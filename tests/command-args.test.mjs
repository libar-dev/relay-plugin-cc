import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { installFakeGrok } from "./fakes/grok.mjs";

// A baseline copy can be selected to prove the regression tests reject old recipes.
const PLUGIN = process.env.RELAY_TEST_COMMANDS_PLUGIN
  ? pathToFileURL(`${path.resolve(process.env.RELAY_TEST_COMMANDS_PLUGIN)}${path.sep}`)
  : new URL("../plugins/relay/", import.meta.url);
const SHARED = new URL("scripts/cli/shared.mjs", PLUGIN).href;

// Extract every companion invocation, including the estimate before mode selection.
function recipes(name) {
  const source = fs.readFileSync(new URL(`commands/${name}.md`, PLUGIN), "utf8");
  return [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map(match => match[1]).filter(command => command.includes("companion.mjs"));
}

function auditInstructions(source) {
  // Audit inline recipes too: this caught the previously untested estimate.
  const shell = [...source.matchAll(/```bash\n([\s\S]*?)\n```|`([^`\n]+)`/g)]
    .flatMap(match => match[1] ? [match[1]] : /^(?:node|git|npm|bash|sh|zsh)\s/.test(match[2]) ? [match[2]] : []);
  for (const code of shell) {
    assert.doesNotMatch(code.replaceAll("${CLAUDE_PLUGIN_ROOT}", "PLUGIN_ROOT"), /\$|<(?!args-file>)[^>]+>/,
      "argument-derived command outside the file transport");
  }
}

test("all command instructions keep argument values out of shell source, including inline estimates", () => {
  for (const entry of fs.readdirSync(new URL("commands/", PLUGIN))) {
    auditInstructions(fs.readFileSync(new URL(`commands/${entry}`, PLUGIN), "utf8"));
  }
  assert.throws(() => auditInstructions('Use `git diff --shortstat <base>...HEAD`.'), /argument-derived/);
  assert.throws(() => auditInstructions('```bash\necho "$base"\n```'), /argument-derived/);
});

for (const name of ["review", "adversarial-review", "setup"]) {
  test(`${name}: every documented flow uses Write and a file, with literal hostile and boundary inputs`, t => {
    const source = fs.readFileSync(new URL(`commands/${name}.md`, PLUGIN), "utf8");
    const commands = recipes(name);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-command-args-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "scripts/companion.mjs"), `
      import fs from "node:fs";
      const argv = process.argv.slice(2);
      const raw = fs.readFileSync(argv.includes("--args-file") ? argv[argv.indexOf("--args-file") + 1] : 0, "utf8");
      fs.writeFileSync("received.json", JSON.stringify({ argv, raw }));
      process.stdout.write("companion output\\n  verbatim\\n");
      process.stderr.write("companion stderr\\n");
      process.exitCode = 7;
    `);
    const samples = [
      "focus\nRELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD\ntouch collision-ran\n",
      "", "-", "first\r\nsecond\r\n", " \n\t", "trailing\\\n\n",
      "--wait `printf RELAY_PROBE; touch backtick-ran` $(touch substitution-ran) $RELAY_REVIEW_LITERAL \"double\" 'single'\nsecond line",
      "$& $` $' $$", "x".repeat(256 * 1024)
    ];
    for (const recipe of commands) {
      for (const raw of samples) {
        const argsFile = path.join(dir, "raw args.txt");
        // Simulate Write: contents never enter the Bash command, including $ replacement patterns.
        fs.writeFileSync(argsFile, raw);
        const command = recipe.replaceAll("<args-file>", () => argsFile).replaceAll("$ARGUMENTS", () => raw);
        const result = spawnSync("bash", ["-c", command], {
          cwd: dir, env: { ...process.env, CLAUDE_PLUGIN_ROOT: dir, RELAY_REVIEW_LITERAL: "EXPANDED" },
          encoding: "utf8", timeout: 10_000
        });
        assert.equal(result.error, undefined);
        for (const marker of ["backtick-ran", "substitution-ran", "collision-ran"]) {
          assert.equal(fs.existsSync(path.join(dir, marker)), false, `${marker}: text ran in Bash`);
        }
        assert.equal(result.status, 7, result.stderr);
        assert.equal(result.stdout, "companion output\n  verbatim\n");
        assert.equal(result.stderr, "companion stderr\n");
        const received = JSON.parse(fs.readFileSync(path.join(dir, "received.json"), "utf8"));
        assert.deepEqual(received.argv, [name, ...(name === "setup" ? ["--json"] : []),
          ...(recipe.includes("--estimate") ? ["--estimate"] : []), "--args-file", argsFile]);
        assert.equal(received.raw, raw);
      }
    }
    assert.match(source, /^allowed-tools:.*\bWrite\b/m);
    assert.match(source, /Use `Write`/);
    assert.match(source, /Raw slash-command arguments:\n`\$ARGUMENTS`/);
    assert.equal(commands.length, name === "setup" ? 2 : 3, "include both launches and the estimate");
    const blocks = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1]);
    const allocation = blocks.find(command => command.includes("mkdtempSync"));
    const cleanup = blocks.find(command => command.includes("unlinkSync"));
    assert.ok(allocation && cleanup, "document the file lifecycle");
    const allocated = spawnSync("bash", ["-c", allocation], { cwd: dir, encoding: "utf8" });
    assert.equal(allocated.status, 0, allocated.stderr);
    const allocatedPath = allocated.stdout.trim();
    assert.match(allocatedPath, /^\/tmp\/relay-args-[a-zA-Z0-9]+\/args\.txt$/);
    const privateDir = path.dirname(allocatedPath);
    t.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
    fs.writeFileSync(allocatedPath, "literal arguments"); // Write, outside Bash.
    const cleaned = spawnSync("bash", ["-c", cleanup.replaceAll("<args-file>", () => allocatedPath)], { cwd: dir, encoding: "utf8" });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(privateDir), false);
  });
}

