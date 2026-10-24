/** @typedef {Array<{ pid: number, startTime: string | null, identityUnknown?: boolean }> & { cause?: string, unverified?: number }} ProcessSnapshot */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { acquireOwnership, releaseOwnership } from "./ownership.mjs";
import { readJsonOrNull, writeJsonAtomic } from "./fs.mjs";

// A dedicated user scope contains all tools, including children that change sessions.
// Scope availability is cached; hosts without a user manager use identity-based tracking.
/** @type {boolean | null} */
let userScopeWorks = null;

export function inOwnUserScope(command, args, { env = process.env, platform = process.platform, cgroup = null, probe = null, description = null } = {}) {
  if (platform !== "linux" || env.RELAY_WORKER_SCOPE === "off") return { command, args };
  if (probe) {
    if (!probe()) return { command, args };
  } else {
    if (userScopeWorks === null) {
      const result = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--slice=relay-jobs.slice", "--", "true"], { env, stdio: "ignore", timeout: 5000 });
      userScopeWorks = !result.error && result.status === 0;
    }
    if (!userScopeWorks) return { command, args };
  }
  return {
    command: "systemd-run",
    args: ["--user", "--scope", "--quiet", "--collect", "--slice=relay-jobs.slice", ...(description ? [`--description=${description}`] : []), "--", command, ...args]
  };
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);

  const ownsPid = () => !options.identity || (options.identity.pid === pid && options.identity.startTime &&
    isProcessIdentityAlive(options.identity, options) && readProcessStartTime(pid, options) === options.identity.startTime);
  if (!ownsPid()) return { attempted: false, delivered: false, method: null };

  const signal = options.signal ?? "SIGTERM";
  options.beforeSignal?.();
  try {
    killImpl(-(options.identity?.pgid ?? pid), signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    // The group kill fails with ESRCH when the pid is alive but does not lead its own
    // process group, for example a companion started in the foreground of a shell
    // Signal the pid itself in that case. Recheck ownership: the leader may have
    // exited and its pid may have been reused since the group signal failed.
    if (!ownsPid()) return { attempted: true, delivered: false, method: "process-group" };
    options.beforeSignal?.();
    try {
      killImpl(pid, signal);
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// The state and start time of a process, or null when it cannot be read. The start time
// tells a live worker from an unrelated process that reused its pid; the state tells a
// zombie, which still answers kill(pid, 0), from a live process.
function readProcessInfo(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { zombie: fields[0] === "Z", ppid: Number(fields[1]), pgid: Number(fields[2]), startTime: fields[19] ? `linux:${fields[19]}` : null };
    } catch {
      return null;
    }
  }
  const result = runCommand("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const text = result.stdout.trim().replace(/\s+/g, " ");
  if (result.status !== 0 || !text) {
    return null;
  }
  const space = text.indexOf(" ");
  const stat = space === -1 ? text : text.slice(0, space);
  const lstart = space === -1 ? "" : text.slice(space + 1);
  return { zombie: stat.startsWith("Z"), startTime: lstart ? `ps:${lstart}` : null };
}

export function readProcessStartTime(pid, options = {}) {
  return readProcessInfo(pid, options)?.startTime ?? null;
}

// Is a recorded process (pid and start time) still that process? A zombie is not, and
// neither is an unrelated process that reused the pid.
export function isProcessIdentityAlive(identity, options = {}) {
  if (!identity?.pid || !isProcessAlive(identity.pid, options)) {
    return false;
  }
  const info = readProcessInfo(identity.pid, options);
  if (info?.zombie) {
    return false;
  }
  return !(identity.startTime && info?.startTime && info.startTime !== identity.startTime);
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

// Every process with its parent, process group and start time, or null where `ps` is
// unavailable or the table cannot be read.
export function listProcesses(options = {}) {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,rss=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  if (result.error || result.status !== 0) {
    return null;
  }
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    // ps includes itself in its output. On macOS there is no later /proc identity read
    // to discard that already-exited helper; retaining it invents a survivor on every sweep.
    if (pid === result.pid || !Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    // Use the same identity format as worker records. On Linux, ticks also avoid
    // confusing two processes started within the same second of ps's lstart.
    const info = (options.platform ?? process.platform) === "linux" ? readProcessInfo(pid, options) : null;
    const startTime = (options.platform ?? process.platform) === "linux" ? (info?.startTime ?? null) : `ps:${parts.slice(5, 10).join(" ")}`;
    // A failed identity read does not prove exit. Retain a live, unreadable row
    // as unknown so cleanup can report it without ever signalling it blindly.
    if (!startTime && !isProcessAlive(pid, options)) continue;
    rows.push({ rss: Number(parts[4]) * 1024, startedAtMs: Date.parse(`${parts.slice(5, 10).join(" ")} UTC`), pid, ppid: info?.ppid ?? ppid, pgid: info?.pgid ?? pgid, zombie: info?.zombie ?? parts[3].startsWith("Z"), startTime });
  }
  return rows;
}

// A numeric group can be reused after its original members exit. Require a
// member known to predate the last heartbeat, or a recorded backend identity.
/** @returns {ProcessSnapshot} */
export function groupSurvivors(leader, table, { aliveUntil = null, servers = [] } = {}) {
  if (!table) return Object.assign([], { cause: "the process table could not be read" });
  if (!Number.isInteger(leader?.pid) || leader.pid <= 0 || !leader.startTime) return [];
  const current = table.find(row => row.pid === leader.pid);
  if (current?.startTime && current.startTime !== leader.startTime) return [];
  const startedAt = (value) => {
    if (value?.startsWith("linux:")) {
      const ticks = value.slice(6);
      return /^\d+$/.test(ticks) ? BigInt(ticks) : null;
    }
    if (value?.startsWith("ps:")) {
      const ms = Date.parse(`${value.slice(3)} UTC`);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  };
  const start = startedAt(leader.startTime);
  if (start === null) return [];
  const group = table.filter(row => row.pgid === (leader.pgid ?? leader.pid) && row.pid !== process.pid && !row.zombie);
  const members = group.filter(row => {
    const at = startedAt(row.startTime);
    return row.startTime?.split(":", 1)[0] === leader.startTime.split(":", 1)[0] && at !== null && at >= start;
  });
  const bound = aliveUntil == null ? NaN : Date.parse(aliveUntil);
  const verified = (current && !current.zombie && current.startTime === leader.startTime) || members.some(row => {
    const ms = row.startedAtMs ?? (row.startTime?.startsWith("ps:") ? startedAt(row.startTime) : NaN);
    return (Number.isFinite(bound) && Number.isFinite(ms) && ms <= bound - 1000) ||
      servers.some(server => server?.startTime && server.pid === row.pid && server.startTime === row.startTime);
  });
  const unknown = group.filter(row => !row.startTime);
  const snapshot = (verified ? [...members, ...unknown] : []).map(({ pid, startTime }) => ({ pid, startTime }));
  return verified || group.length === 0 ? snapshot : Object.assign(snapshot, { unverified: members.length + unknown.length });
}

// The given roots and all their descendants, each with its start time, so a later kill
// never hits an unrelated process that reused a pid. A descendant that left its parent's
// process group (setsid, detached spawn) is still found through its parent link.
/** @returns {ProcessSnapshot} */
export function snapshotProcessTree(rootPids, options = {}) {
  const table = options.table ?? listProcesses(options);
  if (!table) {
    /** @type {Array<{pid: number, startTime: string | null}> & {cause?: string}} */
    const snapshot = [];
    snapshot.cause = "the process table could not be read";
    return snapshot;
  }
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) {
      children.set(row.ppid, []);
    }
    children.get(row.ppid).push(row);
  }
  const seen = new Map();
  const stack = rootPids.filter((pid) => byPid.has(pid)).map((pid) => byPid.get(pid));
  while (stack.length > 0) {
    const row = stack.pop();
    if (seen.has(row.pid) || row.pid === process.pid || options.excludePids?.has(row.pid)) {
      continue;
    }
    seen.set(row.pid, { pid: row.pid, startTime: row.startTime });
    for (const child of children.get(row.pid) ?? []) {
      stack.push(child);
    }
  }
  return [...seen.values()];
}

// Members of a snapshot that still run: same pid, same start time, not a zombie.
export function liveSnapshotMembers(snapshot, options = {}) {
  const table = options.table ?? (options.listProcesses ?? listProcesses)(options);
  if (!table) {
    // A failed read proves nothing gone.
    return [...snapshot];
  }
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const knownPids = new Set(snapshot.filter(entry => entry.startTime).map(entry => entry.pid));
  const remaining = snapshot.filter(entry => entry.startTime || !knownPids.has(entry.pid)).flatMap((entry) => {
    const row = byPid.get(entry.pid);
    if (!row || row.zombie) return [];
    if (!entry.startTime || !row.startTime) return [{ ...entry, identityUnknown: true }];
    if (row.startTime !== entry.startTime) return [];
    const { identityUnknown, ...verified } = entry;
    return [verified];
  });
  if (remaining.some(entry => entry.identityUnknown)) remaining.cause = "process identities could not be read";
  return remaining;
}

// Stop every live member of a snapshot: SIGTERM, then SIGKILL after `graceMs`.
// Returns the members still running at the end (empty on success). If identity checks
// become unavailable, returns the whole snapshot with a cause for the caller to report.
/** @returns {Promise<ProcessSnapshot>} */
export async function stopProcessSnapshot(snapshot, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const graceMs = options.graceMs ?? 2000;
  let tableUnreadable = false;
  const members = () => {
    if (tableUnreadable) return [...snapshot];
    const table = (options.listProcesses ?? listProcesses)(options);
    if (!table) {
      tableUnreadable = true;
      return [...snapshot];
    }
    return liveSnapshotMembers(snapshot, { ...options, table });
  };
  const survivors = () => {
    const remaining = tableUnreadable ? [...snapshot] : members();
    if (tableUnreadable) remaining.cause = "the process table could not be read";
    return remaining;
  };
  const signalAll = (signal) => {
    const live = members();
    for (const entry of live) {
      if (tableUnreadable || entry.identityUnknown || !entry.startTime) continue;
      if (options.beforeSignal?.(entry, signal) === false) continue;
      try { killImpl(entry.pid, signal); } catch { continue; /* gone already */ }
      options.onSignal?.(entry, signal);
      if (signal === "SIGTERM" && members().some(live => live.pid === entry.pid && live.startTime === entry.startTime && !live.identityUnknown)) {
        try { killImpl(entry.pid, "SIGCONT"); } catch {}
      }
    }
  };
  const waitGone = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const live = members();
      if (live.length === 0) return true;
      if (tableUnreadable) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return members().length === 0;
  };
  signalAll("SIGTERM");
  if (tableUnreadable) return survivors();
  if (await waitGone(graceMs)) return [];
  signalAll("SIGKILL");
  if (!tableUnreadable) await waitGone(2000);
  return survivors();
}

// End what is left of a process group a check started (setup's commands and app-servers, the
// stop gate's probes). Only for a group this process created with a detached spawn; a group
// that is gone already is no error.
export function endProcessGroup(pid, { killImpl = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// A command under a time limit, in its own process group. The group is ended when the
// command exits, fails or runs out of time, so nothing a wrapper started outlives the check.
// A process that left the group and still holds the pipes is not waited for.
export function runLimited(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    // The group goes at once; pipes a process outside it still holds are dropped shortly after.
    const release = (result) => {
      endProcessGroup(child.pid);
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(result);
      }, 200);
    };
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      finish({ status: null, signal: null, error });
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("exit", (status, signal) => {
      if (!timedOut) release({ status, signal, error: null });
    });
    child.on("close", (status, signal) => {
      finish(timedOut ? { status: null, signal: "SIGKILL", error: null } : { status, signal, error: null });
    });
    timer = setTimeout(() => {
      timedOut = true;
      release({ status: null, signal: "SIGKILL", error: null });
    }, timeoutMs);
  });
}

