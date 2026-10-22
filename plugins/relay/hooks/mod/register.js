// The relay's Claude Code module, with two hooks.
//
// agent.spawn checks a relay:job prompt's header before the agent starts. A bad header would
// otherwise start a relay whose `companion start` refuses it and hands the error back as the
// report; denied here, the Agent tool call or the Workflow's agent() fails at once with the
// parser's message. The check is `companion check-header`, the same parser start uses, and any
// doubt about its answer lets the spawn through, since start still checks.
//
// session.send wakes a relay's wait. A message sent to a relay:job agent waits in that relay's
// queue until the relay's `companion wait` returns, which can take the wait's whole bound. This
// hook sees the message leave the sender and runs `companion wake` for the recipient, so a running
// job's wait returns within a second and the relay guard delivers the message on its usual path.

// What a Workflow agent's prompt reads on a run that keeps its script out of SDK events; the
// script's real prompt is not seen here, so there is nothing to check.
const WITHHELD_PROMPT = "(withheld: this workflow run does not share its script)";

// Whether a spawn's prompt is checked: a new relay:job agent whose prompt the hook can see. A
// resumed agent's prompt is the resuming message, not a header.
function isCheckedSpawn(e) {
  return e?.subagentType === "relay:job" && e.resume == null && e.prompt !== WITHHELD_PROMPT;
}

// The parser's message when `companion check-header` refuses the prompt, else null. Only an
// answer in check-header's own shape is a refusal: anything else (its usage error, a crash, a
// cut-off output, a run that failed or timed out) is no verdict.
async function headerRefusal($, e) {
  const init = { stdin: e.prompt, timeoutMs: 10000 };
  if (typeof e.cwd === "string" && e.cwd !== "") {
    init.cwd = e.cwd;
  }
  const ran = await $.process.run(["node", $.plugin.root + "/scripts/companion.mjs", "check-header"], init);
  if (ran?.exitCode !== 1 || ran.isStdoutTruncated !== false || typeof ran.stdout !== "string") {
    return null;
  }
  if (!ran.stdout.startsWith("error: ")) {
    return null;
  }
  const message = ran.stdout.slice("error: ".length).trim();
  return message === "" ? null : message;
}

export function register(on) {
  on("agent.spawn", async ($, e, next) => {
    if (!isCheckedSpawn(e)) {
      return next(e);
    }
    let refusal = null;
    try {
      refusal = await headerRefusal($, e);
    } catch {
      // A check that could not run says nothing about the header; the relay's start checks it.
      refusal = null;
    }
    if (refusal !== null) {
      // Claude Code puts its own "spawn denied by a plugin" before the reason.
      return { deny: refusal };
    }
    return next(e);
  });

  on("session.send", async ($, e, next) => {
    const result = await next(e);
    // Only a queued message is worth a wake: a refused one never reaches the relay.
    if (result?.isDelivered !== true) {
      return result;
    }
    try {
      // SendMessage addresses an agent by id or by name. A Workflow's agents are not in the list
      // and are addressed by id, so an unknown `to` is passed on as it is; `wake` writes nothing
      // for an id that is no job's current relay. Two agents may hold one name (a finished relay
      // stays listed for a while beside a new one), so every match is woken. A listed agent of
      // another type has no job, and the sender is spared a process start for it.
      const agents = await $.agent.list();
      const matches = agents.filter((a) => a.id === e.to || a.name === e.to);
      const ids = matches.length > 0 ? matches.filter((a) => a.type === "relay:job").map((a) => a.id) : [e.to];
      for (const id of ids) {
        await $.process.run(["node", $.plugin.root + "/scripts/companion.mjs", "wake", "--agent", id], { timeoutMs: 10000 });
      }
    } catch {
      // The message is already queued. Without a wake the relay still reads it when its wait
      // reaches its bound, so a failed wake only costs time and must not touch the send's result.
    }
    return result;
  });
}
