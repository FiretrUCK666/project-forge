---
kind: todo
title: 核心状态完整性与工作流闭环加固
status: draft
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/conv-arch-plan
owner: planner-conv-arch
plan_mode: interactive
approved: false
done_at: null
task_id: core-state-integrity
planned_at: 6416a330632fa28180080e3ad87f825c49724caf
related_prd: ../prd/261124-conversational-state-machine-prd.md
related_spec: ../specs/261124-core-state-integrity-spec.md
depends_on: []
scope_files:
  - kit/skills/dev-plan/scripts/doc-plan-ops.mjs
  - kit/skills/lib/critique-store.mjs
  - kit/skills/lib/critique-rounds.mjs
  - kit/skills/lib/critique-diff.mjs
  - kit/skills/lib/plan-next.mjs
  - kit/skills/dev-flow/scripts/flow-sync.mjs
  - kit/skills/dev-flow/scripts/flow-merge.mjs
  - kit/skills/dev-flow/scripts/flow-cleanup.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle.mjs
  - kit/skills/dev-flow/scripts/flow-inspect.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs
  - kit/skills/dev-flow/scripts/flow-start-helpers.mjs
  - kit/skills/dev-explore/scripts/repo-map.mjs
  - kit/skills/dev-review/scripts/review-pack.mjs
  - kit/skills/dev-review/scripts/review-diff.mjs
  - kit/skills/dev-review/scripts/review-ledger.mjs
  - kit/skills/dev-review/scripts/review-locks.mjs
  - kit/skills/dev-review/scripts/review-empirical.mjs
  - kit/skills/lib/criteria-lock.mjs
  - kit/skills/lib/handoff-package.mjs
  - scripts/dev/fixtures*.mjs
---

# 核心状态完整性与工作流闭环加固

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/conv-arch-plan` @ `6416a33` |
| 任务编号 | `core-state-integrity` |
| 负责人 / 审批 | planner-conv-arch / `false` |
| 规划态 | `interactive`（全部核心决策已拍板确认） |
| 关联 Issue / PR / SPEC | `#169` / 未关联 / `docs/specs/261124-core-state-integrity-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/specs/261124-core-state-integrity-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/lib/critique-store.mjs`、`kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/critique-diff.mjs`、`kit/skills/lib/plan-next.mjs`、`kit/skills/dev-flow/scripts/flow-sync.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`、`kit/skills/dev-flow/scripts/flow-start-helpers.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-review/scripts/review-diff.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/lib/criteria-lock.mjs`、`kit/skills/lib/handoff-package.mjs`。
- **复用既有模块**：`kit/skills/lib/git.mjs`（`withFileLockSync`、`writeJsonAtomic`）、`kit/skills/lib/ledger.mjs`（`updateTaskLedger`）、`kit/skills/lib/workflow-policy.mjs`（`resolveEffectiveBaseSha`）、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`（`checkTaskSlotBoundaryOrEmit`）。
- **本期不做**：不改 `session-state.mjs` v2、不建 `mutability.mjs`、不改 CLI 规范参数与 `SKILL.md` 体积门禁。
- **门型与回滚路径**：`one-way`；出现回退通过 `git revert` 反向提交还原，不改写远端历史。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C1: 修复 `doc-plan-ops.mjs`（`clarifyDoc` 同步更新 `## 待拍板问题`、`approveSpec` 放行 `critique-continue` 后再 `critique-pass`）、`critique-store.mjs`（`commondir` 侧车、账本/sidecar 合并、`persistPlanCritiqueEntry` 加锁）及 `critique-rounds.mjs` / `critique-diff.mjs` / `plan-next.mjs`（`fromSha` + `roundBaseline`、`continued.active=false` 清理、按 `roundBaseline` 算停损、`continued.reason` 入 R2 作用域、撤销 `approved`、编辑期保留 `continueActive`），通过 `node scripts/dev/fixtures.mjs`。
- [ ] C2: 修复 `flow-sync.mjs`（clean rebase 清 `queueConflict` 并刷 `finalizedHead`，卸载传 `mountedPaths`）、`flow-merge.mjs`（`callerActor` 含 `opts['reviewer-id']` 阻断自合）、`flow-cleanup.mjs`（`handleAbort` 传 `remoteUrls`、校分支删除退出码、清残留）、`flow-lifecycle.mjs`（本地 `lastSubmittedHead` 与 `handleVerify` 槽位检查）、`flow-inspect.mjs`（`in-place` 复用）及 `repo-map.mjs`（`updateTaskLedger` 原子更新），通过 `node scripts/dev/fixtures.mjs`。
- [ ] C3: 修复 `review-pack.mjs` / `review-diff.mjs` / `review-ledger.mjs` / `review-locks.mjs` / `review-empirical.mjs`（`--include-diff` 与 `record` 钉住 `review-<id>` 及已审 `headSha`、卸载传 `mountedPaths`、`evaluatePassBlockers` 用 `resolveEffectiveBaseSha`、`faultRequired` 强制 `check-fault:fail`/`restore`），通过 `node scripts/dev/fixtures.mjs`。
- [ ] C4: 修复 `criteria-lock.mjs` / `flow-lifecycle-finalize.mjs` / `flow-start-helpers.mjs` / `handoff-package.mjs`（归档重绑 `criteriaFrozenFrom`、启动回填 `criteriaFingerprint`、删死字段 `frozenCriteriaSnapshot`、`submit` 与 `review-pack record` 强制 `checkFrozenCriteria`、`buildHandoff` 渲染上下文与动态 `--section` 及 `smoke-verify`），通过 `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/preflight.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先补 C1-C4 正反失败回归测试（Red） | `node scripts/dev/fixtures.mjs` 复现失败 | 无 |
| 2 | 修复规划澄清、Critique 存储与轮次状态机（C1） | `node scripts/dev/fixtures.mjs` 对应组转绿 | 步骤 1 |
| 3 | 修复 Flow 同步、合入、Abort、Verify 与 Repo-Map（C2） | `node scripts/dev/fixtures.mjs` 对应组转绿 | 步骤 2 |
| 4 | 修复 Review 槽位钉住、基线、故障注入及 Criteria/Handoff（C3-C4） | `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs` 全绿 | 步骤 3 |
| 5 | 同步 `node scripts/equip.mjs .` 与全量门禁验证 | `node scripts/dev/merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `review-<id>` 钉住导致部分旧测试依赖自动同步 `impl-<id>` | 测试脚本未显式推进 `review-<id>` | 检查并更新对应测试步骤，保持真实审查隔离语义 |

## 回滚预案

- **出问题时的第一步**：`git revert <commit-sha>` 回退对应改动并重跑 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` 复核。
- **回滚之后要做什么**：保留失败复现 fixture 并记录回退原因至关联 Issue `#169`。

## 断点与遗留决策

- **当前状态**：`draft`（待 SPEC 经独立 Critique 并 `approve` 后启动 Wave 1 实施）
- **待拍板事项**：无
- **下一步第一件事**：对 `docs/specs/261124-core-state-integrity-spec.md` 执行 `doc-plan.mjs audit` 并移交独立 Critic 评审。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
