/** @typedef {Array<{ pid: number, startTime: string | null }> & { cause?: string }} ProcessSnapshot */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

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

  const signal = options.signal ?? "SIGTERM";
  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    // The group kill fails with ESRCH when the pid is alive but does not lead its own
    // process group, for example a companion started in the foreground of a shell
    // Signal the pid itself in that case.
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
      return { zombie: fields[0] === "Z", startTime: fields[19] ? `linux:${fields[19]}` : null };
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
  const result = runCommand("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  if (result.error || result.status !== 0) {
    return null;
  }
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    rows.push({ pid, ppid, pgid, zombie: parts[3].startsWith("Z"), startTime: `ps:${parts.slice(4, 9).join(" ")}` });
  }
  return rows;
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
    if (seen.has(row.pid) || row.pid === process.pid) {
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
  return snapshot.filter((entry) => {
    const row = byPid.get(entry.pid);
    return row && !row.zombie && (!entry.startTime || row.startTime === entry.startTime);
  });
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
      // Pid-only fallback is allowed only for an entry with no saved identity.
      if (tableUnreadable && entry.startTime) continue;
      try { killImpl(entry.pid, signal); } catch { /* gone already */ }
    }
  };
  const waitGone = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (members().length === 0) return true;
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
