import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { SpawnedServerClient } from "../plugins/relay/scripts/lib/backends/transport/stdio-rpc.mjs";
import { scriptedConnection } from "./support/backend-connection.mjs";
import { makeTempDir } from "./support/helpers.mjs";

function scriptedClient() {
  const client = new SpawnedServerClient("/tmp");
  let prompt;
  client.request = async (method, params) => {
    if (method === "turn/start") return { turn: { id: "t1", status: "inProgress" } };
    if (method === "session/prompt") return new Promise(resolve => { prompt = resolve; });
    return {};
  };
  return { client, finish: value => prompt(value), emit: (method, params) => client.handleLine(JSON.stringify({ method, params })) };
}
const input = { prompt: "Task", clientId: "m1", source: "brief", onPending() {}, onTurnId() {} };

test("Codex model evidence and inner retry signals are scoped to active and subagent turns", async () => {
  const { client, emit } = scriptedClient();
  const connection = await scriptedConnection("codex", client, {}); connection.sessionId = "s1";
  let responses = 0; const limits = [];
  const running = connection.run({ ...input, onProviderResponse: () => responses++, onProviderLimit: e => limits.push(e) });
  await tick();
  emit("item/started", { threadId: "s1", turnId: "t1", item: { type: "userMessage", id: "u" } });
  emit("item/agentMessage/delta", { threadId: "other", turnId: "t1", delta: "Unrelated" });
  assert.equal(responses, 0);
  emit("item/reasoning/textDelta", { threadId: "s1", turnId: "t1", delta: "Thought" });
  assert.equal(responses, 1);
  emit("thread/started", { thread: { id: "subagent" } });
  emit("turn/started", { threadId: "subagent", turn: { id: "child-turn" } });
  const error = { message: "Usage exhausted", codexErrorInfo: { usageLimitExceeded: {} } };
  emit("error", { threadId: "subagent", turnId: "child-turn", willRetry: true, error });
  assert.deepEqual(limits, [error], "refusal reaches the worker before completion");
  emit("item/started", { threadId: "s1", turnId: "t1", item: { type: "commandExecution", id: "tool" } });
  assert.equal(responses, 2);
  emit("turn/completed", { threadId: "s1", turn: { id: "t1", status: "completed", items: [] } });
  await running;
});

test("Grok ACP model updates and retry_state reach hooks before prompt completion", async t => {
  const home = makeTempDir("relay-provider-evidence-"); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { client, emit, finish } = scriptedClient();
  const connection = await scriptedConnection("grok", client, { cwd: home, grokHome: home }); connection.sessionId = "s1";
  let responses = 0; const limits = [];
  const running = connection.run({ ...input, onProviderResponse: () => responses++, onProviderLimit: e => limits.push(e) });
  await tick();
  emit("session/update", { sessionId: "s1", update: { sessionUpdate: "user_message_chunk", content: { text: "User" } } });
  emit("session/update", { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { text: "Other" } } });
  assert.equal(responses, 0);
  emit("_x.ai/session/update", { sessionId: "s1", update: { sessionUpdate: "retry_state", type: "retrying", reason: "HTTP 429 Too Many Requests" } });
  assert.equal(limits[0].message, "HTTP 429 Too Many Requests");
  for (const kind of ["agent_message_chunk", "agent_thought_chunk", "tool_call"]) emit("session/update", { sessionId: "s1", update: { sessionUpdate: kind, content: { text: "Answer" } } });
  assert.equal(responses, 3);
  finish({ stopReason: "end_turn", _meta: { promptId: "p1" } }); await running;
});

test("Kimi observes only new wire retry records and ACP provider output during the turn", async t => {
  const home = makeTempDir("relay-provider-evidence-"); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "work", "s1", "agents", "main"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wire.jsonl");
  const retry = { type: "turn.step.retrying", turnId: 1, errorName: "APIStatusError", errorMessage: "403 You have reached your weekly usage limit" };
  fs.writeFileSync(file, JSON.stringify(retry) + "\n");
  const { client, emit } = scriptedClient();
  const connection = await scriptedConnection("kimi", client, { cwd: home, kimiHome: home, mode: "yolo" });
  await connection.open({ sessionId: "s1" });
  let responses = 0; const limits = [];
  const running = connection.run({ ...input, onProviderResponse: () => responses++, onProviderLimit: e => limits.push(e) });
  await tick(); assert.equal(limits.length, 0, "old retries cannot pause a new turn");
  fs.appendFileSync(file, JSON.stringify(retry) + "\n");
  connection.wire.read(); assert.equal(limits[0].message, retry.errorMessage);
  emit("session/update", { sessionId: "s1", update: { sessionUpdate: "user_message_chunk" } });
  assert.equal(responses, 0);
  emit("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { text: "Answer" } } });
  assert.equal(responses, 1);
  await connection.close(); await running;
  assert.equal(connection.wire.onRecord, null);
});
