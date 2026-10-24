import "./support/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SpawnedServerClient } from "../plugins/relay/scripts/lib/backends/transport/stdio-rpc.mjs";
import { KimiWire } from "../plugins/relay/scripts/lib/backends/kimi/wire.mjs";
import { makeTempDir, writeExecutable } from "./support/helpers.mjs";

test("a backend's 70 MiB line closes the connection with a protocol error", async t => {
  const dir = makeTempDir("relay-line-bound-"); const binary = path.join(dir, "backend");
  writeExecutable(binary, `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{ const m=JSON.parse(line); if(!m.id)return;
if(m.method==='initialize') process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
else {const chunk='x'.repeat(1024*1024); let n=70; function write(){while(n-->0){if(!process.stdout.write(chunk)){process.stdout.once('drain',write);return;}}process.stdout.write('\\n');} write();}
});`);
  const client = new SpawnedServerClient(dir, { binary, args: [], backendName: "synthetic", closeGraceMs: 100 });
  t.after(() => client.close());
  await client.initialize();
  await assert.rejects(client.request("oversize", {}), /synthetic sent a single message over 64 MiB; the connection was closed/);
  await client.close();
  assert.equal(client.exitSeen, true);
  assert.equal(client.lineBytes, 0);
  assert.equal(client.lineChunks.length, 0);
});

test("bounded close escalates TERM to KILL even after ChildProcess.killed is true", async t => {
  const dir = makeTempDir("relay-close-bound-"); const binary = path.join(dir, "backend");
  writeExecutable(binary, `#!/usr/bin/env node
process.on('SIGTERM',()=>{}); process.stdin.on('end',()=>{});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}); setInterval(()=>{},1000);`);
  const client = new SpawnedServerClient(dir, { binary, args: [] });
  t.after(() => client.close()); await client.initialize();
  const started = Date.now();
  await Promise.all([client.close(), client.close()]);
  assert.ok(Date.now() - started >= 4900);
  assert.ok(Date.now() - started < 8000);
  assert.equal(client.exitInfo.signal, "SIGKILL");
});

test("Kimi replays 50,000 records over 200 MiB with reads at most 4 MiB and retains delivery evidence", () => {
  const dir = makeTempDir("relay-wire-bound-"); const file = path.join(dir, "wire.jsonl");
  const fd = fs.openSync(file, "w");
  const padding = "x".repeat(4200);
  try { for (let n = 0; n < 25000; n++) {
    fs.writeSync(fd, JSON.stringify({ type: "turn.prompt", turnId: n, origin: { kind: "user" }, promptId: `p${n}`, input: [{ type: "text", text: `text-${n}` }], padding }) + "\n");
    fs.writeSync(fd, JSON.stringify({ type: "turn.ended", turnId: n, padding }) + "\n");
  } } finally { fs.closeSync(fd); }
  let largest = 0, reads = 0;
  const wire = new KimiWire(() => file, { retainPrompt: p => p.promptId === "p0", io: { ...fs,
    readSync(fd, buffer, ...args) { largest = Math.max(largest, buffer.length); reads++; return fs.readSync(fd, buffer, ...args); }
  } }).read();
  assert.ok(fs.statSync(file).size > 200 * 1024 * 1024);
  assert.ok(largest <= 4 * 1024 * 1024); assert.ok(reads > 50);
  assert.equal(wire.consumed, fs.statSync(file).size);
  assert.ok(wire.turns.size <= 51); assert.ok(wire.prompts.size <= 51);
  assert.equal(wire.promptSince(0, "text-0").promptId, "p0");
  assert.equal(wire.promptSince(0, "text-24999").promptId, "p24999");
  assert.ok(wire.userMessages instanceof Set);
});

test("close records a bounded timeout without inventing an exit time", async () => {
  const { readProcessStartTime } = await import("../plugins/relay/scripts/lib/util/process.mjs");
  let ended;
  const signals = [];
  const client = new SpawnedServerClient(".", { closeGraceMs: 1, closeKillWaitMs: 1, onEnd: info => { ended = info; } });
  client.processIdentity = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  client.processEndPromise = new Promise(() => {});
  client.proc = { pid: process.pid, stdin: { end() {} }, stdout: { destroy() {} }, stderr: { destroy() {} }, kill(signal) { signals.push(signal); } };
  await client.close();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(ended.closeTimedOut, true);
  assert.ok(ended.closeTimedOutAt);
  assert.equal(ended.deathObservedAt, undefined);
  assert.equal(ended.endedAt, undefined);
  await client.close();
});

test("a continuation arriving during bounded backend close runs in the next round", async t => {
  const { setup, startJob, readJob, jobDir, companion, waitFor } = await import("./support/job-helpers.mjs");
  const { postInboxMessage, readOutcome } = await import("../plugins/relay/scripts/lib/jobs/messages.mjs");
  const { isProcessIdentityAlive } = await import("../plugins/relay/scripts/lib/util/process.mjs");
  const ctx = setup(t, { env: { FAKE_CODEX_IGNORE_CLOSE: "1", RELAY_WORKER_SCOPE: "off" } });
  const { id } = startJob(ctx, undefined, "[quick] First turn.");
  const dir = jobDir(ctx, id);
  const closing = await waitFor(() => { const j = readJob(ctx, id); return j.state === "completed" && j; });
  assert.equal(isProcessIdentityAlive(closing.server), true, "the completed turn's backend is still closing");
  const message = postInboxMessage(dir, { kind: "continue", text: "[quick] Continue after close." });
  await waitFor(() => readOutcome(dir, message.id)?.action === "turn-started", 12000);
  await waitFor(() => readJob(ctx, id).attempts.length === 2 && readJob(ctx, id).state === "completed", 12000);
  assert.equal(readJob(ctx, id).worker.pid, closing.worker.pid);
  assert.equal(ctx.fakeState().turnStarts.length, 2);
  assert.equal(isProcessIdentityAlive(closing.server), false);
  assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "15"]).status, 0);
});
