---
kind: prd
title: 沙箱双环与单源三轴策略重构
status: draft
created: 2026-11-27
updated: 2026-11-27
issue: null
pr: null
owner: plan-sandbox-v1
plan_mode: interactive
plan_critique: pending
related_spec: null
related_todo: null
multi_spec: true
---

# 沙箱双环与单源三轴策略重构 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-27` / `2026-11-27` |
| 关联 Issue / PR | 未关联 / 未关联 |
| 提出方 / 负责人 | plan-sandbox-v1 |
| 规划态 | `interactive`（本轮 `/grill-me` 7 项架构决策已全部拍板清零） |
| 关联设计 / 任务单 | 1:N 总控 PRD，拆分为 3 组严格顺序依赖切片（Wave 1 -> Wave 2 -> Wave 3），每波独立全绿合入 |

- **目标读者**：实现子代理、独立 Critique 审稿人、独立代码审查者与后续接手维护者

## 一、要解决的问题

### 现状与痛点

经全仓源码审计（基线 `main @ 5feb0db`），当前研发流存在四类结构性摩擦：

1. **策略判定多点分裂与过度升档**：`kit/skills/lib/workflow-policy.mjs`（第 187、191、213 行）把任何 `isUiVisualFile` 命中一律抬升为 `riskTier: 'high'` 并连带触发两阶段故障注入；同时 `kit/skills/dev-review/scripts/review-empirical.mjs`（第 101 行）又另算一套 `faultRequired = !isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired)`，导致普通 `medium` 级局部 Bugfix 也被强迫注入故障，与 `kit/skills/dev-review/scripts/review-locks.mjs`（第 599-601 行）和 `workflow-policy.mjs` 直接冲突。
2. **缺少高频隔离沙箱环，提前锁死文档与远端工单**：当前 `flow.mjs start` 仅支持单环 `impl` 槽位，局部可逆或需「先做出来看真效果」的改动被迫提前建 Issue、提前写文档并早早触发 `git mv` 归档（`flow-lifecycle-finalize.mjs` 第 73-260 行）；同时 `flow-lifecycle-helpers.mjs`（第 295 行）、`review-empirical-state.mjs`（第 632 行）和 `iterate.mjs`（第 276 行）在探索期测试失败时默认直接往远端托管平台自动刷出升级工单。
3. **重复扣检浪费与入口钝化**：单次 `flow verify` 中 `verifyArchitectureMapSync` 被 `edit-gate.mjs`（第 604 行）和 `flow-lifecycle-hooks.mjs`（第 438 行）连续跑两遍；`scanStructuralHygiene`、`evaluateArchRules`、`detectGateWeakening` 在改码、验证、审查、治理 4 处反复重扫相同干净 HEAD；`doc-audit.mjs`（第 165 行）仍保留 `fileCount >= 6` 自动升 Case 4 的钝化阈值，且 `doc-plan.mjs triage` 未输出确定性入口路由。
4. **跨栈通用性须有确定性回归守卫**：流程底座须在空仓、Node/TS 单包与 Monorepo、Python/Go/Rust、Prisma/SQL 数据仓、UI 重型前端仓、无包清单非 JS 通用仓以及 `generic-git` 非 GitHub 远端仓上零补丁直接可用。

### 目标用户与使用场景

- **多代理与单会话协作用户**：在主仓保持干净的前提下，按 `triage` 确定性路由直接完成 Case 1 微调、进入 `.worktrees/sandbox-<id>/` 高频试错看真效果、或对 `one-way`/跨多域工程先出方案经独立 Critic 拍板。
- **跨生态目标仓库维护者**：通过 `project-forge` 接入 `.agents/skills/` 后，在任意语言栈与托管平台上获得统一的沙箱探索体验与单一外环合门。

### 产品目标

- **单一策略源零冲突**：`dev-plan`、`dev-flow`、`dev-edit`、`dev-review`、`dev-govern`、`dev-iterate` 全部消费 `workflow-policy.mjs` 的三轴正交结论，消除 `faultRequired` / `visualCheckRequired` / `riskTier` 跨模块分歧。
- **一条主干外环铁门 + 高频隔离沙箱**：沙箱内秒级迭代零刷远端工单、零提前 `git mv`；拍板后 `flow.mjs promote` 按真实 `git diff <base>...HEAD` 确定性分流 `Case 2/3` 原地晋升或 `Case 4` PoC 转 SPEC/PRD+Critic（遇 `docs/TDD.md` 冲突阻断走 `Case 5`），最终汇入同一套外环审查合并门禁。
- **确定性去重、逐波自洽全绿与零漏拦**：同干净 HEAD 下消除双跑 `verifyArchitectureMapSync` 与 4 处重复静态扫描；内环快检证据打标 `inner: true` 并由外环硬拒防偷渡；每个 Wave 合并前均独立通过全量门禁与故障注入。

