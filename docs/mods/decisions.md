# relay 3.0: the decision log

Every fork met while building relay 3.0 gets an entry here: what was decided, by whom, why, and what would
reopen it. The release itself is described in [release-3.0.md](release-3.0.md), the plan in [plan.md](plan.md).

## Who decides

The working thread decides every tactical question and every question it can answer with high confidence, and
records it here. When a call is hard, it asks advisors from more than one model family (Opus 5.5, GPT-6.1 Sol,
GPT-6 Astra) before deciding, and says so in the entry.

The owner decides product forks only: a change to what users rely on that is hard to take back (the meaning of a
documented call, a breaking interface, a public claim), a trade between product goals that has no technical
answer, and the timing of the release and the publication. Such a question goes into "Open for the owner" below
and to the owner in the thread, with a recommendation. Work that does not depend on it goes on.

Entries are never edited after the fact. A reversed decision gets a new entry that names the one it replaces.

## Open for the owner

None.

## Entries

### D1. Phases 1 to 5 ship together as relay 3.0.0 (owner, 22 October 2026)

Phases 1 to 5 of the plan are one release, built on `release/3.0` and merged to `main` once, so the fleet and the
first publication get a coherent product. Each phase lands as its own PR into `release/3.0` and is smoke-tested
there; nothing reaches the fleet before the release. Phase 6 ships as a report. The later plans (model-family
guidance, orchestration strategies, templates) are not part of 3.0. Proposed by the Phase 1 thread, accepted.

### D2. TaskStop on a relay agent cancels its job (owner, 22 October 2026)

Phase 3. An orchestrator's TaskStop means to stop the work, and the job is the work. A relay that dies without a
TaskStop (session end, a killed process) still leaves its job running. This reverses design.md's "TaskStop stops
only the agent".

### D3. The board's Desktop check (owner, 22 October 2026)

Phase 4. Claude Desktop has no Linux build. The board is checked with the test kit's `desktop` mount on Fedora,
plus one manual pass on a Mac before the release.

### D4. The relay waits 540 seconds (owner, 22 October 2026)

Phase 1. With the wake, the bound only caps one tool call; 540 s is under the Bash tool's 600 s maximum and
costs a long job's relay about a quarter of the model calls 120 s did. One constant, `RELAY_WAIT_SECONDS`.

### D5. How decisions are made (owner, 22 October 2026)

As in "Who decides" above.

### D6. Version numbers on the release branch (Phase 1 thread)

`release/3.0` carries `3.0.0-dev.N`, and each phase PR raises N, so a job's recorded `relayVersion` names the
build that ran it. 3.0.0, not 2.x: TaskStop changes meaning, the companion's `--json` changes in place, and the
Claude Code floor rises. `bump-version.mjs` accepts the pre-release form, and Claude Code installs one.

### D7. The wake marker counts against the boundary the wait came after (Phase 1 thread)

The plan's rule (covered once a guard check read the transcript after it) missed a message sent while the relay's
model wrote its next `wait`. A first replacement (the wait removes the marker) failed review by both GPT-6.1 Sol
and Opus 5.5 in three cases: a leftover wait of an earlier relay, two waits in one assistant message, a message
queued as the job ended. Chosen: the guard reads the boundary from the relay's transcript and passes it as
`wait --wake-after`; nothing removes markers. design.md, "The wake", has the full reasoning. Reopen if Claude
Code changes when it injects queued messages, or the transcript stops carrying entry timestamps.

### D8. Messages from other agents are delivered, as `origin.body` (Phase 1 thread)

Claude Code marks another agent's `SendMessage` as origin kind `peer`, with the text as sent in `origin.body` and
an envelope naming the sender around it. The job gets `origin.body`. An entry without it is recorded as a relay
violation, not unwrapped from the envelope: one way to read the text.

### D9. The module wakes every relay the recipient names (Phase 1 thread)

`$.agent.list()` may hold a finished relay beside a new one with the same name, so every listed `relay:job` match
is woken. A listed agent of another type has no job and gets no process start. An unlisted recipient (a
Workflow's agents are never listed) is woken by `to` as given.

### D10. No fallback to a shorter wait where the module does not load (Phase 1 thread)

A reviewer proposed choosing 120 s per session when the module is not live. Rejected under the plan's rule 4 (one
solution, no fallbacks). Below the 2.1.307 floor a message waits up to 540 s, and design.md says so.

### D11. Peer messages from before the update are delivered after it (Phase 1 thread)

A relay that lives through the update delivers the peer messages it received before, since none has a delivery
record. Filtering them by time would add a rule for a one-time effect; the CHANGELOG states it.

### D12. Smoke tests on a machine that runs relays (Phase 1 thread)

The release smoke test installs the build at local scope into one folder (`scripts/smoke/install-local.sh`) and
drives a session there in tmux (`scripts/smoke/pane.sh`). Rejected: a separate `CLAUDE_CONFIG_DIR` profile (needs
its own sign-in, and copying credentials risks the main sign-in when tokens rotate); `--plugin-dir` for the
release smoke test (it skips the install path; it is what the live checks use). T3 honours the local install in a
T3 project at that folder.

### D13. Test tooling never changes the user's Claude Code settings (Phase 1 thread)

Two incidents in Phase 1: answering the bypass-permissions dialog stored `skipDangerousModePermissionPrompt`, and
exporting `CLAUDE_CONFIG_DIR=~/.claude` made Claude Code start a fresh global config and rerun its settings
migrations (it changed the model setting). Both were undone. Rules: bypass mode comes from
`--settings '{"skipDangerousModePermissionPrompt":true}'` for the session only; no dialog that persists a choice
is answered by a script; `CLAUDE_CONFIG_DIR` is never set when the caller did not set it. Tests hold the last one.

