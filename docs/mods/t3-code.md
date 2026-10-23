# Relay in T3 Code: what works and what we'd need

This note is for T3 Code maintainers and users. It explains what relay is, how it fits next to T3 Code, and
what T3 would need for relay's upcoming Claude Code Mod to show everything it can show elsewhere. The
findings come from T3 Code 0.1.1-nightly.20261020.3438 (commit fe27e8e3dc12) with Claude Code 2.1.307 and Agent
SDK 0.3.276. Some of them come from reading T3's shipped JavaScript, not from its source. Corrections are
welcome.

## What relay is

[relay](../../README.md) is an open-source Claude Code plugin. It runs jobs on Codex, Grok Build, ZCode (GLM)
and Kimi Code as Claude agents. A main thread, or a Workflow script, starts a `relay:job` agent with the Agent
tool. It steers the job with `SendMessage`, continues it after the report with another message, and gets the
report back as the agent's result. Each job has a detached worker and survives the Claude session.

## Relay complements T3 Code

Relay doesn't replace any part of T3 Code. In a T3 thread, T3's own threads, delegates and task tracking come
first. For a plain fan-out of independent agents (reviews, research, one-off fixes), a T3 delegate is the better
choice: it runs on any provider in T3's catalog, as a thread of its own, with that harness's full features, and
no Claude agent waits on it.

Relay is mainly for **dynamic workloads inside Claude Code**: Workflow scripts and Claude orchestrators whose
agents need to run on another harness. A Workflow script can't call T3's tools. A relay job takes part in it as
an ordinary agent. It holds a Workflow slot, is adopted again when a run resumes, takes steering, and returns a
state block the script can read. Most relay users run it in a plain Claude Code terminal or in Claude Desktop,
not in T3.

## The Claude Code Mod

Relay is adding a Claude Code Mod ([the plan](plan.md)). Its parts don't all work in T3:

| Part | Terminal and Desktop | T3 Code today |
|---|---|---|
| A `session.send` hook that wakes a relay when it is sent a message, so a steer arrives in about two seconds | works | expected: event hooks ran in Agent SDK tests; not yet tested in T3 |
| `/relay:status`, `/relay:result`, `/relay:cancel` and `/relay:transfer` answered by the module, with no model turn | works | expected when typed: the SDK returns the answer as an assistant message, which T3's adapter displays (from reading its code); not yet tested in T3 |
| A status line ("2 running · 1 owed") with `$.ui.status` | drawn | not shown: arrives as `system/ui_status`, with no handler |
| Notices with `$.ui.toast` and `$.ui.log` | drawn | not shown: `system/ui_toast` and `system/ui_log`, with no handler |
| A job board pane with `$.ui.open` | drawn | not placed: the SDK host attaches no surface (`no-surface`) |
| Commands the module registers itself | in the picker | not listed: T3's capability probe runs with `disableAllHooks`, and its Claude adapter doesn't handle `commands_changed` |
| `immediate: true` commands during a turn | run at once | run when the turn ends |

## What would help, smallest change first

1. **Render `system/ui_status` and `system/ui_toast`** from the Claude stream, and attach a surface that says
   so. For example, show the status as a chip on the thread and the toast as a transient notice. Rendering alone
   isn't enough: a Mod checks `$.session.surfaces()` before it refreshes anything, and that list is empty in T3
   today. With both changes, relay's status line would work in T3 with no relay change. What a surface
   declaring status-only rendering would look like is a question for T3 and the Claude Code SDK.
2. **Render `system/ui_log`** as a muted row in the thread. Claude Code documents these lines as visible to the
   person and not to the model.
3. **List module commands in the picker.** Read them from the session's `commands_changed` message, or run the
   capability probe with plugin modules loaded.
4. **Send `immediate` commands at once during a busy turn**, instead of queueing them behind the turn.
5. **Attach a drawing surface for panes.** This is the largest of the five, and relay doesn't need it to be
   useful in T3.

None of these is relay-specific. Each one helps every Claude Code Mod that a T3 user installs.

## What we'd like to know

- Are any of these changes planned, or would PRs for them be welcome?
- Is the stream-json `system` subtype the right place for T3 to pick up Mod output, or does T3 prefer another
  route?
- Does a remote T3 server (one T3 client, Claude running on another machine) need anything else?
