# relay 3.0 pre-releases: the owner's guide

Before 3.0.0, relay ships as pre-release cuts: 3.0.0-pre.1, then pre.2 and on. libar-infra installs each cut at
user scope on the M3 and on the ThinkPad, and keeps each machine's relay pin. The M1 stays on relay 2.2.0 as the
fallback.

The cuts run for 48 hours, from Thursday 22 October, 23:45 CEST, to Saturday 24 October, about 23:45. Use them and
test them, but keep heavy production workloads off the M3 and the ThinkPad until the go/no-go on Saturday, about
22:00, and your go.

This page lists each cut and its known issues, a check to run after each install, what should happen while you
work, how to note a problem, and how to install a cut or go back by hand. The [README](../../README.md) explains
relay itself; the user guide comes with a later docs PR. Two words used below: a *relay* is the small Claude agent
(Haiku) that runs one job and *hands back* its result; the *job* runs on Codex, Grok Build, ZCode or Kimi Code.

## pre.1

Version `3.0.0-pre.1`, tag `v3.0.0-pre.1` (217adc8): `release/3.0` at c73e053, with the plugin code of
3.0.0-dev.4. A message reaches a running job within seconds; `/relay:status`, `/relay:result`, `/relay:cancel` and
`/relay:transfer` answer without a model turn; a bad header fails the launch; TaskStop on a relay cancels its job.
The status line and the board come in a later cut.

How it was checked:

- **Before the install:** the test suite (1485 tests), the type check, the plugin's validate and test, CI, and its
  companion reading a copy of the ThinkPad's jobs home.
- **After the install, on both machines:** the smoke test, and libar-infra's thread tests (an orphaned job, an
  interrupted Workflow resumed, a killed worker).
- **On the same code, on Fedora:** the end-to-end suite.
- **Not run for pre.1:** the end-to-end suite on the M3, and the check that 2.2.0 reads the jobs a cut writes (see
  "Going back to 2.2.0").

Known issues. The first four are fixed in pre.2:

1. **A message typed into an agent's own view is lost.** In the terminal's agent view (`↓`, `Enter`, then type), the
   message never reaches the job, while it runs or after it ends. Send messages through Claude.
2. **A relay started with the Agent tool can wrap its hand-back in a code fence and be let go.** Now and then (3 of
   40 such relays in the end-to-end suite) the relay retypes the job's block inside a code fence; after eight tries
   relay lets it end. The job ran correctly, but `/relay:status` marks it `not handed back`, and its block carries a
   `relay-violation:` line. `/relay:result <job>` has the block and the report. Workflow relays are not affected.
3. **A job cancelled with TaskStop is marked `not handed back`,** though Claude got its cancelled block.
4. **`/relay:setup` can misread Grok's sign-in** and show it signed out: run it again. It also lists Kimi as lacking
   steering; a message to a running Kimi job runs as its next turn.
5. **`/relay:transfer` takes no job id.** One typed after it is ignored, and the current session is transferred.

Two issues of T3 Code, not relay, that affect long Workflows:

- **On the M3, a T3 restart leaves the old Claude processes working** for minutes beside the resumed ones. In
  libar-infra's test a Workflow's side effect happened twice, and two processes edited one worktree. T3 restarts on
  the M3 are on hold until you decide.
- **After a T3 restart, T3 can say a thread's background work "was cancelled".** For a relay Workflow that is false:
  resume it (below).

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

4. Paste this. The Workflow returns a block with `state: completed`. Then ask Claude to check that the job's
   `job.json` holds `relay.journalKey`: that key is what lets a resumed Workflow take its jobs over.

   ```
   Run one Workflow whose script runs one agent with agentType relay:job and label check, and returns its result.
   The agent's prompt is these five lines:
   backend: codex
   model: default
   effort: low
   ---
   Reply with the single word pong. Run no commands.
   Show me the block the Workflow returns.
   ```

5. `/relay:result`. The block and the report of the newest finished job.
6. If you use the M3's desktop app: steps 1 and 3 in a new session of its Code tab.

## While you work: what should happen

Each line is what should happen. When one does not, note it (next section).

`/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` take no model turn, but like every plugin
command they run only once the session's current turn has ended. A lead that holds its turn for hours will not answer
them until then: type them in another thread on the same repository. `/relay:status --all` lists every repository's
jobs.

**Jobs started with the Agent tool**
- A message to a running job's agent reaches the job within seconds, and the report shows it. Kimi runs it as its
  next turn.
- A message after the hand-back continues the same job: the same `job:` and `session:`, and `attempts:` one higher.
- From pre.2, a line typed into the agent's own view in the terminal reaches the job too. After the hand-back it
  arrives within seconds; while the job runs, it waits for the relay's next step (up to about nine minutes) or becomes
  a new turn when the job ends. For a prompt steer, send it through Claude.
- A bad header fails the launch at once with the reason, and no job starts.

**Long Workflows**

<!-- The end-to-end suite on the pre.1 plugin code (3.0.0-dev.4, 962130b), all four backends: run
20261022T212434Z-730a (resume-stop, resume-end, resume-cancelled) and run 20261022T210110Z-9dd6 (salvage). -->

The end-to-end suite has shown each of these on the pre.1 code, on all four backends, unless a line says otherwise.

- **A stopped Workflow keeps its jobs.** After a TaskStop on the Workflow, or when its session ends, its jobs are not
  cancelled. The TaskStop's result names each job that keeps running.
