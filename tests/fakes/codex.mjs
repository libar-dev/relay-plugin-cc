import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "../support/helpers.mjs";
import { realHomeGuardSource } from "../support/isolate-env.mjs";
import { READY_SOURCE } from "../support/backend-ready.mjs";

// Source of `leaveChild(spec)`, shared by the fake servers. Only these fakes let a
// child inherit the server's stdout or stderr. Real backends capture tool output.
export const LEAVE_CHILD_SOURCE = `function leaveChild(spec) {
  const code = "setTimeout(() => {}, " + spec.holdStdoutMs + ");";
  require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: spec.pipes === "stderr" ? ["ignore", "ignore", 2] : ["ignore", 1, 2] }).unref();
}`;

export function installFakeCodex(binDir, behavior = "review-ok", options = {}) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const turnMs = options.turnMs ?? 3000;
  const capacityFailures = options.capacityFailures ?? 2;
  const capacityError = options.capacityError ?? {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
    additionalDetails: null
  };
  // Items the failing turn emits before its capacity error, and an exit while a child
  // still holds stdout, for the capacity-retry and transport tests.
  const capacityWork = options.capacityWork ?? [];
  const capacityExit = options.capacityExit ?? null;
  // Where the capacity-work items appear: item/started, item/completed, the failed turn's items.
  const capacityWorkVia = options.capacityWorkVia ?? ["started", "completed"];
  const scriptPath = path.join(binDir, "codex");
  // The fake's source is the template literal below, built here: a backtick or ${ in it must be
  // escaped (\` and \${), or it ends the string or interpolates this process's values. The
  // ${...} already in it are deliberate.
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");
${realHomeGuardSource("codex")}
${READY_SOURCE}

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const TURN_MS = Number(process.env.FAKE_CODEX_TURN_MS) || ${JSON.stringify(turnMs)};
	const CAPACITY_FAILURES = ${JSON.stringify(capacityFailures)};
	const CAPACITY_ERROR = ${JSON.stringify(capacityError)};
	const CAPACITY_WORK = ${JSON.stringify(capacityWork)};
	const CAPACITY_EXIT = ${JSON.stringify(capacityExit)};
	const CAPACITY_WORK_VIA = ${JSON.stringify(capacityWorkVia)};
	${LEAVE_CHILD_SOURCE}
	const interruptibleTurns = new Map();
	// Turns of the job behaviors that are still running: turnId -> { threadId, prompt, steers, timer }.
	const activeTurns = new Map();
	// turn-order-steer-*: whether the steer has come, and the thread/read requests held until it does.
	let steerArrived = false;
	const readsAwaitingSteer = [];
	// turn-order-collab-read-race: the thread/read replies held until the steer has come.
	const repliesAwaitingSteer = [];

	function loadState() {
	  for (let attempt = 0; attempt < 20; attempt += 1) {
	    if (!fs.existsSync(STATE_PATH)) {
	      break;
	    }
	    try {
	      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	    } catch {
	      // Another fake app-server is renaming the file in; read again.
	    }
	  }
	  return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	}