// The process table is shared across workers. A busy cache lock never gets stolen.
export function readProcessTableCached({ home = null, maxAgeMs = 5000, now = Date.now(), list = listProcesses } = {}) {
  if (!home) return list();
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, ".ps-table.json");
  const cached = readJsonOrNull(file);
  if (cached && now >= cached.at && now - cached.at < maxAgeMs) return cached.rows;
  const lock = `${file}.lock`;
  if (!acquireOwnership(lock)) {
    if (maxAgeMs > 0 && cached && now >= cached.at && now - cached.at < 2 * maxAgeMs) return cached.rows;
    return list();
  }
  try {
    const rows = list();
    if (rows) writeJsonAtomic(file, { at: now, rows });
    return rows;
  } finally { releaseOwnership(lock); }
}

export function ownExecution(me, { platform = process.platform, workerRegistry = null } = {}) {
  let cgroup = null, cgroupId = null, bootId = null;
  if (platform === "linux") {
    try {
      const unified = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3).trim();
      if (unified?.includes("/relay-jobs.slice/") && unified.endsWith(".scope")) {
        cgroupId = fs.statSync(path.join("/sys/fs/cgroup", unified)).ino;
        bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        cgroup = unified;
      }
    } catch {}
  }
  return { pgid: me.pid, leader: { pid: me.pid, startTime: me.startTime }, platform, cgroup, cgroupId, bootId, workerRegistry, startedAt: me.startedAt ?? new Date().toISOString() };
}

