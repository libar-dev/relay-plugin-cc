---
description: Check every backend the relay can run (Codex, Grok, ZCode, Kimi): binary, sign-in, default model and effort, models; or toggle the stop-time review gate, fast tier, job MCP servers or the load guard
argument-hint: '[--backend codex|grok|zcode|kimi] [--grok-home H|--kimi-home H] [--enable-review-gate|--disable-review-gate] [--fast-tier allowed|off] [--job-mcp-off names|none] [--admission on|off] [--max-very-heavy 1|2|default]'
allowed-tools: Read, Write, Bash(node:*), Bash(npm:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Before any companion call, allocate a private argument file with this fixed command (it contains no user text):

```bash
node -e 'const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os"); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-args-")); console.log(path.join(dir, "args.txt"));'
```

Use `Write` with `file_path` set to the printed absolute path and `content` set to the raw slash-command arguments exactly, including empty text and trailing newlines. Do not add a framing newline. In every companion recipe, replace only `<args-file>` with that generated path. Never put argument values in Bash source, shell arguments, JavaScript source, or a heredoc; do not build other commands from them. `--args-file` reads the exact file content with the single-string argument parser. Allocate and write it once; reuse it for the initial call and the post-install rerun.

After setup finishes or stops (including an error), remove the snapshot with the removal recipe below, then remove the argument file and its private directory with the fixed cleanup command below. Missing files and directories are accepted. Cleanup refuses other path shapes and never removes a directory recursively.

```bash
node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { cleanupArgumentFile } = await import(pathToFileURL(process.argv[1]).href); cleanupArgumentFile(process.argv[2]);' "${CLAUDE_PLUGIN_ROOT}/scripts/lib/util/argument-file.mjs" "<args-file>"
```

Reject NUL-containing arguments with a usage error; do not normalize them or retry through a shell. File contents do not count toward the shell command's argument-size limit: use the same file route for long input and never fall back to embedding it in a command.

Under Claude Code's sandbox, never run a companion call again with `dangerouslyDisableSandbox` unless the user asked for that. If a call fails with `EPERM` or "operation not permitted" (macOS), or `EROFS` or "read-only file system" (Linux), the sandbox most likely kept the companion from writing, usually to the jobs home. Stop: print the error, then tell the user the two choices: Allow the effective jobs home (`$RELAY_JOBS_HOME`, default `~/.relay-jobs`) and the effective admission home (`$RELAY_ADMISSION_HOME`, default `~/.relay-jobs/admission`) in `sandbox.filesystem.allowWrite`; include both when distinct. For the defaults, use `{"sandbox": {"filesystem": {"allowWrite": ["~/.relay-jobs"]}}}` in `~/.claude/settings.json`. Changing the jobs home does not move admission state. Backend-home writes and network access may still need permissions; full end-to-end sandbox operation is not measured. Or run setup without the sandbox.

Setup uses relay's raw-argument grammar. `$VAR`, command substitutions and globs are literal. Use an absolute path or `~/` for homes and `--cwd` (`~` alone also means the home directory). Quotes group whitespace; backslash is an escape even inside quotes, so double a literal backslash. Empty quoted words are dropped: an empty value is a missing-value error. This prevents argument text from executing shell syntax or selecting paths through environment expansion.

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import { spawnSync } from "node:child_process"; const out = fs.openSync(process.argv[3], "w"); const r = spawnSync(process.execPath, [process.argv[1], "setup", "--json", "--args-file", process.argv[2]], { stdio: ["ignore", out, "inherit"] }); process.exit(r.status ?? 1);' "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" "<args-file>" "<args-file>.snapshot.json"
```

The call writes one JSON object (`schema: "relay.setup/1"`) straight to `<args-file>.snapshot.json`.
Use `Read` on that file; never retype the JSON. When it holds `error`, print its `message` and stop.
Node writes the snapshot itself, with no shell redirect; the fixed invocation is covered by `Bash(node:*)`.
The companion's exit status passes through; a signal or spawn failure returns 1.

With no `--backend`, setup checks every backend home it finds and exits 0 whatever it finds: the
Codex home (`~/.codex` or `CODEX_HOME`), `~/.grok` and every `~/.grok-<name>`, ZCode, and
`~/.kimi-code` and every `~/.kimi-code-<name>`. `--backend codex|grok|zcode|kimi` checks one,
`--grok-home H` selects a Grok home and `--kimi-home H` a Kimi home, and the command
exits non-zero when that backend is not ready. Setup makes no
model call: Codex answers `account/read`, `config/read` and `model/list` on an app-server it stops
afterwards, Grok answers `--version` and `grok models` (asked once more, a second later, before a home is
reported signed out), and for ZCode setup reads `--version`,
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
model and effort, models, ready. Under the table, give each installed backend's resolved `binary` path,
once per backend, on one short line (`binaries: codex ~/.local/bin/codex · grok ~/.local/bin/grok`): the
Desktop app starts Claude Code with an environment of its own, and the path says which binary this session
runs. Put `can` as one short line under the table only where a backend lacks something another has. `can.steer` is steering the running turn: a backend without it (Kimi) takes a
message to a running job as its next turn, so write `steer (next turn)` for it, never "no steering". Then display the settings and load guard from this same JSON snapshot. `settings.loadGuard`
holds configured admission, cap, busy seats, waiting-worker limit and the shared-domain `configPath`;
`loadGuard` holds effective state and sensors. Configured on can coexist with effective off (environment
or unsupported platform). Preserve off reasons, degraded notes, unreadable state and provider pauses.
For exact settings/sensor lines, pass the snapshot file directly to this fixed formatter recipe (no backend
probes). Remove that snapshot before the normal cleanup, including on an error or early stop:

```bash
node --input-type=module -e 'import fs from "node:fs"; import { pathToFileURL } from "node:url"; const { renderSetupPage } = await import(pathToFileURL(process.argv[1]).href); console.log(renderSetupPage(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));' "${CLAUDE_PLUGIN_ROOT}/scripts/lib/setup/page.mjs" "<args-file>.snapshot.json"
node -e 'require("node:fs").rmSync(process.argv[1], { force: true });' "<args-file>.snapshot.json"
```

Copy its `settings:`, `load guard:`, `load-guard:`, notes, paused lines, `Actions taken` and `Next steps`
verbatim. Never rerun setup just for formatting. Preserve any fenced command blocks, including their newlines. Never add rows for node or npm. The sign-in cell keeps the block's own
`signIn.state`. For `signed-out` or `not-installed`, put that state (`signed out`, `not installed`) in the cell, and print
`signIn.detail` and the command it names below the table, never in a cell: a fenced command cannot go in a table cell.
For a block with `error`, print `error: <the error>` below the table, whatever its sign-in. Then go on; only Codex gets the
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

The switches (`--enable-review-gate`, `--disable-review-gate`, `--fast-tier`, `--job-mcp-off`, `--admission`, `--max-very-heavy`)
work with the overview, which applies them first; with `--backend` they are a usage error.

`--admission on|off` changes the load guard for every session of this user; change it only when
the user asks. `--max-very-heavy 1|2|default` lowers or resets the shared quota (default 2).
The configured guard path is independent of `RELAY_JOBS_HOME`.

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
node --input-type=module -e 'import fs from "node:fs"; import { spawnSync } from "node:child_process"; const out = fs.openSync(process.argv[3], "w"); const r = spawnSync(process.execPath, [process.argv[1], "setup", "--json", "--args-file", process.argv[2]], { stdio: ["ignore", out, "inherit"] }); process.exit(r.status ?? 1);' "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" "<args-file>" "<args-file>.snapshot.json"
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not signed in, preserve the guidance to run `!codex login`.
