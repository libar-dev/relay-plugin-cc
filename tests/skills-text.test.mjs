import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULTS, admissionHome, modelClass } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { renderSetupPage } from "../plugins/relay/scripts/lib/setup/page.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins/relay");
const read = f => fs.readFileSync(path.join(plugin, f), "utf8");
const filesBelow = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? filesBelow(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test("installed agent text resolves local Markdown files within the plugin", () => {
  for (const file of ["skills", "agents", "commands"].flatMap(d => filesBelow(path.join(plugin, d))).filter(f => f.endsWith(".md"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, href] of source.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("#")) continue;
      const target = path.resolve(path.dirname(file), href.split("#")[0]);
      assert.ok(target.startsWith(plugin + path.sep), `${file}: ${href} escapes installed plugin`);
      assert.ok(fs.existsSync(target), `${file}: missing ${href}`);
    }
  }
});

test("orchestration references attribute every data row and date the snapshot", () => {
  const models = read("skills/jobs/models.md");
  assert.match(models, /Data as of \d{4}-\d{2}-\d{2}/);
  for (const line of models.split("\n").filter(l => l.startsWith("| ") && !/^\| (?:Model|Harness|---)/.test(l))) {
    assert.match(line, /\[[^\]]+\]\[[^\]]+\]/, `unattributed data row: ${line}`);
  }
  for (const [, key] of models.matchAll(/\[[^\]]+\]\[([^\]]+)\]/g)) {
    assert.ok(models.includes(`[${key}]: https://`), `missing source ${key}`);
  }
  for (const id of ['glm-5.3', 'glm-5.3-flash', 'kimi-code/k3', 'kimi-code/kimi-for-coding']) {
    assert.ok(models.includes('`' + id + '`'));
    assert.ok(read('skills/jobs/SKILL.md').includes('`' + id + '`'));
  }
  assert.match(models, /minor release/);
  assert.match(models, /mark.*stale/);
  // Attribution structure does not prove the numbers or an external scheduler are current.
});

test("documented guard defaults agree with local runtime exports", () => {
  assert.equal(DEFAULTS.guaranteedVeryHeavy, 2);
  assert.equal(DEFAULTS.guaranteedOther, 3);
  assert.equal("maxVeryHeavy" in DEFAULTS, false);
  assert.equal(DEFAULTS.spacingMs, 5000);
  const guide = fs.readFileSync(path.join(root, "docs/guide.md"), "utf8").replace(/\s+/g, " ");
  assert.match(guide, /Very heavy means GPT-6 Astra and Kimi K3 at every effort/);
  assert.match(guide, /Max\/ultra effort on other models does not enter that pool/);
  for (const f of ["SKILL.md", "orchestration.md", "models.md"]) {
    const source = read(`skills/jobs/${f}`);
    assert.match(source, /first two identified very-heavy and first three other active jobs/);
    assert.match(source, /no very-heavy maximum/);
  }
  for (const file of [path.join(root, 'README.md'), path.join(plugin, 'CHANGELOG.md')]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /Astra, (?:the Kimi K3 family|Kimi K3), or (?:effective|any) `max`/);
  }
  for (const effort of ["low", "default", "high", "max", "ultra"]) {
    assert.equal(modelClass({ backend: "codex", model: "gpt-6-astra", effort }), "very-heavy");
    for (const model of ["kimi-code/k3", "kimi-code/k3-highspeed", "k3-256k", "k3.1-pro", "kimi-code/k3.1-pro"]) {
      assert.equal(modelClass({ backend: "kimi", model, effort }), "very-heavy");
    }
  }
});

const obsoleteGuardText = /\bquota\b|--max-very-heavy|(?:starts?(?:\/| and | or )turns?|starts?[^.\n]{0,30}and turns?)[^.\n]{0,50}(?:pac|spac|5)|(?:pac|spac)[^.\n]{0,50}(?:starts? and turns?|turns? (?:every|5))|turns? (?:are )?(?:paced|spaced)|(?:pace|space)(?:s|d)? (?:backend )?turns?/i;
test("current guard instructions reject obsolete quota and turn-pacing claims", () => {
  for (const file of ["skills/jobs/SKILL.md", "skills/jobs/orchestration.md", "skills/jobs/models.md", "skills/jobs/internals.md", "commands/setup.md"]) {
    assert.doesNotMatch(read(file), obsoleteGuardText, file);
  }
  for (const file of ["README.md", "docs/guide.md"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), obsoleteGuardText, file);
  }
  const changelog = read("CHANGELOG.md");
  assert.doesNotMatch(changelog.slice(changelog.indexOf("- Before a job starts"), changelog.indexOf("- When too many workers")), obsoleteGuardText);
  assert.doesNotMatch(changelog.slice(changelog.indexOf("Docs:"), changelog.indexOf("## 2.2.0")), obsoleteGuardText);
  for (const source of ["Turns are paced 5 seconds apart", "paces backend turns", "One shared quota allows 2 very heavy jobs", "Starts and turns are paced 5 s apart", "paces backend starts and turns 5 seconds apart", "one start or turn every 5 s", "--max-very-heavy 1"]) {
    assert.match(source, obsoleteGuardText, source);
  }
});

