import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./support/helpers.mjs";
import {
  codexReceived, companion, decision, humanEntry, jobDirOf, peerEntry, pre,
  readJobJson, realEntry, relayContext, relayStart, RELAY_CMD, runBash, stop,
  updated, waitFor, workflowEntry
} from "./support/relay-fixture.mjs";
import {
  parseRelayTranscript, readGuardState, readLedger, syncRelayMessages, writeGuardState, writeRelayPointer
} from "../plugins/relay/scripts/lib/harness/relay.mjs";
import { appendRelayViolation, readRelayViolations } from "../plugins/relay/scripts/lib/jobs/messages.mjs";

const QUICK = "model: gpt-test\neffort: low\n---\n[quick] Human brief.";
const queued = () => humanEntry("humanQueuedDuringRun");
const after = () => humanEntry("humanAfterHandback");
const parse = (...entries) => parseRelayTranscript(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const withPrompt = (...entries) => parse(realEntry("prompt"), ...entries);
const wrapperProblem = (entry) => `entry ${entry.uuid} is a typed message whose wrapper is not the one Claude Code 2.1.308 writes; delivered as it is`;
const blockProblem = (entry, count) => `entry ${entry.uuid} is a typed message with ${count} block(s) that are not text; the job gets its text only`;

function setOrigin(entry, origin) {
  (entry.attachment ?? entry).origin = origin;
  return entry;
}

function setContent(entry, content) {
  if (entry.attachment) entry.attachment.prompt = content;
  else entry.message.content = content;
  return entry;
}

test("human fixture: both real typed entries deliver exact text and uuids with shape human", () => {
  const during = queued();
  const resumed = after();
  const parsed = withPrompt(during, resumed);
  assert.deepEqual(parsed.messages, [
    { uuid: during.uuid, text: "typed one: hello from the agent view", shape: "human" },
    { uuid: resumed.uuid, text: "typed two: after the hand-back", shape: "human" }
  ]);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.received, [during.uuid, resumed.uuid]);
});

test("human fixture: only the typed line after an interrupt is delivered and received", () => {
  const entries = ["interruptToolResult", "interruptNote", "humanAfterInterrupt"].map(humanEntry);
  const parsed = withPrompt(...entries);
  assert.deepEqual(parsed.messages, [{
    uuid: entries[2].uuid, text: "after the interrupt: redirect the job", shape: "human"
  }]);
  assert.deepEqual(parsed.received, [entries[2].uuid]);
  assert.deepEqual(parsed.problems, []);
  const interrupted = withPrompt(...entries.slice(0, 2));
  assert.deepEqual(interrupted.messages, []);
  assert.deepEqual(interrupted.received, []);
  assert.deepEqual(interrupted.problems, []);
});

test("human fixture: the api-request-blob is ignored before and after the prompt", () => {
  const blob = humanEntry("apiRequestBlob");
  const parsed = parse(blob, realEntry("prompt"), blob);
  assert.equal(parsed.prompt.text, realEntry("prompt").message.content);
  assert.deepEqual(parsed.messages, []);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.received, []);
});

test("human meta text without the measured wrapper is delivered whole with a problem", () => {
  const entry = setContent(after(), "  Plain text\nwith whitespace.  ");
  const parsed = withPrompt(entry);
  assert.deepEqual(parsed.messages, [{ uuid: entry.uuid, text: entry.message.content, shape: "human" }]);
  assert.deepEqual(parsed.problems, [wrapperProblem(entry)]);
});

test("human non-meta user text is delivered unchanged without a wrapper problem", () => {
  const entry = setContent(after(), "  Plain turn.\n ");
  delete entry.isMeta;
  const parsed = withPrompt(entry);
  assert.deepEqual(parsed.messages, [{ uuid: entry.uuid, text: entry.message.content, shape: "human" }]);
  assert.deepEqual(parsed.problems, []);
});

