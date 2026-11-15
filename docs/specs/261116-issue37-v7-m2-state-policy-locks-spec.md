---
kind: spec
title: Milestone 2：L3 状态机、全 Worktree 隔离、三正交策略与六锁防死循环硬拦截
status: approved
tier: L3
created: 2026-11-16
updated: 2026-11-16
issue: 37
pr: null
branch: feat/v7-m2-state-policy-locks
owner: FiretrUCK666
approved: true
implemented: false
plan_critique: "passed (reviewer=independent-plan-critic-m2, round=2, sha=01098c07606e, summary=Round 2 verified all 6 Must-Fix and 5 Should-Fix notes resolved cleanly)"
related_prd: ../prd/261115-v7-workflow-architecture-prd.md
related_todo: ../todo/261116-issue37-v7-m2-state-policy-locks-todo.md
high_risk_paths: [scripts/lib/, scripts/dev/preflight.mjs, templates/, kit/, SKILL.md, AGENTS.md]
---

# Milestone 2：L3 状态机、全 Worktree 隔离、三正交策略与六锁防死循环硬拦截（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `implemented`（总控 PRD `docs/prd/261115-v7-workflow-architecture-prd.md` `C3`–`C5` 及 `1:N` PRD 保护落地） |
| 规划级别 | `L3`（跨核心工作流引擎、六锁审查、文档生命周期、模板契约与双向门禁） |
| 创建 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / Issue / PR | `feat/v7-m2-state-policy-locks` / #37 / 提交后更新 |
| 负责人 / 内审状态 | FiretrUCK666 / `passed` |
| 关联总控 PRD / Todo | [总控 PRD](../prd/261115-v7-workflow-architecture-prd.md) / [Todo](../todo/261116-issue37-v7-m2-state-policy-locks-todo.md) |

## 系统变更全景

```mermaid
flowchart LR
  Start["全量Worktree起步"] --> Next["flow next路由"]
  Next --> Policy["三正交策略"]
  Policy -->|低风险| StaticGate["静态/CI门禁"]
  Policy -->|中高风险| Evid["分层evidence"]
  StaticGate --> Submit["零脏文件提审"]
  Evid --> Submit
  Submit --> Review["六锁独立审查"]
  Review -->|返工| Impl["impl子代理修复"]
  Impl --> FreshRev["新review复审"]
  Review -->|通过| Trial["detach试合复测"]
  FreshRev --> Trial
  Trial --> MergeMain["推进主干与清理"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/workflow-policy.mjs` (new) & `kit/skills/lib/shared.mjs` | 新增 / 导出 | L3 纯策略与证据引擎：`determineWorkflowPolicy`（含 `ownArchived` 豁免）、`evaluateNextState`、`readVerificationEvidence` / `writeVerificationEvidence` / `validateVerificationEvidence`（存 `<gitCommonDir>/project-forge-flow/tasks/<taskId>/evidence.json`）、`runLowRiskDocStaticCheck`（不依赖 `dev-govern`，适配 `lightweight`）与 `hydratePrTemplateBody` |
