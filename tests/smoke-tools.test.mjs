import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyze, parseArgs as analyzerArgs, readTranscript, transcriptCalls } from '../scripts/live/analyze-steer.mjs';
import { buildPrompt, checkCoverage, findTranscript, hasCompletion, inspectDebug,
  parseArgs as liveArgs } from '../scripts/live/steer-wake.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/live-steer');
function copyFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-tools-test-'));
  fs.cpSync(fixture, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function result(dir = fixture, options = {}) {
  return analyze({ jobsHome: path.join(dir, 'jobs'), transcript: path.join(dir, 'transcript.jsonl'),
    claudeCodeVersion: '2.1.308 (Claude Code)', ...options });
}
function edit(dir, file, change) {
  const target = path.join(dir, file);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  change(value);
  fs.writeFileSync(target, JSON.stringify(value));
}
const first = 'jobs/repo/codex-job/inbox/relay/one.json';

test('analyzer resolves names and ids, current and legacy sends, and uses arrival time', () => {
  const analyzed = result();
  assert.equal(analyzed.pass, false);
  assert.deepEqual(analyzed.records.map(row => row.latencySeconds), [2, 10, 12]);
  assert.deepEqual(analyzed.records.map(row => row.pass), [true, true, false]);
  assert.deepEqual(analyzed.records.map(row => row.matchedBy), ['text', 'text', 'order']);
  assert.deepEqual(analyzed.summaries, ['codex: 1/2 within 10 s', 'grok: 1/1 within 10 s']);
  assert.equal(analyzed.records[0].relayVersion, '2.2.0-test');
  assert.equal(analyzed.records[0].model, 'gpt-6.1-sol');
  assert.equal(analyzed.records[0].claudeCodeVersion, '2.1.308 (Claude Code)');
  assert.equal(analyzed.records[0].surface, 'terminal');
  assert.equal(result(fixture, { limitSeconds: 12 }).pass, true);
});

test('duplicate progress snapshots do not add sends or lose their timestamps', () => {
  const entries = readTranscript(path.join(fixture, 'transcript.jsonl'));
  const snapshot = structuredClone(entries[4]);
  delete snapshot.timestamp;
  assert.equal(transcriptCalls([snapshot, ...entries, snapshot]).sends.length, 3);
  assert.equal(transcriptCalls([snapshot, ...entries]).sends[0].sentAt, entries[4].timestamp);
});

test('text matching takes precedence over ledger order and never reuses a record', t => {
  const dir = copyFixture(t);
  edit(dir, first, row => { row.at = '2026-10-22T10:01:02.000Z'; });
  edit(dir, 'jobs/repo/codex-job/inbox/relay/three.json', row => { row.text = 'steer 2 for codex'; row.at = '2026-10-22T10:00:33.000Z'; });
  const rows = result(dir).records;
  assert.equal(rows[0].latencySeconds, 32);
  assert.equal(rows[2].latencySeconds, -27);
  assert.match(rows[2].error, /predates/);
  assert.notEqual(rows[0].deliveryRecord, rows[2].deliveryRecord);
});

test('inbox text mismatches cannot pass by ordinal fallback', t => {
  const dir = copyFixture(t);
  edit(dir, 'jobs/repo/codex-job/inbox/claimed/message-one.json', row => { row.text = 'unrelated message'; });
  edit(dir, 'jobs/repo/codex-job/inbox/relay/three.json', row => { row.text = 'also unrelated'; });
  assert.match(result(dir).records[0].error, /No matching/);
});

test('pending inbox message files supply text before they are claimed', t => {
  const dir = copyFixture(t);
  fs.renameSync(path.join(dir, 'jobs/repo/codex-job/inbox/claimed/message-one.json'), path.join(dir, 'jobs/repo/codex-job/inbox/message-one.json'));
  assert.equal(result(dir).records[0].matchedBy, 'text');
});

test('missing pointers and ledgers are failed records, and no sends cannot pass', t => {
  const dir = copyFixture(t);
  fs.rmSync(path.join(dir, 'jobs/relays/agent-codex.json'));
  fs.rmSync(path.join(dir, 'jobs/repo/grok-job/inbox/relay/two.json'));
  assert.deepEqual(result(dir).records.map(row => row.pass), [false, false, false]);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '');
  assert.equal(result(dir).pass, false);
});

for (const [label, change, error] of [
  ['bad time', row => { row.at = 'invalid'; }, /timestamp/],
  ['failed status', row => { row.status = 'failed'; }, /status/],
  ['continue', row => { row.kind = 'continue'; }, /Expected steer/]
]) {
  test(`analyzer rejects ${label}`, t => {
    const dir = copyFixture(t);
    edit(dir, first, change);
    const row = result(dir).records[0];
    assert.equal(row.pass, false);
    assert.match(row.error, error);
  });
}

