import "./support/isolate-env.mjs";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS as D, WEIGHTS, admissionHome, guardSettings, modelClass, machineState, readMachineDefault, holderAlive, renderGuard, describeGuard, admit, releaseSlot, spawnWithAdmission } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { acquireOwnership, releaseOwnership, readOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";
import { computeJobView } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { retryQueuedWorker } from "../plugins/relay/scripts/lib/worker/delivery.mjs";
import { writeJob, readJob, writeJsonAtomic } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { postInboxMessage } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
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

function fillOtherMinimum(s) {
  const active = Array.from({ length: D.guaranteedOther }, () => s.ctx({ model: "ordinary" }));
  for (const c of active) { assert.equal(admit(c, s.deps).admit, true); s.tick(); }
  s.tick(D.reserveMs);
  return active;
}

test("defaults use exact RAM, seats and backend bytes; minimum classification cannot be demoted", () => {
  for (const total of [7.3, 19.7, 37.2, 95.4]) {
    const settings = guardSettings({}, { totalBytes: total * GiB, cores: 10 });
    assert.equal(settings.headroomBytes, Math.max(2 * GiB, total * GiB * 0.15));
    assert.equal(settings.busySeats, 8);
    assert.equal(settings.maxActive, null);
    assert.equal(settings.maxWaitingWorkers, 16);
  }
  assert.equal(guardSettings({ maxVeryHeavy: 100 }).guaranteedVeryHeavy, 2);
  assert.equal(guardSettings({ maxVeryHeavy: 1 }).guaranteedOther, 3);
  assert.equal("maxVeryHeavy" in guardSettings({ maxVeryHeavy: 1 }), false);
  for (const effort of ["high", "xhigh", "max", "ultra", "default"]) assert.notEqual(modelClass({ model: "ordinary", effort }), "very-heavy");
  for (const request of [{ model: "astra", effort: "low" }, { backend: "kimi", model: "kimi-k3-preview", effort: "low" }]) {
    assert.equal(modelClass(request, [{ pattern: "*", class: "light" }]), "very-heavy");
  }
});

test("critical memory and load block even the first job; startup allowance applies inside the minimum", t => {
  const s = setup(t), c = s.ctx();
  const total = 128 * GiB;
  s.setMachine({ availableBytes: Math.max(D.criticalGiB * GiB, total * D.criticalFraction) - 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
  s.setMachine({ availableBytes: 100 * GiB, load5: D.criticalLoadPerCore * 64 + 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
  s.setMachine({ load5: 0, availableBytes: total * D.criticalFraction + D.startupBytes.codex - 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
});

test("global pacing survives quick completion; replacements reuse weight and refresh reserve", t => {
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
  fillOtherMinimum(s);
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

test("three Astra and three K3 starts have no fixed maximum", t => {
  const s = setup(t);
  for (const request of [{ model: "astra" }, { backend: "kimi", model: "kimi-k3-preview" }]) {
    for (let n = 0; n < 3; n++) { assert.equal(admit(s.ctx(request), s.deps).admit, true); s.tick(); }
  }
});

test("fairness uses fewest active seats, then oldest eligible claimant", t => {
  const s = setup(t); s.setMachine({ cores: 4, load5: 6 });
  const occupied = [s.ctx(), s.ctx(), s.ctx()];
  for (const c of occupied) { assert.equal(admit(c, s.deps).admit, true); s.tick(); }
  const waiter = s.ctx({ backend: "kimi" });
  assert.equal(admit(waiter, s.deps).waitKind, "seats");
  releaseSlot(s.home, occupied[0].jobId, occupied[0].me, s.deps);
  assert.equal(admit(s.ctx(), s.deps).waitKind, "fair-share");
  assert.equal(admit(waiter, s.deps).admit, true);
});

for (const blocked of ["stale", "memory", "pause"]) test(`fairness ignores ${blocked} claimants`, t => {
  const s = setup(t); s.setMachine({ cores: 4, load5: 6 });
  const occupied = [s.ctx(), s.ctx(), s.ctx()];
  for (const c of occupied) { admit(c, s.deps); s.tick(); }
  const waiter = s.ctx({ backend: "kimi", model: "ordinary", effort: "high" });
  admit(waiter, s.deps);
  if (blocked === "stale") s.tick(D.claimantPolls * D.pollMs);
  if (blocked === "pause") {
    fs.mkdirSync(path.join(s.home, "pauses"), { recursive: true });
    writeJsonAtomic(path.join(s.home, "pauses", "kimi.json"), { v: 1, backend: "kimi", kind: "usage", updatedAt: new Date(s.deps.now()).toISOString(), until: new Date(s.deps.now() + 100000).toISOString() });
  }
  if (blocked === "memory") s.setMachine({ availableBytes: 128 * GiB * D.criticalFraction + 0.75 * GiB });
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

test("guard failures hold visibly; corrupt slots do not crash", t => {
  const s = setup(t), c = s.ctx();
  const unknown = admit(c, { ...s.deps, readMachine() { throw new Error("synthetic sensor failure"); } });
  assert.equal(unknown.admit, false); assert.equal(unknown.waitKind, "guard-error");
  assert.match(unknown.reason, /synthetic sensor failure.*RELAY_ADMISSION=off or \/relay:setup --admission off/);
  s.tick();
  fs.mkdirSync(path.join(s.home, "slots"), { recursive: true });
  fs.writeFileSync(path.join(s.home, "slots", "corrupt.json"), "{");
  assert.equal(admit(s.ctx(), s.deps).admit, true);
  const held = admit(s.ctx(), { ...s.deps, readAdmissionConfig() { throw new Error("synthetic failure"); } });
  assert.equal(held.admit, false); assert.equal(held.waitKind, "guard-error");
});

test("macOS uses its memory percentage despite low free+inactive, pressure bits and cached zero", t => {
  const s = setup(t), total = 40 * GiB;
  const sensor = { totalmem: () => total, availableParallelism: () => 12, loadavg: () => [0, 0, 0], freemem() { throw new Error("must not read raw free pages"); } };
  let level = 65, pressure = 1, calls = 0, vmCalls = 0;
  const sysctl = (bin, args, options) => {
    calls++;
    assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 64 * 1024);
    if (bin === "/usr/bin/vm_stat") {
      vmCalls++;
      return { status: 0, stdout: "page size of 16384 bytes\nPages free: 123.\nPages inactive: 456.\n" };
    }
    assert.equal(bin, "/usr/sbin/sysctl");
    if (args[1] === "kern.memorystatus_level") return { status: 0, stdout: `${level}\n` };
    assert.deepEqual(args, ["-n", "kern.memorystatus_vm_pressure_level"]);
    return { status: 0, stdout: String(pressure) };
  };
  const read = now => readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now, sysctl });
  const healthy = read(1);
  assert.equal(healthy.availableBytes, total * 0.65);
  assert.equal(healthy.source, "kern.memorystatus_level");
  assert.equal(healthy.quality, "estimate");
  assert.deepEqual(healthy.notes, []);
  assert.equal(machineState(healthy, 2 * GiB).state, "healthy");
  assert.equal(admit(s.ctx(), { ...s.deps, readMachine: () => healthy }).admit, true);
  assert.equal(vmCalls, 0, "successful sysctl avoids the fallback probe");
  level = 0; pressure = 2;
  const zero = read(D.sensorCacheMs + 2);
  assert.equal(zero.availableBytes, 0);
  const count = calls; assert.equal(read(D.sensorCacheMs + 3).availableBytes, 0); assert.equal(calls, count);
  for (const p of [2, 4, 6]) assert.equal(machineState({ ...zero, availableBytes: total, pressure: p }).state, p === 2 ? "warning" : "critical");
  assert.equal(machineState({ ...zero, availableBytes: null, load5: null, pressure: 4 }).state, "critical");
  const failed = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now: D.sensorCacheMs * 2 + 3, sysctl: () => ({ status: 1 }) });
  assert.equal(failed.availableBytes, null); assert.match(failed.notes.join(" "), /memory not read/);
});

for (const level of [null, "101", "-1", "65junk", ""]) test(`macOS falls back to labelled free+inactive when memory percentage fails: ${JSON.stringify(level)}`, t => {
  const s = setup(t), total = 40 * GiB;
  const sensor = { totalmem: () => total, availableParallelism: () => 12, loadavg: () => [0, 0, 0] };
  const sysctl = (bin, args, options) => {
    assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 64 * 1024);
    if (bin === "/usr/bin/vm_stat") return { status: 0, stdout: "page size of 16384 bytes\nPages free: 123.\nPages inactive: 456.\nPages speculative: 999999.\n" };
    if (args[1] === "kern.memorystatus_level") return level === null ? { status: 1 } : { status: 0, stdout: level };
    assert.deepEqual(args, ["-n", "kern.memorystatus_vm_pressure_level"]);
    return { status: 0, stdout: "2" };
  };
  const reading = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now: 1, sysctl });
  assert.equal(reading.availableBytes, (123 + 456) * 16384);
  assert.equal(reading.source, "vm_stat free+inactive fallback");
  assert.equal(reading.quality, "heuristic");
  assert.match(reading.notes.join(" "), /using vm_stat free\+inactive fallback/);
  assert.equal(reading.pressure, 2, "pressure is still probed when the memory percentage fails");
  const cached = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now: 2, sysctl() { throw new Error("must use cache"); } });
  assert.deepEqual(cached.notes, reading.notes);
  assert.equal(cached.availableBytes, reading.availableBytes);
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
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
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
  fillOtherMinimum(s);
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
  fillOtherMinimum(s);
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

test("legacy descriptive classes cannot demote identified very-heavy selections", t => {
  const s = setup(t);
  const requests = [{ backend: "codex", model: "astra", effort: "high" }, { backend: "kimi", model: "kimi-k3-preview", effort: "low" }];
  for (const request of requests) {
    const c = s.ctx(request);
    assert.equal(admit(c, s.deps).admit, true); s.tick();
    const file = path.join(s.home, "slots", `${c.jobId}.json`);
    const slot = JSON.parse(fs.readFileSync(file));
    writeJob(c.jobDir, { id: c.jobId, state: "running", request: c.request });
    delete slot.model; // Older slots may omit the model; the job still identifies it.
    writeJsonAtomic(file, { ...slot, class: "light", weight: 1, quotaHeavy: false });
  }
  s.tick(D.reserveMs); s.setMachine({ availableBytes: 10 * GiB });
  assert.equal(admit(s.ctx({ model: "astra" }), s.deps).waitKind, "memory");
  assert.equal(admit(s.ctx({ model: "ordinary", effort: "high" }), s.deps).admit, true);
});

test("legacy class labels cannot consume the heavy minimum for ordinary or unknown selections", t => {
  const s = setup(t);
  for (const request of [{ model: "gpt-6-sol", effort: "max" }, { model: "default", effort: "ultra" }]) {
    const c = s.ctx(request); assert.equal(admit(c, s.deps).admit, true); s.tick();
    const file = path.join(s.home, "slots", `${c.jobId}.json`), slot = JSON.parse(fs.readFileSync(file));
    writeJsonAtomic(file, { ...slot, class: "very-heavy", weight: 3, quotaHeavy: true });
  }
  for (let n = 0; n < 2; n++) { assert.equal(admit(s.ctx({ model: "astra" }), s.deps).admit, true); s.tick(); }
  s.tick(D.reserveMs); s.setMachine({ availableBytes: 10 * GiB });
  assert.equal(admit(s.ctx({ model: "astra", effort: "low" }), s.deps).waitKind, "memory");
  assert.equal(admit(s.ctx({ effort: "max" }), s.deps).admit, true);
});

for (const signal of [{ load5: 40.9 }, { pressure: 2 }, { load5: 40.9, pressure: 2 }]) {
  test(`critical load holds replacements; warning alone holds nothing: ${JSON.stringify(signal)}`, t => {
    const s = setup(t), warm = s.ctx();
    s.setMachine({ totalBytes: 64 * GiB, availableBytes: 13.8 * GiB, cores: 10 });
    assert.equal(admit(warm, s.deps).admit, true); s.tick();
    s.setMachine(signal);
    const cold = admit(s.ctx(), s.deps);
    assert.equal(signal.load5 ? cold.waitKind : cold.admit, signal.load5 ? "critical" : true);
    assert.equal(admit({ ...warm, turn: true }, s.deps).admit, true);
    s.tick();
    assert.equal(signal.load5 ? admit(warm, s.deps).waitKind : admit(warm, s.deps).admit, signal.load5 ? "critical" : true);
    releaseSlot(s.home, warm.jobId, warm.me, s.deps); s.tick();
    const replacement = { ...warm, admitted: true };
    const result = admit(replacement, s.deps);
    assert.equal(signal.load5 ? result.waitKind : result.admit, signal.load5 ? "critical" : true);
    releaseSlot(s.home, warm.jobId, warm.me, s.deps); s.tick();
    writeJob(warm.jobDir, { id: warm.jobId, request: warm.request, state: "starting", firstAdmittedAt: new Date(s.deps.now()).toISOString() });
    assert.equal(spawnWithAdmission(warm.jobDir, s.env, () => 123, s.deps), signal.load5 ? null : 123);
  });
}
for (const signal of [{ availableBytes: 0 }, { pressure: 4, load5: 40.9 }, { pressure: 6 }]) {
  test(`critical memory/pressure holds admitted turns with a reason: ${JSON.stringify(signal)}`, t => {
    const s = setup(t), warm = s.ctx();
    s.setMachine({ totalBytes: 64 * GiB, availableBytes: 13.8 * GiB, cores: 10 });
    assert.equal(admit(warm, s.deps).admit, true); s.tick(); s.setMachine(signal);
    const held = admit({ ...warm, turn: true }, s.deps);
    assert.equal(held.waitKind, "critical"); assert.match(held.record.reason, /memory low|pressure critical/);
  });
}

test("busy sensor refresh keeps recent low-memory samples or waits without unknown-byte admission", t => {
  const s = setup(t);
  const sensor = { totalmem: () => 64 * GiB, availableParallelism: () => 10, loadavg: () => [0, 0, 0] };
  const sysctl = (bin, args) => ({ status: 0, stdout: args[1] === "kern.memorystatus_level" ? "0" : "4" });
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

for (const state of ["cancelled", "completed"]) for (const pending of [false, true]) {
  test(`spawn preserves ${state} jobs with pending inbox work=${pending}`, t => {
    const s = setup(t), c = s.ctx();
    writeJob(c.jobDir, { id: c.jobId, request: c.request, state, worker: null, completedAt: new Date(s.deps.now()).toISOString() });
    if (pending) postInboxMessage(c.jobDir, { id: "follow-up", type: "continue", text: "Continue the synthetic task" });
    const before = fs.readFileSync(path.join(c.jobDir, "job.json"), "utf8");
    let launches = 0;
    assert.equal(spawnWithAdmission(c.jobDir, s.env, () => { launches++; return 123; }, s.deps), pending ? 123 : null);
    assert.equal(launches, pending ? 1 : 0);
    assert.equal(fs.readFileSync(path.join(c.jobDir, "job.json"), "utf8"), before);
    if (!pending) assert.equal(fs.existsSync(path.join(s.home, "slots", `${c.jobId}.json`)), false);
  });
}

test("spawn preserves a child save made before launch returns", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "queued", admission: { state: "waiting", waitKind: "worker" } });
  const child = { ...readJob(c.jobDir), state: "queued", worker: c.me, admission: { state: "waiting", waitKind: "memory" } };
  let saved;
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => { writeJob(c.jobDir, child); saved = readJob(c.jobDir); return 123; }, s.deps), 123);
  assert.deepEqual(readJob(c.jobDir), saved);
});

