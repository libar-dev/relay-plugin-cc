# Architecture

The plugin is plain ES modules under `plugins/relay/scripts/`, checked by TypeScript through
JSDoc and run by Node.js with no build step. Claude Code loads it from that folder: hooks run
`${CLAUDE_PLUGIN_ROOT}/scripts/...`, and the agent and the commands call
`scripts/companion.mjs`.

## Layers

```
agents/job.md, commands/*.md, skills/       what Claude Code sees
scripts/companion.mjs                        the command line: one dispatcher
scripts/cli/                                 one module per command
scripts/hooks/                               Claude Code hooks: relay guard, stop gate, session start
scripts/lib/harness/                         everything that reads Claude Code's own files
scripts/lib/worker/                          the detached worker that runs a job's turns
scripts/lib/review/                          review targets, prompts, rendering
scripts/lib/setup/                           the setup page
scripts/lib/jobs/                            the job store: records, inbox, lease, settings, views
scripts/lib/backends/                        Codex, Grok, ZCode and Kimi behind one contract
scripts/lib/util/                            process, file, argument and text helpers
```

A module imports only from its own layer or from a layer below it in this order:
`cli` and `hooks` → `harness`, `worker`, `review`, `setup` → `jobs` → `backends` → `util`.
`jobs/request.mjs` and `jobs/view.mjs` read the backend registry for each backend's rules and
state lines. Nothing in `backends/` imports from `jobs/`, `worker/` or `harness/`.

## Rules

1. **One place names the backends.** `lib/backends/index.mjs` is the registry. No other file
   compares a backend's name, imports a backend's folder, or holds a fact about one backend.
   What a backend can do (its modes, web-search values, priority tier, reviews) is declared
   once, on its object, and every check, every setup line and every state-block line is derived
   from that declaration. [backends.md](backends.md) is the contract.
2. **One writer per job record.** `start` writes `job.json`, then the job's worker writes it
   while it holds the lease. Recovery and cancellation write it only after taking the lease.
   A foreground review writes its own record in the companion process. Commands talk to a worker
   through the job's inbox and read its answers from the outcome files. Every write goes to a
   temporary file and a rename.
3. **Every message runs once or is reported.** A message a command was told about either
   reaches the backend's session exactly once or ends with an outcome that says why not. The
   worker never writes a terminal state while it holds queued work.
4. **Claude Code's undocumented files are read in one folder.** The agent transcript, the
   Workflow journal and the session path are read only under `lib/harness/`. After a Claude Code
   update, that folder and its tests are the ones to check.
5. **No hidden state.** Listing jobs is a directory read. There is no index file, no shared
   state file and no daemon: each job has its own worker and its own backend process.
6. **Comments say why, in the present tense.** A comment explains a wire format, a race, a
   limit or a reason. It never narrates how the code came to be.

## The job directory

```
$RELAY_JOBS_HOME (default ~/.relay-jobs) / <repo-slug> / <job-id> /
  job.json                the job record
  brief.md                the first turn's brief, byte for byte
  report.md               the final message of the current attempt
  events.jsonl            the backend's notifications, one JSON object per line
  stderr.log              the worker's own stdout and stderr
  server.stderr.log       the backend server's stderr, capped at 1 MiB
  inbox/                  messages for the worker, one <id>.json each
    claimed/              the messages a worker took
    outcomes/             one <id>.json per message: what became of it
    relay/                one record per relay delivery, named by the transcript entry's uuid
    relay.lock.d/         the relay's delivery lock: numbered records 1, 2, 3 ...
  attempts/               reports of earlier attempts, <n>-report.md
  worker.lease.d/         the worker lease: numbered records 1, 2, 3 ...
  relay.json              the current relay binding, once a second relay adopts the job
  relay-guard.json        the relay hook's state: its consecutive blocks and the last hand-back
  relay-handbacks.jsonl   every result a relay handed back, appended and never rewritten
  relay-violations.jsonl  every relay violation, appended and never rewritten
```

`inbox/relay/`, `inbox/relay.lock.d/`, `relay-guard.json`, `relay-handbacks.jsonl` and `relay-violations.jsonl` exist
only for a job a `relay:job` agent started. `worker.lease` and `inbox/relay.lock` are lock names,
not files. [design.md](design.md#leases) explains the numbered records.

Beside the slug directories, the jobs home holds `config.json` (the user's settings),
`<repo-slug>/config.json` (a repository's settings) and `relays/<agent-id>.json` (each relay's
pointer to its job).

Fields of `job.json` that tools outside the plugin read, and that keep their names: `id`,
`kind`, `state`, `createdAt`, `startedAt`, `completedAt`, `sessionId`, `request.cwd`,
`request.model`, `request.backend`, `launchedBy`, `relay` and `attempts`. A backend keeps its own
record under `backendState`: Grok keeps `binary`, `promptIds` and `deliveries` there, Kimi keeps
`binary` and `deliveries`, ZCode keeps `binary`, and Codex keeps nothing. Only that backend reads it.
