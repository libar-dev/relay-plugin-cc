#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readRelayPointer } from "../lib/harness/relay.mjs";
import { absoluteJobsHomeEnv, readJob, TERMINAL_STATES } from "../lib/jobs/store.mjs";
import { appendRelayViolation } from "../lib/jobs/messages.mjs";

const COMPANION = fileURLToPath(new URL("../companion.mjs", import.meta.url));
const oneLine = value => String(value ?? "").replace(/\s+/g, " ").trim();
const nonempty = value => typeof value === "string" && value.trim();

export function handleTaskStop(input, env = process.env) {
  if (input?.hook_event_name !== "PostToolUse" || input.tool_name !== "TaskStop") return null;
  let response = input.tool_response;
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { response = null; }
  }
  const agentId = [response?.task_id, input.tool_input?.task_id, input.tool_input?.shell_id].find(nonempty);
  if (!agentId) return null;
  const { jobDir } = readRelayPointer(env, agentId);
  if (!jobDir) return null;
  const job = readJob(jobDir);
  if (!job || job.relay?.agentId !== agentId) return null;
  let context;
  if (TERMINAL_STATES.has(job.state)) {
    context = `TaskStop stopped the relay:job agent ${agentId}. Its job ${job.id} had already ended (${job.state}); nothing was cancelled.`;
  } else {
    const cwd = typeof input.cwd === "string" && fs.existsSync(input.cwd) && fs.statSync(input.cwd).isDirectory() ? input.cwd : process.cwd();
    let result;
    try {
      result = spawnSync(process.execPath, [COMPANION, "cancel", jobDir], {
        cwd, env: absoluteJobsHomeEnv(env), encoding: "utf8", timeout: 55000
      });
    } catch (error) {
      result = { error };
    }
    if (result.status === 0 && !result.error && !result.signal) {
      context = `TaskStop stopped the relay:job agent ${agentId}, and the relay hook cancelled its job ${job.id}:\n${result.stdout}`;
    } else if (result.status === 4 && !result.error && !result.signal) {
      const reason = `TaskStop stopped the relay, and the cancel had not ended the job: ${oneLine(result.stderr)}`;
      appendRelayViolation(jobDir, { kind: "cancel", reason, agentId });
      context = `TaskStop stopped the relay:job agent ${agentId}. The relay hook asked its job ${job.id} to cancel, and the job has not ended yet:\n${result.stdout}${result.stderr}\nCheck it with: node "${COMPANION}" status ${job.id}`;
    } else {
      const reason = oneLine(result.error?.message || result.stderr || (result.signal ? `cancel ended on signal ${result.signal}` : `cancel exited ${result.status}`));
      appendRelayViolation(jobDir, { kind: "cancel", reason: `TaskStop stopped the relay, and the cancel failed: ${reason}`, agentId });
      context = `TaskStop stopped the relay:job agent ${agentId}, and the relay hook could not cancel its job ${job.id}: ${reason}. The job may still be running. Cancel it with: node "${COMPANION}" cancel ${job.id}`;
    }
  }
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
}

async function main() {
  const raw = fs.readFileSync(0, "utf8");
  if (!raw.includes('"TaskStop"')) return;
  const output = handleTaskStop(JSON.parse(raw));
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // A broken hook must never fail the TaskStop that already stopped the relay.
    process.stderr.write(`relay stop: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(0);
  });
}
