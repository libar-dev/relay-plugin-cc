// The user-level job MCP switch names only servers in the Codex home's TOML. A job stores
// the names it passed, so continue, resume and recovery cannot invent a new list.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { companion, finishJob, HEADER, makeHome, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";

const HOME_CONFIG = 'model = "gpt-test"\n[mcp_servers.node_repl]\ncommand = "node"\n[mcp_servers.skipped]\ncommand = "node"\n';

function spawnArgs(ctx) {
  try {
    return ctx.fakeState().spawnArgs ?? [];
  } catch {
    return [];
  }
}

test("setup round-trips job-mcp-off and rejects malformed values", t => {
  const ctx = setup(t);
  const set = companion(ctx, ["setup", "--job-mcp-off", "node_repl, cua_repl"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^settings: fast tier off · job MCP servers off: node_repl, cua_repl · /m);
  // Only the switch's own key is written: the fast tier stays unset, which reads as off.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.jobs, "config.json"), "utf8")), { mcpOff: ["node_repl", "cua_repl"] });

  const shown = companion(ctx, ["setup"]);
  assert.match(shown.stdout, /^settings: fast tier off · job MCP servers off: node_repl, cua_repl · /m);

  const cleared = companion(ctx, ["setup", "--job-mcp-off", "none"]);
  assert.match(cleared.stdout, /^settings: fast tier off · job MCP servers off: none · /m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.jobs, "config.json"), "utf8")).mcpOff, []);

  for (const value of ["", "none,node_repl", "bad.name"]) {
    const failed = companion(ctx, ["setup", "--job-mcp-off", value]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /--job-mcp-off/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.jobs, "config.json"), "utf8")).mcpOff, []);
});

test("a Codex start reads ~/.codex/config.toml, passes defined names, skips undefined names and stores the used list", async t => {
  const ctx = setup(t);
  makeHome(ctx, ".codex", HOME_CONFIG);
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ mcpOff: ["node_repl", "missing", "node_repl"] }));
  const { id, start } = startJob(ctx, HEADER);
  assert.match(start, /^mcp-off: node_repl$/m);
  assert.match(start, /^note: job-mcp-off skips missing: it is not in this home's config\.toml\.$/m);
  await finishJob(ctx, id);
  assert.deepEqual(readJob(ctx, id).request.mcpOff, ["node_repl"]);
  for (const args of [["result", id], ["status", id], ["result", id, "--state-only"], ["wait", id, "--state-only"]]) {
    const output = companion(ctx, args);
    assert.equal(output.status, 0, output.stderr || output.stdout);
    assert.match(output.stdout, /^mcp-off: node_repl$/m, args.join(" "));
  }
  assert.deepEqual(spawnArgs(ctx), [["app-server", "-c", "mcp_servers.node_repl.enabled=false"]]);
});

test("an empty setting passes no override and a resumed job keeps its stored list", async t => {
  const ctx = setup(t, { turnMs: 30000 });
  makeHome(ctx, ".codex", HOME_CONFIG);
  const { id, start } = startJob(ctx, HEADER, "Long first turn.", { FAKE_CODEX_TURN_MS: "30000" });
  assert.doesNotMatch(start, /^mcp-off:/m);
  assert.deepEqual(readJob(ctx, id).request.mcpOff, []);
  await waitFor(() => spawnArgs(ctx).length > 0);
  assert.deepEqual(spawnArgs(ctx).at(-1), ["app-server"]);

  await waitFor(() => readJob(ctx, id).turnId);
  process.kill(readJob(ctx, id).worker.pid, "SIGKILL");
  await waitFor(() => companion(ctx, ["status", id]).stdout.match(/^state: dead$/m));
  const jobFile = path.join(ctx.jobs, fs.readdirSync(ctx.jobs)[0], id, "job.json");
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  job.request.mcpOff = ["node_repl"];
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  const resumed = companion(ctx, ["resume", id], { FAKE_CODEX_TURN_MS: "50" });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  await finishJob(ctx, id);
  assert.deepEqual(readJob(ctx, id).request.mcpOff, ["node_repl"]);
  assert.deepEqual(spawnArgs(ctx).at(-1), ["app-server", "-c", "mcp_servers.node_repl.enabled=false"]);
});

test("ZCode requests carry no Codex MCP setting", t => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ mcpOff: ["node_repl"] }));
  const request = buildLaunchRequest(
    { backend: "zcode", model: "glm-5.3", effort: "high" },
    { baseDir: ctx.work, env: ctx.env }
  );
  assert.equal(Object.hasOwn(request, "mcpOff"), false);
});


