import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, parseArgs } from '../scripts/live/suite.mjs';
import { analyzeCheck, BACKENDS, BACKEND_NAMES, MODELS, STEER_DELIVERY, JOBS_HOME_EXPR,
  readTranscript, transcriptCalls, runSpan, hasMarker, claudeCodeVersionOf, leadModelOf,
  formatSeconds, readJob, scopeToRun, promptText, runLine } from '../scripts/live/lib/evidence.mjs';
import { checks, getCheck } from '../scripts/live/checks/index.mjs';
import { commandRuns, moduleText, statusRows, noModelReply } from '../scripts/live/lib/evidence.mjs';
import * as evidenceReaders from '../scripts/live/lib/evidence.mjs';
import { analyzeRun } from '../scripts/live/lib/runs.mjs';
import { setupJobs, requireCommand, requireBuild } from '../scripts/live/checks/commands.mjs';
import { headlessCommands, runHeadless, executeHeadless } from '../scripts/live/checks/headless.mjs';
import { workflowScript } from '../scripts/live/checks/steer-workflow.mjs';
import { agentCalls, waitLoop } from '../scripts/live/checks/steer-main.mjs';
import { badPrompts, goodPrompt, workflowScript as spawnScript, checkHeader, expectedMessage } from '../scripts/live/checks/spawn-check.mjs';
import { copyEvidence } from '../scripts/live/lib/runs.mjs';
import { postInboxMessage, claimInboxMessages, recordReceipt, writeOutcome } from '../plugins/relay/scripts/lib/jobs/messages.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/live-suite');
const first = 'jobs/repo/codex-job/inbox/relay/one.json';
const ledger = 'jobs/repo/job-one/inbox/relay/send-entry.json';
const outcome = 'jobs/repo/job-one/inbox/outcomes/message-one.json';
const jobFile = 'jobs/repo/job-one/job.json';
const workflowFile = 'transcript/subagents/workflows/wf-synthetic/agent-sender.jsonl';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
}
function edit(dir, file, change) {
  const target = path.join(dir, file), value = read(target);
  change(value);
  write(target, value);
}
function temp(t) {
  const dir = fs.mkdtempSync('/tmp/relay-live-checks-test-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function copy(t, name = 'steer-main') {
  const dir = temp(t);
  fs.cpSync(path.join(fixture, name), dir, { recursive: true });
  return dir;
}
function input(dir, backends = ['codex'], relayVersion = '3.0.0-test') {
  return { runId: 'synthetic-run', surface: 'terminal', backends, relayVersion,
    transcript: path.join(dir, 'transcript.jsonl'), jobsHome: path.join(dir, 'jobs') };
}
function legacy(dir = path.join(fixture, 'steer-main')) {
  return analyzeCheck(input(dir, ['codex', 'grok'], '2.2.0-test'), {
    messages: backend => backend === 'codex' ? ['steer 1 for codex', 'steer 2 for codex'] : ['steer 1 for grok']
  });
}
function lines(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}
function textEntry(type, text, timestamp, extra = {}) {
  return { type, timestamp, message: { content: [{ type: 'text', text }] }, ...extra };
}
function callEntry(id, name, data, timestamp) {
  return { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name, input: data }] } };
}
function mainFixture(t, backends = BACKENDS) {
  const dir = temp(t), entries = [textEntry('user', 'Live suite run synthetic-run.', '2026-10-22T09:59:59.000Z')];
  for (const backend of backends) {
    entries.push(callEntry(`spawn-${backend}`, 'Agent', { subagent_type: 'relay:job', name: `steer-${backend}`,
      prompt: `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\nSynthetic brief.` }, '2026-10-22T10:00:00.000Z'));
    entries.push({ type: 'user', toolUseResult: { agentId: `agent-${backend}` }, message: { content: [
      { type: 'tool_result', tool_use_id: `spawn-${backend}`, content: `agentId: agent-${backend}` }
    ] } });
    write(path.join(dir, `jobs/relays/agent-${backend}.json`), { agentId: `agent-${backend}`, jobDir: `repo/${backend}-job`,
      transcriptPath: `repo/${backend}-job/relay-transcript.jsonl` });
    write(path.join(dir, `jobs/repo/${backend}-job/job.json`), { request: { backend, model: MODELS[backend] },
      attempts: [{ attempt: 1, startedAt: '2026-10-22T10:00:01.000Z', endedAt: '2026-10-22T10:04:00.000Z',
        turnId: 'first-turn', relayVersion: '3.0.0-test' }, ...(backend === 'kimi' ? [2, 3, 4].map(attempt => ({
        attempt, startedAt: `2026-10-22T10:04:0${attempt - 2}.000Z`, relayVersion: '3.0.0-test'
      })) : [])], messages: backend === 'kimi' ? [1, 2, 3].map(round => ({ id: `message-${round}`, action: 'queued-next-turn' })) : [] });
    lines(path.join(dir, `jobs/repo/${backend}-job/relay-transcript.jsonl`), [1, 2, 3].map(round => ({
      type: 'attachment', uuid: String(round), attachment: { type: 'queued_command', prompt: `steer ${round} for ${backend}`, origin: { kind: 'coordinator' } }
    })));
  }
  for (const [round, sent, delivered] of [[1, '00:30', '00:32'], [2, '01:00', '01:03'], [3, '01:30', '01:34']]) {
    for (const backend of backends) {
      const message = `steer ${round} for ${backend}`, messageId = `message-${round}`;
      entries.push(callEntry(`send-${backend}-${round}`, 'SendMessage', { to: `steer-${backend}`, message }, `2026-10-22T10:${sent}.000Z`));
      write(path.join(dir, `jobs/repo/${backend}-job/inbox/relay/${round}.json`), {
        kind: 'steer', status: 'done', at: `2026-10-22T10:${delivered}.000Z`, postedAt: `2026-10-22T10:${delivered}.000Z`, messageId, text: message,
        outcome: backend === 'grok' ? 'interject-queued' : 'queued-next-turn'
      });
      write(path.join(dir, `jobs/repo/${backend}-job/inbox/outcomes/${messageId}.json`), {
        messageId, action: backend === 'kimi' ? 'turn-started' : 'steered', attempt: backend === 'kimi' ? round + 1 : 1,
        at: '2026-10-22T10:04:00.000Z'
      });
    }
  }
  lines(path.join(dir, 'transcript.jsonl'), entries);
  return dir;
}

test('constants use the contract order, names, models and deliveries', () => {
  assert.deepEqual(BACKENDS, ['codex', 'grok', 'zcode', 'kimi']);
  assert.deepEqual(BACKEND_NAMES, { codex: 'Codex', grok: 'Grok Build', zcode: 'ZCode', kimi: 'Kimi Code' });
  assert.deepEqual(MODELS, { codex: 'gpt-6.1-sol', grok: 'grok-4.7', zcode: 'glm-5.3-flash', kimi: 'kimi-code/kimi-for-coding' });
  assert.deepEqual(STEER_DELIVERY, { codex: 'in-turn', grok: 'in-turn', zcode: 'in-turn', kimi: 'next-turn' });
  assert.equal(JOBS_HOME_EXPR, '${RELAY_JOBS_HOME:-$HOME/.relay-jobs}');
});

test('old analyzer cases resolve names and ids, current and legacy sends, and use arrival time', () => {
  const analyzed = legacy();
  assert.deepEqual(analyzed.details.map(row => row.deliveredSeconds), [2, 10, 31]);
  assert.deepEqual(analyzed.details.map(row => row.pass), [true, true, false]);
  assert.deepEqual(analyzed.details.map(row => row.matchedBy), ['text', 'text', 'text']);
  assert.deepEqual(analyzed.results.map(row => row.result), ['fail', 'pass']);
  assert.deepEqual(analyzed.results[0].timings, { deliveredSeconds: [2, 31], readSeconds: [2, 31] });
  assert.equal(analyzed.results[0].relayVersion, '2.2.0-test');
  assert.equal(analyzed.results[0].model, 'gpt-6.1-sol');
  assert.match(analyzed.results[0].reason, /steer 2 for codex.*exceeded 30/);
});

test('duplicate progress snapshots do not add sends or lose timestamps', t => {
  const dir = copy(t), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  const snapshot = structuredClone(entries[5]);
  snapshot.type = 'api-request-blob';
  delete snapshot.timestamp;
  const repeated = [snapshot, ...entries, snapshot];
  assert.equal(transcriptCalls(repeated).sends.length, 3);
  assert.equal(transcriptCalls(repeated).sends[0].sentAt, entries[5].timestamp);
  lines(file, repeated);
  assert.deepEqual(legacy(dir).details.map(row => row.deliveredSeconds), [2, 10, 31]);
});

test('relay entry text matching ignores ledger order and a record is never reused', t => {
  const dir = copy(t);
  edit(dir, first, row => { row.postedAt = row.at = '2026-10-22T10:01:02.000Z'; });
  edit(dir, 'jobs/repo/codex-job/inbox/relay/three.json', row => { row.text = 'steer 2 for codex'; row.postedAt = row.at = '2026-10-22T10:00:33.000Z'; });
  const rows = legacy(dir).details;
  assert.equal(rows[0].deliveredSeconds, 32);
  assert.equal(rows[2].deliveredSeconds, -27);
  assert.match(rows[2].error, /predates/);
  assert.notEqual(rows[0].deliveryRecord, rows[2].deliveryRecord);
  fs.rmSync(path.join(dir, 'jobs/repo/codex-job/inbox/relay/three.json'));
  assert.match(legacy(dir).details[2].error, /No matching delivery/);
});

test('known inbox text mismatches cannot pass by order', t => {
  const dir = copy(t);
  edit(dir, 'jobs/repo/codex-job/inbox/claimed/message-one.json', row => { row.text = 'unrelated'; });
  edit(dir, 'jobs/repo/codex-job/inbox/relay/three.json', row => { row.text = 'also unrelated'; });
  assert.equal(legacy(dir).details[0].pass, false);
  assert.match(legacy(dir).details[0].error, /No matching/);
});

test('pending inbox files supply text before they are claimed', t => {
  const dir = copy(t);
  fs.renameSync(path.join(dir, 'jobs/repo/codex-job/inbox/claimed/message-one.json'), path.join(dir, 'jobs/repo/codex-job/inbox/message-one.json'));
  assert.equal(legacy(dir).details[0].matchedBy, 'text');
  assert.equal(legacy(dir).details[0].pass, true);
});

test('missing pointers, ledgers and sends fail with one result per requested backend', t => {
  const dir = copy(t);
  fs.rmSync(path.join(dir, 'jobs/relays/agent-codex.json'));
  fs.rmSync(path.join(dir, 'jobs/repo/grok-job/inbox/relay/two.json'));
  const analyzed = legacy(dir);
  assert.deepEqual(analyzed.details.map(row => row.pass), [false, false, false]);
  assert.match(analyzed.details[0].error, /No relay pointer/);
  assert.match(analyzed.details[1].error, /No matching/);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '');
  assert.deepEqual(legacy(dir).results.map(row => row.result), ['fail', 'fail']);
});

for (const [label, change, error] of [
  ['bad time', row => { row.at = 'invalid'; }, /timestamp/],
  ['missing time', row => { delete row.at; }, /timestamp/],
  ['failed status', row => { row.status = 'failed'; }, /status/],
  ['continue instead of steer', row => { row.kind = 'continue'; }, /Expected steer/]
]) {
  test(`old analyzer rejects ${label}`, t => {
    const dir = copy(t);
    edit(dir, first, change);
    const row = legacy(dir).details[0];
    assert.equal(row.pass, false);
    assert.match(row.error, error);
  });
}

test('the version comes from the attempt active at the send, not a later attempt', t => {
  const dir = mainFixture(t, ['codex']);
  edit(dir, 'jobs/repo/codex-job/job.json', job => {
    job.attempts.push({ attempt: 2, startedAt: '2026-10-22T11:00:00.000Z', relayVersion: 'future-version' });
  });
  const analyzed = getCheck('steer-main').analyze(input(dir));
  assert.equal(analyzed.results[0].relayVersion, '3.0.0-test');
  assert.equal(analyzed.results[0].result, 'pass');
});

for (const name of ['steer-main', 'steer-workflow', 'steer-plugin', 'continue']) {
  test(`${name} rejects malformed transcript JSON with its line number`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, name === 'steer-workflow' ? workflowFile : 'transcript.jsonl');
    fs.writeFileSync(file, '{}\n\n{bad}\n');
    assert.throws(() => getCheck(name).analyze(input(dir)), { message: `Invalid JSON at ${file}:3` });
  });
}

test('main steer requires every round and the exact backend delivery', t => {
  const dir = mainFixture(t), analyzed = getCheck('steer-main').analyze(input(dir, BACKENDS));
  assert.deepEqual(analyzed.results.map(row => row.backend), BACKENDS);
  assert.deepEqual(analyzed.results.map(row => row.result), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(analyzed.results.map(row => row.delivery), ['in-turn', 'in-turn', 'in-turn', 'next-turn']);
  assert.deepEqual(analyzed.results.map(row => row.timings), BACKENDS.map(() => ({ deliveredSeconds: [2, 3, 4], readSeconds: [2, 3, 4] })));
  assert.equal(analyzed.details.length, 12);
  assert.equal(analyzed.evidence.agents.length, 4);
  assert.equal(analyzed.details.find(row => row.backend === 'grok').outcome.action, 'steered');
});

for (const backend of BACKENDS) {
  test(`${backend} fails the wrong delivery and names the send`, t => {
    const dir = mainFixture(t, [backend]);
    edit(dir, `jobs/repo/${backend}-job/inbox/outcomes/message-1.json`, row => { row.action = backend === 'kimi' ? 'steered' : 'turn-started'; });
    const row = getCheck('steer-main').analyze(input(dir, [backend])).results[0];
    assert.equal(row.result, 'fail');
    assert.equal(row.delivery, null);
    assert.match(row.reason, new RegExp(`steer 1 for ${backend}.*Expected ${STEER_DELIVERY[backend]}`));
  });
}

for (const action of [null, 'queued-next-turn', 'interject-queued', 'failed']) {
  test(`missing or unaccepted outcome ${action} cannot pass on ledger status alone`, t => {
    const dir = mainFixture(t, ['grok']);
    const file = 'jobs/repo/grok-job/inbox/outcomes/message-1.json';
    if (action === null) fs.rmSync(path.join(dir, file));
    else edit(dir, file, row => { row.action = action; });
    const row = getCheck('steer-main').analyze(input(dir, ['grok'])).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /steer 1 for grok/);
    assert.deepEqual(row.timings.deliveredSeconds, [2, 3, 4]);
  });
}

for (const failure of ['missing round', 'repeated round', 'backend without relay']) {
  test(`coverage rejects ${failure}`, t => {
    const dir = mainFixture(t, ['codex']);
    const file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
    if (failure === 'missing round') entries.pop();
    if (failure === 'repeated round') {
      const duplicate = structuredClone(entries.at(-1));
      duplicate.message.content[0].id = 'extra-send';
      entries.push(duplicate);
    }
    lines(file, entries);
    const rows = getCheck('steer-main').analyze(input(dir, failure === 'backend without relay' ? ['codex', 'kimi'] : ['codex'])).results;
    const row = rows.at(-1);
    assert.equal(row.result, 'fail');
    assert.match(row.reason, failure === 'backend without relay' ? /exactly one relay for kimi, found 0/ : /expected exactly one send, found [02]/);
    if (failure === 'backend without relay') {
      assert.equal(rows[0].result, 'pass');
      assert.equal(row.backend, 'kimi');
      assert.equal(row.model, MODELS.kimi);
      assert.equal(row.relayVersion, '3.0.0-test');
      assert.deepEqual(row.timings, {});
    }
  });
}

for (const [label, change, error] of [
  ['version mismatch', job => { job.attempts[0].relayVersion = 'other-build'; }, /relayVersion other-build/],
  ['missing version', job => { delete job.attempts[0].relayVersion; }, /relayVersion missing/],
  ['model mismatch', job => { job.request.model = 'other-model'; }, /model other-model/],
  ['backend mismatch', job => { job.request.backend = 'kimi'; }, /backend does not match/]
]) {
  test(`checks reject ${label}`, t => {
    const dir = copy(t, 'steer-plugin');
    edit(dir, jobFile, change);
    const row = getCheck('steer-plugin').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, error);
    assert.match(row.reason, /steer from a plugin for codex/);
    if (label === 'version mismatch') assert.equal(row.relayVersion, 'other-build');
    if (label === 'model mismatch') assert.equal(row.model, 'other-model');
  });
}

for (const file of ['jobs/relays/relay-one.json', jobFile, ledger, outcome, 'jobs/repo/job-one/relay.json']) {
  test(`malformed ${file} is a failed result`, t => {
    const dir = copy(t, 'steer-plugin');
    fs.writeFileSync(path.join(dir, file), '{bad}');
    const row = getCheck('steer-plugin').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /Cannot read/);
  });
}

test('job reader merges relay.json over the binding in job.json', t => {
  const dir = copy(t, 'steer-plugin'), jobDir = path.join(dir, 'jobs/repo/job-one');
  write(path.join(jobDir, 'relay.json'), { agentId: 'replacement', phase: 'joined' });
  assert.deepEqual(readJob(jobDir).relay, { agentId: 'replacement', label: 'steer-codex', phase: 'joined' });
});

test('missing main transcript is failed evidence', t => {
  const dir = temp(t), analyzed = getCheck('steer-main').analyze(input(dir));
  assert.equal(analyzed.results.length, 1);
  assert.equal(analyzed.results[0].result, 'fail');
  assert.deepEqual(analyzed.details, []);
});

for (const name of ['steer-workflow', 'steer-plugin', 'continue']) {
  test(`${name} reads its send shape, measures arrival and gathers evidence`, () => {
    const dir = path.join(fixture, name), analyzed = getCheck(name).analyze(input(dir));
    assert.deepEqual(analyzed.results, [{ backend: 'codex', model: MODELS.codex, relayVersion: '3.0.0-test',
      delivery: name === 'continue' ? 'new-turn' : 'in-turn',
      timings: name === 'continue' ? { deliveredSeconds: [2], readSeconds: [2], completedSeconds: [5] } : { deliveredSeconds: [2], readSeconds: [2] },
      result: 'pass', reason: null }]);
    assert.equal(analyzed.details.length, 1);
    assert.equal(analyzed.details[0].toolUseId, 'send-one');
    assert.equal(analyzed.evidence.agents[0].agentId, 'relay-one');
    assert.equal(analyzed.evidence.agents[0].jobDir, path.join(dir, 'jobs/repo/job-one'));
    assert.ok(analyzed.evidence.transcripts.includes(path.join(dir, 'transcript.jsonl')));
    assert.ok(analyzed.evidence.transcripts.includes(path.join(dir, 'jobs/repo/job-one/relay-transcript.jsonl')));
    if (name === 'steer-workflow') assert.ok(analyzed.evidence.transcripts.includes(path.join(dir, workflowFile)));
  });
}

test('Workflow sends come only from its sidechain agents and deduplicate snapshots', t => {
  const dir = copy(t, 'steer-workflow'), file = path.join(dir, workflowFile), entries = readTranscript(file);
  const snapshot = structuredClone(entries[0]);
  delete snapshot.timestamp;
  lines(file, [snapshot, ...entries, snapshot]);
  const main = readTranscript(path.join(dir, 'transcript.jsonl'));
  main.push({ ...entries[0], isSidechain: false });
  lines(path.join(dir, 'transcript.jsonl'), main);
  const analyzed = getCheck('steer-workflow').analyze(input(dir));
  assert.equal(analyzed.details.length, 1);
  assert.equal(analyzed.results[0].result, 'pass');
  lines(file, [{ ...entries[0], isSidechain: false }]);
  const failed = getCheck('steer-workflow').analyze(input(dir));
  assert.equal(failed.results[0].result, 'fail');
  assert.match(failed.results[0].reason, /found 0/);
});

test('plugin check reads only main-thread probe calls with input.text', t => {
  const dir = copy(t, 'steer-plugin'), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  entries.push({ ...structuredClone(entries.at(-1)), isSidechain: true });
  entries.push(callEntry('other-send', 'SendMessage', { to: 'steer-codex', message: 'steer from a plugin for codex' }, '2026-10-22T10:00:30.000Z'));
  lines(file, entries);
  assert.equal(getCheck('steer-plugin').analyze(input(dir)).details.length, 1);
  entries[3].message.content[0].input = { to: 'steer-codex', message: 'steer from a plugin for codex' };
  lines(file, entries);
  assert.equal(getCheck('steer-plugin').analyze(input(dir)).results[0].result, 'fail');
});

for (const [label, file, change, error] of [
  ['kind', ledger, row => { row.kind = 'steer'; }, /Expected continue/],
  ['status', ledger, row => { row.status = 'failed'; }, /status is failed/],
  ['missing delivery time', ledger, row => { delete row.at; }, /timestamp/],
  ['invalid delivery time', ledger, row => { row.at = 'bad'; }, /timestamp/],
  ['delivery before send', ledger, row => { row.at = '2026-10-22T10:00:29.000Z'; }, /predates/],
  ['late delivery', ledger, row => { row.postedAt = '2026-10-22T10:01:30.001Z'; }, /exceeded 60/],
  ['outcome', outcome, row => { row.action = 'steered'; }, /Expected turn-started/],
  ['missing outcome attempt', outcome, row => { delete row.attempt; }, /attempt did not end completed/],
  ['unknown outcome attempt', outcome, row => { row.attempt = 99; }, /attempt did not end completed/],
  ['failed attempt', jobFile, job => { job.attempts[1].state = 'failed'; }, /attempt did not end completed/],
  ['running attempt', jobFile, job => { job.attempts[1].state = 'running'; }, /attempt did not end completed/],
  ['missing completion time', jobFile, job => { delete job.attempts[1].endedAt; }, /completion timestamp/],
  ['invalid completion time', jobFile, job => { job.attempts[1].endedAt = 'bad'; }, /completion timestamp/],
  ['completion before delivery', jobFile, job => { job.attempts[1].endedAt = '2026-10-22T10:00:31.000Z'; }, /completion timestamp/]
]) {
  test(`continue rejects ${label}`, t => {
    const dir = copy(t, 'continue');
    edit(dir, file, change);
    const row = getCheck('continue').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, error);
    assert.match(row.reason, /continue for codex/);
  });
}

for (const report of [null, 'prefix second turn for codex', 'second turn for codex suffix', 'first turn for codex']) {
  test(`continue requires the report line itself: ${report}`, t => {
    const dir = copy(t, 'continue'), file = path.join(dir, 'jobs/repo/job-one/report.md');
    if (report === null) fs.rmSync(file);
    else fs.writeFileSync(file, report + '\n');
    const row = getCheck('continue').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.deepEqual(row.timings, { deliveredSeconds: [2], readSeconds: [2], completedSeconds: [5] });
    assert.match(row.reason, /report|Report/);
  });
}

for (const report of ['Second turn for codex.', 'second turn for codex!', '  second turn for codex  ']) {
  test(`continue takes the report line in the model's own case and closing stop: ${report}`, t => {
    const dir = copy(t, 'continue');
    fs.writeFileSync(path.join(dir, 'jobs/repo/job-one/report.md'), report + '\n');
    assert.equal(getCheck('continue').analyze(input(dir)).results[0].result, 'pass');
  });
}

