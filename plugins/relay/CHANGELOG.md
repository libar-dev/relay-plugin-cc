# Changelog

## 3.0.0 (unreleased)

The Mods plan ([docs/mods/plan.md](../../docs/mods/plan.md)), Phases 1 to 5 and Phase 6's report, built
on the branch `release/3.0` ([docs/mods/release-3.0.md](../../docs/mods/release-3.0.md)). Each phase adds
its entries here.

Changed:

- Foreground `task` workers run independently of the caller; Ctrl-C leaves a dispatched job running.
- Jobs own their execution groups and stop their tools at backend loss, cancellation and completion.
  Linux workers use per-job scopes whenever a user manager is available, and set OOM score 500.
  Job and guard status show memory used by relay jobs and their processes.
- Load guard errors hold new starts with the error and explicit off switch in the queue reason.
  `RELAY_ADMISSION=off` and `/relay:setup --admission off` still bypass the guard.
- Provider pauses follow the account home used by each worker attempt, including resumed jobs.
  Pause status identifies the account. Grok recognizes explicit usage exhaustion,
  rate-limit text and provider 429 errors; its usage classifier is not yet verified against a live exhausted account.
  Admission pauses do not bound requests or retries inside running turns.

Fixed:

- Terminal result text omits live memory accounting, keeping verbatim relay hand-backs stable
  while the backend closes and cleanup releases its memory.
- macOS cleanup excludes its own process-table sampler, so an empty worker group no longer
  reports a phantom surviving process and fails before starting the backend.

- Worker launch reservations no longer hold the admission lock across startup. Failed or interrupted
  handoffs retry through plain `wait`; native Windows keeps detached launches with visible guard and
  execution-group bypasses.
- Scope ownership checks boot and inode identity. Cleanup tracks children of escaped tools, preserves
  nested jobs, and reports unresolved job-end cleanup without changing completed or cancelled states.
  Accounting failures preserve worker liveness and backend exit records; Kimi expires old reports while
  retaining delivery evidence.

- Replacement backends and slot release wait for process cleanup, including sampled detached tools.
  Cleanup failures keep surviving processes counted. Cancelling terminal jobs also cleans leftovers.
- Every worker leaves its caller's descendant tree before dispatch acknowledgement, including dispatch
  from long-lived waiters, hooks and recovery; launch provenance and interrupted handoffs are recorded.
- Backend close escalates TERM to KILL within a bounded window. Transport messages over 64 MiB close
  the connection; Kimi history replay uses bounded reads and prunes old turn and prompt state.
- Cancellation checks the attempt before its sweep, counts every verified signal, and can stop a
  verified worker despite an unreadable child. Unknown members require verified group ownership.
  Successor heartbeats no longer extend the predecessor's ownership bound.
- Damaged slots count conservatively until quarantine; a damaged job slot cannot reuse a seat.
  Damaged pauses and pending refusals hold the affected account or backend for at most 15 minutes
  before quarantine. Refusals saved during admission-lock contention retain their original receipt
  time and provider reset, so replay does not restart expired pauses.
- Guard errors preserve finished jobs with empty inboxes. Repeated atomic-write errors use a stable
  queue reason and one diagnostic per message change.
- Only currently held seats are reused. Slotless live jobs count toward the worker minimum, and
  worker deferrals retain their original cause after admission. Clock corrections preserve startup
  holds and pacing. A live provider probe cannot expire just because it is old.

Pre-release cuts:

- `3.0.0-pre.1` (2026-10-22, tag `v3.0.0-pre.1`): Phases 1, 2, 3 and 5 and Phase 6's report, as below; Phase 4
  has not landed.
- `3.0.0-pre.2` (2026-10-23, tag `v3.0.0-pre.2`): what it fixes and changes over pre.1. The details are in
  "Phase 4" and "Fixes from the pre-releases" below.
  - A line typed into a relay's own agent view in the terminal reaches the job; in pre.1 it was lost (pre.1's known
    issue 1). While the relay waits, the line can take up to nine minutes to arrive; a message sent through Claude
    still arrives within seconds. After the hand-back, type only while the agent's view stays open: from Claude Code
    2.1.309 a finished agent leaves the list within about 15 s, and then a continue goes through Claude.
  - A relay that hands back the job's block inside one plain code fence is accepted, no longer blocked eight times
    and let go as `not handed back` (known issue 2). A relay that keeps writing prose instead of the block, as one
    did once after the message `cancel`, is still let go after eight blocks. A relay that a message resumes after its
    hand-back must hand back the result again, where pre.1 let its own words through as the result.
  - A job cancelled with TaskStop is no longer marked `not handed back` (known issue 3).
  - `/relay:setup` asks Grok a second time before it says a home is signed out, and shows Kimi as
    `steer (next turn)` (known issue 4).
  - Text given to `/relay:review`, `/relay:adversarial-review` or `/relay:setup` no longer runs in Claude's shell
    when it holds backticks, `$(…)` or `$VAR`: Claude writes it to a temporary file with its Write tool, and relay
    reads it as written. So none of the three expands `$HOME` or another variable any more: use `~/` or a full path.
    Setup no longer expands globs either; its quotes group spaces, and a backslash escapes the next character even
    inside quotes, so a literal backslash is written twice. Not yet checked live: these commands in default permission mode (Claude may
    ask before its Write), under the sandbox, and with `--background`. The shell commands relay suggests after an
    error or for a sign-in quote what they carry.
  - The companion's `--json` changed in place, for Phase 4's status line and board, which come in a later cut. A
    script that reads it must change: `status --json`, with or without `--all` or `--workflow`, returns slim rows,
    50 a page, newest first (follow `nextCursor` with `--cursor`; `status <job> --json` has the full record), and a
    `--json` error is JSON on stdout, not text on stderr.
  - Still open: `/relay:transfer` takes no job id (known issue 5).
