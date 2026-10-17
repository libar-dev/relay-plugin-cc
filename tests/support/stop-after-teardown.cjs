// Preloaded into a worker (NODE_OPTIONS=--require): once a job.json write fails an attempt with
// an error that starts with RELAY_TEST_STOP_WHEN, it stops this process with SIGSTOP right after
// the write numbered RELAY_TEST_STOP_AFTER from there (0: that write itself), and leaves
// RELAY_TEST_STOP_FILE so a test can kill it at that point.
const fs = require("node:fs");
const path = require("node:path");
const marker = process.env.RELAY_TEST_STOP_FILE;
const after = Number(process.env.RELAY_TEST_STOP_AFTER ?? 0);
const when = process.env.RELAY_TEST_STOP_WHEN ?? "";
const rename = fs.renameSync;
let count = -1;
let jobDir = null;
fs.renameSync = function renameSync(from, to) {
  const result = rename.apply(this, arguments);
  const target = String(to);
  if (!marker || fs.existsSync(marker)) return result;
  if (count === -1) {
    if (!target.endsWith(`${path.sep}job.json`)) return result;
    try {
      const failed = JSON.parse(fs.readFileSync(target, "utf8")).attempts?.some(attempt => attempt.state === "failed" && attempt.errorMessage?.startsWith(when));
      if (!failed) return result;
    } catch { return result; }
    count = 0;
    jobDir = path.dirname(target);
  } else if (target.startsWith(jobDir + path.sep)) {
    count += 1;
  }
  if (count === after) {
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, after, target }));
    process.kill(process.pid, "SIGSTOP");
  }
  return result;
};
