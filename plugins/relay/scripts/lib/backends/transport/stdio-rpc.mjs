/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("../codex/protocol").AppServerMethod} AppServerMethod
 * @typedef {import("../codex/protocol").AppServerNotification} AppServerNotification
 * @typedef {import("../codex/protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("../codex/protocol").ClientInfo} ClientInfo
 * @typedef {import("../codex/protocol").ServerClientOptions} ServerClientOptions
 * @typedef {import("../codex/protocol").InitializeCapabilities} InitializeCapabilities
 */
import { default as fs } from "node:fs";
import { default as process } from "node:process";
import { spawn } from "node:child_process";


const PLUGIN_MANIFEST_URL = new URL("../../../../.claude-plugin/plugin.json", import.meta.url);

const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));


/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Relay Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};


/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};


const STDERR_TAIL_BYTES = 4096;

// How long the client keeps reading after the server process exits while something else
// (a child of the server) still holds its stdout open.
const EXIT_DRAIN_MS = 200;


// The end message's note on a final stdout fragment without a newline; every backend keeps it.
export function partialLineNote(info, subject = "the app-server's output") {
  return info?.partialStdoutBytes ? ` ${subject} ended mid-line after ${info.partialStdoutBytes} bytes.` : "";
}


function serverEndMessage(info, backendName = "codex") {
  const how = info?.signal ? `signal ${info.signal}` : `exit ${info?.code ?? "unknown"}`;
  return `${backendName} server ended before turn/completed (${how}).${info?.pid ? ` pid ${info.pid}.` : ""}${partialLineNote(info)}`;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}


function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}


class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.transportEnded = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    /** Called with every notification before the handler; never replaced by turn capture. */
    this.notificationTap = options.notificationTap ?? null;
    this.exitInfo = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @this {AppServerClientBase & { exitSeen?: boolean }}
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("../codex/protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("../codex/protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error(`${this.options.backendName ?? "codex"} server client is closed.`);
    }
    // A request to a server that has exited would never settle: reject it at once, whether
    // or not its stdout has closed yet.
    if (this.exitResolved || this.exitSeen) {
      return Promise.reject(this.exitError ?? createProtocolError(serverEndMessage(this.exitInfo, this.options.backendName)));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });

  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse ${this.options.backendName ?? "codex"} server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `${this.options.backendName ?? "codex"} server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationTap) {
      try {
        this.notificationTap(/** @type {AppServerNotification} */ (message));
      } catch {
        // A failing tap must never break the protocol stream.
      }
    }

    if (message.method && this.notificationHandler) {
      try {
        this.notificationHandler(/** @type {AppServerNotification} */ (message));
      } catch (error) {
        // One malformed notification must not crash the process that owns the job.
        process.stderr.write(`Ignored a notification the client could not handle (${message.method}): ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  tap(message) {
    try { this.notificationTap?.(message); } catch { /* Event recording cannot break the stream. */ }
  }

  handleServerRequest(message) {
    if (this.options.onServerRequest) {
      this.options.onServerRequest(message, this);
      return;
    }
    this.tap({ method: "codex/serverRequestRejected", params: { method: message.method, id: message.id, code: -32601 } });
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error(`${this.options.backendName ?? "codex"} server connection closed.`));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}


export class SpawnedServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
    // Schedules the drain after the process exits; a test replaces it to control the timer.
    /** @type {((callback: () => void, ms: number) => any) | null} */
    this.setTimer = null;
  }

  async initialize() {
    this.proc = spawn(this.options.binary ?? "codex", this.options.args ?? ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // `processGroup`: the server leads its own group, which its owner ends (setup's checks).
      detached: Boolean(this.options.processGroup)
    });
    this.processEndPromise = new Promise((resolve) => { this.resolveProcessEnd = resolve; });

    this.proc.stdout.setEncoding("utf8");
    this.options.onSpawn?.(this.proc);

    this.proc.stderr.on("data", (chunk) => {
      this.stderrBuffer = Buffer.concat([this.stderrBuffer ?? Buffer.alloc(0), chunk]).subarray(-STDERR_TAIL_BYTES);
      this.stderr = this.stderrBuffer.toString("utf8");
      this.options.onStderr?.(chunk);
    });

    this.proc.on("error", (error) => {
      this.spawnError = error;
    });

    this.proc.on("exit", (code, signal) => this.handleProcessExit(code, signal));

    this.proc.stdout.on("data", (chunk) => this.handleChunk(chunk));
    this.proc.stdout.on("end", () => {
      this.transportEnded = true;
      this.stdoutClosedBeforeExit = !this.exitSeen;
      this.partialStdoutBytes = Buffer.byteLength(this.lineBuffer, "utf8");
      this.lineBuffer = "";
      // EOF can arrive while the process is still alive. Stop it so pending requests
      // get the actual exit details, even if it left stderr or its event loop open.
      if (!this.exitSeen) void this.close();
    });
    this.proc.on("close", (code, signal) => {
      clearTimeout(this.drainTimer);
      this.exitInfo = {
        pid: this.proc.pid ?? null, code, signal, endedAt: new Date().toISOString(),
        stdoutClosedBeforeExit: Boolean(this.stdoutClosedBeforeExit),
        partialStdoutBytes: this.partialStdoutBytes ?? 0,
        stderrTail: this.stderr
      };
      this.options.onEnd?.(this.exitInfo);
      this.handleExit(this.spawnError ?? createProtocolError(serverEndMessage(this.exitInfo, this.options.backendName)));
      this.resolveProcessEnd();
    });
    this.proc.stdin.on("error", () => {}); // EPIPE is reported by the process end.

    await this.request(this.options.initializeMethod ?? "initialize", this.options.initializeParams ?? {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    if (!this.options.initializeParams) this.notify("initialized", {});
  }

  // A child of the server can keep stdout, stderr or both open after the server exits. Read
  // what the server wrote for EXIT_DRAIN_MS, then close both pipes, whichever reached EOF
  // already, so the end is recorded and pending requests settle. `setTimer` is replaceable.
  handleProcessExit(code, signal) {
    this.exitSeen = true;
    this.exitInfo = { code, signal };
    this.drainTimer = (this.setTimer ?? setTimeout)(() => this.drainAfterExit(), EXIT_DRAIN_MS);
  }

  drainAfterExit() {
    if (this.exitResolved) return;
    if (!this.transportEnded) {
      this.partialStdoutBytes = Buffer.byteLength(this.lineBuffer, "utf8");
      this.lineBuffer = "";
    }
    this.proc.stdout.destroy();
    this.proc.stderr.destroy();
  }

  async close() {
    if (this.closed) {
      await this.processEndPromise;
      return;
    }

    this.closed = true;

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          this.proc.kill("SIGTERM");
        }
      }, 50).unref?.();
    }

    await this.processEndPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(this.options.jsonrpc ? { jsonrpc: "2.0", ...message } : message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error(`${this.options.backendName ?? "codex"} server stdin is not available.`);
    }
    stdin.write(line);
  }
}
