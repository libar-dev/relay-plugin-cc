# Design

`relay` has one goal. A Claude Code main thread runs a job on Codex, Grok Build, ZCode or Kimi Code the way
it runs a Claude agent, and the job does not get lost. This page says how the plugin does that and
why. Read it before you change the plugin.

[architecture.md](architecture.md) has the code layout and the module rules,
[backends.md](backends.md) the backend contract, [kimi.md](kimi.md) what the Kimi backend rests on,
the [README](../README.md) installation and the commands, and the `relay:jobs` skill
([SKILL.md](../plugins/relay/skills/jobs/SKILL.md)) what the main thread is told. Issue references name `openai/codex-plugin-cc`, where this started.

## The interface the main thread sees

| Claude agent | `relay:job` agent |
|---|---|
| `Agent({subagent_type, description, prompt})`, run in the background | `Agent({subagent_type: "relay:job", description, prompt})`, the same |
| The completion notice carries the agent's final message | The completion notice carries a state block and the job's report, verbatim |
| `SendMessage` while it runs reaches it between tool calls | `SendMessage` while it runs is steered into the running turn within about two minutes; a turn that cannot take it, or has just ended, gets it as the next turn |
| `SendMessage` after it ends continues it with its context | `SendMessage` after it ends starts a new turn on the same backend session and returns the new report |
| `TaskStop` stops it | The message `cancel`, or `companion cancel <job>`, cancels the job. `TaskStop` stops only the agent, and the job keeps running |
| The Agent tool's `model` picks the model | `model:` and `effort:` in the header pick the job's model; the Agent tool's `model` picks the relay's own |

