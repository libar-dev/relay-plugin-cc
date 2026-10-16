/** @typedef {import("../types").Connection} Connection */
// Kimi's ACP server, isolated from the worker's message and process accounting. ACP carries the
// controls and the live stream; the session's wire.jsonl decides each turn's outcome and report.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { ACP_INITIALIZE_PARAMS, ACP_CHUNKS, acpInitializeParams, acpUpdate, openSession, setConfigOption, promptSession, cancelSession, answerPermission } from "../transport/acp.mjs";
import { partialLineNote, SpawnedServerClient } from "../transport/stdio-rpc.mjs";
import { countPrompts, openTurn, promptTurn, readWire, WireCursor, wireFile, wireSize } from "./wire.mjs";

// How often a turn's records are read, and how long a prompt Kimi answered may go unrecorded
// while no other turn runs before it counts as never launched.
const POLL_MS = Number(process.env.RELAY_JOBS_KIMI_POLL_MS) || 100;
const SETTLE_MS = Number(process.env.RELAY_JOBS_KIMI_SETTLE_MS) || 10000;

export function resolveKimiBinary(env = process.env) {
  const binary = env.KIMI_BINARY || "kimi";
  const userDir = env.HOME || env.USERPROFILE;
  const candidates = binary.includes(path.sep) ? [path.resolve(binary)] : [
    ...String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, binary)),
    // The installer's own location, for a PATH that does not name it.
    ...(userDir ? [path.join(userDir, ".kimi-code", "bin", "kimi")] : [])
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`Kimi binary is not executable: ${binary}`);
}

// A job never updates the binary under itself and schedules nothing that starts turns later.
// Inherited KIMI_MODEL_* variables would replace the header's model and effort.
export function kimiEnvironment(request, env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("KIMI_MODEL_")) result[name] = value;
  }
  return { ...result, KIMI_CODE_HOME: request.kimiHome, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_DISABLE_CRON: "1" };
}

export function kimiEndMessage(info) {
  return `kimi acp ended before the turn finished (${info?.signal ? `signal ${info.signal}` : `exit ${info?.code ?? "unknown"}`}).${info?.pid ? ` pid ${info.pid}.` : ""}${partialLineNote(info, "its output")}${info?.stderrTail ? `\n${info.stderrTail.trim()}` : ""}`;
}

// Kimi puts the detail of a refused option in `data.details`; other errors keep their data.
function rpcError(error) {
  const data = error.data?.data;
  const detail = typeof data?.details === "string" ? `: ${data.details}` : data === undefined ? "" : `\n${JSON.stringify(data)}`;
  return { message: `${error.message}${detail}`, data: error.data };
}

// Read-only: Kimi's `default` mode asks before most tools and every request is rejected, but its
// git policy approves Write and Edit inside a git work tree without asking. The client declares
// file writes and terminals, so Kimi sends both here, and refuses each.
const READ_ONLY_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: true }, terminal: true };
const READ_ONLY_REFUSALS = {
  "fs/write_text_file": "This job is read-only: file writes are refused.",
  "terminal/create": "This job is read-only: shell commands are refused."
};

// Kimi modes: `auto` never asks; `default` asks before writes and shell commands.
const KIMI_MODES = { yolo: "auto", "read-only": "default" };

// Chunk events advance the heartbeat immediately, but only finished messages reach disk.
// Kimi streams a running tool's progress as many tool_call_updates; only the end is kept.
export function kimiEventRecorder(write, touch) {
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
      if (kind === "available_commands_update") return;
      if (kind === "tool_call_update" && !["completed", "failed"].includes(update.status)) return;
      if (!ACP_CHUNKS.has(kind)) {
        const standard = acpUpdate(notification);
        if (standard.startsTool || standard.finishesTool) flush();
        write(notification);
        return;
      }
      const key = `${notification.params.sessionId}:${kind}`;
      const previous = chunks.get(key);
      if (!previous) chunks.set(key, structuredClone(notification));
      else if (update.content?.text != null) previous.params.update.content = { ...previous.params.update.content, text: (previous.params.update.content?.text ?? "") + update.content.text };
      else previous.params.update.chunks = [...(previous.params.update.chunks ?? []), update];
    }
  };
}