test('continue accepts the inclusive 60 second delivery limit and measures the named attempt', t => {
  const dir = copy(t, 'continue');
  edit(dir, ledger, row => { row.postedAt = '2026-10-22T10:01:30.000Z'; });
  edit(dir, jobFile, job => {
    job.attempts[1].endedAt = '2026-10-22T10:01:40.000Z';
    fs.mkdirSync(path.join(dir, 'jobs/repo/job-one/attempts'), { recursive: true });
    fs.copyFileSync(path.join(dir, 'jobs/repo/job-one/report.md'), path.join(dir, 'jobs/repo/job-one/attempts/2-report.md'));
    job.attempts.push({ attempt: 3, startedAt: '2026-10-22T11:00:00.000Z', endedAt: 'bad', state: 'failed', relayVersion: 'future' });
  });
  const row = getCheck('continue').analyze(input(dir)).results[0];
  assert.equal(row.result, 'pass');
  assert.deepEqual(row.timings, { deliveredSeconds: [60], readSeconds: [2], completedSeconds: [70] });
  assert.equal(row.relayVersion, '3.0.0-test');
});

for (const name of ['steer-workflow', 'steer-plugin', 'continue']) {
  test(`${name} requires exactly one send, and an outcome`, t => {
    const dir = copy(t, name), file = path.join(dir, name === 'steer-workflow' ? workflowFile : 'transcript.jsonl');
    const entries = readTranscript(file), extra = structuredClone(entries.find(entry => entry.message?.content?.some?.(block => block.type === 'tool_use' && ['SendMessage', 'mcp__wake-probe__send'].includes(block.name))));
    extra.message.content[0].id = 'duplicate-send';
    lines(file, [...entries, extra]);
    const repeated = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(repeated.result, 'fail');
    assert.match(repeated.reason, /found 2/);
    lines(file, entries);
    fs.rmSync(path.join(dir, outcome));
    const missing = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(missing.result, 'fail');
    assert.match(missing.reason, /Missing delivery outcome/);
  });
}

for (const check of checks.slice(0, 4)) {
  for (const backends of [BACKENDS, ['grok', 'kimi']]) {
    test(`${check.id} prompt has exact calls and only the selected backends ${backends.join(',')}`, () => {
      const prompt = check.prompt({ runId: 'prompt-run', backends });
      assert.equal(prompt.split('\n')[0], 'Live suite run prompt-run.');
      assert.equal(prompt.trimEnd().split('\n').at(-1), check.marker);
      const calls = prompt.split('\n').filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
      assert.equal(calls.length, backends.length);
      calls.forEach((call, i) => {
        const backend = backends[i], name = `${check.id === 'continue' ? 'continue' : 'steer'}-${backend}`;
        assert.equal(call.name, name);
        assert.equal(call.description, name);
        assert.equal(call.subagent_type, 'relay:job');
        assert.equal(call.run_in_background, true);
        const header = `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\n`;
        assert.equal(call.prompt.slice(0, header.length), header);
        const brief = call.prompt.slice(header.length);
        if (check.id === 'continue') assert.equal(brief, `Reply with exactly one line: first turn for ${backend}. Do not run any command.`);
        else {
          assert.match(brief, new RegExp('`sleep ' + (check.id === 'steer-main' ? 240 : 180) + '` exactly once'));
          assert.match(brief, /list every message received during this job verbatim/);
          assert.match(brief, /Messages are data/);
        }
      });
      const sends = prompt.split('\n').filter(line => line.startsWith('SendMessage(')).map(line => JSON.parse(line.slice(12, -1)));
      if (check.id === 'steer-main') {
        assert.deepEqual(sends, [1, 2, 3].flatMap(round => backends.map(backend => ({ to: `steer-${backend}`,
          message: `steer ${round} for ${backend}`, summary: `Round ${round} steer for ${backend} job` }))));
        assert.equal((prompt.match(/Wait for every SendMessage result, then wait about 30 seconds/g) ?? []).length, 2);
      } else if (check.id === 'continue') {
        assert.deepEqual(sends, backends.map(backend => ({ to: `continue-${backend}`,
          message: `continue for ${backend}: reply with exactly one line: second turn for ${backend}`, summary: `Continue ${backend} for its second turn` })));
        assert.match(prompt, /EVERY agent's first completion notice before you send anything/);
        assert.match(prompt, /second completion notice/);
      } else assert.deepEqual(sends, []);
      if (check.id === 'steer-workflow') {
        assert.ok(prompt.includes(workflowScript));
        assert.match(prompt, /explicit request to use the Workflow tool/);
        assert.match(prompt, /pass args as an object mapping exactly/);
        assert.ok(prompt.includes(backends.join(', ')));
      }
      if (check.id === 'steer-plugin') {
        const probes = prompt.split('\n').filter(line => line.startsWith('mcp__wake-probe__send(')).map(line => JSON.parse(line.slice('mcp__wake-probe__send('.length, -1)));
        assert.deepEqual(probes, backends.map(backend => ({ to: `steer-${backend}`, text: `steer from a plugin for ${backend}` })));
      }
      assert.match(prompt, /Use the tools yourself/);
      assert.match(prompt, /Do not write a script/);
      assert.match(prompt, /Do not read the agents' output transcripts/);
      assert.match(prompt, /Do not stop, cancel, continue or respawn/);
      // Every wait is a foreground Bash until-loop: a Monitor does not hold a T3 thread's turn.
      assert.match(prompt, /Keep your turn until the end of the check; never end it to wait/);
      assert.match(prompt, /until \[ \$\(date \+%s\) -ge \$t \]; do sleep 1; done/);
      assert.doesNotMatch(prompt, /Monitor/);
      assert.doesNotMatch(prompt, /^\s*sleep \d|"command"\s*:\s*"sleep/m);
      if (check.id !== 'continue') {
        assert.ok(prompt.includes(`${JOBS_HOME_EXPR}/relays/<agentId>.json`));
        assert.match(prompt, /state "running" and an attempt/);
      }
      for (const backend of BACKENDS.filter(value => !backends.includes(value))) {
        assert.ok(!prompt.includes(`steer-${backend}`));
        assert.ok(!prompt.includes(`continue-${backend}`));
        assert.ok(!prompt.includes(MODELS[backend]));
        assert.ok(!prompt.includes(`for ${backend}`));
      }
    });
  }
}

test('Workflow script equals the contract verbatim', () => {
  assert.equal(workflowScript, "export const meta = { name: 'live-steer-workflow', description: 'Workflow agents steer running relays by agent id' }\n" +
    'return await parallel(Object.entries(args).map(([backend, id]) => () => agent(`Use the SendMessage tool exactly once: send the message "steer from a workflow agent for ${backend}" to the agent whose id is ${id} (to: "${id}"). Reply with the SendMessage tool result only.`, { label: `steer-${backend}` })))');
});

test('transcript metadata ignores sidechain entries', () => {
  const entries = [{ isSidechain: true, version: 'wrong', type: 'assistant', message: { model: 'wrong' } },
    { type: 'user', version: '2.1.308' }, { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
    { version: 'later', type: 'assistant', message: { model: 'later-model' } }];
  assert.equal(claudeCodeVersionOf(entries), '2.1.308');
  assert.equal(leadModelOf(entries), 'claude-sonnet-5-5');
  assert.equal(claudeCodeVersionOf([]), null);
  assert.equal(leadModelOf([]), null);
  assert.equal(leadModelOf([{ type: 'assistant' }, ...entries]), null);
});

test('marker requires an exact assistant line on the main thread', () => {
  const marker = 'DONE';
  assert.equal(hasMarker([textEntry('user', marker)], marker), false);
  assert.equal(hasMarker([textEntry('assistant', marker, null, { isSidechain: true })], marker), false);
  assert.equal(hasMarker([textEntry('assistant', 'prefix DONE')], marker), false);
  assert.equal(hasMarker([textEntry('assistant', 'DONE suffix')], marker), false);
  assert.equal(hasMarker([textEntry('assistant', ' DONE')], marker), false);
  assert.equal(hasMarker([textEntry('assistant', 'text\nDONE  \t\n')], marker), true);
});

test('run span starts at the run user line and ends at the first later assistant marker', () => {
  const entries = [textEntry('assistant', 'DONE', 'before'),
    textEntry('user', 'Live suite run run-1.', 'sidechain', { isSidechain: true }),
    textEntry('user', 'prefix Live suite run run-1.', 'wrong'),
    textEntry('user', 'Live suite run run-1.\nDONE', 'start'),
    textEntry('assistant', 'DONE', 'ignored', { isSidechain: true }),
    textEntry('assistant', 'done\nDONE  ', 'finish'), textEntry('assistant', 'DONE', 'last')];
  assert.deepEqual(runSpan(entries, 'run-1', 'DONE'), { startedAt: 'start', finishedAt: 'finish' });
  assert.deepEqual(runSpan(entries.slice(0, 5), 'run-1', 'DONE'), { startedAt: 'start', finishedAt: 'ignored' });
  assert.deepEqual(runSpan(entries, 'absent', 'DONE'), { startedAt: null, finishedAt: 'last' });
  assert.deepEqual(runSpan([], 'absent', 'DONE'), { startedAt: null, finishedAt: null });
  assert.deepEqual(runSpan([textEntry('user', 'Live suite run run-1.')], 'run-1', 'DONE'), { startedAt: null, finishedAt: null });
});

test('readTranscript skips blank lines and keeps parsed entries', t => {
  const dir = temp(t), file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, '\n{}\n  \n{"type":"assistant"}\n');
  assert.deepEqual(readTranscript(file), [{}, { type: 'assistant' }]);
});

test('formatSeconds uses one decimal and an en dash for a range', () => {
  assert.equal(formatSeconds([2.94]), '2.9 s');
  assert.equal(formatSeconds([4, 1.5, 2]), '1.5–4.0 s');
  assert.equal(formatSeconds([2, 2]), '2.0 s');
  assert.equal(formatSeconds([0.11, 0.14]), '0.1 s');
  assert.equal(formatSeconds([]), '—');
});

test('registry keeps the prompt checks\' interface, with the command checks between continue and stop', () => {
  assert.deepEqual(checks.map(check => check.id), ['steer-main', 'steer-workflow', 'steer-plugin', 'continue', 'commands', 'transfer', 'headless', 'stop', 'session-end', 'spawn-check', 'status-line']);
  assert.equal(new Set(checks.map(check => check.id)).size, 11);
  for (const check of checks.filter(check => !['commands', 'transfer', 'headless'].includes(check.id))) {
    assert.match(check.id, /^[a-z0-9-]+$/);
    assert.equal(typeof check.title, 'string');
    assert.ok(check.title.length > 0);
    assert.equal(typeof check.marker, 'string');
    assert.ok(check.marker.length > 0);
    assert.equal(typeof check.prompt, 'function');
    assert.equal(typeof check.analyze, 'function');
    assert.equal(typeof check.cell, 'function');
    assert.ok(Array.isArray(check.surfaces));
    assert.ok(Array.isArray(check.probes));
    assert.equal(check.timeoutMinutes, check.id === 'steer-main' ? 20 : 15);
    assert.deepEqual(check.surfaces, ['steer-plugin', 'session-end', 'status-line'].includes(check.id) ? ['terminal'] : ['terminal', 't3']);
    assert.deepEqual(check.probes, check.id === 'steer-plugin' ? ['wake-probe'] : []);
    assert.equal(getCheck(check.id), check);
    if (check.probes.length) assert.deepEqual(check.surfaces, ['terminal']);
  }
  assert.equal(getCheck('missing'), undefined);
  assert.equal(getCheck('continue').cell({ timings: { deliveredSeconds: [2] } }), 'a new turn of the job, delivered in 2.0 s');
  for (const check of checks.slice(0, 3)) {
    assert.equal(check.cell({ delivery: 'in-turn', timings: { deliveredSeconds: [1.5, 4] } }), 'into the running turn, delivered in 1.5–4.0 s');
    assert.equal(check.cell({ delivery: 'next-turn', timings: { deliveredSeconds: [2] } }), 'as the next turn, delivered in 2.0 s');
  }
});


test('timings stay in round order when transcript calls are stored out of order', t => {
  const dir = mainFixture(t, ['codex']), file = path.join(dir, 'transcript.jsonl');
  const entries = readTranscript(file);
  lines(file, [...entries.slice(0, 3), ...entries.slice(3).reverse()]);
  const row = getCheck('steer-main').analyze(input(dir)).results[0];
  assert.equal(row.result, 'pass');
  assert.deepEqual(row.timings, { deliveredSeconds: [2, 3, 4], readSeconds: [2, 3, 4] });
});

test('a later send from another build fails even when the first send used the right build', t => {
  const dir = mainFixture(t, ['codex']);
  edit(dir, 'jobs/repo/codex-job/job.json', job => {
    job.attempts.unshift({ attempt: 2, startedAt: '2026-10-22T10:00:45.000Z', relayVersion: 'other-build' });
  });
  const analyzed = getCheck('steer-main').analyze(input(dir));
  assert.deepEqual(analyzed.details.map(row => row.relayVersion), ['3.0.0-test', 'other-build', 'other-build']);
  assert.equal(analyzed.results[0].result, 'fail');
  assert.match(analyzed.results[0].reason, /steer 2 for codex.*other-build/);
});

test('failed evidence reasons contain no absolute paths', t => {
  const dir = copy(t, 'steer-plugin');
  fs.writeFileSync(path.join(dir, jobFile), '{bad}');
  const row = getCheck('steer-plugin').analyze(input(dir)).results[0];
  assert.equal(row.result, 'fail');
  assert.match(row.reason, /Cannot read job.json/);
  assert.ok(!row.reason.includes(dir));
  const missing = getCheck('steer-plugin').analyze({ ...input(dir), transcript: path.join(dir, 'missing.jsonl') }).results[0];
  assert.equal(missing.result, 'fail');
  assert.ok(!missing.reason.includes(dir));
});

test('missing send timestamps fail rather than using a progress snapshot time', t => {
  const dir = copy(t, 'steer-plugin'), file = path.join(dir, 'transcript.jsonl');
  const entries = readTranscript(file);
  delete entries[3].timestamp;
  lines(file, entries);
  const analyzed = getCheck('steer-plugin').analyze(input(dir));
  assert.equal(analyzed.results[0].result, 'fail');
  assert.match(analyzed.results[0].reason, /timestamp/);
  assert.deepEqual(analyzed.results[0].timings, {});
});

test('continue cannot match a missing outcome attempt to an unnamed attempt', t => {
  const dir = copy(t, 'continue');
  edit(dir, outcome, row => { delete row.attempt; });
  edit(dir, jobFile, job => { delete job.attempts[1].attempt; });
  const row = getCheck('continue').analyze(input(dir)).results[0];
  assert.equal(row.result, 'fail');
  assert.match(row.reason, /attempt did not end completed/);
});

test('a known job model remains in a result even when its send is missing', t => {
  const dir = copy(t, 'steer-plugin');
  edit(dir, jobFile, job => { job.request.model = 'observed-model'; });
  const file = path.join(dir, 'transcript.jsonl');
  lines(file, readTranscript(file).slice(0, 3));
  const row = getCheck('steer-plugin').analyze(input(dir)).results[0];
  assert.equal(row.result, 'fail');
  assert.equal(row.model, 'observed-model');
  assert.deepEqual(row.timings, {});
});

for (const name of ['steer-main', 'steer-workflow', 'steer-plugin', 'continue']) {
  test(`${name} rejects a job model or build different from the run`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = name === 'steer-main' ? 'jobs/repo/codex-job/job.json' : jobFile;
    edit(dir, file, job => { job.request.model = 'wrong-model'; });
    const wrongModel = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(wrongModel.result, 'fail');
    assert.equal(wrongModel.model, 'wrong-model');
    assert.match(wrongModel.reason, /model wrong-model/);
    edit(dir, file, job => { job.request.model = MODELS.codex; job.attempts[0].relayVersion = 'wrong-build'; });
    const wrongBuild = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(wrongBuild.result, 'fail');
    assert.equal(wrongBuild.relayVersion, 'wrong-build');
    assert.match(wrongBuild.reason, /relayVersion wrong-build/);
  });
}

test('scopeToRun uses the first line, joins only text blocks and excludes the next run', () => {
  const start = { type: 'user', message: { content: [
    { type: 'image' }, { type: 'text', text: 'Live suite run wanted.' }, { type: 'text', text: 'prompt' }
  ] } };
  const middle = [textEntry('user', 'Live suite run sidechain.', null, { isSidechain: true }),
    textEntry('assistant', 'Live suite run assistant.'), textEntry('user', 'quote\nLive suite run quoted.'),
    textEntry('user', 'Live suite run spaced. '), textEntry('assistant', 'DONE')];
  const before = [textEntry('user', 'quote\nLive suite run wanted.'),
    textEntry('user', 'Live suite run wanted.', null, { isSidechain: true }), textEntry('assistant', 'Live suite run wanted.')];
  const next = { type: 'user', message: { content: 'Live suite run next.\nmore' } };
  const all = [...before, start, ...middle, next, textEntry('assistant', 'DONE')];
  assert.deepEqual(scopeToRun(all, 'wanted'), [start, ...middle]);
  assert.deepEqual(scopeToRun(all, 'absent'), []);
  assert.deepEqual(scopeToRun(before, 'wanted'), []);
  assert.deepEqual(scopeToRun([], 'wanted'), []);
  assert.deepEqual(scopeToRun([start, start], 'wanted'), [start]);
  assert.equal(hasMarker(scopeToRun([textEntry('assistant', 'DONE'), start, next, textEntry('assistant', 'DONE')], 'wanted'), 'DONE'), false);
});

for (const name of ['steer-main', 'steer-workflow', 'steer-plugin', 'continue']) {
  test(`${name} ignores spawns, sends and probe results outside the requested run`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
    const history = structuredClone(entries);
    history[0].message.content = 'Live suite run previous.';
    for (const entry of history) for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.id) block.id = `old-${block.id}`;
      if (block.tool_use_id) block.tool_use_id = `old-${block.tool_use_id}`;
    }
    lines(file, [...history, ...entries, textEntry('user', 'Live suite run later.'), ...history.slice(1)]);
    const analyzed = getCheck(name).analyze(input(dir));
    assert.equal(analyzed.results[0].result, 'pass');
    assert.equal(analyzed.details.length, name === 'steer-main' ? 3 : 1);
    lines(file, [...history, textEntry('user', 'Live suite run synthetic-run.')]);
    assert.equal(getCheck(name).analyze(input(dir)).results[0].result, 'fail');
  });

  test(`${name} rejects a recipient spawned only before this run`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
    lines(file, [entries[1], entries[2], entries[0], ...entries.slice(3)]);
    const analyzed = getCheck(name).analyze(input(dir));
    assert.equal(analyzed.results[0].result, 'fail');
    assert.match(analyzed.results[0].reason, /exactly one relay for codex, found 0/);
    assert.equal(analyzed.details[0].error, `Recipient was not spawned in this run: ${name === 'steer-main' ? 'steer-codex' : name === 'continue' ? 'continue-codex' : name === 'steer-plugin' ? 'steer-codex' : 'relay-one'}.`);
    assert.deepEqual(analyzed.evidence.agents, []);
  });
}

test('Workflow reads only run ids returned by in-scope Workflow calls', t => {
  const dir = copy(t, 'steer-workflow'), main = path.join(dir, 'transcript.jsonl');
  const stale = path.join(dir, 'transcript/subagents/workflows/stale-run/agent-stale.jsonl');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, '{bad}\n');
  const analyzed = getCheck('steer-workflow').analyze(input(dir));
  assert.equal(analyzed.results[0].result, 'pass');
  assert.ok(!analyzed.evidence.transcripts.includes(stale));
  const entries = readTranscript(main);
  const launch = entries.slice(-2);
  lines(main, [...launch, ...entries.slice(0, -2)]);
  const failed = getCheck('steer-workflow').analyze(input(dir));
  assert.equal(failed.results[0].result, 'fail');
  assert.deepEqual(failed.details, []);
});

test('Workflow run id can come from the tool_result Run ID line', t => {
  const dir = copy(t, 'steer-workflow'), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  delete entries.at(-1).toolUseResult;
  lines(file, entries);
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'pass');
  entries.at(-1).message.content[0].is_error = true;
  lines(file, entries);
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'fail');
});

for (const [name, origin] of [
  ['steer-main', { kind: 'coordinator', plugin: 'wake-probe' }],
  ['steer-plugin', { kind: 'coordinator' }],
  ['steer-plugin', { kind: 'coordinator', plugin: 'different' }],
  ['steer-plugin', { kind: 'peer', from: 'sender', plugin: 'wake-probe' }],
  ['steer-workflow', { kind: 'coordinator' }],
  ['steer-workflow', { kind: 'peer', from: 'other-agent' }],
  ['continue', { kind: 'coordinator', plugin: 'wake-probe' }],
  ['continue', { kind: 'peer', from: 'sender' }]
]) {
  test(`${name} rejects relay origin ${JSON.stringify(origin)}`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, name === 'steer-main' ? 'jobs/repo/codex-job/relay-transcript.jsonl' : 'jobs/repo/job-one/relay-transcript.jsonl');
    const entries = readTranscript(file);
    if (name === 'continue') entries[0].origin = origin;
    else entries[0].attachment.origin = origin;
    lines(file, entries);
    const row = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /Relay transcript origin/);
  });
}

for (const name of ['steer-main', 'steer-plugin', 'steer-workflow', 'continue']) {
  for (const failure of ['no transcript', 'no path', 'wrong uuid', 'wrong entry shape']) {
    test(`${name} fails sender attribution with ${failure}`, t => {
      const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
      const relay = name === 'steer-main' ? 'jobs/repo/codex-job/relay-transcript.jsonl' : 'jobs/repo/job-one/relay-transcript.jsonl';
      if (failure === 'no transcript') fs.rmSync(path.join(dir, relay));
      if (failure === 'no path') edit(dir, `jobs/relays/${name === 'steer-main' ? 'agent-codex' : 'relay-one'}.json`, pointer => { delete pointer.transcriptPath; });
      if (['wrong uuid', 'wrong entry shape'].includes(failure)) {
        const entries = readTranscript(path.join(dir, relay));
        if (failure === 'wrong uuid') entries[0].uuid = 'other';
        else entries[0].type = 'assistant';
        lines(path.join(dir, relay), entries);
      }
      const row = getCheck(name).analyze(input(dir)).results[0];
      assert.equal(row.result, 'fail');
      assert.match(row.reason, /relay transcript|Relay transcript/);
    });
  }
}

test('relay binding supplies transcriptPath before the pointer', t => {
  const dir = copy(t, 'steer-plugin');
  edit(dir, jobFile, job => { job.relay.transcriptPath = 'repo/job-one/relay-transcript.jsonl'; });
  edit(dir, 'jobs/relays/relay-one.json', pointer => { pointer.transcriptPath = 'missing.jsonl'; });
  assert.equal(getCheck('steer-plugin').analyze(input(dir)).results[0].result, 'pass');
});

test('copied pointers take precedence over stale original transcript bindings', t => {
  const dir = copy(t, 'steer-plugin'), copied = path.join(dir, 'session/relay.jsonl');
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.copyFileSync(path.join(dir, 'jobs/repo/job-one/relay-transcript.jsonl'), copied);
  fs.renameSync(path.join(dir, 'transcript.jsonl'), path.join(dir, 'session/main.jsonl'));
  edit(dir, jobFile, job => { job.relay.transcriptPath = '/gone/original/session/relay.jsonl'; });
  edit(dir, 'jobs/relays/relay-one.json', pointer => { pointer.transcriptPath = copied; });
  const analyzed = getCheck('steer-plugin').analyze({ ...input(dir), transcript: path.join(dir, 'session/main.jsonl') });
  assert.equal(analyzed.results[0].result, 'pass');
  assert.ok(analyzed.evidence.transcripts.includes(copied));
  assert.ok(analyzed.evidence.transcripts.every(file => file.startsWith(dir + '/')));
});

