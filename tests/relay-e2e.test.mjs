// End to end: the hook script and the companion together, against the fake Codex backend.
// A simulated relay runs the commands of agents/job.md literally; before each of its tool
// calls the hook runs as a process, the way Claude Code runs it. The relay transcript grows
// with entries in the shapes of the real transcripts. The test asserts what Codex received.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  codexReceived,
  companion,
  hookInput,
  jobDirOf,
  PLUGIN_ROOT,
  readJobJson,
  relayContext,
  RELAY_CMD,
  runBash,
  runHookProcess,
  waitFor
} from "./support/relay-fixture.mjs";
import { makeTempDir } from "./support/helpers.mjs";

const AGENT = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "job.md"), "utf8");

// The relay's wait loop, as agents/job.md words it: run wait again while its output starts
// with `still running`. Such a wait exits 0: the hook adds `--exit-zero-while-running`.
function stillRunning(waited) {
  assert.ok(AGENT.includes("If the output starts with `still running`"), "agents/job.md words the loop differently");
  if (!waited.result.stdout.startsWith("still running")) {
    return false;
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);
  return true;
}

function agentCommand(suffix) {
  const command = `${RELAY_CMD} ${suffix}`;
  assert.ok(AGENT.includes(command), `agents/job.md does not contain: ${command}`);
  return command;
}

// One relay tool call: PreToolUse hook (a process), then the tool runs with what the hook
// allowed and rewrote. Returns the hook output and, for Bash, the command's result.
async function relayCall(ctx, toolName, toolInput) {
  if (toolName === "Bash") ctx.append(ctx.toolUse(toolInput.command));
  const hook = await runHookProcess(ctx, hookInput(ctx, "PreToolUse", { tool_name: toolName, tool_input: toolInput }));
  assert.equal(hook.status, 0, hook.stderr);
  const output = hook.json?.hookSpecificOutput;
  if (output?.permissionDecision !== "allow") {
    return { decision: output?.permissionDecision ?? null, reason: output?.permissionDecisionReason ?? "" };
  }
  const input = output.updatedInput ?? toolInput;
  if (toolName === "Bash") {
    return { decision: "allow", input, result: runBash(ctx, input) };
  }
  return { decision: "allow", input };
}

for (const ended of [false, true]) {
  test(`end to end: a message queued after the wait boundary wakes ${ended ? "a completed job continued by the guard" : "the running job's current wait"} at once`, async t => {
    const ctx = relayContext("job", { turnMs: 60000 });
    ctx.append(ctx.prompt(`model: gpt-test\neffort: low\n---\n${ended ? "[quick] " : ""}Wake test.`));
    const started = await relayCall(ctx, "Bash", { command: agentCommand("start --from-relay") });
    assert.equal(started.result.status, 0, started.result.stdout + started.result.stderr);
    const jobId = /^job: (\S+)$/m.exec(started.result.stdout)[1];
    t.after(() => companion(ctx, ["cancel", jobId]));
    await waitFor(() => readJobJson(ctx, jobId).state === (ended ? "completed" : "running"));

    const boundary = new Date(Date.now() - 1000).toISOString();
    if (ended) {
      const beforeBoundary = ctx.peerQueued("B: continue the job.");
      beforeBoundary.timestamp = boundary;
      ctx.append(beforeBoundary);
    }
    const command = `${RELAY_CMD} wait ${jobId} --timeout-seconds 540`;
    ctx.append({ type: "api-request", timestamp: boundary }, ctx.toolUse(command));
    // Queued messages enter the transcript only after the current tool calls return.
    const pending = ctx.peerQueued("C: sent after the boundary.");
    const woke = companion(ctx, ["wake", "--agent", ctx.agentId]);
    assert.equal(woke.status, 0, woke.stderr);
    assert.equal(woke.stdout, `wake: ${jobId}\n`);
    const markerFile = path.join(jobDirOf(ctx, jobId), "relay-wake.json");
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    assert.ok(Date.parse(marker.at) > Date.parse(boundary));

    const hook = await runHookProcess(ctx, hookInput(ctx, "PreToolUse", { tool_name: "Bash", tool_input: { command } }));
    assert.equal(hook.status, 0, hook.stderr);
    const input = hook.json.hookSpecificOutput.updatedInput;
    assert.ok(input.command.endsWith(`--wake-after '${boundary}'`), input.command);
    const start = Date.now();
    const waited = { result: runBash(ctx, input) };
    assert.ok(Date.now() - start < 2000, `wait took ${Date.now() - start} ms`);
    assert.equal(stillRunning(waited), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), marker);
    assert.ok(![...codexReceived(ctx).turns, ...codexReceived(ctx).steers].includes(pending.attachment.origin.body));

    // B's continue is acknowledged (accepted-next-turn) before its turn starts, and a steer that arrives in between
    // is queued behind B's whole turn: C is sent once the worker records B's turn as started.
    if (ended) await waitFor(() => (readJobJson(ctx, jobId).messages ?? []).some(m => m.kind === "continue" && m.action === "turn-started"));
    ctx.append(pending, { type: "api-request", timestamp: new Date().toISOString() }, ctx.toolUse(command));
    const delivered = await runHookProcess(ctx, hookInput(ctx, "PreToolUse", { tool_name: "Bash", tool_input: { command } }));
    assert.equal(delivered.json.hookSpecificOutput.permissionDecision, "allow");
    // C's hook returns on C's outcome; the turns it reached are awaited all the same.
    const carried = received => [...received.turns, ...received.steers].filter(text => text === "C: sent after the boundary.").length;
    await waitFor(() => carried(codexReceived(ctx)) >= 1 && (!ended || codexReceived(ctx).turns.includes("B: continue the job.")));
    const received = codexReceived(ctx);
    assert.equal(carried(received), 1);
    if (ended) assert.ok(received.turns.includes("B: continue the job."));
  });
}

