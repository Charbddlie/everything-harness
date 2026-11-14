CAA_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

codex() {
  if [[ -f "$CAA_ROOT/enabled" ]]; then
    bash "$CAA_ROOT/main.sh" codex "$@"
  else
    command codex "$@"
  fi
}

caa() {
  if [[ -f "$CAA_ROOT/enabled" ]]; then
    bash "$CAA_ROOT/main.sh" toggle
  else
    echo 'codex-auto-approve 已停用。'
  fi
}
