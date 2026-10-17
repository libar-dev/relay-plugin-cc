// The test root's own cleanup (support/isolate-env.mjs), run in child processes with a scratch
// temporary directory: a signal skips the exit handler, so the next run sweeps the root of an
// owner that is gone; a live owner keeps its root; and outside Linux, a process whose working
// directory alone is in a root keeps it.
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { makeTempDir } from "./support/helpers.mjs";

const ISO = new URL("./support/isolate-env.mjs", import.meta.url).href;
const childEnv = tmp => { const env = { ...process.env, TMPDIR: tmp }; delete env.RELAY_TEST_ROOT; return env; };

// A child that makes its root, prints it and waits.
async function owner(tmp) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(ISO)}); console.log(process.env.RELAY_TEST_ROOT); setInterval(() => {}, 1000);`], { env: childEnv(tmp), stdio: ["ignore", "pipe", "ignore"] });
  const [line] = await once(child.stdout, "data");
  return { child, root: String(line).trim() };
}
const run = tmp => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(ISO)});`], { env: childEnv(tmp), encoding: "utf8" });

test("a root whose owner a signal killed is swept by the next run; a live owner's root is kept", async t => {
  const tmp = makeTempDir("relay-roots-");
  const killed = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const { child, root } = await owner(tmp);
    child.kill(signal);
    await once(child, "exit");
    assert.equal(fs.existsSync(root), true, `${signal} skips the exit handler`);
    killed.push(root);
  }
  const live = await owner(tmp);
  t.after(() => live.child.kill("SIGKILL"));
  assert.equal(run(tmp).status, 0);
  for (const root of killed) assert.equal(fs.existsSync(root), false, root);
  assert.equal(fs.existsSync(live.root), true, "a live owner keeps its root");
});

// The temporary directory is reached through a symlink, as macOS's /var/folders is through
// /private/var: lsof and /proc name a working directory by its real path.
for (const platform of ["linux", "darwin"]) {
  test(`${platform}: a process whose working directory alone is in the root keeps it, though the root's path goes through a symlink`, { skip: platform === "darwin" && spawnSync("lsof", ["-v"]).error ? "no lsof" : process.platform !== "linux" && platform === "linux" ? "linux only" : false }, t => {
    const real = makeTempDir("relay-roots-");
    const alias = `${real}-alias`;
    fs.symlinkSync(real, alias);
    t.after(() => fs.rmSync(alias, { force: true }));
    // On macOS, ps shows no working directory, so the check must find it with lsof.
    const source = `${platform === "darwin" ? 'Object.defineProperty(process, "platform", { value: "darwin" });' : ""}
      await import(${JSON.stringify(ISO)});
      const sleeper = (await import("node:child_process")).spawn("sleep", ["30"], { cwd: process.env.RELAY_TEST_ROOT, detached: true, stdio: "ignore" });
      sleeper.unref();
      console.log(sleeper.pid);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...childEnv(alias), RELAY_TEST_ROOT_WAIT_MS: "300" }, encoding: "utf8" });
    // The first line; the test runner's summary follows it.
    const pid = Number(result.stdout.trim().split("\n")[0]);
    t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
    assert.match(result.stderr, new RegExp(`note: kept the test root ${alias}/relay-test-run-\\w+: processes still run from it: ${pid}\\n`));
    assert.equal(fs.readdirSync(real).filter(name => name.startsWith("relay-test-run-")).length, 1);
  });
}
