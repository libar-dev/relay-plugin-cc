---
description: List the relay jobs of this repository (or of every repository with --all), or show one job's state block
argument-hint: '[job-id] [--all]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Keep the `jobs-home:`, `repo:`, `review-gate:`, `fast-tier:` and `jobs:` lines as printed, and the `No jobs` line when there is one.
- Render the job lines as one Markdown table: job id, state, kind, model/effort, duration, summary, relay. Relay holds the `workflow:` or `relay:` part with `adopted:N`, `automatic-resumes: N` and `not handed back` (a relay job that ended and whose result no relay handed back to its caller). A cell is empty when the line has none.
- Add no other prose.
- Without `--all`, the list holds this repository's newest 20 jobs; `--all` lists the jobs of every repository.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
