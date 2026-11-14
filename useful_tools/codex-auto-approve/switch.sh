#!/usr/bin/env bash
set -euo pipefail

root="$HOME/codex-auto-approve"
case ${1:-} in
  on)
    line='source "$HOME/codex-auto-approve/commands.sh"'
    if ! grep -Fxq "$line" "$HOME/.bashrc"; then
      printf '\n%s\n' "$line" >> "$HOME/.bashrc"
    fi
    touch "$root/enabled"
    echo '已启用 codex 和 caa。首次安装后，请执行 source ~/codex-auto-approve/commands.sh，或新开终端。'
    ;;
  off)
    rm -f "$root/enabled"
    bash "$root/main.sh" off
    echo '已停用：codex 恢复原始调用，caa 停用。'
    ;;
  *)
    echo '用法：bash ~/codex-auto-approve/switch.sh on|off' >&2
    exit 1
    ;;
esac