- `3.0.0-pre.3` (2026-10-23, tag `v3.0.0-pre.3`): what it adds and fixes over pre.2. The details are in "Phase 4",
  "Load guard" and "Fixes from the pre-releases" below.
  - **Load guard.** Before a job starts, and before each later turn, relay checks the machine:
    - A job starts only while enough memory stays free after it starts. The jobs that started in the last 30 s
      count toward that.
    - Starts are spaced 5 s apart across all sessions.
    - At most 2 very heavy models run at once. That is a quota limit.
    - A backend pauses after its provider refuses work for a usage limit, rate limit or concurrency limit.

    A job that has to wait shows `queued` with the reason. Running turns are never stopped.
    `RELAY_ADMISSION=off` or `/relay:setup --admission off` turns the guard off. Only while the guard is on,
    Kimi defaults to 3 total attempts per step unless you set `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`; this default
    does not apply with the guard off or on native Windows. Restart Claude sessions after upgrading: a session
    still on pre.2 doesn't know the `queued` state.
  - **The status line and the board** (Phase 4). One line under the prompt counts the repository's running and
    dead jobs and owed messages, and the board lists jobs with their actions.
  - **A person's stop names the job.** When a person stops a relay from Claude Code's controls, relay now says
    that the relay's job keeps running, and which job it is. `TaskStop` and the message `cancel` still cancel it.
  - **A Workflow relay keeps to its job.** Claude Code 2.1.309 shows a Workflow agent the lead's request as "user
    request". The relay is told that this request is not its task, so it runs its three commands. In pre.2, 2 of
    40 relays in a soak refused their job; pre.3's soak had 0 refusals in 80 relays.
  - Still open: after a continue sent to a job directly, the job shows `not handed back` although no relay waited
    for it, and `/relay:transfer` takes no job id.
- `3.0.0-pre.4` (2026-10-23, tag `v3.0.0-pre.4`): one fix over pre.3.
  - **The load guard reads macOS memory the way macOS does.** pre.3 counted only free and inactive pages, so on a
    healthy Mac it held light jobs back: in a soak on an 18 GiB Mac, about half as many ran at once as on pre.2,
    and jobs waited 76 s at the median. Available memory is now macOS's own free percentage times total memory,
    with free and inactive pages as a labelled fallback. The pressure check is unchanged: a warning holds new
    jobs, critical also holds next turns. Linux is unchanged.
- `3.0.0-pre.5` (2026-10-23, tag `v3.0.0-pre.5`): what it changes over pre.4. The details are in "Load guard".
  - **Only Astra and the Kimi K3 family count toward the very-heavy quota,** at any effort. `max` effort on other
    models (Sol, Luna, Kimi K2.x, GLM, Grok) no longer does.
  - **The guard holds its lock briefly however many old jobs there are,** and an unreadable job record no longer
    turns the guard off.
  - **A probe whose lease times out no longer counts as provider success,** so the pause and its strikes stay.
  - **A macOS pressure warning reads as a warning,** not "critical", in status and in the waited line.
  - **An admitted job keeps the reason it waited,** and a job cancelled while queued closes its admission record
    in `status --json`.
- `3.0.0-pre.6` (2026-10-24, tag `v3.0.0-pre.6`): what it changes over pre.5. The details are in "Load guard",
  "Fixes from the pre-releases" and "Docs".
  - **The load guard has a guaranteed minimum again, and no very-heavy maximum.** The first two very-heavy jobs
    (GPT-6 Astra, the Kimi K3 family) and the first three other jobs skip the host reserve and the busy-seat
    allowance; only critical machine states, their own startup allowance, scope limits, provider pauses, ordering
    and start pacing still hold them. More very-heavy jobs start like any other job. `--max-very-heavy` is removed.
  - **A macOS pressure warning no longer holds anything;** critical pressure still does.
  - **Turns of a running job are no longer paced and take no new memory hold;** only critical states and provider
    pauses hold them. Replacement backends still pass the start checks.
  - **The hand-back hint names the first line that differs,** outside the text the relay is told to copy.
  - **The skills, agent text and a new user guide** describe Workflow jobs, queued work, the guard and setup as they
    work now. `/relay:setup` writes its snapshot without a shell redirect, so it no longer prompts in manual mode or
    fails in `dontAsk` mode.

Phase 1, steer wake:

- A message to a running `relay:job` agent started with the Agent tool reaches the job within seconds. The
  plugin has a hooks module, `hooks/mod/register.js`, with one `session.send` hook: when a message is sent to
  a relay, from the main thread, a subagent or another plugin, it runs `companion wake`, and the relay's
  current wait returns. The guard then delivers the message as before. Until now a message waited for the wait
  to end, up to two minutes.
- A relay waits on its job in steps of up to 540 s (Bash timeout 600 s) instead of 120 s, so a long
  job costs its Haiku relay about a quarter of the model calls.
- A `SendMessage` from another agent, such as an orchestrator subagent or a Workflow agent, now
  reaches the job of a relay the Agent tool started, while it runs and after it ended. The guard took
  only the main thread's messages; Claude Code marks another agent's as `peer`, and the guard dropped
  it without a record. The Phase 1 live check found it. A relay that lived through the update delivers
  the peer messages it received before it, since none of them has a delivery record. A message to a
  relay that a Workflow script started is another matter: see "Fixes from the pre-releases".
- Needs Claude Code 2.1.307 or later, for the module's `session.send` event.

Phase 2, commands answered by the module:

- `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` start no model turn and cost
  no tokens. The hooks module answers each with a `command.run` hook that runs the companion and
  shows its output: the command as typed (Claude Code shows such a command without its arguments),
  the companion's own lines in a code block, exactly as printed, then a job's report as Markdown or
  the job list as a table. Until now a model ran the command and retold its output. A headless
  `claude -p "/relay:result <job>"` exits with the companion's exit code (not under
  `--output-format stream-json`, where Claude Code exits 0).
- `C status` prints the job list as a Markdown table with a header row (job, state, kind, backend,
  model/effort, duration, summary, relay); every row names its backend, Codex included. It replaces
  the two-space-separated lines, and is the list `/relay:status` shows. Its header names the relay
  version (`relay-version:`), with the commit for a build `scripts/smoke/install-local.sh` installed. `--json` is unchanged.
- Claude no longer calls `/relay:status` and `/relay:result` itself: a model's call of a command
  never reaches the module. It reads jobs with `C status` and `C result` in Bash, which print the
  same text; in `default` permission mode Claude Code asks before that Bash call.
  `Skill(relay:status)` and `Skill(relay:result)` in `permissions.allow` have no use any more.
- `transfer` finds the session's file by the session's id (`RELAY_COMPANION_SESSION_ID`), in the
  project folders of `~/.claude/projects`; `--source` still takes a file. The SessionStart hook no
  longer exports `RELAY_COMPANION_TRANSCRIPT_PATH`.
