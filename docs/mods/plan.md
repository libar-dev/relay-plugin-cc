# Relay and Claude Code Mods: the plan

Written 22 October 2026 against relay 2.2.0 (main @ f1283c9) and Claude Code 2.1.307. It combines three
independent plans in this directory:

- [claude-opus-5-5.md](claude-opus-5-5.md) (Opus 5.5, high)
- [gpt-6.1-sol.md](gpt-6.1-sol.md) (GPT-6.1 Sol, xhigh)
- [gpt-6-astra.md](gpt-6-astra.md) (GPT-6 Astra, xhigh)

All three followed the same brief, [BRIEF.md](BRIEF.md), and checked the user's preliminary research
(`libar-infra/docs/kontrapunkt-sample-inputs/relay-product-ideation-claude-mods.md`) against the code and the
2.1.307 declarations. The evidence they cite under `/tmp/relay-mods-*` is local scratch and is not committed.
Parts of it hold local job data.

## Rules this plan follows

1. **Everyone runs a current Claude Code.** The floor becomes the build the module is verified on, 2.1.307. No
   code or prose exists for older builds.
2. **One solution for each thing.** When the module takes over a job, the old way is removed. A fallback exists
   only while the module is being proven, and a phase of this plan removes it.
3. **Node work on tool events stays in command hooks; the module answers commands and draws.** That split is the
   one place the three plans agreed without exception (see "What stays where it is").

## What the investigation established

These findings come from experiments that the plans repeated independently. The cited plan sections hold the
transcripts and the declaration line numbers.

- **In T3 Code a Mod can't put anything on screen.** T3 runs Claude Code through the Agent SDK over stream-json.
  There, `$.session.surfaces()` is empty and `$.ui.open` returns `no-surface`. `ui_status`, `ui_toast` and
  `ui_log` reach T3 as `system` messages, and T3 has no handler for any of them. All three plans found this
  (Opus §2, Sol §2, Astra §2).
- **A command the module answers costs no model turn, on every surface.** A `command.run` answer returns
  `num_turns: 0` and `total_cost_usd: 0`, and T3 shows it as an assistant message. Opus verified that the module
  can answer the plugin's own markdown command (`relay:status`) and keep its name.
- **T3 lists only markdown commands in its picker.** Its capability probe runs with `disableAllHooks`, so it never
  sees commands a module registers (Sol §2, `binCli:204939`). A registered name also can't contain `:`.
- **`immediate: true` does nothing in T3.** The command waits for the turn to end (Opus exp4). It does work in the
  terminal.
- **A steer is visible the moment it is sent, but only on the sending side.** A classic `PostToolUse` on
  `SendMessage` fires 51 ms after the call, and the Mod's `session.send` fires at 6 ms. The receiving relay's
  `session.receive` fires only at its next tool round, 25.9 s later in the experiment (Opus §2). So a Mod on the
  receiving side can't beat the 120-second `wait`; a signal from the sender can.
- **`$.process.run` cuts each stream at 4 MiB and still exits 0.** It only sets `isStdoutTruncated`. It can also
  time out after its child has already done the work (Sol §2, both measured). `status --all --json` is already
  1.29 MB for 473 jobs.
- **A Mod hook runs above the plugin's command hooks in the classic chain.** A Mod that answers without `next`
  skips them. A failed Mod hook is skipped (Opus §3 "Rejected", Sol J, Astra "Responsibilities"). Moving the guard
  into a Mod would put it in a weaker place, not a safer one.

## Where the plans disagreed, and the decision

