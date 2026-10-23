import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { register as registerHooks } from "node:module";

// The module imports Claude Code's `claude-code` package for its state; outside Claude Code a stub
// stands in, since the commands these tests drive keep no state.
const stub = "data:text/javascript," + encodeURIComponent(
  "export const atom = (key, initial) => ({ key, initial }); export const read = async () => null; export const update = async () => {};");
registerHooks("data:text/javascript," + encodeURIComponent(
  `export async function resolve(specifier, context, next) { return specifier === "claude-code" ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : next(specifier, context); }`));
const { register } = await import("../plugins/relay/hooks/mod/register.js");

// The four commands the hooks module answers, each with the module's `$` faked: the companion run
// prints nothing, so every answer names the shell command to run instead. That line, pasted into a
// shell from a plugin folder with hostile characters, must hand the companion the module's own
// argv and run nothing else.
function commands(root) {
  const handlers = {};
  const on = (event, filter, handler) => {
    if (event === "command.run") handlers[filter.command] = handler;
    return { catch() { return this; } };
  };
  register(on);
  const runs = [];
  const $ = {
    plugin: { root },
    session: { cwd: async () => root, id: async () => "session-1" },
    process: { run: async (argv) => (runs.push(argv), { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }) },
    env: { get: async () => undefined },
    clock: { now: async () => Date.now() },
  };
  return { handlers, $, runs };
}

// The line as a reader sees it: an inline code span, or the fenced `sh` block a line break needs.
// A Markdown renderer turns every CR and CRLF into LF first.
function shownLine(raw) {
  const text = raw.replace(/\r\n?/g, "\n");
  const block = /\n\n(`{3,})sh\n([\s\S]*)\n\1$/.exec(text);
  if (block) return block[2];
  const span = /Run (`+)([\s\S]*?)\1 in a shell/.exec(text);
  assert.ok(span, text);
  assert.doesNotMatch(span[2], /[\r\n]/, "an inline span never holds a line break");
  // CommonMark closes a code span at the first backtick run as long as its opening one.
  assert.ok((span[2].match(/`+/g) ?? []).every((run) => run.length !== span[1].length), `the span ends early: ${text}`);
  return span[2];
}

const ROOTS = ["plain", "with space", "it's", "$(touch root-ran)", "back`touch tick`tick", "bang!x", "car\rroot"];
const TYPED = [
  "j-1", "", " \t ", "j-1 --all", "$(touch typed-ran)", "`touch typed-ran`", "a''b", "x'\\''y", "trailing\\",
  "!!", "%1", "$HOME ${HOME} ~ * ; | < > #", "-n", "--source \"/tmp/it's here.jsonl\"", "``double`` and ```triple```",
  "x\n\n&#39;; touch typed-ran; printf &#39;\n\n:", "line\nbreak", " nbsp sep", "car\rreturn", "crlf\r\nline", "\r",
];

for (const shell of ["sh", "bash"]) {
  test(`every rerun line runs the companion with the module's argv and nothing else (${shell})`, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rerun-hint-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    for (const name of ROOTS) {
      const root = path.join(base, name);
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      const record = path.join(base, "argv.json");
      fs.writeFileSync(path.join(root, "scripts/companion.mjs"),
        `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
      const { handlers, $, runs } = commands(root);
      for (const [command, sub] of [["relay:status", "status"], ["relay:result", "result"], ["relay:cancel", "cancel"], ["relay:transfer", "transfer"]]) {
        for (const args of TYPED) {
          runs.length = 0;
          fs.rmSync(record, { force: true });
          const answer = await handlers[command]($, { command, args });
          assert.equal(runs.length, 1);
          assert.equal(runs[0][2], sub);
          const line = shownLine(answer.text);
          const ran = spawnSync(shell, ["-c", line], { cwd: base, encoding: "utf8" });
          assert.equal(ran.status, 0, `${shell} -c ${JSON.stringify(line)}: ${ran.stderr}`);
          assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), runs[0].slice(2), `${name} ${command} ${JSON.stringify(args)}`);
          for (const marker of ["root-ran", "typed-ran", "tick"]) {
            assert.equal(fs.existsSync(path.join(base, marker)), false, `${marker} after ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });
}

test("a line break puts the rerun line in a fenced sh block, so Markdown reads none of it", async () => {
  const { handlers, $ } = commands("/plugins/relay");
  const answer = await handlers["relay:transfer"]($, { command: "relay:transfer", args: "x\n\n&#39;; touch y\n\n:" });
  assert.ok(answer.text.endsWith(
    "Printed nothing (exit 0). Run this in a shell to see its output.\n\n```sh\nnode '/plugins/relay/scripts/companion.mjs' transfer 'x\n\n&#39;; touch y\n\n:'\n```"), answer.text);
});
