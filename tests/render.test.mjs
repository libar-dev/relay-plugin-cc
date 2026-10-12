import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, reviewSchemaError } from "../plugins/relay/scripts/lib/review/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /- Validation error: `findings` is missing\./);
  assert.match(output, /Raw final message:/);
});

// Every review answer is checked against review-output.schema.json.
test("reviewSchemaError enforces review-output.schema.json: types, enums, required fields, ranges, items, no extra properties", () => {
  const finding = { severity: "high", title: "T", body: "B", file: "a.js", line_start: 1, line_end: 2, confidence: 0.5, recommendation: "" };
  const valid = { verdict: "approve", summary: "Fine.", findings: [finding], next_steps: ["Ship."] };
  assert.equal(reviewSchemaError(valid), null);
  assert.equal(reviewSchemaError({ ...valid, verdict: "needs-attention", findings: [], next_steps: [] }), null);
  const { recommendation, ...noRecommendation } = finding;
  for (const [answer, message] of [
    [null, "the answer must be an object, not null."],
    [[], "the answer must be an object, not an array."],
    [{ ...valid, verdict: "banana" }, '`verdict` must be one of "approve", "needs-attention", not "banana".'],
    [{ ...valid, summary: "" }, "`summary` must be at least 1 character long."],
    [{ ...valid, summary: 3 }, "`summary` must be a string, not a number."],
    [{ verdict: "approve", summary: "Fine.", findings: [] }, "`next_steps` is missing."],
    [{ ...valid, findings: [null] }, "`findings[0]` must be an object, not null."],
    [{ ...valid, findings: {} }, "`findings` must be an array, not an object."],
    [{ ...valid, findings: [noRecommendation] }, "`findings[0].recommendation` is missing."],
    [{ ...valid, findings: [{ ...finding, severity: "banana" }] }, '`findings[0].severity` must be one of "critical", "high", "medium", "low", not "banana".'],
    [{ ...valid, findings: [{ ...finding, line_start: 0 }] }, "`findings[0].line_start` must be at least 1, not 0."],
    [{ ...valid, findings: [{ ...finding, line_end: 1.5 }] }, "`findings[0].line_end` must be an integer, not 1.5."],
    [{ ...valid, findings: [{ ...finding, confidence: 2 }] }, "`findings[0].confidence` must be at most 1, not 2."],
    [{ ...valid, findings: [{ ...finding, confidence: "high" }] }, "`findings[0].confidence` must be a number, not a string."],
    [{ ...valid, findings: [{ ...finding, extra: 1 }] }, "`findings[0].extra` is not allowed."],
    [{ ...valid, next_steps: [null] }, "`next_steps[0]` must be a string, not null."],
    [{ ...valid, next_steps: [""] }, "`next_steps[0]` must be at least 1 character long."],
    [{ ...valid, extra: true }, "`extra` is not allowed."]
  ]) {
    assert.equal(reviewSchemaError(answer), message, JSON.stringify(answer));
  }
});

test("renderReviewResult shows a schema-invalid answer raw, never as normalized findings", () => {
  const raw = JSON.stringify({ verdict: "approve", summary: "Fine.", findings: [null], next_steps: [] });
  const output = renderReviewResult({ parsed: JSON.parse(raw), rawOutput: raw, parseError: null }, { backendLabel: "Grok", reviewLabel: "Adversarial Review", targetLabel: "working tree diff" });
  assert.match(output, /^# Grok Adversarial Review\n\nTarget: working tree diff\nGrok returned JSON with an unexpected review shape\.\n\n- Validation error: `findings\[0\]` must be an object, not null\.\n/);
  assert.ok(output.includes(`Raw final message:\n\n\`\`\`text\n${raw}\n\`\`\``));
  assert.doesNotMatch(output, /Finding 1|Verdict:/);
});
