// Both review commands run against fake backends with the same request and output rules.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { companion, jobDirs, makeHome, readJob, setup } from "./support/job-helpers.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { installFakeZcode } from "./fakes/zcode.mjs";
import { installFakeKimi } from "./fakes/kimi.mjs";
import { initGitRepo, run } from "./support/helpers.mjs";

const VERDICT = {
  verdict: "needs-attention",
  summary: "One empty-state risk blocks the change.",
  findings: [{ severity: "high", title: "Unguarded first item", body: "items[0] is read without a length check.", file: "src/app.js", line_start: 1, line_end: 1, confidence: 0.8, recommendation: "Return early on an empty list." }],
  next_steps: ["Add an empty-list test."]
};

// A repository in ctx.work: `src/app.js` and every name in `files` committed, then `files`
// changed in the working tree and `untracked` written as untracked files.
function repo(ctx, files = { "src/app.js": "export const value = items[0].id;\n" }, untracked = {}) {
  initGitRepo(ctx.work);
  fs.mkdirSync(path.join(ctx.work, "src"), { recursive: true });
  for (const name of ["src/app.js", ...Object.keys(files)]) fs.writeFileSync(path.join(ctx.work, name), "export const value = 1;\n");
  assert.equal(run("git", ["add", "."], { cwd: ctx.work }).status, 0);
  assert.equal(run("git", ["commit", "-m", "init"], { cwd: ctx.work }).status, 0);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ctx.work, name), text);
  for (const [name, text] of Object.entries(untracked)) fs.writeFileSync(path.join(ctx.work, name), text);
}

// Text of exactly `bytes` bytes that ends with `marker` and a newline.
const sized = (bytes, marker = "END_OF_FILE") => `${"x".repeat(bytes - marker.length - 1)}${marker}\n`;

// The job directories the last command added.
const newJobs = (ctx, before) => jobDirs(ctx).filter(dir => !before.includes(dir)).map(dir => JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")));

function grok(t, options = {}, files, untracked) {
  const ctx = setup(t, { behavior: "review-ok" });
  const fake = installFakeGrok(ctx.bin, options);
  ctx.env.GROK_BINARY = fake.binary;
  // Inherited from the caller's shell; a review must replace it with read-only.
  ctx.env.GROK_SANDBOX = "strict";
  ctx.grok = fake.state;
  if (files !== null) repo(ctx, files, untracked);
  return ctx;
}

function zcode(t, options = {}, files, untracked) {
  const ctx = setup(t, { behavior: "review-ok" });
  const fake = installFakeZcode(ctx.bin, options);
  ctx.env.ZCODE_BINARY = fake.binary;
  ctx.zcode = fake.state;
  ctx.zcodeState = path.join(ctx.bin, "fake-zcode-state.json");
  if (files !== null) repo(ctx, files, untracked);
  return ctx;
}

function kimi(t, options = {}, files, untracked) {
  const ctx = setup(t, { behavior: "review-ok" });
  const fake = installFakeKimi(ctx.bin, options);
  ctx.env.KIMI_BINARY = fake.binary;
  ctx.env.RELAY_JOBS_KIMI_POLL_MS = "20";
  ctx.kimi = fake.state;
  if (files !== null) repo(ctx, files, untracked);
  return ctx;
}

// The fake each review test reads its turns from.
const turnsOf = (ctx, backend) => ({ zcode: () => ctx.zcode().turns, grok: () => ctx.grok().turns, kimi: () => ctx.kimi().turns })[backend]();

function codex(t, behavior = "review-ok") {
  const ctx = setup(t, { behavior });
  repo(ctx);
  return ctx;
}

const onlyJob = (ctx) => {
  const dirs = jobDirs(ctx);
  assert.equal(dirs.length, 1);
  return JSON.parse(fs.readFileSync(path.join(dirs[0], "job.json"), "utf8"));
};

test("selection errors fail before a job exists, with the job path's messages", t => {
  const ctx = codex(t);
  const cases = [
    [["review", "--backend", "other"], "backend must be codex, grok, zcode or kimi."],
    [["adversarial-review", "--grok-home", "jobs"], "grok-home is only valid with backend: grok."]
  ];
  for (const [args, message] of cases) {
    const result = companion(ctx, args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stderr.trim(), message, args.join(" "));
  }
  assert.equal(jobDirs(ctx).length, 0);
  assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false);
});

