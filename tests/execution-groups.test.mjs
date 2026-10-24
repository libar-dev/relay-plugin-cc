import "./support/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setup, startJob, readJob, jobDir, companion, waitFor, finishJob, ROOT } from "./support/job-helpers.mjs";
import { listProcesses, executionMembers, sampleExecution, stopExecution, readProcessStartTime, isProcessIdentityAlive, readProcessTableCached } from "../plugins/relay/scripts/lib/util/process.mjs";
import { describeGuard, renderGuard } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { writeJob, readJob as readRecord } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { spawnWorker } from "../plugins/relay/scripts/lib/worker/delivery.mjs";

const script = path.join(ROOT, "plugins/relay/scripts/companion.mjs");
const alive = pid => isProcessIdentityAlive({ pid });

for (const disabledBy of ["environment", "config"]) {
  for (const parentState of disabledBy === "config" ? ["read-only"] : ["read-only", "unavailable"]) test(`guard off (${disabledBy}) launches with a ${parentState} admission parent`, async t => {
    const ctx = setup(t, { env: { RELAY_WORKER_SCOPE: "off" } });
    const parent = path.join(ctx.root, "admission-parent");
    const home = path.join(parent, "admission");
    fs.mkdirSync(home, { recursive: true });
    ctx.env.RELAY_ADMISSION_HOME = home;
    if (disabledBy === "config") {
      delete ctx.env.RELAY_ADMISSION;
      fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ admission: "off" }));
    } else ctx.env.RELAY_ADMISSION = "off";
    if (parentState === "read-only") {
      fs.chmodSync(parent, 0o555);
      t.after(() => fs.chmodSync(parent, 0o755));
      // Verify the fixture really denies creation (privileged runners may bypass chmod).
      try { fs.mkdirSync(`${home}.probe`); }
      catch (error) { assert.equal(error.code, "EACCES"); }
      if (fs.existsSync(`${home}.probe`)) return t.skip("runner bypasses directory permissions");
    } else {
      fs.rmSync(parent, { recursive: true });
      fs.writeFileSync(parent, "not a directory");
    }
    const { id } = startJob(ctx);
    const launched = await waitFor(() => {
      const job = readJob(ctx, id);
      return job.launch?.state === "acknowledged" && job;
    });
    assert.equal(launched.launch?.state, "acknowledged", "launch still verifies reparenting");
    assert.ok(launched.launch.worker.startTime);
    assert.notEqual(launched.launch.worker.ppid, launched.launch.caller.pid);
    await finishJob(ctx, id);
    assert.equal(readJob(ctx, id).state, "completed");
    assert.equal(ctx.fakeState().appServerStarts, 1);
  });
}

async function treeJob(t, mode, { scope = false, guard = false, brief = "[held] Keep running" } = {}) {
  const ctx = setup(t, { env: { RELAY_WORKER_SCOPE: scope ? "on" : "off", RELAY_JOBS_HEARTBEAT_MS: "100" } });
  if (guard) {
    ctx.env.RELAY_ADMISSION = "on";
    ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "admission");
    ctx.env.RELAY_TEST_ADMISSION_READINGS = path.join(ctx.root, "readings.json");
    fs.writeFileSync(ctx.env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ totalBytes: 64 * 2 ** 30, availableBytes: 60 * 2 ** 30, cores: 8, load5: 0 }));
  }
  ctx.env.FAKE_CODEX_TREE_MODE = mode;
  ctx.env.FAKE_CODEX_TREE_FILE = path.join(ctx.root, "tree.json");
  ctx.env.FAKE_CODEX_RELEASE_FILE = path.join(ctx.root, "release");
  const { id } = startJob(ctx, undefined, brief);
  const tree = await waitFor(() => fs.existsSync(ctx.env.FAKE_CODEX_TREE_FILE) && JSON.parse(fs.readFileSync(ctx.env.FAKE_CODEX_TREE_FILE)));
  t.after(() => { for (const pid of Object.values(tree)) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const dir = jobDir(ctx, id);
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(dir, "processes.json"))).members.some(p => p.pid === tree.grandchild));
  return { ctx, id, dir, tree };
}

