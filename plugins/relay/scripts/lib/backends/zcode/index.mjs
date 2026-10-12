import { requestRules } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { connect, zcodeEndMessage, zcodeEventRecorder } from "./connection.mjs";

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
  view: { lines() { return []; }, json() { return {}; } },
  eventRecorder: zcodeEventRecorder,
  setup: setupProbe,
  review: { schema: "prompt", inlineDiff: true, inlineDiffAdvice: "or run it on Codex." },

  endMessage: zcodeEndMessage,

  connect
};
