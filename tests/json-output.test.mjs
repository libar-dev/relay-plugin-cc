import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { companion, finishJob, HEADER, jobDir, promptFile, readJob, ROOT, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo, run } from "./support/helpers.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { jobPaths, repoSlugFor } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { PLUGIN_BUILD } from "../plugins/relay/scripts/lib/util/plugin.mjs";

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins/relay/.claude-plugin/plugin.json"), "utf8")).version;
const BUSY_VIEW = new URL("./support/busy-view.mjs", import.meta.url).href;
const AT = "2026-01-01T00:00:00.000Z";
const END = "2026-01-01T00:00:07.000Z";

function json(ctx, args, extra = {}, status = 0) {
  const result = companion(ctx, [...args, "--json"], extra);
  assert.equal(result.status, status, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).slice(0, 3), ["schema", "relayVersion", "relayBuild"]);
  assert.equal(value.schema, `relay.${args[0]}/1`);
  assert.equal(value.relayVersion, VERSION);
  assert.equal(value.relayBuild, PLUGIN_BUILD);
  assert.equal(result.stdout, JSON.stringify(value, null, 2) + "\n");
  return value;
}

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(ctx, id, patch = {}, slug = repoSlugFor(ctx.work)) {
  const dir = path.join(ctx.jobs, slug, id);
  put(jobPaths(dir).job, {
    id, kind: "task", state: "completed", createdAt: AT, completedAt: END, updatedAt: END,
    summary: "Done.", repoSlug: slug, request: { model: "gpt-test", effort: "low" }, attempts: [], ...patch
  });
  return dir;
}

function message(dir, id, kind, { stage = "claimed", text = "Hello", createdAt = AT, outcome = null } = {}) {
  const paths = jobPaths(dir);
  put(path.join(stage === "claimed" ? paths.claimed : paths.inbox, `${id}.json`), { id, kind, text, createdAt });
  if (outcome) put(path.join(paths.outcomes, `${id}.json`), outcome);
}

