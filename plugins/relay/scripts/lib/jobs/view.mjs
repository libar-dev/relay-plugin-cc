import { backendFor, DEFAULT_BACKEND } from "../backends/index.mjs";
// What readers print about a job: a short `key: value` block first, then, when there is
// one, a line of three dashes and the report exactly as the backend wrote it.

import fs from "node:fs";
import path from "node:path";

import { isWorkerAlive } from "./lease.mjs";
import { isWorkerLease, readLease } from "./lease.mjs";
import { jobPaths, readJob, readJsonOrNull, TERMINAL_STATES } from "./store.mjs";
import { messageAccount, readJobMessages, readRelayHandbacks, readRelayViolations } from "./messages.mjs";

export const EXIT = {
  ok: 0,
  usage: 1,
  noReport: 3,
  running: 4,
  cancelled: 5
};

// How many times a view reads the job and its parts before it gives up on this call.
const VIEW_READS = 8;

/**
 * A job whose record changed during every pass of a view: a worker is busy with it. Not a state:
 * the reader retries (`loadJobViewSettled`, `wait`), or says the job is busy and to try again.
 */
export class JobViewBusy extends Error {
  constructor(jobDir, job) {
    super(`Job ${job?.id ?? path.basename(jobDir)} is busy: its record changed during each of ${VIEW_READS} reads. Try again.`);
    this.name = "JobViewBusy";
  }
}

// What a worker changes when it begins or ends an attempt: the job's state, how many attempts
// it has, and which attempt is the last and how it stands.
function jobVersion(job) {
  const attempts = Array.isArray(job?.attempts) ? job.attempts : [];
  const last = attempts.at(-1);
  return JSON.stringify([job?.state ?? null, attempts.length, last?.attempt ?? null, last?.startedAt ?? null, last?.state ?? null]);
}

// A validated read. The view reads the job, then its report, lease and message account, then
// the job again. When the job changed in between (a worker began an attempt for owed work, or a
// newer attempt wrote its report), those parts may belong to another version, so the view reads
// them all again. It renders from the report text it read in the pass that held. A pass that did
// not hold is never returned: after VIEW_READS of them it throws JobViewBusy.
export function loadJobView(jobDir, options = {}) {
  for (let pass = 1; ; pass += 1) {
    let job = readJob(jobDir);
    if (!job) {
      throw new Error(`No job.json in ${jobDir}.`);
    }
    let view = computeJobView(job, options);
    if (view.state === "dead") {
      // The worker may have published its terminal state and exited while the liveness
      // check ran. Read that publication before reporting a death from an older snapshot.
      job = readJob(jobDir) ?? job;
      view = computeJobView(job, options);
    }
    const paths = jobPaths(jobDir);
    const read = readReport(paths, job);
    const lease = readLease(jobDir);
    const account = messageAccount(jobDir);
    const relayViolations = readRelayViolations(jobDir);
    const handbacks = readRelayHandbacks(jobDir);
    const messages = readJobMessages(jobDir);
    const lastToolAt = readJsonOrNull(path.join(jobDir, "relay-guard.json"))?.lastToolAt ?? null;
    const again = readJob(jobDir);
    if (!again || jobVersion(again) !== jobVersion(job)) {
      if (pass < VIEW_READS) continue;
      throw new JobViewBusy(jobDir, again ?? job);
    }
    const hasReport = Boolean(read?.text.trim());
    // Owed work is running under a live worker, or undelivered without one.
    const workerLive = isWorkerLease(lease);
    if (workerLive && account.undelivered.length > 0) {
      view = { ...view, state: "running", deadReason: null };
    }
    const undelivered = workerLive ? [] : account.undelivered;
    return {
      job, jobDir, paths, ...view, hasReport, report: hasReport ? read.text : null, reportPath: hasReport ? read.path : null,
      undelivered, dropped: account.dropped, relayViolations, handbacks, ...messages, lastToolAt
    };
  }
}

