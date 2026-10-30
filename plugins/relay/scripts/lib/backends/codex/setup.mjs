import { SpawnedServerClient } from "../transport/stdio-rpc.mjs";
import { codexBackend } from "./index.mjs";
import { budgetsFor, codexDefaultHome } from "./request.mjs";
import { emptyBlock, notInstalled, isScript, firstLine, lastLine, seconds, closeWithin, effortName, executablesOnPath, versionOf } from "../setup.mjs";

// One app-server in the Codex home: `account/read`, `config/read`, `model/list`. No thread is opened.
async function askCodexServer(cwd, home, env, limitMs) {
  const answer = { account: null, config: null, toolOutputOrigin: null, models: null, modelsError: null, error: null, warnings: [] };
  let stderr = "";
  // `account/read`, `config/read` and `model/list` are outside the typed method map.
  const client = /** @type {any} */ (new SpawnedServerClient(cwd, {
    env: { ...env, CODEX_HOME: home.home },
    processGroup: true,
    onStderr(chunk) { stderr = (stderr + chunk.toString("utf8")).slice(-4096); },
    notificationTap(notification) {
      if (notification.method === "warning" || notification.method === "configWarning") {
        const text = notification.params?.message ?? notification.params?.summary;
        if (text) answer.warnings.push(String(text));
      }
    }
  }));
  const work = (async () => {
    await client.initialize();
    const account = await client.request("account/read", { refreshToken: false });
    answer.account = account && typeof account === "object" ? account : null;
    const result = await client.request("config/read", { includeLayers: false, cwd });
    const config = result?.config;
    answer.config = config && typeof config === "object" ? config : {};
    answer.toolOutputOrigin = result?.origins?.tool_output_token_limit?.name ?? null;
    try {
      const models = [];
      let cursor = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await client.request("model/list", { limit: 100, cursor, includeHidden: false });
        if (!Array.isArray(result?.data)) throw new Error("model/list answered without a model list");
        models.push(...result.data);
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
        if (!cursor) break;
      }
      answer.models = models;
    } catch (error) {
      answer.modelsError = firstLine(error.message);
    }
  })();
  work.catch(() => {});
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), limitMs); });
  try {
    if (await Promise.race([work.then(() => "done"), timeout]) === "timeout") {
      answer.error = `no answer in ${seconds(limitMs)}`;
    }
  } catch (error) {
    // A server that ended before answering says why on stderr; a JSON-RPC error says it itself.
    const said = /server ended before/.test(error.message) ? lastLine(stderr) : "";
    answer.error = `codex app-server: ${said || firstLine(error.message)}`;
  } finally {
    clearTimeout(timer);
    await closeWithin(client, 2000);
  }
  return answer;
}

