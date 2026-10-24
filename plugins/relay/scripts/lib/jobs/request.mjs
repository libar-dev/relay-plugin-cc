// The launch request of a job: the prompt header the main thread writes, and how it maps
// onto backend settings. Nothing here is inferred from the brief's words.

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { readUserConfig, userConfigPath } from "./config.mjs";
import { runCommand } from "../util/process.mjs";
import { BACKENDS, DEFAULT_BACKEND, backendNamed, BACKEND_HEADER_KEYS } from "../backends/index.mjs";
import { UsageError } from "../util/errors.mjs";
export { UsageError } from "../util/errors.mjs";

// Existing headers and scripts rely on yolo, and the brief defines the fence. `write` with
// network covers most work, but not `ps` or writes outside the working directory.
const DEFAULT_MODE = "yolo";
const WEB_SEARCH_MODES = new Set(["live", "cached", "indexed", "disabled"]);
const DEFAULT_WEB_SEARCH = "live";
const MODES = new Set(["yolo", "write", "read-only"]);
const HEADER_KEYS = new Set(["model", "effort", "mode", "network", "cd", "add-dir", "brief", "web-search", "fast", "backend", ...Object.keys(BACKEND_HEADER_KEYS)]);

function stripComment(value) {
  const index = value.search(/\s#/);
  return (index === -1 ? value : value.slice(0, index)).trim();
}

// Split a prompt into its header and its brief. The header is `key: value` lines, then a
// line of three dashes. Everything after that line is the brief, byte for byte.
export function parseHeaderPrompt(text) {
  const source = String(text ?? "");
  const match = /^---[ \t]*\r?\n/m.exec(source);
  const endMatch = match ? null : /^---[ \t]*$/m.exec(source);
  if (!match && !endMatch) {
    throw new UsageError("The prompt has no header: expected `key: value` lines, then a line `---`, then the brief.");
  }
  const cut = match ?? endMatch;
  const headerText = source.slice(0, cut.index);
  const brief = match ? source.slice(cut.index + cut[0].length) : "";
  const header = { addDirs: [] };
  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new UsageError(`Header line is not \`key: value\`: ${line}`);
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = stripComment(line.slice(colon + 1));
    if (!HEADER_KEYS.has(key)) {
      throw new UsageError(`Unknown header key "${key}". Known keys: ${[...HEADER_KEYS].join(", ")}.`);
    }
    if (key === "add-dir") {
      header.addDirs.push(value);
    } else {
      header[key === "web-search" ? "webSearch" : Object.hasOwn(BACKEND_HEADER_KEYS, key) ? BACKEND_HEADER_KEYS[key] : key] = value;
    }
  }
  return { header, brief };
}

export function readLaunchPrompt(text, { baseDir = process.cwd(), env = process.env, relativePaths = true } = {}) {
  const { header, brief } = parseHeaderPrompt(text);
  const deferredBrief = header.brief && !relativePaths && !path.isAbsolute(header.brief.trim());
  let briefText = brief;
  if (header.brief) {
    if (brief.trim()) {
      throw new UsageError("The header names a brief file, so nothing may follow the dashes.");
    }
    if (!deferredBrief) briefText = fs.readFileSync(path.resolve(baseDir, header.brief), "utf8");
  }
  if (!deferredBrief && !briefText.trim()) {
    throw new UsageError("The brief is empty.");
  }
  // The spawn cannot know the relay's final directory, including an uncreated worktree.
  if (!relativePaths) {
    if (!path.isAbsolute((header.cd ?? "").trim())) delete header.cd;
    header.addDirs = header.addDirs.filter(dir => path.isAbsolute(dir.trim()));
  }
  return { request: buildLaunchRequest(header, {
    baseDir, env, skipLinkedWorktreeRoots: !relativePaths && !path.isAbsolute((header.cd ?? "").trim())
  }), brief: briefText };
}

function parseBoolean(value, name) {
  if (value == null || value === "") {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "0", "off"].includes(normalized)) {
    return false;
  }
  throw new UsageError(`${name} must be true or false, not "${value}".`);
}

function gitPath(cwd, args) {
  const result = runCommand("git", args, { cwd });
  if (result.error || result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value ? path.resolve(cwd, value) : null;
}

function realpathOr(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

// When cwd is a linked git worktree, the roots a commit writes to that lie outside it:
// the worktree's gitdir under the main repository's .git/worktrees/, and the common
// objects, refs and logs, plus packed-refs and its lock.
function linkedWorktreeRoots(cwd) {
  const gitDir = gitPath(cwd, ["rev-parse", "--git-dir"]);
  const commonDir = gitPath(cwd, ["rev-parse", "--git-common-dir"]);
  if (!gitDir || !commonDir) {
    return [];
  }
  const git = realpathOr(gitDir);
  const common = realpathOr(commonDir);
  if (git === common) {
    return [];
  }
  return [git, common];
}

function normalizeModelOrEffort(value, name, backend = DEFAULT_BACKEND) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new UsageError(`${name} is required. Use \`${name}: default\` to ${backend.request.defaultSource}.`);
  }
  // The server decides which model and effort values are valid.
  return text.toLowerCase() === "default" ? null : text;
}

