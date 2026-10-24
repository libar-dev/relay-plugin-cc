import "./support/isolate-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS as D, admit, classifyRefusal, recordRefusal, probeSucceeded, releaseSlot, listPauses, renderGuard } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { kimiEnvironment } from "../plugins/relay/scripts/lib/backends/kimi/connection.mjs";
import { acquireOwnership, releaseOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";
const GiB = 2 ** 30;
const cases = [
  ["codex", { codexErrorInfo: "usageLimitExceeded" }, "usage"],
  ["codex", { codexErrorInfo: { rateLimitExceeded: {} } }, "rate"],
  ["codex", { data: { codexErrorInfo: "usageLimitExceeded" } }, "usage"],
  ["codex", { data: { data: { codexErrorInfo: "usageLimitExceeded" } } }, "usage"],
  ...["5-hour", "weekly (7-day)", "monthly"].map(p => ["kimi", { message: `You've reached your ${p} usage limit` }, "usage"]),
  ["kimi", { message: "reached your concurrent request limit", data: { details: { statusCode: 403 } } }, "concurrency"],
  ["kimi", { message: "Too many requests" }, "rate"],
  ["grok", { message: "Weekly usage credits exhausted" }, "usage"],
  ["grok", { message: "You've reached your weekly usage limit" }, "usage"],
  ["grok", { data: { retryState: { reason: "weekly usage limit exceeded" } } }, "usage"],
  ["grok", { message: "HTTP 429 rate limit" }, "rate"],
  ["grok", { data: { retryState: { reason: "rate limit reached" } } }, "rate"],
  ...["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321", "1302"].flatMap(code => [
    ["zcode", { data: { code } }, code === "1302" ? "rate" : "usage"],
    ["zcode", { message: `[${code}] synthetic` }, code === "1302" ? "rate" : "usage"],
    ["zcode", { message: `code ${code}` }, code === "1302" ? "rate" : "usage"]
  ])
];
for (const [index, [backend, error, kind]] of cases.entries()) test(`provider-owned refusal ${index + 1}: ${backend} ${kind}`, () => {
  assert.equal(classifyRefusal(backend, error)?.kind, kind);
});
test("unlisted errors never pause; Grok recognizes provider 429", () => {
  for (const backend of ["codex", "kimi", "zcode"]) assert.equal(classifyRefusal(backend, { message: "The engine is currently overloaded", data: { statusCode: 429 } }), null);
});
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pause-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: root };
  let now = Date.parse("2025-01-01T00:00:00Z");
  const deps = { env, now: () => now, isAlive: p => Boolean(p?.pid), readAdmissionConfig: () => ({}), scanUnslotted: () => [],
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
  assert.equal(admit(s.ctx(2), s.deps).waitKind, "probe");
  const deadDeps = { ...s.deps, isAlive: p => p?.pid !== 1 && Boolean(p?.pid) };
  const second = admit(s.ctx(2), deadDeps);
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
  const warm = admit({ ...c, turn: true }, s.deps); assert.equal(warm.slot.probe, true);
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


test("provider pauses and probe completion survive momentary admission-lock contention", t => {
  const s = setup(t), file = path.join(s.root, "admission.lock");
  let retries = 0;
  const deps = { ...s.deps, lockSleep: () => { retries++; releaseOwnership(file); } };
  acquireOwnership(file, { pid: process.pid }); t.after(() => releaseOwnership(file));
  const pause = recordRefusal(s.root, "codex", { kind: "rate" }, "old-job", deps);
  assert.ok(pause); assert.equal(retries, 1);
  assert.equal(admit(s.ctx(1), s.deps).waitKind, "pause");
  s.tick(D.ratePauseMs);
  const probe = admit(s.ctx(1), s.deps);
  acquireOwnership(file, { pid: process.pid });
  assert.equal(probeSucceeded(s.root, "codex", "job-1", deps, probe.slot.probeGeneration), true);
  assert.equal(retries, 2); assert.equal(listPauses(s.env, s.deps).length, 0);
});

test("abandoning an unfinished probe retains strikes and cannot release a newer generation", async t => {
  const { releaseProbe } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = setup(t);
  recordRefusal(s.root, "codex", { kind: "rate" }, "old", s.deps);
  recordRefusal(s.root, "codex", { kind: "rate" }, "other", s.deps);
  s.tick(D.ratePauseMs * 2);
  const first = admit(s.ctx(1), s.deps);
  s.tick(D.probeMs);
  assert.equal(releaseProbe(s.root, "codex", "job-1", s.deps, first.slot.probeGeneration), true);
  const pause = listPauses(s.env, s.deps)[0];
  assert.equal(pause.strikes, 2); assert.equal(pause.probing, false);
  const next = admit(s.ctx(2), s.deps);
  assert.equal(next.slot.probe, true);
  assert.equal(releaseProbe(s.root, "codex", "job-1", s.deps, first.slot.probeGeneration), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, "pauses", "codex.json"))).probe.generation, next.slot.probeGeneration);
});

