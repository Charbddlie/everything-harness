codex() {
  if [[ -f "$HOME/codex-auto-approve/enabled" ]]; then
    bash "$HOME/codex-auto-approve/main.sh" codex "$@"
  else
    command codex "$@"
  fi
}

caa() {
  if [[ -f "$HOME/codex-auto-approve/enabled" ]]; then
    bash "$HOME/codex-auto-approve/main.sh" toggle
  else
    echo 'codex-auto-approve 已停用。'
  fi
}
