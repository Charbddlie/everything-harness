---
name: copilot-api
description: 在本机安装 copilot-api、引导 GitHub 登录、生成后台启动脚本，并按用户选择安装和配置 Claude Code、Codex。当用户说「安装 copilot-api」「配置 Copilot 网关」「初始化 Claude Code」「初始化 Codex」时使用。
---

# Copilot API

安装本地网关 → 用户登录 → 设置启动脚本 → 选择工具 → 安装并配置。
默认地址 `http://127.0.0.1:4821`。使用支持 Responses 和 Messages 的 `@jeffreycao/copilot-api`。

## 1. 安装与登录

检查 Node.js、npm，缺少时安装 Node.js 22.20.0 或更新的 LTS，然后执行：

```sh
npm install -g @jeffreycao/copilot-api@latest
copilot-api auth login --provider copilot
```

将终端显示的验证网址和设备码交给用户，在浏览器完成 GitHub 授权，等待命令确认登录成功。

## 2. 设置启动脚本

本 skill 的 `scripts` 目录提供模板，功能与桌面旧脚本一致：后台启动 `copilot-api start --port 4821`，关闭启动窗口后网关继续运行。

| 系统 | 模板 | 放置位置 |
|---|---|---|
| Windows | `scripts/copilot-api.bat` | 实际桌面目录中的 `copilot-api.bat` |
| macOS / Linux | `scripts/copilot-api.sh` | `~/copilot-api.sh`，执行 `chmod +x` |

Windows 桌面路径用 `[Environment]::GetFolderPath('Desktop')` 获取；BAT 使用 GBK 编码并以 `pause` 结束（模板为纯 ASCII，兼容 GBK）。已有同功能桌面脚本可直接复用，统一使用刚安装的 `copilot-api` 命令。若已有入口，更新该入口即可。

运行启动脚本，确认 `GET /v1/models` 返回模型列表。日志位置由脚本打印。端口需要调整时，同步修改脚本和后面的客户端地址。

## 3. 选择工具和模型

读取 `http://127.0.0.1:4821/v1/models` 的可用模型，询问用户安装哪些工具，可多选 **Claude Code**、**Codex**。列表中没有 Claude 模型时，说明当前账户无可用 Claude 模型，仅提供 Codex 选项。

为每个选中的工具设置：

- **模型**：Claude Code 选当前列表中最强的 Claude；Codex 选网关支持 Responses（原生或适配）的最强编程模型。结合当前模型官方能力说明判断，使用列表中的实际 ID。
- **推理强度**：`medium`。从 `capabilities.supports.reasoning_effort` 或对应模型说明确认支持；最强模型不支持时，说明情况并让用户确认替代模型或强度。
- **上下文 C**：网关对所选模型实际开放的最大可用上下文。读取 `capabilities.limits.max_context_window_tokens`；存在更小的 `max_prompt_tokens` 输入上限时取该上限。字段缺失时查网关模型配置和官方说明确认。
- **压缩点 A**：`floor(C × 0.9)`。下面模板中的模型 ID、C、A 都替换成实际值。

## 4. 安装并配置所选工具

已有配置先备份，按字段合并，保留原有 MCP、hooks 等设置。代理绕过列表保留原值并补入 `127.0.0.1,localhost`。网关启用了 API key 时，使用它签发的网关凭据。

### Claude Code

```sh
npm install -g @anthropic-ai/claude-code@latest
```

用户配置写入 `~/.claude/settings.json`：

```json
{
  "model": "<Claude 模型 ID>",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4821",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "<Claude 模型 ID>",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_EFFORT_LEVEL": "medium",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "<C 的十进制整数>",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "90",
    "NO_PROXY": "127.0.0.1,localhost"
  }
}
```

长上下文使用网关返回的 `claude_model_id`（支持时包含 `[1m]`）；没有这个字段时按实际支持的上下文选择模型 ID / `[1m]` 变体。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 设置的是压缩计算窗口，上限受 Claude Code 识别的模型窗口约束。用 `/model`、`/context` 核实最大窗口与 90% 压缩设置；若客户端识别窗口与网关额度不一致，按官方的 [网关上下文配置](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id) 调整，并告知仍受限的数值。

另外，在 `~/.claude.json` 的顶层合并下面的状态，跳过首次 onboarding 登录引导：

```json
{ "hasCompletedOnboarding": true }
```

它与 `settings.json` 是两个文件；网关本身仍使用第 1 步完成的 GitHub 登录。

### Codex

```sh
npm install -g @openai/codex@latest
```

写入 `~/.codex/config.toml`（设置了 `CODEX_HOME` 时使用该目录）：

```toml
model = "<模型 ID>"
model_provider = "copilot_api"
model_reasoning_effort = "medium"
plan_mode_reasoning_effort = "high"
model_context_window = <C>
model_auto_compact_token_limit = <A>
approval_policy = "on-request"
sandbox_mode = "danger-full-access"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://127.0.0.1:4821/v1"
wire_api = "responses"
requires_openai_auth = false
```

网关启用鉴权时，在 provider 下增加 `env_key = "GITHUB_COPILOT_API_KEY"`，并为本机用户设置该变量。上述权限使用按需审批和完整本机访问。已有 `profile` 覆盖模型或权限时同步更新当前 profile，使这些值实际生效。

## 5. 确认可用

启动新会话，确认所选模型、`medium`、上下文和压缩点。用所选工具发送一次简短请求，核实请求经过本地网关并得到回复。交付启动脚本位置和所改配置文件；重启电脑后运行启动脚本即可恢复网关。