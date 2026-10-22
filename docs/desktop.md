# relay in the Claude desktop app

The Code tab of the Claude desktop app runs Claude Code, so relay runs there as it runs in a terminal. You get
the same `relay:job` agent, the same messages and the same commands. This page says how to install it, what to
check, and how to try an unreleased build in one folder. The [README](../README.md) has the install and the
commands. [design.md](design.md) says how the relay works.

Checked with: not yet checked. This line will name the app's version, its Claude Code version, relay's version and
the machine of the last check.

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
  can differ from the `claude` in your terminal. The app has no slash command that prints it. On macOS, the
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

Add the marketplace with the CLI; the app has no way to add one. A session that was open before the install does
not have the plugin: start a new session in the Code tab.

The app also loads the MCP servers in its own `claude_desktop_config.json`. On a name clash, its entry wins over
the one in `~/.claude.json`.

## Check that it works

In a new Code tab session in a git repository:

1. `/relay:status` prints the job table at once, with no reply from the model. The module answered it.
2. Start a job. Ask the session to launch a `relay:job` agent in the background with a short header, for example
   `backend: codex`, `model: default`, `effort: low`, and a brief that runs `sleep 60`, then reports every message
   it received while it worked.
3. Steer it. Ask the session to send the agent a message while the job runs. The job's report quotes it, and
   `/relay:result <job>` prints that report with no reply from the model.
4. A bad header fails at once. A launch whose header has a key relay does not know is refused before an agent
   starts, with the parser's message.

## Try an unreleased build in one folder

`scripts/smoke/install-local.sh` installs a build of this repository for one folder only, at local scope, so
every other session keeps the released plugin:

```bash
scripts/smoke/install-local.sh ~/path/to/folder
```

Open that folder in the Code tab and start a new session. The session loads the folder's build. Check its version
with `/relay:status`. Remove the install with `scripts/smoke/uninstall-local.sh ~/path/to/folder`.
