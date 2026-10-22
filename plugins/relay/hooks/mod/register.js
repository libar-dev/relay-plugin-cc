// The relay's Claude Code module. A message sent to a relay:job agent waits in that relay's queue
// until the relay's `companion wait` returns, which can take the wait's whole bound. This hook sees
// the message leave the sender and runs `companion wake` for the recipient, so a running job's wait
// returns within a second and the relay guard delivers the message on its usual path.

export function register(on) {
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
