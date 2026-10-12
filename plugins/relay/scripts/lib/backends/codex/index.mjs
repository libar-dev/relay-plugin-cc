import { requestRules } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { REVIEW_GATE_NEXT_STEP } from "./setup.mjs";
import { reviewSupport } from "./review.mjs";
import { transfer } from "./transfer.mjs";
import { getCodexAvailabilityWithin } from "./account.mjs";
import { serverEndMessage } from "./client.mjs";
import { connect } from "./connection.mjs";


/** @type {import("../types").Backend} */
export const codexBackend = {
  name: "codex",
  label: "Codex",
  capabilities: {
    modes: ["yolo", "write", "read-only"], webSearch: ["live", "cached", "indexed", "disabled"], priorityTier: true,
    steer: true, resume: true, review: true, adversarialReview: true, stopGate: true, transfer: true
  },
  capabilityNotes: {},
  request: requestRules,
  view: {
    settingLines(request) {
      const mcpOff = /** @type {string[] | undefined} */ (request.mcpOff);
      return mcpOff?.length > 0 ? [`mcp-off: ${mcpOff.join(", ")}`] : [];
    },
    lines() { return []; },
    json() { return {}; },
    completionInferenceLine(inference, { sessionId, turnId }) {
      if (inference.threadId !== sessionId || inference.turnId !== turnId) return null;
      return `note: turn completion inferred; Codex sent no turn/completed${inference.reason ? `; thread/read: ${inference.reason}` : ""}`;
    }
  },
  eventRecorder(write, touch) { return { record(notification) { touch(); write(notification); }, flush() {} }; },
  setup: { ...setupProbe, reviewGateNextStep: REVIEW_GATE_NEXT_STEP },
  review: reviewSupport,
  transfer,
  probe: getCodexAvailabilityWithin,

  endMessage: serverEndMessage,
  connect
};
