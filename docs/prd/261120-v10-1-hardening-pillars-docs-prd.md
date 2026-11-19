---
kind: prd
title: v10.1 引擎加固、四大工程支柱与全景文档总控 PRD
status: draft
created: 2026-11-20
updated: 2026-11-20
issue: null
pr: null
owner: plan-v101
plan_critique: pending
related_spec: null
related_todo: null
multi_spec: true
plan_mode: interactive
---

# v10.1 引擎加固、四大工程支柱与全景文档总控 PRD

> 关联总控规划单：`#105`　｜　下辖实施切片 Issue：`#99`、`#101`、`#102`、`#103`、`#104`
>
> 并行前置备注：`#100`（`w1b-flow-explore-gate`）作为既定并行缺陷单独立推进，不纳入本总控 5 切片改域；Wave 2 切片须以 `#99` 与 `#100` 均合入 `main` 后的基线启动。

## 一、背景、问题与设计底线

<!-- section: goal -->
### 1.1 本轮为什么立项

Stage C（v10）落地三层常青文档与统一状态机后，通过真实空目录、`LoopForge-main` 多包大仓与本仓 `node scripts/dev/bench.mjs` 盲测，暴露出三类必须成体系收口的短板：

1. **真实仓库边界与性能回退（`#99`）**：对存在 vendored 嵌入子包、合法已跟踪构建目录、自定义技能、存量架构文档（如 architecture 或 design 同类路径）以及手工 `取舍` 块的仓库，现行 `survey`/`compose-agents`/`review`/`equip-bootstrap`/`handoff` 仍有 8 项边界误判或漏检；同时本仓 `survey(self)` 实测中位数退化至 `289.2 ms`（超出 `bench.mjs` 声明的 `250 ms` 预算）。
2. **跨模块规划门禁与工程验证支柱缺环（`#101`、`#102`）**：规划流尚缺纯粹基于仓内文档契约的双态退场硬校验（`interactive` / `autonomous`）、总控 PRD 到切片图的覆盖与波次碰撞校验以及就绪并行波次交接包；审查与迭代流尚缺工具无关的结构化实证附件校验（禁止 UI 改码裸传 `--visual-checked` 敷衍放行）、先复现消误报与 Tier 1/2 整类加固原则，以及 `iterate.mjs cycle` 有界优化闭环。
3. **全景文档与人类首页断层（Wave 2.5 + `#103` + `#104`）**：四大支柱与引擎修复全部合入并经本仓自举互转演练验证后，需要彻底消除 `docs/TDD.md` 局部拼凑感与双语 `README.md` / `README.en.md` 过时文字墙，让人类用户无需读代码即可掌握外部治理 `S1–S4`、全 8 个技能日常流转及升级融合机制，并配齐按真实内容自然定高的新版 SVG 图群。

### 1.2 核心架构底线（不可突破）

1. **零宿主私有工具适配胶水**：`dev-plan`、`dev-flow` 及产品层 `scripts/`、`kit/`、`templates/` 不得感知、探测、绑定或调用任何 AI 宿主特定的 `/plan`、`/grill-me`、私有环境变量或内部路径。双态规划门禁全部通过仓内标准 CLI 参数、Frontmatter 字段与 `docs/` 落盘状态机落地。
2. **严格保持 8 个内置技能不新增**：坚持 `dev-explore`、`dev-plan`、`dev-edit`、`dev-flow`、`dev-verify-tools`、`dev-review`、`dev-iterate`、`dev-govern` 八技能边界，不创建第 9 个技能；有界优化循环与工具沉淀能力合入 `dev-iterate` / `dev-review` / `dev-govern`。
3. **写可迁移工程原则，不写死具体外部工具**：`PoC-first` 复现消误报、Tier 1/2 整类加固、结构化实证附件与有界优化循环一律提炼通用工程契约与接口字段，严禁在产品层或门禁逻辑中硬编码特定浏览器自动化工具、云端平台或商业扫描器名称。
4. **只锁客观输出边界**：所有验收与门禁仅锁外部可观测客观证据（非空实证文件、JSON Schema 与字段契约、命令退出码、正反双向断言、真实浅/深色渲染截图），不对内部实现细节或私有助手做过程死锁。
5. **零第三方依赖与全仓禁 emoji**：`scripts/` 与 `kit/` 严格限于 Node 18+ `node:*` 内置模块；全仓代码、文档、SVG 与提交记录严禁出现 emoji。

