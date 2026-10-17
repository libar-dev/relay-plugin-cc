// Signed-in probes of `kimi acp`, one scenario per run:
//   node probe.mjs <scenario> <outdir> [options as key=value]
// Environment: KIMI_BINARY, KIMI_CODE_HOME (the jobs home). Every run uses a fresh work folder
// under <outdir>, outside every git repository, and writes <scenario>.log.jsonl (the wire),
// <scenario>.summary.json, and copies of the session's files.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startAcp, collectText, sleep } from "./acp-lib.mjs";

const [scenario, outdir, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((kv) => kv.split("=")));
const home = process.env.KIMI_CODE_HOME;
if (!home || !process.env.KIMI_BINARY) throw new Error("KIMI_CODE_HOME and KIMI_BINARY are required");
const work = path.join(outdir, `${scenario}-work`);
fs.mkdirSync(work, { recursive: true });
const MODEL = opts.model ?? "kimi-code/k3";
const EFFORT = opts.effort ?? "low";
const baseEnv = { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_DISABLE_TELEMETRY: "1" };
const summary = { scenario, model: MODEL, effort: EFFORT, home, work, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  summary.steps.push({ name, at: new Date().toISOString(), ...data });
  console.log(`[${name}]`, JSON.stringify(data).slice(0, 600));
};

// Permission answers: allow (pick allow_once), reject (pick reject_once), or cancel.
function permissionAnswer(policy, requests) {
  return (msg) => {
    if (msg.method !== "session/request_permission") return { error: { code: -32601, message: "probe does not serve " + msg.method } };
    const options = msg.params.options ?? [];
    requests.push({ at: new Date().toISOString(), title: msg.params.toolCall?.title, kind: msg.params.toolCall?.kind, rawInput: msg.params.toolCall?.rawInput, options: options.map((o) => `${o.optionId}:${o.kind}`) });
    const pick = (kind) => options.find((o) => o.kind === kind);
    const chosen = policy === "allow" ? pick("allow_once") ?? pick("allow_always") : policy === "reject" ? pick("reject_once") ?? pick("reject_always") : undefined;
    return { result: { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } } };
  };
}

function open(name, { env = {}, policy = "allow", requests = [] } = {}) {
  return startAcp({
    binary: process.env.KIMI_BINARY,
    cwd: work,
    env: { ...baseEnv, ...env },
    log: path.join(outdir, `${scenario}${name ? "-" + name : ""}.log.jsonl`),
    onRequest: permissionAnswer(policy, requests)
  });
}

async function newSession(acp, { mode } = {}) {
  await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const created = await acp.request("session/new", { cwd: work, mcpServers: [] });
  step("session/new", { sessionId: created.sessionId, configOptions: created.configOptions?.map((o) => ({ id: o.id, currentValue: o.currentValue, options: o.options?.map((x) => x.value) })), modes: created.modes });
  const sid = created.sessionId;
  if (opts.model !== "none") {
    const m = await acp.request("session/set_config_option", { sessionId: sid, configId: "model", value: MODEL });
    const t = await acp.request("session/set_config_option", { sessionId: sid, configId: "thinking", value: EFFORT });
    step("config", { model: m.configOptions?.find((o) => o.id === "model")?.currentValue, thinking: t.configOptions?.find((o) => o.id === "thinking")?.currentValue });
  }
  if (mode) {
    await acp.request("session/set_mode", { sessionId: sid, modeId: mode });
    step("set_mode", { mode });
  }
  return sid;
}

async function prompt(acp, sid, blocks) {
  const text = collectText(acp);
  const thought = collectText(acp, "agent_thought_chunk");
  const kinds = {};
  const tools = [];
  const offKinds = acp.on((msg) => {
    const u = msg.params?.update;
    if (msg.method !== "session/update" || !u) return;
    kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
    if (u.sessionUpdate === "tool_call") tools.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status });
    if (u.sessionUpdate === "tool_call_update" && u.status) tools.push({ id: u.toolCallId, status: u.status });
  });
  const t0 = Date.now();
  const content = typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks;
  const done = acp.request("session/prompt", { sessionId: sid, prompt: content }).then(
    (result) => ({ result, ms: Date.now() - t0 }),
    (error) => ({ error: error.rpc ?? String(error), ms: Date.now() - t0 })
  );
  return {
    done: done.then((r) => {
      text.stop();
      thought.stop();
      offKinds();
      return { ...r, text: text.text, thoughtChars: thought.text.length, updateKinds: kinds, tools };
    }),
    t0
  };
}

