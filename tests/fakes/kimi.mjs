import fs from "node:fs";
import path from "node:path";
import { writeExecutable } from "../support/helpers.mjs";
import { realHomeGuardSource } from "../support/isolate-env.mjs";

// A fake `kimi` built from the shapes Kimi Code 2.2.0 sent in live probes: `--version`,
// `provider list --json`, and `acp`, which answers ACP and keeps each session's record in
// `$KIMI_CODE_HOME/sessions/<bucket>/<id>/agents/main/wire.jsonl` as Kimi does. Like Kimi, it
// answers `end_turn` for a turn that failed (the record says `failed`), refuses a second prompt
// while a turn runs, reads a leading `/word` as a command, forgets the mode on a load, checks the
// sign-in when a session opens, and runs a prompt sent during a turn of its own after that turn.
// Such a prompt gets ACP's answer at once and nothing over ACP after it: no updates, and a cancel
// does not reach it. Only the record shows its turn; permission and file requests still come.
export function installFakeKimi(bin, options = {}) {
  const statePath = path.join(bin, "fake-kimi-state.json");
  const binary = path.join(bin, "kimi");
  writeExecutable(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const crypto = require('node:crypto');
const options = ${JSON.stringify(options)};
${realHomeGuardSource("kimi")}
const file = ${JSON.stringify(statePath)};
let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { starts: [], requests: [], answers: [], turns: [], sessions: {} };
const save = () => { const temp = file + '.' + process.pid; fs.writeFileSync(temp, JSON.stringify(state)); fs.renameSync(temp, file); };
const kimiEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('KIMI_')));
fs.appendFileSync(file + '.invocations', JSON.stringify({ args: process.argv.slice(2), env: kimiEnv() }) + '\\n');
const args = process.argv.slice(2);
if (args[0] === '--version' && options.versionFail) { console.error('VERSION DENIED'); process.exit(9); }
if (args[0] === '--version') { console.log('2.2.0-fake'); process.exit(0); }
const MODELS = {
  'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3', displayName: 'K3', supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
  'kimi-code/kimi-for-coding-highspeed': { provider: 'managed:kimi-code', model: 'kimi-for-coding-highspeed', displayName: 'K2.7 Code Highspeed' }
};
if (args[0] === 'provider' && args[1] === 'list') {
  if (options.providersHangMs) { setTimeout(() => process.exit(0), options.providersHangMs); return; }
  const providers = options.signedOut ? {} : { 'managed:kimi-code': { baseUrl: 'https://api.example.invalid/coding/v1', type: 'kimi', apiKey: 'FAKE-SECRET-KEY', oauth: { storage: 'file', key: 'oauth/kimi-code-env-fake', oauthHost: 'https://auth.example.invalid' } } };
  console.log(JSON.stringify({ providers, models: options.signedOut ? {} : MODELS }, null, 2));
  process.exit(0);
}
if (args[0] !== 'acp') { console.error('fake kimi: unsupported ' + args.join(' ')); process.exit(2); }
state.starts.push({ args, env: kimiEnv(), cwd: process.cwd(), pid: process.pid }); save();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const home = process.env.KIMI_CODE_HOME;
let sessionId, active = null, own = null, mode = 'default', model = 'kimi-code/k3', clientCaps = {}, reverseId = 0;
const pendingReverse = new Map();
const queued = [];
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const reverse = (method, params) => { const id = reverseId++; pendingReverse.set(id, method); send({ id, method, params: { sessionId, ...params } }); return id; };
const calls = new Map();
const call = (method, params) => new Promise((resolve, reject) => calls.set(reverse(method, params), { resolve, reject }));
// Kimi's AcpHostFileSystem: text reads and writes go to a client that declares them, and append,
// which ACP lacks, is a read and a write only when the client declares both.
const files = {
  async readText(file, options = {}) {
    if (!clientCaps.fs?.readTextFile) return fs.readFileSync(file, 'utf8');
    return (await call('fs/read_text_file', { path: file, ...options })).content;
  },
  async writeText(file, data) {
    if (!clientCaps.fs?.writeTextFile) { fs.writeFileSync(file, data); state.localWrites = (state.localWrites || 0) + 1; save(); return; }
    await call('fs/write_text_file', { path: file, content: data });
  },
  async appendText(file, data) {
    if (!clientCaps.fs?.readTextFile || !clientCaps.fs?.writeTextFile) { fs.appendFileSync(file, data); state.localWrites = (state.localWrites || 0) + 1; save(); return; }
    let existing = '';
    try { existing = await this.readText(file); } catch (error) { if (error.code !== -32002) throw error; }
    await this.writeText(file, existing + data);
  }
};
// A tool's file operation; a refusal is the tool's error, and the turn goes on.
async function fileOp([op, name, ...args]) {
  const file = path.join(process.cwd(), name);
  try {
    if (op === 'append') await files.appendText(file, args[0]);
    else if (op === 'write') await files.writeText(file, args[0]);
    else if (op === 'read') return { op, content: await files.readText(file, args[0]) };
    else if (op === 'edit') await files.writeText(file, (await files.readText(file)).replace(args[0], args[1]));
    return { op, ok: true };
  } catch (error) { return { op, error: error.message }; }
}
function wireOf(id) {
  const session = state.sessions[id];
  const dir = path.join(home, 'sessions', 'wd_' + path.basename(session.cwd) + '_' + crypto.createHash('sha256').update(session.cwd).digest('hex').slice(0, 12), id, 'agents', 'main');
  refuseRealHome(dir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'wire.jsonl');
}
const record = value => fs.appendFileSync(wireOf(sessionId), JSON.stringify({ ...value, time: Date.now() }) + '\\n');
const inputRecord = turn => record({ type: 'agent.message.appended', kind: 'event', message: { message: { role: 'user', content: turn.input }, meta: { source: 'input', promptId: turn.promptId, origin: { kind: 'user' } } } });
const promptRecords = (turn, origin) => {
  if (origin === 'user') inputRecord(turn);
  record({ type: 'agent.turn.started', kind: 'event', turnId: turn.turnId, queueItemId: turn.promptId });
  record({ type: 'turn.prompt', agentId: 'main', input: turn.input, origin: { kind: origin }, promptId: turn.promptId, turnId: turn.turnId });
};
const nextTurnId = () => { state.turnCounter = (state.turnCounter ?? 0) + 1; save(); return state.turnCounter - 1; };
function configOptions() {
  return [
    { type: 'select', id: 'model', currentValue: model, options: Object.keys(MODELS).map(value => ({ value })) },
    { type: 'select', id: 'mode', currentValue: mode, options: ['default', 'plan', 'auto', 'yolo'].map(value => ({ value })) }
  ];
}
function startTurn(turn, rpcId) {
  active = { ...turn, rpcId };
  state.turns.push({ text: turn.text, promptId: turn.promptId, turnId: turn.turnId, sessionId, mode }); save();
  promptRecords(turn, 'user');
  if (options.dieAfterRecord && state.turns.length === 1) { setTimeout(() => { console.error('fake kimi death'); process.exit(17); }, 50); return; }
  if (options.permission) reverse('session/request_permission', { options: [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' }, { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }], toolCall: { toolCallId: turn.turnId + ':tool_perm', title: 'Bash' } });
  for (const [index, offered] of (options.permissionOptions || []).entries()) reverse('session/request_permission', { options: offered, toolCall: { toolCallId: turn.turnId + ':tool_' + index, title: 'Bash' } });
  if (options.writes) {
    if (clientCaps.fs?.writeTextFile) reverse('fs/write_text_file', { path: path.join(process.cwd(), 'notes.txt'), content: 'x' });
    else { fs.writeFileSync(path.join(process.cwd(), 'notes.txt'), 'x'); state.localWrites = (state.localWrites || 0) + 1; save(); }
    if (clientCaps.terminal) reverse('terminal/create', { command: 'touch', args: ['touched.txt'], cwd: process.cwd() });
  }
  if (options.unsupported) reverse('client/missing', { question: 'unhandled' });
  // Kimi runs a shell command in a session of its own, as its child.
  if (options.shellChild && !state.descendants) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    state.descendants = [{ appServerPid: process.pid, childPid: child.pid }]; save();
  }
  // Kimi's ACP layer sends a turn's updates only to the prompt it drives.
  const tracked = value => { if (rpcId !== null) update(value); };
  tracked({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  if (options.tools) {
    tracked({ sessionUpdate: 'tool_call', toolCallId: turn.turnId + ':tool_1', title: 'Bash', kind: 'execute', status: 'pending' });
    for (let i = 0; i < 3; i++) tracked({ sessionUpdate: 'tool_call_update', toolCallId: turn.turnId + ':tool_1', status: 'in_progress' });
    tracked({ sessionUpdate: 'tool_call_update', toolCallId: turn.turnId + ':tool_1', status: 'completed' });
    record({ type: 'agent.message.appended', kind: 'event', message: { message: { role: 'assistant', content: [{ type: 'text', text: 'Before the tool. ' }], toolCalls: [] } } });
    record({ type: 'agent.message.appended', kind: 'event', message: { message: { role: 'assistant', content: [{ type: 'text', text: 'Preamble.' }], toolCalls: [{ id: 'tool_1', name: 'Bash' }] } } });
    record({ type: 'agent.message.appended', kind: 'event', message: { message: { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCallId: 'tool_1' } } });
  }
  if (options.die) { setTimeout(() => { console.error('fake kimi death'); process.exit(17); }, 80); return; }
  const ms = turn.text.startsWith('[quick]') ? 30 : turn.text.startsWith('[long]') ? 30000 : options.turnMs || 100;
  const schedule = () => { if (active?.turnId === turn.turnId) active.timer = setTimeout(() => finish(options.failTurn ? 'failed' : 'completed'), ms); };
  // The file operations run in the first turn that reaches them, not again after a recovery.
  if (!options.fileOps || state.fileOpsRan) return schedule();
  state.fileOpsRan = true; save();
  (async () => {
    const results = [];
    for (const op of options.fileOps) results.push(await fileOp(op));
    state.fileOps = [...(state.fileOps || []), ...results]; save();
    schedule();
  })();
}
function finish(reason) {
  if (!active) return;
  const turn = active; active = null; clearTimeout(turn.timer);
  if (reason === 'completed') {
    const answer = process.env.FAKE_REVIEW_ANSWER ?? options.answer ?? 'Report for: ' + turn.text;
    if (turn.rpcId !== null) for (const text of [answer.slice(0, 3), answer.slice(3)]) if (text) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    record({ type: 'agent.message.appended', kind: 'event', message: { message: { role: 'assistant', content: [{ type: 'think', think: 'x' }, { type: 'text', text: answer }], toolCalls: [] } } });
  }
  if (reason === 'cancelled') record({ type: 'turn.cancel', agentId: 'main', turnId: turn.turnId, target: 'active', reason: 'user_cancelled' });
  const error = reason === 'failed' ? options.failError ?? { code: 'provider.connection_error', message: 'Connection error.', name: 'APIConnectionError', retryable: true } : undefined;
  record({ type: 'agent.turn.ended', kind: 'event', turnId: turn.turnId, outcome: reason === 'completed' ? 'done' : reason });
  record({ type: 'turn.ended', agentId: 'main', turnId: turn.turnId, reason, ...(error ? { error } : {}) });
  if (reason !== 'cancelled') record({ type: 'prompt.completed', agentId: 'main', promptId: turn.promptId, reason });
  state.completed = [...(state.completed || []), { text: turn.text, reason }]; save();
  // Kimi starts a turn of its own as it goes idle, before ACP's answer reaches the client.
  if (options.ownTurnAfterMs && !state.ownTurnRan) { state.ownTurnRan = true; save(); if (options.ownTurnAfterMs <= 1) ownTurn(); else setTimeout(ownTurn, options.ownTurnAfterMs); }
  // Kimi's ACP layer answers end_turn for a failed turn.
  if (turn.rpcId !== null) send({ id: turn.rpcId, result: { stopReason: reason === 'cancelled' ? 'cancelled' : 'end_turn' } });
}
// A turn Kimi starts on its own (a background task finished): only the record shows it.
function ownTurn() {
  // Kimi runs a turn of its own only when idle; during a turn the notice joins that turn.
  if (active) return setTimeout(ownTurn, 10);
  const turnId = nextTurnId();
  own = { turnId };
  const input = [{ type: 'text', text: '<notification id="task:bash-1:completed">done</notification>' }];
  record({ type: 'agent.turn.started', kind: 'event', turnId });
  record({ type: 'turn.prompt', agentId: 'main', input, origin: { kind: 'task' }, turnId });
  record({ type: 'agent.message.appended', kind: 'event', message: { message: { role: 'assistant', content: [{ type: 'text', text: 'The background task finished.' }], toolCalls: [] } } });
  // It runs ownTurnMs once a prompt has queued behind it, however late the prompt comes, so a
  // test always has its queued prompt; with none after 10 s, it ends.
  const startedAt = Date.now();
  const hold = () => {
    if (own.queuedAt === undefined && Date.now() - startedAt < 10000) return setTimeout(hold, 10);
    setTimeout(end, Math.max(0, (own.queuedAt ?? Date.now()) + (options.ownTurnMs || 400) - Date.now()));
  };
  const end = () => {
    record({ type: 'agent.turn.ended', kind: 'event', turnId, outcome: 'done' });
    record({ type: 'turn.ended', agentId: 'main', turnId, reason: 'completed' });
    own = null;
    // The hand-off runs Kimi's prompt hooks before the queued prompt is committed: it can pause.
    const next = queued.shift();
    // A UserPromptSubmit hook that blocks: the message stays in Kimi's context, and no turn runs.
    if (next && options.blockQueued) {
      record({ type: 'context.append_message', agentId: 'main', message: { role: 'user', content: next.input, id: next.promptId, toolCalls: [], origin: { kind: 'user' } } });
      record({ type: 'prompt.completed', agentId: 'main', promptId: next.promptId, reason: 'blocked' });
      state.blocked = (state.blocked || 0) + 1; save();
    } else if (next) setTimeout(() => startTurn(next, null), options.handoffMs || 0);
  };
  hold();
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); state.requests.push(m); save();
  if (m.id !== undefined && !m.method) {
    state.answers.push({ id: m.id, method: pendingReverse.get(m.id), result: m.result, error: m.error }); save();
    const waiting = calls.get(m.id);
    calls.delete(m.id);
    if (waiting) m.error ? waiting.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : waiting.resolve(m.result);
    return;
  }
  const reply = result => send({ id: m.id, result });
  const error = (code, message, data) => send({ id: m.id, error: data === undefined ? { code, message } : { code, message, data } });
  switch (m.method) {
    case 'initialize':
      if (options.dieInitialize) { setTimeout(() => process.exit(17), 30); break; }
      clientCaps = m.params?.clientCapabilities ?? {};
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {} }, mcpCapabilities: { http: true, sse: true }, auth: { logout: {} } }, authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Kimi account', args: ['--login'] }], agentInfo: { name: 'Kimi Code CLI', version: '2.2.0-fake' } });
      break;
    case 'session/new':
      // Kimi checks the sign-in before it creates or loads a session.
      if (options.authError) { error(-32000, 'Authentication required'); break; }
      sessionId = 'session_fake-' + (Object.keys(state.sessions).length + 1);
      state.sessions[sessionId] = { cwd: m.params.cwd, mcpServers: m.params.mcpServers }; save();
      record({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() });
      mode = 'default';
      reply({ sessionId, configOptions: configOptions(), modes: { currentModeId: mode } });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
      break;
    case 'session/load': {
      if (options.authError) { error(-32000, 'Authentication required'); break; }
      if (!state.sessions[m.params.sessionId]) { error(-32602, 'Invalid params: Unknown sessionId: ' + m.params.sessionId); break; }
      sessionId = m.params.sessionId;
      for (const turn of state.turns.filter(entry => entry.sessionId === sessionId)) update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: turn.text } });
      mode = 'default';
      reply({ configOptions: configOptions(), modes: { currentModeId: mode } });
      break;
    }
    case 'session/set_mode':
      if (!['default', 'plan', 'auto', 'yolo'].includes(m.params.modeId)) { error(-32602, 'Invalid params: Unknown modeId: ' + m.params.modeId); break; }
      mode = m.params.modeId; reply({}); break;
    case 'session/set_config_option':
      if (m.params.configId === 'model') {
        if (!MODELS[m.params.value]) { error(-32603, 'Internal error', { details: 'Model "' + m.params.value + '" is not configured in config.toml.' }); break; }
        model = m.params.value; reply({ configOptions: configOptions() }); break;
      }
      if (m.params.configId === 'thinking') {
        const efforts = MODELS[model].supportEfforts ?? ['on', 'max'];
        if (!efforts.includes(m.params.value)) { error(-32602, 'Invalid params: Unknown thinking value: ' + m.params.value, { configId: 'thinking', value: m.params.value }); break; }
        reply({ configOptions: configOptions() }); break;
      }
      error(-32602, 'Invalid params: Unknown configId: ' + m.params.configId); break;
    case 'session/prompt': {
      if (active) { error(-32600, 'Invalid request: another turn is already in progress', { code: 'turn.agent_busy' }); state.busyRefusals = (state.busyRefusals || 0) + 1; save(); break; }
      const blocks = m.params.prompt;
      const first = blocks[0];
      if (first?.type === 'text' && first.text.startsWith('/')) {
        const name = first.text.slice(1).trim().split(' ')[0];
        if (name && !name.includes('/')) { state.commands = [...(state.commands || []), name]; save(); update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Unknown ACP command: /' + name + '. Use /help to see available commands.' } }); reply({ stopReason: 'end_turn' }); break; }
      }
      // Prompts in the order they arrive, over every process; true means the first.
      state.prompts = (state.prompts || 0) + 1; save();
      const nth = value => value === true ? 1 : value;
      // Kimi answers and never records it: every prompt for true, or only the one numbered.
      if (options.noRecord === true || (options.noRecord && state.prompts === options.noRecord)) { reply({ stopReason: 'end_turn' }); break; }
      // The process dies before Kimi records the prompt: it never reached the session.
      if (options.dieBeforeRecord && state.prompts === nth(options.dieBeforeRecord)) { setTimeout(() => { console.error('fake kimi death'); process.exit(17); }, 30); break; }
      const text = blocks.filter(part => part.type === 'text').map(part => part.text).join('');
      // Kimi puts its UserPromptSubmit hooks' text in front of the prompt's own parts.
      const input = options.hookText ? [{ type: 'text', text: options.hookText, meta: { contentType: 'text/xml', source: 'user prompt submit hook' } }, ...blocks] : blocks;
      const turn = { text, input, promptId: 'msg_fake' + state.prompts, turnId: nextTurnId() };
      // The process dies after Kimi committed the input, before any turn started for it.
      if (options.dieAfterInput && state.prompts === nth(options.dieAfterInput)) { inputRecord(turn); setTimeout(() => { console.error('fake kimi death'); process.exit(17); }, 30); break; }
      // The engine queues a prompt sent during a turn of its own, and ACP answers at once.
      if (own) { own.queuedAt ??= Date.now(); queued.push(turn); state.queuedBehindOwn = (state.queuedBehindOwn || 0) + 1; save(); reply({ stopReason: 'end_turn' }); break; }
      // The prompt is recorded only once the test has created this file, at once if it already
      // has, and then state.recorded names it. A slow machine can let the test create the file
      // between this prompt's request being saved and the first look for it.
      if (options.recordAfter) {
        const recordWhenReleased = () => {
          if (!fs.existsSync(options.recordAfter)) { setTimeout(recordWhenReleased, 10); return; }
          startTurn(turn, m.id);
          state.recorded = turn.promptId; save();
        };
        recordWhenReleased();
        break;
      }
      startTurn(turn, m.id);
      break;
    }
    // ACP cancels only the prompt it drives: not one it answered early, nor a turn of Kimi's own.
    case 'session/cancel': if (active && active.rpcId !== null) finish('cancelled'); else { state.cancelsUnheard = (state.cancelsUnheard || 0) + 1; save(); } break;
    default: if (m.id !== undefined && m.method) error(-32601, 'Method not found');
  }
});
`);
  const state = () => {
    const recorded = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { starts: [], requests: [], answers: [], turns: [], sessions: {} };
    const lines = fs.existsSync(`${statePath}.invocations`) ? fs.readFileSync(`${statePath}.invocations`, "utf8").split("\n").filter(Boolean) : [];
    return { ...recorded, invocations: lines.map(line => JSON.parse(line)) };
  };
  return { binary, state };
}

// A home signed in the way `kimi login` leaves it: the credentials file setup looks for.
export function signInFakeKimiHome(home) {
  const dir = path.join(home, "credentials");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kimi-code-env-fake.json"), JSON.stringify({ access_token: "fake", refresh_token: "fake" }));
  fs.writeFileSync(path.join(home, "config.toml"), 'default_model = "kimi-code/k3"\n\n[thinking]\nenabled = true\neffort = "high"\n');
}
