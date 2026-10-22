#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf 'Usage: uninstall-local.sh DIR\nRemove the local relay smoke build using the marketplace name in its install receipt (default: relay-smoke).\n'
  exit 0
fi
[[ $# == 1 && -d $1 ]] || { printf 'Usage: uninstall-local.sh DIR\n' >&2; exit 2; }
dir=$(cd -- "$1" && pwd -P)
if top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null); then
  top=$(cd -- "$top" && pwd -P)
  [[ $dir == "$top" ]] || { printf 'DIR must be the git work tree top level: %s\n' "$top" >&2; exit 2; }
fi
# The Claude config directory that holds the plugin registry and cache. A set CLAUDE_CONFIG_DIR is
# made absolute, since the claude commands below run from DIR. An unset one stays unset: with it set
# to ~/.claude, Claude Code reads ~/.claude/.claude.json as its global config instead of
# ~/.claude.json, starts a fresh one there and runs its settings migrations again.
RELAY_SMOKE_CONFIG=$(node -e 'const p = require("node:path"), fs = require("node:fs"); const dir = p.resolve(process.env.CLAUDE_CONFIG_DIR || p.join(require("node:os").homedir(), ".claude")); console.log(fs.existsSync(dir) ? fs.realpathSync(dir) : dir)')
export RELAY_SMOKE_CONFIG
if [[ -n ${CLAUDE_CONFIG_DIR:-} ]]; then export CLAUDE_CONFIG_DIR=$RELAY_SMOKE_CONFIG; fi
# Resolve user state before changing cwd; project files never supply the receipt.
RELAY_SMOKE_RECEIPT=$(node - "$dir" <<'NODE'
const path = require('node:path'), os = require('node:os'), { createHash } = require('node:crypto');
const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state');
const hash = createHash('sha256').update(process.argv[2]).digest('hex');
console.log(path.resolve(state, 'relay-plugin-cc/smoke-installs', `${hash}.json`));
NODE
)
export RELAY_SMOKE_RECEIPT
marketplace_guard=$(cat <<'NODE'
function marketplaceProblem(saved, installLocation) {
  const mkt = saved.marketplace, temp = saved.tempDirectory;
  if (typeof mkt !== 'string' || !path.isAbsolute(mkt) || mkt !== installLocation) {
    return `receipt path does not match the registered ${saved.name} installLocation`;
  }
  if (typeof temp !== 'string' || !path.isAbsolute(temp) || path.dirname(mkt) !== temp ||
      !path.basename(mkt).startsWith('relay-smoke-mkt-')) {
    return 'path is not a relay-smoke-mkt-* direct child of the recorded temp directory';
  }
  try {
    if (fs.realpathSync(temp) !== temp || fs.realpathSync(mkt) !== mkt) {
      return 'marketplace or temp directory resolves to a different path';
    }
    const manifest = path.join(mkt, '.claude-plugin/marketplace.json');
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== saved.name) {
      return `marketplace manifest name is not ${saved.name}`;
    }
  } catch {
    return 'marketplace directory or manifest is missing or unreadable';
  }
  return null;
}
NODE
)
# Feed the same guard to both checks without reading executable code from the project.
cleanup_node() {
  { printf '%s\n' "$marketplace_guard"; cat; } | node - "$@"
}
# Require ownership evidence before any mutation or Claude command.
state=$(cleanup_node "$dir" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = process.argv[2], home = fs.realpathSync(os.homedir()), config = process.env.RELAY_SMOKE_CONFIG;
if (dir === home || dir === config) throw new Error('Refusing HOME or the Claude config directory.');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (fs.lstatSync(path.join(dir, '.claude/relay-smoke-local.json'), { throwIfNoEntry: false })) {
  throw new Error('Legacy project install receipt found; leaving it and changing nothing.');
}
for (const name of ['.claude', '.claude/settings.local.json']) {
  if (fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing project symlink: ${name}`);
  }
}
const settings = read(path.join(dir, '.claude/settings.local.json'));
const marker = process.env.RELAY_SMOKE_RECEIPT;
const saved = read(marker);
if (!Object.hasOwn(saved, 'name')) saved.name = 'relay-smoke';
if (typeof saved.name !== 'string' || saved.name.match(/^relay-smoke(-[a-z0-9]+)*$/)?.[0] !== saved.name) {
  throw new Error('Invalid receipt name; refusing to change anything.');
}
const entries = read(path.join(config, 'plugins/installed_plugins.json')).plugins?.[`relay@${saved.name}`] ?? [];
const marketplace = read(path.join(config, 'plugins/known_marketplaces.json'))[saved.name];
if (saved.tool !== 'relay-plugin-cc/scripts/smoke/install-local.sh') {
  throw new Error('No valid install receipt; refusing to change anything. Found: ' + JSON.stringify({
    receipt: fs.existsSync(marker), installations: entries, marketplace: marketplace ?? null,
    enabledPlugins: settings.enabledPlugins ?? {}, extraKnownMarketplaces: settings.extraKnownMarketplaces ?? {},
    cache: fs.existsSync(path.join(config, 'plugins/cache', saved.name))
  }));
}
if (saved.dir !== dir) throw new Error('Receipt is for a different DIR; refusing to change anything.');
if (saved.config !== config) throw new Error('Receipt uses a different Claude config directory; use the original CLAUDE_CONFIG_DIR.');
for (const key of ['createdMarketplace', 'createdCache', 'createdSettingsFile', 'createdClaudeDirectory',
  'hadPreviousRelay', 'addedMarketplace', 'installedPlugin', 'disabledRelay']) {
  if (typeof saved[key] !== 'boolean') throw new Error(`Invalid receipt field: ${key}`);
}
if (entries.some(e => e.scope !== 'local' || !e.projectPath || path.resolve(e.projectPath) !== dir)) {
  throw new Error(`${saved.name} has an installation outside this directory; refusing to remove its marketplace.`);
}
// The registry, not addedMarketplace, tells us whether a partially failed add registered the name.
const problem = marketplaceProblem(saved, marketplace?.installLocation);
if (problem) throw new Error(`Leaving ${saved.name} and keeping its receipt; changing nothing: ${problem}.`);
console.log(saved.name);
console.log(saved.installedPlugin && entries.length ? 'installed' : 'absent');
console.log(marketplace ? 'marketplace' : 'absent');
console.log(JSON.stringify({ saved, registeredMarketplace: !!marketplace }));
NODE
)
# Four lines: the name, the plugin step, the marketplace step, the saved state as JSON. Plain reads, since
# macOS's /bin/bash is 3.2 and has no mapfile.
{ IFS= read -r name; IFS= read -r plugin_step; IFS= read -r marketplace_step; IFS= read -r saved_state; } <<< "$state"
cd -- "$dir"
if [[ $plugin_step == installed ]]; then claude plugin uninstall "relay@$name" --scope local; fi
if [[ $marketplace_step == marketplace ]]; then claude plugin marketplace remove "$name"; fi
cleanup_node "$dir" "$saved_state" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2], file = path.join(dir, '.claude/settings.local.json');
const marker = process.env.RELAY_SMOKE_RECEIPT;
const { saved, registeredMarketplace } = JSON.parse(process.argv[3]);
const registry = path.join(process.env.RELAY_SMOKE_CONFIG, 'plugins/known_marketplaces.json');
const marketplace = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8'))[saved.name] : null;
// Even a successful CLI exit must actually remove the registration before its folder can be deleted.
if (marketplace) throw new Error(`Leaving ${saved.name} and keeping its marketplace folder and receipt: the name is still registered.`);
const problem = marketplaceProblem(saved, saved.marketplace);
if (problem) throw new Error(`Leaving ${saved.name} and keeping its receipt: ${problem}.`);
if (fs.existsSync(file)) {
  const original = fs.readFileSync(file, 'utf8'), settings = JSON.parse(original);
  const before = JSON.stringify(settings);
  if (settings.enabledPlugins) {
    if (saved.installedPlugin) delete settings.enabledPlugins[`relay@${saved.name}`];
    if (saved.disabledRelay) {
      if (saved.hadPreviousRelay) settings.enabledPlugins['relay@libar-relay'] = saved.previousRelay;
      else delete settings.enabledPlugins['relay@libar-relay'];
    }
    if (!Object.keys(settings.enabledPlugins).length) delete settings.enabledPlugins;
  }
  if (settings.extraKnownMarketplaces) {
    if (saved.addedMarketplace || registeredMarketplace) delete settings.extraKnownMarketplaces[saved.name];
    if (!Object.keys(settings.extraKnownMarketplaces).length) delete settings.extraKnownMarketplaces;
  }
  if (saved.createdSettingsFile && !Object.keys(settings).length) fs.rmSync(file);
  else if (JSON.stringify(settings) !== before) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
if (saved.createdCache) {
  fs.rmSync(path.join(process.env.RELAY_SMOKE_CONFIG, 'plugins/cache', saved.name), { recursive: true, force: true });
}
if (saved.createdMarketplace) fs.rmSync(saved.marketplace, { recursive: true, force: true });
fs.rmSync(marker);
const local = path.join(dir, '.claude');
if (saved.createdClaudeDirectory && fs.readdirSync(local).length === 0) fs.rmdirSync(local);
NODE
printf 'Removed local relay smoke installation from %s\n' "$dir"
