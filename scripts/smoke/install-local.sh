#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-local.sh DIR [--ref REF] [--repo PATH] [--worktree]
Install relay@relay-smoke for DIR only. REF defaults to HEAD.
DIR must be a git work tree root or outside any git work tree.
The default build uses git archive and excludes uncommitted edits.
--worktree copies plugins/relay, including uncommitted edits, except the declarations Claude Code
           writes there (.claude-plugin/types/ and tsconfig.json).
--ref and --worktree cannot be combined. Requires bash, git, tar, node and claude.
EOF
}
die() { printf '%s\n' "$*" >&2; exit 2; }
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $# -ge 1 && $1 != --* ]] || { usage >&2; exit 2; }
dir=$1; shift
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/../.." && pwd -P)
ref=HEAD
ref_set=false
worktree=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref|--repo)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 requires a value."
      if [[ $1 == --ref ]]; then ref=$2; ref_set=true; else repo=$2; fi
      shift 2 ;;
    --worktree) worktree=true; shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ $worktree == false || $ref_set == false ]] || die '--ref and --worktree cannot be combined.'
[[ -d $dir ]] || die "Directory does not exist: $dir"
dir=$(cd -- "$dir" && pwd -P)
if top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null); then
  top=$(cd -- "$top" && pwd -P)
  [[ $dir == "$top" ]] || die "DIR must be the git work tree top level: $top"
fi
# Resolve once, before changing cwd, including when the override is relative.
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
node - "$dir" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = process.argv[2], home = fs.realpathSync(os.homedir());
const config = process.env.RELAY_SMOKE_CONFIG;
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (dir === home || dir === (fs.existsSync(config) ? fs.realpathSync(config) : config)) {
  throw new Error('Refusing to install in HOME or the Claude config directory.');
}
for (const name of ['.claude', '.claude/settings.local.json']) {
  if (fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing project symlink: ${name}`);
  }
}
const entries = read(path.join(config, 'plugins/installed_plugins.json')).plugins?.['relay@relay-smoke'] ?? [];
const settings = read(path.join(dir, '.claude/settings.local.json'));
if (entries.some(e => e.projectPath && path.resolve(e.projectPath) === dir) ||
    Object.hasOwn(settings.enabledPlugins ?? {}, 'relay@relay-smoke') ||
    Object.hasOwn(settings.extraKnownMarketplaces ?? {}, 'relay-smoke') ||
    fs.lstatSync(process.env.RELAY_SMOKE_RECEIPT, { throwIfNoEntry: false }) ||
    fs.lstatSync(path.join(dir, '.claude/relay-smoke-local.json'), { throwIfNoEntry: false })) {
  throw new Error('relay@relay-smoke is already installed here. Run uninstall-local.sh first.');
}
if (entries.length || read(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke']) {
  throw new Error('relay-smoke is registered elsewhere. Uninstall that smoke build first.');
}
NODE
sha=$(git -C "$repo" rev-parse --verify --end-of-options "${ref}^{commit}")
short_sha=${sha:0:12}
temp_dir=$(cd -- "${TMPDIR:-/tmp}" && pwd -P)
mkt=$(mktemp -d "$temp_dir/relay-smoke-mkt-${short_sha}-XXXXXX")
mkdir -p "$mkt/relay" "$mkt/.claude-plugin"
if [[ $worktree == true ]]; then
  tar -C "$repo/plugins/relay" --exclude='./.claude-plugin/types' --exclude='./tsconfig.json' -cf - . | tar -C "$mkt/relay" -xf -
else
  git -C "$repo" archive "$sha" plugins/relay | tar -C "$mkt/relay" --strip-components=2 -xf -
fi
node - "$mkt" "$dir" "$temp_dir" "$sha" "$worktree" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs'), path = require('node:path');
const [mkt, dir, tempDirectory, commit, worktree] = process.argv.slice(2);
const plugin = JSON.parse(fs.readFileSync(path.join(mkt, 'relay/.claude-plugin/plugin.json'), 'utf8'));
if (plugin.name !== 'relay' || !plugin.version) throw new Error('Export is not a versioned relay plugin.');
fs.writeFileSync(path.join(mkt, 'relay/.claude-plugin/build.json'), JSON.stringify({
  commit: commit.slice(0, 12) + (worktree === 'true' ? '-dirty' : '')
}, null, 2) + '\n');
fs.writeFileSync(path.join(mkt, '.claude-plugin/marketplace.json'), JSON.stringify({
  name: 'relay-smoke', owner: { name: 'Relay smoke test' }, metadata: { version: plugin.version },
  plugins: [{ name: 'relay', version: plugin.version, source: './relay' }]
}, null, 2) + '\n');
const createdClaudeDirectory = !fs.existsSync(path.join(dir, '.claude'));
fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
const file = path.join(dir, '.claude/settings.local.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const receipt = process.env.RELAY_SMOKE_RECEIPT;
fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(receipt), 0o700);
fs.writeFileSync(receipt, JSON.stringify({
  tool: 'relay-plugin-cc/scripts/smoke/install-local.sh',
  dir, tempDirectory, config: process.env.RELAY_SMOKE_CONFIG,
  marketplace: mkt, createdMarketplace: true, commit, worktree: worktree === 'true',
  cacheExisted: fs.existsSync(path.join(process.env.RELAY_SMOKE_CONFIG, 'plugins/cache/relay-smoke')),
  createdCache: false,
  createdSettingsFile: !fs.existsSync(file), createdClaudeDirectory,
  hadPreviousRelay: Object.hasOwn(settings.enabledPlugins ?? {}, 'relay@libar-relay'),
  previousRelay: settings.enabledPlugins?.['relay@libar-relay'] ?? null,
  addedMarketplace: false, installedPlugin: false, disabledRelay: false
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Exported relay ${plugin.version} to ${mkt}`);
NODE
printf 'Source: %s at %s\n' "$repo" "$sha"
if [[ $worktree == true ]]; then
  printf 'Build includes working tree edits; generated plugin types are excluded.\n'
else
  printf 'Build uses git archive. Uncommitted edits are not included. Use --worktree to include them.\n'
fi
printf 'Undo: %q %q\n' "$script_dir/uninstall-local.sh" "$dir"
cd -- "$dir"
record_step() {
  node - "$RELAY_SMOKE_RECEIPT" "$1" <<'NODE'
// A refusal is one line for the person, not a stack trace.
process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1); });
const fs = require('node:fs');
const [file, step] = process.argv.slice(2);
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
saved[step] = true;
if (step === 'createdCache') {
  saved.createdCache = !saved.cacheExisted && fs.existsSync(require('node:path').join(saved.config, 'plugins/cache/relay-smoke'));
}
fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n');
NODE
}
claude plugin marketplace add "$mkt" --scope local
record_step addedMarketplace
if claude plugin install relay@relay-smoke --scope local; then
  record_step installedPlugin
  record_step createdCache
else
  status=$?
  # A failed install may still have populated the cache.
  record_step createdCache
  exit "$status"
fi
if output=$(claude plugin disable relay@libar-relay --scope local 2>&1); then
  record_step disabledRelay
  printf '%s\n' "$output"
else
  status=$?
  printf '%s\n' "$output" >&2
  case "$output" in
    *'Plugin "relay@libar-relay" is already disabled at local scope'*|*'Plugin "relay@libar-relay" is not installed'*|*'Plugin "relay@libar-relay" not found in installed plugins'*) ;;
    *) exit "$status" ;;
  esac
fi
printf 'Installed relay@relay-smoke locally in %s\n' "$dir"
