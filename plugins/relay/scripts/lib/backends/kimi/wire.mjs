// Kimi's own record of a session: `<home>/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`.
// Kimi appends each batch with a durable write within milliseconds of the event. The ACP stream
// alone cannot carry a turn's outcome: Kimi answers `end_turn` for a turn that failed, and sends
// nothing for a turn it starts on its own (a background task finishing). This record has both.
import fs from "node:fs";
import path from "node:path";

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

export function promptText(input) {
  return (Array.isArray(input) ? input : []).filter(part => part?.type === "text").map(part => part.text ?? "").join("");
}

/**
 * @typedef {{ turnId: number, origin: string | null, promptId: string | null, ended: any, report: string, didWork: boolean }} KimiTurn
 * @typedef {{ promptId: string, at: number, text: string | null, turnId: number | null, started: boolean }} KimiPrompt
 */

const NEWLINE = 0x0a;

// The session's record as it grows: one reader per connection, advanced by byte offset. A line
// without its newline, with any UTF-8 character it splits, waits in its bytes for the next read,
// so a record written across two reads is still read once, whole. Every read updates one state:
// each turn by Kimi's turn id, each prompt relay sent by Kimi's prompt id, and the turn running.
export class KimiWire {
  /** @param {() => string | null} locate */
  constructor(locate) {
    this.locate = locate;
    /** @type {string | null} */
    this.file = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    /** @type {Map<number, KimiTurn>} */
    this.turns = new Map();
    /** @type {Map<string, KimiPrompt>} */
    this.prompts = new Map();
    /** @type {number | null} */
    this.running = null;
  }

  /** The byte offset just past the last whole record read. */
  get consumed() { return this.offset - this.partial.length; }

  /** Whether a turn runs now: Kimi's own or one relay sent. */
  get busy() { return this.running !== null; }

  read() {
    this.file ??= this.locate();
    if (!this.file) return this;
    let fd;
    try { fd = fs.openSync(this.file, "r"); }
    catch (error) { if (error.code === "ENOENT") return this; throw error; }
    let chunk;
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= this.offset) return this;
      chunk = Buffer.alloc(size - this.offset);
      chunk = chunk.subarray(0, fs.readSync(fd, chunk, 0, chunk.length, this.offset));
    } finally {
      fs.closeSync(fd);
    }
    const start = this.consumed;
    const bytes = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    this.offset += chunk.length;
    let from = 0;
    for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, from)) {
      const line = bytes.subarray(from, end).toString("utf8");
      const at = start + from;
      from = end + 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; /* a line Kimi itself could not load either */ }
      this.apply(record, at);
    }
    this.partial = Buffer.from(bytes.subarray(from));
    return this;
  }

  // A new server process: a turn the record left open belonged to one that died.
  forgetRunning() { this.running = null; }

  /** The first prompt relay sent with this text, recorded at or after byte `from`. */
  promptSince(from, text) {
    for (const prompt of this.prompts.values()) {
      if (prompt.at >= from && prompt.text === text) return prompt;
    }
    return null;
  }

  /** How many prompts relay sent with exactly this text the record holds. */
  count(text) {
    let count = 0;
    for (const prompt of this.prompts.values()) if (prompt.text === text) count += 1;
    return count;
  }

  /** @returns {KimiTurn} */
  turn(turnId) {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { turnId, origin: null, promptId: null, ended: null, report: "", didWork: false };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  /** @returns {KimiPrompt} */
  prompt(promptId, at) {
    let prompt = this.prompts.get(promptId);
    if (!prompt) {
      prompt = { promptId, at, text: null, turnId: null, started: false };
      this.prompts.set(promptId, prompt);
    }
    return prompt;
  }

  apply(record, at) {
    switch (record.type) {
      case "agent.turn.started":
        this.turn(record.turnId);
        this.running = record.turnId;
        return;
      case "turn.prompt": {
        const turn = this.turn(record.turnId);
        turn.origin = record.origin?.kind ?? null;
        if (!turn.ended) this.running = record.turnId;
        if (turn.origin !== "user" || typeof record.promptId !== "string") return;
        const prompt = this.prompt(record.promptId, at);
        prompt.text ??= promptText(record.input);
        prompt.turnId = record.turnId;
        prompt.started = true;
        turn.promptId = record.promptId;
        return;
      }
      case "turn.ended": {
        this.turn(record.turnId).ended = record;
        if (this.running === record.turnId) this.running = null;
        return;
      }
      case "agent.message.appended": {
        const message = record.message?.message;
        const turn = this.running === null ? null : this.turns.get(this.running);
        if (!turn || !message) return;
        if (message.role === "tool") turn.didWork = true;
        if (message.role !== "assistant") return;
        const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
        if (text) turn.didWork = true;
        // The report is the text after the turn's last tool call, as on the other backends.
        if (message.toolCalls?.length) {
          turn.didWork = true;
          turn.report = "";
        } else {
          turn.report += text;
        }
        return;
      }
    }
  }
}
