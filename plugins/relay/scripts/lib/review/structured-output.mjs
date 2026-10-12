import { DEFAULT_BACKEND } from "../backends/index.mjs";
import { readJsonFile } from "../util/fs.mjs";


export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? `${DEFAULT_BACKEND.label} did not return a final structured message.`,
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}


export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
