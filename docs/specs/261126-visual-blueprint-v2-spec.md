---
kind: spec
title: Universal Layered Visual Architecture and 4-State Change Blueprint
status: approved
tier: L3
created: 2026-11-26
updated: 2026-11-26
issue: null
pr: null
branch: feat/visual-blueprint-v2
owner: planner-blueprint
plan_mode: autonomous
approved: true
implemented: false
plan_critique: "passed (reviewer=critic-bp-r3, round=3, sha=b85f85744e18, summary=Round 3 独立终审通过：核实 Round 2 全量防线均已精准落盘（addedNodes 合成独立新域、domain.id 哈希固定 palette、多源 BFS impactReasons、cli-parity.mjs:554 围栏字面箭头规避、compactClientModel 透传字段与既有交互锚点、<=800L/25-60KB/<14KB 预算），doc-plan audit 与 edit-gate --changed 均 0 错误 0 警告。)"
related_prd: null
related_todo: ../todo/261126-visual-blueprint-v2-todo.md
high_risk_paths: [kit/skills/lib/, kit/skills/dev-plan/]
---

# Universal Layered Visual Architecture and 4-State Change Blueprint — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `approved`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块重构、接口/契约变更或高风险改造；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / Issue / PR | `feat/visual-blueprint-v2` / 未关联 / 未关联 |
| 负责人 / 内审状态 | planner-blueprint / `passed` |
| 规划态 | `autonomous`（按仓内既有最佳模式推进，单向门与验收边界冻结后交独立 Critique 审查） |
| 关联 PRD / Todo | 无 / `../todo/261126-visual-blueprint-v2-todo.md` |

- **变更一句话**：升级视觉拓扑布局与单文件 HTML 渲染引擎，支持任意规模仓的拓扑分层排布、四态变更蓝图（新增/修改/拟移除/受波及含改前改后与级联原因）、单行精简顶栏与无文本墙可扫读详情面板。

## 系统变更全景

```mermaid
flowchart LR
  CLI["CLI与Sidecar"] --> Overlay["四态拓扑引擎"]
  Overlay --> Render["模块化HTML渲染"]
  Render --> Gate["自包含与对拍门禁"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/visual-layout.mjs` | 改造 | 四态 `DIFF_STATES`、领域拓扑分层排序、虚拟新增/移除节点与 BFS `impactReasons`、防截断几何 |
| `kit/skills/lib/visual-brief.mjs` | 改造 | Sidecar `featureChanges`/`addedFeatures`/`removedFeatures` 归一化、指纹与四态 `diffOverlay` 投影 |
| `kit/skills/dev-plan/scripts/doc-plan-brief.mjs` | 改造 | 解析三态 `--affected-feature`、新 `--add-feature` 与 `--remove-feature` 并透传至简报引擎 |
| `kit/skills/dev-plan/scripts/doc-plan.mjs` | 改造 | 注册与帮助声明 `--add-feature`/`--remove-feature`，对齐 `scripts/dev/cli-parity.mjs` |
| `kit/skills/dev-plan/SKILL.md` | 改造 | 同步 `brief` 命令参数声明，守住 `< 14 KB` 与 `<= 180` 行预算 |
| `kit/skills/lib/visual-render-panels.mjs` (new) | 新增 | 拆出蓝图盘面、目录分组、变更卡片、原型槽、详情壳等 HTML 片段构建（`<= 650` 行） |
| `kit/skills/lib/visual-render.mjs` | 改造 | 单行顶栏、模式感知默认页签、底部浮动缩放胶囊、零左竖条四态 SVG（`<= 650` 行） |
| `kit/skills/lib/visual-render-assets.mjs` | 改造 | 域聚焦过滤条、首流故事板默认态、可扫读详情排版样式、唯一上下文追问逻辑（`<= 650` 行） |
| `docs/TDD.md` | 改造 | 第 2 节 L3 模块清单登记 `kit/skills/lib/visual-render-panels.mjs` |
| `docs/architecture-map.html` | 改造 | 由 `verify-tools.mjs render` 重新投影同步 |
| `scripts/dev/fixtures-visual-engine.mjs` | 改造 | 补齐四态布局、25-60KB 预算、单行顶栏、默认首流与脚本解析正反断言 |
| `scripts/dev/fixtures-living-brief.mjs` | 改造 | 补齐 `--add-feature`/`--remove-feature`/改前改后语法与指纹失效正反断言 |

