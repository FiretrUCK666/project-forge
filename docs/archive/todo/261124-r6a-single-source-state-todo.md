---
kind: todo
title: 单源默认分支、任务活性分类与跨平台四态闭环
status: done
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: 162
branch: feat/r6a-single-source-state
owner: plan-r6-arch
plan_mode: interactive
approved: true
done_at: 2026-11-24
task_id: r6a-single-source-state
planned_at: 1853e2257b47936b97aed07377c98d2d7a117bb8
related_prd: ../../prd/261124-r6-arch-hardening-prd.md
related_spec: ../specs/261124-r6a-single-source-state-spec.md
---

# 单源默认分支、任务活性分类与跨平台四态闭环

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/r6a-single-source-state` @ `1853e22` |
| 任务编号 | `r6a-single-source-state` |
| 负责人 / 审批 | plan-r6-arch / `true` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / #162 / `docs/archive/specs/261124-r6a-single-source-state-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/{git-core,git,git-fast,ledger,workflow-helpers,workflow-policy-next,workflow-policy,gate-enforcement,platform,platform-probe,github-parse,task-backend,task-backend-local,task-graph,plan-exit-gate,pr-template-hydrate}.mjs`、`scripts/lib/survey-git-fast.mjs`、`kit/skills/dev-flow/scripts/flow-*.mjs`（不含 `flow.mjs` 与 `flow-lifecycle-finalize.mjs`）、`scripts/dev/fixtures-r6a-state.mjs` (new)、`scripts/dev/injections-data-r6a.mjs` (new)
- **复用既有模块**：`kit/skills/lib/git-core.mjs`、`kit/skills/lib/git.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/task-backend-local.mjs`
- **本期不做**：不清理 `.worktrees/.state/tasks/` 7 个遗留台账；不改 `flow-lifecycle-finalize.mjs`、`handoff-package.mjs`、`flow.mjs` 及切片 B/C/D 专属文件
- **门型与回滚路径**：one-way；`git revert <sha>` 回退。
- **快测命令**：`node scripts/dev/fixtures.mjs --domain r6a-state`

## 验收标准与执行清单

- [x] C1: 单源改造 `resolveDefaultBranch(repoRoot, { strict = true })` 与 `isDefaultBranch`，`createDefaultLedger` 设 `baseBranch: null`，禁止擅自 `update-ref` 建 `main`，下沉唯一 `detectCommitStyle` 至 `kit/skills/lib/git-core.mjs` 由 `survey-git-fast.mjs` 与 `git.mjs` 共用。
- [x] C2: 实现 `classifyTaskLiveness` 过滤 `'merged'` 与缺失工作树孤儿任务使本仓 7 台账下 `flow.mjs next --json` 零误报；在 `flow-next.mjs` 与 `flow-cleanup.mjs` 共用 `collectTaskRuntimeSnapshot`。
- [x] C3: 移除 `flow-merge.mjs` 对 `GenericRemoteBackend.mergePr` 短路；落实 A3 放行独立审查者/调度者执行 `flow.mjs merge`（仍禁实施者自合）；`flow.mjs start` 自动继承已过 `audit` 文档探索凭据。
- [x] C4: 修 `plan-exit-gate.mjs` `'ledgerEntry' in doc` 假阳性、取消跨机缺失 `.git/issues` 死循环、修 Case 3 Todo `--case 4` 硬编码与无活跃任务转 `draft`/PRD、实现 `refs/pf/claims/` CAS 原子认领租约、修 `generic-git + contributor-fork` 与 `claim --takeover`，通过 `fixtures` 与 `verify-injections`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写 `scripts/dev/fixtures-r6a-state.mjs` (new) 复现 `master`-only、7 台账、`ledgerEntry: null`、`generic-git` 短路与并发认领撞车 | `node scripts/dev/fixtures.mjs --domain r6a-state` 必红 | 无 |
| 2 | 改造 `git*.mjs`、`survey-git-fast.mjs`、`ledger.mjs`、`workflow-*.mjs`、`plan-exit-gate.mjs`、`task-backend-local.mjs` | `node scripts/dev/fixtures.mjs --domain r6a-state` 部分转绿 | 步骤 1 |
| 3 | 完成 `flow-*.mjs` 快照收口、A3 合并权、探索继承与 Git-Ref CAS 租约及 `injections-data-r6a.mjs` (new) | `node scripts/dev/preflight.mjs` 与 `verify-injections.mjs` 全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 远端未配置或只读仓推送 `refs/pf/claims/` 租约失败 | `local-only` 或 `clone-readonly` 执行 `claim` | `local-only` 与 `clone-readonly` 跳过远端 `git push` 仅记录本地提示；`contributor-fork` 只读 `upstream` claims |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`
- **待拍板事项**：无
- **下一步第一件事**：完成 `finalize` 归档与提交、执行 `verify --mode full` / `--mode gate` 实证并 `submit` 提 PR。

## 澄清与补充记录

- 已确认（2026-11-24 · user）：A3: 独立审查通过后 `flow.mjs merge` 执行权 -> A3 已拍板：只读独立审查子代理通过 `review-pack record --verdict pass` 后，允许独立审查者或调度者执行 `flow.mjs merge`（强校验 `reviewPassed === true && headSha === reviewPassedHead`，仍严禁实施者自合），由切片 A 落盘门禁并在切片 D 同步文档。

## 完成后的记录

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .`（`checkedFiles: 141, syntaxErrors: [], abiErrors: [], integrityCheck.ok: true`）
  - `node scripts/dev/preflight.mjs`（`0 项失败，41 项读数`）
  - `node scripts/dev/gap-coverage.mjs`（`21 条各有处置`）
  - `node scripts/dev/fixtures.mjs --jobs 6`（`501 项通过，0 项失败`，含 `r6a-state` 4 组正反双向回归用例）
  - `node scripts/dev/verify-injections.mjs --jobs 4`（`395 条判据都能被抓到`，含 `I601..I607`）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --task r6a-single-source-state --json`（`blockers: 0`）
  - 现场实证本仓 7 个遗留台账：`node .agents/skills/dev-flow/scripts/flow.mjs next --task r6a-single-source-state --json` 与 `status --all --json` 均将其归入 `pendingCleanupTasks`，无 `MULTIPLE_ACTIVE_TASKS` / `BLOCKED_NOT_CLAIMED` 污染。
- **文档同步检查**：总控 PRD `docs/prd/261124-r6-arch-hardening-prd.md` 保持活跃未归档；`docs/TDD.md` 与 `SKILL.md` 同步留归 Wave 2 `r6d`。经 `@coordinator` #732 与 #740 裁决授权同步：在 `kit/skills/lib/exit-codes.mjs` 登记 `BLOCKED_MISSING_DEFAULT_BRANCH`/`BLOCKED_SELF_MERGE`；保留 `kit/skills/lib/plan-exit-gate.mjs:283` `'ledgerEntry' in doc` 防绕过检查并优化 `skipped` 分支 `fixHint`；同步 `scripts/dev/injections-data-workflow.mjs`（`I59` 迁至 `task-backend-local.mjs`）与 `scripts/dev/injections-data-core.mjs`（`I48` 补 `alsoPatches` 覆盖 `refs/pf/claims/` CAS 第二防线）。为守单向依赖与 `<= 800` 行边界，`collectTaskRuntimeSnapshot` 落盘于 `kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`。
- **遗留问题**：无；剩余 4 处默认分支白名单与 `docs/TDD.md` / `SKILL.md` 同步由 Wave 2 `r6d` 收口。
