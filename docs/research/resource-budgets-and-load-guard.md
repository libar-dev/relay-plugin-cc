# Relay resource budgets and minimum load guard

## Consolidated research and implementation brief

**23 October 2026 · Codex, Grok, ZCode, Kimi and Claude · macOS, Linux and Windows**

This is the consolidated report for Relay’s minimum non-killing load guard. It includes the original 17 hosted model selections, the four additional Claude models, the supplied design and Claude Guide follow-up, cross-platform measurement guidance, and a small future-work plan. Numbers described as allowances or thresholds are proposed policy, not measured model memory requirements.

### Contents

1. [Decision and scope](#1-decision-and-scope)
2. [What actually consumes resources locally](#2-what-actually-consumes-resources-locally)
3. [Quantitative evidence and its practical limits](#3-quantitative-evidence-and-its-practical-limits)
4. [Five resource classes to use now](#4-five-resource-classes-to-use-now)
5. [All 21 requested model selections and their efforts](#5-all-21-requested-model-selections-and-their-efforts)
6. [What Claude already manages—and where that protection stops](#6-what-claude-already-managesand-where-that-protection-stops)
7. [Two queues, one composite Relay job](#7-two-queues-one-composite-relay-job)
8. [CPU and machine performance characteristics](#8-cpu-and-machine-performance-characteristics)
9. [Portable live RAM readings and execution scope](#9-portable-live-ram-readings-and-execution-scope)
10. [Claude Mods integration in Terminal, Desktop and SDK sessions](#10-claude-mods-integration-in-terminal-desktop-and-sdk-sessions)
11. [Review of the supplied load-guard draft](#11-review-of-the-supplied-load-guard-draft)
12. [A small, coherent admission policy](#12-a-small-coherent-admission-policy)
13. [Fair backend access, provider pauses and immediate test protection](#13-fair-backend-access-provider-pauses-and-immediate-test-protection)
14. [Small calibration plan and staged future work](#14-small-calibration-plan-and-staged-future-work)
15. [Reconciliation of the Claude Guide investigation and remaining questions](#15-reconciliation-of-the-claude-guide-investigation-and-remaining-questions)

## 1. Decision and scope

**Use available RAM and memory pressure as the primary admission signals. Give unknown coding jobs a provisional 2 GiB allowance, known heavy jobs 4 GiB, and use one shared admission ledger, a two-second start stagger, a low active-job ceiling, and fair selection among waiting backends. All numerical policy defaults in this report are tunable starting points, not measured safe capacities.**

The model name and ordinary reasoning effort are weak predictors of local resource use for these hosted services. The first release should use an effort multiplier of **1.0** across every supported level. A model doing more remote reasoning does not load a larger model onto the execution machine. The useful classes describe the local harness and its tools. [^s9][^s47]

For the four additional Claude models, use **M / 1 GiB as the provisional floor for a fresh, independent Claude Code or SDK process**. Use **L / 2 GiB for its ordinary coding workload**, rising with its tools. A native Claude subagent shares its parent process: do not charge another independent-harness floor for every subagent or Haiku Relay wrapper. Its incremental cost is unmeasured and is not zero. [^s47][^s48]

The reported Fedora incident involved only four or five Relay jobs alongside test suites, Claude sessions and T3 delegates, followed by roughly ten threads being steered together. This points to synchronized starts and local tool bursts as the first problems to address. A start guard reduces those risks; tests that begin later and already-running processes can still exhaust memory. Serializing full test suites is therefore part of the useful minimum.

This report consolidates the initial resource research, the supplied load-guard design excerpt, the follow-up Claude Code Guide investigation, and current primary documentation. It is self-contained; the earlier PDF and pasted transcript are not required to understand the recommendations. No measurements were taken on the user’s computers, and no repository changes were made.

### Version and evidence boundaries

Research date: **23 October 2026**. Repository findings are pinned to **136b4574e25305c61b7dc047e324a4a52cba4870 / 3.0.0-dev.13**, the design’s baseline, with PRs #6 and #32 as context. The supplied setup reports Codex **0.163.0**, Grok **1.0.67**, ZCode **3.16.2-38 / runtime 0.17.0**, and Kimi **2.2.0**. The follow-up investigation identifies Claude Code **2.1.309**. Older measurements below retain their tested versions. The supplied design stops at §1.6; later provisions are not assumed absent. [^s34][^s39][^s41][^s42]

| Evidence label | What it means here |
| --- | --- |
| Documented | Current vendor or OS documentation; still subject to installed version, provider, account and policy. |
| Measured | A disclosed, controlled experiment on its stated workload and machine; not a production capacity guarantee. |
| Reported | An original issue or repository experiment; useful failure evidence, not a population average. |
| Proposed | An engineering choice made in this report, including all resource classes and scheduling thresholds. |
| Unresolved | Requires a small test on the actual Terminal/Desktop/SDK build; no unsupported precision is supplied. |

**Cross-platform answer:** no matched macOS–Linux–Windows dataset was found for these exact versions, modes and model/effort combinations. Use a common coarse budget policy initially, backed by OS-specific live sensors. Do not label that policy an observed three-OS average.

## 2. What actually consumes resources locally

The listed hosted models perform inference on provider infrastructure. The execution machine retains the harness, request/transcript state and tools, rather than loading those models' weights or their server-side KV cache. Reasoning effort changes remote work and often elapsed time or returned data. It does not imply a proportional increase in laptop CPU or RAM. OpenAI's reasoning documentation explicitly separates internal reasoning tokens from visible output. [^s9]

Local cost can still change indirectly. Longer jobs occupy a seat longer; retained history, tool results, images and serialization buffers can grow; faster model responses can trigger local tools more frequently. If a client mode actually spawns extra local agents, those agents are additional workload. OpenAI's user-facing Ultra mode is documented as using subagents, which is different from assuming that a single API effort label has a RAM multiplier. [^s46]

At the inspected Relay baseline, each job has a detached Node worker and its own backend process. The launch modes are `codex app-server`, `grok agent --no-leader --always-approve stdio`, `kimi acp`, and `zcode app-server`. Headless measurements do not automatically describe a standalone TUI or desktop app. Claude’s parent session, T3, renderers, other delegates, MCP servers and tool children compete for the same memory. [^s34][^s35][^s37][^s38]

| Execution shape | Accounting implication |
| --- | --- |
| One native Claude subagent or workflow agent | Incremental work inside the existing Claude host; contexts, output and tools still grow. Do not repeat an independent process allowance. [^s48][^s55] |
| A new Claude Code process, SDK query, or background session | A separate process tree. Apply the independent-harness floor and the appropriate whole-job allowance. [^s47][^s48] |
| A native Haiku wrapper waiting for an external Relay job | One composite external job for Relay execution accounting; the wrapper is a coordinator, not another external backend seat. |
| One Relay job that launches tests, a browser or nested agents | The descendant workload can dominate the harness; the seat count alone does not cap its memory. |

| Metric | Useful for | Main limitation |
| --- | --- | --- |
| Host available RAM and pressure | Immediate admission decisions | Must describe the actual executor and respect container/cgroup limits |
| Whole process-tree footprint | Calibrating the cost of a job | RSS can double-count shared pages; descendants can outlive the parent |
| CPU time over a task | Comparing overhead on matched runs | Different hardware and tasks are not directly comparable |
| Whole-machine CPU utilization | A sustained busy veto | Does not diagnose every disk, swap or single-thread bottleneck |
| Model name and effort | Telemetry and later correlation | No verified conversion into local bytes or cores |

A true mean across macOS, Linux and Windows requires matched workloads, versions, modes and metric definitions. That dataset was not found. Use the same broad budgeting policy across operating systems initially, but keep OS-specific measurements separate. Do not average macOS footprint, Linux RSS/PSS and Windows private commit as if they were the same quantity.

## 3. Quantitative evidence and its practical limits

The strongest shared experiment uses a local scripted model mock, 100 small tool rounds, roughly 4 KB per response, three serial runs and process-tree sampling. Most relevant runs are macOS Apple Silicon; Grok and Kimi use separate batches. CPU uses 100% for one core. These are older headless harness measurements, not production job budgets or a cross-OS comparison. [^s1]

| Harness and tested version | Mean RSS | Peak RSS | Mean / peak CPU |
| --- | --- | --- | --- |
| Codex 0.155.1 | 123.4 MB | 163.7 MB | 10.5% / 26.0% |
| Grok 1.0.41 | 96.7 MB | 102.6 MB | 26.9% / 63.8% |
| Kimi 2.0.0 | 491.9 MB | 603.6 MB | 63.5% / 176.8% |
| Claude Code 2.1.277 | 310.9 MB | 351.0 MB | 71.8% / 122.4% |

The benchmark author also develops a competing harness. The disclosed workload and raw method are useful evidence; the ranking and blended CPU-memory score are not a capacity standard. Real cloud waiting changes the CPU average, and substantial compilers, tests or browsers change the footprint. [^s1]

For Claude, current SDK hosting guidance gives **1 GiB RAM, one CPU and 5 GiB disk per fresh independent instance** as a starting point, explicitly a floor rather than a ceiling. Each SDK `query()` starts a separate `claude` subprocess; sizing should use representative peak session RSS. The one-CPU figure is provisioning guidance, not a measurement of continuous CPU use. It is not a per-native-subagent allocation. [^s47]

Kimi's merged performance PR #3975, 22 September 2026, compares release 2.0.2 with an optimized local build on the same machine. Its 100-round peak RSS fell from 549-607 MB to 367-465 MB; CPU consumption fell from 2.59-2.78 to 1.95-2.22 core-seconds. This supports a hundreds-of-MB baseline, while showing why 603.6 MB should not be advertised as the exact cost of Kimi 2.2.0. [^s2]

| Original report | Observed values | Interpretation |
| --- | --- | --- |
| ZCode Linux, 3.14.4 / runtime 0.16.9; 7 Oct | 40 headless resumes: 364 to 476 MB peak. One tool-heavy turn: 240 MB to 1,053 MiB. | History and output volume can overwhelm a clean baseline. A production 11.5 GB, 77-process cgroup was killed by systemd-oomd. [^s3] |
| ZCode Windows, 3.16.2; 21 Oct | About 200 MB for an idle agent; 1-2 GB including MCP/plugin children. | Original user report, not a controlled average; useful Windows baseline context. [^s4] |
| Codex Linux app-server 0.128.0; 29 May | Reduced MCP repro: about 203 MiB to 3.7 GiB after three subagents. | Reported helper multiplication. It does not prove the same bug persists in 0.163.0. [^s6] |
| Codex Windows CLI 0.162.1; October | Private bytes 6.74 to 7.23 GB; working set about 5 GB; low CPU. | Abnormal growth can be memory-bound with low CPU. Reported, not a normal envelope. [^s7] |

A current ZCode 3.16.2 macOS report used GLM-5.3-Flash and 43-45 plugins, and reported repeated utility-host heap OOMs. This is a heavily extended desktop case, not a clean Relay job. Its narrow relevance is that Flash is not evidence of a small local footprint. [^s5]

A 21 October Codex macOS report similarly distinguishes an abnormal roughly 11 GB backend footprint from a replacement backend around 300-550 MB. Bug reports describe failure modes and bounds worth defending against; averaging their outliers into normal memory estimates would be misleading. [^s8]

## 4. Five resource classes to use now

Use five simple whole-job allowance classes. Values are GiB (2^30 bytes), and include the harness when used as a whole-job allowance. They are deliberately coarse, provisional reservations, not memory limits. Preserve raw measured units such as MB or MiB in evidence tables instead of silently converting them.

| Class | Allowance | Appropriate initial use |
| --- | --- | --- |
| S - Small | 0.5 GiB | Harness-only floor for a clean Codex or Grok process; not the default for unrestricted coding |
| M - Medium | 1 GiB | Harness floor for Kimi, ZCode or an independent Claude instance; small controlled tasks may use this allowance |
| L - Large | 2 GiB | Default for unclassified coding work and ordinary local tool use |
| XL - Extra large | 4 GiB | Known test/build/browser or substantial MCP workload |
| XXL - Very large | 8 GiB or explicit override | Known large builds, nested workloads or measured heavy jobs; 8 GiB is not a universal upper bound |

Select the reservation as max(harness baseline, chosen whole-job allowance). Do not add the baseline again when the allowance already includes it. A review command is only eligible for the smaller class when its actual tools and history are controlled; read-only filesystem permissions alone do not make a job cheap.

| Backend | Provisional harness floor | Default ordinary job | Confidence |
| --- | --- | --- | --- |
| Codex | S: 0.5 GiB | L: 2 GiB | Controlled older-version benchmark; exact Relay mode/version unmeasured |
| Grok | S: 0.5 GiB | L: 2 GiB | Controlled older-version benchmark; exact Relay mode/version unmeasured |
| Kimi | M: 1 GiB | L: 2 GiB | Controlled benchmark and upstream performance PR; current 2.2.0 unmeasured |
| ZCode | M: 1 GiB | L: 2 GiB; raise for large history | Original reports rather than a matched benchmark; least certain floor |
| Claude Code / SDK, independent instance | M: 1 GiB | L: 2 GiB | Official provisioning floor plus older benchmark; native subagent increment unmeasured |

The small floor differences help avoid wasting capacity on genuinely small jobs. They should not drive the active-job ceiling. If the implementation must stay simpler still, assign all unknown jobs 2 GiB and keep backend floors only as future metadata. Keep the draft's 1/2/3 scheduling weights if changing them is disruptive, but store byte allowances separately; the weight numbers are not measured memory ratios.

**Native Claude agents are a separate accounting case, not a sixth size class.** For Fable, Opus, Sonnet and Haiku inside an existing Claude process, retain the model label in telemetry and budget their actual shared host and tool activity. Do not call every Haiku wrapper “S / 0.5 GiB”: no controlled marginal measurement supports that number. Existing memory is already reflected in the host reading; future growth is addressed by the composite job allowance, finite pending work and later calibration.

## 5. All 21 requested model selections and their efforts

The class in this table is a **provisional floor for a fresh independent harness**, identical across its supported ordinary efforts. It is not measured per-model RAM. Ordinary unrestricted coding defaults to L / 2 GiB. The installed backend’s model catalog remains authoritative; API support does not guarantee that every signed-in product exposes every level. Claude’s native subagents use the shared-process accounting described above. [^s10][^s18][^s19][^s20][^s49]

| Model selection | Documented named effort coverage | Independent harness floor |
| --- | --- | --- |
| gpt-6.1-sol | low, medium, high, xhigh, max [^s11] | S / 0.5 GiB |
| gpt-6-astra | low, medium, high, xhigh, max [^s12] | S / 0.5 GiB |
| gpt-6-sol | none, low, medium, high, xhigh, max [^s13] | S / 0.5 GiB |
| gpt-6-luna | none, low, medium, high, xhigh, max [^s14] | S / 0.5 GiB |
| gpt-5.6-sol | none, low, medium, high, xhigh, max [^s15] | S / 0.5 GiB |
| gpt-5.6-terra | none, low, medium, high, xhigh, max [^s16] | S / 0.5 GiB |
| gpt-5.6-luna | none, low, medium, high, xhigh, max [^s17] | S / 0.5 GiB |
| grok-4.7 | API: low, medium, high, xhigh [^s18] | S / 0.5 GiB |
| grok-4.7-build-fast | Resolve Grok Build catalog; complete public list not verified | S / 0.5 GiB |
| grok-4.6 | API: low, medium, high, xhigh [^s18] | S / 0.5 GiB |
| grok-4.5 | API: low, medium, high; xhigh maps to high [^s18] | S / 0.5 GiB |
| GLM-5.3 | low, high, max; ZCode default max [^s19] | M / 1 GiB |
| GLM-5.3-Flash | Use installed catalog; separate complete list not verified | M / 1 GiB |
| kimi-for-coding | Managed entry does not declare discrete effort levels [^s20] | M / 1 GiB |
| kimi-for-coding-highspeed | Managed entry does not declare discrete effort levels [^s20] | M / 1 GiB |
| k3 | low, high, max; resolve effective default [^s20] | M / 1 GiB |
| k3-256k | K3-family low, high, max; confirm installed entry [^s19][^s20] | M / 1 GiB |
| Claude Fable 5.1 / `claude-fable-5-1` | low, medium, high, xhigh, max [^s51] | M / 1 GiB |
| Claude Opus 5.5 / `claude-opus-5-5` | low, medium, high, xhigh, max [^s52] | M / 1 GiB |
| Claude Sonnet 5.5 / `claude-sonnet-5-5` | low, medium, high, xhigh, max [^s53] | M / 1 GiB |
| Claude Haiku 5.5 / `claude-haiku-5-5` | low, medium, high, xhigh, max [^s54] | M / 1 GiB |

For Codex, model/list returns supportedReasoningEfforts and defaultReasoningEffort; availability depends on client and account. Do not turn the API list into a hardcoded CLI validation list. For Kimi, generic accepted configuration strings do not mean each model supports them; its model entries carry support_efforts and default_effort. ZCode's native default max differs from Relay's high default shown in the user's setup. [^s10][^s19][^s20]

A 256k or 1M context window is a service capability, not a local model-memory allocation. Actual transcript bytes, returned reasoning, image payloads and retained copies are the local variables to measure. Keep backend version, model, effective effort and context/history size in future telemetry, while using a 1.0 effort multiplier for the first guard.

### Claude defaults: Code and direct API are not identical

| Model | Claude Code default | API default | Local allowance multiplier at every named effort |
| --- | --- | --- | --- |
| Fable 5.1 | high | high | 1.0 |
| Opus 5.5 | medium | medium | 1.0 |
| Sonnet 5.5 | medium | high | 1.0 |
| Haiku 5.5 | medium | medium | 1.0 |

These defaults apply when no effective user, organization or launch setting overrides them. In particular, Sonnet 5.5’s Code default differs from its API default. Resolve the full model ID: aliases on other providers can still select older models. [^s49][^s50]

**Ultracode changes orchestration.** It is a Claude Code workflow setting, not a sixth ordinary model effort. Its extra agents and tools are additional workload even though the selected model keeps the same floor. Similarly, Codex’s documented Ultra workflow uses subagents. Treat actual fan-out as workload; do not infer local bytes from an effort label. [^s49][^s46]

The four Claude models’ 1M context capacity is a remote service limit, not a 1M-token local model allocation. Large transcripts, images and retained copies still increase client memory. The relevant local quantity is the material actually retained, not the maximum window printed on the model page. [^s51][^s52][^s53][^s54]

## 6. What Claude already manages—and where that protection stops

The follow-up investigation correctly identifies useful native scheduling. It does not establish a shared machine budget across independent Claude sessions, Relay backends and T3 delegates. The minimum Relay feature should focus on external execution while observing native Claude activity.

| Mechanism | Verified behavior | Implication for Relay |
| --- | --- | --- |
| Agent-tool subagents | Default 20 running per session. A further Agent spawn fails. `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` accepts a positive integer, from 2.1.217. Ultracode is exempt; completed-agent resumes and `/subtask` forks can exceed the check. Workflow agents and teammates have separate limits. [^s56] | This is not a machine-wide hard cap or a general queue. |
| Dynamic workflows | `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` sets 1–256 concurrent agents per workflow run. Default up to 16, reduced with fewer available CPUs. Excess `agent()` calls wait. Running transcripts remain in Claude memory. Available from 2.1.269. [^s55] | Useful native queueing; no published exact CPU formula or cross-session memory allocation. |
| Workflow API usage pauses | Eligible interactive claude.ai sessions can wait when auto-continue is enabled, the reset is within 24 hours, and fewer than two waits have occurred. SDK/-p, background, Remote Control and teammate sessions do not receive this pause. [^s57] | This does not manage Grok, Kimi, ZCode or OpenAI quota refusals. |
| Idle background-shell reaping | macOS/Linux cleanup requires critical memory pressure and a session idle for 30 minutes with no active thread/subagent; the pressure-reap setting can disable it. [^s55] | It does not protect an active synchronized fan-out. |
| Low-free-memory warning | `CLAUDE_CODE_WARN_MEMORY_FREE_GIB` is a Linux/WSL advisory reminder, available from 2.1.304. It must be in the launching environment; the settings `env` copy is ignored. [^s55] | A reminder to the model is not an admission refusal. |

A native agent marked idle or waiting can retain context, a scheduler slot and tool processes. Whether a particular Haiku wrapper releases a workflow slot while waiting on Relay must be measured on the installed build. Until then, assume that it can retain the slot. Do not equate “idle” with zero RAM or available execution capacity.

The documented subagent stall timer is normally ten minutes; workflow coverage was added in 2.1.286. [^s55] In workflows, time spent waiting on the agent’s own tool calls or a usage reset is excluded. This helps long waits but does not override a Bash timeout, process-run timeout, cancellation or another background-process lifetime rule. [^s57]

### Linux/WSL memory caps are useful but have different behavior

`CLAUDE_CODE_TOOL_MEMORY_LIMIT` creates a per-session aggregate cgroup cap on Linux/WSL from 2.1.233; Monitor joins Bash/PowerShell from 2.1.246. If setup fails, commands run uncapped and the debug log gives the reason. Initialization is cached until relaunch. Exceeding the cap can cause the kernel to kill a command without its output naming the cap. [^s58]

From 2.1.246, additional kinds can include MCP, LSP, hooks, plugin, helper and agent processes. `CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE=none` includes all supported kinds; `all-new` retains only Bash/PowerShell/Monitor. When unset, the additional set is server-delivered and may change. Permission-gating hooks and the MCP calls they require remain excluded. Thus the guide’s “shell tools only” description is incomplete for newer builds. [^s58]

This optional cap is separate from the requested non-killing Relay guard. Inspect actual membership and setup success before relying on it. A process outside the Bash security sandbox may still belong to a constrained memory cgroup. Security sandboxing and resource accounting answer different questions.

## 7. Two queues, one composite Relay job

| Stage | What exists | Who can schedule it |
| --- | --- | --- |
| Native Claude queue | A workflow request waiting to start its wrapper; there may be no Relay job or worker yet. | Claude’s native workflow scheduler. |
| Relay queue | The wrapper has submitted a job; a queued Relay worker may already exist, while its external backend has not started. | Relay’s shared admission ledger. |
| External execution | Relay worker, backend process and any tools; the wrapper may wait in the parent Claude host. | One Relay execution ticket, with workload and host-pressure checks. |

**Recommended v1 accounting:** associate the wrapper, worker, external backend and descendants with one stable Relay job ID. Attribute its execution seat to the external backend—Codex, Grok, ZCode or Kimi. Do not charge both a native-wrapper seat and an external-job seat against the same capacity pool. Parent Claude memory already appears in available RAM; the reservation covers uncertain additional growth rather than recharging the entire parent.

Double admission can deadlock. With four shared tickets, four wrappers could each acquire one and then wait for external jobs that each demand another ticket. No external job can start, and no wrapper can finish. A future unified scheduler must transfer or reuse a ticket across the parent/child relationship, or give orchestration a separate bounded budget. Cleanup, cancellation, status reads and admission bookkeeping must remain usable when execution is full.

Do not add native-queued and Relay-queued counts blindly: the same work can move between them. Show the queue stage and external backend. `waiting` in Claude’s inventory is not itself a process-footprint measurement or proof that a Relay ticket is free.

A full pending-worker queue must return a typed **not admitted for capacity** result, distinct from an accepted queued job. The wrapper reports it once and terminates; the caller must not repeatedly spawn replacement wrappers to poll for room. Retry is explicit, or handled by one bounded coordinator using capacity notifications/backoff. This closes the gap a worker limit alone leaves: otherwise the caller can create an endless succession of native wrappers and retained transcripts.

Fairness has an information boundary. If a workflow first starts four Codex wrappers and keeps Grok/Kimi wrappers in its native queue, Relay cannot select those unseen requests. It can promise fairness among **submitted, eligible Relay requests**. Interleaving backend types when submitting native workflows improves diversity immediately; seeing all planned requests would require a later integration.

Repository experiments at the pinned baseline found Workflow agents absent from the 2.1.308 `$.agent.list()` declarations, although `agent.spawn` could refuse them. They also observed a Workflow message creating a second loop under the same native agent ID, including a duplicate Relay waiter. These are versioned observations, not claims that every current build behaves identically. Use the Relay job ID as the execution identity and make retries, waits and cancellation idempotent; native agent ID alone is insufficient evidence of one execution. [^s60]

## 8. CPU and machine performance characteristics

RAM is the main first-release capacity metric because memory pressure can freeze a machine even when CPU is low. CPU is still useful as a secondary busy veto. Neither GHz nor logical-core count provides a reliable performance conversion between an older Intel laptop, Apple Silicon and other architectures.

Compute a rough whole-machine CPU percentage from two os.cpus() time-counter snapshots one to two seconds apart. Sum the per-core idle and total counter deltas; busy percent is 100 times (1 minus idle delta divided by total delta). This produces a 0-100% machine scale, unlike the benchmark's one-core scale. Persist the previous counters and busy state in the shared sample so readers do not restart the observation window. [^s33]

Proposed initial thresholds: enter CPU busy after 10 seconds at or above 85%; leave after 10 seconds below 70%; keep the previous state between them. These values are policy, not a researched universal optimum. Missing CPU data may be tolerated when required memory data is valid. Empty CPU lists, counter resets and nonpositive intervals must produce unknown rather than zero.

Keep five-minute load average for diagnostics. It responds too slowly to the described burst, is not CPU utilization, and Node returns [0,0,0] on Windows. Use os.availableParallelism() as an estimate of usable parallelism, with explicit quota handling when relevant; do not normalize a host-wide CPU sample using a different container's core allowance. [^s33]

Record platform, architecture, OS/runtime versions, effective total RAM, logical/available CPU capacity and execution scope once at setup. Live pressure decides whether the machine can admit work now. Thermal state, disk contention and heterogeneous core performance can be later enhancements.

For the first release, record platform, architecture, OS/runtime versions, visible physical RAM, execution-scope limits, usable logical CPUs and sample quality. Do not invent an Apple-versus-Intel or Windows-versus-Linux speed coefficient. A one-core busy task, swapping, disk contention and thermal throttling can make the machine feel slow without a simple all-core CPU threshold identifying the cause.

## 9. Portable live RAM readings and execution scope

| Environment | First useful reading | How to interpret it |
| --- | --- | --- |
| Linux / Fedora | /proc/meminfo: MemAvailable and MemTotal | Multiply the reported kB values by 1024. MemAvailable estimates new-application capacity without swapping. [^s24] |
| Linux constrained scope | Applicable cgroup memory.max and memory.current | Use the tightest remaining allowance across finite ancestors, together with host availability. Treat this subtraction as conservative. [^s25] |
| macOS | vm_stat plus a pressure signal | A first estimate is (free + inactive pages) times the reported page size. Label it heuristic, not Linux-equivalent. [^s27][^s28][^s29][^s30] |
| Windows, future native support | GlobalMemoryStatusEx plus GetPerformanceInfo | Require both physical availability and commit headroom; pagefile capacity is not extra physical RAM. [^s31][^s32] |

Linux: MemFree alone ignores reclaimable capacity. If execution is constrained by a container, service or user cgroup, a healthy host can still hide a local limit. Check every applicable finite ancestor, not only the leaf. memory.high can cause reclaim and throttling before memory.max; PSI at /proc/pressure/memory or the cgroup's memory.pressure describes time lost to contention. Keep PSI as diagnostic or a calibrated busy veto initially, rather than inventing a universal threshold. [^s24][^s25][^s26]

macOS: run /usr/bin/vm_stat once per shared sample and parse its actual page size. A free-plus-inactive estimate follows psutil's Darwin approach. Do not add every page category: speculative, purgeable and other counts can overlap, and compressed memory still consumes RAM. Apple's explanation of memory pressure includes swap rate, wired memory and cache, so standing swap usage alone is not a reliable critical-now rule. [^s27][^s29]

```text
/usr/bin/vm_stat
/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level
```

The pressure sysctl is implemented in Apple's XNU source and is readable without the non-macOS privilege check. Its dispatch levels are normal (1), warning (2), critical (4). It is a private, masked interface: capability-test it on the supported macOS builds and record unknown on failure. A minimal policy can stop new work on warning or critical while continuing active work. If it is unavailable but the byte estimate works, use an explicitly degraded, lower-capacity mode; do not display healthy. A future native helper using public memory-pressure notifications is cleaner. [^s30]

Do not assume process.availableMemory() fixes macOS portability. Node 22.17.1's bundled libuv implements it using the same raw-free calculation as uv_get_free_memory(). The runtime version matters; Relay supports Node 22 and later, and the Desktop guide records Node 24.21.0. Use a tested adapter rather than assuming all supported Node versions share one availability definition. [^s28][^s35]

Windows: physicalAvailableBytes is MEMORYSTATUSEX.ullAvailPhys. Commit headroom is (CommitLimit - CommitTotal) times PageSize from PERFORMANCE_INFORMATION. Committed pages can consume commitment before becoming resident. Keep those two gates separate; do not enlarge the RAM budget by adding pagefile bytes. Adding this collector alone will not make Relay Windows-compatible. [^s31][^s32][^s35]

### Keep host and per-session constraints separate

A shared host sample is reusable; a particular worker’s cgroup headroom is not automatically reusable by another session. On Linux, inspect the worker/backend’s applicable hierarchy, including finite ancestors. A Mod helper’s `/proc/self/cgroup` describes that helper, which can differ from the target. Process detachment alone does not remove cgroup membership. A supported launch path that moves a process to another scope must be accounted against its actual limiting ancestors. [^s25]

Cache constraint data by the actual scope identity, or read the small relevant files at admission. Charge pending reservations only to the ancestors the prospective allocation will consume. Retain a separate host-wide pending total for all participating starts. If scope cannot be established, report it as unknown; do not silently retry outside its limits.

The host/VM needs interactive headroom; a small cgroup needs its own margin. Applying a fixed 2 GiB host reserve inside a 2 GiB tool cgroup would make every job impossible. Section 12 therefore uses separate tests. This supersedes the single “effective total/effective available” formula in the earlier report.

## 10. Claude Mods integration in Terminal, Desktop and SDK sessions

### Use the companion for measurement and admission

A Mod has no Node or DOM runtime and reaches the host through `$` APIs. Relay already invokes Node and `scripts/companion.mjs status --json` with `$.process.run`; a cached `loadGuard` snapshot fits that bridge. Keep sensing, atomic reservations and enforcement in the companion/worker. Let the Mod render and request actions. [^s21][^s22][^s38]

Mods run in Terminal and supported Desktop sessions, and hooks can load in `claude -p`/SDK sessions without a UI surface. Current docs exclude Desktop WSL sessions because plugins do not load there. The reviewed Relay Desktop guide supports macOS/Linux and excludes native Windows due to its process-management assumptions. A Windows sensor alone will not complete Windows support. [^s23][^s35]

Measure the execution environment. SSH workers belong to the remote machine; a cloud VM/container is not the laptop displaying it. Identify the host and scope in status. Native Windows lacks Claude’s Bash sandbox, but OS permissions and resource controls can still apply. Mod-launched processes are outside that Bash sandbox; this does not authorize bypassing the PR #32 permission/sandbox floor. A refused sensor is unavailable, not an instruction to escape. [^s48][^s42]

### Shared storage is not an atomic semaphore

`$.store` is shared across a mod’s sessions, but a separate get followed by set is not atomic. `$.fs.write` is also not an atomic replacement operation, and the API does not expose the compare-and-swap or lock primitive needed for a reliable admission semaphore. Keep that transaction in the existing Node companion using its supported local filesystem locking pattern. [^s61][^s43]

Use one collector refresh at a time, a small cached snapshot and bounded subprocess time/output. A suggested production cadence is one sample per second while there is demand, reusable for at most three seconds. Persist CPU counters and hysteresis state across reads. Do not let every 250 ms worker inbox poll launch another `vm_stat`, `sysctl`, PowerShell or Node collector. Sample outside the admission transaction; check freshness again when committing a permit.

Include `sampledAt`, host/scope identity, platform, physical total/available bytes, applicable constraint headroom, pressure, CPU percentage/window, source quality and error notes. Cache host data globally and cgroup data by scope. Avoid doing expensive sensor work inside a status render or high-frequency listing. `$.ui.invalidate` redraw limits are UI limits, not a recommended sampling rate.

### Hooks can intercept work; they are not a durable queue

A `tool.call` handler can await work before invoking `next(e)`, or return a refusal. Waiting is not restricted to `$.ui.ask`. [^s62] The hook’s own budget is ten seconds, or 50 ms for `prompt.edit`; API/`next` time is excluded except `$.clock.sleep`. `.catch` gets one second. `$.process.run` defaults to 30 seconds and allows at most ten minutes. A skipped timed-out hook is not a reliable admission barrier. [^s43]

Use short companion requests, bounded waits and durable Relay state. A user dialog cannot be required for headless enforcement. Do not keep a multi-minute queue in a Mod’s own Promise or sleep loop; module reloads also destroy in-memory coordination. Classic `PreToolUse` defer is documented for a single tool call in `-p`, not as a universal TUI/Desktop queue, and its routing through a Mod must not be assumed. [^s22][^s63]

### Workflow spawn interception is now versioned, documented functionality

| Claude Code version | Changelog evidence |
| --- | --- |
| 2.1.292 | Workflow agents added to `agent.spawn`, including run/index and refusal. |
| 2.1.299 | Resuming a finished subagent or killed teammate invokes `agent.spawn` with `resume`, allowing refusal. |
| 2.1.300 | Workflow `prompt` and `model` can be rewritten in `agent.spawn`. |

These entries correct the investigation’s broad uncertainty about workflow interception. [^s59] The generic reference still says that SendMessage resumes do not fire the hook, and identifies older coverage. That conflicts with the newer changelog and repository observations; do not build around that older sentence. Validate the installed `.claude-plugin/types` and the exact resume path in each harness. [^s43][^s60]

Spawn interception does not establish complete inventory or queue timing. `$.agent.list()` is session-scoped and is not a machine-wide process list; the repository’s workflow omission matters. Whether `agent.spawn` fires before or after a workflow request obtains its native slot remains a runtime question. For v1, native counts can remain observational, with external backend admission enforced at Relay’s own launch points.

## 11. Review of the supplied load-guard draft

The proposed gate immediately before the first worker connection is a good central point for ordinary starts, resumes and deliveries. The following findings concern the inspected baseline and supplied excerpt; later design sections may already address some policy questions.

- Cover foreground reviews. cli/review.mjs directly calls backend.connect for ordinary reviews and backend.review.native for native reviews. A gate only in worker.mjs misses these launches. Reuse the same admission helper at every backend creation path. [^s36]

- Recheck before reconnecting. worker.mjs closes the failed connection and loops back to connect(), which creates a replacement backend. Keep the logical seat, but recheck pressure, startup spacing and a new startup reservation; do not acquire a second seat. [^s37]

- Check critical pressure before another turn on a retained connection. Existing backend memory is already counted, but that next turn can launch new tools. This check reduces new work without stopping an active turn. It still cannot police every tool allocation. [^s37]

- Never launch automatically after an admission-lock timeout or corrupt shared state. Contention must queue. Otherwise a synchronized timeout can reproduce the original synchronized burst. Reclaim stale owners only using verified process identity; retain an explicit user off switch.

- Do not let a minimum bypass per-job headroom. The draft already says critical overrides the minimum; ensure the ordinary byte-budget rule also applies below the guaranteed weight. A concurrency allowance is not a promise that those jobs fit.

- Bound live queued workers and wrapper growth. A detached Node worker already exists at the proposed gate, and its native Claude wrapper may already exist too. Enforce a finite pending-worker bound before spawning more; return a clear capacity result when full, with no tight automatic retry loop. Native workflow settings can limit wrappers without adding a second execution ticket. [^s34][^s37]

- Make the admission scope explicit. A lock under the jobs home coordinates participants using that same location on the same executor. T3's independent delegates and directly launched harnesses are outside the seat ledger; their use is visible only through global pressure.

- Separate provider refusals from local pressure. A usage/rate/concurrency pause needs independent recovery. A provider probe still needs local admission capacity; recovery from a provider pause must never override a machine veto.

The draft's 30-second pending-memory concept is useful, but its explanation should change. Allocated memory is normally visible promptly; the uncertainty is allocation that has not happened yet. Keeping a full reservation after the allocation appears intentionally double-counts during startup. Call it growth headroom, not a 30-second OS reporting delay.

Preserve the useful user-facing contract: start/continue/resume/steer acknowledgments remain prompt; queued work retains liveness and can be cancelled; status explains the first actual blocking reason. Keep provider-pause information separate from local pressure. Existing 1/2/3 weights and the `admission`/`refusal` fields can remain, with byte allowances and queue scope recorded separately. “Guaranteed” weight must never promise admission when bytes do not fit.

The draft’s automatic “admitted without the guard” fallback conflicts with the stated purpose when locks or required state fail. Prefer a visible held/failed admission with a reason, while preserving an explicit user opt-out. Cancellation and cleanup remain available. This is a proposed behavior change, not a claim that the supplied draft already implements it.

## 12. A small, coherent admission policy

This is a concrete proposal for the first implementation. It needs no model benchmark database, long-running scheduler daemon or learned predictor. Every threshold below is a proposed default.

### Memory tests: host reserve and cgroup margins are distinct

```text
J = max(harnessFloorBytes, wholeJobAllowanceBytes)
H = max(2 GiB, 0.20 * hostOrVmPhysicalTotalBytes)

Host test:
  freshHostAvailable - otherHostStartupHolds - J >= H

For each finite limiting cgroup ancestor g:
  remaining_g = memory.max_g - memory.current_g
  margin_g = min(0.5 GiB, 0.10 * memory.max_g)
  remaining_g - otherStartupHoldsChargedTo_g - J >= margin_g

Also require acceptable pressure, CPU state, active count,
startup spacing, workload cap and provider eligibility.
```

The allowance already includes the harness: do not add that floor a second time. Available memory already reflects existing Claude, T3, apps and jobs, so do not subtract all active jobs’ estimates again. Startup holds are additional growth headroom. On an unconstrained machine only the host test is needed; on Windows, also require sufficient commit headroom for the prospective allocation.

The cgroup margin above is deliberately small relative to a constrained scope and is **not** a documented kernel safety threshold. Inspect all applicable finite ancestors. A job whose allowance plus margin exceeds the entire scope limit cannot fit under this policy; return an actionable “cannot fit this scope” result or require a smaller declared workload, rather than leaving it in an endless busy queue. Apply the same feasibility check when the host reserve plus allowance exceeds physical total.

When revalidating a granted permit or reconnecting, atomically replace or refresh that candidate’s own hold. Do not subtract its current hold and then charge J again. A host with 16 GiB total has proposed H = 3.2 GiB: A = 7 GiB admits a 2 GiB job without other holds, but not with another 2 GiB hold. This is arithmetic, not a machine measurement.

| Setting | Suggested starting policy |
| --- | --- |
| Whole-job allowance | 2 GiB when unknown; 4 GiB for known heavy work; explicit larger overrides. |
| Host/VM reserve | max(2 GiB, 20% of visible physical total). |
| Finite cgroup margin | min(0.5 GiB, 10% of the actual limit), checked separately from the host reserve. |
| Startup hold | 30 seconds after admission for future growth; release confirmed unused holds after a failed launch/completion. |
| Startup spacing | At least 2 seconds between actual backend starts across participants, including replacement backends. |
| Sensor cadence/freshness | One shared refresh per second during demand; required memory at most 3 seconds old at admission. |
| Active Relay ceiling C | Roughly one job per 8 GiB of host/VM RAM, capped at 6; optionally clamp to half usable logical CPUs, with a minimum ceiling of 1 before pressure checks. |
| Heavy ceiling | One declared XL/XXL job at a time; separately serialize actual full test suites. |
| Queued-worker ceiling | A finite proposed default of 2 × C additional workers, enforced before worker creation; reject excess clearly. This does not count metadata-only native queued requests as workers. |
| CPU busy | Enter at 85% for 10 s; clear below 70% for 10 s; preserve state in between. |
| Lock/shared-state failure | Hold starts or fail clearly; no automatic bypass. |
| Required memory missing | Hold starts. Missing optional CPU can remain unknown. A tested fallback may use an explicit degraded mode. |
| Opt-out | Retain an explicit user setting/environment override, clearly displayed. |

Advertised RAM tiers around 8/16/24/32/48 GiB suggest ceilings 1/2/3/4/6. Allow documented small OS-reporting differences so a 15.5 GiB machine is not accidentally treated as an 8 GiB tier. Never round an actual VM or cgroup limit up to an advertised host tier. The count is a ceiling, not a guarantee: pressure or per-scope constraints can reduce admissions to zero.

### Atomic admission and permit lifetime

- Under one short shared lock, validate the required sample and applicable scope data, reconcile known leases, choose an eligible request fairly, test all limits, and write the seat plus startup hold atomically.

- Launch outside that lock. Ensure actual starts satisfy the stagger: delayed permits expire or revalidate before spawning, so several delayed grants cannot launch together.

- Keep the seat for the backend lifetime after its 30-second hold expires. Reconnect retains the same seat but obtains a new hold and launch check. Releasing a seat requires verified cleanup; a dead worker can leave live children.

- Keep cancellation, cleanup, status and coordination callable even when no execution can be admitted. Preserve prompt request acknowledgment and liveness while genuinely queued.

The coordination boundary is the participating jobs home on the same executor. Other users, different jobs homes, T3’s independent delegates and directly launched harnesses do not enter this seat ledger automatically; their use is visible through host pressure. A shared directory on different execution machines must not be mistaken for a single machine budget.

### Status that makes the limits reviewable

Report host/VM memory, applicable constraint headroom, sample age/quality, unexpired growth holds, active seats, pending workers, selected allowance, and the first blocking reason. Distinguish a native Claude queue from a Relay queue where observable. A missing required sensor is unknown; a byte estimate with missing optional pressure can be explicitly degraded. Preserve existing field meanings rather than silently replacing a weight with bytes.

This guard controls admissions. A job can finish remote reasoning and launch a large test after its startup hold has expired. A low count ceiling and test serialization reduce that risk; only later tool admission or containment can directly control every such allocation.

## 13. Fair backend access, provider pauses and immediate test protection

For the requested diversity, use seats per backend. Under the shared admission lock, look at the oldest waiting job for each eligible backend, prefer the backend with the fewest active seats, and break ties by queue age and a stable identifier. Exclude paused backends and requests that cannot fit. This is much more reliable than letting workers race for the lock.

Seat diversity and memory fairness are different: one 4 GiB allowance and one 0.5 GiB allowance each occupy a seat. The memory gate handles bytes separately. If only one backend has work, it may use spare capacity. Once another backend is waiting, favor it at subsequent eligible admissions. Without preemption, it cannot take a seat already occupied by a running job; do not promise immediate equal occupancy. Larger waiting jobs may need aging or temporary capacity reservation later to avoid starvation.

A paused backend or a job that cannot fit is not an eligible claimant to the last free seat. Reconsider when it becomes eligible; otherwise one blocked request can idle the whole machine. A probe after a provider pause still passes the local memory, count and stagger checks. Preserve one-probe-at-a-time behavior and leave the originally refused job failed until explicitly resumed, as the draft proposes.

A concrete immediate improvement matches the reported Fedora incident: Relay's package test script is node --test tests/*.test.mjs. Node's file concurrency normally scales with available parallelism. Several independent suites can therefore multiply worker counts. [^s39][^s40]

```text
node --test --test-concurrency=1 tests/*.test.mjs
```

Use 2 only when measured capacity allows. Put the option before file operands. This limits test-file concurrency, not arbitrary children a test itself launches. Keep the existing machine-wide full-suite lock mentioned in PR #32; use the same lock across worktrees. With multiple execution machines, the lock is local to each executor. [^s40][^s42]

Nested agents and MCP configuration deserve the same treatment. Codex exposes per-session subagent limits, while Kimi documents task.max_running_tasks for background work. A single Relay seat is not automatically a cap on those descendants. Keep unnecessary local MCP services disabled in Relay jobs and bound expensive work explicitly; do not assume disabling only node_repl disables every other helper. [^s20][^s45]

For native workflow submissions, alternate backend types where practical so one backend’s wrappers do not consume every available native slot before the others reach Relay. This is an operational improvement, not a promise of preemption. If future native/Relay coordination uses one global pool, apply the composite-ticket rule from section 7.

## 14. Small calibration plan and staged future work

Do not delay the first release for a 21-model × effort × OS benchmark. The next useful evidence is per harness, workload and execution topology in the exact Relay launch modes.

| Pilot | What it should resolve |
| --- | --- |
| One supported Mac and one Fedora executor | Exact binaries/runtimes, launch mode, machine limits, MCP set, tool concurrency and cold baseline. |
| Cold task, growing read/review, representative coding/test | Whole worker/backend/descendant peak, history growth, later tool bursts and cleanup. |
| One, two and four native Claude agents in the same parent | Incremental shared-host cost without multiplying the parent’s baseline. Include bounded large tool outputs. |
| Small workflow limit with Relay admission deliberately held | Whether a waiting wrapper retains a native slot; whether queued requests appear in list/spawn events before admission. |
| Record spawn, resume and inventory events on the installed build | Agent/workflow coverage and exact queue timing in Terminal, Desktop and SDK; no dependence on stale reference text. |
| Record cgroup membership for Mod helper, companion, worker and backend | Which real ancestor limits apply, including any supported systemd launch path. |
| Full queue plus cancellation and repeated delivery | One composite ticket, bounded workers, no duplicate backend start, working cleanup, no nested-admission deadlock. |
| Long wait through short companion calls | Tool timeout, hook budget and reload behavior without assuming an unlimited Mod call. |

Include the full descendant tree and observe after completion. During calibration, 100–250 ms samples can catch short peaks when practical; the production guard should sample more slowly. Run repeated matched tasks and publish a range. A few runs are a pilot, not enough for a stable p95/p99. Compare effort levels only after controlling or recording changed tool activity. Keep OS-specific memory metrics separate.

Later priorities: process-tree accounting and calibrated workload envelopes; admission for expensive tools/tests and nested agents; Linux resource scopes with explicit failure policy; public macOS pressure/footprint integration; native Windows process identity, cancellation and Job Objects; then more sophisticated memory-aware fairness. Resource containment may terminate or throttle work and therefore needs its own design.

A useful first-release contract is: **Relay budgets and staggers new participating backend starts, holds new work under measured pressure, bounds pending workers, and fairly selects among submitted eligible backends. It leaves running turns alone and does not claim to manage every other process on the machine.** Native Claude scheduling remains in place, with composite accounting for its Relay wrappers.

## 15. Reconciliation of the Claude Guide investigation and remaining questions

The pasted investigation is useful input, but some statements are superseded by newer documentation or need narrower scope. The following resolutions are incorporated throughout this report; they are collected here so the design reviewers can see what changed.

| Investigation/design proposition | Resolution for this report |
| --- | --- |
| Native workflow work is queued and resource-limited. | Confirmed per workflow run; it is not a documented machine-wide memory budget across independent sessions. See section 6. |
| Default workflow limit is an exact CPU formula such as min(16, CPUs − 2). | Not verified. Official wording says up to 16, fewer with fewer available CPUs. Do not encode the unofficial formula. |
| Idle Claude agents make local resource accounting unnecessary. | No. Waiting/idle state does not prove memory release, slot release or stopped descendants. |
| All Claude agents need the independent-instance RAM allowance. | No. Native subagents share the parent process; independent CLI/SDK sessions do not. |
| Workflow interception through agent.spawn is unknown or unavailable. | Updated: support appears in 2.1.292, with rewriting in 2.1.300. Queue timing and installed-build behavior still need a probe. |
| SendMessage resume never fires agent.spawn. | Older reference text conflicts with the 2.1.299 changelog and repository observations. Validate the particular resume path. |
| agent.list gives a complete inventory for admission. | No. It is session-scoped, and the pinned repository observed Workflow omissions. Use Relay’s own job ledger for external execution. |
| Shared Mod storage is unavailable, or can itself serve as a lock. | Both are too broad. Cross-session shared storage exists; get/set is not an atomic reservation. |
| A hook can only hold execution through a user prompt. | Too narrow. API waits can precede next; budgets and reloads still make the companion the right durable queue boundary. |
| Linux tool memory caps cover only shell commands. | Outdated for newer builds: more process kinds can be included, with documented exclusions and setup-failure behavior. |
| Mod process.run is outside the Bash sandbox, so limits do not apply. | Security sandbox scope does not establish cgroup, OS or permission scope. Inspect the actual process and preserve the sandbox floor. |
| A Haiku wrapper and its external backend need separate execution tickets. | Treat them as one composite Relay job. Two acquisitions from the same bounded pool can deadlock. |
| One effective available-memory number is enough for all sessions. | Use shared host data plus correctly scoped constraint readings and separate margins. A helper’s cgroup is not necessarily the backend’s. |
| A 30-second hold compensates for delayed OS memory reporting. | It reserves future growth. Observed allocation normally appears promptly; temporary double-counting is intentional. |

**Remaining runtime questions:** the marginal RAM of native Claude agents; slot retention while a wrapper waits; event timing relative to the native queue; complete inventory on the exact installed build; actual cgroup membership after each launch path; and long-wait/cancellation behavior across Terminal, Desktop and SDK. None of these requires inventing per-model RAM figures or blocking the minimal external-backend guard. They are the focused probes in section 14.

## Sources and provenance

Vendor documentation and original experiments/reports were inspected for this research on 23 October 2026. Mutable documentation may change; repository links are pinned where the inspected baseline matters. Source footnotes distinguish original reports from controlled measurements. The user-provided incident, setup output, draft and Claude Guide investigation are contextual inputs, not independently measured machine data. Recommendations and numerical policy defaults are the analysis of this report.

No private sign-in details or credentials from the setup are reproduced.

[^s1]: **[Controlled harness benchmark](https://github.com/KonghaYao/harness-perf-benchmark)**. Original experiment; September 2026 batches; inspected 23 October.

[^s2]: **[Kimi performance PR 3975](https://github.com/MoonshotAI/kimi-code/pull/3975)**. Merged performance work, 22 September 2026.

[^s3]: **[ZCode Linux memory growth issue 945](https://github.com/zai-org/feedback/issues/945)**. Original report, 7 October 2026.

[^s4]: **[ZCode Windows idle process report 1141](https://github.com/zai-org/feedback/issues/1141)**. Original report, 21 October 2026.

[^s5]: **[ZCode macOS Flash OOM report 1155](https://github.com/zai-org/feedback/issues/1155)**. Report 22 October; incidents 21 October 2026.

[^s6]: **[Codex MCP process growth issue 25015](https://github.com/openai/codex/issues/25015)**. Original Linux reproduction, 29 May 2026.

[^s7]: **[Codex Windows CLI issue 52799](https://github.com/openai/codex/issues/52799)**. Original 0.162.1 report; inspected 23 October 2026.

[^s8]: **[Codex macOS memory report 55944](https://github.com/openai/codex/issues/55944)**. Observed 21 October 2026.

[^s9]: **[OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)**. Current official documentation.

[^s10]: **[Codex App Server model discovery](https://developers.openai.com/codex/app-server)**. model/list and account/client-specific efforts.

[^s11]: **[OpenAI gpt-6.1-sol model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol)**. Current public API effort documentation.

[^s12]: **[OpenAI gpt-6-astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)**. Current public API effort documentation.

[^s13]: **[OpenAI gpt-6-sol model reference](https://developers.openai.com/api/docs/models/gpt-6-sol)**. Current public API effort documentation.

[^s14]: **[OpenAI gpt-6-luna model reference](https://developers.openai.com/api/docs/models/gpt-6-luna)**. Current public API effort documentation.

[^s15]: **[OpenAI gpt-5.6-sol model reference](https://developers.openai.com/api/docs/models/gpt-5.6-sol)**. Current public API effort documentation.

[^s16]: **[OpenAI gpt-5.6-terra model reference](https://developers.openai.com/api/docs/models/gpt-5.6-terra)**. Current public API effort documentation.

[^s17]: **[OpenAI gpt-5.6-luna model reference](https://developers.openai.com/api/docs/models/gpt-5.6-luna)**. Current public API effort documentation.

[^s18]: **[Grok reasoning documentation](https://docs.x.ai/developers/model-capabilities/text/reasoning)**. API effort list; product catalog can differ.

[^s19]: **[ZCode model configuration](https://zcode.z.ai/en/docs/configuration)**. Current effort table and provider behavior.

[^s20]: **[Kimi configuration files](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)**. Model effort metadata and background task controls.

[^s21]: **[Getting started with Claude Code Mods](https://claude.dev/blog/getting-started-with-claude-code-mods/)**. Official tutorial, 1 October 2026.

[^s22]: **[Claude Mods API](https://code.claude.com/docs/en/plugins/mods/api)**. Process, file and clock API.

[^s23]: **[Claude Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)**. Runtime capabilities and supported session surfaces.

[^s24]: **[Linux proc filesystem](https://www.kernel.org/doc/html/latest/filesystems/proc.html)**. MemAvailable definition.

[^s25]: **[Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)**. Hierarchical memory limits and accounting.

[^s26]: **[Linux Pressure Stall Information](https://www.kernel.org/doc/html/latest/accounting/psi.html)**. Contention and stall measurements.

[^s27]: **[Apple Activity Monitor memory guide](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac)**. Memory pressure, compression and swap.

[^s28]: **[Node 22.17.1 Darwin libuv implementation](https://github.com/nodejs/node/blob/v22.17.1/deps/uv/src/unix/darwin.c)**. Pinned free/available-memory implementation.

[^s29]: **[psutil Darwin memory implementation](https://github.com/giampaolo/psutil/blob/a1e3067965a075c40b79971cfda51501e80da685/psutil/arch/osx/mem.c)**. Pinned free-plus-inactive availability calculation.

[^s30]: **[Apple XNU memory pressure implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c)**. Private sysctl implementation and privilege guard.

[^s31]: **[Microsoft MEMORYSTATUSEX](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex)**. Physical memory availability.

[^s32]: **[Microsoft PERFORMANCE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-performance_information)**. Commit totals, limits and page size.

[^s33]: **[Node OS API](https://nodejs.org/api/os.html)**. CPU counters, availableParallelism and Windows loadavg behavior.

[^s34]: **[Relay architecture at design baseline](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/docs/architecture.md)**. Pinned 136b457; one worker and backend per job.

[^s35]: **[Relay Desktop guide at design baseline](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/docs/desktop.md)**. Support scope and local Mac test of 22 October.

[^s36]: **[Relay foreground review source](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/plugins/relay/scripts/cli/review.mjs)**. Direct backend connection paths.

[^s37]: **[Relay worker source](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/plugins/relay/scripts/lib/worker/worker.mjs)**. Connection, subsequent turn and reconnect behavior.

[^s38]: **[Relay Mod implementation](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/plugins/relay/hooks/mod/register.js)**. Existing companion bridge and status polling.

[^s39]: **[Relay package manifest](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/package.json)**. Version and exact test command.

[^s40]: **[Node 22.17.1 command-line reference](https://nodejs.org/download/release/v22.17.1/docs/api/cli.html)**. --test-concurrency behavior.

[^s41]: **[Relay Claude Mods plan PR 6](https://github.com/libar-dev/relay-plugin-cc/pull/6)**. Merged 22 October 2026.

[^s42]: **[Relay skills and sandbox PR 32](https://github.com/libar-dev/relay-plugin-cc/pull/32)**. Inspected 23 October 2026; includes sandbox floor and test lock.

[^s43]: **[Claude Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)**. Exact host API reference; installed types remain build authority.

[^s45]: **[Codex configuration reference](https://developers.openai.com/codex/config-reference)**. agents.max_concurrent_threads_per_session and related settings.

[^s46]: **[Codex and ChatGPT model controls](https://developers.openai.com/codex/models)**. Ultra described as a subagent workflow.

[^s47]: **[Anthropic Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting)**. Official provisioning floor, query subprocess topology and peak-session sizing.

[^s48]: **[Claude Code sandboxing and execution boundaries](https://code.claude.com/docs/en/sandboxing)**. Native subagents share the parent process; background sessions differ; Mod process boundary.

[^s49]: **[Claude Code model configuration](https://code.claude.com/docs/en/model-config)**. Named efforts, Code defaults, provider aliases and Ultracode distinction.

[^s50]: **[Claude API effort](https://platform.claude.com/docs/en/build-with-claude/effort)**. Model support and API defaults, including Sonnet 5.5 high.

[^s51]: **[Claude Fable 5.1 model overview](https://platform.claude.com/docs/en/models/fable-5-1/overview)**. Current model ID, context and effort capabilities.

[^s52]: **[Claude Opus 5.5 model overview](https://platform.claude.com/docs/en/models/opus-5-5/overview)**. Current model ID, context and effort capabilities.

[^s53]: **[Claude Sonnet 5.5 model overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)**. Current model ID, context and effort capabilities.

[^s54]: **[Claude Haiku 5.5 model overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)**. Current model ID, context and effort capabilities.

[^s55]: **[Claude Code environment variables](https://code.claude.com/docs/en/env-vars)**. Workflow per-run queue, transcript retention, pressure reaping, memory reminder and stall-timer scope.

[^s56]: **[Claude Code subagents](https://code.claude.com/docs/en/sub-agents)**. Concurrent Agent limit, exceptions, separate workflow/teammate scope.

[^s57]: **[Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)**. Workflow execution and usage-limit pauses.

[^s58]: **[Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)**. TOOL_MEMORY_LIMIT, supported cgroup process kinds and exclusions.

[^s59]: **[Claude Code changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)**. Versioned entries 2.1.292, 2.1.299 and 2.1.300; inspected through 2.1.309.

[^s60]: **[Relay Mods plan and implementation observations](https://github.com/libar-dev/relay-plugin-cc/blob/136b4574e25305c61b7dc047e324a4a52cba4870/docs/mods/plan.md)**. Pinned observations: API coverage, 2.1.308 workflow inventory, resume/fork behavior. Repository evidence, not a universal runtime contract.

[^s61]: **[Claude Mods interface and shared state](https://code.claude.com/docs/en/plugins/mods/interface)**. Cross-session shared store and non-atomic get/set.

[^s62]: **[Claude Mods event handling](https://code.claude.com/docs/en/plugins/mods/events)**. Middleware next, awaiting work, refusal and error behavior.

[^s63]: **[Claude Code hooks reference](https://code.claude.com/docs/en/hooks)**. Classic hook behavior and non-interactive defer scope.
