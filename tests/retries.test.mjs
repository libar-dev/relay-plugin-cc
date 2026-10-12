import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeCodex } from "./fakes/codex.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { companion, finishJob, HEADER, jobDir, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { DEFAULT_RESUME_MESSAGE } from "../plugins/relay/scripts/lib/worker/recovery.mjs";

// Capacity backoff and cancellation
{

  // How a capacity or request-rate failure is retried
  // depends on whether the failed turn did work, and a cancel during the wait starts no turn.

  const RATE_LIMIT = { message: "rate limit exceeded: Rate limit reached for requests", codexErrorInfo: "rateLimitExceeded", additionalDetails: null };
  const TOOL = { type: "commandExecution", id: "append-tool", command: "append one record", status: "completed", exitCode: 0 };
  const COMMENTARY = { type: "agentMessage", id: "commentary", phase: "commentary", text: "I will inspect the file." };

  function codex(t, options, env = {}) {
    const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "1,1,1", ...env } });
    installFakeCodex(ctx.bin, "job-capacity", { turnMs: 50, capacityError: RATE_LIMIT, ...options });
    return ctx;
  }

  test("a request-rate failure after a tool call is retried as a continuation; the brief is sent once", async t => {
    const ctx = codex(t, { capacityFailures: 1, capacityWork: [TOOL] });
    const brief = "Append one record.";
    const { id } = startJob(ctx, HEADER, brief);
    await finishJob(ctx, id);
    const starts = ctx.fakeState().turnStarts;
    assert.deepEqual(starts.map(start => start.prompt), [brief, DEFAULT_RESUME_MESSAGE]);
    assert.equal(starts[0].clientUserMessageId, `brief-${id}`);
    assert.notEqual(starts[1].clientUserMessageId, `brief-${id}`);
    assert.equal(starts[1].threadId, starts[0].threadId);
    const job = readJob(ctx, id);
    assert.equal(job.state, "completed");
    assert.deepEqual(job.capacityRetries.map(entry => entry.kind), ["continuation"]);
    assert.match(job.capacityRetries[0].error, /Rate limit reached for requests/);
  });

  test("commentary followed by a request-rate failure is retried", async t => {
    const ctx = codex(t, { capacityFailures: 1, capacityWork: [COMMENTARY] });
    const { id } = startJob(ctx, HEADER, "Inspect then act.");
    await finishJob(ctx, id);
    const job = readJob(ctx, id);
    assert.equal(job.state, "completed");
    assert.equal(job.capacityRetries.length, 1);
    // Commentary is an item beyond the user's message: the retry continues the turn.
    assert.equal(job.capacityRetries[0].kind, "continuation");
    assert.deepEqual(ctx.fakeState().turnStarts.map(start => start.prompt), ["Inspect then act.", DEFAULT_RESUME_MESSAGE]);
  });

  test("a failed turn that did no work is retried by sending the same input again", async t => {
    const ctx = codex(t, { capacityFailures: 2 });
    const { id } = startJob(ctx, HEADER, "No work yet.");
    await finishJob(ctx, id);
    const starts = ctx.fakeState().turnStarts;
    assert.deepEqual(starts.map(start => [start.prompt, start.clientUserMessageId]), Array(3).fill(["No work yet.", `brief-${id}`]));
    assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["resend", "resend"]);
  });

  test("a second failure after work retries the continuation, never the brief", async t => {
    const ctx = codex(t, { capacityFailures: 2, capacityWork: [TOOL] });
    const { id } = startJob(ctx, HEADER, "Work, fail, fail.");
    await finishJob(ctx, id);
    const starts = ctx.fakeState().turnStarts;
    assert.deepEqual(starts.map(start => start.prompt), ["Work, fail, fail.", DEFAULT_RESUME_MESSAGE, DEFAULT_RESUME_MESSAGE]);
    assert.equal(starts.filter(start => start.prompt === "Work, fail, fail.").length, 1);
    assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["continuation", "continuation"]);
  });

  test("a cancel during a retry's wait starts no further turn", async t => {
    const ctx = codex(t, { capacityFailures: 3 }, { RELAY_JOBS_CAPACITY_DELAYS_MS: "10000" });
    const { id } = startJob(ctx, HEADER, "Append once.");
    await waitFor(() => readJob(ctx, id).capacityRetries?.length === 1);
    const cancelled = companion(ctx, ["cancel", id]);
    assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
    await finishJob(ctx, id, 5);
    assert.equal(ctx.fakeState().turnStarts.length, 1);
    const job = readJob(ctx, id);
    assert.equal(job.state, "cancelled");
    assert.equal(job.attempts.at(-1).state, "cancelled");
  });

  test("Grok: a capacity failure after a tool call is retried as a continuation; the brief is sent once", async t => {
    const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "1,1,1" } });
    const fake = installFakeGrok(ctx.bin, { capacityPrompts: 1, capacityWork: true });
    ctx.env.GROK_BINARY = fake.binary;
    const brief = "Append one record.";
    const { id } = startJob(ctx, "backend: grok\nmodel: default\neffort: default", brief);
    await finishJob(ctx, id);
    const state = fake.state();
    assert.deepEqual(state.rejected, [brief]);
    assert.deepEqual(state.turns.map(turn => turn.text), [DEFAULT_RESUME_MESSAGE]);
    assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["continuation"]);
    assert.match(fs.readFileSync(path.join(jobDir(ctx, id), "report.md"), "utf8"), /Report for: Your session was cut off/);
  });

  test("Grok: a capacity failure without work is retried by sending the same input again", async t => {
    const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "1,1,1" } });
    const fake = installFakeGrok(ctx.bin, { capacityPrompts: 1 });
    ctx.env.GROK_BINARY = fake.binary;
    const { id } = startJob(ctx, "backend: grok\nmodel: default\neffort: default", "No work yet.");
    await finishJob(ctx, id);
    assert.deepEqual(fake.state().turns.map(turn => turn.text), ["No work yet."]);
    assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["resend"]);
  });
}

