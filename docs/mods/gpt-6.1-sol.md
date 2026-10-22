# Relay Mods implementation plan, GPT-6.1 Sol

## 1. Verdict

Build a small Mod for deterministic commands and job visibility, with text replies that work in Claude-backed T3 sessions.
Ship `/relay-jobs` first; put a versioned companion bridge before controls, and terminal/Desktop panes after that.
Keep the worker, message ledger, recovery, `relay:job`, and all four existing hook responsibilities authoritative.
Do not budget this as a T3 dashboard: its Claude SDK sessions have no drawing surface, and other T3 providers run no Claude Mod.
The strongest later experiment is faster message observation; the current API does not prove a safe replacement for durable delivery.

## 2. Surface matrix and evidence

Research date: 2026-10-22. Repository: `f1283c9d13a77952d93d114185d5859e2d3bdbdb`, relay 2.2.0. Installed Claude Code: 2.1.307. All repository paths below are relative to `/Users/darkomijic/dev-libar/relay-plugin-cc` unless an absolute path is given. The repository remained unchanged. No relay job was started, steered, continued, resumed, or cancelled.

Evidence labels distinguish an observed result, a declaration or documentation guarantee, and an inference about a host. Experiments and downloaded documents are under `/tmp/relay-mods-gpt-6.1-sol/`.

| Capability | Interactive terminal | Claude Desktop, local Code session | Agent SDK and Claude-backed T3 |
|---|---|---|---|
| Engine events and typed `classic.*` hooks | Supported. Observed `session.start`; hooks validated against 2.1.307. | Documented support. Its bundled Claude version must be checked separately. | Supported when the plugin loads. Actual bundled-SDK probe observed `session.start` and `classic.SessionStart`. Other events are declared, not all exercised. |
| Registered commands with `{ text }` | Supported. Observed command execution. | Documented support. | Supported by the engine. Actual SDK probe returned command text with `num_turns: 0` and zero API cost. T3 forwards ordinary prompt text and can display synthetic assistant/result text; this is static evidence, not a live T3 command test. |
| `immediate: true` commands | Documented to run while a turn is active; registration was tested. | Same engine command flag; busy-session behavior not live-tested. | Engine supports the flag. A host must send the command while busy. Do not promise immediate execution through T3's ordinary composer queue; no separate Mod-command dispatch was established. |
| `$.ui.log` | Observed transcript line. Claude does not read it. | Documented transcript output. | Observed SDK `system` event with `subtype: "ui_log"`. The inspected T3 adapter has no matching display handler. SDK delivery is verified; T3 visibility is not. Plain `claude -p` text output omitted this line. |
| Panes | Observed a drawn pane and `isPlaced: true`. | Documented support, with element differences. The test kit accepted the probe pane for Desktop. | No drawing in the tested host. Observed `surfaces: []` and `ui.open` returning `isPlaced: false` with `no-surface`. |
| Indicators, `AbovePrompt`, spinner changes | Documented terminal rendering. | `AbovePrompt` supported; some other render sites are terminal-only. | No visible indicator without an attached drawing surface. Registering a render hook does not create one. |
| `$.session.send` | Declared/documented, same routing as SendMessage. | Same engine API. | Same engine API when plugin and recipient are available. No real message was sent in this investigation. Queue acceptance is not recipient execution. |
| `$.process.run`, `$.process.spawn` | `run` observed. `spawn` declared. | Documented host-process APIs; run on the Claude engine host, not in the Desktop renderer. Not live-tested. | `run` observed through the actual bundled SDK. `spawn` declared; it is suitable for a disposable watch process, not for owning relay jobs. |
| `$.store`, `$.state` | Observed reads/writes. | Declared engine APIs; not a separate Desktop database. | Observed reads/writes through the actual bundled SDK. No drawing is required. |
| OS/terminal notification | Terminal-specific, dependent on configured channel. | `$.ui.notify` reports no terminal surface. | Probe returned `isSent: false, reason: "no-surface"`. This is not a T3 notification API. |

Mods run in the Claude Code process. They do not run in T3 threads backed by Codex, Grok, Kimi, or another provider that does not use Claude Code. A future T3-native relay view could reuse the companion bridge, but that is a separate host integration.