| Question | Opus | Sol | Astra | Decision |
|---|---|---|---|---|
| First thing to ship | Steer wake through a classic hook | `/relay-jobs` Mod command | `/relay-status` Mod command | **Steer wake first.** It needs no Mod and is the largest gain in T3. The command module comes second. |
| Command names | Answer the plugin's own `relay:status`, `relay:result`, `relay:cancel` | New `relay-jobs` | New `relay-status`, `relay-result`, … | **Answer the `relay:` names.** One name per command, the same namespace as `/relay:setup` and `/relay:review`, and the only kind T3's picker lists. |
| Faster delivery of a steer | Sender-side `PostToolUse` on `SendMessage` ends the relay's `wait` early | Observation experiment only | Mod `session.append` signal into a new reconciler (L) | **Opus's design.** It reuses the one delivery path the guard already has. The receiver-side events fire too late (measured), and Astra's reconciler would be a second path. |
| The companion as an interface for the module | Extend the existing `--json` outputs | New `bridge` subcommand; existing JSON kept as is | New `bridge` subcommand; existing JSON kept as is | **No second interface.** Phase 2 shows the companion's text output and needs no JSON. If the board is built (Phase 4), the existing `--json` outputs change in place, and their consumers in the repository change in the same PR. |
| Direct steer and continue from user commands | Deferred | Planned, with durable receipts (M–L) | Planned, with durable receipts (M) | **Not planned.** `SendMessage` to the relay stays the one way to message a job. A second path would bypass the relay's message accounting. Open question 3. |
| Uncollected and failed jobs | — | Separate feature C | Separate feature F4 | **Part of the status table.** Its relay column already marks `not handed back`; owed messages and violations join it. |
| Setup inspector | Rejected | Feature G | Feature F5 | **Rejected.** `/relay:setup` asks questions and installs things, so it stays model-run. |

## Phase 1: steer wake (one PR, no Mod)

A `SendMessage` to a running `relay:job` agent reaches its job in about 2 seconds instead of 0 to 120. This fixes
the steer latency of every review loop, on every surface.

- `hooks/hooks.json`: add `PostToolUse` with the matcher `SendMessage`, running a new
  `scripts/hooks/relay-wake.mjs` with a 5-second timeout.
- `relay-wake.mjs`: when `tool_input.to` names a relay pointer whose job is not terminal (`readRelayPointer`,
  `lib/harness/relay.mjs:292`; `findRelayJob`, `:312`), write `<jobDir>/relay-wake.json`. Exit 0 on every error.
- `cli/wait.mjs:41-68`: with `--exit-zero-while-running`, leave with the "still running" line when the marker is
  newer than the wait's start. The relay runs `wait` again, its tool round ends, and the guard delivers the queued
  message at the next `PreToolUse`. That is the same path the 120-second timeout takes today. The timeout stays as
  the wait's bound.
- `lib/jobs/store.mjs:93` `jobPaths`: the marker path.
- docs: replace "within about two minutes" in README, `agents/job.md` and design.md "Two-minute waits"; CHANGELOG.

Acceptance:
- Unit tests: a running job's pointer writes the marker. An unknown `to`, a terminal job, bad JSON or a missing
  jobs home write nothing and exit 0. A `wait` returns within 2 s of a newer marker, ignores an older one, and
  ignores markers without the flag.
- E2E with the fake backend (`tests/relay-e2e.test.mjs`): the steer is delivered and runs once, with no
  `relay-violation:`.
- Live, in T3 and the terminal: three steers of a running Codex job out of three reach `inbox/relay/` within 10 s
  of the `SendMessage` call.

## Phase 2: the relay module answers its own commands (one PR)

`/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` answer in under a second, with no model
turn and no tokens, and show the companion's output exactly. Today `status.md` and `result.md` ask a model to
render or repeat that output, and every one of the four costs a turn. (`transfer` wasn't in the delegates' plans;
it follows the same pattern of running the companion and showing its output.)

- `hooks/hooks.json`: add `"modules": ["./mod/register.js"]` beside `"hooks"` (Opus verified that the two load
  together and that `claude plugin validate` passes).
