// Acknowledged work survives adoption, timeout and an interrupted hook;
// owed work blocks hand-back, and cancellation succeeds only on terminal job state.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./support/helpers.mjs";
import { codexReceived, COMPANION, companion, decision, hookInput, HOOK, jobDirOf, pre,
  readJobJson, reason, relayContext, relayStart, RELAY_CMD, stop, waitFor } from "./support/relay-fixture.mjs";
import { acquireWorkerLease, isWorkerAlive, readLease, releaseWorkerLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { claimInboxMessages, postInboxMessage, readRelayViolations, writeOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { jobPaths, writeJsonAtomic } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { awaitOutcome } from "../plugins/relay/scripts/lib/worker/delivery.mjs";
import { exitCodeFor, loadJobView, renderJobBlock, renderJobList } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { CodexAppServerClient } from "../plugins/relay/scripts/lib/backends/codex/client.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";
import { deliverRelayMessages, readLedger, RELAY_BLOCK_BUDGET } from "../plugins/relay/scripts/lib/harness/relay.mjs";
import { busyViews } from "./support/busy-view.mjs";
import { acquireOwnership, readOwnership, releaseOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";

const QUICK = "model: gpt-test\neffort: low\n---\n[quick] Initial task.";

async function completed(ctx) {
  ctx.append(ctx.prompt(QUICK));
  const { jobId, started } = await relayStart(ctx);
  assert.ok(jobId, started.stdout + started.stderr);
  assert.equal(companion(ctx, ["wait", jobId, "--timeout-seconds", "10"]).status, 0);
  const dir = jobDirOf(ctx, jobId);
  // A worker that releases its lease looks at the inbox once more and runs a message it finds
  // there. The job has no consumer only once that process has ended.
  const { worker } = readJobJson(ctx, jobId);
  await waitFor(() => !readLease(dir) && !isWorkerAlive(worker));
  return { jobId, dir };
}

async function running(ctx) {
  ctx.append(ctx.prompt(QUICK.replace("[quick] ", "")));
  const { jobId, started } = await relayStart(ctx);
  assert.ok(jobId, started.stdout + started.stderr);
  await waitFor(() => readJobJson(ctx, jobId).state === "running" && readJobJson(ctx, jobId).turnId);
  return { jobId, dir: jobDirOf(ctx, jobId) };
}

function runs(ctx, text) {
  const received = codexReceived(ctx);
  return [...received.turns, ...received.steers].filter((entry) => entry === text).length;
}

function holdLease(dir) {
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  assert.equal(acquireWorkerLease(dir, me), true);
  return () => releaseWorkerLease(dir, me);
}

async function assertRunOnce(ctx, jobId, text) {
  const waited = companion(ctx, ["wait", jobId, "--timeout-seconds", "10"]);
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  await waitFor(() => !readLease(jobDirOf(ctx, jobId)));
  assert.equal(runs(ctx, text), 1);
  assert.doesNotMatch(companion(ctx, ["result", jobId, "--state-only"]).stdout, /^undelivered:/m);
}

for (const behavior of ["job", "turn-order-collab-unsupported"]) {
  test(`shutdown with owed work stays running after ${behavior} completion`, async (t) => {
    const ctx = relayContext(behavior, { turnMs: 50, env: { CODEX_HOME: makeTempDir("relay-f1-home-") } });
    const { jobId, dir } = await completed(ctx);
    let closing = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const connect = CodexAppServerClient.connect;
    t.mock.method(CodexAppServerClient, "connect", async function (...args) {
      const client = await connect.apply(this, args);
      const close = client.close.bind(client);
      client.close = async () => {
        if (!closing) {
          closing = true;
          await gate;
        }
        return close();
      };
      return client;
    });
    postInboxMessage(dir, { kind: "continue", text: "[quick] Second report" });
    const work = runWorker(dir, { env: ctx.env });
    let waiter;
    let waited;
    let output = "";
    let waitExit;
    let runsAtWaitExit;
    const text = "[quick] Must run before hand-back";
    try {
      await waitFor(() => closing);
      assert.equal(readJobJson(ctx, jobId).state, "completed");
      assert.equal(readLease(dir).role, "worker");
      const entry = ctx.queued(text);
      ctx.append(entry);
      await deliverRelayMessages(dir, [{ uuid: entry.uuid, text }], { env: ctx.env, wait: false });
      assert.equal(readLedger(dir, entry.uuid).status, "done");
      const view = loadJobView(dir);
      assert.equal(view.state, "running");
      assert.equal(exitCodeFor(view), 4);
      assert.match(renderJobBlock(view), /^state: running$/m);
      assert.match(renderJobList([view]), /\| running +\|/);
      assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "deny");
      assert.equal((await stop(ctx, renderJobBlock(view)))?.decision, "block");
      const timeout = companion(ctx, ["wait", jobId, "--timeout-seconds", "0"]);
      assert.equal(timeout.status, 4, timeout.stdout + timeout.stderr);
      assert.equal(runs(ctx, text), 0);
      waiter = spawn(process.execPath, [COMPANION, "wait", jobId, "--timeout-seconds", "10"],
        { cwd: ctx.work, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
      waiter.stdout.on("data", chunk => { output += chunk; });
      waiter.stderr.on("data", chunk => { output += chunk; });
      waited = once(waiter, "close").then(([code]) => {
        waitExit = code;
        runsAtWaitExit = runs(ctx, text);
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(waitExit, undefined, output);
    } finally {
      release();
      await work;
      if (waited) await waited;
    }
    assert.equal(waitExit, 0, output);
    assert.match(output, /^state: completed$/m);
    assert.equal(runsAtWaitExit, 1);
    assert.ok(output.includes(behavior === "job" ? text : "Candidate report"), output);
    assert.equal(runs(ctx, text), 1);
    assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "allow");
    await waitFor(() => !readLease(dir));
  });
}

test("a live cancel lease leaves owed work undelivered with exit 3", async () => {
  const ctx = relayContext("job", { turnMs: 50 });
  const { jobId, dir } = await completed(ctx);
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid), role: "cancel" };
  assert.equal(acquireWorkerLease(dir, me, "cancel"), true);
  try {
    const message = postInboxMessage(dir, { kind: "continue", text: "[quick] Owed to a worker" });
    const view = loadJobView(dir);
    assert.equal(view.state, "completed");
    assert.deepEqual(view.undelivered, [message.id]);
    assert.equal(exitCodeFor(view), 3);
    assert.equal(companion(ctx, ["wait", jobId, "--timeout-seconds", "0"]).status, 3);
  } finally {
    releaseWorkerLease(dir, me);
  }
});

test("a live worker lease keeps owed work running", async () => {
  const ctx = relayContext("job", { turnMs: 50, env: { CODEX_HOME: makeTempDir("relay-f1-worker-home-") } });
  const { jobId, dir } = await completed(ctx);
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid), startedAt: new Date().toISOString() };
  assert.equal(acquireWorkerLease(dir, me, "worker"), true);
  try {
    assert.equal(readLease(dir).role, "worker");
    postInboxMessage(dir, { kind: "continue", text: "[quick] Owed under a live worker lease" });
    const view = loadJobView(dir);
    assert.equal(view.storedState, "completed");
    assert.equal(view.state, "running");
    assert.deepEqual(view.undelivered, []);
    assert.equal(exitCodeFor(view), 4);
    const waited = companion(ctx, ["wait", jobId, "--timeout-seconds", "0"]);
    assert.equal(waited.status, 4, waited.stdout + waited.stderr);
    assert.match(waited.stdout, /^state: running$/m);
  } finally {
    releaseWorkerLease(dir, me);
  }
});

test("completed Workflow adoption consumes an early message with wait false", async () => {
  const options = { workflow: "wf_delivery", journalKey: "v2:delivery", turnMs: 100 };
  const first = relayContext("job", options);
  first.append(first.workflowPrompt());
  const { jobId } = await relayStart(first);
  assert.equal(companion(first, ["wait", jobId, "--timeout-seconds", "10"]).status, 0);
  await waitFor(() => !readLease(jobDirOf(first, jobId)));
  const retry = relayContext("job", { ...options, from: first });
  const text = "[quick] Include the missing follow-up";
  retry.append(retry.workflowPrompt(), retry.queued(text));
  assert.equal((await relayStart(retry)).jobId, jobId);
  // No later hook may repair a start that acknowledged without a consumer.
  await assertRunOnce(first, jobId, text);
  const block = companion(retry, ["result", jobId, "--state-only"]).stdout;
  assert.equal(await stop(retry, block), null);
  assert.equal(decision(await pre(retry, "SubagentHandback", { message: "done" })), "allow");
  assert.equal(runs(first, text), 1);
});

test("an acknowledgement timeout under a live worker retries the original post exactly once and in order", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const release = holdLease(dir);
  const text = "[quick] Timed-out follow-up";
  const entry = ctx.queued(text);
  const next = ctx.queued("[quick] Second follow-up");
  const messages = [entry, next].map((item) => ({ uuid: item.uuid, text: item.attachment.prompt }));
  try {
    const result = await deliverRelayMessages(dir, messages, { env: { ...ctx.env, RELAY_ACK_TIMEOUT_MS: "1" } });
    assert.equal(result.undelivered.length, 2);
    assert.equal(runs(ctx, text), 0);
    assert.equal(readLedger(dir, next.uuid), null, "later work cannot pass a timed-out post");
  } finally {
    release();
  }
  const id = readLedger(dir, entry.uuid).messageId;
  assert.notEqual(readLedger(dir, entry.uuid).status, "done");
  await deliverRelayMessages(dir, messages, { env: ctx.env });
  assert.equal(readLedger(dir, entry.uuid).messageId, id);
  await deliverRelayMessages(dir, messages, { env: ctx.env });
  await assertRunOnce(ctx, jobId, text);
  assert.equal(runs(ctx, messages[1].text), 1);
  const received = codexReceived(ctx);
  assert.deepEqual([...received.turns, ...received.steers].filter((text) => messages.some((message) => message.text === text)), messages.map((message) => message.text));
});

