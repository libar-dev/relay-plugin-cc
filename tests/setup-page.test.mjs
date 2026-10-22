// The setup page checks each backend without opening a turn.
// Every test runs in a scratch HOME with fake backends.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { companion, makeHome, setup, waitFor, ROOT } from "./support/job-helpers.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { installFakeZcode } from "./fakes/zcode.mjs";
import { installFakeKimi, signInFakeKimiHome } from "./fakes/kimi.mjs";
import { run } from "./support/helpers.mjs";
import { backendReadyEnv } from "./support/backend-ready.mjs";

const BLOCK_KEYS = ["backend", "home", "homeDefault", "selector", "binary", "binaryIsScript", "realBinary", "version", "signIn",
  "model", "modelNote", "effort", "effortNote", "modelsReason", "models", "can", "warnings", "ready", "error", "elapsedMs"].sort();

// Every backend installed and signed in: Codex in ~/.codex, Grok in ~/.grok and ~/.grok-jobs,
// ZCode with credentials and a default model, Kimi in ~/.kimi-code. A custom Codex home is
// used only when CODEX_HOME selects it.
function everyBackend(t, codexBehavior = "job", grokOptions = {}) {
  const ctx = setup(t, { behavior: codexBehavior });
  if (codexBehavior === "home-probe") makeHome(ctx, ".codex", 'model = "gpt-default"\nmodel_reasoning_effort = "high"\n');
  makeHome(ctx, ".codex-custom", 'model = "glm-5.3"\nmodel_provider = "zai"\n');
  ctx.grok = installFakeGrok(ctx.bin, grokOptions).state;
  fs.mkdirSync(path.join(ctx.user, ".grok-jobs"));
  ctx.zcode = installFakeZcode(ctx.bin).state;
  const zcodeDir = path.join(ctx.user, ".zcode", "v2");
  fs.mkdirSync(zcodeDir, { recursive: true });
  fs.writeFileSync(path.join(zcodeDir, "credentials.json"), '{"encrypted":"x"}');
  fs.writeFileSync(path.join(zcodeDir, "provider_config.json"), JSON.stringify({ config: { defaultModelSelection: { providerId: "account:fake-plan", modelId: "GLM-5.3" } } }));
  ctx.kimi = installFakeKimi(ctx.bin).state;
  signInFakeKimiHome(path.join(ctx.user, ".kimi-code"));
  return ctx;
}

function page(ctx, args = [], env = {}) {
  const result = companion(ctx, ["setup", ...args, "--json"], env);
  return { status: result.status, stderr: result.stderr, page: result.stdout ? JSON.parse(result.stdout) : null };
}