function saveState(state) {
  const tmp = STATE_PATH + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function record(key, value) {
  const state = loadState();
  state[key] = [...(state[key] || []), value];
  saveState(state);
}

function hasLoneSurrogate(text) {
  return /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?:^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/.test(text);
}

function firstLine(text) {
  return String(text || "").split(/\\r?\\n/).map((line) => line.trim()).find(Boolean) || "";
}

const JOB_BEHAVIORS = new Set(["job", "job-no-turn-id", "job-exit-before-complete", "job-capacity", "job-hang", "job-steer-late", "job-child", "job-hang-child"]);

// Client message ids that reached each thread, so thread/resume can return them as
// userMessage items like the real app-server does.
function recordDelivered(threadId, clientId) {
  if (!clientId) {
    return;
  }
  const state = loadState();
  state.delivered = state.delivered || {};
  state.delivered[threadId] = [...(state.delivered[threadId] || []), clientId];
  saveState(state);
}

function deliveredTurns(threadId) {
  const ids = (loadState().delivered || {})[threadId] || [];
  return ids.map((clientId, index) => ({ id: "past_" + index, status: "completed", error: null, items: [{ type: "userMessage", id: "um_" + index, clientId, content: [] }] }));
}

function spawnDescendant(turnId) {
  // A command that leaves the process group, like a daemonizing tool would.
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  record("descendants", { turnId, appServerPid: process.pid, childPid: child.pid });
}

function finishJobTurn(turnId, status) {
  const turn = activeTurns.get(turnId);
  if (!turn) {
    return;
  }
  activeTurns.delete(turnId);
  clearTimeout(turn.timer);
  if (status === "completed") {
    const text = "Report for: " + firstLine(turn.prompt) + (turn.steers.length ? "\\nSteered with: " + turn.steers.join(" | ") : "");
    send({ method: "item/completed", params: { threadId: turn.threadId, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text, phase: "final_answer" } } });
  }
  send({ method: "turn/completed", params: { threadId: turn.threadId, turn: buildTurn(turnId, status) } });
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++ + (JOB_BEHAVIORS.has(BEHAVIOR) && state.nextThreadId > 2 ? "_" + process.pid : ""),
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  let thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread && JOB_BEHAVIORS.has(BEHAVIOR) && /^thr_/.test(threadId)) {
    // Several fake app-servers share this state file and can drop each other's threads.
    thread = { id: threadId, cwd: process.cwd(), name: null, preview: "", ephemeral: false, createdAt: now(), updatedAt: now() };
    state.threads.unshift(thread);
  }
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  refuseRealHome(ledgerPath);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// With an error, the turn ends failed after its items.
function emitTurnCompleted(threadId, turnId, item, error = null) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, error ? "failed" : "completed", error) } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    // A fixed answer for the review tests, in place of the schema-shaped one below.
    if (process.env.FAKE_REVIEW_ANSWER) {
      return process.env.FAKE_REVIEW_ANSWER;
    }
    if (BEHAVIOR === "adversarial-invalid-json") {
      return "The change looks risky, but here is prose instead of JSON.";
    }
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    if (BEHAVIOR === "stop-unexpected") {
      return "I looked at the turn and have thoughts.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
bootState.spawnHomes = [...(bootState.spawnHomes || []), process.env.CODEX_HOME ?? null];
bootState.spawnArgs = [...(bootState.spawnArgs || []), args];
bootState.spawnPids = [...(bootState.spawnPids || []), process.pid];
saveState(bootState);

// The home probe simulates config/catalog loading, including errors before initialize.
// Ordinary job behaviors keep their existing responses.
let homeConfig = "";
if (BEHAVIOR === "home-probe") {
  try {
    homeConfig = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    if (homeConfig.includes("broken TOML")) throw new Error("invalid TOML in config.toml");
    const catalog = /model_catalog_json\\s*=\\s*"([^"]+)"/.exec(homeConfig)?.[1];
    if (catalog) {
      try { JSON.parse(fs.readFileSync(catalog, "utf8")); }
      catch { throw new Error("model catalog failed to load: " + catalog); }
    }
  } catch (error) {
    process.stderr.write(error.message + "\\n", () => process.exit(23));
    return;
  }
}

