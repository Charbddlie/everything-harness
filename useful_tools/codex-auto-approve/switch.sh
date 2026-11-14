#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case ${1:-} in
  on)
    line="source $(printf '%q' "$root/commands.sh") # codex-auto-approve"
    if ! grep -Fxq "$line" "$HOME/.bashrc"; then
      sed -i '/ # codex-auto-approve$/d' "$HOME/.bashrc"
      printf '\n%s\n' "$line" >> "$HOME/.bashrc"
    fi
    touch "$root/enabled"
    printf '已启用 codex 和 caa。请新开终端，或执行 source %q\n' "$root/commands.sh"
    ;;
  off)
    rm -f "$root/enabled"
    bash "$root/main.sh" off
    echo '已停用：codex 恢复原始调用，caa 停用。'
    ;;
  *)
    printf '用法：bash %q on|off\n' "$root/switch.sh" >&2
    exit 1
    ;;
esac