test("retained turns claim, adopt and release fenced probes without changing startup holds or timing", async t => {
  const { releaseProbe } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = setup(t), c = s.ctx(1), peer = s.ctx(2);
  const first = admit(c, s.deps); s.tick(D.spacingMs); admit(peer, s.deps);
  const timingFile = path.join(s.root, "timing.json"), timing = fs.readFileSync(timingFile, "utf8");
  const turn = () => admit({ ...c, turn: true }, s.deps);
  const assertPreserved = result => {
    assert.equal(result.slot.holdAt, first.slot.holdAt); assert.equal(result.slot.holdBytes, first.slot.holdBytes);
    assert.equal(fs.readFileSync(timingFile, "utf8"), timing);
    assert.equal(fs.readdirSync(path.join(s.root, "slots")).length, 2);
  };
  recordRefusal(s.root, "codex", { kind: "rate" }, "old", s.deps);
  const wait = turn(); assert.equal(wait.waitKind, "pause"); assertPreserved(wait);
  s.tick(D.ratePauseMs);
  const probe = admit({ ...c, turn: true, admission: wait.record, waitingSince: wait.record.since }, s.deps);
  assertPreserved(probe); assert.equal(probe.slot.probe, true);
  assert.equal(Date.parse(probe.record.admittedAt) - Date.parse(probe.record.since), D.ratePauseMs);
  assert.equal(admit({ ...peer, turn: true }, s.deps).waitKind, "probe");
  const adopted = turn(); assertPreserved(adopted); assert.equal(adopted.slot.probeGeneration, probe.slot.probeGeneration);
  assert.equal(releaseProbe(s.root, "codex", c.jobId, s.deps, probe.slot.probeGeneration), true);
  const next = turn(); assertPreserved(next); assert.notEqual(next.slot.probeGeneration, probe.slot.probeGeneration);
  assert.equal(releaseProbe(s.root, "codex", c.jobId, s.deps, probe.slot.probeGeneration), false);
  assert.equal(probeSucceeded(s.root, "codex", c.jobId, s.deps, probe.slot.probeGeneration), false);
  assert.equal(probeSucceeded(s.root, "codex", c.jobId, s.deps, next.slot.probeGeneration), true);
  assertPreserved(turn()); assert.equal(listPauses(s.env, s.deps).length, 0);
});

for (const contents of ["nope", JSON.stringify({ v: 1, backend: "codex", kind: "rate", until: "invalid" })]) test(`damaged pause holds until quarantine: ${contents}`, t => {
  const s = setup(t), dir = path.join(s.root, "pauses"), file = path.join(dir, "codex.json");
  fs.mkdirSync(dir); fs.writeFileSync(file, contents);
  fs.utimesSync(file, s.deps.now() / 1000, s.deps.now() / 1000);
  const held = admit(s.ctx(1), s.deps);
  assert.equal(held.waitKind, "pause"); assert.match(held.reason, /codex pause record unreadable; holding until/);
  s.tick(D.maxRatePauseMs - 1); assert.equal(admit(s.ctx(1), s.deps).waitKind, "pause");
  s.tick(1); assert.equal(admit(s.ctx(1), s.deps).admit, true);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readdirSync(path.join(dir, "quarantine")).length, 1);
});

