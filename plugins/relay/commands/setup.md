---
description: Check every backend the relay can run (Codex, Grok, ZCode, Kimi): binary, sign-in, default model and effort, models; or toggle the stop-time review gate, fast tier or job MCP servers
argument-hint: '[--backend codex|grok|zcode|kimi] [--grok-home H|--kimi-home H] [--enable-review-gate|--disable-review-gate] [--fast-tier allowed|off] [--job-mcp-off names|none]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Pass the user's arguments literally in the quoted heredoc below; never interpolate them into shell command arguments or a JavaScript string. Keep the opening delimiter quoted and the closing delimiter at column one. If its exact line occurs in the user's text, choose a new delimiter absent from that text and change both delimiter lines before running. Do not indent, escape, or otherwise rewrite the text. `--args-stdin` removes the one framing newline before the closing delimiter, then uses the same raw-argument parser as the single-string form. Use this transport on the rerun too.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json --args-stdin <<'RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD'
$ARGUMENTS
RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD
```

The output is one JSON object (`schema: "relay.setup/1"`). When it holds `error`, print its `message` and stop.

With no `--backend`, setup checks every backend home it finds and exits 0 whatever it finds: the
Codex home (`~/.codex` or `CODEX_HOME`), `~/.grok` and every `~/.grok-<name>`, ZCode, and
`~/.kimi-code` and every `~/.kimi-code-<name>`. `--backend codex|grok|zcode|kimi` checks one,
`--grok-home H` selects a Grok home and `--kimi-home H` a Kimi home, and the command
exits non-zero when that backend is not ready. Setup makes no
model call: Codex answers `account/read`, `config/read` and `model/list` on an app-server it stops
afterwards, Grok answers `--version` and `grok models`, and for ZCode setup reads `--version`,
whether the credentials file from `zcode login` is a regular file of more than two bytes (the file
is never opened) and the default model, then asks one `zcode app-server` for every model the
sign-in serves: it creates a draft session, reads its model list (what ZCode's model picker
shows) and closes the draft unsaved, with no message. A snapshot without a model list, or an
empty one, leaves the ZCode block not ready; a draft ZCode does not confirm closed is a warning
that names it. Whether the ZCode sign-in works is checked by the first turn. For Kimi, setup reads
`--version` and `kimi provider list --json` under the home (only its model fields), whether each
file-stored sign-in's credentials file is a regular file of more than two bytes (never opened),
and the default model and effort in `config.toml`; whether the Kimi sign-in works is checked by
the first turn. Every check has a time limit (10 s for a command, 20 s for an app-server).

Render one table, one row per block, in the command's order: backend, home, version, sign-in,
model and effort, models, ready. Put `can` as one short line under the table only where a backend
lacks something another has. Then the settings line, `Actions taken` if any, and `Next steps`
verbatim. Never add rows for node or npm. For a block with `error`, or `signIn.state` `signed-out`
or `not-installed`, print its `detail` and the command it names, and go on; only Codex gets the
install offer below. Print every entry of a block's `warnings`; for Grok, a warning that the binary
is a script names the real binary and `GROK_BINARY`.

`--job-mcp-off <name,name...>` stores a user-level list. A Codex job passes
`mcp_servers.<name>.enabled=false` for each name the Codex home's `config.toml` defines as
`[mcp_servers.<name>]`; it skips an undefined name with a note and never passes it. Use
`none` to clear the list. Grok, ZCode and Kimi ignore it.

`/relay:setup --enable-review-gate` turns on the stop-time review gate for this repository,
every worktree and session of it; `--disable-review-gate` turns it off. It is off by default
and runs on Codex only, in the default Codex home at its default model and effort. When the
main thread stops after a turn, one read-only Codex job reviews that turn's edits, as Claude's
last message describes them, against the working tree as it stands, and blocks the stop only
when Codex answers `BLOCK:`. It gets no diff of the turn, so it cannot tell Claude's edits from
changes that were already in the working tree. The gate skips, with a note, while a background
task, a Workflow or a job of this repository runs, while a stop-hook continuation is already
in progress, and when Codex is unavailable or the review fails. Grok, ZCode and Kimi do not run
it; use `/relay:review` on those.

The switches (`--enable-review-gate`, `--disable-review-gate`, `--fast-tier`, `--job-mcp-off`)
work with the overview, which applies them first; with `--backend` they are a usage error.

If `Next steps` says to install Codex with npm:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json --args-stdin <<'RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD'
$ARGUMENTS
RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not signed in, preserve the guidance to run `!codex login`.
