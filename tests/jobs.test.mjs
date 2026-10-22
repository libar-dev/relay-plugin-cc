import { scriptedConnection } from "./support/backend-connection.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fakes/codex.mjs";
import { initGitRepo, makeTempDir, run } from "./support/helpers.mjs";
import { truncateCodePoints } from "../plugins/relay/scripts/lib/util/text.mjs";
import { buildLaunchRequest, parseHeaderPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { computeJobView } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { createJobDir, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "relay", "scripts", "companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "relay", "scripts", "hooks/session-lifecycle.mjs");

function setup(behavior = "job", options = {}) {
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior, options);
  const home = makeTempDir("relay-jobs-");
  const work = makeTempDir("relay-work-");
  const env = {
    ...buildEnv(binDir),
    RELAY_JOBS_HOME: home,
    RELAY_JOBS_POLL_MS: "50",
    RELAY_JOBS_WAIT_POLL_MS: "50",
    RELAY_JOBS_HEARTBEAT_MS: "200",
    ...(options.env ?? {})
  };
  const fakeState = () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return { binDir, home, work, env, fakeState };
}

function companion(ctx, args, extra = {}) {
  return run("node", [SCRIPT, ...args], { cwd: extra.cwd ?? ctx.work, env: { ...ctx.env, ...(extra.env ?? {}) } });
}

function writePrompt(ctx, header, brief) {
  const file = path.join(makeTempDir("relay-prompt-"), "prompt.md");
  fs.writeFileSync(file, `${header}\n---\n${brief}`);
  return file;
}

function startJob(ctx, header, brief, extra = {}) {
  const result = companion(ctx, ["start", "--prompt-file", writePrompt(ctx, header, brief)], extra);
  assert.equal(result.status, 0, result.stderr);
  const jobId = /^job: (\S+)$/m.exec(result.stdout)?.[1];
  assert.ok(jobId, result.stdout);
  return jobId;
}

function jobDirOf(ctx, jobId) {
  for (const slug of fs.readdirSync(ctx.home)) {
    const dir = path.join(ctx.home, slug, jobId);
    if (fs.existsSync(path.join(dir, "job.json"))) {
      return dir;
    }
  }
  throw new Error(`no job dir for ${jobId}`);
}

function readJobJson(ctx, jobId) {
  return JSON.parse(fs.readFileSync(path.join(jobDirOf(ctx, jobId), "job.json"), "utf8"));
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let value = null;
    try {
      value = await predicate();
    } catch {
      value = null;
    }
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function waitJob(ctx, jobId, seconds = 15) {
  return companion(ctx, ["wait", jobId, "--timeout-seconds", String(seconds)]);
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

const HEADER = "model: gpt-test\neffort: low";

// ---------------------------------------------------------------------------------------
// Header and request

test("header parsing keeps the brief byte for byte and reads every key", () => {
  const brief = "line one\n---\n  indented: not a header\n\ttab\n";
  const cwd = makeTempDir();
  const { header, brief: parsed } = parseHeaderPrompt(
    `model: gpt-6-astra\neffort: xhigh\nmode: write   # or read-only\nnetwork: true\ncd: ${cwd}\nadd-dir: /a\nadd-dir: /b\nweb-search: cached\n---\n${brief}`
  );
  assert.equal(parsed, brief);
  assert.equal(header.model, "gpt-6-astra");
  assert.equal(header.effort, "xhigh");
  assert.equal(header.mode, "write");
  assert.equal(header.network, "true");
  assert.equal(header.cd, cwd);
  assert.deepEqual(header.addDirs, ["/a", "/b"]);
  assert.equal(header.webSearch, "cached");
  assert.throws(() => parseHeaderPrompt("model: x\neffort: y\nno dashes"), /no header/);
  assert.throws(() => parseHeaderPrompt("modle: x\n---\nb"), /Unknown header key/);
});

test("the default mode is yolo, and nothing in the brief changes the mode", () => {
  const request = buildLaunchRequest({ model: "m", effort: "e", network: "true", addDirs: [process.cwd()] });
  assert.equal(request.mode, "yolo");
  assert.equal(request.backend, "codex");
  assert.equal(Object.hasOwn(request, "sandbox"), false);
  assert.equal(Object.hasOwn(request, "approvalPolicy"), false);
  assert.equal(request.webSearch, "live");
  assert.match(request.notes.join("\n"), /ignored in yolo mode/);
  assert.throws(() => buildLaunchRequest({ effort: "e" }), /model is required/);
  assert.throws(() => buildLaunchRequest({ model: "m" }), /effort is required/);
});

test("write mode in a linked worktree grants the common gitdir including packed-refs locks", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const worktree = path.join(makeTempDir(), "wt");
  const added = run("git", ["worktree", "add", "-b", "feature", worktree], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);

  const request = buildLaunchRequest({ model: "m", effort: "e", mode: "write", cd: worktree });
  const common = fs.realpathSync(path.join(repo, ".git"));
  assert.deepEqual(request.writableRoots, [path.join(common, "worktrees", "wt"), common]);
  assert.deepEqual(buildLaunchRequest({ model: "m", effort: "e", mode: "write", cd: repo }).writableRoots, []);
});

test("thread names are cut by code point, never inside a surrogate pair", () => {
  const text = "😀".repeat(100);
  const cut = truncateCodePoints(text, 60);
  assert.equal(Array.from(cut).length, 60);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false);
  assert.equal(truncateCodePoints("short", 60), "short");
});

// The backend contract names a session on any backend `sessionId`; only the Codex
// adapter speaks Codex's `threadId`, at its wire boundary.
test("the backend contract, the worker and the Grok and ZCode adapters say sessionId; Codex's threadId stays on its wire", async () => {
  const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "relay", "scripts", "lib");
  const source = (name) => fs.readFileSync(path.join(lib, name), "utf8");
  for (const name of ["worker/worker.mjs", "backends/grok/connection.mjs", "backends/zcode/connection.mjs"]) {
    assert.deepEqual(source(name).match(/\bthread(Id|Used)\b/g) ?? [], [], name);
  }
  const backend = source("backends/types.d.ts");
  assert.match(backend, /sessionId: string \| null;/);
  assert.match(backend, /sessionUsed: boolean;/);
  // Every threadId left in the contract's code is Codex's: a wire key fed from the session id,
  // or the thread Codex opened.
  const code = backend.replace(/\/\/.*$/gm, "");
  assert.deepEqual([...code.matchAll(/[\w.]*\bthreadId\b(?::\s*\w+)?/g)].map((match) => match[0]).filter((use) => !["threadId: sessionId", "opened.threadId"].includes(use)), []);
  const requests = [];
  const client = { request: async (method, params) => { requests.push({ method, params }); return { thread: { id: "t-1" }, serviceTier: null }; } };
  const codex = await scriptedConnection("codex", client, { cwd: process.cwd(), model: null, mode: "read-only", webSearch: "disabled", fast: false });
  const opened = await codex.open({ sessionId: "t-1", sessionUsed: false, sessionName: null });
  assert.equal(opened.sessionId, "t-1");
  assert.equal(requests.find((request) => request.method === "thread/resume").params.threadId, "t-1");
  await codex.steer("turn-1", { id: "m1", text: "more" });
  await codex.interrupt("turn-1");
  assert.deepEqual(requests.slice(-2).map((request) => [request.method, request.params.threadId]), [["turn/steer", "t-1"], ["turn/interrupt", "t-1"]]);
});

