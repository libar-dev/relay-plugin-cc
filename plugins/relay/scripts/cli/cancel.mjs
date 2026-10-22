import { sleep, envNumber, parseCommandInput, resolveJobReference, printJson } from "./shared.mjs";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { readProcessStartTime, snapshotProcessTree, stopProcessSnapshot, terminateProcessTree } from "../lib/util/process.mjs";
import { releaseLeaseToConsumer } from "../lib/worker/delivery.mjs";
import { acquireWorkerLease, isWorkerAlive, readLease } from "../lib/jobs/lease.mjs";
import { claimInboxMessages, owedMessages, readOutcome, writeOutcome, postInboxMessage, recordReceipt } from "../lib/jobs/messages.mjs";
import { AttemptChanged, UsageError } from "../lib/util/errors.mjs";
import { nowIso, readJob, TERMINAL_STATES, writeJob } from "../lib/jobs/store.mjs";
import { EXIT, isTerminalView, JobViewBusy, jobViewJson, loadJobView as readView, loadJobViewSettled as loadJobView, renderJobBlock } from "../lib/jobs/view.mjs";

const TAKEN_ACTIONS = new Set(["interrupt-sent", "interrupt-failed", "cancelled", "nothing-to-cancel"]);

function stateNow(jobDir) {
  try { return readView(jobDir); }
  catch (error) { if (error instanceof JobViewBusy) return null; throw error; }
}

function cancelStopped(jobDir, message, attempt, includeDead = true) {
  const outcome = message ? readOutcome(jobDir, message.id) : null;
  if (outcome?.action === "no-op") return true;
  const view = stateNow(jobDir);
  return view !== null && (TERMINAL_STATES.has(view.state) || (includeDead && view.state === "dead") ||
    (attempt !== null && TAKEN_ACTIONS.has(outcome?.action) && view.job.attempts.length > attempt));
}

function checkRefused(jobDir, message) {
  const outcome = message ? readOutcome(jobDir, message.id) : null;
  if (outcome?.action === "no-op") {
    throw new AttemptChanged(`Job ${path.basename(jobDir)}: ${outcome.reason ?? "the attempt changed"}; nothing was cancelled.`);
  }
  return TAKEN_ACTIONS.has(outcome?.action);
}

function checkAttempt(job, expected) {
  const current = job.attempts?.length ?? 0;
  if (expected !== null && current !== expected && !(expected === 1 && current === 0)) {
    throw new AttemptChanged(`Job ${job.id} is at attempt ${current}, not ${expected}: nothing was cancelled.`);
  }
}


async function waitUntil(predicate, timeoutMs, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(pollMs);
  }
  return predicate();
}


// Cancel writes only after confirming the worker is dead and taking its lease.
// Its lease role does not consume messages. Returns what happened:
// - { wrote: true } when the cancel wrote the cancelled state itself;
// - { ended: state } when a worker had ended the job before the write; its end stands;
// - { delegated, pid, ended } when a worker started after that death holds the lease.
//   The cancel goes to it as an inbox message and waits up to the grace for the job to end.
function markCancelledAfterKill(jobDir, reason, attempt = null, killed = false) {
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  if (!acquireWorkerLease(jobDir, me, "cancel")) {
    const holder = readLease(jobDir);
    if (killed && attempt !== null) return { held: true, pid: holder?.pid ?? "unknown", role: holder?.role ?? "worker" };
    checkAttempt(readJob(jobDir), attempt);
    const message = postInboxMessage(jobDir, { kind: "cancel", text: "", ...(attempt !== null ? { attempt } : {}) });
    const deadline = Date.now() + envNumber("RELAY_JOBS_CANCEL_GRACE_MS", 10000);
    while (!cancelStopped(jobDir, message, attempt, false) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(100, deadline - Date.now())));
    }
    const taken = checkRefused(jobDir, message);
    const view = loadJobView(jobDir);
    if (taken && attempt !== null && view.job.attempts.length > attempt) {
      return { advanced: view.job.attempts.length };
    }
    checkAttempt(view.job, attempt);
    const state = view.state;
    return { delegated: true, pid: holder?.pid ?? "unknown", role: holder?.role ?? "worker", ended: TERMINAL_STATES.has(state) ? state : null };
  }
  try {
    const job = readJob(jobDir);
    if (killed && attempt !== null && job.attempts.length > attempt) return { advanced: job.attempts.length };
    checkAttempt(job, attempt);
    if (TERMINAL_STATES.has(job.state)) {
      return { ended: job.state };
    }
    const attempts = Array.isArray(job.attempts) ? [...job.attempts] : [];
    const last = attempts.at(-1);
    if (last && !["completed", "failed", "cancelled"].includes(last.state)) {
      attempts[attempts.length - 1] = { ...last, state: "cancelled", endedAt: nowIso() };
    }
    writeJob(jobDir, {
      ...job,
      attempts,
      state: "cancelled",
      errorMessage: reason,
      completedAt: nowIso(),
      cancelledBy: "cancel command"
    });
    // Messages the dead worker owed, and any still in the inbox, are reported as dropped.
    for (const message of [...owedMessages(jobDir), ...claimInboxMessages(jobDir)]) {
      writeOutcome(jobDir, message.id, {
        action: message.kind === "cancel" ? "cancelled" : "dropped",
        reason: "the job was cancelled"
      });
    }
    return { wrote: true };
  } finally {
    // A message posted after the claim above gets a worker once the lease is free.
    releaseLeaseToConsumer(jobDir, me);
  }
}


