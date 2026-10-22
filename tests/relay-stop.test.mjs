import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

import { handleTaskStop } from "../plugins/relay/scripts/hooks/relay-stop.mjs";
import { createJobDir, jobPaths, readJob, TERMINAL_STATES, writeJob, writeJsonAtomic } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { writeRelayPointer } from "../plugins/relay/scripts/lib/harness/relay.mjs";
import { COMPANION, PLUGIN_ROOT, companion, jobDirOf, readJobJson, relayContext, relayStart, waitFor } from "./support/relay-fixture.mjs";
import { run } from "./support/helpers.mjs";

const HOOK = path.join(PLUGIN_ROOT, "scripts/hooks/relay-stop.mjs");
const context = output => output?.hookSpecificOutput?.additionalContext;

function input(ctx, extra = {}) {
  return { hook_event_name: "PostToolUse", tool_name: "TaskStop", cwd: ctx.work,
    tool_input: { task_id: ctx.agentId }, tool_response: { task_id: ctx.agentId, task_type: "local_agent" }, ...extra };
}

async function running(t) {
  const ctx = relayContext("job", { turnMs: 60000 });
  ctx.append(ctx.prompt("model: gpt-test\neffort: low\n---\nKeep working."));
  const { jobId, started } = await relayStart(ctx);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.ok(jobId, started.stdout);
  t.after(() => { if (!TERMINAL_STATES.has(readJobJson(ctx, jobId)?.state)) companion(ctx, ["cancel", jobId]); });
  await waitFor(() => readJobJson(ctx, jobId).state === "running" && readJobJson(ctx, jobId).turnId);
  return { ctx, jobId, dir: jobDirOf(ctx, jobId) };
}

function recorded(state = "running") {
  const ctx = relayContext();
  const jobId = "job-stop-test";
  const { jobDir: dir } = createJobDir(ctx.work, jobId, ctx.env);
  writeJob(dir, { id: jobId, state, createdAt: new Date().toISOString(), attempts: [], relay: { agentId: ctx.agentId } });
  writeRelayPointer(ctx.env, { agentId: ctx.agentId, jobDir: dir, jobId });
  return { ctx, jobId, dir };
}

function diskTree(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? diskTree(file) : fs.readFileSync(file, "utf8")];
  });
}

function assertCancelled({ ctx, jobId, dir }, output) {
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(context(output).startsWith(`TaskStop stopped the relay:job agent ${ctx.agentId}, and the relay hook cancelled its job ${jobId}:\n`));
  assert.match(context(output), /^state: cancelled$/m);
  assert.match(context(output), new RegExp(`^job: ${jobId}$`, "m"));
  assert.match(context(output), /^cancel: /m);
  const job = readJob(dir);
  assert.equal(job.state, "cancelled");
  assert.equal(job.attempts.at(-1).state, "cancelled");
  const cancels = fs.readdirSync(jobPaths(dir).claimed).map(name => JSON.parse(fs.readFileSync(path.join(jobPaths(dir).claimed, name), "utf8"))).filter(message => message.kind === "cancel");
  assert.equal(cancels.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobPaths(dir).outcomes, `${cancels[0].id}.json`), "utf8")).action, "cancelled");
}

for (const variant of ["agent id", "name in tool_input and id in tool_response", "JSON-string tool_response"]) {
  test(`TaskStop cancels a running relay job stopped by ${variant}`, async t => {
    const job = await running(t);
    const event = input(job.ctx);
    if (variant !== "agent id") event.tool_input.task_id = "relay-name";
    if (variant === "JSON-string tool_response") event.tool_response = JSON.stringify(event.tool_response);
    assertCancelled(job, handleTaskStop(event, job.ctx.env));
  });
}

