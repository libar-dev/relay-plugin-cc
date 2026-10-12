import { parseCommandInput, resolveCommandCwd, outputResult } from "./shared.mjs";
import process from "node:process";
import { backendWith } from "../lib/backends/index.mjs";
import { resolveClaudeSessionPath } from "../lib/harness/session-path.mjs";


export async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const sourcePath = resolveClaudeSessionPath(cwd, { source: options.source });
  const result = await backendWith("transfer").transfer(cwd, sourcePath, process.env);
  outputResult(options.json ? result.payload : `${result.lines.join("\n")}\n`, options.json);
}
