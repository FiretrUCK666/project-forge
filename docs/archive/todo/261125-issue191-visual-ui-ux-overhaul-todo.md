---
kind: todo
title: Calm Chinese Editorial UI/UX Overhaul for Visual Engine
status: done
created: 2026-11-25
updated: 2026-11-25
issue: 191
pr: null
branch: feat/visual-ui-ux-overhaul
owner: coordinator
plan_mode: autonomous
approved: false
done_at: 2026-11-25
task_id: visual-ui-ux-overhaul
planned_at: 73a9183a4f95a6f3f4b5e385de366fc6ff09d257
related_prd: null
related_spec: null
---

# Calm Chinese Editorial UI/UX Overhaul for Visual Engine

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / 基线 | `feat/visual-ui-ux-overhaul` @ `73a9183` |
| 任务编号 | `visual-ui-ux-overhaul` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `autonomous`（Case 3 局部 UI/UX 与本地化重构） |
| 关联 Issue / PR / SPEC | #191 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-render-assets.mjs` (new)、`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-brief.mjs`、`scripts/dev/fixtures-visual-engine.mjs`、`docs/feature-map.json`、`docs/TDD.md`、`docs/architecture-map.html`
- **复用既有模块**：`kit/skills/lib/visual-layout.mjs`（`escapeHtml` / `escapeXml` / `escapeJsonForScript` / `sanitizeSafeHref` / `sanitizeSafeImgSrc` / `toRelPath`）、`kit/skills/lib/git-core.mjs`（`sha256Text`）、`kit/skills/lib/architecture-map.mjs`、`kit/skills/lib/visual-brief.mjs`
- **本期不做**：不新增任何第三方前端或服务端依赖；不修改 `visual-layout.mjs` 的 `sanitizeSafeHref` 白名单协议校验（保持 I964 注入契约）；不改动 `docs/feature-map.json` 拓扑数据与 S1-S4 校验逻辑；不修改 `scripts/lib/` 与 CLI 参数契约。
- **门型与回滚路径**：two-way；局部可逆改动，直接 `git revert` 或关闭分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 不做什么

- 不引入外部 CSS/JS/字体 CDN，保持单文件 `docs/architecture-map.html` 与 Living Visual Brief 离线自包含运行与 4 功能夹具 `25-60 KB` 体积区间。
- 不更改 `walk-bar` 类名、`ArrowRight` / `ArrowLeft` / `Escape` 快捷键、`execCommand` / `clipboard-fallback` 三级剪贴板降级与 `localStorage` `try/catch` 保护。
- 不修改 `main` 主仓工作区，所有编辑与测试只在 `.worktrees/impl-visual-ui-ux-overhaul` 内进行。

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 拆分 `kit/skills/lib/visual-render-assets.mjs` (new)（迁移 `buildStylesCss` 与 `buildClientScript`），保持 `visual-render.mjs` 与 `visual-render-assets.mjs` 均 `< 600` 行、零第三方依赖、零 emoji，并执行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 与 `.pf-manifest.json`。
- [x] C2: 消除 SVG 节点左竖色条、点阵背景与高饱和紫蓝渐变，落地 Calm Editorial 浅/深色语义配色，且 `context` 状态节点不再渲染冗余状态徽章。
- [x] C3: 全量界面中文化（`<html lang="zh-CN">`）、按模式裁剪 Tab、`方案原型` 支持单方案与并排对比切换及 512 KB 中文提示（更新 `scripts/dev/fixtures-visual-engine.mjs` 对应断言并保持 `25-60 KB` 体积区间）、顶部紧凑单行栏、自动 `fitToView()` 居中缩放、静默连线高亮及集成式右侧「模块详情 + 模块目录」检查器。
- [x] C4: 重新渲染 `docs/architecture-map.html`（`verify-tools.mjs render`），在真实无头 Chrome CDP 验证 `docs/architecture-map.html` 与含 2 个原型 Tab 的 Living Visual Brief HTML 浅/深色交互（0 JS 报错、0 左竖条、全中文界面），并通过 `edit-gate --changed --final`、`flow verify --mode gate`（`merge-gate.mjs` 12/12）及 `verify-tools.mjs audit` / `render --check`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 拆分 `visual-render-assets.mjs` (new) 并重构 `visual-render.mjs`、`visual-layout.mjs`、`visual-brief.mjs` 与 `fixtures-visual-engine.mjs` | `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs` 绿 | 无 |
| 2 | 同步 `.agents/skills/` 与重渲 `docs/architecture-map.html`，在 Chrome CDP 实测浅深色截图与交互 | `node scripts/equip.mjs . --check` 与 `verify-tools.mjs render --check` 绿 | 步骤 1 |
| 3 | 完成文档勾选、归档校验、全量门禁与提交 PR | `flow finalize`、`flow verify --mode gate`、`flow submit` | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 4 功能夹具 HTML 体积超出 `25-60 KB` 预算 | 内联 CSS/JS 或中文文案膨胀 | 保持样式与脚本紧凑并实测 `r1.bytes` 处于 `25-60 KB` 区间 |
| 长中文标签在 SVG 节点框中溢出 | 节点标题或域名超过卡片宽度 | 沿用 `truncateLabel` 按全角宽度截断并在 Chrome 中核查 `maxOverflow: 0` |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（已建 Case 3 Todo 与隔离 worktree `.worktrees/impl-visual-ui-ux-overhaul`）
- **待拍板事项**：无
- **下一步第一件事**：运行 `doc-plan.mjs audit` 与 `flow.mjs start` / `claim` / `explore` 后开始拆分 `visual-render-assets.mjs` (new)。

## 澄清与补充记录

- （本轮无额外澄清补充）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .`：新增 `lib/visual-render-assets.mjs`（< 600 行）并同步升级 `visual-render.mjs`（406 行 < 600 行）、`visual-layout.mjs`、`visual-brief.mjs`，155 个脚本 ABI/语法全绿。
  - `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render` & `render --check` & `audit .`：`docs/feature-map.json` 22 个功能/5 个域/4 条流程全量中文化补全，`docs/architecture-map.html` 同步重渲，`audit` 0 告警/盲区。
  - 无头 Chrome CDP（1440x900 浅/深色）实测 `docs/architecture-map.html` 与双原型 Living Visual Brief HTML：0 JS 报错、0 左竖条、0 文本溢出、87.8% 工作区占比、22/22 模块显示真实测试数、自动 `fitToView()` 居中、专属 `模块详情` 5 段式检查器（`← 返回目录` + 可点击上下游/业务流/折叠详情/画布居中）、`业务流筛选` 编号步骤带、2 栏 `规划盘面` 与 `方案原型` 单方案/并排对比（iframe 520px）均正常交互。
  - 全量门禁：`edit-gate --changed --final`、`flow verify --mode gate`（`merge-gate.mjs` 12/12，含 `preflight` 41/41 与全量 556 项 `fixtures.mjs`）均通过。
- **文档同步检查**：已更新 `docs/TDD.md`（补录 `kit/skills/lib/visual-render-assets.mjs`）、`docs/feature-map.json`、`docs/architecture-map.html`，并经 `equip.mjs .` 同步 `.agents/skills/` 与 `.pf-manifest.json`。
- **遗留问题**：无。
