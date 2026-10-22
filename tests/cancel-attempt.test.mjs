import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setup, startJob, companion, jobDir, readJob, waitFor, ROOT } from "./support/job-helpers.mjs";
import { createJobDir, jobPaths, readJob as readStoredJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { claimInboxMessages, pendingInboxMessages, postInboxMessage, readOutcome, writeOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { acquireWorkerLease, isWorkerAlive, readLease, releaseWorkerLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";

import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { resumeDeadJobOnce } from "../plugins/relay/scripts/lib/worker/recovery.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";

const SCRIPT = path.join(ROOT, "plugins/relay/scripts/companion.mjs");

async function running(t, options = {}) {
  const ctx = setup(t, { turnMs: 60000, ...options });
  const { id } = startJob(ctx, undefined, "Keep working.");
  await waitFor(() => readJob(ctx, id).turnId);
  return { ctx, id, dir: jobDir(ctx, id) };
}

function recorded(t, state, attempts) {
  const ctx = setup(t, { env: { RELAY_JOBS_CANCEL_GRACE_MS: "0" } });
  const id = "job-cancel-attempt";
  const { jobDir: dir } = createJobDir(ctx.work, id, ctx.env);
  writeJob(dir, { id, kind: "task", state, createdAt: new Date().toISOString(), attempts,
    worker: state === "running" ? { pid: 999999, startTime: "gone" } : null });
  return { ctx, id, dir };
}

function cancels(dir) {
  return fs.readdirSync(jobPaths(dir).claimed).filter(name => name.endsWith(".json")).map(name => {
    const message = JSON.parse(fs.readFileSync(path.join(jobPaths(dir).claimed, name), "utf8"));
    return { message, outcome: readOutcome(dir, message.id) };
  }).filter(({ message }) => message.kind === "cancel");
}

function asyncCompanion(ctx, args, extra = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ctx.work, env: { ...ctx.env, ...extra } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
}

test("cancel --attempt 1 cancels running attempt 1 and prints relay.cancel/1 with actions", async t => {
  const { ctx, id, dir } = await running(t);
  const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{\n  "schema": "relay.cancel\/1",/);
  const view = JSON.parse(result.stdout);
  assert.equal(view.state, "cancelled");
  assert.ok(Array.isArray(view.actions));
  assert.ok(view.actions.includes("asked the worker to interrupt the turn"));
  const [cancel] = cancels(dir);
  assert.equal(cancel.message.attempt, 1);
  assert.equal(cancel.outcome.action, "cancelled");
  assert.equal(ctx.fakeState().interrupts.length, 1);
});

test("cancel --attempt 2 at attempt 1 posts nothing and returns attempt-changed JSON on stdout only", async t => {
  const { ctx, id, dir } = await running(t);
  const result = companion(ctx, ["cancel", id, "--attempt", "2", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const error = JSON.parse(result.stdout);
  assert.equal(error.schema, "relay.cancel/1");
  assert.deepEqual(error.error, { kind: "attempt-changed", message: `Job ${id} is at attempt 1, not 2: nothing was cancelled.` });
  assert.deepEqual(pendingInboxMessages(dir), []);
  assert.deepEqual(cancels(dir), []);
  assert.deepEqual(fs.readdirSync(jobPaths(dir).outcomes), []);
  assert.equal(readJob(ctx, id).state, "running");
  assert.equal(isWorkerAlive(readJob(ctx, id).worker), true);
  assert.equal(ctx.fakeState().interrupts?.length ?? 0, 0);
});

test("cancel --attempt 1 accepts a starting job with no attempt", t => {
  const { ctx, id, dir } = recorded(t, "starting", []);
  const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "cancelled");
  assert.equal(cancels(dir)[0].message.attempt, 1);
  assert.equal(cancels(dir)[0].outcome.action, "cancelled");
});

test("cancel of a completed job with any expected attempt records today's no-op receipt", t => {
  const { ctx, id, dir } = recorded(t, "completed", [{ state: "completed" }]);
  for (const attempt of [1, 2, 99]) {
    const result = companion(ctx, ["cancel", id, "--attempt", String(attempt), "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).actions, ["already completed"]);
  }
  assert.equal(cancels(dir).length, 3);
  for (const { message, outcome } of cancels(dir)) {
    assert.equal(message.createdAt.slice(0, 10), new Date().toISOString().slice(0, 10));
    assert.equal(outcome.action, "no-op");
    assert.equal(outcome.reason, "the job had already completed");
  }
});

for (const attempt of ["0", "-1", "x"]) {
  test(`cancel --attempt ${attempt} is a usage error`, t => {
    const { ctx, id, dir } = recorded(t, "starting", []);
    const result = companion(ctx, ["cancel", id, "--attempt", attempt, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).error, { kind: "usage", message: "--attempt must be a positive integer." });
    assert.deepEqual(pendingInboxMessages(dir), []);
    assert.deepEqual(cancels(dir), []);
  });
}

for (const attempt of [1, 2, undefined]) {
  test(`worker cancel ${attempt === undefined ? "without attempt" : `for attempt ${attempt}`} ${attempt === 2 ? "writes no-op and leaves the turn running" : "cancels the current turn"}`, async t => {
    const { ctx, id, dir } = await running(t);
    const message = postInboxMessage(dir, { kind: "cancel", text: "", ...(attempt === undefined ? {} : { attempt }) });
    await waitFor(() => ["cancelled", "no-op"].includes(readOutcome(dir, message.id)?.action));
    if (attempt === 2) {
      assert.deepEqual(readOutcome(dir, message.id), { messageId: message.id, at: readOutcome(dir, message.id).at,
        action: "no-op", reason: "attempt 2 is not the job's current attempt (1)" });
      assert.equal(readJob(ctx, id).state, "running");
      assert.equal(isWorkerAlive(readJob(ctx, id).worker), true);
      assert.equal(ctx.fakeState().interrupts?.length ?? 0, 0);
    } else {
      assert.equal(readJob(ctx, id).state, "cancelled");
      assert.equal(readOutcome(dir, message.id).action, "cancelled");
      assert.equal(ctx.fakeState().interrupts.length, 1);
    }
  });
}

test("cancel waiting for attempt 1 leaves attempt 2 running and its stale message ends no-op", async t => {
  const ctx = setup(t, { turnMs: 8000 });
  // Hold the cancel in the inbox until the queued continuation owns its new attempt.
  const preload = path.join(ctx.root, "hold-cancel.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
import path from "node:path";
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to).includes(path.sep + "claimed" + path.sep)) {
    const message = JSON.parse(fs.readFileSync(from, "utf8"));
    const dir = path.resolve(path.dirname(to), "../..");
    if (message.kind === "cancel" && message.attempt === 1 && JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")).attempts.length === 1) throw new Error("cancel waits for attempt 2");
  }
  return rename.apply(this, arguments);
};
`);
  const { id } = startJob(ctx, undefined, "First turn.", { NODE_OPTIONS: `--import=${preload}` });
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).turnId);
  const continued = companion(ctx, ["continue", id, "--message", "[long] Second turn."]);
  assert.equal(continued.status, 0, continued.stderr);
  const cancelled = asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"], { RELAY_JOBS_CANCEL_GRACE_MS: "20000" });
  await waitFor(() => pendingInboxMessages(dir).some(name => JSON.parse(fs.readFileSync(path.join(jobPaths(dir).inbox, name), "utf8")).kind === "cancel"));
  const result = await cancelled;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.kind, "attempt-changed");
  assert.match(JSON.parse(result.stdout).error.message, /attempt 2|current attempt \(2\)/);
  await waitFor(() => cancels(dir).some(({ outcome }) => outcome?.action === "no-op"));
  await waitFor(() => readJob(ctx, id).attempts.length === 2 && readJob(ctx, id).turnId);
  assert.equal(readJob(ctx, id).state, "running");
  assert.equal(isWorkerAlive(readJob(ctx, id).worker), true);
  assert.equal(ctx.fakeState().interrupts?.length ?? 0, 0);
  assert.equal(cancels(dir)[0].outcome.reason, "attempt 1 is not the job's current attempt (2)");
});

test("dead-worker cancel refuses an attempt change under the lease before writing cancelled", t => {
  const { ctx, id, dir } = recorded(t, "running", [{ attempt: 1, state: "running" }]);
  const preload = path.join(ctx.root, "change-under-lease.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
import path from "node:path";
const read = fs.readFileSync;
let changed = false;
fs.readFileSync = function(file, ...args) {
  const content = read.call(this, file, ...args);
  if (!changed && String(file) === ${JSON.stringify(jobPaths(dir).job)} && /at markCancelledAfterKill/.test(new Error().stack)) {
    const leaseDir = ${JSON.stringify(`${jobPaths(dir).lease}.d`)};
    const latest = fs.readdirSync(leaseDir).filter(name => /^\\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))[0];
    if (JSON.parse(read.call(this, path.join(leaseDir, latest), "utf8")).role !== "cancel") throw new Error("expected cancel lease");
    const job = JSON.parse(String(content));
    job.attempts.push({ attempt: 2, state: "running" });
    changed = true;
    fs.writeFileSync(file, JSON.stringify(job));
    return read.call(this, file, ...args);
  }
  return content;
};
`);
  const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"], { NODE_OPTIONS: `--import=${preload}` });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.kind, "attempt-changed");
  assert.match(JSON.parse(result.stdout).error.message, /at attempt 2, not 1/);
  assert.equal(readStoredJob(dir).state, "running");
  assert.equal(readStoredJob(dir).attempts.length, 2);
  assert.equal(readStoredJob(dir).attempts[0].state, "running");
  assert.deepEqual(pendingInboxMessages(dir), []);
  assert.deepEqual(cancels(dir), []);
  assert.equal(readLease(dir), null);
});

for (const asJson of [true, false]) {
  test(`cancel hand-off uses ${asJson ? "JSON actions without stderr" : "stderr without --json"} and exits 4`, t => {
    const { ctx, id, dir } = recorded(t, "running", [{ attempt: 1, state: "running" }]);
    const holder = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
    assert.equal(acquireWorkerLease(dir, holder), true);
    t.after(() => releaseWorkerLease(dir, holder));
    const result = companion(ctx, ["cancel", id, "--attempt", "1", ...(asJson ? ["--json"] : [])]);
    assert.equal(result.status, 4, result.stdout + result.stderr);
    const handoff = `the job is still running; the cancel is with its worker (pid ${process.pid})`;
    if (asJson) {
      assert.equal(result.stderr, "");
      const view = JSON.parse(result.stdout);
      assert.equal(view.schema, "relay.cancel/1");
      assert.ok(view.actions.includes(handoff));
    } else {
      assert.equal(result.stderr.trim(), `Job ${id} is still running; the cancel is with its worker (pid ${process.pid}).`);
      assert.ok(result.stdout.includes(`cancel: ${handoff}`));
    }
    const [name] = pendingInboxMessages(dir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(jobPaths(dir).inbox, name), "utf8")).attempt, 1);
  });
}


test("worker claims cancel for attempt 1 before beginning a starting job's first attempt", async t => {
  const { ctx, dir } = recorded(t, "starting", []);
  writeJob(dir, { ...readStoredJob(dir), request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: ctx.work }), pendingFirstTurn: true });
  fs.writeFileSync(jobPaths(dir).brief, "First turn.");
  const message = postInboxMessage(dir, { kind: "cancel", text: "", attempt: 1 });
  const job = await runWorker(dir, { env: ctx.env });
  assert.equal(job.state, "cancelled");
  assert.deepEqual(job.attempts, []);
  assert.equal(readOutcome(dir, message.id).action, "cancelled");
  assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false);
});

