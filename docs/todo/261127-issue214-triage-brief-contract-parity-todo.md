---
kind: todo
title: 确定性入口分流、契约对拍与异构仓库双向实证
status: active
created: 2026-11-27
updated: 2026-11-27
issue: 214
pr: null
branch: feat/triage-brief-contract-parity
owner: plan-sandbox-v1
plan_mode: interactive
approved: false
done_at: null
task_id: triage-brief-contract-parity
planned_at: 5feb0dbff6d86a217c45d74e44fe6949a35f912c
related_prd: ../prd/261127-issue214-sandbox-dual-loop-v1-prd.md
related_spec: ../specs/261127-issue214-triage-brief-contract-parity-spec.md
---

# 确定性入口分流、契约对拍与异构仓库双向实证

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/triage-brief-contract-parity` @ `5feb0db` |
| 任务编号 | `triage-brief-contract-parity` |
| 负责人 / 审批 | plan-sandbox-v1 / `false` |
| 规划态 | `interactive`（架构决策已拍板，待 Critique 与审批） |
| 关联 Issue / PR / SPEC | #214 / 未关联 / `docs/specs/261127-issue214-triage-brief-contract-parity-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-plan/scripts/triage-rules.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`references/collaboration.md`、`templates/agents-project.md`、`AGENTS.md`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-review/SKILL.md`、`kit/skills/dev-edit/SKILL.md`、`kit/skills/dev-iterate/SKILL.md`、`scripts/dev/preflight-contract-rules.mjs`、`scripts/dev/preflight-contracts.mjs`、`scripts/dev/preflight-suite.mjs`、`scripts/dev/fixtures-heterogeneous-dual-loop.mjs` (new)、`scripts/dev/injections-data-triage-parity.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`、`scripts/dev/fixtures-doc-triage.mjs`、`scripts/dev/fixtures-living-brief.mjs`、`scripts/dev/fixtures-r6d-contracts.mjs`、`docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md`
- **复用既有模块**：`kit/skills/dev-plan/scripts/triage-rules.mjs`、`kit/skills/lib/static-gates.mjs`、`scripts/compose-agents.mjs`、`scripts/equip.mjs`、`scripts/sync-toc.mjs`、`scripts/review.mjs`、`scripts/dev/fixtures-helpers.mjs`
- **本期不做**：不实施 Milestone B 的 `visual-studio-archify-v2` 画布与蓝图 UI 重构。
- **门型与回滚路径**：one-way；须独立审查与两阶段故障注入；回滚用 `git revert` 并重跑 `compose-agents.mjs .` 与 `equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C9: `doc-plan.mjs triage` 确定性输出 `recommendedEntry: 'direct' | 'sandbox' | 'plan-first'` 与单一 `[NEXT STEP]`，仅移除 `doc-audit.mjs:165` `fileCount >= 6 -> Case 4` 钝化悬崖（保留 `:86,161,169` `fileCount >= 12` PRD 判据），保持 `Case 5` 与 `PRD` 严格正交，且统筹 `doc-plan-brief.mjs` 两处（`handleNoteSubcommand` 与 `handleTriageSubcommand`）按需触发 Living Visual Brief / Prototype（局部可逆默认零 Brief 开销，兼容多轮讨论 `fixtures-living-brief.mjs`）。
- [x] C10: `templates/agents-project.md`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`AGENTS.md`、`references/collaboration.md`、5 份受影响 `kit/skills/*/SKILL.md` 及 `scripts/dev/preflight*`（含同步 `fixtures-r6d-contracts.mjs`）完成同构同步，严守 `SKILL.md <= 14,336 B / <= 180 L`、`AGENTS.md <= 30 KB`、`equip.mjs . --check` 字节一致与零特定 E2E 驱动硬编码。
- [x] C11: 新增 `scripts/dev/fixtures-heterogeneous-dual-loop.mjs` (new) 覆盖 7 类异构仿真仓库（空/极简仓、Node/TS 单包与 Monorepo、Python/Go/Rust、Prisma/SQL、UI 前端、无清单非 JS 通用、`generic-git`），双向验证完整双环流转零项目定制补丁。
- [x] C12: 补齐并更新本里程碑全部双向故障注入样本，完成 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md` 与 `README.en.md` 最终全局对齐，运行全部 10 项全仓门禁、`verify-injections.mjs --jobs 4`、`e2e-zip-harness.mjs` 与 `git archive` 用户包校验全部退出码 `0`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写失败的 Red-Green 测试 `scripts/dev/fixtures-heterogeneous-dual-loop.mjs` (new) 并注册到 `scripts/dev/fixtures.mjs` | 运行 `node scripts/dev/fixtures.mjs` 新用例必须红 | Wave 1 & Wave 2 已合并 |
| 2 | 改造 `triage-rules.mjs`、`doc-audit.mjs`（`<= 785L`）、`doc-plan-brief.mjs`（统筹两处 Brief 触发），同步 `fixtures-doc-triage.mjs` 与 `fixtures-living-brief.mjs` | `C9` 正反双向测试变绿且 `doc-audit.mjs <= 785L` | 步骤 1 |
| 3 | 同构更新 `references/collaboration.md`、`templates/*`、`.github/pull_request_template.md`、5 份 `kit/skills/*/SKILL.md`、`fixtures-r6d-contracts.mjs`、`preflight*`，执行 `compose-agents.mjs .` 与 `equip.mjs .` | `SKILL.md <= 14,336 B / <= 180L`、`AGENTS.md <= 30 KB`、`preflight-suite.mjs <= 792L`、`preflight.mjs` 绿 | 步骤 2 |
| 4 | 同步 `docs/TDD.md`、终验 `docs/feature-map.json` 与 `docs/architecture-map.html`、成对更新 `README.md`/`README.en.md`、补齐 `injections-data-triage-parity.mjs` (new) 并跑通全量 10 项门禁与 `verify-injections --jobs 4`、`e2e-zip-harness.mjs`、`git archive` 包检 | 全部门禁退出码 `0`，且总控 PRD `C1..C12` 全勾闭环 | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `kit/skills/dev-flow/SKILL.md` 或 `kit/skills/dev-plan/SKILL.md` 超 14,336 B 预算 | 直接追加大段双环说明 | 替换旧单环冗余表述，保持紧凑表格与命令行示例，逐份校验字节与行数 |
| `doc-audit.mjs`（777L）或 `preflight-suite.mjs`（790L）超 800 行 | 在原文件堆叠新规则 | 新规则分别归口至 `triage-rules.mjs` 与 `preflight-contract-rules.mjs` |

## 回滚预案

- **出问题时的第一步**：保留 `preflight` / `verify-injections` 失败输出，定位具体契约冲突文件。
- **回滚用什么**：`git revert` 撤销 Wave 3 合入并重跑 `node scripts/compose-agents.mjs . && node scripts/equip.mjs .`。
- **回滚之后要做什么**：运行全量 `preflight.mjs`、`fixtures.mjs` 与 `review.mjs .` 确认恢复。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| Wave 1 (`single-source-policy-core`) | 三轴策略与 `inner: true` 门禁合入 `main` | 启动本切片前 | 主调度 |
| Wave 2 (`sandbox-dual-loop-flow`) | `start --sandbox` 与 `promote` 流水线合入 `main` | 启动本切片前 | 主调度 |

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`（Wave 3 收口切片及 Master Issue #214 `C1..C12` 全部闭环）
- **待拍板事项**：无
- **下一步第一件事**：经 `flow.mjs finalize` 成对归档 Wave 3 SPEC/Todo 与总控 PRD，跑通外环 `verify` 与 `submit` 提审。

## 澄清与补充记录

- 已确认：本切片合入时同时完成总控 PRD `261127-issue214-sandbox-dual-loop-v1-prd.md` 的最后收口与自动归档闭环。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json`（`ok: true`, 0 blockers）、`node scripts/dev/merge-gate.mjs`（12/12 PASS，含 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs` 602/602、`bench.mjs`、`e2e-zip-harness.mjs`、`verify-injections.mjs --jobs 4` 488/488、`review.mjs .`、`govern-audit.mjs audit .`、`git archive` 导出包 `preflight --package`）全部退出 `0`。
- **文档同步检查**：已同步 `references/collaboration.md`、`templates/agents-project.md`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`AGENTS.md`（`< 24 KB`）、5 份 `kit/skills/*/SKILL.md`（全部 `<= 12.6 KB / <= 105 行`）、`docs/TDD.md`、`docs/feature-map.json`、洁净常青 `docs/architecture-map.html`（22 节点、0 `modified`/`impacted` 节点）、`README.md` 与 `README.en.md`。
- **遗留问题**：无。