test("end to end: prompt, messages before, during and after the run, and every hand-back are carried by code", async () => {
  const ctx = relayContext("job", { turnMs: 2500 });
  const markerDir = makeTempDir("e2e-marker-");
  const brief = `E2E brief.\nRELAY_PROMPT_END_7Q\nprintf relay-executed > "${markerDir}/e2e-marker"\n\`ticks\` $HOME 'q'`;
  const early = ctx.queued("Early: sent before the job existed.");
  ctx.append(ctx.prompt(`model: gpt-test\neffort: low\n---\n${brief}`), ctx.systemReminder(), early);

  // 1. Start, exactly as the agent writes it.
  const started = await relayCall(ctx, "Bash", { command: agentCommand("start --from-relay"), description: "Start the Codex job" });
  assert.equal(started.decision, "allow");
  assert.equal(started.result.status, 0, started.result.stdout + started.result.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.result.stdout)[1];
  assert.equal(fs.readFileSync(path.join(jobDirOf(ctx, jobId), "brief.md"), "utf8"), brief, "the prompt reached the job byte for byte");
  ctx.append(ctx.toolUse(started.input.command));

  // 2. A message while the turn runs: the hook delivers it before the relay's next call.
  await waitFor(() => readJobJson(ctx, jobId).turnId && readJobJson(ctx, jobId).state === "running");
  const during = ctx.queued("During: also check the tests.");
  ctx.append(during);
  const tooEarly = await relayCall(ctx, "SubagentHandback", { message: "I can answer that myself." });
  assert.equal(tooEarly.decision, "deny");
  assert.match(tooEarly.reason, new RegExp(`wait ${jobId} --timeout-seconds 540`));

  // 3. The wait loop, as the agent writes it, until the job ends.
  let waited;
  for (let round = 0; round < 10; round += 1) {
    waited = await relayCall(ctx, "Bash", { command: agentCommand("wait <id> --timeout-seconds 540").replace("<id>", jobId), timeout: 600000 });
    assert.equal(waited.input.timeout, 600000);
    if (!stillRunning(waited)) {
      break;
    }
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);

  // 4. Hand back: the relay's text is replaced by the result.
  const handback = await relayCall(ctx, "SubagentHandback", { message: "state: completed\n(my own summary)" });
  assert.equal(handback.decision, "allow");
  const firstResult = companion(ctx, ["result", jobId]).stdout;
  assert.equal(handback.input.message, firstResult);
  // The state block is the part before the first `---` line; `dir:` is in it.
  const cut = handback.input.message.indexOf("\n---\n");
  assert.ok(cut > 0, handback.input.message);
  assert.match(handback.input.message.slice(0, cut + 1), /^dir: \S+$/m);
  ctx.append(ctx.toolUse("SubagentHandback"));
  const stopped = await runHookProcess(ctx, hookInput(ctx, "SubagentStop", { last_assistant_message: "Report delivered.", stop_hook_active: false, agent_transcript_path: ctx.transcript }));
  assert.equal(stopped.stdout, "", "no block after a hand-back");

  // 5. A follow-up after the hand-back resumes the relay; it runs wait; the hook continues the thread.
  const after = ctx.afterHandback("[quick] After: one more line, please.");
  ctx.append(after);
  for (let round = 0; round < 10; round += 1) {
    waited = await relayCall(ctx, "Bash", { command: agentCommand("wait <id> --timeout-seconds 540").replace("<id>", jobId), timeout: 600000 });
    if (!stillRunning(waited)) {
      break;
    }
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);
  const second = await relayCall(ctx, "SubagentHandback", { message: "x" });
  assert.equal(second.input.message, companion(ctx, ["result", jobId]).stdout);
  assert.match(second.input.message, /^attempts: (2|3)$/m);

  // 6. The same hooks again deliver nothing new.
  await relayCall(ctx, "Bash", { command: agentCommand("result <id>").replace("<id>", jobId) });
  await runHookProcess(ctx, hookInput(ctx, "SubagentStop", { last_assistant_message: "x", stop_hook_active: false, agent_transcript_path: ctx.transcript }));

  // What Codex received: the brief, then each message exactly once, in order.
  const received = codexReceived(ctx);
  const all = [...received.turns, ...received.steers];
  assert.equal(received.turns[0], brief);
  for (const text of ["Early: sent before the job existed.", "During: also check the tests.", "[quick] After: one more line, please."]) {
    assert.equal(all.filter((value) => value === text).length, 1, `${text} reached Codex ${all.filter((value) => value === text).length} times`);
  }
  assert.ok(received.turns.indexOf("[quick] After: one more line, please.") > 0, "the follow-up after the end ran as a new turn");
  assert.equal(readJobJson(ctx, jobId).sessionId, "thr_1", "the same Codex thread");
  const ledgerDir = path.join(jobDirOf(ctx, jobId), "inbox", "relay");
  assert.deepEqual(fs.readdirSync(ledgerDir).sort(), [early.uuid, during.uuid, after.uuid].map((uuid) => `${uuid}.json`).sort());
  assert.doesNotMatch(companion(ctx, ["result", jobId]).stdout, /relay-violation/);
  assert.equal(fs.existsSync(path.join(markerDir, "e2e-marker")), false, "the brief was never run by a shell");
});

