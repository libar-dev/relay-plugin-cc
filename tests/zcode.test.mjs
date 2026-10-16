import { scriptedConnection } from "./support/backend-connection.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchRequest, parseHeaderPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { zcodeEventRecorder } from "../plugins/relay/scripts/lib/backends/zcode/connection.mjs";
import { companion, finishJob, jobDir, jobDirs, promptFile, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { installFakeZcode } from "./fakes/zcode.mjs";

const HEADER = "backend: zcode\nmodel: glm-5.3\neffort: default";
const UNATTENDED = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Agent", "SendMessage", "CronCreate", "CronDelete", "CronList", "CronUpdate", "ReadSessionContext"];
const WRITING = ["Write", "Edit", "Bash", "TaskStop", "mcp__node_repl__js"];
const WEB = ["WebSearch", "WebFetch", "mcp__web_reader__webReader"];
const READING = ["Read", "Skill", "TaskOutput", "TodoRead", "TodoWrite", "mcp__4_5v_mcp__analyze_image"];
const PREFERENCES = { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" };

function fixture(t, options = {}) {
  const ctx = setup(t);
  const fake = installFakeZcode(ctx.bin, options);
  ctx.env.ZCODE_BINARY = fake.binary;
  ctx.env.ZCODE_APP_SERVER_AUTH_MODE = "host";
  ctx.env.RELAY_JOBS_CAPACITY_DELAYS_MS = "1";
  ctx.env.RELAY_JOBS_ZCODE_DUPLICATE_MS = "20";
  ctx.env.RELAY_JOBS_ZCODE_UNRESOLVED_MS = "200";
  ctx.zcode = fake.state;
  ctx.fakeState = path.join(ctx.bin, "fake-zcode-state.json");
  return ctx;
}
const report = (ctx, id) => fs.readFileSync(path.join(jobDir(ctx, id), "report.md"), "utf8");
const events = (ctx, id) => fs.readFileSync(path.join(jobDir(ctx, id), "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const commands = (ctx, type) => ctx.zcode().requests.filter(r => r.method === "v4/command" && r.params.type === type);

test("header rules: refused combinations fail before a job or a server exists; effort defaults to high", t => {
  const ctx = fixture(t);
  for (const extra of ["mode: write", "grok-home: default", "web-search: cached", "web-search: indexed"]) {
    const result = companion(ctx, ["start", "--prompt-file", promptFile(ctx, `${HEADER}\n${extra}`)]);
    assert.equal(result.status, 1, `${extra}: ${result.stdout}`);
  }
  assert.match(companion(ctx, ["start", "--prompt-file", promptFile(ctx, `${HEADER}\nmode: write`)]).stderr, /no workspace sandbox.*mode: yolo/);
  assert.equal(jobDirs(ctx).length, 0);
  assert.equal(fs.existsSync(ctx.fakeState), false);
  assert.throws(() => buildLaunchRequest({ model: "default", effort: "default", backend: "other" }), /codex, grok, zcode or kimi/);
  const request = buildLaunchRequest({ model: "default", effort: "default", backend: "zcode", fast: "true", mode: "read-only", network: "true" }, { baseDir: ctx.work });
  assert.equal(request.backend, "zcode");
  assert.equal(request.effort, "high");
  assert.equal(request.model, null);
  assert.equal(request.fast, false);
  assert.ok(request.notes.some(note => /ignored for ZCode/.test(note)));
  assert.ok(request.notes.some(note => /ZCode has no sandbox/.test(note)));
  assert.equal(buildLaunchRequest({ model: "default", effort: "low", backend: "zcode" }, { baseDir: ctx.work }).effort, "low");
  assert.equal(buildLaunchRequest({ model: "default", effort: "default" }, { baseDir: ctx.work }).effort, null);
  assert.equal(parseHeaderPrompt(`${HEADER}\n---\nx`).header.backend, "zcode");
});

test("a turn completes with its report; every request carries the job's settings; continue and resume reopen the session", async t => {
  const ctx = fixture(t);
  const started = companion(ctx, ["start", "--json", "--prompt-file", promptFile(ctx, HEADER, "[quick] First.")]);
  const { jobId: id, backend } = JSON.parse(started.stdout);
  assert.equal(backend, "zcode");
  await finishJob(ctx, id);
  assert.equal(report(ctx, id), "Report for: [quick] First.\n");
  const job = readJob(ctx, id);
  assert.equal(job.backendState.binary, fs.realpathSync(ctx.env.ZCODE_BINARY));
  assert.equal(job.sessionId, "sess_1");
  assert.equal(job.request.effort, "high");
  const state = ctx.zcode();
  const cwd = fs.realpathSync(ctx.work);
  assert.deepEqual(state.starts[0].args, ["app-server"]);
  assert.equal(state.starts[0].env.ZCODE_APP_SERVER_AUTH_MODE, undefined);
  assert.deepEqual(state.requests[0], { id: 1, method: "runtime/capabilities", params: {} });
  assert.ok(state.requests.filter(r => r.method === "v4/command").every(r => r.params.clientId === "relay-plugin" && typeof r.params.issuedAt === "number"));
  assert.deepEqual(commands(ctx, "createSession")[0].params.payload, { workspaceId: cwd, config: { mode: "yolo" } });
  assert.equal(commands(ctx, "createSession")[0].params.sessionId, null);
  assert.deepEqual(state.sessions.sess_1.preferences, PREFERENCES);
  assert.deepEqual(state.requests.find(r => r.method === "session/subscribe").params, { sessionId: "sess_1", deliveryKind: "desktop-continuous", includeSnapshot: true });
  const [first] = state.inputs;
  assert.equal(first.commandId, `brief-${id}`);
  assert.equal(first.delivery, "startNow");
  assert.equal(first.mode, "yolo");
  assert.equal(first.heldQueueDisposition, "clearQueueAndSend");
  assert.deepEqual(first.modelSelection, { providerId: "account:fake-plan", modelId: "GLM-5.3", options: { reasoningLevel: "high" } });
  assert.deepEqual(first.toolDisallowlist, UNATTENDED);
  const recorded = events(ctx, id);
  assert.ok(recorded.some(e => e.params?.type === "turn.completed"));
  assert.ok(recorded.some(e => e.params?.type === "tool.updated" && e.params.payload.kind === "started"));
  assert.ok(!recorded.some(e => e.params?.type === "model.streaming" || e.params?.payload?.kind === "progress" || e.method === "v4/telemetry/event"));
  for (const command of ["continue", "resume"]) {
    assert.equal(companion(ctx, [command, id, "--message", `[quick] ${command}.`]).status, 0);
    await finishJob(ctx, id);
    assert.equal(report(ctx, id), `Report for: [quick] ${command}.\n`);
  }
  const resumes = ctx.zcode().requests.filter(r => r.method === "session/resume");
  assert.equal(resumes.length, 2);
  for (const resume of resumes) assert.deepEqual(resume.params, { sessionId: "sess_1", workspace: { workspacePath: cwd, workspaceKey: cwd }, toolDenylist: UNATTENDED });
  assert.equal(commands(ctx, "createSession").length, 1);
  assert.match(companion(ctx, ["result", id]).stdout, /^backend: zcode$/m);
  assert.equal(JSON.parse(companion(ctx, ["result", id, "--json"]).stdout).backend, "zcode");
});

test("a running steer is a guide drained into the turn by either id field; an idle steer runs the next turn", async t => {
  for (const drainIds of ["drained", "pending"]) {
    const ctx = fixture(t, { turnMs: 700, drainIds });
    const { id } = startJob(ctx, HEADER, "First.");
    await waitFor(() => readJob(ctx, id).turnId);
    assert.equal(companion(ctx, ["steer", id, "--message", "Mid-turn."]).status, 0);
    await finishJob(ctx, id);
    assert.equal(report(ctx, id), "Report for: First.\nSteered with: Mid-turn.\n");
    const steer = readJob(ctx, id).messages.filter(m => m.kind === "steer");
    assert.deepEqual(steer.map(m => m.action), ["steered"]);
    assert.equal(steer[0].turnId, "turn-1");
    assert.deepEqual(ctx.zcode().inputs.map(input => [input.delivery, input.active]), [["startNow", false], ["guide", true]]);
    const guide = ctx.zcode().inputs[1];
    assert.deepEqual([guide.modelSelection, guide.mode, guide.toolDisallowlist, guide.heldQueueDisposition], [ctx.zcode().inputs[0].modelSelection, "yolo", UNATTENDED, "clearQueueAndSend"]);
    assert.ok(!events(ctx, id).some(e => e.method === "zcode/inputsUnresolved"));
    assert.equal(readJob(ctx, id).attempts.length, 1);
    assert.equal(companion(ctx, ["steer", id, "--message", "[quick] After."]).status, 0);
    await finishJob(ctx, id);
    assert.equal(ctx.zcode().inputs.at(-1).delivery, "startNow");
    assert.equal(report(ctx, id), "Report for: [quick] After.\n");
  }
});

test("a guide that misses its turn runs as ZCode's next turn, and that turn owns the report", async t => {
  const ctx = fixture(t, { turnMs: 500, guideMiss: true });
  const { id } = startJob(ctx, HEADER, "First.");
  await waitFor(() => readJob(ctx, id).turnId);
  assert.equal(companion(ctx, ["steer", id, "--message", "[quick] Missed."]).status, 0);
  await finishJob(ctx, id);
  assert.equal(report(ctx, id), "Report for: [quick] Missed.\n");
  assert.deepEqual(ctx.zcode().turns.map(turn => turn.text), ["First.", "[quick] Missed."]);
  assert.equal(readJob(ctx, id).attempts.length, 1);
});

test("cancel stops the turn through ZCode; the job is cancelled without a kill", async t => {
  const ctx = fixture(t, { turnMs: 30000 });
  const { id } = startJob(ctx, HEADER, "Wait.");
  await waitFor(() => readJob(ctx, id).turnId);
  const cancel = companion(ctx, ["cancel", id]);
  assert.doesNotMatch(cancel.stdout, /killed the worker/);
  await finishJob(ctx, id, 5);
  const job = readJob(ctx, id);
  assert.equal(job.state, "cancelled");
  assert.equal(job.attempts.at(-1).state, "cancelled");
  assert.deepEqual(job.messages.map(m => m.action), ["interrupt-sent", "cancelled"]);
  assert.equal(commands(ctx, "stop").length, 1);
  assert.ok(events(ctx, id).some(e => e.params?.type === "turn.completed" && e.params.payload.resultType === "cancelled"));
});

test("a server death mid-turn is recovered on the same session without resending the brief; a second death fails with the reason", async t => {
  const ctx = fixture(t, { die: true, dieTurns: 1 });
  const { id } = startJob(ctx, HEADER, "Brief.");
  await finishJob(ctx, id);
  const job = readJob(ctx, id);
  assert.equal(job.state, "completed");
  assert.equal(job.automaticResumes.length, 1);
  assert.match(job.attempts[0].transportErrors[0], /zcode app-server ended before the turn finished \(exit 17\)/);
  const turns = ctx.zcode().turns.map(turn => turn.commandId);
  assert.equal(turns.filter(commandId => commandId === `brief-${id}`).length, 1);
  assert.equal(turns.length, 2);
  assert.equal(ctx.zcode().requests.filter(r => r.method === "session/resume").length, 1);
  const dead = fixture(t, { die: true, dieTurns: 5 });
  const launched = startJob(dead, HEADER, "Exit.");
  await finishJob(dead, launched.id, 3);
  assert.match(readJob(dead, launched.id).errorMessage, /zcode app-server ended.*exit 17/);
  assert.match(readJob(dead, launched.id).errorMessage, /fake zcode death/);
});

test("a message ZCode admitted but discarded with its process runs once under a new id", async t => {
  const ctx = fixture(t, { dieAfterAdmit: true });
  const { id } = startJob(ctx, HEADER, "[quick] Admitted then lost.");
  await finishJob(ctx, id);
  assert.deepEqual(ctx.zcode().turns.filter(turn => turn.text === "[quick] Admitted then lost.").map(turn => turn.commandId), [`brief-${id}~1`]);
  const briefs = ctx.zcode().requests.filter(r => r.params?.type === "sendText" && r.params.payload.text === "[quick] Admitted then lost.");
  assert.deepEqual(briefs.map(r => r.params.commandId), [`brief-${id}`, `brief-${id}`, `brief-${id}~1`]);
  assert.equal(readJob(ctx, id).state, "completed");
});

test("modes: read-only removes writing tools and allows permission only for reading tools; reverse requests are answered", async t => {
  for (const [mode, webSearch] of [["yolo", "disabled"], ["read-only", "disabled"], ["read-only", "live"]]) {
    const ctx = fixture(t, { permissions: ["Bash", "Read", "WebSearch", "Agent"], userInput: true, mcpAuth: true, unsupported: true, browser: true });
    const { id } = startJob(ctx, `${HEADER}\nmode: ${mode}\nweb-search: ${webSearch}`, "[quick] Mode.");
    await finishJob(ctx, id);
    await waitFor(() => ctx.zcode().replies.length === 8);
    const state = ctx.zcode();
    const decision = toolName => state.replies.find(r => r.toolName === toolName).reply.decision;
    const label = `${mode}/${webSearch}`;
    assert.equal(commands(ctx, "createSession")[0].params.payload.config.mode, mode === "yolo" ? "yolo" : "build", label);
    assert.equal(state.inputs[0].mode, mode === "yolo" ? "yolo" : "build", label);
    assert.deepEqual(state.inputs[0].toolDisallowlist, [...UNATTENDED, ...(webSearch === "disabled" ? WEB : []), ...(mode === "yolo" ? [] : WRITING)], label);
    assert.equal(decision("Bash"), mode === "yolo" ? "allow" : "deny", label);
    assert.equal(decision("Agent"), mode === "yolo" ? "allow" : "deny", label);
    assert.equal(decision("Read"), "allow", label);
    assert.equal(decision("WebSearch"), mode === "yolo" || webSearch === "live" ? "allow" : "deny", label);
    assert.equal(state.replies.find(r => r.method === "interaction/requestUserInput").reply.action, "decline");
    assert.deepEqual(state.replies.find(r => r.method === "interaction/requestOfficialMcpAuthHeaders").reply, { ok: false, reason: "official_auth_unavailable" });
    assert.equal(state.replies.find(r => r.method === "client/missing").reply.error.code, -32601);
    assert.deepEqual(state.replies.find(r => r.method === "interaction/browserList").reply.error, { code: -32601, message: "Browser control is not available in a plugin job; use the shell or the web tools." });
    assert.ok(events(ctx, id).some(e => e.method === "zcode/serverRequestRejected" && e.params.method === "client/missing"));
    assert.equal(state.sessions.sess_1.preferences.nativeSearchEnhancementsEnabled, webSearch === "live");
    assert.equal(companion(ctx, ["continue", id, "--message", "[quick] Again."]).status, 0);
    await finishJob(ctx, id);
    const resume = ctx.zcode().requests.find(r => r.method === "session/resume");
    assert.deepEqual(resume.params.toolAllowlist, mode === "yolo" ? undefined : [...READING, ...(webSearch === "live" ? WEB : [])], label);
  }
});

test("failed turns, refusals and a server that will not start fail the job with ZCode's words", async t => {
  for (const [options, expected] of [
    [{ failTurn: "Model creation failed", failUnderlying: "Provider Registry has no Model: account:fake-plan/GLM-9" }, /^Model creation failed\nProvider Registry has no Model.*\ncode model_not_found$/],
    [{ resultType: "error_max_turns" }, /the turn ended with result error_max_turns/],
    [{ rejectSend: true }, /ZCode refused the message \(rejected, proto.fake\): fake refusal/],
    [{ rejectCreate: true }, /ZCode refused the new session \(failed, fault.command.executionFailed\): fake create refusal/],
    [{ dieInitialize: true }, /zcode app-server ended.*exit 19[\s\S]*refused to start/]
  ]) {
    const ctx = fixture(t, options);
    const { id } = startJob(ctx, HEADER);
    await finishJob(ctx, id, 3);
    assert.equal(readJob(ctx, id).state, "failed");
    assert.match(readJob(ctx, id).errorMessage, expected);
    if (options.rejectCreate) assert.equal(ctx.zcode().requests.filter(r => r.method === "session/subscribe" || r.params?.type === "sendText").length, 0);
  }
});

test("setup --backend zcode reports version, credentials, the default model and every model the sign-in serves, from a draft it closes", t => {
  const ctx = fixture(t);
  const credentials = path.join(ctx.user, ".zcode", "v2", "credentials.json");
  const setupJson = (env = {}) => { const result = companion(ctx, ["setup", "--backend", "zcode", "--json"], env); const page = JSON.parse(result.stdout); return { status: result.status, page, block: page.backends[0] }; };
  let result = setupJson();
  assert.equal(result.status, 1);
  assert.equal(result.page.ready, false);
  assert.deepEqual(result.block.signIn, { state: "signed-out", method: null, detail: `no credentials at ${credentials} (run zcode login)` });
  fs.mkdirSync(credentials, { recursive: true });
  assert.equal(setupJson().block.signIn.state, "signed-out");
  fs.rmdirSync(credentials);
  fs.writeFileSync(credentials, "{}");
  assert.equal(setupJson().block.signIn.state, "signed-out");
  // Signed out: no server is started.
  assert.equal(ctx.zcode().starts.length, 0);
  fs.writeFileSync(credentials, '{"encrypted":"x"}');
  fs.writeFileSync(path.join(ctx.user, ".zcode", "v2", "provider_config.json"), JSON.stringify({ config: { defaultModelSelection: { providerId: "account:fake-plan", modelId: "GLM-5.3" } } }));
  result = setupJson();
  assert.equal(result.status, 0);
  assert.equal(result.page.ready, true);
  assert.deepEqual(result.block.signIn, { state: "credentials-present", method: "zcode login", detail: credentials });
  assert.equal(result.block.version, "zcode-app-cli 9.9.9, zcode-runtime 0.0.fake");
  assert.equal(result.block.model, "account:fake-plan/GLM-5.3");
  assert.deepEqual(result.block.models, ["GLM-5.3", "GLM-5.3-Flash"].map(id => ({ id: `account:fake-plan/${id}`, efforts: ["low", "high", "max"], defaultEffort: "max" })));
  assert.equal(result.block.modelsReason, null);
  assert.equal(result.block.error, null);
  // One server, asked for a draft session's snapshot; the draft is closed; no message, no v4 session.
  const cwd = fs.realpathSync(ctx.work);
  let state = ctx.zcode();
  assert.deepEqual(state.starts.map(start => start.args), [["app-server"]]);
  assert.equal(state.starts[0].env.ZCODE_APP_SERVER_AUTH_MODE, undefined);
  assert.deepEqual(state.requests.filter(r => r.method).map(r => r.method), ["runtime/capabilities", "session/create", "session/close"]);
  assert.deepEqual(state.requests.find(r => r.method === "session/create").params, { workspace: { workspacePath: cwd, workspaceKey: cwd }, persistence: "deferred", mode: "build", titleGenerationEnabled: false });
  assert.deepEqual(state.requests.find(r => r.method === "session/close").params, { sessionId: "draft_1", expectedPersistence: "deferred" });
  assert.deepEqual(state.drafts.draft_1, { persistence: "deferred", preferences: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" }, open: false });
  assert.deepEqual(state.sessions, {});
  assert.equal(state.turns.length, 0);
  const text = companion(ctx, ["setup", "--backend", "zcode"]).stdout;
  assert.match(text, /^## zcode {2}~\/\.zcode {2}ready$/m);
  assert.match(text, /^models: account:fake-plan\/GLM-5\.3, account:fake-plan\/GLM-5\.3-Flash$/m);
  for (const extra of [["--grok-home", "jobs"], ["--fast-tier", "off"], ["--enable-review-gate"], ["--disable-review-gate"]]) {
    const refused = companion(ctx, ["setup", "--backend", "zcode", ...extra]);
    assert.equal(refused.status, 1, extra.join(" "));
    assert.match(refused.stderr, /requires --backend grok|on its own/, extra.join(" "));
  }
  const failing = fixture(t, { versionFail: true });
  fs.mkdirSync(path.join(failing.user, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(path.join(failing.user, ".zcode", "v2", "credentials.json"), '{"encrypted":"x"}');
  const failed = companion(failing, ["setup", "--backend", "zcode", "--json"]);
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).ready, false);
  assert.match(JSON.parse(failed.stdout).backends[0].error, /zcode --version failed \(exit 9\)[\s\S]*VERSION DENIED/);
  assert.equal(failing.zcode().starts.length, 0);
});

test("setup's ZCode model list: a server that refuses or does not answer is that block's reason, and ends", async t => {
  for (const [options, env, expected] of [
    [{ createFail: "Provider registry unavailable" }, {}, /^zcode app-server: Provider registry unavailable$/],
    [{ createHangMs: 5000 }, { RELAY_SETUP_SERVER_MS: "300" }, /^no answer in 0\.3 s$/],
    [{ dieInitialize: true }, {}, /^zcode app-server: fake zcode refused to start$/]
  ]) {
    const ctx = fixture(t, options);
    fs.mkdirSync(path.join(ctx.user, ".zcode", "v2"), { recursive: true });
    fs.writeFileSync(path.join(ctx.user, ".zcode", "v2", "credentials.json"), '{"encrypted":"x"}');
    fs.writeFileSync(path.join(ctx.user, ".zcode", "v2", "provider_config.json"), JSON.stringify({ config: { defaultModelSelection: { providerId: "account:fake-plan", modelId: "GLM-5.3" } } }));
    const result = companion(ctx, ["setup", "--backend", "zcode", "--json"], env);
    assert.equal(result.status, 1, result.stderr);
    const [block] = JSON.parse(result.stdout).backends;
    assert.equal(block.ready, false);
    assert.match(block.error, expected);
    assert.equal(block.modelsReason, block.error);
    // The default model from provider_config.json still shows.
    assert.equal(block.model, "account:fake-plan/GLM-5.3");
    assert.deepEqual(block.models.map(model => model.id), ["account:fake-plan/GLM-5.3"]);
    assert.equal(ctx.zcode().turns.length, 0);
    const [{ pid }] = ctx.zcode().starts;
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000);
  }
});

test("every notification advances the heartbeat; deltas, progress and telemetry stay out of events", () => {
  let touches = 0; const written = [];
  const recorder = zcodeEventRecorder(event => written.push(event), () => { touches += 1; });
  const sessionEvent = (type, payload = {}) => ({ method: "session/event", params: { sessionId: "s", type, payload } });
  const noise = [
    sessionEvent("model.streaming"), sessionEvent("part.delta"), sessionEvent("tool.updated", { kind: "progress" }),
    ...["v4/telemetry/event", "state.updated", "process/mcpTelemetry", "process/toolExecResource", "startup/storageState", "computer-use/operation-event"].map(method => ({ method, params: {} }))
  ];
  for (const notification of [...noise, sessionEvent("tool.updated", { kind: "started" }), sessionEvent("turn.completed"), { method: "zcode/permission", params: {} }]) recorder.record(notification);
  assert.equal(touches, noise.length + 3);
  assert.deepEqual(written.map(e => e.params.type ?? e.method), ["tool.updated", "turn.completed", "zcode/permission"]);
});

test("the header's model matches ZCode's ids case-insensitively; a provider can be named; unknown models pass through", async () => {
  const settings = {
    available: [{ ref: { providerId: "account:a", modelId: "GLM-5.3" } }, { ref: { providerId: "account:b", modelId: "GLM-5.3" } }, { ref: { providerId: "account:b", modelId: "GLM-5.3-Flash" } }],
    current: { providerId: "account:b", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "max" } }
  };
  const select = (model, effort = "high") => selectionFor({ model, effort }, settings);
  assert.deepEqual(await select("glm-5.3"), { providerId: "account:b", modelId: "GLM-5.3", options: { reasoningLevel: "high" } });
  assert.deepEqual(await select("account:a/glm-5.3", "low"), { providerId: "account:a", modelId: "GLM-5.3", options: { reasoningLevel: "low" } });
  assert.deepEqual(await select(null), { providerId: "account:b", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "high" } });
  assert.deepEqual(await select("GLM-9"), { providerId: "account:b", modelId: "GLM-9", options: { reasoningLevel: "high" } });
  await assert.rejects(() => selectionFor({ model: null, effort: "high" }, { available: [] }), /no default model/);
});

// Session creation and resume snapshots list every model the sign-in serves,
// as the model picker shows them.
const PLAN = "account:fake-plan";
const levels = ["low", "high", "max"].map(value => ({ value, label: value }));
const PLAN_MODELS = {
  current: { providerId: PLAN, modelId: "GLM-5.3", options: { reasoningLevel: "max" } },
  available: ["GLM-5.3", "GLM-5.3-Flash"].map(modelId => ({ ref: { providerId: PLAN, modelId }, label: modelId, providerLabel: "Z.AI Individual Coding Plan", reasoning: { levels, defaultLevel: "max" } }))
};

test("every spelling of GLM-5.3-Flash resolves to ZCode's id; FlashX, which the plan does not serve, passes through", async () => {
  const select = model => selectionFor({ model, effort: "low" }, PLAN_MODELS);
  for (const model of ["glm-5.3-flash", "GLM-5.3-Flash", "Glm-5.3-FLASH", `${PLAN}/glm-5.3-flash`, `${PLAN.toUpperCase()}/GLM-5.3-flash`]) {
    assert.deepEqual(await select(model), { providerId: PLAN, modelId: "GLM-5.3-Flash", options: { reasoningLevel: "low" } }, model);
  }
  for (const model of ["glm-5.3", `${PLAN}/GLM-5.3`]) assert.equal((await select(model)).modelId, "GLM-5.3", model);
  // Not in the list: ZCode judges it, and fails the turn with model_not_found.
  assert.deepEqual(await select("glm-5.3-flashx"), { providerId: PLAN, modelId: "glm-5.3-flashx", options: { reasoningLevel: "low" } });
  // The subscription's snapshot alone (only the current model) does not know Flash.
  assert.equal((await selectionFor({ model: "glm-5.3-flash", effort: "low" }, { current: PLAN_MODELS.current, available: PLAN_MODELS.available.slice(0, 1) })).modelId, "glm-5.3-flash");
});

test("a Workflow retry adopts the same ZCode job and returns its state block", async () => {
  const { relayContext, companion: relayCompanion, readJobJson, relayStart, waitFor: relayWait } = await import("./support/relay-fixture.mjs");
  const first = relayContext("job", { workflow: "wf-zcode", journalKey: "zcode-call" });
  const fake = installFakeZcode(first.binDir, { turnMs: 1500 });
  first.env.ZCODE_BINARY = fake.binary;
  const append = ctx => {
    const prompt = ctx.workflowPrompt();
    prompt.message.content = prompt.message.content.replace("mode: write", "mode: yolo").replace("\n  model:", "\n  backend: zcode\n  model:");
    ctx.append(ctx.userRequest(), prompt, ctx.environment(), ctx.snapshot("string"), ctx.systemReminder());
  };
  append(first);
  const started = await relayStart(first);
  assert.equal(started.started.status, 0, started.started.stderr + started.started.stdout);
  const id = started.jobId;
  await relayWait(() => readJobJson(first, id).turnId);
  const retry = relayContext("job", { from: first, workflow: "wf-zcode", label: "relay-test (retry 1)", journalKey: "zcode-call" });
  append(retry);
  const adopted = await relayStart(retry);
  assert.match(adopted.started.stdout, new RegExp(`^job: ${id}$`, "m"));
  assert.match(adopted.started.stdout, /relay-adopted:/);
  const ended = relayCompanion(retry, ["wait", id, "--timeout-seconds", "15", "--state-only"]);
  assert.equal(ended.status, 0, ended.stdout);
  assert.match(ended.stdout, /^backend: zcode$/m);
  assert.doesNotMatch(ended.stdout, /^---$/m);
  assert.equal(fake.state().turns.length, 1);
});

test("a capacity failure fails the turn: ZCode retries its model calls itself, so the worker never replays a ZCode turn", async t => {
  const ctx = fixture(t, { capacityOnce: true });
  const { id } = startJob(ctx, HEADER, "[quick] Busy.");
  await finishJob(ctx, id, 3);
  const job = readJob(ctx, id);
  assert.equal(job.state, "failed");
  assert.match(job.errorMessage, /at capacity/);
  assert.equal(job.capacityRetries, undefined);
  assert.deepEqual(ctx.zcode().inputs.map(input => input.commandId), [`brief-${id}`]);
  assert.equal(companion(ctx, ["resume", id]).status, 0);
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
});

test("a steer ZCode accepted but held is reported dropped, never sent twice; a cancel drops it too", async t => {
  const ctx = fixture(t, { turnMs: 400, guideHold: true });
  const { id } = startJob(ctx, HEADER, "First.");
  await waitFor(() => readJob(ctx, id).turnId);
  assert.equal(companion(ctx, ["steer", id, "--message", "[quick] Held."]).status, 0);
  await finishJob(ctx, id);
  const steer = readJob(ctx, id).messages.filter(m => m.kind === "steer");
  assert.deepEqual(steer.map(m => m.action), ["steered", "dropped"]);
  assert.match(steer[1].reason, /neither ran it nor added it to a turn within 0 s; it was not sent again/);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(report(ctx, id), "Report for: First.\n");
  assert.deepEqual(ctx.zcode().turns.map(turn => turn.commandId), [`brief-${id}`]);
  assert.equal(ctx.zcode().inputs.filter(input => input.delivery === "guide").length, 1);
  assert.ok(events(ctx, id).some(e => e.method === "zcode/inputsUnresolved"));
  assert.match(companion(ctx, ["result", id]).stdout, /^not-delivered: /m);

  const cancelled = fixture(t, { turnMs: 30000, guideHold: true });
  const launched = startJob(cancelled, HEADER, "Wait.");
  await waitFor(() => readJob(cancelled, launched.id).turnId);
  assert.equal(companion(cancelled, ["steer", launched.id, "--message", "Held."]).status, 0);
  companion(cancelled, ["cancel", launched.id]);
  await finishJob(cancelled, launched.id, 5);
  const actions = readJob(cancelled, launched.id).messages.filter(m => m.kind === "steer");
  assert.deepEqual(actions.map(m => m.action), ["steered", "dropped"]);
  assert.equal(actions[1].reason, "the job was cancelled before ZCode took the steer");
  // ZCode now holds its queue; the next message clears the dropped steer and runs alone.
  assert.equal(cancelled.zcode().sessions.sess_1.heldQueue.length, 1);
  assert.equal(companion(cancelled, ["continue", launched.id, "--message", "[quick] After cancel."]).status, 0);
  await finishJob(cancelled, launched.id);
  assert.equal(report(cancelled, launched.id), "Report for: [quick] After cancel.\n");
  assert.deepEqual(cancelled.zcode().sessions.sess_1.heldQueue, []);
  assert.ok(!cancelled.zcode().turns.some(turn => turn.text === "Held."));
  assert.match(companion(cancelled, ["result", launched.id]).stdout, /^not-delivered: /m);
});

test("a session lost before its first message is replaced, and the brief runs once", async t => {
  const ctx = fixture(t, { dieBeforeFirstSend: true });
  const { id } = startJob(ctx, HEADER, "[quick] Fresh.");
  await finishJob(ctx, id);
  const job = readJob(ctx, id);
  assert.equal(job.state, "completed");
  assert.equal(job.sessionId, "sess_2");
  assert.equal(commands(ctx, "createSession").length, 2);
  // The worker's automatic recovery message runs first, as after any death; the brief once.
  assert.deepEqual(ctx.zcode().turns.map(turn => turn.commandId), [job.automaticResumes[0].id, `brief-${id}`]);
  assert.ok(events(ctx, id).some(e => e.method === "zcode/sessionReplaced" && e.params.previous === "sess_1"));
});

// In-process checks of the adapter's turn bookkeeping against a scripted client.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ack = (params, extra = {}) => ({ commandId: params.commandId, status: "accepted", revisionAtDecision: 1, ...extra });
function scriptedClient(answers) {
  let resolveExit;
  return {
    answers, requests: [], taps: [], handler: null, exitInfo: null,
    exitPromise: new Promise(resolve => { resolveExit = resolve; }),
    setNotificationHandler(handler) { this.handler = handler; },
    tap(message) { this.taps.push(message); },
    request(method, params) {
      this.requests.push({ method, params });
      const answer = this.answers[method === "v4/command" ? params.type : method];
      return typeof answer === "function" ? answer(params) : Promise.resolve(answer);
    },
    emit(type, turnId, payload = {}) { this.handler({ method: "session/event", params: { sessionId: "s1", type, turnId, payload } }); },
    die(info) { this.exitInfo = info; resolveExit(); }
  };
}
const connections = new WeakMap();
async function opened(answers = {}, request = {}, sessionId = null, sessionUsed = false) {
  const client = scriptedClient({
    createSession: params => Promise.resolve(ack(params, { result: { type: "createSession", sessionId: "s1" } })),
    sendText: params => Promise.resolve(ack(params)),
    stop: params => Promise.resolve(ack(params)),
    "session/subscribe": { snapshot: { settings: { model: { available: [{ ref: { providerId: "p", modelId: "GLM-5.3" } }], current: { providerId: "p", modelId: "GLM-5.3" } } } } },
    ...answers
  });
  const connection = await scriptedConnection("zcode", client, { cwd: "/work", mode: "yolo", webSearch: "live", model: null, effort: "high", ...request });
  const session = await connection.open({ sessionId, sessionUsed, sessionName: null });
  connections.set(client, connection);
  return { client, session };
}
async function selectionFor(request, settings) {
  const { client } = await opened({
    "session/subscribe": { snapshot: { settings: { model: settings } } },
    "session/resume": { settings: { model: settings } }
  }, request);
  return connections.get(client).session.selection;
}
function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
const runOf = (client, id = "m1") => connections.get(client).run({ prompt: "main", clientId: id, source: "brief", onTurnId() {}, onPending() {} });

test("a steer arriving as an older steer's wait expires keeps its own wait and its own turn", async t => {
  withEnv(t, { RELAY_JOBS_ZCODE_UNRESOLVED_MS: "100" });
  const { client } = await opened();
  const run = runOf(client);
  await sleep(5);
  client.emit("turn.started", "t1", { inputId: "m1" });
  await connections.get(client).steer("t1", { id: "a", text: "A" });
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "success", response: "R1" });
  await sleep(80);
  let releaseB;
  client.answers.sendText = params => new Promise(resolve => { releaseB = () => resolve(ack(params)); });
  const steerB = connections.get(client).steer("t1", { id: "b", text: "B" });
  await sleep(60);
  releaseB();
  await steerB;
  client.emit("turn.started", "t2", { inputId: "b" });
  client.emit("turn.completed", "t2", { inputId: "b", resultType: "success", response: "R2" });
  const result = await run;
  assert.equal(result.finalMessage, "R2");
  assert.deepEqual(result.unjoinedSteers, []);
  assert.deepEqual(result.droppedSteers.map(entry => entry.id), ["a"]);
  assert.equal(result.retryable, false);
});

test("a server that ends during the duplicate wait fails the run with its exit", async t => {
  withEnv(t, { RELAY_JOBS_ZCODE_DUPLICATE_MS: "300" });
  const { client } = await opened({ sendText: params => params.commandId === "m1" ? Promise.resolve({ commandId: "m1", status: "duplicate", revisionAtDecision: 0 }) : new Promise(() => {}) });
  const run = runOf(client);
  await sleep(50);
  client.die({ code: 17, pid: 42 });
  const result = await Promise.race([run, sleep(2000).then(() => "hung")]);
  assert.notEqual(result, "hung");
  assert.equal(result.turnStatus, "failed");
  assert.match(result.error.message, /zcode app-server ended before the turn finished \(exit 17\)\. pid 42\./);
});

test("stop answers: accepted, noop and duplicate stop; anything else fails; a turn starting after stop is stopped", async () => {
  for (const status of ["accepted", "noop", "duplicate"]) {
    const { client } = await opened({ stop: params => Promise.resolve({ commandId: params.commandId, status, revisionAtDecision: 1 }) });
    await connections.get(client).interrupt(null);
  }
  const { client: refusing } = await opened({ stop: params => Promise.resolve({ commandId: params.commandId, status: "rejected", reasonCode: "guard.x", revisionAtDecision: 1 }) });
  await assert.rejects(connections.get(refusing).interrupt(null), /ZCode refused the stop \(rejected, guard.x\)/);
  const { client } = await opened();
  const run = runOf(client);
  await sleep(5);
  client.emit("turn.started", "t1", { inputId: "m1" });
  await connections.get(client).interrupt(null);
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "cancelled", response: "" });
  client.emit("turn.started", "t2", { inputId: "queued" });
  await sleep(5);
  assert.deepEqual(client.requests.filter(r => r.params?.type === "stop").map(r => [r.params.sessionId, r.params.payload]), [["s1", {}], ["s1", {}]]);
  client.emit("turn.completed", "t2", { inputId: "queued", resultType: "cancelled", response: "" });
  assert.equal((await run).turnStatus, "interrupted");
});

