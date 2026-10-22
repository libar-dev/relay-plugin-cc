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

- **What confirms the release candidate before the owner's manual testing** (D60, part 11). Read for now as the
  automated checks passing on the release candidate; to confirm with the owner at that step.

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

### D31. A command's answer: the command as typed, the companion's lines in a code block, then Markdown (Phase 2 thread)

Measured on 2.1.308 before any code: the terminal draws a command's text as Markdown, and a `---` line right after
the state block turns the block into a setext heading; T3 draws the text as an assistant message, as Markdown
without line breaks, so a state block's `key: value` lines run into one paragraph. Claude Code puts the plugin's
name, `relay: `, in front of the first line, which would break a code fence that opened the text, and shows and
records a command a plugin answered without its arguments. So the answer's first line is the command as typed
(`relay: /relay:result <job>` on screen), then the companion's output in a fenced block up to its first line that is
`---` or starts with `|` (with stderr after it, and a fence longer than any backtick run inside), then the rest as
Markdown: a job's report after `---`, which the backend wrote as Markdown, or the job table, which the terminal
draws as a box table (or, when it is wider than the terminal, as one block per job) and T3 as a table; its cells
are drawn as Markdown too, so a brief's backticks show as inline code. The state block and every message the
companion prints read exactly as in Bash, on every surface. Rejected: the bare text (mangled in both surfaces), a Markdown variant of the companion's
output (a second human format, which the plan rules out), fencing the state block inside `renderResultText` (it
would change the hand-back that every completion notice carries, for a display concern), and fencing the table
too, which the first version did: Opus 5.5's review found it unreadable once a row wrapped in a terminal of 80 to
120 columns. Reopen if T3 or the terminal stops rendering command output as Markdown.

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
`Skill(relay:result)` as permission rules: in `default` permission mode Claude Code asks before Claude's Bash call
of the companion. Easy
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
the same code. An interactive session ignores it, and so does `--output-format stream-json` (measured on 2.1.308:
`text` and `json` exit with the code, `stream-json` exits 0).

### D36. The command checks send the run line first and the commands after it (Phase 2 thread)

A slash command cannot carry the prompt's first line, `Live suite run <id>.`, by which the suite scopes a
transcript and finds a T3 thread's. A command check's prompt is that line and a one-line reply; the commands
follow as the session's next messages, typed into the pane by the runner, or sent to the thread by the lead from
the list `prepare` prints. The jobs the commands read are started by the check's setup with the build's companion,
not through Claude, so no relay's hand-back starts a lead turn among the commands, and every job the setup started
and the commands left running is cancelled after the analysis. The transcript holds a command without its
arguments, so a command passes only when the answer's first line, the module's echo of `e.args`, is the command as
planned; a newer finished job and a second running job sit beside the ones the commands name, so the companion's
defaults could not stand in for the arguments. The build that answered is proved by the `relay-version:` line of a
`/relay:status` answer (D37); the jobs' own versions only prove the setup's build. A command's time runs from the
runner's send in the terminal, where the transcript stamps the command and its answer alike, and from the SDK's
`enqueue` record in T3; a `claude -p` run reports its own `duration_ms`, since its `enqueue` record comes before the
hooks module has loaded. `transfer` runs on Codex only; the table says `n/a` for the others, and `run all` skips a
check that applies to none of the backends asked for. Both reviewers (GPT-6.1 Sol and Opus 5.5) found the two
false passes this closes: arguments a module dropped, and an older build answering in T3.

### D37. `status` names the relay version, and a smoke install's commit (Phase 2 thread)

The status header gains `relay-version: <version>` after `fast-tier:`. A person sees which build answers the
commands, and a live check can prove that the module of the build under test answered: in T3 nothing else in the
transcript names the build that loaded. Two builds can share a `3.0.0-dev.N` (D28), as both reviewers of the
second round pointed out, so `install-local.sh` writes the commit into the export (`.claude-plugin/build.json`),
and the line reads `relay-version: <version> (<commit>)` for such a build; a T3 check requires that commit to be
the run's. A released install has no stamp. `status <job>` and `--json` are unchanged; Phase 4 gives every `--json`
output a `relayVersion`.

### D41. TaskStop is mapped to its job by the id in the tool's result (Phase 3 thread)

