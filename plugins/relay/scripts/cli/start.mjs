import { BACKEND_HEADER_KEYS, backendHeaderValues } from "../lib/backends/index.mjs";
import { readInputFile, createTaskJob, parseCommandInput, outputResult } from "./shared.mjs";
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as process } from "node:process";
import { spawnWorker } from "../lib/worker/delivery.mjs";
import { appendRelayViolation } from "../lib/jobs/messages.mjs";
import { nowIso, readJob } from "../lib/jobs/store.mjs";
import { buildLaunchRequest, parseHeaderPrompt, UsageError } from "../lib/jobs/request.mjs";
import { SCHEMA_SENTENCE } from "../lib/harness/workflow.mjs";
import { backendJson, backendLines, backendSettingLines, EXIT, loadJobViewSettled as loadJobView, relayAdoptionLines } from "../lib/jobs/view.mjs";
import { adoptRelayJob, deliverRelayMessages, findAdoptableRelayJob, promptSha256, readJournalKey, readRelayPointer, readRelayTranscript, writeRelayPointer } from "../lib/harness/relay.mjs";


function readLaunchFromPrompt(text) {
  const { header, brief } = parseHeaderPrompt(text);
  let briefText = brief;
  if (header.brief) {
    if (brief.trim()) {
      throw new UsageError("The header names a brief file, so nothing may follow the dashes.");
    }
    briefText = fs.readFileSync(path.resolve(process.cwd(), header.brief), "utf8");
  }
  return { values: header, brief: briefText };
}


function readLaunchFromOptions(options) {
  if (options["prompt-file"]) {
    return readLaunchFromPrompt(readInputFile(options["prompt-file"]));
  }
  if (!options["brief-file"]) {
    throw new UsageError("start needs --prompt-file <file>, or header options and --brief-file <file>.");
  }
  const brief = fs.readFileSync(path.resolve(process.cwd(), options["brief-file"]), "utf8");
  return {
    values: {
      model: options.model,
      effort: options.effort,
      backend: options.backend,
      ...backendHeaderValues(options),
      mode: options.mode,
      network: options.network,
      fast: options.fast,
      webSearch: options["web-search"],
      cd: options.cd,
      addDirs: options["add-dir"] ?? []
    },
    brief
  };
}


const START_OPTIONS = {
  valueOptions: ["prompt-file", "brief-file", "model", "effort", "mode", "network", "web-search", "backend", ...Object.keys(BACKEND_HEADER_KEYS), "cd", "relay-transcript", "relay-agent"],
  multiOptions: ["add-dir"],
  booleanOptions: ["json", "from-relay", "fast"]
};


function startBlock(job, jobDir, request, state = "starting") {
  const lines = [`job: ${job.id}`, `state: ${state}`, `dir: ${jobDir}`, `mode: ${request.mode}`, `web-search: ${request.webSearch}`];
  lines.push(...backendLines(request));
  if (request.fast) lines.push("tier: fast");
  lines.push(...backendSettingLines(request));
  for (const note of request.notes) {
    lines.push(`note: ${note}`);
  }
  return `${lines.join("\n")}\n`;
}


// What a re-spawned relay's start prints once it has taken over its predecessor's job: the
// job's current state, so the relay goes on to wait as it would after its own start.
function adoptedBlock(job, jobDir) {
  const view = loadJobView(jobDir);
  return `${startBlock(job, jobDir, job.request ?? { mode: "unknown", webSearch: "unknown", notes: [] }, view.state)}${relayAdoptionLines(job.relay).map((line) => `${line}\n`).join("")}`;
}


