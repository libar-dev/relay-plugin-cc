#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf 'Usage: uninstall-local.sh DIR\nRemove the local relay smoke build using its install receipt.\n'
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
# Require ownership evidence before any mutation or Claude command.
state=$(node - "$dir" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = process.argv[2], home = fs.realpathSync(os.homedir()), config = process.env.RELAY_SMOKE_CONFIG;
if (dir === home || dir === config) throw new Error('Refusing HOME or the Claude config directory.');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const entries = read(path.join(config, 'plugins/installed_plugins.json')).plugins?.['relay@relay-smoke'] ?? [];
const marketplace = read(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke'];
const settings = read(path.join(dir, '.claude/settings.local.json'));
const marker = path.join(dir, '.claude/relay-smoke-local.json');
const saved = read(marker);
if (saved.tool !== 'relay-plugin-cc/scripts/smoke/install-local.sh') {
  console.error('No valid install receipt. Found: ' + JSON.stringify({
    receipt: fs.existsSync(marker), installations: entries, marketplace: marketplace ?? null,
    enabledPlugins: settings.enabledPlugins ?? {}, extraKnownMarketplaces: settings.extraKnownMarketplaces ?? {},
    cache: fs.existsSync(path.join(config, 'plugins/cache/relay-smoke'))
  }));
  throw new Error('Refusing to change anything without this tool\'s install receipt.');
}
if (saved.config !== config) throw new Error('Receipt uses a different Claude config directory; use the original CLAUDE_CONFIG_DIR.');
for (const key of ['createdMarketplace', 'createdCache', 'createdSettingsFile', 'createdClaudeDirectory',
  'hadPreviousRelay', 'addedMarketplace', 'installedPlugin', 'disabledRelay']) {
  if (typeof saved[key] !== 'boolean') throw new Error(`Invalid receipt field: ${key}`);
}
if (typeof saved.marketplace !== 'string' || !path.isAbsolute(saved.marketplace) ||
    !path.basename(saved.marketplace).startsWith('relay-smoke-mkt-')) throw new Error('Invalid marketplace receipt path.');
if (entries.some(e => e.scope !== 'local' || !e.projectPath || path.resolve(e.projectPath) !== dir)) {
  throw new Error('relay-smoke has an installation outside this directory; refusing to remove its marketplace.');
}
console.log(saved.installedPlugin && entries.length ? 'installed' : 'absent');
console.log(saved.addedMarketplace && marketplace ? 'marketplace' : 'absent');
NODE
)
cd -- "$dir"
if [[ $state == installed$'\n'* ]]; then claude plugin uninstall relay@relay-smoke --scope local; fi
if [[ $state == *$'\n'marketplace ]]; then claude plugin marketplace remove relay-smoke; fi
node - "$dir" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2], file = path.join(dir, '.claude/settings.local.json');
const marker = path.join(dir, '.claude/relay-smoke-local.json');
const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
if (fs.existsSync(file)) {
  const original = fs.readFileSync(file, 'utf8'), settings = JSON.parse(original);
  const before = JSON.stringify(settings);
  if (settings.enabledPlugins) {
    if (saved.installedPlugin) delete settings.enabledPlugins['relay@relay-smoke'];
    if (saved.disabledRelay) {
      if (saved.hadPreviousRelay) settings.enabledPlugins['relay@libar-relay'] = saved.previousRelay;
      else delete settings.enabledPlugins['relay@libar-relay'];
    }
    if (!Object.keys(settings.enabledPlugins).length) delete settings.enabledPlugins;
  }
  if (settings.extraKnownMarketplaces) {
    if (saved.addedMarketplace) delete settings.extraKnownMarketplaces['relay-smoke'];
    if (!Object.keys(settings.extraKnownMarketplaces).length) delete settings.extraKnownMarketplaces;
  }
  if (saved.createdSettingsFile && !Object.keys(settings).length) fs.rmSync(file);
  else if (JSON.stringify(settings) !== before) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
if (saved.createdCache) fs.rmSync(path.join(saved.config, 'plugins/cache/relay-smoke'), { recursive: true, force: true });
if (saved.createdMarketplace) fs.rmSync(saved.marketplace, { recursive: true, force: true });
fs.rmSync(marker);
const local = path.join(dir, '.claude');
if (saved.createdClaudeDirectory && fs.readdirSync(local).length === 0) fs.rmdirSync(local);
NODE
printf 'Removed local relay smoke installation from %s\n' "$dir"