test("TaskStop script reads stdin, cancels the running relay job and prints hook context", async t => {
  const job = await running(t);
  const result = run(process.execPath, [HOOK], { cwd: job.ctx.work, env: job.ctx.env, input: JSON.stringify(input(job.ctx)) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assertCancelled(job, JSON.parse(result.stdout));
});

for (const scenario of ["agent without a pointer", "pointer without jobDir", "missing job", "previous relay after adoption", "Workflow task without a pointer"]) {
  test(`TaskStop ignores ${scenario} and cancels nothing`, () => {
    const { ctx, dir } = recorded();
    const event = input(ctx);
    if (scenario === "agent without a pointer") event.tool_response.task_id = "unknown-agent";
    if (scenario === "pointer without jobDir") writeRelayPointer(ctx.env, { agentId: ctx.agentId });
    if (scenario === "missing job") fs.rmSync(jobPaths(dir).job);
    if (scenario === "previous relay after adoption") {
      writeJsonAtomic(jobPaths(dir).relay, { agentId: "adopted-relay", previous: [{ agentId: ctx.agentId }] });
      assert.equal(readJob(dir).relay.agentId, "adopted-relay");
    }
    if (scenario === "Workflow task without a pointer") {
      event.tool_input.task_id = "workflow-task";
      event.tool_response = { task_id: "workflow-task", task_type: "local_workflow" };
    }
    const before = diskTree(ctx.home);
    assert.equal(handleTaskStop(event, ctx.env), null);
    assert.deepEqual(diskTree(ctx.home), before);
  });
}

for (const state of ["completed", "failed", "cancelled"]) {
  test(`TaskStop reports a job that already ended ${state} without another cancel receipt`, () => {
    const { ctx, jobId } = recorded(state);
    const before = diskTree(ctx.home);
    const output = handleTaskStop(input(ctx), ctx.env);
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext:
      `TaskStop stopped the relay:job agent ${ctx.agentId}. Its job ${jobId} had already ended (${state}); nothing was cancelled.` } });
    assert.deepEqual(diskTree(ctx.home), before);
  });
}

test("TaskStop falls back to tool_input.task_id, then shell_id, regardless of task_type", () => {
  for (const tool_input of [{ task_id: "agent" }, { task_id: "", shell_id: "agent" }]) {
    const { ctx, dir } = recorded();
    writeJob(dir, { ...readJob(dir), state: "completed" });
    for (const tool_response of [undefined, { task_id: "  ", task_type: "local_workflow" }, JSON.stringify({ task_id: 42 })]) {
      const fields = Object.fromEntries(Object.entries(tool_input).map(([key, value]) => [key, value === "agent" ? ctx.agentId : value]));
      const output = handleTaskStop(input(ctx, { tool_input: fields, tool_response }), ctx.env);
      assert.match(context(output), /had already ended \(completed\)/);
      assert.ok(context(output).includes(ctx.agentId));
    }
  }
});

const FAILED = "TaskStop stopped the relay, and the cancel failed: ";

test("TaskStop records a cancel violation when cancel cannot read the job's report", () => {
  const { ctx, dir, jobId } = recorded();
  // A directory at report.md makes cancel's report read fail without a permissions or timing race.
  fs.mkdirSync(jobPaths(dir).report);
  const output = handleTaskStop(input(ctx), ctx.env);
  assert.ok(context(output).startsWith(`TaskStop stopped the relay:job agent ${ctx.agentId}, and the relay hook could not cancel its job ${jobId}: `));
  assert.match(context(output), /EISDIR/);
  assert.ok(context(output).endsWith(`The job may still be running. Cancel it with: node "${COMPANION}" cancel ${jobId}`));
  assert.equal(readJob(dir).state, "running");
  assert.deepEqual(fs.readdirSync(jobPaths(dir).claimed), []);
  const violation = JSON.parse(fs.readFileSync(path.join(dir, "relay-violations.jsonl"), "utf8"));
  assert.equal(violation.kind, "cancel");
  assert.equal(violation.agentId, ctx.agentId);
  assert.match(violation.reason, /^TaskStop stopped the relay, and the cancel failed: .*EISDIR/);
  assert.ok(context(output).includes(violation.reason.slice(FAILED.length)));
});