## 一、背景与边界声明

- **要改什么**：改造视觉布局引擎、四态简报 Sidecar/CLI 与模块化渲染器，并同步仓库契约与夹具：
  1. `kit/skills/lib/visual-layout.mjs` 领域与模块排序算法、四态 diff 计算、`284 x 114` 卡片几何；
  2. `kit/skills/lib/visual-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/SKILL.md` 的四态简报 Sidecar 与向后兼容 CLI 契约；
  3. 拆分 `kit/skills/lib/visual-render-panels.mjs` 并重构 `kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-assets.mjs` 的 Chrome、四态视觉、详情排版与流程故事板交互；
  4. 同步 `docs/TDD.md`、`docs/architecture-map.html`、`.agents/skills/`（`equip.mjs`）及双向夹具。
- **不改什么**：不改变 `docs/feature-map.json` v1/v2 存储 Schema；不改动 `buildGeneratedHeaderLine` 的 Line-1 `schema=v2 feature-map-sha256=<sha>` 格式及 `isUiVisualFile` 豁免契约；不改动 `kit/skills/lib/architecture-map.mjs` 外部导出签名。
- **本期不做**：不引入外部 CSS/JS 框架或图表库；不改变 `doc-plan.mjs` 其余子命令参数；不改动 `scripts/lib/` 安装期逻辑。
- **复用既有模块**：复用 `kit/skills/lib/feature-map-graph.mjs` 的 `buildFallbackDomains`；复用 `kit/skills/lib/visual-layout.mjs` 既有 `escapeHtml`、`escapeXml`、`escapeJsonForScript`、`sanitizeSafeHref`、`sanitizeSafeImgSrc`、`toRelPath`、`truncateLabel`；复用 `kit/skills/lib/git-core.mjs` 的 `sha256Text` 与 `kit/skills/lib/cli.mjs` 的 `parseStandardCli`。
- **架构基线关系**：严格遵循 `docs/TDD.md` 四层单向依赖与 `arch-rules`（`kit/**` 仅引用 `node:*` 与 `kit/skills/lib/`）；`visual-layout.mjs <= 750` 行，三个渲染文件各自 `<= 650` 行，`kit/skills/dev-plan/SKILL.md < 14 KB` 且 `<= 180` 行（依据：`docs/TDD.md`、`kit/skills/lib/tool-owned.mjs`）。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **图引擎（`kit/skills/lib/visual-layout.mjs`，`<= 750` L）**：
   - `DIFF_STATES = Object.freeze(['added', 'modified', 'removed', 'impacted', 'context'])`。
   - **通用拓扑分层排序与稳定调色板**：`resolveDomains` 按跨领域 `dependsOn` 聚合出领域有向边，执行 Kahn 拓扑分Rank（入度 0 根层为 0，逐层递增，环路按剩余最小入度打破），同层内按跨域度与特征数降序、`id.localeCompare` 保底，适配任意规模项目（1 域、v1 合成域或 N 域）。域内特征按域内 `dependsOn` 拓扑序排布；对 `addedNodes[]` 声明的新域直接按 `domain` 名合成为独立域分组（不得折叠回 `'core'`），并按稳定 `domain.id` 哈希确定性绑定 `palette`，确保拓扑重排或跨模式切换不改变域配色。
   - **四态叠加与虚拟节点**：`computeDiffOverlay(featureMap, diffOverlay)` 支持：
     - `diffOverlay.addedNodes`（`[{ id, domain, title, summary, description, dependsOn }]`）：合成为带 `isVirtual: true`、`diffState: 'added'` 的虚拟节点放入目标域（缺域自动合成新域），其连线标记 `isVirtual: true`、`edgeState: 'added'`（绿色虚线）。
     - `diffOverlay.removed` 与 `diffOverlay.featureChanges`（`Record<id, { state?, note?, before?, after?, reason?, replacementId?, targetDomain? }>`）：命中现存特征设为 `removed`（缺席则合成带 `isVirtual: true` 的移除节点），附 `changeDetail`。
     - **下游 BFS `impactReasons`**：以所有 `added`、`modified`、`removed` 节点为起点沿 `dependents` BFS 传播；下游 `context` 节点转为 `impacted`，同时为全部受影响下游聚合多源 `impactReasons[]`（如 `上游「X」计划修改`、`上游「X」拟移除`、`依赖新增「X」`）。`counts` 输出 `{ added, modified, removed, impacted, context }`。
   - **防截断卡片几何**：特征卡固定 `284 x 114`（间距 `24 x 22`）；顶部 eyebrow 徽章行（`y + 12..26`）放置状态胶囊与风险标记，为标题（`y + 48`，全宽 `truncateLabel(..., 34)`）与摘要（`y + 70`，全宽 `truncateLabel(..., 38)`）留出完整宽度；领域头部高度随标题/说明自适应（基础 `54px`，有描述或长标题增至 `66px`）。

