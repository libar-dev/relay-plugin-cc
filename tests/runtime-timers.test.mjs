import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./support/helpers.mjs";

// An older Node without MockTimers must report a versioned skip, rather than a
// passing empty case or a failed timer case. Keep this check portable across Node versions.
test("an unavailable timer API skips with the Node version", () => {
  const preload = `
    import test from "node:test";
    Object.defineProperty(process.versions, "node", { value: "18.18.0" });
    Object.defineProperty(process, "version", { value: "v18.18.0" });
    Object.defineProperty(Object.getPrototypeOf(test.mock), "timers", { get() { return undefined; } });
  `;
  const env = { ...process.env, CODEX_HOME: makeTempDir("codex-timer-api-home-") };
  // This is a separate test runner, rather than a worker of the parent's runner.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`,
    "--test", "--test-reporter=tap",
    "--test-name-pattern=^.*inference waits the full 250ms window$",
    fileURLToPath(new URL("./codex-turns.test.mjs", import.meta.url))
  ], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env,
    encoding: "utf8", timeout: 10000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# SKIP .*Node v?18\.18\.0\b/);
  assert.match(result.stdout, /# fail 0\n/);
});
