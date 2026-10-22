import process from "node:process";
import { parseArgs } from "../lib/util/args.mjs";
import { UsageError } from "../lib/util/errors.mjs";
import { readRelayPointer } from "../lib/harness/relay.mjs";
import { jobPaths, nowIso, readJob, writeJsonAtomic } from "../lib/jobs/store.mjs";


export function handleWake(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["agent"] });
  const agentId = options.agent;
  if (!agentId) throw new UsageError("--agent <agent id> is required.");
  // A send runs this command even for agents that have never had a relay job.
  const { jobDir } = readRelayPointer(process.env, agentId);
  if (!jobDir) return;
  const job = readJob(jobDir);
  if (!job || job.relay?.agentId !== agentId) return;
  try {
    writeJsonAtomic(jobPaths(jobDir).wake, { agentId, at: nowIso() });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  process.stdout.write(`wake: ${job.id}\n`);
}
