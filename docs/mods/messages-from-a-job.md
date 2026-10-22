# Messages from a job: what each backend allows

Phase 6 of [the plan](plan.md#phase-6-messages-from-a-job-investigation-no-code-yet) asked whether a relay job can
send a message to the agent that started it, or to a peer, the way a Claude subagent can with `SendMessage`. It
asked for three answers before any code is written. Can each backend be given a "send to lead" tool, an MCP
server the relay adds to the job? Can the message be delivered on the Claude side as the relay agent's own? And
how would a reply find its way back? This report gives them. Nothing in the plugin changed. Messages from a job
stay out of the [capability table](../live/capabilities.md) until a live check proves them.

The measurements were made on 22 October 2026 on the Fedora ThinkPad with Claude Code 2.1.308, Codex 0.163.0,
Grok Build 1.0.67, ZCode 3.16.2 (runtime 0.17.0) and Kimi Code 2.2.0. Four workers each drove one backend
directly, with a probe MCP server that logs every request: GPT-6.1 Sol for Codex and ZCode, GPT-6 Astra for Grok
and Kimi. Two Opus 5.5 workers ran Claude Code sessions in tmux panes. The lead ran a `relay:job` Workflow agent
on the 3.0.0-dev.2 build, and repeated four of the Claude Code checks in T3 Code. The drivers, protocol logs and
transcripts stay on the test machine (`~/dev-libar/relay-context/mods-phase-6/`), as the live suite's evidence
does ([D19](decisions.md)). They hold local paths and job data.

## The answers

1. **Every backend takes the tool.** Each accepts a client-supplied stdio MCP server for one session, with the
   environment and arguments the client gives it. Each starts the server when the session opens and keeps it
   across turns. None remembers it: relay would declare it again on every open, a continue and a recovery
   included. The backends differ in three ways that decide the design: the modes where the call is allowed, how
   long one call may wait, and whether a message reaches the model while the call waits.
2. **The module cannot send as the relay agent.** A module's `$.session.send` always sends as the main
   conversation, from whatever agent's loop its hook runs in. To `"main"` it is refused, and a peer reads it as a
   message from "the coordinator". The relay agent can send as itself. Give it the `SendMessage` tool, and let
   the `PreToolUse` guard rewrite the call's `message` and `to` with `updatedInput`, as the guard already rewrites
   a hand-back. Measured in the terminal: the receiver gets the job's exact text, from the relay's name or agent
   id, and an idle lead starts a turn on it within 0.2 s. A plain `SendMessage` to an idle lead starts a turn in T3
   too.
3. **A reply comes back two ways.** A reply to a note is the lead's `SendMessage` to the relay, which relay
   already delivers as a steer or a next turn. The answer to a question the job is waiting on must be the waiting
   tool call's result. Only Codex shows the model a message while a tool call waits. Grok and ZCode hold it until
   the call returns, and Kimi refuses it.

One finding concerns relays under the Workflow tool, the way the fleet runs them. A message by agent id to a
running Workflow agent starts a second loop of that agent, and the original loop never reads it. Relay's guard
still delivers a steer to the job, through the second loop. A message to a Workflow relay that has ended
continues nothing. It fails, or it resumes a general-purpose agent that answers in the relay's place. This bears
on any reply to a Workflow relay, and on Phase 4's Steer and Continue buttons ([below](#relays-under-the-workflow-tool)).

## What each backend allows

| | Codex | Grok | ZCode | Kimi |
|---|---|---|---|---|
| How the server is added | `thread/start` and `thread/resume` `config`, as dotted keys `mcp_servers.<name>.command`, `.args`, `.env`, …; or `-c` at the app-server's launch | `mcpServers` on ACP `session/new` and `session/load`: `{name, command, args, env: [{name, value}]}` | `mcpServers` in the v4 `createSession` payload, and in `session/resume`, with `env` as `[{name, value}]` | `mcpServers` on ACP `session/new` and `session/load`, as on Grok |
| When it starts | as the thread opens; one process per thread | as the session opens, before the first prompt; one per session | as the session opens; one per session | as the session opens; one per session |
| A session reopened in a new process | has the tool only if the open declares it again | the same | the same; a resume of a session still in memory ignores a new list | the same |
| What the server is given | the declared `env`, `args` and `cwd`; of the parent's environment only `HOME`, `PATH`, `SHELL`, `USER`, the locale and a few more, plus `env_vars` | the declared `env` and `args`, and the backend's environment | the declared `env` and `args`, a filtered copy of the backend's environment; each call's `_meta` names the session and turn | the declared `env` and `args`, and the backend's environment |
| The tool's name, as the model sees it | `mcp__<server>__<tool>` | `<server>__<tool>`, found with Grok's `search_tool` and run with `use_tool` | `mcp__<server>__<tool>` | `mcp__<server>__<tool>` |
| `yolo` | runs | runs; no permission request | runs; no permission request | runs; no permission request |
| `write` | refused inside Codex ("requires approval, but approval policy is never") unless the server's config sets `default_tools_approval_mode = "approve"`; no request reaches the client | runs, no request, but the server runs inside the `workspace` sandbox: one that wrote outside the working directory failed to start | no such mode | no such mode |
| `read-only` | as `write` | Grok refuses to start its `read-only` profile on this machine | a permission request names the tool; relay denies every such request today, and an allow-once answer works; after a cold resume the tool runs only if relay's allowlist names it | a permission request names the tool; relay rejects every such request today, and `approve_once` for that one tool works |
| How long one call may wait, by default | 300 s (the docs say 60); `tool_timeout_sec` raises it | no limit reached in 12 minutes (the docs say 6,000 s); `tool_timeout_sec` in a config file, no protocol field | 30 s; the declaration's `timeoutMs` raises it | 60 s; `KIMI_MCP_TOOL_TIMEOUT_MS` at launch raises it |
| Relay's cancel, while a call waits | `turn/interrupt` ends the turn, but the server is never told: its call stays open until the app-server exits | `session/cancel` sends the server `notifications/cancelled` | `stop` sends `notifications/cancelled` | `session/cancel` sends `notifications/cancelled` |
| A steer while a call waits | accepted; the model read it 1.5 s later, while the call still waited | `_x.ai/interject` answers `queued`; the model gets it after the call returns | `guide` is accepted; it joins the turn after the call returns | refused: "another turn is already in progress"; nothing is queued |
| The answer as the call's result | the model uses it in the same turn | the same | the same | the same |
| A server of the same name in the user's configuration | the declaration wins; a nested `mcp_servers` table also undid relay's `job-mcp-off` flags, so the keys must be dotted | the declaration wins; a same-name server's timeout and trust settings still apply | a nonempty list replaces the user's and the project's standalone servers; plugins' servers stay | the declaration shadows the home's entry |

In every backend the home's own MCP servers and plugins still load beside the declared one. A reserved,
distinctive server name avoids the collisions in the last row.

Three rows decide what relay could promise:

- **Modes.** In `yolo` the tool works everywhere with no change to how relay answers requests. In Codex's
  `write` and `read-only`, the server's own config must approve its tools. ZCode's and Kimi's `read-only` need
  relay to allow exactly its own tool in a request it now denies, and ZCode's resumed allowlist must name it.
  Grok's `write` confines the server to the working directory, so a server that writes into the jobs home cannot
  work there. It would need another channel to the worker, or no tool in that mode.
- **Waiting.** A question the job waits on ends at the backend's limit unless relay raises it: 30 s on ZCode,
  60 s on Kimi. Each limit can be raised at launch or in the declaration, except Grok's, which needs no raising.
  Codex does not tell the server when a turn is interrupted, so the server must bound its own wait.
- **A message while the call waits.** Only Codex lets a steer reach the model before the call returns. On Grok
  and ZCode the steer waits behind the call, and Kimi refuses it. An answer that comes as a steer would therefore
  never end the wait on three of the four backends.

## On the Claude side

### Routes that exist

What `SendMessage` already does, measured in the terminal and repeated in T3:

- **An agent can reach the lead.** A background subagent and a Workflow agent both reach the main conversation
  with `SendMessage({to: "main"})`. While the lead is busy, the message waits for its current tool call to
  return: 42 to 45 s behind a 60 s Bash loop. An idle lead starts a turn on it, 40 to 70 ms after the send in the
  terminal and about 0.1 s in T3. In T3 this differs from a Monitor, which never starts a turn once the turn has
  ended ([D18](decisions.md)).
- **The lead learns only an address.** It reads `<agent-message from="X">` inside a fixed wrapper. `X` is the
  sender's name, or its agent id when it has none, and a Workflow agent never has one. The lead gets no type and
  no parent. The busy and idle wrappers differ, and only the busy one says how to reply.
- **Agents can reach each other.** A subagent reaches a peer by name or by agent id, and the peer answers to the
  envelope's `from`. Both arrive at the receiver's next tool round.
- **No agent can address its parent.** `"parent"` is not an address, and nothing a child has names the agent
  that spawned it. Claude Code knows the parent: `agent.spawn` carries `parentAgentId`, `$.agent.list()` has
  `parentId`, and `subagents/agent-<id>.meta.json` holds `parentAgentId`. A `PreToolUse` command hook gets
  `agent_id` and `agent_type` only.

### What a module can send

The plan named the module's `$.session.send` for the delivery. Measured, it cannot do it:

- A module's send carries the plugin as its origin and no `agentId`, from any loop. An `agentId` the module
  passes is dropped without an error, though the declarations say it would be refused.
- `to: "main"` is refused: "You are the main conversation — "main" addresses you. Send to a named agent instead."
- A send to a peer arrives as "The coordinator sent a message while you were working". The plugin's name is only
  in the transcript entry's metadata.
- `$.prompt.submit` and `$.session.append` reach the main conversation only, as the plugin's. A submit is refused
  inside a `tool.call` hook. From a timer, it starts a turn once the lead is idle. An append starts no turn.

### The relay sends as itself

A test agent type with the tools `Bash` and `SendMessage` stood in for the relay. It sent `message:
"OUTBOX:<file>"`, and a `PreToolUse` command hook answered `updatedInput` with the file's exact text and, in one
case, a new `to`. Haiku followed the instruction six times out of six: three background agents, one Workflow
agent, one send to a peer, one rewritten `to`. The receiver got the file's bytes unchanged, with quotes, a
backslash, a blank line and non-ASCII text, as `<agent-message from="<the agent's name or id>">` with origin
`peer`. The sending model never saw the text. The hook's output has the shape of the guard's `allow(reason,
updatedInput)` (`plugins/relay/scripts/hooks/relay-guard.mjs:162`). The same rewrite also worked from a module's
`session.send` hook (`next({...e, text})`). That would be a second delivery path beside the guard's ledger, so
it is not the one recommended.

### Relays under the Workflow tool

Three runs of one case: a message by agent id to a Workflow agent.

- **To a running general-purpose Workflow agent**, from the lead or from a module. `SendMessage` answered
  `Resuming agent <id>`. Claude Code started a second loop under the same id, with the message, and the original
  loop never read it. In the terminal the original loop's running Bash was killed, and the Workflow returned
  "no message". T3 behaved the same.
- **To a running `relay:job` Workflow agent**, on Codex. The steer reached the job: the guard recorded it as
  `steered` into the running turn, 2.5 s after the send, and the report quoted it. It went through a second relay
  loop, resumed as `relay:job` on Haiku. Both loops wrote to the Workflow transcript and waited on the job until
  it ended. The guard reads the transcript by agent id and delivers each entry once, so the job got the message
  once. The lead got a completion notice from the second loop as well as the Workflow's result.
- **To a Workflow relay that has ended.** When no message had resumed it, the send failed: "No transcript found
  for agent ID" (terminal and T3). When an earlier message had resumed it, the send resumed it again, but as a
  `general-purpose` agent on the lead's model, without the relay's prompt. That agent answered the message itself
  ("Workflow relay finished: juniper."). The job got no new turn.

So a reply or a steer to a running Workflow relay reaches the job today at the cost of a second relay loop. A
continue cannot reach a Workflow relay's job through `SendMessage`, which the jobs skill already implies: it
tells a Workflow to continue a finished job with `C continue <job>`. One risk is left: after such a fork the
second loop can write `subagents/agent-<id>.jsonl`, which `transcriptCandidates`
(`plugins/relay/scripts/lib/harness/relay.mjs:92`) tries before the Workflow transcript. The guard could then
read a partial transcript. It did not happen in the relay run.

## A design that fits

What relay would build, if it builds this. It is not part of 3.0 ([D1](decisions.md)).

1. **The tool.** A stdio MCP server shipped in the plugin, under a reserved name, with two tools. `send` (a note
   to the lead, or to a named peer) returns at once. `ask` (a question to the lead) waits for the answer and
   returns it. Each backend's connection declares the server on every open, with the job's id and jobs home in
   its environment. Per backend, relay would also:
   - Codex: use dotted config keys, approve the tools in the server's config, and set `tool_timeout_sec`;
   - ZCode: set `timeoutMs`, allow the tool in `read-only` and name it in the resumed allowlist;
   - Kimi: raise `KIMI_MCP_TOOL_TIMEOUT_MS` at launch (it applies to every MCP server of the job), and allow
     exactly the tool in `read-only`;
   - Grok `write`: find a channel to the worker that its sandbox allows, or leave the tool out there.
2. **The outbox and the wake.** The server writes each message under the job directory. The relay's `wait`
   returns on a pending message, as it returns on a wake marker, and tells the relay to call `SendMessage`. The
   relay calls it with any text. The guard takes the message under the relay lock, records it as sent, and
   rewrites `to` and `message` with `updatedInput`. Each message is sent once, by the same rule the inbox ledger
   follows. The relay never sees the text, so it cannot change it.
3. **The address.** The lead is `"main"` for a relay that the main thread or a Workflow started. Only `"main"` is
   reachable from a Workflow. For a relay an orchestrator subagent started, the lead is that agent's id. The
   module's `agent.spawn` hook (Phase 3 adds one) can record it from `parentAgentId`, and the meta file has it
   too. A peer is whoever the brief names. Since the lead sees only the relay's name or id, the text says which
   job and backend it comes from.
4. **Replies.** A reply to a note is a steer or a next turn, on the path that exists. The answer to an `ask` is
   the call's result: the guard records a message to a relay with a pending `ask` as that ask's answer, and the
   server returns it. That is a second consumer of the same ledger, not a second delivery path. The server
   bounds its own wait below the backend's limit and returns "no answer yet". An answer that comes later becomes
   an ordinary steer or next turn.
5. **Workflow relays.** A note and an `ask` from a Workflow relay reach the lead. The lead's answer reaches the
   job only through a second relay loop. Before relying on that, relay needs the guard to prefer the job's
   recorded transcript, and a live check of a reply to a Workflow relay.
6. **Cost.** One model call of the Haiku relay per message, plus the lead's turn.

What a live check would have to prove before the capability table shows it, per backend and surface: a note to
an idle and to a busy lead, a note to a peer, an answered `ask`, an `ask` that runs out, and each from a Workflow
relay. In each, the text received must equal the job's text, and the sender must be the relay.

## Open questions

- **Grok's `write` mode.** Does a channel from the confined server to the worker exist? Grok declares HTTP MCP
  support, so the worker could serve the tool on a loopback port, if the `workspace` profile allows loopback
  connections. Not measured.
- **Why a message to a running Workflow agent forks it.** This is Claude Code's behaviour in 2.1.308. Whether it
  is intended, and whether a resumed Workflow agent should keep its agent type, is a question for Claude Code.
- **Kimi's session approval.** An `approve_always` answer persists in Kimi's session history and survives
  `session/load`. Relay would answer `approve_once`, so that each call is judged again.
