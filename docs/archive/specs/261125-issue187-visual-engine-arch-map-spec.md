---
kind: spec
title: "Zero-Dependency Visual Projection Engine, Architecture Map and S1-S4 Auto-Sync"
status: implemented
tier: L3
created: 2026-11-25
updated: 2026-11-25
issue: 187
pr: null
branch: feat/visual-engine-arch-map
owner: planner-arch
plan_mode: interactive
approved: true
implemented: true
plan_critique: "passed (reviewer=critic-r3, round=3, sha=fec91f2550d5, summary=Round 3 PASS: Verified review-pack.mjs (L379,L501) and review-empirical.mjs (L55) in scope_files/C6/Todo, verify-tools.mjs:45 usage line update for render, 6-site UI_VISUAL_EXT_RE parity, review-gates/flow-lifecycle-helpers <=798L headroom, and DAG/subcommand-meta/exit-codes contracts.)"
related_prd: ../../prd/261125-visual-arch-brief-prd-prd.md
related_todo: ../todo/261125-issue187-visual-engine-arch-map-todo.md
high_risk_paths: [kit/, templates/, .gitattributes]
task_id: visual-engine-arch-map
depends_on: [feature-map-v2-topology]
scope_files: [kit/skills/lib/visual-layout.mjs, kit/skills/lib/visual-render.mjs, kit/skills/lib/architecture-map.mjs, kit/skills/lib/static-gates.mjs, kit/skills/lib/shared.mjs, kit/skills/lib/workflow-policy.mjs, kit/skills/lib/exit-codes.mjs, kit/skills/lib/subcommand-meta.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-review/scripts/review-locks.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/dev-explore/scripts/repo-map.mjs, kit/skills/dev-govern/scripts/govern-audit.mjs, kit/skills/dev-edit/scripts/edit-gate.mjs, docs/architecture-map.html, scripts/lib/artifact-executors.mjs, scripts/lib/survey-gap-rules.mjs, scripts/survey.mjs, scripts/equip.mjs, scripts/lib/equip-bootstrap.mjs, scripts/review.mjs, scripts/dev/gap-coverage.mjs, .gitattributes, references/survey.md, scripts/dev/injections-data-repo-alignment.mjs, scripts/dev/fixtures-equip.mjs, scripts/dev/fixtures-doc-closure.mjs, scripts/dev/fixtures-visual-engine.mjs, .agents/skills/]
---

# Zero-Dependency Visual Projection Engine, Architecture Map and S1-S4 Auto-Sync — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `implemented`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（零依赖视觉引擎、`isUiVisualFile` 策略统一与 S1-S4 接入；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / Issue / PR | `feat/visual-engine-arch-map` / #187 / 未关联 |
| 负责人 / 内审状态 | planner-arch / `passed` |
| 规划态 | `interactive`（边界与策略已由总控 PRD 冻结，待拍板为零） |
| 关联 PRD / Todo | `docs/prd/261125-visual-arch-brief-prd-prd.md` / `docs/archive/todo/261125-issue187-visual-engine-arch-map-todo.md` |

- **变更一句话**：新增零依赖视觉布局与单文件 HTML 渲染引擎，落地 `docs/architecture-map.html` (new) 读写分离自动同步、`isUiVisualFile`（`static-gates.mjs` + `shared.mjs` 重导出）全仓 6 处统一策略及 `S1-S4` 治理接入。

## 系统变更全景

```mermaid
flowchart LR
  MapV2["特征图谱 v2"] --> Layout["布局与SVG计算"]
  Layout --> Render["单文件HTML引擎"]
  Render --> ArchMap["架构全景图"]
  ArchMap --> UiGate["统一视觉门禁"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/visual-layout.mjs` (new) | 新增（`<= 800` 行） | 分层 Domain->Feature 树布局、Actor 泳道 / Flow DAG 与 Diff 叠加纯 SVG 生成 |
