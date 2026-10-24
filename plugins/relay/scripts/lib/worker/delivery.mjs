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
import { isMessagePending, messageAccount, pendingInboxMessages, postInboxMessage, readOutcome, withdrawMessage } from "../jobs/messages.mjs";
import { isWorkerLease, readLease, releaseWorkerLease } from "../jobs/lease.mjs";
import { spawnWithAdmission, discardSpawnReservation, DEFAULTS } from "./admission.mjs";
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

export function spawnWorker(jobDir, cwd, env = process.env, { reservation = null } = {}) {
  const lease = jobPaths(jobDir).lease;
  if (!acquireOwnership(lease, { pid: process.pid, startTime: null, role: "spawn" }, { isAlive: holderAlive })) return null;
  try {
    let job = readJob(jobDir);
    pruneLaunches(jobDir);
    const latest = latestLaunch(jobDir);
    if (latest?.worker && ["pending", "acknowledged"].includes(latest.state) && isProcessIdentityAlive(latest.worker)) return null;
    if (job && (!TERMINAL_STATES.has(job.state) || pendingInboxMessages(jobDir).length) && launchInterrupted(job, latest)) {
      job = { ...job, state: TERMINAL_STATES.has(job.state) ? job.state : "queued", worker: null, admission: { ...job.admission, state: "waiting",
        waitKind: "worker", causeKind: "launch", launcher: { pid: process.pid, startTime: readProcessStartTime(process.pid) }, reason: "worker launch interrupted; retrying", since: new Date().toISOString() } };
      writeJob(jobDir, job);
    }
    const pendingId = pendingInboxMessages(jobDir).at(0) ?? null;
    if (pendingId && job?.admission?.launchMessageId !== pendingId && job?.admission?.launchFailures) {
      job = { ...job, admission: { ...job.admission, launchFailures: 0, launchError: null, launchMessageId: pendingId } };
      writeJob(jobDir, job);
    }
    if ((job?.admission?.launchFailures ?? 0) >= DEFAULTS.maxLaunchFailures) return null;
    const retryAt = Date.parse(job?.admission?.workerRetryAt);
    const poll = envNumber(env, "RELAY_ADMISSION_POLL_MS", DEFAULTS.pollMs);
    if (job?.state === "queued" && job.admission?.waitKind === "worker" && Date.now() - retryAt >= 0 && Date.now() - retryAt < poll) return null;
    const result = spawnWithAdmission(jobDir, env, () => spawnWorkerProcess(jobDir, cwd, env), {}, { reservation });
    const deferred = readJob(jobDir);
    if (deferred?.state === "queued" && deferred.admission?.waitKind === "worker") writeJob(jobDir, { ...deferred, launchPendingAt: new Date(Date.now()).toISOString(), admission: { ...deferred.admission, workerRetryAt: new Date(Date.now()).toISOString() } });
    return result;
  } catch (error) {
    // Dispatch acknowledgement is an observation, not worker ownership. An
    // observation timeout cannot revoke a worker that may already have started.
    const uncertain = latestLaunch(jobDir);
    if (hasLiveWorker(jobDir) || isProcessIdentityAlive(uncertain?.worker)) {
      process.stderr.write(`relay: worker dispatch observation uncertain (${error.message}); waiting for its owner\n`);
      return uncertain?.state === "acknowledged" ? uncertain.worker.pid : null;
    }
    const job = readJob(jobDir);
    if (job && (!TERMINAL_STATES.has(job.state) || pendingInboxMessages(jobDir).length > 0)) writeJob(jobDir, { ...job, state: TERMINAL_STATES.has(job.state) ? job.state : "queued", worker: null,
      admission: { ...job.admission, state: "waiting", waitKind: "worker", causeKind: "launch",
        reason: `worker launch failed (${(job.admission?.launchFailures ?? 0) + 1} of ${DEFAULTS.maxLaunchFailures}): ${error.message}`, launchError: error.message,
        launchFailures: (job.admission?.launchFailures ?? 0) + 1, launchMessageId: pendingInboxMessages(jobDir).at(0) ?? null,
        since: new Date().toISOString(), workerRetryAt: new Date().toISOString() } });
    process.stderr.write(`relay load guard: deferred worker spawn failed (${error.message}); work remains queued for retry\n`);
    return null;
  }
  finally { releaseOwnership(lease); }
}

