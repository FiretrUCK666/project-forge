---
kind: todo
title: 单源三轴正交策略、去重收口与静默防刷屏
status: done
created: 2026-11-27
updated: 2026-11-27
issue: 214
pr: null
branch: feat/single-source-policy-core
owner: plan-sandbox-v1
plan_mode: interactive
approved: false
done_at: 2026-11-27
task_id: single-source-policy-core
planned_at: 5feb0dbff6d86a217c45d74e44fe6949a35f912c
related_prd: ../../prd/261127-issue214-sandbox-dual-loop-v1-prd.md
related_spec: ../specs/261127-issue214-single-source-policy-core-spec.md
---

# 单源三轴正交策略、去重收口与静默防刷屏

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/single-source-policy-core` @ `5feb0db` |
| 任务编号 | `single-source-policy-core` |
| 负责人 / 审批 | plan-sandbox-v1 / `false` |
| 规划态 | `interactive`（架构决策已拍板，待 Critique 与审批） |
| 关联 Issue / PR / SPEC | #214 / 未关联 / `docs/archive/specs/261127-issue214-single-source-policy-core-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/gate-receipt.mjs` (new)、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/dev-review/scripts/review-empirical-state.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-iterate/scripts/iterate.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`docs/feature-map.json`、`docs/architecture-map.html`、`scripts/dev/fixtures-policy-axes.mjs` (new)、`scripts/dev/injections-data-policy-axes.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`、`scripts/dev/fixtures-r6c-gates.mjs`、`scripts/dev/injections-data-r6c.mjs`、`scripts/dev/fixtures-e2e-gate.mjs`、`scripts/dev/fixtures-w4-harness.mjs`、`scripts/dev/fixtures-r8-bugfixes.mjs`、`scripts/dev/fixtures-review-empirical.mjs`、`scripts/dev/fixtures-iterate-evolution.mjs`
- **复用既有模块**：`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/empirical-artifacts.mjs`、`kit/skills/lib/architecture-map.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/git.mjs`
- **本期不做**：不实现沙箱 worktree 创建/`flow promote`（归切片 2）；不改 `triage` 入口、`templates/`、`AGENTS.md` 或 `SKILL.md` 文案（归切片 3）。
- **门型与回滚路径**：one-way；触及 `kit/` 核心门禁，须独立审查与故障注入；回滚用 `git revert` 并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C1: `determineWorkflowPolicy` 将 UI 视觉实证（`visualCheckRequired`）与 `riskTier='high'` 解耦（且 `isLow` 显式要求 `effectiveVisual.length === 0`），不再因仅改前端样式/组件文件而强抬为 `high`；`faultInjectionRequired` 与 `review-empirical.mjs` 的 `faultRequired`（含 `smokeExplicitNone` 对齐 `review-locks.mjs:601`）单源统一精确绑定至 `high`/`one-way`/`Case >= 4`，经 `fixtures-policy-axes.mjs` 与更新后的既有夹具正反双向断言通过。
- [x] C2: 沙箱/内环快检在 `evidence.json` 记录 `inner: true`；外环 `validateVerificationEvidence` 对顶层或门禁项带 `inner === true` 的实证硬拒并返回 `BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER`（退出码 `3`），经正反双向断言通过。
- [x] C3: 新增 `kit/skills/lib/gate-receipt.mjs` (new)（当波登记入 `docs/feature-map.json` 并重渲 `docs/architecture-map.html`）实现 `{ repoRoot, dirty: false, headSha, baseSha, diffFingerprint, profileHash }` 绑定的干净 HEAD 回执复用（支持有 `taskId` 与 headless 无 `taskId` 场景，明确唯一生产者并保活 `I962/I963`），使单次 `flow verify` 中 `verifyArchitectureMapSync` 仅执行 1 次并消除 `scanStructuralHygiene`/`evaluateArchRules`/`detectGateWeakening` 重复重算，且脏树或配置/HEAD 变化时立即失效重扫。
- [x] C4: `flow-lifecycle-helpers.mjs`、`review-empirical-state.mjs` 与 `iterate.mjs`（同步更新 `printHelp()` 第 67 行说明及 `fixtures-r6c-gates.mjs`/`injections-data-r6c.mjs` `I502`）在探索/内环/`quick`/沙箱失败时默认仅记本地诊断包与治理信号而不向远端托管平台自动建单；仅外环阻断或显式 `--escalate` 才触发远端建单。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写失败的 Red-Green 测试 `scripts/dev/fixtures-policy-axes.mjs` (new) 并注册到 `scripts/dev/fixtures.mjs` | 运行 `node scripts/dev/fixtures.mjs` 对应新用例必须红 | 规划获批 |
| 2 | 新增 `kit/skills/lib/gate-receipt.mjs` (new) 并改造 `workflow-policy.mjs` 三轴解耦、`isLow` 排视觉与 `inner: true` 拦截 | `fixtures-policy-axes.mjs` 的 C1/C2 变绿且 `workflow-policy.mjs <= 780L` | 步骤 1 |
| 3 | 接入 `review-empirical.mjs`（零净增行）、`review-empirical-state.mjs`、`review-locks.mjs`、`review-gates.mjs`、`edit-gate.mjs`（保 `I963`）、`flow-lifecycle-hooks.mjs`（保 `I962`）、`flow-lifecycle-helpers.mjs`、`iterate.mjs`（含第 67 行帮助文案）、`govern-checks.mjs` | `fixtures-policy-axes.mjs` 全绿，全部改动 `.mjs <= 800L` | 步骤 2 |
| 4 | 当波同步更新 `fixtures-r6c-gates.mjs`、`injections-data-r6c.mjs` (`I502`)、`fixtures-e2e-gate.mjs`、`fixtures-w4-harness.mjs`、`fixtures-r8-bugfixes.mjs`、`fixtures-review-empirical.mjs`、`fixtures-iterate-evolution.mjs`（`<= 795L`），新增 `scripts/dev/injections-data-policy-axes.mjs` (new)，登记 `gate-receipt.mjs` 入 `docs/feature-map.json` 并重渲 `docs/architecture-map.html`，同步 `.agents/skills/`（`node scripts/equip.mjs .`） | `preflight.mjs`、`fixtures.mjs`、`equip.mjs . --check`、`verify-injections.mjs --jobs 4` 全部退出码 `0` | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `review-empirical.mjs`（797L）或 `fixtures-iterate-evolution.mjs`（795L）超 800 行 | 直接追加多行代码或新测试用例 | `review-empirical.mjs` 仅原地替换 2 行；新增用例全部放 `fixtures-policy-axes.mjs` (new) |
| 回执缓存意外屏蔽 `I962`/`I963` 架构图漂移拦截 | 脏树或漂移态误写/误读 `architectureMapSync` 回执 | 仅在 `syncRes.ok === true && !dirty` 时落盘，且原样保留两处 `if (!syncRes.ok)` 语句 |
| `iterate.mjs` 静默默认打破 `fixtures-r6c-gates.mjs` 与 `I502` | 未在当波同步既有断言 | 步骤 4 当波同步升级 `fixtures-r6c-gates.mjs` 与 `injections-data-r6c.mjs` `I502` |

## 回滚预案

- **出问题时的第一步**：停止向 Wave 2 推进，记录失败用例与 `verify-injections.mjs` 输出。
- **回滚用什么**：`git revert` 撤销本切片合入提交并运行 `node scripts/equip.mjs .`。
- **回滚之后要做什么**：运行 `node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs` 确认基线恢复全绿。

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（Wave 1 切片，零上游依赖，待 Critique 与 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：完成主 PRD 与本 SPEC 的独立 Critique 与 `approve` 后，派独立实施子代理在隔离 worktree 启动步骤 1。

## 澄清与补充记录

- 已确认：本切片为 Wave 1，当波完成 `gate-receipt.mjs` (new) 的 `feature-map` 登记与受波及既有夹具/注入表更新，保证独立合入全绿。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：`node scripts/equip.mjs . --check` PASS、`node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json` `ok: true`（0 blockers）、`node scripts/dev/merge-gate.mjs` 12/12 PASS（含 `fixtures` 594/594 PASS、`verify-injections` 476/476 PASS）、`node scripts/dev/verify-injections.mjs --jobs 4` 476/476 PASS（0 failures）。
- **文档同步检查**：已更新 `docs/TDD.md`（登记 `kit/skills/lib/gate-receipt.mjs`、`scripts/dev/fixtures-policy-axes.mjs`、`scripts/dev/injections-data-policy-axes.mjs`），已登记 `kit/skills/lib/gate-receipt.mjs` 至 `docs/feature-map.json`，已运行 `verify-tools.mjs render` 更新 `docs/architecture-map.html`，已运行 `equip.mjs .` 同步 `.agents/skills/`，并在 SPEC 补齐 `## 实现说明`。
- **遗留问题**：无（Wave 2 `sandbox-dual-loop-flow` 与 Wave 3 `triage-brief-contract-parity` 按主 PRD 拓扑串行推进）。
