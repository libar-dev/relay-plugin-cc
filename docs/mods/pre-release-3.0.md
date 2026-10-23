# relay 3.0 pre-releases: the owner's guide

Before 3.0.0, relay ships as pre-release cuts: 3.0.0-pre.1, then pre.2 and on. libar-infra installs each cut at
user scope on the M3 and on the ThinkPad, and keeps each machine's relay pin. The M1 stays on relay 2.2.0 as the
fallback.

The cuts started on Thursday 22 October, 23:45 CEST, and go on as issues are found. Heavy production runs on them
from pre.2, by your call of 23 October, which ended the 48-hour hold; use them and test them.

This page lists each cut and its known issues, a check to run after each install, what should happen while you
work, how to note a problem, and how a machine is switched. The [README](../../README.md) explains relay itself; the
user guide comes with a later docs PR. Two words used below: a *relay* is the small Claude agent (Haiku) that runs
one job and *hands back* its result; the *job* runs on Codex, Grok Build, ZCode or Kimi Code.

## pre.1

Version `3.0.0-pre.1`, tag `v3.0.0-pre.1` (217adc8): `release/3.0` at c73e053, with the plugin code of
3.0.0-dev.4. The status line and the board come in a later cut.

<!-- How pre.1 was checked. Before the install: the test suite (1485 tests), the type check, the plugin's validate
and test, CI, its companion reading a copy of the ThinkPad's jobs home. After the install: the smoke test and
libar-infra's thread tests on both machines (an orphaned job, an interrupted Workflow resumed, a killed worker), the
end-to-end suite on Fedora (on the same code) and, since the install, on the M3, and the rollback check (2.2.0
reads the jobs pre.1 writes). -->

It passed the test suite and CI before its install, and the smoke test, libar-infra's thread tests and the rollback
check after it. Its known issues, with what to do meanwhile; the first four are planned for pre.2 (Friday, about
20:00):

1. **A message typed into an agent's own view is lost.** In the terminal's agent view (`↓`, `Enter`, then type), the
   message never reaches the job, while it runs or after it ends. Send messages through Claude.
2. **A relay can hand back its block wrongly and be let go.** A relay started with the Agent tool now and then (3 of
   40 such relays in the end-to-end suite) retypes the job's block inside a code fence; after eight tries relay lets
   it end. Once, after the message `cancel`, a relay wrote prose instead of the block and was let go the same way;
   pre.2's fix covers the fence, not yet this case. The job itself is fine, but `/relay:status` marks it
   `not handed back` and its block carries a `relay-violation:` line. `/relay:result <job>` has the block and the
   report. Workflow relays are not affected by the fence.
3. **A job cancelled with TaskStop is marked `not handed back`,** though Claude got its cancelled block.
4. **`/relay:setup` can misread Grok's sign-in** and show it signed out: run it again. It also lists Kimi as lacking
   steering; a message to a running Kimi job runs as its next turn.
5. **`/relay:transfer` takes no job id.** One typed after it is ignored, and the current session is transferred.

Two issues of T3 Code, not relay, that affect long Workflows:

- **On the M3, a T3 restart leaves the old Claude processes working** for minutes beside the resumed ones. In
  libar-infra's test a Workflow's side effect happened twice, and two processes edited one worktree. T3 restarts on
  the M3 are on hold until you decide.
- **After a Stop, an interrupt or a restart, T3 can say a thread's background work "was cancelled".** For a relay
  Workflow that is false: resume it (below).

## After each install: a check

In a new T3 thread on each machine:

1. `/relay:status`. Its `relay-version:` line names the cut.
2. `/relay:setup`. Every backend you use shows ready.
3. Paste this, then within the minute send the agent "Pre-release check: quote this line." through Claude. The
   hand-back quotes the line.

   ```
   Launch one relay:job agent in the background with this prompt:
   backend: codex
   model: default
   effort: low
   ---
   Run sleep 60 once. In your final answer, quote every message you received while you worked. Write no files.
   ```

