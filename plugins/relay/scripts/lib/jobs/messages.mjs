import { jobPaths, nowIso, readJsonOrNull, writeJsonAtomic } from "./store.mjs";
import { randomBytes } from "node:crypto";
import { default as fs } from "node:fs";
import { default as path } from "node:path";


// Inbox messages. A command writes a message file; the worker claims it with a rename,
// acts on it, and writes the outcome under inbox/outcomes/. A rename is atomic, so a
// message is acted on once even when two workers race.
export function newMessageId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}


// A message may carry its own id (the relay delivery chooses it before posting, so a
// delivery cut off half way is posted again under the same id, never twice).
export function postInboxMessage(jobDir, message) {
  const paths = jobPaths(jobDir);
  fs.mkdirSync(paths.inbox, { recursive: true });
  const id = message.id ?? newMessageId();
  const name = `${id}.json`;
  const record = { ...message, id, createdAt: nowIso() };
  const tmp = path.join(paths.inbox, `.${name}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, path.join(paths.inbox, name));
  return record;
}


export function pendingInboxMessages(jobDir) {
  const paths = jobPaths(jobDir);
  try {
    return fs
      .readdirSync(paths.inbox)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}


export function claimInboxMessages(jobDir) {
  const paths = jobPaths(jobDir);
  fs.mkdirSync(paths.claimed, { recursive: true });
  const claimed = [];
  for (const name of pendingInboxMessages(jobDir)) {
    const target = path.join(paths.claimed, name);
    try {
      fs.renameSync(path.join(paths.inbox, name), target);
    } catch {
      continue;
    }
    const message = readJsonOrNull(target);
    if (message) {
      claimed.push(message);
    }
  }
  return claimed;
}


export function writeOutcome(jobDir, messageId, outcome) {
  const paths = jobPaths(jobDir);
  fs.mkdirSync(paths.outcomes, { recursive: true });
  writeJsonAtomic(path.join(paths.outcomes, `${messageId}.json`), { messageId, at: nowIso(), ...outcome });
}


// A receipt for a message that needs no worker (a cancel of a job that already ended):
// written straight to claimed/ with its outcome, so every reader sees it handled.
export function recordReceipt(jobDir, message, outcome) {
  const paths = jobPaths(jobDir);
  fs.mkdirSync(paths.claimed, { recursive: true });
  const record = { ...message, id: message.id ?? newMessageId(), createdAt: nowIso() };
  writeJsonAtomic(path.join(paths.claimed, `${record.id}.json`), record);
  writeOutcome(jobDir, record.id, outcome);
  return record;
}


// Is a message with this id anywhere in the inbox: waiting, claimed or answered?
export function messageExists(jobDir, messageId) {
  const paths = jobPaths(jobDir);
  return [paths.inbox, paths.claimed, paths.outcomes].some((dir) => fs.existsSync(path.join(dir, `${messageId}.json`)));
}


// Relay violations: appended, never rewritten, so a failed check is never forgotten.
export function appendRelayViolation(jobDir, violation) {
  const file = path.join(jobDir, "relay-violations.jsonl");
  const record = { at: nowIso(), ...violation };
  const existing = readRelayViolations(jobDir);
  const duplicate = (record.kind === "transcript" ? existing : existing.slice(-1))
    .find((entry) => entry.kind === record.kind && entry.reason === record.reason);
  if (duplicate) {
    return duplicate;
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}


export function readRelayViolations(jobDir) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(jobDir, "relay-violations.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ kind: "unreadable", reason: "a relay violation record could not be read" });
    }
  }
  return out;
}


// Each result a relay handed back to its caller, appended and never rewritten. A relay job that
// ended with no hand-back for its last attempt was never collected: its caller died or gave up,
// and only `status` or `result` shows the report.
export function appendRelayHandback(jobDir, handback) {
  const file = path.join(jobDir, "relay-handbacks.jsonl");
  const last = readRelayHandbacks(jobDir).at(-1);
  if (last && last.agentId === handback.agentId && last.attempts === handback.attempts && last.state === handback.state) {
    return last;
  }
  const record = { at: nowIso(), ...handback };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}


export function readRelayHandbacks(jobDir) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(jobDir, "relay-handbacks.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.trim()).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}


export function readOutcome(jobDir, messageId) {
  return readJsonOrNull(path.join(jobPaths(jobDir).outcomes, `${messageId}.json`));
}


export function isMessagePending(jobDir, messageId) {
  return fs.existsSync(path.join(jobPaths(jobDir).inbox, `${messageId}.json`));
}


// Message ledger. A message is delivered when it ran as a turn or was steered into one;
// it is closed when delivered, dropped (reported in the state block) or skipped (a default
// resume made redundant by other work). Any other claimed message is still owed: the next
// worker runs it.
const DELIVERED_ACTIONS = new Set(["steered", "turn-started", "delivered-before"]);

export const CLOSED_ACTIONS = new Set([...DELIVERED_ACTIONS, "dropped", "skipped"]);

const WORK_KINDS = new Set(["steer", "continue", "resume"]);


function readClaimedMessages(jobDir) {
  const paths = jobPaths(jobDir);
  let names = [];
  try {
    names = fs.readdirSync(paths.claimed).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names
    .map((name) => readJsonOrNull(path.join(paths.claimed, name)))
    .filter(Boolean)
    .map((message) => ({ message, outcome: readOutcome(jobDir, message.id) }));
}


// Claimed work messages that no worker has delivered or closed yet, oldest first.
export function owedMessages(jobDir) {
  return readClaimedMessages(jobDir)
    .filter(({ message, outcome }) => WORK_KINDS.has(message.kind) && !CLOSED_ACTIONS.has(outcome?.action))
    .map(({ message }) => message);
}


export function messageAccount(jobDir) {
  // Read along the message's path. A move after an earlier listing is visible in
  // the next stage; each id has one entry, with the latest stage we observed.
  const seen = new Map();
  for (const name of pendingInboxMessages(jobDir)) {
    const message = readJsonOrNull(path.join(jobPaths(jobDir).inbox, name));
    if (message && WORK_KINDS.has(message.kind)) seen.set(message.id, { message, outcome: null });
  }
  for (const entry of readClaimedMessages(jobDir)) seen.set(entry.message.id, entry);
  const entries = [...seen.values()];
  const undelivered = entries
    .filter(({ message, outcome }) => WORK_KINDS.has(message.kind) && !CLOSED_ACTIONS.has(outcome?.action))
    .map(({ message }) => message.id);
  const dropped = entries
    .filter(({ outcome }) => outcome?.action === "dropped")
    .map(({ message, outcome }) => ({ id: message.id, reason: outcome.reason ?? "dropped" }));
  return { undelivered, dropped };
}