| `kit/skills/lib/doc-templates.mjs` & `kit/skills/lib/docs.mjs` | 改造 | 统一 `doc-templates.mjs` 与 `templates/docs-{spec,todo,prd}.md` 模板结构（补回 Todo `## 断点与遗留决策` 非尖括号默认值并保持 `I10`/`I10b`/`fillGeneratedDoc` 兼容）；将 `parseCoupledSyncRules`/`evaluateCoupledSync` 移入 `doc-templates.mjs` 并在 `docs.mjs` 与 `shared.mjs` 重导出，保证 `docs.mjs` 远低于 800 行；新增 `isSharedMasterPrd` 保护 `1:N` 总控 PRD（`syncDocsLifecycle` 不写脏、`handleFinalize` 不误拦、`archiveCompletedDocsGroup` 不提前归档并重算 archived SPEC/Todo 的 `related_prd`） |
| `kit/skills/lib/git.mjs` & `kit/skills/lib/github-client.mjs` & `kit/skills/dev-flow/scripts/worktree-deps.mjs` | 改造 | `syncDetachedWorktree` 与 `review` 槽推进支持安全解绑/刷新过期 Junction；扩展既有 `findOpenPrForBranch` 支持 `base` 过滤并导出 `listOpenPrsByHead` 别名防重开 PR（不另造重复实现） |
| `kit/skills/dev-flow/scripts/flow.mjs`, `flow-next.mjs` (new), `flow-inspect.mjs`, `flow-lifecycle.mjs`, `flow-merge.mjs` & `flow-trial-merge.mjs` (new) | 新增 / 改造 | `flow-next.mjs` (new) 承载 `next [--json]`（处理 0 任务 `idle` / 多任务 `ambiguous` 与惰性 `--probe-auth` 水合）；`commits > 0` 全量强制 `.worktrees/impl-*` 隔离（兼容 `baseSha === null` `ls-tree HEAD` 兜底）；新增 `--reset-review-slot`；`verify` 写分层 `evidence.json` 堵死 `quick --target` 旁路；`submit` 推后零跟踪文件变脏（仅写账本与评论）、复用 OPEN PR 并套用 `.github/pull_request_template.md`；`generic-git` 禁本地强合并；`flow-trial-merge.mjs` (new) 经 `.worktrees/.tmp-merge-*` `--detach` 挂载依赖试合复测后才 `ff-only` 或 CAS `update-ref` 推进干净 `mainRoot`；`cleanup` 透传 `_ghProbe`/`_ghClient` 并支持远端 `MERGED`/Squash 安全清本地分支（全部脚本严格 `<= 800` 行） |
| `kit/skills/dev-review/scripts/review-locks.mjs` (new) & `review-ledger.mjs`, `review-pack.mjs`, `review-diff.mjs`, `review-gates.mjs` | 新增 / 改造 | `review-locks.mjs` (new) 落实六锁与收敛四律：未解锁历史停损优先于 Round 4 `pass` 硬拦（退出码 4）；同 `HEAD` 复审硬拦 `BLOCKED_SAME_HEAD_REREVIEW`（退出码 2）；`normalizeMustFixObj`/`parseMustFixItem` 保留 `line`/`endLine` 与 `file:line` 解析，Round 2+ 对 `prevHead..HEAD` 增量 hunk（兼容纯删除 `count=0`、缺失 count=1、重基回退、`rebuts` 与未决 R1 项）执行 `BLOCKED_OUT_OF_SCOPE_MUST_FIX` 硬拦；修 `stillOpen` 与 `repeatedItems` 按指纹/摘要比对防同 `C*` 误报；`findingsBlocker` 仅在 `lastVerifyExitCode !== null && lastVerifyExitCode !== 0` 或显式 `--enforce-gates` 时阻断虚假 `pass`；支持 `--pre-existing`、噪声筛选与 `--disposition` 验证及四类处置统计 |
| `AGENTS.md`, `templates/agents-project.md`, `references/collaboration.md`, `SKILL.md`, `kit/skills/dev-flow/SKILL.md`, `kit/skills/dev-review/SKILL.md`, `docs/TDD.md`, `.agents/skills/` | 同步对齐 | 同步全量 Worktree、`flow.mjs next`、三正交策略、六锁与工作流规则（Case 2/3/4 单任务派 `impl` 子代理；Round 2+ 永远新建独立 `review` 子代理并在增分锁保护下复审）；精炼表达确保 `AGENTS.md <= 24,576B` 预警线以内、`lightweight < 14KB`、两个技能 `SKILL.md <= 180L` 且原样保留全部 `I9*`、`PUSH_TIER_RULE`、`FINISH_STEPS`、`TEAM_CONTRACTS` 与 `- **同步不变量**` 锚点 |
| `scripts/dev/{preflight-contracts,verify-injections,injections-data,fixtures,fixtures-flow,fixtures-docs,fixtures-govern,fixtures-platform}.mjs` & `scripts/dev/fixtures-m2.mjs` (new) | 新增 / 改造 | 同步更新既有测试中已废止的前 M2 行为（`fixtures-flow` 推后回填/同 HEAD 复审/默认 quick verify/Case1-2 改写主仓、`fixtures-platform` `generic-git` 本地强合并等）；新增 `scripts/dev/fixtures-m2.mjs` (new) 覆盖全部 M2 正反双向断言，并视行数需要拆分 `scripts/dev/injections-data.mjs` (new) 确保仓库全部 `.mjs` 均 `<= 800` 行 |

## 一、背景与边界声明