| `kit/skills/lib/visual-render.mjs` (new) | 新增（`<= 800` 行） | `25-60 KB` 原创零依赖 HTML 壳（Verdict/Chips/Theme、缩放检索、`walk-bar`、源码浮卡、3 级 `file://` 追问复制、沙盒原型预览） |
| `kit/skills/lib/architecture-map.mjs` (new) | 新增（`<= 800` 行） | `ARCHITECTURE_MAP_REL = 'docs/architecture-map.html'`、`no-architecture-html` 豁免、幂等渲染与 SHA256 校验 |
| `kit/skills/lib/static-gates.mjs`、`shared.mjs` + 6 处调用方 | 改造 | 升级 `static-gates.mjs:84` `isUiVisualFile(f, { repoRoot })`（仅调叶子模块 `feature-map-graph.mjs` (new) 无环校验）、`shared.mjs` 重导出并统一替换 6 处 `UI_VISUAL_EXT_RE` |
| `verify-tools.mjs`、`repo-map.mjs`、`flow-lifecycle-finalize.mjs`、`flow-lifecycle-hooks.mjs`、`govern-audit.mjs`、`edit-gate.mjs` | 改造 | 写命令（`finalize` 在 `git add` 前）自动渲染 + `render [--check]` 对拍；`reconcile`/`verify`/`edit-gate --final` 纯只读 |
| `scripts/lib/artifact-executors.mjs`、`survey-gap-rules.mjs`、`survey.mjs`、`equip*.mjs`、`review.mjs`、`gap-coverage.mjs`、`.gitattributes`、`references/survey.md` | 改造 | `S1-S4` 治理产物接管、缺口规则对拍、基线 `.gitattributes` 规则与 `injections-data-repo-alignment.mjs` 同步 |

## 一、背景与边界声明

- **要改什么**：从零构建原创零依赖视觉布局与渲染引擎（`visual-layout.mjs` (new)、`visual-render.mjs` (new)）及 `architecture-map.mjs` (new)；升级 `static-gates.mjs:84` `isUiVisualFile(f, { repoRoot })` 并通过 `shared.mjs` 重导出、统一替换全仓 6 处 `UI_VISUAL_EXT_RE` 调用；实现 `flow-lifecycle-finalize.mjs` 与只读校验分离及 `S1-S4` 接入。
- **不改什么**：不修改切片 1 已落地的 `feature-map-graph.mjs` (new) 校验核心；不改动 `session-state.mjs` 或 `doc-plan` Living Brief（留待切片 3）；不把 `govern reconcile` 改为写命令（保持 `subcommand-meta.mjs:62` `mutating: false`）；不为手改 HTML/SVG 放松视觉实证门禁。
- **本期不做**：不挂载 Living Visual Brief 仓外状态机（切片 3）；不在 `project-forge` 自身仓库正式生成提交 `docs/architecture-map.html` (new)（自举提交留在切片 3，本期通过隔离沙盒夹具实证）。
- **复用既有模块**：复用切片 1 叶子模块 `feature-map-graph.mjs` (new) 的 `computeFeatureMapCanonicalSha256`、`verifyArchitectureMapHeader`、`buildFallbackDomains`、`kit/skills/lib/git.mjs`（`sha256Text`、`readTextSafe`、`writeAtomic`）、`kit/skills/lib/profile.mjs`（`readDecisions`）、`kit/skills/lib/subcommand-meta.mjs` 与 `kit/skills/lib/exit-codes.mjs`。
- **架构基线关系**：遵守 `kit/**` 零外联与零第三方依赖约束；`static-gates.mjs` 严禁导入 `architecture-map.mjs` (new) 或 `feature-map.mjs`（仅导入无上游环路的 `feature-map-graph.mjs` (new)）；控制 HTML 产物体积在 `25-60 KB`（远低于 `review.mjs` L223-225 `secrets.unverified-large` 256 KB 阈值），严禁写入 `homedir()` 绝对路径。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **原创双模布局与渲染引擎（`visual-layout.mjs` (new) + `visual-render.mjs` (new) + `architecture-map.mjs` (new)）**：
   - `visual-layout.mjs` (new)：纯函数 SVG 生成器，接收 v2（或自动退化合成域的 v1）特征图与可选 `diffOverlay` / `briefSpec`，生成三类带语义属性（`data-node-id`、`data-node-label`、`data-edge-id`、`data-source-id`）的矢量图：
     1. Hierarchical Domain -> Feature 树视图；
     2. Actor 泳道与 Flow DAG 视图（按拓扑分层与正交/平滑边路由）；
     3. 变更 Diff 叠加视图（高亮新增/修改/下游受影响节点）。
   - `visual-render.mjs` (new)：组装 `25-60 KB` 原创零依赖自包含 HTML（内嵌紧凑 CSS 与原生 JS，绝不嵌套 base64 gzip 副本与外部版权标记）：
     - 首行强制嵌入：`<!-- @generated by project-forge feature-map-sha256=<sha256> -->`（架构图模式）；
     - 顶栏结论卡 `.verdict` + 作用域 `.scope-chip` + `auto/light/dark` 主题切换（`localStorage` 读写包在 `try/catch` 中兼容隐身/禁用存储上下文）；
     - SVG 原位滚轮缩放/拖拽平移/节点关键词检索与上下游聚焦；
     - `walk-bar` 步进导览（上一步/下一步/键盘方向键与 `Esc` 同步高亮节点与说明项）及术语双向联动；
     - 悬停源码锚点气泡卡（仅使用仓库相对路径与行号，绝不出现 `homedir()`）；
     - 面板级「追问」按钮 + 划词浮钮生成含相对路径与节点上下文的 Follow-up Prompt，复制实现 3 级 `file://` 降级链（`navigator.clipboard.writeText` -> 隐藏 `<textarea>` + `execCommand('copy')` -> 可选中回退框提示手动复制）；
     - 沙盒原型视图槽（`<iframe sandbox="allow-scripts">` 内嵌 `srcdoc` / `<img>` / 白名单 URL 预览与多视口切换，供切片 3 复用）。
   - `architecture-map.mjs` (new)：导出 `ARCHITECTURE_MAP_REL = 'docs/architecture-map.html'`、`NO_ARCHITECTURE_HTML_DECISION = 'no-architecture-html'`、`syncArchitectureMap(repoRoot, opts)`、`verifyArchitectureMapSync(repoRoot)`；若 `AGENTS.md`「取舍」声明 `no-architecture-html` 则跳过渲染与漂移阻断。