test("spawn rechecks cancellation after acquiring a contended admission lock", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "queued", admission: { state: "waiting", waitKind: "worker" } });
  const file = path.join(s.home, "admission.lock"); fs.mkdirSync(s.home, { recursive: true });
  acquireOwnership(file, { pid: process.pid }); t.after(() => releaseOwnership(file));
  const cancelled = { ...readJob(c.jobDir), state: "cancelled", errorMessage: "Synthetic cancellation" };
  let saved;
  const deps = { ...s.deps, lockSleep() { writeJob(c.jobDir, cancelled); saved = readJob(c.jobDir); releaseOwnership(file); } };
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("must not launch"), deps), null);
  assert.deepEqual(readJob(c.jobDir), saved);
});

test("spawn retries a busy sensor refresh and launches without writing queued", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "starting" });
  const before = fs.readFileSync(path.join(c.jobDir, "job.json"), "utf8");
  const file = path.join(s.home, "machine-darwin.lock"); fs.mkdirSync(s.home, { recursive: true });
  acquireOwnership(file, { pid: process.pid, startTime: null }); t.after(() => releaseOwnership(file));
  const sleeps = [], writes = [];
  const sensor = { totalmem: () => 64 * GiB, availableParallelism: () => 10, loadavg: () => [0, 0, 0] };
  const sysctl = (bin, args) => ({ status: 0, stdout: args[1] === "kern.memorystatus_level" ? "65" : "1" });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(c.jobDir, "job.json")) writes.push(JSON.parse(fs.readFileSync(from, "utf8")).state);
    return rename(from, to);
  });
  let reads = 0;
  const deps = { ...s.deps, readMachine: args => { reads++; return readMachineDefault({ ...args, platform: "darwin", sensor, sysctl }); },
    lockSleep: ms => { sleeps.push(ms); releaseOwnership(file); } };
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => 123, deps), 123);
  assert.equal(reads, 2); assert.deepEqual(sleeps, [25]);
  assert.deepEqual(writes, []);
  assert.equal(fs.readFileSync(path.join(c.jobDir, "job.json"), "utf8"), before);
});

