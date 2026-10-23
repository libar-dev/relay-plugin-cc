import { setTimeout as sleep } from "node:timers/promises";
import { admit, admissionHome, releaseSlot, recordRefusal, classifyRefusal, probeSucceeded } from "../lib/worker/admission.mjs";
import { parseCommandInput, resolveCommandCwd, firstMeaningfulLine, printJson } from "./shared.mjs";
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { fileURLToPath } from "node:url";
import { parseStructuredOutput, readOutputSchema } from "../lib/review/structured-output.mjs";
import { collectReviewContext, DEFAULT_INLINE_DIFF_MAX_BYTES, estimateReviewSize, resolveReviewTarget } from "../lib/review/git.mjs";
import { BACKEND_HEADER_KEYS, backendHeaderValues, DEFAULT_BACKEND, backendFor } from "../lib/backends/index.mjs";
import { readProcessStartTime } from "../lib/util/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/review/prompts.mjs";
import { createJobDir, generateJobId, jobPaths, nowIso, readJob, writeFileAtomic, writeJob } from "../lib/jobs/store.mjs";
import { buildLaunchRequest, UsageError } from "../lib/jobs/request.mjs";
import { newMessageId } from "../lib/jobs/messages.mjs";
import { PLUGIN_VERSION } from "../lib/util/plugin.mjs";
import { renderNativeReviewResult, renderReviewResult, reviewSchemaError } from "../lib/review/render.mjs";


const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");


// ---------------------------------------------------------------------------------------
// Foreground reviews are jobs so status and result list them.

function recordForegroundJob(cwd, kind, summary, request) {
  const id = generateJobId(kind === "adversarial-review" ? "areview" : "review");
  const { jobDir, slug } = createJobDir(cwd, id);
  writeJob(jobDir, {
    id,
    kind,
    state: "starting",
    createdAt: nowIso(),
    startedAt: nowIso(),
    repoSlug: slug,
    summary,
    request,
    worker: { pid: process.pid, startTime: readProcessStartTime(process.pid), startedAt: nowIso() },
    sessionId: null,
    attempts: [{ attempt: 1, source: kind, startedAt: nowIso(), relayVersion: PLUGIN_VERSION, state: "starting" }]
  });
  const paths = jobPaths(jobDir);
  const tap = (notification) => {
    fs.appendFileSync(paths.events, `${JSON.stringify({ at: nowIso(), ...notification })}\n`, "utf8");
  };
  const finish = (patch, report) => {
    if (report) {
      writeFileAtomic(paths.report, report.endsWith("\n") ? report : `${report}\n`);
    }
    const job = readJob(jobDir);
    const attempts = [...job.attempts];
    attempts[0] = { ...attempts[0], endedAt: nowIso(), state: patch.state, hasReport: Boolean(report) };
    writeJob(jobDir, { ...job, ...patch, attempts, completedAt: nowIso(), lastEventAt: nowIso() });
  };
  const saveState = (patch) => {
    const job = readJob(jobDir);
    writeJob(jobDir, { ...job, backendState: { ...job.backendState, ...patch } });
  };
  const lifecycle = {
    onSpawn(proc) {
      const job = readJob(jobDir);
      const server = { pid: proc.pid ?? null, startTime: proc.pid ? readProcessStartTime(proc.pid) : null, startedAt: nowIso() };
      writeJob(jobDir, { ...job, server, serverPid: server.pid, attempts: job.attempts.map((a, i) => i === 0 ? { ...a, servers: [...(a.servers ?? []), server] } : a) });
    },
    onEnd(info) {
      const job = readJob(jobDir);
      writeJob(jobDir, { ...job, server: { ...job.server, ...info }, attempts: job.attempts.map((a, i) => i === 0 ? { ...a, servers: (a.servers ?? []).map(server => server.pid === info.pid ? { ...server, ...info } : server) } : a) });
    }
  };
  return { jobDir, tap, finish, saveState, lifecycle };
}


const REVIEW_OPTIONS = {
  argsFile: true,
  valueOptions: ["base", "scope", "model", "effort", "backend", ...Object.keys(BACKEND_HEADER_KEYS), "cwd"],
  booleanOptions: ["json", "background", "wait"],
  aliasMap: { m: "model" }
};


