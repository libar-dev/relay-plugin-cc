import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveKimiHome } from "../plugins/relay/scripts/lib/backends/kimi/request.mjs";
import { kimiEventRecorder, resolveKimiBinary } from "../plugins/relay/scripts/lib/backends/kimi/connection.mjs";
import { KimiWire } from "../plugins/relay/scripts/lib/backends/kimi/wire.mjs";
import { KimiFileReads } from "../plugins/relay/scripts/lib/backends/kimi/files.mjs";
import { spawn, spawnSync } from "node:child_process";
import { buildLaunchRequest, parseHeaderPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { isWorkerAlive, readLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";
import { companion, finishJob, jobDir, promptFile, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { makeTempDir } from "./support/helpers.mjs";
import { installFakeKimi } from "./fakes/kimi.mjs";

const HEADER = "backend: kimi\nmodel: kimi-code/k3\neffort: low";

function fixture(t, options = {}) {
  const ctx = setup(t);
  const fake = installFakeKimi(ctx.bin, options);
  ctx.env.KIMI_BINARY = fake.binary;
  ctx.env.RELAY_JOBS_KIMI_POLL_MS = "20";
  ctx.env.RELAY_JOBS_KIMI_SETTLE_MS = "400";
  // Inherited from the caller's shell: a job must not take its model or effort from these.
  ctx.env.KIMI_MODEL_NAME = "inherited-model";
  ctx.env.KIMI_MODEL_THINKING_EFFORT = "max";
  // ... nor trust the working directory, which would load the repository's MCP servers.
  ctx.env.KIMI_CODE_TRUST_WORKSPACE = "1";
  ctx.kimi = fake.state;
  return ctx;
}

const requests = (ctx, method) => ctx.kimi().requests.filter(r => r.method === method);
const answer = (ctx, method) => ctx.kimi().answers.filter(a => a.method === method);
const report = (ctx, id) => fs.readFileSync(path.join(jobDir(ctx, id), "report.md"), "utf8");
const events = (ctx, id) => fs.readFileSync(path.join(jobDir(ctx, id), "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

test("header, home selection and refused combinations fail before launch", t => {
  const ctx = fixture(t);
  for (const extra of ["mode: write", "web-search: cached", "web-search: disabled", "web-search: indexed", "grok-home: jobs"]) {
    const result = companion(ctx, ["start", "--prompt-file", promptFile(ctx, `${HEADER}\n${extra}`)]);
    assert.equal(result.status, 1, `${extra}: ${result.stdout}`);
  }
  assert.match(companion(ctx, ["start", "--prompt-file", promptFile(ctx, `${HEADER}\nmode: write`)]).stderr, /mode: write is not supported for Kimi: it has no workspace sandbox/);
  assert.match(companion(ctx, ["start", "--prompt-file", promptFile(ctx, `${HEADER}\nweb-search: disabled`)]).stderr, /ACP cannot remove Kimi's web tools/);
  assert.equal(ctx.kimi().starts.length, 0, "no refused header starts kimi");
  assert.throws(() => buildLaunchRequest({ model: "default", effort: "default", kimiHome: "default" }), /kimi-home is only valid with backend: kimi/);
  assert.throws(() => buildLaunchRequest({ model: "default", effort: "default", backend: "kimi", kimiHome: "Bad Name" }), /kimi-home must be/);
  assert.throws(() => buildLaunchRequest({ backend: "kimi", effort: "low" }), /model is required. Use `model: default` to use Kimi's own default/);
  assert.equal(resolveKimiHome("jobs", ctx.env), path.join(ctx.user, ".kimi-code-jobs"));
  assert.equal(resolveKimiHome("default", ctx.env), path.join(ctx.user, ".kimi-code"));
  assert.equal(resolveKimiHome("~/custom", ctx.env), path.join(ctx.user, "custom"));
  assert.equal(resolveKimiHome(ctx.work, ctx.env), ctx.work);
  assert.equal(parseHeaderPrompt(`${HEADER}\nkimi-home: jobs\n---\nx`).header.kimiHome, "jobs");
  const request = buildLaunchRequest({ backend: "kimi", model: "default", effort: "default", fast: "true", mode: "read-only", network: "true" }, { env: ctx.env });
  assert.equal(request.model, null);
  assert.equal(request.effort, null);
  assert.equal(request.fast, false);
  assert.ok(request.notes.includes("fast: true is ignored for Kimi; it is an OpenAI service tier."));
  assert.ok(request.notes.some(note => /Kimi has no sandbox/.test(note)));
});

test("a turn's report and outcome come from the session record; the server starts isolated, and home, mode and model survive continue and resume", async t => {
  const ctx = fixture(t, { tools: true });
  const { id, start } = startJob(ctx, `${HEADER}\nkimi-home: jobs\nfast: true`, "[quick] First.");
  assert.match(start, /^backend: kimi$/m);
  assert.match(start, /^kimi-home: .*\.kimi-code-jobs$/m);
  await finishJob(ctx, id);
  // The text after the last tool call, as Kimi recorded it, not the ACP stream's chunks.
  assert.equal(report(ctx, id), "Report for: [quick] First.\n");
  for (const command of ["continue", "resume"]) {
    assert.equal(companion(ctx, [command, id, "--message", `[quick] ${command}.`], { KIMI_CODE_HOME: "/ignored" }).status, 0);
    await finishJob(ctx, id);
  }
  assert.equal(report(ctx, id), "Report for: [quick] resume.\n");
  const state = ctx.kimi();
  const home = path.join(ctx.user, ".kimi-code-jobs");
  assert.equal(state.starts.length, 3);
  for (const start of state.starts) {
    assert.deepEqual(start.args, ["acp"]);
    assert.equal(start.cwd, fs.realpathSync(ctx.work));
    assert.equal(start.env.KIMI_CODE_HOME, home);
    assert.equal(start.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
    assert.equal(start.env.KIMI_DISABLE_CRON, "1");
    assert.deepEqual(Object.keys(start.env).filter(name => name.startsWith("KIMI_MODEL_")), []);
    assert.equal(start.env.KIMI_CODE_TRUST_WORKSPACE, undefined);
  }
  assert.deepEqual(requests(ctx, "initialize").map(r => r.params), Array(3).fill({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "relay-plugin", version: "1" } }));
  assert.deepEqual(requests(ctx, "session/new").map(r => r.params), [{ cwd: fs.realpathSync(ctx.work), mcpServers: [] }]);
  assert.deepEqual(requests(ctx, "session/load").map(r => r.params.sessionId), [readJob(ctx, id).sessionId, readJob(ctx, id).sessionId]);
  assert.ok(requests(ctx, "session/load").every(r => r.params.mcpServers.length === 0));
  // Kimi forgets the mode on a load, so every open sets mode, model and effort again.
  assert.deepEqual(requests(ctx, "session/set_mode").map(r => r.params.modeId), ["auto", "auto", "auto"]);
  assert.deepEqual(requests(ctx, "session/set_config_option").map(r => [r.params.configId, r.params.value]), Array.from({ length: 3 }, () => [["model", "kimi-code/k3"], ["thinking", "low"]]).flat());
  // One text block when the prompt does not start with `/`.
  assert.ok(requests(ctx, "session/prompt").every(r => r.params.prompt.length === 1));
  const saved = readJob(ctx, id);
  assert.equal(saved.backendState.binary, fs.realpathSync(ctx.env.KIMI_BINARY));
  assert.equal(Object.keys(saved.backendState.deliveries).length, 3);
  assert.equal(saved.turnId, state.turns.at(-1).promptId);
  const json = JSON.parse(companion(ctx, ["result", id, "--json"]).stdout);
  assert.equal(json.backend, "kimi");
  assert.equal(json.kimiHome, home);
  // Events: chunks joined, running tool updates and command lists left out.
  const recorded = events(ctx, id);
  assert.equal(recorded.filter(e => e.params?.update?.sessionUpdate === "available_commands_update").length, 0);
  assert.deepEqual(recorded.filter(e => e.params?.update?.sessionUpdate === "tool_call_update").map(e => e.params.update.status), ["completed", "completed", "completed"]);
  assert.deepEqual(recorded.filter(e => e.params?.update?.sessionUpdate === "agent_message_chunk").map(e => e.params.update.content.text), ["Report for: [quick] First.", "Report for: [quick] continue.", "Report for: [quick] resume."]);
  // The session went to the scratch HOME, never to a real ~/.kimi-code.
  assert.ok(fs.existsSync(path.join(home, "sessions")));
});

test("a turn's last updates reach the events, though the worker reads the record's end first", async t => {
  // Kimi sends the report's chunks, then records the end. A worker descheduled meanwhile finds
  // both waiting, and its poll of the record ends the turn before it has read the chunks.
  const ctx = fixture(t, { pauseClientAtEnd: 200 });
  const { id } = startJob(ctx, HEADER, "[quick] Paused.");
  await finishJob(ctx, id);
  assert.equal(report(ctx, id), "Report for: [quick] Paused.\n");
  assert.deepEqual(events(ctx, id).filter(e => e.params?.update?.sessionUpdate === "agent_message_chunk").map(e => e.params.update.content.text), ["Report for: [quick] Paused."]);
});

test("a failed turn fails the job with Kimi's error, though ACP answered end_turn", async t => {
  const ctx = fixture(t, { failTurn: true });
  const { id } = startJob(ctx, HEADER, "[quick] Fail.");
  const end = await finishJob(ctx, id, 3);
  assert.equal(readJob(ctx, id).state, "failed");
  assert.equal(readJob(ctx, id).errorMessage, "[provider.connection_error] Connection error.");
  assert.match(end.stdout, /^error: \[provider\.connection_error\] Connection error\.$/m);
  assert.ok(ctx.kimi().requests.some(r => r.result === undefined && r.method === "session/prompt"));
  // Kimi retries model calls itself: the worker never sends the prompt again.
  assert.equal(requests(ctx, "session/prompt").length, 1);
  assert.equal(readJob(ctx, id).capacityRetries ?? undefined, undefined);
});

test("a request-rate failure is not retried by the worker: Kimi retries model calls itself", async t => {
  const ctx = fixture(t, { failTurn: true, failError: { code: "provider.rate_limit", message: "Rate limit reached for requests", retryable: true } });
  ctx.env.RELAY_JOBS_CAPACITY_DELAYS_MS = "1";
  const { id } = startJob(ctx, HEADER, "[quick] Limited.");
  await finishJob(ctx, id, 3);
  assert.equal(readJob(ctx, id).errorMessage, "[provider.rate_limit] Rate limit reached for requests");
  assert.equal(requests(ctx, "session/prompt").length, 1);
  assert.deepEqual(readJob(ctx, id).capacityRetries ?? [], []);
});

test("a prompt Kimi accepted but never shows starting fails after the idle grace: the server ends, and the prompt is dropped, never sent again", async t => {
  const ctx = fixture(t, { noRecord: true });
  const { id } = startJob(ctx, HEADER, "[quick] Lost.");
  await finishJob(ctx, id, 3);
  const unconfirmed = /^Kimi accepted the message \(ACP answered end_turn\), but its session record shows no start for it after 0\.4 s with no turn running \(.*wire\.jsonl\)\. Relay ended Kimi's server and does not send the message again\.$/;
  let job = readJob(ctx, id);
  assert.equal(job.state, "failed");
  assert.match(job.errorMessage, unconfirmed);
  assert.equal(job.pendingFirstTurn, false, "the brief is not owed again");
  assert.ok(job.backendState.deliveries[`brief-${id}`], "its delivery record is kept");
  assert.equal(job.automaticResumes ?? undefined, undefined);
  // A message's outcome says so; it never runs again, and nothing more went to that server.
  const sent = companion(ctx, ["continue", id, "--message", "[quick] Also lost."]);
  assert.equal(sent.status, 0, sent.stderr);
  await finishJob(ctx, id, 3);
  job = readJob(ctx, id);
  const message = job.messages.find(entry => entry.action === "dropped");
  assert.match(message.reason, unconfirmed);
  assert.deepEqual(requests(ctx, "session/prompt").map(r => r.params.prompt.at(-1).text), ["[quick] Lost.", "[quick] Also lost."]);
  assert.equal(ctx.kimi().starts.length, 2, "one server per send");
  assert.match(companion(ctx, ["status", id]).stdout, /dropped/);
});

const STOP_AFTER_TEARDOWN = new URL("./support/stop-after-teardown.cjs", import.meta.url).pathname;

// The worker gives up on a prompt Kimi never shows starting; it dies right after one of the
// writes that record that, and a resume follows. Whichever write it reached, the prompt is
// never sent again, and the job's accounting says why.
for (const source of ["brief", "continue"]) {
  test(`a teardown survives a worker killed after any of its writes (${source}): dropped, not owed, its delivery record kept, sent once`, async t => {
    const text = "[quick] Never resend this.";
    const killed = [];
    for (const after of [0, 1, 2, 3]) {
      const ctx = fixture(t, { noRecord: source === "brief" ? 1 : 2 });
      const marker = path.join(ctx.root, `stopped-${after}`);
      const stop = { NODE_OPTIONS: `--require=${STOP_AFTER_TEARDOWN}`, RELAY_TEST_STOP_FILE: marker, RELAY_TEST_STOP_AFTER: String(after), RELAY_TEST_STOP_WHEN: "Kimi accepted the message" };
      let id;
      if (source === "brief") {
        Object.assign(ctx.env, stop);
        ({ id } = startJob(ctx, HEADER, text));
      } else {
        ({ id } = startJob(ctx, HEADER, "[quick] First."));
        await finishJob(ctx, id);
        Object.assign(ctx.env, stop);
        assert.equal(companion(ctx, ["continue", id, "--message", text]).status, 0);
      }
      // Stopped right after that write, or, where fewer writes follow, ended on its own.
      await waitFor(() => fs.existsSync(marker) || (readJob(ctx, id).state === "failed" && !readLease(jobDir(ctx, id))));
      if (fs.existsSync(marker)) {
        killed.push(after);
        const { pid } = JSON.parse(fs.readFileSync(marker, "utf8"));
        process.kill(pid, "SIGKILL");
        await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      }
      for (const name of Object.keys(stop)) delete ctx.env[name];
      assert.equal(companion(ctx, ["resume", id, "--message", "[quick] Resume."]).status, 0);
      await finishJob(ctx, id);
      const what = `${source}, killed after write ${after}`;
      assert.equal(sentWith(ctx, text), 1, `${what}: sent once`);
      const job = readJob(ctx, id);
      assert.equal(job.state, "completed", what);
      assert.equal(report(ctx, id), "Report for: [quick] Resume.\n", what);
      const failed = job.attempts.filter(attempt => attempt.teardown);
      assert.equal(failed.length, 1, what);
      assert.equal(failed[0].state, "failed", what);
      assert.match(failed[0].errorMessage, /^Kimi accepted the message/, what);
      assert.equal(failed[0].teardown.source, source, what);
      assert.equal(job.backendState.deliveries[failed[0].teardown.clientId].text, text, `${what}: the delivery record stays`);
      if (source === "brief") {
        assert.equal(failed[0].teardown.clientId, `brief-${id}`, what);
        assert.equal(job.pendingFirstTurn, false, what);
      } else {
        const messageId = failed[0].teardown.messageId;
        assert.equal(readOutcome(jobDir(ctx, id), messageId).action, "dropped", what);
        assert.equal(job.messages.filter(entry => entry.id === messageId && entry.action === "dropped").length, 1, what);
      }
    }
    // The failed attempt's write, and each write after it up to the round's end, was a kill point.
    assert.deepEqual(killed, [0, 1, 2, 3]);
  });
}

test("a steer runs as the next turn: nothing is sent while a turn runs", async t => {
  const ctx = fixture(t, { turnMs: 600 });
  const { id } = startJob(ctx, HEADER, "First.");
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).turnId);
  const message = postInboxMessage(dir, { kind: "steer", text: "[quick] Mid-turn." });
  const outcome = await waitFor(() => readOutcome(dir, message.id));
  assert.equal(outcome.action, "queued-next-turn");
  assert.match(outcome.reason, /Kimi takes no message during a running turn/);
  await finishJob(ctx, id);
  assert.equal(ctx.kimi().busyRefusals ?? 0, 0, "no prompt reached Kimi while its turn ran");
  assert.deepEqual(ctx.kimi().turns.map(turn => turn.text), ["First.", "[quick] Mid-turn."]);
  assert.equal(readOutcome(dir, message.id).action, "turn-started");
  assert.equal(report(ctx, id), "Report for: [quick] Mid-turn.\n");
  // After the end, a steer starts the next turn too.
  assert.equal(companion(ctx, ["steer", id, "--message", "[quick] After."]).status, 0);
  await finishJob(ctx, id);
  assert.equal(ctx.kimi().turns.at(-1).text, "[quick] After.");
});

test("cancel sends session/cancel and the job ends cancelled", async t => {
  const ctx = fixture(t, { turnMs: 30000 });
  const { id } = startJob(ctx, HEADER, "Wait.");
  await waitFor(() => readJob(ctx, id).turnId);
  companion(ctx, ["cancel", id]);
  await finishJob(ctx, id, 5);
  assert.equal(readJob(ctx, id).state, "cancelled");
  const cancel = requests(ctx, "session/cancel");
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0].id, undefined, "a notification");
  assert.equal(cancel[0].params.sessionId, readJob(ctx, id).sessionId);
  assert.deepEqual(ctx.kimi().completed, [{ text: "Wait.", reason: "cancelled" }]);
});

test("a server that dies after Kimi recorded the brief is resumed once and the brief does not run again", async t => {
  const ctx = fixture(t, { dieAfterRecord: true, turnMs: 50 });
  // The worker reads the record slowly, so it dies before it sees the turn start: the brief
  // stays owed, and the record alone says it arrived.
  ctx.env.RELAY_JOBS_KIMI_POLL_MS = "3000";
  const { id } = startJob(ctx, HEADER, "Run once.");
  await finishJob(ctx, id);
  const job = readJob(ctx, id);
  assert.equal(job.state, "completed");
  assert.equal(job.automaticResumes.length, 1);
  assert.equal(requests(ctx, "session/load").length, 1);
  assert.equal(ctx.kimi().turns.filter(turn => turn.text === "Run once.").length, 1, "the brief reached the session once");
  assert.match(report(ctx, id), /^Report for: Your session was cut off\./);
  assert.match(job.transportErrors?.[0] ?? job.attempts.at(-1).transportErrors?.[0] ?? JSON.stringify(job), /kimi acp ended before the turn finished \(exit 17\)/);
});

test("a server that dies before Kimi recorded the brief sends it again, once", async t => {
  const ctx = fixture(t, { dieBeforeRecord: true, turnMs: 50 });
  ctx.env.RELAY_JOBS_KIMI_POLL_MS = "3000";
  const { id } = startJob(ctx, HEADER, "Run me.");
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(ctx.kimi().turns.filter(turn => turn.text === "Run me.").length, 1);
  assert.equal(report(ctx, id), "Report for: Run me.\n");
});

const sentWith = (ctx, text) => requests(ctx, "session/prompt").filter(r => r.params.prompt.at(-1).text === text).length;

test("a server that dies after Kimi committed the brief's input, before a turn started for it, is resumed once and the brief is not sent again", async t => {
  const ctx = fixture(t, { dieAfterInput: true, turnMs: 50 });
  const { id } = startJob(ctx, HEADER, "Run once.");
  await finishJob(ctx, id);
  const job = readJob(ctx, id);
  assert.equal(job.state, "completed");
  assert.equal(job.automaticResumes.length, 1);
  assert.equal(sentWith(ctx, "Run once."), 1, "the input record alone says it arrived");
  assert.match(report(ctx, id), /^Report for: Your session was cut off\./);
});

test("a prompt Kimi's hooks put text in front of is still the prompt: its turn, its report, and its record after a death", async t => {
  const ctx = fixture(t, { hookText: "<hook>branch: main</hook>" });
  const { id } = startJob(ctx, HEADER, "[quick] Hooked.");
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(report(ctx, id), "Report for: [quick] Hooked.\n");
  assert.equal(readJob(ctx, id).turnId, ctx.kimi().turns[0].promptId);
  const dies = fixture(t, { hookText: "<hook>branch: main</hook>", dieAfterInput: true, turnMs: 50 });
  const job = startJob(dies, HEADER, "Hooked once.");
  await finishJob(dies, job.id);
  assert.equal(sentWith(dies, "Hooked once."), 1);
});

test("a hook part never stands in for a prompt: a brief lost with its server runs once, though the recovery prompt's hook text equals it", async t => {
  // The server dies before Kimi records the brief. Kimi's hook puts the same text, marked as the
  // hook's, in front of the recovery prompt; that prompt is not the brief's delivery.
  const ctx = fixture(t, { dieBeforeRecord: true, hookText: "Run tests.", turnMs: 50 });
  const { id } = startJob(ctx, HEADER, "Run tests.");
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(ctx.kimi().turns.filter(turn => turn.text === "Run tests.").length, 1, "the brief ran once");
  assert.equal(sentWith(ctx, "Run tests."), 2, "sent again after the death, as it never reached Kimi");
});

test("two identical messages both run; after a death, each one's own record decides whether it arrived", async t => {
  // The second copy reached Kimi's record before its server died: it is not sent a third time.
  const kept = fixture(t, { dieAfterInput: 2, turnMs: 50 });
  const first = startJob(kept, HEADER, "[quick] Same.");
  await finishJob(kept, first.id);
  assert.equal(companion(kept, ["continue", first.id, "--message", "[quick] Same."]).status, 0);
  await finishJob(kept, first.id);
  assert.equal(sentWith(kept, "[quick] Same."), 2);
  assert.equal(readJob(kept, first.id).automaticResumes.length, 1);
  // The second copy's server died before Kimi recorded it: the first copy does not count for it.
  const lost = fixture(t, { dieBeforeRecord: 2, turnMs: 50 });
  const second = startJob(lost, HEADER, "[quick] Same.");
  await finishJob(lost, second.id);
  assert.equal(companion(lost, ["continue", second.id, "--message", "[quick] Same."]).status, 0);
  await finishJob(lost, second.id);
  assert.equal(sentWith(lost, "[quick] Same."), 3);
  assert.deepEqual(lost.kimi().turns.map(turn => turn.text).filter(text => text === "[quick] Same."), ["[quick] Same.", "[quick] Same."], "both ran");
  assert.equal(report(lost, second.id), "Report for: [quick] Same.\n");
});

test("a queued prompt that a UserPromptSubmit hook blocks fails the job at once with that reason, and is not sent again", async t => {
  const ctx = fixture(t, { ownTurnAfterMs: 1, ownTurnMs: 600, turnMs: 400, blockQueued: true });
  ctx.env.RELAY_JOBS_KIMI_SETTLE_MS = "10000";
  const { id } = startJob(ctx, HEADER, "First.");
  await waitFor(() => readJob(ctx, id).turnId);
  postInboxMessage(jobDir(ctx, id), { kind: "steer", text: "[quick] Next." });
  const started = Date.now();
  await finishJob(ctx, id, 3);
  assert.ok(Date.now() - started < 8000, "the record's verdict, not the grace, ended it");
  const job = readJob(ctx, id);
  assert.equal(job.state, "failed");
  assert.match(job.errorMessage, /^Kimi did not run the message: a UserPromptSubmit hook blocked it\. The hooks are the Kimi home's \(.*\.kimi-code\)\.$/);
  assert.equal(ctx.kimi().blocked, 1);
  assert.equal(sentWith(ctx, "[quick] Next."), 1);
});

test("a worker killed after Kimi recorded the brief is resumed without a second copy", async t => {
  // Kimi records the brief only once the test creates `release`, and the worker is stopped
  // before that: it cannot read the record, however often it polls.
  const release = path.join(makeTempDir("relay-kimi-record-"), "release");
  const ctx = fixture(t, { turnMs: 6000, recordAfter: release });
  const { id } = startJob(ctx, HEADER, "Keep going.");
  await waitFor(() => requests(ctx, "session/prompt").length === 1 && readJob(ctx, id).serverPid);
  const { serverPid, worker } = readJob(ctx, id);
  process.kill(worker.pid, "SIGSTOP");
  let pending;
  try {
    fs.writeFileSync(release, "");
    await waitFor(() => ctx.kimi().recorded);
    pending = readJob(ctx, id).pendingFirstTurn;
  } finally {
    process.kill(serverPid, "SIGKILL");
    process.kill(worker.pid, "SIGKILL");
  }
  // Kimi has recorded the brief; the worker has not seen it.
  assert.equal(pending, true);
  await waitFor(() => companion(ctx, ["status", id]).stdout.includes("state: dead"));
  assert.equal(companion(ctx, ["resume", id]).status, 0);
  await finishJob(ctx, id);
  assert.equal(ctx.kimi().turns.filter(turn => turn.text === "Keep going.").length, 1);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(readJob(ctx, id).pendingFirstTurn, false);
});

test("modes: yolo is Kimi's auto and allows; read-only is default, rejects, and refuses every write and command sent to the client", async t => {
  for (const mode of ["yolo", "read-only"]) {
    const ctx = fixture(t, { permission: true, writes: true });
    const { id } = startJob(ctx, `${HEADER}\nmode: ${mode}`, "[quick] Mode.");
    await finishJob(ctx, id);
    assert.deepEqual(requests(ctx, "session/set_mode").map(r => r.params.modeId), [mode === "yolo" ? "auto" : "default"]);
    const caps = requests(ctx, "initialize")[0].params.clientCapabilities;
    assert.deepEqual(caps, mode === "yolo" ? { fs: { readTextFile: false, writeTextFile: false }, terminal: false } : { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    assert.deepEqual(answer(ctx, "session/request_permission").map(a => a.result.outcome), [{ outcome: "selected", optionId: mode === "yolo" ? "approve_once" : "reject" }]);
    if (mode === "read-only") {
      assert.deepEqual(answer(ctx, "fs/write_text_file").map(a => a.error), [{ code: -32000, message: "This job is read-only: file writes are refused." }]);
      assert.deepEqual(answer(ctx, "terminal/create").map(a => a.error), [{ code: -32000, message: "This job is read-only: shell commands are refused." }]);
      assert.ok(!fs.existsSync(path.join(ctx.work, "notes.txt")));
      assert.deepEqual(events(ctx, id).filter(e => e.method === "kimi/readOnlyRefused").map(e => e.params.method), ["fs/write_text_file", "terminal/create"]);
    } else {
      assert.equal(ctx.kimi().localWrites, 1, "yolo writes locally");
    }
  }
});

test("read-only serves Kimi's file reads and refuses its writes: an append, an overwrite and an edit leave the file as it was", async t => {
  const original = "original\nsecond\n";
  const fileOps = [["append", "notes.txt", "appended\n"], ["read", "notes.txt", { line: 2, limit: 1 }], ["write", "notes.txt", "overwritten\n"], ["edit", "notes.txt", "original", "edited"], ["append", "missing.txt", "x"]];
  for (const mode of ["read-only", "yolo"]) {
    const ctx = fixture(t, { fileOps });
    const notes = path.join(ctx.work, "notes.txt");
    fs.writeFileSync(notes, original);
    const { id } = startJob(ctx, `${HEADER}\nmode: ${mode}`, "[quick] Change the notes.");
    await finishJob(ctx, id);
    if (mode === "yolo") {
      // Kimi's own filesystem: every operation lands.
      assert.equal(fs.readFileSync(notes, "utf8"), "overwritten\n");
      assert.ok(fs.existsSync(path.join(ctx.work, "missing.txt")));
      continue;
    }
    assert.equal(fs.readFileSync(notes, "utf8"), original, "the file is unchanged");
    assert.ok(!fs.existsSync(path.join(ctx.work, "missing.txt")));
    assert.equal(ctx.kimi().localWrites ?? 0, 0, "nothing was written past the client");
    // The append and the edit read through relay first; every write is refused.
    assert.deepEqual(answer(ctx, "fs/read_text_file").map(a => a.result?.content ?? a.error.code), [original, "second\n", original, -32002]);
    assert.deepEqual(answer(ctx, "fs/write_text_file").map(a => a.error?.message), Array(4).fill("This job is read-only: file writes are refused."));
    assert.deepEqual(ctx.kimi().fileOps.map(op => op.error ?? op.content ?? "ok"), Array(1).fill("This job is read-only: file writes are refused.").concat(["second\n"], Array(3).fill("This job is read-only: file writes are refused.")));
  }
});

const readAnswers = ctx => answer(ctx, "fs/read_text_file").map(a => a.result?.content ?? `${a.error.code} ${a.error.message}`);

test("a read-only append to a FIFO is refused at once: after a server death and recovery the job completes and the worker exits", async t => {
  const ctx = fixture(t, { fileOps: [["append", "pipe", "x"]] });
  assert.equal(spawnSync("mkfifo", [path.join(ctx.work, "pipe")]).status, 0);
  const { id } = startJob(ctx, `${HEADER}\nmode: read-only`, "[long] Append to the pipe.");
  const worker = await waitFor(() => readJob(ctx, id).worker);
  t.after(() => { if (isWorkerAlive(worker)) process.kill(worker.pid, "SIGKILL"); });
  await waitFor(() => answer(ctx, "fs/read_text_file").length === 1);
  assert.match(readAnswers(ctx)[0], /^-32000 This job is read-only: relay serves only regular files, and .*\/pipe is a FIFO\.$/);
  process.kill(readJob(ctx, id).serverPid, "SIGKILL");
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(readJob(ctx, id).automaticResumes.length, 1);
  await waitFor(() => !isWorkerAlive(worker), 5000);
  assert.ok(events(ctx, id).some(e => e.method === "kimi/readOnlyRefused" && e.params.method === "fs/read_text_file"));
});

test("read-only reads are judged on the opened file: a symlink to a FIFO and an oversized file are refused, and line and limit are checked", async t => {
  const ctx = fixture(t, { fileOps: [["read", "link"], ["read", "big.txt"], ["read", "notes.txt", { line: 0 }], ["read", "notes.txt", { limit: 1.5 }], ["read", "notes.txt", { line: 2, limit: 1 }]] });
  ctx.env.RELAY_JOBS_KIMI_READ_MAX_BYTES = "1024";
  assert.equal(spawnSync("mkfifo", [path.join(ctx.work, "pipe")]).status, 0);
  fs.symlinkSync(path.join(ctx.work, "pipe"), path.join(ctx.work, "link"));
  fs.writeFileSync(path.join(ctx.work, "big.txt"), "x".repeat(4096));
  fs.writeFileSync(path.join(ctx.work, "notes.txt"), "one\ntwo\nthree\n");
  const { id } = startJob(ctx, `${HEADER}\nmode: read-only`, "[quick] Read.");
  await finishJob(ctx, id);
  const answers = readAnswers(ctx);
  assert.match(answers[0], /^-32000 This job is read-only: relay serves only regular files, and .*\/link is a FIFO\.$/);
  assert.match(answers[1], /^-32000 This job is read-only: relay serves files up to 1024 bytes, and .*\/big\.txt has 4096\.$/);
  assert.deepEqual(answers.slice(2), ["-32602 Invalid params: line and limit must be positive integers.", "-32602 Invalid params: line and limit must be positive integers.", "two\n"]);
});

test("file reads in flight are bounded, and close aborts them and waits; a read after close is refused", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const opened = [];
  const handle = { stat: async () => ({ isFile: () => true, size: 3 }), read: async () => { await held; return { bytesRead: 0 }; }, close: async () => { opened.pop(); } };
  const reads = new KimiFileReads({ open: async () => { opened.push(1); return handle; }, maxInFlight: 2 });
  const first = reads.serve({ path: "/a" });
  const second = reads.serve({ path: "/b" });
  await assert.rejects(reads.serve({ path: "/c" }), /at most 2 file reads at once/);
  const closing = reads.close();
  let closed = false;
  closing.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false, "close waits for the reads in flight");
  release();
  await closing;
  assert.equal(opened.length, 0, "every opened file was closed");
  assert.deepEqual(await Promise.allSettled([first, second]).then(all => all.map(r => r.status)), ["fulfilled", "fulfilled"]);
  await assert.rejects(reads.serve({ path: "/d" }), /The connection is closing/);
});

test("permission answers take fallback options, and no matching option answers cancelled; other requests are refused and recorded", async t => {
  const offered = [
    [{ kind: "allow_always", optionId: "always" }, { kind: "reject_always", optionId: "never" }],
    [{ kind: "allow_once", optionId: "allow" }],
    [{ kind: "reject_once", optionId: "deny" }]
  ];
  const expected = {
    yolo: [{ outcome: "selected", optionId: "always" }, { outcome: "selected", optionId: "allow" }, { outcome: "cancelled" }],
    "read-only": [{ outcome: "selected", optionId: "never" }, { outcome: "cancelled" }, { outcome: "selected", optionId: "deny" }]
  };
  for (const mode of ["yolo", "read-only"]) {
    const ctx = fixture(t, { permissionOptions: offered, unsupported: true });
    const { id } = startJob(ctx, `${HEADER}\nmode: ${mode}`, "[quick] Ask.");
    await finishJob(ctx, id);
    assert.deepEqual(answer(ctx, "session/request_permission").map(a => a.result.outcome), expected[mode], mode);
    assert.deepEqual(answer(ctx, "client/missing").map(a => a.error), [{ code: -32601, message: "Unsupported server request: client/missing" }]);
    assert.ok(events(ctx, id).some(e => e.method === "kimi/serverRequestRejected" && e.params.method === "client/missing"));
  }
});

test("a prompt that starts with / goes after an empty text block, so Kimi never reads it as a command", async t => {
  const ctx = fixture(t);
  const { id } = startJob(ctx, HEADER, "/tmp is a directory. [quick]");
  await finishJob(ctx, id);
  const [sent] = requests(ctx, "session/prompt");
  assert.deepEqual(sent.params.prompt, [{ type: "text", text: "" }, { type: "text", text: "/tmp is a directory. [quick]" }]);
  assert.equal(ctx.kimi().commands, undefined);
  assert.equal(report(ctx, id), "Report for: /tmp is a directory. [quick]\n");
});

test("Kimi's refusals fail the start with its words: an unknown effort, an unknown model, a missing sign-in", async t => {
  for (const [header, options, expected] of [
    ["backend: kimi\nmodel: kimi-code/k3\neffort: medium", {}, /Unknown thinking value: medium/],
    ["backend: kimi\nmodel: kimi-code/nope\neffort: low", {}, /Internal error: Model "kimi-code\/nope" is not configured in config\.toml\./],
    // Kimi checks the sign-in at session/new: the advice names the job's own home and the region,
    // since a home with no login and no region marker signs in to kimi.com.
    [HEADER, { authError: true }, /Authentication required\. Kimi needs a sign-in for .*\/\.kimi-code: run `KIMI_CODE_HOME=.*\/\.kimi-code' kimi login --region global` \(--region mainland-cn for a kimi\.com account\)\./],
    [`${HEADER}\nkimi-home: jobs`, { authError: true }, /Authentication required\. Kimi needs a sign-in for .*\/\.kimi-code-jobs: run `KIMI_CODE_HOME=.*\/\.kimi-code-jobs' kimi login --region global` \(--region mainland-cn for a kimi\.com account\)\./]
  ]) {
    const ctx = fixture(t, options);
    const { id } = startJob(ctx, header, "[quick] Refused.");
    await finishJob(ctx, id, 3);
    assert.match(readJob(ctx, id).errorMessage, expected);
  }
});

test("an explicit KIMI_BINARY is the binary: a name that is not on PATH fails and never falls back to ~/.kimi-code/bin/kimi", t => {
  const dir = makeTempDir("relay-kimi-binary-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "#!/bin/sh\n"); fs.chmodSync(file, 0o755); return fs.realpathSync(file); };
  const installed = executable(path.join(dir, ".kimi-code", "bin", "kimi"));
  const wrapper = executable(path.join(dir, "bin", "kimi-wrapper"));
  const env = { HOME: dir, PATH: path.join(dir, "bin") };
  assert.throws(() => resolveKimiBinary({ ...env, KIMI_BINARY: "missing-kimi-wrapper" }), /^Error: Kimi binary is not executable: missing-kimi-wrapper$/);
  assert.throws(() => resolveKimiBinary({ ...env, KIMI_BINARY: path.join(dir, "missing") }), /not executable/);
  assert.equal(resolveKimiBinary({ ...env, KIMI_BINARY: "kimi-wrapper" }), wrapper);
  assert.equal(resolveKimiBinary(env), installed, "unset, the installer's location serves a PATH without kimi");
});

test("a prompt sent while Kimi runs a turn of its own waits behind it and owns the report", async t => {
  const ctx = fixture(t, { ownTurnAfterMs: 1, ownTurnMs: 600, turnMs: 400 });
  const { id } = startJob(ctx, HEADER, "First.");
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).turnId);
  // The steer becomes the next turn in the same process; Kimi's own turn starts as the first
  // ends, so the next prompt reaches the engine during it and ACP answers end_turn at once.
  postInboxMessage(dir, { kind: "steer", text: "[quick] Next." });
  await finishJob(ctx, id);
  assert.equal(ctx.kimi().queuedBehindOwn, 1, "the prompt was queued behind Kimi's own turn");
  assert.equal(report(ctx, id), "Report for: [quick] Next.\n");
  assert.equal(readJob(ctx, id).state, "completed");
  // ACP sent nothing for the queued turn: its report and its end came from the record alone.
  assert.equal(events(ctx, id).filter(e => e.params?.update?.sessionUpdate === "agent_thought_chunk").length, 1);
});

test("a cancel of a prompt queued behind Kimi's own turn ends the job: ACP cannot reach it, so relay closes Kimi's server", async t => {
  const ctx = fixture(t, { ownTurnAfterMs: 1, ownTurnMs: 600, turnMs: 400 });
  ctx.env.RELAY_JOBS_CANCEL_GRACE_MS = "20000";
  const { id } = startJob(ctx, HEADER, "First.");
  await waitFor(() => readJob(ctx, id).turnId);
  postInboxMessage(jobDir(ctx, id), { kind: "steer", text: "[long] Next." });
  await waitFor(() => ctx.kimi().turns.some(turn => turn.text === "[long] Next."));
  const started = Date.now();
  const cancelled = companion(ctx, ["cancel", id]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /^state: cancelled$/m);
  assert.doesNotMatch(cancelled.stdout, /killed the worker/, "relay ended it before the cancel's kill");
  assert.ok(Date.now() - started < 10000);
  await finishJob(ctx, id, 5);
  assert.equal(ctx.kimi().cancelsUnheard, 1, "session/cancel did not reach the queued turn");
  assert.ok(!(ctx.kimi().completed ?? []).some(turn => turn.text === "[long] Next."), "the queued turn never ended in Kimi");
  assert.ok(readJob(ctx, id).attempts.flatMap(attempt => attempt.servers ?? []).every(server => server.endedAt), "Kimi's server ended");
});

test("a turn of Kimi's own that outlasts the grace, then a pause in the hand-off: the queued prompt still runs and owns the report", async t => {
  // The grace is 400 ms; Kimi's own turn runs 1.2 s, and its hand-off pauses 250 ms.
  const ctx = fixture(t, { ownTurnAfterMs: 1, ownTurnMs: 1200, handoffMs: 250, turnMs: 400 });
  const { id } = startJob(ctx, HEADER, "First.");
  await waitFor(() => readJob(ctx, id).turnId);
  postInboxMessage(jobDir(ctx, id), { kind: "steer", text: "[quick] Next." });
  await finishJob(ctx, id);
  assert.equal(ctx.kimi().queuedBehindOwn, 1, "the prompt was queued behind Kimi's own turn");
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(report(ctx, id), "Report for: [quick] Next.\n");
});

test("a server killed while a prompt queued behind Kimi's own turn runs: one recovery, the old observer stops, and the worker exits", async t => {
  const ctx = fixture(t, { ownTurnAfterMs: 1, ownTurnMs: 600, turnMs: 400 });
  const { id } = startJob(ctx, HEADER, "First.");
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).turnId);
  postInboxMessage(dir, { kind: "steer", text: "[long] Next." });
  // ACP answered the queued prompt at once; once its turn runs, only the record tracks it.
  await waitFor(() => ctx.kimi().turns.some(turn => turn.text === "[long] Next."));
  const worker = readJob(ctx, id).worker;
  t.after(() => { if (isWorkerAlive(worker)) process.kill(worker.pid, "SIGKILL"); });
  process.kill(readJob(ctx, id).serverPid, "SIGKILL");
  await finishJob(ctx, id);
  const job = readJob(ctx, id);
  assert.equal(job.state, "completed");
  assert.equal(job.automaticResumes.length, 1);
  assert.equal(ctx.kimi().queuedBehindOwn, 1);
  assert.equal(ctx.kimi().turns.filter(turn => turn.text === "[long] Next.").length, 1, "the queued prompt is not sent again");
  assert.ok(events(ctx, id).some(e => e.method === "kimi/wireObserverStopped" && e.params.reason === "Kimi's server ended"), "the first connection's observer stopped");
  // The lease is gone (finishJob), and the worker process ends: nothing is left polling.
  await waitFor(() => !isWorkerAlive(worker), 5000);
});

test("containment: a shell command Kimi runs in its own session ends with the old server's sweep; one a server SIGKILL orphaned is out of reach, and relay claims no cleanup of it", async t => {
  const identity = pid => ({ pid, startTime: readProcessStartTime(pid) });
  const start = async () => {
    const ctx = fixture(t, { shellChild: true, turnMs: 30000 });
    const { id } = startJob(ctx, HEADER, "Run a command.");
    const record = await waitFor(() => ctx.kimi().descendants?.[0]);
    const job = readJob(ctx, id);
    const processes = { worker: job.worker, server: identity(record.appServerPid), child: identity(record.childPid) };
    t.after(() => { for (const proc of Object.values(processes)) if (isWorkerAlive(proc)) process.kill(proc.pid, "SIGKILL"); });
    return { ctx, id, ...processes };
  };

  // Only the worker dies. Its Kimi server and the server's command live on, and the next
  // worker stops the recorded server with every descendant before it starts its own.
  const swept = await start();
  process.kill(swept.worker.pid, "SIGKILL");
  await waitFor(() => !isWorkerAlive(swept.worker));
  assert.equal(isWorkerAlive(swept.child), true, "the command outlives its worker");
  assert.equal(companion(swept.ctx, ["resume", swept.id, "--message", "[quick] Finish."]).status, 0);
  await finishJob(swept.ctx, swept.id);
  assert.equal(isWorkerAlive(swept.server), false, "the sweep ended the old server");
  assert.equal(isWorkerAlive(swept.child), false, "and the command it started in a session of its own");
  assert.ok(readJob(swept.ctx, swept.id).attempts[0].servers[0].endedAt, "the sweep recorded the server's end");

  // Worker and server die by SIGKILL: the command is reparented, no longer a descendant of
  // anything relay recorded (design.md, Processes). Recovery does not reach it, and no record
  // claims it was stopped.
  const orphaned = await start();
  process.kill(orphaned.server.pid, "SIGKILL");
  process.kill(orphaned.worker.pid, "SIGKILL");
  await waitFor(() => companion(orphaned.ctx, ["status", orphaned.id]).stdout.includes("state: dead"));
  assert.equal(companion(orphaned.ctx, ["resume", orphaned.id, "--message", "[quick] Finish."]).status, 0);
  await finishJob(orphaned.ctx, orphaned.id);
  assert.equal(isWorkerAlive(orphaned.child), true, "out of reach, as documented");
  assert.doesNotMatch(fs.readFileSync(path.join(jobDir(orphaned.ctx, orphaned.id), "job.json"), "utf8"), new RegExp(`"pid":${orphaned.child.pid}\\b`));
  process.kill(orphaned.child.pid, "SIGKILL");
});

test("server death mid-turn records the exit; a second death in the attempt fails it", async t => {
  const ctx = fixture(t, { die: true });
  const { id } = startJob(ctx, HEADER, "Exit.");
  await finishJob(ctx, id, 3);
  assert.match(readJob(ctx, id).errorMessage, /kimi acp ended before the turn finished \(exit 17\)/);
  assert.match(readJob(ctx, id).errorMessage, /fake kimi death/);
});

test("Workflow retry adopts the same Kimi job and returns its state block", async () => {
  const { relayContext, companion: relayCompanion, readJobJson, relayStart, waitFor: relayWait } = await import("./support/relay-fixture.mjs");
  const first = relayContext("job", { workflow: "wf-kimi", journalKey: "kimi-call" });
  const fake = installFakeKimi(first.binDir, { turnMs: 1500 });
  first.env.KIMI_BINARY = fake.binary;
  first.env.RELAY_JOBS_KIMI_POLL_MS = "20";
  const append = ctx => {
    const prompt = ctx.workflowPrompt();
    // Kimi has no write mode, and its models are the home's.
    prompt.message.content = prompt.message.content.replace("web-search: disabled", "web-search: live").replace("mode: write", "mode: yolo")
      .replace("model: gpt-test", "model: kimi-code/k3").replace("\n  model:", "\n  backend: kimi\n  kimi-home: jobs\n  model:");
    ctx.append(ctx.userRequest(), prompt, ctx.environment(), ctx.snapshot("string"), ctx.systemReminder());
  };
  append(first);
  const started = await relayStart(first);
  assert.equal(started.started.status, 0, started.started.stderr);
  const id = started.jobId;
  await relayWait(() => readJobJson(first, id).turnId);
  const retry = relayContext("job", { from: first, workflow: "wf-kimi", label: "relay-test (retry 1)", journalKey: "kimi-call" });
  append(retry);
  const adopted = await relayStart(retry);
  assert.match(adopted.started.stdout, new RegExp(`^job: ${id}$`, "m"));
  assert.match(adopted.started.stdout, /relay-adopted:/);
  const ended = relayCompanion(retry, ["wait", id, "--timeout-seconds", "15", "--state-only"]);
  assert.equal(ended.status, 0, ended.stdout);
  assert.match(ended.stdout, /^backend: kimi$/m);
  assert.match(ended.stdout, /^kimi-home: .*\/\.kimi-code-jobs$/m);
  assert.doesNotMatch(ended.stdout, /^---$/m);
  assert.equal(fake.state().turns.length, 1);
});

test("setup checks the version and the providers without starting acp; a signed-out home says how to sign in", t => {
  for (const signedOut of [false, true]) {
    const ctx = fixture(t, { signedOut });
    const home = path.join(ctx.user, ".kimi-code-jobs");
    fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(home, "credentials", "kimi-code-env-fake.json"), '{"access_token":"x"}');
    const result = companion(ctx, ["setup", "--backend", "kimi", "--kimi-home", "jobs", "--json"]);
    assert.equal(result.status, signedOut ? 1 : 0, result.stderr);
    const [block] = JSON.parse(result.stdout).backends;
    assert.equal(block.home, home);
    assert.equal(block.version, "2.2.0-fake");
    assert.equal(block.signIn.state, signedOut ? "signed-out" : "credentials-present");
    if (signedOut) assert.match(block.signIn.detail, /no provider is configured \(sign in: `KIMI_CODE_HOME=.* kimi login --region global`, or --region mainland-cn for a kimi\.com account; see kimi-home\.md\)/);
    assert.deepEqual(ctx.kimi().invocations.map(call => call.args.join(" ")).sort(), ["--version", "provider list --json"]);
    assert.equal(ctx.kimi().invocations.find(call => call.args[0] === "provider").env.KIMI_CODE_HOME, home);
    assert.ok(ctx.kimi().invocations.every(call => call.env.KIMI_CODE_TRUST_WORKSPACE === undefined));
    assert.equal(ctx.kimi().starts.length, 0);
    assert.doesNotMatch(result.stdout, /FAKE-SECRET-KEY/);
  }
});