2. **四态简报 Sidecar 与向后兼容 CLI（`visual-brief.mjs`，`<= 795` L / `doc-plan-brief.mjs` / `doc-plan.mjs`）**：
   - **行数与体量守则**：`kit/skills/lib/visual-brief.mjs` 基线已达 713 行，C2 改动后必须严格保持 `<= 795` 行（接近 780 行时将 4 态解析与合并逻辑抽离至辅助模块），严守 `preflight-suite.mjs` 800 行硬上限。
   - Sidecar 扩展字段（缺省平滑兼容旧 JSON）：
     - `featureChanges`: `{ [id]: { state, note?, before?, after?, reason?, replacementId? } }`
     - `addedFeatures`: `[{ id, domain, title, summary, dependsOn }]`
     - `removedFeatures`: `[{ id, reason, replacementId? }]`
     - `computeBriefFingerprint` 纳入上述三项，变更后自动触发 `confirmedState: 'stale'`。
   - `--affected-feature` 兼容三态语法：`featureId`、`featureId=说明`、`featureId=改前 -> 改后`（运行时同时兼容 `->`、`=>`、`::` 分隔符；纯 ID 写入 `affectedFeatures[]`，结构化变更写入 `featureChanges`）。
   - 新增多值参数：
     - `--add-feature "id|domain|title|summary[|dependsOnCsv]"`
     - `--remove-feature "id|reason[|replacementId]"`
     - 格式不足必填分段时抛出 `EXIT.USAGE` 错误（`INVALID_FEATURE_CHANGE`）；在 `doc-plan.mjs` `multiFlags` 与 `printHelp()` 同步声明，在 `doc-plan-brief.mjs` 中通过 `opts['add-feature']` 与 `opts['remove-feature']` 消费并纳入 `hasMutation`，保证 `scripts/dev/cli-parity.mjs` 零漂移；`kit/skills/dev-plan/SKILL.md` 的围栏代码块内禁止出现字面 `->`（规避 `cli-parity` 围栏箭头拆分检查，围栏内使用 `id=before::after` 并在正文说明 `->`/`=>`/`::`）。
   - `projectVisualBriefViewModel` 将 `featureChanges`、`addedFeatures`、`removedFeatures`、`affectedFeatures`、`topicAnchors` 组装为 `diffOverlay` 传入 `buildVisualModel`，并填充 `briefData.changeGroups` 供渲染层使用。