test('version comes from the attempt active at the send', t => {
  const dir = copyFixture(t);
  edit(dir, 'jobs/repo/codex-job/job.json', job => job.attempts.push({ startedAt: '2026-10-22T11:00:00.000Z', relayVersion: 'future-version' }));
  assert.equal(result(dir).records[0].relayVersion, '2.2.0-test');
  assert.equal(result(dir, { claudeCodeVersion: null }).records[0].pass, false);
});

test('analyzer reports malformed transcript JSON with its line number', t => {
  const dir = copyFixture(t);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '{}\n{bad}\n');
  assert.throws(() => result(dir), /transcript.jsonl:2/);
});

test('argument parsing accepts defaults and rejects incomplete or unsafe values', () => {
  assert.equal(analyzerArgs(['--jobs-home', '/tmp/jobs', '--transcript', '/tmp/lead']).limitSeconds, 10);
  for (const args of [[], ['--jobs-home'], ['--jobs-home', '--transcript'], ['--unknown'],
    ['--jobs-home', '/tmp/jobs', '--transcript', '/tmp/lead', '--limit-seconds', 'NaN'],
    ['--jobs-home', '/tmp/jobs', '--transcript', '/tmp/lead', '--limit-seconds', '-1'],
    ['--jobs-home', '/tmp/jobs', '--transcript', '/tmp/lead', '--out', '/tmp/lead']]) {
    assert.throws(() => analyzerArgs(args));
  }
  assert.deepEqual(liveArgs([]).backends, ['codex', 'grok', 'zcode', 'kimi']);
  assert.deepEqual(liveArgs(['--backends', 'kimi,codex', '--keep']).backends, ['kimi', 'codex']);
  assert.equal(liveArgs(['--keep']).keep, true);
  for (const args of [['--backends', 'other'], ['--backends', 'codex,codex'], ['--backends', 'codex,'],
    ['--plugin-dir'], ['--timeout-minutes', '0'], ['--timeout-minutes', 'Infinity'], ['--unknown']]) {
    assert.throws(() => liveArgs(args));
  }
});

test('prompt spells out background agents, exact models and all three rounds', () => {
  const prompt = buildPrompt(liveArgs([]));
  const calls = prompt.split('\n').filter(line => line.startsWith('Agent(')).map(line => JSON.parse(line.slice(6, -1)));
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.run_in_background && call.subagent_type === 'relay:job'));
  assert.equal(calls[0].name, 'steer-codex');
  assert.match(calls[0].prompt, /^model: gpt-6.1-sol\neffort: low/);
  assert.match(calls[3].prompt, /^backend: kimi\nmodel: kimi-code\/kimi-for-coding\neffort: low/);
  assert.equal(prompt.split('\n').filter(line => line.startsWith('SendMessage(')).length, 12);
  // Claude Code blocks a standalone sleep: the gaps between rounds are until-loops on the clock.
  assert.equal((prompt.match(/until \[ \$\(date \+%s\) -ge \$t \]/g) ?? []).length, 2);
  assert.doesNotMatch(prompt, /"command":"sleep/);
  assert.match(prompt, /state "running"/);
});

test('completion requires an assistant answer, and coverage requires every round', () => {
  const marker = { type: 'user', message: { content: [{ type: 'text', text: 'LIVE-STEER-DONE' }] } };
  assert.equal(hasCompletion([marker]), false);
  assert.equal(hasCompletion([{ ...marker, type: 'assistant', isSidechain: true }]), false);
  assert.equal(hasCompletion([{ ...marker, type: 'assistant' }]), true);
  const rows = [1, 2, 3].map(round => ({ backend: 'codex', message: `steer ${round} for codex` }));
  assert.equal(checkCoverage(rows, ['codex']), true);
  assert.equal(checkCoverage([rows[0], rows[0], rows[2]], ['codex']), false);
  assert.equal(checkCoverage(rows, ['codex', 'kimi']), false);
});

test('startup evidence distinguishes expected plugin, module load and load errors', () => {
  const log = '[DEBUG] Read hooks.json for plugin relay (enabled=true): /tmp/plugin/hooks/hooks.json\n' +
    '[DEBUG] Hooks: SessionStart:startup [node "/tmp/plugin/scripts/hooks/session-lifecycle.mjs"] (plugin relay@inline)\n' +
    '[DEBUG] hooks module relay@inline loaded (environment 5); events: session.send\n';
  assert.equal(inspectDebug(log, '/tmp/plugin').moduleLoaded, true);
  assert.equal(inspectDebug(log, '/tmp/plugin').pluginRead, true);
  assert.equal(inspectDebug(log, '/tmp/other').pluginRead, false);
  const failed = inspectDebug(log + '[ERROR] /tmp/plugin/hooks/mod/register.js failed to load', '/tmp/plugin');
  assert.equal(failed.moduleLoaded, false);
  assert.equal(failed.moduleErrors.length, 1);
});

