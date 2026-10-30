// The setup page: every backend home the relay can run, in one shape, with no model call.
//
// Each backend supplies checks for its version, sign-in, settings and models without
// starting a turn or retaining a session.
//
// Every check runs at once, each under a time limit: 10 s for a command, 20 s per app-server.
// A backend that is missing, signed out or slow prints its reason; it never fails the page.
import path from "node:path";
import process from "node:process";
import { BACKENDS, backendFor, backendWith } from "../backends/index.mjs";
import { emptyBlock, firstLine, userDir, realpathOr } from "../backends/setup.mjs";
import { readRepoConfig, readUserConfig } from "../jobs/config.mjs";
import { resolveJobsHome } from "../jobs/store.mjs";

const COMMAND_LIMIT_MS = 10_000;
const SERVER_LIMIT_MS = 20_000;
const REVIEW_GATE_NEXT_STEP = backendWith("stopGate").setup.reviewGateNextStep;

const REVIEW_FEATURES = [["review", "review"], ["adversarialReview", "adversarial review"], ["stopGate", "stop gate"], ["transfer", "transfer"]];

// The `can:` line: modes, steer, resume, web search off, then each review feature the backend
// has. What it lacks is listed with its note, or as `reviews: not yet` when it lacks them all.
/** @param {Pick<import("../backends/types").Backend, "capabilities" | "capabilityNotes">} declaration */
function capabilityWords({ capabilities: can, capabilityNotes: notes = {} }) {
  const noted = (words, note) => (note ? `${words} (${note})` : words);
  const parts = [noted(can.modes.join(", "), notes.modes)];
  if (can.steer) parts.push("steer");
  if (can.resume) parts.push("resume");
  if (can.webSearch.includes("disabled")) parts.push(noted("web search off", notes.webSearchOff));
  const lacking = [];
  for (const [key, words] of REVIEW_FEATURES) (can[key] ? parts : lacking).push(words);
  if (lacking.length === REVIEW_FEATURES.length && !notes.lacking) parts.push("reviews: not yet");
  else if (lacking.length) parts.push(`${lacking.join(", ")}: ${notes.lacking ?? "not yet"}`);
  return parts.join(" · ");
}

