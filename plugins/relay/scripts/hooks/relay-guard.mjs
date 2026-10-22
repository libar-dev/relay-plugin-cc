#!/usr/bin/env node
// The relay:job relay hook. Code carries every piece of content; the relay model carries
// none. It acts only inside a relay subagent (agent type relay:job and an agent id).
//
// PreToolUse (Bash, Write, SubagentHandback, StructuredOutput):
//   - first, deliver every message the relay received and that is not delivered yet, in
//     order (steer while a turn runs, continue once the job ended, `cancel` cancels);
//   - Bash: only the companion's start, wait, result, status and cancel. `start --from-relay`
//     is rewritten to carry the relay's transcript path and agent id; wait, result, status
//     and cancel are rewritten to the job the relay started (found by agent id), wait with a
//     540 s timeout and `--exit-zero-while-running` (a timeout on a running job exits 0 with a
//     first line `still running: …`, so the Bash tool does not show it as an error), and with
//     `--wake-after` the boundary this call came after (relayToolBoundary): a wake marker newer
//     than that ends the wait;
//   - SubagentHandback: denied while the job runs or messages are owed, even on a
//     completed job: received but not delivered, or delivered but not run;
//     when allowed, its message is rewritten to exactly what `result <job>` prints (or, when
//     the start failed, to the start error);
//   - StructuredOutput (added by the Workflow harness under `schema`): denied with the schema
//     sentence;
//   - anything else is denied with a reason that restates the relay's job.
// SubagentStop:
//   - deliver as above; a hand-back exempts the stop only while the readable transcript
//     shows no new inbound message and the relay has not acted since;
//   - otherwise block while the job runs, a message is
//     owed, even on a completed job, or the final message differs from `result <job>`.
//     Owed means received but not delivered, or delivered but not run. For a string-return
//     relay (under the Workflow tool) that is `result <job> --state-only`: the state block,
//     no report, and `wait` and `result` are rewritten with `--state-only` too. Its retyped
//     block may leave out lines that restate the request (see matchesStateBlock).
// The guard counts its own consecutive blocks per relay. After eight, it lets the relay go
// and records a relay violation that `result` and `status` print.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { appendRelayHandback, appendRelayViolation } from "../lib/jobs/messages.mjs";
import { absoluteJobsHomeEnv, JOBS_HOME_ENV, nowIso, readJob } from "../lib/jobs/store.mjs";
import { isTerminalView, JobViewBusy, loadJobViewSettled, OUTCOME_KEYS, renderJobBlock, renderResultText } from "../lib/jobs/view.mjs";

// A view of the job, or, while its record keeps changing, a marker that it is busy: not a state,
// and never terminal, so the relay waits.
/** @returns {any} a job view, or { busy, state: null, undelivered: [] } */
function jobViewOrBusy(jobDir) {
  try { return loadJobViewSettled(jobDir); }
  catch (error) { if (error instanceof JobViewBusy) return { busy: error.message, state: null, undelivered: [] }; throw error; }
}
import {
  findRelayJob,
  isRelayInput,
  readGuardState,
  readRelayPointer,
  RELAY_BASH_TIMEOUT_MS,
  RELAY_BLOCK_BUDGET,
  RELAY_WAIT_SECONDS,
  resolveAgentTranscript,
  syncRelayMessages,
  writeGuardState
} from "../lib/harness/relay.mjs";
import { SCHEMA_SENTENCE } from "../lib/harness/workflow.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "../..");
const COMPANION = path.join(SCRIPT_DIR, "..", "companion.mjs");
const SUBCOMMANDS = new Set(["start", "wait", "result", "status", "cancel"]);
const JOB_ID = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SHOWN = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs"';

function trimEnd(text) {
  return String(text ?? "").replace(/\s+$/, "");
}

function withoutOuterFence(text, expected) {
  // A relay may fence the result; only its outer envelope may differ.
  if (/^(?:[ \t]*\r?\n)*`{3,}/.test(String(expected ?? ""))) return text;
  const fenced = /^(?:[ \t]*\r?\n)*(`{3,})[A-Za-z0-9_+.-]*[ \t]*\r?\n([\s\S]*?)\r?\n\1$/.exec(trimEnd(text));
  return fenced ? fenced[2] : text;
}

