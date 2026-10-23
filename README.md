# relay

Run jobs on Codex, Grok Build, ZCode and Kimi Code from Claude Code like Claude agents.

Launch a `relay:job` agent with the Agent tool or from a Workflow script. The job runs on
OpenAI's Codex, xAI's Grok Build, Z.ai's ZCode or Moonshot AI's Kimi Code while Claude
coordinates the work. Send it a
message to steer a running turn or continue the same session after it reports. Each job has a
detached worker and survives the Claude session. After a server death, or a worker death while
the agent waits on it, the job resumes its session once. The agent returns the report verbatim
with a state block that says what happened.

`relay` started as a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
1.0.6. [NOTICE](NOTICE) keeps the attribution and license terms. [docs/design.md](docs/design.md)
explains the design.

## Backends

A backend is named by its harness. The model family goes in `model:`.

| `backend:` | Harness | Models | Sign-in |
|---|---|---|---|
| `codex` (default) | Codex CLI app-server | GPT models | `codex login` |
| `grok` | `grok agent stdio` | Grok models | `grok login` in the selected Grok home |
| `zcode` | `zcode app-server` | GLM (GLM-5.3, GLM-5.3-Flash), the only route for it | `zcode login` |
| `kimi` | `kimi acp` | Kimi models (K3, K2.8, K2.7) | `kimi login --region global` (or `mainland-cn`) in the selected Kimi home |

`/relay:review` and `/relay:adversarial-review` run on any backend (`--backend`, Codex unless
chosen). The stop-time review gate and transfer run on Codex.

## Install

Requirements:

- Claude Code 2.1.307 or later: the plugin's hooks module needs its `session.send`, `agent.spawn` and `command.run`
  events, and the relay hooks need `SubagentHandback`.
- Node.js 22 or later.
- macOS or Linux. The process sweep reads the process table with `ps`.
- At least one backend CLI, signed in: the Codex CLI, Grok Build, ZCode or Kimi Code. Release 2.1.2
  was checked live with Codex 0.163.0, Grok Build 1.0.60, ZCode 3.15.3 and Kimi Code 2.2.0.

```bash
claude plugin marketplace add libar-dev/relay-plugin-cc
claude plugin install relay@libar-relay
```

Then run `/reload-plugins` in open sessions, or start a new one. The Code tab of the Claude desktop app loads the
same plugins in its next new session: [docs/desktop.md](docs/desktop.md) says what runs there and how to check it.

Update the plugin:

```bash
claude plugin marketplace update libar-relay
claude plugin update relay@libar-relay
```

A session keeps the version it loaded until `/reload-plugins`. Running jobs finish on the version
that started them.

### Auto mode

In auto mode, Claude Code's classifier checks every agent launch. By default it blocks launching
an agent that runs without approvals or a sandbox, and a job in the default `mode: yolo` is one,
so the classifier can block a `relay:job` launch. The plugin cannot change your Claude Code
settings, so add an exception yourself. The classifier reads `autoMode` only from
`~/.claude/settings.json`, managed settings and `--settings`, never from a project's `.claude/`
files:

```json
{
  "autoMode": {
    "allow": [
      "$defaults",
      "Launching a relay:job agent of the relay plugin is allowed: it runs one job on Codex, Grok Build, ZCode or Kimi Code, with no sandbox in mode: yolo, and its brief names where the job may write."
    ]
  }
}
```

Keep `"$defaults"`: an `allow` list without it replaces the built-in exceptions.
`claude auto-mode config` prints the rules the classifier uses. A `permissions.allow` rule such
as `Agent(relay:job)` does not help here, because Claude Code drops `Agent` allow rules when a
session enters auto mode. If the classifier still blocks a launch, ask for the launch in your own
message, or leave auto mode for that step.

## The first hour

**Check the backends.** Run `/relay:setup`. It finds every backend home on the machine (the
Codex home, `~/.grok` and each `~/.grok-<name>`, ZCode, and `~/.kimi-code` and each
`~/.kimi-code-<name>`) and prints one block for each: binary
and version, sign-in, default model and effort, the models you can name in `model:`, and what the
backend can do. It makes no model call, and a missing or signed-out backend never fails the page.
When Codex is missing, `/relay:setup` offers to install Codex for you with npm. When it is signed
out, run `!codex login`.

