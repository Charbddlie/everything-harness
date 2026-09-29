---
name: copilot-api
description: 检查、启动或初始化本机 copilot-api 网关，并按用户选择配置 Codex、Claude Code。当用户说「检查 copilot-api 环境」「启动 copilotapi」「启动 copilot-api」「初始化 copilot-api」「安装 copilot-api」「配置 Copilot 网关」「初始化 Claude Code」「初始化 Codex」，或说明启动时缺少 copilot-api 时使用。
---

# Copilot API

按用户意图区分检查、启动和初始化。默认地址 `http://127.0.0.1:4821`，已有环境沿用实际地址、端口和鉴权配置。使用支持 Responses 和 Messages 的 `@jeffreycao/copilot-api`。

## 模式选择

- **检查环境**：执行下面的只读检查，报告依赖、安装、网关及客户端状态。发现缺项时给出处理建议，等待用户要求启动或初始化。
- **启动环境**：检查后复用可用网关；网关未运行时按已有入口启动。若确认缺少 copilot-api，转入初始化，完成后继续启动并执行初始化后的客户端询问。用户说明“启动时发现缺少 copilot-api”时采用此流程。
- **初始化**：用户明确要求初始化、安装或配置网关时，执行第 1–3 节，再按用户选择执行第 4–5 节。已有有效登录和启动入口可复用。
- **初始化客户端**：用户明确要求初始化 Codex 或 Claude Code 时，检查并启动网关，缺少网关时先初始化；该客户端视为已获用户选择，直接进入相应配置步骤。

## 检查与启动

1. 运行本 skill 的 `node dryrun.mjs` 检查 Node.js ≥22.20.0 和 npm。此入口供安装 skill 后的基础预检使用；网关安装、登录和运行状态由下面的步骤检查。
2. 检查 `copilot-api` 命令是否可用，结合 npm 全局安装目录及 `@jeffreycao/copilot-api` 安装记录确认。若包已安装但命令不在 PATH，定位现有入口；确认包缺失后才按缺少网关处理。
3. 查看已有启动入口和实际监听地址，以短超时请求 `GET /v1/models`；启用鉴权时使用现有网关凭据，输出中隐藏凭据。成功返回非空模型列表后，记录可用模型并复用该实例。请求失败时结合进程、端口和日志区分未启动、鉴权失败与其他服务占用端口。
4. 检查本机 `codex`、`claude` 命令及客户端配置，按第 3 节判断安装和配置状态。检查模式在报告状态后结束。
5. 启动模式下，已安装且未运行的网关使用现有入口启动；缺少入口时按第 2 节生成。端口被其他服务占用时先报告冲突，请用户选择处理方式；保留已有进程。若日志确认登录缺失或失效，按第 1 节引导登录后重试。其他启动错误汇报日志和原因，等待处理。
6. 用 `GET /v1/models` 确认启动成功，交付地址、入口和日志位置。常规启动到此结束；本次转入了初始化时，继续执行第 3 节的客户端询问。

## 1. 安装与登录

检查 Node.js、npm，缺少或版本不足时安装 Node.js 22.20.0 或更新的 LTS。缺少网关或用户要求更新时执行：

```sh
npm install -g @jeffreycao/copilot-api@latest
```

复用已有有效登录。首次登录或认证失效时执行：

```sh
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

启动前按“检查与启动”确认网关状态和端口占用。运行启动脚本，确认 `GET /v1/models` 返回模型列表。日志位置由脚本打印。端口需要调整时，同步修改脚本和本次选中配置的客户端地址；其他已有客户端的地址差异在交付时说明。

## 3. 初始化后的客户端询问与模型选择

网关初始化并确认可用后，读取实际地址的 `/v1/models`，结合本机状态决定询问内容：

- **Codex**：检查 `codex` 命令和 `${CODEX_HOME:-~/.codex}/config.toml`，考虑当前 profile 和 provider。若未安装或尚无有效配置，询问是否安装并配置或补齐配置。已有有效配置时保留原配置；使用其他 provider 也视为已有配置，切换网关需用户明确要求。
- **Claude Code**：当模型列表中存在可用 Claude 模型，且本机未安装 Claude Code 时，询问是否安装并配置。结合 `claude` 命令及现有安装位置判断，避免将 PATH 缺失误判为未安装。已安装时保留现有配置，用户要求配置时再修改。
- 模型列表中没有 Claude 模型时，说明当前账户无可用 Claude 模型。若模型列表读取失败，先处理网关错误，再判断模型是否可用。

需要询问的项目可合并为一次提问，等待用户选择后再安装或写入配置。用户已明确要求某个客户端时直接处理该客户端；其他符合条件的客户端仍需询问。用户拒绝或暂不配置时，保留已启动的网关并结束客户端配置流程。

为每个选中的工具设置：

- **模型**：Claude Code 选当前列表中最强的 Claude；Codex 选网关支持 Responses（原生或适配）的最强编程模型。结合当前模型官方能力说明判断，使用列表中的实际 ID。
- **推理强度**：`medium`。从 `capabilities.supports.reasoning_effort` 或对应模型说明确认支持；最强模型不支持时，说明情况并让用户确认替代模型或强度。
- **上下文 C**：网关对所选模型实际开放的最大可用上下文。读取 `capabilities.limits.max_context_window_tokens`；存在更小的 `max_prompt_tokens` 输入上限时取该上限。字段缺失时查网关模型配置和官方说明确认。
- **压缩点 A**：`floor(C × 0.9)`。下面模板中的模型 ID、C、A 都替换成实际值。

## 4. 安装并配置所选工具

仅处理用户选中的工具。工具缺失时执行对应安装命令，已有安装可复用。已有配置先备份，按字段合并，保留原有 MCP、hooks 等设置。代理绕过列表保留原值并补入 `127.0.0.1,localhost`。网关启用了 API key 时，使用它签发的网关凭据。下面模板中的地址按实际网关地址替换。

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