### 1.3 非目标（Explicit Non-Goals）

<!-- section: non-goals -->
- 本轮不改并行单 `#100`（`kit/skills/dev-flow/scripts/*` 中围绕 `explore` 提交门控的修复）。
- 本轮不引入任何外部 npm 运行时或构建期依赖，不引入 Chrome/Playwright 绑定代码进 `kit/` 或 `scripts/`。
- 本轮不把规划阶段文档在 PR `#105` 中提前归档进 `docs/archive/`（本 PRD 与 5 份切片文档合入 `main` 后作为活跃工程单长期驱动后续 Wave 1–3B 实施）。
- Wave 3B（`#104`）合入并全绿后**不自动跑外部真实仓库测试集，也不自动打标签发版**——必须停在硬停机点等待维护者明确下令。
<!-- section: non-goals-end -->
<!-- section: goal-end -->

## 二、用户、场景与波次编排全景

<!-- section: design -->
### 2.1 执行波次拓扑（Wave 1 -> Wave 2 -> Wave 2.5 -> Wave 3A -> Wave 3B -> 硬停机）

```mermaid
flowchart LR
  S1["切片1: 引擎加固"] --> S2["切片2: 双态门禁"]
  S1 --> S3["切片3: 实证循环"]
  S2 --> W25["W2.5 自举演练"]
  S3 --> W25
  W25 --> S4["切片4: 全景 TDD"]
  S4 --> S5["切片5: 文档 SVG"]
  S5 --> STOP["测试前停机门"]
```

### 2.2 五个切片与总控波次映射表

| 波次 | 切片 ID | Issue | 任务标识 `task_id` | 核心范围摘要 | 依赖前置 | 规划态 `plan_mode` |
| --- | --- | --- | --- | --- | --- | --- |
| Wave 1 | Slice 1 | `#99` | `w1a-engine-fixes` | 引擎 8 项边界缺陷根治 + `survey(self)` 中位数压回 `<= 250 ms` | 无（`depends_on: []`） | `autonomous` |
| Wave 2 并行 A | Slice 2 | `#101` | `w2a-plan-wave-gate` | 宿主无关双态规划门禁 + `flow start` 退场硬校 + 切片图校验 + `batch plan --handoff` | Slice 1（`#99`） | `autonomous` |
| Wave 2 并行 B | Slice 3 | `#102` | `w2b-empirical-poc-cycle` | 工具无关 `--artifact` 实证 + UI 禁裸传 `--visual-checked` + PoC/Tier 原则 + `iterate.mjs cycle` | Slice 1（`#99`） | `autonomous` |
| Wave 2.5 + 3A | Slice 4 | `#103` | `w3a-panoramic-tdd` | 本仓真实自举互转演练（`dev-govern`+`dev-verify-tools`+`dev-iterate`）并修清发现项 + 全景重写 `docs/TDD.md` | Slice 2（`#101`）、Slice 3（`#102`） | `interactive` |
| Wave 3B | Slice 5 | `#104` | `w3b-readme-svg-redesign` | `oil-tone` 双语 `README.md`/`README.en.md` 重写 + 全套重绘/新增自然变高 SVG + 浅深色截图实证 | Slice 4（`#103`） | `interactive` |

### 2.3 Wave 2 严格文件互斥并发契约（Slice 2 与 Slice 3 零碰撞）

Wave 2 的 Slice 2（`#101`）与 Slice 3（`#102`）共享唯一前置 Slice 1（`#99`），设计为可同时派发两个隔离 worktree 并行实施：

