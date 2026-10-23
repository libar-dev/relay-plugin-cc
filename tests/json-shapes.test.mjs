import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { companion, finishJob, HEADER, jobDir, promptFile, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo, run } from "./support/helpers.mjs";
import { jobPaths, repoSlugFor, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { appendRelayViolation, postInboxMessage, writeOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { PLUGIN_BUILD, PLUGIN_VERSION } from "../plugins/relay/scripts/lib/util/plugin.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { installFakeKimi } from "./fakes/kimi.mjs";
import { installFakeZcode } from "./fakes/zcode.mjs";

// Goldens transcribed from the writers, deliberately not imported from jobViewJson.
// cli/ + companion's JSON_COMMANDS also include review, adversarial-review and transfer.
// Rows omit messages; --estimate uses relay.review-estimate/1 for BOTH reviews.
const HEAD = ["schema", "relayVersion", "relayBuild"];
const JOB = [
  "id", "kind", "state", "storedState", "stalled", "deadReason", "sessionId", "turnId",
  "claudeSessionId", "model", "effort", "backend", "fast", "serviceTier", "mode", "webSearch",
  "cwd", "attempts", "errorMessage", "createdAt", "updatedAt", "completedAt", "jobDir",
  "reportPath", "hasReport", "summary", "relay", "relayViolations", "relayViolationCount",
  "handedBackAt", "notHandedBack", "openMessages", "messages", "automaticResumes",
  "automaticResumeCount", "attemptRecords", "server", "undelivered", "undeliveredCount",
  "dropped", "droppedCount"
];
const ROW = JOB.filter(key => !["attemptRecords", "server", "messages"].includes(key));
const LAUNCH = ["jobId", "state", "jobDir", "notes", "backend"];
const backendKeys = (common, backend) => common.flatMap(key => key === "backend" ? [key, `${backend}Home`] : [key]);
const PAGE = ["jobsHome", "scope", "repoSlug", "workflowRunId", "active", "limit", "jobs", "nextCursor"];
const MESSAGE = ["id", "kind", "createdAt", "stage", "preview", "relay", "outcome"];
const OUTCOME = ["action", "at", "reason", "attempt", "turnId"];
const ATTEMPT = ["attempt", "source", "automatic", "messageId", "startedAt", "relayVersion", "turnId", "state"];
const SERVER = ["pid", "startTime", "startedAt"];
const ENDED_SERVER = [...SERVER, "code", "signal", "endedAt", "stdoutClosedBeforeExit", "partialStdoutBytes", "stderrTail"];
const AT = "2026-01-01T00:00:00.000Z";

function keys(value, expected, at, ordered = false) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${at}: expected an object`);
  const actual = Object.keys(value);
  const missing = expected.filter(key => !Object.hasOwn(value, key));
  const added = actual.filter(key => !expected.includes(key));
  assert.deepEqual({ missing, added }, { missing: [], added: [] },
    `${at}: missing keys [${missing.join(", ")}]; unexpected keys [${added.join(", ")}]`);
  if (ordered) assert.deepEqual(actual, expected, `${at}: key order changed (actual: ${actual.join(", ")})`);
}

function json(ctx, args, expectedKeys, { status = 0, extra = {}, schema = args[0] } = {}) {
  const result = companion(ctx, [...args, "--json"], extra);
  assert.equal(result.status, status, result.stderr || result.stdout);
  assert.equal(result.stderr, "", `${args[0]} --json stderr`);
  const value = JSON.parse(result.stdout);
  // Order belongs to the header and view/page literals, not persisted nested records
  // or other command envelopes. Rows opt in separately below.
  keys(value, [...HEAD, ...expectedKeys], `${args[0]} stdout`, expectedKeys[0] === "id" || expectedKeys === PAGE);
  assert.deepEqual(Object.keys(value).slice(0, HEAD.length), HEAD, `${args[0]} header order`);
  assert.equal(value.schema, `relay.${schema}/1`, `${args[0]} schema`);
  assert.equal(value.relayVersion, PLUGIN_VERSION);
  assert.equal(value.relayBuild, PLUGIN_BUILD);
  // JSON.parse rejects extra documents; require exactly one trailing newline while
  // allowing the writer to choose its indentation (including compact JSON).
  assert.match(result.stdout, /[^\s]\n$/);
  return value;
}

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

async function completed(t) {
  const ctx = setup(t);
  const { id } = startJob(ctx);
  await finishJob(ctx, id);
  return { ctx, id, dir: jobDir(ctx, id) };
}

function backendFixture(t, backend) {
  const ctx = setup(t, { behavior: "review-ok" });
  const install = { grok: installFakeGrok, kimi: installFakeKimi, zcode: installFakeZcode }[backend];
  if (install) ctx.env[`${backend.toUpperCase()}_BINARY`] = install(ctx.bin).binary;
  ctx.env.RELAY_JOBS_KIMI_POLL_MS = "20";
  return ctx;
}

function messagesShape(value, at) {
  for (const [index, message] of value.messages.entries()) {
    const here = `${at}.messages[${index}]`;
    keys(message, MESSAGE, here);
    if (message.relay) keys(message.relay, ["entry", "at"], `${here}.relay`);
    if (message.outcome) keys(message.outcome, OUTCOME, `${here}.outcome`);
  }
}

function completedShape(value, at) {
  messagesShape(value, at);
  assert.ok(value.attemptRecords.length > 0, `${at}.attemptRecords must exercise a nested object`);
  for (const [i, attempt] of value.attemptRecords.entries()) {
    keys(attempt, [...ATTEMPT, "servers", "endedAt", "hasReport"], `${at}.attemptRecords[${i}]`);
    assert.ok(attempt.servers.length > 0);
    for (const server of attempt.servers) {
      keys(server, ENDED_SERVER, `${at}.attemptRecords[${i}].servers[]`);
    }
  }
  assert.equal(value.server, null);
}

test("start --json golden shape (ordinary and relay launch)", async t => {
  const ctx = setup(t);
  const ordinary = json(ctx, ["start", "--prompt-file", promptFile(ctx)], LAUNCH);
  assert.equal(ordinary.backend, "codex");
  await finishJob(ctx, ordinary.jobId);
  const transcript = path.join(ctx.root, "agent.jsonl");
  put(transcript, { type: "user", uuid: "brief", message: { role: "user", content: `${HEADER}\n---\n[quick] Relay.` } });
  const relay = json(ctx, ["start", "--from-relay", "--relay-agent", "agent-shape", "--relay-transcript", transcript], LAUNCH);
  await finishJob(ctx, relay.jobId);
  const view = json(ctx, ["status", relay.jobId], JOB);
  keys(view.relay, ["agentId", "transcriptPath", "promptUuid", "promptSha256", "workflowRunId", "label", "phase", "stringReturn", "lastToolAt"], "status.relay");
  assert.equal(view.relay.lastToolAt, null);
  completedShape(view, "status");
});

for (const backend of ["grok", "kimi"]) {
  test(`${backend} --json golden launch, full views and listing row include its home`, async t => {
    const ctx = backendFixture(t, backend);
    const header = backend === "grok" ? "backend: grok\nmodel: grok-custom\neffort: ultra\ngrok-home: jobs"
      : "backend: kimi\nmodel: kimi-code/k3\neffort: low\nkimi-home: jobs";
    const homeKey = `${backend}Home`;
    const home = path.join(ctx.user, backend === "grok" ? ".grok-jobs" : ".kimi-code-jobs");
    const launch = json(ctx, ["start", "--prompt-file", promptFile(ctx, header)], backendKeys(LAUNCH, backend));
    assert.equal(launch.backend, backend);
    assert.equal(launch[homeKey], home);
    await finishJob(ctx, launch.jobId);
    for (const command of ["status", "result", "wait"]) {
      const value = json(ctx, [command, launch.jobId], [...backendKeys(JOB, backend), ...(command === "status" ? [] : ["report"])]);
      assert.equal(value.backend, backend);
      assert.equal(value[homeKey], home);
      messagesShape(value, command);
    }
    const page = json(ctx, ["status"], PAGE);
    assert.equal(page.jobs.length, 1);
    keys(page.jobs[0], backendKeys(ROW, backend), `${backend} status.jobs[0]`, true);
    assert.equal(page.jobs[0].backend, backend);
    assert.equal(page.jobs[0][homeKey], home);
  });
}

for (const command of ["status", "result", "wait"]) {
  test(`${command} one-job --json golden shape and message records`, async t => {
    const { ctx, id, dir } = await completed(t);
    // Exercise nullable and populated entries, including the #15/#20 additions. The job
    // itself and its completed attempt/report came from the real worker + fake Codex.
    put(jobPaths(dir).relay, { agentId: "shape-relay", workflowRunId: "wf-shape", label: "Review", phase: "test" });
    put(path.join(dir, "relay-guard.json"), { lastToolAt: AT });
    const delivered = postInboxMessage(dir, { kind: "steer", text: "Delivered." });
    fs.mkdirSync(jobPaths(dir).claimed, { recursive: true });
    fs.renameSync(path.join(jobPaths(dir).inbox, `${delivered.id}.json`), path.join(jobPaths(dir).claimed, `${delivered.id}.json`));
    writeOutcome(dir, delivered.id, { action: "steered", turnId: "turn-shape" });
    put(path.join(dir, "inbox/relay/entry-shape.json"), { uuid: "entry-shape", messageId: delivered.id, at: AT });
    const pending = postInboxMessage(dir, { kind: "continue", text: "Pending." });
    const dropped = postInboxMessage(dir, { kind: "steer", text: "Dropped." });
    fs.renameSync(path.join(jobPaths(dir).inbox, `${dropped.id}.json`), path.join(jobPaths(dir).claimed, `${dropped.id}.json`));
    writeOutcome(dir, dropped.id, { action: "dropped", reason: "Not delivered." });
    appendRelayViolation(dir, { kind: "transcript", reason: "Unreadable entry.", agentId: "shape-relay" });
    const stored = readJob(ctx, id);
    writeJob(dir, { ...stored, relay: {}, launchedBy: { ...stored.launchedBy, claudeSessionId: "claude-shape" },
      automaticResumes: [{ id: "auto-shape", epoch: "start", at: AT, fromAttempt: 1, reason: "worker", state: "launched" }]
    });
    const expected = command === "status" ? JOB : [...JOB, "report"];
    const value = json(ctx, [command, id], expected, { status: command === "status" ? 0 : 3 });
    completedShape(value, command);
    // Reader round-trip of the binding and automatic resume seeded above; the real
    // relay-binding writer is pinned by the start --from-relay test.
    keys(value.relay, ["agentId", "workflowRunId", "label", "phase", "lastToolAt"], `${command}.relay (reader round-trip)`);
    assert.equal(value.messages.length, 3);
    keys(value.relayViolations[0], ["at", "kind", "reason", "agentId"], `${command}.relayViolations[0]`);
    keys(value.automaticResumes[0], ["id", "epoch", "at", "fromAttempt", "reason", "state"], `${command}.automaticResumes[0] (reader round-trip)`);
    keys(value.dropped[0], ["id", "reason"], `${command}.dropped[0]`);
    const entries = Object.fromEntries(value.messages.map(entry => [entry.id, entry]));
    assert.equal(entries[delivered.id].outcome.action, "steered");
    assert.deepEqual(entries[delivered.id].relay, { entry: "entry-shape", at: AT });
    assert.equal(entries[pending.id].stage, "pending");
    assert.equal(entries[pending.id].outcome, null);
    assert.equal(value.openMessages, 1);
    assert.deepEqual(value.undelivered, [pending.id]);
    assert.equal(value.notHandedBack, true);
    assert.equal(value.hasReport, true);
    assert.equal(value.updatedAt, readJob(ctx, id).updatedAt);
    assert.equal(value.claudeSessionId, "claude-shape");
    assert.equal(value.relay.lastToolAt, AT);
    if (command !== "status") {
      assert.equal(value.report, fs.readFileSync(jobPaths(dir).report, "utf8"));
      const stateOnly = json(ctx, [command, id, "--state-only"], expected, { status: 3 });
      assert.equal(stateOnly.report, null);
      completedShape(stateOnly, `${command} --state-only`);
    }
  });
}

for (const command of ["steer", "continue", "resume"]) {
  test(`${command} --json golden delivery shape`, async t => {
    const ctx = setup(t, { turnMs: command === "steer" ? 60000 : 500 });
    const { id } = startJob(ctx, HEADER, command === "steer" ? "Keep working." : "[quick] First.");
    if (command === "steer") await waitFor(() => readJob(ctx, id).turnId);
    else await finishJob(ctx, id);
    // resume always writes isDefault, for both the default and an explicit message.
    const args = command === "resume" ? [command, id] : [command, id, "--message", "[quick] Next."];
    const value = json(ctx, args, ["job", "message", "outcome", "spawned", "state"]);
    keys(value.message, command === "resume" ? ["kind", "text", "isDefault", "id", "createdAt"] : ["kind", "text", "id", "createdAt"], `${command}.message`);
    if (command === "resume") assert.equal(value.message.isDefault, true);
    assert.equal(value.message.kind, command);
    assert.equal(value.job, id);
    assert.equal(typeof value.spawned, "number");
    // Pin the receipt branch this invocation observes; this does not exercise both
    // accepted-next-turn and turn-started deterministically.
    if (command === "steer") {
      assert.equal(value.outcome.action, "steered");
      keys(value.outcome, ["messageId", "at", "action", "turnId"], "steer.outcome");
    } else {
      assert.ok(["accepted-next-turn", "turn-started"].includes(value.outcome.action));
      keys(value.outcome, value.outcome.action === "turn-started"
        ? ["messageId", "at", "action", "attempt", "turnId"] : ["messageId", "at", "action", "attempt"], `${command}.outcome`);
    }
    if (command !== "steer") await finishJob(ctx, id);
    if (command === "resume") {
      const explicit = json(ctx, ["resume", id, "--message", "[quick] Explicit resume."], ["job", "message", "outcome", "spawned", "state"]);
      keys(explicit.message, ["kind", "text", "isDefault", "id", "createdAt"], "resume --message.message");
      assert.equal(explicit.message.isDefault, false);
      assert.ok(["accepted-next-turn", "turn-started"].includes(explicit.outcome.action));
      keys(explicit.outcome, explicit.outcome.action === "turn-started"
        ? ["messageId", "at", "action", "attempt", "turnId"] : ["messageId", "at", "action", "attempt"], "resume --message.outcome");
      await finishJob(ctx, id);
    }
  });
}

for (const attempt of [false, true]) {
  test(`cancel${attempt ? " --attempt" : ""} --json golden job and actions shape`, async t => {
    const ctx = setup(t, { turnMs: 60000 });
    const { id } = startJob(ctx, HEADER, "Keep working.");
    await waitFor(() => readJob(ctx, id).turnId);
    const running = json(ctx, ["status", id], JOB);
    keys(running.server, SERVER, "status.server");
    keys(running.attemptRecords[0], [...ATTEMPT, "servers"], "status.attemptRecords[0]");
    keys(running.attemptRecords[0].servers[0], SERVER, "status.attemptRecords[0].servers[0]");
    const value = json(ctx, ["cancel", id, ...(attempt ? ["--attempt", "1"] : [])], [...JOB, "actions"]);
    assert.equal(value.state, "cancelled");
    assert.ok(value.actions.includes("asked the worker to interrupt the turn"));
    assert.ok(value.actions.every(action => typeof action === "string"));
    messagesShape(value, "cancel");
    assert.equal(value.attemptRecords.length, 1);
    keys(value.attemptRecords[0], [...ATTEMPT, "servers", "endedAt", "errorMessage", "hasReport"], "cancel.attemptRecords[0]");
    for (const server of value.attemptRecords[0].servers) {
      keys(server, server.endedAt ? ENDED_SERVER : SERVER, "cancel.attemptRecords[0].servers[]");
    }
    if (value.server) keys(value.server, SERVER, "cancel.server");
    // The already-terminal branch has exactly the same top-level contract.
    const again = json(ctx, ["cancel", id], [...JOB, "actions"]);
    assert.deepEqual(again.actions, ["already cancelled"]);
    assert.equal(ctx.fakeState().interrupts.length, 1);
  });
}

for (const background of [false, true]) {
  test(`task${background ? " --background" : ""} --json golden shape`, async t => {
    const ctx = setup(t);
    const value = json(ctx, ["task", ...(background ? ["--background"] : []), "[quick] Task."], background
      ? ["jobId", "state", "jobDir", "backend"]
      : ["jobId", "backend", "status", "state", "sessionId", "rawOutput", "errorMessage"]);
    assert.equal(value.backend, "codex");
    if (background) await finishJob(ctx, value.jobId);
    else {
      assert.equal(value.status, 0);
      assert.equal(value.state, "completed");
      assert.equal(typeof value.rawOutput, "string");
    }
  });
}

test("setup --json golden page, backend, settings, sign-in, capability and model shapes", t => {
  const ctx = setup(t);
  for (const args of [["setup"], ["setup", "--backend", "codex"]]) {
    const value = json(ctx, args, ["ready", "jobsHome", "settings", "backends", "actionsTaken", "nextSteps"]);
    keys(value.settings, ["fastTier", "mcpOff", "reviewGate"], "setup.settings");
    assert.ok(value.backends.length > 0);
    for (const [i, block] of value.backends.entries()) {
      const at = `setup.backends[${i}]`;
      keys(block, ["backend", "home", "homeDefault", "selector", "binary", "binaryIsScript", "realBinary", "version", "signIn", "model", "modelNote", "effort", "effortNote", "modelsReason", "models", "can", "warnings", "ready", "error", "elapsedMs"], at);
      keys(block.signIn, ["state", "method", "detail"], `${at}.signIn`);
      keys(block.can, ["modes", "steer", "resume", "webSearchOff", "review", "adversarialReview", "stopGate", "transfer"], `${at}.can`);
      if (block.backend === "codex") assert.ok(block.models.length > 0);
      for (const [j, model] of block.models.entries()) keys(model, ["id", "efforts", "defaultEffort"], `${at}.models[${j}]`);
    }
  }
});

function dirtyRepo(ctx) {
  initGitRepo(ctx.work);
  fs.writeFileSync(path.join(ctx.work, "app.js"), "old\n");
  for (const args of [["add", "."], ["commit", "-m", "initial"]]) {
    const result = run("git", args, { cwd: ctx.work });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(ctx.work, "app.js"), "new\n");
}

for (const backend of ["codex", "grok", "kimi", "zcode"]) {
  for (const command of ["review", "adversarial-review"]) {
    test(`${backend} ${command} --json golden success and estimate shapes`, t => {
      const ctx = backendFixture(t, backend);
      dirtyRepo(ctx);
      // Supply a schema-valid answer to the non-native fake reviewers. The envelope
      // and its backend-named key still come from the real CLI writers.
      const extra = backend === "codex" ? {} : { FAKE_REVIEW_ANSWER: JSON.stringify({
        verdict: "needs-attention", summary: "One finding.", next_steps: ["Fix it."],
        findings: [{ severity: "high", title: "Guard input", body: "Check empty input.", file: "app.js",
          line_start: 1, line_end: 1, confidence: 0.8, recommendation: "Return early." }]
      }) };
      const value = json(ctx, [command, "--backend", backend], command === "review"
        ? ["review", "backend", "target", "sessionId", backend, "notes"]
        : ["review", "backend", "target", "sessionId", "context", backend, "result", "rawOutput", "parseError", "validationError", "turnError", "reasoningSummary", "notes"], { extra });
      assert.equal(value.backend, backend);
      keys(value.target, ["mode", "label", "explicit"], `${command}.target`);
      keys(value[backend], command === "review"
        ? ["status", "stderr", "stdout", ...(backend === "codex" ? ["reasoning", "sourceThreadId"] : [])]
        : ["status", "stderr", "stdout", "reasoning"], `${command}.${backend}`);
      if (command === "adversarial-review") {
        keys(value.context, ["repoRoot", "branch", "summary"], "adversarial-review.context");
        keys(value.result, ["verdict", "summary", "findings", "next_steps"], "adversarial-review.result");
        assert.ok(value.result.findings.length > 0);
        for (const finding of value.result.findings) keys(finding, ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"], "adversarial-review.result.findings[]");
      }
      const estimate = json(ctx, [command, "--backend", backend, "--estimate"], ["target", "fileCount", "shortstat", "untrackedCount"], { schema: "review-estimate" });
      keys(estimate.target, ["mode", "label", "explicit"], `${command} --estimate.target`);
    });
  }
}

test("transfer --json golden imported-session shape", t => {
  const ctx = setup(t);
  const source = path.join(ctx.user, ".claude/projects/shape/session-shape.jsonl");
  put(source, { type: "user", cwd: ctx.work, message: { role: "user", content: "Transfer this." } });
  const value = json(ctx, ["transfer", "--source", source], ["threadId", "resumeCommand", "sourcePath", "sessionId"]);
  assert.equal(value.resumeCommand, `codex resume ${value.threadId}`);
  assert.equal(value.sourcePath, fs.realpathSync(source));
  assert.equal(value.sessionId, "session-shape");
});

for (const kind of ["busy", "not-found", "usage", "attempt-changed", "error"]) {
  test(`--json ${kind} golden error shape and exit code`, async t => {
    let ctx, id, dir;
    if (kind === "attempt-changed") {
      ctx = setup(t, { turnMs: 60000 });
      ({ id } = startJob(ctx, HEADER, "Keep working."));
      await waitFor(() => readJob(ctx, id).turnId);
      dir = jobDir(ctx, id);
    } else {
      ({ ctx, id, dir } = await completed(t));
    }
    const busyModule = new URL("./support/busy-view.mjs", import.meta.url).href;
    const cases = {
      busy: { args: ["wait", id, "--timeout-seconds", "0"], status: 4, extra: { NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ?? ""} --import=${busyModule}`.trim(), RELAY_TEST_BUSY_JOB: dir }, message: /record changed during each of 8 reads/ },
      "not-found": { args: ["status", "unknown-job"], status: 1, message: /No job found/ },
      usage: { args: ["status", "--limit", "0"], status: 1, message: /--limit must be an integer/ },
      "attempt-changed": { args: ["cancel", id, "--attempt", "2"], status: 1, message: /at attempt 1, not 2: nothing was cancelled/ },
      error: { args: ["start", "--prompt-file", path.join(ctx.root, "missing.md")], status: 1, message: /ENOENT/ }
    };
    const chosen = cases[kind];
    const value = json(ctx, chosen.args, ["error"], chosen);
    keys(value.error, ["kind", "message"], `${kind}.error`);
    assert.equal(value.error.kind, kind);
    assert.match(value.error.message, chosen.message);
  });
}

