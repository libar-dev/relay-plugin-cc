import { sleep, envNumber, parseCommandInput, resolveJobReference, printJson } from "./shared.mjs";
import fs from "node:fs";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { executionMembers, groupSurvivors, listProcesses, readProcessStartTime, snapshotExecutionTree, stopProcessSnapshot, terminateProcessTree } from "../lib/util/process.mjs";
import { releaseLeaseToConsumer } from "../lib/worker/delivery.mjs";
import { acquireWorkerLease, isWorkerAlive, isWorkerLease, readLease } from "../lib/jobs/lease.mjs";
import { claimInboxMessages, owedMessages, readOutcome, writeOutcome, postInboxMessage, recordReceipt } from "../lib/jobs/messages.mjs";
import { AttemptChanged, UsageError } from "../lib/util/errors.mjs";
import { jobPaths, nowIso, readJob, readJsonOrNull, TERMINAL_STATES, writeJob, writeJsonAtomic } from "../lib/jobs/store.mjs";
import { EXIT, isTerminalView, JobViewBusy, jobViewJson, loadJobView as readView, loadJobViewSettled as loadJobView, renderJobBlock } from "../lib/jobs/view.mjs";

const TAKEN_ACTIONS = new Set(["interrupt-sent", "interrupt-failed", "cancelled", "nothing-to-cancel"]);

function stateNow(jobDir) {
  try { return readView(jobDir); }
  catch (error) { if (error instanceof JobViewBusy) return null; throw error; }
}

function cancelStopped(jobDir, message, attempt, includeDead = true, killed = false) {
  const view = stateNow(jobDir);
  const outcome = message ? readOutcome(jobDir, message.id) : null;
  if (outcome?.action === "no-op") return true;
  return view !== null && (TERMINAL_STATES.has(view.state) || (includeDead && view.state === "dead") ||
    (attempt !== null && (killed || TAKEN_ACTIONS.has(outcome?.action)) && view.job.attempts.length > attempt));
}

function checkRefused(jobDir, message, killed = false) {
  const outcome = message ? readOutcome(jobDir, message.id) : null;
  if (!killed && outcome?.action === "no-op") {
    throw new AttemptChanged(`Job ${path.basename(jobDir)}: ${outcome.reason ?? "the attempt changed"}; nothing was cancelled.`);
  }
  return outcome;
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


// A nonworker holder cannot consume a delegated cancel, so wait for its short write.
function markCancelledAfterKill(jobDir, reason, attempt = null, killed = false, originalMessage = null, taken = false) {
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const deadline = Date.now() + 2000;
  while (!acquireWorkerLease(jobDir, me, "cancel")) {
    const current = readJob(jobDir);
    // A finished worker may still be closing its backend. Its job needs one
    // no-op receipt, not a delegated cancel plus a second receipt.
    if (attempt === null && TERMINAL_STATES.has(current.state)) return { ended: current.state };
    const holder = readLease(jobDir);
    if (!isWorkerLease(holder) && Date.now() < deadline) {
      pause();
      continue;
    }
    let message = originalMessage;
    if (attempt === null || (!killed && !taken)) {
      checkAttempt(readJob(jobDir), attempt);
      message = postInboxMessage(jobDir, { kind: "cancel", text: "", ...(attempt !== null ? { attempt } : {}) });
    }
    if (!isWorkerLease(holder)) return { delegated: true, pid: holder?.pid, role: holder?.role };
    const sameWorker = holder.pid === readJob(jobDir).worker?.pid;
    const until = Date.now() + envNumber("RELAY_JOBS_CANCEL_GRACE_MS", 10000);
    while (!cancelStopped(jobDir, message, attempt, false, killed) && Date.now() < until) pause();
    const view = loadJobView(jobDir);
    const outcome = checkRefused(jobDir, message, killed);
    if (attempt !== null && view.job.attempts.length > attempt && (killed || TAKEN_ACTIONS.has(outcome?.action))) {
      if (killed) finishKilledCancel(jobDir, originalMessage, attempt);
      return { advanced: view.job.attempts.length, outcome };
    }
    checkAttempt(view.job, attempt);
    return { delegated: true, pid: holder.pid, role: holder.role, sameWorker, ended: TERMINAL_STATES.has(view.state) ? view.state : null };
  }
  try {
    const job = readJob(jobDir);
    const outcome = checkRefused(jobDir, originalMessage, killed);
    if ((killed || taken) && attempt !== null && job.attempts.length > attempt) {
      if (killed) finishKilledCancel(jobDir, originalMessage, attempt);
      return { advanced: job.attempts.length, outcome };
    }
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
      pendingFirstTurn: false,
      errorMessage: reason,
      completedAt: nowIso(),
      cancelledBy: "cancel command"
    });
    // Save the terminal state before closing messages the dead worker left behind.
    for (const message of [...owedMessages(jobDir), ...claimInboxMessages(jobDir)]) {
      if (message.kind !== "cancel") writeOutcome(jobDir, message.id, { action: "dropped", reason: "the job was cancelled" });
    }
    const claimed = jobPaths(jobDir).claimed;
    for (const name of fs.readdirSync(claimed)) {
      if (!name.endsWith(".json")) continue;
      const message = readJsonOrNull(path.join(claimed, name));
      if (message?.kind !== "cancel") continue;
      const outcome = readOutcome(jobDir, message.id);
      if (outcome && !["interrupt-sent", "interrupt-failed"].includes(outcome.action)) continue;
      const current = attempts.length;
      const mismatch = message.attempt !== undefined && message.attempt !== current && !(message.attempt === 1 && current === 0);
      writeOutcome(jobDir, message.id, mismatch
        ? { action: "no-op", reason: `attempt ${message.attempt} is not the job's current attempt (${current})` }
        : { action: "cancelled" });
    }
    return { wrote: true };
  } finally {
    // A message posted after the claim above gets a worker once the lease is free.
    releaseLeaseToConsumer(jobDir, me);
  }
}