- **Slice 2 独占写域**：`kit/skills/dev-plan/**`、`kit/skills/dev-flow/**`、`kit/skills/lib/pending-decisions.mjs`、`kit/skills/lib/handoff-package.mjs`、`kit/skills/lib/doc-slice-graph.mjs` (new)、`kit/skills/lib/plan-exit-gate.mjs` (new)、`.agents/skills/dev-plan/**`、`.agents/skills/dev-flow/**`、`scripts/dev/fixtures-plan-wave.mjs` (new)、`scripts/dev/injections-data-plan-wave.mjs` (new)。
- **Slice 3 独占写域**：`kit/skills/dev-review/**`、`kit/skills/dev-iterate/**`、`kit/skills/dev-govern/**`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-helpers.mjs`、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/empirical-artifacts.mjs` (new)、`.agents/skills/dev-review/**`、`.agents/skills/dev-iterate/**`、`.agents/skills/dev-govern/**`、`.agents/skills/lib/empirical-artifacts.mjs` (new)、`templates/agents-project.md`、`AGENTS.md`、`scripts/dev/fixtures-empirical-cycle.mjs` (new)、`scripts/dev/injections-data-empirical-cycle.mjs` (new)。
- **派生清单协同规则（`.agents/skills/.pf-manifest.json`）**：`.agents/skills/.pf-manifest.json` 为 `equip.mjs .` / `compose-agents.mjs .` 自动生成的确定性构建派生清单（不手工编辑）；Wave 2 两个切片均须运行 `equip.mjs .` 刷新该清单。`doc-slice-graph` 对派生清单文件不判作阻断碰撞；合入采用「先合入者直推、后合入者 rebase `main` 后重跑 `equip.mjs .`（`#102` 并跑 `compose-agents.mjs .`）重建清单并重验通过后合入」策略。
- **跨界接口契约（`flow.mjs verify` -> `workflow-policy.mjs`）**：
  1. `#101` 在 `kit/skills/dev-flow/scripts/flow.mjs` 用 `multiFlags` 注册 `artifact`、用 `valueFlags` 注册 `visual-blocked-reason`；
  2. `#101` 移除 `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` 中为裸 `--visual-checked` 硬编码合成伪造观察串的逻辑，改为将 `{ artifacts, visualBlockedReason, visualCheckedRaw }` 经 `kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs` `recordVerifyEvidenceForFlow` 透传至 `kit/skills/lib/workflow-policy.mjs` 约定校验入口（`validateVerifyPrecheck` / `writeVerificationEvidence` 前置预检，前置未实现时 Fail-Soft、实现后按返回的 `{ ok, code, exitCode }` 阻断退出）；
  3. `#102` 在 `kit/skills/lib/empirical-artifacts.mjs` (new) 与 `workflow-policy.mjs` / `workflow-helpers.mjs` / `dev-review/` 完成校验消费与渲染（且把新逻辑拆入 `empirical-artifacts.mjs` (new)，保 `workflow-helpers.mjs` 797L 与 `workflow-policy.mjs` 783L 严格 `<= 800` 行）。二者业务逻辑路径保持 0 交集。

### 2.4 Wave 2.5 真实自举互转演练与测试前硬停机设计

1. **Wave 2.5 前置执行门（并入 Slice 4 启动阶段）**：Slice 2 与 Slice 3 均合入 `main` 后，先在本仓真实工作区跑通一轮「`dev-govern` 体检与规则审计 -> `dev-verify-tools` 工具发现/防陈旧校验 -> `dev-iterate cycle` 有界迭代与缺陷上报 -> `dev-plan`/`dev-edit`/`dev-review` 闭环修复」，同步刷新 `docs/feature-map.json` 与 `AGENTS.md`，全部异常清零后再启动 `docs/TDD.md` 全景重写，防止过时架构写进新文档。
2. **进入最终外部测试集前的硬停机点（Hard Stop Gate）**：Wave 3B（`#104`）合入 `main` 且 `merge-gate` 全绿后，系统与调度流进入显式**停机等批状态**：汇总全部 5 切片已合并 PR、性能基准、自举演练实测与浅/深色 SVG 渲染证据，交由用户确认是否启动真实外部仓库批量回归测试集。未获人工明确授权，不得自动批量改写外部测试仓或推进发版。

### 2.5 各切片关键技术方案摘要

