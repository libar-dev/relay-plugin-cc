#!/usr/bin/env node
// Writes a synthetic file for measuring how a harness shortens a tool result: lines L000001 to
// L<lines>, with a random marker word on the first, middle and last line. The markers go to
// stdout as JSON for the caller to keep; give a job the file, never the markers, and compare the
// markers it reports. See docs/harness-output-limits.md.
//
//   node scripts/tool-output-probe.mjs <file> [--lines 16000]
import crypto from "node:crypto";
import fs from "node:fs";

const [file, flag, value] = process.argv.slice(2);
const lines = flag === "--lines" ? Number(value) : 16000;
if (!file || !Number.isSafeInteger(lines) || lines < 3) {
  console.error("usage: node scripts/tool-output-probe.mjs <file> [--lines N], N at least 3");
  process.exit(1);
}
const marker = (name) => `${name}-${crypto.randomBytes(6).toString("hex")}`;
const markers = { begin: marker("BEGIN"), middle: marker("MIDDLE"), end: marker("END") };
const middle = Math.ceil(lines / 2);
const text = Array.from({ length: lines }, (_, index) => {
  const line = index + 1;
  const tag = line === 1 ? markers.begin : line === middle ? markers.middle : line === lines ? markers.end : null;
  return `L${String(line).padStart(6, "0")}${tag ? ` ${tag}` : ""}\n`;
}).join("");
fs.writeFileSync(file, text);
console.log(JSON.stringify({ file, lines, bytes: Buffer.byteLength(text), middleLine: middle, markers }));
