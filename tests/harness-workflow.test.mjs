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
