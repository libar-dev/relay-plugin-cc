import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchRequest, parseHeaderPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { companion, finishJob, HEADER, makeHome, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo } from "./support/helpers.mjs";

test("Codex budgets validate before launch and are refused by other backends", t => {
  const ctx = setup(t);
  const build = value => buildLaunchRequest({ model: "gpt-test", effort: "low", toolOutputTokenLimit: value }, { baseDir: ctx.work, env: ctx.env });
  for (const value of ["", "0", "-1", "1.5", "1e5", "Infinity", "NaN", "9007199254740992", "default"]) {
    assert.throws(() => build(value), /tool-output-token-limit must be a positive safe integer/);
  }
  assert.equal(build("65536").toolOutputTokenLimit, 65536);
  assert.equal(Object.hasOwn(build(undefined), "toolOutputTokenLimit"), false);
  const { header } = parseHeaderPrompt(`${HEADER}\ntool-output-token-limit: 131072 # tokens\n---\nReview`);
  assert.equal(buildLaunchRequest(header, { baseDir: ctx.work, env: ctx.env }).toolOutputTokenLimit, 131072);
  for (const backend of ["grok", "zcode", "kimi"]) {
    assert.throws(() => buildLaunchRequest({ ...header, backend }, { baseDir: ctx.work, env: ctx.env }), /tool-output-token-limit is only valid with backend: codex/);
  }
});

test("an explicit budget is stored, visible, and passed on start, continue and resume", async t => {
  const ctx = setup(t);
  const home = makeHome(ctx, ".codex", "tool_output_token_limit = 8192\n");
  const { id, start } = startJob(ctx, `${HEADER}\ntool-output-token-limit: 131072`);
  assert.match(start, /^tool-output-token-limit: 131072$/m);
  await finishJob(ctx, id);
  fs.writeFileSync(path.join(home, "config.toml"), "tool_output_token_limit = 16384\n");
  for (const command of ["continue", "resume"]) {
    const result = companion(ctx, [command, id, "--message", "[quick] Check another file."]);
    assert.equal(result.status, 0, result.stderr);
    await finishJob(ctx, id);
  }
  assert.equal(readJob(ctx, id).request.toolOutputTokenLimit, 131072);
  const opens = ctx.fakeState().requests.filter(r => ["thread/start", "thread/resume"].includes(r.method));
  assert.deepEqual(opens.map(r => r.method), ["thread/start", "thread/resume", "thread/resume"]);
  assert.deepEqual(opens.map(r => r.params.config.tool_output_token_limit), [131072, 131072, 131072]);
  const status = companion(ctx, ["status", id, "--json"]);
  assert.equal(JSON.parse(status.stdout).toolOutputTokenLimit, 131072);
  assert.match(companion(ctx, ["result", id, "--state-only"]).stdout, /^tool-output-token-limit: 131072$/m);
});

test("an omitted budget leaves Codex configuration in control on start and resume", async t => {
  const ctx = setup(t);
  const { id } = startJob(ctx);
  await finishJob(ctx, id);
  assert.equal(companion(ctx, ["resume", id, "--message", "[quick] Continue."]).status, 0);
  await finishJob(ctx, id);
  assert.equal(Object.hasOwn(readJob(ctx, id).request, "toolOutputTokenLimit"), false);
  for (const r of ctx.fakeState().requests.filter(r => ["thread/start", "thread/resume"].includes(r.method))) {
    assert.equal(Object.hasOwn(r.params.config, "tool_output_token_limit"), false);
  }
});

test("a replacement worker restores the stored budget after worker death", async t => {
  const ctx = setup(t, { turnMs: 30000 });
  const { id } = startJob(ctx, `${HEADER}\ntool-output-token-limit: 65536`, "Read the synthetic input.");
  await waitFor(() => readJob(ctx, id).turnId);
  process.kill(readJob(ctx, id).worker.pid, "SIGKILL");
  await waitFor(() => companion(ctx, ["status", id]).stdout.match(/^state: dead$/m));
  const result = companion(ctx, ["resume", id], { FAKE_CODEX_TURN_MS: "50" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await finishJob(ctx, id);
  const resumed = ctx.fakeState().requests.find(r => r.method === "thread/resume");
  assert.equal(resumed.params.config.tool_output_token_limit, 65536);
  assert.equal(readJob(ctx, id).request.toolOutputTokenLimit, 65536);
});

test("start accepts the budget as a flag without a prompt header", async t => {
  const ctx = setup(t);
  const brief = path.join(ctx.root, "brief.txt");
  fs.writeFileSync(brief, "[quick] Review the synthetic input.");
  const result = companion(ctx, ["start", "--model", "gpt-test", "--effort", "low", "--tool-output-token-limit", "65536", "--brief-file", brief, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const started = JSON.parse(result.stdout);
  assert.equal(started.toolOutputTokenLimit, 65536);
  await finishJob(ctx, started.jobId);
  assert.equal(ctx.fakeState().threadStarts[0].config.tool_output_token_limit, 65536);
});

for (const command of ["task", "review", "adversarial-review"]) {
  test(`${command} accepts and passes the Codex budget flag`, t => {
    const ctx = setup(t, { behavior: "default" });
    initGitRepo(ctx.work);
    fs.writeFileSync(path.join(ctx.work, "sample.txt"), "synthetic review input\n");
    const args = command === "task" ? ["[quick] Read sample.txt"] : ["--scope", "working-tree"];
    const result = companion(ctx, [command, "--tool-output-token-limit", "65536", ...args]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(ctx.fakeState().threadStarts[0].config.tool_output_token_limit, 65536);
  });
}

for (const [label, response, expected] of [
  ["user", { config: { tool_output_token_limit: 65536 }, origins: { tool_output_token_limit: { name: { type: "user", file: "/synthetic/config.toml" } } } }, { value: 65536, source: "user configuration (/synthetic/config.toml)" }],
  ["project", { config: { tool_output_token_limit: 131072 }, origins: { tool_output_token_limit: { name: { type: "project", dotCodexFolder: "/synthetic/project/.codex" } } } }, { value: 131072, source: "project configuration (/synthetic/project/.codex)" }],
  ["missing origin", { config: { tool_output_token_limit: 32768 } }, { value: 32768, source: "configuration (source not reported)" }],
  ["model default", { config: {} }, { value: null, source: "model default (numeric budget not reported)" }],
  ["zero", { config: { tool_output_token_limit: 0 } }, { value: 0, source: "configuration (source not reported)" }],
  ["invalid", { config: { tool_output_token_limit: "bad" } }, { value: null, source: "unknown (unrecognized configured budget)" }]
]) {
  test(`setup reports ${label} budget without changing configuration or opening a thread`, t => {
    const ctx = setup(t, { env: { FAKE_CODEX_CONFIG_READ: JSON.stringify(response) } });
    const home = makeHome(ctx);
    const before = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    const result = companion(ctx, ["setup", "--backend", "codex", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).backends[0].toolOutputTokenLimit, expected);
    const text = companion(ctx, ["setup", "--backend", "codex"]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(expected.source), text.stdout);
    assert.match(text.stdout, /^tool-output-token-limit:/m);
    assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), before);
    assert.equal(ctx.fakeState().threadStarts?.length ?? 0, 0);
    assert.equal(fs.realpathSync(ctx.fakeState().configReads[0].cwd), fs.realpathSync(ctx.work));
    assert.equal(ctx.fakeState().configReads[0].includeLayers, true);
  });
}