// Environment overrides let tests shorten the command and server limits.
function setupLimits(env = process.env) {
  const ms = (name, fallback) => {
    const value = Number(env[name]);
    return env[name] && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { commandMs: ms("RELAY_SETUP_COMMAND_MS", COMMAND_LIMIT_MS), serverMs: ms("RELAY_SETUP_SERVER_MS", SERVER_LIMIT_MS) };
}

// The registry keeps backend homes in page order.
function discoverHomes(env = process.env) {
  return BACKENDS.flatMap(backend => backend.setup.homes(env));
}

// `only`: one home ({ backend, home, homeDefault, selector }) for `--backend`; else every home.
async function checkBackends(cwd, { env = process.env, only = null } = {}) {
  const limits = setupLimits(env);
  const context = { cwd, env, limits };
  const homes = only ? [only] : discoverHomes(env);
  const shared = new Map(BACKENDS.filter(backend => homes.some(home => home.backend === backend.name))
    .map(backend => [backend, Promise.resolve().then(() => backend.setup.prepare(context))]));
  return Promise.all(homes.map(home => checkHome(home, shared.get(backendFor(home)), context)));
}

// One home's check. Whatever goes wrong inside it is that block's reason; the page goes on.
async function checkHome(home, shared, context) {
  const backend = backendFor(home);
  try {
    const prepared = await shared;
    return await backend.setup.check(home, prepared, context);
  } catch (error) {
    const reason = `${home.backend}: unexpected error: ${firstLine(error instanceof Error ? error.message : String(error)) || "unknown"}`;
    const block = emptyBlock(home, backend.capabilities);
    block.signIn = { state: "unknown", method: null, detail: reason };
    block.modelsReason = reason;
    block.error = reason;
    return block;
  }
}

function nextStepsFor(blocks, settings, cwd, env) {
  const context = { cwd, env, limits: setupLimits(env) };
  const steps = blocks.flatMap(block => backendFor(block).setup.nextSteps(block, context));
  if (!settings.reviewGate) steps.push(REVIEW_GATE_NEXT_STEP);
  return steps;
}

function readSettings(cwd, env = process.env) {
  const user = readUserConfig(env);
  return { fastTier: user.fastTier, mcpOff: user.mcpOff, reviewGate: Boolean(readRepoConfig(cwd, env).stopReviewGate) };
}

export async function buildSetupPage(cwd, { env = process.env, only = null, actionsTaken = [] } = {}) {
  const backends = await checkBackends(cwd, { env, only });
  const settings = readSettings(cwd, env);
  return {
    ready: only ? backends[0].ready : backends.some(block => block.ready),
    jobsHome: resolveJobsHome(env),
    settings,
    backends,
    actionsTaken,
    nextSteps: nextStepsFor(backends, settings, cwd, env)
  };
}

// ---------------------------------------------------------------------------------------
// Text

function tilde(file, env) {
  if (!file) return file;
  for (const user of new Set([userDir(env), realpathOr(userDir(env))])) {
    if (file === user) return "~";
    if (file.startsWith(`${user}${path.sep}`)) return `~${file.slice(user.length)}`;
  }
  return file;
}

function statusWord(block) {
  if (block.ready) return "ready";
  if (block.signIn.state === "not-installed") return "not installed";
  if (block.signIn.state === "signed-out") return "signed out";
  return "needs attention";
}

function signInText(block) {
  const { state, method, detail } = block.signIn;
  const custom = backendFor(block).setup.signInText?.(block);
  if (custom != null) return custom;
  if (state === "signed-in") return `signed in (${method})`;
  if (state === "credentials-present") return "credentials present (checked by the first turn)";
  if (state === "not-needed") return detail;
  if (state === "signed-out") return detail;
  return `unknown (${detail})`;
}

function renderBlock(block, env) {
  const selector = block.selector ? `    (${backendFor(block).setup.homeFlag}: ${block.selector})` : "";
  const lines = [`## ${block.backend}  ${tilde(block.home, env)}  ${statusWord(block)}${selector}`];
  if (block.signIn.state === "not-installed") {
    lines.push(block.signIn.detail);
    return lines;
  }
  lines.push(`binary: ${tilde(block.binary, env)}  (${block.version ?? "version unknown"})`);
  lines.push(`sign-in: ${signInText(block)}`);
  const effort = block.effort ? `${block.effort}${block.effortNote ? ` (${block.effortNote})` : ""}` : (block.effortNote ?? "unknown");
  const model = block.model ? `${block.model}${block.modelNote ? ` (${block.modelNote})` : ""}` : null;
  lines.push(model ? `model: ${model}  effort: ${effort}` : `model: unknown (${block.modelsReason ?? "not reported"})`);
  lines.push(...(backendFor(block).setup.settingLines?.(block) ?? []));
  if (block.signIn.state !== "signed-out" && block.signIn.state !== "unknown") {
    const names = block.models.map(model => model.id).join(", ");
    lines.push(`models: ${names || "none listed"}${block.modelsReason ? `  (${block.modelsReason})` : ""}`);
    lines.push(`can: ${capabilityWords(backendFor(block))}`);
  }
  for (const warning of block.warnings) lines.push(`warning: ${warning}`);
  if (block.error && !lines.some(line => line.includes(block.error))) lines.push(`error: ${block.error}`);
  return lines;
}

export function renderSetupPage(page, env = process.env) {
  const { settings } = page;
  const lines = [
    "# relay setup",
    "",
    `jobs home: ${tilde(page.jobsHome, env)}`,
    `settings: fast tier ${settings.fastTier} · job MCP servers off: ${settings.mcpOff.join(", ") || "none"} · review gate ${settings.reviewGate ? "on" : "off"} (this repository)`
  ];
  for (const block of page.backends) lines.push("", ...renderBlock(block, env));
  lines.push("");
  if (page.actionsTaken.length) {
    lines.push("Actions taken:", ...page.actionsTaken.map(action => `- ${action}`));
  } else {
    lines.push("Setup made no changes.");
  }
  lines.push(...page.nextSteps);
  return `${lines.join("\n").trimEnd()}\n`;
}
