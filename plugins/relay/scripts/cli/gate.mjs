import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { parseCommandInput, sleep } from "./shared.mjs";
import { bindReservation, readReservation, reserveWaitingPlace } from "../lib/worker/admission.mjs";
import { findAdoptableRelayJob, findRelayJob, promptSha256, readJournalKey, readRelayTranscript, transcriptCandidates } from "../lib/harness/relay.mjs";

// A stalled Workflow attempt gets a fresh agent id without agent.spawn. At its
// first step, reuse an existing job or reservation before asking for another place.
function hasAdoptableJob(agentId, transcriptPath, env) {
  if (findRelayJob(env, agentId)) return true;
  for (const file of transcriptCandidates({ agent_id: agentId, transcript_path: transcriptPath })) {
    if (!fs.existsSync(file)) continue;
    const run = /[\\/]workflows[\\/]([^\\/]+)[\\/]agent-[^\\/]+\.jsonl$/.exec(file)?.[1];
    if (!run) continue;
    const transcript = readRelayTranscript(file);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch {}
    if (findAdoptableRelayJob(env, { agentId, workflowRunId: run, journalKey: readJournalKey(file, agentId),
      promptSha256: promptSha256(transcript.prompt?.text), label: meta?.description })) return true;
  }
  return false;
}

export async function handleGate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["wait-seconds", "bind", "agent", "transcript"], booleanOptions: ["retry"] });
  if (options.bind) {
    if (!options.agent) throw new Error("gate --bind needs --agent");
    process.stdout.write(bindReservation(options.bind, options.agent) ? "bound\n" : "expired\n");
    return;
  }
  if (options.agent) {
    const reservation = readReservation(options.agent);
    if (reservation) { process.stdout.write(`pass ${reservation}\n`); return; }
    if (options.retry && hasAdoptableJob(options.agent, options.transcript, process.env)) { process.stdout.write("pass\n"); return; }
  }
  const seconds = Number(options["wait-seconds"] ?? 0);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--wait-seconds must be non-negative");
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const result = reserveWaitingPlace();
    if (result.pass) {
      if (result.reservation && options.agent) bindReservation(result.reservation, options.agent);
      process.stdout.write(`pass${result.reservation ? ` ${result.reservation}` : ""}\n`); return;
    }
    if (Date.now() >= deadline) { process.stdout.write(`hold ${result.reason}\n`); return; }
    await sleep(Math.min(2000 + Math.floor(Math.random() * 1000), Math.max(1, deadline - Date.now())));
  }
}
