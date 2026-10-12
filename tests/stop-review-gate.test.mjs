import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { buildEnv, installFakeCodex } from "./fakes/codex.mjs";
import { initGitRepo, makeTempDir, run } from "./support/helpers.mjs";
import { findJobDirs, PLUGIN_ROOT, SCRIPT, STOP_HOOK, waitFor, setupEnv } from "./support/runtime-fixture.mjs";

function stopGateRepo(behavior = "review-ok", options = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior, options);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env: setupEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).settings.reviewGate, true);
  return { repo, binDir, fakeStatePath: path.join(binDir, "fake-codex-state.json") };
}

function runStopHook(repo, env, input = {}) {
  return run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo, ...input }) });
}

function stopGateJobs(repo) {
  return findJobDirs(repo).filter(({ job }) => job.summary === "Codex Stop Gate Review");
}

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const { repo, binDir, fakeStatePath } = stopGateRepo();

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = runStopHook(repo, buildEnv(binDir), {
    session_id: "sess-stop-review",
    stop_hook_active: false,
    background_tasks: [],
    last_assistant_message: "I completed the refactor and updated the retry logic."
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
  const stopJob = stopGateJobs(repo)[0];
  assert.equal(stopJob.job.request.mode, "read-only");
  assert.equal(stopJob.job.request.backend, "codex");
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "job", { turnMs: 30000 });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" };

  const briefFile = path.join(makeTempDir(), "brief.md");
  fs.writeFileSync(briefFile, "Keep running.\n");
  const started = run("node", [SCRIPT, "start", "--model", "m", "--effort", "low", "--cd", repo, "--brief-file", briefFile], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.stdout)[1];
  await waitFor(() => findJobDirs(repo)[0]?.job.state === "running");

  const blocked = runStopHook(repo, env);

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, new RegExp(`job ${jobId} is still running`));
  assert.match(blocked.stderr, /\/relay:status/i);
  assert.match(blocked.stderr, new RegExp(`/relay:cancel ${jobId}`));
  assert.equal(run("node", [SCRIPT, "cancel", jobId], { cwd: repo, env }).status, 0);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const { repo, binDir } = stopGateRepo("adversarial-clean");

  const allowed = runStopHook(repo, buildEnv(binDir), { session_id: "sess-stop-clean" });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook allows with a message when Codex is unavailable even if the review gate is enabled", () => {
  const { repo } = stopGateRepo();

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /^Review gate skipped: Codex is not set up for the review gate/);
  assert.match(payload.systemMessage, /Run \/relay:setup\./);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const { repo, binDir } = stopGateRepo("refreshable-auth");

  const allowed = runStopHook(repo, buildEnv(binDir));

  assert.equal(allowed.status, 0, allowed.stderr);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