The plan asked to check first what TaskStop names. Measured on 2.1.308: `tool_input.task_id` is what the caller
wrote, an agent id or the agent's `name`, while the `PostToolUse` result always carries the stopped agent's id
(`task_id`, with `task_type: "local_agent"`). The hook reads the result's id, falls back to the input's, and finds
the job through that id's relay pointer. It cancels only when the agent is the job's current relay, the rule
`wake` follows, so a TaskStop on a relay that a resume replaced never cancels the job its new relay holds. Claude
Code kills the relay's running Bash call, and no `SubagentStop` fires for a stopped relay, so nothing else of the
guard runs. Reopen if TaskStop's result stops naming the agent by id.

### D42. A TaskStop on a whole Workflow cancels nothing (Phase 3 thread; amended by D48)

D2 covers a TaskStop on a relay agent. Claude Code offers no TaskStop for one agent of a Workflow (`No task found
with ID`), and a TaskStop on the Workflow's own task (`task_type: "local_workflow"`) ends all its relays at once.
Those jobs keep running: the Workflow tool tells a caller to stop a run with TaskStop before a `resumeFromRunId`,
the resume adopts the running jobs (design.md, "Adoption by journal key"), and adoption never takes a cancelled
job, so cancelling them would make every resume start the work over. The hook needs no rule for this: a
Workflow's task id has no relay pointer. A Workflow job is cancelled with the message `cancel` to its relay's
agent id, or with `companion cancel`. Reopen if Claude Code adds a TaskStop for one Workflow agent.

### D43. The TaskStop hook waits for the cancel and tells the caller (Phase 3 thread)

