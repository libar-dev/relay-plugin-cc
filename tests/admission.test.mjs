import "./support/isolate-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS as D, WEIGHTS, admissionHome, guardSettings, modelClass, machineState, readMachineDefault, holderAlive, renderGuard, describeGuard, admit, releaseSlot, spawnWithAdmission } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { acquireOwnership, releaseOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";
import { computeJobView } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { retryQueuedWorker } from "../plugins/relay/scripts/lib/worker/delivery.mjs";
import { writeJob, readJob, writeJsonAtomic } from "../plugins/relay/scripts/lib/jobs/store.mjs";
const GiB = 2 ** 30;
function setup(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "domain");
  let now = Date.parse("2025-01-01T00:00:00Z");
  let machine = { totalBytes: 128 * GiB, availableBytes: 100 * GiB, cores: 64, load5: 0, notes: [] };
  let legacy = [];
  const live = new Set([process.pid]);
  const env = { RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: home, RELAY_JOBS_HOME: path.join(root, "jobs") };
  const deps = { env, now: () => now, readMachine: () => machine, isAlive: p => live.has(p?.pid) && p?.startTime !== "reused", readAdmissionConfig: () => config, scanUnslotted: () => legacy, random: () => 0 };
  let seq = 0;
  const ctx = (request = {}, jobId = `job-${++seq}`) => {
    const pid = 100000 + seq; live.add(pid);
    const dir = path.join(root, jobId); fs.mkdirSync(dir, { recursive: true });
    return { home, jobId, jobDir: dir, me: { pid, startTime: "synthetic" }, request: { backend: "codex", effort: D.lightEfforts[0], ...request } };
  };
  return { home, root, env, deps, ctx, live, tick: (ms = D.spacingMs) => now += ms, setMachine: m => machine = { ...machine, ...m }, setLegacy: jobs => legacy = jobs };
}

test("defaults use exact RAM, seats and backend bytes; mandatory quota cannot be demoted", () => {
  for (const total of [7.3, 19.7, 37.2, 95.4]) {
    const settings = guardSettings({}, { totalBytes: total * GiB, cores: 10 });
    assert.equal(settings.headroomBytes, Math.max(2 * GiB, total * GiB * 0.15));
    assert.equal(settings.busySeats, 8);
    assert.equal(settings.maxActive, null);
    assert.equal(settings.maxWaitingWorkers, 16);
  }
  assert.equal(guardSettings({ maxVeryHeavy: 100 }).maxVeryHeavy, 2);
  assert.equal(guardSettings({ maxVeryHeavy: 1 }).maxVeryHeavy, 1);
  for (const effort of ["high", "xhigh", "default"]) assert.notEqual(modelClass({ model: "ordinary", effort }), "very-heavy");
  for (const request of [{ model: "astra" }, { backend: "kimi", model: "kimi-k3-preview" }, { effort: "max" }, { effort: "ultra" }]) {
    assert.equal(modelClass(request, [{ pattern: "*", class: "light" }]), "very-heavy");
  }
});