test("human unwrapping removes one exact envelope and preserves inner whitespace", () => {
  const ctx = relayContext();
  const inner = ctx.humanAfterHandback("  nested\n\nmessage  ").message.content;
  const entry = ctx.humanAfterHandback(inner);
  const parsed = withPrompt(entry);
  assert.equal(parsed.messages[0].text, inner);
  assert.deepEqual(parsed.problems, []);
  for (const content of [entry.message.content + " ", " " + entry.message.content]) {
    const changed = setContent(after(), content);
    const result = withPrompt(changed);
    assert.equal(result.messages[0].text, content);
    assert.deepEqual(result.problems, [wrapperProblem(changed)]);
  }
});

for (const [shape, make] of [["queued_command", queued], ["user", after]]) {
  test(`human ${shape}: text blocks join with newlines and image blocks are reported`, () => {
    const source = make();
    const content = source.attachment?.prompt ?? source.message.content;
    const entry = setContent(source, [
      { type: "text", text: content }, { type: "image", source: { type: "base64", data: "image" } },
      { type: "image", source: { type: "base64", data: "image2" } }
    ]);
    const parsed = withPrompt(entry);
    assert.equal(parsed.messages[0].text, shape === "user" ? "typed two: after the hand-back" : content);
    assert.equal(parsed.messages[0].shape, "human");
    assert.deepEqual(parsed.problems, [blockProblem(entry, 2)]);
    if (shape === "user") delete entry.isMeta;
    setContent(entry, [{ type: "text", text: "first" }, { type: "image" }, { type: "text", text: "second" }]);
    const joined = withPrompt(entry);
    assert.equal(joined.messages[0].text, "first\nsecond");
    assert.deepEqual(joined.problems, [blockProblem(entry, 1)]);
  });

  test(`human ${shape}: an image without text is a problem and is not delivered`, () => {
    const entry = setContent(make(), [{ type: "image" }]);
    const parsed = withPrompt(entry);
    assert.deepEqual(parsed.messages, []);
    assert.deepEqual(parsed.problems, [blockProblem(entry, 1),
      `entry ${entry.uuid} is a ${shape === "user" ? "message" : "queued message"} whose text could not be read`]);
    assert.deepEqual(parsed.received, [entry.uuid]);
  });

  test(`human ${shape}: task-notification origins are skipped without a problem`, () => {
    const entry = setOrigin(make(), { kind: "task-notification" });
    const parsed = withPrompt(entry);
    assert.deepEqual(parsed.messages, []);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.received, [entry.uuid]);
  });

  test(`human ${shape}: unknown origin bridge is recorded and is not delivered`, () => {
    const entry = setOrigin(make(), { kind: "bridge" });
    const parsed = withPrompt(entry);
    assert.deepEqual(parsed.messages, []);
    assert.deepEqual(parsed.problems, [`entry ${entry.uuid} is a ${shape === "user" ? "user entry" : "queued command"} of origin bridge, which the relay does not deliver`]);
    assert.deepEqual(parsed.received, [entry.uuid]);
    if (shape === "user") {
      delete entry.message;
      assert.deepEqual(withPrompt(entry).problems, parsed.problems);
      assert.deepEqual(withPrompt(entry).messages, []);
    }
  });

  test(`human ${shape}: an origin without a string kind is recorded`, () => {
    for (const origin of [{}, { kind: 7 }]) {
      const entry = setOrigin(make(), origin);
      const parsed = withPrompt(entry);
      assert.deepEqual(parsed.messages, []);
      assert.deepEqual(parsed.problems, [`entry ${entry.uuid} has an origin with no kind`]);
      assert.deepEqual(parsed.received, [entry.uuid]);
      if (shape === "user") {
        delete entry.message;
        assert.deepEqual(withPrompt(entry).problems, parsed.problems);
        assert.deepEqual(withPrompt(entry).messages, []);
      }
    }
  });
}

test("human typed harness and interrupt markers and cancel are messages in both shapes", () => {
  const ctx = relayContext();
  const marker = workflowEntry("userRequest").message.content.split("\n")[0];
  for (const text of [marker, "[Request interrupted by user]", "cancel"]) {
    for (const entry of [ctx.humanQueued(text), ctx.humanAfterHandback(text)]) {
      const parsed = withPrompt(entry);
      assert.deepEqual(parsed.messages, [{ uuid: entry.uuid, text, shape: "human" }]);
      assert.deepEqual(parsed.problems, []);
    }
    const plain = setContent(after(), text);
    delete plain.isMeta;
    assert.equal(withPrompt(plain).messages[0].text, text);
  }
});

