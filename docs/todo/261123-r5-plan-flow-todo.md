---
kind: todo
title: Round-5 规划连续性与协作门禁架构收敛
status: active
created: 2026-11-23
updated: 2026-11-23
issue: null
pr: null
branch: feat/r5-plan-flow
owner: planner-r5-pr1
previous_owners: [impl-r5-pr1]
plan_mode: autonomous
approved: false
done_at: null
task_id: r5-plan-flow
planned_at: b9b4bd6be8689da28e717c1657c54ec151841bac
related_prd: null
related_spec: null
owner_changed_reason: separate planner from implementer
owner_changed_at: 2026-11-23
---

# Round-5 规划连续性与协作门禁架构收敛

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-23` / `2026-11-23` |
| 分支 / 基线 | `feat/r5-plan-flow` @ `b9b4bd6` |
| 任务编号 | `r5-plan-flow` |
| 负责人 / 审批 | impl-r5-pr1 / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/plan-next.mjs` (new)、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/lib/pending-decisions.mjs`、`kit/skills/lib/doc-frontmatter.mjs`、`kit/skills/lib/session-state.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/lib/workflow-policy-next.mjs`、`kit/skills/lib/workflow-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`scripts/dev/fixtures-r5-plan-flow.mjs` (new)
- **复用既有模块**：`evaluatePlanExitGate` / `resolveApprovalBasis`（`plan-exit-gate.mjs`）、`buildCritiqueScope` / `collectExcludedReviewers` / `readPlanCritiqueEntrySync`（`critique-rounds.mjs`）、`buildContextBrief`（`context-brief.mjs`）、`buildSliceGraph`（`doc-slice-graph.mjs`）、`analyzePendingDecisions`（`pending-decisions.mjs`）。
- **本期不做**：PR 2（自适应 800 行分类与反作弊/跨语言 `govern-tests`）与 PR 3（`.gitignore` / `feature-map` / `handoff` 深目录 / RAT 许可头）。
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: `doc-plan next --handoff --json` 与 `flow next --handoff`（`planning` 态）共享 `evaluatePlanNextState()`（`kit/skills/lib/plan-next.mjs`），在主仓/隔离 worktree/`privateDocsDir` 及 `1:N` 总 PRD + 切片下输出确定性 `phase`、`ownerRole`、写手优先续聊（`planner`/`implementer`）vs 复审强制换新（`critic`/`reviewer`）、中断工作位接管指引，以及 3 态人工审批分流（含 `--plan-only` 团队异步交付）。
- [x] C2: `commits > 0` Git 仓库默认分支下 `doc-plan init`（非 `tdd` 且未传 `--in-place`）默认落盘独立规划 worktree（不直写 `main`/`master`）；显式传 `--in-place` 时仍允许本地写入（兼容既有单仓测试）。
- [x] C3: `pending-decisions.mjs` 拦截 `仍待你拍板` / `仍待拍板` / `待确认` 变体及正文/表格中未消解的 `仍待定` / `待拍板` / `待确认` / `TBD`；`stripCritiqueMeta` 剥离文档正文的元信息概览表与 `finalize` 归档改链，使已批准并归档的 SPEC 复检 `doc-plan audit` 仍可通过；已 `done` 或位于 `docs/archive/` 的 Todo 不再误输出 `flow start` 下一步；`kit/skills/dev-plan/SKILL.md` 明示本地优先、禁止非请求外网 `webfetch`。
- [x] C4: `workflow-policy-next.mjs` 与 `workflow-helpers.mjs` 在 `contributor-fork` 进入 `awaiting-upstream-merge` 之前先校验 `independentReviewRequired !== false && !reviewCoversHead`；高/中风险 fork 分支强制先走 `needs-review`。
- [x] C5: `session-state.mjs` 与 `flow-inspect.mjs` 按任务 `taskId`/`slug`（与指纹/完成态）隔离 `triage` 记录，无关新任务（Case 2）不被历史已完/另一任务的 `Case 4` 误阻断 `BLOCKED_TRIAGE_DOWNGRADE`。
- [x] C6: `flow.mjs submit` 在 `generic-git` 不可达远端或传 `--offline` 时支持延迟推送降级，同步本地 `review-<taskId>` 工作位并推进至 `submitted` 供本地独立审查，同时在 `merge` 继续硬锁 `--remote-merged`。
- [x] C7: 正反双向夹具覆盖 `C1..C6` 全部分支，`node scripts/equip.mjs . --check` 与全部全仓门禁通过，经独立 `gemini-4-hydrogen-high` 双门+两阶段故障注入审查通过。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 新增 `plan-next.mjs` 并接入 `doc-plan next` 与 `flow next` | 正反夹具覆盖状态恢复/1:N/Plan-Only/中断接管 | 无 |
| 2 | 修复 `doc-plan init` 默认 `--worktree`、`pending-decisions`、`stripCritiqueMeta`、done 归档提示与 `kit/skills/dev-plan/SKILL.md` | 正反夹具 + `subcommand-parity` | 步骤 1 |
| 3 | 修复 `contributor-fork` 审查优先级、`triageByTask`、与 `generic-git` 离线 `submit` | `fixtures --domain r5-plan-flow` + 全仓门禁 | 步骤 2 |
| 4 | 同步 `kit/skills -> .agents/skills`，独立审查+故障注入并合入 PR | `preflight` / `fixtures` / CI 全绿 | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：审计本 Todo 后运行 `flow start`，实现 `kit/skills/lib/plan-next.mjs` 与相关守卫。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：`node scripts/dev/preflight.mjs`（41 项读数 0 失败）；`node scripts/dev/gap-coverage.mjs`（20 条全覆盖）；`node scripts/dev/fixtures.mjs --jobs 6`（487/487 通过，含 `r5-plan-flow` 6 项）；`node scripts/dev/verify-injections.mjs --jobs 4`（388 条全命中）；`node scripts/dev/subcommand-parity.mjs`（6 套 CLI 全通过）；`node scripts/compose-agents.mjs . --check`、`node scripts/equip.mjs . --check`、`node scripts/review.mjs .`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .`（0 critical/high/medium）全通过。
- **文档同步检查**：已同步 `kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-plan/scripts/doc-plan.mjs` 文件头子命令清单与 `.agents/skills/`（`equip.mjs . --check` 141 项校验通过）；全部修改 `.mjs` 文件均 `<= 800` 行且无 `import.meta.dirname`。
- **遗留问题**：无（PR 2 与 PR 3 拆分至独立工作流后续推进）。