## 二、范围与非目标

### 本次要做（In Scope）

- **逐波独立全绿合门铁律（Per-Wave Self-Contained Green CI）**：
  - Wave 1 -> Wave 2 -> Wave 3 严格按顺序合入 `main`，共享登记表文件（`docs/feature-map.json`、`docs/architecture-map.html`、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`）随波次串行更新，同波零文件重叠。
  - **每波新增 `kit/skills/**` 核心模块须在当波同步登记 `docs/feature-map.json` 并单点重渲 `docs/architecture-map.html`**（避免在 `finalize`/`verify` 触发 `BLOCKED_FEATURE_MAP_SYNC` 与 `BLOCKED_ARCHITECTURE_MAP_DRIFT`）。
  - **当波行为变更波及既有夹具或故障注入锚点时，必须在当波同步升级对应 `fixtures-*.mjs` 与 `injections-data-*.mjs`**（严禁推迟到后续波次或临时跳过门禁），确保每一波独立合入 `main` 时 `preflight.mjs`、`fixtures.mjs`、`equip.mjs . --check` 与 `verify-injections.mjs --jobs 4` 全部退出码 `0`。
- **Wave 1 — 切片 1 `single-source-policy-core`**：`workflow-policy.mjs` 三轴正交解耦（UI 视觉独立于 `riskTier='high'` 且 `isLow` 显式排除视觉文件、故障注入精确绑定 `high`/`one-way`/`Case>=4` 且对齐 `smokeExplicitNone`、外环硬拒 `inner: true` 证据）、新增 `kit/skills/lib/gate-receipt.mjs` (new) 消除 `verifyArchitectureMapSync` 双跑与 4 处重复静态扫描（支持有 `taskId` 与 headless 无 `taskId` 双形态，保活 `I962/I963`）、探索/内环测试失败防远端工单刷屏；当波登记 `gate-receipt.mjs` 入 `feature-map`、重渲 `architecture-map.html` 并同步升级受波及的 `fixtures-r6c-gates.mjs`、`injections-data-r6c.mjs`（`I502`）、`fixtures-e2e-gate.mjs`、`fixtures-w4-harness.mjs`、`fixtures-r8-bugfixes.mjs`、`fixtures-review-empirical.mjs`、`fixtures-iterate-evolution.mjs`。
- **Wave 2 — 切片 2 `sandbox-dual-loop-flow`**（`depends_on: [single-source-policy-core]`）：新增 `kit/skills/lib/sandbox-scope.mjs` (new) 与 `kit/skills/dev-flow/scripts/flow-sandbox.mjs` (new) 承接 `.worktrees/sandbox-<id>/` 隔离沙箱生命周期、账本 `implementers[]`（支持单常驻或互不重叠 `writeScope` 并行子代理并强校 `reviewerId ∉ implementers[]` 与防自合）、`flow.mjs promote --task <id>` 真实 `git diff` 确定性晋升分类器（含 `Case 2/3` 晋升后 `claimedAt`/`explored`/Todo 作者分离衔接及 `Case 5` TDD 冲突阻断）、`flow-lifecycle-hooks.mjs` 内环快检前置豁免、`flow.mjs` 子命令头与帮助同步、`workflow-policy-next.mjs` 沙箱状态机路由；当波登记 `sandbox-scope.mjs` 与 `flow-sandbox.mjs` 入 `feature-map` 并重渲 `architecture-map.html`。
- **Wave 3 — 切片 3 `triage-brief-contract-parity`**（`depends_on: [single-source-policy-core, sandbox-dual-loop-flow]`）：`doc-plan.mjs triage` 确定性三出口 `recommendedEntry: 'direct' | 'sandbox' | 'plan-first'` 与单一 `[NEXT STEP]`、仅移除 `doc-audit.mjs:165` `fileCount >= 6 -> Case 4` 钝化悬崖（保留 `:86,161,169` `fileCount >= 12` PRD 容器判据）、保持 `Case 5` 与 `PRD` 严格正交、统筹 `doc-plan-brief.mjs` 两处（`handleNoteSubcommand` 与 `handleTriageSubcommand`）按需 Brief 触发、全仓模板/文档/技能/门禁/故障注入同构对拍（含更新 `fixtures-r6d-contracts.mjs`、`fixtures-living-brief.mjs`、`fixtures-doc-triage.mjs`），7 类异构仓库双向实证夹具，以及最终全局 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README*.md` 对齐收口。

### 明确不做（Non-Goals）

- 不在本里程碑实施「Visual Studio Archify v2」静态图引擎或前端 Studio UI/UX 重构（归属下一期独立里程碑 `visual-studio-archify-v2`）。
- 不分叉「单人/多人」两套合门规则；全仓统一保留外环合入前必绑 Issue 与清理 worktree 前 `--confirm --preview-hash` 人工确认。
- 不引入任何第三方 npm 依赖，不绑定特定 AI 宿主名称，不硬编码任何具体外部浏览器/E2E 驱动工具名。
- 不松动既有防弱模型硬锁：`BLOCKED_MAIN_SLOT_VIOLATION`、`HALLUCINATED_PATH`、`BLOCKED_PENDING_DECISIONS`、`evidence.json` 防 `quick --target` 偷渡、`detectGateWeakening`、`SELF_REVIEW_REJECTED`、`BLOCKED_SELF_MERGE`、`unmountSharedDeps`。

## 三、用户身份与权限

| 身份 | 能做什么 | 不能做什么 | 代码或配置中的载体 |
| --- | --- | --- | --- |
| 调度协调者（`coordinator`） | 跑 `triage`/`next`/派发沙箱或外环子代理、为 `Case 3` 晋升创建非实施者署名的 Todo、在审查通过后按 A3 执行 `flow.mjs merge` | 亲自改业务源码、冒充实施者 `submit`、跳过独立审查自签放行 | `kit/skills/lib/harness-context.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs` |
| 沙箱/外环实施者（`implementer`） | 在 `.worktrees/sandbox-<id>/` 或 `.worktrees/impl-<id>/` 按自身 `writeScope` 改码、跑内环/外环 verify、由认领者 `submit` | 在 `commits > 0` 主仓原地改 `Case >= 2` 代码、跨 `writeScope` 冲突写入、自审或自合并 | `ledger.implementers[]`、`kit/skills/lib/sandbox-scope.mjs` (new)、`kit/skills/lib/ledger.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs` |
| 独立审查者（`reviewer`） | 在 `.worktrees/review-<id>/` 对未参与实施的任务执行实证核验、必要故障注入与 `review-pack record` | 审查任何 `reviewerId ∈ implementers[]` 或已参审过的 Round 2+ 任务 | `kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs` |
| 人类维护者（`human`） | 拍板晋升、审批 `Case 4/5` 方案、确认 `cleanup --confirm --preview-hash`、签署停损或弱化门禁豁免 | 无限制（审计日志完整留痕） | `flow-cleanup.mjs`、`doc-plan-ops.mjs`、`review-ledger.mjs` |

## 四、关键业务流程

1. **确定性入口分流**：调用 `node .agents/skills/dev-plan/scripts/doc-plan.mjs triage --summary "..."` -> 机械返回 `recommendedEntry: 'direct' | 'sandbox' | 'plan-first'`、单一 `[NEXT STEP]` 与按需 Brief 决策。
2. **高频沙箱内环**：可逆改动或效果待收敛需求执行 `flow.mjs start --sandbox --task <id> --agent <impl>` -> 建立 `.worktrees/sandbox-<id>/`（保护主仓干净；若用户显式传入 `--issue`/`--issues` 则保留并登记为 `reused`，未传才置 `exempt(sandbox)` 不预建 Issue）-> 单常驻或按互不重叠 `writeScope` 并行的子代理高频改码，所有参与改码者自动登记进 `ledger.implementers[]` -> 沙箱内环 `flow verify` 写入 `evidence.json`（打标 `inner: true`），豁免外环前置认领/探索阻塞且测试失败仅写本地诊断与信号，不刷远端 Issue。
3. **真实差分晋升汇流**：用户看真效果拍板后执行 `flow.mjs promote --task <id>`（支持 `--issue`/`--issues`/`--body`/`--body-file`/`--todo`/`--no-issue`/`--reason`）-> 计算真实 `git diff <baseRef>...HEAD` 并交单源 `determineWorkflowPolicy` 与 `checkTddSyncParity` 判定：
   - 命中 `docs/TDD.md` 架构冲突 -> 阻断为 `BLOCKED_CASE_5_TDD_CONFLICT`（`status: 'sandbox-needs-spec'`），先修订并批准 `docs/TDD.md`，不提前新建 Issue。
   - 命中 `Case 2 / Case 3`：原地晋升为标准外环实施态（`sandboxMode: false`, `promotedFromSandbox: true`），自动衔接 `claimedAt`/`explored` 并一次性完成单一 Issue 绑定（优先复用既有 `--issue`；若无绑定、非豁免且未提供 `--body`/`--body-file`/`--todo`，则基于真实 `git diff <baseRef>...HEAD` 自动合成通过质量门禁的 Issue 正文建单绑定，避免 `BLOCKED_MISSING_ISSUE_BINDING` 死锁；`Case 3` 后续 `doc-plan init --kind todo` 复用该 Issue 且由非实施者署名落盘 `C1..Cn` 以满足作者与实施者分离铁锁）。
   - 命中 `Case 4`（`one-way` / `high-risk` / 跨多域契约）：返回 `SANDBOX_PROMOTE_NEEDS_SPEC`，将沙箱标记为已验证 PoC，严禁提前新建 Issue（已有绑定则原样保留），引导补齐 `SPEC` / `1:N PRD` -> 独立 Critic -> `approve` 后落地生产代码。
4. **单一外环铁门收口**：走统一外环 `finalize`（仅此时归档文档）-> `verify`（清除 `inner: true`，单点架构图校验与同 HEAD 门禁回执缓存）-> `submit` -> 全新独立审查者（`reviewerId ∉ implementers[]`）核验（`high`/`one-way`/`Case>=4` 且非 `smoke-verify: none` 走两阶段故障注入；UI 文件走独立视觉与交互实证）-> `merge` -> 列出清单经人 `--confirm --preview-hash` 执行 `cleanup`。

## 五、状态与业务规则

| 对象 | 状态 | 允许的迁移 | 迁移的触发条件 |
| --- | --- | --- | --- |
| 沙箱任务账本 | `sandbox-iterating -> sandbox-ready-to-promote` | 实施者提交干净 commit | 工作树 `dirty === 0` 且存在相对 `baseSha` 的真实提交 |
| 沙箱任务账本 | `sandbox-ready-to-promote -> started` | `flow.mjs promote --task <id>` | 真实 `git diff <baseRef>...HEAD` 落入 `Case 2 / Case 3`、无 TDD 冲突且完成 Issue 绑定与 `claimedAt`/`explored` 衔接 |
| 沙箱任务账本 | `sandbox-ready-to-promote -> sandbox-needs-spec` | `flow.mjs promote --task <id>` | 真实 `git diff <baseRef>...HEAD` 命中 `Case 4` / `one-way` / `high-risk` 或 `Case 5` TDD 冲突 |
| 沙箱任务账本 | `sandbox-* -> finalized / submitted` | **严禁直接迁移** | 硬拦截 `BLOCKED_SANDBOX_PROMOTE_REQUIRED`（退出码 `3`） |
| 实证记录 `evidence.json` | `inner: true -> outer pass` | 外环全量 `flow.mjs verify` | 外环 `validateVerificationEvidence` 拒收 `inner: true`（`BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER`） |
| 门禁回执 `gate-receipt.json` | `valid -> invalidated` | `repoRoot`/`dirty`/`headSha`/`baseSha`/`diffFingerprint`/`profileHash` 任一变化 | 仅干净工作区且全键一致才允许复用，否则强制全量重扫 |

## 六、复用既有模块

- `kit/skills/lib/workflow-policy.mjs`：复用 `determineWorkflowPolicy`、`validateVerificationEvidence`、`resolveRequiredGates`、`runLowRiskDocStaticCheck`、`resolveScopedVerificationGate`。
- `kit/skills/lib/workflow-policy-next.mjs`：复用 `evaluateNextState`、`inferCandidatePhaseAndMutability`、`validateReviewRecordClosure`。
- `kit/skills/lib/ledger.mjs`：复用 `createDefaultLedger`、`collectImplementerHistory`、`rememberPreviousImplementer`、`updateTaskLedger`、`resolveTaskContext`。
- `kit/skills/lib/harness-context.mjs` & `kit/skills/lib/mutability.mjs`：复用 `enforceSlotBoundary`、`resolveHostMode`、`evaluateMutability`。
- `kit/skills/lib/static-gates.mjs` & `kit/skills/lib/architecture-map.mjs`：复用 `isUiVisualFile`、`classifyDoorType`、`scanStructuralHygiene`、`evaluateArchRules`、`detectGateWeakening`、`verifyArchitectureMapSync`。
- `kit/skills/lib/empirical-artifacts.mjs`：复用 `evaluateStoredVisualEvidence`、`precheckVisualAndArtifacts`。
- `kit/skills/dev-flow/scripts/worktree-deps.mjs`：复用 `mountSharedDeps` 与 `unmountSharedDeps`。

## 七、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 体积与零依赖 | `scripts/` 与 `kit/` 严格零第三方依赖（仅 `node:*`）；所有 `.mjs` 文件 `<= 800` 行；`kit/skills/*/SKILL.md <= 14,336 B` 且 `<= 180` 行；`AGENTS.md <= 30 KB` | `node scripts/dev/preflight.mjs`、`node scripts/compose-agents.mjs . --check`、`node scripts/equip.mjs . --check` |
| 逐波独立全绿 | Wave 1、Wave 2、Wave 3 各自独立合入 `main` 时全套门禁、`feature-map` 同步、CLI/子命令对拍与故障注入均退出码 `0` | 每波 PR 必跑 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4`、`equip.mjs . --check` |
| 安全与隔离 | 沙箱严禁污染主仓 `main`；外环硬拒 `inner: true`；`reviewerId ∉ implementers[]` 全历史不可绕过；禁硬编码宿主名或具体外部 E2E 驱动名 | `node scripts/dev/fixtures.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4` |
| 跨栈通用性 | 7 类异构仓库（空仓、Node/TS、Python/Go/Rust、DB/SQL、UI 前端、非 JS 通用、generic-git）零定制补丁全通过 | `node scripts/dev/fixtures.mjs`（含 `fixtures-heterogeneous-dual-loop.mjs`） |
| 性能与去重 | 单次 `flow verify` 中 `verifyArchitectureMapSync` 执行次数 `=== 1`；干净 HEAD 复用 `gate-receipt.json` 避免重复静态重扫 | `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/bench.mjs` |

