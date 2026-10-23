import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeCodex } from "./fakes/codex.mjs";
import { makeTempDir } from "./support/helpers.mjs";
import { waitFor } from "./support/runtime-fixture.mjs";

// Turn ordering checks exercise the worker, report and event stream together in scratch homes.
const INFERENCE_NOTE = "note: turn completion inferred; Codex sent no turn/completed";

async function turnJob(t, behavior, env = {}) {
  const { relayContext, companion, jobDirOf, readJobJson } = await import("./support/relay-fixture.mjs");
  const ctx = relayContext(behavior, { env: { CODEX_HOME: makeTempDir("relay-turn-order-home-"), ...env } });
  const brief = path.join(ctx.work, "brief.md");
  fs.writeFileSync(brief, "First task");
  const started = companion(ctx, ["start", "--model", "gpt-test", "--effort", "low", "--mode", "read-only", "--brief-file", brief]);
  assert.equal(started.status, 0, started.stderr);
  const id = /^job: (\S+)$/m.exec(started.stdout)[1];
  t.after(() => companion(ctx, ["cancel", id]));
  const dir = jobDirOf(ctx, id);
  const events = () => fs.existsSync(path.join(dir, "events.jsonl"))
    ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const job = () => readJobJson(ctx, id);
  const done = async () => {
    await waitFor(() => ["completed", "failed", "cancelled"].includes(job().state) && !job().server, { timeoutMs: 15000 });
    return job();
  };
  return { ctx, id, dir, events, job, done, command: args => companion(ctx, args) };
}

