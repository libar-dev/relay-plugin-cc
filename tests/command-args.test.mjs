import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// A baseline copy can be selected to prove the regression tests reject old recipes.
const PLUGIN = process.env.RELAY_TEST_COMMANDS_PLUGIN
  ? pathToFileURL(`${path.resolve(process.env.RELAY_TEST_COMMANDS_PLUGIN)}${path.sep}`)
  : new URL("../plugins/relay/", import.meta.url);
const SHARED = new URL("scripts/cli/shared.mjs", PLUGIN).href;

// Read the actual recipes, including the old Bash tool example so these tests can
// also demonstrate the vulnerability before the Markdown is fixed. Do not eval JS:
// Claude submits the command string to Bash, not to a JavaScript interpreter.
function recipes(name) {
  const source = fs.readFileSync(new URL(`commands/${name}.md`, PLUGIN), "utf8");
  const commands = [];
  for (const block of source.matchAll(/```(bash|typescript)\n([\s\S]*?)\n```/g)) {
    const command = block[1] === "bash" ? block[2] : /command:\s*`([\s\S]*?)`,/.exec(block[2])?.[1];
    if (command?.includes("companion.mjs")) commands.push(command);
  }
  assert.equal(commands.length, 2, `${name}: both documented flows must be exercised`);
  return commands;
}

for (const name of ["review", "adversarial-review", "setup"]) {
  for (const [index, recipe] of recipes(name).entries()) {
    const flow = name === "setup" ? ["initial", "after install"][index] : ["foreground", "background"][index];
    test(`${name} ${flow}: documented Bash passes literal arguments without evaluation`, t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-command-args-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(path.join(dir, "scripts/companion.mjs"), `
        import fs from "node:fs";
        const argv = process.argv.slice(2);
        const stdin = fs.readFileSync(0, "utf8");
        fs.writeFileSync("received.json", JSON.stringify({ argv, stdin }));
        process.stdout.write("companion output\\n  verbatim\\n");
        process.stderr.write("companion stderr\\n");
        process.exitCode = 7;
      `);
      // Astra's harmless printf probe plus marker files for both expansion forms.
      const raw = "--wait `printf RELAY_PROBE; touch backtick-ran` $(touch substitution-ran) $RELAY_REVIEW_LITERAL \"double quoted\" 'single quoted'\nsecond line";
      const result = spawnSync("bash", ["-c", recipe.replaceAll("$ARGUMENTS", raw)], {
        cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: dir, RELAY_REVIEW_LITERAL: "EXPANDED" },
        encoding: "utf8",
        timeout: 10_000
      });
      assert.equal(result.error, undefined);
      assert.equal(fs.existsSync(path.join(dir, "backtick-ran")), false, "backticked text ran in Bash");
      assert.equal(fs.existsSync(path.join(dir, "substitution-ran")), false, "$(...) text ran in Bash");
      assert.equal(result.status, 7, result.stderr);
      assert.equal(result.stdout, "companion output\n  verbatim\n");
      assert.equal(result.stderr, "companion stderr\n");
      const received = JSON.parse(fs.readFileSync(path.join(dir, "received.json"), "utf8"));
      assert.deepEqual(received.argv, [name, ...(name === "setup" ? ["--json"] : []), "--args-stdin"]);
      assert.equal(received.stdin, `${raw}\n`, "the heredoc adds only its framing newline");
    });
  }
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
  test(`${name}: stdin errors keep single-string JSON output and exit status`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-command-errors-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const raw of ["--json --backend", "--json --backend not-a-backend"]) {
      const invoke = (args, input) => spawnSync(process.execPath, [new URL("scripts/companion.mjs", PLUGIN).pathname, name, ...args], {
        cwd: dir, input, encoding: "utf8", timeout: 10_000
      });
      const expected = invoke([raw]);
      const actual = invoke(["--args-stdin"], `${raw}\n`);
      assert.equal(expected.status, 1, expected.stderr || expected.stdout);
      assert.equal(actual.status, expected.status, actual.stderr || actual.stdout);
      assert.equal(actual.stderr, "");
      assert.equal(actual.stdout, expected.stdout);
      assert.equal(JSON.parse(actual.stdout).error.kind, "usage");
    }
  });
}
