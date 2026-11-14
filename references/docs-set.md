# 项目文档体系与工程契约

## 何时读本文件

需要为项目生成、刷新、瘦身或体检工程文档（`AGENTS.md`、`docs/` 四层文档、`README`、`CONTRIBUTING`、`LICENSE`、`RELEASING`）之前读完本文件。

## 一、按场景分流与两档渐进装配

| 项目现状 | 启用文档范围与推荐档位 | 明确不塞的文件 |
| --- | --- | --- |
| 纯本地个人工具 / 小型仓库 | `lightweight` 档：`AGENTS.md`（`< 14KB`）、`README.md`、`docs/TDD.md`（代码仓）、按需 `docs/todo/` | 不强求 `CONTRIBUTING.md`、CI、发布说明 |
| 多人协作 / 大型仓库 | `full` 档：全套 5 个技能 + 上述 + `CONTRIBUTING.md` + Issue/PR 模板 + `LICENSE` + CI | 不必强行开启发布流水线（无分发包时） |
| 对外发版 / 插件 / 包 | `full` 档 + `RELEASING.md` + 发布说明（`docs/release-notes/` 或 `CHANGELOG.md`） | 未确认发版策略前不乱改既有 `CHANGELOG` |
| 纯文档 / 能力目录 | `AGENTS.md`（`Dev Profile` 测试键写 `none`）、`README.md`、协作与交付说明 | 不填伪构建/伪测试命令 |

- **存量异构结构无损融合铁律**：接入已有仓库时严格遵循 `artifactPlan` 逐项处置——**已存在的 `README`、`CONTRIBUTING`、单/双 `LICENSE`、存量架构设计文档（`ARCHITECTURE.md`、`*-TDD.md`、`docs/{design,architecture,adr}/`）、已有自动化工作流、`.agents/skills/<custom>/` 与非标目录布局一律原样保留融合（`preserve`），绝不推翻既有目录树或强制建立第二套双轨设计文档**；随时可通过 `equip.mjs --tier full` 与 `compose-agents.mjs --tier full` 无损升档补齐缺失资产。

## 二、四层设计文档体系（`docs/`）

初始化时常驻 `docs/prd/.gitkeep`、`docs/specs/.gitkeep`、`docs/todo/.gitkeep`；全部工程单据统一由 `doc-plan.mjs` 与 `doc-templates.mjs` 同源生成（无手写汇总索引表，全景由 `doc-plan.mjs list` 实时扫描文件头生成，避免多人并行 PR 冲突）：

| 层级与路径 | 模板骨架 | 生命周期与统一结构 |
| --- | --- | --- |
| **技术设计契约**：`docs/TDD.md` | `templates/docs-tdd.md` | **常青权威**。H1 下包含 `## 文档信息` 表与技术基线表，含目录、架构全景（短名 Mermaid `flowchart` + 模块表 + `arch-rules` + `Feature Map`）、核心流程与安全不变量；`[按需保留，不适用整节删除]` 节不用即删，不留空壳占位 |
| **产品需求说明**：`docs/prd/YYMMDD-[issue<N>-]<slug>-prd.md` | `templates/docs-prd.md` | **按需创建**。YAML Frontmatter + 一级标题下 `## 文档信息` 表；含痛点、In/Non-Goals、**复用既有模块**、**门型与回滚路径**与 `- [ ] C1:` 验收标准，须经内审与 `critique-pass` 方可 `approve` |
| **功能设计规范**：`docs/specs/YYMMDD-[issue<N>-]<slug>-spec.md` | `templates/docs-spec.md` | **Case 4 专用**。YAML Frontmatter + 一级标题下 `## 文档信息与变更概览` 表 + `## 系统变更全景`（短名 Mermaid 图与模块变更对照表）；含**复用既有模块**、**本期不做**、**门型与回滚路径**与冻结 `C1/C2...`；合入后标 `implemented` |
| **任务执行单**：`docs/todo/YYMMDD-[issue<N>-]<slug>-todo.md` | `templates/docs-todo.md` | **Case 3/4 执行清单**。YAML Frontmatter + 一级标题下 `## 文档信息与范围概览` 表；含影响路径、**复用既有模块**、**本期不做**、**门型与回滚路径**、`- [ ] C1: ...`、`## 完成后的记录`（**在合并之前写完，随这次改动一起提交**） |

