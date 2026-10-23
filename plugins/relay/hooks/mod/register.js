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
// turn.complete tells the person which job a stop left running. A stop from Claude Code's own
// controls (x in the agent list and Esc in a relay's view, measured; the desktop app's Stop and
// ctrl+x ctrl+k, not checked live yet) ends the relay's turn as aborted and leaves its job running
// (D96), and no other event shows it.
// A timer the hook sets finds the relay's job through the companion and names it, with
// /relay:cancel and /relay:result, in the transcript and a toast. It runs after the hook has
// returned, because the engine awaits the hook before it ends the turn, and where nothing draws
// it does nothing. A TaskStop ends the relay the same way, but its PostToolUse hook
// (relay-stop.mjs) cancels the job, so a tool.call hook on TaskStop marks the agents the call
// names, before the stop, narrows the marks to the agent stopped once the call answers, and the
// notice passes a marked agent by. The marks are kept in `$.state`, so a reload between the call
// and the relay's end keeps them.
//
// It also answers /relay:status, /relay:result, /relay:cancel and /relay:transfer itself: each runs
// the companion and shows what it printed, with no model turn. The markdown commands of those
// names only say the module did not load.
//
// The status line counts the repository's jobs that are running, dead or owed messages, from
// `companion status --json --active`, read every five seconds while a surface draws the session.
// While the line is cleared it reads every thirty seconds, and every five for thirty after a relay event
// the module sees. Under an Agent SDK host (T3) nothing draws, so status polling starts no process
// there. The timer starts at session.start, which fires again in the fresh copy after a reload
// ends the old copy's timers.
//
// /relay-board opens the board, a pane of the repository's jobs, where a job is steered, continued
// or cancelled. It draws only from `$.state`, which a three-second read of `companion status
// --json` fills while the pane is shown, placed and drawn by a surface, and the selected job's
// `result --json`. The timer starts when the board opens (where nothing draws, when a surface
// attaches) and stops when its pane closes. A press runs its process from the handler, never from
// a drawing, and a send reads the job first and routes on that.

import { atom, read, update } from "claude-code";

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

// A companion's wait in milliseconds, read as the companion's envNumber reads it, from the
// environment the companion inherits. `get` reads the variable: the engine lists what a module
// reads only from a literal name.
async function envMs(get, fallback) {
  try {
    // An empty value is unset, as the companion's envNumber reads it; an explicit 0 stands.
    const raw = await get();
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  } catch {
    // An unread variable leaves the companion's default.
  }
  return fallback;
}

// The companion's cancel waits up to the grace for the worker, and a delegated cancel waits it
// again; the rest is the process sweep and the busy-view retries.
async function cancelTimeoutMs($) {
  return Math.min(600000, 2 * (await envMs(() => $.env.get("RELAY_JOBS_CANCEL_GRACE_MS"), 10000)) + 40000);
}

