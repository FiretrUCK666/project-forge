---
kind: todo
title: v9 Wave 0.5：Stage B 总控 PRD 与 B1–B5 切片规划文档入仓
status: done
created: 2026-11-18
updated: 2026-11-18
issue: 77
pr: null
branch: feat/v9-stageb-plan
owner: plan-stage-b
approved: false
done_at: 2026-11-18
task_id: v9-plan
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: null
related_spec: null
---

# v9 Wave 0.5：Stage B 总控 PRD 与 B1–B5 切片规划文档入仓

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | `feat/v9-stageb-plan` @ `0aa2068` |
| 任务编号 | `v9-plan` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#77` / 未关联 / 仅关联本规划收口清单（总控 PRD 与 `B1..B5` 保留于 `docs/`） |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交；本 Todo 仅用于 `Wave 0.5` 规划 PR 自身 `finalize` 归档。

## 任务范围与验证基准

- **影响路径**：`docs/prd/261118-v9-stageb-adaptive-architecture-prd.md` (new)、`docs/specs/261118-issue71-b1-skill-discovery-spec.md` (new)、`docs/specs/261118-issue72-b2-branch-protection-hooks-spec.md` (new)、`docs/specs/261118-issue73-b3-local-issue-backend-spec.md` (new)、`docs/specs/261118-issue74-b4a-heterogeneous-survey-spec.md` (new)、`docs/specs/261118-issue75-b4b-escalation-stoploss-closure-spec.md` (new)、`docs/specs/261118-issue76-b5-e2e-blind-run-gate-spec.md` (new) 及各自配套 `docs/todo/` 切片任务单 (new)
- **复用既有模块**：`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`（`checkMasterPrdCoverage`、`checkOrphanSlices`）、`kit/skills/lib/doc-shape.mjs`
- **本期不做**：不修改任何 `.mjs` 业务源码、不修改模板与现有测试夹具、不提前启动 Wave 1–5 实施分支
- **门型与回滚路径**：`two-way`；本 PR 仅新增 `docs/` 规划文档，提交前可重置工作树，合入后可反向提交回退
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: `docs/prd/261118-v9-stageb-adaptive-architecture-prd.md` (new) 完整落盘 `C1..C19`、5 波零重叠写域排程、紧文件 `< 800` 行拆法与 `AGENTS.md` 字节预算，且 4 项待拍板全部固化 `已定：...`。
- [x] C2: 6 组切片文档（`B1 #71`、`B2 #72`、`B3 #73`、`B4a #74`、`B4b #75`、`B5 #76`）全齐且 100% 认领覆盖 `C1..C19`（`checkMasterPrdCoverage` 与 `checkOrphanSlices` 均返回 0 错误）。
- [x] C3: 经独立 `critic-stage-b-r2` 完成全部 7 份文档 `critique-pass`（`round=2`），维护者 `approve` 已将总控 PRD 转 `active`、`B1` 转 `approved`（`B2..B5` 保持 `draft` 含 `plan_critique: passed`，按 `@coordinator` Option 1 决策待并行 Case 2 解除 `doc-plan.mjs:296` `C1` 起始限制后即可直接 `approve`），`node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .`、`node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs --domain doc-depth` 均退出 `0`。
- [x] C4: `flow.mjs finalize --task v9-plan` 仅将本规划 Todo 归档至 `docs/archive/todo/`，完整保留 `docs/prd/261118-v9-stageb-adaptive-architecture-prd.md` 与 `B1..B5` 6 组文档活跃于 `docs/`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 创建 `#71..#77` GitHub Issues 并开立隔离工作位 `.worktrees/impl-v9-plan` | `gh issue view 71..77` 与 `flow.mjs status` | `0aa2068` 清理完毕 |
| 2 | 落盘 Master PRD 与 `B1..B5` 6 组切片 `SPEC + Todo` | `doc-plan.mjs audit .`、`preflight.mjs`、`fixtures.mjs --domain doc-depth` 全绿 | 步骤 1 |
| 3 | 提交分支送独立 `critic-stage-b` Critique，通过后执行 `approve -> finalize -> verify -> submit` | PR CI 全绿并仅关闭 `#77` | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `Wave 0.5` `finalize` 误归档总控 PRD 或 `B1..B5` 文档 | 本 Todo 误配 `related_prd`/`related_spec` 或同 slug 污染 | 本 Todo `related_prd: null`、`related_spec: null`，且独立 `issue: 77` / `slug: v9-stageb-plan` 与 `B1..B5` 完全隔离 |
| 新增文档残留尖括号占位、空泛词或未标记 `(new)` 路径 | 手工增补正文漏检 | 每次修改后全量运行 `doc-plan.mjs audit .` 与红线扫描 |

