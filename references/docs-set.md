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

- **存量异构结构无损融合铁律**：接入已有仓库时严格遵循 `artifactPlan` 逐项处置——**已存在的 `README`、`CONTRIBUTING`、单/双 `LICENSE`、已有自动化工作流、`.agents/skills/<custom>/` 与非标目录布局一律原样保留融合（`preserve`），绝不推翻既有目录树或强行统一模板风格**；只补真实缺项并局部校准漂移路径。

## 二、四层设计文档体系（`docs/`）

彻底替代零散临时单据，全部落在 `docs/` 下各司其职（无手写汇总索引表，全景由 `doc-plan.mjs list` 实时扫描文件头生成，避免多人并行 PR 频繁冲突）：

| 层级与路径 | 模板骨架 | 生命周期与分工 |
| --- | --- | --- |
| **技术设计契约**：`docs/TDD.md` | `templates/docs-tdd.md` | **常青权威**。模块拓扑、主数据流、**`arch-rules` 分层禁引**、**`Feature Map -> smoke-verify`**、核心不变量与高风险同步边界；有代码仓必配，契约变更必须同提交更新 |
| **产品需求说明**：`docs/prd/YYMMDD-<slug>.md` | `templates/docs-prd.md` | **按需创建**。痛点、In/Non-Goals、**复用既有模块**、**门型与回滚路径**及头部 `- Plan Critique: pending`，须经内审与 `critique-pass` 方可 `approve` |
| **功能设计规范**：`docs/specs/YYMMDD-<slug>.md` | `templates/docs-spec.md` | **Case 4 专用**。头部 `Status: draft \| approved \| implemented \| superseded` 与 `- Plan Critique: pending`；含**复用既有模块**、**门型与回滚路径**与冻结 `C1/C2...`；合入后标 `implemented` 并**长留作边界参考** |
| **任务执行单**：`docs/todo/YYMMDD-<slug>.md` | `templates/docs-todo.md` | **Case 3/4 执行清单**。含 `Planned at: <HEAD SHA>`、**复用既有模块**、**本期不做**、**门型与回滚路径**、`- [ ] C1: ...`、`## 完成后的记录`（**在合并之前写完，随这次改动一起提交**）。PR 提交前由 `flow.mjs finalize` 核验全勾并 `git mv` 归档至 `docs/archive/todo/` |

- **`docs/TDD.md` 重入校准**：跨月重入或存量补齐时，依据勘察输出 `reentry.staleTddPaths` 与 `reentry.unregisteredTopDirs` 局部校准——**保留既有模块约束与人工架构决断，仅清理失效路径并补齐新增顶层模块、`arch-rules` 与 `Feature Map` 映射**。

## 三、`AGENTS.md`：给 AI 看的契约（<= 30KB，严进常删）

- **唯一生成入口**：`node scripts/compose-agents.mjs <目标目录>`（母版 `templates/agents-project.md`）。渲染后**严禁残留**任何 `{{VAR}}` 或 `if/endif`；改写已有非空 `AGENTS.md` 前（含默认刷新、`--upgrade` 与有变化的 `--clean`）自动经 `scripts/backup.mjs` 创建 `.tar.gz` 快照（`--no-backup` 可跳过，`--check` 严格零写入）。
- **核心构成**：
  1. 顶部 **8 行自然语言静默意图路由表**（直载 `.agents/skills/dev-{explore,plan,flow,review,govern}/SKILL.md` 并先跑对应 `.mjs`，绝不要求 `/skill` 或反问）；若检测到仓库自有技能（`kit.customSkills`，如 `.agents/skills/<custom>/`），由 `has-custom-skills` 条件块自动在同区间追加自有技能并存路由，保证与 `equip.mjs` / `compose-agents.mjs --check` 零冲突共存；
  2. **`行事总纲与决策准则`**（四条准则、信任倒金字塔与同类纠偏满 2 次下沉脚本、最优解与 UX/DX/AX 取舍、动手前后四问、不当人肉代理）；
  3. 受管 **`Dev Profile`**（`quick-test` / `full-test` / `smoke-verify` / `merge-gate` / `arch-rules` / `high-risk` / `do-not-edit` 供引擎读取，忽略 `none`/`<...>`）；
  4. **上下文阅读护栏**、五档分流与分级内审、双轴五态身份、三档隔离、合并收尾七步及 `取舍` 人工手写节。
