// The job worker. One worker per job at a time, holding the job's lease. It starts its
// backend's server process, opens the session, runs turns, acts on inbox messages, and is
// the only writer of job.json while it lives. It stops the server when the job ends.
//
// Every message a command has been told about runs once as part of the session, or is
// reported as not delivered:
// - a claimed message stays owed until its outcome says it was delivered or dropped, and a
//   new worker runs every owed message a dead worker left behind;
// - each dispatch carries a message id, and the connection checks its session history to
//   tell which messages already reached it, so none runs twice;
// - the worker settles every outstanding steer before it decides it has no more work, and
//   never writes a terminal state while it holds queued work.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { admit, admissionHome, releaseSlot, DEFAULTS, admissionEnabled, classifyRefusal, recordRefusal, probeSucceeded } from "./admission.mjs";
import { readUserConfig } from "../jobs/config.mjs";
import { backendFor } from "../backends/index.mjs";
import { truncateCodePoints } from "../util/text.mjs";
import { acquireWorkerLease, releaseWorkerLease, readLease } from "../jobs/lease.mjs";
import { claimInboxMessages, CLOSED_ACTIONS, newMessageId, owedMessages, pendingInboxMessages, readOutcome, writeOutcome } from "../jobs/messages.mjs";
import { jobPaths, nowIso, readJob, writeFileAtomic, writeJob } from "../jobs/store.mjs";
import { PLUGIN_VERSION } from "../util/plugin.mjs";
import { readProcessStartTime } from "../util/process.mjs";
import { stopRecordedAppServers, sweptAppServersPatch } from "./recovery.mjs";

import { DEFAULT_RESUME_MESSAGE, recoveryForEpoch } from "./recovery.mjs";
const APP_SERVER_LOG_BYTES = 1024 * 1024;

function appendStderr(file, chunk) {
  fs.appendFileSync(file, chunk);
  const size = fs.statSync(file).size;
  if (size > APP_SERVER_LOG_BYTES) {
    const tail = Buffer.alloc(APP_SERVER_LOG_BYTES);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, tail, 0, tail.length, size - tail.length); }
    finally { fs.closeSync(fd); }
    fs.writeFileSync(file, tail);
  }
}
const DEFAULT_CAPACITY_DELAYS_MS = [30000, 60000, 120000];
const CAPACITY_PATTERN = /at capacity|capacity|overloaded/i;
// Short-lived request limits retry; usage and quota limits do not.
const REQUEST_RATE_LIMIT_PATTERN = /rate limit reached for requests/i;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// The capacity retry schedule: three retries 30, 60 and 120 s apart, unless
// RELAY_JOBS_CAPACITY_DELAYS_MS names another list.
function capacityDelaysFrom(env = process.env) {
  const raw = String(env.RELAY_JOBS_CAPACITY_DELAYS_MS ?? "").trim();
  if (!raw) {
    return [...DEFAULT_CAPACITY_DELAYS_MS];
  }
  const delays = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return delays.length > 0 ? delays : [...DEFAULT_CAPACITY_DELAYS_MS];
}

function settings(env = process.env) {
  return {
    admissionPollMs: envNumber(env, "RELAY_ADMISSION_POLL_MS", DEFAULTS.pollMs),
    pollMs: envNumber(env, "RELAY_JOBS_POLL_MS", 250),
    heartbeatMs: envNumber(env, "RELAY_JOBS_HEARTBEAT_MS", 10000),
    capacityDelaysMs: capacityDelaysFrom(env)
  };
}

// Sleep up to `ms`, returning early once `shouldStop()` is true.
async function interruptibleSleep(ms, shouldStop = () => false) {
  const until = Date.now() + ms;
  while (Date.now() < until && !shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
  }
}

function threadNameFor(jobId, brief) {
  // A <task> block names the job even when the brief starts with context or instructions.
  const text = String(brief ?? "");
  const taskBlock = /<task>([\s\S]*?)(?:<\/task>|$)/.exec(text)?.[1];
  const source = taskBlock?.trim() ? taskBlock : text;
  const firstLine =
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "job";
  return `${truncateCodePoints(firstLine.replace(/\s+/g, " "), 60)} (${jobId})`;
}

function isCapacityError(error) {
  if (!error) {
    return false;
  }
  if (REQUEST_RATE_LIMIT_PATTERN.test(String(error.message ?? error))) {
    return true;
  }
  return CAPACITY_PATTERN.test(String(error.message ?? error));
}

