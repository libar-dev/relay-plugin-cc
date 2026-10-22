import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { COMPANION, companion, jobDirOf, readJobJson, relayContext, relayStart, waitFor } from "./support/relay-fixture.mjs";
import { createJobDir, jobPaths, readJob, writeJob, writeJsonAtomic } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { readRelayPointer, writeRelayPointer } from "../plugins/relay/scripts/lib/harness/relay.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";
import { run } from "./support/helpers.mjs";

const BEFORE = "2020-01-01T00:00:00.000Z";
const STILL_RUNNING = "still running: not an error. Run the same wait again.";
const BUSY_IMPORT = `--import=${new URL("./support/busy-view.mjs", import.meta.url).href}`;

async function running(t) {
  const ctx = relayContext("job", { turnMs: 60000 });
  ctx.append(ctx.prompt("model: gpt-test\neffort: low\n---\nKeep working."));
  const { jobId, started } = await relayStart(ctx);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.ok(jobId, started.stdout);
  t.after(() => companion(ctx, ["cancel", jobId]));
  await waitFor(() => readJobJson(ctx, jobId).state === "running" && readJobJson(ctx, jobId).turnId);
  const dir = jobDirOf(ctx, jobId);
  return { ctx, jobId, dir, wake: jobPaths(dir).wake };
}

function recorded(state = "running") {
  const ctx = relayContext();
  const jobId = "job-wake-test";
  const { jobDir: dir } = createJobDir(ctx.work, jobId, ctx.env);
  writeJob(dir, {
    id: jobId, state, createdAt: new Date().toISOString(), attempts: [],
    worker: { pid: process.pid, startTime: readProcessStartTime(process.pid) },
    relay: { agentId: ctx.agentId }
  });
  writeRelayPointer(ctx.env, { agentId: ctx.agentId, jobDir: dir });
  return { ctx, jobId, dir, wake: jobPaths(dir).wake };
}

function mark({ ctx, wake }) {
  const marker = { agentId: ctx.agentId, at: new Date().toISOString() };
  writeJsonAtomic(wake, marker);
  return marker;
}

function relayWait({ ctx, jobId }, seconds, extra = ["--wake-after", BEFORE]) {
  return companion(ctx, ["wait", jobId, "--exit-zero-while-running", "--timeout-seconds", String(seconds), ...extra]);
}

function assertRunning(result, code = 0) {
  assert.equal(result.status, code, result.stdout + result.stderr);
  assert.equal(result.stdout.split("\n")[0], STILL_RUNNING);
  assert.match(result.stdout, /^state: running$/m);
}

function diskTree(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name);
    return fs.statSync(file).isDirectory()
      ? [[name, diskTree(file)]] : [[name, fs.readFileSync(file, "utf8")]];
  });
}

