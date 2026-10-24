import path from "node:path";
import { requestRules } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { connect, zcodeEndMessage, zcodeEventRecorder } from "./connection.mjs";

export function accountHome(_request, env = process.env) {
  const home = env.ZCODE_DATA_BASE_DIR?.trim();
  if (!home) return null;
  const defaultHome = env.HOME || env.USERPROFILE;
  return defaultHome && path.resolve(home) === path.resolve(defaultHome) ? null : path.resolve(home);
}

/** @type {import("../types").Backend} */
export const zcodeBackend = {
  name: "zcode",
  label: "ZCode",
  capabilities: {
    modes: ["yolo", "read-only"], webSearch: ["live", "disabled"], priorityTier: false,
    steer: true, resume: true, review: true, adversarialReview: true, stopGate: false, transfer: false
  },
  capabilityNotes: { modes: "write refused", webSearchOff: "tool filter", lacking: "Codex only" },
  request: requestRules,
  accountHome,
  view: { lines() { return []; }, json() { return {}; } },
  eventRecorder: zcodeEventRecorder,
  setup: setupProbe,
  review: { schema: "prompt", inlineDiff: true, inlineDiffAdvice: "or run it on Codex." },

  endMessage: zcodeEndMessage,

  connect
};