test("a closed session ends the run, and every pending request, as failed with ZCode's reason", async () => {
  for (const reason of ["deleted", ""]) {
    const { client } = await opened();
    const run = runOf(client);
    await sleep(5);
    client.emit("turn.started", "t1", { inputId: "m1" });
    client.emit("session.closed", undefined, { reason });
    const result = await Promise.race([run, sleep(1000).then(() => "hung")]);
    assert.equal(result.turnStatus, "failed");
    assert.equal(result.error.message, reason ? "ZCode closed the session: deleted" : "ZCode closed the session.");
  }
  // Closed while a message and a stop wait for their answers: both fail at once.
  const { client } = await opened({ sendText: () => new Promise(() => {}), stop: () => new Promise(() => {}) });
  const run = runOf(client);
  const stop = connections.get(client).interrupt(null);
  await sleep(5);
  client.emit("session.closed", undefined, {});
  assert.equal((await Promise.race([run, sleep(1000).then(() => ({ turnStatus: "hung" }))])).turnStatus, "failed");
  await assert.rejects(Promise.race([stop, sleep(1000).then(() => { throw new Error("stop hung"); })]), /ZCode closed the session\./);
});

test("a resumed session's history names delivered messages by either intent field and without their resend suffix", async () => {
  const history = [
    { info: { role: "user", metadata: { inputIntent: { sourceCommandId: "brief-x~1" } } } },
    { info: { role: "user", metadata: { conversationInputIntent: { sourceCommandId: "msg-2" } } } },
    { info: { role: "assistant", metadata: { inputIntent: { sourceCommandId: "msg-3" } } } }
  ];
  const { client, session } = await opened({ "session/resume": { messages: history } }, { mode: "read-only", webSearch: "disabled" }, "s1");
  for (const [clientId, expected] of [["brief-x", true], ["msg-2", true], ["msg-3", false], [null, false]]) assert.equal(connections.get(client).delivered({ clientId }), expected, clientId);
  assert.deepEqual(client.requests.find(r => r.method === "session/resume").params, {
    sessionId: "s1", workspace: { workspacePath: "/work", workspaceKey: "/work" }, toolDenylist: [...UNATTENDED, ...WEB, ...WRITING], toolAllowlist: READING
  });
  assert.equal(client.requests.filter(r => r.params?.type === "createSession").length, 0);
});

