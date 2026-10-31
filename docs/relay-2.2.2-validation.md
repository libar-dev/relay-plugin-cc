# Relay 2.2.2: review and validation record

This is the public, self-contained record of the 2.2.2 release review. It covers the changes from 2.2.1,
the independent follow-up review, the defects that review found, and the live checks. All examples and
fixtures were synthetic. Session ids, job ids, local paths, credentials and private logs are deliberately
not part of this record.

Evidence is current through 31 October 2026. This document does not claim approval from the final Opus and
Astra reviews reserved for the next review sequence.

## Review provenance

The initial Opus session reported Node 22 and 24 CI green and documented fixes from Astra, CodeRabbit and
Greptile: Grok TOML key detection, the setup warning's refusal wording, the probe description, untracked-name
size accounting, non-ASCII untracked paths, and human text beside a tool result. It also left three limits on
the evidence: Codex's instructions did not consistently trigger the output pragma, Grok's MCP budget had not
been measured live, and short jobs did not show whether larger budgets improved results.

A second holistic review inspected the whole 2.2.1→2.2.2 diff and the surrounding job, transport and review
contracts. A fresh CodeRabbit run over the then-current PR head independently found the non-ASCII filename
accounting defect and labeled it minor. Partial background audit leads were not counted as completed reviews;
each included finding below was independently reproduced or checked against source.

## Follow-up findings and resolutions

| Area | Evidence before the fix | Resolution and durable regression |
| --- | --- | --- |
| Serialized review size | 3,000 empty non-ASCII files passed with 237,780 estimated bytes but produced 303,865 context bytes. Git status octal-escapes the names. | `cli/review.mjs` checks the actual serialized repository context against 256 KiB. `reviews-backends.test.mjs` includes this file set. |
| Decoded review size | One 100,000-byte invalid-UTF-8 file passed with 100,054 estimated bytes but produced 300,126 context bytes; U+FFFD expansion tripled it. | The same final byte check rejects it. The suite includes a NUL-free invalid-UTF-8 file. |
| Exact boundaries | Existing tests measured the estimator's own arithmetic, not the text sent to the backend. | Working-tree and branch tests now derive an exact 256 KiB context and refuse one additional byte. |
| Oversized-file reads | An untracked file already over the limit was read in full while constructing the lightweight context used for refusal. | `lib/review/git.mjs` gives such files a zero-byte inline allowance, so they are named without being read. A mocked read assertion proves the file is not opened. |
| Mixed transcript entries | The final fix preserved human text beside a tool result, but equivalent peer and coordinator entries were silently discarded. | `lib/harness/relay.mjs` preserves text for all three recognized origins. `relay-guard.test.mjs` covers all three and still excludes tool-result-only entries. |
| Unknown transcript origins | A non-metadata entry with an unknown origin fell through as a plain user message; before the prompt it could become the prompt. | Every unrecognized origin is reported and rejected, independent of `isMeta`, both before and after the prompt. |
| Grok TOML detection | A `[mcp]` block inside a valid multiline string was treated as configuration, suppressing Relay's default budget. | Dependency-free detection now masks comments and multiline strings, parses quoted dotted keys and examines only actual inline-table keys. Tests include basic and literal multiline strings, string lookalikes, escaped quoted keys and inline tables. |
| Close-timeout reporting | A worker could replace `did not exit after SIGKILL` with `server ended ... (exit unknown)` although the process might still run. | `lib/worker/worker.mjs` preserves the timeout error. `server-end.test.mjs` exercises the in-process worker path. |
| Documentation | The design page described only the 50 ms SIGTERM stage and coordinator/plain-user messages. Grok's MCP save was described as unconditional, and the README named 2.2.0. | The design now describes the five-second SIGTERM stage, five-second SIGKILL wait, abandonment and current message filtering. Grok's save is described as best-effort. Release metadata is aligned. |

