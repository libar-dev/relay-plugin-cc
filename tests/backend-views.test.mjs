import test from "node:test";
import assert from "node:assert/strict";
import { backendNamed } from "../plugins/relay/scripts/lib/backends/index.mjs";
import { renderJobBlock } from "../plugins/relay/scripts/lib/jobs/view.mjs";

function view(backend, inference) {
  return {
    job: { id: "job", state: "completed", request: { backend }, sessionId: "session", turnId: "turn",
      attempts: [{ turnId: "turn", completionInference: inference }] },
    state: "completed", jobDir: "/tmp/job", paths: { report: "/tmp/job/report.md" }, hasReport: false
  };
}

test("a backend's inference formatter receives its own recorded layout", () => {
  const backend = backendNamed("grok");
  const previous = backend.view.completionInferenceLine;
  const inference = { receipt: "accepted" };
  try {
    backend.view.completionInferenceLine = (recorded, context) => {
      assert.equal(recorded, inference);
      assert.deepEqual(context, { sessionId: "session", turnId: "turn" });
      return "note: completion confirmed by receipt";
    };
    assert.match(renderJobBlock(view("grok", inference)), /^note: completion confirmed by receipt$/m);
  } finally {
    if (previous) backend.view.completionInferenceLine = previous;
    else delete backend.view.completionInferenceLine;
  }
});

test("Codex inference formatting requires the current thread and turn", () => {
  for (const inference of [{ receipt: "accepted" }, { threadId: "other", turnId: "turn" }, { threadId: "session", turnId: "old" }]) {
    assert.doesNotMatch(renderJobBlock(view("codex", inference)), /completion inferred/);
  }
  assert.match(renderJobBlock(view("codex", { threadId: "session", turnId: "turn" })), /completion inferred/);
});
