# relay 3.0 pre-releases: the owner's guide

Before 3.0.0, relay ships as pre-release cuts: 3.0.0-pre.1, then pre.2 and on. libar-infra installs each cut at
user scope on the M3 and on the ThinkPad, the way it installs releases, and you use it for real work. The M1 stays on
relay 2.2.0: if a cut gets in your way, carry on there, or go back (the last section).

Each cut has been through the end-to-end suite on Fedora and on the M3, and its section below lists the issues it
is known to have. This page is for daily use: what to watch while you work, how to note a problem so a lead can act
on it, and how to install a cut or go back by hand. The [README](../../README.md) explains each feature; the user
guide comes with a later docs PR.

## pre.1

Version `3.0.0-pre.1`, tag `v3.0.0-pre.1` (217adc8, 22 October 2026), installed by libar-infra on the M3 and the
ThinkPad. It is `release/3.0` with the code of 3.0.0-dev.4: a message reaches a running job within seconds, the four
commands answer without a model turn, a bad header fails at the launch, and TaskStop cancels the job. The status line
and the board are not in it yet. Its known issues, each fixed in pre.2 or later:

- **A message typed into an agent's own view is lost.** In the terminal's agent view (`↓`, `Enter`, then type), the
  message never reaches the job, while it runs or after it ends. Send messages through Claude.
- **A relay can wrap its hand-back in a code fence and be let go.** Now and then (3 of 40 relays in the suite) the
  relay agent retypes the job's block inside a ``` fence eight times; relay then lets it end. The job itself ran
  correctly, but `/relay:status` marks it `not handed back` and its block carries a `relay-violation:` line.
  `/relay:result <job>` has its block and report.
- **A job cancelled with TaskStop is marked `not handed back`**, though Claude got its cancelled block.
- **`/relay:setup` can misread Grok's sign-in** and show it signed out. Run it again; a Grok job shows whether the
  sign-in works.

## Install a cut by hand

libar-infra installs each cut. To install one yourself, pick a quiet moment: no relay job running on the machine
(`/relay:status --all` lists none `starting` or `running`). On the ThinkPad, other threads load the cut in their next
session too, so ask the coordinator first. Use the cut's tag, here pre.1's:

```bash
claude plugin marketplace remove libar-relay
claude plugin marketplace add 'libar-dev/relay-plugin-cc#v3.0.0-pre.1'
claude plugin install relay@libar-relay
```

- `claude plugin list` shows `relay@libar-relay` with the cut's version, `3.0.0-pre.1` for pre.1.
- New sessions load the cut. An open session keeps its version until `/reload-plugins`, and a running job finishes on
  the version that started it.
- Your jobs and relay's settings are in `~/.relay-jobs`; a reinstall leaves them alone.
- For the next cut, run the same three lines with its tag. The marketplace is pinned to the tag, so
  `claude plugin marketplace update` does not move it.

## After each install: five minutes

In a new session, in any repository:

1. `/relay:status`. At once, with no model turn; its `relay-version:` line names the cut (`3.0.0-pre.1`).
2. `/relay:setup`. Every backend you use is `ready: yes`.
3. Paste: `Launch one relay:job agent in the background with this prompt: "backend: codex", "model: default",
   "effort: low", "---", "Run sleep 60 once. In your final answer, quote every message you received while you worked.
   Write no files."` Within the minute: `Send that agent the message "Pre-release check: quote this line."` The
   hand-back quotes the line.
4. `/relay:result`. The block and that report, with no model turn.
5. On the Mac, steps 1 and 3 in a new session of the desktop app's Code tab.

## While you work: what should happen

Each line is what should happen. When one does not, note it (next section).

**Jobs and messages**
- A message to a running job reaches it within seconds, and its report shows it. Kimi takes it as its next turn.
- Once its fix lands (pre.2 or later): in the terminal, a message typed into the agent's own view (`↓`, `Enter`,
  then type) does the same.