test("the overview shows every backend home in one shape, ready, with no thread, kept session or agent", t => {
  const ctx = everyBackend(t, "home-probe");
  const { status, page: report } = page(ctx);
  assert.equal(status, 0);
  assert.deepEqual(Object.keys(report).sort(), ["actionsTaken", "backends", "jobsHome", "nextSteps", "ready", "relayBuild", "relayVersion", "schema", "settings"]);
  assert.deepEqual(report.settings, { fastTier: "off", mcpOff: [], reviewGate: false });
  assert.equal(report.jobsHome, ctx.jobs);
  assert.equal(report.ready, true);
  assert.deepEqual(report.backends.map(block => [block.backend, block.selector, block.ready]), [
    ["codex", null, true], ["grok", null, true], ["grok", "jobs", true], ["zcode", null, true], ["kimi", null, true]
  ]);
  for (const block of report.backends) {
    assert.deepEqual(Object.keys(block).sort(), BLOCK_KEYS, block.backend);
    assert.deepEqual(Object.keys(block.signIn).sort(), ["detail", "method", "state"]);
    assert.deepEqual(Object.keys(block.can).sort(), ["adversarialReview", "modes", "resume", "review", "steer", "stopGate", "transfer", "webSearchOff"]);
  }
  const [codex, grok, grokJobs, zcode, kimi] = report.backends;
  assert.equal(codex.home, path.join(ctx.user, ".codex"));
  assert.equal(codex.version, "codex-cli test");
  assert.deepEqual(codex.signIn, { state: "signed-in", method: "chatgpt", detail: "ChatGPT login active for test@example.com" });
  // The app-server reads the home's config.toml.
  assert.equal(codex.model, "gpt-default");
  assert.equal(codex.effort, "high");
  assert.deepEqual(codex.models, [{ id: "gpt-fake-sol", efforts: ["low", "medium", "high"], defaultEffort: "low" }, { id: "gpt-fake-luna", efforts: ["low", "medium"], defaultEffort: "medium" }]);
  assert.equal(codex.can.stopGate, true);
  // Reviews run on Grok, ZCode and Kimi; the stop gate and transfer require Codex.
  assert.deepEqual([grok, zcode, kimi].map(block => [block.can.review, block.can.adversarialReview, block.can.stopGate, block.can.transfer]), [[true, true, false, false], [true, true, false, false], [true, true, false, false]]);
  assert.equal(grok.home, path.join(ctx.user, ".grok"));
  assert.equal(grokJobs.home, path.join(ctx.user, ".grok-jobs"));
  assert.deepEqual(grok.signIn.state, "signed-in");
  assert.equal(grok.model, "grok-4.7");
  assert.deepEqual(grok.models.map(model => model.id), ["grok-4.7", "grok-4.6"]);
  assert.equal(grok.models[0].efforts, null);
  assert.match(grok.modelsReason, /not probed/);
  assert.equal(zcode.signIn.state, "credentials-present");
  assert.equal(zcode.model, "account:fake-plan/GLM-5.3");
  assert.equal(zcode.effort, "high");
  // Every model the sign-in serves, from a ZCode draft session that setup closes unsaved.
  assert.deepEqual(zcode.models.map(model => model.id), ["account:fake-plan/GLM-5.3", "account:fake-plan/GLM-5.3-Flash"]);
  assert.equal(zcode.modelsReason, null);
  assert.deepEqual(zcode.can.modes, ["yolo", "read-only"]);
  // Kimi: the providers and models `kimi provider list --json` prints, the credentials file's
  // presence, and the defaults in config.toml. Its API key field is never read.
  assert.equal(kimi.home, path.join(ctx.user, ".kimi-code"));
  assert.equal(kimi.version, "2.2.0-fake");
  assert.deepEqual(kimi.signIn, { state: "credentials-present", method: "kimi login", detail: path.join(ctx.user, ".kimi-code", "credentials", "kimi-code-env-fake.json") });
  assert.equal(kimi.model, "kimi-code/k3");
  assert.equal(kimi.effort, "high");
  assert.deepEqual(kimi.models, [{ id: "kimi-code/k3", efforts: ["low", "high", "max"], defaultEffort: "max" }, { id: "kimi-code/kimi-for-coding-highspeed", efforts: null, defaultEffort: null }]);
  assert.deepEqual(kimi.can, { modes: ["yolo", "read-only"], steer: false, resume: true, webSearchOff: false, review: true, adversarialReview: true, stopGate: false, transfer: false });
  assert.doesNotMatch(JSON.stringify(report), /FAKE-SECRET-KEY/);

  // Sources only: account/read, config/read, model/list; no thread, no Grok agent; for ZCode,
  // one server and one draft session, closed, with no message.
  const codexState = ctx.fakeState();
  assert.deepEqual(codexState.requests ?? [], []);
  assert.deepEqual(codexState.spawnHomes, [path.join(ctx.user, ".codex")]);
  assert.deepEqual(ctx.grok().invocations.map(call => call.args.join(" ")).sort(), ["--version", "models", "models"]);
  assert.deepEqual(ctx.grok().invocations.filter(call => call.args[0] === "models").map(call => call.env.GROK_HOME).sort(), [path.join(ctx.user, ".grok"), path.join(ctx.user, ".grok-jobs")]);
  assert.equal(ctx.grok().starts.length, 0);
  assert.deepEqual(ctx.zcode().invocations.map(call => call.args.join(" ")).sort(), ["--version", "app-server"]);
  assert.deepEqual(ctx.zcode().requests.filter(r => r.method).map(r => r.method), ["runtime/capabilities", "session/create", "session/close"]);
  assert.deepEqual(Object.values(ctx.zcode().drafts).map(draft => [draft.persistence, draft.open]), [["deferred", false]]);
  assert.equal(ctx.zcode().turns.length, 0);
  assert.deepEqual(ctx.kimi().invocations.map(call => call.args.join(" ")).sort(), ["--version", "provider list --json"]);
  assert.equal(ctx.kimi().invocations.find(call => call.args[0] === "provider").env.KIMI_CODE_HOME, path.join(ctx.user, ".kimi-code"));
  assert.equal(ctx.kimi().starts.length, 0);

  const text = companion(ctx, ["setup"]);
  assert.equal(text.status, 0, text.stderr);
  for (const line of [
    "# relay setup",
    "settings: fast tier off · job MCP servers off: none · review gate off (this repository)",
    "## codex  ~/.codex  ready",
    "sign-in: signed in (ChatGPT, test@example.com)",
    "model: gpt-default  effort: high",
    "models: gpt-fake-sol, gpt-fake-luna",
    "can: yolo, write, read-only · steer · resume · web search off · review · adversarial review · stop gate · transfer",
    "## grok  ~/.grok  ready",
    "## grok  ~/.grok-jobs  ready    (grok-home: jobs)",
    "sign-in: signed in (grok.com)",
    "models: grok-4.7, grok-4.6  (efforts need grok agent; not probed)",
    "can: yolo, write, read-only · steer · resume · review · adversarial review · stop gate, transfer: Codex only",
    "## zcode  ~/.zcode  ready",
    "sign-in: credentials present (checked by the first turn)",
    "model: account:fake-plan/GLM-5.3  effort: high (plugin default; ZCode's own is max)",
    "models: account:fake-plan/GLM-5.3, account:fake-plan/GLM-5.3-Flash",
    "can: yolo, read-only (write refused) · steer · resume · web search off (tool filter) · review · adversarial review · stop gate, transfer: Codex only",
    "## kimi  ~/.kimi-code  ready",
    "model: kimi-code/k3  effort: high",
    "models: kimi-code/k3, kimi-code/kimi-for-coding-highspeed",
    "can: yolo, read-only (write refused) · steer (next turn) · resume · review · adversarial review · stop gate, transfer: Codex only",
    "Setup made no changes.",
    "Optional: `/relay:setup --enable-review-gate` has Codex review each turn's edits before the main thread stops (Codex only, off by default; skips while agents or jobs run)."
  ]) assert.ok(text.stdout.split("\n").includes(line), `${line}\n---\n${text.stdout}`);
  assert.doesNotMatch(text.stdout, /codex-custom/);
});