test("the event recorder joins chunks, keeps finished tools and drops running updates and command lists", () => {
  let touches = 0;
  const written = [];
  const recorder = kimiEventRecorder(event => written.push(event), () => { touches += 1; });
  const event = (kind, extra = {}) => ({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: kind, ...extra } } });
  recorder.record(event("agent_message_chunk", { content: { type: "text", text: "one" } }));
  recorder.record(event("agent_message_chunk", { content: { type: "text", text: "two" } }));
  recorder.record(event("available_commands_update", { availableCommands: [] }));
  recorder.record(event("tool_call", { toolCallId: "t1", status: "pending" }));
  recorder.record(event("tool_call_update", { toolCallId: "t1", status: "in_progress" }));
  recorder.record(event("tool_call_update", { toolCallId: "t1", status: "failed" }));
  recorder.record(event("agent_thought_chunk", { content: { type: "text", text: "partial" } }));
  recorder.flush();
  assert.equal(touches, 7);
  assert.deepEqual(written.map(e => [e.params.update.sessionUpdate, e.params.update.content?.text ?? e.params.update.status]), [
    ["agent_message_chunk", "onetwo"], ["tool_call", "pending"], ["tool_call_update", "failed"], ["agent_thought_chunk", "partial"]
  ]);
});

test("the record reader keeps turns and prompts by id, the report after the last tool call, and a record split across reads, even inside a UTF-8 character", t => {
  const dir = makeTempDir("relay-kimi-wire-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wire.jsonl");
  const line = value => `${JSON.stringify(value)}\n`;
  const prompt = (text, turnId, origin = "user") => ({ type: "turn.prompt", input: [{ type: "text", text: "" }, { type: "text", text }], origin: { kind: origin }, ...(origin === "user" ? { promptId: `p${turnId}` } : {}), turnId });
  const assistant = (text, toolCalls = []) => ({ type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "think", think: "x" }, { type: "text", text }], toolCalls } } });
  fs.writeFileSync(file, [
    line({ type: "agent.turn.started", turnId: 0 }), line(prompt("Same", 0)), line(assistant("first words ")), line(assistant("before tool", [{ id: "t" }])),
    line({ type: "agent.message.appended", message: { message: { role: "tool", content: [] } } }),
    line(assistant("after ")), line(assistant("tool")), line({ type: "turn.ended", turnId: 0, reason: "completed" }),
    line({ type: "agent.turn.started", turnId: 1 }), line(prompt("Same", 1, "task"))
  ].join(""));
  const wire = new KimiWire(() => file).read();
  assert.deepEqual([...wire.prompts.keys()], ["p0"], "a task prompt is not one relay sent");
  assert.deepEqual(wire.prompts.get("p0"), { promptId: "p0", at: fs.readFileSync(file, "utf8").indexOf('{"type":"turn.prompt"'), text: "Same", delivered: false, turnId: 0, started: true, terminal: null });
  assert.equal(wire.turns.get(0).report, "after tool");
  assert.equal(wire.turns.get(0).didWork, true);
  assert.equal(wire.turns.get(1).origin, "task");
  assert.equal(wire.running, 1, "Kimi's own turn runs");
  // A record cut inside a multibyte character waits whole for the next read.
  const before = fs.statSync(file).size;
  const tail = line(assistant("naïve 界 report")) + line({ type: "turn.ended", turnId: 1, reason: "completed" });
  const bytes = Buffer.from(tail);
  const cut = bytes.indexOf(Buffer.from("界")) + 1;
  fs.appendFileSync(file, bytes.subarray(0, cut));
  wire.read();
  assert.equal(wire.consumed, before);
  assert.equal(wire.turns.get(1).report, "");
  fs.appendFileSync(file, bytes.subarray(cut));
  wire.read();
  assert.equal(wire.turns.get(1).report, "naïve 界 report");
  assert.equal(wire.running, null);
  assert.equal(wire.consumed, fs.statSync(file).size);
  assert.equal(wire.promptSince(0, "Same").promptId, "p0");
  assert.equal(wire.promptSince(wire.consumed, "Same"), null, "nothing relay sent is recorded after the end");
});