test("thread names follow the <task> block when the brief has one", () => {
  for (const [brief, label] of [["<context>ignore</context>\n<task>\nFix the cache.\n</task>", "Fix the cache."], ["\n\nPlain brief\nmore", "Plain brief"]]) {
    const ctx = setup("job", { turnMs: 50 });
    const id = startJob(ctx, HEADER, brief);
    assert.equal(waitJob(ctx, id).status, 0);
    assert.equal(ctx.fakeState().threadNames[0], `${label} (${id})`);
  }
});

test("readers compute dead and stalled without writing them", () => {
  const now = Date.parse("2026-10-02T12:00:00.000Z");
  const neverStarted = computeJobView({ state: "starting", createdAt: "2026-10-02T11:58:00.000Z" }, { now });
  assert.equal(neverStarted.state, "dead");
  assert.match(neverStarted.deadReason, /never started/);
  const fresh = computeJobView({ state: "starting", createdAt: "2026-10-02T11:59:50.000Z" }, { now });
  assert.equal(fresh.state, "starting");
  const live = { pid: process.pid };
  const stalled = computeJobView({ state: "running", worker: live, lastEventAt: "2026-10-02T11:45:00.000Z" }, { now });
  assert.equal(stalled.state, "running");
  assert.equal(stalled.stalled, true);
  const busy = computeJobView({ state: "running", worker: live, lastEventAt: "2026-10-02T11:59:00.000Z" }, { now });
  assert.equal(busy.stalled, false);
  assert.equal(computeJobView({ state: "completed", worker: { pid: 999999 } }, { now }).state, "completed");
});

// ---------------------------------------------------------------------------------------
// The job layer against the fake backend

test("a relative jobs home stays bound when cd runs the worker in another directory", () => {
  const ctx = setup();
  ctx.home = path.join(ctx.work, "jobs");
  ctx.env.RELAY_JOBS_HOME = "jobs";
  const cwd = makeTempDir("relay-worker-cwd-");
  const jobId = startJob(ctx, `${HEADER}\ncd: ${cwd}`, "[quick] Relative jobs home.\n");
  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  assert.equal(readJobJson(ctx, jobId).state, "completed");
  assert.equal(readJobJson(ctx, jobId).request.cwd, cwd);
  assert.match(waited.stdout, /^---\nReport for: \[quick\] Relative jobs home\.$/m);
  assert.equal(fs.existsSync(path.join(cwd, "jobs")), false);
});

test("the default header starts a yolo session: danger-full-access, never, live web search", async () => {
  const ctx = setup("job", { turnMs: 100 });
  const jobId = startJob(ctx, HEADER, "Look around.\n");
  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  const state = ctx.fakeState();
  assert.equal(state.threadStarts[0].sandbox, "danger-full-access");
  assert.equal(state.threadStarts[0].approvalPolicy, "never");
  assert.deepEqual(state.threadStarts[0].config, { web_search: "live" });
  assert.equal(state.threadStarts[0].ephemeral, false);
  assert.deepEqual(state.turnStarts[0].sandboxPolicy, { type: "dangerFullAccess" });
  assert.match(waited.stdout, /^state: completed$/m);
  assert.match(waited.stdout, /^mode: yolo$/m);
  assert.match(waited.stdout, /^---\nReport for: Look around\.$/m);
});

