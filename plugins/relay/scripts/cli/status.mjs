import { parseCommandInput, resolveJobReference, outputResult, resolveCommandCwd } from "./shared.mjs";
import { default as process } from "node:process";
import { findJobDir, listJobDirs, repoSlugFor, resolveJobsHome } from "../lib/jobs/store.mjs";
import { readRepoConfig, readUserConfig } from "../lib/jobs/config.mjs";
import { exitCodeFor, jobViewJson, loadJobViewSettled as loadJobView, renderJobBlock, renderJobList, renderResultText, sortViewsNewestFirst } from "../lib/jobs/view.mjs";

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
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });
  if (positionals[0]) {
    const view = loadJobView(findJobDir(positionals[0]));
    outputResult(options.json ? jobViewJson(view) : renderJobBlock(view), options.json);
    return;
  }
  const cwd = resolveCommandCwd(options);
  const slug = options.all ? null : repoSlugFor(cwd);
  let views = [];
  for (const dir of listJobDirs({ slug })) {
    try {
      views.push(loadJobView(dir));
    } catch {
      // A job directory being created right now has no job.json yet.
    }
  }
  views = sortViewsNewestFirst(views);
  if (!options.all) {
    views = views.slice(0, STATUS_LIST_LIMIT);
  }
  if (options.json) {
    outputResult({ jobsHome: resolveJobsHome(), repoSlug: slug, jobs: views.map(jobViewJson) }, true);
    return;
  }
  const config = readRepoConfig(cwd);
  const header = `jobs-home: ${resolveJobsHome()}\n${slug ? `repo: ${slug}\n` : ""}review-gate: ${config.stopReviewGate ? "enabled" : "disabled"}\nfast-tier: ${readUserConfig().fastTier}\n`;
  outputResult(header + renderJobList(views, { scope: slug ? "for this repository" : "" }), false);
}
