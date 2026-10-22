# Job agents: how the plugin carries a job

Read this when a job died or was recovered, a relay misbehaved, a job runs in a git worktree, or you change the plugin. Launching
and talking to a job is in [`SKILL.md`](SKILL.md).

## How the relay is carried by code

The relay is a model, so it carries no content. A plugin hook does, and acts only inside a `relay:job` subagent (a main session started with `--agent relay:job` is not touched):

- The relay runs `start --from-relay`. The hook adds the relay's transcript path and agent id, and the companion reads the prompt from the transcript, byte for byte. The job is bound to the relay's agent id; the relay cannot wait on, read or hand back another job.
- Before every relay tool call and when it stops, the hook reads the relay's transcript and delivers every message the relay received, from the main thread or from another agent (a subagent or a Workflow agent), in order, exactly once: `cancel` cancels, other text steers the running turn or continues the ended job. A message sent before the job existed is delivered when it starts. Each delivery is recorded in the job's `inbox/relay/` by the transcript entry's id.
- A `cancel` counts as delivered once the job is in a terminal state. A cancel that fails is recorded as a `relay-violation:` and stays pending while the job runs and tries remain. A terminal job closes it as done; three started tries close it as failed.
- The hook denies the relay's hand-back and blocks its stop while the job runs or a message is owed, even on a `completed` job. A message is owed while the hook has not delivered it, or while it is acknowledged and not run yet (`undelivered:`). The hand-back is rewritten to exactly what `result <job>` prints. Under the Workflow tool the hook adds `--state-only`, and compares the relay's final text with the state block, ignoring trailing whitespace.
- The relay may run only `start`, `wait`, `result`, `status` and `cancel`. Anything else is refused with a reason that restates its job.
- The hook sets each relay wait to `--timeout-seconds 540` with a Bash timeout of 600 seconds, the Bash tool's maximum, and adds `--exit-zero-while-running`, so a timed-out wait on a running job prints `still running: …` and exits 0. A message sent to the relay ends its wait early (see the hooks module below). A waiting relay therefore makes a tool call about every nine minutes, or as soon as a message comes, and the harness's stall timer, which is off during a tool call, can fire only when the relay's own model call stalls.
- A relay that never runs `start` (a small model can take a brief's "run no commands" as its own) gets its job started by the hook, exactly as its own start would, at its first other command, its hand-back or its stop. The hook then tells it to wait.
- Under the Workflow tool the relay's final text is the state block it retypes. A line it leaves out that restates the request or only informs (`relay:`, `model:`, `session:`, `note:`) passes; a missing outcome line or a changed line is blocked. A `result` or a `wait` after the job ended is no progress, so the blocks that follow it keep counting.
- Each hand-back the hook lets through is appended to the job's `relay-handbacks.jsonl`. `status` marks a relay job that ended with none for its last attempt `not handed back`.
- Nothing traps the relay: after eight consecutive blocks it is let go, and a transcript that cannot be read lets it go on. Both are recorded on the job: `result` and `status` print a `relay-violation:` line.
- When the harness includes a user-request entry, the relay drops it. The job receives the computed task and the messages delivered after it.

## Takeover under the Workflow tool

The harness marks each `agent()` call by the key it writes to the run's `journal.jsonl`, and the plugin stores that key as `relay.journalKey` in the job's `job.json` when the relay starts the job. When a fresh relay takes the job over, its binding (agent id, transcript and the same key) goes to the job's `relay.json`, which readers merge over `job.json`'s, because the worker alone writes `job.json` while it lives. A fresh relay for the same call in the same run (a stall, a lost or throttled reply, a usage-limit wait, a retry from the workflows view, `resumeFromRunId`) takes over the running job; the block gets one `relay-adopted:` line per hand-over and `status` shows `adopted:N`.

## What the relay depends on in Claude Code

The relay reads two things Claude Code does not publish as an interface: the agent transcript and the Workflow tool's run journal (`journal.jsonl`). Its markers were read from Claude Code 2.1.287 and 2.1.288 (`scripts/lib/harness/workflow.mjs`), and its hooks need `SubagentHandback`. Its hooks module needs the `session.send` and `command.run` events of the Mod API, so the floor is Claude Code 2.1.307. A Claude Code update can break it. The check after an update is one workflow that runs a `relay:job` agent: the job's `job.json` must hold the call's key as `relay.journalKey` (once another relay has adopted the job, its `relay.json` holds the binding), and the script must get the state block back.

The module only wakes a waiting relay: delivery runs on command hooks and the transcript. When a message is sent to a relay, the module's `session.send` hook runs `wake --agent <id>`, which writes `relay-wake.json` in the job directory if that agent is the job's current relay, also when the job has ended, since a message can continue it. The guard passes each relay wait `--wake-after <boundary>`, the time of the last transcript entry before the assistant message that holds the call, where Claude Code last put queued messages into the relay's conversation. The wait returns within a second of a marker newer than that, and the hook delivers the message at the relay's next call. Nothing removes a marker; a marker covered by the next boundary ends no more waits.

The module's `command.run` hooks answer `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer`: each runs the companion by argv in the session's directory and shows its output, the lines up to the first `---` in a code block and a report after them as Markdown, with no model turn. A model's Skill call of a command never reaches `command.run`, so those four are the user's; read jobs with `C status` and `C result`.

## Automatic recovery

If the backend server dies before the turn finishes, the worker resumes the saved session once with "Your session was cut off. Continue the task from where you stopped, then write the final report." If the worker dies, the relay's wait (the hook adds `--auto-resume`) can spend that same retry. Start, a user continue and each delivered user message renew the shared allowance. A second server death in one attempt returns `failed`; a worker death after the allowance was spent returns `dead`. The attempt a dead worker left open is closed as `dead` when the next one begins, and every attempt records the plugin version that ran it as `relayVersion`.

On Linux, a worker started from a unit of the user's systemd (T3 Code's server runs as `t3code.service`) runs in a scope of its own through `systemd-run --user --scope`, because stopping a unit kills every process in its cgroup, a new session or not. `RELAY_WORKER_SCOPE=off` turns that off. On macOS, quitting T3 Code has killed workers; the cause is not known, and the recovery above covers one such death. Every recovery appears as `automatic-resume:` with its cause in the state block. All resumes keep the first launch's cwd, mode, network, writable roots, web search, model, effort, tier, backend and Grok home. A job keeps its tier even when the `fast-tier` setting changes while it runs.

## Git worktrees

- `write` in a linked git worktree also opens the worktree's gitdir and the common `.git` directory, packed-refs locks included, so Codex can commit.
- In a workflow script, `isolation: 'worktree'` works: with no `cd:`, the job runs in the worktree, and the state block carries `note: isolated worktree <path>`.

## The job directory

`job.json`, `events.jsonl` (backend events and finished messages, including large results; of Codex's `turn/diff/updated`, only each turn's last), `report.md`, `stderr.log`, `server.stderr.log` (the server's stderr, capped at 1 MiB), `brief.md`, `inbox/` (messages, with `claimed/` and `outcomes/` below it), `attempts/` (earlier reports) and `worker.lease.d/` (the worker lease, as numbered records). A relay job adds `inbox/relay/` (one record per delivered message), `relay-guard.json`, `relay-handbacks.jsonl` once a result is handed back, `relay-violations.jsonl` once a violation is recorded, and `relay.json` once another relay adopts it.

`prune` removes terminal or dead jobs in this repository, or every slug with `--all`; durations take `d`, `h` or `m`, and the default is `14d`. It keeps jobs with a live worker, removes old relay pointers unless their job remains, and prints each job's id, state and age, then the bytes freed. `--dry-run` only lists.