// Build the stored launch request from header values. `baseDir` resolves a relative cd.
// `env` locates the user config: when `fastTier` there is "off", `fast: true` is ignored
// with a note, never an error, and the backend config sets the tier.
// `skipLinkedWorktreeRoots` defers inferred roots when the job's directory is unknown.
export function buildLaunchRequest(values, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const env = options.env ?? process.env;
  const name = String(values.backend ?? DEFAULT_BACKEND.name).trim();
  // Required fields and mode errors precede an unknown backend, as in the header parser.
  let backend = BACKENDS.find(backend => backend.name === name) ?? DEFAULT_BACKEND;
  const model = normalizeModelOrEffort(values.model, "model", backend);
  const effort = normalizeModelOrEffort(values.effort, "effort", backend) ?? backend.request.defaultEffort;
  const mode = /** @type {import("../backends/types").Mode} */ (String(values.mode ?? "").trim().toLowerCase() || DEFAULT_MODE);
  if (!MODES.has(mode)) {
    throw new UsageError(`mode must be one of ${[...MODES.keys()].join(", ")}, not "${values.mode}".`);
  }
  backend = backendNamed(name);
  // Without `backend:` a job runs on the default backend, whatever its model is called.
  const family = values.backend == null && model ? BACKENDS.find(candidate => candidate !== backend && candidate.request.modelFamily?.test(model)) : null;
  if (family) {
    throw new UsageError(`model: ${model} is a ${family.label} model, and with no backend: the job runs on ${backend.label}. Name the backend: backend: ${family.name} (--backend ${family.name} for a review), or backend: ${backend.name} to send it to ${backend.label} as written.`);
  }
  for (const candidate of BACKENDS) {
    for (const [key, field] of Object.entries(candidate.request.headerKeys)) {
      if (candidate !== backend && values[field] != null) throw new UsageError(`${key} is only valid with backend: ${candidate.name}.`);
    }
  }
  if (!backend.capabilities.modes.includes(mode)) {
    throw new UsageError(`mode: ${mode} is not supported for ${backend.label}${backend.request.refusals.mode?.[mode] ?? "."}`);
  }
  const webSearch = /** @type {import("../backends/types").WebSearch} */ (String(values.webSearch ?? "").trim().toLowerCase() || DEFAULT_WEB_SEARCH);
  if (!WEB_SEARCH_MODES.has(webSearch)) {
    throw new UsageError(`web-search must be one of live, cached, disabled, not "${values.webSearch}".`);
  }
  if (!backend.capabilities.webSearch.includes(webSearch)) {
    throw new UsageError(`web-search: ${webSearch} is not supported for ${backend.label}${backend.request.refusals.webSearch ?? "."}`);
  }
  const network = parseBoolean(values.network, "network");
  const cwd = path.resolve(baseDir, String(values.cd ?? "").trim() || baseDir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new UsageError(`cd is not a directory: ${cwd}`);
  }
  const addDirs = (values.addDirs ?? []).map((dir) => path.resolve(baseDir, String(dir).trim())).filter(Boolean);
  for (const dir of addDirs) {
    if (!fs.existsSync(dir)) {
      throw new UsageError(`add-dir does not exist: ${dir}`);
    }
  }

  const notes = [];
  let fast = parseBoolean(values.fast, "fast");
  const userConfig = readUserConfig(env);
  if (fast && !backend.capabilities.priorityTier) {
    fast = false;
    notes.push(backend.request.priorityTierNote);
  } else if (fast && userConfig.fastTier === "off") {
    fast = false;
    notes.push(`fast tier is off in ${userConfigPath(env)}; fast: true is ignored and the ${backend.label} config sets the tier.`);
  }
  let writableRoots = [];
  if (mode === "yolo") {
    if (network || addDirs.length > 0) {
      notes.push("network and add-dir are ignored in yolo mode: the sandbox is off.");
    }
  } else if (mode === "write") {
    writableRoots = [...new Set([...addDirs, ...(options.skipLinkedWorktreeRoots ? [] : linkedWorktreeRoots(cwd))])];
  } else if (addDirs.length > 0) {
    notes.push("add-dir is ignored in read-only mode.");
  }

  const request = {
    backend: backend.name,
    model,
    effort,
    fast,
    mode,
    network: mode === "yolo" ? true : network,
    webSearch,
    cwd,
    addDirs,
    writableRoots,
    notes
  };
  Object.assign(request, backend.request.complete(request, values, { env, userConfig }));
  const home = backend.accountHome(request, env);
  return Object.assign(request, { account: home ? createHash("sha256").update(home).digest("hex").slice(0, 12) : null });
}
