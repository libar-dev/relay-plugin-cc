#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { backendWith } from "../lib/backends/index.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/review/prompts.mjs";
import { absoluteJobsHomeEnv, listJobDirs, readJob, repoSlugFor, TERMINAL_STATES } from "../lib/jobs/store.mjs";
import { computeJobView } from "../lib/jobs/view.mjs";
import { readRepoConfig } from "../lib/jobs/config.mjs";

// Below the hook's own 900 s limit, so Claude Code never kills the hook with a review job
// still running behind it: the two probes, the start, the review and a cancel after it.
const STOP_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_PROBE_TIMEOUT_MS = 10 * 1000;
// Starting the review job, the margin of its wait, and the cancel after a timeout.
export const STOP_COMMAND_TIMEOUT_MS = 60 * 1000;
const REVIEW_BACKEND = backendWith("stopGate");
const MANUAL_REVIEW = "Run /relay:review --wait to review by hand.";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
const COMPANION = path.join(SCRIPT_DIR, "..", "companion.mjs");

// Environment overrides let tests shorten the review and probe limits.
export function stopGateLimits(env = process.env) {
  const ms = (name, fallback) => {
    const value = Number(env[name]);
    return env[name] && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { reviewMs: ms("RELAY_STOP_REVIEW_MS", STOP_REVIEW_TIMEOUT_MS), probeMs: ms("RELAY_STOP_PROBE_MS", STOP_PROBE_TIMEOUT_MS) };
}

function describeLimit(ms) {
  return ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000} minutes` : `${Number((ms / 1000).toFixed(1))} s`;
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// The gate never blocks on its own failure: it allows the stop and says why.
function allowWithMessage(message) {
  emitDecision({ systemMessage: `Review gate skipped: ${message}` });
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

// Jobs belong to no session: report any job of this repository that is still active.
function findActiveJob(cwd) {
  const active = [];
  for (const dir of listJobDirs({ slug: repoSlugFor(cwd) })) {
    const job = readJob(dir);
    if (!job) {
      continue;
    }
    const view = computeJobView(job);
    if (view.state === "starting" || view.state === "running") {
      active.push(job);
    }
  }
  return active.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0] ?? null;
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

async function buildSetupNote(cwd, limits) {
  const availability = await REVIEW_BACKEND.probe(cwd, { timeoutMs: limits.probeMs, env: process.env });
  if (availability.available) {
    return null;
  }
  const detail = availability.detail ? ` (${availability.detail})` : "";
  return `${REVIEW_BACKEND.label} is not set up for the review gate${detail}. Run /relay:setup.`;
}

// `{ ok: true }` allows, `{ ok: false, reason }` blocks, `{ ok: true, failure }` allows with
// a message: only a real `BLOCK:` answer blocks the stop.
function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review returned no answer. ${MANUAL_REVIEW}` };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, failure: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `${REVIEW_BACKEND.label} stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }
  return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review returned an unexpected answer. ${MANUAL_REVIEW}` };
}

// Children inherit the hook's environment and resolve the same jobs home.
// A command that has not answered is ended at `timeoutMs`. Tests can replace `spawn`.
export function runCompanionSync(args, { cwd, timeoutMs, spawn = spawnSync }) {
  const result = spawn(process.execPath, [COMPANION, ...args], {
    cwd,
    env: absoluteJobsHomeEnv(process.env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/).find(Boolean) ?? "";
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// The review is a job: started in the background, waited for up to its limit, and cancelled
// through the job path when it is not done by then (its process tree ended, its state
// terminal). `{ ok: true }` allows, `{ ok: false, reason }` blocks, `{ ok: true, failure }`
// allows with a message.
export function runStopReview(cwd, input = {}, { limits = stopGateLimits(), runCompanion = runCompanionSync } = {}) {
  const prompt = buildStopReviewPrompt(input);
  const started = runCompanion(["task", "--backend", REVIEW_BACKEND.name, "--background", "--json", "--mode", "read-only", "--cd", cwd, prompt], { cwd, timeoutMs: STOP_COMMAND_TIMEOUT_MS });
  if (started.error) {
    return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review did not start: ${started.error.message}. ${MANUAL_REVIEW}` };
  }
  if (started.status !== 0) {
    const detail = firstLine(started.stderr || started.stdout);
    return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review failed (exit ${started.status}${detail ? `: ${detail}` : ""}). ${MANUAL_REVIEW}` };
  }
  const jobId = parseJson(started.stdout)?.jobId;
  if (typeof jobId !== "string" || !jobId) {
    return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review returned invalid JSON. ${MANUAL_REVIEW}` };
  }
  const waited = runCompanion(["wait", jobId, "--json", "--timeout-seconds", String(limits.reviewMs / 1000)], { cwd, timeoutMs: limits.reviewMs + STOP_COMMAND_TIMEOUT_MS });
  const view = waited.error ? null : parseJson(waited.stdout);
  const ended = view && TERMINAL_STATES.has(view.state);
  if (!ended) {
    // Past its limit, dead, or unreadable: nothing of the review may outlive the hook.
    runCompanion(["cancel", jobId, "--json"], { cwd, timeoutMs: STOP_COMMAND_TIMEOUT_MS });
    if (!view && !waited.error) {
      return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review returned invalid JSON. ${MANUAL_REVIEW}` };
    }
    if (view?.state === "dead") {
      return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review stopped: ${view.deadReason ?? "its worker is gone"}. ${MANUAL_REVIEW}` };
    }
    return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review timed out after ${describeLimit(limits.reviewMs)}. ${MANUAL_REVIEW}` };
  }
  if (view.state !== "completed") {
    const detail = firstLine(view.errorMessage);
    return { ok: true, failure: `the stop-time ${REVIEW_BACKEND.label} review failed (exit ${waited.status}${detail ? `: ${detail}` : ""}). ${MANUAL_REVIEW}` };
  }
  return parseStopReviewOutput(view.report);
}

function describeBackgroundTasks(tasks) {
  const types = [...new Set(tasks.map(task => String(task?.type ?? "task")))];
  return `${tasks.length} background task${tasks.length === 1 ? "" : "s"} running (${types.join(", ")})`;
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = readRepoConfig(cwd);

  const runningJob = findActiveJob(cwd);
  const runningTaskNote = runningJob
    ? `job ${runningJob.id} is still running. Check /relay:status and use /relay:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  // The three guards: a continuation already in progress, background work the review cannot
  // see, and a job of this repository whose edits it cannot tell from Claude's.
  if (input.stop_hook_active === true) {
    allowWithMessage("a stop-hook continuation is already in progress.");
    return;
  }
  const backgroundTasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  if (backgroundTasks.length > 0) {
    allowWithMessage(`${describeBackgroundTasks(backgroundTasks)}; the review runs when the session is done.`);
    return;
  }
  if (runningJob) {
    allowWithMessage(`${runningTaskNote}`);
    return;
  }

  const limits = stopGateLimits();
  const setupNote = await buildSetupNote(cwd, limits);
  if (setupNote) {
    allowWithMessage(setupNote);
    return;
  }

  const review = runStopReview(cwd, input, { limits });
  if (!review.ok) {
    emitDecision({ decision: "block", reason: review.reason });
    return;
  }
  if (review.failure) {
    allowWithMessage(review.failure);
  }
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run as the hook; imported (tests), it only exports.
if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