// loadJobView, retried for up to `waitMs` while the job is busy; then JobViewBusy goes to the
// caller. For readers that answer once: status, result, a hook.
export function loadJobViewSettled(jobDir, options = {}, waitMs = 2000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return loadJobView(jobDir, options);
    } catch (error) {
      if (!(error instanceof JobViewBusy) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// The report for the attempts the job snapshot names, read once; readers render this copy and
// never read the file again. A new attempt moves report.md to attempts/<n>-report.md before it
// records itself, so a snapshot taken before that move finds its report there. That alone cannot
// tell a newer attempt's report.md from its own: loadJobView reads the job again after this read
// and reads everything again when the attempt changed, which is what keeps state and report
// together.
function readReport(paths, job) {
  const attempts = Array.isArray(job.attempts) ? job.attempts.length : 0;
  for (const file of [paths.report, ...(attempts > 0 ? [path.join(paths.attempts, `${attempts}-report.md`)] : [])]) {
    try { return { path: file, text: fs.readFileSync(file, "utf8") }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return null;
}

export function isTerminalView(view) {
  return TERMINAL_STATES.has(view.state) || view.state === "dead";
}

// The exit code `wait` and `result` give for a job view.
export function exitCodeFor(view) {
  if (!isTerminalView(view)) {
    return EXIT.running;
  }
  if (view.state === "cancelled") {
    return EXIT.cancelled;
  }
  if (view.undelivered?.length > 0) {
    return EXIT.noReport;
  }
  if (view.state === "completed" && view.hasReport) {
    return EXIT.ok;
  }
  return EXIT.noReport;
}

function lastAttempt(job) {
  return Array.isArray(job.attempts) && job.attempts.length > 0 ? job.attempts[job.attempts.length - 1] : null;
}

// Where a relay job came from: `relay: <agent id>`, then the Workflow run when the relay ran
// inside a workflow script, and the agent's label (its description) when it has one. A label
// is printed on one line: whitespace collapsed, cut to 80 characters.
function oneLineLabel(label) {
  const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  return Array.from(text).slice(0, 80).join("");
}

function relayLine(relay) {
  let line = `relay: ${relay.agentId}`;
  if (relay.workflowRunId) {
    line += ` workflow ${relay.workflowRunId}`;
  }
  const label = oneLineLabel(relay.label);
  if (label) {
    line += ` "${label}"`;
  }
  return line;
}

// One line per relay the job's current relay took over from (a harness re-spawn), oldest
// first: `relay-adopted: <new id> took over from <old id> at <time> as "<new label>"`.
export function relayAdoptionLines(relay) {
  const previous = Array.isArray(relay?.previous) ? relay.previous : [];
  return previous.map((entry, index) => {
    const next = previous[index + 1]?.agentId ?? relay.agentId;
    const as = oneLineLabel(entry.by);
    return `relay-adopted: ${next} took over from ${entry.agentId} at ${entry.replacedAt}${as ? ` as "${as}"` : ""}`;
  });
}

function relayListPart(relay) {
  if (!relay) {
    return [];
  }
  const label = oneLineLabel(relay.label);
  const adopted = Array.isArray(relay.previous) && relay.previous.length > 0 ? [`adopted:${relay.previous.length}`] : [];
  if (relay.workflowRunId) {
    return [`workflow:${relay.workflowRunId}/${label || relay.agentId}`, ...adopted];
  }
  return [label ? `relay:${relay.agentId}/${label}` : `relay:${relay.agentId}`, ...adopted];
}

// The state block names a non-default backend and includes the lines it declares.
export function backendLines(request) {
  const backend = backendFor(request);
  return [...(backend === DEFAULT_BACKEND ? [] : [`backend: ${backend.name}`]), ...backend.view.lines(request)];
}

export function backendJson(request) {
  const backend = backendFor(request);
  return { backend: backend.name, ...backend.view.json(request) };
}

export function backendSettingLines(request) {
  return backendFor(request).view.settingLines?.(request) ?? [];
}


// The lines of a state block that say what became of the job: the ones a workflow script reads.
// Every other line restates the request (model, effort, mode, cwd, the relay's own id), which the
// script already holds, or only informs (session, note).
export const OUTCOME_KEYS = new Set([
  "state", "job", "kind", "duration", "attempts", "report", "dir", "error", "stalled", "relay-violation",
  "undelivered", "not-delivered", "automatic-resume", "relay-adopted", "capacity-retries"
]);

export function renderJobBlock(view) {
  const { job } = view;
  const request = job.request ?? {};
  const end = isTerminalView(view) ? job.completedAt ?? job.updatedAt ?? null : null;
  const lines = [
    `state: ${view.state}`,
    `job: ${job.id}`,
    `session: ${job.sessionId ?? "none"}`,
    `model: ${request.model ?? "default"}`,
    `effort: ${request.effort ?? "default"}`,
    ...backendLines(request),
    `duration: ${formatDuration(job.createdAt, end) ?? "unknown"}`,
    `attempts: ${Array.isArray(job.attempts) ? job.attempts.length : 0}`,
    `report: ${view.hasReport ? view.reportPath : "none"}`,
    `dir: ${view.jobDir}`
  ];
  if (job.kind && job.kind !== "task") {
    lines.push(`kind: ${job.kind}`);
  }
  if (request.fast) lines.push("tier: fast");
  lines.push(...backendSettingLines(request));
  if (request.mode) {
    lines.push(`mode: ${request.mode}`);
  }
  if (request.webSearch) {
    lines.push(`web-search: ${request.webSearch}`);
  }
  if (request.cwd) {
    lines.push(`cwd: ${request.cwd}`);
  }
  if (job.relay) {
    lines.push(relayLine(job.relay), ...relayAdoptionLines(job.relay));
  }
  for (const note of request.notes ?? []) {
    lines.push(`note: ${note}`);
  }
  const attempt = lastAttempt(job);
  const inference = attempt?.completionInference;
  if (inference && attempt.turnId === job.turnId) {
    const line = backendFor(request).view.completionInferenceLine?.(inference, { sessionId: job.sessionId ?? null, turnId: job.turnId ?? null });
    if (line) lines.push(line);
  }
  if (view.state === "dead") {
    lines.push(`error: the job's worker died (${view.deadReason}). Run resume to continue it.`);
  } else if (job.errorMessage && view.state !== "completed") {
    lines.push(`error: ${String(job.errorMessage).replace(/\s+/g, " ").trim()}`);
  }
  if (view.stalled) {
    lines.push(`stalled: no event since ${job.lastEventAt ?? job.startedAt ?? job.createdAt}`);
  }
  for (const violation of view.relayViolations ?? []) {
    const first = String(violation.reason ?? "").split(/\r?\n/)[0];
    lines.push(`relay-violation: ${violation.kind}: ${first}`);
  }
  if (view.undelivered?.length > 0) {
    lines.push(`undelivered: ${view.undelivered.length} message(s) acknowledged but not run yet (${view.undelivered.join(", ")}); resume runs them`);
  }
  if (view.dropped?.length > 0) {
    lines.push(`not-delivered: ${view.dropped.length} message(s) dropped (${view.dropped.map((entry) => `${entry.id}: ${entry.reason}`).join("; ")})`);
  }
  for (const entry of job.automaticResumes ?? []) {
    lines.push(`automatic-resume: ${entry.id} after attempt ${entry.fromAttempt} at ${entry.at}${entry.reason ? ` (${entry.reason})` : ""}`);
  }
  if (Array.isArray(job.capacityRetries) && job.capacityRetries.length > 0) {
    lines.push(`capacity-retries: ${job.capacityRetries.length}`);
  }
  return `${lines.join("\n")}\n`;
}

// What `result` prints: the state block, then, when there is a report, `---` and the whole
// report. Read straight from the files, so nothing between here and the reader cuts it.
export function renderResultText(view) {
  let text = renderJobBlock(view);
  if (view.hasReport) {
    text += `---\n${view.report}${view.report.endsWith("\n") ? "" : "\n"}`;
  }
  return text;
}

export function renderJobWithReport(view) {
  let text = renderJobBlock(view);
  if (view.hasReport && isTerminalView(view)) {
    text += `---\n${view.report}${view.report.endsWith("\n") ? "" : "\n"}`;
  }
  return text;
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// When a relay handed back the ended result of the job's last attempt; null when none did (yet).
// A relay let go while the job ran handed back no result, though its hand-back is recorded.
export function handedBackAt(view) {
  const attempts = Array.isArray(view.job.attempts) ? view.job.attempts.length : 0;
  return (view.handbacks ?? []).findLast((entry) => entry.attempts === attempts && isTerminalView(entry))?.at ?? null;
}

// A relay job whose last attempt ended with no hand-back. Only an attempt that records its
// version can say: before 2.2.0 no hand-back was recorded.
function notHandedBack(view) {
  return Boolean(view.job.relay && isTerminalView(view) && view.job.attempts?.at(-1)?.relayVersion && !handedBackAt(view));
}

function summarizeJob(view) {
  const { job } = view;
  let summary = job.summary ?? "";
  if (!summary && fs.existsSync(view.paths.brief)) {
    summary = firstLine(fs.readFileSync(view.paths.brief, "utf8"));
  }
  return summary.length > 80 ? `${Array.from(summary).slice(0, 77).join("")}...` : summary;
}

export function renderJobList(views, options = {}) {
  if (views.length === 0) {
    return `No jobs${options.scope ? ` ${options.scope}` : ""}.\n`;
  }
  const header = ["job", "state", "kind", "backend", "model/effort", "duration", "summary", "relay"];
  const rows = views.map((view) => {
    const request = view.job.request ?? {};
    const backend = backendFor(request);
    const end = isTerminalView(view) ? view.job.completedAt ?? view.job.updatedAt ?? null : null;
    return [
      view.job.id,
      view.state + (view.stalled ? " (stalled)" : ""),
      view.job.kind ?? "task",
      [backend.name, ...backend.view.lines(request)].join(", "),
      `${request.model ?? "default"}/${request.effort ?? "default"}`,
      formatDuration(view.job.createdAt, end) ?? "?",
      summarizeJob(view),
      [
        ...relayListPart(view.job.relay),
        ...(notHandedBack(view) ? ["not handed back"] : []),
        ...(view.job.automaticResumes?.length ? [`automatic-resumes: ${view.job.automaticResumes.length}`] : [])
      ].join(", ")
    ];
  }).map((row) => row.map((cell) => String(cell).replace(/\s+/g, " ").trim().replaceAll("\\", "\\\\").replaceAll("|", "\\|")));
  // A loop, not a spread: `--all` can list more jobs than a call takes arguments.
  const widths = header.map((cell, index) => rows.reduce((widest, row) => Math.max(widest, Array.from(row[index]).length), Array.from(cell).length));
  const renderRow = (row) => `| ${row.map((cell, index) => cell + " ".repeat(widths[index] - Array.from(cell).length)).join(" | ")} |`;
  const separator = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
  return `jobs: ${views.length}\n\n${[renderRow(header), separator, ...rows.map(renderRow)].join("\n")}\n`;
}

export function jobViewJson(view) {
  return {
    id: view.job.id,
    kind: view.job.kind ?? "task",
    state: view.state,
    storedState: view.storedState,
    stalled: view.stalled,
    deadReason: view.deadReason,
    sessionId: view.job.sessionId ?? null,
    turnId: view.job.turnId ?? null,
    // The Claude Code session the job was started from (its relay's), unlike `sessionId`, the backend's.
    claudeSessionId: view.job.launchedBy?.claudeSessionId ?? null,
    model: view.job.request?.model ?? null,
    effort: view.job.request?.effort ?? null,
    ...backendJson(view.job.request),
    fast: Boolean(view.job.request?.fast),
    serviceTier: view.job.serviceTier ?? null,
    mode: view.job.request?.mode ?? null,
    webSearch: view.job.request?.webSearch ?? null,
    cwd: view.job.request?.cwd ?? null,
    attempts: Array.isArray(view.job.attempts) ? view.job.attempts.length : 0,
    errorMessage: view.job.errorMessage ?? null,
    createdAt: view.job.createdAt ?? null,
    updatedAt: view.job.updatedAt ?? null,
    completedAt: view.job.completedAt ?? null,
    jobDir: view.jobDir,
    reportPath: view.hasReport ? view.reportPath : null,
    hasReport: Boolean(view.hasReport),
    summary: summarizeJob(view),
    relay: view.job.relay ? { ...view.job.relay, lastToolAt: view.lastToolAt ?? null } : null,
    relayViolations: view.relayViolations ?? [],
    relayViolationCount: view.relayViolations?.length ?? 0,
    handedBackAt: view.job.relay ? handedBackAt(view) : null,
    notHandedBack: notHandedBack(view),
    openMessages: view.openMessages ?? 0,
    messages: view.messages ?? [],
    automaticResumes: view.job.automaticResumes ?? [],
    automaticResumeCount: view.job.automaticResumes?.length ?? 0,
    attemptRecords: view.job.attempts ?? [],
    server: view.job.server ?? null,
    undelivered: view.undelivered ?? [],
    undeliveredCount: view.undelivered?.length ?? 0,
    dropped: view.dropped ?? [],
    droppedCount: view.dropped?.length ?? 0
  };
}

// Every string a row holds is cut to this many characters, so one row stays small whatever a request or a
// record holds, and a page of rows stays under its byte budget. One job's full view keeps every value.
const ROW_STRING_LIMIT = 300;

function cutStrings(value) {
  if (typeof value === "string") return value.length > ROW_STRING_LIMIT ? Array.from(value).slice(0, ROW_STRING_LIMIT).join("") : value;
  if (Array.isArray(value)) return value.map(cutStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cutStrings(entry)]));
  return value;
}

export function jobRowJson(view) {
  const { attemptRecords, server, messages, ...row } = jobViewJson(view);
  const relay = row.relay;
  return cutStrings({
    ...row,
    errorMessage: firstLine(row.errorMessage) ? Array.from(firstLine(row.errorMessage)).slice(0, 200).join("") : null,
    relay: relay ? {
      agentId: relay.agentId ?? null, workflowRunId: relay.workflowRunId ?? null,
      label: relay.label == null ? null : oneLineLabel(relay.label), phase: relay.phase == null ? null : oneLineLabel(relay.phase),
      adopted: relay.previous?.length ?? 0, lastToolAt: relay.lastToolAt ?? null
    } : null,
    undelivered: row.undelivered.slice(0, 20),
    dropped: row.dropped.slice(-5).map(entry => ({
      ...entry, reason: entry.reason == null ? null : Array.from(String(entry.reason).split(/\r?\n/)[0]).slice(0, 200).join("")
    })),
    automaticResumes: row.automaticResumes.slice(-5),
    relayViolations: row.relayViolations.slice(-5).map(entry => ({
      at: entry.at ?? null, kind: entry.kind ?? null,
      reason: entry.reason == null ? null : Array.from(String(entry.reason).split(/\r?\n/)[0]).slice(0, 200).join("")
    }))
  });
}

export function sortViewsNewestFirst(views) {
  return [...views].sort((a, b) => String(b.job.createdAt ?? "").localeCompare(String(a.job.createdAt ?? "")));
}

const ACTIVE_STATES = new Set(["starting", "running"]);
const STALLED_AFTER_MS = 10 * 60 * 1000;
// A job whose worker never recorded its pid is dead after this long.
const WORKER_START_GRACE_MS = 60 * 1000;

// The state a reader reports. `dead` is never written: it is computed when the state is
// not terminal and the worker pid is gone or belongs to another process start time.
export function computeJobView(job, options = {}) {
  const now = options.now ?? Date.now();
  const stored = job?.state ?? "starting";
  let state = stored;
  let deadReason = null;
  if (!TERMINAL_STATES.has(stored)) {
    if (job?.worker?.pid) {
      if (!isWorkerAlive(job.worker)) {
        state = "dead";
        deadReason = `worker ${job.worker.pid} is gone`;
      }
    } else {
      const created = Date.parse(job?.launchPendingAt ?? job?.createdAt ?? "");
      if (Number.isFinite(created) && now - created > (options.workerStartGraceMs ?? WORKER_START_GRACE_MS)) {
        state = "dead";
        deadReason = "the worker never started";
      }
    }
  }
  const lastEvent = Date.parse(job?.lastEventAt ?? job?.startedAt ?? job?.createdAt ?? "");
  const stalled =
    ACTIVE_STATES.has(state) && Number.isFinite(lastEvent) && now - lastEvent > (options.stalledAfterMs ?? STALLED_AFTER_MS);
  return { state, storedState: stored, deadReason, stalled };
}

export function formatDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }
  const total = Math.round((end - start) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
