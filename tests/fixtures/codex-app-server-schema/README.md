# Codex app-server schema contract

Baseline: **`codex-cli 0.163.0`**, installed CLI, generated on 2026-10-23.
No app-server session or model call was used to obtain the schema.

```sh
codex --version
codex app-server generate-json-schema --help
codex app-server generate-json-schema --out /tmp/relay-codex-schema
node tests/fixtures/codex-app-server-schema/extract.mjs /tmp/relay-codex-schema "$(codex --version)"
node --test --test-name-pattern='Codex schema contract:' tests/codex-turns.test.mjs
```

When updating Codex, regenerate using the actual new version and review the fixture
diff before running the tests. Tests use the pinned fixture, not an installed CLI,
so they stay offline and reproducible. A pinned fixture cannot detect a new CLI
version until it is regenerated.

`contract.json` contains the `thread/read` variant of `ClientRequest.json`,
`v2/ThreadReadResponse.json`, `JSONRPCResponse.json`, `JSONRPCError.json`, and the
seven `ServerNotification.json` variants consumed by `turn.mjs`. The extractor
retains their complete referenced definitions, sharing identical definitions.
It removes only annotations (`description`, `title`, `default`, nested `$schema`),
and preserves validation keywords. It does not invent or narrow a status enum.

The local test validator covers the validation keywords used by this fixture:
`$ref`, `type`, `enum`, `required`, `properties`, `additionalProperties`, `items`,
`oneOf`, `anyOf`, `allOf`, `minimum`, and `minLength`. `format: int64` and
`format: uint*` are annotations; JSON types are still checked. No package install
or live schema generation is part of the test suite.

## Comparison with relay and its fake

- Request: `{id, method: "thread/read", params: {threadId, includeTurns?}}`.
  `threadId` is required, `includeTurns` is boolean. Relay sends both correctly.
  The fake now leaves turns empty when `includeTurns` is false or omitted.
- Result: `{id, result: {thread: Thread}}`. The fake's read result was missing
  required `thread.projectId` (nullable string) and `thread.sessionId` (string);
  those are now supplied only in its `thread/read` handler. Turn `id`, `items`,
  and `status` are required; `error` is optional, nullable, and its object requires
  only `message`. The fake's minimal failure object is valid.
- Turn status: `completed`, `interrupted`, `failed`, `inProgress`. All names used
  by relay exist. Thread status is a separate tagged union: `notLoaded`, `idle`,
  `systemError`, or `active` (with required `activeFlags`). The fake's `idle`
  shape is valid. Relay classifies the selected turn's status, not thread status.
- RPC errors: `{id, error: {code: integer, message: string, data?: any}}`.
  There is no method-specific error taxonomy, message pattern, or code enum in
  the schema. All five fake error scenarios satisfy this envelope. Their text
  and codes are synthetic classification probes, not captured Codex errors.
  Schema generation cannot establish that real Codex emits the `unknown variant
  thread/read` wording, or that a particular generic server error means a method
  is unsupported.
- `unknown-status` intentionally sends `waiting`, which is outside `TurnStatus`.
  It remains a malformed-peer rejection scenario, with a test requiring that
  exact schema violation. `missing` is a schema-valid history without the target
  turn. `silent` and server exit have no response shape to validate; their
  existing timeout/transport tests remain applicable.
- Notification methods and fields read by relay exist: `thread/started`,
  `thread/name/updated`, `turn/started`, `turn/completed`, `item/started`,
  `item/completed`, and `error`. `agentMessage.phase` accepts `final_answer`
  (also `commentary`, `partial_answer`, null, or absence). The schema describes
  unknown phase as requiring legacy compatibility; it does not promise that
  every final answer carries a phase. Relay's inference requires an explicit
  `final_answer`. `collabAgentToolCall`, `receiverThreadIds`, and its `inProgress`
  and `completed` statuses also exist. No consumed notification name or status
  was renamed in this baseline.
- The turn-order fake's item notifications supply required `startedAtMs` or
  `completedAtMs`; its collaboration items also supply `senderThreadId` and
  `agentsStates`. The fake contract test validates its emitted collaborator item
  notifications. The notification consumer test also validates relay's actual
  `thread/read` parameters, including its request for turns.

No product schema mismatch was found, so no product test is marked TODO. This
contract does **not** establish notification ordering, a missing main-thread
`turn/completed`, the safety of the 250 ms grace window, or the decision to infer
completion from `inProgress`/an unsupported-method error. Those remain runtime
assumptions requiring a real collaborator-turn transcript.

## Live/smoke follow-up (requires real backend evidence)

- Capture a real Codex collaborator turn, including whether the root omits
  `turn/completed`, the final-answer timing, and the `thread/read` response. Use
  the recording to check the 250 ms inference assumption and error classification
  (`unknown variant …`, `Unsupported method`); schemas cannot establish these.
- Capture Grok's actual capacity/request-rate failure payload and its adapter
  mapping. The unverified candidates in `tests/retries.test.mjs` pin no retry
  today; they are not evidence of retry bugs. A bare 429 can also mean a usage
  quota, which must fail at once. Record evidence and intended handling before
  changing any candidate's expectation or introducing a product-bug TODO.
