---
kind: spec
title: 核心状态完整性与工作流闭环加固
status: draft
tier: L3
created: 2026-11-24
updated: 2026-11-25
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
  - kit/skills/dev-flow/scripts/flow-merge-claim.mjs
  - kit/skills/dev-flow/scripts/flow-cleanup.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs
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
  - kit/skills/lib/pr-template-hydrate.mjs
  - kit/skills/lib/github-client.mjs
  - kit/skills/lib/review-comment-render.mjs
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
| 创建 / 更新 | `2026-11-24` / `2026-11-25` |
| 分支 / Issue / PR | `feat/conv-arch-plan` / `#169` / 未关联 |
| 负责人 / 内审状态 | planner-conv-arch / `pending` |
| 规划态 | `interactive`（关键设计与 5 项决策已确认，待拍板为零） |
| 关联 PRD / Todo | `docs/prd/261124-conversational-state-machine-prd.md` / `docs/todo/261124-core-state-integrity-todo.md` |

- **变更一句话**：修复规划澄清与 Critique 账本、Flow 生命周期（含 `planBootstrap` 一等状态、`claim --agent`、Markdown 折叠防护与默认常青同步）、Review 槽位钉住及 Criteria/Handoff 渲染与冻结中的全部状态完整性缺口。

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
| `kit/skills/lib/critique-store.mjs`、`critique-rounds.mjs`、`critique-diff.mjs`、`plan-next.mjs` | 改造 | `commondir` 侧车、账本/sidecar 合并、异步文件锁、`fromSha`/`roundBaseline` 与 R2 作用域 |
| `kit/skills/dev-flow/scripts/flow-sync.mjs`、`flow-merge.mjs`、`flow-merge-claim.mjs`、`flow-cleanup.mjs` | 改造 | 清洁变基清冲突、自合拦截、`claim --agent` 双层归属、abort 租约/分支与产物清理 |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-lifecycle-hooks.mjs`、`flow-inspect.mjs`、`flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs` | 改造 | `planBootstrap` 一等态、默认 `docs/feature-map.json` 与 Case 2 结构漂移守卫、本地 `lastSubmittedHead`、`in-place` 复用 |
| `kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/github-client.mjs` | 改造 | `updateTaskLedger` 原子写、`Part of #N` 与文档链接渲染、`BLOCKED_MALFORMED_MARKDOWN_BODY` 守卫 |
| `kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs`、`kit/skills/lib/review-comment-render.mjs` | 改造 | `review-<id>` 槽位钉住、有效基线、`check-fault` 校验、统一 `C1..Cn` 提取优先级与 `--summary` 渲染 |
| `kit/skills/lib/criteria-lock.mjs`、`kit/skills/lib/handoff-package.mjs` | 改造 | 归档重绑 `criteriaFrozenFrom`、去死字段、冻结全链路守卫与 Case 2 Issue `C*` 交接渲染 |

## 一、背景与边界声明