test("a refusal blocked by a live child's lock is folded before the next grant", async t => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { readProcessStartTime } = await import("../plugins/relay/scripts/lib/util/process.mjs");
  const s = setup(t), file = path.join(s.root, "admission.lock");
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"]);
  t.after(() => child.kill()); await once(child.stdout, "data");
  acquireOwnership(file, { pid: child.pid, startTime: readProcessStartTime(child.pid) });
  const deps = { ...s.deps, lockSleep: () => {} };
  assert.deepEqual(recordRefusal(s.root, "codex", { kind: "rate" }, "old-job", deps), { pending: true });
  const pending = path.join(s.root, "pauses", "pending");
  assert.equal(fs.readdirSync(pending).length, 1);
  child.kill(); await once(child, "close");
  const { isProcessIdentityAlive } = await import("../plugins/relay/scripts/lib/util/process.mjs");
  assert.equal(admit(s.ctx(1), { ...s.deps, isAlive: p => p?.pid === child.pid ? isProcessIdentityAlive(p) : Boolean(p?.pid) }).waitKind, "pause");
  assert.equal(fs.readdirSync(pending).length, 0);
});

test("a live child probe is never expired by age, including the pause's expiry", async t => {
  const { spawn } = await import("node:child_process"), { once } = await import("node:events");
  const { isProcessIdentityAlive, readProcessStartTime } = await import("../plugins/relay/scripts/lib/util/process.mjs");
  const s = setup(t);
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"]);
  t.after(() => child.kill()); await once(child.stdout, "data");
  const deps = { ...s.deps, isAlive: p => p?.pid === child.pid ? isProcessIdentityAlive(p) : Boolean(p?.pid) };
  recordRefusal(s.root, "codex", { kind: "rate" }, "old-job", deps); s.tick(D.ratePauseMs);
  const owner = { ...s.ctx(1), me: { pid: child.pid, startTime: readProcessStartTime(child.pid) } };
  const first = admit(owner, deps); assert.equal(first.slot.probe, true);
  s.tick(D.probeMs + 1);
  assert.equal(admit(s.ctx(2), deps).waitKind, "probe"); assert.equal(listPauses(s.env, deps)[0].probing, true);
  s.tick(D.pauseExpiryMs);
  assert.equal(admit(s.ctx(2), deps).waitKind, "probe");
  child.kill(); await once(child, "close");
  assert.equal(admit(s.ctx(2), deps).admit, true);
});

test("account pauses, probe generations and releases follow durable request accounts", async t => {
  const { buildLaunchRequest } = await import("../plugins/relay/scripts/lib/jobs/request.mjs");
  const { releaseProbe } = await import("../plugins/relay/scripts/lib/worker/admission.mjs");
  const s = setup(t), env = { ...s.env, HOME: s.root };
  const request = home => buildLaunchRequest({ backend: "kimi", model: "default", effort: "default", kimiHome: home }, { env });
  const a = { ...s.ctx(1), request: request("account-a") }, b = { ...s.ctx(2), request: request("account-b") };
  assert.match(a.request.account, /^[a-f0-9]{12}$/); assert.notEqual(a.request.account, b.request.account);
  assert.equal(admit(a, s.deps).admit, true); s.tick(D.spacingMs);
  // No request injection: use the worker's existing public call shape.
  recordRefusal(s.root, "kimi", { kind: "rate" }, a.jobId, s.deps);
  assert.ok(fs.existsSync(path.join(s.root, "pauses", `kimi-${a.request.account}.json`)));
  assert.equal(admit(a, s.deps).waitKind, "pause"); assert.equal(admit(b, s.deps).admit, true);
  s.tick(D.ratePauseMs);
  const probe = admit(a, s.deps); assert.equal(probe.slot.probe, true);
  assert.equal(releaseProbe(s.root, "kimi", a.jobId, s.deps, probe.slot.probeGeneration), true);
  const next = admit({ ...a, turn: true }, s.deps); assert.equal(next.slot.probe, true);
  assert.equal(probeSucceeded(s.root, "kimi", a.jobId, s.deps, next.slot.probeGeneration), true);
  const defaultRequest = request("default"); assert.equal(defaultRequest.account, null);
  const c = { ...s.ctx(3), request: defaultRequest }; s.tick(D.spacingMs); admit(c, s.deps);
  recordRefusal(s.root, "kimi", { kind: "usage" }, c.jobId, s.deps);
  assert.ok(fs.existsSync(path.join(s.root, "pauses", "kimi.json")));
  assert.equal(admit(c, s.deps).waitKind, "pause");
  assert.equal(listPauses(s.env, s.deps)[0].account, null);
});

