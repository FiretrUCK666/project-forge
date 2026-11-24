---
kind: todo
title: Phase 3A PR-A 实施清单：工作流、规划隔离、交接瘦身与单一依赖图
status: done
created: 2026-11-20
updated: 2026-11-21
issue: 120
pr: null
branch: feat/w25-parallel-dispatch
owner: impl-pra
plan_mode: interactive
approved: false
done_at: 2026-11-21
task_id: w25-parallel-dispatch
planned_at: null
related_prd: ../../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue120-w25-parallel-dispatch-spec.md
depends_on: []
scope_files: [kit/skills/dev-flow/scripts/flow.mjs, kit/skills/dev-flow/scripts/flow-inspect.mjs, kit/skills/dev-flow/scripts/flow-next.mjs, kit/skills/dev-flow/scripts/flow-batch.mjs, kit/skills/dev-flow/scripts/flow-cleanup.mjs, kit/skills/dev-flow/scripts/flow-merge.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-flow/scripts/flow-explore.mjs, kit/skills/dev-flow/SKILL.md, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-plan/scripts/doc-plan-ops.mjs, kit/skills/dev-plan/scripts/doc-audit.mjs, kit/skills/dev-plan/SKILL.md, kit/skills/dev-review/scripts/review-sync.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-ledger.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-govern/scripts/govern-state.mjs, kit/skills/lib/ledger.mjs, kit/skills/lib/plan-sync.mjs, kit/skills/lib/critique-rounds.mjs, kit/skills/lib/plan-exit-gate.mjs, kit/skills/lib/doc-substantive.mjs, kit/skills/lib/handoff-package.mjs, kit/skills/lib/workflow-helpers.mjs, kit/skills/lib/workflow-policy.mjs, kit/skills/lib/workflow-policy-next.mjs, kit/skills/lib/doc-slice-graph.mjs, kit/skills/lib/escalation.mjs, kit/skills/lib/signals.mjs, kit/skills/lib/exit-codes.mjs, scripts/dev/fixtures.mjs, scripts/dev/verify-injections.mjs, scripts/dev/e2e-zip-harness.mjs, scripts/dev/fixtures-parallel-dispatch.mjs, scripts/dev/fixtures-flow-explore-gate.mjs, scripts/dev/fixtures-doc-depth.mjs, scripts/dev/fixtures-doc-closure.mjs, scripts/dev/fixtures-doc-rules.mjs, scripts/dev/fixtures-plan-wave-slices.mjs, scripts/dev/injections-data-flow-explore.mjs, scripts/dev/injections-data-gates.mjs, scripts/dev/injections-data-parallel-dispatch.mjs, ".agents/skills/**", AGENTS.md]
---

# `w25-parallel-dispatch` 实施 Todo（Issue `#120`）

> 对应 SPEC：[Phase 3A PR-A SPEC](../specs/261120-issue120-w25-parallel-dispatch-spec.md)
>
> **基线**：`85e5f9d`。本切片无前置，可立即开工。

## 一、要做什么

<!-- section: goal -->
在隔离 worktree 完成 PR-A 七项治本改造：

- **规划隔离与远端同步**：`flow start --planning` / `doc-plan init --worktree` 隔离起草并平滑转入实施；新增 `kit/skills/lib/plan-sync.mjs` (new) 统一经 `createTaskBackend()` + `capabilities` 同步进度与标签（无远端报 `NOT_APPLICABLE`）。
- **账本内审与去棘轮**：Critique 历史迁入单任务账本、`plan-exit-gate.mjs` 改严格白名单（存在 `sha` 必强校，无 `sha` 历史 `passed` 兼容带告警）、拆分 `critique-continue` 与 `critique-override`、修缺 frontmatter 空操作与 PRD 状态；删除 `DOC_REGRESSION_ANCHOR_LOST` 并维持 3 轮停损。
- **全局视图、瘦身交接、拆模块与单一依赖图**：实现 `flow status --all`；拆出 `kit/skills/lib/workflow-policy-next.mjs` (new)；重建 `handoff-package.mjs`；波次/依赖收口到 `doc-slice-graph.mjs` 并支持 `serial-by-overlap`；补全外部 PR 入站、多目标逐条 `try/catch`、折叠 `BLOCKED_NOT_EXPLORED`（含下游夹具、`review-gates.mjs` 与 `I149`/`I240–I244`）、`signals.jsonl` 隔离过滤、`--jobs` 透传与 `I350–I361`。

## 二、不做什么