test("the record reader joins a prompt's forms by Kimi's prompt id: input, start and end; hook text set apart; blocked and aborted prompts end without a turn", t => {
  const dir = makeTempDir("relay-kimi-wire-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wire.jsonl");
  const line = value => `${JSON.stringify(value)}\n`;
  const hook = { type: "text", text: "<hook>branch: main</hook>", meta: { contentType: "text/xml", source: "user prompt submit hook" } };
  const input = (promptId, content) => line({ type: "agent.message.appended", message: { message: { role: "user", content }, meta: { source: "input", promptId, origin: { kind: "user" } } } });
  const started = (promptId, turnId, content) => line({ type: "agent.turn.started", turnId, queueItemId: promptId }) + line({ type: "turn.prompt", input: content, origin: { kind: "user" }, promptId, turnId });
  const text = value => ({ type: "text", text: value });
  fs.writeFileSync(file, input("a", [hook, text("Same")]));
  const wire = new KimiWire(() => file).read();
  // Delivered: the input is committed, and no turn exists for it yet.
  assert.deepEqual(wire.prompts.get("a"), { promptId: "a", at: 0, text: "Same", delivered: true, turnId: null, started: false, terminal: null });
  assert.equal(wire.promptSince(0, "Same").promptId, "a", "the hook's text is set apart");
  assert.equal(wire.promptSince(0, "<hook>branch: main</hook>"), null, "a hook's part never matches");
  const second = fs.statSync(file).size;
  fs.appendFileSync(file, started("a", 0, [hook, text("Same")]) + line({ type: "turn.ended", turnId: 0, reason: "completed" })
    + input("b", [text("Same")]) + started("b", 1, [text("Same")]) + line({ type: "turn.ended", turnId: 1, reason: "completed" }));
  wire.read();
  assert.deepEqual([...wire.prompts.keys()], ["a", "b"], "each prompt once, however many forms the record holds");
  assert.equal(wire.prompts.get("a").started, true);
  assert.equal(wire.turns.get(0).promptId, "a");
  assert.equal(wire.promptSince(second, "Same").promptId, "b", "the same text sent again is another prompt");
  // Kimi always marks a hook's part (its record keeps the part's meta). A part without the mark
  // is the prompt's own text, and no single part matches alone.
  fs.appendFileSync(file, input("c", [text("<unmarked/>"), text("Other")]));
  assert.equal(wire.read().promptSince(0, "Other"), null);
  assert.equal(wire.promptSince(0, "<unmarked/>Other").promptId, "c");
  // Blocked before its input was committed: Kimi keeps the message in its context and completes
  // the prompt as blocked. Cancelled before it started: prompt.aborted.
  fs.appendFileSync(file, line({ type: "context.append_message", message: { role: "user", id: "d", content: [text("Blocked")], origin: { kind: "user" } } })
    + line({ type: "prompt.completed", promptId: "d", reason: "blocked" }) + line({ type: "prompt.aborted", promptId: "e" }));
  wire.read();
  assert.equal(wire.promptSince(0, "Blocked").terminal.reason, "blocked");
  assert.equal(wire.prompts.get("d").started, false);
  assert.equal(wire.prompts.get("e").terminal.type, "prompt.aborted");
});

