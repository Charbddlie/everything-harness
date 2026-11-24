# Codex 审批助手（Linux）

在部署服务器上运行，用于你信任且已备份的环境。`caa` 是本机所有 Codex 会话的统一开关，开启后通过 `PermissionRequest` hook 自动同意审批请求。

依赖 Bash、Python 3.9+、tmux 和支持 `PermissionRequest` 的 Codex CLI（已验证 0.172.0）。在 eh 仓库根目录安装：

```bash
node sync.mjs --add tool:codex-auto-approve
cd ~/codex-auto-approve/useful_tools/codex-auto-approve
bash switch.sh on
source commands.sh
```

使用 `--home <安装父目录>` 自定义位置，随后进入对应安装目录中的 `useful_tools/codex-auto-approve/`。脚本根据自身位置读取文件。

直接运行 `codex`。`caa` 开启或关闭 `caa-approver` tmux 会话中的审批服务。服务通过本机 Unix socket 阻塞等待 hook 事件，开启时自动审批所有会话，关闭时由 Codex 正常展示审批请求。

`switch.sh on` 将本工具的 hook 加入 `${CODEX_HOME:-~/.codex}/hooks.json`，通过 Codex 的配置接口信任该 hook，并保留其他配置。hook 在会话启动时加载。

在工具目录执行 `bash switch.sh off` 停用助手，`on` 重新启用。本机启用状态保存在同目录的 `enabled`，服务 socket 保存在 `.runtime/`，均由 Git 忽略。

更新后重新配置 hook，并重新加载命令：

```bash
git -C ~/codex-auto-approve pull
bash switch.sh on
source commands.sh
```

已开启的审批服务通过 `caa` 关闭再开启，以加载新版本。

运行测试：`python3 -B -m unittest -v test_service.py`。
