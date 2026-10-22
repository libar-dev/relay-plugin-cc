# relay 3.0: how it is built and released

relay 3.0.0 is Phases 1 to 5 of [the plan](plan.md), released together for the fleet and for the first public
publication, with Phase 6's report ([decisions.md](decisions.md), D1). This page is the working agreement for every thread that builds
it: where the work goes, what each step must pass, and how the work was done in Phase 1.

## Branches and versions

- `release/3.0` starts at `main` @ e961d9a. Each phase is a branch `mods/phase-<n>-<slug>` from the tip of
  `release/3.0`, and a PR into it, merged with a merge commit once its gates pass.
- `main` and every fleet machine stay on 2.2.0 until the release PR merges `release/3.0` into `main`.
- The branch carries `3.0.0-dev.N`, and each phase PR raises N with `node scripts/bump-version.mjs` (D6). The
  release PR sets 3.0.0 and dates the CHANGELOG.
- Each phase adds its entries under the CHANGELOG's 3.0.0 heading, and records its forks in decisions.md.

## Sequence

1. **Phase 1, steer wake.** Done (PR #7).
2. **Phase 5's suite runner** (PR #8, `mods/phase-5-suite`). `scripts/live/suite.mjs`: one runner, a registry of
   checks, one record per check and backend in `docs/live/records/`, the terminal and T3 as surfaces, and the
   capability table `docs/live/capabilities.md` generated from the records. Every later phase adds its checks to
   `scripts/live/checks/`.
3. **Phases 2 and 3**, as two PRs that can run at the same time: commands answered by the module (Phase 2, PR
   #10), and the spawn check with TaskStop cancelling the job (D2). Both add hooks to `hooks/mod/register.js`;
   whichever merges second rebases.
4. **Phase 4**, in this order: the companion's `--json` changed in place (the board reads it), the status line,
   the board pane.
5. **Phase 6**, the investigation report, at any point. No code (PR #9). Reported in
   [messages-from-a-job.md](messages-from-a-job.md).
6. **The release PR**, `release/3.0` into `main`.

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

## What the release PR must pass

- The full live suite on all four backends, in the terminal and in T3, and the smoke kit, on the release head.
- One smoke run on a Mac, through cmux, and the manual Desktop pass for the board (D3).
- The capability table, generated from the suite's records, in the README.
- The consolidated CHANGELOG, the version 3.0.0, and a recording of the steering demo the funding notes ask for.
- Then the fleet updates, then the publication. The owner decides the timing of both.

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
- The release smoke test: `scripts/smoke/install-local.sh ~/dev-libar/relay-plugin-cc-smoke`, then
  `scripts/smoke/pane.sh start relay-smoke ~/dev-libar/relay-plugin-cc-smoke -- claude
  --dangerously-skip-permissions --settings '{"skipDangerousModePermissionPrompt":true}'`, then the kit's workflow
  with `args {"dir": "/home/darkomijic/dev-libar/relay-plugin-cc-smoke"}` and its plain fan-out, then
  `scripts/smoke/uninstall-local.sh`. For T3, the T3 project `relay-plugin-cc-smoke` points at that folder, and
  its threads load the installed build.

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