/** @implements {Connection} */
class KimiConnection {
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
    this.wire = null;
    this.openOffset = 0;
    this.promptPending = false;
  }

  get server() { return this.client; }
  async close() { await this.client.close(); }

  saveState(patch) {
    this.hooks.saveState(patch);
    this.state = { ...this.state, ...patch };
  }

  wireFile() {
    this.wire ??= wireFile(String(this.request.kimiHome), this.sessionId);
    return this.wire;
  }

  /** @param {import("../types").OpenOptions} options */
  async open({ sessionId }) {
    const client = this.client;
    const request = this.request;
    const resumed = Boolean(sessionId);
    try {
      const response = await openSession(client, request.cwd, sessionId);
      sessionId = sessionId ?? response.sessionId;
      this.sessionId = sessionId;
      // Kimi keeps model and effort across a load but not the mode, so all three go every time.
      await client.request("session/set_mode", { sessionId, modeId: KIMI_MODES[request.mode] });
      for (const [configId, value] of [["model", request.model], ["thinking", request.effort]]) {
        if (value != null) await setConfigOption(client, sessionId, configId, value);
      }
    } catch (error) { throw new Error(rpcError(error).message); }
    this.wire = null;
    // Turns started before this process (a killed one) are never running.
    this.openOffset = wireSize(this.wireFile());
    return { sessionId, resumed };
  }

  // A message reached the session when its record holds more user prompts with its exact text
  // than it held before the send, so a brief may repeat a request on purpose.
  delivered(item) {
    const delivery = this.state.deliveries?.[item.clientId];
    if (!item.recoveryCandidate || !delivery || delivery.sessionId !== this.sessionId) return false;
    return countPrompts(readWire(this.wireFile()), delivery.text) > delivery.heldBefore;
  }

  controlsReady(_turnId) { return this.promptPending; }

  /** @returns {Promise<import("../types").SteerReceipt>} */
  async steer(_turnId, _message) {
    throw new Error("Kimi takes no message during a running turn");
  }

  async interrupt(_turnId) { cancelSession(this.client, this.sessionId); }

  /** @param {import("../types").TurnInput} options */
  async run(options) {
    const client = this.client;
    const sessionId = this.sessionId;
    const prompt = options.prompt;
    let turnId = null;
    let didWork = false;
    const file = this.wireFile();
    const records = readWire(file);
    const running = openTurn(readWire(file, this.openOffset));
    const cursor = new WireCursor(file, wireSize(file));
    const identify = () => {
      if (!cursor.file) cursor.file = this.wireFile();
      const turn = promptTurn(cursor.read(), prompt);
      if (turn?.promptId && !turnId) {
        turnId = turn.promptId;
        options.onTurnId(turnId);
      }
      return turn;
    };
    client.setNotificationHandler(notification => {
      if (notification.params?.sessionId !== sessionId) return;
      if (acpUpdate(notification).didWork) didWork = true;
    });
    const ended = client.exitPromise.then(() => { throw new Error(kimiEndMessage(client.exitInfo)); });
    ended.catch(() => {});
    let timer = null;
    try {
      // The record is saved before the prompt leaves, so a later worker can tell whether it arrived.
      const delivery = { id: options.clientId, kind: options.source, text: prompt, sessionId, heldBefore: countPrompts(records, prompt), at: new Date().toISOString() };
      this.saveState({ deliveries: { ...this.state.deliveries, [delivery.id]: delivery } });
      // A first text block that starts with `/` would run one of Kimi's commands instead.
      const blocks = prompt.startsWith("/") ? [{ type: "text", text: "" }, { type: "text", text: prompt }] : undefined;
      const pending = promptSession(client, sessionId, prompt, blocks);
      this.promptPending = true;
      options.onPending?.();
      timer = setInterval(identify, POLL_MS);
      let response;
      try {
        response = await Promise.race([pending, ended]);
      } catch (error) {
        if (client.exitSeen || client.exitResolved) throw error;
        return { turnId, turnStatus: "failed", finalMessage: "", didWork, retryable: false, error: this.promptError(error) };
      } finally {
        this.promptPending = false;
        clearInterval(timer);
        timer = null;
      }
      // A turn cancelled before it launched leaves no record, so a cancel settles sooner.
      const settleMs = response.stopReason === "cancelled" ? Math.min(SETTLE_MS, 1000) : SETTLE_MS;
      const turn = await Promise.race([this.turnEnd(cursor, identify, running, settleMs), ended]);
      if (!turn) {
        if (response.stopReason === "cancelled") return { turnId, turnStatus: "interrupted", finalMessage: "", didWork, retryable: false };
        return {
          turnId, turnStatus: "failed", finalMessage: "", didWork, retryable: false,
          error: { message: `Kimi answered ${response.stopReason} but its session record shows no turn for this prompt (${cursor.file ?? `no wire.jsonl for session ${sessionId}`}).` }
        };
      }
      const reason = turn.ended.reason;
      const error = turn.ended.error;
      return {
        turnId: turn.promptId ?? turnId,
        turnStatus: reason === "completed" ? "completed" : reason === "cancelled" ? "interrupted" : "failed",
        finalMessage: turn.report,
        didWork: didWork || turn.didWork,
        // Kimi retries a transient model failure itself (429 and 5xx included).
        retryable: false,
        ...(reason === "completed" || reason === "cancelled" ? {} : {
          error: { message: error ? `[${error.code ?? "error"}] ${error.message ?? ""}`.trim() : `Kimi ended the turn: ${reason}`, data: error ?? null }
        })
      };
    } catch (error) {
      return { turnId, turnStatus: "failed", finalMessage: "", didWork, retryable: false, error: { message: error.message } };
    } finally {
      if (timer) clearInterval(timer);
      this.promptPending = false;
      client.setNotificationHandler(null);
    }
  }

  // Waits for the prompt's turn to end in the record. A prompt Kimi queued behind a turn of its
  // own runs after that turn, so the wait lasts while any turn runs.
  async turnEnd(cursor, identify, runningBefore, settleMs) {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const turn = identify();
      if (turn?.ended) return turn;
      const records = cursor.records;
      const busy = openTurn(records) !== null || (runningBefore !== null && !records.some(record => record.type === "turn.ended" && record.turnId === runningBefore));
      if (!turn && !busy && Date.now() > deadline) return null;
      await sleep(POLL_MS);
    }
  }

  promptError(error) {
    const failure = rpcError(error);
    if (error.data?.code === -32000) {
      failure.message = `${failure.message}. Kimi needs a sign-in for ${this.request.kimiHome}: run \`KIMI_CODE_HOME=${this.request.kimiHome} kimi login\`.`;
    }
    return failure;
  }
}

