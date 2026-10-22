# Changelog

## 3.0.0 (unreleased)

The Mods plan ([docs/mods/plan.md](../../docs/mods/plan.md)), Phases 1 to 5 and Phase 6's report, built
on the branch `release/3.0` ([docs/mods/release-3.0.md](../../docs/mods/release-3.0.md)). Each phase adds
its entries here.

Phase 1, steer wake:

- A message to a running `relay:job` agent reaches the job within seconds. The plugin has a hooks
  module, `hooks/mod/register.js`, with one `session.send` hook: when a message is sent to a relay,
  from the main thread, a subagent or another plugin, it runs `companion wake`, and the relay's
  current wait returns. The guard then delivers the message as before. Until now a message waited
  for the wait to end, up to two minutes.
- A relay waits on its job in steps of up to 540 s (Bash timeout 600 s) instead of 120 s, so a long
  job costs its Haiku relay about a quarter of the model calls.
- A `SendMessage` from another agent, such as an orchestrator subagent or a Workflow agent, now
  reaches the relay's job, while it runs and after it ended. The guard took only the main thread's
  messages; Claude Code marks another agent's as `peer`, and the guard dropped it without a record.
  The Phase 1 live check found it. A relay that lived through the update delivers the peer messages
  it received before it, since none of them has a delivery record.
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
  message `cancel` still cancels a job and lets its relay hand back the cancelled state; it is also
  how to cancel one Workflow agent's job, since TaskStop has no task for one agent of a Workflow.
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

Messages typed into a relay's own view (a fix found by the Desktop and CLI passes):

- **A line the user types into a `relay:job` agent's view reaches the job.** Claude Code lets a person
  open a running agent's view (↓ in the footer, then Enter) and type at `Message @<agent>…`. Claude Code
  marks such a line as origin `human`, and the guard took only the main thread's and other agents'
  messages, so it dropped the line without a record. After the hand-back the line resumed the relay, the
  job got no turn, and the relay could say it had passed the message on. Now the line is delivered like
  any message: steered while the job runs, a new turn once it has ended, and `cancel` cancels the job.
  No hook names a typed line's recipient, so there is no wake: a line typed while the relay waits
  reaches the job at the relay's next step, at most nine minutes later, or as a new turn when the job
  ends first. A line typed after the hand-back arrives at once. A relay that lives through the update
  delivers the lines it received before, since none of them has a delivery record.
- A line typed right after Esc interrupted the relay in its view resumes the relay and reaches the job
  at once, steering it while it runs.
- A relay that a message resumed after its hand-back must hand back the job's result again; while the
  hook can check it, the relay can no longer end with words of its own. (The block budget, a failing
  hook and a relay whose start failed stay as they were.)
- A relay without `SubagentHandback` whose final message is the exact result inside one code fence is
  no longer blocked: the fence, with no tag or a plain one such as `text` or `markdown`, is ignored. A Haiku
  relay had sent the result fenced nine times and been let go after eight blocks, with no recorded hand-back.
  A Workflow relay's state block may carry the same one fence, and no fence line anywhere else.
- A message of an origin the guard does not know is recorded as a `relay-violation:` line instead of
  being dropped in silence (the harness's own `task-notification` notices are skipped), and the same
  transcript problem is recorded once, not again at every hook call.
- The live suite has a check `typed` (terminal only: T3 Code draws no agent view).

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

Docs:

- [docs/desktop.md](../../docs/desktop.md): relay in the Code tab of the Claude desktop app. It covers what runs
  there, installing with the CLI (the app loads what the CLI installs), the permission modes, a check that it works,
  and how to try a build in one folder. Checked on a Mac in Claude for Mac 3.6556.1 with relay 3.0.0-dev.4.

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
