# Tool-output limits per harness

Every harness the relay runs shortens large tool results before its model sees them. A review that
reads a diff, a log or a whole file can then reason from part of the evidence. This page records
what each harness does, what the relay can change, and what it cannot. Relay 2.2.1 handles Codex;
the other three are the subject of 2.2.2.

## How the limits were measured

On 30 October 2026, on a macOS machine, one job per harness read the same synthetic file: 16,000
lines, 128,056 bytes (about 60k tokens), with a random marker word on the first, middle and last
line. Each job ran `cat` once through its shell tool, then read the file once with its own file-read
tool, and reported the first and last lines it received, every notice, and the marker words it saw.
The markers were not in the brief, so a job could name only the markers that reached it. Every job
named exactly the markers it received. Each model then reported its harness's settings from the
installed binary, its configuration files and docs, and official sources, marking each claim as
measured, read on disk, official, or recalled.

[`scripts/tool-output-probe.mjs`](../scripts/tool-output-probe.mjs) writes such a file. Run the
probe again after a harness upgrade: a missing middle marker shows a cut that a report alone would
not.

## What the jobs received

| Harness | Shell `cat` | File-read tool | Full output kept? |
| --- | --- | --- | --- |
| Codex CLI 0.165.0, gpt-6-astra | about 10,000 tokens: start and end, middle cut | none in code mode | no |
| Grok Build 1.0.70, grok-4.7 | 19.6 KB: start and end, middle cut | lines 1 to 1,000 | yes: a log path in the notice |
| ZCode, runtime 0.17.0, GLM-5.3 | a 2 KB preview of the start | lines 1 to 7,966 (25,000-token cap) | yes: a log path in the notice |
| Kimi Code 2.3.1, k3.1-pro | 4 KB of the start and 1 KB of the end | lines 1 to 7,755 (100,000-character cap) | yes: `output_path` in the notice |

Codex is the only harness that discards the cut text. Grok, ZCode and Kimi save the whole output
and tell the model where it is; there the risk is a model that works from the preview and never
reads the file.

## Codex

Two separate limits apply, and Relay 2.2.1 sets both (see
[Codex configuration](../README.md#codex-configuration)).

- `tool_output_token_limit` budgets each result kept in history. Its default comes from the model
  catalog: 10,000 tokens for every current model. Relay sends a per-job value as a thread `config`
  override.
- Code mode, which every current model uses (`tool_mode: code_mode_only` in the catalog), cuts each
  `exec` and `wait` result to 10,000 tokens unless the call asks for more with
  `// @exec: {"max_output_tokens": N}` or `max_tokens: N`. The default is the constant
  `DEFAULT_MAX_OUTPUT_TOKENS` in `codex-rs/core/src/unified_exec/mod.rs`; no setting changes it.
  Relay tells the model the budget and the pragma in developer instructions.

Still open: a fixed 1 MiB capture buffer per command, cut in the middle; per-MCP-tool
`mcp_servers.<id>.tools.<tool>.output_token_limit`; and whether a resumed thread takes a new budget.
Codex's token counts are approximations at four bytes per token. Compaction starts at 90% of the
context window by default.

Sources: [truncate.rs](https://github.com/openai/codex/blob/main/codex-rs/utils/string/src/truncate.rs),
[unified_exec/mod.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/unified_exec/mod.rs),
[code_mode/mod.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/code_mode/mod.rs),
[tools/context.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/context.rs),
[configuration reference](https://developers.openai.com/codex/config-reference/).

## Grok Build

| Limit | Default | Cut | How to set it |
| --- | --- | --- | --- |
| Shell preview | 20,000 bytes | middle | `[toolset.bash] output_byte_limit` in the home's `config.toml`, read at launch. No flag or environment variable. |
| MCP result | 20,000 bytes | head | `GROK_MAX_MCP_OUTPUT_BYTES` (wins over `MAX_MCP_OUTPUT_BYTES`), or `[mcp] max_output_bytes` |
| File read | 1,000 lines per call | head | per call only (`offset`, `limit`) |
| Grep | 200 lines in content mode | head | per call only (`head_limit`) |
| Web fetch | sized to the context window | head | not settable; the page is saved as an artifact |

Full shell output is kept in the session's `terminal/` log, up to 64 MB once the command ends. ACP's
`session/new` `_meta` and `session/set_config_option` carry the model and reasoning effort only. The
context window is 256,000 tokens, with a 500,000 option chosen inside the session. The catalog sets
auto-compaction at 80%, and the shipped guide says 85%.

Sources: [changelog](https://x.ai/changelog/build),
[mcp_truncate.rs](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-tools/src/util/mcp_truncate.rs),
[configuration guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md).

## ZCode

The binary inspected was the npm package `zcode-app-cli` 3.16.2-38, whose `package.json` names the
repository `github.com/kingsword09/zcode-cli`. It bundles zcode-runtime 0.17.0.

| Limit | Default | Cut | How to set it |
| --- | --- | --- | --- |
| Shell result | 30,000 bytes, then a 2,000-character preview | head | not settable |
| File read | 25,000 estimated tokens | head, with the next offset | not settable |
| MCP result | 10,000 bytes | head | not settable |
| Web tools | 100,000 bytes | head | not settable |

Every budget is a constant in the runtime bundle; no setting, `ZCODE_*` variable or flag reaches it.
Full shell output goes to a per-session log whose path the model receives. GLM-5.3 has a context of
about 1M tokens; compaction starts about 34k tokens before the end, with no setting.

Sources: [GLM-5.3](https://z.ai/blog/glm-5.3), [ZCode configuration](https://zcode.z.ai/en/docs/configuration).

## Kimi Code

| Limit | Default | Cut | How to set it |
| --- | --- | --- | --- |
| Shell, MCP, web, subagent results | 50,000 characters, then 4,096 head and 1,024 tail characters | middle | not settable |
| File read | 100,000 characters per call, at most 500,000 | head | `[read] default_max_chars` and `max_chars` in the home's `config.toml`; the process reloads the file |
| Grep, glob | 250 lines, 100 paths | head | per call only |

Full output is saved to `output_path`, kept up to 10,000,000 characters. ACP's
`session/set_config_option` sets the model, thinking level and mode only. k3.1-pro is configured for
1,048,576 tokens; compaction starts at 85% or with 50,000 tokens left.

Sources: [configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html),
[overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html),
[release notes](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html).

## What the relay can do

- **Grok MCP results:** set `GROK_MAX_MCP_OUTPUT_BYTES` in the job's environment, per job, as for
  Codex. Proposed `deep`: a quarter of the context window at four bytes per token, which is the
  window's size in tokens taken as bytes, to the nearest power of two: 262,144 bytes for 256k.
  `balanced` and `compact` are half and a quarter of that.
- **Grok's shell preview and Kimi's file reads** live only in the home's `config.toml`. The relay does
  not write a user's configuration; documenting the keys, or managing the config of a jobs-only home,
  are the two options.
- **ZCode** cannot be changed.
- **All three** save the full output. A job that is told to read the saved path in pages before it
  concludes gets the whole evidence on every harness. None of the three exposes a session field for
  instructions over its protocol, so the open question is how to give a job that instruction.

All values here are from the versions named above and change with them.