test("persistent sensor refresh defers only after a bounded jittered retry", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "starting" });
  s.setMachine({ refreshing: true, availableBytes: null });
  const sleeps = [];
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("must not launch"), {
    ...s.deps, random: () => 0.999, lockSleep: ms => sleeps.push(ms)
  }), null);
  assert.equal(sleeps.length, 10); assert.ok(sleeps.every(ms => ms >= 25 && ms <= 75));
  assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) <= 1000);
  const job = readJob(c.jobDir);
  assert.equal(job.state, "queued"); assert.equal(job.admission.waitKind, "worker");
  assert.equal(job.admission.reason, "sensor refresh in progress");
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

test("warning pressure is a nonblocking admission and status note", t => {
  const s = setup(t), c = s.ctx();
  assert.equal(admit(c, s.deps).admit, true); s.tick();
  s.setMachine({ pressure: 2 });
  assert.match(renderGuard(describeGuard(s.env, {}, s.deps))[0], /on · warning ·/);
  const held = admit(s.ctx(), s.deps);
  assert.equal(held.admit, true); assert.equal(held.record.waitKind, null);
  assert.ok(held.record.notes.includes("memory pressure warning (not holding)"));
  assert.ok(describeGuard(s.env, {}, s.deps).notes.includes("memory pressure warning (not holding)"));
  assert.equal(admit({ ...c, turn: true }, s.deps).admit, true);
  s.setMachine({ pressure: 4 });
  assert.match(renderGuard(describeGuard(s.env, {}, s.deps))[0], /on · critical ·/);
  assert.equal(admit(c, s.deps).admit, false);
});

test("historical job parsing stays outside the lock and cached records refresh on change", t => {
  const s = setup(t), c = s.ctx(), dirs = [];
  for (let n = 0; n < 100; n++) {
    const dir = path.join(s.env.RELAY_JOBS_HOME, "fixture-slug", `old-${n}`);
    fs.mkdirSync(dir, { recursive: true }); dirs.push(dir);
    writeJob(dir, { id: `old-${n}`, state: "completed", request: { model: "ordinary" }, worker: c.me,
      attempts: [{ servers: [{ pid: c.me.pid, endedAt: new Date(s.deps.now()).toISOString() }] }] });
  }
  const deps = { ...s.deps, scanUnslotted: null };
  let reads = 0, lockedReads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (dirs.some(dir => file === path.join(dir, "job.json"))) {
      reads++;
      if (readOwnership(path.join(s.home, "admission.lock"), { isAlive: s.deps.isAlive })) lockedReads++;
    }
    return read(file, ...args);
  });
  assert.equal(admit(c, deps).admit, true);
  assert.equal(reads, 100); assert.equal(lockedReads, 0);
  s.tick(); reads = 0;
  assert.equal(admit(s.ctx(), deps).admit, true);
  assert.equal(reads, 0, "unchanged history is not reparsed");
  writeJob(dirs[0], { id: "old-0", state: "running", worker: c.me, request: { model: "astra" } });
  writeJob(dirs[1], { id: "old-1", state: "failed", server: c.me, request: { backend: "kimi", model: "kimi-k3-preview", effort: "low" } });
  s.tick();
  const heavy = s.ctx({ model: "astra" });
  s.setMachine({ availableBytes: 10 * GiB });
  assert.equal(admit(heavy, deps).waitKind, "memory");
  assert.equal(lockedReads, 2, "live workers and unended servers are rechecked under the lock");
  writeJob(dirs[0], { id: "old-0", state: "completed", worker: c.me });
  fs.rmSync(dirs[1], { recursive: true });
  s.tick();
  assert.equal(admit(heavy, deps).admit, true);
});

