import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { setup, waitFor } from "./support/job-helpers.mjs";
import { createJobDir, jobPaths, readJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { loadJobView, renderJobBlock, renderJobStatus } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";
import { backendNamed } from "../plugins/relay/scripts/lib/backends/index.mjs";
import { DEFAULTS as D } from "../plugins/relay/scripts/lib/worker/admission.mjs";
const GiB = 2 ** 30;
function seed(t, brief = "[quick] First turn.") {
  const ctx = setup(t);
  ctx.env.RELAY_ADMISSION = "on";
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "admission");
  const { jobDir: dir } = createJobDir(ctx.work, "job-admission-worker", ctx.env);
  fs.writeFileSync(jobPaths(dir).brief, brief);
  writeJob(dir, { id: "job-admission-worker", kind: "task", state: "starting", createdAt: new Date().toISOString(), pendingFirstTurn: true, attempts: [],
    request: buildLaunchRequest({ model: "synthetic-model", effort: D.lightEfforts[0], cd: ctx.work }, { baseDir: ctx.work, env: ctx.env }) });
  let now = Date.now(), blocked = true;
  const options = { env: ctx.env, admission: { now: () => now, scanUnslotted: () => [], readMachine: () => ({ totalBytes: 128 * GiB, availableBytes: blocked ? 0 : 100 * GiB, cores: 64, load5: 0, notes: [] }) },
    admissionSleep: async () => { now += D.spacingMs; await new Promise(r => setTimeout(r, 10)); } };
  return { ctx, dir, options, unblock: () => blocked = false, block: () => blocked = true, tick: ms => now += ms };
}

test("queued worker stays live, acknowledges next turns and resets attempt state on admission", async t => {
  const s = seed(t), running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued");
  assert.equal(loadJobView(s.dir).state, "queued");
  assert.equal(loadJobView(s.dir).stalled, false);
  const steer = postInboxMessage(s.dir, { kind: "steer", text: "[quick] Next turn." });
  await waitFor(() => readOutcome(s.dir, steer.id)?.action === "queued-next-turn");
  assert.equal(loadJobView(s.dir).state, "queued", "owed messages must not replace queued with running");
  s.unblock(); await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "completed");
  assert.equal(job.attempts.length, 2);
  assert.ok(job.attempts.every(a => a.state === "completed"));
  assert.equal(job.admission.state, "admitted");
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", `${job.id}.json`)), false);
});

test("cancel while queued launches no backend and releases its slot", async t => {
  const s = seed(t), running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued");
  postInboxMessage(s.dir, { kind: "cancel" });
  await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "cancelled");
  assert.equal(job.admission.state, "cancelled");
  assert.match(job.admission.reason, /memory/); assert.ok(job.admission.since);
  assert.equal(job.attempts.at(-1).state, "cancelled");
  assert.equal(fs.existsSync(path.join(s.ctx.bin, "fake-codex-state.json")), false);
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", `${job.id}.json`)), false);
});

test("the backend remains counted until close finishes", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let observed = false;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), close = connection.close.bind(connection);
    t.mock.method(connection, "close", async () => {
      assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", "job-admission-worker.json")), true);
      observed = true; await close();
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(observed, true);
});

test("terminal relay results stay verbatim while close changes live memory accounting", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let resultAtClose;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), close = connection.close.bind(connection);
    t.mock.method(connection, "close", async () => {
      const view = loadJobView(s.dir);
      assert.equal(view.state, "completed");
      // An accounting sample at backend end must not change a result already returned.
      resultAtClose = renderJobBlock({ ...view, job: { ...view.job, treeBytes: GiB } });
      assert.equal(renderJobBlock({ ...view, job: { ...view.job, treeBytes: 0 } }), resultAtClose);
      await close();
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(renderJobBlock(loadJobView(s.dir)), resultAtClose);
  assert.doesNotMatch(resultAtClose, /^memory:/m);
});

test("critical pressure before a warm turn queues without double charging the slot", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let turns = 0;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), run = connection.run.bind(connection);
    t.mock.method(connection, "run", async (...turn) => {
      const result = await run(...turn); turns++;
      if (turns === 1) { postInboxMessage(s.dir, { kind: "continue", text: "[quick] Second." }); s.block(); }
      return result;
    });
    return connection;
  });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued" && readJob(s.dir).attempts.length === 2);
  const slot = JSON.parse(fs.readFileSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", "job-admission-worker.json")));
  assert.equal(slot.state, "running");
  assert.equal(turns, 1);
  s.unblock(); await running;
  assert.equal(turns, 2);
});

