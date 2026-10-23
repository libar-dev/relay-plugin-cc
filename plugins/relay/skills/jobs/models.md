# Models and spend

Data as of 2026-10-23. Sources below were read on that date. This is a snapshot, not a routing
policy. Prices are standard API USD per million tokens; subscriptions have separate limits.
`/relay:setup` shows the ids, efforts and defaults the user's sign-ins actually serve.

## Header choices and API list prices

One shared quota allows 2 very heavy jobs: GPT-6 Astra and Kimi K3 at **any** effort. Effort alone
never enters it; other models at max/ultra are outside the pool. Unresolved default models remain
unknown until the backend resolves them. Native Claude models below are for harness comparison,
not relay job models. Relay requires no external search or scraping service.

### Codex

| Model / header id | Efforts | Very heavy | Input / cache read / output | Cache write 30m / 12h | Source |
|---|---|---|---|---|---|
| GPT-6 Astra / `gpt-6-astra` | backend model/list; low–max where served | yes, any effort | 10 / 1 / 50 | 12.50 / 25 | [vendor][openai] |
| GPT-6.1 Sol / `gpt-6.1-sol` | backend model/list; low–max where served | no | 2 / 0.10 / 10 | 2.50 / 5 | [vendor][openai] |
| GPT-6 Luna / `gpt-6-luna` | backend model/list; low–max where served | no | 0.10 / 0.01 / 0.50 | 0.125 / 0.25 | [vendor][openai] |

### Grok Build

| Model / header id | Efforts | Very heavy | Input / cache read / output | Source |
|---|---|---|---|---|
| Grok 4.7 / `grok-4.7-build` | backend-defined; default sends no override | no | 2 / 0.50 / 6 | [vendor][xai] |

These are Grok API prices, not a Grok Build subscription bill; tool and context surcharges can differ.

### ZCode

| Model / header id | Efforts | Very heavy | Input / cache read / output | Cache storage | Source |
|---|---|---|---|---|---|
| GLM-5.3 / `glm-5.3` | low, high, max; default high | no | 1.40 / 0.26 / 4.40 | limited-time free | [vendor][zai] |
| GLM-5.3-Flash / `glm-5.3-flash` | low, high, max; default high | no | 0.15 / 0.03 / 0.50 | limited-time free | [vendor][zai] |

### Kimi Code

| Model / header alias | Efforts | Very heavy | Input / cache read / output | Cache write 5m / 1h | Source |
|---|---|---|---|---|---|
| Kimi K3 / `kimi-code/k3` (K3 family) | low, high, max where served | yes, any effort | 3 / 0.30 / 15 | 3 / 6 | [vendor][kimi] |
| Kimi K2.8 Preview / `kimi-code/kimi-for-coding` | inspect setup; alias can change | no if resolved to K2.x | not verified for this preview | not verified | [availability][kimi-code] |

### Native Claude

| Model | Efforts | Very heavy in relay | Input / cache read / output | Cache write 5m / 1h | Source |
|---|---|---|---|---|---|
| Claude Opus 5.5 | native harness setting | not applicable | 4 / 0.20 / 20 | 5 / 8 | [vendor][claude] |
| Claude Sonnet 5.5 | native harness setting | not applicable | 2 / 0.10 / 10 | 2.50 / 4 | [vendor][claude] |
| Claude Fable 5.1 | native harness setting | not applicable | 10 / 0.25 / 50 | 12.50 / 20 | [vendor][claude] |
| Claude Haiku 5.5, prompt ≤100K / >100K | native harness setting | not applicable | 0.10 / 0.50 input; 0.01 / 0.05 cache; 0.50 / 2.50 output | 0.125 / 0.625 (5m); 0.20 / 1 (1h) | [vendor][claude] |

## Public benchmark snapshot

AA Intelligence Index (II) is a broad composite, not a coding-only score. The next four columns
are its agentic component evaluations: Briefcase and GDPval are Elo; Automation and Terminal-Bench
4.0 (TB4) are percentages. Costs/time are AA's weighted **whole-II task** means, including cache
reads/writes at API list prices, not the cost of an average relay job or an agentic-only task.
Claude adaptive rows use AA's default fallback; [Sonnet's pre-release build][sonnet-note] had a
structured-output bug, so those rows are provisional pending a rerun.

