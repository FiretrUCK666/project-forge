---
kind: todo
title: v9 Stage B 规划修订：LoopForge A1-A7、前缀标签、Milestone、停损对齐与零提示词盲测
status: done
created: 2026-11-19
updated: 2026-11-19
issue: 83
pr: null
branch: feat/docs-v9-正式纳入-loopforge-a1-a7-标签前缀-milestone-停损对齐与零提示词盲测
owner: FiretrUCK666
approved: false
done_at: 2026-11-19
task_id: v9-plan-amend
planned_at: c18f5344208203c06d82b906aa273f603b85c62e
related_prd: null
related_spec: null
---

# v9 Stage B 规划修订：LoopForge A1-A7、前缀标签、Milestone、停损对齐与零提示词盲测

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-19` / `2026-11-19` |
| 分支 / 基线 | `feat/docs-v9-正式纳入-loopforge-a1-a7-标签前缀-milestone-停损对齐与零提示词盲测` @ `c18f534` |
| 任务编号 | `v9-plan-amend` |
| 负责人 / 审批 | `plan-w345` / `false` |
| 关联 Issue / PR / SPEC | `#83` / 未关联 / 仅关联本规划修订收口清单（总控 PRD 与 `B3..B5` 切片文档保留于 `docs/`） |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交；本 Todo 仅用于 Issue `#83` 规划修订 PR 自身 `finalize` 归档。

## 任务范围与验证基准

- **影响路径**：`docs/prd/261118-v9-stageb-adaptive-architecture-prd.md`、`docs/specs/261118-issue73-b3-local-issue-backend-spec.md`、`docs/specs/261118-issue74-b4a-heterogeneous-survey-spec.md`、`docs/specs/261118-issue75-b4b-escalation-stoploss-closure-spec.md`、`docs/specs/261118-issue76-b5-e2e-blind-run-gate-spec.md`、`docs/todo/261118-issue73-b3-local-issue-backend-todo.md`、`docs/todo/261118-issue74-b4a-heterogeneous-survey-todo.md`、`docs/todo/261118-issue75-b4b-escalation-stoploss-closure-todo.md`、`docs/todo/261118-issue76-b5-e2e-blind-run-gate-todo.md`
- **复用既有模块**：`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`（`checkMasterPrdCoverage`、`checkOrphanSlices`）、`kit/skills/lib/doc-shape.mjs`
- **本期不做**：不修改任何 `.mjs` 业务源码、模板或现有代码测试夹具；不触碰 PR `#82` 文件；不提前归档总控 PRD 或 `#73..#76` 切片规划文档
- **门型与回滚路径**：`two-way`；本 PR 仅涉及 `docs/` 规划文档，提交前可重置工作树，合入后可单次 `git revert` 回退
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 总控 PRD 标记已合入 PR `#81`（`C1..C3`）与 PR `#82`（`C4..C6`）为 `[x]`，同步 `scripts/survey.mjs`（`758` 行）等基线与拆分上限，新增 `C20–C23` 并 100% 映射认领至 `B3 (#73)`、`B4a (#74)`、`B4b (#75)`、`B5 (#76)`（保持 Wave 3 `B3 || B4a` 写域零重叠、`B5` 只读调用 `escalation.mjs` 与 `B4b` 全路径对齐）。
- [x] C2: 纳入 LoopForge `A1–A7`、自建站点协议路径解析与 `^[A-Za-z]:/` 排除、Issue/PR 规范工作前缀与四态单表语义标签、按需跨后端 `capabilities.milestones` 与路由可发现性、`review-ledger` 切片 `C*` 隔离与 `check-fault` 自动写入 `faultRecord`、代码与规划共享 3 轮停损锁及全套文档口径对齐、`A6` + E2E 优先 diff 实质根因判断，以及 Zero-Hint 轻模型对照与 `$TMPDIR` 多生态实跑闭环，且 `doc-plan.mjs audit .`、`preflight.mjs`、`fixtures.mjs --domain doc-rules`、`fixtures.mjs --domain doc-depth` 与 `govern-audit.mjs audit . --changed --strict` 全绿。
- [x] C3: 经独立 `critic-w345-r3` 完成 Round 2 `critique-pass` 并通过 `doc-plan.mjs approve` 放行 `#73..#76` 切片 `SPEC`；`flow.mjs finalize --task v9-plan-amend --strict-sync` 仅归档本规划 Todo 至 `docs/archive/todo/`，完整保留总控 PRD 与 `#73..#76` 活跃于 `docs/`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 修订总控 PRD 与 `#73..#76` 切片 `SPEC`/`Todo`，同步 `main@9836906` 并修复独立规划 Critique `#239` 全部 4 点 | `doc-plan.mjs audit .`、`preflight.mjs`、`doc-rules`、`doc-depth`、`govern-audit` 全绿 | Issue `#83` 已建单 |
| 2 | 经 `critic-w345-r3` Round 2 盖章 `critique-pass`，执行 `approve`（`#73..#76` SPECs）并更新归档 `#83` Todo | `flow.mjs finalize --task v9-plan-amend --strict-sync` 仅归档本 Todo，总控 PRD 与 `#73..#76` 保持活跃 | 步骤 1 |
| 3 | 提交全部改动并执行 `flow.mjs verify --task v9-plan-amend --mode gate` 与 `flow.mjs submit --task v9-plan-amend --json` | `verify` 退出 `0` 且 PR 创建并绑定 `#83` | 步骤 2 |

## 断点与遗留决策

- **当前状态**：已完成，无遗留（Master PRD 与 `#73..#76` SPECs 已完成 Round 2 独立 Critique 与 `approve`，仅本 `#83` Todo 随 `finalize` 归档）。
- **待拍板事项**：无
- **下一步第一件事**：无（待独立审查者完成 PR 审查、等待 CI 全绿并合入 `main` 且仅关闭 `#83`）。

## 澄清与补充记录

- （已合并协调者 `#222`/`#224`/`#238`/`#240`/`#242` 与独立 Critique `#239` 全部复核建议）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：独立只读规划评审 `critic-w345-r3` 完成 Master PRD 与 `#73..#76` SPECs Round 2 `critique-pass`；`doc-plan.mjs approve` 已将 `#73..#76` SPECs 转为 `approved`；`doc-plan.mjs audit .`（全部通过）、`node scripts/dev/preflight.mjs`（0 失败 / 34 读数）、`node scripts/dev/fixtures.mjs --domain doc-rules`（16/16）、`node scripts/dev/fixtures.mjs --domain doc-depth`（4/4）、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --strict`（0 finding）全部通过；随后执行 `finalize --strict-sync -> verify --mode gate -> submit`。
- **文档同步检查**：总控 PRD、`#73..#76` 四组切片 `SPEC + Todo` 均保持活跃于 `docs/`，仅本 `#83` 规划收口 Todo 归档至 `docs/archive/todo/`；未修改任何业务源码与 `docs/archive/` 历史文件。
- **遗留问题**：无
