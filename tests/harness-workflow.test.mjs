import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { readWorkflowRunId } from "../plugins/relay/scripts/lib/harness/workflow.mjs";
import { makeTempDir } from "./support/helpers.mjs";

// Cut from probe-run-2/session's Workflow result (Claude Code 2.1.308), with paths replaced.
const WORKFLOW_RESULT = {
  "parentUuid": "4ad9d131-82fd-4268-8b32-8524956e9d4c",
  "isSidechain": false,
  "promptId": "f0255025-925f-43d8-ab87-8eada1ed86ac",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01RPp1aoawJakgGMkZN84ipM",
        "type": "tool_result",
        "content": "Workflow launched in background. Task ID: wceoygoi3\nSummary: Phase 3 probe: a denied and a valid relay spawn\nTranscript dir: /fixture/session/fb7d63d5-7301-4c4d-9fe7-de05317a900e/subagents/workflows/wf_6cfd5d48-93f\nScript file: /fixture/session/fb7d63d5-7301-4c4d-9fe7-de05317a900e/workflows/scripts/p3-probe-deny-wf_6cfd5d48-93f.js\n(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: \"/fixture/session/fb7d63d5-7301-4c4d-9fe7-de05317a900e/workflows/scripts/p3-probe-deny-wf_6cfd5d48-93f.js\"} to iterate without resending the script.)\nRun ID: wf_6cfd5d48-93f\nTo resume after editing the script: Workflow({scriptPath: \"/fixture/session/fb7d63d5-7301-4c4d-9fe7-de05317a900e/workflows/scripts/p3-probe-deny-wf_6cfd5d48-93f.js\", resumeFromRunId: \"wf_6cfd5d48-93f\"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).\n\nYou will be notified when it completes. Use /workflows to watch live progress.",
        "is_error": false
      }
    ]
  },
  "uuid": "49d6f93f-d7b2-4468-abb9-a8cc4e1e8dea",
  "timestamp": "2026-10-22T11:04:37.524Z",
  "toolUseResult": {
    "status": "async_launched",
    "taskId": "wceoygoi3",
    "taskType": "local_workflow",
    "workflowName": "p3-probe-deny",
    "runId": "wf_6cfd5d48-93f",
    "summary": "Phase 3 probe: a denied and a valid relay spawn",
    "transcriptDir": "/fixture/session/fb7d63d5-7301-4c4d-9fe7-de05317a900e/subagents/workflows/wf_6cfd5d48-93f",
    "scriptPath": "/fixture/session/fb7d63d5-7301-4c4d-9fe7-de05317a900e/workflows/scripts/p3-probe-deny-wf_6cfd5d48-93f.js"
  },
  "sourceToolAssistantUUID": "4ad9d131-82fd-4268-8b32-8524956e9d4c",
  "permissionDecision": {
    "decision": "accept",
    "source": "config",
    "reasonType": "mode"
  },
  "session_id": "fb7d63d5-7301-4c4d-9fe7-de05317a900e",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/fixture/work",
  "sessionId": "fb7d63d5-7301-4c4d-9fe7-de05317a900e",
  "version": "2.1.308",
  "gitBranch": "master"
};