test("stdin argument parsing matches the single-string form, including quoting and final whitespace", () => {
  const config = {
    argsStdin: true,
    valueOptions: ["backend", "grok-home", "kimi-home", "model", "effort", "base", "scope", "cwd", "fast-tier", "job-mcp-off"],
    booleanOptions: ["json", "wait", "background", "enable-review-gate", "disable-review-gate"],
    aliasMap: { m: "model" }
  };
  const samples = [
    "", " \n\t", "--wait", "--background --backend grok --grok-home 'home with spaces' --base main --scope branch",
    "--backend kimi --kimi-home 'a home' --model kimi-code/test --effort high",
    "--json --enable-review-gate --fast-tier off --job-mcp-off 'one,two'", "--json=false",
    '--wait `printf RELAY_PROBE` $(printf nope) $VAR "double quoted" \'single quoted\'\nnext line',
    "-- --args-stdin --json", "focus\\ with\\ spaces", "focus\\", "'unfinished", '"unfinished\n\n',
    "--model", "--model --wait"
  ];
  const code = `
    import { parseCommandInput } from ${JSON.stringify(SHARED)};
    const config = ${JSON.stringify(config)};
    function capture(argv) {
      try { return parseCommandInput(argv, config); }
      catch (error) { return { error: error.message, name: error.name }; }
    }
    const json = process.argv[2] === "--json";
    const expected = capture([json ? "--json " + process.argv[1] : process.argv[1]]);
    const actual = capture([...(json ? ["--json"] : []), "--args-stdin"]);
    console.log(JSON.stringify({ expected, actual }));
  `;
  for (const raw of samples) {
    for (const extra of [[], ["--json"]]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", raw, ...extra], {
        input: `${raw}\n`, encoding: "utf8", timeout: 10_000
      });
      assert.equal(result.status, 0, result.stderr);
      const { expected, actual } = JSON.parse(result.stdout);
      assert.deepEqual(actual, expected, JSON.stringify({ raw, extra }));
    }
  }
});