test("end to end: a message from another agent steers the running job, and one after the hand-back continues it", async () => {
  const ctx = relayContext("job", { turnMs: 2500 });
  ctx.append(ctx.prompt("model: gpt-test\neffort: low\n---\nPeer brief."), ctx.systemReminder());
  const started = await relayCall(ctx, "Bash", { command: agentCommand("start --from-relay"), description: "Start the Codex job" });
  assert.equal(started.result.status, 0, started.result.stdout + started.result.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.result.stdout)[1];
  ctx.append(ctx.toolUse(started.input.command));

  // A Workflow agent's SendMessage while the turn runs: the harness's peer entry.
  await waitFor(() => readJobJson(ctx, jobId).turnId && readJobJson(ctx, jobId).state === "running");
  const during = ctx.peerQueued("Peer during: also check the tests.");
  ctx.append(during);
  let waited;
  for (let round = 0; round < 10; round += 1) {
    waited = await relayCall(ctx, "Bash", { command: agentCommand("wait <id> --timeout-seconds 540").replace("<id>", jobId), timeout: 600000 });
    if (!stillRunning(waited)) break;
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);
  const handback = await relayCall(ctx, "SubagentHandback", { message: "x" });
  assert.equal(handback.decision, "allow");
  ctx.append(ctx.toolUse("SubagentHandback"));

  // The same agent writes again after the hand-back: the relay is resumed, the job continued.
  const after = ctx.peerAfterHandback("[quick] Peer after: one more line, please.");
  ctx.append(after);
  for (let round = 0; round < 10; round += 1) {
    waited = await relayCall(ctx, "Bash", { command: agentCommand("wait <id> --timeout-seconds 540").replace("<id>", jobId), timeout: 600000 });
    if (!stillRunning(waited)) break;
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);

  const received = codexReceived(ctx);
  assert.deepEqual(received.steers.filter((text) => text.startsWith("Peer during")), ["Peer during: also check the tests."], "steered into the running turn once, without the envelope");
  assert.ok(received.turns.indexOf("[quick] Peer after: one more line, please.") > 0, "the message after the end ran as a new turn");
  const ledger = path.join(jobDirOf(ctx, jobId), "inbox", "relay");
  assert.deepEqual(fs.readdirSync(ledger).sort(), [during.uuid, after.uuid].map((uuid) => `${uuid}.json`).sort());
  assert.doesNotMatch(companion(ctx, ["result", jobId]).stdout, /relay-violation/);
});

