---
name: dev-directory
description: 创建项目或脚本、选择开发目录、配置 Python/conda 环境、提供启动入口时使用。统一项目存放位置、conda 环境选择和 Windows 桌面启动脚本约定。
---

# 开发目录约定

## 项目位置

在已有项目中工作时沿用项目目录；需要新建项目或脚本时，先创建项目文件夹，再把代码、资源和输出放入其中：

| 系统 | 项目目录 |
|---|---|
| Windows | `~\Desktop\code\<项目名>\` |
| Linux | `~/<项目名>/` |

`~` 表示当前用户的主目录。Windows 用户主目录保持整洁，项目内容统一放到桌面的 `code` 下；Linux 在主目录下按项目归档。

## 开发环境

优先使用系统已有的 conda base 环境。具体应用需要安装大量依赖时，新建独立的 conda 环境。

本机 Windows 的 conda 位于 `C:\Users\ShuttleMan\miniconda3`，base Python 为 `C:\Users\ShuttleMan\miniconda3\python.exe`。其他机器通过 `conda info --base` 确认安装位置，沿用相同的环境选择规则。

## 启动入口

功能需要用户访问入口时，询问是否创建快捷启动入口。

Windows 用户需要桌面入口时，提供可双击运行的 BAT 脚本，使用 GBK 编码，末尾加 `pause`，让用户看到运行结果或错误。脚本调用项目目录中的程序，使用选定 conda 环境里的解释器。