4. Paste this, and ask Claude to show the block the Workflow returns: `state: completed`. Then ask Claude to check
   that the job's `job.json` holds `relay.journalKey`: that key is what lets a resumed Workflow take its jobs over.

   ```
   Run one Workflow whose script runs one agent with agentType relay:job and label check, and returns its result.
   The agent's prompt is these five lines:
   backend: codex
   model: default
   effort: low
   ---
   Reply with the single word pong. Run no commands.
   ```

5. `/relay:result`. The block and the report of the newest finished job.
6. If you use the M3's desktop app: steps 1 and 3 in a new session of its Code tab.

## While you work: what should happen

Each line is what should happen. When one does not, note it (next section).

`/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` take no model turn, but like every plugin
command they run only once the session's current turn has ended. A lead that holds its turn for hours will not answer
them until then: type them in another thread on the same repository.

**Jobs started with the Agent tool**
- A message to a running job's agent reaches the job within seconds, and the report shows it. Kimi runs it as its
  next turn.
- A message after the hand-back continues the same job: the same `job:` and `session:`, and `attempts:` one higher.
- A bad header fails the launch at once with the reason, and no job starts.

**Long Workflows**

<!-- The end-to-end suite on the pre.1 plugin code (3.0.0-dev.4, 962130b): run 20261022T212434Z-730a (resume-stop,
resume-end, resume-cancelled) and run 20261022T210110Z-9dd6 (salvage); on the installed pre.1, run
20261022T222258Z-ba8d (resume-stop; its resume-end was not resumed). Calls on resume, from the journals of the three
resumed Workflows (730a's resume-stop and resume-end, ba8d's resume-stop): of 15 calls that had completed, 11 came
back from the cache (8 relay, 3 native) and 4 (three ZCode, one Kimi, whose jobs run longest) ran again and took over
their completed job, one job and one attempt each. -->

The end-to-end suite showed the first four lines on the pre.1 code, on all four backends unless a line says
otherwise. The others are relay's documented behaviour.

- **A stopped Workflow keeps its jobs.** After a TaskStop on the Workflow, or when its session ends, its relays end
  and its jobs are not cancelled. The TaskStop's result names each job that keeps running.