// A string-return relay retypes the state block, and a small model drops a line that only restates
// the request, most often its own `relay:` line. Its text passes when every line it holds is a line
// of the block and no outcome line is missing. A line added or changed still fails, and so does a
// missing state, error or undelivered line. Blank lines and code fences are not counted.
export function matchesStateBlock(text, expected) {
  const lines = (value) => String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("```"));
  const remaining = lines(expected);
  for (const line of lines(text)) {
    const index = remaining.indexOf(line);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.every((line) => !OUTCOME_KEYS.has(line.slice(0, line.indexOf(":"))));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------------------
// Commands the relay may run

function splitCommand(command) {
  // Plain words, double-quoted words and the literal ${CLAUDE_PLUGIN_ROOT}; no other shell.
  if (/[;&|`<>\n\r\\]|\$\(|\$(?!\{CLAUDE_PLUGIN_ROOT\})/.test(command)) {
    return null;
  }
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

export function parseCompanionCommand(command) {
  const tokens = splitCommand(String(command ?? "").trim());
  if (!tokens || tokens.length < 3 || tokens[0] !== "node") {
    return null;
  }
  const script = tokens[1].replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
  if (path.resolve(script) !== COMPANION) {
    return null;
  }
  const subcommand = tokens[2];
  if (!SUBCOMMANDS.has(subcommand)) {
    return null;
  }
  const args = tokens.slice(3);
  const parsed = { subcommand, jobId: null, fromRelay: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (subcommand === "start") {
      if (arg === "--from-relay" && !parsed.fromRelay) {
        parsed.fromRelay = true;
        continue;
      }
      return null;
    }
    if (arg === "--timeout-seconds" && /^\d+$/.test(next ?? "")) {
      index += 1;
    } else if (arg === "--json" || arg === "--all") {
      // harmless; the rewrite drops them
    } else if (!arg.startsWith("-") && JOB_ID.test(arg) && !parsed.jobId) {
      parsed.jobId = arg;
    } else {
      return null;
    }
  }
  if (subcommand === "start" && !parsed.fromRelay) {
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------
// Outputs

const JOB_REMINDER =
  "You are the relay:job relay. Your only job: run start --from-relay once, then wait until the job ends, then hand back. Hooks pass on the prompt, every message and the report; you never write them.";

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function allow(reason, updatedInput = null) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
      ...(updatedInput ? { updatedInput } : {})
    }
  };
}

function waitCommandShown(jobId) {
  return `${SHOWN} wait ${jobId} --timeout-seconds ${RELAY_WAIT_SECONDS}`;
}

// A block the guard counts. After RELAY_BLOCK_BUDGET consecutive blocks the relay may go,
// and a violation is recorded where `result` and `status` print it.
function countBlock(env, agentId, jobDir, kind, reason) {
  const guard = readGuardState(env, agentId, jobDir);
  if (guard.consecutiveBlocks >= RELAY_BLOCK_BUDGET) {
    writeGuardState(env, agentId, jobDir, { consecutiveBlocks: 0 });
    const violation = { kind, reason: `the relay was let go after ${RELAY_BLOCK_BUDGET} blocks: ${reason}`, agentId };
    if (jobDir) {
      appendRelayViolation(jobDir, violation);
    } else {
      const pointer = readRelayPointer(env, agentId);
      writeGuardState(env, agentId, null, { violations: [...(pointer.violations ?? []), { at: new Date().toISOString(), ...violation }] });
    }
    return { release: true };
  }
  writeGuardState(env, agentId, jobDir, { consecutiveBlocks: guard.consecutiveBlocks + 1 });
  return { release: false };
}

function resetBlocks(env, agentId, jobDir) {
  if (readGuardState(env, agentId, jobDir).consecutiveBlocks !== 0) {
    writeGuardState(env, agentId, jobDir, { consecutiveBlocks: 0 });
  }
}

// ---------------------------------------------------------------------------------------
// A start the relay did not make

// A small model can take a line of the brief ("run no commands") as its own instruction and
// never start the job. The relay's first other call, its hand-back or its stop starts the job
// from here instead, exactly as its own `start --from-relay` would, and the relay goes on to
// wait on it. A start that fails leaves its error on the relay's pointer, as the relay's would.
function startForRelay(input, env) {
  const { file, candidates } = resolveAgentTranscript(input);
  spawnSync(process.execPath, [COMPANION, "start", "--from-relay", "--relay-transcript", file ?? candidates[0] ?? "", "--relay-agent", input.agent_id ?? ""], {
    cwd: input.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd(),
    env: absoluteJobsHomeEnv(env),
    stdio: "ignore",
    timeout: 60000
  });
  return { jobDir: findRelayJob(env, input.agent_id), pointer: readRelayPointer(env, input.agent_id) };
}

function startedForYou(jobDir) {
  return `The hook started job ${readJobId(jobDir)} for you: the brief is the job's, and its words do not bind you. Run: ${waitCommandShown(readJobId(jobDir))}`;
}

// ---------------------------------------------------------------------------------------
// PreToolUse

// The rewritten command binds the jobs home this hook resolved, so it reaches the relay's
// job even when the command runs in another directory.
function rewriteBash(env, toolInput, args, extra = {}) {
  return { ...toolInput, command: `${JOBS_HOME_ENV}=${shellQuote(absoluteJobsHomeEnv(env)[JOBS_HOME_ENV])} node ${shellQuote(COMPANION)} ${args.join(" ")}`, ...extra };
}

function handleBash(input, env, jobDir, pointer, wakeAfter) {
  const toolInput = input.tool_input ?? {};
  const parsed = parseCompanionCommand(toolInput.command);
  if (!parsed) {
    if (!jobDir && !pointer.startError) {
      const started = startForRelay(input, env);
      if (started.jobDir) return deny(`${JOB_REMINDER} This Bash command is not part of it. ${startedForYou(started.jobDir)}`);
    }
    return deny(`${JOB_REMINDER} This Bash command is not part of it. Run exactly: ${jobDir ? waitCommandShown(readJobId(jobDir)) : `${SHOWN} start --from-relay`}`);
  }
  if (parsed.subcommand === "start") {
    if (jobDir) {
      return deny(`You already started job ${readJobId(jobDir)}. Do not start another. Run: ${waitCommandShown(readJobId(jobDir))}`);
    }
    if (pointer.startError) {
      return deny("The start failed and cannot be repaired by starting again. Hand back now; the hook hands back the start error.");
    }
    const { file, candidates } = resolveAgentTranscript(input);
    const transcript = file ?? candidates[0] ?? "";
    return allow(
      "relay:job relay start: the companion reads the prompt from the relay transcript.",
      rewriteBash(env, toolInput, ["start", "--from-relay", "--relay-transcript", shellQuote(transcript), "--relay-agent", shellQuote(input.agent_id ?? "")])
    );
  }
  if (!jobDir) {
    const started = pointer.startError ? { jobDir: null, pointer } : startForRelay(input, env);
    if (started.jobDir) return deny(startedForYou(started.jobDir));
    return deny("The start failed. Hand back now; the hook hands back the start error.");
  }
  const jobId = readJobId(jobDir);
  // A wait on a job that has not ended is progress. A result between two tries at the final
  // message is not, so those blocks keep counting toward the budget.
  if (parsed.subcommand === "wait" && !isTerminalView(jobViewOrBusy(jobDir))) {
    resetBlocks(env, input.agent_id, jobDir);
  }
  const stateOnly = isStringReturn(jobDir) ? ["--state-only"] : [];
  if (parsed.subcommand === "wait") {
    return allow(
      "relay:job relay wait on its own job.",
      rewriteBash(env, toolInput, ["wait", shellQuote(jobId), "--auto-resume", "--exit-zero-while-running", "--timeout-seconds", String(RELAY_WAIT_SECONDS), "--wake-after", shellQuote(wakeAfter), ...stateOnly], { timeout: RELAY_BASH_TIMEOUT_MS })
    );
  }
  if (parsed.subcommand === "result") {
    return allow("relay:job relay result on its own job.", rewriteBash(env, toolInput, ["result", shellQuote(jobId), ...stateOnly]));
  }
  return allow(`relay:job relay ${parsed.subcommand} on its own job.`, rewriteBash(env, toolInput, [parsed.subcommand, shellQuote(jobId)]));
}

// A string-return relay (a workflow subagent) has no SubagentHandback: its final text is the
// return value. It sees and returns the state block only; the report stays in `report:`.
function isStringReturn(jobDir) {
  return Boolean(jobDir && readJob(jobDir)?.relay?.stringReturn);
}

function recordHandback(jobDir, agentId, view) {
  appendRelayHandback(jobDir, { agentId, attempts: Array.isArray(view.job.attempts) ? view.job.attempts.length : 0, state: view.state });
}

function readJobId(jobDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8")).id ?? path.basename(jobDir);
  } catch {
    return path.basename(jobDir);
  }
}

function handleHandback(input, env, jobDir, pointer, sync) {
  const toolInput = input.tool_input ?? {};
  const agentId = input.agent_id;
  const rewrite = (text, reason) => {
    writeGuardState(env, agentId, jobDir, {
      consecutiveBlocks: 0,
      handback: { at: new Date().toISOString(), messageUuids: (sync?.messages ?? []).map((message) => message.uuid), receivedUuids: sync?.received ?? [] }
    });
    return allow(reason, { ...toolInput, message: text });
  };
  if (!jobDir) {
    const started = pointer.startError ? { jobDir: null, pointer } : startForRelay(input, env);
    if (started.jobDir) return deny(startedForYou(started.jobDir));
    if (started.pointer.startError) {
      return rewrite(started.pointer.startError, "relay:job relay hands back the start error.");
    }
    const reason = `You have not started the job. Run: ${SHOWN} start --from-relay`;
    if (countBlock(env, agentId, null, "no-job", reason).release) {
      return rewrite("state: not started\nerror: the relay handed back without starting the job\n", "relay:job relay let go without a job (recorded).");
    }
    return deny(reason);
  }
  const jobId = readJobId(jobDir);
  const problems = [];
  if (sync?.busy) {
    problems.push("Messages for the job are being delivered right now.");
  } else if (sync?.undelivered?.length > 0) {
    problems.push(`${sync.undelivered.length} message(s) are owed to the job: received but not delivered.`);
  }
  const view = jobViewOrBusy(jobDir);
  if (view.busy) {
    problems.push(view.busy);
  } else if (!isTerminalView(view)) {
    problems.push(`Job ${jobId} is still ${view.state}.`);
  }
  if (view.undelivered.length > 0) {
    problems.push(`${view.undelivered.length} message(s) are owed to the job: acknowledged but not run yet.`);
  }
  if (problems.length > 0) {
    const reason = `${problems.join(" ")} Do not hand back yet. Run: ${waitCommandShown(jobId)}`;
    if (!countBlock(env, agentId, jobDir, "handback-blocked", reason).release) {
      return deny(reason);
    }
  }
  // Read again: a release above recorded its relay-violation, which the result shows. A busy job
  // is never released with a result it does not have.
  const result = jobViewOrBusy(jobDir);
  if (result.busy) return deny(`${result.busy} Run: ${waitCommandShown(jobId)}`);
  recordHandback(jobDir, agentId, result);
  return rewrite(renderResultText(result), "relay:job relay hand-back, rewritten to the job's result.");
}

async function handlePreToolUse(input, env = process.env) {
  const agentId = input.agent_id;
  const pointer = agentId ? readRelayPointer(env, agentId) : {};
  const jobDir = findRelayJob(env, agentId);
  const sync = jobDir ? await syncRelayMessages(input, jobDir, { env, wait: true }) : null;
  if (input.tool_name !== "SubagentHandback" && agentId) {
    // The relay acted: a later stop without a new hand-back is checked in full.
    writeGuardState(env, agentId, jobDir, { lastToolAt: new Date().toISOString() });
  }
  switch (input.tool_name) {
    case "Bash":
      return handleBash(input, env, jobDir, pointer, sync?.wakeAfter ?? nowIso());
    case "SubagentHandback":
      return handleHandback(input, env, jobDir, pointer, sync);
    case "StructuredOutput":
      // The harness adds this tool when a script passes `schema`. Not a counted block: the
      // relay may hand back the start error, which carries the same sentence.
      return deny(SCHEMA_SENTENCE);
    default:
      return deny(`${JOB_REMINDER} The ${input.tool_name} tool is not part of it.`);
  }
}

// ---------------------------------------------------------------------------------------
// SubagentStop

async function handleSubagentStop(input, env = process.env) {
  const agentId = input.agent_id;
  let pointer = agentId ? readRelayPointer(env, agentId) : {};
  let jobDir = findRelayJob(env, agentId);
  if (!jobDir && agentId && !pointer.startError) {
    const started = startForRelay(input, env);
    if (started.jobDir) return { decision: "block", reason: startedForYou(started.jobDir) };
    ({ jobDir, pointer } = started);
  }
  const sync = jobDir ? await syncRelayMessages(input, jobDir, { env, wait: true }) : null;
  const guard = readGuardState(env, agentId, jobDir);
  const lastToolAt = guard.raw.lastToolAt ?? "";
  const current = jobDir ? jobViewOrBusy(jobDir) : null;
  if (guard.handback && lastToolAt <= guard.handback.at &&
      (!jobDir || (sync.readable && (guard.handback.receivedUuids
        ? sync.received.every((uuid) => guard.handback.receivedUuids.includes(uuid))
        : sync.messages.every((message) => guard.handback.messageUuids.includes(message.uuid))))) &&
      !sync?.busy && !sync?.undelivered?.length &&
      (!current || (isTerminalView(current) && current.undelivered.length === 0))) {
    // The report already went out through SubagentHandback, rewritten by the hook, and the
    // relay has neither acted nor received a message since. A resumed relay must
    // return the current result or hand back again for the hook to rewrite it.
    return null;
  }
  const problems = [];
  let expected = null;
  let done = null;
  let stateBlock = false;
  if (!jobDir) {
    if (pointer.startError) {
      expected = pointer.startError;
    } else {
      problems.push({ kind: "no-job", reason: `You never started the job. Run: ${SHOWN} start --from-relay` });
    }
  } else {
    const jobId = readJobId(jobDir);
    const view = current;
    if (view.busy) {
      problems.push({ kind: "running", reason: `${view.busy} Do not stop. Run: ${waitCommandShown(jobId)}` });
    } else if (!isTerminalView(view)) {
      problems.push({ kind: "running", reason: `Job ${jobId} is still ${view.state}. Do not stop. Run: ${waitCommandShown(jobId)}` });
    }
    if (sync?.busy || sync?.undelivered?.length > 0 || view.undelivered.length > 0) {
      problems.push({ kind: "undelivered", reason: `Messages are owed to the job: received but not delivered, or delivered but not run. Do not stop, even on a completed job. Run: ${waitCommandShown(jobId)}` });
    }
    if (problems.length === 0) {
      done = jobViewOrBusy(jobDir);
      if (done.busy) problems.push({ kind: "running", reason: `${done.busy} Do not stop. Run: ${waitCommandShown(jobId)}` });
      else if (isStringReturn(jobDir)) { expected = renderJobBlock(done); stateBlock = true; }
      else expected = renderResultText(done);
    }
  }
  const matches = stateBlock ? matchesStateBlock(input.last_assistant_message, expected) : trimEnd(withoutOuterFence(input.last_assistant_message, expected)) === trimEnd(expected);
  if (expected != null && !matches) {
    problems.push({
      kind: "final-message",
      reason: `Your final message must be exactly the job's result, with nothing added or removed. Reply with exactly this text and nothing else${stateBlock ? "" : ", with no code fence around it"}:\n${expected}`
    });
  }
  if (problems.length === 0) {
    if (jobDir && done && !done.busy) recordHandback(jobDir, agentId, done);
    resetBlocks(env, agentId, jobDir);
    return null;
  }
  const reason = problems.map((problem) => problem.reason).join("\n\n");
  if (countBlock(env, agentId, jobDir, problems.map((problem) => problem.kind).join(", "), reason).release) {
    return null;
  }
  return { decision: "block", reason };
}

export async function handleRelayHook(input, env = process.env) {
  if (!isRelayInput(input, env)) {
    return null;
  }
  if (input.hook_event_name === "PreToolUse") {
    return handlePreToolUse(input, env);
  }
  if (input.hook_event_name === "SubagentStop") {
    return handleSubagentStop(input, env);
  }
  return null;
}

async function main() {
  const raw = fs.readFileSync(0, "utf8");
  // Fast exit for every hook call outside a relay subagent.
  if (!raw.includes('"agent_type"') || !(raw.includes('"agent_id"') || raw.includes('"agent_transcript_path"'))) {
    return;
  }
  const output = await handleRelayHook(JSON.parse(raw), process.env);
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Fail open: a broken hook must never trap the relay or any other agent.
    process.stderr.write(`relay guard: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(0);
  });
}
