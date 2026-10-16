# Building a Kimi home for jobs

A job with `backend: kimi` and `kimi-home: jobs` uses `~/.kimi-code-jobs` as `KIMI_CODE_HOME`.
The plugin selects the home; you create it and sign in. An absolute or `~/` path also works.
`kimi-home: default` selects `~/.kimi-code`, with everything configured there, regardless of an
inherited `KIMI_CODE_HOME`.

Not yet checked live: the steps below follow Kimi Code 2.2.0's documentation and source, and the
plugin's tests, but no job has run in such a home yet.

## Why a home of its own

Every Kimi session loads its home's MCP servers (`mcp.json`), the MCP servers and session-start
skills of the home's plugins (`plugins/`), its hooks (`[[hooks]]` in `config.toml`), its skills
and its `AGENTS.md`. The empty MCP server list a job sends adds none, but removes none either.
Remote MCP servers cost every session their connection time and their tools' share of the
context. A home for jobs leaves them out.

Skills under `~/.agents/skills/`, `~/.agents/AGENTS.md`, and the working directory's `AGENTS.md`,
`.kimi-code/` and `.agents/` still load: they follow the real home and the project, not
`KIMI_CODE_HOME`.

## Sign in once

```bash
KIMI_CODE_HOME=~/.kimi-code-jobs ~/.kimi-code/bin/kimi login
```

The device-code flow creates the home with its own `config.toml` and credentials. Use a separate
sign-in, never a copied credentials file: Kimi locks a token refresh per home, so two homes
holding one refresh token can race and log each other out. The plugin never logs in, updates
Kimi or copies credentials. Add no `mcp.json` and install no plugins in this home.

Then check it without a model call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --backend kimi --kimi-home jobs
```

The binary is `KIMI_BINARY` when set, otherwise the first `kimi` on `PATH`, otherwise
`~/.kimi-code/bin/kimi`; the job records its resolved path. Setup prints the version, the
sign-in, the default model and effort from `config.toml`, and every model with its efforts from
`kimi provider list --json`.

## Launch a job

```text
backend: kimi
kimi-home: jobs
model: kimi-code/k3
effort: high
mode: yolo
---
<the brief>
```

`yolo` is Kimi's Never Ask mode: nothing asks for approval. `read-only` is Kimi's default mode
with every permission request rejected, and every file write and shell command refused by the
plugin. Kimi has no workspace sandbox, so `write` is refused. Every launch sets
`KIMI_CODE_NO_AUTO_UPDATE=1` and `KIMI_DISABLE_CRON=1`, and drops inherited `KIMI_MODEL_*`
variables, which would replace the header's model and effort.
