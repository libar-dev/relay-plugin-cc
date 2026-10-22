import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

export const recordKeys = ['schema', 'runId', 'check', 'surface', 'backend', 'model', 'relayVersion', 'relayCommit',
  'claudeCodeVersion', 'leadModel', 'platform', 'startedAt', 'finishedAt', 'durationSeconds',
  'delivery', 'timings', 'result', 'reason', 'evidence'];

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export const configDirectory = (env = process.env) => path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
export const evidenceRoot = (env = process.env) => path.resolve(env.RELAY_LIVE_HOME ||
  path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'relay-plugin-cc/live'));

export function runId(check, surface, now = new Date(), suffix = randomBytes(2).toString('hex')) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${check}-${surface}-${suffix}`;
}

export function runDirectory(root, id) {
  if (!/^\d{8}T\d{6}Z-[a-z0-9-]+-(terminal|t3)-[a-f0-9]{4}$/.test(id)) throw new Error(`Invalid run id: ${id}`);
  return path.join(root, 'runs', id);
}

export function createRun(root, check, options) {
  const id = runId(check.id, options.surface);
  const evidenceDir = runDirectory(root, id);
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(evidenceDir, 0o700);
  const run = { ...options, runId: id, check: check.id, preparedAt: new Date().toISOString(), marker: check.marker };
  writeJson(path.join(evidenceDir, 'run.json'), run);
  fs.writeFileSync(path.join(evidenceDir, 'prompt.txt'), check.prompt({ runId: id, backends: run.backends }));
  return { run, evidenceDir };
}

export function smokeInstall(workDir, env = process.env) {
  const dir = fs.realpathSync(workDir);
  const hash = createHash('sha256').update(dir).digest('hex');
  const receipt = path.resolve(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
    'relay-plugin-cc/smoke-installs', `${hash}.json`);
  if (!fs.existsSync(receipt)) throw new Error(`No smoke install for ${dir}. Run scripts/smoke/install-local.sh ${dir} first.`);
  const saved = readJson(receipt);
  if (saved.dir !== dir) throw new Error('Smoke install receipt is for a different directory.');
  const pluginDir = path.join(saved.marketplace, 'relay');
  if (!fs.existsSync(pluginDir)) throw new Error(`The smoke install's build folder ${pluginDir} is gone; reinstall with scripts/smoke/install-local.sh ${dir}.`);
  const relayCommit = /^[a-f0-9]{40}$/i.test(saved.commit ?? '') ? saved.commit.slice(0, 12) + (saved.worktree ? '-dirty' : '') : null;
  return { workDir: dir, pluginDir, relayVersion: pluginVersion(pluginDir), relayCommit };
}

export function pluginVersion(pluginDir) {
  const plugin = readJson(path.join(pluginDir, '.claude-plugin/plugin.json'));
  if (!plugin.version) throw new Error(`Missing version in ${pluginDir}/.claude-plugin/plugin.json.`);
  return plugin.version;
}

