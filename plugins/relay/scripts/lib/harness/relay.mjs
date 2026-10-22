// The relay:job relay, carried by code. The relay is a small model; it never writes the
// prompt, a message or the report. Code reads them from the relay's own transcript and
// from the job:
//
// - `start --from-relay` reads the relay's first prompt from its transcript, byte for byte,
//   and binds the job to the relay's agent id (job.json `relay`, and a pointer file under
//   $RELAY_JOBS_HOME/relays/).
// - Before every relay tool call and at SubagentStop, the relay hook delivers every message
//   the relay received and that is not delivered yet, in order. Each delivery is recorded
//   under inbox/relay/<transcript entry uuid>.json, under a lock, so it happens once.
// - The relay's hand-back is rewritten to what `result <job>` prints.
//
// The transcript format is not documented. It is parsed defensively: anything that cannot
// be read or understood is recorded as a relay violation on the job, never silently
// skipped, and never blocks the relay forever.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { awaitOutcome, hasLiveWorker, COMPANION_SCRIPT } from "../worker/delivery.mjs";
import { appendRelayViolation, messageExists, messageAccount, newMessageId, postInboxMessage } from "../jobs/messages.mjs";
import { absoluteJobsHomeEnv, listJobDirs, nowIso, readJob, jobPaths, readJsonOrNull, resolveJobsHome, TERMINAL_STATES, writeJsonAtomic } from "../jobs/store.mjs";
import { isTerminalView, JobViewBusy, loadJobView } from "../jobs/view.mjs";
import { acquireOwnership, releaseOwnership } from "../util/ownership.mjs";
import { classifyHarnessEntry, unframeComputedTask, WORKFLOW_SYSTEM_NOTES } from "./workflow.mjs";

// The wake (the hooks module's session.send hook) ends a wait when a message is sent to the relay,
// so the bound only caps a tool call. 600 s is the Bash tool's maximum.
export const RELAY_WAIT_SECONDS = 540;
export const RELAY_BASH_TIMEOUT_MS = 600000;
// The guard lets a relay go, with a recorded violation, only after this many consecutive blocks.
export const RELAY_BLOCK_BUDGET = 8;

