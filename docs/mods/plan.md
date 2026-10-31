# Relay and Claude Code Mods: the plan

## Current project direction

Decided 31 October 2026: the 2.x line remains the supported workhorse. The 3.0.0.pre implementation did not
establish the required Claude Mods architecture and is not a basis for further implementation; the active
rearchitecture follows Claude Mods standards. Both 2.x and 3.x are reference inputs to `cc-agents`. Keep this
material while it remains useful to that work, and clean it up only when it no longer informs it. The rest of this
document is a historical plan, not a release roadmap. The root `AGENTS.md` carries the same decision for future
sessions.

Written 22 October 2026 against relay 2.2.0 (main @ f1283c9) and Claude Code 2.1.307. It combines three
independent plans in this directory:

- [claude-opus-5-5.md](claude-opus-5-5.md) (Opus 5.5, high)
- [gpt-6.1-sol.md](gpt-6.1-sol.md) (GPT-6.1 Sol, xhigh)
- [gpt-6-astra.md](gpt-6-astra.md) (GPT-6 Astra, xhigh)

All three followed the same brief, [BRIEF.md](BRIEF.md), and checked the preliminary research
([summary](preliminary-research.md)) against the code and the 2.1.307 declarations. The evidence they cite under `/tmp/relay-mods-*` is local scratch and is not committed.
Parts of it hold local job data. The brief framed the work around one user's T3 Code setup. The product
decisions below replace that framing: relay is open source, and most of its users run Claude Code in a terminal
or in Desktop.

## Rules this plan follows

1. **Terminal and Desktop come first, and T3 Code is supported where it can be.** Most relay users don't run it
   inside T3 Code. Everything the module draws targets the terminal and Desktop. What runs without drawing
   (event hooks, commands) also works in Agent SDK hosts, and is expected to work in T3.
2. **Relay agents should behave like Claude agents.** A main thread or an orchestrator should steer, continue,
   stop and spawn a `relay:job` agent with the same calls and the same results as a Claude subagent.
3. **Everyone runs a current Claude Code.** The floor becomes the build the module is verified on, 2.1.307. No
   code or prose exists for older builds.
4. **One solution for each thing.** When the module takes over a job, the old way goes. A fallback exists only on
   the branch while the module is being proven. Each PR's last commit removes it after the live suite passes, so
   no release ever ships a fallback.
5. **The module takes the events only a Mod sees, the commands, and the drawing; tool-call handling stays in
   command hooks.** A Mod hook runs above the plugin's command hooks and is skipped when it fails. That makes it
   the wrong place for the guard and the right place for `session.send`, which no command hook sees.
6. **One test machine.** All development and live testing run on the Fedora ThinkPad, which does nothing else
   meanwhile.
7. **Every PR reviews the rest of the plan.** A phase's PR ends with a review of every later phase, in light of
   what the PR learned: what the live suite showed, what the declarations or the code turned out to be, what was
   harder or easier than planned. The review records which assumptions held, which phases change and why, and which
   questions are new. Its last commit updates this file to match, so the plan on `main` is always the current one.
   The PR body summarises the review.

## What the investigation established

These findings come from experiments that the three plans repeated independently. The cited plan sections hold
the transcripts and the line numbers in the declarations.

- **The module loads everywhere the plugin loads.** That covers the terminal, Desktop, `claude -p` and Agent SDK
  hosts such as T3. Panes, the status line, toasts and log rows are drawn in the terminal and Desktop only. In an
  SDK host, `$.session.surfaces()` is empty and `$.ui.open` returns `no-surface`. The `ui_*` messages reach the
  host, and T3 renders none of them today (Opus §2, Sol §2, Astra §2).
- **A command the module answers costs no model turn.** `command.run` answers report `num_turns: 0` and
  `total_cost_usd: 0`. The module can answer the plugin's own markdown command and keep its `relay:` name (Opus,
  relaycopy).
- **`session.send` fires for every message that leaves the conversation.** That includes the SendMessage tool
  from the main thread or from any subagent, and the module's own `$.session.send` (2.1.307 declarations,
  `SessionSendInput`, `SessionSendOrigin`). It fired 6 ms after the tool call. A classic `PostToolUse` on
  `SendMessage` fired at 51 ms and doesn't see `$.session.send` (Opus §2). The receiver's `session.receive`
  fires only at its next tool round, 25.9 s later in the experiment.
- **`$.agent.list()` lists the session's agents with their ids.** `session.send`'s `to` can be a name or an id,
  so the module can resolve either.
