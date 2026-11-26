---
kind: todo
title: "Visual UX v5: 60fps Drag, De-Walled Blueprint and UI Polish"
status: done
created: 2026-11-26
updated: 2026-11-26
issue: 212
pr: null
branch: feat/visual-ux-v5-polish
owner: coordinator
plan_mode: autonomous
approved: false
done_at: 2026-11-26
task_id: visual-ux-v5
planned_at: d7a13a47044a08d9173cda5f535dc69e690bc5a1
related_prd: null
related_spec: null
---

# Visual UX v5: 60fps Drag, De-Walled Blueprint and UI Polish

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / 基线 | `feat/visual-ux-v5-polish` @ `d7a13a4` |
| 任务编号 | `visual-ux-v5` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #212 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-render-assets.mjs`、`kit/skills/lib/visual-render-panels.mjs`、`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/architecture-map.mjs`、`scripts/dev/fixtures-visual-engine.mjs`、`.agents/skills/lib/*`（经 `equip.mjs` 同步）、`docs/architecture-map.html`（经 `verify-tools.mjs render` 同步）
- **复用既有模块**：复用 `kit/skills/lib/visual-layout.mjs` 路由/转义工具、`kit/skills/lib/visual-render-assets.mjs` 客户端交互框架、`scripts/dev/fixtures-visual-engine.mjs` 双向测试夹具、`scripts/equip.mjs` 与 `kit/skills/dev-verify-tools/scripts/verify-tools.mjs`
- **本期不做**：不引入任何第三方依赖、不修改 `docs/feature-map.json` schema、不重写 `visual-layout.mjs` 拓扑域分层或正交路由核心算法、不改动非视觉渲染引擎的 CLI 契约
- **门型与回滚路径**：two-way；局部可逆改动，直接 `git revert` 即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 60fps 零卡顿拖拽与平移：`.pf-node` 仅对颜色/边框/阴影做 transition（严禁全属性 `transition:.14s` 拖慢 `left`/`top`），拖拽期启用 `is-dragging-node`（`transition:none!important;will-change:transform`）、`.pf-viewport` 启用 `touch-action:none`、拖拽通过 `setPointerCapture` + `requestAnimationFrame` + `translate3d` 与预索引 `edgesByNode` 仅重绘关联边，`pointerup` 提交坐标并显示 `.pf-zoom-float` 内的「重置布局」按钮可一键复位；拖拽/平移期间挂起 `mouseover` 扫描；画布平移与缩放经 `requestAnimationFrame` 合批；仅在流式列表卡片（`.pf-chg-card`、`.pf-brief-sec`、`.pf-catalog-group`）启用 `content-visibility:auto` 与 `@supports` 降级。验收：`node scripts/dev/fixtures.mjs` 新增 C1 正反断言通过，且真实无头浏览器拖拽探测确认 `translate3d` 更新、边随动与重置复原。
- [x] C2: 可扫视 Studio 蓝图（消除嵌套边框墙）：桌面端（`min-width:960px`）`.pf-topbar` 单行 `flex-wrap:nowrap`、`.pf-title` 单行省略并带 `title` 全称、`.pf-shell` 采用 `height:100dvh` flex 列布局使 `.pf-workspace` 自然填满；`renderBlueprintLandingHtml` 移除 `.pf-verdict-hero` 内重复状态胶囊，内置四态内联筛选条（保留 `data-diff-filter="added|modified|removed|impacted"`）与「在全景图中高亮改动 →」（`#btn-jump-diff-tree`）；用双列细线分隔的变更清单替换多层嵌套卡片墙并折叠下游波及 `<details class="pf-impact-fold">`（保留 `data-target-id`）；`flowDeltas`/`childSlices`/`masterPrd` 改为紧凑横向条，`goals`/`nonGoals`/`decisions`/`openQuestions` 改为无边框细线台账并超 3 条时 `<details>` 渐进折叠。验收：`shoot.mjs` 在 Brief 与 Architecture Map 上「用边框分组过多」lint 告警均为 0。
- [x] C3: UI/UX 细节、WCAG AA 对比度与布局整洁：打开 `#pf-quicklook`/`#pf-cmdk`/`#prompt-dialog` 时自动隐藏 `#pf-focus-card` 且关闭后按 `selId` 恢复；点击弹窗遮罩背景关闭对应弹窗，点击空白 `.pf-viewport`（位移 `<=5px`）取消选中；暗色 `--accent-solid` 调整为 `#4F46E5`、暗色 `--muted` 提亮至 `#A8B8CD`、核查浅色 `--muted`/`--ph` 与 `.pf-node.is-dimmed`/`.pf-node.is-flow-dimmed` 不再用低 `opacity` 导致文字对比度低于 4.5:1；顶栏/聚焦条/泳道条去除多层嵌套边框；`layoutFlowDag` 省略无节点的空泳道行；`fit()` 边距收紧至 `24px`；`architecture-map.mjs` 在 `repoName`/`project` 缺省时回退 `basename(root)`。验收：`shoot.mjs` 在 Brief 与 Architecture Map（深/浅色）对比度与边框分组 lint 告警、控制台错误与横向溢出均为 0。
- [x] C4: 契约兼容、双向测试、浏览器实证与全量门禁：保留既有体积预算（25-60KB）、`284x114` 卡片尺寸、`data-followup-panel` 唯一性、单文件 `<=800` 行等不变量；在 `scripts/dev/fixtures-visual-engine.mjs` 补齐 C1–C3 正反双向断言；执行 `equip.mjs .` 与 `verify-tools.mjs render .`；产出 `visual_v5_after` 真实截图、`--stitch` 前后对照图与拖拽实测；全绿通过 `edit-gate --final`、`flow.mjs finalize`、`flow.mjs verify --mode gate`（12/12 `merge-gate.mjs`）与 `flow.mjs verify --mode smoke`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 冻结 Todo 并绑定隔离任务与 Issue | `doc-plan.mjs audit` + `flow.mjs start` | 无 |
| 2 | 实施 C1–C3 引擎源码修复与样式交互升级 | `node scripts/dev/preflight.mjs` | 步骤 1 |
| 3 | 补充正反双向测试、同步 `.agents/skills` 与 `docs/architecture-map.html` | `node scripts/dev/fixtures.mjs` + `equip.mjs . --check` | 步骤 2 |
| 4 | 运行真实无头浏览器 `shoot.mjs`、前后拼图与拖拽性能探测 | `report.json` 中 `lint=[]`、`issues=[]` 且拖拽实证通过 | 步骤 3 |
| 5 | 执行最终门禁、归档、实证与提交 PR | `edit-gate --final`、`flow.mjs finalize`、`verify --mode gate/smoke`、`submit` | 步骤 4 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：在 `.worktrees/impl-visual-ux-v5-polish` 内先跑 `doc-plan.mjs audit` 与 `flow.mjs start`，随后按 C1–C3 修改 `kit/skills/lib/visual-*.mjs` 与 `architecture-map.mjs`。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .` & `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render .`：同步 157 个套件脚本与 `docs/architecture-map.html`（137201 B）；4 功能 C5 HTML 61247 B（<= 61440 B 预算）。
  - `node scripts/dev/fixtures.mjs --only Visual`：17/17 双向行为断言通过（含 C1–C3 新增正反用例）。
  - `shoot.mjs`（Brief 4 态深/浅 + Arch Map 6 态深/浅）及 4 组 `--stitch` 前后拼图：0 对比度 lint、0 边框分组 lint、0 控制台错误、0 横向溢出。
  - 无头 Chromium CDP 实时拖拽实测：`pointermove -> rAF` 0.7ms 内通过 `translate3d` 更新且 `left`/`top` 零抖动、关联边随动、`pointerup` 提交并显示「重置布局」、点击后精确复原初始坐标与服务端 SVG 路径；模态与焦点卡互斥、遮罩关闭、空画布取消选中均通过。
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json`：0 blockers；全量 `flow.mjs verify --mode gate`（12/12 `merge-gate.mjs`）与 `--mode smoke` 验证通过。
- **文档同步检查**：`.agents/skills/` 已通过 `equip.mjs .` 与 `kit/skills/` 字节级同步，`docs/architecture-map.html` 已重渲对齐 `docs/feature-map.json`，不改动外部契约或 README/TDD。
- **遗留问题**：无。
