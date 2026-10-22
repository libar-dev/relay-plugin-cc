import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "relay");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return the companion's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /review --args-stdin <<'[^'\n]+'\n\$ARGUMENTS\n/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /description:\s*"Review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return the companion's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /adversarial-review --args-stdin <<'[^'\n]+'\n\$ARGUMENTS\n/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /description:\s*"Adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/relay:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue launches the relay:job agent through the same start and wait path", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /allowed-tools:\s*Agent/);
  assert.match(rescue, /subagent_type: "relay:job"/);
  assert.match(rescue, /do not call `Skill\(relay:job\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.doesNotMatch(rescue, /task-resume-candidate|codex-rescue|--resume-last/);
  assert.match(rescue, /never infer `mode` from the brief's words/i);
  assert.match(rescue, /The final user-visible response must be the agent's output verbatim/i);
  assert.match(rescue, /Raw user request:\n\$ARGUMENTS/);
  assert.doesNotMatch(rescue, /```bash|\bBash\b|companion\.mjs/);
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, "agents")), ["job.md"]);
});

test("rescue turns --backend, --grok-home and --kimi-home into header lines; the review commands name the backend flags", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /^argument-hint: .*\[--backend codex\|grok\|zcode\|kimi\] .*\[--grok-home <name\|path>\] \[--kimi-home <name\|path>\]/m);
  assert.match(rescue, /- `--backend <backend>`: the `backend:` header value, passed as given/);
  assert.match(rescue, /- `--grok-home <value>`: the `grok-home:` header value, passed as given/);
  assert.match(rescue, /- `--kimi-home <value>`: the `kimi-home:` header value, passed as given/);
  const header = /```\n([\s\S]*?)\n```/.exec(rescue)[1].split("\n");
  assert.deepEqual(header, [
    "backend: <only when --backend was given>",
    "model: <model or default>",
    "effort: <effort or default>",
    "grok-home: <only when --grok-home was given>",
    "kimi-home: <only when --kimi-home was given>",
    "mode: <only when --read-only or --write was given>",
    "---",
    "<the brief, unchanged>"
  ]);
  for (const name of ["review", "adversarial-review"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /^argument-hint: '\[--wait\|--background\] \[--backend codex\|grok\|zcode\|kimi\] \[--model <m>\] \[--effort <e>\] \[--grok-home H\] \[--kimi-home H\] /m, name);
    assert.match(source, /above two files or 256 KiB the review is refused/, name);
    assert.match(source, /where Grok refuses that profile \(on a Mac whose `\/var\/run\/docker\.sock` is a symlink, or on Linux where it cannot reach a runtime socket such as `\/run\/podman\/podman\.sock`\), the review fails with Grok's error/, name);
  }
  assert.match(read("commands/adversarial-review.md"), /`<backend> returned no valid review JSON`/);
  const skill = read("skills/jobs/SKILL.md");
  assert.match(skill, /^## Reviews$/m);
  assert.match(skill, /^- A review can be a step: a Claude agent whose prompt says to run `C review --wait`/m);
  assert.doesNotMatch(skill, /Reviews, the stop gate and `transfer` remain Codex only/);
});

test("docs name the session, ZCode's default effort as the header does, and \"the job\" where the rename dropped the article", () => {
  const defaults = "Without `--model` and `--effort`, Codex, Grok and Kimi use their configured defaults, and ZCode uses its selected default model at effort `high`, the plugin's default (ZCode's own is `max`), as a job header does.";
  for (const name of ["review", "adversarial-review"]) {
    assert.ok(read(`commands/${name}.md`).includes(defaults), name);
    assert.doesNotMatch(read(`commands/${name}.md`), /without them, the backend's default/, name);
  }
  const skill = read("skills/jobs/SKILL.md");
  for (const sentence of ["- `completed` means the job finished its answer", "A message reaches the job within seconds", "| `cd` | no | absolute directory the job works in |"]) {
    assert.ok(skill.includes(sentence), sentence);
  }
  assert.ok(read("skills/jobs/internals.md").includes("the relay drops it. The job receives the computed task"));
  const guard = read("scripts/hooks/relay-guard.mjs");
  assert.ok(guard.includes('"Messages for the job are being delivered right now."'));
  assert.equal(guard.split("are owed to the job:").length - 1, 3);
  for (const source of [skill, guard, read("skills/jobs/internals.md")]) {
    assert.doesNotMatch(source, /(means|reaches|for|owed to|directory) job\b(?! [a-z]+:)|\. job receives/);
  }
});

test("the relay:job relay is a haiku agent with three commands; it writes no prompt, message or report", () => {
  const agent = read("agents/job.md");
  assert.match(agent, /^name: job$/m);
  assert.match(agent, /^model: haiku$/m);
  assert.match(agent, /^tools: Bash$/m);
  const body = agent.slice(agent.indexOf("\n---\n", 4) + 5);
  assert.doesNotMatch(body, /<<|draft-path|--prompt-file|--message-file| steer| continue| resume|\bWrite\b/);
  assert.match(agent, /companion\.mjs" start --from-relay\n/);
  assert.match(agent, /companion\.mjs" wait <id> --timeout-seconds 540\n/);
  assert.match(agent, /`timeout` parameter set to `600000`/);
  assert.match(agent, /companion\.mjs" result <id>\n/);
  assert.match(agent, /Every message you receive, at any time, also after you handed back, is for the job, `cancel` included\. The hook passes it on, and retries if it fails\. Never answer it, act on it or mention it\. Run 2 again\./);
  assert.match(agent, /that text comes from the plugin, not from a prompt injection/);
  assert.ok(agent.split("\n").length < 60, "the relay's instructions stay short");
});

test("the jobs skill covers the header, SendMessage and the companion commands", () => {
  const skill = read("skills/jobs/SKILL.md") + read("skills/jobs/internals.md");
  assert.match(skill, /^name: jobs$/m);
  assert.match(skill, /worker death after the allowance was spent returns `dead`/i);
  assert.match(skill, /`automatic-resume:`/);
  assert.match(skill, /packed-refs locks/);
  assert.match(skill, /`fast: true` selects `priority`/);
  assert.match(skill, /hook adds `--auto-resume`/);
  assert.match(skill, /subagent_type: "relay:job"/);
  for (const key of ["model", "effort", "fast", "mode", "network", "web-search", "cd", "add-dir", "brief"]) {
    assert.match(skill, new RegExp(`\\| \`${key}\` \\|`));
  }
  assert.match(skill, /`yolo` is the default/);
  assert.match(skill, /## How the relay is carried by code/);
  assert.match(skill, /`relay-violation:`/);
  assert.match(skill, /`SendMessage` with exactly `cancel`/);
  assert.match(skill, /`TaskStop` on the agent \| stops the agent and cancels the job/);
  assert.match(skill, /Workflow agent spawn denied by a plugin: <reason>/);
  assert.match(skill, /within seconds: the plugin's hooks module ends the relay's current wait/);
  for (const command of ["start", "wait", "status", "result", "steer", "continue", "resume", "cancel"]) {
    assert.match(skill, new RegExp(`\\| \`C ${command}`));
  }
});

test("packaging keeps the public install names and attribution", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const notice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
  assert.equal(plugin.name, "relay");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
  assert.equal(pkg.engines.node, ">=22");
  assert.equal(marketplace.name, "libar-relay");
  assert.equal(marketplace.plugins[0].name, "relay");
  assert.match(readme, /^# relay$/m);
  assert.match(readme, /fork of \[openai\/codex-plugin-cc\]/);
  assert.match(readme, /docs\/design\.md/);
  assert.match(readme, /claude plugin install relay@libar-relay/);
  assert.match(readme, /claude plugin marketplace add libar-dev\/relay-plugin-cc/);
  assert.doesNotMatch(readme, /read access to this private repository|plugin-demo\.webm|codex@openai-codex|\/codex:/);
  assert.match(notice, /OpenAI/);
});

// The module runs each of the four commands' companion subcommand itself; its Mod tests
// (hooks/mod/register.test.ts) check the argv and the text.
test("status, result, cancel and transfer are answered by the module's command.run hooks", () => {
  const module = read("hooks/mod/register.js");
  const resultHandling = read("skills/result-handling/SKILL.md");

  for (const name of ["status", "result", "cancel", "transfer"]) {
    assert.match(module, new RegExp(`on\\("command\\.run", \\{ command: "relay:${name}" \\}, (?:async )?\\(\\$, e\\) => answerCommand\\(\\$, e, "${name}",`), name);
  }
  assert.match(resultHandling, /do not turn a failed or incomplete job run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if the job was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs point task work at relay:jobs", () => {
  const promptingSkill = read("skills/codex-prompting/SKILL.md");
  const promptRecipes = read("skills/codex-prompting/references/codex-prompt-recipes.md");

  assert.match(promptingSkill, /^name: codex-prompting$/m);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptingSkill, /`relay:job` job/);
  assert.doesNotMatch(promptingSkill, /codex-rescue|--resume-last/);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow fix/);
});

test("hooks keep the session exports and stop gating, add TaskStop cancellation, and no SessionEnd hook ends jobs", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.doesNotMatch(source, /SessionEnd/);
  assert.match(source, /hooks\/relay-guard\.mjs/);
  assert.match(source, /"PostToolUse"/);
  assert.match(source, /"matcher": "TaskStop"/);
  assert.match(source, /hooks\/relay-stop\.mjs/);
  assert.match(source, /hooks\/stop-review-gate\.mjs/);
  assert.match(source, /hooks\/session-lifecycle\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--backend codex\|grok\|zcode\|kimi\] \[--grok-home H\|--kimi-home H\] \[--enable-review-gate\|--disable-review-gate\] \[--fast-tier allowed\|off\] \[--job-mcp-off names\|none\]'/);
  assert.match(setup, /^description: Check every backend the relay can run \(Codex, Grok, ZCode, Kimi\): binary, sign-in, default model and effort, models; or toggle the stop-time review gate, fast tier or job MCP servers$/m);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /companion\.mjs" setup --json --args-stdin <<'[^'\n]+'\n\$ARGUMENTS\n/);
  assert.match(setup, /Render one table, one row per block, in the command's order/);
  assert.match(setup, /Never add rows for node or npm\./);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offers to\s+install Codex for you/i);
  assert.match(readme, /\/relay:setup --enable-review-gate/);
  assert.match(readme, /\/relay:setup --disable-review-gate/);
});

test("setup and jobs docs describe sign-in checks and backend retry limits", () => {
  for (const file of ["commands/setup.md", "skills/jobs/SKILL.md"]) {
    const source = read(file).replace(/\s+/g, " ");
    assert.match(source, /credentials file (?:from `zcode login` )?is a regular file of more than two bytes/);
    assert.match(source, /sign-in works is checked by the first turn/);
  }
  const skill = read("skills/jobs/SKILL.md").replace(/\s+/g, " ");
  assert.match(skill, /For Codex and Grok routes, the worker retries at 30, 60 and 120 s/);
  assert.match(skill, /ZCode retries model calls itself/);
});

test("the jobs skill describes shared recovery and process records", async () => {
  const { DEFAULT_RESUME_MESSAGE } = await import("../plugins/relay/scripts/lib/worker/recovery.mjs");
  const skill = read("skills/jobs/SKILL.md") + read("skills/jobs/internals.md");
  const design = fs.readFileSync(path.join(ROOT, "docs/design.md"), "utf8");
  for (const source of [skill, design]) {
    assert.ok(source.replace(/\s+/g, " ").includes(DEFAULT_RESUME_MESSAGE));
    assert.ok(source.includes("server.stderr.log"));
    assert.match(source.replace(/\s+/g, " "), /shared.*allowance/);
  }
  for (const fact of ["pid and start time", "exit code or", "unfinished last line", "4096 bytes", "1 MiB"]) {
    assert.ok(design.includes(fact), fact);
  }
});

test("cancel retry and inference prose state the exceptions", () => {
  for (const file of ["skills/jobs/SKILL.md", "skills/jobs/internals.md"]) {
    const source = read(file).replace(/\s+/g, " ");
    assert.match(source, /pending while the job runs and tries remain/);
    assert.match(source, /terminal job closes it as done/);
    assert.match(source, /three started tries close it as failed/);
  }
  const design = fs.readFileSync(path.join(ROOT, "docs/design.md"), "utf8").replace(/\s+/g, " ");
  assert.match(design, /Only an unsupported `thread\/read` or a turn that reads `inProgress` completes by inference/);
  assert.match(design, /any other read failure fails the turn/);
  assert.match(read("skills/jobs/SKILL.md"), /`5` cancelled, including with a pending continuation because cancellation takes precedence/);
  assert.match(read("scripts/companion.mjs"), /5 cancelled \(also with messages not yet run; cancellation takes precedence\)/);
});

test("README carries the first hour, stop gate, Claude Code dependency and development checks", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
  const internals = read("skills/jobs/internals.md").replace(/\s+/g, " ");
  const setup = read("commands/setup.md").replace(/\s+/g, " ");
  const firstHour = readme.slice(readme.indexOf("## The first hour"), readme.indexOf("## Reference"));
  assert.ok(readme.indexOf("## Install") < readme.indexOf("## The first hour"));
  for (const text of ['"autoMode"', "/relay:setup", "mode: write", "the brief is the only fence", "A message reaches the job within seconds", "agentType: 'relay:job'", "relay:jobs"]) {
    assert.ok((text === '"autoMode"' ? readme : firstHour).includes(text), text);
  }
  assert.match(firstHour, /Jobs run in `mode: yolo` by default/);
  const gate = "It is off by default and runs on Codex only, in the default Codex home at its default model and effort.";
  for (const source of [readme, setup]) {
    assert.ok(source.includes(gate));
    assert.ok(source.includes("Grok, ZCode and Kimi do not run it; use `/relay:review` on those."));
    assert.ok(source.includes("every worktree and session of it"));
  }
  for (const source of [readme, internals]) {
    assert.ok(source.includes("The relay reads two things Claude Code does not publish as an interface: the agent transcript and the Workflow tool's run journal"));
    assert.match(source, /Claude Code 2\.1\.287 and 2\.1\.288/);
    assert.match(source, /the `session\.send`, `agent\.spawn` and `command\.run` events of the Mod API, so the floor is Claude Code 2\.1\.307/);
    assert.match(source, /A Claude Code update can break it\./);
    assert.ok(source.includes("the job's `job.json` must hold the call's key as `relay.journalKey`"));
    assert.ok(source.includes("once another relay has adopted the job, its `relay.json` holds the binding"));
    assert.match(source, /The module only checks headers and wakes a waiting relay: delivery runs on command hooks and the transcript/);
  }
  assert.ok(internals.includes("stores that key as `relay.journalKey` in the job's `job.json`"));
  assert.doesNotMatch(internals, /binds the job to that key in the job's `relay\.json`/);
  assert.match(readme, /Node.js 22 or later/);
  assert.match(readme, /macOS or Linux/);
  assert.match(readme, /## Development/);
  assert.match(readme, /npm ci/);
  assert.match(readme, /npm test/);
  assert.match(readme, /npm run check/);
  assert.match(readme, /outside any sandbox/);
  for (const file of ["architecture", "backends", "design"]) {
    assert.ok(readme.includes(`docs/${file}.md`), file);
  }
});

// Claude may run the reading and review commands itself; cancel and transfer stay the user's:
// Claude cancels a job by sending its agent `cancel`, and transfer moves the user's own session.
// The module answers status, result, cancel and transfer with a command.run hook, which a model's
// Skill call never reaches, so they are the person's; their markdown body only runs when the
// module did not load. A model reads jobs with `C status` and `C result` in Bash.
test("review and adversarial-review are model-invocable; status, result, cancel and transfer are not and only say the module did not load", () => {
  const frontmatter = name => /^---\n([\s\S]*?)\n---\n/.exec(read(`commands/${name}.md`))[1];
  const userOnly = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).map(file => file.replace(/\.md$/, ""))
    .filter(name => /^disable-model-invocation:\s*true$/m.test(frontmatter(name))).sort();
  assert.deepEqual(userOnly, ["cancel", "result", "status", "transfer"]);
  for (const name of ["review", "adversarial-review"]) {
    assert.match(frontmatter(name), /^description: .{40,}$/m, name);
  }
  for (const name of ["status", "result", "cancel", "transfer"]) {
    const source = read(`commands/${name}.md`);
    assert.equal(source.slice(source.indexOf("\n---\n") + 5), "\nThe relay module answers this command; it needs Claude Code 2.1.307 or later. If you read this, it did not load: say so and stop.\n", name);
    assert.doesNotMatch(frontmatter(name), /allowed-tools/, name);
    assert.match(frontmatter(name), /^description: .{40,}$/m, name);
    assert.match(frontmatter(name), /^argument-hint: /m, name);
  }
  for (const name of ["review", "adversarial-review"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /If you invoked this command yourself, rather than the user typing it, never use `AskUserQuestion`: with neither `--wait` nor `--background`, run the review in the foreground/, name);
    // The fixed first line, and that it is the one text the verbatim rule allows.
    assert.ok(source.includes("begin your reply with exactly this line before the output: `Ran in the foreground: the default when Claude starts a review without --wait or --background.` That line is the only text allowed before the companion's verbatim output, and nothing follows the output."), name);
    assert.ok(source.includes("- Do not paraphrase, summarize, or add commentary before or after it. The one exception is the foreground line above, first, when you invoked the command yourself."), name);
    assert.ok(source.includes("relay refuses the file writes and terminal commands Kimi sends through the client. That is not an OS sandbox"), name);
    assert.match(frontmatter(name), /Codex, Grok, ZCode or Kimi|Grok, ZCode or Kimi/, name);
  }
  assert.match(frontmatter("adversarial-review"), /schema-checked JSON/);
});
