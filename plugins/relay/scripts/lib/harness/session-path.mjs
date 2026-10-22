import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { backendWith } from "../backends/index.mjs";
import { ensureAbsolutePath } from "../util/fs.mjs";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  let requestedPath = options.source;
  if (!requestedPath) {
    const id = process.env.RELAY_COMPANION_SESSION_ID;
    if (!id) {
      throw new Error("Could not identify the current Claude session. Retry with --source <path-to-claude-jsonl>.");
    }
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.exec(id)?.[0] !== id) {
      throw new Error(`Invalid Claude session id: ${id}. Retry with --source <path-to-claude-jsonl>.`);
    }
    let folders;
    try {
      folders = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      folders = [];
    }
    const matches = folders.filter((entry) => entry.isDirectory())
      .map((entry) => path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`))
      .filter((file) => {
        try { return fs.statSync(file).isFile(); }
        catch (error) { if (error.code !== "ENOENT") throw error; return false; }
      }).sort();
    if (matches.length === 0) {
      throw new Error(`Could not find the transcript of Claude session ${id} in ~/.claude/projects. Retry with --source <path-to-claude-jsonl>.`);
    }
    if (matches.length > 1) {
      throw new Error(`Found several transcripts of Claude session ${id}: ${matches.join(", ")}. Retry with --source <path-to-claude-jsonl>.`);
    }
    requestedPath = matches[0];
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${backendWith("transfer").label} can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}