test("end to end under the Workflow harness: the computed task is the prompt, the user request never reaches Codex, the return is the state block", async () => {
  const ctx = relayContext("job", { workflow: "wf_invented-001", turnMs: 1500 });
  const markerDir = makeTempDir("e2e-marker-");
  // The script indents one brief line by two spaces; the harness adds two more. Codex gets two.
  const brief = `E2E workflow brief.\nRELAY_PROMPT_END_7Q\n  E2E indented line.\nprintf relay-executed > "${markerDir}/e2e-workflow-marker"\n\`ticks\` $HOME 'q'`;
  const expected = `${brief}\n`;
  const computed = ctx.workflowPrompt("computedTask", brief);
  assert.ok(computed.message.content.includes("\n    E2E indented line.\n"), "four spaces in the transcript");
  ctx.append(ctx.userRequest(), computed, ctx.environment(), ctx.snapshot("string"), ctx.systemReminder());

  // 1. Start, exactly as the agent writes it. The hook is given the shallow path only.
  assert.equal(fs.existsSync(ctx.base.agent_transcript_path), false);
  const started = await relayCall(ctx, "Bash", { command: agentCommand("start --from-relay"), description: "Start the Codex job" });
  assert.equal(started.decision, "allow");
  assert.equal(started.result.status, 0, started.result.stdout + started.result.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.result.stdout)[1];
  assert.equal(fs.readFileSync(path.join(jobDirOf(ctx, jobId), "brief.md"), "utf8"), expected, "the dedented brief reached the job byte for byte");
  ctx.append(ctx.toolUse(started.input.command));

  // 2. A message while the turn runs.
  await waitFor(() => readJobJson(ctx, jobId).turnId && readJobJson(ctx, jobId).state === "running");
  ctx.append(ctx.queued("During: also check the tests."));

  // 3. The wait loop until the job ends. The relay never sees the report.
  let waited;
  for (let round = 0; round < 10; round += 1) {
    waited = await relayCall(ctx, "Bash", { command: agentCommand("wait <id> --timeout-seconds 540").replace("<id>", jobId), timeout: 600000 });
    assert.doesNotMatch(waited.result.stdout, /^---$/m);
    if (!stillRunning(waited)) {
      break;
    }
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);
  // The report exists; no output the relay reads carries it.
  const reportMarker = "Report for: E2E workflow brief.";
  assert.ok(fs.readFileSync(path.join(jobDirOf(ctx, jobId), "report.md"), "utf8").startsWith(reportMarker));
  const noReport = (text, what) => {
    assert.ok(!text.includes(reportMarker), `${what} carries the report:\n${text}`);
    assert.doesNotMatch(text, /^---$/m, `${what} has a --- line`);
  };
  noReport(waited.result.stdout, "the rewritten wait");

  // 4. result, rewritten to --state-only; its output is the relay's final text.
  const result = await relayCall(ctx, "Bash", { command: agentCommand("result <id>").replace("<id>", jobId) });
  assert.equal(result.decision, "allow");
  const block = result.result.stdout;
  assert.equal(block, companion(ctx, ["result", jobId, "--state-only"]).stdout);
  assert.ok(block.startsWith("state: completed\njob: "), block);
  assert.match(block, /^duration: /m);
  assert.match(block, /^report: \S+$/m);
  assert.match(block, /^dir: \S+$/m);
  assert.ok(!block.includes("---"), "no --- in a workflow return");
  noReport(block, "the rewritten result");
  const json = JSON.parse(companion(ctx, ["result", jobId, "--json", "--state-only"]).stdout);
  assert.equal(json.report, null);
  noReport(JSON.stringify(json, null, 2), "result --json --state-only");
  const stopInput = (text) => hookInput(ctx, "SubagentStop", { last_assistant_message: text, stop_hook_active: false, agent_transcript_path: ctx.base.agent_transcript_path });
  const other = await runHookProcess(ctx, stopInput("Report delivered."));
  assert.equal(other.json?.decision, "block");
  assert.ok(other.json.reason.includes(block), other.json.reason);
  const lead = "Reply with exactly this text and nothing else, with no code fence around it:\n";
  const asked = other.json.reason.slice(other.json.reason.indexOf(lead) + lead.length);
  assert.equal(asked, block);
  noReport(asked, "the SubagentStop expected block");
  const stopped = await runHookProcess(ctx, stopInput(block));
  assert.equal(stopped.stdout, "", "the final text is the state block: no block");

  // What Codex received: the dedented brief first, the message once, the user request never.
  const received = codexReceived(ctx);
  const all = [...received.turns, ...received.steers];
  assert.equal(received.turns[0], expected);
  assert.equal(all.filter((value) => value === "During: also check the tests.").length, 1);
  assert.equal(all.filter((value) => value.includes("Invented request")).length, 0);
  assert.doesNotMatch(companion(ctx, ["result", jobId]).stdout, /relay-violation/);
  assert.equal(fs.existsSync(path.join(markerDir, "e2e-workflow-marker")), false, "the brief was never run by a shell");
});

