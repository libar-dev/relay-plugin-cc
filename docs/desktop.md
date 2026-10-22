# relay in the Claude desktop app

The Code tab of the Claude desktop app runs Claude Code, so relay runs there as it runs in a terminal. You get
the same `relay:job` agent, the same messages and the same commands. This page says how to install it, what to
check, and how to try an unreleased build in one folder. The [README](../README.md) has the install and the
commands. [design.md](design.md) says how the relay works.

Checked with: Claude for Mac 3.6556.1 (8e298a), its Claude Code 2.1.308, relay 3.0.0-dev.4 (2ffd7ba) and Codex
0.163.0, on macOS 27.2 (an Apple silicon Mac), 22 October 2026. The check covered `/relay:status`, `/relay:setup`,
`/relay:result`, a job steered with `SendMessage`, a refused header, `TaskStop` and a Workflow job. It did not cover
`/relay:cancel`, `/relay:transfer` or an SSH session.

## What runs where

- **The Code tab** runs relay. That includes `relay:job` agents from the Agent tool and from Workflow scripts,
  `SendMessage` steering with the module's wake, the commands the module answers (`/relay:status`,
  `/relay:result`, `/relay:cancel`, `/relay:transfer`), the spawn check, and `TaskStop`.
- **Chat and Cowork** do not. Cowork does not read `~/.claude`, so it does not load Claude Code plugins.
- **An SSH session** from the Code tab runs Claude Code on the other machine. It reads that machine's
  `~/.claude`, so relay, the backends and the jobs live there.
- **Agent teams** run only in the CLI. Relay does not need them.

## Requirements

- **The Code tab's own Claude Code, 2.1.307 or later.** The app ships a Claude Code of its own, whose version
  can differ from the `claude` in your terminal. We found no command in the app that prints it. On macOS, the
  folder names in `~/Library/Application Support/Claude/claude-code/` are the versions it holds.
- **The backends**, installed and signed in on the machine where the session runs, as for the CLI
  ([README](../README.md#backends)). The app starts Claude Code with its own environment, so check that a session
  in the Code tab finds them: run `/relay:setup` there.
- **Node.js 22 or later**, on the same machine.

## Install

The Code tab reads the same files as the CLI: `~/.claude/settings.json`, the installed plugins, skills,
`CLAUDE.md`, and the MCP servers in `~/.claude.json` and `.mcp.json`. So install relay with the CLI, as the README
says, and the Code tab has it too:

```bash
claude plugin marketplace add libar-dev/relay-plugin-cc
claude plugin install relay@libar-relay
```

Add the marketplace with the CLI; we found no way to add one in the app. A session that was open before the
install does not have the plugin: start a new session in the Code tab.

The app also loads the MCP servers in its own `claude_desktop_config.json`. On a name clash, its entry wins over
the one in `~/.claude.json`.

## Permission mode

The Code tab picks a permission mode per session, in the menu under the prompt: Auto, Manual, Accept edits or
Plan. Bypass permissions stays greyed out until you enable it in Claude Code's settings. Auto runs relay's commands
and agents without asking. Auto is Claude Code's auto mode, so the README's note on
[auto mode](../README.md#auto-mode) applies: its classifier can block a `relay:job` launch unless you add the
exception it describes. In the check, with no exception, Auto let every launch through; each was asked for in the
user's own message.

## Check that it works

In a new Code tab session in a git repository:

1. `/relay:status` prints the job table at once, with no reply from the model. The module answered it. The command
   menu lists relay's commands as you type. The first Return picks the command from that menu, which then reads
   `/status [job-id] [--all]`; a second Return sends it. A command typed with its arguments, such as
   `/relay:result <job>`, is sent by the first Return. The output appears under the line `relay: /relay:status`;
   the header line `relay-version:` names the version the session loaded.
2. Start a job. Ask the session to launch a `relay:job` agent in the background with a short header, for example
   `backend: codex`, `model: default`, `effort: low`, and a brief that runs `sleep 60`, then reports every message
   it received while it worked. The agent appears under its description in the conversation and in the Background
   tasks panel on the right. Click it there to see its prompt, the relay's own model and, at the end, the state
   block and report it handed back.
3. Steer it. Ask the session to send the agent a message while the job runs. The job takes it within seconds: the
   job folder's `inbox/outcomes/` holds a file whose `action` is `steered`. The report reaches the session as a
   "Message from subagent", it quotes the message, and `/relay:result <job>` prints that report with no reply from
   the model.
4. A bad header fails at once. A launch whose header has a key relay does not know is refused before an agent
   starts, with the parser's message: `Subagent spawn denied by a plugin: Unknown header key ...`. The agent shows
   as Failed, and no job folder is created.
5. Stop a job. Ask the session to stop a running `relay:job` agent with `TaskStop`. The job is `cancelled` within a
   second, and `/relay:status` lists it as cancelled, "not handed back".
6. Run a Workflow. A Workflow script's `agent(prompt, { agentType: 'relay:job' })` returns the job's state block.
   The Workflow shows as a card in the conversation; click it to see its phases and agents.

## Try an unreleased build in one folder

`scripts/smoke/install-local.sh` installs a build of this repository for one folder only, at local scope, so
every other session keeps the released plugin:

```bash
scripts/smoke/install-local.sh ~/path/to/folder
```

The build is the repository's `HEAD`, taken with `git archive`, so commit your edits first, or pass `--worktree` to
copy the working tree. In that folder the released relay is disabled and the build takes its place.

Open that folder in the Code tab: in a new session, the folder menu under the prompt lists recent folders, and
"Open folder…" picks any other. Then send the first message. The session loads the folder's build. Check its
version with `/relay:status`. Remove the install with `scripts/smoke/uninstall-local.sh ~/path/to/folder`.

## What the Code tab shows differently

- The output of a command the module answers appears as a block under the line `relay: /<command>`, with the
  command's text in a copyable code block. A table after that block, such as the job list, is drawn as a table with
  a horizontal scroll bar. The session's transcript records it as a local command's output, with no model turn.
- A background `relay:job` agent and a Workflow each show their elapsed time and a stop button in the Background
  tasks panel. A stopped agent stays there, marked Stopped.
- The relay's `companion wait` calls show in the conversation as "Background command completed · Wait for the relay
  job to finish". They belong to the relay, not to the session.
- The agent view renders the prompt as Markdown, so the header lines run together and the `---` line does not
  show. The job receives the prompt as it was sent.
- The app names the session after its first message, and lists it under the folder's name in the sidebar.
