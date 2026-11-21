# 项目文档体系与工程契约

## 何时读本文件

需要为项目生成、刷新、瘦身或体检工程文档（`AGENTS.md`、`docs/` 四层文档、`README`、`CONTRIBUTING`、`LICENSE`、`RELEASING`）之前读完本文件。

## 一、按真实协作态裁剪文档与统一装配

| 项目现状 | 启用文档范围与统一装配 | 明确不塞的文件 |
| --- | --- | --- |
| 纯本地个人工具 / 单人仓库 | 统一装配研发套件 + 紧凑 `AGENTS.md`（约 `15–20KB`，上限 `30KB`）、`README.md`、`docs/TDD.md`（代码仓）、按需 `docs/todo/` | 不强求 `CONTRIBUTING.md`、CI、发布说明 |
| 多人协作 / 团队仓库 | 统一装配研发套件 + 上述 + `CONTRIBUTING.md` + Issue/PR 模板 + `LICENSE` + CI | 不必强行开启发布流水线（无分发包时） |
| 对外发版 / 插件 / 包 | 上述 + `RELEASING.md` + 发布说明（`docs/release-notes/` 或 `CHANGELOG.md`） | 未确认发版策略前不乱改既有 `CHANGELOG` |
| 纯文档 / 能力目录 | `AGENTS.md`（`Dev Profile` 测试键写 `none`）、`README.md`、协作与交付说明 | 不填伪构建/伪测试命令 |

- **四类存量资产真融合与原仓建单流**：接入已有仓库时严格遵循 `artifactPlan` 逐项落实四类真融合，绝不推翻既有目录树或制造双轨文档：
  1. **长青文档**（`README`、`CONTRIBUTING`、`LICENSE`、`ARCHITECTURE.md`、`*-TDD.md`、`docs/{design,architecture,adr}/`）：一律 `preserve` 并统一纳管进 `evergreen-docs:` / `docs/TDD.md`，合并冲突副本；
  2. **非长青/过期/无效文档**：归档至 `docs/archive/` 或标出无效残片确认清理，防止污染 `doc-locate`；
  3. **既有脚本、工具、数据模型与 CI**：融入 `Dev Profile`、`docs/feature-map.json` 与 `docs/TDD.md`（`tdd-shape.mjs` 裁剪），标出失效脚本清理建议；
  4. **既有 AI 约定**（`AGENTS.md`、`CLAUDE.md`、`.cursorrules`、`.agents/skills/<custom>/`）：做语义去重与无损融合；勘察发现的原仓遗留问题统一通过 `TaskBackend` 建本地/远端 Issue 按正常流程分步修清。随时可通过 `equip.mjs` 与 `compose-agents.mjs` 无损补齐缺失资产。

## 二、四层设计文档体系（`docs/`）

初始化时常驻 `docs/prd/.gitkeep`、`docs/specs/.gitkeep`、`docs/todo/.gitkeep`；全部工程单据统一由 `doc-plan.mjs` 与 `doc-templates.mjs` 同源生成（无手写汇总索引表，全景由 `doc-plan.mjs list` 实时扫描文件头生成，避免多人并行 PR 冲突）：

| 层级与路径 | 模板骨架 | 生命周期与统一结构 |
| --- | --- | --- |
| **技术设计契约**：`docs/TDD.md` | `kit/skills/templates/docs-tdd.md` | **常青权威**。必备五节与项目形态无关：文档信息、背景与非目标、架构与模块职责、主流程与状态流转、不变量与红线。其余章节（技术栈选型、外部集成、数据模型、对外接口、部署差异、性能基线、前端交互、安全细节）**由 `survey` 按仓库真实文件清单判定**：有 `migrations/` 才要数据模型，有 `Dockerfile` 才要部署节，纯库项目没有接口表就不写。判定与裁剪见 `tdd-shape.mjs`；生成时还会从清单、目录与 Dev Profile 预填技术栈、模块表与验证命令，不让人把已知的东西再抄一遍 |
| **产品需求说明**：`docs/prd/YYMMDD-[issue<N>-]<slug>-prd.md` | `kit/skills/templates/docs-prd.md` | **按需创建**。YAML Frontmatter + 一级标题下 `## 文档信息` 表；**主干三节锁死**（要做什么、不做什么、`- [ ] C1:` 验收标准），其余章节（身份权限、业务流程、状态规则、非功能要求、复用模块、门型与回滚、待拍板）**按项目形态取舍**——纯工具类项目没有「用户身份」，数据管道没有「关键交互」，都可以不写；须经内审与 `critique-pass` 方可 `approve` |
| **功能设计规范**：`docs/specs/YYMMDD-[issue<N>-]<slug>-spec.md` | `kit/skills/templates/docs-spec.md` | **Case 4 专用**。YAML Frontmatter + 一级标题下 `## 文档信息与变更概览` 表 + `## 系统变更全景`（短名 Mermaid 图与模块变更对照表）；**主干三节锁死**（要改什么、本期不做、冻结的 `C1..Cn`），其余（替代方案与否决理由、数据与状态变更、实现顺序、上线与兼容策略）按需保留；含**复用既有模块**、**门型与回滚路径**与冻结 `C1/C2...`；合入后标 `implemented` |
| **任务执行单**：`docs/todo/YYMMDD-[issue<N>-]<slug>-todo.md` | `kit/skills/templates/docs-todo.md` | **Case 3/4 执行清单**。YAML Frontmatter + 一级标题下 `## 文档信息与范围概览` 表；**主干三节锁死**（影响路径与验证基准、`- [ ] C1: ...`、完成后的记录），其余（执行步骤表、风险与应对、断点与遗留决策）按需保留；含**复用既有模块**、**本期不做**、**门型与回滚路径**、`## 完成后的记录`（**在合并之前写完，随这次改动一起提交**） |

