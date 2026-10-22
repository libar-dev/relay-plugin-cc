import fs from 'node:fs';
import path from 'node:path';

export const BACKENDS = ['codex', 'grok', 'zcode', 'kimi'];
export const MODELS = { codex: 'gpt-6.1-sol', grok: 'grok-4.7', zcode: 'glm-5.3-flash', kimi: 'kimi-code/kimi-for-coding' };
export const BACKEND_NAMES = { codex: 'Codex', grok: 'Grok Build', zcode: 'ZCode', kimi: 'Kimi Code' };
export const STEER_DELIVERY = { codex: 'in-turn', grok: 'in-turn', zcode: 'in-turn', kimi: 'next-turn' };
export const JOBS_HOME_EXPR = '${RELAY_JOBS_HOME:-$HOME/.relay-jobs}';
// A woken wait delivers a steer in seconds, plus the relay's own model step, which once took 9 s;
// a wait the wake missed runs its 540 s bound. A continue first resumes the stopped relay.
export const LIMIT_SECONDS = { steer: 30, continue: 60 };

export function readTranscript(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new Error(`Invalid JSON at ${file}:${i + 1}`); }
  });
}

function content(entry) {
  return Array.isArray(entry?.message?.content) ? entry.message.content : [];
}

function textContent(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(block => block?.type === 'text' ? block.text ?? '' : '').join('\n') : '';
}

function hasLine(text, line) {
  return typeof text === 'string' && text.split('\n').some(value => value.replace(/[\t \r]+$/, '') === line);
}

export function claudeCodeVersionOf(entries) {
  return entries.find(entry => entry && !entry.isSidechain && entry.version)?.version ?? null;
}

export function leadModelOf(entries) {
  return entries.find(entry => entry && !entry.isSidechain && entry.type === 'assistant')?.message?.model ?? null;
}

export function hasMarker(entries, marker) {
  return entries.some(entry => entry && !entry.isSidechain && entry.type === 'assistant' &&
    content(entry).some(block => block?.type === 'text' && hasLine(block.text ?? '', marker)));
}

export function runSpan(entries, runId, marker) {
  const start = entries.findIndex(entry => entry && !entry.isSidechain && entry.type === 'user' &&
    hasLine(textContent(entry.message?.content), `Live suite run ${runId}.`));
  const finish = start < 0 ? null : entries.slice(start + 1).find(entry => hasMarker([entry], marker));
  return { startedAt: start < 0 ? null : entries[start].timestamp ?? null,
    finishedAt: finish?.timestamp ?? entries.findLast(entry => entry?.timestamp)?.timestamp ?? null };
}

export function formatSeconds(list) {
  const values = list.filter(Number.isFinite);
  if (!values.length) return '—';
  const low = Math.min(...values), high = Math.max(...values);
  return `${low.toFixed(1)}${low === high ? '' : `–${high.toFixed(1)}`} s`;
}

export function toolCalls(entries, sidechain = false) {
  const calls = new Map();
  for (const entry of entries) {
    if (!entry || Boolean(entry.isSidechain) !== sidechain) continue;
    for (const block of content(entry)) {
      if (block?.type !== 'tool_use') continue;
      // API progress snapshots repeat calls and often omit their timestamps.
      const key = block.id ?? `anonymous-${calls.size}`;
      if (!calls.has(key) || (!calls.get(key).timestamp && entry.timestamp)) {
        calls.set(key, { ...block, timestamp: entry.timestamp ?? null });
      }
    }
  }
  return [...calls.values()];
}

