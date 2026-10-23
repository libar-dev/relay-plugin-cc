import { requestRules } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { connect, kimiEndMessage, kimiEventRecorder } from "./connection.mjs";

/** @type {import("../types").Backend} */
export const kimiBackend = {
  name: "kimi",
  label: "Kimi",
  // Over ACP a running Kimi turn takes no message: a steer waits for the next turn.
  capabilities: {
    modes: ["yolo", "read-only"], webSearch: ["live"], priorityTier: false,
    steer: false, resume: true, review: true, adversarialReview: true, stopGate: false, transfer: false
  },
  capabilityNotes: { modes: "write refused", steer: "next turn", lacking: "Codex only" },
  request: requestRules,
  view: {
    lines(request) { return !request.kimiHomeDefault ? [`kimi-home: ${request.kimiHome}`] : []; },
    json(request) { return { kimiHome: request.kimiHome }; }
  },
  eventRecorder: kimiEventRecorder,
  setup: setupProbe,
  review: { schema: "prompt", inlineDiff: true, inlineDiffAdvice: "or run it on Codex." },

  endMessage: kimiEndMessage,
  connect
};