**Launch a job.** Jobs run in `mode: yolo` by default, with no sandbox and no approvals, so that
existing headers and Workflow scripts keep running as they did. In a check with Codex 0.162.0 and
Grok Build 1.0.50, `mode: write` with `network: true` covered web search, package installs, git
commits and child processes, but not `ps` or writes outside the working directory; ZCode and Kimi
have no `write` mode. In `yolo` the brief is the only fence, so name where the job may write. This first
job asks for `mode: write` instead, the Codex workspace sandbox:

```
Agent({ subagent_type: "relay:job", description: "fix flaky test", run_in_background: true, prompt: `model: gpt-6-astra
effort: high
mode: write
cd: /abs/path/to/repo
---
The test "retries on timeout" in tests/net.test.mjs fails one run in five. Find why and fix it.
Write only under src/ and tests/. Report the cause, the change and the test run.` })
```

The header sets the job. `model:` and `effort:` are required, and `default` takes the home's own
setting. The brief after `---` reaches the job byte for byte. When the job ends, the agent returns
a state block and the report:

```
state: completed
job: job-mur1abcd-1a2b3c4d
session: <the Codex session id>
model: gpt-6-astra
effort: high
duration: 6m 40s
attempts: 1
report: ~/.relay-jobs/<repo>/<job>/report.md
dir: ~/.relay-jobs/<repo>/<job>
mode: write
web-search: live
cwd: /abs/path/to/repo
relay: <the relay's agent id>
---
<the report, as Codex wrote it>
```

`completed` means the job finished its answer, not that its commands passed. Read the report.

**Talk to it.** A message reaches the job within seconds. The relay agent waits on the job in steps
of up to nine minutes, so Claude Code's stall timer never fires on a long job. A message sent to it
ends the current step, and its hook delivers the message at the next. Send the agent "Also check the retry path in
src/net/client.mjs." with `SendMessage` while the job runs, and Codex gets it inside the running
turn. Sent after the job has ended, the same message starts a new turn on the same session, and the
agent returns the new report. The message `cancel` cancels the job. In the terminal, a line you type into the agent's
own view (↓ in the footer, Enter, then ↑ to its prompt) reaches the job too, at the relay's next step: up
to nine minutes later, or as a new turn once the job has ended. Esc at that prompt, or `x` in the agent
list, stops the relay agent and leaves the job running; a line typed right after Esc resumes the relay
and reaches the job at once, steering it while it runs. `/relay:cancel <job>` cancels the job.