2. **无环导入 DAG 与 `isUiVisualFile(f, { repoRoot })` 全仓 6 处统一替换**：
   - **无环依赖设计**：`static-gates.mjs`（787 行）只从叶子模块 `feature-map-graph.mjs` (new) 导入 `verifyArchitectureMapHeader(repoRoot, fileRel)`，不直接导入 `architecture-map.mjs` (new) 或 `feature-map.mjs`，确保 `static-gates.mjs -> feature-map-graph.mjs -> git-core.mjs` 严格无环。
   - **升级 `static-gates.mjs:84` 与 `shared.mjs:132`**：升级 `isUiVisualFile(fileRel, { repoRoot } = {})` 在命中 `UI_VISUAL_EXT_RE` 时检查：若规范化路径为 `docs/architecture-map.html` 且 `repoRoot` 存在该文件与 `docs/feature-map.json` 且首行 `feature-map-sha256` 与实时规范化 SHA256 完全一致，则返回 `false`（免除 UI 截图与 `high` 风险升级），任何篡改或漂移仍返回 `true`。在 `kit/skills/lib/shared.mjs` 同步导出 `isUiVisualFile`。
   - **工作树优先透传与 6 处调用替换**：在 `kit/skills/dev-review/scripts/review-pack.mjs`（L379 与 L501 `assessBehavioralGate` 传入 `reviewRoot`）、`kit/skills/dev-review/scripts/review-empirical.mjs`（L55 `determineWorkflowPolicy` 传入 `repoRoot`）、`workflow-policy.mjs`（`determineWorkflowPolicy` L152 入参增 `repoRoot = null`）与 `review-gates.mjs`（`assessBehavioralGate` L300）透传工作树优先的根目录（`implRoot || reviewRoot || mainRoot`，并保持 `review-gates.mjs <= 798` 行与 `flow-lifecycle-helpers.mjs <= 798` 行，必要时微调抽离辅助行），统一替换全部 6 处 `UI_VISUAL_EXT_RE` 调用：
     1. `kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`（L695）；
     2. `kit/skills/dev-flow/scripts/flow-lifecycle.mjs`（L481）；
     3. `kit/skills/dev-review/scripts/review-gates.mjs`（L307）；
     4. `kit/skills/dev-review/scripts/review-locks.mjs`（L48）；
     5. `kit/skills/dev-review/scripts/review-locks.mjs`（L542）；
     6. `kit/skills/lib/workflow-policy.mjs`（L174）。
