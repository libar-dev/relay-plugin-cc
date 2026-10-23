---
name: result-handling
description: Read and present a relay job's result. Load it when a `relay:job` agent's completion notice, a Workflow step's state block, the output of `C result` or `C wait`, a failed, dead or cancelled job, or a job's report file (`report:`) comes back, before you act on it or show it to the user.
user-invocable: false
---

# Job result handling

A result is a state block, then a line `---` and the report when there is one. Read the state before any finding:
- `completed` with a `report:` path: the job finished its answer. That does not prove its commands passed or its edits are right; the report and the files say that.
- `failed` (with `error:`), `dead`, `cancelled`, or `report: none`: there is no finished answer. Say so, with the `error:` line; do not present a partial report as the answer.
- `undelivered:`, `not-delivered:` and `relay-violation:` are warnings about messages and the relay. Name them, and decide what each means for the work.
- `state: not started` with `error:`: no job ran. Fix what the error names, usually the header, and start again; there is no report.

Two kinds of output, with different rules:
- A command's verbatim output. `/relay:review`, `/relay:adversarial-review` and `/relay:rescue` say what their answer is: the companion's or the agent's output, verbatim. Follow the command. Do not reorder it, summarize it or add a line of your own to it.
- Evidence you consume. A `relay:job` agent's notice, a Workflow step's block, or a `C result` you ran is input to the work at hand. When you present it yourself, keep the job's verdict, summary, findings and next steps; put review findings first, by severity; use file paths and line numbers exactly as the job gave them; keep its evidence boundaries (observed facts, inferences, open questions); say whether it made edits, and list the touched files it names.

What you do next:
- `/relay:review` and `/relay:adversarial-review` are review-only. After their findings, make no code change: ask the user which findings, if any, to fix.
- Elsewhere, go on with the work the user already authorized, such as a review-and-fix step of a plan. A review you ran for yourself does not authorize edits nobody asked for.
- For a `relay:job` job or `/relay:rescue`, do not turn a failed or incomplete job run into a Claude-side implementation attempt. Report the failure, or recover the job when that is part of the work: `C resume <job>` for a dead or failed job, `C continue <job>` for a follow-up (the `jobs` skill).
- For a `relay:job` job or `/relay:rescue`, if the job was never successfully invoked, do not generate a substitute answer at all.
- If the output reports malformed output or a failed run, include its most actionable `error:` or stderr lines instead of guessing.
- If it says setup or a sign-in is needed, direct the user to `/relay:setup`; do not improvise another sign-in.