test("a missing session is replaced only if no turn ever ran on it; other resume errors fail the open", async () => {
  const missing = params => Promise.reject(Object.assign(new Error(`Session not found: ${params.sessionId}`), { data: { code: -32004, message: `Session not found: ${params.sessionId}` } }));
  await assert.rejects(opened({ "session/resume": missing }, {}, "s0", true), /ZCode no longer has session s0, where this job's earlier turns ran; their context is lost/);
  const { client, session } = await opened({ "session/resume": missing }, {}, "s0");
  assert.equal(session.sessionId, "s1");
  assert.equal(connections.get(client).deliveredIds.size, 0);
  assert.deepEqual(client.taps.find(tap => tap.method === "zcode/sessionReplaced").params, { previous: "s0", reason: "Session not found: s0" });
  for (const [code, message] of [[-32603, "database is locked"], [-32603, "Session not found: s0"], [-32004, "Session is not active: s0"]]) {
    const broken = () => Promise.reject(Object.assign(new Error(message), { data: { code, message } }));
    await assert.rejects(opened({ "session/resume": broken }, {}, "s0"), new RegExp(message), `${code} ${message}`);
  }
});

test("the wait defaults and overrides reach model reads, duplicate waits and untaken steers", async t => {
  const names = ["RELAY_JOBS_ZCODE_UNRESOLVED_MS", "RELAY_JOBS_ZCODE_DUPLICATE_MS", "RELAY_JOBS_ZCODE_MODEL_LIST_MS"];
  const saved = names.map(name => process.env[name]);
  const originalTimer = globalThis.setTimeout;
  try {
    for (const [values, expected] of [
      [[], [10000, 2000, 10000]],
      [["5", "x", "7"], [7, 2000, 5]],
      [["-1", "-5", "-3"], [10000, 2000, 10000]]
    ]) {
      names.forEach((name, index) => { if (values[index] === undefined) delete process.env[name]; else process.env[name] = values[index]; });
      const delays = [];
      const timer = t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
        delays.push(ms);
        return originalTimer(callback, 0, ...args);
      });
      try {
        const { client } = await opened({
          "session/resume": { settings: { model: { current: { providerId: "p", modelId: "GLM-5.3" }, available: [] } } },
          sendText: params => Promise.resolve(ack(params, { status: params.commandId === "main" ? "duplicate" : "accepted" }))
        }, { model: "glm-5.3-flash" });
        const run = runOf(client, "main");
        while (!client.requests.some(request => request.params.commandId === "main~1")) await new Promise(resolve => originalTimer(resolve, 0));
        await connections.get(client).steer(null, { id: "guide", text: "more" });
        client.emit("turn.started", "turn", { inputId: "main~1" });
        client.emit("turn.completed", "turn", { inputId: "main~1", resultType: "success", response: "Report" });
        assert.equal((await run).droppedSteers[0].id, "guide");
        assert.deepEqual(delays, expected);
      } finally {
        timer.mock.restore();
      }
    }
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("an id discarded again and again is resent under fresh suffixes until ZCode takes it", async () => {
  const discarded = params => Promise.resolve({ commandId: params.commandId, status: "failed", reasonCode: "fault.command.inputDiscardedOnRestart", revisionAtDecision: 0 });
  const { client } = await opened({ sendText: params => /~(6)$/.test(params.commandId) ? Promise.resolve(ack(params)) : discarded(params) });
  const run = runOf(client);
  await sleep(10);
  client.emit("turn.started", "t1", { inputId: "m1~6" });
  client.emit("turn.completed", "t1", { inputId: "m1~6", resultType: "success", response: "R" });
  const result = await run;
  assert.equal(result.turnStatus, "completed");
  assert.deepEqual(client.requests.filter(r => r.params?.type === "sendText").map(r => r.params.commandId), ["m1", "m1~1", "m1~2", "m1~3", "m1~4", "m1~5", "m1~6"]);
});

test("a steer ZCode accepted when its server ends is handed back to run again, not dropped", async () => {
  const { client } = await opened();
  const run = runOf(client);
  await sleep(5);
  client.emit("turn.started", "t1", { inputId: "m1" });
  await connections.get(client).steer("t1", { id: "a", text: "A" });
  client.die({ code: 9 });
  const result = await run;
  assert.equal(result.turnStatus, "failed");
  assert.deepEqual(result.unjoinedSteers, ["a"]);
  assert.deepEqual(result.droppedSteers, []);
});

test("an established session that ZCode lost fails continue with lost context, never an empty replacement", async t => {
  const ctx = fixture(t);
  const { id } = startJob(ctx, HEADER, "[quick] First.");
  await finishJob(ctx, id);
  const state = JSON.parse(fs.readFileSync(ctx.fakeState, "utf8"));
  delete state.sessions.sess_1;
  fs.writeFileSync(ctx.fakeState, JSON.stringify(state));
  assert.equal(companion(ctx, ["continue", id, "--message", "[quick] Next."]).status, 0);
  await finishJob(ctx, id, 3);
  assert.match(readJob(ctx, id).errorMessage, /ZCode no longer has session sess_1, where this job's earlier turns ran/);
  assert.equal(commands(ctx, "createSession").length, 1);
});

test("a read-only steer carries the job's model, build mode and read-only tool lists", async t => {
  const ctx = fixture(t, { turnMs: 700 });
  const { id } = startJob(ctx, `${HEADER}\nmode: read-only`, "First.");
  await waitFor(() => readJob(ctx, id).turnId);
  assert.equal(companion(ctx, ["steer", id, "--message", "Mid-turn."]).status, 0);
  await finishJob(ctx, id);
  const [main, guide] = ctx.zcode().inputs;
  assert.equal(guide.delivery, "guide");
  assert.deepEqual([guide.modelSelection, guide.mode, guide.toolDisallowlist], [main.modelSelection, "build", [...UNATTENDED, ...WRITING]]);
});

test("steer bookkeeping: a refused steer leaves nothing waiting; every acknowledgement holds the run; a settled run takes no steer", async t => {
  withEnv(t, { RELAY_JOBS_ZCODE_UNRESOLVED_MS: "60" });
  const settled = (promise, ms = 40) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
  // Refused: it throws, waits for nothing, and the run settles with no drop.
  let { client } = await opened();
  let run = runOf(client);
  await sleep(5);
  client.emit("turn.started", "t1", { inputId: "m1" });
  client.answers.sendText = params => Promise.resolve({ commandId: params.commandId, status: "rejected", reasonCode: "guard.busy", revisionAtDecision: 1 });
  await assert.rejects(connections.get(client).steer("t1", { id: "r", text: "R" }), /ZCode refused the steer \(rejected, guard.busy\)/);
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "success", response: "R1" });
  let result = await run;
  assert.deepEqual([result.droppedSteers, result.unjoinedSteers], [[], []]);
  assert.ok(!client.taps.some(tap => tap.method === "zcode/inputsUnresolved"));
  await assert.rejects(connections.get(client).steer("t1", { id: "late", text: "L" }), /no turn is running/);
  assert.equal(client.requests.filter(r => r.params?.commandId === "late").length, 0);
  // Two acknowledgements in flight: the run waits for both; one that arrives after its steer
  // drained settles the run by itself.
  ({ client } = await opened());
  run = runOf(client);
  await sleep(5);
  client.emit("turn.started", "t1", { inputId: "m1" });
  const release = {};
  client.answers.sendText = params => new Promise(resolve => { release[params.commandId] = () => resolve(ack(params)); });
  const steerA = connections.get(client).steer("t1", { id: "a", text: "A" });
  const steerB = connections.get(client).steer("t1", { id: "b", text: "B" });
  await sleep(1);
  client.emit("turn.steerDrained", "t1", { drainedInputs: [{ intent: { sourceCommandId: "a" } }, { intent: { sourceCommandId: "b" } }] });
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "success", response: "R1" });
  release.a(); await steerA;
  assert.equal(await settled(run), false);
  release.b(); await steerB;
  result = await run;
  assert.deepEqual([result.finalMessage, result.droppedSteers, result.unjoinedSteers], ["R1", [], []]);
});

