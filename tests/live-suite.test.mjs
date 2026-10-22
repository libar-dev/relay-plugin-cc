import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, parseArgs, runChecks, usage, UsageError } from '../scripts/live/suite.mjs';
import { analyzeRun, cancelUnfinishedJobs, copyEvidence, createRun, evidenceRoot, findRunTranscript, findTranscript, makeRecords,
  pluginCommit, readJson, recordKeys, runDirectory, runId, smokeInstall, writeJson, writeRecords } from '../scripts/live/lib/runs.mjs';
import { claudeArgs, inspectDebug, paneStartArgs, runTerminal } from '../scripts/live/lib/terminal.mjs';
import { readRecords, renderTable, staleMessage } from '../scripts/live/lib/table.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const suite = pathToFileURL(path.join(root, 'scripts/live/suite.mjs')).href;

// These checks and readers also run in child processes, without importing the live checks.
function fakeSetup(fs, path) {
  const BACKENDS = ['codex', 'grok', 'zcode', 'kimi'];
  const BACKEND_NAMES = { codex: 'Codex', grok: 'Grok Build', zcode: 'ZCode', kimi: 'Kimi Code' };
  const textOf = entry => typeof entry.message?.content === 'string' ? entry.message.content :
    (entry.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const promptText = entry => {
    const text = textOf(entry).replace(/^(?:[\t ]*\r?\n)*/, '');
    const paste = text.match(/^<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*)\r?\n<\/pasted_content id="\1">(?:\r?\n)?$/);
    return (paste?.[2] ?? text).replace(/^(?:[\t ]*\r?\n)*/, '');
  };
  const hasLine = (entry, line) => textOf(entry).split('\n').some(text => text.trimEnd() === line);
  const readers = {
    BACKENDS, BACKEND_NAMES, promptText,
    scopeToRun(entries, id) {
      const isStart = entry => !entry.isSidechain && entry.type === 'user';
      const first = entries.findIndex(entry => isStart(entry) && promptText(entry).split('\n')[0] === `Live suite run ${id}.`);
      if (first < 0) return [];
      const next = entries.findIndex((entry, i) => i > first && isStart(entry) && /^Live suite run \S+\.$/.test(promptText(entry).split('\n')[0]));
      return entries.slice(first, next < 0 ? undefined : next);
    },
    readTranscript(file) {
      return fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line)]; }
        catch { throw new Error(`Invalid JSON at ${file}:${i + 1}`); }
      });
    },
    claudeCodeVersionOf: entries => entries.find(entry => !entry.isSidechain && entry.version)?.version ?? null,
    leadModelOf: entries => entries.find(entry => !entry.isSidechain && entry.type === 'assistant')?.message?.model ?? null,
    hasMarker: (entries, marker) => entries.some(entry => !entry.isSidechain && entry.type === 'assistant' && hasLine(entry, marker)),
    runSpan(entries, id, marker) {
      const start = entries.findIndex(entry => !entry.isSidechain && entry.type === 'user' && promptText(entry).split('\n')[0] === `Live suite run ${id}.`);
      const finish = start < 0 ? null : entries.slice(start + 1).find(entry => !entry.isSidechain && entry.type === 'assistant' && hasLine(entry, marker));
      return { startedAt: entries[start]?.timestamp ?? null,
        finishedAt: (finish ?? entries.findLast(entry => entry.timestamp))?.timestamp ?? null };
    }
  };
  const check = {
    id: 'fake', title: 'A fake check', surfaces: ['terminal', 't3'], probes: [], timeoutMinutes: 7, marker: 'FAKE-DONE',
    prompt: ({ runId, backends }) => `Live suite run ${runId}.\nCheck ${backends.join(',')}.\nPrint FAKE-DONE.\n`,
    analyze(input) {
      const evidence = { transcripts: [input.transcript], agents: [] };
      const results = input.backends.map(backend => {
        const pointer = path.join(input.jobsHome, 'relays', `${backend}.json`);
        let result = 'pass', reason = null;
        if (fs.existsSync(pointer)) {
          const saved = JSON.parse(fs.readFileSync(pointer, 'utf8'));
          const jobDir = path.resolve(input.jobsHome, saved.jobDir);
          evidence.agents.push({ agentId: backend, pointer, jobDir });
          if (saved.transcriptPath) {
            evidence.transcripts.push(saved.transcriptPath);
            if (!fs.existsSync(saved.transcriptPath)) { result = 'fail'; reason = 'Missing relay transcript.'; }
          }
          if (JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8')).state !== 'completed') {
            result = 'fail'; reason = 'The job did not complete.';
          }
        }
        return { backend, model: `model-${backend}`, relayVersion: input.relayVersion,
          delivery: 'in-turn', timings: { deliveredSeconds: [1.5] }, result, reason };
      });
      return { results, details: [{ transcript: input.transcript, jobsHome: input.jobsHome }], evidence };
    },
    cell: record => `delivered in ${record.timings.deliveredSeconds[0]} s`
  };
  return { readers, registry: [check, { ...check, id: 'probe', title: 'A probe check', surfaces: ['terminal'], probes: ['wake-probe'] },
    { ...check, id: 't3-only', title: 'A T3 check', surfaces: ['t3'] }] };
}
const { readers, registry } = fakeSetup(fs, path);
const check = registry[0];
const id = '20261022T103015Z-fake-t3-1a2b';
const start = '2026-10-22T10:30:15.000Z';
const finish = '2026-10-22T10:30:18.500Z';
function entries(run = id, marker = 'FAKE-DONE') {
  return [
    { type: 'user', entrypoint: run.includes('-terminal-') ? 'cli' : 'sdk-ts', timestamp: start, version: '2.1.308', message: { content: `Live suite run ${run}.` } },
    { type: 'assistant', timestamp: finish, message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: marker }] } }
  ];
}
function writeTranscript(file, rows = entries()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function scratch(t) {
  const dir = fs.mkdtempSync('/tmp/relay-live-suite-test-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(workDir);
  assert.equal(spawnSync('git', ['init', '--quiet', workDir]).status, 0);
  fs.mkdirSync(path.join(dir, 'jobs'));
  const env = { ...process.env, RELAY_LIVE_HOME: path.join(dir, 'live'), XDG_STATE_HOME: path.join(dir, 'state'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'config'), RELAY_JOBS_HOME: path.join(dir, 'jobs') };
  return { dir, workDir, env, recordsDir: path.join(dir, 'records') };
}
function receipt(ctx, fields = {}) {
  const marketplace = path.join(ctx.dir, 'marketplace');
  writeJson(path.join(marketplace, 'relay/.claude-plugin/plugin.json'), { name: 'relay', version: '3.0.0-test' });
  const real = fs.realpathSync(ctx.workDir);
  const hash = createHash('sha256').update(real).digest('hex');
  writeJson(path.join(ctx.env.XDG_STATE_HOME, 'relay-plugin-cc/smoke-installs', `${hash}.json`), { dir: real, marketplace, ...fields });
  return path.join(marketplace, 'relay');
}
function cli(ctx, args, driver = '') {
  const source = `import fs from 'node:fs'; import path from 'node:path';
    import { main } from ${JSON.stringify(suite)};
    const { registry, readers } = (${fakeSetup.toString()})(fs, path);
    ${driver}
    process.exitCode = await main(process.argv.slice(1), registry, readers, ${driver ? '{ driver }' : '{}'});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source, '--', ...args], { env: ctx.env, encoding: 'utf8' });
}
function baseRun(overrides = {}) {
  return { runId: id, check: 'fake', surface: 't3', backends: [...readers.BACKENDS], relayVersion: '3.0.0-test',
    preparedAt: start, marker: check.marker, ...overrides };
}
function analyzed(run = baseRun()) {
  return { results: run.backends.map(backend => ({ backend, model: `model-${backend}`, relayVersion: run.relayVersion,
    delivery: 'in-turn', timings: { deliveredSeconds: [1.5] }, result: 'pass', reason: null })),
  details: [{ path: '/tmp/evidence-only' }], evidence: { transcripts: [], agents: [] } };
}
const record = overrides => ({ ...makeRecords(baseRun(), check, analyzed(), entries(), readers)[0], ...overrides });

const invalidArgs = [[], ['unknown'], ['list', 'extra'], ['list', '--keep'], ['run'], ['run', 'missing'],
  ['run', 'all', 'fake'], ['run', 'fake', 'fake'], ['run', 't3-only'], ['run', 'all', '--work-dir', '/tmp/work'],
  ['run', 'fake', 'probe', '--jobs-home', '/tmp/jobs'], ['run', 'fake', '--backends', 'other'],
  ['run', 'fake', '--backends', 'codex,codex'], ['run', 'fake', '--backends', 'codex,'],
  ['run', 'fake', '--timeout-minutes', '0'], ['run', 'fake', '--timeout-minutes', '-1'],
  ['run', 'fake', '--timeout-minutes', 'NaN'], ['run', 'fake', '--timeout-minutes', 'Infinity'],
  ['run', 'fake', '--plugin-dir'], ['run', 'fake', '--plugin-dir', '--keep'], ['run', 'fake', '--unknown'],
  ['run', 'fake', '--keep', '--keep'], ['prepare'], ['prepare', 'missing', '--surface', 't3', '--work-dir', '/tmp'],
  ['prepare', 'fake'], ['prepare', 'fake', '--surface', 'terminal', '--work-dir', '/tmp'],
  ['prepare', 'fake', 'probe', '--surface', 't3', '--work-dir', '/tmp'], ['analyze'], ['analyze', '../other'],
  ['analyze', id, id], ['analyze', id, '--from-copy', '--transcript', '/tmp/a'],
  ['analyze', id, '--from-copy', '--jobs-home', '/tmp/a'], ['table', 'extra'], ['table', '--out'], ['table', '--keep']];

test('argument parsing covers each subcommand, defaults, ordering and overrides', () => {
  const parse = args => parseArgs(args, registry, readers.BACKENDS);
  assert.deepEqual(parse(['list']), { command: 'list' });
  assert.deepEqual(parse(['--help']), { help: true });
  assert.deepEqual(parse(['run', 'all']).checks, ['fake', 'probe']);
  assert.deepEqual(parse(['run', 'fake']).backends, readers.BACKENDS);
  assert.equal(parse(['run', 'fake']).model, 'sonnet');
  const run = parse(['run', 'probe', 'fake', '--backends', 'kimi,codex', '--model', 'opus', '--timeout-minutes', '0.5',
    '--plugin-dir', './plugins/relay', '--records-dir', '/tmp/records', '--keep']);
  assert.deepEqual(run.checks, ['probe', 'fake']);
  assert.deepEqual(run.backends, ['codex', 'kimi']);
  assert.equal(run.timeoutMinutes, 0.5);
  assert.equal(run.model, 'opus');
  assert.equal(run.keep, true);
  assert.equal(run.pluginDir, path.resolve('plugins/relay'));
  assert.equal(run.recordsDir, '/tmp/records');
  const single = parse(['run', 'fake', '--work-dir', '/tmp/work', '--jobs-home', '/tmp/jobs']);
  assert.equal(single.workDir, '/tmp/work');
  assert.equal(single.jobsHome, '/tmp/jobs');
  assert.deepEqual(parse(['prepare', 'fake', '--surface', 't3', '--work-dir', '/tmp/work', '--backends', 'grok']).backends, ['grok']);
  assert.equal(parse(['prepare', 'fake', '--surface', 't3', '--work-dir', '/tmp/work']).checkId, 'fake');
  const analyze = parse(['analyze', id, '--transcript', '/tmp/session', '--jobs-home', '/tmp/jobs', '--records-dir', '/tmp/records']);
  assert.equal(analyze.runId, id);
  assert.equal(analyze.transcript, '/tmp/session');
  assert.equal(analyze.jobsHome, '/tmp/jobs');
  assert.equal(parse(['analyze', id, '--from-copy']).fromCopy, true);
  assert.deepEqual(parse(['table', '--records-dir', '/tmp/records', '--out', '/tmp/table', '--relay-version', 'v1', '--check']),
    { command: 'table', recordsDir: '/tmp/records', out: '/tmp/table', relayVersion: 'v1', check: true });
  for (const args of invalidArgs) assert.throws(() => parse(args), UsageError, args.join(' '));
});

test('CLI usage errors exit 2, and help and list have exact output', t => {
  const ctx = scratch(t);
  for (const args of invalidArgs) {
    const result = cli(ctx, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stderr.trim());
  }
  assert.equal(cli(ctx, ['--help']).stdout, usage);
  const listed = cli(ctx, ['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, 'fake\tterminal,t3\t-\tA fake check\nprobe\tterminal\twake-probe\tA probe check\nt3-only\tt3\t-\tA T3 check\n');
  assert.equal(fs.existsSync(ctx.env.RELAY_LIVE_HOME), false);
});

test('run ids, evidence roots and private run folders', t => {
  const ctx = scratch(t);
  assert.equal(runId('steer-main', 'terminal', new Date(start), '1a2b'), '20261022T103015Z-steer-main-terminal-1a2b');
  assert.match(runId('fake', 't3'), /^\d{8}T\d{6}Z-fake-t3-[a-f0-9]{4}$/);
  assert.equal(evidenceRoot(ctx.env), ctx.env.RELAY_LIVE_HOME);
  assert.equal(evidenceRoot({ XDG_STATE_HOME: ctx.dir }), path.join(ctx.dir, 'relay-plugin-cc/live'));
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, baseRun({ workDir: ctx.workDir }));
  assert.equal(fs.statSync(created.evidenceDir).mode & 0o777, 0o700);
  assert.equal(readJson(path.join(created.evidenceDir, 'run.json')).marker, 'FAKE-DONE');
  assert.equal(fs.readFileSync(path.join(created.evidenceDir, 'prompt.txt'), 'utf8'), check.prompt(created.run));
  assert.throws(() => runDirectory(ctx.dir, '../../elsewhere'), /Invalid run id/);
});

test('records have the exact keys, canonical backend order and no paths', () => {
  const run = baseRun({ backends: ['kimi', 'codex', 'zcode', 'grok'] });
  const result = analyzed(run);
  result.details.push({ path: '/private/path' });
  result.results[0].reason = 'Cannot read /tmp/private/job.json';
  result.results[0].result = 'fail';
  const records = makeRecords(run, check, result, entries(), readers);
  assert.deepEqual(records.map(row => row.backend), readers.BACKENDS);
  for (const row of records) {
    assert.deepEqual(Object.keys(row), recordKeys);
    assert.equal(row.claudeCodeVersion, '2.1.308');
    assert.equal(row.leadModel, 'claude-sonnet-5-5');
    assert.equal(row.platform, process.platform);
    assert.equal(row.startedAt, start);
    assert.equal(row.finishedAt, finish);
    assert.equal(row.durationSeconds, 3.5);
    assert.equal(row.evidence, `runs/${id}`);
    assert.doesNotMatch(JSON.stringify(row), /\/tmp\//);
    assert.equal(Object.hasOwn(row, 'details'), false);
  }
  assert.equal(records[3].reason, 'Cannot read [path]');
  assert.equal(makeRecords(run, check, result, [], readers)[0].durationSeconds, null);
});

test('a missing marker fails every backend and keeps each check reason', () => {
  const result = analyzed();
  result.results[0].result = 'fail';
  result.results[0].reason = 'The delivery was late.';
  const transcript = entries(id, 'not finished');
  transcript.push({ type: 'user', message: { content: 'FAKE-DONE' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'FAKE-DONE' }] } });
  const records = makeRecords(baseRun(), check, result, transcript, readers);
  assert.deepEqual(records.map(row => row.result), ['fail', 'fail', 'fail', 'fail']);
  assert.equal(records[0].reason, 'The lead did not print FAKE-DONE. The delivery was late.');
  assert.equal(records[1].reason, 'The lead did not print FAKE-DONE.');
});

test('missing results become fail records, using the run error when available', () => {
  const result = analyzed();
  result.results = result.results.slice(1);
  const records = makeRecords(baseRun({ error: 'Interrupted.' }), check, result, entries(), readers);
  assert.equal(records.length, 4);
  assert.equal(records[0].result, 'fail');
  assert.equal(records[0].reason, 'Interrupted.');
  assert.equal(records[0].model, null);
  assert.deepEqual(records[0].timings, {});
  assert.equal(makeRecords(baseRun(), check, result, entries(), readers)[0].reason, 'The check produced no result for codex.');
});

test('records go to both destinations and no prompt means no record', t => {
  const ctx = scratch(t);
  const dir = path.join(ctx.dir, 'evidence');
  fs.mkdirSync(dir);
  const rows = [record()];
  assert.equal(writeRecords(baseRun(), rows, dir, ctx.recordsDir), null);
  assert.equal(fs.existsSync(ctx.recordsDir), false);
  assert.equal(fs.existsSync(path.join(dir, 'records.jsonl')), false);
  const file = writeRecords(baseRun({ promptSentAt: start }), rows, dir, ctx.recordsDir);
  const expected = JSON.stringify(rows[0]) + '\n';
  assert.equal(file, path.join(ctx.recordsDir, `${id}.jsonl`));
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8'), expected);
});

const emptyTable = `# What the live suite has passed

<!-- Generated by \`node scripts/live/suite.mjs table\` from docs/live/records/. Do not edit it by hand. -->

Each cell is the latest record of a check on one backend and surface, shown only when it passed. A dash is a
check that has not passed there: not run yet, or failed in its latest run. [scripts/live/](../../scripts/live/)
holds the checks; the records below name the builds.

## Terminal

| Check | Codex | Grok Build | ZCode | Kimi Code |
|---|---|---|---|---|
| A fake check | — | — | — | — |
| A probe check | — | — | — | — |

## T3 Code

| Check | Codex | Grok Build | ZCode | Kimi Code |
|---|---|---|---|---|
| A fake check | — | — | — | — |
| A T3 check | — | — | — | — |

## How each backend took a message

No check has passed yet.

## Records behind each cell

| Check | Surface | Backend | Model | Relay | Claude Code | Lead | Date | Record |
|---|---|---|---|---|---|---|---|---|
`;

test('empty table has exact surrounding text, all sections and dashed cells', () => {
  assert.equal(renderTable([], registry, readers), emptyTable);
  assert.equal(renderTable([record({ check: 'unregistered' }), record({ check: 'probe', surface: 't3' }),
    record({ surface: 'desktop' }), record({ backend: 'unknown' })], registry, readers), emptyTable);
});

test('latest table record wins by finish then run id; a latest failure hides a pass', () => {
  const older = record({ runId: 'older', finishedAt: '2026-10-21T12:00:00Z', timings: { deliveredSeconds: [99] } });
  const first = record({ runId: 'aaa', timings: { deliveredSeconds: [2] } });
  const latest = record({ runId: 'zzz', timings: { deliveredSeconds: [3] } });
  const rows = [latest, older, first];
  const table = renderTable(rows, registry, readers);
  assert.equal(table, renderTable(rows.toReversed(), registry, readers));
  assert.match(table, /\| A fake check \| delivered in 3 s \| — \| — \| — \|/);
  assert.match(table, /\| fake \| t3 \| codex \| model-codex \| 3\.0\.0-test \| 2\.1\.308 \| claude-sonnet-5-5 \| 2026-10-22 \| \[zzz\]\(records\/zzz.jsonl\) \|/);
  assert.doesNotMatch(table, /99 s|2 s|records\/aaa/);
  assert.equal(renderTable([...rows, record({ runId: 'zzzz', result: 'fail', reason: 'Failed.' })], registry, readers), emptyTable);
  assert.match(renderTable([...rows, record({ runId: 'zzzz', relayVersion: 'v2', result: 'fail' })], registry, readers, '3.0.0-test'), /delivered in 3 s/);
  assert.equal(renderTable(rows, registry, readers, 'missing'), emptyTable);
});

test('table CLI writes, checks without writing, filters versions, and reports file:line', t => {
  const ctx = scratch(t);
  const out = path.join(ctx.dir, 'capabilities.md');
  const args = ['table', '--records-dir', ctx.recordsDir, '--out', out];
  const stale = cli(ctx, [...args, '--check']);
  assert.equal(stale.status, 1);
  assert.equal(stale.stderr, staleMessage + '\n');
  assert.equal(fs.existsSync(out), false);
  assert.equal(cli(ctx, args).status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), emptyTable);
  assert.equal(cli(ctx, [...args, '--check']).status, 0);
  fs.writeFileSync(out, 'stale');
  assert.equal(cli(ctx, [...args, '--check']).status, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), 'stale');
  fs.mkdirSync(ctx.recordsDir);
  const file = path.join(ctx.recordsDir, 'one.jsonl');
  fs.writeFileSync(file, JSON.stringify(record()) + '\n');
  assert.equal(cli(ctx, [...args, '--relay-version', 'missing']).status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), emptyTable);
  assert.equal(cli(ctx, args).status, 0);
  assert.match(fs.readFileSync(out, 'utf8'), /delivered in 1.5 s/);
  for (const line of ['{bad}', '{}', 'null']) {
    fs.writeFileSync(file, '\n' + line + '\n');
    assert.throws(() => readRecords(ctx.recordsDir), error => error.message.includes(`${file}:2`));
    const result = cli(ctx, args);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${file}:2`));
  }
});

test('prepare requires a receipt, refuses terminal-only checks, and uses a realpath hash', t => {
  const ctx = scratch(t);
  const args = ['prepare', 'fake', '--surface', 't3', '--work-dir', ctx.workDir, '--backends', 'kimi,codex'];
  const refused = cli(ctx, args);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `No smoke install for ${ctx.workDir}. Run scripts/smoke/install-local.sh ${ctx.workDir} first.\n`);
  assert.equal(fs.existsSync(ctx.env.RELAY_LIVE_HOME), false);
  const pluginDir = receipt(ctx);
  const probe = cli(ctx, ['prepare', 'probe', '--surface', 't3', '--work-dir', ctx.workDir]);
  assert.equal(probe.status, 1);
  assert.equal(probe.stderr, 'probe does not support t3.\n');
  const alias = path.join(ctx.dir, 'alias');
  fs.symlinkSync(ctx.workDir, alias);
  const result = cli(ctx, ['prepare', 'fake', '--surface', 't3', '--work-dir', alias, '--backends', 'kimi,codex']);
  assert.equal(result.status, 0, result.stderr);
  const [runId, promptFile, separator] = result.stdout.split('\n');
  assert.match(runId, /^\d{8}T\d{6}Z-fake-t3-[a-f0-9]{4}$/);
  assert.equal(promptFile, path.join(ctx.env.RELAY_LIVE_HOME, 'runs', runId, 'prompt.txt'));
  assert.equal(separator, '---');
  const run = readJson(path.join(path.dirname(promptFile), 'run.json'));
  assert.equal(run.workDir, ctx.workDir);
  assert.equal(run.pluginDir, pluginDir);
  assert.equal(run.relayVersion, '3.0.0-test');
  assert.deepEqual(run.backends, ['codex', 'kimi']);
  assert.equal(run.surface, 't3');
  assert.equal(run.marker, 'FAKE-DONE');
  assert.ok(Number.isFinite(Date.parse(run.preparedAt)));
  assert.equal(result.stdout, `${runId}\n${promptFile}\n---\n${check.prompt(run)}`);
});

test('transcript discovery requires an exact first line and refuses ambiguous sessions across folders', t => {
  const ctx = scratch(t);
  const projects = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'projects');
  const slug = ctx.workDir.replace(/[^a-zA-Z0-9]/g, '-');
  const preferred = path.join(projects, slug, 'old.jsonl');
  const other = path.join(projects, 'other', 'new.jsonl');
  const find = () => findRunTranscript(ctx.workDir, id, ctx.env.CLAUDE_CONFIG_DIR, readers.readTranscript, readers.promptText);
  writeTranscript(preferred);
  assert.equal(find(), preferred);
  for (const content of [`Quoted prompt:\nLive suite run ${id}.`, `Live suite run ${id}. `, `Live suite run ${id}.\r\nrest`]) {
    writeTranscript(other, [{ type: 'user', message: { content } }]);
    assert.equal(find(), preferred);
  }
  writeTranscript(other, [{ ...entries()[0], isSidechain: true }]);
  assert.equal(find(), preferred);
  writeTranscript(other, [{ ...entries()[0], type: 'assistant' }]);
  assert.equal(find(), preferred);
  writeTranscript(other, [{ ...entries()[0], message: { content: [{ type: 'text', text: `Live suite run ${id}.` }, { type: 'text', text: 'rest' }] } }]);
  assert.throws(find, error => error.message.includes('--transcript') && error.message.includes(preferred) && error.message.includes(other));
  fs.rmSync(preferred);
  assert.equal(find(), other);
  fs.rmSync(other);
  assert.equal(find(), null);
});

test('session discovery ports the old debug-id cases and handles hashed project folders', t => {
  const ctx = scratch(t);
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const project = path.join(ctx.dir, 'projects', '-tmp-steer-test');
  const target = path.join(project, `${sessionId}.jsonl`);
  writeTranscript(target, [{}]);
  const debug = `/tmp/debug/${sessionId}.txt`;
  assert.equal(findTranscript('/tmp/steer-test', debug, ctx.dir, readers.readTranscript), target);
  assert.equal(findTranscript('/tmp/no-match', debug, ctx.dir, readers.readTranscript), null);
  writeTranscript(target, [{ cwd: '/tmp/no-match' }]);
  assert.equal(findTranscript('/tmp/no-match', debug, ctx.dir, readers.readTranscript), target);
  assert.throws(() => findTranscript(ctx.workDir, '/tmp/debug/bad.txt', ctx.dir, readers.readTranscript), /No session id/);
});

function evidenceFixture(ctx, runId = id) {
  const transcript = path.join(ctx.dir, 'source/session.jsonl');
  writeTranscript(transcript, entries(runId));
  const workflow = path.join(ctx.dir, 'source/session/subagents/workflows/one/agent-workflow.jsonl');
  writeTranscript(workflow, [{ type: 'assistant', isSidechain: true }]);
  const jobsHome = path.join(ctx.dir, 'source-jobs');
  const jobDir = path.join(jobsHome, 'repo/job');
  const relayTranscript = path.join(jobDir, 'attempt/transcript.jsonl');
  writeTranscript(relayTranscript, [{}]);
  writeJson(path.join(jobDir, 'job.json'), { state: 'completed' });
  for (const lock of ['job.lock.d', 'worker.lease.d', 'nested/other.lock.d']) writeJson(path.join(jobDir, lock, 'owner.json'), {});
  const pointer = path.join(jobsHome, 'relays/codex.json');
  writeJson(pointer, { jobDir, transcriptPath: relayTranscript });
  return { transcript, workflow, jobsHome, jobDir, pointer, relayTranscript };
}

test('evidence copy preserves workflow paths, rewrites pointers and skips lock folders', t => {
  const ctx = scratch(t);
  const input = evidenceFixture(ctx);
  const dir = path.join(ctx.dir, 'evidence');
  const result = { ...analyzed(), evidence: { transcripts: [input.transcript, input.workflow, input.relayTranscript],
    agents: [{ agentId: 'codex', pointer: input.pointer, jobDir: input.jobDir }] } };
  const copied = copyEvidence(baseRun(input), result, dir);
  assert.equal(copied.transcript, path.join(dir, 'copy/session/session.jsonl'));
  assert.equal(fs.existsSync(path.join(dir, 'copy/session/session/subagents/workflows/one/agent-workflow.jsonl')), true);
  const pointer = readJson(path.join(copied.jobsHome, 'relays/codex.json'));
  assert.equal(pointer.jobDir, path.join(copied.jobsHome, 'repo/job'));
  assert.equal(pointer.transcriptPath, path.join(pointer.jobDir, 'attempt/transcript.jsonl'));
  assert.equal(fs.existsSync(pointer.transcriptPath), true);
  assert.deepEqual(readJson(path.join(pointer.jobDir, 'job.json')), { state: 'completed' });
  for (const lock of ['job.lock.d', 'worker.lease.d', 'nested/other.lock.d']) assert.equal(fs.existsSync(path.join(pointer.jobDir, lock)), false);
});

test('analyze CLI discovers prepared runs, uses overrides, and replays exactly from the copy', t => {
  const ctx = scratch(t);
  receipt(ctx);
  const prepared = cli(ctx, ['prepare', 'fake', '--surface', 't3', '--work-dir', ctx.workDir, '--backends', 'codex']);
  assert.equal(prepared.status, 0, prepared.stderr);
  const runId = prepared.stdout.split('\n')[0];
  const input = evidenceFixture(ctx, runId);
  const slug = ctx.workDir.replace(/[^a-zA-Z0-9]/g, '-');
  const discovered = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'projects', slug, 'main.jsonl');
  writeTranscript(discovered, entries(runId));
  const runDir = runDirectory(ctx.env.RELAY_LIVE_HOME, runId);
  const args = ['analyze', runId, '--records-dir', ctx.recordsDir];
  const first = cli(ctx, [...args, '--jobs-home', input.jobsHome]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readJson(path.join(runDir, 'run.json')).transcript, discovered);
  writeTranscript(discovered, entries(runId, 'not done'));
  const explicit = cli(ctx, [...args, '--transcript', input.transcript, '--jobs-home', input.jobsHome]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /fake codex: pass delivered in 1.5 s/);
  const metadata = readJson(path.join(runDir, 'run.json'));
  assert.equal(metadata.transcript, input.transcript);
  assert.equal(metadata.jobsHome, input.jobsHome);
  const file = path.join(ctx.recordsDir, `${runId}.jsonl`);
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(fs.readFileSync(path.join(runDir, 'records.jsonl'), 'utf8'), original);
  assert.equal(JSON.parse(original).result, 'pass');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'details.jsonl'), 'utf8')),
    { transcript: input.transcript, jobsHome: input.jobsHome });
  fs.rmSync(input.jobsHome, { recursive: true });
  fs.rmSync(path.dirname(input.transcript), { recursive: true });
  fs.rmSync(ctx.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const replay = cli(ctx, [...args, '--from-copy']);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(runDir, 'records.jsonl'), 'utf8'), original);
});

test('analyze uses environment jobs home, refuses absent run prompts and names malformed transcript lines', t => {
  const ctx = scratch(t);
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { surface: 't3', backends: ['codex'], workDir: ctx.workDir, relayVersion: 'test' });
  const transcript = path.join(ctx.dir, 'main.jsonl');
  writeTranscript(transcript, entries(created.run.runId));
  const calls = [];
  const custom = { ...check, analyze(input) { calls.push(input); return analyzed(created.run); } };
  const result = analyzeRun(created.run, created.evidenceDir, [custom], readers, { transcript, recordsDir: ctx.recordsDir, env: ctx.env });
  assert.equal(calls[0].jobsHome, ctx.env.RELAY_JOBS_HOME);
  assert.equal(result.records[0].result, 'pass');
  assert.equal(result.records[0].relayVersion, 'test');
  const untouched = { ...created.run }; delete untouched.promptSentAt;
  writeTranscript(transcript, entries('different-run'));
  assert.throws(() => analyzeRun(untouched, created.evidenceDir, [custom], readers, { transcript, recordsDir: ctx.recordsDir, env: ctx.env }), /no prompt/);
  fs.writeFileSync(transcript, '{}\n{bad}\n');
  const bad = cli(ctx, ['analyze', created.run.runId, '--transcript', transcript, '--records-dir', ctx.recordsDir]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `Invalid JSON at ${transcript}:2\n`);
});

test('debug inspection recognizes relay and probe modules and rejects load errors', () => {
  const log = '[DEBUG] Read hooks.json for plugin relay (enabled=true): /tmp/plugin/hooks/hooks.json\n' +
    '[DEBUG] Hooks: SessionStart:startup [node "/tmp/plugin/scripts/hooks/session-lifecycle.mjs"] (plugin relay@inline)\n' +
    '[DEBUG] hooks module relay@inline loaded (environment 5); events: session.send\n';
  assert.equal(inspectDebug(log, '/tmp/plugin').moduleLoaded, true);
  assert.equal(inspectDebug(log, '/tmp/plugin').pluginRead, true);
  assert.equal(inspectDebug(log, '/tmp/plugin').startup, true);
  assert.equal(inspectDebug(log, '/tmp/other').pluginRead, false);
  const failed = inspectDebug(log + '[ERROR] /tmp/plugin/hooks/mod/register.js failed to load', '/tmp/plugin');
  assert.equal(failed.moduleLoaded, false);
  assert.equal(failed.moduleErrors.length, 1);
  const probe = '[DEBUG] Read hooks.json for plugin wake-probe (enabled=true): /tmp/probe/hooks/hooks.json\n' +
    '[DEBUG] hooks module wake-probe@inline loaded (environment 6)\n';
  assert.equal(inspectDebug(probe, '/tmp/probe', 'wake-probe').pluginRead, true);
  assert.equal(inspectDebug(probe, '/tmp/probe', 'wake-probe').moduleLoaded, true);
  assert.equal(inspectDebug(probe, '/tmp/probe', 'wake-probe').startup, false);
  assert.equal(inspectDebug(probe + '[ERROR] /tmp/probe/hooks/register.js failed to load', '/tmp/probe', 'wake-probe').moduleLoaded, false);
  assert.equal(inspectDebug('hooks module wake-probe@inline not loaded', '/tmp/probe', 'wake-probe').moduleLoaded, false);
});

test('terminal argv includes every plugin, the session bypass setting and model, with no config env override', () => {
  const ctx = { pluginDir: '/tmp/relay', probeDirs: ['/tmp/probe one', '/tmp/probe-two'], sessionId: 'uuid', model: 'sonnet',
    workDir: '/tmp/work', jobsHome: '/tmp/jobs', CLAUDE_CONFIG_DIR: '/tmp/should-not-be-added' };
  const expected = ['claude', '--plugin-dir', '/tmp/relay', '--plugin-dir', '/tmp/probe one', '--plugin-dir', '/tmp/probe-two',
    '--dangerously-skip-permissions', '--settings', '{"skipDangerousModePermissionPrompt":true}', '--debug', '--session-id', 'uuid', '--model', 'sonnet'];
  assert.deepEqual(claudeArgs(ctx), expected);
  const args = paneStartArgs(ctx, 'pane-name', 'uuid');
  assert.deepEqual(args, ['start', 'pane-name', '/tmp/work', '--env', 'RELAY_JOBS_HOME=/tmp/jobs', '--', ...expected]);
  assert.equal(args.some(arg => arg.includes('CLAUDE_CONFIG_DIR')), false);
});

const fakeDriver = `const driver = async (ctx, check, { run }) => {
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  if (process.env.SETTINGS_ACTION === 'write') {
    fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, '{"changed":true}');
  }
  if (process.env.SETTINGS_ACTION === 'delete') fs.rmSync(settings);
  if (process.env.SETUP_FAILURE) throw new Error('Setup failed.');
  const transcript = path.join(ctx.evidenceDir, 'original.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', entrypoint: 'cli', timestamp: '2026-10-22T10:30:15.000Z', version: '2.1.308', message: { content: 'Live suite run ' + ctx.runId + '.' } },
    { type: 'assistant', timestamp: '2026-10-22T10:30:18.500Z', message: { model: 'sonnet', content: [{ type: 'text', text: process.env.NO_MARKER ? 'unfinished' : check.marker }] } }
  ].map(JSON.stringify).join('\\n') + '\\n');
  run.promptSentAt = '2026-10-22T10:30:15.000Z'; run.transcript = transcript;
};`;

for (const state of ['unchanged', 'absent', 'changed', 'created', 'deleted']) {
  test(`settings guard in a child process: ${state}`, t => {
    const ctx = scratch(t);
    const pluginDir = receipt(ctx);
    const settings = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'settings.json');
    const existed = !['absent', 'created'].includes(state);
    const before = '{ "original": true }\n';
    if (existed) { fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, before); }
    if (['changed', 'created'].includes(state)) ctx.env.SETTINGS_ACTION = 'write';
    if (state === 'deleted') ctx.env.SETTINGS_ACTION = 'delete';
    const result = cli(ctx, ['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir,
      '--jobs-home', ctx.env.RELAY_JOBS_HOME, '--records-dir', ctx.recordsDir, '--backends', 'codex'], fakeDriver);
    const changed = !['unchanged', 'absent'].includes(state);
    assert.equal(result.status, changed ? 1 : 0, result.stderr);
    const runDir = path.join(ctx.env.RELAY_LIVE_HOME, 'runs', fs.readdirSync(path.join(ctx.env.RELAY_LIVE_HOME, 'runs'))[0]);
    const run = readJson(path.join(runDir, 'run.json'));
    assert.equal(run.settingsChanged, changed);
    assert.equal(readRecords(ctx.recordsDir)[0].result, changed ? 'fail' : 'pass');
    if (changed) assert.match(readRecords(ctx.recordsDir)[0].reason, /^<tmp>\/.*settings\.json changed during the run\./);
    const copy = path.join(runDir, 'settings.before.json');
    assert.equal(fs.existsSync(copy), changed);
    if (changed) {
      assert.equal(run.settingsExistedBefore, existed);
      assert.equal(fs.readFileSync(copy, 'utf8'), existed ? before : 'null\n');
      assert.equal(result.stderr, `${settings} changed during the run; compare it with ${copy}\n`);
    } else assert.equal(result.stderr, '');
  });
}

test('a setup failure writes no record, and a sent prompt without a marker writes failures', t => {
  const ctx = scratch(t);
  const pluginDir = receipt(ctx);
  const args = ['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir, '--jobs-home', ctx.env.RELAY_JOBS_HOME,
    '--records-dir', ctx.recordsDir];
  ctx.env.SETUP_FAILURE = '1';
  const failed = cli(ctx, args, fakeDriver);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'Setup failed.\n');
  assert.equal(fs.existsSync(ctx.recordsDir), false);
  const runs = path.join(ctx.env.RELAY_LIVE_HOME, 'runs');
  const runDir = path.join(runs, fs.readdirSync(runs)[0]);
  assert.equal(fs.existsSync(path.join(runDir, 'records.jsonl')), false);
  assert.equal(readJson(path.join(runDir, 'run.json')).error, 'Setup failed.');
  delete ctx.env.SETUP_FAILURE;
  ctx.env.NO_MARKER = '1';
  const missing = cli(ctx, args, fakeDriver);
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(readRecords(ctx.recordsDir).map(row => row.result), ['fail', 'fail', 'fail', 'fail']);
  assert.ok(readRecords(ctx.recordsDir).every(row => row.reason === 'The lead did not print FAKE-DONE.'));
});

test('runTerminal override receives the contract context and skips the pane driver', async t => {
  const ctx = scratch(t);
  const pluginDir = receipt(ctx);
  let called = 0, driverCalls = 0, seen;
  const override = { ...check, async runTerminal(input) {
    called++; seen = input;
    const transcript = path.join(input.evidenceDir, 'override.jsonl');
    writeTranscript(transcript, entries(input.runId));
    return { ...analyzed(baseRun({ backends: input.backends })), evidence: { transcripts: [transcript], agents: [] } };
  } };
  const options = parseArgs(['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir,
    '--jobs-home', ctx.env.RELAY_JOBS_HOME, '--records-dir', ctx.recordsDir, '--backends', 'codex'], [override], readers.BACKENDS);
  const status = await runChecks(options, [override], readers, { env: ctx.env, log() {}, warn() {}, driver() { driverCalls++; throw new Error('Pane driver called'); } });
  assert.equal(status, 0);
  assert.equal(called, 1);
  assert.equal(driverCalls, 0);
  assert.deepEqual(Object.keys(seen), ['runId', 'backends', 'pluginDir', 'probeDirs', 'workDir', 'jobsHome', 'workDirCreated', 'jobsHomeCreated', 'evidenceDir', 'model', 'timeoutMinutes', 'run', 'save', 'readers', 'paneDriver']);
  assert.equal(seen.timeoutMinutes, 7);
  assert.equal(seen.model, 'sonnet');
  assert.deepEqual(seen.backends, ['codex']);
  assert.equal(readRecords(ctx.recordsDir)[0].result, 'pass');
});

for (const mode of ['complete', 'bypass', 'module-error', 'SIGINT', 'SIGTERM', 'SIGHUP', 'partial-start', 'stop-error', 'custom-completion', 'caller-trust', 'custom-scope', 'timeout', 'partial-line']) {
  test(`terminal driver with a fake pane: ${mode}`, async t => {
    const ctx = scratch(t);
    const created = createRun(ctx.env.RELAY_LIVE_HOME, registry[1], { surface: 'terminal', backends: ['codex'],
      workDir: ctx.workDir, jobsHome: ctx.env.RELAY_JOBS_HOME, relayVersion: 'test' });
    const input = { runId: created.run.runId, backends: ['codex'], pluginDir: '/tmp/plugin', probeDirs: ['/tmp/probe'],
      workDir: ctx.workDir, workDirCreated: mode !== 'caller-trust', jobsHome: ctx.env.RELAY_JOBS_HOME, evidenceDir: created.evidenceDir, model: 'sonnet', timeoutMinutes: 1 };
    const calls = [];
    let now = Date.now();
    if (mode === 'timeout') t.mock.method(Date, 'now', () => now);
    let polls = 0, fullReads = 0, transcript;
    const drive = (args, prompt) => {
      calls.push(args);
      if (args[0] === 'stop' && mode === 'stop-error') throw new Error('Stop failed.');
      if (args[0] === 'start') {
        if (mode === 'partial-start') throw Object.assign(new Error('Start failed after creating the pane.'), { stdout: 'RELAY_LIVE_UNSET CLAUDECODE\n' });
        const sessionId = args[args.indexOf('--session-id') + 1];
        transcript = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'projects', ctx.workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
        const debug = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'debug', `${sessionId}.txt`);
        fs.mkdirSync(path.dirname(debug), { recursive: true });
        fs.writeFileSync(debug, '[DEBUG] Read hooks.json for plugin relay (enabled=true): /tmp/plugin/hooks/hooks.json\n' +
          '[DEBUG] hooks module relay@inline loaded\n' +
          '[DEBUG] Read hooks.json for plugin wake-probe (enabled=true): /tmp/probe/hooks/hooks.json\n' +
          (mode === 'module-error' ? '[ERROR] hooks module wake-probe@inline failed to load\n' : '[DEBUG] hooks module wake-probe@inline loaded\n'));
      }
      if (args[0] === 'read' && args[2] === '0') {
        if (mode === 'bypass') return 'bypass permissions: Yes, I accept';
        return polls++ === 0 ? 'Yes, I trust this folder' : 'ready';
      }
      if (args[0] === 'send') {
        assert.equal(prompt, check.prompt({ runId: input.runId, backends: ['codex'] }));
        writeTranscript(transcript, mode === 'custom-scope' ? [{ type: 'system', observed: 'done' }] : entries(input.runId, mode === 'timeout' ? 'unfinished' : check.marker));
        // A line Claude Code has only begun to write: the poll must wait for it, not fail.
        if (mode === 'partial-line') fs.appendFileSync(transcript, '{"type":"assistant","message":{"content":[{"ty');
        if (mode.startsWith('SIG')) process.emit(mode);
      }
      if (args[0] === 'read' && mode === 'partial-line' && ++fullReads === 2) writeTranscript(transcript, entries(input.runId, check.marker));
      if (args[0] === 'read') return 'FAKE-DONE';
      return args[0] === 'start' ? 'RELAY_LIVE_UNSET CLAUDECODE\nRELAY_LIVE_UNSET RELAY_COMPANION_TEST\nRELAY_LIVE_UNSET CLAUDECODE\n' : 'pane command';
    };
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal));
    const selected = mode === 'custom-scope' ? { ...registry[1], scope: entries => entries, completed: entries => entries.some(entry => entry.observed === 'done') } : mode === 'custom-completion' ? { ...registry[1], marker: undefined, completed: entries => entries.some(entry => entry.type === 'assistant') } : registry[1];
    const action = runTerminal(input, selected, { run: created.run, save() {}, readers, env: ctx.env, drive,
      pause: async () => { if (mode === 'timeout' && created.run.promptSentAt) now += 60001; }, log() {}, warn() {}, keep: mode.startsWith('SIG') || mode === 'partial-start' });
    if (['complete', 'custom-completion', 'custom-scope', 'partial-line'].includes(mode)) await action;
    else await assert.rejects(action, mode === 'caller-trust' ? { message: `${ctx.workDir} is not trusted by Claude Code; open it in Claude Code once, or let the runner create the work folder.` } : mode === 'partial-start' ? /Start failed/ : mode === 'stop-error' ? /Could not stop/ : mode === 'bypass' ? /bypass-permissions dialog/ : mode === 'module-error' ? /wake-probe hooks module failed/ : mode === 'timeout' ? /Timed out waiting/ : /Interrupted/);
    assert.equal(calls.filter(args => args[0] === 'stop').length, 1);
    assert.equal(calls.filter(args => args[0] === 'send').length, ['bypass', 'module-error', 'partial-start', 'caller-trust'].includes(mode) ? 0 : 1);
    assert.equal(calls.some(args => args[0] === 'trust'), !['bypass', 'partial-start', 'caller-trust'].includes(mode));
    assert.equal(Boolean(created.run.promptSentAt), !['bypass', 'module-error', 'partial-start', 'caller-trust'].includes(mode));
    assert.deepEqual(created.run.removedEnvironment, mode === 'partial-start' ? ['CLAUDECODE'] : ['CLAUDECODE', 'RELAY_COMPANION_TEST']);
    if (created.run.promptSentAt) assert.equal(created.run.transcript, transcript);
    assert.equal(created.run.interrupted, mode.startsWith('SIG'));
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal)), before);
  });
}

// Greptile: a session cut off while writing its transcript left no record, so the table kept an
// older pass. The run now fails on record, after that pass.
test('a sent run that cannot be analyzed writes failing records that hide an older pass', async t => {
  const ctx = scratch(t);
  const pluginDir = receipt(ctx);
  const args = ['run', registry[1].id, '--plugin-dir', pluginDir, '--records-dir', ctx.recordsDir, '--backends', 'codex'];
  const driver = cut => async (input, selected, { run }) => {
    t.after(() => {
      fs.rmSync(input.workDir, { recursive: true, force: true });
      fs.rmSync(input.jobsHome, { recursive: true, force: true });
    });
    const file = path.join(input.evidenceDir, 'main.jsonl');
    writeTranscript(file, entries(input.runId));
    if (cut) fs.appendFileSync(file, '{"type":"assistant","message":{"content":[{"ty');
    run.promptSentAt = start;
    run.transcript = file;
  };
  assert.equal(await main(args, registry, readers, { env: ctx.env, log() {}, warn() {}, driver: driver(false) }), 0);
  const warnings = [];
  assert.equal(await main(args, registry, readers, { env: ctx.env, log() {}, warn: line => warnings.push(line), driver: driver(true) }), 1);
  assert.match(warnings.join('\n'), /Invalid JSON at/);
  const files = fs.readdirSync(ctx.recordsDir).sort();
  assert.equal(files.length, 2);
  const [failed] = readRecords(ctx.recordsDir).filter(record => record.result === 'fail');
  assert.deepEqual(Object.keys(failed), recordKeys);
  assert.match(failed.reason, /^The run could not be analyzed: Invalid JSON at /);
  assert.doesNotMatch(JSON.stringify(failed), /\/tmp\/|\/home\//);
  assert.ok(Date.parse(failed.finishedAt) > Date.parse(readRecords(ctx.recordsDir).find(record => record.result === 'pass').finishedAt));
  const table = renderTable(readRecords(ctx.recordsDir), registry, readers);
  const row = table.split('## T3 Code')[0].split('\n').find(line => line.startsWith(`| ${registry[1].title} |`));
  assert.equal(row.split(' | ')[1], '—');
});

test('run all executes checks serially in fresh work and jobs folders and canonical backend order', async t => {
  const ctx = scratch(t);
  const pluginDir = receipt(ctx);
  const options = parseArgs(['run', 'all', '--plugin-dir', pluginDir, '--records-dir', ctx.recordsDir,
    '--backends', 'kimi,codex', '--timeout-minutes', '3'], registry, readers.BACKENDS);
  const calls = [];
  let active = false;
  const status = await main(['run', 'all', '--plugin-dir', pluginDir, '--records-dir', ctx.recordsDir,
    '--backends', 'kimi,codex', '--timeout-minutes', '3'], registry, readers, { env: ctx.env, log() {}, warn() {},
    driver: async (input, selected, { run }) => {
      assert.equal(active, false); active = true;
      calls.push([selected.id, input]);
      t.after(() => {
        fs.rmSync(input.workDir, { recursive: true, force: true });
        fs.rmSync(input.jobsHome, { recursive: true, force: true });
      });
      await Promise.resolve();
      writeTranscript(path.join(input.evidenceDir, 'main.jsonl'), entries(input.runId));
      run.promptSentAt = start;
      run.transcript = path.join(input.evidenceDir, 'main.jsonl');
      active = false;
    } });
  assert.equal(status, 0);
  assert.deepEqual(calls.map(([id]) => id), options.checks);
  assert.notEqual(calls[0][1].workDir, calls[1][1].workDir);
  assert.notEqual(calls[0][1].jobsHome, calls[1][1].jobsHome);
  for (const [, input] of calls) {
    assert.match(input.workDir, /^\/tmp\/relay-live-work-/);
    assert.match(input.jobsHome, /^\/tmp\/relay-live-jobs-/);
    assert.deepEqual(input.backends, ['codex', 'kimi']);
    assert.equal(input.timeoutMinutes, 3);
    assert.equal(input.workDirCreated, true);
    assert.equal(input.jobsHomeCreated, true);
  }
  assert.equal(readRecords(ctx.recordsDir).length, 4);
  assert.deepEqual(calls[1][1].probeDirs, [path.join(root, 'scripts/live/probes/wake-probe')]);
});

test('a sent prompt with no transcript records failures that replay from empty copied evidence', t => {
  const ctx = scratch(t);
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { surface: 'terminal', backends: ['codex'],
    workDir: ctx.workDir, jobsHome: ctx.env.RELAY_JOBS_HOME, relayVersion: 'test', promptSentAt: start });
  const first = analyzeRun(created.run, created.evidenceDir, registry, readers, { recordsDir: ctx.recordsDir, env: ctx.env });
  assert.equal(first.records[0].result, 'fail');
  assert.equal(first.records[0].reason, 'The lead did not print FAKE-DONE. The session ran as null, not cli.');
  assert.equal(first.records[0].startedAt, null);
  assert.equal(first.records[0].finishedAt, null);
  assert.equal(first.records[0].durationSeconds, null);
  fs.rmSync(created.run.transcript);
  const replay = analyzeRun(created.run, created.evidenceDir, registry, readers, { recordsDir: ctx.recordsDir, env: ctx.env, fromCopy: true });
  assert.deepEqual(replay.records, first.records);
});

// The capability table in the repository is generated from the records beside it; a hand edit,
// or a record committed without regenerating the table, fails here.
test('the committed capability table matches the committed records', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/live/suite.mjs'), 'table', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('record metadata, completion and surface come only from this run', () => {
  const before = entries('prior-run');
  before[0].version = 'old-version'; before[0].entrypoint = 'cli';
  const current = entries(id, 'not done');
  const after = entries('later-run');
  after[0].timestamp = '2026-10-23T00:00:00Z'; after[1].timestamp = '2026-10-23T00:01:00Z';
  const rows = [...before, ...current, ...after];
  const result = makeRecords(baseRun(), check, analyzed(), rows, readers)[0];
  assert.equal(result.result, 'fail');
  assert.equal(result.reason, 'The lead did not print FAKE-DONE.');
  assert.equal(result.claudeCodeVersion, '2.1.308');
  assert.equal(result.leadModel, 'claude-sonnet-5-5');
  assert.equal(result.startedAt, start);
  assert.equal(result.finishedAt, finish);
  const missing = makeRecords(baseRun(), check, analyzed(), [...before, ...after], readers)[0];
  assert.equal(missing.claudeCodeVersion, null);
  assert.equal(missing.leadModel, null);
  assert.equal(missing.startedAt, null);
  assert.equal(missing.finishedAt, null);
});

for (const surface of ['terminal', 't3']) {
  for (const entrypoint of ['cli', 'sdk-ts', null]) {
    test(`${surface} records require their measured entrypoint (${entrypoint})`, () => {
      const rows = entries(); rows[0].entrypoint = entrypoint;
      rows.unshift({ isSidechain: true, entrypoint: surface === 'terminal' ? 'cli' : 'sdk-ts' });
      const records = makeRecords(baseRun({ surface }), check, analyzed(), rows, readers);
      const expected = surface === 'terminal' ? 'cli' : 'sdk-ts';
      for (const record of records) {
        assert.equal(record.result, entrypoint === expected ? 'pass' : 'fail');
        assert.equal(record.reason, entrypoint === expected ? null : `The session ran as ${entrypoint}, not ${expected}.`);
      }
    });
  }
}

test('custom completion sees scoped entries and works without an assistant marker', () => {
  const rows = [entries()[0], { type: 'system', observed: 'done', timestamp: finish }, ...entries('later-run')];
  let seen;
  const custom = { ...check, marker: undefined, completed(entries) { seen = entries; return entries.some(entry => entry.observed === 'done'); } };
  assert.equal(makeRecords(baseRun(), custom, analyzed(), rows, readers)[0].result, 'pass');
  assert.equal(seen.length, 2);
  const failed = analyzed(); failed.results[0].reason = 'Output was missing.'; failed.results[0].result = 'fail';
  custom.completed = () => false;
  assert.equal(makeRecords(baseRun(), custom, failed, rows, readers)[0].reason, 'The run did not complete. Output was missing.');
  assert.equal(makeRecords(baseRun(), { ...custom, completed: undefined }, analyzed(), rows, readers)[0].reason, 'The run did not complete.');
  assert.equal(makeRecords(baseRun(), { ...custom, marker: 'CUSTOM' }, analyzed(), rows, readers)[0].reason, 'The lead did not print CUSTOM.');
});

test('records redact known roots before generic paths, validate models, and keep only numeric timing arrays', () => {
  const home = os.homedir();
  const evidence = path.join(home, 'private live evidence');
  const workDir = path.join(os.tmpdir(), 'work with spaces');
  const jobsHome = path.join(workDir, 'jobs with spaces');
  const run = baseRun({ workDir, jobsHome, relayCommit: '0123456789ab-dirty' });
  const analysis = analyzed(run);
  Object.assign(analysis.results[0], { model: `custom:${home}/private/model`, result: 'fail',
    reason: [`\`${home}/My Folder/x\``, `ENOENT:/home/other/q`, '[/Users/other/z]', 'file:///home/other/a.mjs',
      `${evidence}/run`, `${root.slice(0, -1)}/code`, `${workDir}/work`, `${jobsHome}/job`, '/tmp/other', `${os.tmpdir()}/thing`].join(' '),
    timings: { deliveredSeconds: [2, 3], readSeconds: [1, 2], empty: [], bad: [1, Infinity], nan: [NaN],
      mixed: [1, '/home/person/path'], nested: { path: '/Users/person/path' }, scalar: 4, [`${home}/key`]: [5] } });
  const row = makeRecords(run, check, analysis, entries(), readers, evidence)[0];
  assert.equal(row.model, null);
  assert.equal(row.relayCommit, '0123456789ab-dirty');
  assert.deepEqual(Object.keys(row).slice(6, 9), ['relayVersion', 'relayCommit', 'claudeCodeVersion']);
  assert.deepEqual(row.timings, { deliveredSeconds: [2, 3], readSeconds: [1, 2], empty: [], '[path]': [5] });
  assert.doesNotMatch(JSON.stringify(row), /\/home\/|\/Users\/|\/tmp\//);
  for (const label of ['[path] Folder/x', '<evidence>/run', '<repo>/code', '<work>/work', '<jobs>/job', '<tmp>/other', '[path]']) assert.ok(row.reason.includes(label), label);
  for (const model of ['kimi-code/kimi-for-coding', 'model.v1:low', 'a-b_c']) {
    analysis.results[0].model = model;
    assert.equal(makeRecords(run, check, analysis, entries(), readers)[0].model, model);
  }
  for (const model of ['/absolute/path', 'vendor/home/alice/private/model', 'vendor/home/model', 'vendor/foo/bar', 'a-home-person-model', 'bad model', 'x\nmodel', 123]) {
    analysis.results[0].model = model;
    assert.equal(makeRecords(run, check, analysis, entries(), readers)[0].model, null);
  }
});

