# 工具配置

## 模型选择

Codex、Copilot CLI 和 VS Code Copilot Chat 的默认型号均为 `substrate-gpt-6-astra`，统一使用 Responses API。先查询网关的最新 GPT 候选，列出默认型号与可选版本并询问用户；用户已经指定型号或接受默认时直接执行。

配置前检查工具版本及接口支持；版本缺少下述 Responses 配置入口时，说明需要兼容版本并询问后续处理，保留用户选定型号。

## 地址与凭据配置

配置阶段按主文流程检查 skill 内的 `scripts/key.env` 中的 `LLMPROXY_BASE_URL` 和 `LLMPROXY_API_KEY`：缺少哪项就向用户询问哪项，收到后保存，再继续。该文件由 Git 忽略。将地址和凭据一次性写入目标工具自己的配置，或 API 应用实际运行环境；配置完成后工具和业务代码均独立于 skill 目录。

API 环境（Windows）：将地址和 Key 分别写入用户级 `LLMPROXY_BASE_URL`、`LLMPROXY_API_KEY` 环境变量，并为本次启动的调用进程设置同名变量。用户级设置影响后续启动的程序；已有终端或应用需要重新启动。检查时仅报告是否存在。

API 环境（Linux / macOS / WSL）：设置 `export LLMPROXY_BASE_URL="你的BaseURL"` 和 `export LLMPROXY_API_KEY="你的Key"`；需要持久化时写入实际运行应用的私有 shell 或服务环境配置并重新加载。应用直接读取这两个环境变量。

以下示例中的 `你的BaseURL`、`你的Key` 在配置时替换为已保存的实际值。Base URL 包含 `/v1`；完整 Responses 地址为去掉末尾 `/` 的 Base URL 加 `/responses`。

## Codex CLI / VS Code Codex 插件

配置文件为 `~/.codex/config.toml`，Windows 为 `%USERPROFILE%\.codex\config.toml`；设置了 `CODEX_HOME` 时使用该目录下的配置。

读取已有文件，原位合并同名项并保留其他配置。前三项位于 TOML 顶层、各个配置段之前；若用户使用 profile，检查实际生效的模型及 provider。

```toml
model = "substrate-gpt-6-astra"
model_provider = "llmproxy"
model_reasoning_effort = "medium"

[model_providers.llmproxy]
name = "llmproxy"
base_url = "你的BaseURL"
experimental_bearer_token = "你的Key"
wire_api = "responses"
```

配置时将 `你的Key` 替换为本机实际 Key。该值以明文保存在用户私有 `config.toml`，共享示例保持占位值。将此 provider 的鉴权统一为 `experimental_bearer_token`，清理同一 provider 内冲突的 `env_key`、鉴权命令或其他鉴权来源，并确保 `requires_openai_auth` 为 false 或未设置。

将示例中的 `model` 替换为用户确认的完整模型名。独立的 `llmproxy` provider 是此网关长会话配置的必要条件。yifan 已验证独立 provider 方案在自动压缩上下文后继续执行；本次接入仍需单独验证。

换模型时修改对应的 `model`，保留 provider，按下节补齐完整模型名的元数据，并新建会话。可选择主文列出的 `copilot-` 模型、Substrate 模型或 Azure `gpt-6.1-terra`；这些新增 Codex 路由的接入说明优先于最初仅使用 `copilot-` 前缀的建议。

配置完成后，在项目目录运行 `codex`，或重新打开 VS Code Codex 插件并新建会话。验证时使用最小请求，报告配置结果与调用结果；未做长会话测试时仅报告已验证范围。

自定义 provider 字段参考 [Codex 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)；网关地址、模型兼容性及压缩测试结论来自 yifan 的接入说明。

### Codex 模型元数据

从当前 Codex 的内置模型目录或 `models_cache.json` 中，按去掉网关前缀后的基础型号查找并复制完整条目，将 `slug` 改为选定的完整路由名，按主文规则应用默认值。合并到用户配置目录下的 `llmproxy-models.json`，保留已有条目，在生效配置中设置 `model_catalog_json` 为其绝对路径。重启客户端并新建会话，确认元数据告警消失。

## GitHub Copilot CLI

先运行 `copilot --version`，确认版本支持命名 provider 配置。按 [GitHub 官方接入说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-llm-models)，在用户 `~/.copilot/providers.json` 合并以下内容；Windows 为 `%USERPROFILE%\.copilot\providers.json`。设置了 `COPILOT_HOME` 时使用该目录，`COPILOT_PROVIDERS_CONFIG` 可指定独立文件。

```json
{
  "providers": [
    {
      "name": "llmproxy",
      "type": "openai",
      "baseUrl": "你的BaseURL",
      "wireApi": "responses",
      "apiKey": "你的Key"
    }
  ],
  "models": [
    {
      "id": "substrate-gpt-6-astra",
      "provider": "llmproxy"
    }
  ]
}
```

将 `apiKey` 替换为实际 Key，凭据明文保存在此用户私有文件；JSON 中的环境变量名称会作为字面量处理。按 provider 名称与 model ID 合并已有条目，保留其他连接。配置能力和 token 限制时以该模型的已确认参数为准，字段见 [CLI 配置参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference#provider-settings)。

在用户 `~/.copilot/settings.json` 中合并默认模型：

```json
{
  "model": "llmproxy/substrate-gpt-6-astra"
}
```

这里的 `llmproxy/` 是 CLI 选择 provider 的限定前缀，实际发给网关的模型名仍为 `substrate-gpt-6-astra`。重启 CLI 后运行：

```sh
copilot --model llmproxy/substrate-gpt-6-astra
```

会话内用 `/model` 检查所选模型，或用 `/model --global` 设置全局默认。核对命令行、`COPILOT_MODEL` 和项目设置是否覆盖用户默认。以最小请求验证；运行时凭据来自 `providers.json`。

## VS Code GitHub Copilot Chat

使用支持 Responses 的 `Custom Endpoint` provider，入口为 `Chat: Manage Language Models` → `Add Models` → `Custom Endpoint`。填写组名 `llmproxy`、Key，选择 `Responses`，在其打开的用户 `chatLanguageModels.json` 中合并模型。字段与入口见 [VS Code 官方说明](https://code.visualstudio.com/docs/agent-customization/language-models#add-a-custom-endpoint-model)。

```json
[
  {
    "name": "llmproxy",
    "vendor": "customendpoint",
    "apiKey": "${input:llmproxyApiKey}",
    "apiType": "responses",
    "models": [
      {
        "id": "substrate-gpt-6-astra",
        "name": "substrate-gpt-6-astra (llmproxy)",
        "url": "你的BaseURL/responses",
        "toolCalling": true
      }
    ]
  }
]
```

`apiKey` 引用 VS Code 保存的凭据；保留界面生成的实际引用，并在其凭据输入界面保存本机 Key。按模型及网关确认 token 限制、视觉能力和会话状态支持，补充本机设置定义要求的字段。若网关采用无状态 Responses，在模型项设置 `statefulResponses: false` 以发送完整历史。

保存后在 Chat 模型选择器选择 `substrate-gpt-6-astra (llmproxy)`，新建会话做最小请求验证。此接入方式依据官方文档，网关与本机插件的联调结果以实测为准。
