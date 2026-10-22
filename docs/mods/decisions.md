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

Latest per check, surface and backend (by `finishedAt`, else `startedAt`, else the time in the run id); an older
pass behind a newer failure is a dash. Kimi's
steer cell says "as the next turn" because the steer checks require it: a send passes only when the job's outcome
for the message is `steered` (into the running turn) on Codex, Grok and ZCode, and `turn-started` (a turn of its
own) on Kimi, after the turn that was running at the send ended. The semantics the table states are measured,
not written by hand.

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

### D26. A delivery counts only for the sender and the run that made it (Phase 5 thread)

Both reviewers of the suite (GPT-6.1 Sol and Opus 5.5) found the same two false passes. A steer from the probe or
a Workflow agent could pass on a ledger record that another sender produced with the same text, and a check read
its whole transcript, so an earlier run in the same thread could supply the sends and the marker. Now the analysis
reads only the entries from the run's prompt to the next run's, and the Workflows launched in them. A ledger record
names the relay's transcript entry that carried the message, and that entry's origin must be the sender's: the
coordinator for the main thread, the coordinator with `plugin: wake-probe` for the probe, a peer `from` the
Workflow agent's id. The probe's answer and the Workflow agent's `SendMessage` result must say it was delivered.
How the backend took a message is checked against the attempts as well as the outcome: into the turn that was
running at the send, or a later attempt that started after it ended, with Kimi's `queued-next-turn` on record. A
continue reads the version and the report of the attempt it started, after a hand-back that came before the send.

### D27. A terminal run is a plain terminal session (Phase 5 thread)

Opus 5.5 found that the pane's Claude Code inherited the lead's session variables (`CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT=sdk-ts`, its session id, messaging socket and token), from the runner and from the tmux
server's environment: every "terminal" transcript so far, Phase 1's included, recorded `entrypoint: sdk-ts`.
`pane.sh start` now removes them for the command it starts, and a record fails unless the transcript's entrypoint
is `cli` in the terminal and `sdk-ts` in T3. The terminal records committed with this phase come from clean
sessions. Phase 1's terminal results stand as history; the suite reran their checks.

### D28. A record names the build's commit (Phase 5 thread)

Two builds can share a `3.0.0-dev.N` (a `--worktree` install, or two phase branches before one rebases). A record
carries `relayCommit`, 12 hex characters with `-dirty` for uncommitted changes under `plugins/relay`; the smoke
install's receipt records the commit it exported.

### D29. The table's notes on how a backend took a message are generated from the records it shows (Phase 5 thread)

The first table carried a fixed paragraph on each backend's semantics, printed even with every cell a dash, so D20's
"measured, not written by hand" held for the cells only. The notes now list, for each way of taking a message, the
backends whose shown records carry it, and nothing when no record passed.

### D30. The suite answers the folder-trust dialog for the folders it creates (Phase 5 thread)

Claude Code records the answer per folder in `~/.claude.json`, so each terminal run adds an entry for a `/tmp` work
folder that is gone after the run. This is the one stored choice the tooling makes, as in Phase 1 (`pane.sh trust`),
and only for a folder the runner created. A folder the caller names must already be a git work tree, which the
runner never initializes, and already trusted: when Claude Code asks, the run stops. D13's rule holds for every other dialog. Reopen if Claude Code gets a per-session
trust flag.

### D31. A command shows the companion's lines in a code block, and a job's report as Markdown (Phase 2 thread)

Measured on 2.1.308 before any code: the terminal draws a command's text as Markdown, and a `---` line right after
the state block turns the block into a setext heading; T3 draws the text as an assistant message, as Markdown
without line breaks, so a state block's `key: value` lines run into one paragraph. Claude Code also puts the
plugin's name, `relay: `, in front of the first line, which breaks a code fence that opens the text. So the module
answers a line break, then the companion's output up to its first `---` line in a fenced block (with stderr after
it, and a fence longer than any backtick run inside), then `---` and the report as written. The state block, the
status table and every message the companion prints read exactly as in Bash, on every surface, and a report, which
the backend wrote as Markdown, is drawn as one, as the model's retelling drew it before. Rejected: the bare text
(mangled in both surfaces), a Markdown variant of the companion's output (a second human format, which the plan
rules out), and fencing the state block inside `renderResultText` (it would change the hand-back that every
completion notice carries, for a display concern). Reopen if T3 or the terminal stops rendering command output as
Markdown.

### D32. The commands ship without a branch fallback (Phase 2 thread)

The plan had each `.catch` fall through to the markdown body on the branch, and a last commit remove it. The live
suite has to run on the final code anyway, and a fallback would hide a failing module from a check that requires
no model turn, so the handlers carry their final `.catch` (an error text) from the start, and the markdown bodies
shrink to the plan's one line in the same commit. Rule 4 allows a branch fallback; nothing needed one.

### D33. Claude reads jobs with `C status` and `C result`; the four commands are the user's (Phase 2 thread)