3. **模块化渲染与精简交互（`kit/skills/lib/visual-render-panels.mjs` (new)、`visual-render.mjs`、`visual-render-assets.mjs`，均 `<= 650` L）**：
   - **单行精简顶栏**：合并原三层工具栏为单一 `pf-topbar`：左侧为「标题 + 状态胶囊 + 主页签（`全景架构` / `变更蓝图` / `业务流转` / `方案原型`）」；右侧为「搜索框 + `分步导览` + `主题` + 唯一上下文 `复制追问` 按钮」（移除面板头与侧栏中其余 6 个重复 `复制追问` 按钮）。
   - **画布控制与聚焦条**：画布左下角悬浮缩放胶囊（`-` / `100%` / `+` / `适配`）；画布顶部单条聚焦栏（`全部域` + 各域胶囊 + `仅看本次变更` 开关）。
   - **零左竖条四态视觉**：禁止任何左边框竖条；`added` 绿虚线框 + 虚线连线，`modified` 琥珀边框与浅暖底色，`removed` 玫红虚线框 + 删除线标题 + `opacity: 0.68`，`impacted` 青蓝边框，`context` 净白底色并在聚焦时弱化降噪。
   - **无文本墙可扫读右侧 `模块详情`**：保留全部字段（职责、上下游、业务流、主入口、源码、测试、验证工具、文档锚点），移除嵌套深灰盒子，改用字号层级（`1.1rem` 粗标题、`0.88rem` 正文、`18-20px` 段落间距）：顶部高亮 `本次改动` 区块（改前→改后 / 新增 / 移除与替代 / 受波及原因）-> 双列可点击 `← 上游` / `下游 →` 胶囊带 -> 垂直连线 `参与业务流` 时间线 -> 折叠 `<details>` `源码与验证`。
   - **模式感知落地页与首流默认态**：`architecture-map` 默认落 `全景架构`；`visual-brief` 默认落结论先行的 `变更蓝图`（含四态计数卡片、按态分组可点击变更卡、双列规划盘面）；`业务流转` 当 `flows.length > 0` 时默认选中 `flows[0]` 展示故事板与高亮泳道，而非全边毛线团。
   - **客户端载荷与既有夹具契约**：`compactClientModel` 透传 `impactReasons`、`changeDetail` 与 `isVirtual` 供 `#pf-detail-view` 渲染，同时保留 `switchTab('tree'|'flow')`、`.walk-bar`、`execCommand`、`#clipboard-fallback`、`ArrowRight`、`localStorage`、`512 KB` 限制、`sandbox="allow-scripts"` 及全量 `<script>` 可被 `node:vm` `Script` 解析。
   - **60 KB 体积压缩预算**：基线 4 功能夹具 HTML 已达 `58,549 B`（CSS `15,075 B` + JS `25,689 B`）；C3/C4 必须采用紧凑 CSS/JS 排版（去除多余空白与注释）并在 `mode === 'architecture-map'` 时省略仅属 `visual-brief` 的 DOM 区块，确保富四态交互与改前改后视图稳居 `25–60 KB`（`25600–61440 B`）区间。

### 数据与状态变更

- 仅扩展仓外 `<gitCommonDir>/project-forge-flow/briefs/<key>.json` 的可选字段（`featureChanges`、`addedFeatures`、`removedFeatures`），与既有 schemaVersion=1 读路径完全向后兼容，无破坏性迁移。

### 异常、回退与安全边界

- 所有用户输入文本经 `escapeHtml`/`escapeXml`/`escapeJsonForScript` 转义；原型 `srcdoc <= 512 KB` 且 `sandbox="allow-scripts"`；链接协议严格白名单 `http:`/`https:`/`file:`；生成结果剥离 `homedir()` 绝对路径。
- `file://` 离线环境下剪贴板走 `navigator.clipboard` -> `execCommand('copy')` -> `#clipboard-fallback` 三级降级；`localStorage` 读写统一包在 `try/catch` 内。
- 格式非法的 `--add-feature`/`--remove-feature` 参数以 `EXIT.USAGE`（退出码 `2`）拒绝，不写入残缺 Sidecar。

### 交接与工单绑定约束

- **独立实施与真实 Issue 绑定**：`approve` 后必须由独立实施者（`implementerId !== planner-blueprint`）在同工作树执行 `flow.mjs start --task visual-blueprint-v2 --agent <implId>` 退出 `--planning` 并绑定真实 GitHub Issue（`flow.mjs start` 自动建单或 `doc-plan.mjs link --issue <N>`），否则 `finalize`/`submit` 将触发 `BLOCKED_MISSING_ISSUE_BINDING`。

### 实现顺序

