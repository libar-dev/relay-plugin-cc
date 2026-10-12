---
description: Show the state block and report of a job (default: the newest finished job of this repository)
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- The state block: state, job, session, model, effort, duration, attempts, report path, and any error
- The report after the `---` line, exactly as the backend wrote it
- File paths and line numbers exactly as reported
