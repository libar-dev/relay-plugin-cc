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
