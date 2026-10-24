import "./support/isolate-env.mjs";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { setup, companion } from "./support/job-helpers.mjs";
import { readUserConfig } from "../plugins/relay/scripts/lib/jobs/config.mjs";
import { DEFAULTS as D, describeGuard, guardSettings, readAdmissionConfig, admissionConfigPath } from "../plugins/relay/scripts/lib/worker/admission.mjs";

test("setup validates guard flags and writes only the shared admission domain", t => {
  const ctx = setup(t);
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "domain");
  for (const args of [["--admission", "invalid"], ["--max-very-heavy", "3"], ["--min-weight", "0"], ["--max-weight", "1.2"], ["--max-very-heavy", "101"], ["--model-class", "bad=unknown"], ["--backend", "codex", "--admission", "off"]]) {
    const result = companion(ctx, ["setup", ...args]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(ctx.jobs, "config.json")), false);
  }
  const result = companion(ctx, ["setup", "--admission", "off", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.settings.loadGuard.guaranteedVeryHeavy, 2);
  assert.equal(page.settings.loadGuard.guaranteedOther, 3);
  assert.equal("maxVeryHeavy" in page.settings.loadGuard, false);
  assert.equal(page.settings.loadGuard.maxActive, null);
  assert.equal(page.loadGuard.enabled, false);
  assert.equal(readAdmissionConfig(ctx.env).admission, "off");
  assert.match(page.actionsTaken.join(" "), /domain-wide/);
  assert.equal(fs.existsSync(path.join(ctx.jobs, "config.json")), false);
});

test("removed maximum flag fails explicitly before any setting mutation", t => {
  const ctx = setup(t); ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "domain");
  for (const removed of [["--max-very-heavy", "1"], ["--max-very-heavy", "2"], ["--max-very-heavy", "default"], ["--max-very-heavy", "100"], ["--max-very-heavy"], ["--max-very-heavy=1"], ["--max-very-heavy=false"]]) {
    const result = companion(ctx, ["setup", "--admission", "off", "--fast-tier", "allowed", "--enable-review-gate", ...removed]);
    assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /removed: very heavy jobs have a guaranteed 2 and no maximum/);
    assert.equal(fs.existsSync(admissionConfigPath(ctx.env)), false);
    assert.equal(fs.existsSync(path.join(ctx.jobs, "config.json")), false);
  }
});

test("corrupt stored settings normalize; JSON listing reads no sensors or lock", t => {
  const ctx = setup(t);
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "domain");
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ admission: "invalid", minWeight: -1, modelClasses: [{ class: "light" }, { pattern: "ok", class: "medium" }] }));
  const config = readUserConfig(ctx.env);
  assert.equal(config.admission, undefined); assert.equal(config.minWeight, undefined);
  fs.mkdirSync(path.dirname(admissionConfigPath(ctx.env)), { recursive: true });
  fs.writeFileSync(admissionConfigPath(ctx.env), JSON.stringify({ admission: "invalid", maxVeryHeavy: 100 }));
  assert.deepEqual(readAdmissionConfig(ctx.env), { admission: "on", notes: ["maxVeryHeavy is ignored: very heavy jobs have no maximum"] });
  const env = { ...ctx.env, RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: path.join(ctx.root, "admission"), RELAY_TEST_ADMISSION_READINGS: path.join(ctx.root, "missing.json") };
  const snapshot = describeGuard(env, { readSensors: false }, { readMachine() { throw new Error("must not read"); } });
  assert.deepEqual(snapshot, { enabled: true, pauses: [] });
  const listing = companion(ctx, ["status", "--json", "--all"], env);
  assert.equal(listing.status, 0);
  assert.equal(JSON.parse(listing.stdout).loadGuard.enabled, true);
  assert.equal(fs.existsSync(env.RELAY_ADMISSION_HOME), false);
});

test("a worker-spawn failure is never retried as a guard failure", async t => {
  const { spawnWithAdmission } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const ctx = setup(t);
  const { createJobDir, writeJob } = await import("../plugins/relay/scripts/lib/jobs/store.mjs");
  const { jobDir } = createJobDir(ctx.work, "spawn-failure", ctx.env);
  writeJob(jobDir, { id: "spawn-failure", state: "starting", request: {} });
  let calls = 0;
  assert.throws(() => spawnWithAdmission(jobDir, { RELAY_ADMISSION: "off" }, () => { calls++; throw new Error("synthetic spawn failure"); }), /synthetic spawn failure/);
  assert.equal(calls, 1);
});

test("jobs homes share one guard config and old custom-home off cannot disable admission", t => {
  const ctx = setup(t);
  const domain = path.join(ctx.root, "shared-domain");
  const env = { ...ctx.env, RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: domain };
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ admission: "off", maxVeryHeavy: 100 }));
  assert.equal(describeGuard(env, { readSensors: false }).enabled, true);
  const second = { ...env, RELAY_JOBS_HOME: path.join(ctx.root, "other-jobs") };
  const off = companion(ctx, ["setup", "--admission", "off", "--json"], env);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(describeGuard(second, { readSensors: false }).enabled, false);
  assert.equal("maxVeryHeavy" in readAdmissionConfig(second), false);
  assert.equal(describeGuard({ ...second, RELAY_ADMISSION: "off" }, { readSensors: false }).enabled, false);
});