- **需求澄清、多轮停损与总控 PRD 四态闭环**：`dev-plan` 在复杂或跨模块场景下支持主动建议先建总控 PRD，经多轮互动澄清消解全部「待拍板事项」后再进 `audit` 与独立 Critique（支持 `--worktree` / `flow.mjs start --planning` 隔离起草、`--milestone` 关联；轮次裁定存单任务账本 `ledger.planCritique`，Frontmatter 仅留精简 `plan_critique`；`critique-pass`/`critique-reject` 禁止自审 `SELF_CRITIQUE_REJECTED`、全历史换人 `BLOCKED_CRITIQUE_SAME_REVIEWER`、未改稿重审 `BLOCKED_CRITIQUE_SAME_SHA` 及 3 轮硬停损 `STOP_LOSS_ESCALATE`，停损后支持 `critique-continue`，仅人类 `critique-override --human-approved --reason` 解锁 `approve`；尊重仓内自有模板 `docs/templates/*.md` / `.github/*-template.md`）。认领或传入 `--issue` 时自动补 `-issue<N>-` 互刷 `related_*`；验证与 `docs/TDD.md` 同步通过后，由 `flow.mjs finalize` 或 `doc-plan.mjs archive` 成对 `git mv` 归档至 `docs/archive/{prd,specs,todo}/` 并重算互链；`1:N` 总控 PRD 由 `evaluateMasterPrdClosureState` 执行确定性四态闭环：① 手动策略或仍有活跃兄弟切片维持 `active`；② 尚留未覆盖后续 `C*` 维持 `active`；③ 100% 覆盖且全勾 `[x]` 时无需 `--include-master-prd` 即自动同分支归档（含并行后 `sync`/rebase 幂等重跑 `finalize`）并记入 `archivedPrdFile` 豁免 `do-not-edit`；④ 100% 覆盖却仍留 `[ ] C*` 时 `finalize` 与 `verify` 均阻断并返回 `BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED` 与单一 `[NEXT STEP]`。被替代规格用 `supersede` 标 `superseded`；`govern-docs.mjs` 跳过 `docs/archive/` 而拦截活跃目录死链。与 `AGENTS.md`、`docs/feature-map.json` 共同构成三层常青文档。
- **Mermaid `16/12` 防截断与可读性硬门禁**：图只画拓扑短名，详细路径与职责一律写进图下对照表；禁止在节点或边标签内使用 `<br/>` 等 HTML 标签；单行显示宽度（全角/汉字计 `2` 单位、半角 ASCII 计 `1` 单位）：**矩形节点与分组标题 `<= 16` 单位，菱形节点与边标签 `<= 12` 单位**。该门禁已由 `kit/skills/lib/docs.mjs`（`checkMermaidLabelWidth`）随包接入 `doc-plan.mjs audit`、`review-pack.mjs` 与 `govern-audit.mjs`。
- **`docs/TDD.md` 三场景生成与持续校准（与 `S1` / `--bootstrap-empty` / `dev-explore` 协同）**：
  1. **空白目录起步（`maturity: 'empty'`，`explorationStrategy.tier: 'none'`）**：走 `equip.mjs --bootstrap-empty [--stack <universal|node|python|go|rust|java|docs|...>]` 直接落盘零玩具源码通用治理基线、`docs/TDD.md`、`docs/{prd,specs,todo}/.gitkeep`、`.agents/skills/` 与初始自洽 `AGENTS.md`（原样保留已有 `README`/`LICENSE`），**不派只读子代理**；真实业务代码与构建清单就位后再增量校准 `docs/TDD.md` 与 `AGENTS.md`。同时 `doc-plan` 尊重仓库自有的 `docs/templates/*.md` / `.github/*-template.md` 并对 `prd`/`TDD`/非平凡 `todo` 强制独立 Plan Critique（`SELF_CRITIQUE_REJECTED`）。
  2. **存量仓库接入（`single-pass` / `parallel-subagents`）**：`S1` 由 `survey.mjs` 计算 `explorationStrategy.tier` 与分片（含 `business-flows`）；`S1 -> S3` 进入任何写入前先以**只读方式实跑对方既有测试与主入口**记录 `preForgeBaseline`，`S3` 先跑 `backup.mjs` 与 `equip.mjs` 装配 `.agents/skills/`，再调用 `.agents/skills/dev-explore/` 内的 `repo-map.mjs` / `doc-locate.mjs`（`parallel-subagents` 时按不重叠 `shards` 并行派发只读子代理勘察入口、模块边界、主数据流、`businessFlows` 与状态机）汇总真实事实，以 `kit/skills/templates/docs-tdd.md` 为骨架将 `businessFlows` 与 `preForgeBaseline` 写入 `docs/TDD.md`（已存在存量设计文档则优先 `preserve` 并在 `AGENTS.md`「## 取舍」登记），`AGENTS.md` 仅留薄指针指向 `docs/TDD.md` 以维持预算（`<= 30KB`，建议 `< 24KB`），先于 `compose-agents.mjs` 写入。
  3. **日常迭代与跨月重入校准**：改动涉及顶层模块边界、对外 CLI 或共享契约时，`flow.mjs finalize` 核查 `docs/TDD.md` 最近更新日期同步；日常结合 `govern-audit.mjs` 检查 `docs.tdd-module-drift`、失效路径与活跃文档 Frontmatter/互链（`docs.frontmatter-invalid`、`docs.broken-related-link`、`docs.filename-issue-mismatch`）；跨月重入依 `survey.mjs` 输出的 `reentry.staleTddPaths` 与 `unregisteredTopDirs` 局部校准，保留既有架构决断。

