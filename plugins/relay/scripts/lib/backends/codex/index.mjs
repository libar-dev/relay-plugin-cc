import path from "node:path";
import os from "node:os";
import { requestRules, codexDefaultHome } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { REVIEW_GATE_NEXT_STEP } from "./setup.mjs";
import { reviewSupport } from "./review.mjs";
import { transfer } from "./transfer.mjs";
import { getCodexAvailabilityWithin } from "./account.mjs";
import { serverEndMessage } from "./client.mjs";
import { connect } from "./connection.mjs";

export function accountHome(_request, env = process.env) {
  const home = codexDefaultHome(env);
  return home === path.resolve(env.HOME || env.USERPROFILE || os.homedir(), ".codex") ? null : home;
}



// Codex sends `turn/diff/updated` with the turn's whole diff so far after every change, and those
// copies were most of a job directory's bytes. Only the last one of each turn is kept, by thread
// and turn, since a subagent's turns interleave with the parent's: it is written just before that
// turn's own `turn/completed`, or when the worker ends.
/** @type {import("../types").Backend["eventRecorder"]} */
export function codexEventRecorder(write, touch) {
  /** @type {Map<string, any>} */
  const diffs = new Map();
  const key = (threadId, turnId) => `${threadId ?? ""}\u0000${turnId ?? ""}`;
  return {
    record(notification) {
      touch();
      const params = notification.params ?? {};
      if (notification.method === "turn/diff/updated") {
        const id = key(params.threadId, params.turnId);
        diffs.delete(id);
        diffs.set(id, notification);
        return;
      }
      if (notification.method === "turn/completed") {
        const id = key(params.threadId, params.turn?.id);
        const diff = diffs.get(id);
        if (diff) write(diff);
        diffs.delete(id);
      }
      write(notification);
    },
    flush() {
      for (const diff of diffs.values()) write(diff);
      diffs.clear();
    }
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
  accountHome,
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
