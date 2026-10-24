# Agent guidance

## Required core context

Before any design, implementation, review, or delegation, read every document in `docs/mods/official/` using the local
files, not web summaries or memory. These are the core Claude Code Mods documents required for all repository work.
Within the same session, later tasks may consult the relevant sections instead of rereading unchanged copies. Every
delegation brief must name this directory and require the receiving agent to read it before work. Use the installed
build's declarations to resolve version-specific differences.

## This is a public repository and a public plugin

relay-plugin-cc is open source, and anyone can install the plugin. Everything you write here is published: code,
tests, fixtures, docs, skills, CHANGELOG entries, commit messages and pull request descriptions.

- **No organisation-, project- or machine-specific references.** That means no machine names, hostnames,
  usernames, private paths, internal thread or session ids, fleet or infrastructure tooling, client or project
  names, internal review documents, or someone's private preferences and rulings.
- **Present data and generic behaviour.** Defaults are generic formulas, not values tuned to one computer.
  Evidence is described generically ("a 16 GiB Linux machine"), with public sources cited and dated.
- **Fixtures and examples are synthetic.** Never copy a real job, transcript, measurement or log into a test or a
  doc.
- If a change needs private context to be understood, keep that context outside this repository. The public
  text explains the change on its own terms.

## Working in the repository

- Run the tests with `npm test`, which runs `node --test --test-concurrency=1 tests/*.test.mjs`. Run one suite at
  a time; the full suite is heavy.
- Every version field moves together with `node scripts/bump-version.mjs <version>`.
  `npm run check-version` checks them.
- The CHANGELOG groups entries under the release heading. Don't add a heading per development version.
