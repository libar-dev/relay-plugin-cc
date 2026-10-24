import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { setup, companion, startJob } from "./support/job-helpers.mjs";
import { DEFAULTS as D } from "../plugins/relay/scripts/lib/worker/admission.mjs";
import { relayContext, relayStart, jobDirOf, pre, stop, decision } from "./support/relay-fixture.mjs";
const GiB = 2 ** 30;
function readings(env, root) {
  env.RELAY_ADMISSION = "on";
  env.RELAY_ADMISSION_HOME = path.join(root, "domain");
  env.RELAY_TEST_ADMISSION_READINGS = path.join(root, "readings.json");
  env.RELAY_ADMISSION_POLL_MS = "25";
  const write = availableBytes => fs.writeFileSync(env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify({ availableBytes, totalBytes: 128 * GiB, cores: 64, load5: 0 }));
  write(0); return write;
}

test("start defers a worker at critical pressure; continue is durable, wait owns retry and cancel works", t => {
  const ctx = setup(t), write = readings(ctx.env, ctx.root);
  const { id, start } = startJob(ctx);
  assert.match(start, /state: queued/);
  const initial = JSON.parse(companion(ctx, ["status", id, "--json"]).stdout);
  assert.equal(initial.state, "queued"); assert.equal(initial.attempts, 0);
  assert.equal(fs.existsSync(path.join(ctx.bin, "fake-codex-state.json")), false);
  const next = companion(ctx, ["continue", id, "--message", "[quick] Queued follow-up.", "--json"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).outcome.action, "queued-next-turn");
  const pending = companion(ctx, ["wait", id, "--timeout-seconds", "0", "--exit-zero-while-running"]);
  assert.equal(pending.status, 0); assert.match(pending.stdout, /still running: not an error/);
  write(100 * GiB);
  const done = companion(ctx, ["wait", id, "--json", "--timeout-seconds", String((D.spacingMs * 3) / 1000 + 10)]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).attempts, 2);
  write(0);
  const second = startJob(ctx);
  const cancelled = companion(ctx, ["cancel", second.id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).state, "cancelled");
  const ended = JSON.parse(companion(ctx, ["status", second.id, "--json"]).stdout);
  assert.equal(ended.admission.state, "cancelled");
  assert.ok(ended.admission.since); assert.match(ended.admission.reason, /memory/);
});

for (const workflow of [false, true]) test(`relay ${workflow ? "Workflow" : "Agent"} queued result never finishes before admission`, async () => {
  const ctx = relayContext("job", { workflow: workflow ? "synthetic-run" : null, turnMs: 50 });
  // Fixture paths are beneath a synthetic temporary home.
  const write = readings(ctx.env, ctx.env.RELAY_JOBS_HOME);
  if (workflow) ctx.append(ctx.userRequest(), ctx.environment(), ctx.workflowPrompt("computedTask", "[quick] Queued relay."), ctx.snapshot());
  else ctx.append(ctx.prompt(`model: synthetic-model\neffort: ${D.lightEfforts[0]}\n---\n[quick] Queued relay.`));
  const { jobId: id, started } = await relayStart(ctx);
  assert.ok(id, started.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobDirOf(ctx, id), "job.json"))).state, "queued");
  assert.equal(decision(await pre(ctx, "SubagentHandback", { message: "done" })), "deny");
  assert.equal((await stop(ctx, "done"))?.decision, "block");
  write(100 * GiB);
  const done = companion({ work: ctx.work, env: ctx.env }, ["wait", id, "--timeout-seconds", String(D.spacingMs / 1000 + 10), "--json"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).state, "completed");
});

for (const json of [false, true]) test(`background task reports deferred state (${json ? "JSON" : "text"})`, { skip: !["linux", "darwin"].includes(process.platform) }, t => {
  const ctx = setup(t); readings(ctx.env, ctx.root);
  const result = companion(ctx, ["task", "--background", ...(json ? ["--json"] : []), "[quick] Deferred task."]);
  assert.equal(result.status, 0, result.stderr);
  if (json) assert.equal(JSON.parse(result.stdout).state, "queued");
  else assert.match(result.stdout, /state: queued/);
});
