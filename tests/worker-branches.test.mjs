import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { backendNamed } from "../plugins/relay/scripts/lib/backends/index.mjs";
import { readLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { createJobDir, jobPaths, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";
import { installFakeZcode } from "./fakes/zcode.mjs";
import { finishJob, jobDir, readJob, ROOT, setup, startJob, waitFor } from "./support/job-helpers.mjs";

function seedJob(ctx, patch = {}, brief = "Never sent.") {
  const id = "job-worker-branches";
  const { jobDir: dir } = createJobDir(ctx.work, id, { RELAY_JOBS_HOME: ctx.jobs });
  fs.writeFileSync(jobPaths(dir).brief, brief);
  writeJob(dir, {
    id, kind: "task", state: "starting", createdAt: new Date().toISOString(),
    request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: ctx.work }, { baseDir: ctx.work, env: ctx.env }),
    pendingFirstTurn: false, attempts: [], ...patch
  });
  return { id, dir };
}

const endedAt = "2026-10-01T00:00:00.000Z";
for (const [label, attempts] of [
  ["no attempts", []],
  ["open attempts", [
    { attempt: 1, state: "failed", turnId: null, endedAt, errorMessage: "Could not start." },
    { attempt: 2, state: "starting", turnId: null },
    { attempt: 3, state: "starting", turnId: null }
  ]]
]) test(`cancel with an empty queue before any turn ran handles ${label}`, async t => {
  const ctx = setup(t);
  // No pending brief or work messages: this must take the empty-queue cancel branch.
  const { id, dir } = seedJob(ctx, { attempts });
  const cancel = postInboxMessage(dir, { kind: "cancel" });
  // A skipped cancel can spin in the hand-off loop. Run it in a child so even that
  // regression cannot starve the parent's bounded wait or its diagnostic/cleanup.
  const worker = spawn(process.execPath, [path.join(ROOT, "plugins/relay/scripts/companion.mjs"), "worker", dir], {
    cwd: ctx.work, env: ctx.env, stdio: ["ignore", "pipe", "pipe"]
  });
  let closed = false, output = "";
  worker.stdout.on("data", chunk => { output += chunk; });
  worker.stderr.on("data", chunk => { output += chunk; });
  worker.on("close", () => { closed = true; });
  try {
    await waitFor(() => closed, 10000).catch(() => assert.fail("worker did not exit within 10 s after cancel"));
    assert.equal(worker.exitCode, 0, output);
  } finally {
    if (!closed) worker.kill("SIGKILL");
    await waitFor(() => closed);
  }

  const job = readJob(ctx, id);
  assert.equal(job.state, "cancelled", "the cancel was not taken");
  assert.equal(job.errorMessage, "Cancelled before a turn ran.");
  assert.equal(job.pendingFirstTurn, false);
  assert.ok(job.completedAt);
  assert.equal(readOutcome(dir, cancel.id).action, "cancelled");
  assert.deepEqual(job.messages.map(message => [message.id, message.action]), [[cancel.id, "cancelled"]]);
  assert.equal(job.attempts.length, attempts.length);
  for (const [index, attempt] of job.attempts.entries()) {
    assert.ok(attempt.endedAt, `attempt ${attempt.attempt} must be closed`);
    assert.equal(attempt.turnId, null);
    if (attempts[index].endedAt) assert.deepEqual(attempt, attempts[index]);
    else assert.equal(attempt.state, "cancelled");
  }
  assert.equal(readLease(dir), null);
  assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false,
    "the fake backend must not even start, let alone receive a turn");
});

