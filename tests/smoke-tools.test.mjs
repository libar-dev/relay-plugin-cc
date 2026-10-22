import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function copyFixture(t) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'relay-smoke-tools-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function edit(dir, file, change) {
  const target = path.join(dir, file);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  change(value);
  fs.writeFileSync(target, JSON.stringify(value));
}

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
  // Derive names from CLI inputs so the same fake can model two marketplaces.
  const claude = fs.readFileSync(path.join(root, 'tests/fixtures/smoke-tools/fake-claude.cjs'), 'utf8')
    .replace("const plugin = 'relay@relay-smoke';", `const name = action === 'plugin marketplace add'
  ? read(path.join(args[3], '.claude-plugin/marketplace.json')).name
  : action === 'plugin marketplace remove' ? args[3] : args[2]?.split('@')[1];
const plugin = args[2];`)
    .replaceAll("['relay-smoke']", '[name]')
    .replace("'plugins/cache/relay-smoke/relay/test-version'", "'plugins/cache', name, 'relay/test-version'")
    .replace('write(known, marketplaces);', `write(known, marketplaces);
  if (process.env.SMOKE_FAIL_AFTER_REGISTRATION) fail('Simulated failure after registering the marketplace');`)
    .replace("if (!marketplaces[name]) fail('Marketplace not found');", `if (!marketplaces[name]) fail('Marketplace not found');
  if (process.env.SMOKE_KEEP_REGISTRATION) process.exit(0);`);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n` +
    claude, { mode: 0o755 });
  return { dir, home, config, env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(dir, 'state'), CLAUDE_CONFIG_DIR: config, TMPDIR: dir,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, SMOKE_CALL_LOG: path.join(dir, 'calls.jsonl') } };
}

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
  assert.equal(marker.worktree, true);
  assert.equal(marker.commit, spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim());
  const exported = path.join(marker.marketplace, 'relay');
  assert.deepEqual(readJson(path.join(exported, '.claude-plugin/build.json')), { commit: marker.commit.slice(0, 12) + '-dirty' });
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
    const undone = smokeScript('uninstall', work, env);
    // An add that failed before registering leaves the name unregistered, so only the receipt's own folder
    // is checked, and the cleanup goes on.
    assert.equal(undone.status, 0, undone.stderr);
    assert.deepEqual(callLog(env).slice(before), action === 'plugin install'
      ? [['plugin', 'marketplace', 'remove', 'relay-smoke']] : []);
    assert.deepEqual(readJson(settingsPath(work)), { enabledPlugins: { 'relay@libar-relay': false, 'relay@relay-smoke': true } });
    assert.equal(fs.existsSync(saved.marketplace), false);
    assert.equal(fs.existsSync(receiptPath(work, env)), false);
    assert.deepEqual(readJson(path.join(config, 'plugins/cache/relay-smoke/keep.json')), { createdLater: true });
  });
}

test('ownership mismatch preserves the replacement plugin, settings, cache and receipt', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir), name = 'relay-smoke-2';
  assert.equal(smokeScript('install', work, env, '--name', name, '--repo', root, '--worktree').status, 0);
  const saved = readJson(receiptPath(work, env));
  const replacement = path.join(dir, 'replacement-marketplace');
  writeJson(path.join(replacement, '.claude-plugin/marketplace.json'), { name });
  writeJson(path.join(config, 'plugins/known_marketplaces.json'), { [name]: { installLocation: replacement } });
  const cache = path.join(config, 'plugins/cache', name, 'relay/replacement-version');
  writeJson(path.join(cache, 'sentinel.json'), { replacement: true });
  writeJson(path.join(config, 'plugins/installed_plugins.json'), { plugins: {
    [`relay@${name}`]: [{ scope: 'local', projectPath: work, installPath: cache }]
  } });
  writeJson(settingsPath(work), { enabledPlugins: { [`relay@${name}`]: true },
    extraKnownMarketplaces: { [name]: { source: { source: 'directory', path: replacement } } } });
  const before = snapshot(dir), calls = callLog(env);
  const undone = smokeScript('uninstall', work, env);
  assert.notEqual(undone.status, 0);
  assert.match(undone.stderr, /keeping its receipt; changing nothing: receipt path does not match the registered relay-smoke-2 installLocation/);
  assert.deepEqual(callLog(env), calls);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(fs.existsSync(saved.marketplace), true);
  assert.equal(fs.existsSync(receiptPath(work, env)), true);
});

test('cleanup deregisters a failed marketplace add before removing its folder and receipt', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  env.SMOKE_FAIL_AFTER_REGISTRATION = '1';
  const installed = installSmoke(work, env);
  assert.equal(installed.status, 1);
  assert.match(installed.stderr, /failure after registering/);
  const saved = readJson(receiptPath(work, env));
  assert.equal(saved.addedMarketplace, false);
  assert.equal(readJson(path.join(config, 'plugins/known_marketplaces.json'))[saved.name].installLocation, saved.marketplace);
  const calls = callLog(env).length;
  const undone = smokeScript('uninstall', work, env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.deepEqual(callLog(env).slice(calls), [['plugin', 'marketplace', 'remove', saved.name]]);
  assert.equal(readJson(path.join(config, 'plugins/known_marketplaces.json'))[saved.name], undefined);
  assert.equal(fs.existsSync(saved.marketplace), false);
  assert.equal(fs.existsSync(receiptPath(work, env)), false);
  assert.equal(fs.existsSync(path.join(work, '.claude')), false);
});

for (const failure of ['marketplace removed by hand', 'add that failed before registering']) {
  test(`uninstall cleans up after a ${failure}`, t => {
    const { dir, config, env } = fakeCli(t);
    const work = workDir(dir);
    if (failure === 'add that failed before registering') env.SMOKE_FAIL_ACTION = 'plugin marketplace add';
    const installed = installSmoke(work, env);
    const saved = readJson(receiptPath(work, env));
    if (failure === 'marketplace removed by hand') {
      assert.equal(installed.status, 0, installed.stderr);
      const known = readJson(path.join(config, 'plugins/known_marketplaces.json'));
      delete known[saved.name];
      writeJson(path.join(config, 'plugins/known_marketplaces.json'), known);
    } else {
      assert.notEqual(installed.status, 0);
      assert.equal(saved.addedMarketplace, false);
    }
    const known = path.join(config, 'plugins/known_marketplaces.json');
    assert.equal(fs.existsSync(known) ? readJson(known)[saved.name] : undefined, undefined);
    const undone = smokeScript('uninstall', work, env);
    assert.equal(undone.status, 0, undone.stderr);
    assert.ok(!callLog(env).some(call => call.join(' ').startsWith('plugin marketplace remove')));
    assert.equal(fs.existsSync(saved.marketplace), false);
    assert.equal(fs.existsSync(receiptPath(work, env)), false);
  });
}

test('failed add receipt preserves a registration at another location', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  env.SMOKE_FAIL_AFTER_REGISTRATION = '1';
  assert.equal(installSmoke(work, env).status, 1);
  const saved = readJson(receiptPath(work, env));
  assert.equal(saved.addedMarketplace, false);
  const replacement = path.join(dir, 'replacement-marketplace');
  writeJson(path.join(replacement, '.claude-plugin/marketplace.json'), { name: saved.name });
  writeJson(path.join(config, 'plugins/known_marketplaces.json'), { [saved.name]: { installLocation: replacement } });
  const before = snapshot(dir), calls = callLog(env);
  const undone = smokeScript('uninstall', work, env);
  assert.notEqual(undone.status, 0);
  assert.match(undone.stderr, /keeping its receipt; changing nothing: receipt path does not match/);
  assert.deepEqual(callLog(env), calls);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(fs.existsSync(saved.marketplace), true);
  assert.equal(fs.existsSync(receiptPath(work, env)), true);
});

for (const failure of ['CLI failure', 'successful exit with registration retained']) {
  test(`failed add cleanup keeps the folder and receipt after deregistration ${failure}`, t => {
    const { dir, config, env } = fakeCli(t);
    const work = workDir(dir);
    env.SMOKE_FAIL_AFTER_REGISTRATION = '1';
    assert.equal(installSmoke(work, env).status, 1);
    const saved = readJson(receiptPath(work, env));
    if (failure === 'CLI failure') env.SMOKE_FAIL_ACTION = 'plugin marketplace remove';
    else env.SMOKE_KEEP_REGISTRATION = '1';
    const before = snapshot(dir).filter(([name]) => name !== 'calls.jsonl');
    const calls = callLog(env).length;
    const undone = smokeScript('uninstall', work, env);
    assert.notEqual(undone.status, 0);
    assert.match(undone.stderr, failure === 'CLI failure' ? /Simulated CLI failure/ : /name is still registered/);
    assert.deepEqual(callLog(env).slice(calls), [['plugin', 'marketplace', 'remove', saved.name]]);
    assert.deepEqual(snapshot(dir).filter(([name]) => name !== 'calls.jsonl'), before);
    assert.equal(readJson(path.join(config, 'plugins/known_marketplaces.json'))[saved.name].installLocation, saved.marketplace);
    assert.equal(fs.existsSync(saved.marketplace), true);
    assert.equal(fs.existsSync(receiptPath(work, env)), true);
    delete env.SMOKE_FAIL_ACTION;
    delete env.SMOKE_KEEP_REGISTRATION;
    const retried = smokeScript('uninstall', work, env);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(fs.existsSync(saved.marketplace), false);
    assert.equal(fs.existsSync(receiptPath(work, env)), false);
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

test('install with --name relay-smoke-2 coexists with relay-smoke in another folder', t => {
  const { dir, config, env } = fakeCli(t);
  const first = workDir(dir);
  assert.equal(installSmoke(first, env).status, 0);
  const work = path.join(dir, 'second work');
  fs.mkdirSync(work);
  const installed = smokeScript('install', work, env, '--name', 'relay-smoke-2', '--repo', root, '--worktree');
  assert.equal(installed.status, 0, installed.stderr);
  const saved = readJson(receiptPath(work, env));
  assert.equal(saved.name, 'relay-smoke-2');
  assert.equal(readJson(path.join(saved.marketplace, '.claude-plugin/marketplace.json')).name, 'relay-smoke-2');
  assert.match(path.basename(saved.marketplace), /^relay-smoke-mkt-/);
  assert.equal(saved.createdCache, true);
  assert.equal(fs.existsSync(path.join(config, 'plugins/cache/relay-smoke-2')), true);
  assert.deepEqual(callLog(env).slice(-2), [
    ['plugin', 'install', 'relay@relay-smoke-2', '--scope', 'local'],
    ['plugin', 'disable', 'relay@libar-relay', '--scope', 'local']
  ]);
  assert.match(installed.stdout, /Installed relay@relay-smoke-2 locally/);
});

test('uninstall of relay-smoke-2 preserves relay-smoke registration, cache and settings', t => {
  const { dir, config, env } = fakeCli(t);
  const first = workDir(dir);
  assert.equal(installSmoke(first, env).status, 0);
  const firstReceipt = readJson(receiptPath(first, env));
  const firstWork = snapshot(first), firstMarketplace = snapshot(firstReceipt.marketplace);
  writeJson(path.join(config, 'plugins/cache/relay-smoke/keep.json'), { keep: true });
  const firstCache = snapshot(path.join(config, 'plugins/cache/relay-smoke'));
  const registry = readJson(path.join(config, 'plugins/installed_plugins.json'));
  const known = readJson(path.join(config, 'plugins/known_marketplaces.json'));
  const work = path.join(dir, 'second work');
  fs.mkdirSync(work);
  const original = readJson(settingsPath(first));
  writeJson(settingsPath(work), original);
  const installed = smokeScript('install', work, env, '--name', 'relay-smoke-2', '--repo', root, '--worktree');
  assert.equal(installed.status, 0, installed.stderr);
  const saved = readJson(receiptPath(work, env));
  const undone = smokeScript('uninstall', work, env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.deepEqual(callLog(env).slice(-2), [
    ['plugin', 'uninstall', 'relay@relay-smoke-2', '--scope', 'local'],
    ['plugin', 'marketplace', 'remove', 'relay-smoke-2']
  ]);
  assert.deepEqual(readJson(path.join(config, 'plugins/installed_plugins.json')), registry);
  assert.deepEqual(readJson(path.join(config, 'plugins/known_marketplaces.json')), known);
  assert.equal(fs.existsSync(path.join(config, 'plugins/cache/relay-smoke')), true);
  assert.deepEqual(snapshot(path.join(config, 'plugins/cache/relay-smoke')), firstCache);
  assert.deepEqual(snapshot(first), firstWork);
  assert.deepEqual(snapshot(firstReceipt.marketplace), firstMarketplace);
  assert.deepEqual(readJson(receiptPath(first, env)), firstReceipt);
  assert.deepEqual(readJson(settingsPath(work)), original);
  assert.equal(fs.existsSync(path.join(config, 'plugins/cache/relay-smoke-2')), false);
  assert.equal(fs.existsSync(saved.marketplace), false);
  assert.equal(fs.existsSync(receiptPath(work, env)), false);
});

test('install refuses invalid marketplace names with exit 2 before writing anything', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  const before = snapshot(dir), folders = fs.readdirSync(dir, { recursive: true }).sort();
  for (const name of ['', 'other', 'relay-smoke-', 'relay-smoke--2', 'relay-smoke-A', 'relay-smoke_2',
    'relay-smoke/../../other', 'relay-smoke-2 extra', 'relay-smoke-2\n', 'relay-smoke-2\r']) {
    const installed = smokeScript('install', work, env, '--name', name);
    assert.equal(installed.status, 2, name);
    assert.match(installed.stderr, /--name/);
    assert.equal(installed.stderr.trim().split('\n').length, 1);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), folders);
    assert.deepEqual(callLog(env), []);
  }
});

test('uninstall accepts an older receipt without name as relay-smoke', t => {
  const { dir, config, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(installSmoke(work, env).status, 0);
  const saved = readJson(receiptPath(work, env));
  delete saved.name;
  writeJson(receiptPath(work, env), saved);
  const undone = smokeScript('uninstall', work, env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.deepEqual(callLog(env).slice(-2), [
    ['plugin', 'uninstall', 'relay@relay-smoke', '--scope', 'local'],
    ['plugin', 'marketplace', 'remove', 'relay-smoke']
  ]);
  assert.equal(fs.existsSync(saved.marketplace), false);
  assert.equal(fs.existsSync(path.join(config, 'plugins/cache/relay-smoke')), false);
  assert.equal(fs.existsSync(path.join(work, '.claude')), false);
  assert.equal(fs.existsSync(receiptPath(work, env)), false);
});

test('uninstall refuses invalid receipt names before changing anything', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  assert.equal(installSmoke(work, env).status, 0);
  const saved = readJson(receiptPath(work, env)), calls = callLog(env);
  for (const name of ['', 'other', 'relay-smoke-', 'relay-smoke--2', 'relay-smoke-A', 'relay-smoke_2',
    'relay-smoke/../../other', 'relay-smoke-2 extra', 'relay-smoke-2\n', 'relay-smoke-2\r', null, 2, ['relay-smoke']]) {
    writeJson(receiptPath(work, env), { ...saved, name });
    const before = snapshot(dir);
    const undone = smokeScript('uninstall', work, env);
    assert.notEqual(undone.status, 0, JSON.stringify(name));
    assert.match(undone.stderr, /Invalid receipt name/);
    assert.equal(undone.stderr.trim().split('\n').length, 1);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(callLog(env), calls);
  }
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
  const before = snapshot(dir), calls = callLog(env);
  const undone = smokeScript('uninstall', work, env);
  assert.notEqual(undone.status, 0);
  assert.match(undone.stderr, /does not match the registered relay-smoke installLocation/);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(fs.existsSync(saved.marketplace), true);
  assert.equal(readJson(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke'].installLocation, saved.marketplace);
  assert.deepEqual(callLog(env), calls);
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
    const before = snapshot(dir), calls = callLog(env);
    const undone = smokeScript('uninstall', work, env);
    assert.notEqual(undone.status, 0);
    assert.match(undone.stderr, /keeping its receipt; changing nothing:/);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(callLog(env), calls);
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

for (const mode of ['inherited', 'server-only', 'no-server', 'empty']) {
  test(`pane start scrubs Claude session variables and preserves other variables: ${mode}`, t => {
    const { dir, env } = fakeCli(t);
    const reserved = name => /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|CHILD_SESSION|SESSION_ATTENDED|EXECPATH))$|^(CLAUDE_AGENT_SDK_|RELAY_COMPANION_)/.test(name);
    for (const name of Object.keys(env)) if (reserved(name)) delete env[name];
    const polluted = { CLAUDECODE: '1', CLAUDE_PID: '123', CLAUDE_EFFORT: 'high', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/socket', CLAUDE_CODE_MESSAGING_TOKEN: 'test-token',
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_EXECPATH: '/tmp/claude',
      CLAUDE_AGENT_SDK_VERSION: 'test', CLAUDE_AGENT_SDK_FUTURE: 'future', RELAY_COMPANION_FUTURE: 'future' };
    if (mode === 'inherited' || mode === 'no-server') Object.assign(env, polluted);
    const config = { CLAUDE_CODE_OAUTH_TOKEN: 'kept-token', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096', CLAUDE_CODE_GIT_BASH_PATH: '/some/bash', CLAUDE_CODE_FUTURE_SETTING: 'keep' };
    Object.assign(env, config);
    const globals = mode === 'inherited' || mode === 'server-only' ? { ...polluted, ...config, CLAUDE_CODE_SERVER_ONLY: 'sdk',
      CLAUDE_CODE_REMOVED: null, SERVER_KEEP: 'retained', CLAUDE_CONFIG_DIR: path.join(dir, 'server config') } : {};
    Object.assign(env, { SMOKE_TMUX_GLOBALS: JSON.stringify(globals), SMOKE_TMUX_LOG: path.join(dir, 'tmux.jsonl'),
      XDG_RUNTIME_DIR: path.join(dir, 'runtime'), ORDINARY_VARIABLE: 'keep me' });
    if (mode === 'no-server') env.SMOKE_TMUX_NO_SERVER = '1';
    fs.writeFileSync(path.join(dir, 'bin/tmux'), `#!${process.execPath}\n` +
      fs.readFileSync(path.join(root, 'tests/fixtures/smoke-tools/fake-tmux.cjs'), 'utf8'), { mode: 0o755 });
    const output = path.join(dir, 'child environment.json');
    const code = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))';
    const result = spawnSync('bash', [path.join(root, 'scripts/smoke/pane.sh'), 'start', 'clean', dir,
      ...(mode === 'empty' ? [] : ['--env', 'RELAY_JOBS_HOME=/tmp/jobs with spaces']), '--', process.execPath, '-e', code, output],
    { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const child = readJson(output);
    assert.deepEqual(Object.keys(child).filter(reserved), []);
    assert.equal(child.CLAUDE_CONFIG_DIR, globals.CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR);
    assert.equal(child.ORDINARY_VARIABLE, 'keep me');
    for (const [name, value] of Object.entries(config)) assert.equal(child[name], value, name);
    if (globals.CLAUDE_CODE_SERVER_ONLY) assert.equal(child.CLAUDE_CODE_SERVER_ONLY, 'sdk');
    const removed = result.stdout.trim().split('\n').filter(Boolean).map(line => line.replace(/^RELAY_LIVE_UNSET /, ''));
    assert.ok(removed.every(reserved));
    if (mode !== 'empty') assert.equal(child.RELAY_JOBS_HOME, '/tmp/jobs with spaces');
    if (globals.SERVER_KEEP) assert.equal(child.SERVER_KEEP, 'retained');
    const calls = fs.readFileSync(env.SMOKE_TMUX_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(args => args[2]), ['show-environment', 'new-session', 'set-option']);
    const command = calls[1].slice(calls[1].indexOf('--') + 1);
    assert.equal(command[0], 'env');
    for (const name of Object.keys({ ...(mode === 'inherited' || mode === 'no-server' ? polluted : {}), ...globals }).filter(reserved)) {
      assert.ok(command.some((value, i) => value === name && command[i - 1] === '-u'), name);
      assert.ok(removed.includes(name), name);
    }
    assert.deepEqual(command.slice(-4), [process.execPath, '-e', code, output]);
  });
}