for (const mode of ["plain", "detached"]) test(`backend death cleans ${mode} grandchildren before reconnect`, async t => {
  const { ctx, id, tree } = await treeJob(t, mode);
  process.kill(readJob(ctx, id).server.pid, "SIGKILL");
  await waitFor(() => ctx.fakeState().appServerStarts === 2);
  assert.equal(ctx.fakeState().survivorRunningAtStart, false);
  assert.equal(alive(tree.grandchild), false);
  await finishJob(ctx, id);
});

test("normal completion cleans background tools before releasing its seat", async t => {
  const { ctx, id, dir, tree } = await treeJob(t, "detached", { guard: true });
  const job = readJob(ctx, id);
  const seat = path.join(ctx.env.RELAY_ADMISSION_HOME, "slots", `${id}.json`);
  assert.equal(fs.existsSync(seat), true);
  // The worker's cleanup is also visible to readers before its lease goes away.
  fs.writeFileSync(ctx.env.FAKE_CODEX_RELEASE_FILE, "go");
  const deadline = Date.now() + 15000;
  while (alive(tree.grandchild) && Date.now() < deadline) {
    assert.equal(fs.existsSync(seat), true, "tools remain counted until they exit");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await finishJob(ctx, id);
  assert.equal(alive(tree.grandchild), false);
  assert.equal(readJob(ctx, id).cleanup.state, "empty");
  assert.equal(fs.existsSync(seat), false);
  assert.ok(job.execution.leader.startTime);
  assert.deepEqual(executionMembers(readJob(ctx, id), listProcesses(), { jobDir: dir }), []);
});

for (const action of ["recover", "cancel"]) test(`dead worker and dead backend keep surviving tools counted until ${action}`, async t => {
  const { ctx, id, dir, tree } = await treeJob(t, "detached");
  const job = readJob(ctx, id);
  const home = path.join(ctx.root, "admission"); ctx.env.RELAY_ADMISSION_HOME = home; ctx.env.RELAY_ADMISSION = "on";
  ctx.env.RELAY_TEST_ADMISSION_READINGS = path.join(ctx.root, "readings.json");
  fs.writeFileSync(ctx.env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ totalBytes: 64 * 2 ** 30, availableBytes: 60 * 2 ** 30, cores: 8, load5: 0 }));
  fs.mkdirSync(path.join(home, "slots"), { recursive: true });
  fs.writeFileSync(path.join(home, "slots", `${id}.json`), JSON.stringify({ v: 1, jobId: id, jobDir: dir, pid: job.worker.pid, processStart: job.worker.startTime,
    backend: "codex", class: "light", state: "running", since: new Date().toISOString(), treeBytes: 2 ** 30 }));
  process.kill(job.worker.pid, "SIGKILL"); process.kill(job.server.pid, "SIGKILL");
  await waitFor(() => !alive(job.worker.pid) && !alive(job.server.pid));
  const guard = describeGuard(ctx.env);
  assert.equal(guard.activeSeats, 1);
  assert.match(renderGuard(guard).join("\n"), /relay jobs use 1.0 GiB/);
  assert.equal(fs.existsSync(path.join(home, "slots", `${id}.json`)), true);
  const result = companion(ctx, action === "recover" ? ["wait", id, "--auto-resume", "--timeout-seconds", "15"] : ["cancel", id]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(alive(tree.grandchild), false);
  if (action === "recover") {
    await finishJob(ctx, id);
    assert.equal(ctx.fakeState().survivorRunningAtStart, false);
    assert.equal(readJob(ctx, id).launch.trigger, "recovery");
  }
});