A model's `Skill(relay:status)` call does not go through `command.run`: it expands the markdown body into the
model's context (measured on 2.1.308). With the body reduced to "the module answers this command", a model calling
it would be told the module did not load. `status.md` and `result.md` get `disable-model-invocation: true`, as
`cancel.md` and `transfer.md` have, and the jobs skill and the README send Claude to `C status` and `C result` in
Bash, which print the same text. Rejected: keeping the `!` bodies for the model's calls, which would leave a second
way to run each command and a working fallback in the release. What users lose is `Skill(relay:status)` and
`Skill(relay:result)` as permission rules; a session that allows the companion in Bash has the same reads. Easy
to reverse if a later Claude Code routes a model's call through `command.run`.

### D34. Transfer finds the session's transcript by its id (Phase 2 thread)

The module's process gets Claude Code's environment, not the variables the SessionStart hook writes to
`CLAUDE_ENV_FILE` for Bash, so `RELAY_COMPANION_TRANSCRIPT_PATH` never reaches it. The module passes
`$.session.id()` as `RELAY_COMPANION_SESSION_ID`, and `transfer` looks for `<id>.jsonl` directly inside the project
folders of `~/.claude/projects`; `--source` still wins. The SessionStart hook still exports the session id, which a
Bash call of the companion reads the same way, and stops exporting the transcript path, which nothing else read.
One way to find the session, from both callers.

### D35. A headless run of a command exits with the companion's exit code (Phase 2 thread)

`command.run` answers may carry `exitCode`, which only a headless run (`claude -p "/relay:result <job>"`) uses. The
module passes the companion's own code (0 completed, 3 ended without a report, 4 running or busy, 5 cancelled, 1
usage), and 1 with its own error texts, so a script that ran `C result` can run the slash command instead and read
the same code. An interactive session ignores it.

### D36. The command checks send the run line first and the commands after it (Phase 2 thread)

A slash command cannot carry the prompt's first line, `Live suite run <id>.`, by which the suite scopes a
transcript and finds a T3 thread's. A command check's prompt is that line and a one-line reply; the commands
follow as the session's next messages, typed into the pane by the runner, or sent to the thread by the lead from
the list `prepare` prints. The jobs the commands read are started by the check's setup with the build's companion,
not through Claude, so no relay's hand-back starts a lead turn among the commands. A command's time runs from the
runner's send in the terminal, where the transcript stamps the command and its answer alike, and from the SDK's
`enqueue` record in T3 and `claude -p`. `transfer` runs on Codex only; the table says `n/a` for the others.

### D51. Phase 6's PR raises no version (Phase 6 thread)

Phase 6 is a report. No code of the plugin changes, only its CHANGELOG, so no build gets a new `3.0.0-dev.N`.
This is an exception to D6, which numbers builds: a phase PR that changes no plugin code raises no version.
The PR passes the gates that apply to docs: `npm test`, `npm run check`, `claude plugin validate`,
`claude plugin test`, CI, a review by two model families and the bots. It adds no live check, so it commits no
records, and it runs no smoke kit, since no plugin code changed since Phase 5's smoke run.

### D52. A job's message would be the relay's own `SendMessage` (Phase 6 thread)

The plan had the module deliver a job's message with `$.session.send` as the relay agent's own. Measured in
2.1.308, a module's send always comes from the main conversation: it carries no sender agent from any loop, an
`agentId` passed to it is dropped, `"main"` refuses it, and a peer reads it as the coordinator's. The relay agent
can send as itself: it gets the `SendMessage` tool, and the `PreToolUse` guard takes the message from the job's
outbox under the relay lock and rewrites the call's `message` and `to` with `updatedInput`; `PostToolUse` records
whether the send succeeded. Measured: it fires for a subagent's and a Workflow agent's `SendMessage`, with the
rewritten input and the result, and a failed send is `success: false` there; a denial fires no hook after the
call, so the guard records its own. The guard, not the job, decides the address and writes the header that
names the job. The relay never sees the text. Relay does not resend, so the guarantee is at most once, with a
success, a failure or an unknown outcome on record. The answer to a question the job waits on goes back as the
waiting tool call's result, because a steer ends that wait on no backend; how an answer, the deadline and a
cancel settle a question is a contract the report names for the later plan.
Rejected: a module `session.send` hook that rewrites the relay's send. It works, but the guard already owns the
relay's ledger, and the hook works only where the module loads. The report has the evidence and the design
([messages-from-a-job.md](messages-from-a-job.md)). Reopen if Claude Code lets a module send as an agent.

### D53. D17 covers relays started with the Agent tool (Phase 6 thread)

D17 has Phase 4's Steer and Continue send to the job's recorded relay id. In 2.1.308 a message by id to a running
Workflow agent starts a second loop of it, and the original loop never reads it. For a `relay:job` Workflow agent
the steer still reached the job, through the second relay loop, in the one run measured. A message to a Workflow
relay that has ended fails, or resumes a `general-purpose` agent that answers in the relay's place, and the job
gets no turn. So D17 holds as decided for relays the Agent tool started. What the buttons do for a Workflow job is
Phase 4's to decide, with a live check of both cases from the lead's session, judged by the job's ledger and
attempts. `C steer` and `C continue` already reach a job without its relay. The same fork carries the message
`cancel` to a Workflow relay, which the Phase 3 branch's D42 and D44 rely on. Phase 3's checks should measure it
(the Phase 3 thread was told); if none does, the release does.
