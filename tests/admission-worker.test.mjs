import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { setup, waitFor } from "./support/job-helpers.mjs";
import { createJobDir, jobPaths, readJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { loadJobView } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";
import { backendNamed } from "../plugins/relay/scripts/lib/backends/index.mjs";
import { DEFAULTS as D } from "../plugins/relay/scripts/lib/worker/admission.mjs";
const GiB = 2 ** 30;
function seed(t, brief = "[quick] First turn.") {
  const ctx = setup(t);
  ctx.env.RELAY_ADMISSION = "on";
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "admission");
  const { jobDir: dir } = createJobDir(ctx.work, "job-admission-worker", ctx.env);
  fs.writeFileSync(jobPaths(dir).brief, brief);
  writeJob(dir, { id: "job-admission-worker", kind: "task", state: "starting", createdAt: new Date().toISOString(), pendingFirstTurn: true, attempts: [],
    request: buildLaunchRequest({ model: "synthetic-model", effort: D.lightEfforts[0], cd: ctx.work }, { baseDir: ctx.work, env: ctx.env }) });
  let now = Date.now(), blocked = true;
  const options = { env: ctx.env, admission: { now: () => now, scanUnslotted: () => [], readMachine: () => ({ totalBytes: 128 * GiB, availableBytes: blocked ? 0 : 100 * GiB, cores: 64, load5: 0, notes: [] }) },
    admissionSleep: async () => { now += D.spacingMs; await new Promise(r => setTimeout(r, 10)); } };
  return { ctx, dir, options, unblock: () => blocked = false, block: () => blocked = true, tick: ms => now += ms };
}

test("queued worker stays live, acknowledges next turns and resets attempt state on admission", async t => {
  const s = seed(t), running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued");
  assert.equal(loadJobView(s.dir).state, "queued");
  assert.equal(loadJobView(s.dir).stalled, false);
  const steer = postInboxMessage(s.dir, { kind: "steer", text: "[quick] Next turn." });
  await waitFor(() => readOutcome(s.dir, steer.id)?.action === "queued-next-turn");
  assert.equal(loadJobView(s.dir).state, "queued", "owed messages must not replace queued with running");
  s.unblock(); await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "completed");
  assert.equal(job.attempts.length, 2);
  assert.ok(job.attempts.every(a => a.state === "completed"));
  assert.equal(job.admission.state, "admitted");
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", `${job.id}.json`)), false);
});

test("cancel while queued launches no backend and releases its slot", async t => {
  const s = seed(t), running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued");
  postInboxMessage(s.dir, { kind: "cancel" });
  await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "cancelled");
  assert.equal(job.admission.state, "cancelled");
  assert.match(job.admission.reason, /memory/); assert.ok(job.admission.since);
  assert.equal(job.attempts.at(-1).state, "cancelled");
  assert.equal(fs.existsSync(path.join(s.ctx.bin, "fake-codex-state.json")), false);
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", `${job.id}.json`)), false);
});

test("the backend remains counted until close finishes", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let observed = false;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), close = connection.close.bind(connection);
    t.mock.method(connection, "close", async () => {
      assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", "job-admission-worker.json")), true);
      observed = true; await close();
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(observed, true);
});

test("critical pressure before a warm turn queues without double charging the slot", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let turns = 0;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args), run = connection.run.bind(connection);
    t.mock.method(connection, "run", async (...turn) => {
      const result = await run(...turn); turns++;
      if (turns === 1) { postInboxMessage(s.dir, { kind: "continue", text: "[quick] Second." }); s.block(); }
      return result;
    });
    return connection;
  });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued" && readJob(s.dir).attempts.length === 2);
  const slot = JSON.parse(fs.readFileSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "slots", "job-admission-worker.json")));
  assert.equal(slot.state, "running");
  assert.equal(turns, 1);
  s.unblock(); await running;
  assert.equal(turns, 2);
});

