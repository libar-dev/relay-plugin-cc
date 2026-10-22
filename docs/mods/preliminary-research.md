# The preliminary research

A summary of the research that started this plan, "Claude Mods for relay: what to build, what to reuse, and what
not to replace". It was written on 17 October 2026 by a web research tool, against relay PR #1 at 7dad14c and Mod
declarations from Claude Code 2.1.277. It read the code and the docs; it ran nothing. The three plans in this
directory checked it against relay 2.2.0 and Claude Code 2.1.307.
[plan.md](plan.md#corrections-to-the-preliminary-research) lists what they corrected.

## Its claims

- **Mods are a released extension API, not a frozen contract.** They load by default from Claude Code 2.1.287 in
  the terminal and from 2.1.286 in Desktop, and the declarations a build generates outrank the docs. `claude -p`
  and Agent SDK hosts run a Mod's hooks but draw nothing.
- **Order of work:** a live job board and report inspector first. Then direct controls that respect each
  backend's capabilities, then a backend, model and effort selector, then a view for review workflows. Deeper
  event integration and a history browser come later.
- **The companion is the boundary.** The Mod calls `status --json`, `result --json` and `setup --json`. Relay keeps
  sole ownership of job state, and the Mod never writes job files. A busy read keeps the last view, marked stale.
- **Direct controls** should keep each backend's own meanings apart: steer a running turn, queue a follow-up (Kimi),
  continue after the report, and cancel. A destructive action names its target again when it runs. An action
  needs a request id, so that a timed-out call can be checked instead of resent.
- **Classic hooks are reachable from Mods (`classic.*`), but not unchanged.** `classic.PreToolUse` gets a tool-call
  envelope, and results are normalised. Migrating a hook needs an adapter and parity tests, so relay's four hooks
  stay as they are.
- **agent-harness-kit** stays the layer for observing sessions across a machine and across harnesses: discovery,
  incremental reads, checkpoints and redaction. A Mod sees only its own Claude process.
- **The runtime is not Node.** It has no filesystem or process modules and no npm imports. Calls must stay
  recognisable as `$.namespace.method`. The limits:
  - `$.session.messages()`: the newest 4,096 entries;
  - `$.fs` reads and writes: 4 MiB per file;
  - `$.store`: 4 MiB in total;
  - `$.process.run`: 30 s by default, 10 min at most.

  `$.state` resets on `/clear`, `/resume` and `/branch`.
- **Mod-started processes run outside Claude's Bash sandbox,** so a button is not a security boundary.
- **Stages:** a read-only Mod, then controls and configuration, then native events run alongside the current
  hooks before any replaces them, then history, then the review-workflow view.
- **Rule:** "The interface may disappear. Observation may lag. The job must still run correctly, and its next
  interface must be able to reconstruct what happened."