for (const name of ["review", "adversarial-review", "setup"]) {
  test(`${name}: file and stdin errors keep single-string JSON output and exit status`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-command-errors-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const raw of ["--json --backend", "--json --backend not-a-backend"]) {
      const invoke = (args, input) => spawnSync(process.execPath, [new URL("scripts/companion.mjs", PLUGIN).pathname, name, ...args], {
        cwd: dir, env: { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, ".codex"), PATH: dir, RELAY_JOBS_HOME: path.join(dir, "jobs") }, input, encoding: "utf8", timeout: 10_000
      });
      const expected = invoke([raw]);
      const file = path.join(dir, "args.txt");
      fs.writeFileSync(file, raw);
      assert.equal(expected.status, 1, expected.stderr || expected.stdout);
      for (const actual of [invoke(["--args-stdin"], `${raw}\n`), invoke(["--args-file", file])]) {
        assert.equal(actual.status, expected.status, actual.stderr || actual.stdout);
        assert.equal(actual.stderr, "");
        assert.equal(actual.stdout, expected.stdout);
        assert.equal(JSON.parse(actual.stdout).error.kind, "usage");
      }
    }
  });
}


test("file parsing preserves raw text; transport selectors reject mixed or duplicate argv and NUL", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-input-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "args.txt");
  const code = `
    import { parseCommandInput } from ${JSON.stringify(SHARED)};
    try { console.log(JSON.stringify(parseCommandInput(process.argv.slice(1), {
      argsStdin: true, valueOptions: ["cwd", "grok-home"], booleanOptions: ["json"]
    }))); } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const invoke = (argv, input = "") => spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", ...argv], {
    cwd: dir, input, encoding: "utf8", env: { ...process.env, HOME: dir, RELAY_JOBS_HOME: path.join(dir, "jobs") }
  });
  for (const raw of ["", "--cwd 'a b'", "--grok-home 'team\\\\home'", "--cwd ''", "--cwd $HOME/x", "last\\\n\n"]) {
    fs.writeFileSync(file, raw);
    const expected = invoke([raw]);
    const actual = invoke(["--args-file", file]);
    assert.equal(actual.status, expected.status, raw);
    assert.equal(actual.stdout, expected.stdout, raw);
    assert.equal(actual.stderr, expected.stderr, raw);
  }
  for (const argv of [
    ["--args-stdin", "--args-stdin"], ["--args-stdin", "--cwd", "/tmp"],
    ["--args-file"], ["--args-file", file, "--args-file", file],
    ["--args-file", file, "--args-stdin"], ["--args-file", file, "--cwd", "/tmp"]
  ]) assert.equal(invoke(argv).status, 1, JSON.stringify(argv));
  fs.writeFileSync(file, "bad\0text");
  for (const result of [invoke(["--args-file", file]), invoke(["--args-stdin"], "bad\0text\n")]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NUL/);
  }
});

test("cwd expands only a leading home shorthand, without shell evaluation", () => {
  const code = `
    import { resolveCommandCwd } from ${JSON.stringify(SHARED)};
    console.log(JSON.stringify(["~", "~/project", "$HOME/project", "team\\\\home"].map(cwd => resolveCommandCwd({ cwd }))));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", env: { ...process.env, HOME: "/tmp/relay-test-home" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["/tmp/relay-test-home", "/tmp/relay-test-home/project",
    path.resolve("$HOME/project"), path.resolve("team\\home")]);
});

