---
kind: todo
title: Monochrome Focus Studio 视觉引擎重构
status: done
created: 2026-11-26
updated: 2026-11-26
issue: 195
pr: null
branch: feat/visual-monolith-v3
owner: coordinator
plan_mode: autonomous
approved: false
done_at: 2026-11-26
task_id: visual-monolith-v3
planned_at: b2b027688433c7535318afd6581d318d16a3bbf3
related_prd: null
related_spec: null
---

# Monochrome Focus Studio 视觉引擎重构

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / 基线 | `feat/visual-monolith-v3` @ `b2b0276` |
| 任务编号 | `visual-monolith-v3` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #195 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-panels.mjs`、`kit/skills/lib/visual-render-assets.mjs`、`scripts/dev/fixtures-visual-engine.mjs`、`docs/architecture-map.html`
- **复用既有模块**：复用 `visual-layout.mjs` 中的 `computeDiffOverlay` / `buildFallbackDomains` / `kahnTopoSort` / `sanitizeSafeHref` / `sanitizeSafeImgSrc` 与 `feature-map-graph.mjs` 中的拓扑排序逻辑
- **本期不做**：不改动 `visual-brief.mjs` CLI 协议与 `feature-map.json` v2 Schema，不引入任何第三方前端依赖或外部 CDN
- **门型与回滚路径**：one-way（触碰 `kit/` 高风险路径，须独立审查与故障注入）；已合并远端通过反向提交恢复，未合并直接回退分支 `feat/visual-monolith-v3`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 不做什么

- 本期不引入第三方图表库、打包构建器或外部字体/脚本 CDN。
- 不改变 `docs/feature-map.json` v2 拓扑结构与 `flow.mjs` / `doc-plan.mjs` 对外退出码契约。
- 不保留右向左滑出侧边栏、卡片彩色边条（顶部/左侧）、虚线框及发光背景。

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 去除右侧抽屉与全部彩色条纹/虚线噪音，统一中性细边框与居中排版
- [x] C2: 保留并强化全景架构与角色泳道图双无限画布拖拽、缩放及正交侧道连线
- [x] C3: 实现底部焦点聚光条、居中 Quick-Look 详情窗与 Cmd/Ctrl+K 命令目录面板
- [x] C4: 重构变更蓝图四态收敛卡片与原型对比视图，保持单文件 25-60KB 预算与安全转义

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先在 `scripts/dev/fixtures-visual-engine.mjs` 补充对齐居中、去彩条/去右抽屉及 Quick-Look/双画布失败断言 | `node scripts/dev/fixtures.mjs --filter "Visual"` 必须红 | 无 |
| 2 | 重构 `visual-layout.mjs` / `visual-render.mjs` / `visual-render-panels.mjs` / `visual-render-assets.mjs` 并同步 `equip.mjs` 与 `docs/architecture-map.html` | `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs --jobs 6` 全绿 | 步骤 1 |
| 3 | 完成无头浏览器多视图实拍验收并跑通全部校验与独立审查 | 实拍截图无缺陷且 `merge-gate.mjs` 全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 4 功能仓库自包含 HTML 体积超出 25-60KB 预算 | 单文件 CSS 与运行时 JS 冗余或内联数据重复膨胀 | 使用精简无冗余单色样式表，通过 `fixtures-visual-engine.mjs` C5 体积断言实测拦截 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：在 `.worktrees/impl-visual-monolith-v3` 运行 `fixtures.mjs --filter "Visual"` 确认新增失败用例后实施视觉引擎重构。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .`：同步 `kit/skills/lib/visual-*.mjs` 至 `.agents/skills/`，`integrityCheck.ok: true`（156 files）。
  - `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render .`：重渲 `docs/architecture-map.html`（147,230 bytes，与 `docs/feature-map.json` SHA256 同步）。
  - `node scripts/dev/preflight.mjs`：自检通过，0 项失败（41 项读数）。
  - `node scripts/dev/gap-coverage.mjs`：22 条各有处置，全部通过。
  - `node scripts/dev/fixtures.mjs --jobs 6`：行为断言 558 项通过，0 项失败（4 功能仓库渲染 HTML 体积 60,289 bytes，在 25-60KB 预算内）。
  - `node scripts/dev/verify-injections.mjs --jobs 4`：故障注入复验 467 条判据全命中。
  - `node scripts/compose-agents.mjs . --check` / `node scripts/equip.mjs . --check` / `node scripts/review.mjs .` / `node scripts/sync-toc.mjs README.md README.en.md --check` / `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .`：全部通过。
  - `node scripts/dev/merge-gate.mjs`：12/12 步全部通过。
  - `shoot.mjs`（1440×900 `tree`/`flow`/`focus`/`quicklook`）：exit 0，0 控制台错误、0 横向溢出、0 图片加载失败、0 对比度告警。
- **文档同步检查**：`docs/architecture-map.html` 已同步更新；已导出预览产物并完成 `shots_final` 实拍验收。
- **遗留问题**：无。