for (const ending of ["completed", "failed", "exit"]) {
  test(`final answer awaits late ${ending}`, async t => {
    const j = await turnJob(t, `turn-order-final-${ending}`);
    await waitFor(() => j.events().some(e => e.params?.item?.id === "candidate"), { intervalMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(j.job().state, "running");
    assert.equal(fs.existsSync(path.join(j.dir, "report.md")), false);
    const job = await j.done();
    assert.equal(job.state, ending === "completed" ? "completed" : "failed");
    const output = j.command(["result", j.id]).stdout;
    assert.doesNotMatch(output, /turn completion inferred/);
    const ends = j.events().filter(e => e.method === "turn/completed" && e.params.threadId === job.sessionId);
    assert.equal(ends.length, ending === "exit" ? 0 : 1);
    assert.equal(j.events().filter(e => e.method === "codex/turnCompletionInferred").length, 0);
    if (ending === "completed") assert.match(output, /Report for: First task/);
    else {
      assert.match(output, /^report: none$/m);
      assert.equal(fs.existsSync(path.join(j.dir, "report.md")), false);
      if (ending === "exit") assert.match(output, /ended before turn\/completed/);
    }
  });
}

for (const status of ["completed", "failed", "interrupted", "unsupported", "inProgress", "missing", "read-error", "unknown-method", "unknown-status", "unknown-variant-status", "unsupported-text"]) {
  test(`collaborator thread/read ${status}`, async t => {
    const j = await turnJob(t, `turn-order-collab-${status}`);
    const job = await j.done();
    const readFailure = ["missing", "read-error", "unknown-status", "unknown-variant-status", "unsupported-text"].includes(status);
    const succeeds = !readFailure && !["failed", "interrupted"].includes(status);
    assert.equal(job.state, succeeds ? "completed" : "failed");
    const output = j.command(["result", j.id]).stdout;
    assert.equal(j.events().filter(e => e.method === "turn/completed" && e.params.threadId === job.sessionId).length, 0);
    assert.deepEqual(j.ctx.fakeState().threadReads, [{ threadId: job.sessionId, includeTurns: true }]);
    const inferred = j.events().filter(e => e.method === "codex/turnCompletionInferred");
    assert.equal(inferred.length, readFailure ? 0 : 1);
    if (inferred.length) {
      assert.equal(inferred[0].params.threadId, job.sessionId);
      assert.equal(inferred[0].params.source, ({ unsupported: "unsupported", "unknown-method": "unsupported", inProgress: "inProgress", missing: "turn-not-found", "read-error": "read-error" })[status] ?? "thread/read");
      assert.equal(inferred[0].params.turnId, job.turnId);
      assert.equal(inferred[0].params.status, succeeds ? "completed" : status);
      assert.ok(output.includes(INFERENCE_NOTE), output);
    }
    if (succeeds || readFailure) assert.match(output, /Candidate report/);
    else assert.match(output, /^report: none$/m);
    const reason = ({ unsupported: "method unsupported", "unknown-method": "method unsupported", inProgress: "inProgress", missing: "turn not found", "read-error": "history unavailable" })[status];
    if (reason && !readFailure) assert.ok(output.includes(`${INFERENCE_NOTE}; thread/read: ${reason}\n`), output);
    if (readFailure) {
      const error = ({ missing: "turn not found", "read-error": "history unavailable", "unknown-status": "unknown status waiting", "unknown-variant-status": "unknown variant `waiting`, expected a turn status", "unsupported-text": "Unsupported method: thread/read" })[status];
      assert.equal(job.errorMessage, `thread/read: ${error}`);
      assert.doesNotMatch(output, /turn completion inferred/);
      assert.equal(job.attempts.at(-1).hasReport, true);
    }
    if (status === "read-error") assert.doesNotMatch(output, /additional detail/);
    if (status === "read-error") assert.match(output, /history unavailable/);
    if (status === "failed") assert.match(output, /read found failure/);
  });
}

test("state block: inference block renders without reading the events path", async t => {
  const { loadJobView, renderJobBlock } = await import("../plugins/relay/scripts/lib/jobs/view.mjs");
  const { readLease } = await import("../plugins/relay/scripts/lib/jobs/lease.mjs");
  const j = await turnJob(t, "turn-order-collab-unsupported");
  const job = await j.done();
  await waitFor(() => !readLease(j.dir));
  const eventsPath = path.join(j.dir, "events.jsonl");
  fs.rmSync(eventsPath);
  fs.mkdirSync(eventsPath);
  const output = renderJobBlock(loadJobView(j.dir));
  assert.ok(output.includes(`${INFERENCE_NOTE}; thread/read: method unsupported\n`), output);
  assert.match(output, /^state: completed$/m);
  assert.deepEqual(job.attempts.at(-1).completionInference, {
    threadId: job.sessionId, turnId: job.turnId, status: "completed", source: "unsupported", reason: "method unsupported"
  });
});

test("state block: an earlier inferred turn does not label a later turn/completed", async t => {
  const { loadJobView, renderJobBlock } = await import("../plugins/relay/scripts/lib/jobs/view.mjs");
  const { readLease } = await import("../plugins/relay/scripts/lib/jobs/lease.mjs");
  const j = await turnJob(t, "turn-order-collab-unsupported");
  const first = await j.done();
  await waitFor(() => !readLease(j.dir));
  assert.ok(renderJobBlock(loadJobView(j.dir)).includes(INFERENCE_NOTE));
  installFakeCodex(j.ctx.binDir, "job", { turnMs: 50 });
  assert.equal(j.command(["continue", j.id, "--message", "[quick] Authoritative later report"]).status, 0);
  await waitFor(() => j.job().attempts.length === 2 && j.job().state === "completed" && !readLease(j.dir));
  const later = j.job();
  assert.notEqual(later.turnId, first.turnId);
  assert.ok(j.events().some(e => e.method === "turn/completed" && e.params.threadId === later.sessionId && e.params.turn.id === later.turnId));
  assert.doesNotMatch(renderJobBlock(loadJobView(j.dir)), /turn completion inferred/);
  assert.equal(later.attempts[0].completionInference.turnId, first.turnId);
  assert.equal(later.attempts[1].completionInference, undefined);
  // Even a stale inference attached to the current attempt must match its exact turn.
  const view = loadJobView(j.dir);
  view.job.attempts[1].completionInference = later.attempts[0].completionInference;
  assert.doesNotMatch(renderJobBlock(view), /turn completion inferred/);
});

for (const behavior of ["turn-order-steer-accepted", "turn-order-steer-pending", "turn-order-activity-item", "turn-order-activity-turn", "turn-order-activity-other-item", "turn-order-activity-other-turn", "turn-order-collab-read-race"]) {
  test(`inference cancelled by ${behavior}`, async t => {
    const j = await turnJob(t, behavior);
    await waitFor(() => j.events().some(e => e.params?.item?.id === "candidate"), { intervalMs: 10 });
    if (behavior.includes("steer")) {
      const posted = j.command(["steer", j.id, "--message", "Finish the correction"]);
      assert.equal(posted.status, 0, posted.stderr);
      await waitFor(() => j.ctx.fakeState().steers?.some(s => s.accepted), { intervalMs: 10 });
    }
    // read-race deliberately leaves the status reply in flight while the steer lands.
    if (behavior === "turn-order-collab-read-race") {
      await waitFor(() => j.ctx.fakeState().threadReads?.length, { intervalMs: 10 });
      assert.equal(j.command(["steer", j.id, "--message", "Finish the correction"]).status, 0);
    }
    const job = await j.done();
    assert.equal(job.state, "completed");
    assert.equal(j.events().filter(e => e.method === "codex/turnCompletionInferred").length, 0);
    assert.equal(j.events().filter(e => e.method === "turn/completed" && e.params.threadId === job.sessionId).length, 1);
    const output = j.command(["result", j.id]).stdout;
    assert.doesNotMatch(output, /turn completion inferred/);
    assert.match(output, /Report for: First task/);
    if (behavior.includes("steer") || behavior.endsWith("read-race")) {
      assert.match(output, /Steered with: Finish the correction/);
      assert.equal(j.ctx.fakeState().steers.filter(s => s.accepted).length, 1);
      assert.equal(j.ctx.fakeState().turnStarts.length, 1);
    }
  });
}

test("transport ends before collaborator inference", async t => {
  const j = await turnJob(t, "turn-order-collab-exit");
  const job = await j.done();
  assert.equal(job.state, "failed");
  assert.equal(j.events().filter(e => e.method === "codex/turnCompletionInferred").length, 0);
  assert.equal(j.ctx.fakeState().threadReads?.length ?? 0, 0);
  assert.match(j.command(["result", j.id]).stdout, /ended before turn\/completed/);
  assert.equal(fs.existsSync(path.join(j.dir, "report.md")), false);
});

test("rejected server request records method and id", async t => {
  const j = await turnJob(t, "turn-order-server-request");
  const job = await j.done();
  assert.equal(job.state, "completed");
  const rejected = j.events().filter(e => e.method === "codex/serverRequestRejected");
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0].params, { method: "item/tool/requestUserInput", id: "input-request-1", code: -32601 });
  assert.deepEqual(j.ctx.fakeState().serverRequestRejections, [{ id: "input-request-1", error: { code: -32601, message: "Unsupported server request: item/tool/requestUserInput" } }]);
  assert.match(j.command(["result", j.id]).stdout, /Report for: First task/);
});


