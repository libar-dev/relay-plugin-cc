#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readRelayPointer, resolveAgentTranscript } from "../lib/harness/relay.mjs";
import { readWorkflowRunId } from "../lib/harness/workflow.mjs";
import { absoluteJobsHomeEnv, listJobDirs, readJob, TERMINAL_STATES } from "../lib/jobs/store.mjs";
import { appendRelayHandback, appendRelayViolation } from "../lib/jobs/messages.mjs";

const COMPANION = fileURLToPath(new URL("../companion.mjs", import.meta.url));
const oneLine = value => String(value ?? "").replace(/\s+/g, " ").trim();
const nonempty = value => typeof value === "string" && value.trim();

// How long the cancel may take: the bound /relay:cancel uses. Cancel waits up to the grace for the
// worker, and a delegated cancel waits it again; the rest is the process sweep and the busy-view
// retries. The grace is read as the companion's envNumber reads it, and the hook's own timeout in
// hooks.json (600 s) stays above the largest bound.
function cancelTimeoutMs(env) {
  const raw = env.RELAY_JOBS_CANCEL_GRACE_MS;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  const grace = Number.isFinite(value) && value >= 0 ? value : 10000;
  return Math.min(590000, 2 * grace + 40000);
}
const hookOutput = context => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } });

export function handleTaskStop(input, env = process.env) {
  if (input?.hook_event_name !== "PostToolUse" || input.tool_name !== "TaskStop") return null;
  let response = input.tool_response;
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { response = null; }
  }
  const agentId = [response?.task_id, input.tool_input?.task_id, input.tool_input?.shell_id].find(nonempty);
  if (!agentId) return null;
  const { jobDir } = readRelayPointer(env, agentId);
  if (!jobDir) {
    if (response?.task_type !== "local_workflow") return null;
    const callerTranscript = input.agent_id ? resolveAgentTranscript(input).file : input.agent_transcript_path;
    const runId = readWorkflowRunId(callerTranscript, agentId) ?? readWorkflowRunId(input.transcript_path, agentId);
    if (!runId) return null;
    const jobs = listJobDirs({ env }).map(dir => readJob(dir))
      .filter(job => job?.relay?.workflowRunId === runId && !TERMINAL_STATES.has(job.state));
    if (!jobs.length) return null;
    return hookOutput(`TaskStop stopped Workflow run ${runId}. Its ${jobs.length} relay job(s) keep running, so a resumeFromRunId adopts them: ${jobs.map(job => job.id).join(", ")}. To abandon one: node "${COMPANION}" cancel <job>.`);
  }
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
        cwd, env: absoluteJobsHomeEnv(env), encoding: "utf8", timeout: cancelTimeoutMs(env)
      });
    } catch (error) {
      result = { error };
    }
    let violationReason;
    // A zero exit says the job has ended, not that the cancel ended it: the job may have finished on its own
    // between the state read above and the cancel, which then only records a no-op.
    const exited = !result.error && !result.signal;
    const blockState = /^state: (.*)$/m.exec(result.stdout ?? "");
    const ended = exited && result.status === 0 && !blockState ? readJob(jobDir) : null;
    const endedAs = exited && result.status === 0 ? blockState?.[1] ?? ended?.state : null;
    const attempts = blockState ? Number(/^attempts: (\d+)$/m.exec(result.stdout ?? "")?.[1] ?? 0) : ended?.attempts?.length ?? 0;
    const withWorker = exited && (result.status === 0 ||
      (result.status === 4 && [result.stdout, result.stderr].some(text => text?.includes("the cancel is with its"))));
    if (endedAs === "cancelled") {
      context = `TaskStop stopped the relay:job agent ${agentId}, and the relay hook cancelled its job ${job.id}:\n${result.stdout}`;
      try { appendRelayHandback(jobDir, { agentId, attempts, state: "cancelled", by: "TaskStop" }); }
      catch (error) { context += ` The hand-back could not be recorded: ${oneLine(error instanceof Error ? error.message : error)}.`; }
    } else if (TERMINAL_STATES.has(endedAs)) {
      context = `TaskStop stopped the relay:job agent ${agentId}. Its job ${job.id} ended (${endedAs}) before the cancel reached it; nothing was cancelled:\n${result.stdout}`;
    } else if (withWorker) {
      violationReason = `TaskStop stopped the relay, and the cancel had not ended the job: ${oneLine(result.stderr)}`;
      context = `TaskStop stopped the relay:job agent ${agentId}. The relay hook asked its job ${job.id} to cancel, and the job has not ended yet:\n${result.stdout}${result.stderr}\nCheck it with: node "${COMPANION}" status ${job.id}`;
    } else {
      const reason = oneLine(result.error?.message || result.stderr || (result.signal ? `cancel ended on signal ${result.signal}` : `cancel exited ${result.status}`));
      violationReason = `TaskStop stopped the relay, and the cancel failed: ${reason}`;
      context = `TaskStop stopped the relay:job agent ${agentId}, and the relay hook could not cancel its job ${job.id}: ${reason}. The job may still be running. Cancel it with: node "${COMPANION}" cancel ${job.id}`;
    }
    if (violationReason) {
      try { appendRelayViolation(jobDir, { kind: "cancel", reason: violationReason, agentId }); }
      catch (error) { context += ` The cancel violation could not be recorded: ${oneLine(error instanceof Error ? error.message : error)}.`; }
    }
  }
  return hookOutput(context);
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
