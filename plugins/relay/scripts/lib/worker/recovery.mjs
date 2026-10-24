// Relay wait owns automatic recovery. Take the worker lease before reserving the one
// retry, so concurrent waits cannot write job.json or launch two recovery messages.
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, readReservation } from "./admission.mjs";
import { releaseLeaseToConsumer, startWithinWindow } from "./delivery.mjs";
import { acquireWorkerLease, isWorkerAlive } from "../jobs/lease.mjs";
import { computeJobView } from "../jobs/view.mjs";
import { messageExists, newMessageId, postInboxMessage } from "../jobs/messages.mjs";
import { nowIso, readJob, readJsonOrNull, TERMINAL_STATES, writeJob } from "../jobs/store.mjs";
import { stopExecution, readProcessStartTime } from "../util/process.mjs";

// The sweep: stop those app-servers with every descendant, SIGTERM then SIGKILL. Returns
// the servers found and every process still running after the kill wait. Descendants are
// found in the process table; when it cannot be read, nothing is signalled and every
// server counts as a survivor, with the cause. Each server is then checked by its own
// identity, which needs no table. `options.listProcesses` replaces the table read (tests);
// the other options go to stopProcessSnapshot.
export async function stopRecordedAppServers(job, options = {}) {
  return stopExecution(job, options);
}

// The patch records `deathObservedAt` on swept servers and clears the live
// identity when it was one of them. A survivor keeps its record open.
export function sweptAppServersPatch(job, { servers, survivors }, at = nowIso()) {
  const same = (a, b) => a?.pid === b.pid && (a?.startTime ?? null) === (b.startTime ?? null);
  const gone = servers.filter((server) => !survivors.some((entry) => entry.pid === server.pid));
  const ended = (server) => server && !server.endedAt && gone.some((entry) => same(server, entry));
  const attempts = (job.attempts ?? []).map((attempt) =>
    attempt?.servers ? { ...attempt, servers: attempt.servers.map((server) => (ended(server) ? { ...server, deathObservedAt: server.deathObservedAt ?? at } : server)) } : attempt
  );
  const live = ended(job.server);
  return { attempts, ...(live ? { server: null, serverPid: null } : {}) };
}

function cancelIsRunning(jobDir) {
  const cancelling = path.join(jobDir, "cancelling");
  let records;
  try { records = fs.readdirSync(cancelling); }
  catch (error) { if (error.code !== "ENOENT") throw error; records = []; }
  for (const name of records) {
    if (name.endsWith(".json") && isWorkerAlive(readJsonOrNull(path.join(cancelling, name)))) return true;
  }
  return false;
}

export async function resumeDeadJobOnce(jobDir, env = process.env) {
  if (cancelIsRunning(jobDir)) return "busy";
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  if (!acquireWorkerLease(jobDir, me, "recovery")) return "busy";
  let launch = false;
  let cancelling = false;
  let cwd;
  let original;
  let reservation;
  try {
    let job = readJob(jobDir);
    if (computeJobView(job).state !== "dead" || (job.kind && job.kind !== "task")) return false;
    original = job;
    reservation = job.relay?.agentId ? readReservation(job.relay.agentId, env) : null;
    const epoch = job.recoveryEpoch ?? "start";
    const previous = recoveryForEpoch(job);
    // A reservation interrupted before posting is repaired with the same message id.
    const sweep = await stopRecordedAppServers(job, { jobDir });
    if (sweep.survivors.length || sweep.cause) throw new Error(`Could not stop the dead job's processes: ${sweep.survivors.map(entry => entry.pid).join(", ")}${sweep.cause ? ` (${sweep.cause})` : ""}`);
    job = readJob(jobDir);
    if (sweep.servers.length) job = { ...job, ...sweptAppServersPatch(job, sweep) };
    cancelling = cancelIsRunning(jobDir);
    if (cancelling) return "busy";
    if (previous && previous.state !== "reserved") {
      writeJob(jobDir, { ...job, server: null, serverPid: null,
        automaticResumes: job.automaticResumes.map(entry => entry.id === previous.id ? previous : entry) });
      return false;
    }
    const record = previous ?? { id: newMessageId(), epoch, at: nowIso(), fromAttempt: job.attempts?.length ?? 0, fromWorkerCount: job.workers?.length ?? 0, reason: "worker", state: "reserved" };
    const records = previous ? job.automaticResumes : [...(job.automaticResumes ?? []), record];
    writeJob(jobDir, { ...job, automaticResumes: records });
    if (!messageExists(jobDir, record.id)) {
      postInboxMessage(jobDir, { id: record.id, kind: "resume", text: DEFAULT_RESUME_MESSAGE, isDefault: true, automatic: true });
    }
    cwd = job.request.cwd;
    launch = true;
  } finally {
    releaseLeaseToConsumer(jobDir, me, env, { spawn: !launch && !cancelling });
  }
  if (!launch) return false;
  const result = await startWithinWindow(jobDir, cwd, { ...env, RELAY_WORKER_TRIGGER: "recovery" },
    { windowMs: Number(env.RELAY_ADMISSION_POLL_MS) || DEFAULTS.pollMs, refuse: false, reservation });
  // Workers update the job concurrently. Take its lease before changing the
  // recovery record, or let the worker's own attempt bookkeeping be authoritative.
  if (acquireWorkerLease(jobDir, me, "recovery")) {
    try {
      const job = readJob(jobDir), record = recoveryForEpoch(job);
      // Cancellation or a successor can win while dispatch is being observed.
      // Restoring the old dead view must never overwrite either publication.
      const changedWorker = job.worker && (job.worker.pid !== original.worker?.pid || job.worker.startTime !== original.worker?.startTime);
      if (!result.accepted && record?.state === "reserved" && !TERMINAL_STATES.has(job.state) && !changedWorker) {
        writeJob(jobDir, { ...job, state: original.state, worker: original.worker });
      }
      if (record?.state === "reserved" && result.accepted) writeJob(jobDir, { ...job,
        automaticResumes: job.automaticResumes.map(entry => entry.id === record.id ? { ...entry, state: "launched" } : entry) });
    } finally { releaseLeaseToConsumer(jobDir, me, env, { spawn: false }); }
  }
  return result.accepted;
}

// One automatic recovery per user-work epoch, shared by worker and app-server deaths.
export const DEFAULT_RESUME_MESSAGE = "Your session was cut off. Continue the task from where you stopped, then write the final report.";

export function recoveryForEpoch(job) {
  const epoch = job.recoveryEpoch ?? "start";
  const record = (job.automaticResumes ?? []).find(entry => entry.epoch === epoch);
  // Worker-owned history proves that a reservation was taken without a launcher
  // overwriting job.json while the worker held it. Preserve the single retry epoch.
  if (record?.state === "reserved" && ((job.attempts ?? []).some(a => a.messageId === record.id) ||
      (record.fromWorkerCount != null && (job.workers?.length ?? 0) > record.fromWorkerCount))) return { ...record, state: "launched" };
  return record;
}