test("the record reader keeps Kimi's engine turns apart from its prompt turns: a notification run inside a prompt's turn ends with it, and nothing stays running", t => {
  // The shape a live Kimi 2.2.0 session wrote (2026-10-17): a background task ended during the
  // brief's last model call, and its notification ran as engine turn 1 inside prompt turn 0.
  const dir = makeTempDir("relay-kimi-wire-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wire.jsonl");
  const line = value => `${JSON.stringify(value)}\n`;
  const assistant = (text, toolCalls = []) => line({ type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "text", text }], toolCalls } } });
  fs.writeFileSync(file, [
    line({ type: "agent.message.appended", message: { message: { role: "user", content: [{ type: "text", text: "Brief." }] }, meta: { source: "input", promptId: "p0", origin: { kind: "user" } } } }),
    line({ type: "agent.turn.started", turnId: 0, queueItemId: "p0" }),
    line({ type: "turn.prompt", input: [{ type: "text", text: "Brief." }], origin: { kind: "user" }, promptId: "p0", turnId: 0 }),
    assistant("", [{ id: "a", name: "Bash" }]), assistant("STARTED"),
    line({ type: "agent.turn.ended", turnId: 0, outcome: "done" }),
    line({ type: "agent.message.appended", message: { message: { role: "user", content: [{ type: "text", text: "<notification/>" }] }, meta: { source: "notify" } } }),
    line({ type: "agent.turn.started", turnId: 1 })
  ].join(""));
  const wire = new KimiWire(() => file).read();
  assert.equal(wire.busy, true, "the notification's engine turn runs");
  fs.appendFileSync(file, assistant("", [{ id: "b", name: "Bash" }]) + assistant("OWNDONE") + line({ type: "agent.turn.ended", turnId: 1, outcome: "done" }) + line({ type: "turn.ended", turnId: 0, reason: "completed" }));
  wire.read();
  assert.equal(wire.busy, false, "both ended: nothing runs");
  assert.equal(wire.turns.get(0).report, "OWNDONE", "the prompt turn's last text, as Kimi ended it");
  assert.equal(wire.prompts.get("p0").turnId, 0);
});

