import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeCodex } from "../fakes/codex.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { readLease } from "../../plugins/relay/scripts/lib/jobs/lease.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/relay/scripts/companion.mjs");
export const HEADER = "model: gpt-test\neffort: low";

export function setup(t, options = {}) {
  const root = makeTempDir("relay-job-test-");
  const bin = path.join(root, "bin");
  const jobs = path.join(root, "jobs");
  const work = path.join(root, "work");
  const user = path.join(root, "user");
  for (const dir of [bin, jobs, work, user]) fs.mkdirSync(dir);
  installFakeCodex(bin, options.behavior ?? "job", { turnMs: options.turnMs ?? 50 });
  const env = {
    ...buildEnv(bin), HOME: user, USERPROFILE: user, CODEX_HOME: undefined,
    // Setup checks every backend it finds: point Grok and ZCode at this bin, never at a real install.
    GROK_BINARY: path.join(bin, "grok"), ZCODE_BINARY: path.join(bin, "zcode"),
    RELAY_JOBS_HOME: jobs, RELAY_JOBS_POLL_MS: "20", RELAY_JOBS_WAIT_POLL_MS: "20",
    RELAY_JOBS_HEARTBEAT_MS: "200", ...options.env
  };
  const ctx = {
    root, bin, jobs, work, user, env,
    fakeState: () => JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"))
  };
  t.after(() => {
    for (const dir of jobDirs(ctx)) {
      const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
      companion(ctx, ["cancel", job.id]);
    }
  });
  return ctx;
}

export function companion(ctx, args, extra = {}) {
  return run(process.execPath, [SCRIPT, ...args], { cwd: ctx.work, env: { ...ctx.env, ...extra } });
}

export function makeHome(ctx, name = ".codex", config = 'model = "gpt-test"\n') {
  const dir = path.join(ctx.user, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), config);
  return fs.realpathSync(dir);
}

export function promptFile(ctx, header = HEADER, brief = "[quick] First turn.") {
  const file = path.join(ctx.root, "prompt.md");
  fs.writeFileSync(file, `${header}\n---\n${brief}`);
  return file;
}

export function startJob(ctx, header = HEADER, brief, extra = {}) {
  const result = companion(ctx, ["start", "--prompt-file", promptFile(ctx, header, brief)], extra);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const id = /^job: (\S+)$/m.exec(result.stdout)?.[1];
  assert.ok(id, result.stdout);
  return { id, start: result.stdout };
}

export function jobDirs(ctx) {
  return fs.readdirSync(ctx.jobs, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const slug = path.join(ctx.jobs, entry.name);
    return fs.readdirSync(slug).map(name => path.join(slug, name))
      .filter(dir => fs.existsSync(path.join(dir, "job.json")));
  });
}

export function jobDir(ctx, id) {
  return jobDirs(ctx).find(dir => path.basename(dir) === id);
}

export function readJob(ctx, id) {
  return JSON.parse(fs.readFileSync(path.join(jobDir(ctx, id), "job.json"), "utf8"));
}

export async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = predicate(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

export async function finishJob(ctx, id, expected = 0) {
  const result = companion(ctx, ["wait", id, "--timeout-seconds", "15"]);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  // Wait also for lease release and process-end records before comparing reader output.
  await waitFor(() => !readLease(jobDir(ctx, id)));
  return result;
}
