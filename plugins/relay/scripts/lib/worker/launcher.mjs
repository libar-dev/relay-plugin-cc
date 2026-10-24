// A short-lived parent is required even with a scope: cgroups do not change PPID ancestry.
// The worker acknowledges only after this launcher has exited. Until then it runs no backend.
import fs from "node:fs";
import { registerWorker } from "./registry.mjs";
import { spawn } from "node:child_process";
import { inOwnUserScope, readProcessStartTime } from "../util/process.mjs";
import { writeJsonAtomic, readJsonOrNull } from "../jobs/store.mjs";

const [file, companion, jobDir, cwd] = process.argv.slice(2);
const intent = readJsonOrNull(file);
writeJsonAtomic(file, { ...intent, launcher: { pid: process.pid, startTime: readProcessStartTime(process.pid) } });
const fd = fs.openSync(`${jobDir}/stderr.log`, "a");
const launch = inOwnUserScope(process.execPath, [companion, "worker", jobDir], { description: `relay job worker ${intent.jobId}` });
const child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, RELAY_WORKER_LAUNCH: file }, detached: true, stdio: ["ignore", fd, fd] });
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("spawn", () => {
  const worker = { pid: child.pid, startTime: readProcessStartTime(child.pid), jobDir };
  registerWorker(worker);
  writeJsonAtomic(file, { ...readJsonOrNull(file), worker });
  process.stdout.write(`${child.pid}\n`); child.unref(); });
fs.closeSync(fd);