// A busy job (its record changing during every view) is at work, so a message for it goes as a
// steer. This job had in fact ended: the steer finds no turn and runs as the next one, once.
test("a message for a busy job goes as a steer; on a job that had ended, it runs as the next turn, once", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const text = "[quick] Follow-up to a busy job";
  const entry = ctx.queued(text);
  const restore = busyViews(dir);
  try {
    await deliverRelayMessages(dir, [{ uuid: entry.uuid, text }], { env: ctx.env });
  } finally {
    restore();
  }
  assert.equal(readLedger(dir, entry.uuid).kind, "steer");
  assert.equal(readLedger(dir, entry.uuid).status, "done");
  await assertRunOnce(ctx, jobId, text);
  assert.equal(readJobJson(ctx, jobId).attempts.length, 2);
});

test("a hook killed after posting leaves a retry that runs the message once", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const release = holdLease(dir);
  const text = "[quick] Interrupted delivery";
  const entry = ctx.queued(text);
  ctx.append(entry);
  const child = spawn(process.execPath, [HOOK], { cwd: ctx.work, env: ctx.env, stdio: ["pipe", "ignore", "ignore"] });
  const ended = once(child, "close");
  child.stdin.end(JSON.stringify(hookInput(ctx, "PreToolUse", { tool_name: "Bash", tool_input: { command: `${RELAY_CMD} status ${jobId}` } })));
  let id;
  try {
    await waitFor(() => {
      id = readLedger(dir, entry.uuid)?.messageId;
      return id && fs.existsSync(path.join(jobPaths(dir).inbox, `${id}.json`));
    });
    assert.equal(runs(ctx, text), 0);
  } finally {
    child.kill("SIGKILL");
    await ended;
    release();
  }
  assert.notEqual(readLedger(dir, entry.uuid).status, "done");
  await pre(ctx, "Bash", { command: `${RELAY_CMD} wait ${jobId}` });
  assert.equal(readLedger(dir, entry.uuid).messageId, id);
  await assertRunOnce(ctx, jobId, text);
  await pre(ctx, "Bash", { command: `${RELAY_CMD} result ${jobId}` });
  assert.equal(runs(ctx, text), 1);
});

