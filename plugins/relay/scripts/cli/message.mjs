import { parseCommandInput, requireTaskJob, readMessageText, outputResult } from "./shared.mjs";
import { default as process } from "node:process";
import { deliverMessage } from "../lib/worker/delivery.mjs";
import { findJobDir } from "../lib/jobs/store.mjs";
import { UsageError } from "../lib/jobs/request.mjs";
import { EXIT, isTerminalView, loadJobViewSettled as loadJobView } from "../lib/jobs/view.mjs";
import { DEFAULT_RESUME_MESSAGE } from "../lib/worker/recovery.mjs";


function renderDelivery(jobDir, kind, delivery) {
  const view = loadJobView(jobDir);
  const lines = [
    `job: ${view.job.id}`,
    `message: ${kind} ${delivery.message.id}`,
    `outcome: ${delivery.outcome?.action ?? "pending (no worker has taken it yet)"}`
  ];
  if (delivery.outcome?.turnId) {
    lines.push(`turn: ${delivery.outcome.turnId}`);
  }
  if (delivery.outcome?.attempt) {
    lines.push(`attempt: ${delivery.outcome.attempt}`);
  }
  if (delivery.outcome?.reason) {
    lines.push(`reason: ${String(delivery.outcome.reason).replace(/\s+/g, " ")}`);
  }
  lines.push(`state: ${view.state}`);
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
  requireTaskJob(jobDir);
  const text = readMessageText(options);
  if (!text.trim()) {
    throw new UsageError("The message is empty.");
  }
  const delivery = await deliverMessage(jobDir, kind, text);
  outputResult(options.json ? { ...delivery, state: loadJobView(jobDir).state } : renderDelivery(jobDir, kind, delivery), options.json);
  if (!delivery.outcome) {
    process.exitCode = EXIT.running;
  }
}


export async function handleResume(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["message-file", "message"],
    booleanOptions: ["json"]
  });
  const jobDir = findJobDir(positionals[0]);
  requireTaskJob(jobDir);
  const view = loadJobView(jobDir);
  if (!isTerminalView(view)) {
    throw new UsageError(`Job ${view.job.id} is ${view.state} with a live worker. Use steer or continue.`);
  }
  const text = readMessageText(options, { required: false, fallback: null });
  const delivery = await deliverMessage(jobDir, "resume", text ?? DEFAULT_RESUME_MESSAGE, { isDefault: text == null });
  outputResult(options.json ? { ...delivery, state: loadJobView(jobDir).state } : renderDelivery(jobDir, "resume", delivery), options.json);
  if (!delivery.outcome) {
    process.exitCode = EXIT.running;
  }
}
