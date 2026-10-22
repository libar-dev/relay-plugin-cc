import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import typed, { typedLine, typeInView } from '../scripts/live/checks/typed.mjs';
import { checks, getCheck } from '../scripts/live/checks/index.mjs';
import * as readers from '../scripts/live/lib/evidence.mjs';
import { copyEvidence } from '../scripts/live/lib/runs.mjs';

const fixture = path.resolve('tests/fixtures/live-suite/typed');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const lines = (file, data) => fs.writeFileSync(file, data.map(row => JSON.stringify(row)).join('\n') + '\n');
const edit = (dir, file, fn) => { const value = json(path.join(dir, file)); fn(value); write(path.join(dir, file), value); };
const editLines = (dir, file, fn) => { const rows = readers.readTranscript(path.join(dir, file)); fn(rows); lines(path.join(dir, file), rows); };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-typed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fixture, dir, { recursive: true });
  const input = { runId: 'synthetic-run', backends: ['codex', 'kimi'], relayVersion: '3.0.0-test', surface: 'terminal',
    transcript: path.join(dir, 'transcript.jsonl'), jobsHome: path.join(dir, 'jobs'), evidenceDir: dir };
  return { dir, input };
}
const A = 'jobs/repo/job-a-codex', B = 'jobs/repo/job-b-codex', C = 'jobs/repo/job-c-codex';

test('typed is registered only for terminal with no probe', () => {
  assert.equal(getCheck('typed'), typed);
  assert.equal(checks.filter(check => check.id === 'typed').length, 1);
  assert.deepEqual(typed.surfaces, ['terminal']); assert.deepEqual(typed.probes, []);
  assert.equal(typed.timeoutMinutes, 25);
});

test('typed prompt launches three named jobs per backend and ends at the readiness marker', () => {
  const prompt = typed.prompt({ runId: 'unique-run', backends: readers.BACKENDS });
  const calls = prompt.split('\n').filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
  assert.equal(calls.length, 12);
  for (const backend of readers.BACKENDS) for (const scenario of ['a', 'b', 'c']) {
    const call = calls.find(call => call.name === `typed-${scenario}-${backend}`);
    assert.equal(call.subagent_type, 'relay:job'); assert.equal(call.run_in_background, true);
    assert.match(call.prompt, new RegExp('sleep ' + (scenario === 'a' ? 90 : 240)));
    assert.ok(call.prompt.includes(`model: ${readers.MODELS[backend]}`));
  }
  assert.match(prompt, /Wait until ALL 12 jobs are actually running/);
  assert.match(prompt, /Only acknowledge them in one line. Never send a message, stop or respawn an agent/);
  assert.ok(prompt.startsWith('Live suite run unique-run.'));
  assert.equal(typed.completed([{ type: 'user', message: { content: prompt } }]), false);
  assert.equal(typed.completed([{ type: 'assistant', message: { content: [{ type: 'text', text: typed.marker }] } }]), true);
  assert.equal(new Set(readers.BACKENDS.flatMap(b => ['A1', 'A2', 'B1', 'C1'].map(l => typedLine('unique-run', b, l)))).size, 16);
  assert.notEqual(typedLine('one', 'codex', 'A1'), typedLine('two', 'codex', 'A1'));
});

function navigation(dir, screens = json(path.join(fixture, 'screens.json'))) {
  const calls = [];
  const drive = args => { calls.push(args); if (args[0] === 'read') { assert.ok(screens.length, 'no blind extra screen reads'); return screens.shift(); } return ''; };
  return { ctx: { run: { pane: 'fixture-pane' }, evidenceDir: dir }, calls, drive, sleep: async () => {} };
}

