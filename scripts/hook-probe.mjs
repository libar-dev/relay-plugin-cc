#!/usr/bin/env node
// A probe for the relay guard's assumptions. Register it for PreToolUse, PostToolUse and
// SubagentStop in a throwaway project's .claude/settings.json, run a relay:job agent, send
// it a SendMessage while it runs and one after it ends, then read the log:
//   $RELAY_HOOK_PROBE_LOG (default $TMPDIR/relay-hook-probe.jsonl)
// Each line holds the hook's stdin, whether agent_transcript_path (or the derived
// <session>/subagents/agent-<id>.jsonl) exists, and the last user entries of that file,
// which show how a SendMessage reaches the subagent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const raw = fs.readFileSync(0, "utf8");
let input = {};
try {
  input = JSON.parse(raw);
} catch {
  input = { unparsed: raw };
}
const derived =
  input.transcript_path && input.agent_id
    ? path.join(path.dirname(input.transcript_path), input.session_id ?? "", "subagents", `agent-${input.agent_id}.jsonl`)
    : null;
const transcript = [input.agent_transcript_path, derived].find((file) => file && fs.existsSync(file)) ?? null;
let lastUserEntries = null;
if (transcript) {
  lastUserEntries = fs
    .readFileSync(transcript, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && (entry.type === "user" || entry.message?.role === "user"))
    .slice(-4);
}
const log = process.env.RELAY_HOOK_PROBE_LOG || path.join(os.tmpdir(), "relay-hook-probe.jsonl");
fs.appendFileSync(
  log,
  `${JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(input), input, derivedTranscript: derived, transcriptFound: transcript, lastUserEntries })}\n`
);