## 回滚预案

- **出问题时的第一步**：运行 `git status --short` 确认隔离工作位改动范围，丢弃问题文档或修净重跑 `doc-plan.mjs audit .`。
- **回滚用什么**：`git revert` 反向提交 `Wave 0.5` 规划提交或 `flow.mjs abort --task v9-plan --confirm`。
- **回滚之后要做什么**：向 `@coordinator` 汇报回退原因，确认 `docs/prd/` 与 `docs/specs/` 清净。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 独立规划评审人 | 对 Master PRD 与 `B1..B5` 切片 SPEC 执行独立 Critique (`critique-pass`) | 分支提交交付后 | `critic-stage-b` |
| 人类维护者 | `doc-plan.mjs approve` 放行进入实施波次 | Critique 通过后 | `FiretrUCK666` / `coordinator` |
| 独立审查与合并 | 审查 `Wave 0.5` PR、等待 CI 全绿并合入 `main` | `submit` 提审后 | `review-v9-plan` |

## 断点与遗留决策

- **当前状态**：已完成，无遗留（Master PRD 与 `B1..B5` 6 组切片文档已完成 Round 2 独立 Critique，按 `@coordinator` Option 1 完成 `Wave 0.5` 收口归档与提审）。
- **待拍板事项**：无
- **下一步第一件事**：无（待独立审查者完成 `Wave 0.5` PR 审查与合入并仅关闭 `#77`）。

## 澄清与补充记录

- （四项待拍板问题已全部以选项 A 固化进 Master PRD；`B3` 已合入本地起步新增远端平滑过渡，`B4b` 已合入 `C19` `1:N` 总控 PRD 确定性自动收口）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：`critic-stage-b-r2` 对 Master PRD 与全部 6 份切片 `SPEC` 完成 `critique-pass`（`round=2`）；`doc-plan.mjs approve` 已将 Master PRD 转为 `active`、`B1` 转为 `approved`；`node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .`（14/14 全部通过）、`node scripts/dev/preflight.mjs`（34 项 0 失败）、`node scripts/dev/fixtures.mjs --domain doc-depth`（4/4 通过）、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --strict`（0 finding）均退出 `0`；随后执行 `finalize -> verify --mode gate -> e2e-zip-harness -> submit`。
- **文档同步检查**：总控 PRD、`B1..B5` 6 组切片 `SPEC + Todo`、GitHub Issues `#71..#77`（保持 `OPEN`，仅本规划 `#77` Todo 归档）及 `29/29` 跨波共享文件串行台账全部同步对齐；未改动任何业务源码与 `AGENTS.md`/`README.md`。
- **遗留问题**：`issue72..issue76` 切片 `SPEC` 已带 `critic-stage-b-r2` `plan_critique: passed`，当前按 `@coordinator` Option 1 保持 `draft` 待并行 Case 2 修复 `kit/skills/dev-plan/scripts/doc-plan.mjs` 与 `doc-audit.mjs` 的 `C1` 起始限制合入后再直接 `approve`，无代码侧遗留。