export function pluginCommit(pluginDir) {
  try {
    const git = args => execFileSync('git', ['-C', pluginDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--', path.resolve(pluginDir)]);
    return commit.slice(0, 12) + (dirty ? '-dirty' : '');
  } catch { return null; }
}

function projectFolders(workDir, configDir) {
  const projects = path.join(configDir, 'projects');
  const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
  const folders = fs.existsSync(projects) ? fs.readdirSync(projects, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => path.join(projects, entry.name)).sort() : [];
  const preferred = path.join(projects, slug);
  return { preferred, others: folders.filter(folder => folder !== preferred) };
}

export function findTranscript(workDir, debugLog, configDir, readTranscript) {
  const sessionId = path.basename(debugLog, '.txt');
  if (!/^[\da-f-]{36}$/i.test(sessionId)) throw new Error(`No session id in debug log path: ${debugLog}`);
  const { preferred, others } = projectFolders(workDir, configDir);
  const expected = path.join(preferred, `${sessionId}.jsonl`);
  if (fs.existsSync(expected)) return expected;
  for (const folder of others) {
    const file = path.join(folder, `${sessionId}.jsonl`);
    if (fs.existsSync(file) && readTranscript(file).some(entry => entry.cwd === workDir)) return file;
  }
  return null;
}

function holdsRun(entries, id) {
  return entries.some(entry => {
    if (entry.isSidechain || entry.type !== 'user') return false;
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
      .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    return text.split('\n')[0] === `Live suite run ${id}.`;
  });
}

export function findRunTranscript(workDir, id, configDir, readTranscript) {
  const { preferred, others } = projectFolders(workDir, configDir);
  const files = [preferred, ...others].flatMap(folder => fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => path.join(folder, entry.name)) : []).sort();
  const matches = files.filter(file => holdsRun(readTranscript(file), id));
  if (matches.length > 1) throw new Error(`Multiple transcripts hold ${id}; choose one with --transcript:\n${matches.join('\n')}`);
  return matches[0] ?? null;
}

function settingsBytes(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function settingsGuard(configDir) {
  const file = path.join(configDir, 'settings.json');
  const before = settingsBytes(file);
  return (run, evidenceDir, warn = console.error) => {
    const after = settingsBytes(file);
    const changed = before === null ? after !== null : after === null || !before.equals(after);
    run.settingsChanged = changed;
    if (changed) {
      run.settingsExistedBefore = before !== null;
      const copy = path.join(evidenceDir, 'settings.before.json');
      // JSON null records absence without pretending there was an empty settings object.
      fs.writeFileSync(copy, before ?? 'null\n');
      warn(`${file} changed during the run; compare it with ${copy}`);
    }
    return changed;
  };
}

function withoutPaths(value, replacements) {
  if (typeof value === 'string') {
    for (const [source, label] of replacements) value = value.split(source).join(label);
    return value.replace(/(^|[\s"'`(\[=:])\/+[^\s"'`,;)>\]]+/g, '$1[path]');
  }
  if (Array.isArray(value)) return value.map(item => withoutPaths(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [withoutPaths(key, replacements), withoutPaths(item, replacements)]));
  return value;
}

export function makeRecords(run, check, analysis, entries, readers, root = evidenceRoot()) {
  entries = readers.scopeToRun(entries, run.runId);
  const span = readers.runSpan(entries, run.runId, check.marker);
  const duration = span.startedAt && span.finishedAt ? (Date.parse(span.finishedAt) - Date.parse(span.startedAt)) / 1000 : null;
  const completed = check.completed ? check.completed(entries) : Boolean(check.marker && readers.hasMarker(entries, check.marker));
  const entrypoint = entries.find(entry => !entry.isSidechain && entry.entrypoint)?.entrypoint ?? null;
  const expected = run.surface === 'terminal' ? 'cli' : 'sdk-ts';
  const replacements = [[os.homedir(), '~'], [root, '<evidence>'],
    [fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''), '<repo>'],
    [os.tmpdir(), '<tmp>'], ['/tmp', '<tmp>'], [run.workDir, '<work>'], [run.jobsHome, '<jobs>']]
    .filter(([source]) => source).sort((a, b) => b[0].length - a[0].length);
  const clean = value => withoutPaths(value, replacements);
  return readers.BACKENDS.filter(backend => run.backends.includes(backend)).map(backend => {
    const result = analysis.results.find(row => row.backend === backend);
    let reason = result?.reason ?? (result ? null : run.error || `The check produced no result for ${backend}.`);
    if (entrypoint !== expected) reason = `The session ran as ${entrypoint}, not ${expected}.` + (reason ? ` ${reason}` : '');
    if (!completed) reason = (check.marker ? `The lead did not print ${check.marker}.` : 'The run did not complete.') + (reason ? ` ${reason}` : '');
    const model = clean(result?.model ?? null);
    const timings = Object.fromEntries(Object.entries(result?.timings ?? {})
      .filter(([, values]) => Array.isArray(values) && values.every(Number.isFinite)));
    return clean({ schema: 'relay.live-record/1', runId: run.runId, check: run.check, surface: run.surface,
      backend, model: typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(model) ? model : null,
      relayVersion: result?.relayVersion ?? run.relayVersion, relayCommit: run.relayCommit ?? null,
      claudeCodeVersion: readers.claudeCodeVersionOf(entries), leadModel: readers.leadModelOf(entries),
      platform: run.platform ?? process.platform, startedAt: span.startedAt, finishedAt: span.finishedAt,
      durationSeconds: Number.isFinite(duration) ? duration : null, delivery: result?.delivery ?? null,
      timings, result: completed && entrypoint === expected && result?.result === 'pass' ? 'pass' : 'fail', reason,
      evidence: `runs/${run.runId}` });
  });
}

export function writeRecords(run, records, evidenceDir, recordsDir) {
  if (!run.promptSentAt) return null;
  const lines = records.map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.mkdirSync(recordsDir, { recursive: true });
  const file = path.join(recordsDir, `${run.runId}.jsonl`);
  fs.writeFileSync(file, lines);
  fs.writeFileSync(path.join(evidenceDir, 'records.jsonl'), lines);
  return file;
}

function relativeInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : null;
}

export function copyEvidence(run, analysis, evidenceDir) {
  const copy = path.join(evidenceDir, 'copy');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(evidenceDir, '.copy-'));
  const finalPath = file => path.join(copy, path.relative(staging, file));
  const available = file => {
    if (file && fs.existsSync(file)) return true;
    if (file && fs.existsSync(copy)) throw new Error(`The original evidence of ${run.runId} is gone; analyze it with --from-copy.`);
    return false;
  };
  try {
    const jobsHome = path.join(staging, 'jobs');
    const session = path.join(staging, 'session');
    fs.mkdirSync(jobsHome, { recursive: true });
    fs.mkdirSync(session, { recursive: true });
    const paths = new Map();
    const jobCopies = new Map();
    for (const agent of analysis.evidence.agents) {
      if (!agent.jobDir) continue;
      const source = path.resolve(run.jobsHome, agent.jobDir);
      if (!available(source)) continue;
      const relative = relativeInside(run.jobsHome, source) ?? path.join('external', createHash('sha256').update(source).digest('hex'));
      const target = path.join(jobsHome, relative);
      fs.cpSync(source, target, { recursive: true,
        filter: file => !path.basename(file).endsWith('.lock.d') && path.basename(file) !== 'worker.lease.d' });
      jobCopies.set(source, target);
    }
    for (const file of new Set([run.transcript, ...analysis.evidence.transcripts].filter(Boolean))) {
      if (!available(file)) continue;
      const relative = relativeInside(path.dirname(run.transcript), file);
      let target = relative === null ? null : path.join(session, relative);
      if (!target) {
        for (const [source, destination] of jobCopies) {
          const within = relativeInside(source, file);
          if (within !== null) { target = path.join(destination, within); break; }
        }
      }
      // Relay transcripts can be outside the main session's folder.
      target ??= path.join(session, 'external', createHash('sha256').update(file).digest('hex'), path.basename(file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
      paths.set(path.resolve(file), target);
    }
    for (const agent of analysis.evidence.agents) {
      if (!available(agent.pointer)) continue;
      let pointer;
      try { pointer = readJson(agent.pointer); }
      catch (error) { if (fs.existsSync(copy)) throw error; continue; }
      const job = pointer.jobDir ? path.resolve(run.jobsHome, pointer.jobDir) : null;
      if (job) pointer.jobDir = finalPath(jobCopies.get(job) ?? path.join(jobsHome, 'missing', agent.agentId));
      if (pointer.transcriptPath && paths.has(path.resolve(run.jobsHome, pointer.transcriptPath))) {
        pointer.transcriptPath = finalPath(paths.get(path.resolve(run.jobsHome, pointer.transcriptPath)));
      }
      if (path.basename(agent.agentId) !== agent.agentId) throw new Error('Invalid evidence agent id.');
      writeJson(path.join(jobsHome, 'relays', `${agent.agentId}.json`), pointer);
    }
    for (const target of jobCopies.values()) {
      for (const name of ['job.json', 'relay.json']) {
        const file = path.join(target, name);
        if (!fs.existsSync(file)) continue;
        let saved;
        try { saved = readJson(file); } catch { continue; }
        const binding = name === 'job.json' ? saved?.relay : saved;
        const transcript = binding?.transcriptPath;
        if (typeof transcript === 'string' && paths.has(path.resolve(run.jobsHome, transcript))) {
          binding.transcriptPath = finalPath(paths.get(path.resolve(run.jobsHome, transcript)));
          writeJson(file, saved);
        }
      }
    }
    const backup = `${staging}-previous`;
    const existed = fs.existsSync(copy);
    if (existed) fs.renameSync(copy, backup);
    try { fs.renameSync(staging, copy); }
    catch (error) {
      if (existed) fs.renameSync(backup, copy);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    return { transcript: paths.has(run.transcript) ? finalPath(paths.get(run.transcript)) : null,
      jobsHome: finalPath(jobsHome), originalJobDirs: [...jobCopies.keys()] };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function requireOriginalEvidence(run, transcript, jobsHome) {
  if (!run.copy) return;
  let jobs = run.copy.originalJobDirs;
  if (!jobs) {
    const copiedJobs = run.copy.jobsHome;
    const originals = new Map();
    const pointers = path.join(copiedJobs, 'relays');
    if (fs.existsSync(pointers)) for (const name of fs.readdirSync(pointers).filter(name => name.endsWith('.json'))) {
      const pointer = readJson(path.join(pointers, name));
      if (!pointer.jobDir || !fs.existsSync(pointer.jobDir)) continue;
      const relative = relativeInside(copiedJobs, pointer.jobDir);
      let original = relative === null ? null : path.join(run.jobsHome ?? jobsHome, relative);
      const sourcePointer = path.join(run.jobsHome ?? jobsHome, 'relays', name);
      if (relative?.startsWith(`external${path.sep}`) && fs.existsSync(sourcePointer)) {
        const saved = readJson(sourcePointer);
        if (saved.jobDir) original = path.resolve(run.jobsHome ?? jobsHome, saved.jobDir);
      }
      originals.set(pointer.jobDir, original);
    }
    // Older run.json files have no source manifest; include jobs copied without a relay pointer too.
    if (fs.existsSync(copiedJobs)) for (const name of fs.readdirSync(copiedJobs, { recursive: true })) {
      if (path.basename(name) !== 'job.json') continue;
      const dir = path.dirname(path.join(copiedJobs, name));
      if (!originals.has(dir)) originals.set(dir, path.join(run.jobsHome ?? jobsHome, path.dirname(name)));
    }
    jobs = [...originals.values()];
  }
  if ([run.jobsHome ?? jobsHome, run.transcript ?? transcript, transcript, jobsHome, ...jobs]
    .some(file => !file || !fs.existsSync(file))) {
    throw new Error(`The original evidence of ${run.runId} is gone; analyze it with --from-copy.`);
  }
}

export function analyzeRun(run, evidenceDir, registry, readers, options = {}) {
  const check = registry.find(item => item.id === run.check);
  if (!check) throw new Error(`Unknown check: ${run.check}`);
  const env = options.env ?? process.env;
  let transcript = options.fromCopy ? run.copy?.transcript : options.transcript ?? run.transcript ??
    findRunTranscript(run.workDir, run.runId, configDirectory(env), readers.readTranscript);
  const jobsHome = options.fromCopy ? run.copy?.jobsHome : options.jobsHome ?? run.jobsHome ??
    env.RELAY_JOBS_HOME ?? path.join(os.homedir(), '.relay-jobs');
  if (!options.fromCopy) requireOriginalEvidence(run, transcript, jobsHome);
  if (options.fromCopy && (!transcript || !jobsHome)) throw new Error(`No evidence copy for ${run.runId}.`);
  if (!transcript && !run.promptSentAt) throw new Error(`No transcript for ${run.runId}.`);
  if (!transcript) {
    // Keep empty evidence replayable when the session died before creating its transcript.
    transcript = path.join(evidenceDir, 'missing-transcript.jsonl');
    fs.writeFileSync(transcript, '');
  }
  const entries = readers.scopeToRun(readers.readTranscript(transcript), run.runId);
  if (!run.promptSentAt && !holdsRun(entries, run.runId)) throw new Error(`The transcript has no prompt for ${run.runId}.`);
  run.promptSentAt ??= readers.runSpan(entries, run.runId, check.marker).startedAt ?? run.preparedAt;
  const input = { runId: run.runId, backends: run.backends, surface: run.surface, transcript,
    jobsHome: path.resolve(jobsHome), relayVersion: run.relayVersion, evidenceDir };
  const analysis = options.analysis ?? check.analyze(input);
  const records = makeRecords(run, check, analysis, entries, readers, path.dirname(path.dirname(evidenceDir)));
  if (!options.fromCopy) {
    run.transcript = transcript;
    run.jobsHome = input.jobsHome;
    run.copy = copyEvidence(run, analysis, evidenceDir);
  }
  fs.writeFileSync(path.join(evidenceDir, 'details.jsonl'), analysis.details.map(row => JSON.stringify(row)).join('\n') + (analysis.details.length ? '\n' : ''));
  run.platform ??= process.platform;
  const file = writeRecords(run, records, evidenceDir, options.recordsDir);
  writeJson(path.join(evidenceDir, 'run.json'), run);
  return { records, file };
}
