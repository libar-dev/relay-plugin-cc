/** @typedef {import("../types").Connection} Connection */
// Kimi's ACP server, isolated from the worker's message and process accounting. ACP carries the
// controls and the live stream; the session's wire.jsonl decides each turn's outcome and report.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { ACP_INITIALIZE_PARAMS, ACP_CHUNKS, acpInitializeParams, acpUpdate, openSession, setConfigOption, promptSession, cancelSession, answerPermission } from "../transport/acp.mjs";
import { partialLineNote, SpawnedServerClient } from "../transport/stdio-rpc.mjs";
import { KimiWire, wireFile } from "./wire.mjs";

// How often a turn's records are read, and how long a prompt Kimi answered may go unrecorded
// while no other turn runs before it counts as never launched.
const POLL_MS = Number(process.env.RELAY_JOBS_KIMI_POLL_MS) || 100;
const SETTLE_MS = Number(process.env.RELAY_JOBS_KIMI_SETTLE_MS) || 10000;

// An explicit KIMI_BINARY is the one: a name that is not on PATH fails, and never falls back
// to another installation.
export function resolveKimiBinary(env = process.env) {
  const explicit = env.KIMI_BINARY || null;
  const binary = explicit ?? "kimi";
  const userDir = env.HOME || env.USERPROFILE;
  const candidates = binary.includes(path.sep) ? [path.resolve(binary)] : [
    ...String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, binary)),
    // The installer's own location, for a PATH that does not name it.
    ...(!explicit && userDir ? [path.join(userDir, ".kimi-code", "bin", "kimi")] : [])
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
// Inherited KIMI_MODEL_* variables would replace the header's model and effort, and an
// inherited KIMI_CODE_TRUST_WORKSPACE would trust the job's working directory, loading that
// repository's MCP servers, config directories, skills and instructions.
export function kimiEnvironment(request, env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("KIMI_MODEL_") && name !== "KIMI_CODE_TRUST_WORKSPACE") result[name] = value;
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
// file writes and terminals, so Kimi sends both here, and refuses each. It declares file reads
// too: Kimi has no append request, and emulates one as a read and a write only when the client
// serves both; otherwise it appends to the file itself, past the refused write.
const READ_ONLY_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };
const READ_ONLY_REFUSALS = {
  "fs/write_text_file": "This job is read-only: file writes are refused.",
  "terminal/create": "This job is read-only: shell commands are refused."
};

// ACP `fs/read_text_file`: an absolute path, and an optional 1-based `line` and `limit`.
/** @param {{ path?: string, line?: number, limit?: number }} [params] */
async function readTextFile({ path: file, line, limit } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw Object.assign(new Error(`Invalid params: path must be absolute: ${file}`), { rpcCode: -32602 });
  const content = await fs.promises.readFile(file, "utf8");
  if (line == null && limit == null) return content;
  const lines = content.split(/(?<=\n)/);
  const start = Math.max(0, (line ?? 1) - 1);
  return lines.slice(start, limit == null ? undefined : start + limit).join("");
}