test("a read-only header still starts a read-only thread", async () => {
  const ctx = setup("job", { turnMs: 100 });
  const jobId = startJob(ctx, `${HEADER}\nmode: read-only\nweb-search: disabled`, "Only read.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  const state = ctx.fakeState();
  assert.equal(state.threadStarts[0].sandbox, "read-only");
  assert.deepEqual(state.threadStarts[0].config, { web_search: "disabled" });
  assert.deepEqual(state.turnStarts[0].sandboxPolicy, { type: "readOnly", networkAccess: false });
});

test("ten concurrent starts are all recorded", async () => {
  const ctx = setup("job", { turnMs: 300 });
  const promptFile = writePrompt(ctx, HEADER, "Concurrent job.\n");
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      new Promise((resolve) => {
        const child = spawn("node", [SCRIPT, "start", "--prompt-file", promptFile], { cwd: ctx.work, env: ctx.env });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.on("close", (code) => resolve({ code, stdout }));
      })
    )
  );
  const ids = results.map((result) => {
    assert.equal(result.code, 0);
    return /^job: (\S+)$/m.exec(result.stdout)[1];
  });
  assert.equal(new Set(ids).size, 10);

  const status = companion(ctx, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const listed = JSON.parse(status.stdout).jobs.map((job) => job.id);
  assert.deepEqual([...listed].sort(), [...ids].sort());

  for (const id of ids) {
    assert.equal(waitJob(ctx, id, 20).status, 0);
  }
  const finished = JSON.parse(companion(ctx, ["status", "--json"]).stdout).jobs;
  assert.equal(finished.filter((job) => job.state === "completed").length, 10);
});

test("a worker killed with SIGKILL mid-turn reads as dead and wait exits 3", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Long job.\n");
  const job = await waitFor(() => {
    const value = readJobJson(ctx, jobId);
    return value.turnId && value.worker?.pid ? value : null;
  });
  killGroup(job.worker.pid);
  await waitFor(() => {
    try {
      process.kill(job.worker.pid, 0);
      return false;
    } catch {
      return true;
    }
  });

  const waited = waitJob(ctx, jobId, 5);
  assert.equal(waited.status, 3, waited.stdout);
  assert.match(waited.stdout, /^state: dead$/m);
  assert.match(waited.stdout, /^error: the job's worker died/m);
  assert.equal(readJobJson(ctx, jobId).state, "running", "dead is computed, never written");
});

test("the app-server exiting 0 without turn/completed ends the job as failed, never running", async () => {
  const ctx = setup("job-exit-before-complete");
  const jobId = startJob(ctx, HEADER, "Exit early.\n");
  const waited = waitJob(ctx, jobId, 10);
  assert.equal(waited.status, 3, waited.stdout);
  assert.match(waited.stdout, /^state: failed$/m);
  assert.match(waited.stdout, /server ended before turn\/completed \(exit 0\)/);
  assert.equal(readJobJson(ctx, jobId).state, "failed");
});

test("a start response without a turn id still completes", async () => {
  const ctx = setup("job-no-turn-id", { turnMs: 100 });
  const jobId = startJob(ctx, HEADER, "No turn id.\n");
  const waited = waitJob(ctx, jobId, 10);
  assert.equal(waited.status, 0, waited.stdout);
  assert.match(waited.stdout, /Report for: No turn id\./);
  assert.equal(readJobJson(ctx, jobId).turnId, "turn_1");
});

test("a surrogate pair at the cut point of a thread name does not hang the job", async () => {
  const ctx = setup("job", { turnMs: 100 });
  const jobId = startJob(ctx, HEADER, `${"😀".repeat(100)}\n`);
  const waited = waitJob(ctx, jobId, 10);
  assert.equal(waited.status, 0, waited.stdout);
  const [name] = ctx.fakeState().threadNames;
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name), false, `lone surrogate in ${JSON.stringify(name)}`);
});

test("steer reaches a running turn", async () => {
  const ctx = setup("job", { turnMs: 2500 });
  const jobId = startJob(ctx, HEADER, "Steerable job.\n");
  const job = await waitFor(() => readJobJson(ctx, jobId).turnId && readJobJson(ctx, jobId));
  const messageFile = path.join(makeTempDir(), "steer.md");
  fs.writeFileSync(messageFile, "Also check the tests.");
  const steered = companion(ctx, ["steer", jobId, "--message-file", messageFile]);
  assert.equal(steered.status, 0, steered.stderr);
  assert.match(steered.stdout, /^outcome: steered$/m);

  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0);
  assert.match(waited.stdout, /Steered with: Also check the tests\./);
  const [steer] = ctx.fakeState().steers;
  assert.equal(steer.expectedTurnId, job.turnId);
  assert.equal(steer.accepted, true);
  assert.equal(readJobJson(ctx, jobId).attempts.length, 1);
});

test("steer after the turn ends becomes the next turn", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, "Quick job.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  const steered = companion(ctx, ["steer", jobId, "--message", "Late steer."]);
  assert.equal(steered.status, 0, steered.stderr);
  assert.match(steered.stdout, /^outcome: (accepted-next-turn|turn-started|queued-next-turn)$/m);

  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0);
  assert.match(waited.stdout, /^attempts: 2$/m);
  assert.match(waited.stdout, /Report for: Late steer\./);
  const job = readJobJson(ctx, jobId);
  assert.equal(job.attempts[1].source, "steer");
  assert.ok(fs.existsSync(path.join(jobDirOf(ctx, jobId), "attempts", "1-report.md")));
});

