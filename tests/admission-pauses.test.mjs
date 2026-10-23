import "./support/isolate-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS as D, admit, classifyRefusal, recordRefusal, probeSucceeded, releaseSlot, listPauses } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { kimiEnvironment } from "../plugins/relay/scripts/lib/backends/kimi/connection.mjs";
import { acquireOwnership, releaseOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";
const GiB = 2 ** 30;
const cases = [
  ["codex", { codexErrorInfo: "usageLimitExceeded" }, "usage"],
  ["codex", { codexErrorInfo: { rateLimitExceeded: {} } }, "rate"],
  ["codex", { data: { codexErrorInfo: "usageLimitExceeded" } }, "usage"],
  ...["5-hour", "weekly (7-day)", "monthly"].map(p => ["kimi", { message: `You've reached your ${p} usage limit` }, "usage"]),
  ["kimi", { message: "reached your concurrent request limit", data: { details: { statusCode: 403 } } }, "concurrency"],
  ["kimi", { message: "Too many requests" }, "rate"],
  ...["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321", "1302"].flatMap(code => [
    ["zcode", { data: { code } }, code === "1302" ? "rate" : "usage"],
    ["zcode", { message: `[${code}] synthetic` }, code === "1302" ? "rate" : "usage"],
    ["zcode", { message: `code ${code}` }, code === "1302" ? "rate" : "usage"]
  ])
];
for (const [index, [backend, error, kind]] of cases.entries()) test(`provider-owned refusal ${index + 1}: ${backend} ${kind}`, () => {
  assert.equal(classifyRefusal(backend, error)?.kind, kind);
});
test("bare status, unlisted errors and Grok never pause", () => {
  for (const backend of ["codex", "kimi", "zcode", "grok"]) assert.equal(classifyRefusal(backend, { message: "The engine is currently overloaded", data: { statusCode: 429 } }), null);
});
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pause-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: root };
  let now = Date.parse("2025-01-01T00:00:00Z");
  const deps = { env, now: () => now, isAlive: p => Boolean(p?.pid), readUserConfig: () => ({}), scanUnslotted: () => [],
    readMachine: () => ({ availableBytes: 100 * GiB, totalBytes: 128 * GiB, cores: 64, load5: 0, notes: [] }) };
  const ctx = n => ({ home: root, jobId: `job-${n}`, jobDir: root, request: { backend: "codex", effort: D.lightEfforts[0] }, me: { pid: n, startTime: "synthetic" } });
  return { root, env, deps, ctx, tick: ms => now += ms };
}
test("pause -> single generation-fenced probe -> success; unrelated success never clears", t => {
  const s = setup(t), refusal = classifyRefusal("codex", { codexErrorInfo: "rateLimitExceeded", message: "synthetic" });
  const pause = recordRefusal(s.root, "codex", refusal, "job-old", s.deps);
  assert.equal(pause.strikes, 1);
  assert.equal(admit(s.ctx(1), s.deps).waitKind, "pause");
  assert.equal(probeSucceeded(s.root, "codex", "job-old", s.deps, "old-generation"), false);
  s.tick(D.ratePauseMs);
  const first = admit(s.ctx(1), s.deps); assert.equal(first.slot.probe, true);
  assert.equal(admit(s.ctx(2), s.deps).waitKind, "probe");
  assert.equal(probeSucceeded(s.root, "codex", "job-1", s.deps, first.slot.probeGeneration), true);
  assert.equal(listPauses(s.env, s.deps).length, 0);
});
test("strikes deduplicate in-turn retries, double after a probe and cap; expiry and definite reset", t => {
  const s = setup(t), refusal = classifyRefusal("codex", { codexErrorInfo: "rateLimitExceeded" });
  assert.equal(recordRefusal(s.root, "codex", refusal, "job-a", s.deps).strikes, 1);
  assert.equal(recordRefusal(s.root, "codex", refusal, "job-a", s.deps).strikes, 1);
  s.tick(D.ratePauseMs);
  const next = recordRefusal(s.root, "codex", refusal, "job-a", s.deps);
  assert.equal(next.strikes, 2);
  assert.equal(Date.parse(next.until) - s.deps.now(), Math.min(D.ratePauseMs * 2, D.maxRatePauseMs));
  for (let n = 0; n < 12; n++) recordRefusal(s.root, "codex", refusal, `job-${n}`, s.deps);
  const capped = recordRefusal(s.root, "codex", refusal, "last", s.deps);
  assert.equal(Date.parse(capped.until) - s.deps.now(), D.maxRatePauseMs);
  s.tick(D.pauseExpiryMs); assert.equal(listPauses(s.env, s.deps).length, 0);
  const resetAt = new Date(s.deps.now() + D.usagePauseMs / 2).toISOString();
  const usage = classifyRefusal("codex", { codexErrorInfo: "usageLimitExceeded", message: `reset ${resetAt}` });
  assert.equal(recordRefusal(s.root, "codex", usage, "job-reset", s.deps).until, resetAt);
});
test("a probe lease includes startup; expired generations cannot clear a later probe", t => {
  const s = setup(t), refusal = classifyRefusal("codex", { codexErrorInfo: "rateLimitExceeded" });
  recordRefusal(s.root, "codex", refusal, "job-old", s.deps); s.tick(D.ratePauseMs);
  const first = admit(s.ctx(1), s.deps); s.tick(D.probeMs);
  const second = admit(s.ctx(2), s.deps);
  assert.equal(second.admit, true);
  assert.notEqual(second.slot.probeGeneration, first.slot.probeGeneration);
  assert.equal(probeSucceeded(s.root, "codex", "job-1", s.deps, first.slot.probeGeneration), false);
  assert.equal(probeSucceeded(s.root, "codex", "job-2", s.deps, second.slot.probeGeneration), true);
});
test("failed locked probe completion can retry; warm worker adopts its probe", t => {
  const s = setup(t), c = s.ctx(1);
  admit(c, s.deps);
  const refusal = classifyRefusal("codex", { codexErrorInfo: "rateLimitExceeded" });
  recordRefusal(s.root, "codex", refusal, "job-other", s.deps); s.tick(D.ratePauseMs);
  const warm = admit(c, s.deps); assert.equal(warm.slot.probe, true);
  const file = path.join(s.root, "admission.lock"); acquireOwnership(file, { pid: process.pid, startTime: null });
  try { assert.equal(probeSucceeded(s.root, "codex", c.jobId, s.deps, warm.slot.probeGeneration), false); }
  finally { releaseOwnership(file); }
  assert.equal(probeSucceeded(s.root, "codex", c.jobId, s.deps, warm.slot.probeGeneration), true);
});
test("off skips pauses and Kimi default; user retry value is preserved", t => {
  const s = setup(t), request = { kimiHome: "/synthetic/kimi" };
  assert.equal(kimiEnvironment(request, s.env).KIMI_LOOP_MAX_ATTEMPTS_PER_STEP, D.kimiAttempts);
  assert.equal(kimiEnvironment(request, { ...s.env, KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "7" }).KIMI_LOOP_MAX_ATTEMPTS_PER_STEP, "7");
  const off = { ...s.env, RELAY_ADMISSION: "off" };
  assert.equal(kimiEnvironment(request, off).KIMI_LOOP_MAX_ATTEMPTS_PER_STEP, undefined);
  assert.equal(recordRefusal(s.root, "codex", { kind: "usage" }, "job-1", { ...s.deps, env: off }), null);
});