- **`agent.spawn` fires for the Agent tool and for a Workflow script's `agent()`.** It can deny a spawn with a
  reason, and the caller gets that reason as an error.
- **The Mod API has no event for an agent being stopped.** `TaskStop` is a tool call, so a command hook sees it.
- **`$.process.run` cuts each stream at 4 MiB and still exits 0.** It only sets the truncation flags. It can also
  time out after its child has done its work (Sol §2, both measured). `status --all --json` is 1.29 MB for 473
  jobs.

## Steering, and the other agent calls

The [design](../design.md#the-interface-the-main-thread-sees) compares a `relay:job` agent with a Claude
agent. These are the calls where the two still differ, and what this plan does about each.

| Call | Claude agent | `relay:job` agent today | After this plan |
|---|---|---|---|
| `SendMessage` while it runs | reaches it between tool calls | reaches the job within about two minutes | about two seconds, plus the backend's own delivery (below) |
| `SendMessage` after it ends | continues it with its context | a new turn on the same backend session | unchanged: already the same |
| `TaskStop` | stops it | stops only the relay; the job keeps running | stops the relay and cancels the job |
| Spawn with a bad parameter | the Agent call fails at once | a relay starts, `start` fails, the relay hands the error back | the Agent call, or the Workflow `agent()`, fails at once with the parser's message |
| A message from the agent to its parent or a peer | `SendMessage` | not possible: a backend has no way to send one | investigated in Phase 6 |

**How a steer travels today.** The lead's `SendMessage` queues the message for the relay agent. The relay is a
Haiku agent blocked in `companion wait`, which the guard bounds at 120 seconds. When the wait returns, the relay
makes its next tool call. The `PreToolUse` guard reads the message from the relay's transcript and records it in
`inbox/relay/` under the relay lock, which makes it run exactly once. The worker then hands it to the backend:

- Codex: `turn/steer` into the running turn.
- Grok: `_x.ai/interject` into the running turn.
- ZCode: `sendText` with `guide` into the running turn.
- Kimi: as the next turn. ACP has no steer, so a running Kimi turn can't take a message.

The waiting is the slow part: up to 120 seconds between the send and the guard.

**What changes.** The module's `session.send` hook sees the message as it leaves the sender. It resolves `to` to
an agent id and runs `companion wake --agent <id>`. When that agent is a relay whose job is running, the companion
writes a wake marker into the job directory. The relay's `wait` sees the marker within a second and returns. The
guard delivers the message on the same path as before. This is the most complete option, for three reasons:

- One trigger covers every sender: the main thread, an orchestrator subagent, a teammate, and the board's buttons,
  which use `$.session.send`.
- It draws nothing, so it works in Agent SDK hosts too (tested). Whether it works in T3 is untested; Phase 1's live suite will check it.
- Delivery keeps one path, the guard's ledger. Nothing else posts a message, so nothing can deliver it twice.

The plans' alternatives were weaker. Sol and Astra planned separate direct steer commands with their own
receipts, which would be a second delivery path. Astra planned a reconciler driven by receiver-side events, which
fire only at the next tool round. Opus planned a classic `PostToolUse` hook, which can't see `$.session.send`.

Once the wake is proven, the 120-second wait is no longer how messages arrive; it only bounds a tool call. It
grows to 540 seconds, inside the Bash tool's 600-second maximum. A long job then costs its Haiku relay about a
quarter of the model calls it costs today, and steering stays as fast. The backend still decides what a steer
means: Kimi runs it as the next turn, and the board and the docs say so.

## Phase 1: the module, and steer wake (one PR)

- `hooks/hooks.json`: add `"modules": ["./mod/register.js"]` beside `"hooks"`. Opus verified that the two load
  together and that `claude plugin validate` passes.
- `hooks/mod/register.js`: one `session.send` hook. It awaits `next(e)`. When the send was delivered, it resolves
  `e.to` through `$.agent.list()` and runs `$.process.run(['node', $.plugin.root + '/scripts/companion.mjs',
  'wake', '--agent', id])`. It returns what `next` returned, and it never refuses or rewrites a message.
- `cli/wake.mjs` (new): finds the relay pointer for the agent (`readRelayPointer`, `lib/harness/relay.mjs:292`;
  `findRelayJob`, `:312`) and writes `<jobDir>/relay-wake.json` when the job is not terminal. Otherwise it exits 0
  and writes nothing.
- A wake stays pending until a guard check covers it. The guard records the time it read the transcript
  (`<jobDir>/relay-wake-checked.json`) before it delivers. `cli/wait.mjs:41-68`, under `--exit-zero-while-running`,
  leaves with the "still running" line while a marker is newer than the last check. The wait's own start time
  plays no part. A message sent between the guard's read and the next `wait` keeps its marker pending, and that
  wait returns at once instead of running out its bound. `lib/jobs/store.mjs:93` `jobPaths` gets both paths.
- Floor: README, CHANGELOG and design.md move to Claude Code 2.1.307. Design.md's "The relay needs no Claude Code
  mod" is replaced by what the module does.
- **On the branch only:** the 120-second wait. The PR's last commit raises it to 540 seconds (the guard sets the
  wait and Bash timeouts) and replaces "within about two minutes" in the README, `agents/job.md` and design.md.