for (const name of ['steer-plugin', 'steer-workflow']) {
  for (const failure of ['missing', 'is_error', 'negative', 'invalid', 'wrong tool id']) {
    test(`${name} requires its own successful sender result: ${failure}`, t => {
      const dir = copy(t, name), file = path.join(dir, name === 'steer-workflow' ? workflowFile : 'transcript.jsonl');
      const entries = readTranscript(file), block = entries.at(-1).message.content[0];
      if (failure === 'missing') entries.pop();
      if (failure === 'is_error') block.is_error = true;
      if (failure === 'negative') block.content = name === 'steer-plugin' ? 'wake-probe delivered=false' : '{"success":false}';
      if (failure === 'invalid') block.content = name === 'steer-plugin' ? 'notdelivered=trueish' : '{"success":"true"}';
      if (failure === 'wrong tool id') block.tool_use_id = 'unrelated-tool';
      lines(file, entries);
      const row = getCheck(name).analyze(input(dir)).results[0];
      assert.equal(row.result, 'fail');
      assert.match(row.reason, /sender tool result|Probe tool result|Workflow SendMessage tool result/);
    });
  }
}

test('a failed probe followed by a main-thread fallback cannot earn a plugin pass', t => {
  const dir = copy(t, 'steer-plugin'), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  entries.at(-1).message.content[0].content = 'wake-probe delivered=false reason=No agent named steer-codex';
  entries.push(callEntry('fallback', 'SendMessage', { to: 'steer-codex', message: 'steer from a plugin for codex' }, '2026-10-22T10:00:31.000Z'));
  lines(file, entries);
  const row = getCheck('steer-plugin').analyze(input(dir)).results[0];
  assert.equal(row.result, 'fail');
  assert.match(row.reason, /delivered=true/);
});

test('Workflow sender id uses transcript entries, then the agent filename', t => {
  const dir = copy(t, 'steer-workflow'), file = path.join(dir, workflowFile), entries = readTranscript(file);
  entries.forEach(entry => { entry.agentId = 'actual-sender'; });
  lines(file, entries);
  const relay = path.join(dir, 'jobs/repo/job-one/relay-transcript.jsonl'), relayEntries = readTranscript(relay);
  relayEntries[0].attachment.origin.from = 'actual-sender';
  lines(relay, relayEntries);
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'pass');
  entries.forEach(entry => { delete entry.agentId; });
  lines(file, entries);
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'fail');
  relayEntries[0].attachment.origin.from = 'sender';
  lines(relay, relayEntries);
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'pass');
});

for (const endedAt of ['2026-10-22T10:00:30.000Z', '2026-10-22T10:00:29.999Z', 'invalid']) {
  test(`steer must hit an attempt running at send time: endedAt ${endedAt}`, t => {
    const dir = mainFixture(t, ['codex']);
    edit(dir, 'jobs/repo/codex-job/job.json', job => { job.attempts[0].endedAt = endedAt; });
    const row = getCheck('steer-main').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /not running/);
  });
}

test('a running steer attempt needs no endedAt, and may start exactly at the send', t => {
  const dir = mainFixture(t, ['codex']);
  edit(dir, 'jobs/repo/codex-job/job.json', job => {
    job.attempts[0].startedAt = '2026-10-22T10:00:30.000Z';
    delete job.attempts[0].endedAt;
  });
  assert.equal(getCheck('steer-main').analyze(input(dir)).results[0].result, 'pass');
});

for (const [label, change, error] of [
  ['turn identity', row => { row.turnId = 'other-turn'; }, /turnId does not match/],
  ['attempt identity', row => { row.attempt = 99; }, /outcome attempt does not match/],
  ['message identity', row => { row.messageId = 'other-message'; }, /messageId does not match/]
]) {
  test(`in-turn outcome verifies ${label}`, t => {
    const dir = mainFixture(t, ['codex']);
    edit(dir, 'jobs/repo/codex-job/inbox/outcomes/message-1.json', change);
    const row = getCheck('steer-main').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, error);
  });
}

test('in-turn turn ids agree when both present, and a missing optional id is accepted', t => {
  const dir = mainFixture(t, ['codex']);
  edit(dir, 'jobs/repo/codex-job/inbox/outcomes/message-1.json', row => { row.turnId = 'first-turn'; });
  assert.equal(getCheck('steer-main').analyze(input(dir)).results[0].result, 'pass');
  edit(dir, 'jobs/repo/codex-job/job.json', job => { delete job.attempts[0].turnId; });
  assert.equal(getCheck('steer-main').analyze(input(dir)).results[0].result, 'pass');
});

for (const [label, change, error] of [
  ['earlier start', job => { job.attempts[1].startedAt = '2026-10-22T10:03:59.999Z'; }, /before the active attempt ended/],
  ['missing active end', job => { delete job.attempts[0].endedAt; }, /before the active attempt ended/],
  ['missing target start', job => { delete job.attempts[1].startedAt; }, /before the active attempt ended/],
  ['target build', job => { job.attempts[1].relayVersion = 'wrong-build'; }, /Outcome attempt relayVersion wrong-build/],
  ['missing target build', job => { delete job.attempts[1].relayVersion; }, /Outcome attempt relayVersion missing/],
  ['missing queue', job => { delete job.messages; }, /No queued-next-turn/],
  ['wrong queue id', job => { job.messages[0].id = 'unrelated'; }, /No queued-next-turn/],
  ['wrong queue action', job => { job.messages[0].action = 'accepted-next-turn'; }, /No queued-next-turn/]
]) {
  test(`next-turn requires job evidence: ${label}`, t => {
    const dir = mainFixture(t, ['kimi']);
    edit(dir, 'jobs/repo/kimi-job/job.json', change);
    const row = getCheck('steer-main').analyze(input(dir, ['kimi'])).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, error);
  });
}

for (const attempt of [1, 99, null]) {
  test(`next-turn must name a later known attempt: ${attempt}`, t => {
    const dir = mainFixture(t, ['kimi']);
    edit(dir, 'jobs/repo/kimi-job/inbox/outcomes/message-1.json', row => { row.attempt = attempt; });
    const row = getCheck('steer-main').analyze(input(dir, ['kimi'])).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /does not name a later attempt/);
  });
}

for (const [label, change, error] of [
  ['preceding running state', job => { job.attempts[0].state = 'running'; }, /before the send had not ended completed/],
  ['preceding missing end', job => { delete job.attempts[0].endedAt; }, /before the send had not ended completed/],
  ['preceding late end', job => { job.attempts[0].endedAt = '2026-10-22T10:00:30.001Z'; }, /before the send had not ended completed/],
  ['outcome build', job => { job.attempts[1].relayVersion = 'wrong-build'; }, /Outcome attempt relayVersion wrong-build/],
  ['outcome missing build', job => { delete job.attempts[1].relayVersion; }, /Outcome attempt relayVersion missing/],
  ['outcome message', job => { job.attempts[1].messageId = 'other'; }, /attempt messageId does not match/],
  ['outcome attempt number', job => { job.attempts[0].attempt = 3; }, /not later than/]
]) {
  test(`continue binds attempts end to end: ${label}`, t => {
    const dir = copy(t, 'continue');
    edit(dir, jobFile, change);
    const row = getCheck('continue').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, error);
  });
}

for (const handback of [null, [], [{ at: 'bad' }], [{ at: '2026-10-22T10:00:30.001Z' }]]) {
  test(`continue needs a hand-back before sending: ${JSON.stringify(handback)}`, t => {
    const dir = copy(t, 'continue'), file = path.join(dir, 'jobs/repo/job-one/relay-handbacks.jsonl');
    if (handback === null) fs.rmSync(file);
    else lines(file, handback);
    const row = getCheck('continue').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /hand-back|relay-handbacks/);
  });
}

test('continue accepts a completed preceding attempt and hand-back exactly at the send', t => {
  const dir = copy(t, 'continue');
  edit(dir, jobFile, job => { job.attempts[0].endedAt = '2026-10-22T10:00:30.000Z'; });
  lines(path.join(dir, 'jobs/repo/job-one/relay-handbacks.jsonl'), [{ at: '2026-10-22T10:00:30.000Z' }]);
  assert.equal(getCheck('continue').analyze(input(dir)).results[0].result, 'pass');
});

test('continue reads the named archived report even if the latest report disagrees', t => {
  const dir = copy(t, 'continue'), jobDir = path.join(dir, 'jobs/repo/job-one');
  edit(dir, jobFile, job => { job.attempts.push({ attempt: 3, startedAt: '2026-10-22T11:00:00.000Z', relayVersion: 'future' }); });
  fs.mkdirSync(path.join(jobDir, 'attempts'));
  fs.writeFileSync(path.join(jobDir, 'attempts/2-report.md'), 'second turn for codex\n');
  fs.writeFileSync(path.join(jobDir, 'report.md'), 'third turn\n');
  assert.equal(getCheck('continue').analyze(input(dir)).results[0].result, 'pass');
  fs.writeFileSync(path.join(jobDir, 'attempts/2-report.md'), 'wrong output\n');
  fs.writeFileSync(path.join(jobDir, 'report.md'), 'second turn for codex\n');
  const row = getCheck('continue').analyze(input(dir)).results[0];
  assert.equal(row.result, 'fail');
  assert.match(row.reason, /Report is missing/);
  fs.rmSync(path.join(jobDir, 'attempts/2-report.md'));
  assert.match(getCheck('continue').analyze(input(dir)).results[0].reason, /Cannot read attempts\/2-report.md/);
});

for (const [label, change, error] of [
  ['posting status', row => { row.status = 'posting'; }, /status is posting/],
  ['missing postedAt', row => { delete row.postedAt; }, /postedAt timestamp/],
  ['invalid postedAt', row => { row.postedAt = 'bad'; }, /postedAt timestamp/],
  ['pre-send postedAt', row => { row.postedAt = '2026-10-22T10:00:29.999Z'; }, /predates/],
  ['retried late post', row => { row.postedAt = '2026-10-22T10:01:00.001Z'; }, /exceeded 30/]
]) {
  test(`delivery is acknowledged and timed to postedAt: ${label}`, t => {
    const dir = copy(t, 'steer-plugin');
    edit(dir, ledger, change);
    const row = getCheck('steer-plugin').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, error);
  });
}

test('readSeconds measures guard pickup; deliveredSeconds includes retry delay and its inclusive limit', t => {
  const dir = copy(t, 'steer-plugin');
  edit(dir, ledger, row => { row.postedAt = '2026-10-22T10:01:00.000Z'; });
  const analyzed = getCheck('steer-plugin').analyze(input(dir));
  assert.equal(analyzed.results[0].result, 'pass');
  assert.deepEqual(analyzed.results[0].timings, { deliveredSeconds: [30], readSeconds: [2] });
  assert.equal(analyzed.details[0].deliveredAt, '2026-10-22T10:01:00.000Z');
  assert.equal(analyzed.details[0].readAt, '2026-10-22T10:00:32.000Z');
});

test('both timing arrays follow send timestamps rather than expected-message order', t => {
  const dir = mainFixture(t, ['codex']), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  const sends = entries.filter(entry => entry.message?.content?.some?.(block => block.name === 'SendMessage'));
  [sends[0].timestamp, sends[2].timestamp] = [sends[2].timestamp, sends[0].timestamp];
  lines(file, entries);
  for (const [round, postedAt, at] of [[1, '01:35', '01:34'], [2, '01:03', '01:02'], [3, '00:31', '00:30']]) {
    edit(dir, `jobs/repo/codex-job/inbox/relay/${round}.json`, row => {
      row.postedAt = `2026-10-22T10:${postedAt}.000Z`;
      row.at = `2026-10-22T10:${at}.000Z`;
    });
  }
  const row = getCheck('steer-main').analyze(input(dir)).results[0];
  assert.equal(row.result, 'pass');
  assert.deepEqual(row.timings, { deliveredSeconds: [1, 3, 5], readSeconds: [0, 2, 4] });
});

test('promptText and scopeToRun unwrap a complete Claude paste envelope for terminal analysis', t => {
  const dir = copy(t, 'steer-plugin'), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  const prompt = 'Live suite run synthetic-run.\nRun the acceptance check.';
  entries[0].message.content = `\n\n<pasted_content id="c0a5">\n${prompt}\n</pasted_content id="c0a5">\n`;
  lines(file, entries);
  assert.equal(promptText(entries[0]), prompt);
  assert.deepEqual(scopeToRun(entries, 'synthetic-run'), entries);
  assert.equal(getCheck('steer-plugin').analyze(input(dir)).results[0].result, 'pass');
  const nested = { type: 'user', message: { content: `<pasted_content id="outer">\n${entries[0].message.content}\n</pasted_content id="outer">\n` } };
  assert.deepEqual(scopeToRun([nested], 'synthetic-run'), []);
  for (const content of [`quote\n${entries[0].message.content}`, `${entries[0].message.content}\nReview this prompt.`,
    entries[0].message.content.replace('</pasted_content id="c0a5">', '</pasted_content id="different">')]) {
    lines(file, [{ ...entries[0], message: { content } }, ...entries.slice(1)]);
    assert.deepEqual(scopeToRun(readTranscript(file), 'synthetic-run'), []);
    assert.equal(getCheck('steer-plugin').analyze(input(dir)).results[0].result, 'fail');
  }
});

test('promptText strips leading blank lines from plain T3 strings and text blocks without changing entries', () => {
  const text = 'Live suite run t3.\nprompt';
  for (const content of [text, `\n\n${text}`, ` \t\n\r\n${text}`, [
    { type: 'image' }, { type: 'text', text: '\n\nLive suite run t3.' }, { type: 'text', text: 'prompt' }
  ]]) {
    const entry = { type: 'user', message: { content } }, original = structuredClone(entry);
    assert.equal(promptText(entry), text);
    assert.equal(scopeToRun([entry], 't3')[0], entry);
    assert.deepEqual(entry, original);
  }
  assert.equal(promptText(null), '');
});

test('the next-run boundary uses the same paste and blank-line normalization', () => {
  const start = textEntry('user', 'Live suite run first.'), send = callEntry('send', 'SendMessage', {}, null);
  for (const content of ['\n\nLive suite run next.\nprompt',
    '\n\n<pasted_content id="c0a5">\nLive suite run next.\nprompt\n</pasted_content id="c0a5">\n']) {
    const next = { type: 'user', message: { content } };
    assert.deepEqual(scopeToRun([start, send, next, send], 'first'), [start, send]);
    assert.deepEqual(scopeToRun([start, send, next, send], 'next'), [next, send]);
    const quotes = [`quote\n${content}`, ...(content.includes('<pasted_content') ? [`${content}Review this.`] : [])];
    for (const quote of quotes) {
      const quoted = { type: 'user', message: { content: quote } };
      assert.deepEqual(scopeToRun([start, send, quoted, send], 'first'), [start, send, quoted, send]);
    }
  }
});

test('an unspawned raw-id recipient fails its backend, and an unassigned extra send fails the run', t => {
  const dir = mainFixture(t, ['codex']), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  const send = entries.find(entry => entry.message?.content?.some?.(block => block.name === 'SendMessage'));
  send.message.content[0].input.to = 'foreign-agent-id';
  lines(file, entries);
  assert.match(getCheck('steer-main').analyze(input(dir)).results[0].reason, /Recipient was not spawned in this run/);
  send.message.content[0].input.to = 'steer-codex';
  entries.push(callEntry('extra-send', 'SendMessage', { to: 'foreign-agent-id', message: 'unrelated extra send' }, '2026-10-22T10:02:00.000Z'));
  lines(file, entries);
  assert.match(getCheck('steer-main').analyze(input(dir)).results[0].reason, /Recipient was not spawned in this run/);
});

for (const name of ['steer-main', 'steer-workflow', 'steer-plugin', 'continue']) {
  test(`${name} rejects a second relay even when it receives no sends`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
    const spawn = structuredClone(entries[1]), result = structuredClone(entries[2]);
    spawn.message.content[0].id = 'extra-spawn';
    result.message.content[0].tool_use_id = 'extra-spawn';
    result.toolUseResult.agentId = 'extra-relay';
    lines(file, [...entries, spawn, result]);
    const row = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /exactly one relay for codex, found 2 \(.*extra-relay\)/);
  });

  test(`${name} requires the backend's exact relay name`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
    entries[1].message.content[0].input.name = 'other-relay';
    const parsed = transcriptCalls(entries);
    assert.equal(parsed.spawns.length, 1);
    lines(file, entries);
    const row = getCheck(name).analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, /named "other-relay", expected (steer|continue)-codex/);
  });

  test(`${name} uses its own scope for analyzer evidence`, t => {
    const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
    const file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
    entries[0].message.content = '/command-without-a-run-line';
    lines(file, entries);
    assert.equal(getCheck(name).analyze(input(dir)).results[0].result, 'fail');
    let called = 0;
    const check = { ...getCheck(name), scope(all, runId) {
      called++;
      assert.equal(runId, 'synthetic-run');
      assert.deepEqual(all, entries);
      return all;
    } };
    assert.equal(check.analyze(input(dir)).results[0].result, 'pass');
    assert.equal(called, 1);
    check.scope = () => [];
    assert.equal(check.analyze(input(dir)).results[0].result, 'fail');
  });

  for (const failure of ['missing', 'unrelated', 'substring']) {
    test(`${name} requires exact receiver text: ${failure}`, t => {
      const dir = name === 'steer-main' ? mainFixture(t, ['codex']) : copy(t, name);
      const file = path.join(dir, name === 'steer-main' ? 'jobs/repo/codex-job/relay-transcript.jsonl' : 'jobs/repo/job-one/relay-transcript.jsonl');
      const entries = readTranscript(file);
      const holder = name === 'continue' ? entries[0].message : name === 'steer-workflow' ? entries[0].attachment.origin : entries[0].attachment;
      const key = name === 'continue' ? 'content' : name === 'steer-workflow' ? 'body' : 'prompt';
      if (failure === 'missing') delete holder[key];
      if (failure === 'unrelated') holder[key] = 'something else entirely';
      if (failure === 'substring') holder[key] = holder[key].replace('for codex', 'for codex plus extra text');
      lines(file, entries);
      const row = getCheck(name).analyze(input(dir)).results[0];
      assert.equal(row.result, 'fail');
      assert.match(row.reason, /Relay transcript text does not match the send/);
    });
  }
}

test('three valid jobs cannot supply the three rounds of one backend', t => {
  const dir = mainFixture(t, ['codex']), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  const original = path.join(dir, 'jobs/repo/codex-job');
  entries[3].message.content[0].input.to = 'agent-codex';
  for (const round of [2, 3]) {
    const agentId = `agent-codex-${round}`, jobDir = `repo/codex-job-${round}`;
    fs.cpSync(original, path.join(dir, 'jobs', jobDir), { recursive: true });
    write(path.join(dir, `jobs/relays/${agentId}.json`), { agentId, jobDir, transcriptPath: `${jobDir}/relay-transcript.jsonl` });
    const spawn = structuredClone(entries[1]), result = structuredClone(entries[2]);
    spawn.message.content[0].id = `spawn-${round}`;
    result.message.content[0].tool_use_id = `spawn-${round}`;
    result.toolUseResult.agentId = agentId;
    entries.push(spawn, result);
    const send = entries.find(entry => entry.message?.content?.[0]?.id === `send-codex-${round}`);
    send.message.content[0].input.to = agentId;
  }
  lines(file, entries);
  const analyzed = getCheck('steer-main').analyze(input(dir));
  assert.ok(analyzed.details.every(row => row.pass));
  assert.equal(new Set(analyzed.details.map(row => row.jobDir)).size, 3);
  assert.equal(analyzed.results[0].result, 'fail');
  assert.equal(analyzed.results[0].reason, 'Expected exactly one relay for codex, found 3 (agent-codex, agent-codex-2, agent-codex-3).');
});

test('a send to another backend relay names both relays and fails the intended backend', t => {
  const dir = mainFixture(t, ['codex', 'grok']), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  const send = entries.find(entry => entry.message?.content?.[0]?.id === 'send-codex-1');
  send.message.content[0].input.to = 'agent-grok';
  lines(file, entries);
  const analyzed = getCheck('steer-main').analyze(input(dir, ['codex', 'grok']));
  assert.deepEqual(analyzed.results.map(row => row.result), ['fail', 'pass']);
  assert.match(analyzed.results[0].reason, /Send targets relay agent-grok, not codex's relay agent-codex/);
});

test('a raw recipient id outside the run is named in the failure', t => {
  const dir = mainFixture(t, ['codex']), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  entries[3].message.content[0].input.to = 'another-relay';
  lines(file, entries);
  assert.match(getCheck('steer-main').analyze(input(dir)).results[0].reason, /not spawned in this run: another-relay/);
});

test('spawn counting requires a successful Agent result with an id and ignores repeated snapshots', t => {
  const dir = mainFixture(t, ['codex']), file = path.join(dir, 'transcript.jsonl'), entries = readTranscript(file);
  lines(file, [...entries, structuredClone(entries[2])]);
  assert.equal(getCheck('steer-main').analyze(input(dir)).results[0].result, 'pass');
  for (const failure of ['missing id', 'failed result', 'no result']) {
    const changed = structuredClone(entries);
    if (failure === 'missing id') { delete changed[2].toolUseResult.agentId; changed[2].message.content[0].content = 'No id.'; }
    if (failure === 'failed result') changed[2].message.content[0].is_error = true;
    if (failure === 'no result') changed.splice(2, 1);
    lines(file, changed);
    const row = getCheck('steer-main').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail', failure);
    assert.match(row.reason, /exactly one relay for codex, found 0/);
  }
});

test('ledger entries with no stored message still match by receiver text, never by order', t => {
  const dir = mainFixture(t, ['codex']);
  for (const round of [1, 2, 3]) {
    edit(dir, `jobs/repo/codex-job/inbox/relay/${round}.json`, row => {
      delete row.text;
      row.at = `2026-10-22T10:02:0${4 - round}.000Z`;
    });
  }
  const analyze = () => getCheck('steer-main').analyze(input(dir));
  const passed = analyze();
  assert.equal(passed.results[0].result, 'pass');
  assert.deepEqual(passed.details.map(row => row.matchedBy), ['text', 'text', 'text']);
  assert.deepEqual(passed.results[0].timings.deliveredSeconds, [2, 3, 4]);
  const file = path.join(dir, 'jobs/repo/codex-job/relay-transcript.jsonl'), entries = readTranscript(file);
  entries[0].attachment.prompt = 'unrelated';
  lines(file, entries);
  assert.equal(analyze().results[0].result, 'fail');
  assert.match(analyze().results[0].reason, /No matching delivery record.*relay transcript/);
});

test('Workflow matches origin.body even though the queued prompt carries an agent-message envelope', t => {
  const dir = copy(t, 'steer-workflow');
  const file = path.join(dir, 'jobs/repo/job-one/relay-transcript.jsonl'), entries = readTranscript(file);
  assert.equal(entries[0].attachment.prompt, '<agent-message from="sender">\nsteer from a workflow agent for codex\n</agent-message>');
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'pass');
  delete entries[0].attachment.origin.body;
  lines(file, entries);
  assert.equal(getCheck('steer-workflow').analyze(input(dir)).results[0].result, 'fail');
});

