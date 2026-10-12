/** @typedef {import("../types").Connection} Connection */
import { CodexAppServerClient } from "./client.mjs";
import { clientIdsInThread, openThread, runTurnOnThread } from "./turn.mjs";
import { approvalPolicyFor, sandboxFor, sandboxPolicyFor, threadConfigFor } from "./request.mjs";

// The Codex app-server's arguments for a request: the job MCP servers it turns off.
export function codexServerArgs(request) {
  const args = (request.mcpOff ?? []).flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
  return args.length ? { args: ["app-server", ...args] } : {};
}

/** @implements {Connection} */
class CodexConnection {
  /** @param {import("../types").LaunchRequest} request */
  constructor(client, request) {
    this.client = client;
    this.request = request;
    this.sessionId = null;
    this.deliveredIds = new Set();
    this.steerTracker = { turnSteerHandler: null };
  }

  get server() { return this.client; }

  /** @param {import("../types").OpenOptions} options */
  async open({ sessionId, sessionName, ephemeral }) {
    const request = this.request;
    const opened = await openThread(this.client, request.cwd, {
      threadId: sessionId, threadName: sessionName, ephemeral,
      model: request.model, serviceTier: request.fast ? "priority" : null,
      sandbox: sandboxFor(request), approvalPolicy: approvalPolicyFor(),
      config: threadConfigFor(request)
    });
    this.sessionId = opened.threadId;
    this.deliveredIds = clientIdsInThread(opened.response);
    return { sessionId: opened.threadId, resumed: opened.resumed, serviceTier: opened.response.serviceTier ?? null };
  }

  /** @param {Pick<import("../types").WorkItem, "clientId" | "recoveryCandidate">} item */
  delivered(item) { return this.deliveredIds.has(item.clientId); }

  /** @param {import("../types").TurnInput} turn */
  async run(turn) {
    const request = this.request;
    try {
      const result = await runTurnOnThread(this.client, this.sessionId, {
        ...turn, clientUserMessageId: turn.clientId, steerTracker: this.steerTracker,
        model: request.model, effort: request.effort, serviceTier: request.fast ? "priority" : null,
        sandboxPolicy: sandboxPolicyFor(request), approvalPolicy: approvalPolicyFor()
      });
      return { ...result, capacity: isCapacityError(result.error) };
    } catch (error) {
      return { turnStatus: "failed", error: { message: error.message }, finalMessage: "", capacity: isCapacityError(error) };
    }
  }

  controlsReady(turnId) { return Boolean(turnId); }

  /** @param {import("../types").InboxMessage} message */
  async steer(expectedTurnId, message) {
    const params = {
      threadId: this.sessionId, input: [{ type: "text", text: message.text, text_elements: [] }],
      clientUserMessageId: message.id, expectedTurnId
    };
    this.steerTracker.turnSteerHandler?.("requested", params);
    try {
      const response = await this.client.request("turn/steer", params);
      this.steerTracker.turnSteerHandler?.("settled", params, true);
      return response;
    } catch (error) {
      this.steerTracker.turnSteerHandler?.("settled", params, false);
      throw error;
    }
  }

  async interrupt(turnId) { await this.client.request("turn/interrupt", { threadId: this.sessionId, turnId }); }
  async close() { await this.client.close(); }
}

/**
 * @param {import("../types").LaunchRequest} request
 * @param {import("../types").ConnectHooks} hooks
 * @returns {Promise<import("../types").Connection>}
 */
export async function connect(request, hooks) {
  const client = await CodexAppServerClient.connect(request.cwd, {
    env: hooks.env, onSpawn: hooks.onSpawn, onStderr: hooks.onStderr, onEnd: hooks.onEnd,
    notificationTap: hooks.tap, ...codexServerArgs(request)
  });
  return new CodexConnection(client, request);
}

// Request limits retry; usage and quota limits do not. The protocol kind is authoritative
// even when the message has no recognizable limit text.
function isCapacityError(error) {
  if (!error) return false;
  if (["serverOverloaded", "rateLimitExceeded"].includes(error.codexErrorInfo)) return true;
  return /at capacity|capacity|overloaded|rate limit reached for requests/i.test(String(error.message ?? error));
}
