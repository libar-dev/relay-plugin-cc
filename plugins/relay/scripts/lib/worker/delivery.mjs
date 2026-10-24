// Messages to a job's worker: post to the inbox, start a worker when none is alive to take
// the message, and wait (bounded) for the worker to record an outcome. The companion's
// steer, continue and resume commands and the relay hook share this code.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { absoluteJobsHomeEnv, jobPaths, readJob, writeJob, readJsonOrNull, writeJsonAtomic, TERMINAL_STATES } from "../jobs/store.mjs";
import { isMessagePending, messageAccount, pendingInboxMessages, postInboxMessage, readOutcome, writeOutcome } from "../jobs/messages.mjs";
import { isWorkerLease, readLease, releaseWorkerLease } from "../jobs/lease.mjs";
import { spawnWithAdmission, DEFAULTS } from "./admission.mjs";
import { acquireOwnership, releaseOwnership } from "../util/ownership.mjs";
import { holderAlive } from "./admission.mjs";
import { readProcessStartTime, isProcessIdentityAlive } from "../util/process.mjs";

export const COMPANION_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "companion.mjs");

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnWorker(jobDir, cwd, env = process.env) {
  const lease = jobPaths(jobDir).lease;
  if (!acquireOwnership(lease, { pid: process.pid, startTime: null, role: "spawn" }, { isAlive: holderAlive })) return null;
  try {
    let job = readJob(jobDir);
    const latest = latestLaunch(jobDir);
    if (latest?.worker && ["pending", "acknowledged"].includes(latest.state) && isProcessIdentityAlive(latest.worker)) return null;
    if (job && !TERMINAL_STATES.has(job.state) && launchInterrupted(job, latest) && job.admission?.causeKind !== "launch") {
      job = { ...job, state: "queued", worker: null, admission: { ...job.admission, state: "waiting",
        waitKind: "worker", causeKind: "launch", reason: "worker launch interrupted; retrying", since: new Date().toISOString() } };
      writeJob(jobDir, job);
    }
    const retryAt = Date.parse(job?.admission?.workerRetryAt);
    const poll = envNumber(env, "RELAY_ADMISSION_POLL_MS", DEFAULTS.pollMs);
    if (job?.state === "queued" && job.admission?.waitKind === "worker" && Date.now() >= retryAt && Date.now() - retryAt < poll) return null;
    const result = spawnWithAdmission(jobDir, env, () => spawnWorkerProcess(jobDir, cwd, env));
    const deferred = readJob(jobDir);
    if (deferred?.state === "queued" && deferred.admission?.waitKind === "worker") writeJob(jobDir, { ...deferred, launchPendingAt: new Date(Date.now()).toISOString(), admission: { ...deferred.admission, workerRetryAt: new Date(Date.now()).toISOString() } });
    return result;
  } catch (error) {
    const job = readJob(jobDir);
    if (job && (!TERMINAL_STATES.has(job.state) || pendingInboxMessages(jobDir).length > 0)) writeJob(jobDir, { ...job, state: "queued", worker: null,
      admission: { ...job.admission, state: "waiting", waitKind: "worker", causeKind: "launch",
        reason: "worker launch interrupted; retrying", launchError: error.message,
        since: new Date().toISOString(), workerRetryAt: new Date().toISOString() } });
    process.stderr.write(`relay load guard: deferred worker spawn failed (${error.message}); work remains queued for retry\n`);
    return null;
  }
  finally { releaseOwnership(lease); }
}