- **成对归档与生命周期联动**：认领 Issue 或传入 `--issue` 时由 `doc-plan.mjs link` / `flow.mjs` 自动补 `-issue<N>-` 重命名并互刷 `related_*`；任务验证通过且常青设计同步进 `docs/TDD.md` 后，由 `flow.mjs finalize` 或 `doc-plan.mjs archive` 将关联 `PRD`（`done`）、`SPEC`（`implemented`）与 `Todo`（`done`/`archived`）一并 `git mv` **成对归档**至 `docs/archive/{prd,specs,todo}/` 并重算三者 `related_*` 相对路径；被新版替代的规格执行 `doc-plan.mjs supersede` 标为 `superseded`。`do-not-edit: docs/archive/` 仅禁止人工篡改历史归档，允许工具在 `finalize`/`archive` 时合法写入归档目录。
- **Mermaid `16/12` 防截断与可读性硬门禁**：图只画拓扑短名，详细路径与职责一律写进图下对照表；禁止在节点或边标签内使用 `<br/>` 等 HTML 标签；单行显示宽度（全角/汉字计 `2` 单位、半角 ASCII 计 `1` 单位）：**矩形节点与分组标题 `<= 16` 单位，菱形节点与边标签 `<= 12` 单位**。该门禁已由 `kit/skills/lib/docs.mjs`（`checkMermaidLabelWidth`）随包接入 `doc-plan.mjs audit`、`review-pack.mjs` 与 `govern-audit.mjs`。
- **`docs/TDD.md` 三场景生成与持续校准（与 `S1` / `--bootstrap-empty` / `dev-explore` 协同）**：
  1. **空白目录起步（`maturity: 'empty'`，`explorationStrategy.tier: 'none'`）**：走 `equip.mjs --bootstrap-empty --lang <node|python|go|rust|java|docs>` 直接落盘可运行骨架与含 `## 文档信息` 表、`Feature Map`、`arch-rules: none` 的初始 `docs/TDD.md`，**不派只读子代理**；待后续模块扩展后再按通用骨架扩充。
  2. **存量仓库接入（`single-pass` / `parallel-subagents`）**：`S1` 由 `survey.mjs` 计算 `explorationStrategy.tier` 与分片；`S3` 先跑 `backup.mjs` 与 `equip.mjs` 装配 `.agents/skills/`，再调用 `.agents/skills/dev-explore/` 内的 `repo-map.mjs`（`parallel-subagents` 时按不重叠 `shards` 并行派发只读子代理勘察入口、模块边界、主数据流与状态机）汇总真实事实，以 `templates/docs-tdd.md` 为骨架编写 `docs/TDD.md`（已存在存量设计文档则优先 `preserve` 并在 `AGENTS.md`「## 取舍」登记），先于 `compose-agents.mjs` 写入。
  3. **日常迭代与跨月重入校准**：改动涉及顶层模块边界、对外 CLI 或共享契约时，`flow.mjs finalize` 核查 `docs/TDD.md` 最近更新日期同步；日常结合 `govern-audit.mjs` 检查 `docs.tdd-module-drift`、失效路径与活跃文档 Frontmatter/互链（`docs.frontmatter-invalid`、`docs.broken-related-link`、`docs.filename-issue-mismatch`）；跨月重入依 `survey.mjs` 输出的 `reentry.staleTddPaths` 与 `unregisteredTopDirs` 局部校准，保留既有架构决断。

## 三、`AGENTS.md`：给 AI 看的契约（`lightweight < 14KB` / `full <= 30KB`）

- **唯一生成入口**：`node scripts/compose-agents.mjs <目标目录> [--tier lightweight|full]`（母版 `templates/agents-project.md`）。渲染后**严禁残留**任何 `{{VAR}}` 或 `if/endif`；改写已有非空 `AGENTS.md` 前（含默认刷新、`--upgrade` 与有变化的 `--clean`）自动经 `scripts/backup.mjs` 创建 `.tar.gz` 快照（`--no-backup` 可跳过，`--check` 严格零写入）。
- **核心构成**：
  1. 顶部 **自然语言静默意图路由表**（直载已装配的 `.agents/skills/` 并先跑对应 `.mjs`，`lightweight` 档自动过滤未装入的 `dev-review`/`dev-govern` 行；若有仓库自有技能 `kit.customSkills`，由 `has-custom-skills` 自动追加并存路由）；
  2. **`行事总纲与决策准则`**（四条准则、信任倒金字塔与同类纠偏满 2 次下沉脚本、最优解与 UX/DX/AX 取舍、不当人肉代理）与**测试分层与控频**；
  3. 受管 **`Dev Profile`**（`quick-test` / `full-test` / `smoke-verify` / `merge-gate` / `arch-rules` / `high-risk` / `do-not-edit` 供引擎统一从 `profile.mjs` 读取，**显式 `none` 视为合法禁用态绝不回退覆盖**）；
  4. **上下文阅读护栏**、五档分流、身份与隔离收尾、`高风险路径`、`改哪看哪` 联动表及 `取舍` 人工手写节。
