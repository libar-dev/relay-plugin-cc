import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stopNotice, { driveStops, noticeText, taskStopLine } from '../scripts/live/checks/stop-notice.mjs';
import { checks, getCheck } from '../scripts/live/checks/index.mjs';
import { parseArgs } from '../scripts/live/suite.mjs';
import { BACKENDS, readTranscript } from '../scripts/live/lib/evidence.mjs';
import { copyEvidence } from '../scripts/live/lib/runs.mjs';

const fixture = path.resolve('tests/fixtures/live-suite/stop-notice');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const lines = (file, rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const edit = (dir, file, change) => { const value = json(path.join(dir, file)); change(value); write(path.join(dir, file), value); };
const editLines = (dir, change) => { const rows = readTranscript(path.join(dir, 'transcript.jsonl')); change(rows); lines(path.join(dir, 'transcript.jsonl'), rows); };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-stop-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fixture, dir, { recursive: true });
  const input = { runId: 'synthetic-run', backends: ['codex'], relayVersion: '3.0.0-test', surface: 'terminal',
    transcript: path.join(dir, 'transcript.jsonl'), jobsHome: path.join(dir, 'jobs'), evidenceDir: dir };
  return { dir, input };
}

test('stop-notice registry selects Codex only and terminal with no probes', () => {
  assert.equal(getCheck('stop-notice'), stopNotice);
  assert.deepEqual(stopNotice.surfaces, ['terminal']); assert.deepEqual(stopNotice.probes, []);
  assert.deepEqual(parseArgs(['run', 'stop-notice'], checks, BACKENDS).backends, ['codex']);
  assert.deepEqual(parseArgs(['run', 'stop-notice', '--backends', 'codex,kimi'], checks, BACKENDS).backends, ['codex']);
  assert.throws(() => parseArgs(['run', 'stop-notice', '--backends', 'kimi'], checks, BACKENDS), /does not apply/);
});

test('stop-notice prompt starts three sleeps, waits for running jobs and ends at its marker', () => {
  const prompt = stopNotice.prompt({ runId: 'synthetic-run', backends: ['codex'] });
  assert.equal(prompt, fs.readFileSync(path.join(fixture, 'prompt.txt'), 'utf8'));
  const calls = prompt.split('\n').filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
  assert.deepEqual(calls.map(call => call.name), ['stop-x', 'stop-esc', 'stop-ts']);
  for (const call of calls) {
    assert.equal(call.run_in_background, true); assert.equal(call.subagent_type, 'relay:job');
    assert.match(call.prompt, /sleep 240/); assert.match(call.prompt, /model: gpt-6.1-sol/);
  }
  assert.match(prompt, /Wait until ALL 3 jobs are actually running/);
  assert.match(prompt, /Later you will be asked to stop one agent with TaskStop. Do exactly that and nothing else/);
  assert.equal(stopNotice.completed([{ type: 'user', message: { content: prompt } }]), false);
  assert.equal(stopNotice.completed([{ type: 'assistant', message: { content: [{ type: 'text', text: stopNotice.marker }] } }]), true);
});

test('stop-notice analysis passes exact informational rows and records both notice latencies', t => {
  const { input } = setup(t), result = stopNotice.analyze(input);
  assert.equal(result.results[0].result, 'pass', result.results[0].reason);
  assert.deepEqual(result.results[0].timings, { xNoticeSeconds: [1.2], escNoticeSeconds: [0.9], cancelledSeconds: [0.2] });
  assert.equal(result.evidence.agents.length, 3);
  assert.equal(stopNotice.cell(result.results[0]), 'x to stop: notice in 1.2 s, job runs on; Esc: notice in 0.9 s, job runs on; TaskStop: no notice, job cancelled');
});