test("a run counts only its own session's events and its own turn", async () => {
  const { client } = await opened();
  const settled = (promise, ms = 40) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
  const first = runOf(client, "m1");
  await sleep(5);
  client.handler({ method: "session/event", params: { sessionId: "other", type: "turn.completed", turnId: "x", payload: { inputId: "m1", resultType: "success", response: "foreign" } } });
  client.emit("turn.completed", "u1", { inputId: "unrelated", resultType: "success", response: "unrelated" });
  assert.equal(await settled(first), false);
  client.emit("turn.started", "t1", { inputId: "m1" });
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "success", response: "R1" });
  assert.equal((await first).finalMessage, "R1");
  const second = runOf(client, "m2");
  assert.equal(await settled(second), false);
  client.emit("turn.started", "t2", { inputId: "m2" });
  client.emit("turn.completed", "t2", { inputId: "m2", resultType: "success", response: "R2" });
  assert.deepEqual([(await second).finalMessage, (await second).turnId], ["R2", "t2"]);
});

test("the duplicate path: a duplicate that starts during its wait is not resent; endless duplicates stop at twenty resends", async t => {
  withEnv(t, { RELAY_JOBS_ZCODE_DUPLICATE_MS: "30" });
  const duplicate = params => Promise.resolve({ commandId: params.commandId, status: "duplicate", revisionAtDecision: 0 });
  let { client } = await opened({ sendText: duplicate });
  const run = runOf(client);
  await sleep(10);
  client.emit("turn.started", "t1", { inputId: "m1" });
  await sleep(40);
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "success", response: "R" });
  assert.equal((await run).finalMessage, "R");
  assert.deepEqual(client.requests.filter(r => r.params?.type === "sendText").map(r => r.params.commandId), ["m1"]);
  ({ client } = await opened({ sendText: duplicate }));
  const endless = await runOf(client);
  assert.equal(endless.turnStatus, "failed");
  assert.match(endless.error.message, /ZCode refused the message \(duplicate\)/);
  assert.equal(client.requests.filter(r => r.params?.type === "sendText").length, 21);
});