test('every committed live record is free of home and temporary absolute paths', () => {
  const files = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', 'docs/live/records/'], { encoding: 'utf8' });
  assert.equal(files.status, 0, files.stderr);
  for (const file of files.stdout.split('\0').filter(Boolean)) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    for (const prefix of [os.homedir(), '~/', '/home/', '/Users/', '/tmp/', '/var/', '/private/', '-home-']) assert.ok(!content.includes(prefix), `${file} contains ${prefix}`);
  }
});

test('terminal build commits distinguish plugin changes from unrelated changes and unknown builds', t => {
  const ctx = scratch(t);
  const plugin = path.join(ctx.workDir, 'plugins/relay');
  writeJson(path.join(plugin, '.claude-plugin/plugin.json'), { version: 'test' });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', ctx.workDir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('add', 'plugins');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD').slice(0, 12);
  assert.equal(pluginCommit(plugin), commit);
  fs.writeFileSync(path.join(ctx.workDir, 'unrelated'), 'change');
  assert.equal(pluginCommit(plugin), commit);
  fs.writeFileSync(path.join(plugin, 'new-file'), 'change');
  assert.equal(pluginCommit(plugin), `${commit}-dirty`);
  fs.rmSync(path.join(plugin, 'new-file'));
  writeJson(path.join(plugin, '.claude-plugin/plugin.json'), { version: 'changed' });
  assert.equal(pluginCommit(plugin), `${commit}-dirty`);
  assert.equal(pluginCommit(ctx.dir), null);
});