function sessionDir(sid) {
  const root = path.join(home, "sessions");
  for (const bucket of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, bucket, sid);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function copySession(sid, label = "session") {
  const dir = sessionDir(sid);
  if (!dir) return step("session-files", { sid, found: false });
  const target = path.join(outdir, `${scenario}-${label}`);
  fs.cpSync(dir, target, { recursive: true });
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(`${path.relative(dir, p)} (${fs.statSync(p).size} B)`);
    }
  };
  walk(dir);
  step("session-files", { sid, dir, files });
  const wire = path.join(dir, "agents", "main", "wire.jsonl");
  if (fs.existsSync(wire)) {
    const types = {};
    for (const line of fs.readFileSync(wire, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        const key = r.type + (r.event?.type ? ":" + r.event.type : "") + (r.kind ? ":" + r.kind : "");
        types[key] = (types[key] ?? 0) + 1;
      } catch {
        types["(unparsed)"] = (types["(unparsed)"] ?? 0) + 1;
      }
    }
    step("wire-record-types", types);
  }
}

const procs = (pattern) => {
  try {
    return execFileSync("pgrep", ["-af", pattern], { encoding: "utf8" }).trim().split("\n").filter((l) => !l.includes("pgrep"));
  } catch {
    return [];
  }
};

const scenarios = {
  async basic() {
    const acp = open();
    try {
      const sid = await newSession(acp);
      const p = await prompt(acp, sid, "Reply with exactly the word PONG and nothing else.");
      step("prompt", await p.done);
      const p2 = await prompt(acp, sid, "Reply with exactly the word SECOND and nothing else.");
      step("prompt-2", await p2.done);
      await sleep(500);
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  // A shell tool turn under a mode; while it runs, a second prompt (the busy check).
  async tool() {
    const requests = [];
    const acp = open("", { policy: opts.policy ?? "allow", requests });
    try {
      const sid = await newSession(acp, { mode: opts.mode });
      const p = await prompt(acp, sid, "Use your shell tool to run exactly this command: `printf hello > made-by-shell.txt && sleep 8`. Then reply with exactly the word DONE.");
      await sleep(Number(opts.busyAfterMs ?? 4000));
      try {
        const second = await acp.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Reply with exactly BUSY." }] });
        step("second-prompt", { result: second });
      } catch (error) {
        step("second-prompt", { error: error.rpc ?? String(error), ms: Date.now() - p.t0 });
      }
      step("prompt", await p.done);
      step("permission-requests", { requests });
      step("file", { exists: fs.existsSync(path.join(work, "made-by-shell.txt")) });
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  async cancel() {
    const acp = open();
    try {
      const sid = await newSession(acp, { mode: opts.mode ?? "yolo" });
      const p = await prompt(acp, sid, "Use your shell tool to run exactly `sleep 47`. When it finishes, reply with exactly the word DONE.");
      let sawTool = false;
      const off = acp.on((msg) => { if (msg.params?.update?.sessionUpdate === "tool_call") sawTool = true; });
      for (let i = 0; i < 60 && !sawTool; i++) await sleep(500);
      await sleep(2000);
      off();
      step("before-cancel", { sawTool, sleeps: procs("sleep 47") });
      const tc = Date.now();
      acp.notify("session/cancel", { sessionId: sid });
      const r = await p.done;
      step("prompt", { ...r, cancelToResponseMs: Date.now() - tc });
      await sleep(1500);
      step("after-cancel", { sleeps: procs("sleep 47") });
      const p2 = await prompt(acp, sid, "Reply with exactly the word AFTER.");
      step("prompt-after-cancel", await p2.done);
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  // Kill the server mid-turn, then session/load in a new process.
  async load() {
    const first = open("first");
    let sid;
    try {
      sid = await newSession(first, { mode: "yolo" });
      const p = await prompt(first, sid, "Remember the codeword TANGERINE. Use your shell tool to run exactly `sleep 40`, then reply with exactly the word FINISHED.");
      let sawTool = false;
      const off = first.on((msg) => { if (msg.params?.update?.sessionUpdate === "tool_call") sawTool = true; });
      for (let i = 0; i < 60 && !sawTool; i++) await sleep(500);
      await sleep(2000);
      off();
      step("kill", { sawTool, pid: first.child.pid });
      first.child.kill("SIGKILL");
      step("first-exit", await first.exited);
      step("first-prompt", await p.done);
    } catch (error) {
      step("first-error", { error: String(error) });
    }
    await sleep(1000);
    step("orphans", { sleeps: procs("sleep 40") });
    copySession(sid, "after-kill");
    const second = open("second");
    try {
      await second.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const replay = [];
      const off = second.on((msg) => {
        const u = msg.params?.update;
        if (msg.method === "session/update" && u) replay.push({ kind: u.sessionUpdate, text: u.content?.text?.slice(0, 200), toolCallId: u.toolCallId, title: u.title, status: u.status });
      });
      const t0 = Date.now();
      const loaded = await second.request("session/load", { sessionId: sid, cwd: work, mcpServers: [] });
      off();
      step("session/load", { ms: Date.now() - t0, configOptions: loaded.configOptions?.map((o) => ({ id: o.id, currentValue: o.currentValue })), modes: loaded.modes?.currentModeId, replay });
      const p = await prompt(second, sid, "What was the codeword in my first message? Reply with just the codeword.");
      step("prompt-after-load", await p.done);
      copySession(sid, "after-load");
    } finally {
      step("exit", await second.close());
    }
  },

  // A turn whose model call cannot connect: a temporary provider at a closed port.
  async fail() {
    const env = { KIMI_MODEL_NAME: "probe-unreachable", KIMI_MODEL_API_KEY: "probe-invalid", KIMI_MODEL_BASE_URL: "http://127.0.0.1:9/v1", KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "1" };
    const acp = open("", { env });
    try {
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await acp.request("session/new", { cwd: work, mcpServers: [] });
      step("session/new", { sessionId: created.sessionId, model: created.configOptions?.find((o) => o.id === "model") });
      const p = await prompt(acp, created.sessionId, "Reply with exactly the word PONG.");
      step("prompt", await p.done);
      copySession(created.sessionId);
    } finally {
      step("exit", await acp.close());
    }
  },

  // Read-only enforced by the client: Kimi's `default` mode, every permission request rejected,
  // and the client claims fs writes and terminals so it can refuse each one. Runs in a git work
  // tree, where Kimi's own policy approves Write and Edit inside the workspace without asking.
  async readonly() {
    execFileSync("git", ["init", "-q", work]);
    fs.writeFileSync(path.join(work, "existing.txt"), "alpha\n");
    execFileSync("git", ["-C", work, "add", "."]);
    execFileSync("git", ["-C", work, "-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-qm", "init"]);
    const requests = [];
    const reverse = [];
    const acp = startAcp({
      binary: process.env.KIMI_BINARY,
      cwd: work,
      env: baseEnv,
      log: path.join(outdir, `${scenario}.log.jsonl`),
      onRequest: (msg) => {
        if (msg.method === "session/request_permission") return permissionAnswer("reject", requests)(msg);
        reverse.push({ method: msg.method, path: msg.params?.path, command: msg.params?.command, args: msg.params?.args });
        if (msg.method === "fs/write_text_file") return { error: { code: -32000, message: "This job is read-only: file writes are refused." } };
        if (msg.method === "terminal/create") return { error: { code: -32000, message: "This job is read-only: shell commands are refused." } };
        return { error: { code: -32601, message: "not supported" } };
      }
    });
    try {
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: true }, terminal: true } });
      const created = await acp.request("session/new", { cwd: work, mcpServers: [] });
      const sid = created.sessionId;
      await acp.request("session/set_config_option", { sessionId: sid, configId: "model", value: MODEL });
      await acp.request("session/set_config_option", { sessionId: sid, configId: "thinking", value: EFFORT });
      await acp.request("session/set_mode", { sessionId: sid, modeId: "default" });
      const p = await prompt(acp, sid, "Try each of these four steps once, using your tools, even if an earlier one fails, and do not ask me anything: 1) create the file notes.txt containing x with your file-writing tool; 2) in existing.txt replace alpha with beta using your edit tool; 3) run the shell command `touch touched.txt`; 4) read existing.txt. Then reply with one line per step saying whether it worked, and the content of existing.txt.");
      step("prompt", await p.done);
      step("permission-requests", { requests });
      step("reverse-requests", { reverse });
      const ls = fs.readdirSync(work).filter((n) => n !== ".git");
      step("effects", { files: ls, existing: fs.readFileSync(path.join(work, "existing.txt"), "utf8"), gitStatus: execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" }) });
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  // A background task that finishes while the session is idle: does Kimi start a turn of its own,
  // what reaches the client, and what does a prompt sent during that turn get?
  async background() {
    const acp = open();
    const updates = [];
    acp.on((msg) => {
      const u = msg.params?.update;
      if (msg.method === "session/update" && u) updates.push({ t: acp.elapsed(), kind: u.sessionUpdate, text: u.content?.text?.slice(0, 80) });
    });
    try {
      const sid = await newSession(acp, { mode: "auto" });
      const p1 = await prompt(acp, sid, "Start the shell command `sleep 15 && echo BGDONE` as a background task (run it in the background, do not wait for it), then end your turn at once by replying with exactly the word STARTED.");
      step("prompt-1", await p1.done);
      const dir = sessionDir(sid);
      const wire = dir && path.join(dir, "agents", "main", "wire.jsonl");
      const turnRecords = () => (wire && fs.existsSync(wire) ? fs.readFileSync(wire, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => ["agent.turn.started", "turn.prompt", "turn.ended", "prompt.completed", "agent.message.appended"].includes(r.type)).map((r) => ({ type: r.type, turnId: r.turnId, reason: r.reason, promptId: r.promptId ?? r.queueItemId, origin: r.message?.meta?.origin?.kind ?? r.origin?.kind, role: r.message?.message?.role, text: (r.message?.message?.content ?? r.input ?? []).filter?.((c) => c.type === "text").map((c) => c.text.slice(0, 60)).join("|") })) : []);
      const u0 = updates.length;
      await sleep(Number(opts.waitMs ?? 30000));
      step("idle-updates", { updates: updates.slice(u0) });
      step("wire-turns-after-wait", { records: turnRecords() });
      const p3 = await prompt(acp, sid, "Reply with exactly the word THIRD.");
      step("prompt-after-wait", await p3.done);
      await sleep(3000);
      step("wire-turns-final", { records: turnRecords() });
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  async effort() {
    const acp = open();
    try {
      await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await acp.request("session/new", { cwd: work, mcpServers: [] });
      const sid = created.sessionId;
      step("session/new", { configOptions: created.configOptions });
      const tries = [
        ["model", "kimi-code/k3"], ["thinking", "low"], ["thinking", "high"], ["thinking", "max"], ["thinking", "medium"], ["thinking", "xhigh"], ["thinking", "off"],
        ["model", "kimi-code/kimi-for-coding-highspeed"], ["thinking", "low"], ["model", "kimi-code/nope"], ["model", "k3"]
      ];
      for (const [configId, value] of tries) {
        try {
          const r = await acp.request("session/set_config_option", { sessionId: sid, configId, value });
          step(`set ${configId}=${value}`, { ok: true, model: r.configOptions?.find((o) => o.id === "model")?.currentValue, thinking: r.configOptions?.find((o) => o.id === "thinking") });
        } catch (error) {
          step(`set ${configId}=${value}`, { error: error.rpc ?? String(error) });
        }
      }
    } finally {
      step("exit", await acp.close());
    }
  },

  async slash() {
    const acp = open();
    try {
      const sid = await newSession(acp);
      const plain = await prompt(acp, sid, "/tmp is a directory. Reply with exactly OK.");
      step("plain-slash", await plain.done);
      const guarded = await prompt(acp, sid, [{ type: "text", text: "" }, { type: "text", text: "/tmp is a directory. Reply with exactly the text after the colon, verbatim: OK-GUARDED" }]);
      step("empty-first-block", await guarded.done);
      const echo = await prompt(acp, sid, "Quote, verbatim and inside a code block, the full text of my previous message.");
      step("echo", await echo.done);
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  async web() {
    const acp = open();
    try {
      const sid = await newSession(acp, { mode: "yolo" });
      const p = await prompt(acp, sid, "Use your web search tool to find the official website of the Node.js project, then reply with its domain name only.");
      step("prompt", await p.done);
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  },

  // What asks for permission in a mode: a shell delete, a file write, then an edit of AGENTS-free file.
  async mode() {
    const m = opts.mode;
    const requests = [];
    fs.mkdirSync(path.join(work, `victim-${m}`, "inner"), { recursive: true });
    fs.writeFileSync(path.join(work, `victim-${m}`, "inner", "x.txt"), "x");
    const acp = open("", { policy: opts.policy ?? "allow", requests });
    try {
      const sid = await newSession(acp, { mode: m });
      const p = await prompt(acp, sid, `Do these three steps in order, using your tools, without asking me anything: 1) run the shell command \`rm -rf ./victim-${m}\`; 2) create the file wrote-${m}.txt containing the single letter x with your file-writing tool; 3) run the shell command \`ls\`. Then reply with exactly the word DONE.`);
      step("prompt", await p.done);
      step("permission-requests", { requests });
      step("effects", { victimGone: !fs.existsSync(path.join(work, `victim-${m}`)), wrote: fs.existsSync(path.join(work, `wrote-${m}.txt`)) });
      copySession(sid);
    } finally {
      step("exit", await acp.close());
    }
  }
};

if (!scenarios[scenario]) throw new Error(`unknown scenario ${scenario}; known: ${Object.keys(scenarios).join(", ")}`);
try {
  await scenarios[scenario]();
} catch (error) {
  step("probe-error", { error: error.rpc ?? String(error), stack: error.stack });
}
summary.endedAt = new Date().toISOString();
fs.writeFileSync(path.join(outdir, `${scenario}.summary.json`), JSON.stringify(summary, null, 2));
