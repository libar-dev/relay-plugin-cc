// Relay wait owns automatic recovery. Take the worker lease before reserving the one
// retry, so concurrent waits cannot write job.json or launch two recovery messages.
import process from "node:process";
import { releaseLeaseToConsumer, spawnWorker } from "./delivery.mjs";
import { acquireWorkerLease, isWorkerAlive } from "../jobs/lease.mjs";
import { computeJobView } from "../jobs/view.mjs";
import { hasOpenCancel, messageExists, newMessageId, postInboxMessage } from "../jobs/messages.mjs";
import { nowIso, readJob, writeJob } from "../jobs/store.mjs";
import { listProcesses, readProcessStartTime, snapshotProcessTree, stopProcessSnapshot } from "../util/process.mjs";

// Every app-server recorded on the job (the live one in `server` and each attempt's
// `servers`) that has no `endedAt` and still runs as the same process (pid and start time).
function liveRecordedAppServers(job) {
  const live = new Map();
  for (const server of [job?.server, ...(job?.attempts ?? []).flatMap((attempt) => attempt?.servers ?? [])]) {
    const key = `${server?.pid}:${server?.startTime}`;
    if (server?.pid && !server.endedAt && !live.has(key) && isWorkerAlive(server)) {
      live.set(key, { pid: server.pid, startTime: server.startTime ?? null });
    }
  }
  return [...live.values()];
}

// The sweep: stop those app-servers with every descendant, SIGTERM then SIGKILL. Returns
// the servers found and every process still running after the kill wait. Descendants are
// found in the process table; when it cannot be read, nothing is signalled and every
// server counts as a survivor, with the cause. Each server is then checked by its own
// identity, which needs no table. `options.listProcesses` replaces the table read (tests);
// the other options go to stopProcessSnapshot.
export async function stopRecordedAppServers(job, options = {}) {
  const servers = liveRecordedAppServers(job);
  if (servers.length === 0) {
    return { servers, survivors: [] };
  }
  const table = (options.listProcesses ?? listProcesses)();
  if (!table) {
    return { servers, survivors: servers, cause: "the process table could not be read" };
  }
  const survivors = await stopProcessSnapshot(snapshotProcessTree(servers.map((server) => server.pid), { table }), options);
  for (const server of servers) {
    if (!survivors.some((entry) => entry.pid === server.pid) && isWorkerAlive(server)) {
      survivors.push(server);
    }
  }
  return { servers, survivors, ...(survivors.cause ? { cause: survivors.cause } : {}) };
}

// The patch that records `endedAt` on every swept server that is gone, and clears the live
// identity when it was one of them. A survivor keeps its record open.
export function sweptAppServersPatch(job, { servers, survivors }, at = nowIso()) {
  const same = (a, b) => a?.pid === b.pid && (a?.startTime ?? null) === (b.startTime ?? null);
  const gone = servers.filter((server) => !survivors.some((entry) => entry.pid === server.pid));
  const ended = (server) => server && !server.endedAt && gone.some((entry) => same(server, entry));
  const attempts = (job.attempts ?? []).map((attempt) =>
    attempt?.servers ? { ...attempt, servers: attempt.servers.map((server) => (ended(server) ? { ...server, endedAt: at } : server)) } : attempt
  );
  const live = ended(job.server);
  return { attempts, ...(live ? { server: null, serverPid: null } : {}) };
}

export async function resumeDeadJobOnce(jobDir, env = process.env) {
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  if (!acquireWorkerLease(jobDir, me, "recovery")) return "busy";
  let launch = false;
  let cancelOpen = false;
  let cwd;
  try {
    let job = readJob(jobDir);
    if (computeJobView(job).state !== "dead" || (job.kind && job.kind !== "task")) return false;
    cancelOpen = hasOpenCancel(jobDir, job);
    if (cancelOpen) return false;
    const epoch = job.recoveryEpoch ?? "start";
    const previous = recoveryForEpoch(job);
    // A reservation interrupted before posting is repaired with the same message id.
    const sweep = await stopRecordedAppServers(job);
    if (sweep.survivors.length) throw new Error(`Could not stop the dead job's processes: ${sweep.survivors.map(entry => entry.pid).join(", ")}${sweep.cause ? ` (${sweep.cause})` : ""}`);
    job = readJob(jobDir);
    if (sweep.servers.length) job = { ...job, ...sweptAppServersPatch(job, sweep) };
    if (previous && previous.state !== "reserved") {
      writeJob(jobDir, { ...job, server: null, serverPid: null });
      return false;
    }
    const record = previous ?? { id: newMessageId(), epoch, at: nowIso(), fromAttempt: job.attempts?.length ?? 0, reason: "worker", state: "reserved" };
    const records = previous ? job.automaticResumes : [...(job.automaticResumes ?? []), record];
    writeJob(jobDir, { ...job, automaticResumes: records });
    if (!messageExists(jobDir, record.id)) {
      postInboxMessage(jobDir, { id: record.id, kind: "resume", text: DEFAULT_RESUME_MESSAGE, isDefault: true, automatic: true });
    }
    writeJob(jobDir, {
      ...job, automaticResumes: records.map(entry => entry.id === record.id ? { ...entry, state: "launched" } : entry),
      state: "starting", worker: null, server: null, serverPid: null, launchPendingAt: nowIso()
    });
    cwd = job.request.cwd;
    launch = true;
  } finally {
    // An open cancel must finish without a replacement worker; other arrivals need a consumer.
    releaseLeaseToConsumer(jobDir, me, env, { spawn: !launch && !cancelOpen });
  }
  if (launch) spawnWorker(jobDir, cwd, env);
  return launch;
}

// One automatic recovery per user-work epoch, shared by worker and app-server deaths.
export const DEFAULT_RESUME_MESSAGE = "Your session was cut off. Continue the task from where you stopped, then write the final report.";

export function recoveryForEpoch(job) {
  const epoch = job.recoveryEpoch ?? "start";
  return (job.automaticResumes ?? []).find(entry => entry.epoch === epoch);
}
