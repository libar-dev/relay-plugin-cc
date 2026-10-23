import { resolveJobsHome, repoSlugFor, readJsonOrNull, writeJsonAtomic } from "./store.mjs";
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as process } from "node:process";

const CONFIG_FILE = "config.json";


// Repository config (the stop review gate). One small file per repository slug,
// written only by `setup`, with a rename.
export function readRepoConfig(cwd, env = process.env) {
  const file = path.join(resolveJobsHome(env), repoSlugFor(cwd), CONFIG_FILE);
  return { stopReviewGate: false, ...(readJsonOrNull(file) ?? {}) };
}


export function setRepoConfig(cwd, key, value, env = process.env) {
  const dir = path.join(resolveJobsHome(env), repoSlugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...readRepoConfig(cwd, env), [key]: value };
  writeJsonAtomic(path.join(dir, CONFIG_FILE), next);
  return next;
}


// User-level settings: <jobs home>/config.json, beside the per-repository configs. One
// account's usage is the concern, not one repository's. `fastTier` is "off" (the default)
// or "allowed"; any other stored value reads as "off". Only a stored "allowed" lets
// `fast: true` select the priority tier.
export const FAST_TIER_VALUES = ["allowed", "off"];

const MCP_OFF_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;


export function parseMcpOffSetting(value) {
  if (String(value ?? "").trim().toLowerCase() === "none") return [];
  const names = String(value ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (names.some((name) => name.toLowerCase() === "none")) {
    throw new Error('--job-mcp-off cannot mix "none" with server names.');
  }
  if (names.length === 0) {
    throw new Error('--job-mcp-off needs a comma-separated list of names, or "none".');
  }
  for (const name of names) {
    if (!MCP_OFF_NAME_PATTERN.test(name)) {
      throw new Error(`--job-mcp-off names a server invalidly: "${name}".`);
    }
  }
  return [...new Set(names)];
}


export function userConfigPath(env = process.env) {
  return path.join(resolveJobsHome(env), CONFIG_FILE);
}


export function readUserConfig(env = process.env) {
  const stored = readJsonOrNull(userConfigPath(env));
  const config = { fastTier: "off", ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) };
  if (!FAST_TIER_VALUES.includes(config.fastTier)) {
    config.fastTier = "off";
  }
  config.mcpOff = Array.isArray(config.mcpOff)
    ? [...new Set(config.mcpOff.filter((name) => typeof name === "string" && MCP_OFF_NAME_PATTERN.test(name)))]
    : [];
  // Provisional guard settings in jobs homes are deliberately ignored.
  for (const key of ["admission", "minWeight", "maxWeight", "maxVeryHeavy", "modelClasses"]) delete config[key];
  return config;
}


export function setUserConfig(key, value, env = process.env) {
  const file = userConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = readJsonOrNull(file);
  const next = { ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}), [key]: value };
  writeJsonAtomic(file, next);
  return readUserConfig(env);
}
