import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { readLaunchPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { COMPANION, companion, relayContext, relayStart } from "./support/relay-fixture.mjs";
import { makeTempDir, run } from "./support/helpers.mjs";

const prompt = (extra = "", brief = "hi") => `model: m\neffort: low\n${extra}\n---\n${brief}`;

function context() {
  const work = makeTempDir();
  const home = path.join(work, "jobs");
  return { work, home, env: { ...process.env, RELAY_JOBS_HOME: home } };
}

function check(ctx, text, argv = []) {
  return run(process.execPath, [COMPANION, "check-header", ...argv], { cwd: ctx.work, env: ctx.env, input: text });
}

test("check-header prints ok for a valid prompt and creates nothing", () => {
  const ctx = context();
  const before = fs.readdirSync(ctx.work);
  const result = check(ctx, prompt());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(ctx.home), false);
  assert.deepEqual(fs.readdirSync(ctx.work), before);
});

const refusals = [
  ["no header", "hi", /The prompt has no header:/],
  ["a line without key: value", prompt("not a header line"), /Header line is not `key: value`: not a header line/],
  ["an unknown key", prompt("efort: low"), /Unknown header key "efort"/],
  ["missing model", "effort: low\n---\nhi", /model is required/],
  ["missing effort", "model: m\n---\nhi", /effort is required/],
  ["an unknown backend", prompt("backend: imaginary"), /backend must be codex, grok, zcode or kimi/],
  ["another backend's model without backend", "model: grok-4.7\neffort: low\n---\nhi", /is a Grok model, and with no backend:/],
  ["a backend-only key on another backend", prompt("grok-home: default"), /grok-home is only valid with backend: grok/],
  ["an invalid mode", prompt("mode: imaginary"), /mode must be one of/],
  ["a mode refused by the backend", prompt("backend: zcode\nmode: write"), /mode: write is not supported for ZCode/],
  ["an invalid web-search value", prompt("web-search: imaginary"), /web-search must be one of/],
  ["a web-search value refused by the backend", prompt("backend: grok\nweb-search: cached"), /web-search: cached is not supported for Grok/],
  ["network that is not boolean", prompt("network: maybe"), /network must be true or false/],
  ["cd that is not a directory", prompt("cd: missing"), /cd is not a directory:/],
  ["add-dir that does not exist", prompt("add-dir: missing"), /add-dir does not exist:/],
  ["a missing brief file", prompt("brief: missing", ""), /ENOENT:.*missing/],
  ["text after the dashes with brief", prompt("brief: missing"), /The header names a brief file, so nothing may follow the dashes\./],
  ["an empty brief", prompt("", " \t\n"), /The brief is empty\./]
];

for (const [name, text, expected] of refusals) {
  test(`check-header refuses ${name} on stdout and leaves jobs home absent`, () => {
    const ctx = context();
    const result = check(ctx, text);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^error: [^\r\n]+\n$/);
    assert.match(result.stdout, expected);
    assert.equal(fs.existsSync(ctx.home), false);
    assert.deepEqual(fs.readdirSync(ctx.work), []);
  });
}

test("readLaunchPrompt and check-header resolve cd, add-dir and brief against the working directory", () => {
  const ctx = context();
  fs.mkdirSync(path.join(ctx.work, "project"));
  fs.mkdirSync(path.join(ctx.work, "extra"));
  fs.writeFileSync(path.join(ctx.work, "brief.md"), " The brief, byte for byte.\n");
  const text = prompt("cd: project\nadd-dir: extra\nbrief: brief.md", " \n");
  const launch = readLaunchPrompt(text, { baseDir: ctx.work, env: ctx.env });
  assert.equal(launch.request.cwd, path.join(ctx.work, "project"));
  assert.deepEqual(launch.request.addDirs, [path.join(ctx.work, "extra")]);
  assert.equal(launch.brief, " The brief, byte for byte.\n");
  const result = check(ctx, text);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(ctx.home), false);
});

test("check-header collapses a newline in an error message to one line", () => {
  const ctx = context();
  ctx.work = path.join(ctx.work, "line\nbreak");
  fs.mkdirSync(ctx.work);
  const result = check(ctx, prompt("cd: missing"));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `error: cd is not a directory: ${path.join(ctx.work, "missing").replace(/\s+/g, " ")}\n`);
  assert.equal(result.stderr, "");
});

test("check-header errors equal start --from-relay errors for the same prompts", async () => {
  for (const text of ["hi", prompt("efort: low"), prompt("backend: imaginary"), prompt("network: maybe"), prompt("brief: missing", ""), prompt("", "")]) {
    const ctx = relayContext();
    ctx.append(ctx.prompt(text));
    const checked = check(ctx, text);
    const { started, jobId } = await relayStart(ctx);
    assert.equal(jobId, null);
    assert.equal(started.status, 1, started.stdout + started.stderr);
    assert.equal(checked.status, 1);
    assert.equal(checked.stdout, started.stdout.split("\n").filter(line => line.startsWith("error: ")).join("\n") + "\n");
    assert.equal(checked.stderr, "");
  }
});

test("start --prompt-file uses the shared brief validation before request validation", () => {
  const ctx = relayContext();
  const file = path.join(ctx.work, "prompt.md");
  fs.writeFileSync(file, "backend: imaginary\n---\n");
  const result = companion(ctx, ["start", "--prompt-file", file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "The brief is empty.\n");
  assert.deepEqual(fs.readdirSync(ctx.home), []);
});

test("check-header reads user config without changing any existing jobs-home files", () => {
  const ctx = context();
  fs.mkdirSync(ctx.home);
  const file = path.join(ctx.home, "config.json");
  const config = '{"fastTier":"off"}\n';
  fs.writeFileSync(file, config);
  const launch = readLaunchPrompt(prompt("fast: true"), { baseDir: ctx.work, env: ctx.env });
  assert.equal(launch.request.fast, false);
  assert.match(launch.request.notes.join("\n"), /fast tier is off/);
  for (const text of [prompt("fast: true"), prompt("network: maybe")]) {
    const result = check(ctx, text);
    assert.equal(result.status, text.includes("maybe") ? 1 : 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readdirSync(ctx.home), ["config.json"]);
    assert.equal(fs.readFileSync(file, "utf8"), config);
  }
});

test("check-header unknown options are usage errors on stderr without an error line on stdout", () => {
  const ctx = context();
  const result = check(ctx, prompt(), ["--unknown"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "check-header takes no arguments.\n");
  assert.equal(fs.existsSync(ctx.home), false);
});

test("companion usage describes check-header's stdin and output", () => {
  const ctx = context();
  const result = run(process.execPath, [COMPANION, "help"], { cwd: ctx.work, env: ctx.env });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.split("\n").includes("  companion.mjs check-header   (reads a relay:job prompt on stdin; prints ok, or error: <the reason start would refuse it>)"));
});