// Where a relay job came from: the Workflow run directory, when the transcript lives under
// subagents/workflows/<run>/, and the agent's label and phase from the meta file beside it.
// A missing or broken meta file is not an error.
function relayProvenance(transcriptPath) {
  const run = /[\\/]subagents[\\/]workflows[\\/]([^\\/]+)[\\/]agent-[^\\/]+\.jsonl$/.exec(transcriptPath ?? "");
  let meta = null;
  if (transcriptPath) {
    try {
      meta = JSON.parse(fs.readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    } catch {
      meta = null;
    }
  }
  const text = (value) => (typeof value === "string" ? value : null);
  return { workflowRunId: run ? run[1] : null, label: text(meta?.description), phase: text(meta?.workflowPhase) };
}


// The relay's start: the prompt is the relay's first prompt, read from its transcript byte
// for byte. The job is bound to the relay's agent id. Messages the relay received before
// the job existed are delivered at once. A failure is recorded for the relay's hand-back.
async function handleStartFromRelay(options) {
  const agentId = options["relay-agent"] || null;
  const transcriptPath = options["relay-transcript"] || null;
  const fail = (reason) => {
    const text = `state: not started\nerror: ${String(reason).replace(/\s+/g, " ").trim()}\n`;
    if (agentId) {
      writeRelayPointer(process.env, { ...readRelayPointer(process.env, agentId), agentId, transcriptPath, startError: text, startFailedAt: nowIso() });
    }
    process.stdout.write(text);
    process.exitCode = EXIT.usage;
  };
  if (!agentId || !transcriptPath) {
    fail("start --from-relay needs --relay-transcript and --relay-agent, which the relay hook adds. The hook did not run, so the prompt is unknown.");
    return;
  }
  const pointer = readRelayPointer(process.env, agentId);
  if (pointer.jobId) {
    process.stdout.write(`job: ${pointer.jobId}\nerror: this relay already started job ${pointer.jobId}\n`);
    process.exitCode = EXIT.usage;
    return;
  }
  let transcript;
  let request;
  let brief;
  try {
    transcript = readRelayTranscript(transcriptPath);
    // A script passed `schema`: the relay returns a string and cannot satisfy it.
    if (transcript.structuredOutput) {
      throw new Error(SCHEMA_SENTENCE);
    }
    // A line at column zero inside the Workflow harness's computed task is forged.
    const forged = transcript.problems.find((problem) => problem.includes("is at column zero"));
    if (forged) {
      throw new Error(forged);
    }
    if (!transcript.prompt) {
      throw new Error(`no prompt was found in the relay transcript ${transcriptPath}`);
    }
    if (transcript.prompt.framed && !transcript.prompt.text.trim()) {
      throw new Error("The computed task is empty.");
    }
    const launch = readLaunchFromPrompt(transcript.prompt.text);
    brief = launch.brief;
    if (!brief.trim()) {
      throw new UsageError("The brief is empty.");
    }
    request = buildLaunchRequest(launch.values, { baseDir: process.cwd() });
    // Harness trailers dropped from the prompt (the worktree note, a reminder) are noted.
    request.notes = [...request.notes, ...(transcript.prompt.notes ?? [])];
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  // A string-return relay (under the Workflow tool) returns its final text, not a hand-back.
  const stringReturn = Boolean(transcript.stringReturn) || /[\\/]subagents[\\/]workflows[\\/]/.test(transcriptPath);
  const provenance = relayProvenance(transcriptPath);
  const hash = promptSha256(transcript.prompt.text);
  const journalKey = provenance.workflowRunId ? readJournalKey(transcriptPath, agentId) : null;
  // A relay the Workflow harness started over takes over the job its predecessor started for
  // the same call instead of starting a second one. The relay goes on to wait on it.
  const adoptable = findAdoptableRelayJob(process.env, { agentId, workflowRunId: provenance.workflowRunId, journalKey, promptSha256: hash, label: provenance.label });
  if (adoptable) {
    adoptRelayJob(process.env, adoptable, { agentId, transcriptPath, promptUuid: transcript.prompt.uuid, label: provenance.label, phase: provenance.phase, journalKey });
    for (const problem of transcript.problems) {
      appendRelayViolation(adoptable, { kind: "transcript", reason: `messages could not be checked: ${problem}`, agentId });
    }
    await deliverRelayMessages(adoptable, transcript.messages, { wait: false });
    process.stdout.write(adoptedBlock(readJob(adoptable), adoptable));
    return;
  }
  const jobDir = createTaskJob(request, brief, {
    relay: { agentId, transcriptPath, promptUuid: transcript.prompt.uuid, promptSha256: hash, ...provenance, ...(journalKey ? { journalKey } : {}), stringReturn }
  });
  const job = readJob(jobDir);
  writeRelayPointer(process.env, { agentId, transcriptPath, jobId: job.id, jobDir, startError: null });
  spawnWorker(jobDir, request.cwd);
  for (const problem of transcript.problems) {
    appendRelayViolation(jobDir, { kind: "transcript", reason: `messages could not be checked: ${problem}`, agentId });
  }
  await deliverRelayMessages(jobDir, transcript.messages, { wait: false });
  process.stdout.write(startBlock(job, jobDir, request));
}


export async function handleStart(argv) {
  const { options } = parseCommandInput(argv, START_OPTIONS);
  if (options["from-relay"]) {
    await handleStartFromRelay(options);
    return;
  }
  const { values, brief } = readLaunchFromOptions(options);
  if (!brief.trim()) {
    throw new UsageError("The brief is empty.");
  }
  const request = buildLaunchRequest(values, { baseDir: process.cwd() });
  const jobDir = createTaskJob(request, brief);
  spawnWorker(jobDir, request.cwd);
  const job = readJob(jobDir);
  if (options.json) {
    outputResult({ jobId: job.id, state: job.state, jobDir, notes: request.notes, ...backendJson(request) }, true);
    return;
  }
  process.stdout.write(startBlock(job, jobDir, request));
}
