// Tests never write into the real home of whoever runs them. Every test process,
// and every process it starts, gets a scratch HOME (isolate-env.mjs); a fake backend about
// to write under a real home refuses, and the test file fails naming the path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run, writeExecutable } from "./support/helpers.mjs";
import { REAL_HOMES, realHomeGuardSource } from "./support/isolate-env.mjs";

test("the suite runs with a scratch HOME, and a process it starts inherits it", () => {
  assert.ok(REAL_HOMES.length > 0);
  assert.equal(REAL_HOMES.includes(process.env.HOME), false);
  assert.ok(process.env.HOME.startsWith(os.tmpdir()), process.env.HOME);
  assert.equal(os.homedir(), process.env.HOME);
  assert.equal(process.env.CODEX_HOME, undefined);
  assert.equal(process.env.GROK_HOME, undefined);
  const child = run(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"]);
  assert.equal(child.stdout, process.env.HOME);
});

test("a fake about to write under a real home exits 86, records the refusal and writes nothing", () => {
  const root = makeTempDir("relay-guard-");
  const real = path.join(root, "real");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(real);
  fs.mkdirSync(tmp);
  const log = path.join(root, "refusals.log");
  const probe = path.join(root, "probe");
  writeExecutable(probe, `#!/usr/bin/env node\n${realHomeGuardSource("probe", [real], log)}\nrefuseRealHome(process.argv[2]);\nrequire("node:fs").mkdirSync(process.argv[2], { recursive: true });\n`);
  const env = { ...process.env, TMPDIR: tmp };

  const target = path.join(real, ".grok", "sessions", "session-1");
  const refused = run(process.execPath, [probe, target], { env });
  assert.equal(refused.status, 86);
  assert.equal(refused.stderr, `fake probe refused to write under the real home ${real}: ${target}\n`);
  assert.equal(fs.readFileSync(log, "utf8"), refused.stderr);
  assert.equal(fs.existsSync(path.join(real, ".grok")), false);

  const scratch = path.join(root, "scratch", ".grok", "sessions", "session-1");
  assert.equal(run(process.execPath, [probe, scratch], { env }).status, 0);
  assert.ok(fs.existsSync(scratch));
  // A temp directory inside a real home is still scratch.
  const inTmp = path.join(real, "tmp", "x");
  assert.equal(run(process.execPath, [probe, inTmp], { env: { ...process.env, TMPDIR: path.join(real, "tmp") } }).status, 0);
  assert.equal(fs.readFileSync(log, "utf8"), refused.stderr);
});

test("a recorded refusal fails the test file that caused it, naming the path", () => {
  const root = makeTempDir("relay-guard-run-");
  const file = path.join(root, "refused.test.mjs");
  fs.writeFileSync(file, `import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ${JSON.stringify(new URL("./support/isolate-env.mjs", import.meta.url).href)};
test("passes, but a fake refused", () => {
  fs.appendFileSync(path.join(path.dirname(process.env.RELAY_HOME_FOR_TESTS), "real-home-writes.log"), "fake grok refused to write under the real home /real: /real/.grok\\n");
});
`);
  const env = { ...process.env, RELAY_HOME_FOR_TESTS: path.join(root, "home") };
  delete env.NODE_TEST_CONTEXT;
  const result = run(process.execPath, ["--test", "--test-reporter=spec", file], { cwd: root, env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /A test pointed a fake backend at a real home:\s+fake grok refused to write under the real home \/real: \/real\/\.grok/);
});

test("test isolation disables an inherited admission-on override", () => {
  const source = `await import(${JSON.stringify(new URL("./support/isolate-env.mjs", import.meta.url).href)}); console.log("admission:" + process.env.RELAY_ADMISSION);`;
  const result = run(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, RELAY_ADMISSION: "on" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^admission:off$/m);
});