The hook runs `companion cancel` and waits for it, as long as `/relay:cancel` would (twice
`RELAY_JOBS_CANCEL_GRACE_MS` and 40 s, 60 s at the default; the hook's own timeout is 600 s), then returns the
cancelled job's block as the hook's `additionalContext`, which the caller reads beside
the TaskStop result. Measured: Codex and Kimi jobs were `cancelled` 0.2 s and 0.4 s after the call. A cancel that
fails, or that leaves a newer worker still running (exit 4), is told to the caller with the command to retry,
and recorded as a relay violation, so `status` and `result` show it. Rejected: running the cancel detached (an
`async` hook or a background child), which returns sooner but tells the caller nothing, and leaves a failed
cancel unseen until someone reads the job.

### D44. The message `cancel` stays beside TaskStop (Phase 3 thread; amended by D48)

Rule 4 asks for one solution for each thing. These are two: TaskStop ends the agent and cancels the job, and the
caller gets no hand-back; the message `cancel` cancels the job and the relay hands back the cancelled job's
result, as a Claude agent that is asked to stop reports. The message is also the only way to cancel the job of one
Workflow agent (D42). The docs say when to use which.

### D45. The spawn check fails open and skips the prompts it cannot judge (Phase 3 thread)

The module's `agent.spawn` hook denies a spawn only when `companion check-header` ran and refused the prompt
(exit 1 and an `error:` line); a timeout, a crash, a truncated output or a refused process start lets the spawn
through, because `start --from-relay` runs the same checks and fails the relay as before. It skips a resumed
agent (its prompt is the resuming message) and a Workflow agent whose prompt has no `---` line. Claude Code puts a
placeholder in a Workflow agent's prompt when the run keeps its script from hooks (`(withheld: this workflow run
does not share its script)` on 2.1.308), and its wording is not an interface; the first version matched that exact
string, and Opus 5.5's review showed that another build's wording would refuse every relay of such a run. A
header-less Workflow prompt is still refused, by `start`. The deny text is the parser's message alone; Claude Code
puts `Subagent spawn denied by a plugin: ` or `Workflow agent spawn denied by a plugin: ` before it. Measured: a
Workflow agent's `agent.spawn` carries the script's prompt as written, not the framed task the relay reads from
its transcript, so the check needs no unframing.

### D46. The spawn check leaves relative paths to `start` (Phase 3 thread)

`start` resolves a relative `cd:`, `add-dir:` or `brief:` against the relay's working directory, which is not
known at the spawn: an agent started with worktree isolation runs in a worktree that does not exist yet, and an
agent spawned with no `cwd` runs in its parent agent's directory, while the module's `$.process.run` defaults to
the session's. So `check-header` checks absolute paths and leaves relative ones to `start`. The first version
resolved them against the spawn's directory; both reviewers (GPT-6.1 Sol and Opus 5.5) showed launches it would
have refused that `start` accepts (a `cd:` that climbs out of a worktree, a brief file that exists only in a
subagent's worktree). Their second round found the same through `mode: write`'s linked-worktree roots, which
`buildLaunchRequest` infers from the job's directory and Grok refuses: from a linked worktree, as every T3 thread
runs in, a relative `cd:` was refused. Check mode infers no such roots unless `cd:` is absolute. The documented
forms are absolute, so the common mistake, a wrong absolute `cd:`, still fails at the spawn.

### D47. A TaskStop on a whole Workflow tells the caller which jobs run on (Phase 3 thread)

D42 stands: such a TaskStop cancels nothing, so a resume adopts the jobs. But the relays are gone, so the message
`cancel` can no longer reach one, and a caller who stopped the run to abandon it would not know its jobs still
run. Opus 5.5's review raised it. The TaskStop hook finds the run id from the Workflow tool's result in the
caller's transcript (`taskId` to `runId`), lists that run's jobs that have not ended, and, when there are any,
tells the caller they keep running for a `resumeFromRunId`, with the command to cancel one. A Workflow without
relay jobs gets no output.

### D48. A relay never hands Claude Code's interrupt note to its job (Phase 3 thread)

When Claude Code interrupts an agent's turn (TaskStop, a stopped Workflow), it writes a user entry,
`[Request interrupted by user for tool use]` or `[Request interrupted by user]`, with no origin and no `isMeta`.
The guard took every plain user turn for a message. So a stopped relay that ran again handed the note to its job,
and on a cancelled job a message is a continue: the job TaskStop had just cancelled started again.

A stopped relay runs again in two ways. A message resumes it. Or, as the Phase 6 thread found, a `SendMessage` to a
running Workflow relay starts a second loop under the same agent id while the first runs on; that second loop is a
`local_agent` task TaskStop can stop, and the TaskStop hook then cancels the job, as D2 and D41 say. A live probe
showed the rest: the first loop's guard delivered the note, and the job came back `completed` in a second attempt.

The notes are now harness markers, kept with the others in `lib/harness/workflow.mjs`: the two above and a third
that 2.1.308 substitutes when it resumes an agent the session's end interrupted, read from the binary. The parser
skips them only on an entry with no origin, as every real one is, so a person who types those words is still
heard. With the fix the same probe left the job `cancelled`, and both Workflow agents returned `state: cancelled`.
GPT-6.1 Sol and Opus 5.5 reviewed it.

What this amends:

- D44: the probe measured the message `cancel` to a running Workflow relay. The wake ended the first loop's wait,
  its guard delivered the cancel at the next call, and the job was `cancelled` 1.8 s and 2.7 s after the send.
- D42: "no TaskStop for one Workflow agent" holds except while a second loop a message started still runs; a
  TaskStop on its id then cancels the job like any relay's.

Open, from before Phase 3 (the plan, "After Phase 6"): a fork splits the agent's entries between the Workflow
transcript the job records, which the guard reads, and `subagents/agent-<id>.jsonl`, which it does not, and not the
same way each time. A message that lands in the second file is not delivered.

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

### D54. Where D3's manual Desktop pass runs (owner, 22 October 2026)

D3 holds: the board is checked with the test kit's `desktop` mount on Fedora, plus one manual pass before the
release. That pass, and every Desktop test and screenshot, runs on the M3 itself: the Claude desktop app's Code tab
on the M3, a local session in a folder on the M3 with the build installed there by `scripts/smoke/install-local.sh`,
and a T3 thread on the M3 that drives the app through Cua Driver and keeps the screenshots there. The app has no
Fedora build (its Linux beta is for Debian 12+ and Ubuntu 22.04+), and the M3 cannot reach the ThinkPad over SSH
(its key is not authorized there), so an SSH session from the app is not the route. The app's own Claude Code
(2.1.308 on both Macs) is above relay's floor.

### D55. The companion's JSON: one object per command that names its shape (Phase 4 thread)

Every `--json` output is one object on stdout whose first fields are `schema` (`relay.<command>/1`, raised when
that command's shape changes), `relayVersion` and `relayBuild` (D37's commit). An error under `--json` is the same
header with `error: { kind, message }` on stdout, nothing a reader needs on stderr, and the exit code it had: `busy`
4, and `not-found`, `usage`, `attempt-changed` and `error` 1. A malformed argument list that swallows `--json` as
another option's value still answers in JSON. A job object keeps today's fields and names, flat at
the top, so a script that read `.state` or `.handedBackAt` reads them still; every field is present (null, false,
0 or an empty list when it has no value), and `backend` is always set. `status` has two forms under one schema, a
listing without a job and one job with it, as the command's arguments choose. Rejected: an envelope
(`{ ok, data }`), which would move every field a script reads; a `bridge` command beside it (the plan's Rejected,
a second interface); schema names per form, which would name the arguments, not the command.

### D56. A JSON listing is pages of slim rows (Phase 4 thread)

The status line and the board read listings through `$.process.run`, which keeps 4 MiB of stdout. A full row is
mostly attempt records with server stderr tails (1.29 MB for 473 jobs), so a row leaves out `attemptRecords`, the
server and the messages, cuts the relay binding and the errors to what a list shows, and keeps a few entries of each
list (owed, dropped, recovered, violations) with its full count, and every string in a row is cut to 300
characters; Sol's reviews built 6.2 MB of rows from 300 dropped messages a job, then a 5 MiB row from one long model
name. A page also ends before 2 MiB: 50 rows of a 300-job home
with large attempt records came to 50 KB, read in 0.16 s. Pages are 50 rows by default and at most 200, newest
first by `createdAt`, then job id, and a cursor names the last row's key, so a job created between pages never
shifts them. `--active` keeps the jobs that are starting, running or dead, or owe messages; it skips a job whose
stored state has ended and whose inbox owes nothing without viewing it. `--limit`, `--cursor` and `--active` are
`--json` options: the text listing (`/relay:status`'s) is unchanged. One job's JSON keeps every field.

### D57. `cancel --attempt` cancels only while that attempt is current (Phase 4 thread)

The board's Cancel names a job and an attempt, and a continue or an automatic recovery can begin the next attempt
between the press and the cancel. `cancel --attempt N` checks before it posts; its message carries N, and the worker
answers `no-op` to one for another attempt, which closes the window between that check and the worker taking the
message. A starting job's first attempt counts as 1. Once attempt N is stopped, a newer attempt a message starts runs
on and `cancel` succeeds, saying so.

Two review rounds by GPT-6.1 Sol and Opus 5.5 found the same kind of defect each time: `cancel` reading the job and
then acting on it outside the worker, which can begin an attempt between the two. The first version re-checked the
attempt at more points, and each round found a window between a check and a signal or a lease. The rules that hold by
construction:

- When the worker took the cancel, `cancel` never signals the worker's process. The worker answered, closes its own
  server, and may begin a newer attempt at any moment; `cancel` sweeps only attempt N's other processes.
- `cancel` kills a worker only when it has not taken the cancel within the grace and the attempt is still N.
- Recovery waits while a `cancel` command runs on the job (each records its process in `cancelling/`), instead of
  `cancel` guessing whether a new worker is a recovery or a message's. A worker that died during a cancel, or that the
  cancel killed, is not resumed, and a relay's `wait` sees the job end `cancelled`, not `dead`. This holds for every
  cancel. A first version classified the cancel messages (`hasOpenCancel`) and was wrong both ways in round 2.
- The worker writes the terminal state before the cancel messages' outcomes, so no reader sees a closed cancel on a
  job that is not cancelled.

A third, narrow round on these paths found smaller gaps (a pending cancel of another attempt settled as
`cancelled`, attempt N's processes left unswept when a newer attempt ran on, a second cancel posted to a worker that
had taken the first, a recovery that began before the cancel's record and acted after it, a lease holder's wait
that dropped the old fallback). Each was fixed in place, and one that release/3.0 had too: a job cancelled before
its first worker ran could run its brief when that worker came up late.

Without `--attempt` nothing else changes; `/relay:cancel` and the TaskStop hook pass none.

### D58. A TaskStop that cancelled a job records its hand-back (Phase 4 thread)

Phase 3 left it open: such a job showed `not handed back`, though the TaskStop result carried the cancelled block,
and the board would flag it as a lost result. The TaskStop hook appends `{ agentId, attempts, state: "cancelled",
by: "TaskStop" }` to `relay-handbacks.jsonl` when its cancel ended the job, and only then. The `stop` check requires
the record.

### D59. The job's JSON carries each message's outcome, the relay's last call and the launching session (Phase 4 thread)

The board shows how each message was taken and whether a running job's relay still lives, and routes Steer and
Continue. So one job's JSON lists every message with its stage, a one-line preview (120 characters; the text stays in
the job's files), the relay's transcript entry that carried it, and its outcome from `inbox/outcomes/`; `relay.lastToolAt`
is the relay guard's record of the relay's last tool call;
`claudeSessionId` is the Claude Code session the job was started from (`launchedBy`), which a relay of the
Agent tool shares. A waiting relay calls about every nine minutes; the gap can pass ten (the Bash tool's limit) by its
own model's step and the guard's lock wait, so a reader that judges a relay lost allows more than that.

### D60. How relay 3.0 is reviewed, proved and released (owner, 22 October 2026)

The owner's decisions after PR #12, in parts. What they touch:

- **D3 and D54.** D54's route, the M3 through Cua Driver, now takes the CLI's screenshots as well as Desktop's.
  D3's manual Desktop pass of the board stands there, with screenshots of every user-facing feature beside it,
  the board's included (part 4).
- **The steering demo.** The release gate "a recording of the steering demo the funding notes ask for" is dropped
  (part 3).

release-3.0.md's "Sequence" and "What the release PR must pass" follow these parts.

The parts:

1. **Phase PRs.** Each merges into `release/3.0` once its gates pass, with a merge commit.
2. **The release PR** is its own PR, `release/3.0` into `main`, with the whole procedure: 3.0.0 everywhere
   `scripts/bump-version.mjs` sets it, the marketplace included; a dated CHANGELOG; a git tag and a GitHub release.
   It merges only on the owner's word. There is no npm release: `package.json` is private, and users install relay
   from the marketplace in this repository (`claude plugin marketplace add libar-dev/relay-plugin-cc`), which
   serves `main`.
3. **No demo recording for 3.0.** Feature screenshots and a user guide replace it.
4. **Screenshots of every user-facing feature**, in the Claude Code CLI and in the Claude desktop app, as proofs
   for the reviews. They are taken on the M3 with Cua Driver, since window screenshots fail on the ThinkPad, and
   they stay local, since they show the account and session names. The status line and the board are captured
   once they are built: the CLI in a narrow and a wide terminal, and Desktop.
5. **A holistic review of the whole `release/3.0` branch** once Phase 4 is merged, before the release PR: GPT-6
   Astra at `xhigh`, as a T3 Code delegate, not a relay job.
6. **A UX and UI review by Opus 5.5** of the user-facing surfaces, with the screenshots: the commands' output, the
   status line, the board (a narrow and a wide terminal, and Desktop), the README, `docs/desktop.md` and the user
   guide.
7. **A review of every skill the plugin ships by GPT-6 Astra**, and of the skills it is missing:
   `plugins/relay/skills/` (jobs with `internals.md`, `grok-home.md` and `kimi-home.md`; codex-prompting with its references;
   result-handling), `agents/job.md` and `commands/`. Opus 5.5 makes the skill updates.
8. **A test-coverage review by Kimi K3 at max effort**, as a T3 Code delegate.
9. **A real-API end-to-end suite gates the release.** The unit tests mock the backends; this suite runs the real
   ones.
   - It is run by hand, locally only, not in CI.
   - It lives in the private smoke kit repository, `libar-dev/relay-plugin-cc-smoke`, which keeps its two research
     tools, the Apify CLI and the Firecrawl CLI.
   - It covers a dynamic Workflow, a plain fan-out with the Agent tool, tool calls from jobs, steering and
     continue, cancel and TaskStop, a refused header, the commands the module answers, the status line and the
     board once built, and every backend.
   - It runs on the release head, on Fedora and on a Mac through cmux. Its last run was on 3.0.0-dev.1, and parts
     of it are stale: `hi-refused` is now refused at the spawn.
10. **T3 Code screenshots for the post to the T3 community** ([t3-code.md](t3-code.md),
    [t3-code-discord-post.md](t3-code-discord-post.md)): relay in a T3 thread on the M3 (a command's output, a
    steered job, a Workflow relay), beside what T3 does not draw (the status line and the board).
11. **A manual test script for the owner.** Once the release candidate is confirmed, the owner tests it by hand on
    one Mac and on Fedora at the same time, and the M1 stays on the released relay as a fallback. One feature
    walkthrough feeds both the script, each step with its expected result, and the user guide, with screenshots
    that explain the features.
12. **Public assets later.** Screenshots of Desktop and the CLI for users, taken in a clean demo setup, when the
    owner decides.

### D64. After the pre-release cuts, a phase PR raises no version (Phase 4 thread)

D6 had each phase PR raise `3.0.0-dev.N`. Since PR #16 the branch carries `3.0.0-pre.1`, and the release lead cuts
each later `3.0.0-pre.N` (the coordination plan: pre.2 after this PR and the fix lead's PR A). A phase PR that raised
`dev.N` now would go backwards (`3.0.0-dev.5` sorts below `3.0.0-pre.1`), and one that set `pre.N` would take the
release lead's cut. So a phase PR keeps the branch's version, and its builds are told apart by their commit, which a
smoke install stamps and `status` names (D28, D37). This PR's live records, run before the cut, name `3.0.0-dev.5`.
