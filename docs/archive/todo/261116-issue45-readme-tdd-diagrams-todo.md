---
kind: todo
title: 优化 README 安装直链与架构图解，清理 TDD 过时版本与流程说明
status: done
created: 2026-11-16
updated: 2026-11-16
issue: 45
pr: 46
branch: feat/readme-tdd-diagrams
owner: FiretrUCK666
approved: true
done_at: 2026-11-16
task_id: readme-tdd-diagrams
planned_at: 5ccb2293bdb757702cc766687e2ac28b99269ed2
related_prd: null
related_spec: null
---

# Todo: 优化 README 安装直链与架构图解，清理 TDD 过时版本与流程说明

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / 基线 | `main` @ `5ccb229` |
| 任务编号 | `readme-tdd-diagrams` |
| 负责人 / 审批 | FiretrUCK666 / `true` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`README.md`、`README.en.md`、`assets/readme/architecture.svg`、`assets/readme/architecture-en.svg`、`docs/TDD.md`
- **复用既有模块**：`scripts/sync-toc.mjs`、`scripts/dev/preflight.mjs`、`kit/skills/lib/doc-templates.mjs`（Mermaid 16/12 校验）
- **本期不做**：不修改业务脚本逻辑与版本号（不触发发版），不调整 `hero*.svg` / `workflow*.svg` 主体布局，不在安装文档中额外引入全局路径说明
- **门型与回滚路径**：two-way；局部可逆文档与视觉改动，直接 `git revert` 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs && node scripts/sync-toc.mjs README.md README.en.md --check`

## 验收标准与执行清单

- [x] C1: `README.md` 与 `README.en.md` 安装表直接提供点击即下的 `project-forge.zip` 链接（去除「Releases 页面」引导和裸 URL 文本），更新 `project-forge-main` 目录名示例，补清 12/14 语言栈口径、5 套日常技能分工表，且 `tone_lint.py` 0 FAIL、`sync-toc.mjs --check` 退出码 0。
- [x] C2: `assets/readme/architecture.svg` 与 `architecture-en.svg` 重绘为清楚展示 `dev-explore` → `dev-plan` → `dev-flow` → `dev-review`（含退回环线）、`dev-govern` 回流与合入四项证明的结构化图解（自包含纯 SVG、独立 `viewBox` 高度、`font-size >= 16`），经真实浏览器渲染截图核对无裁剪或遮挡且过 `preflight.mjs` 与 `fixtures-platform.mjs`。
- [x] C3: `docs/TDD.md` 清理全部未发布版本号（`v7.0.0`）与已归档阶段流水（`M0–M5` / `v7`），新增 5 套 Skill 分工总表并用 `subgraph` 重绘显式标注 Skill 归属的 Mermaid 架构与流转图（严格过 Mermaid `16/12` 零 HTML 校验、`tdd-parity` 及 `tone_lint.py` 0 FAIL）。
- [x] C4: 完成 Todo 归档、`verify --mode gate`、独立审查（含渲染截图与故障注入）与三平台 CI 全绿后合入 `main`。

## 执行步骤

1. 更新 `README.md`、`README.en.md`、`assets/readme/architecture*.svg` 与 `docs/TDD.md`，运行 `sync-toc`、`tone_lint.py` 及 SVG 浏览器渲染截图检查 —— 验证：`node scripts/dev/preflight.mjs`
2. 补齐实证与归档记录，执行 `flow.mjs finalize`、`verify --mode gate` 与 `submit`，发起独立审查并按 CI 绿灯结果推进合入 —— 验证：`merge-gate` 与 CI 全绿

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`preflight.mjs`（33 项读数全绿，新增常青保鲜检查 `32 份文档无未发布版本号或 M* 残留`）、`gap-coverage.mjs`（19/19）、`fixtures.mjs`（165/165）、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`（`mature`，0 缺）、`sync-toc.mjs README.md README.en.md --check`、`govern-audit.mjs audit .`、`verify-injections.mjs --jobs 4`（84/84 含 `I77`）、`tone_lint.py`（`README.md`/`README.en.md`/`docs/TDD.md` 0 FAIL），以及 headless Edge 浅/深色截图（`arch-light.png`/`arch-dark.png`）目视确认无重叠裁剪。
- **文档同步检查**：`README.md` 与 `README.en.md` 成对同步；`docs/TDD.md` 图表与 5-Skill 分工表更新且零 `v7`/`M*` 残留；本 Todo 已归档。
- **遗留问题**：无
