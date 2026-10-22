# Relay × Claude Code Mods: implementation plan (Opus 5.5)

Repository: `relay-plugin-cc` main @ f1283c9 (relay 2.2.0). Claude Code 2.1.307. Agent SDK 0.3.276 as T3 Code runs it.
Experiments: `/tmp/relay-mods-claude-opus-5-5/` (probe Mod `probe/`, a relay copy with a module `relaycopy/`,
stream-json transcripts `out/exp1..5.jsonl`, the probe's own log `out/probe-log.jsonl`, the classic-hook log
`out/classic-hooks.jsonl`, stdin feeders in `scripts/`).

Labels: **[V]** verified by experiment or by reading the code or declarations, with a citation. **[D]** stated by the
official docs. **[I]** inferred.

---

## 1. Verdict

1. In T3 Code, where you do most of your work, a Mod can draw nothing. Its hooks and slash commands run. Its status line,
   toasts, log lines and panes go to T3 as `system` messages, and T3 has no code for them **[V]**. A plan that starts
   with the UI gets you nothing until you open a terminal.
2. The one feature that needs a Mod and pays off in T3: answer `/relay:status`, `/relay:result` and `/relay:cancel`
   inside the module. That costs no model turn and no tokens, and the report is never retyped by a model **[V]**. The
   markdown commands stay as the fallback.
3. The biggest win of this investigation is not a Mod. A classic `PostToolUse` hook on `SendMessage` sees a steer the
   moment it is sent **[V]**. It can end the relay's 120-second `wait` early, so a steer reaches the job in about
   2 seconds instead of up to 2 minutes. This works on every surface and on every Claude Code version relay supports.
4. Keep the guard, the hand-back, the stop gate and the session export as command hooks. A Mod would sit above them in
   the chain, be skipped when it fails, and rest on an API marked early access **[V]**.
5. Build a terminal or Desktop board only if you will open it. Before any board, make the companion's JSON a versioned,
   slim and idempotent bridge.

---

## 2. Surface matrix (Q1)

**How T3 runs Claude Code [V]:** `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio …`,
`CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION=0.3.276`. I read this from this session's own process (`ps`) and
environment. The installed relay plugin loads there: its `SessionStart` hook exported `RELAY_COMPANION_TRANSCRIPT_PATH`
into this session. So a module shipped in the relay plugin would load in T3 too, with no `CLAUDE_CODE_PLUGIN_DIRS`.