// Run the worker for a job directory. Returns the final job record, or null when another
// worker holds the job or there was nothing to do. `options.sleep(ms, shouldStop)` replaces
// the capacity backoff wait (tests inject it instead of sleeping). `options.predecessorCleanup`
// supplies the recorded-server cleanup options.
//
// No message is left without a consumer. A round that is about to release the
// lease reads the inbox again; a message that arrived after its last claim keeps the lease
// and runs in the next round. After the lease is gone the inbox is read once more, and a
// message found then is taken with a fresh lease (or by the worker that took it first).
export async function runWorker(jobDir, options = {}) {
  // The submitting process may still be publishing its spawn reservation.
  const spawnDeadline = Date.now() + DEFAULTS.spawnGraceMs;
  while (readLease(jobDir)?.role === "spawn" && Date.now() < spawnDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  let result = null;
  let held = null;
  for (;;) {
    const before = pendingInboxMessages(jobDir).join("\n");
    const round = await runWorkerRound(jobDir, options, held);
    result = round.job ?? result;
    held = round.held ?? null;
    if (round.stop) {
      return result;
    }
    const pending = pendingInboxMessages(jobDir).join("\n");
    // Stop when the inbox is empty, or when a round could take nothing from it.
    if (!pending || (!round.job && pending === before)) {
      if (held) {
        releaseWorkerLease(jobDir, held);
      }
      return result;
    }
  }
}

function sameProcess(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.startTime === b.startTime);
}

