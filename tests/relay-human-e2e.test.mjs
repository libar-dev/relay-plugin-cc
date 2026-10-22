import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./support/helpers.mjs";
import {
  codexReceived, companion, hookInput, jobDirOf, readJobJson, relayContext,
  RELAY_CMD, runBash, runHookProcess, waitFor
} from "./support/relay-fixture.mjs";
import { readLedger } from "../plugins/relay/scripts/lib/harness/relay.mjs";

async function relayCall(ctx, toolName, toolInput) {
  if (toolName === "Bash") ctx.append(ctx.toolUse(toolInput.command));
  const hook = await runHookProcess(ctx, hookInput(ctx, "PreToolUse", { tool_name: toolName, tool_input: toolInput }));
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.json?.hookSpecificOutput?.permissionDecision, "allow", hook.stdout + hook.stderr);
  const input = hook.json.hookSpecificOutput.updatedInput ?? toolInput;
  return { input, result: toolName === "Bash" ? runBash(ctx, input) : null };
}

async function startHeld(ctx, t) {
  ctx.env.FAKE_CODEX_RELEASE_FILE = path.join(makeTempDir("relay-human-e2e-release-"), "go");
  ctx.append(ctx.prompt("model: gpt-test\neffort: low\n---\n[held] Typed-message brief."));
  const started = await relayCall(ctx, "Bash", { command: `${RELAY_CMD} start --from-relay` });
  assert.equal(started.result.status, 0, started.result.stdout + started.result.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.result.stdout)?.[1];
  assert.ok(jobId, started.result.stdout);
  t.after(() => companion(ctx, ["cancel", jobId]));
  await waitFor(() => readJobJson(ctx, jobId).state === "running" && readJobJson(ctx, jobId).turnId);
  await waitFor(() => codexReceived(ctx).turns.length === 1);
  return jobId;
}

async function waitJob(ctx, jobId) {
  for (let round = 0; round < 10; round++) {
    const waited = await relayCall(ctx, "Bash", { command: `${RELAY_CMD} wait ${jobId} --timeout-seconds 540`, timeout: 600000 });
    assert.equal(waited.result.status, 0, waited.result.stdout + waited.result.stderr);
    if (!waited.result.stdout.startsWith("still running")) return;
  }
  assert.fail("relay wait did not finish");
}

function assertLedger(ctx, jobId, entries) {
  const dir = jobDirOf(ctx, jobId);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox", "relay")).sort(), entries.map((entry) => `${entry.uuid}.json`).sort());
  for (const entry of entries) assert.equal(readLedger(dir, entry.uuid).status, "done");
  assert.doesNotMatch(companion(ctx, ["result", jobId]).stdout, /relay-violation/);
}

test("end to end: typed text steers at the relay's next call and text after hand-back runs a new turn", async (t) => {
  const ctx = relayContext("job", { turnMs: 100 });
  const jobId = await startHeld(ctx, t);
  const duringText = "  Typed while running:\nkeep this spacing.  ";
  const during = ctx.humanQueued(duringText);
  ctx.append(during);
  assert.deepEqual(codexReceived(ctx).steers, [], "typing alone has no wake or delivery hook");
  await relayCall(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
  const steered = await waitFor(() => {
    const received = codexReceived(ctx);
    return received.steers.includes(duringText) && received;
  });
  assert.deepEqual(steered.steers, [duringText], "the fake records the exact typed text without an envelope");
  assert.equal(readLedger(jobDirOf(ctx, jobId), during.uuid).kind, "steer");
  fs.writeFileSync(ctx.env.FAKE_CODEX_RELEASE_FILE, "");
  await waitJob(ctx, jobId);
  const first = await relayCall(ctx, "SubagentHandback", { message: "own summary" });
  assert.equal(first.input.message, companion(ctx, ["result", jobId]).stdout);

  const afterText = "[quick] Typed after the hand-back: another turn.";
  const after = ctx.humanAfterHandback(afterText);
  ctx.append(after);
  await waitJob(ctx, jobId);
  const continued = await waitFor(() => {
    const received = codexReceived(ctx);
    return received.turns.includes(afterText) && received;
  });
  assert.deepEqual(continued.turns, ["[held] Typed-message brief.", afterText]);
  assert.equal(readLedger(jobDirOf(ctx, jobId), after.uuid).kind, "continue");
  const second = await relayCall(ctx, "SubagentHandback", { message: "I passed it on" });
  assert.equal(second.input.message, companion(ctx, ["result", jobId]).stdout);
  assertLedger(ctx, jobId, [during, after]);
});

test("end to end: typed cancel while the job runs cancels it at the relay's next call", async (t) => {
  const ctx = relayContext("job", { turnMs: 100 });
  const jobId = await startHeld(ctx, t);
  const cancel = ctx.humanQueued("cancel");
  ctx.append(cancel);
  const call = await relayCall(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
  assert.equal(call.result.status, 0, call.result.stdout + call.result.stderr);
  await waitFor(() => readJobJson(ctx, jobId).state === "cancelled");
  assert.equal(readLedger(jobDirOf(ctx, jobId), cancel.uuid).kind, "cancel");
  const received = await waitFor(() => {
    const state = codexReceived(ctx);
    return state.turns.length === 1 && state;
  });
  assert.deepEqual(received.steers, []);
  assert.deepEqual(received.turns, ["[held] Typed-message brief."]);
  const handback = await relayCall(ctx, "SubagentHandback", { message: "I cancelled it" });
  assert.equal(handback.input.message, companion(ctx, ["result", jobId]).stdout);
  assertLedger(ctx, jobId, [cancel]);
});