The official [host matrix](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run) supports terminal, Desktop local Code, and headless hook execution. Desktop WSL sessions do not load plugins. Desktop includes its own Claude Code version; the terminal's 2.1.307 is not proof of Desktop's version. The [render-site reference](https://code.claude.com/docs/en/plugins/mods/reference#render-sites) distinguishes panes, `AbovePrompt`, and terminal-only render sites. Remote Control draws on the originating machine's terminal. The current docs confirm default Mod loading from terminal 2.1.287 and Desktop 2.1.286. VS Code drawing starts at extension 2.1.299, or 2.1.304 when feature flags are not fetched. Cloud sessions can run loaded Mod hooks but do not draw this UI. The obsolete `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` flag does not control current builds.

### What was actually tested

The scratch plugin generated its own installed-build declarations at:

`/tmp/relay-mods-gpt-6.1-sol/probe/.claude-plugin/types/claude-code/index.d.ts`

Its first line says `Written by Claude Code 2.1.307`. Relevant declarations include:

- Commands and `immediate`: lines 1920-1944.
- SDK `ui_log` delivery: lines 2435-2451.
- Pane placement without a surface: lines 2515-2540.
- Session sending: lines 2933-2949.
- Store and reactive state: lines 3440-3502.
- Process lifecycle and output limits: lines 3580-3639 and 8207-8258.
- `classic.PreToolUse` exception: lines 1275-1288 and 8180-8200.
- Inbound messages: lines 11945-11982.
- Session startup's null headless surface: lines 12277-12301.

I ran the plugin through both `claude -p` and the exact Agent SDK 0.3.276 library bundled in the installed T3 app. The SDK experiment used copied library modules, a scratch Claude configuration, an explicitly loaded scratch plugin, and no model prompt. `evidence/sdk-probe.jsonl` records classic startup logs, `ui_log`, the absent drawing surface, successful process/store/state calls, and a successful result with zero model turns. A live terminal session drew the pane. Two `claude plugin test` tests passed, covering the terminal/Desktop pane trees and the headless command's process/store/state behavior. This is not a live Desktop or end-to-end T3 UI test.

Two further probes matter for the bridge:

- A child wrote a scratch file and then exceeded a 150 ms process timeout. The Mod caught the timeout and read back the file. A rejected process call can follow a completed side effect. See `evidence/print-timeout.txt`.
- A child wrote 4,194,305 bytes. `process.run` returned 4,194,304 bytes, `isStdoutTruncated: true`, and exit 0. Successful process exit does not prove complete JSON. See `evidence/print-large.txt`.

The [creation guide](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build) says installed-build declarations take precedence over documentation. They do here. In particular, the API includes `process.spawn`, truncation flags, and versioned `$.state` writes, which deserve explicit treatment in the implementation.

### T3-specific findings and limits

The inspected installed app is `0.1.1-nightly.20261020.3438`, commit `fe27e8e3dc12`. Its ASAR SHA-256 is `a904e977780162f5e3a3357ac3ca6d0a346cd0f13e2152dfbd9cab6995bf91b7`. The copied files retain their original line numbers:

- `evidence/t3-binCli-DvdnACBz.mjs:199097` builds normal Claude query options and passes configured launch arguments onward. It does not globally disable hooks for ordinary turns.
- `:199394` and `:203907` pass user text into the SDK. `:47541` preserves leading slash commands when adding effort instructions.
- `:203896` rejects starting a second ordinary turn while one is active. Other steering paths exist, so this alone does not prove every busy command is impossible. It does show why `immediate` cannot override T3 queuing before input reaches Claude.
- `:204939` builds a separate capability probe with `settings: { disableAllHooks: true }`. That probe cannot discover commands registered by a user Mod. The normal adapter has no `commands_changed` handler in the inspected bundle, so picker discoverability requires a T3 fix or separate documentation.
- `:202650` through `:203433` handles selected SDK frames and assistant/result text. There is no `ui_log` handler or literal anywhere in this bundle. I infer that these logs are not rendered as user notices; the SDK still delivers them, and protocol logging can retain incoming frames at `:198926`.
- `evidence/t3-claudeHistoryWorker-EwZHWjIg.mjs:58530` identifies SDK 0.3.276. `:41842` updates its own command list from `commands_changed`, and `:41861` forwards messages to SDK consumers. This confirms the distinction between SDK support and T3 presentation.

These are static findings for the installed artifact, not proof that every remote T3 server the user connects to runs the same build. REA's automated analysis timed out; the conclusions above come from direct inspection of extracted JavaScript. Its native-file integrity warnings and incomplete automated-analysis record are preserved in `evidence/t3-rea-limitations.txt`. I did not use the older migrated T3 source checkout as current evidence.

## 3. Feature catalogue and responsibility decisions

Sizes: S fits one focused PR; M needs several coordinated changes; L changes execution or host integration and needs a separate project. "All Claude hosts" means terminal, Desktop local Code, and loaded-plugin SDK sessions, with T3 qualifications from section 2.

### A. Direct status command, build first, S

- User value: `/relay-jobs` produces an accurate status table without a Claude model choosing a Bash command or rewriting the output. Include running/dead state, owed messages, relay violations, workflow provenance, and collection status.
- APIs: `session.start`, `$.command.register`, `command.run`, `$.process.run`, `$.plugin.root`, and `$.session.cwd()`.
- Runtime changes: none for the initial repository-scoped list. Call `status --json --cwd <cwd>` by argv, with explicit cwd and a five-second timeout. Validate the known 2.2.0 response and inspect truncation flags before JSON parsing. Catch command-name collisions independently.
- Hosts: all Claude hosts. Return `{ text }` for requested status, so the SDK host can show it. This text enters Claude's context but starts no model turn. T3 picker appearance is not promised.
- Risks/dependencies: declared-name conflicts, Node discovery, a changing job view, incompatible future JSON, and unexpectedly large output. A failure returns a short diagnostic, never an empty-job claim. Depends only on existing companion reads. Keep existing `/relay:status` as the fallback.

### B. Structured report access, M

- User value: inspect the exact report and its attempt without a relay model copying it. Add `/relay-report <job>` with bounded pages; a later pane can use the same contract.
- APIs: `command.run`, `$.process.run`; optional `ui.open`, `ui.render`, `Code`/Markdown elements.
- Runtime changes: a versioned report operation with byte bounds, content digest, attempt identity, continuation offset, and explicit truncation. It must read through the validated view, not reopen a mutable `report.md` after reading metadata.
- Hosts: text on all Claude hosts; inspector pane only on drawing hosts.
- Risks/dependencies: an unbounded `result --json` can exceed process limits; an attempt can change between pages. A digest mismatch restarts the read. Report text is data, never a source of automatic commands. Depends on phase 2's bridge.

### C. Uncollected-result and failure visibility, M

- User value: find completed relay work that nobody collected, failed jobs, and owed messages. This directly addresses the 2.2.0 survey findings.
- APIs: `$.clock.every`, `$.process.run`, `$.state`; `$.ui.log` for supported receivers. An optional `prompt.submit` hook can add a bounded pointer to a known pending result, without starting a turn.
- Runtime changes: expose a collection-status enum derived from the existing handback rules. Keep terminal/non-relay/legacy cases distinct. A missing `handedBackAt` alone does not mean a report was lost.
- Hosts: requested status everywhere; passive terminal/Desktop notices. SDK logs require host support, which inspected T3 does not provide. Defer background T3 notices until that is fixed; do not substitute unsolicited model turns.
- Risks/dependencies: repeated notices across sessions, stale snapshots, and falsely flagging pre-2.2.0 jobs. Dedupe notifications by job, attempt, and outcome, with preferences in the Mod store. Depends on bridge snapshot identities and an actual host receiver.

### D. Direct queue, steer, continue, resume, and cancel, M to L

- User value: deliberate controls reach the intended job without a relay model translating the request. Kimi gets "queue follow-up"; only a backend that supports it gets "steer running turn".
- APIs: registered commands and `$.process.run`; later buttons and inputs. Process requests use stdin JSON, not shell interpolation or shared message files.
- Runtime changes: durable request IDs, payload checks, preconditions, action receipts, and reconciliation. Expose allowed actions and backend meanings from the registry and current job view. Treat cancellation as its own protocol operation.
- Hosts: direct text commands on all Claude hosts when the input reaches the engine; graphical controls on terminal/Desktop. T3 busy-session controls require a host dispatch path before being advertised as immediate.
- Risks/dependencies: duplicated paid turns, cancellation of a newer attempt, and claiming that queued work already ran. Every action must display the target job and attempt and report accepted/pending/executed separately. Depends on phase 3's durable bridge. Never retry with a fresh ID after a timeout.

### E. Job board and compact indicator, M

- User value: inspect several jobs while Claude works. Start with this repository, then an explicit all-repositories view. Display backend, state, attempt, pending work, last coherent refresh, report availability, and collection status.
- APIs: `ui.open`, `ui.render` on `Pane` and `AbovePrompt`, `$.state`, `$.ui.panes`, `$.clock`, and the bridge. Use `$.ui.resolve(e)` for each host's elements.
- Runtime changes: bounded snapshot/detail reads only. Poll visible boards at a modest interval, with one read in flight, and use slower or no refresh when hidden. Rendering reads cached data and performs no process calls.
- Hosts: terminal/Desktop. No T3 pane in the tested SDK architecture.
- Risks/dependencies: stale selection, overlapping refreshes, crowding other Mods, and excessive machine-wide polling. Keep the previous coherent view visibly stale on busy/error; never reinterpret a busy read as a job state. Compose `AbovePrompt` with `next(e)` so other Mods remain visible. Depends on phase 2; action buttons wait for phase 3.

### F. Workflow grouping, M, after the board

- User value: collect jobs from one Workflow run across repositories, including adopted relay identities and reports not handed back.
- APIs: the board's APIs; no new execution events required.
- Runtime changes: expose `status --workflow <run>` through the read bridge. Current code already supports this filter.
- Hosts: text grouping everywhere, visual grouping on terminal/Desktop.
- Risks/dependencies: workflow label strings do not prove observer/fixer/judge roles or disputed findings. Group by stored run ID and provenance. A true review-workflow view requires an explicit workflow schema first. Depends on B/E; reject a second workflow engine inside the Mod.

### G. Setup diagnostics and validated launch preparation, M

- User value: see backend homes, model choices, effective settings, and reasons a backend is unavailable. Later, prepare a validated job request without manually writing a header.
- APIs: command/process APIs; optional `Input`/`Select` controls; store only nonsecret preferences.
- Runtime changes: use the backend registry and setup blocks; add a cheap static capability operation and request-validation operation. Expensive setup probes run on demand, not every board refresh. A form must show the effective permissions and home before launch.
- Hosts: diagnostic text on all Claude hosts, form on terminal/Desktop.
- Risks/dependencies: setup readiness is not proof that credentials will work on the next turn, and model/effort information can be incomplete. Distinguish credentials-present, signed-in, model discovery, and a real turn test. Setup itself launches bounded diagnostic processes but no model turn. Depends on phase 2; actual job launch waits for durable creation idempotency beyond phase 3.

### H. Native message/lifecycle observer, M, experimental

- User value: structured events may reveal messages earlier than the next two-minute relay Bash wait, and provide useful diagnostics even in an SDK host.
- APIs: `session.send`, `session.receive`, `session.append`, `tool.call`, `turn.complete`, and selected `classic.*` events. Initial handlers always pass through with `next(e)`.
- Runtime changes: an optional observation sink in Node, correlated against the existing relay ledger, transcript UUIDs, attempts, and handbacks. Keep the current delivery writer alone authoritative.
- Hosts: all Claude hosts while their process and plugin are alive. No GUI requirement.
- Risks/dependencies: `SessionReceiveInput` contains no durable message UUID; approval-held messages reach the hook before user acceptance; origin names/plugin claims are not authentication. `session.append` has row identity but does not by itself prove a safe mapping to the earlier message or a completed durable delivery. Depends on the bridge and a documented correlation design. Do not consume or forward messages as a second authoritative path.

### I. Disposable background watcher, M, conditional

- User value: avoid repeated whole-store scans when a supported receiver needs continuous updates.
- APIs: `$.process.spawn`, or bounded polling with `$.clock.every`; `next.signal` where appropriate.
- Runtime changes: only add a bounded `bridge watch` after measuring polling costs. Stream framed updates plus resync tokens; reconnect with a complete snapshot after gaps. No daemon or shared database is needed.
- Hosts: process execution works in the host engine, including SDK. The receiver must still be useful there.
- Risks/dependencies: Mod unload, leaving the async iterator, or abort kills the spawned child. Therefore the watched process must be disposable and never be the relay worker. Depends on phase 2 and measurements. Reject always-on watchers in the first PR.

### J. Full hook migration, reject for this release, L

Typed hooks exist, but a migration would add a transport adapter and move correctness-sensitive ordering without improving T3 drawing. Keep each responsibility as follows:

| Current responsibility | Decision and reason |
|---|---|
| `SessionStart` shell environment exports | Keep `scripts/hooks/session-lifecycle.mjs:25`. It writes session ID and transcript path into `CLAUDE_ENV_FILE` idempotently. `session.start` initializes a Mod and re-runs on reload; it is not the same lifecycle. A Mod can observe `classic.SessionStart` for state resets. |
| `PreToolUse` relay guard | Keep `scripts/hooks/relay-guard.mjs:231` and `:349`. It binds commands to the relay's own job, delivers messages first, blocks unrelated calls, and sets wait timeouts. The current matcher also includes `StructuredOutput`, not just Bash/Write/handback. |
| Handback enforcement | Keep `relay-guard.mjs:297`. `SubagentHandback` is a tool matched under `PreToolUse`, not an event named SubagentHandback. Busy views, live work, and owed messages prevent handing back; allowed handbacks get the exact validated result. |
| `SubagentStop` fallback | Keep `relay-guard.mjs:375`. It starts missing jobs, reconciles messages, recognizes a valid prior handback, checks exact final output, and handles Workflow string returns. Preserve the eight-block release and recorded violations. |
| Stop-time review gate | Keep `scripts/hooks/stop-review-gate.mjs:194`. Only a real `BLOCK:` verdict blocks; missing, malformed, timed-out, or failed review allows the stop with a reason. It skips continuation, background work, and active repository jobs. |
| `relay:job` Bash-mediated lifecycle | Keep `agents/job.md:1`. Direct user inspection/control can bypass this agent, but Workflow adoption, slot ownership, exact handback, and recovery still depend on its existing path. |

Current hook registration and budgets are in `hooks/hooks.json:4`, `:15`, `:26`, and `:38`: 5 seconds for SessionStart, 900 for Stop, and 120 for both guard registrations. A Mod's own execution budget is different; API/`next` waits generally do not count toward the documented 10-second hook CPU budget. The process API still has a ten-minute maximum. One 900-second shell-hook budget is not interchangeable with one `process.run` call.

Ordering is part of the contract. Managed PreToolUse hooks run before Mod `tool.call`; ordinary/plugin PreToolUse hooks run under the final `next`. A Mod that returns a tool result without `next` can bypass the existing relay guard. `classic.PreToolUse` receives the flattened tool envelope, unlike ordinary classic stdin JSON, and cannot simply accept the existing handler unchanged. `tool.call` adds `agentId`; the classic envelope does not promise the guard's full `agent_id`, `agent_type`, and transcript input. See the [ordering and failure rules](https://code.claude.com/docs/en/plugins/mods/events#where-settings-hooks-run-in-the-order) and the installed declarations cited above.

Relay already deliberately fails open on a thrown guard error at `relay-guard.mjs:469`, and releases repeated blocks at `:177`. A failed Mod handler is skipped by default; even a `.catch` refusal has its own failure limit. Preserve the existing behavior, including its limits. Do not describe either implementation as an unconditional fail-closed security boundary. The Stop gate's explicit review failure handling is at `stop-review-gate.mjs:104` and `:153`.

### K. Native external-agent replacement and Mod model helpers, reject, L

`$.agent.register/spawn` creates Claude-side agents; `$.model.complete/fork` does not run an independent tool-using Codex/Grok/Kimi harness. A registered Mod tool could call relay's bridge directly for a simpler job, but durable completion delivery and Workflow compatibility remain unsolved. This overlaps T3's own delegates for plain fan-out. Keep it outside this release instead of making a second delegation product. The [API guide](https://code.claude.com/docs/en/plugins/mods/api#call-a-model) confirms the model-helper restrictions.

### L. Machine-wide cross-harness history, defer, L

There is useful value in a separate historical browser, but it needs discovery, redaction, checkpoints, retention, and its own query API. Mods only observe their loaded Claude process. The existing companion already lists all relay jobs, so no agent-harness-kit integration is needed for A-F.

If this becomes a requested product, keep the kit in Node. Its checkout remains at `061408df6623f8c6716de3ee9266d7e55018bd7c`; [README.md](/Users/darkomijic/dev-libar/libar-agent-harness-kit/README.md:16) and [tail-session.md](/Users/darkomijic/dev-libar/libar-agent-harness-kit/docs/internal/tail-session.md:260) document redaction, cross-harness adapters, per-source checkpoints, and manual commit. The [current SDK sessions docs](https://code.claude.com/docs/en/agent-sdk/sessions) also provide session enumeration and historical reads. Historical access alone is not a reason to add the kit. Its replay and cross-harness guarantees are.

## 4. Phased plan and acceptance criteria

### Phase 1, one small PR: `/relay-jobs`

Add one hooks module through `hooks/hooks.json`'s `modules` key while retaining its existing `hooks` object. Register one global, valid Mod command name, `relay-jobs`, with `immediate: true`. Use the existing repository-scoped status JSON and a strict minimum decoder. Return requested text. Include version requirements and fallback instructions. No timer, pane, settings editor, or mutation path belongs in this PR.

Acceptance:

- Terminal and actual Agent SDK calls produce the same status interpretation with zero model API calls.
- A live Claude-backed T3 thread can execute the exact typed command and show its text. If this fails, the PR's T3 claim is blocked; existing `/relay:status` remains available. Picker discovery is a separate issue.
- Busy view, invalid JSON, a missing Node executable, timeout, and either stream's truncation flag yield explicit diagnostics. None becomes "no jobs".
- Opening or reloading the Mod changes no job files. Disabling Mods leaves all existing relay commands and hooks functional.
- Mod tests and plugin validation pass on 2.1.307; existing command/hook packaging checks stay green.

### Phase 2: bounded read bridge and report access

Add protocol v1, bounded snapshot/detail/report operations, canonical backend identity, collection status, and static capabilities. Add `/relay-report`; then enrich `/relay-jobs` to use the bridge. Preserve all legacy CLI JSON and exit behavior.

Acceptance:

- Tests cover more than 4 MiB of aggregate job/report data without producing a process response above the bridge's chosen maximum, proposed 512 KiB.
- Paging is bounded and explicitly consistent per job/report, with a resync signal if an attempt changes. No claim of an atomic machine-wide snapshot.
- A busy job can be shown as a retryable item alongside other coherent rows; it is never silently omitted. Existing legacy all-or-nothing busy behavior remains unchanged.
- Archived/current report races, pre-2.2.0 collection history, and default-backend records render correctly.
- Capability reads do not start setup servers; full setup is on demand.

### Phase 3: durable action contract, then direct text controls

Implement action IDs, receipt lookup, payload-conflict detection, target preconditions, and short acceptance replies. Add explicit Mod commands for queue/steer/continue/resume/cancel only after these invariants pass. Defer new-job launch until creation idempotency is separately implemented.

Acceptance:

- Sequential and concurrent replay of the same ID cannot enqueue a second message or cancellation; reusing an ID for different content returns conflict.
- Kill the bridge after persistence/enqueue but before stdout. Reconcile by the original ID and report pending or the recorded outcome. Never resend under a fresh ID.
- Enforce expected attempt/action eligibility at the point of execution. A pre-read in the Mod is insufficient. A cancel of an outdated target cannot silently kill a newly resumed attempt.
- Reload/clear the Mod between acceptance and acknowledgement; the companion still owns a queryable outcome.
- Kimi queueing, true steering where available, owed work after recovery, completed-job cancellation, and backend failures retain existing semantics.
- Do not claim T3 controls run while busy until a live host dispatch check proves it.

### Phase 4: terminal/Desktop board, then workflow/setup views

Build the board from the read bridge. Add controls from phase 3, a compact opt-in indicator, workflow grouping, and setup diagnostics. Ship each as a separate feature rather than one UI rewrite.

Acceptance:

- Check narrow/wide terminal layouts and a real Desktop local Code session, not only simulated element trees.
- `clear`, `resume`, `branch`, hot reload, and session end reset/rebuild only presentation state. The same detached worker continues.
- Unreadable/busy snapshots show the last coherent data with a timestamp and stale reason.
- Selected job/attempt identities stay stable across sorting and refresh. Unsupported actions stay unavailable with the backend's reason.
- Multiple Claude sessions can open the view without racing on durable relay state or overwriting shared preference documents.
- An SDK run opens no pane, starts no status-only model turn, and retains the text commands.

### Phase 5: optional observation experiment

Record structured message and lifecycle observations beside the existing relay evidence. Measure message latency and correspondence under approval, interruption, clear/resume, adoption, and reload. Do not remove a hook in this phase.

Acceptance:

- Demonstrate a durable identity mapping or explicitly record that it is unavailable. Equal text/time is not sufficient identity.
- One delivery writer remains in use, with no duplicate backend work.
- If a host rejects inbound messaging or a user stops the session, the observer does not synthesize permission or restart work.
- Promotion of any responsibility needs a separate parity proposal supported by replay/crash results. A failed experiment can be removed without changing the worker or job records.

## 5. Companion bridge and contract changes

### Current behavior verified in 2.2.0

I ran the three permitted read commands. Evidence is saved as `evidence/status-all.json`, `result.json`, `setup.json`, and `metadata.json`.

| Command | Actual output and behavior | Consequence |
|---|---|---|
| `status --json --all` | `{ jobsHome, repoSlug, jobs }`; 473 jobs, 1,290,527 bytes in this snapshot. Per-job objects include computed/stored state, attempt records, report path, provenance, server details, violations, handedBackAt, undelivered and dropped messages. No protocol/version envelope. | Fine for research, poor as a fixed-interval UI protocol. Default repository status limits to 20; `--all` does not. |
| `result <job> --json` | A job-view object plus `report`, inline in full, or null. The sampled completed report was 2,389 bytes and exited 0. | Not the shape of the list envelope. Report size is unbounded by this CLI. Nonzero exit does not automatically mean malformed JSON. |
| `setup --json` | `{ ready, jobsHome, settings, backends, actionsTaken, nextSteps }`; five home blocks here, 9,319 bytes. Blocks include backend/home, binary/version, sign-in, model/effort/model list, `can`, warnings, ready/error and timing. `actionsTaken` was empty. | Useful on demand. `ready` in the overview means at least one home is ready, not every backend, and not a completed real-turn test. |

The relevant implementations are:

- `scripts/companion.mjs:60` dispatches operations; `:113` catches errors, writes human stderr, and maps busy to exit 4. Even under `--json`, error output is not a guaranteed JSON envelope.
- `scripts/cli/status.mjs:12` emits result; `:24` emits status; `:42` limits normal lists; `:49` propagates busy views; `:59` constructs the list envelope.
- `scripts/lib/jobs/view.mjs:48` constructs coherent job views and `:88` retries busy reads. `:119` maps result exits to 0/3/4/5. Status for a single coherent job returns normally even if that job failed; it is not the same exit protocol as result.
- `scripts/lib/jobs/view.mjs:350` builds JSON. `:189` omits the default backend field; the new protocol must normalize it through the registry. `:305` and `:312` implement known handback status, including legacy history.
- `scripts/cli/setup.mjs:36` handles setup, `:54` applies switches, and `:72` emits a page. Setup with no switches was read-only configuration-wise. `scripts/lib/setup/page.mjs:89` constructs the page; `:15` defines command/server deadlines.
- `scripts/cli/message.mjs:41` and `:61` accept steer/continue/resume JSON outputs, but provide no caller request-ID option. Busy after a successful send yields `state: null`, not a failed send. `scripts/lib/worker/delivery.mjs:87` defaults acknowledgement waits to 60 seconds.

### Proposed contract

Keep `companion.mjs` as a dispatcher. Add a `bridge` case and a module such as `scripts/cli/bridge.mjs`; put reusable logic below `cli` following `docs/architecture.md:24`. Do not put execution rules in the Mod.

Use `$.process.run(['node', companionPath, 'bridge'], { cwd, stdin: JSON.stringify(request), timeoutMs })`. Resolve the companion under `$.plugin.root`. The Node executable must be configurable/discoverable for GUI-launched hosts. Set cwd explicitly and resolve relative job-home configuration consistently. No shell expansion, no rendered labels as selectors, and no direct Mod reads/writes of execution files.

A request names `protocol`, `protocolVersion`, `requestId`, `operation`, scope/cwd, and operation input. Every response, including error/busy/conflict, names the same protocol/version/ID, relay version, response status, and either data or a structured error. Publish a schema and protocol support range. These are proposed names, not current companion fields.

Read operations:

1. `capabilities`: cheap backend declarations, supported bridge operations, limits, and settings scope. Obtain backend facts from `lib/backends/index.mjs:1` and `types.d.ts:47`, not from a second Mod registry.
2. `snapshot`: bounded summary rows and cursor, filtering by repository/workflow/all. Bound record sizes as well as row count. Return generated time and per-item identity/revision; a list across jobs is not one transaction.
3. `job`: detail with allowed actions, authoritative/backend state distinctions, pending work, attempt identity, and collection status. Keep unavailable collection history distinct from not-collected.
4. `report`: bounded UTF-8 chunks tied to an immutable captured report identity/digest, with attempt, total bytes, next offset, and a changed-report error. Never trust a mutable file path as the identity.
5. `request`: read an action's durable receipt and current outcome without executing it again.

Action operations:

- Require the ID before any side effect. Persist a per-job command receipt with a normalized payload hash and chosen inbox message ID under a concurrency-safe lock. Same ID/same payload returns the receipt; different payload conflicts.
- Reuse the existing message/outcome machinery. `lib/jobs/messages.mjs:17` can accept an explicit ID, `:63` writes outcomes, and `:83` checks all message locations. It does not alone make concurrent reposting idempotent. The relay's own locked posting at `lib/harness/relay.mjs:577` and `:638` shows the stronger pattern to retain.
- Return durable acceptance quickly; do not spend the Mod's 30-second default waiting for a 60-second acknowledgement. Lookup distinguishes accepted, worker-acknowledged, queued-next-turn, executed, dropped, failed, and unresolved.
- Carry `expectedAttempt` or an equivalent revision where an action is attempt-specific. Enforce the precondition in the worker/lease path, not only in a prior status read. Cancellation uses `cli/cancel.mjs:128` and its identity-aware process path; it must not be implemented as a Mod `kill` command.
- After process timeout, rejection, malformed/truncated output, or Mod reload, query by the same ID. Absence/unknown is not proof that an operation never started. Repeating the same ID is safe only after durable deduplication covers every crash window.
- New job launch requires a separate durable request-to-job mapping before spawning. Do not infer creation idempotency from message IDs or Workflow adoption keys. This is deferred until that mapping and its crash tests exist.

Preserve the current human CLI and JSON contracts. Add the bridge rather than silently wrapping every existing JSON result. The worker remains the owner of `job.json` while leased; the Mod store is not an action ledger. `$.store` belongs to the plugin across sessions and its read-modify-write sequences are not atomic. Prefer independent preference keys and keep execution coordination in Node. `$.state`'s version checks help reject stale UI updates inside one session; they do not replace durable command coordination.

## 6. Test strategy

### Mod test kit

Use `claude plugin validate` and `claude plugin test` against the installed version, with generated declarations excluded from hand maintenance. The scratch run already passed two tests; production tests need the behavior below. The [test guide](https://code.claude.com/docs/en/plugins/mods/test) explains explicit event startup, mocks, and the need to assert effects when failed hooks can be skipped.

- Stub command registration and fire `session.start` explicitly. Assert command names and `immediate`, then assert actual reply text and process argv/cwd/stdin. A test that only finishes is insufficient.
- Stub process results for success, valid nonzero status results, busy exit 4 without JSON, malformed JSON, incompatible protocol, thrown timeout, and both truncation flags.
- Use `mock.clock` for polling. Verify only one read is in flight and a slow earlier read cannot overwrite a newer view. Test background process disposal independently of worker lifetime.
- Use store mocks and real test-kit state for reload/reset behavior; separately fire `classic.SessionStart` with clear/resume/fork. Assert command registration is not incorrectly repeated on those transitions.
- Mount Pane/AbovePrompt on terminal/Desktop and press/select/input by stable keys. Assert unsupported actions, stale status, paging, close/reopen, and selection after reordered data. Simulated trees do not verify real painting.
- For observation hooks, assert `next` receives the unchanged event and its result stays unchanged. Test refusal, held approval, subagent targeting, duplicate observations, and absence of durable message identity.

### Existing Node tests and bridge additions

Keep the existing suite authoritative for execution behavior. Relevant files are `tests/busy-view.test.mjs`, `report-archive.test.mjs`, `backend-views.test.mjs`, `message-account.test.mjs`, `relay-delivery.test.mjs`, `relay-guard.test.mjs`, `recovery.test.mjs`, `runtime-timers.test.mjs`, `process.test.mjs`, `setup-page.test.mjs`, `commands.test.mjs`, and `stop-review-gate.test.mjs`.

Add protocol tests using isolated scratch roots and fakes for pagination bounds, schema compatibility, collection-history semantics, same-ID conflicts, concurrent callers, and kills at each receipt/enqueue/ack/stdout boundary. Reuse the existing fake backends for Kimi queueing versus true steering and exact report/attempt races. Do not weaken existing guard checks merely to accommodate a Mod.

For implementation PRs, run `npm run check`, targeted Node tests, Mod validation/tests, then the normal full suite when execution code changes. This research did not run the relay job suites or change implementation code; it ran only the isolated Mod experiments, Mod tests, and permitted read-only companion commands.

### Live acceptance

Use throwaway jobs only in an explicitly authorized implementation-validation session. Check the configured Claude binary/home in each target host, because Desktop and remote T3 hosts can differ.

Exercise terminal, real Desktop, and a real Claude-backed T3 thread. Record zero-turn status/report command output, Mod load/discovery, SDK `ui_log` handling, busy-command queue behavior, and survival of jobs across Mod reload/clear/close. For mutations, explicitly test lost replies and recovery, stale-attempt cancellation, Kimi follow-ups, relay adoption, and exact handback. A T3-native change should add `ui_log` mapping and dynamic command updates without treating ordinary notices as model prompts.

## 7. Corrections to the preliminary research

1. **The broad host matrix is confirmed, but "no interactive drawing" is incomplete as a product decision.** The SDK can run commands without a model turn and receives `ui_log`. T3 must handle that event before it becomes visible. A UI-first terminal plan does not match this user's main host.
2. **An installed Mod can work headlessly; a Mod newly authored inside an unattended session may not load.** The [creation guide](https://code.claude.com/docs/en/plugins/mods/create#sessions-that-skip-the-approval) distinguishes explicit installed/local plugin loading from session-authored Mods that need approval. The scratch plugin used explicit `--plugin-dir`/SDK local-plugin loading.
3. **The proposed job-board-first sequence should change.** Lead with one deterministic status command, then a bounded bridge. The current `--all` call already returns about 1.29 MB for 473 jobs; report and list growth can hit the verified 4 MiB process cap.
4. **The old declarations are superseded.** This investigation generated 2.1.307 declarations. `classic.PreToolUse` still has the exceptional flattened envelope, and its result remains `allow`/`ask`/`deny` plus updated input/context. Other classic results use normalized fields. The public events guide's blanket stdin-shape wording should not override these types.
5. **The static-analysis restriction was slightly overstated.** Current [creation docs](https://code.claude.com/docs/en/plugins/mods/create#check-what-claude-code-reads-from-your-mod) permit passing `$` to a top-level helper in the same file. Imported helpers/methods and namespace aliasing remain restricted. Literal event registrations are still required.
6. **The runtime limits are confirmed and need two additions.** `process.run` also caps each output stream and reports truncation explicitly. `process.spawn` exists for streaming and ends its child with the iterator/module lifecycle. Neither should own a detached relay job. The Mod itself still has no Node APIs, npm imports, or timer globals; host access goes through `$`. Store/state limits and reset behavior remain relevant; `$.state.set` also has version preconditions.
7. **Current relay metadata is richer than the preliminary plan.** 2.2.0 adds `handedBackAt`, per-attempt `relayVersion`, Workflow filtering, more reliable missing-start recovery, and an eight-block-budget fix. Use these facts before inventing new history machinery. Collection history is unknown for old attempts.
8. **The current guard includes `StructuredOutput`.** Preserve its Workflow schema refusal, exact/state-only handback behavior, lazy start, job binding, and recorded violations. Typed hooks are not a drop-in replacement for this logic or its input fields.
9. **The timeout/idempotency warning is confirmed experimentally.** A process timed out after its side effect. CLI message JSON still lacks caller-controlled request IDs, although internal relay delivery already chooses durable IDs under a lock. Expose that discipline before adding retryable controls.
10. **Backend-specific controls and setup caveats are confirmed.** Kimi cannot steer over ACP; setup's `can` objects are available today. Setup overview readiness is existential and does not verify a real turn. An automatic live "health check" would be new paid work, not a harmless setup refresh.
11. **Machine-wide observation and the kit remain separate concerns.** User-scope installation does not collect every process. The kit's checked commit still has the documented redaction/checkpoint/cross-harness facilities; SDK session enumeration/history is also current. Neither is required for a relay job board.
12. **The sample choices are confirmed, but their role is limited.** The official [playground README](https://github.com/anthropics/claude-code-playground/blob/main/claude-code/mods/README.md) lists `token-weather`, `blast-radius`, and `replay-theater`. They are UI patterns, not proof of relay parity, T3 rendering, or durable action handling.

The preliminary architecture boundary is sound: relay owns execution, an optional Node history component owns ingestion, and the Mod owns presentation and deliberate interaction. What changes is the order of investment and the specificity of the compatibility claim.

## 8. Open questions only the user can answer

- Which T3 Claude provider profiles and remote machines need support, and how much of your relay use is in Claude-backed threads versus other providers? A Mod cannot extend the latter.
- Is a small T3 change to display `ui_log`, refresh Mod commands, and route busy-session commands in scope, or must relay work with T3 unchanged? Without it, I would ship requested text commands and defer passive T3 notices.
- Which direct actions should be allowed by default, and should cancellation require a second explicit confirmation or one fully specified command? These are product choices after the durable contract is implemented.
- Should uncollected reports appear only when requested, as passive notices, or as a bounded pointer in the next prompt's context? I recommend requested text first and no automatic model turn.
- Is cross-repository visibility desired by default, or should every session begin scoped to its repository? I recommend repository scope with an explicit all-repositories action.