function spawnWorkerProcess(jobDir, cwd, env) {
  pruneLaunches(jobDir, 19);
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
  const uncertain = readJsonOrNull(file);
  if (isProcessIdentityAlive(uncertain?.worker)) return uncertain.state === "acknowledged" ? uncertain.worker.pid : null;
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

// Whether the job ended after an attempt that ran this message.
function attemptEnded(jobDir, messageId) {
  const job = readJob(jobDir);
  const attempt = (job?.attempts ?? []).findLast((entry) => entry.messageId === messageId);
  return Boolean(attempt && TERMINAL_STATES.has(attempt.state) && TERMINAL_STATES.has(job.state));
}

// Make sure a worker will take a message already in the inbox, and wait up to timeoutMs
// for its outcome. With wait:false, wait only until a live consumer exists.
// A timeout leaves consumer:false so a relay keeps the original message pending.
// A submission is acknowledged only after a live worker takes the lease. Refusal
// is fenced by the same lease as dispatch; a later reader cannot resurrect the brief.
export async function startWithinWindow(jobDir, cwd, env = process.env, options = {}) {
  const now = options.now ?? Date.now, pause = options.sleep ?? sleep;
  const windowMs = options.windowMs ?? envNumber(env, "RELAY_JOBS_ACK_TIMEOUT_MS", 60000);
  const poll = Math.max(10, envNumber(env, "RELAY_ADMISSION_POLL_MS", DEFAULTS.pollMs));
  const deadline = now() + windowMs;
  let nextSpawn = -Infinity, spawned = 0;
  for (;;) {
    if (hasLiveWorker(jobDir)) return { accepted: true, spawned };
    const job = readJob(jobDir);
    if (!job || (TERMINAL_STATES.has(job.state) && !(options.messageId && messageAccount(jobDir).undelivered.includes(options.messageId)))) return { accepted: false, terminal: true, spawned };
    if (now() >= nextSpawn && now() <= deadline) {
      if ((options.spawn ?? spawnWorker)(jobDir, cwd, env, { reservation: options.reservation })) spawned++;
      nextSpawn = now() + poll;
      if (hasLiveWorker(jobDir)) return { accepted: true, spawned };
    }
    const current = readJob(jobDir);
    if (TERMINAL_STATES.has(current?.state) && !(options.messageId && messageAccount(jobDir).undelivered.includes(options.messageId))) return { accepted: false, terminal: true, spawned };
    if (now() >= deadline || (current?.admission?.launchFailures ?? 0) >= DEFAULTS.maxLaunchFailures) {
      const reason = current?.admission?.reason ?? "no live worker took ownership";
      if (options.refuse === false) return { accepted: false, reason, spawned };
      const lease = jobPaths(jobDir).lease;
      if (acquireOwnership(lease, { pid: process.pid, startTime: readProcessStartTime(process.pid), role: "refusal" }, { isAlive: holderAlive })) {
        try {
          const final = readJob(jobDir);
          if (final && !TERMINAL_STATES.has(final.state)) writeJob(jobDir, { ...final, state: "failed", worker: null,
            completedAt: new Date().toISOString(), errorMessage: `Not started: ${reason}. Nothing ran; start it again later.`,
            admission: { ...final.admission, state: "not-started", reason } });
          discardSpawnReservation(jobDir, env);
        } finally { releaseOwnership(lease); }
        return { accepted: false, reason, spawned };
      }
      // An in-flight dispatch owns the fence. Wait for its live lease or recheck
      // the terminal record before refusing; never race its backend start.
    }
    await pause(Math.max(10, Math.min(50, deadline - now())));
  }
}

export async function awaitOutcome(jobDir, messageId, options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? envNumber(env, "RELAY_JOBS_ACK_TIMEOUT_MS", 60000);
  const pollMs = Math.max(10, envNumber(env, "RELAY_JOBS_POLL_MS", 200));
  const spawnPoll = Math.max(10, envNumber(env, "RELAY_ADMISSION_POLL_MS", DEFAULTS.pollMs));
  const deadline = Date.now() + timeoutMs;
  let spawned = 0;
  if (!hasLiveWorker(jobDir) && messageAccount(jobDir).undelivered.includes(messageId) && timeoutMs > 0) {
    const job = readJob(jobDir);
    spawned += (await startWithinWindow(jobDir, job?.request?.cwd ?? process.cwd(), env,
      { windowMs: timeoutMs, messageId, refuse: false })).spawned;
  }
  let nextSpawn = -Infinity, wasLive = false;
  for (;;) {
    const outcome = readOutcome(jobDir, messageId);
    const live = hasLiveWorker(jobDir);
    if (outcome && (live || !messageAccount(jobDir).undelivered.includes(messageId) || attemptEnded(jobDir, messageId))) {
      return { outcome, spawned, consumer: true };
    }
    if (options.wait === false && live) return { outcome: null, spawned, consumer: true };
    if (Date.now() >= deadline) {
      if (live) return { outcome: null, spawned, consumer: false };
      const reason = readJob(jobDir)?.admission?.reason ?? "no live worker took the message";
      if (withdrawMessage(jobDir, messageId)) return { outcome: { action: "not-started", reason }, spawned, consumer: false };
      // A claim beat the rename. Re-read its outcome before deciding: the worker
      // owns delivery now, and the caller must not invite a duplicate send.
      const claimedOutcome = readOutcome(jobDir, messageId);
      if (claimedOutcome && (hasLiveWorker(jobDir) || !messageAccount(jobDir).undelivered.includes(messageId) || attemptEnded(jobDir, messageId))) return { outcome: claimedOutcome, spawned, consumer: true };
      if (hasLiveWorker(jobDir)) { await sleep(pollMs); continue; }
      return { outcome: null, spawned, consumer: false };
    }
    if (!live && (wasLive || Date.now() >= nextSpawn) &&
        (isMessagePending(jobDir, messageId) || messageAccount(jobDir).undelivered.includes(messageId))) {
      const job = readJob(jobDir);
      if (spawnWorker(jobDir, job?.request?.cwd ?? process.cwd(), env)) spawned++;
      nextSpawn = Date.now() + (isProcessIdentityAlive(latestLaunch(jobDir)?.worker) ? pollMs : spawnPoll);
    }
    wasLive = live;
    await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
  }
}

// Drop a message into the job's inbox and wait until a worker records its outcome.
export async function deliverMessage(jobDir, kind, text, extra = {}, options = {}) {
  const message = postInboxMessage(jobDir, { kind, text, ...extra });
  const { outcome, spawned, consumer } = await awaitOutcome(jobDir, message.id, options);
  return { message, outcome, spawned, consumer };
}

export function pruneLaunches(jobDir, keep = 20) {
  const files = fs.readdirSync(jobDir).filter(name => /^launch-.*\.json$/.test(name));
  const records = files.map(name => ({ name, record: readJsonOrNull(path.join(jobDir, name)) }))
    .sort((a, b) => String(b.record?.requestedAt ?? "").localeCompare(String(a.record?.requestedAt ?? "")) || b.name.localeCompare(a.name));
  for (const entry of records.slice(keep)) {
    // An unresolved live handoff is never discarded, regardless of history age.
    if (entry.record?.state === "pending" && isProcessIdentityAlive(entry.record.worker)) continue;
    fs.rmSync(path.join(jobDir, entry.name), { force: true });
  }
  return records.slice(0, keep).map(entry => entry.record).filter(Boolean);
}
function latestLaunch(jobDir) {
  return fs.readdirSync(jobDir).filter(name => /^launch-.*\.json$/.test(name))
    .map(name => readJsonOrNull(path.join(jobDir, name))).filter(Boolean)
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0] ?? null;
}

function launchInterrupted(job, latest) {
  return latest && (latest.state === "pending" || latest.state?.startsWith("handoff-")) &&
    !isProcessIdentityAlive(latest.worker) && !(job.attempts ?? []).some(attempt => Date.parse(attempt.startedAt) >= Date.parse(latest.requestedAt));
}

export function retryQueuedWorker(jobDir, env = process.env) {
  const job = readJob(jobDir);
  if (job && (!TERMINAL_STATES.has(job.state) || pendingInboxMessages(jobDir).length) && !hasLiveWorker(jobDir) && !isProcessIdentityAlive(job.worker)) {
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