test("critical memory and load block even the first job; headroom applies inside the minimum", t => {
  const s = setup(t), c = s.ctx();
  const total = 128 * GiB;
  s.setMachine({ availableBytes: Math.max(D.criticalGiB * GiB, total * D.criticalFraction) - 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
  s.setMachine({ availableBytes: 100 * GiB, load5: D.criticalLoadPerCore * 64 + 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
  s.setMachine({ load5: 0, availableBytes: guardSettings({}, { totalBytes: total, cores: 64 }).headroomBytes + D.startupBytes.codex - 1 });
  assert.equal(admit(c, s.deps).waitKind, "memory");
});

test("global pacing survives quick completion; turns reuse weight and refresh reserve", t => {
  const s = setup(t), first = s.ctx();
  assert.equal(admit(first, s.deps).admit, true);
  const second = s.ctx({ backend: "kimi" });
  assert.equal(admit(second, s.deps).waitKind, "stagger");
  assert.equal(releaseSlot(s.home, first.jobId, first.me, s.deps), true);
  s.tick(D.spacingMs - 1);
  assert.equal(admit(second, s.deps).waitKind, "stagger");
  s.tick(1);
  assert.equal(admit(second, s.deps).admit, true);
  s.tick(D.spacingMs);
  assert.equal(admit(second, s.deps).admit, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "slots", `${second.jobId}.json`))).weight, WEIGHTS.light);
});

test("pending reservations include the new job and expire; delayed growth still blocks", t => {
  const s = setup(t), c = s.ctx();
  const headroom = guardSettings({}, { totalBytes: 128 * GiB, cores: 64 }).headroomBytes;
  s.setMachine({ availableBytes: headroom + 2 * D.startupBytes.codex - 1 });
  assert.equal(admit(c, s.deps).admit, true);
  s.tick(D.spacingMs);
  const next = s.ctx();
  assert.equal(admit(next, s.deps).waitKind, "memory");
  s.tick(D.reserveMs);
  assert.equal(admit(next, s.deps).admit, true);
  s.tick(D.reserveMs);
  s.setMachine({ availableBytes: headroom - 1 });
  assert.equal(admit(s.ctx(), s.deps).waitKind, "memory");
});

test("healthy hosts can retain forty seats and admit the forty-first with five-second spacing", t => {
  const s = setup(t);
  s.setMachine({ totalBytes: 18 * GiB, availableBytes: 10 * GiB, cores: 12 });
  for (let i = 0; i < 41; i++) {
    assert.equal(admit(s.ctx({ model: "ordinary", effort: "high" }), s.deps).admit, true);
    s.tick(D.spacingMs);
  }
});

for (const cores of [8, 12]) for (const unknown of [false, true]) test(`busy allowance for ${cores} cores, bytes unknown=${unknown}`, t => {
  const s = setup(t), count = cores - 2;
  s.setMachine({ cores, availableBytes: unknown ? null : 100 * GiB, load5: unknown ? null : 1.5 * cores });
  const occupied = [];
  for (let n = 0; n < count; n++) { const c = s.ctx(); occupied.push(c); assert.equal(admit(c, s.deps).admit, true); s.tick(); }
  const next = s.ctx();
  assert.equal(admit(next, s.deps).waitKind, "seats");
  assert.equal(admit(occupied[0], s.deps).admit, true, "warm seat remains usable at F");
  s.tick(); s.setMachine({ availableBytes: 100 * GiB, load5: 0 });
  assert.equal(admit(next, s.deps).admit, true);
});

test("quota includes legacy jobs and rechecks warm selections without blocking ordinary work", t => {
  const s = setup(t), warm = s.ctx({ model: "ordinary", effort: "high" });
  assert.equal(admit(warm, s.deps).admit, true); s.tick();
  for (let n = 0; n < 2; n++) { assert.equal(admit(s.ctx({ model: "astra" }), s.deps).admit, true); s.tick(); }
  assert.equal(admit({ ...warm, request: { ...warm.request, effort: "max" } }, s.deps).waitKind, "very-heavy");
  assert.equal(admit(s.ctx({ model: "ordinary", effort: "high" }), s.deps).admit, true);
  s.tick();
  assert.equal(admit(s.ctx({ model: "default", effort: "default" }), s.deps).admit, true);
  const legacy = setup(t), c = legacy.ctx();
  legacy.setLegacy([1, 2].map(n => ({ id: `old-${n}`, state: "running", worker: c.me, request: { model: "astra" } })));
  assert.equal(admit(legacy.ctx({ model: "astra" }), legacy.deps).waitKind, "very-heavy");
});

test("fairness uses fewest active seats, then oldest eligible claimant", t => {
  const s = setup(t); s.setMachine({ cores: 4, load5: 6 });
  const occupied = [s.ctx(), s.ctx()];
  for (const c of occupied) { assert.equal(admit(c, s.deps).admit, true); s.tick(); }
  const waiter = s.ctx({ backend: "kimi" });
  assert.equal(admit(waiter, s.deps).waitKind, "seats");
  releaseSlot(s.home, occupied[0].jobId, occupied[0].me, s.deps);
  assert.equal(admit(s.ctx(), s.deps).waitKind, "fair-share");
  assert.equal(admit(waiter, s.deps).admit, true);
});

for (const blocked of ["stale", "memory", "pause", "quota"]) test(`fairness ignores ${blocked} claimants`, t => {
  const s = setup(t); s.setMachine({ cores: 4, load5: 6 });
  const occupied = [s.ctx(), s.ctx()];
  for (const c of occupied) { admit(c, s.deps); s.tick(); }
  const waiter = s.ctx({ backend: "kimi", effort: blocked === "quota" ? "max" : "high" });
  admit(waiter, s.deps);
  if (blocked === "stale") s.tick(D.claimantPolls * D.pollMs);
  if (blocked === "pause") {
    fs.mkdirSync(path.join(s.home, "pauses"), { recursive: true });
    writeJsonAtomic(path.join(s.home, "pauses", "kimi.json"), { v: 1, backend: "kimi", kind: "usage", updatedAt: new Date(s.deps.now()).toISOString(), until: new Date(s.deps.now() + 100000).toISOString() });
  }
  if (blocked === "memory") s.setMachine({ availableBytes: guardSettings({}, { totalBytes: 128 * GiB, cores: 4 }).headroomBytes + 0.75 * GiB });
  if (blocked === "quota") { s.setMachine({ load5: 0 }); s.setLegacy([1, 2].map(n => ({ id: `heavy-${n}`, state: "running", worker: occupied[1].me, request: { model: "astra" } }))); }
  releaseSlot(s.home, occupied[0].jobId, occupied[0].me, s.deps);
  s.tick(D.reserveMs); // Expire holds; stale contender is refreshed in applicable cases.
  if (blocked !== "stale") admit(waiter, s.deps);
  const result = admit(s.ctx(), s.deps);
  assert.equal(result.admit, true, result.reason);
});

test("stale slots and reused pids are reclaimed but recorded live backends stay counted", t => {
  const s = setup(t), c = s.ctx();
  admit(c, s.deps); s.live.delete(c.me.pid); s.tick();
  admit(s.ctx(), s.deps);
  assert.equal(fs.existsSync(path.join(s.home, "slots", `${c.jobId}.json`)), false);
  const orphan = s.ctx(); admit(orphan, s.deps); // spacing: waiting also retains the live server
  const serverPid = 999999; s.live.add(serverPid);
  writeJob(orphan.jobDir, { id: orphan.jobId, state: "failed", server: { pid: serverPid, startTime: "synthetic" } });
  s.live.delete(orphan.me.pid); s.tick(); admit(s.ctx(), s.deps);
  assert.equal(fs.existsSync(path.join(s.home, "slots", `${orphan.jobId}.json`)), true);
  assert.equal(releaseSlot(s.home, orphan.jobId, orphan.me, s.deps), false);
});

test("legacy membership reconciles against current slots and ignores current/queued/ended jobs", t => {
  const s = setup(t), c = s.ctx();
  s.setLegacy([{ id: c.jobId, state: "starting", worker: c.me }, { id: "ended", state: "completed", worker: c.me }, { id: "queued", state: "queued", worker: c.me }]);
  assert.equal(admit(c, s.deps).admit, true);
  s.setLegacy([{ id: c.jobId, state: "running", worker: c.me }]);
  s.tick();
  const second = s.ctx();
  assert.equal(admit(second, s.deps).admit, true);
});

test("live locks keep waiting beyond the stuck threshold; off bypasses without files", t => {
  const s = setup(t), c = s.ctx();
  fs.mkdirSync(s.home, { recursive: true });
  const file = path.join(s.home, "admission.lock");
  acquireOwnership(file, { pid: process.pid, startTime: null, since: "2025-01-01T00:00:00Z" });
  try {
    assert.equal(admit(c, s.deps).waitKind, "lock");
    s.tick(D.stuckLockMs);
    assert.match(admit(c, s.deps).reason, /admission lock stuck .*RELAY_ADMISSION=off bypasses/);
    assert.equal(admit(c, { ...s.deps, env: { ...s.env, RELAY_ADMISSION: "OFF" } }).record.state, "bypassed");
  } finally { releaseOwnership(file); }
});

test("sensor and guard failures degrade visibly; corrupt slots do not crash", t => {
  const s = setup(t), c = s.ctx();
  const unknown = admit(c, { ...s.deps, readMachine() { throw new Error("synthetic sensor failure"); } });
  assert.equal(unknown.admit, true); assert.match(unknown.record.notes[0], /sensors not read/);
  s.tick();
  fs.writeFileSync(path.join(s.home, "slots", "corrupt.json"), "{");
  assert.equal(admit(s.ctx(), s.deps).admit, true);
  const bypass = admit(s.ctx(), { ...s.deps, readAdmissionConfig() { throw new Error("synthetic failure"); } });
  assert.equal(bypass.record.state, "bypassed");
});

test("macOS uses free+inactive, actual page size, pressure bits and cached zero", t => {
  const s = setup(t), total = 40 * GiB;
  const sensor = { totalmem: () => total, availableParallelism: () => 12, loadavg: () => [0, 0, 0], freemem() { throw new Error("must not read raw free pages"); } };
  let free = 123, inactive = 456, pressure = 1, calls = 0;
  const sysctl = (bin, args, options) => {
    calls++;
    assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 64 * 1024);
    if (bin === "/usr/bin/vm_stat") return { status: 0, stdout: `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${free}.\nPages inactive: ${inactive}.\nPages speculative: 999999.\n` };
    assert.deepEqual(args, ["-n", "kern.memorystatus_vm_pressure_level"]);
    return { status: 0, stdout: String(pressure) };
  };
  const read = now => readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now, sysctl });
  assert.equal(read(1).availableBytes, (free + inactive) * 16384);
  free = inactive = 0; pressure = 2;
  const zero = read(D.sensorCacheMs + 2);
  assert.equal(zero.availableBytes, 0);
  const count = calls; assert.equal(read(D.sensorCacheMs + 3).availableBytes, 0); assert.equal(calls, count);
  for (const p of [2, 4, 6]) assert.equal(machineState({ ...zero, availableBytes: total, pressure: p }).state, "critical");
  assert.equal(machineState({ ...zero, availableBytes: null, load5: null, pressure: 4 }).state, "critical");
  const failed = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now: D.sensorCacheMs * 2 + 3, sysctl: () => ({ status: 1 }) });
  assert.equal(failed.availableBytes, null); assert.match(failed.notes.join(" "), /memory not read/);
});

