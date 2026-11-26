---
kind: todo
title: "Empirical Gate Cohesion, UI Artifact Parity and Merge Safety"
status: done
created: 2026-11-26
updated: 2026-11-26
issue: 207
pr: null
branch: feat/empirical-handoff-cohesion
owner: planner-arch
plan_mode: interactive
approved: false
done_at: 2026-11-26
task_id: empirical-handoff-cohesion
planned_at: ff2c31b7e9e6762e233fecc57486ddfe04aa085d
related_prd: ../../prd/261126-suite-cohesion-v2-prd.md
related_spec: ../specs/261126-issue207-empirical-handoff-cohesion-spec.md
depends_on: []
scope_files: [kit/skills/lib/workflow-policy.mjs, kit/skills/lib/workflow-helpers.mjs, kit/skills/lib/workflow-policy-next.mjs, kit/skills/lib/static-gates.mjs, kit/skills/lib/empirical-artifacts.mjs, kit/skills/lib/exit-codes.mjs, kit/skills/lib/handoff-package.mjs, kit/skills/lib/task-backend-local.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/lib/verify-state.mjs, kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-review/scripts/review-empirical-state.mjs, kit/skills/dev-review/scripts/review-ledger.mjs, kit/skills/dev-review/scripts/review-locks.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-flow/scripts/flow-next.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs, kit/skills/dev-flow/scripts/flow-merge.mjs, scripts/lib/agents-defaults.mjs, scripts/dev/fixtures-govern.mjs]
---

