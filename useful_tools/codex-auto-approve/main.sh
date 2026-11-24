#!/usr/bin/env bash
set -euo pipefail

self=$(readlink -f -- "${BASH_SOURCE[0]}")
service=caa-approver

case $1 in
  toggle)
    if tmux has-session -t "=$service" 2>/dev/null; then
      bash "$self" off
    else
      tmux new-session -d -s "$service" bash "$self" serve
      tmux set-option -t "$service" destroy-unattached off
      echo '确认助手：开启（所有 Codex 会话）'
    fi
    ;;
  off)
    if tmux has-session -t "=$service" 2>/dev/null; then
      tmux kill-session -t "=$service"
    fi
    echo '确认助手：关闭'
    ;;
  serve)
    exec python3 "${self%/*}/service.py"
    ;;
esac
