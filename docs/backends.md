# Backends

A backend is a harness the relay runs jobs on: Codex's `codex app-server`, Grok Build's
`grok agent stdio`, ZCode's `zcode app-server`, or Kimi Code's `kimi acp`. Each one is a folder under
`plugins/relay/scripts/lib/backends/` whose `index.mjs` exports one object of type `Backend`,
declared in [`lib/backends/types.d.ts`](../plugins/relay/scripts/lib/backends/types.d.ts). That
file is the contract; this page says how the rest of the plugin uses it.

```
lib/backends/
  index.mjs            the registry
  types.d.ts           the contract
  setup.mjs            helpers the setup probes share
  transport/
    stdio-rpc.mjs      a JSON-RPC client over a child process's stdio, with the server's end record
    acp.mjs            the Agent Client Protocol messages Grok and Kimi use
  codex/
    index.mjs          the backend object
    connection.mjs     the connection: threads, turns, steers, interrupts, capacity errors
    turn.mjs           thread start and resume, turn capture and completion
    client.mjs         the app-server client and its end message
    request.mjs        sandbox, approval and thread settings of a request; job MCP servers off
    review.mjs         Codex's own reviewer (`review/start`)
    transfer.mjs       the Claude Code session import
    account.mjs        the availability probes
    setup.mjs          the setup probe
    protocol.d.ts      the Codex 0.162.0 wire fields the plugin sends or reads
  grok/
    index.mjs          the backend object
    connection.mjs     the connection: ACP sessions, Grok's queue and interjections, delivery records
    history.mjs        reads of a session's `chat_history.jsonl`
    request.mjs        Grok homes and Grok's request rules
    setup.mjs          the setup probe
  zcode/
    index.mjs          the backend object
    connection.mjs     the connection: v4 commands, the session subscription, model matching
    request.mjs        ZCode's request rules
    defaults.mjs       the default effort
    setup.mjs          the setup probe
  kimi/
    index.mjs          the backend object
    connection.mjs     the connection: ACP sessions, read-only refusals, delivery records
    wire.mjs           reads of a session's `wire.jsonl`: each turn's end, report and prompt count
    request.mjs        Kimi homes and Kimi's request rules
    setup.mjs          the setup probe
```

## The registry

`lib/backends/index.mjs` is the only module that imports a backend folder or names a backend.

| Export | What it gives |
|---|---|
| `BACKENDS` | every backend, in page order: Codex, Grok, ZCode, Kimi |
| `DEFAULT_BACKEND` | the backend of a header with no `backend:` line, of a review with no `--backend`, and of a `task` with no `--backend` |
| `backendNames(separator, lastSeparator)` | the names joined for a message: "codex, grok, zcode or kimi" |
| `backendNamed(name)` | the backend, or a usage error naming every valid value |
| `backendFor(request)` | the backend of a stored request; a request without `backend` is the default's |
| `backendWith(capability)` | the one backend that has a capability; it throws unless exactly one has it |
| `BACKEND_HEADER_KEYS` | every backend's own header keys, mapped to their request fields |
| `backendHeaderValues(options)` | those keys read from command flags, so `start` and the reviews take `--grok-home` and `--kimi-home` |

`task --backend <name>` checks the name with `backendNamed` and stores it in the request. The stop
gate picks its backend with `backendWith("stopGate")`: it probes that backend, starts its review
with `task --backend <name>`, and names it in every message. `transfer` runs on
`backendWith("transfer")`. The setup page offers the stop gate through that backend's
`setup.reviewGateNextStep`.

## The backend object

| Member | What it is |
|---|---|
| `name`, `label` | the header's `backend:` value, and the name a person reads: "Codex", "Grok", "ZCode", "Kimi" |
| `capabilities` | what the backend can do, the one declaration of each fact |
| `capabilityNotes` | words that qualify a capability on setup's `can:` line |
| `request` | how a header becomes this backend's launch request |
| `view` | the state block's lines and the `status --json` fields this backend adds |
| `connect(request, hooks)` | start one server process for a worker attempt or a review |
| `endMessage(exit)` | the transport error for a server that ended before its turn did |
| `eventRecorder(write, touch)` | which notifications reach `events.jsonl`, and when |
| `setup` | the setup page's checks for this backend's homes |
| `review` | how reviews run on this backend |
| `transfer?(cwd, sourcePath, env)` | import a Claude Code session; present when `capabilities.transfer` is true |
| `probe?(cwd, { timeoutMs, env })` | whether the backend can start at all, within a time limit; present when `capabilities.stopGate` is true |

