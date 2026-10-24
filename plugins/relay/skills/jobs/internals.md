# Job agents: how the plugin carries a job

Read this when a job died or was recovered, a relay misbehaved, a job runs in a git worktree, or you change the plugin. Launching
and talking to a job is in [`SKILL.md`](SKILL.md).

## How the relay is carried by code

The relay is a model, so it carries no content. A plugin hook does, and acts only inside a `relay:job` subagent (a main session started with `--agent relay:job` is not touched):

- The relay runs `start --from-relay`. The hook adds the relay's transcript path and agent id, and the companion reads the prompt from the transcript, byte for byte. The job is bound to the relay's agent id; the relay cannot wait on, read or hand back another job.
- Before every relay tool call and when it stops, the hook reads the relay's transcript and delivers every message the relay received, from the main thread or from another agent (a subagent or a Workflow agent), in order, exactly once: `cancel` cancels, other text steers the running turn or continues the ended job. A message sent before the job existed is delivered when it starts. Each delivery is recorded in the job's `inbox/relay/` by the transcript entry's id.
- Delivery is sure only for a relay the Agent tool started. The hook reads a Workflow relay's recorded transcript too and delivers what lands there. But a message to a Workflow relay's agent id starts a second loop of the relay while it runs, and after such a fork Claude Code can write later entries to `subagents/agent-<id>.jsonl`, which the hook does not read (it reads the transcript the job recorded at start). After that relay ended, such a message reaches no job. A Workflow job takes `C steer`, `C continue` and `C cancel` by job id ([`SKILL.md`](SKILL.md)).
- Cancelling a job whose worker has died stops only processes that still belong to the job; a process id the system has since given to another program is left alone.
- A `cancel` counts as delivered once the job is in a terminal state. A cancel that fails is recorded as a `relay-violation:` and stays pending while the job runs and tries remain. A terminal job closes it as done; three started tries close it as failed.
- The hook denies the relay's hand-back and blocks its stop while the job runs or a message is owed, even on a `completed` job. A message is owed while the hook has not delivered it, or while it is acknowledged and not run yet (`undelivered:`). The hand-back is rewritten to exactly what `result <job>` prints. Under the Workflow tool the hook adds `--state-only`, and compares the relay's final text with the state block, ignoring trailing whitespace.
- The relay may run only `start`, `wait`, `result`, `status` and `cancel`. Anything else is refused with a reason that restates its job.
- The hook sets each relay wait to `--timeout-seconds 540` with a Bash timeout of 600 seconds, the Bash tool's maximum, and adds `--exit-zero-while-running`, so a timed-out wait on a running job prints `still running: …` and exits 0. A message sent to the relay ends its wait early (see the hooks module below). A waiting relay therefore makes a tool call about every nine minutes, or as soon as a message comes, and the harness's stall timer, which is off during a tool call, can fire only when the relay's own model call stalls.
- A relay that never runs `start` (a small model can take a brief's "run no commands" as its own) gets its job started by the hook, exactly as its own start would, at its first other command, its hand-back or its stop. The hook then tells it to wait.
- Under the Workflow tool the relay's final text is the state block it retypes. A line it leaves out that restates the request or only informs (`relay:`, `model:`, `session:`, `note:`) passes; a missing outcome line or a changed line is blocked. A `result` or a `wait` after the job ended is no progress, so the blocks that follow it keep counting.
- Each hand-back the hook lets through is appended to the job's `relay-handbacks.jsonl`, and so is a `TaskStop` that cancelled the job, whose caller got the cancelled block. `status` marks a relay job that ended with none for its last attempt `not handed back`.
- After eight consecutive ordinary blocks the relay is let go, except while its job is queued: queued work remains blocked beyond that budget, and a transcript that cannot be read lets it go on. Both are recorded on the job: `result` and `status` print a `relay-violation:` line.
- When the harness includes a user-request entry, the relay drops it. The job receives the computed task and the messages delivered after it.

## Takeover under the Workflow tool

The harness marks each `agent()` call by the key it writes to the run's `journal.jsonl`, and the plugin stores that key as `relay.journalKey` in the job's `job.json` when the relay starts the job. When a fresh relay takes the job over, its binding (agent id, transcript and the same key) goes to the job's `relay.json`, which readers merge over `job.json`'s, because the worker alone writes `job.json` while it lives. A fresh relay for the same call in the same run (a stall, a lost or throttled reply, a usage-limit wait, a retry from the workflows view, `resumeFromRunId`) takes over the running job; the block gets one `relay-adopted:` line per hand-over and `status` shows `adopted:N`.

## What the relay depends on in Claude Code

The relay reads two things Claude Code does not publish as an interface: the agent transcript and the Workflow tool's run journal (`journal.jsonl`). Its markers were read from Claude Code 2.1.287 and 2.1.288 (`scripts/lib/harness/workflow.mjs`), and its hooks need `SubagentHandback`. Its hooks module needs the `session.send`, `agent.spawn` and `command.run` events of the Mod API, so the floor is Claude Code 2.1.307. A Claude Code update can break it. The check after an update is one workflow that runs a `relay:job` agent: the job's `job.json` must hold the call's key as `relay.journalKey` (once another relay has adopted the job, its `relay.json` holds the binding), and the script must get the state block back.

The module only checks headers and wakes a waiting relay: delivery runs on command hooks and the transcript. When a message is sent to a relay, the module's `session.send` hook runs `wake --agent <id>`, which writes `relay-wake.json` in the job directory if that agent is the job's current relay, also when the job has ended, since a message can continue it. The guard passes each relay wait `--wake-after <boundary>`, the time of the last transcript entry before the assistant message that holds the call, where Claude Code last put queued messages into the relay's conversation. The wait returns within a second of a marker newer than that, and the hook delivers the message at the relay's next call. Nothing removes a marker; a marker covered by the next boundary ends no more waits.

Before a `relay:job` agent starts, the module's `agent.spawn` hook runs `check-header` on its prompt, the parser and request builder `start` uses, and denies the spawn with the parser's message when the header is bad. It leaves relative paths to `start`, since the relay's directory is not known at the spawn, and lets the spawn through when it cannot run the check, for a resumed agent, and for a Workflow agent whose prompt has no `---` line (a run that keeps its script from hooks puts a placeholder there); `start` checks again. A `PostToolUse` hook on `TaskStop` (`scripts/hooks/relay-stop.mjs`) takes the stopped agent's id from the tool's result and, when that agent is its job's current relay and the job has not ended, runs `cancel` and puts the result beside the TaskStop's; a failed cancel is a `relay-violation:`. A TaskStop on a whole Workflow cancels nothing, so a resume adopts the running jobs; the hook lists the run's jobs that keep running.

For surfaced Agent-tool relays, the stop-notice hook names a discoverable active job after a person stops its relay; it skips a matching TaskStop mark. Workflow agents and no-surface hosts receive no notice. `/relay-board` opens the user-operated jobs pane.

The module's `command.run` hooks answer `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer`: each runs the companion by argv in the session's directory and shows its output, the lines up to the first `---` in a code block and a report after them as Markdown, with no model turn. A model's Skill call of a command never reaches `command.run`, so those four are the user's; read jobs with `C status` and `C result`.

## Automatic recovery

If the backend server dies before the turn finishes, the worker resumes the saved session once with "Your session was cut off. Continue the task from where you stopped, then write the final report." If the worker dies, the relay's wait (the hook adds `--auto-resume`) can spend that same retry, except while a `cancel` runs on the job: recovery then waits, and the job ends `cancelled`. Start, a user continue and each delivered user message renew the shared allowance. A second server death in one attempt returns `failed`; a worker death after the allowance was spent returns `dead`. The attempt a dead worker left open is closed as `dead` when the next one begins, and every attempt records the plugin version that ran it as `relayVersion`.

A Grok or ZCode steer acknowledged without proof that it joined a turn stays `interject-queued` and owed.
Grok's session history or ZCode's `turn.started` / `turn.steerDrained` event confirms it as `steered`.
After a worker death, resumed history closes an included message as `delivered-before`; otherwise it runs as a turn.
A message ZCode reports as already held is never sent again: relay waits up to 60 seconds for it to start,
or reports it as not delivered. Only ZCode's explicit `inputDiscardedOnRestart` response permits a fresh command id.

Every worker, whatever dispatches it, starts through a short-lived launcher and acknowledges only
after leaving its caller's descendant tree (PPID 1 on macOS). The caller waits for that acknowledgement;
a reparented worker keeps running after a Stop. If a worker dies before acknowledgement, plain `wait`
retries dispatch without spending an automatic recovery. `launch-*.json` and the job's
bounded launch history retain the trigger, caller PID/start time, launcher identity and acknowledged
worker PPID/PGID and a vanished caller’s observation time. `deathObservedAt` records discovery of a death, not its exit time.

Each worker records an execution group and retains the last 20 execution identities. On Linux with
an available user systemd manager, `systemd-run --user --scope --slice=relay-jobs.slice` contains the
job and its tools, including children that change sessions. Scope access checks the recorded inode
and boot ID before reading members or stopping the scope; `RELAY_WORKER_SCOPE=off` disables it.
Elsewhere, identity-checked process-group members plus a descendant registry (`processes.json`)
provide cleanup. Heartbeats sample descendants every 10 seconds using a process table cached for
5 seconds across workers, pruning gone identities; backend exit also takes a fresh sample. A
setsid child that orphans before any sample can escape tracking without a scope. Published worker
identities bound nested jobs so an outer job never claims their workers or tools. Native Windows
visibly bypasses admission and execution groups and acknowledges its detached launch immediately.

Backend loss and job completion stop owned processes with TERM/CONT, then KILL, before reconnect or
slot release. An unresolved survivor prevents reconnect; at job end it preserves the terminal state,
records `cleanup: unresolved`, and keeps its seat. The backend close itself
sends TERM after 50 ms, KILL at 5 seconds and returns within 10 seconds, recording `closeTimedOut`
if process end remains unobserved. Control RPC and turn deadlines are unchanged.

Heartbeats write `treeBytes` to the job and running slot: Linux scope `memory.current`, otherwise
summed member RSS. Active-job text shows this live measurement; terminal result text omits it so
cleanup cannot change the block a relay must return verbatim. JSON retains the accounting.
Guard status sums running jobs as `relayBytes`. Workers set Linux
`oom_score_adj` to 500 before backend spawn, inherited by tools. There is no static memory cap,
and macOS has visibility and cleanup without enforced containment or pausing running tools.
Transport lines are limited to 64 MiB; Kimi wire replay reads at most 4 MiB at once, retaining the
running turn, the last 50 ended turns and delivery-deduplication evidence.

Every recovery appears as `automatic-resume:` with its cause in the state block. All resumes keep
the first launch's cwd, mode, network, writable roots, web search, model, effort, tier, backend and
Grok home. A job keeps its tier even when the `fast-tier` setting changes while it runs.

## Git worktrees

- `write` in a linked git worktree also opens the worktree's gitdir and the common `.git` directory, packed-refs locks included, so Codex can commit.
- In a workflow script, `isolation: 'worktree'` works: with no `cd:`, the job runs in the worktree, and the state block carries `note: isolated worktree <path>`.

## The job directory

`job.json`, `events.jsonl` (backend events and finished messages, including large results; of Codex's `turn/diff/updated`, only each turn's last), `report.md`, `stderr.log`, `server.stderr.log` (the server's stderr, capped at 1 MiB), `brief.md`, `inbox/` (messages, with `claimed/` and `outcomes/` below it), `attempts/` (earlier reports), `worker.lease.d/` (the worker lease, as numbered records) and `cancelling/` (one record per `cancel` running on the job; automatic recovery waits while one lives). A relay job adds `inbox/relay/` (one record per delivered message), `relay-guard.json`, `relay-handbacks.jsonl` once a result is handed back, `relay-violations.jsonl` once a violation is recorded, and `relay.json` once another relay adopts it.

`prune` removes terminal or dead jobs in this repository, or every slug with `--all`; durations take `d`, `h` or `m`, and the default is `14d`. It keeps jobs with a live worker, removes old relay pointers unless their job remains, and prints each job's id, state and age, then the bytes freed. `--dry-run` only lists.

## The load guard

The guard shares one admission home across this user's sessions, independently of jobs homes.
For `C` CPU cores, the busy allowance is `F = min(16, max(2, C−2))`; the resident waiting-worker
limit is `Q = max(8, 2F)`. A workerless queued job remains valid; a wait, message or relay hook
retries its spawn at most once per admission poll, with a 64 MiB startup hold per waiting worker.
A workerless job with no spawn retry for 15 minutes stops deferring the stop-time review gate;
that changes gate deferral, not queue validity.

Outside the minimum, new backend start admission requires `available − otherHolds − J ≥ R`, where `R = max(2 GiB, 0.15 × total)`.
`J = 0.5 GiB` for Codex/Grok and `1 GiB` for Kimi/ZCode/unknown, held for 30 seconds without an
effort multiplier. Each finite cgroup ancestor has its own `min(0.5 GiB, 10% × limit)` margin.
Busy seats apply at five-minute load ≥ `1.5C` or unknown host bytes; healthy hosts have no fixed
active ceiling. Load > `3C`, critical host memory or macOS critical pressure can hold even
first starts and replacement backends. A macOS warning is shown only; it holds nothing.
Turns on a retained connection wait only for critical memory/pressure or provider pauses/probes;
they take no new hold and are not paced.
Linux uses MemAvailable. macOS uses `kern.memorystatus_level` free percentage times total memory,
falling back to `vm_stat` free+inactive, plus a separate memory-pressure reading.

The first two identified very-heavy and first three other active jobs skip the host reserve and the busy-seat allowance, subject to critical checks, startup allowance, scope/fit limits, provider protection, ordering and start pacing. There is no very-heavy maximum.
Guaranteed starts leave `max(0.75 GiB, 5% × total)` after pending holds and their own startup allowance.
Small hosts where `R + J > total` still fail the permanent-fit test.
Very heavy means GPT-6 Astra and Kimi K3 at any effort; other models at max/ultra stay outside it.
An unresolved default model is a coverage limit. Eligible backends with fewer active seats go first.
Starts and replacement backends are paced 5 s apart.
Native Windows visibly bypasses admission; missing sensors show degraded notes.
If the guard itself fails (its files can't be read or written), new starts wait and the job's state
names the error; `RELAY_ADMISSION=off` or `/relay:setup --admission off` lets work start without the guard.
A damaged guard record counts as busy until it is set aside. Damaged slots retain a startup hold for
30 seconds and count as active seats for 10 minutes before quarantine. Damaged pauses hold their
backend account for 15 minutes before quarantine. Refusals received during lock contention are
saved for the next admission check. Future startup times remain reserved across clock corrections.
Only a currently held seat can be reused; earlier completed admissions do not reserve a place.
Memory later used by tools/tests, native Claude agents, other harnesses and other users is outside
admission control. Recognized provider pauses and recovery are described in [orchestration.md](orchestration.md).