for (const worktree of [false, true]) {
  test(`prepare carries receipt build identity (${worktree ? 'worktree' : 'archive'}) and diagnoses vanished builds`, t => {
    const ctx = scratch(t), commit = '0123456789abcdef0123456789abcdef01234567';
    const plugin = receipt(ctx, { commit, worktree });
    assert.equal(smokeInstall(ctx.workDir, ctx.env).relayCommit, commit.slice(0, 12) + (worktree ? '-dirty' : ''));
    const args = ['prepare', 'fake', '--surface', 't3', '--work-dir', ctx.workDir];
    const prepared = cli(ctx, args);
    assert.equal(prepared.status, 0, prepared.stderr);
    const run = readJson(path.join(path.dirname(prepared.stdout.split('\n')[1]), 'run.json'));
    assert.equal(run.relayCommit, commit.slice(0, 12) + (worktree ? '-dirty' : ''));
    fs.rmSync(plugin, { recursive: true });
    const gone = cli(ctx, args);
    assert.equal(gone.status, 1);
    assert.equal(gone.stderr, `The smoke install's build folder ${plugin} is gone; reinstall with scripts/smoke/install-local.sh ${ctx.workDir}.\n`);
  });
}

test('table uses start and run-id timestamps when finish is absent', () => {
  const old = record();
  for (const failed of [record({ result: 'fail', finishedAt: null, startedAt: '2026-10-23T00:00:00Z' }),
    record({ result: 'fail', finishedAt: null, startedAt: null, runId: '20261023T000000Z-fake-t3-0000' }),
    record({ result: 'fail', finishedAt: 'invalid', startedAt: 'invalid', runId: '20261023T000000Z-fake-t3-0000' })]) {
    assert.equal(renderTable([old, failed], registry, readers), emptyTable);
    assert.equal(renderTable([failed, old], registry, readers), emptyTable);
  }
});

