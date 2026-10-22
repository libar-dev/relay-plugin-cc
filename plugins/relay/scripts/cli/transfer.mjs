import { parseCommandInput, resolveCommandCwd, printJson } from "./shared.mjs";
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
  if (options.json) printJson("transfer", result.payload);
  else process.stdout.write(`${result.lines.join("\n")}\n`);
}
