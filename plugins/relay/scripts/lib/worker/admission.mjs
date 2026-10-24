// Shared per-user launch admission. Sensor failures skip that sensor; guard failures
// hold new starts with a visible reason. A live lock is never broken or bypassed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { listJobDirs, readJob, readJsonOrNull, writeJsonAtomic, writeJob, TERMINAL_STATES } from "../jobs/store.mjs";
import { pendingInboxMessages } from "../jobs/messages.mjs";
import { acquireOwnership, releaseOwnership, readOwnership } from "../util/ownership.mjs";
import { executionMembers, readProcessTableCached, isProcessAlive, isProcessIdentityAlive, readProcessStartTime } from "../util/process.mjs";

const GiB = 2 ** 30;
// Seats and startup bytes are independent of remote model reasoning cost.
export const DEFAULTS = Object.freeze({
  headroomGiB: 2, headroomFraction: 0.15, reserveMs: 30000,
  startupBytes: Object.freeze({ codex: 0.5 * GiB, grok: 0.5 * GiB, kimi: GiB, zcode: GiB }),
  unknownStartupBytes: GiB, workerBytes: 64 * 2 ** 20,
  maxActive: null, minBusySeats: 2, maxBusySeats: 16, spareCores: 2, guaranteedVeryHeavy: 2, guaranteedOther: 3,
  spacingMs: 5000, scopeMarginGiB: 0.5, scopeMarginFraction: 0.10,
  criticalGiB: 0.75, criticalFraction: 0.05, criticalLoadPerCore: 3, busyLoadPerCore: 1.5,
  minWaitingWorkers: 8, waitingPerBusySeat: 2,
  weights: Object.freeze({ light: 1, medium: 2, "very-heavy": 3 }),
  heavyModel: /astra/i, kimiHeavyModel: /(^|[^a-z0-9])k3([^a-z0-9]|$)/i,
  lightEfforts: ["low", "minimal", "none"], lightModel: /luna|flash|highspeed|-fast$/i,
  pollMs: 3000, claimantPolls: 4, probeMs: 120000, sensorCacheMs: 2000, discoveryMs: 60000,
  sensorStaleMs: 10000, processCacheMs: 60000, spawnGraceMs: 10000, stuckLockMs: 60000,
  pauseExpiryMs: 6 * 3600000, clockSkewMs: 300000,
  usagePauseMs: 30 * 60000, ratePauseMs: 60000, maxRatePauseMs: 15 * 60000,
  concurrencyPauseMs: 10 * 60000, kimiAttempts: "3"
});
// Legacy descriptive metadata only; never used in admission arithmetic.
export const WEIGHTS = DEFAULTS.weights;
export const startupBytes = backend => DEFAULTS.startupBytes[backend] ?? DEFAULTS.unknownStartupBytes;
const backends = ["codex", "grok", "zcode", "kimi"];
const iso = n => new Date(n).toISOString();
const recent = (now, at, duration) => {
  const delta = now - Date.parse(at);
  return delta >= -DEFAULTS.clockSkewMs && delta < duration;
};
export function admissionHome(env = process.env) {
  return path.resolve(env.RELAY_ADMISSION_HOME || path.join(os.homedir(), ".relay-jobs", "admission"));
}
export const admissionConfigPath = (env = process.env) => path.join(admissionHome(env), "config.json");
export function readAdmissionConfig(env = process.env) {
  let stored = null;
  const notes = [];
  try {
    stored = JSON.parse(fs.readFileSync(admissionConfigPath(env), "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("invalid config");
  } catch (e) { if (e.code !== "ENOENT") notes.push(`admission settings unreadable; using defaults (${e.code ?? e.message})`); }
  if (stored && Object.hasOwn(stored, "maxVeryHeavy")) notes.push("maxVeryHeavy is ignored: very heavy jobs have no maximum");
  return { admission: stored?.admission === "off" ? "off" : "on", ...(notes.length ? { notes } : {}) };
}
export function setAdmissionConfig(key, value, env = process.env) {
  const file = admissionConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { notes, ...config } = readAdmissionConfig(env);
  writeJsonAtomic(file, { ...config, [key]: value });
  return readAdmissionConfig(env);
}
export function admissionEnabled(env = process.env, config = undefined, platform = process.platform) {
  if (!["linux", "darwin"].includes(platform) || String(env.RELAY_ADMISSION).toLowerCase() === "off") return false;
  return (config ?? readAdmissionConfig(env)).admission !== "off";
}
export function guardSettings(config = {}, machine = { totalBytes: os.totalmem(), cores: os.availableParallelism() }) {
  const busySeats = Math.min(DEFAULTS.maxBusySeats, Math.max(DEFAULTS.minBusySeats, machine.cores - DEFAULTS.spareCores));
  return { maxActive: DEFAULTS.maxActive, busySeats,
    guaranteedVeryHeavy: DEFAULTS.guaranteedVeryHeavy, guaranteedOther: DEFAULTS.guaranteedOther,
    headroomBytes: Math.max(DEFAULTS.headroomGiB * GiB, machine.totalBytes * DEFAULTS.headroomFraction),
    maxWaitingWorkers: Math.max(DEFAULTS.minWaitingWorkers, DEFAULTS.waitingPerBusySeat * busySeats) };
}
export function validModelClasses(entries) {
  return Array.isArray(entries) ? entries.filter(e => e && typeof e.pattern === "string" && /^[0-9A-Za-z._:/*-]{1,100}$/.test(e.pattern) && Object.hasOwn(WEIGHTS, e.class)) : [];
}
/** @param {{ backend?: string, model?: string | null, effort?: string | null }} request */
export function modelClass({ backend = "codex", model, effort } = {}, overrides = []) {
  const m = model === "default" ? "" : String(model ?? "").toLowerCase();
  const e = String(effort ?? "").toLowerCase();
  if (DEFAULTS.heavyModel.test(m) || (backend === "kimi" && DEFAULTS.kimiHeavyModel.test(m))) return "very-heavy";
  for (const rule of validModelClasses(overrides)) {
    const pattern = rule.pattern.toLowerCase().split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (new RegExp(pattern).test(m)) return rule.class;
  }
  return DEFAULTS.lightEfforts.includes(e) || DEFAULTS.lightModel.test(m) ? "light" : "medium";
}

// A persisted scheduling class is descriptive. Quota eligibility always comes
// from an identified effective selection, including older jobs and slot records.
const isVeryHeavy = request => modelClass(request) === "very-heavy";

// Admission alone uses this bounded batch cache, including ownership and legacy reads.
const processCaches = new Map();
export function holderAlive(identity, { platform = process.platform, now = Date.now(), ps = spawnSync } = {}) {
  if (platform === "win32") return isProcessAlive(identity?.pid);
  if (platform === "linux") return isProcessIdentityAlive({ pid: identity?.pid, startTime: identity?.startTime ?? identity?.processStart });
  if (!identity?.pid || !isProcessAlive(identity.pid)) return false;
  let cache = processCaches.get(platform);
  if (!cache || now - cache.at >= DEFAULTS.processCacheMs || now < cache.at) {
    const result = ps("ps", ["-axo", "pid=,stat=,lstart="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const rows = new Map();
    if (!result.error && result.status === 0) {
      for (const line of result.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        if (match) rows.set(Number(match[1]), { zombie: match[2].startsWith("Z"), startTime: `ps:${match[3].trim().replace(/\s+/g, " ")}` });
      }
    }
    cache = { at: now, rows }; processCaches.set(platform, cache);
  }
  const row = cache.rows.get(identity.pid);
  const start = identity.startTime ?? identity.processStart;
  return !row?.zombie && !(start && row?.startTime && start !== row.startTime);
}
function self(deps) {
  const pid = process.pid;
  // Linux is a file read; other platforms use the same bounded batch as holders.
  let startTime = null;
  if ((deps.platform ?? process.platform) === "linux") startTime = readProcessStartTime(pid);
  else { holderAlive({ pid }, { platform: deps.platform, now: deps.now() }); startTime = processCaches.get(deps.platform ?? process.platform)?.rows.get(pid)?.startTime ?? null; }
  return { pid, startTime };
}
function dependencies(deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  return { env, now, platform: process.platform, readScopes: cgroupAvailable, random: Math.random, scanUnslotted: null, readAdmissionConfig, readMachine: readMachineDefault, writeSlot, notes: [],
    lockSleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    isAlive: identity => holderAlive(identity, { platform: deps.platform, now: now() }), ...deps };
}
function lock(home, deps, fn) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "admission.lock");
  if (!acquireOwnership(file, { ...self(deps), since: iso(deps.now()) }, { isAlive: deps.isAlive })) return { locked: false, holder: readOwnership(file, { isAlive: deps.isAlive }) };
  try { return { locked: true, value: fn() }; }
  finally { releaseOwnership(file); }
}
// CLI spawns and rare pause updates can tolerate a short bounded wait. Worker
// admission keeps its cancellable poll instead of blocking here.
function retryLock(home, deps, fn) {
  let result = lock(home, deps, fn);
  for (let retry = 0; !result.locked && retry < 10; retry++) {
    deps.lockSleep(25 + Math.floor(50 * deps.random()));
    result = lock(home, deps, fn);
  }
  return result;
}
export function wasAdmitted(job) {
  return Boolean(job?.firstAdmittedAt || job?.admission?.admittedAt || job?.attempts?.some(a => a.admission?.admittedAt));
}
// The cache key includes the worker's cgroup: one unlimited scope must never
// lend its reading to a memory-limited sibling. The proc identity is cached locally.
const cgroupIdentities = new WeakMap();
function cgroupIdentity(home, now, readFile) {
  let cache = cgroupIdentities.get(readFile);
  if (!cache) { cache = new Map(); cgroupIdentities.set(readFile, cache); }
  const old = cache.get(home);
  if (old && now >= old.at && now - old.at < DEFAULTS.sensorCacheMs) return old;
  let group = null, note = null;
  try {
    const text = readFile("/proc/self/cgroup", "utf8");
    group = /^0::(\/.*)$/m.exec(text)?.[1]?.trim();
    if (!group || group.split("/").includes("..")) throw new Error("unified cgroup unavailable");
    group = path.posix.normalize(group);
  } catch (e) { group = null; note = `readings unavailable: cgroup identity not read (${e.code ?? e.message})`; }
  const value = { at: now, group, note }; cache.set(home, value); return value;
}
export function cgroupAvailable(group, readFile = fs.readFileSync) {
  const scopes = [], notes = [];
  for (let current = group; current; current = current === "/" ? null : path.posix.dirname(current)) {
    try {
      const dir = path.join("/sys/fs/cgroup", current);
      let limit;
      try { limit = readFile(path.join(dir, "memory.max"), "utf8").trim(); }
      catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (limit === "max") continue;
      const used = readFile(path.join(dir, "memory.current"), "utf8").trim();
      if (!/^\d+$/.test(limit) || !/^\d+$/.test(used) || !Number.isSafeInteger(Number(limit)) || !Number.isSafeInteger(Number(used))) throw new Error("invalid reading");
      scopes.push({ id: current, limitBytes: Number(limit), currentBytes: Number(used), remainingBytes: Math.max(0, Number(limit) - Number(used)) });
    } catch (e) {
      const note = `readings unavailable: cgroup memory not read (${e.code ?? e.message})`;
      if (!notes.includes(note)) notes.push(note);
    }
  }
  return { scopes, notes };
}
export function parseVmStat(text) {
  const page = /page size of (\d+) bytes/.exec(text);
  const free = /^Pages free:\s+(\d+)\.\s*$/m.exec(text);
  const inactive = /^Pages inactive:\s+(\d+)\.\s*$/m.exec(text);
  if (!page || !free || !inactive || !Number(page[1])) throw new Error("invalid vm_stat reading");
  const bytes = (Number(free[1]) + Number(inactive[1])) * Number(page[1]);
  if (!Number.isSafeInteger(bytes)) throw new Error("invalid vm_stat bytes");
  return bytes;
}
export function readMachineDefault({ home = admissionHome(), platform = process.platform, now = Date.now(), env = process.env, sensor = os, sysctl = spawnSync, readFile = fs.readFileSync } = {}) {
  if (!["linux", "darwin"].includes(platform)) return { totalBytes: null, cores: 1, availableBytes: null, load5: null, scopes: [], notes: ["admission unavailable on this platform"] };
  // Explicit synthetic subprocess fixtures keep integration tests independent of the host.
  if (env.NODE_TEST_CONTEXT && env.RELAY_TEST_ADMISSION_READINGS) {
    const fixture = readJsonOrNull(env.RELAY_TEST_ADMISSION_READINGS);
    if (!fixture) throw new Error("invalid admission readings");
    return { scopes: [], notes: [], ...fixture };
  }
  const notes = [];
  const read = (name, fn, positiveOnly = false) => {
    try { const n = fn(); if (!Number.isFinite(n) || n < 0 || (positiveOnly && n === 0)) throw new Error("invalid reading"); return n; }
    catch (e) { notes.push(`readings unavailable: ${name} not read (${e.message})`); return null; }
  };
  const totalBytes = read("total memory", () => sensor.totalmem(), true);
  const cores = read("cores", () => sensor.availableParallelism(), true) ?? 1;
  const hostCores = sensor.cpus?.().length;
  const loadScopeMismatch = Boolean(hostCores && hostCores !== cores);
  const load5 = loadScopeMismatch ? null : read("load", () => sensor.loadavg()[1]);
  if (loadScopeMismatch) notes.push("readings unavailable: five-minute load skipped (host and available CPU scopes differ)");
  const identity = platform === "linux" ? cgroupIdentity(home, now, readFile) : null;
  if (identity?.note) notes.push(identity.note);
  const cacheKey = platform === "linux" ? `linux-${createHash("sha256").update(identity.group ?? "unavailable").digest("hex").slice(0, 16)}` : platform;
  const readMemory = () => {
    const before = notes.length;
    let availableBytes = null, pressure = null, source = null, quality = "unavailable";
    const scopes = identity?.group ? cgroupAvailable(identity.group, readFile) : { scopes: [], notes: [] };
    notes.push(...scopes.notes);
    if (platform === "darwin") {
      const command = (bin, args) => {
        const r = sysctl(bin, args, { timeout: 1000, maxBuffer: 64 * 1024, encoding: "utf8" });
        if (r.error || r.status !== 0) throw new Error(`${path.basename(bin)} failed`);
        return String(r.stdout ?? "");
      };
      availableBytes = read("memory", () => {
        const value = command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"]).trim();
        if (!/^\d+$/.test(value) || Number(value) > 100) throw new Error("invalid memory percentage");
        if (totalBytes === null) throw new Error("total memory unavailable");
        return totalBytes * Number(value) / 100;
      });
      source = "kern.memorystatus_level"; quality = "estimate";
      if (availableBytes === null) {
        availableBytes = read("memory fallback", () => parseVmStat(command("/usr/bin/vm_stat", [])));
        source = "vm_stat free+inactive fallback"; quality = "heuristic";
        notes.push(availableBytes === null ? "vm_stat free+inactive fallback also failed" : "using vm_stat free+inactive fallback");
      }
      pressure = read("memory pressure", () => {
        const value = command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).trim();
        if (!/^[124]$/.test(value) && !/^[3567]$/.test(value)) throw new Error("invalid pressure bits");
        return Number(value);
      });
    } else {
      availableBytes = read("MemAvailable", () => {
        const text = readFile("/proc/meminfo", "utf8");
        if (text.length > 64 * 1024) throw new Error("meminfo too large");
        const match = /^MemAvailable:\s+(\d+) kB\s*$/m.exec(text);
        if (!match || !Number.isSafeInteger(Number(match[1]) * 1024)) throw new Error("invalid MemAvailable");
        return Number(match[1]) * 1024;
      });
      source = "Linux MemAvailable"; quality = "estimate";
      if (availableBytes === null) {
        availableBytes = read("memory fallback", () => sensor.freemem());
        source = "Node >=22 freemem fallback";
        notes.push("using Node >=22 available-memory fallback");
      }
    }
    return { availableBytes, pressure, source, quality: availableBytes === null ? "unavailable" : quality, scopes: scopes.scopes, group: identity?.group ?? null, sampledAt: iso(now), notes: notes.slice(before) };
  };
  const file = path.join(home, `.machine-${cacheKey}.json`), cached = readJsonOrNull(file);
  const validBytes = n => n === null || (Number.isFinite(n) && n >= 0 && n <= totalBytes);
  const cacheValid = cached && typeof cached.source === "string" && Array.isArray(cached.scopes) && Array.isArray(cached.notes) && cached.notes.every(n => typeof n === "string") && validBytes(cached.availableBytes);
  let memory;
  if (cacheValid && now >= cached.at && now - cached.at < DEFAULTS.sensorCacheMs) {
    memory = cached; notes.push(...cached.notes);
  } else {
    let owns = false;
    const owner = path.join(home, `machine-${cacheKey}.lock`);
    try {
      fs.mkdirSync(home, { recursive: true });
      owns = Boolean(acquireOwnership(owner, self({ platform, now: () => now }), { isAlive: identity => holderAlive(identity, { platform, now }) }));
      if (!owns) {
        if (cacheValid && now >= cached.at && now - cached.at < DEFAULTS.sensorStaleMs) {
          memory = cached; notes.push(...cached.notes);
        } else memory = { availableBytes: null, pressure: null, scopes: [], group: identity?.group ?? null, source: null, quality: "refreshing", refreshing: true };
      }
      else {
        memory = readMemory();
        try { writeJsonAtomic(file, { at: now, ...memory }); }
        catch (e) { notes.push(`readings unavailable: memory cache not written (${e.code ?? e.message})`); }
      }
    } catch (e) {
      notes.push(`readings unavailable: memory cache not accessible (${e.code ?? e.message})`);
      memory = readMemory();
    } finally {
      if (owns) try { releaseOwnership(owner); }
      catch (e) { notes.push(`readings unavailable: memory cache release failed (${e.code ?? e.message})`); }
    }
  }
  return { ...memory, totalBytes, cores, load5, notes };
}
function machineReading(home, deps) {
  const m = deps.readMachine({ home, env: deps.env, now: deps.now(), platform: deps.platform });
  const valid = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const notes = (Array.isArray(m.notes) ? m.notes : []).filter(n => typeof n === "string");
  for (const [key, label] of [["availableBytes", "memory"], ["load5", "load"]]) {
    if (m[key] !== null && !valid(m[key])) notes.push(`readings unavailable: ${label} not read (invalid reading)`);
  }
  return { ...m, scopes: m.scopes ?? [], group: m.group ?? null, availableBytes: valid(m.availableBytes) ? m.availableBytes : null, load5: valid(m.load5) ? m.load5 : null,
    totalBytes: valid(m.totalBytes) && m.totalBytes > 0 ? m.totalBytes : os.totalmem(), cores: valid(m.cores) && m.cores > 0 ? m.cores : os.availableParallelism(), notes };
}
export function machineState(machine, pendingBytes = 0) {
  const { totalBytes: t, availableBytes: a, load5: l, cores: c } = machine;
  const effective = a === null ? null : a - pendingBytes;
  if (effective !== null && effective < Math.max(DEFAULTS.criticalGiB * GiB, t * DEFAULTS.criticalFraction)) return { state: "critical", detail: "machine critical: memory low", holdsTurns: true };
  if (machine.pressure & 4) return { state: "critical", detail: "memory pressure critical: waiting for pressure to recover", holdsTurns: true };
  if (l !== null && l > DEFAULTS.criticalLoadPerCore * c) return { state: "critical", detail: `machine critical: 5-minute load ${l.toFixed(1)} on ${c} cores`, holdsTurns: false };
  if (machine.pressure & 2) return { state: "warning", detail: "memory pressure warning (not holding)", holdsTurns: false };
  if (a === null && l === null) return { state: "unknown", detail: "machine readings unavailable" };
  const busy = l !== null && l >= DEFAULTS.busyLoadPerCore * c;
  return { state: busy ? "busy" : a === null ? "unknown" : "healthy", detail: null };
}
function files(dir) { try { return fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
function slotFile(home, id) { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid job id"); return path.join(home, "slots", `${id}.json`); }
function writeSlot(home, slot) { fs.mkdirSync(path.join(home, "slots"), { recursive: true }); writeJsonAtomic(slotFile(home, slot.jobId), slot); }
export function executionAlive(job, deps) {
  if (job?.execution || job?.worker) {
    const members = executionMembers(job, readProcessTableCached({ home: admissionHome(deps.env), maxAgeMs: deps.freshExecution ? 0 : 5000 }), { jobDir: job.jobDir });
    if (members.cause || members.some(p => p.pid !== job.worker?.pid)) return true;
  }
  return [job?.server, ...(job?.attempts ?? []).flatMap(a => a.servers ?? [])].some(s => s?.pid && !s.endedAt && deps.isAlive(s));
}
function quarantine(file, now, note, deps) {
  const dir = path.join(path.dirname(file), "quarantine");
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(file, path.join(dir, `${path.basename(file)}.${now}`));
  deps.notes.push(note);
}
function slots(home, deps, clean = true) {
  if (clean) for (const name of files(path.join(home, "pauses"))) {
    if (!name.endsWith(".tmp")) continue;
    const file = path.join(home, "pauses", name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && deps.now() - stat.mtimeMs > 60000) fs.rmSync(file, { force: true });
  }
  const result = [];
  for (const name of files(path.join(home, "slots"))) {
    const file = path.join(home, "slots", name);
    if (name.endsWith(".tmp")) { if (clean && deps.now() - fs.statSync(file).mtimeMs > 60000) fs.rmSync(file, { force: true }); continue; }
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const s = readJsonOrNull(file);
    if (!s || s.v !== 1 || typeof s.jobDir !== "string" || s.jobId !== name.slice(0, -5) || !Object.hasOwn(WEIGHTS, s.class) || !["waiting", "running", "spawning"].includes(s.state) ||
      typeof s.backend !== "string" || !Number.isFinite(Date.parse(s.since)) ||
      (s.state !== "spawning" && (!Number.isInteger(s.pid) || s.pid <= 0)) ||
      (s.holdBytes != null && (!Number.isFinite(s.holdBytes) || s.holdBytes < 0)) ||
      [s.holdAt, s.admittedAt, s.spawnAt].some(at => at != null && !Number.isFinite(Date.parse(at)))) {
      const at = fs.statSync(file).mtimeMs, now = deps.now();
      if (now - at >= 10 * 60000) {
        if (clean) quarantine(file, now, `slot record ${name} was unreadable; quarantined`, deps);
        continue;
      }
      result.push({ jobId: name.slice(0, -5), state: "running", damaged: true,
        holdAt: iso(at > now + DEFAULTS.clockSkewMs ? now : at), holdBytes: DEFAULTS.unknownStartupBytes });
      continue;
    }
    const holdAt = s.holdAt ?? s.admittedAt ?? s.spawnAt;
    if (Date.parse(holdAt) > deps.now() + DEFAULTS.clockSkewMs) {
      s.holdAt = iso(deps.now());
      if (clean) deps.writeSlot(home, s);
    }
    const live = (s.state === "spawning" && recent(deps.now(), s.since, DEFAULTS.spawnGraceMs)) || deps.isAlive({ pid: s.pid, startTime: s.processStart });
    const job = readJob(s.jobDir);
    s.quotaHeavy = isVeryHeavy({ backend: s.backend, model: s.model, effort: s.effort }) || isVeryHeavy(job?.request);
    s.weight = WEIGHTS[s.class];
    const backendLive = executionAlive({ ...job, jobDir: s.jobDir }, deps);
    if (live || backendLive) result.push(!live && backendLive ? { ...s, state: "running" } : s);
    else if (clean) fs.rmSync(file, { force: true });
  }
  return result;
}
const discovered = new Map();
function directories(env, now) {
  const key = env.RELAY_JOBS_HOME ?? "default";
  let cached = discovered.get(key);
  if (!cached || now < cached.at || now - cached.at >= DEFAULTS.discoveryMs) {
    cached = { at: now, dirs: listJobDirs({ env }), jobs: cached?.jobs ?? new Map() };
    const retained = new Set(cached.dirs);
    for (const dir of cached.jobs.keys()) if (!retained.has(dir)) cached.jobs.delete(dir);
    discovered.set(key, cached);
  }
  return cached.dirs;
}
// Historical records are parsed only when their atomic file identity changes.
// Discovery/stat/parse work happens before taking the admission lock. Potentially
// live jobs are read again under the lock, then checked against current slots.
function legacyCandidates(deps) {
  if (deps.scanUnslotted) return deps.scanUnslotted();
  const dirs = directories(deps.env, deps.now());
  const cache = discovered.get(deps.env.RELAY_JOBS_HOME ?? "default").jobs;
  return dirs.filter(dir => {
    let stat;
    try { stat = fs.statSync(path.join(dir, "job.json"), { throwIfNoEntry: false }); } catch { stat = null; }
    if (!stat) { cache.delete(dir); return false; }
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let entry = cache.get(dir);
    if (!entry || entry.signature !== signature) {
      // Cache only the decision: candidates are reread under the lock.
      const job = readJob(dir);
      entry = { signature, candidate: Boolean(job && job.state !== "queued" && (!TERMINAL_STATES.has(job.state) ||
        job.cleanup?.state === "unresolved" || [job.server, ...(job.attempts ?? []).flatMap(a => a.servers ?? [])].some(s => s?.pid && !s.endedAt))) };
      cache.set(dir, entry);
    }
    return entry.candidate;
  });
}
function legacyJobs(current, slotted, candidates, deps) {
  const ids = new Set(slotted.map(s => s.jobId));
  return candidates.map(d => typeof d === "string" ? { ...readJob(d), jobDir: d } : d).filter(j => j?.id && j.id !== current && !ids.has(j.id) && j.state !== "queued" &&
    ((!TERMINAL_STATES.has(j.state) && deps.isAlive(j.worker)) || executionAlive(j, deps)));
}
function pauseFile(home, backend, account = null) {
  if (!backends.includes(backend) || (account !== null && !/^[a-f0-9]{12}$/.test(account))) throw new Error("invalid pause key");
  return path.join(home, "pauses", `${backend}${account ? `-${account}` : ""}.json`);
}
function pauseRead(home, backend, deps, clean = false, retainProbe = false, account = null) {
  if (!backends.includes(backend)) return null;
  const file = pauseFile(home, backend, account), now = deps.now();
  let p;
  try { p = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; }
  if (!p || p.v !== 1 || p.backend !== backend || !["usage", "rate", "concurrency"].includes(p.kind) ||
      !Number.isFinite(Date.parse(p.until)) || !Number.isFinite(Date.parse(p.updatedAt)) ||
      Date.parse(p.updatedAt) > now + DEFAULTS.clockSkewMs ||
      (p.strikes != null && (!Number.isInteger(p.strikes) || p.strikes < 1)) ||
      (p.probe != null && (!Number.isInteger(p.probe.pid) || p.probe.pid <= 0 || typeof p.probe.jobId !== "string" || typeof p.probe.generation !== "string"))) {
    const at = fs.statSync(file).mtimeMs;
    const until = at + DEFAULTS.maxRatePauseMs;
    if (now >= until) {
      if (clean) quarantine(file, now, `${backend} pause record unreadable; quarantined`, deps);
      return null;
    }
    return { v: 1, backend, account, kind: "pause", damaged: true, until: iso(until),
      reason: `${backend} pause record unreadable; holding until ${iso(until)}` };
  }
  // A live probe owns its lease until explicit release, regardless of its age.
  const liveProbe = p.probe && deps.isAlive(p.probe);
  if (!liveProbe && now - Date.parse(p.updatedAt) >= DEFAULTS.pauseExpiryMs) {
    if (clean) fs.rmSync(file, { force: true });
    return null;
  }
  if (!retainProbe && p.probe && !liveProbe) {
    p.probe = null; if (clean) pauseWrite(home, backend, p, account);
  }
  return p;
}
function pauseWrite(home, backend, pause, account = null) {
  fs.mkdirSync(path.join(home, "pauses"), { recursive: true });
  writeJsonAtomic(pauseFile(home, backend, account), pause);
}
// Existing callers identify the durable job; its current slot carries the request's
// account even if the job directory is outside this process's jobs home.
function jobAccount(home, jobId, deps) {
  if (deps.request) return deps.request.account ?? null;
  const slot = readJsonOrNull(slotFile(home, jobId));
  if (slot && typeof slot.jobDir === "string") return slot.account ?? readJob(slot.jobDir)?.request?.account ?? null;
  const job = legacyCandidates(deps).map(d => typeof d === "string" ? { ...readJob(d), jobDir: d } : d).find(j => j?.id === jobId);
  return job?.request?.account ?? null;
}
const kindLabel = kind => ({ usage: "usage limit", rate: "rate limit", concurrency: "concurrent request limit" })[kind] ?? kind;
function refusalReason(p) { if (p.reason) return p.reason; return `${p.backend}${p.account ? ` (account ${p.account})` : ""} paused: ${kindLabel(p.kind)}${p.code ? ` (${p.code})` : ""} until ${p.until}`; }
function recordFor(slot, notes, reason = null, waitKind = null) {
  return { state: reason ? "waiting" : "admitted", reason: reason ?? slot.waitReason ?? null, waitKind: waitKind ?? slot.waitKind ?? null, since: slot.waitingSince ?? null, admittedAt: reason ? null : slot.admittedAt ?? null, class: slot.class, weight: slot.weight, probe: Boolean(slot.probe), notes };
}
function bypass(ctx, platform = process.platform) {
  const notes = [["linux", "darwin"].includes(platform) ? "load guard off" : `load guard bypassed: admission unsupported on ${platform}`];
  return { admit: true, slot: null, record: { state: "bypassed", notes } };
}
const guardErrors = new Map();
function guardError(ctx, error, deps) {
  const message = String(error?.message ?? error).replace(/\.\d+\.[0-9a-f]+\.tmp\b/gi, "").replace(/[\r\n]+/g, " ");
  const reason = `load guard error: ${message}; holding starts and turns. RELAY_ADMISSION=off or /relay:setup --admission off bypasses the guard`;
  const key = `${ctx.home ?? admissionHome(deps.env)}:${ctx.jobId}`;
  const previous = guardErrors.get(key);
  guardErrors.set(key, message);
  if (previous !== message && ctx.admission?.reason !== reason) {
    try { process.stderr.write(`relay load guard: job ${ctx.jobId}: ${reason}\n`); } catch {}
  }
  return { admit: false, waitKind: "guard-error", retryMs: Number(deps.env.RELAY_ADMISSION_POLL_MS) || DEFAULTS.pollMs, reason,
    record: { state: "waiting", waitKind: "guard-error", reason, since: ctx.waitingSince ?? iso(deps.now()), notes: [] } };
}
const lockWaits = new Map();
function lockReason(home, jobId, holder, deps, since = null) {
  const key = `${home}:${jobId}`, now = deps.now();
  if (!lockWaits.has(key)) lockWaits.set(key, now);
  const persisted = Date.parse(since);
  if (Number.isFinite(persisted) && persisted <= now) lockWaits.set(key, Math.min(lockWaits.get(key), persisted));
  return now - lockWaits.get(key) >= DEFAULTS.stuckLockMs
    ? `admission lock stuck (held by pid ${holder?.pid ?? "unknown"} since ${holder?.since ?? "unknown"}); RELAY_ADMISSION=off bypasses`
    : "admission lock busy";
}
// Unknown membership is charged conservatively to every candidate scope. Known
// siblings share only their common ancestors, never each other's private limits.
const inScope = (hold, scope) => !hold.holdGroup || scope.id === "/" || hold.holdGroup === scope.id || hold.holdGroup.startsWith(`${scope.id}/`);
function holds(all, id, now) {
  return all.filter(s => s.jobId !== id && recent(now, s.holdAt ?? s.admittedAt ?? s.spawnAt, DEFAULTS.reserveMs))
    .map(s => ({ ...s, holdBytes: Number.isFinite(s.holdBytes) ? s.holdBytes : s.state === "running" ? startupBytes(s.backend) : DEFAULTS.workerBytes }));
}
function memoryCheck(machine, settings, pending, bytes, guaranteed = false) {
  if (machine.refreshing) return { kind: "sensor", reason: "sensor refresh in progress" };
  if (settings.headroomBytes + bytes > machine.totalBytes) return { permanent: true, kind: "memory", reason: "job cannot fit host memory: reduce startup demand or use an executor with more memory; RELAY_ADMISSION=off bypasses" };
  for (const scope of machine.scopes ?? []) {
    const margin = Math.min(DEFAULTS.scopeMarginGiB * GiB, DEFAULTS.scopeMarginFraction * scope.limitBytes);
    if (margin + bytes > scope.limitBytes) return { permanent: true, kind: "scope", reason: `job cannot fit cgroup ${scope.id}: startup allowance plus margin exceeds memory.max; raise the limit or use another executor; RELAY_ADMISSION=off bypasses` };
  }
  const pendingBytes = pending.reduce((n, s) => n + s.holdBytes, 0);
  const state = machineState(machine, pendingBytes);
  if (state.state === "critical") return { kind: "critical", reason: state.detail };
  if (guaranteed && machine.availableBytes !== null && machine.availableBytes - pendingBytes - bytes < Math.max(DEFAULTS.criticalGiB * GiB, machine.totalBytes * DEFAULTS.criticalFraction)) return { kind: "critical", reason: "machine critical: memory low after startup allowance" };
  if (!guaranteed && machine.availableBytes !== null && machine.availableBytes - pendingBytes - bytes < settings.headroomBytes) return { kind: "memory", reason: `host memory low: ${(machine.availableBytes / GiB).toFixed(1)} GiB available; ${(pendingBytes / GiB).toFixed(2)} GiB pending holds; ${(settings.headroomBytes / GiB).toFixed(1)} GiB reserve required after startup allowance` };
  for (const scope of machine.scopes ?? []) {
    const margin = Math.min(DEFAULTS.scopeMarginGiB * GiB, DEFAULTS.scopeMarginFraction * scope.limitBytes);
    const reserved = pending.filter(h => inScope(h, scope)).reduce((n, h) => n + h.holdBytes, 0);
    if (scope.remainingBytes - reserved - bytes < margin) return { kind: "scope", reason: `cgroup memory low: ${scope.id} needs startup allowance plus margin after pending holds` };
  }
  return null;
}
// Count identified active jobs, never descriptive legacy class labels or waiters.
function inMinimum(candidate, active, settings) {
  const count = active.filter(s => s.jobId !== candidate.jobId && (s.damaged || Boolean(s.quotaHeavy) === Boolean(candidate.quotaHeavy))).length;
  return count < (candidate.quotaHeavy ? settings.guaranteedVeryHeavy : settings.guaranteedOther);
}
const warningNotes = machine => machine.pressure & 2 ? ["memory pressure warning (not holding)"] : [];
export function admit(ctx, injected = {}) {
  const deps = dependencies(injected), home = ctx.home ?? admissionHome(deps.env), now = deps.now();
  try {
    const platform = deps.platform ?? process.platform;
    if (!["linux", "darwin"].includes(platform)) return bypass(ctx, platform);
    if (String(deps.env.RELAY_ADMISSION).toLowerCase() === "off") return bypass(ctx);
    const config = deps.readAdmissionConfig(deps.env);
    if (!admissionEnabled(deps.env, config, platform)) return bypass(ctx);
    const machine = machineReading(home, deps), settings = guardSettings(config, machine);
    const candidates = legacyCandidates(deps);
    const cls = modelClass(ctx.request), w = WEIGHTS[cls];
    const mine = { v: 1, jobId: ctx.jobId, jobDir: ctx.jobDir, pid: ctx.me.pid, processStart: ctx.me.startTime,
      backend: ctx.request.backend ?? "codex", account: ctx.request.account ?? null, model: ctx.request.model, effort: ctx.request.effort, class: cls, weight: w, quotaHeavy: cls === "very-heavy",
      since: iso(now), waitingSince: ctx.waitingSince ?? null, checkedAt: iso(now), probe: false, probeGeneration: null,
      holdGroup: machine.group, scopes: machine.scopes, hostTotalBytes: machine.totalBytes };
    const notes = [...machine.notes, ...(config.notes ?? []), ...warningNotes(machine)];
    if (!ctx.request.model || ctx.request.model === "default" || !ctx.request.effort || ctx.request.effort === "default") notes.push("effective default model/effort unknown: minimum guarantee covers identified selections");
    const wait = (reason, waitKind, existing = null) => {
      mine.waitingSince ??= iso(now);
      const old = readJsonOrNull(slotFile(home, ctx.jobId));
      const slot = existing?.state === "running" ? { ...existing, checkedAt: iso(now) } : { ...mine, since: old?.since ?? mine.since, spawnAt: old?.spawnAt ?? null, holdAt: old?.holdAt ?? old?.spawnAt ?? null, holdBytes: old?.holdBytes ?? 0, state: "waiting", waitKind };
      slot.waitReason = reason; slot.waitKind = waitKind;
      deps.writeSlot(home, slot);
      return { admit: false, reason, waitKind, retryMs: Number(deps.env.RELAY_ADMISSION_POLL_MS) || DEFAULTS.pollMs * (0.67 + 0.67 * deps.random()), slot, record: recordFor({ ...slot, waitingSince: mine.waitingSince }, [...notes, ...deps.notes], reason, waitKind) };
    };
    const decision = lock(home, deps, () => {
      const all = slots(home, deps), own = all.find(s => s.jobId === ctx.jobId), existing = own?.state === "running" && !own.damaged ? own : null;
      const warm = Boolean(existing);
      const retainedTurn = Boolean(ctx.turn && existing);
      mine.since = own?.since ?? mine.since;
      mine.waitingSince ??= own?.state === "waiting" ? own.waitingSince : null;
      const running = all.filter(s => s.jobId !== ctx.jobId && s.state === "running");
      const legacy = legacyJobs(ctx.jobId, all, candidates, deps);
      const active = [...running, ...legacy.map(j => ({ jobId: j.id, backend: j.request?.backend ?? "codex", quotaHeavy: isVeryHeavy(j.request) }))];
      const eligible = (candidate, candidateMachine, pending, reuseSeat = false, retained = false) => {
        const damaged = foldPending(home, candidate.backend, candidate.account ?? null, deps);
        if (damaged) return { reason: damaged.reason, kind: "pause" };
        const pause = pauseRead(home, candidate.backend, deps, true, false, candidate.account ?? null);
        if (pause && now < Date.parse(pause.until)) return { reason: refusalReason(pause), kind: "pause" };
        if (pause?.probe && (pause.probe.jobId !== candidate.jobId || pause.probe.pid !== candidate.pid || pause.probe.startTime !== candidate.processStart)) return { reason: `${candidate.backend} paused: waiting for probe job ${pause.probe.jobId}`, kind: "probe" };
        if (retained) {
          const pendingBytes = pending.reduce((n, s) => n + s.holdBytes, 0);
          const state = machineState(candidateMachine, pendingBytes);
          return state.state === "critical" && state.holdsTurns ? { kind: "critical", reason: state.detail } : null;
        }
        const candidateSettings = guardSettings(config, candidateMachine);
        const guaranteed = inMinimum(candidate, active, candidateSettings);
        const memory = memoryCheck(candidateMachine, candidateSettings, pending, startupBytes(candidate.backend), guaranteed);
        if (memory) return memory;
        const busy = candidateMachine.load5 !== null && candidateMachine.load5 >= DEFAULTS.busyLoadPerCore * candidateMachine.cores;
        if (!reuseSeat && !guaranteed && (busy || candidateMachine.availableBytes === null) && active.length >= candidateSettings.busySeats) return { reason: `busy-load allowance: ${active.length} of ${settings.busySeats} seats in use`, kind: "seats" };
        return null;
      };
      // Structural impossibility is permanent even while a provider is paused.
      const fit = retainedTurn ? null : memoryCheck(machine, settings, [], startupBytes(mine.backend));
      const blocked = fit?.permanent ? fit : eligible(mine, machine, holds(all, ctx.jobId, now), warm, retainedTurn);
      if (blocked?.permanent) return { admit: false, permanent: true, reason: blocked.reason, record: { ...recordFor(mine, notes, blocked.reason, blocked.kind), state: "failed" } };
      if (blocked) return wait(blocked.reason, blocked.kind, existing);
      const timing = readJsonOrNull(path.join(home, "timing.json")) ?? {};
      if (Date.parse(timing.lastStart) > now + DEFAULTS.clockSkewMs) {
        timing.lastStart = null;
        writeJsonAtomic(path.join(home, "timing.json"), { lastStart: iso(now) });
      }
      if (!retainedTurn && recent(now, timing.lastStart, DEFAULTS.spacingMs)) return wait("staggering starts: another backend just started", "stagger", existing);
      if (!warm) {
        const candidateMachine = s => {
          // Refresh finite sibling scopes on demand; do not use an old wait reason
          // or old headroom sample as proof that a claimant remains eligible.
          const scopes = s.holdGroup === machine.group ? machine.scopes : s.holdGroup ? deps.readScopes(s.holdGroup).scopes : machine.scopes;
          return { ...machine, group: s.holdGroup, scopes, totalBytes: machine.totalBytes };
        };
        const candidates = [mine, ...all.filter(s => s.jobId !== ctx.jobId && s.state === "waiting" && recent(now, s.checkedAt, DEFAULTS.claimantPolls * DEFAULTS.pollMs))]
          .filter(s => !eligible(s, candidateMachine(s), holds(all, s.jobId, now)));
        const seats = backend => active.filter(s => s.backend === backend).length;
        const ordered = candidates.sort((a, b) => seats(a.backend) - seats(b.backend) || Date.parse(a.waitingSince ?? a.since) - Date.parse(b.waitingSince ?? b.since) || a.jobId.localeCompare(b.jobId));
        if (ordered[0]?.jobId !== ctx.jobId) return wait(`fair share: waiting for ${ordered[0].backend} job ${ordered[0].jobId}`, "fair-share");
      }
      const pause = pauseRead(home, mine.backend, deps, true, false, mine.account);
      if (pause) {
        if (!pause.probe) { pause.probe = { jobId: ctx.jobId, ...ctx.me, at: iso(now), generation: randomUUID() }; pauseWrite(home, mine.backend, pause, mine.account); }
        mine.probe = true; mine.probeGeneration = pause.probe.generation; mine.probeAt = pause.probe.at;
      }
      const previousWait = ctx.admission?.state === "admitted" ? ctx.admission : null;
      const slot = { ...mine, waitingSince: ctx.waitingSince ?? previousWait?.since ?? null,
        waitReason: ctx.admission?.reason ?? own?.waitReason ?? null, waitKind: (["worker", "spawned"].includes(ctx.admission?.waitKind) ? ctx.admission.causeKind : ctx.admission?.waitKind) ?? own?.waitKind ?? null,
        spawnAt: own?.spawnAt ?? null, state: "running", admittedAt: ctx.waitingSince ? iso(now) : previousWait?.admittedAt ?? iso(now),
        holdAt: retainedTurn ? existing.holdAt : iso(now), holdBytes: retainedTurn ? existing.holdBytes : startupBytes(mine.backend) };
      deps.writeSlot(home, slot);
      if (!retainedTurn) writeJsonAtomic(path.join(home, "timing.json"), { lastStart: iso(now) });
      return { admit: true, slot, record: recordFor(slot, [...notes, ...deps.notes]) };
    });
    const key = `${home}:${ctx.jobId}`;
    if (decision.locked) { lockWaits.delete(key); return decision.value; }
    mine.waitingSince ??= iso(now);
    const reason = lockReason(home, ctx.jobId, decision.holder, deps);
    return { admit: false, reason, waitKind: "lock", retryMs: DEFAULTS.pollMs, slot: null, record: recordFor(mine, notes, reason, "lock") };
  } catch (e) { return guardError(ctx, e, deps); }
}
// Replacements reuse only a currently held seat; only retained turns skip startup checks and holds.
export const checkBackend = admit;

export function updateSlotMemory(home, jobId, me, treeBytes, injected = {}) {
  const deps = dependencies(injected);
  try {
    return lock(home, deps, () => {
      const slot = readJsonOrNull(slotFile(home, jobId));
      if (!slot || slot.pid !== me.pid || slot.processStart !== me.startTime) return false;
      deps.writeSlot(home, { ...slot, treeBytes });
      return true;
    }).value ?? false;
  } catch { return false; }
}

export function releaseSlot(home, jobId, me, injected = {}) {
  const deps = dependencies(injected);
  try {
    if (!["linux", "darwin"].includes(deps.platform)) return false;
    return lock(home, deps, () => {
      const file = slotFile(home, jobId), s = readJsonOrNull(file);
      if (!s || s.pid !== me.pid || s.processStart !== me.startTime) return false;
      // A failed close or a dead predecessor with a live server stays counted.
      if (executionAlive({ ...readJob(s.jobDir), jobDir: s.jobDir }, { ...deps, freshExecution: true })) return false;
      fs.rmSync(file, { force: true });
      const p = pauseRead(home, s.backend, deps, true, false, s.account ?? null);
      if (p?.probe?.jobId === jobId && p.probe.pid === me.pid && p.probe.startTime === me.startTime) { p.probe = null; pauseWrite(home, s.backend, p, s.account ?? null); }
      return true;
    }).value ?? false;
  } catch { return false; }
}

export function classifyRefusal(backend, error) {
  try {
    const text = [error?.message, error?.data?.message, error?.data?.data?.message, error?.data?.retryState?.reason].filter(s => typeof s === "string").join("\n").slice(0, 4000);
    let kind, code;
    if (backend === "codex") {
      const info = error?.codexErrorInfo ?? error?.data?.codexErrorInfo ?? error?.data?.data?.codexErrorInfo;
      code = typeof info === "string" ? info : info && Object.keys(info)[0];
      kind = ({ usageLimitExceeded: "usage", rateLimitExceeded: "rate" })[code];
    } else if (backend === "kimi") {
      kind = /reached your (?:5-hour|weekly|monthly)\b[^.\n]*usage limit/i.test(text) ? "usage" : /reached your concurrent request limit/i.test(text) ? "concurrency" : /too many requests/i.test(text) ? "rate" : null;
      const status = Number(error?.data?.details?.statusCode ?? error?.data?.statusCode ?? error?.data?.data?.details?.statusCode);
      code = Number.isFinite(status) ? String(status) : kind === "rate" ? "429" : "403";
    } else if (backend === "grok") {
      const quotaText = text.replace(/\b(?:token|context)\s+usage\s+(?:limit|pool)\b/gi, "");
      kind = /\b(?:weekly|credits?|usage (?:limit|pool))\b[^.\n]*(?:exhaust|reached|exceeded|used up|depleted)|(?:exhaust|used up|depleted|reached|exceeded)[^.\n]*\b(?:weekly|credits?|usage (?:limit|pool))\b/i.test(quotaText) ? "usage"
        : /\bHTTP\s+429\b|\b429\s+Too Many Requests\b|rate limit/i.test(text) || Number(error?.data?.statusCode ?? error?.data?.details?.statusCode ?? error?.code) === 429 ? "rate" : null;
      code = kind === "rate" ? "429" : undefined;
    } else if (backend === "zcode") {
      code = /^\d{4}$/.test(String(error?.data?.code)) ? String(error.data.code) : /\[(\d{4})\]|\bcode (\d{4})\b/.exec(text)?.slice(1).find(Boolean);
      kind = ["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"].includes(code) ? "usage" : code === "1302" ? "rate" : null;
    }
    if (!kind) return null;
    const instant = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))\b/.exec(text)?.[1];
    return { kind, code, message: String(error?.message ?? "").split(/\r?\n/)[0].slice(0, 300), resetAt: instant && Number.isFinite(Date.parse(instant)) ? instant : null };
  } catch { return null; }
}
function applyRefusal(old, refusal, jobId, now, backend, account) {
  const same = !old?.damaged && old?.kind === refusal.kind;
  const strikes = same ? (old.strikes ?? 1) + ((now >= Date.parse(old.until) || old.lastJobId !== jobId) ? 1 : 0) : 1;
  const reset = Date.parse(refusal.resetAt);
  const provider = refusal.kind === "usage" && Number.isFinite(reset) && reset > now && reset <= now + DEFAULTS.pauseExpiryMs;
  const duration = refusal.kind === "usage" ? DEFAULTS.usagePauseMs : refusal.kind === "concurrency" ? DEFAULTS.concurrencyPauseMs : Math.min(DEFAULTS.ratePauseMs * 2 ** Math.min(strikes - 1, 20), DEFAULTS.maxRatePauseMs);
  // A new refusal never shortens a pause already in force, whatever order refusals are folded in.
  const kept = old ? Date.parse(old.until) : NaN;
  const fresh = provider ? reset : now + Math.min(duration, DEFAULTS.pauseExpiryMs);
  const keepOld = Number.isFinite(kept) && kept > fresh;
  const until = keepOld ? kept : fresh;
  const resetSource = keepOld && !old.damaged ? old.resetSource ?? "default" : provider ? "provider" : "default";
  return { v: 1, backend, account, ...refusal, since: same ? old.since : iso(now), updatedAt: iso(now), until: iso(until), strikes, resetSource, lastJobId: jobId, probe: null };
}
function foldPending(home, backend, account, deps) {
  const dir = path.join(home, "pauses", "pending"), now = deps.now();
  let damaged = null;
  const valid = [];
  for (const name of files(dir).sort()) {
    if (!name.startsWith(`${backend}-`) || !name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let pending;
    try {
      pending = JSON.parse(fs.readFileSync(file, "utf8"));
      // A readable account scopes even a refusal kind from a newer version.
      const knownAccount = pending && (pending.account === null || (typeof pending.account === "string" && /^[a-f0-9]{12}$/.test(pending.account)));
      if (knownAccount && pending.account !== account) continue;
      if (!knownAccount || !["usage", "rate", "concurrency"].includes(pending.refusal?.kind) || typeof pending.jobId !== "string" ||
          (pending.receivedAt != null && !Number.isFinite(Date.parse(pending.receivedAt)))) throw new Error("invalid pending provider refusal");
    } catch {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      const until = stat.mtimeMs + DEFAULTS.maxRatePauseMs;
      if (now >= until) quarantine(file, now, `${backend} pending refusal ${name} unreadable; quarantined`, deps);
      else damaged ??= { reason: `${backend} pending refusal ${name} unreadable; holding until ${iso(until)}` };
      continue;
    }
    // Older writers supplied only mtime; replay must never restart their cooldown.
    const receivedAt = Math.min(now, pending.receivedAt == null ? fs.statSync(file).mtimeMs : Date.parse(pending.receivedAt));
    valid.push({ file, name, pending, receivedAt });
  }
  // Replay in arrival order, so strikes and the last job follow the order the refusals happened.
  valid.sort((a, b) => a.receivedAt - b.receivedAt || a.name.localeCompare(b.name));
  for (const { file, pending, receivedAt } of valid) {
    const old = pauseRead(home, backend, deps, true, false, account);
    pauseWrite(home, backend, applyRefusal(old, pending.refusal, pending.jobId, receivedAt, backend, account), account);
    fs.rmSync(file);
  }
  return damaged;
}
export function recordRefusal(home, backend, refusal, jobId, injected = {}) {
  const deps = dependencies(injected);
  try {
    if (!["linux", "darwin"].includes(deps.platform) || !admissionEnabled(deps.env, deps.readAdmissionConfig(deps.env), deps.platform)) return null;
    const account = jobAccount(home, jobId, deps), receivedAt = deps.now();
    const result = retryLock(home, deps, () => {
      foldPending(home, backend, account, deps);
      const p = applyRefusal(pauseRead(home, backend, deps, true, false, account), refusal, jobId, receivedAt, backend, account);
      pauseWrite(home, backend, p, account); return p;
    });
    if (result.locked) return result.value;
    const dir = path.join(home, "pauses", "pending");
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, `${backend}-${randomUUID()}.json`), { backend, account, refusal, jobId, receivedAt: iso(receivedAt) });
    return { pending: true };
  } catch (e) { process.stderr.write(`relay load guard: provider pause for ${backend} not recorded (${e.message})\n`); return null; }
}
export function probeSucceeded(home, backend, jobId, injected = {}, generation = null) {
  const deps = dependencies(injected);
  try {
    if (!admissionEnabled(deps.env, undefined, deps.platform)) return false;
    const account = jobAccount(home, jobId, deps);
    return retryLock(home, deps, () => {
      const p = pauseRead(home, backend, deps, false, true, account);
      if (!p?.probe || p.probe.jobId !== jobId || !generation || p.probe.generation !== generation) return false;
      fs.rmSync(pauseFile(home, backend, account), { force: true }); return true;
    }).value ?? false; } catch { return false; }
}
// An unfinished startup relinquishes only its fenced lease, never the pause.
export function releaseProbe(home, backend, jobId, injected = {}, generation = null) {
  const deps = dependencies(injected);
  try {
    if (!admissionEnabled(deps.env, undefined, deps.platform)) return false;
    const account = jobAccount(home, jobId, deps);
    return retryLock(home, deps, () => {
      const p = pauseRead(home, backend, deps, false, true, account);
      if (!p?.probe || p.probe.jobId !== jobId || !generation || p.probe.generation !== generation) return false;
      p.probe = null; pauseWrite(home, backend, p, account); return true;
    }).value ?? false;
  } catch { return false; }
}
export function listPauses(env = process.env, injected = {}) {
  const deps = dependencies({ ...injected, env });
  try {
    if (!["linux", "darwin"].includes(deps.platform) || !admissionEnabled(env, deps.readAdmissionConfig(env), deps.platform)) return [];
    const home = admissionHome(env);
    return files(path.join(home, "pauses")).flatMap(name => {
      const key = /^(codex|grok|zcode|kimi)(?:-([a-f0-9]{12}))?\.json$/.exec(name);
      if (!key) return [];
      const p = pauseRead(home, key[1], deps, false, true, key[2] ?? null);
      return p ? [{ backend: p.backend, account: key[2] ?? null, kind: p.kind, reason: p.reason, code: p.code, until: p.until, strikes: p.strikes, probing: Boolean(p.probe && deps.isAlive(p.probe)) }] : [];
    });
  } catch { return []; }
}
export function describeGuard(env = process.env, { readSensors = true } = {}, injected = {}) {
  const deps = dependencies({ ...injected, env });
  try {
    const platform = deps.platform ?? process.platform;
    const enabled = ["linux", "darwin"].includes(platform) && admissionEnabled(env, deps.readAdmissionConfig(env), platform);
    if (!enabled) return { enabled, reason: !["linux", "darwin"].includes(platform) ? `admission unsupported on ${platform}` : String(env.RELAY_ADMISSION).toLowerCase() === "off" ? "RELAY_ADMISSION=off" : "setup", pauses: [] };
    const home = admissionHome(env), pauses = listPauses(env, deps);
    if (!readSensors) return { enabled, pauses };
    const machine = machineReading(home, deps), candidates = legacyCandidates(deps), all = slots(home, deps, false);
    const running = all.filter(s => s.state === "running");
    const legacy = legacyJobs(null, all, candidates, deps);
    return { enabled, ...machine, notes: [...machine.notes, ...(deps.readAdmissionConfig(env).notes ?? []), ...warningNotes(machine), ...deps.notes], state: machineState(machine).state, ...guardSettings(deps.readAdmissionConfig(env), machine), relayBytes: [...running, ...legacy].reduce((n, s) => n + (s.treeBytes ?? 0), 0), activeSeats: running.length + legacy.length, pendingBytes: holds(all, null, deps.now()).reduce((n, s) => n + s.holdBytes, 0),
      veryHeavy: running.filter(s => s.quotaHeavy).length + legacy.filter(j => isVeryHeavy(j.request)).length, waiting: all.filter(s => s.state !== "running").length, pauses };
  } catch (e) { return { enabled: true, error: e.message, pauses: [] }; }
}
export function renderGuard(snapshot) {
  if (!snapshot.enabled) return [`load-guard: off (${snapshot.reason})`];
  if (snapshot.error) return [`load-guard: on (state unreadable: ${snapshot.error})`];
  const state = snapshot.refreshing ? "sensor refresh in progress" : (snapshot.notes ?? []).some(n => n.includes("readings unavailable")) ? `readings unavailable (${snapshot.state})` : snapshot.state;
  const memory = snapshot.availableBytes === null ? "memory not read" : `memory ${(snapshot.availableBytes / GiB).toFixed(1)} of ${(snapshot.totalBytes / GiB).toFixed(1)} GiB available`;
  return [`load-guard: on · ${state} · seats ${snapshot.activeSeats}, no fixed ceiling, busy allowance ${snapshot.busySeats} · very heavy ${snapshot.veryHeavy} running (${snapshot.guaranteedVeryHeavy} guaranteed, no maximum) · minimum guarantee ${snapshot.guaranteedVeryHeavy} very heavy + ${snapshot.guaranteedOther} other · host ${memory} (${snapshot.source ?? "source unknown"}; ${snapshot.quality ?? "unknown quality"}) · relay jobs use ${((snapshot.relayBytes ?? 0) / GiB).toFixed(1)} GiB · pending holds ${((snapshot.pendingBytes ?? 0) / GiB).toFixed(2)} GiB · finite scopes ${(snapshot.scopes ?? []).map(s => `${s.id}: ${(s.remainingBytes / GiB).toFixed(2)} GiB remaining`).join(", ") || "none known"} · 5-minute load ${snapshot.load5 ?? "not read"} on ${snapshot.cores} cores`,
    ...(snapshot.notes ?? []).map(n => `note: load guard: ${n}`), ...(snapshot.pauses ?? []).map(p => `paused: ${refusalReason(p)}; strike ${p.strikes}`)];
}

// Reserve a waiting-worker place and spawn while holding the admission lock. The
// caller owns retries; completing workers never launch another session's jobs.
export function spawnWithAdmission(jobDir, env, spawn, injected = {}) {
  const deps = dependencies({ ...injected, env });
  let spawnAttempted = false;
  const launch = () => { spawnAttempted = true; return spawn(); };
  try {
    const platform = deps.platform ?? process.platform;
    if (!["linux", "darwin"].includes(platform)) { process.stderr.write(`relay load guard: admission unsupported on ${platform}; worker bypassed\n`); return launch(); }
    if (String(env.RELAY_ADMISSION).toLowerCase() === "off") return launch();
    const config = deps.readAdmissionConfig(env);
    if (!admissionEnabled(env, config, platform)) return launch();
    const home = admissionHome(env);
    let machine = machineReading(home, deps);
    for (let retry = 0; machine.refreshing && retry < 10; retry++) {
      deps.lockSleep(25 + Math.floor(50 * deps.random()));
      machine = machineReading(home, deps);
    }
    const settings = guardSettings(config, machine), job = readJob(jobDir), candidates = legacyCandidates(deps);
    const decision = retryLock(home, deps, () => {
      const job = readJob(jobDir);
      if (TERMINAL_STATES.has(job?.state) && pendingInboxMessages(jobDir).length === 0) return null;
      const all = slots(home, deps), existing = all.find(s => s.jobId === job.id);
      if (existing && ((existing.state === "spawning" && recent(deps.now(), existing.since, DEFAULTS.spawnGraceMs)) || deps.isAlive({ pid: existing.pid, startTime: existing.processStart }))) return null;
      const waiting = all.filter(s => s.state !== "running").length;
      const cls = modelClass(job.request);
      const candidate = { jobId: job.id, quotaHeavy: isVeryHeavy(job.request) };
      const guaranteed = inMinimum(candidate, [...all.filter(s => s.state === "running"), ...legacyJobs(job.id, all, candidates, deps).map(j => ({ jobId: j.id, quotaHeavy: isVeryHeavy(j.request) }))], settings);
      const check = memoryCheck(machine, settings, holds(all, job.id, deps.now()), DEFAULTS.workerBytes, guaranteed);
      const reason = check?.reason ?? (waiting >= settings.maxWaitingWorkers ? `waiting worker limit: ${waiting} of ${settings.maxWaitingWorkers}` : null);
      if (reason) {
        writeJob(jobDir, { ...job, state: check?.permanent ? "failed" : "queued", ...(check?.permanent ? { completedAt: iso(deps.now()), errorMessage: reason } : {}), worker: null,
          admission: { state: check?.permanent ? "failed" : "waiting", reason, waitKind: "worker", causeKind: check?.kind ?? "workers", since: job.admission?.state === "waiting" ? job.admission.since : iso(deps.now()), class: cls, weight: WEIGHTS[cls], notes: machine.notes } });
        return null;
      }
      const slot = { v: 1, jobId: job.id, jobDir, pid: null, processStart: null, backend: job.request.backend ?? "codex", account: job.request.account ?? null, class: cls, weight: WEIGHTS[cls], state: "spawning", spawnAt: iso(deps.now()), since: iso(deps.now()), holdAt: iso(deps.now()), holdBytes: DEFAULTS.workerBytes, holdGroup: machine.group, scopes: machine.scopes };
      deps.writeSlot(home, slot);
      if (job.state === "queued" && job.admission?.waitKind === "worker")
        writeJob(jobDir, { ...job, state: "starting", worker: null, launchPendingAt: iso(deps.now()),
          admission: { ...job.admission, waitKind: "spawned" } });
      return slot;
    });
    if (!decision.locked) {
      const previousLock = job.admission?.waitKind === "worker" && /admission lock (busy|stuck)/.test(job.admission.reason);
      const lockSince = previousLock ? job.admission.lockSince ?? job.admission.since : iso(deps.now());
      writeJob(jobDir, { ...job, state: "queued", worker: null, admission: { state: "waiting", waitKind: "worker", causeKind: "lock",
        reason: lockReason(home, job.id, decision.holder, deps, lockSince), lockSince,
        since: job.admission?.since ?? iso(deps.now()), notes: [] } });
      return null;
    }
    lockWaits.delete(`${home}:${job.id}`);
    if (!decision.value) return null;
    // The spawning reservation fences contenders while the handshake runs outside the lock.
    try { return launch(); }
    catch (e) {
      retryLock(home, deps, () => {
        const current = readJsonOrNull(slotFile(home, job.id));
        if (current?.state === "spawning" && current.spawnAt === decision.value.spawnAt)
          fs.rmSync(slotFile(home, job.id), { force: true });
      });
      throw e;
    }
  } catch (e) {
    if (spawnAttempted) throw e;
    const job = readJob(jobDir);
    if (job && !(TERMINAL_STATES.has(job.state) && pendingInboxMessages(jobDir).length === 0)) {
      const held = guardError({ jobId: job.id, home: admissionHome(env), waitingSince: job.admission?.since, admission: job.admission }, e, deps);
      try { writeJob(jobDir, { ...job, state: "queued", worker: null, admission: { ...held.record, waitKind: "worker", causeKind: "guard-error" } }); } catch {}
    }
    return null;
  }
}
