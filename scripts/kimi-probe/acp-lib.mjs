// A minimal ACP client for probing `kimi acp`: newline-delimited JSON-RPC 2.0 over stdio.
// Every message in either direction is appended to a JSONL log with a timestamp, so each
// probe leaves a full wire record beside its summary.
import { spawn } from "node:child_process";
import fs from "node:fs";

export function startAcp({ binary, args = ["acp"], cwd, env, log, onRequest }) {
  const out = fs.createWriteStream(log, { flags: "a" });
  const t0 = Date.now();
  const record = (dir, msg) => out.write(JSON.stringify({ t: Date.now() - t0, at: new Date().toISOString(), dir, msg }) + "\n");
  const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  record("spawn", { pid: child.pid, binary, args, cwd });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        record("stdout-unparsed", line);
        continue;
      }
      record("in", msg);
      if (msg.id !== undefined && msg.method === undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
          else p.resolve(msg.result);
        }
      } else if (msg.method !== undefined && msg.id !== undefined) {
        Promise.resolve(onRequest ? onRequest(msg) : { error: { code: -32601, message: "not supported by probe" } }).then((answer) => {
          const reply = answer?.error ? { jsonrpc: "2.0", id: msg.id, error: answer.error } : { jsonrpc: "2.0", id: msg.id, result: answer?.result ?? answer ?? null };
          record("out", reply);
          child.stdin.write(JSON.stringify(reply) + "\n");
        });
      } else {
        for (const l of listeners) l(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    record("stderr", chunk);
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => {
    record("exit", { code, signal });
    for (const p of pending.values()) p.reject(new Error(`server exited (${code ?? signal}) before answering`));
    pending.clear();
    resolve({ code, signal });
  }));
  return {
    child,
    exited,
    get stderr() { return stderr; },
    elapsed: () => Date.now() - t0,
    note: (text, data) => record("note", { text, ...data }),
    request(method, params) {
      const id = nextId++;
      const msg = { jsonrpc: "2.0", id, method, params };
      record("out", msg);
      child.stdin.write(JSON.stringify(msg) + "\n");
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params) {
      const msg = { jsonrpc: "2.0", method, params };
      record("out", msg);
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
      const end = await exited;
      clearTimeout(timer);
      out.end();
      return end;
    }
  };
}

// Join the streamed text of one session/update kind into a string.
export function collectText(acp, kind = "agent_message_chunk") {
  let text = "";
  const off = acp.on((msg) => {
    const u = msg.params?.update;
    if (msg.method === "session/update" && u?.sessionUpdate === kind && u.content?.type === "text") text += u.content.text;
  });
  return { get text() { return text; }, stop: off };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