## One declaration per fact

`capabilities` is the only place a backend says what it can do: `modes`, `webSearch`,
`priorityTier`, `steer`, `resume`, `review`, `adversarialReview`, `stopGate` and `transfer`.
Generic code derives the rest:

- The header check in `jobs/request.mjs` refuses a `mode` or `web-search` value the backend's
  lists lack, with the backend's `request.refusals` text, and ignores `fast: true` with
  `request.priorityTierNote` when `priorityTier` is false.
- The setup page prints `can:` from `capabilities`, with `capabilityNotes.modes`,
  `capabilityNotes.webSearchOff` and `capabilityNotes.lacking` beside the facts they qualify.
- `/relay:review` refuses a review kind the backend lacks.

`request` holds the rest of a backend's rules:

- `headerKeys`: the header keys only this backend takes, mapped to the request field each sets
  (Grok's `grok-home` → `grokHome`, Kimi's `kimi-home` → `kimiHome`). The header parser accepts the union of every backend's keys
  and refuses one given with another backend.
- `defaultSource`: the end of the "is required" message, "Use `model: default` to ...".
- `defaultEffort`: the effort `effort: default` gives a job (`high` on ZCode); null leaves it to
  the backend's configuration.
- `refusals` and `priorityTierNote`: the texts above.
- `complete(request, values, context)`: the backend's own fields, checks and notes, after every
  generic rule passed. Grok resolves its home and refuses extra writable roots in `write`. Codex
  keeps the job MCP servers off that its home's `config.toml` defines and notes the rest.

## The state view

- `view.lines(request)` supplies lines after `backend:`, which generic code prints for every
  backend but the default. Grok prints `grok-home:` for a home other than `~/.grok`, and Kimi
  `kimi-home:` for one other than `~/.kimi-code`.
- `view.settingLines?(request)` supplies backend settings at the settings position of the launch
  block and the state block, after `tier: fast`. Codex uses it for `mcp-off:`.
- `view.json(request)` supplies the backend's fields for `status --json` and `start --json`,
  beside `backend`. Grok adds `grokHome` and Kimi `kimiHome`. A setting line adds no JSON field.
- `view.completionInferenceLine?(inference, { sessionId, turnId })` formats the current attempt's
  recorded inference as a `note:` line, or returns null when it does not apply. Generic code
  passes the inference as backend data and does not read it. Codex checks the inference's thread
  and turn ids against the job's in its own formatter.

## The worker and a connection

The worker owns message accounting: the inbox, outcomes, attempts, retries and recovery. A
connection owns the protocol: what to send, how to read a turn's end, and what the backend's
history proves was delivered. The worker drives a connection like this:

```
connection = await backend.connect(request, hooks)     // spawns the server
opened     = await connection.open({ sessionId, sessionUsed, sessionName })
for each queued item that connection.delivered(item) confirms: outcome delivered-before, skip
for each item to run:
  result = await connection.run({ prompt, clientId, source, onPending, onTurnId })
    while the turn runs and connection.controlsReady(turnId):
      receipt = await connection.steer(turnId, message)
      receipt.unconfirmed → poll connection.steerHeld(id); at turn end connection.steerLost(id)
      cancel → await connection.interrupt(turnId)
  result.unjoinedSteers → next turns; result.droppedSteers → outcomes dropped
await connection.close()
```

`connect` takes the stored `LaunchRequest` and `ConnectHooks`, and returns a `Connection`. The
backend object has no session methods; each connection keeps its request, session id, replay
evidence and control state.

- **Hooks.** `env` is the server's environment. `state` is the backend's record as last saved,
  and `saveState(patch)` merges a patch into `job.backendState` and writes `job.json` before it
  returns, so a backend can save delivery evidence before it sends the request it describes.
  `tap(notification)` records every notification and every event the backend records itself.
  `onSpawn`, `onStderr` and `onEnd` let the worker record the server's identity, its stderr and
  its end.
- **`open`** opens a new session or resumes `sessionId`. `sessionUsed` says whether a turn ever
  ran on it, so a backend can tell a lost draft from lost work. `ephemeral: true` asks for a
  session the backend may forget (reviews). It returns the session id, whether it resumed, the
  service tier where the backend reports one, and notes the worker prints once as `note:`.
- **`delivered(item)`** says whether a work item reached the session before a previous worker
  died. Every item carries a string `clientId`, including the replacement report prompt after
  recovery.
- **`server`** exposes the process's end: `exitInfo`, `exitSeen`, `exitResolved`, `exitPromise`
  and the last 4 KiB of its stderr.

