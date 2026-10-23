---
description: Run a read-only review that challenges the local diff's approach and design, on Codex, Grok, ZCode or Kimi (pick one with --backend); its findings come back as schema-checked JSON
argument-hint: '[--wait|--background] [--backend codex|grok|zcode|kimi] [--model <m>] [--effort <e>] [--grok-home H] [--kimi-home H] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
allowed-tools: Write, Read, Glob, Grep, Bash(node:*), AskUserQuestion
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
  - Prepare the argument file as described below, then run this fixed estimate command and read its output:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review --estimate --args-file "<args-file>"
```
  - The estimate calls `resolveReviewTarget`, just as the review does: an explicit base selects the branch; `auto` selects the working tree when dirty and the branch otherwise. Use its target label, unique file count, untracked count and shortstat; do not rebuild target selection or a Git command from the arguments.
  - Untracked files count as reviewable work. Only conclude there is nothing to review when the estimate succeeds and reports zero files for its selected target. On an estimate error, return the error and stop.
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

Before any companion call, allocate a private argument file with this fixed command (it contains no user text):

```bash
node -e 'const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os"); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-args-")); console.log(path.join(dir, "args.txt"));'
```

Use `Write` with `file_path` set to the printed absolute path and `content` set to the raw slash-command arguments exactly, including empty text and trailing newlines. Do not add a framing newline. In every companion recipe, replace only `<args-file>` with that generated path. Never put argument values in Bash source, shell arguments, JavaScript source, or a heredoc; do not build other commands from them. `--args-file` reads the exact file content with the single-string argument parser. Allocate and write it once; reuse it for the estimate and the selected review flow. Writing this temporary transport file is permitted by the review-only constraint; do not write project files.

The companion removes its generated argument file and directory immediately after reading them for a review. Estimates retain the file for the review call. After a final foreground call, an empty or failed estimate, or a stop before launch, run this cleanup. Missing files and directories are accepted. Cleanup refuses other path shapes and never removes a directory recursively. Background reviews need no later cleanup turn; do not wait in the launching turn.

```bash
node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { cleanupArgumentFile } = await import(pathToFileURL(process.argv[1]).href); cleanupArgumentFile(process.argv[2]);' "${CLAUDE_PLUGIN_ROOT}/scripts/lib/util/argument-file.mjs" "<args-file>"
```

Reject NUL-containing arguments with a usage error; do not normalize them or retry through a shell. File contents do not count toward the shell command's argument-size limit: use the same file route for long input and never fall back to embedding it in a command.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review --args-file "<args-file>"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it. The one exception is the foreground line above, first, when you invoked the command yourself.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch this command with `Bash`, setting `description: "Adversarial review"` and `run_in_background: true`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review --args-file "<args-file>"
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "The adversarial review started in the background. Check `/relay:status` for progress."
