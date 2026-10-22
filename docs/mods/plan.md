# Relay and Claude Code Mods: the plan

Written 22 October 2026 against relay 2.2.0 (main @ f1283c9) and Claude Code 2.1.307. Phase 1, Phase 5's suite
runner and Phase 3 are done on the branch `release/3.0`, Phase 6's investigation is reported, and the later phases
were reviewed in the light of each ([After Phase 1](#after-phase-1-what-held-and-what-changed),
[After the suite runner](#after-the-suite-runner-what-held-and-what-changed),
[After Phase 6](#after-phase-6-what-held-and-what-changed),
[After Phase 3](#after-phase-3-what-held-and-what-changed)). Phases 1 to 5 ship together as relay 3.0.0
([release-3.0.md](release-3.0.md)); every decision taken on the way is in [decisions.md](decisions.md).
It combines three independent plans in this directory:

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
  so the module can resolve either. It lists no Workflow agent (2.1.308 declarations), and SendMessage reaches
  those by id.
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
| `SendMessage` after it ends | continues it with its context | a new turn on the same backend session | unchanged: already the same (neither a Claude Workflow agent nor a Workflow relay continues this way, [Phase 6](messages-from-a-job.md#relays-under-the-workflow-tool)) |
| `TaskStop` | stops it | stops only the relay; the job keeps running | stops the relay and cancels the job |
| Spawn with a bad parameter | the Agent call fails at once | a relay starts, `start` fails, the relay hands the error back | the Agent call, or the Workflow `agent()`, fails at once with the parser's message |
| A message from the agent to its parent or a peer | `SendMessage` | not possible: a backend has no way to send one | possible as the relay's own `SendMessage`, on every backend in `yolo` and in the other modes with the changes [Phase 6](messages-from-a-job.md) lists, except Grok's `write` and `read-only` (open); not built in 3.0 |

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
guard delivers the message on the same path as before. This is the most complete option, for
three reasons:

- One trigger covers every sender: the main thread, an orchestrator subagent, a teammate, and the board's buttons,
  which use `$.session.send`.
- It draws nothing, so it works in Agent SDK hosts too (tested).
- Delivery keeps one path, the guard's ledger. Nothing else posts a message, so nothing can deliver it twice.

The plans' alternatives were weaker. Sol and Astra planned separate direct steer commands with their own
receipts, which would be a second delivery path. Astra planned a reconciler driven by receiver-side events, which
fire only at the next tool round. Opus planned a classic `PostToolUse` hook, which can't see `$.session.send`.

Once the wake is proven, the 120-second wait is no longer how messages arrive; it only bounds a tool call. It
grows to 540 seconds, inside the Bash tool's 600-second maximum. A long job then costs its Haiku relay about a
quarter of the model calls it costs today, and steering stays as fast. The backend still decides what a steer
means: Kimi runs it as the next turn, and the board and the docs say so.

## Phase 1: the module, and steer wake (done, on `release/3.0`)

What shipped:

- `hooks/hooks.json` lists `"modules": ["./mod/register.js"]` beside `"hooks"`. `hooks/mod/register.js` has one
  `session.send` hook. It awaits `next(e)` once and returns its result unchanged. When the send was delivered, it
  resolves `e.to` through `$.agent.list()` (an id, then a name, else `e.to` as given, since a Workflow's agents
  are not listed) and runs `companion wake --agent <id>` with a 10-second timeout. Errors are caught.
- `companion wake` reads only the relay pointer, never the scan over every job, since it runs on every
  `SendMessage`. It writes `<jobDir>/relay-wake.json` when the agent is the job's current relay, also on a job that
  has ended, since a message can continue it.
- **A marker counts against the boundary the wait came after, not against a guard check.** Claude Code puts a
  queued message into the relay's conversation only after every tool call of an assistant message has returned.
  The rule planned here (a marker is covered once the guard has read the transcript after it) missed a message
  sent after that boundary while the relay's model wrote its next `wait`: its marker is older than the guard's
  read, and the message is not in the transcript yet. A first fix, the wait removing the marker whenever it
  returned, failed review in three cases: a leftover wait of an earlier relay took the current relay's marker,
  two waits in one assistant message let the second run its bound, and a message queued as the job ended found no
  marker. Now the guard reads the boundary from the transcript (the latest timestamp before the assistant message
  that holds the `wait`) and passes it as `wait --wake-after <time>`. The wait returns on a marker newer than
  that. Nothing removes markers, and `wake` marks a job that has ended too, since a message can continue it.
- **The guard delivers messages from other agents.** The live check found that a `SendMessage` from a subagent
  or a Workflow agent reaches a relay with origin kind `peer` (a `queued_command`, or after the hand-back a `user`
  entry), its text in `origin.body`. The guard took only the coordinator's, so such a message was dropped with no
  record, in 2.2.0 too. The fixture is cut from that run.
- The relay waits 540 s with a 600 s Bash timeout. The floor is Claude Code 2.1.307.
- Tests: unit tests for `wake`, `wait` and the boundary, 7 Mod tests (`claude plugin test`; the kit runs only `*.test.ts`),
  parser and end-to-end tests for peer messages. CI installs a pinned Claude Code to run `claude plugin validate`
  and `claude plugin test`.
- Dev tools: `scripts/smoke/` (a tmux pane an agent drives, and an install of a build into one directory),
  `scripts/live/steer-wake.mjs` (the live steer check below; now the suite's `steer-main` check).

Live results on the Fedora machine, Claude Code 2.1.308 (`scripts/live/steer-wake.mjs` and its analyzer, Sonnet
lead). The last terminal run and the T3 run used the final rule, on the build then numbered 2.3.0:

| Surface | Sender | Backends | Delivered to `inbox/relay/` after the send |
|---|---|---|---|
| Terminal | Main thread `SendMessage`, three rounds, three runs | Codex, Grok, ZCode, Kimi | 36 of 36, 1.5 to 4.0 s |
| Terminal | A plugin's `$.session.send` (a probe module's command) | Codex | 4.0 s |
| Terminal | A Workflow agent's `SendMessage`, by agent id | Codex | 2.8 s, and 2.9 s on the installed build (before the peer fix: never) |
| Terminal | Main thread `SendMessage` after the hand-back (continue) | Codex | runs as a new turn, as before |
| T3 Code (Agent SDK host) | Main thread `SendMessage`, three rounds | Codex, Grok, ZCode, Kimi | 12 of 12, 1.5 to 6.7 s |

Kimi took each steer as a next turn, as documented. The release smoke test (`relay-plugin-cc-smoke`) passed on
the installed build (then 2.3.0): the workflow's five agents, the plain fan-out with its refused header, and a steer
from the lead and from a Workflow agent.

## After Phase 1: what held and what changed

Assumptions that held:

- `session.send` fires for every sender the plan named, before the receiver's next tool round, and `$.process.run`
  of the companion costs 75 to 90 ms per send. One trigger covers the main thread, other agents and plugins.
- Delivery keeps one path. The wake posts nothing, and every live delivery went through the guard's ledger.
- A plugin's `$.session.send` reaches a relay as the coordinator's message, with the plugin's name beside it, so
  the board's buttons (Phase 4) need nothing new from the guard.
- `claude plugin validate` and the Mod test kit run without a sign-in, so CI can hold every later phase's Mod tests.

What changed, and where:

- **The wake rule** (Phase 1, above): a marker counts against the boundary read from the transcript. Nothing
  later depends on the planned guard check.
- **Other agents' messages** were never delivered before Phase 1. An orchestrator subagent steering a relay, which
  the steering table counts on, works only from 3.0.0.
- **Phase 4's Steer and Continue** must not depend on `$.agent.list()`. The declarations say the list holds no
  Workflow agent, and drops a subagent some time after it ends, which is when Continue is needed. The buttons
  send to the agent id the job records (`relay.agentId`, `relay.json` after an adoption) with
  `$.session.send({ to: { agentId } })`, and show the send's `reason` when it is refused. Phase 4 must check
  live that a send from the lead's session reaches a Workflow relay by id; Phase 1 checked a Workflow agent's
  send to the lead's relay.
- **Phase 5 starts from Phase 1's tools.** `scripts/live/steer-wake.mjs` writes the record the suite needs
  (backend, model, relay version, Claude Code version, surface, timings, pass). A terminal check runs in a tmux
  pane (`scripts/smoke/pane.sh`) with `--plugin-dir`, so it does not touch the session that starts it. An
  installed build, for the release smoke test and for T3, goes into one directory at local scope
  (`scripts/smoke/install-local.sh`), so the machine's other sessions keep the released plugin. The lead in a
  scripted session must wait with a Monitor until-loop: Claude Code blocks a standalone `sleep`.
- **Phase 6** has its receiving half: a relay now takes a message from any agent of the session. The question
  left is the sending half, from a job back to its parent or a peer.
- Loading a plugin folder with `--plugin-dir` makes Claude Code write declarations into it
  (`.claude-plugin/types/`, `tsconfig.json`). Both are ignored by git and left out of a `--worktree` install.

Phases 2 and 3 are unchanged. Their hooks go into the same `register.js`, and their Mod tests into
`register.test.ts`.

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

## Phase 3: spawn and stop like a Claude agent (done, on `release/3.0`)

What shipped:

- **Spawn check.** The module's `agent.spawn` hook runs `companion check-header` on a `relay:job` prompt:
  `readLaunchPrompt` (`lib/jobs/request.mjs`), the parser and request builder `start` uses, creating nothing. A
  bad header is denied with the parser's message, and Claude Code puts `Subagent spawn denied by a plugin: ` (the
  Agent tool's error) or `Workflow agent spawn denied by a plugin: ` (the error a Workflow `agent()` throws) before
  it. The check leaves relative `cd:`, `add-dir:` and `brief:` paths to `start`, and infers no linked-worktree
  roots unless `cd:` is absolute, since the relay's directory is not known at the spawn (D46). It lets a resumed
  agent and a Workflow prompt with no `---` line through (D45), and fails open on anything but its own refusal.
  `check-header` takes about 80 ms, which every relay spawn now waits for.
- **TaskStop cancels the job** (D2). A `PostToolUse` command hook on `TaskStop` (`scripts/hooks/relay-stop.mjs`)
  takes the stopped agent's id from the tool's result: the input names the agent by id or by name, the result
  always by id (D41). When the agent is its job's current relay and the job has not ended, the hook runs
  `companion cancel`, waits, and gives the caller the cancelled job's block as its context (D43); a failed cancel
  is told to the caller and recorded as a relay violation. Claude Code has no TaskStop for one Workflow agent (D48
  has the exception), and a TaskStop on a whole Workflow cancels nothing, so a resume adopts its jobs (D42); the
  hook lists the run's jobs that keep running (D47). The message `cancel` stays (D44). A stopped relay that runs
  again never hands Claude Code's interrupt note to its job (D48).
- design.md, the relay:jobs skill and internals, `agents/job.md`, the README and architecture.md describe both.
- The live suite: `stop`, `session-end` (a `runTerminal` check that ends the pane's Claude process mid-job,
  waits for its pid to go, and follows the jobs to their end) and `spawn-check`.
- Smoke tooling: `install-local.sh --name` gives a second folder its own install, since Claude Code keeps one
  marketplace registry per config; `uninstall-local.sh` changes nothing of a name whose ownership it cannot verify.
- Two review rounds by GPT-6.1 Sol and Opus 5.5, and a third on the interrupt-note fix (D48). Both rounds found, in
  both families, a way the spawn check could refuse a launch `start` accepts (a relative path, then `mode: write`'s
  worktree roots), and the first found the `stop` check crediting a cancel the hook had not made.

Live results (the Fedora machine, Claude Code 2.1.308, 3.0.0-dev.3, Sonnet 5.5 lead; records in
`docs/live/records/`, table in [docs/live/capabilities.md](../live/capabilities.md)). The phase's own checks and
`steer-main` ran on the final build, 1f274c4; the whole suite ran on f7e474b, which differs from it only in where
the interrupt-note filter applies (D48):

| Check | Terminal | T3 Code |
|---|---|---|
| `stop` | cancelled 0.2–1.4 s after the TaskStop | 0.2–1.1 s |
| `session-end` | ran on, and completed 140–159 s after the session ended | terminal only |
| `spawn-check` | refused at the spawn with the parser's message, all four backends | the same |
| `steer-main` | 2.0–4.0 s to the job's ledger | 2.2–13.3 s (Kimi's 13.3 s with two suites running at once; the limit is 30 s) |
| `steer-workflow`, `steer-plugin`, `continue` (f7e474b) | 3.1–4.1 s | Phase 5's records stand |

64 of 64 records passed on those two builds, and 40 of 40 on 9487e38 before the last two fixes. The cancels of about
a second on 1f274c4 ran beside a T3 run and the smoke kit; alone they took 0.2–0.5 s. The smoke kit passed on the
final build (workflow `wf_f2f4cd17-c20`, then the plain fan-out, whose `hi-refused` was refused at the spawn with the
parser's message).

### After Phase 3: what held and what changed

Assumptions that held:

- TaskStop's `PostToolUse` names the agent the hook needs: the result carries the agent id whatever the caller
  wrote. Claude Code kills the stopped relay's Bash call and fires no `SubagentStop` for it, so nothing of the guard
  runs after a stop.
- `agent.spawn` fires for the Agent tool and for a Workflow `agent()`, with the prompt as the caller wrote it, and a
  deny reaches the caller at once as an error, in the terminal and in T3.
- Command hooks and the module run in T3 as in the terminal; both new checks passed there on all four backends.
- The job's files and the lead's transcript are enough to judge the new checks. A `PostToolUse` hook's output is a
  `hook_additional_context` attachment in the transcript, with the tool call's id.

What changed, and where:

- **A Workflow agent cannot be TaskStopped alone**, and a TaskStop on the Workflow ends all its relays at once.
  Cancelling their jobs would break the resume Claude Code tells callers to do next, so it cancels nothing and says
  which jobs run on (D42, D47).
- **The spawn check judges only what does not depend on the relay's directory** (D46). Both review rounds found a
  false refusal through the directory, the second through Grok's refusal of inferred worktree roots, which every T3
  thread (a linked worktree) would have hit.
- **A Workflow prompt can be a placeholder**: a run that keeps its script from hooks shows the spawn a fixed text,
  so the check leaves a Workflow prompt with no `---` line to `start` (D45).
- **Two smoke installs need two marketplace names.** Phases running side by side each have their own smoke folder,
  and now their own `--name`.
- **A stopped relay can run again** (D48): a message resumes it, or, for a Workflow relay a message has forked, its
  other loop runs on. Claude Code's interrupt note in its transcript was delivered to the job as a message, which
  restarted a job TaskStop had cancelled; the note is now a harness marker. A probe after Phase 6's finding showed
  it; the review rounds had not.
- `pane.sh pid` gives a check the pane's process id: a scan of process arguments for the session id also matched the
  tmux server, which keeps the command line of the session that started it.

The later phases, in this light:

- **Phase 2** is unchanged. Whichever of Phases 2 and 3 merges second rebases `register.js` (two hooks there now)
  and `register.test.ts`.
- **Phase 4.** The board's Cancel stays `companion cancel`: a module cannot call TaskStop, and a press is the user's
  explicit cancel. The board should show what TaskStop leaves for a person to decide: jobs of a stopped Workflow
  that run on with no relay (running and not handed back), and the `relay-violation:` line of a cancel the
  TaskStop hook could not finish. A job cancelled by TaskStop shows `not handed back` in `status` today, since its
  relay never handed back, though the caller saw the cancelled block in the hook's context; the board should not
  flag it as a lost result (the hook could record the hand-back). The companion JSON changed in place must keep `check-header`'s text interface
  (`ok`, or `error: <message>`, exit 1), which the module reads; it has no `--json` and needs none. Steer and
  Continue by the recorded agent id are unchanged.
- **Phase 6** is reported. Its finding that a message by id forks a running Workflow relay was measured here with
  a probe, not a suite check: the message `cancel` reaches the job through the second loop and cancels it, and a
  TaskStop on the forked id cancels the job as D41 says (D48). Its other open point stands: after a fork, Claude
  Code can write later entries to `subagents/agent-<id>.jsonl`, which the guard does not read. The release can turn
  the probe into a check of the message `cancel` to a Workflow relay.
- **The release.** `suite.mjs run all` now has seven checks; `session-end` runs only in the terminal and takes about
  four minutes. The T3 checks are `steer-main`, `steer-workflow`, `continue`, `stop` and `spawn-check`. The
  capability table gains the stop and spawn rows the funding notes list. The smoke kit's `hi-refused` agent is now
  refused at the spawn (`Subagent spawn denied by a plugin: model: glm-5.3-flash is a ZCode model…`), not handed
  back as `state: not started`; the kit's SMOKE-TEST.md says the old form and needs the new one for 3.0.

## Phase 4: the terminal and Desktop board (separate PRs)

1. **Status line.** `$.ui.status` shows "2 running · 1 owed" for this repository. The module polls only while
   `$.session.surfaces()` is non-empty, with one read in flight.
2. **Board pane** `/relay:board`. It lists the jobs, their backend, state, attempt, owed messages and hand-back
   state, and shows the selected job's report in a `Markdown` element. Its actions are:
   - **Steer** and **Continue** call `$.session.send({ to: { agentId } })` with the agent id the job records,
     the same path as the lead's `SendMessage`. A refused send shows its `reason`. `$.agent.list()` does not
     decide whether they are offered: it holds no Workflow agent. The label follows the backend:
     "Queue next turn" for Kimi. This holds for a relay the Agent tool started. For a Workflow job, a send by id
     forks the relay or reaches nothing ([After Phase 6](#after-phase-6-what-held-and-what-changed), D53), and
     Phase 4 decides what the buttons do.
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
empty `surfaces()`, nothing polls. The live check of Steer and Continue reads the job's ledger and attempts,
not the send's `isDelivered` alone, for a relay the Agent tool started and for a Workflow relay. The live suite runs the board in a narrow and a wide terminal on Fedora.
Claude Desktop has no Linux build, so the Desktop check is the test kit's `desktop` mount, plus one manual pass on
a Mac before release (open question 2).

## Phase 5: a scripted live suite

Every acceptance step marked "live suite" above is a script, not a manual check. It runs on the Fedora machine
against real backends and writes one record per check, naming the backend, model, relay version, Claude Code
version, surface, result and timing. The suite grows with each phase. Its records are the evidence for a public
capability table per backend, which the [funding principles](#impact-of-the-funding-notes) call for. The table shows
only what the suite has passed.

### The runner (done, on `release/3.0`)

What shipped:

- `scripts/live/suite.mjs` and a registry of checks in `scripts/live/checks/`. A check is a module: an id, the
  title of its table row, the surfaces it runs on, the probe Mods it needs, a prompt, an analyzer, and the text of
  its table cell. A check that is not a prompt (a `claude -p` run, a session killed on purpose) supplies its own
  `runTerminal`. `run` drives the terminal: a tmux pane with `--plugin-dir`, a fresh jobs home and a Sonnet
  lead. `prepare` and `analyze` are the T3 surface, with the same prompt and analyzer (D22).
- One record per check, backend and surface, in `docs/live/records/<run id>.jsonl`: check, backend, model, relay
  version, Claude Code version (the transcript's, D24), lead model, platform, start and end, timings, how the
  backend took the message, result and reason, and the evidence folder. Records hold no absolute path. The
  evidence stays on the machine in `~/.local/state/relay-plugin-cc/live/runs/`, copied out of `/tmp`, and
  `analyze --from-copy` reproduces a run's records from it (D19).
- `docs/live/capabilities.md`, generated by `suite.mjs table`. A cell is the latest record of a check on one
  backend and surface, shown only when it passed (D20). `npm test` fails when the table and the records disagree.
- Four checks. `steer-main` is Phase 1's script, moved (D23). `steer-workflow` steers from a Workflow agent by
  agent id. `steer-plugin` steers through `scripts/live/probes/wake-probe`, a Mod whose tool sends with
  `$.session.send` (D21). `continue` sends after the hand-back. A steer passes only when the job's outcome for the
  message says how the backend took it: `steered` on Codex, Grok and ZCode, `turn-started` (a turn of its own)
  on Kimi. The table's statement of Kimi's semantics is therefore a measurement. A steer must reach the job's
  ledger within 30 s of the send (D25), a continue within 60 s.
- A terminal run fails when `~/.claude/settings.json` changed during it (D13).

Live results (the Fedora machine, Claude Code 2.1.308, 3.0.0-dev.2 at 6adeeaf, Sonnet 5.5 lead; the records are
in `docs/live/records/` and the table in [docs/live/capabilities.md](../live/capabilities.md)): every check passed on
all four backends, 28 of 28 records.

| Check | Terminal | T3 Code | How the message was taken |
|---|---|---|---|
| `steer-main` (3 rounds) | 2.2 to 4.8 s | 1.8 to 6.2 s | into the running turn; Kimi as the next turn |
| `steer-workflow` | 2.9 to 4.4 s | 5.4 to 7.3 s | the same |
| `steer-plugin` | 3.1 to 4.4 s | terminal only | the same |
| `continue` | 2.2 to 3.2 s | 3.9 to 4.6 s | a new turn of the job |

The smoke kit passed on the same build (workflow `wf_d17160d4-740`, then the plain fan-out).

### After the suite runner: what held and what changed

Assumptions that held:

- Phase 1's tools carried over: `pane.sh`, `install-local.sh`, the per-session bypass setting, with the one fix
  to `pane.sh` below.
- The job's own files are enough to judge every check so far: the relay pointer, `inbox/relay/` for when the
  guard delivered a message, `inbox/outcomes/` for how the backend took it, and the attempts for the version and
  for the turn a continue started.
- A plugin's `$.session.send` reaches a running relay as the lead's `SendMessage` does, also when it is sent
  from inside a `tool.call` hook. Phase 4's buttons need nothing new from the guard.

What changed, and where:

- **A terminal run was not a plain terminal session** (D27). The pane's Claude Code inherited the lead's session
  variables, its messaging socket and token among them, and recorded itself as an Agent SDK child
  (`entrypoint: sdk-ts`); Phase 1's terminal runs did too. `pane.sh start` now removes them, and a record fails
  unless the transcript's entrypoint matches its surface. The suite's terminal records come from clean sessions.
- **A check credits a delivery to its sender and its run only** (D26). Both reviewers found that a steer could pass
  on a record another sender produced, or on an earlier run in the same transcript. The relay's transcript names
  the sender of every message it received, and the analysis is cut to the run's own entries.
- **How a check waits.** A lead that waits in a background Monitor ends its turn, and in T3 it is not woken again
  (D18). The suite's prompts have the lead wait in foreground Bash until-loops and keep its turn until it prints
  the check's marker. Completion notices of background agents and Workflows still arrive between its tool calls,
  in T3 as in the terminal: each T3 run finished in one turn. Every later check's prompt does the same.
- **The steer limit** is 30 s, not 10 s (D25). In T3, Kimi's relay once took 9.3 s for its own Haiku step after
  the wake had ended its wait in under a second.
- **A T3 thread runs the build only if the build is installed in its project folder.** `prepare` reads the
  version from the smoke install's receipt, and a record fails when its job ran another version.

The later phases, in this light:

- **Phase 2.** Its live checks show each command's output with no model reply, in the terminal and in T3, and
  `claude -p "/relay:status" --output-format stream-json` reporting `num_turns: 0`. The `-p` check is a
  `runTerminal` check with no pane; such a session records `entrypoint: sdk-cli`, and a check names the
  entrypoints it accepts and how its entries are scoped (`entrypoints`, `scope`). The pane and T3 checks send a slash command, which cannot carry the prompt's
  first line, `Live suite run <id>.`, by which `analyze` finds a T3 transcript. Phase 2 adds a way: a first
  message that carries the run line before the command, or a transcript named to `analyze`. Whether T3 passes a
  slash command to Claude Code as a command is the first thing to check. These records have no delivery, and
  their cell names the time from the command to its output.
- **Phase 3.** TaskStop on a running relay is a prompt check whose analyzer reads the job's state and the time it
  was cancelled, within 15 s on each backend. Ending the session during a job is a `runTerminal` check that
  stops the pane mid-run and then reads the job, terminal only. The spawn check runs a Workflow whose `agent()`
  has a bad header and reads the parser's message from the Workflow's journal; no job folder may appear.
- **Phase 4.** The board's live check reads the pane's screen in a narrow and a wide terminal, a `runTerminal`
  check; `pane.sh` starts panes at 200×50 and needs a resize. The board can show how each message was taken from
  the same `inbox/outcomes/` the steer checks read, so the companion's JSON should carry the outcome per message.
- **Phase 6** has nothing to measure yet. Messages from a job to its parent or a peer stay out of the table until
  a check proves them.
- **The release** runs `suite.mjs run all` and every T3 check on the release head, commits the records,
  regenerates the table, and puts it in the README with its links adapted (they are relative to `docs/live/`).

## Phase 6: messages from a job (investigation, no code yet)

A Claude subagent can `SendMessage` its parent or a peer. A relay job can't. Find out whether a backend can be
given a "send to lead" tool (an MCP server the relay adds to the job) whose messages the module delivers with
`$.session.send` as the relay agent's own. Report what each backend allows, and how a reply would find its way
back, before writing any code.

**Reported** in [messages-from-a-job.md](messages-from-a-job.md). The four backends were driven directly; the
Claude Code routes were measured in the terminal, four of them repeated in T3; one relay ran under the Workflow
tool on Codex:

- Every backend takes a client-supplied stdio MCP server for one session, with the environment relay gives it,
  and must be given it again on every open. The modes where its call is allowed, how long one call may wait
  (30 s on ZCode, 60 s on Kimi, 300 s on Codex), whether a steer reaches the model while the call waits (only
  on Codex), and what happens to the user's other MCP servers (ZCode drops them) differ, and the report has the
  table.
- The module cannot deliver the message as the relay's: a module's `$.session.send` always sends as the main
  conversation, and `"main"` refuses it. The relay agent can send it itself, with `SendMessage`, its `message`
  and `to` rewritten by the guard with `updatedInput`, as the guard rewrites a hand-back. The lead then reads the
  job's exact text from the relay, and an idle lead starts a turn on it.
- A reply to a note is the steer or continue that exists. The answer to a question the job waits on must be the
  waiting call's result: a steer ends the wait on no backend.

Building it is a later plan ([Later plans](#later-plans)).

### After Phase 6: what held and what changed

Assumptions that held:

- A backend can be given a tool by the client, on all four, without writing into the user's home.
- Messages to a main thread reach it from any agent, and an idle main thread starts a turn on one, in T3 too
  (unlike a Monitor, D18).

What changed, and where:

- **The plan's delivery path does not exist.** `$.session.send` carries no sender agent, whatever loop calls it.
  A job's message would be the relay's own `SendMessage`, rewritten by the guard, and the answer to a question
  would be taken from the guard's ledger, not from a second delivery path (D52). The report's design names what
  that needs: a recorded outcome per message, question ids, the relay's life, trust and the busy lead, and the
  contracts a later plan has to settle.
- **A message by id to a running Workflow agent forks it.** Claude Code starts a second loop under the same id,
  and the original loop never reads the message. For a `relay:job` Workflow agent the steer still reached the
  job, through the second relay loop, which waited on the job beside the first and sent the lead an extra
  completion notice. A message to a Workflow relay that has ended fails ("No transcript found"), or resumes a
  `general-purpose` agent on the lead's model that answers in the relay's place; the job gets no turn. After a
  fork, Claude Code can write later entries to `subagents/agent-<id>.jsonl`, which the guard does not read: it
  reads the transcript recorded at start. Phase 1 and the suite never sent to a Workflow relay: every relay they
  steered was started with the Agent tool.

The later phases, in this light:

- **Phase 2.** Unchanged.
- **Phase 3.** A message that resumes a relay fires `agent.spawn` with `resume` and the message as the prompt, so
  the spawn check must let a resume through; the Phase 3 branch does (that branch's D45). That branch's D42 and
  D44 make the message `cancel` to a Workflow relay's id the way to cancel one Workflow agent's job. That message
  travels through a fork, which was not measured, and a forked id is a background task that `TaskStop` can stop,
  which that branch's D41 maps to the job. The Phase 3 thread has been told. Its `agent.spawn` hook is where relay would record a relay's
  parent from `parentAgentId`, when messages from a job are built.
- **Phase 4.** D17's Steer and Continue by the recorded relay id hold for relays started with the Agent tool. For
  a Workflow relay, a Steer would start a second relay loop, and a Continue would not reach the job (D53). Phase 4
  decides what the buttons do for a Workflow job: `C steer` and `C continue` exist for scripts. Its live checks
  include a steer and a continue of a Workflow relay from the lead's session, the check "After Phase 1" already
  asked for, and judge them by the job's ledger and attempts.
- **Phase 5's suite.** The rows for messages from a job stay out of the table. The report lists the checks a
  later plan would add.
- **The release.** Several texts promise for every relay what holds only for one the Agent tool started:
  design.md's interface table and "Under the Workflow tool", the jobs skill's message rules, `agents/job.md`
  ("after it ends, SendMessage continues the same session"; "the message `cancel` cancels it"), and the 3.0
  CHANGELOG's Phase 1 line on messages from other agents. The release PR states what a Workflow relay does: a
  steer reaches the job through a second relay loop, and a continue does not. For the message `cancel` to a
  Workflow relay, the release runs a live check if Phase 3 has none, or states it as unmeasured.

## Later plans

These features are being considered and will get plans of their own. They are listed here so that this plan
leaves room for them:

- **Messages from a job.** A "send to lead" and an "ask the lead" tool for jobs, delivered as the relay's own
  `SendMessage`. Phase 6's [report](messages-from-a-job.md) has the per-backend facts, a design and the live
  checks it would need.
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
  and agent-to-parent and agent-to-agent messages (Phase 6: possible with the changes its report lists, open on
  Grok's `write` and `read-only`, not built in 3.0, unsupported until proven).
- **A short demo** of steering a running job while a second agent joins. It needs Phase 1's
  two-second steer to be watchable, and the board to be visible. That is one more reason the terminal board is in
  scope.
- **Exact backend semantics.** Kimi takes no mid-turn steer, and read-only
  modes are not an OS sandbox. The board labels Kimi's message as "Queue next turn", and the matrix states the
  limit instead of marking it supported.
- **No paid tier or paid UI.** The module and the board ship in the same open-source plugin.

## T3 Code

The module's `session.send` hook works in T3: Phase 1's live check ran in a T3 thread on all four backends (see
Phase 1). T3 loads a plugin installed at local scope in the thread's project directory, which is how an unreleased
build is checked there without reaching other threads. A Monitor the lead arms does not start a new turn in a T3
thread once its turn has ended, so a scripted T3 check is driven by messages to the thread. Phase 3's spawn check and
TaskStop hook passed in T3 on all four backends; Phase 2 is expected to work there too, and its live suite checks it. Phase 4 needs two things
from T3: it has to render the `ui_*` messages, and it has to attach a surface. The module refreshes the status
line only while `$.session.surfaces()` is non-empty. [t3-code.md](t3-code.md) explains what relay would need from T3 and why relay complements T3's
own delegates. It is the article to link from a post to the T3 community.

## Open questions

None is open. The three this plan asked were answered on 22 October 2026, and are recorded with their reasons
in [decisions.md](decisions.md): a TaskStop on a relay agent cancels its job (Phase 3); the board's Desktop
check is the test kit's `desktop` mount plus one manual pass on a Mac before release (Phase 4); the wait bound is
540 seconds (Phase 1). New questions go to the decision log, and only product forks go to the owner.
