# Codex 自动审批（Linux）

依赖 Bash、tmux 和 Codex CLI。在仓库根目录安装：

```bash
ln -s "$PWD/useful_tools/codex-auto-approve" ~/codex-auto-approve
bash ~/codex-auto-approve/switch.sh on
source ~/codex-auto-approve/commands.sh
```

`codex` 创建专用 tmux 会话，`caa` 切换自动审批。开启后每 3 秒检查当前版本的英文审批框，匹配时确认单次同意选项。确认后每 0.2 秒复查并继续处理审批，直到所有前台会话都没有审批框，再恢复 3 秒间隔。按 `Ctrl+B` 再按 `D` 分离后，Codex 转入后台会话并停止自动审批。

执行 `bash ~/codex-auto-approve/switch.sh off` 停用命令覆盖，`on` 重新启用。本机启用状态保存在 Git 忽略的 `useful_tools/codex-auto-approve/enabled`。
