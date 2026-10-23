# Using relay

This guide walks through relay the way you meet it: install it, check your backends, run a job, talk to it, read
it, stop it, run jobs from a Workflow, and watch them with the status line and the board. The [README](../README.md)
has the install requirements and the full reference (the header, the commands, the review flags),
[desktop.md](desktop.md) the Claude desktop app, and [design.md](design.md) how it works.

Relay runs jobs on Codex, Grok Build, ZCode and Kimi Code from Claude Code. You launch a job like a Claude agent,
as a `relay:job` agent, and Claude coordinates the work. The job runs on its backend, in its own process, and the
agent hands back the job's report. Every example below runs on Codex;
[What each backend can do](#what-each-backend-can-do) says where the others differ. Keys and screens are Claude Code
2.1.309's; a Claude Code update can change them.

<!-- Screenshots marked G1 to G25 come from the public-assets pass, in a clean demo setup (D92). -->

## Install

Install with the Claude Code CLI, as the README's [Install](../README.md#install) section says:

```bash
claude plugin marketplace add libar-dev/relay-plugin-cc
claude plugin install relay@libar-relay
```

Run `/reload-plugins` in an open session, or start a new one. Type `/relay:` and the command menu lists relay's
commands.

<!-- screenshot G1: the command menu after typing /relay:, terminal -->

## Check your backends

Type `/relay:setup`. Claude runs relay's setup and shows one block for each backend it finds: the binary and its
version, the sign-in, the default model and effort, the models you can name, and whether it is ready. It makes no
model call. Under the blocks it says what each backend lacks compared with the others, and the next steps: a
missing Codex can be installed for you, and a signed-out one needs `!codex login`.

<!-- screenshot G2: /relay:setup with four ready backends and the "lacks" list -->

Setup can only see that the ZCode and Kimi credentials files exist. Your first job on each shows whether the sign-in
works.

## Run a job

Ask Claude for a `relay:job` agent in your own words, with the job's header and brief:

```
Launch one relay:job agent in the background with this prompt:
backend: codex
model: default
effort: low
---
Run sleep 60 once. In your final answer, quote every message you received while you worked. Write no files.
```

The header lines set the job: `model:` and `effort:` are required, and `default` takes the backend's own setting.
Everything after `---` is the brief, which reaches the job byte for byte. The README's
[header table](../README.md#the-header) lists every key, and its [first hour](../README.md#the-first-hour) has a real
first job. `/relay:rescue <task>` builds the prompt for you from flags such as `--backend` and `--model`.

Claude launches the agent and tells you the job id. The agent appears in the list under the prompt, beside `main`,
with its running time. Press `↓` until it is selected and `Enter` to open its view: the prompt it was given, and the
agent waiting on the job. With the agent selected, `x` stops the agent but not its job (see [Stop a job](#stop-a-job)).
The agent is a small Claude agent (Haiku) that relays; the job itself runs on the model in the header.

<!-- screenshot G3: the launched job, and the agent list under the prompt -->
<!-- screenshot G4: the agent view, waiting on the job -->

When the job ends, its agent hands back the job's state block and report, and Claude reads them: you see
`Message from @relay-job` and `Agent "…" finished`. `state: completed` means the job finished its answer, not that
its commands passed: read the report.

## Steer a running job

While the job runs, ask Claude to send its agent a message:

```
Send that relay:job agent this message with SendMessage: "Also quote this exact line in your report."
```

Claude Code says the message is queued for the agent's next tool round. Relay wakes the agent at once, so the job
gets the message within a few seconds, inside the turn it is running. The report quotes it.

<!-- screenshot G5: the steer sent, and the report that quotes it -->

Kimi is the exception: a running Kimi turn takes no message, so Kimi runs it as the next turn, once the running one
ends. A message from another agent, such as a Workflow agent or an orchestrator, steers a job the same way. This
is for a relay the Agent tool started; a Workflow job's relay differs (see [Jobs in a Workflow](#jobs-in-a-workflow)).
One moment does not steer: a message that reaches a job in the few seconds before a turn starts (just after a continue
was accepted, or at the launch) waits until that whole turn ends, then runs as the next turn.

### Typing to a relay, in the terminal

You can also type to a relay yourself, in its own view:

1. Press `↓` until the agent is selected, and `Enter` to open its view. The list keeps focus.
2. Press `↑` until no row is selected, past `main`. The rule above the prompt reads `@<agent name>`, and the prompt
   `Message @<agent name>…` takes what you type.
3. Type the line and press `Enter`. It reaches the job at the relay's next step, up to about nine minutes later, or
   as a new turn once the job has ended: nothing wakes the relay for a typed line yet.

To redirect the job at once, press `Esc` once at the agent's prompt, then send the line right away. The Esc stops the
relay, and the view shows `Interrupted`; if it does not, the Esc only left the list. The line you send resumes the
relay and reaches the job within seconds (Kimi: as its next turn). Claude tells your session that you stopped the
agent, then that you resumed it. If you send nothing after the Esc, the relay stays stopped and its job runs on, as
under [Stop a job](#stop-a-job). Check that the rule above the prompt names the agent before you press `Esc`: in the
main view, Esc interrupts your own session.

Do not press `←` (`← for agents`): it opens Claude Code's session manager and moves your conversation to a new
session. The desktop app and T3 Code have no agent view to type into; ask Claude to send the message there.

## Continue a finished job

After the hand-back, ask Claude to send the agent another message. The agent resumes, the job runs a new turn on the
same backend session, and you get a second hand-back with the new report. The block keeps the job id and the
session, and counts `attempts: 2`.

A finished agent leaves the list under the prompt within about 15 seconds. If you kept its view open through the
hand-back, a line typed there continues the job too, and arrives within seconds.

<!-- screenshot G6: a continue, the agent resuming and its second hand-back -->

## See your jobs

`/relay:status` lists this repository's newest jobs: state, backend, model and effort, duration, the brief's first
line and the agent that relays it. `/relay:status <job>` shows one job's state block, `--all` lists every
repository's jobs, and `--workflow <run>` every job of one Workflow run. Its header names the relay version you run.

`/relay:result` shows the newest finished job's state block and its report; `/relay:result <job>` shows one.

These two, with `/relay:cancel` and `/relay:transfer`, answer at once, with no model turn and no tokens spent. Like
any plugin command, they wait for a running turn to end, so while your session works for a long time, type them in
another session on the same repository. The answer starts with the command as you typed it, then relay's lines in a
code block, then the report or the job table. A narrow terminal draws the table as one block per job.

<!-- screenshot G7: /relay:status in a wide terminal, the job table -->
<!-- screenshot G8: /relay:status in a narrow terminal, one block per job -->
<!-- screenshot G9: /relay:result, the state block and the report -->

A job whose result never reached its caller, because the session ended or its agent was stopped or lost, is marked
`not handed back`. `/relay:result <job>` has its report.

## Stop a job

Jobs run until they finish, so stopping one is always something you do:

- **`/relay:cancel`** cancels the only active job of this repository; `/relay:cancel <job>` a named one. Relay
  interrupts the turn and, if the job has not ended ten seconds later, stops its processes. The answer is the job's
  block, `state: cancelled`, with a line for each thing relay did.
- **The message `cancel`**: send it to the job's agent (a relay the Agent tool started), and the agent hands back
  the cancelled job.
- **TaskStop**: ask Claude to stop the agent with TaskStop. Relay cancels its job within a second or so, and Claude
  gets the cancelled block with the TaskStop result.

Stopping the agent yourself stops only the agent, not its job, so the work it has done is not lost. In the terminal
that is `x` in the agent list, or one Esc at the agent's prompt; in the desktop app, the Stop button in the Background
tasks panel. The job runs on to the end, and `/relay:status` marks it `not handed back` until a relay hands its result
back; `/relay:result <job>` has the report. To stop the job itself, use one of the three ways above.
<!-- Pending the fix lead's PR B (the D96 notice), add: "Relay then shows a notice that names the job, with
/relay:cancel and /relay:result." -->

<!-- screenshot G10: /relay:cancel and its cancel: lines -->
<!-- screenshot G13: TaskStop, the agent stopped and the job cancelled -->

## A header relay refuses

When relay cannot run a header, the launch fails at once, before any agent or job starts, and says why:

```
Error: Subagent spawn denied by a plugin: Unknown header key "colour". Known keys: model, effort, mode,
network, cd, add-dir, brief, web-search, fast, backend, grok-home, kimi-home.
```

The same goes for a missing `model:`, or a mode or web-search setting the backend lacks. Fix the header and launch
again.

<!-- screenshot G12: a refused header -->

## Jobs in a Workflow

A Workflow script runs a job with `agent(prompt, { agentType: 'relay:job', label })` and gets the state block back as
a string: the outcome lines and the `report:` path, without the report itself. `/workflows` shows the run with its
phases and agents; each relay agent shows as Haiku, the relay's own model. `/relay:status` names a Workflow job's
relay as `workflow:<run>/<label>`. The [jobs skill](../plugins/relay/skills/jobs/SKILL.md) has the rules for scripts.

<!-- screenshot G14: /workflows with a relay agent -->
<!-- screenshot G15: the state block a Workflow returned -->

A relay a Workflow script started takes messages to its agent differently (measured on Claude Code 2.1.308, in few
runs). A message while it runs starts a second loop of the agent beside the first: in the runs measured, a steer
reached the job through it, and the message `cancel` cancelled the job within 3 seconds, but Claude Code can then
write the relay's later entries to a second transcript that relay does not read, and a message that lands there
never reaches the job. A message after the relay ended fails, or a general-purpose agent answers in its place, and
the job gets no turn. A line typed into its view has not been measured. So control a Workflow job by its job id (the
block's `job:` line, or `/relay:status --workflow <run>`): ask Claude to steer, continue or cancel it with the
companion's `steer`, `continue` or `cancel`, or type `/relay:cancel <job>`. TaskStop finds no task for one agent of a
Workflow.

## Jobs outlive your session

A job does not belong to the Claude session that started it. End the session, and the job runs on; start a new
session in the same folder and `/relay:status` shows it, `/relay:result` its report. If the backend's server dies,
or the worker dies while its agent waits, the job resumes its session once by itself.

## Long orchestrations

<!-- Shown by the end-to-end suite on 3.0.0-dev.4 (pre.1's plugin code), all four backends: run 20261022T212434Z-730a
(resume-stop, resume-end, resume-cancelled) and run 20261022T210110Z-9dd6 (salvage, a message to an Agent-tool
relay); on the installed pre.1, run 20261022T222258Z-ba8d (resume-stop and resume-collect: the typed /relay:status
--workflow and /relay:result after a resume). On resume, 11 of 15 completed calls came back from the cache and 4 (the
longest ZCode and Kimi jobs) ran again and took over their job. Not shown by the suite: the companion's `continue`
for a Workflow job. -->

A Workflow can run for hours, with many relay jobs on several backends. When it stops, its jobs' work is kept, and a
resume picks it up.

**A stopped Workflow keeps its jobs.** After a TaskStop on the Workflow, or when its session ends, its relays end but
its jobs are not cancelled. The TaskStop's result names each job that keeps running.

**Resume it.** In the same conversation (the same T3 thread, or `claude --resume`), ask Claude to run the Workflow
again with `resumeFromRunId` and the run id. A call whose result had reached the Workflow comes back from its cache.
A call whose job had completed but whose result had not reached the Workflow yet runs again: its new relay takes the
job over and hands back its result, and the job does not run again. A job that is still running gets a new relay
that takes it over and waits for it. Each takeover adds a `relay-adopted:` line to the job's block. A worker that
died meanwhile is resumed once, and its block says so in `automatic-resume:`. A job that was cancelled or failed is
not taken over: a resume runs its call again as a new job, so collect its work first.

**Save a cancelled job's work.** A cancelled job writes no report, but it keeps its session on the backend. Send its
agent a message such as "Report what you have done so far, then stop", and the job reports in a new turn of that
session. That works for a job started with the Agent tool; a Workflow job's agent has ended, so ask Claude to continue
the job by its id with the companion's `continue`, as the jobs skill says.

**Collect the results.** `/relay:status --workflow <run>` lists every job one Workflow run started, in any
repository, cancelled ones included, and `/relay:result <job>` shows each one's block and full report. Both answer with
no model turn, also after a resume. Do not resume a Workflow under a different relay version from the one that
started it; let it finish, or read its jobs.

**What a stop keeps.**

| You stop | The job |
|---|---|
| one job with `/relay:cancel <job>`, or its Agent-tool relay with TaskStop or the message `cancel` | is cancelled, and keeps its session for a message |
| a Workflow with TaskStop | runs on; the TaskStop names the jobs that keep running, and a resume takes them over |
| an agent by hand: `x`, one Esc at its prompt, or the desktop app's Stop button | runs on to its report, marked `not handed back` |
| the Claude session | runs on |

<!-- The third row is D96. PR B adds a notice naming the job: add it here when it merges. -->

## Move a session to Codex

`/relay:transfer` imports the current Claude Code session into a Codex session and prints the line to resume it:

```
Transferred the Claude session into a Codex thread with visible turn history.
Codex session ID: <id>
Resume in Codex: codex resume <id>
```

It takes no job id: one typed after it is ignored, and the current session is transferred.

<!-- screenshot G11: /relay:transfer -->

## Reviews

`/relay:review` reviews your working tree, or your branch, on Codex's own reviewer or with `--backend` on another;
`/relay:adversarial-review` questions the approach. A review is read-only and is listed by `/relay:status`. The text
you give these commands, and `/relay:setup`, reaches relay as written: `$HOME` and other variables are not expanded,
so use `~/` or a full path. The README's [Review flags](../README.md#review-flags) and
[stop-time review gate](../README.md#the-stop-time-review-gate) have the details.

## The status line

While this repository has jobs running or dead, or messages a job has taken and not run, a line under the prompt
counts them:

```
⚠ relay: 2 running · 1 dead · 3 owed
```

- `running` counts the jobs that are starting or running.
- `dead` counts jobs whose worker died; a message or `resume` continues them.
- `owed` counts messages a job has acknowledged and not run yet.

A count of 0 is left out, and the line goes away when all are 0. A `+` after the counts means there are more than
200 active jobs and each count is a lower bound. `status unavailable` means the last read failed; the next good read
replaces it.

A job a `relay:job` agent of this session starts shows within about five seconds. A review, a job started from
another session or from a shell shows within about thirty. In T3 Code nothing draws a status line, and relay runs
nothing for it.

<!-- Checked in the terminal by the live suite's status-line check (#24, D63). The desktop app: the M3 lead's pass
after pre.3; describe it then. -->
<!-- screenshot G20: the status line, terminal -->
<!-- screenshot G21: the status line, desktop app -->

## The board

`/relay-board` (with a hyphen, not a colon) opens a pane, **Relay jobs**, with this repository's jobs. It docks beside
the transcript in the fullscreen layout from 110 columns, and sits above the prompt otherwise.

- **The list:** one row per job, newest first, with its id, backend, state and attempt, and its flags: owed
  messages, `not handed back`, `relay lost` (a running job whose relay has not called for 15 minutes) and
  violations. `More` shows more rows, and `Older jobs` and `Newest jobs` page through the rest.
- **A selected job:** its model and effort, its relay and Workflow run, each message to it with how the backend took
  it, and the report.
- **Steer** (`Queue next turn` on Kimi) sends text to a starting or running job, and **Continue** to an ended or dead
  one. For a job a relay of this session started with the Agent tool, the board sends through that relay, as
  Claude's `SendMessage` would, and the relay hands the result back to your session. For any other job (a Workflow
  job, another session's, a job whose relay is silent) it sends to the job directly. A steer sent that way comes
  back in the block of the relay that waits on the job; a continue runs a turn no relay hands back, and the board
  shows its report. Each message says which way it went. A send the relay refuses offers `Send to the job directly`;
  nothing is sent twice.
- **Cancel** asks again, naming the job and its attempt, and cancels only that attempt.

The pane takes the keyboard only while your session has no running turn and no background agent: `Tab` walks its
buttons, `Enter` presses, `Esc` gives the keys back to the prompt, and `ctrl+x` `Tab` takes them again. While relays
run in the background, which is when the board helps most, use the mouse: start Claude Code with
`CLAUDE_CODE_NO_FLICKER=1` for the fullscreen layout, where the pane takes clicks at any time. In T3 Code
`/relay-board` answers one line that points to `/relay:status`.

<!-- Checked in the terminal by the live suite's board check (#25, D61, D62, D65): a wide fullscreen session by
clicks, a narrow one by keys. The desktop app: the M3 lead's board pass after pre.3; describe it then. -->
<!-- screenshot G22: the board, wide terminal -->
<!-- screenshot G23: the board, narrow terminal -->
<!-- screenshot G24: a job selected, its report and messages -->
<!-- screenshot G25: the board in the desktop app -->

## In the desktop app

The Code tab of the Claude desktop app runs relay too. [desktop.md](desktop.md) says how to install it there, what
it shows differently (the Background tasks panel, a command's answer as a block with a copy button) and how to check
that it works. A message reaches a relay there only through Claude: the agent's side view has no input box.

<!-- screenshot G16: /relay:status in the Code tab -->
<!-- screenshot G17: a steered job in the Background tasks panel -->
<!-- screenshot G18: a refused header in the Code tab -->
<!-- screenshot G19: a Workflow card and its panel -->

## In T3 Code

In a T3 Code thread the commands answer as the assistant's message, with no model turn, and steering, continuing
and TaskStop through Claude work as in the terminal. T3 draws no agent view, no status line and no board. For a plain
fan-out of independent agents, a T3 delegate is often the better fit; relay carries the Workflow jobs and what needs
relay itself.

## What each backend can do

| | Codex | Grok Build | ZCode | Kimi Code |
|---|---|---|---|---|
| A message while a turn runs | joins the turn | joins the turn | joins the turn | runs as the next turn |
| A message after the job ended | a new turn | a new turn | a new turn | a new turn |
| `mode` | `yolo`, `write`, `read-only` | `yolo`, `write`, `read-only` | `yolo`, `read-only` | `yolo`, `read-only` |
| `web-search` | `live`, `cached`, `disabled` | `live` | `live`, `disabled` | `live` |
| `/relay:transfer` | yes | no | no | no |
| The stop-time review gate | yes | no | no | no |
| `/relay:review` | Codex's own reviewer | relay's prompt; two files, 256 KiB at most | the same as Grok | the same as Grok |

[capabilities.md](live/capabilities.md) shows what the live suite has passed on each backend, in the terminal and in
T3 Code.