test("continue on a finished job reuses the thread id", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, "First turn.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  const threadId = readJobJson(ctx, jobId).sessionId;

  const continued = companion(ctx, ["continue", jobId, "--message", "Second turn."]);
  assert.equal(continued.status, 0, continued.stderr);
  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0);
  assert.match(waited.stdout, /Report for: Second turn\./);

  const state = ctx.fakeState();
  assert.equal(readJobJson(ctx, jobId).sessionId, threadId);
  assert.deepEqual(
    state.turnStarts.map((turn) => turn.threadId),
    [threadId, threadId]
  );
  assert.equal(state.threadResumes.at(-1).threadId, threadId);
  assert.equal(state.threadStarts.length, 1);
});

test("resume of a dead job restores cwd, sandbox and writable roots", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const extra = makeTempDir("relay-extra-");
  const jobId = startJob(ctx, `${HEADER}\nmode: write\nnetwork: true\nadd-dir: ${extra}\ncd: ${ctx.work}`, "Write something.\n", {
    cwd: ROOT
  });
  const job = await waitFor(() => {
    const value = readJobJson(ctx, jobId);
    return value.turnId && value.worker?.pid ? value : null;
  });
  killGroup(job.worker.pid);
  await waitFor(() => /^state: dead$/m.test(companion(ctx, ["status", jobId]).stdout));

  const resumed = companion(ctx, ["resume", jobId], { cwd: ROOT, env: { FAKE_CODEX_TURN_MS: "50" } });
  assert.equal(resumed.status, 0, resumed.stderr);
  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0, waited.stdout);
  assert.match(waited.stdout, /Report for: Your session was cut off\. Continue the task from where you stopped, then write the final report\./);

  const state = ctx.fakeState();
  const [first] = state.threadStarts;
  const resume = state.threadResumes.at(-1);
  assert.equal(resume.threadId, job.sessionId);
  assert.equal(resume.cwd, first.cwd);
  assert.equal(resume.cwd, ctx.work);
  assert.equal(resume.sandbox, "workspace-write");
  assert.deepEqual(resume.config, first.config);
  assert.deepEqual(resume.config.sandbox_workspace_write.writable_roots, [extra]);
  assert.equal(resume.config.sandbox_workspace_write.network_access, true);
  assert.deepEqual(state.turnStarts.at(-1).sandboxPolicy, state.turnStarts[0].sandboxPolicy);
  assert.deepEqual(state.turnStarts.at(-1).sandboxPolicy.writableRoots, [extra]);
});

test("a model-at-capacity failure at start is retried and recorded", async () => {
  const ctx = setup("job-capacity", { turnMs: 50, capacityFailures: 2, env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "50,50,50" } });
  const jobId = startJob(ctx, HEADER, "Busy model.\n");
  const waited = waitJob(ctx, jobId, 15);
  assert.equal(waited.status, 0, waited.stdout);
  const job = readJobJson(ctx, jobId);
  assert.equal(job.capacityRetries.length, 2);
  assert.match(job.capacityRetries[0].error, /at capacity/);
  assert.equal(ctx.fakeState().turnStarts.length, 3);
  assert.match(waited.stdout, /^capacity-retries: 2$/m);
});

test("a request-rate limit failure at start is retried and recorded", async () => {
  const ctx = setup("job-capacity", {
    turnMs: 50,
    capacityFailures: 2,
    capacityError: { message: "rate limit exceeded: Rate limit reached for requests", codexErrorInfo: "rateLimitExceeded", additionalDetails: null },
    env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "50,50,50" }
  });
  const jobId = startJob(ctx, HEADER, "Too many requests.\n");
  const waited = waitJob(ctx, jobId, 15);
  assert.equal(waited.status, 0, waited.stdout);
  const job = readJobJson(ctx, jobId);
  assert.equal(job.capacityRetries.length, 2);
  assert.match(job.capacityRetries[0].error, /Rate limit reached for requests/);
  assert.equal(ctx.fakeState().turnStarts.length, 3);
  assert.match(waited.stdout, /^capacity-retries: 2$/m);
});

test("a usage limit failure is not retried", async () => {
  const ctx = setup("job-capacity", {
    turnMs: 50,
    capacityFailures: 1,
    capacityError: { message: "Usage limit reached.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null }
  });
  const jobId = startJob(ctx, HEADER, "Out of usage.\n");
  const waited = waitJob(ctx, jobId, 15);
  assert.equal(waited.status, 3, waited.stdout);
  assert.equal(readJobJson(ctx, jobId).capacityRetries, undefined);
  assert.equal(ctx.fakeState().turnStarts.length, 1);
});

async function capacityResult(error) {
  const client = {
    stderr: "", exitPromise: new Promise(() => {}),
    setNotificationHandler(handler) { this.notificationHandler = handler; },
    request: async () => ({ turn: { id: "turn", status: "failed", error } })
  };
  const connection = await scriptedConnection("codex", client, { cwd: process.cwd(), mode: "read-only", model: null, effort: null, fast: false });
  return (await connection.run({ prompt: "Task", clientId: "message", source: "brief", onPending() {}, onTurnId() {} })).capacity;
}

test("protocol limit kinds distinguish request-rate from usage failures", async () => {
  assert.equal(await capacityResult({ message: "rate limit exceeded: Rate limit reached for requests", codexErrorInfo: "rateLimitExceeded" }), true);
  assert.equal(await capacityResult({ message: "Usage limit reached.", codexErrorInfo: "usageLimitExceeded" }), false);
});

// Each recognition path stands alone. The kind-only text names neither a request-rate limit nor
// capacity, and the text-only failure carries no protocol kind.
const KIND_ONLY = { message: "Too many requests; slow down.", codexErrorInfo: "rateLimitExceeded", additionalDetails: null };
const TEXT_ONLY = { message: "Rate limit reached for requests", codexErrorInfo: null, additionalDetails: null };

test("a request-rate limit is recognised by its kind alone and by its message alone", async () => {
  assert.equal(await capacityResult(KIND_ONLY), true);
  assert.equal(await capacityResult(TEXT_ONLY), true);
  assert.equal(await capacityResult({ ...KIND_ONLY, codexErrorInfo: null }), false);
  assert.equal(await capacityResult({ ...TEXT_ONLY, message: "Request failed." }), false);
});

for (const [label, capacityError] of [["kind alone", KIND_ONLY], ["message alone", TEXT_ONLY]]) {
  test(`a request-rate failure recognised by its ${label} is retried at start`, async () => {
    const ctx = setup("job-capacity", { turnMs: 50, capacityFailures: 1, capacityError, env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "50" } });
    const jobId = startJob(ctx, HEADER, "Too many requests.\n");
    const waited = waitJob(ctx, jobId, 15);
    assert.equal(waited.status, 0, waited.stdout);
    assert.equal(readJobJson(ctx, jobId).capacityRetries.length, 1);
    assert.equal(ctx.fakeState().turnStarts.length, 2);
  });
}

