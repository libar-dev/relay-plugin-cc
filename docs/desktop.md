# relay in the Claude desktop app

The Code tab of the Claude desktop app runs Claude Code, so relay runs there much as it does in a terminal, with
the differences listed at the end of this page. This page says how to install it, how to check that it works, and
how to try an unreleased build in one folder. The [README](../README.md) has the install and the commands, and
[design.md](design.md) says how the relay works.

Checked with Claude for Mac 3.6556.1 (8e298a), its Claude Code 2.1.308, relay 3.0.0-dev.4 (2ffd7ba), Codex 0.163.0
and Node 24.21.0, on macOS 27.2, on 22 October 2026. The check used a local session in Auto mode. It covered
`/relay:status`, `/relay:setup`, `/relay:result`, a job steered with `SendMessage`, a refused header, `TaskStop` and
a Workflow job. It did not cover `/relay:cancel`, `/relay:transfer`, the Manual permission mode, an SSH session,
Windows, or a backend other than Codex.

## What runs where

- **The Code tab, in a local session.** The check ran `relay:job` agents from the Agent tool and from a Workflow
  script, steering with `SendMessage`, `/relay:status` and `/relay:result` answered with no model turn, the spawn
  check and `TaskStop`. `/relay:cancel` and `/relay:transfer` are answered the same way as `/relay:status`; the
  check did not run them.
- **An SSH session.** Anthropic's [desktop docs](https://code.claude.com/docs/en/desktop) say the Code tab can run
  Claude Code on another machine over SSH, reading that machine's `~/.claude`. Relay, the backends and the jobs
  would then live there. The check did not try it.
- **Chat and Cowork.** Relay runs in Claude Code sessions. The check did not try Chat or Cowork.

## Requirements