for (const [name, mutate, reason] of [
  ['no notice for stop-x', dir => editLines(dir, rows => rows.splice(rows.findIndex(row => row.content?.startsWith('relay: stop-x')), 1)), /exact notice for stop-x, found 0/],
  ['a notice for stop-ts', dir => editLines(dir, rows => rows.push({ type: 'system', subtype: 'informational', timestamp: '2026-10-23T10:00:41.100Z', content: noticeText('stop-ts', 'job-ts') })), /Unexpected notice for stop-ts/],
  ["stop-esc's job cancelled by its stop", dir => edit(dir, 'jobs/repo/job-esc/job.json', job => { job.completedAt = job.attempts[0].endedAt = '2026-10-23T10:00:35.500Z'; }), /did not run on|active at the boundary/],
  ['two notices for one agent', dir => editLines(dir, rows => rows.push({ ...rows.find(row => row.content?.startsWith('relay: stop-x')) })), /exact notice for stop-x, found 2/],
  ['wrong notice text', dir => editLines(dir, rows => { rows.find(row => row.content?.startsWith('relay: stop-x')).content = noticeText('stop-x', 'wrong-job'); }), /exact notice for stop-x/],
  ['an early running observation', dir => edit(dir, 'run.json', run => { run.stopNotice.codex.esc.after.at = '2026-10-23T10:00:49.999Z'; }), /at least 15 seconds/],
  ['an early cancel receipt', dir => edit(dir, 'jobs/repo/job-x/inbox/claimed/cancel-x.json', message => { message.createdAt = '2026-10-23T10:00:31.000Z'; }), /Early cancellation/],
  ['missing TaskStop hook context', dir => editLines(dir, rows => rows.splice(rows.findIndex(row => row.attachment), 1)), /No successful hook context/],
  ['missing TaskStop hand-back', dir => lines(path.join(dir, 'jobs/repo/job-ts/relay-handbacks.jsonl'), []), /recorded no hand-back/],
  ['missing lead turn end', dir => editLines(dir, rows => rows.splice(rows.findLastIndex(row => row.subtype === 'turn_duration'), 1)), /ended turn/],
  ['notice outside the main transcript', dir => editLines(dir, rows => { rows.find(row => row.content?.startsWith('relay: stop-x')).isSidechain = true; }), /exact notice for stop-x, found 0/]
]) test(`stop-notice analysis rejects ${name}`, t => {
  const { dir, input } = setup(t); mutate(dir);
  const row = stopNotice.analyze(input).results[0];
  assert.equal(row.result, 'fail'); assert.match(row.reason, reason);
});

test('stop-notice copied evidence replays without the original jobs or transcripts', t => {
  const { dir, input } = setup(t), analysis = stopNotice.analyze(input);
  const run = { ...json(path.join(dir, 'run.json')), ...input };
  run.copy = copyEvidence(run, analysis, dir); write(path.join(dir, 'run.json'), run);
  fs.rmSync(input.jobsHome, { recursive: true }); fs.rmSync(input.transcript); fs.rmSync(path.join(dir, 'transcript'), { recursive: true });
  assert.deepEqual(stopNotice.analyze({ ...input, transcript: run.copy.transcript, jobsHome: run.copy.jobsHome }).results, analysis.results);
});

const keys = ['Down', 'Down', 'x', 'Up', 'Enter', 'Up',
  'Down', 'Down', 'Down', 'Enter', 'Up', 'Up', 'Up', 'Escape', 'Down', 'Enter', 'Up'];
function navigation(dir, screens = json(path.join(fixture, 'screens.json'))) {
  const calls = [];
  let time = Date.parse('2026-10-23T10:00:30.000Z'), last, sent = false;
  const drive = args => {
    calls.push(args);
    if (args[0] === 'read') { if (screens.length) last = screens.shift(); return last; }
    if (args[0] === 'send') sent = true;
    return '';
  };
  return { ctx: { run: { pane: 'fixture-pane' }, evidenceDir: dir }, calls, drive,
    now: () => time, sleep: async ms => { time += ms; }, submitted: () => sent };
}

test('stop-notice navigation presses x on its row, Escape once at the relay prompt and sends TaskStop on main', async t => {
  const { dir } = setup(t), nav = navigation(dir), stops = [];
  await driveStops(nav.ctx, { ...nav, beforeStop: key => stops.push(key) });
  assert.deepEqual(stops, ['x', 'esc']);
  assert.deepEqual(nav.calls.filter(call => call[0] !== 'read'), [
    ...keys.map(key => ['keys', 'fixture-pane', key]), ['send', 'fixture-pane', taskStopLine] ]);
  const steps = readTranscript(path.join(dir, 'typed-navigation.jsonl'));
  assert.equal(steps.length, 18);
  assert.ok(steps.every(step => step.settled && step.reads === 1 && step.elapsedMs === 200));
  const x = steps.find(step => step.key === 'x'), esc = steps.find(step => step.key === 'Escape');
  assert.match(fs.readFileSync(path.join(dir, x.screen), 'utf8'), /x to clear/);
  assert.match(fs.readFileSync(path.join(dir, esc.screen), 'utf8'), /Message @stop-esc…/);
  assert.equal(nav.calls.filter(call => call.includes('Escape')).length, 1);
});