test("max effort passes through to turn/start", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, "model: gpt-test\neffort: max", "Think hard.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  assert.equal(ctx.fakeState().turnStarts[0].effort, "max");

  const task = companion(ctx, ["task", "--effort", "ultra", "--model", "gpt-test", "[quick] task"]);
  assert.equal(task.status, 0, task.stderr);
  assert.equal(ctx.fakeState().turnStarts.at(-1).effort, "ultra");
});

test("wait exits 4 when the job is still running at the timeout", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Slow job.\n");
  const waited = waitJob(ctx, jobId, 1);
  assert.equal(waited.status, 4, waited.stdout);
  assert.match(waited.stdout, /^state: (starting|running)$/m);
  assert.doesNotMatch(waited.stdout, /^---$/m);
  const cancelled = companion(ctx, ["cancel", jobId]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test("wait --exit-zero-while-running exits 0 with a first line while the job runs, and as before once it ends", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Slow job.\n");
  const relayWait = (seconds) => companion(ctx, ["wait", jobId, "--timeout-seconds", String(seconds), "--exit-zero-while-running"]);
  const running = relayWait(1);
  assert.equal(running.status, 0, running.stdout);
  assert.match(running.stdout, /^still running: not an error\. Run the same wait again\.\nstate: (starting|running)\n/);
  assert.doesNotMatch(running.stdout, /^---$/m);
  assert.equal(waitJob(ctx, jobId, 1).status, 4, "without the flag a running job still exits 4");
  assert.equal(companion(ctx, ["cancel", jobId]).status, 0);
  const cancelled = relayWait(5);
  assert.equal(cancelled.status, 5, cancelled.stdout);
  assert.match(cancelled.stdout, /^state: cancelled$/m);
  assert.doesNotMatch(cancelled.stdout, /still running/);

  const quick = setup("job", { turnMs: 50 });
  const quickId = startJob(quick, HEADER, "[quick] Quick job.\n");
  const done = companion(quick, ["wait", quickId, "--timeout-seconds", "20", "--exit-zero-while-running"]);
  assert.equal(done.status, 0, done.stdout);
  assert.match(done.stdout, /^state: completed\n/);
});

test("cancel interrupts the running turn and wait exits 5", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Cancel me.\n");
  await waitFor(() => readJobJson(ctx, jobId).turnId);
  const cancelled = companion(ctx, ["cancel", jobId]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /^state: cancelled$/m);
  assert.equal(ctx.fakeState().interrupts.length, 1);
  assert.equal(waitJob(ctx, jobId, 2).status, 5);
});

test("cancel stops a foreground job whose process-group kill fails with ESRCH", async () => {
  const ctx = setup("job-hang", { env: { RELAY_JOBS_CANCEL_GRACE_MS: "300" } });
  // Not detached: the foreground task shares the test's process group, so kill(-pid) fails
  // with ESRCH, like a companion started in the foreground of a shell.
  const child = spawn("node", [SCRIPT, "task", "--model", "gpt-test", "--effort", "low", "Hang forever."], {
    cwd: ctx.work,
    env: ctx.env,
    stdio: "ignore"
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const jobId = await waitFor(() => {
    for (const slug of fs.readdirSync(ctx.home)) {
      for (const id of fs.readdirSync(path.join(ctx.home, slug))) {
        const job = readJobJson(ctx, id);
        if (job.turnId && job.worker?.pid === child.pid) {
          return id;
        }
      }
    }
    return null;
  });

  try {
    const cancelled = companion(ctx, ["cancel", jobId]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /killed the worker process/);
    const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    assert.ok(exit, "the foreground job is still alive after cancel");
    assert.equal(exit.signal, "SIGTERM");
    assert.equal(readJobJson(ctx, jobId).state, "cancelled");
  } finally {
    child.kill("SIGKILL");
  }
});

test("status lists jobs by directory read and reports one job's block", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, "Listed job.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  const list = companion(ctx, ["status"]);
  assert.match(list.stdout, new RegExp(`\\| ${jobId} +\\| completed +\\| task +\\| codex +\\| gpt-test/low +\\|`));
  const one = companion(ctx, ["status", jobId]);
  assert.match(one.stdout, /^state: completed$/m);
  assert.doesNotMatch(one.stdout, /Report for/);
  const result = companion(ctx, ["result", jobId]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Report for: Listed job\./);
  assert.equal(fs.existsSync(path.join(ctx.home, "state.json")), false);
});

// ---------------------------------------------------------------------------------------
// Hooks

test("SessionEnd leaves a running job alone", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Outlive the session.\n", { env: { RELAY_COMPANION_SESSION_ID: "sess-1" } });
  const job = await waitFor(() => {
    const value = readJobJson(ctx, jobId);
    return value.turnId ? value : null;
  });
  const hook = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: ctx.work,
    env: { ...ctx.env, RELAY_COMPANION_SESSION_ID: "sess-1" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-1", cwd: ctx.work })
  });
  assert.equal(hook.status, 0, hook.stderr);
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.kill(job.worker.pid, 0);
  assert.match(companion(ctx, ["status", jobId]).stdout, /^state: running$/m);
  assert.equal(companion(ctx, ["cancel", jobId]).status, 0);
});