- **要改什么**：按总控 PRD（`docs/prd/261115-v7-workflow-architecture-prd.md`）Milestone 2 交付范围，落地 L3 纯状态机与 `flow.mjs next`、全 Worktree 隔离、三正交风险策略与防绕过 `evidence.json`、提审/归档/合入/清理全链路断点修复（含 `1:N` 总控 PRD 保护）、以及六锁防无限审查代码级硬拦截与工作流协作契约对齐。
- **不改什么**：保持零第三方运行时依赖（仅 `node:*`）；保持 `kit/** -> scripts/dev/**` 与 `kit/** -> scripts/lib/**` 单向禁引规则；严格守住 `kit/skills/**/*.mjs <= 800` 行、`scripts/dev/*.mjs <= 800` 行、`AGENTS.md <= 24,576B` 预警线与 `kit/skills/*/SKILL.md <= 180L`；不提前改动 M3 专属范围（`batch` 并行多 Worktree 调度 / FIFO 合并队列 / 堆叠 PR `graph`/`--after`/`sync` / 统一 `TaskBackend` / `--bootstrap-empty` 重写 / 三层命令嗅探）或 M4（`govern-tests.mjs` AST 级重造与 Fake-Agent `.zip` E2E 测试台）。
- **本期不做**：不重写 `update.mjs` / `backup.mjs`（已在 M1 完成）；不在 `scripts/dev/evidence.mjs` 混入任务级运行证据（两者路径与职责严格正交）。
- **复用既有模块**：`kit/skills/lib/{git,ledger,docs,static-gates,platform,github-client,profile,cli}.mjs`（含复用并扩展既有 `findOpenPrForBranch` 而非重复实现）、`kit/skills/dev-flow/scripts/worktree-deps.mjs`（`mountSharedDeps` / `unmountSharedDeps`）、`kit/skills/dev-review/scripts/{review-diff,review-gates}.mjs`。
- **与 `docs/TDD.md` 的关系**：严格落实 `docs/TDD.md`「共享运行时 vs 安装器边界」「L3 纯策略与状态机引擎层」「Worktree 隔离与成对复用」「单入口路由与三正交策略」「成对归档与 1:N PRD」「六锁收口」中的 `[v7 规划 M2]` 条款，落地时去掉规划标签并登记新增模块 `kit/skills/lib/workflow-policy.mjs` (new)、`kit/skills/dev-flow/scripts/flow-next.mjs` (new)、`kit/skills/dev-flow/scripts/flow-trial-merge.mjs` (new)、`kit/skills/dev-review/scripts/review-locks.mjs` (new)。关于总控 PRD「已拍板决策 #5」的复审会话规则，依据维护者最新明确拍板，在本 SPEC 与协作文档统一调整为 **Round 2+ 永远新建独立 `review` 子代理并在代码层增量视野硬锁下复审**（见「四、高风险点、门型与回滚路径」）。

## 二、设计方案与契约变更

### 1. L3 纯策略与状态机引擎（`kit/skills/lib/workflow-policy.mjs` (new) + `kit/skills/dev-flow/scripts/flow-next.mjs` (new)）

1. **`determineWorkflowPolicy(input)` 三正交策略判定**：
   - 输入：`{ changedFiles, ownArchived, caseType, highRiskGlobs, doNotEditGlobs, gateWeakeningHits, isDocsOnlyRepo, hasRemote, hasCiWorkflow, visualFilesChanged, diffBytes }`。
   - **空仓库/首提交 `changedFiles` 兜底**：当 `baseSha === null` 且 `HEAD` 存在时，调用方通过 `git ls-tree -r --name-only HEAD` 连同未跟踪文件一并收集改动文件，防止空仓首提交返回空列表。
   - **低风险（`low`）严格白名单**（必须全部满足）：
     - `changedFiles.length > 0`；
     - 每个文件命中非可执行纯文本/文档正则 `LOW_RISK_TEXT_EXT_RE`（`\.(?:md|mdx|txt|rst)$`，排除 `.yml`/`.yaml`/`.json`/`.toml`/锁文件/任何代码或脚本）；
     - 显式**排除**：`AGENTS.md`、`**/AGENTS.md`、`docs/TDD.md`、`ARCHITECTURE.md`、`RELEASING.md`、`.gitattributes`、`.gitignore`、`.github/**`、命中 `highRiskGlobs` 的路径，以及不在 `ownArchived` 豁免集合内且命中 `doNotEditGlobs` 的路径；
     - `gateWeakeningHits.length === 0` 且 `visualFilesChanged.length === 0` 且 `caseType < 4`。
   - **高风险（`high`）判定**：
     - 命中 `highRiskGlobs`、`gateWeakeningHits.length > 0`、`caseType >= 4`、`visualFilesChanged.length > 0`、或触碰 CI 工作流/包清单/锁文件/认证迁移目录等 `one-way` 边界。
   - **中风险（`medium`）判定**：其余全部常规源码/测试改动与 Case 2/3。
   - 正交输出矩阵：

   | `riskTier` | `issueRequired` | `independentReviewRequired` | `faultInjectionRequired` | `requiredGates` | `staticDocCheckRequired` |
   | --- | --- | --- | --- | --- | --- |
   | `low` | `false` | `false` | `false` | `[]` | `!hasCiWorkflow`（无 CI 时强制静态门禁） |
   | `medium` | `Boolean(hasRemote)` | `true` | `false` | 依已配置非 `none` 优先级取 `full` -> `smoke` -> `quick`（无任意配置时允许显式 `--cmd`） | `false` |
   | `high` | `Boolean(hasRemote)` | `true` | `true` | 依已配置非 `none` 优先级取 `gate` -> `full` -> `smoke` -> `quick`（无任意配置时允许显式 `--cmd`） | `false` |