function busy(ctx, dir) {
  return { NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ?? ""} --import=${BUSY_VIEW}`.trim(), RELAY_TEST_BUSY_JOB: dir };
}

test("JSON headers cover readers, start, background and foreground task, messages, cancel and setup", async t => {
  const ctx = setup(t, { turnMs: 2000 });
  const started = json(ctx, ["start", "--prompt-file", promptFile(ctx, HEADER, "First.")]);
  assert.equal(started.backend, "codex");
  await waitFor(() => readJob(ctx, started.jobId).turnId);
  const steered = json(ctx, ["steer", started.jobId, "--message", "Check tests."]);
  assert.equal(steered.job, started.jobId);
  assert.equal(steered.outcome.action, "steered");
  assert.ok(steered.message.id);
  assert.equal(typeof steered.spawned, "number");
  await finishJob(ctx, started.jobId);
  for (const args of [["status"], ["status", started.jobId], ["result", started.jobId], ["wait", started.jobId]]) json(ctx, args);
  assert.equal(json(ctx, ["result", started.jobId, "--state-only"]).report, null);
  assert.equal(json(ctx, ["wait", started.jobId, "--state-only"]).report, null);
  for (const command of ["continue", "resume"]) {
    const delivery = json(ctx, [command, started.jobId, "--message", "[quick] Next."]);
    assert.equal(delivery.job, started.jobId);
    assert.ok(["turn-started", "accepted-next-turn"].includes(delivery.outcome.action));
    await finishJob(ctx, started.jobId);
    const view = json(ctx, ["status", started.jobId]);
    assert.equal(view.messages.find(entry => entry.id === delivery.message.id).outcome.action, "turn-started");
  }
  const cancelled = json(ctx, ["cancel", started.jobId]);
  assert.equal(cancelled.id, started.jobId);
  assert.equal(cancelled.backend, "codex");
  assert.deepEqual(cancelled.actions, ["already completed"]);
  const task = json(ctx, ["task", "--background", "[quick] Background."]);
  assert.equal(task.backend, "codex");
  assert.equal(task.state, "starting");
  await finishJob(ctx, task.jobId);
  assert.equal(json(ctx, ["task", "[quick] Foreground."]).backend, "codex");
  json(ctx, ["setup"]);
});

test("review and adversarial-review successes and transfer errors carry JSON headers", t => {
  const ctx = setup(t, { behavior: "review-ok" });
  initGitRepo(ctx.work);
  fs.writeFileSync(path.join(ctx.work, "app.js"), "old\n");
  assert.equal(run("git", ["add", "."], { cwd: ctx.work }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd: ctx.work }).status, 0);
  fs.writeFileSync(path.join(ctx.work, "app.js"), "new\n");
  json(ctx, ["review"]);
  json(ctx, ["adversarial-review"]);
  const transfer = json(ctx, ["transfer"], { RELAY_COMPANION_SESSION_ID: "" }, 1);
  assert.equal(transfer.error.kind, "error");
  assert.match(transfer.error.message, /Could not identify/);
});

test("relay starts use JSON for success, repeat starts and missing transcript errors", async t => {
  const ctx = setup(t);
  const transcript = path.join(ctx.root, "agent.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "prompt", message: { role: "user", content: `${HEADER}\n---\n[quick] Relay.` } }) + "\n");
  const flags = ["start", "--from-relay", "--relay-agent", "json-relay", "--relay-transcript", transcript];
  const started = json(ctx, flags);
  assert.equal(started.backend, "codex");
  await finishJob(ctx, started.jobId);
  assert.equal(json(ctx, flags, {}, 1).error.kind, "usage");
  assert.equal(json(ctx, ["start", "--from-relay"], {}, 1).error.kind, "usage");
});

test("not-found and usage errors are JSON on stdout or unchanged text on stderr", t => {
  const ctx = setup(t);
  const cases = [
    [["status", "unknown-job"], "not-found"],
    [["status", "--limit", "0"], "usage"],
    [["status", "--limit", "201"], "usage"],
    [["status", "--limit", "3.5"], "usage"],
    [["status", "--limit", "no"], "usage"],
    [["status", "--limit"], "usage"],
    ...["!", "e30", "WyJhIl0", Buffer.from('[1,"job"]').toString("base64url")].map(cursor => [["status", "--cursor", cursor], "usage"])
  ];
  for (const [args, kind] of cases) assert.equal(json(ctx, args, {}, 1).error.kind, kind);
  const missing = companion(ctx, ["status", "unknown-job"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, `No job found for "unknown-job" under ${ctx.jobs}.\n`);
  for (const [flag, value] of [["limit", "0"], ["cursor", "!"], ["active", null]]) {
    const result = companion(ctx, ["status", `--${flag}`, ...(value ? [value] : [])]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `--${flag} requires --json.\n`);
  }
});

test("busy readers return JSON error objects with exit 4 and keep text errors", t => {
  const ctx = setup(t);
  const dir = fixture(ctx, "job-busy");
  const extra = busy(ctx, dir);
  for (const args of [["status"], ["status", "job-busy"], ["result", "job-busy"], ["wait", "job-busy", "--timeout-seconds", "0"], ["wait", "job-busy", "--timeout-seconds", "0", "--exit-zero-while-running"]]) {
    const value = json(ctx, args, extra, 4);
    assert.equal(value.error.kind, "busy");
    assert.equal(value.error.message, "Job job-busy is busy: its record changed during each of 8 reads. Try again.");
    if (args.includes("--exit-zero-while-running")) continue;
    const text = companion(ctx, args, extra);
    assert.equal(text.status, 4);
    assert.equal(text.stdout, "");
    assert.equal(text.stderr, value.error.message + "\n");
  }
});

test("full views expose message outcomes, relay entries, previews and open work", t => {
  const ctx = setup(t);
  const dir = fixture(ctx, "job-messages", {
    relay: { agentId: "old-relay", previous: [{ agentId: "first" }] },
    attempts: [{ relayVersion: VERSION }], errorMessage: "\n" + "e".repeat(250) + "\nmore detail", messages: [{ private: "worker log" }],
    server: { stderrTail: "private server" }
  });
  put(path.join(dir, "relay.json"), { agentId: "new-relay", phase: "review" });
  put(path.join(dir, "relay-guard.json"), { lastToolAt: END });
  fs.writeFileSync(path.join(dir, "report.md"), "Report.\n");
  fs.writeFileSync(path.join(dir, "relay-violations.jsonl"), JSON.stringify({ kind: "test", reason: "First\nSecond" }) + "\n");
  message(dir, "a-steer", "steer", { createdAt: END, outcome: { action: "steered", at: END } });
  message(dir, "b-continue", "continue", { outcome: { action: "turn-started", at: END, attempt: 2, turnId: "turn-2" } });
  message(dir, "c-pending", "resume", { stage: "pending", text: "\n  Long   " + "x".repeat(150) + "\nDo not show this" });
  message(dir, "d-cancel", "cancel", { text: "", outcome: { action: "cancelled" } });
  message(dir, "e-relay", "steer", { outcome: { action: "queued-next-turn" } });
  put(path.join(dir, "inbox/relay/entry-1.json"), { uuid: "entry-1", messageId: "e-relay", at: END });
  fs.writeFileSync(path.join(dir, "inbox/broken.json"), "{");
  const full = json(ctx, ["status", "job-messages"]);
  assert.equal(full.backend, "codex");
  assert.equal(full.updatedAt, END);
  assert.equal(full.hasReport, true);
  assert.equal(full.notHandedBack, true);
  assert.equal(full.relay.agentId, "new-relay");
  assert.equal(full.relay.lastToolAt, END);
  assert.equal(full.openMessages, 2);
  assert.deepEqual(full.messages.map(entry => entry.id), ["b-continue", "c-pending", "d-cancel", "e-relay", "a-steer"]);
  const entries = Object.fromEntries(full.messages.map(entry => [entry.id, entry]));
  assert.equal(full.server.stderrTail, "private server");
  assert.deepEqual(full.attemptRecords, [{ relayVersion: VERSION }]);
  assert.deepEqual(entries["a-steer"].outcome, { action: "steered", at: END, reason: null, attempt: null, turnId: null });
  assert.deepEqual(entries["b-continue"].outcome, { action: "turn-started", at: END, reason: null, attempt: 2, turnId: "turn-2" });
  assert.equal(entries["c-pending"].stage, "pending");
  assert.equal(entries["c-pending"].outcome, null);
  assert.equal(entries["c-pending"].preview, "Long " + "x".repeat(115));
  assert.equal(entries["a-steer"].relay, null);
  assert.deepEqual(entries["e-relay"].relay, { entry: "entry-1", at: END });
  assert.equal(entries["d-cancel"].kind, "cancel");
  assert.equal(entries["d-cancel"].preview, "");
  const row = json(ctx, ["status"]).jobs[0];
  for (const field of ["attemptRecords", "server", "messages"]) assert.equal(Object.hasOwn(row, field), false);
  assert.deepEqual(row.relay, { agentId: "new-relay", workflowRunId: null, label: null, phase: "review", adopted: 1, lastToolAt: END });
  assert.equal(row.errorMessage, "e".repeat(200));
  assert.equal(row.notHandedBack, true);
  assert.equal(row.openMessages, 2);
  assert.deepEqual(row.relayViolations, [{ at: null, kind: "test", reason: "First" }]);
  assert.deepEqual(row.undelivered, ["c-pending", "e-relay"]);
  fixture(ctx, "job-empty", { createdAt: END });
  const emptyView = json(ctx, ["status", "job-empty"]);
  for (const field of ["relay", "handedBackAt", "errorMessage", "server", "reportPath"]) assert.equal(emptyView[field], null);
  assert.deepEqual(emptyView.messages, []);
  assert.equal(emptyView.openMessages, 0);
  assert.equal(emptyView.notHandedBack, false);
  assert.equal(emptyView.hasReport, false);
});

test("Codex and Grok rows and full views always identify the backend and keep backend extras", async t => {
  const ctx = setup(t);
  installFakeGrok(ctx.bin);
  const codex = startJob(ctx, HEADER, "[quick] Codex.").id;
  await finishJob(ctx, codex);
  const grok = startJob(ctx, "backend: grok\nmodel: grok-4.7\neffort: low\ngrok-home: jobs", "[quick] Grok.").id;
  await finishJob(ctx, grok);
  const rows = json(ctx, ["status"]).jobs;
  assert.equal(rows.find(row => row.id === codex).backend, "codex");
  assert.equal(Object.hasOwn(rows.find(row => row.id === codex), "grokHome"), false);
  const expected = path.join(ctx.user, ".grok-jobs");
  for (const value of [rows.find(row => row.id === grok), json(ctx, ["status", grok])]) {
    assert.equal(value.backend, "grok");
    assert.equal(value.grokHome, expected);
  }
  assert.equal(json(ctx, ["status", codex]).backend, "codex");
});

for (const scope of ["repository", "all", "workflow"]) {
  test(`status ${scope} paging is stable, ordered and complete`, t => {
    const ctx = setup(t);
    const slug = repoSlugFor(ctx.work);
    const flags = scope === "workflow" ? ["--workflow", "wf-test"] : scope === "all" ? ["--all"] : [];
    const expected = [];
    for (let index = 0; index < 7; index += 1) {
      const id = `job-${index}`;
      expected.unshift(id);
      fixture(ctx, id, { createdAt: index < 3 ? null : END, relay: { workflowRunId: "wf-test" } }, scope !== "repository" && index % 2 ? "another-repo" : slug);
    }
    if (scope === "workflow") fixture(ctx, "unrelated", { relay: { workflowRunId: "other" } });
    if (scope === "repository") fixture(ctx, "unrelated", {}, "another-repo");
    const first = json(ctx, ["status", ...flags, "--limit", "3"]);
    assert.equal(first.scope, scope);
    assert.equal(first.repoSlug, scope === "repository" ? slug : null);
    assert.equal(first.workflowRunId, scope === "workflow" ? "wf-test" : null);
    assert.equal(first.active, false);
    assert.equal(first.limit, 3);
    assert.equal(first.jobs.length, 3);
    assert.ok(first.nextCursor);
    fixture(ctx, "job-new", { createdAt: "2026-02-01T00:00:00.000Z", relay: { workflowRunId: "wf-test" } });
    const second = json(ctx, ["status", ...flags, "--limit", "3", "--cursor", first.nextCursor]);
    assert.equal(second.jobs.length, 3);
    assert.ok(second.nextCursor);
    assert.deepEqual(JSON.parse(Buffer.from(second.nextCursor, "base64url").toString("utf8")), [second.jobs.at(-1).createdAt, second.jobs.at(-1).id]);
    const third = json(ctx, ["status", ...flags, "--limit", "3", "--cursor", second.nextCursor]);
    assert.equal(third.jobs.length, 1);
    assert.equal(third.nextCursor, null);
    assert.deepEqual([...first.jobs, ...second.jobs, ...third.jobs].map(row => row.id), expected);
  });
}

test("active listing includes running, dead and owed terminal jobs and skips closed work", t => {
  const ctx = setup(t);
  fixture(ctx, "job-running", { state: "running", createdAt: new Date().toISOString() });
  fixture(ctx, "job-dead", { state: "running" });
  for (const state of ["completed", "failed", "cancelled"]) {
    const closed = fixture(ctx, `job-${state}`, { state });
    message(closed, "closed", "steer", { outcome: { action: "steered" } });
    message(closed, "cancel", "cancel");
  }
  const owed = fixture(ctx, "job-owed");
  message(owed, "queued", "steer", { outcome: { action: "queued-next-turn" } });
  const pending = fixture(ctx, "job-pending", { state: "failed" });
  message(pending, "pending", "continue", { stage: "pending" });
  const first = json(ctx, ["status", "--active", "--limit", "2"]);
  const second = json(ctx, ["status", "--active", "--limit", "2", "--cursor", first.nextCursor]);
  assert.equal(first.active, true);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.jobs, ...second.jobs].map(row => row.id), ["job-running", "job-pending", "job-owed", "job-dead"]);
  fixture(ctx, "job-running");
});

test("default listing limits 200 large job records to 50 slim rows below 400 KB", t => {
  const ctx = setup(t);
  const attempts = Array.from({ length: 4 }, (_, index) => ({ attempt: index + 1, servers: [{ stderrTail: "s".repeat(4096) }, { stderrTail: "t".repeat(4096) }] }));
  const slug = repoSlugFor(ctx.work);
  for (let index = 0; index < 200; index += 1) fixture(ctx, `job-${String(index).padStart(3, "0")}`, { attempts }, slug);
  const value = json(ctx, ["status"]);
  assert.equal(value.limit, 50);
  assert.equal(value.jobs.length, 50);
  assert.ok(value.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2) + "\n") < 400000);
  fs.rmSync(path.join(ctx.jobs, slug), { recursive: true });
});

test("status, result, wait and cancel retain their exact text output", t => {
  const ctx = setup(t);
  const dir = fixture(ctx, "job-1");
  fs.writeFileSync(jobPaths(dir).report, "Report.\n");
  const block = `state: completed\njob: job-1\nsession: none\nmodel: gpt-test\neffort: low\nduration: 7s\nattempts: 0\nreport: ${jobPaths(dir).report}\ndir: ${dir}\n`;
  for (const [args, expected] of [
    [["status", "job-1"], block],
    [["result", "job-1"], block + "---\nReport.\n"],
    [["wait", "job-1"], block + "---\nReport.\n"],
    [["cancel", "job-1"], block + "cancel: already completed\n"]
  ]) {
    const result = companion(ctx, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  }
  const listed = companion(ctx, ["status"]);
  assert.equal(listed.stderr, "");
  assert.equal(listed.stdout, [
    `jobs-home: ${ctx.jobs}`, `repo: ${repoSlugFor(ctx.work)}`, "review-gate: disabled", "fast-tier: off",
    `relay-version: ${VERSION}${PLUGIN_BUILD !== null ? ` (${PLUGIN_BUILD})` : ""}`, "jobs: 1", "",
    "| job   | state     | kind | backend | model/effort | duration | summary | relay |",
    "|-------|-----------|------|---------|--------------|----------|---------|-------|",
    "| job-1 | completed | task | codex   | gpt-test/low | 7s       | Done.   |       |", ""
  ].join("\n"));
});
