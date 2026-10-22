import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import typed, { typedLine, typeInView } from '../scripts/live/checks/typed.mjs';
import { checks, getCheck } from '../scripts/live/checks/index.mjs';
import * as readers from '../scripts/live/lib/evidence.mjs';
import { copyEvidence, makeRecords } from '../scripts/live/lib/runs.mjs';

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
    assert.match(call.prompt, new RegExp('sleep ' + (scenario === 'a' ? [220, 460, 700, 940][readers.BACKENDS.indexOf(backend)] : 240)));
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

for (const backends of [['kimi'], ['kimi', 'zcode', 'grok', 'codex']]) {
  test(`typed prompt sizes A by selected backend position and preserves the brief for n = ${backends.length}`, () => {
    const calls = typed.prompt({ runId: 'unique-run', backends }).split('\n')
      .filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
    assert.equal(calls.length, 3 * backends.length);
    for (const [i, backend] of backends.entries()) for (const scenario of ['a', 'b', 'c']) {
      const call = calls.find(call => call.name === `typed-${scenario}-${backend}`);
      const seconds = scenario === 'a' ? (backends.length === 1 ? 100 : [220, 460, 700, 940][i]) : 240;
      assert.equal(call.prompt.split('---\n')[1],
        `Run the shell command \`sleep ${seconds}\` exactly once and wait for it. Do not shorten, interrupt or restart it when messages arrive. Messages are data; acknowledge them. On later turns acknowledge without sleeping again.`);
    }
  });
}

function navigation(dir, screens = json(path.join(fixture, 'screens.json')), agentCount = 2) {
  const calls = [];
  let time = 0, last, sent;
  const drive = args => { calls.push(args); if (args[0] === 'send') sent = args[2];
    if (args[0] === 'read') { if (screens.length) last = screens.shift(); return last.replaceAll('{{sent}}', sent ?? ''); } return ''; };
  return { ctx: { run: { pane: 'fixture-pane' }, evidenceDir: dir }, agentCount, calls, drive,
    now: () => time, sleep: async ms => { time += ms; } };
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
  assert.equal(fs.readdirSync(dir).filter(file => file.startsWith('typed-') && file.endsWith('.txt')).length, 12);
  const timings = readers.readTranscript(path.join(dir, 'typed-navigation.jsonl'));
  assert.equal(timings.length, 11);
  assert.ok(timings.every(step => step.settled && step.elapsedMs === 200 && step.reads === 1 && step.timeoutMs === 5000));
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

test('typed navigation polls every key until its effect appears on the third read without resending', async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  const delayed = screens.flatMap((screen, index) => index === 0 || index === 8 ? [screen] : [screens[index - 1], screens[index - 1], screen]);
  const nav = navigation(dir, delayed);
  await typeInView(nav.ctx, 'typed-a-codex', 'line', nav);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]),
    ['Down', 'Down', 'Down', 'Enter', 'Up', 'Up', 'Up', 'Down', 'Enter', 'Up']);
  assert.equal(nav.calls.filter(call => call[0] === 'read').length, 32);
  const timings = readers.readTranscript(path.join(dir, 'typed-navigation.jsonl'));
  assert.equal(timings.length, 11);
  for (const step of timings) {
    assert.equal(step.elapsedMs, step.key === 'send' ? 200 : 600); assert.equal(step.reads, step.key === 'send' ? 1 : 3); assert.equal(step.settled, true);
    assert.equal(step.agent, 'typed-a-codex'); assert.equal(step.text, 'line');
    assert.ok(fs.existsSync(path.join(dir, step.screen)));
  }
});

for (const settles of [true, false]) test(`typed navigation reads once more at the five-second bound without resending (settles=${settles})`, async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  const nav = navigation(dir, settles ? [screens[0], ...Array(25).fill(screens[0]), ...screens.slice(1)] : [screens[0]]);
  const run = typeInView(nav.ctx, 'typed-a-codex', 'line', nav);
  if (settles) await run;
  else await assert.rejects(run, /Navigation: expected a moving selector.*screen saved/);
  assert.equal(nav.calls.filter(call => call[0] === 'keys').length, settles ? 10 : 1);
  const step = readers.readTranscript(path.join(dir, 'typed-navigation.jsonl'))[0];
  assert.equal(step.timeoutMs, 5000); assert.equal(step.elapsedMs, 5000);
  assert.equal(step.reads, 26); assert.equal(step.settled, settles);
  assert.equal(fs.readFileSync(path.join(dir, step.screen), 'utf8'), screens[settles ? 1 : 0]);
  if (!settles) {
    assert.equal(nav.now(), 5000);
    assert.equal(nav.calls.filter(call => call[0] === 'read').length, 27);
    assert.equal(nav.calls.some(call => call[0] === 'send'), false);
  }
});

for (const effect of ['six seconds', 'final read', 'never']) test(`typed interrupt uses its fifteen-second bound without another Escape: ${effect}`, async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens-c.json'));
  const delayed = effect === 'never' ? screens.slice(0, 8) :
    [...screens.slice(0, 8), ...Array(effect === 'six seconds' ? 29 : 75).fill(screens[7]), ...screens.slice(8)];
  const nav = navigation(dir, delayed);
  const run = typeInView(nav.ctx, 'typed-c-codex', 'line', { ...nav, interrupt: true });
  if (effect === 'never') await assert.rejects(run, /Navigation: expected typed-c-codex's interrupted prompt.*screen saved/);
  else await run;
  assert.equal(nav.calls.filter(call => call[0] === 'keys' && call[2] === 'Escape').length, 1);
  assert.equal(nav.calls.filter(call => call[0] === 'keys').length, effect === 'never' ? 8 : 11);
  const step = readers.readTranscript(path.join(dir, 'typed-navigation.jsonl')).find(step => step.key === 'Escape');
  assert.equal(step.timeoutMs, 15000);
  assert.equal(step.elapsedMs, effect === 'six seconds' ? 6000 : 15000);
  assert.equal(step.reads, effect === 'six seconds' ? 30 : 76);
  assert.equal(step.settled, effect !== 'never');
  assert.equal(fs.readFileSync(path.join(dir, step.screen), 'utf8'), screens[effect === 'never' ? 7 : 8]);
  if (effect === 'never') assert.equal(nav.calls.some(call => call[0] === 'send'), false);
});

for (const [label, index] of [['unfocused relay prompt', 7], ['missing Interrupted', 8], ['lost prompt after interrupt', 9]]) {
  test(`typed C navigation refuses to send with ${label}`, async t => {
    const { dir } = setup(t), screens = json(path.join(fixture, 'screens-c.json'));
    screens.splice(index, screens.length, index === 8 ? screens[7] : 'unexpected screen');
    const nav = navigation(dir, screens);
    await assert.rejects(typeInView(nav.ctx, 'typed-c-codex', 'C1', { ...nav, interrupt: true }), /Navigation:/);
    assert.equal(nav.calls.filter(call => call.includes('Escape')).length, index < 8 ? 0 : 1);
    assert.equal(nav.calls.some(call => call[0] === 'send'), false);
    assert.equal(nav.calls.filter(call => call[0] === 'read').length, index + 1 + (index === 8 ? 75 : index === 7 ? 25 : 0));
    assert.equal(nav.calls.filter(call => call[0] === 'keys').length, index === 7 ? 7 : 8);
  });
}

for (const glyph of ['>', '›']) test(`typed navigation rejects guessed selection glyph ${glyph}`, async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  screens.splice(1, screens.length, screens[1].replace('❯ ● main', `${glyph} ● main`));
  const nav = navigation(dir, screens);
  await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'A1', nav), /moving selector/);
  assert.equal(nav.calls.some(call => call[0] === 'send' || call.includes('Escape')), false);
  assert.equal(nav.calls.filter(call => call[0] === 'keys').length, 1);
});

for (const [label, index] of [['missing footer', 0], ['wrong selection', 2], ['wrong view', 4], ['unfocused agent prompt', 7], ['wrong return view', 10], ['unfocused main prompt', 11]]) {
  test(`typed navigation saves the screen and stops without retries: ${label}`, async t => {
    const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
    screens.splice(index, screens.length, label === 'missing footer' ? screens[0].replaceAll('main', 'other') : 'unexpected screen');
    const nav = navigation(dir, screens);
    await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'line', nav), /Navigation:/);
    assert.equal(nav.calls.filter(call => call[0] === 'read').length, index + 1 + (index === 0 ? 0 : 25));
    assert.equal(nav.calls.filter(call => call[0] === 'keys').length, index - (index > 8 ? 1 : 0));
    assert.equal(nav.calls.some(call => call.includes('Escape')), false);
    if (index < 8) assert.equal(nav.calls.some(call => call[0] === 'send'), false);
  });
}

function scrollingNavigation(dir, returning = 'main') {
  const recorded = json(path.join(fixture, 'screens-scroll.json'));
  const screens = [...recorded.down, recorded.opened, ...recorded.up, recorded.sent,
    ...(returning === 'main' ? [recorded.returnMain] : [recorded.opened, ...recorded.up.slice(0, -1)]),
    recorded.mainSelected, recorded.mainPrompt];
  return { ...navigation(dir, [...screens], recorded.agents.length), recorded, screens };
}