test("a fresh spawn caller diagnoses persisted admission-lock contention", t => {
  const s = setup(t), c = s.ctx();
  fs.mkdirSync(s.home, { recursive: true });
  const file = path.join(s.home, "admission.lock");
  acquireOwnership(file, { pid: process.pid, since: new Date(s.deps.now()).toISOString() });
  t.after(() => releaseOwnership(file));
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "queued", admission: {
    state: "waiting", waitKind: "worker", reason: "admission lock busy", since: new Date(s.deps.now() - D.stuckLockMs).toISOString()
  } });
  spawnWithAdmission(c.jobDir, s.env, () => assert.fail("locked"), { ...s.deps, lockSleep() {} });
  assert.match(readJob(c.jobDir).admission.reason, /lock stuck .*pid .*RELAY_ADMISSION=off bypasses/);
});

test("production ignores both old and test-only synthetic sensor overrides", t => {
  const s = setup(t), sensor = { totalmem: () => 64 * GiB, availableParallelism: () => 8, loadavg: () => [0, 0, 0] };
  const env = { RELAY_ADMISSION_READINGS: "/missing/old.json", RELAY_TEST_ADMISSION_READINGS: "/missing/test.json" };
  const result = readMachineDefault({ home: s.home, env, platform: "darwin", now: s.deps.now(), sensor,
    sysctl: (bin, args) => ({ status: 0, stdout: args[1] === "kern.memorystatus_level" ? "50" : "1" }) });
  assert.equal(result.availableBytes, 32 * GiB);
  assert.equal(result.source, "kern.memorystatus_level");
});

test("admission preserves the last queue cause through grants and later warm turns", t => {
  const s = setup(t), c = s.ctx();
  s.setMachine({ availableBytes: 0 });
  const waiting = admit(c, s.deps).record;
  s.tick(497100); s.setMachine({ availableBytes: 100 * GiB });
  const admitted = admit({ ...c, waitingSince: waiting.since, admission: waiting }, s.deps).record;
  assert.equal(admitted.state, "admitted");
  assert.equal(admitted.reason, waiting.reason); assert.equal(admitted.waitKind, waiting.waitKind);
  s.tick();
  const warm = admit({ ...c, admission: admitted }, s.deps).record;
  assert.equal(warm.reason, waiting.reason); assert.equal(warm.waitKind, waiting.waitKind);
  assert.equal(warm.since, waiting.since); assert.equal(warm.admittedAt, admitted.admittedAt);
});

test("a long memory wait does not count toward a subsequent stuck-lock diagnostic", t => {
  const s = setup(t), c = s.ctx();
  fs.mkdirSync(s.home, { recursive: true });
  const file = path.join(s.home, "admission.lock");
  acquireOwnership(file, { pid: process.pid }); t.after(() => releaseOwnership(file));
  const since = new Date(s.deps.now() - D.stuckLockMs * 2).toISOString();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "queued", admission: {
    state: "waiting", waitKind: "worker", reason: "host memory low", since
  } });
  const deps = { ...s.deps, lockSleep() {} };
  for (let n = 0; n < 2; n++) {
    spawnWithAdmission(c.jobDir, s.env, () => assert.fail("locked"), deps);
    assert.equal(readJob(c.jobDir).admission.reason, "admission lock busy");
    assert.equal(readJob(c.jobDir).admission.since, since);
  }
  s.tick(D.stuckLockMs);
  spawnWithAdmission(c.jobDir, s.env, () => assert.fail("locked"), deps);
  assert.match(readJob(c.jobDir).admission.reason, /admission lock stuck/);
});

const ordinaryQuotaModels = [
  { backend: "codex", model: "gpt-6-sol" }, { backend: "codex", model: "gpt-6-luna" },
  { backend: "kimi", model: "kimi-k2.6" }, { backend: "kimi", model: "kimi-for-coding" },
  { backend: "zcode", model: "glm-5.3" }, { backend: "grok", model: "grok-build" }
];
test("only Astra and Kimi K3 models are very heavy, independently of effort", () => {
  for (const effort of [undefined, "default", "low", "high", "max", "ultra"]) {
    for (const request of [{ model: "gpt-6-astra" }, { backend: "kimi", model: "kimi-k3" }, { backend: "kimi", model: "kimi-k3-preview" }])
      assert.equal(modelClass({ ...request, effort }), "very-heavy", JSON.stringify({ ...request, effort }));
    for (const request of [...ordinaryQuotaModels, { model: "default" }, {}])
      assert.notEqual(modelClass({ ...request, effort }), "very-heavy", JSON.stringify({ ...request, effort }));
  }
});

test("heavy starts have no maximum and do not block other models at max and ultra effort", t => {
  const s = setup(t);
  for (const request of [{ model: "gpt-6-astra", effort: "low" }, { backend: "kimi", model: "kimi-k3-preview", effort: "low" }]) {
    assert.equal(admit(s.ctx(request), s.deps).admit, true); s.tick();
  }
  assert.equal(admit(s.ctx({ backend: "kimi", model: "kimi-k3", effort: "low" }), s.deps).admit, true); s.tick();
  for (const request of ordinaryQuotaModels) for (const effort of ["max", "ultra"]) {
    const result = admit(s.ctx({ ...request, effort }), s.deps);
    assert.equal(result.admit, true, `${request.model}/${effort}: ${result.reason}`); s.tick();
  }
  const snapshot = describeGuard(s.env, {}, s.deps);
  assert.equal(snapshot.veryHeavy, 3); assert.equal(snapshot.guaranteedVeryHeavy, 2); assert.equal("maxVeryHeavy" in snapshot, false);
  assert.match(renderGuard(snapshot)[0], /very heavy 3 running \(2 guaranteed, no maximum\)/);
});