// Read what the fake binary actually wrote, independently of the worker's wire reader.
function kimiRecords(ctx, id) {
  const job = readJob(ctx, id);
  const root = path.join(job.request.kimiHome, "sessions");
  const file = fs.readdirSync(root).map(bucket => path.join(root, bucket, job.sessionId, "agents", "main", "wire.jsonl")).find(file => fs.existsSync(file));
  return fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(record => record.type !== "metadata");
}

const lateRecordOrder = ["agent.message.appended", "agent.turn.started", "turn.prompt", "turn.ended", "prompt.completed", "agent.message.appended", "agent.turn.ended"];

test("a final answer recorded after turn.ended and prompt.completed reaches the completed job's report before the settle grace", async t => {
  const ctx = fixture(t, { lateMessages: { releaseFile: "release-final" }, answer: "The late final answer." });
  ctx.env.RELAY_JOBS_KIMI_SETTLE_MS = "10000";
  const { id } = startJob(ctx, HEADER, "[quick] Late record.");
  // The worker has observed this turn, but the fake's engine still holds its final batch.
  await waitFor(() => readJob(ctx, id).turnId && kimiRecords(ctx, id).some(record => record.type === "prompt.completed"));
  assert.equal(readJob(ctx, id).state, "running");
  assert.deepEqual(kimiRecords(ctx, id).map(record => record.type), lateRecordOrder.slice(0, 5));
  assert.equal(fs.existsSync(path.join(jobDir(ctx, id), "report.md")), false);
  fs.writeFileSync(path.join(ctx.work, "release-final"), "");
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(readJob(ctx, id).attempts.at(-1).hasReport, true);
  assert.equal(report(ctx, id), "The late final answer.\n");
  assert.deepEqual(kimiRecords(ctx, id).map(record => record.type), lateRecordOrder);
  const result = companion(ctx, ["result", id]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^report: none$/m);
  assert.match(result.stdout, /The late final answer\./);
  assert.deepEqual(events(ctx, id).filter(e => e.params?.update?.sessionUpdate === "agent_message_chunk").map(e => e.params.update.content.text), ["The late final answer."]);
  assert.equal(requests(ctx, "session/prompt").length, 1);
});