// The cancel's report when it did not write the state itself. A cancel left with a live
// worker that has not ended the job exits nonzero, so a relay retries it.
function reportCancelHandOff(jobDir, result, actions, asJson, attempt = null) {
  if (result.held) {
    actions.push(`the worker of attempt ${attempt} was stopped; a new worker (pid ${result.pid}) took the job for a message sent since, and runs on`);
  } else if (result.advanced) {
    actions.push(`attempt ${attempt} was stopped; attempt ${result.advanced} started since, for a message, and runs on`);
  } else if (result.delegated && !result.ended) {
    const jobId = readJob(jobDir)?.id ?? path.basename(jobDir);
    actions.push(`the job is still running; the cancel is with its ${result.role} (pid ${result.pid})`);
    if (!asJson) process.stderr.write(`Job ${jobId} is still running; the cancel is with its ${result.role} (pid ${result.pid}).\n`);
    process.exitCode = EXIT.running;
  } else if (result.delegated) {
    actions.push(`the cancel went to the job's ${result.role === "worker" ? "new worker" : result.role} (pid ${result.pid}), which ended it ${result.ended}`);
  } else if (result.ended) {
    actions.push(`a worker ended the job ${result.ended} before the cancel wrote it`);
  }
}


function processRoots(job) {
  const roots = [];
  if (job.worker?.pid && isWorkerAlive(job.worker)) {
    roots.push(job.worker.pid);
  }
  if (job.server?.pid && isWorkerAlive(job.server)) {
    roots.push(job.server.pid);
  }
  return roots;
}


/** @param {...import("../lib/util/process.mjs").ProcessSnapshot} snapshots */
function mergeSnapshots(...snapshots) {
  const byPid = new Map();
  for (const entry of snapshots.flat()) {
    byPid.set(`${entry.pid}:${entry.startTime}`, entry);
  }
  /** @type {import("../lib/util/process.mjs").ProcessSnapshot} */
  const merged = [...byPid.values()];
  const unreadable = snapshots.find(snapshot => snapshot.cause);
  if (unreadable) merged.cause = unreadable.cause;
  return merged;
}