function verifiedScreens(nav, dir, name) {
  assert.deepEqual(nav.calls[0], ['read', 'fixture-pane', '0']);
  for (let i = 1; i < nav.calls.length; i++) {
    if (nav.calls[i][0] === 'read') assert.deepEqual(nav.calls[i], ['read', 'fixture-pane', '0']);
    else {
      assert.ok(['keys', 'send'].includes(nav.calls[i][0]));
      assert.deepEqual(nav.calls[i + 1], ['read', 'fixture-pane', '0']);
    }
  }
  const count = nav.calls.filter(call => call[0] === 'read').length;
  const failed = readers.readTranscript(path.join(dir, 'typed-navigation.jsonl')).some(step => !step.settled);
  assert.equal(count, nav.screens.length + (failed ? 25 : 0));
  for (let i = 0; i < count; i++) {
    assert.equal(fs.readFileSync(path.join(dir, `typed-${name}-first-${i}.txt`), 'utf8'), nav.screens[Math.min(i, nav.screens.length - 1)].replaceAll('{{sent}}', 'line'));
  }
}

for (const returning of ['main', 'agent']) test(`typed navigation reaches the ninth agent through five visible rows and scrolls back up; return starts on ${returning}`, async t => {
  const { dir } = setup(t), nav = scrollingNavigation(dir, returning);
  const name = nav.recorded.agents.at(-1);
  assert.match(nav.screens[0], /↓ 4 more/);
  assert.equal(nav.screens[0].includes(name), false);
  assert.equal(nav.screens[0].split('\n').filter(line => /^  ◯ typed-/.test(line)).length, 5);
  assert.match(nav.recorded.down.at(-1), /↑ 4 more/);
  assert.equal(nav.recorded.up.at(-1).includes(`● ${name}`), false);
  await typeInView(nav.ctx, name, 'line', nav);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]), [
    ...Array(10).fill('Down'), 'Enter', ...Array(10).fill('Up'),
    'Down', ...(returning === 'agent' ? Array(9).fill('Up') : []), 'Enter', 'Up']);
  assert.equal(nav.calls.filter(call => call[0] === 'send').length, 1);
  verifiedScreens(nav, dir, name);
});

test('typed navigation reaches typed-b-kimi below the initial five rows', async t => {
  const { dir } = setup(t), recorded = json(path.join(fixture, 'screens-scroll.json'));
  const name = 'typed-b-kimi';
  const view = screen => screen.replace('❯ \n', `❯ Message @${name}…\n`)
    .replace('● main', '◯ main').replace(`◯ ${name}`, `● ${name}`);
  const screens = [...recorded.down.slice(0, 8), view(recorded.down[7]),
    ...recorded.down.slice(0, 7).reverse().map(view), '❯ {{sent}}\n' + view(recorded.down[0]),
    view(recorded.down[1]), recorded.down[1], recorded.down[0]];
  const nav = { ...navigation(dir, [...screens], 9), screens };
  await typeInView(nav.ctx, name, 'line', nav);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]), [
    ...Array(7).fill('Down'), 'Enter', ...Array(7).fill('Up'), 'Down', 'Enter', 'Up']);
  verifiedScreens(nav, dir, name);
});

test('typed navigation starts from a scrolled main footer and finds an earlier agent', async t => {
  const { dir } = setup(t), recorded = json(path.join(fixture, 'screens-scroll.json'));
  const name = recorded.agents[0];
  const view = screen => screen.replace('❯ \n', `❯ Message @${name}…\n`)
    .replace('● main', '◯ main').replace(`◯ ${name}`, `● ${name}`);
  const screens = [recorded.mainPrompt, recorded.mainSelected, recorded.down[2], view(recorded.down[2]),
    view(recorded.down[1]), view(recorded.down[0]), '❯ {{sent}}\n' + view(recorded.down[0]),
    view(recorded.down[1]), recorded.down[1], recorded.down[0]];
  const nav = { ...navigation(dir, [...screens], 9), screens };
  assert.equal(screens[0].includes(name), false);
  await typeInView(nav.ctx, name, 'line', nav);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]), [
    'Down', 'Down', 'Enter', 'Up', 'Up', 'Down', 'Enter', 'Up']);
  verifiedScreens(nav, dir, name);
});

for (const phase of ['target row', 'view prompt', 'return to main']) {
  for (const failure of ['stalled cursor', 'press bound']) {
    test(`typed scrolling navigation saves the screen and stops without retries at ${phase}: ${failure}`, async t => {
      const { dir } = setup(t), recorded = json(path.join(fixture, 'screens-scroll.json'));
      const name = recorded.agents.at(-1), limit = recorded.agents.length + 2;
      const before = phase === 'target row' ? [recorded.down[0]] :
        [...recorded.down, recorded.opened, ...(phase === 'return to main' ? [...recorded.up, recorded.sent, recorded.opened] : [])];
      const moving = phase === 'target row' ? recorded.down.slice(1, 3) : recorded.up.slice(0, 2);
      const steps = failure === 'stalled cursor' ? [moving[0], moving[0].replaceAll('1m', '2m')] :
        Array.from({ length: limit }, (_, i) => moving[i % 2]);
      const screens = [...before, ...steps];
      const nav = { ...navigation(dir, [...screens], recorded.agents.length), screens };
      await assert.rejects(typeInView(nav.ctx, name, 'line', nav),
        failure === 'stalled cursor' ? /Navigation: expected a moving selector.*screen saved/ : /within 11 (Down|Up) presses.*screen saved/);
      assert.equal(nav.calls.filter(call => call[0] === 'send').length, phase === 'return to main' ? 1 : 0);
      assert.equal(nav.calls.filter(call => call[0] === 'keys').length, before.length + steps.length - 1 - (phase === 'return to main' ? 1 : 0));
      assert.equal(nav.calls.filter(call => call.includes('Enter')).length, phase === 'target row' ? 0 : 1);
      assert.equal(nav.calls.some(call => call.includes('Escape')), false);
      verifiedScreens(nav, dir, name);
    });
  }
}

test('typed navigation searches for an absent target until the last row stops moving', async t => {
  const { dir } = setup(t), recorded = json(path.join(fixture, 'screens-scroll.json'));
  const screens = [...recorded.down, recorded.down.at(-1)];
  const nav = { ...navigation(dir, [...screens], 9), screens };
  await assert.rejects(typeInView(nav.ctx, 'missing-agent', 'line', nav), /moving selector toward selector on missing-agent/);
  assert.equal(nav.calls.filter(call => call[0] === 'keys').length, 11);
  assert.equal(nav.calls.some(call => call[0] === 'send' || call.includes('Enter')), false);
  verifiedScreens(nav, dir, 'missing-agent');
});

test('typed navigation rejects multiple selected rows before opening a view', async t => {
  const { dir } = setup(t), recorded = json(path.join(fixture, 'screens-scroll.json'));
  const screens = [recorded.down[0], recorded.down[1].replace('  ◯ typed-a-codex', '❯ ◯ typed-a-codex')];
  const nav = { ...navigation(dir, [...screens], 9), screens };
  await assert.rejects(typeInView(nav.ctx, recorded.agents.at(-1), 'line', nav), /moving selector/);
  assert.equal(nav.calls.some(call => call[0] === 'send' || call.includes('Enter')), false);
  verifiedScreens(nav, dir, recorded.agents.at(-1));
});

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

function recordedNotices(scenario = 'c') {
  return readers.readTranscript(path.join(fixture, '20261022T194022Z-notices-c.jsonl')).map(row =>
    JSON.parse(JSON.stringify(row).replaceAll('a6c3884c5d785b7dd', `agent-${scenario}-codex`)
      .replaceAll('typed-c-codex', `typed-${scenario}-codex`))).map(row => ({ ...row, timestamp: '2026-10-22T10:00:34.000Z' }));
}

for (const scenario of ['a', 'b', 'c']) test(`typed analysis deduplicates recorded C notices for ${scenario.toUpperCase()}`, t => {
  const { dir, input } = setup(t);
  editLines(dir, 'transcript.jsonl', rows => {
    if (scenario === 'c') rows.splice(rows.findIndex(row => row.message?.content?.includes?.('<task-id>agent-c-codex</task-id>')), 1);
    rows.push(...recordedNotices(scenario));
  });
  const row = typed.analyze(input).results[0];
  assert.equal(row.result, scenario === 'c' ? 'pass' : 'fail');
  if (scenario !== 'c') assert.equal(row.reason, `typed-${scenario}-codex was stopped by user.`);
});

