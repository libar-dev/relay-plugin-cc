import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { parseArgs, splitRawArgumentString } from "../lib/util/args.mjs";
import { createJobDir, findJobDir, generateJobId, jobPaths, listJobDirs, nowIso, readJob, repoSlugFor, writeFileAtomic, writeJob } from "../lib/jobs/store.mjs";
import { UsageError } from "../lib/jobs/request.mjs";
import { isTerminalView, JobViewBusy, loadJobViewSettled, sortViewsNewestFirst } from "../lib/jobs/view.mjs";
import { PLUGIN_BUILD, PLUGIN_VERSION } from "../lib/util/plugin.mjs";


// An empty or blank value is unset; an explicit 0 stands.
export function envNumber(name, fallback) {
  const raw = process.env[name];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}


export function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}


// Every `--json` output is one object that names its shape and the build that wrote it:
// `schema` is `relay.<command>/<n>`, and n rises when the shape changes.
export function jsonHeader(command) {
  return { schema: `relay.${command}/1`, relayVersion: PLUGIN_VERSION, relayBuild: PLUGIN_BUILD };
}


export function printJson(command, value) {
  console.log(JSON.stringify({ ...jsonHeader(command), ...value }, null, 2));
}


// Whether this run asked for JSON: what the command's own parse found, or, when the parse
// itself failed, the `--json` token.
let parsedJson = null;

export function jsonRequested(argv) {
  return parsedJson ?? normalizeArgv(argv).includes("--json");
}


function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}


export function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  parsedJson = Boolean(parsed.options.json);
  return parsed;
}


export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}


export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}


export function readInputFile(filePath) {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}


export function readMessageText(options, { required = true, fallback = null } = {}) {
  if (options["message-file"]) {
    return readInputFile(options["message-file"]);
  }
  if (typeof options.message === "string") {
    return options.message;
  }
  if (!required) {
    return fallback;
  }
  throw new UsageError("--message-file <file> is required.");
}


// A job reference, or, when none is given, the obvious job of this repository: the newest
// finished one for `result`, the only active one for `cancel`.
export function resolveJobReference(reference, purpose) {
  if (reference) {
    return findJobDir(reference);
  }
  const views = [];
  for (const dir of listJobDirs({ slug: repoSlugFor(process.cwd()) })) {
    try {
      views.push(loadJobViewSettled(dir));
    } catch (error) {
      // A busy job is never skipped: it may be the active one. Skip a directory without job.json.
      if (error instanceof JobViewBusy) throw error;
    }
  }
  const sorted = sortViewsNewestFirst(views);
  if (purpose === "cancel") {
    const active = sorted.filter((view) => !isTerminalView(view));
    if (active.length === 1) {
      return active[0].jobDir;
    }
    throw new UsageError(active.length === 0 ? "No active job in this repository." : `${active.length} jobs are active. Pass a job id: ${active.map((view) => view.job.id).join(", ")}.`);
  }
  const finished = sorted.find((view) => isTerminalView(view));
  if (!finished) {
    throw new UsageError("No finished job in this repository. Pass a job id.");
  }
  return finished.jobDir;
}


export function requireTaskJob(jobDir) {
  const job = readJob(jobDir);
  if (job?.kind && job.kind !== "task") {
    throw new UsageError(`Job ${job.id} is a ${job.kind} job. Only task jobs take messages.`);
  }
  return job;
}


// ---------------------------------------------------------------------------------------
// Job creation

export function createTaskJob(request, brief, options = {}) {
  const id = generateJobId(options.prefix ?? "job");
  const { jobDir, slug } = createJobDir(request.cwd, id);
  const paths = jobPaths(jobDir);
  writeFileAtomic(paths.brief, brief);
  writeJob(jobDir, {
    id,
    kind: "task",
    state: "starting",
    createdAt: nowIso(),
    repoSlug: slug,
    request,
    pendingFirstTurn: true,
    ...(options.summary ? { summary: options.summary } : {}),
    ...(options.relay ? { relay: options.relay } : {}),
    sessionId: null,
    turnId: null,
    attempts: [],
    launchedBy: {
      pid: process.pid,
      claudeSessionId: process.env.RELAY_COMPANION_SESSION_ID ?? null
    }
  });
  return jobDir;
}
