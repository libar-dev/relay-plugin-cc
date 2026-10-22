# Messages from a job: what each backend allows

Phase 6 of [the plan](plan.md#phase-6-messages-from-a-job-investigation-no-code-yet) asked whether a relay job can
send a message to the agent that started it, or to a peer, the way a Claude subagent can with `SendMessage`. It
asked for three answers before any code is written. Can each backend be given a "send to lead" tool, an MCP
server the relay adds to the job? Can the message be delivered on the Claude side as the relay agent's own? And
how would a reply find its way back? This report gives them. Nothing in the plugin changed. Messages from a job
stay out of the [capability table](../live/capabilities.md) until a live check proves them.

The measurements were made on 22 October 2026 on the Fedora ThinkPad, with Claude Code 2.1.308, Codex 0.163.0,
Grok Build 1.0.67, ZCode 3.16.2 (runtime 0.17.0) and Kimi Code 2.2.0. They come from separate experiments, not
from one run of relay end to end:

- **The backends.** Four workers each drove one backend directly, with relay's own launch settings and a probe
  MCP server that logs every request: GPT-6.1 Sol for Codex and ZCode, GPT-6 Astra for Grok and Kimi. No relay
  job ran in these.
- **Claude Code.** Two Opus 5.5 workers ran Claude Code sessions in tmux panes, with Sonnet as the lead. One
  measured the routes `SendMessage` already has, the other what a module and a plugin's hooks can do.
- **T3 Code.** The lead repeated four of the routes in T3 threads: an agent's message to a busy and to an idle
  lead, from a background subagent and from a Workflow agent.
- **A relay under the Workflow tool.** The lead ran one `relay:job` Workflow agent on Codex, on the 3.0.0-dev.2
  build, in the terminal: a steer while it ran, a continue after it ended.

The drivers, protocol logs and transcripts stay on the test machine (`~/dev-libar/relay-context/mods-phase-6/`), as
the live suite's evidence does ([D19](decisions.md)). They hold local paths and job data.

## The answers

1. **Every backend takes the tool.** Each accepts a client-supplied stdio MCP server for one session, with the
   environment and arguments the client gives it. Each starts the server when the session opens and keeps it
   across turns. None remembers it: relay would declare it again on every open, a continue and a recovery
   included. The backends differ in four ways that decide the design: the modes where the call is allowed, how
   long one call may wait, whether a message reaches the model while the call waits, and what happens to the
   user's other MCP servers.
2. **The module cannot send as the relay agent.** A module's `$.session.send` always sends as the main
   conversation, from whatever agent's loop its hook runs in. To `"main"` it is refused, and a peer reads it as a
   message from "the coordinator". The relay agent can send as itself. Give it the `SendMessage` tool, and let
   the `PreToolUse` guard rewrite the call's `message` and `to` with `updatedInput`, as the guard already rewrites
   a hand-back. Measured in the terminal with a stand-in agent type: the receiver gets the outbox's exact text, from
   the agent's name or id, and an idle lead starts a turn on it within 0.2 s. A plain `SendMessage` to an idle
   lead starts a turn in T3 too.
3. **A reply comes back two ways.** A reply to a note is the lead's `SendMessage` to the relay, which relay
   already delivers as a steer or a next turn. The answer to a question the job is waiting on must be the waiting
   tool call's result, because a steer ends that wait on no backend. Codex shows the model a steer while the call
   still waits. Grok and ZCode hold it until the call returns. Kimi takes no message during a turn, so relay holds
   it for the next turn.

One finding concerns relays under the Workflow tool, the way the fleet runs them. A message by agent id to a
running Workflow agent starts a second loop of that agent, and the original loop never reads it. In the one relay
run, a steer still reached the job, through the second loop. A message to a Workflow relay that has ended
continues nothing. This bears on any reply to a Workflow relay, on cancelling one by message, and on Phase 4's
Steer and Continue buttons ([below](#relays-under-the-workflow-tool)).

## What each backend allows

| | Codex | Grok | ZCode | Kimi |
|---|---|---|---|---|
| How the server is added | `thread/start` and `thread/resume` `config`, as dotted keys `mcp_servers.<name>.command`, `.args`, `.env`, …; or `-c` at the app-server's launch | `mcpServers` on ACP `session/new` and `session/load`: `{name, command, args, env: [{name, value}]}` | `mcpServers` in the v4 `createSession` payload, and in `session/resume`, with `env` as `[{name, value}]` and `protocolVersion: "legacy"` | `mcpServers` on ACP `session/new` and `session/load`, as on Grok |
| When it starts | as the thread opens; one process per thread | as the session opens, before the first prompt; one per session | as the session opens; one per session by default (one per workspace with `isolation: "workspace"`); without `protocolVersion: "legacy"`, ZCode starts it twice while it negotiates | as the session opens; one per session |
| A session reopened in a new process | has the tool only if the open declares it again | the same | the same; a resume of a session still in memory ignores a new list | the same |
| What the server is given | the declared `env`, `args` and `cwd`; of the parent's environment only `HOME`, `PATH`, `SHELL`, `USER`, the locale and a few more, plus `env_vars` | the declared `env` and `args`, and the backend's environment | the declared `env` and `args`, a filtered copy of the backend's environment; each call's `_meta` names the session and turn | the declared `env` and `args`, and the backend's environment |
| The tool's name, as the model sees it | `mcp__<server>__<tool>` | `<server>__<tool>`, found with Grok's `search_tool` and run with `use_tool` | `mcp__<server>__<tool>` | `mcp__<server>__<tool>` |
| `yolo` | runs | runs; no permission request | runs; no permission request | runs; no permission request |
| `write` | refused inside Codex ("requires approval, but approval policy is never") unless the server's config sets `default_tools_approval_mode = "approve"`; no request reaches the client | runs, no request, but the server runs inside the `workspace` sandbox: one that wrote outside the working directory failed to start | no such mode | no such mode |
| `read-only` | as `write` | Grok refuses to start its `read-only` profile on this machine | a permission request names the tool; relay denies every such request today, and an allow-once answer works; after a cold resume the tool runs only if relay's allowlist names it | a permission request names the tool; relay rejects every such request today, and `approve_once` for that one tool works |
| How long one call may wait, by default | 300 s (the docs say 60); `tool_timeout_sec` raises it | no limit reached in 12 minutes (the docs say 6,000 s); `tool_timeout_sec` in a config file works, no protocol field was found | 30 s; the declaration's `timeoutMs` raises it | 60 s; `KIMI_MCP_TOOL_TIMEOUT_MS` at launch raises the session's default; a server's own configured timeout takes precedence |
| Relay's cancel, while a call waits | `turn/interrupt` ends the turn but never tells the server: its call waits on until it is answered, its own deadline passes or the app-server exits | `session/cancel` sends the server `notifications/cancelled` | `stop` sends `notifications/cancelled` | `session/cancel` sends `notifications/cancelled`; Kimi also sends it at a turn's end for calls already answered |
| A message while a call waits | `turn/steer` is accepted; the model read it 1.5 s later, while the call still waited | `_x.ai/interject` answers `queued`; the model gets it after the call returns | `guide` is accepted; it joins the turn after the call returns | Kimi refuses a prompt during a turn ("another turn is already in progress"); relay sends none, and holds the message for the next turn |
| The answer as the call's result | the model uses it in the same turn | the same | the same | the same |
| The user's other MCP servers | load beside the declared one; relay's `job-mcp-off` flags hold only with dotted keys, since a nested `mcp_servers` table undid them | load beside it; a declaration wins over a server of the same name, but that name's timeout and trust settings still apply, and an untrusted project's definition of that name suppresses it | a nonempty list replaces the user's and the project's standalone servers, whatever their names; plugins' servers stay | load beside it; a declaration shadows a home entry of the same name |

Four rows decide what relay could promise:

- **Modes.** In `yolo` the tool works on every backend with no change to how relay answers requests. In Codex's
  `write` and `read-only`, the server's own config must approve its tools. ZCode's and Kimi's `read-only` need
  relay to allow exactly its own tool in a request it now denies, and ZCode's resumed allowlist must name it.
  Grok's `write` confines the server to the working directory, so a server that writes into the jobs home cannot
  work there. It would need another channel to the worker, or no tool in that mode.
- **Waiting.** A question the job waits on ends at the backend's limit unless relay raises it: 30 s on ZCode,
  60 s on Kimi. Codex's 300 s and Grok's documented 6,000 s are longer than a bounded question needs. Codex does
  not tell the server when a turn is interrupted, so the server must bound its own wait.
- **A message while the call waits.** It never ends the wait. Only Codex lets the model read it before the call
  returns.
- **The user's other servers.** On ZCode, declaring relay's server drops every standalone server the user and the
  project configured, from every ZCode job. Relay sends no list today, so ZCode jobs load them now. Relay would
  have to merge them into its list, or document the loss.

## On the Claude side

### Routes that exist

What `SendMessage` already does, measured in the terminal, with the first two points repeated in T3:

- **An agent can reach the lead.** A background subagent and a Workflow agent both reach the main conversation
  with `SendMessage({to: "main"})`. While the lead is busy, the message waits for its current tool call to
  return: 38 to 45 s later behind a 60 s Bash loop, in the terminal and in T3. An idle lead starts a turn on it,
  40 to 70 ms after the send in the terminal and 30 to 100 ms in T3. In T3 this differs from a Monitor, which
  never starts a turn once the turn has ended ([D18](decisions.md)).
- **The lead learns only an address.** It reads `<agent-message from="X">` inside a fixed wrapper. `X` is the
  sender's name, or its agent id when it has none, and a Workflow agent never has one. The lead gets no type and
  no parent. The busy and idle wrappers differ, and only the busy one says how to reply.
- **Agents can reach each other.** A subagent reaches a peer by name or by agent id, and the peer answers to the
  envelope's `from`. Both arrive at the receiver's next tool round.
- **There is no built-in parent address.** `"parent"` is not an address, and nothing a child has names the agent
  that spawned it. A child that knows its parent's name or id can reach it. Claude Code knows the parent:
  `agent.spawn` carries `parentAgentId`, `$.agent.list()` has `parentId`, and `subagents/agent-<id>.meta.json`
  holds `parentAgentId`. A `PreToolUse` command hook gets `agent_id` and `agent_type` only.

### What a module can send

The plan named the module's `$.session.send` for the delivery. Measured, it cannot do it:

- A module's send carries the plugin as its origin and no `agentId`, from any loop. An `agentId` the module
  passes is dropped without an error, though the declarations say it would be refused.
- `to: "main"` is refused: "You are the main conversation — "main" addresses you. Send to a named agent instead."
- A send to a peer arrives as "The coordinator sent a message while you were working". The plugin's name is only
  in the transcript entry's metadata.
- `$.prompt.submit` reaches only the main conversation, as the plugin's. It is refused inside a `tool.call` hook;
  from a timer it starts a turn once the lead is idle. `$.session.append` adds a hidden user row, to the main
  conversation or, with an `agentId`, to a running subagent's. It names no sender and starts no turn.
- No `session.receive` fires in the main conversation, so a module cannot see or rewrite a message to the lead
  either.

### The relay sends as itself

A test agent type with the tools `Bash` and `SendMessage` stood in for the relay. It sent `message:
"OUTBOX:<file>"`, and a `PreToolUse` command hook answered `updatedInput` with the file's exact text and, in one
case, a new `to`. Haiku followed the instruction six times out of six: three background agents, one Workflow
agent, one send to a peer, one rewritten `to`. The receiver got the file's bytes unchanged, with quotes, a
backslash, a blank line and non-ASCII text, as `<agent-message from="<the agent's name or id>">` with origin
`peer`. The sending model never saw the text. The hook's output has the shape of the guard's `allow(reason,
updatedInput)` (`plugins/relay/scripts/hooks/relay-guard.mjs:162`). The same rewrite also worked from a module's
`session.send` hook (`next({...e, text})`). Relay would keep it in the guard, beside the ledger the guard already
owns ([D52](decisions.md)).

### Relays under the Workflow tool

The same case was run three ways: a message by agent id to a Workflow agent.

- **To a running general-purpose Workflow agent**, from the lead or from a module. `SendMessage` answered
  `Resuming agent <id>`. Claude Code started a second, background loop under the same id, with the message, and
  the original loop never read it. In the terminal the original loop's running Bash was killed, and the Workflow
  returned "no message". T3 behaved the same.
- **To a running `relay:job` Workflow agent**, on Codex, once. The steer reached the job: the guard delivered it
  2.5 s after the send, and Codex took it into the running turn 2.6 s after the send. The report quoted it. It
  went through a second relay loop, resumed as `relay:job` on Haiku. Both loops waited on the job until it ended,
  and the lead got a completion notice from the second loop as well as the Workflow's result.
- **To a Workflow agent that has ended.** When no message had resumed it, the send failed: "No transcript found
  for agent ID" (general-purpose Workflow agents, terminal and T3). In the relay run, where the steer had resumed
  it, the continue resumed it again, but as a `general-purpose` agent on the lead's model, without the relay's
  prompt. That agent answered the message itself ("Workflow relay finished: juniper."). The job got no new turn.

The guard reads the transcript the job recorded at start, the Workflow agent's
(`plugins/relay/scripts/lib/harness/relay.mjs:722`). After a fork, Claude Code wrote some later entries to
`subagents/agent-<id>.jsonl` instead: the second loop's last answer and the continue message in the relay run, and
the original loop's later turns in a general-purpose run. Which loop writes where differed between runs. A
message written there would not reach the job, and the guard would leave no record of it. In the relay run the
steer landed in the Workflow transcript and was delivered.

What this means today, for relays that run under the Workflow tool:

- A steer by id reaches the job in the run measured, at the cost of a second relay loop until the job ends.
  A second steer to the same relay was not tried.
- A continue by `SendMessage` does not reach the job. The jobs skill already tells a Workflow to continue a
  finished job with `C continue <job>`.
- The message `cancel` to a Workflow relay, which the Phase 3 branch's D42 and D44 name as the way to cancel one
  Workflow agent's job, travels through such a fork. It was not measured. A forked id is also a background task that `TaskStop` can
  stop.

## A design that fits

What relay would build, if it builds this. It is not part of 3.0 ([D1](decisions.md)). Here "the lead" means the
agent that started the relay: the main thread (also for a relay a Workflow started), or an orchestrator subagent.

1. **The tool.** A stdio MCP server shipped in the plugin, under a reserved name, with two tools. `send` (a note
   to the lead, or to a peer the lead allowed) returns once the message is queued for the relay. `ask` (a question
   to the lead) waits for the answer and returns it. Each backend's connection declares the server on every open,
   with the job's id and jobs home in its environment. Per backend, relay would also:
   - Codex: use dotted config keys, approve the tools in the server's config, and set `tool_timeout_sec`;
   - ZCode: declare `protocolVersion: "legacy"` and `timeoutMs`, and merge the user's standalone servers into the
     list or document their loss; to offer the tool in `read-only` (step 7), allow it there and name it in the
     resumed allowlist;
   - Kimi: raise `KIMI_MCP_TOOL_TIMEOUT_MS` at launch; to offer the tool in `read-only`, answer `approve_once` for
     exactly the tool (`approve_always` would persist in Kimi's session history and survive a reload);
   - Grok: in `write`, find a channel to the worker that its sandbox allows, or leave the tool out; `read-only`
     could not be measured here.
2. **The send.** The server writes each message under the job directory with an id. The relay's `wait` returns
   on a pending message, as it returns on a wake marker, and tells the relay to call `SendMessage` to a reserved
   address that reaches nobody, so a call the guard did not rewrite fails instead of reaching someone. In
   `PreToolUse` the guard, under the relay lock, checks that the caller is the job's current relay, takes the
   oldest pending message, ties it to the call's `tool_use_id`, marks it `sending`, and rewrites `to` and `message`
   with `updatedInput`. It denies a relay `SendMessage` with nothing pending, with the wait command. `PostToolUse`
   and `PostToolUseFailure` for that `tool_use_id` mark it `sent` or `failed`. A `sending` message with neither
   becomes `unknown` at the relay's next hook. Relay does not resend, so the guarantee is at most once, with a
   success, a failure or an unknown outcome on record. A message that is not `sent` shows on the job, as
   `undelivered:` does today. `sent` means queued for the receiver, not read. The relay never sees the text, so it
   cannot change it. Whether those two hooks fire for a subagent's `SendMessage`, and see the rewritten input, was
   not measured.
3. **The address and the header.** The guard decides the address, never the job: `"main"` for a relay the main
   thread or a Workflow started, the orchestrator's id while it runs for a relay an orchestrator subagent started,
   and a peer only if the lead allowed it when it started the job. A message to an orchestrator that has ended
   would resume it, and one to an orchestrator that is a Workflow agent would fork it, so in those cases the
   message goes to `"main"` or stays unsent; the later plan chooses which. A relay's id is a peer only if the lead
   allowed it, so one job cannot steer another without the lead. The module's `agent.spawn` hook can record the
   parent from `parentAgentId`, and the meta file has it too. The guard writes a header in front of the job's
   text: the job, its backend and its mode, and for an `ask` the question's id and the form of a reply. The job's
   text follows unchanged, so a job cannot forge the header.
4. **Questions and answers.** One `ask` is open at a time per job, with an id. Its answer is a message to the
   relay from the asked party in the reply form for that id. The guard knows the asked party by the transcript
   entry's origin: the main thread's message is `coordinator` with no `plugin` (a board button's carries the
   plugin's name), an orchestrator's is `peer` with its `senderTaskId`. Whether an answer, the server's deadline or
   a cancel ends the `ask` is one decision, made once under the relay lock and recorded in the ledger. The server
   returns an answer that won as the call's result. A cancel keeps its precedence. An answer that lost to the
   deadline, and every other message, stays a steer or a next turn, except that a late answer to a Workflow relay
   that has ended reaches no job (`C continue` does). The server bounds its own wait below the backend's limit and
   returns "no answer yet". It ignores a cancellation for a call it has already answered.
5. **The relay's life.** A job outlives its relay. A message the job sends while no relay runs stays pending,
   and the job's state block shows it as `unsent:`. Only the job's current relay takes a message, so a relay that
   adoption replaced cannot send under the old id. Whether an open `ask` and unsent notes carry over to a relay
   adopted in a new session, whose `"main"` is another conversation, is the later plan's to decide; an old
   session's address is never reused for a new one. The hand-back waits while a message is `pending` (not yet
   taken), not while one is `sending`. A cancel ends an open `ask`.
6. **A busy lead.** A note to a lead that is inside a long tool call arrives when the call returns, and a
   foreground relay's lead is inside the Agent call for the job's whole run. So `ask` needs a relay in the
   background, and a bound longer than the lead's usual tool call, or the question runs out unanswered.
7. **Trust.** The job's text is untrusted output of another model, which may have read untrusted input. The
   wrapper Claude Code puts around it already tells the lead that an agent's message is not the user's and cannot
   grant permissions, but the lead then acts with its own permissions, not the job's. A request from a job is
   bounded by the job's own mode: a lead should not do for a `read-only` job what that job could not do itself.
   The header states the mode for that reason. Until relay can hold to it, `send` and `ask` stay out of
   `read-only`. Relay also adds a size cap and a rate limit per job, since every note starts a turn of an idle
   lead on its own model.
8. **Workflow relays.** A note and an `ask` from a Workflow relay reach the lead. The lead's answer reaches the job
   only through a second relay loop, and may be written where the guard does not read. A second message to a
   forked relay was not tried, and a late answer after the relay ends reaches no job. So for now `ask` works end to
   end only for relays the Agent tool started. Before it can work for Workflow relays, the guard has to read the
   flat `subagents/agent-<id>.jsonl` beside the recorded transcript, merged by entry id, or detect the fork and
   record a violation, and a live check has to show the answer arriving.
9. **Cost.** Not measured. An estimate: for one note, the relay's model makes a call to send and a call to wait
   again, unless several notes go in one turn; the backend makes its tool call; an idle lead runs a turn on its own
   model, which is likely the largest part. For a Workflow relay, the first message from the lead added a second
   relay loop for the rest of the job in the run measured; what later messages add is unknown.

What a live check would have to prove before the capability table shows it, per backend, mode and surface:

- a note to an idle lead and to a busy one, and a note to a peer;
- an answered `ask`, an `ask` that runs out, an answer that comes late, an answer at the deadline, and an
  unrelated steer while an `ask` is open;
- a cancel or an interrupt while an `ask` is open;
- a send the guard marks `failed` (an address that does not exist), a guard that fails while a message is
  `sending`, and a relay that dies with a message pending;
- the tool after a continue and after a recovery, and on ZCode the user's servers still loading;
- an adoption while the replaced relay still runs;
- each of these from a Workflow relay, with a steer after a fork and a second message to a forked relay;
- a body that imitates the header, a burst above the rate limit, and a `read-only` job that asks the lead to write
  a file.

In each, the body received must equal the job's text byte for byte, the guard's header must be the expected one,
the sender must be the relay, and the job's record must match what arrived.

## Open questions

- **Grok's `write` mode.** Does a channel from the confined server to the worker exist? Grok declares HTTP MCP
  support, so the worker could serve the tool on a loopback port, if the `workspace` profile allows loopback
  connections. Not measured.
- **Grok's `read-only` mode.** Grok refused to start the profile on this machine, so nothing is known about the
  tool in it.
- **Why a message to a running Workflow agent forks it.** This is Claude Code's behaviour in 2.1.308, and so is
  resuming an ended Workflow agent as `general-purpose`. Whether either is intended is a question for Claude Code.
- **A second message to a forked Workflow relay.** Does it reach the second loop, or fork a third? Not measured.
- **ZCode's user servers.** Merge them into relay's list by reading ZCode's settings as ZCode does, or document
  that a ZCode job with the tool loses them.
