// The user-level fast-tier switch is stored in `<jobs home>/config.json`.
// With `fastTier: "off"`, a start ignores `fast: true` with a note, never an error; the
// Codex config then sets the tier. Off is the default: only a
// stored `fastTier: "allowed"` lets `fast: true` select the priority tier.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./support/helpers.mjs";
import { companion, decision, jobDirOf, pre, relayContext, relayStart, updated } from "./support/relay-fixture.mjs";

const NOTE_PATTERN = (home) => new RegExp(`^note: fast tier is off in ${path.join(home, "config.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; fast: true is ignored and the Codex config sets the tier\\.$`, "m");

function startWithPrompt(ctx, prompt) {
  const file = path.join(ctx.work, `prompt-${Date.now()}.md`);
  fs.writeFileSync(file, prompt);
  const started = companion(ctx, ["start", "--prompt-file", file]);
  const jobId = /^job: (\S+)$/m.exec(started.stdout)?.[1] ?? null;
  return { started, jobId };
}

function readJob(ctx, jobId) {
  return JSON.parse(fs.readFileSync(path.join(jobDirOf(ctx, jobId), "job.json"), "utf8"));
}

function finish(ctx, jobId) {
  assert.equal(companion(ctx, ["wait", jobId, "--timeout-seconds", "20"]).status, 0);
}

// The service tier the fake backend received for the job that ran last: thread/start and
// every turn/start of it (each job here ends before the next starts).
function tiersReceived(ctx) {
  const state = ctx.fakeState();
  const thread = (state.threadStarts ?? []).at(-1) ?? {};
  const turn = (state.turnStarts ?? []).at(-1) ?? {};
  return { session: thread.serviceTier ?? null, turn: turn.serviceTier ?? null };
}

const FAST_PROMPT = "model: gpt-test\neffort: low\nfast: true\n---\n[quick] Quick job.";

test("with fastTier allowed, a fast: true start is fast; with off, it ignores fast and says so, and sends no service-tier override", () => {
  const ctx = relayContext("job", { turnMs: 100 });
  fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "allowed" }));
  const allowed = startWithPrompt(ctx, FAST_PROMPT);
  assert.ok(allowed.jobId, allowed.started.stdout + allowed.started.stderr);
  assert.match(allowed.started.stdout, /^tier: fast$/m);
  assert.doesNotMatch(allowed.started.stdout, /^note: fast tier/m);
  assert.equal(readJob(ctx, allowed.jobId).request.fast, true);
  finish(ctx, allowed.jobId);
  assert.deepEqual(tiersReceived(ctx), { session: "priority", turn: "priority" });

  fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "off" }));
  const off = startWithPrompt(ctx, FAST_PROMPT);
  assert.ok(off.jobId, off.started.stdout + off.started.stderr);
  assert.doesNotMatch(off.started.stdout, /^tier: fast$/m);
  assert.match(off.started.stdout, NOTE_PATTERN(ctx.home));
  assert.equal(readJob(ctx, off.jobId).request.fast, false);
  finish(ctx, off.jobId);
  assert.deepEqual(tiersReceived(ctx), { session: null, turn: null }, "no priority tier under off");
  assert.match(companion(ctx, ["result", off.jobId]).stdout, NOTE_PATTERN(ctx.home));

  // The --fast flag goes through the same function.
  const brief = path.join(ctx.work, "brief.md");
  fs.writeFileSync(brief, "[quick] Flag job.");
  const flagged = companion(ctx, ["start", "--model", "gpt-test", "--effort", "low", "--fast", "--brief-file", brief]);
  assert.doesNotMatch(flagged.stdout, /^tier: fast$/m);
  assert.match(flagged.stdout, NOTE_PATTERN(ctx.home));
  finish(ctx, /^job: (\S+)$/m.exec(flagged.stdout)[1]);
});