test('stop-notice navigation polls delayed screens without resending a key', async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  const delayed = screens.flatMap((screen, index) => [0, 7, 19].includes(index) ? [screen] : [screens[index - 1], screens[index - 1], screen]);
  const nav = navigation(dir, delayed);
  await driveStops(nav.ctx, nav);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]), keys);
  assert.equal(nav.calls.filter(call => call[0] === 'send').length, 1);
  assert.ok(readTranscript(path.join(dir, 'typed-navigation.jsonl')).some(step => step.reads === 3));
});

test('stop-notice navigation bounds a lost x without pressing it twice', async t => {
  const { dir } = setup(t), nav = navigation(dir, json(path.join(fixture, 'screens.json')).slice(0, 3));
  await assert.rejects(driveStops(nav.ctx, nav), /stop-x stopped in the footer/);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]), ['Down', 'Down', 'x']);
  const step = readTranscript(path.join(dir, 'typed-navigation.jsonl')).at(-1);
  assert.equal(step.settled, false); assert.equal(step.elapsedMs, 15000);
});

test('stop-notice navigation recognizes the recorded m2 x and Escape aftermath', async t => {
  const { dir } = setup(t), screens = json(path.join(fixture, 'screens.json'));
  const x = fs.readFileSync(path.join(fixture, 'screen-x-2s.txt'), 'utf8').replaceAll('notice-x', 'stop-x');
  const esc = fs.readFileSync(path.join(fixture, 'screen-esc-2s.txt'), 'utf8').replaceAll('notice-esc', 'stop-esc');
  screens[3] = x; screens[15] = esc;
  const nav = navigation(dir, screens);
  await driveStops(nav.ctx, nav);
  assert.deepEqual(nav.calls.filter(call => call[0] === 'keys').map(call => call[2]), keys);
});

function terminal(t, { lostX = false, startupFailure = false, cancelFailure = false } = {}) {
  const { dir, input } = setup(t);
  const main = readTranscript(input.transcript), run = { ...json(path.join(dir, 'run.json')), ...input, pane: 'fixture-pane' };
  const screens = json(path.join(fixture, 'screens.json'));
  const nav = navigation(dir, lostX ? screens.slice(0, 3) : screens);
  const pending = [], jobs = new Map();
  for (const key of ['x', 'esc', 'ts']) {
    const jobDir = path.join(input.jobsHome, 'repo', `job-${key}`);
    jobs.set(key, json(path.join(jobDir, 'job.json')));
    edit(dir, `jobs/repo/job-${key}/job.json`, job => {
      job.state = job.attempts[0].state = 'running'; job.completedAt = job.attempts[0].endedAt = null; job.messages = [];
    });
    fs.rmSync(path.join(jobDir, 'inbox'), { recursive: true });
  }
  lines(input.transcript, main.slice(0, 9));
  const ctx = { ...input, run, timeoutMinutes: stopNotice.timeoutMinutes,
    save: () => write(path.join(dir, 'run.json'), run),
    paneDriver: async (_ctx, _check, options) => {
      assert.equal(options.keep, true);
      if (startupFailure) { fs.appendFileSync(input.transcript, '{"type":'); throw new Error('Startup failed after spawning.'); }
    } };
  const append = row => fs.appendFileSync(input.transcript, JSON.stringify(row) + '\n');
  const drive = args => {
    const result = nav.drive(args);
    if (args[0] === 'keys' && ['x', 'Escape'].includes(args[2])) {
      const key = args[2] === 'x' ? 'x' : 'esc';
      const at = nav.now() + (key === 'x' ? 1200 : 900);
      pending.push({ at, action: () => append({ type: 'system', subtype: 'informational', timestamp: new Date(at).toISOString(), content: noticeText(`stop-${key}`, `job-${key}`) }) });
    }
    if (args[0] === 'send') {
      const delta = nav.now() - Date.parse('2026-10-23T10:00:40.000Z');
      const shift = value => JSON.parse(JSON.stringify(value).replace(/2026-10-23T[\d:.]+Z/g, at => new Date(Date.parse(at) + delta).toISOString()));
      const rows = main.slice(11).map(shift);
      for (const row of rows) pending.push({ at: Date.parse(row.timestamp), action: () => append(row) });
      pending.push({ at: nav.now() + 1300, action() {
        write(path.join(input.jobsHome, 'repo/job-ts/job.json'), shift(jobs.get('ts')));
        fs.cpSync(path.join(fixture, 'jobs/repo/job-ts/inbox'), path.join(input.jobsHome, 'repo/job-ts/inbox'), { recursive: true });
        for (const file of ['inbox/claimed/cancel-ts.json', 'inbox/outcomes/cancel-ts.json']) {
          const target = path.join(input.jobsHome, 'repo/job-ts', file); write(target, shift(json(target)));
        }
        lines(path.join(input.jobsHome, 'repo/job-ts/relay-handbacks.jsonl'), readTranscript(path.join(fixture, 'jobs/repo/job-ts/relay-handbacks.jsonl')).map(shift));
      } });
    }
    return result;
  };
  const dependencies = { drive, now: nav.now, sleep: async ms => {
    await nav.sleep(ms);
    for (const item of pending.sort((a, b) => a.at - b.at)) if (!item.done && item.at <= nav.now()) { item.done = true; item.action(); }
  }, companionRunner: async (_ctx, args) => {
    nav.calls.push(args);
    const file = path.join(args[1], 'job.json'), job = json(file);
    if (args[0] === 'status') return JSON.stringify(job);
    assert.equal(args[0], 'cancel');
    if (cancelFailure) throw new Error('Cancel failed.');
    job.state = job.attempts[0].state = 'cancelled';
    job.completedAt = job.attempts[0].endedAt = new Date(nav.now()).toISOString(); write(file, job);
    return '';
  } };
  return { dir, input, ctx, calls: nav.calls, dependencies };
}

