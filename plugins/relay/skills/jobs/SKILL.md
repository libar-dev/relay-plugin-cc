---
name: jobs
description: "Run jobs on Codex, Grok Build, ZCode and Kimi Code from Claude Code like Claude agents, as a `relay:job` agent or from a workflow script. Load it before launching or messaging such an agent, and before running `companion` commands yourself."
---

# Job agents

A `relay:job` agent runs one job and returns the job report verbatim. Launch it like a Claude agent:

```
Agent({ subagent_type: "relay:job", description: "<3-5 words>", prompt: "<header>\n---\n<brief>", run_in_background: true })
```

## Relay or a T3 Code delegate

Relay complements T3 Code and replaces none of its features. In a T3 thread, T3's own threads, delegates and task tracking come first; relay carries the jobs they cannot.

In a T3 Code thread (the `t3-code` MCP server's tools are there, `delegate_task` among them), consider a T3 delegate first for a plain fan-out of independent agents: reviews, research, one-off fixes. T3 runs each child as a thread of its own, on any provider and model in its catalog with that model's options, tracks it with `task_status`, and wakes the lead when it ends. No Claude relay holds a slot or spends Claude usage while the child works.

Use `relay:job` for:

- the jobs of a dynamic workflow: a Workflow script cannot call T3's tools;
- a job that needs relay itself: a header's `mode` and `web-search`, steering a running turn, continuing the session, adoption on `resumeFromRunId`, or the state block a script reads;
- every job outside T3 Code, in the plain Claude Code harness.

## The prompt

Header lines of `key: value`, a line `---`, then the brief, which reaches the job byte for byte. Only the header sets the job: "do not edit files" in a brief leaves `mode` as it is.

```
model: gpt-6-astra
effort: xhigh
mode: write
cd: /abs/path/to/repo
---
<the brief>
```

| Key | Required | Values | Default |
|---|---|---|---|
| `backend` | no | `codex`, `grok`, `zcode`, `kimi` | `codex` |
| `grok-home` | no | Grok only: `jobs` for `~/.grok-jobs`, another name, an absolute or `~/` path, or `default` | `default` |
| `kimi-home` | no | Kimi only: `jobs` for `~/.kimi-code-jobs`, another name, an absolute or `~/` path, or `default` | `default` |
| `model` | yes | a model name, or `default` for the home's config | none |
| `effort` | yes | `low` ... `xhigh`, `max`, `ultra`, or `default` | none |
| `fast` | no | `true` selects OpenAI's `priority` tier when the setting `fast-tier` is `allowed`, kept on continue and resume; ignored under `fast-tier: off`, the default, with a `note:` in the state block | `false` |
| `mode` | no | `yolo` (no sandbox, no approvals), `write` (`workspace-write`), `read-only` | `yolo` |
| `network` | no | `true`, `false`; `write` and `read-only` only | `false` |
| `web-search` | no | `live`, `cached`, `disabled` | `live` |
| `cd` | no | absolute directory the job works in | the agent's directory |
| `add-dir` | no | absolute extra writable root, repeatable; `write` only | none |
| `brief` | no | absolute path of the brief file; nothing follows the dashes | none |

- A bad header fails the Agent call at once, before a relay starts, with the reason the job would have been refused: `Subagent spawn denied by a plugin: <reason>`. Fix the header and spawn again.
- A model named like another backend's (`glm-*`, `grok-*`, `kimi-code/*`) with no `backend:` is refused before launch, since the job would run on Codex. `backend: codex` sends it to Codex as written.
- Ask a `read-only` job for its report as its final answer, not in a file it writes. Codex and Grok hold `read-only` with a sandbox: their commands run and cannot write. Kimi and ZCode have no sandbox: `read-only` takes their shell and write tools away, and what they start themselves (hooks, MCP servers, Kimi's own operations) can still write. See Kimi jobs and GLM jobs.
- In Codex `mode: write`, a command that keeps its own state under `~` (a CLI's sign-in file, say) cannot write it there. Name that directory with `add-dir:`. Grok's `write` takes no `add-dir:`; such a job needs `mode: yolo`.
- `yolo` is the default, so existing headers keep running as they did. `mode: write` with `network: true` covers web search, installs, commits and child processes on Codex and Grok, but not `ps` or writes outside the working directory. `yolo` ignores `network` and `add-dir` and the state block says so. The brief is then the only fence: name where the job may write.

## GLM jobs

`backend: zcode` runs Z.ai's GLM models through ZCode, Z.ai's own harness, on the Anthropic Messages API, GLM's native interface. It is the only route for GLM. GLM-5.3 and GLM-5.3-Flash are separate models and equal options; choose by the task. Effort is `low`, `high` or `max`, and `effort: default` is `high`.

| `model` | ZCode's id | On ZCode |
|---|---|---|
| `glm-5.3` | `GLM-5.3` | runs |
| `glm-5.3-flash` | `GLM-5.3-Flash` | runs |
| `glm-5.3-flashx` | none | not supported yet |

A model id matches ZCode's without regard to case: `glm-5.3-flash`, `GLM-5.3-Flash` and `account:zai-individual-coding-plan/glm-5.3-flash` all run `GLM-5.3-Flash`. The job matches it against every model the sign-in serves, the list ZCode's model picker shows, which comes with the Z.ai plan; `/relay:setup --backend zcode` prints it. A model that is not in the list reaches ZCode as written and fails the job with ZCode's `model_not_found`. When the list cannot be read (an error, or no answer in 10 s), the model goes as written too, and the state block says why in a `note:`. ZCode's own default effort is `max`; the plugin uses `high`.

### Through ZCode

- `model`: a model id, matched without regard to case against every model the sign-in serves, or `default`, ZCode's default model; `<provider>/<model>` names a provider.
- `effort`: `default` is `high`.
- Sign-in is the CLI's own `zcode login`, shared by every job; there is no home key. `/relay:setup --backend zcode` prints the binary, version, whether the credentials file is a regular file of more than two bytes, the default model and every model the sign-in serves, without a model call: it asks one `zcode app-server` for a draft session's model list and closes the draft unsaved. No list, or an empty one, leaves the block not ready. Whether the sign-in works is checked by the first turn.
- `yolo` is ZCode's yolo mode. `read-only` is ZCode's build mode with its write, shell and code tools removed from every message; permission requests are allowed only for its reading tools, and a resumed session is held to those tools. `write` is a usage error: ZCode has no workspace sandbox, and no OS sandbox at all.
- `web-search` is `live` or `disabled`; `disabled` removes WebSearch, WebFetch and the web reader. `fast` is ignored with a `note:`. `grok-home` is an error.
- Every job loses AskUserQuestion, plan mode, subagents (`Agent`, `SendMessage`), the Cron tools and ReadSessionContext, and runs with ZCode's memory off. A turn ZCode starts on its own when a background command finishes gets these tools back until the session is resumed. Browser control and ZCode's official web-reader and image MCP servers are unavailable. ZCode's plugins and skills, `~/.zcode/AGENTS.md`, and the working directory's `AGENTS.md` and `.zcode/` settings still load.
- The same relay, SendMessage, cancel, continue, recovery and Workflow adoption apply. A steer joins the running turn; one that arrives as the turn ends becomes ZCode's next turn, and the job waits for it. ZCode retries model calls itself, so a capacity failure fails the job at once; `resume` continues it. The block prints `backend: zcode`. Reviews run on ZCode with `--backend zcode` (see Reviews); the stop gate and `transfer` remain Codex only.

## Grok jobs

`backend: grok` runs Grok Build through `grok agent stdio`, using the selected home's
subscription sign-in. `grok-home: jobs` selects `~/.grok-jobs`; `default` selects `~/.grok`.
`model` and `effort` remain required. `default` sends no override; Grok rejects invalid values.
`fast: true` is ignored with a note; select `model: grok-4.7-build-fast` to request that model.

- The same relay, SendMessage, cancel, continue, recovery and Workflow adoption paths apply.
  Continue and recovery keep the first launch's backend and home. The block prints
  `backend: grok` and `grok-home:` for a non-default home.
- `yolo` removes the sandbox. `write` uses Grok's `workspace` profile and refuses `add-dir`
  and linked git worktrees; those need `mode: yolo`. `read-only` uses Grok's `read-only`
  profile. A profile Grok cannot apply fails the job with its error. Child-process network
  follows the profile, and macOS does not enforce it.
- `web-search: live` is supported. `cached` and `disabled` are usage errors; removal of both
  web tools has not been proved in agent mode.
- `/relay:setup --backend grok [--grok-home H]` prints the binary, version, sign-in and models
  from `grok models`, without a model call. The binary is `GROK_BINARY`, else the first `grok`
  on `PATH`. When that file is a script, setup says so and names the real binary if it finds
  one: a wrapper such as cmux's may run its own hooks when a job starts `grok agent`. Set
  `GROK_BINARY` to the real binary to pin it; jobs otherwise keep what `PATH` gives. For a home with no personal MCP servers or hooks, read
  [`grok-home.md`](grok-home.md) before creating or signing in to it. Compatibility sources
  and memory are disabled in the process environment, but Grok still loads installed Claude
  plugins. The chosen home's MCP servers and hooks, and the working directory's Grok rules,
  remain active.
- Reviews run on Grok with `--backend grok` (see Reviews), always under Grok's `read-only` profile. Where Grok refuses that profile (on a Mac whose `/var/run/docker.sock` is a symlink, or on Linux where it cannot reach a runtime socket such as `/run/podman/podman.sock`), the review fails with Grok's error. The stop gate and `transfer` remain Codex only.

## Kimi jobs

`backend: kimi` runs Moonshot AI's Kimi Code through `kimi acp`, using the selected home's
sign-in. `kimi-home: jobs` selects `~/.kimi-code-jobs`; `default` selects `~/.kimi-code`. `model`
and `effort` remain required: a model is the home's alias (`kimi-code/k3`,
`kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`), and an effort is one the model
lists (`low`, `high`, `max` on K3; `on`, `max` on K2.7 Highspeed). `default` sends no override;
Kimi refuses an alias or effort it does not know, and the job fails with Kimi's words. `fast` is
ignored with a `note:`.

- The same relay, cancel, continue, recovery and Workflow adoption paths apply, and continue and
  recovery keep the first launch's backend and home. **A running Kimi turn takes no message**:
  `SendMessage` while a turn runs becomes the next turn (`queued-next-turn`), and a reply comes
  with that turn's report. The block prints `backend: kimi` and `kimi-home:` for a non-default home.
- `yolo` is Kimi's Never Ask mode. `read-only` is Kimi's default mode with every permission
  request rejected, and relay refuses the file writes and terminal commands Kimi sends through
  the client. That is not an OS sandbox: Kimi's hooks, the MCP servers and plugins it starts, and
  its other local operations can still have side effects. `write` is a usage error: Kimi has no
  workspace sandbox. `web-search: live` only.
- The outcome and the report come from the session's own record (`wire.jsonl`), because Kimi
  answers `end_turn` over ACP for a turn that failed. Kimi retries model calls itself, so a
  capacity failure fails the job at once; `resume` continues it.
- Kimi's record of the session, with every tool call it made, web searches included, is
  `<home>/sessions/<bucket>/<session>/agents/main/wire.jsonl`, where `<session>` is the block's
  `session:`.
- The chosen home's MCP servers, plugins (with their session-start skills), hooks, skills and
  `AGENTS.md` load in every job. For a home without them, read [`kimi-home.md`](kimi-home.md).
  `/relay:setup --backend kimi [--kimi-home H]` prints the binary, version, sign-in and models
  from `kimi provider list --json`, without a model call.
- A turn Kimi starts on its own (a background command finished) runs unseen: its work is not in
  the report. A completed job confirms the turn relay sent, and only that turn: not the background
  tasks Kimi started, which may still run or be lost. A task's notice that arrives during a later
  turn is handled in that turn, and its answer can end that turn's report. A message queued behind a turn of Kimi's own
  cannot be cancelled over ACP; relay cancels it by ending Kimi's server. Reviews run on Kimi with `--backend kimi` (see Reviews); the stop gate and
  `transfer` remain Codex only.

## Reviews

`/relay:review` and `/relay:adversarial-review` (`C review`, `C adversarial-review`) take the header's keys as flags: `--backend codex|grok|zcode|kimi` (Codex unless given; nothing stores a default), `--model`, `--effort`, `--grok-home`, `--kimi-home`, beside `--base <ref>` and `--scope auto|working-tree|branch`. A review is read-only and runs in the foreground, or as a Claude background task with `--background`; it is recorded as a job (`kind: review` or `adversarial-review`), and its block prints `backend:` as a job's does.

- Codex: the review runs in the Codex home, as a Codex job does. `/relay:review` is Codex's own reviewer, which takes no effort: `--effort` there is a `note:`. `/relay:adversarial-review` sends the plugin's prompt with the schema as Codex's `outputSchema`.
- Grok, ZCode and Kimi: the plugin's prompts (`prompts/review.md`, `prompts/adversarial-review.md`) on a fresh read-only session, with the diff inlined. Above two files or 256 KiB the review is refused; narrow it with `--base` or `--scope`, or run it on Codex. The adversarial prompt carries the schema as text and the plugin checks the answer.
- An adversarial answer that is not review JSON fails the review on every backend: `error: <backend> returned no valid review JSON`, the raw answer in the report, a non-zero exit. There is no second try.
- A review turn that fails is reported as `The <backend> turn failed: <error>`, with the backend's error as `error:` and a non-zero exit. Anything it had sent stays raw and is never read as review JSON.

## What comes back

The completion notice is a state block, a line `---`, then the report as the backend wrote it:

```
state: completed
job: job-mur1abcd-1a2b3c4d
model: gpt-6-astra
effort: xhigh
duration: 4m 12s
report: ~/.relay-jobs/<repo>/<job>/report.md
dir: ~/.relay-jobs/<repo>/<job>
...
---
<report>
```

- `state` is `completed`, `failed` (with `error:`), `cancelled`, `dead` (the worker died and its automatic retry was spent), or `starting`/`running`. A failed start is `state: not started` with `error:`. A block with no `---` has no report.
- `completed` means the job finished its answer, not that its commands passed. Read the report.
- Lines that may appear: `backend:`, `grok-home:` and `kimi-home:` (see Grok jobs, GLM jobs and Kimi jobs), `kind:` (a review), `tier: fast`, `mcp-off:` (the MCP servers this job turned off), `relay:`, `note:`, `stalled:` (no event for ten minutes; information only), `capacity-retries:`, `automatic-resume:` (a recovery and its cause), `relay-adopted:`, `undelivered:` (messages to the job, acknowledged and not run yet; `resume` runs them; it says nothing about the report), `not-delivered:` (dropped, for example by a cancel), and `relay-violation:` (the hook let the relay go, or a delivery or a cancel failed; read the job yourself with `C result <job>`).

`status` marks a relay job that ended with no hand-back of its result `not handed back` (`handedBackAt: null` in `--json`): its caller died or gave up, and `C result <job>` has the report.

A failed cancel stays pending while the job runs and tries remain. A terminal job closes it as done, and three started tries close it as failed.

## Talking to a running or finished job

| You do | While the job runs | After it ended |
|---|---|---|
| `SendMessage` with text | steers the running turn; if the turn cannot take it (always on Kimi), it becomes the next turn | a new turn on the same thread; the agent returns the new report |
| `SendMessage` with exactly `cancel` | interrupts the turn; if the job has not ended 10 s later, kills the worker | nothing |
| `TaskStop` on the agent | stops the agent and cancels the job, as `cancel` does; the TaskStop result comes with the cancelled job's block | nothing |

A message reaches the job within seconds: the plugin's hooks module ends the relay's current wait when the message is sent, and the relay's hook delivers it. A line the user types into the agent's own view has no such wake: it reaches the job at the relay's next step, at most nine minutes later, or as a new turn once the job has ended. Stop a job with `TaskStop` when you no longer need the agent; send `cancel` when you want the agent to hand back the cancelled job's result. A job survives its agent ending any other way, and the end of the Claude session. A dead or failed job continues on a message or `C resume <job>`.

## Inside a workflow script

`agent(prompt, { agentType: 'relay:job', label })` takes the same header and brief. It returns the state block as a string, with no `---` and no report. Once a job exists, `state:`, `job:`, `duration:`, `report:` and `dir:` are always present (`report: none` when there is none). Read the block by its lines and treat every state but `completed`, and a block with an `undelivered:` line, as a failed step:

    const jobReturn = (text) => Object.fromEntries(
      String(text ?? '').split('\n').flatMap((line) => {
        const m = /^([a-z-]+): (.*)$/.exec(line.trim())
        return m ? [[m[1], m[2]]] : []
      }),
    )
    const r = jobReturn(await agent(prompt, { agentType: 'relay:job', label: 'writer-3' }))
    if (r.state !== 'completed' || r.undelivered) return { step: 'writer-3', state: r.state, undelivered: r.undelivered, error: r.error, job: r.job }

- The relay retypes the block. The hook accepts it with a line left out that restates the request or only informs (`relay:`, `model:`, `mode:`, `cwd:`, `session:`, `note:` and the like), never with an outcome line left out (`state:`, `job:`, `duration:`, `report:`, `dir:`, `error:`, `undelivered:` and the like) or any line changed. A return with no `state:` line comes from a relay that was let go or a Claude Code failure such as a usage limit, and its job may still run: find it by label with `C status --workflow <run> --json`.
- A relay is a Claude agent and spends Claude usage for its job's whole run. When Claude's usage limit ends the relays, their jobs run on; collect them with `C status --workflow <run>` or `C status --all`.
- Give a `relay:job` agent no `schema`. A script cannot read files either: for structured data, ask the brief for the shape, then hand `r.report` to a Claude agent that has the schema: `agent(\`Read ${r.report} and return its findings.\`, { schema: FINDINGS })`.
- The agent holds its slot for the job's whole run, so size a launch by job length. `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` caps how many run at once.
- A retried or resumed call takes over its running job. Two calls with the same prompt and label are two jobs. Adoption is not a follow-up: a script cannot send a new turn to a job it names. To continue a finished job from a workflow, give a Claude agent the job id and have it run `C continue <job> --message-file F`.
- An `agent()` whose header is bad throws at once, before a relay starts: `Workflow agent spawn denied by a plugin: <reason>`. Catch it per call, `agent(prompt, opts).catch((error) => ({ refused: error.message }))`: an uncaught throw inside `parallel` fails the run while the other agents' jobs run on. After fixing the header, resume with `resumeFromRunId`, which adopts the running jobs.
- A skipped agent returns null. Stopping the workflow, with `TaskStop` too, ends the relays, not the jobs, so a `resumeFromRunId` adopts them; a `TaskStop` on the workflow comes back with the list of its jobs that keep running. `C status --workflow <run>` lists them; `C cancel <job>` the ones you abandon. To cancel one agent's job, send its agent id the message `cancel`: `TaskStop` has no task for one agent of a workflow.
- A review can be a step: a Claude agent whose prompt says to run `C review --wait` (or `C adversarial-review --wait`, with `--backend` and the other review flags) and return its output. The review runs in the foreground and is recorded as a job. Outside a workflow you can invoke `/relay:review` and `/relay:adversarial-review` directly instead.

## Direct use

You can invoke `/relay:review`, `/relay:adversarial-review`, `/relay:setup` and `/relay:rescue` yourself. A review you start never asks the user a question: without `--wait` or `--background` it runs in the foreground. `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` are the user's: the plugin's hooks module answers them without you. To read jobs yourself, run `C status` and `C result`, which print the same text; cancel a job with `TaskStop` on its agent, or by sending its agent the message `cancel`. The `C` commands below are for you, scripts and Workflow steps.

`C` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs"`. In your own Bash, define it as a function, `C() { node "<that path>" "$@"; }`: a variable that holds the command does not split into words in zsh. A job lives in `$RELAY_JOBS_HOME` (default `~/.relay-jobs`) under `<repo-slug>/<job-id>/`; any command takes a job id or a unique prefix, or the job's directory inside that home.

| Command | What it does |
|---|---|
| `C start --prompt-file <header+brief>` | start a job, print `job: <id>`, return at once |
| `C wait <job> [--timeout-seconds N] [--state-only]` | block until the job ends or N seconds pass (default 240); print the block and the report |
| `C status [<job>] [--all] [--workflow <run>] [--json]` | this repository's newest 20 jobs, every repository's with `--all`, every job of one Workflow run with `--workflow`, or one job's block |
| `C result [<job>] [--state-only]` | the block and report, without waiting; without a job, the newest finished job of this repository |
| `C steer <job> --message-file F` | steer the running turn, or queue the message as the next turn |
| `C continue <job> --message-file F` | a new turn on the same thread |
| `C resume <job> [--message-file F]` | continue a dead or failed job |
| `C cancel [<job>]` | interrupt the turn; if the job has not ended 10 s later, kill the worker; without a job, the only active job of this repository |
| `C review [--backend B] [--model M] [--effort E] [--grok-home H] [--kimi-home H] [--base R \| --scope S]` | a read-only review in the foreground, recorded as a job; prints the review |
| `C adversarial-review [the same flags] [focus]` | the same, with the adversarial prompt; exits 1 when the answer is not review JSON |
| `C prune [--older-than 14d] [--all] [--dry-run]` | remove old ended jobs; live workers are kept |
| `C setup --fast-tier allowed\|off` | with `off`, the default, jobs started from now on ignore `fast: true` and the Codex config sets their tier; with `allowed`, `fast: true` selects `priority` |
| `C setup --job-mcp-off name,name...\|none` | Codex jobs pass `enabled=false` for each listed name that the Codex home's `config.toml` defines; undefined names are skipped with a note |
| `C setup [--json]` | every backend home found (the Codex home, `~/.grok` and `~/.grok-*`, ZCode, `~/.kimi-code` and `~/.kimi-code-*`): binary and version, sign-in, default model and effort, models, `can`; exits 0 whatever it finds |
| `C setup --backend codex\|grok\|zcode\|kimi [--grok-home H\|--kimi-home H] [--json]` | one backend home; exits 1 when it is not ready |

A wide fan-out that needs no steering can start its jobs with `C start` a few seconds apart and collect them with `C wait` or `C status`; no Claude agent is held per job. Jobs started within the same second can hit a provider's request-rate limit. For Codex and Grok routes, the worker retries at 30, 60 and 120 s. ZCode and Kimi retry model calls themselves.

Exit codes of `wait` and `result`: `0` completed with a report, `3` ended without a report or with messages not yet run, `4` still running, `5` cancelled, including with a pending continuation because cancellation takes precedence, `1` usage error.

How the hook carries the relay, automatic recovery, git worktrees and the job directory's files are in [`internals.md`](internals.md). Read it when a job died or was recovered, a relay misbehaved, a job runs in a git worktree, or you change the plugin.