## 八、验收标准

> 全部 12 条 `C1..C12` 按 1:1 严格切分至 3 份切片 SPEC，零重叠、零遗漏；Wave 1 -> Wave 2 -> Wave 3 顺序依赖，共享登记表文件（`docs/feature-map.json`、`docs/architecture-map.html`、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`）按波次串行更新。

### 切片归属与波次拓扑

| Wave | 切片 Slug | 依赖 | 认领条款 | 当波核心独占产物与共享登记表更新 |
| --- | --- | --- | --- | --- |
| Wave 1 | `single-source-policy-core` | 无 | `C1` - `C4` | 独占：`gate-receipt.mjs` (new)、`workflow-policy.mjs`、`review-empirical*.mjs`、`review-locks.mjs`、`review-gates.mjs`、`edit-gate.mjs`、`flow-lifecycle-hooks.mjs`、`flow-lifecycle-helpers.mjs`、`iterate.mjs`、`govern-checks.mjs`、`fixtures-policy-axes.mjs` (new)、`injections-data-policy-axes.mjs` (new)、受波及旧夹具/注入（`fixtures-r6c-gates.mjs`、`injections-data-r6c.mjs`、`fixtures-e2e-gate.mjs`、`fixtures-w4-harness.mjs`、`fixtures-r8-bugfixes.mjs`、`fixtures-review-empirical.mjs`、`fixtures-iterate-evolution.mjs`）；串行登记：`docs/feature-map.json`（登记 `gate-receipt.mjs`）、`docs/architecture-map.html`、`fixtures.mjs`、`injections-data.mjs` |
| Wave 2 | `sandbox-dual-loop-flow` | `single-source-policy-core` | `C5` - `C8` | 独占：`sandbox-scope.mjs` (new)、`flow-sandbox.mjs` (new)、`ledger.mjs`、`harness-context.mjs`、`mutability.mjs`、`subcommand-meta.mjs`、`workflow-policy-next.mjs`、`flow.mjs`、`flow-inspect.mjs`、`flow-start-helpers.mjs`、`flow-lifecycle.mjs`、`flow-lifecycle-finalize.mjs`、`flow-merge.mjs`、`fixtures-sandbox-dual-loop.mjs` (new)、`injections-data-sandbox-flow.mjs` (new)；串行增补：`flow-lifecycle-hooks.mjs`（内环快检前置豁免）、`docs/feature-map.json`（登记 `sandbox-scope.mjs` 与 `flow-sandbox.mjs`）、`docs/architecture-map.html`、`fixtures.mjs`、`injections-data.mjs` |
| Wave 3 | `triage-brief-contract-parity` | `single-source-policy-core`, `sandbox-dual-loop-flow` | `C9` - `C12` | 独占：`doc-audit.mjs`、`triage-rules.mjs`、`doc-plan-brief.mjs`、`templates/*`、`.github/pull_request_template.md`、`AGENTS.md`、`references/collaboration.md`、5 份 `kit/skills/*/SKILL.md`、`scripts/dev/preflight*`、`fixtures-heterogeneous-dual-loop.mjs` (new)、`injections-data-triage-parity.mjs` (new)、`fixtures-r6d-contracts.mjs`、`fixtures-living-brief.mjs`、`fixtures-doc-triage.mjs`、`docs/TDD.md`、`README.md`、`README.en.md`；串行终验：`docs/feature-map.json`、`docs/architecture-map.html`、`fixtures.mjs`、`injections-data.mjs` |

### 冻结条款清单（C1..C12）

- [ ] C1: `determineWorkflowPolicy` 将 UI 视觉实证（`visualCheckRequired`）与 `riskTier='high'` 解耦（且 `isLow` 显式要求 `effectiveVisual.length === 0`），不再因仅改前端样式/组件文件而强抬为 `high`；`faultInjectionRequired` 与 `review-empirical.mjs` 的 `faultRequired`（含 `smokeExplicitNone` 对齐 `review-locks.mjs:601`）单源统一精确绑定至 `high`/`one-way`/`Case >= 4`，经 `fixtures-policy-axes.mjs` 与更新后的 Wave 1 既有夹具正反双向断言通过。
- [ ] C2: 沙箱/内环快检在 `evidence.json` 记录 `inner: true`；外环 `validateVerificationEvidence` 对顶层或门禁项带 `inner === true` 的实证硬拒并返回 `BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER`（退出码 `3`），经正反双向断言通过。
- [ ] C3: 新增 `kit/skills/lib/gate-receipt.mjs` (new)（当波登记入 `docs/feature-map.json` 并重渲 `docs/architecture-map.html`）实现 `{ repoRoot, dirty: false, headSha, baseSha, diffFingerprint, profileHash }` 绑定的干净 HEAD 回执复用（支持有 `taskId` 与 headless 无 `taskId` 场景，明确各门禁唯一生产者并保活 `I962/I963`），使单次 `flow verify` 中 `verifyArchitectureMapSync` 仅执行 1 次并消除 `scanStructuralHygiene`/`evaluateArchRules`/`detectGateWeakening` 重复重算，且脏树或配置/HEAD 变化时立即失效重扫。
- [ ] C4: `flow-lifecycle-helpers.mjs`、`review-empirical-state.mjs` 与 `iterate.mjs`（同步更新 `printHelp()` 第 67 行说明及 `fixtures-r6c-gates.mjs`/`injections-data-r6c.mjs` `I502`）在探索/内环/`quick`/沙箱失败时默认仅记本地诊断包与治理信号而不向远端托管平台自动建单；仅外环阻断或显式 `--escalate` 才触发远端建单。
- [ ] C5: `flow.mjs start --sandbox`（经 `kit/skills/dev-flow/scripts/flow-sandbox.mjs` (new) 与 `kit/skills/lib/sandbox-scope.mjs` (new)，当波登记 `feature-map`、重渲 `architecture-map.html` 并同步 `flow.mjs` 子命令头与 `printHelp()`）创建 `.worktrees/sandbox-<id>/` 隔离工作树，保护 `main` 干净（`BLOCKED_MAIN_SLOT_VIOLATION` 保持生效）；显式传入 `--issue`/`--issues` 时保留并记为 `reused`（未传时才记 `exempt(sandbox)` 豁免预建 Issue），且对未晋升沙箱执行 `finalize`/`submit` 硬拒 `BLOCKED_SANDBOX_PROMOTE_REQUIRED`（不提前 `git mv` 归档文档）。
- [ ] C6: `ledger.mjs` 新增 `implementers[]` 及沙箱态登记入 `OPEN_TASK_STATUSES`/`PRE_SUBMIT_STATUSES`，写域校验与登记抽入 `sandbox-scope.mjs` (new)（支持单常驻或互不重叠 `writeScope` 多子代理并行登记，写域冲突硬拒 `BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP`），`collectImplementerHistory` 自动聚合 `implementers[]` 并在外环审查与合并强制执行 `reviewerId ∉ implementers[]`（`SELF_REVIEW_REJECTED`）与防自合（`BLOCKED_SELF_MERGE`）。
- [ ] C7: `flow.mjs promote --task <id>`（支持 `--issue`/`--issues`/`--body`/`--body-file`/`--todo`/`--no-issue`/`--reason` 及参数化 `commandName: 'promote'` 指引）按真实 `git diff <baseRef>...HEAD` 经单源 `determineWorkflowPolicy` 与 `checkTddSyncParity` 确定性路由：`docs/TDD.md` 冲突阻断 `BLOCKED_CASE_5_TDD_CONFLICT`；`Case 2/3`（含纯 UI 局部改）原地晋升、自动衔接 `claimedAt`/`explored` 并完成单一 Issue 绑定（保留已有 `--issue`，无绑定非豁免且缺正文/Todo 时从真实 `git diff` 自动合成合规 Issue 正文经 `buildAndValidateIssueBody` 建单，零 `BLOCKED_MISSING_ISSUE_BINDING` 死锁；`Case 3` 补建非实施者署名 `docs/todo/` 复用该 Issue 并通过 `BLOCKED_AUTHOR_IS_IMPLEMENTER`）；命中 `Case 4` 输出 `SANDBOX_PROMOTE_NEEDS_SPEC` 标记为已验证 PoC 且不提前新建 Issue，引导走 `SPEC`/`1:N PRD` + 独立 Critic + `approve`。
- [ ] C8: `workflow-policy-next.mjs` 完整支持 `sandbox-iterating`、`sandbox-ready-to-promote`、`sandbox-needs-spec` 状态路由与单一可执行命令；`flow-lifecycle-hooks.mjs` 对沙箱内环 `flow verify` 豁免外环前置认领/探索阻塞且不放宽外环校验；沙箱内 `flow verify` 自动打标 `inner: true`，晋升后无缝接入外环 `finalize -> verify -> submit -> review -> merge -> cleanup --confirm --preview-hash`。
- [ ] C9: `doc-plan.mjs triage` 确定性输出 `recommendedEntry: 'direct' | 'sandbox' | 'plan-first'` 与单一 `[NEXT STEP]`，仅移除 `doc-audit.mjs:165` `fileCount >= 6 -> Case 4` 钝化悬崖（保留 `:86,161,169` `fileCount >= 12` PRD 判据），保持 `Case 5` 与 `PRD` 严格正交，且统筹 `doc-plan-brief.mjs` 两处（`handleNoteSubcommand` 与 `handleTriageSubcommand`）按需触发 Living Visual Brief / Prototype（局部可逆默认零 Brief 开销，兼容多轮讨论 `fixtures-living-brief.mjs`）。
- [ ] C10: `templates/agents-project.md`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`AGENTS.md`、`references/collaboration.md`、5 份受影响 `kit/skills/*/SKILL.md` 及 `scripts/dev/preflight*`（含同步 `fixtures-r6d-contracts.mjs`）完成同构同步，严守 `SKILL.md <= 14,336 B / <= 180 L`、`AGENTS.md <= 30 KB`、`equip.mjs . --check` 字节一致与零特定 E2E 驱动硬编码。
- [ ] C11: 新增 `scripts/dev/fixtures-heterogeneous-dual-loop.mjs` (new) 覆盖 7 类异构仿真仓库（空/极简仓、Node/TS 单包与 Monorepo、Python/Go/Rust、Prisma/SQL、UI 前端、无清单非 JS 通用、`generic-git`），双向验证完整双环流转零项目定制补丁。
- [ ] C12: 补齐并更新本里程碑全部双向故障注入样本，完成 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md` 与 `README.en.md` 最终全局对齐，运行全部 10 项全仓门禁、`verify-injections.mjs --jobs 4`、`e2e-zip-harness.mjs` 与 `git archive` 用户包校验全部退出码 `0`。

## 九、待拍板问题

- 待确认：无

## 十、成功度量

| 度量 | 现状基线 | 目标 | 怎么采集 | 什么时候看 |
| --- | --- | --- | --- | --- |
| 策略冲突点数 | 5 处重算分歧（`workflow-policy` vs `review-empirical` 等） | 0 处分歧，全部单源读取 | `node scripts/dev/fixtures.mjs` 策略一致性断言 | Wave 1 合并后 |
| 单次 `flow verify` 架构图重校验次数 | 2 次（`edit-gate` + `flow-lifecycle-hooks`） | 1 次（干净 HEAD 回执复用） | `fixtures-policy-axes.mjs` 调用计数断言 | Wave 1 合并后 |
| 探索期失败误建远端 Issue 数 | 默认每次失败即建单 | 0（仅外环阻断或显式 `--escalate` 建单） | `fixtures-policy-axes.mjs` Mock client 断言 | Wave 1 合并后 |
| 逐波独立全绿合入率 | 0/3 | 3/3 波次各自通过全量门禁与故障注入 | 每波 PR 实证日志 | 每波合并前 |
| 异构栈双环通过率 | 未覆盖沙箱双环 | 7/7 异构仿真仓库正反双向 100% 通过 | `fixtures-heterogeneous-dual-loop.mjs` | Wave 3 合并后 |

- **如果目标没达到**：任一 Wave 门禁或故障注入未全绿即阻断合入，严禁弱化 `preflight` / `fixtures` / `verify-injections` 放行。

## 十一、门型与回滚路径

- **门型判定**：`one-way`（涉及 `kit/skills/` 分发内核、`templates/`、`AGENTS.md` 与 `scripts/dev/preflight*` 高风险契约路径，必须经独立 Critique、用户 `approve` 及每片独立代码审查 + 两阶段故障注入）。
- **回滚路径**：3 个切片按 Wave 1 -> Wave 2 -> Wave 3 独立分支与 PR 渐进合入；任一片合入后若发现回归，直接对对应 PR 执行 `git revert -m 1 <merge-sha>` 并重跑 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 即可干净还原，不破坏既有任务账本字段向后兼容性（新增账本字段均为可选缺省值）。

## 十二、依赖与前置条件

| 依赖 | 类型 | 就绪状态 | 没有它会怎样 |
| --- | --- | --- | --- |
| 本仓 `main @ 5feb0db` 全绿基线 | 技术依赖 | 已就绪 | 无法区分新增回归与既有问题 |
| Node 18+ 运行时与 Git worktree 支持 | 技术依赖 | 已就绪 | 无法运行沙箱与外环隔离测试 |
| 独立 Critique 与人类维护者 `approve` | 审批 | 待本规划完成后触发 | 按规则禁止进入 Wave 1 编码 |

## 十三、风险与开放问题

| 风险 | 可能性 | 影响 | 缓解办法 |
| --- | --- | --- | --- |
| 紧文件超 800 行（`review-ledger.mjs` 798L、`review-empirical.mjs` 797L、`flow-inspect.mjs` 795L、`fixtures-iterate-evolution.mjs` 795L、`preflight-suite.mjs` 790L、`flow-merge.mjs` 789L、`flow-lifecycle.mjs` 784L、`doc-audit.mjs` 777L、`ledger.mjs` 756L、`workflow-policy.mjs` 755L） | 高 | 触发 `edit.file-oversized` 阻断 | 新增核心逻辑全部抽入 `gate-receipt.mjs` (new)、`sandbox-scope.mjs` (new) 与 `flow-sandbox.mjs` (new)，原紧文件只做薄委托或原地替换 |
| 当波行为重构打破既有夹具或故障注入锚点 | 高 | 当波 PR 门禁红灯 | 实行逐波独立全绿合门：每份切片 SPEC 显式列出受波及旧测试与注入表并在当波同步升级 |
| `SKILL.md` 超 14,336 B 或 `AGENTS.md` 超 30 KB 预算 | 中 | `preflight` / `compose-agents --check` 失败 | Wave 3 采用紧凑表格式写法替换冗余旧句，改后逐份核验字节与行数预算 |

## 澄清与补充记录

- 已确认：采用「隔离沙箱高频迭代 + 单一外环铁门」双环架构，不拆两套合门规则。
- 已确认：Wave 拓扑采用 Wave 1 (`single-source-policy-core`) -> Wave 2 (`sandbox-dual-loop-flow`) -> Wave 3 (`triage-brief-contract-parity`) 严格顺序依赖，每波自包含完成 `docs/feature-map.json`、`docs/architecture-map.html`、既有夹具与故障注入同步，确保逐波独立全绿且同波零文件重叠。
- 已确认：全栈通用性作为核心硬要求，必须覆盖 7 类异构仿真仓库双向验证。

> 确认需调整系统模块或对外契约时，以此 PRD 为依据补充 `docs/specs/` 后再进入实现；需求全部交付后随同关联 `SPEC`/`Todo` 成对归档至 `docs/archive/prd/`；`1:N` 总控 PRD 走四态闭环（子切片合入时仅追加关联进度，全部分支交付完成后统一归档总控 PRD）。