test('stop-notice terminal observes running jobs, cleans them up and replays the same result', async t => {
  const { input, ctx, calls, dependencies } = terminal(t);
  const result = await stopNotice.runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'pass', result.results[0].reason);
  assert.deepEqual(result.results[0].timings.xNoticeSeconds, [1.2]);
  assert.deepEqual(result.results[0].timings.escNoticeSeconds, [0.9]);
  for (const key of ['x', 'esc']) {
    const receipt = ctx.run.stopNotice.codex[key];
    assert.equal(receipt.after.state, 'running');
    assert.ok(Date.parse(receipt.after.at) - Date.parse(receipt.keyAt) >= 15000);
    assert.ok(Date.parse(receipt.cleanupAt) >= Date.parse(receipt.after.at));
  }
  assert.deepEqual(calls.filter(call => call[0] === 'cancel').map(call => path.basename(call[1])), ['job-x', 'job-esc']);
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
  assert.deepEqual(stopNotice.analyze(input).results, result.results);
});

test('stop-notice terminal cleans up every job after navigation failure', async t => {
  const { ctx, calls, dependencies } = terminal(t, { lostX: true });
  await assert.rejects(stopNotice.runTerminal(ctx, dependencies), /stop-x stopped in the footer/);
  assert.deepEqual(calls.filter(call => call[0] === 'cancel').map(call => path.basename(call[1])), ['job-x', 'job-esc', 'job-ts']);
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
  assert.equal(ctx.run.completed, false);
});

test('stop-notice terminal discovers startup jobs despite a partial transcript row', async t => {
  const { ctx, calls, dependencies } = terminal(t, { startupFailure: true });
  await assert.rejects(stopNotice.runTerminal(ctx, dependencies), /Startup failed after spawning/);
  assert.match(ctx.run.cleanupScanError, /Invalid JSON at/);
  assert.deepEqual(calls.filter(call => call[0] === 'cancel').map(call => path.basename(call[1])), ['job-x', 'job-esc', 'job-ts']);
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
});

test('stop-notice terminal reports cleanup errors and still tries every running job', async t => {
  const { ctx, calls, dependencies } = terminal(t, { cancelFailure: true });
  const result = await stopNotice.runTerminal(ctx, dependencies);
  assert.equal(result.results[0].result, 'fail'); assert.match(result.results[0].reason, /Cleanup failed: Cancel failed/);
  assert.deepEqual(calls.filter(call => call[0] === 'cancel').map(call => path.basename(call[1])), ['job-x', 'job-esc']);
  assert.deepEqual(calls.at(-1), ['stop', 'fixture-pane']);
});

test('stop-notice analysis requires the lead turn to end after the TaskStop hook', t => {
  const { dir, input } = setup(t);
  editLines(dir, rows => { rows.findLast(row => row.subtype === 'turn_duration').timestamp = '2026-10-23T10:00:40.500Z'; });
  const row = stopNotice.analyze(input).results[0];
  assert.equal(row.result, 'fail'); assert.match(row.reason, /ended turn/);
});