1. 先更新 `kit/skills/lib/visual-layout.mjs` 确立 `DIFF_STATES`、领域拓扑排序、四态覆盖与 `284 x 114` 几何模型；
2. 更新 `kit/skills/lib/visual-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs` 与 `kit/skills/dev-plan/SKILL.md`；
3. 拆分 `kit/skills/lib/visual-render-panels.mjs` (new)，重构 `kit/skills/lib/visual-render.mjs` 与 `kit/skills/lib/visual-render-assets.mjs`；
4. 同步 `docs/TDD.md`、`docs/architecture-map.html`、执行 `node scripts/equip.mjs .`；
5. 补全 `scripts/dev/fixtures-visual-engine.mjs` 与 `scripts/dev/fixtures-living-brief.mjs` 正反用例并完成 1440x900 浅/深色无头 Chrome 全五视图实证。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 模块化拆分 `visual-render-panels.mjs` + 单行顶栏 | 将面板构建拆出并合并三层 Chrome，保留全量详情字段做排版重构 | 已选：兼顾 `<= 650` 行预算、可维护性与 25-60KB 体积控制 | 无；单文件渲染职责清晰 |
| 将全部视图与面板继续堆在 `visual-render.mjs` | 直接在 407 行原文件追加蓝图与详情模板 | 超出 650 行上限且与样式脚本耦合，难于审计 | 若渲染代码缩减至 300 行内可合并 |
| 右侧详情直接隐藏源码/测试/锚点以消除文本墙 | 仅保留标题与简述，删掉路径与验证工具明细 | 违反「全量信息可访问」要求，工程排查断链 | 仅当外部需求明确要求摘要态时 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/visual-layout.mjs` | 修改 | 拓扑域排序、5 态 `DIFF_STATES`、虚拟节点与 `impactReasons`、`284 x 114` 卡片 | `visual-brief.mjs`、`architecture-map.mjs` |
| `kit/skills/lib/visual-brief.mjs` | 修改 | Sidecar 扩展、指纹计算、四态 `diffOverlay` 投影 | `doc-plan-brief.mjs`、仓外简报生成 |
| `kit/skills/dev-plan/scripts/doc-plan-brief.mjs` | 修改 | 解析三态 `--affected-feature`、`--add-feature`、`--remove-feature` | `doc-plan.mjs brief` |
| `kit/skills/dev-plan/scripts/doc-plan.mjs` | 修改 | `multiFlags` 与 `printHelp()` 声明同步 | `cli-parity.mjs`、`doc-plan` CLI |
| `kit/skills/dev-plan/SKILL.md` | 修改 | 更新 `brief` 命令示例（`< 14 KB`, `<= 180` L） | `preflight-suite.mjs`、`equip.mjs` |
| `kit/skills/lib/visual-render-panels.mjs` (new) | 新增 | 蓝图盘面、目录、变更卡、原型槽、详情壳 HTML 生成 | `visual-render.mjs` |
| `kit/skills/lib/visual-render.mjs` | 修改 | 单行顶栏、悬浮缩放胶囊、域聚焦条、零竖条 SVG | `architecture-map.mjs`、`visual-brief.mjs` |
| `kit/skills/lib/visual-render-assets.mjs` | 修改 | 排版对比 CSS、四态样式、首流默认、唯一追问与聚焦脚本 | 浏览器交互、25-60KB 体积预算 |
| `docs/TDD.md` | 修改 | 补充 `visual-render-panels.mjs` 模块条目 | `preflight.mjs`、`review.mjs` |
| `docs/architecture-map.html` | 修改 | 重渲同步最新 UI 与拓扑 | `verify-tools.mjs`、`edit-gate.mjs` |
| `scripts/dev/fixtures-visual-engine.mjs` | 修改 | 增补 C1/C3/C4/C5 正反双向断言与 `<script>` 解析门禁 | `fixtures.mjs`、`merge-gate.mjs` |
| `scripts/dev/fixtures-living-brief.mjs` | 修改 | 增补 C2 CLI 语法正反用例、Sidecar 指纹与 `stale` 断言 | `fixtures.mjs` |

- **对外可见的变化**：`doc-plan.mjs brief` 新增 `--add-feature`、`--remove-feature` 且 `--affected-feature` 支持 `=` 与 `->` 改前改后表达；产出 HTML 采用单行顶栏、默认变更蓝图/首流故事板与重构详情面板。
- **需要同步改的地方**：运行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 镜像与 `.pf-manifest.json`，并运行 `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render .` 更新 `docs/architecture-map.html`。

## 五、冻结的验收标准

- [ ] C1: `kit/skills/lib/visual-layout.mjs`（`<= 750` 行）导出 5 态 `DIFF_STATES = ['added', 'modified', 'removed', 'impacted', 'context']`，实现跨任意项目规模的 Kahn 拓扑分层域排序、`addedNodes[]` 虚拟节点与绿色虚线边合成、`removed[]`/`featureChanges` 映射、下游 BFS `impactReasons` 及 `284 x 114` 顶部 eyebrow 防截断几何；由 `node scripts/dev/fixtures.mjs --domain visual-engine` 验证通过。
- [ ] C2: `kit/skills/lib/visual-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs` 与 `kit/skills/dev-plan/SKILL.md`（`< 14 KB` 且 `<= 180` 行）支持 Sidecar `featureChanges`/`addedFeatures`/`removedFeatures`、向后兼容三态 `--affected-feature` 与新 `--add-feature`/`--remove-feature`（错误格式退出码 `2`），并通过 `node scripts/dev/cli-parity.mjs`、`node scripts/dev/subcommand-parity.mjs` 与 `node scripts/dev/fixtures.mjs --domain living-brief`。
- [ ] C3: 新增 `kit/skills/lib/visual-render-panels.mjs` (new) 并更新 `kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-assets.mjs`（三文件均 `<= 650` 行），实现单行顶栏（仅 1 个上下文 `复制追问` 按钮）、左下角浮动缩放胶囊、单条域聚焦/仅看变更栏、零左竖条四态样式、无嵌套灰盒排版可扫读详情区（`1.1rem` 标题、`0.88rem` 正文、顶部 `本次改动`、双列上下游胶囊、垂直流转时间线与折叠源码详情）、模式感知默认页签及 `flows.length > 0` 时默认选中 `flows[0]` 故事板；由 `node scripts/dev/fixtures.mjs --domain visual-engine` 断言通过。
- [ ] C4: 4 功能夹具渲染 HTML 体积严格位于 `25600–61440` 字节（`25-60 KB`），保持零三方依赖、零 emoji、零 `homedir()` 泄漏、XSS 与 `javascript:`/`data:` 阻断、`file://` 三级剪贴板降级与 `localStorage` `try/catch`；同步更新 `docs/architecture-map.html`、`docs/TDD.md`、`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check` 与 `node scripts/dev/preflight.mjs` 全绿。
- [ ] C5: `scripts/dev/fixtures-visual-engine.mjs` 与 `scripts/dev/fixtures-living-brief.mjs` 具备正反双向用例与 `node:vm` `Script` 语法门禁，且完成真实 `1440x900` 浅色与深色无头 Chrome 全 5 视图（`全景架构`/`变更蓝图`/`业务流转`/`方案原型`/`模块详情`）交互与零报错实证并在 `flow.mjs verify` 提交 `--artifact` 附件。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（修改 `kit/skills/lib/`、`kit/skills/dev-plan/SKILL.md` 及公共 CLI 契约）；回滚做法：在分支上执行 `git revert <commit>` 恢复上一版本并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`。
- **高风险路径**：`kit/skills/lib/`、`kit/skills/dev-plan/SKILL.md`（受 `AGENTS.md` 高风险目录与 `KIT_SKILL_WARN_BYTES` 14KB 预算保护）；`docs/architecture-map.html` 受 `isUiVisualFile` Line-1 SHA256 校验保护。
- **故障注入预演**：复用 `scripts/dev/verify-injections.mjs` 与 `scripts/dev/injections-data-visual-engine.mjs` 验证 `I961–I964`（XSS/协议拦截、架构图漂移阻断、Line-1 篡改拦截）在改造后保持 100% 检出率。

## 澄清与补充记录

- 已定（`autonomous`）：按任务指令明确要求，采用模块化拆分 `kit/skills/lib/visual-render-panels.mjs` (new)、5 态 `DIFF_STATES`、单行顶栏与唯一上下文追问按钮、无左竖条四态样式及 `flows[0]` 默认故事板；所有参数格式与预算边界均已对齐仓内既有门禁。

## 实现说明

- **实际落地摘要**：
- **与草案的差异**：
- **关联同步文件**：
