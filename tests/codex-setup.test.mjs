import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeCodex } from "./fakes/codex.mjs";
import { makeTempDir, run } from "./support/helpers.mjs";
import { ROOT, SCRIPT, setupEnv, codexBlock } from "./support/runtime-fixture.mjs";

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: setupEnv(binDir)
  });

  assert.equal(result.status, 0);
  const { payload, codex } = codexBlock(result);
  assert.equal(payload.ready, true);
  assert.equal(codex.ready, true);
  assert.equal(codex.version, "codex-cli test");
  assert.equal(codex.signIn.state, "signed-in");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: setupEnv(binDir, { PATH: binDir })
  });

  assert.equal(result.status, 0, result.stderr);
  const { payload, codex } = codexBlock(result);
  assert.equal(payload.ready, true);
  assert.equal(Object.hasOwn(payload, "npm"), false);
  assert.equal(codex.ready, true);
  assert.equal(codex.signIn.state, "signed-in");
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: setupEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const { payload, codex } = codexBlock(result);
  assert.equal(payload.ready, true);
  assert.deepEqual(codex.signIn, { state: "signed-in", method: "api-key", detail: "API key configured (unverified)" });
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: setupEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const { payload, codex } = codexBlock(result);
  assert.equal(payload.ready, true);
  assert.equal(codex.signIn.state, "not-needed");
  assert.equal(codex.signIn.method, "ollama");
  assert.match(codex.signIn.detail, /provider ollama, no OpenAI sign-in needed/);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: setupEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const { payload, codex } = codexBlock(result);
  assert.equal(payload.ready, true);
  assert.equal(codex.signIn.state, "not-needed");
  assert.equal(codex.signIn.method, "openai-custom");
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: setupEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const { payload, codex } = codexBlock(result);
  assert.equal(payload.ready, false);
  assert.equal(codex.ready, false);
  assert.equal(codex.signIn.state, "unknown");
  assert.match(codex.signIn.detail, /config\/read failed for cwd/);
});