test("domain ignores custom jobs homes; spawn reservations bound waiting workers and critical starts", t => {
  const s = setup(t);
  assert.equal(admissionHome({ RELAY_JOBS_HOME: "/synthetic/a" }), admissionHome({ RELAY_JOBS_HOME: "/synthetic/b" }));
  const bound = guardSettings({}, { totalBytes: 128 * GiB, cores: 64 }).maxWaitingWorkers;
  let spawns = 0;
  for (let n = 0; n < bound + 1; n++) {
    const c = s.ctx(); writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
    const result = spawnWithAdmission(c.jobDir, s.env, () => ++spawns, s.deps);
    if (n === bound) { assert.equal(result, null); assert.equal(readJob(c.jobDir).state, "queued"); }
  }
  assert.equal(spawns, bound);
  s.setMachine({ availableBytes: 0 });
  const c = s.ctx(); writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => ++spawns, s.deps), null);
  assert.match(readJob(c.jobDir).admission.reason, /critical/);
});

test("Windows admission is a visible no-op even with stale files and failed sensors", t => {
  const s = setup(t), c = s.ctx();
  const before = fs.readdirSync(s.root);
  const deps = { ...s.deps, platform: "win32", readAdmissionConfig() { throw new Error("no config read"); }, readMachine() { throw new Error("no sensor read"); } };
  assert.match(admit(c, deps).record.notes.join(" "), /unsupported on win32/);
  let launched = 0;
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => ++launched, deps), 1);
  assert.deepEqual(fs.readdirSync(s.root), before);
  assert.equal(holderAlive({ pid: 2147483647 }, { platform: "win32", ps() { throw new Error("no ps"); } }), false);
  assert.equal(holderAlive({ pid: process.pid }, { platform: "win32" }), true);
});

