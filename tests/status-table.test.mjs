import "./support/isolate-env.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { renderJobList } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { repoSlugFor } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { makeTempDir, run } from "./support/helpers.mjs";
import { SCRIPT } from "./support/runtime-fixture.mjs";

function view(job = {}, fields = {}) {
  return {
    job: {
      id: "job-1", createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:07Z",
      summary: "Done.", request: { model: "gpt-test", effort: "low" }, ...job
    },
    state: "completed", paths: { brief: "" }, ...fields
  };
}

test("empty status lists keep their scope", () => {
  assert.equal(renderJobList([]), "No jobs.\n");
  assert.equal(renderJobList([], { scope: "for this repository" }), "No jobs for this repository.\n");
});

test("one Codex task has every table column and a final newline", () => {
  assert.equal(renderJobList([view()]), [
    "jobs: 1",
    "",
    "| job   | state     | kind | backend | model/effort | duration | summary | relay |",
    "|-------|-----------|------|---------|--------------|----------|---------|-------|",
    "| job-1 | completed | task | codex   | gpt-test/low | 7s       | Done.   |       |",
    ""
  ].join("\n"));
});

test("mixed backends include their view lines and keep input order", () => {
  const views = [
    view(),
    view({ id: "job-2", request: { backend: "grok", model: "grok-code", effort: "high", grokHome: "/tmp/grok-home", grokHomeDefault: false } }),
    view({ id: "job-3", request: { backend: "kimi", model: "kimi-code", effort: "low", kimiHomeDefault: true } }),
    view({ id: "job-4", request: { backend: "zcode", model: "glm", effort: "low" } })
  ];
  assert.equal(renderJobList(views), [
    "jobs: 4",
    "",
    "| job   | state     | kind | backend                         | model/effort   | duration | summary | relay |",
    "|-------|-----------|------|---------------------------------|----------------|----------|---------|-------|",
    "| job-1 | completed | task | codex                           | gpt-test/low   | 7s       | Done.   |       |",
    "| job-2 | completed | task | grok, grok-home: /tmp/grok-home | grok-code/high | 7s       | Done.   |       |",
    "| job-3 | completed | task | kimi                            | kimi-code/low  | 7s       | Done.   |       |",
    "| job-4 | completed | task | zcode                           | glm/low        | 7s       | Done.   |       |",
    ""
  ].join("\n"));
});

test("relay cells include labels, workflow runs, adoptions, handbacks and automatic resumes", () => {
  const views = [
    view({ id: "job-1", relay: { agentId: "a1", label: "  Say\n hi  " } }),
    view({ id: "job-2", relay: { agentId: "a2", workflowRunId: "wf_1", previous: [{ agentId: "old" }, { agentId: "older" }] } }),
    view({ id: "job-3", relay: { agentId: "a3" }, attempts: [{ relayVersion: "3.0.0" }] }),
    view({ id: "job-4", relay: { agentId: "a4" }, attempts: [{ relayVersion: "3.0.0" }], automaticResumes: [{ id: "m1" }, { id: "m2" }] }, { handbacks: [{ attempts: 1, state: "completed", at: "2026-01-01T00:00:08Z" }] })
  ];
  assert.equal(renderJobList(views), [
    "jobs: 4",
    "",
    "| job   | state     | kind | backend | model/effort | duration | summary | relay                          |",
    "|-------|-----------|------|---------|--------------|----------|---------|--------------------------------|",
    "| job-1 | completed | task | codex   | gpt-test/low | 7s       | Done.   | relay:a1/Say hi                |",
    "| job-2 | completed | task | codex   | gpt-test/low | 7s       | Done.   | workflow:wf_1/a2, adopted:2    |",
    "| job-3 | completed | task | codex   | gpt-test/low | 7s       | Done.   | relay:a3, not handed back      |",
    "| job-4 | completed | task | codex   | gpt-test/low | 7s       | Done.   | relay:a4, automatic-resumes: 2 |",
    ""
  ].join("\n"));
});

test("stalled running jobs mark their state and unknown duration", () => {
  assert.equal(renderJobList([view({ createdAt: null, request: {} }, { state: "running", stalled: true })]), [
    "jobs: 1",
    "",
    "| job   | state             | kind | backend | model/effort    | duration | summary | relay |",
    "|-------|-------------------|------|---------|-----------------|----------|---------|-------|",
    "| job-1 | running (stalled) | task | codex   | default/default | ?        | Done.   |       |",
    ""
  ].join("\n"));
});

test("cells collapse whitespace, escape pipes, preserve backticks and count code points", () => {
  assert.equal(renderJobList([view({ id: "😀", summary: "  Use | pipes\nand `ticks`  " })]), [
    "jobs: 1",
    "",
    "| job | state     | kind | backend | model/effort | duration | summary                  | relay |",
    "|-----|-----------|------|---------|--------------|----------|--------------------------|-------|",
    "| 😀   | completed | task | codex   | gpt-test/low | 7s       | Use \\| pipes and `ticks` |       |",
    ""
  ].join("\n"));
});

test("summaries keep the existing 80-character truncation", () => {
  assert.equal(renderJobList([view({ summary: "a".repeat(81) })]), [
    "jobs: 1",
    "",
    "| job   | state     | kind | backend | model/effort | duration | summary                                                                          | relay |",
    "|-------|-----------|------|---------|--------------|----------|----------------------------------------------------------------------------------|-------|",
    "| job-1 | completed | task | codex   | gpt-test/low | 7s       | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa... |       |",
    ""
  ].join("\n"));
});

test("review jobs retain their kind and longer duration", () => {
  assert.equal(renderJobList([view({ id: "review-1", kind: "review", completedAt: "2026-01-01T01:02:03Z" })]), [
    "jobs: 1",
    "",
    "| job      | state     | kind   | backend | model/effort | duration | summary | relay |",
    "|----------|-----------|--------|---------|--------------|----------|---------|-------|",
    "| review-1 | completed | review | codex   | gpt-test/low | 1h 2m 3s | Done.   |       |",
    ""
  ].join("\n"));
});

test("companion status prints its headers, then jobs and a blank line before the table", () => {
  const root = makeTempDir("relay-status-table-");
  const work = path.join(root, "work");
  const jobs = path.join(root, "jobs");
  fs.mkdirSync(work);
  fs.mkdirSync(jobs);
  const slug = repoSlugFor(work);
  const jobDir = path.join(jobs, slug, "job-1");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ ...view().job, state: "completed" }));
  fs.writeFileSync(path.join(jobs, "config.json"), JSON.stringify({ fastTier: "allowed" }));
  const result = run(process.execPath, [SCRIPT, "status"], { cwd: work, env: { ...process.env, RELAY_JOBS_HOME: jobs } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    `jobs-home: ${jobs}`,
    `repo: ${slug}`,
    "review-gate: disabled",
    "fast-tier: allowed",
    "jobs: 1",
    "",
    "| job   | state     | kind | backend | model/effort | duration | summary | relay |",
    "|-------|-----------|------|---------|--------------|----------|---------|-------|",
    "| job-1 | completed | task | codex   | gpt-test/low | 7s       | Done.   |       |",
    ""
  ].join("\n"));
});