test('continue extracts the exact message from its coordinator envelope as a string or text blocks', t => {
  const dir = copy(t, 'continue');
  const file = path.join(dir, 'jobs/repo/job-one/relay-transcript.jsonl'), entries = readTranscript(file);
  const text = entries[0].message.content;
  entries[0].message.content = text.split('\n').map(text => ({ type: 'text', text }));
  lines(file, entries);
  assert.equal(getCheck('continue').analyze(input(dir)).results[0].result, 'pass');
  for (const content of [text.replace('The coordinator sent a message while you were working:\n', ''),
    text.replace('\n\nAddress this before completing your current task.', ''),
    text.replace('second turn for codex', 'second turn for codex\nextra message text')]) {
    entries[0].message.content = content;
    lines(file, entries);
    assert.equal(getCheck('continue').analyze(input(dir)).results[0].result, 'fail');
  }
});

test('run span uses the same normalized first prompt line as scoping', () => {
  assert.equal(runLine('wanted'), 'Live suite run wanted.');
  const prompt = 'Live suite run wanted.\nprompt';
  const finish = textEntry('assistant', 'DONE', 'finish');
  for (const content of [prompt, `\n\n${prompt}`, `\n\n<pasted_content id="paste">\n${prompt}\n</pasted_content id="paste">\n`,
    [{ type: 'text', text: '\n\nLive suite run wanted.' }, { type: 'text', text: 'prompt' }]]) {
    const start = { type: 'user', timestamp: 'start', message: { content } };
    assert.deepEqual(runSpan([start, finish], 'wanted', 'DONE'), { startedAt: 'start', finishedAt: 'finish' });
    assert.deepEqual(scopeToRun([start, finish], 'wanted'), [start, finish]);
  }
  for (const content of [`quoted\n${prompt}`, `<pasted_content id="paste">\n${prompt}\n</pasted_content id="paste">\nReview this.`]) {
    const quoted = textEntry('user', content, 'wrong');
    assert.equal(runSpan([quoted, finish], 'wanted', 'DONE').startedAt, null);
    assert.deepEqual(scopeToRun([quoted, finish], 'wanted'), []);
  }
});

const phaseJob = 'jobs/repo/codex-job/job.json';
const phaseJournal = 'transcript/subagents/workflows/wf-synthetic/journal.jsonl';
const phaseWorkflow = 'transcript/workflows/wf-synthetic.json';
const parserMessages = {
  codex: 'Unknown header key "efort". Known keys: model, effort, mode, network, cd, add-dir, brief, web-search, fast, backend, grok-home, kimi-home.',
  grok: 'web-search: cached is not supported for Grok; disabling web_search and web_fetch has not been proved in agent mode.',
  zcode: 'mode: write is not supported for ZCode: it has no workspace sandbox, and its edit mode lets shell commands write anywhere. Use mode: yolo, or mode: read-only.',
  kimi: "effort is required. Use `effort: default` to use Kimi's own default."
};
const fakeHeader = prompt => ({ status: 1, stderr: '', stdout: `error: ${parserMessages[Object.keys(badPrompts).find(backend => badPrompts[backend] === prompt)]}\n` });
function phaseInput(dir, backends = ['codex']) { return { ...input(dir, backends), evidenceDir: dir }; }
function phaseAnalyze(name, dir, backends = ['codex']) {
  return getCheck(name).analyze(phaseInput(dir, backends), { checkHeaderRunner: fakeHeader });
}
function changeEntries(dir, change, file = 'transcript.jsonl') {
  const target = path.join(dir, file), entries = readTranscript(target);
  lines(target, change(entries) ?? entries);
}
const callBlock = (entries, id) => entries.flatMap(e => Array.isArray(e.message?.content) ? e.message.content : []).find(b => b.type === 'tool_use' && b.id === id);
const resultEntry = (entries, id) => entries.find(e => e.message?.content?.some?.(b => b.type === 'tool_result' && b.tool_use_id === id));
const hookEntry = entries => entries.find(e => e.attachment?.toolUseID === 'stop-codex');
const at = value => `2026-10-22T10:${value}Z`;

for (const backends of [BACKENDS, ['grok', 'kimi']]) {
  test(`stop prompt holds the contract calls for ${backends}`, () => {
    const prompt = getCheck('stop').prompt({ runId: 'prompt-run', backends });
    assert.ok(prompt.includes(agentCalls(backends, { prefix: 'stop', seconds: 240 })));
    assert.deepEqual(prompt.split('\n').filter(line => line.startsWith('TaskStop(')), backends.map(backend => `TaskStop({"task_id":"stop-${backend}"})`));
    assert.ok(prompt.includes(waitLoop(20)));
    assert.match(prompt, /state "running" and an attempt/);
    assert.match(prompt, /Do not send messages, spawn replacements or wait for completion notices/);
    assert.equal(prompt.trimEnd().split('\n').at(-1), 'LIVE-STOP-DONE');
  });
  test(`session-end prompt holds the contract calls for ${backends}`, () => {
    const prompt = getCheck('session-end').prompt({ runId: 'prompt-run', backends });
    const calls = prompt.split('\n').filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
    assert.deepEqual(calls, backends.map(backend => ({ subagent_type: 'relay:job', name: `session-end-${backend}`,
      description: `session-end-${backend}`, run_in_background: true,
      prompt: `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\nRun the shell command \`sleep 150\` exactly once and wait for it. Then reply with exactly one line: session-end done for ${backend}` })));
    assert.match(prompt, /state "running" and an attempt/);
    assert.match(prompt, /end the turn without waiting for any completion notice/);
    assert.equal(prompt.trimEnd().split('\n').at(-1), 'LIVE-SESSION-END-READY');
  });
  test(`spawn-check prompt holds the exact Agent calls and exported Workflow script for ${backends}`, () => {
    const prompt = getCheck('spawn-check').prompt({ runId: 'prompt-run', backends });
    assert.deepEqual(prompt.split('\n').filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1))),
      backends.map(backend => ({ subagent_type: 'relay:job', name: `spawn-bad-${backend}`, description: `spawn-bad-${backend}`, run_in_background: true, prompt: badPrompts[backend] })));
    assert.equal(prompt.split('with no args:\n\n')[1].split('\n\nThen wait')[0], spawnScript(backends));
    assert.match(prompt, /explicit request to use the Workflow tool/);
    assert.match(prompt, /verbatim; do not retry/);
    assert.ok(prompt.includes(waitLoop(60)));
    assert.equal(prompt.trimEnd().split('\n').at(-1), 'LIVE-SPAWN-CHECK-DONE');
  });
}

test('spawn-check bad prompts are the four distinct contract errors', () => {
  assert.deepEqual(badPrompts, {
    codex: 'model: gpt-6.1-sol\nefort: low\n---\nSay hi.',
    grok: 'backend: grok\nmodel: grok-4.7\neffort: low\nweb-search: cached\n---\nSay hi.',
    zcode: 'backend: zcode\nmodel: glm-5.3-flash\neffort: low\nmode: write\n---\nSay hi.',
    kimi: 'backend: kimi\nmodel: kimi-code/kimi-for-coding\n---\nSay hi.'
  });
});

test('spawn-check Workflow catches each bad call before its good call and runs backends in parallel', async () => {
  const script = spawnScript(BACKENDS), seen = [];
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('parallel', 'agent', script.replace('export const meta', 'const meta'));
  const result = await execute(tasks => Promise.all(tasks.map(task => task())), async (prompt, options) => {
    seen.push({ prompt, options });
    const backend = BACKENDS.find(b => options.label.endsWith(`-${b}`));
    assert.equal(options.agentType, 'relay:job');
    if (options.label.startsWith('spawn-bad')) {
      assert.equal(prompt, badPrompts[backend]);
      if (backend === 'kimi') return 'unexpected return';
      throw new Error(`denied ${backend}`);
    }
    assert.equal(prompt, goodPrompt(backend));
    return `completed ${backend}`;
  });
  assert.deepEqual(seen.slice(0, 4).map(item => item.options.label), BACKENDS.map(b => `spawn-bad-${b}`));
  for (const backend of BACKENDS) {
    assert.deepEqual(result[backend], { bad: backend === 'kimi' ? { returned: 'unexpected return' } : { error: `denied ${backend}` }, good: `completed ${backend}` });
  }
});

for (const [name, backends, timings] of [
  ['stop', ['codex', 'kimi'], [{ cancelledSeconds: [0.2] }, { cancelledSeconds: [0.4] }]],
  ['session-end', ['codex'], [{ ranOnSeconds: [130] }]], ['spawn-check', ['codex'], [{}]]
]) {
  test(`${name} reduced live fixture passes on ${backends}`, () => {
    const analyzed = phaseAnalyze(name, path.join(fixture, name), backends);
    assert.deepEqual(analyzed.results.map(row => row.reason), backends.map(() => null));
    assert.deepEqual(analyzed.results.map(row => row.result), backends.map(() => 'pass'));
    assert.deepEqual(analyzed.results.map(row => row.timings), timings);
  });
}

const stopMutations = [
  ...[
    'TaskStop stopped the relay:job agent agent-codex. Its job codex-job had already ended (cancelled); nothing was cancelled.',
    'TaskStop stopped the relay:job agent agent-codex. The relay hook asked its job codex-job to cancel, and the job has not ended yet:\npending',
    'TaskStop stopped the relay:job agent agent-codex, and the relay hook could not cancel its job codex-job: failure. The job may still be running. Cancel it with: node "/plugin/scripts/companion.mjs" cancel codex-job'
  ].map((text, i) => [`${['already-ended', 'pending', 'failed'][i]} hook context`, dir => changeEntries(dir, e => {
    hookEntry(e).attachment.content = [text];
  }), /successful hook context/]),
  ['cancel posted after hook attachment', dir => edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.createdAt = at('00:31.001'); }), /[Cc]ancel message/],
  ['hook attachment without timestamp', dir => changeEntries(dir, e => { delete hookEntry(e).timestamp; }), /[Cc]ancel message/],
  ['missing relay', dir => changeEntries(dir, e => e.filter(x => !x.message?.content?.some?.(b => b.id === 'spawn-codex'))), /one relay/],
  ['wrong relay name', dir => changeEntries(dir, e => { callBlock(e, 'spawn-codex').input.name = 'other'; }), /one relay/],
  ['second relay', dir => changeEntries(dir, e => { const c = structuredClone(e[1]), r = structuredClone(e[2]); c.message.content[0].id = 'second'; r.message.content[0].tool_use_id = 'second'; e.push(c, r); }), /one relay/],
  ['missing agent id', dir => changeEntries(dir, e => { const r = resultEntry(e, 'spawn-codex'); delete r.toolUseResult; r.message.content[0].content = ''; }), /one relay/],
  ['another pointer binding', dir => edit(dir, phaseJob, j => { j.relay.agentId = 'other'; }), /another relay/],
  ['no hook context', dir => changeEntries(dir, e => e.filter(x => x !== hookEntry(e))), /hook context/],
  ['hook context for another call', dir => changeEntries(dir, e => { hookEntry(e).attachment.toolUseID = 'other'; }), /hook context/],
  ['hook context naming another job', dir => changeEntries(dir, e => { hookEntry(e).attachment.content = ['other-job']; }), /hook context/],
  ['TaskStop naming another relay', dir => changeEntries(dir, e => { callBlock(e, 'stop-codex').input.task_id = 'other'; }), /one TaskStop/],
  ['missing TaskStop result', dir => changeEntries(dir, e => e.filter(x => x !== resultEntry(e, 'stop-codex'))), /TaskStop result/],
  ['TaskStop result error', dir => changeEntries(dir, e => { resultEntry(e, 'stop-codex').message.content[0].is_error = true; }), /TaskStop result/],
  ['TaskStop result naming another relay', dir => changeEntries(dir, e => { resultEntry(e, 'stop-codex').toolUseResult.task_id = 'other'; }), /another relay/],
  ['job not cancelled', dir => edit(dir, phaseJob, j => { j.state = 'running'; }), /not cancelled/],
  ['cancelled 15.001 seconds later', dir => edit(dir, phaseJob, j => { j.completedAt = at('00:45.001'); }), /0 to 15 seconds/],
  ['completion before TaskStop', dir => edit(dir, phaseJob, j => { j.completedAt = at('00:29.999'); }), /0 to 15 seconds/],
  ['cancel posted before TaskStop', dir => edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.createdAt = at('00:29.999'); }), /[Cc]ancel message/],
  ['missing cancel', dir => fs.rmSync(path.join(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json')), /[Cc]ancel message/],
  ['wrong message kind', dir => edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.kind = 'steer'; }), /[Cc]ancel message/],
  ['wrong cancel outcome', dir => edit(dir, 'jobs/repo/codex-job/inbox/outcomes/cancel-codex.json', m => { m.action = 'interrupt-sent'; }), /[Cc]ancel message/],
  ['attempt ended before TaskStop', dir => edit(dir, phaseJob, j => { j.attempts[0].endedAt = at('00:29.999'); }), /not active/],
  ['attempt started at TaskStop', dir => edit(dir, phaseJob, j => { j.attempts[0].startedAt = at('00:30.000'); }), /not active/],
  ['attempt not cancelled', dir => edit(dir, phaseJob, j => { j.attempts[0].state = 'completed'; }), /attempt is not cancelled/],
  ['later attempt', dir => edit(dir, phaseJob, j => { j.attempts.push({ ...j.attempts[0], attempt: 2, startedAt: at('00:31.000') }); }), /not active/],
  ['another relay version', dir => edit(dir, phaseJob, j => { j.attempts[0].relayVersion = 'other'; }), /relayVersion/],
  ['second TaskStop', dir => changeEntries(dir, e => { e.push(callEntry('second-stop', 'TaskStop', { task_id: 'agent-codex' }, at('00:30.100'))); }), /one TaskStop/],
  ['TaskStop outside the run scope', dir => changeEntries(dir, e => { e.splice(3, 0, textEntry('user', 'Live suite run other-run.')); }), /one TaskStop/],
  ['hook outside the run scope', dir => changeEntries(dir, e => { e.splice(e.indexOf(hookEntry(e)), 0, textEntry('user', 'Live suite run other-run.')); }), /hook context/],
  ['no hand-back recorded', dir => fs.rmSync(path.join(dir, 'jobs/repo/codex-job/relay-handbacks.jsonl')), /hand-back/],
  ['hand-back not by TaskStop', dir => fs.writeFileSync(path.join(dir, 'jobs/repo/codex-job/relay-handbacks.jsonl'), '{"at":"2026-10-22T10:00:30.150Z","agentId":"agent-codex","attempts":1,"state":"cancelled"}\n'), /hand-back/],
  ['hand-back for another relay', dir => fs.writeFileSync(path.join(dir, 'jobs/repo/codex-job/relay-handbacks.jsonl'), '{"at":"2026-10-22T10:00:30.150Z","agentId":"other","attempts":1,"state":"cancelled","by":"TaskStop"}\n'), /hand-back/],
  ['hand-back before TaskStop', dir => fs.writeFileSync(path.join(dir, 'jobs/repo/codex-job/relay-handbacks.jsonl'), '{"at":"2026-10-22T10:00:29.999Z","agentId":"agent-codex","attempts":1,"state":"cancelled","by":"TaskStop"}\n'), /hand-back/]
];
for (const [label, mutate, reason] of stopMutations) {
  test(`stop rejects ${label}`, t => {
    const dir = copy(t, 'stop'); mutate(dir);
    const result = phaseAnalyze('stop', dir).results[0];
    assert.equal(result.result, 'fail'); assert.match(result.reason, reason);
  });
}

test('stop accepts agent id, JSON result fallback and inclusive 15 second cancellation', t => {
  const dir = copy(t, 'stop');
  changeEntries(dir, e => { callBlock(e, 'stop-codex').input.task_id = 'agent-codex'; delete resultEntry(e, 'stop-codex').toolUseResult; });
  edit(dir, phaseJob, j => { j.completedAt = at('00:45.000'); });
  assert.equal(phaseAnalyze('stop', dir).results[0].result, 'pass');
  assert.equal(getCheck('stop').cell({ timings: { cancelledSeconds: [15] } }), 'cancelled in 15.0 s');
});

function cancelEvidence(dir, form, id, createdAt, action = 'cancelled') {
  const jobDir = path.join(dir, 'jobs/repo/codex-job');
  const message = { id, kind: 'cancel', text: '' };
  if (form === 'receipt') recordReceipt(jobDir, message, { action });
  else {
    postInboxMessage(jobDir, message);
    if (form === 'claimed') claimInboxMessages(jobDir);
    writeOutcome(jobDir, id, { action });
  }
  const file = `jobs/repo/codex-job/inbox/${form === 'pending' ? '' : 'claimed/'}${id}.json`;
  edit(dir, file, m => { m.createdAt = createdAt; });
}

