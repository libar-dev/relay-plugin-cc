import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./support/helpers.mjs";
import {
  codexReceived, companion, hookInput, jobDirOf, readJobJson, relayContext,
  RELAY_CMD, runBash, runHookProcess, waitFor
} from "./support/relay-fixture.mjs";
import { readGuardState, readLedger, syncRelayMessages } from "../plugins/relay/scripts/lib/harness/relay.mjs";

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
  if (!ctx.workflow) ctx.append(ctx.prompt("model: gpt-test\neffort: low\n---\n[held] Typed-message brief."));
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
  assert.equal(fs.existsSync(path.join(jobDirOf(ctx, jobId), "relay-wake.json")), false, "typing alone writes no wake marker");
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

test("end to end under the Workflow harness: typed text steers at the next call and only one allowed outer fence passes the stop", async (t) => {
  const ctx = relayContext("job", { workflow: "wf_typed-001", turnMs: 100 });
  ctx.append(ctx.userRequest(), ctx.workflowPrompt("computedTask", "[held] Typed-message Workflow brief."),
    ctx.environment(), ctx.snapshot("string"), ctx.systemReminder());
  const jobId = await startHeld(ctx, t);
  const text = "  Typed into the Workflow relay:\nkeep this spacing.  ";
  const typed = ctx.humanQueued(text);
  ctx.append(typed);
  await relayCall(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
  const received = await waitFor(() => {
    const state = codexReceived(ctx);
    return state.steers.includes(text) && state;
  });
  assert.deepEqual(received.steers, [text]);
  assert.equal(readLedger(jobDirOf(ctx, jobId), typed.uuid).kind, "steer");
  fs.writeFileSync(ctx.env.FAKE_CODEX_RELEASE_FILE, "");
  await waitJob(ctx, jobId);
  const result = await relayCall(ctx, "Bash", { command: `${RELAY_CMD} result ${jobId}` });
  assert.match(result.input.command, /--state-only$/);
  const block = companion(ctx, ["result", jobId, "--state-only"]).stdout;
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(result.result.stdout, block);
  assert.doesNotMatch(block, /^---$/m);
  const stop = (text) => runHookProcess(ctx, hookInput(ctx, "SubagentStop", {
    last_assistant_message: text, stop_hook_active: false
  }));
  const blocked = await stop("I passed your message on");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json?.decision, "block");
  assert.equal(blocked.json.reason, "Your final message must be exactly the job's result, with nothing added or removed. Reply with exactly this text and nothing else, with no code fence around it:\n" + block);
  for (const text of [
    "```passed-your-message-on.to.the-job\n" + block + "```",
    "```yaml-extra\n" + block + "```",
    "```I passed your message on to the job\n" + block + "```",
    "    ```yaml\n" + block + "```",
    "```yaml\n" + block + "    ```",
    block.replace("\n", "\n```I passed your message on to the job\n"),
    block.replace("\n", "\n```\n"),
    "````text\n" + block + "```",
    "````\n```text\n" + block + "```\n````"
  ]) {
    const rejected = await stop(text);
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(rejected.json?.decision, "block", text);
    const reset = await stop(block);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(reset.stdout, "");
  }
  for (const tag of ["", "text", "txt", "plaintext", "plain", "markdown", "md", "yaml", "yml", "ini", "console", "log", "YAML", "Text"]) {
    const stopped = await stop("\n \t\n````" + tag + " \t\n" + block.trimEnd() + "\n````\n \t");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, "", tag);
  }
  for (const [opening, closing] of [
    [" ```yaml", " ```"],
    ["  ```YAML", "  ```"],
    ["   ```Text", "   ```"],
    ["```md", "   ```"],
    ["   ```md", "```"]
  ]) {
    const stopped = await stop(opening + "\n" + block + closing);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, "", opening + " / " + closing);
  }
  assertLedger(ctx, jobId, [typed]);
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

for (const ended of [false, true]) {
  test(`end to end: typed text after an interrupt without hand-back is a ${ended ? "continue after the job ends" : "steer while the job runs"}`, async (t) => {
    const ctx = relayContext("job", { turnMs: 100 });
    const jobId = await startHeld(ctx, t);
    const dir = jobDirOf(ctx, jobId);
    const entries = ctx.interrupted();
    ctx.append(...entries.slice(0, 2));
    if (ended) {
      fs.writeFileSync(ctx.env.FAKE_CODEX_RELEASE_FILE, "");
      await waitFor(() => readJobJson(ctx, jobId).state === "completed");
    }
    assert.equal(readGuardState(ctx.env, ctx.agentId, dir).handback, null);
    ctx.append(entries[2]);
    await relayCall(ctx, "Bash", { command: `${RELAY_CMD} status ${jobId}` });
    const text = "after the interrupt: redirect the job";
    const received = await waitFor(() => {
      const state = codexReceived(ctx);
      return (ended ? state.turns : state.steers).includes(text) && state;
    });
    assert.deepEqual(received.steers, ended ? [] : [text]);
    assert.deepEqual(received.turns, ended ? ["[held] Typed-message brief.", text] : ["[held] Typed-message brief."]);
    assert.equal(readLedger(dir, entries[2].uuid).kind, ended ? "continue" : "steer");
    if (!ended) fs.writeFileSync(ctx.env.FAKE_CODEX_RELEASE_FILE, "");
    await waitJob(ctx, jobId);
    const sync = await syncRelayMessages(ctx.base, dir, { env: ctx.env });
    assert.deepEqual(sync.received, [entries[2].uuid]);
    assert.deepEqual(sync.messages, [{ uuid: entries[2].uuid, text, shape: "human" }]);
    assert.equal(readLedger(dir, entries[0].uuid), null);
    assert.equal(readLedger(dir, entries[1].uuid), null);
    assertLedger(ctx, jobId, [entries[2]]);
  });
}