// A steer or a continue waits up to the acknowledgement wait for the worker to take it.
async function sendTimeoutMs($) {
  return Math.min(600000, (await envMs(() => $.env.get("RELAY_JOBS_ACK_TIMEOUT_MS"), 60000)) + 15000);
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

// Ends the wait of the relay with this agent id, so it delivers a message queued for it now.
async function wake($, id) {
  await $.process.run(["node", $.plugin.root + "/scripts/companion.mjs", "wake", "--agent", id], { timeoutMs: 10000 });
}

// A hook that threw or ran past its budget would otherwise be skipped, and the markdown body
// would run in its place. The handler has a one-second grace, so it makes no call on `$`.
function moduleFailed($, e, next, sub) {
  const why = next.error.kind === "timeout" ? "it ran past its time budget" : next.error.message ?? "it failed";
  return errorText(e, "The relay module failed while answering it: " + why + ". " + rerunHint($, sub, e.args, "to see its output"));
}

// Claude Code draws a plugin's status line after the plugin's name ("relay: "), so the text leaves it out.
const UNAVAILABLE = "status unavailable";

// The status line's text for one run of the listing: the line, undefined to clear it, or null to
// keep it as it is, since a busy listing only means a job's record was changing.
function statusText(ran) {
  if (ran?.isStdoutTruncated !== false || typeof ran.stdout !== "string") {
    return UNAVAILABLE;
  }
  let answer;
  try {
    answer = JSON.parse(ran.stdout);
  } catch {
    return UNAVAILABLE;
  }
  if (answer?.schema !== "relay.status/1") {
    return UNAVAILABLE;
  }
  if (answer.error?.kind === "busy" && ran.exitCode === 4) {
    return null;
  }
  if (ran.exitCode !== 0 || answer.error != null || !Array.isArray(answer.jobs)) {
    return UNAVAILABLE;
  }
  let running = 0;
  let dead = 0;
  let owed = 0;
  for (const job of answer.jobs) {
    if (job?.state === "starting" || job?.state === "running") {
      running++;
    } else if (job?.state === "dead") {
      dead++;
    }
    // The count, not the list: a row's list of owed messages is cut to a few.
    owed += Number.isInteger(job?.undeliveredCount) ? job.undeliveredCount : 0;
  }
  // More pages exist, and the line does not page: every count is then a lower bound, and an older
  // running job may sit on a later page.
  const more = answer.nextCursor != null ? "+" : "";
  const parts = [];
  if (running > 0) {
    parts.push(running + more + " running");
  }
  if (dead > 0) {
    parts.push(dead + more + " dead");
  }
  if (owed > 0) {
    parts.push(owed + more + " owed");
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

// One read of the listing, as statusText reads it; a run that failed shows the line is unavailable.
async function statusLine($) {
  const argv = ["node", $.plugin.root + "/scripts/companion.mjs", "status", "--json", "--active", "--limit", "200"];
  let ran;
  try {
    ran = await $.process.run(argv, { cwd: await $.session.cwd(), timeoutMs: 10000 });
  } catch {
    return UNAVAILABLE;
  }
  return statusText(ran);
}

// While the line is cleared, the ticks between reads: thirty seconds at one tick in five.
const CLEARED_TICKS = 6;

// One tick: a read only while a surface draws the session and no read is in flight. While the
// last good answer cleared the line, a job can only appear through a start the module rarely
// sees, so a tick reads only every CLEARED_TICKS ticks, or at every tick for CLEARED_TICKS ticks
// after a relay event it did see (a relay's job exists only once its start has run) or a busy
// answer.
async function poll($, poller, tick) {
  if ((await $.session.surfaces()).length === 0 || poller.isReading) {
    return;
  }
  if (poller.isCleared && tick > poller.fastUntil && tick - poller.readTick < CLEARED_TICKS) {
    return;
  }
  poller.isReading = true;
  poller.readTick = tick;
  try {
    const text = await statusLine($);
    if (text !== null) {
      $.ui.status(text);
      poller.isCleared = text === undefined;
    } else if (poller.isCleared) {
      // Busy: a job's record is being written, often by a worker that has just started.
      poller.fastUntil = tick + CLEARED_TICKS;
    }
  } finally {
    poller.isReading = false;
  }
}

// A TaskStop's relay ends its turn well within a second of the call. A minute leaves room for a
// slow session, and a mark that its turn never used (a refused TaskStop) still lapses, so a later
// stop by a person of the same agent, resumed by a message, shows its notice.
const TASK_STOP_MS = 60000;
const NOTICE_MS = 20000;
// The listing's pages read for one notice: 2000 active or dead jobs, newest first.
const NOTICE_PAGES = 10;

// The marks TaskStops left: each agent id, or text the call named, with its mark's end (null when
// the clock could not be read).
const stopMarks = atom({ plugin: "relay", key: "stopMarks" }, {});
// The marks a write keeps. The value lives in the session's state across reloads, and marks a
// stop never uses (a shell's, an agent stopped before it began a turn) would otherwise pile up.
const MOST_MARKS = 50;

// Marks the agents a TaskStop names until TASK_STOP_MS after it, and resolves what it wrote. The
// model passes an agent's id or its name, and two agents may hold one name, so every agent that
// matches is marked by its id; a name mark would also pass by a later agent of that name. The text
// itself is marked only when the list cannot be read here or names no such agent. relay-stop
// also reads the older `shell_id`. A clock that cannot be read marks with no end: no notice is the
// old behaviour.
async function markTaskStop($, e) {
  const named = [e.task_id, e.shell_id].find((one) => typeof one === "string" && one !== "");
  if (named === undefined) {
    return undefined;
  }
  const at = await now($);
  const until = at === null ? null : at + TASK_STOP_MS;
  let ids = [];
  try {
    ids = (await $.agent.list()).filter((agent) => agent.id === named || agent.name === named).map((agent) => agent.id);
  } catch {
    // The text alone is marked.
  }
  const keys = ids.length === 0 ? [named] : ids;
  await update($, stopMarks, (held) => keptMarks(held ?? {}, Object.fromEntries(keys.map((key) => [key, until])), at));
  return { keys, until };
}

// The marks held and the new ones, as a write keeps them. Once the clock reads, a mark with no
// end gets the usual minute from now, so it lapses too; lapsed marks are dropped, and only the
// MOST_MARKS newest are kept, the latest end first. A write stores the new marks first and the
// sort is stable, so among marks of one end the newer stay ahead and the cap drops an older one.
function keptMarks(held, marks, at) {
  const entries = [...Object.entries(marks), ...Object.entries(held).filter(([key]) => !Object.hasOwn(marks, key))]
    .map(([key, end]) => [key, at !== null && end === null ? at + TASK_STOP_MS : end])
    .filter(([, end]) => at === null || end === null || end >= at);
  entries.sort(([, one], [, other]) => (other ?? Infinity) - (one ?? Infinity));
  return Object.fromEntries(entries.slice(0, MOST_MARKS));
}

// The marks after the TaskStop's answer, or null when they stay as they are. Before the stop the
// call could not tell which agent it would stop, so its marks may name more: a refused call
// stops nothing and keeps none, and a stop names its agent in the record's `task_id`, which keeps
// one mark under that id. Only the call's marks still held with its end are touched: one used up
// means the notice check ran, and one with another end was written again by a later call. A new
// id mark is written only while one of them is held, and never in place of the agent's own mark
// already used up, since it would pass by a later stop of that agent by a person.
function narrowedMarks(held, wrote, answer) {
  const live = wrote.keys.filter((key) => Object.hasOwn(held, key) && held[key] === wrote.until);
  if (live.length === 0) {
    return null;
  }
  const isRefused = typeof answer?.deny === "string" || answer?.isError === true;
  const id = answer?.result?.task_id;
  if (!isRefused && (typeof id !== "string" || id === "")) {
    return null;
  }
  const rest = Object.entries(held).filter(([key]) => !live.includes(key));
  if (isRefused || (wrote.keys.includes(id) && !live.includes(id))) {
    return Object.fromEntries(rest);
  }
  if (live.length === 1 && live[0] === id) {
    return null;
  }
  // The id may hold a later call's mark, whose end is kept when it is later.
  const other = Object.hasOwn(held, id) && !live.includes(id) ? held[id] : undefined;
  const end = other !== undefined && (other === null || (wrote.until !== null && other > wrote.until)) ? other : wrote.until;
  return Object.fromEntries([[id, end], ...rest.filter(([key]) => key !== id)]);
}

// Narrows the call's marks to the agent it stopped, once its answer is in.
async function narrowTaskStop($, wrote, answer) {
  if (narrowedMarks((await read($, stopMarks)) ?? {}, wrote, answer) === null) {
    return;
  }
  await update($, stopMarks, (held) => narrowedMarks(held ?? {}, wrote, answer) ?? held ?? {});
}

// Whether a TaskStop marked the agent within its mark's time, and only that mark is used up, so a
// later stop of the agent by a person shows its notice. Its id mark is the agent's own; a name
// mark, made when the TaskStop could not tell the agents apart, counts only when the agent has
// no id mark, so a TaskStop that named another agent of the name by its id keeps that mark.
async function isMarked($, agent) {
  const held = (await read($, stopMarks)) ?? {};
  const at = await now($);
  const isLive = (key) => typeof key === "string" && key !== "" && Object.hasOwn(held, key) && (at === null || held[key] === null || at <= held[key]);
  const key = [agent.id, agent.name].find(isLive);
  if (key === undefined) {
    return false;
  }
  await update($, stopMarks, (marks) => Object.fromEntries(Object.entries(marks ?? {}).filter(([one]) => one !== key)));
  return true;
}

// The job whose current relay is the agent and that is still at work, or undefined. The listing
// is newest first, so an old job behind newer ones is on a later page.
async function liveJobOf($, agentId) {
  let cursor = null;
  for (let page = 0; page < NOTICE_PAGES; page++) {
    // --all: a job's `cd:` can put it in another repository; 200, the most a page holds.
    const args = ["status", "--all", "--active", "--limit", "200", "--json"];
    if (cursor !== null) {
      args.push("--cursor", cursor);
    }
    const ran = await companionJson($, args, 10000);
    if (failureOf(ran) !== null || !Array.isArray(ran.answer.jobs)) {
      return undefined;
    }
    // Only a job that is still at work runs on; a dead one waits for its relay or a resume.
    const job = ran.answer.jobs.find((one) => one?.relay?.agentId === agentId && ["starting", "running"].includes(one.state));
    if (job !== undefined) {
      return job;
    }
    cursor = typeof ran.answer.nextCursor === "string" && ran.answer.nextCursor !== "" ? ran.answer.nextCursor : null;
    if (cursor === null) {
      return undefined;
    }
  }
  return undefined;
}

// After a relay's aborted turn: the notice when a surface draws it, a person stopped the relay,
// its job has not ended, and the job is found. A Workflow's agents are never listed, so they get
// none; their stop is the Workflow's own.
async function stopNotice($, e, poller) {
  if ((await $.session.surfaces()).length === 0) {
    return;
  }
  const agent = (await $.agent.list()).find((one) => one.id === e.agentId);
  if (agent?.type !== "relay:job" || agent.status !== "killed") {
    return;
  }
  poller.fastUntil = poller.ticks + CLEARED_TICKS;
  if (await isMarked($, agent)) {
    // The live check reads this line to tell a mark that worked from a cancel that came first.
    $.ui.log("stop notice skipped for " + agent.id + ": TaskStop named it", { to: "debug" });
    return;
  }
  const job = await liveJobOf($, agent.id);
  if (job === undefined) {
    return;
  }
  const text = (agent.name || agent.id) + " was stopped, and its job " + job.id + " keeps running. /relay:cancel " + job.id + " cancels it, /relay:result " + job.id + " shows it.";
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: NOTICE_MS });
}

const BOARD_PANE = "relay-board";
const BOARD_COMMAND = { name: "relay-board", description: "Show this repository's relay jobs in a pane, to steer, continue or cancel them", immediate: true };
const PAGE = 20;
// The most rows one listing holds; past them the board moves its window by the cursor.
const MOST_ROWS = 200;
// A relay quiet for longer may be gone: a waiting relay calls about every nine minutes, and the
// gap can pass ten.
const RELAY_QUIET_MS = 15 * 60 * 1000;
// A view that failed is read again no sooner than this, unless its row is pressed.
const RETRY_MS = 10000;
const TICK_MS = 3000;
// A live job's view is read again at least this often: a message created and taken between two
// reads leaves every fact of its row as it was (openMessages goes from 0 to 0).
const LIVE_VIEW_MS = 30000;
const ENDED = ["completed", "failed", "cancelled"];
const LIVE_AGENT = ["pending", "running", "waiting"];

const boardList = atom({ plugin: "relay", key: "boardList" }, null);
const boardWindow = atom({ plugin: "relay", key: "boardWindow" }, { limit: PAGE, cursor: null });
const boardSelected = atom({ plugin: "relay", key: "boardSelected" }, null);
const boardDetail = atom({ plugin: "relay", key: "boardDetail" }, null);
const boardNote = atom({ plugin: "relay", key: "boardNote" }, null);
const boardConfirm = atom({ plugin: "relay", key: "boardConfirm" }, null);

const NO_SURFACE = "The relay board draws in the terminal and the desktop app, and nothing draws here. /relay:status lists this repository's jobs.";

// One companion run that prints a `relay.<sub>/1` object: `{ answer, exitCode }`, or `{ failure }`
// when it printed nothing the board can read, with `isUnfinished` when it did not finish.
async function companionJson($, args, timeoutMs) {
  let ran;
  try {
    const argv = ["node", $.plugin.root + "/scripts/companion.mjs", ...args];
    ran = await $.process.run(argv, { cwd: await $.session.cwd(), timeoutMs });
  } catch (error) {
    return { failure: error?.message ?? String(error), isUnfinished: true };
  }
  try {
    if (ran.isStdoutTruncated) {
      return { failure: "it printed more than Claude Code passes to a plugin" };
    }
    const answer = JSON.parse(ran.stdout);
    if (answer?.schema !== "relay." + args[0] + "/1") {
      return { failure: "it did not answer relay." + args[0] + "/1" };
    }
    return { answer, exitCode: ran.exitCode };
  } catch (error) {
    return { failure: error?.message ?? String(error) };
  }
}

// A busy answer only means a job's record was changing, so the board keeps what it last read.
function isBusy(ran) {
  return ran.answer?.error?.kind === "busy" && ran.exitCode === 4;
}

// What failed, or null for an answer to draw.
function failureOf(ran) {
  return ran.failure ?? ran.answer.error?.message ?? null;
}

// A run whose answer the board could not read: one that ended may still have acted.
function unread(ran) {
  return (ran.isUnfinished ? "did not finish (" : "finished, and its answer could not be read (") + ran.failure + ")";
}

function isLive(job) {
  return job.state === "starting" || job.state === "running";
}

// A starting job's first attempt counts as 1, as `cancel --attempt` counts it.
function attemptOf(job) {
  return Math.max(1, job.attempts);
}

function isRelayQuiet(job, at) {
  const last = Date.parse(job.relay?.lastToolAt ?? "");
  return at === null || Number.isNaN(last) || at - last > RELAY_QUIET_MS;
}

function sendKind(job) {
  return isLive(job) ? "steer" : "continue";
}

function sendLabel(job) {
  if (!isLive(job)) {
    return "Continue";
  }
  return job.backend === "kimi" && job.state === "running" ? "Queue next turn" : "Steer";
}

// A listing's row cut to what the board draws and what marks its view stale, so a read that
// changed none of them writes nothing: each write draws the whole pane again.
function boardRow(job, at) {
  const relay = job.relay == null ? null : {
    agentId: job.relay.agentId, workflowRunId: job.relay.workflowRunId, label: job.relay.label, lastToolAt: job.relay.lastToolAt,
  };
  return {
    id: job.id, state: job.state, backend: job.backend, model: job.model, effort: job.effort, attempts: job.attempts,
    completedAt: job.completedAt, reportPath: job.reportPath, relay,
    isRelayLost: job.state === "running" && relay !== null && isRelayQuiet(job, at),
    notHandedBack: job.notHandedBack, undeliveredCount: job.undeliveredCount,
    relayViolationCount: job.relayViolationCount, openMessages: job.openMessages,
  };
}

function rowText(job) {
  const parts = [job.id, job.backend, job.state, "attempt " + attemptOf(job)];
  if (job.undeliveredCount > 0) {
    parts.push(job.undeliveredCount + " owed");
  }
  if (job.notHandedBack) {
    parts.push("not handed back");
  }
  if (job.isRelayLost) {
    parts.push("relay lost");
  }
  if (job.relayViolationCount > 0) {
    parts.push(job.relayViolationCount + (job.relayViolationCount === 1 ? " violation" : " violations"));
  }
  return parts.join(" · ");
}

// What tells the board the selected job's full view is out of date: what changes when the job
// takes a message (its open and owed messages, and the relay's call that hands one over), starts
// an attempt, or ends and lands its report. Not `updatedAt`, which the worker's heartbeat rewrites
// every ten seconds.
function detailMark(job) {
  return [job.state, job.attempts, job.openMessages, job.undeliveredCount, job.reportPath, job.completedAt, job.relay?.lastToolAt ?? null].join("|");
}

// Whether the selected job's view is read at this read: a new job, a stale view that is not
// waiting out a failure, or a live job's view at the last tick within LIVE_VIEW_MS of its read.
function isDetailDue(detail, job, at) {
  if (detail?.id !== job.id) {
    return true;
  }
  if (detail.mark === detailMark(job)) {
    return isLive(job) && at !== null && at - (detail.readAt ?? 0) > LIVE_VIEW_MS - TICK_MS;
  }
  return detail.retryAt === null || (at !== null && at >= detail.retryAt);
}

// A read writes only a value that changed: every write of a value the pane reads draws it again.
function isSame(one, other) {
  return JSON.stringify(one) === JSON.stringify(other);
}

// The board's pane, or undefined once it is closed.
async function boardPane($) {
  return (await $.ui.panes()).find((one) => one.id === BOARD_PANE);
}

// Whether a surface draws the pane now: placed, and shown rather than a tab behind another pane.
async function isDrawn($, pane) {
  return pane?.isPlaced === true && pane.isShown === true && (await $.session.surfaces()).length > 0;
}

function stopBoard(board) {
  board.timer?.cancel();
  board.timer = null;
}

// One read, only while a surface draws the board, and one at a time: the guard is taken before
// the first await, so a tick and a press whose pane reads overlap never both read.
async function boardTick($, board) {
  if (board.isReading) {
    return;
  }
  board.isReading = true;
  // A close and a reopen while this tick's pane read is out start another timer, which the
  // read's stale "no pane" must not stop.
  const timer = board.timer;
  try {
    const pane = await boardPane($);
    if (pane === undefined) {
      // Closed: an unload, or a drawing that threw, closes the pane without the ui.close hook.
      if (board.timer === timer) {
        stopBoard(board);
      }
    } else if (await isDrawn($, pane)) {
      await readBoard($);
    }
  } finally {
    board.isReading = false;
  }
}

const NOT_READ = { jobs: [], nextCursor: null, isRead: false, isBusy: false, error: null };

// The window's listing, then the selected job's view when it is due and the board still draws:
// a close during the listing starts no `result`.
async function readBoard($) {
  const window = await read($, boardWindow);
  const args = ["status", "--json", "--limit", String(window.limit)];
  if (window.cursor !== null) {
    args.push("--cursor", window.cursor);
  }
  const ran = await companionJson($, args, 10000);
  const at = await now($);
  const stored = await read($, boardList);
  const last = stored ?? NOT_READ;
  let list;
  if (isBusy(ran)) {
    list = { ...last, isBusy: true, error: null };
  } else if (failureOf(ran) !== null || !Array.isArray(ran.answer.jobs)) {
    list = { ...last, isBusy: false, error: "The jobs could not be read: " + (failureOf(ran) ?? "the answer lists none") + "." };
  } else {
    list = { jobs: ran.answer.jobs.map((job) => boardRow(job, at)), nextCursor: ran.answer.nextCursor ?? null, isRead: true, isBusy: false, error: null };
  }
  if (!isSame(list, stored)) {
    await update($, boardList, () => list);
  }
  if (!(await isDrawn($, await boardPane($)))) {
    return;
  }
  const selected = await read($, boardSelected);
  const job = list.jobs.find((one) => one.id === selected);
  if (job !== undefined && isDetailDue(await read($, boardDetail), job, at)) {
    await readDetail($, job, at);
  }
}

// `at` is the time the read starts, which a live job's next read is counted from.
async function readDetail($, job, at) {
  const ran = await companionJson($, ["result", job.id, "--json"], 30000);
  const last = await read($, boardDetail);
  const kept = last?.id === job.id ? last : { id: job.id, mark: null, readAt: null, retryAt: null, isRead: false, messages: [], report: null, isBusy: false, error: null };
  let detail;
  if (isBusy(ran)) {
    // The mark stays stale, so the next tick reads again.
    detail = { ...kept, retryAt: null, isBusy: true, error: null };
  } else if (failureOf(ran) !== null) {
    const failedAt = await now($);
    detail = { ...kept, mark: null, retryAt: failedAt === null ? null : failedAt + RETRY_MS, isBusy: false, error: failureOf(ran) };
  } else {
    const { messages, report } = ran.answer;
    detail = { id: job.id, mark: detailMark(job), readAt: at, retryAt: null, isRead: true, messages, report, isBusy: false, error: null };
  }
  if (!isSame(detail, last)) {
    await update($, boardDetail, () => detail);
  }
}

// The job's view is read at the next read, a failed one at once.
async function staleDetail($, id) {
  if ((await read($, boardDetail))?.id === id) {
    await update($, boardDetail, (detail) => ({ ...detail, mark: null, retryAt: null }));
  }
}

// A row pressed is read again, and after a send or a cancel the job is read again at once.
async function readAgain($, board, id) {
  await staleDetail($, id);
  await boardTick($, board);
}

async function selectJob($, board, id) {
  await update($, boardSelected, () => id);
  await readAgain($, board, id);
}

async function moveWindow($, board, move) {
  await update($, boardWindow, move);
  await boardTick($, board);
}

// The relay route (D61): the job's current relay is an Agent tool agent of this session, by the
// session id read now, and a live job's relay runs here (the list holds this process's agents
// alone) and has called within 15 minutes. An ended or dead job's relay has finished and left
// the list; the lead's SendMessage resumes it for a continue (D17).
async function isByRelay($, job) {
  const relay = job.relay;
  // A Workflow relay never goes by the relay (D53): one with a run id, or a string-return relay
  // recorded with none.
  if (relay?.agentId == null || relay.workflowRunId != null || relay.stringReturn || job.claudeSessionId !== (await $.session.id())) {
    return false;
  }
  if (!isLive(job)) {
    return true;
  }
  if (isRelayQuiet(job, await now($))) {
    return false;
  }
  // A relay between its model's steps may show as waiting; only an ended one (completed, failed, killed) is gone.
  return (await $.agent.list()).some((agent) => agent.id === relay.agentId && agent.type === "relay:job" && LIVE_AGENT.includes(agent.status));
}

function noteOf(id, line, more = {}) {
  return { id, line, retry: null, delivered: null, ...more };
}

// A text as the job's messages preview it (readJobMessages, scripts/lib/jobs/messages.mjs): its
// first line that is not blank, its spaces folded, cut to 120 characters.
function previewOf(text) {
  const line = text.split(/\r?\n/).find((one) => one.trim()) ?? "";
  return Array.from(line.replace(/\s+/g, " ").trim()).slice(0, 120).join("");
}

// One send per press. `kind` is what the field's label offered, or a refused send's kind when the
// person pressed "Send to the job directly" (`retry`). A press while one for the job still runs
// is dropped, and the board never sends again by itself.
async function sendFromBoard($, board, id, text, kind, retry) {
  if (text.trim() === "" || board.sending.has(id)) {
    return;
  }
  board.sending.add(id);
  try {
    // At once: the job's read takes up to 10 s, and a press the guard drops meanwhile shows why.
    await update($, boardNote, () => noteOf(id, "Reading the job…"));
    // Only the reads before a send can throw.
    const note = await sendOnce($, id, text, kind, retry).catch((error) => noteOf(id, "Nothing was sent: " + (error?.message ?? String(error)) + ".", { retry }));
    await update($, boardNote, () => note);
  } finally {
    board.sending.delete(id);
  }
  await readAgain($, board, id);
}

// The kind and the route come from the job as read now, never from the list.
async function sendOnce($, id, text, kind, retry) {
  const fresh = await companionJson($, ["status", id, "--json"], 10000);
  if (isBusy(fresh) || failureOf(fresh) !== null) {
    const why = isBusy(fresh) ? "its record was changing" : failureOf(fresh);
    return noteOf(id, "Nothing was sent: the job could not be read (" + why + ").", { retry });
  }
  const job = fresh.answer;
  if (sendKind(job) !== kind || (retry !== null && job.attempts !== retry.attempts)) {
    return noteOf(id, "Nothing was sent: the job moved on, and is " + job.state + " at attempt " + attemptOf(job) + ".");
  }
  if (retry === null && (await isByRelay($, job))) {
    return sendByRelay($, job, text, kind);
  }
  const to = "To the job directly (" + kind + "): ";
  await update($, boardNote, () => noteOf(id, to + "sending…"));
  const ran = await companionJson($, [kind, id, "--message", text, "--json"], await sendTimeoutMs($));
  if (ran.failure !== undefined) {
    return noteOf(id, to + unread(ran) + "; it may have reached the job.");
  }
  if (ran.answer.error != null) {
    return noteOf(id, to + ran.answer.error.message);
  }
  return noteOf(id, to + (ran.answer.outcome?.action ?? "pending, no worker has taken it yet") + ".");
}

async function sendByRelay($, job, text, kind) {
  const by = "By the relay " + (job.relay.label ?? job.relay.agentId) + ": ";
  const at = await now($);
  try {
    const sent = await $.session.send({ to: { agentId: job.relay.agentId }, text });
    if (!sent.isDelivered) {
      return noteOf(job.id, by + "refused: " + sent.reason, { retry: { text, kind, attempts: job.attempts } });
    }
  } catch (error) {
    return noteOf(job.id, by + "the send did not finish (" + (error?.message ?? String(error)) + "); it may have gone through.");
  }
  // The module's own session.send hook does not see the board's send.
  await wake($, job.relay.agentId).catch(() => {});
  // Pending until the job's messages show this one handed over by the relay: created since the
  // send, with this text's preview. Another message the relay delivers first is not this one.
  const delivered = at === null ? null : { since: at, preview: previewOf(text), line: by + "sent, and the relay delivered it." };
  return noteOf(job.id, by + "sent, pending until the relay delivers it.", { delivered });
}

async function askCancel($, id) {
  const job = (await read($, boardList))?.jobs.find((one) => one.id === id);
  if (job !== undefined) {
    await update($, boardConfirm, () => ({ id, attempt: attemptOf(job) }));
  }
}

// Yes on the question: the attempt it named, so a newer attempt is never cancelled. A Yes while a
// cancel of the job still runs is dropped; the note says it runs.
async function cancelFromBoard($, board, confirm) {
  await update($, boardConfirm, () => null);
  if (board.cancelling.has(confirm.id)) {
    return;
  }
  board.cancelling.add(confirm.id);
  try {
    const of = "Cancel of attempt " + confirm.attempt + ": ";
    await update($, boardNote, () => noteOf(confirm.id, "Cancelling attempt " + confirm.attempt + "…"));
    const args = ["cancel", confirm.id, "--attempt", String(confirm.attempt), "--json"];
    const ran = await companionJson($, args, await cancelTimeoutMs($));
    let line;
    if (ran.failure !== undefined) {
      line = of + unread(ran) + "; it may have gone through, and the list shows the job's state.";
    } else if (ran.answer.error?.kind === "attempt-changed") {
      line = of + ran.answer.error.message + " The job moved on: press Cancel again to cancel the new attempt.";
    } else if (ran.answer.error != null) {
      line = of + ran.answer.error.message;
    } else {
      // Exit 4: the cancel went to the job's worker, which has not ended the job yet.
      const state = ran.exitCode === 4 ? "the job still runs, and the cancel is with its worker" : "the job is " + ran.answer.state;
      const actions = Array.isArray(ran.answer.actions) && ran.answer.actions.length > 0 ? " (" + ran.answer.actions.join("; ") + ")" : "";
      line = of + state + actions + ".";
    }
    await update($, boardNote, () => noteOf(confirm.id, line));
  } finally {
    board.cancelling.delete(confirm.id);
  }
  await readAgain($, board, confirm.id);
}

// The board reads every three seconds from its open until its pane closes.
function startBoard($, board) {
  board.timer ??= $.clock.every(TICK_MS, () => {
    boardTick($, board).catch(() => {});
  });
}

async function openBoard($, board) {
  const opened = await $.ui.open({ id: BOARD_PANE, title: "Relay jobs", focus: true });
  // With no surface the pane waits for one, and its timer waits for session.attach.
  if (!opened.isPlaced && opened.reason.startsWith("no-surface")) {
    return { text: NO_SURFACE };
  }
  startBoard($, board);
  if (opened.isPlaced) {
    await boardTick($, board);
    return { text: "Opened the relay board." };
  }
  return { text: "The relay board is open but not drawn: " + opened.reason };
}

// The pane, from `$.state` alone. The handlers run the board's processes when pressed.
async function drawBoard($, e, board) {
  const elements = $.ui.resolve(e);
  const { Box, Text, Button } = elements;
  const list = await read($, boardList);
  // Until a read succeeds there is nothing to list, and a busy read is no answer.
  if (list === null || (!list.isRead && list.error === null)) {
    return h(Text, { dimColor: true }, "Reading this repository's jobs...");
  }
  const selected = await read($, boardSelected);
  const window = await read($, boardWindow);
  const nodes = [];
  if (list.error !== null) {
    nodes.push(h(Text, { color: "error" }, list.error));
  }
  if (list.isBusy) {
    nodes.push(h(Text, { dimColor: true }, "A job's record was changing: this is the last read."));
  }
  if (list.isRead && list.jobs.length === 0) {
    nodes.push(h(Text, { dimColor: true }, "No jobs in this repository."));
  }
  // The pane takes the keys when it opens and at ctrl+x tab; the ring then starts on the selected row, or
  // the first, rather than on nothing, so the person sees where the keys went.
  const ring = list.jobs.some((one) => one.id === selected) ? selected : list.jobs[0]?.id;
  for (const job of list.jobs) {
    const mark = job.id === selected ? "> " : "  ";
    const focus = job.id === ring ? { autoFocus: true } : {};
    nodes.push(h(Button, { key: "job:" + job.id, plain: true, ...focus, onPress: () => selectJob($, board, job.id) }, mark + rowText(job)));
  }
  // More grows the window to the most one listing holds; past that the window moves to older jobs.
  if (list.nextCursor !== null && window.limit < MOST_ROWS) {
    nodes.push(h(Button, { key: "more", label: "More", onPress: () => moveWindow($, board, (current) => ({ ...current, limit: Math.min(MOST_ROWS, current.limit + PAGE) })) }));
  } else if (list.nextCursor !== null) {
    const cursor = list.nextCursor;
    nodes.push(h(Button, { key: "older", label: "Older jobs", onPress: () => moveWindow($, board, (current) => ({ ...current, cursor })) }));
  }
  if (window.cursor !== null) {
    nodes.push(h(Button, { key: "newest", label: "Newest jobs", onPress: () => moveWindow($, board, (current) => ({ ...current, cursor: null })) }));
  }
  const job = list.jobs.find((one) => one.id === selected);
  if (job !== undefined) {
    nodes.push(await drawJob($, elements, job, board));
  }
  return h(Box, { flexDirection: "column" }, ...nodes);
}

async function drawJob($, { Box, Text, Button, Input, Markdown }, job, board) {
  const relay = job.relay;
  const nodes = [
    h(Text, { bold: true }, job.id + " · " + job.backend + " · " + job.state + " · attempt " + attemptOf(job)),
    h(Text, null, "model " + (job.model ?? "default") + " · effort " + (job.effort ?? "default")),
    h(Text, null, relay === null ? "no relay" : "relay " + (relay.label ?? relay.agentId) + (relay.workflowRunId === null ? "" : " · Workflow run " + relay.workflowRunId)),
  ];
  // The mobile app draws no text field. The field is the job's own, so text typed for one job
  // never stays in it for another.
  if (Input !== undefined) {
    const kind = sendKind(job);
    const onSubmit = (text) => sendFromBoard($, board, job.id, text, kind, null);
    nodes.push(h(Input, { key: "message:" + job.id, label: sendLabel(job), submitLabel: "send", onSubmit }));
  }
  const detail = await read($, boardDetail);
  const view = detail?.id === job.id ? detail : null;
  const note = await read($, boardNote);
  if (note?.id === job.id) {
    const isDelivered = note.delivered !== null && view !== null && view.messages.some((message) =>
      message.relay != null && message.preview === note.delivered.preview && Date.parse(message.createdAt ?? "") >= note.delivered.since);
    nodes.push(h(Text, null, isDelivered ? note.delivered.line : note.line));
    const retry = note.retry;
    if (retry !== null) {
      nodes.push(h(Button, { key: "direct", label: "Send to the job directly", onPress: () => sendFromBoard($, board, job.id, retry.text, retry.kind, retry) }));
    }
  }
  const confirm = await read($, boardConfirm);
  if (confirm?.id === job.id) {
    nodes.push(h(Box, { flexDirection: "row", gap: 1 },
      h(Text, null, "Cancel job " + job.id + ", attempt " + confirm.attempt + "?"),
      h(Button, { key: "cancel-yes", label: "Yes", onPress: () => cancelFromBoard($, board, confirm) }),
      h(Button, { key: "cancel-no", label: "No", onPress: () => update($, boardConfirm, () => null) })));
  } else if (!ENDED.includes(job.state)) {
    nodes.push(h(Button, { key: "cancel", label: "Cancel", onPress: () => askCancel($, job.id) }));
  }
  if (view === null || (view.isBusy && !view.isRead)) {
    nodes.push(h(Text, { dimColor: true }, "Reading the job..."));
    return h(Box, { flexDirection: "column", marginTop: 1 }, ...nodes);
  }
  if (view.isBusy) {
    nodes.push(h(Text, { dimColor: true }, "The job's record was changing: this is the last read."));
  }
  for (const message of view.messages) {
    const route = message.relay != null ? "by the relay" : "directly";
    const taken = message.outcome?.action ?? "pending (" + message.stage + ")";
    nodes.push(h(Text, null, "- " + message.kind + " · " + message.preview + " · " + route + " · " + taken));
  }
  if (view.error !== null) {
    const where = job.reportPath === null ? "" : " The report is " + job.reportPath + ";";
    nodes.push(h(Text, { color: "error" }, "The job could not be read: " + view.error + "." + where + " /relay:result " + job.id + " shows it."));
  } else if (view.report !== null) {
    nodes.push(h(Markdown, { text: view.report }));
  } else {
    nodes.push(h(Text, { dimColor: true }, "No report yet."));
  }
  return h(Box, { flexDirection: "column", marginTop: 1 }, ...nodes);
}

export function register(on) {
  // One timer and one read in flight per load of the module. `fastUntil` is the last tick of the
  // every-tick reads a relay event (a relay:job spawn, a wake, one of the commands below) asks for.
  const poller = { timer: null, ticks: 0, isReading: false, isCleared: false, readTick: 0, fastUntil: 0 };
  // `sending` holds the jobs a press is sending to, `cancelling` those a Yes is cancelling.
  const board = { timer: null, isReading: false, sending: new Set(), cancelling: new Set() };
  on("session.start", async ($, e, next) => {
    // session.start fires again without a reload (an enable, another plugin's engine.create),
    // and this copy's timers are still running then.
    poller.timer ??= $.clock.every(5000, () => {
      // A tick that failed leaves the line as it is; the next one reads again.
      poll($, poller, ++poller.ticks).catch(() => {});
    });
    try {
      // A reload ends the old copy's timer while the board's pane stays open.
      if ((await $.ui.panes()).some((pane) => pane.id === BOARD_PANE)) {
        startBoard($, board);
      }
    } catch {
      // The next /relay-board starts it.
    }
    // A command the module registers can run mid-turn; a plugin's markdown command cannot.
    await $.command.register(BOARD_COMMAND);
    return next(e);
  });

  // A board opened where nothing drew starts reading once a surface attaches to draw it.
  on("session.attach", async ($, e, next) => {
    const attached = await next(e);
    try {
      if ((await boardPane($)) !== undefined) {
        startBoard($, board);
      }
    } catch {
      // The next /relay-board starts it.
    }
    return attached;
  });

  // A registered command is declared "for this session", and /clear, /resume and a fork go on
  // under another session with no session.start, so the board's command is declared again;
  // declaring a name again replaces it.
  on("classic.SessionStart", async ($, e, next) => {
    if (["clear", "resume", "fork"].includes(e.source)) {
      await $.command.register(BOARD_COMMAND).catch(() => {});
    }
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    if (e?.subagentType === "relay:job") {
      poller.fastUntil = poller.ticks + CLEARED_TICKS;
    }
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
        poller.fastUntil = poller.ticks + CLEARED_TICKS;
        await wake($, id);
      }
    } catch {
      // The message is already queued. Without a wake the relay still reads it when its wait
      // reaches its bound, so a failed wake only costs time and must not touch the send's result.
    }
    return result;
  });

  // The mark is written before the stop: the relay's aborted turn can end before the call returns.
  // The answer then narrows it to the agent stopped. It never decides a stop: the answer goes back
  // as it came, and a hook that failed or ran past its budget passes the call on too.
  on("tool.call", { tool: "TaskStop" }, async ($, e, next) => {
    let wrote;
    try {
      wrote = await markTaskStop($, e);
    } catch {
      // Unmarked, the relay's stop shows the notice even though relay-stop cancels its job.
    }
    const answer = await next(e);
    if (wrote !== undefined) {
      try {
        await narrowTaskStop($, wrote, answer);
      } catch {
        // The marks stay as written, and lapse within the minute.
      }
    }
    return answer;
  }).catch(($, e, next) => next(e));

  // The engine awaits this hook before the turn ends, so the notice's listing runs on a timer
  // after it has returned, and a slow or stuck listing never holds Claude Code's stop.
  on("turn.complete", async ($, e, next) => {
    const completed = await next(e);
    if (e.agentId != null && e.reason === "aborted") {
      try {
        $.clock.after(0, () => {
          // The stop has happened; a missing notice is the behaviour before it.
          stopNotice($, e, poller).catch(() => {});
        });
      } catch {
        // No timer, no notice.
      }
    }
    return completed;
  });

  // A command marks the event when it ends, after the change it made to a job.
  const marked = () => {
    poller.fastUntil = poller.ticks + CLEARED_TICKS;
  };
  on("command.run", { command: "relay:status" }, ($, e) => answerCommand($, e, "status", 30000).finally(marked))
    .catch(($, e, next) => moduleFailed($, e, next, "status"));
  on("command.run", { command: "relay:result" }, ($, e) => answerCommand($, e, "result", 30000).finally(marked))
    .catch(($, e, next) => moduleFailed($, e, next, "result"));
  // Cancel's timeout follows the grace it waits for the worker (cancelTimeoutMs), transfer's sits
  // above the two minutes it allows Codex's import.
  on("command.run", { command: "relay:cancel" }, async ($, e) => answerCommand($, e, "cancel", await cancelTimeoutMs($)).finally(marked))
    .catch(($, e, next) => moduleFailed($, e, next, "cancel"));
  on("command.run", { command: "relay:transfer" }, ($, e) => answerCommand($, e, "transfer", 180000, true).finally(marked))
    .catch(($, e, next) => moduleFailed($, e, next, "transfer"));
  on("command.run", { command: "relay-board" }, ($) => openBoard($, board));
  on("ui.render", { component: "Pane", requestId: BOARD_PANE }, ($, e) => drawBoard($, e, board));
  on("ui.close", { id: BOARD_PANE }, async ($, e, next) => {
    const closed = await next(e);
    stopBoard(board);
    return closed;
  });
}