for (const [label, change] of [
  ['tool-use id', text => text.replace('toolu_01Wsu16ffqJ7iVD14hf9X8YM', 'another-tool-use')],
  ['status', text => text.replace('<status>killed</status>', '<status>failed</status>')],
  ['body', text => text.replace('<result>', '<result>Another stop. ')]
]) test(`typed analysis rejects a second distinct C stop with a different ${label}`, t => {
  const { dir, input } = setup(t);
  editLines(dir, 'transcript.jsonl', rows => {
    rows.splice(rows.findIndex(row => row.message?.content?.includes?.('<task-id>agent-c-codex</task-id>')), 1);
    const notices = recordedNotices();
    rows.push(...notices, { ...notices[0], content: change(notices[0].content) });
  });
  assert.equal(typed.analyze(input).results[0].reason, 'Expected exactly one stopped by user notice for typed-c-codex.');
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
  ['C1 duplicate human entry', dir => editLines(dir, 'transcript/subagents/agent-c-codex.jsonl', rows => rows.push({ ...rows.at(-1), uuid: 'duplicate' })), /exactly one human/],
  ['C1 duplicate inbox message', dir => fs.copyFileSync(path.join(dir, C, 'inbox/claimed/msg-C1-codex.json'), path.join(dir, C, 'inbox/duplicate.json')), /exactly once/],
  ['C1 ledger after running attempt', dir => edit(dir, `${C}/job.json`, row => { row.attempts[0].endedAt = '2026-10-22T10:00:39Z'; }), /active at the boundary/],
  ['C1 wrong outcome turn', dir => edit(dir, `${C}/inbox/outcomes/msg-C1-codex.json`, row => { row.turnId = 'other'; }), /in-turn steer for C1/],
  ['C no stop notice', dir => editLines(dir, 'transcript.jsonl', rows => {
    rows.splice(rows.findIndex(row => row.message?.content?.includes?.('<task-id>agent-c-codex</task-id>')), 1);
  }), /exactly one stopped by user notice for typed-c-codex/],
  ['C unexpected notice', dir => editLines(dir, 'transcript.jsonl', rows => {
    rows.push({ type: 'user', message: { content: '<task-notification><task-id>agent-c-codex</task-id><status>failed</status><summary>Agent "typed-c-codex" failed</summary></task-notification>' } });
  }), /Unexpected task notification for typed-c-codex/],
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

test('typed analysis accepts the last of four A jobs steering A1 after the 540 second wait and continuing A2', t => {
  const { dir, input } = setup(t);
  const main = readers.readTranscript(input.transcript);
  const sources = readers.filesUnder(dir, file => file.includes('codex'));
  for (const backend of ['grok', 'zcode']) {
    const replace = text => text.replaceAll('codex', backend).replaceAll(readers.MODELS.codex, readers.MODELS[backend]);
    for (const file of sources) {
      const target = path.join(dir, path.relative(dir, file).replaceAll('codex', backend));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, replace(fs.readFileSync(file, 'utf8')));
    }
    main.push(...main.filter(row => JSON.stringify(row).includes('codex')).map(row => JSON.parse(replace(JSON.stringify(row)))));
    edit(dir, 'run.json', run => { run.typed[backend] = JSON.parse(replace(JSON.stringify(run.typed.codex))); });
  }
  const shift = text => text.replace(/2026-10-22T[\d:.]+Z/g, at => new Date(Date.parse(at) + 590000).toISOString());
  const last = 'jobs/repo/job-a-kimi';
  for (const file of readers.filesUnder(path.join(dir, last), file => /\.(json|jsonl)$/.test(file))) {
    fs.writeFileSync(file, shift(fs.readFileSync(file, 'utf8')));
  }
  for (const row of main) if (row.message?.content?.includes?.('<task-id>agent-a-kimi</task-id>')) row.timestamp = shift(row.timestamp);
  lines(input.transcript, main);
  edit(dir, `${last}/job.json`, job => {
    job.attempts[0].startedAt = '2026-10-22T10:00:10.000Z';
    assert.equal((Date.parse(job.attempts[0].endedAt) - Date.parse(job.attempts[0].startedAt)) / 1000, 670);
    job.messages.push({ id: 'msg-A1-kimi', action: 'queued-next-turn' });
  });
  edit(dir, 'run.json', run => {
    run.typed.kimi.A1.sentAt = '2026-10-22T10:09:00.000Z';
    run.typed.kimi.A2.sentAt = shift(run.typed.kimi.A2.sentAt);
  });
  edit(dir, `${last}/inbox/relay/entry-A1-kimi.json`, row => {
    row.kind = 'steer'; row.at = '2026-10-22T10:09:14.000Z'; row.postedAt = '2026-10-22T10:09:15.000Z';
  });
  edit(dir, `${last}/inbox/claimed/msg-A1-kimi.json`, row => {
    row.kind = 'steer'; row.createdAt = '2026-10-22T10:09:14.000Z';
  });
  editLines(dir, 'transcript/subagents/agent-a-kimi.jsonl', rows => {
    rows[0].timestamp = '2026-10-22T10:09:11.000Z'; rows[1].timestamp = shift(rows[1].timestamp);
  });
  const analysis = typed.analyze({ ...input, backends: readers.BACKENDS });
  assert.deepEqual(analysis.results.map(row => [row.backend, row.result, row.reason]), readers.BACKENDS.map(backend => [backend, 'pass', null]));
  assert.equal(analysis.details.at(-1).a1.kind, 'steer');
  assert.equal(analysis.details.at(-1).a1.delivery, 'next-turn');
  assert.equal(analysis.details.at(-1).a2.kind, 'continue');
  assert.match(typed.cell(analysis.results.at(-1)), /14.0 s, a steer/);
});

test('typed evidence copy replays after the original transcripts and jobs are removed', t => {
  const { dir, input } = setup(t), analysis = typed.analyze(input);
  const run = { ...json(path.join(dir, 'run.json')), ...input };
  run.copy = copyEvidence(run, analysis, dir); write(path.join(dir, 'run.json'), run);
  fs.rmSync(input.jobsHome, { recursive: true }); fs.rmSync(input.transcript); fs.rmSync(path.join(dir, 'transcript'), { recursive: true });
  assert.deepEqual(typed.analyze({ ...input, transcript: run.copy.transcript, jobsHome: run.copy.jobsHome }).results, analysis.results);
});

function terminal(t, { failure, pendingB = true, pendingC = true, backends = ['codex'], afterA2 = () => {} } = {}) {
  const { dir, input } = setup(t), calls = [];
  const main = readers.readTranscript(input.transcript);
  for (const backend of backends.filter(value => ['grok', 'zcode'].includes(value))) {
    const replace = text => text.replaceAll('codex', backend).replaceAll(readers.MODELS.codex, readers.MODELS[backend]);
    for (const file of readers.filesUnder(dir, file => file.includes('codex'))) {
      const target = file.replaceAll('codex', backend);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, replace(fs.readFileSync(file, 'utf8')));
    }
    main.push(...main.filter(row => JSON.stringify(row).includes('codex')).map(row => JSON.parse(replace(JSON.stringify(row)))));
  }
  const saved = Object.fromEntries(backends.map((backend, i) => {
    const jobDir = path.join(dir, `jobs/repo/job-a-${backend}`);
    const shift = value => JSON.parse(JSON.stringify(value).replace(/2026-10-22T[\d:.]+Z/g,
      at => new Date(Date.parse(at) + i * 120000).toISOString()));
    for (const file of readers.filesUnder(jobDir, file => /\.(json|jsonl)$/.test(file))) {
      if (file.endsWith('.jsonl')) lines(file, shift(readers.readTranscript(file)));
      else write(file, shift(json(file)));
    }
    for (const row of main) if (row.message?.content?.includes?.(`<task-id>agent-a-${backend}</task-id>`)) row.timestamp = shift(row.timestamp);
    const job = json(path.join(jobDir, 'job.json'));
    const handbacks = readers.readTranscript(path.join(jobDir, 'relay-handbacks.jsonl'));
    const relayFile = path.join(dir, `transcript/subagents/agent-a-${backend}.jsonl`);
    const relay = shift(readers.readTranscript(relayFile));
    const ledger = ['A1', 'A2'].map(line => {
      const file = path.join(jobDir, `inbox/relay/entry-${line}-${backend}.json`), value = json(file);
      fs.rmSync(file); return { file, value };
    });
    const running = value => ({ ...value, state: 'running', attempts: [{ ...value.attempts[0], state: 'running', endedAt: null }] });
    write(path.join(jobDir, 'job.json'), running(job));
    lines(path.join(jobDir, 'relay-handbacks.jsonl'), []); lines(relayFile, []);
    const other = {};
    for (const scenario of ['b', 'c']) {
      const file = path.join(dir, `jobs/repo/job-${scenario}-${backend}/job.json`);
      other[scenario] = { file, job: json(file) };
      write(file, running(other[scenario].job));
    }
    return [backend, { jobDir, job, handbacks, relayFile, relay, ledger, other, offset: i * 120000 }];
  }));
  let time = Date.parse('2026-10-22T10:00:25Z'), screens = [], visit = 0, stage = null, current, sent, lastScreen;
  const visits = ['B1', 'C1', 'A1'].flatMap(line => backends.map(backend => ({ line, backend })));
  lines(input.transcript, main.filter(row => row.origin?.kind !== 'task-notification'));
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
    calls.push(['sleep', ms]);
    if (failure === 'timeout' || ms >= 500) time += ms;
    if (ms !== 1000 || !stage) return;
    const { jobDir, job, handbacks, relayFile, relay, ledger, offset } = saved[current.backend];
    if (stage === 'A1') {
      write(ledger[0].file, ledger[0].value); lines(relayFile, relay.slice(0, 1));
      write(path.join(jobDir, 'job.json'), { ...job, attempts: job.attempts.slice(0, 2) });
      stage = 'handback';
    } else if (stage === 'handback') {
      lines(path.join(jobDir, 'relay-handbacks.jsonl'), handbacks.slice(0, 1));
      lines(input.transcript, main.filter(row => Date.parse(row.timestamp) < Date.parse('2026-10-22T10:01:50Z') + offset));
      stage = 'idle';
    } else if (stage === 'idle') {
      time = Math.max(time, Date.parse('2026-10-22T10:01:50Z') + offset);
      stage = null;
    } else if (stage === 'A2') {
      write(ledger[1].file, ledger[1].value); lines(relayFile, relay);
      write(path.join(jobDir, 'job.json'), job); lines(path.join(jobDir, 'relay-handbacks.jsonl'), handbacks);
      time = Math.max(time, Date.parse('2026-10-22T10:02:00Z') + offset);
      lines(input.transcript, main.filter(row => Date.parse(row.timestamp) <= time));
      stage = null;
      afterA2({ jobDir, handbacks, main, input });
    }
  }, drive(args) {
    calls.push(args);
    if (args[0] === 'read') {
      if (!screens.length && visit >= visits.length) return lastScreen;
      if (!screens.length) {
        current = visits[visit++]; assert.ok(current, 'no navigation after the final A');
        const { line, backend } = current;
        screens = json(path.join(fixture, line === 'C1' ? 'screens-c.json' : 'screens.json'));
        if (line === 'B1') {
          screens = screens.map(screen => screen.replaceAll('typed-a-codex', 'typed-b-codex'));
          time = Date.parse('2026-10-22T10:00:25Z') + backends.indexOf(backend) * 1000;
        } else if (line === 'C1') time = Date.parse('2026-10-22T10:00:32Z') + backends.indexOf(backend) * 1000;
        else {
          let idle = fs.readFileSync(path.join(fixture, 'screen-a-idle.txt'), 'utf8');
          if (failure === 'unfocused-a-prompt') idle = idle.replace('  ◯ main', '❯ ◯ main');
          screens.splice(9, 0, screens[8], failure === 'lost-a-view' ? screens[0] : idle, screens[8]);
          time = Math.max(time, Date.parse('2026-10-22T10:00:45Z') + saved[backend].offset);
          if (failure === 'a-completed') write(path.join(saved[backend].jobDir, 'job.json'), saved[backend].job);
        }
        screens = screens.map(screen => screen.replaceAll('codex', backend));
        if (failure === 'navigation') screens[0] = 'unexpected';
      }
      lastScreen = screens.shift().replaceAll('{{sent}}', sent ?? '');
      return lastScreen;
    }
    if (args[0] === 'keys' && current?.line === 'A1' && run.typed[current.backend].A2) {
      assert.ok(fs.existsSync(saved[current.backend].ledger[1].file), 'A2 ledger precedes returning to main');
    }
    if (args[0] === 'send') {
      sent = args[2];
      if (args[2].includes(' B1 ')) time += 1000;
      if (args[2].includes(' C1 ') && !pendingC) {
        const { file, job } = saved[current.backend].other.c; write(file, job);
      }
      if (args[2].includes(' A1 ')) stage = 'A1';
      if (args[2].includes(' A2 ')) stage = 'A2';
    }
    return '';
  }, async companionRunner(value, args) {
    assert.equal(value, ctx); calls.push(args);
    if (args[0] === 'wake') {
      assert.deepEqual(args, ['wake', '--agent', `agent-b-${current.backend}`]);
      if (failure === 'wake') throw new Error('Wake failed.');
      if (failure === 'interrupt') controller.abort(new Error('Interrupted.'));
      if (!pendingB) { const { file, job } = saved[current.backend].other.b; write(file, job); }
    }
    if (args[0] === 'cancel') {
      assert.ok(backends.some(backend => ['a', 'b', 'c'].some(scenario => args[1] === path.join(dir, `jobs/repo/job-${scenario}-${backend}`))));
      const job = json(path.join(args[1], 'job.json')), at = new Date(time).toISOString();
      write(path.join(args[1], 'job.json'), { ...job, state: 'cancelled', completedAt: at,
        attempts: job.attempts.map(attempt => ({ ...attempt, state: 'cancelled', endedAt: at })) });
    }
    return '';
  } };
  return { ctx, dependencies, calls, dir };
}

