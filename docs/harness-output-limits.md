# Tool-output limits per harness

Every harness the relay runs shortens large tool results before its model sees them. A review that
reads a diff, a log or a whole file can then reason from part of the evidence. This page records
what each harness does, what the relay can change, and what it cannot.

## How the limits were measured

On 30 October 2026, on a macOS machine, one job per harness read the same synthetic file: 16,000
lines, 128,056 bytes (about 60k tokens), with a random marker word on the first, middle and last
line. Each job ran `cat` once through its shell tool, then read the file once with its own file-read
tool, and reported the first and last lines it received, every notice, and the marker words it saw.
The markers were not in the brief, so a job could name only the markers that reached it. Every job
named exactly the markers it received. Each model then reported its harness's settings from the
installed binary, its configuration files and docs, and official sources, marking each claim as
measured, read on disk, official, or recalled.

On 31 October 2026 the shell results were measured again on a Linux machine, with the same results
for Grok, ZCode and Kimi on the same versions. A second probe gave each job a 16,000-line refund log
with one odd line in the middle, which no keyword search finds, and asked only whether anything
looked wrong. Every job found the line: Codex with its budget on and off, and Grok, ZCode and Kimi
with and without an instruction to read saved output. These were short, synthetic, single-file
tasks; a long job can still reason from a preview.

[`scripts/tool-output-probe.mjs`](../scripts/tool-output-probe.mjs) writes the marker file. Run the
probe again after a harness upgrade: a missing middle marker shows a cut that a report alone would
not.

## What the jobs received

| Harness | Shell `cat` | File-read tool | Full output kept? |
| --- | --- | --- | --- |
| Codex CLI 0.165.0, gpt-6-astra | about 10,000 tokens: start and end, middle cut | none in code mode | no |
| Grok Build 1.0.70, grok-4.7 | 19.6 KB: start and end, middle cut | lines 1 to 1,000 | yes: a log path in the notice |
| ZCode, runtime 0.17.0, GLM-5.3 | a 2 KB preview of the start | lines 1 to 7,966 (25,000-token cap) | yes: a log path in the notice |
| Kimi Code 2.3.1, k3.1-pro | 4 KB of the start and 1 KB of the end | lines 1 to 7,755 (100,000-character cap) | yes: `output_path` in the notice |

Codex discards the cut text of a shell result. Grok, ZCode and Kimi save the whole shell output and
tell the model where it is; there the risk is a model that works from the preview and never reads
the file. That is not true of every tool: ZCode's MCP results and web search are cut with no saved
copy, and no instruction recovers them.

## Codex

