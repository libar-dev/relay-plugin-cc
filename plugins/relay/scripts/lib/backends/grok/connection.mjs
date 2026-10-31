/** @typedef {import("../types").Connection} Connection */
import { ACP_INITIALIZE_PARAMS, ACP_CHUNKS, acpUpdate, openSession, setConfigOption, promptSession, cancelSession, promptCancelled, promptResult, answerPermission } from "../transport/acp.mjs";
import { heldMessage, evidenceKey, countHeld, grokSessionMessages } from "./history.mjs";
// Grok's ACP protocol, isolated from the worker's message and process accounting.
import fs from "node:fs";
import path from "node:path";
import { partialLineNote, SpawnedServerClient } from "../transport/stdio-rpc.mjs";

export function resolveGrokBinary(env = process.env) {
  const binary = env.GROK_BINARY || "grok";
  const candidates = binary.includes(path.sep) ? [path.resolve(binary)] :
    String(env.PATH ?? "").split(path.delimiter).map(dir => path.resolve(dir, binary));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`Grok binary is not executable: ${binary}`);
}

// Grok shows the model 20,000 bytes of an MCP result, from its start, and saves the rest to a file,
// so a job gets a larger budget unless the environment or the home's `[mcp] max_output_bytes` names
// one: a quarter of its 256k-token window at four bytes per token.
const GROK_MCP_OUTPUT_BYTES = 262144;

// Mask comments and multiline strings, whose contents can look like tables and settings. Ordinary
// quoted keys stay intact for `tomlKeyPath`; this is key detection, not a general TOML parser.
function maskTomlMultilineStrings(text) {
  let out = "";
  let quote = null;
  let multiline = false;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (quote && multiline) {
      if (char === quote) {
        let end = index;
        while (text[end] === quote) end += 1;
        if (end - index >= 3) {
          out += " ".repeat(end - index);
          index = end;
          quote = null;
          multiline = false;
          continue;
        }
      }
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (quote) {
      out += char;
      index += 1;
      if (char === "\\" && quote === '"' && index < text.length) {
        out += text[index];
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if ((char === '"' || char === "'") && text.slice(index, index + 3) === char.repeat(3)) {
      quote = char;
      multiline = true;
      out += "   ";
      index += 3;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    out += char;
    index += 1;
  }
  return out;
}

/** @returns {string[] | null} */
function tomlKeyPath(text) {
  const raw = [];
  let part = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      part += char;
      if (char === "\\" && quote === '"') part += text[++index] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      part += char;
    } else if (char === ".") {
      raw.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  if (quote) return null;
  raw.push(part);
  const parts = [];
  for (const item of raw) {
    const key = item.trim();
    if (!key) return null;
    if (key.startsWith("'") && key.endsWith("'")) parts.push(key.slice(1, -1));
    else if (key.startsWith('"') && key.endsWith('"')) {
      try { parts.push(JSON.parse(key)); } catch { return null; }
    } else parts.push(key);
  }
  return parts;
}

function tomlEntry(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "=") return [line.slice(0, index), line.slice(index + 1)];
  }
  return null;
}

function inlineTableSetsMcpOutput(value) {
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return false;
  const entries = [];
  let entry = "";
  let quote = null;
  let depth = 0;
  const inner = text.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote) {
      entry += char;
      if (char === "\\" && quote === '"') entry += inner[++index] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      entry += char;
    } else if (char === "{" || char === "[") {
      depth += 1;
      entry += char;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      entry += char;
    } else if (char === "," && depth === 0) {
      entries.push(entry);
      entry = "";
    } else entry += char;
  }
  entries.push(entry);
  return entries.some((item) => {
    const pair = tomlEntry(item);
    const key = pair ? tomlKeyPath(pair[0]) : null;
    return key?.length === 1 && key[0] === "max_output_bytes";
  });
}

