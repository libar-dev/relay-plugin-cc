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

// The first line of Grok's error when it refused a sandbox profile; null for anything else, such
// as a network failure under the profile, which says nothing about whether the profile can run.
function sandboxRefusal(result) {
  const text = String(result?.stderr ?? "");
  if (result?.timedOut || result?.error || result?.status === 0 || !/sandbox/i.test(text)) return null;
  return firstLine(text);
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
  const [version, listing] = await Promise.all([
    shared.version,
    runLimited(shared.binary, ["models"], { cwd, env: grokEnv, timeoutMs: limits.commandMs })
  ]);
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
    block.signIn = { state: "signed-out", method: null, detail: `${said} (sign in: GROK_HOME=${home.home} grok login; see grok-home.md)` };
    block.modelsReason = "signed out";
    if (failure) block.error = failure;
    return block;
  }
  block.signIn = { state: "signed-in", method: parsed.signedIn, detail: firstLine(listing.stdout) };
  // The same command under the read-only profile: Grok refuses a profile it cannot enforce before
  // it does anything else, and makes no model call either way.
  const sandboxed = await runLimited(shared.binary, ["models"], { cwd, env: grokEnvironment({ grokHome: home.home, mode: "read-only" }, env), timeoutMs: limits.commandMs });
  const refusal = sandboxRefusal(sandboxed);
  if (refusal) block.warnings.push(`Grok refuses its read-only profile on this machine, so read-only jobs and every Grok review fail; yolo and write run. Grok said: ${refusal}`);
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
      ? [`Sign in to Grok in ${block.home} once: \`GROK_HOME=${block.home} grok login\` (see the jobs skill's grok-home.md).`]
      : [];
  }
};