test("a final answer arriving after the settle grace stays in the record and events, but the job completes with report: none", async t => {
  const ctx = fixture(t, { lateMessages: { afterClose: true }, answer: "Too late for the report." });
  const { id } = startJob(ctx, HEADER, "[quick] Past the grace.");
  // No engine end until connection close: the grace must bound the wait. Close then releases
  // real final records and ACP chunks, after the worker has already chosen its empty report.
  const end = await finishJob(ctx, id, 3);
  const job = readJob(ctx, id);
  assert.equal(job.state, "completed");
  assert.equal(job.attempts.at(-1).hasReport, false);
  assert.equal(fs.existsSync(path.join(jobDir(ctx, id), "report.md")), false);
  assert.match(end.stdout, /^report: none$/m);
  const records = kimiRecords(ctx, id);
  assert.deepEqual(records.map(record => record.type), lateRecordOrder);
  assert.equal(records[5].message.message.content.find(part => part.type === "text").text, "Too late for the report.");
  assert.ok(records[5].time - records[3].time >= Number(ctx.env.RELAY_JOBS_KIMI_SETTLE_MS), "the final record arrived after the grace");
  assert.deepEqual(events(ctx, id).filter(e => e.params?.update?.sessionUpdate === "agent_message_chunk").map(e => e.params.update.content.text), ["Too late for the report."]);
  assert.equal(requests(ctx, "session/prompt").length, 1, "no resend or automatic recovery");
  assert.equal(ctx.kimi().starts.length, 1);
  const result = companion(ctx, ["result", id]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /^report: none$/m);
  assert.doesNotMatch(result.stdout, /Too late for the report\./);
});


