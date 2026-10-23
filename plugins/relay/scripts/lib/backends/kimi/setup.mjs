import { shellCommandMarkdown } from "../../util/shell.mjs";
import fs from "node:fs";
import path from "node:path";
import { runLimited } from "../../util/process.mjs";
import { kimiBackend } from "./index.mjs";
import { kimiEnvironment, resolveKimiBinary } from "./connection.mjs";
import { kimiLoginCommand, KIMI_REGION_HINT, resolveKimiHome } from "./request.mjs";
import { emptyBlock, notInstalled, isScript, firstLine, userDir, isDirectory, commandFailure, versionOf, tryResolve } from "../setup.mjs";

function kimiConfigDefaults(kimiHome) {
  try {
    const text = fs.readFileSync(path.join(kimiHome, "config.toml"), "utf8");
    const top = text.split(/^\s*\[/m)[0];
    const thinking = /^\s*\[thinking\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
    const value = (section, key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1] ?? null;
    return { model: value(top, "default_model"), effort: value(thinking, "effort") };
  } catch {
    return { model: null, effort: null };
  }
}

// `kimi provider list --json` prints the home's providers and models with no model call. Its
// providers carry their API key fields: only the model fields and the OAuth references are read.
function parseKimiProviders(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const providers = Object.entries(data.providers ?? {}).map(([id, provider]) => ({
    id, oauthKey: provider?.oauth?.storage === "file" && typeof provider.oauth.key === "string" ? provider.oauth.key : null,
    oauth: Boolean(provider?.oauth)
  }));
  const models = Object.entries(data.models ?? {}).map(([id, model]) => ({
    id,
    efforts: Array.isArray(model?.supportEfforts) && model.supportEfforts.length ? model.supportEfforts.map(String) : null,
    defaultEffort: typeof model?.defaultEffort === "string" ? model.defaultEffort : null
  }));
  return { providers, models };
}

// A file-stored OAuth sign-in lives in `<home>/credentials/<key without "oauth/">.json`. The file
// is never opened: whether the sign-in works is known at the first turn.
function credentialsFile(kimiHome, key) {
  return path.join(kimiHome, "credentials", `${key.replace(/^oauth\//, "")}.json`);
}
function presentFile(file) {
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 2; } catch { return false; }
}

async function checkKimiHome(cwd, home, env, shared, limits) {
  const started = Date.now();
  const block = emptyBlock(home, kimiBackend.capabilities);
  if (!shared.binary) return notInstalled(block, "kimi: not installed (KIMI_BINARY, PATH or ~/.kimi-code/bin; see kimi-home.md)");
  block.binary = shared.binary;
  block.binaryIsScript = isScript(shared.binary);
  const [version, listing] = await Promise.all([
    shared.version,
    runLimited(shared.binary, ["provider", "list", "--json"], { cwd, env: kimiEnvironment({ kimiHome: home.home }, env), timeoutMs: limits.commandMs })
  ]);
  block.elapsedMs = Date.now() - started;
  block.version = version.text;
  const config = kimiConfigDefaults(home.home);
  block.model = config.model;
  block.effort = config.effort;
  if (!config.effort) block.effortNote = "not set in config.toml; the model's own default";
  if (version.error) {
    block.error = version.error;
    block.signIn = { state: "unknown", method: null, detail: "not checked: kimi --version failed" };
    block.modelsReason = "not checked: kimi --version failed";
    return block;
  }
  const failure = commandFailure("kimi provider list", listing, limits.commandMs);
  if (failure) {
    block.error = failure;
    block.signIn = { state: "unknown", method: null, detail: failure };
    block.modelsReason = failure;
    return block;
  }
  const parsed = parseKimiProviders(listing.stdout);
  const login = `${kimiLoginCommand(home.home)}, or ${KIMI_REGION_HINT}`;
  if (!parsed || parsed.providers.length === 0) {
    const said = parsed ? "no provider is configured" : firstLine(listing.stdout) || "kimi provider list printed nothing";
    block.signIn = { state: "signed-out", method: null, detail: `${said} (sign in: ${login}; see kimi-home.md)` };
    block.modelsReason = "signed out";
    return block;
  }
  const files = parsed.providers.filter(provider => provider.oauthKey).map(provider => credentialsFile(home.home, provider.oauthKey));
  const missing = files.filter(file => !presentFile(file));
  if (missing.length > 0) {
    block.signIn = { state: "signed-out", method: null, detail: `no credentials at ${missing.join(", ")} (sign in: ${login})` };
    block.modelsReason = "signed out";
    return block;
  }
  block.signIn = files.length > 0
    ? { state: "credentials-present", method: "kimi login", detail: files.join(", ") }
    : { state: "not-needed", method: "API key in config.toml", detail: "the key is read on the first turn" };
  block.models = parsed.models;
  if (parsed.models.length === 0) {
    block.modelsReason = "kimi provider list listed no model";
    block.error = block.modelsReason;
    return block;
  }
  block.ready = true;
  return block;
}

/** @type {import("../types").SetupProbe} */
export const setupProbe = {
  homeFlag: "kimi-home",
  homes(env) {
    const user = userDir(env);
    const homes = [this.home(null, env)];
    let names = [];
    try { names = fs.readdirSync(user).sort(); } catch {}
    for (const name of names) {
      const match = /^\.kimi-code-([a-z0-9][a-z0-9-]*)$/.exec(name);
      if (match && isDirectory(path.join(user, name))) homes.push(this.home(match[1], env));
    }
    return homes;
  },
  home(value, env) {
    const text = value == null ? "default" : String(value).trim();
    const isDefault = text === "default";
    return { backend: "kimi", home: resolveKimiHome(text, env), homeDefault: isDefault, selector: !isDefault && /^[a-z0-9][a-z0-9-]*$/.test(text) ? text : null };
  },
  prepare({ cwd, env, limits }) {
    const binary = tryResolve(resolveKimiBinary, env);
    return { binary, version: versionOf(binary, "kimi", cwd, kimiEnvironment({ kimiHome: path.join(userDir(env), ".kimi-code") }, env), limits) };
  },
  check(home, shared, { cwd, env, limits }) { return checkKimiHome(cwd, home, env, shared, limits); },
  signInText(block) { return block.signIn.state === "signed-out" ? `signed out: ${block.signIn.detail}` : null; },
  nextSteps(block) {
    return block.signIn.state === "signed-out"
      ? [`Sign in to Kimi in ${block.home} once: ${shellCommandMarkdown(kimiLoginCommand(block.home))} (${KIMI_REGION_HINT}; see the jobs skill's kimi-home.md).`]
      : [];
  }
};