test('transcript discovery uses the working directory and debug session id', t => {
  const dir = copyFixture(t);
  const id = '12345678-1234-1234-1234-123456789abc';
  const project = path.join(dir, 'projects', '-tmp-steer-test');
  fs.mkdirSync(project, { recursive: true });
  const target = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(target, '{}\n');
  assert.equal(findTranscript('/tmp/steer-test', `/tmp/debug/${id}.txt`, dir), target);
  assert.equal(findTranscript('/tmp/no-match', `/tmp/debug/${id}.txt`, dir), null);
});

test('shell help and invalid arguments never need tmux or Claude', () => {
  for (const file of ['pane.sh', 'install-local.sh', 'uninstall-local.sh']) {
    const script = path.join(root, 'scripts/smoke', file);
    const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    assert.notEqual(spawnSync('bash', [script], { encoding: 'utf8' }).status, 0);
  }
  for (const args of [['send', 'name'], ['keys', 'name'], ['read', 'name', '-1'], ['wait', 'name', '['],
    ['wait', 'name', 'ready', 'bad'], ['start', 'name', '/tmp', '--env', 'not-an-assignment', '--', 'bash'],
    ['start', 'name', '/tmp', 'bash'], ['stop', 'bad:name'], ['list', 'extra'], ['unknown']]) {
    assert.equal(spawnSync('bash', [path.join(root, 'scripts/smoke/pane.sh'), ...args], { encoding: 'utf8' }).status, 2);
  }
  assert.equal(spawnSync('bash', [path.join(root, 'scripts/smoke/install-local.sh'), '/tmp', '--ref', 'HEAD', '--worktree']).status, 2);
});

function fakeCli(t) {
  const dir = copyFixture(t);
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  // This executable records arguments only. Tests never invoke the real Claude CLI.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.SMOKE_CALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === '--version') console.log('2.1.308 (Claude Code)');
`, { mode: 0o755 });
  return { dir, home, env: { ...process.env, HOME: home, TMPDIR: dir,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, SMOKE_CALL_LOG: path.join(dir, 'calls.jsonl') } };
}

test('analyzer CLI writes JSONL and returns failure or success from the limit', t => {
  const { dir, env } = fakeCli(t);
  const out = path.join(dir, 'results.jsonl');
  const args = [path.join(root, 'scripts/live/analyze-steer.mjs'), '--jobs-home', path.join(dir, 'jobs'),
    '--transcript', path.join(dir, 'transcript.jsonl'), '--out', out];
  const failed = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, '');
  assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 3);
  assert.match(failed.stderr, /codex: 1\/2 within 10 s/);
  assert.equal(spawnSync(process.execPath, [...args, '--limit-seconds', '12'], { env }).status, 0);
});

test('worktree export excludes generated types and keeps local settings on repeated cleanup', t => {
  const { dir, env } = fakeCli(t);
  const work = path.join(dir, 'work with spaces');
  fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
  const settings = path.join(work, '.claude/settings.local.json');
  const original = { enabledPlugins: { 'relay@libar-relay': false, 'other@plugin': true }, permissions: { allow: ['Bash(pwd)'] } };
  fs.writeFileSync(settings, JSON.stringify(original));
  const install = spawnSync('bash', [path.join(root, 'scripts/smoke/install-local.sh'), work, '--repo', root, '--worktree'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(work, '.claude/relay-smoke-local.json'), 'utf8'));
  const exported = path.join(marker.marketplace, 'relay');
  assert.equal(fs.existsSync(path.join(exported, '.claude-plugin/types')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(exported, '.claude-plugin/plugin.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(root, 'plugins/relay/.claude-plugin/plugin.json'), 'utf8')));
  const calls = fs.readFileSync(env.SMOKE_CALL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.slice(-2)), [['--scope', 'local'], ['--scope', 'local'], ['--scope', 'local']]);
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['plugin', 'marketplace', 'add'], ['plugin', 'install', 'relay@relay-smoke'], ['plugin', 'disable', 'relay@libar-relay']
  ]);
  for (let i = 0; i < 2; i++) {
    const undo = spawnSync('bash', [path.join(root, 'scripts/smoke/uninstall-local.sh'), work], { env, encoding: 'utf8' });
    assert.equal(undo.status, 0, undo.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original);
  }
});