- **要改什么**：修复 Wave 1 中 `dev-plan`、`dev-flow`、`dev-review`、`dev-explore` 与 `kit/skills/lib/` 状态账本、工作树槽位、基线 SHA、`planBootstrap` 引导流、Markdown 折叠防护、默认常青文档同步与审查/交接标准提取一致性缺陷，并补齐正反双向 `scripts/dev/fixtures.mjs` 用例。
- **不改什么**：不引入多主题 `session-state.mjs` v2 Schema、不新建 `mutability.mjs`、不更改 CLI 公共标志规范名与 `SKILL.md` 体积门禁（均留待 Wave 2 / Wave 3）。
- **本期不做**：不在本切片修改 `kit/skills/*/SKILL.md` 文案、`AGENTS.md` 或 `templates/agents-project.md`。
- **复用既有模块**：复用 `kit/skills/lib/git.mjs`（`withFileLockSync`、`writeJsonAtomic`、`readJsonSafe`）、`kit/skills/lib/ledger.mjs`（`updateTaskLedger`）、`kit/skills/lib/workflow-policy.mjs`（`resolveEffectiveBaseSha`）、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`（`checkTaskSlotBoundaryOrEmit`、`checkFeatureMapSyncOnFinalize`）、`kit/skills/lib/tdd-parity.mjs`（`checkTddSyncParity`）与 `kit/skills/lib/doc-substantive.mjs`（`evaluateMasterPrdClosureState`）。
- **架构基线关系**：严格遵守零第三方依赖、单一真相源与工作树隔离原则，符合 `docs/TDD.md` 不变量。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **规划澄清与 Critique 状态流转**：
   - `kit/skills/dev-plan/scripts/doc-plan-ops.mjs`：`clarifyDoc` 写入 `## 澄清与补充记录` 的同时，匹配并更新 `## 待拍板问题` 中对应条目为已确认/已消解状态，使 `BLOCKED_PENDING_DECISIONS` 立即清空；`approveSpec` 判定历史停损时，若存在 `critique-continue` 后产生的更新 `critique-pass`（且轮次晚于 `roundsAtContinue`），允许批准通过。
   - `kit/skills/lib/critique-store.mjs`：`sidecarCritiqueFile` 使用 `resolveEffectiveRoots` 解析出的 `commondir` 定位共享 Git 目录；`readPlanCritiqueEntrySync` 在任务账本存在但缺条目时回退或合并 sidecar 历史；`persistPlanCritiqueEntry` 增加文件锁防止并发覆盖。
   - `kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/critique-diff.mjs`、`kit/skills/lib/plan-next.mjs`：`critiqueContinueDoc` 记录 `fromSha` 与 `roundBaseline`，若作用于 `approved` 文档则撤销 `approved: false` 并回退状态；`critiquePassDoc` / `critiqueRejectDoc` / `critiqueOverrideDoc` 执行后置 `continued.active = false`；`evaluateThreeRoundStopLoss` 相对 `roundBaseline` 计算续审轮次；`evaluateRound2CritiqueScope` 将 `continued.reason` 纳入合法 R2 作用域；`plan-next.mjs` 在编辑期间保持 `continueActive` 存活直至下一次 Critique 轮次落盘。
2. **Flow 同步、合入、归属、`planBootstrap` 与默认常青同步**：
   - `kit/skills/dev-flow/scripts/flow-sync.mjs`：清洁变基后清除 `queueConflict` 与冲突导致的 `rework` 标志并刷新 `finalizedHead`；卸载时向 `unmountSharedDeps` 传入 `mountedPaths`。
   - `kit/skills/dev-flow/scripts/flow-merge.mjs`、`flow-merge-claim.mjs`：`callerActor` 解析纳入 `opts['reviewer-id']` 阻断 `BLOCKED_SELF_MERGE`；`handleClaim` 统一接受并继承 `--agent`，使 Issue/PR 认领评论输出 `@<login> (<agent>)` 与 `submit` 保持双层归属对齐。
   - `kit/skills/dev-flow/scripts/flow-cleanup.mjs`（`handleAbort`）：向 `releaseGitClaimLease` 传入 `remoteUrls`；显式校验 `git branch -d/-D` 退出码；清理 `private-docs/`、`evidence.json` 与 `review-empirical.json`。
   - `kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`：`local-only`/`generic-git` `submit` 写入 `ledger.lastSubmittedHead`；`handleVerify` 接入 `checkTaskSlotBoundaryOrEmit`；`flow start` 支持 `isolation === 'in-place'` 复用；`repo-map --task` 使用 `updateTaskLedger` 原子更新账本。
   - **`planBootstrap` 一等状态**（`flow-inspect.mjs`、`flow-lifecycle-finalize.mjs`、`pr-template-hydrate.mjs`、`flow-lifecycle.mjs`）：`flow start --allow-plan-bootstrap` 显式写入 `ledger.planBootstrap = true` 并保持 `prdFile`/`specFile`/`todoFile` 绑定（未显式绑定时从 `changedFiles` 推断活跃 `docs/(prd|specs|todo)/*.md`）；`finalize` 在 `planBootstrap === true` 时仅执行校验锁而不对活跃规划文档做 `git mv` 归档；`hydratePrTemplateBody` 在 `ledger.planBootstrap === true` 或 `#<N>` 为未达到 `close-complete` 的 1:N 总控 PRD Issue（经 `evaluateMasterPrdClosureState` 判定）时自动输出 `Part of #<N>`（替代 `Fixes #<N>`）并列出真实规划文档链接；`planBootstrap` 执行 `submit` 时把实际生成的 PRD + 切片 SPEC/Todo 列表同步写回关联总控 Issue（替换占位产物描述），且引导 PR 合入不自动关闭总控 Issue。
   - **Markdown 折叠防线**（`pr-template-hydrate.mjs`、`github-client.mjs`）：提供 `assertWellFormedMarkdownBody(body)`，当多章节正文被压成单行（同一行出现 `>= 2` 次 `## ` 标题，或多章节输出总行数 `<= 2`）时以 `BLOCKED_MALFORMED_MARKDOWN_BODY` 快速阻断失败。
   - **默认常青同步对齐（零新增标志）**（`flow-lifecycle-hooks.mjs`、`flow-lifecycle.mjs`）：将 `checkFeatureMapSyncOnFinalize` 升级为默认阻断（`BLOCKED_FEATURE_MAP_SYNC`，退出码 `1`；遇 `no-tdd`/`--no-tdd` 或仓库无 `docs/feature-map.json` 时跳过），同时检测「新增未覆盖核心模块」与「已删除/重命名但仍残留在 `docs/feature-map.json` 的失效路径」（对未增删改名核心模块的内部 bugfix 零误报）；并在 `flow verify` 中对确实新增/删除/重命名非测试核心源码模块的 Case 2 任务复用 `checkTddSyncParity` 与 `checkFeatureMapSyncOnFinalize`（常规原地 Case 2 修复零触发）。
