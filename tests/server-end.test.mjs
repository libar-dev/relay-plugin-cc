import { scriptedConnection } from "./support/backend-connection.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { serverEndMessage, CodexAppServerClient } from "../plugins/relay/scripts/lib/backends/codex/client.mjs";
import { SpawnedServerClient } from "../plugins/relay/scripts/lib/backends/transport/stdio-rpc.mjs";
import { runTurnOnThread } from "../plugins/relay/scripts/lib/backends/codex/turn.mjs";
import { grokEndMessage } from "../plugins/relay/scripts/lib/backends/grok/connection.mjs";
import { zcodeEndMessage } from "../plugins/relay/scripts/lib/backends/zcode/connection.mjs";
import { kimiEndMessage } from "../plugins/relay/scripts/lib/backends/kimi/connection.mjs";
import { installFakeCodex } from "./fakes/codex.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { finishJob, HEADER, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { makeTempDir, writeExecutable } from "./support/helpers.mjs";
import fs from "node:fs";
import { DEFAULT_RESUME_MESSAGE, resumeDeadJobOnce } from "../plugins/relay/scripts/lib/worker/recovery.mjs";
import { isWorkerAlive } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { companion, jobDirOf, readJobJson, relayContext, waitFor as waitForForAppserverdeath } from "./support/relay-fixture.mjs";

// Requests after transport end
{

  // A request after the server exits rejects at once,
  // whether or not stdout has closed, so the worker takes the server-end path; and every
  // backend's end message keeps the partial-line byte count.

  // Settles within `ms`, or reports that it is still pending.
  async function settlesWithin(promise, ms = 200) {
    return Promise.race([
      promise.then(value => ({ state: "resolved", value }), error => ({ state: "rejected", error })),
      delay(ms).then(() => ({ state: "pending" }))
    ]);
  }

  test("a request after the client saw the server end rejects at once, for Codex and Grok turns", async () => {
    for (const backend of ["codex", "grok"]) {
      const client = new SpawnedServerClient("/tmp");
      client.proc = { stdin: { write() {} } };
      client.handleExit(new Error("Ended"));
      const raw = await settlesWithin(client.request("thread/read", {}));
      assert.equal(raw.state, "rejected", backend);
      assert.match(raw.error.message, /Ended/);
      if (backend === "codex") {
        const turn = await settlesWithin(runTurnOnThread(client, "thread", { prompt: "Task", onTurnId() {} }));
        assert.equal(turn.state, "rejected");
        assert.match(turn.error.message, /Ended/);
      } else {
        const connection = await scriptedConnection("grok", client, { cwd: "/nonexistent" }, { env: {}, state: {}, saveState() {}, tap() {} });
        connection.sessionId = "s";
        const turn = await settlesWithin(connection.run({ prompt: "Task", clientId: "task", source: "brief", onPending() {}, onTurnId() {} }));
        assert.equal(turn.state, "resolved");
        assert.equal(turn.value.turnStatus, "failed");
        assert.match(turn.value.error.message, /Ended/);
      }
    }
  });

  test("a request after the server process exited rejects at once while a child still holds stdout", async () => {
    const dir = makeTempDir("transport-end-");
    const binary = path.join(dir, "server");
    writeExecutable(binary, `#!/usr/bin/env node
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n');
    if (m.method === 'die') {
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 1, 2] }).unref();
      process.stdout.write('{"partial":', () => setTimeout(() => process.exit(17), 10));
    }
  });
  `);
    const client = new SpawnedServerClient(dir, { binary, args: [], initializeParams: {} });
    await client.initialize();
    await client.request("die", {});
    const exited = Date.now();
    while (!client.exitSeen && Date.now() - exited < 3000) await delay(5);
    assert.ok(client.exitSeen, "the server process exited");
    const after = await settlesWithin(client.request("turn/start", {}), 50);
    assert.equal(after.state, "rejected", "rejects at once, before stdout closes");
    assert.match(after.error.message, /exit 17/);
    // The end is recorded long before the child releases stdout, with the partial line.
    const ended = await settlesWithin(client.exitPromise, 2000);
    assert.equal(ended.state, "resolved");
    assert.ok(client.exitInfo.endedAt);
    assert.equal(client.exitInfo.code, 17);
    assert.equal(client.exitInfo.partialStdoutBytes, Buffer.byteLength('{"partial":'));
    await client.close();
  });

  for (const backend of ["codex", "grok"]) {
    for (const holdStdoutMs of [100, 5000]) {
      test(`${backend}: a server that dies during a capacity wait, its child holding stdout ${holdStdoutMs} ms, is recovered automatically`, async t => {
        const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: "500" } });
        let header = HEADER;
        if (backend === "codex") {
          installFakeCodex(ctx.bin, "job-capacity", { turnMs: 50, capacityFailures: 1, capacityExit: { holdStdoutMs } });
        } else {
          const fake = installFakeGrok(ctx.bin, { capacityPrompts: 1, capacityExit: { holdStdoutMs } });
          ctx.env.GROK_BINARY = fake.binary;
          header = "backend: grok\nmodel: default\neffort: default";
        }
        const { id } = startJob(ctx, header, "Task");
        await finishJob(ctx, id);
        const job = readJob(ctx, id);
        assert.equal(job.state, "completed");
        assert.equal(job.automaticResumes?.length, 1);
        assert.equal(job.automaticResumes[0].reason, "app-server");
        assert.equal(job.capacityRetries.length, 1);
        // Grok never started the rejected brief, so it still runs once after the recovery.
        assert.equal(job.attempts.length, backend === "codex" ? 1 : 2);
        assert.equal(job.attempts[0].servers[0].code, 17);
        const first = job.attempts[0].servers[0];
        // The end is recorded without waiting for the child to release stdout.
        assert.ok(Date.parse(first.endedAt) - Date.parse(first.startedAt) < 3000, `${first.startedAt} to ${first.endedAt}`);
        assert.equal(job.attempts[0].servers.length, 2);
      });
    }
  }

  test("Codex, Grok, ZCode and Kimi end messages keep the partial-line byte count", () => {
    const end = { code: 17, pid: 42, partialStdoutBytes: 123 };
    for (const [name, message] of [["codex", serverEndMessage], ["grok", grokEndMessage], ["zcode", zcodeEndMessage], ["kimi", kimiEndMessage]]) {
      assert.match(message(end), /output ended mid-line after 123 bytes/, name);
      assert.doesNotMatch(message({ ...end, partialStdoutBytes: 0 }), /mid-line/, name);
    }
    assert.match(grokEndMessage({ ...end, stderrTail: "tail\n" }), /after 123 bytes\.\ntail$/);
    assert.match(zcodeEndMessage({ ...end, stderrTail: "tail\n" }), /after 123 bytes\.\ntail$/);
    assert.match(kimiEndMessage({ ...end, stderrTail: "tail\n" }), /after 123 bytes\.\ntail$/);
  });
}