function grokHomeSetsMcpOutput(grokHome) {
  let text;
  try {
    text = fs.readFileSync(path.join(grokHome, "config.toml"), "utf8");
  } catch {
    return false;
  }
  /** @type {string[] | null} */
  let table = [];
  for (const line of maskTomlMultilineStrings(text).split(/\r?\n/)) {
    const header = /^\s*\[(\[?)([^\[\],]*)\]\]?\s*$/.exec(line);
    if (header) {
      table = header[1] ? null : tomlKeyPath(header[2]);
      continue;
    }
    const entry = tomlEntry(line);
    if (!entry || table === null) continue;
    const key = tomlKeyPath(entry[0]);
    if (!key) continue;
    const path = [...table, ...key];
    if (path.length === 2 && path[0] === "mcp" && path[1] === "max_output_bytes") return true;
    if (path.length === 1 && path[0] === "mcp" && inlineTableSetsMcpOutput(entry[1])) return true;
  }
  return false;
}

export function grokEnvironment(request, env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const result = { ...env, GROK_HOME: request.grokHome, GROK_MEMORY: "0" };
  for (const source of ["CLAUDE", "CURSOR"]) {
    for (const kind of ["HOOKS", "SKILLS", "MCPS", "RULES", "AGENTS", "SESSIONS"]) result[`GROK_${source}_${kind}_ENABLED`] = "0";
  }
  if (env.GROK_MAX_MCP_OUTPUT_BYTES == null && env.MAX_MCP_OUTPUT_BYTES == null && !grokHomeSetsMcpOutput(request.grokHome)) {
    result.GROK_MAX_MCP_OUTPUT_BYTES = String(GROK_MCP_OUTPUT_BYTES);
  }
  delete result.GROK_SANDBOX;
  if (request.mode !== "yolo") result.GROK_SANDBOX = request.mode === "write" ? "workspace" : "read-only";
  return result;
}

export function grokEndMessage(info) {
  return `grok agent ended before the turn finished (${info?.signal ? `signal ${info.signal}` : `exit ${info?.code ?? "unknown"}`}).${info?.pid ? ` pid ${info.pid}.` : ""}${partialLineNote(info, "the agent's output")}${info?.stderrTail ? `\n${info.stderrTail.trim()}` : ""}`;
}

function rpcError(error) {
  return { message: `${error.message}${error.data?.data === undefined ? "" : `\n${JSON.stringify(error.data.data)}`}`, data: error.data };
}

const CHUNKS = new Set([...ACP_CHUNKS, "tool_call_delta_chunk"]);

// Chunk events advance the heartbeat immediately, but only finished messages reach disk.
export function grokEventRecorder(write, touch) {
  const chunks = new Map();
  const flush = () => {
    for (const notification of chunks.values()) write(notification);
    chunks.clear();
  };
  return {
    flush,
    record(notification) {
      touch();
      const update = notification.params?.update;
      const kind = update?.sessionUpdate;
      if (!CHUNKS.has(kind)) {
        const standard = acpUpdate(notification);
        if (kind === "response_completed" || kind === "turn_completed" || standard.finishesTool || standard.startsTool || notification.method === "_x.ai/session/prompt_complete") flush();
        write(notification);
        return;
      }
      const key = `${notification.params.sessionId}:${kind}:${update.toolCallId ?? ""}`;
      const previous = chunks.get(key);
      if (!previous) {
        chunks.set(key, structuredClone(notification));
      } else {
        const target = previous.params.update;
        if (update.content?.text != null) target.content = { ...target.content, text: (target.content?.text ?? "") + update.content.text };
        else target.chunks = [...(target.chunks ?? []), update];
      }
    }
  };
}

/** @implements {Connection} */
class GrokConnection {
  /**
   * @param {import("../types").LaunchRequest} request
   * @param {import("../types").ConnectHooks} hooks
   */
  constructor(client, request, hooks) {
    this.client = client;
    this.request = request;
    this.hooks = hooks;
    /** @type {Record<string, any>} */
    this.state = { ...hooks.state };
    this.sessionId = null;
    this.replay = { messages: [], persisted: [] };
    this.heldCounts = new Map();
    this.openDeliveries = [];
    this.running = null;
    this.promptPending = false;
    this.steers = 0;
    this.controlChanged = null;
  }