| Model, measured effort | II | Briefcase / GDPval | Automation / TB4 % | II $/task / minutes | Source |
|---|---|---|---|---|---|
| GPT-6 Astra (max) | 52.7 | 1568 / 1574 | 68.5 / 59.1 | 3.258 / 7.9 | [AA][gpt-6-astra] |
| GPT-6.1 Sol (high) | 50.2 | 1465 / 1509 | 64.5 / 51.5 | 0.319 / 4.5 | [AA][gpt-6-1-sol-high] |
| GPT-6.1 Sol (xhigh) | 51.0 | 1502 / 1536 | 66.6 / 54.0 | 0.393 / 5.8 | [AA][gpt-6-1-sol-xhigh] |
| GPT-6.1 Sol (max) | 51.8 | 1555 / 1596 | 64.9 / 56.1 | 0.724 / 11.6 | [AA][gpt-6-1-sol] |
| GPT-6 Luna (max) | 38.1 | 1336 / 1433 | 53.2 / 12.6 | 0.068 / 6.1 | [AA][gpt-6-luna] |
| Grok 4.7 (xhigh) | 46.4 | 1639 / 1714 | 65.6 / 25.8 | 3.738 / 14.2 | [AA][grok-4-7] |
| GLM-5.3 (max) | 44.8 | 1505 / 1649 | 62.2 / 41.9 | 2.006 / 11.7 | [AA][glm-5-3] |
| GLM-5.3-Flash | 41.8 | 1453 / 1642 | 60.4 / 32.8 | 0.284 / 13.8 | [AA][glm-5-3-flash] |
| Kimi K3 (max) | 43.6 | 1499 / 1534 | 58.3 / 12.6 | 2.000 / 19.8 | [AA][kimi-k3] |
| Claude Opus 5.5 (high with fallback) | 53.6 | 1685 / 1703 | 63.2 / 56.6 | 1.823 / 4.7 | [AA][claude-opus-5-5-high] |
| Claude Opus 5.5 (max with fallback) | 57.6 | 1801 / 1866 | 69.5 / 59.6 | 5.982 / 13.3 | [AA][claude-opus-5-5] |
| Claude Sonnet 5.5 (max with fallback) | 56.0 | 1816 / 1838 | 71.8 / 63.6 | 5.461 / 15.8 | [AA][claude-sonnet-5-5] |
| Claude Haiku 5.5 (max) | 43.4 | 1575 / 1619 | 35.4 / 32.8 | 0.213 / 7.2 | [AA][claude-haiku-5-5] |
| Claude Fable 5.1 (max with fallback) | 53.4 | 1671 / 1755 | 59.4 / 52.0 | 7.630 / 12.3 | [AA][claude-fable-5-1] |

Kimi K2.8 Preview: no public benchmark result verified in this snapshot; no score is inferred.
GLM-5.3-Flash's AA variant is labelled max; relay's ZCode default is high. Those are different settings.

AA Coding Agent Index v2.0 uses FrontierCode v1.1, TB4 and SWE-Atlas-QnA-AA in the named harness.
Its task set, efforts and durations differ from II above. GLM runs use Opencode, whereas relay uses
ZCode. Coding-harness TB4 results can also differ from model-evaluation TB4; compare like with like.

| Harness / model / effort | Coding Index | API $/task | Minutes/task | Source |
|---|---|---|---|---|
| Claude Code - Opus 5.5 (max) | 61.7 | 11.42 | 61 | [AA coding][coding] |
| Codex - GPT-6 Astra (max) | 54.7 | 7.04 | 25 | [AA coding][coding] |
| Claude Code - Sonnet 5.5 (max) | 59.3 | 13.30 | 80 | [AA coding][coding] |
| Codex - GPT-6.1 Sol (max) | 54.1 | 1.50 | 24 | [AA coding][coding] |
| Grok Build - Grok 4.7 (xhigh) | 46.6 | 9.48 | 36 | [AA coding][coding] |
| Claude Code - Haiku 5.5 (max) | 37.3 | 2.67 | 71 | [AA coding][coding] |
| Kimi Code CLI - Kimi K3 (max) | 41.4 | 5.17 | 63 | [AA coding][coding] |
| Claude Code - Fable 5.1 (max) (with fallback) | 57.6 | 11.53 | 35 | [AA coding][coding] |
| Opencode - GLM-5.3 (max) | 48.9 | 5.23 | 56 | [AA coding][coding] |
| Codex - GPT-6 Luna (max) | 31.1 | 0.16 | 21 | [AA coding][coding] |