| Capability | Terminal REPL | Desktop Code tab | SDK host / T3 Code (stream-json) | `claude -p` |
|---|---|---|---|---|
| Events: `tool.call`, `agent.spawn`, `session.send`/`receive`, `turn.complete`, `classic.*` | yes [D] | yes [D] | **yes [V]** exp2–5: all fired | yes [V] exp1 |
| `session.start` input | `surface: "terminal"`, interactive | remote surface [D] | **`surface: null`, `isInteractive: false`, `surfaces() = []` [V]** | same [V] |
| `$.command.register` + a `command.run` answer | yes [D] | yes [D] | **yes [V]**: listed in the SDK `initialize` response's `commands` and in init `slash_commands`. The answer arrives as an assistant message with `model: "<synthetic>"`; `num_turns: 0`, `total_cost_usd: 0` (exp1, exp2) | yes [V] |
| Hook a plugin's own markdown command (e.g. `relay:status`) and answer it | yes [I] | yes [I] | yes [I]: the same dispatch as in `-p` | **yes [V]**: `relaycopy:status` answered, `num_turns 0`, cost 0 |
| Does T3 show that synthetic message? | — | — | **likely [I]**: T3 reads `/goal` output from `<synthetic>` assistant messages and leaves them out only of usage and model tracking (bundle grep around the `<synthetic>` sites). Confirm live in Phase 2 | prints it [V] |
| `immediate: true` (runs mid-turn) | yes [D] | not checked | **no [V]**: exp4 sent `/probe-imm` 9 s into a 20 s turn; it ran at `turn.complete`, like a plain command | n/a |
| `{}` answer (nothing in the transcript) | yes [D] | yes [D] | yes [V]: result `""`, no synthetic message (exp3) | yes |
| `$.ui.log` | dim transcript row [D] | yes [D] | emitted as `{"type":"system","subtype":"ui_log"}` [V]. **T3 shows nothing [I]**: the bundle holds no `ui_log` string, and T3 handles system subtypes one by one (`compact_boundary`, `status`, …) | same as SDK |
| `$.ui.status`, `$.ui.toast` | yes [D] | yes [D] | emitted as `system/ui_status` and `system/ui_toast` [V]; **T3 has no handler [I]** | same |
| Panes `$.ui.open` | drawn [D] | drawn [D] | **`{isPlaced:false, reason:"no-surface: no surface is attached"}` [V]**, plus `system/ui_panes` | same [V] |
| Band `AbovePrompt`, redrawn engine components | yes [D] | yes, except terminal-only elements [D] | nothing draws [D] | no |
| `$.ui.notify` | yes [D] | `no-surface` (d.ts 15021: "no terminal (a -p run, the SDK, the desktop)") | **`{isSent:false, reason:"no-surface"}` [V]** | same [V] |
| `$.ui.ask` | yes [D] | yes [I] | not checked; rejects under `-p` per the d.ts | rejects [D] |
| `$.prompt.read` / `fill` / `suggest` | yes | yes | **`read` → `{text:"",cursor:0}` [V]**; `fill`/`suggest` → not shown (d.ts 3066–3067, 3076) | same |
| `$.ui.view` | yes | yes | denied: "draws no main view" (reference.md "Work that outlives a dispatch") | denied |
| `$.session.send` | yes | yes | **yes [V]**: the `session.send` hook fired at send time, `isDelivered:true` | yes |
| `$.process.run` | yes | yes | **yes [V]**: `node -v`, and `companion status --json` from `$.plugin.root` (relaycopy) | yes [V] |
| `$.store` / `$.state` | yes | yes | `$.store` **yes [V]**; `$.state` held by the host, no surface needed [I] | yes |

**What that means for you:** in T3, a Mod gives you event hooks, commands answered between turns, and background calls
to `$.process.run`. It shows nothing on its own. Everything it shows has to come back as a slash command's answer. A host
could render `ui_status`, `ui_toast` and `ui_log`; T3 doesn't today. A small T3 change, rendering `system/ui_status` as a
chip and `ui_log` as a dim row, would make a terminal-style status line visible in T3. That's the cheapest route to any
UI there (open question 4).

**The timing that matters for steering [V]** (exp3, exp5: a background subagent blocked in a 25-second Bash call):

```
t=0          SendMessage tool call
t=+6 ms      Mod session.send        (to = agent id, isDelivered: true)
t=+51 ms     classic PostToolUse SendMessage  (tool_input.to = agent id)
t=+25.9 s    Mod session.receive (agentId = the subagent), only when its tool call returned
```

The receiving side only sees a message at the agent's next tool round. The `SendMessage` result says so itself: "queued
for delivery … at its next tool round". So nothing on the relay agent's side can shorten its 120-second `wait`. The
sending side can, and a classic hook sees it as early as a Mod does.

---

## 3. Feature catalogue

Size: S ≤ 1 day, M ≤ 3 days, L more.

### F1. Steer wake (classic hook, not a Mod). **Build first.**
- **Value:** a `SendMessage` to a running `relay:job` agent reaches the job within about 2 s instead of 0–120 s (design.md
  "Two-minute waits, never trapped"). This is the steer latency the lead feels in every review loop.
- **Mechanism:** a `PostToolUse` matcher `SendMessage` in `hooks.json`, running a new `scripts/hooks/relay-wake.mjs`.
  If `tool_input.to` names a relay pointer (`readRelayPointer`, `lib/harness/relay.mjs:292`; `findRelayJob`,
  `relay.mjs:312`) whose job is not terminal, it writes `<jobDir>/relay-wake.json` (`{at}`). The relay `wait` polls it:
  `wait.mjs:41-54` already polls once a second. When the file's mtime is later than the wait's own start, and only under
  `--exit-zero-while-running`, the wait leaves with the "still running" line (`wait.mjs:62-68`). The relay runs `wait`
  again; that tool round ends, the queued message is attached, and the guard delivers it at the next `PreToolUse`, the
  same path the 120-second timeout takes today.