`run` never throws for a failed turn. It returns a `TurnResult`:

- `turnStatus` is `completed`, `failed` with an `error`, or `interrupted`. A turn that ends
  because the server died returns `failed` too; the worker reads `connection.server.exitInfo`,
  records the transport error from `endMessage`, and resumes the session once.
- `finalMessage` becomes the report. `completionReadError` keeps it when the turn ended but its
  completion could not be read, and `completionInference` records how a completion was inferred.
- `retryable: false` tells the worker the backend retries model calls itself (ZCode), so a
  capacity error fails the turn at once.
- `capacity: true` identifies a capacity or request-rate failure from the backend's protocol.
  Codex sets it from its error kind even when the error's text has no limit wording. The worker
  also recognizes capacity and request-rate text, with the same retry schedule for both.
- `didWork` decides how a capacity retry goes: as the same prompt again, or as a continuation.
- `unjoinedSteers` are steers the backend accepted and lost before a turn took them; they run
  next. `droppedSteers` are steers the backend may still hold; they are reported dropped and
  never sent again.
- `teardown: true` says the backend took the prompt but cannot show that it started, and may
  still hold it. The job fails with `error`, the prompt's message is reported dropped (a brief is
  no longer owed), and the round ends: nothing more goes to that server, which the worker closes.
  Work still queued stays owed. The decision is durable: the write that fails the attempt also
  records `teardown` on it (the delivery's `clientId`, the message id, the source) and clears a
  brief's `pendingFirstTurn`. Every round rebuilds a missing `dropped` outcome from it before it
  works out what is owed, so a worker killed after any later write never sends the prompt again.
  The backend's delivery evidence stays.
- `reasoningSummary` and `stderr` feed a foreground result. A backend that filters its transport
  diagnostics returns `stderr`; without it, a review uses the server's stderr.

`eventRecorder(write, touch)` decides what reaches `events.jsonl`. Every notification calls
`touch`, which moves the job's last-event time. Codex writes every notification, Grok joins
streamed chunks into one entry, ZCode leaves out telemetry, token deltas and tool progress, and
Kimi joins chunks and leaves out command lists and a running tool's progress.

A connection may take a turn's outcome from somewhere other than its protocol's answer. Kimi's
ACP layer answers `end_turn` for a turn that failed, and sends nothing for a turn Kimi starts on
its own, so its `run` reads the session's `wire.jsonl` for the turn's end and report. Such a
connection owns one reader of that record and one observer: `run`, `interrupt` and `close` abort
the observer and wait for it to stop, because an observer left polling keeps the worker alive. A
backend
whose turns take no message mid-turn throws from `steer`, and the worker runs the message as the
next turn.

## Backend state

The worker merges each `saveState` patch into `job.backendState`, and a new worker hands the
saved record back as `hooks.state`. Grok stores `binary`, `promptIds` and `deliveries` there;
Kimi stores `binary` and `deliveries`; ZCode stores `binary`; Codex stores nothing. A Grok delivery holds its message id, kind, text,
method, session id, timestamp and the count of matching copies Grok held before sending.
Refusing or giving up an interjection saves `refused` and moves later identical open deliveries
down one place. The next connection checks this record against session replay and persisted
history before it resends work. A Kimi delivery holds the message id, kind, exact text, session id,
timestamp, and the byte offset of the session's `wire.jsonl` before sending; after a death, a
prompt with that text first recorded after the offset means the message arrived.

## Reviews

`review` is a `ReviewSupport`:

- `schema` is `"turn"` when the adversarial schema reaches the model as the turn's
  `outputSchema` (Codex), or `"prompt"` when it goes in the prompt (Grok, ZCode).
- `inlineDiff: true` means the review reads only a diff inlined in its prompt, so the inline
  limits apply, and `inlineDiffAdvice` ends the refusal of an oversized diff.
- `native?(request, target, hooks)` runs the backend's own reviewer for `/relay:review`. Codex's
  starts `review/start` on an ephemeral read-only thread. Without it, the plugin's
  `prompts/review.md` runs, and `nativeEffortNote?(effort)` is the note for an effort the native
  reviewer ignores.
- `prepare?(request)` checks that the backend can run before the review collects its input.
  Codex's checks the Codex CLI.

A prompt review uses `connect`, `open` with `ephemeral: true`, and one `run` on a read-only
request. Codex's adversarial review passes `outputSchema` on that turn. The foreground process
owns the review's job record and saves `saveState` patches to its `backendState`.

## Setup

`setup` is a `SetupProbe`:

- `homes(env)` lists every home of the backend in page order, and `home(value, env)` picks the one
  `setup --backend <name>` checks. `homeFlag` names the flag that picks a non-default home:
  `grok-home` for Grok.
- `prepare(context)` starts once per page for every home of the backend: the binary and its
  version.
- `check(home, shared, context)` returns the home's block within the page's limits, 10 seconds
  per command and 20 seconds per app-server.
- `signInText?(block)` replaces the generic sign-in line where it does not fit, and
  `nextSteps(block, context)` says what to do next for the block.
- `reviewGateNextStep?` is the line the page prints while the stop gate is off.

## Adding a backend

A backend that follows the contract can still misread when a turn ends, what a mode allows, or
what a session holds after a crash. The structure below is the easy part; the probe, the tests
and the live checks are what make a backend safe to run unattended.

### Probe the harness first

Measure the installed version before designing anything, and read its source or documentation
for what a run cannot show. Run the probes with trivial prompts (answer one word, sleep, write one
file) in scratch folders outside every repository, with a home whose state you can afford to
change, and keep the drivers and their logs with the findings. Establish:

- **The handshake** and the capabilities the server declares.
- **A session's start and its restore**: open a session, kill the server with SIGKILL during a
  turn, and restore the session in a new process. Its context must survive.
- **A terminal status for each turn**: the server must say that the turn completed, failed or was
  interrupted, tied to that turn. An end inferred from silence, or from a final answer alone, does
  not count. Make a turn fail on purpose and see what the server reports for it.
- **Steer**: whether a running turn takes a message, what the server answers, and what proves the
  message arrived. An acknowledgement is not delivery: a message can be queued and then lost.
- **Cancel** and the answer that ends the cancelled turn.
- **Model and effort** per session, and the server's answer to a value it does not know.
- **Permissions per mode**: what each mode lets a tool do, and which requests reach the client.
  A permission policy is not a sandbox. A job never gets more access than its header asks for,
  so a mode the harness cannot enforce is a usage error, never a weaker mode.
- **Web search**, and whether it can be turned off.
- **What a session loads**: the home's MCP servers, plugins, hooks, skills, memory and instruction
  files. An empty MCP server list in a request is not isolation.
- **Sign-in**: whether it works headless from a detached process with no terminal, and whether
  two processes, or two homes, can share it without one logging the other out.
- **Durable history**: what the backend writes per session that proves, after a crash, which
  messages arrived.
- **What the harness does on its own**: turns it starts without a prompt, and requests it sends
  the client.

When headless sign-in, a terminal status for each turn, or a restore after a killed server fails,
stop: the backend cannot meet the job contract as it stands.

### Build it

1. A folder with `index.mjs` exporting the `Backend` object, and its tests beside the others in
   `tests/`, driving a fake binary the way `tests/fakes/` does for the backends here.
2. Its name in `BackendName` in `types.d.ts`, and one line in the registry.
3. A section in the `relay:jobs` skill and a row in the README's backend table.

`stopGate` and `transfer` stay true on one backend each, because `backendWith` throws when none
or more than one has them. No runtime code outside `lib/backends/` changes. If one has to, the
contract is missing a member. Add it to `types.d.ts` for every backend instead of branching on a
name.

### Test it

- **A fake built from captured protocol.** Copy the shapes the probe recorded: ids, field names,
  error codes and data, the order of notifications, and the server's quirks. A fake written from
  documentation alone tests the documentation. The fake records every request, its arguments and
  its environment.
- **Exact assertions.** Assert the params of every request, the capabilities the client declares,
  the environment the server gets and the variables it must not inherit, and the outcome each
  path records.
- **Isolated homes.** Every test runs in a scratch home. `tests/support/isolate-env.mjs` strips
  inherited variables a backend reads, and no test may reach a real backend binary on `PATH`. A
  fake refuses to write under a real home.
- **Death around delivery.** Kill the server, and the worker, before and after the backend
  recorded a message, and check that each message runs exactly once.
- **Tests that bite.** A test must fail with the behavior it guards removed. Run targeted
  mutations of the new code; a mutation that survives is a missing test or dead code.

### Check it live, then review it whole

- With the real binary, check the companion run directly and Claude Code end to end separately:
  start, a steer mid-turn, continue after the end, cancel, recovery after a killed server and a
  killed worker, both reviews, a foreground `relay:job` agent, a Workflow call adopted after a
  retry, and a background agent messaged with `SendMessage`. Record the versions, job ids and
  states.
- After fixing what the review and the live checks found, review the whole system again, the
  existing backends included, and compare the versions as well as the diff.
