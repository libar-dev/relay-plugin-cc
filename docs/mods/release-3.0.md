# relay 3.0: how it is built and released

relay 3.0.0 is Phases 1 to 5 of [the plan](plan.md), released together for the fleet and for the first public
publication ([decisions.md](decisions.md), D1). This page is the working agreement for every thread that builds
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
2. **Phase 5's suite runner.** It turns `scripts/live/steer-wake.mjs` into the first check of a suite: one
   runner, one record per check (backend, model, relay version, Claude Code version, surface, timings, result),
   the terminal and T3 as surfaces, and a capability table generated from the records. Every later phase adds its
   checks to it.
3. **Phases 2 and 3**, as two PRs that can run at the same time: commands answered by the module, and the spawn
   check with TaskStop cancelling the job (D2). Both add hooks to `hooks/mod/register.js`; whichever merges second
   rebases.
4. **Phase 4**, in this order: the companion's `--json` changed in place (the board reads it), the status line,
   the board pane.
5. **Phase 6**, the investigation report, at any point. No code.
6. **The release PR**, `release/3.0` into `main`.

## What a phase PR must pass

- `npm test`, `npm run check`, `claude plugin validate plugins/relay`, `claude plugin test plugins/relay`, and CI.
- A review by two model families before the bots: GPT-6.1 Sol through relay, and Opus 5.5. Each gets the brief
  and the code, not the author's conclusions.
- CodeRabbit and Greptile, followed with T3's `watch_pull_request`. A finding is answered on its thread when it
  is fixed or declined, then the thread is resolved.
- The phase's own checks in the live suite, in the terminal and in T3, on the Fedora ThinkPad.
- The smoke kit (`relay-plugin-cc-smoke`) on the PR's head, installed with `scripts/smoke/install-local.sh`.
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
- Live checks run in a tmux pane on a private socket, with `--plugin-dir`, a fresh jobs home and the per-session
  bypass setting: `node scripts/live/steer-wake.mjs --model sonnet` is the model. Probes for one-off cases
  (another plugin's `$.session.send`, a Workflow agent's send) are small Mods loaded with a second `--plugin-dir`.
- The release smoke test: `scripts/smoke/install-local.sh ~/dev-libar/relay-plugin-cc-smoke`, then
  `scripts/smoke/pane.sh start relay-smoke ~/dev-libar/relay-plugin-cc-smoke -- claude
  --dangerously-skip-permissions --settings '{"skipDangerousModePermissionPrompt":true}'`, then the kit's workflow
  with `args {"dir": "/home/darkomijic/dev-libar/relay-plugin-cc-smoke"}` and its plain fan-out, then
  `scripts/smoke/uninstall-local.sh`. For T3, the T3 project `relay-plugin-cc-smoke` points at that folder, and
  its threads load the installed build.

## What Phase 1 learned about the tools

- Claude Code (2.1.308) blocks a standalone `sleep` in Bash. A lead that has to wait uses a Monitor with an
  until-loop; in T3 a Monitor does not start a new turn after the turn ended, so a T3 check is driven by messages.
- A folder Claude Code has not seen shows a trust dialog whose default is "No, exit": `pane.sh trust` answers it.
- `pane.sh wait` matches each screen line; the prompt you sent is on the screen too, so wait for text only the
  answer holds.
- `--plugin-dir` makes Claude Code write `.claude-plugin/types/` and a `tsconfig.json` into the plugin folder;
  both are ignored by git.
- The Mod test kit runs only `*.test.ts`; `claude plugin validate` and `claude plugin test` need no sign-in.
- `$.agent.list()` holds no Workflow agent. A message from another agent reaches a relay as origin kind `peer`.
- Never set `CLAUDE_CONFIG_DIR` and never answer a dialog that stores a choice (D13). Check
  `~/.claude/settings.json` against a copy taken before a live run.