3. **自动同步写/读分离与 `verify-tools render [--check]`**：
   - **写入口自动渲染**：
     - `kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs` `handleFinalize`：在归档同步之后、执行 `git add`（L221）**之前**自动调用 `syncArchitectureMap(implRoot)` 并把 `docs/architecture-map.html` (new) 加入 `pathsToStage` 一并暂存，避免产生未暂存脏文件导致后续 `verify`/`submit` 触发 `BLOCKED_DIRTY_WORKTREE`；
     - `verify-tools.mjs` `create`/`sync`/`render` 与 `repo-map.mjs --write-feature-map`（未启用 `no-architecture-html` 时）自动调用 `syncArchitectureMap`。
   - **只读命令与门禁零写入**：
     - `govern-audit.mjs` `reconcile`（`subcommand-meta.mjs:62` `mutating: false`）保持 100% 只读，检测 `docs/architecture-map.html` (new) 缺失或漂移并输出修复提示 `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render`；
     - `flow-lifecycle-hooks.mjs`（`verify`）与 `edit-gate.mjs --final` 只读调用 `verifyArchitectureMapSync`，存在 `docs/feature-map.json` 且未声明 `no-architecture-html` 时若缺失或指纹失配则以 `BLOCKED_ARCHITECTURE_MAP_DRIFT` 阻断（在 `kit/skills/lib/exit-codes.mjs` `FACT_CODES` 登记为单一 `EXIT.FACT` = `3` 档位，满足 `exit-code-parity.mjs`）。
   - **CLI 四处对拍**：`verify-tools.mjs` 新增 `render [--check] [--out <path>] [--json]`，由 `verify-tools.mjs` 直接读取 `opts.check` 与 `opts.out`（满足 `cli-parity.mjs:50` 作用域扫描），同步更新 `kit/skills/lib/subcommand-meta.mjs`（`verify-tools` 新增 `entry('render', true)`）、`verify-tools.mjs` 头部 JSDoc、`printHelp()`（含 L45 用法行把 `render` 并入 `sync/create/run/audit/clean/render` 列表及子命令/选项声明）与命令分发。
4. **S1-S4 治理接入与基线对齐**：
   - `scripts/lib/artifact-executors.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/survey.mjs`、`scripts/review.mjs`、`scripts/dev/gap-coverage.mjs`：纳入 `architecture-map` 产物计划与体检（存在 `docs/feature-map.json` 且未设 `no-architecture-html` 时检查 `docs/architecture-map.html` (new) 就绪与漂移，保证 `ARTIFACT_EXECUTORS`、`survey-gap-rules.mjs`、`review.mjs` 与 `gap-coverage.mjs` 全闭环）；
   - `references/survey.md` 与 `scripts/dev/injections-data-repo-alignment.mjs`：若 `artifactPlan` 基础条目数仍为 13 项（按条件附加 `architecture-map`）则严守 `references/survey.md:38` `I396` 锚点字面量；若扩展为 14 项则同步更新 `references/survey.md:38` 与 `injections-data-repo-alignment.mjs:97-98` 保持注入必红。
   - `scripts/equip.mjs`、`scripts/lib/equip-bootstrap.mjs`（`BASE_GITATTRIBUTES`）与本仓 `.gitattributes`：同步派生 HTML 行尾/语言标记规则且不破坏 `preflight --package` 与 `REPO_ONLY_*` 一致性。
   - 同步维护 `scripts/dev/fixtures-equip.mjs`、`scripts/dev/fixtures-doc-closure.mjs` 并新增 `scripts/dev/fixtures-visual-engine.mjs` (new)。

