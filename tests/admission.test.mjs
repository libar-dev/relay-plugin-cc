import "./support/isolate-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS as D, WEIGHTS, admissionHome, guardSettings, modelClass, machineState, readMachineDefault, holderAlive, renderGuard, admit, releaseSlot, spawnWithAdmission } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { acquireOwnership, releaseOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";
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
  const deps = { env, now: () => now, readMachine: () => machine, isAlive: p => live.has(p?.pid) && p?.startTime !== "reused", readUserConfig: () => config, scanUnslotted: () => legacy, random: () => 0 };
  let seq = 0;
  const ctx = (request = {}, jobId = `job-${++seq}`) => {
    const pid = 100000 + seq; live.add(pid);
    const dir = path.join(root, jobId); fs.mkdirSync(dir, { recursive: true });
    return { home, jobId, jobDir: dir, me: { pid, startTime: "synthetic" }, request: { backend: "codex", effort: D.lightEfforts[0], ...request } };
  };
  return { home, root, env, deps, ctx, live, tick: (ms = Math.max(D.spacingMs, D.aboveMinSpacingMs)) => now += ms, setMachine: m => machine = { ...machine, ...m }, setLegacy: jobs => legacy = jobs };
}

test("defaults derive unrounded ceiling, headroom and scheduling classes", () => {
  for (const total of [7.3, 19.7, 37.2, 95.4]) {
    const machine = { totalBytes: total * GiB, cores: 10 };
    const expected = Math.max(D.minWeight, Math.min(D.ceilingCores * machine.cores, Math.floor((total - Math.max(D.headroomGiB, total * D.headroomFraction)) / D.reserveGiBPerWeight)));
    assert.equal(guardSettings({}, machine).maxWeight, expected);
  }
  assert.equal(modelClass({ model: "unknown" }), "medium");
  for (const effort of D.heavyEfforts) assert.equal(modelClass({ effort }), "very-heavy");
  for (const effort of D.lightEfforts) assert.equal(modelClass({ effort }), "light");
  assert.equal(modelClass({ model: "custom-a" }, [{ pattern: "custom-*", class: "light" }, { pattern: "custom", class: "medium" }]), "light");
  assert.equal(guardSettings({ minWeight: D.minWeight + 5, maxWeight: 1 }).maxWeight, D.minWeight + 5);
});