- A message after the hand-back continues the same job: same `job:` and `session:`, `attempts:` one higher.
- A bad header fails the launch at once with the reason, and no job starts.
- Each agent hands back once its job ends. `/relay:status` marks a job `not handed back` only when its agent was
  stopped by hand or its session ended (and, in pre.1, after a TaskStop or a fenced hand-back).

**Long Workflows** (from the design: the end-to-end suite's checks for these are being added)
<!-- pending the e2e suite's resume and cancel-then-continue steps: keep only what it shows -->
- `/relay:status --workflow <run>` lists every job of a run, with its state; `/relay:result <job>` shows its report.
- After an interruption (a TaskStop on the Workflow, a crash, a T3 restart, Claude's usage limit), the Workflow
  tool with `resumeFromRunId` takes the running jobs over (`relay-adopted:` in their blocks) and does not run the
  finished calls again.
- A worker that died is resumed once (`automatic-resume:` in the block).
- A cancelled job keeps its session: a message to its agent continues it and can report its work so far.

**Stopping**
- `/relay:cancel`, the message `cancel` and TaskStop each cancel the job within seconds.
- Stopping the agent yourself (`x` in the agent list, Esc twice in its view, or the Stop button in Desktop's
  Background tasks) ends the agent and leaves its job running to its end, `not handed back` (D96).
  <!-- pending the fix lead's PR B --> From a later cut, a notice names the job, with `/relay:cancel` and
  `/relay:result`.

**Commands, on every surface**
- `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` answer at once, with no model turn, in the
  terminal, in Desktop's Code tab and in T3 Code.

**Desktop (Mac)**
- Background agents and Workflows show in the Background tasks panel. A message reaches a relay only through
  Claude: the agent's side view has no input box.

**T3 Code**
- Commands answer as the assistant's message; steering and continue work as in the terminal. T3 draws no status
  line and no board.

**From pre.2: the status line and the board** <!-- outline until Phase 4's PRs 2 and 3 merge -->
- While this repository has jobs to tell about, a line under the prompt reads `relay: 2 running · 1 dead · 3 owed`,
  and it goes away when they end. Terminal and Desktop only.
- `/relay:board` lists the jobs; selecting one shows its report and how each message was taken; its buttons steer,
  continue and cancel.

## When something goes wrong

Send one note per problem to the coordination thread (ThinkPad, relay-plugin-cc). It passes the note to the lead who
owns that part. Copy this and fill it in:

```
relay 3.0.0-pre.N · <M3 | ThinkPad> · <terminal | Desktop | T3> · Claude Code <version> · <time>
Did:      <what you did, or the prompt you gave>
Expected: <what should have happened>
Saw:      <what happened instead; the exact error line>
Job:      <job id>
<the output of /relay:status <job id>>
```

- The job id is in Claude's launch message and in `/relay:status`. `claude --version` gives Claude Code's version.
- Leave the job's folder (the `dir:` line) as it is: it holds the job's record and logs, and a lead reads them there.
  Do not prune it or start the same work again before you have noted it.
- For something drawn on screen (Desktop, the status line, the board), keep a screenshot on the machine and say where.
  It stays local: screenshots show your account.

## Going back to 2.2.0

On any machine, at a quiet moment:

```bash
claude plugin marketplace remove libar-relay
claude plugin marketplace add 'libar-dev/relay-plugin-cc#v2.2.0'
claude plugin install relay@libar-relay
```

Then run `/reload-plugins` in open sessions, or start new ones. `claude plugin list` shows `Version: 2.2.0`, and
`~/.relay-jobs` keeps every job and setting.

This pins the marketplace to the 2.2.0 tag. Once 3.0.0 is released, follow `main` again: `claude plugin marketplace
remove libar-relay`, `claude plugin marketplace add libar-dev/relay-plugin-cc`, `claude plugin install
relay@libar-relay`.
