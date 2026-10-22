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
  return Array.isArray(value) ? value.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : '';
}

export function promptText(entry) {
  const text = textContent(entry?.message?.content).replace(/^(?:[\t ]*\r?\n)*/, '');
  // Unwrap only Claude's whole-message paste envelope, never a quotation with outside text.
  const pasted = text.match(/^<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*)\r?\n<\/pasted_content id="\1">(?:\r?\n)?$/);
  return pasted ? pasted[2].replace(/^(?:[\t ]*\r?\n)*/, '') : text;
}

export function runLine(runId) {
  return `Live suite run ${runId}.`;
}

export function scopeToRun(entries, runId) {
  const isRun = entry => entry && !entry.isSidechain && entry.type === 'user';
  const firstLine = entry => promptText(entry).split('\n')[0];
  const start = entries.findIndex(entry => isRun(entry) && firstLine(entry) === runLine(runId));
  if (start < 0) return [];
  const next = entries.findIndex((entry, index) => index > start && isRun(entry) && /^Live suite run \S+\.$/.test(firstLine(entry)));
  return entries.slice(start, next < 0 ? undefined : next);
}

function hasLine(text, line) {
  return typeof text === 'string' && text.split('\n').some(value => value.replace(/[\t \r]+$/, '') === line);
}

// A backend's model writes the requested line in its own way ("Second turn for zcode.", in a live
// run); the words decide, not their case or a closing full stop.
function hasReportLine(text, line) {
  const words = value => value.trim().replace(/[.!]+$/, '').toLowerCase();
  return typeof text === 'string' && text.split('\n').some(value => words(value) === words(line));
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
    promptText(entry).split('\n')[0] === runLine(runId));
  const finish = start < 0 ? null : entries.slice(start + 1).find(entry => hasMarker([entry], marker));
  return { startedAt: start < 0 ? null : entries[start].timestamp ?? null,
    finishedAt: finish?.timestamp ?? entries.findLast(entry => entry?.timestamp)?.timestamp ?? null };
}

export function formatSeconds(list) {
  const values = list.filter(Number.isFinite);
  if (!values.length) return '—';
  const low = Math.min(...values), high = Math.max(...values);
  return `${low.toFixed(1)}${low.toFixed(1) === high.toFixed(1) ? '' : `–${high.toFixed(1)}`} s`;
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
  const names = new Map(), agents = new Map(), spawns = [], seenSpawns = new Set();
  for (const entry of entries) {
    if (!entry || entry.isSidechain) continue;
    for (const block of content(entry)) {
      if (block?.type !== 'tool_result') continue;
      const call = byId.get(block.tool_use_id);
      if (block.is_error || call?.name !== 'Agent' || call.input?.subagent_type !== 'relay:job') continue;
      const result = entry.toolUseResult;
      const agentId = result?.agentId ?? textContent(block.content).match(/\bagentId:\s*([\w.-]+)/)?.[1];
      if (typeof agentId !== 'string' || !agentId) continue;
      if (seenSpawns.has(call.id)) continue;
      seenSpawns.add(call.id);
      const input = call.input ?? {};
      for (const name of [input.name, result?.name, input.description, result?.description]) {
        if (name) names.set(name, agentId);
      }
      const prompt = input.prompt ?? result?.prompt ?? '';
      const agent = { backend: prompt.match(/^backend:\s*(\S+)/m)?.[1] ?? 'codex',
        model: prompt.match(/^model:\s*(\S+)/m)?.[1] ?? null, name: input.name ?? result?.name ?? null };
      agents.set(agentId, agent);
      spawns.push({ ...agent, agentId, toolUseId: call.id });
    }
  }
  return { calls, agents, names, spawns, sends: calls.filter(call => call.name === 'SendMessage').map(call => sendOf(call, names, agents)) };
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

function toolResults(entries, sidechain = false) {
  const results = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'user' || Boolean(entry.isSidechain) !== sidechain) continue;
    for (const block of content(entry)) {
      if (block?.type === 'tool_result') results.set(block.tool_use_id, { ...block, result: entry.toolUseResult });
    }
  }
  return results;
}

