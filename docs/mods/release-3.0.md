# relay 3.0: how it is built and released

relay 3.0.0 is Phases 1 to 5 of [the plan](plan.md), released together for the fleet and for the first public
publication, with Phase 6's report ([decisions.md](decisions.md), D1). This page is the working agreement for every thread that builds
it: where the work goes, what each step must pass, and how the work was done in Phase 1.

## Branches and versions

- `release/3.0` starts at `main` @ e961d9a. Each phase is a branch `mods/phase-<n>-<slug>` from the tip of
  `release/3.0`, and a PR into it, merged with a merge commit once its gates pass.
- `main` and the M1 stay on 2.2.0 until the release PR merges `release/3.0` into `main`. The M3 and the ThinkPad
  run the pre-release cuts (D95).
- The branch carries `3.0.0-dev.N`, and each phase PR raises N with `node scripts/bump-version.mjs` (D6). A
  pre-release cut sets `3.0.0-pre.N` and is tagged `v3.0.0-pre.N` (D70). The release PR sets 3.0.0 and dates the
  CHANGELOG.
- Each phase adds its entries under the CHANGELOG's 3.0.0 heading, and records its forks in decisions.md.
- Threads that work in parallel take decision numbers from the blocks the coordinating thread assigns them, so
  their entries never collide; a PR that merges after another puts its entries in numeric order.

## Sequence

