---
kind: spec
title: 核心状态完整性与工作流闭环加固
status: draft
tier: L3
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/conv-arch-plan
owner: planner-conv-arch
plan_mode: interactive
approved: false
implemented: false
plan_critique: pending
task_id: core-state-integrity
related_prd: ../prd/261124-conversational-state-machine-prd.md
related_todo: ../todo/261124-core-state-integrity-todo.md
depends_on: []
scope_files:
  - kit/skills/dev-plan/scripts/doc-plan-ops.mjs
  - kit/skills/lib/critique-store.mjs
  - kit/skills/lib/critique-rounds.mjs
  - kit/skills/lib/critique-diff.mjs
  - kit/skills/lib/plan-next.mjs
  - kit/skills/dev-flow/scripts/flow-sync.mjs
  - kit/skills/dev-flow/scripts/flow-merge.mjs
  - kit/skills/dev-flow/scripts/flow-cleanup.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle.mjs
  - kit/skills/dev-flow/scripts/flow-inspect.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs
  - kit/skills/dev-flow/scripts/flow-start-helpers.mjs
  - kit/skills/dev-explore/scripts/repo-map.mjs
  - kit/skills/dev-review/scripts/review-pack.mjs
  - kit/skills/dev-review/scripts/review-diff.mjs
  - kit/skills/dev-review/scripts/review-ledger.mjs
  - kit/skills/dev-review/scripts/review-locks.mjs
  - kit/skills/dev-review/scripts/review-empirical.mjs
  - kit/skills/lib/criteria-lock.mjs
  - kit/skills/lib/handoff-package.mjs
  - scripts/dev/fixtures*.mjs
high_risk_paths:
  - kit/
---

# 核心状态完整性与工作流闭环加固 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块重构、状态机契约修复与高风险门禁；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / Issue / PR | `feat/conv-arch-plan` / `#169` / 未关联 |
| 负责人 / 内审状态 | planner-conv-arch / `pending` |
| 规划态 | `interactive`（关键设计与 5 项决策已确认，待拍板为零） |
| 关联 PRD / Todo | `docs/prd/261124-conversational-state-machine-prd.md` / `docs/todo/261124-core-state-integrity-todo.md` |

- **变更一句话**：修复规划澄清与 Critique 账本、Flow 生命周期与自合防线、Review 槽位钉住及 Criteria 冻结与交接包中的全部状态完整性缺口。

## 系统变更全景

```mermaid
flowchart LR
  Plan["规划澄清与内审"] --> Flow["隔离流转与合入"]
  Flow --> Review["槽位钉住与实证"]
  Review --> Lock["标准冻结与交接"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/dev-plan/scripts/doc-plan-ops.mjs` | 改造 | `clarifyDoc` 同步更新待拍板区；`approveSpec` 放行 `critique-continue` 后再过审 |