test("superseded matching cancels all receive interrupt-sent and cancelled while a mismatch gets only no-op", async t => {
  const { ctx, id, dir } = await running(t);
  const worker = readJob(ctx, id).worker;
  process.kill(worker.pid, "SIGSTOP");
  let messages;
  try {
    messages = [1, undefined, 2, 1].map(attempt => postInboxMessage(dir, { kind: "cancel", text: "", ...(attempt ? { attempt } : {}) }));
  } finally {
    process.kill(worker.pid, "SIGCONT");
  }
  await waitFor(() => messages.every(message => ["cancelled", "no-op"].includes(readOutcome(dir, message.id)?.action)));
  const job = readJob(ctx, id);
  for (const message of messages) {
    const actions = job.messages.filter(entry => entry.id === message.id).map(entry => entry.action);
    assert.deepEqual(actions, message.attempt === 2 ? ["no-op"] : ["interrupt-sent", "cancelled"]);
  }
  assert.equal(ctx.fakeState().interrupts.length, 1);
});

function preload(ctx, name, source) {
  const file = path.join(ctx.root, `${name}.mjs`);
  fs.writeFileSync(file, `import fs from "node:fs";\nimport path from "node:path";\n${source}`);
  return { NODE_OPTIONS: `--import=${file}` };
}

