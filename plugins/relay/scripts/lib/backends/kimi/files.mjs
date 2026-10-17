// The file reads a read-only Kimi job serves (ACP `fs/read_text_file`). Once the client declares
// reads, which read-only must or an append goes past the refused write, Kimi's file adapter sends
// every text read here. A read opens without blocking and serves only a regular file of bounded
// size, judged on the opened descriptor, so a FIFO, a device, or a symlink to either is refused
// at once and never holds the worker. Reads in flight are bounded and belong to the connection:
// its close aborts them and waits for them. There is no allowlist: Kimi's modes are not a sandbox.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const MAX_BYTES = Number(process.env.RELAY_JOBS_KIMI_READ_MAX_BYTES) || 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const CHUNK = 64 * 1024;

/** A read relay refuses or cannot serve, with its JSON-RPC error code. */
export class ReadRefused extends Error {
  constructor(code, message) {
    super(message);
    this.rpcCode = code;
  }
}

function kindOf(stat) {
  if (stat.isFIFO()) return "a FIFO";
  if (stat.isCharacterDevice()) return "a character device";
  if (stat.isBlockDevice()) return "a block device";
  if (stat.isSocket()) return "a socket";
  if (stat.isDirectory()) return "a directory";
  return "not a regular file";
}

const positive = value => value == null || (Number.isInteger(value) && value >= 1);

export class KimiFileReads {
  constructor({ open = (file, flags) => fs.promises.open(file, flags), maxBytes = MAX_BYTES, maxInFlight = MAX_IN_FLIGHT } = {}) {
    this.open = open;
    this.maxBytes = maxBytes;
    this.maxInFlight = maxInFlight;
    /** @type {Set<Promise<string>>} */
    this.inFlight = new Set();
    this.controller = new AbortController();
  }

  /** @param {{ path?: string, line?: number, limit?: number }} [params] */
  async serve(params = {}) {
    if (this.controller.signal.aborted) throw new ReadRefused(-32603, "The connection is closing.");
    if (this.inFlight.size >= this.maxInFlight) throw new ReadRefused(-32603, `Relay serves at most ${this.maxInFlight} file reads at once.`);
    const read = this.read(params);
    this.inFlight.add(read);
    try { return await read; }
    finally { this.inFlight.delete(read); }
  }

  /** @param {{ path?: string, line?: number, limit?: number }} params */
  async read({ path: file, line, limit }) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new ReadRefused(-32602, `Invalid params: path must be absolute: ${file}`);
    if (!positive(line) || !positive(limit)) throw new ReadRefused(-32602, "Invalid params: line and limit must be positive integers.");
    let handle;
    try { handle = await this.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
    catch (error) {
      if (error.code === "ENOENT") throw new ReadRefused(-32002, `Resource not found: ${file}`);
      throw new ReadRefused(-32603, error.message);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ReadRefused(-32000, `This job is read-only: relay serves only regular files, and ${file} is ${kindOf(stat)}.`);
      if (stat.size > this.maxBytes) throw new ReadRefused(-32000, `This job is read-only: relay serves files up to ${this.maxBytes} bytes, and ${file} has ${stat.size}.`);
      const chunks = [];
      let total = 0;
      for (;;) {
        if (this.controller.signal.aborted) throw new ReadRefused(-32603, "The connection is closing.");
        const buffer = Buffer.alloc(CHUNK);
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > this.maxBytes) throw new ReadRefused(-32000, `This job is read-only: relay serves files up to ${this.maxBytes} bytes, and ${file} grew past that.`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const content = Buffer.concat(chunks).toString("utf8");
      if (line == null && limit == null) return content;
      const lines = content.split(/(?<=\n)/);
      const start = (line ?? 1) - 1;
      return lines.slice(start, limit == null ? undefined : start + limit).join("");
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Abort the reads in flight and wait for them; refuse any read after. */
  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }
}