for (const form of ['pending', 'claimed', 'receipt']) {
  test(`stop accepts one ${form} cancel with a cancelled outcome`, t => {
    const dir = copy(t, 'stop');
    fs.rmSync(path.join(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json'));
    cancelEvidence(dir, form, 'cancel-codex', at('00:30.100'));
    assert.equal(phaseAnalyze('stop', dir).results[0].result, 'pass');
  });
  for (const [when, timestamp] of [['before TaskStop', at('00:29.999')], ['during the hook', at('00:30.150')], ['after the hook', at('00:31.001')]]) {
    test(`stop rejects a second ${form} cancel ${when}`, t => {
      const dir = copy(t, 'stop');
      cancelEvidence(dir, form, 'second-cancel', timestamp, form === 'receipt' ? 'no-op' : 'cancelled');
      const result = phaseAnalyze('stop', dir).results[0];
      assert.equal(result.result, 'fail');
      assert.match(result.reason, /exactly one cancel message, found 2/);
    });
  }
}

for (const command of ['node /plugin/scripts/companion.mjs cancel codex-job',
  'C(){ node "$CLAUDE_PLUGIN_ROOT/scripts/companion.mjs" "$@"; }; C cancel codex-job']) {
  test(`stop rejects manual cancellation followed by a hook no-op: ${command}`, t => {
    const dir = copy(t, 'stop');
    changeEntries(dir, entries => { entries.push(callEntry('manual-cancel', 'Bash', { command }, at('00:30.050'))); });
    cancelEvidence(dir, 'receipt', 'hook-no-op', at('00:30.250'), 'no-op');
    assert.match(phaseAnalyze('stop', dir).results[0].reason, /exactly one cancel message, found 2/);
  });
}

test('stop rejects a lone no-op cancel receipt', t => {
  const dir = copy(t, 'stop');
  cancelEvidence(dir, 'receipt', 'cancel-codex', at('00:30.100'), 'no-op');
  assert.match(phaseAnalyze('stop', dir).results[0].reason, /no cancelled outcome/);
});

test('stop rejects a second cancel known only to the job ledger', t => {
  const dir = copy(t, 'stop');
  edit(dir, phaseJob, job => { job.messages.push({ id: 'second-cancel', kind: 'cancel', action: 'cancelled' }); });
  assert.match(phaseAnalyze('stop', dir).results[0].reason, /exactly one cancel message, found 2/);
});

const sessionMutations = [
  ['missing claudePid', dir => edit(dir, 'run.json', r => { delete r.claudePid; }), /claudePid/],
  ['pid without start time', dir => edit(dir, 'run.json', r => { delete r.claudePid.startedAt; }), /claudePid/],
  ['lead transcript entry after sessionEndedAt', dir => changeEntries(dir, e => {
    e.push(textEntry('assistant', 'Still here.', at('00:30.001')));
  }), /later than sessionEndedAt/],
  ['later lead entry outside run scope', dir => changeEntries(dir, e => {
    e.push(textEntry('user', 'Live suite run later-run.', at('00:30.001')));
  }), /later than sessionEndedAt/],
  ['missing relay', dir => changeEntries(dir, e => e.filter(x => !x.message?.content?.some?.(b => b.id === 'spawn-codex'))), /one relay/],
  ['wrong relay name', dir => changeEntries(dir, e => { callBlock(e, 'spawn-codex').input.name = 'other'; }), /one relay/],
  ['missing agent id', dir => changeEntries(dir, e => { const r = resultEntry(e, 'spawn-codex'); delete r.toolUseResult; r.message.content[0].content = ''; }), /one relay/],
  ['running read at 14.999 seconds', dir => edit(dir, 'run.json', r => { r.afterEnd['agent-codex'].at = at('00:44.999'); }), /15 seconds/],
  ['afterEnd not running', dir => edit(dir, 'run.json', r => { r.afterEnd['agent-codex'].state = 'completed'; }), /running observation/],
  ['cancel in messages', dir => edit(dir, phaseJob, j => { j.messages = [{ kind: 'cancel' }]; }), /cancel message/],
  ['cancel in pending inbox', dir => write(path.join(dir, 'jobs/repo/codex-job/inbox/cancel.json'), { kind: 'cancel' }), /cancel message/],
  ['cancel in claimed inbox', dir => write(path.join(dir, 'jobs/repo/codex-job/inbox/claimed/cancel.json'), { kind: 'cancel' }), /cancel message/],
  ['second attempt', dir => edit(dir, phaseJob, j => { j.attempts.push({ ...j.attempts[0], attempt: 2, startedAt: at('02:41.000') }); }), /not active/],
  ['attempt starts at session end', dir => edit(dir, phaseJob, j => { j.attempts[0].startedAt = at('00:30.000'); }), /not active/],
  ['attempt ends at session end', dir => edit(dir, phaseJob, j => { j.attempts[0].endedAt = at('00:30.000'); }), /not active/],
  ['completed before session end', dir => edit(dir, phaseJob, j => { j.completedAt = at('00:29.999'); }), /did not complete/],
  ['job not completed', dir => edit(dir, phaseJob, j => { j.state = 'running'; }), /did not complete/],
  ['attempt not completed', dir => edit(dir, phaseJob, j => { j.attempts[0].state = 'failed'; }), /did not complete/],
  ['missing report line', dir => fs.writeFileSync(path.join(dir, 'jobs/repo/codex-job/report.md'), 'other'), /Report/],
  ['missing sessionEndedAt', dir => edit(dir, 'run.json', r => { delete r.sessionEndedAt; }), /sessionEndedAt/],
  ['missing afterEnd', dir => edit(dir, 'run.json', r => { delete r.afterEnd; }), /running observation/],
  ['another relay version', dir => edit(dir, phaseJob, j => { j.attempts[0].relayVersion = 'other'; }), /relayVersion/],
  ['spawn outside the run scope', dir => changeEntries(dir, e => { e.splice(1, 0, textEntry('user', 'Live suite run other-run.')); }), /one relay/],
  ['another run metadata', dir => edit(dir, 'run.json', r => { r.runId = 'other'; }), /this run/]
];
for (const [label, mutate, reason] of sessionMutations) {
  test(`session-end rejects ${label}`, t => {
    const dir = copy(t, 'session-end'); mutate(dir);
    const result = phaseAnalyze('session-end', dir).results[0];
    assert.equal(result.result, 'fail'); assert.match(result.reason, reason);
  });
}

test('session-end accepts running at exactly 15 seconds and report case and full stop', t => {
  const dir = copy(t, 'session-end');
  edit(dir, 'run.json', r => { r.afterEnd['agent-codex'].at = at('00:45.000'); });
  assert.equal(phaseAnalyze('session-end', dir).results[0].result, 'pass');
  assert.equal(getCheck('session-end').cell({ timings: { ranOnSeconds: [130] } }), 'ran on and completed 130.0 s after the session ended');
});

function extraSpawnJob(dir, session = true) {
  const job = read(path.join(dir, phaseJob));
  job.id = 'extra-job'; job.relay.agentId = 'extra-agent';
  if (!session) job.relay.transcriptPath = '../other-session/subagents/agent-extra.jsonl';
  write(path.join(dir, 'jobs/repo/extra-job/job.json'), job);
}
const spawnMutations = [
  ['missing Agent call', dir => changeEntries(dir, e => e.filter(x => !x.message?.content?.some?.(b => b.id === 'bad-codex'))), /one bad Agent/],
  ['repeated Agent call', dir => changeEntries(dir, e => { const c = structuredClone(e[1]); c.message.content[0].id = 'second'; e.push(c); }), /one bad Agent/],
  ['wrong bad prompt', dir => changeEntries(dir, e => { callBlock(e, 'bad-codex').input.prompt = goodPrompt('codex'); }), /expected prompt/],
  ['Agent result not an error', dir => changeEntries(dir, e => { resultEntry(e, 'bad-codex').message.content[0].is_error = false; }), /Agent result/],
  ['Agent deny text with another message', dir => changeEntries(dir, e => { resultEntry(e, 'bad-codex').message.content[0].content = 'Subagent spawn denied by a plugin: other'; }), /Agent result/],
  ['meta file with bad name', dir => write(path.join(dir, 'transcript/subagents/agent-bad.meta.json'), { name: 'spawn-bad-codex' }), /meta file/],
  ['nested meta file with bad description', dir => write(path.join(dir, 'transcript/subagents/workflows/other/agent-bad.meta.json'), { description: 'spawn-bad-codex' }), /meta file/],
  ['wrong Workflow script', dir => changeEntries(dir, e => { const c = callBlock(e, 'workflow'); c.input.script = c.input.script.replace('spawn-good-codex', 'spawn-good-other'); }), /expected script/],
  ['Workflow script with leading text', dir => changeEntries(dir, e => { callBlock(e, 'workflow').input.script = '// note\n' + callBlock(e, 'workflow').input.script; }), /expected script/],
  ['Workflow args', dir => changeEntries(dir, e => { callBlock(e, 'workflow').input.args = {}; }), /no args/],
  ['second Workflow', dir => changeEntries(dir, e => { e.push(callEntry('second-workflow', 'Workflow', { script: spawnScript(['codex']) })); }), /one Workflow/],
  ['Workflow result error', dir => changeEntries(dir, e => { resultEntry(e, 'workflow').message.content[0].is_error = true; }), /Workflow launch/],
  ['Workflow bad.error with another message', dir => edit(dir, phaseWorkflow, r => { r.result.codex.bad.error = 'other'; }), /bad.error/],
  ['Workflow result of another run', dir => edit(dir, phaseWorkflow, r => { r.runId = 'other'; }), /another run/],
  ['bad label started', dir => changeEntries(dir, e => { e.push({ type: 'started', label: 'spawn-bad-codex', agentId: 'bad' }); }, phaseJournal), /bad Workflow label/],
  ['missing failed line', dir => changeEntries(dir, e => e.filter(x => x.type !== 'failed'), phaseJournal), /failed journal/],
  ['failed line with an agent id', dir => changeEntries(dir, e => { e[0].agentId = 'bad'; }, phaseJournal), /failed journal/],
  ['extra failed line', dir => changeEntries(dir, e => { e.push({ type: 'failed', key: 'extra', agentId: '' }); }, phaseJournal), /failed journal/],
  ['missing good started line', dir => changeEntries(dir, e => e.filter(x => x.type !== 'started'), phaseJournal), /started journal/],
  ['second good started line', dir => changeEntries(dir, e => { e.push({ ...e[1] }); }, phaseJournal), /started journal/],
  ['good block not completed', dir => edit(dir, phaseWorkflow, r => { r.result.codex.good = r.result.codex.good.replace('completed', 'running'); }), /state block/],
  ['good block job outside jobs home', dir => edit(dir, phaseWorkflow, r => { r.result.codex.good = r.result.codex.good.replace('repo/codex-job', '/tmp/other-job'); }), /dir does not match/],
  ['good job of another run', dir => edit(dir, phaseJob, j => { j.relay.workflowRunId = 'other'; }), /another Workflow/],
  ['good job with another label', dir => edit(dir, phaseJob, j => { j.relay.label = 'other'; }), /another Workflow/],
  ['good job with another agent', dir => edit(dir, phaseJob, j => { j.relay.agentId = 'other'; }), /another Workflow/],
  ['good job not completed', dir => edit(dir, phaseJob, j => { j.state = 'running'; }), /not completed/],
  ['good report missing', dir => fs.writeFileSync(path.join(dir, 'jobs/repo/codex-job/report.md'), 'other'), /report/],
  ['another relay version', dir => edit(dir, phaseJob, j => { j.attempts[0].relayVersion = 'other'; }), /relayVersion/],
  ['extra job of this session', dir => extraSpawnJob(dir), /extra job/],
  ['Agent call outside the run scope', dir => changeEntries(dir, e => { e.splice(1, 0, textEntry('user', 'Live suite run other-run.', at('00:00.500'))); }), /one bad Agent/],
  ['Workflow outside the run scope', dir => changeEntries(dir, e => { e.splice(3, 0, textEntry('user', 'Live suite run other-run.', at('00:04.000'))); }), /one Workflow/]
];
for (const [label, mutate, reason] of spawnMutations) {
  test(`spawn-check rejects ${label}`, t => {
    const dir = copy(t, 'spawn-check'); mutate(dir);
    const result = phaseAnalyze('spawn-check', dir).results[0];
    assert.equal(result.result, 'fail'); assert.match(result.reason, reason);
  });
}

test('spawn-check accepts tool_use_error wrappers and ignores jobs of other sessions', t => {
  const dir = copy(t, 'spawn-check'); extraSpawnJob(dir, false);
  changeEntries(dir, e => { const b = resultEntry(e, 'bad-codex').message.content[0]; b.content = `\n <tool_use_error>\n${b.content}\n</tool_use_error> \n`; delete resultEntry(e, 'workflow').toolUseResult; });
  assert.equal(phaseAnalyze('spawn-check', dir).results[0].result, 'pass');
  assert.equal(getCheck('spawn-check').cell(), "refused at the spawn with the parser's message; a valid header runs");
});

for (const [label, result] of [
  ['valid header result', { status: 0, stdout: 'ok\n', stderr: '' }],
  ['usage error', { status: 1, stdout: '', stderr: 'Unknown command' }],
  ['empty parser message', { status: 1, stdout: 'error: \n', stderr: '' }],
  ['blank parser message', { status: 1, stdout: 'error:   \n', stderr: '' }],
  ['process failure', { error: new Error('timeout'), status: null, stdout: '' }]
]) {
  test(`spawn-check fails when check-header returns ${label}`, () => {
    const row = getCheck('spawn-check').analyze(phaseInput(path.join(fixture, 'spawn-check')), { checkHeaderRunner: () => result }).results[0];
    assert.equal(row.result, 'fail'); assert.match(row.reason, /check-header did not refuse/);
  });
}

test('spawn-check runs the real repository check-header for all bad and good prompts', t => {
  const first = checkHeader(badPrompts.codex);
  if (/Unknown command.*check-header/i.test(first.stderr ?? '')) {
    t.skip('companion check-header does not exist yet; the injected runner covers analysis.'); return;
  }
  for (const backend of BACKENDS) {
    assert.equal(expectedMessage(badPrompts[backend]), parserMessages[backend]);
    const good = checkHeader(goodPrompt(backend));
    assert.equal(good.status, 0, good.stderr); assert.equal(good.stdout, 'ok\n'); assert.equal(good.stderr, '');
  }
  assert.equal(getCheck('spawn-check').analyze(phaseInput(path.join(fixture, 'spawn-check'))).results[0].result, 'pass');
});

function allSpawnBackends(t) {
  const dir = copy(t, 'spawn-check');
  const original = readTranscript(path.join(dir, 'transcript.jsonl'));
  const entries = [original[0]], journal = [], result = {};
  for (const backend of BACKENDS) {
    const job = read(path.join(dir, phaseJob));
    job.id = `${backend}-job`; job.request = { backend, model: MODELS[backend] };
    job.relay = { ...job.relay, agentId: `agent-${backend}`, label: `spawn-good-${backend}`,
      transcriptPath: `../transcript/subagents/workflows/wf-synthetic/agent-${backend}.jsonl` };
    write(path.join(dir, `jobs/repo/${backend}-job/job.json`), job);
    fs.writeFileSync(path.join(dir, `jobs/repo/${backend}-job/report.md`), `Spawn check ok for ${backend}.\n`);
    entries.push(callEntry(`bad-${backend}`, 'Agent', { subagent_type: 'relay:job', name: `spawn-bad-${backend}`, prompt: badPrompts[backend] }, at('00:01.000')),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `bad-${backend}`, is_error: true, content: `Subagent spawn denied by a plugin: ${parserMessages[backend]}` }] } });
    journal.push({ type: 'failed', key: `bad-${backend}`, agentId: '' }, { type: 'started', key: `good-${backend}`, agentId: `agent-${backend}`, label: `spawn-good-${backend}` });
    result[backend] = { bad: { error: `Workflow agent spawn denied by a plugin: ${parserMessages[backend]}` }, good: `state: completed\njob: ${backend}-job\ndir: repo/${backend}-job` };
  }
  entries.push(callEntry('workflow', 'Workflow', { script: spawnScript(BACKENDS) }, at('00:05.000')), original[4], original[5]);
  lines(path.join(dir, 'transcript.jsonl'), entries); lines(path.join(dir, phaseJournal), journal);
  write(path.join(dir, phaseWorkflow), { runId: 'wf-synthetic', result });
  return dir;
}

test('spawn-check counts unlabeled failed entries across all four backends', t => {
  const dir = allSpawnBackends(t);
  assert.deepEqual(phaseAnalyze('spawn-check', dir, BACKENDS).results.map(r => r.reason), BACKENDS.map(() => null));
  changeEntries(dir, e => { e.splice(0, 1); }, phaseJournal);
  assert.ok(phaseAnalyze('spawn-check', dir, BACKENDS).results.every(r => r.result === 'fail'));
});

function sessionDriver(t, failure) {
  const dir = copy(t, 'session-end'), run = { ...read(path.join(dir, 'run.json')), backends: ['codex'], surface: 'terminal',
    relayVersion: '3.0.0-test', transcript: path.join(dir, 'transcript.jsonl'), sessionId: 'fake-session' };
  delete run.sessionEndedAt; delete run.afterEnd; delete run.claudePid;
  let clock = Date.parse(at('00:29.000')), saves = [], polls = 0, statusCalls = 0, paneCalls = 0, stopped = false;
  const identity = { pid: 12345, startedAt: 'Thu Oct 22 10:00:00 2026' };
  const ctx = { runId: run.runId, backends: run.backends, run, evidenceDir: dir, jobsHome: path.join(dir, 'jobs'), pluginDir: '/tmp/fake-plugin',
    keep: true, save() { saves.push(structuredClone(run)); write(path.join(dir, 'run.json'), run); },
    async paneDriver(input, check, options) {
      paneCalls++; assert.equal(input, ctx); assert.equal(check.id, 'session-end'); assert.equal(options.keep, false); assert.equal(typeof options.drive, 'function');
      assert.equal(check.completed(readTranscript(run.transcript)), true);
      if (failure === 'missing marker') changeEntries(dir, e => e.slice(0, -1));
      if (failure === 'pane timeout') throw new Error('Timed out waiting for marker.');
      if (failure !== 'no pid recorded') options.drive(['stop', 'fake-pane']);
    } };
  const dependencies = { now: () => clock, sleep: async ms => { clock += ms; },
    drive(args) {
      assert.equal(args[1], 'fake-pane');
      if (args[0] === 'pid') { assert.equal(stopped, false); return failure === 'missing pid' ? '' : '12345\n'; }
      assert.equal(args[0], 'stop');
      if (!['missing pid', 'missing start time'].includes(failure)) {
        assert.deepEqual(run.claudePid, identity);
        assert.deepEqual(saves.at(-1).claudePid, identity);
      }
      stopped = true;
    },
    processRunner({ pid, timeoutMs }) {
      assert.equal(pid, identity.pid); assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
      assert.equal(run.sessionEndedAt, undefined);
      if (!stopped) return failure === 'missing start time' ? '' : identity.startedAt;
      polls++;
      return failure === 'process timeout' || polls <= 4 ? identity.startedAt :
        failure === 'pid reused' ? 'Thu Oct 22 10:00:30 2026' : '';
    },
    companionRunner: async (input, args) => {
      assert.equal(input, ctx); assert.equal(args[0], 'status'); assert.equal(args[1], path.join(dir, 'jobs/repo/codex-job')); assert.equal(args[2], '--json');
      assert.ok(clock - Date.parse(run.sessionEndedAt) >= 20000);
      assert.ok(saves.some(saved => saved.sessionEndedAt)); statusCalls++;
      if (statusCalls === 1 || failure === 'job timeout') return JSON.stringify({ state: 'running' });
      if (statusCalls === 2) return JSON.stringify({ state: 'running' });
      clock = Date.parse(at('02:40.000'));
      return JSON.stringify({ state: 'completed' });
    } };
  return { ctx, dependencies, state: () => ({ saves, polls, statusCalls, paneCalls, stopped }) };
}

test('session-end runTerminal records pid before stop, closes even under keep, waits for process exit, saves observations, waits for jobs and analyzes', async t => {
  const { ctx, dependencies, state } = sessionDriver(t);
  const result = await getCheck('session-end').runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass', result.results[0].reason);
  assert.equal(ctx.run.sessionEndedAt, at('00:30.000'));
  assert.deepEqual(ctx.run.afterEnd, { 'agent-codex': { at: at('00:50.000'), state: 'running' } });
  assert.ok(Date.parse(ctx.run.checkFinishedAt) >= Date.parse(ctx.run.afterEnd['agent-codex'].at));
  assert.equal(state().paneCalls, 1); assert.equal(state().polls, 5); assert.equal(state().statusCalls, 3);
  assert.ok(state().saves.some(saved => saved.afterEnd?.['agent-codex']?.state === 'running'));
  assert.deepEqual(read(path.join(ctx.evidenceDir, 'run.json')), ctx.run);
});
for (const [failure, message] of [
  ['missing marker', /Session ended without LIVE-SESSION-END-READY/], ['pane timeout', /Timed out waiting for marker/],
  ['missing pid', /Missing Claude pane pid/], ['no pid recorded', /Missing Claude pane pid/],
  ['missing start time', /Missing Claude process start time/],
  ['process timeout', /Timed out waiting for the Claude process/], ['job timeout', /Timed out waiting for jobs/]
]) {
  test(`session-end runTerminal saves and throws on ${failure}`, async t => {
    const { ctx, dependencies, state } = sessionDriver(t, failure);
    const listeners = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listeners(signal));
    await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), message);
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listeners(signal)), listeners);
    if (failure === 'missing pid' || failure === 'missing start time') assert.equal(state().stopped, true);
    assert.match(state().saves.at(-1).error, message);
    assert.deepEqual(read(path.join(ctx.evidenceDir, 'run.json')), ctx.run);
    if (failure === 'job timeout') assert.equal(ctx.run.afterEnd['agent-codex'].state, 'running');
    else assert.equal(ctx.run.sessionEndedAt, undefined);
  });
}

for (const name of ['stop', 'session-end', 'spawn-check']) {
  test(`${name} analysis replays from a copy after original evidence is removed`, t => {
    const dir = copy(t, name), destination = temp(t), backends = name === 'stop' ? ['codex', 'kimi'] : ['codex'];
    const run = { ...(name === 'session-end' ? read(path.join(dir, 'run.json')) : {}), runId: 'synthetic-run', jobsHome: path.join(dir, 'jobs'), transcript: path.join(dir, 'transcript.jsonl') };
    if (name === 'spawn-check') edit(dir, phaseWorkflow, r => { r.result.codex.good = r.result.codex.good.replace('repo/codex-job', path.join(dir, 'jobs/repo/codex-job')); });
    const before = phaseAnalyze(name, dir, backends);
    assert.ok(before.results.every(r => r.result === 'pass'));
    run.copy = copyEvidence(run, before, destination);
    write(path.join(destination, 'run.json'), run);
    fs.rmSync(dir, { recursive: true });
    const after = getCheck(name).analyze({ ...phaseInput(destination, backends), transcript: run.copy.transcript, jobsHome: run.copy.jobsHome }, { checkHeaderRunner: fakeHeader });
    assert.deepEqual(after.results, before.results);
  });
}

for (const failure of ['meta file with bad name', 'extra job of this session', 'extra job without a transcript file']) {
  test(`spawn-check copy preserves failure evidence for ${failure}`, t => {
    const dir = copy(t, 'spawn-check'), destination = temp(t);
    if (failure === 'extra job without a transcript file') {
      extraSpawnJob(dir);
      edit(dir, 'jobs/repo/extra-job/job.json', job => { job.relay.transcriptPath = '../transcript/subagents/agent-missing.jsonl'; });
    } else spawnMutations.find(([label]) => label === failure)[1](dir);
    const before = phaseAnalyze('spawn-check', dir);
    const run = { runId: 'synthetic-run', jobsHome: path.join(dir, 'jobs'), transcript: path.join(dir, 'transcript.jsonl') };
    run.copy = copyEvidence(run, before, destination); write(path.join(destination, 'run.json'), run);
    fs.rmSync(dir, { recursive: true });
    const after = getCheck('spawn-check').analyze({ ...phaseInput(destination), transcript: run.copy.transcript, jobsHome: run.copy.jobsHome }, { checkHeaderRunner: fakeHeader });
    assert.equal(after.results[0].result, 'fail'); assert.equal(after.results[0].reason, before.results[0].reason);
  });
}

test('spawn-check accepts the Workflow script with a trailing newline, as a lead copied it live', t => {
  const dir = copy(t, 'spawn-check');
  changeEntries(dir, e => { callBlock(e, 'workflow').input.script += '\n'; });
  assert.equal(phaseAnalyze('spawn-check', dir).results[0].result, 'pass');
});

test('stop accepts cancellation and cancel posting at the exact TaskStop timestamp', t => {
  const dir = copy(t, 'stop');
  edit(dir, phaseJob, j => { j.completedAt = at('00:30.000'); j.attempts[0].endedAt = at('00:30.000'); });
  edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.createdAt = at('00:30.000'); });
  assert.deepEqual(phaseAnalyze('stop', dir).results[0].timings, { cancelledSeconds: [0] });
  assert.equal(phaseAnalyze('stop', dir).results[0].result, 'pass');
});

test('session-end rejects a second relay for the backend', t => {
  const dir = copy(t, 'session-end');
  changeEntries(dir, entries => {
    const call = structuredClone(entries[1]), result = structuredClone(entries[2]);
    call.message.content[0].id = 'second'; result.message.content[0].tool_use_id = 'second';
    entries.push(call, result);
  });
  assert.match(phaseAnalyze('session-end', dir).results[0].reason, /one relay/);
});

for (const name of ['stop', 'session-end', 'spawn-check']) {
  for (const field of ['backend', 'model']) {
    test(`${name} rejects a job with another ${field}`, t => {
      const dir = copy(t, name);
      edit(dir, phaseJob, job => { job.request[field] = field === 'backend' ? 'kimi' : MODELS.kimi; });
      const result = phaseAnalyze(name, dir).results[0];
      assert.equal(result.result, 'fail');
      assert.match(result.reason, new RegExp(`Job ${field}`));
    });
  }
}

test('stop accepts cancel posting at the hook attachment timestamp', t => {
  const dir = copy(t, 'stop');
  edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.createdAt = at('00:31.000'); });
  assert.equal(phaseAnalyze('stop', dir).results[0].result, 'pass');
});

for (const command of [
  "printf '%s\\n' 'node /plugin/scripts/companion.mjs cancel codex-job'",
  'node /plugin/scripts/companion.mjs status cancel-job --json'
]) {
  test(`stop accepts Bash text without a second cancel message: ${command}`, t => {
    const dir = copy(t, 'stop');
    changeEntries(dir, entries => { entries.push(callEntry('printed-cancel', 'Bash', { command }, at('00:30.100'))); });
    assert.equal(phaseAnalyze('stop', dir).results[0].result, 'pass');
  });
}

test('session-end accepts a lead entry at sessionEndedAt and ignores later sidechain entries', t => {
  const dir = copy(t, 'session-end');
  changeEntries(dir, entries => {
    entries.push(textEntry('assistant', 'Ended.', at('00:30.000')),
      textEntry('assistant', 'Sidechain.', at('00:31.000'), { isSidechain: true }));
  });
  assert.equal(phaseAnalyze('session-end', dir).results[0].result, 'pass');
});

test('session-end runTerminal accepts a reused pid with a different start time and removes handlers', async t => {
  const { ctx, dependencies } = sessionDriver(t, 'pid reused');
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], listeners = signals.map(signal => process.listeners(signal));
  const result = await getCheck('session-end').runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass', result.results[0].reason);
  assert.equal(ctx.run.sessionEndedAt, at('00:30.000'));
  assert.deepEqual(signals.map(signal => process.listeners(signal)), listeners);
});

for (const stage of ['pane pid', 'process start time']) {
  for (const driverFails of [false, true]) {
    test(`session-end records a failed ${stage} read and stops the pane${driverFails ? ' without hiding the driver error' : ''}`, async t => {
      const { ctx, dependencies } = sessionDriver(t);
      const pidError = new Error(`${stage} read failed.`), driverError = new Error('Session startup failed.');
      let stopped = false;
      dependencies.drive = args => {
        if (args[0] === 'pid') {
          if (stage === 'pane pid') throw pidError;
          return '12345';
        }
        assert.equal(args[0], 'stop');
        assert.equal(ctx.run.claudePidError, pidError.message);
        stopped = true;
      };
      dependencies.processRunner = () => { throw pidError; };
      ctx.paneDriver = async (input, check, { drive }) => {
        try { if (driverFails) throw driverError; }
        finally { drive(['stop', 'fake-pane']); }
      };
      await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), error => {
        if (driverFails) assert.equal(error, driverError);
        else {
          assert.match(error.message, /Missing Claude pane pid and start time/);
          assert.ok(error.message.includes(pidError.message));
        }
        return true;
      });
      assert.equal(stopped, true);
      assert.equal(ctx.run.claudePid, undefined);
      assert.equal(ctx.run.claudePidError, pidError.message);
      assert.deepEqual(read(path.join(ctx.evidenceDir, 'run.json')), ctx.run);
    });
  }
}

for (const kind of ['Promise', 'thenable']) {
  test(`session-end rejects a ${kind} from processRunner in the synchronous stop wrapper`, async t => {
    const { ctx, dependencies, state } = sessionDriver(t, 'missing start time');
    dependencies.processRunner = () => kind === 'Promise' ? Promise.resolve('start time') : { then() {} };
    await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), /processRunner must be synchronous in the stop wrapper/);
    assert.equal(state().stopped, true);
    assert.equal(ctx.run.claudePid, undefined);
    assert.equal(ctx.run.sessionEndedAt, undefined);
    assert.match(ctx.run.claudePidError, /must be synchronous/);
    assert.deepEqual(read(path.join(ctx.evidenceDir, 'run.json')), ctx.run);
  });
}