test("Linux cgroup headroom uses every ancestor and caches per cgroup, never across siblings", t => {
  const s = setup(t);
  const sensor = { totalmem: () => 128 * GiB, availableParallelism: () => 64, loadavg: () => [0, 0, 0], freemem: () => 100 * GiB };
  const limits = new Map([
    ["/proc/self/cgroup", "0::/session/worker\n"],
    ["/sys/fs/cgroup/session/worker/memory.max", "max"],
    ["/sys/fs/cgroup/session/memory.max", String(20 * GiB)],
    ["/sys/fs/cgroup/session/memory.current", String(16 * GiB)]
  ]);
  let reads = 0;
  const readFile = file => {
    reads++;
    if (file === "/proc/meminfo") return `MemAvailable: ${100 * GiB / 1024} kB\n`;
    if (!limits.has(file)) throw Object.assign(new Error("no file"), { code: "ENOENT" });
    return limits.get(file);
  };
  const first = readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile, now: 1 });
  assert.equal(first.availableBytes, sensor.freemem());
  assert.equal(first.scopes[0].remainingBytes, 4 * GiB);
  assert.deepEqual(first.notes, []);
  assert.match(renderGuard(describeGuard(s.env, {}, { ...s.deps, readMachine: () => first })).join("\n"), /load-guard: on · healthy/);
  const count = reads;
  limits.set("/sys/fs/cgroup/session/memory.current", String(19 * GiB));
  assert.equal(readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile, now: 2 }).scopes[0].remainingBytes, 4 * GiB);
  assert.equal(reads, count);
  assert.equal(readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile, now: D.sensorCacheMs + 2 }).scopes[0].remainingBytes, GiB);
  const otherFile = file => file === "/proc/self/cgroup" ? "0::/other\n" : "max";
  assert.equal(readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile: otherFile, now: D.sensorCacheMs + 2 }).availableBytes, sensor.freemem());
});