/**
 * @param {import("../types").LaunchRequest} request
 * @param {import("../types").ConnectHooks} hooks
 * @returns {Promise<Connection>}
 */
export async function connect(request, hooks) {
  const binary = resolveKimiBinary(hooks.env);
  hooks.saveState({ binary });
  const readOnly = request.mode !== "yolo";
  const client = new SpawnedServerClient(request.cwd, {
    onSpawn: hooks.onSpawn, onStderr: hooks.onStderr, onEnd: hooks.onEnd,
    notificationTap: hooks.tap, backendName: "kimi", binary, args: ["acp"],
    env: kimiEnvironment(request, hooks.env), jsonrpc: true,
    initializeParams: acpInitializeParams(readOnly ? READ_ONLY_CAPABILITIES : ACP_INITIALIZE_PARAMS.clientCapabilities),
    onServerRequest(message, transport) {
      if (answerPermission(request.mode, message, transport)) return;
      const refusal = readOnly ? READ_ONLY_REFUSALS[message.method] : undefined;
      if (refusal) {
        transport.tap({ method: "kimi/readOnlyRefused", params: { id: message.id, method: message.method, path: message.params?.path, command: message.params?.command } });
        transport.sendMessage({ id: message.id, error: { code: -32000, message: refusal } });
        return;
      }
      transport.tap({ method: "kimi/serverRequest", params: message });
      const error = { code: -32601, message: `Unsupported server request: ${message.method}` };
      transport.tap({ method: "kimi/serverRequestRejected", params: { id: message.id, method: message.method, ...error } });
      transport.sendMessage({ id: message.id, error });
    }
  });
  try { await client.initialize(); }
  catch (error) { await client.close(); throw new Error(client.exitInfo ? kimiEndMessage(client.exitInfo) : error.message); }
  return new KimiConnection(client, request, { ...hooks, state: { ...hooks.state, binary } });
}
