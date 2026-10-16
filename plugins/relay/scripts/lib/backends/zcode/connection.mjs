/** @typedef {import("../types").Connection} Connection */
// ZCode's app-server protocol, isolated from the worker's message and process accounting.
// Sessions and turns go through ZCode Protocol v4 commands (`v4/command`); a turn's start and
// end come from the session subscription (`session/event`). Every message is sent with the
// plugin's message id as its command id, and a resumed session's user messages carry that id
// as `sourceCommandId`, so a new worker can tell which messages already reached the session.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { partialLineNote, SpawnedServerClient } from "../transport/stdio-rpc.mjs";

import { ZCODE_DEFAULT_EFFORT } from "./defaults.mjs";
const CLIENT_ID = "relay-plugin";
const DELIVERY_KIND = "desktop-continuous";
const DISCARDED_ON_RESTART = "fault.command.inputDiscardedOnRestart";
const SESSION_UNAVAILABLE = -32004;
const LIST_TIMEOUT = Symbol("model list timeout");

// `unresolvedInputMs`: how long a steer ZCode accepted may stay neither in a turn nor drained
// into one, once nothing runs, before the run ends without it and reports it dropped.
// `duplicateStartMs`: how long a message whose id ZCode already holds may take to start
// before it is sent again under a new id. `modelListMs`: how long the read of every model the
// sign-in serves may take before the named model is sent as written.
function zcodeTimings(env = process.env) {
  const ms = (name, fallback) => {
    const value = Number(env[name]);
    return env[name] && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    unresolvedInputMs: ms("RELAY_JOBS_ZCODE_UNRESOLVED_MS", 10000),
    duplicateStartMs: ms("RELAY_JOBS_ZCODE_DUPLICATE_MS", 2000),
    modelListMs: ms("RELAY_JOBS_ZCODE_MODEL_LIST_MS", 10000)
  };
}

// Tools no job gets: they wait for a person, run work outside the limits each message
// carries (a subagent inherits only the session's own tool lists, which a new v4 session
// lacks; a Cron entry runs later), or read other sessions.
const UNATTENDED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Agent", "SendMessage", "CronCreate", "CronDelete", "CronList", "CronUpdate", "ReadSessionContext"];
const WEB_TOOLS = ["WebSearch", "WebFetch", "mcp__web_reader__webReader"];
// Removed in read-only: they write files, or run commands or code.
const WRITING_TOOLS = ["Write", "Edit", "Bash", "TaskStop", "mcp__node_repl__js"];
// Everything a read-only job may use. A resumed read-only session is held to exactly these;
// a new one loses the tools above on every message, and its permission requests are allowed
// only for these.
const READING_TOOLS = ["Read", "Skill", "TaskOutput", "TodoRead", "TodoWrite", "mcp__4_5v_mcp__analyze_image"];

function zcodeReadOnlyTools(request) {
  return [...READING_TOOLS, ...(request.webSearch === "disabled" ? [] : WEB_TOOLS)];
}

export function resolveZcodeBinary(env = process.env) {
  const binary = env.ZCODE_BINARY || "zcode";
  const candidates = binary.includes(path.sep) ? [path.resolve(binary)] :
    String(env.PATH ?? "").split(path.delimiter).map(dir => path.resolve(dir, binary));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`ZCode binary is not executable: ${binary}`);
}

// The app-server reuses the CLI's own sign-in (`zcode login`); host mode would wait for this
// client to supply account credentials.
export function zcodeEnvironment(env = process.env) {
  const result = { ...env };
  delete result.ZCODE_APP_SERVER_AUTH_MODE;
  return result;
}

function zcodeSessionMode(request) { return request.mode === "yolo" ? "yolo" : "build"; }

function zcodeToolDenylist(request) {
  return [...UNATTENDED_TOOLS, ...(request.webSearch === "disabled" ? WEB_TOOLS : []), ...(request.mode === "yolo" ? [] : WRITING_TOOLS)];
}