test("structured turn/start refusal is preserved, pauses the backend and never retries usage", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let runs = 0, retries = 0;
  s.options.sleep = async () => retries++;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    const request = connection.client.request.bind(connection.client);
    t.mock.method(connection.client, "request", async (method, params, ...rest) => {
      if (method !== "turn/start") return request(method, params, ...rest);
      runs++;
      const error = new Error("synthetic usage limit at turn/start");
      error.data = { code: -32000, message: error.message, data: { codexErrorInfo: "usageLimitExceeded" } };
      throw error;
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(runs, 1);
  assert.equal(retries, 0);
  const job = readJob(s.dir);
  assert.equal(job.state, "failed");
  assert.equal(job.refusal.kind, "usage");
  assert.equal(job.refusal.code, "usageLimitExceeded");
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "pauses", "codex.json")), true);
});

test("capacity retries check critical pressure before sending another turn", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let runs = 0;
  s.options.sleep = async () => s.block();
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    t.mock.method(connection, "run", async () => { runs++; return { turnStatus: "failed", error: { message: "synthetic capacity" }, finalMessage: "", capacity: true }; });
    return connection;
  });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued" && runs === 1);
  postInboxMessage(s.dir, { kind: "cancel" }); await running;
  assert.equal(runs, 1);
  assert.equal(readJob(s.dir).state, "cancelled");
});

test("inherited guard off survives a partial worker environment and creates no admission files", async t => {
  const s = seed(t, "[held] Wait for a heartbeat with the guard off.");
  delete s.options.env.RELAY_ADMISSION;
  assert.equal(process.env.RELAY_ADMISSION, "off");
  const release = path.join(s.ctx.root, "release-guard-off");
  s.options.env.FAKE_CODEX_RELEASE_FILE = release;
  const running = runWorker(s.dir, s.options);
  try {
    await waitFor(() => readJob(s.dir).treeBytes > 0);
    assert.equal(fs.existsSync(s.ctx.env.RELAY_ADMISSION_HOME), false, "a heartbeat must not create the disabled guard's cache");
  } finally {
    fs.writeFileSync(release, "release");
    await running;
  }
  assert.equal(readJob(s.dir).state, "completed");
  assert.equal(fs.existsSync(s.ctx.env.RELAY_ADMISSION_HOME), false);
});

test("a provider refusal followed by a backend exit is failed without automatic recovery", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let connections = 0;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args); connections++;
    t.mock.method(connection, "run", async () => {
      connection.client.exitInfo = { code: 1, endedAt: new Date().toISOString() };
      return { turnStatus: "failed", error: { message: "synthetic usage limit", codexErrorInfo: "usageLimitExceeded" }, finalMessage: "" };
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "failed");
  assert.equal(job.refusal.kind, "usage");
  assert.equal(connections, 1);
  assert.equal(job.automaticResumes?.length ?? 0, 0);
});

test("an impossible backend scope fails clearly without connecting or retrying", async t => {
  const s = seed(t); s.unblock();
  s.options.admission.readMachine = () => ({ totalBytes: 64 * GiB, availableBytes: 60 * GiB, cores: 8, load5: 0, notes: [], group: "/synthetic",
    scopes: [{ id: "/synthetic", limitBytes: 0.5 * GiB, currentBytes: 0, remainingBytes: 0.5 * GiB }] });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "failed"); assert.equal(job.admission.state, "failed");
  assert.match(job.errorMessage, /cannot fit cgroup/);
  assert.equal(fs.existsSync(path.join(s.ctx.bin, "fake-codex-state.json")), false);
});

test("deferred worker retries are throttled across callers at the admission poll interval", async t => {
  const { retryQueuedWorker } = await import("../plugins/relay/scripts/lib/worker/delivery.mjs");
  const s = seed(t);
  s.ctx.env.RELAY_TEST_ADMISSION_READINGS = path.join(s.ctx.root, "readings.json");
  fs.writeFileSync(s.ctx.env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ totalBytes: 64 * GiB, availableBytes: 0, cores: 8, load5: 0 }));
  const job = readJob(s.dir);
  writeJob(s.dir, { ...job, state: "queued", admission: { state: "waiting", waitKind: "worker", since: new Date().toISOString() } });
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  retryQueuedWorker(s.dir, s.ctx.env);
  const first = readJob(s.dir).admission.workerRetryAt;
  assert.equal(readJob(s.dir).launchPendingAt, first, "old readers retain their start grace while a waiter retries");
  now += D.pollMs - 1;
  retryQueuedWorker(s.dir, s.ctx.env);
  assert.equal(readJob(s.dir).admission.workerRetryAt, first);
  now++;
  retryQueuedWorker(s.dir, s.ctx.env);
  assert.notEqual(readJob(s.dir).admission.workerRetryAt, first);
});