export function workflowTranscripts(transcript, entries = []) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents/workflows');
  if (!fs.existsSync(dir)) return [];
  const results = toolResults(entries), runs = new Set();
  for (const call of toolCalls(entries).filter(call => call.name === 'Workflow')) {
    const result = results.get(call.id);
    if (!result || result.is_error) continue;
    const runId = result.result?.runId ?? textContent(result.content).match(/^Run ID:\s*([\w.-]+)\s*$/m)?.[1];
    if (typeof runId === 'string' && /^[\w-][\w.-]*$/.test(runId)) runs.add(runId);
  }
  return [...runs].flatMap(runId => {
    const folder = path.join(dir, runId);
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(name => /^agent-.*\.jsonl$/.test(name)).map(name => path.join(folder, name));
  }).sort();
}

function activeAttempt(job, sentAt) {
  const sentMs = Date.parse(sentAt);
  return (Array.isArray(job.attempts) ? job.attempts : []).filter(item => item && Date.parse(item.startedAt) <= sentMs)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).at(-1);
}

function relayTranscriptPath(input, job, pointer) {
  const binding = typeof job.relay?.transcriptPath === 'string' ? path.resolve(input.jobsHome, job.relay.transcriptPath) : null;
  const pointed = typeof pointer.transcriptPath === 'string' ? path.resolve(input.jobsHome, pointer.transcriptPath) : null;
  const sessionDir = path.dirname(path.resolve(input.transcript));
  const inSession = file => file && !path.relative(sessionDir, file).startsWith('..') && !path.isAbsolute(path.relative(sessionDir, file));
  // Evidence copies rewrite pointers; older copies retain the original binding in job.json.
  if (inSession(pointed) && !inSession(binding)) return pointed;
  return binding ?? pointed;
}

function requireVersion(attempt, version, label = 'Attempt') {
  if (!attempt?.relayVersion || attempt.relayVersion !== version) {
    throw new Error(`${label} relayVersion ${attempt?.relayVersion ?? 'missing'} does not match ${version}.`);
  }
}

function requireSenderResult(send, source) {
  if (source === 'main') return;
  const result = send.senderResult;
  if (!result || result.is_error) throw new Error(`Missing or failed ${source} sender tool result.`);
  const text = textContent(result.content);
  if (source === 'plugin') {
    if (!/(?:^|\s)delivered=true(?:\s|$)/.test(text)) throw new Error('Probe tool result did not report delivered=true.');
  } else {
    let value;
    try { value = JSON.parse(text); } catch { /* A non-JSON reply is not a successful SendMessage result. */ }
    if (value?.success !== true) throw new Error('Workflow SendMessage tool result did not report success.');
  }
}

function deliveryEntry(entries, record) {
  const uuid = path.basename(record.file, '.json');
  const entry = entries.find(entry => entry?.uuid === uuid);
  if (!entry) throw new Error(`No relay transcript entry with ledger uuid ${uuid}.`);
  return entry;
}

function deliveryText(entry, source, kind) {
  if (kind === 'continue') {
    if (entry?.type !== 'user') return null;
    const text = textContent(entry.message?.content);
    const lead = 'The coordinator sent a message while you were working:\n';
    const tail = '\n\nAddress this before completing your current task.';
    return text.startsWith(lead) && text.endsWith(tail) ? text.slice(lead.length, -tail.length) : null;
  }
  if (entry?.type !== 'attachment' || entry.attachment?.type !== 'queued_command') return null;
  return source === 'workflow' ? entry.attachment.origin?.body ?? null : entry.attachment.prompt ?? null;
}

function requireOrigin(entries, record, send, source, kind) {
  const entry = deliveryEntry(entries, record);
  const origin = kind === 'continue' && entry.type === 'user' ? entry.origin :
    entry.type === 'attachment' && entry.attachment?.type === 'queued_command' ? entry.attachment.origin : null;
  const matches = source === 'workflow' ? origin?.kind === 'peer' && origin.from === send.senderAgentId :
    origin?.kind === 'coordinator' && (source === 'plugin' ? origin.plugin === 'wake-probe' : !Object.hasOwn(origin, 'plugin'));
  if (!matches) throw new Error(`Relay transcript origin does not match the ${source} sender.`);
  if (deliveryText(entry, source, kind) !== send.message) throw new Error('Relay transcript text does not match the send.');
}