Acceptance, all on the Fedora machine:
- Unit: `wake` writes the marker for a running job's relay, and writes nothing for an unknown agent, a terminal
  job or a missing jobs home. `wait` returns within 2 s of a marker newer than the last guard check, waits on
  through one the guard has covered, and ignores markers without the flag. A marker written after the guard's
  read but before the next `wait` starts makes that wait return at once. This test must pass before the wait
  grows to 540 seconds.
- Mod test kit: the hook calls `next` once and returns its result unchanged. It resolves a name through
  `$.agent.list()`. A thrown `process.run` doesn't change the send's result.
- Live suite, in the terminal and in T3: for each backend, a steer of a running job reaches `inbox/relay/` within
  10 s of the `SendMessage` call, three times out of three. That includes a send from a Workflow subagent, and a
  `$.session.send` from a test module. A continue after the hand-back works as before.

## Phase 2: commands that answer without a model turn (one PR)

`/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` start no model turn, cost no tokens and
show the companion's output exactly. How long a command takes is the companion's time, not a turn's.
`status` and `result` take under a second. `cancel` can take more than 10 seconds: it waits
`RELAY_JOBS_CANCEL_GRACE_MS` (10 s) before it kills the worker. `transfer` waits up to two minutes for Codex's
import (`lib/backends/codex/transfer.mjs:11`). Each handler's `$.process.run` timeout is set above its command's
own deadline, at 60 s for `cancel` and 180 s for `transfer`, so the module never cuts off a cancel or a transfer
that would have succeeded. Today `status.md` and `result.md` ask a model to render or repeat that
output, and all four cost a turn. (`transfer` wasn't in the delegates' plans; it follows the same pattern of
running the companion and showing its output.)

- Four `command.run` handlers on the plugin's own command names. Each runs the companion with argv (never a
  shell) and returns `{ text }`. Either truncation flag, a timeout or a missing exit code becomes an error text,
  never "no jobs". They run when the current turn ends, on every surface. `immediate` is a property of a command
  the module registers itself; the 2.1.307 declarations make it read-only for any other command
  (`CommandDescribeInput.immediate`). In the terminal and Desktop, the board (Phase 4) is how to see jobs during a
  turn.
- `renderJobList` (`lib/jobs/view.mjs:325`) prints the Markdown table that `status.md` currently asks the model to
  build. It becomes the only human format, so `C status` in Bash prints it too.
- `result` keeps `renderResultText` (`view.mjs:278`), because the guard's hand-back compares against it
  (`relay-guard.mjs:346`, `:421`). Any change to how it reads goes there, so the hand-back and the command keep
  one format.