test('session-end awaits an asynchronous processRunner in the process wait loop', async t => {
  const { ctx, dependencies, state } = sessionDriver(t);
  const runner = dependencies.processRunner;
  dependencies.processRunner = args => state().stopped ? Promise.resolve(runner(args)) : runner(args);
  const result = await getCheck('session-end').runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass', result.results[0].reason);
  assert.equal(state().polls, 5);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']) {
  for (const stage of ['process wait', 'status call']) {
    test(`session-end classifies a child ${signal} during ${stage} before its signal handler runs`, async t => {
      const { ctx, dependencies, state } = sessionDriver(t);
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], listeners = signals.map(name => process.listeners(name));
      const childError = Object.assign(new Error('Child command failed.'), { signal, status: null });
      if (stage === 'process wait') {
        const runner = dependencies.processRunner;
        dependencies.processRunner = args => {
          if (state().stopped) throw childError;
          return runner(args);
        };
      } else dependencies.companionRunner = () => { throw childError; };
      await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), error => {
        if (signal === 'SIGKILL') assert.equal(error, childError);
        else assert.equal(error.message, 'Interrupted.');
        return true;
      });
      assert.equal(Boolean(ctx.run.interrupted), signal !== 'SIGKILL');
      assert.deepEqual(read(path.join(ctx.evidenceDir, 'run.json')), ctx.run);
      assert.deepEqual(signals.map(name => process.listeners(name)), listeners);
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  for (const stage of ['process wait', 'observation delay', 'job wait']) {
    test(`session-end runTerminal handles ${signal} during ${stage} after pane close and removes handlers`, async t => {
      const { ctx, dependencies, state } = sessionDriver(t);
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], listeners = signals.map(name => process.listeners(name));
      const sleep = dependencies.sleep;
      let signalled = false;
      dependencies.sleep = async ms => {
        const ready = stage === 'process wait' ? !ctx.run.sessionEndedAt :
          stage === 'observation delay' ? ctx.run.sessionEndedAt && !ctx.run.afterEnd : state().statusCalls >= 2;
        if (ready && !signalled) {
          assert.equal(state().stopped, true);
          signalled = true; process.emit(signal);
        }
        await sleep(ms);
      };
      await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), { message: 'Interrupted.' });
      assert.equal(signalled, true);
      assert.equal(ctx.run.interrupted, true);
      assert.equal(read(path.join(ctx.evidenceDir, 'run.json')).interrupted, true);
      assert.deepEqual(signals.map(name => process.listeners(name)), listeners);
    });
  }
}

for (const artifact of ['job', 'meta file']) {
  for (const boundary of ['before run', 'at run start', 'inside run', 'at next run', 'after next run']) {
    test(`spawn-check scopes an earlier session's ${artifact}: ${boundary}`, t => {
      const dir = copy(t, 'spawn-check');
      changeEntries(dir, entries => {
        entries.unshift(textEntry('user', 'Live suite run earlier-run.', '2026-10-22T09:59:00.000Z'));
        entries.push(textEntry('user', 'Live suite run next-run.', at('01:00.000')));
      });
      const when = { 'before run': '2026-10-22T09:59:59.999Z', 'at run start': at('00:00.000'),
        'inside run': at('00:10.000'), 'at next run': at('01:00.000'), 'after next run': at('01:00.001') }[boundary];
      if (artifact === 'job') {
        extraSpawnJob(dir);
        edit(dir, 'jobs/repo/extra-job/job.json', job => { job.createdAt = when; job.relay.workflowRunId = 'wf-earlier'; });
      } else {
        const file = path.join(dir, 'transcript/subagents/agent-earlier.meta.json');
        write(file, { name: 'spawn-bad-codex' });
        fs.utimesSync(file, new Date(when), new Date(when));
      }
      const result = phaseAnalyze('spawn-check', dir).results[0];
      if (boundary === 'at run start' || boundary === 'inside run') {
        assert.equal(result.result, 'fail'); assert.match(result.reason, artifact === 'job' ? /extra job/ : /meta file/);
      } else assert.equal(result.result, 'pass', result.reason);
    });
  }
}


test('session-end runTerminal reports Interrupted when a signalled process read rejects', async t => {
  const { ctx, dependencies, state } = sessionDriver(t);
  const processRunner = dependencies.processRunner;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], listeners = signals.map(signal => process.listeners(signal));
  dependencies.processRunner = options => {
    if (!state().stopped) return processRunner(options);
    process.emit('SIGTERM');
    throw new Error('Process read interrupted.');
  };
  await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), { message: 'Interrupted.' });
  assert.equal(ctx.run.interrupted, true);
  assert.deepEqual(signals.map(signal => process.listeners(signal)), listeners);
});

function commandSource(shape) {
  return readTranscript(path.join(fixture, 'commands', `${shape === 'terminal' ? 'terminal-commands' : shape + '-status'}-transcript.jsonl`));
}