test("a pending steer whose turn ends before delivery runs as the next turn", async t => {
  const ctx = setup(t);
  const releaseFile = path.join(ctx.root, "release-turn");
  ctx.env.FAKE_CODEX_RELEASE_FILE = releaseFile;
  const brief = "[held] First turn.";
  const { id, dir } = seedJob(ctx, { pendingFirstTurn: true }, brief);

  // Keep controls unavailable for the first turn so the claimed steer stays pending.
  // The existing fake's [held] barrier lets the test end that turn only after the claim.
  const backend = backendNamed("codex");
  const connect = backend.connect;
  let blockedTurnId = null;
  let allowControls = false;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    const ready = connection.controlsReady.bind(connection);
    t.mock.method(connection, "controlsReady", turnId => {
      if (turnId && !blockedTurnId) blockedTurnId = turnId;
      return (allowControls || turnId !== blockedTurnId) && ready(turnId);
    });
    return connection;
  });

  const running = runWorker(dir, { env: ctx.env });
  try {
    await waitFor(() => readJob(ctx, id).turnId && blockedTurnId);
    const steer = postInboxMessage(dir, { kind: "steer", text: "[quick] Pending steer." });
    await waitFor(() => fs.existsSync(path.join(jobPaths(dir).claimed, `${steer.id}.json`)));
    assert.equal(readOutcome(dir, steer.id), null, "claimed while controls are unavailable");
    fs.writeFileSync(releaseFile, "release");
    await running;

    const job = readJob(ctx, id);
    const messages = (job.messages ?? []).filter(message => message.id === steer.id);
    assert.equal(job.state, "completed");
    assert.deepEqual(messages.map(message => message.action), ["queued-next-turn", "accepted-next-turn", "turn-started"]);
    assert.equal(messages[0].reason, "the turn ended before the steer was delivered");
    assert.deepEqual(job.attempts.map(attempt => [attempt.source, attempt.state]), [["brief", "completed"], ["steer", "completed"]]);
    assert.equal(job.attempts[1].messageId, steer.id);
    assert.equal(readOutcome(dir, steer.id).action, "turn-started");
    assert.equal(readOutcome(dir, steer.id).attempt, 2);
    assert.equal(readOutcome(dir, steer.id).turnId, job.attempts[1].turnId);
    const state = ctx.fakeState();
    assert.deepEqual(state.turnStarts.map(turn => turn.prompt), [brief, steer.text]);
    assert.deepEqual(state.steers ?? [], [], "no steer was sent to the completed turn");
    assert.equal(fs.readFileSync(jobPaths(dir).report, "utf8"), `Report for: ${steer.text}\n`);
    assert.equal(readLease(dir), null);
  } finally {
    allowControls = true;
    fs.writeFileSync(releaseFile, "release");
    if (readLease(dir)) postInboxMessage(dir, { kind: "cancel" });
    await running;
  }
});

test("a steer ZCode accepted but lost with its server is requeued by the worker and runs once", async t => {
  const ctx = setup(t);
  // guideHold acknowledges without draining or starting a turn. Kill only after the
  // worker records that acknowledgement, so ZCode returns this id in unjoinedSteers.
  const fake = installFakeZcode(ctx.bin, { guideHold: true });
  ctx.env.ZCODE_BINARY = fake.binary;
  ctx.env.ZCODE_APP_SERVER_AUTH_MODE = "host";
  ctx.env.RELAY_JOBS_ZCODE_DUPLICATE_MS = "20";
  const { id } = startJob(ctx, "backend: zcode\nmodel: glm-5.3\neffort: default", "[long] First turn.");
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).turnId);
  const steer = postInboxMessage(dir, { kind: "steer", text: "[quick] Lost steer." });
  await waitFor(() => readOutcome(dir, steer.id)?.action === "steered");
  assert.deepEqual(fake.state().turns.map(turn => turn.text), ["[long] First turn."]);
  process.kill(fake.state().starts[0].pid, "SIGKILL");
  await finishJob(ctx, id);

  const job = readJob(ctx, id);
  const messages = job.messages.filter(message => message.id === steer.id);
  assert.equal(job.state, "completed");
  assert.deepEqual(messages.map(message => message.action), ["steered", "queued-next-turn", "accepted-next-turn", "turn-started"]);
  assert.equal(messages[1].reason, "the backend accepted the steer but lost it before a turn took it");
  const attempt = job.attempts.at(-1);
  assert.equal(attempt.source, "steer");
  assert.equal(attempt.messageId, steer.id);
  assert.equal(attempt.state, "completed");
  assert.equal(readOutcome(dir, steer.id).action, "turn-started");
  assert.equal(readOutcome(dir, steer.id).turnId, attempt.turnId);
  assert.equal(readOutcome(dir, steer.id).attempt, attempt.attempt);
  assert.equal(fake.state().starts.length, 2, "the worker recovered on a fresh server");
  assert.equal(job.automaticResumes.length, 1);
  // The restarted command store rejects the old admission as discarded; the adapter
  // retries with a fresh suffix. Only that fresh command actually starts the turn.
  assert.deepEqual(fake.state().turns.filter(turn => turn.text === steer.text).map(turn => turn.commandId), [`${steer.id}~1`]);
  assert.deepEqual(fake.state().inputs.filter(input => input.commandId.split("~")[0] === steer.id)
    .map(input => [input.commandId, input.delivery]), [[steer.id, "guide"], [`${steer.id}~1`, "startNow"]]);
  assert.equal(fs.readFileSync(jobPaths(dir).report, "utf8"), `Report for: ${steer.text}\n`);
});