test('table explains only shown deliveries, deduplicates canonical backend names and names build commits', () => {
  const rows = [record({ backend: 'zcode' }), record({ surface: 'terminal' }), record({ backend: 'codex' }),
    record({ backend: 'kimi', delivery: 'next-turn' }), record({ backend: 'grok', delivery: 'new-turn', relayCommit: '0123456789ab' })];
  const table = renderTable(rows, registry, readers);
  assert.match(table, /\*\*Into the running turn\*\*: Codex, ZCode\. The backend added/);
  assert.ok(table.includes('- **As the next turn**: Kimi Code. The message reached the job as fast, waited for the running turn to end, and then ran as a turn of its own.\n'));
  assert.doesNotMatch(table, /did not see it|ACP has no steer/);
  assert.match(table, /\*\*A new turn of the job\*\*: Grok Build\./);
  assert.match(table, /3\.0\.0-test \(0123456789ab\)/);
  assert.doesNotMatch(table, /same session|turn\/steer|_x.ai|sendText/);
  const onlyNext = renderTable([record({ delivery: 'next-turn' })], registry, readers);
  assert.match(onlyNext, /\*\*As the next turn\*\*: Codex\./);
  assert.doesNotMatch(onlyNext, /Kimi's ACP|\*\*Into the running turn|\*\*A new turn/);
  const hidden = renderTable([...rows, record({ backend: 'kimi', result: 'fail', finishedAt: '2026-10-24T00:00:00Z' })], registry, readers);
  assert.doesNotMatch(hidden, /\*\*As the next turn|Kimi's ACP/);
});

function directoryBytes(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().filter(file => fs.statSync(path.join(dir, file)).isFile())
    .map(file => [file, fs.readFileSync(path.join(dir, file), 'base64')]);
}

for (const missing of ['jobsHome', 'transcript', 'jobDir']) {
  for (const legacy of [false, true]) {
    test(`reanalyze refuses missing ${missing} with ${legacy ? 'legacy' : 'new'} copies and changes no evidence`, t => {
      const ctx = scratch(t), input = evidenceFixture(ctx);
      const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(input), backends: ['codex'], promptSentAt: start });
      // createRun chooses a new id; the original transcript belongs to that run.
      writeTranscript(input.transcript, entries(created.run.runId));
      const options = { recordsDir: ctx.recordsDir, env: ctx.env };
      const original = analyzeRun(created.run, created.evidenceDir, registry, readers, options);
      if (legacy) {
        delete created.run.copy.originalJobDirs;
        fs.rmSync(created.run.copy.manifest);
        delete created.run.copy.manifest;
        writeJson(path.join(created.evidenceDir, 'run.json'), created.run);
      }
      const before = directoryBytes(created.evidenceDir), records = directoryBytes(ctx.recordsDir);
      fs.rmSync(input[missing], { recursive: true });
      assert.throws(() => analyzeRun(created.run, created.evidenceDir, registry, readers, options),
        { message: `The original evidence of ${created.run.runId} is gone; analyze it with --from-copy.` });
      assert.deepEqual(directoryBytes(created.evidenceDir), before);
      assert.deepEqual(directoryBytes(ctx.recordsDir), records);
      assert.deepEqual(analyzeRun(created.run, created.evidenceDir, registry, readers, { ...options, fromCopy: true }).records, original.records);
    });
  }
}