test("effort alone never puts non-Astra/non-K3 models in the very-heavy class", () => {
  for (const [backend, model] of [["codex", "gpt-6.1-sol"], ["codex", "gpt-6-luna"],
    ["zcode", "glm-5.3"], ["kimi", "kimi-code/kimi-for-coding"], ["grok", "grok-4.7-build"]]) {
    for (const effort of ["max", "ultra"]) assert.notEqual(modelClass({ backend, model, effort }), "very-heavy");
  }
  assert.notEqual(modelClass({ backend: "codex", model: "default", effort: "default" }), "very-heavy");
});

test("setup's captured-snapshot formatter preserves configured versus effective guard state", () => {
  const page = { jobsHome: "/tmp/example-jobs", settings: { fastTier: "off", mcpOff: [], reviewGate: false,
    loadGuard: { admission: "on", busySeats: 4, guaranteedVeryHeavy: 2, guaranteedOther: 3, maxWaitingWorkers: 8, configPath: "/tmp/example-admission/config.json" } },
    loadGuard: { enabled: false, reason: "unsupported platform" }, backends: [], actionsTaken: [], nextSteps: [] };
  const off = renderSetupPage(page);
  assert.match(off, /load guard: on/);
  assert.match(off, /domain settings: \/tmp\/example-admission\/config.json/);
  assert.match(off, /load-guard: off \(unsupported platform\)/);
  assert.match(renderSetupPage({ ...page, loadGuard: { enabled: true, error: "synthetic read error" } }), /state unreadable: synthetic read error/);
  const setup = read("commands/setup.md");
  assert.match(setup, /renderSetupPage\(JSON.parse/);
  assert.match(setup, /Never rerun setup just for formatting/);
  const setupCalls = setup.split("\n").filter(line => line.startsWith('node ') && line.includes('companion.mjs'));
  assert.equal(setupCalls.length, 2);
  for (const call of setupCalls) {
    assert.doesNotMatch(call.replaceAll("<args-file>", "args.txt"), /[<>|&]/, "snapshot writes must not use shell redirection");
    assert.match(call, /fs\.openSync\(process\.argv\[3\], "w"\)/);
    assert.ok(call.endsWith('"${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" "<args-file>" "<args-file>.snapshot.json"'));
  }
  assert.match(setup, /^allowed-tools:.*\bRead\b.*Bash\(node:\*\)/m);
  assert.match(setup, /Use `Read` on that file; never retype the JSON/);
  assert.doesNotMatch(setup, /save the captured JSON with Write/);
});

test("the guide keeps the default queue folder when only the jobs home changes", () => {
  const defaultHome = admissionHome({});
  assert.equal(admissionHome({ RELAY_JOBS_HOME: "/tmp/example-jobs" }), defaultHome);
  assert.equal(defaultHome, path.join(os.homedir(), ".relay-jobs", "admission"));
  assert.equal(admissionHome({ RELAY_ADMISSION_HOME: "/tmp/example-admission" }), "/tmp/example-admission");
  const guide = fs.readFileSync(path.join(root, "docs/guide.md"), "utf8").replace(/\s+/g, " ");
  assert.match(guide, /If you set only `RELAY_JOBS_HOME`, keep `~\/\.relay-jobs\/admission` in the list too/);
  assert.match(guide, /`RELAY_ADMISSION_HOME` overrides that queue folder/);
});

test("the guide reconciles direct continuation, queued UI and conditional stop notices", () => {
  const guide = fs.readFileSync(path.join(root, "docs/guide.md"), "utf8").replace(/\s+/g, " ");
  const design = fs.readFileSync(path.join(root, 'docs/design.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(design.includes("the board's direct route) once its relay has ended"));
  assert.doesNotMatch(guide, /No relay hands back a turn that a continue by job id starts/);
  for (const fact of ["if it still waits", "Queue next turn", "queued job", "queue reason", "no notice", "does not ask Claude to cancel"]) {
    assert.ok(guide.includes(fact), fact);
  }
});

// This PR's content scope is explicit: no Git state, remote refs, fetch depth or calendar age.
// AGENTS.md states the rule itself and belongs outside the content corpus.
const publicTextFiles = new Set([
  ".claude-plugin/marketplace.json", "package.json", "package-lock.json", "README.md",
  "docs/design.md", "docs/desktop.md", "docs/guide.md",
  "plugins/relay/.claude-plugin/plugin.json", "plugins/relay/CHANGELOG.md",
  "plugins/relay/agents/job.md", "plugins/relay/commands/adversarial-review.md",
  "plugins/relay/commands/review.md", "plugins/relay/commands/setup.md",
  "plugins/relay/skills/codex-prompting/SKILL.md",
  "plugins/relay/skills/codex-prompting/references/codex-prompt-recipes.md",
  "plugins/relay/skills/codex-prompting/references/prompt-blocks.md",
  "plugins/relay/skills/jobs/SKILL.md", "plugins/relay/skills/jobs/internals.md",
  "plugins/relay/skills/jobs/models.md", "plugins/relay/skills/jobs/orchestration.md",
  "plugins/relay/skills/result-handling/SKILL.md",
  "tests/command-args.test.mjs", "tests/commands.test.mjs", "tests/skills-text.test.mjs",
]);
// Character classes keep the rule's regex source from matching its own literal identifiers.
const privateText = /(?:\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/|\b(?:[T]hinkPad|[f]leet|D\d{2,}|M\d)\b|\b[o]wners?(?:['’]s?)?\b(?!"\s*:)|\b[u]ntil\s+you\s+(?:decide|choose)\b|\b\d{8}T\d{6}Z-[\w-]+\.jsonl\b)/i;
const publicTextViolations = entries => entries
  .filter(([file]) => publicTextFiles.has(file))
  .filter(([, source]) => privateText.test(source))
  .map(([file]) => file);

test("public content scans the explicit changed-file corpus and permits generic default homes", () => {
  assert.ok(!privateText.test("~/.relay-jobs ~/.relay-jobs/admission ~/.claude/settings.json"));
  const entries = [...publicTextFiles].map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]);
  assert.deepEqual(publicTextViolations(entries), []);
});

test("public content rejects synthetic machine, personal and decision framing", () => {
  for (const digit of "0123456789") assert.ok(privateText.test("M" + digit));
  for (const text of ["the " + "own" + "er", "own" + "er's guide", "own" + "er’s guide",
    "until you " + "decide", "until you " + "choose"]) assert.ok(privateText.test(text), text);
  assert.ok(!privateText.test("file ownership and generic process identifiers"));
  assert.ok(!privateText.test(JSON.stringify({ ["own" + "er"]: { name: "Example Maintainer" } })));
  assert.doesNotMatch(fs.readFileSync(path.join(root, "docs/guide.md"), "utf8"), /\]\([^)]*(?:docs\/)?mods\//);
  assert.doesNotMatch(read("CHANGELOG.md"), /\]\([^)]*mods\/pre-release-3\.0\.md/);
});

test("AGENTS.md rule prose cannot enter the public content corpus", () => {
  assert.equal(publicTextFiles.has("AGENTS.md"), false);
  const entries = [
    ["AGENTS.md", fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")],
    ["README.md", "Generic defaults: ~/.relay-jobs ~/.claude/settings.json"],
    ["docs/guide.md", `D${42}`], // synthetic private decision marker in an included file
  ];
  assert.deepEqual(publicTextViolations(entries), ["docs/guide.md"]);
});

const orgGuidanceText = /\b(?:libar-infra|Greptile|CodeRabbit|model roster|do not use Fable|never use Fable)\b/i;

test("built-in skills stay free of organisation-specific model and review policies", () => {
  const skillFiles = filesBelow(path.join(plugin, "skills")).filter(file => file.endsWith(".md"));
  assert.ok(skillFiles.length > 0);
  for (const file of skillFiles) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), orgGuidanceText, path.relative(plugin, file));
  }
  for (const text of ["model roster: Astra high", "follow libar-infra", "ask Greptile", "do not use Fable"]) {
    assert.ok(orgGuidanceText.test(text), text);
  }
});

test("load guard documentation describes holds and the explicit off switch", () => {
  for (const file of ["README.md", "docs/guide.md", "plugins/relay/skills/jobs/internals.md", "plugins/relay/commands/setup.md"]) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /guard (?:itself )?fails[^]*?new starts\s+wait/, file);
    assert.match(source, /RELAY_ADMISSION=off/, file);
    assert.match(source, /\/relay:setup --admission off/, file);
    assert.match(source, /[Dd]amaged guard\s+records?\s+counts? as busy until (?:it is )?set aside/, file);
    assert.doesNotMatch(source, /Guard\/storage errors visibly bypass|guard failures admit with a note/i, file);
  }
});