test('archive install receipt identifies the full exported commit and worktree flag', t => {
  const { dir, env } = fakeCli(t);
  const work = workDir(dir);
  const commit = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const result = smokeScript('install', work, env, '--repo', root, '--ref', commit);
  assert.equal(result.status, 0, result.stderr);
  const saved = readJson(receiptPath(work, env));
  assert.equal(saved.commit, commit);
  assert.equal(saved.worktree, false);
  assert.deepEqual(readJson(path.join(saved.marketplace, 'relay/.claude-plugin/build.json')), { commit: commit.slice(0, 12) });
  assert.equal(smokeScript('uninstall', work, env).status, 0);
});

test('pane pid prints the pane process id on a private tmux socket', async t => {
  const dir = fs.mkdtempSync('/tmp/relay-pane-pid-test-');
  const env = { ...process.env, XDG_RUNTIME_DIR: dir };
  const socket = path.join(dir, 'claude-tmux/tmux.sock');
  t.after(() => {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pane = (...args) => spawnSync('bash', [path.join(root, 'scripts/smoke/pane.sh'), ...args], { env, encoding: 'utf8' });
  for (const args of [[], ['invalid:name'], ['test', 'extra']]) assert.equal(pane('pid', ...args).status, 2);
  const pidFile = path.join(dir, 'process-id'), script = path.join(dir, 'process.cjs');
  fs.writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
  fs.mkdirSync(path.dirname(socket), { mode: 0o700 });
  const started = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'pid-test',
    '--', process.execPath, script, pidFile], { env, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const result = pane('pid', 'pid-test');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\n$/);
  assert.equal(result.stdout.trim(), fs.readFileSync(pidFile, 'utf8'));
  assert.equal(pane('stop', 'pid-test').status, 0);
  assert.notEqual(pane('pid', 'pid-test').status, 0);
});

test('pane start runs in its folder after the folder a tmux server started from is deleted', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/relay-pane-cwd-test-'));
  // pane.sh starts the first server with no -f; a private HOME keeps the user's tmux configuration out of it.
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, HOME: dir, XDG_CONFIG_HOME: dir };
  const socket = path.join(dir, 'claude-tmux/tmux.sock');
  t.after(() => {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pane = (cwd, ...args) => spawnSync('bash', [path.join(root, 'scripts/smoke/pane.sh'), ...args], { env, cwd, encoding: 'utf8' });
  const target = path.join(dir, 'target'), caller = path.join(dir, 'caller'), script = path.join(dir, 'record.cjs');
  fs.mkdirSync(target);
  fs.writeFileSync(script, 'const fs = require("node:fs"); fs.writeFileSync(process.argv[2] + ".tmp", ' +
    'JSON.stringify({ cwd: process.cwd(), pid: process.pid })); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]); ' +
    'setInterval(() => {}, 1000);');
  const recorded = async name => {
    const file = path.join(dir, name), deadline = Date.now() + 5000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  // pane.sh starts the server from its socket's folder, so deleting the caller's folder strands nothing.
  fs.mkdirSync(caller);
  const first = pane(caller, 'start', 'first', target, '--', process.execPath, script, path.join(dir, 'first'));
  assert.equal(first.status, 0, first.stderr);
  const firstRecord = await recorded('first');
  assert.equal(firstRecord.cwd, target);
  assert.equal(pane(dir, 'pid', 'first').stdout.trim(), String(firstRecord.pid));
  fs.rmSync(caller, { recursive: true });
  const direct = spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'direct', '-c', target, '--',
    process.execPath, script, path.join(dir, 'direct')], { env, encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal((await recorded('direct')).cwd, target);
  // A server another caller started from a folder since deleted: the pane's command enters its folder itself.
  const server = Number(spawnSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { env, encoding: 'utf8' }).stdout);
  assert.ok(server > 0);
  assert.equal(spawnSync('tmux', ['-S', socket, 'kill-server'], { env }).status, 0);
  const alive = () => { try { process.kill(server, 0); return true; } catch { return false; } };
  for (const deadline = Date.now() + 5000; alive() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(), false);
  fs.mkdirSync(caller);
  const stranded = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'stranded', '--',
    process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env, cwd: caller, encoding: 'utf8' });
  assert.equal(stranded.status, 0, stranded.stderr);
  fs.rmSync(caller, { recursive: true });
  const second = pane(dir, 'start', 'second', target, '--', process.execPath, script, path.join(dir, 'second'));
  assert.equal(second.status, 0, second.stderr);
  const secondRecord = await recorded('second');
  assert.equal(secondRecord.cwd, target);
  assert.equal(pane(dir, 'pid', 'second').stdout.trim(), String(secondRecord.pid));
});