test("main-thread completion must match the exact turn id", async t => {
  const j = await turnJob(t, "turn-order-wrong-turn");
  await waitFor(() => j.events().some(e => e.params?.turn?.id === "unrelated"));
  assert.equal(j.job().state, "running");
  assert.equal(fs.existsSync(path.join(j.dir, "report.md")), false);
  const job = await j.done();
  assert.equal(job.state, "completed");
  assert.equal(j.events().filter(e => e.method === "turn/completed" && e.params.turn.id === job.turnId).length, 1);
  assert.match(j.command(["result", j.id]).stdout, /Report for: First task/);
});

for (const status of ["completed", "failed", "interrupted"]) {
  test(`terminal start response ${status}`, async t => {
    const j = await turnJob(t, `turn-order-terminal-start-${status}`);
    const job = await j.done();
    assert.equal(job.state, status === "completed" ? "completed" : "failed");
    assert.equal(j.events().filter(e => e.method === "turn/completed").length, 0);
    assert.equal(j.events().filter(e => e.method === "codex/turnCompletionInferred").length, 0);
    const output = j.command(["result", j.id]).stdout;
    assert.doesNotMatch(output, /turn completion inferred/);
    if (status === "completed") assert.match(output, /Terminal response report/);
    else assert.match(output, /^report: none$/m);
  });
}

