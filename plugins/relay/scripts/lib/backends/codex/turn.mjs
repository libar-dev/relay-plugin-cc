/**
 * @typedef {import("./protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./protocol").ThreadStartParams} ThreadStartParams
 * @typedef {Pick<ThreadStartParams, "model" | "serviceTier" | "sandbox" | "approvalPolicy" | "config" | "ephemeral" | "developerInstructions"> & { threadName?: string | null }} ThreadOpenOptions
 * @typedef {import("./protocol").Turn} Turn
 * @typedef {import("./protocol").UserInput} UserInput
 * @typedef {{
 *   threadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completionReadError: string | null,
 *   completionInference: { threadId: string, turnId: string, status: string, source: string, reason: string | null } | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   collaborationSeen: boolean,
 *   completionGeneration: number,
 *   pendingSteers: number,
 *   client: any,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   onTurnId: ((turnId: string) => void) | null,
 *   responseReceived: boolean,
 *   workSeen: boolean
 * }} TurnCaptureState
 */
import { serverEndMessage, CodexAppServerClient } from "./client.mjs";


const SERVICE_NAME = "claude_code_codex_plugin";

// A thread name is a label. Never let a missing reply to thread/name/set hold a job.
const THREAD_NAME_TIMEOUT_MS = 30 * 1000;


function withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}


export function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}


/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    ...(options.config ? { config: options.config } : {}),
    ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}


/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    ...(options.config ? { config: options.config } : {}),
    ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {})
  };
}


/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}


function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}


function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}


function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}


function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}


function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}


/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completionReadError: null,
    completionInference: null,
    completed: false,
    finalAnswerSeen: false,
    collaborationSeen: false,
    completionGeneration: 0,
    pendingSteers: 0,
    client: options.client,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    onTurnId: options.onTurnId ?? null,
    responseReceived: false,
    // Any item beyond the user's own message: a failed turn that did work is never resent.
    workSeen: false
  };
}


function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}


function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    state.completionInference = { threadId: state.threadId, turnId: state.turnId,
      status: state.finalTurn.status, source: options.source, reason: options.reason ?? null };
    state.client.tap({ method: "codex/turnCompletionInferred", params: { threadId: state.threadId, turnId: state.turnId, status: state.finalTurn.status, source: options.source, ...(options.reason ? { reason: options.reason } : {}) } });
  }

  state.resolveCompletion(state);
}


function invalidateInference(state) {
  clearCompletionTimer(state);
  state.completionGeneration += 1;
  state.finalAnswerSeen = false;
}


function canInferCompletion(state) {
  return !state.client.transportEnded && !state.completed && !state.finalTurn && state.finalAnswerSeen && state.collaborationSeen &&
    state.turnId && state.pendingCollaborations.size === 0 && state.activeSubagentTurns.size === 0 &&
    state.pendingSteers === 0;
}


