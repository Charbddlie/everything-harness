# Codex 终端确认助手（Linux）

用于你信任且已备份的环境。显式开启后，检测 Codex 的命令执行、文件修改、网络访问和权限确认框，对选中的单次同意项发送 Enter。

依赖 Bash、tmux 和 Codex CLI。在 eh 仓库根目录安装：

```bash
node sync.mjs --add tool:codex-auto-approve
cd ~/codex-auto-approve/useful_tools/codex-auto-approve
bash switch.sh on
source commands.sh
```

使用 `--home <安装父目录>` 自定义位置，随后进入对应安装目录中的 `useful_tools/codex-auto-approve/`。脚本根据自身位置读取文件。

`codex` 创建专用 tmux 会话，`caa` 切换确认助手。开启后每 3 秒检查当前版本的英文确认框，确认后每 0.2 秒复查并继续处理，直到所有前台会话都没有确认框，再恢复 3 秒间隔。按 `Ctrl+B` 再按 `D` 分离后，Codex 转入后台会话，确认助手停止处理该会话。

在工具目录执行 `bash switch.sh off` 停用命令覆盖，`on` 重新启用。本机启用状态保存在同目录的 `enabled`，由 Git 忽略。

```bash
git -C ~/codex-auto-approve pull
```

更新后重新加载 `commands.sh`。已开启的确认助手通过 `caa` 关闭再开启，以加载新版本。
