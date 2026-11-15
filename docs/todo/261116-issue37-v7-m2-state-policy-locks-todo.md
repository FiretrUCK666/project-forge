---
kind: todo
title: Milestone 2：L3 状态机、全 Worktree 隔离、三正交策略与六锁防死循环硬拦截
status: active
created: 2026-11-16
updated: 2026-11-16
issue: 37
pr: null
branch: feat/v7-m2-state-policy-locks
owner: FiretrUCK666
approved: false
done_at: null
task_id: m2-state-policy-locks
planned_at: b6a787d286aa674beb0b7e2dc4d5f1920b734536
related_prd: ../prd/261115-v7-workflow-architecture-prd.md
related_spec: ../specs/261116-issue37-v7-m2-state-policy-locks-spec.md
---

# Todo: Milestone 2：L3 状态机、全 Worktree 隔离、三正交策略与六锁防死循环硬拦截

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / 基线 | `feat/v7-m2-state-policy-locks` @ `b6a787d` |
| 任务编号 | `m2-state-policy-locks` |
| 关联 Issue / SPEC / 总控 PRD | #37 / [SPEC](../specs/261116-issue37-v7-m2-state-policy-locks-spec.md) / [PRD](../prd/261115-v7-workflow-architecture-prd.md) |

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/workflow-policy.mjs` (new)、`kit/skills/lib/{shared,docs,doc-templates,git,github-client}.mjs`、`kit/skills/dev-flow/scripts/{flow,flow-inspect,flow-lifecycle,flow-merge,worktree-deps}.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs` (new)、`kit/skills/dev-flow/scripts/flow-trial-merge.mjs` (new)、`kit/skills/dev-review/scripts/{review-pack,review-ledger,review-diff,review-gates}.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs` (new)、`AGENTS.md`、`templates/{agents-project,docs-spec,docs-todo}.md`、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-{flow,review}/SKILL.md`、`docs/TDD.md`、`.agents/skills/`、`scripts/dev/{preflight-contracts,verify-injections,fixtures,fixtures-flow,fixtures-docs,fixtures-govern,fixtures-platform}.mjs`、`scripts/dev/fixtures-m2.mjs` (new)
- **复用既有模块**：`kit/skills/lib/{git,ledger,docs,static-gates,platform,github-client,profile,cli}.mjs`（含扩展既有 `findOpenPrForBranch`）、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-review/scripts/{review-diff,review-gates}.mjs`
- **本期不做**：不提前实现 M3 范围（`batch` 并行多 Worktree 调度 / FIFO 合并队列 / 堆叠 PR `graph`/`--after`/`sync` / `TaskBackend` / `--bootstrap-empty` 重构 / 三层命令嗅探）与 M4（`govern-tests.mjs` 改造 / Fake-Agent E2E 测试台）
- **门型与回滚路径**：`one-way`；异常时 `git revert` 回退并重跑全仓 `merge-gate`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C1: 抽离 `kit/skills/lib/workflow-policy.mjs` (new) 与 `kit/skills/dev-flow/scripts/flow-next.mjs` (new)，实现 `flow.mjs next [--json]`（含 0/多任务态与惰性水合）、`determineWorkflowPolicy`（含 `ownArchived` 豁免）与 `<gitCommonDir>/project-forge-flow/tasks/<taskId>/evidence.json`（拦截 `quick --target` 旁路并强制无 CI 低风险过独立静态门禁），正反双向夹具通过。
- [x] C2: `commits > 0` 全量强制 `.worktrees/impl-*` 隔离（兼容首提交与冲突校验），支持跨轮复用与过期依赖 Junction 自动解绑及 `--reset-review-slot`，正反双向夹具通过。
- [x] C3: 修复 `submit` 推后零跟踪文件变脏、先查 OPEN PR 并套用 PR 模板、`isSharedMasterPrd` 保护 1:N 总控 PRD 不修改亦不被提前归档、`generic-git` 禁本地强合并、`flow-trial-merge.mjs` (new) 临时 `--detach` 试合后推进干净主仓与 `cleanup` 支持 Squash/`MERGED` 安全清本地分支，正反双向夹具通过。
- [x] C4: `kit/skills/dev-review/scripts/review-locks.mjs` (new) 落地六锁 + 收敛四律硬拦截（堵 Round 4 `pass` 绕过历史停损、拒同 `HEAD` 复审、Round 2+ 增量视野硬锁禁未改旧行/无据新刺、修 `stillOpen` 与 `repeatedItems` 误报、`findingsBlocker`、`--pre-existing` 去重与 `--disposition` 校验统计），正反双向夹具通过。
- [x] C5: 统一 `doc-templates.mjs` 与 `templates/`；同步 `AGENTS.md`（`<= 24,576B`）、`templates/agents-project.md`、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-{flow,review}/SKILL.md`（`<= 180L`）、`docs/TDD.md`、`.agents/skills/`（全仓 `.mjs <= 800L`）、`preflight-contracts.mjs`、更新既有回归测试并新增 `fixtures-m2.mjs` (new) 与 `verify-injections.mjs` M2 注入用例，全量 `merge-gate` + `bench.mjs` + `--package` 退出码 `0`。

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`（M2 `C1`–`C5` 实现、文档同步与全量门禁已通过，随本 PR 成对归档至 `docs/archive/`）
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`preflight.mjs` 0 失败（31 项）、`gap-coverage.mjs` 19/19 通过、`fixtures.mjs` 140/140 通过、`verify-injections.mjs` 70/70 全红、`bench.mjs` 6/6 达标、`review.mjs .` `mature`、`govern-audit.mjs audit .` 0 严重/高危。
- **文档同步检查**：已同步 `AGENTS.md`（22,010B）、`templates/agents-project.md`、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-{flow,review}/SKILL.md`、`docs/TDD.md`、`templates/docs-{spec,todo}.md` 与 `.agents/skills/`；1:N 总控 PRD `docs/prd/261115-v7-workflow-architecture-prd.md` 保持 `active`。
- **遇到的问题与回避方式**：`verify-injections.mjs` 捕获 `validateVerificationEvidence` 在 `quick-only` 仓库场景测试空白与 `review-ledger.mjs` 806 行超限，已补充 `quick-only` 正反夹具并将打包展示函数移入 `review-gates.mjs`（全部修改/新增 `.mjs` 均 `<= 800` 行）。
