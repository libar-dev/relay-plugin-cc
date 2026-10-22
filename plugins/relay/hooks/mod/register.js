// The relay's Claude Code module. A message sent to a relay:job agent waits in that relay's queue
// until the relay's `companion wait` returns, which can take the wait's whole bound. This hook sees
// the message leave the sender and runs `companion wake` for the recipient, so a running job's wait
// returns within a second and the relay guard delivers the message on its usual path.
//
// It also answers /relay:status, /relay:result, /relay:cancel and /relay:transfer itself: each runs
// the companion and shows what it printed, with no model turn. The markdown commands of those
// names only say the module did not load.

// The command as typed, on one line. It is the text's first line, where Claude Code puts "relay: ",
// so the person reads which job the command reached: Claude Code shows and records a command a
// plugin answered without its arguments.
function commandLine(e) {
  const args = typeof e.args === "string" && /\S/.test(e.args) ? " " + e.args : "";
  return ("/" + e.command + args).replace(/\s+/g, " ").trim();
}

// The companion's lines go in a code block, so every surface shows them as printed (the terminal
// and T3 draw command output as Markdown). The tail after them is left as Markdown: a report after
// the first `---` line, as the backend wrote it, or the status table from its first `|` line, which
// the terminal draws as a box table and T3 as a table.
function companionText(e, { stdout, stderr }) {
  const lines = stdout.split("\n");
  const at = lines.findIndex((line) => line === "---" || line.startsWith("|"));
  const head = at === -1 ? lines : lines.slice(0, at);
  // The blank line before the status table, and the empty piece after a final line break.
  while (head.length > 0 && head.at(-1).trim() === "") {
    head.pop();
  }
  let verbatim = head.map((line) => line + "\n").join("") + stderr;
  if (!verbatim.endsWith("\n")) {
    verbatim += "\n";
  }
  const longest = Math.max(0, ...(verbatim.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const tail = at === -1 ? "" : lines[at] === "---" ? "---\n" + lines.slice(at + 1).join("\n") : lines.slice(at).join("\n");
  return commandLine(e) + "\n" + fence + "text\n" + verbatim + fence + "\n" + tail;
}

// How a person runs the same command by hand, named in every error text.
function companionShell($, sub, args) {
  const typed = typeof args === "string" && /\S/.test(args) ? " " + args : "";
  return "`node \"" + $.plugin.root + "/scripts/companion.mjs\" " + sub + typed + "`";
}

// An error text: the command line, then a paragraph of the module's own words.
function errorText(e, paragraph) {
  return { text: commandLine(e) + "\n\n" + paragraph, exitCode: 1 };
}

// The companion's cancel waits up to the grace for the worker, and a delegated cancel waits it
// again; the rest is the process sweep and the busy-view retries. The grace is read as the
// companion's envNumber reads it, from the environment the companion inherits.
async function cancelTimeoutMs($) {
  let grace = 10000;
  try {
    const value = Number(await $.env.get("RELAY_JOBS_CANCEL_GRACE_MS"));
    if (Number.isFinite(value) && value >= 0) {
      grace = value;
    }
  } catch {
    // An unread variable leaves the companion's default.
  }
  return Math.min(600000, 2 * grace + 40000);
}

// The time now, or null when it cannot be read.
async function now($) {
  try {
    return await $.clock.now();
  } catch {
    return null;
  }
}

// The whole answer of one command. It never calls `next`, so the markdown body never runs while
// the module is loaded, and it answers its own failures, so a failed run never reads as an empty
// listing.
async function answerCommand($, e, sub, timeoutMs, withSessionId = false) {
  const argv = ["node", $.plugin.root + "/scripts/companion.mjs", sub];
  if (e.args.trim() !== "") {
    // One element, as typed: the companion splits it as it split the markdown command's "$ARGUMENTS".
    argv.push(e.args);
  }
  const shell = companionShell($, sub, e.args);
  let timedOut = false;
  let result;
  try {
    const init = { cwd: await $.session.cwd(), timeoutMs };
    if (withSessionId) {
      // Transfer finds the session's transcript by its id.
      init.env = { RELAY_COMPANION_SESSION_ID: await $.session.id() };
    }
    // `$.process.run` rejects alike when the child cannot start and when it is still running at
    // its timeout; only the time tells them apart. A cancel cut off by its timeout may still have
    // reached the job, one that never started did not.
    const startedAt = sub === "cancel" ? await now($) : null;
    try {
      result = await $.process.run(argv, init);
    } catch (error) {
      const endedAt = startedAt === null ? null : await now($);
      timedOut = endedAt !== null && endedAt - startedAt >= timeoutMs;
      throw error;
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    const cancelNote = timedOut ? " The cancel may have gone through anyway; /relay:status shows the job's state." : "";
    return errorText(e, "Did not finish: " + message + ". Run " + shell + " in a shell to see its output." + cancelNote);
  }
  const { exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated } = result;
  if (isStdoutTruncated || isStderrTruncated) {
    const streams = isStdoutTruncated && isStderrTruncated ? "stdout and stderr" : isStdoutTruncated ? "stdout" : "stderr";
    return errorText(e, "Printed more than 4 MiB on " + streams + ", more than Claude Code passes to a plugin, so none of it is shown. Run " + shell + " in a shell to read it.");
  }
  if (typeof exitCode !== "number" || Number.isNaN(exitCode)) {
    return errorText(e, "Ended without an exit code. Run " + shell + " in a shell to see its output.");
  }
  if (stdout === "" && stderr === "") {
    return errorText(e, "Printed nothing (exit " + exitCode + "). Run " + shell + " in a shell to see its output.");
  }
  const answer = { text: companionText(e, result) };
  // A headless `claude -p "/relay:result <job>"` then exits as the companion did; the engine
  // fails a hook whose exitCode is anything but a whole number from 0 to 255.
  if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
    answer.exitCode = exitCode;
  }
  return answer;
}

// A hook that threw or ran past its budget would otherwise be skipped, and the markdown body
// would run in its place. The handler has a one-second grace, so it makes no call on `$`.
function moduleFailed($, e, next, sub) {
  const why = next.error.kind === "timeout" ? "it ran past its time budget" : next.error.message ?? "it failed";
  return errorText(e, "The relay module failed while answering it: " + why + ". Run " + companionShell($, sub, e.args) + " in a shell to see its output.");
}

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

  on("command.run", { command: "relay:status" }, ($, e) => answerCommand($, e, "status", 30000))
    .catch(($, e, next) => moduleFailed($, e, next, "status"));
  on("command.run", { command: "relay:result" }, ($, e) => answerCommand($, e, "result", 30000))
    .catch(($, e, next) => moduleFailed($, e, next, "result"));
  // Cancel's timeout follows the grace it waits for the worker (cancelTimeoutMs), transfer's sits
  // above the two minutes it allows Codex's import.
  on("command.run", { command: "relay:cancel" }, async ($, e) => answerCommand($, e, "cancel", await cancelTimeoutMs($)))
    .catch(($, e, next) => moduleFailed($, e, next, "cancel"));
  on("command.run", { command: "relay:transfer" }, ($, e) => answerCommand($, e, "transfer", 180000, true))
    .catch(($, e, next) => moduleFailed($, e, next, "transfer"));
}
