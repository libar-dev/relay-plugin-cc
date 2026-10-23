import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { companion, finishJob, HEADER, jobDir, promptFile, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo, run } from "./support/helpers.mjs";
import { jobPaths, repoSlugFor, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { appendRelayViolation, postInboxMessage, writeOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { PLUGIN_BUILD, PLUGIN_VERSION } from "../plugins/relay/scripts/lib/util/plugin.mjs";

// Goldens transcribed from the writers, deliberately not imported from jobViewJson.
// cli/ + companion's JSON_COMMANDS also include review, adversarial-review and transfer.
// Phase 4 describes these headers, rows and typed-message fields. Code differences:
// - printListing always writes nextCursor: null on the last page.
// - rows also omit messages; --estimate uses relay.review-estimate/1 for BOTH reviews.
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
const ROW = [
  "id", "kind", "state", "storedState", "stalled", "deadReason", "sessionId", "turnId",
  "claudeSessionId", "model", "effort", "backend", "fast", "serviceTier", "mode", "webSearch",
  "cwd", "attempts", "errorMessage", "createdAt", "updatedAt", "completedAt", "jobDir",
  "reportPath", "hasReport", "summary", "relay", "relayViolations", "relayViolationCount",
  "handedBackAt", "notHandedBack", "openMessages", "automaticResumes", "automaticResumeCount",
  "undelivered", "undeliveredCount", "dropped", "droppedCount"
];
const PAGE = ["jobsHome", "scope", "repoSlug", "workflowRunId", "active", "limit", "jobs", "nextCursor"];
const MESSAGE = ["id", "kind", "createdAt", "stage", "preview", "relay", "outcome"];
const OUTCOME = ["action", "at", "reason", "attempt", "turnId"];
const ATTEMPT = ["attempt", "source", "automatic", "messageId", "startedAt", "relayVersion", "turnId", "state"];
const SERVER = ["pid", "startTime", "startedAt"];
const ENDED_SERVER = [...SERVER, "code", "signal", "endedAt", "stdoutClosedBeforeExit", "partialStdoutBytes", "stderrTail"];
const AT = "2026-01-01T00:00:00.000Z";

function keys(value, expected, at) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${at}: expected an object`);
  const actual = Object.keys(value);
  const missing = expected.filter(key => !Object.hasOwn(value, key));
  const added = actual.filter(key => !expected.includes(key));
  assert.deepEqual({ missing, added }, { missing: [], added: [] },
    `${at}: missing keys [${missing.join(", ")}]; unexpected keys [${added.join(", ")}]`);
  assert.deepEqual(actual, expected, `${at}: key order changed (actual: ${actual.join(", ")})`);
}

function json(ctx, args, expectedKeys, { status = 0, extra = {}, schema = args[0] } = {}) {
  const result = companion(ctx, [...args, "--json"], extra);
  assert.equal(result.status, status, result.stderr || result.stdout);
  assert.equal(result.stderr, "", `${args[0]} --json stderr`);
  const value = JSON.parse(result.stdout);
  keys(value, [...HEAD, ...expectedKeys], `${args[0]} stdout`);
  assert.equal(value.schema, `relay.${schema}/1`, `${args[0]} schema`);
  assert.equal(value.relayVersion, PLUGIN_VERSION);
  assert.equal(value.relayBuild, PLUGIN_BUILD);
  assert.equal(result.stdout, JSON.stringify(value, null, 2) + "\n");
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
  const launchKeys = ["jobId", "state", "jobDir", "notes", "backend"];
  const ordinary = json(ctx, ["start", "--prompt-file", promptFile(ctx)], launchKeys);
  assert.equal(ordinary.backend, "codex");
  await finishJob(ctx, ordinary.jobId);
  const transcript = path.join(ctx.root, "agent.jsonl");
  put(transcript, { type: "user", uuid: "brief", message: { role: "user", content: `${HEADER}\n---\n[quick] Relay.` } });
  const relay = json(ctx, ["start", "--from-relay", "--relay-agent", "agent-shape", "--relay-transcript", transcript], launchKeys);
  await finishJob(ctx, relay.jobId);
  const view = json(ctx, ["status", relay.jobId], JOB);
  keys(view.relay, ["agentId", "transcriptPath", "promptUuid", "promptSha256", "workflowRunId", "label", "phase", "stringReturn", "lastToolAt"], "status.relay");
  assert.equal(view.relay.lastToolAt, null);
  completedShape(view, "status");
});

for (const command of ["status", "result", "wait"]) {
  test(`${command} one-job --json golden shape and typed messages`, async t => {
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
    keys(value.relay, ["agentId", "workflowRunId", "label", "phase", "lastToolAt"], `${command}.relay`);
    assert.equal(value.messages.length, 3);
    keys(value.relayViolations[0], ["at", "kind", "reason", "agentId"], `${command}.relayViolations[0]`);
    keys(value.automaticResumes[0], ["id", "epoch", "at", "fromAttempt", "reason", "state"], `${command}.automaticResumes[0]`);
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
    // A next-turn receipt can precede turn/start. Both are deliberate writer shapes.
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

for (const command of ["review", "adversarial-review"]) {
  test(`${command} --json golden success and estimate shapes`, t => {
    const ctx = setup(t, { behavior: "review-ok" });
    dirtyRepo(ctx);
    const value = json(ctx, [command], command === "review"
      ? ["review", "backend", "target", "sessionId", "codex", "notes"]
      : ["review", "backend", "target", "sessionId", "context", "codex", "result", "rawOutput", "parseError", "validationError", "turnError", "reasoningSummary", "notes"]);
    keys(value.target, ["mode", "label", "explicit"], `${command}.target`);
    keys(value.codex, command === "review" ? ["status", "stderr", "stdout", "reasoning", "sourceThreadId"] : ["status", "stderr", "stdout", "reasoning"], `${command}.codex`);
    if (command === "adversarial-review") {
      keys(value.context, ["repoRoot", "branch", "summary"], "adversarial-review.context");
      keys(value.result, ["verdict", "summary", "findings", "next_steps"], "adversarial-review.result");
      assert.ok(value.result.findings.length > 0);
      for (const finding of value.result.findings) keys(finding, ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"], "adversarial-review.result.findings[]");
    }
    const estimate = json(ctx, [command, "--estimate"], ["target", "fileCount", "shortstat", "untrackedCount"], { schema: "review-estimate" });
    keys(estimate.target, ["mode", "label", "explicit"], `${command} --estimate.target`);
  });
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
  keys(row, ROW, at);
  keys(row.relay, ["agentId", "workflowRunId", "label", "phase", "adopted", "lastToolAt"], `${at}.relay`);
  for (const entry of row.automaticResumes) keys(entry, ["id", "epoch", "at", "fromAttempt", "reason", "state"], `${at}.automaticResumes[]`);
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
      // Pin what printListing writes; the requested omission is tracked below.
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
