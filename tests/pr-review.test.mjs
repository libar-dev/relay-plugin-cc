import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildReviewPrompt, commentBody, reviewerCommand, MAX_DIFF_BYTES } from "../scripts/pr-review.mjs";
import { makeTempDir, writeExecutable } from "./support/helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/pr-review.mjs", import.meta.url));

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", shell: false });
}

function fixture(t, diffBytes = 100) {
  const root = makeTempDir("pr-review-test-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "gh-calls.jsonl");
  writeExecutable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const joined = args.join(" ");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (joined.includes("application/vnd.github.v3.diff")) {
  const size = Number(process.env.FAKE_DIFF_BYTES || ${diffBytes});
  process.stdout.write("diff --git a/a.js b/a.js\\n" + "x".repeat(size));
} else if (joined.includes("/issues/60/comments")) {
  process.stdout.write(JSON.stringify([{ id: 42, body: "<!-- relay-pr-review:opus --> old" }]));
} else if (joined.includes("/pulls/60")) {
  process.stdout.write(JSON.stringify({ number: 60, title: "Synthetic PR", user: { login: "synthetic-user" }, html_url: "https://synthetic.invalid/pr/60", head: { sha: "abc123" } }));
} else if (joined.includes("PATCH")) {
  process.stdout.write("https://synthetic.invalid/comments/42\\n");
} else if (args[0] === "pr" && args[1] === "comment") {
  process.stdout.write("https://synthetic.invalid/comments/43\\n");
} else {
  process.exit(2);
}
`);
  writeExecutable(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(path.join(root, "claude-args.json"))}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ is_error: false, result: "OPUS_SYNTHETIC_FINDING" }));
`);
  writeExecutable(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(root, "codex-args.json"))}, JSON.stringify(args));
const index = args.indexOf("--output-last-message");
fs.writeFileSync(args[index + 1], "ASTRA_SYNTHETIC_FINDING\\n");
`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REVIEW_WORK_DIR: path.join(root, "work"),
    REPOSITORY: "synthetic/repo",
    PR_NUMBER: "60",
    PR_AUTHOR: "synthetic-user",
    ANTHROPIC_API_KEY: "test-not-a-secret",
    OPENAI_API_KEY: "test-not-a-secret",
    GH_TOKEN: "test-not-a-secret",
    FAKE_DIFF_BYTES: String(diffBytes)
  };
  return { root, env, log };
}

test("review prompts and CLI arguments pin the requested models and isolation", () => {
  const prompt = buildReviewPrompt("diff --git a/a b/a\n+const x = 1;", "https://synthetic.invalid/pr/1");
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /Do not call any tool/);
  assert.match(prompt, /<untrusted_pull_request_diff>/);
  const opus = reviewerCommand("opus", { prompt, directory: "/synthetic", output: "/synthetic/out" });
  assert.equal(opus.command, "claude");
  assert.ok(opus.args.includes("claude-opus-5-5"));
  assert.ok(opus.args.includes("high"));
  assert.ok(opus.args.includes("--safe-mode"));
  assert.ok(opus.args.includes("--no-session-persistence"));
  assert.equal(opus.args[opus.args.indexOf("--tools") + 1], "");
  const astra = reviewerCommand("astra", { prompt, directory: "/synthetic", output: "/synthetic/out" });
  assert.equal(astra.command, "codex");
  assert.ok(astra.args.includes("gpt-6-astra"));
  assert.ok(astra.args.includes('model_reasoning_effort="high"'));
  assert.ok(astra.args.includes("shell_environment_policy.inherit=none"));
  assert.ok(astra.args.includes("read-only"));
  assert.ok(astra.args.includes("--ignore-user-config"));
  assert.ok(astra.args.includes("--ignore-rules"));
  assert.ok(astra.args.includes("--ephemeral"));
  const body = commentBody("opus", "Finding", "synthetic-user", "abc123");
  assert.match(body, /Claude Opus 5\.5 \(high\) responding on behalf of @synthetic-user/);
  assert.match(body, /abc123/);
  assert.match(body, /<!-- relay-pr-review:opus -->/);
});

test("collect, both reviews and marked comment publication run end to end with fake CLIs", t => {
  const { root, env, log } = fixture(t);
  for (const args of [["collect"], ["review", "--reviewer", "opus"], ["review", "--reviewer", "astra"], ["post", "--reviewer", "opus"], ["post", "--reviewer", "astra"]]) {
    const result = run(args, env);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /test-not-a-secret/);
  }
  const work = env.REVIEW_WORK_DIR;
  assert.equal(fs.readFileSync(path.join(work, "opus.md"), "utf8").trim(), "OPUS_SYNTHETIC_FINDING");
  assert.equal(fs.readFileSync(path.join(work, "astra.md"), "utf8").trim(), "ASTRA_SYNTHETIC_FINDING");
  assert.match(fs.readFileSync(path.join(work, "opus-comment.md"), "utf8"), /abc123/);
  assert.match(fs.readFileSync(path.join(work, "astra-comment.md"), "utf8"), /GPT-6 Astra/);
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, /PATCH/);
  assert.match(calls, /pr","comment/);
  assert.ok(!calls.includes("test-not-a-secret"));
  assert.ok(fs.existsSync(path.join(root, "claude-args.json")));
  assert.ok(fs.existsSync(path.join(root, "codex-args.json")));
});

test("an oversized diff is rejected without being truncated or reviewed", t => {
  const { env } = fixture(t, MAX_DIFF_BYTES + 1);
  const result = run(["collect"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /above the 196608-byte review limit/);
  assert.equal(fs.existsSync(path.join(env.REVIEW_WORK_DIR, "prompt.txt")), false);
});

test("a missing provider key fails before starting a reviewer", t => {
  const { env } = fixture(t);
  delete env.ANTHROPIC_API_KEY;
  assert.equal(run(["collect"], env).status, 0);
  const result = run(["review", "--reviewer", "opus"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANTHROPIC_API_KEY is required/);
  assert.match(fs.readFileSync(path.join(env.REVIEW_WORK_DIR, "opus.md"), "utf8"), /Automated review failed/);
  const posted = run(["post", "--reviewer", "opus"], env);
  assert.equal(posted.status, 0, posted.stderr);
  assert.match(fs.readFileSync(path.join(env.REVIEW_WORK_DIR, "opus-comment.md"), "utf8"), /Automated review failed/);
});