test("status shows the fast tier off by default; setup --fast-tier writes the user config; a bogus value is a usage error", () => {
  const ctx = relayContext("job", { turnMs: 100 });
  assert.match(companion(ctx, ["status"]).stdout, /^review-gate: (enabled|disabled)\nfast-tier: off$/m);
  // Setup checks every backend home: give it a scratch HOME and no real Grok or ZCode.
  const scratch = { ...ctx, env: { ...ctx.env, HOME: makeTempDir("relay-setup-home-"), GROK_BINARY: path.join(ctx.binDir, "grok"), ZCODE_BINARY: path.join(ctx.binDir, "zcode"), KIMI_BINARY: path.join(ctx.binDir, "kimi") } };
  const shown = companion(scratch, ["setup", "--json"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).settings.fastTier, "off");
  assert.equal(fs.existsSync(path.join(ctx.home, "config.json")), false, "setup without a switch writes no setting");
  const set = companion(scratch, ["setup", "--fast-tier", "allowed"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^settings: fast tier allowed · /m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.home, "config.json"), "utf8")), { fastTier: "allowed" });
  assert.match(companion(ctx, ["status"]).stdout, /^review-gate: (enabled|disabled)\nfast-tier: allowed$/m);
  const back = companion(scratch, ["setup", "--fast-tier", "off", "--json"]);
  assert.equal(JSON.parse(back.stdout).settings.fastTier, "off");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.home, "config.json"), "utf8")), { fastTier: "off" });
  assert.match(companion(ctx, ["status"]).stdout, /^review-gate: (enabled|disabled)\nfast-tier: off$/m);
  const bogus = companion(scratch, ["setup", "--fast-tier", "bogus"]);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /--fast-tier must be allowed or off, not "bogus"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.home, "config.json"), "utf8")).fastTier, "off");
  // Any other stored value reads as off, with no error.
  fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "sometimes" }));
  const status = companion(ctx, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^fast-tier: off$/m);
});

test("a relay start under fastTier off with a fast: true header runs, and its hand-back carries the note", async () => {
  const ctx = relayContext("job", { turnMs: 100 });
  fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "off" }));
  ctx.append(ctx.prompt(FAST_PROMPT), ctx.systemReminder());
  const { started, jobId } = await relayStart(ctx);
  assert.ok(jobId, started.stdout + started.stderr);
  finish(ctx, jobId);
  assert.deepEqual(tiersReceived(ctx), { session: null, turn: null }, "no priority tier under off");
  const handback = await pre(ctx, "SubagentHandback", { message: "x" });
  assert.equal(decision(handback), "allow");
  assert.match(updated(handback).message, NOTE_PATTERN(ctx.home));
  assert.doesNotMatch(updated(handback).message, /^tier: fast$/m);
});

test("with no fastTier setting, or one that is neither allowed nor off, a fast: true start ignores fast with its note", () => {
  const ctx = relayContext("job", { turnMs: 100 });
  assert.equal(fs.existsSync(path.join(ctx.home, "config.json")), false);
  const absent = startWithPrompt(ctx, FAST_PROMPT);
  assert.ok(absent.jobId, absent.started.stdout + absent.started.stderr);
  assert.doesNotMatch(absent.started.stdout, /^tier: fast$/m);
  assert.match(absent.started.stdout, NOTE_PATTERN(ctx.home));
  assert.equal(readJob(ctx, absent.jobId).request.fast, false);
  finish(ctx, absent.jobId);
  assert.deepEqual(tiersReceived(ctx), { session: null, turn: null }, "no priority tier by default");
  assert.match(companion(ctx, ["result", absent.jobId]).stdout, NOTE_PATTERN(ctx.home));
  // Reading the setting writes nothing.
  assert.equal(fs.existsSync(path.join(ctx.home, "config.json")), false);

  fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ fastTier: "sometimes" }));
  const bogus = startWithPrompt(ctx, FAST_PROMPT);
  assert.ok(bogus.jobId, bogus.started.stdout + bogus.started.stderr);
  assert.doesNotMatch(bogus.started.stdout, /^tier: fast$/m);
  assert.match(bogus.started.stdout, NOTE_PATTERN(ctx.home));
  finish(ctx, bogus.jobId);
  assert.deepEqual(tiersReceived(ctx), { session: null, turn: null }, "no priority tier for an unknown value");
});
