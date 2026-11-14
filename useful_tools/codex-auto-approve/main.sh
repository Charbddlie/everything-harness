#!/usr/bin/env bash
set -euo pipefail

self=$(readlink -f -- "${BASH_SOURCE[0]}")
watcher=caa-approver

approval_visible() {
  awk '
    /^[[:space:]]*(Would you like to (run the following command|make the following edits|grant these permissions|send input to .+)\?|Do you want to approve network access to ".+"\?)[[:space:]]*$/ { heading = 1 }
    /^[[:space:]]*›[[:space:]]+[0-9]+\.[[:space:]]+Yes, (proceed|just this once|grant these permissions for this turn)([[:space:]]+\([^)]*\))?[[:space:]]*$/ { selected = 1 }
    /[^[:space:]]/ { last = $0 }
    END {
      footer = last ~ /^[[:space:]]*Press enter to confirm or esc to cancel( or .+ to open thread)?[[:space:]]*$/
      exit !(heading && selected && footer)
    }
  '
}

case $1 in
  codex)
    shift
    session=caa-active-$(date +%Y%m%d-%H%M%S)-$$
    tmux new-session -d -s "$session" -c "$PWD" bash "$self" run "$session" "$@"
    if [[ -n ${TMUX:-} ]]; then
      tmux switch-client -t "=$session"
    else
      tmux attach-session -t "=$session"
    fi
    ;;
  run)
    session=$2
    shift 2
    tmux set-option -t "$session" destroy-unattached off
    tmux set-hook -t "$session" client-detached \
      "run-shell 'bash \"$self\" park $session'"
    exec codex "$@"
    ;;
  park)
    session=$2
    [[ $(tmux display-message -p -t "$session" '#{session_attached}') == 0 ]] || exit 0
    tmux new-session -d -s "${session/caa-active-/caa-background-}" -t "$session"
    tmux kill-session -t "=$session"
    ;;
  toggle)
    if tmux has-session -t "=$watcher" 2>/dev/null; then
      bash "$self" off
    else
      tmux new-session -d -s "$watcher" bash "$self" watch
      tmux set-option -t "$watcher" destroy-unattached off
      echo '自动审批：开启（每 3 秒检查审批框）'
    fi
    ;;
  off)
    if tmux has-session -t "=$watcher" 2>/dev/null; then
      tmux kill-session -t "=$watcher"
    fi
    echo '自动审批：关闭'
    ;;
  watch)
    while sleep 3; do
      while read -r session attached pane dead mode; do
        if [[ $session == caa-active-* && $attached -gt 0 && $dead == 0 && $mode == 0 ]]; then
          if tmux capture-pane -p -J -t "$pane" 2>/dev/null | approval_visible; then
            tmux send-keys -t "$pane" Enter 2>/dev/null || true
          fi
        fi
      done < <(tmux list-panes -a -F '#{session_name} #{session_attached} #{pane_id} #{pane_dead} #{pane_in_mode}')
    done
    ;;
esac