function executions(job) {
  const entries = [...(job?.executions ?? []), job?.execution].filter(Boolean);
  if (!entries.length && job?.worker) entries.push({ leader: job.worker, pgid: job.worker.pgid ?? job.worker.pid });
  return [...new Map(entries.map(e => [`${e.leader?.pid}:${e.leader?.startTime}`, e])).values()];
}
function roots(job) {
  return [job?.server, ...(job?.attempts ?? []).flatMap(a => a.servers ?? [])].filter(Boolean);
}
function cgroupFile(execution, name) {
  const group = execution.cgroup;
  // Only relay scopes, never an ancestor or a caller-supplied arbitrary filesystem path.
  if (!group?.startsWith("/") || group.split("/").includes("..") || !group.includes("/relay-jobs.slice/") || !/^run-[a-zA-Z0-9_-]+\.scope$/.test(group.split("/").at(-1))) return null;
  try {
    if (!execution.bootId || !execution.cgroupId ||
        execution.bootId !== fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
        execution.cgroupId !== fs.statSync(path.join("/sys/fs/cgroup", group)).ino) return null;
  } catch { return null; }
  return path.join("/sys/fs/cgroup", group, name);
}

function scopeMemberStarted(row, execution) {
  // Linux identities have tick precision; ps's wall-clock time is rounded to a second.
  const leader = execution.leader?.startTime;
  if (/^linux:\d+$/.test(leader ?? "") && /^linux:\d+$/.test(row.startTime ?? ""))
    return BigInt(row.startTime.slice(6)) >= BigInt(leader.slice(6));
  const start = Date.parse(execution.startedAt);
  return !row.startTime || !Number.isFinite(start) || row.startedAtMs >= Math.floor(start / 1000) * 1000;
}