test("Codex review runs in the Codex home with the job MCP list; --effort on the native reviewer is a note", t => {
  const ctx = codex(t);
  makeHome(ctx, ".codex", 'model = "gpt-test"\n[mcp_servers.node_repl]\ncommand = "node"\n');
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ mcpOff: ["node_repl"] }));

  const result = companion(ctx, ["review", "--effort", "high", "--model", "gpt-review-pick"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("note: effort high is ignored: Codex's native review takes no effort.\n\n# Codex Review\n"), result.stdout);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  const state = ctx.fakeState();
  // The caller's environment, unchanged: no CODEX_HOME is added.
  assert.deepEqual(state.spawnHomes, [null]);
  assert.deepEqual(state.spawnArgs, [["app-server", "-c", "mcp_servers.node_repl.enabled=false"]]);
  // The selected model reaches the backend request, not only the stored request.
  assert.deepEqual(state.threadStarts.map(start => start.model), ["gpt-review-pick"]);

  const job = onlyJob(ctx);
  assert.equal(job.kind, "review");
  assert.equal(job.request.mode, "read-only");
  assert.equal(job.request.model, "gpt-review-pick");
  assert.equal(job.request.effort, null);
  const status = companion(ctx, ["status", job.id]);
  assert.match(status.stdout, /^note: effort high is ignored: Codex's native review takes no effort\.$/m);
  assert.doesNotMatch(status.stdout, /^backend:/m);

  // The public payload names the session `sessionId`, on every backend.
  const before = jobDirs(ctx);
  const json = companion(ctx, ["review", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  const [second] = newJobs(ctx, before);
  assert.equal(typeof payload.sessionId, "string");
  assert.equal(payload.sessionId, second.sessionId);
  assert.equal("threadId" in payload, false);
  assert.equal("sourceThreadId" in payload, false);
});

test("Codex adversarial review keeps outputSchema and its prompt, and passes --model and --effort", t => {
  const ctx = codex(t);
  const inherited = makeHome(ctx, "inherited-codex", 'model = "gpt-home-default"\n');
  const result = companion(ctx, ["adversarial-review", "--effort", "xhigh", "--model", "gpt-adversarial-pick", "--json"], { CODEX_HOME: inherited });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.backend, "codex");
  assert.equal(payload.sessionId, onlyJob(ctx).sessionId);
  assert.equal("threadId" in payload, false);
  const state = ctx.fakeState();
  // An inherited CODEX_HOME is the default home, passed through as it is.
  assert.deepEqual(state.spawnHomes, [inherited]);
  assert.deepEqual(state.threadStarts.map(start => start.model), ["gpt-adversarial-pick"]);
  assert.equal(state.lastTurnStart.model, "gpt-adversarial-pick");
  assert.equal(payload.result.findings[0].title, "Missing empty-state guard");
  assert.deepEqual(payload.notes, []);
  const turn = ctx.fakeState().lastTurnStart;
  assert.equal(turn.effort, "xhigh");
  assert.match(turn.prompt, /^<role>\nYou are Codex performing an adversarial software review\./);
  assert.match(turn.prompt, /Write the summary like a terse ship\/no-ship assessment, not a neutral recap\.\n<\/structured_output_contract>/);
  assert.doesNotMatch(turn.prompt, /output_schema/);
});

test("ZCode review: the plain prompt with the diff inlined, a fresh read-only session, a ZCode heading", t => {
  const answer = "ready to ship\nNo material findings.";
  const ctx = zcode(t, { answer });
  // Neither the fake's current model (GLM-5.3) nor the plugin's default effort (high).
  const result = companion(ctx, ["review", "--backend", "zcode", "--model", "glm-5.3-flash", "--effort", "low"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `# ZCode Review\n\nTarget: working tree diff\n\n${answer}\n`);

  const state = ctx.zcode();
  assert.equal(state.turns.length, 1);
  const prompt = state.turns[0].text;
  assert.match(prompt, /^<role>\nYou are ZCode performing a code review\./);
  assert.match(prompt, /Answer in plain text, not JSON\./);
  assert.match(prompt, /items\[0\]\.id/);
  assert.match(prompt, /Use the repository context below as primary evidence\./);
  assert.doesNotMatch(prompt, /adversarial/);
  assert.equal(state.requests.filter(r => r.method === "v4/command" && r.params.type === "createSession").length, 1);
  // A fresh session: its one session/resume reads the model list (glm-5.3-flash is not the
  // subscription's one model); it names no older session and sets no tools.
  const createdId = state.requests.find(r => r.method === "session/subscribe").params.sessionId;
  assert.deepEqual(state.requests.filter(r => r.method === "session/resume").map(r => r.params), [{ sessionId: createdId }]);
  assert.ok(state.inputs[0].toolDisallowlist.includes("Bash"));
  assert.equal(state.inputs[0].modelSelection.modelId, "GLM-5.3-Flash");
  assert.equal(state.inputs[0].modelSelection.options.reasoningLevel, "low");

  const job = onlyJob(ctx);
  assert.equal(job.state, "completed");
  assert.equal(job.request.backend, "zcode");
  assert.equal(job.request.mode, "read-only");
  assert.equal(job.sessionId, "sess_1");
  for (const args of [["status", job.id], ["status"], ["result", job.id]]) {
    assert.match(companion(ctx, args).stdout, /backend: zcode/, args.join(" "));
  }
  assert.match(fs.readFileSync(path.join(jobDirs(ctx)[0], "report.md"), "utf8"), /^# ZCode Review/);
});

test("Grok review runs under Grok's read-only profile, with its home and a Grok heading", t => {
  const ctx = grok(t, { answer: "needs changes\n[high] src/app.js:1: unguarded first item" });
  const home = path.join(ctx.user, ".grok-jobs");
  const result = companion(ctx, ["review", "--backend", "grok", "--grok-home", "jobs", "--model", "grok-4.7", "--effort", "high"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Grok Review\n\nTarget: working tree diff\n\nneeds changes\n/);

  const state = ctx.grok();
  assert.equal(state.starts.length, 1);
  assert.equal(state.starts[0].env.GROK_SANDBOX, "read-only");
  assert.equal(state.starts[0].env.GROK_HOME, home);
  assert.equal(state.requests.filter(r => r.method === "session/new").length, 1);
  assert.deepEqual(state.requests.filter(r => r.method === "session/set_config_option").map(r => [r.params.configId, r.params.value]), [["model", "grok-4.7"], ["reasoning_effort", "high"]]);
  assert.match(state.turns[0].text, /You are Grok performing a code review\./);
  assert.match(state.turns[0].text, /items\[0\]\.id/);

  const job = onlyJob(ctx);
  assert.equal(job.request.backend, "grok");
  assert.equal(job.request.grokHome, home);
  // The session Grok returned is recorded and printed.
  assert.equal(job.sessionId, "session-1");
  const status = companion(ctx, ["status", job.id]).stdout;
  assert.match(status, /^backend: grok$/m);
  assert.match(status, new RegExp(`^grok-home: ${home}$`, "m"));
  assert.match(status, /^kind: review$/m);
  assert.match(status, /^session: session-1$/m);
  assert.match(companion(ctx, ["result", job.id]).stdout, /^session: session-1$/m);

  const before = jobDirs(ctx);
  const json = companion(ctx, ["review", "--backend", "grok", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.sessionId, "session-2");
  assert.equal(newJobs(ctx, before)[0].sessionId, "session-2");
  assert.equal("threadId" in payload, false);
});

test("Kimi review runs read-only, refusing every write and command, with its home and a Kimi heading", t => {
  const ctx = kimi(t, { answer: "needs changes\n[high] src/app.js:1: unguarded first item", writes: true, permission: true });
  const home = path.join(ctx.user, ".kimi-code-jobs");
  const result = companion(ctx, ["review", "--backend", "kimi", "--kimi-home", "jobs", "--model", "kimi-code/k3", "--effort", "high"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Kimi Review\n\nTarget: working tree diff\n\nneeds changes\n/);
  const state = ctx.kimi();
  assert.equal(state.starts.length, 1);
  assert.equal(state.starts[0].env.KIMI_CODE_HOME, home);
  const requests = method => state.requests.filter(r => r.method === method);
  assert.deepEqual(requests("initialize")[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: true }, terminal: true });
  assert.deepEqual(requests("session/set_mode").map(r => r.params.modeId), ["default"]);
  assert.deepEqual(requests("session/set_config_option").map(r => [r.params.configId, r.params.value]), [["model", "kimi-code/k3"], ["thinking", "high"]]);
  assert.deepEqual(state.answers.map(a => [a.method, a.result?.outcome?.optionId ?? a.error?.message]), [
    ["session/request_permission", "reject"],
    ["fs/write_text_file", "This job is read-only: file writes are refused."],
    ["terminal/create", "This job is read-only: shell commands are refused."]
  ]);
  assert.match(state.turns[0].text, /You are Kimi performing a code review\./);
  assert.match(state.turns[0].text, /items\[0\]\.id/);
  const job = onlyJob(ctx);
  assert.equal(job.request.backend, "kimi");
  assert.equal(job.request.kimiHome, home);
  assert.equal(job.request.mode, "read-only");
  const status = companion(ctx, ["status", job.id]).stdout;
  assert.match(status, /^backend: kimi$/m);
  assert.match(status, new RegExp(`^kimi-home: ${home}$`, "m"));
  assert.match(status, /^kind: review$/m);
  assert.match(status, new RegExp(`^session: ${job.sessionId}$`, "m"));
});

test("adversarial review on ZCode and Grok: the schema travels in the prompt and the plugin checks the answer", t => {
  for (const [backend, label, install, answer, selection] of [
    ["zcode", "ZCode", zcode, JSON.stringify(VERDICT), ["--model", "glm-5.3-flash", "--effort", "max"]],
    // A single ```json fence around the whole answer is unwrapped.
    ["grok", "Grok", grok, "```json\n" + JSON.stringify(VERDICT, null, 2) + "\n```", ["--model", "grok-4.6", "--effort", "low"]],
    ["kimi", "Kimi", kimi, JSON.stringify(VERDICT), ["--model", "kimi-code/k3", "--effort", "max"]]
  ]) {
    const ctx = install(t, { answer });
    const result = companion(ctx, ["adversarial-review", "--backend", backend, ...selection, "focus on empty lists"]);
    assert.equal(result.status, 0, `${backend}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^# ${label} Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n`));
    assert.match(result.stdout, /- \[high\] Unguarded first item \(src\/app\.js:1\)/);
    const prompt = turnsOf(ctx, backend)[0].text;
    assert.match(prompt, new RegExp(`You are ${label} performing an adversarial software review\\.`));
    assert.match(prompt, /User focus: focus on empty lists/);
    assert.match(prompt, /This request carries no schema parameter, so the schema is below\./);
    assert.match(prompt, /<output_schema>\n\{\n {2}"\$schema"[\s\S]*"next_steps"[\s\S]*<\/output_schema>\n<\/structured_output_contract>/);
    const job = onlyJob(ctx);
    assert.equal(job.kind, "adversarial-review");
    assert.equal(job.state, "completed");
    assert.equal(job.summary, VERDICT.summary);
    if (backend === "kimi") {
      assert.deepEqual(ctx.kimi().requests.filter(r => r.method === "session/set_config_option").map(r => [r.params.configId, r.params.value]), [["model", "kimi-code/k3"], ["thinking", "max"]]);
      assert.deepEqual(ctx.kimi().requests.filter(r => r.method === "session/set_mode").map(r => r.params.modeId), ["default"]);
    } else if (backend === "zcode") {
      const [input] = ctx.zcode().inputs;
      assert.deepEqual([input.modelSelection.modelId, input.modelSelection.options.reasoningLevel], ["GLM-5.3-Flash", "max"]);
    } else {
      const state = ctx.grok();
      assert.equal(state.starts[0].env.GROK_SANDBOX, "read-only");
      assert.deepEqual(state.requests.filter(r => r.method === "session/set_config_option").map(r => [r.params.configId, r.params.value]), [["model", "grok-4.6"], ["reasoning_effort", "low"]]);
      assert.equal(job.sessionId, "session-1");
      for (const args of [["status", job.id], ["result", job.id]]) assert.match(companion(ctx, args).stdout, /^session: session-1$/m, args.join(" "));
    }
  }
});

test("invalid review JSON fails the review on every backend and keeps the raw answer", t => {
  const raw = {
    codex: "The change looks risky, but here is prose instead of JSON.",
    grok: "Looks fine to me.",
    zcode: JSON.stringify({ verdict: "approve", summary: "No findings." }),
    kimi: "Approved, no JSON here."
  };
  for (const [backend, label, make] of [
    ["codex", "Codex", () => codex(t, "adversarial-invalid-json")],
    ["grok", "Grok", () => grok(t, { answer: raw.grok })],
    ["zcode", "ZCode", () => zcode(t, { answer: raw.zcode })],
    ["kimi", "Kimi", () => kimi(t, { answer: raw.kimi })]
  ]) {
    const ctx = make();
    const result = companion(ctx, ["adversarial-review", "--backend", backend]);
    assert.equal(result.status, 1, `${backend}: ${result.stdout}`);
    assert.match(result.stdout, new RegExp(`^# ${label} Adversarial Review\n`), backend);
    assert.ok(result.stdout.includes(`Raw final message:\n\n\`\`\`text\n${raw[backend]}\n\`\`\``), result.stdout);
    const job = onlyJob(ctx);
    assert.equal(job.state, "failed", backend);
    assert.equal(job.errorMessage, `${label} returned no valid review JSON`);
    const report = fs.readFileSync(path.join(jobDirs(ctx)[0], "report.md"), "utf8");
    assert.ok(report.includes(raw[backend]), backend);
    const status = companion(ctx, ["status", job.id]).stdout;
    assert.match(status, /^state: failed$/m);
    assert.ok(status.includes(`${label} returned no valid review JSON`), status);
    // The turn completed: nothing says it failed.
    assert.doesNotMatch(result.stdout, /turn failed/, backend);
    if (backend !== "zcode") assert.ok(result.stdout.includes(`${label} did not return valid structured JSON.\n\n- Parse error: `), result.stdout);
  }
});

test("a failed adversarial-review turn says the turn failed with the backend's error on every backend, never that the JSON was invalid", t => {
  for (const [backend, label, make, error] of [
    // Codex sends a whole verdict, then fails the turn: the answer stays raw, not findings.
    ["codex", "Codex", () => codex(t, "adversarial-turn-failed"), "stream disconnected before completion"],
    ["grok", "Grok", () => grok(t, { stopReason: "max_tokens" }), "the turn ended with stop reason max_tokens"],
    ["zcode", "ZCode", () => zcode(t, { failTurn: "Model not found: glm-9" }), "Model not found: glm-9\ncode model_not_found"],
    ["kimi", "Kimi", () => kimi(t, { failTurn: true }), "[provider.connection_error] Connection error."]
  ]) {
    const ctx = make();
    const result = companion(ctx, ["adversarial-review", "--backend", backend]);
    assert.equal(result.status, 1, `${backend}: ${result.stdout}`);
    assert.ok(result.stdout.startsWith(`# ${label} Adversarial Review\n\nTarget: working tree diff\n\nThe ${label} turn failed: ${error}\n`), `${backend}: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /structured JSON|Parse error|no valid review JSON|unexpected review shape|^Verdict:/m, backend);
    if (backend === "codex") assert.ok(result.stdout.includes(`Raw final message:\n\n\`\`\`text\n{"verdict":"needs-attention"`), result.stdout);
    const job = onlyJob(ctx);
    assert.equal(job.state, "failed", backend);
    assert.equal(job.errorMessage, error, backend);
    const status = companion(ctx, ["status", job.id]).stdout;
    assert.match(status, /^state: failed$/m, backend);
    assert.doesNotMatch(status, /no valid review JSON/, backend);
    const json = JSON.parse(companion(ctx, ["adversarial-review", "--backend", backend, "--json"]).stdout);
    assert.deepEqual([json.turnError, json.result, json.parseError, json.validationError], [error, null, null, null], backend);
  }
});

const LIMIT = 256 * 1024;
const refusal = (what, label) => `The diff is ${what}; a ${label} review reads only an inlined diff. Narrow it with --base or --scope, or run it on Codex.\n`;

test("the inline limits are exact: two files and 256 KiB pass, a third file or one byte more is refused before a job or a server", t => {
  // Two changed files pass; a third is refused.
  const ctx = zcode(t, {}, { "src/a.js": "a\n", "src/b.js": "b\n" });
  assert.equal(companion(ctx, ["review", "--backend", "zcode"]).status, 0);
  fs.writeFileSync(path.join(ctx.work, "src", "app.js"), "c\n");
  const before = jobDirs(ctx);
  const three = companion(ctx, ["review", "--backend", "zcode"]);
  assert.equal(three.status, 1);
  assert.equal(three.stderr, refusal("3 files / 1 KiB", "ZCode"));
  assert.deepEqual(jobDirs(ctx), before);
  assert.equal(ctx.zcode().starts.length, 1);

  // A binary untracked file is named, not inlined, and counts as a file; its size, here above
  // the byte limit, does not count, since nothing of it reaches the prompt.
  const binary = zcode(t, { answer: JSON.stringify(VERDICT) }, undefined, { "src/blob.bin": Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.alloc(300 * 1024, 7)]) });
  assert.equal(companion(binary, ["adversarial-review", "--backend", "zcode"]).status, 0);
  assert.match(binary.zcode().turns[0].text, /### src\/blob\.bin\n\(skipped: binary file\)/);
  fs.writeFileSync(path.join(binary.work, "src", "c.js"), "c\n");
  assert.equal(companion(binary, ["adversarial-review", "--backend", "zcode"]).stderr, refusal("3 files / 1 KiB", "ZCode"));
  assert.equal(binary.zcode().starts.length, 1);

  // Working tree: an untracked file of exactly 256 KiB is inlined whole; one byte more is refused.
  const bytes = grok(t, {}, {}, { "src/new.txt": sized(LIMIT, "WHOLE_FILE_END") });
  assert.equal(companion(bytes, ["review", "--backend", "grok"]).status, 0);
  assert.ok(bytes.grok().turns[0].text.includes(sized(LIMIT, "WHOLE_FILE_END").trimEnd()));
  fs.writeFileSync(path.join(bytes.work, "src", "new.txt"), sized(LIMIT + 1, "WHOLE_FILE_END"));
  const over = companion(bytes, ["review", "--backend", "grok"]);
  assert.equal(over.status, 1);
  assert.equal(over.stderr, refusal("1 file / more than 256 KiB", "Grok"));
  assert.equal(jobDirs(bytes).length, 1);
  assert.equal(bytes.grok().starts.length, 1);

  // Branch: a diff of exactly 256 KiB against --base passes; one byte more is refused.
  const branch = zcode(t, { answer: JSON.stringify(VERDICT) }, null);
  const git = (...args) => assert.equal(run("git", args, { cwd: branch.work }).status, 0, args.join(" "));
  initGitRepo(branch.work);
  fs.writeFileSync(path.join(branch.work, "base.txt"), "base\n");
  git("add", "."); git("commit", "-m", "base"); git("checkout", "-b", "feature");
  const diffBytes = () => Buffer.byteLength(run("git", ["diff", "--binary", "--no-ext-diff", "--submodule=diff", "main..HEAD"], { cwd: branch.work }).stdout);
  const commitBig = (length, amend) => {
    fs.writeFileSync(path.join(branch.work, "big.txt"), `${"y".repeat(length - 1)}\n`);
    git("add", "."); git("commit", ...(amend ? ["--amend"] : []), "-m", "big");
  };
  commitBig(1000, false);
  const content = 1000 + LIMIT - diffBytes();
  commitBig(content, true);
  assert.equal(diffBytes(), LIMIT);
  assert.equal(companion(branch, ["adversarial-review", "--backend", "zcode", "--base", "main"]).status, 0);
  commitBig(content + 1, true);
  assert.equal(diffBytes(), LIMIT + 1);
  assert.equal(companion(branch, ["adversarial-review", "--backend", "zcode", "--base", "main"]).stderr, refusal("1 file / more than 256 KiB", "ZCode"));
  assert.equal(jobDirs(branch).length, 1);
  assert.equal(branch.zcode().starts.length, 1);

  // Codex still reviews three files: its own reviewer reads the repository.
  const codexCtx = codex(t);
  for (const name of ["src/a.js", "src/b.js", "src/c.js"]) fs.writeFileSync(path.join(codexCtx.work, name), "new\n");
  assert.equal(companion(codexCtx, ["review"]).status, 0);
});

test("where Grok refuses its read-only profile, both reviews fail with Grok's error and no turn", t => {
  for (const command of ["review", "adversarial-review"]) {
    const ctx = grok(t, { sandboxFail: true });
    const result = companion(ctx, [command, "--backend", "grok"]);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /Refusing to start with its protections missing/);
    const state = ctx.grok();
    assert.equal(state.starts.length, 1);
    assert.equal(state.starts[0].env.GROK_SANDBOX, "read-only");
    assert.equal(state.requests.length, 0);
    assert.equal(state.turns.length, 0);
    const job = onlyJob(ctx);
    assert.equal(job.state, "failed");
    assert.match(job.errorMessage, /Refusing to start with its protections missing/);
    assert.equal(readJob(ctx, job.id).request.mode, "read-only");
  }
});

test("a failed ZCode review turn fails the job with ZCode's error under a ZCode heading", t => {
  const ctx = zcode(t, { failTurn: "Model not found: glm-9" });
  const result = companion(ctx, ["review", "--backend", "zcode", "--model", "glm-9"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^# ZCode Review\n\nTarget: working tree diff\n\nZCode review failed: Model not found: glm-9/);
  const job = onlyJob(ctx);
  assert.equal(job.state, "failed");
  assert.match(job.errorMessage, /Model not found: glm-9/);
  // The failing model is the one the review asked for.
  assert.equal(ctx.zcode().inputs[0].modelSelection.modelId, "glm-9");
});

// An inline-only review sees the whole change or does not start.
test("untracked files count toward the inline limits and are inlined whole on Grok, ZCode and Kimi, both commands", t => {
  for (const [backend, label, install] of [["grok", "Grok", grok], ["zcode", "ZCode", zcode], ["kimi", "Kimi", kimi]]) {
    for (const command of ["review", "adversarial-review"]) {
      const what = `${backend} ${command}`;
      // 30 KiB: above the 24 KiB per-file cut Codex's context uses, below the limit.
      const below = install(t, { answer: JSON.stringify(VERDICT) }, {}, { "src/new.js": sized(30 * 1024, "UNTRACKED_TAIL") });
      const ok = companion(below, [command, "--backend", backend]);
      assert.equal(ok.status, 0, `${what}: ${ok.stderr}`);
      const prompt = turnsOf(below, backend)[0].text;
      assert.ok(prompt.includes(sized(30 * 1024, "UNTRACKED_TAIL").trimEnd()), what);
      assert.doesNotMatch(prompt, /exceeds \d+ byte limit/, what);

      const above = install(t, {}, {}, { "src/new.js": sized(300 * 1024, "UNTRACKED_TAIL") });
      const refused = companion(above, [command, "--backend", backend]);
      assert.equal(refused.status, 1, what);
      assert.equal(refused.stderr, refusal("1 file / more than 256 KiB", label), what);
      assert.equal(jobDirs(above).length, 0, what);
      assert.equal(backend === "zcode" ? fs.existsSync(above.zcodeState) : backend === "kimi" ? above.kimi().starts.length > 0 : above.grok().starts.length > 0, false, what);
    }
  }
});

// --base and --scope branch select the branch diff on Grok, ZCode and Kimi.
test("--base and --scope branch reach Grok, ZCode and Kimi reviews: the branch diff, not the dirty working tree", t => {
  for (const [backend, install] of [["grok", grok], ["zcode", zcode], ["kimi", kimi]]) {
    for (const target of [["--base", "main"], ["--scope", "branch"]]) {
      const ctx = install(t, { answer: JSON.stringify(VERDICT) }, null);
      const git = (...args) => assert.equal(run("git", args, { cwd: ctx.work }).status, 0, args.join(" "));
      initGitRepo(ctx.work);
      fs.writeFileSync(path.join(ctx.work, "app.js"), "base\n");
      git("add", "."); git("commit", "-m", "base"); git("checkout", "-b", "feature");
      fs.writeFileSync(path.join(ctx.work, "branch.js"), "BRANCH_ONLY_MARKER\n");
      git("add", "branch.js"); git("commit", "-m", "branch work");
      fs.writeFileSync(path.join(ctx.work, "app.js"), "WORKTREE_ONLY_MARKER\n");
      for (const command of ["review", "adversarial-review"]) {
        const what = `${backend} ${command} ${target.join(" ")}`;
        const result = companion(ctx, [command, "--backend", backend, ...target]);
        assert.equal(result.status, 0, `${what}: ${result.stderr}`);
        const turns = turnsOf(ctx, backend);
        const prompt = turns[turns.length - 1].text;
        assert.match(prompt, /Target: branch diff against main/, what);
        assert.match(prompt, /BRANCH_ONLY_MARKER/, what);
        assert.doesNotMatch(prompt, /WORKTREE_ONLY_MARKER/, what);
      }
    }
  }
});

// An answer counts only if it matches review-output.schema.json.
test("schema-invalid review JSON fails the review on Codex, Grok, ZCode and Kimi", t => {
  const finding = VERDICT.findings[0];
  const cases = [
    ["enum", { ...VERDICT, verdict: "banana" }],
    ["nested", { ...VERDICT, findings: [null] }],
    ["type", { ...VERDICT, next_steps: [null] }],
    ["range", { ...VERDICT, findings: [{ ...finding, line_start: 0, confidence: 2 }] }],
    ["additional property", { ...VERDICT, extra: true }]
  ];
  for (const [backend, label, make] of [
    ["codex", "Codex", () => codex(t)],
    ["grok", "Grok", () => grok(t)],
    ["zcode", "ZCode", () => zcode(t)],
    ["kimi", "Kimi", () => kimi(t)]
  ]) {
    const ctx = make();
    for (const [name, answer] of cases) {
      const what = `${backend} ${name}`;
      const raw = JSON.stringify(answer);
      const before = jobDirs(ctx);
      const result = companion(ctx, ["adversarial-review", "--backend", backend], { FAKE_REVIEW_ANSWER: raw });
      assert.equal(result.status, 1, `${what}: ${result.stdout}`);
      assert.ok(result.stdout.includes(`Raw final message:\n\n\`\`\`text\n${raw}\n\`\`\``), `${what}: ${result.stdout}`);
      assert.doesNotMatch(result.stdout, /^Verdict:/m, what);
      const [job] = newJobs(ctx, before);
      assert.equal(job.state, "failed", what);
      assert.equal(job.errorMessage, `${label} returned no valid review JSON`, what);
    }
    // The same fake accepts a valid answer: the failures above are the schema's.
    const valid = companion(ctx, ["adversarial-review", "--backend", backend], { FAKE_REVIEW_ANSWER: JSON.stringify(VERDICT) });
    assert.equal(valid.status, 0, `${backend}: ${valid.stdout}`);
  }
});

test("task selects its requested backend and validates it before launch", t => {
  const ctx = grok(t, { turnMs: 50 }, null);
  for (const name of ["unknown", ""]) {
    const invalid = companion(ctx, ["task", "--backend", name, "Task"]);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.trim(), "backend must be codex, grok, zcode or kimi.");
    assert.equal(jobDirs(ctx).length, 0);
  }
  const result = companion(ctx, ["task", "--backend", "grok", "--json", "Task"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(onlyJob(ctx).request.backend, "grok");
  assert.equal(JSON.parse(result.stdout).state, "completed");
});
