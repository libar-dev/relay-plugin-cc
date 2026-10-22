import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCheck, BACKENDS, BACKEND_NAMES, MODELS, STEER_DELIVERY, JOBS_HOME_EXPR,
  readTranscript, transcriptCalls, runSpan, hasMarker, claudeCodeVersionOf, leadModelOf,
  formatSeconds, readJob, scopeToRun, promptText, runLine } from '../scripts/live/lib/evidence.mjs';
import { checks, getCheck } from '../scripts/live/checks/index.mjs';
import { workflowScript } from '../scripts/live/checks/steer-workflow.mjs';
import { agentCalls, waitLoop } from '../scripts/live/checks/steer-main.mjs';
import { badPrompts, goodPrompt, workflowScript as spawnScript, checkHeader, expectedMessage } from '../scripts/live/checks/spawn-check.mjs';
import { copyEvidence } from '../scripts/live/lib/runs.mjs';

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
  assert.equal(formatSeconds([]), '—');
});

test('registry has seven unique ordered checks, the complete interface and terminal-only probes', () => {
  assert.deepEqual(checks.map(check => check.id), ['steer-main', 'steer-workflow', 'steer-plugin', 'continue', 'stop', 'session-end', 'spawn-check']);
  assert.equal(new Set(checks.map(check => check.id)).size, 7);
  for (const check of checks) {
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
    assert.deepEqual(check.surfaces, ['steer-plugin', 'session-end'].includes(check.id) ? ['terminal'] : ['terminal', 't3']);
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
  ['cancel posted before TaskStop', dir => edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.createdAt = at('00:29.999'); }), /claimed cancel/],
  ['missing cancel', dir => fs.rmSync(path.join(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json')), /claimed cancel/],
  ['wrong message kind', dir => edit(dir, 'jobs/repo/codex-job/inbox/claimed/cancel-codex.json', m => { m.kind = 'steer'; }), /claimed cancel/],
  ['wrong cancel outcome', dir => edit(dir, 'jobs/repo/codex-job/inbox/outcomes/cancel-codex.json', m => { m.action = 'interrupt-sent'; }), /claimed cancel/],
  ['attempt ended before TaskStop', dir => edit(dir, phaseJob, j => { j.attempts[0].endedAt = at('00:29.999'); }), /not active/],
  ['attempt started at TaskStop', dir => edit(dir, phaseJob, j => { j.attempts[0].startedAt = at('00:30.000'); }), /not active/],
  ['attempt not cancelled', dir => edit(dir, phaseJob, j => { j.attempts[0].state = 'completed'; }), /attempt is not cancelled/],
  ['later attempt', dir => edit(dir, phaseJob, j => { j.attempts.push({ ...j.attempts[0], attempt: 2, startedAt: at('00:31.000') }); }), /not active/],
  ['another relay version', dir => edit(dir, phaseJob, j => { j.attempts[0].relayVersion = 'other'; }), /relayVersion/],
  ['second TaskStop', dir => changeEntries(dir, e => { e.push(callEntry('second-stop', 'TaskStop', { task_id: 'agent-codex' }, at('00:30.100'))); }), /one TaskStop/],
  ['TaskStop outside the run scope', dir => changeEntries(dir, e => { e.splice(3, 0, textEntry('user', 'Live suite run other-run.')); }), /one TaskStop/],
  ['hook outside the run scope', dir => changeEntries(dir, e => { e.splice(e.indexOf(hookEntry(e)), 0, textEntry('user', 'Live suite run other-run.')); }), /hook context/]
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

const sessionMutations = [
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
  ['wrong Workflow script', dir => changeEntries(dir, e => { callBlock(e, 'workflow').input.script += '\n'; }), /expected script/],
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
  ['Agent call outside the run scope', dir => changeEntries(dir, e => { e.splice(1, 0, textEntry('user', 'Live suite run other-run.')); }), /one bad Agent/],
  ['Workflow outside the run scope', dir => changeEntries(dir, e => { e.splice(3, 0, textEntry('user', 'Live suite run other-run.')); }), /one Workflow/]
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
  delete run.sessionEndedAt; delete run.afterEnd;
  let clock = Date.parse(at('00:29.000')), saves = [], polls = 0, statusCalls = 0, paneCalls = 0;
  const ctx = { runId: run.runId, backends: run.backends, run, evidenceDir: dir, jobsHome: path.join(dir, 'jobs'), pluginDir: '/tmp/fake-plugin',
    keep: true, save() { saves.push(structuredClone(run)); write(path.join(dir, 'run.json'), run); },
    async paneDriver(input, check, options) {
      paneCalls++; assert.equal(input, ctx); assert.equal(check.id, 'session-end'); assert.deepEqual(options, { keep: false });
      assert.equal(check.completed(readTranscript(run.transcript)), true);
      if (failure === 'missing marker') changeEntries(dir, e => e.slice(0, -1));
      if (failure === 'pane timeout') throw new Error('Timed out waiting for marker.');
    } };
  const dependencies = { now: () => clock, sleep: async ms => { clock += ms; },
    processRunner: async () => {
      assert.equal(run.sessionEndedAt, undefined);
      polls++;
      return failure === 'process timeout' || polls <= 4 ? 'claude --session-id fake-session --model sonnet\n' :
        'claude --session-id fake-session-other\n';
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
  return { ctx, dependencies, state: () => ({ saves, polls, statusCalls, paneCalls }) };
}

test('session-end runTerminal closes even under keep, waits for process exit, saves observations, waits for jobs and analyzes', async t => {
  const { ctx, dependencies, state } = sessionDriver(t);
  const result = await getCheck('session-end').runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass', result.results[0].reason);
  assert.equal(ctx.run.sessionEndedAt, at('00:30.000'));
  assert.deepEqual(ctx.run.afterEnd, { 'agent-codex': { at: at('00:50.000'), state: 'running' } });
  assert.equal(state().paneCalls, 1); assert.equal(state().polls, 5); assert.equal(state().statusCalls, 3);
  assert.ok(state().saves.some(saved => saved.afterEnd?.['agent-codex']?.state === 'running'));
  assert.deepEqual(read(path.join(ctx.evidenceDir, 'run.json')), ctx.run);
});
for (const [failure, message] of [
  ['missing marker', /Session ended without LIVE-SESSION-END-READY/], ['pane timeout', /Timed out waiting for marker/],
  ['process timeout', /Timed out waiting for the Claude process/], ['job timeout', /Timed out waiting for jobs/]
]) {
  test(`session-end runTerminal saves and throws on ${failure}`, async t => {
    const { ctx, dependencies, state } = sessionDriver(t, failure);
    await assert.rejects(getCheck('session-end').runTerminal(ctx, dependencies), message);
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
