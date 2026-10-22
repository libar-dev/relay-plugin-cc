import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setup, startJob, companion, jobDir, readJob, waitFor, ROOT } from "./support/job-helpers.mjs";
import { createJobDir, jobPaths, readJob as readStoredJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { pendingInboxMessages, postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { acquireWorkerLease, isWorkerAlive, readLease, releaseWorkerLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";

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
  assert.deepEqual(JSON.parse(result.stdout).error, { kind: "attempt-changed", message: `Job ${id} is at attempt 2, not 1: nothing was cancelled.` });
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