2. **防旁路分层证据 `evidence.json`（位于 `<gitCommonDir>/project-forge-flow/tasks/<taskId>/evidence.json`）与无 CI 低风险静态必检**：
   - **层级包含关系**：`gate` > `full` > `smoke` > `quick`（全量跑 `gate` 或 `full` 自动满足下位层级，但传了 `--target` 的 `quick --target single.test.mjs` 仅写入 `{ target, partial: true }`，**绝不**满足未指定 `--target` 的全量门禁要求）。
   - `flow.mjs verify` 每次校验后按 `{ taskId, baseSha, headSha, dirty, riskTier, mode, target, exitCode }` 原子写入 `gates: { quick, smoke, full, gate, docStatic }` 与 `skipped[]`；对 Dev Profile 显式配 `none` 的键记 `skipped-explicit-none`（若工作区存在已跟踪脏改动则标记 `dirty: true`，仅允许在本地未提交预检，提审/合并要求干净 `HEAD`）。
   - **无远端 CI 的低风险改动静态必检（`runLowRiskDocStaticCheck`）**：实现于 `workflow-policy.mjs`（不引入 `dev-govern`，确保 `lightweight` 档位完整可用），针对本任务非删除的改动文档检查 Markdown 相对死链（围栏代码感知）、Mermaid `16/12` 标签与 HTML 禁止项、以及硬编码秘密与本机路径泄露；当 `policy.riskTier === 'low'` 且 `!hasCiWorkflow` 时，由 `verify` 自动执行并写入 `gates.docStatic`。
   - `validateVerificationEvidence({ policy, evidence, headSha, profile, explicitCmdUsed })` 在 `submit` 与 `merge` 现场对完整 `baseSha..HEAD` 重算 `policy`：
     - 当 `policy.riskTier === 'medium' | 'high'` 且仓库在 `AGENTS.md` 配置了非 `none` 的 `full-test`、`smoke-verify` 或 `merge-gate` 时，若仅有 `quick --target single.test.mjs`（无对应完整 `full`/`smoke`/`gate`）或未满足高风险所需的 `gate`（回退链内最高配置层级），返回 **`BLOCKED_INSUFFICIENT_VERIFICATION_TIER`**（exit `3`）；
     - 当 `policy.riskTier === 'low'` 且 `!hasCiWorkflow` 时，若 `gates.docStatic` 缺失或失败，返回 **`BLOCKED_STATIC_DOC_CHECK_FAILED`**（exit `3`）；
     - 若工作区 dirty 或 `evidence.headSha !== headSha` 则返回 `BLOCKED_STALE_VERIFICATION`。

3. **单一入口 `flow.mjs next [--task taskId] [--probe-auth] [--json]`（`flow-next.mjs` (new)）**：
   - 未传 `--task` 时安全枚举活跃任务，禁止直接因 `0` 任务或 `>= 2` 任务抛异常，而是确定性返回 `phase: 'idle'` 或 `phase: 'ambiguous'` 及候选任务列表；
   - 默认严格保持惰性鉴权（不调外网/SSH/gh，确保 `<= 300ms` 预算）；仅在显式传 `--probe-auth`（且未设 `PF_NO_REAL_AUTH_PROBE=1`）时调用远端评论中的 `pf-state` 重水合外部认领/PR/审查轮次状态；
   - 输出 `{ taskId, phase, nextAction, command, blockingReasons, worktreePath, reviewWorktreePath, policy, coordinatorGuidance, compactContext }`（含明确标识 Case 2/3/4 应派 `impl` 子代理、Round 2+ 应新建 `review` 子代理）。