## 三、`AGENTS.md`：给 AI 看的紧凑契约（建议 `< 24KB`，上限 `<= 30KB`）

- **唯一生成入口**：`node scripts/compose-agents.mjs <目标目录>`（母版 `templates/agents-project.md`）。渲染后**严禁残留**任何 `{{VAR}}` 或 `if/endif`；改写已有非空 `AGENTS.md` 前（含默认刷新、`--upgrade` 与有变化的 `--clean`）自动经 `scripts/backup.mjs` 创建 `.zip` 快照（支持 `--format tar.gz` 且兼容恢复 `.tar.gz`，`--no-backup` 可跳过，`--check` 严格零写入）。
- **核心构成**：
  1. 顶部 **自然语言静默意图路由表**（按磁盘已落盘的 `.agents/skills/` 动态渲染并过滤显式 `disabledSkills`；若有仓库自有技能 `kit.customSkills`，由 `has-custom-skills` 自动追加并存路由）；
  2. **`行事总纲与决策准则`**（四条准则、信任倒金字塔与同类纠偏满 2 次沉入结构重构或静态检查、最优解与 UX/DX/AX 取舍、不当人肉代理）与**测试分层与控频**；
  3. 受管 **`Dev Profile`**（`quick-test` / `full-test` / `smoke-verify` / `merge-gate` / `arch-rules` / `high-risk` / `do-not-edit` 供引擎统一从 `profile.mjs` 读取，**显式 `none` 视为合法禁用态绝不回退覆盖**）；
  4. **上下文阅读护栏**、五档分流、身份与隔离收尾、`高风险路径`、`改哪看哪` 联动表及 `取舍` 人工手写节。
- **体积、保护与重入校准**：硬上限 **`30KB`（30720 字节）**、**`24KB`（24576 字节）起预警**，默认空模板约 `15KB`；遵循**严进常删**与子目录就近 `<subdir>/AGENTS.md`；缺 `agentsRegions` 基线时对既有非空区段默认采取 `protect` 不覆盖，已删区间记入 `removedAgentsRegions` 不强行插回；跨月重入时先核对 `reentry` 信号（`staleAgentPaths` / `staleAgentScripts` / `unregisteredTopDirs`），完整保留手写规范与 `.agents/skills/<custom>/`。

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
