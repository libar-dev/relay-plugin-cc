#!/usr/bin/env node

import { handleStart } from "./cli/start.mjs";
import { handleCheckHeader } from "./cli/check-header.mjs";
import { handleWait } from "./cli/wait.mjs";
import { handleWake } from "./cli/wake.mjs";
import { handleStatus, handleResult } from "./cli/status.mjs";
import { handleSteerOrContinue, handleResume } from "./cli/message.mjs";
import { handleCancel } from "./cli/cancel.mjs";
import { handleTask, handleWorker } from "./cli/task.mjs";
import { handleSetup } from "./cli/setup.mjs";
import { handleReviewCommand, validateNativeReviewRequest } from "./cli/review.mjs";
import { handleTransfer } from "./cli/transfer.mjs";
import { default as process } from "node:process";
import { handlePrune } from "./cli/prune.mjs";
import { AttemptChanged, JobNotFound, UsageError } from "./lib/util/errors.mjs";
import { jsonRequested, printJson } from "./cli/shared.mjs";
import { BACKENDS } from "./lib/backends/index.mjs";
import { EXIT, JobViewBusy } from "./lib/jobs/view.mjs";


function printUsage() {
  const names = BACKENDS.map(backend => backend.name).join("|");
  const homeFlags = BACKENDS.flatMap(backend => backend.setup.homeFlag ? [`[--${backend.setup.homeFlag} <name|path|default>]`] : []).join(" ");
  console.log(
    [
      "Usage:",
      "  companion.mjs check-header   (reads a relay:job prompt on stdin; prints ok, or error: <the reason start would refuse it>)",
      "  companion.mjs start --prompt-file <header+brief file> [--json]",
      "  companion.mjs start --from-relay [--json]        (the relay:job relay; its hook adds the transcript and agent id)",
      "  companion.mjs start --model <m> --effort <e> [--mode yolo|write|read-only] [--network true|false]",
      `                            [--fast] [--backend ${names}] ${homeFlags} [--web-search live|cached|disabled]`,
      "                            [--cd <dir>] [--add-dir <dir>]... --brief-file <f> [--json]",
      "  companion.mjs wait <job> [--timeout-seconds N] [--wake-after ISO] [--state-only] [--exit-zero-while-running] [--json]",
      "  companion.mjs wake --agent <agent id>",
      "  companion.mjs status [<job>] [--all | --workflow <run>] [--json] [--limit N] [--cursor C] [--active]",
      "  companion.mjs result <job> [--state-only] [--json]",
      "  companion.mjs steer <job> --message-file <f> [--json]",
      "  companion.mjs continue <job> --message-file <f> [--json]",
      "  companion.mjs resume <job> [--message-file <f>] [--json]",
      "  companion.mjs cancel <job> [--attempt N] [--json]",
      "  companion.mjs prune [--older-than <duration>] [--all] [--dry-run]",
      "  companion.mjs task [--model <m>] [--effort <e>] [--mode <mode>] [--write] [--cd <dir>] [--json] [--prompt-file <f> | prompt]",
      "  companion.mjs setup [--enable-review-gate|--disable-review-gate] [--fast-tier allowed|off] [--job-mcp-off names|none] [--json]",
      `  companion.mjs setup --backend ${names} ${homeFlags} [--json]`,
      `  companion.mjs review [--wait|--background] [--backend ${names}] [--model <m>] [--effort <e>]`,
      `                            ${homeFlags} [--base <ref>] [--scope <auto|working-tree|branch>] [--json]`,
      "  companion.mjs adversarial-review [the same options as review] [focus text] [--json]",
      "  companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "",
      "Exit codes of wait and result: 0 completed with a report, 3 ended without a report (dead or failed) or with messages not yet run,",
      "4 still running, 5 cancelled (also with messages not yet run; cancellation takes precedence), 1 usage error."
    ].join("\n")
  );
}


// The commands that take `--json`. Under it, an error is JSON on stdout too.
const JSON_COMMANDS = new Set(["status", "result", "wait", "start", "task", "steer", "continue", "resume", "cancel", "setup", "review", "adversarial-review", "transfer"]);

const [subcommand, ...argv] = process.argv.slice(2);


async function main() {
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "check-header":
      handleCheckHeader(argv);
      break;
    case "start":
      await handleStart(argv);
      break;
    case "wait":
      await handleWait(argv);
      break;
    case "wake":
      handleWake(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "steer":
      await handleSteerOrContinue("steer", argv);
      break;
    case "continue":
      await handleSteerOrContinue("continue", argv);
      break;
    case "resume":
      await handleResume(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "prune": {
      handlePrune(argv);
      break;
    }
    case "task":
      await handleTask(argv);
      break;
    case "worker":
      await handleWorker(argv);
      break;
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review", validateRequest: validateNativeReviewRequest });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    default:
      throw new UsageError(`Unknown subcommand: ${subcommand}`);
  }
}


main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (JSON_COMMANDS.has(subcommand) && jsonRequested(argv)) {
    const kind = error instanceof JobViewBusy ? "busy" : error instanceof AttemptChanged ? "attempt-changed" : error instanceof JobNotFound ? "not-found" : error instanceof UsageError ? "usage" : "error";
    printJson(subcommand, { error: { kind, message } });
  } else {
    process.stderr.write(`${message}\n`);
  }
  // A job whose record kept changing is at work: not a usage error, and not a state.
  process.exitCode = error instanceof JobViewBusy ? EXIT.running : EXIT.usage;
});