test("coordinator, peer and human messages before the prompt are problems in both shapes", () => {
  const entries = [realEntry("queuedDuringRun"), realEntry("messageAfterHandback"),
    peerEntry("peerQueuedDuringRun"), peerEntry("peerAfterHandback"), queued(), after()];
  const parsed = parse(...entries, realEntry("prompt"));
  assert.deepEqual(parsed.messages, []);
  assert.deepEqual(parsed.problems, entries.map((entry) => `entry ${entry.uuid} is a message that came before the prompt`));
  assert.deepEqual(parsed.received, entries.filter((entry) => entry.attachment).map((entry) => entry.uuid));
});

test("received lists every queued command and only inbound user entries after the prompt, in order", () => {
  const ctx = relayContext();
  const noOrigin = queued();
  delete noOrigin.attachment.origin;
  const early = setOrigin(ctx.humanQueued("before prompt"), { kind: "bridge" });
  const unreadable = ctx.userTurn([{ type: "image" }]);
  const peerNoBody = peerEntry("peerAfterHandback");
  delete peerNoBody.origin.body;
  const inbound = [ctx.humanQueued("typed"), ctx.queued("coordinator"), ctx.peerQueued("peer"),
    ctx.humanAfterHandback("typed again"), ctx.afterHandback("coordinator again"), ctx.peerAfterHandback("peer again"),
    setOrigin(ctx.humanQueued("notification"), { kind: "task-notification" }),
    setOrigin(ctx.humanAfterHandback("notification"), { kind: "task-notification" }),
    setOrigin(ctx.humanQueued("unknown"), { kind: "bridge" }), setOrigin(ctx.humanAfterHandback("unknown"), { kind: "bridge" }),
    setOrigin(ctx.humanQueued("no kind"), {}), setOrigin(ctx.humanAfterHandback("no kind"), {}),
    noOrigin, setContent(ctx.humanAfterHandback("image"), [{ type: "image" }]), peerNoBody,
    unreadable, ctx.userTurn("plain message")];
  const parsed = parse(ctx.afterHandback("too soon"), early, workflowEntry("userRequest"), ctx.prompt(QUICK),
    ctx.systemReminder(), realEntry("bashToolUse"), realEntry("bashToolResult"),
    humanEntry("apiRequestBlob"), ctx.userTurn("[Request interrupted by user]"),
    ...inbound, workflowEntry("userRequest"));
  assert.deepEqual(parsed.received, [early.uuid, ...inbound.map((entry) => entry.uuid)]);
  assert.ok(parsed.problems.includes(`entry ${noOrigin.uuid} is a queued command with no origin`));
});

test("recurring transcript problems deduplicate across intervening records", () => {
  const dir = makeTempDir("relay-human-violations-");
  for (let i = 0; i < 20; i++) {
    appendRelayViolation(dir, { kind: "transcript", reason: "first", agentId: "one" });
    appendRelayViolation(dir, { kind: "transcript", reason: "second", agentId: "two" });
  }
  assert.deepEqual(readRelayViolations(dir).map(({ kind, reason }) => ({ kind, reason })), [
    { kind: "transcript", reason: "first" }, { kind: "transcript", reason: "second" }
  ]);
});

test("a delivery violation repeated after another record is appended again", () => {
  const dir = makeTempDir("relay-human-delivery-");
  appendRelayViolation(dir, { kind: "delivery", reason: "retry" });
  appendRelayViolation(dir, { kind: "delivery", reason: "retry" });
  appendRelayViolation(dir, { kind: "transcript", reason: "other" });
  appendRelayViolation(dir, { kind: "delivery", reason: "retry" });
  assert.deepEqual(readRelayViolations(dir).map(({ kind, reason }) => ({ kind, reason })), [
    { kind: "delivery", reason: "retry" }, { kind: "transcript", reason: "other" }, { kind: "delivery", reason: "retry" }
  ]);
});

