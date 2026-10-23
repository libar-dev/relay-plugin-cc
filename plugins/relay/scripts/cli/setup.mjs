import { setAdmissionConfig, admissionConfigPath } from "../lib/worker/admission.mjs";
import { parseCommandInput, resolveCommandCwd, printJson } from "./shared.mjs";
import { default as process } from "node:process";
import { parseMcpOffSetting, setRepoConfig, setUserConfig, userConfigPath, FAST_TIER_VALUES } from "../lib/jobs/config.mjs";
import { UsageError } from "../lib/util/errors.mjs";
import { BACKENDS, backendNamed, backendNames } from "../lib/backends/index.mjs";
import { EXIT } from "../lib/jobs/view.mjs";
import { buildSetupPage, renderSetupPage } from "../lib/setup/page.mjs";
import { ensureGitRepository } from "../lib/review/git.mjs";


// ---------------------------------------------------------------------------------------
// Setup and transfer

// `/relay:setup` checks every backend home, or one with `--backend`.
// Flags are checked before settings are changed or backend checks run.
const GUARD_FLAGS = { "max-very-heavy": ["maxVeryHeavy", 2] };
const SETUP_SWITCHES = ["admission", ...Object.keys(GUARD_FLAGS), "enable-review-gate", "disable-review-gate", "fast-tier", "job-mcp-off"];


function setupSelection(options) {
  let backend = null;
  if (options.backend != null) {
    try { backend = backendNamed(String(options.backend).trim()); }
    catch { throw new UsageError(`--backend must be ${backendNames()}, not "${options.backend}".`); }
  }
  for (const candidate of BACKENDS) {
    const flag = candidate.setup.homeFlag;
    if (flag && options[flag] != null && backend !== candidate) throw new UsageError(`--${flag} requires --backend ${candidate.name}.`);
  }
  if (!backend) return null;
  const switches = SETUP_SWITCHES.filter(name => options[name] != null && options[name] !== false);
  if (switches.length) throw new UsageError(`Use setup --backend on its own, without --${switches[0]}.`);
  return backend.setup.home(options[backend.setup.homeFlag] ?? null, process.env);
}


export async function handleSetup(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    argsFile: true,
    valueOptions: ["admission", ...Object.keys(GUARD_FLAGS), "cwd", "fast-tier", "job-mcp-off", ...BACKENDS.flatMap(backend => backend.setup.homeFlag ? [backend.setup.homeFlag] : []), "backend"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (positionals.length) {
    throw new UsageError(`Unexpected setup argument: ${positionals[0]}`);
  }
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new UsageError("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options["fast-tier"] != null && !FAST_TIER_VALUES.includes(options["fast-tier"])) {
    throw new UsageError(`--fast-tier must be allowed or off, not "${options["fast-tier"]}".`);
  }
  const jobMcpOff = options["job-mcp-off"] == null ? null : parseMcpOffSetting(options["job-mcp-off"]);
  const guardChanges = [];
  if (options.admission != null) {
    if (!["on", "off"].includes(options.admission)) throw new UsageError(`--admission must be on or off, not "${options.admission}".`);
    guardChanges.push(["admission", options.admission]);
  }
  for (const [flag, [key, max]] of Object.entries(GUARD_FLAGS)) {
    if (options[flag] == null) continue;
    const value = options[flag] === "default" ? null : Number(options[flag]);
    if (value !== null && (!/^\d+$/.test(options[flag]) || !Number.isInteger(value) || value < 1 || value > Number(max))) throw new UsageError(`--${flag} must be an integer from 1 to ${max}, or default.`);
    guardChanges.push([key, value]);
  }
  const cwd = resolveCommandCwd(options);
  const only = setupSelection(options);
  const actionsTaken = [];
  if (!only) {
    for (const [key, value] of guardChanges) {
      setAdmissionConfig(key, value);
      actionsTaken.push(`Set domain-wide load guard ${key} to ${value === null ? "default" : JSON.stringify(value)} in ${admissionConfigPath()}.`);
    }
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    if (options["enable-review-gate"]) {
      setRepoConfig(cwd, "stopReviewGate", true);
      actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot} (every worktree and session of this repository).`);
    } else if (options["disable-review-gate"]) {
      setRepoConfig(cwd, "stopReviewGate", false);
      actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot} (every worktree and session of this repository).`);
    }
    if (options["fast-tier"] != null) {
      setUserConfig("fastTier", options["fast-tier"]);
      actionsTaken.push(`Set the fast tier to ${options["fast-tier"]} in ${userConfigPath()}.`);
    }
    if (jobMcpOff != null) {
      setUserConfig("mcpOff", jobMcpOff);
      actionsTaken.push(`Set job MCP servers off to ${jobMcpOff.length ? jobMcpOff.join(", ") : "none"} in ${userConfigPath()}.`);
    }
  }
  const page = await buildSetupPage(cwd, { only, actionsTaken });
  if (options.json) printJson("setup", page);
  else process.stdout.write(renderSetupPage(page));
  // The overview answers whatever it finds; one backend keeps the non-zero exit when not ready.
  if (only && !page.ready) process.exitCode = EXIT.usage;
}


function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
