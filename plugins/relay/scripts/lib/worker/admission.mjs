// Shared per-user launch admission. Sensor failures skip that sensor; guard failures
// bypass with a visible note. A live lock is never broken or bypassed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
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
// Admission alone uses this bounded batch cache, including ownership and legacy reads.
const processCaches = new Map();
export function holderAlive(identity, { platform = process.platform, now = Date.now(), ps = spawnSync } = {}) {
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
  return { env, now, random: Math.random, readUserConfig, 
    isAlive: identity => holderAlive(identity, { platform: deps.platform, now: now() }), ...deps };
}
function lock(home, deps, fn) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "admission.lock");
  if (!acquireOwnership(file, { ...self(deps), since: iso(deps.now()) }, { isAlive: deps.isAlive })) return { locked: false, holder: readOwnership(file, { isAlive: deps.isAlive }) };
  try { return { locked: true, value: fn() }; }
  finally { releaseOwnership(file); }
}
function files(dir) { try { return fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
function slotFile(home, id) { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid job id"); return path.join(home, "slots", `${id}.json`); }
function writeSlot(home, slot) { fs.mkdirSync(path.join(home, "slots"), { recursive: true }); writeJsonAtomic(slotFile(home, slot.jobId), slot); }
function serversAlive(job, deps) {
  return [job?.server, ...(job?.attempts ?? []).flatMap(a => a.servers ?? [])].some(s => s?.pid && !s.endedAt && deps.isAlive(s));
}
function slots(home, deps, clean = true) {
  const result = [];
  for (const name of files(path.join(home, "slots"))) {
    const file = path.join(home, "slots", name);
    if (name.endsWith(".tmp")) { if (clean && deps.now() - fs.statSync(file).mtimeMs > 60000) fs.rmSync(file, { force: true }); continue; }
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const s = readJsonOrNull(file);
    if (!s || s.v !== 1 || !Object.hasOwn(WEIGHTS, s.class) || !["waiting", "running", "spawning"].includes(s.state)) {
      if (clean && deps.now() - fs.statSync(file).mtimeMs > 10000) fs.rmSync(file, { force: true }); continue;
    }
    const live = (s.state === "spawning" && age(deps.now(), s.since, DEFAULTS.spawnGraceMs)) || deps.isAlive({ pid: s.pid, startTime: s.processStart });
    if (live || serversAlive(readJob(s.jobDir), deps)) result.push(s);
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
export function releaseSlot(home, jobId, me, injected = {}) {
  const deps = dependencies(injected);
  try {
    return lock(home, deps, () => {
      const file = slotFile(home, jobId), s = readJsonOrNull(file);
      if (!s || s.pid !== me.pid || s.processStart !== me.startTime) return false;
      // A failed close or a dead predecessor with a live server stays counted.
      if (serversAlive(readJob(s.jobDir), deps)) return false;
      fs.rmSync(file, { force: true });
      return true;
    }).value ?? false;
  } catch { return false; }
}
