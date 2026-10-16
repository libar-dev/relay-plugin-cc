// The ACP messages Grok and Kimi use. Grok's queue and interjections, and Kimi's session record,
// stay in their connections.
export const ACP_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "relay-plugin", version: "1" }
};

export const ACP_CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);
const WORK_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

// A replay boundary closes the preceding user message; unrelated updates do not split it.
export function acpUpdate(notification) {
  const update = notification.params?.update;
  const kind = update?.sessionUpdate;
  return {
    userText: kind === "user_message_chunk" ? update.content?.text ?? "" : null,
    agentText: kind === "agent_message_chunk" ? update.content?.text ?? "" : null,
    startsTool: kind === "tool_call",
    finishesTool: kind === "tool_call_update" && ["completed", "failed"].includes(update.status),
    replayBoundary: ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(kind),
    didWork: WORK_UPDATES.has(kind)
  };
}

export function openSession(client, cwd, sessionId) {
  return client.request(sessionId ? "session/load" : "session/new", {
    ...(sessionId ? { sessionId } : {}), cwd, mcpServers: []
  });
}

export function setConfigOption(client, sessionId, configId, value) {
  return client.request("session/set_config_option", { sessionId, configId, value });
}

// A client that serves file writes and terminals itself declares them, and the agent sends them.
export function acpInitializeParams(clientCapabilities) {
  return { ...ACP_INITIALIZE_PARAMS, clientCapabilities };
}

export function promptSession(client, sessionId, text, prompt = [{ type: "text", text }]) {
  return client.request("session/prompt", { sessionId, prompt });
}

export function cancelSession(client, sessionId) { client.notify("session/cancel", { sessionId }); }
export function promptCancelled(reason) { return reason === "cancelled"; }

export function promptResult(reason) {
  return {
    turnStatus: reason === "end_turn" ? "completed" : promptCancelled(reason) ? "interrupted" : "failed",
    ...(reason === "end_turn" || promptCancelled(reason) ? {} : { error: { message: `the turn ended with stop reason ${reason}` } })
  };
}

export function answerPermission(mode, message, transport) {
  if (message.method !== "session/request_permission") return false;
  const kinds = mode === "yolo" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const selected = message.params?.options?.find(option => kinds.includes(option.kind));
  transport.sendMessage({ id: message.id, result: { outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } } });
  return true;
}
