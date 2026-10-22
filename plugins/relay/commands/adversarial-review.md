---
description: Run a read-only review that challenges the local diff's approach and design, on Codex, Grok, ZCode or Kimi (pick one with --backend); its findings come back as schema-checked JSON
argument-hint: '[--wait|--background] [--backend codex|grok|zcode|kimi] [--model <m>] [--effort <e>] [--grok-home H] [--kimi-home H] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial review through the shared plugin runtime, on Codex, Grok, ZCode or Kimi.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the companion's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If you invoked this command yourself, rather than the user typing it, never use `AskUserQuestion`: with neither `--wait` nor `--background`, run the review in the foreground, as with `--wait`, and begin your reply with exactly this line before the output: `Ran in the foreground: the default when Claude starts a review without --wait or --background.` That line is the only text allowed before the companion's verbatim output, and nothing follows the output.
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, when the user typed the command, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
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
- Every review is read-only and recorded as a job: `/relay:status` lists it with its backend, as it lists a job.

The answer is review JSON. Codex is held to the schema by its own `outputSchema`; Grok, ZCode and Kimi get the schema in the prompt and the plugin checks the answer. An answer that is not review JSON fails the review (`<backend> returned no valid review JSON`), keeps the raw answer in the report and exits non-zero; there is no second try. A turn that fails is not an answer: the review says `The <backend> turn failed: <error>` with the backend's error and exits non-zero. Grok, ZCode and Kimi read only the inlined diff: above two files or 256 KiB the review is refused with a message that names `--base`, `--scope` and Codex. A Grok review always runs under Grok's `read-only` profile; where Grok refuses that profile (on a Mac whose `/var/run/docker.sock` is a symlink, or on Linux where it cannot reach a runtime socket such as `/run/podman/podman.sock`), the review fails with Grok's error. A Kimi review runs in Kimi's `default` mode: every permission request is rejected, and relay refuses the file writes and terminal commands Kimi sends through the client. That is not an OS sandbox: Kimi's hooks, the MCP servers and plugins it starts, and its other local operations can still have side effects.

Argument handling:
- Preserve the user's arguments exactly in the quoted heredoc below; never interpolate them into shell command arguments or a JavaScript string.
- Keep the opening delimiter quoted and the closing delimiter at column one. If its exact line occurs in the user's text, choose a new delimiter absent from that text and change both delimiter lines before running. Do not indent, escape, or otherwise rewrite the text.
- `--args-stdin` removes the one framing newline before the closing delimiter, then uses the same raw-argument parser as the single-string form.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/relay:adversarial-review` uses the same review target selection as `/relay:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/relay:review`, it can still take extra focus text after the flags.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review --args-stdin <<'RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD'
$ARGUMENTS
RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it. The one exception is the foreground line above, first, when you invoked the command yourself.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch this command with `Bash`, setting `description: "Adversarial review"` and `run_in_background: true`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review --args-stdin <<'RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD'
$ARGUMENTS
RELAY_ARGS_8F4C2B7D91E64A0BA35D6E2C9F1087AD
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "The adversarial review started in the background. Check `/relay:status` for progress."