test('typed navigation finds the named row and verifies every key against saved screens without Escape', async t => {
  const { dir } = setup(t), nav = navigation(dir);
  let sends = 0;
  await typeInView(nav.ctx, 'typed-a-codex', typedLine('synthetic-run', 'codex', 'A1'), { ...nav, beforeSend() { sends++; } });
  assert.equal(sends, 1);
  assert.deepEqual(nav.calls.filter(call => call[0] !== 'read'), [
    ...['Down', 'Down', 'Down', 'Enter', 'Up', 'Up', 'Up'].map(key => ['keys', 'fixture-pane', key]),
    ['send', 'fixture-pane', typedLine('synthetic-run', 'codex', 'A1')],
    ...['Down', 'Enter', 'Up'].map(key => ['keys', 'fixture-pane', key])]);
  assert.equal(nav.calls.filter(call => call[0] === 'read').length, 12);
  assert.equal(fs.readdirSync(dir).filter(file => file.startsWith('typed-')).length, 12);
});

test('typed C navigation interrupts only the focused relay prompt once and waits three seconds before sending', async t => {
  const { dir } = setup(t), nav = navigation(dir, json(path.join(fixture, 'screens-c.json'))), waits = [];
  await typeInView(nav.ctx, 'typed-c-codex', typedLine('synthetic-run', 'codex', 'C1'), {
    ...nav, interrupt: true, sleep: async ms => { waits.push(ms); }, beforeSend() {
      assert.equal(waits.filter(ms => ms === 3000).length, 1);
      assert.equal(nav.calls.filter(call => call.includes('Escape')).length, 1);
      assert.equal(nav.calls.filter(call => call[0] === 'read').length, 10);
    }
  });
  assert.deepEqual(nav.calls.filter(call => call[0] !== 'read'), [
    ...['Down', 'Down', 'Down', 'Enter', 'Up', 'Up', 'Up', 'Escape'].map(key => ['keys', 'fixture-pane', key]),
    ['send', 'fixture-pane', typedLine('synthetic-run', 'codex', 'C1')],
    ...['Down', 'Enter', 'Up'].map(key => ['keys', 'fixture-pane', key])]);
  assert.equal(nav.calls.filter(call => call[0] === 'read').length, 14);
});

for (const [label, index] of [['unfocused relay prompt', 7], ['missing Interrupted', 8], ['lost prompt after interrupt', 9]]) {
  test(`typed C navigation refuses to send with ${label}`, async t => {
    const { dir } = setup(t), screens = json(path.join(fixture, 'screens-c.json'));
    screens[index] = index === 8 ? screens[7] : 'unexpected screen';
    const nav = navigation(dir, screens);
    await assert.rejects(typeInView(nav.ctx, 'typed-c-codex', 'C1', { ...nav, interrupt: true }), /Navigation:/);
    assert.equal(nav.calls.filter(call => call.includes('Escape')).length, index < 8 ? 0 : 1);
    assert.equal(nav.calls.some(call => call[0] === 'send'), false);
    assert.equal(nav.calls.filter(call => call[0] === 'read').length, index + 1);
  });
}

for (const glyph of ['>', '›']) test(`typed navigation rejects guessed selection glyph ${glyph}`, async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  screens[1] = screens[1].replace('❯ ● main', `${glyph} ● main`);
  const nav = navigation(dir, screens);
  await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'A1', nav), /selector on main/);
  assert.equal(nav.calls.some(call => call[0] === 'send' || call.includes('Escape')), false);
});

for (const [label, index] of [['missing row', 0], ['wrong selection', 2], ['wrong view', 4], ['unfocused agent prompt', 7], ['wrong return view', 10], ['unfocused main prompt', 11]]) {
  test(`typed navigation saves the screen and stops without retries: ${label}`, async t => {
    const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
    screens[index] = label === 'missing row' ? screens[0].replaceAll('typed-a-codex', 'other') : 'unexpected screen';
    const nav = navigation(dir, screens);
    await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'line', nav), /Navigation:/);
    assert.equal(nav.calls.filter(call => call[0] === 'read').length, index + 1);
    assert.equal(nav.calls.some(call => call.includes('Escape')), false);
    if (index < 8) assert.equal(nav.calls.some(call => call[0] === 'send'), false);
  });
}