test("a cancel ends only its own run: the next run on the client gives an untaken steer the normal wait", async t => {
  withEnv(t, { RELAY_JOBS_ZCODE_UNRESOLVED_MS: "40" });
  const { client } = await opened();
  let run = runOf(client, "m1");
  await sleep(5);
  client.emit("turn.started", "t1", { inputId: "m1" });
  await connections.get(client).interrupt(null);
  client.emit("turn.completed", "t1", { inputId: "m1", resultType: "cancelled", response: "" });
  assert.equal((await run).turnStatus, "interrupted");
  run = runOf(client, "m2");
  await sleep(5);
  client.emit("turn.started", "t2", { inputId: "m2" });
  await connections.get(client).steer("t2", { id: "a", text: "A" });
  client.emit("turn.completed", "t2", { inputId: "m2", resultType: "success", response: "R2" });
  const result = await run;
  assert.equal(result.droppedSteers.length, 1);
  assert.match(result.droppedSteers[0].reason, /neither ran it nor added it to a turn/);
  assert.deepEqual(client.taps.find(tap => tap.method === "zcode/inputsUnresolved").params, { sessionId: "s1", commandIds: ["a"] });
});


test("a new session reads every model from session/resume only when the subscription's one model does not match; a resumed session's own snapshot serves", async () => {
  const subscribe = { snapshot: { settings: { model: { current: PLAN_MODELS.current, available: PLAN_MODELS.available.slice(0, 1) } } } };
  const full = { messages: [], settings: { model: PLAN_MODELS } };
  const resumes = client => client.requests.filter(r => r.method === "session/resume").map(r => r.params);
  // Flash on a new session: one session/resume of that session, with nothing else in it.
  let { client } = await opened({ "session/subscribe": subscribe, "session/resume": full }, { model: "glm-5.3-flash", effort: "low" });
  assert.deepEqual(resumes(client), [{ sessionId: "s1" }]);
  assert.deepEqual(connections.get(client).session.selection, { providerId: PLAN, modelId: "GLM-5.3-Flash", options: { reasoningLevel: "low" } });
  // The current model, in any case, and the default: the subscription's snapshot is enough.
  for (const model of ["glm-5.3", null]) {
    ({ client } = await opened({ "session/subscribe": subscribe, "session/resume": full }, { model }));
    assert.deepEqual(resumes(client), [], String(model));
    assert.equal(connections.get(client).session.selection.modelId, "GLM-5.3", String(model));
  }
  // A resumed session: its own session/resume snapshot lists every model; nothing is read twice.
  ({ client } = await opened({ "session/subscribe": subscribe, "session/resume": full }, { model: "GLM-5.3-FLASH" }, "s1"));
  assert.equal(resumes(client).length, 1);
  assert.equal(connections.get(client).session.selection.modelId, "GLM-5.3-Flash");
  // A list read that fails leaves the id to ZCode, and the events and the state block say why.
  const missing = () => Promise.reject(Object.assign(new Error("Session not found: s1"), { data: { code: -32004 } }));
  let session;
  ({ client, session } = await opened({ "session/subscribe": subscribe, "session/resume": missing }, { model: "glm-5.3-flash" }));
  assert.equal(connections.get(client).session.selection.modelId, "glm-5.3-flash");
  assert.deepEqual(client.taps.map(tap => [tap.method, tap.params.sessionId, tap.params.model]), [["zcode/modelListUnavailable", "s1", "glm-5.3-flash"]]);
  assert.deepEqual(session.notes, ["ZCode's model list was not read (Session not found: s1); model glm-5.3-flash was sent as written."]);
});

