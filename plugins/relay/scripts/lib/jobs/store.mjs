// The job store. Every job has its own directory under the job home:
//
//   $RELAY_JOBS_HOME (default ~/.relay-jobs) / <repo-slug> / <job-id> /
//     job.json      the job record; written by `start`, then only by the job's worker
//     events.jsonl  every app-server notification, one JSON object per line
//     report.md     the final agent message of the current attempt
//     stderr.log    the worker's stdout and stderr
//     brief.md      the brief of the first turn, byte for byte
//     inbox/        messages for the worker (steer, continue, cancel)
//     attempts/     reports of earlier attempts
//
// Listing is a directory read. There is no index file and no shared state file.
// Every write is a write to a temporary file and a rename.

import { createHash, randomBytes } from "node:crypto";
import { default as fs } from "node:fs";
import { default as os } from "node:os";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { writeFileAtomic, writeJsonAtomic, readJsonOrNull } from "../util/fs.mjs";
export { writeFileAtomic, writeJsonAtomic, readJsonOrNull } from "../util/fs.mjs";
import { runCommand } from "../util/process.mjs";
import { JobNotFound } from "../util/errors.mjs";


export const JOBS_HOME_ENV = "RELAY_JOBS_HOME";

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);


export function nowIso() {
  return new Date().toISOString();
}


export function resolveJobsHome(env = process.env) {
  const configured = env[JOBS_HOME_ENV];
  return path.resolve(configured && configured.trim() ? configured : path.join(os.homedir(), ".relay-jobs"));
}


// Children get the jobs home as an absolute path because a relative one would resolve
// against the child's working directory.
export function absoluteJobsHomeEnv(env = process.env) {
  return { ...env, [JOBS_HOME_ENV]: resolveJobsHome(env) };
}


function gitOutput(cwd, args) {
  const result = runCommand("git", args, { cwd });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}


function realpathOr(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}


// The repository a working directory belongs to: the main checkout for a linked
// worktree, the top level for a plain checkout, the directory itself outside git.
function resolveRepositoryRoot(cwd) {
  const commonDir = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) {
    const common = realpathOr(commonDir);
    if (path.basename(common) === ".git") {
      return path.dirname(common);
    }
    const topLevel = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
    return realpathOr(topLevel ?? cwd);
  }
  return realpathOr(cwd);
}


export function repoSlugFor(cwd) {
  const root = resolveRepositoryRoot(cwd);
  const base = (path.basename(root) || "workspace").replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}


export function generateJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}


export function jobPaths(jobDir) {
  return {
    dir: jobDir,
    job: path.join(jobDir, "job.json"),
    events: path.join(jobDir, "events.jsonl"),
    serverStderr: path.join(jobDir, "server.stderr.log"),
    report: path.join(jobDir, "report.md"),
    stderr: path.join(jobDir, "stderr.log"),
    brief: path.join(jobDir, "brief.md"),
    inbox: path.join(jobDir, "inbox"),
    claimed: path.join(jobDir, "inbox", "claimed"),
    outcomes: path.join(jobDir, "inbox", "outcomes"),
    attempts: path.join(jobDir, "attempts"),
    lease: path.join(jobDir, "worker.lease"),
    wake: path.join(jobDir, "relay-wake.json"),
    // The job's current relay binding, written when a re-spawned relay takes the job over.
    // job.json keeps the binding at creation: the worker is its only writer while it lives
    // and holds its own copy, so a later binding lives here and is merged in by readJob.
    relay: path.join(jobDir, "relay.json")
  };
}


export function createJobDir(cwd, jobId, env = process.env) {
  const slug = repoSlugFor(cwd);
  const jobDir = path.join(resolveJobsHome(env), slug, jobId);
  const paths = jobPaths(jobDir);
  fs.mkdirSync(paths.claimed, { recursive: true });
  fs.mkdirSync(paths.outcomes, { recursive: true });
  fs.mkdirSync(paths.attempts, { recursive: true });
  return { jobDir, slug };
}


export function readJob(jobDir) {
  const paths = jobPaths(jobDir);
  const job = readJsonOrNull(paths.job);
  if (!job?.relay) {
    return job;
  }
  const binding = readJsonOrNull(paths.relay);
  return binding ? { ...job, relay: { ...job.relay, ...binding } } : job;
}


// Preserve queue history while closing a wait that can no longer be active.
export function settledAdmission(admission, state) {
  return admission?.state === "waiting" && (TERMINAL_STATES.has(state) || state === "dead")
    ? { ...admission, state: state === "cancelled" ? "cancelled" : "ended" } : admission;
}

export function writeJob(jobDir, job) {
  writeJsonAtomic(jobPaths(jobDir).job, { ...job,
    ...(job.admission ? { admission: settledAdmission(job.admission, job.state) } : {}), updatedAt: nowIso() });
}


function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}


// Job directories of one repository slug, or of every slug.
export function listJobDirs({ slug = null, env = process.env } = {}) {
  const home = resolveJobsHome(env);
  const slugDirs = slug ? [path.join(home, slug)] : listDirs(home);
  return slugDirs.flatMap((slugDir) => listDirs(slugDir).filter((dir) => fs.existsSync(jobPaths(dir).job)));
}


function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}


// A job given as a directory is one of this relay's only when its real path is inside the
// resolved jobs home. Refuse paths outside it before reading another store's records.
export function requireJobDirInHome(dir, env = process.env) {
  const home = resolveJobsHome(env);
  const real = realpathOr(dir);
  if (!isInside(realpathOr(home), real) && !(real === dir && isInside(home, dir))) {
    throw new Error(`${dir} is not a job of this relay: its jobs home is ${home}.`);
  }
  return dir;
}


// Find a job by id or unique id prefix across every repository slug, or by its directory
// inside the jobs home.
export function findJobDir(reference, env = process.env) {
  const ref = String(reference ?? "").trim();
  if (!ref) {
    throw new Error("A job id is required.");
  }
  if (path.isAbsolute(ref)) {
    requireJobDirInHome(ref, env);
    if (fs.existsSync(jobPaths(ref).job)) {
      return ref;
    }
    throw new JobNotFound(`No job found for "${ref}" under ${resolveJobsHome(env)}.`);
  }
  const all = listJobDirs({ env });
  const exact = all.filter((dir) => path.basename(dir) === ref);
  if (exact.length === 1) {
    return exact[0];
  }
  const prefix = all.filter((dir) => path.basename(dir).startsWith(ref));
  if (prefix.length === 1) {
    return prefix[0];
  }
  if (prefix.length > 1) {
    throw new Error(`Job reference "${ref}" is ambiguous. Use the full job id.`);
  }
  throw new JobNotFound(`No job found for "${ref}" under ${resolveJobsHome(env)}.`);
}