export function analyzeCheck(input, { source = 'main', messages, kind = 'steer', scope = scopeToRun }) {
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
    if (!jobs.has(jobDir)) {
      const job = readJob(jobDir), transcript = relayTranscriptPath(input, job, pointer);
      if (transcript && fs.existsSync(transcript) && !evidence.transcripts.includes(transcript)) evidence.transcripts.push(transcript);
      jobs.set(jobDir, { job, used: new Set(), jobDir, transcript });
    }
    return jobs.get(jobDir);
  };
  try {
    const entries = scope(readTranscript(input.transcript), input.runId);
    evidence.transcripts.push(path.resolve(input.transcript));
    parsed = transcriptCalls(entries);
    if (source === 'workflow') {
      for (const file of workflowTranscripts(input.transcript, entries)) {
        evidence.transcripts.push(path.resolve(file));
        const workflowEntries = readTranscript(file), results = toolResults(workflowEntries, true);
        sends.push(...toolCalls(workflowEntries, true).filter(call => call.name === 'SendMessage')
          .map(call => ({ ...sendOf(call, parsed.names, parsed.agents), transcript: file, senderResult: results.get(call.id),
            senderAgentId: workflowEntries.find(entry => entry?.isSidechain && entry.agentId &&
              content(entry).some(block => block?.type === 'tool_use' && block.id === call.id))?.agentId ??
              workflowEntries.find(entry => entry?.isSidechain && entry.agentId)?.agentId ?? path.basename(file, '.jsonl').slice(6) })));
      }
    } else {
      const results = toolResults(entries);
      sends = source === 'plugin' ? parsed.calls.filter(call => call.name === 'mcp__wake-probe__send')
        .map(call => ({ ...sendOf(call, parsed.names, parsed.agents, true), senderResult: results.get(call.id) })) : parsed.sends;
    }
  } catch (error) {
    if (error.message.startsWith('Invalid JSON at ')) throw error;
    readError = `Cannot read transcript evidence: ${error.code ?? error.message}`;
  }
  for (const [agentId] of parsed?.agents ?? []) {
    try { load(agentId); } catch { /* The send below reports missing job evidence. */ }
  }
  for (const send of sends) {
    const row = { ...send, backend: input.backends.find(backend => messages(backend).includes(send.message)) ?? send.agent?.backend ?? null, model: null, relayVersion: null,
      deliveredAt: null, deliveredSeconds: null, readAt: null, readSeconds: null, completedSeconds: null, delivery: null, pass: false };
    const prefix = kind === 'continue' ? 'continue-' : 'steer-';
    row.backend ??= input.backends.find(backend => send.recipient === `${prefix}${backend}`) ?? null;
    try {
      if (!send.agent) throw new Error(`Recipient was not spawned in this run: ${send.agentId ?? 'missing'}.`);
      const spawned = parsed.spawns.filter(agent => agent.backend === row.backend);
      if (spawned.length === 1 && send.agentId !== spawned[0].agentId) {
        throw new Error(`Send targets relay ${send.agentId}, not ${row.backend}'s relay ${spawned[0].agentId}.`);
      }
      const loaded = load(send.agentId);
      const { job, used, jobDir } = loaded;
      row.jobDir = jobDir;
      row.backend ??= job.request?.backend ?? job.backend ?? null;
      const backend = row.backend;
      row.model = job.request?.model ?? job.model ?? null;
      const active = activeAttempt(job, send.sentAt);
      row.relayVersion = active?.relayVersion ?? null;
      loaded.ledger ??= recordsFor(jobDir);
      if (!loaded.transcript || !fs.existsSync(loaded.transcript)) throw new Error('Missing relay transcript.');
      loaded.entries ??= readTranscript(loaded.transcript);
      const candidates = loaded.ledger.filter(item => !used.has(item));
      const record = candidates.find(item => typeof send.message === 'string' &&
        (item.message === null || item.message === send.message) &&
        deliveryText(loaded.entries.find(entry => entry?.uuid === path.basename(item.file, '.json')), source, kind) === send.message);
      if (!record) {
        // A known ledger text can explain the failure, but can never substitute for the entry's text.
        const known = candidates.find(item => typeof send.message === 'string' && item.message === send.message);
        if (known) requireOrigin(loaded.entries, known, send, source, kind);
        throw new Error('No matching delivery record with the send text in the relay transcript.');
      }
      used.add(record);
      Object.assign(row, { deliveryRecord: record.file, kind: record.kind ?? null, status: record.status ?? null,
        matchedBy: 'text', deliveredAt: record.postedAt ?? null, readAt: record.at ?? null });
      const sentMs = Date.parse(send.sentAt), deliveredMs = Date.parse(record.postedAt), readMs = Date.parse(record.at);
      if (Number.isFinite(sentMs) && Number.isFinite(deliveredMs)) row.deliveredSeconds = (deliveredMs - sentMs) / 1000;
      if (Number.isFinite(sentMs) && Number.isFinite(readMs)) row.readSeconds = (readMs - sentMs) / 1000;
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
      if (row.deliveredSeconds === null || row.readSeconds === null) throw new Error('Missing or invalid send, at or postedAt timestamp.');
      if (typeof send.message !== 'string') throw new Error('Missing message text.');
      if (record.kind !== kind) throw new Error(`Expected ${kind}, got ${record.kind ?? 'no kind'}.`);
      if (record.status !== 'done') throw new Error(`Delivery status is ${record.status ?? 'missing'}.`);
      if (row.deliveredSeconds < 0 || row.readSeconds < 0) throw new Error('Delivery predates the send.');
      const limit = LIMIT_SECONDS[kind];
      if (row.deliveredSeconds > limit) throw new Error(`Delivery exceeded ${limit} seconds.`);
      if ((job.request?.backend ?? job.backend) !== backend) throw new Error(`Job backend does not match ${backend}.`);
      if (row.model !== MODELS[backend]) throw new Error(`Job model ${row.model ?? 'missing'} does not match ${MODELS[backend]}.`);
      requireVersion(active, input.relayVersion);
      if (!outcome) throw new Error('Missing delivery outcome.');
      if (outcome.messageId !== record.messageId) throw new Error('Outcome messageId does not match the delivery record.');
      requireSenderResult(send, source);
      requireOrigin(loaded.entries, record, send, source, kind);
      if (kind === 'continue') {
        if (active.state !== 'completed' || !(Date.parse(active.endedAt) <= sentMs)) {
          throw new Error('The attempt before the send had not ended completed.');
        }
        let handbacks;
        try { handbacks = readTranscript(path.join(jobDir, 'relay-handbacks.jsonl')); }
        catch { throw new Error('Cannot read relay-handbacks.jsonl.'); }
        if (!handbacks.some(entry => Date.parse(entry?.at) <= sentMs)) throw new Error('No hand-back at or before the send.');
        if (outcome.action !== 'turn-started') throw new Error(`Expected turn-started outcome, got ${outcome.action ?? 'no action'}.`);
        if (!attempt || attempt.state !== 'completed') throw new Error('The outcome attempt did not end completed.');
        if (!(attempt.attempt > active.attempt)) throw new Error('The outcome attempt is not later than the attempt before the send.');
        if (!(Date.parse(attempt.startedAt) >= sentMs)) throw new Error('The outcome attempt started before the send or has no valid start.');
        requireVersion(attempt, input.relayVersion, 'Outcome attempt');
        if (attempt.messageId != null && attempt.messageId !== record.messageId) throw new Error('Outcome attempt messageId does not match the delivery record.');
        if (row.completedSeconds === null || row.completedSeconds < row.deliveredSeconds) throw new Error('Missing or invalid completion timestamp.');
        const latest = Math.max(...job.attempts.map(item => item?.attempt).filter(Number.isFinite));
        const reportFile = attempt.attempt === latest ? 'report.md' : `attempts/${attempt.attempt}-report.md`;
        let report;
        try { report = fs.readFileSync(path.join(jobDir, reportFile), 'utf8'); }
        catch { throw new Error(`Cannot read ${reportFile}.`); }
        if (!hasReportLine(report, `second turn for ${backend}`)) throw new Error(`Report is missing the line second turn for ${backend}.`);
      } else {
        if (!(active.endedAt == null || Date.parse(active.endedAt) > sentMs)) throw new Error('The attempt active at the send was not running.');
        if (row.delivery !== STEER_DELIVERY[backend]) {
          throw new Error(`Expected ${STEER_DELIVERY[backend]} delivery, got ${row.delivery ?? outcome.action ?? 'no action'}.`);
        }
        if (row.delivery === 'in-turn') {
          if (outcome.turnId != null && active.turnId != null && outcome.turnId !== active.turnId) throw new Error('Outcome turnId does not match the active attempt.');
          const target = outcome.attempt == null ? active : job.attempts.find(item => item?.attempt === outcome.attempt);
          if (target !== active) throw new Error('In-turn outcome attempt does not match the active attempt.');
          requireVersion(target, input.relayVersion, 'Outcome attempt');
        } else {
          const target = job.attempts.find(item => item?.attempt === outcome.attempt);
          if (!target || !(target.attempt > active.attempt)) throw new Error('Next-turn outcome does not name a later attempt.');
          if (!(Date.parse(target.startedAt) >= Date.parse(active.endedAt))) throw new Error('Next-turn attempt started before the active attempt ended.');
          requireVersion(target, input.relayVersion, 'Outcome attempt');
          if (!job.messages?.some(item => item?.id === record.messageId && item.action === 'queued-next-turn')) {
            throw new Error('No queued-next-turn job message for this message id.');
          }
        }
      }
      row.pass = true;
    } catch (error) { row.error = error.message; }
    details.push(row);
  }
  const results = input.backends.map(backend => {
    const rows = details.filter(row => row.backend === backend);
    const expected = messages(backend);
    const spawned = (parsed?.spawns ?? []).filter(agent => agent.backend === backend);
    const agentId = spawned[0]?.agentId;
    const knownJob = evidence.agents.find(agent => agent.agentId === agentId);
    const job = knownJob ? jobs.get(knownJob.jobDir)?.job : null;
    const unassigned = details.find(row => !row.backend && !row.pass);
    let reason = readError ?? (unassigned ? `Send ${JSON.stringify(unassigned.message)}: ${unassigned.error}` : null);
    if (!reason && spawned.length !== 1) {
      reason = `Expected exactly one relay for ${backend}, found ${spawned.length}${spawned.length ? ` (${spawned.map(agent => agent.agentId).join(', ')})` : ''}.`;
    }
    const name = `${kind === 'continue' ? 'continue' : 'steer'}-${backend}`;
    if (!reason && spawned[0].name !== name) reason = `Relay ${agentId} is named ${JSON.stringify(spawned[0].name)}, expected ${name}.`;
    if (!reason) {
      for (const message of expected) {
        const count = rows.filter(row => row.message === message).length;
        if (count !== 1) { reason = `Send ${JSON.stringify(message)}: expected exactly one send, found ${count}.`; break; }
      }
    }
    if (!reason && rows.length !== expected.length) reason = `Expected ${expected.length} sends for ${backend}, found ${rows.length}.`;
    if (!reason && new Set(rows.map(row => row.jobDir).filter(Boolean)).size > 1) reason = `Sends for ${backend} reached different jobs.`;
    const failed = rows.find(row => !row.pass);
    if (!reason && failed) reason = `Send ${JSON.stringify(failed.message)}: ${failed.error}`;
    const deliveries = new Set(rows.map(row => row.delivery));
    const timings = {};
    const ordered = [...rows].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || expected.indexOf(a.message) - expected.indexOf(b.message));
    const delivered = ordered.map(row => row.deliveredSeconds).filter(Number.isFinite);
    const read = ordered.map(row => row.readSeconds).filter(Number.isFinite);
    const completed = ordered.map(row => row.completedSeconds).filter(Number.isFinite);
    if (delivered.length) timings.deliveredSeconds = delivered;
    if (read.length) timings.readSeconds = read;
    if (kind === 'continue' && completed.length) timings.completedSeconds = completed;
    return { backend, model: rows.find(row => row.model)?.model ?? job?.request?.model ?? job?.model ?? MODELS[backend],
      relayVersion: rows.find(row => row.relayVersion)?.relayVersion ?? input.relayVersion,
      delivery: rows.length && deliveries.size === 1 ? rows[0].delivery : null,
      timings, result: reason ? 'fail' : 'pass', reason: reason ?? null };
  });
  return { results, details, evidence };
}

