test("a worker that arrives after the cancel does not run the brief", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "job", { turnMs: 50 });
  const work = makeTempDir("relay-work-cancelled-");
  const home = makeTempDir("relay-jobs-cancelled-");
  const jobId = `job-cancelled-${Date.now()}`;
  const { jobDir } = createJobDir(work, jobId, { RELAY_JOBS_HOME: home });
  fs.writeFileSync(path.join(jobDir, "brief.md"), "Must never run.\n");
  writeJob(jobDir, {
    id: jobId, kind: "task", state: "cancelled", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    errorMessage: "Cancelled before a turn ran.",
    request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: work }), pendingFirstTurn: true, attempts: []
  });
  const job = await runWorker(jobDir, { env: { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" } });
  const after = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
  assert.equal(after.state, "cancelled");
  assert.deepEqual(after.attempts, [], "no attempt began");
  assert.equal(after.pendingFirstTurn, false, "its claim on the brief ends");
  assert.ok(job == null || job.state === "cancelled");
});

test("a job cancelled before its first turn never runs its brief, through a resume and a later continue", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "job", { turnMs: 50 });
  const work = makeTempDir("relay-work-cancelled-");
  const home = makeTempDir("relay-jobs-cancelled-");
  const jobId = `job-cancelled-resume-${Date.now()}`;
  const { jobDir } = createJobDir(work, jobId, { RELAY_JOBS_HOME: home });
  fs.writeFileSync(path.join(jobDir, "brief.md"), "Must never run.\n");
  writeJob(jobDir, {
    id: jobId, kind: "task", state: "cancelled", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    errorMessage: "Cancelled.",
    request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: work }), pendingFirstTurn: true, attempts: []
  });
  const env = { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" };
  postInboxMessage(jobDir, { kind: "resume", text: "Do this instead." });
  await runWorker(jobDir, { env });
  postInboxMessage(jobDir, { kind: "continue", text: "And then this." });
  await runWorker(jobDir, { env });
  const after = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
  assert.deepEqual(after.attempts.map(attempt => attempt.source), ["resume", "continue"]);
  assert.equal(after.pendingFirstTurn, false);
});

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { buildEnv, installFakeCodex } from "./fakes/codex.mjs";
import { makeTempDir } from "./support/helpers.mjs";
import { acquireWorkerLease, isWorkerAlive, readLease, releaseWorkerLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { createJobDir, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { owedMessages, postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { DEFAULT_RESUME_MESSAGE, resumeDeadJobOnce } from "../plugins/relay/scripts/lib/worker/recovery.mjs";
import { loadJobView } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { ownershipDir } from "../plugins/relay/scripts/lib/util/ownership.mjs";
import { readProcessStartTime, listProcesses } from "../plugins/relay/scripts/lib/util/process.mjs";
import { awaitOutcome } from "../plugins/relay/scripts/lib/worker/delivery.mjs";
import { runWorker } from "../plugins/relay/scripts/lib/worker/worker.mjs";
import { COMPANION, RELAY_CMD, companion, decision, jobDirOf, pre, readJobJson, relayContext, relayStart, updated, waitFor } from "./support/relay-fixture.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { installFakeZcode } from "./fakes/zcode.mjs";
import { installFakeKimi } from "./fakes/kimi.mjs";
import { setup, HEADER, startJob, jobDirs, readJob, waitFor as waitForJob, finishJob } from "./support/job-helpers.mjs";

// Worker recovery and cancellation
{

  async function start(ctx) {
    const extra = makeTempDir("relay-recovery-root-");
    // The fast tier is off unless the user config allows it; allowed, the tier is a setting to keep.
    fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "allowed" }));
    ctx.append(ctx.prompt(`model: gpt-test\neffort: low\nfast: true\nmode: write\nnetwork: true\nweb-search: cached\nadd-dir: ${extra}\ncd: ${ctx.work}\n---\nLong first turn`));
    const launched = await relayStart(ctx);
    assert.equal(launched.started.status, 0, launched.started.stderr);
    const id = launched.jobId;
    await waitFor(() => readJobJson(ctx, id).turnId);
    return id;
  }

  function killWorker(ctx, id) {
    const job = readJobJson(ctx, id);
    process.kill(job.worker.pid, "SIGKILL");
    return job;
  }

  // The job's attempt `count` runs its turn, and the worker has recorded it. As the turn starts,
  // the worker writes the turn id, then the message the attempt runs as delivered (turn-started).
  // A worker killed between the two leaves that message owed, and the next worker runs it again.
  function turnRecorded(ctx, id, count) {
    const job = readJobJson(ctx, id);
    const messageId = job.attempts[count - 1]?.messageId;
    return job.attempts.length === count && job.turnId && job.worker &&
      (!messageId || (job.messages ?? []).some(entry => entry.id === messageId && entry.action === "turn-started"));
  }

  async function waitInput(ctx, id) {
    const input = updated(await pre(ctx, "Bash", { command: `${RELAY_CMD} wait ${id} --timeout-seconds 120` }));
    // Keep mutation runs bounded when a broken retry loops forever.
    return { ...input, command: input.command.replace("--timeout-seconds 120", "--timeout-seconds 10") };
  }

  // Run the hook's rewritten wait asynchronously, so the test can kill a worker during it.
  function waitAsync(ctx, input) {
    const child = spawn("bash", ["-c", input.command], { cwd: ctx.work, env: ctx.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    return new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
  }

  test("relay wait resumes a SIGKILL once with first-launch settings and records it", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const old = killWorker(ctx, id);
    await waitFor(() => !isWorkerAlive(old.worker));
    // Direct wait remains a reader.
    assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "0"]).status, 3);
    ctx.env.FAKE_CODEX_TURN_MS = "50";
    const input = await waitInput(ctx, id);
    assert.match(input.command, /--auto-resume/);
    const result = await waitAsync(ctx, input);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^automatic-resume:/m);
    assert.match(result.stdout, /Report for: Your session was cut off\. Continue the task from where you stopped, then write the final report\./);
    const job = readJobJson(ctx, id);
    assert.equal(job.automaticResumes.length, 1);
    assert.equal(job.attempts.length, 2);
    assert.equal(job.attempts[1].automatic, true);
    assert.equal(job.attempts[0].state, "dead", "the dead worker's attempt is closed");
    assert.ok(job.attempts[0].endedAt);
    assert.equal(job.attempts[1].relayVersion, JSON.parse(fs.readFileSync(new URL("../plugins/relay/.claude-plugin/plugin.json", import.meta.url), "utf8")).version);
    assert.equal(isWorkerAlive(old.server), false, "old app-server is swept after worker-only SIGKILL");
    const state = ctx.fakeState();
    const first = state.threadStarts[0], resumed = state.threadResumes[0];
    assert.equal(first.serviceTier, "priority");
    for (const key of ["cwd", "model", "sandbox", "approvalPolicy", "serviceTier", "config"]) {
      assert.deepEqual(resumed[key], first[key], key);
    }
    for (const key of ["model", "effort", "serviceTier", "sandboxPolicy", "approvalPolicy"]) {
      assert.deepEqual(state.turnStarts[1][key], state.turnStarts[0][key], key);
    }
    const status = JSON.parse(companion(ctx, ["status", id, "--json"]).stdout);
    assert.deepEqual(status.automaticResumes, job.automaticResumes);
    assert.match(companion(ctx, ["status", "--all"]).stdout, /automatic-resumes: 1/);
  });

  test("relay wait catches a death while waiting, stops after two deaths and permits hand-back", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const waiting = waitAsync(ctx, await waitInput(ctx, id));
    killWorker(ctx, id);
    await waitFor(() => turnRecorded(ctx, id, 2));
    const second = killWorker(ctx, id);
    const result = await waiting;
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /^state: dead$/m);
    assert.equal(readJobJson(ctx, id).automaticResumes.length, 1);
    // Repeated relay waits spend no more automatic retries.
    assert.equal((await waitAsync(ctx, await waitInput(ctx, id))).status, 3);
    const handback = await pre(ctx, "SubagentHandback", { message: "relay prose" });
    assert.equal(decision(handback), "allow");
    assert.match(updated(handback).message, /^state: dead$/m);
    assert.match(updated(handback).message, /^automatic-resume:/m);
    assert.equal(isWorkerAlive(second.server), false, "second death is swept before hand-back");
  });

  test("continue and a delivered steer each rearm automatic recovery", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    killWorker(ctx, id);
    const waiting = waitAsync(ctx, await waitInput(ctx, id));
    await waitFor(() => turnRecorded(ctx, id, 2));
    killWorker(ctx, id);
    assert.equal((await waiting).status, 3);
    // A user continue starts new work, which earns its own one retry.
    assert.equal(companion(ctx, ["continue", id, "--message", "New user work"]).status, 0);
    await waitFor(() => turnRecorded(ctx, id, 3));
    killWorker(ctx, id);
    const waitingAgain = waitAsync(ctx, await waitInput(ctx, id));
    await waitFor(() => turnRecorded(ctx, id, 4));
    assert.equal(readJobJson(ctx, id).automaticResumes.length, 2);
    // Delivering a message into the automatic turn earns a fresh retry too.
    assert.equal(companion(ctx, ["steer", id, "--message", "User correction"]).status, 0);
    killWorker(ctx, id);
    await waitFor(() => readJobJson(ctx, id).automaticResumes.length === 3 && readJobJson(ctx, id).turnId);
    companion(ctx, ["cancel", id]);
    assert.equal((await waitingAgain).status, 5);
  });

  test("two concurrent relay waits reserve only one automatic resume", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const old = killWorker(ctx, id);
    await waitFor(() => !isWorkerAlive(old.worker));
    ctx.env.FAKE_CODEX_TURN_MS = "100";
    const input = await waitInput(ctx, id);
    const results = await Promise.all([waitAsync(ctx, input), waitAsync(ctx, input)]);
    assert.ok(results.every(result => result.status === 0), JSON.stringify(results));
    assert.equal(readJobJson(ctx, id).automaticResumes.length, 1);
    assert.equal(ctx.fakeState().threadResumes.length, 1);
  });


  test("continue rearms before thread resume or message delivery", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    killWorker(ctx, id);
    const waiting = waitAsync(ctx, await waitInput(ctx, id));
    await waitFor(() => turnRecorded(ctx, id, 2));
    killWorker(ctx, id);
    assert.equal((await waiting).status, 3);
    ctx.env.FAKE_CODEX_RESUME_DELAY_MS = "30000";
    assert.equal(companion(ctx, ["continue", id, "--message", "User work before resume"]).status, 0);
    await waitFor(() => readJobJson(ctx, id).attempts.length === 3 && readJobJson(ctx, id).server);
    assert.equal(readJobJson(ctx, id).turnId, null);
    killWorker(ctx, id);
    ctx.env.FAKE_CODEX_RESUME_DELAY_MS = "0";
    ctx.env.FAKE_CODEX_TURN_MS = "50";
    const result = await waitAsync(ctx, await waitInput(ctx, id));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readJobJson(ctx, id).automaticResumes.length, 2);
  });


  test("a live lease prevents automatic recovery from writing or spawning", async (t) => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const old = killWorker(ctx, id);
    await waitFor(() => !isWorkerAlive(old.worker));
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const identity = { pid: holder.pid, startTime: readProcessStartTime(holder.pid) };
    const dir = jobDirOf(ctx, id);
    t.after(() => { holder.kill("SIGKILL"); releaseWorkerLease(dir, identity); });
    assert.equal(acquireWorkerLease(dir, identity), true);
    const before = fs.readFileSync(path.join(dir, "job.json"), "utf8");
    assert.equal(await resumeDeadJobOnce(dir, ctx.env), "busy");
    assert.equal(fs.readFileSync(path.join(dir, "job.json"), "utf8"), before);
  });

  test("an interrupted automatic reservation is repaired with the same message id", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const old = killWorker(ctx, id);
    await waitFor(() => !isWorkerAlive(old.worker));
    const job = readJobJson(ctx, id);
    const record = { id: "reserved-retry", epoch: "start", at: new Date().toISOString(), fromAttempt: 1, state: "reserved" };
    writeJob(jobDirOf(ctx, id), { ...job, automaticResumes: [record] });
    ctx.env.FAKE_CODEX_TURN_MS = "50";
    assert.equal((await waitAsync(ctx, await waitInput(ctx, id))).status, 0);
    const final = readJobJson(ctx, id);
    assert.equal(final.automaticResumes.length, 1);
    assert.equal(final.automaticResumes[0].id, "reserved-retry");
    assert.equal(final.attempts[1].messageId, "reserved-retry");
  });

  // Every app-server recorded on the job, alive by pid and start time.
  function liveServers(job) {
    return (job.attempts ?? []).flatMap((attempt) => attempt.servers ?? []).filter((server) => isWorkerAlive(server));
  }

  // Only the worker dies; its app-server lives on, and a
  // manual follow-up starts a replacement worker. The replacement stops the old server, with
  // its descendants, before it starts its own.
  for (const command of ["resume", "continue", "steer"]) {
    test(`${command} after only the worker died stops the old app-server before starting one`, async (t) => {
      const ctx = relayContext("job", { turnMs: 30000 });
      const id = await start(ctx);
      const old = killWorker(ctx, id);
      t.after(() => { if (isWorkerAlive(old.server)) process.kill(old.server.pid, "SIGKILL"); });
      await waitFor(() => !isWorkerAlive(old.worker));
      assert.equal(isWorkerAlive(old.server), true, "the fake app-server outlives its worker");
      const sent = companion(ctx, [command, id, "--message", "[quick] Finish after manual recovery"]);
      assert.equal(sent.status, 0, sent.stderr + sent.stdout);
      assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "10"]).status, 0);
      assert.equal(isWorkerAlive(old.server), false, "the replacement swept the old server");
      const job = readJobJson(ctx, id);
      const swept = job.attempts[0].servers[0];
      const replacement = job.attempts.at(-1).servers[0];
      assert.equal(swept.pid, old.server.pid);
      assert.ok(swept.endedAt, "the sweep records endedAt");
      assert.ok(Date.parse(swept.endedAt) <= Date.parse(replacement.startedAt), "swept before the new server started");
    });
  }

  // A live process standing in for an old app-server. `ignoreTerm` makes it ignore SIGTERM
  // (and write `marker` when it gets one); `descendant` makes it start a detached child of
  // its own, whose identity it publishes. It is returned only once its handlers are in place:
  // a sweep that signals it sooner would meet the default SIGTERM action, not the stand-in.
  async function oldServer(t, { ignoreTerm = false, marker = null, descendant = false } = {}) {
    const pidFile = path.join(makeTempDir("relay-old-server-"), "child");
    const ready = `${pidFile}.ready`;
    const script = `
      const fs = require("fs");
      process.on("SIGTERM", () => { if (${JSON.stringify(marker)}) fs.writeFileSync(${JSON.stringify(marker)}, ""); if (!${ignoreTerm}) process.exit(0); });
      if (${descendant}) {
        const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        fs.writeFileSync(${JSON.stringify(pidFile)} + ".tmp", String(child.pid));
        fs.renameSync(${JSON.stringify(pidFile)} + ".tmp", ${JSON.stringify(pidFile)});
      }
      fs.writeFileSync(${JSON.stringify(ready)}, "");
      setInterval(() => {}, 1000);`;
    const server = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const closed = once(server, "close");
    await waitFor(() => readProcessStartTime(server.pid) && fs.existsSync(ready) && (!descendant || fs.existsSync(pidFile)));
    const identity = { pid: server.pid, startTime: readProcessStartTime(server.pid), startedAt: new Date().toISOString() };
    const childPid = descendant ? Number(fs.readFileSync(pidFile, "utf8")) : null;
    const child = childPid ? { pid: childPid, startTime: readProcessStartTime(childPid) } : null;
    t.after(async () => {
      if (child && isWorkerAlive(child)) process.kill(child.pid, "SIGKILL");
      server.kill("SIGKILL");
      await closed;
    });
    return { identity, child };
  }

  // A job whose worker died, with the given app-server records and a quick follow-up queued.
  // Its next worker runs in this process against the fake backend.
  function sweepJob({ server = null, servers = [] } = {}) {
    const binDir = makeTempDir();
    installFakeCodex(binDir, "job", { turnMs: 50 });
    const work = makeTempDir("relay-work-sweep-");
    const home = makeTempDir("relay-jobs-sweep-");
    const jobId = `job-sweep-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const { jobDir } = createJobDir(work, jobId, { RELAY_JOBS_HOME: home });
    fs.writeFileSync(path.join(jobDir, "brief.md"), "Old work.\n");
    writeJob(jobDir, {
      id: jobId, kind: "task", state: "running", createdAt: new Date().toISOString(),
      request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: work }),
      worker: { pid: 999999, startTime: "gone" }, server, serverPid: server?.pid ?? null,
      attempts: [{ attempt: 1, source: "brief", state: "running", servers }]
    });
    const message = postInboxMessage(jobDir, { kind: "continue", text: "[quick] Next work" });
    const fakeState = () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    const run = (predecessorCleanup) => runWorker(jobDir, { env: { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" }, predecessorCleanup });
    return { binDir, jobDir, message, fakeState, run };
  }

  test("a worker whose sweep cannot stop the old app-server starts none and fails naming its pid", async (t) => {
    const { identity } = await oldServer(t);
    const ctx = sweepJob({ server: identity, servers: [identity] });
    // A kill that never lands stands in for a server the sweep cannot stop.
    const job = await ctx.run({ killImpl: () => {}, graceMs: 50 });
    assert.equal(job.state, "failed");
    assert.match(job.errorMessage, new RegExp(`app-server pid ${identity.pid}\\b`));
    assert.equal(isWorkerAlive(identity), true);
    assert.equal(fs.existsSync(path.join(ctx.binDir, "fake-codex-state.json")), false, "no app-server was started");
    assert.equal(job.attempts[0].servers[0].endedAt, undefined, "a survivor keeps its record open");
    assert.equal(job.server.pid, identity.pid, "a survivor stays the job's recorded app-server");
    assert.equal(readOutcome(ctx.jobDir, ctx.message.id)?.action, "accepted-next-turn");
    assert.deepEqual(owedMessages(ctx.jobDir).map((entry) => entry.id), [ctx.message.id], "the follow-up stays owed");
  });

  test("a sweep that cannot read the process table marks no live predecessor ended and starts nothing", async (t) => {
    const { identity } = await oldServer(t);
    const ctx = sweepJob({ server: identity, servers: [identity] });
    const job = await ctx.run({ listProcesses: () => null });
    assert.equal(job.state, "failed");
    assert.match(job.errorMessage, new RegExp(`app-server pid ${identity.pid}: the process table could not be read`));
    assert.equal(isWorkerAlive(identity), true);
    assert.equal(job.attempts[0].servers[0].endedAt, undefined);
    assert.equal(fs.existsSync(path.join(ctx.binDir, "fake-codex-state.json")), false, "no app-server was started");
    assert.deepEqual(owedMessages(ctx.jobDir).map((entry) => entry.id), [ctx.message.id]);
  });

  test("a readable process table omitting a live server still prevents startup", async t => {
    const { identity } = await oldServer(t);
    const ctx = sweepJob({ server: identity, servers: [identity] });
    const job = await ctx.run({ listProcesses: () => [] });
    assert.equal(job.state, "failed");
    assert.match(job.errorMessage, new RegExp(`app-server pid ${identity.pid}`));
    assert.equal(isWorkerAlive(identity), true);
    assert.equal(job.attempts[0].servers[0].endedAt, undefined);
    assert.equal(fs.existsSync(path.join(ctx.binDir, "fake-codex-state.json")), false);
  });

  test("the sweep leaves a reused pid with another start time alone", async (t) => {
    const { identity } = await oldServer(t);
    const reused = { ...identity, startTime: "ps:Thu Jan 1 00:00:00 1970" };
    const ctx = sweepJob({ server: reused, servers: [reused] });
    const job = await ctx.run();
    assert.equal(job.state, "completed");
    assert.equal(isWorkerAlive(identity), true, "an unrelated process with the recorded pid lives on");
    assert.equal(job.attempts[0].servers[0].endedAt, undefined);
  });

  test("the sweep skips an already-ended record of a live identity", async (t) => {
    const { identity } = await oldServer(t);
    const ended = { ...identity, endedAt: new Date().toISOString(), code: 0 };
    const ctx = sweepJob({ servers: [ended] });
    const job = await ctx.run();
    assert.equal(job.state, "completed");
    assert.equal(isWorkerAlive(identity), true);
  });

  test("the sweep stops a predecessor recorded only in attempts[].servers", async (t) => {
    const { identity } = await oldServer(t);
    const ctx = sweepJob({ servers: [identity] });
    const job = await ctx.run();
    assert.equal(job.state, "completed");
    assert.equal(isWorkerAlive(identity), false);
    assert.ok(job.attempts[0].servers[0].endedAt, "the swept server's record is ended");
    assert.equal(ctx.fakeState().turnStarts.length, 1);
  });

  test("the sweep stops a predecessor's descendant, even one in its own session", async (t) => {
    const { identity, child } = await oldServer(t, { descendant: true });
    assert.equal(isWorkerAlive(child), true);
    const ctx = sweepJob({ server: identity, servers: [identity] });
    const job = await ctx.run();
    assert.equal(job.state, "completed");
    assert.equal(isWorkerAlive(identity), false);
    assert.equal(isWorkerAlive(child), false, "the descendant is swept with its server");
  });

  function companionAsync(ctx, args) {
    const child = spawn(process.execPath, [COMPANION, ...args], { cwd: ctx.work, env: ctx.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    return new Promise(resolve => child.on("close", status => resolve({ status, stdout, stderr })));
  }

  // Both recoveries act on one dead job whose app-server lives on. The second starts as soon
  // as the first holds the lease, so each order is exercised.
  for (const first of ["manual", "automatic"]) {
    test(`manual and automatic recovery at once leave one app-server (${first} first)`, async () => {
      const ctx = relayContext("job", { turnMs: 30000 });
      const id = await start(ctx);
      const dir = jobDirOf(ctx, id);
      const old = killWorker(ctx, id);
      await waitFor(() => !isWorkerAlive(old.worker));
      assert.equal(isWorkerAlive(old.server), true, "the fake app-server outlives its worker");
      const input = await waitInput(ctx, id);
      const runs = {
        manual: () => companionAsync(ctx, ["continue", id, "--message", "Manual follow-up"]),
        automatic: () => waitAsync(ctx, { ...input, command: input.command.replace("--timeout-seconds 10", "--timeout-seconds 3") })
      };
      const second = first === "manual" ? "automatic" : "manual";
      const started = { [first]: runs[first]() };
      await waitFor(() => { const lease = readLease(dir); return lease && lease.pid !== old.worker.pid && isWorkerAlive(lease); }, { intervalMs: 5 });
      started[second] = runs[second]();
      const manual = await started.manual;
      assert.equal(manual.status, 0, manual.stdout + manual.stderr);
      const automatic = await started.automatic;
      assert.ok([0, 4].includes(automatic.status), automatic.stdout + automatic.stderr);
      await waitFor(() => {
        const job = readJobJson(ctx, id);
        return job.attempts.length > 1 && job.turnId && isWorkerAlive(job.worker);
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const job = readJobJson(ctx, id);
      assert.equal(isWorkerAlive(old.server), false, "the old server was swept");
      assert.equal(liveServers(job).length, 1, JSON.stringify(job.attempts.map((attempt) => attempt.servers)));
      assert.equal(companion(ctx, ["cancel", id]).status, 0);
    });
  }

  // A message posted after the worker's last claim, while it finishes, is run. The
  // worker runs in this process, and a hook on `fs` posts the message at one point of its exit:
  // when it writes the job's final state, or when it removes its lease.
  for (const moment of ["final-state", "lease-release"]) {
    test(`a message posted between the worker's last claim and its exit is run (${moment})`, async (t) => {
      const binDir = makeTempDir();
      installFakeCodex(binDir, "job", { turnMs: 50 });
      const work = makeTempDir("relay-work-late-");
      const home = makeTempDir("relay-jobs-late-");
      const jobId = `job-late-${Date.now()}`;
      const { jobDir } = createJobDir(work, jobId, { RELAY_JOBS_HOME: home });
      fs.writeFileSync(path.join(jobDir, "brief.md"), "First work.\n");
      writeJob(jobDir, {
        id: jobId, kind: "task", state: "starting", createdAt: new Date().toISOString(),
        request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: work }), pendingFirstTurn: true, attempts: []
      });
      const jobFile = path.join(jobDir, "job.json");
      const leaseRecords = ownershipDir(path.join(jobDir, "worker.lease"));
      let late = null;
      const post = () => { late = postInboxMessage(jobDir, { kind: "continue", text: "Late work" }); };
      // Every lease record the worker links: an owner record per acquisition, a release record
      // per release.
      const links = [];
      const { renameSync, linkSync } = fs;
      t.after(() => { fs.renameSync = renameSync; fs.linkSync = linkSync; });
      fs.renameSync = function (from, to, ...rest) {
        if (moment === "final-state" && !late && to === jobFile && JSON.parse(fs.readFileSync(from, "utf8")).state === "completed") post();
        return renameSync.call(this, from, to, ...rest);
      };
      fs.linkSync = function (from, to, ...rest) {
        if (path.dirname(String(to)) === leaseRecords) {
          const release = JSON.parse(fs.readFileSync(from, "utf8")).release === true;
          if (moment === "lease-release" && !late && release) post();
          links.push(release ? "release" : "owner");
        }
        return linkSync.call(this, from, to, ...rest);
      };
      const job = await runWorker(jobDir, { env: { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" } });
      assert.ok(late, "the message was posted during the worker's exit");
      assert.equal(readOutcome(jobDir, late.id)?.action, "turn-started");
      assert.equal(job.state, "completed");
      assert.deepEqual(job.attempts.map((attempt) => attempt.source), ["brief", "continue"]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")).turnStarts.length, 2);
      assert.equal(readLease(jobDir), null, "the lease is released at the end");
      // Posted before the release, the message keeps the lease until it has run: one take,
      // one release. Posted as the lease goes, it is taken again with a fresh lease.
      assert.deepEqual(links, moment === "final-state" ? ["owner", "release"] : ["owner", "release", "owner", "release"]);
    });
  }

  // A default resume that the owed brief makes redundant is closed only once the brief's attempt
  // is on the job. Closed sooner, it left nothing owed while the job still named its dead worker,
  // and a reader took the job for dead as the new worker was about to run the brief.
  test("a default resume skipped for the owed brief is closed only once the brief's attempt is on the job", async (t) => {
    const binDir = makeTempDir();
    installFakeCodex(binDir, "job", { turnMs: 50 });
    const work = makeTempDir("relay-work-skip-");
    const home = makeTempDir("relay-jobs-skip-");
    const jobId = `job-skip-${Date.now()}`;
    const { jobDir } = createJobDir(work, jobId, { RELAY_JOBS_HOME: home });
    fs.writeFileSync(path.join(jobDir, "brief.md"), "First work.\n");
    // The brief went out, and its worker died before it saw the brief start.
    writeJob(jobDir, {
      id: jobId, kind: "task", state: "running", createdAt: new Date().toISOString(),
      request: buildLaunchRequest({ model: "gpt-test", effort: "low", cd: work }), pendingFirstTurn: true,
      worker: { pid: 999999, startTime: "gone" }, attempts: [{ attempt: 1, source: "brief", state: "running" }]
    });
    const resume = postInboxMessage(jobDir, { kind: "resume", text: DEFAULT_RESUME_MESSAGE, isDefault: true });
    // The job as a reader sees it right after the resume's outcome is published.
    let seen = null;
    const { renameSync } = fs;
    t.after(() => { fs.renameSync = renameSync; });
    fs.renameSync = function (from, to, ...rest) {
      const result = renameSync.call(this, from, to, ...rest);
      if (!seen && path.basename(String(to)) === `${resume.id}.json` && readOutcome(jobDir, resume.id)) seen = loadJobView(jobDir).state;
      return result;
    };
    const job = await runWorker(jobDir, { env: { ...buildEnv(binDir), RELAY_JOBS_POLL_MS: "50" } });
    assert.equal(readOutcome(jobDir, resume.id).action, "skipped");
    assert.equal(seen, "starting");
    assert.equal(job.state, "completed");
    assert.deepEqual(job.attempts.map((attempt) => attempt.source), ["brief", "brief"]);
  });

  // A worker records itself and its attempt before it sweeps, so a cancel
  // that arrives during the sweep sees the new attempt, not the job's old completed state.
  test("a cancel during the new worker's sweep stops the follow-up", async (t) => {
    const ctx = relayContext("job", { turnMs: 50 });
    const id = await start(ctx);
    const dir = jobDirOf(ctx, id);
    assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "10"]).status, 0);
    await waitFor(() => !readLease(dir));
    // An old app-server record left open, whose process ignores SIGTERM: the next sweep lasts
    // the kill wait.
    const marker = path.join(makeTempDir("relay-sweep-marker-"), "term");
    const { identity } = await oldServer(t, { ignoreTerm: true, marker });
    const job = readJobJson(ctx, id);
    writeJob(dir, { ...job, server: identity, serverPid: identity.pid,
      attempts: job.attempts.map((attempt, index) => (index === 0 ? { ...attempt, servers: [...(attempt.servers ?? []), identity] } : attempt)) });
    const followUp = companionAsync(ctx, ["continue", id, "--message", "Follow-up"]);
    await waitFor(() => fs.existsSync(marker), { intervalMs: 5 });
    const during = readJobJson(ctx, id);
    assert.equal(during.attempts.length, 2, "the new attempt is recorded before the sweep");
    assert.equal(during.state, "starting");
    const cancelled = companion({ ...ctx, env: { ...ctx.env, RELAY_JOBS_CANCEL_GRACE_MS: "8000" } }, ["cancel", id]);
    assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
    assert.doesNotMatch(cancelled.stdout, /already completed/);
    assert.match(cancelled.stdout, /^state: cancelled$/m);
    assert.equal((await followUp).status, 0);
    const final = readJobJson(ctx, id);
    assert.equal(ctx.fakeState().appServerStarts, 1, "cancel during the sweep prevents app-server startup");
    assert.equal(final.state, "cancelled");
    assert.equal(final.attempts.at(-1).state, "cancelled");
    assert.equal(ctx.fakeState().turnStarts.length, 1, "the follow-up never ran");
    assert.equal(isWorkerAlive(identity), false);
  });

  // `cancel` of a dead job races the worker a `resume` starts.
  // The old app-server ignores SIGTERM, so the cancel's own sweep lasts the kill wait; the
  // resume starts during it, and its worker holds the lease when the cancel comes to write.
  // The cancel then goes to that worker and says so. "marked cancelled" is printed only
  // when the cancel wrote the state itself.
  // `holdWorker` stops the resume's worker as soon as it holds the lease, before the cancel
  // posts its message, and continues it only after the cancel has answered: whatever the
  // cancel's reads take, that worker cannot end the job first.
  async function cancelDuringResume(t, cancelEnv = {}, { holdWorker = false } = {}) {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const dir = jobDirOf(ctx, id);
    const old = killWorker(ctx, id);
    await waitFor(() => !isWorkerAlive(old.worker));
    process.kill(old.server.pid, "SIGKILL");
    await waitFor(() => !isWorkerAlive(old.server));
    const marker = path.join(makeTempDir("relay-cancel-marker-"), "term");
    const { identity } = await oldServer(t, { ignoreTerm: true, marker });
    const job = readJobJson(ctx, id);
    writeJob(dir, { ...job, server: identity, serverPid: identity.pid, attempts: job.attempts.map((attempt, index) => (index === 0 ? { ...attempt, servers: [identity] } : attempt)) });
    const cancelled = companionAsync({ ...ctx, env: { ...ctx.env, ...cancelEnv } }, ["cancel", id]);
    await waitFor(() => fs.existsSync(marker), { intervalMs: 5 });
    const resumed = companionAsync(ctx, ["resume", id, "--message", "Resumed work"]);
    await waitFor(() => { const lease = readLease(dir); return lease?.role === "worker" && isWorkerAlive(lease); }, { intervalMs: 5 });
    const worker = readLease(dir);
    if (holdWorker) {
      process.kill(worker.pid, "SIGSTOP");
      t.after(() => { try { process.kill(worker.pid, "SIGCONT"); } catch {} });
    }
    const answer = await cancelled;
    if (holdWorker) process.kill(worker.pid, "SIGCONT");
    return { ctx, id, dir, identity, worker, cancelled: answer, resumed };
  }

  async function settledCancelled(ctx, id, dir) {
    const settled = () => !isWorkerAlive(readLease(dir) ?? {}) && !isWorkerAlive(readJobJson(ctx, id).worker);
    await waitFor(settled, { timeoutMs: 8000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    const final = readJobJson(ctx, id);
    assert.equal(final.state, "cancelled", final.state);
    assert.equal(settled(), true, "no worker runs on after the cancel");
    assert.equal(liveServers(final).length, 0);
    // The resumed turn either never started, or started and was interrupted by the cancel.
    assert.deepEqual(final.attempts.map((attempt) => attempt.state).slice(1), final.attempts.length > 1 ? Array(final.attempts.length - 1).fill("cancelled") : []);
    assert.ok(ctx.fakeState().turnStarts.length <= 2, "no turn ran after the cancel");
  }

  test("cancel racing a resume on a dead job goes to the new worker, which ends it cancelled", async (t) => {
    const { ctx, id, dir, identity, worker, cancelled, resumed } = await cancelDuringResume(t, { RELAY_JOBS_CANCEL_GRACE_MS: "8000" });
    assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
    assert.match(cancelled.stdout, new RegExp(`^cancel: the cancel went to the job's new worker \\(pid ${worker.pid}\\), which ended it cancelled$`, "m"));
    assert.doesNotMatch(cancelled.stdout, /marked cancelled/);
    assert.match(cancelled.stdout, /^state: cancelled$/m);
    await resumed;
    await settledCancelled(ctx, id, dir);
    assert.equal(isWorkerAlive(identity), false);
  });

  test("cancel racing a resume exits nonzero while the new worker has not ended the job", async (t) => {
    const { ctx, id, dir, worker, cancelled, resumed } = await cancelDuringResume(t, { RELAY_JOBS_CANCEL_GRACE_MS: "1" }, { holdWorker: true });
    assert.equal(cancelled.status, 4, cancelled.stdout + cancelled.stderr);
    assert.equal(cancelled.stderr.split("\n")[0], `Job ${id} is still running; the cancel is with its worker (pid ${worker.pid}).`);
    assert.match(cancelled.stdout, new RegExp(`^cancel: the job is still running; the cancel is with its worker \\(pid ${worker.pid}\\)$`, "m"));
    assert.doesNotMatch(cancelled.stdout, /marked cancelled/);
    await resumed;
    // The worker then ends the job on the cancel it was given.
    await settledCancelled(ctx, id, dir);
  });

  test("cancel of a dead job with no new worker says it marked the job cancelled", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = await start(ctx);
    const old = killWorker(ctx, id);
    await waitFor(() => !isWorkerAlive(old.worker));
    const cancelled = companion(ctx, ["cancel", id]);
    assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
    assert.match(cancelled.stdout, /^cancel: worker was already gone; marked cancelled$/m);
    assert.equal(readJobJson(ctx, id).cancelledBy, "cancel command");
  });

  test("automatic recovery's lease is no wait-false consumer", async t => {
    const marker = path.join(makeTempDir("relay-recovery-marker-"), "term");
    const { identity } = await oldServer(t, { ignoreTerm: true, marker });
    const ctx = sweepJob({ server: identity, servers: [identity] });
    // Recovery starts a worker only for a job inside its jobs home.
    const env = { ...buildEnv(ctx.binDir), RELAY_JOBS_HOME: path.dirname(path.dirname(ctx.jobDir)), RELAY_JOBS_POLL_MS: "50", CODEX_HOME: makeTempDir("relay-recovery-home-") };
    t.after(async () => {
      await waitFor(() => {
        const job = JSON.parse(fs.readFileSync(path.join(ctx.jobDir, "job.json"), "utf8"));
        return job.worker?.pid && job.worker.pid !== 999999;
      });
      const job = JSON.parse(fs.readFileSync(path.join(ctx.jobDir, "job.json"), "utf8"));
      const ours = [job.worker, job.server, ...(job.workers ?? []), ...(job.attempts ?? []).flatMap(attempt => attempt.servers ?? [])];
      for (const identity of ours) {
        if (identity && isWorkerAlive(identity)) process.kill(identity.pid, "SIGKILL");
      }
      await waitFor(() => ours.every(identity => !identity || !isWorkerAlive(identity)));
    });
    const recovering = resumeDeadJobOnce(ctx.jobDir, env);
    try {
      await waitFor(() => fs.existsSync(marker));
      assert.equal(readLease(ctx.jobDir).pid, process.pid, "automatic recovery holds the lease");
      const message = postInboxMessage(ctx.jobDir, { kind: "continue", text: "[quick] Arrived during recovery" });
      const delivered = await awaitOutcome(ctx.jobDir, message.id, { env, wait: false, timeoutMs: 50 });
      assert.equal(delivered.consumer, false);
      assert.equal(delivered.outcome, null);
      assert.equal(readOutcome(ctx.jobDir, message.id), null);
      await recovering;
      await waitFor(() => readOutcome(ctx.jobDir, message.id)?.action === "turn-started" && !readLease(ctx.jobDir));
      assert.equal(ctx.fakeState().turnStarts.filter(turn => turn.prompt === message.text).length, 1);
    } finally {
      await recovering;
    }
  });

  for (const role of ["recovery", "cancel"]) {
    test(`cancel names its ${role} lease holder`, async t => {
      const ctx = relayContext("job", { turnMs: 50, env: { CODEX_HOME: makeTempDir("relay-role-home-") } });
      const id = await start(ctx);
      const dir = jobDirOf(ctx, id);
      assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "10"]).status, 0);
      await waitFor(() => !readLease(dir));
      writeJob(dir, { ...readJobJson(ctx, id), state: "running", worker: { pid: 999999 }, server: null });
      const holder = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
      assert.equal(acquireWorkerLease(dir, holder, role), true);
      t.after(() => releaseWorkerLease(dir, holder));
      const result = companion({ ...ctx, env: { ...ctx.env, RELAY_JOBS_CANCEL_GRACE_MS: "1" } }, ["cancel", id]);
      assert.equal(result.status, 4, result.stdout + result.stderr);
      assert.equal(result.stderr.trim(), `Job ${id} is still running; the cancel is with its ${role} (pid ${process.pid}).`);
      assert.ok(result.stdout.split("\n").includes(`cancel: the job is still running; the cancel is with its ${role} (pid ${process.pid})`), result.stdout);
      assert.doesNotMatch(result.stdout + result.stderr, /its worker/);
    });
  }
}