### 数据与状态变更

- 新增仓库产物 `docs/architecture-map.html` (new)（默认由 `docs/feature-map.json` 自动同步生成，可被 `no-architecture-html` 豁免）。
- `kit/skills/lib/exit-codes.mjs`：`FACT_CODES` 新增单一档位 `BLOCKED_ARCHITECTURE_MAP_DRIFT`（`EXIT.FACT` = `3`）；`kit/skills/lib/subcommand-meta.mjs`：`verify-tools` 新增 `render`。

### 异常、回退与安全边界

- 任何对 `docs/architecture-map.html` (new) 的手工编辑（导致首行 SHA256 与 `docs/feature-map.json` 不匹配）立刻失去 `isUiVisualFile` 豁免，恢复 `high` 风险与 `--artifact` 实证要求。
- 渲染前对路径做仓库相对化脱敏，严禁包含 `homedir()` 绝对路径。
- `static-gates.mjs`（787 L）、`review-gates.mjs`（792 L）、`flow-lifecycle-helpers.mjs`（788 L）与 `verify-tools.mjs`（737 L）改动严控在 `<= 798` 行以内（核心计算下沉 `architecture-map.mjs` (new) 与 `feature-map-graph.mjs` (new)）。

### 实现顺序

1. 新建 `visual-layout.mjs` (new)、`visual-render.mjs` (new)、`architecture-map.mjs` (new)。
2. 升级 `static-gates.mjs:84` `isUiVisualFile`（仅调 `feature-map-graph.mjs` (new)）与 `shared.mjs` 重导出，透传工作树优先路径并替换全仓 6 处 `UI_VISUAL_EXT_RE` 调用。
3. 接入 `verify-tools render [--check]`、`subcommand-meta.mjs`、写命令（含 `flow-lifecycle-finalize.mjs` `git add` 前）自动渲染、`govern reconcile` 只读漂移提示与 `verify`/`edit-gate --final` 只读阻断 `BLOCKED_ARCHITECTURE_MAP_DRIFT`。
4. 接入 `S1-S4`（`artifact-executors.mjs`、`survey-gap-rules.mjs`、`survey.mjs`、`equip*.mjs`、`review.mjs`、`gap-coverage.mjs`、`.gitattributes`、`references/survey.md`），运行 `node scripts/equip.mjs .` 并补齐双向 fixture 与故障注入。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 让 `static-gates.mjs` 直接导入 `architecture-map.mjs` (new) | 跨模块互相引用 | `architecture-map.mjs -> feature-map.mjs -> static-gates.mjs` 构成三元循环依赖 | 永不改回 |
| 在 `flow-lifecycle-finalize.mjs` 先 `git add` 再渲染 HTML | 渲染落在 `git add` 之后 | 会遗留未暂存脏改动导致 `verify`/`submit` 触发 `BLOCKED_DIRTY_WORKTREE` | 永不改回 |
| 让 `govern reconcile` 自动写入 `docs/architecture-map.html` (new) | 与 `subcommand-meta.mjs` `mutating: false` 冲突 | 破坏只读审计子命令语义与 `subcommand-parity.mjs` 契约 | 永不改回 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/visual-layout.mjs` (new)、`visual-render.mjs` (new)、`architecture-map.mjs` (new) | 新增 | 双模布局、零依赖 `25-60 KB` HTML 壳、幂等渲染与 SHA256 校验 | `verify-tools`、`repo-map`、`flow`、`govern`、`doc-plan` |
| `kit/skills/lib/static-gates.mjs`、`shared.mjs`、`workflow-policy.mjs`、`flow-lifecycle*.mjs`、`review-gates.mjs`、`review-locks.mjs`、`review-pack.mjs`、`review-empirical.mjs` | 修改 | 升级 `isUiVisualFile(f, { repoRoot })`（无环）并统一替换 6 处 `UI_VISUAL_EXT_RE`，透传 `reviewRoot`/`repoRoot` | 全部视觉文件风险判定与实证门槛 |
| `kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`subcommand-meta.mjs`、`exit-codes.mjs`、`repo-map.mjs`、`govern-audit.mjs`、`edit-gate.mjs` | 修改 | `render [--check]` 4 处对拍（直接读 `opts.check`/`opts.out`）、`finalize` `git add` 前自动同步、`reconcile`/`verify`/`edit-gate` 只读 | `cli-parity`、`subcommand-parity`、`verify`/`edit-gate` |
| `scripts/lib/artifact-executors.mjs`、`survey-gap-rules.mjs`、`survey.mjs`、`equip.mjs`、`equip-bootstrap.mjs`、`review.mjs`、`gap-coverage.mjs`、`.gitattributes`、`references/survey.md` | 修改 | `S1-S4` 接入与对齐、`BASE_GITATTRIBUTES` 同步、缺口与 `I396` 锚点维护 | 外部项目接入与本仓 `gap-coverage`/`preflight` |
| `.agents/skills/`、`scripts/dev/fixtures-visual-engine.mjs` (new)、`fixtures-equip.mjs`、`fixtures-doc-closure.mjs`、`injections-data-repo-alignment.mjs` | 同步 / 新增 / 修改 | 套件同步、正反行为断言与故障注入复验 | `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs` |

