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
// --json` fills while the pane is open and a surface draws, and the selected job's `result --json`.
// A press runs its process from the handler, never from a drawing.

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
  // A loop, not a spread: a large output can hold more backtick runs than a call takes arguments.
  const longest = (verbatim.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
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

// Ends the wait of the relay with this agent id, so it delivers a message queued for it now.
async function wake($, id) {
  await $.process.run(["node", $.plugin.root + "/scripts/companion.mjs", "wake", "--agent", id], { timeoutMs: 10000 });
}

// A hook that threw or ran past its budget would otherwise be skipped, and the markdown body
// would run in its place. The handler has a one-second grace, so it makes no call on `$`.
function moduleFailed($, e, next, sub) {
  const why = next.error.kind === "timeout" ? "it ran past its time budget" : next.error.message ?? "it failed";
  return errorText(e, "The relay module failed while answering it: " + why + ". Run " + companionShell($, sub, e.args) + " in a shell to see its output.");
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
  const parts = [];
  if (running > 0) {
    // More pages exist, and the line does not page.
    parts.push(running + (answer.nextCursor != null ? "+" : "") + " running");
  }
  if (dead > 0) {
    parts.push(dead + " dead");
  }
  if (owed > 0) {
    parts.push(owed + " owed");
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
// after a relay event it did see (a relay's job exists only once its start has run).
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
    }
  } finally {
    poller.isReading = false;
  }
}

const BOARD_PANE = "relay-board";
const PAGE = 20;
// A relay quiet for longer may be gone: a waiting relay calls about every nine minutes, and the
// gap can pass ten.
const RELAY_QUIET_MS = 15 * 60 * 1000;
// The companion waits up to 60 s for the worker to take a steer or a continue.
const SEND_TIMEOUT_MS = 75000;
const ENDED = ["completed", "failed", "cancelled"];

const boardList = atom({ plugin: "relay", key: "boardList" }, null);
const boardLimit = atom({ plugin: "relay", key: "boardLimit" }, PAGE);
const boardSelected = atom({ plugin: "relay", key: "boardSelected" }, null);
const boardDetail = atom({ plugin: "relay", key: "boardDetail" }, null);
const boardNote = atom({ plugin: "relay", key: "boardNote" }, null);
const boardConfirm = atom({ plugin: "relay", key: "boardConfirm" }, null);

const NO_SURFACE = "The relay board draws in the terminal and the desktop app, and nothing draws here. /relay:status lists this repository's jobs.";