test("registry prunes 1,000 samples to less than 1 MiB and retains escaped identities", t => {
  const ctx = setup(t); const dir = ctx.root;
  const job = { server: { pid: 100, startTime: "linux:100" } };
  let escaped;
  for (let n = 0; n < 1000; n++) {
    const rows = [{ pid: 100, ppid: 1, pgid: 100, startTime: "linux:100" },
      { pid: 200 + n, ppid: 100, pgid: 200 + n, startTime: `linux:${200 + n}` }];
    escaped = rows[1];
    sampleExecution(job, dir, rows);
    const members = sampleExecution(job, dir, [{ ...escaped, ppid: 1 }, rows[0]]);
    assert.ok(members.some(p => p.pid === escaped.pid));
    assert.ok(fs.statSync(path.join(dir, "processes.json")).size < 1024 * 1024);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "processes.json"))).members.length, 2);
});

test("process table cache shares a sample and never steals a live lock", t => {
  const ctx = setup(t); let reads = 0;
  const list = () => { reads++; return [{ pid: 42 }]; };
  assert.deepEqual(readProcessTableCached({ home: ctx.root, now: 100, list }), [{ pid: 42 }]);
  readProcessTableCached({ home: ctx.root, now: 101, list });
  assert.equal(reads, 1);
});

test("unresolved execution members remain visible and SIGCONT lets stopped tools terminate", async t => {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" }); await once(child, "spawn");
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const identity = { pid: child.pid, startTime: readProcessStartTime(child.pid) };
  const job = { server: identity };
  const unresolved = await stopExecution(job, { killImpl() {}, graceMs: 0 });
  assert.ok(unresolved.survivors.some(p => p.pid === child.pid));
  process.kill(child.pid, "SIGSTOP");
  const stopped = await stopExecution(job, { graceMs: 500 });
  assert.deepEqual(stopped.survivors, []);
});

// A Stop implementation enumerates PPIDs across sessions, rather than signalling one group.
function stopDescendants(pid) {
  const table = listProcesses(); const descendants = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const row of table) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
  for (const member of [...descendants].reverse()) { try { process.kill(member, "SIGTERM"); } catch {} }
  return descendants;
}

for (const phase of ["running", "admission", "recovery"]) test(`a long-lived wait dispatch survives lead descendant cancellation during ${phase}`, async t => {
  const ctx = setup(t, { turnMs: 30000, env: { RELAY_WORKER_SCOPE: "off" } });
  const fixture = path.join(ctx.root, "machine.json");
  if (phase !== "recovery") {
    ctx.env.RELAY_ADMISSION = "on";
    ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "admission");
    ctx.env.RELAY_TEST_ADMISSION_READINGS = fixture;
    fs.writeFileSync(fixture, JSON.stringify({ totalBytes: 16 * 2 ** 30, availableBytes: 0, load5: 0, cores: 8 }));
  }
  const { id } = startJob(ctx, undefined, "[long] Work");
  const dir = jobDir(ctx, id);
  let old = readJob(ctx, id);
  if (phase === "recovery") {
    await waitFor(() => readJob(ctx, id).turnId);
    old = readJob(ctx, id);
    process.kill(old.worker.pid, "SIGKILL"); process.kill(old.server.pid, "SIGKILL");
    await waitFor(() => !alive(old.worker.pid) && !alive(old.server.pid));
  } else {
    assert.equal(old.worker, null, "spawn-time admission deferred the first worker");
    fs.writeFileSync(fixture, JSON.stringify({ totalBytes: 16 * 2 ** 30, availableBytes: phase === "admission" ? 2 ** 30 : 12 * 2 ** 30, load5: 0, cores: 8 }));
  }
  const leadCode = `const {spawn}=require('node:child_process'); spawn(process.execPath, [${JSON.stringify(script)}, 'wait', ${JSON.stringify(id)}, '--auto-resume', '--timeout-seconds', '30'], {stdio:'ignore'}); setInterval(()=>{},1000);`;
  const lead = spawn(process.execPath, ["-e", leadCode], { env: ctx.env, cwd: ctx.work, stdio: "ignore" });
  t.after(() => { try { lead.kill("SIGKILL"); } catch {} });
  const next = await waitFor(() => { const j = readJob(ctx, id); return j.worker?.pid && j.worker.pid !== old.worker?.pid && j.launch?.state === "acknowledged" && j; });
  if (phase === "running") await waitFor(() => readJob(ctx, id).turnId);
  if (phase === "admission") await waitFor(() => ["critical", "memory"].includes(readJob(ctx, id).admission?.waitKind));
  const tree = stopDescendants(lead.pid);
  assert.equal(tree.has(next.worker.pid), false);
  assert.equal(alive(next.worker.pid), true);
  assert.equal(readJob(ctx, id).attempts.length, next.attempts.length);
  assert.ok(next.launch.worker.ppid !== next.launch.caller.pid);
});

