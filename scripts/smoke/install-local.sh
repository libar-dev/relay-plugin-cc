#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-local.sh DIR [--ref REF] [--repo PATH] [--worktree]
Install relay@relay-smoke for DIR only. REF defaults to HEAD.
The default build uses git archive and excludes uncommitted edits.
--worktree copies plugins/relay, including uncommitted edits, except .claude-plugin/types/.
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
node - "$dir" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = process.argv[2], home = fs.realpathSync(os.homedir());
const config = path.join(home, '.claude');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (dir === home || dir === (fs.existsSync(config) ? fs.realpathSync(config) : config)) {
  throw new Error('Refusing to install in HOME or ~/.claude.');
}
const entries = read(path.join(config, 'plugins/installed_plugins.json')).plugins?.['relay@relay-smoke'] ?? [];
const settings = read(path.join(dir, '.claude/settings.local.json'));
if (entries.some(e => e.projectPath && path.resolve(e.projectPath) === dir) ||
    Object.hasOwn(settings.enabledPlugins ?? {}, 'relay@relay-smoke') ||
    fs.existsSync(path.join(dir, '.claude/relay-smoke-local.json'))) {
  throw new Error('relay@relay-smoke is already installed here. Run uninstall-local.sh first.');
}
if (entries.length || read(path.join(config, 'plugins/known_marketplaces.json'))['relay-smoke']) {
  throw new Error('relay-smoke is registered elsewhere. Uninstall that smoke build first.');
}
NODE
sha=$(git -C "$repo" rev-parse --verify --end-of-options "${ref}^{commit}")
short_sha=${sha:0:12}
mkt=$(mktemp -d "${TMPDIR:-/tmp}/relay-smoke-mkt-${short_sha}-XXXXXX")
mkdir -p "$mkt/relay" "$mkt/.claude-plugin"
if [[ $worktree == true ]]; then
  tar -C "$repo/plugins/relay" --exclude='./.claude-plugin/types' -cf - . | tar -C "$mkt/relay" -xf -
else
  git -C "$repo" archive "$sha" plugins/relay | tar -C "$mkt/relay" --strip-components=2 -xf -
fi
node - "$mkt" "$dir" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [mkt, dir] = process.argv.slice(2);
const plugin = JSON.parse(fs.readFileSync(path.join(mkt, 'relay/.claude-plugin/plugin.json'), 'utf8'));
if (plugin.name !== 'relay' || !plugin.version) throw new Error('Export is not a versioned relay plugin.');
fs.writeFileSync(path.join(mkt, '.claude-plugin/marketplace.json'), JSON.stringify({
  name: 'relay-smoke', owner: { name: 'Relay smoke test' }, metadata: { version: plugin.version },
  plugins: [{ name: 'relay', version: plugin.version, source: './relay' }]
}, null, 2) + '\n');
fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
const file = path.join(dir, '.claude/settings.local.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
fs.writeFileSync(path.join(dir, '.claude/relay-smoke-local.json'), JSON.stringify({
  marketplace: mkt, previousRelay: settings.enabledPlugins?.['relay@libar-relay'] ?? null
}, null, 2) + '\n');
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
claude plugin marketplace add "$mkt" --scope local
claude plugin install relay@relay-smoke --scope local
claude plugin disable relay@libar-relay --scope local
printf 'Installed relay@relay-smoke locally in %s\n' "$dir"
