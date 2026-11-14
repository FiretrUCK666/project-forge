# 项目文档体系与工程契约

## 何时读本文件

需要为项目生成、刷新、瘦身或体检工程文档（`AGENTS.md`、`docs/` 四层文档、`README`、`CONTRIBUTING`、`LICENSE`、`RELEASING`）之前读完本文件。

## 一、按场景分流：不塞多余空文件

| 项目现状 | 启用文档范围 | 明确不塞的文件 |
| --- | --- | --- |
| 纯本地个人工具（无远端） | `AGENTS.md`、`README.md`、`docs/TDD.md`（代码仓）、按需 `docs/todo/` | 不强求 `CONTRIBUTING.md`、CI、发布说明 |
| 有 GitHub 远端且收贡献 | 上述 + `CONTRIBUTING.md` + GitHub Issue/PR 模板 + `LICENSE` | 不必强行开启发布流水线（无分发包时） |
| 对外发版 / 插件 / 包 | 上述 + `RELEASING.md` + `docs/release-notes/` | 未确认发版模式前不乱改既有 `CHANGELOG` |
| 纯文档 / 能力目录 | `AGENTS.md`、`README.md`、协作与交付说明 | 不填伪构建/伪测试命令 |

## 二、四层设计文档体系（`docs/`）

彻底替代零散临时单据，全部落在 `docs/` 下各司其职（无手写汇总索引表，全景由 `doc-plan.mjs list` 实时扫描文件头生成，避免多人并行 PR 频繁冲突）：

| 层级与路径 | 模板骨架 | 生命周期与分工 |
| --- | --- | --- |
| **技术设计契约**：`docs/TDD.md` | `templates/docs-tdd.md` | **常青权威**。模块拓扑、主数据流、核心不变量、对外契约与高风险同步边界；有代码仓必配，契约变更必须同提交更新 |
| **产品需求说明**：`docs/prd/YYMMDD-<slug>.md` | `templates/docs-prd.md` | **按需创建**。解决什么痛点、In/Non-Goals、关键用户路径与待拍板项 |
| **功能设计规范**：`docs/specs/YYMMDD-<slug>.md` | `templates/docs-spec.md` | **Case 4 专用**。头部 `Status: draft \| approved \| implemented \| superseded`；含冻结 `C1/C2...`；合入后更新为 `implemented` 与「实现说明」，**长留作已实现行为边界参考** |
| **任务执行单**：`docs/todo/YYMMDD-<slug>.md` | `templates/docs-todo.md` | **Case 3/4 执行清单**。含 `Planned at: <HEAD SHA>`、快测命令、`- [ ] C1: ...`、`## 完成后的记录`（**在合并之前写完，随这次改动一起提交**）。PR 提交前由 `flow.mjs finalize` 核验全勾并 `git mv` 归档至 `docs/archive/todo/` |

## 三、`AGENTS.md`：给 AI 看的契约（<= 30KB，严进常删）

- **唯一生成入口**：`node scripts/compose-agents.mjs <目标目录>`（母版 `templates/agents-project.md`）。渲染后**严禁残留**任何 `{{VAR}}` 或 `if/endif`。
- **核心构成**：
  1. 顶部 **8 行自然语言静默意图路由表**（直载 `.agents/skills/dev-{explore,plan,flow,review,govern}/SKILL.md` 并先跑对应 `.mjs`，绝不要求 `/skill` 或反问）；
  2. 受管 **`Dev Profile`**（`quick-test` / `full-test` / `merge-gate` / `high-risk` / `do-not-edit` 供引擎读取）；
  3. **上下文阅读护栏**（按序读取与默认跳过目录）；
  4. 五档分流、双轴五态身份、三档隔离与合并收尾七步、`取舍` 人工手写节。
- **体积与演进红线**：硬上限 **`30KB`（30720 字节）**，**`24KB`（24576 字节）起预警**；超限会阻断生成与 `--check`。遵循**严进常删**：能在源码 10 秒看出的细节不写入，长篇原理下沉 `docs/TDD.md`，子目录特例写入 `<subdir>/AGENTS.md`（首行指回根契约，仅记局部例外）。
- **无损保护升级**：有 `fill` 标记的段落一旦人写过并删去 `fill` 就永久不动；加 `customized` 标记的段不覆盖；当目标库存在 `.agents/skills/.pf-manifest.json` 的 `agentsRegions` 基线时，未标 `customized` 但磁盘 SHA256 与基线不符的受管区间**自动保护跳过并告警**，绝不静默冲掉用户跨月手改。

## 四、`README`：给人看的门面

- 骨架 `templates/readme.md`。面向人类读者写定位、5 分钟上手步骤、环境要求（必须与 `AGENTS.md` 一致）、目录概览与反馈渠道。
- 外链徽章不能只看 HTTP 状态码；仓库仍私有或不适用时不贴伪造公开构建徽章。
- 存在多语言版本（如 `README.md` 与 `README.en.md`）时必须成对更新，保持目录与双向切换链接一致（用 `sync-toc.mjs` 检查目录同步）。

## 五、`CONTRIBUTING` 与协作门槛

- 骨架 `templates/contributing.md`：面向外部贡献者写提问方式、Fork 推 `origin` 开跨仓 PR、本地门禁命令（与 `AGENTS.md` 一致）、提交信息风格与 UTF-8 临时文件 `--body-file` 交互规范。
- 明确「只改错字」网页快捷路不适用代码；**不以内部 `docs/todo/` 或 `docs/specs/` 作为外部贡献者的前置门槛**，维护者内部流程不强加于外人。

## 六、`LICENSE`：许可证决策

- 许可证属于**只能由人拍板的法律选型**；AI 不擅自代选，仅提供常见开源骨架（`templates/license-<类型>.txt`，含 `templates/license-mit.txt`、`templates/license-bsd-2-clause.txt`、`templates/license-bsd-3-clause.txt`、`templates/license-isc.txt`、`templates/license-unlicense.txt`）。
- 目标目录已有双许可（如 `LICENSE-MIT` + `LICENSE-APACHE`）或自定义商业/私有声明时，**不视为缺口，不覆盖补充单文件 `LICENSE`**；私有项目不放许可证时引导在 `AGENTS.md`「## 取舍」中登记 `license`。

## 七、`RELEASING`：给维护者看的发版顺序

- 骨架 `templates/releasing.md` 与 `templates/release-notes.md`；日常改动合并即终点，**只有人明确要求「发版」时才按 `RELEASING.md` 执行**。
- 严格顺序：先核对唯一版本号来源与兼容性下限 -> 将发布说明 `docs/release-notes/<标签>.md` 提交并推送到默认分支 -> 确认就绪后再打标签推送触发发布流水线（顺序倒置会导致自动化因读不到说明文件失败）。发后必回读发布页与制品库确认就位。
