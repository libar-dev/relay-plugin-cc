import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const recordKeys = ['schema', 'runId', 'check', 'surface', 'backend', 'model', 'relayVersion',
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
  return { workDir: dir, pluginDir, relayVersion: pluginVersion(pluginDir) };
}

export function pluginVersion(pluginDir) {
  const plugin = readJson(path.join(pluginDir, '.claude-plugin/plugin.json'));
  if (!plugin.version) throw new Error(`Missing version in ${pluginDir}/.claude-plugin/plugin.json.`);
  return plugin.version;
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
    return text.split('\n').some(line => line.trimEnd() === `Live suite run ${id}.`);
  });
}

export function findRunTranscript(workDir, id, configDir, readTranscript) {
  const { preferred, others } = projectFolders(workDir, configDir);
  for (const folders of [[preferred], others]) {
    const files = folders.flatMap(folder => fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => path.join(folder, entry.name)) : []);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || a.localeCompare(b));
    for (const file of files) if (holdsRun(readTranscript(file), id)) return file;
  }
  return null;
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
      warn(`~/.claude/settings.json changed during the run; compare it with ${copy}`);
    }
    return changed;
  };
}

function withoutPaths(value) {
  if (typeof value === 'string') return value.replace(/(^|[\s"'(=])\/(?!\/)[^\s"',;)]+/g, '$1[path]');
  if (Array.isArray(value)) return value.map(withoutPaths);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutPaths(item)]));
  return value;
}

export function makeRecords(run, check, analysis, entries, readers) {
  const span = readers.runSpan(entries, run.runId, check.marker);
  const duration = span.startedAt && span.finishedAt ? (Date.parse(span.finishedAt) - Date.parse(span.startedAt)) / 1000 : null;
  const marked = readers.hasMarker(entries, check.marker);
  return readers.BACKENDS.filter(backend => run.backends.includes(backend)).map(backend => {
    const result = analysis.results.find(row => row.backend === backend);
    let reason = result?.reason ?? (result ? null : run.error || `The check produced no result for ${backend}.`);
    if (!marked) reason = `The lead did not print ${check.marker}.` + (reason ? ` ${reason}` : '');
    return withoutPaths({ schema: 'relay.live-record/1', runId: run.runId, check: run.check, surface: run.surface,
      backend, model: result?.model ?? null, relayVersion: result?.relayVersion ?? run.relayVersion,
      claudeCodeVersion: readers.claudeCodeVersionOf(entries), leadModel: readers.leadModelOf(entries),
      platform: run.platform ?? process.platform, startedAt: span.startedAt, finishedAt: span.finishedAt,
      durationSeconds: Number.isFinite(duration) ? duration : null, delivery: result?.delivery ?? null,
      timings: result?.timings ?? {}, result: marked && result?.result === 'pass' ? 'pass' : 'fail', reason,
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
  fs.rmSync(copy, { recursive: true, force: true });
  const jobsHome = path.join(copy, 'jobs');
  const session = path.join(copy, 'session');
  fs.mkdirSync(jobsHome, { recursive: true });
  fs.mkdirSync(session, { recursive: true });
  const paths = new Map();
  const jobCopies = new Map();
  for (const agent of analysis.evidence.agents) {
    if (!agent.jobDir || !fs.existsSync(agent.jobDir)) continue;
    const source = path.resolve(run.jobsHome, agent.jobDir);
    const relative = relativeInside(run.jobsHome, source) ?? path.join('external', createHash('sha256').update(source).digest('hex'));
    const target = path.join(jobsHome, relative);
    fs.cpSync(source, target, { recursive: true,
      filter: file => !path.basename(file).endsWith('.lock.d') && path.basename(file) !== 'worker.lease.d' });
    jobCopies.set(source, target);
  }
  for (const file of new Set([run.transcript, ...analysis.evidence.transcripts].filter(Boolean))) {
    if (!fs.existsSync(file)) continue;
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
    if (!agent.pointer || !fs.existsSync(agent.pointer)) continue;
    let pointer;
    try { pointer = readJson(agent.pointer); }
    catch { continue; }
    const job = pointer.jobDir ? path.resolve(run.jobsHome, pointer.jobDir) : null;
    if (job) pointer.jobDir = jobCopies.get(job) ?? path.join(jobsHome, 'missing', agent.agentId);
    if (pointer.transcriptPath && paths.has(path.resolve(run.jobsHome, pointer.transcriptPath))) {
      pointer.transcriptPath = paths.get(path.resolve(run.jobsHome, pointer.transcriptPath));
    }
    if (path.basename(agent.agentId) !== agent.agentId) throw new Error('Invalid evidence agent id.');
    writeJson(path.join(jobsHome, 'relays', `${agent.agentId}.json`), pointer);
  }
  return { transcript: paths.get(run.transcript) ?? null, jobsHome };
}

export function analyzeRun(run, evidenceDir, registry, readers, options = {}) {
  const check = registry.find(item => item.id === run.check);
  if (!check) throw new Error(`Unknown check: ${run.check}`);
  const env = options.env ?? process.env;
  let transcript = options.fromCopy ? run.copy?.transcript : options.transcript ?? run.transcript ??
    findRunTranscript(run.workDir, run.runId, configDirectory(env), readers.readTranscript);
  const jobsHome = options.fromCopy ? run.copy?.jobsHome : options.jobsHome ?? run.jobsHome ??
    env.RELAY_JOBS_HOME ?? path.join(os.homedir(), '.relay-jobs');
  if (options.fromCopy && (!transcript || !jobsHome)) throw new Error(`No evidence copy for ${run.runId}.`);
  if (!transcript && !run.promptSentAt) throw new Error(`No transcript for ${run.runId}.`);
  if (!transcript) {
    // Keep empty evidence replayable when the session died before creating its transcript.
    transcript = path.join(evidenceDir, 'missing-transcript.jsonl');
    fs.writeFileSync(transcript, '');
  }
  const entries = readers.readTranscript(transcript);
  if (!run.promptSentAt && !holdsRun(entries, run.runId)) throw new Error(`The transcript has no prompt for ${run.runId}.`);
  run.promptSentAt ??= readers.runSpan(entries, run.runId, check.marker).startedAt ?? run.preparedAt;
  const input = { runId: run.runId, backends: run.backends, surface: run.surface, transcript,
    jobsHome: path.resolve(jobsHome), relayVersion: run.relayVersion };
  const analysis = options.analysis ?? check.analyze(input);
  const records = makeRecords(run, check, analysis, entries, readers);
  fs.writeFileSync(path.join(evidenceDir, 'details.jsonl'), analysis.details.map(row => JSON.stringify(row)).join('\n') + (analysis.details.length ? '\n' : ''));
  if (!options.fromCopy) {
    run.transcript = transcript;
    run.jobsHome = input.jobsHome;
    run.copy = copyEvidence(run, analysis, evidenceDir);
  }
  run.platform ??= process.platform;
  const file = writeRecords(run, records, evidenceDir, options.recordsDir);
  writeJson(path.join(evidenceDir, 'run.json'), run);
  return { records, file };
}