// Bounded pipe draining
{

  // The server end stays bounded by the drain whichever pipe a child holds.
  // A retry that meets the exited client waits for the completed end record.

  // A job whose first server fails a turn and exits, leaving `child` behind (see leaveChild).
  function dyingServer(t, backend, child, { delays = "500", turnMs = 10000 } = {}) {
    const ctx = setup(t, { env: { RELAY_JOBS_CAPACITY_DELAYS_MS: delays } });
    if (backend === "codex") {
      installFakeCodex(ctx.bin, "job-capacity", { turnMs, capacityFailures: 1, capacityExit: child });
      return { ctx, header: HEADER };
    }
    const fake = installFakeGrok(ctx.bin, { turnMs, capacityPrompts: 1, capacityExit: child });
    ctx.env.GROK_BINARY = fake.binary;
    return { ctx, header: "backend: grok\nmodel: default\neffort: default" };
  }

  test("a server end is recorded within the drain when a child holds only stderr", async () => {
    const dir = makeTempDir("stderr-drain-");
    const binary = path.join(dir, "server");
    writeExecutable(binary, `#!/usr/bin/env node
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n');
    if (m.method === 'die') {
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], { stdio: ['ignore', 'ignore', 2] }).unref();
      setTimeout(() => process.exit(17), 10);
    }
  });
  `);
    const client = new SpawnedServerClient(dir, { binary, args: [], initializeParams: {} });
    await client.initialize();
    await client.request("die", {});
    await waitFor(() => client.exitSeen);
    const ended = await Promise.race([client.exitPromise.then(() => "ended"), delay(1500).then(() => "pending")]);
    assert.equal(ended, "ended", "the end waited for the child holding stderr");
    assert.ok(client.exitInfo.endedAt);
    assert.equal(client.exitInfo.code, 17);
    await client.close();
  });

  for (const backend of ["codex", "grok"]) {
    test(`${backend}: recovery starts before a child holding only stderr exits`, async t => {
      const { ctx, header } = dyingServer(t, backend, { holdStdoutMs: 3500, pipes: "stderr" }, { delays: "300", turnMs: 50 });
      const { id } = startJob(ctx, header, "Task");
      await waitFor(() => readJob(ctx, id).capacityRetries?.length === 1);
      const retried = Date.now();
      await waitFor(() => readJob(ctx, id).automaticResumes?.length === 1, 2500);
      assert.ok(Date.now() - retried < 2500);
      await finishJob(ctx, id);
      assert.equal(readJob(ctx, id).state, "completed");
    });

    test(`${backend}: a retry that meets the exited client before the drain ends waits for the end record and recovers`, async t => {
      const { ctx, header } = dyingServer(t, backend, { holdStdoutMs: 5000 }, { delays: "50", turnMs: 50 });
      const { id } = startJob(ctx, header, "Task");
      await finishJob(ctx, id);
      const job = readJob(ctx, id);
      assert.equal(job.state, "completed");
      assert.equal(job.automaticResumes?.length, 1);
      assert.ok(job.attempts[0].servers[0].endedAt);
    });
  }

  test("the drain after a server exits is 200 ms and closes both pipes, whichever reached EOF first", () => {
    for (const stdoutEnded of [false, true]) {
      const client = new SpawnedServerClient("/tmp");
      const scheduled = [];
      client.setTimer = (callback, ms) => { scheduled.push({ callback, ms }); return null; };
      const destroyed = [];
      client.proc = { stdout: { destroy: () => destroyed.push("stdout") }, stderr: { destroy: () => destroyed.push("stderr") } };
      client.transportEnded = stdoutEnded;
      client.lineBytes = stdoutEnded ? 0 : Buffer.byteLength('{"partial":');
      client.handleProcessExit(17, null);
      assert.equal(client.exitSeen, true);
      assert.deepEqual(scheduled.map(entry => entry.ms), [200]);
      assert.deepEqual(destroyed, [], "nothing closes before the drain time");
      scheduled[0].callback();
      assert.deepEqual(destroyed.sort(), ["stderr", "stdout"]);
      if (!stdoutEnded) assert.equal(client.partialStdoutBytes, Buffer.byteLength('{"partial":'));
    }
  });
}