- **对外可见的变化**：新增 `verify-tools.mjs render [--check] [--out]`；新增 `BLOCKED_ARCHITECTURE_MAP_DRIFT`（`EXIT.FACT` = `3`）与 `no-architecture-html` 取舍开关；确定性派生 `docs/architecture-map.html` (new)。
- **需要同步改的地方**：`.agents/skills/`（执行 `node scripts/equip.mjs .`）、`scripts/dev/fixtures.mjs` 登记新 fixture。

## 五、冻结的验收标准

- [x] C5: 新增 `kit/skills/lib/visual-layout.mjs` (new)、`kit/skills/lib/visual-render.mjs` (new) 与 `kit/skills/lib/architecture-map.mjs` (new)（`ARCHITECTURE_MAP_REL = 'docs/architecture-map.html'`、支持 `no-architecture-html` 豁免），生成 `25-60 KB` 零依赖自包含 HTML（首行 `@generated ... feature-map-sha256=<sha256>`、树+泳道/DAG+Diff 视图、`walk-bar`、悬停源码浮卡、3 级 `file://` 剪贴板相对路径追问、`try/catch` `localStorage`、沙盒原型查看器、零 `homedir()` 绝对路径），经 `scripts/dev/fixtures-visual-engine.mjs` (new) 验证通过。
- [x] C6: 升级 `kit/skills/lib/static-gates.mjs:84` `isUiVisualFile(f, { repoRoot })`（仅调用叶子模块 `feature-map-graph.mjs` (new) 无环校验，并由 `kit/skills/lib/shared.mjs` 重导出）及 `kit/skills/dev-review/scripts/review-pack.mjs`（L379、L501 `assessBehavioralGate` 传入 `reviewRoot`）、`kit/skills/dev-review/scripts/review-empirical.mjs`（L55 `determineWorkflowPolicy` 传入 `repoRoot`）、`workflow-policy.mjs`/`review-gates.mjs`（`<= 798` 行）透传工作树优先根目录，统一替换全仓 6 处 `UI_VISUAL_EXT_RE` 调用（`flow-lifecycle-helpers.mjs`、`flow-lifecycle.mjs`、`review-gates.mjs`、`review-locks.mjs` 两处、`workflow-policy.mjs`），仅放行 SHA256 与实时 `docs/feature-map.json` 一致的 `docs/architecture-map.html` (new)。
- [x] C7: 实现自动同步写/读分离：`flow-lifecycle-finalize.mjs` `handleFinalize` 在 `git add`（L221）前渲染并暂存 `docs/architecture-map.html` (new)，`verify-tools create/sync/render` 与 `repo-map --write-feature-map` 自动渲染；`govern reconcile` 保持 `mutating: false` 只读报漂移；`flow verify` 与 `edit-gate --final` 纯只读并在漂移时报 `BLOCKED_ARCHITECTURE_MAP_DRIFT`（`EXIT.FACT` 单一档位）；新增 `verify-tools render [--check] [--out]`（含 `verify-tools.mjs:45` `printHelp()` 用法行加入 `render` 至 `sync/create/run/audit/clean/render`）直接读取 `opts.check`/`opts.out` 并全绿通过 `subcommand-parity.mjs` 与 `cli-parity.mjs`。
- [x] C8: 完成 `S1-S4` 接入（`artifact-executors.mjs`、`survey-gap-rules.mjs`、`survey.mjs`、`equip.mjs`、`equip-bootstrap.mjs`、`review.mjs`、`gap-coverage.mjs`、`.gitattributes`、`references/survey.md`、`injections-data-repo-alignment.mjs`），运行 `node scripts/equip.mjs .`，全绿通过 `fixtures-equip.mjs`、`fixtures-doc-closure.mjs`、`fixtures-visual-engine.mjs` (new)、`gap-coverage.mjs`、`preflight.mjs` 与 `verify-injections.mjs --jobs 4`。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（涉及 `isUiVisualFile` 风险策略、`S1-S4` 产物计划与 CLI 子命令契约）；回滚通过 `git revert` 并重跑 `node scripts/equip.mjs .`。
- **高风险路径**：触及 `kit/`、`references/survey.md`、`.gitattributes` 与 6 处安全门禁调用点；任何改动均须保持 `references/survey.md:38` 与 `injections-data-repo-alignment.mjs:97`（`I396`）对齐。
- **故障注入预演**：新增故障注入验证「放行篡改 SHA256 的 `docs/architecture-map.html` (new) / `verify` 或 `edit-gate --final` 跳过 `BLOCKED_ARCHITECTURE_MAP_DRIFT`」，通过 `review-pack check-fault --phase fail` 与 `restore` 实证。