test("blocked Linux proc/sys readings degrade visibly and preserve readable memory/load", t => {
  const s = setup(t), sensor = { totalmem: () => 128 * GiB, availableParallelism: () => 64, loadavg: () => [0, 0, 0], freemem: () => 100 * GiB };
  for (const blocked of ["proc", "sys"]) {
    const readFile = file => {
      if (file === "/proc/self/cgroup" && blocked !== "proc") return "0::/session\n";
      throw Object.assign(new Error("synthetic permission denied"), { code: "EACCES" });
    };
    const machine = readMachineDefault({ home: path.join(s.home, blocked), env: {}, platform: "linux", sensor, readFile });
    assert.equal(machine.availableBytes, sensor.freemem());
    assert.equal(machine.load5, 0);
    assert.match(machine.notes.join(" "), /readings unavailable: cgroup/);
    assert.equal(machineState(machine).state, "healthy");
    assert.match(renderGuard({ enabled: true, ...machine, ...guardSettings({}, machine), state: "healthy", usedWeight: 0, veryHeavy: 0, pauses: [] }).join("\n"), /load-guard: on · readings unavailable/);
  }
});

test("a failed cgroup ancestor is skipped while readable constraints still apply", t => {
  const s = setup(t), sensor = { totalmem: () => 128 * GiB, availableParallelism: () => 64, loadavg: () => [0, 0, 0], freemem: () => 100 * GiB };
  const readFile = file => {
    if (file === "/proc/self/cgroup") return "0::/session/worker\n";
    if (file.startsWith("/sys/fs/cgroup/session/worker/")) return file.endsWith("memory.max") ? String(12 * GiB) : String(9 * GiB);
    throw Object.assign(new Error("synthetic denied ancestor"), { code: "EACCES" });
  };
  const machine = readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile });
  assert.equal(machine.availableBytes, sensor.freemem());
  assert.equal(machine.scopes[0].remainingBytes, 3 * GiB);
  assert.match(machine.notes.join(" "), /readings unavailable/);
});

test("small finite scopes use their own margin; structural impossibility fails permanently", t => {
  const s = setup(t), c = s.ctx({ backend: "kimi" });
  const scope = limit => ({ id: "/synthetic", limitBytes: limit * GiB, currentBytes: 0, remainingBytes: limit * GiB });
  s.setMachine({ group: "/synthetic", scopes: [scope(2)] });
  assert.equal(admit(c, s.deps).admit, true);
  s.tick();
  s.setMachine({ scopes: [scope(0.75)] });
  const failed = admit(s.ctx({ backend: "kimi" }), s.deps);
  assert.equal(failed.permanent, true); assert.match(failed.reason, /raise the limit/);
  s.setMachine({ totalBytes: GiB, scopes: [] });
  assert.equal(admit(s.ctx(), s.deps).permanent, true);
});

