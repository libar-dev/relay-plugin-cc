#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const SESSION_ID_ENV = "RELAY_COMPANION_SESSION_ID";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

// Write each export at most once. SessionStart fires on start, resume, clear and
// compaction; repeated exports can grow CLAUDE_ENV_FILE until Bash calls fail with E2BIG.
// A line already present is left alone.
function exportOnce(name, value) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || value === "") {
    return;
  }
  const line = `export ${name}=${shellEscape(value)}`;
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch {
    existing = "";
  }
  if (existing.split(/\r?\n/).includes(line)) {
    return;
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envFile, `${prefix}${line}\n`, "utf8");
}

function handleSessionStart(input) {
  exportOnce(SESSION_ID_ENV, input.session_id);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
  }
  // SessionEnd ends no job. Jobs belong to no Claude session: a job runs on in its own
  // worker until it ends or someone cancels it, and there is no shared broker to stop.
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