function scheduleInferredCompletion(state) {
  if (!canInferCompletion(state)) return;
  clearCompletionTimer(state);
  const generation = state.completionGeneration;
  state.completionTimer = setTimeout(async () => {
    state.completionTimer = null;
    if (!canInferCompletion(state) || generation !== state.completionGeneration) return;
    let turn;
    let source = "thread/read";
    let reason = null;
    let readError = null;
    try {
      const configured = Number(process.env.RELAY_JOBS_THREAD_READ_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10000;
      let timer;
      let response;
      try {
        response = await Promise.race([
          state.client.request("thread/read", { threadId: state.threadId, includeTurns: true }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no reply in ${timeoutMs / 1000} s`)), timeoutMs);
            timer.unref?.();
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      turn = response.thread.turns.find((entry) => entry.id === state.turnId);
      if (!turn) {
        readError = "turn not found";
      } else if (turn.status === "inProgress") {
        reason = "inProgress";
        source = "inProgress";
        turn = null;
      } else if (!["completed", "failed", "interrupted"].includes(turn.status)) {
        readError = `unknown status ${turn.status}`;
      }
    } catch (error) {
      if (state.completed || generation !== state.completionGeneration) return;
      const unsupported = error?.rpcCode === -32601 || /\bunknown variant\s+[`'"]?thread\/read(?:[`'"]|(?=[\s,.;:]|$))/i.test(error?.message ?? "");
      if (unsupported) {
        reason = "method unsupported";
        source = "unsupported";
      } else {
        readError = String(error?.message ?? error).split(/\r?\n/, 1)[0].trim();
      }
    }
    // A notification or accepted steer can arrive while thread/read is in flight.
    if (!canInferCompletion(state) || generation !== state.completionGeneration || state.client.exitResolved) return;
    if (readError !== null) {
      state.completionReadError = `thread/read: ${readError}`;
      completeTurn(state, { id: state.turnId, status: "failed", items: [],
        error: { message: state.completionReadError, codexErrorInfo: null, additionalDetails: null } });
      return;
    }
    completeTurn(state, turn, { inferred: true, source, reason });
  }, 250);
  state.completionTimer.unref?.();
}


function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}


function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      state.collaborationSeen = true;
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      trackThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    return;
  }
}


function trackThread(state, threadId) {
  if (threadId) state.threadIds.add(threadId);
}


function applyTurnNotification(state, message) {
  if (extractThreadId(message) === state.threadId &&
      (message.method.startsWith("item/") || message.method === "turn/started")) {
    invalidateInference(state);
  }
  switch (message.method) {
    case "thread/started":
      trackThread(state, message.params.thread.id);
      break;
    case "thread/name/updated":
      trackThread(state, message.params.threadId);
      break;
    case "turn/started":
      trackThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) === state.threadId && !state.turnId) {
        // A start response without a turn id takes it from the notification.
        state.turnId = message.params.turn.id;
      }
      if ((message.params.threadId ?? null) === state.threadId) {
        state.onTurnId?.(message.params.turn.id);
      }
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      break;
    case "item/started":
      if (message.params.item?.type !== "userMessage") state.workSeen = true;
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      break;
    case "item/completed":
      if (message.params.item?.type !== "userMessage") state.workSeen = true;
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      break;
    case "error":
      state.error = message.params.error;
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}


export async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, { ...options, client });
  const steerTracker = options.steerTracker ?? { turnSteerHandler: null };
  const previousSteerHandler = steerTracker.turnSteerHandler;
  steerTracker.turnSteerHandler = (phase, params, accepted) => {
    previousSteerHandler?.(phase, params, accepted);
    if (params.threadId !== state.threadId || params.expectedTurnId !== state.turnId || state.completed) return;
    if (phase === "requested") {
      state.pendingSteers += 1;
      clearCompletionTimer(state);
      state.completionGeneration += 1;
    } else {
      state.pendingSteers = Math.max(0, state.pendingSteers - 1);
      if (accepted) invalidateInference(state);
      else scheduleInferredCompletion(state);
    }
  };
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    // Buffer only until the start response arrives. A response without a turn id must
    // not leave every later notification in the buffer.
    if (!state.turnId && !state.responseReceived) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
      // New main-thread activity also cancels an old candidate's inference, even
      // when its turn id differs. Completion authority still requires the exact id.
      if (extractThreadId(message) === state.threadId &&
          (message.method.startsWith("item/") || message.method === "turn/started")) invalidateInference(state);
      if (previousHandler) {
        previousHandler(message);
      }
      return;
    }

    applyTurnNotification(state, message);
  });

  // Transport end before completion fails the turn, whatever the exit code. A drained
  // collaborator turn with a final answer may infer completion when thread/read is
  // unsupported or reads inProgress. Transport end before that check settles still fails.
  void client.exitPromise.then(() => {
    if (state.completed) {
      return;
    }
    const message = client.exitError?.message ?? serverEndMessage(client.exitInfo);
    state.error = { message };
    completeTurn(state, { id: state.turnId ?? "unknown-turn", status: "failed", error: { message } });
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.responseReceived = true;
    state.turnId = response.turn?.id ?? state.turnId ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
      state.onTurnId?.(state.turnId);
    }
    const buffered = state.bufferedNotifications.splice(0);
    for (const message of buffered) {
      if (!belongsToTurn(state, message) && extractThreadId(message) === state.threadId &&
          (message.method.startsWith("item/") || message.method === "turn/started")) invalidateInference(state);
      if (message.method === "thread/started" || message.method === "thread/name/updated" || belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else if (previousHandler) {
        previousHandler(message);
      }
    }

    if (response.turn?.id === state.turnId && ["completed", "failed", "interrupted"].includes(response.turn?.status)) {
      completeTurn(state, response.turn);
    }
    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
    steerTracker.turnSteerHandler = previousSteerHandler;
  }
}