test("structured turn/start refusal is preserved, pauses the backend and never retries usage", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let runs = 0, retries = 0;
  s.options.sleep = async () => retries++;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    const request = connection.client.request.bind(connection.client);
    t.mock.method(connection.client, "request", async (method, params, ...rest) => {
      if (method !== "turn/start") return request(method, params, ...rest);
      runs++;
      const error = new Error("synthetic usage limit at turn/start");
      error.data = { code: -32000, message: error.message, data: { codexErrorInfo: "usageLimitExceeded" } };
      throw error;
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(runs, 1);
  assert.equal(retries, 0);
  const job = readJob(s.dir);
  assert.equal(job.state, "failed");
  assert.equal(job.refusal.kind, "usage");
  assert.equal(job.refusal.code, "usageLimitExceeded");
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, "pauses", "codex.json")), true);
});

test("capacity retries check critical pressure before sending another turn", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let runs = 0;
  s.options.sleep = async () => s.block();
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args);
    t.mock.method(connection, "run", async () => { runs++; return { turnStatus: "failed", error: { message: "synthetic capacity" }, finalMessage: "", capacity: true }; });
    return connection;
  });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued" && runs === 1);
  postInboxMessage(s.dir, { kind: "cancel" }); await running;
  assert.equal(runs, 1);
  assert.equal(readJob(s.dir).state, "cancelled");
});

test("inherited guard off survives a partial worker environment and creates no admission files", async t => {
  const s = seed(t);
  delete s.options.env.RELAY_ADMISSION;
  assert.equal(process.env.RELAY_ADMISSION, "off");
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed");
  assert.equal(fs.existsSync(s.ctx.env.RELAY_ADMISSION_HOME), false);
});

test("a provider refusal followed by a backend exit is failed without automatic recovery", async t => {
  const s = seed(t); s.unblock();
  const backend = backendNamed("codex"), connect = backend.connect;
  let connections = 0;
  t.mock.method(backend, "connect", async (...args) => {
    const connection = await connect(...args); connections++;
    t.mock.method(connection, "run", async () => {
      connection.client.exitInfo = { code: 1, endedAt: new Date().toISOString() };
      return { turnStatus: "failed", error: { message: "synthetic usage limit", codexErrorInfo: "usageLimitExceeded" }, finalMessage: "" };
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "failed");
  assert.equal(job.refusal.kind, "usage");
  assert.equal(connections, 1);
  assert.equal(job.automaticResumes?.length ?? 0, 0);
});

test("an impossible backend scope fails clearly without connecting or retrying", async t => {
  const s = seed(t); s.unblock();
  s.options.admission.readMachine = () => ({ totalBytes: 64 * GiB, availableBytes: 60 * GiB, cores: 8, load5: 0, notes: [], group: "/synthetic",
    scopes: [{ id: "/synthetic", limitBytes: 0.5 * GiB, currentBytes: 0, remainingBytes: 0.5 * GiB }] });
  await runWorker(s.dir, s.options);
  const job = readJob(s.dir);
  assert.equal(job.state, "failed"); assert.equal(job.admission.state, "failed");
  assert.match(job.errorMessage, /cannot fit cgroup/);
  assert.equal(fs.existsSync(path.join(s.ctx.bin, "fake-codex-state.json")), false);
});

test("deferred worker retries are throttled across callers at the admission poll interval", async t => {
  const { retryQueuedWorker } = await import("../plugins/relay/scripts/lib/worker/delivery.mjs");
  const s = seed(t);
  s.ctx.env.RELAY_TEST_ADMISSION_READINGS = path.join(s.ctx.root, "readings.json");
  fs.writeFileSync(s.ctx.env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ totalBytes: 64 * GiB, availableBytes: 0, cores: 8, load5: 0 }));
  const job = readJob(s.dir);
  writeJob(s.dir, { ...job, state: "queued", admission: { state: "waiting", waitKind: "worker", since: new Date().toISOString() } });
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  retryQueuedWorker(s.dir, s.ctx.env);
  const first = readJob(s.dir).admission.workerRetryAt;
  assert.equal(readJob(s.dir).launchPendingAt, first, "old readers retain their start grace while a waiter retries");
  now += D.pollMs - 1;
  retryQueuedWorker(s.dir, s.ctx.env);
  assert.equal(readJob(s.dir).admission.workerRetryAt, first);
  now++;
  retryQueuedWorker(s.dir, s.ctx.env);
  assert.notEqual(readJob(s.dir).admission.workerRetryAt, first);
});

test("first dispatch consumes its start grant once and preserves the actual queue wait", async t => {
  const s = seed(t);
  const rename = fs.renameSync;
  let grants = 0, queuedAfterGrant = 0, atConnect;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(s.ctx.env.RELAY_ADMISSION_HOME, "timing.json")) grants++;
    if (to === path.join(s.dir, "job.json") && grants && JSON.parse(fs.readFileSync(from, "utf8")).state === "queued") queuedAfterGrant++;
    return rename(from, to);
  });
  s.options.admissionSleep = async () => {
    assert.equal(grants, 0, "first turn must not sleep on its own grant (clock deliberately stays fixed)");
    await new Promise(r => setTimeout(r, 10));
  };
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => { atConnect = readJob(s.dir).admission; return connect(...args); });
  const running = runWorker(s.dir, s.options);
  await waitFor(() => readJob(s.dir).state === "queued");
  const since = readJob(s.dir).admission.since;
  s.tick(120000); s.unblock(); await running;
  const job = readJob(s.dir);
  assert.equal(job.state, "completed"); assert.equal(grants, 1); assert.equal(queuedAfterGrant, 0);
  assert.equal(job.admission.since, since); assert.equal(job.admission.admittedAt, atConnect.admittedAt);
  assert.equal(Date.parse(job.admission.admittedAt) - Date.parse(since), 120000);
});