  get server() { return this.client; }
  async close() { await this.client.close(); }

  saveState(patch) {
    this.hooks.saveState(patch);
    this.state = { ...this.state, ...patch };
  }

  saveDeliveries(deliveries) {
    if (deliveries.length > 0) this.saveState({ deliveries: { ...this.state.deliveries, ...Object.fromEntries(deliveries.map(entry => [entry.id, { ...entry }])) } });
  }

  recordDelivery(item, method) {
    const delivery = this.prepareDelivery(item, method);
    delivery.at = new Date().toISOString();
    this.saveDeliveries([delivery]);
    return delivery;
  }

  steerHeld(id) {
    const delivery = this.openDeliveries.find(entry => entry.id === id);
    if (!delivery || !this.held(delivery)) return false;
    this.settle(delivery, true);
    return true;
  }

  steerLost(id) {
    const delivery = this.openDeliveries.find(entry => entry.id === id);
    if (delivery) this.saveDeliveries(this.settle(delivery, false));
  }

  /** @param {import("../types").OpenOptions} options */
  async open({ sessionId }) {
    const client = this.client;
    const request = this.request;
    const resumed = Boolean(sessionId);
    const replay = this.replay = { messages: [], persisted: [] };
    let user = "";
    let userKey = null;
    const flushUser = () => {
      if (user) replay.messages.push(heldMessage(user));
      user = "";
      userKey = null;
    };
    client.setNotificationHandler(notification => {
      if (sessionId && notification.params?.sessionId !== sessionId) return;
      const update = notification.params?.update;
      const standard = acpUpdate(notification);
      if (standard.userText !== null) {
        const key = update._meta?.promptIndex ?? notification.params?._meta?.promptId ?? null;
        if (user && key != null && userKey != null && key !== userKey) flushUser();
        userKey = key ?? userKey;
        user += standard.userText;
      } else if ((standard.replayBoundary || update?.sessionUpdate === "turn_completed") || notification.method === "_x.ai/session/prompt_complete") {
        flushUser();
      }
    });
    let response;
    try {
      response = await openSession(client, request.cwd, sessionId);
      sessionId = sessionId ?? response.sessionId;
      flushUser();
      replay.persisted = grokSessionMessages(request, sessionId);
      this.sessionId = sessionId;
      this.heldCounts = new Map();
      for (const [configId, value] of [["model", request.model], ["reasoning_effort", request.effort]]) {
        if (value != null) await setConfigOption(client, sessionId, configId, value);
      }
    } catch (error) { throw new Error(rpcError(error).message); }
    finally { client.setNotificationHandler(null); }
    return { sessionId, resumed };
  }

