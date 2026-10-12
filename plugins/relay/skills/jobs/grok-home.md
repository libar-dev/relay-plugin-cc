# Building a Grok home for jobs

A job with `backend: grok` and `grok-home: jobs` uses `~/.grok-jobs` as `GROK_HOME`.
The plugin selects the home; you create it and sign in. An absolute or `~/` path
also works. `grok-home: default` explicitly selects `~/.grok`, including its MCP servers
and hooks, regardless of an inherited `GROK_HOME`.

## Create the home

Create `~/.grok-jobs/`, an empty `hooks/` directory inside it, and `config.toml`:

```toml
[memory]
enabled = false

[compat.claude]
hooks = false
skills = false
mcps = false
rules = false
agents = false
sessions = false

[compat.cursor]
hooks = false
skills = false
mcps = false
rules = false
agents = false
sessions = false
```

Leave MCP server definitions out. Grok's own `AGENTS.md` and `.grok/` in the working
directory still apply. The worker also sets `GROK_MEMORY=0` and the Claude and Cursor
compatibility environment switches to `0` on every launch. Installed Claude plugins
still load in Grok 1.0.46; those switches do not disable plugins.

## Sign in once

Run:

```bash
GROK_HOME=~/.grok-jobs ~/.grok/bin/grok login
```

Use a separate sign-in, never a copied `auth.json`. Two homes holding one refresh token
can log each other out, the same race as openai/codex-plugin-cc#789. The plugin never logs in, updates
Grok, or copies credentials.

Then check the home without a model call:

```bash
GROK_BINARY="$HOME/.grok/bin/grok" node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --backend grok --grok-home jobs
```

The binary is `GROK_BINARY` when set, otherwise the first `grok` on `PATH`. Terminal apps
can put a wrapper first; the explicit path selects Grok's own binary. The job records its
resolved path. Setup prints the path, version and sign-in check from `grok models`.

## Launch a job

```text
backend: grok
grok-home: jobs
model: default
effort: high
mode: yolo
---
<the brief>
```

`yolo` approves tools and removes `GROK_SANDBOX`. `write` uses `workspace`; `read-only`
uses `read-only`. A profile Grok refuses fails the job with Grok's error; there is no
fallback. On macOS, Grok can refuse `read-only` when `/var/run/docker.sock` is a symlink.
Grok's macOS profiles do not enforce child-process network restrictions. `network` on a
sandboxed job prints a note.
