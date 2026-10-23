import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { installFakeGrok } from "./fakes/grok.mjs";
import { installFakeKimi } from "./fakes/kimi.mjs";
import { KimiConnection } from "../plugins/relay/scripts/lib/backends/kimi/connection.mjs";

for (const backend of ["grok", "kimi"]) {
  for (const sample of ["space here", "single'and\"double", "`touch backtick-ran`", "$(touch substitution-ran)", "first\nsecond", "cr\rhere", "crlf\r\nhere"]) {
    test(`${backend}: signed-out advice preserves ${JSON.stringify(sample)} in Bash`, t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-signin-guidance-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const bin = path.join(dir, "bin");
      const stubs = path.join(dir, "stubs");
      fs.mkdirSync(bin); fs.mkdirSync(stubs);
      const fake = backend === "grok" ? installFakeGrok(bin, { signedOut: true }) : installFakeKimi(bin, { signedOut: true });
      const home = path.join(dir, sample);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(?:CODEX_HOME$|GROK_|KIMI_|ZCODE_)/.test(key)) delete env[key];
      Object.assign(env, { HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, ".codex"),
        XDG_CONFIG_HOME: path.join(dir, "config"), RELAY_JOBS_HOME: path.join(dir, "jobs"),
        PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
        [`${backend.toUpperCase()}_BINARY`]: fake.binary });
      // The raw parser escapes backslashes even inside quotes; double quotes group this path.
      const rawPath = `"${home.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
      const file = path.join(dir, "args.txt");
      fs.writeFileSync(file, `--backend ${backend} --${backend}-home ${rawPath}`);
      const result = spawnSync(process.execPath, [new URL("../plugins/relay/scripts/companion.mjs", import.meta.url).pathname,
        "setup", "--json", "--args-file", file], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      const block = report.backends[0];
      assert.equal(block.home, home);
      assert.equal(block.signIn.state, "signed-out");
      const assignment = backend === "grok" ? "GROK_HOME" : "KIMI_CODE_HOME";
      const suffix = backend === "grok" ? "grok login" : "kimi login --region global";
      const advice = [block.signIn.detail, ...report.nextSteps.filter(step => step.includes(`${assignment}=`))];
      assert.ok(advice.length >= 2, "detail and Next steps both name a login command");
      if (backend === "kimi") advice.push(KimiConnection.prototype.requestError.call({ request: { kimiHome: home } },
        { message: "Authentication required", data: { code: -32000 } }).message);
      fs.writeFileSync(path.join(stubs, backend), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync('received.json', JSON.stringify({ home: process.env.${assignment}, args: process.argv.slice(2) }));\n`, { mode: 0o755 });
      // Only the marker-writing probe and inert login stub are available to Bash.
      fs.writeFileSync(path.join(stubs, "touch"), `#!${process.execPath}\nconst fs = require('node:fs');\nfor (const name of process.argv.slice(2)) fs.writeFileSync(name, 'ran');\n`, { mode: 0o755 });
      for (const text of advice) {
        const start = text.indexOf(`${assignment}=`);
        assert.notEqual(start, -1, text);
        const command = text.slice(start, text.indexOf(suffix, start) + suffix.length);
        const pasted = spawnSync("/bin/bash", ["-c", command], { cwd: dir,
          env: { ...env, PATH: stubs }, encoding: "utf8", timeout: 10_000 });
        assert.equal(fs.existsSync(path.join(dir, "backtick-ran")), false, "backticks ran in Bash");
        assert.equal(fs.existsSync(path.join(dir, "substitution-ran")), false, "$() ran in Bash");
        assert.equal(pasted.status, 0, pasted.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "received.json"), "utf8")),
          { home, args: backend === "grok" ? ["login"] : ["login", "--region", "global"] });
        // Markdown turns a carriage return into a line feed: none may reach the command as written.
        assert.doesNotMatch(command, /\r/);
        // Markdown command advice must retain newlines and embedded backticks when copied.
        if (/[`\n]/.test(command)) {
          assert.ok(text.includes(`\n${command}\n`), "use a fenced block for multiline/backtick commands");
        } else {
          assert.ok(text.includes(`\`${command}\``), "put a one-line command in inline code");
        }
      }
      assert.equal(fake.state().starts.length, 0, "setup makes no model call");
    });
  }
}