test("sibling holds spend only shared ancestors, with unknown membership charged conservatively", t => {
  const s = setup(t);
  const scope = (id, remaining = 2) => ({ id, limitBytes: 2 * GiB, currentBytes: (2 - remaining) * GiB, remainingBytes: remaining * GiB });
  s.setMachine({ group: "/parent/a", scopes: [scope("/parent/a"), { ...scope("/parent"), limitBytes: 10 * GiB, remainingBytes: 10 * GiB }] });
  assert.equal(admit(s.ctx({ backend: "kimi" }), s.deps).admit, true); s.tick();
  s.setMachine({ group: "/parent/b", scopes: [scope("/parent/b", 1.25), { ...scope("/parent"), limitBytes: 10 * GiB, remainingBytes: 10 * GiB }] });
  assert.equal(admit(s.ctx({ backend: "kimi" }), s.deps).admit, true); s.tick();
  s.setMachine({ group: "/parent/c", scopes: [scope("/parent/c"), { ...scope("/parent"), limitBytes: 10 * GiB, remainingBytes: 3 * GiB }] });
  assert.equal(admit(s.ctx({ backend: "kimi" }), s.deps).waitKind, "scope");
  s.tick(D.reserveMs);
  s.setMachine({ group: null, scopes: [] });
  assert.equal(admit(s.ctx({ backend: "kimi" }), s.deps).admit, true); s.tick();
  s.setMachine({ group: "/other", scopes: [scope("/other", 1.2)] });
  assert.equal(admit(s.ctx({ backend: "kimi" }), s.deps).waitKind, "scope");
});

test("worker and backend holds share host budget; admission replaces its own worker hold in actual scope", t => {
  const s = setup(t), first = s.ctx();
  const reserve = guardSettings({}, { totalBytes: 128 * GiB, cores: 64 }).headroomBytes;
  s.setMachine({ availableBytes: reserve + D.startupBytes.codex + D.workerBytes - 1 });
  assert.equal(admit(first, s.deps).admit, true); s.tick();
  const queued = s.ctx(); writeJob(queued.jobDir, { id: queued.jobId, state: "starting", request: queued.request });
  assert.equal(spawnWithAdmission(queued.jobDir, s.env, () => 123, s.deps), null);
  assert.match(readJob(queued.jobDir).admission.reason, /host memory/);
  releaseSlot(s.home, first.jobId, first.me, s.deps);
  assert.equal(spawnWithAdmission(queued.jobDir, s.env, () => 123, s.deps), 123);
  s.setMachine({ availableBytes: reserve + D.startupBytes.codex, group: "/actual-worker", scopes: [{ id: "/actual-worker", limitBytes: GiB, currentBytes: 0, remainingBytes: GiB }] });
  assert.equal(admit(queued, s.deps).admit, true);
  s.tick(); assert.equal(admit(queued, s.deps).admit, true, "own hold is refreshed, never counted twice");
});

test("wait episodes preserve closed timing through warm grants and reset only on a new wait", t => {
  const s = setup(t), c = s.ctx();
  s.setMachine({ availableBytes: 0 });
  const waiting = admit(c, s.deps).record;
  s.tick(D.spacingMs); s.setMachine({ availableBytes: 100 * GiB });
  const admitted = admit({ ...c, waitingSince: waiting.since, admission: waiting }, s.deps).record;
  assert.equal(admitted.since, waiting.since); assert.ok(Date.parse(admitted.admittedAt) > Date.parse(admitted.since));
  s.tick(); const warm = admit({ ...c, admission: admitted }, s.deps).record;
  assert.equal(warm.since, admitted.since); assert.equal(warm.admittedAt, admitted.admittedAt);
  s.tick(); s.setMachine({ availableBytes: 0 });
  const next = admit({ ...c, admission: warm }, s.deps).record;
  assert.notEqual(next.since, admitted.since);
});

test("Linux MemAvailable is independent of cgroup headroom; mismatched CPU load is skipped", t => {
  const s = setup(t);
  const sensor = { totalmem: () => 64 * GiB, availableParallelism: () => 2, cpus: () => Array(8), loadavg() { throw new Error("wrong CPU scope"); } };
  const machine = readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile(file) {
    if (file === "/proc/meminfo") return "MemFree: 1 kB\nMemAvailable: 8388608 kB\n";
    if (file === "/proc/self/cgroup") return "0::/synthetic\n";
    return "max";
  } });
  assert.equal(machine.availableBytes, 8 * GiB); assert.equal(machine.load5, null);
  assert.match(machine.notes.join(" "), /scopes differ/);
});