test('a failed copy leaves the previous copy and records byte-for-byte intact and removes staging files', t => {
  const ctx = scratch(t), input = evidenceFixture(ctx);
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(input), backends: ['codex'], promptSentAt: start });
  writeTranscript(input.transcript, entries(created.run.runId));
  const options = { recordsDir: ctx.recordsDir, env: ctx.env };
  analyzeRun(created.run, created.evidenceDir, registry, readers, options);
  const before = directoryBytes(created.evidenceDir), records = directoryBytes(ctx.recordsDir);
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('Simulated disk failure.'); });
  assert.throws(() => analyzeRun(created.run, created.evidenceDir, registry, readers, options), /Simulated disk failure/);
  assert.deepEqual(directoryBytes(created.evidenceDir), before);
  assert.deepEqual(directoryBytes(ctx.recordsDir), records);
  assert.equal(fs.readdirSync(created.evidenceDir).some(name => name.startsWith('.copy-')), false);
});

for (const command of ['run', 'prepare']) {
  test(`${command} refuses a caller-owned non-repository and accepts a repository subdirectory without git init`, t => {
    const ctx = scratch(t), pluginDir = receipt(ctx);
    const outside = path.join(ctx.dir, 'outside'), nested = path.join(ctx.workDir, 'nested');
    fs.mkdirSync(outside); fs.mkdirSync(nested);
    const args = dir => command === 'run' ? ['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', dir,
      '--jobs-home', ctx.env.RELAY_JOBS_HOME, '--records-dir', ctx.recordsDir] : ['prepare', 'fake', '--surface', 't3', '--work-dir', dir];
    const refused = cli(ctx, args(outside), fakeDriver);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /--work-dir must already be inside a git work tree/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(ctx.env.RELAY_LIVE_HOME), false);
    if (command === 'prepare') receipt({ ...ctx, workDir: nested });
    const accepted = cli(ctx, args(nested), fakeDriver);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(fs.existsSync(path.join(nested, '.git')), false);
  });
}

