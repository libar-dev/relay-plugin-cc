// The Kimi connection on a scripted ACP client, with a wire.jsonl the test writes: exact
// interleavings of Kimi's record with relay's reads, which a fake server cannot time.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./support/helpers.mjs";

process.env.RELAY_JOBS_KIMI_POLL_MS = "10";
process.env.RELAY_JOBS_KIMI_SETTLE_MS = "300";
const { KimiConnection } = await import("../plugins/relay/scripts/lib/backends/kimi/connection.mjs");

const line = value => `${JSON.stringify(value)}\n`;
const ownStart = turnId => line({ type: "agent.turn.started", kind: "event", turnId })
  + line({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "<notification>done</notification>" }], origin: { kind: "task" }, turnId });
const turnEnded = (turnId, reason = "completed") => line({ type: "turn.ended", agentId: "main", turnId, reason });
const userTurn = (text, promptId, turnId, answer) =>
  line({ type: "agent.message.appended", kind: "event", message: { message: { role: "user", content: [{ type: "text", text }] }, meta: { source: "input", promptId, origin: { kind: "user" } } } })
  + line({ type: "agent.turn.started", kind: "event", turnId, queueItemId: promptId })
  + line({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text }], origin: { kind: "user" }, promptId, turnId })
  + line({ type: "agent.message.appended", kind: "event", message: { message: { role: "assistant", content: [{ type: "text", text: answer }], toolCalls: [] } } })
  + turnEnded(turnId);

// A session record in a scratch home, and a connection on a client whose prompt answers the
// test scripts. Nothing is spawned.
async function scripted(t, onPrompt) {
  const home = makeTempDir("relay-kimi-scripted-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "wd_work_0", "session_s1", "agents", "main");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wire.jsonl");
  fs.writeFileSync(file, line({ type: "metadata", protocol_version: "1.5" }));
  const client = {
    exitPromise: new Promise(() => {}), exitSeen: false, exitResolved: false, exitInfo: null,
    setNotificationHandler() {}, notify() {}, async close() {},
    async request(method, params) { return method === "session/prompt" ? onPrompt(params) : {}; }
  };
  const named = [];
  const connection = new KimiConnection(client, { kimiHome: home, cwd: home, mode: "yolo", model: null, effort: null }, { state: {}, saveState() {}, tap() {} });
  await connection.open({ sessionId: "session_s1" });
  // A run still waiting when its test ends stops with the connection.
  t.after(() => connection.close());
  const run = prompt => connection.run({ prompt, clientId: "m1", source: "brief", onPending() {}, onTurnId(id) { named.push(id); } });
  return { file, append: data => fs.appendFileSync(file, data), run, named };
}

// Runs `inject` just before the k-th call that names the record's path.
function beforeWireCall(file, k, inject) {
  const originals = { openSync: fs.openSync, statSync: fs.statSync, existsSync: fs.existsSync };
  let count = 0;
  for (const [name, original] of Object.entries(originals)) {
    fs[name] = (target, ...rest) => {
      if (target === file && (count += 1) === k) inject();
      return original(target, ...rest);
    };
  }
  return () => Object.assign(fs, originals);
}

test("a turn of Kimi's own that starts between any two reads of the record is seen: the queued prompt waits behind it and owns the report", async t => {
  for (let k = 1; k <= 4; k += 1) {
    let injected = false;
    /** @type {any} */
    let ctx;
    const inject = () => { if (!injected) { injected = true; ctx.append(ownStart(5)); } };
    ctx = await scripted(t, async () => {
      // At the latest, Kimi's own turn runs when the prompt arrives: the engine queues the
      // prompt, ACP answers at once, and only the record shows the rest. Kimi's own turn
      // outlasts the 300 ms grace; the hand-off is one write, so only an unseen turn of
      // Kimi's own can end the run early.
      inject();
      setTimeout(() => ctx.append(turnEnded(5) + userTurn("Queued.", "p6", 6, "Done.")), 600);
      return { stopReason: "end_turn" };
    });
    const restore = beforeWireCall(ctx.file, k, inject);
    const started = Date.now();
    let result;
    try { result = await ctx.run("Queued."); } finally { restore(); }
    assert.equal(result.turnStatus, "completed", `before call ${k}: ${JSON.stringify(result.error)}`);
    assert.equal(result.finalMessage, "Done.", `before call ${k}`);
    assert.deepEqual(ctx.named, ["p6"], `before call ${k}`);
    assert.ok(Date.now() - started >= 550, `before call ${k}: the run ended before Kimi's own turn did`);
  }
});