- **Mod APIs:** none. A Mod's `session.send` would be equivalent but needs Claude Code ≥ 2.1.287 and an early-access API.
- **Surfaces:** all. It's a command hook.
- **Risks:** `to` given as a name rather than an agent id isn't resolved; relay agents are addressed by id in practice
  (open question 5). A stale marker can't hurt: the guard still decides what is delivered. It is never worse than today:
  if the hook fails, the 120 s timeout remains. The hook must fail open: exit 0 and a 5 s timeout.
- **Size:** S. **Depends on:** nothing.

### F2. Zero-turn `/relay:status`, `/relay:result`, `/relay:cancel` (the first Mod). **Build second.**
- **Value:** in T3 and the terminal, these commands answer in about 0.3 s with no model turn and no tokens. The report is
  shown verbatim, so a model never retypes it. Today `commands/result.md` asks the model to "present the full command
  output … do not summarize", which costs a turn and risks drift.
- **Mod APIs:** `on('command.run', { command: 'relay:status' }, …)` and the same for `relay:result` and `relay:cancel`.
  Each runs `$.process.run(['node', $.plugin.root + '/scripts/companion.mjs', <sub>, '--format', 'markdown', e.args])`
  and returns `{ text }`. Each registration has `.catch(($, e, next) => next(e))`: when the module throws, the markdown
  command runs as it does today. Verified: a module in relay's own `hooks.json` (beside `"hooks"`) validates, loads, and
  answers the plugin's markdown command with `num_turns 0` (relaycopy).