### D14. The smoke install's receipt lives in the user's state directory (Phase 1 thread)

Greptile showed that a receipt in the project folder let a forged file choose what uninstall deleted. The receipt
is in `${XDG_STATE_HOME:-~/.local/state}/relay-plugin-cc/smoke-installs/`, and every recursive delete is checked
against the plugin registry and the folder's contents first.

### D15. Mod tests and CI (Phase 1 thread)

The Mod test kit runs only `*.test.ts`, so `hooks/mod/register.test.ts` ships inside the plugin folder; the engine
does not load it. CI installs a pinned Claude Code globally to run `claude plugin validate` and
`claude plugin test`. CodeRabbit asked for a lockfile-backed install; not needed: the package has no
dependencies, its optional platform binaries are pinned to the same version, and a published npm version never
changes.

### D16. Bot reviews on the release branch (Phase 1 thread)

`.coderabbit.yaml` adds `release/.*` to the base branches CodeRabbit reviews automatically. Greptile is asked with
a comment, `@greptileai review`, when it does not start on its own. T3's `watch_pull_request` follows every PR.

### D17. Phase 4's Steer and Continue use the job's recorded relay id (Phase 1 thread)

`$.agent.list()` holds no Workflow agent and drops a finished subagent, which is when Continue is needed. The
buttons send to `relay.agentId` from the job (`relay.json` after an adoption) and show a refused send's reason.

### D18. Scripted checks in T3 are driven by messages to the thread (Phase 1 thread)

A Monitor the lead arms does not start a new turn in a T3 thread once the turn has ended. The Phase 1 T3 check
stopped after its first round until a message continued it.

### D19. The live suite's records are committed, its evidence stays on the test machine (Phase 5 thread)

A record is one line per check, backend and surface, in `docs/live/records/<run id>.jsonl`: one file per run, so
two phase PRs that both run the suite never edit the same file. A record names the check, backend, model, relay
version, Claude Code version, surface, lead model, timings, result and its evidence folder, and holds no absolute
path. The evidence (screen, transcripts, the jobs' folders) is copied out of `/tmp` into
`${XDG_STATE_HOME:-~/.local/state}/relay-plugin-cc/live/runs/<run id>/`, so `analyze --from-copy` reproduces a
run's records later. Committed records let anyone regenerate the capability table, and `npm test` holds the
committed table to them. Rejected: records kept only on the machine (a public table would rest on files nobody
else can read), and committed evidence (transcripts carry local paths and job data). A run that sent its prompt
keeps its records, failures included; a run whose setup failed writes none.

### D20. The capability table shows a cell only when its latest record passed (Phase 5 thread)

Latest by `finishedAt`, per check, surface and backend; an older pass behind a newer failure is a dash. Kimi's
steer cell says "as the next turn" because the steer checks require it: a send passes only when the job's outcome
for the message is `steered` (into the running turn) on Codex, Grok and ZCode, and `turn-started` (a turn of its
own) on Kimi. The semantics the table states are measured, not written by hand.

### D21. A probe Mod sends from a tool the model calls (Phase 5 thread)

Phase 1's `/wake-probe` was a slash command: a person, or the driver, had to type it with an agent id known only
once the run was under way. A tool (`mcp__wake-probe__send`) lets one prompt drive the check, as every other check
is driven. Probes live in `scripts/live/probes/` and load with `--plugin-dir` only, never installed, so a check
that needs one runs in the terminal only; a T3 thread loads only installed plugins. Reopen if a later phase needs
a plugin's send proven in T3.

### D22. A T3 run is prepared and analyzed by the runner and sent by the lead (Phase 5 thread)

`suite.mjs prepare` writes the run and its prompt; the lead sends the prompt to a thread of the T3 project that has
the build installed (`scripts/smoke/install-local.sh`), and `suite.mjs analyze` finds that thread's transcript by
the prompt's first line, `Live suite run <run id>.` `prepare` reads the build's version from the smoke install's
receipt, and a record fails when its job ran another relay version, so a thread that loaded the released plugin
cannot pass. The prompt names the jobs home as `${RELAY_JOBS_HOME:-$HOME/.relay-jobs}`, since a T3 thread cannot
be given an environment of its own; the terminal pane sets a fresh one.

### D23. The suite replaces `steer-wake.mjs` and `analyze-steer.mjs` (Phase 5 thread)

Their prompt and analyzer are the `steer-main` check; the plan's rule 4 leaves one way to run a live check.

### D24. A record's Claude Code version is the transcript's (Phase 5 thread)

T3 runs Claude Code through the Agent SDK, whose build can differ from `claude --version` on the same machine. The
lead's transcript carries the version of the build that ran it, on both surfaces. The lead's model comes from the
transcript too; a terminal run uses `--model sonnet` unless told otherwise, as Phase 1's runs did.

### D25. A steer check allows 30 seconds from the send to the job's ledger (Phase 5 thread)

Phase 1's analyzer allowed 10 s. In the first T3 run of the suite, Kimi's first steer took 10.25 s: the wake ended
the relay's wait 0.86 s after the send, and the relay's own Haiku step then took 9.3 s before its next tool call,
where the guard delivered the message. The limit was measuring Haiku's latency. A wait the wake missed runs its
540 s bound, so 30 s still tells the two apart, and the table shows each measured range. A continue keeps 60 s:
it first resumes a relay that has stopped. Reopen if the relay's model changes, or the ranges creep up.