test('typed analysis proves exact delivery, both backend steer outcomes, hand-backs and timings without quoted reports', t => {
  const { input } = setup(t), analysis = typed.analyze(input);
  assert.deepEqual(analysis.results.map(row => [row.result, row.reason]), [['pass', null], ['pass', null]]);
  for (const row of analysis.results) assert.deepEqual(row.timings, { a1Seconds: [74], a2Seconds: [2], b1WakeSeconds: [2], c1Seconds: [4.3] });
  assert.equal(analysis.results[0].delivery, 'continue; assisted-steer:in-turn; interrupt-steer:in-turn');
  assert.equal(analysis.results[1].delivery, 'continue; assisted-steer:next-turn; interrupt-steer:next-turn');
  assert.equal(analysis.evidence.agents.length, 6); assert.equal(analysis.evidence.transcripts.length, 7);
  assert.match(typed.cell(analysis.results[0]), /74.0 s, a continue.*new turn in 2.0 s.*woken by hand: a steer in 2.0 s/);
  assert.match(typed.cell(analysis.results[1]), /\(next turn\)$/);
});

test('typed C analysis proves an interrupt steer in the running or next turn without a hand-back', t => {
  const { input } = setup(t), analysis = typed.analyze(input);
  for (const [i, delivery] of ['in-turn', 'next-turn'].entries()) {
    assert.equal(analysis.results[i].result, 'pass');
    assert.equal(analysis.details[i].c1.kind, 'steer');
    assert.equal(analysis.details[i].c1.delivery, delivery);
    assert.deepEqual(analysis.results[i].timings.c1Seconds, [4.3]);
    assert.match(typed.cell(analysis.results[i]), /typed after an interrupt: a steer in 4.3 s/);
  }
});

