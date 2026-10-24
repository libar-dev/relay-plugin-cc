import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { setup, companion, startJob, waitFor } from "./support/job-helpers.mjs";
import { DEFAULTS as D } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { relayContext, relayStart, jobDirOf, pre, stop, decision } from "./support/relay-fixture.mjs";
const GiB = 2 ** 30;
function readings(env, root) {
  env.RELAY_ADMISSION = "on";
  env.RELAY_ADMISSION_HOME = path.join(root, "domain");
  env.RELAY_TEST_ADMISSION_READINGS = path.join(root, "readings.json");
  env.RELAY_ADMISSION_POLL_MS = "25";
  env.RELAY_JOBS_ACK_TIMEOUT_MS = "200";
  const write = availableBytes => fs.writeFileSync(env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ availableBytes, totalBytes: 128 * GiB, cores: 64, load5: 0 }));
  write(0); return write;
}

test("workerless starts and continuations refuse; an explicit resume after pressure clears runs the work", t => {
  const ctx = setup(t), write = readings(ctx.env, ctx.root);
  const file = path.join(ctx.root, "prompt.md");
  fs.writeFileSync(file, "model: synthetic-model\neffort: low\n---\n[quick] Initial brief.");
  const start = companion(ctx, ["start", "--prompt-file", file, "--json"]);
  assert.equal(start.status, 6, start.stdout + start.stderr);
  const id = JSON.parse(start.stdout).jobId;
  const initial = JSON.parse(companion(ctx, ["status", id, "--json"]).stdout);
  assert.equal(initial.state, "failed"); assert.equal(initial.attempts, 0);
  assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false);
  const next = companion(ctx, ["continue", id, "--message", "[quick] Withdraw this.", "--json"]);
  assert.equal(next.status, 6, next.stdout + next.stderr);
  assert.equal(JSON.parse(next.stdout).outcome.action, "not-started");
  write(100 * GiB);
  assert.equal(companion(ctx, ["wait", id, "--timeout-seconds", "1"]).status, 6);
  assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false);
  ctx.env.RELAY_JOBS_ACK_TIMEOUT_MS = "5000";
  assert.equal(companion(ctx, ["resume", id]).status, 0);
  const done = companion(ctx, ["wait", id, "--timeout-seconds", "15", "--json"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).state, "completed");
});

for (const workflow of [false, true]) test(`relay ${workflow ? "Workflow" : "Agent"} queued result never finishes before admission`, async () => {
  const ctx = relayContext("job", { workflow: workflow ? "synthetic-run" : null, turnMs: 50 });
  // Fixture paths are beneath a synthetic temporary home.
  const write = readings(ctx.env, ctx.env.RELAY_JOBS_HOME);
  write(128 * GiB * D.criticalFraction + 2 * D.workerBytes);
  ctx.env.RELAY_JOBS_ACK_TIMEOUT_MS = "5000";
  if (workflow) ctx.append(ctx.userRequest(), ctx.environment(), ctx.workflowPrompt("computedTask", "[quick] Queued relay."), ctx.snapshot());
  else ctx.append(ctx.prompt(`model: synthetic-model\neffort: ${D.lightEfforts[0]}\n---\n[quick] Queued relay.`));
  const { jobId: id, started } = await relayStart(ctx);
  assert.ok(id, started.stdout);
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(jobDirOf(ctx, id), "job.json"))).state === "queued");
  assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "deny");
  assert.equal((await stop(ctx, "done"))?.decision, "block");
  write(100 * GiB);
  const done = companion({ work: ctx.work, env: ctx.env }, ["wait", id, "--timeout-seconds", String(D.spacingMs / 1000 + 10), "--json"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).state, "completed");
});

for (const json of [false, true]) test(`background task refuses without a worker (${json ? "JSON" : "text"})`, { skip: !["linux", "darwin"].includes(process.platform) }, t => {
  const ctx = setup(t); readings(ctx.env, ctx.root);
  const result = companion(ctx, ["task", "--background", ...(json ? ["--json"] : []), "[quick] Deferred task."]);
  assert.equal(result.status, 6, result.stderr);
  if (json) assert.equal(JSON.parse(result.stdout).state, "not started");
  else assert.match(result.stdout, /state: not started/);
});
