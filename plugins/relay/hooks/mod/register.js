// The relay's Claude Code module.
//
// agent.spawn checks a relay:job prompt's header before the agent starts. A bad header would
// otherwise start a relay whose `companion start` refuses it and hands the error back as the
// report; denied here, the Agent tool call or the Workflow's agent() fails at once with the
// parser's message. The check is `companion check-header`, the same parser start uses, and any
// doubt about its answer lets the spawn through, since start still checks. check-header leaves
// relative paths to start: the relay's directory is not known at the spawn.
//
// session.send wakes a relay's wait. A message sent to a relay:job agent waits in that relay's
// queue until the relay's `companion wait` returns, which can take the wait's whole bound. This
// hook sees the message leave the sender and runs `companion wake` for the recipient, so a running
// job's wait returns within a second and the relay guard delivers the message on its usual path.
//
// It also answers /relay:status, /relay:result, /relay:cancel and /relay:transfer itself: each runs
// the companion and shows what it printed, with no model turn. The markdown commands of those
// names only say the module did not load.

// A line that is `---`, trailing spaces or tabs allowed: the line parseHeaderPrompt (in
// scripts/lib/jobs/request.mjs) ends a header with. Its two patterns, `---` before a line break
// and `---` at the end, are this one, since `$` in multiline mode matches before \r and \n alike.
const DASHES_LINE = /^---[ \t]*$/m;

// Whether a spawn's prompt is checked: a new relay:job agent whose prompt the hook can see. A
// resumed agent's prompt is the resuming message, not a header. A Workflow agent's prompt with no
// `---` line may be a placeholder rather than the script's prompt: on a run that keeps its script
// out of SDK events, Claude Code puts one there, and its wording is not an interface. Such an
// agent is left to start, which refuses a prompt that truly has no header. An Agent tool call's
// prompt is always the one the relay gets, so it is checked with or without the dashes.
function isCheckedSpawn(e) {
  if (e?.subagentType !== "relay:job" || e.resume != null) {
    return false;
  }
  return e.workflow == null || DASHES_LINE.test(String(e.prompt ?? ""));
}

// The parser's message when `companion check-header` refuses the prompt, else null. Only an
// answer in check-header's own shape is a refusal: anything else (its usage error, a crash, a
// cut-off output, a run that failed or timed out) is no verdict.
async function headerRefusal($, e) {
  const init = { stdin: e.prompt, timeoutMs: 10000 };
  // The cwd goes along only when the spawn names one; check-header reads it only for a
  // `mode: write` request's git checks, and judges no relative path.
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
  const fence = fenceFor(verbatim, 3);
  const tail = at === -1 ? "" : lines[at] === "---" ? "---\n" + lines.slice(at + 1).join("\n") : lines.slice(at).join("\n");
  return commandLine(e) + "\n" + fence + "text\n" + verbatim + fence + "\n" + tail;
}

// A run of backticks longer than any in the text, and at least `least` long, to fence it in.
// A loop, not a spread: a large output can hold more backtick runs than a call takes arguments.
function fenceFor(text, least) {
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  return "`".repeat(Math.max(least, longest + 1));
}

// One POSIX shell word that the shell takes as written: nothing in single quotes runs. Markdown
// turns a carriage return into a line feed, so one is written as printf's `\r` outside the quotes.
function shellWord(text) {
  return "'" + text.replace(/'/g, "'\\''").replace(/\r/g, "'\"$(printf '\\r')\"'") + "'";
}

// How a person runs the same command by hand, named in every error text: the sentence that names
// it, then `after`. The typed text is one word, as the module passes it, so the companion splits it
// as it splits "$ARGUMENTS", and a quote, `$(…)` or backtick in it runs nothing. A line break would
// end an inline code span and let Markdown read the rest, decoding an entity such as `&#39;` into a
// quote; such a line goes in a fenced block, where nothing is read as Markdown and line breaks stay.
function rerunHint($, sub, args, purpose, after = "") {
  const typed = typeof args === "string" && /\S/.test(args) ? " " + shellWord(args) : "";
  const shell = "node " + shellWord($.plugin.root + "/scripts/companion.mjs") + " " + sub + typed;
  if (!/[\r\n]/.test(shell)) {
    const fence = fenceFor(shell, 1);
    return "Run " + fence + shell + fence + " in a shell " + purpose + "." + after;
  }
  const fence = fenceFor(shell, 3);
  return "Run this in a shell " + purpose + "." + after + "\n\n" + fence + "sh\n" + shell + "\n" + fence;
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
    // An empty value is unset, as the companion's envNumber reads it; an explicit 0 stands.
    const raw = await $.env.get("RELAY_JOBS_CANCEL_GRACE_MS");
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
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
  const rerun = (purpose, after) => rerunHint($, sub, e.args, purpose, after);
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
    return errorText(e, "Did not finish: " + message + ". " + rerun("to see its output", cancelNote));
  }
  const { exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated } = result;
  if (isStdoutTruncated || isStderrTruncated) {
    const streams = isStdoutTruncated && isStderrTruncated ? "stdout and stderr" : isStdoutTruncated ? "stdout" : "stderr";
    return errorText(e, "Printed more than 4 MiB on " + streams + ", more than Claude Code passes to a plugin, so none of it is shown. " + rerun("to read it"));
  }
  if (typeof exitCode !== "number" || Number.isNaN(exitCode)) {
    return errorText(e, "Ended without an exit code. " + rerun("to see its output"));
  }
  if (stdout === "" && stderr === "") {
    return errorText(e, "Printed nothing (exit " + exitCode + "). " + rerun("to see its output"));
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
  return errorText(e, "The relay module failed while answering it: " + why + ". " + rerunHint($, sub, e.args, "to see its output"));
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
