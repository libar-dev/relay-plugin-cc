import path from "node:path";
import { SpawnedServerClient } from "../transport/stdio-rpc.mjs";
import { zcodeBackend } from "./index.mjs";
import { resolveZcodeBinary, zcodeEnvironment, zcodeModelRefs, zcodeSignIn } from "./connection.mjs";
import { ZCODE_DEFAULT_EFFORT } from "./defaults.mjs";
import { emptyBlock, notInstalled, isScript, firstLine, lastLine, userDir, seconds, closeWithin, effortName, versionOf, tryResolve } from "../setup.mjs";

// One `zcode app-server`, as a job starts it: `session/create` with `persistence: "deferred"`,
// a draft that ZCode keeps in memory until a first message, then `session/close`. No message
// is sent, so no model is called and nothing is saved. The draft's snapshot lists every model
// the sign-in serves, the list ZCode's model picker shows; a subscription's lists only one.
// `available` is null when the snapshot has no list. A draft ZCode does not confirm closed is
// a warning that names it; the list stands.
async function askZcodeServer(cwd, binary, env, limitMs) {
  const answer = { listed: false, available: null, current: null, error: null, warnings: [] };
  let closing = null;
  // Once the check has its answer, a late end of the work (the server stopped below) says nothing.
  let decided = false;
  const unclosed = (sessionId, why) => `setup's draft ZCode session ${sessionId} was not closed: ${why}.`;
  let stderr = "";
  const client = /** @type {any} */ (new SpawnedServerClient(cwd, {
    backendName: "zcode", binary, args: ["app-server"], env: zcodeEnvironment(env),
    initializeMethod: "runtime/capabilities", initializeParams: {},
    processGroup: true,
    onStderr(chunk) { stderr = (stderr + chunk.toString("utf8")).slice(-4096); },
    onServerRequest(message, transport) {
      if (message.method === "session/requestRuntimePreferences") {
        transport.sendMessage({ id: message.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" } });
      } else if (message.method === "interaction/requestOfficialMcpAuthHeaders") {
        transport.sendMessage({ id: message.id, result: { ok: false, reason: "official_auth_unavailable" } });
      } else {
        transport.sendMessage({ id: message.id, error: { code: -32601, message: `setup does not answer ${message.method}` } });
      }
    }
  }));
  const work = (async () => {
    await client.initialize();
    const snapshot = await client.request("session/create", {
      workspace: { workspacePath: cwd, workspaceKey: cwd }, persistence: "deferred", mode: "build", titleGenerationEnabled: false
    });
    const model = snapshot?.settings?.model;
    answer.listed = true;
    answer.available = Array.isArray(model?.available) ? model.available : null;
    answer.current = model?.current ?? null;
    const sessionId = snapshot?.session?.sessionId;
    if (!sessionId) {
      answer.warnings.push("setup's draft ZCode session was not closed: session/create named no session.");
      return;
    }
    closing = sessionId;
    let closed;
    try {
      closed = await client.request("session/close", { sessionId, expectedPersistence: "deferred" });
    } catch (error) {
      closing = null;
      if (!decided) answer.warnings.push(unclosed(sessionId, `session/close failed: ${firstLine(error.message)}`));
      return;
    }
    closing = null;
    if (closed?.closed !== true && !decided) answer.warnings.push(unclosed(sessionId, `session/close answered closed: ${JSON.stringify(closed?.closed ?? null)}`));
  })();
  work.catch(() => {});
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), limitMs); });
  try {
    if (await Promise.race([work.then(() => "done"), timeout]) === "timeout") {
      // The list read before the time ran out stands; only the close is missing.
      if (answer.listed && closing) answer.warnings.push(unclosed(closing, `no answer to session/close in ${seconds(limitMs)}`));
      else answer.error = `no answer in ${seconds(limitMs)}`;
    }
  } catch (error) {
    const said = /server ended before/.test(error.message) ? lastLine(stderr) : "";
    answer.error = `zcode app-server: ${said || firstLine(error.message)}`;
  } finally {
    decided = true;
    clearTimeout(timer);
    await closeWithin(client, 2000);
  }
  return answer;
}

function zcodeEfforts(entry) {
  const levels = Array.isArray(entry?.reasoning?.levels) ? entry.reasoning.levels.map(level => effortName(level?.value ?? level)).filter(Boolean) : [];
  return levels.length ? levels : null;
}

async function checkZcode(cwd, home, env, shared, limits) {
  const started = Date.now();
  const block = emptyBlock(home, zcodeBackend.capabilities);
  if (!shared.binary) return notInstalled(block, "zcode: not installed (ZCODE_BINARY or PATH)");
  block.binary = shared.binary;
  block.binaryIsScript = isScript(shared.binary);
  const version = await shared.version;
  block.version = version.text;
  const signIn = zcodeSignIn(env);
  block.model = signIn.defaultModel;
  block.effort = ZCODE_DEFAULT_EFFORT;
  block.effortNote = "plugin default; ZCode's own is max";
  block.models = signIn.defaultModel ? [{ id: signIn.defaultModel, efforts: null, defaultEffort: null }] : [];
  block.signIn = signIn.credentialsPresent
    ? { state: "credentials-present", method: "zcode login", detail: signIn.credentials }
    : { state: "signed-out", method: null, detail: `no credentials at ${signIn.credentials} (run zcode login)` };
  if (version.error || !signIn.credentialsPresent) {
    block.elapsedMs = Date.now() - started;
    block.modelsReason = version.error ? "not checked: zcode --version failed" : "signed out";
    if (version.error) block.error = version.error;
    return block;
  }
  const answer = await askZcodeServer(cwd, shared.binary, env, limits.serverMs);
  block.elapsedMs = Date.now() - started;
  block.warnings.push(...answer.warnings);
  // No list, or an empty one, is no catalog: the block is not ready and says why.
  const entries = (answer.available ?? []).filter(entry => zcodeModelRefs({ available: [entry] }).length === 1);
  const failure = answer.error
    ?? (answer.available === null ? "zcode app-server: session/create answered without a model list" : null)
    ?? (entries.length === 0 ? "ZCode listed no model for this sign-in" : null);
  if (failure) {
    block.modelsReason = failure;
    block.error = failure;
    return block;
  }
  block.models = entries.map(entry => {
    const ref = entry.ref ?? entry;
    return { id: `${ref.providerId}/${ref.modelId}`, efforts: zcodeEfforts(entry), defaultEffort: effortName(entry.reasoning?.defaultLevel) };
  });
  const current = answer.current?.providerId && answer.current?.modelId ? `${answer.current.providerId}/${answer.current.modelId}` : null;
  block.model = current ?? signIn.defaultModel;
  block.modelsReason = null;
  block.ready = true;
  return block;
}

/** @type {import("../types").SetupProbe} */
export const setupProbe = {
  homes(env) { return [this.home(null, env)]; },
  home(_value, env) {
    const base = env.ZCODE_DATA_BASE_DIR?.trim() || userDir(env);
    return { backend: "zcode", home: path.join(base, ".zcode"), homeDefault: true, selector: null };
  },
  prepare({ cwd, env, limits }) {
    const binary = tryResolve(resolveZcodeBinary, env);
    return { binary, version: versionOf(binary, "zcode", cwd, zcodeEnvironment(env), limits) };
  },
  check(home, shared, { cwd, env, limits }) { return checkZcode(cwd, home, env, shared, limits); },
  nextSteps(block) { return block.signIn.state === "signed-out" ? ["Run `!zcode login` once."] : []; }
};