1. **Phase 1, steer wake.** Done (PR #7).
2. **Phase 5's suite runner** (PR #8, `mods/phase-5-suite`). `scripts/live/suite.mjs`: one runner, a registry of
   checks, one record per check and backend in `docs/live/records/`, the terminal and T3 as surfaces, and the
   capability table `docs/live/capabilities.md` generated from the records. Every later phase adds its checks to
   `scripts/live/checks/`.
3. **Phases 2 and 3**, as two PRs that can run at the same time: commands answered by the module (Phase 2, PR
   #10), and the spawn check with TaskStop cancelling the job (D2; Phase 3, PR #11). Both add hooks to
   `hooks/mod/register.js`; whichever merges second rebases.
4. **Phase 4**, in this order: the companion's `--json` changed in place (the board reads it), the status line,
   the board pane.
5. **Phase 6**, the investigation report, at any point. No code (PR #9). Reported in
   [messages-from-a-job.md](messages-from-a-job.md).

Steps 6 to 8 start while Phase 4 is open; each part starts once what it needs has merged. Pre-release cuts run
beside them (see "Pre-release cuts" below): pre.1 from the tip after #14, pre.2 once Phase 4's `--json` and the
typed-message fix merge, and more as Phase 4 lands and the owner's issues are fixed.

6. **The real-API suite**, in the private smoke kit repository `libar-dev/relay-plugin-cc-smoke`, run by hand and
   locally only; the kit keeps its Apify and Firecrawl CLIs. It runs the real backends where the unit tests mock
   them: a dynamic Workflow, a plain fan-out with the Agent tool, tool calls from jobs, steering and continue,
   cancel and TaskStop, a refused header, the commands the module answers, the status line and the board once
   built, on every backend. It does not wait for Phase 4, and adds the status line and the board when they merge.
7. **The reviews**, as T3 Code delegates, each given the brief and the code:
   - After Phase 4's `--json` PR, which changes the jobs skill: GPT-6 Astra's review of every skill the plugin
     ships and the ones it is missing, `agents/job.md` and `commands/`, and Kimi K3's test-coverage review at max
     effort. Opus 5.5 makes the skill updates and fixes the texts that promise for every relay what holds only
     for a relay started with the Agent tool ([plan.md](plan.md#after-phase-6-what-held-and-what-changed)), in
     one PR; the coverage fixes are another PR. Once the status line and the board merge, a second pass of both
     reviews covers them, and brings those texts in line with the board's live checks of a Workflow relay.
   - After Phase 4: GPT-6 Astra's review of the whole `release/3.0` branch against `main`, at `xhigh`. And, once
     step 8's screenshots and guide exist, Opus 5.5's UX and UI review, with the screenshots, of the commands'
     output, the status line, the board, the README, `docs/desktop.md` and the user guide. Their fixes merge
     before the release PR.
8. **The screenshots, the walkthrough and the guide.** Screenshots of every user-facing feature, in the CLI and
   in Desktop, taken on the M3 (D54, D60), with the status line and the board once built (the CLI in a narrow and
   a wide terminal, and Desktop); they stay local. T3 screenshots for the post to the T3 community. One feature
   walkthrough, which feeds the owner's manual test script (each step with its expected result) and the user
   guide (with screenshots that explain the features). A screenshot that is published, in the T3 post or the
   user guide, shows no account or session names.
9. **The release PR**, `release/3.0` into `main`.
10. **The owner's testing.** Production use of each cut on the M3 and the ThinkPad, with the guide lead's
    pre-release guide as its checklist; the M1 stays on 2.2.0 as a fallback (D95). Once the release candidate is
    confirmed (decisions.md, "Open for the owner"), and on the owner's word, the release PR merges with a merge
    commit, and `v3.0.0` is tagged and published as a GitHub release.
11. **The fleet update, then the publication**, when the owner decides. The merge already makes 3.0.0 what the
    marketplace serves; the publication is the T3 post and, later, public screenshots for users, taken in a
    clean demo setup.

## What a phase PR must pass

- `npm test`, `npm run check`, `claude plugin validate plugins/relay`, `claude plugin test plugins/relay`, and CI.
- A review by two model families before the bots: GPT-6.1 Sol through relay, and Opus 5.5. Each gets the brief
  and the code, not the author's conclusions.
- CodeRabbit and Greptile, followed with T3's `watch_pull_request`. A finding is answered on its thread when it
  is fixed or declined, then the thread is resolved.
- When the phase changes plugin code: its own checks in the live suite, in the terminal and in T3, on the Fedora
  ThinkPad, with their records committed and `docs/live/capabilities.md` regenerated
  (`node scripts/live/suite.mjs table`); and the smoke kit (`relay-plugin-cc-smoke`) on the PR's head, installed
  with `scripts/smoke/install-local.sh`. A phase that changes no plugin code, such as Phase 6's report, raises no
  version and runs neither (D51).
- Its last commit updates plan.md: a review of every later phase in light of what the PR learned (the plan's
  rule 7), and the CHANGELOG and decisions.md entries.

Other PRs into `release/3.0`, such as the reviews' fixes, pass the same gates, except the review of every later
phase; their last commit updates the CHANGELOG and decisions.md.

## What the release PR must pass

D60 added the real-API suite, the screenshots, the walkthrough with its test script and guide, and the reviews,
and dropped the demo recording: feature screenshots and the user guide replace it.

- `npm test`, `npm run check`, `claude plugin validate plugins/relay`, `claude plugin test plugins/relay`, CI,
  CodeRabbit and Greptile.
- The full live suite on all four backends, in the terminal and in T3, on the release head.
- The real-API suite, which replaces the smoke kit's release run, on the release head, on Fedora and on a Mac
  through cmux.
- D3's checks of the board: its Mod tests on the test kit's `desktop` mount, which `claude plugin test` runs on
  Fedora, and the manual Desktop pass on the M3 (D54).
- The screenshots of every user-facing feature, in the CLI and in Desktop, the status line and the board included.
- The feature walkthrough done, the user guide in the release, and the owner's manual test script ready.
- The reviews of step 7 done, and their fixes merged: the skills review with Opus 5.5's skill updates, the
  coverage review, the review of the whole branch, and the UX and UI review.
- The texts that promise for every relay what holds only for a relay started with the Agent tool, fixed:
  design.md's interface table and "Under the Workflow tool", the jobs skill's message rules, `agents/job.md` on
  continue and cancel, and the CHANGELOG's Phase 1 line on messages from other agents. The docs say what a
  Workflow relay does with a steer, a continue and the message `cancel`, and each claim rests on a live check or
  is marked unmeasured ([plan.md](plan.md#after-phase-6-what-held-and-what-changed)).
- The capability table, generated from the suite's records, in the README.
- The smoke kit's `SMOKE-TEST.md` current for 3.0.
- 3.0.0 everywhere `scripts/bump-version.mjs` sets it, the marketplace included, and the consolidated CHANGELOG,
  dated.
- Every fleet machine's marketplace pinned to a tag: the M1 to `#v2.2.0`, the cut machines to their cut. A
  marketplace with no ref follows `main`, and an update round would move it to 3.0.0 before the owner's fleet
  update.

The PR merges only on the owner's word, after the owner's testing, with a merge commit; then the tag
`v3.0.0` and a GitHub release. There is no npm release: users install relay from this repository's marketplace,
which serves `main`, so the merge is what makes 3.0.0 available. Then the fleet update, then the publication, each
when the owner decides.

## Pre-release cuts

D95 and D70. A cut is a PR into `release/3.0` that runs `node scripts/bump-version.mjs 3.0.0-pre.N` and adds one
line under the CHANGELOG's 3.0.0 heading. It passes `npm test`, `npm run check`, `claude plugin validate`,
`claude plugin test` and CI, and the end-to-end suite has passed on its plugin code on Fedora and on the M3 through
cmux. Its merge commit is tagged `v3.0.0-pre.N` and pushed; no GitHub release, no npm. The two-family review and the
bots may follow the merge, and what they find goes into the next cut.

libar-infra installs the cut on the M3 and the ThinkPad with its fleet tool, in a terminal the owner watches:

1. **A quiet moment.** No relay job starting or running (`companion status --all`), and no session holding a
   Workflow of relays. `claude plugin marketplace remove` uninstalls every plugin of that marketplace and deletes
   their `enabledPlugins` entries from every settings file. Copy `~/.claude/settings.json` first.
2. **Switch.** `claude plugin marketplace remove libar-relay`, `claude plugin marketplace add
   'libar-dev/relay-plugin-cc#v3.0.0-pre.N'`, `claude plugin install relay@libar-relay`.
3. **Check.** `claude plugin list` shows `3.0.0-pre.N`; a new session's `/relay:status` says `relay-version:
   3.0.0-pre.N`; `~/.claude/settings.json` differs from the copy only in plugin and marketplace entries.
4. **Sessions.** A session that started before the switch keeps the build it loaded until its plugins reload; new
   ones run the cut.
5. **The way back** is the same with `#v2.2.0`.

No mixed versions across a resume: switch only while nothing runs, and never in the middle of a Workflow. A Workflow
started under one version finishes, or is abandoned and its jobs cancelled, under that version. Adoption across
versions is untested.

## How the work is done

What worked in Phase 1:

- The lead thread writes a contract (the spec every worker follows) and one brief per worker, as files, and
  gives each worker its own files in the shared checkout. Workers never commit; the lead reviews and commits.
- Code workers: GPT-6.1 Sol (`effort: high`) for core code, GPT-6 Astra for tooling and scripts, Opus 5.5 for the
  Mod API. They run as relay jobs from a Workflow script (the owner's rule: only a Workflow job can be taken over
  if the lead dies). The Mod API's declarations come with the `plugin-authoring` skill; load it and copy its
  `types/claude-code.d.ts` and `reference.md` to a scratch folder for the workers. Never write under
  `~/.claude/dev-mods`.
- Live checks are the suite's. In the terminal, `node scripts/live/suite.mjs run all` (or `run <check>`, with
  `--backends`) runs each check in a tmux pane on a private socket, with `--plugin-dir`, a fresh jobs home, the
  per-session bypass setting and a Sonnet lead, and fails the run when `~/.claude/settings.json` changed. A check
  that needs another plugin names a probe Mod from `scripts/live/probes/`, loaded with a second `--plugin-dir`;
  such a check runs in the terminal only.
- In T3, the lead installs the build into the smoke folder (`scripts/smoke/install-local.sh
  ~/dev-libar/relay-plugin-cc-smoke`), runs `node scripts/live/suite.mjs prepare <check> --surface t3 --work-dir
  ~/dev-libar/relay-plugin-cc-smoke`, and sends the printed prompt as the first message of a new thread of the T3
  project `relay-plugin-cc-smoke` (`t3_thread_launch`, Sonnet). It follows the thread with `t3_thread_wait`,
  sends a message if the thread stops before the check's marker, and then runs `node scripts/live/suite.mjs analyze
  <run id>`, which finds the thread's transcript by the prompt's first line.
- The smoke kit run, a phase PR's gate: `scripts/smoke/install-local.sh ~/dev-libar/relay-plugin-cc-smoke`, then
  `scripts/smoke/pane.sh start relay-smoke ~/dev-libar/relay-plugin-cc-smoke -- claude
  --dangerously-skip-permissions --settings '{"skipDangerousModePermissionPrompt":true}'`, then the kit's workflow
  with `args {"dir": "/home/darkomijic/dev-libar/relay-plugin-cc-smoke"}` and its plain fan-out, then
  `scripts/smoke/uninstall-local.sh`. For T3, the T3 project `relay-plugin-cc-smoke` points at that folder, and
  its threads load the installed build.

## What Phase 3 learned about the tools

- Claude Code keeps one marketplace registry per config, so two smoke folders cannot both hold `relay@relay-smoke`.
  A second folder installs with `scripts/smoke/install-local.sh DIR --name relay-smoke-<suffix>`; the receipt keeps
  the name, and `uninstall-local.sh` reads it.
- A command hook's output reaches the transcript as an attachment (`hook_additional_context`, with the tool call's
  id), so a check can prove the hook ran and what it said.
- `pane.sh pid NAME` prints the pane's process id, which is Claude's. Scanning process arguments for a session id
  is no proof: the tmux server keeps the command line of the session that started it.
- A lead told to pass a script verbatim may end it with a newline.
- `suite.mjs analyze --from-copy` rewrites `run.json`, `details.jsonl` and `records.jsonl` in the run's folder; a
  read-only replay copies the folder under `/tmp` and points `RELAY_LIVE_HOME` at the copy.

## What Phase 1 learned about the tools

- Claude Code (2.1.308) blocks a standalone `sleep` in Bash. In T3 a Monitor does not start a new turn after the
  turn ended, so the suite's prompts have the lead wait in foreground Bash until-loops and keep its turn until it
  prints the marker; background agents' completion notices still arrive between its tool calls.
- A folder Claude Code has not seen shows a trust dialog whose default is "No, exit": `pane.sh trust` answers it.
- `pane.sh wait` matches each screen line; the prompt you sent is on the screen too, so wait for text only the
  answer holds.
- `--plugin-dir` makes Claude Code write `.claude-plugin/types/` and a `tsconfig.json` into the plugin folder;
  both are ignored by git.
- The Mod test kit runs only `*.test.ts`; `claude plugin validate` and `claude plugin test` need no sign-in.
- `$.agent.list()` holds no Workflow agent. A message from another agent reaches a relay as origin kind `peer`.
- Never set `CLAUDE_CONFIG_DIR` and never answer a dialog that stores a choice (D13). Check
  `~/.claude/settings.json` against a copy taken before a live run.

## What Phase 2 learned about the tools

- A check whose subject is a slash command sends the prompt (with its run line) first; `prepare` prints the commands
  to send after the marker. In T3, send each as its own message with `t3_thread_send` and wait until the thread is
  idle before the next. T3 passes a slash command to Claude Code as a command, arguments included.
- Claude Code 2.1.308 shows and records a command a plugin answered without its arguments, and prompt history keeps
  no such command. The module's answer starts with the command as typed, and the checks read the arguments there.
- The terminal and T3 draw a command's text as Markdown; T3 runs a paragraph's lines together.
- `claude -p` exits with a command's `exitCode` under `--output-format text` and `json`, and 0 under `stream-json`;
  only the stream has the init event that lists the loaded plugins and their paths.
- `scripts/smoke/install-local.sh` stamps the export with its commit (`.claude-plugin/build.json`), and `status`
  shows it, so a T3 check proves the build that answered even when two builds share a `3.0.0-dev.N`. Install, then
  start a new thread: a thread that started before the install keeps the module it loaded.
- `pane.sh` starts panes at 200 columns. `tmux -S <socket> resize-window -t <pane> -x 100` narrows one; the socket
  is in `pane.sh attach-command`'s output.

## What Phase 6 learned about the tools

- A `SendMessage` from a background subagent or a Workflow agent to `"main"` starts a turn of an idle main thread,
  in the terminal and in T3. A busy one reads it when its current tool call returns.
- A message by agent id to a running Workflow agent starts a second loop of that agent, and the original loop
  never reads it. A message to a Workflow agent that has ended fails, or resumes it as `general-purpose`.
- A module's `$.session.send` always sends as the main conversation, from any loop.
- The guard reads the transcript a job recorded at start. After a Workflow agent forks, Claude Code can write
  later entries to `subagents/agent-<id>.jsonl` instead.