for (const fail of [false, true]) {
  test(`override can reuse the pane driver and retain lifecycle metadata when it ${fail ? 'throws' : 'returns'}`, async t => {
    const ctx = scratch(t), pluginDir = receipt(ctx);
    let driverCalls = 0, analyzeCalls = 0, seenRun, transcript;
    const custom = { ...check, async runTerminal(input) {
      await input.paneDriver();
      seenRun = input.run;
      assert.equal(input.readers, readers);
      input.save();
      if (fail) throw new Error('After-start failure.');
      return { ...analyzed(baseRun({ backends: input.backends })), evidence: { transcripts: [], agents: [] } };
    }, analyze(input) {
      analyzeCalls++;
      assert.equal(input.evidenceDir, path.dirname(transcript));
      assert.equal(input.transcript, transcript);
      return check.analyze(input);
    } };
    const options = parseArgs(['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir,
      '--jobs-home', ctx.env.RELAY_JOBS_HOME, '--records-dir', ctx.recordsDir, '--backends', 'codex'], [custom], readers.BACKENDS);
    const status = await runChecks(options, [custom], readers, { env: ctx.env, log() {}, warn() {}, driver(input, selected, { run }) {
      driverCalls++;
      assert.equal(selected, custom);
      transcript = path.join(input.evidenceDir, 'main.jsonl');
      writeTranscript(transcript, entries(input.runId, fail ? 'unfinished' : check.marker));
      Object.assign(run, { promptSentAt: start, transcript, sessionId: 'kept-session', debugLog: 'kept-debug', startupEvidence: { kept: true } });
    } });
    assert.equal(status, fail ? 1 : 0);
    assert.equal(driverCalls, 1); assert.equal(analyzeCalls, fail ? 1 : 0);
    assert.equal(seenRun.promptSentAt, start); assert.equal(seenRun.transcript, transcript);
    assert.equal(seenRun.sessionId, 'kept-session'); assert.equal(seenRun.debugLog, 'kept-debug');
    assert.deepEqual(seenRun.startupEvidence, { kept: true });
    const records = readRecords(ctx.recordsDir);
    assert.equal(records.length, 1); assert.equal(records[0].result, fail ? 'fail' : 'pass');
    if (fail) assert.equal(readJson(path.join(path.dirname(transcript), 'run.json')).error, 'After-start failure.');
  });
}