// A backend without a schema parameter receives it in the prompt so the answer can be checked.
function schemaInPrompt() {
  return [
    "This request carries no schema parameter, so the schema is below. Answer with one JSON object that matches it and nothing else: no prose before or after it, no code fence.",
    "<output_schema>",
    JSON.stringify(readOutputSchema(REVIEW_SCHEMA), null, 2),
    "</output_schema>",
    ""
  ].join("\n");
}


function buildAdversarialReviewPrompt(context, focusText, backend = DEFAULT_BACKEND) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEWER: backend.label,
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    OUTPUT_SCHEMA: backend.review.schema === "turn" ? "" : schemaInPrompt()
  });
}


// The plain prompt supplies review instructions when the backend has no native reviewer.
function buildPlainReviewPrompt(context, backend) {
  return interpolateTemplate(loadPromptTemplate(ROOT_DIR, "review"), {
    REVIEWER: backend.label,
    TARGET_LABEL: context.target.label,
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}


export function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/relay:review\` does not support custom focus text. Retry with \`/relay:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
  if (!["working-tree", "branch"].includes(target.mode)) {
    throw new Error("This `/relay:review` target is not supported by the built-in reviewer. Retry with `/relay:adversarial-review` for custom targeting.");
  }
  return target;
}


// Review flags use the same request rules as jobs so home checks and status agree.
function buildReviewRequest(options, cwd, reviewName) {
  const request = buildLaunchRequest(
    {
      backend: options.backend,
      model: options.model ?? "default",
      effort: options.effort ?? "default",
      ...backendHeaderValues(options),
      mode: "read-only",
      cd: cwd
    },
    { baseDir: cwd }
  );
  const backend = backendFor(request);
  if (reviewName === "Review" && backend.review.nativeEffortNote && request.effort != null) {
    request.notes.push(backend.review.nativeEffortNote(request.effort));
    request.effort = null;
  }
  return request;
}


// An inline review needs the whole diff. Untracked files count toward the limits and are
// inlined whole; a refusal precedes job creation and starting a backend process.
function inlineReviewContext(cwd, target, backend) {
  const context = collectReviewContext(cwd, target, { untrackedInFull: true });
  if (context.inputMode === "inline-diff") {
    return context;
  }
  const files = `${context.fileCount} file${context.fileCount === 1 ? "" : "s"}`;
  const size = context.diffBytes > DEFAULT_INLINE_DIFF_MAX_BYTES
    ? `more than ${DEFAULT_INLINE_DIFF_MAX_BYTES / 1024} KiB`
    : `${Math.ceil(context.diffBytes / 1024)} KiB`;
  throw new UsageError(
    `The diff is ${files} / ${size}; a ${backend.label} review reads only an inlined diff. Narrow it with --base or --scope, ${backend.review.inlineDiffAdvice}`
  );
}


// A review owns its job record and uses a fresh read-only session and its event recorder.
function reviewHooks(backend, tap, saveState, lifecycle) {
  const recorder = backend.eventRecorder(tap, () => {});
  const hooks = {
    env: process.env, state: {}, ...lifecycle,
    saveState(patch) { saveState(patch); Object.assign(hooks.state, patch); },
    tap: notification => recorder.record(notification)
  };
  return { recorder, hooks };
}

async function runReviewTurn(request, prompt, tap, saveState, lifecycle) {
  const backend = backendFor(request);
  const { recorder, hooks } = reviewHooks(backend, tap, saveState, lifecycle);
  const outputSchema = backend.review.schema === "turn" ? readOutputSchema(REVIEW_SCHEMA) : undefined;
  let connection;
  try {
    connection = await backend.connect(request, hooks);
    const opened = await connection.open({ sessionId: null, sessionUsed: false, sessionName: null, ephemeral: true });
    for (const note of opened.notes ?? []) request.notes.push(note);
    const result = await connection.run({
      prompt, clientId: newMessageId(), source: "brief", onPending() {},
      ...(outputSchema ? { outputSchema } : {}),
      onTurnId() {}
    });
    const status = result.turnStatus === "completed" ? 0 : 1;
    return {
      status, sessionId: opened.sessionId, finalMessage: result.finalMessage ?? "",
      error: result.error ?? (status === 0 ? null : { message: `the ${backend.label} turn ended ${result.turnStatus ?? "without a status"}` }),
      stderr: result.stderr ?? connection.server.stderr ?? "", reasoningSummary: result.reasoningSummary ?? null
    };
  } finally {
    recorder.flush();
    await connection?.close().catch(() => {});
  }
}


// The answer as review JSON. A single ```json fence around the whole answer is unwrapped;
// anything else that does not parse stays invalid. No repair turn.
function parseReviewAnswer(text, fallback) {
  const raw = String(text ?? "");
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(raw.trim());
  return { ...parseStructuredOutput(fenced ? fenced[1] : raw, fallback), rawOutput: raw };
}


// A failed turn fails with the backend's error; its text is never read as an answer. An answer
// from a completed turn that does not parse or match the schema fails with its raw text kept in
// the report.
function adversarialOutcome(run, { backend, reviewName, context }) {
  const label = backend.label;
  const turnError = run.status === 0 ? null : run.error?.message ?? (run.stderr || "The review failed.");
  const parsed = turnError
    ? { parsed: null, parseError: null, rawOutput: String(run.finalMessage ?? "") }
    : parseReviewAnswer(run.finalMessage, { failureMessage: `${label} did not return a final message.` });
  const validationError = parsed.parsed ? reviewSchemaError(parsed.parsed) : null;
  const invalid = !turnError && (!parsed.parsed || Boolean(validationError));
  return {
    providerError: run.error,
    exitStatus: invalid ? 1 : run.status,
    sessionId: run.sessionId,
    payload: {
      review: reviewName,
      backend: backend.name,
      target: context.target,
      sessionId: run.sessionId,
      context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary },
      [backend.name]: { status: run.status, stderr: run.stderr, stdout: run.finalMessage, reasoning: run.reasoningSummary },
      result: validationError ? null : parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      validationError,
      turnError,
      reasoningSummary: run.reasoningSummary
    },
    rendered: renderReviewResult(parsed, {
      backendLabel: label,
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: run.reasoningSummary,
      turnError
    }),
    errorMessage: invalid ? `${label} returned no valid review JSON` : turnError
  };
}


async function executeNativeReview({ request, target, reviewName, tap, saveState, lifecycle }) {
  const backend = backendFor(request);
  const { recorder, hooks } = reviewHooks(backend, tap, saveState, lifecycle);
  let result;
  try { result = await backend.review.native(request, target, hooks); }
  finally { recorder.flush(); }
  return {
    providerError: result.error,
    exitStatus: result.status,
    sessionId: result.sessionId,
    payload: {
      review: reviewName,
      backend: backend.name,
      target,
      sessionId: result.sessionId,
      [backend.name]: { status: result.status, stderr: result.stderr, stdout: result.reviewText, reasoning: result.reasoningSummary, ...result.details }
    },
    rendered: renderNativeReviewResult(
      { status: result.status, stdout: result.reviewText, stderr: result.stderr },
      { backendLabel: backend.label, reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    ),
    errorMessage: result.status === 0 ? null : result.error?.message ?? (result.stderr || "The review failed.")
  };
}


async function executeBackendReview({ request, context, focusText, reviewName, tap, saveState, lifecycle }) {
  const backend = backendFor(request);
  const prompt = reviewName === "Review" ? buildPlainReviewPrompt(context, backend) : buildAdversarialReviewPrompt(context, focusText, backend);
  const run = await runReviewTurn({ ...request, cwd: context.repoRoot }, prompt, tap, saveState, lifecycle);
  if (reviewName !== "Review") return adversarialOutcome(run, { backend, reviewName, context });
  const { status } = run;
  const errorMessage = status === 0 ? null : run.error.message;
  return {
    providerError: run.error,
    exitStatus: status,
    sessionId: run.sessionId,
    payload: {
      review: reviewName,
      backend: backend.name,
      target: context.target,
      sessionId: run.sessionId,
      [backend.name]: { status, stderr: run.stderr, stdout: run.finalMessage }
    },
    rendered: renderNativeReviewResult(
      { status, stdout: run.finalMessage, stderr: status === 0 ? "" : run.stderr },
      { backendLabel: backend.label, reviewLabel: reviewName, targetLabel: context.target.label, errorMessage }
    ),
    errorMessage
  };
}


export async function handleReviewCommand(argv, config) {
  // The recipe's outer estimate mode cannot be disabled by options in raw text.
  const estimateOnly = argv.includes("--estimate");
  const { options, positionals } = parseCommandInput(argv.filter(token => token !== "--estimate"), {
    ...REVIEW_OPTIONS, consumeArgsFile: !estimateOnly
  });
  const cwd = resolveCommandCwd(options);
  const focusText = positionals.join(" ").trim();
  const request = buildReviewRequest(options, cwd, config.reviewName);
  const backend = backendFor(request);
  const capability = config.reviewName === "Review" ? "review" : "adversarialReview";
  if (!backend.capabilities[capability]) throw new UsageError(`${backend.label} does not support ${config.reviewName.toLowerCase()}.`);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  config.validateRequest?.(target, focusText);
  if (estimateOnly) {
    const size = estimateReviewSize(cwd, target);
    if (options.json) printJson("review-estimate", { target, ...size });
    else process.stdout.write(`target: ${target.label}\nfiles: ${size.fileCount}\nuntracked: ${size.untrackedCount}\n${size.shortstat || "(empty diff)"}\n`);
    return;
  }
  let context = backend.review.inlineDiff ? inlineReviewContext(cwd, target, backend) : null;

  const kind = config.reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const { jobDir, tap, finish, saveState, lifecycle } = recordForegroundJob(cwd, kind, `${config.reviewName} ${target.label}`, request);
  const home = admissionHome(), me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  const jobId = readJob(jobDir).id;
  let execution, slot;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const refusal = error => {
    const classified = classifyRefusal(backend.name, error);
    if (classified && slot) recordRefusal(home, backend.name, classified, jobId);
  };
  try {
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    try {
      let shownReason = null;
      for (;;) {
        if (cancelled) throw new Error("Review cancelled while waiting for admission.");
        const job = readJob(jobDir);
        const decision = admit({ home, jobDir, jobId, me, request, admission: job.admission,
          waitingSince: job.admission?.state === "waiting" ? job.admission.since : null });
        slot = decision.slot ?? slot;
        writeJob(jobDir, { ...job, state: decision.admit ? "running" : decision.permanent ? "failed" : "queued", admission: decision.record,
          attempts: job.attempts.map(a => ({ ...a, state: decision.admit ? "running" : "queued", admission: decision.record })) });
        if (decision.permanent) throw new Error(decision.reason);
        if (decision.admit) break;
        if (shownReason !== decision.reason) { process.stderr.write(`relay review queued: ${decision.reason}\n`); shownReason = decision.reason; }
        const deadline = Date.now() + decision.retryMs;
        while (!cancelled && Date.now() < deadline) await sleep(Math.min(100, deadline - Date.now()));
      }
    } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    if (config.reviewName === "Review" && backend.review.native) {
      execution = await executeNativeReview({ request, target, reviewName: config.reviewName, tap, saveState, lifecycle });
    } else {
      backend.review.prepare?.(request);
      context ??= collectReviewContext(request.cwd, target);
      execution = await executeBackendReview({ request, context, focusText, reviewName: config.reviewName, tap, saveState, lifecycle });
    }
    if (execution.providerError) refusal(execution.providerError);
    else if (slot?.probe && execution.exitStatus === 0) probeSucceeded(home, backend.name, jobId, {}, slot.probeGeneration);
  } catch (error) {
    refusal(error);
    finish({ state: cancelled ? "cancelled" : "failed", errorMessage: error instanceof Error ? error.message : String(error) }, null);
    throw error;
  } finally { if (slot) releaseSlot(home, jobId, me); }
  finish(
    {
      // The request again: a backend may have added a note while opening its session.
      request,
      state: execution.exitStatus === 0 ? "completed" : "failed",
      sessionId: execution.sessionId ?? null,
      errorMessage: execution.errorMessage ?? null,
      summary: firstMeaningfulLine(execution.payload?.result?.summary ?? execution.payload?.[backend.name]?.stdout, `${config.reviewName} finished.`)
    },
    execution.rendered
  );
  const notes = request.notes.map((note) => `note: ${note}\n`).join("");
  if (options.json) printJson(kind, { ...execution.payload, notes: request.notes });
  else process.stdout.write(`${notes}${notes ? "\n" : ""}${execution.rendered}`);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}