async function handedBack(ctx) {
  ctx.append(ctx.prompt(QUICK));
  const { jobId, started } = await relayStart(ctx);
  assert.ok(jobId, started.stdout + started.stderr);
  assert.equal(companion(ctx, ["wait", jobId, "--timeout-seconds", "15"]).status, 0);
  const handback = await pre(ctx, "SubagentHandback", { message: "relay's words" });
  assert.equal(decision(handback), "allow");
  return { jobId, dir: jobDirOf(ctx, jobId), handback };
}

function assertExactResultBlock(output, ctx, jobId) {
  assert.equal(output?.decision, "block");
  assert.equal(output.reason, "Your final message must be exactly the job's result, with nothing added or removed. Reply with exactly this text and nothing else, with no code fence around it:\n" + companion(ctx, ["result", jobId]).stdout);
}

test("a hand-back followed by its SubagentStop is exempt", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { dir } = await handedBack(ctx);
  const guard = readGuardState(ctx.env, ctx.agentId, dir);
  assert.deepEqual(guard.handback.receivedUuids, []);
  assert.equal(await stop(ctx, "Report delivered."), null);
});

test("a typed follow-up after hand-back continues the job and requires a second hand-back", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const release = path.join(makeTempDir("relay-human-release-"), "go");
  ctx.env.FAKE_CODEX_RELEASE_FILE = release;
  const { jobId, dir } = await handedBack(ctx);
  const entry = ctx.humanAfterHandback("[held] Follow-up from the view.");
  ctx.append(entry);
  const blocked = await stop(ctx, "I passed your message on");
  assert.equal(blocked?.decision, "block");
  assert.match(blocked.reason, /still running/);
  assert.equal(readLedger(dir, entry.uuid).kind, "continue");
  await waitFor(() => codexReceived(ctx).turns.includes("[held] Follow-up from the view."));
  fs.writeFileSync(release, "");
  assert.equal(companion(ctx, ["wait", jobId, "--timeout-seconds", "15"]).status, 0);
  // No relay tool has run since its first hand-back; even a finished continue ends the exemption.
  assertExactResultBlock(await stop(ctx, "I passed your message on"), ctx, jobId);
  const wait = await pre(ctx, "Bash", { command: `${RELAY_CMD} wait ${jobId}` });
  assert.equal(runBash(ctx, updated(wait)).status, 0);
  const second = await pre(ctx, "SubagentHandback", { message: "my summary" });
  assert.equal(decision(second), "allow");
  assert.equal(updated(second).message, companion(ctx, ["result", jobId]).stdout);
  assert.deepEqual(readGuardState(ctx.env, ctx.agentId, dir).handback.receivedUuids, [entry.uuid]);
  assert.equal(await stop(ctx, "Report delivered again."), null);
});

test("typed cancel after hand-back leaves nothing owed but blocks the relay's own final text", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await handedBack(ctx);
  const entry = ctx.humanAfterHandback("cancel");
  ctx.append(entry);
  assertExactResultBlock(await stop(ctx, "I passed your message on"), ctx, jobId);
  const sync = await syncRelayMessages(ctx.base, dir, { env: ctx.env });
  assert.deepEqual(sync.received, [entry.uuid]);
  assert.deepEqual(sync.undelivered, []);
  assert.equal(readLedger(dir, entry.uuid).kind, "cancel");
  assert.equal(readLedger(dir, entry.uuid).status, "done");
});

test("an unknown-origin entry after hand-back ends the SubagentStop exemption", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await handedBack(ctx);
  const entry = setOrigin(ctx.humanAfterHandback("unknown"), { kind: "bridge" });
  ctx.append(entry);
  assertExactResultBlock(await stop(ctx, "I passed your message on"), ctx, jobId);
  assert.equal(readLedger(dir, entry.uuid), null);
  assert.equal(readRelayViolations(dir).length, 1);
  const next = await pre(ctx, "SubagentHandback", { message: "own words" });
  assert.equal(decision(next), "allow");
  assert.deepEqual(readGuardState(ctx.env, ctx.agentId, dir).handback.receivedUuids, [entry.uuid]);
  assert.equal(await stop(ctx, "Report delivered."), null);
});