  // The connection saves this record synchronously before sending the request. `heldBefore` is
  // how many matching copies the history must hold before this one counts as delivered: what
  // it held before the send, or, behind identical interjections still open, one more than the
  // last of them. Each persisted copy so confirms at most one of them, in the order sent.
  prepareDelivery(item, method) {
    const key = evidenceKey(method, item.prompt);
    const open = (this.openDeliveries ??= []);
    const earlier = open.filter(entry => evidenceKey(entry.method, entry.text) === key);
    let heldBefore;
    if (earlier.length > 0) heldBefore = Math.max(...earlier.map(entry => entry.heldBefore)) + 1;
    else {
      const persisted = grokSessionMessages(this.request, this.sessionId);
      heldBefore = Math.max(countHeld(this.replay.messages, method, item.prompt), countHeld(persisted, method, item.prompt), this.heldCounts.get(key) ?? 0);
    }
    const delivery = { id: item.clientId, kind: item.source, text: item.prompt, method, sessionId: this.sessionId, heldBefore };
    // An interjection stays open until its copy is in the history or it is ruled out.
    if (method === "_x.ai/interject") open.push(delivery);
    return delivery;
  }
  // Whether this session's persisted history holds a delivery beyond the matches it held
  // before the send. A `queued` interjection is delivered only once this is true.
  held(delivery) {
    if (delivery.refused) return false;
    const persisted = grokSessionMessages(this.request, this.sessionId);
    return countHeld(persisted, delivery.method, delivery.text) > delivery.heldBefore;
  }
  // Close an open interjection. Held, it is one of the copies the history holds; not held,
  // it is ruled out as delivery evidence and every later identical open one moves down a
  // place. Returns all changed records to save.
  settle(delivery, held) {
    const open = this.openDeliveries ?? [];
    const index = open.indexOf(delivery);
    if (index !== -1) open.splice(index, 1);
    if (held) {
      this.accepted(delivery);
      return [];
    }
    delivery.refused = true;
    if (index === -1) return [delivery];
    const key = evidenceKey(delivery.method, delivery.text);
    const moved = open.slice(index).filter(entry => evidenceKey(entry.method, entry.text) === key);
    for (const entry of moved) entry.heldBefore -= 1;
    return [delivery, ...moved];
  }
  accepted(delivery) {
    if (!delivery) return;
    const key = evidenceKey(delivery.method, delivery.text);
    this.heldCounts.set(key, Math.max(this.heldCounts.get(key) ?? 0, delivery.heldBefore + 1));
  }
  delivered(item) {
    const delivery = this.state.deliveries?.[item.clientId];
    if (!item.recoveryCandidate || !delivery || delivery.refused || delivery.sessionId !== this.sessionId) return false;
    const count = Math.max(countHeld(this.replay.messages, delivery.method, delivery.text), countHeld(this.replay.persisted, delivery.method, delivery.text));
    return count > delivery.heldBefore;
  }
  controlsReady(_turnId) { return Boolean(this.promptPending || this.running); }

  /** @param {import("../types").InboxMessage} message */
  async steer(turnId, message) {
    // The queue is authoritative, even while the worker is settling this turn.
    if (!this.promptPending && !this.running) throw new Error("no turn is running");
    const client = this.client;
    const sessionId = this.sessionId;
    const delivery = this.recordDelivery({ clientId: message.id, source: message.kind, prompt: message.text }, "_x.ai/interject");
    const promptId = this.running;
    this.steers = (this.steers ?? 0) + 1;
    try {
      const response = await client.request("_x.ai/interject", { sessionId, text: message.text });
      const status = response.result?.status ?? response.status;
      if (status !== "queued") throw new Error(`Grok did not queue the interjection: ${status ?? "unknown"}`);
      // Queued is not durable: Grok can lose the interjection before it persists it.
      if (promptId) this.saveState({ promptIds: { ...this.state.promptIds, [message.id]: promptId } });
      return { turnId, promptId, unconfirmed: true };
    } catch (error) {
      if (!client.exitSeen) this.saveDeliveries(this.settle(delivery, false));
      throw error;
    } finally {
      this.steers -= 1;
      this.controlChanged?.();
    }
  }
  async interrupt(_turnId) { cancelSession(this.client, this.sessionId); }