test("first dispatch consumes its start grant once and preserves the actual queue wait", async t => {
  const s = seed(t);
  const rename = fs.renameSync;
  let grants = 0, queuedAfterGrant = 0, atConnect;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(s.ctx.env.RELAY_ADMISSION_HOME, "timing.json")) grants++;
    if (to === path.join(s.dir, "job.json") && grants && JSON.parse(fs.readFileSync(from, "utf8")).state === "queued") queuedAfterGrant++;
    return rename(from, to);
  });
  s.options.admissionSleep = async () => {
    assert.equal(grants, 0, "first turn must not sleep on its own grant (clock deliberately stays fixed)");
    await new Promise(r => setTimeout(r, 10));
  };
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => { atConnect = readJob(s.dir).admission; return connect(...args); });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued");
  const since = readJob(s.dir).admission.since;
  s.tick(120000); s.unblock(); await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "completed"); assert.equal(grants, 1); assert.equal(queuedAfterGrant, 0);
  assert.equal(job.admission.since, since); assert.equal(job.admission.admittedAt, atConnect.admittedAt);
  assert.equal(Date.parse(job.admission.admittedAt) - Date.parse(since), 120000);
});


test("workerless queues without a live launcher do not defer the review gate", async t => {
  const { findActiveJob } = await import("../plugins/relay/scripts/hooks/stop-review-gate.mjs");
  const s = seed(t), oldHome = process.env.RELAY_JOBS_HOME;
  process.env.RELAY_JOBS_HOME = s.ctx.env.RELAY_JOBS_HOME;
  t.after(() => { if (oldHome === undefined) delete process.env.RELAY_JOBS_HOME; else process.env.RELAY_JOBS_HOME = oldHome; });
  writeJob(s.dir, { ...readJob(s.dir), state: "queued", worker: null, admission: { waitKind: "worker" } });
  assert.equal(findActiveJob(s.ctx.work), null);
});