for (const heavy of [true, false]) test(`minimum skips reserve for only its first active jobs: heavy=${heavy}`, t => {
  const s = setup(t), count = heavy ? D.guaranteedVeryHeavy : D.guaranteedOther;
  s.setMachine({ availableBytes: 10 * GiB });
  for (let n = 0; n < count; n++) {
    assert.equal(admit(s.ctx({ model: heavy ? "astra" : "ordinary" }), s.deps).admit, true);
    s.tick(D.reserveMs);
  }
  assert.equal(admit(s.ctx({ model: heavy ? "astra" : "ordinary" }), s.deps).waitKind, "memory");
});

for (const backend of ["codex", "kimi"]) for (const pending of [false, true]) {
  test(`minimum critical floor includes startup allowance at exact boundary: ${backend}, pending=${pending}`, t => {
    const s = setup(t), floor = 128 * GiB * D.criticalFraction;
    if (pending) { assert.equal(admit(s.ctx(), s.deps).admit, true); s.tick(); }
    const heldBytes = pending ? D.startupBytes.codex : 0;
    const c = s.ctx({ backend, model: backend === "kimi" ? "kimi-k3" : "astra" });
    s.setMachine({ availableBytes: floor + heldBytes + D.startupBytes[backend] - 1 });
    const held = admit(c, s.deps);
    assert.equal(held.waitKind, "critical"); assert.match(held.reason, /after startup allowance/);
    s.setMachine({ availableBytes: floor + heldBytes + D.startupBytes[backend] });
    assert.equal(admit(c, s.deps).admit, true, "equality passes, including pending holds and own J");
  });
}

for (const heavy of [true, false]) test(`legacy jobs consume their minimum without duplicate or dead counts: heavy=${heavy}`, t => {
  const s = setup(t), count = heavy ? D.guaranteedVeryHeavy : D.guaranteedOther;
  const request = { model: heavy ? "astra" : "ordinary" };
  const own = s.ctx(request); assert.equal(admit(own, s.deps).admit, true); s.tick(D.reserveMs);
  const legacy = Array.from({ length: count - 1 }, (_, n) => ({ id: `legacy-${n}`, state: "running", worker: own.me, request }));
  const duplicate = { id: own.jobId, state: "running", worker: own.me, request };
  const dead = { id: "dead", state: "running", worker: { pid: 999 }, request };
  const stale = { id: "stale", state: "completed", worker: own.me, request };
  s.setMachine({ availableBytes: 10 * GiB });
  s.setLegacy([...legacy, duplicate, dead, stale]);
  assert.equal(admit({ ...own, admitted: true }, s.deps).admit, true, "reconnect excludes itself and its legacy duplicate");
  s.tick(D.reserveMs);
  const candidate = s.ctx(request);
  assert.equal(admit(candidate, s.deps).waitKind, "memory", "slotted and legacy jobs together exhaust the minimum");
  releaseSlot(s.home, own.jobId, own.me, s.deps);
  s.setLegacy([...legacy, { ...duplicate, id: "unslotted" }, dead, stale]);
  assert.equal(admit(candidate, s.deps).waitKind, "memory", "fully legacy count consumes the same minimum");
  s.setLegacy([...legacy, dead, stale]);
  assert.equal(admit(candidate, s.deps).admit, true, "dead and completed jobs do not consume the minimum");
});

test("warning cannot mask busy load, but minimum contenders skip busy seats", t => {
  const s = setup(t); fillOtherMinimum(s);
  s.setMachine({ cores: 4, load5: 6, pressure: 2 });
  assert.equal(admit(s.ctx(), s.deps).waitKind, "seats");
  for (let n = 0; n < D.guaranteedVeryHeavy; n++) {
    const grant = admit(s.ctx({ model: "astra" }), s.deps);
    assert.equal(grant.admit, true); assert.ok(grant.record.notes.some(n => n.includes("not holding"))); s.tick();
  }
  assert.equal(admit(s.ctx({ model: "astra" }), s.deps).waitKind, "seats");
});

test("retained turns preserve holds and timing, close critical waits, and leave start spacing intact", t => {
  const s = setup(t), occupied = fillOtherMinimum(s), c = occupied[0];
  const other = s.ctx({ model: "astra" }); assert.equal(admit(other, s.deps).admit, true);
  const timing = () => fs.readFileSync(path.join(s.home, "timing.json"), "utf8");
  const before = timing(), slot = JSON.parse(fs.readFileSync(path.join(s.home, "slots", `${c.jobId}.json`)));
  s.tick(1000); s.setMachine({ availableBytes: 10 * GiB, load5: 999, scopes: [{ id: "/now-small", limitBytes: 1, remainingBytes: 0 }] });
  const turn = admit({ ...c, turn: true }, s.deps);
  assert.equal(turn.admit, true); assert.equal(turn.slot.holdAt, slot.holdAt); assert.equal(turn.slot.holdBytes, slot.holdBytes);
  assert.equal(timing(), before);
  s.setMachine({ load5: 0, scopes: [] });
  const memoryWaiter = s.ctx();
  assert.equal(admit(memoryWaiter, s.deps).waitKind, "memory", "new job outside its minimum still needs reserve");
  releaseSlot(s.home, memoryWaiter.jobId, memoryWaiter.me, s.deps);
  s.setMachine({ availableBytes: 100 * GiB });
  const next = s.ctx({ model: "astra" }); assert.equal(admit(next, s.deps).waitKind, "stagger");
  s.setMachine({ pressure: 4 });
  const wait = admit({ ...c, turn: true, admission: turn.record }, s.deps);
  assert.equal(wait.waitKind, "critical");
  s.tick(2000); s.setMachine({ pressure: 0 });
  const granted = admit({ ...c, turn: true, admission: wait.record, waitingSince: wait.record.since }, s.deps);
  assert.equal(granted.admit, true); assert.equal(granted.record.since, wait.record.since);
  assert.equal(Date.parse(granted.record.admittedAt) - Date.parse(wait.record.since), 2000);
  assert.equal(granted.slot.holdAt, slot.holdAt); assert.equal(granted.slot.holdBytes, slot.holdBytes);
  assert.equal(timing(), before);
  assert.equal(describeGuard(s.env, {}, s.deps).activeSeats, 4);
  assert.equal(admit(next, s.deps).waitKind, "stagger"); s.tick(2000);
  assert.equal(admit(next, s.deps).admit, true);
});

test("turn true without its own running slot falls back to full admission", t => {
  const s = setup(t), c = s.ctx(); assert.equal(admit(c, s.deps).admit, true);
  releaseSlot(s.home, c.jobId, c.me, s.deps);
  const absent = { ...c, admitted: true, turn: true };
  assert.equal(admit(absent, s.deps).waitKind, "stagger");
  s.tick(); s.setMachine({ load5: 999 });
  assert.equal(admit(absent, s.deps).waitKind, "critical");
  s.setMachine({ load5: 0, scopes: [{ id: "/finite", limitBytes: GiB, remainingBytes: 0 }] });
  assert.equal(admit(absent, s.deps).waitKind, "scope");
  s.setMachine({ scopes: [] });
  const grant = admit(absent, s.deps); assert.equal(grant.admit, true); assert.equal(grant.slot.holdBytes, D.startupBytes.codex);
});