test("SessionStart run three times exports only the session id once", () => {
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "export OTHER=1\n");
  for (let index = 0; index < 3; index += 1) {
    const hook = run("node", [SESSION_HOOK, "SessionStart"], {
      env: { ...process.env, CLAUDE_ENV_FILE: envFile },
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-2", transcript_path: "/tmp/t.jsonl", cwd: ROOT })
    });
    assert.equal(hook.status, 0, hook.stderr);
  }
  const lines = fs.readFileSync(envFile, "utf8").trim().split("\n");
  assert.deepEqual(lines, [
    "export OTHER=1",
    "export RELAY_COMPANION_SESSION_ID='sess-2'"
  ]);
});

// ---------------------------------------------------------------------------------------
// Messages are never lost, a new attempt never reads as the previous one, cancel
// leaves nothing running, the default capacity schedule, the real surrogate cut point.

function spawnAsync(ctx, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], { cwd: ctx.work, env: { ...ctx.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = run("ps", ["-o", "stat=", "-p", String(pid)]).stdout.trim();
  return Boolean(stat) && !stat.startsWith("Z");
}

test("a steer refused after its turn completed still runs, as the next turn", async () => {
  const ctx = setup("job-steer-late", { turnMs: 10000 });
  const jobId = startJob(ctx, HEADER, "Steer races the end.\n");
  await waitFor(() => readJobJson(ctx, jobId).turnId);
  const steered = companion(ctx, ["steer", jobId, "--message", "[quick] late steer"]);
  assert.equal(steered.status, 0, steered.stderr);
  assert.match(steered.stdout, /^outcome: (queued-next-turn|accepted-next-turn|turn-started)$/m);

  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0, waited.stdout);
  assert.match(waited.stdout, /^attempts: 2$/m);
  assert.match(waited.stdout, /Report for: \[quick\] late steer/);
  assert.deepEqual(
    ctx.fakeState().turnStarts.map((turn) => turn.prompt),
    ["Steer races the end.\n", "[quick] late steer"]
  );
});

test("a queued message claimed by a worker that died runs in the next worker, once", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "First turn.\n");
  const job = await waitFor(() => {
    const value = readJobJson(ctx, jobId);
    return value.turnId ? value : null;
  });
  const queued = companion(ctx, ["continue", jobId, "--message", "[quick] DO THE QUEUED FOLLOWUP"]);
  assert.match(queued.stdout, /^outcome: queued-next-turn$/m);
  const messageId = /^message: continue (\S+)$/m.exec(queued.stdout)[1];
  killGroup(job.worker.pid);
  await waitFor(() => /^state: dead$/m.test(companion(ctx, ["status", jobId]).stdout));
  assert.match(companion(ctx, ["status", jobId]).stdout, /^undelivered: 1 message\(s\)/m);

  const resumed = companion(ctx, ["resume", jobId], { env: { FAKE_CODEX_TURN_MS: "50" } });
  assert.equal(resumed.status, 0, resumed.stderr);
  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 0, waited.stdout);
  assert.match(waited.stdout, /Report for: \[quick\] DO THE QUEUED FOLLOWUP/);
  assert.doesNotMatch(waited.stdout, /^undelivered:/m);
  const turns = ctx.fakeState().turnStarts;
  assert.deepEqual(
    turns.map((turn) => turn.prompt),
    ["First turn.\n", "[quick] DO THE QUEUED FOLLOWUP"]
  );
  assert.equal(turns[1].clientUserMessageId, messageId);
});

test("a recovered message that already reached the thread is not run again", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, "First turn.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  const dir = jobDirOf(ctx, jobId);
  const job = readJobJson(ctx, jobId);
  // A worker claimed this message and sent it, then died before recording the outcome.
  const id = "zz-already-sent";
  fs.writeFileSync(path.join(dir, "inbox", "claimed", `${id}.json`), JSON.stringify({ id, kind: "continue", text: "[quick] already ran" }));
  const fakePath = path.join(ctx.binDir, "fake-codex-state.json");
  const fake = JSON.parse(fs.readFileSync(fakePath, "utf8"));
  fake.delivered = { [job.sessionId]: [id] };
  fs.writeFileSync(fakePath, JSON.stringify(fake));
  assert.equal(waitJob(ctx, jobId, 1).status, 3, "an owed message makes wait exit 3");

  assert.equal(companion(ctx, ["resume", jobId]).status, 0);
  assert.equal(waitJob(ctx, jobId).status, 0);
  const prompts = ctx.fakeState().turnStarts.map((turn) => turn.prompt);
  assert.deepEqual(prompts, ["First turn.\n", "Your session was cut off. Continue the task from where you stopped, then write the final report."]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "inbox", "outcomes", `${id}.json`), "utf8")).action, "delivered-before");
});