test("a heartbeat during slow probe startup retains the claim until provider evidence", async t => {
  const { recordRefusal, listPauses } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  s.options.env.RELAY_JOBS_HEARTBEAT_MS = "10";
  const home = s.ctx.env.RELAY_ADMISSION_HOME, deps = { ...s.options.admission, env: s.ctx.env };
  recordRefusal(home, "codex", { kind: "rate" }, "previous-job", deps);
  s.tick(D.ratePauseMs);
  const backend = backendNamed("codex"), connect = backend.connect;
  let paused;
  t.mock.method(backend, "connect", async (...args) => {
    assert.ok(listPauses(s.ctx.env, deps)[0].probing);
    s.tick(D.probeMs + 10000);
    await new Promise(resolve => setTimeout(resolve, 30));
    paused = JSON.parse(fs.readFileSync(path.join(home, "pauses", "codex.json")));
    assert.ok(paused.probe);
    assert.equal(paused.strikes, 1);
    return connect(...args);
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed");
  assert.equal(listPauses(s.ctx.env, deps).length, 0, "actual model output clears the probe");
});

test("server-death replacement waits for critical states, scope, provider pause and pacing before reconnecting", async t => {
  const { recordRefusal } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  s.options.env.FAKE_CODEX_DEATH_KIND = "zero";
  const home = s.ctx.env.RELAY_ADMISSION_HOME, slotFile = path.join(home, "slots", "job-admission-worker.json");
  const timingFile = path.join(home, "timing.json");
  let connections = 0, stage = 0, original, timing;
  const states = [{ load5: 200 }, { availableBytes: 0 }, { pressure: 4 },
    { group: "/finite", scopes: [{ id: "/finite", limitBytes: 2 * GiB, remainingBytes: 0 }] }, {}, {}];
  const kinds = ["critical", "critical", "critical", "scope", "pause", "stagger"];
  s.options.admission.readMachine = () => ({ totalBytes: 128 * GiB, availableBytes: 100 * GiB, cores: 64, load5: 0, notes: [],
    ...(connections === 1 ? states[stage] : {}) });
  s.options.admissionSleep = async () => {
    assert.equal(connections, 1, "second connect must wait for every launch gate");
    assert.equal(readJob(s.dir).admission.waitKind, kinds[stage]);
    const slot = JSON.parse(fs.readFileSync(slotFile));
    assert.equal(slot.state, "running"); assert.equal(slot.holdAt, original.holdAt); assert.equal(slot.holdBytes, original.holdBytes);
    assert.equal(fs.readFileSync(timingFile, "utf8"), timing);
    stage++;
    if (stage === 4) recordRefusal(home, "codex", { kind: "rate" }, "previous", { ...s.options.admission, env: s.options.env });
    if (stage === 5) fs.rmSync(path.join(home, "pauses", "codex.json"));
    if (stage === 6) s.tick(D.spacingMs);
  };
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    connections++;
    const slot = JSON.parse(fs.readFileSync(slotFile));
    if (connections === 1) { original = slot; timing = fs.readFileSync(timingFile, "utf8"); }
    else {
      assert.equal(stage, 6);
      assert.equal(Date.parse(slot.holdAt) - Date.parse(original.holdAt), D.spacingMs);
      assert.equal(slot.holdBytes, D.startupBytes.codex);
      assert.notEqual(fs.readFileSync(timingFile, "utf8"), timing);
      assert.equal(fs.readdirSync(path.join(home, "slots")).length, 1);
    }
    return connect(...args);
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed"); assert.equal(connections, 2); assert.equal(stage, 6);
  assert.equal(readJob(s.dir).attempts[0].servers.length, 2);
});

test("turns on the same connection ignore critical load and pacing without refreshing holds", async t => {
  const s = seed(t); s.unblock();
  const home = s.ctx.env.RELAY_ADMISSION_HOME, slotFile = path.join(home, "slots", "job-admission-worker.json"), timingFile = path.join(home, "timing.json");
  const backend = backendNamed("codex"), connect = backend.connect;
  let connections = 0, turns = 0, original, timing;
  s.options.admissionSleep = async () => assert.fail("retained connection must not wait on load or pacing");
  t.mock.method(backend, "connect", async (...args) => {
    connections++; const connection = await connect(...args), run = connection.run.bind(connection);
    original = JSON.parse(fs.readFileSync(slotFile)); timing = fs.readFileSync(timingFile, "utf8");
    t.mock.method(connection, "run", async (...turn) => {
      turns++;
      if (turns === 2) {
        const slot = JSON.parse(fs.readFileSync(slotFile));
        assert.equal(slot.holdAt, original.holdAt); assert.equal(slot.holdBytes, original.holdBytes);
        assert.equal(fs.readFileSync(timingFile, "utf8"), timing);
      }
      const result = await run(...turn);
      if (turns === 1) {
        postInboxMessage(s.dir, { kind: "continue", text: "[quick] Second turn." });
        s.options.admission.readMachine = () => ({ totalBytes: 128 * GiB, availableBytes: 100 * GiB, cores: 64, load5: 200, notes: [] });
      }
      return result;
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed"); assert.equal(turns, 2); assert.equal(connections, 1);
});

for (const [name, variable] of [["codex", "CODEX_HOME"], ["zcode", "ZCODE_DATA_BASE_DIR"]]) test(`${name} resumed workers use the current execution account for admission and refusals`, async t => {
  const { recordRefusal } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  if (name === "zcode") {
    const { installFakeZcode } = await import("./fakes/zcode.mjs");
    s.ctx.env.ZCODE_BINARY = installFakeZcode(s.ctx.bin).binary;
  }
  const originalHome = path.join(s.ctx.root, "account-a"), currentHome = path.join(s.ctx.root, "account-b");
  fs.mkdirSync(originalHome); fs.mkdirSync(currentHome);
  s.ctx.env[variable] = originalHome;
  const values = { backend: name, model: "default", effort: "default", cd: s.ctx.work };
  const first = buildLaunchRequest(values, { baseDir: s.ctx.work, env: s.ctx.env });
  writeJob(s.dir, { ...readJob(s.dir), request: first });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed");
  s.ctx.env[variable] = currentHome;
  const current = buildLaunchRequest(values, { baseDir: s.ctx.work, env: s.ctx.env });
  assert.notEqual(first.account, current.account);
  const home = s.ctx.env.RELAY_ADMISSION_HOME, pauseFile = path.join(home, "pauses", `${name}-${current.account}.json`);
  recordRefusal(home, name, { kind: "rate" }, "previous", { ...s.options.admission, env: s.ctx.env, request: current });
  let waited = false, connections = 0;
  s.options.admissionSleep = async () => {
    const job = readJob(s.dir);
    assert.equal(job.admission.waitKind, "pause"); assert.equal(job.request.account, current.account);
    waited = true; fs.rmSync(pauseFile); s.tick(D.spacingMs);
  };
  const backend = backendNamed(name), connect = backend.connect;
  t.mock.method(backend, "connect", async (request, options) => {
    connections++;
    assert.equal(waited, true, "the current account pause must gate the resumed connection");
    assert.equal(request.account, current.account); assert.equal(options.env[variable], currentHome);
    const connection = await connect(request, options);
    t.mock.method(connection, "run", async () => ({ turnStatus: "failed", finalMessage: "", error: name === "codex"
      ? { codexErrorInfo: "usageLimitExceeded", message: "synthetic quota" }
      : { data: { code: "1113" }, message: "synthetic quota" } }));
    return connection;
  });
  postInboxMessage(s.dir, { kind: "continue", text: "[quick] Resume under current account." });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(connections, 1); assert.equal(job.state, "failed"); assert.equal(job.refusal.kind, "usage");
  assert.equal(job.request.account, current.account);
  assert.equal(JSON.parse(fs.readFileSync(pauseFile)).account, current.account);
  assert.equal(fs.existsSync(path.join(home, "pauses", `${name}-${first.account}.json`)), false);
});

test("heartbeat memory is visible in the job, slot and aggregate guard status", async t => {
  const { describeGuard, renderGuard } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const { renderJobBlock } = await import("../plugins/relay/scripts/lib/jobs/view.mjs");
  const s = seed(t, "[held] Sample memory."); s.unblock();
  s.options.env.RELAY_JOBS_HEARTBEAT_MS = "20";
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).treeBytes > 0);
  const slot = JSON.parse(fs.readFileSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", "job-admission-worker.json")));
  assert.ok(slot.treeBytes > 0);
  const guard = describeGuard(s.ctx.env, {}, s.options.admission);
  assert.ok(guard.relayBytes > 0);
  assert.match(renderGuard(guard).join("\n"), /relay jobs use [\d.]+ GiB/);
  assert.match(renderJobBlock(loadJobView(s.dir)), /memory: [\d.]+ GiB \(job and its processes\)/);
  postInboxMessage(s.dir, { kind: "cancel" });
  await running;
});

test("unresolved owned tools preserve completion and retain the running seat", async t => {
  const { spawn } = await import("node:child_process");
  const { readProcessStartTime } = await import("../plugins/relay/scripts/lib/util/process.mjs");
  const s = seed(t); s.unblock();
  s.options.predecessorCleanup = { killImpl() {}, graceMs: 0 };
  const backend = backendNamed("codex"), connect = backend.connect;
  let child;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), run = connection.run.bind(connection);
    t.mock.method(connection, "run", async (...turn) => {
      const result = await run(...turn);
      child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
      await waitFor(() => readProcessStartTime(child.pid));
      fs.writeFileSync(path.join(s.dir, "processes.json"), JSON.stringify({ members: [{ pid: child.pid, startTime: readProcessStartTime(child.pid) }] }));
      return result;
    });
    return connection;
  });
  t.after(() => { try { child?.kill("SIGKILL"); } catch {} });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "completed");
  assert.equal(job.cleanup.state, "unresolved");
  assert.ok(job.cleanup.pids.includes(child.pid));
  assert.doesNotMatch(renderJobBlock(loadJobView(s.dir)), /cleanup: unresolved/);
  assert.match(renderJobStatus(loadJobView(s.dir)), /cleanup: unresolved/);
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", "job-admission-worker.json")), true);
});

test("native Windows acknowledges without a process table and runs with groups bypassed", async t => {
  const s = seed(t); s.unblock();
  const launch = path.join(s.dir, "launch-windows.json");
  fs.writeFileSync(launch, JSON.stringify({ state: "pending", caller: { pid: 999999999, startTime: "gone" } }));
  const running = runWorker(s.dir, { ...s.options, platform: "win32", env: { ...s.ctx.env, RELAY_WORKER_LAUNCH: launch },
    admission: { ...s.options.admission, platform: "win32" } });
  const ack = JSON.parse(fs.readFileSync(launch));
  assert.equal(ack.state, "acknowledged");
  assert.equal(ack.reparenting, "unverified");
  await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "completed");
  assert.match(job.admission.notes.join(" "), /unsupported on win32/);
  assert.match(renderJobBlock(loadJobView(s.dir)), /execution groups unsupported on win32/);
});