**In a workflow.** A Workflow script runs a job with `agent(prompt, { agentType: 'relay:job' })` and
gets the state block back as a string. The `relay:jobs` skill has the rules, and the section
[What the relay depends on in Claude Code](#what-the-relay-depends-on-in-claude-code) says what a
Claude Code update can break.

## Reference

### The header

| Key | Values | Default |
|---|---|---|
| `backend` | `codex`, `grok`, `zcode`, `kimi` | `codex` |
| `model` | a model name, or `default` | required |
| `effort` | a backend effort name, such as `low`, `high`, `xhigh`, `max` or `ultra`, or `default` | required |
| `mode` | `yolo`, `write`, `read-only` | `yolo` |
| `grok-home` | Grok only: `jobs` for `~/.grok-jobs`, another name, a path, or `default` for `~/.grok` | `default` |
| `kimi-home` | Kimi only: `jobs` for `~/.kimi-code-jobs`, another name, a path, or `default` for `~/.kimi-code` | `default` |
| `fast` | `true` asks OpenAI for its priority tier after `/relay:setup --fast-tier allowed` | `false` |
| `network` | `true`, `false`; `write` and `read-only` only | `false` |
| `web-search` | `live`, `cached`, `disabled` | `live` |
| `cd` | absolute working directory | the agent's directory |
| `add-dir` | absolute extra writable root, repeatable; Codex `write` only | none |
| `brief` | absolute path of the brief file; nothing follows `---` | the text after `---` |

The `relay:jobs` skill describes every key, GLM on ZCode, Grok and Kimi homes and the state block's
lines.
An unknown header key fails the start with a usage error that lists the known keys. Each backend
accepts only the modes and web-search settings it supports. Grok supports all three modes and only
`web-search: live`. ZCode supports `yolo` and `read-only`, with `web-search: live` or `disabled`.
Kimi supports `yolo` and `read-only` and only `web-search: live`, and a running Kimi turn takes no
message: a message sent while it runs becomes the next turn.

### Commands

| Command | What it does |
|---|---|
| `/relay:setup` | every backend home in one shape; `--backend codex\|grok\|zcode\|kimi [--grok-home H\|--kimi-home H]` checks one and exits non-zero when it is not ready |
| `/relay:setup --fast-tier allowed\|off` | with `off`, the default, jobs ignore `fast: true`; with `allowed`, it asks for the priority tier |
| `/relay:setup --job-mcp-off name,...\|none` | Codex jobs turn off these MCP servers |
| `/relay:rescue <task>` | hand an investigation or a fix to a `relay:job` agent; `--backend`, `--model`, `--effort`, `--grok-home`, `--kimi-home`, `--read-only` and `--write` become its header, `--background` runs the agent in the background |
| `/relay:status [job] [--all]` | this repository's newest 20 jobs, every repository's with `--all`, or one job's state block |
| `/relay:result [job]` | a job's state block and report; without a job, the newest finished job of this repository |
| `/relay:cancel [job]` | interrupt the turn; the worker is killed if the job has not ended 10 s later; without a job, the only active job of this repository |
| `/relay:review` | a review of the working tree or of a branch, on Codex's own reviewer or, with `--backend grok\|zcode\|kimi`, the plugin's prompt |
| `/relay:adversarial-review [focus]` | a review that questions the approach and its assumptions; its answer must be review JSON |
| `/relay:transfer [--source <jsonl>]` | import the current Claude Code session into a Codex session you resume with `codex resume <id>` |

The plugin's hooks module answers `/relay:status`, `/relay:result`, `/relay:cancel` and
`/relay:transfer` itself: it runs the companion and shows its output, with no model turn and no
tokens spent. The answer starts with the command as you typed it, then the companion's lines in a
code block, as it prints them, then a job's report as Markdown, or the job list as a table.
`claude -p "/relay:result <job>"` exits with the companion's exit code (0 completed, 3 ended
without a report, 4 running, 5 cancelled), with `--output-format text` or `json`; under
`stream-json` Claude Code exits 0. These four run only when you type them. When you ask
in plain words, Claude reads jobs with the companion in Bash, which a session in `default`
permission mode asks you about, and cancels a job by sending its agent the message `cancel`.

Claude can run `/relay:setup`, `/relay:rescue`, `/relay:review` and `/relay:adversarial-review`
itself when you ask for one in plain words, for example "review my changes on Kimi". A review Claude
starts never stops to ask you anything: without `--wait` or `--background` it runs in the foreground.
Claude Code treats each of these runs as a Skill call. A session in `default` permission mode asks
you before Claude runs one, and `claude -p` refuses the call unless it is allowed. To run the two
reviews without a prompt, allow `Skill(relay:review)` and `Skill(relay:adversarial-review)`, in
`permissions.allow` or with `claude -p --allowedTools`.

Every job has its own directory under `$RELAY_JOBS_HOME` (default `~/.relay-jobs`), its own
worker and its own server process. Jobs belong to no Claude session and survive its end. The skill's
"Direct use" section lists the companion's commands for scripts.

### Review flags

`/relay:review` and `/relay:adversarial-review` take the same flags. A review runs read-only and
is recorded as a job, so `/relay:status` lists it.