- The live suite has checks for the commands: `commands` (status, result and cancel on each backend,
  in the terminal and in T3), `transfer`, and `headless` (`claude -p`, `num_turns: 0`).

Phase 3, spawn and stop like a Claude agent:

- **`TaskStop` on a `relay:job` agent cancels its job.** A `PostToolUse` hook on `TaskStop` runs
  `companion cancel` for the job of the relay it stopped, and the TaskStop result comes with the
  cancelled job's block. Until now TaskStop stopped only the relay, and the job ran on. A relay that
  ends any other way (the Claude session ends, its process is killed, its Workflow is stopped) still
  leaves its job running, so a `resumeFromRunId` after a stopped Workflow still adopts its jobs; a
  TaskStop on a Workflow comes back with the list of its jobs that keep running. A cancel the hook
  could not finish is told to the caller and shown as a `relay-violation:` line. The
  message `cancel` still cancels a job and lets its relay hand back the cancelled state. TaskStop has no
  task for one agent of a Workflow, except a second loop that a message to it started; cancel such a job
  with `C cancel <job>`.
- **A bad header fails at the spawn.** The hooks module has an `agent.spawn` hook: before a
  `relay:job` agent starts, it runs the new `companion check-header`, the parser and request
  builder `start` uses, and refuses the spawn with the parser's message. The Agent call fails, or a
  Workflow script's `agent()` throws, at once (`Subagent spawn denied by a plugin: <reason>`).
  Until now a relay started, its start failed, and the relay handed the error back. `start` keeps
  every check, and checks relative `cd:`, `add-dir:` and `brief:` paths alone, since the relay's
  directory is not known at the spawn. A Workflow script that runs agents in `parallel` should catch
  the error per call.
- A relay never hands Claude Code's interrupt note (`[Request interrupted by user for tool use]`) to its job.
  A relay stopped by TaskStop that ran again, resumed by a message or as a Workflow relay's second loop, handed
  it over, and on a cancelled job that restarted the job.
- The live suite has three more checks: `stop` (TaskStop cancels the job within 15 s), `session-end`
  (the job runs on after the Claude session ends, terminal only) and `spawn-check`.

Phase 4, the companion's JSON, changed in place (the status line and the board read it):

- **Every `--json` output names its shape and build.** It is one object whose first fields are `schema`
  (`relay.<command>/1`), `relayVersion` and `relayBuild` (the commit of a smoke install, else null). Under
  `--json` an error is JSON on stdout too, `{ …, error: { kind, message } }`, with `kind` `busy` (exit 4, as
  before), `not-found`, `usage`, `attempt-changed` or `error`, and nothing a reader needs goes to stderr. A script
  that read a `--json` error from stderr reads it from stdout now.
- **`status --json` lists pages of slim rows.** Rows leave out `attemptRecords` and `server`, carry a short relay
  binding and one-line errors, cut every string to 300 characters, keep a few entries of each list (owed, dropped,
  recovered, violations) with its full count, and come newest first, 50 a page (`--limit N`, up to 200, and never past 2 MiB), with `nextCursor` for
  `--cursor`; `--active` lists only jobs that are starting, running or dead, or owe messages. `--all` and
  `--workflow` page the same way. Until now the listing held every field of every job, `--all` and `--workflow`
  every job: 1.29 MB for 473 jobs. `status <job> --json`, `result`, `wait` and `cancel` keep every field. The text
  listing is unchanged.
- Every job in the JSON names its `backend`, Codex included; before, a missing `backend` meant Codex.
- One job's JSON adds `messages` (every message to the job, with its stage, a one-line preview, the relay's
  transcript entry that carried it, and its outcome: how the backend took it), `openMessages`, `notHandedBack`,
  `hasReport`, `updatedAt`, `claudeSessionId` (the Claude Code session the job was started from) and
  `relay.lastToolAt` (the relay's last tool call). `steer`, `continue` and `resume` add `job`; `start` and `task`
  add `backend`.
- `cancel --attempt N` cancels the job only while attempt N is current, so a cancel meant for one attempt never stops
  a newer one that a continue or an automatic recovery started; it then says `attempt-changed`. Once attempt N is
  stopped, a newer attempt a message starts runs on.
- A job cancelled before its first turn ran no longer runs its brief when its first worker comes up late.
- Automatic recovery waits while a `cancel` command runs on the job. A worker that died while a cancel was under
  way, or that the cancel killed, could be resumed by its relay's wait and meet the cancel again; the relay now sees
  the job end `cancelled`.
- A `TaskStop` that cancelled a job records its hand-back, since the TaskStop result carried the cancelled block:
  `status` no longer marks such a job `not handed back`.
- The stop-time review gate reads the new JSON. `check-header` keeps its text answer.
- The live suite's `stop` check requires the hand-back record.

Phase 4, the status line:

- The terminal shows a status line under the prompt while the repository has jobs to tell about:
  `relay: 2 running · 1 dead · 3 owed`. Running counts starting and running jobs, dead counts jobs whose worker
  died (`resume` continues them), owed counts messages a job acknowledged and has not run. The hooks module reads
  `status --json --active` every five seconds while a count shows, every thirty while the line is cleared, and every
  five for thirty seconds after it sees a relay start, a wake, one of its commands or a busy read. A busy read keeps
  the line; a failed one shows `status unavailable`. Where nothing draws the session (an Agent SDK host such as T3
  Code), it runs no process.
- The live suite has a `status-line` check (terminal only): the line shows one running job per backend, then clears
  after the cancel. The runner answers the folder trust dialog in two steps (Down, then Enter once "Yes" is
  selected) and again when a key was lost, presses Enter again while the lead's pasted prompt sits unsent, and
  refuses a run where an installed copy of the plugin loaded its hooks module beside the build under test.
- A recovery test that took up to 219 s on a loaded machine shortens its cleanup's cancel grace.

Phase 4, the board:

- `/relay-board` opens a pane of the repository's jobs in the terminal: each job's backend, state, attempt, owed
  messages and flags (`not handed back`, `relay lost`, violations), and for the selected job its model, relay,
  messages with how the backend took each, and report. **Steer** (`Queue next turn` on Kimi) and **Continue** go by
  the relay, as the lead's `SendMessage`, for an Agent-tool relay of this session that is alive (and a continue of
  its ended job by its finished relay), and to the job directly otherwise (a Workflow job, another session's job, a
  job with no relay or a silent relay). **Cancel** asks
  again and cancels the attempt it named. The command has no colon: Claude Code refuses one in a command a module
  registers. Known limit: after a continue sent to the job directly, the job shows `not handed back` although no
  relay waited for that attempt; its report is in `result`.
