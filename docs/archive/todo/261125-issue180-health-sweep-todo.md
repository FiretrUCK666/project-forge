---
kind: todo
title: 全仓体检四项根因治理与热点盲区补测
status: done
created: 2026-11-25
updated: 2026-11-25
issue: 180
pr: null
branch: feat/health-sweep
owner: planner-health-sweep
plan_mode: autonomous
approved: false
done_at: 2026-11-25
task_id: health-sweep
planned_at: 776fb9a645efc7bc229fe727110711a803560019
related_prd: null
related_spec: null
---

# 全仓体检四项根因治理与热点盲区补测

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / 基线 | `feat/health-sweep` @ `776fb9a` |
| 任务编号 | `health-sweep` |
| 负责人 / 审批 | planner-health-sweep / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #180 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-flow/scripts/flow-merge-claim.mjs`、`kit/skills/lib/verify-state.mjs`、`kit/skills/dev-review/scripts/review-context.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`docs/feature-map.json`、`scripts/dev/fixtures-health-sweep.mjs` (new)、`scripts/dev/injections-data-health-sweep.mjs` (new)
- **复用既有模块**：`kit/skills/lib/doc-slice-graph.mjs`（`buildSliceGraph`）、`kit/skills/lib/verify-state.mjs`（`computeFeatureFingerprint`、`reclaimVerifySlotCache`、`writeVerifyCacheEntry`）、`kit/skills/lib/plan-sync.mjs`（`collectPlanSummaryMeta`、`syncIssueSummaryBody`）、`kit/skills/lib/exec.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/critique-rounds.mjs`
- **本期不做**：不修改外部 CLI 公共参数名、不弱化 `quick-test` / `preflight` 门禁白名单、不重写现有旧夹具断言语义。
- **门型与回滚路径**：`two-way`；局部可逆改动，出现问题执行 `git revert` 并重跑 `node scripts/equip.mjs .` 即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 修复 `kit/skills/dev-flow/scripts/flow-merge-claim.mjs` 中 `evaluateMasterIssueCloseGuard`，排除已属于子切片 SPEC (`s.data?.issue === issNum`) 及非引导切片任务的自身工单，仅在总控 PRD `issue === issNum` 或总控未填 `issue` 且非切片子单时触发关单保护；并通过 Node UTF-8 将 Issue `#176` 底部 `plan-summary` 更新为终态（`SPEC:implemented / TODO:done`、`4/4 已完成（[x] C5..C8）`）。
- [x] C2: 修复 `kit/skills/lib/verify-state.mjs`（`evaluateToolStaleness` 在 `effSlot !== 'main'` 且当前槽位无快照时回退 `cache.slots?.main?.[tool.id] ?? cache.tools[tool.id]`，并保留无 `main` 基线时的 `unbaselined` 行为；新增合并同步函数）、`kit/skills/dev-review/scripts/review-context.mjs`（区分 `unbaselined` 与 `healthyTools`）与 `kit/skills/dev-flow/scripts/flow-merge.mjs` / `flow-cleanup.mjs`（合入后同步已验证槽位至 `main` 并正确回收 `impl`/`review` 槽位缓存），在隔离工作树运行 `verify-tools run --stale --refresh-baseline` 验证后使 `verify-tools audit .` 全绿。
- [x] C3: 消除 `govern-audit reconcile .` 检出的 9 个 `FeatureMap Drift: unmapped` 模块，将其精确归入 `docs/feature-map.json` 对应功能条目，并核实 `doc-plan-clarify.mjs` 与 `mutability.mjs` 已在映射中，使 `govern-audit reconcile .` 报告 `unmapped=0`、`missing=0`。
- [x] C4: 新增 `scripts/dev/fixtures-health-sweep.mjs` (new) 与 `scripts/dev/injections-data-health-sweep.mjs` (new) 并在 `docs/feature-map.json` `testRefs` 登记，覆盖 `evaluateMasterIssueCloseGuard`、`verify-state.mjs` 继承与隔离、`exec.mjs` / `pr-template-hydrate.mjs` / `doc-slice-graph.mjs` / `critique-rounds.mjs` / `flow-cleanup.mjs` 热点边界正反双向断言及故障注入，同步 `node scripts/equip.mjs .` 后全部门禁与夹具全绿通过。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 完善 Todo 并过 `doc-plan audit` 与 `flow start --create-issue` | `doc-plan audit` 退出 0 且工作树账本就绪 | 无 |
| 2 | 先在 `scripts/dev/fixtures-health-sweep.mjs` (new) 补 C1/C2 复现用例验证根因红灯，再修复 `flow-merge-claim.mjs`、`verify-state.mjs`、`review-context.mjs`、`flow-merge.mjs`、`flow-cleanup.mjs` | `node scripts/dev/fixtures.mjs --domain health-sweep` 转绿 | 步骤 1 |
| 3 | 更新 `docs/feature-map.json` 消除 9 个 unmapped 模块并登记 `testRefs`，补齐热点边界测试与故障注入，同步 `equip.mjs .` | `govern-audit reconcile .` `unmapped=0` 且 `verify-tools audit .` 全绿 | 步骤 2 |
| 4 | 在测试通过后修复历史 Issue `#176` 底部 `plan-summary`，执行全量门禁校验与 `finalize` / `verify` / `submit` | 全套门禁、`fixtures --jobs 6`、`verify-injections --jobs 4`、`e2e-zip-harness`、`bench` 全绿 | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`
- **待拍板事项**：无
- **下一步第一件事**：运行 `flow.mjs finalize`、`verify --mode full` 与 `submit`。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：`preflight.mjs`、`gap-coverage.mjs`、`cli-parity.mjs`、`subcommand-parity.mjs`、`exit-code-parity.mjs`、`equip.mjs . --check`、`compose-agents.mjs . --check`、`sync-toc.mjs --check`、`review.mjs .`、`verify-tools.mjs audit .`（22/22 OK）、`govern-audit.mjs audit . --strict`、`govern-audit.mjs reconcile .`（`unmapped=0, missing=0, stale=0`）、`fixtures.mjs --jobs 6`（543/543 通过）、`verify-injections.mjs --jobs 4`（460/460 捕获）、`e2e-zip-harness.mjs`（Scenarios A-L 245 entries 51926ms）、`bench.mjs`（6/6 calibrated unitMs=103ms）、`edit-gate.mjs --final`（0 blockers）全绿通过；历史 Issue `#176` 底部 `plan-summary` 已用 Node UTF-8 刷新为 `SPEC:implemented / TODO:done` 与 `4/4 已完成（[x] C5..C8）`。
- **文档同步检查**：已同步 `docs/TDD.md`、`docs/feature-map.json`、`docs/archive/todo/261125-issue180-health-sweep-todo.md` 与 `.agents/skills/`（`equip.mjs . --check` 字节一致）。
- **遗留问题**：无。