for (const scenario of ["cancel still running on stdout", "cancel still running on stderr", "exit 4 before a cancel was posted", "spawn error", "signal"]) {
  test(`TaskStop records a violation and recovery command for ${scenario}`, t => {
    const { ctx, dir, jobId } = recorded();
    const results = {
      "cancel still running on stdout": { status: 4, stdout: "state: running\ncancel: the cancel is with its newer worker\n", stderr: "" },
      "cancel still running on stderr": { status: 4, stdout: "state: running\n", stderr: "the cancel is with its\n  newer worker\n" },
      "exit 4 before a cancel was posted": { status: 4, stdout: "", stderr: "The job record is busy.\n" },
      "spawn error": { status: null, error: new Error("spawn failed"), stdout: "", stderr: "" },
      signal: { status: null, signal: "SIGTERM", stdout: "", stderr: "" }
    };
    const mocked = t.mock.method(childProcess, "spawnSync", (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [COMPANION, "cancel", dir]);
      assert.equal(options.cwd, process.cwd());
      assert.equal(options.env.RELAY_JOBS_HOME, ctx.home);
      assert.equal(options.encoding, "utf8");
      // The relay fixture sets its own grace; the bound is twice it and 40 s.
      assert.equal(options.timeout, 2 * Number(ctx.env.RELAY_JOBS_CANCEL_GRACE_MS ?? 10000) + 40000);
      return results[scenario];
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const output = handleTaskStop(input(ctx, { cwd: path.join(ctx.work, "absent") }), { ...ctx.env, RELAY_JOBS_HOME: path.relative(process.cwd(), ctx.home) });
    assert.equal(mocked.mock.callCount(), 1);
    const violation = JSON.parse(fs.readFileSync(path.join(dir, "relay-violations.jsonl"), "utf8"));
    assert.equal(violation.kind, "cancel");
    assert.equal(violation.agentId, ctx.agentId);
    assert.equal(readJob(dir).state, "running");
    if (scenario.startsWith("cancel still running")) {
      assert.equal(violation.reason, `TaskStop stopped the relay, and the cancel had not ended the job: ${results[scenario].stderr.replace(/\s+/g, " ").trim()}`);
      assert.ok(context(output).includes(results[scenario].stdout + results[scenario].stderr));
      assert.ok(context(output).endsWith(`Check it with: node "${COMPANION}" status ${jobId}`));
    } else {
      assert.ok(violation.reason.startsWith(FAILED));
      assert.ok(context(output).includes(violation.reason.slice(FAILED.length)));
      assert.ok(context(output).endsWith(`Cancel it with: node "${COMPANION}" cancel ${jobId}`));
    }
  });
}

for (const [code, status] of [["EACCES", 1], ["ENOSPC", 4]]) {
  test(`TaskStop returns the cancel warning when recording its violation fails with ${code}`, t => {
    const { ctx, dir, jobId } = recorded();
    const mocked = t.mock.method(childProcess, "spawnSync", () => ({ status, stdout: "", stderr:
      status === 4 ? "the cancel is with its newer worker" : "cancel failed" }));
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const append = t.mock.method(fs, "appendFileSync", file => {
      assert.equal(file, path.join(dir, "relay-violations.jsonl"));
      throw Object.assign(new Error(`${code}: cannot append violation`), { code });
    });
    const output = handleTaskStop(input(ctx), ctx.env);
    assert.equal(append.mock.callCount(), 1);
    assert.ok(context(output).includes(jobId));
    assert.match(context(output), status === 4 ? /asked its job .* to cancel/ : /could not cancel its job/);
    assert.ok(context(output).includes(`node "${COMPANION}" ${status === 4 ? "status" : "cancel"} ${jobId}`));
    assert.ok(context(output).includes(`The cancel violation could not be recorded: ${code}: cannot append violation.`));
    assert.equal(fs.existsSync(path.join(dir, "relay-violations.jsonl")), false);
    assert.equal(readJob(dir).state, "running");
  });
}

// The toolUseResult cut from probe-run-2/session's Workflow result, with paths replaced.
const WORKFLOW_RESULT = { toolUseResult: {
  status: "async_launched", taskId: "wceoygoi3", taskType: "local_workflow", workflowName: "p3-probe-deny",
  runId: "wf_6cfd5d48-93f", summary: "Phase 3 probe: a denied and a valid relay spawn",
  transcriptDir: "/fixture/session/subagents/workflows/wf_6cfd5d48-93f",
  scriptPath: "/fixture/session/workflows/scripts/p3-probe-deny-wf_6cfd5d48-93f.js"
} };
const WORKFLOW_RUN = WORKFLOW_RESULT.toolUseResult.runId;

function workflowStop(ctx) {
  const transcript = ctx.base.transcript_path;
  fs.writeFileSync(transcript, `${JSON.stringify(WORKFLOW_RESULT)}\n`);
  return input(ctx, { transcript_path: transcript, tool_input: { task_id: "wceoygoi3" },
    tool_response: { task_id: "wceoygoi3", task_type: "local_workflow" } });
}

function workflowJob(ctx, id, state, runId = WORKFLOW_RUN, work = ctx.work) {
  const { jobDir } = createJobDir(work, id, ctx.env);
  writeJob(jobDir, { id, state, attempts: [], relay: { agentId: `agent-${id}`, workflowRunId: runId } });
  return jobDir;
}

test("TaskStop reports only nonterminal jobs of the stopped Workflow run without cancelling", t => {
  const { ctx } = recorded();
  const event = workflowStop(ctx);
  workflowJob(ctx, "job-workflow-one", "running");
  const otherWork = path.join(ctx.work, "other-repo");
  fs.mkdirSync(otherWork);
  const second = workflowJob(ctx, "job-workflow-two", "starting", "old-run", otherWork);
  // A resumed binding in relay.json takes precedence over the run in job.json.
  writeJsonAtomic(jobPaths(second).relay, { agentId: "new-agent", workflowRunId: WORKFLOW_RUN });
  for (const state of TERMINAL_STATES) workflowJob(ctx, `job-ended-${state}`, state);
  workflowJob(ctx, "job-other-run", "running", "other-run");
  const before = diskTree(ctx.home);
  const cancel = t.mock.method(childProcess, "spawnSync", () => { throw new Error("Workflow jobs must not be cancelled"); });
  syncBuiltinESMExports();
  t.after(() => { cancel.mock.restore(); syncBuiltinESMExports(); });
  const output = handleTaskStop(event, ctx.env);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  const listed = context(output).match(/adopts them: ([^.]+)\./)[1].split(", ");
  assert.deepEqual(listed.sort(), ["job-workflow-one", "job-workflow-two"]);
  assert.ok(context(output).startsWith(`TaskStop stopped Workflow run ${WORKFLOW_RUN}. Its 2 relay job(s) keep running, so a resumeFromRunId adopts them: `));
  assert.ok(context(output).endsWith(`To abandon one: node "${COMPANION}" cancel <job>.`));
  assert.equal(cancel.mock.callCount(), 0);
  assert.deepEqual(diskTree(ctx.home), before);
});

for (const scenario of ["no running jobs", "task absent from transcript", "unreadable transcript"]) {
  test(`TaskStop ignores a Workflow with ${scenario}`, () => {
    const { ctx } = recorded();
    const event = workflowStop(ctx);
    for (const state of TERMINAL_STATES) workflowJob(ctx, `job-ended-${state}`, state);
    workflowJob(ctx, "job-other-run", "running", "other-run");
    if (scenario !== "no running jobs") workflowJob(ctx, "job-running", "running");
    if (scenario === "task absent from transcript") {
      event.tool_response.task_id = "unknown-task";
      event.tool_input.task_id = "unknown-task";
    }
    if (scenario === "unreadable transcript") event.transcript_path = ctx.work;
    const before = diskTree(ctx.home);
    assert.equal(handleTaskStop(event, ctx.env), null);
    assert.deepEqual(diskTree(ctx.home), before);
  });
}

test("TaskStop finds a subagent's own Workflow in its resolved transcript before the session transcript", () => {
  const { ctx } = recorded();
  const event = workflowStop(ctx);
  workflowJob(ctx, "job-agent-run", "running");
  workflowJob(ctx, "job-session-run", "running", "session-run");
  event.agent_id = ctx.agentId;
  event.session_id = ctx.sessionId;
  assert.equal(event.agent_transcript_path, undefined);
  assert.equal(ctx.transcript, path.join(path.dirname(event.transcript_path), ctx.sessionId, "subagents", `agent-${ctx.agentId}.jsonl`));
  fs.copyFileSync(event.transcript_path, ctx.transcript);
  fs.writeFileSync(event.transcript_path, JSON.stringify({ toolUseResult: { ...WORKFLOW_RESULT.toolUseResult, runId: "session-run" } }));
  event.tool_response = JSON.stringify(event.tool_response);
  const output = handleTaskStop(event, ctx.env);
  assert.ok(context(output).includes(`Workflow run ${WORKFLOW_RUN}`));
  assert.ok(context(output).includes("job-agent-run"));
  assert.ok(!context(output).includes("job-session-run"));
});

test("TaskStop falls back to the session transcript when a subagent stops a Workflow the main thread started", () => {
  const { ctx } = recorded();
  const event = workflowStop(ctx);
  event.agent_id = ctx.agentId;
  event.session_id = ctx.sessionId;
  workflowJob(ctx, "job-session-run", "running");
  workflowJob(ctx, "job-other-run", "running", "other-run");
  fs.writeFileSync(ctx.transcript, JSON.stringify({ toolUseResult: { ...WORKFLOW_RESULT.toolUseResult, taskId: "another-task", runId: "other-run" } }));
  const before = diskTree(ctx.home);
  for (const scenario of ["no matching task", "missing transcript", "unreadable transcript"]) {
    if (scenario === "missing transcript") fs.rmSync(ctx.transcript);
    if (scenario === "unreadable transcript") fs.mkdirSync(ctx.transcript);
    const output = handleTaskStop(event, ctx.env);
    assert.ok(context(output)?.includes(`Workflow run ${WORKFLOW_RUN}`), scenario);
    assert.ok(context(output).includes("job-session-run"), scenario);
    assert.ok(!context(output).includes("job-other-run"), scenario);
    assert.deepEqual(diskTree(ctx.home), before);
  }
});

test("TaskStop ignores other tools, other hook events and inputs without an agent", () => {
  const { ctx } = recorded();
  const before = diskTree(ctx.home);
  for (const event of [input(ctx, { tool_name: "Bash" }), input(ctx, { hook_event_name: "PreToolUse" }),
    input(ctx, { tool_input: {}, tool_response: {} }), null]) {
    assert.equal(handleTaskStop(event, ctx.env), null);
  }
  assert.deepEqual(diskTree(ctx.home), before);
});

test("TaskStop script exits zero without stdout on bad JSON and non-TaskStop input", () => {
  const { ctx } = recorded();
  const before = diskTree(ctx.home);
  for (const raw of ["{broken", '{"tool_name":"TaskStop",', JSON.stringify(input(ctx, { tool_name: "Bash" })), JSON.stringify(input(ctx, { hook_event_name: "PreToolUse" }))]) {
    const result = run(process.execPath, [HOOK], { cwd: ctx.work, env: ctx.env, input: raw });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    if (raw === '{"tool_name":"TaskStop",') assert.match(result.stderr, /relay stop:/);
    else assert.equal(result.stderr, "");
  }
  assert.deepEqual(diskTree(ctx.home), before);
});

for (const [grace, timeout] of [[undefined, 60000], ["", 60000], ["25000", 90000], ["0", 40000], ["1000000", 590000], ["soon", 60000]]) {
  test(`TaskStop gives cancel the /relay:cancel bound for grace ${JSON.stringify(grace)}`, t => {
    const { ctx } = recorded();
    const mocked = t.mock.method(childProcess, "spawnSync", (executable, args, options) => {
      assert.equal(options.timeout, timeout);
      return { status: 0, stdout: "state: cancelled\n", stderr: "" };
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const env = { ...ctx.env };
    if (grace === undefined) delete env.RELAY_JOBS_CANCEL_GRACE_MS;
    else env.RELAY_JOBS_CANCEL_GRACE_MS = grace;
    handleTaskStop(input(ctx), env);
    assert.equal(mocked.mock.callCount(), 1);
  });
}

test("TaskStop does not claim a cancel when the job ended on its own before the cancel reached it", t => {
  const { ctx, dir, jobId } = recorded();
  const mocked = t.mock.method(childProcess, "spawnSync", () => {
    // The worker finishes between the hook's read and the cancel, which then records only a no-op.
    writeJob(dir, { ...readJob(dir), state: "completed", completedAt: new Date().toISOString() });
    return { status: 0, stdout: "state: completed\ncancel: already completed\n", stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const output = handleTaskStop(input(ctx), ctx.env);
  assert.equal(context(output), `TaskStop stopped the relay:job agent ${ctx.agentId}. Its job ${jobId} ended (completed) before the cancel reached it; nothing was cancelled:\nstate: completed\ncancel: already completed\n`);
  assert.equal(fs.existsSync(path.join(dir, "relay-violations.jsonl")), false);
});

test("hooks.json registers the TaskStop command with its timeout and description", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(hooks.hooks.PostToolUse, [{ matcher: "TaskStop", hooks: [{ type: "command",
    command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/relay-stop.mjs"', timeout: 600 }] }]);
  assert.match(hooks.description, /a TaskStop hook that cancels a stopped relay's job/);
  assert.match(hooks.description, /checks a relay:job prompt's header at the spawn/);
});
