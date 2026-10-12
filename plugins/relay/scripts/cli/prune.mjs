import process from "node:process";
import { parseCommandInput } from "./shared.mjs";
import { UsageError } from "../lib/jobs/request.mjs";
import { pruneJobs } from "../lib/jobs/prune.mjs";

export function handlePrune(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["older-than"], booleanOptions: ["all", "dry-run"]
  });
  if (positionals.length) throw new UsageError(`Unexpected prune argument: ${positionals[0]}`);
  process.stdout.write(pruneJobs({ olderThan: options["older-than"], all: options.all, dryRun: options["dry-run"] }));
}
