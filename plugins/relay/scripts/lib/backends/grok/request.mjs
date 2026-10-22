import os from "node:os";
import path from "node:path";
import process from "node:process";
import { UsageError } from "../../util/errors.mjs";

function grokHomeSelection(value, env = process.env) {
  const text = String(value ?? "default").trim() || "default";
  return { path: resolveGrokHomePath(text, env), isDefault: text === "default" };
}
export function resolveGrokHome(value, env = process.env) { return grokHomeSelection(value, env).path; }
function resolveGrokHomePath(text, env) {
  const userDir = env.HOME || env.USERPROFILE || os.homedir();
  if (text === "default") return path.join(userDir, ".grok");
  if (path.isAbsolute(text)) return path.resolve(text);
  if (text.startsWith("~/")) return path.resolve(userDir, text.slice(2));
  if (/^[a-z0-9][a-z0-9-]*$/.test(text)) return path.join(userDir, `.grok-${text}`);
  throw new UsageError(`grok-home must be a name, an absolute path or a ~/ path, not "${text}".`);
}

/** @type {import("../types").RequestRules} */
export const requestRules = {
  headerKeys: { "grok-home": "grokHome" },
  defaultSource: "use Grok's own default",
  defaultEffort: null,
  modelFamily: /^grok-/i,
  refusals: { webSearch: "; disabling web_search and web_fetch has not been proved in agent mode." },
  priorityTierNote: "fast: true is ignored for Grok; select model: grok-4.7-build-fast instead.",
  complete(request, values, { env }) {
    if (request.mode === "write" && request.writableRoots.length > 0) {
      throw new UsageError("Grok mode: write cannot add writable roots for add-dir or a linked git worktree. Use mode: yolo for this working directory or these extra roots.");
    }
    if (request.mode !== "yolo" && values.network != null) {
      request.notes.push("Grok's sandbox profile decides child-process network; macOS does not enforce it.");
    }
    const home = grokHomeSelection(values.grokHome, env);
    return { grokHome: home.path, grokHomeDefault: home.isDefault };
  }
};