const failures = [
  ['missing marker', (dir) => editLines(dir, 'transcript.jsonl', rows => rows.splice(rows.findIndex(row => readers.hasMarker([row], typed.marker)), 1)), /marker/],
  ['wrong run', dir => edit(dir, 'run.json', run => { run.runId = 'other'; }), /run or marker/],
  ['duplicate relay', dir => editLines(dir, 'transcript.jsonl', rows => {
    const spawn = structuredClone(rows.find(row => row.message?.content?.[0]?.name === 'Agent'));
    spawn.message.content[0].id = 'extra'; rows.push(spawn, { type: 'user', toolUseResult: { agentId: 'extra-agent' }, message: { content: [{ type: 'tool_result', tool_use_id: 'extra', content: 'agentId: extra-agent' }] } });
  }), /three relays/],
  ['nonhuman origin', dir => editLines(dir, 'transcript/subagents/agent-a-codex.jsonl', rows => { rows[0].attachment.origin.kind = 'coordinator'; }), /human transcript/],
  ['duplicate human entry', dir => editLines(dir, 'transcript/subagents/agent-a-codex.jsonl', rows => rows.push({ ...rows[0], uuid: 'duplicate' })), /exactly one human/],
  ['wrong wrapped text', dir => editLines(dir, 'transcript/subagents/agent-a-codex.jsonl', rows => { rows[1].message.content += ' extra'; }), /human transcript/],
  ['wrong ledger uuid', dir => fs.renameSync(path.join(dir, A, 'inbox/relay/entry-A1-codex.json'), path.join(dir, A, 'inbox/relay/wrong.json')), /ledger record/],
  ['duplicate ledger', dir => fs.copyFileSync(path.join(dir, A, 'inbox/relay/entry-A1-codex.json'), path.join(dir, A, 'inbox/relay/duplicate.json')), /exactly one ledger/],
  ['unfinished ledger', dir => edit(dir, `${A}/inbox/relay/entry-A1-codex.json`, row => { row.status = 'posting'; }), /Incomplete delivery/],
  ['wrong inbox text', dir => edit(dir, `${A}/inbox/claimed/msg-A1-codex.json`, row => { row.text += ' changed'; }), /Inbox/],
  ['duplicate inbox', dir => fs.copyFileSync(path.join(dir, A, 'inbox/claimed/msg-A1-codex.json'), path.join(dir, A, 'inbox/duplicate.json')), /exactly once/],
  ['missing outcome', dir => fs.rmSync(path.join(dir, B, 'inbox/outcomes/msg-B1-codex.json')), /Cannot read/],
  ['wrong outcome turn', dir => edit(dir, `${B}/inbox/outcomes/msg-B1-codex.json`, row => { row.turnId = 'other'; }), /in-turn/],
  ['wrong attempt message', dir => edit(dir, `${A}/job.json`, row => { row.attempts[1].messageId = 'other'; }), /new attempt/],
  ['wrong version', dir => edit(dir, `${A}/job.json`, row => { row.attempts[1].relayVersion = 'other'; }), /relayVersion/],
  ['A1 typed after completion', dir => edit(dir, 'run.json', row => { row.typed.codex.A1.sentAt = '2026-10-22T10:01:31Z'; }), /active at the boundary/],
  ['A2 before hand-back', dir => edit(dir, 'run.json', row => { row.typed.codex.A2.sentAt = '2026-10-22T10:01:39Z'; }), /after the A1 hand-back/],
  ['A2 steered', dir => edit(dir, `${A}/inbox/relay/entry-A2-codex.json`, row => { row.kind = 'steer'; }), /Inbox|continue/],
  ['B1 not assisted', dir => edit(dir, 'run.json', row => { delete row.typed.codex.B1.assistance; }), /assisted steer/],
  ['ledger before wake', dir => edit(dir, 'run.json', row => { row.typed.codex.B1.wakeAt = '2026-10-22T10:00:29Z'; }), /timing/],
  ['B1 ledger after running attempt', dir => edit(dir, `${B}/job.json`, row => { row.attempts[0].endedAt = '2026-10-22T10:00:27Z'; }), /active at the boundary/],
  ['C1 continue instead of steer', dir => {
    edit(dir, `${C}/inbox/relay/entry-C1-codex.json`, row => { row.kind = 'continue'; });
    edit(dir, `${C}/inbox/claimed/msg-C1-codex.json`, row => { row.kind = 'continue'; });
  }, /C1 was not a steer/],
  ['C1 two ledger records', dir => fs.copyFileSync(path.join(dir, C, 'inbox/relay/entry-C1-codex.json'), path.join(dir, C, 'inbox/relay/duplicate.json')), /exactly one ledger/],
  ['C1 duplicate human entry', dir => editLines(dir, 'transcript/subagents/agent-c-codex.jsonl', rows => rows.push({ ...rows[0], uuid: 'duplicate' })), /exactly one human/],
  ['C1 duplicate inbox message', dir => fs.copyFileSync(path.join(dir, C, 'inbox/claimed/msg-C1-codex.json'), path.join(dir, C, 'inbox/duplicate.json')), /exactly once/],
  ['C1 ledger after running attempt', dir => edit(dir, `${C}/job.json`, row => { row.attempts[0].endedAt = '2026-10-22T10:00:39Z'; }), /active at the boundary/],
  ['C1 wrong outcome turn', dir => edit(dir, `${C}/inbox/outcomes/msg-C1-codex.json`, row => { row.turnId = 'other'; }), /in-turn steer for C1/],
  ['C no stop notice', dir => editLines(dir, 'transcript.jsonl', rows => {
    rows.splice(rows.findIndex(row => row.message?.content?.includes?.('<task-id>agent-c-codex</task-id>')), 1);
  }), /exactly one stopped by user notice for typed-c-codex/],
  ['C two stop notices', dir => editLines(dir, 'transcript.jsonl', rows => {
    rows.push(rows.find(row => row.message?.content?.includes?.('<task-id>agent-c-codex</task-id>')));
  }), /exactly one stopped by user notice for typed-c-codex/],
  ['C job cancelled', dir => edit(dir, `${C}/job.json`, row => { row.state = 'cancelled'; row.completedAt = '2026-10-22T10:01:00Z'; }), /cancelled before cleanup/],
  ['C attempt cancelled', dir => edit(dir, `${C}/job.json`, row => { row.attempts[0].state = 'cancelled'; }), /cancelled before cleanup/],
  ['missing hand-back', dir => fs.rmSync(path.join(dir, A, 'relay-handbacks.jsonl')), /relay-handbacks/],
  ['old final hand-back', dir => editLines(dir, `${A}/relay-handbacks.jsonl`, rows => rows.pop()), /completed hand-back/],
  ['wrong result', dir => editLines(dir, 'transcript.jsonl', rows => { rows.at(-2).message.content = rows.at(-2).message.content.replace('Acknowledged.', 'I forwarded it.'); }), /not the job result/],
  ['stopped A', dir => editLines(dir, 'transcript.jsonl', rows => rows.push({ type: 'user', message: { content: '<task-notification><task-id>agent-a-codex</task-id><summary>Agent "typed-a-codex" was stopped by user</summary></task-notification>' } })), /stopped by user/],
  ['stopped B', dir => editLines(dir, 'transcript.jsonl', rows => rows.push({ type: 'user', message: { content: '<task-notification><task-id>agent-b-codex</task-id><summary>Agent "typed-b-codex" was stopped by user</summary></task-notification>' } })), /stopped by user/],
  ['lead SendMessage', dir => editLines(dir, 'transcript.jsonl', rows => rows.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', id: 'send', input: { to: 'typed-a-codex', message: 'hello' } }] } })), /Lead sent/]
];
for (const [label, mutate, reason] of failures) test(`typed analysis rejects ${label}`, t => {
  const { dir, input } = setup(t); mutate(dir);
  const row = typed.analyze(input).results[0];
  assert.equal(row.result, 'fail'); assert.match(row.reason, reason);
});

test('typed analysis accepts A1 as an unassisted steer and matches text independently of record order', t => {
  const { dir, input } = setup(t);
  edit(dir, `${A}/inbox/relay/entry-A1-codex.json`, row => { row.kind = 'steer'; row.at = '2026-10-22T10:00:30Z'; row.postedAt = '2026-10-22T10:00:31Z'; });
  edit(dir, `${A}/inbox/claimed/msg-A1-codex.json`, row => { row.kind = 'steer'; });
  edit(dir, `${A}/inbox/outcomes/msg-A1-codex.json`, row => { row.action = 'steered'; row.turnId = 'turn-a-codex-1'; delete row.attempt; });
  editLines(dir, 'transcript/subagents/agent-a-codex.jsonl', rows => rows.reverse());
  const row = typed.analyze(input).results[0];
  assert.equal(row.result, 'pass'); assert.match(row.delivery, /^steer;/);
});

test('typed evidence copy replays after the original transcripts and jobs are removed', t => {
  const { dir, input } = setup(t), analysis = typed.analyze(input);
  const run = { ...json(path.join(dir, 'run.json')), ...input };
  run.copy = copyEvidence(run, analysis, dir); write(path.join(dir, 'run.json'), run);
  fs.rmSync(input.jobsHome, { recursive: true }); fs.rmSync(input.transcript); fs.rmSync(path.join(dir, 'transcript'), { recursive: true });
  assert.deepEqual(typed.analyze({ ...input, transcript: run.copy.transcript, jobsHome: run.copy.jobsHome }).results, analysis.results);
});

function terminal(t, { failure, pendingB = true, pendingC = true, backends = ['codex'] } = {}) {
  const { dir, input } = setup(t), savedA = json(path.join(dir, A, 'job.json')), savedB = json(path.join(dir, B, 'job.json')), savedC = json(path.join(dir, C, 'job.json'));
  const main = readers.readTranscript(input.transcript), handbacks = readers.readTranscript(path.join(dir, A, 'relay-handbacks.jsonl'));
  const relay = readers.readTranscript(path.join(dir, 'transcript/subagents/agent-a-codex.jsonl'));
  let time = Date.parse('2026-10-22T10:00:20Z'), screens = [], sends = 0;
  const calls = [];
  const running = job => ({ ...job, state: 'running', attempts: [{ ...job.attempts[0], state: 'running', endedAt: null }] });
  write(path.join(dir, A, 'job.json'), running(savedA)); write(path.join(dir, B, 'job.json'), running(savedB));
  write(path.join(dir, C, 'job.json'), running(savedC));
  lines(path.join(dir, A, 'relay-handbacks.jsonl'), []);
  lines(input.transcript, main.filter(row => row.origin?.kind !== 'task-notification'));
  lines(path.join(dir, 'transcript/subagents/agent-a-codex.jsonl'), []);
  const run = { ...input, backends, pane: 'fixture-pane', timeoutMinutes: failure === 'timeout' ? 0.01 : typed.timeoutMinutes };
  const ctx = { ...input, timeoutMinutes: run.timeoutMinutes, run, save() { write(path.join(dir, 'run.json'), run); },
    async paneDriver(value, check, overrides) {
      calls.push(['paneDriver']); assert.equal(value, ctx); assert.equal(check, typed); assert.equal(overrides.keep, true);
      assert.equal(typeof overrides.drive, 'function');
      if (failure === 'driver') throw new Error('Driver failed.');
      if (failure === 'marker') lines(input.transcript, []);
      run.completed = true;
    } };
  const controller = new AbortController();
  const dependencies = { signal: controller.signal, now: () => time, sleep: async ms => {
    if (failure === 'timeout' || ms === 3000) time += ms;
  }, drive(args) {
    calls.push(args);
    if (args[0] === 'read') {
      if (!screens.length) {
        screens = json(path.join(fixture, sends === 2 ? 'screens-c.json' : 'screens.json'));
        if (sends === 1) screens = screens.map(screen => screen.replaceAll('typed-a-codex', 'typed-b-codex'));
        if (failure === 'navigation') screens[0] = 'unexpected';
      }
      return screens.shift();
    }
    if (args[0] === 'send') {
      sends++;
      if (args[2].includes(' A1 ')) time = Date.parse('2026-10-22T10:00:25Z');
      if (args[2].includes(' B1 ')) time = Date.parse('2026-10-22T10:00:26Z');
      if (args[2].includes(' C1 ')) {
        if (!pendingC) write(path.join(dir, C, 'job.json'), savedC);
        time = Date.parse('2026-10-22T10:01:50Z');
      }
      if (args[2].includes(' A2 ')) {
        write(path.join(dir, A, 'job.json'), savedA); lines(path.join(dir, A, 'relay-handbacks.jsonl'), handbacks);
        lines(input.transcript, main); lines(path.join(dir, 'transcript/subagents/agent-a-codex.jsonl'), relay);
        time = Date.parse('2026-10-22T10:02:00Z');
      }
    }
    return '';
  }, async companionRunner(value, args) {
    assert.equal(value, ctx); calls.push(args);
    if (args[0] === 'wake') {
      assert.deepEqual(args, ['wake', '--agent', 'agent-b-codex']);
      if (failure === 'wake') throw new Error('Wake failed.');
      if (failure === 'interrupt') controller.abort(new Error('Interrupted.'));
      write(path.join(dir, A, 'job.json'), { ...savedA, attempts: savedA.attempts.slice(0, 2) });
      lines(path.join(dir, A, 'relay-handbacks.jsonl'), handbacks.slice(0, 1));
      lines(path.join(dir, 'transcript/subagents/agent-a-codex.jsonl'), relay.slice(0, 1));
      lines(input.transcript, main.filter(row => Date.parse(row.timestamp) < Date.parse('2026-10-22T10:01:50Z')));
      if (!pendingB) write(path.join(dir, B, 'job.json'), savedB);
      time = Date.parse('2026-10-22T10:00:32Z');
    }
    if (args[0] === 'cancel') {
      assert.ok([path.join(dir, B), path.join(dir, C)].includes(args[1]));
      const job = json(path.join(args[1], 'job.json')), at = new Date(time).toISOString();
      write(path.join(args[1], 'job.json'), { ...job, state: 'cancelled', completedAt: at,
        attempts: job.attempts.map(attempt => ({ ...attempt, state: 'cancelled', endedAt: at })) });
    }
    return '';
  } };
  return { ctx, dependencies, calls, dir };
}

for (const pendingB of [true, false]) for (const pendingC of [true, false]) test(`typed terminal keeps driving after the marker and closes the pane (B running=${pendingB}, C running=${pendingC})`, async t => {
  const { ctx, dependencies, calls } = terminal(t, { pendingB, pendingC });
  const result = await typed.runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass');
  assert.equal(ctx.run.completed, true); assert.ok(ctx.run.checkFinishedAt);
  assert.deepEqual(calls.filter(call => call[0] === 'send').map(call => call[2]), ['A1', 'B1', 'C1', 'A2'].map(line => typedLine('synthetic-run', 'codex', line)));
  assert.equal(calls.filter(call => call[0] === 'wake').length, 1);
  assert.equal(calls.filter(call => call[0] === 'cancel').length, Number(pendingB) + Number(pendingC));
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
  assert.equal(calls.filter(call => call.includes('Escape')).length, 1);
  assert.equal(typed.analyze(ctx).results[0].result, 'pass');
  assert.equal(ctx.run.typed.codex.B1.assistance, 'manual-wake');
});

for (const failure of ['driver', 'marker', 'navigation', 'wake', 'interrupt', 'timeout']) {
  test(`typed terminal records failure and always stops the pane: ${failure}`, async t => {
    const { ctx, dependencies, calls } = terminal(t, { failure });
    await assert.rejects(typed.runTerminal(ctx, dependencies));
    assert.equal(ctx.run.completed, false); assert.ok(ctx.run.error);
    assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
    if (['navigation', 'wake', 'interrupt', 'timeout'].includes(failure)) assert.equal(calls.filter(call => call[0] === 'cancel').length, 2);
  });
}

test('typed terminal scales the default timeout by backend count before starting the pane', async t => {
  const { ctx, dependencies } = terminal(t, { failure: 'driver', backends: readers.BACKENDS });
  await assert.rejects(typed.runTerminal(ctx, dependencies), /Driver failed/);
  assert.equal(ctx.timeoutMinutes, 40); assert.equal(ctx.run.timeoutMinutes, 40);
});

for (const backend of ['grok', 'zcode']) test(`typed analysis verifies ${backend} steers into the running turn`, t => {
  const { dir, input } = setup(t);
  for (const file of readers.filesUnder(dir, file => /\.(json|jsonl)$/.test(file) && !file.endsWith('screens.json'))) {
    let text = fs.readFileSync(file, 'utf8');
    text = text.replaceAll('typed-a-codex', `typed-a-${backend}`).replaceAll('typed-b-codex', `typed-b-${backend}`).replaceAll('typed-c-codex', `typed-c-${backend}`)
      .replaceAll('for codex in', `for ${backend} in`).replaceAll('backend: codex', `backend: ${backend}`)
      .replaceAll('gpt-6.1-sol', readers.MODELS[backend]).replaceAll('"codex"', JSON.stringify(backend));
    fs.writeFileSync(file, text);
  }
  const row = typed.analyze({ ...input, backends: [backend] }).results[0];
  assert.equal(row.result, 'pass', row.reason); assert.equal(row.delivery, 'continue; assisted-steer:in-turn; interrupt-steer:in-turn');
});

test('typed analysis preserves a terminal navigation failure even when delivery evidence passes', t => {
  const { dir, input } = setup(t);
  edit(dir, 'run.json', run => { run.error = 'Navigation: expected the main prompt.'; });
  assert.ok(typed.analyze(input).results.every(row => row.result === 'fail' && row.reason.startsWith('Navigation:')));
});

test('typed failed evidence remains replayable after copying', t => {
  const { dir, input } = setup(t);
  edit(dir, `${A}/inbox/claimed/msg-A1-codex.json`, row => { row.text += ' wrong'; });
  const analysis = typed.analyze(input), run = { ...json(path.join(dir, 'run.json')), ...input };
  run.copy = copyEvidence(run, analysis, dir); write(path.join(dir, 'run.json'), run);
  fs.rmSync(input.jobsHome, { recursive: true }); fs.rmSync(input.transcript); fs.rmSync(path.join(dir, 'transcript'), { recursive: true });
  assert.deepEqual(typed.analyze({ ...input, transcript: run.copy.transcript, jobsHome: run.copy.jobsHome }).results, analysis.results);
});
