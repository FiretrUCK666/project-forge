---
kind: todo
title: v9 B4b：纯调度、分级建单、双侧 3 轮停损与 1:N 总控 PRD 自动收口
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 75
pr: null
branch: null
owner: "plan-stage-b"
approved: false
done_at: null
task_id: b4b-escalation-stoploss-closure
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_spec: ../specs/261118-issue75-b4b-escalation-stoploss-closure-spec.md
---

# v9 B4b：纯调度、分级建单、双侧 3 轮停损与 1:N 总控 PRD 自动收口

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | 待启动 Wave 4 认领 @ `0aa2068` |
| 任务编号 | `b4b-escalation-stoploss-closure` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#75` / 未关联 / [B4b SPEC](../specs/261118-issue75-b4b-escalation-stoploss-closure-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC；启动前确认 Wave 3（`B3` `#73` 与 `B4a` `#74`）均已合入 `main`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/escalation.mjs` (new)、`kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/task-backend.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/local-issues.mjs` (new)、`scripts/lib/platform/registry.mjs`、`scripts/lib/platform/github.mjs`、`scripts/lib/platform/github-client.mjs`、`kit/skills/dev-plan/scripts/doc-audit-helpers.mjs` (new)、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-batch.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs` (new)、`kit/skills/dev-flow/scripts/flow-trial-merge.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-sync.mjs` (new)、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-govern/scripts/govern-state.mjs`、`SKILL.md`、`templates/agents-project.md`、`references/collaboration.md`、`references/docs-set.md`、`README.md`、`README.en.md`、`AGENTS.md`、`scripts/dev/injections-data-workflow.mjs`、`scripts/dev/fixtures-stageb-loop.mjs` (new)
- **复用既有模块**：`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/signals.mjs`、`kit/skills/lib/task-backend.mjs`、`kit/skills/lib/platform-probe.mjs`
- **本期不做**：不改动 `review-gates.mjs` / `review-empirical.mjs` 通用 E2E 门禁（留待 Wave 5 `B5`）；不触及 `Dev Profile` 7 键名
- **门型与回滚路径**：`one-way`；合入前丢弃分支，合入后单提交 `git revert` 并重跑 `compose-agents.mjs .` 与 `equip.mjs .`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C11: 固化主会话薄上下文纯调度、`flow-batch`/`workflow-policy` 默认并行优先扫描就绪 `docs/specs/*.md` 并输出 `parallelDispatch: true`（`Wave 1 >= 2` 且不压回 `--task firstTask`）、`flow-next`/`doc-plan` 单一 `[NEXT STEP]` 输出，并对齐 `references/collaboration.md`/`kit/skills/dev-flow/SKILL.md`/`review-ledger.mjs`/`flow.mjs` 中 `git rebase --continue`/`git merge` 非交互保护。
- [ ] C12: 交付 `kit/skills/lib/escalation.mjs` (new) 统一分级建单路由（含远端 `probeForWrite`），接管 `govern-state.mjs` 与 `review-ledger.mjs`。
- [ ] C13: 实现 `review-locks.mjs` `checkDistinctRoundReviewer` 全历史换人锁（`BLOCKED_SAME_REVIEWER_REREVIEW`）、`flow-next.mjs` `excludedReviewers` 与结构化 `stopLossPacket`。
- [ ] C14: 在 `critique-rounds.mjs`、`doc-plan.mjs` 与 `doc-audit.mjs` 补齐 `critique-reject`/`critique-override`、全历史换人、同 SHA 锁与 3 轮停损升级，同步更新 `injections-data-workflow.mjs` (`I64`/`I78`)。
- [ ] C19: 在 `doc-substantive.mjs` 交付单源 `evaluateMasterPrdClosureState` 接入 `docs.mjs` 与 `flow-lifecycle`（`finalize` + `verify`），实现 `1:N` 总控 PRD 确定性四态收口与并行后重跑幂等归档，在 `fixtures-stageb-loop.mjs` 跑通正反双向用例。
- [ ] C22: 交付 `C22` 六项闭环增强：`A4/A5`（`artifact_baseline` 防空转、`flow-trial-merge` 有界冲突提取与恢复包）、Issue/PR 统一工作前缀（含 `Case 1 -> docs:`）与四态单表语义标签（`in-progress` / `in-review` / `changes-requested` / `reviewed`）、`low` 风险 PR 可选 `review-pack record`、`review-gates`/`review-ledger` 切片 `C*` 隔离与 `check-fault` 自动 `faultRecord`、按需跨后端 `capabilities.milestones`（`GitHub` 直连、`local-only` 持久存储且 `migrate` 带出、`generic-git` 本地分组映射并输出可直接照单配平台的结构化清单）与 `AGENTS.md`/`SKILL.md` `milestone`/裸链接可发现性入口，以及双侧复用共享 3 轮硬停损校验器并同步对齐 `kit/skills/dev-plan/SKILL.md`、`README.md`、`README.en.md`、`templates/agents-project.md`、`references/collaboration.md` 与 `references/docs-set.md`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 拆出 `doc-audit-helpers.mjs` (new)、`escalation.mjs` (new) 与扩展 `critique-rounds.mjs`（含双侧共享 3 轮停损锁），降妥 4 紧文件行数，同步 `injections-data-workflow.mjs` (`I64`/`I78`) 并核验 `write-probe-audit` | `node scripts/dev/preflight.mjs` 与 `verify-injections.mjs --only I64 --only I78 --only I58` 通过 | `#73`、`#74` 已合入 `main` |
| 2 | 在 `doc-substantive.mjs` 实现 `evaluateMasterPrdClosureState` 对接 `docs.mjs`/`flow-lifecycle` 并落地 `C11`（含就绪 SPEC 并行分波）、`C12–C14`、`C19` 与 `C22`（`A4/A5`、前缀/标签、可选 `low` 记录、切片 `C*`/`faultRecord`、按需 Milestone、共享停损） | `fixtures-stageb-loop.mjs` 正反用例由红转绿 | 步骤 1 |
| 3 | 对齐 `kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-flow/SKILL.md`、`README.md`、`README.en.md`、`templates/agents-project.md`、`references/collaboration.md` 与 `references/docs-set.md` 停损口径及 `milestone`/裸链接入口，运行 `compose-agents.mjs .` 与 `equip.mjs .`，确认 `AGENTS.md < 24576 B`、`SKILL.md <= 180` 行且全量 `merge-gate` 全绿 | 全量门禁与 `sync-toc --check` 全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `docs.mjs` 修改破坏 `I58` 故障注入字符串匹配或超 800 行 | 改写 `isSharedMasterPrd` 函数签名或塞入过多逻辑 | 原位保留 `isSharedMasterPrd` 函数体，核心图判断放 `doc-substantive.mjs` 并控制 `docs.mjs <= 755` 行 |
| `AGENTS.md` 渲染体积触及 `24576 B` 预警线 | 在模板新增过多纯调度/停损长段描述 | 合并重复长句、具体流程与报错码下沉 `references/collaboration.md` |

## 回滚预案

- **出问题时的第一步**：用 `git diff` 核对涉及门禁与 `docs.mjs` 的精准改动段。
- **回滚用什么**：`git revert` 反向提交并重跑 `compose-agents.mjs .`、`equip.mjs .` 与 `verify-injections.mjs`。
- **回滚之后要做什么**：在 `#75` 评论保留触发失败的归档状态或停损快照。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 独立代码审查人 | 按 `C11–C14`、`C19` 逐条核验双侧停损与自动收口实证并合入 | Wave 4 `submit` 后 | `review` 子代理 |

## 断点与遗留决策

- **当前状态**：`待 Wave 4 启动`（依赖 `#73`、`#74` 先行合入）
- **待拍板事项**：无
- **下一步第一件事**：Wave 4 启动后执行 `flow.mjs start --task b4b-escalation-stoploss-closure --issue 75 --case 4` 进入 `.worktrees/impl-b4b-escalation-stoploss-closure`。

## 澄清与补充记录

- （已合入 `C19` 确定性四态闭环及「并行切片 A 先合入后，已归档自己 `SPEC/Todo` 的兄弟 B 经 `sync` 追平可幂等重跑 `finalize` 收口总控 PRD」设计）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
