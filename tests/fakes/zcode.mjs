import fs from "node:fs";
import path from "node:path";
import { writeExecutable } from "../support/helpers.mjs";
import { READY_SOURCE } from "../support/backend-ready.mjs";

// A fake `zcode app-server`: NDJSON `{id, method, params}`, v4 commands, the session
// subscription's `session/event` notifications, reverse requests, and a command store and
// session history that outlive the process, as ZCode's do. As in ZCode 3.14.4, the
// subscription's snapshot lists only the session's current model, and the snapshots of
// `session/create` and `session/resume` list every model the sign-in serves (`options.models`).
export function installFakeZcode(bin, options = {}) {
  const statePath = path.join(bin, "fake-zcode-state.json");
  const binary = path.join(bin, "zcode");
  // The fake's source is the template literal below, built here: a backtick or ${ in it must be
  // escaped (\` and \${), or it ends the string or interpolates this process's values. The
  // ${...} already in it are deliberate.
  writeExecutable(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${JSON.stringify(options)};
const file = ${JSON.stringify(statePath)};
let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { invocations: [], starts: [], requests: [], replies: [], sessions: {}, commands: {}, turns: [], inputs: [] };
const save = () => { const temp = file + '.' + process.pid; fs.writeFileSync(temp, JSON.stringify(state)); fs.renameSync(temp, file); };
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
state.invocations.push({ args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ZCODE_'))) }); save();
if (process.argv[2] === '--version') { if (options.versionFail) { console.error('VERSION DENIED'); process.exit(9); } console.log('zcode-app-cli 9.9.9\\nzcode-runtime 0.0.fake'); process.exit(0); }
state.starts.push({ args: process.argv.slice(2), pid: process.pid, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ZCODE_'))) }); save();
// stubborn: the server ignores SIGTERM and leaves a child that ignores it too, in its group.
if (options.stubborn) {
  process.on('SIGTERM', () => {});
  const kid = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  state.children = [...(state.children || []), kid.pid]; save();
}
// The server says it runs once its start is recorded and, if stubborn, its handler and child are in
// place (tests/support/backend-ready.mjs).
${READY_SOURCE}
let sessionId = null, active = null, seq = 0, serverIds = 0, drafts = 0;
const provider = options.provider ?? 'account:fake-plan';
const current = { providerId: provider, modelId: 'GLM-5.3', options: { reasoningLevel: 'max' } };
const levels = ['low', 'high', 'max'].map(value => ({ value, label: value }));
const every = (options.models ?? ['GLM-5.3', 'GLM-5.3-Flash']).map(modelId => ({ ref: { providerId: provider, modelId }, label: modelId, providerLabel: 'Fake Plan', reasoning: { levels, defaultLevel: 'max' } }));
const settings = list => ({ model: { available: list, current } });
const queue = [];
const waiting = new Map();
const requestClient = (method, params) => new Promise(resolve => { const id = 'server-' + (++serverIds); waiting.set(id, resolve); send({ id, method, params }); });
const event = (type, turnId, payload) => send({ method: 'session/event', params: { sessionId, turnId, type, payload, seq: ++seq, eventId: 'event-' + seq, timestamp: Date.now(), deliveryKind: 'desktop-continuous' } });
const history = () => state.sessions[sessionId].messages;
// Real ZCode keeps a new session in memory until its first message is admitted.
const promote = () => { if (state.sessions[sessionId].draft) { state.sessions[sessionId].draft = false; save(); } };
function startTurn(input) {
  history().push({ commandId: input.commandId, text: input.text }); save();
  const turnId = 'turn-' + (state.turns.length + 1);
  state.turns.push({ turnId, text: input.text, commandId: input.commandId }); save();
  const turn = active = { turnId, input, steers: [] };
  event('turn.started', turnId, { turnNumber: state.turns.length - 1, input: input.text, inputId: input.commandId });
  send({ method: 'v4/telemetry/event', params: { kind: 'noise' } });
  event('model.streaming', turnId, { delta: 'x', kind: 'text_delta' });
  event('tool.updated', turnId, { toolCallId: 'tool-1', toolName: 'Bash', kind: 'started' });
  event('tool.updated', turnId, { toolCallId: 'tool-1', toolName: 'Bash', kind: 'progress', elapsedMs: 1 });
  if (options.die && state.turns.length <= (options.dieTurns ?? 1)) { setTimeout(() => { console.error('fake zcode death'); process.exit(17); }, 60); return; }
  // ZCode's tools wait for the client's reply to each request they send: the turn ends only once
  // every reply is in and recorded.
  const asked = [];
  for (const toolName of options.permissions ?? []) {
    asked.push(requestClient('interaction/requestPermission', { requestId: 'perm-' + toolName, sessionId, turnId, toolCallId: 'call-' + toolName, toolName, reason: 'side effects', riskLevel: 'high', input: {},
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow', reason: 'Approved once' } }, { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] })
      .then(reply => { state.replies.push({ method: 'interaction/requestPermission', toolName, reply }); save(); }));
  }
  if (options.userInput) asked.push(requestClient('interaction/requestUserInput', { requestId: 'question-1', sessionId, prompt: 'Which?' }).then(reply => { state.replies.push({ method: 'interaction/requestUserInput', reply }); save(); }));
  if (options.mcpAuth) asked.push(requestClient('interaction/requestOfficialMcpAuthHeaders', { mcpKey: 'web_reader', requestId: 'official-mcp-auth:1', targetOrigin: 'https://example.invalid', workspace: {} }).then(reply => { state.replies.push({ method: 'interaction/requestOfficialMcpAuthHeaders', reply }); save(); }));
  if (options.unsupported) asked.push(requestClient('client/missing', { sessionId }).then(reply => { state.replies.push({ method: 'client/missing', reply }); save(); }));
  if (options.browser) asked.push(requestClient('interaction/browserList', { sessionId }).then(reply => { state.replies.push({ method: 'interaction/browserList', reply }); save(); }));
  // steered: the test steers this turn. The turn ends only once the guide is in (drained, held, or
  // queued for the next turn), however late it comes, so a slow steer never meets an idle server.
  if (options.steered && !input.text.startsWith('[quick]')) asked.push(new Promise(resolve => { turn.guided = resolve; }));
  turn.timer = setTimeout(() => Promise.all(asked).then(() => { if (active === turn) finish(options.resultType ?? 'success'); }), input.text.startsWith('[quick]') ? 30 : input.text.startsWith('[long]') ? 30000 : options.turnMs ?? 100);
}
function finish(resultType) {
  const turn = active;
  if (!turn) return;
  active = null; clearTimeout(turn.timer);
  const capacity = options.capacityOnce && !state.capacityFailed;
  if (capacity) { state.capacityFailed = true; save(); }
  if (capacity && resultType !== 'cancelled') event('turn.failed', turn.turnId, { error: { type: 'provider_error', code: 'overloaded', message: 'Model is overloaded: at capacity' }, turnPhase: 'model', inputId: turn.input.commandId });
  else if (options.failTurn && resultType !== 'cancelled') event('turn.failed', turn.turnId, { error: { type: 'unknown_error', code: 'model_not_found', message: options.failTurn, underlyingErrorMessage: options.failUnderlying ?? options.failTurn }, turnPhase: 'model', inputId: turn.input.commandId });
  // answer (or FAKE_REVIEW_ANSWER): a fixed final message in place of the report, for the review tests.
  else event('turn.completed', turn.turnId, { response: resultType === 'cancelled' ? '' : (process.env.FAKE_REVIEW_ANSWER ?? options.answer) != null ? (process.env.FAKE_REVIEW_ANSWER ?? options.answer) : ['Report for: ' + turn.input.text, ...turn.steers.map(text => 'Steered with: ' + text)].join('\\n'), resultType, inputId: turn.input.commandId, tokenCount: 1, toolCallCount: 0, duration: 1 });
  setTimeout(() => { if (!active && queue.length) startTurn(queue.shift()); }, 20);
}
function sendText(m, envelope) {
  const payload = envelope.payload;
  const input = { commandId: envelope.commandId, text: payload.text };
  state.inputs.push({ commandId: envelope.commandId, delivery: payload.requestedDelivery, modelSelection: payload.modelSelection, mode: payload.mode, toolDisallowlist: payload.toolDisallowlist, heldQueueDisposition: payload.heldQueueDisposition, active: Boolean(active) }); save();
  // A stop with queued input holds the queue, durably: ZCode then needs a disposition.
  if (state.sessions[sessionId].heldQueue?.length) {
    if (!payload.heldQueueDisposition) { send({ id: m.id, result: { commandId: envelope.commandId, status: 'failed', reasonCode: 'heldQueueDispositionRequired', message: 'held queue requires heldQueueDisposition (clearQueueAndSend | keepQueueAndSend)', revisionAtDecision: 1 } }); return; }
    if (payload.heldQueueDisposition === 'clearQueueAndSend') { state.sessions[sessionId].heldQueue = []; state.held = []; save(); }
  }
  const admit = () => { state.commands[sessionId + ':' + envelope.commandId] = { status: 'accepted', process: process.pid }; promote(); save(); };
  const ack = delivery => { admit(); send({ id: m.id, result: { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 1, result: { type: 'inputAccepted', delivery, inputId: envelope.commandId } } }); };
  if (options.rejectSend) { send({ id: m.id, result: { commandId: envelope.commandId, status: 'rejected', reasonCode: 'proto.fake', message: 'fake refusal', revisionAtDecision: 1 } }); return; }
  if (options.dieBeforeFirstSend && !state.diedBeforeSend) { state.diedBeforeSend = true; save(); console.error('fake zcode died before admission'); process.exit(17); }
  if (options.dieAfterAdmit && !state.diedAfterAdmit) { state.diedAfterAdmit = true; admit(); console.error('fake zcode died after admission'); process.exit(17); }
  if (!active) { ack('startNow'); startTurn(input); return; }
  if (payload.requestedDelivery === 'guide' && options.guideHold) { ack('queue'); state.held = [...(state.held || []), input.commandId]; save(); active.guided?.(); return; }
  if (payload.requestedDelivery === 'guide' && !options.guideMiss) {
    ack('queue');
    event('turn.steerQueued', active.turnId, { pendingInputId: 'queue_' + input.commandId, inputId: input.commandId, input: input.text, inputPreview: input.text, inputSize: input.text.length, delivery: 'guide', targetTurnId: active.turnId, queueLength: 1 });
    const turn = active;
    setTimeout(() => {
      if (active !== turn) { queue.push(input); return; }
      turn.steers.push(input.text); history().push({ commandId: input.commandId, text: input.text }); save();
      const source = options.drainIds ?? 'both';
      event('turn.steerDrained', turn.turnId, { pendingInputIds: source === 'drained' ? [] : ['queue_' + input.commandId], targetTurnId: turn.turnId, injectedMessageIds: ['msg-steer'], ...(source === 'pending' ? {} : { drainedInputs: [{ pendingInputId: 'queue_' + input.commandId, messageId: 'msg-steer', text: input.text, delivery: 'guide', intent: { sourceCommandId: input.commandId } }] }) });
      turn.guided?.();
    }, 10);
    return;
  }
  if (payload.requestedDelivery === 'startNow') { finish('cancelled'); clearTimeout(active?.timer); ack('startNow'); setTimeout(() => startTurn(input), 5); return; }
  ack('queue');
  queue.push(input);
  active.guided?.();
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { state.requests.push(m); save(); const resolve = waiting.get(m.id); waiting.delete(m.id); resolve?.(m.result ?? { error: m.error }); return; }
  state.requests.push(m); save();
  const reply = result => send({ id: m.id, result });
  const error = (message, code = -32602) => send({ id: m.id, error: { code, message } });
  switch (m.method) {
    case 'runtime/capabilities': if (options.dieInitialize) { console.error('fake zcode refused to start'); process.exit(19); } reply({ independentPlanState: true }); break;
    case 'v4/command': {
      const envelope = m.params;
      const key = (envelope.sessionId ?? 'global') + ':' + envelope.commandId;
      const known = state.commands[key];
      if (known) {
        // Admitted by an earlier process but never in the session: discarded on restart.
        const discarded = known.process !== process.pid && !Object.values(state.sessions).some(entry => entry.messages.some(message => message.commandId === envelope.commandId));
        reply(discarded ? { commandId: envelope.commandId, status: 'failed', reasonCode: 'fault.command.inputDiscardedOnRestart', message: 'Input was discarded when the CLI restarted; confirm before resending.', revisionAtDecision: 0 } : { commandId: envelope.commandId, status: 'duplicate', revisionAtDecision: 0 });
        break;
      }
      if (envelope.type === 'createSession') {
        if (options.rejectCreate) { reply({ commandId: envelope.commandId, status: 'failed', reasonCode: 'fault.command.executionFailed', message: 'fake create refusal', revisionAtDecision: 0, result: { type: 'createSession', sessionId: 'sess_refused' } }); break; }
        const id = 'sess_' + (Object.keys(state.sessions).length + 1);
        requestClient('session/requestRuntimePreferences', { sessionId: id, scope: 'runtime-materialization' }).then(preferences => {
          sessionId = id; state.sessions[id] = { messages: [], cwd: envelope.payload.workspaceId, config: envelope.payload.config, preferences, draft: true, process: process.pid }; save();
          const result = { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0, result: { type: 'createSession', sessionId: id } };
          state.commands[key] = { ...result, process: process.pid }; save(); reply(result);
        });
      } else if (envelope.type === 'sendText') sendText(m, envelope);
      else if (envelope.type === 'stop') {
        const result = { commandId: envelope.commandId, status: active ? 'accepted' : 'noop', revisionAtDecision: 1 };
        state.commands[key] = { ...result, process: process.pid };
        if (state.held?.length) state.sessions[sessionId].heldQueue = [...state.held];
        save(); reply(result); finish('cancelled');
      }
      else error('unknown command');
      break;
    }
    case 'session/subscribe':
      if (m.params.deliveryKind !== 'desktop-continuous' && m.params.deliveryKind !== 'web-remote-replayable') { error('Invalid params — deliveryKind'); break; }
      reply({ sessionId: m.params.sessionId, eventSeq: seq, events: [], ...(m.params.includeSnapshot ? { snapshot: { settings: settings(every.filter(entry => entry.ref.modelId === current.modelId)) } } : {}) });
      break;
    case 'session/create': {
      // A draft (\`persistence: "deferred"\`) stays in this process until its first message.
      if (options.createFail) { error(options.createFail, -32603); break; }
      const id = 'draft_' + (++drafts);
      requestClient('session/requestRuntimePreferences', { sessionId: id, scope: 'runtime-materialization' }).then(preferences => {
        state.drafts = { ...(state.drafts || {}), [id]: { persistence: m.params.persistence, preferences, open: true } }; save();
        // createAnswer: 'no-settings' leaves the model list out of the snapshot.
        setTimeout(() => reply({ session: { sessionId: id }, messages: [], ...(options.createAnswer === 'no-settings' ? {} : { settings: settings(every) }) }), options.createHangMs ?? 0);
      });
      break;
    }
    case 'session/close': {
      // closeAnswer: 'refuse' answers closed: false, 'error' an RPC error, 'silent' nothing.
      if (options.closeAnswer === 'silent') break;
      if (options.closeAnswer === 'error') { error('CLOSE FAILED', -32603); break; }
      if (options.closeAnswer === 'refuse') { reply({ closed: false }); break; }
      const draft = state.drafts?.[m.params.sessionId];
      if (draft) { draft.open = false; save(); }
      reply({ closed: Boolean(draft) && (m.params.expectedPersistence === undefined || m.params.expectedPersistence === draft.persistence) });
      break;
    }
    case 'session/resume': {
      const stored = state.sessions[m.params.sessionId];
      // listSilent: the model-list read of a new session (a draft of this process) gets no answer.
      if (options.listSilent && stored?.draft && stored.process === process.pid) break;
      if (!stored || (stored.draft && stored.process !== process.pid)) { error('Session not found: ' + m.params.sessionId, -32004); break; }
      sessionId = m.params.sessionId;
      const intent = commandId => options.historyShape === 'conversation' ? { conversationInputIntent: { sourceCommandId: commandId } } : { inputIntent: { sourceCommandId: commandId } };
      reply({ messages: history().map(entry => ({ info: { role: 'user', metadata: intent(entry.commandId) }, parts: [{ type: 'text', text: entry.text }] })), settings: settings(every) });
      break;
    }
    default: if (m.id !== undefined) error('unknown method', -32601);
  }
});
`);
  return { binary, state: () => JSON.parse(fs.readFileSync(statePath, "utf8")) };
}