test("a silent thread/read fails on deadline and keeps the report", async t => {
  const j = await turnJob(t, "turn-order-collab-silent", { RELAY_JOBS_THREAD_READ_TIMEOUT_MS: "100" });
  await waitFor(() => j.ctx.fakeState().threadReads?.length === 1);
  const job = await j.done();
  assert.equal(job.state, "failed");
  assert.equal(job.errorMessage, "thread/read: no reply in 0.1 s");
  assert.match(fs.readFileSync(path.join(j.dir, "report.md"), "utf8"), /Candidate report/);
  assert.equal(j.events().filter(e => e.method === "codex/turnCompletionInferred").length, 0);
  assert.equal(j.command(["result", j.id]).status, 3);
});

// MockTimers' object API is unavailable on supported Node 18 and early Node 20.
function timerTest(name, body) {
  test(name, t => {
    if (Number(process.versions.node.split(".")[0]) < 20) {
      t.skip(`Node ${process.versions.node} lacks the MockTimers object API`);
      return;
    }
    try {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.timers.reset();
    } catch {
      t.skip(`Node ${process.versions.node} lacks the MockTimers object API`);
      return;
    }
    return body(t);
  });
}

// Controlled protocol ordering keeps the sampling-boundary tests independent of
// process startup and scheduler load. The integration cases above cover job storage.
async function turnCapture(t, read = () => ({ thread: { turns: [{ id: "other", status: "failed" }, { id: "turn", status: "completed" }] } })) {
  const { runTurnOnThread } = await import("../plugins/relay/scripts/lib/backends/codex/turn.mjs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let end, result, now = 0;
  const events = [], reads = [], steers = [];
  const steerTracker = { turnSteerHandler: null };
  const client = {
    stderr: "", notificationHandler: null, transportEnded: false,
    exitPromise: new Promise(resolve => { end = resolve; }),
    setNotificationHandler(handler) { this.notificationHandler = handler; },
    tap(notification) {
      events.push({ ...notification, at: now });
    },
    async request(method, params) {
      if (method === "turn/start") return { turn: { id: "turn", status: "inProgress" } };
      if (method === "thread/read") {
        reads.push({ ...params, at: now });
        return read(reads.length);
      }
      assert.equal(method, "turn/steer");
      steerTracker.turnSteerHandler?.("requested", params);
      const accepted = await new Promise(resolve => steers.push(resolve));
      steerTracker.turnSteerHandler?.("settled", params, accepted);
      return { turnId: "turn" };
    }
  };
  const completion = runTurnOnThread(client, "root", { prompt: "First task", steerTracker }).then(value => { result = value; return value; });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = async ms => { now += ms; t.mock.timers.tick(ms); await flush(); };
  await flush();
  const emit = (method, params) => {
    const event = { method, params };
    events.push(event);
    client.notificationHandler?.(event);
  };
  const item = (value, lifecycle = "completed", threadId = "root", turnId = "turn") => emit(`item/${lifecycle}`, { threadId, turnId, item: value });
  const collab = ({ itemActive = false, childActive = false } = {}) => {
    const value = { type: "collabAgentToolCall", id: "collab", status: "inProgress", receiverThreadIds: ["child"] };
    item(value, "started");
    emit("turn/started", { threadId: "child", turn: { id: "child-turn", status: "inProgress" } });
    if (!childActive) emit("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "completed" } });
    if (!itemActive) item({ ...value, status: "completed" });
  };
  const candidate = (text = "Candidate report") => item({ type: "agentMessage", id: "answer", phase: "final_answer", text });
  const finish = (status = "completed") => emit("turn/completed", { threadId: "root", turn: { id: "turn", status } });
  t.after(async () => { if (!result) { end(); await flush(); } });
  return { client, events, reads, collab, candidate, item, emit, finish, tick, flush, completion, result: () => result,
    steer: () => client.request("turn/steer", { threadId: "root", expectedTurnId: "turn" }),
    settleSteer: async accepted => { steers.shift()(accepted); await flush(); },
    end: async () => { end(); await flush(); } };
}

for (const [message, succeeds] of [
  ["unknown variant `thread/read`, expected a method", true],
  ["thread/read: unknown variant `waiting`, expected a status", false],
  ["unknown variant `thread/reading`, expected a method", false],
  ["unknown method thread/read", false]
]) {
  timerTest(`unsupported read classification for ${message}`, async t => {
    const h = await turnCapture(t, () => { throw new Error(message + "\nextra detail"); });
    h.collab(); h.candidate();
    await h.tick(250);
    const result = await h.completion;
    assert.equal(result.turnStatus, succeeds ? "completed" : "failed");
    assert.equal(result.finalMessage, "Candidate report");
    assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, succeeds ? 1 : 0);
    if (!succeeds) assert.equal(result.error.message, `thread/read: ${message}`);
  });
}

for (const guard of ["item", "child"]) {
  timerTest(`active ${guard} prevents inference`, async t => {
    const h = await turnCapture(t);
    h.collab({ itemActive: guard === "item", childActive: guard === "child" });
    h.candidate();
    await h.tick(1000);
    assert.equal(h.result(), undefined);
    assert.equal(h.reads.length, 0);
    assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, 0);
    h.finish();
    assert.equal((await h.completion).turnStatus, "completed");
  });
}