test("all backend home exports hash only non-default resolved homes", async t => {
  const { buildLaunchRequest } = await import("../plugins/relay/scripts/lib/jobs/request.mjs");
  const { createHash } = await import("node:crypto");
  const s = setup(t), env = { ...s.env, HOME: s.root };
  for (const backend of ["codex", "grok", "kimi", "zcode"]) {
    const values = { backend, model: "default", effort: "default" };
    assert.equal(buildLaunchRequest(values, { env }).account, null, backend);
    const home = path.join(s.root, `${backend}-account`);
    const alternate = { ...env, ...(backend === "codex" ? { CODEX_HOME: home } : backend === "zcode" ? { ZCODE_DATA_BASE_DIR: home } : {}) };
    const fields = backend === "kimi" ? { kimiHome: home } : backend === "grok" ? { grokHome: home } : {};
    const request = buildLaunchRequest({ ...values, ...fields }, { env: alternate });
    assert.equal(request.account, createHash("sha256").update(home).digest("hex").slice(0, 12), backend);
  }
  assert.equal(classifyRefusal("grok", { message: "An unknown engine failure" }), null);
});

test("pending refusals are applied only to their account", t => {
  const s = setup(t), file = path.join(s.root, "admission.lock"), account = "123456abcdef";
  acquireOwnership(file, { pid: process.pid });
  try {
    assert.deepEqual(recordRefusal(s.root, "kimi", { kind: "rate" }, "job-a", { ...s.deps, request: { account }, lockSleep: () => {} }), { pending: true });
  } finally { releaseOwnership(file); }
  const pending = path.join(s.root, "pauses", "pending");
  const ctx = { ...s.ctx(1), request: { backend: "kimi", account: "abcdef123456" } };
  assert.equal(admit(ctx, s.deps).admit, true);
  assert.equal(fs.readdirSync(pending).length, 1);
  assert.equal(admit({ ...s.ctx(2), request: { backend: "kimi", account } }, s.deps).waitKind, "pause");
  assert.equal(fs.readdirSync(pending).length, 0);
});


for (const contents of ["{", JSON.stringify({ account: "invalid", refusal: { kind: "rate" } })]) test(`damaged pending refusals hold only their backend and quarantine: ${contents}`, t => {
  const s = setup(t), dir = path.join(s.root, "pauses", "pending"), file = path.join(dir, "codex-damaged.json");
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, contents);
  fs.utimesSync(file, s.deps.now() / 1000, s.deps.now() / 1000);
  const held = admit(s.ctx(1), s.deps);
  assert.equal(held.waitKind, "pause"); assert.match(held.reason, /codex pending refusal codex-damaged.json unreadable; holding until/);
  assert.equal(admit({ ...s.ctx(3), request: { backend: "codex", account: "123456abcdef" } }, s.deps).waitKind, "pause");
  const other = { ...s.ctx(2), request: { backend: "kimi" } };
  assert.equal(admit(other, s.deps).admit, true, "damaged Codex claimant cannot block Kimi");
  s.tick(D.maxRatePauseMs - 1); assert.equal(admit(s.ctx(1), s.deps).waitKind, "pause");
  s.tick(1); assert.equal(admit(s.ctx(1), s.deps).admit, true);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readdirSync(path.join(dir, "quarantine")).length, 1);
});

test("invalid pending refusal kinds hold only the identifiable account until quarantine", t => {
  const s = setup(t), dir = path.join(s.root, "pauses", "pending"), file = path.join(dir, "codex-damaged.json"), account = "123456abcdef";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ account, jobId: "old", refusal: { kind: "future-kind" } }));
  fs.utimesSync(file, s.deps.now() / 1000, s.deps.now() / 1000);
  const affected = { ...s.ctx(1), request: { backend: "codex", account } };
  assert.equal(admit(affected, s.deps).waitKind, "pause");
  assert.equal(admit(s.ctx(2), s.deps).admit, true);
  s.tick(D.maxRatePauseMs); assert.equal(admit(affected, s.deps).admit, true);
  assert.equal(fs.existsSync(file), false);
});

