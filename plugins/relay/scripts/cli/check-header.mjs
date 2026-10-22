import fs from "node:fs";
import process from "node:process";
import { readLaunchPrompt, UsageError } from "../lib/jobs/request.mjs";

export function handleCheckHeader(argv) {
  if (argv.length) throw new UsageError("check-header takes no arguments.");
  const text = fs.readFileSync(0, "utf8");
  try {
    readLaunchPrompt(text, { baseDir: process.cwd(), env: process.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`error: ${message.replace(/\s+/g, " ").trim()}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("ok\n");
}