function finishKilledCancel(jobDir, message, attempt) {
  if (!message) return;
  const outcome = readOutcome(jobDir, message.id);
  if (!outcome || ["interrupt-sent", "interrupt-failed", "no-op"].includes(outcome.action)) {
    writeOutcome(jobDir, message.id, { action: "cancelled", reason: `the cancel stopped attempt ${attempt}'s processes` });
  }
}

function advancedAction(attempt, current, outcome) {
  return outcome?.action === "nothing-to-cancel"
    ? `attempt ${attempt} had already ended (${outcome.state}); attempt ${current} runs`
    : `attempt ${attempt} was stopped; attempt ${current} started since, for a message, and runs on`;
}

// A cancel left with a worker still running exits nonzero so its relay retries it.
function reportCancelHandOff(jobDir, result, actions, asJson, attempt = null) {
  if (result.advanced) {
    actions.push(advancedAction(attempt, result.advanced, result.outcome));
  } else if (result.delegated && !result.ended) {
    const jobId = readJob(jobDir)?.id ?? path.basename(jobDir);
    actions.push(`the job is still running; the cancel is with its ${result.role} (pid ${result.pid})`);
    if (!asJson) process.stderr.write(`Job ${jobId} is still running; the cancel is with its ${result.role} (pid ${result.pid}).\n`);
    process.exitCode = EXIT.running;
  } else if (result.delegated) {
    actions.push(`the cancel went to the job's ${result.role === "worker" && !result.sameWorker ? "new worker" : result.role} (pid ${result.pid}), which ended it ${result.ended}`);
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


// Snapshot before signalling so descendants remain identifiable after their parent dies.
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
  const record = path.join(jobDir, "cancelling", `${process.pid}.json`);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  writeJsonAtomic(record, { pid: process.pid, startTime: readProcessStartTime(process.pid), at: nowIso() });
  try {
    let view = loadJobView(jobDir);
    if (!isTerminalView(view) || view.state === "dead") checkAttempt(view.job, attempt);
    const actions = [];
    const initialTable = listProcesses();
    const terminal = isTerminalView(view) && view.state !== "dead";
    const initialRoots = terminal ? processRoots({ ...view.job, worker: null }) : processRoots(view.job);
    let tree = mergeSnapshots(snapshotExecutionTree(view.job, initialRoots, initialTable), executionMembers(view.job, initialTable, { jobDir }));
    if (terminal) tree = Object.assign(tree.filter(p => p.pid !== view.job.worker?.pid), tree.cause ? { cause: tree.cause } : {});
    if (tree.cause) throw new Error(`Could not cancel job ${view.job.id}: ${tree.cause}.`);
    if (isTerminalView(view) && view.state !== "dead" && tree.length === 0) {
      // Nothing to interrupt. The request is still recorded as handled: a no-op receipt.
      recordReceipt(jobDir, { kind: "cancel", text: "" }, { action: "no-op", reason: `the job had already ${view.state === "completed" ? "completed" : `ended (${view.state})`}` });
      actions.push(`already ${view.state}`);
    } else if (isTerminalView(view) || (view.state === "queued" && !view.job.worker?.pid && view.job.admission?.waitKind === "worker")) {
      checkAttempt(readJob(jobDir), attempt);
      let reusedPid = false;
      let unverified = 0;
      if (view.job.worker?.pid) {
        const table = listProcesses();
        const group = groupSurvivors(view.job.worker, table, {
          aliveUntil: view.job.heartbeatAt ?? view.job.lastEventAt ?? view.job.startedAt,
          servers: [view.job.server, ...(view.job.attempts ?? []).flatMap(attempt => attempt.servers ?? [])]
        });
        unverified = group.unverified ?? 0;
        tree = mergeSnapshots(tree, group);
        if (terminal) tree = Object.assign(tree.filter(p => p.pid !== view.job.worker.pid), tree.cause ? { cause: tree.cause } : {});
        if (tree.cause) throw new Error(`Could not cancel job ${view.job.id}: ${tree.cause}.`);
        reusedPid = Boolean(view.job.worker.startTime) && table.some(row => row.pid === view.job.worker.pid &&
          !row.zombie && row.startTime && row.startTime !== view.job.worker.startTime);
      }
      let sweepStarted = false;
      let killed = false;
      const survivors = await stopProcessSnapshot(tree, {
        beforeSignal: () => {
          if (!sweepStarted) checkAttempt(readJob(jobDir), attempt);
          sweepStarted = true;
        },
        onSignal: () => { killed = true; }
      });
      if (survivors.length > 0 || survivors.cause || tree.cause) {
        throw new Error(`Could not stop processes ${survivors.map((entry) => entry.pid).join(", ")} of job ${view.job.id}${(survivors.cause || tree.cause) ? `: ${survivors.cause || tree.cause}` : ""}.`);
      }
      const result = markCancelledAfterKill(jobDir, "Cancelled after the worker had died.", attempt, killed);
      if (result.wrote) {
        recordReceipt(jobDir, { kind: "cancel", text: "" }, { action: "cancelled", reason: "the worker had died; the job was marked cancelled" });
        if (unverified) actions.push(`${unverified} ${unverified === 1 ? "process" : "processes"} in the dead worker's old process group could not be tied to the job; ${tree.length === 0 ? "nothing was signalled" : "they were left alone"}`);
        actions.push(reusedPid && tree.length === 0
          ? "the worker was already gone and its process id now belongs to another process; nothing was signalled"
          : "worker was already gone; marked cancelled");
      } else {
        if (result.ended) recordReceipt(jobDir, { kind: "cancel", text: "" }, {
          action: killed ? "cancelled" : "no-op", reason: killed ? "owned processes were stopped after the job ended" : `the job had already ended (${result.ended})`
        });
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
      view = loadJobView(jobDir);
      let outcome = checkRefused(jobDir, message);
      let taken = TAKEN_ACTIONS.has(outcome?.action);
      let killed = false;
      const beforeSignal = () => {
        if (!killed && !taken) checkAttempt(readJob(jobDir), attempt);
      };
      const recordKill = (method) => {
        if (killed) return;
        killed = true;
        actions.push(`killed the worker process ${method === "process" ? "" : "tree "}(${worker.pid}) after ${Math.round(graceMs / 1000)}s`);
      };
      const refresh = () => {
        view = loadJobView(jobDir);
        outcome = checkRefused(jobDir, message, killed);
        taken = TAKEN_ACTIONS.has(outcome?.action);
      };
      const runsOn = () => {
        if (attempt === null || view.job.attempts.length <= attempt) return false;
        if (killed) finishKilledCancel(jobDir, message, attempt);
        actions.push(advancedAction(attempt, view.job.attempts.length, outcome));
        return true;
      };
      const advanced = () => attempt !== null && view.job.attempts.length > attempt && (killed || taken);
      const worker = view.job.worker;
      const cooperative = attempt !== null && (taken || (stopped && view.state !== "dead"));
      if (cooperative) {
        // The worker answered and may begin a newer attempt, so it is never signalled. Its tree is read
        // again for what attempt N left (a tool started while the turn was interrupted): a newer attempt is
        // recorded before its server starts, so a read after which the count is still N holds none of it.
        const later = worker?.pid && isWorkerAlive(worker) ? snapshotExecutionTree(view.job, [worker.pid]) : [];
        const current = readJob(jobDir)?.attempts?.length ?? 0;
        const merged = current === attempt || (attempt === 1 && current === 0) ? mergeSnapshots(tree, later) : tree;
        tree = Object.assign(merged.filter(entry => entry.pid !== worker?.pid), merged.cause ? { cause: merged.cause } : {});
      } else {
        tree = mergeSnapshots(tree, snapshotExecutionTree(view.job, processRoots(view.job)));
      }
      if (!advanced()) {
        checkAttempt(view.job, attempt);
        // Check again just before signalling: the worker can begin a queued attempt meanwhile.
        if (!cooperative && (!stopped || view.state === "dead")) {
          checkAttempt(readJob(jobDir), attempt);
          if (worker?.pid && isWorkerAlive(worker)) {
            const kill = terminateProcessTree(worker.pid, { identity: worker, beforeSignal });
            if (kill.delivered) recordKill(kill.method);
          }
        } else if (worker?.pid) {
          await waitUntil(() => !isWorkerAlive(worker) || (attempt !== null && (stateNow(jobDir)?.job.attempts.length ?? 0) > attempt), 5000, 100);
          refresh();
          if (cooperative && isWorkerAlive(worker) && !advanced()) {
            actions.push(isTerminalView(view)
              ? `the worker (pid ${worker.pid}) is still closing; it is left to finish`
              : `the worker (pid ${worker.pid}) has not ended the turn; it is left to finish`);
          }
        }
      }
      let sweepStarted = false;
      const survivors = await stopProcessSnapshot(tree, {
        beforeSignal: (entry) => {
          if (!sweepStarted) beforeSignal();
          // A worker can run attempt N+1 in-process; an old tool cannot.
          if (sweepStarted && entry.pid === worker?.pid && attempt !== null && (readJob(jobDir).attempts?.length ?? 0) > attempt) return false;
          sweepStarted = true;
        },
        // The group signal may have failed verification or delivery. A later sweep
        // can still stop the verified original worker; retain that fact at once.
        onSignal: (entry) => {
          if (entry.pid === worker?.pid && entry.startTime === worker.startTime) recordKill("process");
          else if (!killed) { killed = true; actions.push(`stopped attempt ${attempt ?? view.job.attempts.length}'s processes`); }
        }
      });
      if (survivors.length > 0 || survivors.cause || tree.cause) {
        throw new Error(`Could not stop processes ${survivors.map((entry) => entry.pid).join(", ")} of job ${view.job.id}. ${survivors.cause ?? tree.cause ?? "They are still running"}.`);
      }
      if (tree.length > 1) actions.push(`stopped ${tree.length} processes (worker, app-server and descendants)`);
      refresh();
      if (!((killed || taken) && runsOn()) && (!isTerminalView(view) || view.state === "dead")) {
        const result = markCancelledAfterKill(jobDir, "Cancelled: the worker was stopped.", attempt, killed, message, taken);
        if (!result.wrote) reportCancelHandOff(jobDir, result, actions, options.json, attempt);
      }
    }
    view = loadJobView(jobDir);
    if (options.json) {
      printJson("cancel", { ...jobViewJson(view), actions });
    } else {
      process.stdout.write(`${renderJobBlock(view)}${actions.map((action) => `cancel: ${action}`).join("\n")}\n`);
    }
  } finally {
    fs.unlinkSync(record);
  }
}