function pauseBeforeMark(ctx) {
  const marker = path.join(ctx.root, "before-mark");
  const gate = path.join(ctx.root, "allow-mark");
  const env = preload(ctx, "pause-before-mark", `
const mkdir = fs.mkdirSync;
let paused = false;
fs.mkdirSync = function(...args) {
  if (!paused && /at markCancelledAfterKill/.test(new Error().stack)) {
    paused = true;
    fs.writeFileSync(${JSON.stringify(marker)}, "");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return mkdir.apply(this, args);
};`);
  return { marker, release: () => fs.writeFileSync(gate, ""), env };
}

for (const closing of [false, true]) {
  test(`cancel succeeds and preserves a continue ${closing ? "started during the close wait" : "arriving as attempt 1 is cancelled"}`, async t => {
    const ctx = setup(t, { turnMs: 60000 });
    const marker = path.join(ctx.root, "cancelled");
    const workerEnv = preload(ctx, "continue-on-cancel", `
process.on("SIGTERM", () => fs.appendFileSync(${JSON.stringify(path.join(ctx.root, "worker-signals"))}, "SIGTERM\\n"));
const rename = fs.renameSync;
let posted = false;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (!posted && String(to).endsWith(path.sep + "job.json")) {
    const job = JSON.parse(fs.readFileSync(to, "utf8"));
    if (job.state === "cancelled") {
      posted = true;
      fs.writeFileSync(${JSON.stringify(marker)}, "");
      ${closing ? 'process.kill(process.pid, "SIGSTOP");' : `const id = "continue-after-cancel";
      fs.writeFileSync(path.join(path.dirname(to), "inbox", id + ".json"), JSON.stringify({ id, kind: "continue", text: "[long] Next.", createdAt: new Date().toISOString() }));`}
    }
  }
  return result;
};`);
    const { id } = startJob(ctx, undefined, "First turn.", workerEnv);
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const worker = readJob(ctx, id).worker;
    t.after(() => { try { process.kill(worker.pid, "SIGCONT"); } catch {} });
    const closeMarker = path.join(ctx.root, "closing");
    const cancelEnv = closing ? preload(ctx, "observe-closing", `
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const stack = new Error().stack;
  if (String(file).startsWith("/proc/") && /waitUntil/.test(stack) && !/cancelStopped/.test(stack)) fs.writeFileSync(${JSON.stringify(closeMarker)}, "");
  return read.call(this, file, ...args);
};`) : {};
    const cancelled = asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...cancelEnv, RELAY_JOBS_CANCEL_GRACE_MS: "20000" });
    if (closing) {
      await waitFor(() => fs.existsSync(marker) && fs.existsSync(closeMarker));
      postInboxMessage(dir, { kind: "continue", text: "[long] Next." });
      process.kill(worker.pid, "SIGCONT");
    }
    const result = await cancelled;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    const out = JSON.parse(result.stdout);
    assert.ok(out.actions.includes("attempt 1 was stopped; attempt 2 started since, for a message, and runs on"));
    await waitFor(() => readJob(ctx, id).attempts.length === 2 && readJob(ctx, id).turnId);
    const job = readJob(ctx, id);
    assert.equal(job.attempts[0].state, "cancelled");
    assert.equal(job.state, "running");
    assert.equal(isWorkerAlive(job.worker), true);
    assert.equal(cancels(dir).length, 1);
    assert.equal(cancels(dir)[0].outcome.action, "cancelled");
    assert.equal(fs.existsSync(path.join(ctx.root, "worker-signals")), false);
  });
}

