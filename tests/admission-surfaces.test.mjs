import "./support/isolate-env.mjs";
import fs from "node:fs";
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
  const result = companion(ctx, ["setup", "--admission", "off", "--max-very-heavy", "1", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.settings.loadGuard.maxVeryHeavy, 1);
  assert.equal(page.settings.loadGuard.maxActive, null);
  assert.equal(page.loadGuard.enabled, false);
  assert.equal(readAdmissionConfig(ctx.env).admission, "off");
  assert.match(page.actionsTaken.join(" "), /domain-wide/);
  assert.equal(fs.existsSync(path.join(ctx.jobs, "config.json")), false);
});

test("corrupt stored settings normalize; JSON listing reads no sensors or lock", t => {
  const ctx = setup(t);
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, "domain");
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ admission: "invalid", minWeight: -1, modelClasses: [{ class: "light" }, { pattern: "ok", class: "medium" }] }));
  const config = readUserConfig(ctx.env);
  assert.equal(config.admission, undefined); assert.equal(config.minWeight, undefined);
  fs.mkdirSync(path.dirname(admissionConfigPath(ctx.env)), { recursive: true });
  fs.writeFileSync(admissionConfigPath(ctx.env), JSON.stringify({ admission: "invalid", maxVeryHeavy: 100 }));
  assert.deepEqual(readAdmissionConfig(ctx.env), { admission: "on", maxVeryHeavy: 2 });
  const env = { ...ctx.env, RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: path.join(ctx.root, "admission"), RELAY_ADMISSION_READINGS: path.join(ctx.root, "missing.json") };
  const snapshot = describeGuard(env, { readSensors: false }, { readMachine() { throw new Error("must not read"); } });
  assert.deepEqual(snapshot, { enabled: true, pauses: [] });
  const listing = companion(ctx, ["status", "--json", "--all"], env);
  assert.equal(listing.status, 0);
  assert.equal(JSON.parse(listing.stdout).loadGuard.enabled, true);
  assert.equal(fs.existsSync(env.RELAY_ADMISSION_HOME), false);
});

test("a worker-spawn failure is never retried as a guard failure", async t => {
  const { spawnWithAdmission } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  let calls = 0;
  assert.throws(() => spawnWithAdmission("/synthetic/absent", { RELAY_ADMISSION: "off" }, () => { calls++; throw new Error("synthetic spawn failure"); }), /synthetic spawn failure/);
  assert.equal(calls, 1);
});

test("jobs homes share one guard config and old custom-home off cannot disable admission", t => {
  const ctx = setup(t);
  const domain = path.join(ctx.root, "shared-domain");
  const env = { ...ctx.env, RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: domain };
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ admission: "off", maxVeryHeavy: 100 }));
  assert.equal(describeGuard(env, { readSensors: false }).enabled, true);
  const second = { ...env, RELAY_JOBS_HOME: path.join(ctx.root, "other-jobs") };
  const off = companion(ctx, ["setup", "--admission", "off", "--max-very-heavy", "1", "--json"], env);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(describeGuard(second, { readSensors: false }).enabled, false);
  assert.equal(readAdmissionConfig(second).maxVeryHeavy, 1);
  assert.equal(describeGuard({ ...second, RELAY_ADMISSION: "off" }, { readSensors: false }).enabled, false);
});