A Workflow script gets the same agent with `agent(prompt, { agentType: 'relay:job' })` and receives
the state block as a string ([Under the Workflow tool](#under-the-workflow-tool)).

Jobs outlive the agent and the Claude session on purpose, so stopping one is always an explicit
act. A dead or failed job continues on a message, or on `companion resume <job>`, whose default
message is "Your session was cut off. Continue the task from where you stopped, then write the
final report." Each queued turn starts a new attempt. A steer inside a running turn and automatic server
recovery stay in that attempt. The previous attempt's report moves to `attempts/`. A reader reads
one version of the job: the job record, then the report, the lease and the message account, then
the record again, and all of it again (up to eight times) when a worker began or ended an
attempt in between. It renders the report text from the pass that held, and takes a report a
new attempt has just moved from `attempts/`. A pass that did not hold is never shown: after
eight of them the job is busy, which is not a state. `wait` polls again within its deadline;
`status`, `result` and the other readers retry for two seconds, then say the job is busy and
exit 4; the relay hook refuses a hand-back or stop until it settles. So a view never pairs one
attempt's state with another's report, nor shows a job completed while owed work is running.
`steer`, `continue` and `resume` still report a message they have sent, with a note in place of
the state, so a busy read never gets it sent twice.

### The prompt

```
backend: codex             # default; or grok, zcode, kimi
model: gpt-6-astra
effort: xhigh
mode: yolo                 # default; or write, read-only
cd: /abs/path/to/worktree  # default: the directory the agent starts in
---
<the brief, passed to the job byte for byte>
```

The keys are `backend`, `model`, `effort`, `mode`, `network`, `web-search`, `fast`, `cd`, `add-dir`
(repeatable), `brief`, `grok-home` and `kimi-home`; the README's table lists their values.

- **Only the header configures the job.** The brief goes to the backend without interpretation, so "do not edit
  files" in a brief leaves `mode` as it is. A forwarder agent that reinterpreted requests dropped a
  `--write` flag and passed a note meant for itself to the job as part of the task.
- **`model` and `effort` are required**, so every job's model is chosen in the header, never by the
  relay. `default` leaves the choice to the backend's configuration (for ZCode, its default model
  at effort `high`). Other values pass through, and the backend decides which models and efforts
  exist, `max` and `ultra` included. A local list of efforts rejected valid ones
  (openai/codex-plugin-cc#751).
- **An unknown header key is a usage error** that names the known keys. A typo fails before
  anything runs.
- **`mode` defaults to `yolo`**: no sandbox and no approvals, so that every existing header and
  Workflow script keeps running as it did. A live check (Codex 0.162.0 and Grok Build 1.0.50, on
  macOS) found `write` with `network: true` enough for web search, package installs, git commits
  and child processes, and not enough for `ps` or for writes outside the working directory; with
  `network` at its default, Codex's `write` had no DNS. ZCode and Kimi have no `write` mode. A job that runs
  `ps`, as the plugin's own tests do, or writes outside its working directory needs `yolo`. The
  brief is then the only fence, so a brief names where the job may write. `network`
  applies to sandboxed modes, and `add-dir` adds writable roots in Codex's `write` mode.
  `yolo` ignores both with a `note:`; `read-only` ignores `add-dir` with a note.
- **`web-search`** (default `live`) is a tool setting, not the sandbox, so it applies in every mode.
- **`fast: true` asks OpenAI for its priority tier**, on Codex, only after
  `setup --fast-tier allowed`. The switch is off by default and lives in the jobs home's
  `config.json`, because the concern is one account's usage, not one repository's. With it off,
  `fast: true` runs without the tier and says so in a `note:`, never an error, so a brief written
  for another machine still runs. Grok, ZCode and Kimi ignore `fast` with a note.
- **A job keeps its first launch.** Continue, resume and recovery reuse the stored request: working
  directory, mode, network, writable roots, web search, model, effort, tier, backend, and the
  backend's own fields (Grok's and Kimi's homes, Codex's job MCP servers off).

`/relay:rescue` builds the same header from its flags and never infers `mode` or `backend` from the
words of the request.

### The state block

- `state` is `starting`, `running`, `completed`, `failed` (with `error:`), `cancelled` or `dead`.
  No process writes `dead`. A reader computes it when the state is not terminal and the worker's
  pid is gone or belongs to a process with another start time, or no worker recorded itself within
  60 seconds of the launch. A relay start that fails prints `state: not started` and `error:`.
- `completed` means the backend finished its answer, not that the job's commands passed.
- `stalled:` appears when an active job has sent no event for ten minutes. It is information only.
- Other lines appear when they apply: `backend:`, `grok-home:`, `kimi-home:`, `kind:` (a review), `tier: fast`,
  `mcp-off:`, `relay:`, `relay-adopted:`, `note:`, `automatic-resume:`, `capacity-retries:`,
  `undelivered:`, `not-delivered:` and `relay-violation:`.

| Exit code of `wait` and `result` | Meaning |
|---|---|
| `0` | completed with a report |
| `3` | ended without a report (failed or dead), or with messages not yet run |
| `4` | still running |
| `5` | cancelled; this wins over `3` |
| `1` | usage error |

## Why each layer exists

| Layer | What it owns |
|---|---|
| Relay agent (`relay:job`) | an agent id and a transcript for the job; three commands |
| Hooks | the prompt, the messages and the report; the relay's allowlist; session exports; the stop gate |
| Companion (`scripts/companion.mjs`) | the command line: creating jobs, posting messages, reading views |
| Worker | one job's `job.json`, its turns and its backend server |
| Backend server | the backend session while a worker or a review runs |

**The relay agent.** `agents/job.md` runs on Haiku with the Bash tool only, and runs three
commands: `start --from-relay`, then `wait <id> --timeout-seconds 120` while the output starts with
`still running` or a message arrives, then `result <id>`, whose output it hands back. It exists
because only a Claude subagent gets a background run, a completion notice, `SendMessage` and a
Workflow `agent()` slot. It carries no content. In live trials a small model dropped a message,
answered one itself, and appended its answer to a "verbatim" report. So code carries the prompt,
the messages and the report. Because the model carries nothing, Haiku is enough; a launch that
passes `model: sonnet` gets a Sonnet relay.

**The hooks.** PreToolUse (matcher `Bash|Write|SubagentHandback|StructuredOutput`) and SubagentStop
(matcher `^relay:job$`) run the relay guard. It acts only inside a relay subagent, with agent type
`relay:job` and an agent id or agent transcript, so a main session started with
`--agent relay:job` is untouched and every other hook call exits at once. A guard that throws
exits 0, so a broken hook never traps an agent. SessionStart exports `RELAY_COMPANION_SESSION_ID` and
`RELAY_COMPANION_TRANSCRIPT_PATH`, each at most once. It fires on start, resume, clear and
compaction, and appending each time grew `CLAUDE_ENV_FILE` until every Bash call failed with E2BIG
(openai/codex-plugin-cc#783, openai/codex-plugin-cc#788). Stop runs the
[review gate](#the-stop-time-review-gate). No hook ends a job,
because jobs belong to no session; a `SessionEnd` hook that killed a session's jobs lost their work.

**The companion.** `scripts/companion.mjs` is the one command line, for the relay, the slash
commands, the hooks, the worker launcher and scripts (the skill's "Direct use"). While a worker
lives, the companion never writes `job.json`; it talks to the worker through the inbox.

**The worker.** A detached process (a new session, its output in `stderr.log`), one per job at a
time, holding the job's lease. It starts the backend server, runs turns, acts on inbox messages,
writes the report, and alone writes `job.json` while it lives, recording its pid and process start
time, a heartbeat every 10 seconds and the last event's time. Detached, it outlives the agent and the
Claude session. On Linux a new session is not enough: stopping a systemd unit kills every process in
its cgroup, and T3 Code's server runs as `t3code.service`, so its restart killed the workers it had
started. A worker started from a unit of the user's systemd runs in a scope of its own
(`systemd-run --user --scope`, same pid). On macOS, quitting T3 Code has killed workers too; that
cause is not known. With the start time in its identity, a dead worker and a pid with a different
recorded start time read as dead (openai/codex-plugin-cc#704: a dead worker shown as running forever).

**The backend server.** A worker starts its own `codex app-server`, `grok agent ... stdio`,
`zcode app-server` or `kimi acp` in the job's working directory, a new one after a server end, and stops it when
its work ends. A review starts its own the same way. There is no shared broker. A long-lived shared
Codex app-server reused ChatGPT's single-use refresh token and logged out every client of
`~/.codex` (openai/codex-plugin-cc#789). Leaked brokers are described in
openai/codex-plugin-cc#753, openai/codex-plugin-cc#767, openai/codex-plugin-cc#782 and
openai/codex-plugin-cc#791.

## The job layer

### The job directory

A job lives in `$RELAY_JOBS_HOME` (default `~/.relay-jobs`) under `<repo-slug>/<job-id>/`;
[architecture.md](architecture.md#the-job-directory) lists its files. The slug is the repository
root's base name and eight hex digits of a hash of its path. A linked worktree belongs to its main
checkout, so every worktree of a repository shares one slug. A command takes a job id, a unique id
prefix, or the job's directory inside the jobs home.

Listing jobs is a directory read. There is no index file and no shared state file. One shared
`state.json` written without a lock lost jobs under concurrent launches (openai/codex-plugin-cc#689).

`job.json` always carries `request.backend`. A backend's own fields live under `backendState`, and
only that backend reads them. Settings are files in the jobs home that only `setup` writes:
`config.json` for the user (`fastTier`, `mcpOff`) and `<slug>/config.json` for a repository
(`stopReviewGate`).

### One writer per file

`start` writes the first `job.json`, then the worker owns it. Every write goes to a temporary file
and a rename, so a reader never sees half a record. Foreground reviews write their own job record
in the companion process. Commands that act on a job (`steer`,
`continue`, `resume`, `cancel`) drop a message into its inbox, and the worker acts on it. Only two
other writers exist, and both take the worker lease first: `cancel` once the worker is dead, and
automatic recovery after a worker death. A relay that adopts a job writes its binding to
`relay.json` instead, because the worker holds its own copy of `job.json`; readers merge
`relay.json` over the binding in `job.json`.

### Every message runs once or is reported

A message is a file posted to `inbox/` with a rename. The worker claims it by renaming it into
`inbox/claimed/` and records its outcome in `inbox/outcomes/<id>.json`; a rename is atomic, so two
workers never claim the same message. `steered`, `turn-started` and `delivered-before` mean it
reached the session; `dropped` (printed in `not-delivered:`) and `skipped` close it; any other
claimed steer, continue or resume is still owed. So a message a command was told about reaches the
backend's session exactly once, or ends with an outcome that says why not.

- **Owed until closed.** A claimed message stays owed until its outcome delivers or closes it, and
  a new worker runs every message a dead one owed.
- **No double delivery.** Each message carries its id to the backend: Codex's
  `clientUserMessageId`, ZCode's command id, or a Grok or Kimi delivery record saved before the
  request leaves. After a death the resumed session's history says which ids already arrived, and those
  never run again.
- **Steers settle first.** After a turn ends, the worker waits for every steer request in flight
  before it decides anything. A steer the turn did not take joins the queue.
- **No message without a consumer.** The worker never writes a terminal state while it holds queued
  work, and reads the inbox again before and after it releases its lease. Posting an acknowledged
  message waits until a live worker exists, and starts one for an ended job. A cancel or a recovery
  holding the lease is no consumer, so it starts a worker for anything that arrived meanwhile.
- **Owed work is not finished.** While a live worker holds owed work, the job reads `running`, so
  `wait` keeps waiting and the relay may not hand back. With no live worker, owed work prints
  `undelivered:` and `wait` exits 3, even on a `completed` job.
- **Counted along the path.** The account reads the inbox, then claimed messages, then outcomes,
  and counts each id once, so a message that moves during the read is never lost.
- **A default resume message yields.** It asks only for the final report, so it is skipped when
  other work is queued.

### Leases

The worker lease (`worker.lease`) and the relay's delivery lock (`inbox/relay.lock`) share one
helper. Neither name is a file. Ownership is a series of numbered records in `<lock>.d/<n>`, so
the worker lease lives in `worker.lease.d/1`, `worker.lease.d/2` and on. A taker writes its whole
record to a temporary file and hard-links it as the number above the highest it read; `EEXIST`
means another process took that number. The highest number holds the lock while its holder (pid
and start time) lives and it is not a release record; release links the next number, and needs
the record's token. Nothing removes the highest record, so a late taker finds a newer number above
its own and does not hold the lock. One exclusive link is the only step that makes a holder; a
scheme that removes a dead holder's lock file lets two cleaners both succeed. An unparsable record
is stale after 10 seconds; a live holder is never broken. A lease names its holder's role,
`worker`, `cancel` or `recovery`, and only a `worker` consumes messages.

### Processes and the predecessor sweep

The worker records each server it starts (pid and start time) before initialization, so even a
server that dies during initialization leaves an identity, and records its end: exit code or
signal, an unfinished last line, the last 4096 bytes of stderr. `server.stderr.log` keeps at most
1 MiB. JSONL lines have no size cap, so multi-megabyte results reach `events.jsonl` intact, and an
unfinished last line is never parsed. A server that relay closes gets its stdin ended, then
SIGTERM 50 ms later if it still runs, so a closed server's end record can show SIGTERM; that is
relay's own close, not a crash, and the job's state was settled before it. When the server exits
while a child of it holds a pipe, the client reads for 200 ms more, then closes the pipes, so the
end is recorded and every pending request settles; a request to a server that has exited fails at
once.

A new worker records itself and its attempt before any await, so a cancel or a reader sees it at
once. Before it starts a server, it stops every recorded server that has no end record and still
runs as the same process, with its descendants, SIGTERM then SIGKILL; that one place covers every
path that starts a worker. If the process table cannot be read, nothing is signalled and the job
fails with that cause, and a server that survives fails the job with its pid. A second server never
starts beside an old one, and queued work stays owed for a later worker.

### Automatic recovery, once

- **The server ends before the turn completes.** The worker resumes the saved session once with the
  resume message, in the same attempt. A second end in that attempt fails it, naming both ends.
- **The worker dies.** The relay's `wait` (the hook adds `--auto-resume`) takes the lease as
  `recovery`, stops the dead worker's servers, posts the automatic resume message and starts a new
  worker. A direct `wait` resumes only when it is given `--auto-resume`.
- **One shared allowance.** Both paths spend one allowance per stretch of user work: the start, each user
  continue and each delivered user message begin a new stretch, and automatic messages do not. Each
  recovery is recorded in `automaticResumes` with its cause, `app-server` or `worker`, and printed
  as `automatic-resume:`. A worker death after that reads `dead`, and `resume` continues the job.
- **Recorded processes only.** Recovery waits for the server's bounded end record and stops only
  processes it recorded, by identity. A process-group sweep in recovery ended a nested companion
  job that shared the outer worker's group.

### Capacity retries

On Codex and Grok, a failed turn whose error names capacity, an overloaded server or a request-rate
limit (Codex's
`serverOverloaded` and `rateLimitExceeded`, or "Rate limit reached for requests") is retried three
times, 30, 60 and 120 seconds apart, and each retry is recorded in `capacityRetries`. Of eight Codex
jobs started within one second, one failed on a request-rate limit after Codex's own reconnects.

- `usageLimitExceeded` fails at once, because a usage quota resets in hours. `resume` continues the
  job after the reset.
- A retry never replays work. A turn that failed before doing anything is sent again with the same
  input. A turn that did work (a tool call or commentary) is retried as a continuation on the same
  session with the resume message. A cancel during the wait starts no further turn.
- ZCode and Kimi retry model calls themselves, so the worker never retries their turns;
  a worker retry would send the message again.

### Cancel

- **A running job.** `cancel` posts a cancel message, and the worker interrupts the turn (Codex
  `turn/interrupt`, Grok and Kimi `session/cancel`, ZCode `stop`). If the job has not ended 10 seconds later,
  `cancel` kills the worker's process group, and signals the pid when the group kill fails with
  ESRCH: a worker started in a shell's foreground does not lead its own group, and a cancel never
  reached it (openai/codex-plugin-cc#786).
- **Nothing left running.** `cancel` snapshots the worker, the server and every descendant, with
  start times, before it signals anything. At the end it sweeps the snapshot and checks each start
  time before it signals a process. If the first read of the process table fails, `cancel`
  signals nothing and says so. A later read, after the grace period, can fail too: `cancel` then
  still signals the worker's process group, or the worker's pid when the group kill fails with
  ESRCH, signals none of the snapshot it can no longer check, and reports the failure. The
  process-group fallback has the limits listed under [Known limits](#known-limits).
- **A dead worker.** `cancel` takes the lease as `cancel`, writes `cancelled`, and reports owed
  messages as dropped; a job a worker ended meanwhile keeps that end. If a new worker holds the
  lease (from a resume, a continue or recovery), the cancel goes to it as an inbox message, and if
  that worker has not ended the job within 10 seconds, `cancel` exits 4 and names the holder's role,
  so a relay tries again.
- **An ended job** gets a no-op receipt, so every cancel is recorded as handled.

### Prune

`prune [--older-than 14d] [--all] [--dry-run]` is the only retention; nothing prunes on its own.
Durations are whole numbers of `d`, `h` or `m`, and the scope is the current repository or, with
`--all`, every slug. A job is removed only when its state reads completed, failed, cancelled or
dead, its worker and lease holder are gone, and its last activity (`completedAt`, else
`lastEventAt`, else `createdAt`) is older than the cutoff. The worker lease protects the final check
and the removal. Unrecognised directories and symlinks survive, empty slug directories go, and
stale relay pointers go by age unless their job remains, so follow-ups still find it. Each removal
prints the job id, state and age, then a total of bytes freed; `--dry-run` changes nothing.

## The relay and Workflow adoption

### The prompt reaches the job

The hook rewrites `start --from-relay` (`updatedInput`) to add the relay's transcript path and
agent id. The companion reads the relay's first prompt from the transcript, byte for byte, parses
the header and starts the job, bound to the relay by `relay.agentId` in `job.json` and a pointer at
`<jobs home>/relays/<agent-id>.json`. The hook finds the job by agent id, never by a job id the
relay names, and rewrites `wait`, `result`, `status` and `cancel` to that job, so a relay cannot
reach another job; each rewritten command names the jobs home the hook resolved. The relay may run
only these five commands, as plain words with no shell syntax, and hand back. Write and every
other command are refused with a reason that restates its job. A prompt that cannot be read or
parsed starts no job, and the error is kept for the hand-back.

### Messages

Before every relay tool call and at SubagentStop, the hook reads the transcript and delivers every
received message not yet delivered, in order: steered while the job runs, continued once it ended.

- A message is recognised by its entry type and origin, never by its text: a `queued_command`
  attachment from the coordinator (a `SendMessage` while the relay works), a `user` entry from the
  coordinator (a message after the hand-back, taken out of the harness's fixed wrapper), or a plain
  `user` turn after the prompt that is neither metadata (`isMeta`) nor a tool result.
- A message that arrives before the job exists is delivered by `start` once the job exists.
- Each delivery is recorded in `inbox/relay/<transcript entry uuid>.json` under the relay lock, with
  the inbox message id chosen before posting. A hook cut off half way posts again under the same
  id, so the message runs once even when hooks run twice or at the same time. A hook that cannot
  take the lock within 45 seconds leaves the messages for the next one; a post with no consumer
  after 20 seconds stays pending and is retried under the same id.
- A `cancel` counts as delivered once the job is terminal. A failed try is a `relay-violation:` and
  stays pending while the job runs, with later messages waiting behind it. A try counts when it
  starts, and three started tries close it as failed.

### The report

PreToolUse on `SubagentHandback` denies the hand-back while the job is not terminal or a message is
owed, received but not delivered or delivered but not run, even on a `completed` job; the reason
gives the exact wait command. Otherwise it rewrites the hand-back's `message` to exactly what
`result <job>` prints, read from `job.json` and `report.md` in process, never through a capped
pipe. After a failed start the hand-back is allowed at once and carries the start error. Claude
Code gives a subagent the `SubagentHandback` tool only in auto mode, and a subagent under the
Workflow tool does not get it. Without it, SubagentStop blocks while the job runs, a message is
owed, or the relay's final text differs from the result. A message after the hand-back resumes
the relay; the hook delivers it at the next tool call, as a continue, and the next hand-back is
rewritten the same way.

### Two-minute waits, never trapped

The hook sets every relay `wait` to 120 seconds with a Bash timeout of 180 seconds, so a message
reaches the job within about two minutes. It also adds `--exit-zero-while-running`, so a wait that
times out on a running job prints `still running: not an error. Run the same wait again.` first and
exits 0. The Bash tool marks every non-zero exit as an error, and the `/workflows` view showed each
two-minute wait of a long job as a failure. A direct `wait` keeps exit 4. Claude Code's stall timer
is off during a tool call, so it can fire on a waiting relay only when the relay's own model call
stalls.

The transcript format is not documented, so it is parsed defensively. A transcript that cannot be
found or read, an entry that cannot be understood, or a delivery that fails is appended to
`relay-violations.jsonl` in the job directory, and the relay proceeds. The guard counts its own
consecutive blocks per relay and lets the relay go after eight, with a recorded violation.
Violations are never removed; `result` and `status` print each as a `relay-violation:` line.

### Under the Workflow tool

- **The transcript is found by agent id.** A workflow subagent's transcript lives one directory
  deeper than the path the hook receives, under `subagents/workflows/<run>/`. The run directory is
  in no hook field, so every run directory is tried with the exact basename `agent-<id>.jsonl`, and
  the path found is recorded on the job.
- **The harness's own entries are recognised by their marker line**, the one exception to "never by
  text", because the harness marks its two user entries with nothing else. The markers, the
  system-prompt notes and the trailers live in one module with the Claude Code version they were
  read from. The user-request entry is skipped. The computed-task entry is the prompt, with one
  indentation level removed; a later one is delivered as a message. A line at column zero inside
  the indented block is forged, and the start fails naming it. The two trailers the harness
  appends, the isolated-worktree note and a reminder, are dropped and noted.
- **`schema` fails the start.** The relay returns a string and cannot satisfy a schema, and a small
  model would invent one. The start fails with a sentence that names the fix, and the hook denies
  the StructuredOutput tool with it. The script gets the harness's own error (`subagent completed
  without calling StructuredOutput`), because the harness accepts only a StructuredOutput call
  under `schema`. For structured data, a script hands the `report:` file to a Claude agent that has
  the schema.
- **The return is the state block.** A workflow subagent's final text is its return value, and a
  small model cannot be trusted to retype a whole report. So the hook adds `--state-only` to its
  `wait` and `result`, and SubagentStop compares its final text with the state block, ignoring
  trailing whitespace. `state:`, `job:`, `duration:`, `report:` and `dir:` are always present.
- **The job records where it came from**: the run id from the transcript path, the label and phase
  from the meta file beside it. The `relay:` line prints the run id and the label, cut to 80
  characters, and `status` prints `workflow:<run>/<label>`. Under `isolation: 'worktree'` with no
  `cd:`, the job runs in the worktree and carries `note: isolated worktree <path>`.
- **A relay holds its slot for the job's whole run.** The harness runs at most
  `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` agents at once, by default two fewer than the
  machine's cores, within 2 and 16. Stopping a workflow ends the relays, not the jobs.

### Adoption by journal key

The Workflow harness starts an `agent()` call over, with the same prompt and a fresh agent id, after
a stall (by default five minutes without progress), a lost or throttled reply, a usage-limit wait,
a retry the user asks for, and a resume with `resumeFromRunId`. The first relay's job keeps
running, so a second start would double the cost and write into the same `cd:` at once.

- **The key is the harness's own.** The harness writes a `started` line per spawn to the run's
  `journal.jsonl`, with the agent id and a key: one key for every spawn of a call, a different key
  for a second call with the same prompt and label. `start --from-relay` reads the journal beside
  the transcript, records the key as `relay.journalKey`, and takes over the newest job of the same
  run whose relays carry that key. The harness writes the line before the relay's first model
  call, so a start nearly always finds it.
- **Without a key**, only a relay whose label carries a retry suffix (`(retry N)`,
  `(throttle-retry)` or `(after usage limit)`) adopts, matched by the prompt's SHA-256 and the label
  without the suffix.
- **What never adopts.** A failed or cancelled job, because a retry after a failure runs the work
  again. A job of another run, because a resume keeps its run id and a new run wants fresh work.
  Two calls with the same prompt and label in one run are two jobs. `Agent`-tool relays are never
  started over.
- **The hand-over.** The binding goes to `relay.json`, the old relay to `relay.previous`, and the
  new agent id's pointer names the job; the label stays the script's own and the guard count starts
  clean. The start prints the job's current state, so the new relay goes on to wait. The state
  block prints one `relay-adopted:` line per hand-over, and `status` prints `adopted:N`.

### What the relay reads from Claude Code

None of it is a published interface; [architecture.md](architecture.md) keeps every read in
`lib/harness/`. From hooks: the agent id, type and transcript path, the session's transcript path
and id, `last_assistant_message`, `stop_hook_active`, `background_tasks`, the `SubagentHandback`
tool and `updatedInput`. From the transcript: each entry's `type`, `uuid`, `isMeta`, `origin` and
content, two attachment types and the coordinator's wrapper. From the Workflow harness: the
transcript path, the marker lines, two system-prompt notes, two trailers, the meta file, the
journal's `started` lines and the three retry suffixes.

## Backends

Each backend is one folder behind the contract in [backends.md](backends.md). What it can do is
declared once, on its object, and the header check, setup's `can:` line and the review commands
derive from that declaration. Workers and reviews drive every backend through the same
connection interface, and the backend's own record lives in `job.backendState`. Tests drive fake
binaries and never start a real backend.

| | Codex | Grok | ZCode | Kimi |
|---|---|---|---|---|
| Server | `codex app-server` | `grok agent --no-leader --always-approve stdio` | `zcode app-server` | `kimi acp` |
| Protocol | app-server JSON-RPC: threads and turns | ACP (JSON-RPC 2.0) with Grok's `_x.ai/` methods | NDJSON: ZCode Protocol v4 commands and a session subscription | ACP, with the session's `wire.jsonl` for each turn's outcome |
| Modes | `yolo`, `write`, `read-only` | `yolo`, `write`, `read-only` | `yolo`, `read-only` | `yolo`, `read-only` |
| Web search | `live`, `cached`, `disabled` | `live` | `live`, `disabled` | `live` |
| `fast` | priority tier, when allowed | ignored, with a note | ignored, with a note | ignored, with a note |
| Home | `CODEX_HOME`, else `~/.codex` | `grok-home:` | `~/.zcode` | `kimi-home:` |
| Sign-in | the Codex CLI's | `grok login`, per home | `zcode login`, shared | `kimi login --region`, per home |
| Steer, cancel | `turn/steer`, `turn/interrupt` | `_x.ai/interject`, `session/cancel` | `sendText` with `guide`, `stop` | the next turn, `session/cancel` |
| Capacity retry | yes | yes | no | no |

### Codex

- **Protocol.** A new job sends `thread/start` with the working directory, model, sandbox, approval
  policy `never`, and config overrides for web search (`web_search`) and the write sandbox; the
  thread is persistent, so it can be resumed. Every `turn/start` carries the message id as
  `clientUserMessageId`, the model, the effort and the first launch's sandbox policy, so a turn on a
  resumed thread keeps the sandbox. Continue and recovery send `thread/resume` with the saved id.
- **Thread names** come from the first line of the brief (or its `<task>` block), cut to 60 code
  points; a name cut inside a surrogate pair got no reply from the app-server (openai/codex-plugin-cc#793).
- **Modes.** `yolo` is `danger-full-access`. `write` is `workspace-write`, with `add-dir` as extra
  writable roots and `network` as network access; in a linked git worktree it also opens the
  worktree's gitdir and the common `.git` directory, so commits work (openai/codex-plugin-cc#765).
- **A turn completes on the server's word**: `turn/completed` for the exact turn id, a terminal
  status in the `turn/start` response, or `failed` when the server ends first. A final answer alone
  never ends a turn. A start response without a turn id drops no notifications (openai/codex-plugin-cc#781),
  and a failed turn keeps its error message (openai/codex-plugin-cc#757).
- **Collaborator turns** are the one inference. When collaborator agents drained, the final answer
  arrived and no `turn/completed` came within 250 ms, a `thread/read` of that turn (10 seconds)
  decides. Only an unsupported `thread/read` or a turn that reads `inProgress` completes by
  inference, with `note: turn completion inferred`; any other read failure fails the turn. The
  path comes from upstream, and its fake (a collaborator turn whose main-thread `turn/completed`
  never arrives) has not been checked against a real multi-agent Codex turn.
- **Server requests** (an approval, a question) are refused with `-32601`, because a job has no one
  to answer them, and recorded in `events.jsonl` as `codex/serverRequestRejected`.
- **Home and sign-in.** Jobs use the Codex CLI's home, `CODEX_HOME` or `~/.codex`, its
  `config.toml`, and a project's `.codex/config.toml` when Codex trusts the project; the plugin
  writes nothing there. `default` takes the configured `model` and `model_reasoning_effort`. Sign-in
  is the CLI's: ChatGPT, an API key, or none when the configured provider needs no OpenAI sign-in
  (setup's `not-needed`, from openai/codex-plugin-cc#177).
- **Tool-output budget.** Codex keeps 10,000 tokens of each tool result by default, which truncates
  a review's diff, so every Codex job gets a Relay budget. Presets are formulas of the model's
  context window: `deep` is a quarter of it to the nearest power of two and the default,
  `balanced` half of `deep`, `compact` a quarter. The window is `model_context_window`, else the
  model's entry in Codex's `models_cache.json`, else 272000; `model/list` reports neither window
  nor budget. `codex/tool-output-budgets.json` holds hand-reviewed values that replace the formula
  for named models, with a version, unless `model_context_window` is configured: the reviewed
  values assume the catalog's window. A job's `tool-output-token-limit` takes a preset, a number or
  `inherit`. A preset resolves at each thread open, after `config/read`, so a configured
  `model_context_window` bounds it whether or not the job names its model. The number
  is sent as `config.tool_output_token_limit` on thread start and resume, including recovery, and on
  a native review's source thread. Without a choice, each thread open asks `config/read`: a
  configured budget stays Codex's; otherwise Relay sends the model's default and writes a `note:`
  naming the value and its basis. Code mode cuts each `exec` and `wait` result to 10,000 tokens
  unless the call asks for more (`max_output_tokens`, `max_tokens`), whatever the budget; no
  setting changes that default. So when the effective budget is above 10,000, the thread opens
  with `developerInstructions` naming the budget and the pragma, appended to the configured
  `developer_instructions`.
  See [Codex configuration](../README.md#codex-configuration) for usage and limits.
- **Job MCP servers off.** `setup --job-mcp-off name,...` stores a user-level list. A job passes
  `-c mcp_servers.<name>.enabled=false` for each listed name the home's `config.toml` defines and
  skips any other name with a `note:`, because Codex refuses to start on a setting for a server its
  configuration does not define. With `fast-tier: allowed`, `fast: true` sends service tier
  `priority` on `thread/start`, `thread/resume` and every turn.
- **Delivery evidence.** `turn/steer` needs the active turn id (`expectedTurnId`) and carries the
  message id. An accepted steer is delivered; a refused one becomes the next turn. After a death, the
  resumed thread's `userMessage` items carry the ids it already holds.

### Grok

- **Protocol.** A new job sends `session/new`, continue and recovery `session/load`, both with an
  empty MCP server list, then `session/set_config_option` for the model and the effort. A message
  is `session/prompt`. The binary is `GROK_BINARY`, else the first executable `grok` on `PATH`,
  and the job records its real path; setup warns when it is a script, because a wrapper may run its
  own hooks when a job starts `grok agent`.
- **Isolation.** Every launch sets `GROK_MEMORY=0` and the Claude and Cursor compatibility switches
  to `0`. Grok's working-directory rules and the chosen home's MCP servers and hooks still apply,
  and installed Claude plugins still load in Grok.
- **Modes.** `yolo` removes an inherited `GROK_SANDBOX`; `write` sets Grok's `workspace` profile and
  `read-only` its `read-only` profile. `write` refuses `add-dir` and a linked git worktree before a
  job exists, because the profile cannot add writable roots. A profile Grok cannot apply fails the
  job with Grok's error, and the mode is never weakened. A permission request gets an offered allow
  option in `yolo`, a reject option otherwise, and `cancelled` when none is offered. Child-process
  network follows the profile, which macOS does not enforce.
- **Web search** is `live` only; `cached` and `disabled` are usage errors, because removing both
  `web_search` and `web_fetch` in agent mode is not proved.
- **Homes and sign-in.** `grok-home: default` is `~/.grok`, a name is `~/.grok-<name>`, a path is
  taken as given; the resolved `GROK_HOME` is stored at launch and used on every later launch. Each
  home signs in with its own `grok login`. A copied `auth.json` puts one refresh token in two
  homes, which can log each other out, the race of openai/codex-plugin-cc#789. The skill's `grok-home.md`
  builds a home without MCP servers or hooks.
- **Turns.** The prompt's id is the first new prompt id in Grok's queue whose running text matches
  the brief after trimming, else the response's `_meta.promptId`. The worker waits beyond the
  prompt response while Grok reports queued entries, a running prompt or an interjection in flight,
  so the last completed turn owns the report, which is the agent text after its last tool call.
  Stop reason `end_turn` completes, `cancelled` interrupts, and any other fails with that reason.
  Grok's controls need only the session and a pending prompt, even before a turn id arrives.
- **Delivery evidence.** `_x.ai/interject` answers `queued`, nested in `result.result`; reading that
  as a missing status ran a steer twice in a live check. `queued` is not durable, so the steer stays
  `interject-queued` until the session's `chat_history.jsonl` holds it as an interjection record,
  and only then is `steered`. If the turn ends without it there, or Grok refuses it, it runs as the
  next turn.
- **Recovery.** Before a prompt or interjection leaves, the backend saves a delivery record: message
  id, kind, exact text, method, session, and how many matching messages Grok already held. After a
  death, the replayed user messages and `chat_history.jsonl` say what Grok holds, and each persisted
  copy confirms at most one message, in the order sent, so a brief may repeat a request on purpose.
  The backend reads only its own session's history and ignores an unfinished last line.

### ZCode

- **Protocol.** `runtime/capabilities` is the handshake. A new job sends the v4 command
  `createSession`, because a session made with `session/create` fails v4 `sendText` with "FOREIGN
  KEY constraint failed". Continue and recovery send `session/resume`, and both subscribe with a
  snapshot. A turn's message is `sendText` with delivery `startNow` and the plugin's message id as
  its command id; every `sendText` carries the model selection, the mode and the tools it removes.
- **Process and sign-in.** The binary is `ZCODE_BINARY`, else the first executable `zcode` on
  `PATH`, and the job records its real path. The connection removes `ZCODE_APP_SERVER_AUTH_MODE`,
  so the server uses the CLI's `zcode login` instead of waiting for credentials from the client.
  Jobs share the CLI's credentials file. The connection answers
  `session/requestRuntimePreferences`, without which ZCode fails the create after 15 seconds:
  memory off, and search enhancements following `web-search`.
- **Models and effort.** ZCode's ids are case-sensitive, and the subscription's snapshot lists only
  the current model. So a named model is matched, without regard to case and with an optional
  `<provider>/` prefix, against every model the sign-in serves, which a `session/resume` snapshot
  lists. The read gets 10 seconds; when it fails, the model goes as written and a `note:` says why.
  A model not in the list goes as written, and ZCode fails the turn with `model_not_found`.
  `effort: default` is `high`; ZCode's own default is `max`.
- **Modes.** ZCode's modes are approval policies, not sandboxes, and it has no OS sandbox, so
  `write` is a usage error. `yolo` is ZCode's `yolo`. `read-only` is ZCode's `build` mode with Write,
  Edit, Bash, TaskStop and the node REPL removed from every message; permission requests are allowed
  only for the reading tools, and a resumed session gets those tools as its allowlist.
  `web-search: disabled` removes WebSearch, WebFetch and the web reader.
- **Unattended jobs.** Every message removes AskUserQuestion, EnterPlanMode, ExitPlanMode, Agent,
  SendMessage, the four Cron tools and ReadSessionContext. A subagent inherits only the session's
  own lists, which a new v4 session lacks, so subagents are removed rather than limited. Requests
  for user input, official MCP auth headers and browser control are declined or refused (browser
  control with a message naming the shell and web tools); any other is refused and recorded.
- **Turns.** The job's turn is the one whose `inputId` is the message's command id. The run ends
  when that turn has ended, no turn runs, no steer is in flight, and every steer ZCode accepted has
  joined a turn or started one. The last finished turn owns the report and the status: `success`
  completes, `cancelled` interrupts, and any other result, `turn.failed` or `session.closed` fails
  with ZCode's words. Every request races the server's end and the session's closing, because a
  request to either never settles.
- **Delivery evidence.** A steer is `sendText` with delivery `guide`, accepted only while a turn
  runs. An accepted steer is `steered` and must join a turn (`turn.steerDrained`) or start one. Once
  nothing runs, one that has done neither gets 10 seconds, then is reported dropped and never sent
  again, because ZCode may still hold it. One still held when the server ends runs as the next turn,
  where the resumed history decides whether it arrived. A cancel drops every steer ZCode still
  holds, and since a stop with steers queued pauses ZCode's queue durably, every message carries
  `heldQueueDisposition: "clearQueueAndSend"`.
- **Recovery.** A message is delivered when the resumed session's user messages name its id
  (`sourceCommandId`). A resend uses the next `~<n>` command-id suffix. A
  message ZCode discarded on restart is sent again, up to twenty times; one answered `duplicate`
  gets two seconds to start first. A session ZCode no longer has (`-32004`) where no turn ever ran
  never left memory, and a new session replaces it; a session where a turn ran fails the job,
  because its context is lost.

### Kimi

[kimi.md](kimi.md) has the Kimi Code 2.2.0 facts this section rests on, how they were probed and
how to check a new Kimi version, the reason for each choice below, and Kimi's features left for
later.

- **Protocol.** `kimi acp` speaks ACP. A new job sends `session/new`, continue and recovery
  `session/load`, both with an empty MCP server list, then `session/set_mode`, and
  `session/set_config_option` for the model and the thinking effort; Kimi keeps model and effort
  across a load but not the mode, so all three go on every open. A message is `session/prompt`.
  The binary is `KIMI_BINARY`, else the first executable `kimi` on `PATH`, else
  `~/.kimi-code/bin/kimi`, and the job records its real path. A `KIMI_BINARY` name that is not on
  `PATH` fails; it never falls back to the installer's location.
- **The session's record decides.** Kimi's ACP layer answers `end_turn` for a turn that failed,
  and sends nothing for a turn Kimi starts on its own (a background command finished, a goal the
  model set). Kimi appends every turn to the session's `wire.jsonl` with a durable write within
  milliseconds. The connection reads that record with one reader of its own, which advances by
  byte offset and keeps a line still being written, with any UTF-8 character it splits, for the
  next read; it tracks each turn by Kimi's turn id and knows which turn runs, Kimi's own or a
  prompt relay sent. Kimi records engine turns (`agent.turn.started`, `agent.turn.ended`) apart
  from prompt turns (`turn.prompt`, `turn.ended`): a background task's notice that arrives as a
  prompt turn ends runs as a second engine turn inside it. Kimi counts as busy while either kind
  runs, and a turn's messages are its prompt turn's. Before a prompt goes, the connection notes the offset. The prompt is the first
  one with its exact text first recorded after that offset, joined across its records by Kimi's
  prompt id: delivered when Kimi commits the user input (`agent.message.appended`), started when
  `agent.turn.started` names it or `turn.prompt` runs it, completed at its turn's `turn.ended`.
  Kimi's `UserPromptSubmit` hooks put their text in front of the prompt's own parts, marked as the
  hook's (the record keeps the mark); matching leaves those parts out, so a hook's text never
  stands for a prompt. `completed` completes, `cancelled` interrupts, `failed`
  fails with Kimi's `[code] message`. A prompt a hook blocked ends with `prompt.completed`
  (`blocked`) and no turn, and fails the job with that reason; one cancelled before it started
  ends with `prompt.aborted` and interrupts. The report is the turn's assistant text after its last tool call, from the
  record. One observer reads the record for the run; the run, a cancel and the connection's close
  abort it and wait for it to stop.
- **A prompt queued behind a turn of Kimi's own.** Kimi queues a prompt sent while it runs a turn
  of its own, and ACP answers `end_turn` at once and never reports that prompt again. The
  hand-off runs Kimi's prompt hooks before the queued prompt reaches the record, so it can pause.
  The observer waits while any turn runs. After ACP's answer, a prompt the record does not show
  has 10 seconds of Kimi idle (1 second after a `cancelled` answer); time Kimi spends busy does
  not count. When those run out, the job fails: Kimi accepted the message, but its start is not
  confirmed. The worker reports the message dropped (a brief is no longer owed), sends nothing
  more to that server and closes it, so the message is never sent twice; its delivery record
  stays. The failed attempt records that decision in the same write that fails it, and the next
  round honours it before anything owed is worked out, so a worker death in between changes
  nothing. A cancel of such a prompt cannot go over ACP, which cancels only a prompt it drives, so
  relay stops waiting and closes Kimi's server.
- **Commands.** Kimi reads a prompt whose first text block starts with `/word` as one of its
  commands or skills, so a brief or message that starts with `/` goes after an empty text block.
- **Steer.** A running Kimi turn takes no message: ACP has no steer, and Kimi refuses a second
  prompt as busy. A message sent while a turn runs becomes the next turn.
- **Modes.** `yolo` is Kimi's `auto` (Never Ask); a permission request that still arrives gets an
  offered allow option. `read-only` is Kimi's `default` mode with every permission request
  rejected. Kimi's own git policy approves file writes inside a git work tree without asking, so
  a `read-only` client also declares file writes and terminals, and refuses each
  `fs/write_text_file` and `terminal/create` Kimi then sends it. It declares and serves file
  reads (`fs/read_text_file`) too: ACP has no append, and Kimi emulates one as a read and a write
  only when the client serves both, appending to the file itself otherwise. A read opens without
  blocking and serves only a regular file of up to 8 MiB, judged on the opened file, so a FIFO, a
  device or a symlink to one is refused at once; at most eight reads run at once, and the
  connection's close aborts them and waits. There is no allowlist: read-only is not a sandbox. `write` is a usage error: Kimi
  has no workspace sandbox. `web-search: live` only: ACP cannot remove Kimi's web tools.
- **Homes and sign-in.** `kimi-home: default` is `~/.kimi-code`, a name is `~/.kimi-code-<name>`,
  a path is taken as given; the resolved `KIMI_CODE_HOME` is stored at launch. Each home signs in
  with its own `kimi login --region global` (or `mainland-cn`): without `--region`, Kimi signs a
  new home in to kimi.com. Kimi locks a token refresh per home, so jobs share one home safely;
  a copied credentials file in a second home would not be. Every launch sets
  `KIMI_CODE_NO_AUTO_UPDATE=1` and `KIMI_DISABLE_CRON=1` and drops inherited `KIMI_MODEL_*`
  variables, which would replace the header's model and effort, and an inherited
  `KIMI_CODE_TRUST_WORKSPACE`, which would trust the working directory and load that repository's
  MCP servers, config directories, skills and instructions. Kimi checks the sign-in at
  `session/new` and `session/load`; a signed-out home fails the job there, with the
  `kimi login` line, region included, for the job's own home.
- **Recovery.** Before a prompt leaves, the backend saves a delivery record: message id, exact
  text, session, and the record's byte offset. After a death, a prompt with that text first
  recorded after the offset means the message arrived (its input committed, its turn started, or
  a hook blocked it), and it does not run again. An earlier copy of the same text, recorded
  before the offset, does not count. Kimi retries model calls itself, so the worker never retries
  a Kimi turn.

## Reviews

`/relay:review` and `/relay:adversarial-review` run on any backend: `--backend` (Codex unless
given; nothing stores a default), `--model`, `--effort` and `--grok-home`, beside `--base` and
`--scope`. The request is built as a job's is, in `read-only` mode, so a combination a job refuses
is refused the same way. A review runs in the foreground, or as a Claude background task with
`--background`, and is recorded as a job of kind `review`
or `adversarial-review`, so `status` lists it. A Codex review turns off the job MCP servers.

- **Review.** On Codex, `/relay:review` is Codex's own reviewer (`review/start` on an ephemeral
  read-only thread, against the working tree or a base branch), which takes no effort (`--effort`
  is a `note:`) and no focus text. On Grok, ZCode and Kimi it is the plugin's `prompts/review.md`.
- **Adversarial review** sends `prompts/adversarial-review.md` through the backend's connection,
  the one a job uses, on a fresh read-only session. Codex gets the schema as `outputSchema`; Grok,
  ZCode and Kimi, which have no schema parameter, get it in the prompt. A Grok review always runs
  under Grok's `read-only` profile, and a Kimi review refuses the file writes and terminal
  commands Kimi sends through the client, which is not an OS sandbox (Known limits, Kimi).
- **Inline limit.** A Grok, ZCode or Kimi review reads only the inlined change (read-only ZCode and
  Kimi have no shell to run git), so it sees the whole change or does not start. Untracked files count toward
  the limit and are inlined whole, and a binary file is named. Above 256 KiB, the review is refused
  before any job or process exists, with a message naming `--base`, `--scope` and Codex. A Codex
  adversarial review above two files or 256 KiB gets a summary and
  reads the diff itself with read-only git commands; untracked files there are cut at 24 KiB each.
- **The schema.** An adversarial answer counts only if it matches
  `schemas/review-output.schema.json`: types, enums, required fields, ranges, array items and no
  extra properties. One JSON code fence around the whole answer is unwrapped. Anything else fails
  the review on every backend with `<backend> returned no valid review JSON`, keeps the raw answer
  in the report, and exits 1. There is no second try. A turn that fails is not read as an answer:
  the review says `The <backend> turn failed: <error>`, `error:` is the backend's error, anything
  the turn had sent stays raw, and the exit is 1.

## Setup

`/relay:setup` with no arguments checks every backend home it finds and prints one block for each:
binary and version, sign-in, default model and effort, the models one can name in `model:`, and a
`can:` line rendered from the backend's capability declaration. The homes are the Codex home,
`~/.grok` and every `~/.grok-<name>`, ZCode (`~/.zcode`, or under `ZCODE_DATA_BASE_DIR`), and
`~/.kimi-code` and every `~/.kimi-code-<name>`.

- **No model call.** Codex: `codex --version`, then one app-server asked `account/read`,
  `config/read` and `model/list`, with no thread. Grok: `grok --version` and `grok models` under the
  home, and its `config.toml`; setup never starts `grok agent`, which a wrapper may hook. ZCode:
  `zcode --version`, whether the credentials file is a regular file of more than two bytes (never
  opened), the default model from `provider_config.json`, then one app-server asked to create a
  draft session that ZCode keeps in memory, read its model list, and close it unsaved, with no
  message. Whether the ZCode sign-in works is known at the first turn. Kimi: `kimi --version` and
  `kimi provider list --json` under the home, reading only its model fields (the output carries
  the provider's API key field), whether each file-stored sign-in's credentials file is a regular
  file of more than two bytes (never opened), and the defaults in `config.toml`; whether the sign-in
  works is known at the first turn.
- **Limits.** All checks run at once, 10 seconds per command and 20 seconds per app-server, each in
  its own process group, which ends with the check however it ends.
- **Failure is local.** A missing, signed-out or slow backend, or an unexpected error in one home,
  becomes that block's reason, and the page still prints and exits 0. A ZCode block with no model
  list, or an empty one, is not ready; a draft ZCode does not confirm closed is a warning that names
  it. `--backend codex|grok|zcode|kimi [--grok-home H|--kimi-home H]` checks one home and exits 1 when
  it is not ready.
- **Switches** (`--enable-review-gate`, `--disable-review-gate`, `--fast-tier`, `--job-mcp-off`)
  apply before the overview and are a usage error beside `--backend`.

## The stop-time review gate

`/relay:setup --enable-review-gate` turns the gate on for the repository, every worktree and session
of it. It is off by default, because each review is a Codex job and costs usage.

- When the main thread stops after a turn, one read-only Codex job, in the Codex home at its default
  model and effort, reviews that turn's edits, as Claude's last message describes them, against the
  working tree as it stands. Its first line must be `ALLOW:` or `BLOCK:`. The gate has no record of
  which edits the turn made: it cannot tell them from changes already in the working tree, and
  skipping while jobs and background tasks run narrows that overlap without removing it.
- It blocks only on a real `BLOCK:` answer. A timeout, a failed review, invalid JSON or any other
  answer allows the stop with a message naming `/relay:review --wait`, and a missing Codex with one
  naming `/relay:setup`. A gate that blocked on its own failure would trap the session.
- It allows the stop at once, with a message, during a stop-hook continuation, while background
  tasks run (a Workflow among them), and while a job of the repository runs, whose edits it cannot
  tell from Claude's.
- The review is a background job (`task --backend codex --background`, the backend
  `backendWith("stopGate")` names) with 10 minutes. Past that it is cancelled through the job path,
  so nothing of it keeps running. The two Codex probes before it get 10 seconds each and end with
  their process group. All of it stays inside the hook's 900 seconds.
- It runs on Codex only; on Grok, ZCode and Kimi, run `/relay:review`.

## Transfer

`/relay:transfer` imports the current Claude Code session into a Codex session that one resumes
with `codex resume <id>`. It finds the session file through `RELAY_COMPANION_TRANSCRIPT_PATH`,
which the SessionStart hook exports, or `--source`, and accepts only a JSONL file under
`~/.claude/projects`. One app-server runs `externalAgentConfig/import`, with two minutes to
complete, and the imported thread id is read from the Codex home's import ledger, matched by the
file's path and content hash. No other backend imports a Claude session, so transfer runs on Codex
only.

## The Claude Code dependency

The relay reads two things Claude Code does not publish as an interface: the agent transcript and
the Workflow tool's run journal ([what it reads](#what-the-relay-reads-from-claude-code)). Its
markers were read from Claude Code 2.1.287 and 2.1.288, and its hooks need `SubagentHandback`, so
the floor is Claude Code 2.1.271. A Claude Code update can break any of it. The relay needs no
Claude Code mod. It runs on command hooks and the transcript.

The Workflow journal has a second storage mode, behind a feature flag and off on 2.1.288, that
keeps no `journal.jsonl` on disk. Under it a relay finds no key, so a resumed run's relay starts a
second job instead of adopting the first; a retry still adopts by its label suffix.

After a Claude Code update:

1. Run one Workflow script with a `relay:job` agent. The script must get the state block back, and
   the job must record the call's key as `relay.journalKey` (`job.json`, or `relay.json` after an
   adoption).
2. Steer one running `relay:job` agent with `SendMessage`, and send it one message after it hands
   back. The state block must show no `relay-violation:` line, and the second message must run as a
   new turn.
3. If either fails, `scripts/hook-probe.mjs` logs what the hooks receive. Register it for
   PreToolUse, PostToolUse and SubagentStop in a throwaway project, repeat the steps, and compare
   the log with what `lib/harness/` expects.

## Known limits

**Processes.**

- `cancel` of a dead job signals the recorded worker pid without checking its start time, and its
  process-group kill can reach a nested job that kept the worker's group.
- A `cancel` whose read of the process table fails after the grace period signals only the
  worker's process group, or its bare pid; a descendant outside that group, such as a tool
  command the server started in a session of its own, keeps running.
- Recovery treats a process whose start time cannot be read as the same process.
- A process a dead server left behind that is no longer its descendant is out of reach of recovery
  and of a later cancel. The fake-server tests reproduce this when a child inherits stdout. The plugin does not
  record every descendant while a server runs.
- A `zcode app-server` can leave a file lock under `~/.zcode/v2` after it ends. A later
  ZCode start may report that lock before recovering it.

**Codex.** The job MCP switch covers servers defined in the home's `config.toml`. It does not
turn off servers supplied by an installed Codex plugin. A job that hits a usage quota fails; `resume` continues it after the reset.
Inside Codex's `write` sandbox, `ps` is denied, so the plugin's process tests fail there; run the
full suite outside it. The inferred completion of a collaborator turn rests on a fake, not on a
real multi-agent turn: it is no pattern for another backend.

**Grok.** Where Grok refuses its `read-only` profile (a Mac whose `/var/run/docker.sock` is a
symlink, or Linux where it cannot reach a runtime socket it denies, such as
`/run/podman/podman.sock` under a root-only `/run/podman`), read-only jobs and every Grok review
fail with Grok's error. `web-search: disabled` is
refused until removing both web tools is proved. Setup does not show Grok's per-model efforts; that
would need `grok agent`.

**ZCode.**

- In a session's first process, a turn ZCode starts on its own (a background command finished)
  carries no per-message tool lists, so it has subagents, the Cron tools, plan mode and, under
  `web-search: disabled`, the web tools. A v4 session gets session-wide lists only through
  `session/resume` in a later process. `read-only` jobs have no shell, so they start no background
  command.
- A message ZCode reported started or accepted, then lost with its process before it stored the
  text, counts as delivered. The plugin cannot prove that the text reached durable storage before the process ended.
- No isolation per job. Jobs share ZCode's storage, session database and settings; ZCode's plugins
  and skills, `~/.zcode/AGENTS.md`, and the working directory's `AGENTS.md` and `.zcode/` settings
  load, and a project's `.zcode/config.json` can add MCP servers.
- `read-only` trusts ZCode's risk classes for the tools a new session still has; a plugin tool ZCode
  classes as free of side effects can run until a resume applies the allowlist.
- A ZCode server that is alive but silent holds a request without a deadline, a continue's
  `session/resume` included. Only the model-list read is bounded, and only on the plugin's side: a
  read that times out stays pending on the server until it answers or exits.
- The runtime moves. The plugin uses ZCode's v4 commands and the session methods
  `session/subscribe` and `session/resume`, which ZCode's source marked for removal when this
  backend was built (source of 2026-09-24). Check one job after every ZCode update.

**Kimi.**

- A turn Kimi starts on its own (a background command finished, a goal the model set) is not seen
  over ACP, and its work is not in the job's report. `read-only` refuses the shell, so it starts
  no background command.
- **Completion and background work.** A completed job confirms the terminal record of the turn
  relay sent, and only that turn. It does not cover background tasks Kimi started: they may still
  run, or end with Kimi's server. A background task's notice that arrives while a later prompt
  turn runs is handled inside that turn, so the turn's report can be Kimi's answer to the notice
  rather than to the message (seen live, 2026-10-17). A message queued behind a turn of Kimi's own
  has no ACP driver, so ACP's cancel cannot reach it; relay cancels it by ending Kimi's server.
- `read-only` is not an OS sandbox. It rests on Kimi sending file writes and shell commands to a
  client that declares them; Kimi's hooks, the MCP servers and plugins it starts, and its other
  local operations can still have side effects. `Write` creates missing parent directories
  locally before its refused write, and Kimi's file adapter keeps binary writes (bytes that are
  not UTF-8) and exclusive creates on its own filesystem. A tool that writes another way, such as
  a plugin's stdio MCP server, is not covered; in Kimi's default mode an MCP call asks and is
  rejected, unless the home's `[[permission.rules]]` allow it.
- Kimi runs each shell command in a session of its own. After a server SIGKILL the command
  outlives it, out of reach of recovery, as above.
- No isolation per job in one home: sessions, MCP servers, plugins and their session-start skills,
  hooks and the sign-in are the home's. A home for jobs without MCP servers or plugins is the
  skill's `kimi-home.md`.
- The session record's format is undocumented (`protocol_version` 1.5). Check one job after every
  Kimi update.

**Not measured.** Sustained rate limits and simultaneous jobs on one plan for Grok, ZCode and Kimi,
and a crash during a partial answer. Nothing caps how many jobs run at once.