test("wait --auto-resume waits through a cancel sweep after the worker dies and returns cancelled", async t => {
  const { ctx, id, dir } = await running(t);
  const worker = readJob(ctx, id).worker;
  process.kill(worker.pid, "SIGSTOP");
  const pause = pauseBeforeMark(ctx);
  t.after(pause.release);
  const cancelled = asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...pause.env, RELAY_JOBS_CANCEL_GRACE_MS: "20000" });
  await waitFor(() => pendingInboxMessages(dir).length > 0);
  process.kill(worker.pid, "SIGKILL");
  await waitFor(() => fs.existsSync(pause.marker));
  let waitFinished = false;
  const waiting = asyncCompanion(ctx, ["wait", id, "--auto-resume", "--timeout-seconds", "15", "--json"]).then(result => { waitFinished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(waitFinished, false);
  assert.equal(readJob(ctx, id).attempts.length, 1);
  assert.equal(readJob(ctx, id).automaticResumes?.length ?? 0, 0);
  pause.release();
  const result = await cancelled;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "cancelled");
  assert.equal(readJob(ctx, id).attempts[0].state, "cancelled");
  assert.equal(cancels(dir)[0].outcome.action, "cancelled");
  const waited = await waiting;
  assert.equal(waited.status, 5, waited.stdout + waited.stderr);
  assert.equal(JSON.parse(waited.stdout).state, "cancelled");
  assert.deepEqual(fs.readdirSync(path.join(dir, "cancelling")), []);
});