function rowShape(row, at) {
  keys(row, ROW, at, true);
  keys(row.relay, ["agentId", "workflowRunId", "label", "phase", "adopted", "lastToolAt"], `${at}.relay`);
  // Reader round-trips of seeded recovery records, not assertions on their writer.
  for (const entry of row.automaticResumes) keys(entry, ["id", "epoch", "at", "fromAttempt", "reason", "state"], `${at}.automaticResumes[] (reader round-trip)`);
  for (const entry of row.relayViolations) keys(entry, ["at", "kind", "reason"], `${at}.relayViolations[]`);
  for (const entry of row.dropped) keys(entry, ["id", "reason"], `${at}.dropped[]`);
}

for (const scope of ["repository", "all", "workflow", "active"]) {
  test(`status ${scope} --json golden 50-row pages, slim rows and string limits`, async t => {
    const { ctx, id, dir } = await completed(t);
    const seed = readJob(ctx, id);
    // Scale a genuine worker-created record without starting 51 backend processes.
    fs.rmSync(dir, { recursive: true });
    const dirs = [];
    const long = "x".repeat(301);
    const flags = scope === "all" ? ["--all"] : scope === "workflow" ? ["--workflow", "wf-shape"] : scope === "active" ? ["--active"] : [];
    try {
      for (let i = 0; i < 51; i += 1) {
        const slug = ["all", "workflow"].includes(scope) && i % 2 ? "other-repo" : repoSlugFor(ctx.work);
        const clone = path.join(ctx.jobs, slug, `shape-${String(i).padStart(2, "0")}`);
        dirs.push(clone);
        put(jobPaths(clone).job, { ...seed, id: path.basename(clone), worker: null, server: { private: long },
          state: scope === "active" ? "starting" : "completed", createdAt: new Date(Date.now() + i).toISOString(),
          request: { ...seed.request, model: long }, errorMessage: "e".repeat(250) + "\nprivate detail",
          relay: { agentId: long, workflowRunId: "wf-shape", label: "Label", phase: "Test", previous: [{ agentId: "old" }] },
          automaticResumes: [{ id: long, epoch: long, at: AT, fromAttempt: 1, reason: long, state: "launched" }]
        });
        fs.writeFileSync(path.join(clone, "relay-violations.jsonl"), JSON.stringify({ at: AT, kind: long, reason: "v".repeat(250) + "\nprivate detail", agentId: "private" }) + "\n");
        const dropped = postInboxMessage(clone, { kind: "steer", text: "Dropped." });
        fs.mkdirSync(jobPaths(clone).claimed, { recursive: true });
        fs.renameSync(path.join(jobPaths(clone).inbox, `${dropped.id}.json`), path.join(jobPaths(clone).claimed, `${dropped.id}.json`));
        writeOutcome(clone, dropped.id, { action: "dropped", reason: "d".repeat(250) + "\nprivate detail" });
      }
      const first = json(ctx, ["status", ...flags], PAGE);
      assert.equal(first.scope, scope === "active" ? "repository" : scope);
      assert.equal(first.active, scope === "active");
      assert.equal(first.repoSlug, ["all", "workflow"].includes(scope) ? null : repoSlugFor(ctx.work));
      assert.equal(first.workflowRunId, scope === "workflow" ? "wf-shape" : null);
      assert.equal(first.limit, 50);
      assert.equal(first.jobs.length, 50);
      assert.equal(typeof first.nextCursor, "string");
      const second = json(ctx, ["status", ...flags, "--cursor", first.nextCursor], PAGE);
      assert.equal(second.jobs.length, 1);
      // The last page writes nextCursor: null; readers test it with != null.
      assert.equal(second.nextCursor, null);
      const rows = [...first.jobs, ...second.jobs];
      assert.deepEqual(rows.map(row => row.id), Array.from({ length: 51 }, (_, i) => `shape-${String(50 - i).padStart(2, "0")}`));
      for (const row of rows) {
        rowShape(row, `status.jobs[${row.id}]`);
        assert.equal(row.model, "x".repeat(300));
        assert.equal(row.relay.agentId, "x".repeat(300));
        assert.equal(row.automaticResumes[0].reason, "x".repeat(300));
        assert.equal(row.relayViolations[0].kind, "x".repeat(300));
        assert.equal(row.errorMessage, "e".repeat(200));
        assert.equal(row.dropped[0].reason, "d".repeat(200));
        assert.equal(row.relayViolations[0].reason, "v".repeat(200));
        const strings = value => {
          if (typeof value === "string") assert.ok(Array.from(value).length <= 300, `status row string exceeds 300: ${value.slice(0, 40)}`);
          else if (value && typeof value === "object") Object.values(value).forEach(strings);
        };
        strings(row);
      }
    } finally {
      for (const clone of dirs) fs.rmSync(clone, { recursive: true, force: true });
    }
  });
}
