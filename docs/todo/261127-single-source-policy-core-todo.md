---
kind: todo
title: 单源三轴正交策略、去重收口与静默防刷屏
status: draft
created: 2026-11-27
updated: 2026-11-27
issue: null
pr: null
branch: feat/sandbox-dual-loop-v1
owner: plan-sandbox-v1
plan_mode: interactive
approved: false
done_at: null
task_id: single-source-policy-core
planned_at: 5feb0dbff6d86a217c45d74e44fe6949a35f912c
related_prd: ../prd/261127-sandbox-dual-loop-v1-prd.md
related_spec: ../specs/261127-single-source-policy-core-spec.md
---

# 单源三轴正交策略、去重收口与静默防刷屏

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/sandbox-dual-loop-v1` @ `5feb0db` |
| 任务编号 | `single-source-policy-core` |
| 负责人 / 审批 | plan-sandbox-v1 / `false` |
| 规划态 | `interactive`（架构决策已拍板，待 Critique 与审批） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `docs/specs/261127-single-source-policy-core-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/gate-receipt.mjs` (new)、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/dev-review/scripts/review-empirical-state.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-iterate/scripts/iterate.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`scripts/dev/fixtures-policy-axes.mjs` (new)、`scripts/dev/injections-data-policy-axes.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`、`scripts/dev/fixtures-r8-bugfixes.mjs`、`scripts/dev/fixtures-review-empirical.mjs`、`scripts/dev/fixtures-iterate-evolution.mjs`
- **复用既有模块**：`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/empirical-artifacts.mjs`、`kit/skills/lib/architecture-map.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/git.mjs`
- **本期不做**：不实现沙箱 worktree 创建/`flow promote`（归切片 2）；不改 `triage` 入口、`templates/`、`AGENTS.md` 或 `SKILL.md` 文案（归切片 3）。
- **门型与回滚路径**：one-way；触及 `kit/` 核心门禁，须独立审查与故障注入；回滚用 `git revert` 并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C1: `determineWorkflowPolicy` 将 UI 视觉实证（`visualCheckRequired`）与 `riskTier='high'` 解耦，不再因仅改前端样式/组件文件而强抬为 `high`；`faultInjectionRequired` 与 `review-empirical.mjs` 的 `faultRequired` 单源统一精确绑定至 `high`/`one-way`/`Case >= 4`，经 `fixtures-policy-axes.mjs` 正反双向断言通过。
- [ ] C2: 沙箱/内环快检在 `evidence.json` 记录 `inner: true`；外环 `validateVerificationEvidence` 对顶层或门禁项带 `inner === true` 的实证硬拒并返回 `BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER`（退出码 `3`），经正反双向断言通过。
- [ ] C3: 新增 `kit/skills/lib/gate-receipt.mjs` (new) 实现 `{ headSha, diffFingerprint, profileHash }` 绑定的干净 HEAD 回执复用，使单次 `flow verify` 中 `verifyArchitectureMapSync` 仅执行 1 次并消除 `scanStructuralHygiene`/`evaluateArchRules`/`detectGateWeakening` 在 4 处的重复重算，且脏树或 HEAD 变化时立即失效重扫。
- [ ] C4: `flow-lifecycle-helpers.mjs`、`review-empirical-state.mjs` 与 `iterate.mjs` 在探索/内环/`quick`/沙箱失败时默认仅记本地诊断包与治理信号而不向远端托管平台自动建单；仅外环阻断或显式 `--escalate` 才触发远端建单。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写失败的 Red-Green 测试 `scripts/dev/fixtures-policy-axes.mjs` (new) 并注册到 `scripts/dev/fixtures.mjs` | 运行 `node scripts/dev/fixtures.mjs` 对应新用例必须红 | 规划获批 |
| 2 | 新增 `kit/skills/lib/gate-receipt.mjs` (new) 并改造 `workflow-policy.mjs` 三轴解耦与 `inner: true` 拦截 | `fixtures-policy-axes.mjs` 的 C1/C2 变绿且 `workflow-policy.mjs <= 800L` | 步骤 1 |
| 3 | 接入 `review-empirical*.mjs`、`review-locks.mjs`、`review-gates.mjs`、`edit-gate.mjs`、`flow-lifecycle-hooks.mjs`、`flow-lifecycle-helpers.mjs`、`iterate.mjs`、`govern-checks.mjs` | `fixtures-policy-axes.mjs` 全部变绿，全部改动文件 `<= 800L` | 步骤 2 |
| 4 | 更新旧夹具断言并新增 `scripts/dev/injections-data-policy-axes.mjs` (new)，运行 `node scripts/equip.mjs .` 同步 `.agents/skills/` | `preflight.mjs`、`fixtures.mjs`、`equip.mjs . --check`、`verify-injections.mjs --jobs 4` 全绿 | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `review-empirical.mjs`（797L）超 800 行红线 | 改动时新增 4 行以上代码 | 仅原地替换第 101-102 行，额外判断全部放在 `workflow-policy.mjs` 与 `gate-receipt.mjs` (new) |
| 旧单测仍断言 `medium` 运行时改动 `faultRequired === true` | 运行 `fixtures-r8-bugfixes.mjs` / `fixtures-review-empirical.mjs` | 同步改造对应夹具为双向断言（`high`/`one-way`/`Case>=4` 为 `true`，普通 `medium` 为 `false`） |

## 回滚预案

- **出问题时的第一步**：停止向 Wave 2 推进，记录失败用例与 `verify-injections.mjs` 输出。
- **回滚用什么**：`git revert` 撤销本切片合入提交并运行 `node scripts/equip.mjs .`。
- **回滚之后要做什么**：运行 `node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs` 确认基线恢复全绿。

## 断点与遗留决策

- **当前状态**：`draft`（Wave 1 切片，零上游依赖，待 Critique 与 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：完成主 PRD 与本 SPEC 的独立 Critique 与 `approve` 后，派独立实施子代理在隔离 worktree 启动步骤 1。

## 澄清与补充记录

- 已确认：本切片为 Wave 1，独占策略核心与门禁回执缓存文件，与 Wave 2 零同波冲突。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