| `kit/skills/lib/critique-store.mjs` | 改造 | `commondir` 解析侧车、账本/sidecar 合并、异步写加文件锁 |
| `kit/skills/lib/critique-rounds.mjs`、`critique-diff.mjs`、`plan-next.mjs` | 改造 | `fromSha`/`roundBaseline` 停损基线、`continued` 状态流转与 R2 作用域 |
| `kit/skills/dev-flow/scripts/flow-sync.mjs`、`flow-merge.mjs`、`flow-cleanup.mjs` | 改造 | 清洁变基清冲突、自合拦截、abort 租约/分支与产物清理 |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-inspect.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs` | 改造 | 本地 `lastSubmittedHead`、verify 槽位边界、`in-place` 复用、原子更新账本 |
| `kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs` | 改造 | `review-<id>` 槽位钉住、有效基线与 `check-fault` 双阶段强制校验 |
| `kit/skills/lib/criteria-lock.mjs`、`flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs`、`kit/skills/lib/handoff-package.mjs` | 改造 | 归档重绑 `criteriaFrozenFrom`、去死字段、冻结全链路守卫与交接上下文渲染 |

## 一、背景与边界声明

- **要改什么**：修复 Wave 1 中 `dev-plan`、`dev-flow`、`dev-review`、`dev-explore` 与 `kit/skills/lib/` 状态账本、工作树槽位、基线 SHA 及冻结标准的一致性缺陷，并补齐正反双向 `scripts/dev/fixtures.mjs` 用例。
- **不改什么**：不引入多主题 `session-state.mjs` v2 Schema、不新建 `mutability.mjs`、不更改 CLI 公共标志规范名与 `SKILL.md` 体积门禁（均留待 Wave 2 / Wave 3）。
- **本期不做**：不在本切片修改 `kit/skills/*/SKILL.md` 文案、`AGENTS.md` 或 `templates/agents-project.md`。
- **复用既有模块**：复用 `kit/skills/lib/git.mjs`（`withFileLockSync`、`writeJsonAtomic`、`readJsonSafe`）、`kit/skills/lib/ledger.mjs`（`updateTaskLedger`）、`kit/skills/lib/workflow-policy.mjs`（`resolveEffectiveBaseSha`）与 `kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`（`checkTaskSlotBoundaryOrEmit`）。
- **架构基线关系**：严格遵守零第三方依赖、单一真相源与工作树隔离原则，符合 `docs/TDD.md` 不变量。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **规划澄清与 Critique 状态流转**：
   - `kit/skills/dev-plan/scripts/doc-plan-ops.mjs`：`clarifyDoc` 写入 `## 澄清与补充记录` 的同时，匹配并更新 `## 待拍板问题` 中对应条目为已确认/已消解状态，使 `BLOCKED_PENDING_DECISIONS` 立即清空；`approveSpec` 判定历史停损时，若存在 `critique-continue` 后产生的更新 `critique-pass`（且其轮次晚于 `roundsAtContinue`），允许批准通过。
   - `kit/skills/lib/critique-store.mjs`：`sidecarCritiqueFile` 使用 `resolveEffectiveRoots` 解析出的 `commondir` 定位共享 Git 目录（确保主仓与工作树读写同一份 sidecar）；`readPlanCritiqueEntrySync` 在任务账本存在但缺条目时回退或合并 sidecar 历史；`persistPlanCritiqueEntry` 增加文件锁（对齐同步版本 `withFileLockSync` 或异步重试锁）防止并发覆盖。
   - `kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/critique-diff.mjs`、`kit/skills/lib/plan-next.mjs`：`critiqueContinueDoc` 记录 `fromSha` 与 `roundBaseline`（当前已有轮次基线），若作用于 `approved` 文档则撤销 `approved: false` 并回退状态；`critiquePassDoc` / `critiqueRejectDoc` / `critiqueOverrideDoc` 执行后显式清理 `continued.active = false`；`evaluateThreeRoundStopLoss` 相对 `roundBaseline` 计算续审轮次而非总历史轮次；`evaluateRound2CritiqueScope` 将 `continued.reason` 纳入合法 R2 审查作用域；`plan-next.mjs` 在文档编辑期间保持 `continueActive` 存活直至下一次 Critique 轮次落盘。
2. **Flow 同步、合并、终止与生命周期边界**：
   - `kit/skills/dev-flow/scripts/flow-sync.mjs`：上游变基清洁完成后清除 `queueConflict` 与冲突导致的 `rework` 标志，并刷新 `finalizedHead`；卸载共享依赖时传入 `mountedPaths` 给 `unmountSharedDeps`。
   - `kit/skills/dev-flow/scripts/flow-merge.mjs`：`callerActor` 解析纳入 `opts['reviewer-id']`，杜绝传 `--reviewer-id` 指向实施者时绕过 `BLOCKED_SELF_MERGE`。
   - `kit/skills/dev-flow/scripts/flow-cleanup.mjs`（`handleAbort`）：向 `releaseGitClaimLease` 传入 `remoteUrls`；显式校验 `git branch -d/-D` 退出码（非零即阻断报告）；清理任务私有目录 `private-docs/`、工作区 `evidence.json` 与 `review-empirical.json`。
   - `kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-inspect.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`：`local-only` / `generic-git` 模式执行 `submit` 时写入 `lastSubmittedHead`；`handleVerify` 开头接入 `checkTaskSlotBoundaryOrEmit`；`flow start` 支持 `isolation === 'in-place'` 的既有任务复用；`repo-map --task` 使用 `updateTaskLedger` 原子更新账本。
3. **Review 槽位钉住、实证与标准冻结闭环**：
   - `kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs`：`--include-diff` 与 `record` 严格钉住 `review-<id>` 隔离槽位及其当前已审 `headSha`（审查过程中禁止快进同步或越界读取 `impl-<id>` 工作区）；卸载依赖传 `mountedPaths`；`evaluatePassBlockers` 使用 `resolveEffectiveBaseSha` 解析有效基线；当 `faultRequired` 为真时，`evaluateIncludeDiffGate` 强制要求存在 `check-fault:fail` 与 `check-fault:restore` 双阶段收据。
   - `kit/skills/lib/criteria-lock.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs`、`kit/skills/lib/handoff-package.mjs`：`finalize` 将规范归档至 `docs/archive/specs/` 时同步更新 `ledger.criteriaFrozenFrom` 为归档后相对路径；`flow start` 遇到建账前已批准文档时自动回填 `criteriaFingerprint` 与 `criteriaFrozenFrom`；删除死字段 `frozenCriteriaSnapshot` 及其无用分支；在 `submit` 与 `review-pack record` 入口强制执行 `checkFrozenCriteria`；`buildHandoff` 渲染 `issueContext` / `prContext`，`locateCommand` 使用动态 `--section "<matched heading>"`，并在 `## 怎么算做完` 输出 `smoke-verify` 校验指令。

### 数据与状态变更

- `ledger.planCritique[relDoc].continued` 新增 `fromSha` 与 `roundBaseline`；`pass` / `reject` / `override` 后置 `active: false`。
- `ledger.criteriaFrozenFrom` 随 `finalize` 归档迁移更新；移除死字段 `ledger.frozenCriteriaSnapshot`；本地提交补齐 `ledger.lastSubmittedHead`。

### 异常、回退与安全边界

- 当 `critique-continue` 在 `approved` 文档上触发时，强制撤销 `approved` 状态避免旧批准戳继续生效。
- 当 `review-pack` 在 `review-<id>` 槽位检测到 `headSha` 漂移或 `faultRequired` 缺少 `fail`/`restore` 成对收据时，硬阻断并返回非零退出码。
- 所有状态回退可通过单个 `git revert` 恢复；sidecar 合并仅做非破坏性补全。

### 实现顺序

1. 修复 `critique-store.mjs`、`critique-rounds.mjs`、`critique-diff.mjs`、`plan-next.mjs` 与 `doc-plan-ops.mjs`（规划状态单源闭环）。
2. 修复 `flow-sync.mjs`、`flow-merge.mjs`、`flow-cleanup.mjs`、`flow-lifecycle.mjs`、`flow-inspect.mjs`、`repo-map.mjs`（工作流状态与槽位闭环）。
3. 修复 `review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs` 与 `criteria-lock.mjs` / `flow-lifecycle-finalize.mjs` / `flow-start-helpers.mjs` / `handoff-package.mjs`（审查钉住与标准冻结交接闭环）。
4. 补充正反双向 fixture，运行 `preflight.mjs` 与 `fixtures.mjs` 全绿验证。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 保留 `frozenCriteriaSnapshot` 并补写快照文本 | 在 `approve` 时把全部标准文本存进账本 | 增加账本膨胀且 Git 历史已存原文，维护成本高 | 若未来支持非 Git 无历史环境逐条 diff 展示 |
| 在 `review-pack --include-diff` 时自动快进 `review-<id>` 到最新 `impl-<id>` | 每次打包都同步最新代码 | 会导致审查中途代码漂移、`record` 签发给未审提交 | 永不改回（破坏独立审查不可变前提） |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/dev-plan/scripts/doc-plan-ops.mjs` | 修改 | `clarifyDoc` 清待拍板；`approveSpec` 支持 `continue` 后过审 | `doc-plan clarify` / `approve` |
| `kit/skills/lib/critique-store.mjs`、`critique-rounds.mjs`、`critique-diff.mjs`、`plan-next.mjs` | 修改 | `commondir` 侧车、异步锁、`roundBaseline` 停损与 R2 作用域 | `doc-plan critique-*` / `next` |
| `kit/skills/dev-flow/scripts/flow-sync.mjs`、`flow-merge.mjs`、`flow-cleanup.mjs`、`flow-lifecycle.mjs`、`flow-inspect.mjs`、`flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs` | 修改 | rebase 清冲突、自合防线、abort 清理、verify 槽位、`submit` 冻结校验与 `in-place` 复用 | `flow` 全周期命令与 `repo-map --task` |
| `kit/skills/dev-explore/scripts/repo-map.mjs` | 修改 | `--task` 使用 `updateTaskLedger` 原子更新 | `repo-map --task` |
| `kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs` | 修改 | 钉住 `review-<id>` 与 `headSha`、`resolveEffectiveBaseSha`、`faultRequired` 门禁 | `review-pack` 全子命令 |
| `kit/skills/lib/criteria-lock.mjs`、`kit/skills/lib/handoff-package.mjs` | 修改 | 归档重绑路径、移除死字段、交接包渲染上下文与 `smoke-verify` | `flow next --handoff` / `finalize` / `submit` |

- **对外可见的变化**：错误拦截更严格（`BLOCKED_SELF_MERGE`、`BLOCKED_CRITERIA_DRIFT`、`check-fault` 门禁），`buildHandoff` 输出包含 `issueContext`/`prContext`、`smoke-verify` 与精确 `--section`。
- **需要同步改的地方**：`.agents/skills/`（执行 `node scripts/equip.mjs .`）、`scripts/dev/fixtures*.mjs`。

## 五、冻结的验收标准

- [ ] C1: `clarifyDoc` 更新 `## 待拍板问题` 使 `doc-plan audit` 不再报 `BLOCKED_PENDING_DECISIONS`；`approveSpec` 放行 `critique-continue` 后新获 `critique-pass` 的文档；`critique-store.mjs` 用 `commondir` 解析 sidecar、合并 sidecar 历史并在 `persistPlanCritiqueEntry` 加文件锁；`critiqueContinueDoc` 写 `fromSha` 与 `roundBaseline`、撤销已批文档 `approved`、`pass`/`reject`/`override` 后置 `continued.active=false`、停损按 `roundBaseline` 计算、R2 范围纳入 `continued.reason` 且 `plan-next.mjs` 在编辑期保持 `continueActive`，由 `node scripts/dev/fixtures.mjs` 正反用例断言通过。
- [ ] C2: `flow-sync.mjs` 在清洁 upstream rebase 后清除 `queueConflict` 与冲突重做状态并刷新 `finalizedHead`，卸载传入 `mountedPaths`；`flow-merge.mjs` 将 `opts['reviewer-id']` 纳入 `callerActor` 阻断自合；`flow-cleanup.mjs` `handleAbort` 传 `remoteUrls` 给 `releaseGitClaimLease`、检查 `git branch -d/-D` 退出码并清理任务私有文档与实证残留；`flow-lifecycle.mjs` 为 `local-only`/`generic-git` `submit` 写入 `lastSubmittedHead` 且 `handleVerify` 调用 `checkTaskSlotBoundaryOrEmit`；`flow-inspect.mjs` 支持 `isolation === 'in-place'` 复用；`repo-map --task` 使用 `updateTaskLedger` 原子写入，由 `node scripts/dev/fixtures.mjs` 断言通过。
- [ ] C3: `review-pack.mjs` / `review-diff.mjs` / `review-ledger.mjs` / `review-locks.mjs` / `review-empirical.mjs` 在 `--include-diff` 与 `record` 严格钉住 `review-<id>` 槽位与已审 `headSha`（不中途快进或检查 `impl-<id>`），卸载传 `mountedPaths`，`evaluatePassBlockers` 调用 `resolveEffectiveBaseSha`，且 `faultRequired=true` 时 `evaluateIncludeDiffGate` 强制校验 `check-fault:fail` 与 `check-fault:restore` 收据，由 `node scripts/dev/fixtures.mjs` 正反用例断言通过。
- [ ] C4: `flow-lifecycle-finalize.mjs` 归档 SPEC 时同步更新 `criteriaFrozenFrom` 至 `docs/archive/specs/` 路径；`flow-start-helpers.mjs` 为预建账前已批准文档回填 `criteriaFingerprint`；`criteria-lock.mjs` 移除死字段 `frozenCriteriaSnapshot` 并在 `submit` 与 `review-pack record` 强制执行 `checkFrozenCriteria`；`handoff-package.mjs` `buildHandoff` 渲染 `issueContext`/`prContext`、动态 `--section` 标题及 `## 怎么算做完` 中的 `smoke-verify`，由 `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/preflight.mjs` 断言通过。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（涉及审查与合并防绕过门禁）；回滚做法：通过 `git revert` 反向提交还原，禁止改写远端历史。
- **高风险路径**：触及 `kit/`（全部内置技能库），改后须同步 `node scripts/equip.mjs .` 并通过 `node scripts/dev/preflight.mjs` 与 `node scripts/dev/e2e-zip-harness.mjs`。
- **故障注入预演**：复用 `node .agents/skills/dev-review/scripts/review-pack.mjs check-fault --phase fail` / `restore`，注入自合放行或跳过 `checkFrozenCriteria` 的故障以验证门禁必红并复绿。

## 澄清与补充记录

- （本轮无额外澄清补充；全部设计边界已由总控 PRD 确认，待拍板为零）

## 实现说明

- **实际落地摘要**：
- **与草案的差异**：
- **关联同步文件**：