// Cancel leaves nothing running: the worker, its app-server and every descendant are
// snapshotted (with start times) before anything is signalled, and swept at the end. With
// `--attempt`, a newer attempt a message started after this one stopped is left running.
export async function handleCancel(argv) {
  let parsed;
  try { parsed = parseCommandInput(argv, { booleanOptions: ["json"], valueOptions: ["attempt"] }); }
  catch (error) {
    if (error.message === "Missing value for --attempt") throw new UsageError("--attempt must be a positive integer.");
    throw error;
  }
  const { options, positionals } = parsed;
  const attempt = options.attempt === undefined ? null : Number(options.attempt);
  if (attempt !== null && (!/^\d+$/.test(options.attempt) || !Number.isSafeInteger(attempt) || attempt < 1)) {
    throw new UsageError("--attempt must be a positive integer.");
  }
  const jobDir = resolveJobReference(positionals[0], "cancel");
  let view = loadJobView(jobDir);
  if (!isTerminalView(view) || view.state === "dead") checkAttempt(view.job, attempt);
  const actions = [];
  let tree = snapshotProcessTree(processRoots(view.job));
  if (tree.cause) throw new Error(`Could not cancel job ${view.job.id}: ${tree.cause}.`);
  if (isTerminalView(view) && view.state !== "dead") {
    // Nothing to interrupt. The request is still recorded as handled: a no-op receipt.
    recordReceipt(jobDir, { kind: "cancel", text: "" }, { action: "no-op", reason: `the job had already ${view.state === "completed" ? "completed" : `ended (${view.state})`}` });
    actions.push(`already ${view.state}`);
  } else if (view.state === "dead") {
    checkAttempt(readJob(jobDir), attempt);
    if (view.job.worker?.pid) {
      // The worker is gone; stop anything left in its process group.
      terminateProcessTree(view.job.worker.pid);
    }
    const survivors = await stopProcessSnapshot(tree);
    if (survivors.length > 0 || survivors.cause || tree.cause) {
      throw new Error(`Could not stop processes ${survivors.map((entry) => entry.pid).join(", ")} of job ${view.job.id}${(survivors.cause || tree.cause) ? `: ${survivors.cause || tree.cause}` : ""}.`);
    }
    const result = markCancelledAfterKill(jobDir, "Cancelled after the worker had died.", attempt);
    if (result.wrote) {
      recordReceipt(jobDir, { kind: "cancel", text: "" }, { action: "cancelled", reason: "the worker had died; the job was marked cancelled" });
      actions.push("worker was already gone; marked cancelled");
    } else {
      reportCancelHandOff(jobDir, result, actions, options.json, attempt);
    }
  } else {
    const graceMs = envNumber("RELAY_JOBS_CANCEL_GRACE_MS", 10000);
    let message = null;
    if (view.job.kind === "task" || !view.job.kind) {
      checkAttempt(readJob(jobDir), attempt);
      message = postInboxMessage(jobDir, { kind: "cancel", text: "", ...(attempt !== null ? { attempt } : {}) });
      actions.push("asked the worker to interrupt the turn");
    }
    const stopped = await waitUntil(() => cancelStopped(jobDir, message, attempt), graceMs);
    const taken = checkRefused(jobDir, message);
    view = loadJobView(jobDir);
    const runsOn = () => {
      if (attempt === null || view.job.attempts.length <= attempt) return false;
      actions.push(`attempt ${attempt} was stopped; attempt ${view.job.attempts.length} started since, for a message, and runs on`);
      return true;
    };
    if (!(taken && runsOn())) {
      checkAttempt(view.job, attempt);
      let killed = false;
      const worker = view.job.worker;
      tree = mergeSnapshots(tree, snapshotProcessTree(processRoots(view.job)));
      // This second read can fail (`tree.cause`). The worker's group is still signalled below, by
      // pid alone, and the sweep after it signals nothing it cannot check before the failure is
      // reported: only the first read's failure stops cancel before any signal.
      if (!stopped || view.state === "dead") {
        checkAttempt(readJob(jobDir), attempt);
        if (worker?.pid && isWorkerAlive(worker)) {
          const kill = terminateProcessTree(worker.pid);
          killed = true;
          actions.push(`killed the worker process ${kill.method === "process" ? "" : "tree "}(${worker.pid}) after ${Math.round(graceMs / 1000)}s`);
        }
      } else if (worker?.pid) {
        // The worker stopped the turn itself; let it finish closing its app-server.
        await waitUntil(() => !isWorkerAlive(worker), 5000, 100);
      }
      view = loadJobView(jobDir);
      if (!runsOn()) {
        const survivors = await stopProcessSnapshot(tree);
        if (survivors.length > 0 || survivors.cause || tree.cause) {
          throw new Error(`Could not stop processes ${survivors.map((entry) => entry.pid).join(", ")} of job ${view.job.id}. ${survivors.cause ?? tree.cause ?? "They are still running"}.`);
        }
        if (tree.length > 1) {
          actions.push(`stopped ${tree.length} processes (worker, app-server and descendants)`);
        }
        view = loadJobView(jobDir);
        if (!runsOn() && (!isTerminalView(view) || view.state === "dead")) {
          const result = markCancelledAfterKill(jobDir, "Cancelled: the worker was stopped.", attempt, killed);
          if (!result.wrote) {
            reportCancelHandOff(jobDir, result, actions, options.json, attempt);
          }
        }
      }
    }
  }
  view = loadJobView(jobDir);
  if (options.json) {
    printJson("cancel", { ...jobViewJson(view), actions });
  } else {
    process.stdout.write(`${renderJobBlock(view)}${actions.map((action) => `cancel: ${action}`).join("\n")}\n`);
  }
}