for (const beforeAttempt of [false, true]) {
  test(`a cancel kill preserves a continue's new worker ${beforeAttempt ? "before its attempt starts" : "after attempt 2 starts"}`, async t => {
    const ctx = setup(t, { turnMs: 60000 });
    const workerEnv = preload(ctx, "stop-after-interrupt", `
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to).includes(path.sep + "outcomes" + path.sep) && JSON.parse(fs.readFileSync(from, "utf8")).action === "interrupt-sent") process.kill(process.pid, "SIGSTOP");
  return rename.apply(this, arguments);
};`);
    const { id } = startJob(ctx, undefined, "First turn.", workerEnv);
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const pause = pauseBeforeMark(ctx);
    t.after(pause.release);
    const cancelled = asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...pause.env, RELAY_JOBS_CANCEL_GRACE_MS: "1200" });
    await waitFor(() => fs.existsSync(pause.marker));
    writeOutcome(dir, cancels(dir)[0].message.id, { action: "interrupt-sent" });
    const started = path.join(ctx.root, "new-worker");
    const gate = path.join(ctx.root, "new-worker-go");
    const continueEnv = beforeAttempt ? preload(ctx, "pause-new-worker", `
const read = fs.readFileSync;
let paused = false;
fs.readFileSync = function(file, ...args) {
  if (!paused && String(file).endsWith(path.sep + "job.json") && /runWorkerRound/.test(new Error().stack)) {
    paused = true;
    fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return read.call(this, file, ...args);
};`) : {};
    t.after(() => fs.writeFileSync(gate, ""));
    const continued = asyncCompanion(ctx, ["continue", id, "--message", "[long] Next."], continueEnv);
    if (beforeAttempt) await waitFor(() => fs.existsSync(started));
    else await waitFor(() => readJob(ctx, id).attempts.length === 2 && readJob(ctx, id).turnId);
    pause.release();
    fs.writeFileSync(gate, "");
    const result = await cancelled;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const out = JSON.parse(result.stdout);
    assert.ok(out.actions.some(action => action.startsWith("killed the worker process")));
    const expected = "attempt 1 was stopped; attempt 2 started since, for a message, and runs on";
    assert.ok(out.actions.includes(expected), result.stdout);
    fs.writeFileSync(gate, "");
    assert.equal((await continued).status, 0);
    await waitFor(() => readJob(ctx, id).attempts.length === 2 && readJob(ctx, id).turnId);
    assert.equal(isWorkerAlive(readJob(ctx, id).worker), true);
    assert.equal(cancels(dir).length, 1);
    assert.equal(cancels(dir)[0].outcome.action, "cancelled");
    assert.equal(cancels(dir)[0].outcome.reason, "the cancel stopped attempt 1's worker");
  });
}

test("delegated no-op reports attempt-changed with the worker's reason", t => {
  const { ctx, id, dir } = recorded(t, "running", [{ attempt: 1, state: "running" }]);
  const holder = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  assert.equal(acquireWorkerLease(dir, holder), true);
  t.after(() => releaseWorkerLease(dir, holder));
  const env = preload(ctx, "delegate-refusal", `
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (String(to).endsWith(".json") && path.dirname(String(to)) === ${JSON.stringify(jobPaths(dir).inbox)}) {
    const message = JSON.parse(fs.readFileSync(to, "utf8"));
    fs.writeFileSync(path.join(${JSON.stringify(jobPaths(dir).outcomes)}, message.id + ".json"), JSON.stringify({ action: "no-op", reason: "attempt 1 is not the job's current attempt (2)" }));
  }
  return result;
};`);
  const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).error, { kind: "attempt-changed", message: `Job ${id}: attempt 1 is not the job's current attempt (2); nothing was cancelled.` });
});

for (const role of ["recovery", "cancel"]) {
  for (const scoped of [true, false]) {
    test(`cancel ${scoped ? "with attempt" : "without attempt"} retries a ${role} lease after killing the worker`, async t => {
      const { ctx, id, dir } = await running(t);
      process.kill(readJob(ctx, id).worker.pid, "SIGSTOP");
      const pause = pauseBeforeMark(ctx);
      t.after(pause.release);
      let finished = false;
      const cancelling = asyncCompanion(ctx, ["cancel", id, ...(scoped ? ["--attempt", "1"] : []), "--json"],
        { ...pause.env, RELAY_JOBS_CANCEL_GRACE_MS: "100" }).then(result => { finished = true; return result; });
      await waitFor(() => fs.existsSync(pause.marker));
      const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
      assert.equal(acquireWorkerLease(dir, me, role), true);
      t.after(() => releaseWorkerLease(dir, me));
      pause.release();
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(finished, false);
      releaseWorkerLease(dir, me);
      const result = await cancelling;
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).state, "cancelled");
      assert.equal(readJob(ctx, id).attempts[0].state, "cancelled");
      assert.deepEqual(fs.readdirSync(path.join(dir, "cancelling")), []);
    });
  }
}