for (const first of ["stdin end", "SIGTERM"]) {
  test(`late-order fake flushes once when ${first} arrives first`, async t => {
    const ctx = fixture(t, { lateMessages: { afterClose: true }, answer: "Close-time final." });
    const child = spawn(process.execPath, [ctx.env.KIMI_BINARY, "acp"], {
      cwd: ctx.work, env: { ...ctx.env, KIMI_CODE_HOME: path.join(ctx.user, ".kimi-code") },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let closed = false, stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", () => { closed = true; });
    t.after(async () => {
      child.stdin.destroy();
      if (!closed) child.kill("SIGKILL");
      await waitFor(() => closed);
    });
    const request = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      let reply;
      await waitFor(() => {
        reply = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === id);
        return reply || closed;
      });
      assert.ok(reply?.result, `${method}: ${stderr}`);
      return reply.result;
    };
    await request(1, "initialize", { clientCapabilities: {} });
    const { sessionId } = await request(2, "session/new", { cwd: ctx.work, mcpServers: [] });
    await request(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "[quick] Close." }] });
    const records = () => {
      const home = path.join(ctx.user, ".kimi-code", "sessions");
      const bucket = fs.readdirSync(home)[0];
      return fs.readFileSync(path.join(home, bucket, sessionId, "agents/main/wire.jsonl"), "utf8")
        .trim().split("\n").map(line => JSON.parse(line)).filter(record => record.type !== "metadata");
    };
    assert.deepEqual(records().map(record => record.type), lateRecordOrder.slice(0, 5));
    if (first === "stdin end") child.stdin.end();
    else child.kill("SIGTERM");
    // Observe the flush before allowing the other close event: no scheduling delay
    // can hide a missing first-event handler or make the two handlers look ordered.
    await waitFor(() => records().length === lateRecordOrder.length);
    await waitFor(() => stdout.trim().split("\n").map(line => JSON.parse(line))
      .filter(message => message.params?.update?.sessionUpdate === "agent_message_chunk")
      .map(message => message.params.update.content.text).join("") === "Close-time final.");
    if (first === "stdin end") child.kill("SIGTERM");
    else child.stdin.end();
    await waitFor(() => closed);
    assert.equal(child.exitCode, 0, stderr);
    assert.deepEqual(records().map(record => record.type), lateRecordOrder, "both close events flush only once");
    const messages = stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(messages.filter(message => message.params?.update?.sessionUpdate === "agent_message_chunk")
      .map(message => message.params.update.content.text).join(""), "Close-time final.");
  });
}