test("end to end under the Workflow harness: a relay the harness re-spawned takes over the job, waits on it and returns its block", async () => {
  const run = "wf_invented-003";
  const key = "v2:invented-key-003";
  const first = relayContext("job", { workflow: run, turnMs: 3000, journalKey: key });
  first.append(first.userRequest(), first.workflowPrompt(), first.environment(), first.snapshot("string"), first.systemReminder());
  const started = await relayCall(first, "Bash", { command: agentCommand("start --from-relay"), description: "Start the Codex job" });
  assert.equal(started.decision, "allow");
  assert.equal(started.result.status, 0, started.result.stdout + started.result.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.result.stdout)[1];
  first.append(first.toolUse(started.input.command));
  await waitFor(() => readJobJson(first, jobId).turnId && readJobJson(first, jobId).state === "running");

  // The harness drops the first relay (a stall, a lost reply, a usage-limit wait or a user
  // retry) and spawns another with the same prompt, the same journal key and a suffixed label.
  // It runs the agent's commands from the top.
  const retry = relayContext("job", { from: first, workflow: run, label: "relay-test (retry 1)", journalKey: key });
  retry.append(retry.userRequest(), retry.workflowPrompt(), retry.environment(), retry.snapshot("string"), retry.systemReminder());
  const adopted = await relayCall(retry, "Bash", { command: agentCommand("start --from-relay"), description: "Start the Codex job" });
  assert.equal(adopted.decision, "allow");
  assert.equal(adopted.result.status, 0, adopted.result.stdout + adopted.result.stderr);
  assert.match(adopted.result.stdout, new RegExp(`^job: ${jobId}$`, "m"));
  assert.match(adopted.result.stdout, new RegExp(`^relay-adopted: ${retry.agentId} took over from ${first.agentId} at `, "m"));
  retry.append(retry.toolUse(adopted.input.command));
  let waited;
  for (let round = 0; round < 10; round += 1) {
    waited = await relayCall(retry, "Bash", { command: agentCommand("wait <id> --timeout-seconds 540").replace("<id>", jobId), timeout: 600000 });
    if (!stillRunning(waited)) {
      break;
    }
  }
  assert.equal(waited.result.status, 0, waited.result.stdout);
  const result = await relayCall(retry, "Bash", { command: agentCommand("result <id>").replace("<id>", jobId) });
  const block = result.result.stdout;
  assert.equal(block, companion(retry, ["result", jobId, "--state-only"]).stdout);
  assert.match(block, new RegExp(`^relay: ${retry.agentId} workflow ${run} "relay-test"$`, "m"));
  assert.match(block, /^relay-adopted: /m);
  assert.doesNotMatch(block, /^---$/m);
  const stopInput = (text) => hookInput(retry, "SubagentStop", { last_assistant_message: text, stop_hook_active: false, agent_transcript_path: retry.base.agent_transcript_path });
  assert.equal((await runHookProcess(retry, stopInput("Done."))).json?.decision, "block");
  assert.equal((await runHookProcess(retry, stopInput(block))).stdout, "", "the final text is the state block: no block");
  assert.deepEqual(codexReceived(first).turns, ["Invented task. Write one file and reply with one line.\n  Invented indented line.\n"], "Codex ran the brief once");
  const dirs = fs
    .readdirSync(first.home)
    .filter((name) => name !== "relays" && fs.statSync(path.join(first.home, name)).isDirectory())
    .flatMap((slug) => fs.readdirSync(path.join(first.home, slug)));
  assert.deepEqual(dirs, [jobId], "one job directory");
});
