---
description: Run a read-only code review of the local git diff (working tree or branch): Codex's own reviewer on Codex, the plugin's review prompt on Grok, ZCode or Kimi; pick one with --backend
argument-hint: '[--wait|--background] [--backend codex|grok|zcode|kimi] [--model <m>] [--effort <e>] [--grok-home H] [--kimi-home H] [--base <ref>] [--scope auto|working-tree|branch]'
allowed-tools: Write, Read, Glob, Grep, Bash(node:*), AskUserQuestion
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
  - Prepare the argument file as described below, then run this fixed estimate command and read its output:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review --estimate --args-file "<args-file>"
```
  - The estimate calls `resolveReviewTarget`, just as the review does: an explicit base selects the branch; `auto` selects the working tree when dirty and the branch otherwise. Use its target label, unique file count, untracked count and shortstat; do not rebuild target selection or a Git command from the arguments.
  - Untracked files count as reviewable work. Only conclude there is nothing to review when the estimate succeeds and reports zero files for its selected target. On an estimate error, return the error and stop.
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
- Every review is read-only and recorded as a job: `/relay:status` lists it with its backend, as it lists a job.

Grok, ZCode and Kimi read only the inlined diff: above two files or 256 KiB the review is refused with a message that names `--base`, `--scope` and Codex. Return that message as it is. A Grok review always runs under Grok's `read-only` profile; where Grok refuses that profile (on a Mac whose `/var/run/docker.sock` is a symlink, or on Linux where it cannot reach a runtime socket such as `/run/podman/podman.sock`), the review fails with Grok's error. A Kimi review runs in Kimi's `default` mode: every permission request is rejected, and relay refuses the file writes and terminal commands Kimi sends through the client. That is not an OS sandbox: Kimi's hooks, the MCP servers and plugins it starts, and its other local operations can still have side effects.

Argument handling:

Before any companion call, allocate a private argument file with this fixed command (it contains no user text):

```bash
node -e 'const fs = require("node:fs"); const dir = fs.mkdtempSync("/tmp/relay-args-"); console.log(dir + "/args.txt");'
```

Use `Write` with `file_path` set to the printed absolute path and `content` set to the raw slash-command arguments exactly, including empty text and trailing newlines. Do not add a framing newline. In every companion recipe, replace only `<args-file>` with that generated path. Never put argument values in Bash source, shell arguments, JavaScript source, or a heredoc; do not build other commands from them. `--args-file` reads the exact file content with the single-string argument parser. Allocate and write it once; reuse it for the estimate and the selected review flow. Writing this temporary transport file is permitted by the review-only constraint; do not write project files.

After the final foreground call (including an error or an empty estimate), remove the file and its private directory with the fixed cleanup command below. For a background review, keep the file until its completion notification, then clean up; do not wait in the launching turn.

```bash
node -e 'const fs = require("node:fs"); const path = require("node:path"); fs.unlinkSync(process.argv[1]); fs.rmdirSync(path.dirname(process.argv[1]));' "<args-file>"
```

Reject NUL-containing arguments with a usage error; do not normalize them or retry through a shell. File contents do not count toward the shell command's argument-size limit: use the same file route for long input and never fall back to embedding it in a command.

- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/relay:review` does not support staged-only review, unstaged-only review, or extra focus text, on any backend.
- If the user needs custom review instructions or more adversarial framing, they should use `/relay:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review --args-file "<args-file>"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it. The one exception is the foreground line above, first, when you invoked the command yourself.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch this command with `Bash`, setting `description: "Review"` and `run_in_background: true`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review --args-file "<args-file>"
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "The review started in the background. Check `/relay:status` for progress."