export function zcodeEndMessage(info) {
  return `zcode app-server ended before the turn finished (${info?.signal ? `signal ${info.signal}` : `exit ${info?.code ?? "unknown"}`}).${info?.pid ? ` pid ${info.pid}.` : ""}${partialLineNote(info)}${info?.stderrTail ? `\n${info.stderrTail.trim()}` : ""}`;
}

function protocolMessage(error) {
  const data = error.data?.data;
  const detail = data && typeof data === "object" ? (data.code ?? data.name) : data;
  return `${error.message}${detail == null ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`;
}

const NOISE_METHODS = new Set(["v4/telemetry/event", "process/mcpTelemetry", "process/toolExecResource", "startup/storageState", "state.updated", "computer-use/operation-event"]);
const NOISE_EVENTS = new Set(["model.streaming", "part.delta"]);

// Every notification advances the heartbeat. Telemetry, token deltas and the once-a-second
// progress of a running tool stay out of events.jsonl; finished messages arrive whole in
// `session.updated` and `turn.completed`.
export function zcodeEventRecorder(write, touch) {
  return {
    flush() {},
    record(notification) {
      touch();
      if (NOISE_METHODS.has(notification.method)) return;
      const type = notification.params?.type;
      if (notification.method === "session/event" && (NOISE_EVENTS.has(type) || (type === "tool.updated" && notification.params.payload?.kind === "progress"))) return;
      write(notification);
    }
  };
}