// Nested jobs sharing a process group
{
  const waitFor = waitForJob;

  for (const backend of ['codex', 'grok', 'zcode', 'kimi']) {
    test(`${backend}: recovery preserves a nested companion job sharing its process group`, async t => {
      const outer = setup(t, { turnMs: 3000 });
      const inner = setup(t, { turnMs: 6000 });
      let binary = path.join(outer.bin, 'codex');
      let header = HEADER;
      if (backend === 'grok') {
        binary = installFakeGrok(outer.bin, { turnMs: 3000 }).binary;
        outer.env.GROK_BINARY = binary;
        header = 'backend: grok\nmodel: default\neffort: default';
      } else if (backend === 'zcode') {
        binary = installFakeZcode(outer.bin, { turnMs: 3000 }).binary;
        outer.env.ZCODE_BINARY = binary;
        header = 'backend: zcode\nmodel: default\neffort: default';
      } else if (backend === 'kimi') {
        binary = installFakeKimi(outer.bin, { turnMs: 3000 }).binary;
        outer.env.KIMI_BINARY = binary;
        header = 'backend: kimi\nmodel: default\neffort: default';
      }
      const script = new URL('../plugins/relay/scripts/companion.mjs', import.meta.url).pathname;
      const marker = path.join(outer.root, 'nested-started');
      const overrides = { HOME: inner.user, USERPROFILE: inner.user, RELAY_JOBS_HOME: inner.jobs, PATH: inner.env.PATH };
      // Model a tool shell launching a foreground companion in the background, then exiting.
      // Both shells use captured output, but the companion retains the outer worker's group.
      const launch = `require('node:child_process').spawn(process.execPath, ${JSON.stringify([script, 'task', '--model', 'gpt-test', '--effort', 'low', 'Nested task'])}, {
        cwd: ${JSON.stringify(inner.work)}, env: { ...process.env, ...${JSON.stringify(overrides)} }, stdio: 'ignore'
      }).unref();`;
      const inject = `if (!require('node:fs').existsSync(${JSON.stringify(marker)})) {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(launch)}], { stdio: 'ignore' }).unref();
      }\n`;
      fs.writeFileSync(binary, fs.readFileSync(binary, 'utf8').replace('\n', '\n' + inject));
      // The outer brief runs until the test kills its server: a turn on a timer could end first
      // when the nested job starts slowly, and a server killed after its turn needs no recovery.
      // The resumed turn takes the fake's 3 s.
      const { id } = startJob(outer, header, '[long] Outer task');
      const innerDir = await waitFor(() => jobDirs(inner).find(dir => JSON.parse(fs.readFileSync(path.join(dir, 'job.json'))).state === 'running'));
      const innerId = path.basename(innerDir);
      const before = readJob(inner, innerId);
      const outerBefore = readJob(outer, id);
      // The intermediate shells must have exited before recovery takes its group snapshot. The
      // orphaned worker's new parent is pid 1, or on Linux the nearest child subreaper (such as
      // `systemd --user`); either way it is outside the outer worker's group.
      await waitFor(() => {
        const rows = listProcesses();
        const worker = rows.find(row => row.pid === before.worker.pid);
        const parent = worker && rows.find(row => row.pid === worker.ppid);
        return worker && (worker.ppid === 1 || !parent || parent.pgid !== outerBefore.worker.pid);
      });
      const table = listProcesses();
      const identities = [before.worker.pid, before.serverPid].map(pid => table.find(row => row.pid === pid));
      assert.ok(identities.every(row => row && row.pgid === outerBefore.worker.pid));
      process.kill(outerBefore.serverPid, 'SIGKILL');
      await waitFor(() => readJob(outer, id).automaticResumes?.length === 1);
      const afterTable = listProcesses();
      assert.ok(identities.every(identity => afterTable.some(row => row.pid === identity.pid && row.startTime === identity.startTime && !row.zombie)),
        'recovery killed the inner worker or server');
      await finishJob(inner, innerId);
      assert.equal(readJob(inner, innerId).state, 'completed');
      await finishJob(outer, id);
      assert.equal(readJob(outer, id).state, 'completed');
    });
  }
}
