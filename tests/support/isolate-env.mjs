import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after } from "node:test";

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
