---
kind: todo
title: Milestone 0：v7 总控 PRD 与 TDD 架构契约校准
status: done
created: 2026-11-15
updated: 2026-11-15
issue: 33
pr: 34
branch: feat/v7-prd-tdd
owner: FiretrUCK666
approved: false
done_at: 2026-11-15
task_id: m0-v7-prd-tdd
planned_at: 7dbc719ee36c7da23b7b67e5a855cdcaae5886ef
related_prd: null
related_spec: null
---

# Todo: Milestone 0：v7 总控 PRD 与 TDD 架构契约校准

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（`draft \| active \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-15` / `2026-11-15` |
| 分支 / 基线 | `feat/v7-prd-tdd` @ `7dbc719` |
| 任务编号 | `m0-v7-prd-tdd` |
| 关联 Issue / PR | #33 / #34 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交；总控 PRD 为跨 M1–M5 长期活跃文档，**本任务仅归档本 Todo，不归档 `docs/prd/261115-v7-workflow-architecture-prd.md`**。

## 影响范围

- 预计改动文件：`docs/prd/261115-v7-workflow-architecture-prd.md` (new)、`docs/TDD.md`、`docs/archive/todo/261115-issue33-v7-prd-tdd-todo.md`
- 快测命令：`node scripts/dev/preflight.mjs`
- 高风险提醒：触碰 `docs/TDD.md`（Case 5 架构先行校准），须完成独立 Plan Critique 与独立上下文审查 + 故障注入验证。

## 复用既有模块

- `scripts/review.mjs` 与 `scripts/lib/survey-reentry.mjs`（校验 `docs/TDD.md` 无 `staleTddPaths`）
- `kit/skills/dev-plan/scripts/doc-plan.mjs` 与 `doc-audit.mjs`（校验 PRD/Todo 结构与 Mermaid 16/12 宽度）
- `scripts/dev/preflight.mjs` 与 `scripts/dev/fixtures.mjs`（全仓静态契约与夹具验证）

## 本期不做

- 本切片不修改 `scripts/`、`kit/`、`templates/`、`SKILL.md` 或 `AGENTS.md` 实现代码（分别留待 M1–M5 独立切片交付）。
- 不提前在 `docs/TDD.md` 写入 M1–M4 尚未落盘的新 `.mjs` 路径字面量（避免触发 `detectTddStalePaths` 误报，各新建路径随对应切片同步登记）。

## 门型与回滚路径

- 门型：`one-way`（确立 v7 顶层架构契约与 5 切片边界）
- 回滚路径：纯文档立项校准，若方向调整可直接 `git revert` 本次合并提交或通过后续切片修订 `docs/TDD.md`。

## 验收标准（动手之前冻结）

- [x] C1: `docs/prd/261115-v7-workflow-architecture-prd.md` 完整覆盖全部 7 大场景、5 切片分解路线图与冻结标准 `C1..C12`，通过 `doc-plan.mjs audit`、完成独立只读 Plan Critique、执行 `critique-pass` 并批准设为 `active`（不随 M0 归档）。
- [x] C2: `docs/TDD.md` 已完整校准至 v7 四层正交边界、纯 JS `.zip` 备份契约、全量 Worktree 与三正交策略、外部全拓扑、宿主无关并行调度与 FIFO 合并队列、1:N 总控 PRD 生命周期保护、抗无限审查与三位一体实证规范，且 `scripts/review.mjs` 报告 0 个 `staleTddPaths` 与 0 个 `missing`。
- [x] C3: 在 `.worktrees/impl-m0-v7-prd-tdd` 跑通全仓门禁（`preflight`、`gap-coverage`、`fixtures`、`compose-agents --check`、`equip --check`、`review`、`sync-toc`、`govern-audit`、`verify-injections`），完成独立审查与故障注入记录后通过 PR 合并。

## 执行步骤

1. 撰写总控 PRD 与更新 `docs/TDD.md` 契约 —— 验证：`node .agents/skills/dev-plan/scripts/doc-plan.mjs audit` 通过
2. 派独立只读代理对 PRD 与 TDD 做 Plan Critique 并回填自净化，执行 `critique-pass` 与 `approve` —— 验证：`node scripts/review.mjs .` 通过（0 个「缺」）
3. 执行 `flow.mjs finalize`、提交、运行 `flow.mjs verify` 与 `flow.mjs submit`，移交独立上下文审查并合并 —— 验证：`node scripts/dev/preflight.mjs` 通过

## 断点与遗留决策

- **当前状态**：`已完成，待合并收尾`（总控 PRD 维持 `active` 留驻 `docs/prd/` 供 M1–M5 切片依序分解）
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- 验证命令与结果：
  - `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .`：2 份文档全部通过
  - `node scripts/dev/preflight.mjs`：31 项读数，0 项失败
  - `node scripts/dev/gap-coverage.mjs`：19 条全覆盖
  - `node scripts/compose-agents.mjs . --check` & `node scripts/equip.mjs . --check` & `node scripts/sync-toc.mjs README.md README.en.md --check`：全部退出码 0
  - `node scripts/review.mjs .`：0 个「缺」，0 个 `staleTddPaths`
  - `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .`：0 critical/high/medium
  - `node scripts/dev/fixtures.mjs`：132 项通过，0 失败
  - `node scripts/dev/verify-injections.mjs --jobs 6`（经洁净沙盒副本运行）：58 条判据全部拦截（退出码 0）
- 遇到的问题与回避方式：
  - 在 `.worktrees/impl-m0-v7-prd-tdd` 内直接运行 `scripts/dev/verify-injections.mjs` 时，命中已有 Bug（`COPY_SKIP` 正则误将父路径中的 `.worktrees` 当跳过目录导致拷贝空树）；本次 M0 先在洁净沙盒副本实证全通过，并在 M1 切片根治 `verify-injections.mjs` 相对路径过滤与 `fixtures.mjs` 子进程并发隔离。