- `hooks/mod/register.js`: four `command.run` handlers. Each runs
  `$.process.run(['node', $.plugin.root + '/scripts/companion.mjs', <sub>, ...args], { cwd })` and returns
  `{ text }`. It passes arguments as argv, never through a shell. It treats either truncation flag or a missing
  exit code as an error and returns that error's text; it never shows "no jobs" after a failure. Set
  `immediate: true` so the terminal can run them during a turn; in T3 they run when the turn ends.
- `status` text output: `renderJobList` (`lib/jobs/view.mjs:325`) prints the Markdown table that `status.md`
  currently asks the model to build. It is the only human format; `C status` in Bash prints the same table.
- `result` output stays `renderResultText` (`view.mjs:278`), because the guard's hand-back compares against it
  (`relay-guard.mjs:346`, `:421`). If T3 renders it badly, change it there, so the hand-back and the command keep
  one format.
- **Temporary fallback, removed in Phase 3:** each handler ends with `.catch(($, e, next) => next(e))`, so a
  thrown module error runs the current markdown body. Each body gains a first line telling the model to say
  "the relay module did not answer this command" before anything else, so a fallback is visible whenever it
  happens.
- Floor: README, CHANGELOG and design.md move to Claude Code 2.1.307. Design.md's "The relay needs no Claude Code
  mod" becomes a description of the module and the version it was verified on.

Acceptance:
- `claude plugin validate plugins/relay` passes. The module has exactly four `command.run` handlers and no hook on
  `tool.call`, `classic.PreToolUse` or `classic.SubagentStop`.
- `claude plugin test`: one test per command checks argv, cwd and the text passed through. Truncation, timeout,
  exit 4 (busy) and stderr each produce an error text. With an empty `surfaces()`, the module draws nothing.
- `node --test`: golden output for the status table (a list, an empty list, a busy job, every relay-column
  marker).
- Live on M1, M3 and the ThinkPad, in T3 and the terminal: each command shows its output with no model reply under
  it, and `claude -p "/relay:status" --output-format stream-json` reports `num_turns: 0`.

## Phase 3: remove the fallback (one small PR)

Phase 3 can start once the module is proven: Phase 2's live checks have passed on all three machines, and the
fallback line hasn't appeared for a period the user sets (open question 5).

- Each handler's `.catch` returns an error text naming the failure, instead of calling `next`.
- The four markdown files keep their frontmatter, which carries the name, description and argument hint for the
  picker. Their bodies shrink to one line: "The relay module answers this command. If you are reading this, it did
  not load: say so and stop."
- `tests/commands.test.mjs` asserts that the bodies contain no companion call.

## Phase 4: terminal and Desktop board (only if open question 1 says yes)

A status line ("2 running · 1 owed") and a `/relay:board` pane listing jobs, the selected job's report, and a
Cancel button that names the job and attempt again when pressed. It is drawn in the terminal and Desktop only.

- The module polls only while `$.session.surfaces()` is non-empty, with one read in flight. Rendering reads cached
  `$.state` and never runs a process. After `/clear`, `/resume` or `/branch` it rebuilds from the companion.
- The companion's `--json` outputs change in place, and the stop gate, `setup.md` and the jobs skill change with
  them in the same PR:
  - every output carries `schema: "relay.<command>/1"` and `relayVersion`;
  - under `--json`, errors are JSON on stdout (busy keeps exit 4);
  - listings are bounded, with a cursor, and every row names its backend (`view.mjs:189` omits Codex today);
  - a slim row by default, with full attempt records only for one job.
- Cancel needs an attempt precondition checked in `cli/cancel.mjs`, so a press can't cancel a newer attempt after
  an automatic resume.

## What stays where it is

