import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveGrokHome } from "../plugins/relay/scripts/lib/backends/grok/request.mjs";
import { buildLaunchRequest, parseHeaderPrompt } from "../plugins/relay/scripts/lib/jobs/request.mjs";
import { grokEventRecorder } from "../plugins/relay/scripts/lib/backends/grok/connection.mjs";
import { companion, finishJob, jobDir, promptFile, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { initGitRepo, run } from './support/helpers.mjs';
import { installFakeGrok } from "./fakes/grok.mjs";
const HEADER = 'backend: grok\nmodel: grok-custom\neffort: ultra';
function fixture(t, options = {}) {
  const ctx = setup(t);
  const fake = installFakeGrok(ctx.bin, options);
  ctx.env.GROK_BINARY = fake.binary;
  ctx.env.GROK_SANDBOX = 'strict';
  ctx.env.RELAY_JOBS_CAPACITY_DELAYS_MS = '1';
  ctx.grok = fake.state;
  return ctx;
}

test('header, home selection and refused combinations fail before launch', t => {
  const ctx = fixture(t);
  const repo = path.join(ctx.root, 'repo'); const linked = path.join(ctx.root, 'linked');
  fs.mkdirSync(repo); initGitRepo(repo);
  assert.equal(run('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: repo }).status, 0);
  assert.equal(run('git', ['worktree', 'add', '-b', 'linked', linked], { cwd: repo }).status, 0);
  for (const extra of ['web-search: cached', 'web-search: disabled', 'web-search: indexed', `mode: write\nadd-dir: ${ctx.work}`, `mode: write\ncd: ${linked}`]) {
    const result = companion(ctx, ['start', '--prompt-file', promptFile(ctx, HEADER + '\n' + extra)]);
    assert.equal(result.status, 1, result.stdout);
  }
  assert.throws(() => buildLaunchRequest({ model: 'default', effort: 'default', grokHome: 'default' }), /only valid with backend/);
  assert.throws(() => buildLaunchRequest({ model: 'default', effort: 'default', backend: 'other' }), /backend must/);
  assert.equal(resolveGrokHome('jobs', ctx.env), path.join(ctx.user, '.grok-jobs'));
  assert.equal(resolveGrokHome('default', ctx.env), path.join(ctx.user, '.grok'));
  assert.equal(resolveGrokHome('~/custom', ctx.env), path.join(ctx.user, 'custom'));
  assert.equal(resolveGrokHome(ctx.work, ctx.env), ctx.work);
  assert.equal(parseHeaderPrompt(HEADER + '\ngrok-home: jobs\n---\nx').header.grokHome, 'jobs');
});

test('report is text after the last tool, events coalesce, home and backend survive continue and resume', async t => {
  const ctx = fixture(t, { tools: true });
  const { id, start } = startJob(ctx, HEADER + '\ngrok-home: jobs\nfast: true', '[quick] First.');
  assert.match(start, /backend: grok/); assert.match(start, /grok-home: .*grok-jobs/); assert.match(start, /grok-4.7-build-fast/);
  await finishJob(ctx, id);
  assert.equal(fs.readFileSync(path.join(jobDir(ctx, id), 'report.md'), 'utf8'), 'Report for: [quick] First.\n');
  const events = fs.readFileSync(path.join(jobDir(ctx, id), 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.params?.update?.sessionUpdate === 'agent_message_chunk').length, 2);
  assert.ok(readJob(ctx, id).lastEventAt);
  for (const command of ['continue', 'resume']) {
    assert.equal(companion(ctx, [command, id, '--message', '[quick] Next.'], { GROK_HOME: '/ignored' }).status, 0);
    await finishJob(ctx, id);
  }
  const state = ctx.grok();
  assert.equal(state.requests.filter(r => r.method === 'session/load').length, 2);
  assert.equal(state.requests.filter(r => r.method === 'session/set_config_option').length, 6);
  assert.deepEqual(state.requests.filter(r => r.method === 'session/set_config_option').map(r => [r.params.configId, r.params.value]), Array.from({ length: 3 }, () => [['model', 'grok-custom'], ['reasoning_effort', 'ultra']]).flat());
  assert.ok(state.starts.every(s => s.env.GROK_HOME === path.join(ctx.user, '.grok-jobs')));
  assert.equal(readJob(ctx, id).backendState.binary, fs.realpathSync(ctx.env.GROK_BINARY));
  assert.match(companion(ctx, ['result', id]).stdout, /backend: grok/);
  const json = JSON.parse(companion(ctx, ['result', id, '--json']).stdout);
  assert.equal(json.backend, 'grok'); assert.equal(json.grokHome, path.join(ctx.user, '.grok-jobs'));
});

test('running steer interjects; idle steer and rejected interjection run the next turn', async t => {
  for (const steerError of [false, true]) {
    const ctx = fixture(t, { turnMs: 650, steerError, steered: true });
    const { id } = startJob(ctx, HEADER, 'First.');
    await waitFor(() => readJob(ctx, id).turnId);
    assert.equal(companion(ctx, ['steer', id, '--message', '[quick] Mid-turn.']).status, 0);
    await finishJob(ctx, id);
    assert.equal(ctx.grok().turns.length, steerError ? 2 : 1);
    assert.ok(ctx.grok().requests.some(r => r.method === '_x.ai/interject'));
    assert.equal(companion(ctx, ['steer', id, '--message', '[quick] After.']).status, 0);
    await finishJob(ctx, id);
    assert.equal(ctx.grok().turns.at(-1).text, '[quick] After.');
    assert.equal(readJob(ctx, id).messages.some(m => m.action === 'steered'), !steerError);
    if (!steerError) {
      const saved = readJob(ctx, id); const receipt = saved.messages.find(m => m.action === 'steered');
      assert.equal(receipt.promptId, ctx.grok().interjections[0].promptId);
      assert.equal(saved.backendState.promptIds[receipt.id], receipt.promptId);
    }
  }
});

test('cancel interrupts and server death records exit reason', async t => {
  const ctx = fixture(t, { turnMs: 30000 });
  const { id } = startJob(ctx, HEADER, 'Wait.');
  await waitFor(() => readJob(ctx, id).turnId);
  companion(ctx, ['cancel', id]);
  await finishJob(ctx, id, 5);
  assert.equal(readJob(ctx, id).state, 'cancelled');
  assert.ok(ctx.grok().requests.some(r => r.method === 'session/cancel' && r.id === undefined));
  const dead = fixture(t, { die: true });
  const launched = startJob(dead, HEADER, 'Exit.');
  await finishJob(dead, launched.id, 3);
  assert.match(readJob(dead, launched.id).errorMessage, /grok agent.*exit 17/);
  assert.match(readJob(dead, launched.id).errorMessage, /fake server death/);
});

test('modes, compatibility isolation and unexpected permissions', async t => {
  for (const [mode, sandbox] of [['yolo', undefined], ['write', 'workspace'], ['read-only', 'read-only']]) {
    const ctx = fixture(t, { permission: true });
    const { id, start } = startJob(ctx, HEADER + `\nmode: ${mode}\nnetwork: false`, '[quick] Mode.');
    await finishJob(ctx, id);
    const state = ctx.grok(); const spawn = state.starts[0];
    assert.deepEqual(spawn.args, ['agent', '--no-leader', '--always-approve', 'stdio']);
    assert.equal(spawn.env.GROK_SANDBOX, sandbox);
    assert.equal(spawn.env.GROK_MEMORY, '0');
    for (const source of ['CLAUDE', 'CURSOR']) for (const kind of ['HOOKS', 'SKILLS', 'MCPS', 'RULES', 'AGENTS', 'SESSIONS']) assert.equal(spawn.env[`GROK_${source}_${kind}_ENABLED`], '0');
    assert.deepEqual(state.requests.find(r => r.id === 'permission').result.outcome, { outcome: 'selected', optionId: mode === 'yolo' ? 'allow' : 'deny' });
    if (mode !== 'yolo') assert.match(start, /macOS does not enforce/);
  }
});

test('unexpected permissions take fallback options, and no matching option answers cancelled', async t => {
  const offered = [
    [{ kind: 'allow_always', optionId: 'always' }, { kind: 'reject_always', optionId: 'never' }],
    [{ kind: 'allow_once', optionId: 'allow' }],
    [{ kind: 'reject_once', optionId: 'deny' }]
  ];
  const expected = {
    yolo: [{ outcome: 'selected', optionId: 'always' }, { outcome: 'selected', optionId: 'allow' }, { outcome: 'cancelled' }],
    'read-only': [{ outcome: 'selected', optionId: 'never' }, { outcome: 'cancelled' }, { outcome: 'selected', optionId: 'deny' }]
  };
  for (const mode of ['yolo', 'read-only']) {
    const ctx = fixture(t, { permissionOptions: offered });
    const { id } = startJob(ctx, HEADER + `\nmode: ${mode}\nnetwork: false`, '[quick] Ask.');
    await finishJob(ctx, id);
    const answers = offered.map((_, index) => ctx.grok().requests.find(r => r.id === `permission-${index}` && !r.method).result.outcome);
    assert.deepEqual(answers, expected[mode], mode);
  }
});

test('sandbox and config errors fail start verbatim; prompt errors carry data; unknown stops fail', async t => {
  for (const [options, header, expected] of [
    [{ sandboxFail: true }, '\nmode: read-only', /Refusing to start with its protections missing/],
    [{ configError: true }, '', /Invalid Grok config/],
    [{ promptError: true }, '', /Prompt rejected.*\n.*capacity exhausted/],
    [{ stopReason: 'max_tokens' }, '', /the turn ended with stop reason max_tokens/]
  ]) {
    const ctx = fixture(t, options);
    const { id } = startJob(ctx, HEADER + header);
    await finishJob(ctx, id, 3);
    assert.match(readJob(ctx, id).errorMessage, expected);
  }
});

test('Grok queued work outlives the prompt response and owns the final report', async t => {
  const ctx = fixture(t, { followup: true });
  const { id } = startJob(ctx, HEADER);
  await finishJob(ctx, id);
  assert.equal(fs.readFileSync(path.join(jobDir(ctx, id), 'report.md'), 'utf8'), 'Report for: queued interjection\n');
});

test('setup checks version and models without opening a session', t => {
  const ctx = fixture(t);
  const result = companion(ctx, ['setup', '--backend', 'grok', '--grok-home', 'jobs', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const [block] = JSON.parse(result.stdout).backends;
  assert.equal(block.ready, true); assert.equal(block.version, 'grok 1.0.fake');
  assert.equal(block.home, path.join(ctx.user, '.grok-jobs'));
  assert.deepEqual(ctx.grok().invocations.map(call => call.args).sort(), [['--version'], ['models'], ['models']]);
  assert.deepEqual(ctx.grok().invocations.filter(call => call.args[0] === 'models').map(call => call.env.GROK_SANDBOX ?? null).sort(), ['read-only', null].sort());
  assert.equal(ctx.grok().invocations.find(call => call.args[0] === 'models').env.GROK_HOME, block.home);
  assert.equal(ctx.grok().requests.length, 0);
  assert.deepEqual(block.warnings.filter(warning => /read-only profile/.test(warning)), []);
});

test('setup warns when Grok refuses its read-only profile, and stays ready; another failure under it is no warning', t => {
  const refused = fixture(t, { refuseReadOnly: true });
  const result = companion(refused, ['setup', '--backend', 'grok', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const [block] = JSON.parse(result.stdout).backends;
  assert.equal(block.ready, true);
  const warnings = block.warnings.filter(warning => /read-only profile/.test(warning));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /refuses its read-only profile.*every Grok review fail.*sandbox profile resolve failed/);
  assert.doesNotMatch(warnings[0], /write/);
  const other = fixture(t, { networkFailsUnderReadOnly: true });
  assert.deepEqual(JSON.parse(companion(other, ['setup', '--backend', 'grok', '--json']).stdout).backends[0].warnings.filter(warning => /read-only profile/.test(warning)), []);
});

test('a Grok job gets a larger MCP budget, unless the environment or the home names one', async t => {
  const budget = async (prepare) => {
    const ctx = fixture(t);
    prepare?.(ctx);
    const { id } = startJob(ctx, HEADER, '[quick] Budget.');
    await finishJob(ctx, id);
    return ctx.grok().starts[0].env;
  };
  assert.equal((await budget()).GROK_MAX_MCP_OUTPUT_BYTES, '262144');
  assert.equal((await budget(ctx => { ctx.env.GROK_MAX_MCP_OUTPUT_BYTES = '1000'; })).GROK_MAX_MCP_OUTPUT_BYTES, '1000');
  assert.equal((await budget(ctx => { ctx.env.MAX_MCP_OUTPUT_BYTES = '2000'; })).GROK_MAX_MCP_OUTPUT_BYTES, undefined);
  const configured = await budget(ctx => {
    fs.mkdirSync(path.join(ctx.user, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(ctx.user, '.grok', 'config.toml'), '[mcp]\nmax_output_bytes = 3000\n');
  });
  assert.equal(configured.GROK_MAX_MCP_OUTPUT_BYTES, undefined);
  const elsewhere = await budget(ctx => {
    fs.mkdirSync(path.join(ctx.user, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(ctx.user, '.grok', 'config.toml'), '[other]\nmax_output_bytes = 3000\n');
  });
  assert.equal(elsewhere.GROK_MAX_MCP_OUTPUT_BYTES, '262144');
  const withConfig = text => budget(ctx => {
    fs.mkdirSync(path.join(ctx.user, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(ctx.user, '.grok', 'config.toml'), text);
  });
  for (const text of [
    '[mcp] # budget\nmax_output_bytes = 3000\n',
    '[ mcp ]\n"max_output_bytes" = 3000\n',
    '[mcp]\n\'max_output_bytes\' = 3000\n',
    '["mcp"]\r\nmax_output_bytes=3000\r\n',
    'mcp.max_output_bytes = 3000\n',
    '"mcp"."max_output_bytes" = 3000\n',
    '"m\\u0063p".max_output_bytes = 3000\n',
    'mcp = { max_output_bytes = 3000 }\n',
    'mcp = { note = "x", "max_output_bytes" = 3000 }\n'
  ]) {
    assert.equal((await withConfig(text)).GROK_MAX_MCP_OUTPUT_BYTES, undefined, text);
  }
  for (const text of [
    '[mcp]\n# max_output_bytes = 3000\n',
    '[mcp.server]\nmax_output_bytes = 3000\n',
    '[mcp]\ntimeout = 1\n[other]\nmax_output_bytes = 3000\n',
    '[other]\ntext = """\n[mcp]\nmax_output_bytes = 3000\n"""\n',
    "[other]\ntext = '''\n[mcp]\nmax_output_bytes = 3000\n'''\n",
    'mcp = { note = "max_output_bytes = 3000" }\n',
    '"mcp.max_output_bytes" = 3000\n',
    '"m c p".max_output_bytes = 3000\n'
  ]) {
    assert.equal((await withConfig(text)).GROK_MAX_MCP_OUTPUT_BYTES, '262144', text);
  }
});

for (const home of ['default', 'jobs']) test(`Workflow retry adopts the same Grok job with ${home} home and returns its state block`, async () => {
  const { relayContext, companion: relayCompanion, readJobJson, relayStart, waitFor: relayWait } = await import('./support/relay-fixture.mjs');
  const first = relayContext('job', { workflow: 'wf-grok', journalKey: 'grok-call' });
  const fake = installFakeGrok(first.binDir, { turnMs: 1500 });
  first.env.GROK_BINARY = fake.binary;
  const append = ctx => {
    const prompt = ctx.workflowPrompt();
    prompt.message.content = prompt.message.content.replace('web-search: disabled', 'web-search: live').replace('\n  model:', `\n  backend: grok\n  grok-home: ${home}\n  model:`);
    ctx.append(ctx.userRequest(), prompt, ctx.environment(), ctx.snapshot('string'), ctx.systemReminder());
  };
  append(first);
  const started = await relayStart(first);
  assert.equal(started.started.status, 0, started.started.stderr);
  const id = started.jobId;
  await relayWait(() => readJobJson(first, id).turnId);
  const retry = relayContext('job', { from: first, workflow: 'wf-grok', label: 'relay-test (retry 1)', journalKey: 'grok-call' });
  append(retry);
  const adopted = await relayStart(retry);
  assert.match(adopted.started.stdout, new RegExp(`^job: ${id}$`, 'm'));
  assert.match(adopted.started.stdout, /relay-adopted:/);
  const ended = relayCompanion(retry, ['wait', id, '--timeout-seconds', '15', '--state-only']);
  assert.equal(ended.status, 0, ended.stdout);
  assert.match(ended.stdout, /^backend: grok$/m);
  for (const block of [started.started.stdout, adopted.started.stdout, ended.stdout]) {
    assert.equal(/^grok-home: /m.test(block), home !== 'default');
    if (home !== 'default') assert.match(block, /^grok-home: .*\/\.grok-jobs$/m);
  }
  assert.doesNotMatch(ended.stdout, /^---$/m);
  assert.equal(fake.state().turns.length, 1);
  // The session went to the context's scratch HOME, never to the real ~/.grok or ~/.grok-jobs.
  const sessions = path.join(first.user, home === 'default' ? '.grok' : '.grok-jobs', 'sessions');
  assert.deepEqual(fs.readdirSync(sessions), [encodeURIComponent(first.work)]);
});


test('chunks advance every heartbeat and flush at finished-message boundaries', () => {
  let touches = 0; const written = [];
  const recorder = grokEventRecorder(event => written.push(event), () => { touches += 1; });
  const event = (kind, text, extra = {}) => ({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: kind, ...(text ? { content: { type: 'text', text } } : {}), ...extra } } });
  for (const kind of ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'tool_call_delta_chunk']) {
    recorder.record(event(kind, 'one'));
    recorder.record(event(kind, 'two'));
    recorder.record(event(kind === 'tool_call_delta_chunk' ? 'tool_call_update' : 'response_completed', '', { status: 'completed' }));
  }
  assert.equal(touches, 12);
  assert.equal(written.length, 8);
  assert.deepEqual(written.filter(e => e.params.update.content).map(e => e.params.update.content.text), Array(4).fill('onetwo'));
  recorder.record(event('agent_message_chunk', 'partial'));
  recorder.flush();
  assert.equal(written.at(-1).params.update.content.text, 'partial');
});


test('a failed tool update flushes pending chunks before its own event; an unfinished one does not', () => {
  const written = [];
  const recorder = grokEventRecorder(event => written.push(event), () => {});
  const event = (kind, text, extra = {}) => ({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: kind, ...(text ? { content: { type: 'text', text } } : {}), ...extra } } });
  const shape = () => written.map(e => [e.params.update.sessionUpdate, e.params.update.content?.text ?? e.params.update.status]);
  recorder.record(event('agent_message_chunk', 'one'));
  recorder.record(event('agent_message_chunk', 'two'));
  recorder.record(event('tool_call_delta_chunk', 'a', { toolCallId: 't1' }));
  recorder.record(event('tool_call_update', '', { toolCallId: 't1', status: 'in_progress' }));
  assert.deepEqual(shape(), [['tool_call_update', 'in_progress']]);
  recorder.record(event('tool_call_update', '', { toolCallId: 't1', status: 'failed' }));
  assert.deepEqual(shape(), [['tool_call_update', 'in_progress'], ['agent_message_chunk', 'onetwo'], ['tool_call_delta_chunk', 'a'], ['tool_call_update', 'failed']]);
});

test('a prompt response does not retire the prompt still reported as running', async t => {
  const ctx = fixture(t, { earlyResponse: true, turnMs: 300 });
  const { id } = startJob(ctx, HEADER, 'Still running.');
  await finishJob(ctx, id);
  assert.equal(fs.readFileSync(path.join(jobDir(ctx, id), 'report.md'), 'utf8'), 'Report for: Still running.\n');
});