function readError(error, file) {
  if (error.code === "ENOENT") return { code: -32002, message: `Resource not found: ${file}` };
  return { code: error.rpcCode ?? -32603, message: error.message };
}

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
export class KimiConnection {
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
    // The session's record, read by this connection alone.
    this.wire = new KimiWire(() => wireFile(String(this.request.kimiHome), this.sessionId));
    // The one wire observer: run() starts it, and run(), interrupt() and close() abort it and
    // wait for it to stop. An observer left polling would keep the worker alive after the job.
    /** @type {{ controller: AbortController, done: Promise<any>, response: { value: any, error: any } } | null} */
    this.observer = null;
  }

  get server() { return this.client; }

  async close() {
    await this.stopObserver("the connection closed");
    await this.client.close();
  }

  observe(response, watch) {
    const controller = new AbortController();
    const done = watch(controller.signal);
    this.observer = { controller, done, response };
    return done;
  }

  async stopObserver(reason) {
    const observer = this.observer;
    if (!observer) return;
    observer.controller.abort(reason);
    await observer.done.catch(() => {});
    if (this.observer === observer) this.observer = null;
  }

  saveState(patch) {
    this.hooks.saveState(patch);
    this.state = { ...this.state, ...patch };
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
    } catch (error) { throw new Error(this.requestError(error).message); }
    // Turns started before this process (a killed one) are never running.
    this.wire.read().forgetRunning();
    return { sessionId, resumed };
  }

  // A message reached the session when the record holds a prompt with its text first recorded
  // after the offset saved before the send: Kimi committed its input, started it, or blocked
  // it. An earlier prompt with the same text was recorded before that offset.
  delivered(item) {
    const delivery = this.state.deliveries?.[item.clientId];
    if (!item.recoveryCandidate || !delivery || delivery.sessionId !== this.sessionId) return false;
    return this.wire.read().promptSince(delivery.offset, delivery.text) !== null;
  }

  // Steer and cancel can go while a prompt waits for its answer or its turn's end.
  controlsReady(_turnId) { return this.observer !== null; }

  /** @returns {Promise<import("../types").SteerReceipt>} */
  async steer(_turnId, _message) {
    throw new Error("Kimi takes no message during a running turn");
  }

  // ACP cancels only a prompt it still drives. One it answered early (queued behind a turn of
  // Kimi's own) ends when relay stops waiting for it and closes the server.
  async interrupt(_turnId) {
    cancelSession(this.client, this.sessionId);
    if (this.observer?.response.value) await this.stopObserver("cancel");
  }

  /** @param {import("../types").TurnInput} options */
  async run(options) {
    const client = this.client;
    const sessionId = this.sessionId;
    const prompt = options.prompt;
    const wire = this.wire.read();
    // Where this prompt's records can start: a record at or after it came after the send.
    const from = wire.consumed;
    const run = { turnId: null, didWork: false, from };
    client.setNotificationHandler(notification => {
      if (notification.params?.sessionId !== sessionId) return;
      if (acpUpdate(notification).didWork) run.didWork = true;
    });
    const ended = client.exitPromise.then(() => { throw new Error(kimiEndMessage(client.exitInfo)); });
    ended.catch(() => {});
    /** @type {{ value: any, error: any }} */
    const response = { value: null, error: null };
    try {
      // The record is saved before the prompt leaves, so a later worker can tell whether it arrived.
      const delivery = { id: options.clientId, kind: options.source, text: prompt, sessionId, offset: from, at: new Date().toISOString() };
      this.saveState({ deliveries: { ...this.state.deliveries, [delivery.id]: delivery } });
      // A first text block that starts with `/` would run one of Kimi's commands instead.
      const blocks = prompt.startsWith("/") ? [{ type: "text", text: "" }, { type: "text", text: prompt }] : undefined;
      promptSession(client, sessionId, prompt, blocks).then(value => { response.value = value; }, error => { response.error = error; });
      const outcome = this.observe(response, signal => this.watch(prompt, run, response, options, signal));
      options.onPending?.();
      return this.result(await Promise.race([outcome, ended]), run);
    } catch (error) {
      return { turnId: run.turnId, turnStatus: "failed", finalMessage: "", didWork: run.didWork, retryable: false, error: { message: error.message } };
    } finally {
      await this.stopObserver(client.exitSeen || client.exitInfo ? "Kimi's server ended" : "the run ended");
      client.setNotificationHandler(null);
    }
  }

  // Reads the record until this prompt's turn ends. ACP answers a prompt Kimi queued behind a
  // turn of its own at once, so the wait lasts while any turn runs. A prompt the record does not
  // show yet has a grace that counts only time Kimi is idle after ACP answered: the hand-off to a
  // queued prompt runs Kimi's prompt hooks first, and busy time must not use the grace up.
  async watch(text, run, response, options, signal) {
    let idleSince = null;
    for (;;) {
      const wire = this.wire.read();
      const prompt = wire.promptSince(run.from, text);
      if (prompt?.started && !run.turnId) {
        run.turnId = prompt.promptId;
        options.onTurnId(prompt.promptId);
      }
      const turn = prompt?.turnId == null ? null : wire.turns.get(prompt.turnId);
      if (turn?.ended) return { kind: "ended", turn };
      // Blocked by a hook, or cancelled, before a turn existed for it.
      if (prompt?.terminal && !prompt.started) return { kind: "terminal", record: prompt.terminal };
      if (response.error) return { kind: "rejected", error: response.error };
      if (signal.aborted) {
        this.hooks.tap?.({ method: "kimi/wireObserverStopped", params: { reason: signal.reason } });
        return { kind: "stopped", reason: signal.reason };
      }
      if (response.value) {
        if (wire.busy) {
          idleSince = null;
        } else {
          idleSince ??= Date.now();
          // A turn cancelled before it launched leaves no record, so a cancel settles sooner.
          const graceMs = response.value.stopReason === "cancelled" ? Math.min(SETTLE_MS, 1000) : SETTLE_MS;
          if (Date.now() - idleSince >= graceMs) return { kind: "unconfirmed", stopReason: response.value.stopReason, graceMs };
        }
      }
      await sleep(POLL_MS, undefined, { signal }).catch(() => {});
    }
  }

  result(outcome, run) {
    const base = { turnId: run.turnId, finalMessage: "", didWork: run.didWork, retryable: false };
    switch (outcome.kind) {
      case "ended": {
        const { reason, error } = outcome.turn.ended;
        return {
          ...base,
          turnStatus: reason === "completed" ? "completed" : reason === "cancelled" ? "interrupted" : "failed",
          finalMessage: outcome.turn.report,
          didWork: run.didWork || outcome.turn.didWork,
          // Kimi retries a transient model failure itself (429 and 5xx included).
          ...(reason === "completed" || reason === "cancelled" ? {} : {
            error: { message: error ? `[${error.code ?? "error"}] ${error.message ?? ""}`.trim() : `Kimi ended the turn: ${reason}`, data: error ?? null }
          })
        };
      }
      case "rejected":
        if (this.client.exitSeen || this.client.exitResolved) return { ...base, turnStatus: "failed", error: { message: outcome.error.message } };
        return { ...base, turnStatus: "failed", error: this.requestError(outcome.error) };
      case "terminal": {
        const { type, reason } = outcome.record;
        if (type === "prompt.aborted") return { ...base, turnStatus: "interrupted" };
        const why = reason === "blocked" ? "a UserPromptSubmit hook blocked it" : `its prompt hooks ended it (${reason})`;
        return { ...base, turnStatus: "failed", error: { message: `Kimi did not run the message: ${why}. The hooks are the Kimi home's (${this.request.kimiHome}).` } };
      }
      case "stopped":
        if (outcome.reason === "cancel") return { ...base, turnStatus: "interrupted" };
        return { ...base, turnStatus: "failed", error: { message: `Kimi's turn was still running when ${outcome.reason}.` } };
      default:
        if (outcome.stopReason === "cancelled") return { ...base, turnStatus: "interrupted" };
        // Kimi took the prompt, but nothing shows that it started. It may still be in Kimi's
        // queue, so the server ends and the prompt is never sent again.
        return {
          ...base, turnStatus: "failed", teardown: true,
          error: { message: `Kimi accepted the message (ACP answered ${outcome.stopReason}), but its session record shows no start for it after ${outcome.graceMs / 1000} s with no turn running (${this.wire.file ?? `no wire.jsonl for session ${this.sessionId}`}). Relay ended Kimi's server and does not send the message again.` }
        };
    }
  }

  // Kimi checks the sign-in at session/new and session/load as well as at a prompt, and answers
  // -32000 (Authentication required) where the selected home is signed out.
  requestError(error) {
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
      if (readOnly && message.method === "fs/read_text_file") {
        const answer = reply => { try { transport.sendMessage({ id: message.id, ...reply }); } catch {} };
        readTextFile(message.params).then(content => answer({ result: { content } }), error => answer({ error: readError(error, message.params?.path) }));
        return;
      }
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