| Responsibility | Where it stays | Why |
|---|---|---|
| Session exports (`session-lifecycle.mjs`) | `SessionStart` command hook | `CLAUDE_ENV_FILE` is a settings-hook contract. A Mod's `session.start` doesn't fire on `/clear`, `/resume` or `/branch`. |
| Relay guard, including `SubagentHandback` and `StructuredOutput` (`relay-guard.mjs`) | `PreToolUse` command hook | Moving it into a Mod would put it above the guard's place in the chain, where a failure is skipped. It needs Node for locks and transcript reads either way. |
| `SubagentStop` guard | Command hook | Same reasons, plus the eight-block release and the recorded violations. |
| Stop review gate | Command hook | It runs up to 900 s, past `$.process.run`'s 10-minute maximum. |
| The `relay:job` agent and its Bash calls | Unchanged | It supplies the background run, the completion notice, `SendMessage` and the Workflow slot. A Mod-registered agent is still a Claude agent. |
| `/relay:setup`, `/relay:review`, `/relay:adversarial-review`, `/relay:rescue` | Model-run markdown commands | They need the model: they ask questions, choose options, or present findings. |

## Rejected

- **A board as the first release** (the research's Stage 1): T3 can't show it.
- **Moving the guard, hand-back, stop gate or session export into a Mod:** see the table above.
- **Receiver-side Mod events to speed delivery, or to replace transcript reads:** they fire at the next tool round,
  and replacing the transcript reads would need its own parity proof. If that is ever attempted, the transcript
  path is removed in the same change.
- **Mod-registered commands with new names** (`relay-jobs`, `relay-status`): a second name for the same command,
  and T3's picker can't list them.
- **A second, `bridge`-style JSON interface beside the current one.**
- **`$.model.*` summaries of reports:** reports are shown exactly as written.
- **A model-callable relay status tool:** the model already calls the companion through Bash.
- **A completion watcher with notifications:** completion notices already exist, and in T3 `$.ui.notify` returns
  `no-surface`.
- **agent-harness-kit and a history browser:** a separate product. Nothing here depends on it.

## Corrections to the preliminary research

All three plans confirmed its authority split: relay owns execution, the Mod owns commands and presentation, and
the kit owns history. They corrected these points:

- **"No interactive drawing" for SDK hosts:** right, and it decides the order of this plan. The SDK still receives
  `ui_*` messages, so a host could render them; T3 doesn't today.
- **`immediate` commands:** they run during a turn in the terminal only.
- **"Relay already exposes enough for a board":** not as an interface for a module. The output carries no version
  and errors go to stderr as text, `--all` is unbounded, and `$.process.run` truncates silently. Phase 4 covers
  this.
- **"Mod hooks and classic hooks" ordering:** Mod hooks run above the plugin's command hooks. The research didn't
  say so, and it decides where the guard stays.
- **Static analysis:** `$` may be passed to a top-level helper in the same file. Only imported helpers and methods
  are restricted (Sol §7).
- **Declarations:** 2.1.307's replace 2.1.277's. The `classic.PreToolUse` exception still holds.
- **The 2.2.0 additions:** `handedBackAt`, per-attempt `relayVersion`, `--workflow` listing and missed-start
  recovery are already in place, and the status table uses them.

## Open questions for the user

1. **The board:** how often do you work in a terminal or the Desktop Code tab? If rarely, Phase 4 is dropped.
2. **T3 Code changes:** can T3 be changed? Two changes would help: render `system/ui_status` as a chip and
   `ui_log` as a dim row, and read module commands. With them, Phase 4's status line would work in T3 without a
   relay change.
3. **Direct steer and continue commands:** do you want a way to message a job that bypasses the lead's
   `SendMessage`? The plan says no, to keep one path.
4. **Header pre-check:** Opus F4 proposes a `PreToolUse` hook on `Agent` that refuses a malformed `relay:job`
   header before a relay starts. In a Workflow script the refusal becomes a thrown error. Do you want it?
5. **Proof period:** the plan proposes seven days without the fallback line on all three machines before Phase 3
   removes it. Do you want a different period?
6. **Addressing:** do your leads and Workflow scripts always send to a relay by agent id? Phase 1 resolves ids.
   Sending by name would need a name-to-id record.