for (const blocked of ["scope", "pause"]) test(`fair share orders eligible guaranteed contenders and recalculates after a grant: ${blocked}`, t => {
  const s = setup(t), c = s.ctx({ backend: "kimi", model: "kimi-k3" }), older = s.ctx({ model: "astra" }), later = s.ctx({ model: "astra" });
  s.setMachine({ availableBytes: 0, group: "/blocked", scopes: [] }); admit(c, s.deps);
  s.setMachine({ group: "/ready" }); s.tick(1); admit(older, s.deps); s.tick(1); admit(later, s.deps);
  if (blocked === "pause") {
    fs.mkdirSync(path.join(s.home, "pauses"), { recursive: true });
    writeJsonAtomic(path.join(s.home, "pauses", "kimi.json"), { v: 1, backend: "kimi", kind: "rate", updatedAt: new Date(s.deps.now()).toISOString(), until: new Date(s.deps.now() + 100000).toISOString() });
  }
  const deps = { ...s.deps, readScopes: () => ({ scopes: blocked === "scope" ? [{ id: "/blocked", limitBytes: 2 * GiB, remainingBytes: 0 }] : [] }) };
  s.setMachine({ availableBytes: 10 * GiB });
  assert.equal(admit(later, deps).waitKind, "fair-share");
  assert.equal(admit(older, deps).admit, true); s.tick();
  assert.equal(admit(later, deps).admit, true); s.tick();
  const third = admit(s.ctx({ model: "astra" }), deps);
  assert.equal(third.waitKind, "memory", "preceding grants consume the heavy minimum");
});

for (const pressure of [2, 4]) test(`guaranteed worker admission under pressure ${pressure}`, t => {
  const s = setup(t), c = s.ctx({ model: "astra" });
  s.setMachine({ availableBytes: 10 * GiB, pressure });
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  let launches = 0;
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => ++launches, s.deps), pressure === 2 ? 1 : null);
  assert.equal(launches, pressure === 2 ? 1 : 0);
  if (pressure === 4) { assert.equal(readJob(c.jobDir).admission.waitKind, "worker"); assert.match(readJob(c.jobDir).admission.reason, /critical/); }
});

test("a guaranteed worker still waits for finite cgroup headroom and fails impossible fits", t => {
  const s = setup(t), c = s.ctx({ model: "astra" });
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  s.setMachine({ group: "/finite", scopes: [{ id: "/finite", limitBytes: GiB, remainingBytes: D.workerBytes }] });
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("scope must hold worker"), s.deps), null);
  assert.equal(readJob(c.jobDir).admission.waitKind, "worker"); assert.match(readJob(c.jobDir).admission.reason, /cgroup memory low/);
  s.setMachine({ scopes: [{ id: "/finite", limitBytes: D.workerBytes, remainingBytes: D.workerBytes }] });
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("impossible scope must fail worker"), s.deps), null);
  assert.equal(readJob(c.jobDir).state, "failed"); assert.match(readJob(c.jobDir).admission.reason, /cannot fit cgroup/);
});

test("simultaneous guaranteed starts serialize grants and retain global pacing", async t => {
  const { spawn } = await import("node:child_process");
  const s = setup(t), callers = [s.ctx({ model: "astra" }), s.ctx({ model: "astra" })];
  const source = `
    import fs from "node:fs";
    import { admit } from ${JSON.stringify(new URL('../plugins/relay/scripts/lib/worker/admission.mjs', import.meta.url).href)};
    const ctx = JSON.parse(process.argv[1]), root = process.argv[2];
    fs.writeFileSync(root + "/ready-" + ctx.jobId, "");
    while (!fs.existsSync(root + "/go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const result = admit(ctx, { env: { RELAY_ADMISSION: "on" }, now: () => Date.parse("2025-01-01T00:00:00Z"),
      isAlive: () => true, readAdmissionConfig: () => ({}), scanUnslotted: () => [],
      readMachine: () => ({ totalBytes: 128 * 2 ** 30, availableBytes: 100 * 2 ** 30, cores: 64, load5: 0, notes: [] }) });
    process.stdout.write(JSON.stringify(result));
  `;
  const results = callers.map(c => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(c), s.root]);
    t.after(() => child.kill());
    let output = "", errors = "";
    child.stdout.on("data", data => output += data); child.stderr.on("data", data => errors += data);
    child.on("error", reject);
    child.on("close", code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(output)); } catch (e) { reject(e); } });
  }));
  const deadline = Date.now() + 5000;
  while (!callers.every(c => fs.existsSync(path.join(s.root, `ready-${c.jobId}`)))) {
    assert.ok(Date.now() < deadline, "both synthetic callers must reach barrier");
    await new Promise(r => setTimeout(r, 10));
  }
  fs.writeFileSync(path.join(s.root, "go"), "");
  const decisions = await Promise.all(results);
  assert.equal(decisions.filter(d => d.admit).length, 1);
  assert.ok(decisions.every(d => d.record.state !== "bypassed"));
  const held = decisions.findIndex(d => !d.admit);
  assert.ok(["lock", "stagger"].includes(decisions[held].waitKind));
  assert.equal(admit(callers[held], s.deps).waitKind, "stagger");
  s.tick(); assert.equal(admit(callers[held], s.deps).admit, true);
});

for (const fault of ["readMachine", "writeSlot"]) test(`guard ${fault} exceptions hold, deduplicate diagnostics and preserve the off switch`, t => {
  const s = setup(t), c = s.ctx();
  const deps = { ...s.deps, [fault]: () => { throw new Error("synthetic storage failure"); } };
  const lines = [], original = process.stderr.write;
  process.stderr.write = line => { lines.push(line); return true; };
  try {
    for (let n = 0; n < 2; n++) {
      const held = admit(c, deps);
      assert.equal(held.admit, false); assert.equal(held.waitKind, "guard-error");
      assert.equal(held.retryMs, D.pollMs);
      assert.match(held.reason, /holding starts and turns.*RELAY_ADMISSION=off or \/relay:setup --admission off/);
    }
    assert.equal(lines.length, 1);
    assert.equal(admit(c, { ...deps, env: { ...s.env, RELAY_ADMISSION: "off" } }).admit, true);
  } finally { process.stderr.write = original; }
});

