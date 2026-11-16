# GPU Holder

本地 tmux 通过 SSH 管理远程 tmux。远端持续检测每张 NVIDIA GPU，连续空闲 10 秒后占用当时可用显存的约 80%，同时运行轻量计算；检测到其他进程后释放，恢复空闲后重新占用。

本地需要 Python 3.9+、ssh、tmux。远端需要 Linux、Python 3.9+、tmux、nvidia-smi 和 NVIDIA 驱动。训练环境会自动配置 CUDA 版 PyTorch（cu126，需要兼容的驱动）。

## 配置与运行

在 eh 仓库根目录安装，再准备本机配置：

```bash
node sync.mjs --add tool:gpu-holder
cd ~/gpu-holder/useful_tools/gpu-holder
cp config.example.json config.json
```

安装时可通过 `--home <安装父目录>` 自定义位置。更新执行 `git -C ~/gpu-holder pull`。

在 `config.json` 中填写可直接 SSH 的主机名或 SSH 别名；该文件由 Git 忽略：

```json
{
  "servers": [
    "gpu-server-1",
    {"host": "gpu-server-2", "gpus": [0, 1], "worker_python": "~/miniconda3/envs/train/bin/python"}
  ],
  "mode": "normal",
  "memory_fraction": 0.8,
  "poll_interval": 2,
  "refresh_interval": 3,
  "idle_seconds": 10,
  "idle_memory_mib": 512,
  "ssh_timeout": 10,
  "worker_python": "~/.local/share/gpu-holder/venv/bin/python",
  "compute_duty_cycle": 0.1
}
```

省略 `gpus` 时管理该服务器所有 GPU。空闲条件为没有其他进程、GPU 利用率为 0、已用显存不超过 `idle_memory_mib`。时间单位为秒；占卡失败每 30 秒重试。

`worker_python` 指定远端实际运行训练的 Python 路径或命令名，可在每个 server 中覆盖。指定 `<环境目录>/bin/python` 时会自动创建缺失的环境，并安装缺失的 CUDA 版 PyTorch。安装期间面板显示进度阶段，日志位于远端 `setup.log`。程序通过该解释器运行 `~/.local/share/gpu-holder/train.py`，自动安装 `setproctitle`，设置 `ps` 和 `nvidia-smi` 中的进程名称。

`compute_duty_cycle` 范围为 0～1，默认每秒约 0.1 秒执行矩阵前向、反向传播和 SGD 更新，其余时间休眠；设为 0 时仅占显存。该值控制计算时间比例，实际 GPU 利用率随硬件和采样窗口变化。

```bash
python3 gpu_holder.py start
tmux attach -t gpu-holder
```

按 `Ctrl-b d` 分离，本地和远程继续运行。面板逐台显示占卡、正常使用、问题、空闲卡数；连接失败且卡数未知时显示 `?`，并打印错误。SSH 使用免交互连接，启动时直接部署，无预先连通性检测；断线自动重试。

```bash
python3 gpu_holder.py status
python3 gpu_holder.py stop
```

`stop` 停止本地服务、远端会话并释放显存；无法连接的主机会明确报错，恢复连接后重新执行。修改配置后先用原配置停止服务，再重新启动，尤其是删除服务器时。可通过 `--config /path/to/config.json` 指定配置。

远端文件位于 `~/.local/share/gpu-holder/`，会话名为 `gpu-holder`，监控日志为 `daemon.log`，每张卡的训练日志为 `worker-<GPU索引>.log`。本地服务停止或网络断开时，远端仍会自主检测并让出 GPU。

quiet_cart、icy_board 各两台的节点任务由原 keeper 主进程维持，其占卡子进程通过 `/tmp/unirun-occupancy.pause` 暂停。

让出发生在下一次检测发现其他进程时；新任务若必须一次申请大量显存，建议先执行 `stop`。MIG 模式会显示为问题卡。

## 模式与 agent 操作

默认 `normal`（普通占卡），进程名为 `gpuholder.py`；`real`（真实模式），进程名为 `training.py`。两种模式使用相同的显存与计算参数，并在检测到其他进程后让卡。

Agent 根据用户当前任务选择：正在用于用户任务的卡设为 `real`，其余设为 `normal`；任务结束后恢复 `normal`。任务使用关系由 agent 根据任务上下文指定。

```bash
# 当前任务使用 icy_board 的 GPU 0、1
python3 gpu_holder.py mode real --host icy_board --gpus 0 1
# 任务结束
python3 gpu_holder.py mode normal --host icy_board --gpus 0 1
# 所有已配置服务器和 GPU 恢复普通占卡
python3 gpu_holder.py mode normal
# 读取每张卡的 state、mode、pids 和显存状态
python3 gpu_holder.py status --json
```

省略 `--gpus` 时切换目标服务器全部受管理的卡，省略 `--host` 时切换全部服务器。切换保存到本机配置；本地监控运行时下次刷新自动部署，否则命令直接部署。部署会重启受影响服务器的占卡进程，按空闲等待时间重新占卡。用 `status --json` 确认实际状态；连接或状态错误返回非零退出码。

配置中 `mode` 可在每个 server 覆盖，`gpu_modes` 可按索引覆盖，例如 `{"host": "icy_board", "mode": "normal", "gpu_modes": {"0": "real"}}`。整台或全部切换会清除对应的单卡覆盖。模式切换命令保留服务器与 GPU 管理范围；增删服务器仍按前述停止、启动流程操作。

## 验证

```bash
python3 -m unittest discover -s tests -v
```
