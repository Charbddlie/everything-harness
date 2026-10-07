# 开发约定

## 开发范围

- `eh` 指本项目。Skill 源码放在 `skills/<name>/SKILL.md`，常驻规则放在 `agents-md/<name>.md`；本文件只用于仓库开发。
- 内容、来源和规则在 `harness.json` 中维护，删除项长期保留在 `deleted`；harness 路径统一在 `harnesses.json` 中定义并按名称读取。
- 同步入口为 `sync.mjs`，依赖 Node.js 内置模块、Git 和 curl。同步与清理共用路径枚举、指令块处理、原子写入和目录删除实现。
- 操作说明集中在 `skills/harness-manage/SKILL.md`。文档只保留必要的当前约束，清除历史记录和已由代码或流程固定的细节。
- 保持实现简洁，不扩展 TUI、安装数据库或通用链接管理。

## Skill 导入与维护

- 在项目根目录执行 `npx skills add <owner/repo> --skill <name> --agent codex --yes`，下载到项目级 `.agents/skills`，审阅、精简并处理脚本和资源后加入 `skills/<name>`。
- `npx skills` 限于开发导入，禁止全局安装及提交下载缓存、锁文件或凭据。
- 安装时校验 skill 源码结构，随后复制内容。
- 维护 skill 时同步维护 `SKILL.md`。
- Skill 在 `SKILL.md` 中列出所需 key、用途和获取方式，本机凭据统一存入当前 harness 实际使用的 `<skill>/scripts/key.env`。脚本优先读取环境变量，再从该文件补齐；缺失时以非零状态退出，列出缺失键名及文件路径。
- 缺少 key 时，agent 自动生成或查询可取得的值；外部服务密钥向用户询问，按键补全 `scripts/key.env`、保留其他配置，再重试原命令。密钥值只保留在本机。

## 环境与验证

- Node.js ≥22.20.0，文件统一使用 UTF-8 / LF。
- Windows 下 sync 的全部命令行输出使用 GBK，无法表示的字符替换为 `?`；其他系统使用 UTF-8。
- 开发验证使用隔离目录及本地仓库，保留个人 harness 配置。
