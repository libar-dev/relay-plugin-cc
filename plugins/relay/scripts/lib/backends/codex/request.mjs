import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { UsageError } from "../../util/errors.mjs";

const MODES = new Map([
  ["yolo", "danger-full-access"],
  ["write", "workspace-write"],
  ["read-only", "read-only"]
]);
// The simple TOML read covers the header form Codex homes use for stdio servers. It is not
// a TOML parser: a setting for a server this does not find is skipped and reported, never
// passed to Codex.
function mcpServersInConfig(codexHome) {
  try {
    const text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    return new Set([...text.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*([^\]\s.]+)\s*\]\s*(?:#.*)?$/gm)]
      .map((match) => match[1].replace(/^(["'])(.*)\1$/, "$2")));
  } catch {
    return new Set();
  }
}

// The one Codex home: `CODEX_HOME`, else `~/.codex`.
export function codexDefaultHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex"));
}

// thread/start and thread/resume `config` overrides for a request.
export function threadConfigFor(request) {
  const config = { web_search: request.webSearch };
  if (request.toolOutputTokenLimit != null) config.tool_output_token_limit = request.toolOutputTokenLimit;
  if (request.mode === "write") {
    config.sandbox_workspace_write = {
      writable_roots: request.writableRoots,
      network_access: Boolean(request.network),
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false
    };
  }
  return config;
}

// turn/start `sandboxPolicy` for a request, so every turn, including one on a resumed
// thread, runs with the sandbox of the first launch.
export function sandboxPolicyFor(request) {
  if (request.mode === "yolo") {
    return { type: "dangerFullAccess" };
  }
  if (request.mode === "write") {
    return {
      type: "workspaceWrite",
      writableRoots: request.writableRoots,
      networkAccess: Boolean(request.network),
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }
  return { type: "readOnly", networkAccess: Boolean(request.network) };
}

/** @returns {import("./protocol").SandboxMode} */
export function sandboxFor(request) { return /** @type {import("./protocol").SandboxMode} */ (MODES.get(request.mode)); }
/** @returns {"never"} */
export function approvalPolicyFor() { return "never"; }

/** @type {import("../types").RequestRules} */
export const requestRules = {
  headerKeys: { "tool-output-token-limit": "toolOutputTokenLimit" },
  defaultSource: "let the Codex config decide",
  defaultEffort: null,
  refusals: {},
  complete(request, values, { env, userConfig }) {
    const value = values.toolOutputTokenLimit;
    const toolOutputTokenLimit = value == null ? null : Number(value);
    if (value != null && (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(toolOutputTokenLimit) || toolOutputTokenLimit <= 0)) {
      throw new UsageError("tool-output-token-limit must be a positive safe integer (tokens).");
    }
    const defined = mcpServersInConfig(codexDefaultHome(env));
    for (const name of userConfig.mcpOff.filter(name => !defined.has(name))) {
      request.notes.push(`job-mcp-off skips ${name}: it is not in this home's config.toml.`);
    }
    return {
      mcpOff: userConfig.mcpOff.filter(name => defined.has(name)),
      ...(toolOutputTokenLimit == null ? {} : { toolOutputTokenLimit })
    };
  }
};