test("critical memory and load block even the first job; headroom applies inside the minimum", t => {
  const s = setup(t), c = s.ctx();
  const total = 128 * GiB;
  s.setMachine({ availableBytes: Math.max(D.criticalGiB * GiB, total * D.criticalFraction) - 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
  s.setMachine({ availableBytes: 100 * GiB, load5: D.criticalLoadPerCore * 64 + 1 });
  assert.equal(admit(c, s.deps).waitKind, "critical");
  s.setMachine({ load5: 0, availableBytes: guardSettings({}, { totalBytes: total, cores: 64 }).headroomBytes + WEIGHTS.light * D.reserveGiBPerWeight * GiB - 1 });
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
  s.setMachine({ availableBytes: headroom + 2 * WEIGHTS.light * D.reserveGiBPerWeight * GiB - 1 });
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

test("busy and unknown stop at the minimum; healthy above-minimum spacing persists after release", t => {
  const s = setup(t);
  s.setMachine({ availableBytes: null, load5: null });
  for (let n = 0; n < Math.floor(D.minWeight / WEIGHTS.light); n++) {
    assert.equal(admit(s.ctx(), s.deps).admit, true); s.tick();
  }
  assert.equal(admit(s.ctx(), s.deps).waitKind, "weight");
  s.setMachine({ availableBytes: 100 * GiB, load5: 0 });
  const extra = s.ctx(); assert.equal(admit(extra, s.deps).admit, true);
  releaseSlot(s.home, extra.jobId, extra.me, s.deps);
  s.tick(D.spacingMs);
  if (D.aboveMinSpacingMs > D.spacingMs) assert.equal(admit(s.ctx(), s.deps).waitKind, "spacing");
  s.tick(D.aboveMinSpacingMs);
  assert.equal(admit(s.ctx(), s.deps).admit, true);
});

test("very-heavy cap and fair share yield without deadlocking tied backends", t => {
  const s = setup(t);
  for (let n = 0; n < D.maxVeryHeavy; n++) { assert.equal(admit(s.ctx({ effort: D.heavyEfforts[0] }), s.deps).admit, true); s.tick(); }
  assert.equal(admit(s.ctx({ effort: D.heavyEfforts[0] }), s.deps).waitKind, "very-heavy");
  assert.equal(admit(s.ctx(), s.deps).admit, true);
  const fair = setup(t); fair.setMachine({ load5: D.healthyLoadPerCore * 64 });
  const count = Math.floor(D.minWeight / WEIGHTS.medium);
  const occupied = [];
  for (let i = 0; i < count; i++) { const c = fair.ctx({ effort: "high" }); occupied.push(c); assert.equal(admit(c, fair.deps).admit, true); fair.tick(); }
  const waiter = fair.ctx({ backend: "kimi", effort: "high" });
  assert.equal(admit(waiter, fair.deps).waitKind, "weight");
  releaseSlot(fair.home, occupied[0].jobId, occupied[0].me, fair.deps);
  assert.equal(admit(fair.ctx({ effort: "high" }), fair.deps).waitKind, "fair-share");
  assert.equal(admit(waiter, fair.deps).admit, true);
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
  const bypass = admit(s.ctx(), { ...s.deps, readUserConfig() { throw new Error("synthetic failure"); } });
  assert.equal(bypass.record.state, "bypassed");
});

test("macOS uses available percentage, never free pages; bounded sensor errors skip memory", t => {
  const s = setup(t), total = 40 * GiB;
  const sensor = { totalmem: () => total, availableParallelism: () => 12, loadavg: () => [0, 0, 0], freemem() { throw new Error("must not read free pages"); } };
  const value = 63;
  const machine = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now: 1, sysctl: () => ({ status: 0, stdout: String(value) }) });
  assert.equal(machine.availableBytes, total * value / 100);
  const failed = readMachineDefault({ home: s.home, env: {}, platform: "darwin", sensor, now: D.sensorCacheMs + 2, sysctl: () => ({ status: 1 }) });
  assert.equal(failed.availableBytes, null);
  assert.match(failed.notes.join(" "), /memory not read/);
});

test("domain ignores custom jobs homes; spawn reservations bound waiting workers and critical starts", t => {
  const s = setup(t, { maxWeight: D.minWeight });
  assert.equal(admissionHome({ RELAY_JOBS_HOME: "/synthetic/a" }), admissionHome({ RELAY_JOBS_HOME: "/synthetic/b" }));
  const bound = Math.max(D.minWaitingWorkers, D.minWeight * D.waitingPerCeiling);
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

test("fifty synthetic mixed submissions obey caps and spacing until all finish", t => {
  const s = setup(t), requests = Array.from({ length: 50 }, (_, i) => s.ctx({ backend: i % 2 ? "codex" : "kimi", effort: i % 4 === 0 ? D.heavyEfforts[0] : i % 3 === 0 ? "high" : D.lightEfforts[0] }));
  const running = new Map(); let last = -Infinity, admitted = 0;
  for (let step = 0; requests.length || running.size; step++) {
    assert.ok(step < 10000);
    for (const [c, end] of running) if (end <= step) { releaseSlot(s.home, c.jobId, c.me, s.deps); running.delete(c); }
    const used = [...running].reduce((n, [c]) => n + WEIGHTS[modelClass(c.request)], 0);
    s.setMachine({ availableBytes: 100 * GiB - used * D.reserveGiBPerWeight * GiB });
    for (const c of [...requests]) {
      const result = admit(c, s.deps);
      if (!result.admit) continue;
      assert.ok(step * 1000 - last >= D.spacingMs); last = step * 1000;
      requests.splice(requests.indexOf(c), 1); running.set(c, step + 17); admitted++;
      const current = [...running].reduce((n, [r]) => n + WEIGHTS[modelClass(r.request)], 0);
      assert.ok(current <= guardSettings({}, { totalBytes: 128 * GiB, cores: 64 }).maxWeight);
      assert.ok([...running].filter(([r]) => modelClass(r.request) === "very-heavy").length <= D.maxVeryHeavy);
    }
    s.tick(1000);
  }
  assert.equal(admitted, 50);
});

test("win32 skips unavailable load and process identities, uses free memory and retains unknown slots", t => {
  const s = setup(t);
  let loadReads = 0, psCalls = 0;
  const sensor = { totalmem: () => 128 * GiB, availableParallelism: () => 64,
    freemem: () => 100 * GiB, loadavg() { loadReads++; return [0, 0, 0]; } };
  const machine = readMachineDefault({ home: s.home, env: {}, platform: "win32", sensor });
  assert.equal(machine.availableBytes, sensor.freemem());
  assert.equal(machine.load5, null);
  assert.match(machine.notes.join(" "), /load not read/);
  assert.equal(loadReads, 0);
  const alive = identity => holderAlive(identity, { platform: "win32", ps() { psCalls++; throw new Error("ps unavailable"); } });
  const deps = { ...s.deps, platform: "win32", isAlive: alive, readMachine: () => machine };
  const first = s.ctx(); assert.equal(admit(first, deps).admit, true);
  s.live.delete(first.me.pid); s.tick();
  assert.equal(admit(s.ctx(), deps).admit, true);
  assert.equal(fs.existsSync(path.join(s.home, "slots", `${first.jobId}.json`)), true);
  assert.equal(alive({ pid: 2147483647, startTime: "unreadable" }), true);
  assert.equal(psCalls, 0);
});

test("Linux cgroup headroom uses every ancestor and caches per cgroup, never across siblings", t => {
  const s = setup(t);
  const sensor = { totalmem: () => 128 * GiB, availableParallelism: () => 64, loadavg: () => [0, 0, 0], freemem: () => 100 * GiB };
  const limits = new Map([
    ["/proc/self/cgroup", "0::/session/worker\n"],
    ["/sys/fs/cgroup/session/worker/memory.max", "max"],
    ["/sys/fs/cgroup/session/memory.max", String(20 * GiB)],
    ["/sys/fs/cgroup/session/memory.current", String(16 * GiB)],
    ["/sys/fs/cgroup/memory.max", String(80 * GiB)],
    ["/sys/fs/cgroup/memory.current", String(70 * GiB)]
  ]);
  let reads = 0;
  const readFile = file => { reads++; assert.ok(limits.has(file), file); return limits.get(file); };
  const first = readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile, now: 1 });
  assert.equal(first.availableBytes, 4 * GiB);
  const count = reads;
  limits.set("/sys/fs/cgroup/session/memory.current", String(19 * GiB));
  assert.equal(readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile, now: 2 }).availableBytes, 4 * GiB);
  assert.equal(reads, count);
  assert.equal(readMachineDefault({ home: s.home, env: {}, platform: "linux", sensor, readFile, now: D.sensorCacheMs + 2 }).availableBytes, GiB);
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
  assert.equal(machine.availableBytes, 3 * GiB);
  assert.match(machine.notes.join(" "), /readings unavailable/);
});