function moduleAnswer(stdout, report = null, command = '/relay:status') {
  const lines = stdout.split('\n'), split = lines.findIndex(line => line === '---' || line.startsWith('|'));
  const verbatim = (split < 0 ? stdout : lines.slice(0, split).join('\n')).replace(/(?:\n[ \t]*)+$/, '') + '\n';
  const tail = split < 0 ? (report === null ? '' : '---\n' + report) : lines.slice(split).join('\n');
  const longest = Math.max(2, ...(verbatim.match(/`+/g) ?? []).map(value => value.length));
  const fence = '`'.repeat(longest + 1);
  return `relay: ${command}\n${fence}text\n${verbatim}${fence}\n${tail}`;
}

function commandEntries(shape, text, answer, index = 0) {
  const source = structuredClone(commandSource(shape).filter(entry => ['queue-operation', 'user', 'system'].includes(entry.type)).slice(0, shape === 'terminal' ? 2 : 5));
  const command = text.slice(1).split(' ')[0], args = ''; // Measured plugin-answered inputs lose their arguments.
  const stamp = seconds => new Date(Date.parse('2026-10-22T12:00:00Z') + (index * 10 + seconds) * 1000).toISOString();
  for (const entry of source) {
    entry.timestamp = stamp(entry.type === 'queue-operation' ? 0 : 2);
    if (entry.type === 'queue-operation') continue;
    entry.entrypoint = shape === 'terminal' ? 'cli' : shape === 'p' ? 'sdk-cli' : 'sdk-ts';
    if (entry.commandRun) {
      entry.commandRun = { command, args, plugin: 'relay' };
      entry.content = `<local-command-stdout>${answer}</local-command-stdout>`;
    } else {
      const holder = entry.type === 'user' ? entry.message : entry;
      if (holder.content.startsWith('<command-name>')) holder.content = `<command-name>/${command}</command-name>\n            <command-message>${command}</command-message>\n            <command-args>${args}</command-args>`;
    }
  }
  return source;
}

function statusText(backends, state = 'running') {
  const header = '| job | state | kind | backend | model/effort | duration | summary | relay |\n|---|---|---|---|---|---|---|---|\n';
  return `relay-version: 3.0.0-test\njobs: ${backends.length * 2 + 2}\n\n` + header + backends.flatMap(backend => [
    `| done-${backend} | completed | task | ${backend} | ${MODELS[backend]}/low | 2s | done | |`,
    `| running-${backend} | ${state} | task | ${backend} | ${MODELS[backend]}/low | ? | sleep | |`
  ]).join('\n') + '\n' +
    `| decoy-done | completed | task | ${backends[0]} | ${MODELS[backends[0]]}/low | 1s | decoy | |\n` +
    `| decoy-running | running | task | ${backends[0]} | ${MODELS[backends[0]]}/low | ? | sleep | |\n`;
}

function commandsFixture(t, name = 'commands', surface = 'terminal', backends = ['codex']) {
  const dir = temp(t), check = getCheck(name), runId = `20261022T120000Z-${name}-${surface}-abcd`;
  const run = { runId, check: name, surface, backends, relayVersion: '3.0.0-test', relayCommit: '0123456789ab', preparedAt: '2026-10-22T11:59:00Z',
    pluginDir: path.join(dir, 'build'), workDir: path.join(dir, 'work'), jobsHome: path.join(dir, 'jobs'), setup: { jobs: {}, decoys: {} } };
  fs.mkdirSync(run.jobsHome, { recursive: true });
  if (name !== 'transfer') for (const backend of backends) {
    run.setup.jobs[backend] = {};
    for (const kind of name === 'commands' ? ['done', 'running'] : ['done']) {
      const id = `${kind}-${backend}`, jobDir = `repo/${id}`;
      run.setup.jobs[backend][kind] = { id, jobDir };
      write(path.join(run.jobsHome, jobDir, 'job.json'), { id, state: kind === 'done' ? 'completed' : 'cancelled',
        request: { backend, model: MODELS[backend] }, attempts: [{ attempt: 1, relayVersion: run.relayVersion }] });
      fs.writeFileSync(path.join(run.jobsHome, jobDir, 'report.md'), `# Done\ndone for ${backend}.\n`);
    }
  }
  if (name !== 'transfer') for (const kind of ['done', 'running']) {
    const id = `decoy-${kind}`, jobDir = `repo/${id}`;
    run.setup.decoys[kind] = { id, jobDir };
    write(path.join(run.jobsHome, jobDir, 'job.json'), { id, state: kind === 'done' ? 'completed' : 'running',
      request: { backend: backends[0], model: MODELS[backends[0]] }, attempts: [{ relayVersion: run.relayVersion }] });
  }
  const plan = name === 'headless' ? headlessCommands(run) : check.commands(run);
  const answer = (command, index) => {
    if (command.text === '/relay:transfer') return moduleAnswer('Codex session ID: abc-123\nResume in Codex: codex resume abc-123\n', null, command.text);
    if (command.text === '/relay:status') return moduleAnswer(statusText(backends, index === 0 ? 'running' : 'cancelled')
      .replace('relay-version: 3.0.0-test', `relay-version: 3.0.0-test${surface === 't3' ? ` (${run.relayCommit})` : ''}`));
    if (command.text.startsWith('/relay:cancel')) return moduleAnswer(`state: cancelled\njob: running-${command.backend}\n`, null, command.text);
    if (command.running) return moduleAnswer(`state: running\njob: ${run.setup.decoys.running.id}\n`, null, command.text);
    return moduleAnswer(`state: completed\njob: done-${command.backend}\n`, `# Done\ndone for ${command.backend}.\n`, command.text);
  };
  if (name === 'headless') {
    run.headless = plan.map((command, index) => {
      const transcript = path.join(dir, `session-${index}.jsonl`), stream = path.join(dir, `stream-${index}.jsonl`);
      const rows = commandEntries('p', command.text, answer(command, index), index);
      const sessionId = rows.find(entry => entry.sessionId).sessionId;
      lines(transcript, rows);
      const events = readTranscript(path.join(fixture, 'commands/p-status-stream.jsonl'));
      events.find(event => event.type === 'assistant').message.content[0].text = answer(command, index);
      events.find(event => event.subtype === 'init').plugins = [{ name: 'relay', path: run.pluginDir }];
      const result = events.find(event => event.type === 'result');
      Object.assign(result, { result: answer(command, index), session_id: sessionId, duration_ms: 250 + 100 * index });
      lines(stream, events);
      return { ...command, sessionId, transcript, stream, exitCode: command.running ? 4 : 0, finished: true };
    });
    run.transcript = run.headless[0].transcript;
  } else {
    const rows = [textEntry('user', `Live suite run ${runId}.`, '2026-10-22T11:59:00Z', { entrypoint: surface === 't3' ? 'sdk-ts' : 'cli', version: '2.1.308' }),
      textEntry('assistant', check.marker, '2026-10-22T11:59:02Z', { message: { model: 'sonnet', content: [{ type: 'text', text: check.marker }] } })];
    plan.forEach((command, index) => rows.push(...commandEntries(surface === 't3' ? 't3' : 'terminal', command.text, answer(command, index), index)));
    run.transcript = path.join(dir, 'transcript.jsonl');
    lines(run.transcript, rows);
    if (surface === 'terminal') run.commands = plan.map((command, index) => ({ text: command.text,
      sentAt: new Date(Date.parse('2026-10-22T12:00:00Z') + index * 10000).toISOString() }));
  }
  const env = { CODEX_HOME: path.join(dir, 'codex') };
  if (name === 'transfer') write(path.join(env.CODEX_HOME, 'external_agent_session_imports.json'), { records: [
    { imported_thread_id: 'abc-123', source_path: fs.realpathSync(run.transcript), imported_at: Date.parse('2026-10-22T12:00:11Z') / 1000 }
  ] });
  return { dir, run, check, env, input: { ...run, run, evidenceDir: dir, env } };
}

for (const shape of ['terminal', 't3', 'p']) {
  test(`command readers invert the measured ${shape} transcript shape`, () => {
    const entries = commandSource(shape), rows = commandRuns(entries);
    assert.equal(rows.length, 1, 'the model Skill call is not a slash command');
    const row = rows[0];
    assert.equal(row.command, 'relay:status');
    assert.equal(row.args, '');
    assert.equal(row.plugin, 'relay');
    assert.equal(row.noModelReply, true);
    assert.equal(noModelReply(entries, row), true);
    assert.equal(row.answeredAt, row.answer.timestamp);
    assert.equal(row.startedAt, shape === 'terminal' ? null : entries[0].timestamp);
    assert.equal(row.seconds, shape === 'terminal' ? null : shape === 't3' ? 0.14 : 0.816);
    assert.deepEqual(statusRows(moduleText(row.text).table).map(row => [row.job, row.state]),
      [['done-codex', 'completed'], ['running-codex', 'running']]);
    assert.equal(moduleText(row.text).report, null);
    assert.equal(row.input.type, shape === 'terminal' ? 'system' : 'user');
    if (shape === 'terminal') assert.ok(entries.some(entry => entry.message?.content?.some?.(block => block.name === 'Skill')));
  });
}

test('moduleText inverts contract examples, preserves reports and rejects prose and error text', () => {
  for (const prefix of ['', 'relay: ']) {
    assert.deepEqual(moduleText(prefix + '/relay:result j-1\n```text\nstate: completed\njob: j-1\n```\n---\n# Done\n'),
      { command: '/relay:result j-1', table: null, verbatim: 'state: completed\njob: j-1\n', report: '# Done\n' });
    assert.deepEqual(moduleText(prefix + '/relay:result j-1\n```text\nJob j-1 is busy: … Try again.\n```\n'),
      { command: '/relay:result j-1', table: null, verbatim: 'Job j-1 is busy: … Try again.\n', report: null });
    assert.deepEqual(moduleText(prefix + '/relay:result j-1\n````text\nsummary: use ``` fences\n````\n'),
      { command: '/relay:result j-1', table: null, verbatim: 'summary: use ``` fences\n', report: null });
    assert.deepEqual(moduleText(prefix + '/relay:result j-1\n```text\nstate: completed\n```\n---\n'), { command: '/relay:result j-1', table: null, verbatim: 'state: completed\n', report: '' });
  }
  for (const text of [null, 'The job has completed.', 'relay: \n/relay:result printed nothing (exit 0). Run `node <root>/scripts/companion.mjs result` in a shell to see its output.',
    'relay: ```text\nstate: completed\n```\n', '\n```text\nx\n````\n', '\n```text\nx ```\n```\n', '\n```text\nx\n```\nmodel prose']) assert.equal(moduleText(text), null);
});

test('statusRows reads padded Unicode and escaped pipes, and rejects missing separators', () => {
  assert.deepEqual(statusRows('jobs: 1\n\n| job | state | summary | relay |\n|-----|-------|---------|-------|\n| j-1 | running (stalled) | 你好 \\| x | |\n'),
    [{ job: 'j-1', state: 'running (stalled)', summary: '你好 | x', relay: '' }]);
  for (const text of ['No jobs.', '| job | state |\n| j-1 | running |\n', '| job | state |\n|---|\n']) assert.deepEqual(statusRows(text), []);
});

test('timing uses sentAt first, otherwise the latest enqueue since the previous answer', () => {
  const a = commandEntries('t3', '/relay:status', moduleAnswer('No jobs.\n'));
  a.splice(1, 0, { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-22T12:00:01Z' });
  const b = commandEntries('t3', '/relay:status', moduleAnswer('No jobs.\n'), 1).filter(entry => entry.type !== 'queue-operation');
  assert.deepEqual(commandRuns([...a, ...b]).map(row => row.seconds), [1, null]);
  assert.deepEqual(commandRuns([...a, ...b], { commands: [{ sentAt: '2026-10-22T12:00:00Z' }, { sentAt: '2026-10-22T12:00:10Z' }] }).map(row => row.seconds), [2, 2]);
  // Claude Code records a plugin-answered command without its arguments, so only the name pairs.
  const noArgs = structuredClone(a);
  noArgs.at(-1).commandRun.args = '';
  assert.notEqual(commandRuns(noArgs)[0].answer, null);
  const mismatch = structuredClone(a);
  mismatch.at(-1).commandRun.command = 'relay:result';
  assert.equal(commandRuns(mismatch)[0].answer, null);
  const later = [...mismatch, ...b];
  assert.equal(commandRuns(later)[0].answer, null, 'a later command cannot supply the missing answer');
});

for (const shape of ['terminal', 't3', 'p']) {
  test(`no-model-reply boundaries on ${shape}`, () => {
    const entries = commandEntries(shape, '/relay:status', moduleAnswer('No jobs.\n'));
    const model = { type: 'assistant', message: { model: 'sonnet', content: [{ type: 'text', text: 'Here are your jobs.' }] } };
    assert.equal(commandRuns([...entries, model])[0].noModelReply, false);
    assert.equal(commandRuns([...entries.slice(0, -1), model, entries.at(-1)])[0].noModelReply, false);
    assert.equal(commandRuns([...entries, { ...model, message: { ...model.message, model: '<synthetic>' } }])[0].noModelReply, true);
    assert.equal(commandRuns([...entries, { ...model, isSidechain: true }])[0].noModelReply, true);
    for (const boundary of [textEntry('user', 'A new prompt.'), textEntry('user', '<task-notification>finished</task-notification>', null, { isMeta: true }),
      { type: 'attachment', attachment: { type: 'task_notification' } }]) {
      assert.equal(commandRuns([...entries, boundary, model])[0].noModelReply, true);
    }
    const foreign = structuredClone(entries); foreign.at(-1).commandRun.plugin = 'other';
    assert.equal(commandRuns(foreign)[0].noModelReply, false);
    assert.equal(commandRuns(entries.slice(0, -1))[0].noModelReply, false);
  });
}

for (const [name, surfaces] of [['commands', ['terminal', 't3']], ['transfer', ['terminal', 't3']], ['headless', ['terminal']]]) {
  for (const surface of surfaces) {
    test(`${name} passes on ${surface}, has one record per backend and replays from evidence copies`, t => {
      const ctx = commandsFixture(t, name, surface, name === 'transfer' ? ['codex'] : BACKENDS);
      const analysis = ctx.check.analyze(ctx.input);
      assert.deepEqual(analysis.results.map(row => row.result), ctx.run.backends.map(() => 'pass'), JSON.stringify(analysis.results));
      assert.ok(analysis.results.every(row => row.delivery === null));
      assert.equal(analysis.evidence.agents.length, name === 'transfer' ? 0 : ctx.run.backends.length * (name === 'commands' ? 2 : 1) + 2);
      const recordsDir = path.join(ctx.dir, 'records'), evidenceDir = path.join(ctx.dir, 'evidence');
      fs.mkdirSync(evidenceDir);
      const first = analyzeRun(ctx.run, evidenceDir, [ctx.check], evidenceReaders, { recordsDir, env: ctx.env });
      assert.ok(first.records.every(row => row.result === 'pass'), JSON.stringify(first.records));
      assert.equal(first.records.length, ctx.run.backends.length);
      assert.doesNotMatch(JSON.stringify(first.records), /\/tmp\/|\/home\//);
      for (const source of [ctx.run.jobsHome, ctx.run.transcript, ...(ctx.run.headless ?? []).flatMap(row => [row.transcript, row.stream])]) fs.rmSync(source, { recursive: true, force: true });
      const replay = analyzeRun(ctx.run, evidenceDir, [ctx.check], evidenceReaders, { recordsDir, fromCopy: true });
      assert.deepEqual(replay.records, first.records);
      assert.equal(ctx.check.cell(first.records[0]), name === 'commands' ? 'no model turn; answered in 2.0 s, cancelled in 2.0 s' :
        name === 'transfer' ? 'no model turn; imported in 2.0 s' : 'num_turns 0; answered in 0.3–0.8 s');
    });
  }
}

for (const name of ['commands', 'transfer', 'headless']) {
  for (const failure of ['missing answer', 'model reply', 'missing start time', ...(name === 'transfer' ? ['wrong session'] : ['wrong state', 'different report', 'version mismatch'])]) {
    test(`${name} fails for ${failure}`, t => {
      const ctx = commandsFixture(t, name), transcript = ctx.run.transcript;
      const entries = readTranscript(transcript);
      if (failure === 'missing answer') entries.splice(entries.findIndex(entry => entry.commandRun), 1);
      if (failure === 'model reply') entries.splice(entries.findIndex(entry => entry.commandRun) + 1, 0,
        { type: 'assistant', message: { model: 'sonnet', content: [] } });
      if (failure === 'missing start time') {
        delete ctx.run.commands;
        for (const entry of entries) if (entry.operation === 'enqueue') delete entry.timestamp;
      }
      if (failure === 'wrong session') entries.find(entry => entry.commandRun?.command === 'relay:transfer').content = entries.find(entry => entry.commandRun?.command === 'relay:transfer').content.replace('codex resume abc-123', 'codex resume different');
      if (failure === 'wrong state') edit(ctx.dir, 'jobs/repo/done-codex/job.json', job => { job.state = 'running'; });
      if (failure === 'different report') fs.writeFileSync(path.join(ctx.dir, 'jobs/repo/done-codex/report.md'), 'different report');
      if (failure === 'version mismatch') edit(ctx.dir, 'jobs/repo/done-codex/job.json', job => { job.attempts.at(-1).relayVersion = 'other'; });
      lines(transcript, entries);
      const row = ctx.check.analyze(ctx.input).results[0];
      assert.equal(row.result, 'fail');
      assert.match(row.reason, { 'missing answer': /Missing answer/, 'model reply': /Model reply/, 'missing start time': /start time/,
        'wrong state': /state/, 'different report': /report.md/, 'version mismatch': /relayVersion/, 'wrong session': /Codex session/ }[failure]);
    });
  }
}

for (const failure of ['num_turns', 'cost', 'is_error', 'exit', 'entrypoint', 'duration', 'stream model', 'stream text', 'status row', 'receipt']) {
  test(`headless rejects ${failure}`, t => {
    const ctx = commandsFixture(t, 'headless'), receipt = ctx.run.headless[0];
    const events = readTranscript(receipt.stream), result = events.find(event => event.type === 'result');
    if (failure === 'num_turns') result.num_turns = 1;
    if (failure === 'cost') result.total_cost_usd = 0.001;
    if (failure === 'is_error') result.is_error = true;
    if (failure === 'exit') receipt.exitCode = 5;
    if (failure === 'duration') delete result.duration_ms;
    if (failure === 'stream model') events.find(event => event.type === 'assistant').message.model = 'sonnet';
    if (failure === 'stream text') result.result = moduleAnswer('state: running\n');
    if (failure === 'receipt') receipt.finished = false;
    if (failure === 'entrypoint') {
      const entries = readTranscript(receipt.transcript);
      entries.forEach(entry => { if (entry.entrypoint) entry.entrypoint = 'sdk-ts'; });
      lines(receipt.transcript, entries);
    }
    if (failure === 'status row') {
      const status = ctx.run.headless.at(-1), entries = readTranscript(status.transcript), stream = readTranscript(status.stream);
      entries.at(-1).content = entries.at(-1).content.replace('| done-codex | completed |', '| done-codex | running |');
      stream.find(event => event.type === 'result').result = stream.find(event => event.type === 'result').result.replace('| done-codex | completed |', '| done-codex | running |');
      lines(status.transcript, entries); lines(status.stream, stream);
    }
    lines(receipt.stream, events);
    assert.equal(ctx.check.analyze(ctx.input).results[0].result, 'fail');
  });
}

for (const mode of ['success', 'start failure', 'wait failure', 'timeout', 'cancel failure']) {
  test(`setup starts only companion jobs and cancels everything it started on ${mode}`, async t => {
    const dir = temp(t), run = { backends: ['codex', 'grok'] }, calls = [];
    const ctx = { run, backends: run.backends, pluginDir: path.join(dir, 'build'), workDir: path.join(dir, 'work'),
      jobsHome: path.join(dir, 'jobs'), evidenceDir: dir, save() {} };
    let now = 0;
    const execute = async (command, args, options) => {
      calls.push(args);
      assert.equal(command, process.execPath);
      assert.equal(args[0], path.join(ctx.pluginDir, 'scripts/companion.mjs'));
      assert.equal(options.cwd, ctx.workDir);
      assert.equal(options.env.RELAY_JOBS_HOME, ctx.jobsHome);
      assert.equal(options.env.CLAUDECODE, undefined);
      assert.equal(options.env.RELAY_COMPANION_SESSION_ID, undefined);
      if (args[1] === 'cancel') {
        if (mode === 'cancel failure' && args[2] === 'done-codex') throw new Error('Cancel refused.');
        return { stdout: '' };
      }
      assert.deepEqual(args.slice(1, 3), ['start', '--prompt-file']);
      const name = path.basename(args[3], '.txt'), [backend, ...parts] = name.split('-');
      const kind = parts.at(-1), decoy = parts[0] === 'decoy';
      const prompt = fs.readFileSync(args[3], 'utf8');
      assert.ok(prompt.startsWith(`${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\n`));
      assert.ok(prompt.includes(kind === 'done' ? (decoy ? 'Reply with exactly one line: decoy.' : `Reply with exactly one line: done for ${backend}. Do not run any command.`) :
        'Run the shell command `sleep 600` exactly once, and wait for it to finish. Then reply with one line: slept.'));
      const id = `${decoy ? 'decoy-' : ''}${kind}-${backend}`, jobDir = path.join(ctx.jobsHome, 'repo', id);
      write(path.join(jobDir, 'job.json'), { id, state: kind === 'done' ? 'completed' : 'running', attempts: [{}] });
      const stdout = `job: ${id}\nstate: starting\ndir: ${jobDir}\n`;
      if (name === 'grok-done' && ['start failure', 'cancel failure'].includes(mode)) throw Object.assign(new Error('Start failed.'), { stdout });
      if (name === 'grok-done' && ['wait failure', 'timeout'].includes(mode)) write(path.join(jobDir, 'job.json'), { id, state: mode === 'timeout' ? 'starting' : 'failed' });
      return { stdout };
    };
    const action = setupJobs(ctx, true, { execute, env: { PATH: process.env.PATH, CLAUDECODE: '1', RELAY_COMPANION_SESSION_ID: 'parent' }, now: () => now,
      pause: async () => { now += 240001; } });
    if (mode === 'success') await action;
    else await assert.rejects(action, mode.includes('failure') && mode !== 'wait failure' ? /Start failed/ : mode === 'timeout' ? /Timed out/ : /ended failed/);
    if (mode === 'success') {
      assert.equal(calls.filter(args => args[1] === 'cancel').length, 0);
      assert.deepEqual(run.setup.jobs.codex.running, { id: 'running-codex', jobDir: 'repo/running-codex' });
    } else {
      assert.deepEqual(calls.filter(args => args[1] === 'cancel').map(args => args[2]), ['done-codex', 'done-grok']);
      assert.equal(run.setup.cancellations[0].status, mode === 'cancel failure' ? 'failed' : 'cancelled');
    }
  });
}

for (const fail of [false, true]) {
  test(`headless executor records streams, exit codes and all sessions without a pane (failure=${fail})`, async t => {
    const dir = temp(t), check = getCheck('headless');
    const run = { backends: ['codex', 'kimi'], setup: { decoys: { running: { id: 'decoy-running' } }, jobs: { codex: { done: { id: 'done-codex' } }, kimi: { done: { id: 'done-kimi' } } } } };
    const ctx = { run, pluginDir: '/build/relay', workDir: '/work/fixture', jobsHome: '/jobs/fixture', evidenceDir: dir, save() {} };
    const calls = [];
    const env = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_TEST: 'x', RELAY_COMPANION_SESSION_ID: 'parent', KEEP_ME: 'yes' };
    await runHeadless(ctx, { env, uuid: () => `session-${calls.length}`, execute: async (command, args, options) => {
      calls.push(args);
      assert.equal(command, 'claude');
      const planned = headlessCommands(run)[calls.length - 1];
      // The results run as json, whose exit code is the command's; the status as a stream, for its init event.
      assert.equal(planned.format, planned.text === '/relay:status' ? 'stream-json' : 'json');
      assert.deepEqual(args, ['-p', planned.text, ...(planned.format === 'stream-json' ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
        '--plugin-dir', ctx.pluginDir, '--session-id', `session-${calls.length - 1}`, '--model', 'sonnet']);
      assert.deepEqual(options.env, { PATH: '/bin', KEEP_ME: 'yes', RELAY_JOBS_HOME: ctx.jobsHome });
      assert.equal(options.cwd, ctx.workDir);
      assert.equal(options.timeout, 120000);
      const stdout = '{"type":"result","num_turns":0}\n';
      if (fail && calls.length === 1) throw Object.assign(new Error('Exited 5.'), { code: 5, stdout, stderr: 'failed' });
      return { stdout, stderr: '' };
    } });
    assert.equal(check.completed([], run), true);
    assert.equal(calls.length, 4);
    assert.equal(run.headless[0].expectedTranscript, path.join(os.homedir(), '.claude/projects/-work-fixture/session-0.jsonl'));
    assert.equal(run.transcript, path.join(dir, 'headless-0-missing-transcript.jsonl'));
    assert.equal(fs.readFileSync(run.transcript, 'utf8'), '');
    assert.equal(run.headless[0].exitCode, fail ? 5 : 0);
    for (const receipt of run.headless) assert.equal(fs.readFileSync(receipt.stream, 'utf8'), '{"type":"result","num_turns":0}\n');
    assert.deepEqual(run.removedEnvironment, ['CLAUDECODE', 'CLAUDE_AGENT_SDK_TEST', 'CLAUDE_CODE_ENTRYPOINT', 'RELAY_COMPANION_SESSION_ID']);
    assert.equal(env.CLAUDECODE, '1');
    run.headless.pop();
    assert.equal(check.completed([], run), false);
  });
}

for (const name of ['commands', 'headless']) {
  for (const failure of ['version', 'missing report', 'missing stream']) {
    if (name !== 'headless' && failure === 'missing stream') continue;
    test(`${name} retains all job evidence and reproduces ${failure} failures from the copy`, t => {
      const ctx = commandsFixture(t, name, 'terminal', ['codex', 'kimi']);
      if (failure === 'version') edit(ctx.dir, 'jobs/repo/done-codex/job.json', job => { job.attempts.at(-1).relayVersion = 'wrong'; });
      if (failure === 'missing report') fs.rmSync(path.join(ctx.dir, 'jobs/repo/done-codex/report.md'));
      if (failure === 'missing stream') fs.rmSync(ctx.run.headless[0].stream);
      const evidenceDir = path.join(ctx.dir, 'evidence'), recordsDir = path.join(ctx.dir, 'records');
      fs.mkdirSync(evidenceDir);
      const first = analyzeRun(ctx.run, evidenceDir, [ctx.check], evidenceReaders, { recordsDir, env: ctx.env });
      assert.equal(first.records[0].result, 'fail');
      for (const jobs of Object.values(ctx.run.setup.jobs)) for (const job of Object.values(jobs)) {
        assert.ok(fs.existsSync(path.join(ctx.run.copy.jobsHome, job.jobDir, 'job.json')));
      }
      fs.rmSync(ctx.run.jobsHome, { recursive: true });
      fs.rmSync(ctx.run.transcript);
      for (const receipt of ctx.run.headless ?? []) for (const file of [receipt.transcript, receipt.stream]) fs.rmSync(file, { force: true });
      assert.deepEqual(analyzeRun(ctx.run, evidenceDir, [ctx.check], evidenceReaders, { recordsDir, fromCopy: true }).records, first.records);
    });
  }
}

test('a headless exit before transcript creation still leaves replayable failure records', async t => {
  const ctx = commandsFixture(t, 'headless'), evidenceDir = path.join(ctx.dir, 'evidence'), recordsDir = path.join(ctx.dir, 'records');
  fs.mkdirSync(evidenceDir);
  delete ctx.run.transcript;
  await runHeadless({ ...ctx.run, run: ctx.run, pluginDir: '/build/relay', evidenceDir, save() {} }, {
    env: {}, execute: async () => { throw Object.assign(new Error('Claude failed before starting.'), { code: 1, stdout: '', stderr: 'failed' }); }
  });
  const first = analyzeRun(ctx.run, evidenceDir, [ctx.check], evidenceReaders, { recordsDir, env: ctx.env });
  assert.equal(first.records[0].result, 'fail');
  assert.match(first.records[0].reason, /Missing headless transcript/);
  for (const receipt of ctx.run.headless) for (const file of [receipt.transcript, receipt.stream]) fs.rmSync(file);
  fs.rmSync(ctx.run.jobsHome, { recursive: true });
  assert.deepEqual(analyzeRun(ctx.run, evidenceDir, [ctx.check], evidenceReaders, { recordsDir, fromCopy: true }).records, first.records);
});

test('moduleText preserves the first split tail and reads status only outside the fence', () => {
  const table = '| job | summary |\n|---|---|\n| j-1 | 你好 \\| x |\n';
  const parsed = moduleText(moduleAnswer(`relay-version: build\njobs: 1\n\n${table}`));
  assert.deepEqual(parsed, { command: '/relay:status', verbatim: 'relay-version: build\njobs: 1\n', report: null, table });
  assert.deepEqual(statusRows(parsed.table), [{ job: 'j-1', summary: '你好 | x' }]);
  assert.deepEqual(statusRows(parsed.verbatim), []);
  assert.equal(moduleText(moduleAnswer(`header\n---\n${table}`)).report, table);
  assert.equal(moduleText(moduleAnswer(`header\n${table}---\nreport`)).table, table + '---\nreport');
  assert.deepEqual(moduleText(moduleAnswer(table)), { command: '/relay:status', verbatim: '\n', report: null, table });
  assert.equal(moduleText('relay: /relay:result j-1\n\nPrinted nothing (exit 0).'), null);
});

for (const text of ['/relay:status', '/relay:result job-1', '/relay:cancel job-1', '/relay:transfer']) {
  test(`command proof requires the exact echoed text for ${text}`, () => {
    const rows = commandRuns(commandEntries('t3', text, moduleAnswer('output\n', null, text)));
    assert.equal(rows[0].args, '');
    assert.equal(requireCommand(rows[0], text).command, text);
    for (const echo of [text + ' extra', text.startsWith('/relay:result') || text.startsWith('/relay:cancel') ? text.split(' ')[0] : '/relay:other']) {
      rows[0].text = moduleAnswer('output\n', null, echo);
      assert.throws(() => requireCommand(rows[0], text), /Echoed command/);
    }
  });
}

for (const name of ['commands', 'transfer', 'headless']) {
  for (const header of ['', 'relay-version: wrong\n', 'relay-version: 3.0.0-test\nrelay-version: wrong\n']) {
    test(`${name} rejects a missing, wrong or ambiguous status build (${JSON.stringify(header)})`, t => {
      const ctx = commandsFixture(t, name);
      const file = name === 'headless' ? ctx.run.headless.at(-1).transcript : ctx.run.transcript;
      const entries = readTranscript(file), status = entries.find(entry => entry.commandRun?.command === 'relay:status');
      status.content = status.content.replace('relay-version: 3.0.0-test\n', header);
      lines(file, entries);
      if (name === 'headless') {
        const stream = ctx.run.headless.at(-1).stream, events = readTranscript(stream);
        events.find(event => event.type === 'result').result = status.content.slice('<local-command-stdout>'.length, -'</local-command-stdout>'.length);
        lines(stream, events);
      }
      const result = ctx.check.analyze(ctx.input).results[0];
      assert.equal(result.result, 'fail');
      assert.match(result.reason, /relay-version/);
      if (name === 'transfer' && header === 'relay-version: wrong\n') assert.equal(result.relayVersion, 'wrong');
    });
  }
}

for (const failure of ['no init', 'no relay', 'wrong path', 'running exit', 'running state', 'running job', 'running echo']) {
  test(`headless proves plugin loading and the running decoy (${failure})`, t => {
    const ctx = commandsFixture(t, 'headless');
    // Only the status run is a stream with an init event; the running decoy's result runs as json.
    const initFailure = ['no init', 'no relay', 'wrong path'].includes(failure);
    const receipt = ctx.run.headless.find(row => initFailure ? row.format === 'stream-json' : row.running), events = readTranscript(receipt.stream);
    const init = events.find(event => event.subtype === 'init');
    if (failure === 'no init') events.splice(events.indexOf(init), 1);
    if (failure === 'no relay') init.plugins = [{ name: 'other', path: ctx.run.pluginDir }];
    if (failure === 'wrong path') init.plugins[0].path += '-other';
    if (failure === 'running exit') receipt.exitCode = 0;
    if (['running state', 'running job', 'running echo'].includes(failure)) {
      const result = events.find(event => event.type === 'result');
      const [before, after] = failure === 'running state' ? ['state: running', 'state: completed'] :
        failure === 'running job' ? ['job: decoy-running', 'job: done-codex'] : ['/relay:result decoy-running', '/relay:result'];
      result.result = result.result.replace(before, after);
      const entries = readTranscript(receipt.transcript);
      entries.find(entry => entry.commandRun).content = `<local-command-stdout>${result.result}</local-command-stdout>`;
      lines(receipt.transcript, entries);
    }
    lines(receipt.stream, events);
    assert.equal(ctx.check.analyze(ctx.input).results[0].result, 'fail');
  });
}

for (const failure of ['wrong thread', 'wrong source', 'missing ledger', 'invalid ledger']) {
  test(`transfer ledger rejection replays without the live ledger (${failure})`, t => {
    const ctx = commandsFixture(t, 'transfer'), ledger = path.join(ctx.env.CODEX_HOME, 'external_agent_session_imports.json');
    const saved = read(ledger);
    if (failure === 'wrong thread') saved.records[0].imported_thread_id = 'other';
    if (failure === 'wrong source') saved.records[0].source_path += '-other';
    write(ledger, saved);
    if (failure === 'missing ledger') fs.rmSync(ledger);
    if (failure === 'invalid ledger') fs.writeFileSync(ledger, '{');
    const recordsDir = path.join(ctx.dir, 'records');
    const first = analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders, { recordsDir, env: ctx.env });
    assert.equal(first.records[0].result, 'fail');
    assert.match(first.records[0].reason, /import (ledger|evidence)/);
    fs.rmSync(ctx.env.CODEX_HOME, { recursive: true });
    fs.rmSync(ctx.run.transcript);
    assert.deepEqual(analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders, { recordsDir, fromCopy: true }).records, first.records);
  });
}

test('transfer matches the canonical transcript path and preserves proof after originals disappear', t => {
  const ctx = commandsFixture(t, 'transfer'), original = ctx.run.transcript;
  const link = path.join(ctx.dir, 'linked.jsonl');
  fs.symlinkSync(original, link);
  ctx.run.transcript = link;
  const recordsDir = path.join(ctx.dir, 'records');
  const first = analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders, { recordsDir, env: ctx.env });
  assert.equal(first.records[0].result, 'pass');
  assert.equal(first.records[0].relayVersion, '3.0.0-test');
  fs.rmSync(ctx.env.CODEX_HOME, { recursive: true });
  fs.rmSync(original);
  fs.rmSync(link);
  assert.deepEqual(analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders, { recordsDir, fromCopy: true }).records, first.records);
});

for (const running of [false, true]) {
  test(`setup orders decoys after target jobs with one backend (running=${running})`, async t => {
    const dir = temp(t), run = { backends: ['grok'] }, order = [];
    const ctx = { run, backends: run.backends, pluginDir: '/fixture/build', workDir: dir, jobsHome: path.join(dir, 'jobs'), evidenceDir: dir, save() {} };
    await setupJobs(ctx, running, { env: {}, async execute(command, args) {
      assert.equal(args[1], 'start');
      const id = path.basename(args.at(-1), '.txt'), kind = id.endsWith('done') ? 'done' : 'running';
      const jobDir = path.join(ctx.jobsHome, 'repo', id);
      order.push(id);
      const prompt = fs.readFileSync(args.at(-1), 'utf8');
      assert.match(prompt, /^backend: grok\nmodel: grok-4.7\neffort: low\n---\n/);
      if (id === 'grok-decoy-done') assert.ok(prompt.endsWith('Reply with exactly one line: decoy.\n'));
      if (kind === 'running') assert.match(prompt, /`sleep 600` exactly once/);
      write(path.join(jobDir, 'job.json'), { id, state: kind === 'done' ? 'completed' : 'running', attempts: [{}] });
      return { stdout: `job: ${id}\ndir: ${jobDir}\n` };
    } });
    assert.deepEqual(order, ['grok-done', 'grok-decoy-done', ...(running ? ['grok-running'] : []), 'grok-decoy-running']);
    assert.deepEqual(run.setup.decoys, { done: { id: 'grok-decoy-done', jobDir: 'repo/grok-decoy-done' },
      running: { id: 'grok-decoy-running', jobDir: 'repo/grok-decoy-running' } });
  });
}

test('a setup failure after decoy starts cancels all started jobs with the grace budget', async t => {
  const dir = temp(t), run = { backends: ['codex'] }, started = [], cancelled = [];
  const ctx = { run, backends: run.backends, pluginDir: '/build', workDir: dir, jobsHome: path.join(dir, 'jobs'), evidenceDir: dir, save() {} };
  await assert.rejects(setupJobs(ctx, true, { env: { RELAY_JOBS_CANCEL_GRACE_MS: '30000' }, async execute(command, args, options) {
    if (args[1] === 'cancel') { cancelled.push(args.at(-1)); assert.equal(options.timeout, 100000); return {}; }
    const id = path.basename(args.at(-1), '.txt'), jobDir = path.join(ctx.jobsHome, 'repo', id);
    started.push(id);
    write(path.join(jobDir, 'job.json'), { id, state: id.endsWith('done') ? 'completed' : 'running', attempts: [{}] });
    const stdout = `job: ${id}\ndir: ${jobDir}\n`;
    if (id === 'codex-decoy-running') throw Object.assign(new Error('Late setup failure.'), { stdout });
    return { stdout };
  } }), /Late setup failure/);
  assert.deepEqual(started, ['codex-done', 'codex-decoy-done', 'codex-running', 'codex-decoy-running']);
  assert.deepEqual(cancelled, started);
  assert.equal(run.setup.cancellations.length, 4);
});

test('headless timings come from result durations even when enqueue includes a long module load', t => {
  const ctx = commandsFixture(t, 'headless');
  for (const receipt of ctx.run.headless) {
    const entries = readTranscript(receipt.transcript);
    entries.find(entry => entry.operation === 'enqueue').timestamp = '2026-10-22T11:00:00Z';
    lines(receipt.transcript, entries);
  }
  const result = ctx.check.analyze(ctx.input).results[0];
  assert.equal(result.result, 'pass');
  assert.deepEqual(result.timings.answeredSeconds, [0.25, 0.35, 0.45]);
});

for (const surface of ['terminal', 't3']) {
  for (const commit of [null, '0123456789ab', '0123456789ab-dirty', 'abcdef012345']) {
    test(`status build identity on ${surface}: ${commit}`, () => {
      const parsed = { verbatim: `relay-version: 3.0.0-test${commit ? ` (${commit})` : ''}\n` };
      const run = { surface, relayVersion: '3.0.0-test', relayCommit: '0123456789ab' };
      if (commit === run.relayCommit || (commit === null && surface === 'terminal')) {
        assert.deepEqual(requireBuild(parsed, run), { relayVersion: run.relayVersion, relayCommit: commit });
      } else assert.throws(() => requireBuild(parsed, run), /relay-version commit/);
      if (commit?.endsWith('-dirty')) {
        assert.equal(requireBuild(parsed, { ...run, relayCommit: commit }).relayCommit, commit);
      }
    });
  }
}

for (const name of ['commands', 'transfer']) {
  for (const stamp of ['', ' (abcdef012345)']) {
    test(`${name} rejects missing or mismatched T3 stamp ${JSON.stringify(stamp)}`, t => {
      const ctx = commandsFixture(t, name, 't3');
      const rows = readTranscript(ctx.run.transcript);
      rows.find(row => row.commandRun?.command === 'relay:status').content = rows.find(row => row.commandRun?.command === 'relay:status')
        .content.replace(' (0123456789ab)', stamp);
      lines(ctx.run.transcript, rows);
      const result = ctx.check.analyze(ctx.input).results[0];
      assert.equal(result.result, 'fail');
      assert.match(result.reason, /relay-version commit/);
    });
  }
}

for (const surface of ['terminal', 't3']) {
  test(`transfer records the reported build separately from the run on ${surface}`, t => {
    const ctx = commandsFixture(t, 'transfer', surface);
    const { records } = analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders,
      { recordsDir: path.join(ctx.dir, 'records'), env: ctx.env });
    assert.equal(records[0].result, 'pass');
    assert.equal(records[0].relayVersion, '3.0.0-test');
    // T3 takes the commit from the status line's stamp; a terminal --plugin-dir build has none, so the run's own.
    assert.equal(records[0].relayCommit, ctx.run.relayCommit);
  });
}

for (const surface of ['terminal', 't3']) {
  for (const offset of [-3, -2, 0, 2, 4, 5, null, '0', 0.5]) {
    test(`transfer requires this command's import time on ${surface}: ${offset}`, t => {
      const ctx = commandsFixture(t, 'transfer', surface);
      const ledger = path.join(ctx.env.CODEX_HOME, 'external_agent_session_imports.json');
      const saved = read(ledger), row = commandRuns(readTranscript(ctx.run.transcript), ctx.run)[1];
      saved.records[0].imported_at = typeof offset === 'number' ? Date.parse(row.startedAt) / 1000 + offset : offset;
      write(ledger, saved);
      const pass = [-2, 0, 2, 4].includes(offset);
      const recordsDir = path.join(ctx.dir, 'records');
      const first = analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders, { recordsDir, env: ctx.env });
      assert.equal(first.records[0].result, pass ? 'pass' : 'fail');
      if (!pass) assert.match(first.records[0].reason, /this command's time/);
      fs.rmSync(ctx.env.CODEX_HOME, { recursive: true });
      fs.rmSync(ctx.run.transcript);
      assert.deepEqual(analyzeRun(ctx.run, ctx.dir, [ctx.check], evidenceReaders, { recordsDir, fromCopy: true }).records, first.records);
    });
  }
}

test('status rows decode escaped backslashes, pipes and trailing backslashes without splitting a cell', () => {
  const values = ['a\\|b', 'trailing\\', '`sleep 600`'];
  const escaped = values.map(value => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'));
  const table = '| job | summary |\n|---|---|\n' + escaped.map((value, i) => `| j-${i} | ${value} |`).join('\n');
  assert.deepEqual(statusRows(table).map(row => row.summary), values);
});

test('headless execution supplies EOF immediately to a subprocess', async () => {
  const output = await executeHeadless(process.execPath, ['-e',
    'let bytes = 0; process.stdin.on("data", chunk => bytes += chunk.length); process.stdin.on("end", () => console.log(bytes));'],
  { encoding: 'utf8', timeout: 5000 });
  assert.equal(output.stdout, '0\n');
});

test('interrupted headless execution saves its partial output and starts no more commands', async t => {
  const ctx = commandsFixture(t, 'headless'), controller = new AbortController();
  let calls = 0;
  await assert.rejects(runHeadless({ ...ctx.run, run: ctx.run, evidenceDir: ctx.dir, save() {} }, {
    env: { CLAUDE_CONFIG_DIR: path.join(ctx.dir, 'claude') }, signal: controller.signal,
    execute: async (file, args, options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      controller.abort(new Error('Interrupted by SIGHUP.'));
      throw Object.assign(new Error('Aborted'), { stdout: 'partial output', stderr: 'partial error' });
    }
  }), /Interrupted by SIGHUP/);
  assert.equal(calls, 1);
  assert.equal(ctx.run.headless.length, 1);
  assert.equal(ctx.run.headless[0].interrupted, true);
  assert.equal(fs.readFileSync(ctx.run.headless[0].stream, 'utf8'), 'partial output');
  assert.notEqual(ctx.run.completed, true);
});

for (const when of ['start', 'wait']) {
  test(`interrupted setup keeps the job receipt and cancels it (${when})`, async t => {
    const dir = temp(t), controller = new AbortController(), calls = [];
    const ctx = { backends: ['codex'], pluginDir: path.join(dir, 'plugin'), jobsHome: path.join(dir, 'jobs'),
      workDir: dir, evidenceDir: dir, run: {}, save() {} };
    await assert.rejects(setupJobs(ctx, true, {
      signal: controller.signal, env: {},
      async execute(file, args, options) {
        calls.push(args[1]);
        assert.equal(options.signal, undefined, 'cleanup must not inherit the aborted signal');
        if (args[1] === 'cancel') return {};
        const jobDir = path.join(ctx.jobsHome, 'repo/job-1');
        write(path.join(jobDir, 'job.json'), { id: 'job-1', state: 'running' });
        if (when === 'start') controller.abort(new Error('Interrupted.'));
        return { stdout: `job: job-1\ndir: ${jobDir}\n` };
      },
      async pause() { controller.abort(new Error('Interrupted.')); }
    }), /Interrupted/);
    assert.deepEqual(calls, ['start', 'cancel']);
    assert.deepEqual(ctx.run.setup.jobs.codex.done, { id: 'job-1', jobDir: 'repo/job-1' });
    assert.deepEqual(ctx.run.setup.cancellations, [{ jobId: 'job-1', status: 'cancelled' }]);
  });
}

function statusInput(dir) {
  const run = { ...read(path.join(dir, 'run.json')), jobsHome: path.join(dir, 'jobs'),
    transcript: path.join(dir, 'transcript.jsonl') };
  return { ...input(dir, run.backends), run, evidenceDir: dir };
}

test('status-line is terminal only and run all includes it', async () => {
  const check = getCheck('status-line');
  assert.deepEqual(check.surfaces, ['terminal']);
  assert.equal(typeof check.runTerminal, 'function');
  assert.deepEqual(parseArgs(['run', 'status-line'], checks, BACKENDS).backends, BACKENDS);
  assert.ok(parseArgs(['run', 'all'], checks, BACKENDS).checks.includes('status-line'));
  const warnings = [];
  assert.equal(await main(['prepare', 'status-line', '--surface', 't3', '--work-dir', '/tmp'], checks,
    evidenceReaders, { warn: text => warnings.push(text) }), 1);
  assert.deepEqual(warnings, ['status-line does not support t3.']);
  assert.doesNotMatch(check.prompt({ runId: 'synthetic-run' }), /relay: /);
});

const statusScreen = text => `────────────────────\n❯ \n────────────────────\n${text ? `  ${text}\n` : ''}  ⏵⏵ bypass permissions on\n`;

test('status-line captured footer fixture passes for all four backends with both timings', () => {
  const data = statusInput(path.join(fixture, 'status-line')), check = getCheck('status-line');
  const analyzed = check.analyze(data);
  assert.deepEqual(analyzed.results, BACKENDS.map(backend => ({ backend, model: MODELS[backend],
    relayVersion: '3.0.0-test', delivery: null, timings: { shownSeconds: [3], clearedSeconds: [10] }, result: 'pass', reason: null })));
  assert.equal(analyzed.evidence.files.length, 4);
  assert.equal(analyzed.evidence.agents.length, 4);
  assert.equal(check.cell(analyzed.results[0]), 'count shown in 3.0 s, cleared in 10.0 s');
});

for (const [failure, file, text, reason] of [
  ['never appears', 'running', statusScreen(''), /No screen shows relay: 4 running/],
  ['shows another count', 'running', statusScreen('⚠ relay: 3 running'), /No screen shows relay: 4 running/],
  ['is quoted by the assistant', 'running', `● The previous run said relay: 4 running.\n${statusScreen('')}`, /No screen shows/],
  ['has a warning quoted above the prompt', 'running', `  ⚠ relay: 4 running\n${statusScreen('')}`, /No screen shows/],
  ['lacks the warning prefix', 'running', statusScreen('relay: 4 running'), /No screen shows/],
  ['has two pinned relay lines', 'running', statusScreen('⚠ relay: 4 running\n  ⚠ relay: 4 running'), /No screen shows/],
  ['has another relay error line', 'running', statusScreen('⚠ relay: 4 running\n  ⚠ relay: status unavailable'), /No screen shows/],
  ['has a second relay line below a blank row', 'running', statusScreen('⚠ relay: 4 running\n\n  ⚠ relay: 4 running'), /No screen shows/],
  ['has the old double prefix', 'running', statusScreen('⚠ relay: relay: 4 running'), /No screen shows/],
  ['has a wrong count prefix', 'running', statusScreen('⚠ relay: 40 running'), /No screen shows/],
  ['uses the wrong part separator', 'running', statusScreen('⚠ relay: 4 running | 1 dead'), /No screen shows/],
  ['has unavailable instead of a count', 'running', statusScreen('⚠ relay: status unavailable'), /No screen shows/],
  ['joins across a blank footer boundary', 'running', statusScreen('⚠ relay: 4\n\nrunning'), /No screen shows/],
  ['joins across another widget', 'running', statusScreen('⚠ relay: 4\n  other widget\n  running'), /No screen shows/],
  ['joins a transcript count to a footer word', 'running', `⚠ relay: 4\n${statusScreen('running')}`, /No screen shows/],
  ['never clears', 'cleared', statusScreen('⚠ relay: 1 dead · 2 owed'), /never clears/],
  ['keeps a wrapped count', 'cleared', statusScreen('⚠ relay: 4\n  running'), /never clears/],
  ['becomes unavailable', 'cleared', statusScreen('⚠ relay: status unavailable'), /never clears/],
  ['is below a blank footer row', 'cleared', statusScreen('\n  ⚠ relay: status unavailable'), /never clears/],
  ['has an empty capture', 'cleared', '', /never clears/],
  ['loses its prompt', 'cleared', 'How did this session go?\n', /never clears/],
  ['has only a transcript prompt', 'cleared', '● Example:\n❯\n', /never clears/],
  ['has a blank before capture', 'before', '', /visible prompt/],
  ['starts with unavailable', 'before', statusScreen('⚠ relay: status unavailable'), /visible prompt/]
]) {
  test(`status-line rejects a screen where the line ${failure}`, t => {
    const dir = copy(t, 'status-line');
    fs.writeFileSync(path.join(dir, `screen-${file}.txt`), text);
    const results = getCheck('status-line').analyze(statusInput(dir)).results;
    for (const row of results) { assert.equal(row.result, 'fail'); assert.match(row.reason, reason); }
  });
}

for (const text of ['⚠ relay: 4\n  running', '⚠ relay:\n  4 running', '⚠ relay: 4 running · 1 dead · 2 owed',
  '⚠ relay: 4\n  running · 1\n  dead · 2 owed']) {
  test(`status-line accepts pinned count parts, including physical wrapping: ${JSON.stringify(text)}`, t => {
    const dir = copy(t, 'status-line');
    fs.writeFileSync(path.join(dir, 'screen-running.txt'), statusScreen(text));
    assert.ok(getCheck('status-line').analyze(statusInput(dir)).results.every(row => row.result === 'pass'));
  });
}

for (const gap of [0, 5, 5.001, 6]) {
  test(`status-line requires clear captures strictly more than five seconds apart: ${gap}`, t => {
    const data = statusInput(copy(t, 'status-line'));
    data.run.statusLine.screens.at(-1).at = new Date(Date.parse(data.run.statusLine.screens.at(-2).at) + gap * 1000).toISOString();
    const results = getCheck('status-line').analyze(data).results;
    assert.ok(results.every(row => row.result === (gap > 5 ? 'pass' : 'fail')));
  });
}

test('status-line restarts clear confirmation after a redraw or a returning line', t => {
  const data = statusInput(copy(t, 'status-line'));
  for (const text of ['', statusScreen('⚠ relay: status unavailable')]) {
    fs.writeFileSync(path.join(data.evidenceDir, 'redraw.txt'), text);
    const changed = structuredClone(data);
    changed.run.statusLine.screens.splice(-1, 0, { phase: 'cleared', file: 'redraw.txt', at: '2026-10-22T10:00:20.000Z' });
    assert.ok(getCheck('status-line').analyze(changed).results.every(row => row.result === 'fail' && /never clears/.test(row.reason)));
  }
});

test('status-line ignores transcript quotations when judging a cleared footer', t => {
  const dir = copy(t, 'status-line');
  for (const phase of ['cleared', 'cleared-confirmed']) {
    fs.writeFileSync(path.join(dir, `screen-${phase}.txt`), `● The previous run said ⚠ relay: 4 running.\n${statusScreen('')}`);
  }
  assert.ok(getCheck('status-line').analyze(statusInput(dir)).results.every(row => row.result === 'pass'));
});

for (const state of [{ completed: false, error: 'Could not cancel status-line jobs; see run.json.' },
  { completed: true, error: 'Could not stop pane.' }, { completed: false }, { completed: undefined }]) {
  test(`status-line separates the lead marker from run failure: ${JSON.stringify(state)}`, t => {
    const data = statusInput(copy(t, 'status-line')), check = getCheck('status-line');
    Object.assign(data.run, state);
    assert.equal(check.completed(readTranscript(data.transcript), data.run), true);
    const analyzed = analyzeRun(data.run, data.evidenceDir, [check], evidenceReaders,
      { recordsDir: path.join(data.evidenceDir, 'records') });
    for (const row of analyzed.records) {
      assert.equal(row.result, 'fail');
      assert.equal(row.reason, state.error ?? 'The status-line run did not complete.');
      assert.doesNotMatch(row.reason, /did not print/);
    }
  });
}

test('status-line rejects observations beyond either 60 second bound', t => {
  const data = statusInput(copy(t, 'status-line')), check = getCheck('status-line');
  for (const phase of ['running', 'cleared']) {
    const changed = structuredClone(data);
    changed.run.statusLine.screens.filter(row => row.phase === phase).at(-1).at = '2026-10-22T10:02:00.000Z';
    for (const row of check.analyze(changed).results) {
      assert.equal(row.result, 'fail'); assert.match(row.reason, /60 second bounds/);
    }
  }
});

test('status-line records replay from copied screens and jobs after the originals disappear', t => {
  const dir = copy(t, 'status-line'), data = statusInput(dir), check = getCheck('status-line');
  const recordsDir = path.join(dir, 'records');
  const first = analyzeRun(data.run, dir, [check], evidenceReaders, { recordsDir });
  assert.ok(first.records.every(row => row.result === 'pass'));
  assert.ok(first.records.every(row => row.finishedAt === data.run.checkFinishedAt));
  for (const screen of data.run.statusLine.screens) fs.rmSync(path.join(dir, screen.file));
  fs.rmSync(data.transcript);
  fs.rmSync(data.jobsHome, { recursive: true });
  assert.deepEqual(analyzeRun(data.run, dir, [check], evidenceReaders, { recordsDir, fromCopy: true }).records, first.records);
});

function statusDriver(t, failure, { keep = false, startMs = 1000, cancelMs = 1000 } = {}) {
  const dir = temp(t), jobsHome = path.join(dir, 'jobs'), controller = new AbortController();
  fs.mkdirSync(jobsHome);
  const run = { runId: 'synthetic-run', check: 'status-line', backends: BACKENDS, surface: 'terminal',
    relayVersion: '3.0.0-test', jobsHome, jobsHomeCreated: true, workDir: dir, pluginDir: '/build/relay' };
  const calls = [], check = getCheck('status-line');
  let clock = Date.parse('2026-10-22T10:00:00.000Z'), ready = false, starts = 0, cancels = 0, runningReads = 0, clearedReads = 0;
  const ctx = { ...run, run, evidenceDir: dir, save() { write(path.join(dir, 'run.json'), run); },
    async paneDriver(input, selected, options) {
      assert.equal(input, ctx); assert.equal(options.keep, undefined, 'the suite owns --keep');
      assert.equal(selected.completed([{ type: 'assistant', message: { content: [{ type: 'text', text: check.marker }] } }]), true);
      run.pane = 'fake-pane'; run.promptSentAt = new Date(clock).toISOString();
      fs.copyFileSync(path.join(fixture, 'status-line/transcript.jsonl'), path.join(dir, 'transcript.jsonl'));
      run.transcript = path.join(dir, 'transcript.jsonl');
      run.completed = ready = true;
      if (!keep) options.drive(['stop', run.pane]);
      assert.equal(calls.some(args => args[0] === 'stop'), false, 'the pane must stay open for the observations');
    } };
  const dependencies = { env: { RELAY_JOBS_CANCEL_GRACE_MS: '0', CLAUDECODE: '1' }, signal: controller.signal,
    now: () => clock, sleep: async ms => { clock += ms; },
    drive(args) {
      calls.push(args);
      if (args[0] === 'stop') return '';
      assert.deepEqual(args, ['screen', 'fake-pane']);
      if (!starts) return statusScreen('');
      if (!cancels) {
        if (failure === 'interrupted') controller.abort(new Error('Interrupted.'));
        if (failure === 'missing job') fs.rmSync(path.join(jobsHome, 'repo/grok-job'), { recursive: true, force: true });
        return ++runningReads > 2 && !['never appears', 'dead job', 'missing job', 'status failure'].includes(failure) ? statusScreen('⚠ relay: 4 running') : statusScreen('');
      }
      if (failure === 'unavailable') return statusScreen('⚠ relay: status unavailable');
      if (failure === 'blank cleared') return '';
      if (failure === 'clear redraw' && clearedReads === 5) { clearedReads++; return ''; }
      return ++clearedReads > 3 && failure !== 'never clears' ? statusScreen('') : statusScreen('⚠ relay: 1 running');
    },
    async execute(command, args, options) {
      assert.equal(command, process.execPath); assert.equal(args[0], '/build/relay/scripts/companion.mjs');
      assert.equal(options.cwd, dir); assert.equal(options.env.RELAY_JOBS_HOME, jobsHome);
      assert.equal(options.env.CLAUDECODE, undefined); assert.equal(options.detached, true);
      assert.equal(ready, true);
      if (args[1] === 'status') {
        assert.deepEqual(args.slice(1), ['status', '--json', '--limit', '200']);
        assert.equal(options.timeout, 10000);
        if (failure === 'status failure') throw new Error('Listing timed out.');
        const jobs = BACKENDS.flatMap(backend => {
          const file = path.join(jobsHome, 'repo', `${backend}-job`, 'job.json');
          if (!fs.existsSync(file)) return [];
          const job = read(file);
          if (failure === 'dead job' && backend === 'grok') {
            assert.equal(job.state, 'running', 'dead is computed, never stored');
            job.state = 'dead';
          }
          return [job];
        });
        return { stdout: JSON.stringify({ schema: 'relay.status/1', jobs, nextCursor: null }) };
      }
      if (args[1] === 'cancel') {
        assert.equal(options.timeout, 40000); assert.equal(options.signal, undefined);
        cancels++; clock += cancelMs;
        if (failure === 'cancel failure') throw new Error('Cancel failed.');
        edit(dir, `jobs/repo/${args[2]}/job.json`, job => { job.state = 'cancelled'; });
        return { stdout: '' };
      }
      assert.equal(args[1], 'start'); assert.equal(args[2], '--prompt-file');
      const backend = BACKENDS[starts++], id = `${backend}-job`, jobDir = path.join(jobsHome, 'repo', id);
      const prompt = fs.readFileSync(args[3], 'utf8');
      assert.ok(prompt.includes(`model: ${MODELS[backend]}\neffort: low\n---\n`));
      assert.match(prompt, /`sleep 150` exactly once and wait for it/);
      assert.doesNotMatch(prompt, /relay: /);
      write(path.join(jobDir, 'job.json'), { id, state: 'running', request: { backend, model: MODELS[backend] }, attempts: [{ relayVersion: run.relayVersion }] });
      clock += startMs;
      const stdout = `job: ${id}\ndir: ${jobDir}\n`;
      if (failure === 'partial start') throw Object.assign(new Error('Start failed after its receipt.'), { stdout });
      if (starts === 2 && ['missing receipt', 'incomplete receipt'].includes(failure)) {
        throw Object.assign(new Error('Second start timed out.'), { stdout: failure === 'missing receipt' ? undefined : `job: ${id}\n` });
      }
      return { stdout };
    } };
  return { ctx, dependencies, state: () => ({ calls, starts, cancels, runningReads, clearedReads }) };
}

test('status-line runTerminal starts all backends in one ready pane, captures screens and cancels before clearing', async t => {
  const { ctx, dependencies, state } = statusDriver(t);
  await getCheck('status-line').runTerminal(ctx, dependencies);
  const analyzed = getCheck('status-line').analyze(statusInput(ctx.evidenceDir));
  assert.ok(analyzed.results.every(row => row.result === 'pass'));
  assert.deepEqual(analyzed.results[0].timings, { shownSeconds: [6], clearedSeconds: [13] });
  assert.equal(state().starts, 4); assert.equal(state().cancels, 4);
  assert.deepEqual(state().calls.at(-1), ['stop', 'fake-pane']);
  assert.equal(ctx.run.statusLine.screens.length, 14);
  assert.equal(ctx.run.completed, true);
});

for (const failure of ['never appears', 'never clears', 'unavailable', 'blank cleared', 'interrupted', 'partial start',
  'missing receipt', 'incomplete receipt', 'dead job', 'status failure']) {
  test(`status-line runTerminal cleans up when ${failure}`, async t => {
    const { ctx, dependencies, state } = statusDriver(t, failure);
    await assert.rejects(getCheck('status-line').runTerminal(ctx, dependencies),
      failure === 'interrupted' ? /Interrupted/ : failure === 'partial start' ? /Start failed/ :
        failure.includes('receipt') ? /Second start timed out/ : /within 60 seconds/);
    assert.equal(state().cancels, state().starts);
    assert.deepEqual(state().calls.at(-1), ['stop', 'fake-pane']);
    assert.equal(ctx.run.completed, false);
    assert.ok(ctx.run.error);
    if (failure === 'never appears') assert.equal(state().runningReads, 57);
    if (failure === 'never clears') assert.equal(state().clearedReads, 57);
    if (failure === 'dead job') assert.match(ctx.run.error, /Jobs not starting or running: grok-job \(dead\)/);
    if (failure === 'status failure') {
      for (const backend of BACKENDS) assert.ok(ctx.run.error.includes(`${backend}-job (unreadable)`));
      assert.match(ctx.run.error, /Status read failed: Listing timed out/);
    }
    if (failure.includes('receipt')) assert.deepEqual(ctx.run.cancellations.map(row => row.jobId), ['codex-job', 'grok-job']);
  });
}

test('status-line includes every sequential start and cancel in its timings', async t => {
  const { ctx, dependencies } = statusDriver(t, undefined, { startMs: 10000, cancelMs: 10000 });
  await getCheck('status-line').runTerminal(ctx, dependencies);
  const results = getCheck('status-line').analyze(statusInput(ctx.evidenceDir)).results;
  assert.ok(results.every(row => row.result === 'pass'));
  assert.deepEqual(results[0].timings, { shownSeconds: [42], clearedSeconds: [49] });
});

test('status-line names a missing setup job at the running deadline', async t => {
  const { ctx, dependencies, state } = statusDriver(t, 'missing job');
  await assert.rejects(getCheck('status-line').runTerminal(ctx, dependencies), /Jobs not starting or running: grok-job \(missing\)/);
  assert.equal(state().cancels, 3);
});

test('status-line also cleans receiptless jobs in a supplied empty home', async t => {
  const { ctx, dependencies, state } = statusDriver(t, 'missing receipt');
  ctx.run.jobsHomeCreated = ctx.jobsHomeCreated = false;
  await assert.rejects(getCheck('status-line').runTerminal(ctx, dependencies), /Second start timed out/);
  assert.equal(state().cancels, 2);
});

test('status-line runTerminal waits a fresh poll interval after an empty redraw', async t => {
  const { ctx, dependencies, state } = statusDriver(t, 'clear redraw');
  await getCheck('status-line').runTerminal(ctx, dependencies);
  assert.equal(state().clearedReads, 13);
  assert.deepEqual(getCheck('status-line').analyze(statusInput(ctx.evidenceDir)).results[0].timings,
    { shownSeconds: [6], clearedSeconds: [16] });
});

for (const failure of [undefined, 'never appears', 'cancel failure']) {
  test(`status-line honours --keep through cleanup: ${failure ?? 'success'}`, async t => {
    const { ctx, dependencies, state } = statusDriver(t, failure, { keep: true });
    const check = getCheck('status-line');
    if (failure) await assert.rejects(check.runTerminal(ctx, dependencies), /within 60 seconds|Could not cancel/);
    else await check.runTerminal(ctx, dependencies);
    assert.equal(state().calls.some(args => args[0] === 'stop'), false);
    assert.ok(state().cancels >= state().starts);
  });
}

test('status-line stops after failed cleanup when --keep is absent', async t => {
  const { ctx, dependencies, state } = statusDriver(t, 'cancel failure');
  await assert.rejects(getCheck('status-line').runTerminal(ctx, dependencies), /Could not cancel/);
  assert.deepEqual(state().calls.at(-1), ['stop', 'fake-pane']);
  assert.equal(ctx.run.completed, false);
});

test('status-line rejects an occupied home without cancelling its jobs', async t => {
  const { ctx, dependencies, state } = statusDriver(t);
  write(path.join(ctx.jobsHome, 'repo/existing/job.json'), { id: 'existing', state: 'running' });
  await assert.rejects(getCheck('status-line').runTerminal(ctx, dependencies), /empty jobs home/);
  assert.equal(state().starts, 0);
  assert.equal(state().cancels, 0);
  assert.deepEqual(state().calls, []);
});

test('pane screen captures visible physical lines without joining or scrollback', t => {
  const dir = temp(t), bin = path.join(dir, 'bin'), log = path.join(dir, 'args.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n` +
    'process.stdout.write("relay: 4\\nrunning\\n");\n', { mode: 0o755 });
  const result = spawnSync('bash', [fileURLToPath(new URL('../scripts/smoke/pane.sh', import.meta.url)), 'screen', 'test-pane'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: dir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'relay: 4\nrunning\n');
  assert.deepEqual(read(log), ['-S', path.join(dir, 'claude-tmux/tmux.sock'), 'capture-pane', '-p', '-t', '=test-pane:']);
});