test("a post error stays pending and a later hook runs the same message once", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const text = "[quick] Retry a failed inbox write";
  const entry = ctx.queued(text);
  ctx.append(entry);
  // A previous hook reserved the id, then an inbox write failed.
  const id = "zzzzzzzz-post-error";
  const ledgerDir = path.join(dir, "inbox", "relay");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, `${entry.uuid}.json`), JSON.stringify({ uuid: entry.uuid, kind: "continue", messageId: id, status: "posting" }));
  const blocked = path.join(jobPaths(dir).inbox, `.${id}.json.tmp`);
  fs.mkdirSync(blocked);
  await assert.rejects(deliverRelayMessages(dir, [{ uuid: entry.uuid, text }], { env: ctx.env, wait: false }), /EISDIR/);
  assert.notEqual(readLedger(dir, entry.uuid).status, "done");
  assert.equal(runs(ctx, text), 0);
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: delivery: messages could not be delivered: EISDIR/m);
  fs.rmdirSync(blocked);
  await pre(ctx, "Bash", { command: `${RELAY_CMD} wait ${jobId}` });
  assert.equal(readLedger(dir, entry.uuid).messageId, id);
  await assertRunOnce(ctx, jobId, text);
  await pre(ctx, "Bash", { command: `${RELAY_CMD} result ${jobId}` });
  assert.equal(runs(ctx, text), 1);
});