// Independent of admission storage, including when the guard is explicitly off.
export const independentWorkerRegistry = () => path.join("/tmp", `relay-workers-${process.getuid?.() ?? "user"}`);

// Published workers form ownership boundaries, including during a nested launch handoff.
function foreignWorkerPids(job, table) {
  const excluded = new Set();
  for (const directory of new Set([independentWorkerRegistry(), ...executions(job).map(e => e.workerRegistry).filter(Boolean)])) {
    // Lookup only current process ids. Historical crash records cannot increase
    // sampling work, and a newly published nested worker is visible immediately.
    for (const row of table) {
      const worker = readJsonOrNull(path.join(directory, `${row.pid}.json`));
      if (worker?.jobDir !== job.jobDir && worker?.startTime &&
          row.startTime === worker.startTime && !row.zombie) excluded.add(row.pid);
    }
  }
  // Never walk through another job's worker to capture its backend or tools either.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of table) if (excluded.has(row.ppid) && !excluded.has(row.pid)) { excluded.add(row.pid); changed = true; }
  }
  return excluded;
}

function verifiedRoots(entries, table, excluded) {
  return entries.filter(root => root.startTime && !excluded.has(root.pid) && table.some(row =>
    row.pid === root.pid && row.startTime === root.startTime && !row.zombie));
}