test("after a kill a new worker takes the pending cancel, closes attempt 1 cancelled and drops the continue", async t => {
  const { ctx, id, dir } = await running(t);
  process.kill(readJob(ctx, id).worker.pid, "SIGSTOP");
  const pause = pauseBeforeMark(ctx);
  t.after(pause.release);
  const cancelling = asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"],
    { ...pause.env, RELAY_JOBS_CANCEL_GRACE_MS: "2000" });
  await waitFor(() => fs.existsSync(pause.marker));
  const started = path.join(ctx.root, "new-worker");
  const gate = path.join(ctx.root, "new-worker-go");
  const env = preload(ctx, "hold-new-worker", `
const read = fs.readFileSync;
let paused = false;
fs.readFileSync = function(file, ...args) {
  if (!paused && String(file).endsWith(path.sep + "job.json") && /runWorkerRound/.test(new Error().stack)) {
    paused = true;
    fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return read.call(this, file, ...args);
};`);
  t.after(() => fs.writeFileSync(gate, ""));
  const continuing = asyncCompanion(ctx, ["continue", id, "--message", "[long] Next.", "--json"], env);
  await waitFor(() => fs.existsSync(started));
  const pid = Number(fs.readFileSync(started, "utf8"));
  pause.release();
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(gate, "");
  const result = await cancelling;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const view = JSON.parse(result.stdout);
  assert.equal(view.state, "cancelled");
  assert.ok(view.actions.includes(`the cancel went to the job's new worker (pid ${pid}), which ended it cancelled`));
  const continued = await continuing;
  assert.equal(continued.status, 0, continued.stdout + continued.stderr);
  assert.equal(JSON.parse(continued.stdout).outcome.action, "dropped");
  const job = readJob(ctx, id);
  assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].state, "cancelled");
  assert.ok(job.attempts[0].endedAt);
  assert.equal(cancels(dir).length, 1);
  assert.equal(cancels(dir)[0].outcome.action, "cancelled");
});

test("a worker dying by itself followed by a continue is refused rather than reported stopped by this cancel", async t => {
  const { ctx, id, dir } = await running(t);
  const worker = readJob(ctx, id).worker;
  process.kill(worker.pid, "SIGSTOP");
  const pause = pauseBeforeMark(ctx);
  t.after(pause.release);
  const cancelling = asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"],
    { ...pause.env, RELAY_JOBS_CANCEL_GRACE_MS: "20000" });
  await waitFor(() => pendingInboxMessages(dir).length > 0);
  process.kill(worker.pid, "SIGKILL");
  await waitFor(() => fs.existsSync(pause.marker));
  claimInboxMessages(dir);
  const continued = companion(ctx, ["continue", id, "--message", "[long] Next."]);
  assert.equal(continued.status, 0, continued.stdout + continued.stderr);
  await waitFor(() => readJob(ctx, id).attempts.length === 2 && readJob(ctx, id).turnId);
  pause.release();
  const result = await cancelling;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.kind, "attempt-changed");
  assert.equal(readJob(ctx, id).state, "running");
  assert.equal(isWorkerAlive(readJob(ctx, id).worker), true);
});

for (const queued of [false, true]) {
  test(`early cancellation ${queued ? "with queued work" : "without queued work"} saves cancelled before publishing outcomes and closes the predecessor`, async t => {
    const { ctx, dir } = recorded(t, "running", [{ attempt: 1, state: "running" }]);
    writeJob(dir, { ...readStoredJob(dir), request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: ctx.work }) });
    const message = postInboxMessage(dir, { kind: "cancel", text: "", attempt: 1 });
    if (queued) postInboxMessage(dir, { kind: "continue", text: "Next." });
    const rename = fs.renameSync;
    let checked = false;
    t.after(() => { fs.renameSync = rename; });
    fs.renameSync = function(from, to) {
      if (String(to) === path.join(jobPaths(dir).outcomes, `${message.id}.json`)) {
        const job = readStoredJob(dir);
        assert.equal(job.state, "cancelled");
        assert.equal(job.attempts[0].state, "cancelled");
        assert.ok(job.attempts[0].endedAt);
        checked = true;
      }
      return rename.apply(this, arguments);
    };
    const job = await runWorker(dir, { env: ctx.env });
    assert.equal(checked, true);
    assert.equal(job.state, "cancelled");
    assert.equal(readOutcome(dir, message.id).action, "cancelled");
    assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false);
  });
}

