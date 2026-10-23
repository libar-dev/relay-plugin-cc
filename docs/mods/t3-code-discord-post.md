# Draft: post for the T3 Code Discord

Not posted. Replace `<link>` with the URL of `docs/mods/t3-code.md` on `main` once it is merged.

---

Hi all. I maintain relay, an open-source Claude Code plugin that runs Codex, Grok Build, ZCode (GLM) and Kimi
Code jobs as Claude agents: a main thread starts them with the Agent tool (a Workflow script with `agent()`),
steers them with SendMessage and gets their reports back.

It complements T3 Code rather than competing with it. For a plain fan-out, T3's own delegates are the better
fit. Relay is for dynamic workloads inside Claude Code: Workflow scripts and Claude orchestrators whose agents
need another harness. A Workflow script can't call T3's tools.

We're adding a Claude Code Mod to relay. Its hooks and commands work in T3: our live suite steered jobs through
its wake, refused a bad header at the spawn and answered its commands with no model turn, in T3 threads, on all
four backends. What a Mod draws doesn't
show: `system/ui_status`, `ui_toast` and `ui_log` arrive in the stream with no handler, and module commands
don't reach the picker. None of that is relay-specific; it affects every Mod.

I wrote up what we found and the small changes that would help, smallest first: <link>

Are any of these planned, and would PRs be welcome?
