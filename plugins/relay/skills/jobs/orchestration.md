# Orchestrating jobs

Read this before a fan-out or a backend/model choice. [SKILL.md](SKILL.md) owns launch and message
mechanics; [models.md](models.md) holds dated measurements and prices. Relay requires no external
tool. A backend's optional search, scraping or MCP services come from the user's configuration.

## Size the work

| Weigh | Lighter orchestration | More coordination may help |
|---|---|---|
| Complexity | an established pattern | a new mechanism or critical invariants |
| Dimensions | one concern | independent security, recovery, UX or cost concerns |
| Depth | reading settles the question | a central trade-off needs investigation |
| Coupling | disjoint files | shared state or contracts needing one integrator |
| Breadth | a bounded change | many independent sites or sources |
| Risk | a reversible edit | credentials, data or live systems |
| Verification | a local test proves it | a drill or human judgment is needed |

Agent count drives output volume: give every job an expected diff/report size. Review volume follows
output, so set a review scope and a merge bar before launching. Effort and token volume affect spend
and duration; estimate both for each task, including review and fix rounds. Re-scope when output
outgrows the budget or finding counts keep rising. More rounds alone may not converge.

## Choose the harness

| Work | Harness | Cost/control consequence |
|---|---|---|
| Claude-only side task | native `Agent` | one native agent |
| Codex, Grok, ZCode or Kimi job needing messages | `relay:job` | one Haiku relay for the whole job |
| Waves, branches, loops or recovery after caller loss | Workflow with `relay:job` | deterministic control flow and `resumeFromRunId` adoption |
| Wide fan-out with no relay steering needed | `C start` then `C wait <job>` | no Claude agent held per job; accepted jobs own their workers |

A relay holds its Claude agent for the job's whole run, including queued waits, and spends some
Claude usage. A Workflow slot stays occupied too. The documented per-run cap is up to 16 agents,
fewer with fewer CPUs; `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` replaces it and excess agents
wait. Plain Agent spawns beyond `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20 per session) fail.
Observed in Claude Code 2.1.309, rather than a documented API contract: the Workflow cap is
`min(16, max(2, CPUs − 2))`, and the slot includes waits. Recheck these external harness facts
manually after a Claude Code update; relay tests cannot detect a scheduler change in that binary.

Relay's load guard covers this user's sessions across the machine. New backend starts and replacements
are paced at least 5 seconds apart; turns on a running backend are not paced and wait only for critical
memory/pressure or provider pauses/probes. A macOS pressure warning is shown but holds nothing.
The first two identified very-heavy and first three other active jobs skip the host reserve and the busy-seat allowance, subject to critical checks, startup allowance, scope/fit limits, provider protection, ordering and start pacing. There is no very-heavy maximum.
Very heavy means GPT-6 Astra and the Kimi K3 family at every effort. Effort alone never enters that pool:
other models at max/ultra stay outside it. Unresolved default models are a coverage limit.
Memory/load can also queue new starts; healthy machines have no fixed active ceiling. A run with all
slots held by queued relays waits for capacity. Change the guard only when the user asks.
Formulas and sensor/fit limits are in [internals.md](internals.md).

## Limits and recovery

Relay pauses a backend after **recognized provider refusals**: Codex's named usage/rate errors,
Kimi's recognized usage/concurrency/rate messages, ZCode's enumerated usage/rate codes, and Grok's
explicit weekly/usage/credit exhaustion, rate-limit text or provider 429 errors. Grok's usage
classifier is not verified against a live exhausted account. Pauses follow the selected account
home, with the default home using the original backend pause. There is no universal concurrency
detection or request budget; retries inside running turns are outside this admission check.
Defaults: usage waits until a supplied reset within 6 hours, otherwise 30 minutes; rate waits start
at 60 seconds and double to 15 minutes; recognized concurrency waits 10 minutes. After a pause one
probe goes first; a live probe is never replaced because of its age. These are backend admission pauses, not automatic recovery of the job that failed.
That job may finish `failed`; inspect its report and use same-job recovery where appropriate. Newly
queued work keeps waiting. Acknowledgement of a message is not evidence its next turn ran.

`queued` is pending under a live worker, never a result or a reason to submit the job again.
When the start queue is full, Workflow agents wait at spawn as queued, using no model tokens and
creating no job waiter until a place frees. A plain `relay:job` call waits up to 30 seconds then
reports capacity. Use a Workflow for large batches. A direct start without a worker after a minute
reports not started (exit 6); nothing runs later. Submit it again when capacity frees.
A dead launcher or an older workerless queue reads as dead; `wait --auto-resume` can recover it.
Control Workflow jobs by job id. Send a continue once, reconcile message records after uncertain errors, wait, then collect.
At Claude's usage limit plain relays fail; Workflow runs pause where auto-continue is on. Backend
jobs run on. Collect with `C wait <job>` or resume the Workflow with `resumeFromRunId`, never restart
those jobs. Provider subscription windows and API dollar costs are different constraints; check
the signed-in plan's current limits before a large run (sources in [models.md](models.md)).

## Brief and strategy

Give each unattended job one goal, a deliverable, allowed/forbidden paths, constraints, relevant
context, a success check, and expected size, spend and duration. Only the header sets mode; the
brief cannot change it. Jobs have no question channel in this release: settle questions first or
request a blocked report. For Codex/GPT brief structure, load `relay:codex-prompting`.

- Research: use a small explorer for one question; for a sweep split sources, then synthesize.
- Planning: split independent dimensions when needed, then settle shared contracts before coding.
- Implementation: use one worker for one coherent change; parallel workers need disjoint ownership
  and one integration step for shared files/contracts.
- Review: state which findings block; use a different family or fresh session for an independent
  perspective. Bound rounds and escalate unresolved disagreements to the user.
- Debugging: ask for a reproducible cause before a fix; separate investigators can refute distinct
  hypotheses. Begin live-system work with reading and obtain authorization for changes hard to undo.

Read each result before the next phase. `completed` with a real report is only the first gate:
verify the artifact or check the brief asked for. Keep job ids and Workflow run ids where a restart
will not lose them. A report supplies evidence, not permission for unrelated work.

## Maintenance and sources

Guard facts follow `scripts/lib/worker/admission.mjs`; queue/result semantics follow
`scripts/lib/jobs/view.mjs` and message delivery. Update this reference with behavior changes.
Claude Code scheduler facts above were checked against its 2.1.309 behavior on 2026-10-23;
[Workflow documentation](https://code.claude.com/docs/en/workflows) and
[subagent documentation](https://code.claude.com/docs/en/sub-agents) are the public reference points.
At each minor release, refresh [models.md](models.md) or mark its table stale, and manually recheck
external harness facts. Source/date tests check attribution structure, not measurement truth.