// Cancellation also snapshots the worker tree. Apply the same identity and nested-job
// boundaries as registry sampling, rather than authorizing traversal by a numeric root alone.
export function snapshotExecutionTree(job, rootPids, table = listProcesses()) {
  if (!table) return Object.assign([], { cause: "the process table could not be read" });
  const excluded = foreignWorkerPids(job, table);
  const valid = verifiedRoots([job.worker, ...roots(job)].filter(root => root && rootPids.includes(root.pid)), table, excluded);
  return snapshotProcessTree(valid.map(root => root.pid), { table, excludePids: excluded });
}

// Prune dead identities on every sample, retaining escaped descendants by identity.
export function sampleExecution(job, jobDir, table) {
  if (!table) return readJsonOrNull(path.join(jobDir, "processes.json"))?.members ?? [];
  if (job.execution?.platform && !["linux", "darwin"].includes(job.execution.platform)) return [];
  const file = path.join(jobDir, "processes.json");
  const old = readJsonOrNull(file)?.members ?? [];
  const excluded = foreignWorkerPids(job, table);
  const validRoots = verifiedRoots([...roots(job), ...old], table, excluded);
  const candidates = [...old, ...snapshotProcessTree(validRoots.map(r => r.pid), { table, excludePids: excluded })];
  const byPid = new Map(table.map(row => [row.pid, row]));
  const members = [...new Map(candidates.filter(entry => {
    const row = byPid.get(entry.pid);
    return !excluded.has(entry.pid) && row && !row.zombie && entry.startTime && (!row.startTime || row.startTime === entry.startTime);
  }).map(entry => [`${entry.pid}:${entry.startTime}`, { pid: entry.pid, startTime: entry.startTime, firstSeenAt: entry.firstSeenAt ?? new Date().toISOString() }])).values()];
  writeJsonAtomic(file, { members });
  return members;
}

