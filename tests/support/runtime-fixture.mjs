import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildEnv } from "../fakes/codex.mjs";
import { makeTempDir } from "./helpers.mjs";


function findJobDirs(repo) {
  const home = process.env.RELAY_JOBS_HOME;
  const found = [];
  for (const slug of fs.readdirSync(home)) {
    for (const id of fs.readdirSync(path.join(home, slug))) {
      const dir = path.join(home, slug, id);
      if (!fs.existsSync(path.join(dir, "job.json"))) {
        continue;
      }
      const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
      if (!repo || (job.request?.cwd && fs.realpathSync(job.request.cwd) === fs.realpathSync(repo))) {
        found.push({ dir, job });
      }
    }
  }
  return found.sort((a, b) => String(b.job.createdAt).localeCompare(String(a.job.createdAt)));
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "relay");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "hooks/stop-review-gate.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

// Setup checks every backend home it finds: a scratch HOME, and Grok and ZCode pointed at
// binaries that do not exist, so no test reads a real home or runs a real install.
function setupEnv(binDir, extra = {}) {
  return {
    ...buildEnv(binDir),
    HOME: makeTempDir("relay-setup-home-"),
    GROK_BINARY: path.join(binDir, "grok"),
    ZCODE_BINARY: path.join(binDir, "zcode"),
    ...extra
  };
}

function codexBlock(result) {
  const payload = JSON.parse(result.stdout);
  return { payload, codex: payload.backends.find((block) => block.backend === "codex" && block.homeDefault) };
}
export { findJobDirs, ROOT, PLUGIN_ROOT, SCRIPT, STOP_HOOK, waitFor, setupEnv, codexBlock };