async function idleWorker(t) {
  const fixture = recorded(t, "running", [{ attempt: 1, state: "running" }]);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => child.kill("SIGKILL"));
  const worker = { pid: child.pid, startTime: readProcessStartTime(child.pid) };
  writeJob(fixture.dir, { ...readStoredJob(fixture.dir), worker });
  return { ...fixture, worker };
}

for (const action of ["cancelled", "nothing-to-cancel"]) {
  test(`a taken ${action} with attempt 2 running stops the grace promptly and reports accurately`, async t => {
    const { ctx, id, dir, worker } = await idleWorker(t);
    const env = preload(ctx, "publish-taken", `
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (path.dirname(String(to)) === ${JSON.stringify(jobPaths(dir).inbox)}) {
    const message = JSON.parse(fs.readFileSync(to, "utf8"));
    const file = ${JSON.stringify(jobPaths(dir).job)};
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    job.attempts[0] = { ...job.attempts[0], state: "completed", endedAt: new Date().toISOString() };
    job.attempts.push({ attempt: 2, state: "running" });
    fs.writeFileSync(file, JSON.stringify(job));
    fs.writeFileSync(path.join(${JSON.stringify(jobPaths(dir).outcomes)}, message.id + ".json"), JSON.stringify({ action: ${JSON.stringify(action)}, state: "completed" }));
  }
  return result;
};`);
    const started = Date.now();
    const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...env, RELAY_JOBS_CANCEL_GRACE_MS: "5000" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(Date.now() - started < 3000, "an accepted cancel must not wait out the grace after attempt 2 starts");
    const expected = action === "nothing-to-cancel" ? "attempt 1 had already ended (completed); attempt 2 runs"
      : "attempt 1 was stopped; attempt 2 started since, for a message, and runs on";
    assert.ok(JSON.parse(result.stdout).actions.includes(expected));
    assert.equal(isWorkerAlive(worker), true);
  });
}

for (const delegated of [false, true]) {
  test(`${delegated ? "delegated" : "running"} cancel reads the view before an outcome published at the decision boundary`, async t => {
    const { ctx, id, dir, worker } = await idleWorker(t);
    if (delegated) {
      writeJob(dir, { ...readStoredJob(dir), worker: { pid: 999999, startTime: "gone" } });
      assert.equal(acquireWorkerLease(dir, worker), true);
      t.after(() => releaseWorkerLease(dir, worker));
    }
    const env = preload(ctx, "decision-boundary", `
const read = fs.readFileSync;
let armed = false;
let decided = false;
let viewRead = false;
let messageId;
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (path.dirname(String(to)) === ${JSON.stringify(jobPaths(dir).inbox)}) {
    messageId = JSON.parse(read.call(fs, to, "utf8")).id;
    const file = ${JSON.stringify(jobPaths(dir).job)};
    const job = JSON.parse(read.call(fs, file, "utf8"));
    job.attempts.push({ attempt: 2, state: "running" });
    job.worker = ${JSON.stringify(worker)};
    fs.writeFileSync(file, JSON.stringify(job));
    armed = true;
  }
  return result;
};
fs.readFileSync = function(file, ...args) {
  const stack = new Error().stack;
  if (armed && String(file) === ${JSON.stringify(jobPaths(dir).job)} && /loadJobViewSettled/.test(stack) && !/cancelStopped/.test(stack)) viewRead = true;
  if (armed && viewRead && !decided && /checkRefused/.test(stack) && String(file).endsWith(messageId + ".json")) {
    decided = true;
    fs.writeFileSync(file, JSON.stringify({ action: "cancelled" }));
  }
  return read.call(this, file, ...args);
};`);
    const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...env, RELAY_JOBS_CANCEL_GRACE_MS: "0" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(JSON.parse(result.stdout).actions.includes("attempt 1 was stopped; attempt 2 started since, for a message, and runs on"));
    assert.equal(isWorkerAlive(worker), true);
  });
}

