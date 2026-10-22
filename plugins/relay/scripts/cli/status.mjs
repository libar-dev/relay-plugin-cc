import { parseCommandInput, resolveJobReference, printJson, resolveCommandCwd } from "./shared.mjs";
import { default as process } from "node:process";
import { findJobDir, listJobDirs, readJob, repoSlugFor, resolveJobsHome, TERMINAL_STATES } from "../lib/jobs/store.mjs";
import { UsageError } from "../lib/jobs/request.mjs";
import { splitRawArgumentString } from "../lib/util/args.mjs";
import { messageAccount } from "../lib/jobs/messages.mjs";
import { readRepoConfig, readUserConfig } from "../lib/jobs/config.mjs";
import { PLUGIN_BUILD, PLUGIN_VERSION } from "../lib/util/plugin.mjs";
import { exitCodeFor, JobViewBusy, jobRowJson, jobViewJson, loadJobViewSettled as loadJobView, renderJobBlock, renderJobList, renderResultText, sortViewsNewestFirst } from "../lib/jobs/view.mjs";

const STATUS_LIST_LIMIT = 20;


// `--state-only` prints the state block without `---` and the report: what a string-return
// relay (a workflow subagent) types as its final text, so the report never goes through it.
export function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json", "state-only"] });
  const view = loadJobView(resolveJobReference(positionals[0], "result"));
  if (options.json) {
    printJson("result", { ...jobViewJson(view), report: view.hasReport && !options["state-only"] ? view.report : null });
  } else {
    process.stdout.write(options["state-only"] ? renderJobBlock(view) : renderResultText(view));
  }
  process.exitCode = exitCodeFor(view);
}

function readCursor(value) {
  if (value == null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const key = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(key) || key.length !== 2 || (key[0] !== null && typeof key[0] !== "string") || typeof key[1] !== "string" || !key[1]) throw new Error();
    return key;
  } catch {
    throw new UsageError("--cursor must be a cursor from status --json.");
  }
}

function compareKeys(a, b) {
  return String(b[0] ?? "").localeCompare(String(a[0] ?? "")) || b[1].localeCompare(a[1]);
}

function printListing(dirs, { slug, workflow, options, limit, cursor }) {
  const records = dirs.map(dir => ({ dir, job: readJob(dir) })).filter(entry => entry.job);
  const key = job => [job.createdAt ?? null, String(job.id)];
  records.sort((a, b) => compareKeys(key(a.job), key(b.job)));
  const jobs = [];
  let lastKey = null;
  let more = false;
  for (const { dir, job } of records) {
    if (cursor && compareKeys(key(job), cursor) <= 0) continue;
    if (options.active && TERMINAL_STATES.has(job.state) && messageAccount(dir).undelivered.length === 0) continue;
    if (!options.active && jobs.length === limit) { more = true; break; }
    let view;
    try { view = loadJobView(dir); }
    catch (error) { if (error instanceof JobViewBusy) throw error; continue; }
    if (options.active && TERMINAL_STATES.has(view.state) && view.undelivered.length === 0) continue;
    if (jobs.length === limit) { more = true; break; }
    jobs.push(jobRowJson(view));
    lastKey = key(job);
  }
  printJson("status", {
    jobsHome: resolveJobsHome(), scope: workflow ? "workflow" : options.all ? "all" : "repository",
    repoSlug: slug, workflowRunId: workflow || null, active: Boolean(options.active), limit, jobs,
    nextCursor: more ? Buffer.from(JSON.stringify(lastKey)).toString("base64url") : null
  });
}


export function handleStatus(argv) {
  const tokens = argv.length === 1 ? splitRawArgumentString(argv[0]) : argv;
  for (const [index, token] of tokens.entries()) {
    if (["--limit", "--cursor"].includes(token) && (!tokens[index + 1] || tokens[index + 1].startsWith("--"))) {
      throw new UsageError(`Missing value for ${token}.`);
    }
  }
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "workflow", "limit", "cursor"],
    booleanOptions: ["json", "all", "active"]
  });
  for (const name of ["limit", "cursor", "active"]) {
    if (options[name] != null && !options.json) throw new UsageError(`--${name} requires --json.`);
  }
  const limit = options.limit == null ? 50 : Number(options.limit);
  if ((options.limit != null && !/^\d+$/.test(options.limit)) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new UsageError("--limit must be an integer from 1 to 200.");
  }
  const cursor = readCursor(options.cursor);
  if (positionals[0]) {
    const view = loadJobView(findJobDir(positionals[0]));
    if (options.json) printJson("status", jobViewJson(view));
    else process.stdout.write(renderJobBlock(view));
    return;
  }
  const cwd = resolveCommandCwd(options);
  // `--workflow <run>`: every job one Workflow run started, in any repository, however many.
  const workflow = typeof options.workflow === "string" ? options.workflow.trim() : null;
  const slug = options.all || workflow ? null : repoSlugFor(cwd);
  let dirs = listJobDirs({ slug });
  if (workflow) {
    dirs = dirs.filter((dir) => readJob(dir)?.relay?.workflowRunId === workflow);
  }
  if (options.json) {
    printListing(dirs, { slug, workflow, options, limit, cursor });
    return;
  }
  if (!workflow && !options.all) {
    // The newest, by each job's record, before any is viewed: only a job the listing shows can
    // make it busy.
    const created = new Map(dirs.map((dir) => [dir, String(readJob(dir)?.createdAt ?? "")]));
    dirs = dirs.sort((a, b) => created.get(b).localeCompare(created.get(a))).slice(0, STATUS_LIST_LIMIT);
  }
  let views = [];
  for (const dir of dirs) {
    try {
      views.push(loadJobView(dir));
    } catch (error) {
      // A busy job is never left out: the listing is busy too, and says so (exit 4). A job
      // directory being created right now has no job.json yet.
      if (error instanceof JobViewBusy) throw error;
    }
  }
  views = sortViewsNewestFirst(views);
  const config = readRepoConfig(cwd);
  const header = `jobs-home: ${resolveJobsHome()}\n${slug ? `repo: ${slug}\n` : ""}review-gate: ${config.stopReviewGate ? "enabled" : "disabled"}\nfast-tier: ${readUserConfig().fastTier}\nrelay-version: ${PLUGIN_VERSION}${PLUGIN_BUILD !== null ? ` (${PLUGIN_BUILD})` : ""}\n`;
  process.stdout.write(header + renderJobList(views, { scope: workflow ? `for workflow ${workflow}` : slug ? "for this repository" : "" }));
}
