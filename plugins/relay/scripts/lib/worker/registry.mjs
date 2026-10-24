import fs from "node:fs";
import path from "node:path";
import { admissionEnabled, admissionHome } from "./admission.mjs";
import { writeJsonAtomic } from "../jobs/store.mjs";

export function registerWorker(worker, { env = process.env, platform = process.platform } = {}) {
  if (!["linux", "darwin"].includes(platform)) return null;
  const directory = `${admissionHome(env)}.workers`;
  const file = path.join(directory, `${worker.pid}.json`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    writeJsonAtomic(file, worker);
    return file;
  } catch (error) {
    if (admissionEnabled(env, undefined, platform)) throw error;
    // Guard-off launches cannot require admission storage. The launch intent and its
    // reparenting acknowledgement remain mandatory writes in the job's own directory.
    return null;
  }
}
