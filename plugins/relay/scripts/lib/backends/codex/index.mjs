import { requestRules } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { REVIEW_GATE_NEXT_STEP } from "./setup.mjs";
import { reviewSupport } from "./review.mjs";
import { transfer } from "./transfer.mjs";
import { getCodexAvailabilityWithin } from "./account.mjs";
import { serverEndMessage } from "./client.mjs";
import { connect } from "./connection.mjs";


// Codex sends `turn/diff/updated` with the turn's whole diff so far after every change, and those
// copies were most of a job directory's bytes. Only the last one of a turn is kept: it is written
// before the turn's `turn/completed`, before another turn's diff, or when the worker ends.
/** @type {import("../types").Backend["eventRecorder"]} */
export function codexEventRecorder(write, touch) {
  /** @type {any} */
  let diff = null;
  const writeDiff = () => {
    if (diff) write(diff);
    diff = null;
  };
  return {
    record(notification) {
      touch();
      if (notification.method === "turn/diff/updated") {
        if (diff && diff.params?.turnId !== notification.params?.turnId) writeDiff();
        diff = notification;
        return;
      }
      if (notification.method === "turn/completed") writeDiff();
      write(notification);
    },
    flush: writeDiff
  };
}

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
  eventRecorder: codexEventRecorder,
  setup: { ...setupProbe, reviewGateNextStep: REVIEW_GATE_NEXT_STEP },
  review: reviewSupport,
  transfer,
  probe: getCodexAvailabilityWithin,

  endMessage: serverEndMessage,
  connect
};