### 2. 全量 Worktree 隔离、跨轮复用与全链路断点修复（`dev-flow` + `docs.mjs`）

1. **废除有历史提交仓的主仓原地分支（`flow-inspect.mjs`）**：
   - 当 `state.commits > 0` 时，无论 Case 1/2/3/4，全部进入 Tier 2 `.worktrees/impl-<taskId>`（`isolation: 'worktree'`）；仅 `state.commits === 0` 且非 `--parallel` 时使用 Tier 1 `branch`。
   - 基线提交 `baseSha` 取自默认分支真实提交（优先 `refs/heads/<defaultBranch>`，其次 `origin/<defaultBranch>`，再其次 `HEAD`）；若目标分支已在其他 worktree 或主仓检出，给出明确可读提示阻断不撕裂现有工作树。
2. **跨轮复用与 Junction 自动解绑 + `--reset-review-slot`**：
   - `review-diff.mjs` `syncTier2ReviewSlotIfNeeded` 与 `flow-lifecycle.mjs` 推进 `.worktrees/review-<taskId>` 前，先安全执行 `unmountSharedDeps(mainRoot, reviewWtAbs)`（无论此前锁文件是否变化），随后执行 `syncDetachedWorktree`，最后重新按当前锁文件执行 `mountSharedDeps`。
   - 新增 `--reset-review-slot`（可用于 `flow.mjs submit` 与 `review-pack.mjs`）：当 `.worktrees/review-<taskId>` 因故障注入或人为测试变脏时，安全卸载 Junction、在审查位执行 `git reset --hard && git clean -fd` 后同步至当前 `HEAD`（绝不触碰 `impl-*` 或 `mainRoot`）。
3. **`finalize` / `submit` / `merge` / `cleanup` / `1:N PRD` 全链路断点**：
   - **`submit` 零脏文件（根治 `68c2c98`）**：`handleSubmit` 在 `git push` 之后**移除一切写回追踪文件调用**（不再调用 `syncTaskDocsSafe` 或 `updateDocFrontmatter` 修改 `docs/archive/*`）；`prNumber` / `prUrl` 写回任务账本并放入 PR 正文与评论。
   - **PR 查重与模板套用**：扩展 `github-client.mjs` 既有的 `findOpenPrForBranch` 支持 `base` 过滤并提供 `listOpenPrsByHead` 别名；`handleSubmit` 推后建 PR 前先查该分支是否已有 `OPEN` PR（有则复用并追加返工评论）；新建 PR 默认调用 `hydratePrTemplateBody` 读取 `.github/pull_request_template.md` 填充对应章节（`Fixes #N`、关联文档、实现依据、实证输出与 `pf-state`）。
   - **`finalize` 返工兼容与 `1:N` 总控 PRD 保护（`docs.mjs`）**：
     - 定义 `isSharedMasterPrd(repoRoot, prdRel, activeSpecRel)`：只要满足 ① 仓内另有活跃未完结 `docs/specs/*.md` 或 `docs/todo/*.md` 经 `related_prd` 指向该 PRD，或 ② `docs/archive/specs/*.md` 已有历史子 SPEC 经 `related_prd` 指向该 PRD，或 ③ 该 PRD 声明 `multi_spec: true` / `archive_policy: manual` / (`related_spec: null` 且 `prdSlug !== specSlug` 且仍含未勾 `- [ ] C*`)，即判定为 `1:N` 共享总控 PRD；
     - 当 `isSharedMasterPrd` 为真时：`syncDocsLifecycle` 不得覆盖该 PRD 的 `issue`、`branch`、`status`、`related_spec` 与 `related_todo`；`handleFinalize` 对该父 PRD 跳过 `BLOCKED_UNCHECKED_PRD`；`archiveCompletedDocsGroup` 保留父 PRD 于 `docs/prd/` 维持 `status: active`，把已归档 SPEC/Todo 中的 `related_prd` 重算为 `../../prd/<parent>.md`（保持 `doc-plan audit` 0 断链），且不写 `ledger.archivedPrdFile`（1:1 同 slug 三件套归档原样保留）；同时在返工周期内 `SPEC`/`Todo` 已归档且无未勾 `[ ]`、无占位词时，`finalize` 幂等刷新 `finalizedHead`。
   - **`generic-git` 禁本地强合并**：当 `ledger.role === 'generic-git'` 且未显式传入 `--remote-merged` 或 `--human-approved` 时，`flow.mjs merge` 硬阻断本地合并（退出码 `3`，`BLOCKED_GENERIC_REMOTE_MR_REQUIRED`）。
   - **临时 `--detach` worktree 试合再 `merge --ff-only`（`flow-trial-merge.mjs` (new)）**：本地合入路径严禁直接在 `mainRoot` 运行 `git switch` / `git merge --no-ff`；必须先确认 `mainRoot` 干净，创建临时 `.worktrees/.tmp-merge-<taskId>`（detached at `baseSha/baseBranch`；若仓库尚无 `refs/heads/<baseBranch>` 则安全处理首个分支），在临时槽位执行 `merge --no-ff` 并按需 `mountSharedDeps` + 跑配置验证 + `finally` 必然 `unmountSharedDeps` 与 `git worktree remove --force`，试合成功后再通过 `merge --ff-only`（若 `mainRoot` 在 `baseBranch`）或 CAS `git update-ref refs/heads/<baseBranch> <mergedSha> <oldBaseSha>` 推进干净主干分支。
   - **`cleanup` Squash / 远端 `MERGED` 安全删本地分支**：`handleCleanup` 透传 `_ghProbe` / `_ghClient` 至 `buildCleanupChecklist`；当远端 PR 状态确认 `MERGED`（含 Squash merge）或 `mergeState.state` 为 `merged` / `squash_or_rebase_merged` 时，经 `--confirm` 安全执行 `git branch -D` 删除已合入本地分支；无 `--confirm` 时只打印清单一律不删。