for (const pendingB of [true, false]) for (const pendingC of [true, false]) test(`typed terminal drives B then C then A in one view visit and closes the pane (B running=${pendingB}, C running=${pendingC})`, async t => {
  const { ctx, dependencies, calls } = terminal(t, { pendingB, pendingC });
  const result = await typed.runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass');
  assert.equal(ctx.run.completed, true); assert.ok(ctx.run.checkFinishedAt);
  assert.deepEqual(calls.filter(call => call[0] === 'send').map(call => call[2]), ['B1', 'C1', 'A1', 'A2'].map(line => typedLine('synthetic-run', 'codex', line)));
  const keys = values => values.map(key => ['keys', 'fixture-pane', key]);
  const open = keys(['Down', 'Down', 'Down', 'Enter', 'Up', 'Up', 'Up']);
  const back = keys(['Down', 'Enter', 'Up']);
  const send = line => ['send', 'fixture-pane', typedLine('synthetic-run', 'codex', line)];
  assert.deepEqual(calls.filter(call => ['keys', 'send', 'wake'].includes(call[0])), [
    ...open, send('B1'), ...back, ['wake', '--agent', 'agent-b-codex'],
    ...open, ...keys(['Escape']), send('C1'), ...back,
    ...open, send('A1'), send('A2'), ...back]);
  const a1 = calls.findIndex(call => call[0] === 'send' && call[2].includes(' A1 '));
  const a2 = calls.findIndex(call => call[0] === 'send' && call[2].includes(' A2 '));
  assert.equal(calls.slice(a1 + 1, a2).filter(call => call[0] === 'sleep' && call[1] === 1000).length, 3);
  const leave = calls.findIndex((call, i) => i > a2 && call[0] === 'keys');
  assert.equal(calls.slice(a2 + 1, leave).filter(call => call[0] === 'sleep' && call[1] === 1000).length, 1);
  assert.equal(calls.filter(call => call[0] === 'wake').length, 1);
  assert.equal(calls.filter(call => call[0] === 'cancel').length, Number(pendingB) + Number(pendingC));
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
  assert.equal(calls.filter(call => call.includes('Escape')).length, 1);
  assert.equal(typed.analyze(ctx).results[0].result, 'pass');
  assert.equal(ctx.run.typed.codex.B1.assistance, 'manual-wake');
});

test('typed terminal waits for the final A2 hand-back and then its notice before analyzing once', async t => {
  let pending, polls = 0, analyses = 0;
  const { ctx, dependencies } = terminal(t, { afterA2(value) {
    pending = value;
    lines(path.join(value.jobDir, 'relay-handbacks.jsonl'), value.handbacks.slice(0, 1));
    lines(value.input.transcript, value.main.slice(0, -2));
  } });
  const sleep = dependencies.sleep;
  dependencies.sleep = async ms => {
    const wasPending = Boolean(pending);
    await sleep(ms);
    if (!wasPending || ms !== 1000) return;
    polls++;
    if (polls === 1) lines(path.join(pending.jobDir, 'relay-handbacks.jsonl'), pending.handbacks);
    if (polls === 2) lines(pending.input.transcript, pending.main);
  };
  const analyze = typed.analyze;
  t.mock.method(typed, 'analyze', function (input) {
    analyses++; assert.equal(polls, 2); return analyze.call(this, input);
  });
  const result = await typed.runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass');
  assert.equal(analyses, 1);
});

for (const failure of ['wrong B outcome', 'wrong final result', 'missing final hand-back', 'missing final notice']) {
  test(`typed terminal returns a failing analysis within two minutes of A2's ledger: ${failure}`, async t => {
    const { ctx, dependencies, dir, calls } = terminal(t, { afterA2({ jobDir, handbacks, main, input }) {
      if (failure === 'missing final hand-back') lines(path.join(jobDir, 'relay-handbacks.jsonl'), handbacks.slice(0, 1));
      if (failure === 'missing final notice') lines(input.transcript, main.slice(0, -2));
      if (failure === 'wrong final result') editLines(input.evidenceDir, 'transcript.jsonl', rows => {
        rows.at(-2).message.content = rows.at(-2).message.content.replace('Acknowledged.', 'Wrong report.');
      });
    } });
    if (failure === 'wrong B outcome') edit(dir, `${B}/inbox/outcomes/msg-B1-codex.json`, row => { row.turnId = 'wrong'; });
    const analyze = typed.analyze;
    let analyses = 0;
    t.mock.method(typed, 'analyze', function (input) { analyses++; return analyze.call(this, input); });
    const result = await typed.runTerminal(ctx, dependencies);
    assert.equal(analyses, 1);
    const row = result.results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, failure === 'wrong B outcome' ? /Expected in-turn steer for B1/ :
      failure === 'wrong final result' ? /Last hand-back is not the job result/ : /Missing completed (hand-back|notice)/);
    const ledgerAt = Date.parse(json(path.join(dir, A, 'inbox/relay/entry-A2-codex.json')).at);
    const elapsed = dependencies.now() - ledgerAt;
    assert.ok(elapsed <= 120000);
    assert.equal(elapsed, failure === 'missing final notice' ? 120000 : 8000);
    assert.equal(ctx.run.completed, true);
    assert.equal(ctx.run.error, undefined);
    assert.ok(ctx.run.checkFinishedAt);
    assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
    assert.equal(typed.analyze(ctx).results[0].reason, row.reason);
  });
}