test("Linux worker scope contains tools and inherits OOM score 500", { skip: process.platform !== "linux" }, async t => {
  const probe = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--slice=relay-jobs.slice", "--", "true"]);
  if (probe.status !== 0) return t.skip("user systemd manager unavailable");
  const { ctx, id, tree } = await treeJob(t, "detached", { scope: true });
  const job = readJob(ctx, id);
  assert.match(job.execution.cgroup, /\/relay-jobs.slice\/run-.*\.scope$/);
  for (const pid of [job.worker.pid, job.server.pid, tree.grandchild]) {
    assert.match(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"), /\/relay-jobs.slice\/run-.*\.scope/);
    assert.equal(fs.readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim(), "500");
  }
  process.kill(job.server.pid, "SIGKILL");
  await waitFor(() => ctx.fakeState().appServerStarts === 2);
  assert.equal(ctx.fakeState().survivorRunningAtStart, false);
  await finishJob(ctx, id);
});

test("Stop during launcher handoff starts no backend; concurrent waiters recover one worker", async t => {
  const ctx = setup(t, { turnMs: 30000, env: { RELAY_WORKER_SCOPE: "off" } });
  const { id } = startJob(ctx, undefined, "[long] Handoff work");
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).worker?.pid && readJob(ctx, id).server?.pid);
  await waitFor(() => ctx.fakeState().appServerStarts === 1);
  const old = readJob(ctx, id);
  process.kill(old.worker.pid, "SIGKILL"); if (old.server?.pid) process.kill(old.server.pid, "SIGKILL");
  await waitFor(() => !alive(old.worker.pid));
  writeJob(dir, { ...old, worker: null, server: null, pendingFirstTurn: true, state: "queued", admission: { waitKind: "worker", workerRetryAt: new Date(0).toISOString() } });
  ctx.env.RELAY_ADMISSION = "on";
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "admission");
  ctx.env.RELAY_TEST_ADMISSION_READINGS = path.join(ctx.root, "readings.json");
  fs.writeFileSync(ctx.env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ totalBytes: 64 * 2 ** 30, availableBytes: 60 * 2 ** 30, cores: 64, load5: 0 }));
  const marker = path.join(ctx.root, "launcher-blocked");
  const preload = path.join(ctx.root, "handoff.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs';
if(process.argv[1]?.endsWith('/launcher.mjs')) {
 const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=function(...args){fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);return write(...args);};
}`);
  const lead = spawn(process.execPath, ["-e", `require('node:child_process').spawn(process.execPath,[${JSON.stringify(script)},'wait',${JSON.stringify(id)},'--timeout-seconds','30'],{stdio:'ignore'});setInterval(()=>{},1000)`],
    { cwd: ctx.work, env: { ...ctx.env, NODE_OPTIONS: `--import=${preload}` }, stdio: "ignore" });
  t.after(() => { try { lead.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(marker));
  const launches = fs.readdirSync(dir).filter(name => name.startsWith("launch-"));
  const pending = launches.map(name => JSON.parse(fs.readFileSync(path.join(dir, name)))).find(entry => entry.state === "pending");
  assert.ok(pending?.worker?.pid);
  assert.equal(readJob(ctx, id).state, "starting", "the interrupted reservation has left the worker queue");
  const starts = ctx.fakeState().appServerStarts;
  const killed = stopDescendants(lead.pid);
  assert.ok(killed.has(pending.worker.pid), "the race occurs before reparenting acknowledgement");
  await waitFor(() => !alive(pending.worker.pid));
  assert.equal(ctx.fakeState().appServerStarts, starts, "no backend runs before the handoff");
  // A pending handoff remains retryable. Concurrent waiters use the same lease fence.
  const waiters = Array.from({ length: 3 }, () => spawn(process.execPath, [script, "wait", id, "--timeout-seconds", "30"], { env: ctx.env, cwd: ctx.work, stdio: "ignore" }));
  t.after(() => { for (const waiter of waiters) { try { waiter.kill("SIGKILL"); } catch {} } });
  await waitFor(() => readJob(ctx, id).worker?.pid && readJob(ctx, id).launch?.state === "acknowledged", 20000);
  assert.equal(readJob(ctx, id).workers.filter(w => w.pid !== old.worker.pid).length, 1);
  assert.ok(readJob(ctx, id).launches.some(launch => launch.state === "death-observed" && launch.deathObservedAt && !launch.endedAt));
});

test("a successor never advances its predecessor's heartbeat ownership bound", async t => {
  const { createJobDir } = await import("../plugins/relay/scripts/lib/jobs/store.mjs");
  const { buildLaunchRequest } = await import("../plugins/relay/scripts/lib/jobs/request.mjs");
  const { postInboxMessage } = await import("../plugins/relay/scripts/lib/jobs/messages.mjs");
  const { runWorker } = await import("../plugins/relay/scripts/lib/worker/worker.mjs");
  const ctx = setup(t);
  const { jobDir: dir } = createJobDir(ctx.work, "job-successor-heartbeat", ctx.env);
  const old = { pid: 999999999, startTime: "gone" };
  const bound = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(path.join(dir, "brief.md"), "Old brief.");
  writeJob(dir, { id: "job-successor-heartbeat", kind: "task", state: "failed", worker: old,
    execution: { leader: old, pgid: old.pid }, heartbeatAt: bound, pendingFirstTurn: true,
    request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: ctx.work }, { env: ctx.env }),
    attempts: [{ attempt: 1, state: "failed", teardown: { source: "brief" } }] });
  postInboxMessage(dir, { kind: "continue", text: "[quick] Next." });
  const rename = fs.renameSync;
  let beforeOwnership = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    const result = rename(from, to);
    if (to === path.join(dir, "job.json")) {
      const job = readRecord(dir);
      if (job.worker.pid === old.pid) {
        beforeOwnership++;
        assert.equal(job.heartbeatAt, bound);
      }
      assert.equal(job.executions.find(e => e.leader.pid === old.pid).aliveUntil, bound);
    }
    return result;
  });
  await runWorker(dir, { env: ctx.env });
  assert.ok(beforeOwnership > 0, "teardown writes occur before the successor records itself");
  assert.notEqual(readRecord(dir).heartbeatAt, bound);
});

test("manual continuation retains a legacy dead worker's group before publishing the successor", async t => {
  const { ctx, id, dir, tree } = await treeJob(t, "plain");
  // Give the coarse ps start time an ownership bound from a later heartbeat.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const old = readJob(ctx, id);
  process.kill(old.worker.pid, "SIGKILL"); process.kill(old.server.pid, "SIGKILL");
  await waitFor(() => !alive(old.worker.pid) && !alive(old.server.pid));
  delete old.execution; delete old.executions;
  writeJob(dir, old);
  fs.rmSync(path.join(dir, "processes.json"));
  const result = companion(ctx, ["continue", id, "--message", "[quick] Finish legacy work."]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  await finishJob(ctx, id);
  assert.equal(alive(tree.grandchild), false);
  assert.equal(ctx.fakeState().survivorRunningAtStart, false);
  assert.ok(readJob(ctx, id).executions.some(e => e.leader.pid === old.worker.pid));
});

test("cleanup verifies a newly forked member instead of declaring its old snapshot empty", async () => {
  const leader = { pid: process.pid, startTime: "linux:100" };
  const root = { pid: 500000001, startTime: "linux:200" };
  const newcomer = { pid: 500000002, startTime: "linux:300" };
  let forked = false;
  const result = await stopExecution({ execution: { leader, pgid: leader.pid }, server: root }, {
    listProcesses: () => [{ ...leader, pgid: leader.pid, ppid: 1 },
      { ...(forked ? newcomer : root), pgid: leader.pid, ppid: leader.pid }],
    killImpl: () => { forked = true; }, graceMs: 0
  });
  assert.deepEqual(result.survivors, [newcomer]);
});

test("terminal cleanup never signals the reusable worker that is still closing", async t => {
  const ctx = setup(t, { env: { FAKE_CODEX_IGNORE_CLOSE: "1", RELAY_WORKER_SCOPE: "off" } });
  const { id } = startJob(ctx, undefined, "[quick] Finish while the server stays open.");
  const closing = await waitFor(() => { const j = readJob(ctx, id); return j.state === "completed" && j.server?.pid && j; });
  const signals = path.join(ctx.root, "worker-signals");
  const preload = path.join(ctx.root, "track-terminal-signals.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs';
const kill=process.kill;
process.kill=function(pid,signal){
 if(Math.abs(pid)===${closing.worker.pid} && signal!==0) fs.appendFileSync(${JSON.stringify(signals)},String(signal));
 return kill.apply(this,arguments);
};`);
  const result = companion(ctx, ["cancel", id, "--attempt", "1"], { NODE_OPTIONS: `--import=${preload}` });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(signals), false);
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
});

