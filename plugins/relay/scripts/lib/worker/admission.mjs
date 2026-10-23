// Shared per-user launch admission. Sensor failures skip that sensor; guard failures
// bypass with a visible note. A live lock is never broken or bypassed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readUserConfig } from "../jobs/config.mjs";
import { listJobDirs, readJob, readJsonOrNull, writeJsonAtomic, writeJob, TERMINAL_STATES } from "../jobs/store.mjs";
import { acquireOwnership, releaseOwnership, readOwnership } from "../util/ownership.mjs";
import { isProcessAlive, isProcessIdentityAlive, readProcessStartTime } from "../util/process.mjs";

const GiB = 2 ** 30;
// All scheduling policy lives here. Weights describe scheduling hints, not RSS.
export const DEFAULTS = Object.freeze({
  headroomGiB: 2, headroomFraction: 1 / 4,
  reserveGiBPerWeight: 0.5, reserveMs: 30000,
  minWeight: 12, ceilingCores: 2, maxVeryHeavy: 2,
  spacingMs: 5000, aboveMinSpacingMs: 10000,
  criticalGiB: 0.75, criticalFraction: 0.05, criticalLoadPerCore: 3,
  healthyGiB: 2, healthyFraction: 0.15, healthyLoadPerCore: 1.5,
  minWaitingWorkers: 8, waitingPerCeiling: 1,
  weights: Object.freeze({ light: 1, medium: 2, "very-heavy": 3 }),
  heavyEfforts: ["max", "ultra"], heavyModel: /astra/i, kimiHeavyModel: /(^|[^a-z0-9])k3([^a-z0-9]|$)/i,
  lightEfforts: ["low", "minimal", "none"], lightModel: /luna|flash|highspeed|-fast$/i,
  pollMs: 3000, probeMs: 120000, sensorCacheMs: 2000, discoveryMs: 60000,
  processCacheMs: 60000, spawnGraceMs: 10000, stuckLockMs: 60000,
  pauseExpiryMs: 6 * 3600000, clockSkewMs: 300000,
  usagePauseMs: 30 * 60000, ratePauseMs: 60000, maxRatePauseMs: 15 * 60000,
  concurrencyPauseMs: 10 * 60000, kimiAttempts: "3"
});
export const WEIGHTS = DEFAULTS.weights;
export const PENDING_BYTES = Object.fromEntries(Object.entries(WEIGHTS).map(([k, w]) => [k, w * DEFAULTS.reserveGiBPerWeight * GiB]));
const backends = ["codex", "grok", "zcode", "kimi"];
const iso = n => new Date(n).toISOString();
const age = (now, at, duration) => now >= Date.parse(at) && now - Date.parse(at) < duration;
const positive = (value, max, fallback) => Number.isInteger(value) && value > 0 && value <= max ? value : fallback;
export function admissionHome(env = process.env) {
  return path.resolve(env.RELAY_ADMISSION_HOME || path.join(os.homedir(), ".relay-jobs", "admission"));
}
export function admissionEnabled(env = process.env, config = readUserConfig(env)) {
  return String(env.RELAY_ADMISSION).toLowerCase() !== "off" && config.admission !== "off";
}
export function guardSettings(config = {}, machine = { totalBytes: os.totalmem(), cores: os.availableParallelism() }) {
  const total = machine.totalBytes / GiB;
  const headroom = Math.max(DEFAULTS.headroomGiB, total * DEFAULTS.headroomFraction);
  const minWeight = positive(config.minWeight, 1000, DEFAULTS.minWeight);
  const ceiling = Math.max(DEFAULTS.minWeight, Math.min(DEFAULTS.ceilingCores * machine.cores, Math.floor((total - headroom) / DEFAULTS.reserveGiBPerWeight)));
  return { minWeight, maxWeight: Math.max(minWeight, positive(config.maxWeight, 10000, ceiling)),
    maxVeryHeavy: positive(config.maxVeryHeavy, 100, DEFAULTS.maxVeryHeavy), modelClasses: validModelClasses(config.modelClasses), headroomBytes: headroom * GiB };
}
export function validModelClasses(entries) {
  return Array.isArray(entries) ? entries.filter(e => e && typeof e.pattern === "string" && /^[0-9A-Za-z._:/*-]{1,100}$/.test(e.pattern) && Object.hasOwn(WEIGHTS, e.class)) : [];
}
/** @param {{ backend?: string, model?: string | null, effort?: string | null }} request */
export function modelClass({ backend = "codex", model, effort } = {}, overrides = []) {
  const m = model === "default" ? "" : String(model ?? "").toLowerCase();
  const e = String(effort ?? "").toLowerCase();
  for (const rule of validModelClasses(overrides)) {
    const pattern = rule.pattern.toLowerCase().split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (new RegExp(pattern).test(m)) return rule.class;
  }
  if (DEFAULTS.heavyEfforts.includes(e) || DEFAULTS.heavyModel.test(m) || (backend === "kimi" && DEFAULTS.kimiHeavyModel.test(m))) return "very-heavy";
  return DEFAULTS.lightEfforts.includes(e) || DEFAULTS.lightModel.test(m) ? "light" : "medium";
}

// Admission alone uses this bounded batch cache, including ownership and legacy reads.
const processCaches = new Map();
export function holderAlive(identity, { platform = process.platform, now = Date.now(), ps = spawnSync } = {}) {
  // Windows has no ps identity reading. Unknown holders stay counted; no
  // unsupported command or negative identity inference can free their slots.
  if (platform === "win32") return Number.isInteger(identity?.pid) && identity.pid > 0;
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
  return { env, now, random: Math.random, scanUnslotted: null, readUserConfig, readMachine: readMachineDefault,
    isAlive: identity => holderAlive(identity, { platform: deps.platform, now: now() }), ...deps };
}
function lock(home, deps, fn) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "admission.lock");
  if (!acquireOwnership(file, { ...self(deps), since: iso(deps.now()) }, { isAlive: deps.isAlive })) return { locked: false, holder: readOwnership(file, { isAlive: deps.isAlive }) };
  try { return { locked: true, value: fn() }; }
  finally { releaseOwnership(file); }
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
  let availableBytes = null;
  const notes = [];
  for (let current = group; current; current = current === "/" ? null : path.posix.dirname(current)) {
    try {
      const dir = path.join("/sys/fs/cgroup", current);
      const limit = readFile(path.join(dir, "memory.max"), "utf8").trim();
      if (limit === "max") continue;
      const used = readFile(path.join(dir, "memory.current"), "utf8").trim();
      if (!/^\d+$/.test(limit) || !/^\d+$/.test(used)) throw new Error("invalid reading");
      const remaining = Math.max(0, Number(limit) - Number(used));
      if (!Number.isFinite(remaining)) throw new Error("invalid reading");
      availableBytes = availableBytes === null ? remaining : Math.min(availableBytes, remaining);
    } catch (e) {
      const note = `readings unavailable: cgroup memory not read (${e.code ?? e.message})`;
      if (!notes.includes(note)) notes.push(note);
    }
  }
  return { availableBytes, notes };
}
export function readMachineDefault({ home = admissionHome(), platform = process.platform, now = Date.now(), env = process.env, sensor = os, sysctl = spawnSync, readFile = fs.readFileSync } = {}) {
  // Test hook: subprocess fixtures supply synthetic readings; never used implicitly.
  if (env.RELAY_ADMISSION_READINGS) {
    const fixture = readJsonOrNull(env.RELAY_ADMISSION_READINGS);
    if (!fixture) throw new Error("invalid admission readings");
    return { notes: [], ...fixture };
  }
  const notes = platform === "win32" ? ["process identity not read (not available on this system); slots retained"] : [];
  const read = (name, fn, positiveOnly = false) => {
    try { const n = fn(); if (!Number.isFinite(n) || n < 0 || (positiveOnly && n === 0)) throw new Error("invalid reading"); return n; }
    catch (e) { notes.push(`readings unavailable: ${name} not read (${e.message})`); return null; }
  };
  const totalBytes = read("total memory", () => sensor.totalmem(), true);
  const cores = read("cores", () => sensor.availableParallelism(), true) ?? 1;
  const load5 = read("load", () => { if (platform === "win32") throw new Error("not available on this system"); return sensor.loadavg()[1]; });
  const identity = platform === "linux" ? cgroupIdentity(home, now, readFile) : null;
  if (identity?.note) notes.push(identity.note);
  const cacheKey = platform === "linux" ? `linux-${createHash("sha256").update(identity.group ?? "unavailable").digest("hex").slice(0, 16)}` : platform;
  const readMemory = () => {
    if (platform === "darwin") return read("memory", () => {
      const r = sysctl("sysctl", ["-n", "kern.memorystatus_level"], { timeout: 1000, encoding: "utf8" });
      const value = String(r.stdout ?? "").trim();
      if (r.error || r.status !== 0 || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100 || !totalBytes) throw new Error("sysctl kern.memorystatus_level failed");
      return Number(value) / 100 * totalBytes;
    });
    let available = read("memory", () => sensor.freemem());
    if (identity?.group) {
      const constrained = cgroupAvailable(identity.group, readFile);
      notes.push(...constrained.notes);
      if (constrained.availableBytes !== null) available = available === null ? constrained.availableBytes : Math.min(available, constrained.availableBytes);
    }
    return available;
  };
  let availableBytes;
  if (!["linux", "darwin"].includes(platform)) availableBytes = readMemory();
  else {
    const file = path.join(home, `.machine-${cacheKey}.json`);
    const cached = readJsonOrNull(file);
    const cacheValid = cached && Array.isArray(cached.notes) && cached.notes.every(n => typeof n === "string") && (cached.availableBytes === null || (Number.isFinite(cached.availableBytes) && cached.availableBytes >= 0 && cached.availableBytes <= totalBytes));
    if (cacheValid && now >= cached.at && now - cached.at < DEFAULTS.sensorCacheMs) {
      availableBytes = cached.availableBytes; notes.push(...cached.notes);
    } else {
      let owns = false;
      const owner = path.join(home, `machine-${cacheKey}.lock`);
      try {
        fs.mkdirSync(home, { recursive: true });
        owns = Boolean(acquireOwnership(owner, { pid: process.pid, startTime: null }, { isAlive: identity => holderAlive(identity, { platform, now }) }));
        if (!owns) {
          availableBytes = null; notes.push("readings unavailable: memory not read (sensor refresh in progress)");
        } else {
          const before = notes.length;
          availableBytes = readMemory();
          try { writeJsonAtomic(file, { at: now, availableBytes, notes: notes.slice(before) }); }
          catch (e) { notes.push(`readings unavailable: memory cache not written (${e.code ?? e.message})`); }
        }
      } catch (e) {
        // A denied cache directory must not hide readable memory/load sensors.
        notes.push(`readings unavailable: memory cache not accessible (${e.code ?? e.message})`);
        availableBytes = readMemory();
      } finally {
        if (owns) try { releaseOwnership(owner); }
        catch (e) { notes.push(`readings unavailable: memory cache release failed (${e.code ?? e.message})`); }
      }
    }
  }
  return { totalBytes, cores, availableBytes, load5, notes };
}
function machineReading(home, deps) {
  try {
    const m = deps.readMachine({ home, env: deps.env, now: deps.now(), platform: deps.platform });
    const valid = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
    const notes = (Array.isArray(m.notes) ? m.notes : []).filter(n => typeof n === "string");
    for (const [key, label] of [["availableBytes", "memory"], ["load5", "load"]]) {
      if (m[key] !== null && !valid(m[key])) notes.push(`readings unavailable: ${label} not read (invalid reading)`);
    }
    return { ...m, availableBytes: valid(m.availableBytes) ? m.availableBytes : null, load5: valid(m.load5) ? m.load5 : null,
      totalBytes: valid(m.totalBytes) && m.totalBytes > 0 ? m.totalBytes : os.totalmem(), cores: valid(m.cores) && m.cores > 0 ? m.cores : os.availableParallelism(), notes };
  } catch (e) { return { totalBytes: os.totalmem(), cores: os.availableParallelism(), availableBytes: null, load5: null, notes: [`readings unavailable: sensors not read (${e.message})`] }; }
}
export function machineState(machine, pendingBytes = 0) {
  const { totalBytes: t, availableBytes: a, load5: l, cores: c } = machine;
  const effective = a === null ? null : a - pendingBytes;
  if (effective !== null && effective < Math.max(DEFAULTS.criticalGiB * GiB, t * DEFAULTS.criticalFraction)) return { state: "critical", detail: "machine critical: memory low" };
  if (l !== null && l > DEFAULTS.criticalLoadPerCore * c) return { state: "critical", detail: `machine critical: 5-minute load ${l.toFixed(1)} on ${c} cores` };
  if (a === null && l === null) return { state: "unknown", detail: "machine readings unavailable" };
  const healthy = (effective === null || effective >= Math.max(DEFAULTS.healthyGiB * GiB, t * DEFAULTS.healthyFraction)) && (l === null || l < DEFAULTS.healthyLoadPerCore * c);
  return { state: healthy ? "healthy" : "busy", detail: null };
}
function files(dir) { try { return fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
function slotFile(home, id) { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid job id"); return path.join(home, "slots", `${id}.json`); }
function writeSlot(home, slot) { fs.mkdirSync(path.join(home, "slots"), { recursive: true }); writeJsonAtomic(slotFile(home, slot.jobId), slot); }
function serversAlive(job, deps) {
  return [job?.server, ...(job?.attempts ?? []).flatMap(a => a.servers ?? [])].some(s => s?.pid && !s.endedAt && deps.isAlive(s));
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
    if (!s || s.v !== 1 || typeof s.jobDir !== "string" || typeof s.jobId !== "string" || !Object.hasOwn(WEIGHTS, s.class) || !["waiting", "running", "spawning"].includes(s.state)) {
      if (clean && deps.now() - fs.statSync(file).mtimeMs > 10000) fs.rmSync(file, { force: true }); continue;
    }
    const live = (s.state === "spawning" && age(deps.now(), s.since, DEFAULTS.spawnGraceMs)) || deps.isAlive({ pid: s.pid, startTime: s.processStart });
    s.weight = WEIGHTS[s.class];
    const backendLive = serversAlive(readJob(s.jobDir), deps);
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
    cached = { at: now, dirs: listJobDirs({ env }) }; discovered.set(key, cached);
  }
  return cached.dirs;
}
function legacyJobs(home, current, slotted, deps) {
  const dirs = deps.scanUnslotted ? deps.scanUnslotted() : directories(deps.env, deps.now());
  return dirs.map(d => typeof d === "string" ? readJob(d) : d).filter(j => j?.id && j.id !== current && !slotted.some(s => s.jobId === j.id) && j.state !== "queued" &&
    ((!TERMINAL_STATES.has(j.state) && deps.isAlive(j.worker)) || serversAlive(j, deps)));
}
function pauseFile(home, backend) { if (!backends.includes(backend)) throw new Error("invalid backend"); return path.join(home, "pauses", `${backend}.json`); }
function pauseRead(home, backend, deps, clean = false, retainProbe = false) {
  const file = pauseFile(home, backend), p = readJsonOrNull(file), now = deps.now();
  if (!p || p.v !== 1 || !Number.isFinite(Date.parse(p.until)) || !Number.isFinite(Date.parse(p.updatedAt)) || Date.parse(p.updatedAt) > now + DEFAULTS.clockSkewMs || now - Date.parse(p.updatedAt) >= DEFAULTS.pauseExpiryMs) {
    if (clean) fs.rmSync(file, { force: true }); return null;
  }
  if (!retainProbe && p.probe && (!deps.isAlive(p.probe) || !age(now, p.probe.at, DEFAULTS.probeMs))) {
    p.probe = null; if (clean) writeJsonAtomic(file, p);
  }
  return p;
}
function pauseWrite(home, backend, pause) { fs.mkdirSync(path.join(home, "pauses"), { recursive: true }); writeJsonAtomic(pauseFile(home, backend), pause); }
const kindLabel = kind => ({ usage: "usage limit", rate: "rate limit", concurrency: "concurrent request limit" })[kind] ?? kind;
function refusalReason(p) { return `${p.backend} paused: ${kindLabel(p.kind)}${p.code ? ` (${p.code})` : ""} until ${p.until}`; }
function recordFor(slot, notes, reason = null, waitKind = null) {
  return { state: reason ? "waiting" : "admitted", reason, waitKind, since: reason ? slot.since : null, admittedAt: slot.admittedAt ?? null, class: slot.class, weight: slot.weight, probe: Boolean(slot.probe), notes };
}
function bypass(ctx, error = null) {
  const notes = error ? [`admitted without the guard (${error.message ?? error})`] : ["load guard off"];
  if (error) process.stderr.write(`relay load guard: admitted job ${ctx.jobId} without the guard: ${error.message ?? error}\n`);
  return { admit: true, slot: null, record: { state: "bypassed", notes } };
}
const lockWaits = new Map();
function lockReason(home, jobId, holder, deps) {
  const key = `${home}:${jobId}`, now = deps.now();
  if (!lockWaits.has(key)) lockWaits.set(key, now);
  return now - lockWaits.get(key) >= DEFAULTS.stuckLockMs
    ? `admission lock stuck (held by pid ${holder?.pid ?? "unknown"} since ${holder?.since ?? "unknown"}); RELAY_ADMISSION=off bypasses`
    : "admission lock busy";
}
export function admit(ctx, injected = {}) {
  const deps = dependencies(injected), home = ctx.home ?? admissionHome(deps.env), now = deps.now();
  try {
    const config = deps.readUserConfig(deps.env);
    if (!admissionEnabled(deps.env, config)) return bypass(ctx);
    const machine = machineReading(home, deps), settings = guardSettings(config, machine);
    // Discover outside the lock; membership and live records are reconciled inside it.
    if (!deps.scanUnslotted) directories(deps.env, now);
    const cls = modelClass(ctx.request, settings.modelClasses), w = WEIGHTS[cls];
    const mine = { v: 1, jobId: ctx.jobId, jobDir: ctx.jobDir, pid: ctx.me.pid, processStart: ctx.me.startTime,
      backend: ctx.request.backend ?? "codex", model: ctx.request.model, class: cls, weight: w,
      since: ctx.waitingSince ?? iso(now), checkedAt: iso(now), probe: false, probeGeneration: null };
    const wait = (reason, waitKind, existing = null) => {
      const slot = existing?.state === "running" ? { ...existing, checkedAt: iso(now) } : { ...mine, spawnAt: readJsonOrNull(slotFile(home, ctx.jobId))?.spawnAt ?? null, state: "waiting", waitKind };
      writeSlot(home, slot);
      return { admit: false, reason, waitKind, retryMs: Number(deps.env.RELAY_ADMISSION_POLL_MS) || DEFAULTS.pollMs * (0.67 + 0.67 * deps.random()), slot, record: recordFor({ ...slot, since: mine.since }, machine.notes, reason, waitKind) };
    };
    const decision = lock(home, deps, () => {
      const all = slots(home, deps), existing = all.find(s => s.jobId === ctx.jobId && s.state === "running");
      const running = all.filter(s => s.jobId !== ctx.jobId && s.state === "running");
      const legacy = legacyJobs(home, ctx.jobId, all, deps);
      const used = running.reduce((n, s) => n + s.weight, 0) + legacy.length * WEIGHTS.medium;
      const pending = running.filter(s => age(now, s.admittedAt, DEFAULTS.reserveMs)).reduce((n, s) => n + s.weight * DEFAULTS.reserveGiBPerWeight * GiB, 0);
      const pause = pauseRead(home, mine.backend, deps, true);
      if (pause && now < Date.parse(pause.until)) return wait(refusalReason(pause), "pause", existing);
      if (pause?.probe && (pause.probe.jobId !== ctx.jobId || pause.probe.pid !== ctx.me.pid || pause.probe.startTime !== ctx.me.startTime)) return wait(`${mine.backend} paused: waiting for probe job ${pause.probe.jobId}`, "probe", existing);
      const state = machineState(machine, pending);
      if (state.state === "critical") return wait(state.detail, "critical", existing);
      const effective = machine.availableBytes === null ? null : machine.availableBytes - pending - w * DEFAULTS.reserveGiBPerWeight * GiB;
      if (effective !== null && effective < settings.headroomBytes) return wait(`memory low: ${(machine.availableBytes / GiB).toFixed(1)} GiB available; ${(settings.headroomBytes / GiB).toFixed(1)} GiB headroom required after startup reserves`, "memory", existing);
      const timing = readJsonOrNull(path.join(home, "timing.json")) ?? {};
      if (age(now, timing.lastStart, DEFAULTS.spacingMs)) return wait("staggering starts: another job or turn just started", "stagger", existing);
      let aboveMin = false;
      if (!existing) {
        const vh = running.filter(s => s.class === "very-heavy").length;
        if (cls === "very-heavy" && vh >= settings.maxVeryHeavy) return wait(`very heavy limit: ${vh} of ${settings.maxVeryHeavy} very heavy jobs running`, "very-heavy");
        const fitsMin = used + w <= settings.minWeight;
        if (!fitsMin && (state.state !== "healthy" || used + w > settings.maxWeight)) return wait(state.state !== "healthy" ? `machine busy: weight ${used} of the minimum ${settings.minWeight} in use` : `at the ceiling: weight ${used} of ${settings.maxWeight} in use`, "weight");
        aboveMin = !fitsMin;
        if (aboveMin && age(now, timing.lastAboveMin, DEFAULTS.aboveMinSpacingMs)) return wait("one start above the minimum per spacing interval", "spacing");
        const limit = fitsMin ? settings.minWeight : settings.maxWeight;
        const weightOf = b => running.filter(s => s.backend === b).reduce((n, s) => n + s.weight, 0) + legacy.filter(j => (j.request?.backend ?? "codex") === b).length * WEIGHTS.medium;
        const other = all.find(s => s.jobId !== ctx.jobId && s.state === "waiting" && s.backend !== mine.backend && ["weight", "spacing", "stagger", "fair-share"].includes(s.waitKind) && weightOf(s.backend) < weightOf(mine.backend));
        if (limit - (used + w) < WEIGHTS.medium && other) return wait(`fair share: the last free weight is held for a waiting ${other.backend} job`, "fair-share");
      }
      if (pause) {
        if (!pause.probe) { pause.probe = { jobId: ctx.jobId, ...ctx.me, at: iso(now), generation: randomUUID() }; pauseWrite(home, mine.backend, pause); }
        mine.probe = true; mine.probeGeneration = pause.probe.generation; mine.probeAt = pause.probe.at;
      }
      const slot = { ...mine, spawnAt: all.find(s => s.jobId === ctx.jobId)?.spawnAt ?? null, state: "running", admittedAt: iso(now), aboveMin };
      writeSlot(home, slot);
      writeJsonAtomic(path.join(home, "timing.json"), { ...timing, lastStart: iso(now), ...(aboveMin ? { lastAboveMin: iso(now) } : {}) });
      return { admit: true, slot, record: recordFor(slot, machine.notes) };
    });
    const key = `${home}:${ctx.jobId}`;
    if (decision.locked) { lockWaits.delete(key); return decision.value; }
    const reason = lockReason(home, ctx.jobId, decision.holder, deps);
    return { admit: false, reason, waitKind: "lock", retryMs: DEFAULTS.pollMs, slot: null, record: recordFor(mine, machine.notes, reason, "lock") };
  } catch (e) { return bypass(ctx, e); }
}
// A warm worker keeps its weight, but every new turn/replacement refreshes pacing
// and memory allowance through exactly the same gate.
export const checkBackend = admit;

export function releaseSlot(home, jobId, me, injected = {}) {
  const deps = dependencies(injected);
  try {
    return lock(home, deps, () => {
      const file = slotFile(home, jobId), s = readJsonOrNull(file);
      if (!s || s.pid !== me.pid || s.processStart !== me.startTime) return false;
      // A failed close or a dead predecessor with a live server stays counted.
      if (serversAlive(readJob(s.jobDir), deps)) return false;
      fs.rmSync(file, { force: true });
      const p = pauseRead(home, s.backend, deps, true);
      if (p?.probe?.jobId === jobId && p.probe.pid === me.pid && p.probe.startTime === me.startTime) { p.probe = null; pauseWrite(home, s.backend, p); }
      return true;
    }).value ?? false;
  } catch { return false; }
}

export function classifyRefusal(backend, error) {
  try {
    const text = [error?.message, error?.data?.message, error?.data?.data?.message].filter(s => typeof s === "string").join("\n").slice(0, 4000);
    let kind, code;
    if (backend === "codex") {
      const info = error?.codexErrorInfo ?? error?.data?.codexErrorInfo ?? error?.data?.data?.codexErrorInfo;
      code = typeof info === "string" ? info : info && Object.keys(info)[0];
      kind = ({ usageLimitExceeded: "usage", rateLimitExceeded: "rate" })[code];
    } else if (backend === "kimi") {
      kind = /reached your (?:5-hour|weekly|monthly)\b[^.\n]*usage limit/i.test(text) ? "usage" : /reached your concurrent request limit/i.test(text) ? "concurrency" : /too many requests/i.test(text) ? "rate" : null;
      const status = Number(error?.data?.details?.statusCode ?? error?.data?.statusCode ?? error?.data?.data?.details?.statusCode);
      code = Number.isFinite(status) ? String(status) : kind === "rate" ? "429" : "403";
    } else if (backend === "zcode") {
      code = /^\d{4}$/.test(String(error?.data?.code)) ? String(error.data.code) : /\[(\d{4})\]|\bcode (\d{4})\b/.exec(text)?.slice(1).find(Boolean);
      kind = ["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"].includes(code) ? "usage" : code === "1302" ? "rate" : null;
    }
    if (!kind) return null;
    const instant = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))\b/.exec(text)?.[1];
    return { kind, code, message: String(error?.message ?? "").split(/\r?\n/)[0].slice(0, 300), resetAt: instant && Number.isFinite(Date.parse(instant)) ? instant : null };
  } catch { return null; }
}
export function recordRefusal(home, backend, refusal, jobId, injected = {}) {
  const deps = dependencies(injected);
  try {
    if (!admissionEnabled(deps.env, deps.readUserConfig(deps.env))) return null;
    return lock(home, deps, () => {
      const now = deps.now(), old = pauseRead(home, backend, deps, true);
      const same = old?.kind === refusal.kind;
      const strikes = same ? old.strikes + ((now >= Date.parse(old.until) || old.lastJobId !== jobId) ? 1 : 0) : 1;
      const reset = Date.parse(refusal.resetAt);
      const provider = refusal.kind === "usage" && reset > now && reset <= now + DEFAULTS.pauseExpiryMs;
      const duration = refusal.kind === "usage" ? DEFAULTS.usagePauseMs : refusal.kind === "concurrency" ? DEFAULTS.concurrencyPauseMs : Math.min(DEFAULTS.ratePauseMs * 2 ** Math.min(strikes - 1, 20), DEFAULTS.maxRatePauseMs);
      const p = { v: 1, backend, ...refusal, since: same ? old.since : iso(now), updatedAt: iso(now), until: iso(provider ? reset : now + Math.min(duration, DEFAULTS.pauseExpiryMs)), strikes, resetSource: provider ? "provider" : "default", lastJobId: jobId, probe: null };
      pauseWrite(home, backend, p); return p;
    }).value ?? null;
  } catch { return null; }
}
export function probeSucceeded(home, backend, jobId, injected = {}, generation = null) {
  const deps = dependencies(injected);
  try { return lock(home, deps, () => {
    const p = pauseRead(home, backend, deps, false, true);
    if (!p?.probe || p.probe.jobId !== jobId || !generation || p.probe.generation !== generation) return false;
    fs.rmSync(pauseFile(home, backend), { force: true }); return true;
  }).value ?? false; } catch { return false; }
}
export function listPauses(env = process.env, injected = {}) {
  const deps = dependencies({ ...injected, env });
  try {
    if (!admissionEnabled(env, deps.readUserConfig(env))) return [];
    return backends.map(b => pauseRead(admissionHome(env), b, deps, false, true)).filter(Boolean).map(p => ({ backend: p.backend, kind: p.kind, code: p.code, until: p.until, strikes: p.strikes, probing: Boolean(p.probe && age(deps.now(), p.probe.at, DEFAULTS.probeMs)) }));
  } catch { return []; }
}
export function describeGuard(env = process.env, { readSensors = true } = {}, injected = {}) {
  const deps = dependencies({ ...injected, env });
  try {
    const enabled = admissionEnabled(env, deps.readUserConfig(env));
    if (!enabled) return { enabled, reason: String(env.RELAY_ADMISSION).toLowerCase() === "off" ? "RELAY_ADMISSION=off" : "setup", pauses: [] };
    const home = admissionHome(env), pauses = listPauses(env, deps);
    if (!readSensors) return { enabled, pauses };
    const machine = machineReading(home, deps), all = slots(home, deps, false);
    const running = all.filter(s => s.state === "running");
    const legacy = legacyJobs(home, null, all, deps);
    return { enabled, ...machine, state: machineState(machine).state, ...guardSettings(deps.readUserConfig(env), machine), usedWeight: running.reduce((n, s) => n + s.weight, 0) + legacy.length * WEIGHTS.medium,
      veryHeavy: running.filter(s => s.class === "very-heavy").length, waiting: all.filter(s => s.state !== "running").length, pauses };
  } catch (e) { return { enabled: true, error: e.message, pauses: [] }; }
}
export function renderGuard(snapshot) {
  if (!snapshot.enabled) return [`load-guard: off (${snapshot.reason})`];
  if (snapshot.error) return [`load-guard: on (state unreadable: ${snapshot.error})`];
  const state = (snapshot.notes ?? []).some(n => n.includes("readings unavailable")) ? `readings unavailable (${snapshot.state})` : snapshot.state;
  const memory = snapshot.availableBytes === null ? "memory not read" : `memory ${(snapshot.availableBytes / GiB).toFixed(1)} of ${(snapshot.totalBytes / GiB).toFixed(1)} GiB available`;
  return [`load-guard: on · ${state} · weight ${snapshot.usedWeight} of ${snapshot.minWeight} minimum, ceiling ${snapshot.maxWeight} · very heavy ${snapshot.veryHeavy} of ${snapshot.maxVeryHeavy} · ${memory} · load ${snapshot.load5 ?? "not read"} on ${snapshot.cores} cores`,
    ...(snapshot.notes ?? []).map(n => `note: load guard: ${n}`), ...(snapshot.pauses ?? []).map(p => `paused: ${refusalReason(p)}; strike ${p.strikes}`)];
}

// Reserve a waiting-worker place and spawn while holding the admission lock. The
// caller owns retries; completing workers never launch another session's jobs.
export function spawnWithAdmission(jobDir, env, spawn, injected = {}) {
  const deps = dependencies({ ...injected, env });
  let spawned = null;
  let spawnAttempted = false;
  const launch = () => { spawnAttempted = true; return spawn(); };
  try {
    const config = deps.readUserConfig(env);
    if (!admissionEnabled(env, config)) return launch();
    const home = admissionHome(env), machine = machineReading(home, deps), settings = guardSettings(config, machine), job = readJob(jobDir);
    const decision = lock(home, deps, () => {
      const all = slots(home, deps), existing = all.find(s => s.jobId === job.id);
      if (existing && ((existing.state === "spawning" && age(deps.now(), existing.since, DEFAULTS.spawnGraceMs)) || deps.isAlive({ pid: existing.pid, startTime: existing.processStart }))) return null;
      const waiting = all.filter(s => s.state !== "running").length;
      const bound = Math.max(DEFAULTS.minWaitingWorkers, settings.maxWeight * DEFAULTS.waitingPerCeiling);
      let reason = machineState(machine).state === "critical" ? machineState(machine).detail : waiting >= bound ? `waiting worker limit: ${waiting} of ${bound}` : null;
      // Pending spawn allowances are included, so a synchronized queue cannot
      // consume the critical floor before its worker readings become visible.
      const spawnReserve = all.filter(s => s.state !== "running" && age(deps.now(), s.spawnAt ?? s.since, DEFAULTS.reserveMs)).reduce((n, s) => n + PENDING_BYTES[s.class], 0);
      const cls = modelClass(job.request, settings.modelClasses);
      if (!reason && machine.availableBytes !== null && machine.availableBytes - spawnReserve - PENDING_BYTES[cls] < Math.max(DEFAULTS.criticalGiB * GiB, machine.totalBytes * DEFAULTS.criticalFraction)) reason = "machine critical: memory reserved for waiting workers";
      if (reason) {
        writeJob(jobDir, { ...job, state: "queued", worker: null, admission: { state: "waiting", reason, waitKind: "worker", since: job.admission?.since ?? iso(deps.now()), class: cls, weight: WEIGHTS[cls], notes: machine.notes } });
        return null;
      }
      const slot = { v: 1, jobId: job.id, jobDir, pid: null, processStart: null, backend: job.request.backend ?? "codex", class: cls, weight: WEIGHTS[cls], state: "spawning", spawnAt: iso(deps.now()), since: iso(deps.now()) };
      writeSlot(home, slot);
      try { spawned = launch(); return spawned; }
      catch (e) { fs.rmSync(slotFile(home, job.id), { force: true }); throw e; }
    });
    if (!decision.locked) {
      writeJob(jobDir, { ...job, state: "queued", worker: null, admission: { state: "waiting", waitKind: "worker", reason: lockReason(home, job.id, decision.holder, deps), since: job.admission?.since ?? iso(deps.now()), notes: [] } });
      return null;
    }
    lockWaits.delete(`${home}:${job.id}`);
    return decision.value;
  } catch (e) {
    if (spawnAttempted) throw e;
    process.stderr.write(`relay load guard: worker spawn bypassed (${e.message})\n`);
    return spawn();
  }
}