test("wake writes an agent and timestamp for the running job's current relay", async t => {
  const job = await running(t);
  const before = Date.now();
  const result = companion(job.ctx, ["wake", "--agent", job.ctx.agentId]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `wake: ${job.jobId}\n`);
  const marker = JSON.parse(fs.readFileSync(job.wake, "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), ["agentId", "at"]);
  assert.equal(marker.agentId, job.ctx.agentId);
  assert.equal(new Date(marker.at).toISOString(), marker.at);
  assert.ok(Date.parse(marker.at) >= before && Date.parse(marker.at) <= Date.now());
  assert.equal(jobPaths(job.dir).wake, path.join(job.dir, "relay-wake.json"));
  assert.equal(fs.readdirSync(job.dir).some(name => name.endsWith(".tmp")), false);
});

for (const scenario of [
  "unknown agent with no pointer", "pointer without jobDir", "gone job directory", "previous relay after adoption",
  "missing job record", "unreadable job record", "missing jobs home"
]) test(`wake writes nothing and exits zero for ${scenario}`, () => {
  const job = recorded();
  const { ctx, dir } = job;
  if (scenario === "unknown agent with no pointer") fs.rmSync(path.join(ctx.home, "relays", `${ctx.agentId}.json`));
  if (scenario === "pointer without jobDir") writeRelayPointer(ctx.env, { agentId: ctx.agentId });
  if (scenario === "gone job directory") fs.rmSync(dir, { recursive: true });
  if (scenario === "previous relay after adoption") {
    writeJsonAtomic(jobPaths(dir).relay, { agentId: "new-relay", previous: [{ agentId: ctx.agentId }] });
    assert.equal(readJob(dir).relay.agentId, "new-relay");
  }
  if (scenario === "missing job record") fs.rmSync(jobPaths(dir).job);
  if (scenario === "unreadable job record") fs.writeFileSync(jobPaths(dir).job, "{broken");
  if (scenario === "missing jobs home") ctx.env.RELAY_JOBS_HOME = path.join(ctx.home, "missing-home");
  const before = diskTree(ctx.home);
  const result = companion(ctx, ["wake", "--agent", ctx.agentId]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(job.wake), false);
  assert.deepEqual(diskTree(ctx.home), before);
  assert.equal(readRelayPointer(ctx.env, ctx.agentId).jobDir ?? null,
    scenario === "unknown agent with no pointer" || scenario === "pointer without jobDir" || scenario === "missing jobs home" ? null : dir);
});

for (const state of ["completed", "failed", "cancelled", "dead"]) {
  test(`wake writes a marker for the current relay on a ${state} job`, () => {
    const job = recorded(state === "dead" ? "running" : state);
    if (state === "dead") writeJob(job.dir, { ...readJob(job.dir), worker: { pid: 1073741823 } });
    const before = Date.now();
    const result = companion(job.ctx, ["wake", "--agent", job.ctx.agentId]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `wake: ${job.jobId}\n`);
    const marker = JSON.parse(fs.readFileSync(job.wake, "utf8"));
    assert.equal(marker.agentId, job.ctx.agentId);
    assert.ok(Date.parse(marker.at) >= before && Date.parse(marker.at) <= Date.now());
  });
}

test("wake without --agent exits one and writes nothing", () => {
  const { ctx } = recorded();
  const before = diskTree(ctx.home);
  const result = companion(ctx, ["wake"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--agent/);
  assert.equal(result.stdout, "");
  assert.deepEqual(diskTree(ctx.home), before);
});

test("wake writes a marker when the job view is busy", () => {
  const job = recorded();
  const result = run(process.execPath, [COMPANION, "wake", "--agent", job.ctx.agentId], {
    cwd: job.ctx.work, env: { ...job.ctx.env, NODE_OPTIONS: BUSY_IMPORT, RELAY_TEST_BUSY_JOB: job.dir }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `wake: ${job.jobId}\n`);
  assert.equal(JSON.parse(fs.readFileSync(job.wake, "utf8")).agentId, job.ctx.agentId);
});

test("relay wait returns within two seconds of a marker written while it waits and leaves it in place", async t => {
  const job = await running(t);
  const ready = path.join(job.ctx.work, "wait-ready");
  const preload = path.join(job.ctx.work, "wait-ready.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
const read = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const value = read.call(this, file, ...args);
  if (String(file) === ${JSON.stringify(jobPaths(job.dir).job)}) fs.writeFileSync(${JSON.stringify(ready)}, "");
  return value;
};
`);
  const child = spawn(process.execPath, ["--import", preload, COMPANION, "wait", job.jobId,
    "--exit-zero-while-running", "--wake-after", BEFORE, "--timeout-seconds", "60"], { cwd: job.ctx.work, env: job.ctx.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const ended = new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
  t.after(async () => { if (child.exitCode === null) child.kill(); await ended; });
  await waitFor(() => fs.existsSync(ready));
  assert.equal(child.exitCode, null);
  const sent = Date.now();
  const woke = companion(job.ctx, ["wake", "--agent", job.ctx.agentId]);
  assert.equal(woke.status, 0, woke.stderr);
  assert.equal(woke.stdout, `wake: ${job.jobId}\n`);
  const result = await Promise.race([ended, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("wake did not end the wait within two seconds")), 2000);
    timer.unref();
  })]);
  assert.ok(Date.now() - sent < 2000, `wake took ${Date.now() - sent} ms`);
  assertRunning(result);
  assert.equal(fs.existsSync(job.wake), true);
  assert.equal(readJobJson(job.ctx, job.jobId).state, "running");
});

for (const scenario of ["two waits in one assistant message", "a leftover wait and the current relay's wait"]) {
  test(`${scenario} both return at once on the same marker without consuming it`, () => {
    const job = recorded();
    const marker = mark(job);
    for (let call = 0; call < 2; call += 1) {
      const start = Date.now();
      assertRunning(relayWait(job, 60));
      assert.ok(Date.now() - start < 1500, `wait took ${Date.now() - start} ms`);
      assert.deepEqual(JSON.parse(fs.readFileSync(job.wake, "utf8")), marker);
    }
  });
}

for (const at of [BEFORE, "2019-12-31T23:59:59.999Z", "not-a-date"]) {
  test(`wait reaches its timeout and keeps a marker at ${at}`, () => {
    const job = recorded();
    const marker = { agentId: job.ctx.agentId, at };
    writeJsonAtomic(job.wake, marker);
    const start = Date.now();
    assertRunning(relayWait(job, 0.3));
    assert.ok(Date.now() - start >= 300, "wait returned before its timeout");
    assert.deepEqual(JSON.parse(fs.readFileSync(job.wake, "utf8")), marker);
  });
}

for (const extra of [[], ["--exit-zero-while-running"]]) {
  test(`wait without --wake-after ignores a marker at timeout ${extra.join(" ")}`, () => {
    const job = recorded();
    const marker = mark(job);
    const start = Date.now();
    const result = companion(job.ctx, ["wait", job.jobId, "--timeout-seconds", "0.3", ...extra]);
    assert.ok(Date.now() - start >= 300, "wait returned before its timeout");
    if (extra.length) assertRunning(result);
    else assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(job.wake, "utf8")), marker);
  });
}

for (const value of ["not-a-date", ""]) {
  test(`wait rejects an invalid --wake-after ${JSON.stringify(value)}`, () => {
    const job = recorded();
    const marker = mark(job);
    const result = relayWait(job, 60, ["--wake-after", value]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--wake-after must be an ISO date/);
    assert.deepEqual(JSON.parse(fs.readFileSync(job.wake, "utf8")), marker);
  });
}

test("wait without the relay flag ignores a marker and leaves it on disk at timeout", async t => {
  const job = await running(t);
  const marker = mark(job);
  const start = Date.now();
  const result = companion(job.ctx, ["wait", job.jobId, "--timeout-seconds", "0.3"]);
  assert.ok(Date.now() - start >= 300, "wait returned before its timeout");
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /^state: running\n/);
  assert.doesNotMatch(result.stdout, /still running:/);
  assert.deepEqual(JSON.parse(fs.readFileSync(job.wake, "utf8")), marker);
});

test("relay wait keeps a marker when its timeout is already reached", () => {
  const job = recorded();
  mark(job);
  const result = relayWait(job, 0);
  assertRunning(result);
  assert.equal(fs.existsSync(job.wake), true);
  assert.equal(readJob(job.dir).state, "running");
});

for (const [state, code] of [["completed", 0], ["failed", 3], ["cancelled", 5], ["dead", 3]]) {
  test(`relay wait keeps a marker on a ${state} job and preserves its exit code`, () => {
    const job = recorded(state === "dead" ? "running" : state);
    if (state === "completed") fs.writeFileSync(jobPaths(job.dir).report, "Done.\n");
    if (state === "dead") writeJob(job.dir, { ...readJob(job.dir), worker: { pid: 1073741823 } });
    mark(job);
    const result = relayWait(job, 60);
    assert.equal(result.status, code, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^state: ${state}\\n`));
    assert.doesNotMatch(result.stdout, /still running:/);
    assert.equal(fs.existsSync(job.wake), true);
  });
}

test("relay wait keeps a marker and exits zero on a busy view", () => {
  const job = recorded();
  mark(job);
  const start = Date.now();
  const result = run(process.execPath, [COMPANION, "wait", job.jobId,
    "--exit-zero-while-running", "--wake-after", BEFORE, "--timeout-seconds", "60"], {
    cwd: job.ctx.work, env: { ...job.ctx.env, NODE_OPTIONS: BUSY_IMPORT, RELAY_TEST_BUSY_JOB: job.dir }
  });
  assert.ok(Date.now() - start < 1500);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, `${STILL_RUNNING}\n`);
  assert.match(result.stderr, /is busy/);
  assert.equal(fs.existsSync(job.wake), true);
});