- **Slice 1（`#99` 引擎加固与性能压降）**：
  - `scripts/lib/agents-sections.mjs` 将 `取舍` 纳入与 `isCalibratedDevProfile` 同级的语义免模板字面漂移集合；`scripts/compose-agents.mjs` 与 `scripts/lib/agents-defaults.mjs` 在存在新增自定义技能时单遍联动收敛 `意图路由` 与 `探索策略`。
  - `scripts/lib/survey-ecosystem.mjs` 与 `scripts/compose-agents.mjs` 过滤 `vendor/**`、`third_party/**` 及 `**/vscode-web/extensions/**` 等嵌入第三方子包，并在子包超限（> 16 个）时按目录簇聚合摘要保证 `AGENTS.md <= 30720 B` 且建议 `< 24576 B`。
  - `scripts/lib/survey-workspace.mjs` 仅在输出目录（`dist` / `build` / `out` / `coverage` / `bin`）实际包含未跟踪文件时才报 `unignoredOutputDirs`；`scripts/review.mjs` 对齐读取 `facts.docs.existingDesignDocs` 与 `tdd-authority`；`scripts/lib/equip-bootstrap.mjs` 移除生成的 `README.md` 中悬空 `scripts/compose-agents.mjs` 指针；`scripts/handoff.mjs` 按 `dirname(rel)` 校验相对 `references/*.md` 并将 `SKILL_INTERNAL_RE` 收紧到本工具真实内部参考，同时对嵌入/第三方大文件标注 skipped 而非 leak/truncated。
  - **性能剖析依据与定向改造**：实测 `node scripts/dev/bench.mjs` `survey(self) = 289.2 ms`（超 `250 ms` 红线），主因在于 `survey-workspace.mjs` 触发串行 `git rev-list --count HEAD`（~52 ms）、对 486 个文件无差别执行过宽 `SECRET_FAST_PRECHECK_RE`（命中 95 次）与 `mightHaveHome`（命中 63 次），以及 `survey-scan.mjs` 对 `.agents/skills/` 重复扫描。改造通过快速提交数估算与并发采集、收紧预检正则并排除 `.agents/skills/` 与构建测试样本路径误触发、复用单遍 `.agents/` 文件清单，在不放宽 `SURVEY_SELF_BUDGET_MS = 250` 前提下将 `survey(self)` 中位数压回 `<= 250 ms`。
- **Slice 2（`#101` 双态规划门禁与波次调度）**：
  - 在 `kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/SKILL.md` 及 `kit/skills/lib/pending-decisions.mjs`、`kit/skills/lib/plan-exit-gate.mjs` (new) 中确立 `plan_mode: interactive | autonomous` 双态 Frontmatter 与 CLI 参数。
  - 在 `kit/skills/dev-flow/scripts/flow-inspect.mjs` / `flow-lifecycle.mjs` 为 `flow.mjs start --case 3|4` 前置调用统一规划退场校验器，未清零 `pendingDecisions` 或文档未过审时以退出码 `3` 阻断并报错 `BLOCKED_PLAN_NOT_READY`。
  - 在 `kit/skills/lib/doc-slice-graph.mjs` (new) 落地总控 PRD 到子切片覆盖检查（100% 覆盖 `C1..Cn`）、`scope_files` 与 `depends_on` 声明必填检查、有向图判环（`BLOCKED_SLICE_CYCLE`）及同波次并行切片 `scope_files` 碰撞检查；接入 `doc-plan.mjs audit`。
  - 升级 `flow.mjs batch plan --handoff [--json]`（`kit/skills/dev-flow/scripts/flow-batch.mjs` + `kit/skills/lib/handoff-package.mjs`）：按拓扑分波次并调用标准 `buildHandoff` 为当前就绪并行波次中的每个切片生成独立子代理交接包。
- **Slice 3（`#102` 实证附件、PoC 原则与有界循环）**：
  - 将工具无关结构化实证校验与 PR 附件格式化拆入独立模块 `kit/skills/lib/empirical-artifacts.mjs` (new)，`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-helpers.mjs`（通过 `buildVerificationEvidenceSection` 与 `hydratePrTemplateBody` 供 `flow-lifecycle.mjs` 复用）及 `kit/skills/dev-review/` 薄委托调用，确保全仓所有 `.mjs` 严格 `<= 800` 行；支持 `--artifact {path}`（校验真实非空常规文件并登记哈希/大小至 `.pf-state` `evidence.json` 与审查回执，不脏工作区）并在 PR 验证表输出实证摘要与附件清单。
  - 触及 `UI_VISUAL_EXT_RE` 文件时，强制禁止裸传 `--visual-checked` 放行：必须同时附带非空 `--artifact` 或实质视觉观察记录，无渲染环境时必须显式提供 `--visual-blocked-reason "{reason}"` 诚实报阻。
  - `kit/skills/lib/escalation.mjs` 与 `kit/skills/dev-iterate/SKILL.md`、`kit/skills/dev-govern/SKILL.md` 固化「最小运行复现消误报 -> 复跑证伪与回归 -> 评估 Tier 1/2 整类根治」原则，支持可选 `reproEvidence` 与 `pocCommand` 字段（不硬编码工具）。
  - `kit/skills/dev-iterate/scripts/iterate.mjs` 新增只读编排子命令 `cycle --goal "{goal}" [--max-rounds 3] [--json]`，输出标准四段状态机计划（`Observe -> PoC/Escalate (autonomous) -> Fix/Verify -> Reflect`）及硬停损门控（轮次上限、连续两轮零进展停损、遇到单向门停损），同步写明「只锁客观输出边界」工程底线到 `templates/agents-project.md` 并重新生成 `AGENTS.md`（`< 24576 B`）。
