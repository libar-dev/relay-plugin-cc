import { parseCommandInput, requireTaskJob, readMessageText, printJson } from "./shared.mjs";
import { default as process } from "node:process";
import { deliverMessage } from "../lib/worker/delivery.mjs";
import { findJobDir } from "../lib/jobs/store.mjs";
import { UsageError } from "../lib/jobs/request.mjs";
import { EXIT, isTerminalView, JobViewBusy, loadJobViewSettled as loadJobView } from "../lib/jobs/view.mjs";
import { DEFAULT_RESUME_MESSAGE } from "../lib/worker/recovery.mjs";


// The job's state once the message is in its inbox, or null while the job is busy. A busy read
// here is no failed send: the command still reports the delivery, so it is never sent twice.
function stateAfterDelivery(jobDir) {
  try { return loadJobView(jobDir).state; }
  catch (error) { if (error instanceof JobViewBusy) return null; throw error; }
}


function renderDelivery(job, kind, delivery, state) {
  const lines = [
    `job: ${job.id}`,
    `message: ${kind} ${delivery.message.id}`,
    `outcome: ${delivery.outcome?.action ?? "pending (no worker has taken it yet)"}`
  ];
  if (delivery.outcome?.action === "not-started") lines.push(`not delivered: ${delivery.outcome.reason}; send it again later`);
  if (delivery.outcome?.turnId) {
    lines.push(`turn: ${delivery.outcome.turnId}`);
  }
  if (delivery.outcome?.attempt) {
    lines.push(`attempt: ${delivery.outcome.attempt}`);
  }
  if (delivery.outcome?.reason) {
    lines.push(`reason: ${String(delivery.outcome.reason).replace(/\s+/g, " ")}`);
  }
  lines.push(state ? `state: ${state}` : `note: the job is busy, so its state is not shown; status ${job.id} shows it`);
  return `${lines.join("\n")}\n`;
}


// ---------------------------------------------------------------------------------------
// Messages to a job

export async function handleSteerOrContinue(kind, argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["message-file", "message"],
    booleanOptions: ["json"]
  });
  const jobDir = findJobDir(positionals[0]);
  const job = requireTaskJob(jobDir);
  const text = readMessageText(options);
  if (!text.trim()) {
    throw new UsageError("The message is empty.");
  }
  const delivery = await deliverMessage(jobDir, kind, text);
  const state = stateAfterDelivery(jobDir);
  if (options.json) printJson(kind, { job: job.id, ...delivery, state });
  else process.stdout.write(renderDelivery(job, kind, delivery, state));
  if (delivery.outcome?.action === "not-started") process.exitCode = EXIT.notStarted;
  else if (!delivery.outcome) {
    process.exitCode = EXIT.running;
  }
}


export async function handleResume(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["message-file", "message"],
    booleanOptions: ["json"]
  });
  const jobDir = findJobDir(positionals[0]);
  const job = requireTaskJob(jobDir);
  // Busy here, nothing is sent yet: the companion says the job is busy, and exits 4.
  const view = loadJobView(jobDir);
  if (!isTerminalView(view)) {
    throw new UsageError(`Job ${view.job.id} is ${view.state} with a live worker. Use steer or continue.`);
  }
  const text = readMessageText(options, { required: false, fallback: null });
  const delivery = await deliverMessage(jobDir, "resume", text ?? DEFAULT_RESUME_MESSAGE, { isDefault: text == null });
  const state = stateAfterDelivery(jobDir);
  if (options.json) printJson("resume", { job: job.id, ...delivery, state });
  else process.stdout.write(renderDelivery(job, "resume", delivery, state));
  if (delivery.outcome?.action === "not-started") process.exitCode = EXIT.notStarted;
  else if (!delivery.outcome) {
    process.exitCode = EXIT.running;
  }
}
