---
description: Hand an investigation or a fix to a job through the relay:job agent
argument-hint: "[--background|--wait] [--backend codex|grok|zcode|kimi] [--model <model>] [--effort <effort>] [--grok-home <name|path>] [--kimi-home <name|path>] [--read-only|--write] [what the job should investigate or fix]"
allowed-tools: Agent, AskUserQuestion
---

Launch one job through the `relay:job` agent with the `Agent` tool (`subagent_type: "relay:job"`). It uses the same `start` and `wait` path as every job of this plugin.
`relay:job` is an agent, not a skill: do not call `Skill(relay:job)` or `Skill(relay:rescue)`. This command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be the agent's output verbatim.

Raw user request:
$ARGUMENTS

Build the agent's prompt from the request:

1. Take these flags out of the request. They are controls, not task text:
   - `--background`: run the agent in the background (`run_in_background: true`). `--wait`: run it in the foreground. Neither: foreground.
   - `--backend <backend>`: the `backend:` header value, passed as given (`codex`, `grok`, `zcode` or `kimi`). Without it, leave `backend` out (Codex).
   - `--model <model>`: the `model:` header value. Without it, use `default` (the backend's config decides).
   - `--effort <effort>`: the `effort:` header value, passed as given. Without it, use `default`.
   - `--grok-home <value>`: the `grok-home:` header value, passed as given. Without it, leave `grok-home` out. A name selects `~/.grok-<name>`; an absolute or `~/` path selects that home.
   - `--kimi-home <value>`: the `kimi-home:` header value, passed as given. Without it, leave `kimi-home` out. A name selects `~/.kimi-code-<name>`; an absolute or `~/` path selects that home.
   - `--read-only`: `mode: read-only`. `--write`: `mode: write`. Neither: leave `mode` out (the default, yolo, applies).
2. Refuse any other flag with a usage error that names it. Do not launch the agent. What is left after the known flags is the brief. Keep it exactly as the user wrote it. If it is empty, ask the user what the job should investigate or fix, and stop.
3. The prompt is the header lines, then a line `---`, then the brief:

```
backend: <only when --backend was given>
model: <model or default>
effort: <effort or default>
grok-home: <only when --grok-home was given>
kimi-home: <only when --kimi-home was given>
mode: <only when --read-only or --write was given>
---
<the brief, unchanged>
```

4. Call `Agent` with `subagent_type: "relay:job"`, a short `description`, and that prompt.

Rules:
- Never put anything else in the header, and never infer `mode` from the brief's words, nor `backend`.
- Return the agent's final message verbatim. Do not paraphrase, summarize, or add commentary before or after it.
- Do not inspect the repository, solve the task yourself, or fix anything the job reports.
- To follow up on the same session, send the follow-up to the agent with `SendMessage`. To stop it, send the message `cancel`.
- If the agent reports that the backend is missing or unauthenticated, tell the user to run `/relay:setup`.
