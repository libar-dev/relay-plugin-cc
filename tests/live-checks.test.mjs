import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCheck, BACKENDS, BACKEND_NAMES, MODELS, STEER_DELIVERY, JOBS_HOME_EXPR,
  readTranscript, transcriptCalls, runSpan, hasMarker, claudeCodeVersionOf, leadModelOf,
  formatSeconds, readJob, scopeToRun, promptText } from '../scripts/live/lib/evidence.mjs';
import { checks, getCheck } from '../scripts/live/checks/index.mjs';
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
      type: 'attachment', uuid: String(round), attachment: { type: 'queued_command', origin: { kind: 'coordinator' } }
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
  assert.deepEqual(analyzed.details.map(row => row.matchedBy), ['text', 'text', 'order']);
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

test('text matching takes precedence over order and a record is never reused', t => {
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
    assert.match(row.reason, /expected exactly one send, found [02]/);
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
  test(`continue requires the exact report line: ${report}`, t => {
    const dir = copy(t, 'continue'), file = path.join(dir, 'jobs/repo/job-one/report.md');
    if (report === null) fs.rmSync(file);
    else fs.writeFileSync(file, report + '\n');
    const row = getCheck('continue').analyze(input(dir)).results[0];
    assert.equal(row.result, 'fail');
    assert.deepEqual(row.timings, { deliveredSeconds: [2], readSeconds: [2], completedSeconds: [5] });
    assert.match(row.reason, /report|Report/);
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

for (const check of checks) {
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

test('registry has four unique ordered checks, the complete interface and terminal-only probes', () => {
  assert.deepEqual(checks.map(check => check.id), ['steer-main', 'steer-workflow', 'steer-plugin', 'continue']);
  assert.equal(new Set(checks.map(check => check.id)).size, 4);
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
    assert.match(analyzed.results[0].reason, /Recipient was not spawned in this run/);
    assert.equal(analyzed.details[0].error, 'Recipient was not spawned in this run.');
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