export function transcriptCalls(entries) {
  const calls = toolCalls(entries);
  const byId = new Map(calls.map(call => [call.id, call]));
  const names = new Map(), agents = new Map();
  for (const entry of entries) {
    if (!entry || entry.isSidechain) continue;
    for (const block of content(entry)) {
      if (block?.type !== 'tool_result') continue;
      const call = byId.get(block.tool_use_id);
      if (call?.name !== 'Agent' || call.input?.subagent_type !== 'relay:job') continue;
      const result = entry.toolUseResult;
      const agentId = result?.agentId ?? textContent(block.content).match(/\bagentId:\s*([\w.-]+)/)?.[1];
      if (typeof agentId !== 'string' || !agentId) continue;
      const input = call.input ?? {};
      for (const name of [input.name, result?.name, input.description, result?.description]) {
        if (name) names.set(name, agentId);
      }
      const prompt = input.prompt ?? result?.prompt ?? '';
      agents.set(agentId, { backend: prompt.match(/^backend:\s*(\S+)/m)?.[1] ?? 'codex',
        model: prompt.match(/^model:\s*(\S+)/m)?.[1] ?? null, name: input.name ?? null });
    }
  }
  return { calls, agents, names, sends: calls.filter(call => call.name === 'SendMessage').map(call => sendOf(call, names, agents)) };
}

function sendOf(call, names, agents, plugin = false) {
  const input = call.input ?? {};
  const recipient = input.to ?? input.recipient ?? null;
  const agentId = names.get(recipient) ?? recipient;
  return { toolUseId: call.id ?? null, recipient, agentId, message: plugin ? input.text ?? null : input.message ?? input.content ?? null,
    sentAt: call.timestamp, agent: agents.get(agentId) };
}