test("an unwritable admission home holds worker creation and records its reason", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, request: c.request, state: "starting", createdAt: new Date(s.deps.now()).toISOString() });
  fs.mkdirSync(s.home, { mode: 0o500 });

  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("must not spawn"), s.deps), null);
  const job = readJob(c.jobDir);
  assert.equal(job.state, "queued"); assert.equal(job.admission.waitKind, "worker");
  assert.equal(job.admission.causeKind, "guard-error");
  assert.match(job.admission.reason, /load guard error:.*RELAY_ADMISSION=off/);
  assert.equal(computeJobView(job, { now: s.deps.now() + 60001 }).state, "queued");
  fs.chmodSync(s.home, 0o700);
  const spawn = childProcess.spawnSync; let retries = 0;
  t.mock.method(childProcess, "spawnSync", (command, args, ...rest) => {
    if (args?.[0]?.endsWith("/launcher.mjs")) { retries++; throw new Error("synthetic spawn reached"); }
    return spawn(command, args, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(process.stderr, "write", () => true);
  assert.equal(retryQueuedWorker(c.jobDir, { ...s.env, RELAY_ADMISSION: "off" }), null);
  assert.equal(retries, 1);
});

test("damaged slots consume busy seats, startup bytes and the minimum until quarantine", t => {
  const s = setup(t);
  s.setMachine({ cores: 6, load5: 10 });
  fillOtherMinimum(s);
  const file = path.join(s.home, "slots", "damaged.json");
  fs.writeFileSync(file, "{"); fs.utimesSync(file, s.deps.now() / 1000, s.deps.now() / 1000);
  const c = s.ctx();
  assert.equal(admit(c, s.deps).waitKind, "seats");
  assert.equal(describeGuard(s.env, {}, s.deps).pendingBytes, D.unknownStartupBytes);
  s.tick(11000); assert.equal(admit(c, s.deps).waitKind, "seats"); assert.ok(fs.existsSync(file));
  s.tick(10 * 60000 - 11000);
  const granted = admit(c, s.deps); assert.equal(granted.admit, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.join(s.home, "slots", "quarantine")).length, 1);
  assert.ok(granted.record.notes.includes("slot record damaged.json was unreadable; quarantined"));
});

for (const ahead of [60000, 600000]) test(`future start timing ${ahead} ms is fenced or repaired`, t => {
  const s = setup(t), c = s.ctx(); fs.mkdirSync(s.home, { recursive: true });
  writeJsonAtomic(path.join(s.home, "timing.json"), { lastStart: new Date(s.deps.now() + ahead).toISOString() });
  const result = admit(c, s.deps);
  if (ahead <= D.clockSkewMs) {
    assert.equal(result.waitKind, "stagger");
    s.tick(ahead + D.spacingMs); assert.equal(admit(c, s.deps).admit, true);
  } else {
    assert.equal(result.admit, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "timing.json"))).lastStart, new Date(s.deps.now()).toISOString());
    assert.equal(admit(s.ctx(), s.deps).waitKind, "stagger");
  }
});

for (const ahead of [20000, 600000]) test(`future startup hold ${ahead} ms remains reserved`, t => {
  const s = setup(t), c = s.ctx(); admit(c, s.deps);
  const file = path.join(s.home, "slots", `${c.jobId}.json`), slot = JSON.parse(fs.readFileSync(file));
  writeJsonAtomic(file, { ...slot, holdAt: new Date(s.deps.now() + ahead).toISOString() });
  s.tick(D.spacingMs);
  s.setMachine({ availableBytes: 128 * GiB * D.criticalFraction + D.startupBytes.codex });
  assert.equal(admit(s.ctx(), s.deps).waitKind, "critical");
  if (ahead > D.clockSkewMs) assert.equal(JSON.parse(fs.readFileSync(file)).holdAt, new Date(s.deps.now()).toISOString());
});

test("missing host bytes admits only the busy allowance after the minimum", t => {
  const s = setup(t); s.setMachine({ cores: 6, availableBytes: null });
  for (let n = 0; n < 4; n++) { assert.equal(admit(s.ctx(), s.deps).admit, true); s.tick(); }
  assert.equal(admit(s.ctx(), s.deps).waitKind, "seats");
});

test("a completed job's historical admission does not reuse a released busy seat", t => {
  const s = setup(t), c = s.ctx();
  admit(c, s.deps); releaseSlot(s.home, c.jobId, c.me, s.deps); s.tick();
  writeJob(c.jobDir, { id: c.jobId, state: "completed", request: c.request, firstAdmittedAt: new Date(s.deps.now()).toISOString() });
  s.setMachine({ cores: 6, load5: 10 });
  for (let n = 0; n < 4; n++) { assert.equal(admit(s.ctx(), s.deps).admit, true); s.tick(); }
  assert.equal(admit({ ...c, admitted: true }, s.deps).waitKind, "seats");
});

test("slotless live very-heavy jobs consume the worker minimum", t => {
  const s = setup(t), c = s.ctx({ model: "astra" });
  const jobs = [s.ctx({ model: "astra" }), s.ctx({ model: "astra" })];
  s.setLegacy(jobs.map(j => ({ id: j.jobId, state: "running", worker: j.me, request: j.request })));
  s.setMachine({ availableBytes: 10 * GiB });
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("reserve must hold"), s.deps), null);
  assert.equal(readJob(c.jobDir).admission.causeKind, "memory");
  s.setMachine({ availableBytes: 100 * GiB });
  const waiting = readJob(c.jobDir).admission;
  assert.equal(spawnWithAdmission(c.jobDir, s.env, () => 1, s.deps), 1);
  const spawned = readJob(c.jobDir).admission;
  assert.equal(spawned.waitKind, "spawned"); assert.equal(spawned.causeKind, "memory");
  const granted = admit({ ...c, admission: spawned, waitingSince: waiting.since }, s.deps);
  assert.equal(granted.admit, true); assert.equal(granted.record.waitKind, "memory");
});

test("worker admission never launches or creates a job when its record cannot be read", t => {
  const s = setup(t), dir = path.join(s.root, "missing-job");
  assert.equal(spawnWithAdmission(dir, s.env, () => assert.fail("must not spawn"), s.deps), null);
  assert.equal(fs.existsSync(dir), false);
});

test("the environment off switch survives configuration read errors", t => {
  const s = setup(t), c = s.ctx(), env = { ...s.env, RELAY_ADMISSION: "off" };
  const deps = { ...s.deps, env, readAdmissionConfig: () => { throw new Error("unreadable configuration"); } };
  assert.equal(admit(c, deps).admit, true);
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  assert.equal(spawnWithAdmission(c.jobDir, env, () => 42, deps), 42);
});


test("guard errors preserve terminal jobs with empty inboxes", t => {
  const s = setup(t), c = s.ctx();
  for (const state of ["completed", "failed", "cancelled"]) {
    writeJob(c.jobDir, { id: c.jobId, state, request: c.request });
    const before = fs.readFileSync(path.join(c.jobDir, "job.json"), "utf8");
    assert.equal(spawnWithAdmission(c.jobDir, s.env, () => assert.fail("must not spawn"), {
      ...s.deps, readMachine() { throw new Error("synthetic sensor failure"); }
    }), null);
    assert.equal(fs.readFileSync(path.join(c.jobDir, "job.json"), "utf8"), before);
  }
});