- **macOS or Linux** on the machine where the session runs. Relay reads the process table with `ps`, and does not
  run on Windows ([README](../README.md#install)). Anthropic's Linux build of the app is a beta for Debian and
  Ubuntu ([desktop on Linux](https://code.claude.com/docs/en/desktop-linux)).
- **The Code tab's own Claude Code, 2.1.307 or later.** The app ships a Claude Code of its own, whose version can
  differ from the `claude` in your terminal. On macOS it lives in
  `~/Library/Application Support/Claude/claude-code/<version>/`. A session's transcript, under
  `~/.claude/projects/`, also records the version that wrote each entry in its `version` field.
- **The Claude Code CLI in a terminal**, to install the plugin as below. The check did not look for a way to
  install it from the app.
- **Node.js 22 or later**, and **at least one backend CLI, installed and signed in** (Codex, Grok Build, ZCode or
  Kimi Code), on the same machine ([README](../README.md#backends)). The app starts Claude Code with its own
  environment, so check that a Code tab session finds them: run `/relay:setup` there. In the check it found every
  backend the terminal found.

## Install

Install relay with the CLI, as the README says:

```bash
claude plugin marketplace add libar-dev/relay-plugin-cc
claude plugin install relay@libar-relay
```

The Code tab loads the plugins the CLI installs, because both read `~/.claude`
([plugins](https://code.claude.com/docs/en/plugins/install)). Start a new session in the Code tab after the install.
The check did not try `/reload-plugins` in the app.

## Permission mode

The Code tab picks a permission mode per session, in the menu under the prompt: Auto, Manual, Accept edits or
Plan. In the check, Bypass permissions was greyed out, with the note "Enable in Claude Code settings".

Auto is Claude Code's auto mode, so the README's note on [auto mode](../README.md#auto-mode) applies: its
classifier can block a `relay:job` launch, and the README says how to add an exception and what to do if a launch
is still blocked. In the check, with no exception in `~/.claude/settings.json`, no launch was blocked and no
permission prompt appeared. The launches were asked for in the user's own messages.

In Auto mode a finished relay hands its report back with Claude Code's `SubagentHandback` tool. In other modes the
relay's last message carries it instead (design.md, "The report"). The check ran only in Auto.

## Check that it works

Open a git repository's top-level folder in the Code tab, choose Auto, and start a new session. Then:

1. Type `/relay:status`. The command menu lists relay's commands as you type. The first Return picks the command
   from the menu, and the prompt then shows `/status [job-id] [--all]`: that is still `/relay:status`, with its
   argument hint. A second Return sends it. The output appears under the line `relay: /relay:status`, without a
   model turn, once any running turn has ended. Its `relay-version:` line names the version the session loaded.
2. Start a job, and steer it while it runs. Ask the session to launch one `relay:job` agent in the background with
   this prompt:

   ```
   backend: codex
   model: default
   effort: low
   ---
   Run sleep 60 once, then write a report that quotes every message you received while you worked.
   ```

   Then, within the minute, ask the session to send that agent a message with `SendMessage`. The agent shows under
   its description in the conversation, and in the Background tasks panel on the right. In the check, the job took
   the message 6.4 s after the send. In the job's folder, which is the `dir:` line of its state block, under
   `~/.relay-jobs/`, `inbox/outcomes/` then holds a file whose `action` is `steered`.
3. Read the report. When the job ends, the report reaches the session as a "Message from subagent", and it quotes
   your message. Clicking the agent in the Background tasks panel shows its prompt, the relay agent's own model
   (Haiku, not the job's) and the state block it handed back. `/relay:result <job>` prints the state block and the
   report without a model turn.
4. Check that a bad header fails at once. Ask the session to launch a `relay:job` agent whose header has an extra
   line such as `colour: red`. The spawn is refused before any relay or job starts, with the parser's message:
   `Subagent spawn denied by a plugin: Unknown header key "colour". Known keys: ...`. The Agent entry shows as
   Failed, and no job folder is created.
5. Stop a job. Launch another job like the one in step 2 with `sleep 120`, and ask the session to stop its agent
   with `TaskStop`. The job becomes `cancelled`: in the check 0.4 s later, though a cancel may take up to about 10
   seconds. `/relay:status` lists it as cancelled; from 3.0.0-dev.5 it is no longer marked "not handed back",
   since the TaskStop result carried the cancelled job's block.
6. Run a Workflow. Ask the session to run a Workflow whose script calls `agent(prompt, { agentType: 'relay:job' })`
   with a short job. The Workflow returns the job's state block. It shows as a card in the conversation, and in the
   Background tasks panel with its phases and agents.

## Try an unreleased build in one folder

`scripts/smoke/install-local.sh` installs a build of this repository for one folder only, at local scope, so every
other session keeps the released plugin. Run it from a clone of this repository:

```bash
git clone https://github.com/libar-dev/relay-plugin-cc && cd relay-plugin-cc
scripts/smoke/install-local.sh ~/path/to/folder
```

- **The folder.** It must exist, and be the top level of a git repository or outside any repository.
- **The build.** It is the clone's `HEAD`, taken with `git archive`, so commit your edits first, or pass
  `--worktree` to copy the working tree.
- **What changes.** In that folder the released relay is disabled and the build takes its place.
- **A second folder.** It needs its own name: `--name relay-smoke-<something>`.

Open that folder in the Code tab (the folder menu under the prompt lists recent folders and opens others), and
start a new session. Check the version with `/relay:status`. When you are done, remove the install from the clone
with `scripts/smoke/uninstall-local.sh ~/path/to/folder`. Do it before long: the install keeps its marketplace in
the system's temporary folder, and the uninstall refuses to run once that folder is gone.

## What the Code tab shows differently

- **A command the module answers.** Its output appears as a block under the line `relay: /<command>`. The
  companion's output comes first, in a copyable code block. A table after it, such as the job list, is drawn as a
  table with a horizontal scroll bar. The session's transcript records it as a local command's output, with no
  model turn.
- **Background tasks.** A background `relay:job` agent and a Workflow each appear in the Background tasks panel,
  with their elapsed time and a stop button. A stopped agent stays there, marked Stopped.
- **The relay's own waits.** The relay agent's `companion wait` calls show in the conversation as
  "Background command completed · Wait for the relay job to finish". They are the relay agent's calls, not the
  main conversation's.
- **The agent's prompt.** The agent view renders the prompt as Markdown. The header lines run together, and the
  `---` line turns the line above it into a heading. This is display only: the job receives the prompt as it was
  sent.
- **Session names.** The app names a session after its first message, and lists it under the folder's name in the
  sidebar.