test("dormant workerless jobs stop deferring the repository review gate after fifteen minutes", async t => {
  const { findActiveJob } = await import("../plugins/relay/scripts/hooks/stop-review-gate.mjs");
  const s = seed(t), oldHome = process.env.RELAY_JOBS_HOME;
  process.env.RELAY_JOBS_HOME = s.ctx.env.RELAY_JOBS_HOME;
  t.after(() => { if (oldHome === undefined) delete process.env.RELAY_JOBS_HOME; else process.env.RELAY_JOBS_HOME = oldHome; });
  const now = Date.now(), at = new Date(now).toISOString();
  writeJob(s.dir, { ...readJob(s.dir), state: "queued", worker: null, admission: { waitKind: "worker", since: at, workerRetryAt: at } });
  assert.equal(findActiveJob(s.ctx.work, now + 15 * 60000).id, readJob(s.dir).id);
  assert.equal(findActiveJob(s.ctx.work, now + 15 * 60000 + 1), null);
  const job = readJob(s.dir);
  writeJob(s.dir, { ...job, admission: { ...job.admission, workerRetryAt: new Date(now + 15 * 60000 + 1).toISOString() } });
  assert.equal(findActiveJob(s.ctx.work, now + 15 * 60000 + 1).id, job.id, "an adopter makes it active again");
});