### 3. 六锁 + 收敛四律硬落地（`kit/skills/dev-review/scripts/review-locks.mjs` (new) + `review-ledger.mjs` + `review-pack.mjs`）

1. **硬拦截优先级与状态顺序**：
   - **锁 A — 历史停损防 Round 4 `pass` 绕过**：若 `prevRounds` 任一轮 `stopLossTriggered === true` 且账本无 `humanApprovedStopLoss === true`（且本次未显式传 `--human-approved --reason` 解锁），无论 `--verdict pass` 还是 `--verdict changes`，直接阻断并返回 `EXIT.STOP_LOSS (4)`。
   - **锁 B — 硬拒同 `HEAD` 原地复审（`BLOCKED_SAME_HEAD_REREVIEW`）**：当 `round >= 2` 且 `prevRound?.headSha` 与当前待审 `headSha` 相同时（非 `UNBORN`），`review-pack record` 返回退出码 `2` 并拒绝复审。
   - **锁 C — Round 2+ 增量视野硬锁（`BLOCKED_OUT_OF_SCOPE_MUST_FIX`）**：
     - 升级 `parseMustFixItem` 与 `normalizeMustFixObj` 保留可选 `file`、`line` / `endLine`（并从字符串如 `"C1: src/foo.mjs:42 ..."` 中提取 `file` 与 `line`）；
     - 当 `round >= 2` 且 `verdict === 'changes'` 且 `mustFixList.length > 0` 时，`review-locks.mjs` 解析 `prevRound.headSha..headSha`（若 `prevHead` 已变基不可达则回退 `baseSha..headSha`）改动文件集合及各 hunk 行区间（纯删除 `count === 0` 锚定在 `start`，省略 count 按 `1`，±3 行上下文），连同上一轮未决 `Must Fix` 与 `rebuts` 构建白名单；
     - 若新 `Must Fix` 项指向未在增量范围修改的旧文件/旧行（且不匹配上轮未决项或 `rebuts`），或新增无文件路径、未关联确定性门禁/实证失败的主观挑刺，`record` 返回退出码 `2` 并输出 `BLOCKED_OUT_OF_SCOPE_MUST_FIX`（提示非阻塞项走 `--should-fix` 或 `--pre-existing`）。
2. **修复 `stillOpen` 与 `repeatedItems` 跨文件误判**：
   - 删除 `(pm.criterion && newCriteriaSet.has(pm.criterion))` 仅按 `C*` 编号匹配的逻辑；改为依据完整 `fingerprint` 或 `(file, normalizedSummary)` 精准匹配，确保不同文件或不同缺陷同标 `C1` 不再在 Round 2 误触发停损。