test("from the moment a continue is taken, readers and cancel see the new attempt", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, "First turn.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);

  const continuing = spawnAsync(ctx, ["continue", jobId, "--message", "Second turn."], { FAKE_CODEX_RESUME_DELAY_MS: "3000" });
  await waitFor(() => (readJobJson(ctx, jobId).workers ?? []).length === 2, { intervalMs: 5 });
  const status = companion(ctx, ["status", jobId]).stdout;
  assert.match(status, /^state: (starting|running)$/m, status);
  assert.match(status, /^attempts: 2$/m);
  assert.match(status, /^report: none$/m);
  const result = companion(ctx, ["result", jobId]);
  assert.equal(result.status, 4);
  assert.doesNotMatch(result.stdout, /Report for: First turn/);

  const acked = await continuing;
  assert.match(acked.stdout, /^outcome: accepted-next-turn$/m);
  const cancelled = companion(ctx, ["cancel", jobId]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /^state: cancelled$/m);
  assert.equal(ctx.fakeState().turnStarts.length, 1, "the cancelled continuation never started a turn");
});

test("a continuation whose thread/resume fails keeps no previous report", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, "First turn.\n");
  assert.equal(waitJob(ctx, jobId).status, 0);
  const continued = companion(ctx, ["continue", jobId, "--message", "Second turn."], { env: { FAKE_CODEX_RESUME_FAIL: "1" } });
  assert.equal(continued.status, 0, continued.stderr);
  const waited = waitJob(ctx, jobId);
  assert.equal(waited.status, 3, waited.stdout);
  assert.match(waited.stdout, /^state: failed$/m);
  assert.match(waited.stdout, /^attempts: 2$/m);
  assert.match(waited.stdout, /^report: none$/m);
  assert.match(waited.stdout, /authentication expired/);
  assert.match(waited.stdout, /^undelivered: 1 message\(s\)/m);
  assert.doesNotMatch(waited.stdout, /Report for: First turn/);
  assert.ok(fs.existsSync(path.join(jobDirOf(ctx, jobId), "attempts", "1-report.md")));
});

test("cancel of a foreground job (ESRCH path) leaves no worker, app-server or descendant running", async () => {
  const ctx = setup("job-hang-child", { env: { RELAY_JOBS_CANCEL_GRACE_MS: "300" } });
  const child = spawn("node", [SCRIPT, "task", "--model", "gpt-test", "--effort", "low", "Hang with a child."], {
    cwd: ctx.work,
    env: ctx.env,
    stdio: "ignore"
  });
  let descendants = [];
  try {
    const record = await waitFor(() => ctx.fakeState().descendants?.[0]);
    const jobId = await waitFor(() => {
      for (const slug of fs.readdirSync(ctx.home)) {
        for (const id of fs.readdirSync(path.join(ctx.home, slug))) {
          if (readJobJson(ctx, id).worker?.pid === child.pid) {
            return id;
          }
        }
      }
      return null;
    });
    descendants = [child.pid, record.appServerPid, record.childPid];
    const cancelled = companion(ctx, ["cancel", jobId]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    for (const pid of descendants) {
      assert.equal(pidAlive(pid), false, `process ${pid} survived cancel`);
    }
    assert.equal(readJobJson(ctx, jobId).state, "cancelled");
  } finally {
    for (const pid of descendants) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    child.kill("SIGKILL");
  }
});

test("cancel of a detached job leaves no descendant running, even one that left the process group", async () => {
  const ctx = setup("job-child", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Run a command that daemonizes.\n");
  const record = await waitFor(() => ctx.fakeState().descendants?.[0]);
  const worker = readJobJson(ctx, jobId).worker.pid;
  try {
    const cancelled = companion(ctx, ["cancel", jobId]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /^state: cancelled$/m);
    for (const pid of [worker, record.appServerPid, record.childPid]) {
      assert.equal(pidAlive(pid), false, `process ${pid} survived cancel`);
    }
  } finally {
    for (const pid of [worker, record.appServerPid, record.childPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
});

for (const [label, env, expected] of [
  ["default", {}, [30000, 60000, 120000]],
  ["empty override", { RELAY_JOBS_CAPACITY_DELAYS_MS: "" }, [30000, 60000, 120000]],
  ["explicit override", { RELAY_JOBS_CAPACITY_DELAYS_MS: "5,6" }, [5, 6]]
]) test(`the ${label} capacity schedule reaches the worker's retry waits`, async () => {

  // Run a worker in this process with the default schedule and a recording sleep.
  const binDir = makeTempDir();
  installFakeCodex(binDir, "job-capacity", { turnMs: 50, capacityFailures: expected.length });
  const work = makeTempDir("relay-work-");
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const request = buildLaunchRequest({ model: "gpt-test", effort: "low", cd: work });
    const jobId = `job-capacity-${Date.now()}`;
    const capacityHome = makeTempDir("relay-capacity-jobs-");
    const { jobDir } = createJobDir(work, jobId, { RELAY_JOBS_HOME: capacityHome });
    assert.ok(jobDir.startsWith(capacityHome + path.sep));
    fs.writeFileSync(path.join(jobDir, "brief.md"), "Busy model.\n");
    writeJob(jobDir, { id: jobId, kind: "task", state: "starting", createdAt: new Date().toISOString(), request, pendingFirstTurn: true, attempts: [] });
    const slept = [];
    const job = await runWorker(jobDir, { env: { RELAY_JOBS_POLL_MS: "50", ...env }, sleep: async (ms) => slept.push(ms) });
    assert.deepEqual(slept, expected);
    assert.equal(job.state, "completed");
    assert.equal(job.capacityRetries.length, expected.length);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a surrogate pair across the real thread-name cut point reaches the backend whole", async () => {
  const ctx = setup("job", { turnMs: 50 });
  const jobId = startJob(ctx, HEADER, `${"a".repeat(59)}${"😀".repeat(10)}\n`);
  assert.equal(waitJob(ctx, jobId, 10).status, 0);
  const [name] = ctx.fakeState().threadNames;
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name), false, `lone surrogate in ${JSON.stringify(name)}`);
  assert.ok(name.startsWith("a".repeat(57)), name);
});

test("cancel reports a queued message as not delivered", async () => {
  const ctx = setup("job", { turnMs: 30000 });
  const jobId = startJob(ctx, HEADER, "Long turn.\n");
  await waitFor(() => readJobJson(ctx, jobId).turnId);
  assert.match(companion(ctx, ["continue", jobId, "--message", "never runs"]).stdout, /^outcome: queued-next-turn$/m);
  const cancelled = companion(ctx, ["cancel", jobId]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /^not-delivered: 1 message\(s\) dropped/m);
  assert.doesNotMatch(cancelled.stdout, /^undelivered:/m);
});


// The fast tier is off unless the user config allows it; these tests allow it.
function allowFastTier(home) {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ fastTier: "allowed" }));
}