function spawnWorkerProcess(jobDir, cwd, env) {
  const file = path.join(jobDir, `launch-${randomUUID()}.json`);
  writeJsonAtomic(file, { jobId: path.basename(jobDir), trigger: env.RELAY_WORKER_TRIGGER ?? process.argv[2] ?? "dispatch",
    caller: { pid: process.pid, startTime: readProcessStartTime(process.pid) }, requestedAt: new Date().toISOString(), state: "pending" });
  /** @type {NodeJS.ProcessEnv} */
  const launchEnv = absoluteJobsHomeEnv(env);
  delete launchEnv.RELAY_WORKER_TRIGGER;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./launcher.mjs", import.meta.url)), file, COMPANION_SCRIPT, jobDir, fs.existsSync(cwd) ? cwd : jobDir], {
    env: launchEnv, encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Worker launch failed: ${result.stderr}`);
  const pid = Number(result.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Worker launcher returned no process identity.");
  // Do not publish a successful dispatch until the worker proves it was reparented.
  // Keeping the caller here also lets the worker detect Stop during the handoff.
  const deadline = Date.now() + 10000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const launch = readJsonOrNull(file);
    if (launch?.state === "acknowledged") return launch.worker.pid;
    if (launch?.state?.startsWith("handoff-")) throw new Error("Worker launch handoff failed; no backend was started.");
    Atomics.wait(pause, 0, 0, 10);
  }
  throw new Error("Worker launch acknowledgement timed out; no dispatch was confirmed.");
}

// Only a live worker consumes inbox messages. A cancel or a recovery that holds the lease
// to write job.json is no consumer.
export function hasLiveWorker(jobDir) {
  return isWorkerLease(readLease(jobDir));
}

// Release a lease taken by a holder that is not a worker. It reads the inbox before and
// after the release, and starts a worker for a message that arrived while it held the
// lease. `spawn: false` when the caller
// starts a worker itself. Returns whether it started one.
export function releaseLeaseToConsumer(jobDir, holder, env = process.env, { spawn = true } = {}) {
  const before = pendingInboxMessages(jobDir).length > 0;
  releaseWorkerLease(jobDir, holder);
  if (!spawn || !(before || pendingInboxMessages(jobDir).length > 0) || hasLiveWorker(jobDir)) {
    return false;
  }
  const job = readJob(jobDir);
  spawnWorker(jobDir, job?.request?.cwd ?? process.cwd(), env);
  return true;
}

// A worker was spawned for this job a moment ago and has not taken its lease yet.
function workerJustSpawned(job, now = Date.now()) {
  if (job?.worker?.pid || ["completed", "failed", "cancelled"].includes(job?.state)) {
    return false;
  }
  const created = Date.parse(job?.createdAt ?? "");
  return Number.isFinite(created) && now - created < 10000;
}

// Whether the job ended after an attempt that ran this message.
function attemptEnded(jobDir, messageId) {
  const job = readJob(jobDir);
  const attempt = (job?.attempts ?? []).findLast((entry) => entry.messageId === messageId);
  return Boolean(attempt && TERMINAL_STATES.has(attempt.state) && TERMINAL_STATES.has(job.state));
}

// Make sure a worker will take a message already in the inbox, and wait up to timeoutMs
// for its outcome. With wait:false, wait only until a live consumer exists.
// A timeout leaves consumer:false so a relay keeps the original message pending.
export async function awaitOutcome(jobDir, messageId, options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? envNumber(env, "RELAY_JOBS_ACK_TIMEOUT_MS", 60000);
  const pollMs = envNumber(env, "RELAY_JOBS_POLL_MS", 200);
  const deadline = Date.now() + timeoutMs;
  let lastSpawnAt = 0;
  let spawned = 0;
  for (;;) {
    retryQueuedWorker(jobDir, env);
    const outcome = readOutcome(jobDir, messageId);
    const live = hasLiveWorker(jobDir);
    // A worker that ran this message in an attempt and then ended the job (a failed resume,
    // say) leaves it owed for `resume`, which the state block names. Only a worker that died
    // before it ended such an attempt gets a successor here; otherwise the attempt count would
    // depend on whether this loop read the outcome before or after that worker exited.
    if (outcome && (live || !messageAccount(jobDir).undelivered.includes(messageId) || attemptEnded(jobDir, messageId))) {
      return { outcome, spawned, consumer: true };
    }
    const deferred = readJob(jobDir);
    if (!live && deferred?.state === "queued" && deferred.admission?.waitKind === "worker") {
      const queued = outcome ?? { action: "queued-next-turn", reason: deferred.admission.reason };
      if (!outcome) writeOutcome(jobDir, messageId, queued);
      return { outcome: queued, spawned, consumer: true };
    }
    if (options.wait === false && live) {
      return { outcome: null, spawned, consumer: true };
    }
    if (Date.now() >= deadline) {
      return { outcome: null, spawned, consumer: false };
    }
    if ((isMessagePending(jobDir, messageId) || messageAccount(jobDir).undelivered.includes(messageId)) && !live && Date.now() - lastSpawnAt > 5000) {
      const job = readJob(jobDir);
      if (job?.admission?.waitKind === "worker" || !workerJustSpawned(job)) {
        const pid = spawnWorker(jobDir, job?.request?.cwd ?? process.cwd(), env);
        lastSpawnAt = Date.now();
        if (pid) spawned += 1;
      }
    }
    await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
  }
}

// Drop a message into the job's inbox and wait until a worker records its outcome.
export async function deliverMessage(jobDir, kind, text, extra = {}, options = {}) {
  const message = postInboxMessage(jobDir, { kind, text, ...extra });
  const { outcome, spawned } = await awaitOutcome(jobDir, message.id, options);
  return { message, outcome, spawned };
}

function latestLaunch(jobDir) {
  return fs.readdirSync(jobDir).filter(name => /^launch-.*\.json$/.test(name))
    .map(name => readJsonOrNull(path.join(jobDir, name))).filter(Boolean)
    .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt))).at(-1);
}

function launchInterrupted(job, latest) {
  return latest && (latest.state === "pending" || latest.state?.startsWith("handoff-")) &&
    !isProcessIdentityAlive(latest.worker) && !(job.attempts ?? []).some(attempt => Date.parse(attempt.startedAt) >= Date.parse(latest.requestedAt));
}

export function retryQueuedWorker(jobDir, env = process.env) {
  const job = readJob(jobDir);
  if (job && !TERMINAL_STATES.has(job.state) && !hasLiveWorker(jobDir) && !isProcessIdentityAlive(job.worker)) {
    const latest = latestLaunch(jobDir);
    if (launchInterrupted(job, latest)) {
      // Re-read and reserve under the spawn lease; concurrent waiters share that fence.
      return spawnWorker(jobDir, job.request?.cwd ?? process.cwd(), env);
    }
  }
  if (job?.state === "queued" && job.admission?.waitKind === "worker" && !hasLiveWorker(jobDir)) {
    try { return spawnWorker(jobDir, job.request?.cwd ?? process.cwd(), env); }
    catch (error) {
      process.stderr.write(`relay load guard: deferred worker spawn failed (${error.message}); work remains queued for retry\n`);
      return null;
    }
  }
  return null;
}
