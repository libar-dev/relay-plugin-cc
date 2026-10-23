import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";
import { isProcessIdentityAlive, readProcessStartTime } from "../../plugins/relay/scripts/lib/util/process.mjs";

// One temporary root per test process. TMPDIR points at it, so every temporary directory this
// process makes and every process it starts lands under it. At exit the root goes, once no
// process runs from it any more: one still running keeps it, and its path and the pids are
// printed. RELAY_TEST_KEEP_TMP=1 keeps the root of a run that failed and marks it kept, so no
// later run sweeps it; remove it yourself. A signal skips the exit handler, so each root records
// its owner, and a new run sweeps the roots of owners now gone.
if (!process.env.RELAY_TEST_ROOT) {
  sweepStaleTestRoots(os.tmpdir());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-run-"));
  fs.writeFileSync(path.join(root, ".owner"), JSON.stringify({ pid: process.pid, startTime: readProcessStartTime(process.pid) }));
  process.env.RELAY_TEST_ROOT = root;
  process.env.TMPDIR = root;
  process.on("exit", code => removeTestRoot(root, code));
}

// Processes other than this one whose working directory or command line is under `root`. The
// root is also matched by its real path: /proc and lsof name a working directory that way, and a
// temporary directory can be reached through a symlink (macOS's /var/folders is
// /private/var/folders). The limit: a detached process that uses the root only through
// RELAY_TEST_ROOT or TMPDIR, its working directory and command line elsewhere, is not found, so
// its owner's exit, or a sweep after the owner died, removes the root under it. Finding it would
// take tracking each child by pid and start time, which the suite does not do.
function processesUnder(root) {
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* gone */ }
  const inside = text => [root, real].some(dir => text === dir || text.startsWith(dir + path.sep) || text.includes(dir + path.sep));
  if (process.platform === "linux") {
    const pids = [];
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (inside(fs.readlinkSync(`/proc/${name}/cwd`)) || inside(fs.readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " "))) pids.push(Number(name));
      } catch { /* gone, or a zombie */ }
    }
    return pids;
  }
  const listed = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const pids = new Set(String(listed.stdout ?? "").split("\n").map(line => /^\s*(\d+)\s(.*)$/.exec(line)).filter(match => match && inside(match[2])).map(match => Number(match[1])));
  // Working directories, which ps cannot show: lsof prints a `p<pid>` line, then `n<cwd>`.
  let pid = null;
  for (const line of String(spawnSync("lsof", ["-d", "cwd", "-Fpn"], { encoding: "utf8" }).stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && inside(line.slice(1))) pids.add(pid);
  }
  pids.delete(process.pid);
  return [...pids];
}

// A root whose recorded owner is gone (by pid and start time), that no process runs from, and
// that was not kept on purpose.
function sweepStaleTestRoots(tmp) {
  for (const name of fs.readdirSync(tmp).filter(entry => entry.startsWith("relay-test-run-"))) {
    const root = path.join(tmp, name);
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || fs.existsSync(path.join(root, ".kept"))) continue;
      const owner = JSON.parse(fs.readFileSync(path.join(root, ".owner"), "utf8"));
      if (isProcessIdentityAlive(owner) || processesUnder(root).length > 0) continue;
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* no owner recorded yet, or already gone */ }
  }
}

function removeTestRoot(root, code) {
  if (code !== 0 && process.env.RELAY_TEST_KEEP_TMP === "1") {
    try { fs.writeFileSync(path.join(root, ".kept"), ""); } catch { /* gone */ }
    process.stderr.write(`note: kept the test root of a failed run: ${root}\n`);
    return;
  }
  // The exit handler is synchronous: wait for stragglers up to 5 s (RELAY_TEST_ROOT_WAIT_MS).
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + (Number(process.env.RELAY_TEST_ROOT_WAIT_MS) || 5000);
  let running = processesUnder(root);
  while (running.length > 0 && Date.now() < deadline) {
    Atomics.wait(pause, 0, 0, 100);
    running = processesUnder(root);
  }
  if (running.length > 0) {
    process.stderr.write(`note: kept the test root ${root}: processes still run from it: ${running.join(", ")}\n`);
    return;
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the next run's leftovers check names it */ }
}

// Tests run inside Claude Code sessions where hooks of an installed relay plugin export
// variables that change where state goes and which jobs a command can see. Strip them so
// the suite behaves the same inside and outside a session, and never writes into a real
// plugin data directory or a real job home.
const LEAKED_ENV = [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "RELAY_COMPANION_SESSION_ID",
  "RELAY_COMPANION_TRANSCRIPT_PATH",
  "RELAY_COMPANION_APP_SERVER_ENDPOINT",
  "RELAY_COMPANION_APP_SERVER_PID_FILE",
  "RELAY_COMPANION_APP_SERVER_LOG_FILE"
];

for (const name of LEAKED_ENV) {
  delete process.env[name];
}
// A shell that ZCode started exports its own data and provider paths, which would point the
// ZCode setup check at a real sign-in.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ZCODE_")) delete process.env[name];
}
// A shell Kimi started, or a user's own setup, can name a Kimi home or a model to use. The
// installer puts the real kimi on PATH, so every process gets a binary that does not exist
// unless its test installs the fake.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("KIMI_")) delete process.env[name];
}
process.env.KIMI_BINARY = path.join(os.tmpdir(), "relay-tests-no-kimi", "kimi");

