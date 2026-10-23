import fs from "node:fs";
import path from "node:path";

export function isGeneratedArgumentFile(file) {
  return path.isAbsolute(file) && path.resolve(file) === file && path.basename(file) === "args.txt"
    && /^relay-args-[A-Za-z0-9]+$/.test(path.basename(path.dirname(file)));
}

// Never recursively remove a directory or follow a directory symlink.
// A missing Write or a companion that already consumed the file makes cleanup a no-op.
export function cleanupArgumentFile(file) {
  if (!isGeneratedArgumentFile(file)) throw new Error("Not a generated relay argument file.");
  const dir = path.dirname(file);
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("Not a relay argument directory.");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(file, { force: true });
  try { fs.rmdirSync(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
