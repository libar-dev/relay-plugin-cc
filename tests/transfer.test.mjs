import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { buildEnv, installFakeCodex } from "./fakes/codex.mjs";
import { initGitRepo, makeTempDir, run } from "./support/helpers.mjs";
import { SCRIPT } from "./support/runtime-fixture.mjs";

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/relay:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      RELAY_COMPANION_SESSION_ID: sessionId
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/relay:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

async function sessionResolver(t, id = "sess-lookup") {
  const home = makeTempDir("relay-transfer-lookup-");
  t.mock.method(os, "homedir", () => home);
  const previous = process.env.RELAY_COMPANION_SESSION_ID;
  if (id == null) delete process.env.RELAY_COMPANION_SESSION_ID;
  else process.env.RELAY_COMPANION_SESSION_ID = id;
  t.after(() => {
    if (previous == null) delete process.env.RELAY_COMPANION_SESSION_ID;
    else process.env.RELAY_COMPANION_SESSION_ID = previous;
  });
  const { resolveClaudeSessionPath } = await import(`../plugins/relay/scripts/lib/harness/session-path.mjs?home=${encodeURIComponent(home)}`);
  const projects = path.join(home, ".claude", "projects");
  const transcript = (folder, name = id) => {
    const dir = path.join(projects, folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    return file;
  };
  return { home, projects, transcript, resolve: resolveClaudeSessionPath };
}

test("session lookup finds the id directly inside one project folder, regardless of cwd", async t => {
  const ctx = await sessionResolver(t);
  ctx.transcript("-other", "another-session");
  const source = ctx.transcript("-project");
  ctx.transcript("-nested/subagents");
  assert.equal(ctx.resolve("/unrelated"), fs.realpathSync(source));
});

test("session lookup with no match asks for an explicit source", async t => {
  const ctx = await sessionResolver(t);
  const message = "Could not find the transcript of Claude session sess-lookup in ~/.claude/projects. Retry with --source <path-to-claude-jsonl>.";
  assert.throws(() => ctx.resolve(ctx.home), { message });
  ctx.transcript("-project", "another-session");
  ctx.transcript("-nested/subagents");
  fs.mkdirSync(path.join(ctx.projects, "-project", "sess-lookup.jsonl"));
  assert.throws(() => ctx.resolve(ctx.home), { message });
});

test("session lookup names both matches and asks for --source", async t => {
  const ctx = await sessionResolver(t);
  const first = ctx.transcript("-first");
  const second = ctx.transcript("-second");
  assert.throws(() => ctx.resolve(ctx.home), {
    message: `Found several transcripts of Claude session sess-lookup: ${first}, ${second}. Retry with --source <path-to-claude-jsonl>.`
  });
  assert.equal(ctx.resolve(ctx.home, { source: first }), fs.realpathSync(first));
});

test("invalid session ids are refused before any filesystem access", async t => {
  const ctx = await sessionResolver(t);
  const calls = ["readdirSync", "statSync", "realpathSync", "readFileSync", "existsSync"].map(name => t.mock.method(fs, name, () => {
    throw new Error(`Unexpected ${name}`);
  }));
  for (const id of ["/", "..", "a/b", "a..b", "a_b", "-abc", "abc\n", "a b", "é"]) {
    process.env.RELAY_COMPANION_SESSION_ID = id;
    assert.throws(() => ctx.resolve(ctx.home), { message: `Invalid Claude session id: ${id}. Retry with --source <path-to-claude-jsonl>.` });
  }
  for (const call of calls) assert.equal(call.mock.callCount(), 0);
});

test("--source wins even over an invalid session id and still resolves relative and home paths", async t => {
  const ctx = await sessionResolver(t, "../invalid");
  const source = ctx.transcript("-project", "explicit");
  const expected = fs.realpathSync(source);
  assert.equal(ctx.resolve(ctx.home, { source: path.relative(ctx.home, source) }), expected);
  assert.equal(ctx.resolve(ctx.home, { source: `~/${path.relative(ctx.home, source)}` }), expected);
  assert.throws(() => ctx.resolve(ctx.home, { source: "bad.txt" }), /must be a JSONL file/);
  assert.throws(() => ctx.resolve(ctx.home, { source: "missing.jsonl" }), /Claude session file not found/);
});

test("session lookup keeps the real-path boundary check", async t => {
  const ctx = await sessionResolver(t);
  const source = ctx.transcript("-project");
  const outside = path.join(ctx.home, "outside.jsonl");
  fs.writeFileSync(outside, "{}\n");
  fs.unlinkSync(source);
  fs.symlinkSync(outside, source);
  assert.throws(() => ctx.resolve(ctx.home), /only from .*\.claude.*projects/);
});

test("transfer with neither session id nor --source fails without using the old transcript variable", () => {
  const home = makeTempDir("relay-transfer-no-id-");
  const result = run(process.execPath, [SCRIPT, "transfer"], {
    cwd: home,
    env: { ...process.env, HOME: home, RELAY_COMPANION_SESSION_ID: "", RELAY_COMPANION_TRANSCRIPT_PATH: "/tmp/old-session.jsonl" }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Could not identify the current Claude session. Retry with --source <path-to-claude-jsonl>.\n");
});