function transcript(entries) {
  const file = path.join(makeTempDir(), "caller.jsonl");
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

test("readWorkflowRunId finds the real Workflow tool result by task id", () => {
  const file = transcript([{ toolUseResult: { ...WORKFLOW_RESULT.toolUseResult, taskId: "other-task", runId: "other-run" } }, WORKFLOW_RESULT]);
  assert.equal(readWorkflowRunId(file, "wceoygoi3"), "wf_6cfd5d48-93f");
  assert.equal(readWorkflowRunId(file, "unknown-task"), null);
});

test("readWorkflowRunId ignores prose, malformed lines and incomplete trailing entries", () => {
  const file = transcript([{ message: WORKFLOW_RESULT.message }]);
  fs.appendFileSync(file, "{broken\nnull\n");
  assert.equal(readWorkflowRunId(file, "wceoygoi3"), null);
  fs.appendFileSync(file, JSON.stringify(WORKFLOW_RESULT) + '\n{"toolUseResult":');
  assert.equal(readWorkflowRunId(file, "wceoygoi3"), "wf_6cfd5d48-93f");
});

test("readWorkflowRunId requires a Workflow result with a nonempty string run id", () => {
  for (const patch of [{ taskType: "local_agent" }, { taskType: undefined }, { runId: "" }, { runId: "  " }, { runId: 42 }]) {
    const file = transcript([{ ...WORKFLOW_RESULT, toolUseResult: { ...WORKFLOW_RESULT.toolUseResult, ...patch } }]);
    assert.equal(readWorkflowRunId(file, "wceoygoi3"), null);
  }
});

test("readWorkflowRunId returns null for absent or unreadable transcripts and absent task ids", () => {
  const dir = makeTempDir();
  for (const file of [undefined, "", path.join(dir, "missing"), dir]) {
    assert.equal(readWorkflowRunId(file, "wceoygoi3"), null);
  }
  assert.equal(readWorkflowRunId(transcript([WORKFLOW_RESULT]), undefined), null);
});

// Exercise the module's admission hooks with the host API faked, including retries
// that enter the first step without another agent.spawn event.
import { register as registerHooks } from 'node:module';
const modStub = 'data:text/javascript,' + encodeURIComponent('export const atom = (key, initial) => ({key, initial}); export const read = async () => null; export const update = async () => {};');
registerHooks('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) { return s === 'claude-code' ? {url: ${JSON.stringify(modStub)}, shortCircuit: true} : next(s, c); }`));
const { register } = await import('../plugins/relay/hooks/mod/register.js');
function hooks(answers) {
  const handlers = {}, catches = {}, runs = [], calls = [];
  register((event, filter, handler) => { handlers[event] = handler ?? filter; return { catch(fn) { catches[event] = fn; return this; } }; });
  const $ = { plugin: { root: '/synthetic/plugin' }, session: { cwd: async () => '/synthetic/work' },
    process: { run: async (argv, init) => {
      runs.push({ argv, init });
      if (argv[2] === 'check-header') return { exitCode: 0, stdout: 'ok\n' };
      if (argv.includes('--bind')) return { exitCode: 0, stdout: 'bound\n' };
      const answer = answers.shift(); if (answer instanceof Error) throw answer;
      return { exitCode: 0, stdout: answer ?? 'pass\n' };
    } } };
  const next = async e => { calls.push(e); return { agentId: 'a-new' }; };
  return { handlers, catches, runs, calls, $, next };
}
const spawnEvent = { subagentType: 'relay:job', prompt: 'model: synthetic\neffort: low\n---\nDummy.' };

test('Workflow spawn holds through host waits and binds its reservation before the wrapper runs', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const h = hooks(['hold waiting worker limit: 2 of 2', 'hold waiting worker limit: 2 of 2', `pass ${id}`]);
  assert.deepEqual(await h.handlers['agent.spawn'](h.$, { ...spawnEvent, workflow: { runId: 'wf-one', agentIndex: 1 } }, h.next), { agentId: 'a-new' });
  assert.equal(h.calls.length, 1);
  const gate = h.runs.filter(r => r.argv[2] === 'gate'); assert.equal(gate.length, 4);
  assert.equal(gate[0].init.timeoutMs, 600000); assert.ok(gate[0].argv.includes('540'));
  assert.deepEqual(gate.at(-1).argv.slice(3), ['--bind', id, '--agent', 'a-new']);
  assert.equal(typeof h.catches['agent.spawn'], 'function');
});
test('plain spawns wait at most 30 seconds then deny with the capacity reason', async () => {
  const h = hooks(['hold waiting worker limit: 2 of 2']);
  const result = await h.handlers['agent.spawn'](h.$, spawnEvent, h.next);
  assert.match(result.deny, /relay is at capacity: waiting worker limit: 2 of 2/); assert.match(result.deny, /Workflow/);
  assert.equal(h.calls.length, 0); assert.ok(h.runs.at(-1).argv.includes('30'));
});
test('a gate crash falls back to the bounded start, while cancellation is denied by catch', async () => {
  const h = hooks([new Error('synthetic gate crash')]);
  await h.handlers['agent.spawn'](h.$, spawnEvent, h.next); assert.equal(h.calls.length, 1);
  const cancelled = hooks([new Error('process.run aborted')]);
  await assert.rejects(cancelled.handlers['agent.spawn'](cancelled.$, spawnEvent, cancelled.next), /aborted/);
  assert.ok(cancelled.catches['agent.spawn'](cancelled.$, spawnEvent).deny); assert.equal(cancelled.calls.length, 0);
});
test('resume spawns do not take another waiting place', async () => {
  const h = hooks([]); await h.handlers['agent.spawn'](h.$, { ...spawnEvent, resume: { agentId: 'a-old' } }, h.next);
  assert.equal(h.runs.length, 0); assert.equal(h.calls.length, 1);
});
test('a Workflow stall retry is gated at its first step even without agent.spawn', async () => {
  const h = hooks(['hold waiting worker limit: 2 of 2', 'pass']);
  await h.handlers['classic.SubagentStart'](h.$, { agent_type: 'relay:job', agent_id: 'a-retry', transcript_path: '/synthetic/session.jsonl' }, h.next);
  h.calls.length = 0;
  const step = h.handlers['turn.step'](h.$, { index: 0, agentId: 'a-retry', turnId: 'turn-retry' }, async function* (e) { return await h.next(e); });
  await step.next();
  assert.equal(h.calls.length, 1); assert.equal(h.runs.length, 2); assert.ok(h.runs.every(r => r.argv.includes('--retry') && r.argv.includes('a-retry')));
});