timerTest("candidate during pending steer does not infer", async t => {
  const h = await turnCapture(t);
  h.collab();
  const steer = h.steer();
  h.candidate();
  await h.tick(1000);
  assert.equal(h.result(), undefined);
  assert.equal(h.reads.length, 0);
  await h.settleSteer(true);
  await steer;
  h.finish();
  assert.equal((await h.completion).turnStatus, "completed");
});

timerTest("accepted steer cancels a valid candidate", async t => {
  const h = await turnCapture(t);
  h.collab({ childActive: true }); h.candidate();
  await h.tick(100);
  const steer = h.steer();
  await h.settleSteer(true); await steer;
  h.emit("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "completed" } });
  await h.tick(1000);
  assert.equal(h.result(), undefined);
  assert.equal(h.reads.length, 0);
  h.candidate("Correction executed"); h.finish();
  assert.equal((await h.completion).finalMessage, "Correction executed");
});

timerTest("fresh candidate ignores the cancelled candidate's stale read", async t => {
  const replies = [];
  const h = await turnCapture(t, () => new Promise(resolve => replies.push(resolve)));
  h.collab(); h.candidate("Old candidate");
  await h.tick(250);
  assert.equal(h.reads.length, 1);
  h.item({ type: "agentMessage", id: "resumed", phase: "commentary", text: "Resuming work" }, "started");
  h.candidate("Fresh candidate");
  await h.tick(250);
  assert.equal(h.reads.length, 2);
  replies[0]({ thread: { turns: [{ id: "turn", status: "failed" }] } });
  await h.flush();
  assert.equal(h.result(), undefined);
  assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, 0);
  replies[1]({ thread: { turns: [{ id: "turn", status: "completed" }] } });
  const result = await h.completion;
  assert.equal(result.turnStatus, "completed");
  assert.equal(result.finalMessage, "Fresh candidate");
  assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, 1);
});

timerTest("completion at 100ms beats the sampling window", async t => {
  const h = await turnCapture(t);
  h.collab(); h.candidate();
  await h.tick(100);
  h.finish("failed");
  assert.equal((await h.completion).turnStatus, "failed");
  await h.tick(1000);
  assert.equal(h.reads.length, 0);
  assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, 0);
});

timerTest("inference waits the full 250ms window", async t => {
  const h = await turnCapture(t);
  h.collab(); h.candidate();
  await h.tick(200);
  assert.equal(h.result(), undefined);
  assert.equal(h.reads.length, 0);
  await h.tick(49);
  assert.equal(h.result(), undefined);
  assert.equal(h.reads.length, 0);
  await h.tick(1);
  assert.equal(h.result()?.turnStatus, "completed");
  assert.equal((await h.completion).turnStatus, "completed");
  assert.equal(h.reads[0].at, 250);
  assert.equal(h.events.find(e => e.method === "codex/turnCompletionInferred").at, 250);
});

timerTest("stdout EOF blocks inference while process close is pending", async t => {
  const h = await turnCapture(t);
  h.collab(); h.candidate();
  await h.tick(100);
  h.client.transportEnded = true;
  await h.tick(1000);
  assert.equal(h.result(), undefined);
  assert.equal(h.reads.length, 0);
  await h.end();
  assert.equal((await h.completion).turnStatus, "failed");
  assert.match(h.result().error.message, /ended before turn\/completed/);
  assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, 0);
});