// One companion run that prints a `relay.<sub>/1` object: `{ answer, exitCode }`, or `{ failure }`
// when it did not finish or printed nothing the board can read.
async function companionJson($, args, timeoutMs) {
  try {
    const argv = ["node", $.plugin.root + "/scripts/companion.mjs", ...args];
    const ran = await $.process.run(argv, { cwd: await $.session.cwd(), timeoutMs });
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

function sendLabel(job) {
  if (!isLive(job)) {
    return "Continue";
  }
  return job.backend === "kimi" && job.state === "running" ? "Queue next turn" : "Steer";
}

function rowText(job, readAt) {
  const parts = [job.id, job.backend, job.state, "attempt " + attemptOf(job)];
  if (job.undeliveredCount > 0) {
    parts.push(job.undeliveredCount + " owed");
  }
  if (job.notHandedBack) {
    parts.push("not handed back");
  }
  if (job.state === "running" && job.relay !== null && isRelayQuiet(job, readAt)) {
    parts.push("relay lost");
  }
  if (job.relayViolationCount > 0) {
    parts.push(job.relayViolationCount + (job.relayViolationCount === 1 ? " violation" : " violations"));
  }
  return parts.join(" · ");
}

// What tells the board the selected job's full view is out of date. Its open messages count too,
// so a send's outcome shows once the job takes it.
function detailMark(job) {
  return [job.updatedAt, job.state, job.attempts, job.openMessages].join("|");
}

// One read: only while the board is open, a surface draws it and no read is in flight.
async function boardTick($, board) {
  if (board.isReading || !(await $.ui.panes()).some((pane) => pane.id === BOARD_PANE)) {
    return;
  }
  if ((await $.session.surfaces()).length === 0) {
    return;
  }
  board.isReading = true;
  try {
    await readBoard($);
  } finally {
    board.isReading = false;
  }
}

// The listing, then the selected job's full view when it is new or its row changed.
async function readBoard($) {
  const ran = await companionJson($, ["status", "--json", "--limit", String(await read($, boardLimit))], 10000);
  const last = (await read($, boardList)) ?? { jobs: [], nextCursor: null, readAt: null };
  let list;
  if (isBusy(ran)) {
    list = { ...last, isBusy: true, error: null };
  } else if (failureOf(ran) !== null || !Array.isArray(ran.answer.jobs)) {
    list = { ...last, isBusy: false, error: "The jobs could not be read: " + (failureOf(ran) ?? "the answer lists none") + "." };
  } else {
    list = { jobs: ran.answer.jobs, nextCursor: ran.answer.nextCursor ?? null, readAt: await now($), isBusy: false, error: null };
  }
  await update($, boardList, () => list);
  const selected = await read($, boardSelected);
  const job = list.jobs.find((one) => one.id === selected);
  const detail = await read($, boardDetail);
  if (job !== undefined && (detail?.id !== job.id || detail.mark !== detailMark(job))) {
    await readDetail($, job);
  }
}

async function readDetail($, job) {
  const ran = await companionJson($, ["result", job.id, "--json"], 30000);
  const last = await read($, boardDetail);
  const kept = last?.id === job.id ? last : { id: job.id, mark: null, messages: [], report: null };
  let detail;
  if (isBusy(ran)) {
    // The mark stays, so the next tick reads again.
    detail = { ...kept, isBusy: true, error: null };
  } else if (failureOf(ran) !== null) {
    detail = { ...kept, mark: detailMark(job), isBusy: false, error: failureOf(ran) };
  } else {
    const { messages, report } = ran.answer;
    detail = { id: job.id, mark: detailMark(job), messages, report, isBusy: false, error: null };
  }
  await update($, boardDetail, () => detail);
}

// After a send or a cancel the selected job is read again at once.
async function readAgain($, board) {
  await update($, boardDetail, (detail) => detail && { ...detail, mark: null });
  await boardTick($, board);
}

async function selectJob($, board, id) {
  await update($, boardSelected, () => id);
  await boardTick($, board);
}

async function moreJobs($, board) {
  await update($, boardLimit, (limit) => Math.min(200, limit + PAGE));
  await boardTick($, board);
}

// The relay route (D61): the job's current relay is this session's Agent tool agent, and a running
// job's relay has called lately. Everything else goes to the job directly.
async function isByRelay($, job) {
  if (job.relay?.agentId == null || job.relay.workflowRunId != null) {
    return false;
  }
  if (job.claudeSessionId !== (await $.session.id())) {
    return false;
  }
  return job.state !== "running" || !isRelayQuiet(job, await now($));
}

// One send, by the route the job's facts choose at the press, or to the job directly when the
// person pressed that after a refusal. The board never sends again by itself.
async function sendFromBoard($, board, id, text, isDirect) {
  const job = (await read($, boardList))?.jobs.find((one) => one.id === id);
  if (job === undefined || text.trim() === "") {
    return;
  }
  const kind = isLive(job) ? "steer" : "continue";
  let line;
  let retry = null;
  if (!isDirect && (await isByRelay($, job))) {
    const by = "By the relay " + (job.relay.label ?? job.relay.agentId) + ": ";
    try {
      const sent = await $.session.send({ to: { agentId: job.relay.agentId }, text });
      if (sent.isDelivered) {
        line = by + "sent, pending until the relay delivers it.";
        // The module's own session.send hook does not see the board's send.
        await wake($, job.relay.agentId).catch(() => {});
      } else {
        line = by + "refused: " + sent.reason;
        retry = text;
      }
    } catch (error) {
      line = by + "the send did not finish (" + (error?.message ?? String(error)) + "); it may have gone through.";
    }
  } else {
    const ran = await companionJson($, [kind, job.id, "--message", text, "--json"], SEND_TIMEOUT_MS);
    const to = "To the job directly (" + kind + "): ";
    if (ran.failure !== undefined) {
      line = to + "did not finish (" + ran.failure + "); it may have reached the job.";
    } else if (ran.answer.error != null) {
      line = to + ran.answer.error.message;
    } else {
      line = to + (ran.answer.outcome?.action ?? "pending, no worker has taken it yet") + ".";
    }
  }
  await update($, boardNote, () => ({ id: job.id, line, retry }));
  await readAgain($, board);
}

async function askCancel($, id) {
  const job = (await read($, boardList))?.jobs.find((one) => one.id === id);
  if (job !== undefined) {
    await update($, boardConfirm, () => ({ id, attempt: attemptOf(job) }));
  }
}

// Yes on the question: the attempt it named, so a newer attempt is never cancelled.
async function cancelFromBoard($, board, confirm) {
  await update($, boardConfirm, () => null);
  const args = ["cancel", confirm.id, "--attempt", String(confirm.attempt), "--json"];
  const ran = await companionJson($, args, await cancelTimeoutMs($));
  const of = "Cancel of attempt " + confirm.attempt + ": ";
  let line;
  if (ran.failure !== undefined) {
    line = of + "did not finish (" + ran.failure + "); it may have gone through, and the list shows the job's state.";
  } else if (ran.answer.error?.kind === "attempt-changed") {
    line = of + ran.answer.error.message + " The job moved on: press Cancel again to cancel the new attempt.";
  } else if (ran.answer.error != null) {
    line = of + ran.answer.error.message;
  } else {
    line = of + "the job is " + ran.answer.state + ".";
  }
  await update($, boardNote, () => ({ id: confirm.id, line, retry: null }));
  await readAgain($, board);
}

async function openBoard($, board) {
  const opened = await $.ui.open({ id: BOARD_PANE, title: "Relay jobs", focus: true });
  if (opened.isPlaced) {
    await boardTick($, board);
    return { text: "Opened the relay board." };
  }
  return { text: opened.reason.startsWith("no-surface") ? NO_SURFACE : "The relay board is open but not drawn: " + opened.reason };
}

// The pane, from `$.state` alone. The handlers run the board's processes when pressed.
async function drawBoard($, e, board) {
  const elements = $.ui.resolve(e);
  const { Box, Text, Button } = elements;
  const list = await read($, boardList);
  if (list === null) {
    return h(Text, { dimColor: true }, "Reading this repository's jobs...");
  }
  const selected = await read($, boardSelected);
  const nodes = [];
  if (list.error !== null) {
    nodes.push(h(Text, { color: "error" }, list.error));
  }
  if (list.isBusy) {
    nodes.push(h(Text, { dimColor: true }, "A job's record was changing: this is the last read."));
  }
  if (list.jobs.length === 0) {
    nodes.push(h(Text, { dimColor: true }, "No jobs in this repository."));
  }
  for (const job of list.jobs) {
    const mark = job.id === selected ? "> " : "  ";
    nodes.push(h(Button, { key: "job:" + job.id, plain: true, onPress: () => selectJob($, board, job.id) }, mark + rowText(job, list.readAt)));
  }
  if (list.nextCursor !== null && (await read($, boardLimit)) < 200) {
    nodes.push(h(Button, { key: "more", label: "More", onPress: () => moreJobs($, board) }));
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
  // The mobile app draws no text field.
  if (Input !== undefined) {
    const onSubmit = (text) => sendFromBoard($, board, job.id, text, false);
    nodes.push(h(Input, { key: "message", label: sendLabel(job) + ": ", submitLabel: "send", onSubmit }));
  }
  const note = await read($, boardNote);
  if (note?.id === job.id) {
    nodes.push(h(Text, null, note.line));
    if (note.retry !== null) {
      nodes.push(h(Button, { key: "direct", label: "Send to the job directly", onPress: () => sendFromBoard($, board, job.id, note.retry, true) }));
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
  const detail = await read($, boardDetail);
  if (detail?.id !== job.id) {
    nodes.push(h(Text, { dimColor: true }, "Reading the job..."));
    return h(Box, { flexDirection: "column", marginTop: 1 }, ...nodes);
  }
  if (detail.isBusy) {
    nodes.push(h(Text, { dimColor: true }, "The job's record was changing: this is the last read."));
  }
  for (const message of detail.messages) {
    const taken = message.outcome?.action ?? "pending (" + message.stage + ")";
    nodes.push(h(Text, null, "- " + message.kind + " · " + message.preview + " · " + taken));
  }
  if (detail.error !== null) {
    const where = job.reportPath === null ? "" : " The report is " + job.reportPath + ";";
    nodes.push(h(Text, { color: "error" }, "The job could not be read: " + detail.error + "." + where + " /relay:result " + job.id + " shows it."));
  } else if (detail.report !== null) {
    nodes.push(h(Markdown, { text: detail.report }));
  } else {
    nodes.push(h(Text, { dimColor: true }, "No report yet."));
  }
  return h(Box, { flexDirection: "column", marginTop: 1 }, ...nodes);
}

export function register(on) {
  // One timer and one read in flight per load of the module. `fastUntil` is the last tick of the
  // every-tick reads a relay event (a relay:job spawn, a wake, one of the commands below) asks for.
  const poller = { timer: null, ticks: 0, isReading: false, isCleared: false, readTick: 0, fastUntil: 0 };
  const board = { timer: null, isReading: false };
  on("session.start", async ($, e, next) => {
    // session.start fires again without a reload (an enable, another plugin's engine.create),
    // and this copy's timers are still running then.
    poller.timer ??= $.clock.every(5000, () => {
      // A tick that failed leaves the line as it is; the next one reads again.
      poll($, poller, ++poller.ticks).catch(() => {});
    });
    board.timer ??= $.clock.every(3000, () => {
      boardTick($, board).catch(() => {});
    });
    // A command the module registers can run mid-turn; a plugin's markdown command cannot.
    await $.command.register({ name: "relay-board", description: "Show this repository's relay jobs in a pane, to steer, continue or cancel them", immediate: true });
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
}