For example, Sol high→xhigh adds 0.8 II points with task cost 0.319→0.393 and time 4.5→5.8 minutes;
xhigh→max adds 0.8 points at 0.393→0.724 and 5.8→11.6 minutes. These are readings of this snapshot,
not a preferred effort. Haiku's long-prompt tier changes the whole-request bill; token volume and
cache share matter alongside list price. Include cache writes when estimating spend. Count tasks
of comparable scope, plus review/fix rounds; calibrate estimates on a small sample of your work.

## Limits and maintenance

Subscription allowances are not API dollar budgets. Check the current [Claude limits][claude-limits],
[Codex plan limits][codex-limits], [Kimi Code limits][kimi-code], [GLM Coding Plan][zai-limits] and
[Grok plans][grok-plans] for the signed-in account; windows and model multipliers can change.
As of this snapshot, Claude seat allowances can have rolling 5-hour and weekly windows; Codex's
5-hour/weekly limits depend on plan (some Pro tiers have no 5-hour limit). GLM Coding Plan has both
5-hour and weekly credits. Kimi Code has a rolling 5-hour limit; new plans have no weekly cap,
legacy plans do, and exhausting shared monthly credits can also stop work. Grok allowances depend
on the signed-in plan; no transferable task budget is inferred here. These are usage windows, not
allowed wall time per job. The linked vendor rules are the source for each statement.
Recognized-refusal pauses and failed-job recovery are in [orchestration.md](orchestration.md).

Numbers age in weeks. Recheck original pages before fixing routing or a spending commitment. At each
minor release refresh this table (including missing results, preview status, efforts, cache TTLs and
subscription windows), or mark it stale. A source-key/date test verifies attribution structure only.
The jobs skill's explicit GLM/Kimi ids are checked locally; Codex/native Claude availability comes
from setup/the native harness rather than a complete static relay catalog.

## Sources (all read 2026-10-23)

[openai]: https://developers.openai.com/api/docs/pricing
[claude]: https://platform.claude.com/docs/en/about-claude/pricing
[xai]: https://docs.x.ai/developers/models/grok-4.7
[zai]: https://docs.z.ai/guides/overview/pricing
[kimi]: https://platform.kimi.ai/docs/pricing/chat
[coding]: https://artificialanalysis.ai/agents/coding-agents
[claude-limits]: https://code.claude.com/docs/en/costs
[codex-limits]: https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex
[kimi-code]: https://www.kimi.com/en/help/membership/membership-update-rules
[zai-limits]: https://docs.z.ai/devpack/overview
[grok-plans]: https://grok.com/plans
[gpt-6-astra]: https://artificialanalysis.ai/models/gpt-6-astra
[gpt-6-1-sol-high]: https://artificialanalysis.ai/models/gpt-6-1-sol-high
[gpt-6-1-sol-xhigh]: https://artificialanalysis.ai/models/gpt-6-1-sol-xhigh
[gpt-6-1-sol]: https://artificialanalysis.ai/models/gpt-6-1-sol
[gpt-6-luna]: https://artificialanalysis.ai/models/gpt-6-luna
[grok-4-7]: https://artificialanalysis.ai/models/grok-4-7
[glm-5-3]: https://artificialanalysis.ai/models/glm-5-3
[glm-5-3-flash]: https://artificialanalysis.ai/models/glm-5-3-flash
[kimi-k3]: https://artificialanalysis.ai/models/kimi-k3
[claude-opus-5-5-high]: https://artificialanalysis.ai/models/claude-opus-5-5-high
[claude-opus-5-5]: https://artificialanalysis.ai/models/claude-opus-5-5
[claude-sonnet-5-5]: https://artificialanalysis.ai/models/claude-sonnet-5-5
[claude-haiku-5-5]: https://artificialanalysis.ai/models/claude-haiku-5-5
[claude-fable-5-1]: https://artificialanalysis.ai/models/claude-fable-5-1
[sonnet-note]: https://artificialanalysis.ai/articles/claude-sonnet-5-5