// The read is bounded. No answer sends the model as written, with the reason.
test("a model-list read that never answers ends after its limit: the model goes as written, with an event and a note", { timeout: 10000 }, async t => {
  withEnv(t, { RELAY_JOBS_ZCODE_MODEL_LIST_MS: "60" });
  const subscribe = { snapshot: { settings: { model: { current: PLAN_MODELS.current, available: PLAN_MODELS.available.slice(0, 1) } } } };
  const started = Date.now();
  const { client, session } = await opened({ "session/subscribe": subscribe, "session/resume": () => new Promise(() => {}) }, { model: "glm-5.3-flash", effort: "low" });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(connections.get(client).session.selection, { providerId: PLAN, modelId: "glm-5.3-flash", options: { reasoningLevel: "low" } });
  assert.deepEqual(client.taps.map(tap => tap.params.reason), ["no answer in 0.1 s"]);
  assert.deepEqual(session.notes, ["ZCode's model list was not read (no answer in 0.1 s); model glm-5.3-flash was sent as written."]);
  // The server ending during the read is the server's end, not a note.
  const ended = scriptedClient({});
  ended.request = (method, params) => {
    ended.requests.push({ method, params });
    if (method === "v4/command") return Promise.resolve(ack(params, { result: { type: "createSession", sessionId: "s1" } }));
    if (method === "session/subscribe") return Promise.resolve(subscribe);
    ended.die({ code: 17, signal: null });
    return new Promise(() => {});
  };
  const endedConnection = await scriptedConnection("zcode", ended, { cwd: "/work", mode: "yolo", webSearch: "live", model: "glm-5.3-flash", effort: "low" });
  await assert.rejects(endedConnection.open({ sessionId: null, sessionUsed: false, sessionName: null }), /zcode app-server ended before the turn finished \(exit 17\)/);
  assert.deepEqual(ended.taps, []);
});