for (const kind of ["rate", "usage"]) test(`pending ${kind} refusals keep their receipt deadline after lock contention`, t => {
  const s = setup(t), file = path.join(s.root, "admission.lock"), receivedAt = s.deps.now();
  const resetAt = new Date(receivedAt + D.ratePauseMs).toISOString();
  acquireOwnership(file, { pid: process.pid });
  try { assert.deepEqual(recordRefusal(s.root, "codex", { kind, ...(kind === "usage" ? { resetAt } : {}) }, "old", { ...s.deps, lockSleep() {} }), { pending: true }); }
  finally { releaseOwnership(file); }
  const dir = path.join(s.root, "pauses", "pending");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]))).receivedAt, new Date(receivedAt).toISOString());
  s.tick(D.ratePauseMs + 1);
  const result = admit(s.ctx(1), s.deps);
  assert.equal(result.admit, true); assert.equal(result.slot.probe, true);
  assert.equal(listPauses(s.env, s.deps)[0].until, resetAt);
  assert.equal(probeSucceeded(s.root, "codex", "job-1", s.deps, result.slot.probeGeneration), true);
  releaseSlot(s.root, "job-1", s.ctx(1).me, s.deps);
  const legacy = path.join(dir, "codex-legacy.json");
  fs.writeFileSync(legacy, JSON.stringify({ account: null, refusal: { kind }, jobId: "legacy" }));
  fs.utimesSync(legacy, receivedAt / 1000, receivedAt / 1000);
  s.tick(D.usagePauseMs);
  assert.equal(admit(s.ctx(2), s.deps).admit, true, "legacy pending files use mtime as receipt time");
});

test("pending refusals replay in arrival order and never shorten a pause in force", t => {
  const s = setup(t), file = path.join(s.root, "admission.lock"), dir = path.join(s.root, "pauses", "pending");
  const first = s.deps.now(), laterReset = new Date(first + 20 * 60000).toISOString(), earlierReset = new Date(first + 5 * 60000).toISOString();
  acquireOwnership(file, { pid: process.pid });
  try {
    assert.deepEqual(recordRefusal(s.root, "codex", { kind: "usage", resetAt: laterReset }, "newer", { ...s.deps, lockSleep() {} }), { pending: true });
  } finally { releaseOwnership(file); }
  // An older refusal with an earlier reset, saved under a name that sorts last.
  fs.writeFileSync(path.join(dir, "codex-zzzz-older.json"), JSON.stringify({ backend: "codex", account: null, refusal: { kind: "usage", resetAt: earlierReset }, jobId: "older", receivedAt: new Date(first - 60000).toISOString() }));
  assert.equal(admit(s.ctx(1), s.deps).waitKind, "pause");
  const [pause] = listPauses(s.env, s.deps);
  assert.equal(pause.until, laterReset, "the later provider reset stands");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a provider reset already past at receipt gets the default usage pause, not an immediate probe", t => {
  const s = setup(t), now = s.deps.now(), resetAt = new Date(now - 1000).toISOString();
  const p = recordRefusal(s.root, "codex", { kind: "usage", resetAt }, "old", s.deps);
  assert.equal(p.resetSource, "default");
  assert.equal(p.until, new Date(now + D.usagePauseMs).toISOString());
  assert.equal(admit(s.ctx(1), s.deps).waitKind, "pause");
  s.tick(D.usagePauseMs);
  assert.equal(admit(s.ctx(1), s.deps).slot.probe, true);
});

test("Grok ignores incidental status numbers and token limits but recognizes documented quota refusals", () => {
  for (const message of ["Could not open document 429", "token usage limit exceeded", "context usage limit exceeded", "usage statistics exhausted"]) {
    assert.equal(classifyRefusal("grok", { message }), null, message);
  }
  for (const message of ["HTTP 429", "429 Too Many Requests"]) assert.equal(classifyRefusal("grok", { message }).kind, "rate");
  assert.equal(classifyRefusal("grok", { data: { statusCode: 429 } }).kind, "rate");
  for (const message of ["usage limit exceeded", "usage pool exhausted", "credits depleted", "weekly limit reached"]) assert.equal(classifyRefusal("grok", { message }).kind, "usage");
});

test("guard status identifies each paused account", t => {
  const s = setup(t), account = "123456abcdef";
  recordRefusal(s.root, "kimi", { kind: "rate" }, "old", { ...s.deps, request: { account } });
  const lines = renderGuard({ enabled: true, availableBytes: null, pauses: listPauses(s.env, s.deps) });
  assert.ok(lines.some(line => line.includes(`kimi (account ${account}) paused:`)));
});