3. **Review 槽位钉住、统一标准提取与 Criteria/Handoff 闭环**：
   - `kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs`、`kit/skills/lib/review-comment-render.mjs`：`review-pack --include-diff` 与 `record` 钉住 `review-<id>` 槽位及已审 `headSha`（审查中途不快进或读取 `impl-<id>`）；卸载向 `unmountSharedDeps` 传 `mountedPaths`；`evaluatePassBlockers` 使用 `resolveEffectiveBaseSha`；`faultRequired` 时 `evaluateIncludeDiffGate` 强制校验 `check-fault:fail` 与 `check-fault:restore`；`review-ledger.mjs` 建立统一标准提取优先级 `SPEC > Todo > PRD > planBootstrap 变更文档 > 关联 Issue 正文（Case 2 经 ledger.issueContext）`，确保 Case 2/3/4 与引导 PR 均渲染 `#### 验收标准逐条核对`；`buildReviewComments` 透传并渲染审查结论 `- **审查结论**：...`（`--summary`）。
   - `kit/skills/lib/criteria-lock.mjs`、`flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs`、`kit/skills/lib/handoff-package.mjs`：归档 SPEC 时同步更新 `ledger.criteriaFrozenFrom` 至 `docs/archive/specs/`；`flow start` 为建账前已批准文档回填 `criteriaFingerprint`；移除死字段 `ledger.frozenCriteriaSnapshot`；在 `submit` 与 `review-pack record` 强制执行 `checkFrozenCriteria`；`buildHandoff` 复用同一优先级链为 Case 2 从 Issue 正文抽取 `C1..Cn`，并渲染 `issueContext`/`prContext`、`locateCommand` 使用动态 `--section "<matched heading>"` 与 `## 怎么算做完` 中的 `smoke-verify`。

### 数据与状态变更

- `ledger` 新增 `planBootstrap: boolean`、`lastSubmittedHead`、`criteriaFrozenFrom` 随归档更新；移除死字段 `frozenCriteriaSnapshot`。
- `ledger.planCritique[relDoc].continued` 新增 `fromSha` 与 `roundBaseline`，`pass`/`reject`/`override` 后置 `active: false`。

### 异常、回退与安全边界

- `assertWellFormedMarkdownBody` 在写入 GitHub Issue/PR 正文或模板水合输出前执行 fail-close 阻断（`BLOCKED_MALFORMED_MARKDOWN_BODY`），禁止单行压扁多节 Markdown 发送到远端。
- `critique-continue` 作用于 `approved` 文档时强制撤销 `approved` 状态；`review-pack` 与 `checkFrozenCriteria` 发现基线或标准漂移立即阻断。
- 所有状态回退可通过单个 `git revert` 恢复。

