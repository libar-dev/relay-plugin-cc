import { getCodexAvailability } from "./account.mjs";
import { codexServerArgs } from "./connection.mjs";
import { toolOutputTokenLimitFor } from "./request.mjs";
import { withAppServer, startThread, captureTurn, buildResultStatus, cleanCodexStderr, connectOptions } from "./turn.mjs";


async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/relay:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const budget = await toolOutputTokenLimitFor(client, options.request);
    const thread = await startThread(client, cwd, {
      model: options.model,
      config: budget.limit == null ? undefined : { tool_output_token_limit: budget.limit },
      sandbox: "read-only",
      ephemeral: true
    });
    const sourceThreadId = thread.thread.id;

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery: "inline",
          target: options.target
        }),
      {
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  }, connectOptions(options));
}

function ensureAvailable(cwd) {
  if (!getCodexAvailability(cwd).available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/relay:setup`.");
  }
}

/** @type {import("../types").ReviewSupport} */
export const reviewSupport = {
  schema: "turn",
  inlineDiff: false,
  nativeEffortNote(effort) { return `effort ${effort} is ignored: Codex's native review takes no effort.`; },
  async native(request, target, hooks) {
    ensureAvailable(request.cwd);
    const result = await runAppServerReview(request.cwd, {
      target: target.mode === "working-tree" ? { type: "uncommittedChanges" } : { type: "baseBranch", branch: target.baseRef },
      model: request.model, request,
      notificationTap: hooks.tap, ...codexServerArgs(request)
    });
    return {
      status: result.status, sessionId: result.threadId, sourceSessionId: result.sourceThreadId,
      reviewText: result.reviewText, reasoningSummary: result.reasoningSummary, error: result.error, stderr: result.stderr,
      details: { sourceThreadId: result.sourceThreadId }
    };
  },
  prepare(request) { ensureAvailable(request.cwd); }
};