for (const mismatch of ["inode", "boot"]) test(`a reused scope with a different ${mismatch} is ignored`, async t => {
  const group = "/synthetic/relay-jobs.slice/run-u37.scope";
  const read = fs.readFileSync, stat = fs.statSync, write = fs.writeFileSync;
  const signals = [], writes = [];
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === "/proc/sys/kernel/random/boot_id") return "current-boot\n";
    if (file === `/sys/fs/cgroup${group}/cgroup.procs`) return "500000001\n";
    return read(file, ...args);
  });
  t.mock.method(fs, "statSync", (file, ...args) => file === `/sys/fs/cgroup${group}` ? { ino: 37 } : stat(file, ...args));
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file === `/sys/fs/cgroup${group}/cgroup.kill`) { writes.push(file); return; }
    return write(file, ...args);
  });
  const execution = { leader: { pid: 500000000, startTime: "linux:100" }, pgid: 500000000,
    cgroup: group, cgroupId: mismatch === "inode" ? 36 : 37, bootId: mismatch === "boot" ? "old-boot" : "current-boot" };
  const table = [{ pid: 500000001, ppid: 1, pgid: 500000001, startTime: "linux:200" }];
  const job = { execution };
  assert.deepEqual(executionMembers(job, table), []);
  const { executionAlive } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  assert.equal(executionAlive(job, { listProcesses: () => table }), false);
  assert.deepEqual((await stopExecution(job, { listProcesses: () => table, killImpl: pid => signals.push(pid), graceMs: 0 })).survivors, []);
  assert.deepEqual(signals, []);
  assert.deepEqual(writes, []);
});