async function runWorkerRound(jobDir, options, held) {
  const config = settings(options.env ?? process.env);
  const sleep = options.sleep ?? interruptibleSleep;
  const paths = jobPaths(jobDir);
  const me = held ?? { pid: process.pid, startTime: readProcessStartTime(process.pid), startedAt: nowIso() };
  if (!held && !acquireWorkerLease(jobDir, me)) {
    return { job: null, stop: true };
  }
  // Keep the lease while the inbox holds a message this round did not claim.
  const handOff = () => {
    if (pendingInboxMessages(jobDir).length > 0) {
      return me;
    }
    releaseWorkerLease(jobDir, me);
    return null;
  };

  let job = readJob(jobDir);
  if (!job) {
    releaseWorkerLease(jobDir, me);
    throw new Error(`No job.json in ${jobDir}.`);
  }

  const backend = backendFor(job.request);
  const admissionDeps = { env: options.env ?? process.env, ...options.admission };
  const home = admissionHome(admissionDeps.env);
  let slot = null;
  const guardOn = admissionEnabled(admissionDeps.env, readUserConfig(admissionDeps.env));
  let lastEventAt = job.lastEventAt ?? null;
  const save = (patch = {}) => {
    job = { ...job, ...patch, lastEventAt, heartbeatAt: nowIso() };
    writeJob(jobDir, job);
  };

  const queue = [];
  const pendingSteers = [];
  // Steers a backend accepted, by message id: one that never joined a turn comes back from
  // the run in `unjoinedSteers`.
  const steered = new Map();
  // Steers acknowledged but not yet proved delivered, by message id (see confirmSteers).
  const openSteers = new Map();
  let steerSeq = 0;
  const inflight = new Set();
  let cancelRequested = false;
  const cancelMessages = [];
  /** @type {import("../backends/types").Connection | null} */
  let connection = null;
  let sessionId = job.sessionId ?? null;
  let activeTurnId = null;
  let turnActive = false;
  let attemptOpen = false;
  let interruptSent = false;

  const outcome = (message, result) => {
    if (!message) {
      return;
    }
    writeOutcome(jobDir, message.id, result);
    const log = Array.isArray(job.messages) ? job.messages : [];
    const reset = !message.automatic && ["steered", "turn-started", "delivered-before"].includes(result.action);
    save({ messages: [...log, { id: message.id, kind: message.kind, at: nowIso(), ...result }],
      ...(reset ? { recoveryEpoch: message.id } : {}) });
  };

  const cancelOutcome = (result) => {
    for (const message of cancelMessages) outcome(message, result);
  };

  const enqueue = (item, reason) => {
    queue.push(item);
    if (attemptOpen && item.message) {
      outcome(item.message, { action: "queued-next-turn", reason });
    }
  };

  const accept = (messages, recoveryCandidate = false) => {
    for (const message of messages) {
      if (message.kind === "cancel") {
        const current = job.attempts?.length ?? 0;
        if (message.attempt !== undefined && message.attempt !== current && !(message.attempt === 1 && current === 0)) {
          outcome(message, { action: "no-op", reason: `attempt ${message.attempt} is not the job's current attempt (${current})` });
          continue;
        }
        cancelRequested = true;
        cancelMessages.push(message);
        continue;
      }
      if (message.kind === "steer" && turnActive) {
        pendingSteers.push(message);
        continue;
      }
      enqueue(
        { prompt: message.text, source: message.kind, message, clientId: message.id, isDefault: Boolean(message.isDefault), recoveryCandidate },
        message.kind === "steer" ? "no turn is running" : "a turn is running"
      );
    }
  };

  // A default resume message ("write the final report now") is only needed when nothing
  // else will run. Close it as skipped when there is other work, but only once the attempt that
  // runs that work is on the job, or the job ends (reportSkipped). Closed sooner, the message
  // would leave nothing owed while the job still names its dead predecessor, and a reader would
  // take the job for dead as this worker is about to run it.
  const skipped = [];
  const pruneDefaultResumes = () => {
    const others = queue.filter((item) => !item.isDefault);
    const defaults = queue.filter((item) => item.isDefault);
    const keep = others.length > 0 ? [] : defaults.slice(0, 1);
    skipped.push(...defaults.filter((item) => !keep.includes(item)));
    queue.splice(0, queue.length, ...others, ...keep);
  };
  const reportSkipped = () => {
    for (const item of skipped.splice(0)) {
      outcome(item.message, { action: "skipped", reason: "other queued work ran instead" });
    }
  };

  // The worker records itself in the same write that begins its first attempt (or ends the
  // job), so no reader ever sees a live new worker beside the previous terminal state.
  const me_record = { worker: me, workers: sameProcess(job.workers?.at(-1), me) ? job.workers : [...(job.workers ?? []), me] };

  // A teardown an attempt recorded is final, across a crash too: its message is reported
  // dropped and a brief is not owed, before anything owed is worked out. The backend's delivery
  // evidence stays as it is.
  const honourTeardowns = () => {
    for (const attempt of job.attempts ?? []) {
      const teardown = attempt?.teardown;
      if (!teardown) continue;
      if (teardown.messageId) {
        const reason = attempt.errorMessage ?? "The backend could not confirm the message started.";
        const message = { id: teardown.messageId, kind: teardown.source };
        const action = readOutcome(jobDir, teardown.messageId)?.action;
        if (!CLOSED_ACTIONS.has(action)) outcome(message, { action: "dropped", reason });
        else if (action === "dropped" && !(job.messages ?? []).some(entry => entry.id === teardown.messageId && entry.action === "dropped")) {
          save({ messages: [...(job.messages ?? []), { id: message.id, kind: message.kind, at: nowIso(), action: "dropped", reason }] });
        }
      }
      if (teardown.source === "brief" && job.pendingFirstTurn) save({ pendingFirstTurn: false });
    }
  };
  honourTeardowns();

  // Work: the first brief if it never started, then messages a dead worker claimed but
  // never delivered, then new inbox messages.
  // A job cancelled before its first turn never runs its brief later; a failed first turn keeps it
  // for `resume`, which runs it before the resume message.
  if (job.pendingFirstTurn && job.state !== "cancelled") {
    queue.push({ prompt: fs.readFileSync(paths.brief, "utf8"), source: "brief", message: null, clientId: `brief-${job.id}`, recoveryCandidate: true });
  }
  accept(owedMessages(jobDir), true);
  accept(claimInboxMessages(jobDir));
  pruneDefaultResumes();

  // Set when a predecessor's app-server survives the sweep: its identity stays on the job,
  // and the worker ends without another round (the next one would meet the same server).
  let sweepFailed = false;
  const releaseAndReturn = async (patch) => {
    if (connection) {
      await connection.close().catch(() => {});
      connection = null;
    }
    if (sweepFailed) {
      save(patch);
      releaseWorkerLease(jobDir, me);
      return { job, stop: true };
    }
    save({ ...patch, serverPid: null, server: null });
    return { job, held: handOff() };
  };

  const dropQueued = (reason) => {
    reportSkipped();
    for (const item of queue.splice(0)) {
      outcome(item.message, { action: "dropped", reason });
    }
    for (const message of pendingSteers.splice(0)) {
      outcome(message, { action: "dropped", reason });
    }
  };

  const cancelBeforeTurn = () => {
    const attempts = (job.attempts ?? []).map(entry =>
      entry.endedAt ? entry : { ...entry, state: "cancelled", endedAt: nowIso() });
    save({ ...me_record, attempts, state: "cancelled", pendingFirstTurn: false, completedAt: nowIso(), errorMessage: "Cancelled before a turn ran." });
    cancelOutcome({ action: "cancelled" });
    dropQueued("the job was cancelled");
    return releaseAndReturn({});
  };

  if (cancelRequested && TERMINAL.has(job.state) && cancelMessages.every(message => message.attempt !== undefined)) {
    cancelOutcome({ action: "nothing-to-cancel", state: job.state });
    cancelMessages.length = 0;
    cancelRequested = false;
  }

  if (queue.length === 0) {
    if (cancelRequested) {
      if (!TERMINAL.has(job.state)) {
        return cancelBeforeTurn();
      }
      cancelOutcome({ action: "nothing-to-cancel", state: job.state });
      return releaseAndReturn(me_record);
    }
    return { job: null, held: handOff() };
  }
  if (cancelRequested) {
    return cancelBeforeTurn();
  }

  // Begin an attempt: nonterminal state, attempt record and report ownership are written
  // before anything asynchronous, so readers and cancel see the new attempt at once.
  const beginAttempt = (item, extra = {}) => {
    // An earlier attempt with no end was the attempt of a worker that died: this worker holds the
    // lease, so no other runs it. It is closed here, so no attempt reads as running forever.
    const attempts = (Array.isArray(job.attempts) ? job.attempts : []).map(entry =>
      entry.endedAt ? entry : { ...entry, state: "dead", endedAt: nowIso(), errorMessage: entry.errorMessage ?? "the worker running this attempt died" });
    if (attempts.length > 0 && fs.existsSync(paths.report)) {
      fs.mkdirSync(paths.attempts, { recursive: true });
      fs.renameSync(paths.report, path.join(paths.attempts, `${attempts.length}-report.md`));
    }
    const attempt = {
      attempt: attempts.length + 1,
      source: item.source,
      automatic: Boolean(item.message?.automatic),
      messageId: item.message?.id ?? null,
      startedAt: nowIso(),
      relayVersion: PLUGIN_VERSION,
      turnId: null,
      state: "starting"
    };
    attemptOpen = true;
    activeTurnId = null;
    interruptSent = false;
    save({
      ...extra,
      launchPendingAt: null,
      ...(!item.message?.automatic && item.source === "continue" ? { recoveryEpoch: item.message.id } : {}),
      state: "starting",
      startedAt: job.startedAt ?? attempt.startedAt,
      completedAt: null,
      errorMessage: null,
      refusal: null,
      turnId: null,
      attempts: [...attempts, attempt]
    });
    if (item.message) {
      outcome(item.message, { action: "accepted-next-turn", attempt: attempt.attempt });
    }
    for (const queued of queue) {
      if (queued.message && !readOutcome(jobDir, queued.message.id)) {
        outcome(queued.message, { action: "queued-next-turn", reason: "an earlier turn runs first" });
      }
    }
    reportSkipped();
    return item;
  };

  const updateAttempt = (patch) => {
    const list = [...job.attempts];
    list[list.length - 1] = { ...list[list.length - 1], ...patch };
    save({ attempts: list });
  };

  const track = (promise) => {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise)).catch(() => {});
    return promise;
  };

  const settleInflight = async () => {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  };

  async function serviceTurnControls() {
    if (!connection || !sessionId || !turnActive || !connection.controlsReady(activeTurnId)) {
      return;
    }
    if (cancelRequested && !interruptSent) {
      interruptSent = true;
      try {
        await track(connection.interrupt(activeTurnId));
        cancelOutcome({ action: "interrupt-sent", turnId: activeTurnId });
      } catch (error) {
        cancelOutcome({ action: "interrupt-failed", reason: error.message });
      }
    }
    while (pendingSteers.length > 0 && turnActive && connection.controlsReady(activeTurnId)) {
      const message = pendingSteers.shift();
      const expectedTurnId = activeTurnId;
      const seq = (steerSeq += 1);
      try {
        const response = await track(
          connection.steer(expectedTurnId, message)
        );
        steered.set(message.id, message);
        const receipt = { turnId: response?.turnId ?? expectedTurnId, ...(response.promptId ? { promptId: response.promptId } : {}) };
        if (response.unconfirmed) {
          openSteers.set(message.id, { message, receipt, seq });
          confirmSteers();
          if (openSteers.has(message.id)) outcome(message, { action: "interject-queued", ...receipt });
        } else {
          outcome(message, { action: "steered", ...receipt });
        }
      } catch (error) {
        // Not taken by the turn (it ended, or cannot be steered): it becomes a next turn. A
        // request that may have reached the backend is checked against its history after a
        // death; one a live backend refused is ruled out at once.
        enqueue({ prompt: message.text, source: "steer", message, clientId: message.id, recoveryCandidate: true }, error.message);
      }
    }
  }

  // A steer the backend acknowledged without proof of delivery stays open
  // until the backend's persisted history shows it, then it is `steered`. When its turn has
  // ended (`final`), one the history does not show runs as the next turn; after a death, the
  // resumed-history check decides first whether it arrived.
  function confirmSteers(final = false) {
    for (const [id, open] of [...openSteers].sort(([, a], [, b]) => a.seq - b.seq)) {
      let held = false;
      try { held = Boolean(connection?.steerHeld?.(id)); } catch { held = false; }
      if (held) {
        openSteers.delete(id);
        outcome(open.message, { action: "steered", ...open.receipt });
      } else if (final) {
        openSteers.delete(id);
        connection.steerLost?.(id);
        enqueue({ prompt: open.message.text, source: "steer", message: open.message, clientId: id, recoveryCandidate: true },
          "the backend queued the steer, but its history does not hold it");
      }
    }
  }

  let current = beginAttempt(queue.shift(), me_record);

  const completeProbe = () => {
    if (slot?.probe && probeSucceeded(home, backend.name, job.id, admissionDeps, slot.probeGeneration)) {
      slot = { ...slot, probe: false, probeGeneration: null, probeAt: null };
    }
  };
  const heartbeat = setInterval(() => {
    save({});
    if (slot?.probeAt && (admissionDeps.now ?? Date.now)() - Date.parse(slot.probeAt) >= DEFAULTS.probeMs) completeProbe();
  }, config.heartbeatMs);
  heartbeat.unref?.();
  const poller = setInterval(() => {
    try {
      accept(claimInboxMessages(jobDir));
      if (openSteers.size > 0) confirmSteers();
      void serviceTurnControls();
    } catch {
      // Inbox trouble must not kill the worker; the next tick retries.
    }
  }, config.pollMs);
  poller.unref?.();

  const request = job.request;
  const writeEvent = notification => fs.appendFileSync(paths.events, `${JSON.stringify({ at: lastEventAt, ...notification })}\n`, "utf8");
  const touchEvents = () => { lastEventAt = nowIso(); };
  const eventRecorder = backend.eventRecorder(writeEvent, touchEvents);
  const connect = async () => {
    const attemptIndex = job.attempts.length - 1;
    let serverIndex;
    const record = (patch) => {
      const attempts = [...job.attempts];
      const attempt = { ...attempts[attemptIndex] };
      const servers = [...(attempt.servers ?? [])];
      servers[serverIndex] = { ...servers[serverIndex], ...patch };
      attempts[attemptIndex] = { ...attempt, servers: servers };
      save({ attempts });
    };
    return backend.connect(request, {
      state: job.backendState ?? {},
      saveState(patch) { save({ backendState: { ...job.backendState, ...patch } }); },
      env: { ...process.env, ...options.env },
      onSpawn(proc) {
        serverIndex = job.attempts[attemptIndex].servers?.length ?? 0;
        const identity = { pid: proc.pid ?? null, startTime: proc.pid ? readProcessStartTime(proc.pid) : null, startedAt: nowIso() };
        record(identity);
        save({ serverPid: identity.pid, server: identity.pid ? identity : null });
        appendStderr(paths.serverStderr, Buffer.from(`\n--- attempt ${attemptIndex + 1}, app-server ${serverIndex + 1}, pid ${identity.pid}, ${identity.startedAt} ---\n`));
      },
      onStderr(chunk) { appendStderr(paths.serverStderr, chunk); },
      onEnd(info) { record(info); },
      tap(notification) { eventRecorder.record(notification); }
    });
  };

  const waitForAdmission = async () => {
    for (;;) {
      if (cancelRequested) return false;
      const decision = admit({ home, jobId: job.id, jobDir, me, request: { ...job.request, backend: backend.name },
        waitingSince: job.admission?.state === "waiting" ? job.admission.since : null }, admissionDeps);
      if (decision.slot) slot = decision.slot;
      if (decision.admit) {
        touchEvents();
        save({ state: "starting", admission: decision.record });
        updateAttempt({ state: "starting" });
        return true;
      }
      if (job.state !== "queued" || job.admission?.reason !== decision.reason) {
        save({ state: "queued", admission: decision.record });
        updateAttempt({ state: "queued" });
      }
      await (options.admissionSleep ?? interruptibleSleep)(Math.min(decision.retryMs, config.admissionPollMs), () => cancelRequested);
    }
  };

  try {
    // The new worker and its attempt are recorded above, before any await, so a cancel or a
    // reader sees them at once. Before it starts an app-server, the worker stops every
    // app-server a predecessor left running, with its descendants. This one
    // place covers start, continue, resume, a steer that becomes a turn, relay delivery and
    // automatic recovery. A server that survives, or a sweep that cannot see the process
    // table, fails the job, and no second app-server starts beside it.
    const sweep = await stopRecordedAppServers(job, options.predecessorCleanup);
    if (sweep.servers.length > 0) {
      save(sweptAppServersPatch(job, sweep));
    }
    if (sweep.survivors.length > 0) {
      sweepFailed = true;
      const servers = sweep.servers.filter((server) => sweep.survivors.some((entry) => entry.pid === server.pid)).map((server) => `app-server pid ${server.pid}`);
      const others = sweep.survivors.filter((entry) => !sweep.servers.some((server) => server.pid === entry.pid)).map((entry) => `pid ${entry.pid}`);
      // The queued work stays owed: a later worker runs it once the old server is gone.
      throw new Error(`A previous worker's app-server is still running after the sweep (${[...servers, ...others].join(", ")}${sweep.cause ? `: ${sweep.cause}` : ""}); no new app-server was started.`);
    }
    await waitForAdmission();
    for (;;) {
      if (cancelRequested) {
        break;
      }
      try {
        connection = await connect();
        const opened = await connection.open({
          sessionId,
          sessionName: sessionId ? null : threadNameFor(job.id, current.prompt),
          // Whether a turn ever ran on this thread, so a backend can tell a lost draft from lost work.
          sessionUsed: Boolean(sessionId && job.attempts.some((attempt) => attempt.turnId))
        });
        sessionId = opened.sessionId;
        save({ sessionId, serviceTier: opened.serviceTier ?? null });
        // What the backend had to decide while opening is a `note:` in the state block, once.
        const openNotes = (opened.notes ?? []).filter((note) => !(job.request.notes ?? []).includes(note));
        if (openNotes.length > 0) {
          save({ request: { ...job.request, notes: [...(job.request.notes ?? []), ...openNotes] } });
        }

        // Messages that reached the thread before a previous worker died never run again.
        const alreadyInThread = item => connection.delivered(item);
        for (const item of [...queue]) {
          if (item.clientId && alreadyInThread(item)) {
            queue.splice(queue.indexOf(item), 1);
            if (item.source === "brief") save({ pendingFirstTurn: false });
            outcome(item.message, { action: "delivered-before" });
          }
        }

        for (;;) {
          if (current.clientId && alreadyInThread(current)) {
            // It reached the thread before the previous worker died. Do not run it again; give
            // its attempt to the next work, or ask for the report whose turn result was lost.
            outcome(current.message, { action: "delivered-before" });
            if (current.source === "brief") {
              save({ pendingFirstTurn: false });
            }
            const replacement = queue.shift() ?? { prompt: DEFAULT_RESUME_MESSAGE, source: "resume", message: null, clientId: newMessageId() };
            updateAttempt({ source: replacement.source, messageId: replacement.message?.id ?? null, replaces: current.message?.id ?? current.clientId });
            if (replacement.message) {
              outcome(replacement.message, { action: "accepted-next-turn", attempt: job.attempts.length });
            }
            current = replacement;
            continue;
          }
          {
            if (cancelRequested) {
              break;
            }
            turnActive = true;
            const capacityRetries = [];
            /** @type {import("../backends/types").TurnResult} */
            let result = null;
            let refusal = null;
            // What the next send carries: the current work, or, once a failed turn did work,
            // the resume message as a continuation on the same thread (never its input again).
            let dispatch = current;
            for (let retry = 0; ; retry += 1) {
              // A cancel during a retry's wait starts no further turn.
              if (retry > 0 && cancelRequested) {
                result = { ...result, turnStatus: "interrupted" };
                break;
              }
              if (!(await waitForAdmission())) {
                result = { ...result, turnStatus: "interrupted" };
                break;
              }
              try {
                result = await connection.run({
                  prompt: dispatch.prompt,
                  onPending() { save({ state: "running" }); void serviceTurnControls(); },
                  clientId: dispatch.clientId,
                  source: dispatch.source,
                  onTurnId(turnId) {
                    activeTurnId = turnId;
                    save({ state: "running", turnId, ...(current.source === "brief" ? { pendingFirstTurn: false } : {}) });
                    updateAttempt({ turnId, state: "running" });
                    if (current.message && readOutcome(jobDir, current.message.id)?.action !== "turn-started") {
                      outcome(current.message, { action: "turn-started", attempt: job.attempts.length, turnId });
                    }
                    void serviceTurnControls();
                  }
                });
              } catch (error) {
                result = { turnStatus: "failed", error: { ...error.data, message: error.message, data: error.data }, finalMessage: "" };
              }
              refusal = guardOn && result.turnStatus === "failed" ? classifyRefusal(backend.name, result.error) : null;
              if (refusal) {
                const pause = recordRefusal(home, backend.name, refusal, job.id, admissionDeps);
                save({ refusal: { backend: backend.name, kind: refusal.kind, code: refusal.code,
                  message: refusal.message, at: nowIso(), pausedUntil: pause?.until ?? null } });
              }
              // A backend that retries model calls itself marks its failures `retryable: false`.
              // Commentary does not stop a retry; work done decides how the retry is sent.
              const capacity = result.turnStatus === "failed" && (!refusal || refusal.kind === "rate") && result.retryable !== false && (result.capacity || isCapacityError(result.error));
              if (!capacity || retry >= config.capacityDelaysMs.length || cancelRequested) {
                break;
              }
              const delayMs = config.capacityDelaysMs[retry];
              const kind = result.didWork ? "continuation" : "resend";
              capacityRetries.push({ at: nowIso(), delayMs, kind, error: result.error?.message ?? String(result.error) });
              save({ capacityRetries: [...(job.capacityRetries ?? []), capacityRetries.at(-1)] });
              activeTurnId = null;
              if (kind === "continuation") {
                dispatch = { prompt: DEFAULT_RESUME_MESSAGE, source: "retry", message: null, clientId: `retry-${newMessageId()}` };
              }
              await sleep(delayMs, () => cancelRequested);
            }
            turnActive = false;

            // Every steer request in flight settles before the next decision; a steer the
            // turn did not take joins the queue.
            await settleInflight();
            while (pendingSteers.length > 0) {
              const message = pendingSteers.shift();
              enqueue({ prompt: message.text, source: "steer", message, clientId: message.id }, "the turn ended before the steer was delivered");
            }
            confirmSteers(true);
            // An accepted steer the backend lost with its server runs as the next turn; one the
            // backend may still hold is dropped, never sent twice.
            for (const id of result.unjoinedSteers ?? []) {
              const message = steered.get(id);
              if (message) enqueue({ prompt: message.text, source: "steer", message, clientId: message.id }, "the backend accepted the steer but lost it before a turn took it");
            }
            for (const { id, reason } of result.droppedSteers ?? []) {
              const message = steered.get(id);
              if (message) outcome(message, { action: "dropped", reason });
            }

            if (result.turnStatus !== "completed" && !refusal && connection.server.exitInfo) {
              throw new Error(backend.endMessage(connection.server.exitInfo));
            }

            const finalMessage = String(result.finalMessage ?? "");
            let state;
            let errorMessage = null;
            if (result.turnStatus === "completed") {
              completeProbe();
              state = "completed";
            } else if (result.turnStatus === "interrupted" && cancelRequested) {
              state = "cancelled";
              errorMessage = "Cancelled.";
            } else {
              state = "failed";
              errorMessage =
                result.error?.message ||
                (result.turnStatus === "interrupted" ? "The turn was interrupted." : `The turn ended with status ${result.turnStatus ?? "unknown"}.`);
            }
            const hasReport = Boolean(finalMessage.trim()) && (state === "completed" || Boolean(result.completionReadError));
            if (hasReport) {
              writeFileAtomic(paths.report, finalMessage.endsWith("\n") ? finalMessage : `${finalMessage}\n`);
            }
            // A teardown is decided in the same write that fails the attempt: the attempt names the
            // delivery it gives up, and a brief stops being owed, so a crash after this write can
            // never send it again (honourTeardowns rebuilds the rest).
            const teardown = result.teardown ? { clientId: dispatch.clientId, messageId: current.message?.id ?? null, source: current.source } : null;
            const attempts = [...job.attempts];
            attempts[attempts.length - 1] = {
              ...attempts.at(-1),
              turnId: result.turnId ?? activeTurnId,
              ...(result.completionInference ? { completionInference: result.completionInference } : {}),
              endedAt: nowIso(),
              state,
              ...(errorMessage ? { errorMessage } : {}),
              hasReport,
              ...(teardown ? { teardown } : {})
            };
            save({ attempts, errorMessage, turnId: result.turnId ?? activeTurnId, ...(teardown?.source === "brief" ? { pendingFirstTurn: false } : {}) });
            activeTurnId = null;
            if (state === "cancelled") {
              break;
            }
            // The backend may still hold the prompt: it is not sent again, and nothing more goes
            // to this server. Work still queued stays owed.
            if (teardown) {
              honourTeardowns();
              break;
            }
          }

          // Decide, with no await between the last claim and the decision.
          accept(claimInboxMessages(jobDir));
          pruneDefaultResumes();
          if (cancelRequested || queue.length === 0) {
            break;
          }
          current = beginAttempt(queue.shift());
        }

        break;
      } catch (error) {
        accept(claimInboxMessages(jobDir));
        // The process exited and the connection is still draining its pipes: wait for the end
        // record, which the connection completes within its drain time.
        if (connection?.server.exitSeen && !connection.server.exitResolved) await connection.server.exitPromise;
        if (cancelRequested) break;
        // connect can fail before it returns a connection. Its onEnd record still exists.
        const end = connection?.server.exitInfo ?? job.attempts.at(-1).servers?.at(-1);
        if (!end?.endedAt) throw error;
        const transportErrors = [...(job.attempts.at(-1).transportErrors ?? []), backend.endMessage(end)];
        updateAttempt({ transportErrors });
        if (!sessionId || transportErrors.length > 1 || recoveryForEpoch(job)) throw new Error(transportErrors.join("\n"));
        const recovery = { id: newMessageId(), epoch: job.recoveryEpoch ?? "start", at: nowIso(),
          fromAttempt: job.attempts.length, reason: "app-server", state: "launched" };
        save({ automaticResumes: [...(job.automaticResumes ?? []), recovery], state: "starting", turnId: null });
        updateAttempt({ state: "starting" });
        await connection?.close();
        connection = null;
        activeTurnId = null;
        turnActive = false;
        interruptSent = false;
        // A resume may have died before the current user message reached the thread.
        // Keep that message owed, and deduplicate it against the resumed history.
        if ((current.message && !CLOSED_ACTIONS.has(readOutcome(jobDir, current.message.id)?.action)) ||
            (current.source === "brief" && job.pendingFirstTurn)) queue.unshift({ ...current, recoveryCandidate: true });
        // The automatic prompt has its own id.
        current = { prompt: DEFAULT_RESUME_MESSAGE, source: "resume", message: null, clientId: recovery.id };
        if (!(await waitForAdmission())) break;
      }
    }

    clearInterval(poller);
    const last = job.attempts.at(-1);
    if (cancelRequested) {
      if (last && !TERMINAL.has(last.state)) {
        updateAttempt({ state: "cancelled", endedAt: nowIso() });
      }
      save({ state: "cancelled", errorMessage: "Cancelled.", completedAt: nowIso() });
      cancelOutcome({ action: "cancelled" });
      if (current.message && !CLOSED_ACTIONS.has(readOutcome(jobDir, current.message.id)?.action)) {
        outcome(current.message, { action: "dropped", reason: "the job was cancelled before this turn ran" });
      }
      dropQueued("the job was cancelled");
    } else {
      save({ state: last?.state ?? "failed", errorMessage: last?.errorMessage ?? null, completedAt: nowIso() });
    }
    attemptOpen = false;
  } catch (error) {
    clearInterval(poller);
    const message = error instanceof Error ? error.message : String(error);
    const last = job.attempts.at(-1);
    if (last && !TERMINAL.has(last.state)) {
      updateAttempt({ state: "failed", endedAt: nowIso(), errorMessage: message });
    }
    // Messages still queued stay owed: the next worker runs them.
    save({ state: "failed", errorMessage: message, completedAt: nowIso() });
  } finally {
    clearInterval(heartbeat);
    clearInterval(poller);
    // The connection reads the server's output to its end as it closes. A turn can end on the
    // backend's record before the worker has read the updates the server sent ahead of it, so
    // the events are flushed only once the connection has closed.
    try {
      if (connection) {
        await connection.close().catch(() => {});
        connection = null;
      }
      eventRecorder?.flush();
    } finally {
      if (slot) releaseSlot(home, job.id, me, admissionDeps);
      slot = null;
    }
  }

  return releaseAndReturn({});
}
