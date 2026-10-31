# Agent guidance

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

## Release lines and future work

- The 2.x line is the supported workhorse. Keep it reliable for current users and validate its Claude Code
  integration after harness upgrades.
- The 3.0.0.pre line did not establish the required Claude Mods architecture and is not a basis for further
  implementation. The active rearchitecture follows Claude Mods standards.
- Both 2.x and 3.x are reference inputs to `cc-agents`. Keep 3.x material while it remains useful to that work;
  clean it up only after it has no remaining value as an input.
- Read [the current-direction note](docs/mods/plan.md#current-project-direction) before changing 3.x or
  `cc-agents`, and before deleting legacy implementation or design material.