test("sampling failures preserve heartbeat liveness and the backend end record", async t => {
  const s = seed(t, "[long] Wait for accounting trouble."); s.unblock();
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).server?.pid);
  const mkdir = fs.mkdirSync, rename = fs.renameSync;
  let failedSamples = 0;
  t.mock.method(fs, "mkdirSync", (directory, ...args) => {
    if (directory === s.ctx.env.RELAY_ADMISSION_HOME) { failedSamples++; throw new Error("synthetic sample failure"); }
    return mkdir(directory, ...args);
  });
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(s.dir, "processes.json")) { failedSamples++; throw new Error("synthetic registry failure"); }
    return rename(from, to);
  });
  await waitFor(() => failedSamples > 0);
  postInboxMessage(s.dir, { kind: "cancel" });
  await running;
  assert.equal(readJob(s.dir).state, "cancelled");
  assert.ok(readJob(s.dir).attempts.at(-1).servers.at(-1).endedAt);
  assert.ok(failedSamples >= 2);
});

test("a reparented worker acknowledges even after its caller has gone", async t => {
  const s = seed(t); s.unblock();
  const launch = path.join(s.dir, "launch-caller-gone.json");
  fs.writeFileSync(launch, JSON.stringify({ state: "pending", caller: { pid: 999999998, startTime: "gone" }, launcher: { pid: 999999999, startTime: "gone" } }));
  // Model the outside-caller ancestry check independently of this test runner’s PPID.
  await runWorker(s.dir, { ...s.options, platform: "linux", env: { ...s.ctx.env, RELAY_WORKER_LAUNCH: launch } });
  const ack = JSON.parse(fs.readFileSync(launch));
  assert.equal(ack.state, "acknowledged");
  assert.ok(ack.callerGoneAt);
  assert.equal(readJob(s.dir).state, "completed");
});

