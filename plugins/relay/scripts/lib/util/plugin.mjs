// The plugin's own version, from its manifest: the backends' client info and each attempt's record.
import fs from "node:fs";

const MANIFEST_URL = new URL("../../../.claude-plugin/plugin.json", import.meta.url);

export const PLUGIN_VERSION = JSON.parse(fs.readFileSync(MANIFEST_URL, "utf8")).version ?? "0.0.0";