timerTest("rejected steer resamples a still-valid candidate", async t => {
  const h = await turnCapture(t, () => { throw new Error("unknown variant thread/read"); });
  h.collab(); h.candidate();
  await h.tick(100);
  const steer = h.steer();
  await h.tick(1000);
  assert.equal(h.result(), undefined);
  await h.settleSteer(false); await steer;
  await h.tick(249);
  assert.equal(h.reads.length, 0);
  await h.tick(1);
  assert.equal(h.result()?.turnStatus, "completed");
  assert.equal((await h.completion).turnStatus, "completed");
  const event = h.events.find(e => e.method === "codex/turnCompletionInferred");
  assert.deepEqual(event.params, { threadId: "root", turnId: "turn", status: "completed", source: "unsupported", reason: "method unsupported" });
});

timerTest("read selects exact turn over unrelated first status", async t => {
  const h = await turnCapture(t, () => ({ thread: { turns: [{ id: "other", status: "completed" }, { id: "turn", status: "interrupted" }] } }));
  h.collab(); h.candidate();
  await h.tick(250);
  assert.equal((await h.completion).turnStatus, "interrupted");
  assert.deepEqual(h.reads[0], { threadId: "root", includeTurns: true, at: 250 });
  const event = h.events.find(e => e.method === "codex/turnCompletionInferred");
  assert.equal(event.params.source, "thread/read");
  assert.equal(event.params.threadId, "root");
});

timerTest("default thread/read deadline is ten seconds", async t => {
  const h = await turnCapture(t, () => new Promise(() => {}));
  h.collab(); h.candidate();
  await h.tick(250);
  await h.tick(9999);
  assert.equal(h.result(), undefined);
  await h.tick(1);
  assert.equal(h.result()?.turnStatus, "failed");
  const result = await h.completion;
  assert.equal(result.turnStatus, "failed");
  assert.equal(result.error.message, "thread/read: no reply in 10 s");
  assert.equal(result.finalMessage, "Candidate report");
});

test("the Codex event log keeps only a turn's last diff, by thread and turn, before that turn's turn/completed", async () => {
  const { codexEventRecorder } = await import("../plugins/relay/scripts/lib/backends/codex/index.mjs");
  const written = [];
  let touched = 0;
  const recorder = codexEventRecorder((n) => written.push(n), () => { touched += 1; });
  const diff = (threadId, turnId, text) => ({ method: "turn/diff/updated", params: { threadId, turnId, diff: text } });
  const completed = (threadId, turnId) => ({ method: "turn/completed", params: { threadId, turn: { id: turnId } } });
  const shown = () => written.map((n) => n.params.diff ?? `${n.method} ${n.params.threadId}`);
  // A parent turn's diffs interleave with a subagent's turn, which completes first.
  for (const n of [diff("p", "a", "1"), { method: "item/completed", params: { threadId: "p", turnId: "a" } }, diff("c", "x", "c1"), diff("p", "a", "12"),
    completed("c", "x"), diff("p", "a", "123"), completed("p", "a"), diff("p", "b", "2"), diff("c", "y", "c2")]) recorder.record(n);
  assert.deepEqual(shown(), ["item/completed p", "c1", "turn/completed c", "123", "turn/completed p"]);
  recorder.flush();
  assert.deepEqual(shown().slice(5), ["2", "c2"], "the worker's end writes each turn's last diff");
  recorder.flush();
  assert.equal(written.length, 7);
  assert.equal(touched, 9, "every notification still advances the heartbeat");
});

// Offline protocol contracts: only the installed fake runs, never a real model/backend.
const codexSchema = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-app-server-schema/contract.json", import.meta.url), "utf8"));