test("a consumer lost after a wait-false receipt leaves claimed work for the next hook", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const release = holdLease(dir);
  const text = "[quick] Claimed by the lost consumer";
  const entry = ctx.queued(text);
  ctx.append(entry);
  let id;
  try {
    await deliverRelayMessages(dir, [{ uuid: entry.uuid, text }], { env: ctx.env, wait: false });
    const receipt = readLedger(dir, entry.uuid);
    assert.equal(receipt.status, "done");
    id = receipt.messageId;
    assert.equal(claimInboxMessages(dir)[0].id, id);
    writeOutcome(dir, id, { action: "queued-next-turn" });
    assert.equal(runs(ctx, text), 0);
  } finally {
    release();
  }
  assert.equal(companion(ctx, ["result", jobId]).status, 3);
  await pre(ctx, "Bash", { command: `${RELAY_CMD} wait ${jobId}` });
  assert.equal(readLedger(dir, entry.uuid).messageId, id);
  await assertRunOnce(ctx, jobId, text);
  await pre(ctx, "Bash", { command: `${RELAY_CMD} result ${jobId}` });
  assert.equal(runs(ctx, text), 1);
});

for (const handbackFirst of [false, true]) {
  test(`completed job with owed inbox work blocks stop and hand-back${handbackFirst ? " after an earlier hand-back" : ""}, then escapes with a violation`, async () => {
    const ctx = relayContext("job", { turnMs: 100 });
    const { jobId, dir } = await completed(ctx);
    if (handbackFirst) assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "allow");
    postInboxMessage(dir, { kind: "continue", text: "[quick] Owed outside this transcript" });
    const result = companion(ctx, ["result", jobId]);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /^state: completed$/m);
    assert.match(result.stdout, /^undelivered: 1 /m);
    assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "deny");
    for (let i = 1; i < RELAY_BLOCK_BUDGET; i++) {
      assert.equal((await stop(ctx, result.stdout))?.decision, "block");
    }
    assert.equal(await stop(ctx, result.stdout), null);
    assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: .*let go after 8 blocks/m);
    assert.equal(companion(ctx, ["resume", jobId]).status, 0);
    await assertRunOnce(ctx, jobId, "[quick] Owed outside this transcript");
  });
}

test("cancel timeout is visible and the next hook retries successfully", async () => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  const entry = ctx.queued("cancel");
  ctx.append(entry);
  ctx.env.RELAY_CANCEL_TIMEOUT_MS = "1";
  await pre(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
  assert.notEqual(readLedger(dir, entry.uuid).status, "done");
  assert.equal(readJobJson(ctx, jobId).state, "running");
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: cancel: .*attempt 1 failed:.*ETIMEDOUT/m);
  delete ctx.env.RELAY_CANCEL_TIMEOUT_MS;
  await pre(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
  assert.equal(readJobJson(ctx, jobId).state, "cancelled");
  assert.equal(readLedger(dir, entry.uuid).status, "done");
  assert.equal(readLedger(dir, entry.uuid).tries, 2);
});

test("nonzero cancel records stderr and remains retryable", async () => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  const messages = [{ uuid: ctx.queued("cancel").uuid, text: "cancel" }];
  const wrongEnv = { ...ctx.env, RELAY_JOBS_HOME: makeTempDir("relay-empty-jobs-") };
  const result = await deliverRelayMessages(dir, messages, { env: wrongEnv });
  assert.equal(result.undelivered.length, 1);
  const receipt = readLedger(dir, messages[0].uuid);
  assert.equal(receipt.exitCode, 1);
  assert.notEqual(receipt.status, "done");
  assert.equal(readJobJson(ctx, jobId).state, "running");
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: cancel: .*exit 1: .*No job found/m);
  await deliverRelayMessages(dir, messages, { env: ctx.env });
  assert.equal(readJobJson(ctx, jobId).state, "cancelled");
  assert.equal(readLedger(dir, messages[0].uuid).status, "done");
});

