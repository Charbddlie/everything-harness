---
name: llmproxy
description: 使用 yifan 提供的 llmproxy 大模型 API，查询模型、调用 Responses / Chat 接口，并配置 Codex、GitHub Copilot CLI 或 VS Code GitHub Copilot Chat。当需要调用大模型 API、配置 Codex/Copilot 的模型服务，或排查 llmproxy 接入问题时使用；用户已指定其他服务时沿用其选择。
---

# llmproxy

## 接入与凭据

- 配置前检查当前实际加载的 skill 目录下 `scripts/key.env` 中的 `LLMPROXY_BASE_URL`（API 根地址，包含 `/v1`）和 `LLMPROXY_API_KEY`（本人专用 Key），两项均由用户提供，可向 yifan 获取。
- 文件、键或非空值缺失时，向用户询问缺少的项目；收到后创建所需目录，按 UTF-8、每行 `KEY=value` 保存到 `scripts/key.env`，保留已有值、其他键和注释，再继续配置。等待期间暂停需要这些信息的操作。
- 两项齐全后，将地址和 Key 写入目标工具自己的配置或 API 应用环境。`scripts/key.env` 由 Git 忽略，仅保留在本机。
- Codex 将 Key 写入用户配置的 `model_providers.llmproxy.experimental_bearer_token`；Copilot 使用其版本支持的模型配置或专用凭据存储。运行时直接使用工具保存的凭据。
- API 调用前将地址和 Key 配置到应用实际运行环境的 `LLMPROXY_BASE_URL`、`LLMPROXY_API_KEY`；业务代码只读取这两个环境变量。缺失时停止并提示补全，运行时保持与 skill 目录独立。
- 实际地址和 Key 仅保留在本机配置文件、工具私有配置及应用环境中；共享正文使用变量名或占位值，日志和截图遮住 Key。发布与同步 skill 时将本机 `scripts/key.env` 留在提交范围之外，并保留本机副本。
- 网络需为公司内网或已加入白名单的出口 IP。调用失败先检查网络与白名单；Azure VM 可将机器名或公网 IP 提供给 yifan 确认。

## 选择模型和接口

以下是 yifan 提供的模型名与兼容性信息；实际模型列表通过鉴权 `GET <BASE_URL>/models` 获取。拼接接口路径时去掉 Base URL 末尾的 `/`，保留其已有 `/v1`。模型名是网关路由标识，保留原样。

- Azure AI Foundry（无前缀）：`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5.1-codex-max`、`gpt-4.1`、`gpt-4o`、`o3`、`o4-mini`。
- GitHub Copilot（多账号负载均衡）：`copilot-gpt-6-astra`、`copilot-gpt-6.1-sol`、`copilot-gpt-6.1-terra`、`copilot-gpt-5.6-sol`、`copilot-gpt-5.6-terra`、`copilot-gpt-5.3-codex`、`copilot-gemini-4-argon`、`copilot-gemini-3.8-flash`、`copilot-grok-4.7`。
- Substrate：`substrate-gpt-6-astra`、`substrate-gpt-6.1-sol`、`substrate-gpt-6-sol`、`substrate-gpt-6-luna`、`substrate-gpt-6.1-terra`、`substrate-gpt-chat-latest`。

默认使用 Responses API。GPT-6 / GPT-6.1 系列仅支持 Responses；Chat 接口已由 yifan 测试的 Copilot 模型为 `copilot-gpt-5.3-codex`、`copilot-gemini-4-argon`、`copilot-gemini-3.8-flash`。其他模型的 Chat 支持需另行确认，`/models` 中出现模型只代表被列出。

所有 harness 的默认配置统一使用 `copilot-gpt-6-astra` 和 Responses API。配置前查询 `/models`，结合提供方说明确认版本与接口支持，列出默认型号及最新 GPT 候选的完整模型名，询问用户要配置哪个版本，确认后写入。用户明确型号或接受默认时直接采用；无法查询时说明可用性尚未确认，并依据已知型号询问选择。

用户也可选择 Substrate、其他 Copilot 或 Azure GPT 模型。yifan 补充 Azure `gpt-6.1-terra` 部署于 wus3、额度较大且速度快；容量和延迟以实际调用为准。Azure `gpt-6-astra` 返回 429 时，可向用户建议 `substrate-gpt-6-astra`，保留用户明确指定的模型选择。

## API 调用

Python 使用 `openai` 包。准备好进程环境中的地址和 Key 后：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["LLMPROXY_API_KEY"],
    base_url=os.environ["LLMPROXY_BASE_URL"],
    timeout=120,
)

# 查询可用模型时运行：
# print([model.id for model in client.models.list()])

r = client.responses.create(
    model="copilot-gpt-6-astra",
    input="你好",
    reasoning={"effort": "low"},
)
print(r.output_text)
```

按任务选择模型与 reasoning effort。最小连通性测试可用 `gpt-5.4-nano`，输入“请只回复：API 调用成功”；该测试只验证本次调用。

## 工具配置

配置 Codex、GitHub Copilot CLI 或 VS Code GitHub Copilot Chat 时，读取 [工具配置](references/tool-config.md) 的对应章节。先区分具体产品，再合并用户请求的配置；普通 API 调用只需准备客户端。

## 排错

- 超时或连接被拒：核对公司网络、实际出口和白名单。
- 401 / 403：区分缺失或失效凭据与访问限制；仅检查 Key 是否存在和服务错误信息。
- 429：检查对应路由的额度与限流，短暂问题有限重试，持续失败报告原因及可选路由。
- `input item does not belong to this connection`：核对 Codex 使用独立 `llmproxy` provider，随后新建会话。网关按账号绑定加密上下文，此错误可能与会话绑定有关。
- 报告工具名称、模型名和脱敏后的完整报错，区分 yifan 提供的测试结论与本次实测结果。