- **Resume it in the same conversation:** `claude --resume` in a terminal, or the same T3 thread (shown by
  libar-infra's thread tests), then the Workflow tool with `resumeFromRunId`. A call whose result had reached the
  Workflow comes back from its cache. A call whose job had completed, but whose result had not reached the Workflow
  yet, runs again (shown on ZCode and Kimi): its new relay takes the job over and hands back its result, and the job
  does not run again. A running job is taken over and awaited. Each takeover adds a `relay-adopted:` line to the job's
  block. The Workflow's result has an entry for every label. A worker that died meanwhile is resumed once:
  `automatic-resume: … (worker)` in the block.
- **A cancelled job is not taken over** (shown on Codex), and by design neither is a failed one: a resume runs its
  call again as a new job. Collect its work first.
- **To collect a cancelled job's work** from a relay started with the Agent tool, send its agent a message such as
  "report what you have done so far, then stop". The job runs a new turn on the same session and reports.
- **To collect a cancelled Workflow job's work,** ask Claude to continue the job by its id with the companion's
  `continue`, as the jobs skill says: its agent has ended, so a message to it does not reach the job.
- **To cancel one job of a running Workflow,** use `/relay:cancel <job>`, from another thread if the lead holds its
  turn. TaskStop cannot target one agent of a Workflow.
- `/relay:status --workflow <run>` lists every job of a run, in any repository.
- **Do not resume a Workflow under a different cut** from the one that started it: that has not been tested. Let it
  finish, or read its jobs with `/relay:result`.
- **`not handed back`** means no relay handed back the job's result: its agent was stopped by hand, died or was let
  go, or its Workflow stopped before the job ended (in pre.1, also after a TaskStop on its agent: known issue 3). The
  mark clears when a resumed relay hands the result back. `/relay:result <job>` has the report either way.

**Stopping**
- TaskStop on one relay agent, the message `cancel` to it, and `/relay:cancel <job>` each cancel that job within
  seconds.
- TaskStop on a Workflow ends its relays and leaves its jobs running, for a resume to take over.
- Stopping an agent yourself (`x` in the agent list or Esc in its view in the terminal, or the Stop button in
  the desktop app's Background tasks panel) ends the agent only, and the job runs to its end, `not handed back`.
  That is the owner's decision; a notice naming the job comes in a later cut.
- In T3, Stop ends the thread's process: its relays end and their jobs run on. Resume a Workflow as above, and read
  an Agent-tool job with `/relay:result <job>`.

**Other surfaces**
- In the desktop app, a message reaches a relay only through Claude: the agent's side view has no input box.
- In T3, the commands answer as the assistant's message, and steering and continuing work as in the terminal.

## When something goes wrong

Send one note per problem to the relay 3.0 coordination thread on the ThinkPad
(`mcp:37aa2fb1-2c83-4898-ab5d-1432f4cff415`). It passes the note to the lead who owns that part. Copy this and fill it
in:

```
relay <version> · <M3 | ThinkPad> · <T3 | terminal | Desktop> · Claude Code <that surface's version> · <time>
Where:    <T3 thread id or Claude session id>; Workflow run <id>, if any
Did:      <what you did, or the prompt you gave>
Expected: <what should have happened>
Saw:      <what happened instead; the exact error line>
Job:      <job id, or none>
<the job's row from /relay:status --workflow <run>, or /relay:status in its repository>
<its block from /relay:status <job id>>
```

- **relay's version:** the version the job ran on (ask Claude for the `relayVersion` of its last attempt in
  `status <job> --json`), or `relay-version:` from `/relay:status` in that session. An open session can still run an
  older cut.
- **Claude Code's version:** `claude --version` in a terminal. The desktop app's Code tab runs its own, named by its
  folder in `~/Library/Application Support/Claude/claude-code/`.
- Leave the job's folder (its `dir:` line) as it is: it holds the job's record and logs. A lead on the other machine
  reads it through a thread on that machine. Do not prune it, or start the same work again, before you have noted it.
- For client work, leave out the prompt and the paths: name the job, the machine and the time.
- For something drawn on screen, keep a screenshot on the machine and say where. It stays local: it shows your
  account.

## Switching a machine

libar-infra installs every cut, and every plugin install, update or rollback, on any machine, goes through it: ask
libar-infra. It keeps each machine's pin and checks the machine against it. The commands below are what a switch
runs, for reference.

Before a switch: no Workflow running or waiting to be resumed, and no relay job `starting`, `running` or `dead`. Ask
Claude to list them with their Workflow runs: the plain list is too long to read by eye. On pre.1,
`status --all --json` lists every job. From pre.2, `status --all --active --json` lists only those jobs, a page at a
time: Claude reads every page, following `nextCursor`.

To a cut: replace `N` with the cut's number, so `v3.0.0-pre.1` for pre.1.

```bash
claude plugin marketplace remove libar-relay
claude plugin marketplace add 'libar-dev/relay-plugin-cc#v3.0.0-pre.N'
claude plugin install relay@libar-relay
```

Back to 2.2.0:

```bash
claude plugin marketplace remove libar-relay
claude plugin marketplace add 'libar-dev/relay-plugin-cc#v2.2.0'
claude plugin install relay@libar-relay
```

- `claude plugin list` shows the new `Version:`. Jobs and relay's settings stay in `~/.relay-jobs`.
- New sessions and new T3 threads load the new version. An open session keeps its version until `/reload-plugins`, or
  until its process is replaced (in T3: a Stop, a kill or a restart). Do not reload a session whose relay is running.
- 2.2.0 reads the jobs pre.1 wrote (checked 22 October). Not checked: continuing or resuming a pre.1 job under
  2.2.0, or 2.2.0 reading a later cut's jobs. After going back, read pre.1's jobs with `/relay:result`; do not
  continue or resume them.
- When 3.0.0 is released, libar-infra moves the machines back to following `main`.