test('typed terminal finishes every B and C before visiting each backend A without reopening its view', async t => {
  const { ctx, dependencies, calls } = terminal(t, { backends: ['codex', 'kimi'], pendingB: false, pendingC: false });
  const result = await typed.runTerminal(ctx, dependencies);
  assert.deepEqual(result.results.map(row => [row.result, row.reason]), [['pass', null], ['pass', null]]);
  assert.deepEqual(calls.filter(call => call[0] === 'send').map(call => call[2]), [
    ['codex', 'B1'], ['kimi', 'B1'], ['codex', 'C1'], ['kimi', 'C1'],
    ['codex', 'A1'], ['codex', 'A2'], ['kimi', 'A1'], ['kimi', 'A2']
  ].map(([backend, line]) => typedLine('synthetic-run', backend, line)));
  for (const backend of ctx.run.backends) {
    const a1 = calls.findIndex(call => call[0] === 'send' && call[2] === typedLine('synthetic-run', backend, 'A1'));
    const a2 = calls.findIndex(call => call[0] === 'send' && call[2] === typedLine('synthetic-run', backend, 'A2'));
    assert.ok(calls.slice(a1 + 1, a2).every(call => ['read', 'sleep'].includes(call[0])));
  }
  assert.equal(calls.filter(call => call.includes('Escape')).length, 2);
});

for (const failure of ['lost-a-view', 'unfocused-a-prompt']) test(`typed terminal saves the screen and fails before A2 without retries: ${failure}`, async t => {
  const { ctx, dependencies, calls, dir } = terminal(t, { failure });
  await assert.rejects(typed.runTerminal(ctx, dependencies), /Navigation: expected typed-a-codex's focused prompt before A2/);
  assert.equal(ctx.run.completed, false);
  assert.equal(calls.filter(call => call[0] === 'send').length, 3);
  assert.equal(calls.some(call => call[0] === 'send' && call[2].includes(' A2 ')), false);
  const files = fs.readdirSync(dir).filter(file => file.startsWith('typed-typed-a-codex-A2-'));
  assert.deepEqual(files.sort(), ['typed-typed-a-codex-A2-10.txt', 'typed-typed-a-codex-A2-9.txt']);
  const screen = fs.readFileSync(path.join(dir, files.find(file => file.endsWith('-10.txt'))), 'utf8');
  if (failure === 'lost-a-view') assert.equal(screen.includes('Message @typed-a-'), false);
  else assert.match(screen, /❯ ◯ main/);
  const lastRead = calls.findLastIndex(call => call[0] === 'read');
  assert.ok(calls.slice(lastRead + 1).every(call => ['cancel', 'stop'].includes(call[0])));
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
});

test('typed terminal refuses A1 if its job ended during the earlier B and C visits', async t => {
  const { ctx, dependencies, calls } = terminal(t, { failure: 'a-completed' });
  await assert.rejects(typed.runTerminal(ctx, dependencies), /typed-a-codex is no longer running before A1/);
  assert.equal(calls.filter(call => call[0] === 'send').length, 2);
  assert.equal(ctx.run.completed, false);
});

for (const failure of ['driver', 'marker', 'navigation', 'wake', 'interrupt', 'timeout']) {
  test(`typed terminal records failure and always stops the pane: ${failure}`, async t => {
    const { ctx, dependencies, calls } = terminal(t, { failure });
    await assert.rejects(typed.runTerminal(ctx, dependencies));
    assert.equal(ctx.run.completed, false); assert.ok(ctx.run.error);
    assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
    if (['navigation', 'wake', 'interrupt', 'timeout'].includes(failure)) assert.equal(calls.filter(call => call[0] === 'cancel').length, 3);
  });
}

for (const n of [1, 2, 3, 4]) test(`typed terminal timeout covers the last A visit and settlement for n = ${n} before starting the pane`, async t => {
  const { ctx, dependencies } = terminal(t, { failure: 'driver', backends: readers.BACKENDS.slice(0, n) });
  await assert.rejects(typed.runTerminal(ctx, dependencies), /Driver failed/);
  assert.equal(ctx.timeoutMinutes, [25, 30, 35, 40][n - 1]);
  assert.equal(ctx.run.timeoutMinutes, ctx.timeoutMinutes);
  const sleeps = [[100], [140, 380], [180, 420, 660], [220, 460, 700, 940]][n - 1];
  const calls = typed.prompt({ runId: 'sizing', backends: readers.BACKENDS.slice(0, n) }).split('\n')
    .filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
  assert.deepEqual(calls.slice(0, n).map(call => Number(call.prompt.match(/sleep (\d+)/)[1])), sleeps);
  const navigation = 5 * (3 * (3 * n + 2) + 6);
  // Earlier visits overlap the sleeps; allow startup and the last visit through settlement.
  const estimate = 300 + sleeps.at(-1) + 120 + 120 + 30 + 60 + 120 + navigation + 120;
  assert.ok(ctx.timeoutMinutes * 60 >= estimate);
});

test('typed four-backend sizing keeps the next A running after a typical visit', () => {
  const calls = typed.prompt({ runId: 'sizing', backends: readers.BACKENDS }).split('\n')
    .filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
  const sleeps = calls.slice(0, 4).map(call => Number(call.prompt.match(/sleep (\d+)/)[1]));
  let ready = sleeps[0] - 1;
  for (let i = 0; i < sleeps.length - 1; i++) {
    ready = Math.max(ready, sleeps[i]) + 150;
    assert.ok(ready < sleeps[i + 1], `A${i + 1} must still run at the next A1 send`);
    assert.equal(sleeps[i + 1] - ready, 90);
  }
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

for (const effect of ['third read', 'final read', 'stuck text', 'lost paste']) {
  test(`typed send waits for a submitted echo and cleared prompt without resending: ${effect}`, async t => {
    const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
    const pending = effect === 'lost paste' ? screens[7] : screens[7].replace('❯ Message @typed-a-codex…', '❯ line');
    const succeeds = effect === 'third read' || effect === 'final read';
    const sequence = [...screens.slice(0, 8), ...Array(effect === 'third read' ? 2 : 25).fill(pending),
      ...(succeeds ? screens.slice(8) : [pending])];
    const nav = navigation(dir, sequence);
    if (succeeds) await typeInView(nav.ctx, 'typed-a-codex', 'line', nav);
    else await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'line', nav), /cleared prompt and submitted text.*screen saved/);
    const sent = readers.readTranscript(path.join(dir, 'typed-navigation.jsonl')).find(step => step.key === 'send');
    assert.equal(sent.reads, effect === 'third read' ? 3 : 26);
    assert.equal(sent.elapsedMs, effect === 'third read' ? 600 : 5000);
    assert.equal(sent.timeoutMs, 5000); assert.equal(sent.settled, succeeds);
    assert.equal(nav.calls.filter(call => call[0] === 'send').length, 1);
    assert.ok(fs.existsSync(path.join(dir, sent.screen)));
    if (!succeeds) assert.equal(nav.calls.filter(call => call[0] === 'keys').length, 7);
  });
}

test('typed send accepts the submitted echo recorded in the four-backend passing run', async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json')).map(screen => screen.replaceAll('typed-a-codex', 'typed-b-codex'));
  screens[8] = fs.readFileSync(path.join(fixture, '20261022T201923Z-sent-b.txt'), 'utf8');
  const nav = navigation(dir, screens);
  await typeInView(nav.ctx, 'typed-b-codex', typedLine('20261022T201923Z-typed-terminal-a8d4', 'codex', 'B1'), nav);
  assert.equal(nav.calls.filter(call => call[0] === 'send').length, 1);
});

test('typed return requires main selection after Enter before sending Up', async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  screens.splice(10, 2, screens[11]);
  const nav = navigation(dir, screens);
  await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'line', nav), /main view with selector on main/);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').at(-1), ['keys', 'fixture-pane', 'Enter']);
  assert.equal(readers.readTranscript(path.join(dir, 'typed-navigation.jsonl')).at(-1).settled, false);
});

test('typed terminal refuses Escape when C ended while its prompt was being focused', async t => {
  const { ctx, dependencies, calls, dir } = terminal(t);
  const drive = dependencies.drive;
  dependencies.drive = args => {
    const value = drive(args);
    if (args[0] === 'read' && value.includes('❯ Message @typed-c-codex…') && !value.includes('❯ ◯') && !value.includes('❯ ●')) {
      edit(dir, `${C}/job.json`, job => { job.state = 'completed'; });
    }
    return value;
  };
  await assert.rejects(typed.runTerminal(ctx, dependencies), /typed-c-codex is no longer running before Escape/);
  assert.equal(calls.some(call => call.includes('Escape')), false);
  assert.equal(calls.filter(call => call[0] === 'send').length, 1);
});