### 实现顺序

1. 修复规划澄清与 Critique 存储/轮次状态机（`doc-plan-ops.mjs`、`critique-store.mjs`、`critique-rounds.mjs`、`critique-diff.mjs`、`plan-next.mjs`）。
2. 落地 `planBootstrap` 一等态、`claim --agent`、Markdown 折叠防护、默认 `docs/feature-map.json` / Case 2 结构同步及 Flow 生命周期修复。
3. 落地 Review 槽位钉住、统一 `C1..Cn` 提取与 `--summary` 渲染、`criteria-lock.mjs` 与 `handoff-package.mjs` 修复。
4. 补充正反双向 fixture，同步 `node scripts/equip.mjs .` 并全绿通过 `preflight.mjs` 与 `fixtures.mjs`。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 保留 `frozenCriteriaSnapshot` 原文快照 | `approve` 时把标准原文拷贝进账本 | 账本冗余膨胀且 Git 历史已保留原文 | 若未来支持无 Git 历史环境逐条展示差异 |
| 用 `--strict-feature-map` 新标志控制 `feature-map` 同步阻断 | 新增 CLI 开关由人工手动传入 | 新增开关徒增记忆负担且默认行为仍放过脏路径 | 永不改回（默认守卫、零新开关、`no-tdd` 显式豁免） |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/lib/critique-store.mjs`、`critique-rounds.mjs`、`critique-diff.mjs`、`plan-next.mjs` | 修改 | `clarifyDoc` 清待拍板、`commondir` 侧车、锁、`roundBaseline` 与 R2 作用域 | `doc-plan clarify`/`critique-*`/`approve`/`next` |
| `kit/skills/dev-flow/scripts/flow-sync.mjs`、`flow-merge.mjs`、`flow-merge-claim.mjs`、`flow-cleanup.mjs`、`flow-lifecycle.mjs`、`flow-lifecycle-hooks.mjs`、`flow-inspect.mjs`、`flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs` | 修改 | rebase 清冲突、自合防线、`claim --agent`、`planBootstrap`、默认常青同步、Case 2 漂移守卫、`abort` 清理、原子写账本 | `flow` 全周期命令与 `repo-map --task` |
| `kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/github-client.mjs` | 修改 | `Part of #N` 判定、`assertWellFormedMarkdownBody` 阻断单行折叠正文 | PR 水合与远端发布通道 |
| `kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs`、`kit/skills/lib/review-comment-render.mjs` | 修改 | `review-<id>` 钉住、有效基线、`check-fault`、统一 `C*` 提取与 `--summary` 渲染 | `review-pack` 全子命令 |
| `kit/skills/lib/criteria-lock.mjs`、`kit/skills/lib/handoff-package.mjs` | 修改 | 归档重绑 `criteriaFrozenFrom`、去死字段、冻结守卫、Case 2 `C*` 与上下文渲染 | `flow next --handoff`/`finalize`/`submit` |

- **对外可见的变化**：新增阻断码 `BLOCKED_MALFORMED_MARKDOWN_BODY`；`BLOCKED_FEATURE_MAP_SYNC` 升为默认阻断；`flow claim` 统一 `--agent` 归属；PR/Issue 评论新增逐条标准表与 `--summary` 结论；引导 PR 自动生成 `Part of #N` 并回写总控 Issue。
- **需要同步改的地方**：`.agents/skills/`（执行 `node scripts/equip.mjs .`）、`scripts/dev/fixtures*.mjs`。

## 五、冻结的验收标准

