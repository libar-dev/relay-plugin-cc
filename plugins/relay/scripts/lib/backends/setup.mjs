import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { endProcessGroup, runLimited } from "../util/process.mjs";

export function seconds(ms) {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

export function userDir(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
}

export function lastLine(text) {
  return String(text ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? "";
}

export function isDirectory(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

export function realpathOr(file) {
  try { return fs.realpathSync.native(file); } catch { return path.resolve(file); }
}

export function isScript(file) {
  if (!file) return false;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(2);
    return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function executablesOnPath(name, env) {
  const found = [];
  for (const dir of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      found.push(fs.realpathSync(candidate));
    } catch {}
  }
  return [...new Set(found)];
}

export function commandFailure(name, result, limitMs) {
  if (result.timedOut) return `${name}: no answer in ${seconds(limitMs)}`;
  if (result.error) return `${name}: ${result.error.message}`;
  if (result.status !== 0 || result.signal) {
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    return [`${name} failed (${how}).`, firstLine(result.stderr)].filter(Boolean).join(" ");
  }
  return null;
}

export function emptyBlock(home, capabilities) {
  return {
    backend: home.backend, home: home.home, homeDefault: home.homeDefault, selector: home.selector,
    binary: null, binaryIsScript: false, realBinary: null, version: null,
    signIn: { state: "unknown", method: null, detail: null },
    model: null, modelNote: null, effort: null, effortNote: null, modelsReason: null, models: [],
    can: setupCapabilities(capabilities),
    warnings: [], ready: false, error: null, elapsedMs: 0
  };
}

export function notInstalled(block, detail) {
  block.signIn = { state: "not-installed", method: null, detail };
  block.modelsReason = "not installed";
  return block;
}

// The server runs in its own process group (`processGroup`), and the whole group goes when
// the check ends, however it ends: a wrapper's children and a server's own leave nothing behind.
export async function closeWithin(client, ms) {
  let timer;
  await Promise.race([
    client.close().catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, ms); })
  ]);
  clearTimeout(timer);
  if (client.proc && client.proc.exitCode === null && client.proc.signalCode === null) {
    try { client.proc.kill("SIGKILL"); } catch {}
  }
  if (client.proc?.pid) endProcessGroup(client.proc.pid);
}

export function effortName(entry) {
  const name = entry && typeof entry === "object" ? entry.reasoningEffort : entry;
  return typeof name === "string" && name ? name : null;
}

export function versionOf(binary, name, cwd, env, limits) {
  if (!binary) return Promise.resolve({ text: null, error: null });
  return runLimited(binary, ["--version"], { cwd, env, timeoutMs: limits.commandMs }).then(result => {
    const error = commandFailure(`${name} --version`, result, limits.commandMs);
    return { text: result.stdout.trim().replace(/\r?\n/g, ", ") || null, error };
  });
}

export function tryResolve(resolver, env) {
  try { return resolver(env); } catch { return null; }
}

// The public setup JSON keeps its fields while search support comes from the backend list.
/** @param {import("./types").Capabilities} can */
function setupCapabilities(can) {
  return {
    modes: can.modes, steer: can.steer, resume: can.resume, webSearchOff: can.webSearch.includes("disabled"),
    review: can.review, adversarialReview: can.adversarialReview, stopGate: can.stopGate, transfer: can.transfer
  };
}