test("estimate resolves auto, explicit scopes and bases like review; bad revisions stay inert", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-estimate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, RELAY_JOBS_HOME: path.join(dir, "jobs"),
    CODEX_HOME: path.join(dir, ".codex"),
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  git("init", "-b", "main");
  fs.writeFileSync(path.join(dir, "tracked"), "base\n");
  git("add", "."); git("commit", "-m", "base"); git("checkout", "-b", "feature");
  fs.appendFileSync(path.join(dir, "tracked"), "branch\n");
  git("commit", "-am", "feature");
  const companion = new URL("scripts/companion.mjs", PLUGIN).pathname;
  const estimate = (raw, name = "review", file = false) => {
    const argsFile = path.join(os.tmpdir(), `relay-estimate-args-${path.basename(dir)}`);
    t.after(() => fs.rmSync(argsFile, { force: true }));
    fs.writeFileSync(argsFile, raw);
    return spawnSync(process.execPath, [companion, name, "--estimate", "--json",
      ...(file ? ["--args-file", argsFile] : ["--args-stdin"])], {
      cwd: dir, env, input: `${raw}\n`, encoding: "utf8", timeout: 10_000
    });
  };
  const read = raw => {
    const result = estimate(raw);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  assert.equal(read("").target.mode, "branch");
  assert.equal(read("").fileCount, 1);
  assert.equal(read("--scope working-tree").fileCount, 0);
  assert.equal(read("--estimate=false --scope working-tree").fileCount, 0);
  fs.writeFileSync(path.join(dir, "untracked"), "new\n");
  assert.equal(read("").target.mode, "working-tree");
  assert.equal(read("").fileCount, 1);
  fs.appendFileSync(path.join(dir, "tracked"), "staged\n"); git("add", "tracked");
  fs.appendFileSync(path.join(dir, "tracked"), "unstaged\n");
  assert.equal(read("").fileCount, 2); // Count staged/unstaged overlap once, plus untracked.
  assert.equal(read("--base main --scope working-tree").target.mode, "branch");
  for (const name of ["review", "adversarial-review"]) {
    const result = estimate("--base main", name, true);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.target.label, "branch diff against main");
    assert.equal(payload.fileCount, 1);
    assert.match(payload.shortstat, /1 file changed/);
    for (const base of ["--output=estimate-ran", "main$(touch estimate-ran)", "`touch estimate-ran`", "missing-ref", "main...HEAD", ""]) {
      const bad = estimate(`--base '${base}'`, name, true);
      assert.equal(bad.status, 1, base);
      assert.equal(fs.readdirSync(dir).some(entry => entry.startsWith("estimate-ran")), false);
    }
  }
  assert.equal(fs.existsSync(path.join(dir, "jobs")), false, "estimation must not start a backend or create jobs");
});


test("setup file input keeps cwd and home shorthand and documents raw-parser escaping through a fake backend", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-setup-args-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const project = path.join(dir, "project with spaces");
  fs.mkdirSync(bin); fs.mkdirSync(project);
  const fake = installFakeGrok(bin);
  const file = path.join(dir, "args.txt");
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, RELAY_JOBS_HOME: path.join(dir, "jobs"), GROK_BINARY: fake.binary };
  const invoke = raw => {
    fs.writeFileSync(file, raw);
    return spawnSync(process.execPath, [new URL("scripts/companion.mjs", PLUGIN).pathname, "setup", "--json", "--args-file", file], {
      cwd: dir, env, encoding: "utf8", timeout: 10_000
    });
  };
  for (const [home, expected] of [
    ["~/custom", path.join(dir, "custom")],
    ["'/tmp/team\\\\home'", "/tmp/team\\home"],
    ['"/tmp/team\\home"', "/tmp/teamhome"]
  ]) {
    const result = invoke(`--backend grok --cwd '~/project with spaces' --grok-home ${home}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const page = JSON.parse(result.stdout);
    assert.equal(page.backends[0].home, expected);
  }
  for (const raw of ["--backend grok --grok-home $HOME/custom", "--cwd ''", "--backend grok --grok-home ''"]) {
    const result = invoke(raw);
    assert.equal(result.status, 1, raw);
    assert.equal(JSON.parse(result.stdout).error.kind, "usage");
  }
  assert.equal(fake.state().starts.length, 0, "setup makes no model call");
});
