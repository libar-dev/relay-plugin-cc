// A relay subagent, simulated: a transcript that grows like a real one (entries cut from two
// real relay:job relay transcripts, and invented entries in the shapes of a real workflow
// subagent transcript), the hook inputs Claude Code sends, and the fake Codex backend behind
// the companion.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "../fakes/codex.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { handleRelayHook } from "../../plugins/relay/scripts/hooks/relay-guard.mjs";
import { readJob } from "../../plugins/relay/scripts/lib/jobs/store.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "relay");
export const HOOK = path.join(PLUGIN_ROOT, "scripts", "hooks/relay-guard.mjs");
export const COMPANION = path.join(PLUGIN_ROOT, "scripts", "companion.mjs");
export const RELAY_CMD = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs"';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "relay-transcript-entries.json"), "utf8")).entries;

const WORKFLOW_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "relay-transcript-workflow-entries.json"), "utf8")).entries;

const PEER_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "relay-transcript-peer-entries.json"), "utf8")).entries;

const HUMAN_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "relay-transcript-human-entries.json"), "utf8")).entries;

export function humanEntry(name) {
  return structuredClone(HUMAN_FIXTURE[name].entry);
}

export function realEntry(name) {
  return structuredClone(FIXTURE[name].entry);
}

// A real entry of a message from another agent of the session (Claude Code 2.1.308).
export function peerEntry(name) {
  return structuredClone(PEER_FIXTURE[name].entry);
}

// An entry in the shape of a real workflow subagent transcript; every text is invented.
export function workflowEntry(name) {
  return structuredClone(WORKFLOW_FIXTURE[name].entry);
}

function fresh(name, agentId, patch, source = realEntry) {
  const entry = source(name);
  entry.uuid = randomUUID();
  entry.agentId = agentId;
  patch(entry);
  return entry;
}

// Every job a test started is stopped when its file ends, also when a test failed half way:
// no worker or fake app-server outlives the suite.
const homes = new Set();

function killTree(pid) {
  // Only a process that is still one of ours: a finished job's pid may belong to anything now.
  const command = run("ps", ["-o", "command=", "-p", String(pid)]).stdout ?? "";
  if (!/companion\.mjs worker|codex app-server/.test(command)) {
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

after(() => {
  for (const home of homes) {
    for (const file of walkJobFiles(home)) {
      try {
        const job = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const entry of [job.worker, job.server, ...(job.workers ?? [])]) {
          if (entry?.pid) {
            killTree(entry.pid);
          }
        }
      } catch {
        // a job file being written; its worker is in another record
      }
    }
  }
});

function walkJobFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJobFiles(full));
    } else if (entry.name === "job.json") {
      out.push(full);
    }
  }
  return out;
}

