import { requestRules, resolveGrokHome } from "./request.mjs";
import { setupProbe } from "./setup.mjs";
import { connect, grokEndMessage, grokEventRecorder } from "./connection.mjs";

export function accountHome(request, env = process.env) {
  const home = resolveGrokHome(request.grokHome ?? "default", env);
  return home === resolveGrokHome("default", env) ? null : home;
}

/** @type {import("../types").Backend} */
export const grokBackend = {
  name: "grok",
  label: "Grok",
  capabilities: {
    modes: ["yolo", "write", "read-only"], webSearch: ["live"], priorityTier: false,
    steer: true, resume: true, review: true, adversarialReview: true, stopGate: false, transfer: false
  },
  capabilityNotes: { lacking: "Codex only" },
  request: requestRules,
  accountHome,
  view: {
    lines(request) { return !request.grokHomeDefault ? [`grok-home: ${request.grokHome}`] : []; },
    json(request) { return { grokHome: request.grokHome }; }
  },
  eventRecorder: grokEventRecorder,
  setup: setupProbe,
  review: { schema: "prompt", inlineDiff: true, inlineDiffAdvice: "or run it on Codex." },

  endMessage: grokEndMessage,
  connect
};
