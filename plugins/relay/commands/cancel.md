---
description: Cancel a job (default: the only active job of this repository)
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" cancel "$ARGUMENTS"`