for (const [failure, mutate, reason] of [
  ['own words', dir => editLines(dir, 'transcript.jsonl', rows => {
    const row = rows.find(row => row.message?.content?.includes?.('<task-id>agent-a-codex</task-id>'));
    row.message.content = row.message.content.replace('Acknowledged.', 'My own words.');
  }), /Last hand-back is not the job result/],
  ['altered inbox', dir => edit(dir, `${A}/inbox/claimed/msg-A1-codex.json`, row => { row.text += ' altered'; }), /Inbox does not carry A1 exactly once/],
  ['duplicate delivery', dir => fs.copyFileSync(path.join(dir, A, 'inbox/relay/entry-A1-codex.json'), path.join(dir, A, 'inbox/relay/duplicate.json')), /exactly one ledger record for A1/],
  ['continue before completion', dir => edit(dir, `${A}/job.json`, job => { job.attempts[0].endedAt = '2026-10-22T10:01:37Z'; }), /Continue A1 preceded completion/]
]) test(`typed terminal throws permanent A1 failure with its cause: ${failure}`, async t => {
  const { ctx, dependencies, calls, dir } = terminal(t);
  const sleep = dependencies.sleep;
  let changed = failure === 'altered inbox';
  if (changed) mutate(dir);
  dependencies.sleep = async ms => {
    await sleep(ms);
    const ready = failure === 'own words' ? readers.readTranscript(path.join(dir, A, 'relay-handbacks.jsonl')).length :
      fs.existsSync(path.join(dir, A, 'inbox/relay/entry-A1-codex.json'));
    if (!changed && ready) { changed = true; mutate(dir); }
  };
  await assert.rejects(typed.runTerminal(ctx, dependencies), reason);
  assert.equal(changed, true); assert.match(ctx.run.error, reason);
  assert.ok(dependencies.now() <= Date.parse('2026-10-22T10:02:46Z'));
  assert.equal(calls.some(call => call[0] === 'send' && call[2].includes(' A2 ')), false);
  assert.match(typed.analyze(ctx).results[0].reason, reason);
});

for (const failure of ['missing A1 ledger', 'posting A1 ledger', 'missing A1 hand-back', 'missing A1 notice', 'missing A2 ledger', 'posting A2 ledger']) {
  test(`typed terminal bounds in-flight evidence and saves its last diagnostic: ${failure}`, async t => {
    const { ctx, dependencies, calls, dir } = terminal(t, { afterA2({ jobDir }) {
      if (failure === 'missing A2 ledger') fs.rmSync(path.join(jobDir, 'inbox/relay/entry-A2-codex.json'));
      if (failure === 'posting A2 ledger') edit(jobDir, 'inbox/relay/entry-A2-codex.json', row => { row.status = 'posting'; });
    } });
    const sleep = dependencies.sleep;
    dependencies.sleep = async ms => {
      await sleep(ms);
      const file = path.join(dir, A, 'inbox/relay/entry-A1-codex.json');
      if (failure === 'missing A1 ledger') fs.rmSync(file, { force: true });
      if (failure === 'posting A1 ledger' && fs.existsSync(file)) edit(dir, `${A}/inbox/relay/entry-A1-codex.json`, row => { row.status = 'posting'; });
      if (failure === 'missing A1 hand-back') lines(path.join(dir, A, 'relay-handbacks.jsonl'), []);
      if (['missing A1 hand-back', 'missing A1 notice'].includes(failure)) editLines(dir, 'transcript.jsonl', rows => {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].message?.content?.includes?.('<task-id>agent-a-codex</task-id>')) rows.splice(i, 1);
      });
    };
    const reason = failure.startsWith('posting') ? /A[12] ledger status is posting/ :
      failure === 'missing A1 hand-back' ? /Missing hand-back/ : failure === 'missing A1 notice' ? /Missing completed notice/ : /ledger record is missing/;
    await assert.rejects(typed.runTerminal(ctx, dependencies), reason);
    assert.match(ctx.run.error, /screen saved/);
    const line = failure.includes('A2') ? 'A2' : 'A1';
    const elapsed = dependencies.now() - Date.parse(ctx.run.typed.codex[line].sentAt);
    assert.equal(elapsed, line === 'A2' ? 60000 : 220000);
    assert.ok(fs.readdirSync(dir).some(file => file.endsWith('-timeout.txt')));
    assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
  });
}

test('typed idle row wait stops after thirty seconds with the screen saved', async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  const nav = navigation(dir, screens.slice(0, 9));
  await assert.rejects(typeInView(nav.ctx, 'typed-a-codex', 'line', { ...nav,
    followup: { text: 'A2', ready: async () => {}, beforeSend() { assert.fail('A2 must not be sent'); } }
  }), /idle row within 30 seconds.*screen saved/);
  assert.equal(nav.now(), 31600);
  assert.equal(nav.calls.filter(call => call[0] === 'send').length, 1);
  const saved = fs.readdirSync(dir).filter(file => file.startsWith('typed-typed-a-codex-'));
  assert.ok(saved.length >= 31);
});

for (const failure of ['missing rejected result', 'missing interruption note', 'unrelated rejected tool', 'interrupt after C1', 'receipt before interrupt', 'queued command', 'stop after delivery']) {
  test(`typed analysis proves interrupt then redirect: ${failure}`, t => {
    const { dir, input } = setup(t);
    if (failure === 'receipt before interrupt') edit(dir, 'run.json', run => { run.typed.codex.C1.sentAt = '2026-10-22T10:00:32Z'; });
    else if (failure === 'stop after delivery') editLines(dir, 'transcript.jsonl', rows => {
      rows.find(row => row.message?.content?.includes?.('<task-id>agent-c-codex</task-id>')).timestamp = '2026-10-22T10:00:41Z';
    });
    else editLines(dir, 'transcript/subagents/agent-c-codex.jsonl', rows => {
      if (failure === 'missing rejected result') rows.splice(1, 1);
      if (failure === 'missing interruption note') rows.splice(2, 1);
      if (failure === 'unrelated rejected tool') rows[0].message.content[0].input.command = 'echo unrelated';
      if (failure === 'interrupt after C1') rows.push(...rows.splice(1, 2));
      if (failure === 'queued command') {
        const entry = rows.at(-1);
        rows[rows.length - 1] = { ...entry, type: 'attachment', attachment: {
          type: 'queued_command', origin: { kind: 'human' }, prompt: typedLine('synthetic-run', 'codex', 'C1')
        } };
      }
    });
    const row = typed.analyze(input).results[0];
    assert.equal(row.result, 'fail');
    assert.match(row.reason, failure === 'queued command' ? /resuming human user entry/ :
      failure === 'stop after delivery' ? /stop notice did not precede C1 delivery/ : /interrupted wait before/);
  });
}

for (const outcome of ['pass', 'analysis failure', 'navigation failure']) {
  test(`typed cleanup records cancel errors and still cancels every unfinished job after ${outcome}`, async t => {
    const { ctx, dependencies, calls, dir } = terminal(t, { failure: outcome === 'navigation failure' ? 'navigation' : undefined });
    if (outcome === 'analysis failure') edit(dir, `${B}/inbox/outcomes/msg-B1-codex.json`, row => { row.turnId = 'wrong'; });
    const cancel = dependencies.companionRunner;
    dependencies.companionRunner = async (value, args) => {
      if (args[0] === 'cancel' && args[1] === path.join(dir, outcome === 'navigation failure' ? A : B)) {
        calls.push(args); throw Object.assign(new Error('Cancel exited 1.'), { status: 1 });
      }
      return cancel(value, args);
    };
    if (outcome === 'navigation failure') await assert.rejects(typed.runTerminal(ctx, dependencies), /Navigation:/);
    else {
      const result = await typed.runTerminal(ctx, dependencies);
      assert.equal(result.results[0].result, outcome === 'pass' ? 'pass' : 'fail');
      if (outcome === 'analysis failure') assert.match(result.results[0].reason, /in-turn steer for B1/);
      assert.match(result.results[0].reason, /Warning: B1 cleanup: Cancel exited 1/);
      if (outcome === 'pass') {
        const [record] = makeRecords({ ...ctx.run, check: 'typed' }, typed, result,
          readers.readTranscript(ctx.run.transcript), readers, dir);
        assert.equal(record.result, 'pass');
        assert.match(record.reason, /Warning: B1 cleanup: Cancel exited 1/);
        assert.match(typed.cell(record), /Warning: B1 cleanup: Cancel exited 1/);
      }
    }
    const scenarios = outcome === 'navigation failure' ? ['A', 'B', 'C'] : ['B', 'C'];
    assert.equal(calls.filter(call => call[0] === 'cancel').length, scenarios.length);
    for (const scenario of scenarios) assert.ok(ctx.run.typed.codex[`${scenario}1`].cleanupAt);
    assert.equal(ctx.run.typed.codex[`${scenarios[0]}1`].cleanupError, 'Cancel exited 1.');
    assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
    const replay = typed.analyze(ctx).results[0];
    assert.equal(replay.result, outcome === 'pass' ? 'pass' : 'fail');
    assert.match(replay.reason, /Warning: [AB]1 cleanup: Cancel exited 1/);
  });
}