for (const sampled of [false, true]) test(`an escaped tracked tool's later children are found before cleanup (sampled=${sampled})`, async t => {
  const ctx = setup(t), dir = ctx.root;
  const backend = { pid: 500000001, ppid: 1, pgid: 500000001, startTime: "linux:100" };
  const tool = { pid: 500000002, ppid: backend.pid, pgid: 500000002, startTime: "linux:200" };
  const child = { pid: 500000003, ppid: tool.pid, pgid: tool.pgid, startTime: "linux:300" };
  const job = { server: backend };
  sampleExecution(job, dir, [backend, tool]);
  let table = [{ ...tool, ppid: 1 }, child];
  if (sampled) for (let n = 0; n < 3; n++) assert.ok(sampleExecution(job, dir, table).some(p => p.pid === child.pid));
  const signals = [];
  const result = await stopExecution(job, { jobDir: dir, listProcesses: () => table, graceMs: 0,
    killImpl(pid, signal) { signals.push(pid); if (signal === "SIGTERM") table = table.filter(row => row.pid !== pid); } });
  assert.ok(signals.includes(child.pid));
  assert.deepEqual(result.survivors, []);
});

test("an unreadable backend identity never authorizes walking its children", async () => {
  const root = { pid: 500000001, startTime: "linux:100" };
  const table = [{ ...root, startTime: null, ppid: 1, pgid: root.pid },
    { pid: 500000002, startTime: "linux:200", ppid: root.pid, pgid: root.pid }];
  const signals = [];
  const result = await stopExecution({ server: root }, { listProcesses: () => table, killImpl: pid => signals.push(pid), graceMs: 0 });
  assert.deepEqual(signals, []);
  assert.equal(result.survivors.some(p => p.pid === root.pid), true);
  assert.equal(result.survivors.some(p => p.pid === 500000002), false);
});