- In the terminal the pane takes keys only between the lead's turns; in the fullscreen layout
  (`CLAUDE_CODE_NO_FLICKER=1`) it takes clicks at any time.
- The live suite has a `board` check (terminal only): in a wide fullscreen session it steers, continues and cancels
  Agent-tool and Workflow jobs on every backend by clicks, and in a narrow one it selects a job by keys; every action
  is judged by the job's files.

Phase 5, the live suite (development tooling; the plugin itself does not change):

- `scripts/live/suite.mjs` runs live checks against the real backends, in the terminal and in T3 Code, and
  writes one record per check and backend to `docs/live/records/`. `docs/live/capabilities.md`, generated from
  the records, shows what the suite has passed on each backend and surface. It replaces
  `scripts/live/steer-wake.mjs`.
- The checks so far: a steer from the main thread, from a Workflow agent and from another plugin's
  `$.session.send`, and a continue after the hand-back, on all four backends. A steer passes only when the job's
  record shows how the backend took it: into the running turn on Codex, Grok and ZCode, as the next turn on Kimi.

Phase 6, an investigation (the plugin does not change):

- [docs/mods/messages-from-a-job.md](../../docs/mods/messages-from-a-job.md) reports what Codex, Grok, ZCode and
  Kimi allow for a job that sends a message to the agent that started it, or to a peer, and how such a message
  and its reply would travel. Messages from a job are not part of 3.0.

Load guard:

- `3.0.0-dev.17`: macOS pressure warning reads as `warning`; critical stays `critical`. Warning and load above
  `3C` still hold only new jobs, and shared pacing stays 5 seconds.
- Only Astra and the Kimi K3 family count as very heavy; max effort on other models no longer does.
- Admission history keeps its last queue cause and shows it beside the completed wait duration. Cancellation
  closes waiting records; JSON views also close stale waiting records for ended jobs without changing stored history.
- Historical job records are parsed outside the admission lock and cached until their file changes. Potentially
  live jobs and unended servers are rechecked under the lock, preserving seat accounting.
- Probe startup timeouts release only the fenced claim, retaining the provider pause and strike history. An
  active turn still uses the existing probe window; a completed turn can clear its matching pause.
- Deferred spawn failures leave work queued and report a retry note instead of aborting wait or relay hooks.
  Short-lived spawn callers now report a persisted stuck admission lock with its holder and off switch.
- Background tasks report their actual queued state. Setup sizes its busy allowance and worker cap from the
  same machine reading as the guard. Recovered settings omit transient diagnostics from saved config.
- Synthetic readings require a test process and the explicitly named test override; admission fixtures isolate
  inherited guard settings and skip unsupported-platform foreground queue cases. The README documents small-host
  impossible fits and the off switch; the jobs skill clarifies the state list.
- `3.0.0-dev.16`: on macOS, available bytes now use the `kern.memorystatus_level` percentage of total memory,
  so reclaimable memory counts toward admission. `vm_stat` free plus inactive pages remains a labelled fallback
  when that reading fails. The separate pressure veto, reserve, holds, pacing and quota are unchanged.
- Before a job starts, and before each later turn, relay checks the machine it runs on. It covers every session
  and jobs home of the user. The README's "Load guard" section has the rules and their defaults.
  - Memory: new backend starts and replacements outside the minimum need
    `available − recent starts’ holds − this job’s hold ≥ max(2 GiB, 15% of RAM)`.
    Holds are 0.5 GiB for Codex/Grok and 1 GiB for Kimi/ZCode/unknown, for 30 s.
    Finite Linux cgroup limits are tested separately. macOS uses `kern.memorystatus_level`
    times total memory, with `vm_stat` free plus inactive pages as a fallback.
  - Pacing: one new backend start or replacement every 5 s across sessions. Retained turns
    are not paced, take no new hold, and wait only for critical memory/pressure or provider pauses/probes.
    Healthy hosts have no fixed ceiling; busy-load/unknown-byte seats use `min(16, max(2, CPUs − 2))`.
  - Minimum: the first two identified very-heavy and first three other active jobs skip the host
    reserve and busy-seat allowance, subject to critical checks, startup allowance, scope/fit limits,
    provider protection, ordering and start pacing. There is no very-heavy maximum. Astra and Kimi K3
    are very heavy at any effort; effort alone on other models never enters that pool.
  - Provider refusals: recognized Codex/Grok/Kimi/ZCode usage or rate errors, and Kimi concurrency refusals,
    pause that backend account. A pause does not resume the failed job. After the pause, one
    probe job goes first. Only while the guard is on, Kimi defaults to 3 total attempts per step unless
    `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` is set; this default does not apply with the guard off or on native Windows.
- A job that waits shows `queued` with its reason in status, `--json`, the status line and the board, and can be
  cancelled. Critical load holds new starts and replacements. A macOS pressure warning holds nothing. Critical memory
  and critical macOS pressure also hold next turns. A turn that is running is never stopped. Foreground reviews pass the same check.
- When too many workers already wait, a new job is recorded `queued` without a worker. The submitter's `wait` (a
  relay agent's or yours) starts it later; `status` only reads.
- `RELAY_ADMISSION=off`, or `/relay:setup --admission off`, turns the guard off. On native Windows the guard does
  nothing and says so.
- Not covered: memory used later by commands a job runs (tests, builds), native Claude agents, other harness
  sessions and other users. The research behind the defaults is in
  [docs/research/resource-budgets-and-load-guard.md](../../docs/research/resource-budgets-and-load-guard.md).

Fixes from the pre-releases:

- Cancelling a dead job leaves a reused worker pid alone. Surviving members of its original process group
  are stopped by their saved identities after the group is tied to a heartbeat or recorded backend; live-worker
  termination rechecks the worker identity before signalling. Unreadable process identities leave cleanup incomplete.
- A message ZCode reports as already held keeps its original command id. Relay adopts its session turn when it
  starts, or fails after 60 seconds with an explicit not-delivered reason; it never resends an uncertain duplicate.
  Only an explicit discarded-on-restart response permits a fresh id.
