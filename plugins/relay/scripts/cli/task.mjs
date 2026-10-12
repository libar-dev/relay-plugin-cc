import { backendNamed, backendWith } from "../lib/backends/index.mjs";
import { parseCommandInput, resolveCommandCwd, createTaskJob, outputResult } from "./shared.mjs";
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { readStdinIfPiped } from "../lib/util/fs.mjs";
import { spawnWorker } from "../lib/worker/delivery.mjs";
import { requireJobDirInHome, jobPaths, readJob } from "../lib/jobs/store.mjs";
import { buildLaunchRequest, UsageError } from "../lib/jobs/request.mjs";
import { loadJobView, renderJobWithReport } from "../lib/jobs/view.mjs";
import { runWorker } from "../lib/worker/worker.mjs";

const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";


// ---------------------------------------------------------------------------------------
// Foreground task: one job, run in this process. The stop review gate uses it.

export async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["backend", "model", "effort", "mode", "cwd", "cd", "prompt-file", "web-search", "network"],
    booleanOptions: ["json", "write", "background"],
    aliasMap: { m: "model" }
  });
  const baseDir = resolveCommandCwd(options);
  let prompt = "";
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(baseDir, options["prompt-file"]), "utf8");
  } else {
    prompt = positionals.join(" ") || readStdinIfPiped();
  }
  if (!String(prompt).trim()) {
    throw new UsageError("Provide a prompt, a prompt file, or piped stdin.");
  }
  const request = buildLaunchRequest(
    {
      backend: options.backend == null ? undefined : backendNamed(options.backend).name,
      model: options.model ?? "default",
      effort: options.effort ?? "default",
      mode: options.write ? "write" : options.mode,
      network: options.network,
      fast: options.fast,
      webSearch: options["web-search"],
      cd: options.cd ?? baseDir
    },
    { baseDir }
  );
  const jobDir = createTaskJob(request, prompt, {
    prefix: "task",
    summary: prompt.includes(STOP_REVIEW_TASK_MARKER) ? `${backendWith("stopGate").label} Stop Gate Review` : null
  });
  if (options.background) {
    spawnWorker(jobDir, request.cwd);
    const job = readJob(jobDir);
    outputResult(options.json ? { jobId: job.id, state: "starting", jobDir } : `job: ${job.id}\nstate: starting\ndir: ${jobDir}\n`, options.json);
    return;
  }
  await runWorker(jobDir);
  const view = loadJobView(jobDir);
  const rawOutput = view.hasReport ? fs.readFileSync(view.paths.report, "utf8") : "";
  if (options.json) {
    outputResult(
      {
        jobId: view.job.id,
        status: view.state === "completed" ? 0 : 1,
        state: view.state,
        sessionId: view.job.sessionId ?? null,
        rawOutput,
        errorMessage: view.job.errorMessage ?? null
      },
      true
    );
  } else {
    process.stdout.write(renderJobWithReport(view));
  }
  if (view.state !== "completed") {
    process.exitCode = 1;
  }
}


export async function handleWorker(argv) {
  const jobDir = argv[0] ? requireJobDirInHome(path.resolve(argv[0])) : null;
  if (!jobDir || !fs.existsSync(jobPaths(jobDir).job)) {
    throw new UsageError("worker needs a job directory.");
  }
  await runWorker(jobDir);
}
