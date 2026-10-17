---
description: Run a read-only code review of the local git diff (working tree or branch): Codex's own reviewer on Codex, the plugin's review prompt on Grok, ZCode or Kimi; pick one with --backend
argument-hint: '[--wait|--background] [--backend codex|grok|zcode|kimi] [--model <m>] [--effort <e>] [--grok-home H] [--kimi-home H] [--base <ref>] [--scope auto|working-tree|branch]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a code review. On Codex it is Codex's own reviewer; on Grok, ZCode and Kimi it is the plugin's review prompt on a fresh read-only session, with the diff inlined in the prompt.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the companion's output verbatim to the user.

Execution mode rules:
- If you invoked this command yourself, rather than the user typing it, never use `AskUserQuestion`: with neither `--wait` nor `--background`, run the review in the foreground, as with `--wait`, and begin your reply with exactly this line before the output: `Ran in the foreground: the default when Claude starts a review without --wait or --background.` That line is the only text allowed before the companion's verbatim output, and nothing follows the output.
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, when the user typed the command, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Backend selection (the flags mirror a job header's keys):
- `--backend codex|grok|zcode|kimi` picks the backend; without it, Codex. Nothing stores a default.
- `--model <model>` and `--effort <effort>` are passed as given. Without `--model` and `--effort`, Codex, Grok and Kimi use their configured defaults, and ZCode uses its selected default model at effort `high`, the plugin's default (ZCode's own is `max`), as a job header does.
- A Codex review runs in the Codex home (`~/.codex`, or `CODEX_HOME`); `--grok-home <name|path>` runs a Grok review in that Grok home, and `--kimi-home <name|path>` a Kimi review in that Kimi home.
- A combination a job would refuse (`--grok-home` without Grok, `--kimi-home` without Kimi) is refused the same way, before anything runs.
- On Codex, `--effort` is ignored with a `note:` line: Codex's own reviewer takes no effort.
- Every review is read-only and recorded as a job: `/relay:status` lists it, with `backend:` on Grok, ZCode and Kimi as for a job.

Grok, ZCode and Kimi read only the inlined diff: above two files or 256 KiB the review is refused with a message that names `--base`, `--scope` and Codex. Return that message as it is. A Grok review always runs under Grok's `read-only` profile; where Grok refuses that profile (on a Mac whose `/var/run/docker.sock` is a symlink, or on Linux where it cannot reach a runtime socket such as `/run/podman/podman.sock`), the review fails with Grok's error. A Kimi review runs in Kimi's `default` mode: every permission request is rejected, and relay refuses the file writes and terminal commands Kimi sends through the client. That is not an OS sandbox: Kimi's hooks, the MCP servers and plugins it starts, and its other local operations can still have side effects.

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/relay:review` does not support staged-only review, unstaged-only review, or extra focus text, on any backend.
- If the user needs custom review instructions or more adversarial framing, they should use `/relay:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it. The one exception is the foreground line above, first, when you invoked the command yourself.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review "$ARGUMENTS"`,
  description: "Review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "The review started in the background. Check `/relay:status` for progress."