| Flag | What it does |
|---|---|
| `--backend codex\|grok\|zcode\|kimi` | the backend; Codex when omitted |
| `--model <m>`, `--effort <e>` | as in a header; without them, the backend's defaults, and effort `high` on ZCode. Codex's own reviewer takes no effort, so `--effort` there prints a `note:` |
| `--grok-home <H>` | the Grok home, as in a header; Grok only |
| `--kimi-home <H>` | the Kimi home, as in a header; Kimi only |
| `--base <ref>` | review the branch against `<ref>` |
| `--scope auto\|working-tree\|branch` | `auto`, the default, reviews the working tree when it has changes, else the branch against the default branch |
| `--wait`, `--background` | run in the foreground, or as a Claude background task; without either, a review you type asks, and a review Claude starts runs in the foreground |
| `[focus]` | text after the flags; `/relay:adversarial-review` only |

Grok, ZCode and Kimi read only the diff inlined in their prompt, so they refuse a change above two files
or 256 KiB before anything starts. An adversarial answer that does not match the review schema
fails the review with the raw answer in the report.

### The stop-time review gate

`/relay:setup --enable-review-gate` turns on the stop-time review gate for this repository, every
worktree and session of it; `/relay:setup --disable-review-gate` turns it off. It is off by default
and runs on Codex only, in the default Codex home at its default model and effort. When the main
thread stops after a turn, one read-only Codex job reviews that turn's edits, as Claude's last
message describes them, against the working tree as it stands, and blocks the stop only when Codex
answers `BLOCK:`. It gets no diff of the turn, so it cannot tell Claude's edits from changes that
were already in the working tree. The gate skips, with a note, while a background task, a Workflow
or a job of this repository runs, while a stop-hook continuation is already in progress, and when
Codex is unavailable or the review fails. Grok, ZCode and Kimi do not run it; use `/relay:review`
on those.

Each review is a Codex job and costs usage. Turn the gate on for sessions you watch.

### Codex configuration

Codex jobs use the global `codex` binary and its own configuration: the Codex home's
`config.toml` (`~/.codex`, or `CODEX_HOME` when it is set), and a project's `.codex/config.toml`
when Codex trusts the project. `model: default` and `effort: default` take the configured `model`
and `model_reasoning_effort`:

```toml
model = "gpt-6-astra"
model_reasoning_effort = "high"
```

Your Codex sign-in, API key and provider configuration apply as they do in the Codex CLI.

## What the relay depends on in Claude Code

The relay reads two things Claude Code does not publish as an interface: the agent transcript and
the Workflow tool's run journal. Its markers were read from Claude Code 2.1.287 and 2.1.288, and its
hooks need `SubagentHandback`. Its hooks module needs the `session.send`, `agent.spawn` and `command.run` events of
the Mod API, so the floor is Claude Code 2.1.307. A Claude Code update can break it. The check after an update is one workflow that runs a `relay:job` agent: the job's `job.json`
must hold the call's key as `relay.journalKey` (once another relay has adopted the job, its
`relay.json` holds the binding), and the script must get the state block back. Repeat this check
after a Claude Code update. It was last run in full on Claude Code 2.1.302, on Fedora, for the 2.1.0
release, on Codex, Grok, ZCode and Kimi: a foreground `relay:job` agent's hand-back, a Workflow
call's state-block return with its `relay.journalKey`, a relay restarted with `TaskStop` and
`resumeFromRunId` that adopted its running job, a background agent steered and then continued with
`SendMessage`, and a cancel by message. The 2.0.0 release was checked on Claude Code 2.1.296,
without the adoption.

The hooks are PreToolUse on `Bash`, `Write`, `SubagentHandback` and `StructuredOutput`,
SubagentStop on `relay:job`, PostToolUse on `TaskStop`, SessionStart and Stop. Claude Code gives
subagents the `SubagentHandback` tool only in auto mode. In other modes, the SubagentStop hook checks
the relay's final text against the job's result instead. The PostToolUse hook cancels the job of a
relay that `TaskStop` stopped. The hooks module (`hooks/mod/register.js`) adds an `agent.spawn` hook,
which checks a `relay:job` prompt's header and refuses the spawn with the parser's message when the
header is bad, and a `session.send` hook: when a message is sent to a relay, it ends the relay's
current wait, and the guard delivers the message at the relay's next call. The module only checks
headers and wakes a waiting relay: delivery runs on command hooks and the transcript. Its
`command.run` hooks answer `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer`.