test("unknown backends use the full startup allowance without provider-pause bypass", t => {
  const s = setup(t), c = s.ctx({ backend: "synthetic" });
  const reserve = guardSettings({}, { totalBytes: 128 * GiB, cores: 64 }).headroomBytes;
  s.setMachine({ availableBytes: reserve + 0.75 * GiB });
  assert.equal(admit(c, s.deps).waitKind, "memory");
  s.setMachine({ availableBytes: reserve + GiB });
  const result = admit(c, s.deps);
  assert.equal(result.admit, true); assert.equal(result.slot.holdBytes, GiB);
});

test("impossible fits fail permanently even behind an active provider pause", t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.home, "pauses"), { recursive: true });
  writeJsonAtomic(path.join(s.home, "pauses", "codex.json"), { v: 1, backend: "codex", kind: "usage", updatedAt: new Date(s.deps.now()).toISOString(), until: new Date(s.deps.now() + 100000).toISOString() });
  s.setMachine({ totalBytes: GiB });
  assert.equal(admit(s.ctx(), s.deps).permanent, true);
});

test("legacy descriptive classes cannot demote mandatory quota selections", t => {
  const s = setup(t);
  const requests = [{ backend: "codex", model: "astra", effort: "high" }, { backend: "grok", model: "ordinary", effort: "max" }];
  for (const request of requests) {
    const c = s.ctx(request);
    assert.equal(admit(c, s.deps).admit, true); s.tick();
    const file = path.join(s.home, "slots", `${c.jobId}.json`);
    const slot = JSON.parse(fs.readFileSync(file));
    writeJob(c.jobDir, { id: c.jobId, state: "running", request: c.request });
    delete slot.effort; // Earlier slots did not retain effort; the job does.
    writeJsonAtomic(file, { ...slot, class: "light", weight: 1, quotaHeavy: false });
  }
  assert.equal(admit(s.ctx({ model: "astra" }), s.deps).waitKind, "very-heavy");
  assert.equal(admit(s.ctx({ model: "ordinary", effort: "high" }), s.deps).admit, true);
});

test("legacy class labels cannot impose quota on ordinary or unknown selections", t => {
  const s = setup(t);
  for (const request of [{ model: "ordinary", effort: "high" }, { model: "default", effort: "default" }]) {
    const c = s.ctx(request); assert.equal(admit(c, s.deps).admit, true); s.tick();
    const file = path.join(s.home, "slots", `${c.jobId}.json`), slot = JSON.parse(fs.readFileSync(file));
    writeJsonAtomic(file, { ...slot, class: "very-heavy", weight: 3, quotaHeavy: true });
  }
  for (let n = 0; n < 2; n++) { assert.equal(admit(s.ctx({ model: "astra" }), s.deps).admit, true); s.tick(); }
  assert.equal(admit(s.ctx({ effort: "max" }), s.deps).waitKind, "very-heavy");
});

for (const signal of [{ load5: 40.9 }, { pressure: 2 }, { load5: 40.9, pressure: 2 }]) {
  test(`CPU critical/warning pressure holds only new jobs: ${JSON.stringify(signal)}`, t => {
    const s = setup(t), warm = s.ctx();
    s.setMachine({ totalBytes: 64 * GiB, availableBytes: 13.8 * GiB, cores: 10 });
    assert.equal(admit(warm, s.deps).admit, true); s.tick();
    s.setMachine(signal);
    const held = admit(s.ctx(), s.deps);
    assert.equal(held.waitKind, "critical");
    assert.match(held.reason, /load|pressure warning/);
    assert.equal(admit(warm, s.deps).admit, true, "next turn/capacity retry retains its seat"); s.tick();
    releaseSlot(s.home, warm.jobId, warm.me, s.deps);
    const replacement = { ...warm, admitted: true };
    assert.equal(admit(replacement, s.deps).admit, true, "replacement backend stays admitted without a live slot"); s.tick();
    releaseSlot(s.home, warm.jobId, warm.me, s.deps);
    writeJob(warm.jobDir, { id: warm.jobId, request: warm.request, state: "starting", firstAdmittedAt: new Date(s.deps.now()).toISOString() });
    assert.equal(spawnWithAdmission(warm.jobDir, s.env, () => 123, s.deps), 123, "replacement worker also stays eligible");
  });
}
for (const signal of [{ availableBytes: 0 }, { pressure: 4, load5: 40.9 }, { pressure: 6 }]) {
  test(`critical memory/pressure holds admitted turns with a reason: ${JSON.stringify(signal)}`, t => {
    const s = setup(t), warm = s.ctx();
    s.setMachine({ totalBytes: 64 * GiB, availableBytes: 13.8 * GiB, cores: 10 });
    assert.equal(admit(warm, s.deps).admit, true); s.tick(); s.setMachine(signal);
    const held = admit(warm, s.deps);
    assert.equal(held.waitKind, "critical"); assert.match(held.record.reason, /memory low|pressure critical/);
  });
}

