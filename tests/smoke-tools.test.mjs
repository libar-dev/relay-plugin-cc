import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyze, parseArgs as analyzerArgs, readTranscript, transcriptCalls } from '../scripts/live/analyze-steer.mjs';
import { buildPrompt, checkCoverage, findTranscript, hasCompletion, inspectDebug,
  parseArgs as liveArgs } from '../scripts/live/steer-wake.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/live-steer');
function copyFixture(t) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'relay-smoke-tools-test-'));
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

test('shell help and invalid arguments never need tmux or Claude', t => {
  const { dir, env } = fakeCli(t);
  for (const file of ['pane.sh', 'install-local.sh', 'uninstall-local.sh']) {
    const script = path.join(root, 'scripts/smoke', file);
    const help = spawnSync('bash', [script, '--help'], { env, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    assert.notEqual(spawnSync('bash', [script], { env, encoding: 'utf8' }).status, 0);
  }
  for (const args of [['send', 'name'], ['keys', 'name'], ['read', 'name', '-1'], ['wait', 'name', '['],
    ['wait', 'name', 'ready', 'bad'], ['start', 'name', '/tmp', '--env', 'not-an-assignment', '--', 'bash'],
    ['start', 'name', '/tmp', 'bash'], ['stop', 'bad:name'], ['list', 'extra'], ['unknown']]) {
    assert.equal(spawnSync('bash', [path.join(root, 'scripts/smoke/pane.sh'), ...args], { env, encoding: 'utf8' }).status, 2);
  }
  assert.equal(spawnSync('bash', [path.join(root, 'scripts/smoke/install-local.sh'), dir, '--ref', 'HEAD', '--worktree'], { env }).status, 2);
});

function fakeCli(t) {
  const dir = copyFixture(t);
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const config = path.join(dir, 'config override');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n` +
    fs.readFileSync(path.join(root, 'tests/fixtures/smoke-tools/fake-claude.cjs'), 'utf8'), { mode: 0o755 });
  return { dir, home, config, env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(dir, 'state'), CLAUDE_CONFIG_DIR: config, TMPDIR: dir,
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

test('worktree export excludes generated types and keeps local settings on cleanup', t => {
  const { dir, env } = fakeCli(t);
  const work = path.join(dir, 'work with spaces');
  fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
  const settings = path.join(work, '.claude/settings.local.json');
  const original = { enabledPlugins: { 'relay@libar-relay': false, 'other@plugin': true }, permissions: { allow: ['Bash(pwd)'] } };
  fs.writeFileSync(settings, JSON.stringify(original));
  const install = spawnSync('bash', [path.join(root, 'scripts/smoke/install-local.sh'), work, '--repo', root, '--worktree'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const marker = JSON.parse(fs.readFileSync(receiptPath(work, env), 'utf8'));
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
    assert.equal(undo.status, i === 0 ? 0 : 1, undo.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original);
  }
  assert.equal(fs.existsSync(marker.marketplace), false);
  assert.equal(marker.disabledRelay, false);
});

const smokeScript = (name, work, env, ...args) => spawnSync('bash',
  [path.join(root, 'scripts/smoke', `${name}-local.sh`), work, ...args], { env, encoding: 'utf8' });
const installSmoke = (work, env) => smokeScript('install', work, env, '--repo', root, '--worktree');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const receiptPath = (work, env) => path.join(env.XDG_STATE_HOME || path.join(env.HOME, '.local/state'),
  'relay-plugin-cc/smoke-installs', `${createHash('sha256').update(fs.realpathSync(work)).digest('hex')}.json`);
const settingsPath = work => path.join(work, '.claude/settings.local.json');
const callLog = env => fs.existsSync(env.SMOKE_CALL_LOG)
  ? fs.readFileSync(env.SMOKE_CALL_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];
function workDir(dir) {
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  return work;
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'base64')]);
}

test('both scripts reject git subdirectories and symlink aliases before any mutation', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(spawnSync('git', ['init', work]).status, 0);
  const sub = path.join(work, 'sub');
  fs.mkdirSync(sub);
  const alias = path.join(dir, 'sub-alias');
  fs.symlinkSync(sub, alias);
  writeJson(settingsPath(work), { enabledPlugins: { 'relay@libar-relay': true } });
  const before = snapshot(work);
  for (const target of [sub, alias]) {
    for (const name of ['install', 'uninstall']) {
      const result = smokeScript(name, target, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /git work tree top level/);
      assert.deepEqual(snapshot(work), before);
    }
  }
  assert.deepEqual(callLog(env), []);
  const rootAlias = path.join(dir, 'root-alias');
  fs.symlinkSync(work, rootAlias);
  const installed = installSmoke(rootAlias, env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(smokeScript('uninstall', rootAlias, env).status, 0);
  assert.deepEqual(readJson(settingsPath(work)), { enabledPlugins: { 'relay@libar-relay': true } });
});

for (const mode of ['absent', 'disabled', 'enabled', 'not installed', 'not found']) {
  test(`install handles released relay ${mode} and records whether it disabled it`, t => {
    const { dir, env } = fakeCli(t);
    const work = workDir(dir);
    const original = mode === 'enabled' || mode === 'disabled'
      ? { enabledPlugins: { 'relay@libar-relay': mode === 'enabled' } } : {};
    if (mode !== 'absent') writeJson(settingsPath(work), original);
    if (mode === 'not installed') env.SMOKE_DISABLE_ERROR = 'Plugin "relay@libar-relay" is not installed';
    if (mode === 'not found') env.SMOKE_DISABLE_ERROR = 'Plugin "relay@libar-relay" not found in installed plugins';
    const installed = installSmoke(work, env);
    assert.equal(installed.status, 0, installed.stderr);
    const saved = readJson(receiptPath(work, env));
    assert.equal(saved.tool, 'relay-plugin-cc/scripts/smoke/install-local.sh');
    assert.equal(saved.dir, fs.realpathSync(work));
    assert.equal(saved.tempDirectory, fs.realpathSync(env.TMPDIR));
    assert.equal(fs.statSync(path.dirname(receiptPath(work, env))).mode & 0o777, 0o700);
    assert.equal(fs.statSync(receiptPath(work, env)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(work, '.claude/relay-smoke-local.json')), false);
    assert.equal(saved.disabledRelay, mode === 'enabled');
    assert.equal(saved.installedPlugin, true);
    assert.equal(saved.addedMarketplace, true);
    assert.equal(saved.createdSettingsFile, mode === 'absent');
    const undone = smokeScript('uninstall', work, env);
    assert.equal(undone.status, 0, undone.stderr);
    if (mode === 'absent') assert.equal(fs.existsSync(path.join(work, '.claude')), false);
    else assert.deepEqual(readJson(settingsPath(work)), original);
    assert.equal(fs.existsSync(saved.marketplace), false);
    assert.equal(fs.existsSync(receiptPath(work, env)), false);
    assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'plugins/cache/relay-smoke')), false);
    assert.deepEqual(callLog(env).slice(-2), [
      ['plugin', 'uninstall', 'relay@relay-smoke', '--scope', 'local'],
      ['plugin', 'marketplace', 'remove', 'relay-smoke']
    ]);
  });
}

test('unrecognized disable errors fail but leave an accurate receipt for cleanup', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  env.SMOKE_DISABLE_ERROR = 'Permission denied, not an already disabled or not installed result';
  const installed = installSmoke(work, env);
  assert.equal(installed.status, 1);
  assert.match(installed.stderr, /Permission denied/);
  assert.equal(readJson(receiptPath(work, env)).disabledRelay, false);
  assert.equal(smokeScript('uninstall', work, env).status, 0);
  assert.equal(fs.existsSync(path.join(work, '.claude')), false);
});

for (const action of ['plugin marketplace add', 'plugin install']) {
  test(`cleanup undoes only completed steps after ${action} fails`, t => {
    const { dir, config, env } = fakeCli(t);
    const work = workDir(dir);
    env.SMOKE_FAIL_ACTION = action;
    const installed = installSmoke(work, env);
    assert.equal(installed.status, 1);
    const saved = readJson(receiptPath(work, env));
    assert.equal(saved.installedPlugin, false);
    assert.equal(saved.createdCache, false);
    writeJson(path.join(config, 'plugins/cache/relay-smoke/keep.json'), { createdLater: true });
    assert.equal(saved.addedMarketplace, action === 'plugin install');
    // Unrecorded resources and settings must survive even if they appear later.
    writeJson(settingsPath(work), { enabledPlugins: { 'relay@libar-relay': false, 'relay@relay-smoke': true } });
    writeJson(path.join(config, 'plugins/installed_plugins.json'), { plugins: {
      'relay@relay-smoke': [{ scope: 'local', projectPath: work }]
    } });
    const before = callLog(env).length;
    assert.equal(smokeScript('uninstall', work, env).status, 0);
    assert.deepEqual(callLog(env).slice(before), action === 'plugin install'
      ? [['plugin', 'marketplace', 'remove', 'relay-smoke']] : []);
    assert.deepEqual(readJson(settingsPath(work)), { enabledPlugins: { 'relay@libar-relay': false, 'relay@relay-smoke': true } });
    assert.equal(fs.existsSync(saved.marketplace), action === 'plugin marketplace add');
    assert.deepEqual(readJson(path.join(config, 'plugins/cache/relay-smoke/keep.json')), { createdLater: true });
  });
}

for (const marker of ['absent', 'foreign', 'old']) {
  test(`uninstall refuses cleanup with a receipt that is ${marker} and reports existing resources without changing them`, t => {
    const { dir, config, env } = fakeCli(t);
    const work = workDir(dir);
    writeJson(settingsPath(work), { enabledPlugins: { 'relay@relay-smoke': true, 'relay@libar-relay': false },
      extraKnownMarketplaces: { 'relay-smoke': { source: { source: 'directory', path: '/tmp/manual' } } } });
    writeJson(path.join(config, 'plugins/installed_plugins.json'), { plugins: {
      'relay@relay-smoke': [{ scope: 'local', projectPath: work }]
    } });
    writeJson(path.join(config, 'plugins/known_marketplaces.json'), { 'relay-smoke': { installLocation: '/tmp/manual' } });
    writeJson(path.join(config, 'plugins/cache/relay-smoke/keep.json'), { keep: true });
    if (marker !== 'absent') writeJson(receiptPath(work, env), marker === 'old' ? { marketplace: '/tmp/manual' } : { tool: 'some-other-tool' });
    const before = snapshot(dir);
    const undone = smokeScript('uninstall', work, env);
    assert.notEqual(undone.status, 0);
    assert.match(undone.stderr, /No valid install receipt; refusing to change anything. Found:/);
    assert.match(undone.stderr, /relay@relay-smoke/);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(callLog(env), []);
  });
}

test('uninstall with no receipt and no resources also fails without creating anything', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  const before = snapshot(dir);
  assert.notEqual(smokeScript('uninstall', work, env).status, 0);
  assert.deepEqual(snapshot(dir), before);
});

for (const preexistingCache of [true, false]) {
  test(`config override is used for registries and cleanup, preserving ${preexistingCache ? 'existing' : 'unrelated'} cache`, t => {
    const { dir, home, config, env } = fakeCli(t);
    const work = workDir(dir);
    const defaultConfig = path.join(home, '.claude');
    writeJson(path.join(defaultConfig, 'plugins/installed_plugins.json'), { plugins: {
      'relay@relay-smoke': [{ scope: 'user' }]
    } });
    writeJson(path.join(defaultConfig, 'plugins/known_marketplaces.json'), { 'relay-smoke': {} });
    writeJson(path.join(defaultConfig, 'plugins/cache/relay-smoke/keep.json'), { keep: true });
    const before = snapshot(defaultConfig);
    const cache = path.join(config, 'plugins/cache/relay-smoke');
    if (preexistingCache) writeJson(path.join(cache, 'keep.json'), { keep: true });
    const installed = installSmoke(work, env);
    assert.equal(installed.status, 0, installed.stderr);
    const saved = readJson(receiptPath(work, env));
    assert.equal(saved.createdCache, !preexistingCache);
    assert.equal(saved.config, config);
    assert.equal(smokeScript('uninstall', work, env).status, 0);
    assert.equal(fs.existsSync(cache), preexistingCache);
    if (preexistingCache) assert.deepEqual(readJson(path.join(cache, 'keep.json')), { keep: true });
    assert.deepEqual(snapshot(defaultConfig), before);
    assert.equal(readJson(path.join(config, 'plugins/installed_plugins.json')).plugins['relay@relay-smoke'], undefined);
    assert.equal(readJson(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke'], undefined);
  });
}

test('the smoke scripts use nothing newer than Bash 3.2, which macOS ships as /bin/bash', () => {
  // A static check: CI and the Fedora machine run a newer Bash, so a 4.x feature would pass every
  // other test there and fail on a Mac.
  const newer = [
    [/\b(mapfile|readarray)\b/, 'mapfile/readarray (4.0)'],
    [/\bdeclare\s+-[a-zA-Z]*A/, 'associative arrays (4.0)'],
    [/\blocal\s+-n\b|\bdeclare\s+-n\b/, 'namerefs (4.3)'],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,|\^\^|,|\^)\}/, 'case modification (4.0)'],
    [/\[\[\s+-v\b/, '[[ -v ]] (4.2)'],
    [/\bcoproc\b|\|&|&>>|;;&|\bwait\s+-n\b/, 'a 4.x operator'],
  ];
  for (const name of ['pane.sh', 'install-local.sh', 'uninstall-local.sh']) {
    const text = fs.readFileSync(path.join(root, 'scripts/smoke', name), 'utf8')
      .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    for (const [pattern, what] of newer) assert.doesNotMatch(text, pattern, `${name} uses ${what}`);
  }
});

test('unset config override uses the scratch HOME .claude directory, and claude runs without one', t => {
  const { dir, home, env } = fakeCli(t);
  delete env.CLAUDE_CONFIG_DIR;
  // With CLAUDE_CONFIG_DIR set to ~/.claude, Claude Code reads ~/.claude/.claude.json as its global
  // config and runs its settings migrations again, so the scripts must not set it themselves.
  env.SMOKE_ENV_LOG = path.join(dir, 'env.log');
  const work = workDir(dir);
  const installed = installSmoke(work, env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readJson(receiptPath(work, env)).config, path.join(home, '.claude'));
  assert.equal(smokeScript('uninstall', work, env).status, 0);
  assert.equal(fs.existsSync(path.join(home, '.claude/plugins/cache/relay-smoke')), false);
  const seen = fs.readFileSync(env.SMOKE_ENV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(seen.length >= 4, `claude ran ${seen.length} times`);
  assert.deepEqual([...new Set(seen)], [null]);
});

test('uninstall keeps new unrelated settings and a pre-existing .claude directory', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  fs.mkdirSync(path.join(work, '.claude'));
  assert.equal(installSmoke(work, env).status, 0);
  edit(work, '.claude/settings.local.json', settings => {
    settings.permissions = { allow: ['Bash(pwd)'] };
    settings.extraKnownMarketplaces.other = { source: { source: 'directory', path: '/tmp/other' } };
  });
  assert.equal(smokeScript('uninstall', work, env).status, 0);
  assert.deepEqual(readJson(settingsPath(work)), { permissions: { allow: ['Bash(pwd)'] },
    extraKnownMarketplaces: { other: { source: { source: 'directory', path: '/tmp/other' } } } });
  fs.rmSync(settingsPath(work));
  assert.equal(installSmoke(work, env).status, 0);
  assert.equal(smokeScript('uninstall', work, env).status, 0);
  assert.equal(fs.existsSync(settingsPath(work)), false);
  assert.equal(fs.existsSync(path.join(work, '.claude')), true);
});

test('install detects conflicting registrations in the overridden config directory', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  writeJson(path.join(config, 'plugins/known_marketplaces.json'), { 'relay-smoke': { installLocation: '/tmp/other' } });
  assert.notEqual(installSmoke(work, env).status, 0);
  assert.deepEqual(callLog(env), []);
  assert.equal(fs.existsSync(receiptPath(work, env)), false);
});

test('uninstall refuses a changed config directory and installations shared with another project', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(installSmoke(work, env).status, 0);
  const before = snapshot(work);
  const calls = callLog(env);
  const wrong = smokeScript('uninstall', work, { ...env, CLAUDE_CONFIG_DIR: path.join(dir, 'other-config') });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /different Claude config directory/);
  writeJson(path.join(config, 'plugins/installed_plugins.json'), { plugins: {
    'relay@relay-smoke': [{ scope: 'local', projectPath: '/tmp/some-other-project' }]
  } });
  const shared = smokeScript('uninstall', work, env);
  assert.notEqual(shared.status, 0);
  assert.match(shared.stderr, /installation outside this directory/);
  assert.deepEqual(snapshot(work), before);
  assert.deepEqual(callLog(env), calls);
});


test('a failed plugin install records and cleans up the cache it already created', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  env.SMOKE_FAIL_AFTER_CACHE = '1';
  const installed = installSmoke(work, env);
  assert.equal(installed.status, 1);
  const saved = readJson(receiptPath(work, env));
  assert.equal(saved.installedPlugin, false);
  assert.equal(saved.createdCache, true);
  assert.equal(smokeScript('uninstall', work, env).status, 0);
  assert.equal(fs.existsSync(path.join(config, 'plugins/cache/relay-smoke')), false);
  assert.equal(fs.existsSync(path.join(work, '.claude')), false);
});

for (const trustedReceipt of [false, true]) {
  test(`legacy forged project receipt changes nothing${trustedReceipt ? ' even with a valid state receipt' : ''}`, t => {
    const { dir, config, env } = fakeCli(t);
    const work = workDir(dir);
    if (trustedReceipt) assert.equal(installSmoke(work, env).status, 0);
    const unrelated = path.join(dir, 'relay-smoke-mkt-unrelated');
    writeJson(path.join(unrelated, 'sentinel.json'), { keep: true });
    const cacheSentinel = path.join(config, 'plugins/cache/relay-smoke/sentinel.json');
    writeJson(cacheSentinel, { keep: true });
    writeJson(path.join(work, '.claude/relay-smoke-local.json'), {
      tool: 'relay-plugin-cc/scripts/smoke/install-local.sh', config,
      marketplace: unrelated, createdMarketplace: true, createdCache: true,
      createdSettingsFile: false, createdClaudeDirectory: false, hadPreviousRelay: false,
      addedMarketplace: false, installedPlugin: false, disabledRelay: false
    });
    const before = snapshot(dir), calls = callLog(env);
    const undone = smokeScript('uninstall', work, env);
    assert.notEqual(undone.status, 0);
    assert.match(undone.stderr, /Legacy project install receipt/);
    assert.equal(undone.stderr.trim().split('\n').length, 1);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(callLog(env), calls);
    assert.equal(fs.existsSync(path.join(unrelated, 'sentinel.json')), true);
    assert.equal(fs.existsSync(cacheSentinel), true);
  });
}

test('a forged state receipt cannot delete a marketplace different from the registry', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(installSmoke(work, env).status, 0);
  const saved = readJson(receiptPath(work, env));
  const unrelated = path.join(dir, 'relay-smoke-mkt-unrelated');
  writeJson(path.join(unrelated, '.claude-plugin/marketplace.json'), { name: 'relay-smoke' });
  writeJson(path.join(unrelated, 'sentinel.json'), { keep: true });
  writeJson(receiptPath(work, env), { ...saved, marketplace: unrelated });
  const before = snapshot(unrelated), calls = callLog(env).length;
  const undone = smokeScript('uninstall', work, env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.match(undone.stderr, /does not match the registered relay-smoke installLocation/);
  assert.deepEqual(snapshot(unrelated), before);
  assert.equal(fs.existsSync(saved.marketplace), true);
  assert.equal(readJson(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke'].installLocation, saved.marketplace);
  assert.deepEqual(callLog(env).slice(calls), [['plugin', 'uninstall', 'relay@relay-smoke', '--scope', 'local']]);
});

test('a receipt copied under another DIR hash is refused before any changes', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(installSmoke(work, env).status, 0);
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  fs.copyFileSync(receiptPath(work, env), receiptPath(other, env));
  const before = snapshot(dir), calls = callLog(env);
  const undone = smokeScript('uninstall', other, env);
  assert.notEqual(undone.status, 0);
  assert.match(undone.stderr, /Receipt is for a different DIR/);
  assert.equal(undone.stderr.trim().split('\n').length, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(callLog(env), calls);
});

test('an existing state receipt alone prevents another install through a realpath alias', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  const alias = path.join(dir, 'work-alias');
  fs.symlinkSync(work, alias);
  writeJson(receiptPath(work, env), { partial: true });
  const before = snapshot(dir);
  const installed = installSmoke(alias, env);
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr, /already installed here/);
  assert.equal(installed.stderr.trim().split('\n').length, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(callLog(env), []);
});

for (const invalid of ['temp directory', 'name', 'manifest name', 'missing manifest', 'symlink']) {
  test(`marketplace cleanup keeps the folder with an invalid ${invalid}`, t => {
    const { dir, config, env } = fakeCli(t);
    const work = workDir(dir);
    assert.equal(installSmoke(work, env).status, 0);
    const saved = readJson(receiptPath(work, env));
    let folder = saved.marketplace;
    if (invalid === 'temp directory') saved.tempDirectory = path.join(dir, 'other-temp');
    if (invalid === 'name' || invalid === 'symlink') {
      folder = path.join(dir, 'unrelated');
      fs.renameSync(saved.marketplace, folder);
      if (invalid === 'symlink') fs.symlinkSync(folder, saved.marketplace);
      else saved.marketplace = folder;
      writeJson(path.join(config, 'plugins/known_marketplaces.json'), { 'relay-smoke': { installLocation: saved.marketplace } });
    }
    const manifest = path.join(folder, '.claude-plugin/marketplace.json');
    if (invalid === 'manifest name') writeJson(manifest, { name: 'other' });
    if (invalid === 'missing manifest') fs.rmSync(manifest);
    writeJson(path.join(folder, 'sentinel.json'), { keep: true });
    writeJson(receiptPath(work, env), saved);
    const before = snapshot(folder), calls = callLog(env).length;
    const undone = smokeScript('uninstall', work, env);
    assert.equal(undone.status, 0, undone.stderr);
    assert.match(undone.stderr, /Leaving scratch marketplace:/);
    assert.deepEqual(snapshot(folder), before);
    assert.deepEqual(callLog(env).slice(calls), [['plugin', 'uninstall', 'relay@relay-smoke', '--scope', 'local']]);
  });
}

test('cache cleanup ignores receipt paths and uses only the fixed config cache', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(installSmoke(work, env).status, 0);
  const unrelated = path.join(dir, 'unrelated-cache');
  writeJson(path.join(unrelated, 'sentinel.json'), { keep: true });
  const saved = readJson(receiptPath(work, env));
  writeJson(receiptPath(work, env), { ...saved, cache: unrelated });
  assert.equal(smokeScript('uninstall', work, env).status, 0);
  assert.deepEqual(readJson(path.join(unrelated, 'sentinel.json')), { keep: true });
  assert.equal(fs.existsSync(path.join(config, 'plugins/cache/relay-smoke')), false);
});

for (const target of ['.claude', '.claude/settings.local.json']) {
  test(`project ${target} symlink cannot redirect writes outside the project`, t => {
    const { dir, env } = fakeCli(t);
    const work = workDir(dir);
    assert.equal(installSmoke(work, env).status, 0);
    const external = path.join(dir, 'external');
    fs.renameSync(path.join(work, target), external);
    fs.symlinkSync(external, path.join(work, target));
    const before = snapshot(dir), calls = callLog(env);
    for (const action of ['install', 'uninstall']) {
      const result = smokeScript(action, work, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing project symlink/);
      assert.equal(result.stderr.trim().split('\n').length, 1);
      assert.deepEqual(snapshot(dir), before);
      assert.deepEqual(callLog(env), calls);
    }
  });
}