test("three failed cancels close as failed and a terminal job is a successful no-op", async () => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  const messages = [{ uuid: ctx.queued("cancel").uuid, text: "cancel" }];
  const env = { ...ctx.env, RELAY_JOBS_HOME: makeTempDir("relay-empty-jobs-") };
  for (let i = 0; i < 3; i++) await deliverRelayMessages(dir, messages, { env });
  const receipt = readLedger(dir, messages[0].uuid);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.tries, 3);
  const violations = readRelayViolations(dir);
  assert.equal(violations.length, 3);
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: cancel: .*closed as failed after 3 tries started/m);
  assert.equal((await deliverRelayMessages(dir, messages, { env })).undelivered.length, 0);
  assert.equal(readRelayViolations(dir).length, 3);
  assert.equal(readJobJson(ctx, jobId).state, "running");
  assert.equal(companion(ctx, ["cancel", jobId]).status, 0);
  const noop = [{ uuid: ctx.queued("cancel").uuid, text: "cancel" }];
  await deliverRelayMessages(dir, noop, { env: ctx.env });
  assert.equal(readLedger(dir, noop[0].uuid).status, "done");
  assert.equal(readJobJson(ctx, jobId).state, "cancelled");
  assert.equal(readRelayViolations(dir).length, 3);
});

// The actual companion process can fail, publish a terminal job, or remain in flight.
// Each launch writes its pid to a scratch counter so interrupted tries can be counted.
function cancelFixture(ctx, dir, mode) {
  const scratch = makeTempDir("relay-cancel-command-");
  const counter = path.join(scratch, "counter.txt");
  const preload = path.join(scratch, "cancel.mjs");
  fs.writeFileSync(counter, "");
  fs.writeFileSync(preload, `import fs from "node:fs";
if (process.argv[2] === "cancel") {
  fs.appendFileSync(process.env.RELAY_TEST_CANCEL_COUNTER, process.pid + "\\n");
  const mode = process.env.RELAY_TEST_CANCEL_MODE;
  if (mode === "terminal-nonzero") {
    const file = process.env.RELAY_TEST_CANCEL_JOB;
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...job, state: "completed" }));
  }
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  process.stderr.write("fixture cancel failure\\n");
  process.exit(mode === "zero" ? 0 : 7);
}
`);
  return {
    env: { ...ctx.env, NODE_OPTIONS: `--import ${preload}`, RELAY_TEST_CANCEL_COUNTER: counter,
      RELAY_TEST_CANCEL_JOB: jobPaths(dir).job, RELAY_TEST_CANCEL_MODE: mode },
    pids: () => fs.readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).map(Number)
  };
}

test("a nonzero cancel that ends the job is done and records one violation", async () => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  // Stop the real worker first so the fixture alone publishes the terminal state.
  assert.equal(companion(ctx, ["cancel", jobId]).status, 0);
  await waitFor(() => !readLease(dir));
  writeJsonAtomic(jobPaths(dir).job, { ...readJobJson(ctx, jobId), state: "running" });
  const fixture = cancelFixture(ctx, dir, "terminal-nonzero");
  const entry = ctx.queued("cancel");
  await deliverRelayMessages(dir, [{ uuid: entry.uuid, text: "cancel" }], { env: fixture.env });
  assert.equal(readLedger(dir, entry.uuid).status, "done");
  assert.equal(readLedger(dir, entry.uuid).exitCode, 7);
  assert.equal(readJobJson(ctx, jobId).state, "completed");
  assert.equal(fixture.pids().length, 1);
  assert.equal(readRelayViolations(dir).length, 1);
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: cancel: .*exit 7: fixture cancel failure/m);
});

test("interrupting the third cancel try permits no fourth command", async () => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  const fixture = cancelFixture(ctx, dir, "nonzero");
  const entry = ctx.queued("cancel");
  const messages = [{ uuid: entry.uuid, text: "cancel" }];
  for (let i = 0; i < 2; i++) await deliverRelayMessages(dir, messages, { env: fixture.env });
  ctx.append(entry);
  const child = spawn(process.execPath, [HOOK], { cwd: ctx.work,
    env: { ...fixture.env, RELAY_TEST_CANCEL_MODE: "hang" }, stdio: ["pipe", "ignore", "ignore"] });
  const ended = once(child, "close");
  child.stdin.end(JSON.stringify(hookInput(ctx, "PreToolUse", { tool_name: "Bash", tool_input: { command: `${RELAY_CMD} status ${jobId}` } })));
  try {
    await waitFor(() => fixture.pids().length === 3);
    assert.equal(readLedger(dir, entry.uuid).tries, 3);
    assert.equal(readLedger(dir, entry.uuid).status, "posting");
  } finally {
    child.kill("SIGKILL");
    await ended;
    const pid = fixture.pids()[2];
    if (pid) {
      const startTime = readProcessStartTime(pid);
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await waitFor(() => !isWorkerAlive({ pid, startTime }));
    }
  }
  Object.assign(ctx.env, fixture.env);
  await pre(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
  assert.equal(fixture.pids().length, 3);
  assert.equal(readLedger(dir, entry.uuid).status, "failed");
  assert.equal(readLedger(dir, entry.uuid).tries, 3);
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: cancel: .*closed as failed after 3 tries started; no further command/m);
});

