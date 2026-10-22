#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const usage = `Usage: analyze-steer.mjs --jobs-home DIR --transcript FILE [--out FILE.jsonl] [--limit-seconds 10]
Measure SendMessage to inbox/relay arrival, using the ledger's at timestamp.
JSONL goes to --out or stdout; backend summaries go to stderr.
Exit 0 requires at least one send and every send passing.
`;

export function parseArgs(args) {
  const options = { limitSeconds: 10 };
  const names = { '--jobs-home': 'jobsHome', '--transcript': 'transcript', '--out': 'out', '--limit-seconds': 'limitSeconds' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const key = names[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    options[key] = key === 'limitSeconds' ? Number(value) : path.resolve(value);
  }
  if (!options.jobsHome || !options.transcript) throw new Error('--jobs-home and --transcript are required.');
  if (!Number.isFinite(options.limitSeconds) || options.limitSeconds <= 0) throw new Error('--limit-seconds must be positive.');
  if (options.out === options.transcript) throw new Error('--out must not overwrite the transcript.');
  return options;
}

export function readTranscript(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new Error(`Invalid JSON at ${file}:${i + 1}`); }
  });
}

function content(entry) {
  return Array.isArray(entry.message?.content) ? entry.message.content : [];
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(block => block.text ?? '').join('\n');
  return '';
}

export function transcriptCalls(entries) {
  const calls = new Map();
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    for (const block of content(entry)) {
      if (block.type !== 'tool_use' || !['Agent', 'SendMessage'].includes(block.name)) continue;
      // Progress snapshots can repeat a tool call without a timestamp.
      const key = block.id ?? `${calls.size}`;
      if (!calls.has(key) || (!calls.get(key).timestamp && entry.timestamp)) {
        calls.set(key, { ...block, timestamp: entry.timestamp ?? null });
      }
    }
  }
  const names = new Map();
  const agents = new Map();
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    for (const block of content(entry)) {
      if (block.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id);
      if (call?.name !== 'Agent') continue;
      const result = entry.toolUseResult;
      const agentId = result?.agentId ?? textContent(block.content).match(/\bagentId:\s*([\w.-]+)/)?.[1];
      if (!agentId) continue;
      const input = call.input ?? {};
      for (const name of [input.name, result?.name, input.description, result?.description]) {
        if (name) names.set(name, agentId);
      }
      const prompt = input.prompt ?? result?.prompt ?? '';
      agents.set(agentId, {
        backend: prompt.match(/^backend:\s*(\S+)/m)?.[1] ?? 'codex',
        model: prompt.match(/^model:\s*(\S+)/m)?.[1] ?? null,
        name: input.name ?? null
      });
    }
  }
  const sends = [...calls.values()].filter(call => call.name === 'SendMessage').map(call => {
    const input = call.input ?? {};
    const recipient = input.to ?? input.recipient ?? null;
    const agentId = names.get(recipient) ?? recipient;
    return { toolUseId: call.id, recipient, agentId, message: input.message ?? input.content ?? null,
      sentAt: call.timestamp, agent: agents.get(agentId) };
  });
  return { sends, agents, names };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

function recordsFor(jobDir) {
  const dir = path.join(jobDir, 'inbox/relay');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const file = path.join(dir, name);
    const record = readJson(file);
    let message = record.text ?? record.message ?? null;
    if (message === null && record.messageId) {
      const id = path.basename(record.messageId);
      const inbox = readJson(path.join(jobDir, 'inbox', `${id}.json`)) ??
        readJson(path.join(jobDir, 'inbox/claimed', `${id}.json`));
      message = inbox?.text ?? null;
    }
    return { ...record, message, file };
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.file.localeCompare(b.file));
}

export function analyze({ jobsHome, transcript, limitSeconds = 10, claudeCodeVersion }) {
  const { sends } = transcriptCalls(readTranscript(transcript));
  const jobs = new Map();
  const records = [];
  for (const send of sends) {
    const row = {
      backend: send.agent?.backend ?? 'unknown', model: send.agent?.model ?? null, relayVersion: null,
      claudeCodeVersion: claudeCodeVersion ?? null, surface: 'terminal', sentAt: send.sentAt,
      deliveredAt: null, latencySeconds: null, pass: false, recipient: send.recipient,
      agentId: send.agentId, toolUseId: send.toolUseId, message: send.message
    };
    try {
      if (typeof send.agentId !== 'string' || !send.agentId) throw new Error('Missing recipient.');
      const safeId = send.agentId.replace(/[^0-9A-Za-z._-]/g, '_');
      const pointer = readJson(path.join(jobsHome, 'relays', `${safeId}.json`));
      if (!pointer?.jobDir) throw new Error('No relay pointer for the recipient.');
      const jobDir = path.resolve(jobsHome, pointer.jobDir);
      row.jobDir = jobDir;
      if (!jobs.has(jobDir)) {
        const job = readJson(path.join(jobDir, 'job.json'));
        if (!job) throw new Error('Missing job.json.');
        jobs.set(jobDir, { job, ledger: recordsFor(jobDir), used: new Set() });
      }
      const { job, ledger, used } = jobs.get(jobDir);
      row.backend = job.request?.backend ?? job.backend ?? row.backend;
      row.model = job.request?.model ?? job.model ?? row.model;
      const sentMs = Date.parse(send.sentAt);
      const attempts = job.attempts ?? [];
      const attempt = attempts.filter(item => !item.startedAt || Date.parse(item.startedAt) <= sentMs).at(-1);
      row.relayVersion = attempt?.relayVersion ?? null;
      const candidates = ledger.filter(item => !used.has(item));
      // Prefer the text; fall back to chronological position only when the text is absent.
      const delivery = candidates.find(item => typeof send.message === 'string' && item.message === send.message) ??
        candidates.find(item => item.message === null);
      if (!delivery) throw new Error('No matching delivery record.');
      used.add(delivery);
      row.deliveryRecord = delivery.file;
      row.kind = delivery.kind ?? null;
      row.status = delivery.status ?? null;
      row.matchedBy = delivery.message === null ? 'order' : 'text';
      row.deliveredAt = delivery.at ?? null;
      const deliveredMs = Date.parse(delivery.at);
      if (!Number.isFinite(sentMs) || !Number.isFinite(deliveredMs)) throw new Error('Missing or invalid timestamp.');
      row.latencySeconds = (deliveredMs - sentMs) / 1000;
      if (typeof send.message !== 'string') throw new Error('Missing message text.');
      if (delivery.kind !== 'steer') throw new Error(`Expected steer, got ${delivery.kind ?? 'no kind'}.`);
      if (!['posting', 'done'].includes(delivery.status)) throw new Error(`Delivery status is ${delivery.status ?? 'missing'}.`);
      if (row.latencySeconds < 0) throw new Error('Delivery predates the send.');
      if (!row.relayVersion || !row.model || row.backend === 'unknown' || !row.claudeCodeVersion) {
        throw new Error('Missing version, backend or model evidence.');
      }
      row.pass = row.latencySeconds <= limitSeconds;
      if (!row.pass) row.error = `Delivery exceeded ${limitSeconds} seconds.`;
    } catch (error) { row.error = error.message; }
    records.push(row);
  }
  const backends = [...new Set(records.map(row => row.backend))];
  const summaries = backends.map(backend => {
    const rows = records.filter(row => row.backend === backend);
    return `${backend}: ${rows.filter(row => row.pass).length}/${rows.length} within ${limitSeconds} s`;
  });
  return { records, summaries, pass: records.length > 0 && records.every(row => row.pass) };
}

export function writeAnalysis(result, out) {
  const jsonl = result.records.map(row => JSON.stringify(row)).join('\n') + (result.records.length ? '\n' : '');
  if (out) fs.writeFileSync(out, jsonl); else process.stdout.write(jsonl);
  for (const summary of result.summaries) process.stderr.write(`${summary}\n`);
  if (!result.records.length) process.stderr.write('No SendMessage calls found.\n');
}

export function claudeVersion() {
  return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else {
      const result = analyze({ ...options, claudeCodeVersion: claudeVersion() });
      writeAnalysis(result, options.out);
      process.exitCode = result.pass ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