test("a cooperative scoped cancel never signals the worker when attempt 2 begins inside the sweep", async t => {
  const { ctx, id, dir, worker } = await idleWorker(t);
  const signals = path.join(ctx.root, "signals");
  const env = preload(ctx, "sweep-transition", `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
let accepted = false;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (path.dirname(String(to)) === ${JSON.stringify(jobPaths(dir).inbox)}) {
    const message = JSON.parse(fs.readFileSync(to, "utf8"));
    const file = ${JSON.stringify(jobPaths(dir).job)};
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    job.state = "cancelled";
    job.attempts[0].state = "cancelled";
    fs.writeFileSync(file, JSON.stringify(job));
    fs.writeFileSync(path.join(${JSON.stringify(jobPaths(dir).outcomes)}, message.id + ".json"), JSON.stringify({ action: "cancelled" }));
    accepted = true;
  }
  return result;
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function(...args) {
  if (accepted && /stopProcessSnapshot/.test(new Error().stack)) {
    const file = ${JSON.stringify(jobPaths(dir).job)};
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.attempts.length === 1) {
      job.state = "running";
      job.attempts.push({ attempt: 2, state: "running" });
      fs.writeFileSync(file, JSON.stringify(job));
    }
  }
  return spawnSync.apply(this, args);
};
syncBuiltinESMExports();
const kill = process.kill;
process.kill = function(pid, signal) {
  if (Math.abs(pid) === ${worker.pid} && signal !== 0) fs.appendFileSync(${JSON.stringify(signals)}, String(signal) + "\\n");
  return kill.apply(this, arguments);
};`);
  const result = companion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...env, RELAY_JOBS_CANCEL_GRACE_MS: "100" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(signals), false, "no signal may reach the reusable worker, even if it survives SIGTERM");
  const view = JSON.parse(result.stdout);
  assert.ok(view.actions.includes(`the worker (pid ${worker.pid}) is still closing; it is left to finish`));
  assert.ok(view.actions.includes("attempt 1 was stopped; attempt 2 started since, for a message, and runs on"));
  assert.equal(view.state, "running");
});

test("a crash before the final cancel outcome leaves terminal state that automatic recovery cannot resume", async t => {
  const ctx = setup(t, { turnMs: 60000 });
  const marker = path.join(ctx.root, "crashed-before-outcome");
  const env = preload(ctx, "crash-before-outcome", `
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to).includes(path.sep + "outcomes" + path.sep) && JSON.parse(fs.readFileSync(from, "utf8")).action === "cancelled") {
    const dir = path.resolve(path.dirname(to), "../..");
    fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync(path.join(dir, "job.json"), "utf8"));
    process.kill(process.pid, "SIGKILL");
  }
  return rename.apply(this, arguments);
};`);
  const { id } = startJob(ctx, undefined, "First turn.", env);
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).turnId);
  const worker = readJob(ctx, id).worker;
  const result = await asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitFor(() => fs.existsSync(marker) && !isWorkerAlive(worker));
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).state, "cancelled");
  assert.equal(cancels(dir)[0].outcome.action, "interrupt-sent");
  assert.deepEqual(fs.readdirSync(path.join(dir, "cancelling")), []);
  assert.equal(await resumeDeadJobOnce(dir, ctx.env), false);
  assert.equal(readJob(ctx, id).attempts.length, 1);
  assert.equal(readJob(ctx, id).automaticResumes?.length ?? 0, 0);
});

test("after a kill the attempt advance under cancel's own lease is preserved and its outcome is final", async t => {
  const { ctx, id, dir } = await running(t);
  process.kill(readJob(ctx, id).worker.pid, "SIGSTOP");
  const env = preload(ctx, "advance-under-cancel-lease", `
const read = fs.readFileSync;
let changed = false;
fs.readFileSync = function(file, ...args) {
  const content = read.call(this, file, ...args);
  if (!changed && String(file) === ${JSON.stringify(jobPaths(dir).job)} && /at markCancelledAfterKill/.test(new Error().stack)) {
    const leaseDir = ${JSON.stringify(`${jobPaths(dir).lease}.d`)};
    const latest = fs.readdirSync(leaseDir).filter(name => /^\\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))[0];
    if (JSON.parse(read.call(this, path.join(leaseDir, latest), "utf8")).role !== "cancel") throw new Error("expected cancel lease");
    const job = JSON.parse(String(content));
    job.attempts.push({ attempt: 2, state: "running" });
    changed = true;
    fs.writeFileSync(file, JSON.stringify(job));
    return read.call(this, file, ...args);
  }
  return content;
};`);
  const result = await asyncCompanion(ctx, ["cancel", id, "--attempt", "1", "--json"], { ...env, RELAY_JOBS_CANCEL_GRACE_MS: "100" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(JSON.parse(result.stdout).actions.includes("attempt 1 was stopped; attempt 2 started since, for a message, and runs on"));
  assert.equal(readJob(ctx, id).state, "running");
  assert.equal(readJob(ctx, id).attempts.length, 2);
  const [name] = pendingInboxMessages(dir);
  const message = JSON.parse(fs.readFileSync(path.join(jobPaths(dir).inbox, name), "utf8"));
  assert.equal(readOutcome(dir, message.id).action, "cancelled");
  assert.equal(readOutcome(dir, message.id).reason, "the cancel stopped attempt 1's worker");
});
