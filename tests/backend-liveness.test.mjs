import test from "node:test";
import assert from "node:assert/strict";
import { SpawnedServerClient, TransportTimeout } from "../plugins/relay/scripts/lib/backends/transport/stdio-rpc.mjs";
import { backendLiveness, STALLED_AFTER_MS, PING_INTERVAL_MS } from "../plugins/relay/scripts/lib/worker/liveness.mjs";
import { scriptedConnection } from "./support/backend-connection.mjs";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function silentClient(backend = "codex") {
  const client = new SpawnedServerClient("/tmp", { backendName: backend });
  client.proc = { stdin: { write() {} } };
  return client;
}

for (const [method, ms] of [["initialize", 120000], ["runtime/capabilities", 120000], ["session/new", 300000], ["turn/steer", 30000]]) {
  test(`${method} deadline rejects, forgets the pending call and marks the transport wedged`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = silentClient();
    let failure;
    const request = client.request(method, {}, { timeoutMs: ms }).catch(error => { failure = error; });
    t.mock.timers.tick(ms - 1); await flush(); assert.equal(failure, undefined);
    t.mock.timers.tick(1); await request;
    assert.ok(failure instanceof TransportTimeout);
    assert.equal(failure.message, `codex stopped answering (${method}, ${ms / 1000} s)`);
    assert.equal(client.pending.size, 0); assert.equal(client.wedged, failure);
    assert.equal(await client.wedgedPromise, failure);
  });
}

test("turn requests have no deadline and replies/exits clear request timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = silentClient();
  let done = false;
  const turn = client.request("turn/start", {}).then(() => { done = true; });
  const control = client.request("turn/steer", {}, { timeoutMs: 30000 });
  client.handleLine(JSON.stringify({ id: 2, result: { turnId: "t" } }));
  await control;
  t.mock.timers.tick(25 * 60000); await flush();
  assert.equal(done, false); assert.equal(client.wedged, null);
  client.handleLine(JSON.stringify({ id: 1, result: {} })); await turn;
  const pending = client.request("session/load", {}, { timeoutMs: 300000 });
  client.handleExit(new Error("ended")); await assert.rejects(pending, /ended/);
  t.mock.timers.tick(300000); assert.equal(client.wedged, null);
});

for (const backend of ["codex", "grok", "kimi", "zcode"]) test(`${backend} uses its read-only liveness method`, async () => {
  const calls = [];
  const client = { request: async (...args) => {
    calls.push(args);
    if (["grok", "kimi"].includes(backend)) throw Object.assign(new Error("Method not found"), { rpcCode: -32601 });
    return {};
  } };
  const connection = await scriptedConnection(backend, client, { cwd: "/tmp" });
  await connection.ping();
  const [method, params, options] = calls[0];
  assert.equal(method, backend === "codex" ? "account/read" : backend === "zcode" ? "runtime/capabilities" : "relay/ping");
  assert.deepEqual(params, backend === "codex" ? { refreshToken: false } : {});
  assert.deepEqual(options, { timeoutMs: 30000, wedgeOnTimeout: false });
});

function watchdog() {
  let now = 0, pings = 0, answering = true;
  const notes = [], server = silentClient();
  const connection = { server, request: { backend: "codex" }, pingMethod: "account/read", async ping() {
    pings++;
    if (!answering) throw new TransportTimeout("codex", "account/read", 30000);
  } };
  const watch = backendLiveness(connection, { now: () => now, note: value => notes.push(value) });
  return { watch, server, notes, pings: () => pings, advance: ms => now += ms, silent: () => answering = false, answer: () => answering = true };
}

test("a fake backend sleeping silently for 25 minutes while answering pings is never killed", async () => {
  const s = watchdog(); await s.watch.open();
  for (let minute = 1; minute <= 25; minute++) { s.advance(60000); await s.watch.tick(true); }
  assert.equal(s.server.wedged, null);
  assert.equal(s.pings(), 5, "open, then minutes 10, 15, 20 and 25");
  assert.equal(s.notes.at(-1).state, "backend answering");
});

test("two unanswered silent-turn pings wedge the backend; a reply resets the count", async () => {
  const s = watchdog(); await s.watch.open(); s.silent();
  s.advance(STALLED_AFTER_MS); await s.watch.tick(true); assert.equal(s.server.wedged, null);
  s.answer(); s.advance(PING_INTERVAL_MS); await s.watch.tick(true);
  s.silent(); s.advance(PING_INTERVAL_MS); await s.watch.tick(true); assert.equal(s.server.wedged, null);
  s.advance(PING_INTERVAL_MS); await s.watch.tick(true); assert.ok(s.server.wedged instanceof TransportTimeout);
});

test("an unanswered open-time ping disables only the watchdog", async () => {
  const s = watchdog(); s.silent(); await s.watch.open();
  s.advance(25 * 60000); await s.watch.tick(true);
  assert.equal(s.pings(), 1); assert.equal(s.server.wedged, null);
  assert.equal(s.notes[0].enabled, false); assert.match(s.notes[0].reason, /control deadlines remain/);
});

test("notifications, inactive turns and concurrent heartbeats never open extra pings", async () => {
  const s = watchdog(); await s.watch.open(); s.advance(STALLED_AFTER_MS); s.watch.touch();
  await s.watch.tick(true); assert.equal(s.pings(), 1);
  s.advance(STALLED_AFTER_MS); await s.watch.tick(false); assert.equal(s.pings(), 1);
  await Promise.all([s.watch.tick(true), s.watch.tick(true)]); assert.equal(s.pings(), 2);
  s.watch.stop(); s.advance(STALLED_AFTER_MS); await s.watch.tick(true); assert.equal(s.pings(), 2);
});