test("a nested worker and its backend are excluded even if sampled during handoff", async t => {
  const ctx = setup(t), dir = ctx.root, registry = path.join(dir, "workers");
  fs.mkdirSync(registry);
  const root = { pid: 500000001, ppid: 1, pgid: 500000001, startTime: "linux:100" };
  const worker = { pid: 500000002, ppid: root.pid, pgid: 500000002, startTime: "linux:200" };
  const backend = { pid: 500000003, ppid: worker.pid, pgid: worker.pgid, startTime: "linux:300" };
  const job = { jobDir: dir, server: root, execution: { leader: root, pgid: root.pgid, workerRegistry: registry } };
  const table = [root, worker, backend];
  sampleExecution(job, dir, table); // Even an earlier sample must be corrected after publication.
  fs.writeFileSync(path.join(registry, `${worker.pid}.json`), JSON.stringify({ ...worker, jobDir: path.join(dir, "inner") }));
  assert.deepEqual(sampleExecution(job, dir, table).map(p => p.pid), [root.pid]);
  const signals = [];
  const result = await stopExecution(job, { jobDir: dir, listProcesses: () => table.filter(row => !signals.includes(row.pid)), graceMs: 0,
    killImpl: pid => signals.push(pid) });
  assert.deepEqual(signals, [root.pid]);
  assert.deepEqual(result.survivors, []);
});

test("a failed launch stays queued and plain wait dispatches it without auto-resume", async t => {
  const ctx = setup(t, { env: { RELAY_WORKER_SCOPE: "off" } });
  const preload = path.join(ctx.root, "fail-launch.mjs");
  fs.writeFileSync(preload, `if(process.argv[1]?.endsWith('/launcher.mjs')) process.exit(1);`);
  const { id } = startJob(ctx, undefined, "[quick] Retry the launch.", { NODE_OPTIONS: `--import=${preload}` });
  const queued = readJob(ctx, id);
  assert.equal(queued.state, "queued");
  assert.equal(queued.admission.causeKind, "launch");
  assert.equal(queued.admission.waitKind, "worker");
  assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "15"]).status, 0);
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).attempts.length, 1);
  assert.equal(readJob(ctx, id).workers.length, 1);
  assert.equal(readJob(ctx, id).autoRecoveries?.length ?? 0, 0);
});