test('a stop failure propagates to run.error and CLI status even when analysis passes', async t => {
  const ctx = scratch(t), pluginDir = receipt(ctx);
  const status = await main(['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir,
    '--jobs-home', ctx.env.RELAY_JOBS_HOME, '--records-dir', ctx.recordsDir, '--backends', 'codex'], registry, readers,
  { env: ctx.env, log() {}, warn() {}, driver(input, selected, { run }) {
    run.transcript = path.join(input.evidenceDir, 'main.jsonl');
    run.promptSentAt = start;
    writeTranscript(run.transcript, entries(input.runId));
    throw new Error('Could not stop pane: Stop failed.');
  } });
  assert.equal(status, 1);
  const record = readRecords(ctx.recordsDir)[0];
  const run = readJson(path.join(runDirectory(ctx.env.RELAY_LIVE_HOME, record.runId), 'run.json'));
  assert.equal(run.error, 'Could not stop pane: Stop failed.');
});

test('copied job and adoption bindings follow their copied relay transcript', t => {
  const ctx = scratch(t), input = evidenceFixture(ctx);
  writeJson(path.join(input.jobDir, 'job.json'), { state: 'completed', relay: { transcriptPath: input.relayTranscript } });
  writeJson(path.join(input.jobDir, 'relay.json'), { transcriptPath: input.relayTranscript });
  const result = { ...analyzed(), evidence: { transcripts: [input.transcript, input.relayTranscript],
    agents: [{ agentId: 'codex', pointer: input.pointer, jobDir: input.jobDir }] } };
  const copy = copyEvidence(baseRun(input), result, path.join(ctx.dir, 'evidence'));
  const pointer = readJson(path.join(copy.jobsHome, 'relays/codex.json'));
  fs.rmSync(input.jobsHome, { recursive: true });
  assert.equal(readJson(path.join(pointer.jobDir, 'job.json')).relay.transcriptPath, pointer.transcriptPath);
  assert.equal(readJson(path.join(pointer.jobDir, 'relay.json')).transcriptPath, pointer.transcriptPath);
  assert.equal(fs.existsSync(pointer.transcriptPath), true);
});

test('a source disappearing during analysis cannot replace the existing evidence copy', t => {
  const ctx = scratch(t), input = evidenceFixture(ctx);
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(input), backends: ['codex'], promptSentAt: start });
  writeTranscript(input.transcript, entries(created.run.runId));
  const options = { recordsDir: ctx.recordsDir, env: ctx.env };
  analyzeRun(created.run, created.evidenceDir, registry, readers, options);
  const before = directoryBytes(created.evidenceDir);
  const custom = { ...check, analyze(input) {
    const result = check.analyze(input);
    fs.rmSync(result.evidence.agents[0].jobDir, { recursive: true });
    return result;
  } };
  assert.throws(() => analyzeRun(created.run, created.evidenceDir, [custom], readers, options), /original evidence.*gone; analyze it with --from-copy/);
  assert.deepEqual(directoryBytes(created.evidenceDir), before);
  assert.equal(fs.readdirSync(created.evidenceDir).some(name => name.startsWith('.copy-')), false);
});

test('a failed swap restores the old copy and removes staging files', t => {
  const ctx = scratch(t), input = evidenceFixture(ctx);
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(input), backends: ['codex'], promptSentAt: start });
  writeTranscript(input.transcript, entries(created.run.runId));
  const options = { recordsDir: ctx.recordsDir, env: ctx.env };
  analyzeRun(created.run, created.evidenceDir, registry, readers, options);
  const before = directoryBytes(created.evidenceDir), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (path.basename(source).startsWith('.copy-') && !source.endsWith('-previous')) throw new Error('Swap failed.');
    return rename(source, destination);
  });
  assert.throws(() => analyzeRun(created.run, created.evidenceDir, registry, readers, options), /Swap failed/);
  assert.deepEqual(directoryBytes(created.evidenceDir), before);
  assert.equal(fs.readdirSync(created.evidenceDir).some(name => name.startsWith('.copy-')), false);
});

for (const wrapped of [false, true]) {
  test(`discovery and prepared analysis share prompt normalization (paste=${wrapped}) and skip malformed neighbors`, t => {
    const ctx = scratch(t);
    const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(), workDir: ctx.workDir });
    const project = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'projects', 'other');
    const transcript = path.join(project, 'valid.jsonl');
    const rows = entries(created.run.runId);
    const prompt = `\n\nLive suite run ${created.run.runId}.\nrest`;
    rows[0].message.content = wrapped ? `\n<pasted_content id="p1">\n${prompt}\n</pasted_content id="p1">` : prompt;
    writeTranscript(transcript, rows);
    fs.writeFileSync(path.join(project, 'broken.jsonl'), '{"unfinished":');
    assert.equal(findRunTranscript(ctx.workDir, created.run.runId, ctx.env.CLAUDE_CONFIG_DIR,
      readers.readTranscript, readers.promptText), transcript);
    const result = analyzeRun(created.run, created.evidenceDir, registry, readers, { env: ctx.env, recordsDir: ctx.recordsDir });
    assert.ok(result.records.every(row => row.result === 'pass'));
    assert.equal(result.records[0].startedAt, start);
    assert.equal(result.records[0].durationSeconds, 3.5);
    assert.throws(() => analyzeRun(created.run, created.evidenceDir, registry, readers,
      { env: ctx.env, recordsDir: ctx.recordsDir, transcript: path.join(project, 'broken.jsonl') }), /Invalid JSON/);
  });
}

test('command-only scope supplies completion, metadata and span with check-specific surface entrypoints', t => {
  const ctx = scratch(t);
  const run = baseRun({ surface: 'terminal', workDir: ctx.workDir, jobsHome: ctx.env.RELAY_JOBS_HOME });
  const custom = { ...check, marker: undefined,
    scope(rows, runId) { assert.equal(runId, id); return rows.slice(1, 3); },
    entrypoints: { terminal: ['cli', 'sdk-cli'], t3: ['sdk-ts'] },
    completed: rows => rows.some(entry => entry.num_turns === 0) };
  const rows = [entries('other')[0],
    { type: 'system', timestamp: start, entrypoint: 'sdk-cli', version: 'command-version' },
    { type: 'assistant', timestamp: finish, num_turns: 0, message: { model: 'command-model', content: [] } },
    ...entries('later')];
  const transcript = path.join(ctx.dir, 'command.jsonl');
  writeTranscript(transcript, rows);
  const evidenceDir = runDirectory(ctx.env.RELAY_LIVE_HOME, id);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const result = analyzeRun(run, evidenceDir, [custom], readers,
    { transcript, env: ctx.env, recordsDir: ctx.recordsDir, analysis: analyzed(run) });
  assert.ok(result.records.every(row => row.result === 'pass'));
  const row = result.records[0];
  assert.equal(row.claudeCodeVersion, 'command-version');
  assert.equal(row.leadModel, 'command-model');
  assert.equal(row.startedAt, start);
  assert.equal(row.finishedAt, finish);
  assert.equal(row.durationSeconds, 3.5);
  assert.equal(run.promptSentAt, start);
  const wrong = makeRecords({ ...run, surface: 't3' }, custom, analyzed(run), rows, readers)[0];
  assert.equal(wrong.result, 'fail');
  assert.equal(wrong.reason, 'The session ran as sdk-cli, not sdk-ts.');
  assert.equal(makeRecords(run, { ...custom, entrypoints: undefined }, analyzed(run), rows, readers)[0].result, 'fail');
});