test("an unreadable transcript at SubagentStop ends the hand-back exemption", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { jobId, dir } = await handedBack(ctx);
  fs.unlinkSync(ctx.transcript);
  fs.mkdirSync(ctx.transcript);
  assertExactResultBlock(await stop(ctx, "I passed your message on"), ctx, jobId);
  const sync = await syncRelayMessages(ctx.base, dir, { env: ctx.env });
  assert.equal(sync.readable, false);
  assert.deepEqual(sync.received, []);
  assert.equal(readRelayViolations(dir).length, 1);
});

test("a guard state without receivedUuids still exempts a stop with no new message", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  const { dir } = await handedBack(ctx);
  const entry = ctx.afterHandback("cancel");
  ctx.append(entry);
  assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "x" })), "allow");
  const handback = readGuardState(ctx.env, ctx.agentId, dir).handback;
  delete handback.receivedUuids;
  writeGuardState(ctx.env, ctx.agentId, dir, { handback });
  assert.deepEqual(handback.messageUuids, [entry.uuid]);
  assert.equal(await stop(ctx, "Report delivered."), null);
});

test("without SubagentHandback, only one whole-message fence may surround the exact result", async (t) => {
  const ctx = relayContext("job", { turnMs: 100 });
  ctx.append(ctx.prompt(QUICK));
  const { jobId, started } = await relayStart(ctx);
  assert.ok(jobId, started.stdout + started.stderr);
  assert.equal(companion(ctx, ["wait", jobId, "--timeout-seconds", "15"]).status, 0);
  const dir = jobDirOf(ctx, jobId);
  const result = () => companion(ctx, ["result", jobId]).stdout;
  const fence = (text, opening = "```", closing = "```") => `${opening}\n${text.trimEnd()}\n${closing}`;
  await t.test("a real result in three backticks passes and records the hand-back", async () => {
    assert.equal(JSON.parse(companion(ctx, ["status", jobId, "--json"]).stdout).handedBackAt, null);
    assert.equal(await stop(ctx, fence(result())), null);
    assert.ok(JSON.parse(companion(ctx, ["status", jobId, "--json"]).stdout).handedBackAt);
  });
  await t.test("a text info string and whitespace outside the fence pass", async () => {
    assert.equal(await stop(ctx, `\n \t\n${fence(result(), "```text")}\n \t`), null);
  });
  await t.test("four backticks around a result containing a three-backtick block pass", async () => {
    fs.writeFileSync(path.join(dir, "report.md"), "A report with code:\n```\nexact code\n```\n");
    assert.match(result(), /```\nexact code\n```/);
    assert.equal(await stop(ctx, fence(result(), "````", "````")), null);
  });
  const cases = [
    ["an unclosed fence fails", (text) => `\`\`\`\n${text}`],
    ["a fence with a changed line fails", (text) => fence(text.replace("state: completed", "state: cancelled"))],
    ["a fence with an added line fails", (text) => fence(`${text}\nAdded line.`)],
    ["a fence with a missing line fails", (text) => fence(text.replace(/^state:.*\n/, ""))],
    ["a fence around only part of the result fails", (text) => text.replace(/^state: completed\n/, "```\nstate: completed\n```\n")],
    ["different opening and closing runs fail", (text) => fence(text, "````", "```")],
    ["two enclosing fences fail", (text) => fence(fence(text), "````", "````")]
  ];
  for (const [name, wrap] of cases) {
    await t.test(name, async () => {
      assertExactResultBlock(await stop(ctx, wrap(result())), ctx, jobId);
      assert.equal(await stop(ctx, result()), null);
    });
  }
  assert.deepEqual(readRelayViolations(dir), []);
});

test("a start error beginning with a fence keeps its own fence", async () => {
  const ctx = relayContext();
  const error = "```text\nThe start failed.\n```\n";
  writeRelayPointer(ctx.env, { agentId: ctx.agentId, startError: error });
  const blocked = await stop(ctx, `\`\`\`\`\n${error}\`\`\`\``);
  assert.equal(blocked?.decision, "block");
  assert.match(blocked.reason, /with no code fence around it:/);
  assert.equal((await stop(ctx, "The start failed."))?.decision, "block");
  assert.equal(await stop(ctx, error), null);
});