test("setup before posting on the adoption start path records one violation", async () => {
  const options = { workflow: "wf_setup_failure", journalKey: "v2:setup-failure", turnMs: 100 };
  const first = relayContext("job", options);
  first.append(first.workflowPrompt());
  const { jobId } = await relayStart(first);
  assert.equal(companion(first, ["wait", jobId, "--timeout-seconds", "10"]).status, 0);
  const dir = jobDirOf(first, jobId);
  await waitFor(() => !readLease(dir));
  const retry = relayContext("job", { ...options, from: first });
  retry.append(retry.workflowPrompt(), retry.queued("[quick] Setup failed"));
  const inbox = jobPaths(dir).inbox;
  const saved = path.join(dir, "saved-inbox");
  fs.renameSync(inbox, saved);
  fs.writeFileSync(inbox, "obstruct inbox setup");
  try {
    const { started } = await relayStart(retry);
    assert.notEqual(started.status, 0, started.stdout + started.stderr);
    const { listJobDirs } = await import("../plugins/relay/scripts/lib/jobs/store.mjs");
    assert.deepEqual(listJobDirs({ env: retry.env }), [dir], "uncertain adoption must never submit a duplicate job");
    assert.equal(readRelayViolations(dir).length, 1);
    assert.match(readRelayViolations(dir)[0].reason, /messages could not be delivered: Message storage uncertain:.*ENOTDIR/);
  } finally {
    fs.unlinkSync(inbox);
    fs.renameSync(saved, inbox);
  }
  assert.match(companion(first, ["result", jobId]).stdout, /^relay-violation: delivery: .*storage uncertain:.*ENOTDIR/m);
});

test("wait false reports no consumer on timeout", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { dir } = await completed(ctx);
  const message = postInboxMessage(dir, { kind: "continue", text: "[quick] No consumer yet" });
  const result = await awaitOutcome(dir, message.id, { env: ctx.env, wait: false, timeoutMs: 0 });
  assert.equal(result.consumer, false);
  assert.equal(result.outcome.action, "not-started");
  assert.equal(runs(ctx, message.text), 0);
});

test("a fresh terminal job without worker pid starts its consumer at once", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  writeJsonAtomic(jobPaths(dir).job, { ...readJobJson(ctx, jobId), worker: null, createdAt: new Date().toISOString() });
  const text = "[quick] Fresh terminal consumer";
  const message = postInboxMessage(dir, { kind: "continue", text });
  const result = await awaitOutcome(dir, message.id, { env: ctx.env, wait: false, timeoutMs: 1000 });
  assert.equal(result.consumer, true);
  assert.equal(result.spawned, 1);
  await assertRunOnce(ctx, jobId, text);
});

test("owed work exhausts the hand-back budget on its own", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  postInboxMessage(dir, { kind: "continue", text: "[quick] Hand-back owed work" });
  for (let i = 0; i < RELAY_BLOCK_BUDGET; i++) {
    assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "deny");
  }
  const released = await pre(ctx, "SubagentHandback", { message: "done" });
  assert.equal(decision(released), "allow");
  assert.match(released.hookSpecificOutput.updatedInput.message, /^relay-violation: handback-blocked: .*let go after 8 blocks/m);
  assert.match(released.hookSpecificOutput.updatedInput.message, /^undelivered: 1 /m);
  assert.equal(companion(ctx, ["resume", jobId]).status, 0);
  await assertRunOnce(ctx, jobId, "[quick] Hand-back owed work");
});