// A job whose model-list read gets no answer still runs and says why.
test("a job whose model-list read gets no answer runs its turn on the model as written; the events and the state block say why", { timeout: 30000 }, async t => {
  const ctx = fixture(t, { listSilent: true });
  ctx.env.RELAY_JOBS_ZCODE_MODEL_LIST_MS = "200";
  const { id } = startJob(ctx, "backend: zcode\nmodel: glm-5.3-flash\neffort: low\nmode: read-only", "[quick] Flash.");
  await finishJob(ctx, id);
  assert.equal(readJob(ctx, id).state, "completed");
  assert.equal(ctx.zcode().inputs[0].modelSelection.modelId, "glm-5.3-flash");
  const unavailable = events(ctx, id).filter(e => e.method === "zcode/modelListUnavailable");
  assert.deepEqual(unavailable.map(e => e.params), [{ sessionId: "sess_1", model: "glm-5.3-flash", reason: "no answer in 0.2 s" }]);
  const note = "note: ZCode's model list was not read (no answer in 0.2 s); model glm-5.3-flash was sent as written.";
  for (const args of [["result", id, "--state-only"], ["status", id]]) assert.ok(companion(ctx, args).stdout.split("\n").includes(note), args.join(" "));
  // A continue resumes the session: its snapshot lists the models, and the note is not repeated.
  assert.equal(companion(ctx, ["continue", id, "--message", "[quick] Again."]).status, 0);
  await finishJob(ctx, id);
  assert.equal(ctx.zcode().inputs.at(-1).modelSelection.modelId, "GLM-5.3-Flash");
  assert.equal(readJob(ctx, id).request.notes.filter(text => text.startsWith("ZCode's model list")).length, 1);
});

