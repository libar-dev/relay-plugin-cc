# Kimi Code

What the Kimi backend rests on. [design.md](design.md#kimi) says what the backend does; this page
gives the facts about Kimi Code 2.2.0 that it is built on, how they were measured, how to measure
them again on a new Kimi version, why the backend is built the way it is, and the Kimi features it
leaves for later. Read it before you change `lib/backends/kimi/` or move to another Kimi version.

Each fact carries where it comes from:

- **[source]** read in the JavaScript bundled in the 2.2.0 binary;
- **[docs]** from Kimi Code's documentation, <https://moonshotai.github.io/kimi-code/en/>;
- **[live]** measured with Kimi Code 2.2.0 in October 2026, with the probe described below.

## Reading Kimi's source

Kimi Code 2.2.0 is a Node single-executable application. Its JavaScript is one bundled CommonJS
script, about 22 MB, stored as plain text in the binary's `NODE_SEA_BLOB` resource. On Linux that
resource is an ELF note: `readelf -S -W kimi` lists it as the largest NOTE section, about 66 MB for
2.2.0, with no section name. Copy that section out by the offset and size `readelf` prints, and cut
the script from its first line, `Object.defineProperty(exports, Symbol.toStringTag, { value:
"Module" });`, to `exports.main = main;`.

Kimi's ACP server is the part of the bundle around `ACP_BUILTIN_SLASH_COMMANDS`, `driveLaunch` and
`driverFor`. This page names functions and constants rather than line numbers, so a reference
still finds its place in another copy of the bundle.

## The protocol, as of 2.2.0

### Process and handshake

- `kimi acp` speaks ACP over stdio: newline-delimited JSON-RPC 2.0, protocol version 1, built on
  `@agentclientprotocol/sdk` 1.3.0. It prints no banner. Logs go to stderr and `<home>/logs/`. EOF
  on stdin ends the server with exit 0. [live]
- `initialize {protocolVersion: 1, clientCapabilities: {}}` answers `loadSession: true`,
  `promptCapabilities {image: true, audio: false, embeddedContext: true}`, `sessionCapabilities`
  with `list`, `resume`, `close`, `delete`, `fork` and `additionalDirectories`, `mcpCapabilities`
  `http` and `sse`, `auth.logout`, one auth method `login` of type `terminal`, and
  `agentInfo {name: "Kimi Code CLI", version: "2.2.0"}`. [live]
- The server registers `initialize`, `authenticate`, `logout`, `session/new`, `session/load`,
  `session/resume`, `session/list`, `session/close`, `session/delete`, `session/fork`,
  `session/set_mode`, `session/set_config_option`, `session/prompt`, the notification
  `session/cancel`, and the extension request `session/set_model`. Any other request is `-32601`;
  an unknown notification is dropped. No Kimi method steers a turn or queues a prompt. [source]
- A client that declares no `fs` or `terminal` capability gets file IO and shell commands run
  locally, inside the server. [source]
- `kimi acp` skips the update check that the main command runs. `KIMI_CODE_NO_AUTO_UPDATE=1` also
  stops the swap to a staged update at startup. [source]

### Sign-in

- A home is chosen with `KIMI_CODE_HOME`. A fresh home starts signed out and signs in with
  `KIMI_CODE_HOME=<home> kimi login --region <global|mainland-cn>`, a device-code flow. [docs, live]
- The managed provider keeps its OAuth token in `<home>/credentials/<name>.json`. A refresh runs
  under a lock across processes (`proper-lockfile` on `<home>/oauth/<provider>`, 120 retries,
  stale after 5 s) and fails if it cannot take the lock, so jobs in one home never race the
  rotation of the refresh token. Two homes holding a copy of one credentials file do race it.
  [source]
- `newSession` calls `ensureAuthed()` before anything else, so a signed-out home fails
  `session/new`, and `session/load`, at once with `-32000 "Authentication required"`. Nothing but
  `logs/` is written into the home. [source, live]
- Sign-in works headless: a process started with `setsid`, stdin `/dev/null` and no terminal ran
  turns on the stored token. [live]
- The region comes from OAuth environment overrides, then the stored login, then `<home>/region`,
  then the mainland default. The marker counts only before the first login. A new home has
  neither, so `kimi login` without `--region` signs it in to mainland China (kimi.com), and an
  account on kimi.ai needs `--region global`. Every login line relay prints names the region.
  [source]

### Sessions and the record

- `session/new {cwd, mcpServers, additionalDirectories?}` returns `sessionId`, `configOptions`
  (model, thinking, mode) and `modes`. [source]
- `session/load {sessionId, cwd, mcpServers}` restores a session from disk and replays its history
  before it answers: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call` and `tool_call_update`, with no message ids and no turn ends. `session/resume` is the
  same without the replay. An unknown id is `-32602`. [source]
- A session killed with SIGKILL mid-turn loaded in a new process in about 270 ms, and its next turn
  answered from the first message's context. The model and the effort survived the load; the mode
  came back `default`. [live]
- A session lives in `<home>/sessions/<workDirKey>/<sessionId>/`, with `state.json` and
  `agents/main/wire.jsonl`, "the main Agent's complete communication record". [docs] The record's
  first line is `metadata` with `protocol_version: "1.5"`. Its format is not documented.
- The record is durable. Kimi's append log writes each batch on a microtask with `durable: true`,
  and every record was on disk within milliseconds of the prompt's answer, though a read in the
  same tick missed them. [source, live]
- A prompt leaves these records, in this order [source, live]:
  1. `agent.message.appended`, the user input, with `meta.source: "input"` and `meta.promptId`;
  2. `agent.turn.started`, whose `queueItemId` is the prompt id;
  3. `turn.prompt {input, origin, promptId, turnId}`;
  4. `agent.message.appended` for each assistant and tool message;
  5. `agent.turn.ended`, then `turn.ended {turnId, reason, error?}`;
  6. `prompt.completed`.

  `turn.started` exists as an event to observe, but Kimi never writes it to the record. Engine
  records and the semantic records travel separate asynchronous paths, so join them by id, never by
  what sits next to what. [source]
- Kimi's turns come in two kinds. Engine turns are `agent.turn.started` and `agent.turn.ended`.
  Prompt turns are `turn.prompt` and `turn.ended`. A background task's notice that arrives as a
  prompt turn ends runs as a second engine turn inside that prompt turn. [live]
- A failed turn: ACP answered `end_turn`, while the record held `turn.ended {reason: "failed",
  error: {code: "provider.connection_error", message: "Connection error.", retryable: true}}` and
  `prompt.completed {reason: "failed"}`. A cancelled turn leaves `turn.cancel` and
  `turn.ended {reason: "cancelled"}` and no `prompt.completed`. [live]
- A prompt a `UserPromptSubmit` hook blocked leaves no user input record and no `turn.prompt`: only
  a `context.append_message` with its id and `prompt.completed` with reason `blocked`. A queued
  prompt cancelled before it started leaves `prompt.aborted`. [source]
- `UserPromptSubmit` hooks put their text in front of the prompt's own parts
  (`content: [...ctx.hookParts, ...originalParts]`). Each hook part carries
  `meta.source: "user prompt submit hook"`, and the record keeps that mark. [source]

### Turns over ACP

- `session/prompt {sessionId, prompt: [content blocks], _meta?}` stays pending until the turn ends
  and answers `{stopReason}` alone: no usage, no turn id. The request has no field for a message
  id, so the client cannot name its prompt. [source]
- Stop reasons come from the engine's `turn.ended` reason: `completed` is `end_turn`, `cancelled`
  is `cancelled`, `blocked` is `refusal`, `failed` with `provider.filtered` is `refusal`, and **any
  other `failed` is `end_turn`**. A turn that failed on sign-in rejects the request with
  `auth_required`; a launch error is `-32603 "session prompt failed"`. The stop reason cannot tell
  a failed turn from a completed one; the record can. [source]
- A second `session/prompt` while ACP drives one is refused at once: `-32600` "another turn is
  already in progress", `data.code: "turn.agent_busy"`. The engine would queue it, but the ACP
  layer tracks one prompt in flight. [source, live]
- A prompt sent while Kimi runs a turn of its own, one ACP does not drive, is queued.
  `AgentPromptChannel.submit()` returns `undefined` when the loop is running, paused or holds a
  queue, and `driveLaunch` answers that with `end_turn`, or `cancelled` after a cancel request. ACP
  never mentions that prompt again: its update handlers find no driver through `driverFor(turnId)`
  and return, and `session/cancel` returns when no driver is active. Only the record shows the
  queued prompt's turn and outcome. [source]
- The hand-off to a queued prompt is not atomic. When the engine goes idle, its gate
  (`promptGateActor`) runs the prompt hooks before `commitPendingToHistory` appends the queued
  input, and the record's batches drain separately. A read can find Kimi's own turn ended and no
  next prompt yet. In one live run the next prompt's `turn.prompt` was written 1 ms before the own
  turn's `turn.ended`. [source, live]
- `session/cancel {sessionId}` cancels the turn in flight, even one whose turn id is not known yet,
  and aborts a prompt still compressing its images; the prompt then answers `cancelled`. A
  JSON-RPC `$/cancel_request` takes the same path. A cancel of a `sleep 47` answered 19 ms later,
  and Kimi ended the child. [source, live]
- **A prompt that starts with `/` may never reach the model.** When the first content block is
  text that starts with `/` and its first word, up to the first space, holds no other `/`, the ACP
  layer reads it as a command: a skill of that name (`/skill:<name>` too), one of the built-ins in
  `ACP_BUILTIN_SLASH_COMMANDS` (`compact`, `status`, `usage`, `mcp`, `tasks`, `help`), or else
  "Unknown ACP command: /<name>" and `end_turn`, with no model call. So `/tmp is full` is a command
  and `/home/x/y is broken` is a prompt. Only the first block is checked: the same text after an
  empty text block reached the model, which quoted it back byte for byte. [source, live]
- Kimi starts turns of its own. A background command that finished 15 s after an idle turn started
  a turn with `turn.prompt` origin `task`, a tool call and an answer; over ACP the client saw one
  `usage_update`. [live]

### Model and effort

- The model is `session/set_config_option {configId: "model", value}`, the effort
  `{configId: "thinking", value}`. A thinking value must be one of the model's `support_efforts`,
  plus `off` unless the model is always thinking; `on` is the model's default. Anything else is
  `-32602 "Unknown thinking value: <v>"`. A model the home does not configure is `-32603` with
  `data.details` "Model … is not configured in config.toml.". [source, live]
- The managed provider offered `kimi-code/k3` (K3, the default), `kimi-code/k3-256k`,
  `kimi-code/kimi-for-coding` (K2.8 Preview) and `kimi-code/kimi-for-coding-highspeed` (K2.7). K3
  takes `low`, `high` and `max`, and refuses `medium`, `xhigh` and `off`; K2.7 offers `on` and
  `max`. [live]
- When `KIMI_MODEL_NAME` is set, Kimi builds a temporary provider and model from the
  `KIMI_MODEL_*` variables, ahead of the home's default model; `KIMI_MODEL_THINKING_EFFORT` sets
  its effort. `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP=1` gives a failing step one attempt, with no retry.
  [docs, live]

### Modes and permissions

- The ACP modes map onto the engine (`acpModeToToggles`): `default` is permission `manual`,
  `plan` is plan mode with `manual`, `auto` is permission `auto`, and `yolo` is permission `yolo`.
  `session/set_mode` or `set_config_option {configId: "mode"}` sets one. [source]
- ACP's descriptions ("auto: auto-approve safe operations", "yolo: auto-approve everything")
  contradict the docs, which call the engine's `yolo` "Ask When Needed" (risky actions, sensitive
  files and plan exits still ask) and `auto` "Never Ask". [source, docs] The docs are right. A
  prompt to delete a folder with `rm -rf`, write a file and run `ls`: [live]

  | ACP mode | What asked |
  |---|---|
  | `default`, every request rejected | the `rm -rf`; after the rejection the model stopped, and nothing ran |
  | `auto` | nothing; all three ran |
  | `yolo` | the `rm -rf` alone |
  | `plan` | leaving plan mode, then every shell command and write |

- Approvals reach the client as `session/request_permission`, with the options `approve_once`,
  `approve_always` and `reject`. The same request carries the agent's questions when the client
  has no form for them. [source, live]
- In a git work tree, Kimi's own policy approves `Write` and `Edit` inside the workspace without
  asking. A client that declares `fs.writeTextFile` receives them as `fs/write_text_file` and can
  refuse them. [live]
- Kimi's file adapter emulates an append as a read and a write through the client only when the
  client declares both; otherwise `appendText()` writes to the local file itself. Binary writes and
  exclusive creates always stay local, and `Write` creates missing parent folders locally before its
  routed write. [source]
- Kimi has no OS sandbox and no write boundary for its shell. Its modes are approval policies.
  [docs]
- The web tools are `WebSearch` and `FetchURL`. Kimi's default rules approve them in every mode,
  and ACP cannot remove a tool. [source, live]

### What a session loads

- `session/new`'s `mcpServers` is an overlay, and an empty list means no overlay, not no servers.
  Every session connects the home's `mcp.json`, the MCP servers of enabled plugins and, when the
  folder is trusted, the project's `.mcp.json` and `<cwd>/.kimi-code/mcp.json`. No environment
  variable turns them off; `enabled: false` in the file does, or a home without them. [source]
- Connecting a remote MCP server that has no token runs the MCP SDK's OAuth discovery and dynamic
  client registration, which writes a client record into the home's MCP credential store.
  [source]
- In a home with remote MCP servers and a plugin, Kimi discovered their tools 1.5 to 1.8 s after
  `session/new` and offered the model 67 tools, 40 of them from MCP. The plugin's session-start
  skill went into every session as a system reminder. The first turn's input was about 44k tokens,
  and its first token came after 9.1 s, against 5.5 s for the second turn. [live]
- Skills load from `$KIMI_CODE_HOME/skills/`, `~/.agents/skills/`, the project's
  `.kimi-code/skills/` and `.agents/skills/`, plugins, and Kimi's built-in skills;
  `KIMI_CODE_BUILTIN_PRODUCT_SKILLS=0` drops the built-ins about Kimi itself. Instructions load from
  `$KIMI_CODE_HOME/AGENTS.md`, `~/.agents/AGENTS.md`, the project's `AGENTS.md` and `.kimi-code/`,
  and a project's `.kimi-code/agents/agent.md` with `override: true` replaces the system prompt.
  Hooks are `[[hooks]]` in the home's `config.toml`. Kimi has no memory across sessions.
  `KIMI_DISABLE_TELEMETRY=1` turns off telemetry and `KIMI_DISABLE_CRON=1` the Cron tool. [docs]
- `KIMI_CODE_TRUST_WORKSPACE`, when truthy, trusts the working directory, which loads that
  repository's MCP servers, config folders, skills and instructions. [source]

### Steering

- Over ACP a running turn takes no message: there is no method for it, and a second prompt is
  refused as busy. [source]
- The engine has a prompt queue with steering, reachable only through `kimi web`'s HTTP API:
  `POST /api/v1/sessions/{id}/prompts`, `prompts:steer`, a per-prompt `:steer` and abort, a
  WebSocket event stream, and prompt states `queued`, `running`, `completed`, `failed` and
  `cancelled`. [docs, Reference › Server API]

## The probe

The facts marked [live] come from a probe run before any of the backend was written. Repeat it on
every new Kimi version before you trust the backend on it.

**The client.** It is in [`scripts/kimi-probe/`](../scripts/kimi-probe/). `probe.mjs <scenario>
<outdir>` runs one scenario in the signed-in home `KIMI_CODE_HOME` names (an unknown scenario
lists them), and `p0-signed-out.mjs <outdir>` makes a fresh home under `<outdir>`; both run the
binary `KIMI_BINARY` names. They start the real Kimi, so they are not part of `npm test`.
`acp-lib.mjs` is a small Node ACP client: it spawns `kimi acp` in the work folder, writes
newline-delimited JSON-RPC, and logs every message in both directions, stderr and the exit to a
JSONL file with timestamps. It answers `session/request_permission` by a policy chosen per
scenario (an `allow_once` option, a `reject_once` option, or `cancelled`) and answers any other
client request `-32601`, unless the scenario serves it.

**Each run.** One scenario per run, in a fresh work folder outside every git repository, with a
signed-in home kept for probing, model `kimi-code/k3`, effort `low`,
`KIMI_CODE_NO_AUTO_UPDATE=1` and `KIMI_DISABLE_TELEMETRY=1`. The prompts are trivial: answer one
word, sleep, write one file. After each run, copy the session's folder and count the record types
in its `wire.jsonl`. Keep the logs with the findings.

| Scenario | What it does | What 2.2.0 did |
|---|---|---|
| Signed out | A fresh empty home: `initialize`, then `session/new` | `-32000 "Authentication required"` in under a second; only `logs/` written |
| Two plain turns | Two prompts on one session, each asking for one word | Both `end_turn` with the word; 10.9 s and 5.5 s |
| A failed turn | A temporary provider at a closed port through `KIMI_MODEL_*`, `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP=1` | ACP `end_turn` with no text; the record `turn.ended` `failed` with Kimi's error |
| A shell turn, then a second prompt | Mode `default`, permissions allowed: `printf hello > file && sleep 8`, and 4 s in a second prompt | The shell asked; the second prompt `-32600 turn.agent_busy` at once; the turn completed |
| Kill and load | Mode `yolo`: remember a code word, run `sleep 40`; SIGKILL the server during the sleep; `session/load` in a new process; ask for the code word | Loaded with the history replayed; the code word came back; model and effort kept, mode back to `default`; the `sleep` outlived the server |
| Cancel | Mode `yolo`: run `sleep 47`; `session/cancel` once the tool runs; then another prompt | `cancelled` in 19 ms; Kimi ended the `sleep`; the next prompt ran |
| Effort and model | `set_config_option` with each effort and some unknown values, then other models | As in "Model and effort" above |
| A leading `/` | `/tmp is a directory…` alone, then after an empty text block, then ask for the previous message verbatim | Alone: "Unknown ACP command" in 2 ms, no model call. After the empty block: the model got the text unchanged |
| Web search | Mode `yolo`: find the Node.js project's website | `WebSearch` ran; the answer was the domain |
| Modes | In each ACP mode: `rm -rf` a folder, write a file, run `ls`; permissions allowed, and in `default` also rejected | The table in "Modes and permissions" |
| Read-only by the client | A git work tree; mode `default` with every permission rejected; the client declares `fs.writeTextFile` and `terminal` and refuses `fs/write_text_file` and `terminal/create`; ask to create a file, edit one, run `touch`, and read one | `Write` and `Edit` asked nothing and reached the client, which refused them; the shell asked and was rejected; the read worked; `git status` clean |
| Detached | The two plain turns from a process started with `setsid` and stdin `/dev/null` | Both completed |
| Background work | Mode `auto`: start `sleep 15 && echo …` in the background and end the turn; wait 30 s; prompt again | Kimi ran a turn of its own with origin `task`; ACP showed one `usage_update` |

**What makes Kimi unfit.** Stop if headless sign-in, a terminal status for each turn, or a session
restored after a killed server fails, as [backends.md](backends.md#probe-the-harness-first) says.
For 2.2.0 none failed: the detached run signed in, the record names every turn's outcome even where
ACP says `end_turn` for a failure, and `session/load` brought a killed session back with its
context.

**Checking a new version.** The backend depends on the facts below. Probe each again, update
`tests/fakes/kimi.mjs` to the shapes you see, and run one live job of each kind
[backends.md](backends.md#check-it-live-then-review-it-whole) lists.

| If this changes | What breaks | Where |
|---|---|---|
| The record's types, order or ids, the hook mark, `protocol_version` | Each turn's outcome and report, and delivery after a death | `kimi/wire.mjs`, `kimi/connection.mjs` |
| The stop reasons, or the early `end_turn` for a queued prompt | Telling a failed or queued turn from a completed one; the idle grace | `kimi/connection.mjs` |
| The rule for a leading `/` | A brief read as a command | `transport/acp.mjs` (`promptSession`'s blocks), `kimi/connection.mjs` |
| What a load keeps | Mode, model and effort after recovery | `kimi/connection.mjs` (set again on every open) |
| The meaning of `auto` and `yolo` | What a `yolo` job is asked | `KIMI_MODES` in `kimi/connection.mjs` |
| How writes, appends and shell commands reach the client | `read-only` | `kimi/connection.mjs`, `kimi/files.mjs` |
| The refusal texts for model and effort | The start's error | `kimi/connection.mjs` |
| `kimi provider list --json`, the credentials file | Setup | `kimi/setup.mjs` |
| `KIMI_CODE_HOME`, the update and cron switches, the `KIMI_MODEL_*` and trust variables | Isolation of a job | `kimi/connection.mjs`, `kimi/request.mjs` |

## Rulings, and why

[design.md](design.md#kimi) states each of these; here is the reason for each.

- **ACP, not print mode or the web API.** ACP gives the session id when the session opens, and
  live controls: cancel, permission answers, file and terminal requests. `kimi -p` gives its
  resume hint only after the run and has no live controls. `kimi web` has prompt ids, prompt
  states, steer and abort, but would need its own design for who owns the server, sign-in,
  reconnects and recovery.
- **The record decides each turn.** ACP answers `end_turn` for a failed turn and for a prompt Kimi
  only queued, and says nothing about a turn Kimi starts itself.
- **One reader, by byte offset.** Separate reads of the record, of the running turn and of the
  file's size can miss a turn that starts between them. One reader keeps a partial line, and a
  UTF-8 character split across writes, for the next read, and tracks turns and prompts by Kimi's
  ids.
- **Delivered is the input record.** Kimi commits the user input before it writes `turn.prompt`.
  Counting only `turn.prompt` would resend a message whose server died between the two.
- **A hook's text is set apart.** Hook text goes in front of the prompt, so matching on the whole
  input misses the prompt. Matching on any part let a recovery prompt's hook text stand for a brief
  lost with its server. Only the prompt's own parts count.
- **An idle-only grace, then teardown, never a resend.** Time Kimi spends on a turn of its own must
  not use up the wait for a queued prompt. When the grace runs out, the message may still have
  arrived, since hooks and persistence can be slow, so the job fails, the message is dropped and
  the server closes. Sending it again could run it twice. The decision is written with the failed
  attempt, so a worker death after it changes nothing.
- **A steer becomes the next turn.** Nothing reaches a running turn over ACP.
- **A cancel of a queued prompt closes the server.** ACP's cancel reaches only the prompt it
  drives.
- **`yolo` is Kimi's `auto`.** Kimi's `yolo` still asks before risky actions, and a job runs
  unattended. A permission request that still arrives gets an allow option.
- **`read-only` is enforced by the client.** Kimi's `default` mode with every request rejected
  still lets its git policy write inside a work tree, so the client declares writes and terminals
  and refuses each. It declares and serves reads too, or an append would stay local. A read opens
  without blocking and serves a regular file of up to 8 MiB, at most eight at once, because a read
  of a FIFO would block and outlive the job. `write` is a usage error: Kimi has no workspace
  sandbox, and a job never gets a weaker mode than its header asks for.
- **`web-search: live` only.** ACP cannot remove tools, and Kimi approves its web tools in every
  mode.
- **`fast` is ignored, with a note.** Kimi has no priority tier.
- **`KIMI_BINARY` is the binary.** A name that is not on `PATH` fails instead of falling back to
  `~/.kimi-code/bin/kimi`, which could be another version. Without `KIMI_BINARY`, that location is
  the last fallback, because a detached worker's `PATH` may not name it.
- **The job's environment.** `KIMI_CODE_NO_AUTO_UPDATE=1`, so Kimi never updates under a job.
  `KIMI_DISABLE_CRON=1`, so nothing schedules a turn for later. Inherited `KIMI_MODEL_*` variables
  are dropped, because they replace the header's model and effort, and so is
  `KIMI_CODE_TRUST_WORKSPACE`, which would load the repository's MCP servers and instructions.
- **The home is the user's.** An empty `mcpServers` adds nothing, and the home's MCP servers,
  plugins, hooks, skills and instructions stay. For jobs, the advice is a home without MCP
  servers or plugins, signed in with its own `kimi login --region`, never a copied credentials
  file.
- **Sign-in advice at open.** Kimi checks the sign-in at `session/new` and `session/load`, so the
  `kimi login` line for the job's own home, with its region, goes there, not only on a prompt.
- **A leading empty text block.** It keeps a brief or message that starts with `/` from being read
  as a command, and the model reads the text unchanged.
- **No retries by the worker.** Kimi retries model calls itself, 429 and 5xx included.
- **The report is the turn's text after its last tool call**, read from the record.
- **A notice inside a later turn stays in its report.** When a background task's notice is handled
  inside a later prompt turn, the turn ends on Kimi's answer to the notice, and that answer is the
  report. It is Kimi's own end of the turn. Cutting the report at the notice is the alternative.
- **Setup starts no session.** It runs `kimi --version` and `kimi provider list --json` and reads
  only the model fields, since that output carries the provider's API key field. It checks that
  the credentials file exists without opening it, and makes no model call.

## Another Kimi plugin

[`linxule/kimi-plugin-cc`](https://github.com/linxule/kimi-plugin-cc), compared at 2.2.1, runs one
`kimi -p --output-format stream-json` per call and keeps read-only jobs to a set of tools with a
`PreToolUse` hook. The Kimi backend took from it: an explicit binary, launch settings that do not
change, no auto-update, acceptance pinned to Kimi versions, dropping `KIMI_CODE_TRUST_WORKSPACE`,
one owner for every abort with a teardown that is waited for, and one absolute home for the check,
the login advice and the job.

It did not take:
- **Exit 0 as completion.** Kimi's print runner can warn and return while a turn is still active.
- **A hook as the read-only boundary.** Kimi's hooks allow when the hook fails to start or times
  out, and a write to the active plan file can skip later hooks.
- **Print's resume hint for session identity.** It arrives only after the run.
- **Switching regions**, which that plugin proposed and did not build. A marker file is not a
  sign-in, and changing two variables is not an atomic account switch.

## Left for later

The backend gives the core: jobs through the relay, steer, continue, cancel, resume, both reviews
and setup. These Kimi features are left out, with what each would take:

| Feature | In Kimi Code 2.2.0 | Over `kimi acp`? | Evidence |
|---|---|---|---|
| Agent swarm | The `AgentSwarm` tool: one prompt template over up to 128 items, each a subagent, with one report | Already reachable as a tool the job's model may call; in a mode that asks, relay's permission answer decides | docs, Reference › Built-in Tools |
| Goal mode | `/goal <objective>`: turns that continue on their own toward an objective, with pause, resume and a queue; `kimi -p "/goal …"` exits 0, 3 or 6 | No: `goal` is not in `ACP_BUILTIN_SLASH_COMMANDS`, so ACP answers "Unknown ACP command" | docs, Reference › Slash Commands; source |
| Plan mode | Plan first, then ask before editing | Yes, as the ACP mode `plan` | docs, Guides › Interaction; source, `acpModeToToggles` |
| Steering through the engine's queue | `kimi web`: prompts steered into the running turn, prompt states | No; it needs `kimi web` as a second transport | docs, Reference › Server API |
| A subagent model pool | `[secondary_model]` in the home's config | Home configuration; nothing for the header | docs, Configuration › Config Files |
| 1M-token context | `kimi-code/k3` and `kimi-code/kimi-for-coding` declare `max_context_size = 1048576` | A choice of `model:` | the home's model list |
| Patch-only parallel writes | Not a Kimi feature: `kimi-plugin-cc`'s swarm writes in throwaway worktrees, returned as a patch | n/a | that plugin |

And three changes to the backend itself:
- **Hold a message until Kimi's own turn ends.** It avoids most early ACP answers and lets ACP
  cancel the prompt. It cannot remove the race between seeing Kimi idle and sending, so the queued
  prompt handling stays.
- **A `PreToolUse` hook for read-only**, as `kimi-plugin-cc` does. It could only add to the
  client's refusals, never replace them, since Kimi's hooks allow on failure.
- **Print mode or `kimi web` as the transport**, for the reasons under the first ruling.

**Not measured:** rate limits, many jobs at once on one plan, and a long turn. The limits that
remain are in [design.md](design.md#known-limits).