function readJson(file, optional = false) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
    return value;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path.basename(file)}: ${error.code ?? (error instanceof SyntaxError ? 'Invalid JSON.' : error.message)}`);
  }
}

export function readJob(jobDir) {
  const job = readJson(path.join(jobDir, 'job.json'));
  const binding = readJson(path.join(jobDir, 'relay.json'), true);
  return binding ? { ...job, relay: { ...job.relay, ...binding } } : job;
}

export function recordsFor(jobDir) {
  const dir = path.join(jobDir, 'inbox/relay');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const file = path.join(dir, name);
    const record = readJson(file);
    let message = record.text ?? record.message ?? null;
    if (message === null && typeof record.messageId === 'string') {
      const id = path.basename(record.messageId);
      const inbox = readJson(path.join(jobDir, 'inbox', `${id}.json`), true) ??
        readJson(path.join(jobDir, 'inbox/claimed', `${id}.json`), true);
      message = inbox?.text ?? null;
    }
    return { ...record, message, file };
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.file.localeCompare(b.file));
}

export function workflowTranscripts(transcript) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents/workflows');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(item => {
    const folder = path.join(dir, item.name);
    return fs.readdirSync(folder).filter(name => /^agent-.*\.jsonl$/.test(name)).map(name => path.join(folder, name));
  }).sort();
}

function activeAttempt(job, sentAt) {
  const sentMs = Date.parse(sentAt);
  return (Array.isArray(job.attempts) ? job.attempts : []).filter(item => item && Date.parse(item.startedAt) <= sentMs)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).at(-1);
}

export function analyzeCheck(input, { source = 'main', messages, kind = 'steer' }) {
  const details = [], evidence = { transcripts: [], agents: [] };
  const jobs = new Map();
  let parsed, sends = [], readError = null;
  const load = agentId => {
    if (typeof agentId !== 'string' || !agentId) throw new Error('Missing recipient.');
    const safeId = agentId.replace(/[^0-9A-Za-z._-]/g, '_');
    const pointerFile = path.resolve(input.jobsHome, 'relays', `${safeId}.json`);
    const pointer = readJson(pointerFile, true);
    if (typeof pointer?.jobDir !== 'string' || !pointer.jobDir) throw new Error('No relay pointer for the recipient.');
    const jobDir = path.resolve(input.jobsHome, pointer.jobDir);
    if (!evidence.agents.some(item => item.agentId === agentId)) evidence.agents.push({ agentId, pointer: pointerFile, jobDir });
    if (typeof pointer.transcriptPath === 'string') {
      const file = path.resolve(input.jobsHome, pointer.transcriptPath);
      if (fs.existsSync(file) && !evidence.transcripts.includes(file)) evidence.transcripts.push(file);
    }
    if (!jobs.has(jobDir)) jobs.set(jobDir, { job: readJob(jobDir), used: new Set(), jobDir });
    return jobs.get(jobDir);
  };
  try {
    const entries = readTranscript(input.transcript);
    evidence.transcripts.push(path.resolve(input.transcript));
    parsed = transcriptCalls(entries);
    if (source === 'workflow') {
      for (const file of workflowTranscripts(input.transcript)) {
        evidence.transcripts.push(path.resolve(file));
        sends.push(...toolCalls(readTranscript(file), true).filter(call => call.name === 'SendMessage')
          .map(call => ({ ...sendOf(call, parsed.names, parsed.agents), transcript: file })));
      }
    } else sends = source === 'plugin' ? parsed.calls.filter(call => call.name === 'mcp__wake-probe__send')
      .map(call => sendOf(call, parsed.names, parsed.agents, true)) : parsed.sends;
  } catch (error) {
    if (error.message.startsWith('Invalid JSON at ')) throw error;
    readError = `Cannot read transcript evidence: ${error.code ?? error.message}`;
  }
  for (const [agentId] of parsed?.agents ?? []) {
    try { load(agentId); } catch { /* The send below reports missing job evidence. */ }
  }
  for (const send of sends) {
    const row = { ...send, backend: send.agent?.backend ?? null, model: null, relayVersion: null,
      deliveredAt: null, deliveredSeconds: null, completedSeconds: null, delivery: null, pass: false };
    const prefix = kind === 'continue' ? 'continue-' : 'steer-';
    row.backend ??= input.backends.find(backend => send.recipient === `${prefix}${backend}`) ?? null;
    try {
      const loaded = load(send.agentId);
      const { job, used, jobDir } = loaded;
      row.jobDir = jobDir;
      row.backend ??= job.request?.backend ?? job.backend ?? null;
      const backend = row.backend;
      row.model = job.request?.model ?? job.model ?? null;
      row.relayVersion = activeAttempt(job, send.sentAt)?.relayVersion ?? null;
      loaded.ledger ??= recordsFor(jobDir);
      const candidates = loaded.ledger.filter(item => !used.has(item));
      const record = candidates.find(item => typeof send.message === 'string' && item.message === send.message) ??
        candidates.find(item => item.message === null);
      if (!record) throw new Error('No matching delivery record.');
      used.add(record);
      Object.assign(row, { deliveryRecord: record.file, kind: record.kind ?? null, status: record.status ?? null,
        matchedBy: record.message === null ? 'order' : 'text', deliveredAt: record.at ?? null });
      const sentMs = Date.parse(send.sentAt), deliveredMs = Date.parse(record.at);
      if (Number.isFinite(sentMs) && Number.isFinite(deliveredMs)) row.deliveredSeconds = (deliveredMs - sentMs) / 1000;
      let outcome = null, attempt = null;
      if (typeof record.messageId === 'string') {
        row.outcomeFile = path.join(jobDir, 'inbox/outcomes', `${path.basename(record.messageId)}.json`);
        outcome = readJson(row.outcomeFile, true);
      }
      row.outcome = outcome;
      row.delivery = outcome?.action === 'steered' ? 'in-turn' : outcome?.action === 'turn-started' ?
        (kind === 'continue' ? 'new-turn' : 'next-turn') : null;
      if (kind === 'continue') {
        attempt = outcome?.attempt == null ? null : (Array.isArray(job.attempts) ? job.attempts : []).find(item => item?.attempt === outcome.attempt);
        row.attempt = attempt ?? null;
        const endedMs = Date.parse(attempt?.endedAt);
        if (Number.isFinite(sentMs) && Number.isFinite(endedMs)) row.completedSeconds = (endedMs - sentMs) / 1000;
      }
      if (row.deliveredSeconds === null) throw new Error('Missing or invalid timestamp.');
      if (typeof send.message !== 'string') throw new Error('Missing message text.');
      if (record.kind !== kind) throw new Error(`Expected ${kind}, got ${record.kind ?? 'no kind'}.`);
      if (!['posting', 'done'].includes(record.status)) throw new Error(`Delivery status is ${record.status ?? 'missing'}.`);
      if (row.deliveredSeconds < 0) throw new Error('Delivery predates the send.');
      const limit = LIMIT_SECONDS[kind];
      if (row.deliveredSeconds > limit) throw new Error(`Delivery exceeded ${limit} seconds.`);
      if ((job.request?.backend ?? job.backend) !== backend) throw new Error(`Job backend does not match ${backend}.`);
      if (row.model !== MODELS[backend]) throw new Error(`Job model ${row.model ?? 'missing'} does not match ${MODELS[backend]}.`);
      if (!row.relayVersion || row.relayVersion !== input.relayVersion) throw new Error(`Attempt relayVersion ${row.relayVersion ?? 'missing'} does not match ${input.relayVersion}.`);
      if (!outcome) throw new Error('Missing delivery outcome.');
      if (kind === 'continue') {
        if (outcome.action !== 'turn-started') throw new Error(`Expected turn-started outcome, got ${outcome.action ?? 'no action'}.`);
        if (!attempt || attempt.state !== 'completed') throw new Error('The outcome attempt did not end completed.');
        if (row.completedSeconds === null || row.completedSeconds < row.deliveredSeconds) throw new Error('Missing or invalid completion timestamp.');
        let report;
        try { report = fs.readFileSync(path.join(jobDir, 'report.md'), 'utf8'); }
        catch { throw new Error('Cannot read report.md.'); }
        if (!hasLine(report, `second turn for ${backend}`)) throw new Error(`Report is missing the line second turn for ${backend}.`);
      } else if (row.delivery !== STEER_DELIVERY[backend]) {
        throw new Error(`Expected ${STEER_DELIVERY[backend]} delivery, got ${row.delivery ?? outcome.action ?? 'no action'}.`);
      }
      row.pass = true;
    } catch (error) { row.error = error.message; }
    details.push(row);
  }
  const results = input.backends.map(backend => {
    const rows = details.filter(row => row.backend === backend);
    const expected = messages(backend);
    const agentId = [...(parsed?.agents ?? [])].find(([, agent]) => agent.backend === backend)?.[0];
    const knownJob = evidence.agents.find(agent => agent.agentId === agentId);
    const job = knownJob ? jobs.get(knownJob.jobDir)?.job : null;
    let reason = readError;
    if (!reason) {
      for (const message of expected) {
        const count = rows.filter(row => row.message === message).length;
        if (count !== 1) { reason = `Send ${JSON.stringify(message)}: expected exactly one send, found ${count}.`; break; }
      }
    }
    if (!reason && rows.length !== expected.length) reason = `Expected ${expected.length} sends for ${backend}, found ${rows.length}.`;
    const failed = rows.find(row => !row.pass);
    if (!reason && failed) reason = `Send ${JSON.stringify(failed.message)}: ${failed.error}`;
    const deliveries = new Set(rows.map(row => row.delivery));
    const timings = {};
    const ordered = [...rows].sort((a, b) => expected.indexOf(a.message) - expected.indexOf(b.message));
    const delivered = ordered.map(row => row.deliveredSeconds).filter(Number.isFinite);
    const completed = ordered.map(row => row.completedSeconds).filter(Number.isFinite);
    if (delivered.length) timings.deliveredSeconds = delivered;
    if (kind === 'continue' && completed.length) timings.completedSeconds = completed;
    return { backend, model: rows.find(row => row.model)?.model ?? job?.request?.model ?? job?.model ?? MODELS[backend],
      relayVersion: rows.find(row => row.relayVersion)?.relayVersion ?? input.relayVersion,
      delivery: rows.length && deliveries.size === 1 ? rows[0].delivery : null,
      timings, result: reason ? 'fail' : 'pass', reason: reason ?? null };
  });
  return { results, details, evidence };
}
