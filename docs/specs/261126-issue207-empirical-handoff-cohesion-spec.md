---
kind: spec
title: "Empirical Gate Cohesion, UI Artifact Parity and Merge Safety"
status: approved
tier: L3
created: 2026-11-26
updated: 2026-11-26
issue: 207
pr: null
branch: feat/empirical-handoff-cohesion
owner: planner-arch
plan_mode: interactive
approved: true
implemented: false
plan_critique: "passed (reviewer=critic-governance-cohesion-r4, round=4, sha=c0c41e1f7305, summary=Verified mechanical lint/naming fixes at 6e6f870; all design invariants and C1..C12 remain intact.)"
related_prd: ../prd/261126-suite-cohesion-v2-prd.md
related_todo: ../todo/261126-issue207-empirical-handoff-cohesion-todo.md
high_risk_paths: [kit/, SKILL.md]
task_id: empirical-handoff-cohesion
depends_on: []
scope_files: [kit/skills/lib/workflow-policy.mjs, kit/skills/lib/workflow-helpers.mjs, kit/skills/lib/workflow-policy-next.mjs, kit/skills/lib/static-gates.mjs, kit/skills/lib/empirical-artifacts.mjs, kit/skills/lib/exit-codes.mjs, kit/skills/lib/handoff-package.mjs, kit/skills/lib/task-backend-local.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/lib/verify-state.mjs, kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-review/scripts/review-empirical-state.mjs, kit/skills/dev-review/scripts/review-ledger.mjs, kit/skills/dev-review/scripts/review-locks.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-flow/scripts/flow-next.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs, kit/skills/dev-flow/scripts/flow-merge.mjs, scripts/lib/agents-defaults.mjs, scripts/dev/fixtures-govern.mjs]
---

# Empirical Gate Cohesion, UI Artifact Parity and Merge Safety — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `approved`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（实证门禁策略、UI 产物判据、合并安全与流转工具契约对齐；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / Issue / PR | `feat/empirical-handoff-cohesion` / #207 / 未关联 |
| 负责人 / 内审状态 | planner-arch / `passed` |
| 规划态 | `interactive`（策略边界与退出码已由总控 PRD 冻结，待拍板为零） |
| 关联 PRD / Todo | `docs/prd/261126-suite-cohesion-v2-prd.md` / `docs/todo/261126-issue207-empirical-handoff-cohesion-todo.md` |

- **变更一句话**：消除 `check-empirical`/`check-fault` 死锁与过严拦截，落地 `review-ledger` 回执自动复用与单一实质判据，修复 UI 产物校验链、`mergeAuthority` 边界、`mcp-delegate`/`generic-git` 合并漏洞及多处流转工具缺陷。

## 系统变更全景