A post-push CodeRabbit review found two remaining cases, also fixed: an unknown origin carrying both text
and a tool result now reaches origin validation and records a violation, while a tool-result-only entry stays
out; and an early-NUL binary file is rejected from its 4 KiB sample without a full `readFileSync`. Both have
regressions, including a no-full-read assertion for a 300 KiB binary file.

The original mixed-human-entry, non-ASCII file-read, pre-first-turn cancellation, symlink and SIGTERM→SIGKILL
fixes were also checked. The live peer and coordinator checks below exercise their ordinary delivery paths;
the mixed text/tool-result shapes remain synthetic edge cases, not shapes observed in those live runs.

## Automated verification before this follow-up

- PR CI passed the complete suite and type check on Node 22 and Node 24.
- A separate local run on Node 24.19.0 passed 647 tests with zero failures and zero cancellations.
- Version metadata and `git diff --check` passed.
- The 2.2.1 Codex budget suite passed 40 tests. No additional 2.2.1 correctness defect was confirmed.

## Live validation before this follow-up

All jobs used short synthetic prompts and isolated job storage. The plugin was loaded from the PR directory,
not installed globally.

| Path | Versions and settings | Result |
| --- | --- | --- |
| Direct Codex job | Codex CLI 0.166.0, `gpt-6-luna`, low effort, read-only | Completed with the exact expected token. |
| Direct Grok job | Grok Build 1.0.70, `grok-4.7`, low effort, workspace mode | Completed with the exact expected token. Setup independently reproduced the read-only profile refusal. |
| Direct ZCode job | ZCode 3.16.2-38, runtime 0.17.0, GLM-5.3-Flash, low effort, read-only | Completed with the exact expected token. |
| Direct Kimi job | Kimi Code 2.4.1, `kimi-code/kimi-for-coding` (K2.8 Preview), high effort, read-only | Completed with the exact expected token. |
| Regular Claude fan-out | Claude Code 2.1.316, two background `relay:job` agents | Both exact tokens returned and both hand-backs recorded. |
| Dynamic Workflow | Claude Code 2.1.316, computed loop with two `relay:job` calls | Both exact tokens and state blocks returned. Distinct journal keys matched the journal's `started` entries and both hand-backs were recorded. |
| Coordinator correction | A user correction forwarded with `SendMessage` | One queued coordinator entry, one continuation and the requested final token; no parser problem. |
| Peer correction | A general-purpose agent sent one message to the relay agent | One actual `origin: peer` entry, one continuation and `PEER_STEER_OK`; no parser problem. |

The assertion pass checked ten exact reports across the direct and focused scenarios, eight relay hand-backs,
two Workflow journal keys, and coordinator and peer delivery. Twelve isolated jobs, including an initial
fan-out fixture that was superseded by a non-conflicting fixture, completed with no active jobs and no relay
violations.

## Evidence that remains limited

- The live messages arrived as `queued_command` entries. Mixed text/tool-result entries and direct human-origin
  wrappers were not observed live; their coverage is synthetic.
- Grok's larger MCP budget is confirmed in its source and environment tests, but its effect on a real MCP result
  has not been measured.
- Codex's output instructions are accurate, but earlier live jobs did not consistently use the pragma on their
  first call. Short synthetic jobs do not establish that a larger budget improves answers.
- Live success on ordinary paths does not replace the adversarial regressions above or prove behavior on every
  future Claude Code transcript shape.

## Follow-up verification

The focused review, relay-guard, Grok and server-end suites pass with the new regressions. On Node 24.19.0 the
full `npm test` run passed **648 tests with zero failures and zero cancellations**. `npm run check`,
`npm run check-version` and `git diff --check` passed.

The updated code also passed live follow-up checks on Claude Code 2.1.316: direct Codex and Grok jobs returned
exact tokens; a dynamic Workflow returned both computed jobs with exact tokens, journal keys and hand-backs;
and a real peer correction was delivered exactly once and returned `POST_FIX_PEER_OK`. All five isolated jobs
completed with no active jobs and no relay violations. The caller-visible Workflow output, report files and
actual transcript origins were checked, not only the Claude sessions' final prose.
