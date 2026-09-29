## Windows 项目目录

- 在 Windows 上，已有项目沿用原目录；新项目先建文件夹，代码、资源和输出集中存放，使用 `~/Desktop/code/<项目名>/`。
- Python 优先使用已有 conda base；依赖较多时新建独立环境，通过 `conda info --base` 确认安装位置。
- 需要访问入口时，询问是否创建快捷启动入口。Windows 使用 GBK 编码的 BAT，调用项目程序和选定解释器，末尾加 `pause`。