test("a silent probe retains its fence beyond two minutes and clears only on provider evidence", async t => {
  const { recordRefusal, listPauses, admit } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  s.options.env.RELAY_JOBS_HEARTBEAT_MS = "10";
  const home = s.ctx.env.RELAY_ADMISSION_HOME, deps = { ...s.options.admission, env: s.ctx.env };
  recordRefusal(home, "codex", { kind: "rate" }, "previous", deps); s.tick(D.ratePauseMs);
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    t.mock.method(connection, "run", async turn => {
      turn.onPending(); turn.onTurnId("silent-turn"); s.tick(D.probeMs + 10000);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(listPauses(s.ctx.env, deps)[0].probing);
      const decision = admit({ home, jobId: "other-job", request: readJob(s.dir).request,
        me: { pid: process.pid, startTime: readJob(s.dir).worker.startTime } }, deps);
      assert.equal(decision.waitKind, "probe");
      turn.onProviderResponse();
      assert.equal(listPauses(s.ctx.env, deps).length, 0);
      return { turnStatus: "completed", finalMessage: "Answer" };
    });
    return connection;
  });
  await runWorker(s.dir, s.options); assert.equal(readJob(s.dir).state, "completed");
});

test("a slow connection rechecks a grant before sending into a newly recorded provider pause", async t => {
  const { recordRefusal } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  const home = s.ctx.env.RELAY_ADMISSION_HOME, deps = { ...s.options.admission, env: s.ctx.env };
  const backend = backendNamed("codex"), connect = backend.connect;
  let held = false;
  s.options.admissionSleep = async () => {
    assert.equal(readJob(s.dir).admission.waitKind, "pause"); held = true;
    fs.rmSync(path.join(home, "pauses", "codex.json"));
  };
  t.mock.method(backend, "connect", async (...args) => {
    s.tick(15000); recordRefusal(home, "codex", { kind: "usage" }, "other-job", deps);
    const connection = await connect(...args), run = connection.run.bind(connection);
    t.mock.method(connection, "run", (...turn) => { assert.equal(held, true); return run(...turn); });
    return connection;
  });
  await runWorker(s.dir, s.options); assert.equal(readJob(s.dir).state, "completed");
});

test("a completed local turn without provider evidence releases its probe and preserves the pause", async t => {
  const { recordRefusal, listPauses } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  const home = s.ctx.env.RELAY_ADMISSION_HOME, deps = { ...s.options.admission, env: s.ctx.env };
  recordRefusal(home, "codex", { kind: "rate" }, "previous", deps); s.tick(D.ratePauseMs);
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    t.mock.method(connection, "run", async () => ({ turnStatus: "completed", finalMessage: "" }));
    return connection;
  });
  await runWorker(s.dir, s.options);
  const pause = listPauses(s.ctx.env, deps)[0];
  assert.equal(readJob(s.dir).state, "completed"); assert.equal(pause.strikes, 1); assert.equal(pause.probing, false);
});

for (const [name, error] of [["codex", { codexErrorInfo: { usageLimitExceeded: {} }, message: "Quota" }],
  ["grok", { message: "HTTP 429 Too Many Requests" }], ["kimi", { message: "403 You have reached your weekly usage limit" }]]) {
  test(`${name} early retry signal pauses new work before the current turn completes`, async t => {
    const { admit } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
    const s = seed(t); s.unblock();
    if (name !== "codex") {
      const { installFakeGrok } = await import("./fakes/grok.mjs");
      const { installFakeKimi } = await import("./fakes/kimi.mjs");
      const fake = name === "grok" ? installFakeGrok(s.ctx.bin) : installFakeKimi(s.ctx.bin);
      s.ctx.env[`${name.toUpperCase()}_BINARY`] = fake.binary;
      const request = buildLaunchRequest({ backend: name, model: "default", effort: "default", cd: s.ctx.work }, { baseDir: s.ctx.work, env: s.ctx.env });
      writeJob(s.dir, { ...readJob(s.dir), request });
    }
    const backend = backendNamed(name), connect = backend.connect;
    let signalled = false;
    t.mock.method(backend, "connect", async (...args) => {
      const connection = await connect(...args);
      t.mock.method(connection, "run", async turn => {
        turn.onPending(); turn.onTurnId("still-running"); turn.onProviderLimit(error); signalled = true;
        const decision = admit({ home: s.ctx.env.RELAY_ADMISSION_HOME, jobId: "queued-job", request: readJob(s.dir).request,
          me: readJob(s.dir).worker }, { ...s.options.admission, env: s.ctx.env });
        assert.equal(decision.waitKind, "pause"); assert.equal(readJob(s.dir).state, "running");
        return { turnStatus: "completed", finalMessage: "Eventually answered" };
      });
      return connection;
    });
    await runWorker(s.dir, s.options);
    assert.equal(signalled, true); assert.equal(readJob(s.dir).state, "completed");
    assert.equal(readJob(s.dir).refusal.kind, name === "grok" ? "rate" : "usage");
  });
}