test("a heartbeat during slow probe startup releases the claim without provider success", async t => {
  const { recordRefusal, listPauses } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  s.options.env.RELAY_JOBS_HEARTBEAT_MS = "10";
  const home = s.ctx.env.RELAY_ADMISSION_HOME, deps = { ...s.options.admission, env: s.ctx.env };
  recordRefusal(home, "codex", { kind: "rate" }, "previous-job", deps);
  s.tick(D.ratePauseMs);
  const backend = backendNamed("codex"), connect = backend.connect;
  let paused;
  t.mock.method(backend, "connect", async (...args) => {
    assert.ok(listPauses(s.ctx.env, deps)[0].probing);
    s.tick(D.probeMs);
    await waitFor(() => { paused = JSON.parse(fs.readFileSync(path.join(home, "pauses", "codex.json"))); return paused && !paused.probe; });
    assert.equal(paused.strikes, 1);
    return connect(...args);
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed");
  assert.equal(listPauses(s.ctx.env, deps)[0].strikes, 1, "completion of a released generation cannot clear the pause");
});

test("server-death replacement waits for critical states, scope, provider pause and pacing before reconnecting", async t => {
  const { recordRefusal } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = seed(t); s.unblock();
  s.options.env.FAKE_CODEX_DEATH_KIND = "zero";
  const home = s.ctx.env.RELAY_ADMISSION_HOME, slotFile = path.join(home, "slots", "job-admission-worker.json");
  const timingFile = path.join(home, "timing.json");
  let connections = 0, stage = 0, original, timing;
  const states = [{ load5: 200 }, { availableBytes: 0 }, { pressure: 4 },
    { group: "/finite", scopes: [{ id: "/finite", limitBytes: 2 * GiB, remainingBytes: 0 }] }, {}, {}];
  const kinds = ["critical", "critical", "critical", "scope", "pause", "stagger"];
  s.options.admission.readMachine = () => ({ totalBytes: 128 * GiB, availableBytes: 100 * GiB, cores: 64, load5: 0, notes: [],
    ...(connections === 1 ? states[stage] : {}) });
  s.options.admissionSleep = async () => {
    assert.equal(connections, 1, "second connect must wait for every launch gate");
    assert.equal(readJob(s.dir).admission.waitKind, kinds[stage]);
    const slot = JSON.parse(fs.readFileSync(slotFile));
    assert.equal(slot.state, "running"); assert.equal(slot.holdAt, original.holdAt); assert.equal(slot.holdBytes, original.holdBytes);
    assert.equal(fs.readFileSync(timingFile, "utf8"), timing);
    stage++;
    if (stage === 4) recordRefusal(home, "codex", { kind: "rate" }, "previous", { ...s.options.admission, env: s.options.env });
    if (stage === 5) fs.rmSync(path.join(home, "pauses", "codex.json"));
    if (stage === 6) s.tick(D.spacingMs);
  };
  const backend = backendNamed("codex"), connect = backend.connect;
  t.mock.method(backend, "connect", async (...args) => {
    connections++;
    const slot = JSON.parse(fs.readFileSync(slotFile));
    if (connections === 1) { original = slot; timing = fs.readFileSync(timingFile, "utf8"); }
    else {
      assert.equal(stage, 6);
      assert.equal(Date.parse(slot.holdAt) - Date.parse(original.holdAt), D.spacingMs);
      assert.equal(slot.holdBytes, D.startupBytes.codex);
      assert.notEqual(fs.readFileSync(timingFile, "utf8"), timing);
      assert.equal(fs.readdirSync(path.join(home, "slots")).length, 1);
    }
    return connect(...args);
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed"); assert.equal(connections, 2); assert.equal(stage, 6);
  assert.equal(readJob(s.dir).attempts[0].servers.length, 2);
});

test("turns on the same connection ignore critical load and pacing without refreshing holds", async t => {
  const s = seed(t); s.unblock();
  const home = s.ctx.env.RELAY_ADMISSION_HOME, slotFile = path.join(home, "slots", "job-admission-worker.json"), timingFile = path.join(home, "timing.json");
  const backend = backendNamed("codex"), connect = backend.connect;
  let connections = 0, turns = 0, original, timing;
  s.options.admissionSleep = async () => assert.fail("retained connection must not wait on load or pacing");
  t.mock.method(backend, "connect", async (...args) => {
    connections++; const connection = await connect(...args), run = connection.run.bind(connection);
    original = JSON.parse(fs.readFileSync(slotFile)); timing = fs.readFileSync(timingFile, "utf8");
    t.mock.method(connection, "run", async (...turn) => {
      turns++;
      if (turns === 2) {
        const slot = JSON.parse(fs.readFileSync(slotFile));
        assert.equal(slot.holdAt, original.holdAt); assert.equal(slot.holdBytes, original.holdBytes);
        assert.equal(fs.readFileSync(timingFile, "utf8"), timing);
      }
      const result = await run(...turn);
      if (turns === 1) {
        postInboxMessage(s.dir, { kind: "continue", text: "[quick] Second turn." });
        s.options.admission.readMachine = () => ({ totalBytes: 128 * GiB, availableBytes: 100 * GiB, cores: 64, load5: 200, notes: [] });
      }
      return result;
    });
    return connection;
  });
  await runWorker(s.dir, s.options);
  assert.equal(readJob(s.dir).state, "completed"); assert.equal(turns, 2); assert.equal(connections, 1);
});
