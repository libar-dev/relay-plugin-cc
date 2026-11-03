import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchRequest, parseHeaderPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { companion, finishJob, HEADER, makeHome, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo } from "./support/helpers.mjs";
import { TOOL_OUTPUT_BUDGETS } from "../plugins/relay/scripts/lib/backends/codex/request.mjs";

const VERSION = TOOL_OUTPUT_BUDGETS.version;

test("Codex budgets validate before launch and are refused by other backends", t => {
  const ctx = setup(t);
  const build = value => buildLaunchRequest({ model: "gpt-test", effort: "low", toolOutputTokenLimit: value }, { baseDir: ctx.work, env: ctx.env });
  for (const value of ["", "0", "-1", "1.5", "1e5", "Infinity", "NaN", "9007199254740992", "default", "maximum"]) {
    assert.throws(() => build(value), /tool-output-token-limit must be compact, balanced, deep, inherit or a positive safe integer/);
  }
  assert.equal(build("65536").toolOutputTokenLimit, 65536);
  assert.equal(Object.hasOwn(build(undefined), "toolOutputTokenLimit"), false);
  // A preset is stored as chosen and resolved when the thread opens.
  assert.deepEqual(["Compact", "balanced", "deep", "inherit"].map(preset => [build(preset).toolOutputPreset, build(preset).toolOutputTokenLimit]), [["compact", undefined], ["balanced", undefined], ["deep", undefined], ["inherit", undefined]]);
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

test("without a budget, a table model gets its default budget on start and resume, with a note", async t => {
  const ctx = setup(t);
  const { id } = startJob(ctx, "model: gpt-6.1-sol\neffort: low");
  await finishJob(ctx, id);
  assert.equal(companion(ctx, ["resume", id, "--message", "[quick] Continue."]).status, 0);
  await finishJob(ctx, id);
  assert.equal(Object.hasOwn(readJob(ctx, id).request, "toolOutputTokenLimit"), false);
  const opens = ctx.fakeState().requests.filter(r => ["thread/start", "thread/resume"].includes(r.method));
  assert.deepEqual(opens.map(r => r.params.config.tool_output_token_limit), [131072, 131072]);
  const state = companion(ctx, ["result", id, "--state-only"]).stdout;
  assert.equal(state.match(/^note: tool-output-token-limit: .*$/gm).join("\n"), `note: tool-output-token-limit: 131072, Relay's deep budget for gpt-6.1-sol (reviewed ${VERSION}).`);
});

for (const [label, header, configRead, expected] of [
  ["Astra's default is balanced", "model: gpt-6-astra", { config: {} }, 65536],
  ["Luna's default is deep", "model: gpt-6-luna", { config: {} }, 65536],
  ["a default-model job takes the configured model's default", "model: default", { config: { model: "gpt-6.1-terra" } }, 131072],
  ["a default-model job resolves its preset when the thread opens", "model: default\ntool-output-token-limit: compact", { config: { model: "gpt-6-luna" } }, 16384],
  ["a budget in the Codex configuration wins over the default", "model: gpt-6.1-sol", { config: { tool_output_token_limit: 8192 } }, undefined],
  ["a preset wins over the Codex configuration", "model: gpt-6.1-sol\ntool-output-token-limit: balanced", { config: { tool_output_token_limit: 8192 } }, 65536],
  ["inherit sends no budget", "model: gpt-6.1-sol\ntool-output-token-limit: inherit", { config: {} }, undefined],
  ["an unreviewed model without a known window", "model: gpt-test", { config: {} }, 65536],
  ["an unreviewed model's catalog window", "model: gpt-wide", { config: {} }, 131072],
  ["an unreviewed model's preset", "model: gpt-small\ntool-output-token-limit: compact", { config: {} }, 8192],
  ["the configured context window", "model: gpt-test", { config: { model_context_window: 1000000 } }, 262144],
  ["the configured context window under a named model's preset", "model: gpt-custom\ntool-output-token-limit: deep", { config: { model_context_window: 32768 } }, 8192],
  ["the configured context window under a default model's preset", "model: default\ntool-output-token-limit: deep", { config: { model: "gpt-custom", model_context_window: 32768 } }, 8192],
  ["the configured context window over a conflicting catalog entry", "model: gpt-wide\ntool-output-token-limit: deep", { config: { model_context_window: 32768 } }, 8192],
  ["the configured context window over a reviewed model's values", "model: gpt-6.1-sol\ntool-output-token-limit: deep", { config: { model_context_window: 32768 } }, 8192],
  ["a reviewed model's default under a configured context window", "model: gpt-6-astra", { config: { model_context_window: 1000000 } }, 262144]
]) {
  test(`budget: ${label}`, async t => {
    const ctx = setup(t, { env: { FAKE_CODEX_CONFIG_READ: JSON.stringify(configRead) } });
    fs.writeFileSync(path.join(makeHome(ctx), "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-wide", context_window: 500000 }, { slug: "gpt-small", context_window: 128000 }] }));
    const { id } = startJob(ctx, `${header}\neffort: low`);
    await finishJob(ctx, id);
    assert.equal(ctx.fakeState().threadStarts[0].config.tool_output_token_limit, expected);
    if (label.includes("without a known window")) {
      assert.match(companion(ctx, ["result", id, "--state-only"]).stdout, /^note: tool-output-token-limit: 65536, Relay's deep budget for gpt-test \(context window not reported, 272000 assumed\)\.$/m);
    }
    if (label.includes("catalog window")) {
      assert.match(companion(ctx, ["result", id, "--state-only"]).stdout, /^note: tool-output-token-limit: 131072, Relay's deep budget for gpt-wide \(context 500000 \/ 4\)\.$/m);
    }
  });
}

test("a native review without a budget gets the configured model's default", t => {
  const ctx = setup(t, { behavior: "default", env: { FAKE_CODEX_CONFIG_READ: JSON.stringify({ config: { model: "gpt-6-astra" } }) } });
  initGitRepo(ctx.work);
  fs.writeFileSync(path.join(ctx.work, "sample.txt"), "synthetic review input\n");
  const result = companion(ctx, ["review", "--scope", "working-tree"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(ctx.fakeState().threadStarts[0].config.tool_output_token_limit, 65536);
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
  ["unset on a table model", { config: { model: "gpt-6.1-sol" } }, { value: 131072, source: `Relay's deep budget for gpt-6.1-sol (reviewed ${VERSION})` }],
  ["unset on another model", { config: {} }, { value: 65536, source: "Relay's deep budget for the default model (context window not reported, 272000 assumed)" }],
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
    assert.equal(ctx.fakeState().configReads[0].includeLayers, false);
  });
}

for (const [label, header, configRead, expected] of [
  ["a budget above code mode's default tells the model how to ask for it", "model: gpt-6.1-sol", { config: {} }, { has: "\"max_output_tokens\": 131072" }],
  ["the instruction says the nested value alone is not enough, and to read what a truncation names", "model: gpt-6.1-sol", { config: {} }, { has: "alone does not change that" }],
  ["the instruction tells the model to read large evidence by range", "model: gpt-6.1-sol", { config: {} }, { has: "read the omitted part before relying on it" }],
  ["a configured budget reaches code mode, after the user's developer instructions", "model: gpt-6.1-sol", { config: { tool_output_token_limit: 65536, developer_instructions: "Keep answers short." } }, { starts: "Keep answers short.\n\n", has: "\"max_output_tokens\": 65536" }],
  ["a budget at or below code mode's default adds no instructions", "model: gpt-6.1-sol\ntool-output-token-limit: 8192", { config: {} }, null],
  ["inherit without a configured budget adds no instructions", "model: gpt-6.1-sol\ntool-output-token-limit: inherit", { config: {} }, null]
]) {
  test(`code mode: ${label}`, async t => {
    const ctx = setup(t, { env: { FAKE_CODEX_CONFIG_READ: JSON.stringify(configRead) } });
    const { id } = startJob(ctx, `${header}\neffort: low`);
    await finishJob(ctx, id);
    assert.equal(companion(ctx, ["resume", id, "--message", "[quick] Continue."]).status, 0);
    await finishJob(ctx, id);
    const opens = ctx.fakeState().requests.filter(r => ["thread/start", "thread/resume"].includes(r.method));
    for (const open of opens) {
      const instructions = open.params.developerInstructions;
      if (!expected) { assert.equal(instructions, undefined, open.method); continue; }
      assert.ok(instructions.includes(expected.has), instructions);
      assert.match(instructions, /`wait`/);
      if (expected.starts) assert.ok(instructions.startsWith(expected.starts), instructions);
    }
  });
}

test("a budget flag beside a prompt file wins over the file's header", async t => {
  const ctx = setup(t);
  const file = path.join(ctx.root, "prompt.md");
  fs.writeFileSync(file, `${HEADER}\ntool-output-token-limit: 131072\n---\n[quick] Read the synthetic input.`);
  const result = companion(ctx, ["start", "--prompt-file", file, "--tool-output-token-limit", "65536", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const started = JSON.parse(result.stdout);
  assert.equal(started.toolOutputTokenLimit, 65536);
  await finishJob(ctx, started.jobId);
  assert.equal(ctx.fakeState().threadStarts[0].config.tool_output_token_limit, 65536);
});

test("a native review prints the budget Relay chose and passes code mode's instructions", t => {
  const ctx = setup(t, { behavior: "default", env: { FAKE_CODEX_CONFIG_READ: JSON.stringify({ config: { model: "gpt-6.1-sol" } }) } });
  initGitRepo(ctx.work);
  fs.writeFileSync(path.join(ctx.work, "sample.txt"), "synthetic review input\n");
  const result = companion(ctx, ["review", "--scope", "working-tree"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`^note: tool-output-token-limit: 131072, Relay's deep budget for gpt-6.1-sol \\(reviewed ${VERSION}\\)\\.$`, "m"));
  assert.ok(ctx.fakeState().threadStarts[0].developerInstructions.includes("\"max_output_tokens\": 131072"));
});