<!-- section: non-goals -->
不触碰 Phase 3B 专属模块（`git-status-fast.mjs`、`git-fast.mjs`、`bench.mjs`、`evidence.mjs`、`protocol.mjs`、`verify-tools.mjs`、`feature-map.json`、`govern-checks.mjs`、`govern-retro.mjs`、`flow-context.mjs`、`doc-locate.mjs`）及 `#103` 文档；不向 `task-backend.mjs` 净增行数；不改缺写域保守串行判据、并行阈值与拓扑核心；不加跳过门禁开关；不新建 `collab/*.json` 文件；不硬编码平台名；不碰 `docs/archive/`。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [x] **T1（`C1` 规划隔离 worktree）**：`flow.mjs` 与 `flow-inspect.mjs` 支持 `start --planning --task`，`doc-plan.mjs` 支持 `init --worktree`，`ledger.mjs` 与 `workflow-policy-next.mjs` (new) 支持 `planning` 状态及过审后复用同一 worktree 转入实施。
- [x] **T2（`C2` 规划期 `TaskBackend` 同步）**：新增 `kit/skills/lib/plan-sync.mjs` (new)，接入 `doc-plan.mjs` 的 `init` / `critique-reject` / `critique-pass` / `stop-loss` / `approve`，带幂等键 `taskId + phase + round`，`github` 写精简评论与状态标签（PR 防刷屏），`local-only`/`generic-git` 写本地日志并报 `NOT_APPLICABLE`（`task-backend.mjs` 零净增）。
- [x] **T3（`C3` 账本态 Critique 与白名单门禁）**：`critique-rounds.mjs` 迁入账本存储并兼容旧 Frontmatter 回读、停损后允许继续写入意见、落盘/回读失败显式抛错、拆分 `critique-continue` 与 `critique-override`、修缺 frontmatter 空操作；`plan-exit-gate.mjs` 改严格白名单（存在 `sha` 强校一致，无 `sha` 历史 `passed` 带告警兼容）且 `formatPlanExitGate` 输出 `warnings`，对齐 `scripts/dev/fixtures-doc-rules.mjs:635`；`doc-audit.mjs` 的 PRD 补 `superseded` 且 PRD `critique-pass` 不误提示 `approve`。
- [x] **T4（`C4` 砍掉棘轮与理性化规划）**：删除 `doc-substantive.mjs` 的 `DOC_REGRESSION_ANCHOR_LOST`（保留结构节非空与冻结 `C1..Cn`），`doc-audit.mjs` 对 SPEC 超 380 行给软提示，Case 3 不跑多轮换人 Critique，维持 `PLAN_STOP_LOSS_MAX_ROUNDS = 3` 对齐 `fixtures-escalation-stoploss.mjs`；更新 `scripts/dev/fixtures-doc-depth.mjs`。
- [x] **T5（`C5` 全局视图、模块拆分与交接包重建）**：拆出 `kit/skills/lib/workflow-policy-next.mjs` (new) 将 `workflow-policy.mjs` 压降至约 540 行；`flow.mjs` 与 `flow-cleanup.mjs` 新增 `status --all [--json]`；重建 `handoff-package.mjs`（注入真实 `mustFix`/`shouldFix`/`blockers`、`scope_files`、修非目标吞节与设计节正则、内嵌 5 行极简回执模板及详报落账本/评论与 15 行回报约束）；消除 `flow-inspect.mjs` 重复输出 `formatPlanExitGate`。
- [x] **T6（`C6` 单一三态依赖图）**：删除 `workflow-helpers.mjs` 分裂正则/字面波次逻辑，收口到 `doc-slice-graph.mjs`（归档前置满足、未就绪 `depends_on` 不静默丢弃、写域重叠 `serial-by-overlap` 不报假错 `BLOCKED_SLICE_OVERLAP`、`workflow-policy-next.mjs` (new) `needs-*` 可见并行切片）；更新 `scripts/dev/fixtures-plan-wave-slices.mjs`。
- [x] **T7（`C7` 入站/多目标/折叠探索/信号/并发）**：`flow-inspect.mjs` 外部 PR 写受理评论与 `external-contribution` 标签并继承 SPEC `issue:`；`flow-merge.mjs` 与 `review-sync.mjs` 逐条 `try/catch` 落账本禁 `.some()` 吞错；审查完成强校 `review-pack record`；`escalation.mjs` 默认自动建单；折叠 `BLOCKED_NOT_EXPLORED` 并同步 `kit/skills/dev-review/scripts/review-gates.mjs`、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/fixtures-doc-closure.mjs`、`scripts/dev/fixtures-flow-explore-gate.mjs`、`scripts/dev/injections-data-gates.mjs`（`I149`）与 `scripts/dev/injections-data-flow-explore.mjs`（`I240–I244`）；`signals.jsonl` 隔离作用域与 `govern-state.mjs` 仅聚类 `severity >= medium`；支持 `--jobs N` 与 `verify-injections.mjs --only` 逗号多 ID。
- [x] **T8（夹具、注入与体积同步）**：新增 `scripts/dev/fixtures-parallel-dispatch.mjs` (new) 与 `scripts/dev/injections-data-parallel-dispatch.mjs` (new)（`I350–I361`）；逐文件核对全仓 `.mjs <= 800` 行；同步 `kit/skills/dev-flow/SKILL.md` / `kit/skills/dev-plan/SKILL.md`，执行 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .`（`AGENTS.md < 24576` 字节）。

## 四、验收与合前检查

- [x] `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit docs/archive/specs/261120-issue120-w25-parallel-dispatch-spec.md --json` 返回 `ok: true`。
- [x] `node scripts/dev/fixtures.mjs --domain parallel-dispatch --jobs 6` 全绿（覆盖 `C1..C7` 正反双向断言）。
- [x] `node scripts/dev/verify-injections.mjs --only I149,I240,I241,I242,I243,I244,I350,I351,I352,I353,I354,I355,I356,I357,I358,I359,I360,I361 --jobs 6` 全部命中变红通过。
- [x] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs --jobs 6 && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs .` 全绿，全仓 `.mjs <= 800` 行且 `AGENTS.md < 24576` 字节。

## 完成后的记录

- **在合并之前写完**：完成 `C1–C7` 全部改造并同步 `equip.mjs .`、`compose-agents.mjs .` 与 `docs/TDD.md`（新增 `workflow-policy-next.mjs` 与 `plan-sync.mjs`，`task-backend.mjs` 零净增，全仓 `.mjs <= 800` 行，`AGENTS.md` 22477 字节）。
- **验证摘要**：`fixtures.mjs --jobs 6` 394/394 通过、`verify-injections.mjs --jobs 6` 306/306 命中变红、`preflight.mjs` 39/39 通过、`gap-coverage.mjs` / `compose-agents.mjs . --check` / `equip.mjs . --check` / `review.mjs .` / `edit-gate.mjs` / `govern-audit.mjs` 全绿。