- **Slice 4（`#103` Wave 2.5 自举与全景 `docs/TDD.md`）**：
  - 完成 Wave 2.5 自举闭环与缺陷修清后，按照 `tdd-structure.mjs` 强制节结构重写 `docs/TDD.md`：覆盖 `S1–S4`、全 8 个技能日常闭环、双态规划门禁、波次图与 `handoff`、实证附件与 `cycle` 循环、三层常青文档与跨代迁移；配多张 `16/12` 无 HTML Mermaid 图与平实无 AI 味中文。
- **Slice 5（`#104` 双语 README 与可变高度 SVG）**：
  - 基于定型后的 `docs/TDD.md`，依据 `oil-tone` 与 `beautify-github-readme` 重写 `README.md` 与 `README.en.md` 保持双向 TOC 同步；重设计 `assets/readme/` 全部 6 张已有 SVG 并补充关键章节新图示（如 8 技能闭环与三层文档体系图，严守每图按内容自然定高、禁止强行统一高度、`font-size >= 16`、零外链/脚本、无禁止术语），并通过真实浏览器浅/深色双主题截图验收。

### 2.6 可复用已有模块与不变量边界

<!-- section: reuse -->
- `scripts/lib/protocol.mjs`（标记与预算唯一真相源，禁写死于他处）
- `scripts/lib/agents-sections.mjs`、`scripts/lib/survey-scan.mjs`、`scripts/lib/survey-workspace.mjs`（增量扩展，不拆双轨扫描）
- `kit/skills/lib/pending-decisions.mjs`、`kit/skills/lib/handoff-package.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-helpers.mjs`、`kit/skills/lib/escalation.mjs`
- `kit/skills/lib/tdd-structure.mjs`、`scripts/dev/preflight-suite.mjs`、`scripts/sync-toc.mjs`、`scripts/dev/bench.mjs`
<!-- section: reuse-end -->

### 2.7 备选方案与取舍理由

<!-- section: alternatives -->
- **双态规划门禁方案**：曾评估增加宿主插件适配器探测 `/plan` 状态（否定，违背零宿主绑定红线且易跨宿主漂移），最终选用仓内 `plan_mode` Frontmatter + `flow start` 静态退出校验（可逆且跨宿主稳定）。
- **Wave 2 `flow verify` `--artifact` 透传**：曾评估串行执行 Wave 2（否定，人工拉长工期）或在 Slice 3 修改 `dev-flow/`（否定，造成合并冲突），最终由 Slice 2 在 `dev-flow/` 预注册通用透传标志、Slice 3 独占消费与策略校验，实现 Wave 2 无碰撞并行。
<!-- section: alternatives-end -->
<!-- section: design-end -->

## 三、全链路门型评估与总控验收清单

<!-- section: gates -->
- **门型评估**：
  - Slice 1（`#99`）：`two-way`（高风险引擎与基准路径，通过双向 fixture 与 `I225–I239` 故障注入保护，禁改阈值）。
  - Slice 2（`#101`）：`one-way` 级别门禁契约升级（新增 `BLOCKED_PLAN_NOT_READY` 与 `BLOCKED_SLICE_CYCLE` 阻断语义，须 `critic` 内审 + `I250–I259` 故障注入 + 独立审查）。
  - Slice 3（`#102`）：`one-way` 级别实证门禁升级（禁用 UI 裸 `--visual-checked`，更改 `templates/agents-project.md` 影响全部宿主项目契约，须独立审查 + `I260–I269` 故障注入）。
  - Slice 4（`#103`）：Wave 2.5 运行态演练 + 文档重写（`two-way`，演练发现的代码补丁须按对应门型建单或随闭环审查合入）。
  - Slice 5（`#104`）：`two-way`（须通过真实浏览器浅/深色背景渲染截图实证后方可触发测试前硬停机点）。
