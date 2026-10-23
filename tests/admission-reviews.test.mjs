import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleReviewCommand } from "../plugins/relay/scripts/cli/review.mjs";
import { backendNamed } from "../plugins/relay/scripts/lib/backends/index.mjs";
import { connectOptions } from "../plugins/relay/scripts/lib/backends/codex/turn.mjs";
import { setup, jobDirs, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo, run } from "./support/helpers.mjs";
import { readJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";

for (const native of [true, false]) test(`foreground ${native ? "native" : "ordinary"} review waits, forwards identity hooks and releases after close`, async t => {
  const ctx = setup(t, { behavior: "review-ok" });
  initGitRepo(ctx.work);
  fs.writeFileSync(path.join(ctx.work, "example.js"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: ctx.work }); run("git", ["commit", "-m", "fixture"], { cwd: ctx.work });
  fs.writeFileSync(path.join(ctx.work, "example.js"), "export const value = 2;\n");
  const home = path.join(ctx.root, "admission"), fixture = path.join(ctx.root, "readings.json");
  const values = { ...ctx.env, RELAY_ADMISSION: "on", RELAY_ADMISSION_HOME: home, RELAY_ADMISSION_READINGS: fixture, RELAY_ADMISSION_POLL_MS: "20" };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const reading = availableBytes => fs.writeFileSync(fixture, JSON.stringify({ availableBytes, totalBytes: 64 * 2 ** 30, cores: 8, load5: 0 }));
  reading(0);
  const output = [], progress = [];
  const stdout = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk, ...args) => { if (typeof chunk === "string" && chunk.startsWith("{")) { output.push(chunk); return true; } return stdout(chunk, ...args); });
  t.mock.method(process.stderr, "write", chunk => { progress.push(String(chunk)); return true; });
  const backend = backendNamed("codex");
  let spawned = 0, ended = 0, dir;
  const instrument = hooks => ({ ...hooks,
    onSpawn(proc) { spawned++; assert.ok(fs.existsSync(path.join(home, "slots", `${readJob(dir).id}.json`))); hooks.onSpawn(proc); },
    onEnd(info) { ended++; assert.ok(fs.existsSync(path.join(home, "slots", `${readJob(dir).id}.json`))); hooks.onEnd(info); }
  });
  if (native) {
    const original = backend.review.native;
    t.mock.method(backend.review, "native", (request, target, hooks) => original(request, target, instrument(hooks)));
  } else {
    const original = backend.connect;
    t.mock.method(backend, "connect", (request, hooks) => original(request, instrument(hooks)));
  }
  const running = handleReviewCommand(["--cwd", ctx.work, "--json", "--model", "ordinary"], { reviewName: native ? "Review" : "Adversarial Review" });
  await waitFor(() => { dir = jobDirs(ctx)[0]; return dir && readJob(dir).state === "queued"; });
  assert.equal(spawned, 0); assert.equal(readJob(dir).attempts[0].state, "queued");
  reading(60 * 2 ** 30); await running;
  assert.equal(spawned, 1); assert.equal(ended, 1);
  const job = readJob(dir);
  assert.equal(job.state, "completed"); assert.ok(job.server.endedAt);
  assert.ok(job.admission.since); assert.ok(job.admission.admittedAt);
  assert.equal(fs.existsSync(path.join(home, "slots", `${job.id}.json`)), false);
  assert.equal(JSON.parse(output.join("")).backend, "codex");
  assert.match(progress.join(""), /review queued/);
});

test("native connectOptions retains environment and lifecycle callbacks", () => {
  const options = { env: { SYNTHETIC: "1" }, onSpawn() {}, onEnd() {}, notificationTap() {}, args: ["app-server"] };
  assert.deepEqual(connectOptions(options), options);
});