## Development

`package.json` names the package `@libar-dev/relay-plugin-cc`, version 3.0.0-pre.2. It is private and
not published to npm. Clone the repository and run:

```bash
npm ci
npm test
npm run check
```

The hooks module runs only inside Claude Code, so its checks need the CLI (no sign-in):

```bash
claude plugin validate plugins/relay
claude plugin test plugins/relay
```

`claude plugin test` runs `plugins/relay/hooks/mod/register.test.ts` against Claude Code's own test kit. CI runs both
on a pinned Claude Code.

`npm test` runs every file in `tests/` with `node --test` and takes about two minutes. Run it
outside any sandbox. Its process tests use `ps` to find and stop test processes. The tests drive
fake backend binaries and never start a real backend. A few tests depend on timing (the 50 ms grace
before a closing server gets SIGTERM, a transport test with a 5-second child) and can fail on a busy
machine, for example with several suites running at once; each passes alone, so rerun a failure on
an idle machine before reading it as a regression. Each test file's process keeps its temporary
files under one `relay-test-run-*` directory in the temp directory, which `TMPDIR` points at, and
removes it at exit once no test process runs from it. A directory whose run was killed by a signal
is removed by the next run once its recorded owner is gone. `RELAY_TEST_KEEP_TMP=1 npm test` keeps
the directory of a file that failed; no later run removes it, so delete it yourself. `npm run check`
type-checks the plugin's scripts (`plugins/relay/scripts/`) with TypeScript, without an installed Codex CLI.

A build is tried before a release in an independent Claude Code session on the test machine, while
every other session there, the one that starts the test included, keeps the released plugin:

- `scripts/smoke/install-local.sh <dir>` installs `HEAD`'s `plugins/relay` (`--worktree` adds
  uncommitted edits) as `relay@relay-smoke` for `<dir>` only. It adds a scratch marketplace and
  installs, and disables `relay@libar-relay`, at local scope, so only a session started in `<dir>`
  loads the build. `scripts/smoke/uninstall-local.sh <dir>` undoes it. The install's receipt is kept
  in `${XDG_STATE_HOME:-$HOME/.local/state}/relay-plugin-cc/smoke-installs/`, never in `<dir>`, so
  nothing in a project folder can make the uninstall delete anything outside it.
- `scripts/smoke/pane.sh` runs that session in tmux on a private socket, so an agent can start it,
  type prompts and read the screen (`start`, `send`, `read`, `wait`, `trust`, `stop`).
  `pane.sh attach-command <name>` prints the line to watch it.
- `node scripts/live/suite.mjs` is the live suite: checks that drive a real Claude Code session
  against the real backends, such as a steer from the main thread, a Workflow agent or a plugin,
  and a continue after the hand-back (`list` names them). `run <check>` or `run all` runs them
  in the terminal, each in a tmux pane with `--plugin-dir` and a fresh jobs home. In T3 Code,
  `prepare` writes a check's prompt for a thread whose project has the build installed, and
  `analyze` reads the thread's transcript afterwards. Each run writes one record per backend to
  `docs/live/records/`, and `table` generates [docs/live/capabilities.md](docs/live/capabilities.md)
  from them; `npm test` fails when the two disagree. A run's evidence (screen, transcripts, job
  folders) stays in `~/.local/state/relay-plugin-cc/live/`.

`claude plugin marketplace update` installs a new build only when the plugin's version goes up.
Every release that changes the plugin bumps it with `node scripts/bump-version.mjs <version>`,
which sets the manifests, `package.json` and `package-lock.json` (`npm run check-version` checks
them); the version named above in this section is set by hand.

Read [docs/architecture.md](docs/architecture.md) for the code layout and module rules,
[docs/backends.md](docs/backends.md) for the backend contract,
[docs/design.md](docs/design.md) for the behavior and the reasons behind it, and
[docs/kimi.md](docs/kimi.md) for what the Kimi backend rests on and how to check a new Kimi version, and
[docs/thread-surveys.md](docs/thread-surveys.md) for the surveys of real use that fixes came from.
