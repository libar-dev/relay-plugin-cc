import { parseCommandInput, resolveJobReference, outputResult, resolveCommandCwd } from "./shared.mjs";
import { default as process } from "node:process";
import { findJobDir, listJobDirs, readJob, repoSlugFor, resolveJobsHome } from "../lib/jobs/store.mjs";
import { readRepoConfig, readUserConfig } from "../lib/jobs/config.mjs";
import { PLUGIN_VERSION } from "../lib/util/plugin.mjs";
import { exitCodeFor, JobViewBusy, jobViewJson, loadJobViewSettled as loadJobView, renderJobBlock, renderJobList, renderResultText, sortViewsNewestFirst } from "../lib/jobs/view.mjs";

const STATUS_LIST_LIMIT = 20;


// `--state-only` prints the state block without `---` and the report: what a string-return
// relay (a workflow subagent) types as its final text, so the report never goes through it.
export function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json", "state-only"] });
  const view = loadJobView(resolveJobReference(positionals[0], "result"));
  if (options.json) {
    outputResult({ ...jobViewJson(view), report: view.hasReport && !options["state-only"] ? view.report : null }, true);
  } else {
    process.stdout.write(options["state-only"] ? renderJobBlock(view) : renderResultText(view));
  }
  process.exitCode = exitCodeFor(view);
}


export function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "workflow"],
    booleanOptions: ["json", "all"]
  });
  if (positionals[0]) {
    const view = loadJobView(findJobDir(positionals[0]));
    outputResult(options.json ? jobViewJson(view) : renderJobBlock(view), options.json);
    return;
  }
  const cwd = resolveCommandCwd(options);
  // `--workflow <run>`: every job one Workflow run started, in any repository, however many.
  const workflow = typeof options.workflow === "string" ? options.workflow.trim() : null;
  const slug = options.all || workflow ? null : repoSlugFor(cwd);
  let dirs = listJobDirs({ slug });
  if (workflow) {
    dirs = dirs.filter((dir) => readJob(dir)?.relay?.workflowRunId === workflow);
  } else if (!options.all) {
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
  if (options.json) {
    outputResult({ jobsHome: resolveJobsHome(), repoSlug: slug, jobs: views.map(jobViewJson) }, true);
    return;
  }
  const config = readRepoConfig(cwd);
  const header = `jobs-home: ${resolveJobsHome()}\n${slug ? `repo: ${slug}\n` : ""}review-gate: ${config.stopReviewGate ? "enabled" : "disabled"}\nfast-tier: ${readUserConfig().fastTier}\nrelay-version: ${PLUGIN_VERSION}\n`;
  outputResult(header + renderJobList(views, { scope: workflow ? `for workflow ${workflow}` : slug ? "for this repository" : "" }), false);
}