- **Companion changes:** `--format markdown` for `status` (the table `commands/status.md` asks the model to build: id,
  state, kind, model/effort, duration, summary, relay) and for `result` (the state block in a ```text fence, then the
  report as it is). The format lives in the companion, so `node --test` covers it and the module stays a pipe.
- **Surfaces:** terminal, Desktop, T3/SDK (between turns), `-p`.
- **Risks:** the early-access API changes; the module must stay small and fail open. The command's text goes to the
  model on the next turn, as the Bash output does today. In T3 the command waits for the turn to end [V]. `/relay:setup`
  stays model-mediated: it asks questions and installs packages.
- **Size:** S–M. **Depends on:** nothing. Ship F3 (a) and (b) with it or before it.

### F3. Bridge contract hardening (companion). **Build alongside F2, needed before F5.**
See §5. **Size:** M.

### F4. Header pre-check for `relay:job` (classic hook). Optional.
- **Value:** a malformed header (unknown key, missing `model:`/`effort:`) fails at the `Agent` call with the parser's
  message, instead of spinning up a Haiku relay that fails `start` and hands back an error.
- **Mechanism:** `PreToolUse` matcher `Agent` with `subagent_type == "relay:job"`. Run `parseHeaderPrompt`
  (`lib/jobs/request.mjs:29`) and `buildLaunchRequest` (`request.mjs:123`) on `tool_input.prompt` without creating a job,
  and deny with the `UsageError` message. Verified: `PreToolUse` on `Agent` receives the full prompt and `subagent_type`
  (exp5).
- **Mod alternative:** `agent.spawn` also covers a Workflow script's `agent()` (a deny is the error `agent()` throws, d.ts
  `AgentSpawnInput.workflow`). Defer it until a Mod is in place anyway.
- **Size:** S. **Risk:** the check must use the exact parser `start` uses, so it can never refuse a header that `start`
  would accept.

### F5. Terminal and Desktop presence: status line and job board. Deferred.
- **Value:** "2 running · 1 owed" under the prompt (`$.ui.status`), and a `/relay-board` pane listing jobs, the selected
  job's report in a `Markdown` element, and a Cancel button that asks again at the moment of action. Only on surfaces
  that draw.
- **Mod APIs:** `$.ui.status`, `$.ui.open`, a `ui.render` hook on `Pane`, `$.state` atoms, `$.clock.every`,
  `$.process.run`, `$.command.register` (with `immediate`, which works in the terminal).
- **Rule:** poll only when `(await $.session.surfaces()).length > 0`, so a T3 session never spawns a process every 15 s
  for output nobody sees.
- **Depends on:** F3 (slim listing, versioned JSON, busy as JSON). **Size:** M for the status line and a read-only board.
  Steer/continue buttons add M and need F3's message ids.

### F6. Shadow observation of Mod events. Experiment.
- **(a)** A `session.receive` hook for relay agents writes `{agentId, origin, sha256(text), t}` to
  `relay-shadow.jsonl`. Compare it with `inbox/relay/` to measure whether Mod events could replace the transcript reads
  in `lib/harness/` (design.md "What the relay reads from Claude Code").
- **(b)** An `agent.spawn` hook with `subagentType: "relay:job"` records `workflow.runId` and `workflow.agentIndex` with
  the spawned `agentId`. That is a second adoption key for when the Workflow journal keeps no `journal.jsonl`
  (design.md "The Claude Code dependency"). Caveat from the d.ts: "a stalled agent's retry is not raised again", so it
  covers resumes, not retries.
- **Promote only** after weeks with zero divergence. **Size:** M.

### Rejected
| Idea | Why not |
|---|---|
| Move the relay guard (PreToolUse incl. `SubagentHandback`, SubagentStop) into a Mod | The chain is `[managed settings hooks, ...hooks modules, the other settings hooks as core]` (d.ts 1280-1283): a Mod sits **above** the guard, and a Mod that answers without `next` skips it. A failed Mod hook is skipped (reference.md, "Developing one"), so the Mod is no safer than today's fail-open exit 0 (`relay-guard.mjs:469-472`). The guard's work (locks, fs, transcript) needs Node and would still be a process per call. |
| Stop review gate in a Mod | It runs up to 900 s of Codex. It already works in T3 as a command hook. A Mod adds an unknown hook budget and nothing else. Its known limit, not knowing which edits the turn made (design.md "The stop-time review gate"), is fixed better by a classic `UserPromptSubmit` snapshot (`git stash create`) than by a Mod. |
| SessionStart export in a Mod | `CLAUDE_ENV_FILE` handling is a settings-hook contract, and the E2BIG lesson (design.md) lives there. Nothing to gain. |
| Replace the `relay:job` Haiku agent with a Mod tool or `$.agent.register` | The agent exists for a background run, a completion notice, `SendMessage` and a Workflow slot (design.md "Why each layer exists"). A registered agent type is still a Claude agent. |
| `immediate` commands as a T3 feature | Over stream-json they wait for the turn [V, exp4]. |
| "Direct controls" board as the first release (research §2B) | Invisible in T3. Without F3 it would also need retry reconciliation the companion can't support yet. |
| Config form (backend, home, model, effort) | Terminal-only. `/relay:setup` exists. The setup page already exposes `can`/`models` in JSON. |
| `$.tool.register` status tool for the model | The model already calls the companion through Bash. One more deferred tool for little gain. |
| `$.model.*` report summaries | Reports are verbatim by design. It costs tokens. |
| A watcher that notifies on job completion | Relay-launched jobs already notify through the agent's completion notice; `--background` reviews notify through the Bash task. And in T3, `$.ui.notify` and `toast` show nothing. |

---

## 4. Phased plan

### Phase 1: steer wake (one PR, no Mod)
Changes: `hooks/hooks.json` (add `PostToolUse` → `SendMessage`, timeout 5), new `scripts/hooks/relay-wake.mjs`,
`cli/wait.mjs` (watch the marker only under `--exit-zero-while-running`), `lib/jobs/store.mjs:93` `jobPaths` (marker path),
design.md "Two-minute waits" plus the README line "within about two minutes" (agents/job.md description, design.md
interface table), and the CHANGELOG.

Acceptance:
- Unit: a hook input with `tool_input.to` naming a relay pointer of a running job writes the marker. An unknown `to`, a
  terminal job, malformed JSON or a missing jobs home write nothing and exit 0.
- Unit: a `wait --exit-zero-while-running --timeout-seconds 120` on a running fake job returns within 2 s of a newer
  marker, prints `still running: …`, exits 0. A marker older than the wait's start is ignored. A direct `wait` without
  the flag ignores markers.
- E2E (`tests/relay-e2e.test.mjs` style, fake backend): the steer is delivered and run once, with no
  `relay-violation:` line.
- Live (T3 and terminal): steer a running Codex `relay:job`. The time from the `SendMessage` call to the
  `inbox/relay/<uuid>.json` record is under 10 s, three runs out of three. After hand-back, a message still continues
  as before.

### Phase 2: the first Mod, zero-turn commands (one PR)
Changes: `hooks/hooks.json` adds `"modules": ["./mod/register.js"]`; new `hooks/mod/register.js` (JS with JSDoc
`import('claude-code').Register`, no build), `hooks/mod/*.test.ts`; companion `--format markdown` for `status` and
`result`; F3 (a) and (b); README "Requirements: Claude Code 2.1.307 for the module; older builds use the markdown
commands"; design.md replaces "The relay needs no Claude Code mod" with what the module does and its fallback.

Acceptance:
- `claude plugin validate plugins/relay` passes. The `hooks:` line lists exactly three `command.run` matchers, each with
  `.catch`. No hook on `tool.call`, `classic.PreToolUse` or `classic.SubagentStop`.
- `claude plugin test plugins/relay` passes on `terminal` and `desktop` mounts where relevant: each command answers from
  a stubbed `process.run` (`{ value: … }`, verified working in `relaycopy/hooks/mod/status.test.ts`). A throwing stub
  falls through to `next` (the test's own `command.run` answers "fallback").
- `node --test`: `--format markdown` golden tests for a list, an empty list, a busy job, a report with a fence in it.
- Live, `claude -p "/relay:status" --output-format stream-json`: `num_turns: 0`, `total_cost_usd: 0`.
- Live in T3: `/relay:result <job>` shows the state block and the report in the thread with no model reply under it. If
  T3 does not show the synthetic message, stop and record that in design.md; the markdown fallback stays the T3 path.

### Phase 3: bridge for a board (one PR, companion only)
F3 (c)–(f) from §5. Acceptance in §6.

### Phase 4: terminal/Desktop status line, then a read-only board (only if you want it, question 1)
Acceptance: no `$.process.run` in a session whose `surfaces()` is empty (test: mount with no surface; the kit's
`process.run` stub is never called). The board survives `/clear` (it rebuilds from `status --json`) and a module reload
(state in `$.state`). Cancel asks again with the job id and current state at the moment of the press.

### Phase 5: shadow experiments (F6). Report after four weeks; no behaviour change.

---

## 5. Bridge contract changes to the companion

| # | Change | Where | Why |
|---|---|---|---|
| a | Every `--json` output carries `"schema": "relay.<command>/1"` and `"relayVersion"` (from `plugin.json`) | `cli/status.mjs:16` (result), `:31`, `:59`; `cli/wait.mjs:64`; `cli/message.mjs:54`, `:76`; `cli/start.mjs:198-201`; `cli/cancel.mjs:193-194`; `cli/setup.mjs:73` | A module built against relay N must notice relay N+1's shape. Today nothing in the JSON says which version wrote it. |
| b | Errors as JSON under `--json`: a busy view prints `{"schema":…,"busy":true,"message":…}` on stdout and still exits 4; a usage error prints `{"error":{"kind":"usage","message":…}}` and exits 1 | `companion.mjs:113-117` (every error goes to stderr as text today); `JobViewBusy` at `lib/jobs/view.mjs:28-33` | A Mod can't tell "busy, keep the last view" from "broken" without parsing stderr. The research's "label it stale, don't clear the board" needs this. |
| c | `status --json --brief` (no `attemptRecords`, `server`, `relay.transcriptPath`; adds `owed` = `undelivered.length`) and `--active` | `cli/status.mjs:24-60`, `jobViewJson` `lib/jobs/view.mjs:350-384` | Measured: `status --all --json` is **1,290,527 bytes for 473 jobs** (about 2.7 KB a job, mostly `attemptRecords[].servers[].stderrTail`). `$.process.run` keeps 4 MiB of stdout, so the full listing would be cut at about 1,500 jobs. It takes 0.28 s now. |
| d | `steer`/`continue`/`resume --message-id <id>`: post under the caller's id; if `messageExists` already, don't post again, just await or read the outcome | `cli/message.mjs:41-79`; `postInboxMessage` already takes `message.id` (`lib/jobs/messages.mjs:17-27`); `messageExists` `messages.mjs:83-86` | A process the Mod killed at its timeout may have posted already. A retry under the same id runs the message once, the guarantee the relay delivery already has (design.md "Every message runs once or is reported"). |
| e | `--ack-timeout-seconds N` on the same commands | `awaitOutcome` reads `RELAY_JOBS_ACK_TIMEOUT_MS` (60 s) at `lib/worker/delivery.mjs:87` | `$.process.run` defaults to a 30 s timeout. The bridge must return `outcome: null` ("pending") before the caller gives up. |
| f | `message-status <job> <message-id> --json` → `{state: pending\|claimed\|done, outcome}` | new; reads `readOutcome` `messages.mjs:153`, `isMessagePending` `:158` | Reconciliation after an unclear result, without sending again. |
| g | `--format markdown` for `status` and `result` | `cli/status.mjs`, rendering in `lib/jobs/view.mjs` beside `renderJobList` (`:325`) and `renderResultText` (`:278`) | F2. One renderer, tested in Node. |
| h | Phase 1 only: the wake marker in `jobPaths`; `wait` watches it | `lib/jobs/store.mjs`; `cli/wait.mjs:41-54` | F1. |

Not needed: a daemon or socket. Each call takes 0.1–0.3 s (`status --json` 0.10 s, `--all` 0.28 s, measured), and
architecture.md rule 5 (no daemon) stands.

---

## 6. Test strategy

- **Node tests (`tests/`, `npm test`):** F1 hook unit tests next to `tests/relay-guard.test.mjs`. The `wait` marker in
  `tests/jobs.test.mjs` or a new `tests/relay-wake.test.mjs`. An E2E steer in `tests/relay-e2e.test.mjs` with the fakes.
  Bridge: golden JSON with `schema`; busy-as-JSON in `tests/busy-view.test.mjs`; `--message-id` idempotence (post
  twice, one inbox file, one outcome) in `tests/message-account.test.mjs`; `--brief` size bound (100 fake jobs < N KB);
  markdown goldens in `tests/render.test.mjs`. `tests/commands.test.mjs` asserts the markdown commands still exist,
  since they are the fallback.
- **Mod test kit (`claude plugin test plugins/relay`):** `$` stubs answer `{ value }` (verified on 2.1.307). One test per
  command: argv as expected, text passed through, a throwing stub falls to `next`. For F5: mount `Pane` on `terminal`
  and `desktop`, press Cancel, and assert the second confirmation; with an empty `surfaces()`, assert `process.run` is
  never called. The kit runs only where `claude` is installed, so CI runs it as a separate job, or it stays a local
  pre-release step listed in CONTRIBUTING.
- **Static:** `claude plugin validate plugins/relay` in the release checklist. Fail if `gatingHooks` lists a hook without
  `.catch`, or if any hook names `tool.call`, `classic.PreToolUse` or `classic.SubagentStop`.
- **Live, after every Claude Code update** (add to design.md "After a Claude Code update"): (1) `claude -p "/relay:status"
  --output-format stream-json`: `num_turns 0`; (2) steer a running relay and measure F1's latency; (3) `claude --version`
  is in the module's README range. The scratch harness `scripts/feed*.mjs` (stdin feeder) plus the probe Mod is the
  model for this check.

---

## 7. Corrections to the preliminary research

| Claim (research doc, 2026-10-17) | Status |
|---|---|
| Matrix: `claude -p` / Agent SDK, "Supported when the plugin loads / No interactive drawing" | **Confirmed, with one gap.** The engine still sends `ui_status`, `ui_toast`, `ui_log` and `ui_panes` to the host as `system` messages [V exp1]. T3 drops them [I, bundle grep]. Commands work there and appear in the SDK's `initialize` command list [V]. |
| "Mods can register commands that run while Claude is busy using `immediate: true`" | **True in the terminal only.** Over stream-json, so in T3, an immediate command runs at turn end [V exp4]. |
| "An interface-only command can return `{}`" | **Confirmed** [V exp3]. In T3 it then shows nothing at all. |
| "`$.ui.log` displays text without giving it to Claude"; "routine status stays in the interface" | True in the terminal. In T3 the "interface" is nowhere, so a routine status Mod shows nothing there. |
| "The first cross-project job board needs neither agent-harness-kit nor a new service … relay already exposes enough" | **Partly refuted.** No version marker. Busy goes to stderr as text with exit 4. No caller-chosen message id on `steer`/`continue`, though the inbox supports one. `status --all --json` is 1.29 MB for 473 jobs, against a 4 MiB stdout limit in `$.process.run`. §5 (a)–(f). |
| Stage 1 = `/relay-board` + indicator + pane | For this user, none of the three renders in T3. A registered Mod command can't be named `relay:…` (`CommandSpec.name`: letters, digits, `_`, `-`). Hooking the plugin's own `relay:status` keeps the names and keeps a fallback [V relaycopy]. |
| `$.session.send` reports queuing, not action | **Confirmed**, and more: the receiver's `session.receive` fires only at its next tool round (25.9 s later in exp3). Only the sender side can cut relay latency, and a classic `PostToolUse` sees that as early as a Mod [V exp5]. |
| Native send/receive events may replace transcript detection (research §7) | Possible only for messages while the relay runs. A message after hand-back resumes the agent (`agent.spawn` with `resume`). Taking it in a Mod would park the agent and lose the completion notice. Keep it shadow-only (F6). |
| `classic.PreToolUse` is a `ToolCallEnvelope` exception; results are normalized | **Confirmed** for 2.1.307 (d.ts 1280-1290, `ClassicResult` 1312). Also: Mod hooks sit **above** plugin and settings command hooks in the classic chain, which the research didn't state. |
| `SubagentHandback` is a tool matched by `PreToolUse` | Confirmed (`hooks/hooks.json`). |
| Limits: 4096 messages, 4 MiB fs, 4 MiB store, `process.run` 30 s / 10 min | Confirmed (d.ts 2794-2826, 3316-3318, 3450-3454, 3604-3618). Also: `process.run` keeps the first 4 MiB of each stream. |
| `$.state` resets on `/clear`; `session.start` doesn't fire again; `classic.SessionStart` does | Confirmed (d.ts 4464; `SessionStartHookInput.source` includes `clear`). |
| Mods on by default from 2.1.287 terminal / 2.1.286 Desktop | Confirmed by the docs today. Declarations now come from 2.1.307 (the research had 2.1.277). |
| Three playground samples (`token-weather`, `blast-radius`, `replay-theater`) | Confirmed; the README says each needs 2.1.287+. |
| (Not addressed) packaging | One `hooks.json` holds both `"hooks"` and `"modules"`; `claude plugin validate` passes and the module loads [V relaycopy]. `$.plugin.root` locates `scripts/companion.mjs` [V]. |

---

## 8. Open questions only you can answer

1. **Terminal versus T3:** how often do you work in a terminal or the Desktop Code tab? If almost never, drop Phase 4.
2. **Version floor:** relay's floor is 2.1.271, and modules load from 2.1.287. I tested only 2.1.307 (your machine also
   has 2.1.303 and 2.1.306). Which Claude Code versions do M1, M3 and the ThinkPad run, and may the module's documented
   floor be 2.1.307?
3. **Model visibility:** should `/relay:status` and `/relay:result` output enter the model's context, as their Bash output
   does today? The other choice is `{}` plus UI only, which is invisible in T3.
4. **T3 rendering:** can you get T3 Code to render `system/ui_status` (a chip) and `system/ui_log` (a dim row)? With that,
   Phase 4's status line works in T3 with no relay change.
5. **Addressing:** do your leads and Workflow scripts always send to a relay by agent id, or also by `name`? F1 resolves
   ids only. Names would need a name → id record from `PostToolUse Agent`.
6. **Header pre-check (F4):** a refusal at the `Agent` call is stricter than today's failed start plus hand-back. Is that
   the behaviour you want in Workflow scripts, where the deny becomes a thrown error?