- [ ] C1: `clarifyDoc` 更新 `## 待拍板问题` 使 `doc-plan audit` 清空 `BLOCKED_PENDING_DECISIONS`；`approveSpec` 放行 `critique-continue` 后再 `critique-pass` 的文档；`critique-store.mjs` 用 `commondir` 解析 sidecar、合并 sidecar 历史并在 `persistPlanCritiqueEntry` 加文件锁；`critiqueContinueDoc` 写 `fromSha` 与 `roundBaseline`、撤销已批文档 `approved`、`pass`/`reject`/`override` 后置 `continued.active=false`、停损按 `roundBaseline` 计算、R2 范围纳入 `continued.reason` 且 `plan-next.mjs` 在编辑期保持 `continueActive`，由 `node scripts/dev/fixtures.mjs` 正反用例断言通过。
- [ ] C2: `flow-sync.mjs` 清洁 rebase 后清 `queueConflict` 与冲突重做状态、刷 `finalizedHead`、卸载传 `mountedPaths`；`flow-merge.mjs` 纳入 `opts['reviewer-id']` 阻断自合；`flow-merge-claim.mjs` `claim` 支持并继承 `--agent` 双层归属；`flow-cleanup.mjs` `handleAbort` 传 `remoteUrls`、校分支删除退出码并清残留；`flow-lifecycle.mjs`/`flow-inspect.mjs`/`repo-map.mjs` 落地本地 `lastSubmittedHead`、`handleVerify` 接入 `flow-lifecycle-hooks.mjs` `checkTaskSlotBoundaryOrEmit`、`in-place` 复用与 `updateTaskLedger` 原子写；`planBootstrap` 一等态保持文档绑定、不归档活跃文档、引导或未收口 1:N PR 自动生成 `Part of #<N>` 并同步规划清单回总控 Issue；`assertWellFormedMarkdownBody` 阻断折叠正文报 `BLOCKED_MALFORMED_MARKDOWN_BODY`；`checkFeatureMapSyncOnFinalize` 升级为默认 `BLOCKED_FEATURE_MAP_SYNC` 双向校验增删改名失效路径，且 Case 2 仅在增删改名核心模块时在 `verify` 联动校验，全部由 `node scripts/dev/fixtures.mjs` 正反用例断言通过。
- [ ] C3: `review-pack.mjs` / `review-diff.mjs` / `review-ledger.mjs` / `review-locks.mjs` / `review-empirical.mjs` 与 `kit/skills/lib/review-comment-render.mjs` 在 `--include-diff` 与 `record` 严格钉住 `review-<id>` 与已审 `headSha`（不中途快进或读 `impl-<id>`），卸载传 `mountedPaths`，`evaluatePassBlockers` 用 `resolveEffectiveBaseSha`，`faultRequired=true` 强制 `check-fault:fail`/`restore`；`review-ledger.mjs` 按 `SPEC > Todo > PRD > planBootstrap 变更文档 > 关联 Issue 正文` 统一提取 `C1..Cn` 并在 Case 2/3/4 与引导 PR 渲染 `#### 验收标准逐条核对`，且 `buildReviewComments` 渲染审查 `--summary`，由 `node scripts/dev/fixtures.mjs` 正反用例断言通过。
- [ ] C4: `flow-lifecycle-finalize.mjs` 归档 SPEC 时同步更新 `criteriaFrozenFrom` 至 `docs/archive/specs/`；`flow-start-helpers.mjs` 为预建账前已批准文档回填 `criteriaFingerprint`；`criteria-lock.mjs` 移除死字段 `frozenCriteriaSnapshot` 并在 `submit` 与 `review-pack record` 强制 `checkFrozenCriteria`；`handoff-package.mjs` `buildHandoff` 复用统一优先级为 Case 2 抽取 `C1..Cn`，并渲染 `issueContext`/`prContext`、动态 `--section` 标题与 `## 怎么算做完` 中的 `smoke-verify`，由 `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/preflight.mjs` 断言通过。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（涉及审查与合并防绕过门禁、PR 水合及默认常青阻断）；回滚做法：通过 `git revert` 反向提交还原，禁止改写远端历史。
- **高风险路径**：触及 `kit/`（全部内置技能库），改后须同步 `node scripts/equip.mjs .` 并通过 `node scripts/dev/preflight.mjs` 与 `node scripts/dev/e2e-zip-harness.mjs`。
- **故障注入预演**：复用 `node .agents/skills/dev-review/scripts/review-pack.mjs check-fault --phase fail` / `restore`，注入自合放行、单行折叠正文通过或跳过 `checkFrozenCriteria`/`BLOCKED_FEATURE_MAP_SYNC` 的故障以验证门禁必红并复绿。

## 澄清与补充记录

- （本轮无额外澄清补充；全部设计边界与 R2 增补根因修复已确认，待拍板为零）

## 实现说明

- **实际落地摘要**：
- **与草案的差异**：
- **关联同步文件**：
