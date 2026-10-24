#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/relay-dev.sh [run] [claude arguments]
       scripts/relay-dev.sh env
       scripts/relay-dev.sh status

Run this checkout's relay plugin alongside an installed production release.
The development process uses its own jobs and admission homes and disables
relay@libar-relay only for that process. Normal Claude sessions are unchanged.

RELAY_DEV_HOME overrides the development state root (default:
${XDG_STATE_HOME:-$HOME/.local/state}/relay-dev/<checkout-id>).
RELAY_DEV_WORKDIR optionally changes the session's working directory.
EOF
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$script_dir/.." && pwd -P)
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi

command=run
if [[ $# -gt 0 ]]; then
  case "$1" in
    run|env|status) command=$1; shift ;;
  esac
fi

checkout_id=$(node - "$repo" <<'NODE'
const { createHash } = require('node:crypto');
console.log(createHash('sha256').update(process.argv[2]).digest('hex').slice(0, 16));
NODE
)
dev_root=${RELAY_DEV_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/relay-dev/$checkout_id}
jobs_home=$dev_root/jobs
admission_home=$dev_root/admission
plugin_dir=$repo/plugins/relay
settings='{"enabledPlugins":{"relay@libar-relay":false}}'

if [[ ! -f $plugin_dir/.claude-plugin/plugin.json ]]; then
  printf 'Not a relay checkout: %s\n' "$repo" >&2
  exit 2
fi
mkdir -p "$jobs_home" "$admission_home"
export RELAY_JOBS_HOME=$jobs_home
export RELAY_ADMISSION_HOME=$admission_home

case "$command" in
  env)
    printf 'export RELAY_JOBS_HOME=%q\n' "$RELAY_JOBS_HOME"
    printf 'export RELAY_ADMISSION_HOME=%q\n' "$RELAY_ADMISSION_HOME"
    printf 'export RELAY_DEV_PLUGIN_DIR=%q\n' "$plugin_dir"
    printf 'export RELAY_DEV_SETTINGS=%q\n' "$settings"
    ;;
  status)
    printf 'Development checkout: %s\n' "$repo"
    printf 'Development state: %s\n' "$dev_root"
    node "$plugin_dir/scripts/companion.mjs" status --all
    ;;
  run)
    if [[ -n ${RELAY_DEV_WORKDIR:-} ]]; then cd -- "$RELAY_DEV_WORKDIR"; fi
    exec claude --plugin-dir "$plugin_dir" --settings "$settings" "$@"
    ;;
esac
