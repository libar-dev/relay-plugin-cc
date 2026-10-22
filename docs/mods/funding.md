# Funding and the product

Relay may look for support for its maintenance at some point. Nothing about that is decided. This note records
the principles any support would follow and what they ask of the product. Those principles are the parts that
matter for this plan.

## Principles

- **Relay stays free and open source.** No paid tier, no paid UI, no hosted version, no private build. The Mod and
  its board ship in the same plugin as everything else.
- **Support funds testing and maintenance, not control.** It doesn't influence compatibility results, defaults,
  model recommendations, issue priority or the roadmap.
- **A backend counts as supported only when the public live suite says so.** Support can't buy that status.
- **Every backend is treated the same.** Each one's real capabilities and limits are stated exactly. For example,
  Kimi takes no message during a running turn and runs it as the next turn, and a `read-only` mode is not an
  operating-system sandbox.

## Why testing is the cost

Relay's guarantees come from live runs of real harnesses: tools, MCP, steering, cancellation, recovery after a
killed worker, and long review workflows. Those runs use real model capacity. Any support relay looks for would go
first to that testing.

## What it asks of the product

- **A public capability table for each backend, backed by the live suite.** Each cell links to the test that
  proves it, and shows only what the suite has passed. Candidate rows include a delegated task, multi-turn tools,
  MCP, steering a running job, messages between the parent and the agent (both ways) and between agents, joining
  a dynamic workflow, recovery, and a long review workflow.
- **A short demo.** Claude delegates to an external agent, steers it while it runs, the agent uses a tool, a second
  agent joins, and the result returns normally.
- **Concrete compatibility cases**, each with its regression test: a harness behaviour relay had to handle, and how
  it handles it.

[plan.md](plan.md#impact-of-the-funding-notes) lists where the plan takes these up.