const COORDINATOR_PREFIX = "The coordinator sent a message while you were working:\n";
const COORDINATOR_SUFFIX = "\n\nAddress this before completing your current task.";

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function relayAgentTypes(env = process.env) {
  return new Set(
    String(env.RELAY_AGENT_TYPES || "relay:job")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

// Only a subagent is a relay: a main session started with `--agent relay:job` carries the
// agent type too, but no agent id and no agent transcript.
export function isRelayInput(input, env = process.env) {
  if (!input?.agent_type || !relayAgentTypes(env).has(input.agent_type)) {
    return false;
  }
  return Boolean(input.agent_id || input.agent_transcript_path);
}

// ---------------------------------------------------------------------------------------
// The relay transcript

// A workflow subagent's transcript is <dir>/workflows/<run>/agent-<id>.jsonl, one level below
// the <dir>/agent-<id>.jsonl the hook input names. The run directory name appears in no hook
// field, so every run directory is tried with the exact basename, the agent id as the key.
function workflowSiblings(file) {
  const basename = path.basename(file);
  if (!/^agent-([0-9A-Za-z]+)\.jsonl$/.test(basename)) {
    return [];
  }
  const workflows = path.join(path.dirname(file), "workflows");
  let entries;
  try {
    entries = fs.readdirSync(workflows, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(workflows, name, basename));
}

export function transcriptCandidates(input) {
  const candidates = [];
  if (input.agent_transcript_path) {
    candidates.push(input.agent_transcript_path, ...workflowSiblings(input.agent_transcript_path));
  }
  if (input.transcript_path && input.agent_id) {
    const base = path.dirname(input.transcript_path);
    const session = input.session_id || path.basename(input.transcript_path, ".jsonl");
    const inSession = path.join(base, session, "subagents", `agent-${input.agent_id}.jsonl`);
    candidates.push(inSession, ...workflowSiblings(inSession));
    candidates.push(path.join(base, `agent-${input.agent_id}.jsonl`));
  }
  return [...new Set(candidates)];
}

export function resolveAgentTranscript(input, extra = []) {
  const candidates = [...transcriptCandidates(input), ...extra.filter(Boolean)];
  return { file: candidates.find((candidate) => fs.existsSync(candidate)) ?? null, candidates };
}

function textOfContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  if (!content.every((block) => block && block.type === "text" && typeof block.text === "string")) {
    return null;
  }
  return content.map((block) => block.text).join("\n");
}

function isToolResult(content) {
  return Array.isArray(content) && content.some((block) => block?.type === "tool_result");
}

// A message from another agent of the session (a subagent's or a Workflow agent's SendMessage)
// has origin kind `peer`. The harness wraps its text in an envelope naming the sender, and keeps
// the text as sent in `origin.body`, which is what the job gets.
function peerBody(origin) {
  return typeof origin?.body === "string" ? origin.body : null;
}

function unwrapCoordinator(text) {
  if (text.startsWith(COORDINATOR_PREFIX) && text.endsWith(COORDINATOR_SUFFIX) && text.length >= COORDINATOR_PREFIX.length + COORDINATOR_SUFFIX.length) {
    return text.slice(COORDINATOR_PREFIX.length, text.length - COORDINATOR_SUFFIX.length);
  }
  return text;
}

// The relay's first prompt and every message it received after it, in order. A message is
// recognised by its entry type and origin, never by its text:
// - an `attachment` entry of type `queued_command` whose origin is the coordinator or a peer
//   (SendMessage while the relay works, from the main thread or from another agent);
// - a `user` entry whose origin is the coordinator or a peer (a message that resumes a relay
//   that has handed back), unwrapped from the harness's fixed wrapper when it has one; a
//   peer's text is its origin's `body`;
// - a plain `user` turn that is not metadata (`isMeta`) and not a tool result.
// Under the Workflow tool the harness's two user entries are recognised by their marker line
// (workflow-harness.mjs): the user request is skipped, the computed task is the prompt,
// unframed. `structuredOutput` is true when the system prompt snapshot asks for the
// StructuredOutput tool (a script passed `schema`). `stringReturn` is true when the relay's
// final text is its return value (the string-return note, or a framed prompt): such a relay
// has no SubagentHandback, so SubagentStop holds its final text.
export function parseRelayTranscript(text) {
  const lines = text.split("\n");
  const complete = text.endsWith("\n");
  let prompt = null;
  let structuredOutput = false;
  let stringReturnNote = false;
  let framedPrompt = false;
  const messages = [];
  const problems = [];
  const seen = new Set();
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !complete) {
        return; // the last line is still being written; the next check reads it
      }
      problems.push(`line ${index + 1} is not JSON`);
      return;
    }
    if (!entry || typeof entry !== "object") {
      problems.push(`line ${index + 1} is not an entry`);
      return;
    }
    const where = entry.uuid ? `entry ${entry.uuid}` : `line ${index + 1}`;
    const addMessage = (messageText, shape) => {
      if (!entry.uuid) {
        problems.push(`a received message on line ${index + 1} has no uuid`);
        return;
      }
      if (seen.has(entry.uuid)) {
        return;
      }
      seen.add(entry.uuid);
      messages.push({ uuid: entry.uuid, text: messageText, shape });
    };

    if (entry.type === "attachment" && entry.attachment?.type === "queued_command") {
      const originEntry = entry.attachment.origin ?? entry.origin ?? null;
      const origin = originEntry?.kind ?? null;
      if (origin !== "coordinator" && origin !== "peer") {
        if (origin == null) {
          problems.push(`${where} is a queued command with no origin`);
        }
        return;
      }
      if (prompt == null) {
        problems.push(`${where} is a message that came before the prompt`);
        return;
      }
      const messageText = origin === "peer"
        ? peerBody(originEntry)
        : typeof entry.attachment.prompt === "string" ? entry.attachment.prompt : textOfContent(entry.attachment.prompt);
      if (messageText == null) {
        problems.push(`${where} is a queued message whose text could not be read`);
        return;
      }
      addMessage(messageText, origin === "peer" ? "peer" : "queued_command");
      return;
    }

    if (entry.type === "attachment" && entry.attachment?.type === "prompt_snapshot") {
      const systemPrompt = entry.attachment.systemPrompt;
      if (Array.isArray(systemPrompt) && systemPrompt.some((part) => typeof part === "string" && part.includes(WORKFLOW_SYSTEM_NOTES.structuredOutput))) {
        structuredOutput = true;
      }
      if (Array.isArray(systemPrompt) && systemPrompt.some((part) => typeof part === "string" && part.includes(WORKFLOW_SYSTEM_NOTES.stringReturn))) {
        stringReturnNote = true;
      }
      return;
    }

    const message = entry.message;
    const isUser = entry.type === "user" || (entry.type == null && message?.role === "user");
    if (!isUser || !message) {
      return;
    }
    if (isToolResult(message.content)) {
      return;
    }
    const fromCoordinator = entry.origin?.kind === "coordinator";
    const fromPeer = entry.origin?.kind === "peer";
    if (prompt == null) {
      if (entry.isMeta || fromCoordinator || fromPeer) {
        return;
      }
      const promptText = textOfContent(message.content);
      if (promptText == null) {
        problems.push(`${where} is the prompt, but its text could not be read`);
        return;
      }
      const kind = classifyHarnessEntry(promptText);
      if (kind === "user-request") {
        return; // harness context: never the prompt, never a message
      }
      if (kind === "computed-task") {
        const unframed = unframeComputedTask(promptText);
        problems.push(...unframed.problems.map((problem) => `${where} ${problem}`));
        prompt = { uuid: entry.uuid ?? null, text: unframed.prompt, notes: unframed.notes, framed: true };
        framedPrompt = true;
        return;
      }
      prompt = { uuid: entry.uuid ?? null, text: promptText, notes: [], framed: false };
      return;
    }
    if (entry.isMeta && !fromCoordinator && !fromPeer) {
      return; // harness metadata, marked as such by the entry itself
    }
    if (fromPeer) {
      const body = peerBody(entry.origin);
      if (body == null) {
        problems.push(`${where} is a message from another agent whose text could not be read`);
        return;
      }
      addMessage(body, "peer");
      return;
    }
    const messageText = textOfContent(message.content);
    if (messageText == null) {
      problems.push(`${where} is a message whose text could not be read`);
      return;
    }
    if (!fromCoordinator && classifyHarnessEntry(messageText) === "user-request") {
      return; // harness context, never a message
    }
    addMessage(fromCoordinator ? unwrapCoordinator(messageText) : messageText, fromCoordinator ? "coordinator" : "user");
  });
  return { prompt, messages, problems, structuredOutput, stringReturn: stringReturnNote || framedPrompt };
}

