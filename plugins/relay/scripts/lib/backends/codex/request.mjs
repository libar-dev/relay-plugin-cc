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

// Codex keeps 10,000 tokens of each tool result by default, which cuts the middle out of a
// review's diff or a log, so every Codex job gets a Relay budget. `tool-output-budgets.json`
// holds the reviewed models. Every other model gets the formula: `deep` is a quarter of its
// context window to the nearest power of two (65536 for 272k, 131072 for 500k), `balanced` half
// of that and `compact` a quarter, and `deep` is its default. The window comes from
// `model_context_window`, else from Codex's model catalog cache, else 272000 is assumed.
export const TOOL_OUTPUT_BUDGETS = JSON.parse(fs.readFileSync(new URL("./tool-output-budgets.json", import.meta.url), "utf8"));
const TOOL_OUTPUT_PRESETS = ["compact", "balanced", "deep"];
const ASSUMED_CONTEXT_WINDOW = 272000;

function contextWindowFor(model, config, codexHome) {
  const configured = config?.model_context_window;
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8"));
    const window = catalog?.models?.find((entry) => entry?.slug === model)?.context_window;
    return Number.isSafeInteger(window) && window > 0 ? window : null;
  } catch {
    return null;
  }
}

// A model's presets, its default preset and where they come from. A configured
// `model_context_window` wins over the reviewed values, which assume the catalog's window.
/** @param {string | null | undefined} model @param {{ config?: Record<string, any>, codexHome: string }} options */
export function budgetsFor(model, { config = {}, codexHome }) {
  const configured = Number.isSafeInteger(config?.model_context_window) && config.model_context_window > 0;
  if (!configured && model && Object.hasOwn(TOOL_OUTPUT_BUDGETS.models, model)) {
    return { ...TOOL_OUTPUT_BUDGETS.models[model], basis: `reviewed ${TOOL_OUTPUT_BUDGETS.version}` };
  }
  const window = contextWindowFor(model, config, codexHome);
  const deep = 2 ** Math.round(Math.log2((window ?? ASSUMED_CONTEXT_WINDOW) / 4));
  return {
    compact: deep / 4, balanced: deep / 2, deep, default: "deep",
    basis: window ? `context ${window} / 4` : `context window not reported, ${ASSUMED_CONTEXT_WINDOW} assumed`
  };
}

// A header value: a positive token count, a preset, or `inherit` (no override). A preset
// resolves when the thread opens, after `config/read`, so a configured `model_context_window`
// bounds it whether or not the job names its model.
function toolOutputFields(value) {
  if (value == null) return {};
  const text = String(value).trim().toLowerCase();
  if (text === "inherit" || TOOL_OUTPUT_PRESETS.includes(text)) return { toolOutputPreset: text };
  const limit = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new UsageError(`tool-output-token-limit must be compact, balanced, deep, inherit or a positive safe integer (tokens), not "${value}".`);
  }
  return { toolOutputTokenLimit: limit };
}

// Code mode returns 10,000 tokens of each `exec` or `wait` result unless the call asks for more,
// whatever the history budget is, and no setting changes that default. A thread whose budget is
// larger tells the model how to ask, after the developer instructions the user configured.
const CODE_MODE_DEFAULT_TOKENS = 10000;

function developerInstructionsFor(limit, config) {
  if (!(limit > CODE_MODE_DEFAULT_TOKENS)) return null;
  const relay = `Tool output: this job keeps up to ${limit} tokens of each tool result. In code mode, \`exec\` and \`wait\` return only ${CODE_MODE_DEFAULT_TOKENS} tokens of output by default and cut the middle, and \`max_output_tokens\` on a nested \`exec_command\` alone does not change that. When a command can print more (a diff, a log, a whole file), start the exec input with \`// @exec: {"max_output_tokens": ${limit}}\` and pass the same value to the nested \`exec_command\`, or pass \`max_tokens: ${limit}\` to \`wait\`. A result that large fills much of the context, so read a large file or diff by line range where you can. When a result says it was truncated, read the omitted part before relying on it.`;
  return [typeof config.developer_instructions === "string" ? config.developer_instructions : null, relay].filter(Boolean).join("\n\n");
}

// The budget a thread opens with, a note when Relay chose it, and the developer instructions that
// carry it into code mode: the job's number; none for `inherit` or when the Codex configuration
// sets one; else the job's preset or the model's default. A failed `config/read` counts as no
// configured budget.
export async function toolOutputTokenLimitFor(client, request, env = process.env) {
  let config = {};
  try {
    config = (await client.request("config/read", { includeLayers: false, cwd: request.cwd }))?.config ?? {};
  } catch {
    config = {};
  }
  const configured = Number.isSafeInteger(config.tool_output_token_limit) ? config.tool_output_token_limit : null;
  const result = (limit, note) => ({ limit, note, developerInstructions: developerInstructionsFor(limit ?? configured, config) });
  if (request.toolOutputTokenLimit != null) return result(request.toolOutputTokenLimit, null);
  if (request.toolOutputPreset === "inherit") return result(null, null);
  if (!request.toolOutputPreset && config.tool_output_token_limit != null) return result(null, null);
  const model = request.model && request.model !== "default" ? request.model : config.model;
  const budgets = budgetsFor(model, { config, codexHome: codexDefaultHome(env) });
  const preset = request.toolOutputPreset ?? budgets.default;
  return result(budgets[preset], `tool-output-token-limit: ${budgets[preset]}, Relay's ${preset} budget for ${model ?? "the default model"} (${budgets.basis}).`);
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
    const budget = toolOutputFields(values.toolOutputTokenLimit);
    const defined = mcpServersInConfig(codexDefaultHome(env));
    for (const name of userConfig.mcpOff.filter(name => !defined.has(name))) {
      request.notes.push(`job-mcp-off skips ${name}: it is not in this home's config.toml.`);
    }
    return { mcpOff: userConfig.mcpOff.filter(name => defined.has(name)), ...budget };
  }
};
