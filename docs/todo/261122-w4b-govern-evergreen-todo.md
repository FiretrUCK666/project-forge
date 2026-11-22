---
kind: todo
title: "Wave 2: 基于升级工具的长青文档系统与功能地图刷新"
status: active
created: 2026-11-22
updated: 2026-11-22
issue: null
pr: null
branch: feat/w4b-govern-evergreen
owner: plan-harness
plan_mode: interactive
approved: false
done_at: null
task_id: w4b-govern-evergreen
planned_at: b6ea3f6a2134373f8139ea581465e8024639e5c6
related_prd: ../prd/261122-w4-harness-and-evergreen-prd.md
related_spec: ../specs/261122-w4b-govern-evergreen-spec.md
---

# Wave 2: 基于升级工具的长青文档系统与功能地图刷新

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active` |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | `feat/w4b-govern-evergreen` @ `b6ea3f6`（需在 `w4a-harness-core` 合入后 rebase 启动） |
| 任务编号 | `w4b-govern-evergreen` |
| 负责人 / 审批 | `plan-harness` / `false` |
| 规划态 | `interactive`（前置依赖 `w4a-harness-core`，待 Critique 后批准） |
| 关联文档 | [Wave 4 总控 PRD](../prd/261122-w4-harness-and-evergreen-prd.md) · [Wave 2 SPEC](../specs/261122-w4b-govern-evergreen-spec.md) |

- **断点恢复**：先确认 `w4a-harness-core` 已合并进 `main`，再按 `C6..C7` 实跑新版工具刷新长青文档。

## 任务范围与验证基准

- **影响路径**：`docs/TDD.md`、`docs/feature-map.json`、`AGENTS.md`、`templates/agents-project.md`
- **复用既有模块**：`kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`scripts/compose-agents.mjs`、`scripts/review.mjs`
- **本期不做**：不修改 `kit/skills/` 与 `scripts/` 逻辑代码、不修改 `README.md`/`README.en.md`/`assets/readme/`
- **门型与回滚路径**：`two-way`；合入后可用 `git revert` 单提交回滚。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C6: 实跑新版 `repo-map.mjs` 与 `govern-audit.mjs reconcile` 后刷新 `docs/TDD.md`（补全全部 L1–L4 模块清单、升级图 1/4/5 与 Harness 四原语及 per-worktree 状态隔离说明），通过 `doc-plan.mjs audit .`、`tdd-structure` 与 `tdd-parity`。
- [ ] C7: 刷新 `docs/feature-map.json`（补全全量 `docAnchor`、`skill` `verificationTools`、`check`/`release` `testRefs` 与 PR #128/#129/`w4a` 模块）及 `AGENTS.md` CI 校验命令（`< 24576B`），达到 `verify-tools.mjs audit .` `Status: OK | StaleTools: 0`、`govern-audit.mjs reconcile .` 零漂移与 `review.mjs .` 零脱节。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 实跑 `repo-map.mjs`、`govern-audit.mjs reconcile . --json` 与 `verify-tools.mjs audit .` 获取终态清单 | 确认 `w4a` 已合入 `main` | `w4a-harness-core` |
| 2 | 更新 `docs/TDD.md`、`docs/feature-map.json` 与 `AGENTS.md` | `compose-agents.mjs . --check`、`doc-plan.mjs audit .` | 步骤 1 |
| 3 | 复跑全量工具校验与门禁 | `verify-tools audit .` (`StaleTools: 0`)、`govern-audit audit . --strict`、`review.mjs .`、`preflight.mjs` | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`等待 Wave 1 (w4a-harness-core) 先行与独立 Critique 审核`
- **待拍板事项**：无
- **下一步第一件事**：在 `w4a-harness-core` 合并进 `main` 且本规划获批后，运行 `flow.mjs start --task w4b-govern-evergreen` 建槽并实跑新版 `govern-audit reconcile`。

## 澄清与补充记录

- 已确认（2026-11-22 · user）：严格等待 `w4a-harness-core` 落地后再更新 `docs/TDD.md` 与 `docs/feature-map.json`，避免树哈希漂移与重复劳动。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