## 七、上线与兼容策略

- **开关与默认值**：仓库可通过在 `AGENTS.md`「取舍」添加 `no-architecture-html` 关闭自动生成与漂移拦截；未声明时存在 `docs/feature-map.json` 即默认启用。
- **向后兼容**：v1 `docs/feature-map.json` 自动走 `buildFallbackDomains` 渲染，不强制修改既有项目文件结构。

## 澄清与补充记录

- （无未决澄清；已核实 `references/survey.md:38` `I396` 锚点、`static-gates.mjs:84` 无环 DAG 及 `flow-lifecycle-finalize.mjs:221` 暂存顺序）

## 实现说明

- **实际落地摘要**：已新增 `kit/skills/lib/visual-layout.mjs`、`visual-render.mjs`、`architecture-map.mjs` 与对应双向测试 `scripts/dev/fixtures-visual-engine.mjs`、故障注入 `scripts/dev/injections-data-visual-engine.mjs`（`I961`-`I964`）；升级 `isUiVisualFile(fileRel, { repoRoot })` 并全量替换 `workflow-policy`、`flow-lifecycle*`、`review-gates`、`review-locks`、`review-pack`、`review-empirical` 调用点；接入 `verify-tools render [--check] [--out]`、`repo-map`、`flow-lifecycle-finalize` `git add` 前渲染、只读 `verify`/`edit-gate --final`/`govern reconcile` 漂移检查与 `S1-S4` 接入。
- **与草案的差异**：实测发现 `feature-map-graph.mjs:408` `verifyArchitectureMapHeader` 原调用 `readTextSafe(htmlAbs, 8192)` 会在 HTML 超 8KB 时返回 `undefined`，已修正上限为 `4 * 1024 * 1024` 字节以支持 `25-60 KB` 自包含 HTML 首行指纹校验。
- **关联同步文件**：`.agents/skills/`（`node scripts/equip.mjs .`）、`.gitattributes`、`scripts/lib/equip-bootstrap.mjs`、`references/survey.md`、`scripts/lib/artifact-executors.mjs`、`scripts/lib/review-helpers.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/survey.mjs`、`scripts/review.mjs`、`scripts/dev/fixtures-equip.mjs`、`scripts/dev/fixtures-doc-closure.mjs`。
