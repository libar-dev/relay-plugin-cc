import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('registry keeps the original four interfaces and appends the command checks', () => {
  assert.deepEqual(checks.map(check => check.id), ['steer-main', 'steer-workflow', 'steer-plugin', 'continue', 'commands', 'transfer', 'headless']);
  assert.equal(new Set(checks.map(check => check.id)).size, 7);
  for (const check of checks.slice(0, 4)) {
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
    assert.deepEqual(check.surfaces, check.id === 'steer-plugin' ? ['terminal'] : ['terminal', 't3']);
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