- **On the branch only:** each handler's `.catch` falls through to the markdown body, which first says "the relay
  module did not answer this command". In the PR's last commit, `.catch` returns an error text instead. Each
  markdown body then shrinks to one line ("The relay module answers this command. If you read this, it did not
  load: say so and stop."), and the frontmatter keeps the name and description for the command picker.

Acceptance: `claude plugin validate` passes. A Mod test per command checks argv, cwd and the text passed
through, and covers truncation, timeout, busy (exit 4) and stderr. Node goldens cover the status table. In the
live suite, each command shows its output with no model reply in the terminal and in T3. `claude -p
"/relay:status" --output-format stream-json` reports `num_turns: 0`.

## Phase 3: spawn and stop like a Claude agent (one PR)

- **Spawn check.** The module adds an `agent.spawn` hook for `subagentType: "relay:job"`. It runs `companion
  check-header` on the prompt, which uses `parseHeaderPrompt` and `buildLaunchRequest` (`lib/jobs/request.mjs:29`,
  `:123`) and creates nothing. A bad header returns `{ deny: <parser message> }`. `start` keeps the same parser,
  because it builds the job from it. The check only moves the failure to the spawn.
- **TaskStop cancels the job.** Add a `PostToolUse` command hook with the matcher `TaskStop`. When the stopped
  task is a relay agent with a running job, it runs `companion cancel` for that job. This reverses design.md's
  "TaskStop stops only the agent, and the job keeps running". An orchestrator's TaskStop is an explicit stop, and
  the job is what it means to stop. A relay that dies without a TaskStop (session end, a killed process) still
  leaves its job running, so jobs still outlive Claude.
- The design table and the `agents/job.md` description change to match.

Acceptance: a Workflow `agent()` with a bad header throws the parser's message, and a valid one starts as before.
In the live suite, TaskStop on a running relay leaves the job `cancelled` within 15 s for each backend. Ending the
Claude session during a job leaves the job running. Check first that TaskStop's input names the agent the hook
needs. If it doesn't, record what it does name and how the hook maps it.

## Phase 4: the terminal and Desktop board (separate PRs)

1. **Status line.** `$.ui.status` shows "2 running · 1 owed" for this repository. The module polls only while
   `$.session.surfaces()` is non-empty, with one read in flight.
2. **Board pane** `/relay:board`. It lists the jobs, their backend, state, attempt, owed messages and hand-back
   state, and shows the selected job's report in a `Markdown` element. Its actions are:
   - **Steer** and **Continue** call `$.session.send` to the job's relay agent, the same path as the lead's
     `SendMessage`. They are offered only when `$.agent.list()` holds that relay. The label follows the backend:
     "Queue next turn" for Kimi.
   - **Cancel** runs the same `companion cancel` as `/relay:cancel`, and names the job and attempt again when
     pressed.
3. **Companion JSON, changed in place.** The stop gate, `setup.md` and the jobs skill change in the same PR:
   - every `--json` output carries `schema: "relay.<command>/1"` and `relayVersion`;
   - under `--json`, errors are JSON on stdout (busy keeps exit 4);
   - listings are bounded, with a cursor, and every row names its backend (`view.mjs:189` omits Codex today);
   - a slim row by default, with full attempt records only for one job;
   - cancel takes an expected attempt, checked in `cli/cancel.mjs`, so a press can't cancel a newer attempt
     after an automatic resume.

Rendering reads cached `$.state` and never runs a process. After `/clear`, `/resume` or `/branch` the board
rebuilds from the companion.

Acceptance: Mod tests mount the pane on `terminal` and `desktop`, press each action and assert its call. With an
empty `surfaces()`, nothing polls. The live suite runs the board in a narrow and a wide terminal on Fedora.
Claude Desktop has no Linux build, so the Desktop check is the test kit's `desktop` mount, plus one manual pass on
a Mac before release (open question 2).

## Phase 5: a scripted live suite

Every acceptance step marked "live suite" above is a script, not a manual check. It runs on the Fedora machine
against real backends and writes one record per check, naming the backend, model, relay version, Claude Code
version, surface, result and timing. The suite grows with each phase. Its records are the evidence for a public
capability table per backend, which the [funding principles](#impact-of-the-funding-notes) call for. The table shows
only what the suite has passed.

## Phase 6: messages from a job (investigation, no code yet)

A Claude subagent can `SendMessage` its parent or a peer. A relay job can't. Find out whether a backend can be
given a "send to lead" tool (an MCP server the relay adds to the job) whose messages the module delivers with
`$.session.send` as the relay agent's own. Report what each backend allows, and how a reply would find its way
back, before writing any code.

## Later plans

These features are being considered and will get plans of their own. They are listed here so that this plan
leaves room for them:

- **Model-family guidance.** How each model family behaves, what it does well, and how families complement each
  other in one piece of work.
- **Orchestration strategies for different kinds of work**, such as planning a coding session, executing one,
  architecture design, UX and UI work, and deep research.
- **Orchestration templates.** Skills and UI together: for example, choosing a template on the board to start a
  strategy. The template picker would build on Phase 4's board and its companion JSON.

## What stays where it is

| Responsibility | Where it stays | Why |
|---|---|---|
| Session exports (`session-lifecycle.mjs`) | `SessionStart` command hook | `CLAUDE_ENV_FILE` is a settings-hook contract. A Mod's `session.start` doesn't fire on `/clear`, `/resume` or `/branch`. |
| Relay guard, including `SubagentHandback` and `StructuredOutput` | `PreToolUse` command hook | In a Mod it would run above the guard's place in the chain and be skipped when it fails. It needs Node for locks and transcript reads either way. |
| `SubagentStop` guard | Command hook | Same reasons, plus the eight-block release and the recorded violations. |
| Stop review gate | Command hook | It runs up to 900 s, past `$.process.run`'s 10-minute maximum. |
| Message delivery | The guard and the `inbox/relay/` ledger | The wake only shortens the wait; it posts nothing. |
| The `relay:job` agent | Unchanged | It supplies the background run, the completion notice, `SendMessage` and the Workflow slot. |
| `/relay:setup`, `/relay:review`, `/relay:adversarial-review`, `/relay:rescue` | Model-run markdown commands | They need the model: they ask questions, choose options or present findings. |

## Rejected

- **Moving the guard, hand-back, stop gate or session export into a Mod:** see the table above.
- **Direct steer and continue commands with their own receipts** (Sol D, Astra F2): a second delivery path. The
  board's buttons send as the lead does.
- **A reconciler driven by receiver-side events** (Astra F3): those events fire at the next tool round.
- **New command names** (`relay-jobs`, `relay-status`): a second name for the same command, and command pickers
  that list markdown commands don't list them. Registering them would make the commands `immediate` in the terminal.
  That is the one thing these names would add, and the board covers it.
- **A `bridge` subcommand beside the current JSON** (Sol, Astra): a second interface. The JSON changes in place.
- **A setup form:** `/relay:setup` asks questions and installs things.
- **`$.model.*` summaries of reports, and a model-callable status tool:** reports are shown exactly as written,
  and the model already calls the companion through Bash.
- **agent-harness-kit and a history browser:** a separate product.

## Corrections to the preliminary research

All three plans confirmed its authority split: relay owns execution, the Mod owns commands and presentation, and
the kit owns history. They corrected these points:

- **SDK hosts:** they run the module's hooks, commands and process calls, and they receive the `ui_*` messages.
  Whether those messages are drawn is up to the host.
- **`immediate` commands:** they run during a turn in the terminal. Over stream-json they run when the turn ends.
  Only a command the module registers can be `immediate`.
- **"Relay already exposes enough for a board":** not as an interface for a module. Phase 4 covers the gaps: no
  version, errors in stderr text, an unbounded `--all`, and `$.process.run`'s silent truncation.
- **Hook ordering:** Mod hooks run above the plugin's command hooks. The research didn't say so, and it decides
  where the guard stays.
- **Static analysis:** `$` may be passed to a top-level helper in the same file. Only imported helpers and methods
  are restricted (Sol §7).
- **Declarations:** 2.1.307's replace 2.1.277's. The `classic.PreToolUse` exception still holds.
- **2.2.0 additions:** `handedBackAt`, per-attempt `relayVersion`, `--workflow` listing and missed-start recovery
  are already in place. The status table and the board use them.

## Impact of the funding notes

The funding principles ([funding.md](funding.md)) add no product feature. Four points affect this plan:

- **A capability matrix proved by tests** ("compatibility is earned by tests"). Phase 5 makes the live acceptance
  checks a scripted suite whose records back such a table. Its rows line up with this plan: steering during
  execution (Phase 1), continue (unchanged), stop (Phase 3), dynamic Workflow joining (Phase 3's spawn check),
  and agent-to-parent and agent-to-agent messages (Phase 6, unsupported until proven).
- **A short demo** of steering a running job while a second agent joins. It needs Phase 1's
  two-second steer to be watchable, and the board to be visible. That is one more reason the terminal board is in
  scope.
- **Exact backend semantics.** Kimi takes no mid-turn steer, and read-only
  modes are not an OS sandbox. The board labels Kimi's message as "Queue next turn", and the matrix states the
  limit instead of marking it supported.
- **No paid tier or paid UI.** The module and the board ship in the same open-source plugin.

## T3 Code

In Agent SDK runs, the module's hooks and commands work, so Phases 1 to 3 are expected to work in T3 as well.
No plan has tested this in T3 yet; Phase 1's and Phase 2's live suites will. Phase 4 needs two things
from T3: it has to render the `ui_*` messages, and it has to attach a surface. The module refreshes the status
line only while `$.session.surfaces()` is non-empty. [t3-code.md](t3-code.md) explains what relay would need from T3 and why relay complements T3's
own delegates. It is the article to link from a post to the T3 community.

## Open questions

1. **TaskStop:** Phase 3 makes a TaskStop on a relay agent cancel its job, which reverses a documented decision.
   Is that what you want?
2. **Desktop:** Fedora can't run Claude Desktop. Is the test kit's `desktop` mount enough, plus one manual pass on
   a Mac before each release that changes the board?
3. **Wait bound:** 540 seconds once the wake is proven, or another value under the Bash tool's 600-second
   maximum?