// The fixture uses this subset of draft-07. Keep validation local: no installs, and
// no dependency on a Codex binary being present when the normal test suite runs.
function schemaErrors(schema, value, at = "$", errors = []) {
  if (schema === true) return errors;
  if (schema === false) { errors.push(`${at}: forbidden`); return errors; }
  if (schema.$ref) return schemaErrors(codexSchema.definitions[schema.$ref.split("/").at(-1)], value, at, errors);
  const typeOf = type => type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
    : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "integer" ? Number.isInteger(value) : typeof value === type;
  if (schema.type && ![schema.type].flat().some(typeOf)) {
    errors.push(`${at}: expected ${schema.type}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) errors.push(`${at}: enum rejects ${JSON.stringify(value)}`);
  for (const branch of schema.allOf ?? []) schemaErrors(branch, value, at, errors);
  for (const keyword of ["oneOf", "anyOf"]) {
    if (!schema[keyword]) continue;
    const matches = schema[keyword].filter(branch => schemaErrors(branch, value, at).length === 0).length;
    if (keyword === "oneOf" ? matches !== 1 : matches === 0) errors.push(`${at}: ${keyword} matched ${matches} branches`);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
    for (const [key, entry] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      if (child !== undefined) schemaErrors(child, entry, `${at}.${key}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((entry, i) => schemaErrors(schema.items, entry, `${at}[${i}]`, errors));
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
  if (typeof value === "string" && schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${at}: too short`);
  return errors;
}

function assertSchema(name, value) {
  assert.deepEqual(schemaErrors(codexSchema.schemas[name], value), [], `${codexSchema.codexVersion} ${name}`);
}

async function fakeReadPeer(t, scenario) {
  const { spawn } = await import("node:child_process");
  const bin = makeTempDir("relay-codex-schema-");
  installFakeCodex(bin, `turn-order-collab-${scenario}`);
  const child = spawn(process.execPath, [path.join(bin, "codex"), "app-server"], {
    cwd: bin,
    env: { ...process.env, HOME: bin, USERPROFILE: bin, CODEX_HOME: bin },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "", stderr = "", closed = false, nextId = 0;
  const replies = new Map(), notifications = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (Object.hasOwn(message, "id")) replies.set(message.id, message);
      else notifications.push(message);
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("close", () => { closed = true; });
  t.after(async () => {
    child.stdin.destroy();
    if (!closed) child.kill("SIGKILL");
    await waitFor(() => closed);
  });
  const request = async (method, params) => {
    const sent = { id: ++nextId, method, params };
    child.stdin.write(JSON.stringify(sent) + "\n");
    await waitFor(() => closed || replies.has(sent.id));
    assert.ok(replies.has(sent.id), `${method}: fake exited: ${stderr}`);
    return { sent, response: replies.get(sent.id) };
  };
  await request("initialize", { clientInfo: { name: "schema-contract", version: "1" } });
  const { response: opened } = await request("thread/start", { cwd: bin });
  const threadId = opened.result.thread.id;
  const { response: started } = await request("turn/start", { threadId, input: [{ type: "text", text: "Schema contract" }] });
  const turnId = started.result.turn.id;
  return {
    threadId, turnId, notifications,
    async read(...options) {
      const includeTurns = options.length ? options[0] : true;
      const pending = request("thread/read", { threadId, ...(includeTurns === undefined ? {} : { includeTurns }) });
      if (scenario === "read-race") await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "Finish" }] });
      return pending;
    }
  };
}

test("Codex schema contract: fake thread/read requests and results", async t => {
  for (const status of ["completed", "failed", "interrupted", "inProgress", "missing", "read-race"]) {
    await t.test(status, async t => {
      const peer = await fakeReadPeer(t, status);
      const { sent, response } = await peer.read();
      assertSchema("ThreadReadRequest", sent);
      assertSchema("JSONRPCResponse", response);
      assertSchema("ThreadReadResponse", response.result);
      const items = peer.notifications.filter(message => ["item/started", "item/completed"].includes(message.method));
      assert.ok(items.some(message => message.params.item.type === "collabAgentToolCall"));
      for (const notification of items) assertSchema(notification.method, notification);
      assert.equal(response.id, sent.id);
      assert.equal(response.result.thread.id, peer.threadId);
      const turn = response.result.thread.turns.find(turn => turn.id === peer.turnId);
      if (status === "missing") assert.equal(turn, undefined);
      else assert.equal(turn.status, status === "read-race" ? "completed" : status);
    });
  }
});

test("Codex schema contract: fake metadata-only thread/read omits turns", async t => {
  const peer = await fakeReadPeer(t, "completed");
  // includeTurns defaults to false in Codex; an omitted field is also a valid request.
  for (const includeTurns of [false, undefined]) {
    const { sent, response } = await peer.read(includeTurns);
    assertSchema("ThreadReadRequest", sent);
    assertSchema("ThreadReadResponse", response.result);
    assert.deepEqual(response.result.thread.turns, []);
  }
});

test("Codex schema contract: fake thread/read RPC error envelopes", async t => {
  for (const scenario of ["unsupported", "unknown-method", "read-error", "unknown-variant-status", "unsupported-text"]) {
    await t.test(scenario, async t => {
      const peer = await fakeReadPeer(t, scenario);
      const { sent, response } = await peer.read();
      assertSchema("ThreadReadRequest", sent);
      assertSchema("JSONRPCError", response);
      assert.equal(response.id, sent.id);
      assert.equal(Object.hasOwn(response, "result"), false);
      // Error code meanings and message text are not constrained by this schema.
    });
  }
});

test("Codex schema contract: unknown-status is an intentional malformed response", async t => {
  const peer = await fakeReadPeer(t, "unknown-status");
  const { sent, response } = await peer.read();
  assertSchema("ThreadReadRequest", sent);
  assertSchema("JSONRPCResponse", response);
  assert.deepEqual(schemaErrors(codexSchema.schemas.ThreadReadResponse, response.result), [
    '$.thread.turns[1].status: enum rejects "waiting"'
  ]);
});

timerTest("Codex schema contract: relay consumes schema-valid collaborator notifications", async t => {
  const thread = { id: "root", cliVersion: "0.163.0", createdAt: 0, updatedAt: 0,
    cwd: "/tmp", ephemeral: false, modelProvider: "openai", preview: "", projectId: null,
    sessionId: "session", source: "appServer", status: { type: "idle" },
    turns: [{ id: "turn", items: [], status: "completed" }] };
  const response = { thread };
  assertSchema("ThreadReadResponse", response);
  assert.deepEqual(codexSchema.definitions.TurnStatus.enum, ["completed", "interrupted", "failed", "inProgress"]);
  assert.deepEqual(codexSchema.definitions.ThreadStatus.oneOf.map(s => s.properties.type.enum[0]), ["notLoaded", "idle", "systemError", "active"]);
  const h = await turnCapture(t, () => response);
  const emit = (method, params) => {
    assertSchema(method, { method, params });
    h.emit(method, params);
  };
  emit("thread/started", { thread: { ...thread, turns: [] } });
  emit("thread/name/updated", { threadId: "root", threadName: "Contract" });
  emit("turn/started", { threadId: "root", turn: { id: "turn", items: [], status: "inProgress" } });
  const item = { type: "collabAgentToolCall", id: "collab", senderThreadId: "root",
    receiverThreadIds: ["child"], agentsStates: {}, tool: "spawnAgent", status: "inProgress" };
  emit("item/started", { threadId: "root", turnId: "turn", startedAtMs: 0, item });
  emit("turn/started", { threadId: "child", turn: { id: "child-turn", items: [], status: "inProgress" } });
  emit("turn/completed", { threadId: "child", turn: { id: "child-turn", items: [], status: "completed" } });
  emit("item/completed", { threadId: "root", turnId: "turn", completedAtMs: 1, item: { ...item, status: "completed" } });
  emit("item/completed", { threadId: "root", turnId: "turn", completedAtMs: 2,
    item: { type: "agentMessage", id: "answer", text: "Schema-valid answer", phase: "final_answer" } });
  await h.tick(250);
  assert.equal(h.reads.length, 1);
  const { at, ...params } = h.reads[0];
  assertSchema("ThreadReadRequest", { id: 1, method: "thread/read", params });
  assert.equal(params.includeTurns, true);
  const result = await h.completion;
  assert.equal(result.turnStatus, "completed");
  assert.equal(result.finalMessage, "Schema-valid answer");
  assert.equal(h.events.filter(e => e.method === "codex/turnCompletionInferred").length, 1);
});