function answerServerRequest(request, message, transport) {
  const params = message.params ?? {};
  if (message.method === "session/requestRuntimePreferences") {
    transport.sendMessage({ id: message.id, result: { nativeSearchEnhancementsEnabled: request.webSearch === "live", memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" } });
    return;
  }
  if (message.method === "interaction/requestPermission") {
    const allowed = request.mode === "yolo" || zcodeReadOnlyTools(request).includes(params.toolName);
    const option = allowed ? (params.options ?? []).find(entry => entry.kind === "allow_once" && entry.response?.decision === "allow") : null;
    const response = option?.response ?? { decision: "deny", reason: `This job runs in mode ${request.mode}, which does not allow ${params.toolName ?? "this tool"}. It did not run; do not try another way to do the same thing.` };
    transport.tap({ method: "zcode/permission", params: { requestId: params.requestId, toolName: params.toolName, decision: response.decision } });
    transport.sendMessage({ id: message.id, result: response });
    return;
  }
  if (message.method === "interaction/requestUserInput") {
    // AskUserQuestion is removed from every job; anything else that asks gets no answer.
    transport.tap({ method: "zcode/userInputDeclined", params: { requestId: params.requestId, toolName: params.toolName } });
    transport.sendMessage({ id: message.id, result: { action: "decline", reason: "This job has no interactive user. Decide yourself and continue." } });
    return;
  }
  if (message.method === "interaction/requestOfficialMcpAuthHeaders") {
    // The plugin holds no Z.ai credentials. ZCode marks its official MCP servers (web reader,
    // image analysis) failed; its native web tools are unaffected.
    transport.sendMessage({ id: message.id, result: { ok: false, reason: "official_auth_unavailable" } });
    return;
  }
  const error = message.method.startsWith("interaction/browser")
    ? { code: -32601, message: "Browser control is not available in a plugin job; use the shell or the web tools." }
    : { code: -32601, message: `Unsupported server request: ${message.method}` };
  transport.tap({ method: "zcode/serverRequestRejected", params: { id: message.id, method: message.method, ...error } });
  transport.sendMessage({ id: message.id, error });
}

// A request written to a server that has already ended, or to a session ZCode closed, never
// settles, so every request, and every wait between requests, races both.
function live(connection, promise) {
  return Promise.race([promise, connection.server.exitPromise.then(() => { throw new Error(zcodeEndMessage(connection.server.exitInfo)); }), ...(connection.session?.closedPromise ? [connection.session.closedPromise] : [])]);
}

function call(connection, method, params) {
  return live(connection, Promise.resolve().then(() => connection.client.request(method, params)));
}

function command(connection, sessionId, type, payload, commandId = randomUUID()) {
  return call(connection, "v4/command", { commandId, clientId: CLIENT_ID, sessionId, type, payload, issuedAt: Date.now() });
}

// A stop with steers still queued pauses ZCode's queue, durably, and ZCode then refuses every
// message that does not say what to do with it. Those steers were reported dropped, so every
// message clears them; ZCode ignores the field when nothing is held.
function sendText(connection, commandId, text, requestedDelivery) {
  const z = connection.session;
  const denied = zcodeToolDenylist(z.request);
  return command(connection, z.sessionId, "sendText", {
    text, requestedDelivery, modelSelection: z.selection, mode: zcodeSessionMode(z.request), heldQueueDisposition: "clearQueueAndSend",
    ...(denied.length ? { toolDisallowlist: denied } : {})
  }, commandId);
}

function refused(ack, what) {
  return `ZCode refused the ${what} (${ack?.status ?? "no answer"}${ack?.reasonCode ? `, ${ack.reasonCode}` : ""})${ack?.message ? `: ${ack.message}` : ""}`;
}

// A message sent again under a new id carries `~<n>`; it is still the same message. This
// process never reuses an id it sent: a steer that comes back to run as a turn takes the next
// suffix at once.
const baseId = id => String(id).replace(/~\d+$/, "");
function nextCommandId(z, id) {
  let candidate = id;
  for (let n = 1; z.sent.has(candidate); n += 1) candidate = `${id}~${n}`;
  z.sent.add(candidate);
  return candidate;
}

function inputIdsOf(payload) {
  return [
    ...(payload.drainedInputs ?? []).map(input => input.intent?.sourceCommandId),
    ...(payload.pendingInputIds ?? []).map(id => String(id).replace(/^queue_/, ""))
  ].filter(Boolean);
}

// Session state that outlives a single turn: a message steered just as a turn ended starts
// its own turn, and a turn can start between two worker calls.
function trackSession(connection, notification) {
  const z = connection.session;
  if (notification.method !== "session/event" || notification.params?.sessionId !== z.sessionId) return;
  const { type, turnId, payload = {} } = notification.params;
  if (type === "turn.started") {
    z.running.set(turnId, payload.inputId ?? null);
    z.outstanding.delete(payload.inputId);
    if (z.cancelRequested) void command(connection, z.sessionId, "stop", {}).catch(() => {});
  } else if (type === "turn.steerDrained") {
    for (const id of inputIdsOf(payload)) z.outstanding.delete(id);
  } else if (type === "turn.completed" || type === "turn.failed") {
    z.running.delete(turnId);
    z.outstanding.delete(payload.inputId);
    z.ended.push({ turnId, inputId: payload.inputId ?? null, type, payload });
  } else if (type === "session.closed") {
    if (z.closed === null) {
      z.closed = String(payload.reason ?? "");
      z.rejectClosed(new Error(`ZCode closed the session${z.closed ? `: ${z.closed}` : "."}`));
    }
  } else return;
  z.changed?.();
}

// The models a ZCode snapshot lists, as `{ providerId, modelId }`. `session/create` and
// `session/resume` list every model the sign-in serves (ZCode's provider registry, the list its
// model picker shows); `session/subscribe` and `session/read` list only the session's current one.
export function zcodeModelRefs(model) {
  return (model?.available ?? []).map(entry => entry?.ref ?? entry).filter(ref => ref?.providerId && ref?.modelId);
}

// A named model matched without regard to case against a snapshot's models: `ref` is ZCode's
// own spelling, or null. `provider/model` picks a provider (`provider` is set even without a
// match); a bare id prefers the current model's provider.
function matchZcodeModel(text, settings) {
  const available = zcodeModelRefs(settings);
  const lower = String(text).toLowerCase();
  const provider = available.find(entry => lower.startsWith(`${entry.providerId.toLowerCase()}/`))?.providerId ?? null;
  const modelId = provider ? String(text).slice(provider.length + 1) : String(text);
  const matches = available.filter(entry => entry.modelId.toLowerCase() === modelId.toLowerCase() && (!provider || entry.providerId === provider));
  const ref = matches.find(entry => entry.providerId === settings?.current?.providerId) ?? matches[0] ?? null;
  return { ref: ref && { providerId: ref.providerId, modelId: ref.modelId }, provider, modelId, available };
}

// The header's model, matched without regard to case against every model ZCode serves this
// sign-in (ZCode's own ids are case-sensitive: `glm-5.3-flash` as given is `model_not_found`).
// An unknown model passes through and ZCode fails the turn with its own error. `default` is
// ZCode's selection.
function resolveZcodeSelection(request, settings) {
  const current = settings?.current;
  let ref;
  if (request.model == null) {
    ref = current?.providerId && current?.modelId ? { providerId: current.providerId, modelId: current.modelId } : null;
    if (!ref) throw new Error("ZCode has no default model for this sign-in; name one with model:.");
  } else {
    const match = matchZcodeModel(request.model, settings);
    ref = match.ref ?? { providerId: match.provider ?? current?.providerId ?? match.available[0]?.providerId, modelId: match.modelId };
    if (!ref.providerId) throw new Error(`ZCode offers no provider for model ${request.model}.`);
  }
  return { providerId: ref.providerId, modelId: ref.modelId, options: { reasoningLevel: request.effort ?? ZCODE_DEFAULT_EFFORT } };
}

function turnResult(end, fallbackTurnId) {
  if (!end) return { turnId: fallbackTurnId, turnStatus: "failed", finalMessage: "", error: { message: "ZCode ended the turn without a result." } };
  const finalMessage = String(end.payload.response ?? "");
  if (end.type === "turn.failed") {
    const error = end.payload.error ?? {};
    const message = [error.message, error.underlyingErrorMessage && error.underlyingErrorMessage !== error.message ? error.underlyingErrorMessage : null, error.code ? `code ${error.code}` : null].filter(Boolean).join("\n");
    return { turnId: end.turnId, turnStatus: "failed", finalMessage: "", error: { message: message || `ZCode failed the turn in phase ${end.payload.turnPhase ?? "unknown"}.`, data: { code: error.code, type: error.type, retryable: error.retryable } } };
  }
  const result = end.payload.resultType;
  if (result === "success") return { turnId: end.turnId, turnStatus: "completed", finalMessage };
  if (result === "cancelled") return { turnId: end.turnId, turnStatus: "interrupted", finalMessage };
  return { turnId: end.turnId, turnStatus: "failed", finalMessage, error: { message: `the turn ended with result ${result ?? "unknown"}` } };
}

/** @implements {Connection} */
class ZcodeConnection {
  /** @param {import("../types").LaunchRequest} request */
  constructor(client, request) {
    this.client = client;
    this.request = request;
    this.session = null;
    this.deliveredIds = new Set();
  }

  get server() { return this.client; }
  async close() { await this.client.close(); }

  /** @param {import("../types").OpenOptions} options */
  async open({ sessionId, sessionUsed = false }) {
    const client = this.client;
    const request = this.request;
    /** @type {{
     *   request: typeof request,
     *   sessionId: string | null,
     *   running: Map<string, string>,
     *   outstanding: Set<string>,
     *   sent: Set<string>,
     *   ended: Array<{ turnId: string, inputId: string, type: string, payload: object }>,
     *   steering: number,
     *   pending: boolean,
     *   cancelRequested: boolean,
     *   closed: string | null,
     *   selection: ReturnType<typeof resolveZcodeSelection> | null,
     *   changed: (() => void) | null,
     *   closedPromise?: Promise<never>,
     *   rejectClosed?: (reason: Error) => void
     * }} */
    const z = this.session = {
      request, sessionId: sessionId ?? null, running: new Map(), outstanding: new Set(), sent: new Set(), ended: [],
      steering: 0, pending: false, cancelRequested: false, closed: null, selection: null, changed: null
    };
    z.closedPromise = new Promise((_resolve, reject) => { z.rejectClosed = reject; });
    z.closedPromise.catch(() => {});
    client.setNotificationHandler(notification => trackSession(this, notification));
    const delivered = new Set();
    const notes = [];
    let resumed = null;
    try {
      if (sessionId) {
        try {
          // A resumed session's tool surface comes from these lists, not from its first creation.
          resumed = await call(this, "session/resume", {
            sessionId, workspace: { workspacePath: request.cwd, workspaceKey: request.cwd }, toolDenylist: zcodeToolDenylist(request),
            ...(request.mode === "yolo" ? {} : { toolAllowlist: zcodeReadOnlyTools(request) })
          });
        } catch (error) {
          // A new session stays in memory until its first message is admitted. One whose
          // process died first does not exist, and no message can have reached it. A session
          // that ran a turn and is gone took the job's context with it.
          if (error.data?.code !== SESSION_UNAVAILABLE || !/not found/i.test(error.message)) throw error;
          if (sessionUsed) throw new Error(`ZCode no longer has session ${sessionId}, where this job's earlier turns ran; their context is lost. Start a new job.`);
          client.tap({ method: "zcode/sessionReplaced", params: { previous: sessionId, reason: error.message } });
        }
        for (const message of resumed?.messages ?? []) {
          if (message.info?.role !== "user") continue;
          const metadata = message.info.metadata ?? {};
          const id = metadata.inputIntent?.sourceCommandId ?? metadata.conversationInputIntent?.sourceCommandId;
          if (id) delivered.add(baseId(id));
        }
        if (!resumed) z.sessionId = null;
      }
      if (!z.sessionId) {
        const ack = await command(this, null, "createSession", { workspaceId: request.cwd, config: { mode: zcodeSessionMode(request) } });
        if (ack.status !== "accepted" || !ack.result?.sessionId) throw new Error(refused(ack, "new session"));
        z.sessionId = ack.result.sessionId;
      }
      const subscribed = await call(this, "session/subscribe", { sessionId: z.sessionId, deliveryKind: DELIVERY_KIND, includeSnapshot: true });
      const model = subscribed.snapshot?.settings?.model;
      // The subscription's snapshot lists only the session's current model. A named model is
      // matched against every model the sign-in serves: `session/resume`'s snapshot lists them,
      // a resumed session's already, and a new session's when asked (an active session is not
      // resumed again). Without that list, the subscription's stands and ZCode judges the id.
      let settings = { current: model?.current, available: resumed?.settings?.model?.available ?? model?.available };
      if (request.model != null && !resumed && !matchZcodeModel(request.model, settings).ref) {
        // The read is bounded: an error or no answer sends the model as written, and the job's
        // events and state block say why.
        const { modelListMs } = zcodeTimings();
        let timer;
        let reason = null;
        try {
          const listing = await live(this, Promise.race([
            Promise.resolve().then(() => client.request("session/resume", { sessionId: z.sessionId })),
            new Promise(resolve => { timer = setTimeout(() => resolve(LIST_TIMEOUT), modelListMs); })
          ]));
          if (listing === LIST_TIMEOUT) reason = `no answer in ${Number((modelListMs / 1000).toFixed(1))} s`;
          else if (Array.isArray(listing?.settings?.model?.available)) settings = { ...settings, available: listing.settings.model.available };
          else reason = "the answer had no model list";
        } catch (error) {
          if (client.exitInfo || z.closed !== null) throw error;
          reason = error.data ? protocolMessage(error) : error.message;
        } finally {
          // A read that timed out is abandoned, not cancelled: ZCode holds it until it answers
          // or exits.
          clearTimeout(timer);
        }
        if (reason !== null) {
          client.tap({ method: "zcode/modelListUnavailable", params: { sessionId: z.sessionId, model: request.model, reason } });
          notes.push(`ZCode's model list was not read (${String(reason).replace(/\s+/g, " ").trim()}); model ${request.model} was sent as written.`);
        }
      }
      z.selection = resolveZcodeSelection(request, settings);
    } catch (error) { throw new Error(error.data ? protocolMessage(error) : error.message); }
    this.deliveredIds = delivered;
    return { sessionId: z.sessionId, resumed: Boolean(resumed), notes };
  }

  delivered(item) { return Boolean(item.clientId && this.deliveredIds.has(item.clientId)); }
  controlsReady() { return Boolean(this.session?.pending); }

  // An accepted steer is `steered`. If the server ends before ZCode puts it into a turn, the
  // run hands it back in `unjoinedSteers` and the worker runs it as the next turn; if the run
  // ends otherwise without it, it is reported in `droppedSteers`.
  /** @param {import("../types").InboxMessage} message */
  async steer(turnId, message) {
    const client = this.client;
    const z = this.session;
    if (!z?.pending) throw new Error("no turn is running");
    const commandId = nextCommandId(z, message.id);
    z.outstanding.add(commandId);
    z.steering += 1;
    z.changed?.();
    try {
      const ack = await sendText(this, commandId, message.text, "guide");
      if (ack.status !== "accepted") throw new Error(refused(ack, "steer"));
      // Accepted while idle, ZCode starts it as its own turn, and this run waits for it.
      return { turnId };
    } catch (error) {
      z.outstanding.delete(commandId);
      throw error;
    } finally {
      z.steering -= 1;
      z.changed?.();
    }
  }

  async interrupt(_turnId) {
    const client = this.client;
    const z = this.session;
    z.cancelRequested = true;
    const ack = await command(this, z.sessionId, "stop", {});
    if (!["accepted", "noop", "duplicate"].includes(ack.status)) throw new Error(refused(ack, "stop"));
    z.changed?.();
  }

  /** @param {import("../types").TurnInput} options */
  async run(options) {
    const client = this.client;
    const z = this.session;
    const sessionId = z.sessionId;
    const { unresolvedInputMs, duplicateStartMs } = zcodeTimings();
    const id = options.clientId;
    let commandId = nextCommandId(z, id);
    let turnId = null;
    const first = z.ended.length;
    const dropped = new Map();
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    let settleTimer = null;
    const ours = end => end.inputId === commandId;
    const settle = () => { clearTimeout(settleTimer); settleTimer = null; };
    const check = () => {
      if (!turnId) {
        const started = [...z.running].find(([, inputId]) => inputId === commandId)?.[0] ?? z.ended.slice(first).find(ours)?.turnId;
        if (started) { turnId = started; options.onTurnId(started); }
      }
      if (!z.pending || !z.ended.slice(first).some(ours) || z.running.size || z.steering) { settle(); return; }
      if (z.outstanding.size && !z.cancelRequested) {
        // ZCode took a steer that neither joined a turn nor started one: give it time. ZCode
        // may still hold it, so it is never sent again; only the steers that were waiting
        // when the time started are reported dropped.
        if (!settleTimer) {
          const waiting = [...z.outstanding];
          settleTimer = setTimeout(() => {
            settleTimer = null;
            const expired = waiting.filter(input => z.outstanding.delete(input));
            for (const input of expired) dropped.set(input, `ZCode accepted the steer but neither ran it nor added it to a turn within ${Math.round(unresolvedInputMs / 1000)} s; it was not sent again`);
            client.tap({ method: "zcode/inputsUnresolved", params: { sessionId, commandIds: expired } });
            check();
          }, unresolvedInputMs);
        }
        return;
      }
      // A cancel ends the run with every steer ZCode still holds.
      for (const input of z.outstanding) dropped.set(input, "the job was cancelled before ZCode took the steer");
      z.outstanding.clear();
      // Decided with no await before it: a steer arriving from now on becomes the next turn.
      z.pending = false;
      resolveDone();
    };
    // ZCode retries every model call itself, so the worker never retries a ZCode turn.
    const receipts = () => ({
      retryable: false,
      unjoinedSteers: [...new Set([...z.outstanding].filter(input => input !== commandId).map(baseId))],
      droppedSteers: [...dropped].map(([input, reason]) => ({ id: baseId(input), reason }))
    });
    z.cancelRequested = false;
    z.changed = check;
    try {
      for (let resend = 0; ; resend += 1) {
        // Each discarded or duplicate answer is immediate, and suffixes an earlier process used
        // are unknown here, so the bound is generous.
        z.outstanding.add(commandId);
        const ack = await sendText(this, commandId, options.prompt, "startNow");
        if (ack.status === "accepted") break;
        z.outstanding.delete(commandId);
        // The id reached ZCode before its process was replaced, but not the session. ZCode
        // answers `duplicate` while it may still start it, and a failure naming the restart
        // once it discarded it: send it again under a new id unless it starts.
        const discarded = ack.status === "failed" && ack.reasonCode === DISCARDED_ON_RESTART;
        if ((ack.status === "duplicate" || discarded) && resend < 20) {
          if (ack.status === "duplicate") {
            await live(this, new Promise(resolve => setTimeout(resolve, duplicateStartMs)));
            if ([...z.running.values(), ...z.ended.slice(first).map(end => end.inputId)].includes(commandId)) break;
          }
          commandId = nextCommandId(z, id);
          continue;
        }
        return { turnId: null, turnStatus: "failed", finalMessage: "", error: { message: refused(ack, "message") }, ...receipts() };
      }
      z.pending = true;
      options.onPending?.();
      check();
      await live(this, done);
      return { ...turnResult(z.ended.slice(first).at(-1), turnId), ...receipts() };
    } catch (error) {
      return { turnId, turnStatus: "failed", finalMessage: "", error: { message: error.data ? protocolMessage(error) : error.message }, ...receipts() };
    } finally {
      settle();
      z.outstanding.clear();
      z.pending = false;
      z.changed = null;
    }
  }
}

/**
 * @param {import("../types").LaunchRequest} request
 * @param {import("../types").ConnectHooks} hooks
 * @returns {Promise<Connection>}
 */
export async function connect(request, hooks) {
    const binary = resolveZcodeBinary(hooks.env);
    hooks.saveState({ binary });
    const client = new SpawnedServerClient(request.cwd, {
      onSpawn: hooks.onSpawn, onStderr: hooks.onStderr, onEnd: hooks.onEnd,
      notificationTap: hooks.tap, backendName: "zcode", binary, args: ["app-server"], env: zcodeEnvironment(hooks.env),
      initializeMethod: "runtime/capabilities", initializeParams: {},
      onServerRequest(message, transport) { answerServerRequest(request, message, transport); }
    });
    try { await client.initialize(); }
    catch (error) { await client.close(); throw new Error(client.exitInfo ? zcodeEndMessage(client.exitInfo) : protocolMessage(error)); }
    return new ZcodeConnection(client, request);
}
// Where `zcode app-server` finds its sign-in and default model, read without a model call and
// without opening the credentials file. The check is for a regular credentials file of more
// than two bytes; whether the sign-in works is known at the first turn.
export function zcodeSignIn(env = process.env) {
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || env.HOME || env.USERPROFILE || "";
  const credentials = path.join(base, ".zcode", "v2", "credentials.json");
  let credentialsPresent = false;
  try {
    const stat = fs.statSync(credentials);
    credentialsPresent = stat.isFile() && stat.size > 2;
  } catch {}
  const providerConfig = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || path.join(base, ".zcode", "v2", "provider_config.json");
  let defaultModel = null;
  try {
    const selection = JSON.parse(fs.readFileSync(providerConfig, "utf8"))?.config?.defaultModelSelection;
    if (selection?.providerId && selection?.modelId) defaultModel = `${selection.providerId}/${selection.modelId}`;
  } catch {}
  return { credentials, credentialsPresent, defaultModel };
}