// Work evidence and retry message identity
{

  // Each source of work evidence alone makes the
  // retry a continuation, the user's own message alone never does, and every continuation
  // carries a fresh identifier.

  const RATE_LIMIT = { message: "rate limit exceeded: Rate limit reached for requests", codexErrorInfo: "rateLimitExceeded", additionalDetails: null };
  const TOOL = { type: "commandExecution", id: "append-tool", command: "append one record", status: "completed", exitCode: 0 };
  const USER = { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Brief." }] };

  function codex(t, options) {
    const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "1,1,1" } });
    installFakeCodex(ctx.bin, "job-capacity", { turnMs: 50, capacityError: RATE_LIMIT, capacityFailures: 1, ...options });
    return ctx;
  }

  for (const via of ["started", "completed", "terminal"]) {
    test(`Codex: work seen only as ${via} items makes the retry a continuation`, async t => {
      const ctx = codex(t, { capacityWork: [TOOL], capacityWorkVia: [via] });
      const { id } = startJob(ctx, HEADER, "Brief.");
      await finishJob(ctx, id);
      assert.deepEqual(ctx.fakeState().turnStarts.map(start => start.prompt), ["Brief.", DEFAULT_RESUME_MESSAGE]);
      assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["continuation"]);
    });

    test(`Codex: the user's own message seen as ${via} items is not work; the retry resends the input`, async t => {
      const ctx = codex(t, { capacityWork: [USER], capacityWorkVia: [via] });
      const { id } = startJob(ctx, HEADER, "Brief.");
      await finishJob(ctx, id);
      assert.deepEqual(ctx.fakeState().turnStarts.map(start => [start.prompt, start.clientUserMessageId]), Array(2).fill(["Brief.", `brief-${id}`]));
      assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["resend"]);
    });
  }

  test("every continuation dispatch carries a fresh identifier, consecutive ones too", async t => {
    const ctx = codex(t, { capacityWork: [TOOL], capacityFailures: 3 });
    const { id } = startJob(ctx, HEADER, "Work, fail, fail, fail.");
    await finishJob(ctx, id);
    const ids = ctx.fakeState().turnStarts.map(start => start.clientUserMessageId);
    assert.equal(ids.length, 4);
    assert.equal(ids[0], `brief-${id}`);
    assert.equal(new Set(ids).size, 4, `identifiers repeat: ${ids.join(", ")}`);
    assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), ["continuation", "continuation", "continuation"]);
  });

  for (const kind of ["agent_message_chunk", "agent_thought_chunk", "plan", "tool_call", "tool_call_update", "user_message_chunk"]) {
    const work = kind !== "user_message_chunk";
    test(`Grok: ${kind} alone before a capacity failure ${work ? "makes the retry a continuation" : "is not work"}`, async t => {
      const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "1,1,1" } });
      const fake = installFakeGrok(ctx.bin, { capacityPrompts: 1, capacityWork: [kind] });
      ctx.env.GROK_BINARY = fake.binary;
      const { id } = startJob(ctx, "backend: grok\nmodel: default\neffort: default", "Brief.");
      await finishJob(ctx, id);
      assert.deepEqual(fake.state().turns.map(turn => turn.text), [work ? DEFAULT_RESUME_MESSAGE : "Brief."]);
      assert.deepEqual(readJob(ctx, id).capacityRetries.map(entry => entry.kind), [work ? "continuation" : "resend"]);
    });
  }
}
