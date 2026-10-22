import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_VERSION } from "../plugins/relay/scripts/lib/util/plugin.mjs";
import { companion, finishJob, HEADER, makeHome, readJob, ROOT, setup, startJob, waitFor } from "./support/job-helpers.mjs";

const FIXTURE = path.join(ROOT, "tests/fixtures/codex-golden.json");

// Normalize only generated identities, directories and clock/process values. Request keys,
// defaults, ordering, state text, status columns and every other JSON value remain exact.
function normalizer(ctx, id) {
  const clientIds = [...new Set(ctx.fakeState().requests.map(request => request.params.clientUserMessageId).filter(Boolean))];
  const slug = readJob(ctx, id).repoSlug;
  const replace = value => {
    let text = value.replaceAll(id, "<job>").replaceAll(slug, "<repo>");
    text = text.replaceAll(fs.realpathSync(ctx.root), "<tmp>").replaceAll(ctx.root, "<tmp>");
    for (const [index, clientId] of clientIds.entries()) text = text.replaceAll(clientId, `<message-${index + 1}>`);
    return text.replace(/\b\d+[hms](?: \d+[hms])*/g, "<duration>").replace(/<duration> +(?=\|)/g, "<duration> ");
  };
  const walk = (value, key = "") => {
    if (value == null) return value;
    if (["pid", "serverPid"].includes(key)) return "<pid>";
    if (key === "relayVersion") return "<version>";
    if (key === "startTime" || /^(createdAt|updatedAt|startedAt|endedAt|completedAt)$/.test(key)) return "<time>";
    if (Array.isArray(value)) return value.map(item => walk(item));
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return typeof value === "string" ? replace(value) : value;
  };
  return walk;
}

for (const inherited of [false, true]) {
  test(`Codex golden output with CODEX_HOME ${inherited ? "inherited" : "unset"}`, async t => {
    const ctx = setup(t, { turnMs: 1500 });
    // Pin the allowed fast tier so the golden status header stays exact.
    fs.writeFileSync(path.join(ctx.jobs, "config.json"), JSON.stringify({ fastTier: "allowed" }));
    if (inherited) ctx.env.CODEX_HOME = makeHome(ctx, ".codex");
    const { id, start } = startJob(ctx, HEADER, "First turn.");
    await waitFor(() => readJob(ctx, id).turnId);
    const steer = companion(ctx, ["steer", id, "--message", "Also check the tests."]);
    assert.equal(steer.status, 0, steer.stderr);
    assert.match(steer.stdout, /outcome: steered/);
    const snapshots = [];
    const snapshot = async phase => {
      await finishJob(ctx, id);
      const block = companion(ctx, ["result", id, "--state-only"]);
      const status = companion(ctx, ["status", "--json"]);
      const row = companion(ctx, ["status"]);
      assert.equal(block.status, 0, block.stderr);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(row.status, 0, row.stderr);
      snapshots.push({ phase, block: block.stdout, status: JSON.parse(status.stdout), row: row.stdout });
    };
    await snapshot("start-and-steer");
    assert.equal(companion(ctx, ["continue", id, "--message", "[quick] Second turn."]).status, 0);
    await snapshot("continue");
    assert.equal(companion(ctx, ["resume", id, "--message", "[quick] Third turn."]).status, 0);
    await snapshot("resume");
    const state = ctx.fakeState();
    assert.deepEqual(state.requests.map(request => request.method), [
      "thread/start", "turn/start", "turn/steer", "thread/resume", "turn/start", "thread/resume", "turn/start"
    ]);
    assert.equal(state.spawnHomes.length, 3);
    const actual = normalizer(ctx, id)({ start, spawnHomes: state.spawnHomes, requests: state.requests, snapshots });
    const key = inherited ? "inherited" : "unset";
    const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"))[key];
    // The version follows the manifest; the fixture keeps the rest of the output fixed.
    for (const snapshot of expected.snapshots) {
      snapshot.row = snapshot.row.replace("\nfast-tier: allowed\n", `\nfast-tier: allowed\nrelay-version: ${PLUGIN_VERSION}\n`);
    }
    assert.deepEqual(actual, expected);
  });
}