test("a zero-exit cancel on a running job stays open and later work stays unposted", async () => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  const fixture = cancelFixture(ctx, dir, "zero");
  const cancel = ctx.queued("cancel");
  const later = ctx.queued("[quick] Must not pass cancel");
  const result = await deliverRelayMessages(dir, [cancel, later].map((entry) => ({ uuid: entry.uuid, text: entry.attachment.prompt })), { env: fixture.env });
  assert.equal(readJobJson(ctx, jobId).state, "running");
  assert.equal(readLedger(dir, cancel.uuid).exitCode, 0);
  assert.equal(readLedger(dir, cancel.uuid).status, "posting");
  assert.equal(result.undelivered.length, 2);
  assert.equal(readLedger(dir, later.uuid), null);
  assert.equal(fs.readdirSync(jobPaths(dir).inbox).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(runs(ctx, later.attachment.prompt), 0);
  assert.match(companion(ctx, ["result", jobId]).stdout, /^relay-violation: cancel: .*job is still nonterminal/m);
});

test("terminal publication during liveness check is terminal, never dead", async (t) => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const original = readJobJson(ctx, jobId);
  const pid = 1073741823;
  writeJsonAtomic(jobPaths(dir).job, { ...original, state: "running", worker: { pid } });
  const kill = process.kill.bind(process);
  let published = false;
  t.mock.method(process, "kill", (target, signal) => {
    if (target !== pid || signal !== 0) return kill(target, signal);
    writeJsonAtomic(jobPaths(dir).job, { ...original, state: "completed" });
    published = true;
    const error = new Error("worker exited after publishing completion");
    error.code = "ESRCH";
    throw error;
  });
  const view = loadJobView(dir);
  assert.equal(published, true);
  assert.equal(view.state, "completed");
  assert.equal(view.deadReason, null);
});

// The cancel command's lease is no consumer. Cancel is paused
// just before it releases the lease, and a follow-up is delivered with wait:false then.
test("a cancel's lease is no consumer for wait-false delivery, and the cancel starts a worker for it", async (t) => {
  const ctx = relayContext("job", { turnMs: 30000 });
  const { jobId, dir } = await running(ctx);
  const old = readJobJson(ctx, jobId);
  process.kill(old.worker.pid, "SIGKILL");
  await waitFor(() => !isWorkerAlive(old.worker));
  const sync = makeTempDir("relay-cancel-pause-");
  const entered = path.join(sync, "entered");
  const go = path.join(sync, "go");
  const records = `${jobPaths(dir).lease}.d`;
  const injection = path.join(sync, "pause-release.mjs");
  fs.writeFileSync(injection, `import fs from "node:fs";
import path from "node:path";
const original = fs.linkSync;
fs.linkSync = function (from, to, ...rest) {
  if (path.dirname(String(to)) === ${JSON.stringify(records)} && JSON.parse(fs.readFileSync(from, "utf8")).release === true) {
    fs.writeFileSync(${JSON.stringify(entered)}, "");
    while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return original.call(this, from, to, ...rest);
};
`);
  const child = spawn(process.execPath, ["--import", injection, COMPANION, "cancel", jobId], { env: ctx.env, cwd: ctx.work, stdio: "ignore" });
  const ended = once(child, "close");
  t.after(async () => { fs.writeFileSync(go, ""); await ended; });
  const text = "[quick] After cancellation";
  const entry = ctx.queued(text);
  ctx.append(entry);
  let receipt;
  try {
    await waitFor(() => fs.existsSync(entered));
    assert.equal(readLease(dir).role, "cancel");
    await deliverRelayMessages(dir, [{ uuid: entry.uuid, text }], { env: { ...ctx.env, RELAY_ACK_TIMEOUT_MS: "1500" }, wait: false });
    receipt = readLedger(dir, entry.uuid);
  } finally {
    fs.writeFileSync(go, "");
    await ended;
  }
  assert.equal(receipt, null, "a cancel lease cannot accept work; the refused mapping was removed");
  assert.equal(runs(ctx, text), 0);
  // The next hook posts the withdrawn message again and gets a real consumer.
  await deliverRelayMessages(dir, [{ uuid: entry.uuid, text }], { env: ctx.env, wait: false });
  await waitFor(() => runs(ctx, text) === 1);
  await waitFor(() => readJobJson(ctx, jobId).state === "completed" && !readLease(dir));
  assert.equal(readLedger(dir, entry.uuid).status, "done");
  assert.equal(runs(ctx, text), 1);
});

