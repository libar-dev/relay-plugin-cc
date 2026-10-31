# Automated PR reviews

The `PR review` workflow reviews each pull request with **Claude Opus 5.5 at high effort**, then **GPT-6 Astra
at high effort**. Astra still runs if Opus fails. Each reviewer updates one marked comment per PR, so a new push
replaces its earlier review instead of adding another pair of comments. Reviews of the same PR are serialized by
a concurrency group.

## Enable it

1. Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` as repository Actions secrets. The keys stay in GitHub; this
   repository contains no credentials or account-specific configuration.
2. Keep the `PR review` workflow enabled. It runs on opened, reopened and synchronized PRs and when a PR is marked
   ready for review.
3. To request a review manually, run the workflow with a PR number. No dashboard model setting is required: the
   model ids and high effort are explicit in `scripts/pr-review.mjs` and `.github/workflows/pr-review.yml`.

The workflow requires only `contents: read`, `pull-requests: read` and `issues: write`. Provider secrets are
present only on the two review steps, never on collection or comment-publication steps. CLI failures are published
as failures rather than silently turning into clean reviews, and the job remains failed even when both outcomes
are published.

## Security model

`pull_request_target` runs the workflow from the base repository. Checkout uses that base revision, never the PR
head, so no code, dependency lifecycle script, hook or configuration from a fork executes with repository secrets.
GitHub documents the distinction and its risks in [Securely using
`pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

The driver collects the diff through GitHub's API as data and rejects diffs over 192 KiB instead of silently
truncating them. The prompt treats the entire diff as untrusted input and forbids tool use.

- **Opus:** `--safe-mode`, no tools and no session persistence.
- **Astra:** a read-only empty working directory, no user configuration or exec-policy rules, an ephemeral
  session, and `shell_environment_policy.inherit=none` so model-launched commands do not inherit provider keys.
- **Publication:** only the generated review text and public PR metadata enter a marked comment. Raw CLI stderr,
  environment files and job logs are not copied into comments.

The pinned CLIs are Claude Code 2.1.316 and Codex CLI 0.166.0. Upgrade them deliberately and rerun validation.

## Validate

`tests/pr-review.test.mjs` uses fake `gh`, `claude` and `codex` executables. It checks model and effort arguments,
the no-tools and environment-isolation settings, diff collection, sequential review output and create/update
comment behavior without network access or credentials. Run:

```bash
node --test --test-concurrency=1 tests/pr-review.test.mjs
npm test
npm run check
```

A workflow dispatch without the two secrets fails explicitly and does not publish a fabricated review. After
configuring the secrets, use a small synthetic PR for the first live check and inspect both marked comments.

On 31 October 2026, a read-only collection against a public 125,494-byte PR diff succeeded and produced the
untrusted-input prompt without calling a model or publishing a comment. Provider-backed reviews remain a separate
live check after the secrets are configured; no account behavior is inferred from the fake-CLI tests.