3. **接入 `findingsBlocker`、`--pre-existing`、噪声筛选与四类处置统计**：
   - 新增 `--pre-existing` 与 `--disposition "idOrFp:fixed|rebutted-wrong|intentional|deferred"`（传入非法枚举直接报错退出 `2`，按 `(round, idOrFp)` 去重防止重跑叠加）；
   - `record --verdict pass` 时运行 `evaluatePassBlockers`：仅当 `lastVerifyExitCode !== null && lastVerifyExitCode !== 0`、存在匹配 `headSha` 的失败 `evidence.json` 门禁、或显式传 `--enforce-gates` 时检测到 stale `verifiedHead` / 未豁免 `archViolations` / 未授权 `gateWeakening`，方返回 `BLOCKED_PASS_WITH_OPEN_BLOCKERS`（退出码 `2`），不误伤独立沙盒单测；
   - 对 `shouldFix` / `preExisting` 执行轻量归一化去重并写入 `dispositionStats`。

### 4. 统一模板与全协作契约同步

1. **统一 `doc-templates.mjs` 与 `templates/`**：将 `kit/skills/lib/doc-templates.mjs`（含移入的 `parseCoupledSyncRules`/`evaluateCoupledSync` 并保持从 `docs.mjs` 与 `shared.mjs` 重导出）中 `spec` 与 `todo` 模板对齐 `templates/docs-{spec,todo}.md`（补回 Todo `## 断点与遗留决策` 非尖括号默认值，保持 `I10`/`I10b` 及 `fillGeneratedDoc`/`govern-docs` 零占位兼容）。
2. **同步协作规则（含用户拍板 A & B）**：
   - 同步更新 `templates/agents-project.md`、`references/collaboration.md`、`AGENTS.md`、`SKILL.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-review/SKILL.md`、`docs/TDD.md` 并运行 `equip.mjs .` 与 `compose-agents.mjs .`；
   - 精炼 `templates/agents-project.md` 冗余措辞以守住 `AGENTS.md <= 24,576B`（`lightweight < 14KB`）预算与两个技能 `SKILL.md <= 180L`，原样保留全部 `I9*`、`- **同步不变量**`、`PUSH_TIER_RULE`、`FINISH_STEPS` 与 `TEAM_CONTRACTS` 对拍锚点；
   - 同步 `scripts/dev/preflight-contracts.mjs`、`scripts/dev/fixtures-*.mjs` 与 `scripts/dev/verify-injections.mjs`（新增 `scripts/dev/fixtures-m2.mjs` (new) 与按需拆分 `scripts/dev/injections-data.mjs` (new)）。

## 三、冻结的验收标准

