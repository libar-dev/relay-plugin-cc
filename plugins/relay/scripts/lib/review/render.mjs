import fs from "node:fs";
import { DEFAULT_BACKEND } from "../backends/index.mjs";

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

// The review answer has one definition, schemas/review-output.schema.json. Each backend
// receives that schema, and every answer is checked against it here.
// The checker covers the keywords that file uses; any other keyword is an error, so the
// schema cannot outgrow the checker silently.
const REVIEW_SCHEMA_URL = new URL("../../../schemas/review-output.schema.json", import.meta.url);
const SCHEMA_KEYWORDS = new Set(["$schema", "title", "description", "type", "enum", "required", "properties", "additionalProperties", "items", "minLength", "minimum", "maximum"]);
const TYPE_NAMES = { object: "an object", array: "an array", string: "a string", number: "a number", integer: "an integer", boolean: "a boolean", null: "null" };
let reviewSchema = null;

function valueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return TYPE_NAMES[typeof value] ?? typeof value;
}

function hasType(value, type) {
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "null": return value === null;
    default: return typeof value === type;
  }
}

function checkKeywords(schema) {
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`The review checker does not support the schema keyword "${key}".`);
  }
  for (const child of Object.values(schema.properties ?? {})) checkKeywords(child);
  if (schema.items && typeof schema.items === "object") checkKeywords(schema.items);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") checkKeywords(schema.additionalProperties);
}

function firstError(schema, value, at) {
  const where = at ? `\`${at}\`` : "the answer";
  if (schema.type && !hasType(value, schema.type)) {
    const actual = schema.type === "integer" && typeof value === "number" ? String(value) : valueKind(value);
    return `${where} must be ${TYPE_NAMES[schema.type] ?? schema.type}, not ${actual}.`;
  }
  if (schema.enum && !schema.enum.some((entry) => entry === value)) {
    return `${where} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}, not ${JSON.stringify(value)}.`;
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    return `${where} must be at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"} long.`;
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) {
    return `${where} must be at least ${schema.minimum}, not ${value}.`;
  }
  if (typeof value === "number" && schema.maximum != null && value > schema.maximum) {
    return `${where} must be at most ${schema.maximum}, not ${value}.`;
  }
  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      const error = firstError(schema.items, item, `${at}[${index}]`);
      if (error) return error;
    }
  }
  if (hasType(value, "object")) {
    const child = (key) => (at ? `${at}.${key}` : key);
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `\`${child(key)}\` is missing.`;
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) return `\`${child(key)}\` is not allowed.`;
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const error = firstError(schema.additionalProperties, value[key], child(key));
        if (error) return error;
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const error = firstError(propertySchema, value[key], child(key));
      if (error) return error;
    }
  }
  return null;
}

export function reviewSchemaError(value) {
  reviewSchema ??= JSON.parse(fs.readFileSync(REVIEW_SCHEMA_URL, "utf8"));
  checkKeywords(reviewSchema);
  return firstError(reviewSchema, value, "");
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

// The heading uses `meta.backendLabel` or the default backend's label.
export function renderReviewResult(parsedResult, meta) {
  const backend = meta.backendLabel ?? DEFAULT_BACKEND.label;
  if (!parsedResult.parsed) {
    const lines = [
      `# ${backend} ${meta.reviewLabel}`,
      "",
      `${backend} did not return valid structured JSON.`,
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = reviewSchemaError(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# ${backend} ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      `${backend} returned JSON with an unexpected review shape.`,
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# ${backend} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const backend = meta.backendLabel ?? DEFAULT_BACKEND.label;
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# ${backend} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push(`${backend} review completed without any stdout output.`);
  } else {
    lines.push(meta.errorMessage ? `${backend} review failed: ${meta.errorMessage}` : `${backend} review failed.`);
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}