test("a record still being written when relay reads, and a UTF-8 character split across writes, are read whole later", async t => {
  const own = Buffer.from(ownStart(5));
  const answer = Buffer.from(userTurn("Queued.", "p6", 6, "naïve 界 done"));
  const cut = answer.indexOf(Buffer.from("界")) + 1;
  /** @type {any} */
  let ctx;
  ctx = await scripted(t, async () => {
    setTimeout(() => ctx.append(own.subarray(20)), 50);
    setTimeout(() => ctx.append(Buffer.concat([Buffer.from(turnEnded(5)), answer.subarray(0, cut)])), 600);
    setTimeout(() => ctx.append(answer.subarray(cut)), 700);
    return { stopReason: "end_turn" };
  });
  // Kimi is writing its own turn's first record when the prompt goes.
  ctx.append(own.subarray(0, 20));
  const started = Date.now();
  const result = await ctx.run("Queued.");
  assert.equal(result.turnStatus, "completed", JSON.stringify(result.error));
  assert.equal(result.finalMessage, "naïve 界 done");
  assert.ok(Date.now() - started >= 650, "the run ended before the turn's last record");
});

test("after a prompt turn that ran a notification as a second engine turn, a prompt the record never shows still fails after the grace", async t => {
  /** @type {any} */
  let ctx;
  ctx = await scripted(t, async () => ({ stopReason: "end_turn" }));
  ctx.append(line({ type: "agent.turn.started", turnId: 0, queueItemId: "p0" })
    + line({ type: "turn.prompt", input: [{ type: "text", text: "Brief." }], origin: { kind: "user" }, promptId: "p0", turnId: 0 })
    + line({ type: "agent.turn.ended", turnId: 0, outcome: "done" })
    + line({ type: "agent.turn.started", turnId: 1 })
    + line({ type: "agent.turn.ended", turnId: 1, outcome: "done" })
    + turnEnded(0));
  const result = await Promise.race([ctx.run("Never recorded."), new Promise(resolve => setTimeout(() => resolve({ turnStatus: "still waiting" }), 3000))]);
  assert.equal(result.turnStatus, "failed");
  assert.equal(result.teardown, true);
});

test("a turn's last messages that Kimi records after its turn.ended, up to the engine turn's end, are its report", async t => {
  /** @type {any} */
  let ctx;
  const assistant = (text, toolCalls = []) => line({ type: "agent.message.appended", kind: "event", message: { message: { role: "assistant", content: [{ type: "text", text }], toolCalls } } });
  const tool = line({ type: "agent.message.appended", kind: "event", message: { message: { role: "tool", content: [{ type: "text", text: "ok" }] } } });
  ctx = await scripted(t, async () => {
    // As in a live record: the engine's batch of messages, the final answer included, drains
    // after the prompt turn's turn.ended and prompt.completed, then the engine turn ends.
    ctx.append(line({ type: "agent.message.appended", kind: "event", message: { message: { role: "user", content: [{ type: "text", text: "Review." }] }, meta: { source: "input", promptId: "p0", origin: { kind: "user" } } } })
      + line({ type: "agent.turn.started", kind: "event", turnId: 0, queueItemId: "p0" })
      + line({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "Review." }], origin: { kind: "user" }, promptId: "p0", turnId: 0 })
      + assistant("Reading.", [{ id: "c1" }]) + tool
      + turnEnded(0)
      + line({ type: "prompt.completed", promptId: "p0", reason: "completed" }));
    setTimeout(() => ctx.append(assistant("Checking more.", [{ id: "c2" }]) + tool + assistant("The review.")), 100);
    setTimeout(() => ctx.append(line({ type: "agent.turn.ended", kind: "event", turnId: 0, outcome: "done" })), 150);
    return { stopReason: "end_turn" };
  });
  const result = await ctx.run("Review.");
  assert.equal(result.turnStatus, "completed", JSON.stringify(result.error));
  assert.equal(result.finalMessage, "The review.");
});

test("a notice's answer that Kimi records after its prompt turn's turn.ended, in a second engine turn, is the report", async t => {
  /** @type {any} */
  let ctx;
  const assistant = (text, toolCalls = []) => line({ type: "agent.message.appended", kind: "event", message: { message: { role: "assistant", content: [{ type: "text", text }], toolCalls } } });
  ctx = await scripted(t, async () => {
    ctx.append(line({ type: "agent.message.appended", kind: "event", message: { message: { role: "user", content: [{ type: "text", text: "Start it." }] }, meta: { source: "input", promptId: "p0", origin: { kind: "user" } } } })
      + line({ type: "agent.turn.started", kind: "event", turnId: 0, queueItemId: "p0" })
      + line({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "Start it." }], origin: { kind: "user" }, promptId: "p0", turnId: 0 })
      + assistant("Started.")
      + line({ type: "agent.turn.ended", kind: "event", turnId: 0, outcome: "done" })
      // The task's notice runs as engine turn 1 inside prompt turn 0, whose turn.ended comes first.
      + line({ type: "agent.turn.started", kind: "event", turnId: 1 })
      + turnEnded(0));
    setTimeout(() => ctx.append(assistant("The task finished.")), 100);
    setTimeout(() => ctx.append(line({ type: "agent.turn.ended", kind: "event", turnId: 1, outcome: "done" })), 150);
    return { stopReason: "end_turn" };
  });
  const result = await ctx.run("Start it.");
  assert.equal(result.turnStatus, "completed", JSON.stringify(result.error));
  assert.equal(result.finalMessage, "Started.The task finished.");
});