- **体积、保护与重入校准**：`full` 档硬上限 **`30KB`（30720 字节）**、**`24KB`（24576 字节）起预警**；`lightweight` 档控制在 **`14KB` 以内**；遵循**严进常删**与子目录就近 `<subdir>/AGENTS.md`；缺 `agentsRegions` 基线时对既有非空区段默认采取 `protect` 不覆盖，已删区间记入 `removedAgentsRegions` 不强行插回；跨月重入时先核对 `reentry` 信号（`staleAgentPaths` / `staleAgentScripts` / `unregisteredTopDirs`），完整保留手写规范与 `.agents/skills/<custom>/`。

## 四、`README`：给人看的门面

- 骨架 `templates/readme.md` 面向新项目提供可自由定制的模块化母版（落地后可自由增删、重排章节与视觉卡片）；写清价值定位、可复制快速开始、核心能力与工作原理、环境要求（直读清单，严禁「或更高」）、按需目录结构、排查与贡献许可；若仓库已配备 `.agents/skills/`，可附简洁使用入口。
- **文风与真实性**：采用朴实直白表达（`oil-tone` 原则：事实边界内平铺直叙、语法完整、中英文及数字间留空格、无虚构能力与空洞套话、无 emoji），所有命令直接可复制执行，不出现只有 AI 才懂的占位描述。
- **徽章分型与防「200 假绿」**：按项目形态选配 **3–6 枚已实测出图的徽章**，覆盖五类信息：CI 工作流状态、已发布制品库版本、运行环境基线、许可证、实证工程特征。落盘前须确认图片内容而非仅看 HTTP 状态码；**私有仓或未发布制品严禁保留公开动态徽章与制品库查询徽章**。
- **图解浅深色可读性**：若配备 SVG 架构图或头图，须保证在 GitHub 浅色与深色主题下同样清晰——推荐中性亮底画布（如 `#F5F3EE`）配深色高对比文字（如 `#172033` / `#1A1D24`）与边框，保留 `<title>` 与 `<desc>` 无障碍文本，字号不低于 `16`。
- **存量已有 `README` 严禁覆写（`preserve`）**：目标仓库已有 `README.md` 时，**严禁拿 `templates/readme.md` 全篇覆盖或强行统一样式**，仅对失效命令、最低运行版本或缺失入口做最小校准；多语版本成对同步并用 `sync-toc.mjs` 检查目录。

## 五、`CONTRIBUTING` 与协作门槛

- 骨架 `templates/contributing.md`：面向外部贡献者写提问方式、Fork 推 `origin` 开跨仓 PR（团队写权限协作者直接同源独立分支开 PR）、本地门禁命令（与 `AGENTS.md` 一致）、提交信息风格与 UTF-8 临时文件 `--body-file` 交互规范。
- 明确「只改错字」网页快捷路不适用代码；**不以内部 `docs/todo/` 或 `docs/specs/` 作为外部贡献者的前置门槛**，维护者内部流程不强加于外人。

## 六、`LICENSE`：许可证决策

- 许可证属于**只能由人拍板的法律选型**；AI 不擅自代选，仅提供常见开源骨架（`templates/license-<类型>.txt`，含 `templates/license-mit.txt`、`templates/license-bsd-2-clause.txt`、`templates/license-bsd-3-clause.txt`、`templates/license-isc.txt`、`templates/license-unlicense.txt`）。
- 目标目录已有双许可（如 `LICENSE-MIT` + `LICENSE-APACHE`）或自定义商业/私有声明时，**不视为缺口，不覆盖补充单文件 `LICENSE`**；私有项目不放许可证时引导在 `AGENTS.md`「## 取舍」中登记 `license`。

## 七、`RELEASING`：给维护者看的发版顺序

- 骨架 `templates/releasing.md` 与 `templates/release-notes.md`；日常改动合并即终点，**只有人明确要求「发版」时才按 `RELEASING.md` 执行**。
- **跨多版本与人类可读去噪**：长周期多轮迭代后支持直接跨越多个版本或指定自定义号（如 `v1.0.0` 直接发布 `3.0.0` / `v4.0.0`），绝不假设单步递增。草拟说明前先跑 `.agents/skills/dev-govern/` 下的 `govern-audit.mjs release-prep [--version <目标号>] [--from <基线>]`，覆盖上个发布标签至 `HEAD`（首发覆盖全史）防遗漏；成文时过滤内部重构、测试/夹具、CI 微调与内部编号，只写用户可见变化，空节整节删去。
- 严格顺序：先核对唯一版本号来源与兼容性下限 -> 将发布说明 `docs/release-notes/<标签>.md`（或 `CHANGELOG.md` 对应节）提交并推送到默认分支 -> 确认就绪后再打标签推送触发发布流水线。发后必回读发布页与制品库确认就位。