test('typed terminal settles every A2 turn, hand-back and notice before analyzing once', async t => {
  const pending = new Map(), stages = new Map();
  let analyses = 0;
  const { ctx, dependencies, calls } = terminal(t, { backends: ['codex', 'kimi'], pendingB: false, pendingC: false,
    afterA2(value) {
      const job = json(path.join(value.jobDir, 'job.json')), backend = job.request.backend;
      pending.set(backend, { ...value, job }); stages.set(backend, 0);
      write(path.join(value.jobDir, 'job.json'), { ...job, state: 'running',
        attempts: job.attempts.map((attempt, i) => i === 2 ? { ...attempt, state: 'running', endedAt: null } : attempt) });
      lines(path.join(value.jobDir, 'relay-handbacks.jsonl'), value.handbacks.slice(0, 1));
      lines(value.input.transcript, readers.readTranscript(value.input.transcript).filter(row => !row.message?.content?.includes?.(`<task-id>agent-a-${backend}</task-id>`) ||
        Date.parse(row.timestamp) < Date.parse(value.handbacks.at(-1).at)));
    }
  });
  const sleep = dependencies.sleep;
  dependencies.sleep = async ms => {
    const waiting = [...pending];
    await sleep(ms);
    if (ms !== 1000) return;
    for (const [backend, value] of waiting) {
      const stage = stages.get(backend) + 1; stages.set(backend, stage);
      if (stage === 1) write(path.join(value.jobDir, 'job.json'), value.job);
      if (stage === 2) lines(path.join(value.jobDir, 'relay-handbacks.jsonl'), value.handbacks);
      if (stage === 3) {
        const notice = value.main.filter(row => row.message?.content?.includes?.(`<task-id>agent-a-${backend}</task-id>`) &&
          Date.parse(row.timestamp) >= Date.parse(value.handbacks.at(-1).at));
        lines(value.input.transcript, [...readers.readTranscript(value.input.transcript), ...notice]);
        pending.delete(backend);
      }
    }
  };
  const analyze = typed.analyze;
  t.mock.method(typed, 'analyze', function (input) {
    analyses++;
    assert.deepEqual([...stages], [['codex', 3], ['kimi', 3]]);
    return analyze.call(this, input);
  });
  const result = await typed.runTerminal(ctx, dependencies);
  assert.equal(analyses, 1);
  assert.deepEqual(result.results.map(row => [row.result, row.reason]), [['pass', null], ['pass', null]]);
  assert.equal(calls.filter(call => call[0] === 'send' && call[2].includes(' A2 ')).length, 2);
});

test('typed analysis accepts the interrupted wait and resuming entry cut from the passing run', t => {
  const { dir, input } = setup(t);
  const rows = readers.readTranscript(path.join(fixture, '20261022T201923Z-interrupt-c.jsonl')).map(row => {
    const value = JSON.parse(JSON.stringify(row).replaceAll('job-mvjziwe3-c90046ab', 'job-c-codex')
      .replaceAll('20261022T201923Z-typed-terminal-a8d4', 'synthetic-run'));
    value.timestamp = new Date(Date.parse(row.timestamp) - (10 * 60 + 20) * 60000).toISOString();
    return value;
  });
  rows.at(-1).uuid = 'entry-C1-codex';
  lines(path.join(dir, 'transcript/subagents/agent-c-codex.jsonl'), rows);
  edit(dir, 'run.json', run => { run.typed.codex.C1.sentAt = '2026-10-22T10:00:31.293Z'; });
  const row = typed.analyze(input).results[0];
  assert.equal(row.result, 'pass', row.reason);
});

for (const command of ['wait', 'wait --timeout-seconds 540']) {
  test(`typed analysis accepts an interrupted ${command} without a job id`, t => {
    const { dir, input } = setup(t);
    editLines(dir, 'transcript/subagents/agent-c-codex.jsonl', rows => {
      rows[0].message.content[0].input.command = `node "/fixture/plugin/scripts/companion.mjs" ${command}`;
    });
    const row = typed.analyze(input).results[0];
    assert.equal(row.result, 'pass', row.reason);
  });
}

test('typed analysis rejects a relay that resumed with another wait before C1', t => {
  const { dir, input } = setup(t);
  editLines(dir, 'transcript/subagents/agent-c-codex.jsonl', rows => {
    const resumed = structuredClone(rows[0]);
    resumed.uuid = 'resumed-without-C1'; resumed.parentUuid = rows[2].uuid;
    resumed.timestamp = '2026-10-22T10:00:34Z';
    rows.at(-1).parentUuid = resumed.uuid;
    rows.splice(3, 0, resumed);
  });
  const row = typed.analyze(input).results[0];
  assert.equal(row.result, 'fail'); assert.match(row.reason, /C1 did not resume the relay/);
});

for (const line of ['A1', 'A2']) for (const delay of line === 'A1' ? [1000, 20000, null] : [1000, 20000, 120000, null]) {
  test(`typed terminal retries done ${line} delivery when its attempt ${delay === null ? 'never appears' : `appears after ${delay} ms`}`, async t => {
    const { ctx, dependencies, dir, calls } = terminal(t);
    const sleep = dependencies.sleep;
    let ledgerAt, savedJob, retries = 0;
    dependencies.sleep = async ms => {
      await sleep(ms);
      if (!fs.existsSync(path.join(dir, A, `inbox/relay/entry-${line}-codex.json`))) return;
      if (ledgerAt === undefined) {
        ledgerAt = dependencies.now();
        savedJob = json(path.join(dir, A, 'job.json'));
        write(path.join(dir, A, 'job.json'), { ...savedJob,
          attempts: savedJob.attempts.filter(attempt => attempt.messageId !== `msg-${line}-codex`) });
      } else if (ms === 500) {
        retries++;
        if (delay !== null && dependencies.now() - ledgerAt >= delay) write(path.join(dir, A, 'job.json'), savedJob);
      }
    };
    if (delay === null) {
      const message = `Missing new attempt carrying ${line}.`;
      await assert.rejects(typed.runTerminal(ctx, dependencies), { message });
      assert.equal(dependencies.now() - ledgerAt, 120000);
      assert.equal(ctx.run.error, message);
      assert.equal(calls.filter(call => call[0] === 'send').length, line === 'A1' ? 3 : 4);
    } else {
      const result = await typed.runTerminal(ctx, dependencies);
      assert.equal(result.results[0].result, 'pass', result.results[0].reason);
    }
    assert.equal(retries, (delay ?? 120000) / 500);
  });
}

for (const delay of [30000, null]) test(`typed terminal waits for ZCode A1 continue to start its turn: ${delay === null ? 'never starts' : '30 seconds after done'}`, async t => {
  const { ctx, dependencies, dir } = terminal(t, { backends: ['zcode'] });
  const sleep = dependencies.sleep;
  const jobDir = path.join(dir, 'jobs/repo/job-a-zcode');
  const outcomeFile = path.join(jobDir, 'inbox/outcomes/msg-A1-zcode.json');
  const outcome = json(outcomeFile);
  let ledgerAt, validatedAt;
  dependencies.sleep = async ms => {
    await sleep(ms);
    if (!fs.existsSync(path.join(jobDir, 'inbox/relay/entry-A1-zcode.json'))) return;
    if (ledgerAt === undefined) {
      ledgerAt = dependencies.now();
      assert.ok(json(path.join(jobDir, 'job.json')).attempts.some(attempt => attempt.messageId === outcome.messageId));
      write(outcomeFile, { ...outcome, action: 'claimed' });
    } else if (delay !== null && validatedAt === undefined && dependencies.now() - ledgerAt >= delay) {
      validatedAt = dependencies.now(); write(outcomeFile, outcome);
    }
  };
  if (delay === null) {
    await assert.rejects(typed.runTerminal(ctx, dependencies), { message: 'Missing new attempt carrying A1.' });
    assert.equal(dependencies.now() - ledgerAt, 120000);
  } else {
    const result = await typed.runTerminal(ctx, dependencies);
    assert.equal(result.results[0].result, 'pass', result.results[0].reason);
    assert.equal(validatedAt - ledgerAt, delay);
  }
});

