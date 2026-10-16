# Changelog

## Unreleased

- A fourth backend, `backend: kimi`, runs Moonshot AI's Kimi Code through `kimi acp`. Jobs, the
  relay, cancel, continue, recovery, Workflow adoption, both reviews and setup work as on the other
  backends. `kimi-home:` selects the Kimi home (`default` is `~/.kimi-code`, a name is
  `~/.kimi-code-<name>`), and `/relay:setup` lists every Kimi home it finds.
- A running Kimi turn takes no message: a message sent while it runs becomes the next turn.
- Kimi supports `yolo` (Kimi's Never Ask mode) and `read-only` (Kimi's default mode, with every
  permission request rejected and every file write and shell command refused by the plugin), and
  only `web-search: live`.
- A Kimi turn's outcome and report come from the session's own record, because Kimi's ACP layer
  answers `end_turn` for a turn that failed.
- A failed adversarial-review turn says the turn failed and gives the backend's error, on every
  backend. It was shown as invalid structured JSON with the turn's error as the parse error, and on
  Codex a whole answer sent before the failure was shown as findings. `<backend> returned no valid
  review JSON` stays for an answer that came back and is not review JSON.
- Claude can invoke `/relay:review`, `/relay:adversarial-review`, `/relay:status` and
  `/relay:result` itself; they were user-only. A review Claude starts never asks a question: without
  `--wait` or `--background` it runs in the foreground. `/relay:cancel` and `/relay:transfer` stay
  user-only.
- The tests that wait for an orphaned process accept a child subreaper, such as `systemd --user`,
  as its new parent, so they pass on Linux desktops.
- The docs say why `yolo` is the default: existing headers and Workflow scripts keep running as
  they did. A live check found `write` with `network: true` enough for web search, installs,
  commits and child processes on Codex and Grok, but not for `ps` or writes outside the working
  directory. The 2.0.0 entry below gave the earlier reason.
- The docs say what the stop gate can attribute (Claude's last message and the working tree as it
  stands, no diff of the turn), when `cancel` still signals after the process table becomes
  unreadable, and how a new backend is probed, tested and checked before it ships.

## 2.0.0

The first public release. `relay` runs jobs on Codex (GPT), Grok Build and ZCode (GLM) from Claude
Code like Claude agents.

- A `relay:job` agent, launched with the Agent tool or from a Workflow script, runs one job on
  another provider's harness and returns its report verbatim with a state block.
- `SendMessage` steers a running job and continues a finished one; the message `cancel` cancels it.
  Jobs survive the Claude session. After a server death, or a worker death while a relay agent
  waits on the job, the job resumes its session once per stretch of user work.
- Reviews and adversarial reviews run on all three backends. `/relay:setup` checks every backend
  without a model call. An optional stop-time review gate and session transfer run on Codex.
- Needs Claude Code 2.1.271 or later, Node.js 22 or later, macOS or Linux, and at least one of the
  Codex CLI, Grok Build or ZCode, signed in.

Compared with the development releases below:

- The three backends sit behind one contract (`docs/backends.md`). Each backend declares its
  capabilities once, and the header check, setup's `can:` line and the review commands derive from
  that declaration. Workers and reviews drive every backend through one connection interface.
- `job.json` always carries `request.backend`. A backend's own record lives under `backendState`.
- Settings live in the jobs home (`$RELAY_JOBS_HOME`, default `~/.relay-jobs`), and only
  `/relay:setup` writes them. An unknown header key is a usage error.
- Node.js 22 or later is required. macOS and Linux are supported, because the process sweep reads
  the process table with `ps`.
- The default `mode` stays `yolo`, because jobs need the network and web search. The brief is then
  the only fence, so name where a job may write.
- Codex's adversarial review runs through the same backend connection as a job.
- The prompting skill for Codex and GPT jobs is `codex-prompting`.
- A message whose attempt ended the job, such as a continuation whose session failed to resume,
  stays owed for `resume`. The plugin no longer starts a second worker for it on its own, which
  made the number of attempts depend on timing.
