#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pane.sh start NAME DIR [--env VAR=value]... -- command [args...]
       pane.sh send NAME TEXT             TEXT - reads stdin
       pane.sh keys NAME KEY...
       pane.sh read NAME [LINES]          Default: 200 lines of scrollback
       pane.sh wait NAME REGEX [SECONDS]  An extended regex matched against each screen line. Default: 30 seconds
       pane.sh trust NAME
       pane.sh attach-command NAME
       pane.sh stop NAME
       pane.sh list

Uses a private tmux socket under XDG_RUNTIME_DIR, or TMPDIR when unset.
Prompts use bracketed paste followed by Enter. Keys are tmux key names.
EOF
}
die() { printf '%s\n' "$*" >&2; exit 2; }
[[ $# -gt 0 ]] || { usage >&2; exit 2; }
action=$1; shift
case "$action" in -h|--help) usage; exit 0 ;; esac
case "$action" in start|send|keys|read|wait|trust|attach-command|stop|list) ;; *) die "Unknown command: $action" ;; esac
name=
if [[ "$action" == list ]]; then
  [[ $# == 0 ]] || die 'Usage: pane.sh list'
else
  [[ $# -gt 0 ]] || die 'A pane name is required.'
  name=$1; shift
  [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Use only letters, numbers, underscores and hyphens in a pane name.'
fi

# Validate before contacting tmux, including for callers that only check arguments.
case "$action" in
  start)
    [[ $# -ge 3 ]] || die 'Usage: pane.sh start NAME DIR [--env VAR=value]... -- command [args...]'
    dir=$1; shift
    [[ -d "$dir" ]] || die "Directory does not exist: $dir"
    dir=$(cd -- "$dir" && pwd -P)
    env_args=()
    while [[ ${1:-} == --env ]]; do
      [[ $# -ge 2 && "$2" =~ ^[a-zA-Z_][a-zA-Z0-9_]*= ]] || die '--env needs VAR=value'
      env_args+=(-e "$2"); shift 2
    done
    [[ ${1:-} == -- && $# -ge 2 ]] || die 'Put -- before the command.'
    shift ;;
  send) [[ $# == 1 ]] || die 'Usage: pane.sh send NAME TEXT' ;;
  keys) [[ $# -ge 1 ]] || die 'Usage: pane.sh keys NAME KEY...' ;;
  read) [[ $# -le 1 && ${1:-200} =~ ^[0-9]+$ ]] || die 'LINES must be a nonnegative integer.' ;;
  wait)
    [[ $# -ge 1 && $# -le 2 && ${2:-30} =~ ^[0-9]+$ ]] || die 'Usage: pane.sh wait NAME REGEX [SECONDS]'
    regex=$1
    grep -Eq -- "$regex" <<<'' || [[ $? != 2 ]] || die 'Invalid regular expression.' ;;
  trust|attach-command|stop) [[ $# == 0 ]] || die "Usage: pane.sh $action NAME" ;;
esac

socket_dir=${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/claude-tmux}
socket_dir=${socket_dir:-${TMPDIR:-/tmp}/claude-tmux-$(id -u)}
SOCK=$socket_dir/tmux.sock
if [[ "$action" == attach-command ]]; then
  printf 'tmux -S %q attach-session -t %q\n' "$SOCK" "=$name"
  exit 0
fi
command -v tmux >/dev/null || die 'tmux is required.'
install -d -m 700 "$socket_dir"
target="=$name:"
case "$action" in
  start)
    # Multiple tmux command arguments execute directly; no shell reparses their values.
    tmux -S "$SOCK" new-session -d -s "$name" -x 200 -y 50 -c "$dir" "${env_args[@]}" -- "$@"
    # Claude Code tracks focus through the terminal's focus events, which tmux passes on only
    # when asked; without them it prints a hint under the prompt.
    tmux -S "$SOCK" set-option -g focus-events on ;;
  send)
    buffer="relay-paste-$$-$RANDOM"
    trap 'tmux -S "$SOCK" delete-buffer -b "$buffer" 2>/dev/null || true' EXIT
    if [[ $1 == - ]]; then
      tmux -S "$SOCK" load-buffer -b "$buffer" -
    else
      printf '%s' "$1" | tmux -S "$SOCK" load-buffer -b "$buffer" -
    fi
    tmux -S "$SOCK" paste-buffer -p -d -b "$buffer" -t "$target"
    sleep 0.5
    tmux -S "$SOCK" send-keys -t "$target" Enter ;;
  keys) tmux -S "$SOCK" send-keys -t "$target" "$@" ;;
  read) tmux -S "$SOCK" capture-pane -p -J -t "$target" -S "-${1:-200}" ;;
  wait)
    deadline=$((SECONDS + ${2:-30}))
    while :; do
      screen=$(tmux -S "$SOCK" capture-pane -p -J -t "$target" -S -2000)
      # Line by line, so ^ and $ anchor to a line of the screen, not to the whole capture.
      if grep -Eq -- "$regex" <<<"$screen"; then printf '%s\n' "$screen"; exit 0; fi
      (( SECONDS < deadline )) || { printf 'Timed out waiting for %s in %s\n' "$regex" "$name" >&2; exit 1; }
      sleep 0.5
    done ;;
  trust)
    screen=$(tmux -S "$SOCK" capture-pane -p -J -t "$target")
    if [[ "$screen" == *'Yes, I trust this folder'* ]]; then
      tmux -S "$SOCK" send-keys -t "$target" Down Enter
      printf 'Accepted folder trust in %s\n' "$name"
    fi ;;
  stop)
    if tmux -S "$SOCK" has-session -t "=$name" 2>/dev/null; then
      tmux -S "$SOCK" kill-session -t "=$name"
    fi ;;
  list)
    if [[ -S "$SOCK" ]]; then tmux -S "$SOCK" list-sessions; fi ;;
esac
