// Kimi's own record of a session: `<home>/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`.
// Kimi appends each batch with a durable write within milliseconds of the event. The ACP stream
// alone cannot carry a turn's outcome: Kimi answers `end_turn` for a turn that failed, and sends
// nothing for a turn it starts on its own (a background task finishing). This record has both.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export function wireFile(home, sessionId) {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(sessionId ?? "")) return null;
  const root = path.join(home, "sessions");
  let buckets = [];
  try { buckets = fs.readdirSync(root); } catch { return null; }
  for (const bucket of buckets) {
    const file = path.join(root, bucket, sessionId, "agents", "main", "wire.jsonl");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function wireSize(file) {
  try { return file ? fs.statSync(file).size : 0; } catch { return 0; }
}

// Reads the records appended since `from`, a byte offset taken earlier. A last line without its
// newline waits for the next read. A fragment at `from`, the tail of an earlier record, never
// parses as a record, and is skipped with every line that does not parse.
export class WireCursor {
  constructor(file, from = 0) {
    this.file = file;
    this.offset = from;
    this.decoder = new StringDecoder("utf8");
    this.rest = "";
    /** @type {any[]} */
    this.records = [];
  }

  read() {
    if (!this.file) return this.records;
    let fd;
    try { fd = fs.openSync(this.file, "r"); }
    catch (error) { if (error.code === "ENOENT") return this.records; throw error; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= this.offset) return this.records;
      const buffer = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      this.rest += this.decoder.write(buffer.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.records.push(JSON.parse(line)); } catch { /* a line Kimi itself could not load either */ }
    }
    return this.records;
  }
}

export function readWire(file, from = 0) {
  return new WireCursor(file, from).read();
}

export function promptText(input) {
  return (Array.isArray(input) ? input : []).filter(part => part?.type === "text").map(part => part.text ?? "").join("");
}

const userPrompt = record => record.type === "turn.prompt" && record.origin?.kind === "user";

/** How many user prompts with exactly this text the session holds. */
export function countPrompts(records, text) {
  return records.filter(record => userPrompt(record) && promptText(record.input) === text).length;
}

/** The turn that ran a prompt: its ids, its end once recorded, and its report. */
export function promptTurn(records, text) {
  const index = records.findIndex(record => userPrompt(record) && promptText(record.input) === text);
  if (index === -1) return null;
  const prompt = records[index];
  let report = "";
  let didWork = false;
  let ended = null;
  for (const record of records.slice(index + 1)) {
    if (record.type === "turn.ended" && record.turnId === prompt.turnId) {
      ended = record;
      break;
    }
    const message = record.type === "agent.message.appended" ? record.message?.message : null;
    if (message?.role === "tool") didWork = true;
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
    if (text) didWork = true;
    // The report is the text after the turn's last tool call, as on the other backends.
    if (message.toolCalls?.length) {
      didWork = true;
      report = "";
    } else {
      report += text;
    }
  }
  return { promptId: prompt.promptId ?? null, turnId: prompt.turnId, ended, report, didWork };
}

/** The turn Kimi is running, if any: the last one started and not ended. */
export function openTurn(records) {
  let open = null;
  for (const record of records) {
    if (record.type === "agent.turn.started") open = record.turnId;
    else if (record.type === "turn.ended" && record.turnId === open) open = null;
  }
  return open;
}