for (const cancel of [false, true]) test(`an actual nested task survives outer cleanup after sampling its launcher handoff (cancel=${cancel})`, async t => {
  const outer = setup(t, { turnMs: 100, env: { RELAY_WORKER_SCOPE: "off" } });
  const inner = setup(t, { turnMs: 30000, env: { RELAY_WORKER_SCOPE: "off" } });
  const shared = path.join(outer.root, "admission");
  outer.env.RELAY_ADMISSION_HOME = shared;
  inner.env.RELAY_ADMISSION_HOME = shared;
  const marker = path.join(outer.root, "nested-started"), blocked = path.join(inner.root, "blocked"), release = path.join(inner.root, "release");
  const preload = path.join(inner.root, "hold-launcher.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs';
if(process.argv[1]?.endsWith('/launcher.mjs')) {
 const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=(...args)=>{fs.writeFileSync(${JSON.stringify(blocked)},fs.readFileSync(process.argv[2]));
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer);},10);return write(...args);};
}`);
  const launch = `if(!require('node:fs').existsSync(${JSON.stringify(marker)})) {
require('node:fs').writeFileSync(${JSON.stringify(marker)},'');
require('node:child_process').spawn(process.execPath,${JSON.stringify([script, "task", "--model", "gpt-test", "--effort", "low", "[long] Nested task"])},
{cwd:${JSON.stringify(inner.work)},env:{...process.env,...${JSON.stringify(inner.env)},NODE_OPTIONS:${JSON.stringify(`--import=${preload}`)}},stdio:'ignore'}).unref();
}\n`;
  const binary = path.join(outer.bin, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace("\n", "\n" + launch));
  const { id } = startJob(outer, undefined, "[long] Outer task");
  const pending = await waitFor(() => fs.existsSync(blocked) && JSON.parse(fs.readFileSync(blocked)));
  const record = readJob(outer, id), dir = jobDir(outer, id);
  const table = listProcesses();
  assert.ok(table.some(row => row.pid === pending.worker.pid));
  assert.equal(sampleExecution(record, dir, table).some(row => row.pid === pending.worker.pid), false);
  if (cancel) {
    const result = companion(outer, ["cancel", id]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } else fs.writeFileSync(release, "go");
  const { jobDirs } = await import("./support/job-helpers.mjs");
  const innerDir = await waitFor(() => jobDirs(inner).find(dir => readRecord(dir).state === "running"));
  const worker = readRecord(innerDir).worker;
  if (!cancel) {
    process.kill(readJob(outer, id).server.pid, "SIGKILL");
    await finishJob(outer, id);
  }
  assert.equal(isProcessIdentityAlive(worker), true);
  assert.equal(readRecord(innerDir).state, "running");
});

test("scope cleanup excludes older members and preserves nested workers sharing the scope", async t => {
  const ctx = setup(t), registry = path.join(ctx.root, "workers");
  fs.mkdirSync(registry);
  const group = "/synthetic/relay-jobs.slice/run-u37.scope";
  const leader = { pid: 500000000, startTime: "linux:200" };
  const older = { pid: 500000001, ppid: 1, pgid: 500000001, startTime: "linux:100" };
  const worker = { pid: 500000002, ppid: 1, pgid: 500000002, startTime: "linux:300" };
  const tool = { pid: 500000003, ppid: 1, pgid: 500000003, startTime: "linux:400" };
  let table = [older, worker, tool];
  fs.writeFileSync(path.join(registry, `${worker.pid}.json`), JSON.stringify({ ...worker, jobDir: path.join(ctx.root, "nested") }));
  const read = fs.readFileSync, stat = fs.statSync, write = fs.writeFileSync;
  const scopeKills = [], signals = [];
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === "/proc/sys/kernel/random/boot_id") return "current-boot\n";
    if (file === `/sys/fs/cgroup${group}/cgroup.procs`) return `${older.pid}\n${worker.pid}\n${tool.pid}\n`;
    return read(file, ...args);
  });
  t.mock.method(fs, "statSync", (file, ...args) => file === `/sys/fs/cgroup${group}` ? { ino: 37 } : stat(file, ...args));
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file === `/sys/fs/cgroup${group}/cgroup.kill`) { scopeKills.push(file); return; }
    return write(file, ...args);
  });
  const job = { jobDir: ctx.root, execution: { leader, pgid: leader.pid, cgroup: group, cgroupId: 37, bootId: "current-boot", workerRegistry: registry } };
  assert.deepEqual(executionMembers(job, table).map(p => p.pid), [tool.pid]);
  const result = await stopExecution(job, { listProcesses: () => table, graceMs: 0,
    killImpl(pid) { signals.push(pid); table = table.filter(row => row.pid !== pid); } });
  assert.deepEqual(signals, [tool.pid]);
  assert.deepEqual(scopeKills, []);
  assert.deepEqual(result.survivors, []);
});