<!-- section: gates-end -->

<!-- section: acceptance -->
### 总控端到端验收标准（20 条 `C1..C20` 严格切分至 5 个切片）

<!-- criteria:start -->
- [ ] **C1**（Slice 1 `#99`）：`compose-agents.mjs` / `agents-sections.mjs` 将手写 `取舍` 区纳入免字面漂移检查，且新增自定义技能后单次运行 `compose-agents.mjs` 同步收敛 `意图路由` 与 `探索策略`。
- [ ] **C2**（Slice 1 `#99`）：`survey-ecosystem.mjs` / `compose-agents.mjs` 跳过 `vendor/**`、`third_party/**` 等嵌入子包并对超多子包聚合摘要保障 `AGENTS.md <= 30KB`，且 `survey-workspace.mjs` 仅在输出目录存在未跟踪文件时才报 `unignoredOutputDirs`。
- [ ] **C3**（Slice 1 `#99`）：`review.mjs` 识别 `facts.docs.existingDesignDocs` 与 `tdd-authority`；`equip-bootstrap.mjs` 消除生成 `README.md` 悬空脚本指针；`handoff.mjs` 按 `dirname(rel)` 校验内部相对参考文档并区分嵌入大文件。
- [ ] **C4**（Slice 1 `#99`）：在不放宽 `bench.mjs` 预算（`250 ms`）的前提下优化 `survey.mjs` / `survey-scan.mjs` / `survey-workspace.mjs`，使 `survey(self)` 本地实测中位数回到 `<= 250 ms`，并补齐 `fixtures-engine-hardening.mjs` (new) 与 `I225–I239` 注入用例。
- [ ] **C5**（Slice 2 `#101`）：`doc-plan.mjs triage` 与规划文档 Frontmatter 支持 `plan_mode: interactive | autonomous`（零宿主胶水），并在 `kit/skills/dev-plan/SKILL.md` 明确交互逐题清零与自治停机边界。
- [ ] **C6**（Slice 2 `#101`）：抽离规划退场校验模块 `kit/skills/lib/plan-exit-gate.mjs` (new)，并在 `flow.mjs start --case 3|4` 前置强校 `pendingDecisions === 0` 且文档过审，未就绪以退出码 `3` 阻断并输出 `BLOCKED_PLAN_NOT_READY`。
- [ ] **C7**（Slice 2 `#101`）：新增 `kit/skills/lib/doc-slice-graph.mjs` (new) 并接入 `doc-plan.mjs audit`，校验总控 PRD 到切片 100% 覆盖、`scope_files` 与 `depends_on` 显式声明、依赖无环（`BLOCKED_SLICE_CYCLE`）及同波次无文件碰撞。
- [ ] **C8**（Slice 2 `#101`）：升级 `flow.mjs batch plan --handoff [--json]` 按依赖拓扑输出波次并为就绪并行切片生成独立子代理交接包，同时在 `flow.mjs verify` 预透传 `--artifact`/`--visual-blocked-reason`，刷新 `equip.mjs .` 并补齐 `fixtures-plan-wave.mjs` (new) 与 `I250–I259`。
- [ ] **C9**（Slice 3 `#102`）：`flow.mjs verify` 与 `review-pack.mjs check-empirical` 支持工具无关 `--artifact {path}`（校验真实非空文件并登记实证摘要至 `evidence.json`/审查回执，不脏工作区），并在 PR 验证表输出结构化实证与附件清单。
- [ ] **C10**（Slice 3 `#102`）：触及 `UI_VISUAL_EXT_RE` 文件时禁止裸传 `--visual-checked` 放行，必须提供非空 `--artifact` 或实质视觉观察，无渲染环境时必须显式传 `--visual-blocked-reason` 诚实报阻。
- [ ] **C11**（Slice 3 `#102`）：在 `kit/skills/lib/escalation.mjs`、`kit/skills/dev-iterate/SKILL.md`、`kit/skills/dev-govern/SKILL.md` 固化「最小运行复现消误报 -> 复跑证伪与回归 -> 评估 Tier 1/2 整类加固」原则及可选 `reproEvidence`/`pocCommand` 字段（零硬编码工具）。
- [ ] **C12**（Slice 3 `#102`）：`kit/skills/dev-iterate/scripts/iterate.mjs` 新增只读编排子命令 `cycle --goal "{goal}" [--max-rounds 3] [--json]`（串联四阶段与硬停损），拆出 `kit/skills/lib/empirical-artifacts.mjs` (new) 保全 `.mjs <= 800` 行，在 `templates/agents-project.md` 与 `AGENTS.md` 确立「只锁客观输出边界」底线，刷新 `equip`/`compose-agents`（`AGENTS.md < 24576 B`），补齐 `fixtures-empirical-cycle.mjs` (new) 与 `I260–I269`。
- [ ] **C13**（Slice 4 `#103`）：Wave 1 与 Wave 2 全部合入后，在本仓真实完成一轮 `dev-govern` + `dev-verify-tools` + `dev-iterate`（含 `cycle`）自举互转演练并修清实操发现缺陷，刷新 `docs/feature-map.json`。
- [ ] **C14**（Slice 4 `#103`）：全面重写 `docs/TDD.md`，完整覆盖外部治理 `S1–S4`、全 8 个技能日常流转、双态规划门禁、波次图与 `handoff`、结构化实证与有界优化循环、三层常青文档与跨代升级。
- [ ] **C15**（Slice 4 `#103`）：新版 `docs/TDD.md` 包含多张符合 Mermaid `16/12` 宽度上限且零 HTML 标签的清晰架构图与流程图，讲透流转跳转、拦截点与核心原则。
- [ ] **C16**（Slice 4 `#103`）：`docs/TDD.md` 全文采用无 AI 味平实中文，人类用户不读源码即可完全看懂系统运转方式，并通过 `preflight`/`doc-plan`/`govern-audit`/`sync-toc` 全部校验。
- [ ] **C17**（Slice 5 `#104`）：严格按 `oil-tone` 重写 `README.md` 与 `README.en.md`（消除文字墙与 AI 味），覆盖 `S1–S4`、全 8 个技能日常自然语言与斜杠触发用法、有界优化循环与跨代融合，通过 `sync-toc --check`。
- [ ] **C18**（Slice 5 `#104`）：按 `beautify-github-readme` 重设计全套现有 6 张 `assets/readme/*.svg` 并补充关键章节新 SVG（如 8 技能闭环与三层文档图），严格按每张图实际内容自然定高、画幅宽松不堆小字。
- [ ] **C19**（Slice 5 `#104`）：全部 SVG 通过 `preflight` 字体（`>= 16`）、卫生与双语产品层检查。
- [ ] **C20**（Slice 5 `#104`）：全部 SVG 与重排 README 在浏览器真实浅/深色背景下完成渲染截图核查；Wave 3B 合入全绿后强制停在外部测试集前硬停机点等待人工确认。
<!-- criteria:end -->
<!-- section: acceptance-end -->

