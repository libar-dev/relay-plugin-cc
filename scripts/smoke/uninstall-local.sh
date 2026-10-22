#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf 'Usage: uninstall-local.sh DIR\nRemove the local relay smoke build and restore the previous relay setting.\n'
  exit 0
fi
[[ $# == 1 && -d $1 ]] || { printf 'Usage: uninstall-local.sh DIR\n' >&2; exit 2; }
dir=$(cd -- "$1" && pwd -P)
# Inspect the registry before removing a marketplace shared by other directories.
state=$(node - "$dir" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = process.argv[2], home = fs.realpathSync(os.homedir()), config = path.join(home, '.claude');
if (dir === home || dir === (fs.existsSync(config) ? fs.realpathSync(config) : config)) throw new Error('Refusing HOME or ~/.claude.');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const entries = read(path.join(config, 'plugins/installed_plugins.json')).plugins?.['relay@relay-smoke'] ?? [];
if (entries.some(e => e.scope !== 'local' || !e.projectPath || path.resolve(e.projectPath) !== dir)) {
  throw new Error('relay-smoke has an installation outside this directory; refusing to remove its marketplace.');
}
const settings = read(path.join(dir, '.claude/settings.local.json'));
const owned = entries.length || Object.hasOwn(settings.enabledPlugins ?? {}, 'relay@relay-smoke') ||
  fs.existsSync(path.join(dir, '.claude/relay-smoke-local.json'));
if (!owned) { console.log('unowned'); process.exit(0); }
console.log(entries.length ? 'installed' : 'absent');
console.log(owned && read(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke'] ? 'marketplace' : 'absent');
NODE
)
if [[ $state == unowned ]]; then
  printf 'No local relay smoke installation in %s\n' "$dir"
  exit 0
fi
cd -- "$dir"
if [[ $state == installed$'\n'* ]]; then claude plugin uninstall relay@relay-smoke --scope local; fi
if [[ $state == *$'\n'marketplace ]]; then claude plugin marketplace remove relay-smoke; fi
node - "$dir" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = process.argv[2], file = path.join(dir, '.claude/settings.local.json');
const marker = path.join(dir, '.claude/relay-smoke-local.json');
const saved = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
if (fs.existsSync(file)) {
  const original = fs.readFileSync(file, 'utf8'), settings = JSON.parse(original);
  const before = JSON.stringify(settings);
  if (settings.enabledPlugins) {
    delete settings.enabledPlugins['relay@relay-smoke'];
    if (settings.enabledPlugins['relay@libar-relay'] === false) {
      if (saved?.previousRelay !== null && saved?.previousRelay !== undefined) {
        settings.enabledPlugins['relay@libar-relay'] = saved.previousRelay;
      } else delete settings.enabledPlugins['relay@libar-relay'];
    }
    if (!Object.keys(settings.enabledPlugins).length) delete settings.enabledPlugins;
  }
  if (JSON.stringify(settings) !== before) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
fs.rmSync(path.join(os.homedir(), '.claude/plugins/cache/relay-smoke'), { recursive: true, force: true });
fs.rmSync(marker, { force: true });
// The exported marketplace stays in /tmp so a failed smoke run can still be inspected.
NODE
printf 'Removed local relay smoke installation from %s\n' "$dir"