for (const missing of ['relayTranscript', 'workflow', 'pointer', 'jobFile']) {
  test(`source manifest preserves the previous copy when a previously copied ${missing} vanishes`, t => {
    const ctx = scratch(t), input = evidenceFixture(ctx);
    // Exercise a relay transcript outside both the session and job folders.
    input.relayTranscript = path.join(ctx.dir, 'external-relay/transcript.jsonl');
    writeTranscript(input.relayTranscript, [{}]);
    input.jobFile = path.join(input.jobDir, 'report.md');
    fs.writeFileSync(input.jobFile, 'report');
    writeJson(input.pointer, { jobDir: input.jobDir, transcriptPath: input.relayTranscript });
    const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(input), backends: ['codex'], promptSentAt: start });
    writeTranscript(input.transcript, entries(created.run.runId));
    let analyzeCalls = 0;
    const selected = { ...check, analyze(value) {
      analyzeCalls++;
      const result = check.analyze(value);
      result.evidence.transcripts.push(input.workflow);
      return result;
    } };
    const options = { recordsDir: ctx.recordsDir, env: ctx.env };
    analyzeRun(created.run, created.evidenceDir, [selected], readers, options);
    const sources = readJson(created.run.copy.manifest).sources;
    for (const key of ['transcript', 'relayTranscript', 'workflow', 'pointer', 'jobDir', 'jobFile']) assert.ok(sources.includes(input[key]), key);
    assert.ok(!sources.some(source => source.includes('.lock.d') || source.includes('worker.lease.d')));
    const before = directoryBytes(created.evidenceDir), records = directoryBytes(ctx.recordsDir);
    fs.rmSync(input[missing]);
    assert.throws(() => analyzeRun(created.run, created.evidenceDir, [selected], readers, options),
      { message: `The original evidence of ${created.run.runId} is gone; analyze it with --from-copy.` });
    assert.equal(analyzeCalls, 1, 'refuse before the analyzer can omit the missing source');
    assert.throws(() => copyEvidence(created.run, { ...analyzed(), evidence: { transcripts: [], agents: [] } }, created.evidenceDir), /original evidence.*gone/);
    assert.deepEqual(directoryBytes(created.evidenceDir), before);
    assert.deepEqual(directoryBytes(ctx.recordsDir), records);
  });
}

test('a relay transcript disappearing and omitted during analysis cannot erase its saved copy', t => {
  const ctx = scratch(t), input = evidenceFixture(ctx);
  const created = createRun(ctx.env.RELAY_LIVE_HOME, check, { ...baseRun(input), promptSentAt: start });
  writeTranscript(input.transcript, entries(created.run.runId));
  const options = { env: ctx.env, recordsDir: ctx.recordsDir };
  analyzeRun(created.run, created.evidenceDir, registry, readers, options);
  const before = directoryBytes(created.evidenceDir);
  const custom = { ...check, analyze() {
    fs.rmSync(input.relayTranscript);
    return { ...analyzed(), evidence: { transcripts: [input.transcript], agents: [] } };
  } };
  assert.throws(() => analyzeRun(created.run, created.evidenceDir, [custom], readers, options), /original evidence.*gone/);
  assert.deepEqual(directoryBytes(created.evidenceDir), before);
});

test('settings changes fail every record first, with private paths redacted', () => {
  const run = baseRun({ settingsChanged: true, settingsFile: path.join(os.homedir(), '.claude/settings.json') });
  const result = analyzed(run);
  result.results[0].result = 'fail'; result.results[0].reason = 'Backend failed.';
  const rows = makeRecords(run, check, result, entries(id, 'unfinished'), readers);
  assert.ok(rows.every(row => row.result === 'fail' && row.reason.startsWith('[path] changed during the run. The lead did not print FAKE-DONE.')));
  assert.ok(rows[0].reason.endsWith('Backend failed.'));
  assert.doesNotMatch(JSON.stringify(rows), /~\/|\/home\//);
});

test('record sanitization catches path signatures anywhere in non-space tokens', () => {
  const analysis = analyzed();
  analysis.results[0].reason = ['source->/home/alice/model', 'source->~/secret', 'vendor/Users/alice/model',
    'uri:/var/cache/x', 'file:///private/x', 'project-home-alice-repo', 'prefix/tmp/x'].join(' ');
  const row = makeRecords(baseRun(), check, analysis, entries(), readers)[0];
  assert.equal(row.reason, '[path] [path] [path] [path] [path] [path] prefix<tmp>/x');
});

for (const after of ['0123456789ab', '0123456789ab-dirty', 'abcdef012345', null]) {
  test(`terminal rechecks the build after the session (${after})`, async t => {
    const ctx = scratch(t), pluginDir = receipt(ctx);
    let commits = 0, ended = false;
    const status = await main(['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir,
      '--jobs-home', ctx.env.RELAY_JOBS_HOME, '--records-dir', ctx.recordsDir], registry, readers, {
      env: ctx.env, log() {}, warn() {},
      commitOf(dir) { assert.equal(dir, pluginDir); commits++; return ended ? after : '0123456789ab'; },
      driver(input, selected, { run }) {
        run.promptSentAt = start;
        run.transcript = path.join(input.evidenceDir, 'main.jsonl');
        writeTranscript(run.transcript, entries(input.runId));
        ended = true;
      }
    });
    assert.equal(status, 0);
    assert.equal(commits, 2);
    const expected = after === '0123456789ab' ? after : '0123456789ab-dirty';
    const rows = readRecords(ctx.recordsDir);
    assert.ok(rows.every(row => row.relayCommit === expected));
    assert.equal(readJson(path.join(runDirectory(ctx.env.RELAY_LIVE_HOME, rows[0].runId), 'run.json')).relayCommit, expected);
  });
}

for (const mode of ['timeout', 'interrupt', 'failure', 'complete', 'startup', 'caller-owned', 'cancel-failure']) {
  test(`unfinished terminal job cleanup before analysis: ${mode}`, async t => {
    const ctx = scratch(t), pluginDir = receipt(ctx);
    const calls = [], warnings = [];
    let seen, analyzedAfterCleanup = false;
    const custom = { ...check, analyze(input) {
      if (!['complete', 'caller-owned'].includes(mode)) assert.equal(calls.length, 2);
      analyzedAfterCleanup = true;
      return { ...analyzed(baseRun({ backends: input.backends })), evidence: { transcripts: [input.transcript], agents: [] } };
    } };
    const status = await main(['run', 'fake', '--plugin-dir', pluginDir, '--work-dir', ctx.workDir,
      '--records-dir', ctx.recordsDir, ...(mode === 'caller-owned' ? ['--jobs-home', ctx.env.RELAY_JOBS_HOME] : [])], [custom], readers, {
      env: ctx.env, log() {}, warn(message) { warnings.push(message); },
      cancelJobs: (run, options) => cancelUnfinishedJobs(run, { ...options, async execute(command, args, settings) {
        calls.push(args.at(-1));
        assert.equal(command, process.execPath);
        assert.deepEqual(args.slice(0, 2), [path.join(pluginDir, 'scripts/companion.mjs'), 'cancel']);
        assert.equal(settings.env.RELAY_JOBS_HOME, run.jobsHome);
        assert.equal(settings.env.CLAUDE_CONFIG_DIR, ctx.env.CLAUDE_CONFIG_DIR);
        assert.equal(analyzedAfterCleanup, false);
        if (mode === 'cancel-failure' && calls.length === 1) throw new Error('Simulated cancel failure.');
      } }),
      driver(input, selected, { run }) {
        seen = run;
        assert.equal(input.workDirCreated, false);
        assert.equal(input.jobsHomeCreated, mode !== 'caller-owned');
        if (mode !== 'caller-owned') t.after(() => fs.rmSync(input.jobsHome, { recursive: true, force: true }));
        for (const [jobId, state] of [['a-running', 'running'], ['b-starting', 'starting'], ['c-completed', 'completed'],
          ['d-failed', 'failed'], ['e-cancelled', 'cancelled']]) writeJson(path.join(input.jobsHome, 'repo', jobId, 'job.json'), { id: jobId, state });
        if (mode === 'startup') throw new Error('Startup failed.');
        run.promptSentAt = start;
        run.transcript = path.join(input.evidenceDir, 'main.jsonl');
        writeTranscript(run.transcript, entries(input.runId, mode === 'complete' ? check.marker : 'unfinished'));
        run.completed = mode === 'complete';
        if (mode === 'interrupt') run.interrupted = true;
        if (['failure', 'caller-owned', 'cancel-failure'].includes(mode)) throw new Error('After prompt failure.');
      }
    });
    assert.equal(status, mode === 'complete' ? 0 : 1);
    const shouldCancel = !['complete', 'startup', 'caller-owned'].includes(mode);
    assert.deepEqual(calls, shouldCancel ? ['a-running', 'b-starting'] : []);
    assert.equal(analyzedAfterCleanup, mode !== 'startup');
    const saved = readJson(path.join(runDirectory(ctx.env.RELAY_LIVE_HOME, seen.runId), 'run.json'));
    if (shouldCancel) assert.deepEqual(saved.cancellations, [
      { jobId: 'a-running', status: mode === 'cancel-failure' ? 'failed' : 'cancelled',
        ...(mode === 'cancel-failure' ? { error: 'Simulated cancel failure.' } : {}) },
      { jobId: 'b-starting', status: 'cancelled' }
    ]);
    else assert.equal(saved.cancellations, undefined);
    if (mode === 'cancel-failure') assert.ok(warnings.some(message => message.includes('Could not cancel a-running')));
  });
}

test('job cleanup refuses caller-owned homes even when called directly', async () => {
  assert.deepEqual(await cancelUnfinishedJobs({ promptSentAt: start, jobsHomeCreated: false, jobsHome: '/not-a-real-home' },
    { execute() { assert.fail('must not execute'); } }), []);
});