- A Grok turn that Grok cancels while its queue still lists entries ends as interrupted. It used
  to wait for a queue notification that Grok does not always send, which held the job `running`.

## Before 2.0.0

The development releases 2.0.0-fork.1 to 2.0.0-fork.17. Each line is a capability as it stands in 2.0.0.

- **Jobs as agents.** A `relay:job` agent runs one job and hands back the report with a state block,
  so the main thread treats a job like a Claude agent.
- **A relay that carries nothing.** Hooks read the prompt from the relay's transcript, deliver its
  messages and write its report, because a model that retypes text drops and adds to it. The relay
  runs on Haiku.
- **Steering.** A message sent while the job runs reaches the running turn within about two
  minutes, and one sent after the job ended starts a new turn on the same session, as `SendMessage`
  does with a Claude agent.
- **Cancel.** The message `cancel` interrupts the turn and, if the job has not ended 10 seconds
  later, stops the worker, the server and its snapshotted descendants. See `docs/design.md` for
  the process limits.
- **One worker and one server per job.** Each job has its own directory, detached worker and backend
  server, with no shared broker or state file, so concurrent workers do not overwrite another
  job's record.
- **Jobs outlive the session.** Jobs belong to no Claude session; `TaskStop` and the session's end
  leave them running.
- **Every message runs once or is reported.** Messages go through an inbox with recorded outcomes,
  and their ids are checked against the resumed session's history, so none runs twice or vanishes.
- **Recovery.** A server that dies mid-turn, or a relay job's worker, is resumed once on the same
  session, and the state block records it as `automatic-resume:`.
- **Capacity retries.** On Codex and Grok, model-capacity and request-rate failures retry after 30,
  60 and 120 seconds without repeating work already done; a usage quota fails at once.
- **Workflow scripts.** `agent(prompt, { agentType: 'relay:job' })` returns the state block as a
  string, so a script can fan work out to other providers; `schema` is refused with a sentence that
  names the fix.
- **Workflow adoption.** A relay the Workflow harness starts over can take over its predecessor's
  job by the run journal's key. This avoids a second job on a retry or a resumed run. Failed and
  cancelled jobs are not adopted; without a journal key, only a retry label can trigger adoption.
- **Quiet waits.** A relay's two-minute wait on a running job exits 0, so the `/workflows` view no
  longer shows a long job as an error.
- **Grok Build.** `backend: grok` runs jobs through Grok's ACP server, with separate Grok homes,
  Grok's sandbox profiles, and steers confirmed against Grok's own session history.
- **GLM on ZCode.** `backend: zcode` runs GLM on ZCode, Z.ai's harness for GLM's native interface,
  with model names matched in any case and recovery by command id.
- **Reviews on every backend.** `/relay:review` and `/relay:adversarial-review` take `--backend`, so
  a second opinion can come from any subscription, and every adversarial answer is checked against
  the review schema.
- **One setup page.** `/relay:setup` checks every backend home without a model call, so one command
  shows which backends are ready and what each can do.
- **Fast tier switch.** `fast: true` selects OpenAI's priority tier only after
  `setup --fast-tier allowed`, so spending one account's priority usage is a deliberate choice.
- **Lean Codex jobs.** `setup --job-mcp-off` turns off chosen MCP servers for Codex jobs, so a job
  does not start local servers it does not use.
- **A quiet stop gate.** The optional stop-time review gate is off by default, runs on Codex, and
  blocks only on a real `BLOCK:` answer, because a gate that blocks on its own failure traps the
  session.
- **Transfer.** `/relay:transfer` imports the current Claude Code session into a Codex session, so
  the work can go on in the Codex CLI with `codex resume`.
- **Manual prune.** `prune` removes old ended jobs when asked, and nothing else removes a job, so no
  report disappears unasked.
- **Fixes to the original plugin.** Dead workers read as dead, a turn ends when its server exits,
  thread names are cut by code point, efforts pass through unchecked, cancel reaches a job started
  in a shell's foreground, a failed turn keeps its error, a job in a linked worktree can commit,
  and SessionStart writes each export once.

## 1.0.6 and earlier

`relay` started as a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
1.0.6; the releases up to it are that project's work.