- **Resume it in the same conversation:** the same T3 thread, or `claude --resume` in a terminal, then the Workflow
  tool with `resumeFromRunId`. Calls that had finished are not run again. Each running job is taken over, with a
  `relay-adopted:` line in its block, and the result has an entry for every label.
- **A worker that died** while the Workflow was stopped is resumed once when its job is taken over:
  `automatic-resume: … (worker)` in the block.
- **A cancelled job is not taken over.** A resume runs its call again as a new job, so collect a cancelled job's
  work first.
- **To collect a cancelled job's work,** send its agent a message such as "report what you have done so far, then
  stop" (a relay started with the Agent tool). The job runs a new turn on the same session and reports. A Workflow
  job's agent has ended, and a message to it does not reach the job: ask Claude to continue the job by its id with
  the companion's `continue`, as the jobs skill says. The suite has not run that route yet.
- **To cancel one job of a running Workflow,** use `/relay:cancel <job>`, or send its agent the message `cancel`.
  TaskStop cannot target one agent of a Workflow.
- **`/relay:status --workflow <run>`** lists every job of a run, in any repository. The suite reads the same list
  through the companion; the typed command is its next check.
- **Do not resume a Workflow under a different cut** from the one that started it: that has not been tested. Let it
  finish, or read its jobs with the version that started them.
- **`not handed back`** means no relay handed back the job's result: its agent was stopped by hand, died or was let
  go, or its Workflow stopped before the job ended (and, in pre.1, after a TaskStop). A resume that takes the job over
  clears it. `/relay:result <job>` has the report either way.

**Stopping**
- TaskStop on one relay agent, the message `cancel` to it, and `/relay:cancel <job>` each cancel that job within
  seconds.
- TaskStop on a Workflow ends its relays and leaves its jobs running, for a resume to take over.
- Stopping an agent yourself (`x` in the agent list or Esc twice in its view in the terminal, or the Stop button in
  the desktop app's Background tasks panel) ends the agent only, and the job runs to its end, `not handed back`.
  That is the owner's decision; a notice naming the job comes in a later cut.

**Other surfaces**
- In the desktop app, a message reaches a relay only through Claude: the agent's side view has no input box.
- In T3, the commands answer as the assistant's message, and steering and continuing work as in the terminal.

## When something goes wrong

Send one note per problem to the relay 3.0 coordination thread on the ThinkPad
(`mcp:37aa2fb1-2c83-4898-ab5d-1432f4cff415`). It passes the note to the lead who owns that part. Copy this and fill it
in:

```
relay <relay-version: from /relay:status in that session> · <M3 | ThinkPad> · <T3 | terminal | Desktop>
Claude Code <that surface's version> · <time>
Where:    <T3 thread id or Claude session id>; Workflow run <id>, if any
Did:      <what you did, or the prompt you gave>
Expected: <what should have happened>
Saw:      <what happened instead; the exact error line>
Job:      <job id, or none>
<the job's row from /relay:status --all, and its block from /relay:status <job id>>
```

- The `relay-version:` of the session matters: an open session can still run an older cut.
- Claude Code's version: `claude --version` in a terminal. The desktop app's Code tab runs its own, named by its
  folder in `~/Library/Application Support/Claude/claude-code/`.
- The `not handed back` mark shows only in the list, so paste the job's row as well as its block.
- Leave the job's folder (its `dir:` line) as it is: it holds the job's record and logs. A lead on the other machine
  reads it through a thread on that machine. Do not prune it, or start the same work again, before you have noted it.
- For client work, leave out the prompt and the paths: name the job, the machine and the time.
- For something drawn on screen, keep a screenshot on the machine and say where. It stays local: it shows your
  account.

## Installing a cut or going back by hand

libar-infra installs each cut and records each machine's pin. A change by hand leaves that pin wrong, and libar-infra's
next install puts the pinned version back. So ask libar-infra to switch a machine, or tell it afterwards.

Before any switch:

- No Workflow running or waiting to be resumed, and no relay job running. Ask Claude to list the jobs whose state is
  `starting` or `running` from `status --all --json`: the plain list is too long to read by eye.
- Claude Code 2.1.307 or later, and in the desktop app, its Code tab's own Claude Code too.

### Install a cut

```bash
claude plugin marketplace remove libar-relay
claude plugin marketplace add 'libar-dev/relay-plugin-cc#v3.0.0-pre.1'
claude plugin install relay@libar-relay
```

- `claude plugin list` shows `relay@libar-relay` with `Version: 3.0.0-pre.1`.
- New sessions and new T3 threads load the cut. An open session keeps its version until `/reload-plugins`, or until
  its process is replaced (in T3: a stop, a kill or a restart). Do not reload a session whose relay is running.
- `marketplace remove` also clears relay's enabled and disabled entries in every settings file. In a folder with a test
  build from `scripts/smoke/install-local.sh`, run `claude plugin disable relay@libar-relay --scope local` again.
- Jobs and relay's settings stay in `~/.relay-jobs`.
- For the next cut, use the same three lines with its tag. A pinned marketplace does not move on
  `claude plugin marketplace update`.

### Going back to 2.2.0

Only once every job that pre.1 started has ended and you have read it with `/relay:result`. Whether 2.2.0 reads the
records a cut writes has not been checked for pre.1 yet; from pre.2 on, each cut's gates check it.

```bash
claude plugin marketplace remove libar-relay
claude plugin marketplace add 'libar-dev/relay-plugin-cc#v2.2.0'
claude plugin install relay@libar-relay
```

- `claude plugin list` shows `Version: 2.2.0`. Start new sessions; do not reload one whose relay is running.
- When 3.0.0 is released, libar-infra moves the machines back to following `main`.
