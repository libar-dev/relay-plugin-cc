// P0: `kimi acp` in a scratch, signed-out KIMI_CODE_HOME. No model call is possible.
// Records: the initialize answer, what session/new does without credentials, and what the
// server writes into an empty home.
import fs from "node:fs";
import path from "node:path";
import { startAcp } from "./acp-lib.mjs";

const root = process.argv[2];
const home = path.join(root, "home-signed-out");
const work = path.join(root, "work");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const env = { ...process.env, KIMI_CODE_HOME: home, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_DISABLE_TELEMETRY: "1" };
const acp = startAcp({ binary: process.env.KIMI_BINARY, cwd: work, env, log: path.join(root, "p0.log.jsonl") });
const summary = {};
try {
  summary.initialize = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  try {
    summary.sessionNew = await acp.request("session/new", { cwd: work, mcpServers: [] });
  } catch (error) {
    summary.sessionNewError = error.rpc ?? String(error);
  }
} finally {
  summary.exit = await acp.close();
  summary.elapsedMs = acp.elapsed();
}
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    files.push(path.relative(home, p) + (e.isDirectory() ? "/" : ""));
    if (e.isDirectory()) walk(p);
  }
};
walk(home);
summary.homeAfter = files;
fs.writeFileSync(path.join(root, "p0.summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