test("recovering corrupt admission settings saves only normalized config", async t => {
  const { setAdmissionConfig } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const ctx = setup(t); ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "domain");
  fs.mkdirSync(ctx.env.RELAY_ADMISSION_HOME);
  const file = admissionConfigPath(ctx.env);
  fs.writeFileSync(file, "{");
  assert.ok(readAdmissionConfig(ctx.env).notes);
  setAdmissionConfig("admission", "off", ctx.env);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { admission: "off" });
  assert.equal(readAdmissionConfig(ctx.env).notes, undefined);
});

test("setup sizes the busy allowance and worker cap from its guard reading", { skip: !["linux", "darwin"].includes(process.platform) }, t => {
  const ctx = setup(t), fixture = path.join(ctx.root, "machine.json");
  fs.writeFileSync(fixture, JSON.stringify({ totalBytes: 32 * 2 ** 30, availableBytes: 24 * 2 ** 30, cores: 4, load5: 0 }));
  const result = companion(ctx, ["setup", "--json"], { RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: path.join(ctx.root, "domain"), RELAY_TEST_ADMISSION_READINGS: fixture });
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.settings.loadGuard.busySeats, 2);
  assert.equal(page.settings.loadGuard.maxWaitingWorkers, 8);
  assert.equal(page.settings.loadGuard.headroomBytes, page.loadGuard.headroomBytes);
});

test("deferred spawn errors remain retryable without aborting callers", async t => {
  const { createJobDir, writeJob, readJob, jobPaths } = await import("../plugins/relay/scripts/lib/jobs/store.mjs");
  const { retryQueuedWorker } = await import("../plugins/relay/scripts/lib/worker/delivery.mjs");
  const ctx = setup(t), { jobDir } = createJobDir(ctx.work, "queued-failure", ctx.env);
  writeJob(jobDir, { id: "queued-failure", state: "queued", request: { cwd: ctx.work }, admission: { waitKind: "worker", reason: "memory low" } });
  const spawn = childProcess.spawnSync, notes = [];
  t.mock.method(childProcess, "spawnSync", (command, args, ...rest) => {
    if (args?.[0]?.endsWith("/launcher.mjs")) throw new Error("synthetic spawn error");
    return spawn(command, args, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(process.stderr, "write", chunk => { notes.push(String(chunk)); return true; });
  assert.equal(retryQueuedWorker(jobDir, ctx.env), null);
  assert.equal(readJob(jobDir).state, "queued");
  assert.match(notes.join(""), /deferred worker spawn failed .*synthetic spawn error.*queued for retry/);
});

test("status shows both the completed queue duration and its cause", async t => {
  const { createJobDir, writeJob } = await import("../plugins/relay/scripts/lib/jobs/store.mjs");
  const ctx = setup(t), { jobDir } = createJobDir(ctx.work, "waited-cause", ctx.env);
  writeJob(jobDir, { id: "waited-cause", state: "completed", createdAt: "2025-01-01T00:00:00Z", request: {},
    admission: { state: "admitted", since: "2025-01-01T00:00:00Z", admittedAt: "2025-01-01T00:08:17.100Z", reason: "host memory low", waitKind: "memory" } });
  const text = companion(ctx, ["status", "waited-cause"]);
  assert.match(text.stdout, /waited 497\.1s before admission \(memory: host memory low\)/);
  const json = JSON.parse(companion(ctx, ["status", "waited-cause", "--json"]).stdout);
  assert.equal(json.admission.reason, "host memory low"); assert.equal(json.admission.waitKind, "memory");
});

for (const state of ["completed", "failed", "cancelled", "dead"]) test(`JSON closes a legacy admission wait on ${state} jobs without rewriting it`, async t => {
  const { createJobDir, jobPaths, writeJsonAtomic, readJob } = await import("../plugins/relay/scripts/lib/jobs/store.mjs");
  const ctx = setup(t), id = `ended-${state}`, { jobDir } = createJobDir(ctx.work, id, ctx.env);
  const admission = { state: "waiting", reason: "memory low", waitKind: "worker", since: "2025-01-01T00:00:00Z" };
  writeJsonAtomic(jobPaths(jobDir).job, { id, state: state === "dead" ? "starting" : state, request: {}, createdAt: "2025-01-01T00:00:00Z", admission });
  const result = JSON.parse(companion(ctx, ["status", id, "--json"]).stdout);
  assert.equal(result.state, state);
  assert.equal(result.admission.state, state === "cancelled" ? "cancelled" : "ended");
  assert.equal(result.admission.reason, admission.reason); assert.equal(result.admission.since, admission.since);
  const listing = JSON.parse(companion(ctx, ["status", "--json", "--all"]).stdout);
  assert.equal(listing.jobs[0].admission.state, result.admission.state);
  assert.deepEqual(readJob(jobDir).admission, admission, "status stays read-only");
});

test("stored maximum values are ignored with a note and never enter effective settings", t => {
  const ctx = setup(t); ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "domain");
  fs.mkdirSync(ctx.env.RELAY_ADMISSION_HOME);
  for (const maxVeryHeavy of [null, 1, 2, 100, "bad", {}]) {
    fs.writeFileSync(admissionConfigPath(ctx.env), JSON.stringify({ maxVeryHeavy }));
    const config = readAdmissionConfig(ctx.env);
    assert.equal("maxVeryHeavy" in config, false);
    assert.ok(config.notes.includes("maxVeryHeavy is ignored: very heavy jobs have no maximum"));
    assert.equal("maxVeryHeavy" in guardSettings(config), false);
    assert.equal(guardSettings(config).guaranteedVeryHeavy, 2);
  }
});
