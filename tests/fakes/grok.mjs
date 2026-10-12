import fs from "node:fs";
import path from "node:path";
import { writeExecutable } from "../support/helpers.mjs";
import { realHomeGuardSource } from "../support/isolate-env.mjs";
import { LEAVE_CHILD_SOURCE } from "./codex.mjs";

export function installFakeGrok(bin, options = {}) {
  const statePath = path.join(bin, "fake-grok-state.json");
  const binary = path.join(bin, "grok");
  writeExecutable(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const options = ${JSON.stringify(options)};
${LEAVE_CHILD_SOURCE}
${realHomeGuardSource("grok")}
const file = ${JSON.stringify(statePath)};
let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { starts: [], requests: [], turns: [], sessions: {} };
const save = () => { const temp = file + '.' + process.pid; fs.writeFileSync(temp, JSON.stringify(state)); fs.renameSync(temp, file); };
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let sessionId, active;
const note = (method, params) => send({ method, params: { sessionId, ...params } });
const update = value => note('session/update', { update: value });
// One line per invocation, appended: setup runs --version and models at once, and a shared
// read-modify-write of the state file would drop one of them.
fs.appendFileSync(file + '.invocations', JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GROK_'))) }) + '\\n');
if (process.argv[2] === '--version' && options.versionFail) { console.error('VERSION DENIED'); process.exit(9); }
if (process.argv[2] === '--version') { console.log('grok 1.0.fake'); process.exit(0); }
if (process.argv[2] === 'models' && options.modelsHangMs) { setTimeout(() => process.exit(0), options.modelsHangMs); return; }
if (process.argv[2] === 'models') { console.log(options.signedOut ? 'Not signed in' : 'You are logged in with grok.com.\\n\\nDefault model: grok-4.7\\n\\nAvailable models:\\n  * grok-4.7 (default)\\n  - grok-4.6'); process.exit(options.signedOut ? 1 : 0); }
state.starts.push({ args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GROK_'))), cwd: process.cwd() }); save();
if (options.sandboxFail && process.env.GROK_SANDBOX) { console.error('Refusing to start with its protections missing'); process.exit(1); }
const wrapper = text => 'The user sent a message while you were working:\\n<user_query>\\n' + text + '\\n</user_query>\\nComplete previous work.';
function persist(entry) {
  const cwd = state.cwds[sessionId];
  const dir = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(cwd), sessionId);
  refuseRealHome(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'chat_history.jsonl'), JSON.stringify(entry) + '\\n');
}
function replayUser(text, index) {
  if (options.splitReplay) {
    const cut = Math.floor(text.length / 2);
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: text.slice(0, cut) }, _meta: { promptIndex: index } });
    note('_x.ai/queue/changed', { entries: [] });
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: text.slice(cut) }, _meta: { promptIndex: index } });
  } else update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex: index } });
}
function finish(reason = 'end_turn') {
  if (!active) return;
  const turn = active; active = null; clearTimeout(turn.timer);
  if (reason === 'cancelled' && options.cancelWithQueuedEntries) {
    note('_x.ai/queue/changed', { entries: [{ id: 'queued', text: 'queued interjection' }], runningPromptId: turn.id, runningKind: 'prompt', runningText: turn.text });
  }
  if (reason === 'end_turn') {
    if (options.tools) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Preamble.' } }); update({ sessionUpdate: 'tool_call', toolCallId: 'tool1' }); }
    // answer (or FAKE_REVIEW_ANSWER): a fixed final message in place of the report, for the review tests.
    const answer = process.env.FAKE_REVIEW_ANSWER ?? options.answer;
    for (const text of answer != null ? [answer] : ['Report for: ', turn.text, ...turn.steers.map(s => '\\nSteered with: ' + s)]) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }
  if (reason !== 'cancelled') note('_x.ai/queue/changed', { entries: options.followup && !turn.followup ? [{ id: 'follow', text: 'follow' }] : [] });
  const complete = () => {
  state.completed = [...(state.completed || []), turn.id]; save();
  update({ sessionUpdate: 'turn_completed', prompt_id: turn.id, stop_reason: reason });
  note('_x.ai/session/prompt_complete', { promptId: turn.id, stopReason: reason });
  if (turn.rpcId) send({ id: turn.rpcId, result: { stopReason: reason, _meta: { promptId: turn.id } } });
  };
  if (options.completionDelayMs) setTimeout(complete, options.completionDelayMs); else complete();
  if (options.followup && !turn.followup) {
    setTimeout(() => {
      active = { id: 'follow', text: 'queued interjection', steers: [], followup: true };
      note('_x.ai/queue/changed', { entries: [], runningPromptId: 'follow', runningKind: 'prompt', runningText: active.text });
      active.timer = setTimeout(finish, 100);
    }, 50);
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); state.requests.push(m); save();
  const reply = result => send({ id: m.id, result });
  const error = (message, data) => send({ id: m.id, error: { code: -32602, message, data } });
  switch (m.method) {
    case 'initialize':
      if (options.dieInitialize) { sessionId = 'partial'; update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial before death' } }); setTimeout(() => process.exit(17), 30); break; }
      if (m.params?.protocolVersion !== 1) { error('Unsupported protocol version', { supported: [1], requested: m.params?.protocolVersion ?? null }); break; }
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } }); break;
    case 'session/new': sessionId = 'session-' + (Object.keys(state.sessions).length + 1); state.sessions[sessionId] = []; state.cwds = { ...state.cwds, [sessionId]: m.params.cwd }; save(); reply({ sessionId }); break;
    case 'session/load':
      sessionId = m.params.sessionId;
      for (const [index, turn] of (state.sessions[sessionId] || []).entries()) {
        replayUser(turn.text, index);
        if (options.replaySteers) for (const text of turn.steers || []) replayUser(wrapper(text), 'steer-' + index);
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
        update({ sessionUpdate: 'turn_completed', prompt_id: turn.id, stop_reason: 'end_turn' });
      }
      reply({}); break;
    case 'session/set_config_option': options.configError ? error('Invalid Grok config', { value: m.params.value }) : reply({}); break;
    case 'session/prompt': {
      const text = m.params.prompt[0].text;
      if (options.promptError) { error('Prompt rejected', { detail: 'capacity exhausted' }); break; }
      if (options.capacityPrompts && (state.capacityFailures || 0) < options.capacityPrompts) {
        state.capacityFailures = (state.capacityFailures || 0) + 1; state.rejected = [...(state.rejected || []), text]; save();
        // capacityWork: true is a tool call and its update; a list names the update kinds.
        const kinds = options.capacityWork === true ? ['tool_call', 'tool_call_update'] : (options.capacityWork || []);
        for (const kind of kinds) {
          const id = 'work-' + state.capacityFailures;
          update(kind === 'tool_call' ? { sessionUpdate: kind, toolCallId: id, title: 'append one record' }
            : kind === 'tool_call_update' ? { sessionUpdate: kind, toolCallId: id, status: 'completed' }
            : kind === 'plan' ? { sessionUpdate: kind, entries: [{ content: 'append one record', status: 'pending' }] }
            : kind === 'user_message_chunk' ? { sessionUpdate: kind, content: { type: 'text', text } }
            : { sessionUpdate: kind, content: { type: 'text', text: 'thinking' } });
        }
        error('Prompt rejected', { detail: 'capacity exhausted' });
        if (options.capacityExit && state.capacityFailures === 1) {
          leaveChild(options.capacityExit);
          setTimeout(() => process.exit(17), 10);
        }
        break;
      }
      const turn = { id: 'prompt-' + (state.turns.length + 1), text, steers: [], rpcId: m.id };
      state.turns.push({ id: turn.id, text }); state.sessions[sessionId].push({ id: turn.id, text, steers: [] }); save();
      persist({ type: 'user', content: [{ type: 'text', text: '<user_query>\\n' + text + '\\n</user_query>' }], prompt_index: state.turns.length - 1 });
      active = turn;
      if (options.dieBeforeId && state.turns.length === 1) { setTimeout(() => process.exit(17), 50); break; }
      const identify = () => { if (active === turn) note('_x.ai/queue/changed', { entries: [], runningPromptId: turn.id, runningKind: 'prompt', runningText: text.trim() }); };
      if (!options.noQueueId) { if (options.queueDelayMs) setTimeout(identify, options.queueDelayMs); else identify(); }
      if (options.earlyResponse) { reply({ stopReason: 'end_turn', _meta: { promptId: turn.id } }); turn.rpcId = null; }
      if (options.unsupported) send({ id: 'unknown', method: 'client/missing', params: { sessionId, question: 'unhandled' } });
      if (options.permission) send({ id: 'permission', method: 'session/request_permission', params: { sessionId, options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }] } });
      for (const [index, offered] of (options.permissionOptions || []).entries()) send({ id: 'permission-' + index, method: 'session/request_permission', params: { sessionId, options: offered } });
      if (options.die) { setTimeout(() => { console.error('fake server death'); process.exit(17); }, 80); break; }
      turn.timer = setTimeout(() => finish(options.stopReason), text.startsWith('[quick]') ? 30 : options.turnMs || 100);
      break;
    }
    case '_x.ai/interject':
      if (!active || options.steerError) { error('no turn running'); break; }
      const hold = (turn, text) => {
        turn.steers.push(text);
        state.sessions[sessionId].find(entry => entry.id === turn.id).steers.push(text); save();
        persist({ type: 'user', content: [{ type: 'text', text: wrapper(text) }], synthetic_reason: 'interjection' });
      };
      state.interjections = [...(state.interjections || []), { sessionId, text: m.params.text, promptId: active.id }]; save();
      // Grok can answer queued before it persists the interjection, or never persist it.
      // persistAfterReplyMs: one delay, or one per interjection in order; holdInterjections:
      // only that many interjections are ever held.
      const index = state.interjections.length - 1;
      const late = Array.isArray(options.persistAfterReplyMs) ? options.persistAfterReplyMs[index] : options.persistAfterReplyMs;
      const kept = options.holdInterjections == null || index < options.holdInterjections;
      if (late) { const turn = active, text = m.params.text; setTimeout(() => hold(turn, text), late); }
      else if (!options.interjectNotHeld && kept) hold(active, m.params.text);
      if (options.interjectDelayMs) setTimeout(() => reply({ result: { status: 'queued' } }), options.interjectDelayMs);
      else reply({ result: { status: 'queued' } });
      break;
    case 'session/cancel': finish('cancelled'); break;
    default: if (m.id !== undefined && m.method) error('unknown method');
  }
});
`);
  const state = () => {
    const recorded = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { starts: [], requests: [], turns: [], sessions: {} };
    const lines = fs.existsSync(`${statePath}.invocations`) ? fs.readFileSync(`${statePath}.invocations`, "utf8").split("\n").filter(Boolean) : [];
    return { ...recorded, invocations: lines.map(line => JSON.parse(line)) };
  };
  return { binary, state };
}