## 四、已拍板架构决议与待拍板问题

<!-- section: pending -->
- 已定：所有架构约束、波次切分、Wave 2 文件互斥边界与验收标准均已拍板锁定（无遗留待决事项）。
- 已定：绝不增加宿主 `/plan`、`/grill-me` 适配胶水；双态门禁完全依托 `plan_mode`、`pendingDecisions` 与 `flow start` 仓内状态契约。
- 已定：保持 8 个内置技能不新增；有界优化循环 `cycle` 纳入 `dev-iterate`，`PoC-first` 原则纳入 `escalation.mjs` 与 `dev-iterate` / `dev-govern`。
- 已定：Wave 2 两个并行切片 `#101` 与 `#102` 在 `scope_files` 上 100% 文件互斥；`flow.mjs verify` 由 `#101` 预透传 `--artifact` 与 `--visual-blocked-reason` 标志，`workflow-policy.mjs` 与 `dev-review/` 由 `#102` 完成校验消费。
- 已定：故障注入编号区间预先切片隔离，消除合并号段碰撞：`#99` 使用 `I225–I239`、`#101` 使用 `I250–I259`、`#102` 使用 `I260–I269`（并行中的 `#100` 使用 `I240–I249`）。
- 已定：Planning PR（`#105`）只合入活跃规划文档，不执行提前归档，PR 正文仅关联 `Fixes #105` 而不得误关 `#99`、`#101`、`#102`、`#103`、`#104`。
<!-- section: pending-end -->
