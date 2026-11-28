---
kind: todo
title: 编写 v6.0.0 发布说明并校验发版门禁
status: done
created: 2026-11-16
updated: 2026-11-16
issue: 47
pr: null
branch: feat/release-v6-0-0
owner: FiretrUCK666
approved: true
done_at: 2026-11-16
task_id: release-v6-0-0
planned_at: 82e7b076b3ab27ae72fa06b6806d8e1747567801
related_prd: null
related_spec: null
---

# Todo: 编写 v6.0.0 发布说明并校验发版门禁

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / 基线 | `feat/release-v6-0-0` @ `82e7b07` |
| 任务编号 | `release-v6-0-0` |
| 负责人 / 审批 | FiretrUCK666 / `false` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`docs/release-notes/v6.0.0.md` (new)
- **复用既有模块**：`RELEASING.md`、`templates/release-notes.md`、`kit/skills/dev-govern/scripts/govern-audit.mjs`（`release-prep`）
- **本期不做**：不修改源码版本号（`SKILL.md` 已为 `6.0.0`），不在合入前打 Git 标签
- **门型与回滚路径**：two-way（发布说明合并前完全可逆）；发版标签属于 one-way，合入 `main` 且经人确认后执行
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C1: `docs/release-notes/v6.0.0.md` 严格以 `# v6.0.0` 开头，包含一句话导语与可感知变化/修复/兼容性/升级命令，无空节、`project-forge: fill` 占位或内部脚本/阶段噪音，并通过 `tone_lint.py`（0 FAIL）。
- [x] C2: 跑通 `RELEASING.md` 全部门禁、`git archive` 用户包白名单自检（`preflight.mjs --package`）与 `release.yml` 说明格式规则校验。
- [x] C3: 完成 Todo 归档、`verify --mode gate`、独立审查与三平台 CI 全绿后合入 `main`，随后在 `main` 打推送 `v6.0.0` 标签并回读确认 Release 正文与 `project-forge.zip` 附件一致。

## 执行步骤

1. 撰写 `docs/release-notes/v6.0.0.md` 并运行 `tone_lint.py`、`preflight.mjs` 与 `git archive --format=tar HEAD` 包检查 —— 验证：`node scripts/dev/preflight.mjs --package`
2. 补齐实证并执行 `flow.mjs finalize`、`verify --mode gate`、`submit` 及独立审查后合入 `main` —— 验证：`merge-gate` 与 CI 全绿；合后推 `v6.0.0` 标签并回读 Release 页面

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`preflight.mjs`（33 项）、`gap-coverage.mjs`（19/19）、`fixtures.mjs`（165/165）、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`（`mature`，0 缺）、`sync-toc.mjs README.md README.en.md --check`、`govern-audit.mjs audit .`（0 死链）、`verify-injections.mjs --jobs 4`（84/84）、`git archive --format=tar HEAD | preflight.mjs --package` 以及 `tone_lint.py docs/release-notes/v6.0.0.md`（0 FAIL）全数通过；按 `RELEASING.md` 核对 `v6.0.0.md` 标题、正文与无 `project-forge: fill`/`scripts/dev/` 残留。
- **文档同步检查**：新增 `docs/release-notes/v6.0.0.md` 与 `SKILL.md` `metadata.version: 6.0.0`、`README*.md` `v6.0.0` 徽章对齐；本 Todo 已归档。
- **遗留问题**：无（合入 `main` 后打推送 `v6.0.0` 标签并回读确认发布页）
