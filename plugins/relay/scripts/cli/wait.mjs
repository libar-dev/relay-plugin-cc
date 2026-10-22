import { parseCommandInput, envNumber, sleep, printJson } from "./shared.mjs";
import { default as process } from "node:process";
import { resumeDeadJobOnce } from "../lib/worker/recovery.mjs";
import { findJobDir, jobPaths, readJsonOrNull } from "../lib/jobs/store.mjs";
import { UsageError } from "../lib/jobs/request.mjs";
import { EXIT, exitCodeFor, isTerminalView, JobViewBusy, jobViewJson, loadJobView, renderJobBlock, renderJobWithReport } from "../lib/jobs/view.mjs";

const DEFAULT_WAIT_TIMEOUT_SECONDS = 240;


// ---------------------------------------------------------------------------------------
// Readers

// What a relay's wait prints first when it times out on a job that still runs. The relay hook
// adds `--exit-zero-while-running`: the Bash tool shows every non-zero exit as an error (in the
// workflows view too), and a job that is still running is not one. The relay runs wait again on
// this line instead of on exit 4.
const STILL_RUNNING_LINE = "still running: not an error. Run the same wait again.";


export async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["timeout-seconds", "wake-after"],
    booleanOptions: ["json", "auto-resume", "state-only", "exit-zero-while-running"]
  });
  const wakeAfter = options["wake-after"] == null ? null : Date.parse(options["wake-after"]);
  if (wakeAfter !== null && !Number.isFinite(wakeAfter)) {
    throw new UsageError("--wake-after must be an ISO date.");
  }
  const jobDir = findJobDir(positionals[0]);
  const wake = jobPaths(jobDir).wake;
  const timeoutSeconds = options["timeout-seconds"] != null ? Number(options["timeout-seconds"]) : DEFAULT_WAIT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new UsageError("--timeout-seconds must be a number of seconds.");
  }
  const pollMs = envNumber("RELAY_JOBS_WAIT_POLL_MS", 1000);
  const deadline = Date.now() + timeoutSeconds * 1000;
  // A busy job (its record changed during every pass of a view) is polled again, never shown.
  /** @type {Error | null} */
  let busy = null;
  const read = () => {
    try { busy = null; return loadJobView(jobDir); }
    catch (error) { if (!(error instanceof JobViewBusy)) throw error; busy = error; return null; }
  };
  let view = read();
  for (;;) {
    if (view && options["auto-resume"] && view.state === "dead" && Date.now() < deadline) {
      const recovery = await resumeDeadJobOnce(jobDir);
      if (recovery === "busy") {
        await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
        view = read();
        continue;
      }
      view = read();
    }
    if ((view && isTerminalView(view)) || Date.now() >= deadline) break;
    if (wakeAfter !== null && Date.parse(readJsonOrNull(wake)?.at) > wakeAfter) break;
    await sleep(Math.max(10, Math.min(busy ? 20 : pollMs, deadline - Date.now())));
    view = read();
  }
  if (!view) {
    // Still busy at the deadline: it is at work, as a job that still runs is.
    if (options.json) {
      printJson("wait", { error: { kind: "busy", message: busy ? busy.message : "The job is busy. Try again." } });
      process.exitCode = EXIT.running;
      return;
    }
    if (options["exit-zero-while-running"]) process.stdout.write(`${STILL_RUNNING_LINE}\n`);
    process.stderr.write(`${busy ? busy.message : "The job is busy. Try again."}\n`);
    process.exitCode = options["exit-zero-while-running"] ? EXIT.ok : EXIT.running;
    return;
  }
  const stillRunning = Boolean(options["exit-zero-while-running"]) && !isTerminalView(view);
  if (options.json) {
    printJson("wait", { ...jobViewJson(view), report: view.hasReport && !options["state-only"] ? view.report : null });
  } else {
    process.stdout.write(`${stillRunning ? `${STILL_RUNNING_LINE}\n` : ""}${options["state-only"] ? renderJobBlock(view) : renderJobWithReport(view)}`);
  }
  process.exitCode = stillRunning ? EXIT.ok : exitCodeFor(view);
}