test("fast header defaults off and validates its value", () => {
  const parsed = parseHeaderPrompt(`${HEADER}\nfast: true\n---\nbrief`);
  const home = makeTempDir("relay-jobs-");
  allowFastTier(home);
  assert.equal(buildLaunchRequest(parsed.header, { env: { ...process.env, RELAY_JOBS_HOME: home } }).fast, true);
  assert.equal(buildLaunchRequest({ model: "m", effort: "e" }).fast, false);
  assert.equal(buildLaunchRequest({ model: "m", effort: "e", fast: "false" }).fast, false);
  assert.throws(() => buildLaunchRequest({ model: "m", effort: "e", fast: "maybe" }), /fast must be true or false/);
});

test("fast persists on start, continue and resume and prints its tier", async () => {
  const ctx = setup("job", { turnMs: 50 });
  allowFastTier(ctx.home);
  const id = startJob(ctx, `${HEADER}\nfast: true`, "[quick] Fast launch");
  assert.equal(waitJob(ctx, id).status, 0);
  assert.match(companion(ctx, ["status", id]).stdout, /^tier: fast$/m);
  const status = JSON.parse(companion(ctx, ["status", id, "--json"]).stdout);
  assert.equal(status.fast, true);
  assert.equal(status.serviceTier, "priority");
  const message = path.join(ctx.work, "message.txt");
  fs.writeFileSync(message, "[quick] Continue fast");
  assert.equal(companion(ctx, ["continue", id, "--message-file", message]).status, 0);
  assert.equal(waitJob(ctx, id).status, 0);
  assert.equal(companion(ctx, ["resume", id]).status, 0);
  assert.equal(waitJob(ctx, id).status, 0);
  const state = ctx.fakeState();
  assert.equal(state.threadStarts[0].serviceTier, "priority");
  assert.equal(state.threadResumes.length, 2);
  assert.ok(state.threadResumes.every(request => request.serviceTier === "priority"));
  assert.equal(state.turnStarts.length, 3);
  assert.ok(state.turnStarts.every(request => request.serviceTier === "priority"));
});

test("direct start accepts --fast and off omits serviceTier everywhere", () => {
  const ctx = setup("job", { turnMs: 50 });
  allowFastTier(ctx.home);
  const brief = path.join(ctx.work, "brief.txt");
  fs.writeFileSync(brief, "[quick] Flag launch");
  const launched = companion(ctx, ["start", "--model", "m", "--effort", "low", "--fast", "--brief-file", brief]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /^tier: fast$/m);
  assert.equal(waitJob(ctx, /^job: (\S+)$/m.exec(launched.stdout)[1]).status, 0);
  assert.equal(ctx.fakeState().threadStarts[0].serviceTier, "priority");
  const off = setup("job", { turnMs: 50 });
  const id = startJob(off, `${HEADER}\nfast: false`, "[quick] Config decides");
  assert.equal(waitJob(off, id).status, 0);
  assert.equal(companion(off, ["resume", id]).status, 0);
  assert.equal(waitJob(off, id).status, 0);
  assert.doesNotMatch(companion(off, ["status", id]).stdout, /^tier:/m);
  for (const request of [...off.fakeState().threadStarts, ...off.fakeState().threadResumes, ...off.fakeState().turnStarts]) {
    assert.equal(Object.hasOwn(request, "serviceTier"), false);
  }
});

test("a model of another backend's family with no backend: is refused before launch; an explicit backend sends it as written", () => {
  for (const [model, backend] of [["glm-5.3", "zcode"], ["account:zai-individual-coding-plan/GLM-5.3-Flash", "zcode"], ["grok-4.7", "grok"], ["kimi-code/k3", "kimi"]]) {
    assert.throws(() => buildLaunchRequest({ model, effort: "high" }), new RegExp(`with no backend: the job runs on Codex\\. Name the backend: backend: ${backend} \\(--backend ${backend} for a review\\), or backend: codex`), model);
    assert.equal(buildLaunchRequest({ model, effort: "high", backend: "codex" }).model, model);
  }
  assert.equal(buildLaunchRequest({ model: "glm-5.3", effort: "high", backend: "zcode" }).backend, "zcode");
  assert.equal(buildLaunchRequest({ model: "gpt-6-sol", effort: "high" }).backend, "codex");
});