Two separate limits apply, and the relay handles both (see
[Codex configuration](../README.md#codex-configuration)). Measured on Codex CLI 0.166.0.

- `tool_output_token_limit` budgets each result kept in history. Its default comes from the model
  catalog: 10,000 tokens for every current model. Relay sends a per-job value as a thread `config`
  override.
- Code mode, which every current model uses (`tool_mode: code_mode_only` in the catalog), cuts each
  `exec` and `wait` result to 10,000 tokens unless the call asks for more with
  `// @exec: {"max_output_tokens": N}` or `max_tokens: N`. The default is the constant
  `DEFAULT_MAX_OUTPUT_TOKENS_PER_EXEC_CALL` in `codex-rs/code-mode-protocol/src/runtime.rs`; no
  setting changes it. `max_output_tokens` on a nested `exec_command` alone does not change it: a job
  that set only that received 10,000 tokens. The relay tells the model the budget and both forms in
  developer instructions, but nothing enforces them. In the refund-log probe, jobs given only that
  instruction still began with a plain `cat`, saw the truncation notice and searched the file. The
  same text in the brief made them use the pragma every time, at a cost of about 132,000 tokens for
  the one read.

Also known, and not changed by the relay: unified exec keeps at most 1 MiB per command, half from the
start and half from the end, as a constant. `mcp_servers.<id>.tools.<tool>.output_token_limit` replaces
the budget for that tool, and a plugin's own limit can only be tightened. A native review runs in its
own conversation with a copy of the thread's configuration, so it inherits the budget and
instructions (read in the source). A cold `thread/resume` applies new `config` and
`developerInstructions`; a thread already loaded and running ignores them. The bundled computer-use
plugin's `cua_repl` is not an `mcp_servers` entry, so `job-mcp-off` cannot turn it off, and three
per-process overrides tried on 0.166.0 (the plugin's `enabled`, its server's `enabled`, and
`features.computer_use`) left it listed with its tools. Codex's token counts are approximations at four bytes per token. Compaction starts at 90% of the
context window by default.

Sources: [truncate.rs](https://github.com/openai/codex/blob/main/codex-rs/utils/string/src/truncate.rs),
[code-mode runtime](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/code-mode-protocol/src/runtime.rs),
[unified_exec/mod.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/unified_exec/mod.rs),
[review task](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/tasks/review.rs),
[thread resume](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_processor.rs),
[configuration reference](https://developers.openai.com/codex/config-reference/).

## Grok Build

| Limit | Default | Cut | How to set it |
| --- | --- | --- | --- |
| Shell preview | 20,000 characters | middle | `[toolset.bash] output_byte_limit` in the home's `config.toml`, read at launch. The name says bytes; the count is of characters. No flag or environment variable, and `GROK_CONFIG` refuses the key. |
| MCP result | 20,000 bytes | head; the full output is saved and the notice names the file | `GROK_MAX_MCP_OUTPUT_BYTES` (wins over `MAX_MCP_OUTPUT_BYTES`), or `[mcp] max_output_bytes` |
| File read | 1,000 lines and 25,000 estimated tokens per call | head; a range over the token cap is an error | per call only (`offset`, `limit`) |
| Grep | 200 lines in content mode | head | per call only (`head_limit`) |
| Web fetch | 3% of the estimated context | head | runtime parameters only; the relay does not set them. The page is saved as an artifact |

Full shell output is kept in the session's `terminal/` log, up to 64 MiB once the command ends. ACP's
`session/new` `_meta` documents `rules`, which appends to the system prompt when the session is
created, as well as `systemPromptOverride` and `agentProfile`; the relay uses none of them. The context
window is 256,000 tokens, and `session/set_model` with `_meta: {"contextWindow": 500000}` selects the
larger one. Auto-compaction is 80% in the catalog of current models, and 85% is the fallback.

On Linux, Grok refuses its `read-only` profile when it cannot resolve a runtime socket it denies, such
as `/run/podman/podman.sock` under a root-only `/run/podman`. `grok models` under that profile fails
the same way, with no model call, so setup can report it.

Sources: [changelog](https://x.ai/changelog/build),
[mcp_truncate.rs](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-tools/src/util/mcp_truncate.rs),
[read_file](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file/mod.rs),
[configuration guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md).

## ZCode

The binary inspected was the npm package `zcode-app-cli` 3.16.2-38, whose `package.json` names the
repository `github.com/kingsword09/zcode-cli`. It bundles zcode-runtime 0.17.0. The bundle of 3.17.1-42
(runtime 0.17.1) declares the same budgets and changes how a large file read selects its text; it was
read, not run.

| Limit | Default | Cut | How to set it |
| --- | --- | --- | --- |
| Shell result | 30,000 bytes, then a 2,000-character preview | head; the full output is saved | not settable: `BASH_MAX_OUTPUT_LENGTH` (default 30,000, at most 150,000) changes what is captured, not this budget |
| File read | 25,000 estimated tokens | head, with the next offset | not settable |
| MCP result | 50,000 bytes for the model, 100,000 inline | head; **no copy is saved** | not settable |
| Web fetch | 100,000 bytes | head; the page is saved | not settable |
| Web search | 10,000 bytes | head; **no copy is saved** | not settable |
| Glob, Grep, JavaScript REPL | 100,000, 20,000 and 65,536 bytes | saved | not settable |
| Task output | 32,000 characters | head | `TASK_MAX_OUTPUT_LENGTH`, at most 160,000 |

Full shell output goes to a per-session log whose path the model receives. GLM-5.3 has a context of
about 1M tokens; compaction starts about 34k tokens before the end, with no setting.

Sources: [GLM-5.3](https://z.ai/blog/glm-5.3), [ZCode configuration](https://zcode.z.ai/en/docs/configuration).

## Kimi Code

| Limit | Default | Cut | How to set it |
| --- | --- | --- | --- |
| Shell, MCP, web, subagent results | 50,000 characters, then 4,096 head and 1,024 tail characters; a result of long lines that fits after shaping is kept with a file pointer | middle | not settable |
| File read | 100,000 characters per call, at most 500,000 | head | `[read] default_max_chars` and `max_chars` in the home's `config.toml`; the process reloads the file |
| Grep, glob | 250 lines, 100 paths | head | per call only |

Output is saved to `output_path`: the first 10,000,000 characters, or nothing if the write fails, in
which case the notice says so. The relay's own limit on a `read-only` job's file reads is 8 MiB, so a
larger saved output cannot be read there in one piece. ACP's `session/set_config_option` sets the model,
thinking level and mode only. Measured on 2.3.1; 2.4.0 has been released, and its docs describe a lower
read cap. k3.1-pro is configured for
1,048,576 tokens; compaction starts at 85% or with 50,000 tokens left.

Sources: [configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html),
[overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html),
[release notes](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html).

## What the relay does

- **Codex:** every job gets a budget, and developer instructions name the budget, the pragma and line
  ranges.
- **Grok MCP results:** a job's environment sets `GROK_MAX_MCP_OUTPUT_BYTES` to 262,144, a quarter of the
  256k window at four bytes per token, unless the environment or the home's `[mcp] max_output_bytes`
  names a value. The variable is read from Grok's source; a live check could not reach an MCP server
  from a job, so its effect has not been measured.
- **Reviews on Grok, ZCode and Kimi:** the diff goes inline in the prompt, up to 256 KiB, so these limits
  do not cut it; above that the review is refused. Later file reads are limited as above.
- **Setup:** warns when Grok refuses its `read-only` profile.

The relay does not change Grok's shell preview or Kimi's file reads, which live only in a home's
`config.toml`, because it does not write a user's configuration; set them there, or in a home kept for
jobs. Nor does it give Grok, ZCode or Kimi jobs a standing instruction: each harness's notice already
names the saved file, and the probes found no case where an instruction changed the result.

All values here are from the versions named above and change with them.
