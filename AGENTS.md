# 开发约定

## 内容与导入

- `eh` 指本项目。Skill 源码放在 `skills/<name>/SKILL.md`，常驻规则放在 `agents-md/<name>.md`；本文件只用于仓库开发。
- `npx skills` 只用于开发导入：在本项目根目录执行项目级安装，将 skill 下载到 `.agents/skills`，审阅、精简并处理脚本和资源后，加入 `skills/<name>`。不使用全局安装，不将下载缓存、锁文件或凭据提交到仓库。
- 导入示例：`npx skills add <owner/repo> --skill <name> --agent codex --yes`。同步运行时不调用 `npx skills`。
- 包含脚本的自有 skill 必须提供独立的 `dryrun.mjs`，仅检查环境与配置，不上传文件、不执行业务或调用计费 API。

## 清单与同步

- `harness.json` 管理全局 `agents`、`skill`、`agents-md`、`sync-rules` 和 `deleted`。Skill 记录仅含 `name`、GitHub `source`；片段仅含 `name`；规则成员和删除记录使用 `type_name`，删除 skill 保留来源。名称在同类中唯一，规则不嵌套、不引用删除项。
- 支持 `codex`、`github-copilot`。规则回调集中注册：`auto` 无条件，`win` 检测 Windows，`learn` 检测 Windows 和显式调用。
- `sync.mjs` 是同步入口，使用 Node.js 内置模块、Git 和 curl。读取远程 main 清单，按来源浅克隆：自有来源读取 main，第三方读取默认分支；自有 skill 位于 `skills/<name>`，第三方按 `SKILL.md` 查找，名称歧义或格式错误时报错。
- 执行顺序为规则回调 → 下载 → 检查全部 skill → 覆盖同一份源码 → 写入片段。普通同步和 add 中，skill 内部检查未通过仅警告，继续应用和保存；显式 `--dryrun` 不安装且检查失败返回非零。下载、结构校验、复制等流程错误仍中止对应操作，不保存设置，不掩盖原始错误。
- 共享正文复制到 `<home>/.agents/skills/<name>`。仅当显式 `--home` 不同于用户主目录时，再复制到生效 agents 的 `.codex/skills`、`.copilot/skills`；用户主目录不额外建立入口。保留父目录链接，源码不接受链接或特殊文件。
- 每个安装目录的 `.eh-source.json` 记录来源，覆盖和删除前校验。无标记的同名目录按清单选中处理；保留清单外内容和其他工具的锁文件。复制先准备完整副本，再替换目标；替换失败恢复原目录。
- 删除只处理选中 skill 和 agents。自定义 home 保留未选中 agent 的副本及共享正文；用户主目录的共享正文须同时选择全部支持的 agents 才可删除。关闭同步不卸载内容。
- `agents-md` 按生效 agents 写入 `.codex/AGENTS.md`、`.copilot/copilot-instructions.md`，包括 `home=~`。片段标记使用 `<!-- eh:<name>:start -->` / `<!-- eh:<name>:end -->`，写前校验全部目标，保留标记外内容和目标文件链接。
- `--home` 控制内容、指令、本机配置和检查子进程的主目录；显式值优先于 agent 环境变量。Git 保留原身份和认证。运行前按当前 session 的实际 skill 路径确认同步根目录。
- 下载和 Git 操作的临时副本放在用户主目录 `~/temp`，不随内容 `--home` 改变。临时目录、写入暂存文件和替换备份清理失败时，报告具体失败路径并继续，不覆盖原始操作错误；正式内容删除失败仍报错。
- 本机 `.everything-harness/harness.json` 保存规则成员和可选的 agents 覆盖；每个规则整份覆盖远程。首次保存 `{"sync-rules":{}}`；读取其他受支持格式时保留原文件，成功后保存规范格式。`--list`、`--dryrun` 不修改正式安装和配置。
- `--local` 只操作本机。远程清单变更在隔离副本中 commit / push，只提交清单及对应自有源码的删除；不改用户工作区、不强推。删除项长期保留，失败保留已完成操作和未推送改动。
- `clean.mjs` 始终清理用户主目录，`--home` 增加目标。删除三个 agent 目录下清单活动项和删除项的同名 skill；清除根目录及 agent 目录指令文件的全部 eh 块，保留其他正文、配置和锁文件。提供 `--dryrun`，写前校验全部片段。

## 实现与验证

- 保持代码和文档简洁，只描述当前设计，不记录修改过程。不扩展 TUI、安装数据库或通用链接管理。
- Node.js ≥22.20.0，UTF-8 / LF。维护 skill 时同步维护 `SKILL.md` 和 dryrun；操作说明集中在 `skills/harness-manage/SKILL.md`。
- 使用 `node --test`。安装、Git 发布和删除测试使用隔离目录；真实 GitHub 测试通过 `SKILLS_INTEGRATION=1` 启用。不得修改个人 harness 配置，如实说明联网或环境限制。