# Empirical Gate Cohesion, UI Artifact Parity and Merge Safety

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / 基线 | `feat/empirical-handoff-cohesion` @ `ff2c31b` |
| 任务编号 | `empirical-handoff-cohesion` |
| 负责人 / 审批 | planner-arch / `false` |
| 规划态 | `interactive`（边界与退出码已定案，待拍板为零） |
| 关联 Issue / PR / SPEC | #207 / 未关联 / `docs/archive/specs/261126-issue207-empirical-handoff-cohesion-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261126-issue207-empirical-handoff-cohesion-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-helpers.mjs`、`kit/skills/lib/workflow-policy-next.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/empirical-artifacts.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/handoff-package.mjs`、`kit/skills/lib/task-backend-local.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`kit/skills/lib/verify-state.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/dev-review/scripts/review-empirical-state.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/dev/fixtures-govern.mjs`。
- **复用既有模块**：`kit/skills/lib/evidence-substance.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/git.mjs`、`kit/skills/lib/exit-codes.mjs`。
- **本期不做**：不修改切片一的 `doc-graph`/`profile`/`govern-audit`/`doc-plan` 文件，也不修改切片三的评论渲染、`kit/skills/dev-review/SKILL.md` 与 `flow-context.mjs`。
- **门型与回滚路径**：`one-way`；出现异常通过 `git revert` 反向提交并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C5: 修复 `review-empirical.mjs:420` 与 `review-empirical-state.mjs:316` 省略 `smoke-verify` 死锁、优化 `scripts/lib/agents-defaults.mjs:406` 纯库/CLI 默认值、将 `review-empirical.mjs:92` 改为 `!isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired)`（仅去 `|| hasDevProfileTestCmds`，保留高风险 `smoke-verify: none` 及 `fixtures-r8-bugfixes.mjs:348-356` 中风险运行时样本触发 `faultRequired === true`），并支持四项 Dev Profile 全 `explicitNone` 纯文档仓经静态校验通过 `check-empirical`。
- [x] C6: 在 `review-ledger.mjs` 实现同 `HEAD` 有效 `check-empirical` 回执自动复用（保留 L121 `if (!evidenceRaw) {` 供 `I117`）、消除 L426-438 `empParts` 三重拼接、统一 `evaluateObservationSubstance` 与 `validateE2eEvidenceText` 判据并取消仅为附着文本重跑 `flow verify --mode smoke`，经 `node scripts/dev/fixtures.mjs` 验证通过。
- [x] C7: 从 `flow-lifecycle-helpers.mjs`（795 行）抽离 precheck 辅助至 `flow-lifecycle-hooks.mjs` 并于 L405 透传 `implRoot`（两文件均 `<= 800` 行）、`flow-lifecycle.mjs:330` precheck 前置、`flow-lifecycle-helpers.mjs:620` 去矛盾 `--visual-checked` 提示、`flow-lifecycle.mjs:94,402` 在 `quick --target` 内循环跳过 `--final` edit-gate 与重复 `govern-audit`、将细化 `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs`（`static-gates.mjs <= 800` 行）统一标准并豁免非 UI README `.svg` 与模板，经 `node scripts/dev/fixtures.mjs` 验证通过。
- [x] C8: 收窄 `static-gates.mjs:383`（`classifyDoorType` 接受 `review-gates.mjs:518,525` 透传的 `untrustedSurface = false`）与 `review-gates.mjs:568` `mergeAuthority = 'human-required'` 为 `gateWeakened || humanAuth || untrustedSurface`（同步 `scripts/dev/fixtures-govern.mjs:60`），将 `kit/skills/lib/exit-codes.mjs:133` `BLOCKED_HUMAN_MERGE_AUTHORITY` 从 `FACT_CODES` 迁至 `HUMAN_CODES`（`4`）并使 `flow-merge.mjs:501-503` 返回 `EXIT.HUMAN`（`4`，过 `exit-code-parity.mjs:152`）；在 `flow-merge.mjs:657-722` 阻断 `!mergeRes || mergeRes?.delegated === true || mergeRes?.ok === false`（含 `!ledger.prNumber && !ledger.branch` 与 `prNumber === null`）；补齐 `generic-git` 离线 `--reason` 校验（对齐 `task-backend-local.mjs:523`）、修复 `flow-lifecycle-finalize.mjs:229,243`、`workflow-helpers.mjs:43`、`flow-next.mjs:346`、`handoff-package.mjs:338-342`、`verify-tools.mjs:65,129,392`、`workflow-policy.mjs:727`，同步 `node scripts/equip.mjs .` 并全绿通过 `preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs --jobs 4`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补充省略 smoke 死锁、回执复用、UI 产物、`mergeAuthority` 与合并安全失败用例（Red） | `node scripts/dev/fixtures.mjs` 复现失败 | 无 |
| 2 | 修复 `review-empirical*`、`agents-defaults.mjs`、`workflow-policy*.mjs` 与 `workflow-helpers.mjs` | `node scripts/dev/fixtures.mjs` C5 转绿 | 步骤 1 |
| 3 | 改造 `review-ledger.mjs`、`review-locks.mjs`，将 `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs` 并改造 `static-gates.mjs` | `node scripts/dev/fixtures.mjs` C6 转绿 | 步骤 2 |
| 4 | 从 `flow-lifecycle-helpers.mjs` 抽离 precheck 至 `flow-lifecycle-hooks.mjs`，改造 `flow-lifecycle*.mjs`、`flow-merge.mjs`、`task-backend-local.mjs`、`review-gates.mjs`、`flow-next.mjs`、`handoff-package.mjs`、`verify-tools.mjs`、`verify-state.mjs` 与 `fixtures-govern.mjs` | `node scripts/dev/fixtures.mjs` C7-C8 转绿 | 步骤 3 |
| 5 | 执行 `node scripts/equip.mjs .` 并跑全量门禁与故障注入 | `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4`、`merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `flow-lifecycle-helpers.mjs`（795 L）、`static-gates.mjs`（792 L）或 `review-gates.mjs`（792 L）超 800 行 | 原地增加分支 | 提前抽离至 `flow-lifecycle-hooks.mjs` 与 `empirical-artifacts.mjs` |
| 破坏 `review-ledger.mjs:121` `I117` 锚点 | 重写 `if (!evidenceRaw) {` 判断形式 | 保留 L121 精确字面量作为最终兜底并在其前赋值回执 |

## 回滚预案

- **出问题时的第一步**：执行 `git revert HEAD` 并重跑 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/fixtures.mjs`。
- **回滚之后要做什么**：恢复原 `mergeAuthority` 与实证门禁判定并复跑 `verify-injections.mjs`。

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（等待总控 PRD 与本 SPEC 独立 Critique 及 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：完成总控 PRD 与本切片 SPEC 的独立 Critique，再经 `approve` 启动实施工作区。

## 澄清与补充记录

- 已根据 Round 1 Critique 校准 `C5` `faultRequired` 公式、`C8` `mergeAuthority` 收窄与 `EXIT.HUMAN`（`4`）、`mcp-delegate` `prNumber === null` 假合并防护及 `static-gates.mjs`/`flow-lifecycle-helpers.mjs` 800 行抽离目标。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .` / `node scripts/equip.mjs . --check`：通过（156 个文件字节级一致，0 语法/ABI 错误）
  - `node scripts/dev/preflight.mjs`：通过（41 项读数，0 项失败）
  - `node scripts/dev/fixtures.mjs --jobs 6`：通过（583 项行为断言全部通过，0 失败）
  - `node scripts/dev/verify-injections.mjs --jobs 4`：通过（470 条故障注入判据全部命中）
  - `node scripts/dev/merge-gate.mjs`：通过（含全套 CI 门禁与基准）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json`：通过（58 个文件检查，0 blocker）
- **文档同步检查**：已执行 `node scripts/equip.mjs .` 同步 `.agents/skills/`，同步更新 `kit/skills/dev-review/SKILL.md`（108 行，未触及 L95 PR/Issue 四栏合同）及 `scripts/dev/injections-data-visual-engine.mjs`（`I961` 指向单源 `empirical-artifacts.mjs`）。
- **遗留问题**：无；切片一、切片三专属文件均未触及。