// Setup needs a model list, and names a draft it could not close.
test("setup's ZCode block: no model list, or an empty one, is not ready; a draft ZCode did not close is a warning, and the list stands", async t => {
  const signed = ctx => {
    fs.mkdirSync(path.join(ctx.user, ".zcode", "v2"), { recursive: true });
    fs.writeFileSync(path.join(ctx.user, ".zcode", "v2", "credentials.json"), '{"encrypted":"x"}');
  };
  for (const [options, reason] of [
    [{ createAnswer: "no-settings" }, "zcode app-server: session/create answered without a model list"],
    [{ models: [] }, "ZCode listed no model for this sign-in"]
  ]) {
    const ctx = fixture(t, options);
    signed(ctx);
    const result = companion(ctx, ["setup", "--backend", "zcode", "--json"]);
    assert.equal(result.status, 1, JSON.stringify(options));
    const [block] = JSON.parse(result.stdout).backends;
    assert.deepEqual([block.ready, block.error, block.modelsReason], [false, reason, reason], JSON.stringify(options));
    assert.match(companion(ctx, ["setup", "--backend", "zcode"]).stdout, /^## zcode {2}~\/\.zcode {2}needs attention$/m);
  }
  for (const [closeAnswer, why] of [
    ["refuse", "session/close answered closed: false"],
    ["error", "session/close failed: CLOSE FAILED"],
    ["silent", "no answer to session/close in 0.4 s"]
  ]) {
    const ctx = fixture(t, { closeAnswer });
    signed(ctx);
    const result = companion(ctx, ["setup", "--backend", "zcode", "--json"], { RELAY_SETUP_SERVER_MS: "400" });
    assert.equal(result.status, 0, closeAnswer);
    const [block] = JSON.parse(result.stdout).backends;
    const warning = `setup's draft ZCode session draft_1 was not closed: ${why}.`;
    assert.deepEqual([block.ready, block.error, block.warnings], [true, null, [warning]], closeAnswer);
    assert.deepEqual(block.models.map(model => model.id), ["account:fake-plan/GLM-5.3", "account:fake-plan/GLM-5.3-Flash"], closeAnswer);
    assert.ok(companion(ctx, ["setup", "--backend", "zcode"], { RELAY_SETUP_SERVER_MS: "400" }).stdout.split("\n").includes(`warning: ${warning}`), closeAnswer);
    for (const { pid } of ctx.zcode().starts) await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
  }
});

// The check's server leads its own process group, which setup ends.
test("setup ends a ZCode server that ignores SIGTERM, and the child it left in its group", async t => {
  const ctx = fixture(t, { stubborn: true, createHangMs: 60000 });
  fs.mkdirSync(path.join(ctx.user, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(path.join(ctx.user, ".zcode", "v2", "credentials.json"), '{"encrypted":"x"}');
  t.after(() => { for (const pid of ctx.zcode().children ?? []) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const result = companion(ctx, ["setup", "--backend", "zcode", "--json"], { RELAY_SETUP_SERVER_MS: "150" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).backends[0].error, "no answer in 0.1 s");
  const state = ctx.zcode();
  assert.equal(state.children.length, 1);
  const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
  await waitFor(() => gone(state.starts[0].pid) && gone(state.children[0]), 4000);
});

test("a job with model: glm-5.3-flash runs on GLM-5.3-Flash, ZCode's id, on the fake", async t => {
  const ctx = fixture(t);
  const { id } = startJob(ctx, "backend: zcode\nmodel: glm-5.3-flash\neffort: low\nmode: read-only", "[quick] Flash.");
  await finishJob(ctx, id);
  const state = ctx.zcode();
  assert.deepEqual(state.inputs[0].modelSelection, { providerId: "account:fake-plan", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "low" } });
  assert.deepEqual(state.requests.filter(r => r.method === "session/resume").map(r => r.params), [{ sessionId: "sess_1" }]);
  assert.equal(readJob(ctx, id).request.model, "glm-5.3-flash", "the request keeps the header's words");
  // A continue resumes the session and reads the list from that snapshot: one resume more.
  assert.equal(companion(ctx, ["continue", id, "--message", "[quick] Again."]).status, 0);
  await finishJob(ctx, id);
  assert.equal(ctx.zcode().inputs.at(-1).modelSelection.modelId, "GLM-5.3-Flash");
  assert.equal(ctx.zcode().requests.filter(r => r.method === "session/resume").length, 2);
});

test("the GLM docs: ZCode is the only route, GLM-5.3 and GLM-5.3-Flash run, FlashX is not supported yet, ids match in any case", () => {
  const root = new URL("..", import.meta.url);
  const read = file => fs.readFileSync(new URL(file, root), "utf8");
  const skill = read("plugins/relay/skills/jobs/SKILL.md");
  const glm = skill.slice(skill.indexOf("## GLM jobs"), skill.indexOf("### Through ZCode"));
  assert.match(glm, /It is the only route for GLM\./);
  assert.ok(glm.includes("| `glm-5.3` | `GLM-5.3` | runs |"));
  assert.ok(glm.includes("| `glm-5.3-flash` | `GLM-5.3-Flash` | runs |"));
  assert.ok(glm.includes("| `glm-5.3-flashx` | none | not supported yet |"));
  assert.ok(glm.includes("A model id matches ZCode's without regard to case: `glm-5.3-flash`, `GLM-5.3-Flash` and `account:zai-individual-coding-plan/glm-5.3-flash` all run `GLM-5.3-Flash`."));
  assert.doesNotMatch(glm, /Codex route|if the sign-in offers it|times as fast|not checked/);
  assert.match(skill, /every model the sign-in serves, without a model call: it asks one `zcode app-server` for a draft session's model list and closes the draft unsaved/);
  assert.match(read("README.md"), /\| `zcode` \| `zcode app-server` \| GLM \(GLM-5\.3, GLM-5\.3-Flash\), the only route for it \|/);
  assert.match(read("plugins/relay/commands/setup.md").replace(/\s+/g, " "), /creates a draft session, reads its model list \(what ZCode's model picker shows\) and closes the draft unsaved, with no message/);
  const design = read("docs/design.md").replace(/\s+/g, " ");
  assert.match(design, /read its model list, and close it unsaved, with no message/);
});