function commandInput(entry) {
  if (!entry || entry.isSidechain || !(entry.type === 'user' ||
      (entry.type === 'system' && entry.subtype === 'local_command'))) return null;
  const text = entry.type === 'system' ? entry.content : textContent(entry.message?.content);
  const match = typeof text === 'string' && text.match(/^<command-name>\/([^<\n]+)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>$/);
  return match ? { command: match[1], args: match[2] } : null;
}

function commandBoundary(entry) {
  if (!entry || entry.isSidechain) return false;
  if (commandInput(entry)) return true;
  const text = textContent(entry.message?.content);
  if (text.includes('<task-notification>')) return true;
  if (entry.type === 'attachment' && /task[_-]notification/.test(entry.attachment?.type ?? '')) return true;
  return entry.type === 'user' && !entry.isMeta && Boolean(text) && !text.startsWith('<local-command-caveat>');
}

export function noModelReply(entries, command) {
  return Boolean(command.answer && command.plugin === 'relay' &&
    !entries.slice(command.inputIndex + 1, command.endIndex).some(entry => !entry.isSidechain &&
      entry.type === 'assistant' && entry.message?.model !== '<synthetic>'));
}

export function commandRuns(entries, run = {}) {
  const commands = [];
  let previousAnswer = -1;
  for (let i = 0; i < entries.length; i++) {
    const input = commandInput(entries[i]);
    if (!input) continue;
    let endIndex = entries.findIndex((entry, index) => index > i && commandBoundary(entry));
    if (endIndex < 0) endIndex = entries.length;
    // Claude Code 2.1.308 records a command a plugin answered without its arguments, in the input
    // entry and in `commandRun` alike, so the answer is matched by the command's name; a check reads
    // which job a command reached from its output.
    const answerIndex = entries.findIndex((entry, index) => index > i && index < endIndex && !entry.isSidechain &&
      entry.type === 'system' && entry.subtype === 'local_command' && entry.commandRun?.command === input.command);
    const answer = answerIndex < 0 ? null : entries[answerIndex];
    const enqueue = entries.slice(previousAnswer + 1, i).findLast(entry => !entry.isSidechain &&
      entry.type === 'queue-operation' && entry.operation === 'enqueue');
    const sent = run.commands?.[commands.length];
    const startedAt = sent?.sentAt ?? enqueue?.timestamp ?? null;
    const answeredAt = answer?.timestamp ?? null;
    const seconds = (Date.parse(answeredAt) - Date.parse(startedAt)) / 1000;
    const row = { ...input, input: entries[i], inputIndex: i, endIndex, answer,
      plugin: answer?.commandRun?.plugin ?? null,
      text: answer?.content?.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/)?.[1] ?? null,
      startedAt, answeredAt, seconds: Number.isFinite(seconds) ? seconds : null };
    row.noModelReply = noModelReply(entries, row);
    commands.push(row);
    if (answer) previousAnswer = answerIndex;
  }
  return commands;
}

