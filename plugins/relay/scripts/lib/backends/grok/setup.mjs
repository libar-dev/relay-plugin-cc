import { shellAssignment, shellCommandMarkdown } from "../../util/shell.mjs";
import fs from "node:fs";
import path from "node:path";
import { runLimited } from "../../util/process.mjs";
import { grokBackend } from "./index.mjs";
import { grokEnvironment, resolveGrokBinary } from "./connection.mjs";
import { resolveGrokHome } from "./request.mjs";
import { emptyBlock, notInstalled, isScript, firstLine, userDir, isDirectory, commandFailure, executablesOnPath, versionOf, tryResolve } from "../setup.mjs";

function grokConfigDefaults(grokHome) {
  try {
    const text = fs.readFileSync(path.join(grokHome, "config.toml"), "utf8");
    const section = /^\s*\[models\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
    const value = key => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1] ?? null;
    return { model: value("default"), effort: value("default_reasoning_effort") };
  } catch {
    return { model: null, effort: null };
  }
}

function parseGrokModels(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const signedIn = /logged in with\s+([^\s.]+(?:\.[^\s.]+)*)/i.exec(text ?? "");
  const defaultModel = /^\s*Default model:\s*(\S+)/im.exec(text ?? "")?.[1] ?? null;
  const models = [];
  let listing = false;
  for (const line of lines) {
    if (/^\s*Available models:/i.test(line)) { listing = true; continue; }
    if (!listing) continue;
    const match = /^\s*[*-]\s+(\S+)/.exec(line);
    if (match) models.push(match[1]);
    else if (line.trim()) listing = false;
  }
  return { signedIn: signedIn ? signedIn[1] : null, defaultModel, models };
}

// A script on PATH may be a wrapper that runs its own hooks at job start.
function grokScriptNote(binary, env) {
  if (!isScript(binary)) return { realBinary: null, note: null };
  const real = executablesOnPath("grok", env).find(candidate => candidate !== binary && !isScript(candidate)) ?? null;
  return {
    realBinary: real,
    note: `${binary} is a script, not the Grok binary: a wrapper may run its own hooks when a job starts \`grok agent\` (cmux's does; \`--version\` and \`models\` skip them). ${real ? `The real binary is ${real}; set GROK_BINARY=${real} to pin it.` : "No other grok binary was found on PATH; set GROK_BINARY to pin the real one."}`
  };
}

// `grok models` once answered "You are not authenticated" for a signed-in home, and the next call
// said signed in (the end-to-end suite, 22 October 2026), so a signed-out answer is asked again.
const SIGNED_OUT_RECHECK_MS = 1000;

async function checkGrokHome(cwd, home, env, shared, limits) {
  const started = Date.now();
  const block = emptyBlock(home, grokBackend.capabilities);
  if (!shared.binary) return notInstalled(block, "grok: not installed (GROK_BINARY or PATH; see grok-home.md)");
  block.binary = shared.binary;
  block.binaryIsScript = isScript(shared.binary);
  const script = grokScriptNote(shared.binary, env);
  block.realBinary = script.realBinary;
  if (script.note) block.warnings.push(script.note);
  const grokEnv = grokEnvironment({ grokHome: home.home, mode: "yolo" }, env);
  const listModels = () => runLimited(shared.binary, ["models"], { cwd, env: grokEnv, timeoutMs: limits.commandMs });
  const [version, first] = await Promise.all([shared.version, listModels()]);
  let listing = first;
  if (!version.error && !first.timedOut && !first.error && !parseGrokModels(first.stdout).signedIn) {
    await new Promise(resolve => setTimeout(resolve, SIGNED_OUT_RECHECK_MS));
    // A second answer replaces the first only when it came: a retry that hangs or fails to start
    // leaves the first reading, signed out, with its sign-in step.
    const again = await listModels();
    if (!again.timedOut && !again.error) listing = again;
  }
  block.elapsedMs = Date.now() - started;
  block.version = version.text;
  const config = grokConfigDefaults(home.home);
  const failure = commandFailure("grok models", listing, limits.commandMs);
  const parsed = parseGrokModels(listing.stdout);
  block.model = parsed.defaultModel ?? config.model;
  block.effort = config.effort;
  if (!config.effort) block.effortNote = "not set in config.toml; Grok's own default";
  if (version.error) {
    block.error = version.error;
    block.signIn = { state: "unknown", method: null, detail: "not checked: grok --version failed" };
    block.modelsReason = "not checked: grok --version failed";
    return block;
  }
  if (listing.timedOut || listing.error) {
    block.error = failure;
    block.signIn = { state: "unknown", method: null, detail: failure };
    block.modelsReason = failure;
    return block;
  }
  if (!parsed.signedIn) {
    const said = firstLine(listing.stdout) || firstLine(listing.stderr) || failure || "grok models printed nothing";
    block.signIn = { state: "signed-out", method: null, detail: `${said} (sign in: ${shellAssignment("GROK_HOME", home.home)} grok login; see grok-home.md)` };
    block.modelsReason = "signed out";
    if (failure) block.error = failure;
    return block;
  }
  block.signIn = { state: "signed-in", method: parsed.signedIn, detail: firstLine(listing.stdout) };
  block.models = parsed.models.map(id => ({ id, efforts: null, defaultEffort: null }));
  block.modelsReason = "efforts need grok agent; not probed";
  block.ready = !failure;
  if (failure) block.error = failure;
  return block;
}

/** @type {import("../types").SetupProbe} */
export const setupProbe = {
  homeFlag: "grok-home",
  homes(env) {
    const user = userDir(env);
    const homes = [this.home(null, env)];
    let names = [];
    try { names = fs.readdirSync(user).sort(); } catch {}
    for (const name of names) {
      const match = /^\.grok-([a-z0-9][a-z0-9-]*)$/.exec(name);
      if (match && isDirectory(path.join(user, name))) homes.push(this.home(match[1], env));
    }
    return homes;
  },
  home(value, env) {
    const text = value == null ? "default" : String(value).trim();
    const isDefault = text === "default";
    return { backend: "grok", home: resolveGrokHome(text, env), homeDefault: isDefault, selector: !isDefault && /^[a-z0-9][a-z0-9-]*$/.test(text) ? text : null };
  },
  prepare({ cwd, env, limits }) {
    const binary = tryResolve(resolveGrokBinary, env);
    return { binary, version: versionOf(binary, "grok", cwd, grokEnvironment({ grokHome: path.join(userDir(env), ".grok"), mode: "yolo" }, env), limits) };
  },
  check(home, shared, { cwd, env, limits }) { return checkGrokHome(cwd, home, env, shared, limits); },
  signInText(block) { return block.signIn.state === "signed-out" ? `signed out: ${block.signIn.detail}` : null; },
  nextSteps(block) {
    return block.signIn.state === "signed-out"
      ? [`Sign in to Grok in ${block.home} once: ${shellCommandMarkdown(`${shellAssignment("GROK_HOME", block.home)} grok login`)} (see the jobs skill's grok-home.md).`]
      : [];
  }
};