// Claimed work that never ran needs a consumer when the previous one is gone.
test("wait false starts a consumer for claimed but unrun work", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await completed(ctx);
  const text = "[quick] Claimed, then the worker died";
  const message = postInboxMessage(dir, { kind: "continue", text });
  assert.equal(claimInboxMessages(dir)[0].id, message.id);
  writeOutcome(dir, message.id, { action: "queued-next-turn" });
  const got = await awaitOutcome(dir, message.id, { env: ctx.env, wait: false, timeoutMs: 10000 });
  assert.equal(got.consumer, true);
  assert.equal(got.spawned, 1);
  await assertRunOnce(ctx, jobId, text);
});

test("relay inbox lock timeout returns busy without receipts or violations; release delivers in order", async () => {
  const ctx = relayContext("job", { turnMs: 50, env: { RELAY_LOCK_WAIT_MS: "200" } });
  const { jobId, dir } = await completed(ctx);
  const messages = ["[quick] First after lock release", "[quick] Second after lock release"]
    .map(text => ({ uuid: ctx.queued(text).uuid, text }));
  const lock = path.join(jobPaths(dir).inbox, "relay.lock");
  const owner = acquireOwnership(lock);
  assert.ok(owner);
  const ledgerDir = path.join(jobPaths(dir).inbox, "relay");
  const ledgerFiles = () => fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir) : [];
  const before = ledgerFiles();
  try {
    const result = await deliverRelayMessages(dir, messages, { env: ctx.env });
    assert.deepEqual(result, { busy: true, delivered: [], undelivered: messages });
    assert.deepEqual(readOwnership(lock), owner, "contention leaves the live owner intact");
    assert.deepEqual(ledgerFiles(), before, "a busy delivery writes no ledger entry");
    for (const message of messages) {
      assert.equal(readLedger(dir, message.uuid), null);
      assert.equal(runs(ctx, message.text), 0);
    }
    assert.deepEqual(readRelayViolations(dir), []);
    assert.deepEqual(fs.readdirSync(jobPaths(dir).inbox).filter(name => name.endsWith(".json")), []);
  } finally {
    assert.equal(releaseOwnership(lock), true);
  }
  const result = await deliverRelayMessages(dir, messages, { env: ctx.env });
  assert.equal(result.busy, false);
  assert.deepEqual(result.undelivered, []);
  assert.deepEqual(result.delivered.map(message => message.uuid), messages.map(message => message.uuid));
  await waitFor(() => messages.every(message => runs(ctx, message.text) === 1));
  await assertRunOnce(ctx, jobId, messages[0].text);
  const received = codexReceived(ctx);
  assert.deepEqual([...received.turns, ...received.steers].filter(text => messages.some(message => message.text === text)), messages.map(message => message.text));
  for (const message of messages) assert.equal(readLedger(dir, message.uuid).status, "done");
  assert.deepEqual(readRelayViolations(dir), []);
});

test("relay inbox lock contention holds hand-back with the busy text, then permits it after delivery", async () => {
  const ctx = relayContext("job", { turnMs: 50, env: { RELAY_LOCK_WAIT_MS: "200" } });
  const { jobId, dir } = await completed(ctx);
  const text = "[quick] Owed while hand-back contends for the lock";
  const entry = ctx.queued(text);
  ctx.append(entry);
  const lock = path.join(jobPaths(dir).inbox, "relay.lock");
  const owner = acquireOwnership(lock);
  assert.ok(owner);
  try {
    const held = await pre(ctx, "SubagentHandback", { message: "done" });
    assert.equal(decision(held), "deny");
    assert.ok(reason(held).includes("Messages for the job are being delivered right now."), reason(held));
    assert.equal(readLedger(dir, entry.uuid), null);
    assert.equal(runs(ctx, text), 0);
    assert.deepEqual(readOwnership(lock), owner);
    assert.deepEqual(readRelayViolations(dir), []);
  } finally {
    assert.equal(releaseOwnership(lock), true);
  }
  // A later guard invocation retries the transcript itself. An acknowledgement can
  // precede turn/start, so wait for execution and completion before handing back.
  await pre(ctx, "Bash", { command: `${RELAY_CMD} wait ${jobId}` });
  await waitFor(() => runs(ctx, text) === 1);
  await assertRunOnce(ctx, jobId, text);
  const handedBack = await pre(ctx, "SubagentHandback", { message: "done" });
  assert.equal(decision(handedBack), "allow");
  assert.doesNotMatch(reason(handedBack), /Messages for the job are being delivered right now\./);
  assert.equal(readLedger(dir, entry.uuid).status, "done");
  assert.deepEqual(readRelayViolations(dir), []);
});