test("two unanswered watchdog pings bound a stubborn server's close and recover exactly once", async t => {
  const { writeExecutable } = await import("./support/helpers.mjs");
  const { installFakeCodex } = await import("./fakes/codex.mjs");
  const s = seed(t); s.unblock();
  // A real RPC peer: its first ping answers, later pings and the turn stay silent. EOF
  // and TERM leave it running, so recovery must wait for the transport's bounded KILL.
  writeExecutable(path.join(s.ctx.bin, "codex"), `#!/usr/bin/env node
const readline = require('node:readline');
process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
let pings = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id == null) return;
  const reply = result => process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
  if (m.method === 'account/read') { if (++pings === 1) reply({}); return; }
  if (m.method === 'turn/start') { reply({ turn: { id: 'silent', status: 'inProgress', items: [] } }); return; }
  if (m.method === 'thread/start' || m.method === 'thread/resume') { reply({ thread: { id: 'thr_silent' } }); return; }
  reply({});
});
`);
  const setTimer = globalThis.setTimeout;
  let pingDeadlines = 0;
  let deadlineTimer;
  let now = 0, connections = 0, closeMs;
  s.options.now = () => now; s.options.env.RELAY_JOBS_HEARTBEAT_MS = "10";
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args); connections++;
    if (connections === 1) {
      const run = connection.run.bind(connection), close = connection.close.bind(connection);
      t.mock.method(connection, "run", async turn => {
        assert.equal(readJob(s.dir).backendLiveness.enabled, true, "the real open-time ping answered");
        deadlineTimer = t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
          if (ms === 30000) { pingDeadlines++; return setTimer(callback, 20, ...args); }
          return setTimer(callback, ms, ...args);
        });
        const running = run(turn); now = 10 * 60000;
        await waitFor(() => readJob(s.dir).backendLiveness.misses === 1);
        now += 5 * 60000;
        return running;
      });
      t.mock.method(connection, "close", async () => {
        if (closeMs != null) return close();
        const started = Date.now(); await close(); closeMs = Date.now() - started;
        deadlineTimer.mock.restore();
        installFakeCodex(s.ctx.bin, "job", { turnMs: 30 });
      });
    }
    return connection;
  });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "completed"); assert.equal(connections, 2);
  assert.equal(job.automaticResumes.length, 1); assert.equal(job.automaticResumes[0].reason, "app-server");
  assert.match(job.attempts[0].transportErrors[0], /codex stopped answering \(account\/read, 30 s\)/);
  assert.equal(job.attempts[0].servers[0].signal, "SIGKILL");
  assert.ok(closeMs >= 4500 && closeMs < 12000, `bounded close took ${closeMs} ms`);
  assert.equal(pingDeadlines, 2, "both missed pings use the real 30-second request deadline");
});

test("initialize with no reply fails the job at its control deadline", async t => {
  const { writeExecutable } = await import("./support/helpers.mjs");
  const s = seed(t); s.unblock();
  writeExecutable(path.join(s.ctx.bin, "codex"), '#!/usr/bin/env node\nprocess.stdin.resume();\n');
  const setTimer = globalThis.setTimeout;
  let deadlineSeen = false;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 120000) { deadlineSeen = true; return setTimer(callback, 10, ...args); }
    return setTimer(callback, ms, ...args);
  });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(deadlineSeen, true); assert.equal(job.state, "failed");
  assert.match(job.errorMessage, /codex stopped answering \(initialize, 120 s\)/);
  assert.ok(job.attempts[0].servers[0].endedAt);
});

test("an unanswered open-time ping disables the watchdog and the job still completes", async t => {
  const { TransportTimeout } = await import("../plugins/relay/scripts/lib/backends/transport/stdio-rpc.mjs");
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    t.mock.method(connection, "ping", async () => { throw new TransportTimeout("codex", "account/read", 30000); });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed");
  assert.equal(readJob(s.dir).backendLiveness.enabled, false);
  assert.match(fs.readFileSync(jobPaths(s.dir).events, "utf8"), /watchdog disabled/);
});