test("atomic write errors normalize temporary paths and retain only the last diagnostic", t => {
  const s = setup(t), c = s.ctx(), lines = [];
  t.mock.method(process.stderr, "write", line => { lines.push(line); return true; });
  let calls = 0, cause = "ENOSPC";
  const deps = { ...s.deps, writeSlot() { throw new Error(`${cause}: open 'slot.json.123.${(++calls).toString(16)}.tmp'`); } };
  const reasons = Array.from({ length: 5 }, () => admit(c, deps).reason);
  assert.equal(new Set(reasons).size, 1);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(reasons[0], /\.123\.[a-f0-9]+\.tmp/);
  cause = "EACCES"; admit(c, deps);
  cause = "ENOSPC"; admit(c, deps);
  assert.equal(lines.length, 3, "returning to an earlier message logs again; only the last is retained");
});

test("lock-busy worker deferrals retain their cause through admission", t => {
  const s = setup(t), c = s.ctx();
  writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
  fs.mkdirSync(s.home, { recursive: true });
  const file = path.join(s.home, "admission.lock");
  acquireOwnership(file, { pid: process.pid });
  try { spawnWithAdmission(c.jobDir, s.env, () => assert.fail("locked"), { ...s.deps, lockSleep() {} }); }
  finally { releaseOwnership(file); }
  const admission = readJob(c.jobDir).admission;
  assert.equal(admission.causeKind, "lock");
  assert.equal(admit({ ...c, admission, waitingSince: admission.since }, s.deps).record.waitKind, "lock");
});

test("a damaged own slot cannot reuse a busy seat or retain the damaged placeholder", t => {
  const s = setup(t); fillOtherMinimum(s);
  s.setMachine({ cores: 4, load5: 6 });
  const c = s.ctx(), file = path.join(s.home, "slots", `${c.jobId}.json`);
  fs.writeFileSync(file, "{"); fs.utimesSync(file, s.deps.now() / 1000, s.deps.now() / 1000);
  assert.equal(admit({ ...c, turn: true }, s.deps).waitKind, "seats");
  const slot = JSON.parse(fs.readFileSync(file));
  assert.equal(slot.state, "waiting"); assert.equal(slot.damaged, undefined);
});

test("a burst can reserve other seats while the first launch handshake is still running", t => {
  const s = setup(t);
  const jobs = Array.from({ length: 8 }, () => {
    const c = s.ctx();
    writeJob(c.jobDir, { id: c.jobId, state: "starting", request: c.request });
    return c;
  });
  let launches = 0, sleeps = 0;
  const deps = { ...s.deps, lockSleep() { sleeps++; } };
  const launch = index => spawnWithAdmission(jobs[index].jobDir, s.env, () => {
    launches++;
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "slots", `${jobs[index].jobId}.json`))).state, "spawning");
    if (index + 1 < jobs.length) assert.equal(launch(index + 1), index + 2);
    return index + 1;
  }, deps);
  assert.equal(launch(0), 1);
  assert.equal(launches, jobs.length);
  assert.equal(sleeps, 0);
  assert.ok(jobs.every(c => readJob(c.jobDir).admission?.causeKind !== "lock"));
});

test('admitted records retain the longest hold instead of the last short pacing hold', t => {
  const s = setup(t), c = s.ctx({ model: 'synthetic-model' });
  s.setMachine({ availableBytes: 0 });
  let result = admit(c, s.deps);
  c.admission = result.record; c.waitingSince = result.record.since;
  assert.equal(result.waitKind, 'critical');
  s.tick(120000); s.setMachine({ availableBytes: 100 * GiB });
  fs.writeFileSync(path.join(s.home, 'timing.json'), JSON.stringify({ lastStart: new Date(s.deps.now()).toISOString() }));
  result = admit(c, s.deps); assert.equal(result.waitKind, 'stagger'); c.admission = result.record;
  s.tick(D.spacingMs); result = admit(c, s.deps);
  assert.equal(result.admit, true); assert.equal(result.record.waitKind, 'critical');
  assert.match(result.record.reason, /memory/);
  assert.equal(Object.values(result.record.waitTotals).find(x => x.kind === 'critical').ms, 120000);
  assert.equal(Object.values(result.record.waitTotals).find(x => x.kind === 'stagger').ms, D.spacingMs);
});

test('slot cleaning and release require fresh live execution evidence even with a busy process cache', async t => {
  const { executionAlive } = await import('../plugins/relay/scripts/lib/worker/admission.mjs');
  const s = setup(t), c = s.ctx(), dir = c.jobDir, file = path.join(s.home, 'slots', `${c.jobId}.json`);
  const leader = { pid: 600000000, startTime: 'linux:100' };
  const tool = { pid: 600000001, ppid: 1, pgid: leader.pid, startTime: 'linux:200' };
  writeJob(dir, { id: c.jobId, request: c.request, worker: leader, server: tool, state: 'running', execution: { leader, pgid: leader.pid } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, jobId: c.jobId, jobDir: dir, pid: leader.pid, processStart: leader.startTime,
    backend: 'codex', class: 'light', state: 'running', since: new Date(s.deps.now()).toISOString() }));
  fs.writeFileSync(path.join(s.home, '.ps-table.json'), JSON.stringify({ at: Date.now() - 60000, rows: [] }));
  const lock = path.join(s.home, '.ps-table.json.lock'); assert.ok(acquireOwnership(lock)); t.after(() => releaseOwnership(lock));
  const deps = { ...s.deps, listProcesses: () => [tool] };
  assert.equal(executionAlive({ ...readJob(dir), jobDir: dir }, deps), true);
  assert.equal(describeGuard(s.env, {}, deps).activeSeats, 1); assert.equal(fs.existsSync(file), true);
  assert.equal(releaseSlot(s.home, c.jobId, leader, deps), false); assert.equal(fs.existsSync(file), true);
});

test('changing memory readings accumulate one bounded hold kind and outweigh a short final stagger', t => {
  const s = setup(t); fillOtherMinimum(s);
  const c = s.ctx({ model: 'synthetic-model' });
  for (let i = 0; i < 100; i++) {
    s.setMachine({ availableBytes: (10 + i / 100) * GiB });
    const held = admit(c, s.deps); assert.equal(held.waitKind, 'memory');
    c.admission = held.record; c.waitingSince = held.record.since; s.tick(1000);
  }
  s.setMachine({ availableBytes: 100 * GiB });
  fs.writeFileSync(path.join(s.home, 'timing.json'), JSON.stringify({ lastStart: new Date(s.deps.now()).toISOString() }));
  const stagger = admit(c, s.deps); c.admission = stagger.record;
  s.tick(D.spacingMs); const result = admit(c, s.deps);
  assert.equal(result.admit, true); assert.equal(result.record.waitKind, 'memory');
  assert.equal(result.record.waitTotals.memory.ms, 100000);
  assert.equal(Object.keys(result.record.waitTotals).length, 2);
});
