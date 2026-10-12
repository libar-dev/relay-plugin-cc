// Messages to a job's worker: post to the inbox, start a worker when none is alive to take
// the message, and wait (bounded) for the worker to record an outcome. The companion's
// steer, continue and resume commands and the relay hook share this code.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { absoluteJobsHomeEnv, jobPaths, readJob, TERMINAL_STATES } from "../jobs/store.mjs";
import { isMessagePending, messageAccount, pendingInboxMessages, postInboxMessage, readOutcome } from "../jobs/messages.mjs";
import { isWorkerLease, readLease, releaseWorkerLease } from "../jobs/lease.mjs";

export const COMPANION_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "companion.mjs");

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnWorker(jobDir, cwd, env = process.env) {
  const paths = jobPaths(jobDir);
  const fd = fs.openSync(paths.stderr, "a");
  try {
    const child = spawn(process.execPath, [COMPANION_SCRIPT, "worker", jobDir], {
      cwd: fs.existsSync(cwd) ? cwd : jobDir,
      env: absoluteJobsHomeEnv(env),
      detached: true,
      stdio: ["ignore", fd, fd]
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(fd);
  }
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
    const outcome = readOutcome(jobDir, messageId);
    const live = hasLiveWorker(jobDir);
    // A worker that ran this message in an attempt and then ended the job (a failed resume,
    // say) leaves it owed for `resume`, which the state block names. Only a worker that died
    // before it ended such an attempt gets a successor here; otherwise the attempt count would
    // depend on whether this loop read the outcome before or after that worker exited.
    if (outcome && (live || !messageAccount(jobDir).undelivered.includes(messageId) || attemptEnded(jobDir, messageId))) {
      return { outcome, spawned, consumer: true };
    }
    if (options.wait === false && live) {
      return { outcome: null, spawned, consumer: true };
    }
    if (Date.now() >= deadline) {
      return { outcome: null, spawned, consumer: false };
    }
    if ((isMessagePending(jobDir, messageId) || messageAccount(jobDir).undelivered.includes(messageId)) && !live && Date.now() - lastSpawnAt > 5000) {
      const job = readJob(jobDir);
      if (!workerJustSpawned(job)) {
        spawnWorker(jobDir, job?.request?.cwd ?? process.cwd(), env);
        lastSpawnAt = Date.now();
        spawned += 1;
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