```mermaid
flowchart LR
  Verify["验证与实证前置"] --> Ledger["审查回执与复用"]
  Ledger --> Merge["合并与退出码门"]
  Tools["工具与辅助修正"] --> Verify
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-empirical-state.mjs`、`scripts/lib/agents-defaults.mjs` | 改造 | 消除省略 `smoke-verify` 死锁；优化纯库/CLI 接入默认；L92 仅去 `|| hasDevProfileTestCmds`；支持全 `explicitNone` 纯文档仓 |
| `kit/skills/dev-review/scripts/review-ledger.mjs`、`review-locks.mjs` | 改造 | 自动复用同 `HEAD` 有效 `check-empirical` 回执（保 L121 `I117`）；去 L426-438 重复拼接；统一实质判据；取消仅附文本重跑 smoke |
| `kit/skills/lib/static-gates.mjs`、`empirical-artifacts.mjs`、`exit-codes.mjs` | 改造 | 将细化 `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs`（保 `static-gates.mjs <= 800` 行）；L383 收窄 `human-required`（接受 `untrustedSurface`）；将 `BLOCKED_HUMAN_MERGE_AUTHORITY` 从 `FACT_CODES` L133 迁至 `HUMAN_CODES`（`4`） |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-lifecycle-helpers.mjs`、`flow-lifecycle-hooks.mjs` | 改造 | 将 precheck 辅助从 `flow-lifecycle-helpers.mjs`（795 行）抽入 `flow-lifecycle-hooks.mjs` 并于 L405 传 `implRoot`；测试前跑 precheck；`flow-lifecycle-helpers.mjs:620` 去矛盾提示；`quick --target` 跳过 `--final` 与重复审计 |
| `kit/skills/dev-flow/scripts/flow-merge.mjs`、`task-backend-local.mjs`、`review-gates.mjs`、`scripts/dev/fixtures-govern.mjs` | 改造 | 守卫 L657-722 `!mergeRes \|\| mergeRes?.delegated === true \|\| mergeRes?.ok === false` 防假合并；补齐 `generic-git` 离线 `--reason`；L568 收窄 `human-required`（透传 `untrustedSurface` 至 L548）并使 L501-503 返回 `EXIT.HUMAN`（`4`）；锁步更新 `fixtures-govern.mjs:60` |
| `flow-lifecycle-finalize.mjs`、`flow-next.mjs`、`handoff-package.mjs`、`workflow-*.mjs`、`verify-tools.mjs`、`verify-state.mjs` | 改造 | 修 L229/243 `changed`、补 `posixPath`、修 `pack` 标志、复用 `parseAgentsProfile`、对齐 `verify-tools` `--kind`/`resolveDefaultBranch`/缓存命名空间与 `pnpm --dir` |

## 一、背景与边界声明

- **要改什么**：统一实证门禁策略（`check-empirical`/`check-fault`、全 `none` 纯文档仓与 `workflow-policy.mjs`）、回执复用与 UI 产物核验链、`mergeAuthority` 授权范围、`mcp-delegate`/`generic-git` 合并安全校验及流转工具链单点缺陷。
- **不改什么**：不触碰切片一的 `doc-graph`/`profile`/`govern-audit`/`doc-plan` 文件集；不更改 `review-comment-render.mjs`、`kit/skills/dev-review/SKILL.md` 与 `REVIEW_FIELDS` 评论渲染契约（留待切片三）；不破坏 `I117`（`review-ledger.mjs:121`）与 `I247`（`review-gates.mjs`）。
- **本期不做**：不实施 Case 2 `C1..Cn` 提取回退与 PR/Issue 评论瘦身（归切片三）。
- **复用既有模块**：复用 `kit/skills/lib/evidence-substance.mjs`（统一 `evaluateObservationSubstance` 与 `validateE2eEvidenceText`）、`kit/skills/lib/profile.mjs`（`parseAgentsProfile`）、`kit/skills/lib/git.mjs`（`posixPath`、`resolveDefaultBranch`）与 `kit/skills/lib/exit-codes.mjs`（退出码 `4` `EXIT.HUMAN`）。
- **架构基线关系**：`flow-lifecycle-helpers.mjs`（795 行）、`static-gates.mjs`（792 行）与 `review-gates.mjs`（792 行）改造后必须严格 `<= 800` 行；`isUiVisualFile` 细化辅助抽入 `empirical-artifacts.mjs`，verify-precheck 辅助抽入 `flow-lifecycle-hooks.mjs`。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **实证门禁与默认配置对齐**：
   - `review-empirical.mjs:420` 与 `review-empirical-state.mjs:316`：修复省略 `smoke-verify` 时的 `smokeExecuted` / 缺失步骤重入死锁。
   - `scripts/lib/agents-defaults.mjs:406`：为纯库/CLI 新接入仓库生成合理的 `smoke-verify` 默认值或可选标记，避免首次运行即卡死在 `BLOCKED_SMOKE_VERIFY_UNCONFIGURED`。
   - `review-empirical.mjs:92`：将 `faultRequired` 由 `!isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired || hasDevProfileTestCmds)` 精确改为 `!isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired)`——仅去除 `|| hasDevProfileTestCmds`，使纯测试或非运行时文档/配置差异不再被迫跑故障注入，同时保证**所有运行时代码改动**（含高风险 `smoke-verify: none` 及 `scripts/dev/fixtures-r8-bugfixes.mjs:348-356` 中风险 `caseType: 3` 运行时样本）继续保持 `faultRequired === true`。
   - 纯文档仓放行：`quick-test` / `full-test` / `smoke-verify` / `merge-gate` 四项均配置 `explicitNone`（`none`）的纯文档仓，在 `check-empirical` 走静态文档核查放行而不报 `BLOCKED_EMPIRICAL_CMD_REQUIRED`。
2. **`review-ledger.mjs` 自动复用与去重**：
   - `record` 在未传 `--evidence` 时优先检查同 `HEAD` 的有效 `check-empirical` 回执并自动提取实证文本（保留 L121 `if (!evidenceRaw) {` 拦截完全无回执也无 `--evidence` 的场景，保持 `I117` 有效）。
   - 修复 L426-438 `empParts` 对同一实证文本的三重拼接；统一 `empirical-artifacts.mjs` `evaluateObservationSubstance` 与 `verify-state.mjs` `validateE2eEvidenceText` 对 `evidence-substance.mjs` 的调用规范；移除仅为附着 `--e2e-evidence` 文本而强迫重跑 `flow verify --mode smoke` 的阻断。
3. **UI 产物校验链与 `verify` 内循环优化（严格控 `<= 800` 行）**：
   - 从 `flow-lifecycle-helpers.mjs`（795 行）抽离 verify-precheck 包装逻辑至 `kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`，并在 `flow-lifecycle-helpers.mjs:405` 透传 `implRoot`（保证两文件均 `<= 800` 行）；清理 `flow-lifecycle-helpers.mjs:620` 自相矛盾的 `--visual-checked` 提示。
   - `flow-lifecycle.mjs`：L330 处测试执行前先跑 precheck 提前暴露缺少实证产物问题；L94 与 L402 当 `mode === 'quick' && Boolean(rawTarget)` 时跳过 `--final` `edit-gate` 与重复 `govern-audit`（全量 `full`/`gate` 与 `finalize` 照常强检）。
   - 将细化 `isUiVisualFile` 路径分类辅助抽入 `kit/skills/lib/empirical-artifacts.mjs`，在 `static-gates.mjs` 薄委托调用（保持 `static-gates.mjs <= 800` 行），统一 `empirical-artifacts.mjs` 双重标准，使非 UI 的 README `.svg` 或工程模板不误触发高风险 `BLOCKED_UI_ARTIFACT_REQUIRED`。
4. **合并权限收窄、退出码对拍、`mcp-delegate` 阻断与流转工具修复**：
   - `static-gates.mjs:383`（`classifyDoorType` 接受可选参数 `untrustedSurface = false`，由 `review-gates.mjs:518,525` 计算并经 L548 透传）与 `review-gates.mjs:568`：将 `mergeAuthority = 'human-required'` 统一收窄为 `gateWeakened || humanAuth || untrustedSurface`（移除裸 `isOneWay` / `doorType === 'one-way'`），使未弱化门禁的 `one-way`/`highRiskHits` 差异落入 `'reviewer-with-fault-injection'`，与 `AGENTS.md` / `references/collaboration.md` 的「八、谁能合」（仅弱化门禁须人点头；取舍写 `merge-authority: human` 收回人合）一致；同步更新 `scripts/dev/fixtures-govern.mjs:60`。
   - `kit/skills/lib/exit-codes.mjs:133` 与 `flow-merge.mjs:501-503`：将 `'BLOCKED_HUMAN_MERGE_AUTHORITY'` 从 `FACT_CODES`（`3`）迁至 `HUMAN_CODES`（`4`），与 `flow-merge.mjs:501-503` 返回 `EXIT.HUMAN`（`4`）锁步对齐，确保 `scripts/dev/preflight.mjs`（`evaluateExitCodeParity` 位于 `exit-code-parity.mjs:152`）全绿通过。
   - `flow-merge.mjs:657-722`：修复 `canUseGhApi && ledger.prNumber` 在 L578 为假（含 `mcp-delegate` 遗留 `ledger.prNumber === null`，以及 `!ledger.prNumber && !ledger.branch` 场景）时落入 L657 分支调用 `GitHubBackend.mergePr` 返回 `{ ok: false, delegated: true }`、绕过 L679（`blocked`）与 L693（`merged === false`）并在 L722 静默将 `ledger.status` 置为 `'merged'` 的缺陷；在 L722 之前显式守卫 `!mergeRes || mergeRes?.delegated === true || mergeRes?.ok === false`（阻断或按委托载荷分支退出）。
   - `flow-merge.mjs:528,660` 与 `task-backend-local.mjs:523`：对 `generic-git` 离线 `--human-approved` 强制校验非空合规 `--reason`。
   - `flow-lifecycle-finalize.mjs:229,243` 改传真实 `changed` 文件列表而非 `preCheck.changedFiles`；`workflow-helpers.mjs:43` 补导入 `posixPath`；`flow-next.mjs:346` `pack` 模式不拼接 `--reviewer-id`/`--review-token`；`handoff-package.mjs:338-342` 复用 `parseAgentsProfile`；`verify-tools.mjs:65,129,392` 对齐 `--kind` 枚举、使用 `resolveDefaultBranch` 与槽位隔离缓存命名空间；`workflow-policy.mjs:727` 支持 `pnpm --dir`。

### 数据与状态变更

- `review-ledger.mjs` 回执复用字段保持现有账本与 `receipt` Schema 兼容；`verify-state.mjs` 缓存键增加槽位隔离维度（不破坏历史读兼容）。

### 异常、回退与安全边界

- 所有放行理由（如离线 `generic-git` `--reason`）走 `evaluateReleaseReason` 防敷衍校验；`mcp-delegate` 未收到明确合并事实前必须阻断而非伪装 `merged`；`BLOCKED_HUMAN_MERGE_AUTHORITY` 严格退出码 `4`（`EXIT.HUMAN`）。

### 实现顺序

1. 修复 `review-empirical.mjs`（L92 去 `|| hasDevProfileTestCmds`、L420、全 `none` 文档仓）、`review-empirical-state.mjs`、`agents-defaults.mjs`、`workflow-policy.mjs`、`workflow-helpers.mjs` 与 `workflow-policy-next.mjs`。
2. 改造 `review-ledger.mjs`、`review-locks.mjs`，并将 `isUiVisualFile` 细化辅助抽入 `empirical-artifacts.mjs`、接入 `static-gates.mjs`（含 L383 `mergeAuthority` 收窄）。
3. 从 `flow-lifecycle-helpers.mjs` 抽离 precheck 辅助至 `flow-lifecycle-hooks.mjs`（L405 传 `implRoot`），改造 `flow-lifecycle.mjs`、`flow-lifecycle-finalize.mjs`、`flow-merge.mjs`、`task-backend-local.mjs`、`review-gates.mjs`（L568 `mergeAuthority` 收窄）、`flow-next.mjs`、`handoff-package.mjs`、`verify-tools.mjs`、`verify-state.mjs` 与 `scripts/dev/fixtures-govern.mjs:60`。
4. 运行 `node scripts/equip.mjs .` 并补充全套正反双向夹具。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 将 `faultRequired` 缩窄为仅 `riskTier === 'high'` | 排除中风险运行时用例 | 会打穿 `fixtures-r8-bugfixes.mjs:348-356` 已有断言并削弱常规运行时改动门禁 | 永不改回 |
| `flow-lifecycle-helpers.mjs` / `static-gates.mjs` 原地增行 | 在 795 / 792 行文件直接加逻辑 | 极易超过 800 行被 `preflight` 阻断 | 永不改回 |
| 直接删除 `review-ledger.mjs:121` 非空校验 | 删掉 `if (!evidenceRaw)` | 会直接打穿 `I117` 故障注入与无回执空审防线 | 永不改回 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-empirical-state.mjs`、`scripts/lib/agents-defaults.mjs` | 修改 | 修复省略 smoke 死锁、L92 仅去 `hasDevProfileTestCmds`、纯库默认值、全 `none` 文档仓 | `check-empirical` 与 `S3` |
| `kit/skills/dev-review/scripts/review-ledger.mjs`、`review-locks.mjs` | 修改 | 回执复用（保 `I117`）、去三重拼接、统一实质判据 | 审查记账 |
| `kit/skills/lib/static-gates.mjs`、`empirical-artifacts.mjs`、`exit-codes.mjs`、`flow-lifecycle*.mjs` | 修改 | `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs`、`BLOCKED_HUMAN_MERGE_AUTHORITY` 迁至 `HUMAN_CODES`（`4`）、precheck 辅助抽入 `flow-lifecycle-hooks.mjs`、`implRoot` 透传、`flow-lifecycle-helpers.mjs:620` 去矛盾提示、`quick --target` 提速 | `flow verify`、`finalize` 与退出码对拍 |
| `kit/skills/dev-flow/scripts/flow-merge.mjs`、`task-backend-local.mjs`、`review-gates.mjs`、`scripts/dev/fixtures-govern.mjs` | 修改 | `mcp-delegate` L657-722 守卫 `!mergeRes \|\| mergeRes?.delegated === true \|\| mergeRes?.ok === false`、`generic-git` 离线 reason、`mergeAuthority` 收窄与退出码 `4`、更新 `fixtures-govern.mjs:60` | `flow merge` 与审查门 |
| `flow-next.mjs`、`handoff-package.mjs`、`workflow-*.mjs`、`verify-tools.mjs`、`verify-state.mjs` | 修改 | `posixPath`、`pack` 命令、`parseAgentsProfile` 复用、`verify-tools` 三处修复、`pnpm --dir` | 交棒与验证工具 |

- **对外可见的变化**：`review-pack record` 支持自动复用匹配 `HEAD` 的 `check-empirical` 回执；`BLOCKED_HUMAN_MERGE_AUTHORITY` 统一返回退出码 `4`；非弱化门禁的 `one-way` 差异交由 `reviewer-with-fault-injection` 处理；纯文档仓（四项 `none`）与纯库新仓不再被 `smoke-verify` 误阻断。
- **需要同步改的地方**：执行 `node scripts/equip.mjs .`；同步更新 `scripts/dev/fixtures-govern.mjs:60` 及新增正反双向夹具。

## 五、冻结的验收标准

- [x] C5: `review-empirical.mjs:420` 与 `review-empirical-state.mjs:316` 解决省略 `smoke-verify` 死锁，`scripts/lib/agents-defaults.mjs:406` 优化纯库/CLI 新手配置，将 `review-empirical.mjs:92` `faultRequired` 精确调整为 `!isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired)`（仅移除 `|| hasDevProfileTestCmds`，保留高风险 `smoke-verify: none` 及 `fixtures-r8-bugfixes.mjs:348-356` 中风险运行时样本触发 `faultRequired === true`），且四项 Dev Profile 全 `explicitNone` 纯文档仓经静态校验通过 `check-empirical`。
- [x] C6: `review-ledger.mjs` `record` 自动复用同 `HEAD` 有效 `check-empirical` 回执（保留 L121 `if (!evidenceRaw) {` 供 `I117`）、消除 L426-438 `empParts` 三重拼接、统一 `evaluateObservationSubstance` 与 `validateE2eEvidenceText`、取消仅为附着文本重跑 `flow verify --mode smoke`。
- [x] C7: 从 `flow-lifecycle-helpers.mjs`（795 行）抽离 precheck 辅助至 `flow-lifecycle-hooks.mjs` 并于 L405 透传 `implRoot`（两文件均 `<= 800` 行）；`flow-lifecycle.mjs:330` precheck 前置于命令执行、`flow-lifecycle-helpers.mjs:620` 移除矛盾 `--visual-checked` 提示、`flow-lifecycle.mjs:94,402` 在 `quick --target` 内循环跳过 `--final` edit-gate 与重复 `govern-audit`；将细化 `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs`（`static-gates.mjs <= 800` 行），统一 `empirical-artifacts.mjs` 标准并豁免非 UI README `.svg` 与模板。
- [x] C8: 收窄 `static-gates.mjs:383`（`classifyDoorType` 接受由 `review-gates.mjs:518,525` 透传的 `untrustedSurface = false`）与 `review-gates.mjs:568` `mergeAuthority = 'human-required'` 为 `gateWeakened || humanAuth || untrustedSurface`（同步 `scripts/dev/fixtures-govern.mjs:60`），将 `kit/skills/lib/exit-codes.mjs:133` `BLOCKED_HUMAN_MERGE_AUTHORITY` 从 `FACT_CODES` 迁至 `HUMAN_CODES`（`4`）并使 `flow-merge.mjs:501-503` 返回 `EXIT.HUMAN`（`4`，通过 `exit-code-parity.mjs:152`）；在 `flow-merge.mjs:657-722` 阻断 `!mergeRes || mergeRes?.delegated === true || mergeRes?.ok === false`（覆盖 `!ledger.prNumber && !ledger.branch` 及 `prNumber === null` 落入 `GitHubBackend.mergePr`）；补齐 `generic-git` 离线 `--reason` 校验（对齐 `task-backend-local.mjs:523`）、修复 `flow-lifecycle-finalize.mjs:229,243`、`workflow-helpers.mjs:43`、`flow-next.mjs:346`、`handoff-package.mjs:338-342`、`verify-tools.mjs:65,129,392`、`workflow-policy.mjs:727`，同步 `node scripts/equip.mjs .` 并全绿通过 `preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs --jobs 4`。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`；回滚做法：执行 `git revert` 并重跑 `node scripts/equip.mjs .`。
- **高风险路径**：触及 `kit/` 与 `SKILL.md` 边界（实证门禁、UI 产物判定、`mergeAuthority` 与合并退出码）。
- **故障注入预演**：保留 `review-ledger.mjs:121`（`I117`）触发路径，运行 `node scripts/dev/verify-injections.mjs --jobs 4` 复验全量通过。

## 澄清与补充记录

- 已根据 Round 1 Critique 校准 `faultRequired` 公式、`mergeAuthority` 收窄与 `EXIT.HUMAN`（`4`）、`mcp-delegate` `prNumber === null` 假合并根因及 `static-gates.mjs`/`flow-lifecycle-helpers.mjs` 800 行抽离目标。

## 实现说明

- **实际落地摘要**：完成 C5–C8 全部工程收敛：`review-empirical*.mjs` 与 `scripts/lib/agents-defaults.mjs` 解决省略 `smoke-verify` 死锁、纯库/CLI 默认值与全 `none` 文档仓放行并收窄 `faultRequired`（去 `|| hasDevProfileTestCmds`）；`review-ledger.mjs`、`review-locks.mjs`、`evidence-substance.mjs`、`verify-state.mjs`、`workflow-policy.mjs` 实现同 HEAD 有效 `check-empirical` 回执自动复用（保留 `I117`）、去三重拼接、统一实质判据并消除 `smoke --e2e-evidence` 重复重跑；抽离 `runVerifyPrecheck` 至 `flow-lifecycle-hooks.mjs` 并抽离 `isUiVisualFileCandidate` 至 `empirical-artifacts.mjs` 使 `flow-lifecycle-helpers.mjs`（758 行）、`static-gates.mjs`（788 行）、`review-gates.mjs`（792 行）均严守 800 行上限；`flow-merge.mjs` 与 `task-backend-local.mjs` 堵住空/委托 `mergeRes` 穿透并补齐离线 `generic-git` `--reason` 校验，收窄 `mergeAuthority === 'human-required'` 且 `BLOCKED_HUMAN_MERGE_AUTHORITY` 统一返回 `EXIT.HUMAN`（`4`），修复 `flow-lifecycle-finalize.mjs`、`workflow-helpers.mjs`、`flow-next.mjs`、`handoff-package.mjs`、`verify-tools.mjs`、`workflow-policy.mjs` 收尾缺陷并补全正反双向回归夹具。
- **与草案的差异**：因 `isUiVisualFile` 架构图豁免单源收敛进 `kit/skills/lib/empirical-artifacts.mjs`，同步更新 `scripts/dev/injections-data-visual-engine.mjs`（`I961`）指向该单源实现并通过复验。
- **关联同步文件**：`kit/` 与 `.agents/skills/`（经 `equip.mjs .` 全量同步）、`scripts/lib/agents-defaults.mjs`、`scripts/dev/fixtures-govern.mjs`、`scripts/dev/fixtures-plan-wave-slices.mjs`、`scripts/dev/fixtures-review-token.mjs`、`scripts/dev/fixtures-r5-onboarding.mjs`、`scripts/dev/fixtures-review-empirical.mjs`、`scripts/dev/fixtures-empirical-cycle.mjs`、`scripts/dev/fixtures-e2e-gate.mjs`、`scripts/dev/injections-data-visual-engine.mjs`。