// Process death and recovery
{
  const waitFor = waitForForAppserverdeath;

  function start(ctx, extra = []) {
    const brief = path.join(ctx.work, "brief.md");
    fs.writeFileSync(brief, "First task");
    const result = companion(ctx, ["start", "--model", "gpt-test", "--effort", "low", "--brief-file", brief, ...extra]);
    assert.equal(result.status, 0, result.stderr);
    return /^job: (\S+)$/m.exec(result.stdout)[1];
  }
  async function finish(ctx, id) {
    await waitFor(() => ["completed", "failed", "cancelled"].includes(readJobJson(ctx, id).state) && !readJobJson(ctx, id).server, { timeoutMs: 15000 });
    return readJobJson(ctx, id);
  }

  for (const kind of ["zero", "kill", "partial"]) {
    test(`app-server ${kind}: end records, one recovery and original settings`, async () => {
      const ctx = relayContext("job", { turnMs: 50, env: { FAKE_CODEX_DEATH_KIND: kind } });
      // The fast tier is off unless the user config allows it; allowed, the tier is a setting to keep.
      fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "allowed" }));
      const id = start(ctx, ["--mode", "write", "--network", "true", "--web-search", "cached", "--fast", "--add-dir", ctx.binDir]);
      await waitFor(() => readJobJson(ctx, id).server);
      const live = readJobJson(ctx, id);
      assert.equal(live.serverPid, live.attempts[0].servers[0].pid);
      assert.ok(live.attempts[0].servers[0].startTime);
      assert.ok(live.attempts[0].servers[0].startedAt);
      const job = await finish(ctx, id);
      assert.equal(job.state, "completed");
      assert.equal(job.attempts.length, 1);
      assert.equal(job.attempts[0].servers.length, 2);
      const [end, normal] = job.attempts[0].servers;
      assert.equal(end.code, kind === "kill" ? null : 0);
      assert.equal(end.signal, kind === "kill" ? "SIGKILL" : null);
      assert.equal(typeof end.stdoutClosedBeforeExit, "boolean");
      assert.match(end.stderrTail, /stderr-tail-/);
      assert.ok(normal.endedAt);
      assert.equal(isWorkerAlive(end), false);
      assert.equal(isWorkerAlive(normal), false);
      if (kind === "partial") {
        assert.equal(end.stdoutClosedBeforeExit, true);
        assert.equal(end.partialStdoutBytes, Buffer.byteLength('{"method":"item/completed","text":"' + "界".repeat(1000)));
        assert.match(job.attempts[0].transportErrors[0], /output ended mid-line after 3035 bytes/);
        assert.doesNotMatch(job.attempts[0].transportErrors[0], /parse|JSON/);
      }
      const log = fs.readFileSync(path.join(jobDirOf(ctx, id), "server.stderr.log"), "utf8");
      assert.match(log, /attempt 1, app-server 1/);
      assert.match(log, /attempt 1, app-server 2/);
      assert.match(log, /stderr-tail-/);
      const state = ctx.fakeState();
      assert.equal(state.threadStarts[0].serviceTier, "priority");
      for (const key of ["cwd", "model", "sandbox", "approvalPolicy", "serviceTier", "config"]) {
        assert.deepEqual(state.threadResumes[0][key], state.threadStarts[0][key], key);
      }
      for (const key of ["model", "effort", "serviceTier", "sandboxPolicy", "approvalPolicy"]) {
        assert.deepEqual(state.turnStarts[1][key], state.turnStarts[0][key], key);
      }
      assert.equal(state.turnStarts[1].prompt, DEFAULT_RESUME_MESSAGE);
      const status = JSON.parse(companion(ctx, ["status", id, "--json"]).stdout);
      assert.deepEqual(status.attemptRecords, job.attempts);
      assert.equal(status.automaticResumes[0].reason, "app-server");
      assert.match(companion(ctx, ["result", id]).stdout, /automatic-resume:.*\(app-server\)/);
    });
  }

  test("second app-server death fails with both ends and bounded stderr tail", async () => {
    const ctx = relayContext("job", { env: { FAKE_CODEX_DEATH_KIND: "kill", FAKE_CODEX_DEATH_COUNT: "2", FAKE_CODEX_STDERR_BYTES: "1300000" } });
    const id = start(ctx);
    const job = await finish(ctx, id);
    assert.equal(job.state, "failed");
    assert.equal(job.automaticResumes.length, 1);
    assert.equal(job.attempts[0].servers.length, 2);
    assert.equal(job.attempts[0].transportErrors.length, 2);
    assert.equal((job.errorMessage.match(/SIGKILL/g) ?? []).length, 2);
    assert.match(companion(ctx, ["result", id]).stdout, /^error:.*signal SIGKILL/m);
    for (const end of job.attempts[0].servers) {
      assert.equal(Buffer.byteLength(end.stderrTail), 4096);
      assert.match(end.stderrTail, /stderr-tail-/);
      assert.equal(isWorkerAlive(end), false);
    }
    const log = fs.readFileSync(path.join(jobDirOf(ctx, id), "server.stderr.log"));
    assert.equal(log.length, 1024 * 1024);
    assert.match(log.toString(), /stderr-tail-/);
  });

  test("death during thread resume records partial bytes and exit details", async () => {
    const ctx = relayContext("job", { turnMs: 50 });
    const id = start(ctx);
    const first = await finish(ctx, id);
    // The changed environment belongs to a new worker. A warm worker can still take
    // a continue after publishing its terminal state, while its backend is closing.
    await waitFor(() => !isWorkerAlive(first.worker), { timeoutMs: 15000 });
    ctx.env.FAKE_CODEX_RESUME_PARTIAL = "9";
    assert.equal(companion(ctx, ["continue", id, "--message", "Next task"]).status, 0);
    const job = await finish(ctx, id);
    assert.equal(job.state, "failed");
    const attempt = job.attempts[1];
    assert.equal(attempt.servers.length, 2);
    assert.ok(attempt.servers.every(end => end.code === 0 && end.partialStdoutBytes > 300000));
    assert.equal(attempt.transportErrors.length, 2);
    assert.match(job.errorMessage, /output ended mid-line after \d+ bytes/);
    assert.match(job.errorMessage, /exit 0/);
    assert.doesNotMatch(job.errorMessage, /parse|JSON/);
  });

  test("app-server recovery spends the dead-worker allowance", async () => {
    const ctx = relayContext("job", { turnMs: 30000, env: { FAKE_CODEX_DEATH_KIND: "zero" } });
    const id = start(ctx);
    await waitFor(() => readJobJson(ctx, id).automaticResumes?.length && readJobJson(ctx, id).turnId);
    const job = readJobJson(ctx, id);
    process.kill(job.worker.pid, "SIGKILL");
    await waitFor(() => !isWorkerAlive(job.worker));
    assert.equal(await resumeDeadJobOnce(jobDirOf(ctx, id), ctx.env), false);
    assert.equal(readJobJson(ctx, id).automaticResumes.length, 1);
    assert.equal(ctx.fakeState().appServerStarts, 2);
  });

  test("dead-worker recovery spends the app-server allowance", async () => {
    const ctx = relayContext("job", { turnMs: 30000 });
    const id = start(ctx);
    await waitFor(() => readJobJson(ctx, id).turnId);
    const job = readJobJson(ctx, id);
    process.kill(job.worker.pid, "SIGKILL");
    await waitFor(() => !isWorkerAlive(job.worker));
    ctx.env.FAKE_CODEX_DEATH_KIND = "kill";
    ctx.env.FAKE_CODEX_DEATH_COUNT = "9";
    assert.equal(await resumeDeadJobOnce(jobDirOf(ctx, id), ctx.env), true);
    const final = await finish(ctx, id);
    assert.equal(final.state, "failed");
    assert.equal(final.automaticResumes.length, 1);
    assert.equal(ctx.fakeState().appServerStarts, 2);
  });

  test("cancel prevents app-server recovery", async () => {
    const ctx = relayContext("job", { turnMs: 30000, env: { FAKE_CODEX_INTERRUPT_DEATH: "1" } });
    const id = start(ctx);
    await waitFor(() => readJobJson(ctx, id).turnId);
    companion(ctx, ["cancel", id]);
    const job = await finish(ctx, id);
    assert.equal(job.state, "cancelled");
    assert.equal(job.automaticResumes?.length ?? 0, 0);
    assert.ok(job.attempts[0].servers[0].endedAt);
    assert.equal(job.attempts[0].servers[0].signal, "SIGKILL");
    assert.equal(ctx.fakeState().appServerStarts, 1);
  });

  test("multi-megabyte resume and MCP lines remain intact", async (t) => {
    const ctx = relayContext("job", { turnMs: 50, env: { FAKE_CODEX_LARGE_LINES: "1" } });
    const id = start(ctx);
    await finish(ctx, id);
    const client = await CodexAppServerClient.connect(ctx.work, { env: ctx.env });
    t.after(() => client.close());
    // Keep a reader mutation bounded even when it drops the response's final newline.
    const deadline = setTimeout(() => void client.close(), 3000);
    let response;
    try { response = await client.request("thread/resume", { threadId: "thr_1", cwd: ctx.work }); }
    finally { clearTimeout(deadline); }
    assert.equal(response.thread.preview, "界😀".repeat(600000) + "resume-tail");
    const events = fs.readFileSync(path.join(jobDirOf(ctx, id), "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const mcp = events.find(event => event.params?.item?.id === "large-mcp");
    assert.equal(mcp.params.item.result.content[0].text, "界😀".repeat(600000) + "mcp-tail");
  });


  test("recovery keeps a continue owed when thread resume was cut off", async () => {
    const ctx = relayContext("job", { turnMs: 50 });
    const id = start(ctx);
    const first = await finish(ctx, id);
    await waitFor(() => !isWorkerAlive(first.worker), { timeoutMs: 15000 });
    ctx.env.FAKE_CODEX_RESUME_PARTIAL = "2";
    assert.equal(companion(ctx, ["continue", id, "--message", "Owed next task"]).status, 0);
    const job = await finish(ctx, id);
    assert.equal(job.state, "completed");
    assert.equal(job.attempts.length, 3);
    assert.equal(ctx.fakeState().turnStarts.filter(turn => turn.prompt === "Owed next task").length, 1);
    assert.match(companion(ctx, ["result", id]).stdout, /Report for: Owed next task/);
  });

  test("a delivered steer cannot allow a second app-server recovery in one attempt", async () => {
    const ctx = relayContext("job", { turnMs: 30000, env: { FAKE_CODEX_DEATH_KIND: "zero" } });
    const id = start(ctx);
    await waitFor(() => readJobJson(ctx, id).automaticResumes?.length && readJobJson(ctx, id).turnId);
    assert.equal(companion(ctx, ["steer", id, "--message", "User correction"]).status, 0);
    const job = readJobJson(ctx, id);
    process.kill(job.server.pid, "SIGKILL");
    const final = await finish(ctx, id);
    assert.equal(final.state, "failed");
    assert.equal(final.attempts[0].transportErrors.length, 2);
    assert.equal(final.automaticResumes.length, 1);
  });


  test("initialization death is recorded before connect returns", async () => {
    const ctx = relayContext("job", { env: { FAKE_CODEX_INIT_DEATH: "1" } });
    const id = start(ctx);
    const job = await finish(ctx, id);
    assert.equal(job.state, "failed");
    assert.equal(job.automaticResumes?.length ?? 0, 0);
    const end = job.attempts[0].servers[0];
    assert.ok(end.pid);
    assert.ok(end.startTime);
    assert.equal(end.code, 23);
    assert.equal(end.stderrTail, "initialization-stderr");
    assert.match(job.errorMessage, /exit 23/);
  });
}