// `not-needed`: the home's provider is not OpenAI (a local or custom provider in its config).
function codexSignIn(account, config) {
  const entry = account?.account ?? null;
  if (entry?.type === "chatgpt") {
    const email = typeof entry.email === "string" && entry.email.trim() ? entry.email.trim() : null;
    return { state: "signed-in", method: "chatgpt", detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active" };
  }
  if (entry?.type === "apiKey") {
    return { state: "signed-in", method: "api-key", detail: "API key configured (unverified)" };
  }
  if (account?.requiresOpenaiAuth === false) {
    const provider = config?.model_provider ?? "custom";
    return { state: "not-needed", method: provider, detail: `provider ${provider}, no OpenAI sign-in needed (the key is read on the first turn)` };
  }
  return { state: "signed-out", method: null, detail: "signed out (run codex login)" };
}

// A catalog entry the page can show: an object with a model name. Anything else is skipped.
function isCatalogModel(model) {
  if (!model || typeof model !== "object") return false;
  const id = model.id ?? model.model;
  return typeof id === "string" && id.trim() !== "";
}

async function checkCodexHome(cwd, home, env, shared, limits) {
  const started = Date.now();
  const block = emptyBlock(home, codexBackend.capabilities);
  const binary = shared.binary;
  if (!binary) return notInstalled(block, "codex: not installed (npm install -g @openai/codex)");
  block.binary = binary;
  block.binaryIsScript = isScript(binary);
  const [version, answer] = await Promise.all([shared.version, askCodexServer(cwd, home, env, limits.serverMs)]);
  block.version = version.text;
  if (version.error) block.warnings.push(version.error);
  block.warnings.push(...answer.warnings);
  block.elapsedMs = Date.now() - started;
  if (answer.error) {
    block.signIn = { state: "unknown", method: null, detail: answer.error };
    block.modelsReason = answer.error;
    block.error = answer.error;
    return block;
  }
  const signIn = codexSignIn(answer.account, answer.config);
  block.signIn = signIn;
  const budget = answer.config.tool_output_token_limit;
  const origin = answer.toolOutputOrigin;
  const location = origin?.file ?? origin?.dotCodexFolder;
  const model = answer.config.model;
  const budgets = budgetsFor(model, { config: answer.config, codexHome: home.home });
  block.toolOutputTokenLimit = budget == null
    ? { value: budgets[budgets.default], source: `Relay's ${budgets.default} budget for ${model ?? "the default model"} (${budgets.basis})` }
    : Number.isSafeInteger(budget) && budget >= 0
      ? { value: budget, source: origin?.type ? `${origin.type} configuration${location ? ` (${location})` : ""}` : "configuration (source not reported)" }
      : { value: null, source: "unknown (unrecognized configured budget)" };
  const catalog = (answer.models ?? []).filter(isCatalogModel).filter(model => !model.hidden);
  block.models = catalog.map(model => ({
    id: model.id ?? model.model,
    efforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(effortName).filter(Boolean) : null,
    defaultEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null
  }));
  block.modelsReason = answer.modelsError ? `model/list: ${answer.modelsError}` : null;
  const configured = typeof answer.config?.model === "string" && answer.config.model.trim() ? answer.config.model.trim() : null;
  const catalogDefault = catalog.find(model => model.isDefault);
  block.model = configured ?? catalogDefault?.id ?? null;
  if (!configured && block.model) block.modelNote = "the catalog default; config.toml sets none";
  const effort = typeof answer.config?.model_reasoning_effort === "string" ? answer.config.model_reasoning_effort : null;
  const modelDefault = block.models.find(model => model.id === block.model)?.defaultEffort ?? null;
  block.effort = effort ?? modelDefault;
  if (!effort) block.effortNote = modelDefault ? "the model's default" : "not set";
  block.ready = signIn.state === "signed-in" || signIn.state === "not-needed";
  return block;
}

/** @type {import("../types").SetupProbe} */
export const setupProbe = {
  homes(env) { return [this.home(null, env)]; },
  home(_value, env) { return { backend: "codex", home: codexDefaultHome(env), homeDefault: true, selector: null }; },
  prepare({ cwd, env, limits }) {
    const binary = executablesOnPath("codex", env)[0] ?? null;
    return { binary, version: versionOf(binary, "codex", cwd, env, limits) };
  },
  check(home, shared, { cwd, env, limits }) { return checkCodexHome(cwd, home, env, shared, limits); },
  settingLines(block) {
    const budget = block.toolOutputTokenLimit;
    return budget ? [`tool-output-token-limit: ${budget.value == null ? budget.source : `${budget.value} (${budget.source})`}`] : [];
  },
  signInText({ signIn: { state, method, detail } }) {
    if (state !== "signed-in") return null;
    if (method === "chatgpt") return `signed in (ChatGPT${detail?.includes(" for ") ? `, ${detail.split(" for ").pop()}` : ""})`;
    return "signed in (API key, unverified)";
  },
  nextSteps(block, { env }) {
    if (block.signIn.state === "not-installed") {
      const npm = executablesOnPath("npm", env)[0];
      return [npm ? "Install Codex with `npm install -g @openai/codex`." : "Install Codex (npm is not on PATH): see https://github.com/openai/codex."];
    }
    if (block.signIn.state === "signed-out") return [
      "Run `!codex login`.",
      "If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`."
    ];
    return [];
  }
};

export const REVIEW_GATE_NEXT_STEP =
  "Optional: `/relay:setup --enable-review-gate` has Codex review each turn's edits before the main thread stops (Codex only, off by default; skips while agents or jobs run).";
