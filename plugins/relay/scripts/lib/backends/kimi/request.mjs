import os from "node:os";
import path from "node:path";
import process from "node:process";
import { UsageError } from "../../util/errors.mjs";

function kimiHomeSelection(value, env = process.env) {
  const text = String(value ?? "default").trim() || "default";
  return { path: resolveKimiHomePath(text, env), isDefault: text === "default" };
}
export function resolveKimiHome(value, env = process.env) { return kimiHomeSelection(value, env).path; }

// The sign-in a home needs. Without --region, Kimi signs a home with no stored login and no
// region marker in to mainland China (kimi.com), so the command names the region.
export function kimiLoginCommand(home) { return `KIMI_CODE_HOME=${home} kimi login --region global`; }
export const KIMI_REGION_HINT = "--region mainland-cn for a kimi.com account";
function resolveKimiHomePath(text, env) {
  const userDir = env.HOME || env.USERPROFILE || os.homedir();
  if (text === "default") return path.join(userDir, ".kimi-code");
  if (path.isAbsolute(text)) return path.resolve(text);
  if (text.startsWith("~/")) return path.resolve(userDir, text.slice(2));
  if (/^[a-z0-9][a-z0-9-]*$/.test(text)) return path.join(userDir, `.kimi-code-${text}`);
  throw new UsageError(`kimi-home must be a name, an absolute path or a ~/ path, not "${text}".`);
}

/** @type {import("../types").RequestRules} */
export const requestRules = {
  headerKeys: { "kimi-home": "kimiHome" },
  defaultSource: "use Kimi's own default",
  defaultEffort: null,
  refusals: {
    mode: { write: ": it has no workspace sandbox, and its shell can write anywhere. Use mode: yolo, or mode: read-only." },
    webSearch: "; ACP cannot remove Kimi's web tools, so only live is supported."
  },
  priorityTierNote: "fast: true is ignored for Kimi; it is an OpenAI service tier.",
  complete(request, values, { env }) {
    if (request.mode === "read-only" && values.network != null) {
      request.notes.push("Kimi has no sandbox: read-only refuses its file writes and shell commands, and web-search decides its web tools.");
    }
    const home = kimiHomeSelection(values.kimiHome, env);
    return { kimiHome: home.path, kimiHomeDefault: home.isDefault };
  }
};