export function readRelayTranscript(file) {
  if (!file) {
    throw new Error("the relay transcript was not found");
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`the relay transcript ${file} could not be read (${error.code ?? error.message})`);
  }
  return parseRelayTranscript(text);
}

// ---------------------------------------------------------------------------------------
// The relay pointer and the job a relay is bound to

function safeName(value) {
  return String(value).replace(/[^0-9A-Za-z._-]/g, "_");
}

function relayPointerPath(env, agentId) {
  return path.join(resolveJobsHome(env), "relays", `${safeName(agentId)}.json`);
}

export function readRelayPointer(env, agentId) {
  return readJsonOrNull(relayPointerPath(env, agentId)) ?? { agentId };
}

export function writeRelayPointer(env, pointer) {
  const file = relayPointerPath(env, pointer.agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { ...pointer, updatedAt: nowIso() });
}

// Every relay a job has had: the current one first, then each one it took over from.
function relayAgentIds(job) {
  const relay = job?.relay;
  if (!relay?.agentId) {
    return [];
  }
  return [relay.agentId, ...(relay.previous ?? []).map((entry) => entry.agentId).filter(Boolean)];
}

// The job a relay started: found by the relay's agent id, never by a job id the relay names.
export function findRelayJob(env, agentId) {
  if (!agentId) {
    return null;
  }
  const pointer = readRelayPointer(env, agentId);
  if (pointer.jobDir && relayAgentIds(readJob(pointer.jobDir)).includes(agentId)) {
    return pointer.jobDir;
  }
  let found = null;
  let foundAt = "";
  for (const dir of listJobDirs({ env })) {
    const job = readJob(dir);
    if (relayAgentIds(job).includes(agentId) && String(job.createdAt ?? "") >= foundAt) {
      found = dir;
      foundAt = String(job.createdAt ?? "");
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------
// A re-spawned relay adopts its predecessor's job
//
// The Workflow harness starts an `agent()` call over, with the same prompt and a fresh agent
// id, when the agent stalls, loses its reply, gets a throttled reply, waits out a usage limit,
// when the user asks for a retry, and when a stopped run is resumed (the run keeps its id).
// The first relay's job keeps running; the new relay must take it over, not start a
// second one. The harness's own identity for a call is the key it writes to the run's
// `journal.jsonl`: one `started` line per spawn, the same key for every spawn of one call,
// different keys for two calls with the same prompt (Claude Code 2.1.288). A retry, and only
// a retry, also carries a label suffix: `(retry N)`, `(throttle-retry)`, `(after usage limit)`.

export function promptSha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// The journal key of the relay's `agent()` call: the last `started` line of the run's journal
// that names the agent id. Null when the journal or the line is not there.
export function readJournalKey(transcriptPath, agentId) {
  if (!transcriptPath || !agentId) {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(path.join(path.dirname(transcriptPath), "journal.jsonl"), "utf8");
  } catch {
    return null;
  }
  let key = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "started" && entry.agentId === agentId && typeof entry.key === "string" && entry.key) {
      key = entry.key;
    }
  }
  return key;
}

const RETRY_SUFFIX = /^(.*?) \((?:retry \d+|throttle-retry|after usage limit)\)$/;

// A label with the harness's one retry suffix removed, and whether it had one. Any other
// parenthetical part of a label is the label's own.
export function stripRetrySuffix(label) {
  const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  const match = RETRY_SUFFIX.exec(text);
  return match ? { base: match[1], retried: true } : { base: text, retried: false };
}

// The job a predecessor relay started for this call, or null. Same run only. By the journal
// key when the new relay has one (a job recorded without a key is looked up in the journal by
// its relay's agent id); otherwise, for a relay whose label carries a retry suffix,
// by the prompt's bytes and the label without that suffix. A job that failed or was cancelled
// is never adopted: a retry after a failure runs the work again.
export function findAdoptableRelayJob(env, { agentId, workflowRunId, journalKey, promptSha256: hash, label }) {
  if (!workflowRunId) {
    return null;
  }
  const own = stripRetrySuffix(label);
  if (!journalKey && !own.retried) {
    return null;
  }
  let found = null;
  let foundAt = "";
  for (const dir of listJobDirs({ env })) {
    const job = readJob(dir);
    const relay = job?.relay;
    if (!relay?.workflowRunId || relay.workflowRunId !== workflowRunId || relayAgentIds(job).includes(agentId)) {
      continue;
    }
    if (journalKey) {
      // A job whose start found no journal line is checked against its line in the journal now.
      if ((relay.journalKey || readJournalKey(relay.transcriptPath, relay.agentId)) !== journalKey) {
        continue;
      }
    } else if (relay.promptSha256 !== hash || stripRetrySuffix(relay.label).base !== own.base) {
      continue;
    }
    let state;
    try {
      state = loadJobView(dir).state;
    } catch (error) {
      // A busy job is at work: it stays a candidate. A directory without job.json does not.
      if (!(error instanceof JobViewBusy)) continue;
      state = null;
    }
    if (state === "failed" || state === "cancelled") {
      continue;
    }
    if (String(job.createdAt ?? "") >= foundAt) {
      found = dir;
      foundAt = String(job.createdAt ?? "");
    }
  }
  return found;
}

// Bind a job to its new relay: the old relay goes into `relay.previous`, the pointer of the
// new agent id names the job, and the guard starts the new relay with a clean count. The label
// stays the script's own; the retry's suffixed label is kept as `by`.
export function adoptRelayJob(env, jobDir, { agentId, transcriptPath, promptUuid, label, phase, journalKey }) {
  const job = readJob(jobDir);
  const relay = job.relay ?? {};
  const previous = [
    ...(relay.previous ?? []),
    {
      agentId: relay.agentId ?? null,
      transcriptPath: relay.transcriptPath ?? null,
      promptUuid: relay.promptUuid ?? null,
      label: relay.label ?? null,
      replacedAt: nowIso(),
      by: label ?? null
    }
  ];
  // The worker owns job.json while it lives, so the new binding goes to the job's relay.json,
  // which readJob merges over the binding recorded at creation.
  writeJsonAtomic(jobPaths(jobDir).relay, {
    agentId,
    transcriptPath,
    promptUuid: promptUuid ?? null,
    phase: phase ?? relay.phase ?? null,
    journalKey: journalKey ?? relay.journalKey ?? null,
    previous,
    updatedAt: nowIso()
  });
  writeRelayPointer(env, { agentId, transcriptPath, jobId: job.id, jobDir, startError: null, adoptedFrom: relay.agentId ?? null });
  writeGuardState(env, agentId, jobDir, { consecutiveBlocks: 0, handback: null, lastToolAt: nowIso() });
  return readJob(jobDir);
}

// Guard state (consecutive blocks, the last hand-back): in the job directory when the relay
// has a job, else in its pointer.
function guardFile(env, agentId, jobDir) {
  return jobDir ? path.join(jobDir, "relay-guard.json") : relayPointerPath(env, agentId);
}

export function readGuardState(env, agentId, jobDir) {
  const state = readJsonOrNull(guardFile(env, agentId, jobDir)) ?? {};
  return { consecutiveBlocks: Number(state.consecutiveBlocks) || 0, handback: state.handback ?? null, raw: state };
}

export function writeGuardState(env, agentId, jobDir, patch) {
  const file = guardFile(env, agentId, jobDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readJsonOrNull(file) ?? (jobDir ? {} : { agentId });
  writeJsonAtomic(file, { ...current, ...patch });
}

// ---------------------------------------------------------------------------------------
// Delivery: every received message, once, in order

function ledgerDir(jobDir) {
  return path.join(jobDir, "inbox", "relay");
}

function ledgerPath(jobDir, uuid) {
  return path.join(ledgerDir(jobDir), `${safeName(uuid)}.json`);
}

export function readLedger(jobDir, uuid) {
  return readJsonOrNull(ledgerPath(jobDir, uuid));
}

function writeLedger(jobDir, uuid, record) {
  fs.mkdirSync(ledgerDir(jobDir), { recursive: true });
  writeJsonAtomic(ledgerPath(jobDir, uuid), { uuid, ...record, updatedAt: nowIso() });
}

// One relay hook delivers at a time, under the ownership helper the worker lease also uses
// A live holder is never broken; a hook that cannot take the lock within its
// wait leaves the messages undelivered for the next hook.

function lockPath(jobDir) {
  return path.join(jobDir, "inbox", "relay.lock");
}

export function tryLock(jobDir) {
  const file = lockPath(jobDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return Boolean(acquireOwnership(file));
}

export function unlock(jobDir) {
  releaseOwnership(lockPath(jobDir));
}

function isLedgerClosed(jobDir, ledger) {
  if (ledger?.status === "failed") return true;
  if (ledger?.status !== "done") return false;
  // A wait:false receipt confirms a consumer at posting time. If that consumer died
  // before running the message, the next hook starts another under the original id.
  return !ledger.messageId || hasLiveWorker(jobDir) ||
    !messageAccount(jobDir).undelivered.includes(ledger.messageId);
}

function undeliveredMessages(jobDir, messages) {
  return messages.filter((message) => !isLedgerClosed(jobDir, readLedger(jobDir, message.uuid)));
}

function isCancelText(text) {
  return String(text).trim() === "cancel";
}

let lastIdTime = 0;
function orderedMessageId() {
  // Inbox ids sort by time; ids posted in one batch must sort in the order received.
  let now = Date.now();
  if (now <= lastIdTime) {
    now = lastIdTime + 1;
  }
  lastIdTime = now;
  return `${now.toString(36)}-${newMessageId().split("-")[1]}`;
}

function runCompanionCancel(jobId, env) {
  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, "cancel", jobId], {
    env: absoluteJobsHomeEnv(env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: envNumber(env, "RELAY_CANCEL_TIMEOUT_MS", 60000)
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), error: result.error?.message ?? null, stderr: String(result.stderr ?? "").trim().split(/\r?\n/)[0] };
}

// Deliver, in order, every message whose ledger is still open. Steer while the job
// runs, continue once it has ended. A cancel counts as delivered only once the job is
// terminal; a failed cancel is recorded as a relay-violation and retried at the next
// hook, three tries in all. Returns { busy, undelivered }.
export async function deliverRelayMessages(jobDir, messages, options = {}) {
  try {
    return await deliverRelayMessagesUnderLock(jobDir, messages, options);
  } catch (error) {
    // Starts call delivery directly too. Include setup, lock acquisition and release.
    appendRelayViolation(jobDir, { kind: "delivery", reason: `messages could not be delivered: ${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

async function deliverRelayMessagesUnderLock(jobDir, messages, options) {
  const env = options.env ?? process.env;
  const wait = options.wait ?? true;
  if (undeliveredMessages(jobDir, messages).length === 0) {
    return { busy: false, delivered: [], undelivered: [] };
  }
  const lockWaitMs = options.lockWaitMs ?? envNumber(env, "RELAY_LOCK_WAIT_MS", 45000);
  const deadline = Date.now() + lockWaitMs;
  let locked = tryLock(jobDir);
  while (!locked && Date.now() < deadline) {
    sleepSync(50);
    locked = tryLock(jobDir);
  }
  if (!locked) {
    return { busy: true, delivered: [], undelivered: undeliveredMessages(jobDir, messages) };
  }
  const delivered = [];
  try {
    const jobId = readJob(jobDir)?.id ?? path.basename(jobDir);
    for (const message of messages) {
      const ledger = readLedger(jobDir, message.uuid);
      if (isLedgerClosed(jobDir, ledger)) {
        continue;
      }
      if (ledger?.kind === "cancel" || (!ledger && isCancelText(message.text))) {
        const started = ledger?.tries ?? 0;
        if (started >= 3) {
          writeLedger(jobDir, message.uuid, { ...ledger, status: "failed" });
          appendRelayViolation(jobDir, { kind: "cancel", reason: `cancel ${message.uuid} closed as failed after ${started} tries started; no further command will run` });
          continue;
        }
        const tries = started + 1;
        const record = { ...ledger, kind: "cancel", status: "posting", tries, at: nowIso() };
        writeLedger(jobDir, message.uuid, record);
        // Count a try before launch, so an interrupted hook cannot permit a fourth.
        let cancelled;
        try {
          cancelled = runCompanionCancel(jobId, env);
        } catch (error) {
          cancelled = { status: null, output: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
        }
        const terminal = TERMINAL_STATES.has(readJob(jobDir)?.state);
        const failed = !terminal && tries >= 3;
        const commandFailed = Boolean(cancelled.error) || cancelled.status !== 0;
        if (commandFailed || !terminal) {
          const why = cancelled.error || (cancelled.status !== 0
            ? `exit ${cancelled.status}: ${cancelled.stderr || "no stderr"}`
            : "the job is still nonterminal");
          const next = terminal ? "; the job is terminal; receipt is done"
            : failed ? `; closed as failed after ${tries} tries started` : "; will retry at the next hook";
          appendRelayViolation(jobDir, { kind: "cancel", reason: `cancel ${message.uuid} attempt ${tries} failed: ${why}${next}` });
        }
        writeLedger(jobDir, message.uuid, { ...record, status: terminal ? "done" : failed ? "failed" : "posting",
          exitCode: cancelled.status, output: cancelled.output, error: cancelled.error });
        if (terminal) {
          delivered.push({ uuid: message.uuid, kind: "cancel" });
          continue;
        }
        if (failed) continue;
        break; // Later messages cannot pass a cancellation that is still owed.
      }
      let record = ledger;
      if (!record?.messageId) {
        // A busy job is at work, so the message goes as a steer.
        let terminal = false;
        try { terminal = isTerminalView(loadJobView(jobDir)); }
        catch (error) { if (!(error instanceof JobViewBusy)) throw error; }
        const kind = terminal ? "continue" : "steer";
        record = { kind, messageId: orderedMessageId(), status: "posting", at: nowIso() };
        writeLedger(jobDir, message.uuid, record);
      }
      if (record.status === "done") {
        record = { ...record, status: "posting" };
        writeLedger(jobDir, message.uuid, record);
      }
      if (!messageExists(jobDir, record.messageId)) {
        postInboxMessage(jobDir, { id: record.messageId, kind: record.kind, text: message.text, relayUuid: message.uuid });
      }
      const ackTimeoutMs = envNumber(env, "RELAY_ACK_TIMEOUT_MS", 20000);
      const { outcome, consumer } = await awaitOutcome(jobDir, record.messageId, { env, timeoutMs: ackTimeoutMs, wait });
      if (!consumer) {
        appendRelayViolation(jobDir, { kind: "delivery", reason: `message ${message.uuid} acknowledgement timed out; will retry with message id ${record.messageId}` });
        break;
      }
      writeLedger(jobDir, message.uuid, { ...record, status: "done", postedAt: nowIso(), outcome: outcome?.action ?? null });
      delivered.push({ uuid: message.uuid, kind: record.kind, messageId: record.messageId });
    }
  } finally {
    unlock(jobDir);
  }
  return { busy: false, delivered, undelivered: undeliveredMessages(jobDir, messages) };
}

// Read the relay transcript and deliver what it holds. A transcript that cannot be read,
// or an entry that cannot be understood, is recorded as a relay violation on the job.
export async function syncRelayMessages(input, jobDir, options = {}) {
  const env = options.env ?? process.env;
  const job = readJob(jobDir);
  // The path recorded at start is read first, so every check reads the one file the start read.
  const recorded = job?.relay?.transcriptPath ?? null;
  const { file, candidates } =
    recorded && fs.existsSync(recorded) ? { file: recorded, candidates: [recorded] } : resolveAgentTranscript(input, [recorded]);
  let parsed;
  try {
    parsed = readRelayTranscript(file);
  } catch (error) {
    const why = file ? error.message : `the relay transcript was not found (looked at ${candidates.join(", ") || "no path"})`;
    appendRelayViolation(jobDir, { kind: "transcript", reason: `messages could not be checked: ${why}`, agentId: input.agent_id ?? null });
    return { readable: false, messages: [], busy: false, undelivered: [], delivered: [] };
  }
  for (const problem of parsed.problems) {
    appendRelayViolation(jobDir, { kind: "transcript", reason: `messages could not be checked: ${problem}`, agentId: input.agent_id ?? null });
  }
  try {
    const delivery = await deliverRelayMessages(jobDir, parsed.messages, { env, wait: options.wait ?? true });
    return { readable: true, messages: parsed.messages, ...delivery };
  } catch (error) {
    // Failed delivery leaves work owed: received but not delivered, or delivered but
    // not run. Hand-back and stop wait even on a completed job, within the block budget.
    // A cancel is checked against the job's terminal state and retried at the next
    // hook on failure, three tries in all, with a recorded relay-violation.
    appendRelayViolation(jobDir, { kind: "delivery", reason: `messages could not be delivered: ${error instanceof Error ? error.message : String(error)}`, agentId: input.agent_id ?? null });
    return { readable: true, messages: parsed.messages, busy: false, delivered: [], undelivered: undeliveredMessages(jobDir, parsed.messages) };
  }
}
