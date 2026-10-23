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
    admissionSleep: async () => { now += Math.max(D.spacingMs, D.aboveMinSpacingMs); await new Promise(r => setTimeout(r, 10)); } };
  return { ctx, dir, options, unblock: () => blocked = false, block: () => blocked = true };
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
