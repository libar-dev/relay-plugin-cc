import { ZCODE_DEFAULT_EFFORT } from "./defaults.mjs";

/** @type {import("../types").RequestRules} */
export const requestRules = {
  headerKeys: {},
  defaultSource: "use ZCode's default model, or effort high",
  defaultEffort: ZCODE_DEFAULT_EFFORT,
  refusals: {
    mode: { write: ": it has no workspace sandbox, and its edit mode lets shell commands write anywhere. Use mode: yolo, or mode: read-only." },
    webSearch: "; use live or disabled."
  },
  priorityTierNote: "fast: true is ignored for ZCode; it is an OpenAI service tier.",
  complete(request, values) {
    if (request.mode === "read-only" && values.network != null) {
      request.notes.push("ZCode has no sandbox: read-only removes its write, shell and code tools, and web-search decides its web tools.");
    }
    return {};
  }
};