test("busy sensor refresh keeps recent low-memory samples or waits without unknown-byte admission", t => {
  const s = setup(t);
  const sensor = { totalmem: () => 64 * GiB, availableParallelism: () => 10, loadavg: () => [0, 0, 0] };
  const sysctl = bin => ({ status: 0, stdout: bin.endsWith("vm_stat") ? "page size of 16384 bytes\nPages free: 0.\nPages inactive: 0.\n" : "4" });
  const first = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, sysctl, now: 1 });
  assert.equal(first.availableBytes, 0);
  const owner = path.join(s.home, "machine-darwin.lock");
  acquireOwnership(owner, { pid: process.pid, startTime: null }); t.after(() => releaseOwnership(owner));
  const read = now => readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now, sysctl() { throw new Error("must not refresh"); } });
  for (const now of [D.sensorCacheMs + 2, D.sensorStaleMs - 1, D.sensorStaleMs + 1]) {
    const machine = read(now);
    const result = admit(s.ctx(), { ...s.deps, readMachine: () => machine });
    assert.equal(result.admit, false);
    assert.equal(result.waitKind, machine.refreshing ? "sensor" : "critical");
    if (machine.refreshing) assert.equal(result.reason, "sensor refresh in progress");
    else { assert.equal(machine.availableBytes, 0); assert.equal(machine.pressure, 4); }
  }
});

test("a deferred spawn that exits before saving becomes dead after grace without respawning", t => {
  const s = setup(t), c = s.ctx();
  const since = new Date(s.deps.now() - 120000).toISOString();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "queued", createdAt: since, admission: { state: "waiting", waitKind: "worker", since } });
  let launches = 0;
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => { launches++; return 2147483647; }, s.deps), 2147483647);
  const job = readJob(c.jobDir);
  assert.equal(job.state, "starting"); assert.equal(job.admission.waitKind, "spawned"); assert.equal(job.admission.since, since);
  assert.equal(computeJobView(job, { now: s.deps.now() + 59999 }).state, "starting");
  assert.equal(computeJobView(job, { now: s.deps.now() + 60001 }).state, "dead");
  for (let n = 0; n < 3; n++) assert.equal(retryQueuedWorker(c.jobDir, s.env), null);
  assert.equal(launches, 1);
});

test("short admission-lock contention retries a healthy start before deferring", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  const file = path.join(s.home, "admission.lock"); fs.mkdirSync(s.home, { recursive: true });
  acquireOwnership(file, { pid: process.pid }); t.after(() => releaseOwnership(file));
  const sleeps = [];
  const deps = { ...s.deps, lockSleep: ms => { sleeps.push(ms); releaseOwnership(file); } };
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => 123, deps), 123);
  assert.equal(readJob(c.jobDir).state, "starting"); assert.deepEqual(sleeps, [25]);
});

test("persistent admission-lock contention defers after a bounded short retry", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  const file = path.join(s.home, "admission.lock"); fs.mkdirSync(s.home, { recursive: true });
  acquireOwnership(file, { pid: process.pid }); t.after(() => releaseOwnership(file));
  let total = 0, sleeps = 0;
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("must not launch"), { ...s.deps, lockSleep: ms => { total += ms; sleeps++; } }), null);
  assert.equal(sleeps, 10); assert.ok(total <= 1000); assert.equal(readJob(c.jobDir).state, "queued");
});