// `options.from` makes a sibling relay of an earlier context: the same fake backend, jobs
// home, work directory and Claude session, a fresh agent id, its own transcript (under
// `options.workflow`, which may name another run) and its own meta label (`options.label`).
// That is the shape of a relay the Workflow harness re-spawned.
export function relayContext(behavior = "job", options = {}) {
  const from = options.from ?? null;
  const binDir = from ? from.binDir : makeTempDir();
  if (!from) {
    installFakeCodex(binDir, behavior, { turnMs: options.turnMs ?? 1500 });
  }
  const home = from ? from.home : makeTempDir("relay-jobs-relay-");
  homes.add(home);
  const work = from ? from.work : makeTempDir("relay-work-relay-");
  const projects = from ? from.projects : makeTempDir("claude-projects-");
  // Its own HOME: a default home (`grok-home: default`, `~/.codex`) resolves under it, never
  // under the real one.
  const user = from ? from.user : makeTempDir("relay-user-");
  const sessionId = from ? from.sessionId : randomUUID();
  const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const mainTranscript = path.join(projects, `${sessionId}.jsonl`);
  if (!from) {
    fs.writeFileSync(mainTranscript, "");
  }
  // A relay the Agent tool spawns writes <session>/subagents/agent-<id>.jsonl. A workflow
  // subagent writes <session>/subagents/workflows/<run>/agent-<id>.jsonl, with its meta file
  // beside it, while the hook input still names the shallow path, which does not exist.
  const shallow = path.join(projects, sessionId, "subagents", `agent-${agentId}.jsonl`);
  const transcript = options.workflow ? path.join(projects, sessionId, "subagents", "workflows", options.workflow, `agent-${agentId}.jsonl`) : shallow;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  if (options.workflow) {
    fs.writeFileSync(path.join(path.dirname(transcript), `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "relay:job", description: options.label ?? "relay-test", workflowPhase: "Test" }));
    // The run's journal, as the harness writes it: one `started` line per spawn, with the call's
    // key. `options.journalKey` names the key; without it, no line is written for this relay.
    const journal = path.join(path.dirname(transcript), "journal.jsonl");
    if (!fs.existsSync(journal)) {
      fs.writeFileSync(journal, `${JSON.stringify({ type: "launched" })}\n`);
    }
    if (options.journalKey) {
      fs.appendFileSync(journal, `${JSON.stringify({ type: "started", key: options.journalKey, agentId, label: options.label ?? "relay-test", phase: "Test" })}\n`);
    }
  }
  const env = from
    ? { ...from.env, ...(options.env ?? {}) }
    : {
        ...buildEnv(binDir),
        HOME: user,
        USERPROFILE: user,
        RELAY_JOBS_HOME: home,
        RELAY_JOBS_POLL_MS: "50",
        RELAY_JOBS_WAIT_POLL_MS: "50",
        RELAY_JOBS_HEARTBEAT_MS: "200",
        RELAY_JOBS_CANCEL_GRACE_MS: "3000",
        RELAY_ACK_TIMEOUT_MS: "10000",
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        ...(options.env ?? {})
      };
  const base = { tool_use_id: randomUUID(), session_id: sessionId, transcript_path: mainTranscript, cwd: work, agent_id: agentId, agent_type: "relay:job", permission_mode: "auto" };
  if (options.workflow) {
    base.agent_transcript_path = shallow;
  }
  const fakeState = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    } catch {
      return {};
    }
  };
  const ctx = {
    binDir,
    home,
    work,
    projects,
    user,
    sessionId,
    env,
    base,
    agentId,
    transcript,
    shallow,
    workflow: options.workflow ?? null,
    fakeState,
    append(...entries) {
      fs.appendFileSync(transcript, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      return entries;
    },
    // Entries in the shapes the real transcripts use.
    prompt(text) {
      return fresh("prompt", agentId, (entry) => {
        entry.message.content = text;
      });
    },
    systemReminder() {
      return fresh("systemReminder", agentId, () => {});
    },
    queued(text) {
      return fresh("queuedDuringRun", agentId, (entry) => {
        entry.attachment.prompt = text;
      });
    },
    afterHandback(text) {
      return fresh("messageAfterHandback", agentId, (entry) => {
        entry.message.content = `The coordinator sent a message while you were working:\n${text}\n\nAddress this before completing your current task.`;
      });
    },
    // A message from another agent: the harness wraps it, and keeps the text in origin.body.
    peerQueued(text, from = "a0peer") {
      return fresh("peerQueuedDuringRun", agentId, (entry) => {
        entry.attachment.prompt = `<agent-message from="${from}">\n${text}\n</agent-message>`;
        entry.attachment.origin = { ...entry.attachment.origin, from, senderTaskId: from, name: from, body: text };
      }, peerEntry);
    },
    peerAfterHandback(text, from = "a0peer") {
      return fresh("peerAfterHandback", agentId, (entry) => {
        entry.message.content = entry.message.content.replace(/<agent-message from="[^"]*">\n[\s\S]*?\n<\/agent-message>/, `<agent-message from="${from}">\n${text}\n</agent-message>`);
        entry.origin = { ...entry.origin, from, senderTaskId: from, name: from, body: text };
      }, peerEntry);
    },
    humanQueued(text) {
      return fresh("humanQueuedDuringRun", agentId, (entry) => {
        entry.attachment.prompt = text;
      }, humanEntry);
    },
    humanAfterHandback(text) {
      return fresh("humanAfterHandback", agentId, (entry) => {
        entry.message.content = entry.message.content.replace("typed two: after the hand-back", () => text);
      }, humanEntry);
    },
    interrupted() {
      return ["interruptToolResult", "interruptNote", "humanAfterInterrupt"].map((name) =>
        fresh(name, agentId, () => {}, humanEntry));
    },
    userTurn(text) {
      return { parentUuid: null, isSidechain: true, agentId, type: "user", message: { role: "user", content: text }, uuid: randomUUID(), timestamp: new Date().toISOString() };
    },
    toolUse(command, toolUseId = randomUUID(), messageId = randomUUID()) {
      base.tool_use_id = toolUseId;
      return fresh("bashToolUse", agentId, (entry) => {
        entry.message.id = messageId;
        entry.message.content[0].id = toolUseId;
        entry.message.content[0].input = { command };
      });
    },
    // The Workflow harness's entries, from the invented workflow fixture.
    // The fixture's `cd: /invented/scratch` does not exist; a job runs in this context's work
    // directory instead. Every other byte of the entry stays.
    workflowPrompt(name = "computedTask", brief = null) {
      return fresh(
        name,
        agentId,
        (entry) => {
          let text = entry.message.content.replace("\n  cd: /invented/scratch\n", `\n  cd: ${work}\n`);
          if (brief != null) {
            // Everything after the indented `---` line is the brief; the harness indents each line.
            const cut = text.indexOf("\n  ---\n") + "\n  ---\n".length;
            text = `${text.slice(0, cut)}${`${brief}\n`.split("\n").map((line) => `  ${line}`).join("\n")}`;
          }
          entry.message.content = text;
        },
        workflowEntry
      );
    },
    userRequest() {
      return fresh("userRequest", agentId, () => {}, workflowEntry);
    },
    environment() {
      return fresh("environment", agentId, () => {}, workflowEntry);
    },
    snapshot(kind = "string") {
      return fresh(kind === "schema" ? "promptSnapshotSchema" : "promptSnapshotString", agentId, () => {}, workflowEntry);
    }
  };
  return ctx;
}

export function hookInput(ctx, event, extra = {}) {
  return { ...ctx.base, hook_event_name: event, ...extra };
}

export function pre(ctx, tool_name, tool_input) {
  return handleRelayHook(hookInput(ctx, "PreToolUse", { tool_name, tool_input }), ctx.env);
}

export function stop(ctx, last_assistant_message, extra = {}) {
  return handleRelayHook(
    hookInput(ctx, "SubagentStop", { last_assistant_message, stop_hook_active: false, agent_transcript_path: ctx.base.agent_transcript_path ?? ctx.transcript, ...extra }),
    ctx.env
  );
}

export function decision(output) {
  return output?.hookSpecificOutput?.permissionDecision ?? null;
}

export function updated(output) {
  return output?.hookSpecificOutput?.updatedInput ?? null;
}

export function reason(output) {
  return output?.hookSpecificOutput?.permissionDecisionReason ?? output?.reason ?? "";
}

// Run a Bash tool input the way Claude Code would after the hook: the (rewritten) command.
export function runBash(ctx, toolInput) {
  return run("bash", ["-c", toolInput.command], { cwd: ctx.work, env: ctx.env });
}

export function companion(ctx, args) {
  return run("node", [COMPANION, ...args], { cwd: ctx.work, env: ctx.env });
}

// The relay's start: the hook rewrites `start --from-relay`, then the command runs.
export async function relayStart(ctx) {
  const output = await pre(ctx, "Bash", { command: `${RELAY_CMD} start --from-relay`, description: "Start the job" });
  const started = runBash(ctx, updated(output) ?? { command: "false" });
  const jobId = /^job: (\S+)$/m.exec(started.stdout)?.[1] ?? null;
  return { output, started, jobId };
}

export function jobDirOf(ctx, jobId) {
  for (const slug of fs.readdirSync(ctx.home)) {
    const dir = path.join(ctx.home, slug, jobId);
    if (fs.existsSync(path.join(dir, "job.json"))) {
      return dir;
    }
  }
  throw new Error(`no job dir for ${jobId}`);
}

// The job as every reader sees it: job.json with the job's current relay binding merged in.
export function readJobJson(ctx, jobId) {
  return readJob(jobDirOf(ctx, jobId));
}

export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let value = null;
    try {
      value = await predicate();
    } catch {
      value = null;
    }
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

// The hook as Claude Code runs it: a process, hook input on stdin, JSON on stdout.
export function runHookProcess(ctx, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { cwd: ctx.work, env: ctx.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      let json = null;
      try {
        json = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({ status, stdout, stderr, json });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// Every text Codex received: each turn's prompt and each accepted steer.
export function codexReceived(ctx) {
  const state = ctx.fakeState();
  return {
    turns: (state.turnStarts ?? []).map((turn) => turn.prompt),
    steers: (state.steers ?? []).filter((steer) => steer.accepted).map((steer) => steer.text)
  };
}
