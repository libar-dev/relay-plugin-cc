import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { setup, companion } from "./support/job-helpers.mjs";
import { parseModelClassSetting, readUserConfig } from "../plugins/relay/scripts/lib/jobs/config.mjs";
import { DEFAULTS as D, describeGuard, guardSettings } from "../plugins/relay/scripts/lib/worker/admission.mjs";

test("setup validates all guard flags before writing, resolves defaults and model overrides", t => {
  const ctx = setup(t);
  for (const args of [["--admission", "invalid"], ["--min-weight", "0"], ["--max-weight", "1.2"], ["--max-very-heavy", "101"], ["--model-class", "bad=unknown"], ["--backend", "codex", "--admission", "off"]]) {
    const result = companion(ctx, ["setup", ...args]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(ctx.jobs, "config.json")), false);
  }
  const result = companion(ctx, ["setup", "--admission", "off", "--min-weight", String(D.minWeight + 1), "--max-weight", "default", "--max-very-heavy", String(D.maxVeryHeavy + 1), "--model-class", "custom-*=light", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.settings.loadGuard.minWeight, D.minWeight + 1);
  assert.equal(page.settings.loadGuard.maxVeryHeavy, D.maxVeryHeavy + 1);
  assert.equal(page.loadGuard.enabled, false);
  assert.deepEqual(readUserConfig(ctx.env).modelClasses, [{ pattern: "custom-*", class: "light" }]);
  assert.deepEqual(parseModelClassSetting("none"), []);
});

test("corrupt stored settings normalize; JSON listing reads no sensors or lock", t => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ admission: "invalid", minWeight: -1, modelClasses: [{ class: "light" }, { pattern: "ok", class: "medium" }] }));
  const config = readUserConfig(ctx.env);
  assert.equal(config.admission, "on"); assert.equal(config.minWeight, null);
  assert.deepEqual(config.modelClasses, [{ pattern: "ok", class: "medium" }]);
  const env = { ...ctx.env, RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: path.join(ctx.root, "admission"), RELAY_ADMISSION_READINGS: path.join(ctx.root, "missing.json") };
  const snapshot = describeGuard(env, { readSensors: false }, { readMachine() { throw new Error("must not read"); } });
  assert.deepEqual(snapshot, { enabled: true, pauses: [] });
  const listing = companion(ctx, ["status", "--json", "--all"], env);
  assert.equal(listing.status, 0);
  assert.equal(JSON.parse(listing.stdout).loadGuard.enabled, true);
  assert.equal(fs.existsSync(env.RELAY_ADMISSION_HOME), false);
});