for (const backend of readers.BACKENDS) test(`typed terminal bounds ${backend} A1 steer validation by its delivery mode`, async t => {
  const { ctx, dependencies, dir } = terminal(t, { backends: [backend] });
  const sleep = dependencies.sleep;
  const jobDir = path.join(dir, `jobs/repo/job-a-${backend}`);
  let ledgerAt;
  dependencies.sleep = async ms => {
    await sleep(ms);
    if (ledgerAt !== undefined || !fs.existsSync(path.join(jobDir, `inbox/relay/entry-A1-${backend}.json`))) return;
    ledgerAt = dependencies.now();
    edit(jobDir, `inbox/relay/entry-A1-${backend}.json`, row => {
      row.kind = 'steer'; row.at = '2026-10-22T10:01:29Z'; row.postedAt = row.at;
    });
    edit(jobDir, `inbox/claimed/msg-A1-${backend}.json`, row => { row.kind = 'steer'; });
    edit(jobDir, `inbox/outcomes/msg-A1-${backend}.json`, row => { row.action = 'wrong'; });
  };
  const message = backend === 'kimi' ? 'Missing new attempt carrying A1.' : 'Expected in-turn steer for A1.';
  await assert.rejects(typed.runTerminal(ctx, dependencies), { message });
  assert.equal(dependencies.now() - ledgerAt, backend === 'kimi' ? 120000 : 20000);
  assert.equal(ctx.run.error, message);
});

for (const line of ['A1', 'A2']) for (const failure of ['inbox', 'outcome']) {
  test(`typed terminal fails done ${line} ${failure} after the delivery bound before waiting for hand-back`, async t => {
    const { ctx, dependencies, dir, calls } = terminal(t);
    const sleep = dependencies.sleep;
    let invalidatedAt;
    dependencies.sleep = async ms => {
      await sleep(ms);
      if (invalidatedAt || !fs.existsSync(path.join(dir, A, `inbox/relay/entry-${line}-codex.json`))) return;
      invalidatedAt = dependencies.now();
      if (failure === 'inbox') edit(dir, `${A}/inbox/claimed/msg-${line}-codex.json`, row => { row.text += ' altered'; });
      else edit(dir, `${A}/inbox/outcomes/msg-${line}-codex.json`, row => { row.action = 'wrong'; });
      lines(path.join(dir, A, 'relay-handbacks.jsonl'), []);
      editLines(dir, 'transcript.jsonl', rows => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].message?.content?.includes?.('<task-id>agent-a-codex</task-id>')) rows.splice(i, 1);
        }
      });
    };
    const message = failure === 'inbox' ? `Inbox does not carry ${line} exactly once.` :
      `Missing new attempt carrying ${line}.`;
    await assert.rejects(typed.runTerminal(ctx, dependencies), { message });
    assert.equal(dependencies.now() - invalidatedAt, 120000);
    assert.equal(ctx.run.error, message);
    assert.equal(calls.filter(call => call[0] === 'send').length, line === 'A1' ? 3 : 4);
  });
}

for (const corruption of ['partial trailing line', 'malformed complete line']) {
  for (const outcome of ['pass', 'analysis failure']) {
    test(`typed cleanup preserves ${outcome} and cancels known jobs with a ${corruption}`, async t => {
      const { ctx, dependencies, dir, calls } = terminal(t);
      if (outcome === 'analysis failure') edit(dir, `${B}/inbox/outcomes/msg-B1-codex.json`, row => { row.turnId = 'wrong'; });
      const analyze = typed.analyze;
      let analyses = 0;
      t.mock.method(typed, 'analyze', function (input) {
        analyses++;
        const result = analyze.call(this, input);
        fs.appendFileSync(ctx.run.transcript, '{"type":' + (corruption === 'malformed complete line' ? '\n' : ''));
        return result;
      });
      const result = await typed.runTerminal(ctx, dependencies);
      assert.equal(analyses, 1);
      assert.equal(result.results[0].result, outcome === 'pass' ? 'pass' : 'fail');
      if (outcome === 'analysis failure') assert.match(result.results[0].reason, /^Expected in-turn steer for B1/);
      assert.match(result.results[0].reason, /Warning: cleanup scan: Invalid JSON at/);
      assert.match(ctx.run.cleanupScanError, /Invalid JSON at/);
      assert.equal(json(path.join(dir, 'run.json')).cleanupScanError, ctx.run.cleanupScanError);
      assert.deepEqual(calls.filter(call => call[0] === 'cancel').map(call => call[1]), [B, C].map(job => path.join(dir, job)));
      assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
    });
  }
}

test('typed cleanup discovers jobs before a partial trailing line when startup fails', async t => {
  const { ctx, dependencies, dir, calls } = terminal(t);
  ctx.paneDriver = async () => {
    fs.appendFileSync(ctx.run.transcript, '{"type":');
    throw new Error('Startup failed after spawning.');
  };
  await assert.rejects(typed.runTerminal(ctx, dependencies), /Startup failed after spawning/);
  assert.equal(ctx.run.error, 'Startup failed after spawning.');
  assert.match(ctx.run.cleanupScanError, /Invalid JSON at/);
  assert.deepEqual(calls.filter(call => call[0] === 'cancel').map(call => call[1]).sort(),
    [A, B, C].map(job => path.join(dir, job)).sort());
});

test('typed cleanup reports a pane stop error without replacing the analysis', async t => {
  const { ctx, dependencies } = terminal(t);
  const drive = dependencies.drive;
  dependencies.drive = args => {
    if (args[0] === 'stop') throw new Error('Pane stop failed.');
    return drive(args);
  };
  const result = await typed.runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass');
  assert.match(result.results[0].reason, /Warning: cleanup: Pane stop failed/);
  assert.match(typed.cell(result.results[0]), /Warning: cleanup: Pane stop failed/);
});

test('typed replay carries cleanup warnings into records for the affected backends', t => {
  const { dir, input } = setup(t);
  edit(dir, 'run.json', run => {
    run.cleanupScanError = 'Invalid JSON at transcript.jsonl:50';
    run.typed.codex.B1.cleanupError = 'Cancel exited 1.';
  });
  const result = typed.analyze(input);
  const records = makeRecords({ ...json(path.join(dir, 'run.json')), ...input, check: 'typed' }, typed, result,
    readers.readTranscript(input.transcript), readers, dir);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.result, 'pass');
    assert.match(record.reason, /Warning: cleanup scan: Invalid JSON at transcript.jsonl:50/);
    assert.match(typed.cell(record), /Warning: cleanup scan: Invalid JSON at transcript.jsonl:50/);
    assert.equal(record.reason.includes('B1 cleanup: Cancel exited 1.'), record.backend === 'codex');
  }
});

test('typed terminal visits the second A before slow first A2 settlement and reads an expired bound once', async t => {
  let pending, settled = false, secondSentAt;
  const { ctx, dependencies, dir, calls } = terminal(t, { backends: ['codex', 'kimi'], pendingB: false, pendingC: false,
    afterA2(value) {
      if (!value.jobDir.endsWith('job-a-codex')) return;
      pending = { ...value, job: json(path.join(value.jobDir, 'job.json')) };
      write(path.join(value.jobDir, 'job.json'), { ...pending.job, state: 'running',
        attempts: pending.job.attempts.map((attempt, i) => i === 2 ? { ...attempt, state: 'running', endedAt: null } : attempt) });
      lines(path.join(value.jobDir, 'relay-handbacks.jsonl'), value.handbacks.slice(0, 1));
      lines(value.input.transcript, readers.readTranscript(value.input.transcript).filter(row =>
        !row.message?.content?.includes?.('<task-id>agent-a-codex</task-id>') ||
        Date.parse(row.timestamp) < Date.parse(value.handbacks.at(-1).at)));
    }
  });
  const sleep = dependencies.sleep, drive = dependencies.drive;
  const secondEnds = Date.parse('2026-10-22T10:03:30Z'), firstSettles = secondEnds + 5000;
  dependencies.sleep = async ms => {
    await sleep(ms);
    if (!secondSentAt && dependencies.now() >= secondEnds) {
      edit(dir, 'jobs/repo/job-a-kimi/job.json', job => { job.state = 'completed'; });
    }
    if (pending && !settled && dependencies.now() >= firstSettles) {
      write(path.join(pending.jobDir, 'job.json'), pending.job);
      lines(path.join(pending.jobDir, 'relay-handbacks.jsonl'), pending.handbacks);
      const notices = pending.main.filter(row => row.message?.content?.includes?.('<task-id>agent-a-codex</task-id>'));
      lines(ctx.run.transcript, [...readers.readTranscript(ctx.run.transcript), ...notices]);
      settled = true;
    }
  };
  dependencies.drive = args => {
    const value = drive(args);
    if (args[0] === 'send' && args[2] === typedLine('synthetic-run', 'kimi', 'A1')) {
      secondSentAt = dependencies.now();
      assert.equal(settled, false);
    }
    return value;
  };
  const analyze = typed.analyze;
  let analyses = 0;
  t.mock.method(typed, 'analyze', function (input) {
    analyses++;
    assert.ok(dependencies.now() > Date.parse(json(path.join(dir, A, 'inbox/relay/entry-A2-codex.json')).at) + 120000);
    assert.equal(ctx.run.typed.codex.A2.settleError, undefined);
    return analyze.call(this, input);
  });
  const result = await typed.runTerminal(ctx, dependencies);
  assert.ok(secondSentAt < secondEnds);
  assert.equal(settled, true); assert.equal(analyses, 1);
  assert.deepEqual(result.results.map(row => [row.result, row.reason]), [['pass', null], ['pass', null]]);
  assert.equal(calls.filter(call => call[0] === 'send').length, 8);
});