const rl = readline.createInterface({ input: process.stdin });
// The client closes the server by ending its stdin, and escalates through SIGTERM and SIGKILL if it still
// runs, which a loaded machine can cause. An idle server, with no turn or timer pending, exits 0
// either way, through process.exit: a natural exit drops the SIGTERM handler before it ends. A
// server with work pending keeps running when stdin ends, and SIGTERM kills it, as before.
const idle = () => !process.getActiveResourcesInfo().some((type) => type === "Timeout" || type === "Immediate");
process.stdin.on("end", () => { if (idle()) process.exit(0); });
const onTerm = () => {
  if (idle()) process.exit(0);
  process.off("SIGTERM", onTerm);
  process.kill(process.pid, "SIGTERM");
};
process.on("SIGTERM", onTerm);
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  if (["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(message.method)) {
    record("requests", { method: message.method, params: message.params });
  }
  const state = loadState();
  if (message.id === "input-request-1" && message.error) record("serverRequestRejections", message);
  // The turn that sent this request ends only once its answer is recorded (just above).
  if (message.id === "input-request-1" && !message.method) {
    for (const turn of activeTurns.values()) if (turn.awaitingAnswer) { turn.awaitingAnswer = false; turn.whenAnswered?.(); }
  }

  try {
    switch (message.method) {
      case "initialize":
        if (process.env.FAKE_CODEX_INIT_DEATH) { process.stderr.write("initialization-stderr", () => process.exit(23)); break; }
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "thread/read": {
        record("threadReads", message.params);
        if (BEHAVIOR === "turn-order-collab-silent") break;
        // turn-order-steer-*: the reply waits for the steer, so relay cannot infer the turn
        // complete before the steer arrives, however slowly the steer comes.
        if (BEHAVIOR.startsWith("turn-order-steer-") && !steerArrived) {
          readsAwaitingSteer.push(message.id);
          break;
        }
        if (!BEHAVIOR.startsWith("turn-order-collab-") || BEHAVIOR === "turn-order-collab-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: thread/read" } });
          break;
        }
        if (BEHAVIOR === "turn-order-collab-unknown-method") {
          send({ id: message.id, error: { code: -32000, message: "unknown variant thread/read" } });
          break;
        }
        if (BEHAVIOR === "turn-order-collab-read-error") {
          send({ id: message.id, error: { code: -32000, message: "history unavailable\\nadditional detail" } });
          break;
        }
        if (BEHAVIOR === "turn-order-collab-unknown-variant-status" || BEHAVIOR === "turn-order-collab-unsupported-text") {
          send({ id: message.id, error: { code: -32000, message: BEHAVIOR.endsWith("unsupported-text")
            ? "Unsupported method: thread/read" : "unknown variant \`waiting\`, expected a turn status" } });
          break;
        }
        const status = BEHAVIOR.slice("turn-order-collab-".length);
        const turn = buildTurn(state.lastTurnStart.turnId, status === "unknown-status" ? "waiting" : ["failed", "interrupted", "inProgress"].includes(status) ? status : "completed", status === "failed" ? { message: "read found failure" } : null);
        const response = { id: message.id, result: { thread: { ...buildThread(ensureThread(state, message.params.threadId)), turns: [buildTurn("unrelated", "completed"), ...(status === "missing" ? [] : [turn])] } } };
        // read-race: the reply goes once the steer is answered, so it is in flight while the steer
        // lands, however slowly the steer comes.
        if (status === "read-race" && !steerArrived) repliesAwaitingSteer.push(response);
        else send(response);
        break;
      }

      case "initialized":
        if (process.env.FAKE_CODEX_CONFIG_WARNING && BEHAVIOR === "home-probe") send({ method: "configWarning", params: { summary: process.env.FAKE_CODEX_CONFIG_WARNING, details: null } });
        break;

      case "account/read":
        // A setup check that never answers, for the page's time limit.
        if (process.env.FAKE_CODEX_SETUP_HANG) break;
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        record("configReads", message.params);
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        if (process.env.FAKE_CODEX_CONFIG_READ) {
          send({ id: message.id, result: JSON.parse(process.env.FAKE_CODEX_CONFIG_READ) });
          break;
        }
        if (BEHAVIOR === "home-probe") {
          const homeValue = key => new RegExp(key + '\\\\s*=\\\\s*"([^"]+)"').exec(homeConfig)?.[1] ?? null;
          send({ id: message.id, result: { config: { model: homeValue("model"), model_provider: homeValue("model_provider"), model_reasoning_effort: homeValue("model_reasoning_effort") }, origins: {} } });
          break;
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "model/list":
        record("modelLists", message.params);
        send({ id: message.id, result: { data: [
          { id: "gpt-fake-sol", model: "gpt-fake-sol", hidden: false, isDefault: true, defaultReasoningEffort: "low",
            supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) },
          { id: "gpt-fake-luna", model: "gpt-fake-luna", hidden: false, isDefault: false, defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium"].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }
        ], nextCursor: null } });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        record("threadStarts", message.params);
        const homeValue = key => new RegExp(key + '\\\\s*=\\\\s*"([^"]+)"').exec(homeConfig)?.[1];
        if (process.env.FAKE_CODEX_WARNING) send({ method: "warning", params: { threadId: thread.id, message: process.env.FAKE_CODEX_WARNING } });
        if (process.env.FAKE_CODEX_CONFIG_WARNING) send({ method: "configWarning", params: { summary: process.env.FAKE_CODEX_CONFIG_WARNING, details: null } });
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || homeValue("model") || "gpt-5.4", modelProvider: homeValue("model_provider") || "openai", serviceTier: message.params.serviceTier ?? null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: homeValue("model_reasoning_effort") || null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        record("threadNames", message.params.name);
        if (hasLoneSurrogate(message.params.name)) {
          // A name with a lone surrogate gets no reply from the app-server.
          break;
        }
        const fresh = loadState();
        const target = ensureThread(fresh, message.params.threadId);
        target.name = message.params.name;
        target.updatedAt = now();
        saveState(fresh);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        saveState(state);
        record("threadResumes", message.params);
        if (process.env.FAKE_CODEX_RESUME_FAIL) {
          send({ id: message.id, error: { code: -32000, message: "authentication expired; run codex login" } });
          break;
        }
        const resumeDelay = Number(process.env.FAKE_CODEX_RESUME_DELAY_MS) || 0;
        const resumed = { ...buildThread(thread), turns: deliveredTurns(thread.id) };
        if (process.env.FAKE_CODEX_LARGE_LINES) resumed.preview = "界😀".repeat(600000) + "resume-tail";
        if (process.env.FAKE_CODEX_RESUME_PARTIAL && loadState().appServerStarts <= Number(process.env.FAKE_CODEX_RESUME_PARTIAL)) {
          process.stdout.write('{"id":' + message.id + ',"result":{"thread":{"preview":"' + "x".repeat(300000), () => process.exit(0));
          break;
        }
        const reply = () => send({ id: message.id, result: { thread: resumed, model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: message.params.serviceTier ?? null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        if (resumeDelay) { setTimeout(reply, resumeDelay); } else { reply(); }
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        record("turnStarts", { threadId: message.params.threadId, turnId, model: message.params.model ?? null, effort: message.params.effort ?? null, ...(Object.hasOwn(message.params, "serviceTier") ? { serviceTier: message.params.serviceTier } : {}), sandboxPolicy: message.params.sandboxPolicy ?? null, approvalPolicy: message.params.approvalPolicy ?? null, clientUserMessageId: message.params.clientUserMessageId ?? null, prompt });
	        recordDelivered(message.params.threadId, message.params.clientUserMessageId);
	        if (BEHAVIOR === "job-child" || BEHAVIOR === "job-hang-child") {
	          spawnDescendant(turnId);
	        }

        if (BEHAVIOR.startsWith("turn-order-terminal-start-")) {
          const status = BEHAVIOR.slice("turn-order-terminal-start-".length);
          send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "terminal-answer", phase: "final_answer", text: "Terminal response report" } } });
          send({ id: message.id, result: { turn: buildTurn(turnId, status) } });
          break;
        }
        if (BEHAVIOR.startsWith("turn-order-")) {
          send({ id: message.id, result: { turn: buildTurn(turnId) } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          const collab = BEHAVIOR.startsWith("turn-order-collab-") || BEHAVIOR.includes("steer") || BEHAVIOR.includes("activity") || BEHAVIOR === "turn-order-collab-exit";
          if (collab) {
            const childId = "turn-order-child";
            const item = { type: "collabAgentToolCall", id: "collab_" + turnId, receiverThreadIds: [childId], tool: "spawnAgent", status: "inProgress" };
            send({ method: "item/started", params: { threadId: thread.id, turnId, item } });
            send({ method: "turn/started", params: { threadId: childId, turn: buildTurn("child-turn") } });
            send({ method: "turn/completed", params: { threadId: childId, turn: buildTurn("child-turn", "completed") } });
            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { ...item, status: "completed" } } });
          }
          const entry = { threadId: thread.id, prompt, steers: [], timer: null };
          activeTurns.set(turnId, entry);
          setTimeout(() => {
            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "candidate", phase: "final_answer", text: "Candidate report" } } });
          }, 100);
          if (BEHAVIOR === "turn-order-wrong-turn") {
            setTimeout(() => send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn("unrelated", "failed") } }), 200);
          }
          if (BEHAVIOR === "turn-order-server-request") {
            // Codex waits for the client's answer to its request before the turn goes on.
            entry.awaitingAnswer = true;
            send({ id: "input-request-1", method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId } });
          }
          if (BEHAVIOR.startsWith("turn-order-activity-")) {
            setTimeout(() => send(BEHAVIOR.endsWith("item")
              ? { method: "item/started", params: { threadId: thread.id, turnId: BEHAVIOR.includes("other") ? "new-turn" : turnId, item: { type: "agentMessage", id: "more-work", phase: "commentary", text: "More work" } } }
              : { method: "turn/started", params: { threadId: thread.id, turn: buildTurn(BEHAVIOR.includes("other") ? "new-turn" : turnId) } }), 200);
          }
          if (BEHAVIOR === "turn-order-final-exit" || BEHAVIOR === "turn-order-collab-exit") {
            setTimeout(() => process.exit(0), BEHAVIOR === "turn-order-collab-exit" ? 300 : 800);
          } else if (BEHAVIOR.startsWith("turn-order-steer-")) {
            // The turn ends once its steer is answered (turn/steer), however late the steer comes.
          } else if (!BEHAVIOR.startsWith("turn-order-collab-") || BEHAVIOR === "turn-order-collab-read-race") {
            const end = () => finishJobTurn(turnId, BEHAVIOR === "turn-order-final-failed" ? "failed" : "completed");
            // read-race: the turn ends once the steer is answered, too, however late it comes.
            const held = () => entry.awaitingAnswer || (BEHAVIOR === "turn-order-collab-read-race" && !steerArrived);
            entry.timer = setTimeout(() => { if (held()) entry.whenAnswered = end; else end(); }, 900);
          }
          break;
        }

	        if (JOB_BEHAVIORS.has(BEHAVIOR)) {
	          if (BEHAVIOR === "job-capacity") {
	            const fresh = loadState();
	            fresh.capacityFailuresSoFar = (fresh.capacityFailuresSoFar || 0) + 1;
	            saveState(fresh);
	            if (fresh.capacityFailuresSoFar <= CAPACITY_FAILURES) {
	              send({ id: message.id, result: { turn: buildTurn(turnId) } });
	              send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	              for (const item of CAPACITY_WORK) {
	                if (CAPACITY_WORK_VIA.includes("started")) send({ method: "item/started", params: { threadId: thread.id, turnId, item } });
	                if (CAPACITY_WORK_VIA.includes("completed")) send({ method: "item/completed", params: { threadId: thread.id, turnId, item } });
	              }
	              const error = CAPACITY_ERROR;
	              send({ method: "error", params: { error, willRetry: false, threadId: thread.id, turnId } });
	              const failed = { ...buildTurn(turnId, "failed", error), items: CAPACITY_WORK_VIA.includes("terminal") ? CAPACITY_WORK : [] };
	              send({ method: "turn/completed", params: { threadId: thread.id, turn: failed } });
	              if (CAPACITY_EXIT && fresh.capacityFailuresSoFar === 1) {
	                leaveChild(CAPACITY_EXIT);
	                setTimeout(() => process.exit(17), 10);
	              }
	              break;
	            }
	          }
	          if (BEHAVIOR === "job-no-turn-id") {
	            send({ id: message.id, result: {} });
	          } else {
	            send({ id: message.id, result: { turn: buildTurn(turnId) } });
	          }
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          if (BEHAVIOR === "job-exit-before-complete") {
	            setTimeout(() => process.exit(0), 100);
	            break;
	          }
          const deathKind = process.env.FAKE_CODEX_DEATH_KIND;
          if (deathKind && loadState().appServerStarts <= Number(process.env.FAKE_CODEX_DEATH_COUNT || 1)) {
            setTimeout(() => {
              const end = () => {
                if (deathKind === "kill") process.kill(process.pid, "SIGKILL");
                else if (deathKind === "partial") {
                  // With stdout ended, the client closes stdin and escalates through SIGTERM and SIGKILL if this
                  // process still runs, which a loaded machine can cause. It exits 0 either way,
                  // through process.exit: a natural exit drops the SIGTERM handler before it ends.
                  process.on("SIGTERM", () => process.exit(0));
                  process.stdin.on("end", () => process.exit(0));
                  process.stdout.write('{"method":"item/completed","text":"' + "界".repeat(1000), () => process.stdout.end());
                }
                else process.exit(0);
              };
              process.stderr.write("s".repeat(Number(process.env.FAKE_CODEX_STDERR_BYTES || 0)) + "stderr-tail-" + process.pid + "\\n", end);
            }, 100);
            break;
          }
          if (process.env.FAKE_CODEX_LARGE_LINES) {
            send({ method: "item/completed", params: { threadId: thread.id, turnId,
              item: { type: "mcpToolCall", id: "large-mcp", result: { content: [{ type: "text", text: "界😀".repeat(600000) + "mcp-tail" }] } } } });
          }
	          const entry = { threadId: thread.id, prompt, steers: [], timer: null };
	          activeTurns.set(turnId, entry);
	          if (BEHAVIOR !== "job-hang" && BEHAVIOR !== "job-hang-child") {
	            // "[quick]" ends the turn at once; "[fail]" ends it at once as a failed turn; "[long]"
	            // runs it 30 s; "[held]" ends it once FAKE_CODEX_RELEASE_FILE exists, a barrier the
	            // test controls.
	            if (prompt.includes("[held]")) {
	              const release = () => { entry.timer = fs.existsSync(process.env.FAKE_CODEX_RELEASE_FILE || "") ? (finishJobTurn(turnId, "completed"), null) : setTimeout(release, 20); };
	              entry.timer = setTimeout(release, 20);
	            } else entry.timer = setTimeout(() => finishJobTurn(turnId, prompt.includes("[fail]") ? "failed" : "completed"), prompt.includes("[quick]") || prompt.includes("[fail]") ? 50 : prompt.includes("[long]") ? 30000 : TURN_MS);
	          }
	          break;
	        }
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else if (BEHAVIOR === "adversarial-turn-failed") {
	          // The whole answer arrives, then the turn fails.
	          emitTurnCompleted(thread.id, turnId, items, { message: "stream disconnected before completion" });
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/steer": {
	        const text = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
	        const turn = activeTurns.get(message.params.expectedTurnId);
	        if (BEHAVIOR === "job-steer-late" && turn) {
	          // The turn completes before the steer is answered; then the steer is refused.
	          record("steers", { threadId: message.params.threadId, expectedTurnId: message.params.expectedTurnId, text, accepted: false, late: true });
	          finishJobTurn(message.params.expectedTurnId, "completed");
	          setTimeout(() => send({ id: message.id, error: { code: -32600, message: "no active turn matches expectedTurnId " + message.params.expectedTurnId } }), 300);
	          break;
	        }
	        record("steers", { threadId: message.params.threadId, expectedTurnId: message.params.expectedTurnId, text, accepted: Boolean(turn), clientUserMessageId: message.params.clientUserMessageId ?? null });
	        if (turn) {
	          recordDelivered(message.params.threadId, message.params.clientUserMessageId);
	        }
	        if (!turn || turn.threadId !== message.params.threadId) {
	          send({ id: message.id, error: { code: -32600, message: "no active turn matches expectedTurnId " + message.params.expectedTurnId } });
	          break;
	        }
	        turn.steers.push(text);
        if (BEHAVIOR.startsWith("turn-order-steer-")) {
          steerArrived = true;
          for (const id of readsAwaitingSteer.splice(0)) send({ id, error: { code: -32601, message: "Unsupported method: thread/read" } });
        }
        if (BEHAVIOR === "turn-order-steer-pending") {
          setTimeout(() => {
            send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
            finishJobTurn(message.params.expectedTurnId, "completed");
          }, 400);
        } else {
	          send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
          if (BEHAVIOR === "turn-order-steer-accepted") finishJobTurn(message.params.expectedTurnId, "completed");
          if (BEHAVIOR === "turn-order-collab-read-race") {
            steerArrived = true;
            for (const response of repliesAwaitingSteer.splice(0)) send(response);
            const end = turn.whenAnswered;
            turn.whenAnswered = null;
            end?.();
          }
        }
	        break;
	      }

	      case "turn/interrupt": {
            if (process.env.FAKE_CODEX_INTERRUPT_DEATH) { process.kill(process.pid, "SIGKILL"); break; }
	        if (activeTurns.has(message.params.turnId)) {
	          record("interrupts", message.params);
	          send({ id: message.id, result: {} });
	          if (BEHAVIOR !== "job-hang" && BEHAVIOR !== "job-hang-child") {
	            finishJobTurn(message.params.turnId, "interrupted");
	          }
	          break;
	        }
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);


}

export function buildEnv(binDir) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`
  };
}