// These guards allow at once, with a message, and start no review.
test("stop gate skips during a stop-hook continuation, while background tasks run, and while a job of this repository runs", async () => {
  const { repo, binDir } = stopGateRepo("job", { turnMs: 30000 });
  const env = { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" };

  const continuing = runStopHook(repo, env, { stop_hook_active: true, background_tasks: [] });
  assert.equal(continuing.status, 0, continuing.stderr);
  assert.deepEqual(JSON.parse(continuing.stdout), { systemMessage: "Review gate skipped: a stop-hook continuation is already in progress." });

  const background = runStopHook(repo, env, {
    stop_hook_active: false,
    background_tasks: [
      { id: "task-1", type: "workflow", status: "running", description: "run" },
      { id: "task-2", type: "subagent", status: "running", description: "agent" }
    ]
  });
  assert.equal(background.status, 0, background.stderr);
  assert.deepEqual(JSON.parse(background.stdout), { systemMessage: "Review gate skipped: 2 background tasks running (workflow, subagent); the review runs when the session is done." });
  assert.deepEqual(stopGateJobs(repo), []);

  const briefFile = path.join(makeTempDir(), "brief.md");
  fs.writeFileSync(briefFile, "Keep running.\n");
  const started = run("node", [SCRIPT, "start", "--model", "m", "--effort", "low", "--cd", repo, "--brief-file", briefFile], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const jobId = /^job: (\S+)$/m.exec(started.stdout)[1];
  await waitFor(() => findJobDirs(repo)[0]?.job.state === "running");
  const running = runStopHook(repo, env, { background_tasks: [] });
  assert.equal(running.status, 0, running.stderr);
  const payload = JSON.parse(running.stdout);
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, new RegExp(`^Review gate skipped: job ${jobId} is still running\\.`));
  assert.match(payload.systemMessage, new RegExp(`/relay:cancel ${jobId}`));
  assert.deepEqual(stopGateJobs(repo), []);
  assert.equal(run("node", [SCRIPT, "cancel", jobId], { cwd: repo, env }).status, 0);
});

test("stop gate fails open: a failed review or an answer that is neither ALLOW nor BLOCK allows with a message", () => {
  for (const [behavior, expected] of [
    ["auth-run-fails", /^Review gate skipped: the stop-time Codex review failed \(exit \d+/],
    ["stop-unexpected", /^Review gate skipped: the stop-time Codex review returned an unexpected answer\./]
  ]) {
    const { repo, binDir } = stopGateRepo(behavior);
    const allowed = runStopHook(repo, buildEnv(binDir), { background_tasks: [] });
    assert.equal(allowed.status, 0, allowed.stderr);
    const payload = JSON.parse(allowed.stdout);
    assert.equal(payload.decision, undefined, behavior);
    assert.match(payload.systemMessage, expected, behavior);
    assert.match(payload.systemMessage, /Run \/relay:review --wait to review by hand\.$/, behavior);
  }
});

test("stop gate's limits: 10 minutes for the review, 10 s per probe, all of it below the hook's own timeout", async () => {
  const { stopGateLimits, STOP_COMMAND_TIMEOUT_MS } = await import(STOP_HOOK);
  assert.deepEqual(stopGateLimits({}), { reviewMs: 10 * 60 * 1000, probeMs: 10 * 1000 });
  assert.deepEqual(stopGateLimits({ RELAY_STOP_REVIEW_MS: "700", RELAY_STOP_PROBE_MS: "300" }), { reviewMs: 700, probeMs: 300 });
  assert.deepEqual(stopGateLimits({ RELAY_STOP_REVIEW_MS: "x", RELAY_STOP_PROBE_MS: "0" }), { reviewMs: 10 * 60 * 1000, probeMs: 10 * 1000 });
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const stopTimeout = hooks.hooks.Stop[0].hooks[0].timeout;
  // Two probes, the start, the review's wait with its margin, and the cancel after a timeout.
  const { reviewMs, probeMs } = stopGateLimits({});
  const worstCase = 2 * probeMs + STOP_COMMAND_TIMEOUT_MS + reviewMs + STOP_COMMAND_TIMEOUT_MS + STOP_COMMAND_TIMEOUT_MS;
  assert.ok(worstCase < stopTimeout * 1000, `worst case ${worstCase} ms, hook timeout ${stopTimeout} s`);
});

// The outer limit reaches each companion process the gate spawns, and a stalled
// one is ended at that limit.
test("stop gate's outer limits reach the start, the wait and the cancel it spawns; a stalled companion is ended", async () => {
  const { runStopReview, runCompanionSync, stopGateLimits, STOP_COMMAND_TIMEOUT_MS } = await import(STOP_HOOK);
  const spawned = [];
  let taskArgs;
  const answer = { task: JSON.stringify({ jobId: "task-x", state: "starting" }), wait: JSON.stringify({ state: "running" }), cancel: "{}" };
  const spawn = (command, args, options) => {
    spawned.push([args[1], options.timeout]);
    if (args[1] === "task") taskArgs = args.slice(1);
    return { status: 0, stdout: answer[args[1]], stderr: "" };
  };
  const limits = { ...stopGateLimits({}), reviewMs: 1500 };
  const review = runStopReview(process.cwd(), { last_assistant_message: "done" }, { limits, runCompanion: (args, options) => runCompanionSync(args, { ...options, spawn }) });
  assert.match(review.failure, /^the stop-time Codex review timed out after 1\.5 s\./);
  const { backendWith } = await import("../plugins/relay/scripts/lib/backends/index.mjs");
  assert.equal(taskArgs[taskArgs.indexOf("--backend") + 1], backendWith("stopGate").name);
  assert.deepEqual(spawned, [["task", STOP_COMMAND_TIMEOUT_MS], ["wait", 1500 + STOP_COMMAND_TIMEOUT_MS], ["cancel", STOP_COMMAND_TIMEOUT_MS]]);

  // A companion that does not answer is ended at the limit, not when it chooses to exit.
  const started = Date.now();
  const stalled = runCompanionSync(["wait", "task-x"], { cwd: process.cwd(), timeoutMs: 300, spawn: (command, args, options) => spawnSync(command, ["-e", "setTimeout(() => {}, 4000)"], options) });
  assert.equal(stalled.error?.code, "ETIMEDOUT");
  assert.ok(Date.now() - started < 3000, `ended after ${Date.now() - started} ms`);
  // The hook identifies review jobs by their summary, without a prompt marker.
  assert.doesNotMatch(fs.readFileSync(STOP_HOOK, "utf8"), /STOP_REVIEW_TASK_MARKER/);
});

// A stop hook run that cannot block the suite: a hook that outlives `timeout` fails its test.
function runStopHookWithin(repo, env, input, timeout) {
  const result = spawnSync(process.execPath, [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo, ...input }), encoding: "utf8", timeout });
  assert.equal(result.error, undefined, `the stop hook did not end within ${timeout} ms`);
  return result;
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// A review past its limit is cancelled through the job path.
test("stop gate's review past its limit is cancelled: nothing of it runs, its job is terminal, and the stop is allowed naming /relay:review --wait", async () => {
  const { repo, binDir, fakeStatePath } = stopGateRepo("job-hang-child", { turnMs: 60000 });
  const env = { ...buildEnv(binDir), RELAY_STOP_REVIEW_MS: "1500", RELAY_JOBS_CANCEL_GRACE_MS: "500", RELAY_JOBS_POLL_MS: "50", RELAY_JOBS_WAIT_POLL_MS: "50" };
  const allowed = runStopHookWithin(repo, env, { background_tasks: [] }, 20000);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(JSON.parse(allowed.stdout), { systemMessage: "Review gate skipped: the stop-time Codex review timed out after 1.5 s. Run /relay:review --wait to review by hand." });
  const [review] = stopGateJobs(repo);
  assert.equal(review.job.state, "cancelled");
  const fake = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  const pids = [review.job.worker?.pid, ...(fake.spawnPids ?? []), ...(fake.descendants ?? []).map((entry) => entry.childPid)].filter(Boolean);
  assert.ok((fake.descendants ?? []).length > 0, "the review's tool started a child");
  await waitFor(() => pids.every(isGone), { timeoutMs: 3000 }).catch(() => {});
  assert.deepEqual(pids.filter((pid) => !isGone(pid)), [], "no process of the review survives");
});

// Each availability probe has its own limit, and its process group ends with it.
for (const hung of ["--version", "app-server"]) {
  test(`stop gate's availability probe that hangs (codex ${hung}) is ended within its limit and allows with a message`, async () => {
    const { repo, binDir } = stopGateRepo();
    const real = path.join(binDir, "codex-real");
    fs.renameSync(path.join(binDir, "codex"), real);
    const pids = path.join(binDir, "probe.pids");
    fs.writeFileSync(path.join(binDir, "codex"), `#!/bin/sh
if [ "$1" = "${hung}" ]; then
  echo $$ >> '${pids}'
  '${process.execPath}' -e 'setInterval(() => {}, 1000)' stop-probe-child &
  echo $! >> '${pids}'
  wait
fi
exec '${real}' "$@"
`, { mode: 0o755 });
    const allowed = runStopHookWithin(repo, { ...buildEnv(binDir), RELAY_STOP_PROBE_MS: "500" }, { background_tasks: [] }, 8000);
    assert.equal(allowed.status, 0, allowed.stderr);
    const probe = hung === "--version" ? "codex --version" : "codex app-server --help";
    const payload = JSON.parse(allowed.stdout);
    assert.equal(payload.decision, undefined);
    assert.match(payload.systemMessage, new RegExp(`^Review gate skipped: Codex is not set up for the review gate \\(.*${probe.replace(/-/g, "\\-")}: no answer in 0\\.5 s\\)\\. Run /relay:setup\\.$`));
    const started2 = fs.readFileSync(pids, "utf8").trim().split("\n").map(Number);
    assert.equal(started2.length, 2);
    await waitFor(() => started2.every(isGone), { timeoutMs: 3000 }).catch(() => {});
    assert.deepEqual(started2.filter((pid) => !isGone(pid)), [], "the probe and its child are ended");
    assert.deepEqual(stopGateJobs(repo), []);
  });
}

// The gate never blocks on its own failure: an answer that is not JSON allows the stop.
test("stop gate allows with the manual-review message when the companion's review JSON is malformed", async () => {
  const { runStopReview, stopGateLimits } = await import(STOP_HOOK);
  const manual = "Run /relay:review --wait to review by hand.";
  for (const broken of ["task", "wait"]) {
    const calls = [];
    const runCompanion = (args) => {
      calls.push(args[0]);
      if (args[0] === "task") return { status: 0, stdout: broken === "task" ? "{not json" : JSON.stringify({ jobId: "task-x", state: "starting" }), stderr: "", error: null };
      if (args[0] === "wait") return { status: 0, stdout: broken === "wait" ? "BLOCK: {not json" : "{}", stderr: "", error: null };
      return { status: 0, stdout: "{}", stderr: "", error: null };
    };
    const review = runStopReview(process.cwd(), { last_assistant_message: "done" }, { limits: stopGateLimits({}), runCompanion });
    assert.deepEqual(review, { ok: true, failure: `the stop-time Codex review returned invalid JSON. ${manual}` }, broken);
    // A review whose answer could not be read is still ended through the job path.
    assert.deepEqual(calls, broken === "task" ? ["task"] : ["task", "wait", "cancel"], broken);
  }
});