- [x] C1: 抽离 L3 纯策略与状态机模块 `kit/skills/lib/workflow-policy.mjs` (new) 与 `kit/skills/dev-flow/scripts/flow-next.mjs` (new)，实现 `flow.mjs next [--json]` 与 `determineWorkflowPolicy`（`low`/`medium`/`high`）；`flow.mjs verify` 写入 `<gitCommonDir>/project-forge-flow/tasks/<taskId>/evidence.json` 并在 `submit`/`merge` 拦截 `quick --target foo.test.mjs` 旁路（`BLOCKED_INSUFFICIENT_VERIFICATION_TIER`），且无远端 CI 低风险改动通过独立不依赖 `dev-govern` 的 `runLowRiskDocStaticCheck` 后方可放行，正反双向夹具通过。
- [x] C2: 废除有提交仓 Tier 1 主仓切换分支，`commits > 0` 全量强制 `.worktrees/impl-<taskId>` 隔离（含 `baseSha === null` 与分支冲突保护）；支持跨轮复用同一 `impl`/`review` 槽位，推进时自动 `unmountSharedDeps` 后重挂载并提供 `--reset-review-slot` 清理审查位脏状态，正反双向夹具通过。
- [x] C3: 修复提审/归档/合入/清理全链路断点：`submit` 推送后 `implRoot` 0 跟踪文件变脏、先查 OPEN PR 防重并套用 `.github/pull_request_template.md`；`isSharedMasterPrd` 保护 1:N 总控 PRD 在仍有未完结子 SPEC 或未勾项时不修改元数据亦不提前归档；`generic-git` 有远端禁越权本地合并；本地合入经 `.worktrees/.tmp-merge-*` `--detach` 试合复测后推进干净主干；`cleanup` 支持 Squash / 远端 `MERGED` 安全删本地分支，全项正反双向夹具通过。
- [x] C4: `kit/skills/dev-review/scripts/review-locks.mjs` (new) 落地六锁 + 收敛四律硬拦截：未解锁历史停损阻断 Round 4 `pass` 绕过（退出码 4）、同 `HEAD` 复审退出码 2（`BLOCKED_SAME_HEAD_REREVIEW`）、Round 2+ 增量视野外 `Must Fix` 退回（`BLOCKED_OUT_OF_SCOPE_MUST_FIX`）、同 `C*` 不同文件/摘要不误停损、`findingsBlocker`、`--pre-existing` 噪声去重与 `--disposition` 校验及统计，正反双向夹具通过。
- [x] C5: 统一 `doc-templates.mjs` 与 `templates/docs-{spec,todo}.md`；同步更新 `AGENTS.md`（`<= 24,576B`）、`templates/agents-project.md`、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-{flow,review}/SKILL.md`（`<= 180L`）、`docs/TDD.md`、`.agents/skills/`（全仓 `.mjs` 均 `<= 800L` 且 `arch-rules` 0 违例）、`preflight-contracts.mjs`、`fixtures-m2.mjs` (new) 与 `verify-injections.mjs`（新增 M2 门禁注入必红），全量 `merge-gate` + `bench.mjs` + `--package` 退出码 `0`。

## 四、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（改造全流程隔离模式、三正交门禁策略、六锁硬拦截及合同模板；同时正式将用户拍板的「Round 2+ 永远新建独立 `review` 子代理 + Case 2/3/4 单任务派 `impl` 子代理」记为相对总控 PRD 决策 #5 的演进覆盖）；回滚须通过 `git revert` 撤销 M2 合入提交并重跑全仓 `merge-gate`。
- **高风险路径**：`kit/`、`templates/`、`AGENTS.md`、`SKILL.md`、`scripts/dev/preflight.mjs`。
- **故障注入预演**：
  1. 放宽 `workflow-policy.mjs` 的 `low` 白名单至包含 `.mjs`/`.json` 或去掉无 CI 静态检查，确认低风险旁路夹具必红；
  2. 破坏 `validateVerificationEvidence` 层级核验，确认 `quick --target` 旁路夹具必红；
  3. 破坏 `docs.mjs` `isSharedMasterPrd` 检查或 `flow-merge.mjs` `generic-git` 本地合入拦截，确认对应正反夹具必红；
  4. 破坏 `review-locks.mjs` 同 `HEAD` 拦截、Round 2+ 未改旧行阻塞拦截或 Round 4 停损绕过拦截，确认对应六锁夹具必红。

## 实现说明

- **实际落地摘要**：
  1. 新增 `kit/skills/lib/workflow-policy.mjs` 与 `kit/skills/dev-flow/scripts/flow-next.mjs`，落实 `flow.mjs next [--json]`（`idle`/`ambiguous`/单任务 `ownerRole` 路由与 `--probe-auth` 惰性水合）、`determineWorkflowPolicy`、`runLowRiskDocStaticCheck`、`<gitCommonDir>/project-forge-flow/tasks/<taskId>/evidence.json` 防旁路校验及 `hydratePrTemplateBody`；并在 `flow-lifecycle.mjs` 落盘 `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH` 实施者权责锁。
  2. 在 `flow-inspect.mjs` / `flow-lifecycle.mjs` / `flow-merge.mjs` / `flow-trial-merge.mjs` (new) 落实 `commits > 0` 全 Worktree 隔离、跨轮槽位复用与 `--reset-review-slot`、`submit` 零跟踪脏文件与 `findOpenPrForBranch` 复用、`isSharedMasterPrd` 1:N 总控 PRD 保护、`generic-git` 禁本地强合并、`--detach` `.worktrees/.tmp-merge-*` 试合复测与 Squash/`MERGED` 安全清理。
  3. 新增 `kit/skills/dev-review/scripts/review-locks.mjs` 并将 `formatPackText`/`buildPackNextSteps` 迁入 `review-gates.mjs`（保证 `kit/skills/**/*.mjs` 与 `scripts/dev/*.mjs` 均 `<= 800` 行），落地历史停损禁 Round 4 绕过、同 `HEAD` 拦截、Round 2+ 增量 hunk 视野硬锁、跨文件同 `C*` 指纹匹配、`evaluatePassBlockers`、`--pre-existing` 去重及 `--disposition` 校验统计。
  4. 统一 `doc-templates.mjs` 与 `templates/docs-{prd,spec,todo}.md` 结构；拆分 `scripts/dev/injections-data.mjs` 并新增 `scripts/dev/fixtures-m2.mjs` 与注入 `I55`–`I63`（70 条全红）。
- **关联同步文件**：`AGENTS.md`（22,010B）、`templates/agents-project.md`、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-{flow,review}/SKILL.md`、`docs/TDD.md`、`.agents/skills/`。