if (!process.env.RELAY_JOBS_HOME_FOR_TESTS) {
  process.env.RELAY_JOBS_HOME_FOR_TESTS = fs.mkdtempSync(path.join(os.tmpdir(), "relay-jobs-home-"));
}
process.env.RELAY_JOBS_HOME = process.env.RELAY_JOBS_HOME_FOR_TESTS;

// The real home holds backend sign-ins and Claude Code sessions.
// This process and every process it starts get a scratch HOME instead, so a default home
// (`grok-home: default`, `~/.codex`, `~/.relay-jobs`) resolves under it. The real homes, as
// the environment and the password database name them, are kept for the fakes' guard.
function realHomes() {
  if (process.env.RELAY_REAL_HOMES_FOR_TESTS) return JSON.parse(process.env.RELAY_REAL_HOMES_FOR_TESTS);
  let account = null;
  try {
    account = os.userInfo().homedir;
  } catch {
    // no password entry
  }
  const homes = [process.env.HOME, process.env.USERPROFILE, account]
    .filter(Boolean)
    .map((home) => path.resolve(home))
    .filter((home) => home !== path.parse(home).root);
  return [...new Set(homes.flatMap((home) => [home, fs.existsSync(home) ? fs.realpathSync(home) : home]))];
}

export const REAL_HOMES = realHomes();
process.env.RELAY_REAL_HOMES_FOR_TESTS = JSON.stringify(REAL_HOMES);
if (!process.env.RELAY_HOME_FOR_TESTS) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-home-"));
  fs.mkdirSync(path.join(scratch, "home"));
  process.env.RELAY_HOME_FOR_TESTS = path.join(scratch, "home");
}
process.env.HOME = process.env.RELAY_HOME_FOR_TESTS;
process.env.USERPROFILE = process.env.RELAY_HOME_FOR_TESTS;
// Existing suites must not depend on real machine pressure or admission pacing.
process.env.RELAY_ADMISSION ??= "off";
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

// A fake that was about to write under a real home appends its refusal here.
const REFUSALS = path.join(path.dirname(process.env.RELAY_HOME_FOR_TESTS), "real-home-writes.log");

// Source of `refuseRealHome(target)` for a fake binary: before it writes under a home, the
// fake checks the target. Under a real home (and outside the temp directory), it records
// the refusal, says so on stderr and exits 86 without writing.
export function realHomeGuardSource(name, homes = REAL_HOMES, log = REFUSALS) {
  return `function refuseRealHome(target) {
  const path = require("node:path");
  const inside = (dir) => { const relative = path.relative(dir, path.resolve(target)); return !relative.startsWith("..") && !path.isAbsolute(relative); };
  if (inside(require("node:os").tmpdir())) return;
  const home = ${JSON.stringify(homes)}.find(inside);
  if (!home) return;
  const message = "fake ${name} refused to write under the real home " + home + ": " + path.resolve(target) + "\\n";
  require("node:fs").appendFileSync(${JSON.stringify(log)}, message);
  process.stderr.write(message);
  process.exit(86);
}`;
}

// The refusal fails the test file by name, whatever the test that caused it then saw.
after(() => {
  if (fs.existsSync(REFUSALS)) {
    throw new Error(`A test pointed a fake backend at a real home:\n${fs.readFileSync(REFUSALS, "utf8")}`);
  }
});