/** @returns {ProcessSnapshot} */
export function executionMembers(job, table, { jobDir = job?.jobDir, excludeSelf = true } = {}) {
  if (job.execution?.platform && !["linux", "darwin"].includes(job.execution.platform)) return [];
  if (!table) return Object.assign([], { cause: "the process table could not be read" });
  const entries = [];
  const excluded = foreignWorkerPids(job, table);
  let cause;
  for (const execution of executions(job)) {
    const file = cgroupFile(execution, "cgroup.procs");
    if (file) {
      try {
        const pids = new Set(fs.readFileSync(file, "utf8").trim().split(/\s+/).map(Number));
        entries.push(...table.filter(row => pids.has(row.pid) && !row.zombie &&
          scopeMemberStarted(row, execution)));
        // Scope membership disproves emptiness even when the process table missed
        // a concurrently forked pid. Never signal it without a verified identity.
        for (const pid of pids) if (pid > 0 && !table.some(row => row.pid === pid)) {
          entries.push({ pid, startTime: null, identityUnknown: true });
          cause = "an execution scope member has no process identity";
        }
      } catch (error) { if (error.code !== "ENOENT") cause = "the execution scope could not be read"; }
    }
    const leader = table.find(row => row.pid === execution.leader?.pid && row.startTime === execution.leader.startTime && !row.zombie);
    if (leader) entries.push(leader);
    entries.push(...groupSurvivors({ ...execution.leader, pgid: execution.pgid }, table, {
      aliveUntil: execution.aliveUntil ?? job.heartbeatAt ?? job.lastEventAt ?? job.startedAt, servers: roots(job)
    }));
  }
  const recorded = jobDir ? readJsonOrNull(path.join(jobDir, "processes.json"))?.members ?? [] : [];
  const knownRoots = verifiedRoots([...roots(job), ...recorded], table, excluded);
  entries.push(...roots(job), ...recorded, ...snapshotProcessTree(knownRoots.map(root => root.pid), { table, excludePids: excluded }));
  const live = [...liveSnapshotMembers(entries, { table }), ...entries.filter(entry => entry.identityUnknown && !entry.startTime && !table.some(row => row.pid === entry.pid))];
  const result = [...new Map(live.filter(entry => !excluded.has(entry.pid) && (!excludeSelf || entry.pid !== process.pid)).map(entry => [`${entry.pid}:${entry.startTime}`, entry])).values()];
  if (cause) Object.assign(result, { cause });
  return result;
}

export function executionBytes(job, table, options = {}) {
  const group = cgroupFile(job.execution ?? {}, "memory.current");
  if (group) { try { return Number(fs.readFileSync(group, "utf8").trim()); } catch {} }
  const members = executionMembers(job, table, { ...options, excludeSelf: false });
  const pids = new Set(members.map(entry => entry.pid));
  return table ? table.filter(row => pids.has(row.pid)).reduce((sum, row) => sum + (row.rss ?? 0), 0) : null;
}

export async function stopExecution(job, options = {}) {
  if (job.execution?.platform && !["linux", "darwin"].includes(job.execution.platform)) return { servers: roots(job), survivors: [] };
  const table = (options.listProcesses ?? listProcesses)();
  const members = executionMembers(job, table, options);
  if (members.cause) return { servers: roots(job), survivors: members.length ? members : roots(job).filter(root => root.pid !== process.pid && isProcessIdentityAlive(root)), cause: members.cause };
  // A nested worker can deliberately inherit this scope when its own scopes are off.
  // In that case only signal verified members individually, preserving the ownership boundary.
  const foreign = foreignWorkerPids(job, table);
  for (const execution of executions(job)) {
    const file = cgroupFile(execution, "cgroup.kill");
    if (file && !isProcessIdentityAlive(execution.leader)) {
      try {
        const pids = fs.readFileSync(cgroupFile(execution, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number);
        if (pids.filter(pid => pid > 0).every(pid => {
          const row = table.find(row => row.pid === pid);
          return row?.startTime && scopeMemberStarted(row, execution) && !foreign.has(pid);
        })) fs.writeFileSync(file, "1");
      } catch {}
    }
  }
  const stopped = await stopProcessSnapshot(members, options);
  // Tools may fork while TERM is being handled. Verify the execution itself again,
  // rather than declaring it empty just because the original snapshot is gone.
  const remaining = executionMembers(job, (options.listProcesses ?? listProcesses)(), options);
  /** @type {ProcessSnapshot} */
  const survivors = [...new Map([...stopped, ...remaining].map(entry => [`${entry.pid}:${entry.startTime}`, entry])).values()];
  if (stopped.cause || remaining.cause) survivors.cause = stopped.cause ?? remaining.cause;
  for (const server of roots(job)) {
    if (server.pid !== process.pid && isProcessIdentityAlive(server) && !survivors.some(p => p.pid === server.pid)) survivors.push(server);
  }
  return { servers: roots(job), survivors, ...(survivors.cause ? { cause: survivors.cause } : {}) };
}
