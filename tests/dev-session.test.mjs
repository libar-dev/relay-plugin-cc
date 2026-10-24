import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/relay-dev.sh');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dev-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const capture = path.join(dir, 'claude.json');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n` +
    'const fs = require("node:fs");\n' +
    'fs.writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), jobs: process.env.RELAY_JOBS_HOME, admission: process.env.RELAY_ADMISSION_HOME }));\n',
    { mode: 0o755 });
  return { dir, capture, env: {
    ...process.env,
    HOME: path.join(dir, 'home'),
    XDG_STATE_HOME: path.join(dir, 'state with spaces'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_CLAUDE_CAPTURE: capture,
    RELAY_JOBS_HOME: '/production/jobs',
    RELAY_ADMISSION_HOME: '/production/admission'
  } };
}

test('help does not invoke Claude or create development state', t => {
  const { dir, env } = fixture(t);
  const result = spawnSync('bash', [script, '--help'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(fs.existsSync(path.join(dir, 'state with spaces')), false);
});

test('run loads only the checkout plugin with isolated persistent state and preserves arguments', t => {
  const { dir, capture, env } = fixture(t);
  const args = ['--continue', '--debug-file', 'debug with spaces.log'];
  const first = spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const call = JSON.parse(fs.readFileSync(capture, 'utf8'));
  const state = call.jobs.replace(/\/jobs$/, '');
  assert.notEqual(call.jobs, '/production/jobs');
  assert.notEqual(call.admission, '/production/admission');
  assert.equal(call.admission, path.join(state, 'admission'));
  assert.ok(state.includes('state with spaces'));
  assert.deepEqual(call.args, [
    '--plugin-dir', path.join(root, 'plugins/relay'),
    '--settings', '{"enabledPlugins":{"relay@libar-relay":false}}',
    ...args
  ]);
  assert.equal(call.cwd, root);
  assert.equal(fs.existsSync(call.jobs), true);
  assert.equal(fs.existsSync(call.admission), true);

  const second = spawnSync('bash', [script], { env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).jobs, call.jobs, 'the checkout keeps one development home');
});

test('env reports only development paths and status uses the development home', t => {
  const { capture, env } = fixture(t);
  const printed = spawnSync('bash', [script, 'env'], { env, encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /export RELAY_JOBS_HOME=/);
  assert.match(printed.stdout, /export RELAY_ADMISSION_HOME=/);
  assert.match(printed.stdout, /export RELAY_DEV_PLUGIN_DIR=/);
  assert.doesNotMatch(printed.stdout, /\/production\//);

  const status = spawnSync('bash', [script, 'status'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Development checkout:/);
  assert.doesNotMatch(status.stdout, /\/production\//);
  assert.equal(fs.existsSync(capture), false, 'status does not invoke Claude');
});

test('RELAY_DEV_HOME and RELAY_DEV_WORKDIR are honored without changing production settings', t => {
  const { dir, capture, env } = fixture(t);
  const work = path.join(dir, 'work with spaces');
  fs.mkdirSync(work);
  const custom = path.join(dir, 'custom dev home');
  const result = spawnSync('bash', [script], { env: { ...env, RELAY_DEV_HOME: custom, RELAY_DEV_WORKDIR: work }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(call.jobs, path.join(custom, 'jobs'));
  assert.equal(call.admission, path.join(custom, 'admission'));
  assert.equal(call.cwd, work);
});
