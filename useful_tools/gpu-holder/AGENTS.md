# 占卡模式

根据用户当前任务选择模式：正在使用的 GPU 设为 `real`，其余设为 `normal`，任务结束恢复 `normal`。

使用 `python3 gpu_holder.py mode <normal|real> --host <主机> --gpus <索引...>` 切换，使用 `python3 gpu_holder.py status --json` 确认实际状态。省略 host 和 gpus 表示所有已配置的卡。命令与部署说明见 `README.md`。