export async function withAppServer(cwd, fn, options = {}) {
  const client = await CodexAppServerClient.connect(cwd, options);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}


// A review's app-server: the notification tap, and the arguments (job MCP servers off) of its
// request. It runs in the default Codex home.
export function connectOptions(options) {
  return {
    notificationTap: options.notificationTap,
    ...(options.args ? { args: options.args } : {})
  };
}


export async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await withTimeout(
        client.request("thread/name/set", { threadId, name: options.threadName }),
        THREAD_NAME_TIMEOUT_MS,
        null
      );
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}


async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}


export function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}


// Start a persistent thread, or resume one by id, on a client the caller owns. Codex's own
// names: the backend contract's `sessionId` arrives here as `threadId`.
/** @param {ThreadOpenOptions & { threadId?: string | null }} [options] */
export async function openThread(client, cwd, options = {}) {
  if (options.threadId) {
    const response = await resumeThread(client, options.threadId, cwd, options);
    return { threadId: response.thread.id, resumed: true, response };
  }
  const response = await startThread(client, cwd, { ...options, ephemeral: options.ephemeral ?? false });
  return { threadId: response.thread.id, resumed: false, response };
}


// Run one turn on an open thread and wait for it to end. Ends as failed, never hangs,
// when the app-server exits first.
export async function runTurnOnThread(client, threadId, options = {}) {
  const prompt = String(options.prompt ?? "");
  if (!prompt.trim()) {
    throw new Error("A prompt is required for this Codex turn.");
  }
  const turnState = await captureTurn(
    client,
    threadId,
    () =>
      client.request("turn/start", {
        threadId,
        input: buildTurnInput(prompt),
        ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
        model: options.model ?? null,
        effort: options.effort ?? null,
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        ...(options.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        outputSchema: options.outputSchema ?? null
      }),
    { onTurnId: options.onTurnId, steerTracker: options.steerTracker }
  );

  return {
    status: buildResultStatus(turnState),
    turnStatus: turnState.finalTurn?.status ?? null,
    completionReadError: turnState.completionReadError,
    completionInference: turnState.completionInference,
    threadId,
    turnId: turnState.turnId,
    finalMessage: turnState.lastAgentMessage,
    reasoningSummary: turnState.reasoningSummary,
    turn: turnState.finalTurn,
    error: turnState.finalTurn?.error ?? turnState.error ?? null,
    stderr: cleanCodexStderr(client.stderr),
    didWork: turnState.workSeen || (turnState.finalTurn?.items ?? []).some((item) => item?.type && item.type !== "userMessage")
  };
}


// The client message ids a thread already holds, from a thread/resume response: a message
// whose id is here reached the thread before, and must not run again.
export function clientIdsInThread(response) {
  const ids = new Set();
  const turns = [...(response?.thread?.turns ?? []), ...(response?.turns ?? [])];
  for (const turn of turns) {
    for (const item of turn?.items ?? []) {
      if (item?.type === "userMessage" && item.clientId) {
        ids.add(item.clientId);
      }
    }
  }
  return ids;
}