test("an inherited CODEX_HOME supplies MCP definitions instead of ~/.codex", async t => {
  const ctx = setup(t);
  makeHome(ctx, ".codex", '[mcp_servers.cua_repl]\ncommand = "node"\n');
  ctx.env.CODEX_HOME = makeHome(ctx, "inherited-codex", HOME_CONFIG);
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ mcpOff: ["node_repl", "cua_repl"] }));
  const { id, start } = startJob(ctx);
  assert.match(start, /^mcp-off: node_repl$/m);
  assert.match(start, /^note: job-mcp-off skips cua_repl:/m);
  await finishJob(ctx, id);
  assert.deepEqual(readJob(ctx, id).request.mcpOff, ["node_repl"]);
  assert.deepEqual(spawnArgs(ctx), [["app-server", "-c", "mcp_servers.node_repl.enabled=false"]]);
});

test("completed empty MCP lists omit the line from result, status and state-only output", async t => {
  const ctx = setup(t);
  makeHome(ctx, ".codex", HOME_CONFIG);
  const { id } = startJob(ctx);
  await finishJob(ctx, id);
  assert.deepEqual(readJob(ctx, id).request.mcpOff, []);
  for (const args of [["result", id], ["status", id], ["result", id, "--state-only"], ["wait", id, "--state-only"]]) {
    const output = companion(ctx, args);
    assert.equal(output.status, 0, output.stderr || output.stdout);
    assert.doesNotMatch(output.stdout, /^mcp-off:/m, args.join(" "));
  }
});

for (const [route, diagnostic] of [
  [["--backend", "grok"], "Use setup --backend on its own, without --job-mcp-off."],
  [["--backend", "zcode"], "Use setup --backend on its own, without --job-mcp-off."],
  [["--backend", "codex"], "Use setup --backend on its own, without --job-mcp-off."]
]) {
  test(`setup ${route.join(" ")} rejects --job-mcp-off before configuration or backend checks`, t => {
    const ctx = setup(t);
    makeHome(ctx, ".codex", HOME_CONFIG);
    const configPath = path.join(ctx.jobs, "config.json");
    const original = JSON.stringify({ mcpOff: ["cua_repl"], fastTier: "off" });
    fs.writeFileSync(configPath, original);
    const marker = path.join(ctx.root, "backend-check");
    const probe = path.join(ctx.bin, "backend-probe");
    fs.writeFileSync(probe, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); process.exit(1);\n`, { mode: 0o755 });
    // Codex resolves through PATH; the other routes support explicit binaries.
    fs.copyFileSync(probe, path.join(ctx.bin, "codex"));
    fs.chmodSync(path.join(ctx.bin, "codex"), 0o755);
    const failed = companion(ctx, ["setup", ...route, "--job-mcp-off", "node_repl"], { GROK_BINARY: probe, ZCODE_BINARY: probe, KIMI_BINARY: probe });
    assert.equal(failed.status, 1, failed.stdout);
    assert.ok(failed.stderr.includes(diagnostic), failed.stderr);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
    assert.equal(fs.existsSync(marker), false, "setup must not start a backend check");
  });
}

test("Grok requests carry neither Codex MCP overrides nor skip notes", t => {
  const ctx = setup(t);
  makeHome(ctx, ".codex", HOME_CONFIG);
  fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ mcpOff: ["node_repl", "missing"] }));
  const request = buildLaunchRequest(
    { backend: "grok", model: "grok-test", effort: "low" },
    { baseDir: ctx.work, env: ctx.env }
  );
  assert.equal(Object.hasOwn(request, "mcpOff"), false);
  assert.ok(request.notes.every(note => !note.includes("job-mcp-off")), JSON.stringify(request.notes));
});

for (const spelling of ["node_repl", '\"node_repl\"', "'node_repl'"]) {
  test(`MCP header ${spelling} resolves the supported server name`, t => {
    const ctx = setup(t);
    makeHome(ctx, ".codex", `[mcp_servers.${spelling}]\ncommand = "node"\n`);
    fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ mcpOff: ["node_repl"] }));
    const request = buildLaunchRequest({ model: "gpt-test", effort: "low" }, { baseDir: ctx.work, env: ctx.env });
    assert.deepEqual(request.mcpOff, ["node_repl"]);
    assert.ok(request.notes.every(note => !note.includes("job-mcp-off")), JSON.stringify(request.notes));
  });
}