export function moduleText(text) {
  if (typeof text !== 'string') return null;
  text = text.replace(/^relay: /, '');
  const opening = text.match(/^\n(`{3,})text\n/);
  if (!opening) return null;
  const fence = opening[1], rest = text.slice(opening[0].length);
  const end = rest.indexOf(`\n${fence}\n`);
  if (end < 0) return null;
  const verbatim = rest.slice(0, end + 1), tail = rest.slice(end + fence.length + 2);
  if ((verbatim.match(/`+/g) ?? []).some(run => run.length >= fence.length)) return null;
  if (tail && !tail.startsWith('---\n')) return null;
  return { verbatim, report: tail ? tail.slice(4) : null };
}

export function statusRows(verbatim) {
  const cells = line => {
    if (!line.startsWith('|') || !line.endsWith('|')) return null;
    return line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  };
  const lines = verbatim.split('\n');
  const start = lines.findIndex(line => cells(line)?.[0] === 'job');
  if (start < 0) return [];
  const header = cells(lines[start]), separator = cells(lines[start + 1] ?? '');
  if (!separator || separator.length !== header.length || !separator.every(cell => /^-+$/.test(cell))) return [];
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    const values = cells(line);
    if (!values || values.length !== header.length) break;
    rows.push(Object.fromEntries(header.map((key, index) => [key, values[index]])));
  }
  return rows;
}