  /** @param {import("../types").TurnInput} options */
  async run(options) {
    const client = this.client;
    const sessionId = this.sessionId;
    let turnId = null;
    let currentDelivery = null;
    const known = new Set(Object.values(this.state.promptIds ?? {}));
    let text = "";
    /** @type {{ turnId: string, stopReason: string, finalMessage: string } | null} */
    let last = null;
    let queuedCount = 0;
    let didWork = false;
    let responseDone = false;
    let resolveIdle;
    const idle = new Promise(resolve => { resolveIdle = resolve; });
    const unfinished = new Set();
    const check = () => { if (responseDone && !queuedCount && !this.running && !this.steers && !unfinished.size) resolveIdle(); };
    this.controlChanged = check;
    const identify = id => {
      if (!id || turnId) return;
      turnId = id;
      this.accepted(currentDelivery);
      this.saveState({ promptIds: { ...this.state.promptIds, [options.clientId]: id } });
      options.onTurnId(id);
    };
    client.setNotificationHandler(notification => {
      const params = notification.params ?? {};
      if (params.sessionId !== sessionId) return;
      if (notification.method === "_x.ai/queue/changed") {
        this.running = params.runningPromptId ?? null;
        if (this.running) unfinished.add(this.running);
        queuedCount = params.entries?.length ?? 0;
        if (params.runningPromptId && params.runningKind === "prompt" && !known.has(params.runningPromptId) && String(params.runningText ?? "").trim() === options.prompt.trim()) identify(params.runningPromptId);
        check();
      }
      const update = params.update;
      const standard = acpUpdate(notification);
      if (standard.didWork || update?.sessionUpdate === "tool_call_delta_chunk") didWork = true;
      if (standard.startsTool) text = "";
      if (standard.agentText !== null) text += standard.agentText;
      if (update?.sessionUpdate === "turn_completed") {
        last = { turnId: update.prompt_id, stopReason: update.stop_reason, finalMessage: text };
        text = "";
        unfinished.delete(update.prompt_id);
        if (this.running === update.prompt_id) this.running = null;
        check();
      }
    });
    try {
      const delivery = this.recordDelivery(options, "session/prompt");
      currentDelivery = delivery;
      const pending = promptSession(client, sessionId, options.prompt);
      this.promptPending = true;
      options.onPending?.();
      const response = await pending;
      this.promptPending = false;
      identify(response._meta?.promptId);
      // A prompt response alone cannot retire a prompt the queue still says is running.
      // Cancellation is terminal even when Grok omits its empty-queue notification.
      if (promptCancelled(response.stopReason)) queuedCount = 0;
      if (promptCancelled(response.stopReason) || (!this.running && !queuedCount)) {
        unfinished.delete(response._meta?.promptId ?? turnId);
        if (this.running === (response._meta?.promptId ?? turnId)) this.running = null;
      }
      responseDone = true;
      check();
      await Promise.race([idle, client.exitPromise.then(() => { throw new Error(grokEndMessage(client.exitInfo)); })]);
      const reason = last?.stopReason ?? response.stopReason;
      if (promptResult(reason).turnStatus !== "failed") this.accepted(delivery);
      return {
        turnId: last?.turnId ?? turnId,
        ...promptResult(reason),
        finalMessage: last?.finalMessage ?? text,
        didWork
      };
    } catch (error) { return { turnId, turnStatus: "failed", finalMessage: "", didWork, error: rpcError(error) }; }
    finally { this.promptPending = false; this.controlChanged = null; this.running = null; client.setNotificationHandler(null); }
  }
}

/**
 * @param {import("../types").LaunchRequest} request
 * @param {import("../types").ConnectHooks} hooks
 * @returns {Promise<Connection>}
 */
export async function connect(request, hooks) {
    const binary = resolveGrokBinary(hooks.env);
    hooks.saveState({ binary });
    const client = new SpawnedServerClient(request.cwd, {
      onSpawn: hooks.onSpawn, onStderr: hooks.onStderr, onEnd: hooks.onEnd,
      notificationTap: hooks.tap, backendName: "grok", binary, args: ["agent", "--no-leader", "--always-approve", "stdio"],
      env: grokEnvironment(request, hooks.env), jsonrpc: true,
      initializeParams: ACP_INITIALIZE_PARAMS,
      onServerRequest(message, transport) {
        if (!answerPermission(request.mode, message, transport)) {
          transport.tap({ method: "grok/serverRequest", params: message });
          const error = { code: -32601, message: `Unsupported server request: ${message.method}` };
          transport.tap({ method: "grok/serverRequestRejected", params: { id: message.id, method: message.method, ...error } });
          transport.sendMessage({ id: message.id, error });
        }
      }
    });
    try { await client.initialize(); }
    catch (error) { await client.close(); throw new Error(client.exitInfo ? grokEndMessage(client.exitInfo) : error.message); }
    return new GrokConnection(client, request, { ...hooks, state: { ...hooks.state, binary } });
}