- **体积、反腐与保护升级**：硬上限 **`30KB`（30720 字节）**，**`24KB`（24576 字节）起预警**；遵循**严进常删**与子目录就近 `<subdir>/AGENTS.md`；结合 `govern-audit.mjs` 检查演进温差（`docs.stale-vs-churn`）、围栏感知死链（`docs.dead-link`）、立碑/借口注释与 >800 行神文件，绝不静默覆盖无 `customized` 但相对 `.pf-manifest.json` `agentsRegions` 基线改写过的区段。
- **跨月重入与存量校准模式**：接管已有手写规则或跨月重入时，先核对 `reentry` 信号（`staleAgentPaths` / `staleAgentScripts` / `unregisteredTopDirs`）：**完整保留手写规范与 `.agents/skills/<custom>/`**，仅定点替换失效路径与失效脚本、补充新增顶层模块边界，不借刷新整段覆盖人工约定。

## 四、`README`：给人看的门面

- 骨架 `templates/readme.md` 面向新项目提供可自由定制的模块化母版（落地后可自由增删、重排章节与视觉卡片）；写清价值定位、可复制快速开始、核心能力与工作原理、环境要求（直读清单，严禁「或更高」）、按需目录结构、排查与贡献许可。
- **存量已有 `README` 严禁覆写**：目标仓库已有 `README.md` 时，**严禁拿 `templates/readme.md` 全篇覆盖或强行统一样式**，必须完整保留既有排版与叙述风格，仅在命令失效、最低运行版本过期或缺失关键入口时做最小外科手术式校准。
- 外链徽章不能只看 HTTP 状态码；落盘前须确认返回真实图像而非 `repo not found` / `package not found`，私有仓或不适用时不贴伪造徽章。
- 存在多语言版本（如 `README.md` 与 `README.en.md`）时必须成对更新，保持目录与双向切换链接一致（用 `sync-toc.mjs` 检查目录同步）。

## 五、`CONTRIBUTING` 与协作门槛

- 骨架 `templates/contributing.md`：面向外部贡献者写提问方式、Fork 推 `origin` 开跨仓 PR、本地门禁命令（与 `AGENTS.md` 一致）、提交信息风格与 UTF-8 临时文件 `--body-file` 交互规范。
- 明确「只改错字」网页快捷路不适用代码；**不以内部 `docs/todo/` 或 `docs/specs/` 作为外部贡献者的前置门槛**，维护者内部流程不强加于外人。

## 六、`LICENSE`：许可证决策

- 许可证属于**只能由人拍板的法律选型**；AI 不擅自代选，仅提供常见开源骨架（`templates/license-<类型>.txt`，含 `templates/license-mit.txt`、`templates/license-bsd-2-clause.txt`、`templates/license-bsd-3-clause.txt`、`templates/license-isc.txt`、`templates/license-unlicense.txt`）。
- 目标目录已有双许可（如 `LICENSE-MIT` + `LICENSE-APACHE`）或自定义商业/私有声明时，**不视为缺口，不覆盖补充单文件 `LICENSE`**；私有项目不放许可证时引导在 `AGENTS.md`「## 取舍」中登记 `license`。

## 七、`RELEASING`：给维护者看的发版顺序

- 骨架 `templates/releasing.md` 与 `templates/release-notes.md`；日常改动合并即终点，**只有人明确要求「发版」时才按 `RELEASING.md` 执行**。
- **跨多版本与人类可读去噪**：长周期多轮迭代后支持直接跨越多个版本或指定自定义号（如 `v1.0.0` 直接发布 `3.0.0` / `v4.0.0`），绝不假设单步递增。草拟说明前先跑 `.agents/skills/dev-govern/` 下的 `govern-audit.mjs release-prep [--version <目标号>] [--from <基线>]`，覆盖上个发布标签至 `HEAD`（首发覆盖全史）防遗漏；成文时过滤内部重构、测试/夹具、CI 微调与内部编号，只写用户可见变化，章节支持自由定制或沿用既有 `CHANGELOG.md`（空节整节删去）。
- 严格顺序：先核对唯一版本号来源与兼容性下限 -> 将发布说明 `docs/release-notes/<标签>.md`（或 `CHANGELOG.md` 对应节）提交并推送到默认分支 -> 确认就绪后再打标签推送触发发布流水线（顺序倒置会导致自动化因读不到说明文件失败）。发后必回读发布页与制品库确认就位。