- An accepted ZCode steer stays `interject-queued` and owed until session events show it joined a turn. After a
  worker death, resumed history confirms delivery or the steer runs once as a turn. A steer reported dropped is
  closed before the worker considers unconfirmed steers for another turn.
- When a relay retypes a job's block with a changed line, the hand-back guard names the first differing line before
  repeating the exact result. This helps correct a `dir:` line copied from `report:`; the result format, matching
  rules and eight-block budget are unchanged. Not yet checked live: whether a Haiku relay corrects the line when told.
- A Workflow relay is told that the harness's "user request" is the lead's request to the whole Workflow, not its
  task, and that the "computed task" is the job's brief: it runs its three commands whatever the request says. The
  agent and hook instructions and its block reasons say `${CLAUDE_PLUGIN_ROOT}` in those commands is typed as written
  and the hook fills in the path. The guard's commands, matching, hand-back checks and eight-block budget are unchanged.
  Not yet checked live: a Workflow soak with these instructions (pre.2's soak had 2 refusals in 40).
- When `/relay:status`, `/relay:result`, `/relay:cancel` or `/relay:transfer` fails, the shell command its answer
  names single-quotes the plugin's path and what you typed, one shell word each, so it passes the companion the
  same arguments as the hooks module's own call. A job id or `--source` path with backticks, `$(...)` or quotes now
  runs nothing when the line is pasted into a shell; with a line break in what you typed, the command is shown in a
  fenced block, which Markdown leaves as written.
- `/relay:setup` asks Grok's `grok models` a second time, a second apart, before it says a home is signed out: a
  signed-in home once answered "You are not authenticated" and then signed in.
- `/relay:setup` shows Kimi as `steer (next turn)`, not as having no steering: a message to a running Kimi job is
  taken as its next turn. The command tells Claude so, and `companion setup`'s text says it in Kimi's `can:` line.
  The JSON's `can.steer` is unchanged, and still means steering the running turn.
- `/relay:status`'s argument hint names `--workflow <run>`.
- **A line the user types into a `relay:job` agent's view reaches the job.** Claude Code in the terminal lets
  a person open a running agent's view (↓ in the footer, then Enter) and type at `Message @<agent>…`; the
  Desktop app's agent view has no input. Claude Code
  marks such a line as origin `human`, and the guard took only the main thread's and other agents'
  messages, so it dropped the line without a record. After the hand-back the line resumed the relay, the
  job got no turn, and the relay could say it had passed the message on. Now the line is delivered like
  any message: steered while the job runs, a new turn once it has ended, and `cancel` cancels the job.
  No hook names a typed line's recipient, so there is no wake: a line typed while the relay waits
  reaches the job at the relay's next step, at most nine minutes later, or as a new turn when the job
  ends first. A line typed after the hand-back arrives at once in a view that is still open (from Claude Code 2.1.309 a finished agent leaves the footer's list within
  about 15 s unless its view is open; once it has left, a continue goes through Claude's `SendMessage` or
  `C continue`). A relay that lives through the update
  delivers the lines it received before, since none of them has a delivery record.
- A line typed right after Esc interrupted the relay in its view resumes the relay and reaches the job
  at once, steering it while it runs.
- A relay that a message resumed after its hand-back must hand back the job's result again; while the
  hook can check it, the relay can no longer end with words of its own. (The block budget, a failing
  hook and a relay whose start failed stay as they were.)
- A relay without `SubagentHandback` whose final message is the exact result inside one code fence is
  no longer blocked: the fence, with no tag or a plain one such as `text`, `markdown` or `yaml`, is ignored. A Haiku
  relay had sent the result fenced nine times and been let go after eight blocks, with no recorded hand-back.
  A Workflow relay's state block may carry the same one fence, and no fence line anywhere else.
- A message of an origin the guard does not know is recorded as a `relay-violation:` line instead of
  being dropped in silence (the harness's own `task-notification` notices are skipped), and the same
  transcript problem is recorded once, not again at every hook call.
- The live suite has a check `typed` (terminal only: T3 Code draws no agent view).
- Arguments that held backticks, `$(…)` or `$VAR` ran in Claude's shell before the companion started.
  `/relay:review`, `/relay:adversarial-review` and `/relay:setup` use `Write` to put raw arguments in
  a private temporary file. Only its path enters the shell, and a review removes the file as soon as
  it reads it. Background reviews and setup's rerun use the same route. Output and exit codes are
  unchanged.
- Review-size estimation runs in the companion with the review's target and merge-base rules.
  Clean `auto` includes branch changes. The estimate prints the target, file count, untracked count
  and shortstat. It starts no backend or job. Invalid or option-like bases are refused.
- Setup uses the review commands' single-string parser. Variables, command substitutions and globs
  are literal. Quotes group whitespace. Backslash escapes even inside quotes; double literal
  backslashes. Empty quoted values are missing-value errors. Use absolute or `~/` paths.
  Commands with `--cwd` also accept `~/` and bare `~`. NUL is rejected. Long input uses the same file.
- Grok and Kimi sign-in advice quotes home paths for safe copying into a shell.
- The docs no longer promise for a relay a Workflow script started what holds for one the Agent tool started.
  A message to a running Workflow relay's agent id starts a second loop of it. In the one run measured for each, a
  steer reached the job through that loop, and a `cancel` through the first loop's guard. But Claude Code can then
  write the relay's later entries to a transcript the guard does not read, and a message there never reaches the
  job. A message after a Workflow relay ended fails, or resumes a general-purpose agent that answers in its place.
  Steer, continue and cancel a Workflow job by its job id: `C steer`, `C continue` and `C cancel`, as the board's
  live check did on all four backends. After its relay ended, a continue by id runs an attempt no relay hands back,
  so `status` marks it `not handed back`; its report is in `C result`.
- The jobs skill and the design say that a message reaching a job while a turn is starting (for example its first
  turn, or a continue or resume it accepted, before the backend began that turn) runs as the next turn, after that
  whole turn.
- The jobs skill's continue recipe goes on to the result: send once, wait for the job to end in waits that fit the
  Bash tool's timeout, read its state and its open messages, run an owed message with `resume` and wait again,
  then collect the new report. `C steer`, `C continue` and `C resume` exit 4 when the message was posted but no
  outcome came within 60 s. Exit 1 can also occur after posting, before a receipt is printed; after any nonzero
  exit read the job's messages before sending again, since every call posts a new one.
- The Workflow example in the jobs skill refuses `report: none` for a step that reads the report, and says that
  `completed` is only the first gate.
- `dead` and exit 3 are defined as the code has them: `dead` is a job that has not ended whose worker is gone or
  never started within 60 s, except a workerless admission wait; exit 3 also covers a failed or dead job with a report, and a
  completed job without one.
- The `result-handling` skill reads the state before the report, and keeps a command's verbatim output apart from
  a result Claude uses: Claude adds no line of its own after a command's verbatim output. Any review the user asked
  for, by a command, `C review`, a `relay:job` brief or a Workflow step, is review-only unless the same request
  asked for fixes; otherwise Claude goes on with work the user already asked for. It now loads for relay results,
  state blocks, failed jobs and report files.
- The `codex-prompting` skill says a relay job cannot ask its caller anything: settle questions before launch, or
  ask for a blocked report that names the missing decision.
- A relay whose start failed hands back the start output at once, instead of first running `result` with no job
  id, which the hook refused.
- `/relay:setup` shows each backend's binary path under the table. For a signed-out or missing backend it prints
  the sign-in `detail`, which can hold a fenced command, below the table instead of in a cell; for a block with an
  error it prints `error:` with the error below the table, and keeps the sign-in the check read.
- **Relay never leaves Claude Code's sandbox unasked.** Under the sandbox the companion fails with `EPERM`
  when it writes the jobs home, and Claude ran a review's companion call again with `dangerouslyDisableSandbox`
  without asking: the commands' `Bash(node:*)` grant approves that retry. The review and setup commands, the relay
  agent and the jobs skill now say never to retry without the sandbox unless the user asked, and to offer the two
  choices: allow the effective jobs and admission homes in `sandbox.filesystem.allowWrite`, including both
  when distinct, or run without the sandbox. Backend-home and network access remain separate caveats.
- `/relay:adversarial-review`'s argument hint says that quotes and apostrophes in the focus text group words and
  are removed, as before the argument file.
- When a person stops a relay from Claude Code's own controls (`x to stop` in the agent list, Esc at the relay's
  view prompt, ctrl+x ctrl+k, the desktop app's Stop button), its job keeps running, as before, and relay now
  says so: a line in the transcript and a toast name the job, with `/relay:cancel <job>` to cancel it and
  `/relay:result <job>` to read it. Until now the job ran on with no word. `TaskStop` and the message
  `cancel` still cancel the job, and show no notice. Checked live with `x to stop` and Esc; ctrl+x ctrl+k and
  the desktop app's Stop button are expected to behave the same but are not checked live yet. A Workflow's
  relays, which Claude Code does not list, get no notice, and none is shown where nothing draws the session
  (T3 Code, `claude -p`).

Docs:

- The installed jobs skill now includes a light orchestration guide and a dated model/benchmark/price snapshot
  with public sources, cache-write costs, distinct benchmark task bases, and a minor-release refresh procedure.
  It describes the two-very-heavy/three-other minimum, no very-heavy maximum, warning-only pressure
  reporting and pacing for new backend starts and replacements.
- Skill/guide agreement checks cover model-only classification, the minimum and retained turns;
  obsolete maximum and turn-pacing wording fails validation.
- The user guide covers queued work, conditional stop notices, Workflow job-id control and direct continuation,
  queued status-line/board controls, and both sandbox storage paths. Relay requires no external search or
  scraping service; optional services are the user's configuration.
- Setup renders configured and effective guard state from one captured JSON snapshot, including domain settings,
  off reasons, degraded/unreadable readings and provider pauses, without another backend probe.

- The README has a section on Claude Code's sandbox, with the setting that allows the jobs home and
  `sandbox.allowUnsandboxedCommands`; says that the review and setup commands ask no permission for their own
  steps, and why; and says that `/relay:review` on Codex prints Codex's own stderr, which
  `/relay:setup --job-mcp-off <name>` quiets for a noisy MCP server, for Codex jobs and reviews alike.
- [docs/desktop.md](../../docs/desktop.md): relay in the Code tab of the Claude desktop app. It covers what runs
  there, installing with the CLI (the app loads what the CLI installs), the permission modes, a check that it works,
  and how to try a build in one folder. Checked on a Mac in Claude for Mac 3.6556.1 with relay 3.0.0-dev.4; later
  checks there ran `/relay:cancel` and `/relay:transfer`, and found that the Background tasks Stop button ends the
  relay agent, not its job, and that the agent's view has no input box.
- [docs/guide.md](../../docs/guide.md): a walk through relay the way a user meets it, from the install to the status
  line and the board, with Claude Code 2.1.309's keys, and links to the README and desktop.md for the reference.

## 2.2.0 (2026-10-22)

From a survey of every T3 Code thread on three machines, about 360 relay jobs from 17 to 22 October,
most of them run by Workflow scripts ([docs/thread-surveys.md](../../docs/thread-surveys.md)).

- A Kimi job no longer ends `completed` with `report: none`. Kimi can write a turn's `turn.ended`
  before the engine's last batch of messages, the final answer included; relay dropped every message
  after `turn.ended`. A message now goes to the prompt turn of the engine turn running (for a
  notice run inside a prompt turn, that prompt turn), and a turn ends once that engine turn has
  ended too, or 10 s after `turn.ended` at most.
- A Workflow relay no longer loops on its state block. The relay retypes the block, and Haiku often
  left out its last line, `relay: …`; the hook blocked each try, and a `result` between tries reset
  the eight-block budget, so a relay could be blocked 44 times or be let go with prose as the step's
  return. A line that restates the request or only informs may now be left out; an outcome line may
  not, and no line may change. Only a `wait` on a job that has not ended, by its view (a dead job has ended), renews the
  budget.
- A relay that never runs `start` gets its job started by the hook at its first other command, its
  hand-back or its stop. In the 2.2.0 smoke test a relay read the brief's "Do not run any command"
  as its own instruction, answered "Hi." itself, and no job ever existed.
- On Linux, a worker started from a unit of the user's systemd runs in a scope of its own
  (`systemd-run --user --scope`). T3 Code's server runs as `t3code.service` with `KillMode=mixed`,
  so every T3 restart killed the workers it had started, and their jobs spent their one automatic
  resume on it. `RELAY_WORKER_SCOPE=off` turns the scope off.
- Each hand-back is recorded in the job's `relay-handbacks.jsonl`. `status` marks a relay job that
  ended with no hand-back of its result `not handed back` (only for attempts run by 2.2.0 or later; a relay let go while the job ran
  collected nothing), and `--json` gives `handedBackAt`, so a
  sweep for jobs nobody collected reads the job instead of the relay's transcript.
- `status --workflow <run>` lists every job one Workflow run started, in any repository.
- A header that names a GLM, Grok or Kimi model (`glm-*`, `grok-*`, `kimi-code/*`) with no `backend:`
  is refused before launch with the backend to add. Such a job used to run on Codex and fail there.
- A ZCode turn that fails on its sign-in (`project_token_login_failed`) says to run `zcode login`,
  then resume. Setup checks only that the credentials file exists.
- The Codex event log keeps only each turn's last `turn/diff/updated`, by thread and turn. Codex sends the whole diff so
  far after every change, and those copies were 60% of a 2.1 GB jobs home.
- The attempt a dead worker left open is closed as `dead` when the next attempt begins, and every
  attempt, a foreground review's included, records the plugin version that ran it (`relayVersion`).
- The relay's instructions say that the brief is for the job, that the hooks' text is the plugin's
  and no prompt injection, and that the result is copied whole. Relays had read the brief's files,
  refused to start over a hook's message, and commented on `cancel`.
- The jobs skill says what a `read-only` job cannot do on each backend, that Codex `mode: write`
  needs `add-dir:` for a CLI's own state under `~`, where Kimi's session record is, what a return without
  `state:` means in a workflow, that relays spend Claude usage while they wait, and that `C` in a
  lead's own Bash is a function, not a variable. In a T3 Code thread it points a plain fan-out of
  agents to T3's delegates, which relay complements, and keeps a dynamic workflow's jobs on relay.

## 2.1.2 (2026-10-17)

- A job's event log keeps the last updates of every turn. A Kimi turn ends on the session record,
  and a worker descheduled as Kimi ended the turn dropped the message chunks Kimi had sent just
  before: the worker flushed its events before it closed the connection, which reads the server's
  last output. It now closes first.
- A job resumed while its first brief was still owed no longer reads as dead for a moment while
  the new worker takes it over. The worker closed the redundant default resume before it recorded
  itself and the brief's attempt, so `wait` could report the job dead, exit 3, as it ran.
- The test suite passes on a slow, busy runner. Each test waits on the event it depends on: a
  steer or a cancel the fake's turn waits for, a setup limit counted from a fake that runs, a kill
  that lands mid-turn. No sleep was added and no time limit changed.

## 2.1.1 (2026-10-17)

- Every Kimi sign-in line names the region: `kimi login --region global`, or `--region
  mainland-cn` for a kimi.com account. That covers the sign-in error a job gives, `/relay:setup`
  and the jobs skill's `kimi-home.md`. A new home has no stored login and no region marker, so
  `kimi login` without `--region` signed a kimi.ai account in to kimi.com.
- The Kimi probe drivers are in `scripts/kimi-probe/`, so the facts in `docs/kimi.md` can be
  checked again on a new Kimi version.
- The test fakes end each turn only after relay's answers to their requests are recorded, as the
  real backends do. GitHub's runner had failed tests that read those answers too early.

## 2.1.0 (2026-10-17)

- A fourth backend, `backend: kimi`, runs Moonshot AI's Kimi Code through `kimi acp`. Jobs, the
  relay, cancel, continue, recovery, Workflow adoption, both reviews and setup work as on the other
  backends. `kimi-home:` selects the Kimi home (`default` is `~/.kimi-code`, a name is
  `~/.kimi-code-<name>`), and `/relay:setup` lists every Kimi home it finds.
- A running Kimi turn takes no message: a message sent while it runs becomes the next turn.
- Kimi supports `yolo` (Kimi's Never Ask mode) and `read-only` (Kimi's default mode, with every
  permission request rejected, and the file writes and terminal commands Kimi sends through the
  client refused by relay), and only `web-search: live`. `read-only` is not an OS sandbox: Kimi's
  hooks, the MCP servers and plugins it starts, and its other local operations can still have
  side effects.
- A Kimi turn's outcome and report come from the session's own record, because Kimi's ACP layer
  answers `end_turn` for a turn that failed.
- A failed adversarial-review turn says the turn failed and gives the backend's error, on every
  backend. It was shown as invalid structured JSON with the turn's error as the parse error, and on
  Codex a whole answer sent before the failure was shown as findings. `<backend> returned no valid
  review JSON` stays for an answer that came back and is not review JSON.
- `wait`, `result` and `status` read one validated version of a job, on every backend: the job,
  then its report, lease and owed messages, then the job again, all of it read again when a worker
  began or ended an attempt in between. A report is never paired with another attempt's state, nor
  missing while the next attempt archives it, and a job with owed work never shows as finished; it
  could return the previous report with exit 0 while that work ran. A job still changing after
  eight reads is busy, a retryable read and not a state: `wait` polls again, and the other readers
  retry, then say the job is busy and exit 4; `steer`, `continue` and `resume` still report a
  message they have sent. A view never mixes two versions of a job.
- Claude can invoke `/relay:review`, `/relay:adversarial-review`, `/relay:status` and
  `/relay:result` itself; they were user-only. A review Claude starts never asks a question: without
  `--wait` or `--background` it runs in the foreground. `/relay:cancel` and `/relay:transfer` stay
  user-only. The README gives the allow rules that run the four without Claude Code's prompt.
- The tests that wait for an orphaned process accept a child subreaper, such as `systemd --user`,
  as its new parent, so they pass on Linux desktops.
- The test suite cleans up its temporary directories; `RELAY_TEST_KEEP_TMP=1` keeps a failed run's.
- The docs say why `yolo` is the default: existing headers and Workflow scripts keep running as
  they did. A live check found `write` with `network: true` enough for web search, installs,
  commits and child processes on Codex and Grok, but not for `ps` or writes outside the working
  directory. The 2.0.0 entry below gave the earlier reason.
- The docs say what the stop gate can attribute (Claude's last message and the working tree as it
  stands, no diff of the turn), when `cancel` still signals after the process table becomes
  unreadable, and how a new backend is probed, tested and checked before it ships.
- The docs name the Linux case where Grok refuses its `read-only` profile, so read-only Grok jobs
  and Grok reviews fail: a runtime socket it denies, such as `/run/podman/podman.sock` under a
  root-only `/run/podman`. `write` still runs.

## 2.0.0

The first public release. `relay` runs jobs on Codex (GPT), Grok Build and ZCode (GLM) from Claude
Code like Claude agents.

- A `relay:job` agent, launched with the Agent tool or from a Workflow script, runs one job on
  another provider's harness and returns its report verbatim with a state block.
- `SendMessage` steers a running job and continues a finished one; the message `cancel` cancels it.
  Jobs survive the Claude session. After a server death, or a worker death while a relay agent
  waits on the job, the job resumes its session once per stretch of user work.
- Reviews and adversarial reviews run on all three backends. `/relay:setup` checks every backend
  without a model call. An optional stop-time review gate and session transfer run on Codex.
- Needs Claude Code 2.1.271 or later, Node.js 22 or later, macOS or Linux, and at least one of the
  Codex CLI, Grok Build or ZCode, signed in.

Compared with the development releases below:

- The three backends sit behind one contract (`docs/backends.md`). Each backend declares its
  capabilities once, and the header check, setup's `can:` line and the review commands derive from
  that declaration. Workers and reviews drive every backend through one connection interface.
- `job.json` always carries `request.backend`. A backend's own record lives under `backendState`.
- Settings live in the jobs home (`$RELAY_JOBS_HOME`, default `~/.relay-jobs`), and only
  `/relay:setup` writes them. An unknown header key is a usage error.
- Node.js 22 or later is required. macOS and Linux are supported, because the process sweep reads
  the process table with `ps`.
- The default `mode` stays `yolo`, because jobs need the network and web search. The brief is then
  the only fence, so name where a job may write.
- Codex's adversarial review runs through the same backend connection as a job.
- The prompting skill for Codex and GPT jobs is `codex-prompting`.
- A message whose attempt ended the job, such as a continuation whose session failed to resume,
  stays owed for `resume`. The plugin no longer starts a second worker for it on its own, which
  made the number of attempts depend on timing.
- A Grok turn that Grok cancels while its queue still lists entries ends as interrupted. It used
  to wait for a queue notification that Grok does not always send, which held the job `running`.

## Before 2.0.0

The development releases 2.0.0-fork.1 to 2.0.0-fork.17. Each line is a capability as it stands in 2.0.0.

- **Jobs as agents.** A `relay:job` agent runs one job and hands back the report with a state block,
  so the main thread treats a job like a Claude agent.
- **A relay that carries nothing.** Hooks read the prompt from the relay's transcript, deliver its
  messages and write its report, because a model that retypes text drops and adds to it. The relay
  runs on Haiku.
- **Steering.** A message sent while the job runs reaches the running turn within about two
  minutes, and one sent after the job ended starts a new turn on the same session, as `SendMessage`
  does with a Claude agent.
- **Cancel.** The message `cancel` interrupts the turn and, if the job has not ended 10 seconds
  later, stops the worker, the server and its snapshotted descendants. See `docs/design.md` for
  the process limits.
- **One worker and one server per job.** Each job has its own directory, detached worker and backend
  server, with no shared broker or state file, so concurrent workers do not overwrite another
  job's record.
- **Jobs outlive the session.** Jobs belong to no Claude session; `TaskStop` and the session's end
  leave them running.
- **Every message runs once or is reported.** Messages go through an inbox with recorded outcomes,
  and their ids are checked against the resumed session's history, so none runs twice or vanishes.
- **Recovery.** A server that dies mid-turn, or a relay job's worker, is resumed once on the same
  session, and the state block records it as `automatic-resume:`.
- **Capacity retries.** On Codex and Grok, model-capacity and request-rate failures retry after 30,
  60 and 120 seconds without repeating work already done; a usage quota fails at once.
- **Workflow scripts.** `agent(prompt, { agentType: 'relay:job' })` returns the state block as a
  string, so a script can fan work out to other providers; `schema` is refused with a sentence that
  names the fix.
- **Workflow adoption.** A relay the Workflow harness starts over can take over its predecessor's
  job by the run journal's key. This avoids a second job on a retry or a resumed run. Failed and
  cancelled jobs are not adopted; without a journal key, only a retry label can trigger adoption.
- **Quiet waits.** A relay's two-minute wait on a running job exits 0, so the `/workflows` view no
  longer shows a long job as an error.
- **Grok Build.** `backend: grok` runs jobs through Grok's ACP server, with separate Grok homes,
  Grok's sandbox profiles, and steers confirmed against Grok's own session history.
- **GLM on ZCode.** `backend: zcode` runs GLM on ZCode, Z.ai's harness for GLM's native interface,
  with model names matched in any case and recovery by command id.
- **Reviews on every backend.** `/relay:review` and `/relay:adversarial-review` take `--backend`, so
  a second opinion can come from any subscription, and every adversarial answer is checked against
  the review schema.
- **One setup page.** `/relay:setup` checks every backend home without a model call, so one command
  shows which backends are ready and what each can do.
- **Fast tier switch.** `fast: true` selects OpenAI's priority tier only after
  `setup --fast-tier allowed`, so spending one account's priority usage is a deliberate choice.
- **Lean Codex jobs.** `setup --job-mcp-off` turns off chosen MCP servers for Codex jobs, so a job
  does not start local servers it does not use.
- **A quiet stop gate.** The optional stop-time review gate is off by default, runs on Codex, and
  blocks only on a real `BLOCK:` answer, because a gate that blocks on its own failure traps the
  session.
- **Transfer.** `/relay:transfer` imports the current Claude Code session into a Codex session, so
  the work can go on in the Codex CLI with `codex resume`.
- **Manual prune.** `prune` removes old ended jobs when asked, and nothing else removes a job, so no
  report disappears unasked.
- **Fixes to the original plugin.** Dead workers read as dead, a turn ends when its server exits,
  thread names are cut by code point, efforts pass through unchecked, cancel reaches a job started
  in a shell's foreground, a failed turn keeps its error, a job in a linked worktree can commit,
  and SessionStart writes each export once.

## 1.0.6 and earlier

`relay` started as a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
1.0.6; the releases up to it are that project's work.