test("a steer that never answers is queued with recovery evidence and cannot hang settleInflight", async t => {
  const s = seed(t, "[held] Wait for the steer."); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => setTimer(callback, ms === 30000 ? 20 : ms, ...args));
  let connections = 0, steer;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args); connections++;
    if (connections === 1) {
      const send = connection.client.sendMessage.bind(connection.client);
      t.mock.method(connection.client, "sendMessage", message => { if (message.method !== "turn/steer") send(message); });
      const run = connection.run.bind(connection);
      t.mock.method(connection, "run", turn => {
        steer = postInboxMessage(s.dir, { kind: "steer", text: "[quick] Next turn." });
        return run(turn);
      });
    }
    return connection;
  });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "completed"); assert.equal(connections, 2);
  assert.ok(job.messages.some(m => m.id === steer.id && m.action === "queued-next-turn" && /stopped answering/.test(m.reason)));
  assert.ok(["turn-started", "delivered-before"].includes(readOutcome(s.dir, steer.id).action));
  assert.equal(job.automaticResumes.length, 1);
});

test("a worker leaves a silent 25-minute sleep alive while the backend answers pings", async t => {
  const s = seed(t); s.unblock();
  let now = 0, pings = 0, turns = 0, finished = false;
  s.options.now = () => now; s.options.env.RELAY_JOBS_HEARTBEAT_MS = "10";
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), close = connection.close.bind(connection);
    t.mock.method(connection, "ping", async () => { pings++; });
    t.mock.method(connection, "close", async () => { assert.equal(finished, true); await close(); });
    t.mock.method(connection, "run", async turn => {
      turns++; turn.onPending(); turn.onTurnId("long-sleep");
      for (let minute = 1; minute <= 25; minute++) {
        now = minute * 60000;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(connection.server.wedged, null);
      }
      finished = true;
      return { turnStatus: "completed", finalMessage: "Sleep finished" };
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed"); assert.equal(turns, 1); assert.equal(pings, 5);
  assert.equal(readJob(s.dir).automaticResumes?.length ?? 0, 0);
});


test("an inbox cancel claimed during ZCode's initial acknowledgement prevents discarded-input resend", async t => {
  const { installFakeZcode } = await import("./fakes/zcode.mjs");
  const s = seed(t); s.unblock(); s.ctx.env.ZCODE_BINARY = installFakeZcode(s.ctx.bin).binary;
  writeJob(s.dir, { ...readJob(s.dir), request: buildLaunchRequest({ backend: "zcode", model: "default", effort: "default", cd: s.ctx.work }, { baseDir: s.ctx.work, env: s.ctx.env }) });
  const backend = backendNamed("zcode"), connect = backend.connect;
  let resolveAck, params, sends = 0;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), request = connection.client.request.bind(connection.client);
    t.mock.method(connection.client, "request", (method, input, options) => {
      if (method === "v4/command" && input.type === "sendText") {
        sends++; params = input;
        if (sends === 1) return new Promise(resolve => { resolveAck = resolve; });
      }
      return request(method, input, options);
    });
    return connection;
  });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => resolveAck);
  const cancel = postInboxMessage(s.dir, { kind: "cancel" });
  await waitFor(() => fs.existsSync(path.join(s.dir, "inbox", "claimed", `${cancel.id}.json`)));
  resolveAck({ commandId: params.commandId, status: "failed", reasonCode: "fault.command.inputDiscardedOnRestart" });
  await running;
  assert.equal(readJob(s.dir).state, "cancelled"); assert.equal(sends, 1);
  assert.equal(readOutcome(s.dir, cancel.id).action, "cancelled");
});

test("an in-turn retry preserves probe ownership until a later provider answer restores service", async t => {
  const { recordRefusal, admit, listPauses } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  const home = s.ctx.env.RELAY_ADMISSION_HOME, deps = { ...s.options.admission, env: s.ctx.env };
  recordRefusal(home, "codex", { kind: "rate" }, "previous", deps); s.tick(D.ratePauseMs);
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    t.mock.method(connection, "run", async turn => {
      turn.onPending(); turn.onTurnId("probe-retrying");
      const file = path.join(home, "pauses", "codex.json"), before = JSON.parse(fs.readFileSync(file)).probe;
      turn.onProviderLimit({ codexErrorInfo: { rateLimitExceeded: {} }, message: "Rate limit, retrying" });
      assert.deepEqual(JSON.parse(fs.readFileSync(file)).probe, before);
      s.tick(D.maxRatePauseMs + D.probeMs);
      assert.equal(admit({ home, jobId: "second-probe", request: readJob(s.dir).request, me: readJob(s.dir).worker }, deps).waitKind, "probe");
      turn.onProviderResponse(); assert.equal(listPauses(s.ctx.env, deps).length, 0);
      return { turnStatus: "completed", finalMessage: "Recovered" };
    });
    return connection;
  });
  await runWorker(s.dir, s.options); assert.equal(readJob(s.dir).state, "completed");
});