test("a backend that is not installed prints its reason and never fails the overview", t => {
  const ctx = setup(t, { behavior: "job" });
  const { status, page: report } = page(ctx);
  assert.equal(status, 0);
  const grok = report.backends.find(block => block.backend === "grok");
  assert.equal(grok.signIn.state, "not-installed");
  assert.equal(grok.ready, false);
  assert.equal(grok.binary, null);
  assert.equal(report.backends.find(block => block.backend === "zcode").signIn.state, "not-installed");
  assert.equal(report.ready, true, "the Codex home is ready");
  const text = companion(ctx, ["setup"]).stdout;
  assert.match(text, /^## grok {2}~\/\.grok {2}not installed\ngrok: not installed \(GROK_BINARY or PATH; see grok-home\.md\)$/m);
  assert.match(text, /^## zcode {2}~\/\.zcode {2}not installed\nzcode: not installed \(ZCODE_BINARY or PATH\)$/m);
  assert.match(text, /^## kimi {2}~\/\.kimi-code {2}not installed\nkimi: not installed \(KIMI_BINARY, PATH or ~\/\.kimi-code\/bin; see kimi-home\.md\)$/m);
  assert.equal(companion(ctx, ["setup", "--backend", "grok"]).status, 1);

  // Codex missing: the install offer is the next step only when npm is on PATH.
  const bare = setup(t, { behavior: "job" });
  fs.rmSync(path.join(bare.bin, "codex"));
  const nodeOnly = path.join(bare.root, "node-only");
  fs.mkdirSync(nodeOnly);
  fs.symlinkSync(process.execPath, path.join(nodeOnly, "node"));
  const missing = page(bare, [], { PATH: `${bare.bin}${path.delimiter}${nodeOnly}` }).page;
  assert.equal(missing.backends[0].signIn.state, "not-installed");
  assert.equal(missing.ready, false);
  assert.ok(missing.nextSteps.some(step => step.includes("npm is not on PATH")), missing.nextSteps.join("\n"));
});

test("a signed-out backend shows binary, sign-in and model, then stops; --backend keeps the non-zero exit", t => {
  const ctx = everyBackend(t, "logged-out", { signedOut: true });
  const { status, page: report } = page(ctx);
  assert.equal(status, 0);
  // A signed-out Grok home is asked twice before setup says so.
  assert.equal(ctx.grok().invocations.filter(call => call.args[0] === "models").length, 4);
  const codex = report.backends[0];
  assert.equal(codex.signIn.state, "signed-out");
  assert.equal(codex.ready, false);
  assert.ok(report.nextSteps.includes("Run `!codex login`."));
  assert.ok(!report.nextSteps.some(step => step.includes("CODEX_HOME=")), report.nextSteps.join("\n"));
  const grok = report.backends.find(block => block.backend === "grok");
  assert.equal(grok.signIn.state, "signed-out");
  assert.match(grok.signIn.detail, /Not signed in/);
  assert.ok(report.nextSteps.some(step => step.includes(`GROK_HOME=${path.join(ctx.user, ".grok")} grok login`)));
  assert.equal(report.backends.find(block => block.backend === "zcode").ready, true);
  const text = companion(ctx, ["setup"]).stdout;
  const block = text.slice(text.indexOf("## codex  ~/.codex  signed out"), text.indexOf("## grok  ~/.grok "));
  assert.match(block, /^binary: .*\(codex-cli test\)$/m);
  assert.match(block, /^sign-in: signed out \(run codex login\)$/m);
  assert.match(block, /^model: gpt-fake-sol/m);
  assert.doesNotMatch(block, /^(models|can):/m);
  assert.equal(companion(ctx, ["setup", "--backend", "codex"]).status, 1);
  assert.equal(companion(ctx, ["setup", "--backend", "grok"]).status, 1);
  assert.equal(companion(ctx, ["setup", "--backend", "zcode"]).status, 0);
});

// A wrapper in front of a fake backend, as a user's wrapper script would be: it records its
// pid, leaves a child of its own running in its process group, and runs the real binary.
// `barrier` holds the given subcommand until `parties` checks have reached it.
function wrapBinary(ctx, name, { barrier = null, gate = null, parties = 0, versionExit = null } = {}) {
  const real = path.join(ctx.bin, `${name}-real`);
  fs.renameSync(path.join(ctx.bin, name), real);
  const pids = path.join(ctx.root, `${name}.pids`);
  const lines = [
    "#!/bin/sh",
    `echo $$ >> '${pids}'`,
    `'${process.execPath}' -e 'setInterval(() => {}, 1000)' setup-wrapper-child > /dev/null 2>&1 &`,
    `echo $! >> '${pids}'`
  ];
  if (barrier) {
    lines.push(
      `if [ "$1" = "${gate}" ]; then`,
      `  touch '${barrier}/${name}-'$$`,
      "  i=0",
      `  while [ "$(ls '${barrier}' | wc -l)" -lt ${parties} ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done`,
      "fi"
    );
  }
  if (versionExit != null) lines.push(`if [ "$1" = "--version" ]; then echo "${name} wrapper failed" >&2; exit ${versionExit}; fi`);
  // exec: the fake keeps the wrapper's pid, by which it says it runs (backend-ready.mjs).
  lines.push(`exec '${real}' "$@"`);
  fs.writeFileSync(path.join(ctx.bin, name), `${lines.join("\n")}\n`, { mode: 0o755 });
  return () => fs.readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number);
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

async function assertAllGone(pids, what) {
  await waitFor(() => pids.every(isGone), 3000).catch(() => {});
  assert.deepEqual(pids.filter(pid => !isGone(pid)), [], what);
}

test("a check that hangs answers with its time limit while the others finish, and nothing it started survives", async t => {
  const ctx = everyBackend(t, "job", { modelsHangMs: 60000 });
  const codexPids = wrapBinary(ctx, "codex");
  const grokPids = wrapBinary(ctx, "grok");
  // A command that fails leaves its child behind too.
  const zcodePids = wrapBinary(ctx, "zcode", { versionExit: 3 });
  // Each limit counts from a process that runs: the checks meant to finish must, however slowly
  // the fakes start, and only the hanging ones reach their limits.
  const limits = { FAKE_CODEX_SETUP_HANG: "1", RELAY_SETUP_SERVER_MS: "800", RELAY_SETUP_COMMAND_MS: "600", ...backendReadyEnv(ctx.env) };
  const { status, page: report } = page(ctx, [], limits);
  assert.equal(status, 0);
  for (const codex of report.backends.filter(block => block.backend === "codex")) {
    assert.deepEqual(codex.signIn, { state: "unknown", method: null, detail: "no answer in 0.8 s" });
    assert.equal(codex.ready, false);
  }
  for (const grok of report.backends.filter(block => block.backend === "grok")) {
    assert.equal(grok.signIn.state, "unknown");
    assert.equal(grok.error, "grok models: no answer in 0.6 s");
  }
  const zcode = report.backends.find(block => block.backend === "zcode");
  assert.equal(zcode.ready, false);
  assert.equal(zcode.error, "zcode --version failed (exit 3). zcode wrapper failed");
  // Every wrapper and every child it left: the Codex server and the version check, the Grok
  // version check and both listings, the failed ZCode version check.
  assert.equal(codexPids().length, 4);
  assert.equal(grokPids().length, 6);
  assert.equal(zcodePids().length, 2);
  await assertAllGone([...codexPids(), ...grokPids(), ...zcodePids()], "no wrapper and no child of one survives setup");
  const text = companion(ctx, ["setup"], limits).stdout;
  assert.match(text, /^## codex {2}~\/\.codex {2}needs attention\n.*\nsign-in: unknown \(no answer in 0\.8 s\)$/m);
  await assertAllGone([...codexPids(), ...grokPids(), ...zcodePids()], "nor after the text page");
});

// The checks overlap. The Codex server and each Grok listing wait at a barrier
// until all three have started, so a check that waited for another's end would time out.
test("every home's check runs at once with the others, and setup ends what each started when it completes", async t => {
  const ctx = everyBackend(t, "home-probe");
  const barrier = path.join(ctx.root, "barrier");
  fs.mkdirSync(barrier);
  const codexPids = wrapBinary(ctx, "codex", { barrier, gate: "app-server", parties: 3 });
  const grokPids = wrapBinary(ctx, "grok", { barrier, gate: "models", parties: 3 });
  const { status, page: report } = page(ctx, [], { RELAY_SETUP_SERVER_MS: "8000", RELAY_SETUP_COMMAND_MS: "8000" });
  assert.equal(status, 0);
  assert.equal(fs.readdirSync(barrier).length, 3);
  assert.deepEqual(report.backends.map(block => [block.backend, block.selector, block.ready, block.error]), [
    ["codex", null, true, null], ["grok", null, true, null], ["grok", "jobs", true, null], ["zcode", null, true, null], ["kimi", null, true, null]
  ]);
  await assertAllGone([...codexPids(), ...grokPids()], "every wrapper and its child end when their checks complete");
});

// One backend's bad answer never takes down the overview.
test("a malformed Codex catalog entry is skipped and the overview still prints every block", t => {
  const ctx = everyBackend(t, "home-probe");
  const fake = path.join(ctx.bin, "codex");
  const source = fs.readFileSync(fake, "utf8");
  assert.ok(source.includes("result: { data: ["));
  fs.writeFileSync(fake, source.replace("result: { data: [", 'result: { data: [null, 7, { "id": null }, '));
  const { status, page: report } = page(ctx);
  assert.equal(status, 0);
  assert.deepEqual(report.backends.map(block => [block.backend, block.selector, block.ready]), [
    ["codex", null, true], ["grok", null, true], ["grok", "jobs", true], ["zcode", null, true], ["kimi", null, true]
  ]);
  assert.deepEqual(report.backends[0].models.map(model => model.id), ["gpt-fake-sol", "gpt-fake-luna"]);
  const text = companion(ctx, ["setup"]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.match(/^## /gm).length, 5);
});

// Capability facts have one declaration; the text and the JSON agree.
test("every block's can: line says what its JSON can says, and nothing else", t => {
  const ctx = everyBackend(t, "home-probe");
  const report = page(ctx).page;
  const text = companion(ctx, ["setup"]).stdout;
  const sections = text.split(/^(?=## )/m).slice(1);
  assert.equal(sections.length, report.backends.length);
  const features = [["review", "review"], ["adversarialReview", "adversarial review"], ["stopGate", "stop gate"], ["transfer", "transfer"]];
  report.backends.forEach((block, index) => {
    const line = /^can: (.*)$/m.exec(sections[index])?.[1];
    assert.ok(line, sections[index]);
    const items = line.split(" · ");
    assert.equal(items[0].replace(/ \(.*\)$/, ""), block.can.modes.join(", "), line);
    assert.equal(items.includes("steer"), block.can.steer, line);
    assert.equal(items.includes("resume"), block.can.resume, line);
    assert.equal(items.some(item => item.startsWith("web search off")), block.can.webSearchOff, line);
    const lacking = items.find(item => item.includes(": ")) ?? "";
    for (const [key, words] of features) {
      assert.equal(items.includes(words), block.can[key], `${key}: ${line}`);
      if (!block.can[key]) assert.ok(lacking.startsWith("reviews:") || lacking.split(": ")[0].split(", ").includes(words), `${key}: ${line}`);
    }
  });
  // The fixed table, as the page prints it.
  const grok = report.backends.find(block => block.backend === "grok");
  assert.deepEqual(grok.can, { modes: ["yolo", "write", "read-only"], steer: true, resume: true, webSearchOff: false, review: true, adversarialReview: true, stopGate: false, transfer: false });
  // Kimi takes a message as its next turn: the line says so, and the JSON's steer stays the in-turn one.
  const kimiIndex = report.backends.findIndex(block => block.backend === "kimi");
  assert.equal(report.backends[kimiIndex].can.steer, false);
  assert.match(sections[kimiIndex], /^can: yolo, read-only \(write refused\) · steer \(next turn\) · resume · /m);
  for (const [index, block] of report.backends.entries()) {
    if (block.backend !== "kimi") assert.doesNotMatch(sections[index], /next turn/, block.backend);
  }
});

test("a Grok home that reads signed out once is asked again, and setup says signed in", t => {
  const ctx = everyBackend(t, "home-probe", { signedOutOnce: true });
  const { status, page: report } = page(ctx);
  assert.equal(status, 0);
  const groks = report.backends.filter(block => block.backend === "grok");
  assert.equal(groks.length, 2);
  for (const block of groks) {
    assert.equal(block.signIn.state, "signed-in", JSON.stringify(block.signIn));
    assert.equal(block.ready, true);
  }
  // One home's first answer was "not authenticated": three model listings for two homes.
  assert.equal(ctx.grok().invocations.filter(call => call.args[0] === "models").length, 3);
});

test("--backend checks one home, keeps exit codes, and refuses mixed flags", t => {
  const ctx = everyBackend(t);
  const one = page(ctx, ["--backend", "codex"]);
  assert.equal(one.status, 0);
  assert.deepEqual(one.page.backends.map(block => [block.backend, block.homeDefault, block.home]), [["codex", true, path.join(ctx.user, ".codex")]]);
  // An inherited CODEX_HOME is the Codex home.
  const inherited = page(ctx, ["--backend", "codex"], { CODEX_HOME: path.join(ctx.user, ".codex-custom") });
  assert.deepEqual(inherited.page.backends.map(block => [block.backend, block.homeDefault, block.selector, block.home]), [["codex", true, null, path.join(ctx.user, ".codex-custom")]]);
  const grokJobs = page(ctx, ["--backend", "grok", "--grok-home", "jobs"]);
  assert.equal(grokJobs.status, 0);
  assert.equal(grokJobs.page.backends[0].home, path.join(ctx.user, ".grok-jobs"));
  fs.rmSync(path.join(ctx.user, ".zcode", "v2", "credentials.json"));
  const zcode = page(ctx, ["--backend", "zcode"]);
  assert.equal(zcode.status, 1);
  assert.equal(zcode.page.ready, false);
  assert.equal(zcode.page.backends[0].signIn.state, "signed-out");
  // The overview still exits 0 with ZCode signed out.
  assert.equal(page(ctx).status, 0);
  // A Kimi home without its own sign-in is signed out, whatever the providers say.
  const kimiJobs = page(ctx, ["--backend", "kimi", "--kimi-home", "jobs"]);
  assert.equal(kimiJobs.status, 1);
  assert.equal(kimiJobs.page.backends[0].home, path.join(ctx.user, ".kimi-code-jobs"));
  assert.equal(kimiJobs.page.backends[0].signIn.state, "signed-out");
  assert.ok(kimiJobs.page.nextSteps.some(step => step.includes(`KIMI_CODE_HOME=${path.join(ctx.user, ".kimi-code-jobs")} kimi login --region global`) && step.includes("--region mainland-cn for a kimi.com account")), kimiJobs.page.nextSteps.join("\n"));

  const configPath = path.join(ctx.jobs, "config.json");
  for (const [args, message] of [
    [["--backend", "other"], '--backend must be codex, grok, zcode or kimi, not "other".'],
    [["--kimi-home", "jobs"], "--kimi-home requires --backend kimi."],
    [["--grok-home", "jobs"], "--grok-home requires --backend grok."],
    [["--backend", "codex", "--fast-tier", "off"], "Use setup --backend on its own, without --fast-tier."],
    [["--backend", "codex", "--job-mcp-off", "node_repl"], "Use setup --backend on its own, without --job-mcp-off."],
    [["--backend", "zcode", "--enable-review-gate"], "Use setup --backend on its own, without --enable-review-gate."]
  ]) {
    const refused = companion(ctx, ["setup", ...args]);
    assert.equal(refused.status, 1, args.join(" "));
    assert.equal(refused.stderr.trim(), message);
    assert.equal(fs.existsSync(configPath), false, args.join(" "));
  }

  // The overview runs a switch first, so `--fast-tier allowed` works in one call.
  const switched = page(ctx, ["--fast-tier", "allowed"]);
  assert.equal(switched.status, 0);
  assert.equal(switched.page.settings.fastTier, "allowed");
  assert.deepEqual(switched.page.actionsTaken, [`Set the fast tier to allowed in ${configPath}.`]);
});

test("setup names the real Grok binary when the resolved one is a script, and says a wrapper may hook job start", t => {
  const ctx = setup(t, { behavior: "job" });
  installFakeGrok(ctx.bin);
  const nodeDir = path.dirname(process.execPath);
  const realDir = path.join(ctx.root, "real-grok");
  fs.mkdirSync(realDir);
  fs.symlinkSync(process.execPath, path.join(realDir, "grok"));
  const basePath = [ctx.bin, nodeDir, "/usr/bin", "/bin"].join(path.delimiter);

  const alone = page(ctx, ["--backend", "grok"], { PATH: basePath }).page.backends[0];
  assert.equal(alone.binaryIsScript, true);
  assert.equal(alone.realBinary, null);
  assert.match(alone.warnings[0], /grok is a script, not the Grok binary: a wrapper may run its own hooks when a job starts `grok agent`/);
  assert.match(alone.warnings[0], /No other grok binary was found on PATH; set GROK_BINARY to pin the real one\./);

  const withReal = page(ctx, ["--backend", "grok"], { PATH: `${basePath}${path.delimiter}${realDir}` }).page.backends[0];
  assert.equal(withReal.realBinary, fs.realpathSync(process.execPath));
  assert.ok(withReal.warnings[0].includes(`set GROK_BINARY=${fs.realpathSync(process.execPath)} to pin it.`), withReal.warnings[0]);
  const text = companion(ctx, ["setup", "--backend", "grok"], { PATH: `${basePath}${path.delimiter}${realDir}` }).stdout;
  assert.match(text, /^warning: .*grok is a script, not the Grok binary/m);

  // A binary that is not a script gets no warning.
  const plain = page(ctx, ["--backend", "grok"], { PATH: basePath, GROK_BINARY: path.join(realDir, "grok") }).page.backends[0];
  assert.equal(plain.binaryIsScript, false);
  assert.deepEqual(plain.warnings, []);
});

function tree(root) {
  const entries = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      entries.push([path.relative(root, file), stat.mode, stat.size, stat.mtimeMs]);
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return entries;
}

test("a job directory outside the jobs home is refused without reads or writes", async t => {
  const ctx = setup(t, { behavior: "job" });
  const old = path.join(ctx.user, "outside-jobs", "repo-0123abcd");
  const oldJob = path.join(old, "job-old");
  fs.mkdirSync(path.join(oldJob, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(oldJob, "job.json"), JSON.stringify({ id: "job-old", kind: "task", state: "completed", threadId: "thread-old", request: { cwd: ctx.work } }));
  fs.writeFileSync(path.join(oldJob, "report.md"), "External report.\n");
  // A named pipe blocks whoever opens it: a command that read this job would hang here.
  const piped = path.join(old, "job-piped");
  fs.mkdirSync(piped);
  assert.equal(run("mkfifo", [path.join(piped, "job.json")]).status, 0);
  // A link inside the relay home that leads out of it is refused by its real path.
  fs.mkdirSync(path.join(ctx.jobs, "repo-0123abcd"), { recursive: true });
  const link = path.join(ctx.jobs, "repo-0123abcd", "job-old");
  fs.symlinkSync(oldJob, link);
  const before = tree(path.join(ctx.user, "outside-jobs"));
  const home = ctx.jobs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const dir of [oldJob, piped, link]) {
    for (const args of [["result", dir], ["continue", dir, "--message", "more"], ["steer", dir, "--message", "more"], ["cancel", dir], ["resume", dir], ["wait", dir, "--timeout-seconds", "0"], ["status", dir]]) {
      const refused = spawnSync(process.execPath, [path.join(ROOT, "plugins", "relay", "scripts", "companion.mjs"), ...args], { cwd: ctx.work, env: ctx.env, encoding: "utf8", timeout: 10000 });
      assert.equal(refused.error, undefined, `${args.join(" ")} hung`);
      assert.equal(refused.status, 1, `${args.join(" ")}: ${refused.stdout}${refused.stderr}`);
      assert.equal(refused.stdout, "", args.join(" "));
      assert.match(refused.stderr, new RegExp(`^${args[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not a job of this relay: its jobs home is ${home}\\.\\n$`), args.join(" "));
    }
  }
  assert.deepEqual(tree(path.join(ctx.user, "outside-jobs")), before, "nothing in the old home changed");
  assert.equal(fs.readFileSync(path.join(oldJob, "report.md"), "utf8"), "External report.\n");

  // A relay job's own absolute directory is still a job.
  const { startJob, jobDir: jobDirOf, finishJob } = await import("./support/job-helpers.mjs");
  const { id } = startJob(ctx);
  await finishJob(ctx, id);
  const own = companion(ctx, ["result", jobDirOf(ctx, id)]);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, new RegExp(`^job: ${id}$`, "m"));
});
