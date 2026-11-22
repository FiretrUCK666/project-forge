---
kind: spec
title: Slice 6C：跨仓隔离、并发实证豁免与角色溯源防绕过
status: approved
tier: L3
created: 2026-11-22
updated: 2026-11-22
issue: 143
pr: null
branch: feat/w6c-harness-gates-provenance
owner: plan-w6
plan_mode: interactive
approved: true
implemented: false
plan_critique: "passed (reviewer=critic-w6-r2, round=1, sha=2912481b85f3, summary=Round 2 independent critique PASS (#599))"
related_prd: ../prd/261122-issue143-w6-universal-architecture-prd.md
related_todo: ../todo/261122-issue143-w6c-harness-gates-provenance-todo.md
high_risk_paths: [kit/]
task_id: w6c-harness-gates-provenance
depends_on: [w6a-survey-handoff-core, w6b-kit-single-source-hygiene]
scope_files: [kit/skills/dev-flow/scripts/flow.mjs, kit/skills/dev-flow/scripts/flow-issues.mjs, kit/skills/dev-flow/scripts/flow-inspect.mjs, kit/skills/dev-flow/scripts/flow-start-provenance.mjs, kit/skills/dev-flow/scripts/flow-merge.mjs, kit/skills/dev-flow/scripts/flow-merge-claim.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-flow/scripts/flow-start-helpers.mjs, kit/skills/dev-flow/scripts/worktree-deps.mjs, kit/skills/dev-plan/scripts/doc-plan-ops.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-review/scripts/review-empirical-state.mjs, kit/skills/dev-review/scripts/review-locks.mjs, kit/skills/lib/cli.mjs, kit/skills/lib/exit-codes.mjs, kit/skills/lib/ledger.mjs, kit/skills/lib/docs.mjs, kit/skills/lib/doc-approval.mjs, kit/skills/lib/harness-context.mjs, kit/skills/lib/workflow-policy.mjs, kit/skills/lib/workflow-policy-next.mjs, kit/skills/lib/escalation.mjs, kit/skills/lib/issue-template-hydrate.mjs, kit/skills/lib/pr-template-hydrate.mjs, kit/skills/lib/handoff-package.mjs, .agents/skills/dev-flow/scripts/flow.mjs, .agents/skills/dev-flow/scripts/flow-issues.mjs, .agents/skills/dev-flow/scripts/flow-inspect.mjs, .agents/skills/dev-flow/scripts/flow-start-provenance.mjs, .agents/skills/dev-flow/scripts/flow-merge.mjs, .agents/skills/dev-flow/scripts/flow-merge-claim.mjs, .agents/skills/dev-flow/scripts/flow-lifecycle.mjs, .agents/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, .agents/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs, .agents/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, .agents/skills/dev-flow/scripts/flow-start-helpers.mjs, .agents/skills/dev-flow/scripts/worktree-deps.mjs, .agents/skills/dev-plan/scripts/doc-plan-ops.mjs, .agents/skills/dev-review/scripts/review-pack.mjs, .agents/skills/dev-review/scripts/review-empirical.mjs, .agents/skills/dev-review/scripts/review-empirical-state.mjs, .agents/skills/dev-review/scripts/review-locks.mjs, .agents/skills/lib/cli.mjs, .agents/skills/lib/exit-codes.mjs, .agents/skills/lib/ledger.mjs, .agents/skills/lib/docs.mjs, .agents/skills/lib/doc-approval.mjs, .agents/skills/lib/harness-context.mjs, .agents/skills/lib/workflow-policy.mjs, .agents/skills/lib/workflow-policy-next.mjs, .agents/skills/lib/escalation.mjs, .agents/skills/lib/issue-template-hydrate.mjs, .agents/skills/lib/pr-template-hydrate.mjs, .agents/skills/lib/handoff-package.mjs, .agents/skills/.pf-manifest.json, docs/feature-map.json, scripts/dev/fixtures-w6c-harness-gates.mjs, scripts/dev/injections-data-w6c.mjs]
---

# Slice 6C：跨仓隔离、并发实证豁免与角色溯源防绕过 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块重构、接口/契约变更或高风险改造；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / Issue / PR | 见 Frontmatter `branch` / #143 / 未关联 |
| 负责人 / 内审状态 | plan-w6 / `pending` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 PRD / Todo | `docs/prd/261122-issue143-w6-universal-architecture-prd.md` / `docs/todo/261122-issue143-w6c-harness-gates-provenance-todo.md` |

- **变更一句话**：加固跨仓 CWD 错位 fail-closed 拦截、无损水合与 SPEC 状态同步、`low` 风险纯文档实证豁免、多语言单栈/并发验证识别、`pnpm` junction/`fs.allow`/游离槽位兼容性，以及防同会话伪造 `--owner` 的真实角色溯源校验。

## 系统变更全景

```mermaid
flowchart LR
  CLI["跨仓与角色入口"] --> Gate["策略与豁免门禁"]
  Gate --> Flow["归档与工作树"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/cli.mjs` & `kit/skills/lib/exit-codes.mjs` & `kit/skills/dev-flow/scripts/flow.mjs` & `kit/skills/dev-flow/scripts/flow-issues.mjs` | 改造 | 跨仓 CWD 错位 fail-closed 拦截 `BLOCKED_CROSS_REPO_CWD_MISMATCH`（登记 `exit-codes.mjs`），接入 6B 单源 `SUBCOMMAND_META` |
| `kit/skills/lib/issue-template-hydrate.mjs` & `kit/skills/lib/pr-template-hydrate.mjs` | 改造 | 兼容 `**Bold**` 提示模板且零 section 命中时完整保留 `--body` |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` & `flow-lifecycle-helpers.mjs` & `flow-lifecycle-finalize.mjs`(new) | 改造/拆分 | 拆分 `finalize` 逻辑控制 `<= 800` 行，归档时同步 SPEC 正文状态表与 YAML `status: implemented` |
| `kit/skills/dev-review/scripts/review-empirical.mjs` & `review-empirical-state.mjs` & `review-pack.mjs` & `kit/skills/lib/escalation.mjs` | 改造 | `low` 风险纯文档豁免强制 runtime/fault/`--include-diff` 阻塞；单栈实证收集过滤；`escalation` 按错误签名去重 |
| `kit/skills/lib/workflow-policy.mjs` & `kit/skills/lib/workflow-policy-next.mjs` | 改造 | 放行 `--maxWorkers`/`--workers`/`--bail`/`--config.verify-deps-before-run=false`；多语言单栈作用域验证识别 |
| `kit/skills/dev-flow/scripts/worktree-deps.mjs` & `docs/feature-map.json` | 改造 | 修复独立 `mount` 更新 `mountedDepsByWorktree`、透传 `pnpm` junction 环境变量与 Vite `fs.allow` 引导；修 `verify-edit-gate` 兼容 |
| `doc-plan-ops.mjs` & `docs.mjs` & `doc-approval.mjs` & `harness-context.mjs` & `ledger.mjs` & `flow-inspect.mjs` & `flow-start-provenance.mjs`(new) & `flow-merge.mjs` & `flow-merge-claim.mjs`(new) & `flow-lifecycle-hooks.mjs` & `flow-start-helpers.mjs` & `review-locks.mjs` & `handoff-package.mjs` | 改造/拆分 | 仓外 `.git/project-forge-flow/` 规划溯源基线防未留痕直改 Todo `owner:` 与伪传 `--owner` 绕过；拆小 `flow-inspect`/`flow-merge` `<=800` 行并界定 CLI 证明边界 |

## 一、背景与边界声明

- **要改什么**：改造 `kit/skills/dev-flow/`、`kit/skills/dev-review/scripts/{review-pack,review-empirical,review-empirical-state,review-locks}.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/lib/{cli,exit-codes,ledger,docs,doc-approval,harness-context,workflow-policy*,escalation,issue-template-hydrate,pr-template-hydrate,handoff-package}.mjs` 与 `docs/feature-map.json`（同步 `.agents/skills/`）。
- **不改什么**：不碰 `scripts/`（除 `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) 与 `injections-data-w6c.mjs`(new)）、`templates/`、`kit/skills/dev-govern/`、`kit/skills/dev-plan/scripts/{doc-plan,triage-rules,doc-audit*}.mjs`、`kit/skills/dev-edit/`、`kit/skills/dev-explore/`、`kit/skills/dev-review/scripts/review-gates.mjs` 等 6A/6B 文件。
- **本期不做**：不改动 S1 勘察逻辑与 `SUBCOMMAND_META` 定义本身（直接消费 6B 落盘的 `kit/skills/lib/subcommand-meta.mjs`(new) 与 `edit-gate.mjs` `--base`/游离 `HEAD` 支持）。
- **复用既有模块**：复用 `kit/skills/lib/subcommand-meta.mjs`(new)（6B 落盘）、`kit/skills/lib/doc-approval.mjs`（`collectOwnerHistory`）、`kit/skills/lib/harness-context.mjs`（`checkAuthorIsNotImplementer`）、`kit/skills/lib/profile-sniffer.mjs`（6A 拆分的子包探测）。
- **架构基线关系**：保持 `kit/` 零第三方依赖与 `<= 800` 行红线（`flow-lifecycle.mjs` 现为 798 行、`flow-merge.mjs` 793 行、`flow-inspect.mjs` 792 行、`docs.mjs` 791 行，必须拆出 `flow-lifecycle-finalize.mjs`(new)、`flow-start-provenance.mjs`(new)、`flow-merge-claim.mjs`(new)，并把溯源持久辅助放入 `doc-approval.mjs`/`ledger.mjs` 控制 `docs.mjs` 增量 `<= 5` 行），执行 `node scripts/equip.mjs .` 保持 `.agents/skills/` 一致（依据：`docs/TDD.md`）。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **跨仓工作目录不匹配拦截与阻断码登记（`kit/skills/lib/cli.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs`、`review-pack.mjs`）**：
   - 在 `kit/skills/lib/exit-codes.mjs` 的 `FACT_CODES`（`EXIT.FACT = 3`）正式登记 `BLOCKED_CROSS_REPO_CWD_MISMATCH` 与 `BLOCKED_PROVENANCE_TAMPERED`，确保 `scripts/dev/exit-code-parity.mjs` 与 `preflight.mjs` 退出码档位对拍通过。
   - 在 `cli.mjs` 导出并集成 `validateCrossRepoTarget({ cwd, targetDir, argv, explicitDir, scriptPath, urlRepo })`：
     - 当命令未显式传入 `--dir` / `--repo` 时，若脚本所在仓库根（从 `import.meta.url` 追溯含 `.agents/skills` 的宿主仓根）或显式传入的 Issue/PR URL 所属 `owner/repo` 与 `process.cwd()` 解析出的 Git 仓根（`mainRoot` / remote `owner/repo`）不一致，**立即 fail-closed 拦截**，抛出结构化错误码 `BLOCKED_CROSS_REPO_CWD_MISMATCH`（退出码 `EXIT.FACT` = 3），提示显式传入 `--dir <targetRepo>` 或切入目标仓执行；
     - 在 `flow.mjs`（特别覆盖 `issue`、`intake`、`start`、`submit`、`merge`、`close`、`milestone` 等含远端读写路径）与 `flow-issues.mjs` 统一执行该校验；仅当显式传 `--dir` 时允许跨目录精准定位目标仓。
   - 同步让 `flow.mjs`（头注释补齐全部子命令）与 `review-pack.mjs`（头注释补齐 `子命令：` 列表）从 `kit/skills/lib/subcommand-meta.mjs`(new) 导入 `subcommandNamesFor('flow')` / `subcommandNamesFor('review-pack')`，使 `scripts/dev/subcommand-parity.mjs`(new) 升级为 6/6 全量强制校验。

2. **`**Bold**` 提示模板水合与 `finalize` SPEC 正文状态同步（`issue-template-hydrate.mjs`、`pr-template-hydrate.mjs`、`flow-lifecycle.mjs`、`flow-lifecycle-finalize.mjs`(new)）**：
   - `issue-template-hydrate.mjs` 与 `pr-template-hydrate.mjs`：
     - 除识别 `## Heading` 二级标题分段外，支持识别 `**Bold**` 提示行/段落型模板（如 `**Describe the bug**`、`**背景与现象**`、`### ...` 等）；
     - 当传入用户 `--body`（或 `rawBody`）且模板与正文的 section 匹配数为 **0** 时，绝不丢弃用户原文，改为在干净剥离模板注释占位后将用户 `--body` 完整追加/嵌入正文保留。
   - 从 `flow-lifecycle.mjs`（798 行）拆出 `finalize` 核心逻辑至 `kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`(new)：
     - 归档 `SPEC` 时在更新 YAML `status: implemented` 与 `implemented: true` 的同时，同步更新正文 `## 文档信息与变更概览` 表格中的 `当前状态` 单元格（替换为 `` `implemented` ``）及 `更新` 日期与关联归档路径，消除正文状态表与 YAML 脱节。

3. **`low` 风险纯文档豁免与错误签名建单去重（`review-empirical.mjs`、`review-empirical-state.mjs`、`review-pack.mjs`、`escalation.mjs`）**：
   - `review-empirical.mjs` & `review-pack.mjs`：当 `computeEmpiricalRequirements` 判定 `isLowRiskPureDoc === true`（`policy.riskTier === 'low'` 且无 `high-risk` / `one-way` / 门禁弱化 / UI 视觉文件）时：
     - `empiricalRequired = false`、`faultRequired = false`、`businessFlowEmpiricalRequired = false`；
     - `evaluateIncludeDiffGate` 自动放行 `--include-diff`（无需先跑 runtime `check-empirical` 与 `check-fault`），仍保留机械包校验与纯文档静态检查（死链 / Mermaid 16/12 / 秘密字面量）。
   - `escalation.mjs`：在 `escalateToBackend` 建单前计算规范化错误签名指纹 `computeEscalationFingerprint(item)`（基于 `category + pattern/code + normalizedTargetFile + normalizedSummary`），先检索当前后端（GitHub open/closed 近期工单或 `local-issues`）是否已存在同签名活跃/近期工单；命中则追加进展评论或复用现有工单号（返回 `deduplicated: true`），绝不重复建单。

4. **并发命令等价与多语言单栈作用域验证（`workflow-policy.mjs`、`workflow-policy-next.mjs`、`review-empirical-state.mjs`、`review-empirical.mjs`）**：
   - `workflow-policy-next.mjs` 的 `normalizeConcurrentVerifyCommand(cmd)` 扩展剥离 `--maxWorkers[= ]\S+`、`--workers[= ]\S+`、`--bail`、`--config.verify-deps-before-run=false`（以及 `--jobs` / `-j`），使 `isEquivalentConcurrentCommand` 在并发或 pnpm 跳过重校验参数下正常匹配配置命令。
   - `workflow-policy.mjs` 新增多语言仓单栈局部变更验证作用域分析函数 `resolveScopedVerificationGate({ repoRoot, changedFiles, packages, profile })`：当变更文件全部落在单一语言栈/子包内且其他栈无文件变更时，记录受波及子包与栈集合（`affectedStacks` / `affectedPackages`）；在 `review-empirical-state.mjs:32-48`（`collectDevProfileEmpiricalCmds`）与 `review-empirical.mjs:69` 接入该作用域过滤逻辑，将 `Dev Profile` 全栈验证命令按变更栈/子包作用域匹配过滤（同时标注被跳过的未改栈命令及原因），避免只改 TS 前端包时因本地缺失未改栈运行时（如 `go`/`cargo`）被误阻塞。

5. **Worktree 依赖 `pnpm` 兼容与 `verify-edit-gate` 游离槽修复（`worktree-deps.mjs`、`docs/feature-map.json`）**：
   - `worktree-deps.mjs`：
     - 修复独立 CLI 执行 `worktree-deps.mjs mount` 时同步回写任务账本中的 `mountedDepsByWorktree[wtRel]`，与 `flow start` 保持一致；
     - 检测到 `pnpm` junction 挂载时，在输出环境提示及导出的工作树运行环境中注入 `npm_config_verify_deps_before_run=false`，并在检测到 Vite 配置时输出 `server.fs.allow` 放行共享 `node_modules` 真实路径的可操作引导（写入 JSON `hints` 与标准输出）。
   - `docs/feature-map.json` 中的 `verify-edit-gate`：直接消费 6B 在 `kit/skills/dev-edit/scripts/edit-gate.mjs` 落地的 `--base {ref}` 与游离 `HEAD` 兼容能力（更新验证命令传入 `--mode verify --base main` 或兼容游离 `review-*` 槽自动回退基线），确保在游离审查槽下执行 `verify-edit-gate` 不误报且不引用不存在参数。

6. **强化规划/实施/审查真实角色溯源校验（`doc-plan-ops.mjs`、`docs.mjs`、`doc-approval.mjs`、`ledger.mjs`、`harness-context.mjs`、`flow-inspect.mjs`、`flow-start-provenance.mjs`(new)、`flow-merge.mjs`、`flow-merge-claim.mjs`(new)、`flow-lifecycle-hooks.mjs`、`flow-start-helpers.mjs`、`review-locks.mjs`、`handoff-package.mjs`）**：
   - **仓外不可伪造规划溯源基线（彻底摒弃 Git commit `user.name` 误杀方案）**：
     - 本地多代理模式下，`plan-w6` 与隔离 `impl-*` 子代理共享宿主的同一 `git config user.name / user.email`，因此**绝不以 Git commit author 比对拦截隔离实施子代理**。
     - 改由 `doc-plan init`（`doc-plan-ops.mjs`）与 `doc-plan link`（`docs.mjs` 调用 `doc-approval.mjs` / `ledger.mjs` 持久化辅助，保持 `docs.mjs` 791 行安全余量）将不可伪造的规划作者基线 `planningProvenance`（含 `planningOwner`、`previousOwners`、`docRelPaths`、`ownerHeaderHash`——仅覆盖 Frontmatter `owner` / `previous_owners` / `owner_changed_reason` / `plan_critique` 规范化哈希及允许留痕变更路径）同步写入仓外 `.git/project-forge-flow/` 账本（包含任务账本与独立文档溯源索引，确保未执行 `start` 的 Case 3 Todo 也有基线）。
     - 若需合法移交或修改负责人，必须经过 `doc-plan link --owner {newOwner} --owner-reason "{reason}"` 走留痕通道同步刷新 `previous_owners` 与仓外基线哈希。
   - **三点闭环拦截未留痕直改与自建自改**：
     - 将 `flow-inspect.mjs`（792 行）的启动溯源/CWD 校验拆出至 `kit/skills/dev-flow/scripts/flow-start-provenance.mjs`(new)，将 `flow-merge.mjs`（793 行）的认领与合并前溯源/视觉门检查拆出至 `kit/skills/dev-flow/scripts/flow-merge-claim.mjs`(new)。
     - 在 `start`（`flow-inspect.mjs` -> `flow-start-provenance.mjs`）、`claim` / `assertPreMergeGates`（`flow-merge.mjs` -> `flow-merge-claim.mjs`）、`submit`（`flow-lifecycle-hooks.mjs` `assertSubmitOwnership`）与 `review-locks.mjs` 联合核验：对照当前工作区 Todo/SPEC `owner:` / `previous_owners:` 与仓外 `.git/project-forge-flow/` 基线及 `HEAD` 版本——若检测到未走 `doc-plan link --owner-reason` 而直接篡改文档 `owner:`，立即阻断并报 `BLOCKED_PROVENANCE_TAMPERED`（`EXIT.FACT = 3`）；若 `checkAuthorIsNotImplementer`（`harness-context.mjs`）命中 `planningOwner ∪ previous_owners ∪ owner` 与 `implementerId` / `claimedBy` / `--agent` 重叠，报 `BLOCKED_AUTHOR_IS_IMPLEMENTER`；且 `Case >= 2` 多代理模式下强校 `--agent` 非协调者/非规划者/非审查者。
   - **诚实界定 `handoff-package.mjs` 证明边界**：在 `handoff-package.mjs` 的 `coordinator` / `implementer` / `reviewer` 交接包中明确区分两类事实：(a) CLI 可机械实证的边界（仓外 `planningProvenance` 完整性、`owner:` 未经 `link` 篡改校验、`implRoot !== mainRoot` 隔离工作树及声明代理标识互斥）；(b) 依赖宿主协调器调度隔离的运行时前提（不在 CLI 中伪造无法由子进程取得的 OS 进程级上下文证明）。

### 数据与状态变更

- `kit/skills/lib/exit-codes.mjs` 的 `FACT_CODES` 新增 `BLOCKED_CROSS_REPO_CWD_MISMATCH` 与 `BLOCKED_PROVENANCE_TAMPERED`。
- 仓外 `.git/project-forge-flow/` 账本及文档溯源索引新增/规范化：`mountedDepsByWorktree` 在独立 `worktree-deps.mjs mount` 后实时更新；`planningProvenance`（`{ planningOwner, previousOwners, docRelPaths, ownerHeaderHash, recordedAt }`）在 `doc-plan init/link` 落盘并在 `start`/`claim`/`submit` 校验。
- `escalation.mjs` 持久化或检索工单时附带可机器匹配的签名指纹标记（如 `pf-sig:<hash12>`）。

### 异常、回退与安全边界

- `validateCrossRepoTarget` 仅在隐式 `cwd` 与脚本/目标仓库发生跨仓错位时阻断；显式传入 `--dir <targetRepo>` 指向合法仓库时正常放行。
- 存量历史规划文档若早于 `planningProvenance` 机制创建（仓外索引尚无记录），按 `HEAD` 与文档 `previous_owners ∪ owner` 回填只读基线而不误阻断存量合法流程，但在检测到工作区未留痕改写 `owner:` 时仍严格拦截 `BLOCKED_PROVENANCE_TAMPERED`。
- `low` 风险纯文档豁免仅限于 `riskTier === 'low'`，任何代码/配置/工作流/视觉文件/high-risk 命中均自动回落 `medium` / `high` 严格模式，不可降级。
- `escalation.mjs` 去重命中已关闭（`CLOSED`）且距今久远的历史工单时，仅去重 `OPEN` 状态或相同活跃周期指纹，避免已关闭旧单阻止真实回归重新立单。

### 实现顺序

1. 在 `kit/skills/lib/exit-codes.mjs` 登记新阻断码；改造 `kit/skills/lib/cli.mjs`（跨仓 CWD 错位拦截）、`kit/skills/dev-flow/scripts/flow.mjs`（接入 `SUBCOMMAND_META` + CWD 校验 + 头注释补齐）、`kit/skills/dev-flow/scripts/flow-issues.mjs`。
2. 改造 `kit/skills/lib/issue-template-hydrate.mjs` & `kit/skills/lib/pr-template-hydrate.mjs`；拆分 `kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`(new) 并实现 SPEC 正文状态表同步。
3. 改造 `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-empirical-state.mjs`、`review-pack.mjs`（`SUBCOMMAND_META` + 头注释 + `low` 文档豁免）、`kit/skills/lib/escalation.mjs`（错误签名去重）。
4. 改造 `kit/skills/lib/workflow-policy.mjs`、`workflow-policy-next.mjs`（并发 flags 等价 + 多语言单栈作用域识别）、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`docs/feature-map.json`（消费 6B `edit-gate.mjs` `--base`/游离 `HEAD` 支持）。
5. 落地仓外 `planningProvenance` 防伪造体系：`doc-plan-ops.mjs`、`docs.mjs`、`doc-approval.mjs`、`ledger.mjs`、`harness-context.mjs`，拆分 `flow-start-provenance.mjs`(new) 与 `flow-merge-claim.mjs`(new)，加固 `flow-inspect.mjs`、`flow-merge.mjs`、`flow-lifecycle-hooks.mjs`、`flow-start-helpers.mjs`、`review-locks.mjs`、`handoff-package.mjs`；运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`（含 `.agents/skills/.pf-manifest.json`）；编写 `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) 与 `scripts/dev/injections-data-w6c.mjs`(new) 并全量跑通门禁。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 仅在 `cli.mjs` 提示警告不阻断跨仓运行 | 打印 stderr 警告后仍继续向当前 CWD 建单 | 用户或自动化脚本忽略警告后仍会污染错误仓库远端 | 必须 fail-closed 阻断 |
| 按 Git commit author（`user.name`）比对拦截实施者 | 把 Todo 提交的 Git 作者当规划身份与实施 commit 作者比对 | 本地多代理模式下规划与隔离 `impl-*` 代理共享同一 `git config user.name`，会误杀全部合法隔离实施代理，且未提交的 Case 3 Todo 无历史 | 绝不采纳 Git `user.name` 拦截方案 |
| 在 `escalation.mjs` 用完整标题字符串精确匹配去重 | 标题完全相等才跳过建单 | 错误堆栈行号/时间戳轻微变化即失效，依然重复建单 | 必须按结构化签名指纹去重 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/cli.mjs` & `kit/skills/lib/exit-codes.mjs` & `flow.mjs` & `flow-issues.mjs` | 修改 | 跨仓 CWD 错位拦截 `BLOCKED_CROSS_REPO_CWD_MISMATCH`、`BLOCKED_PROVENANCE_TAMPERED` 登记、`flow.mjs` 接入 `SUBCOMMAND_META` | 所有 CLI 入口与 Issue 操作 |
| `kit/skills/lib/issue-template-hydrate.mjs` & `pr-template-hydrate.mjs` | 修改 | 兼容 `**Bold**` 提示模板且零命中保留 `--body` | Issue / PR 创建与提交 |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` & `flow-lifecycle-helpers.mjs` & `flow-lifecycle-finalize.mjs`(new) | 修改/新增 | 拆分 `finalize` 控制 `<=800` 行，同步归档 SPEC 正文状态表与 YAML | `flow finalize` 与归档闭环 |
| `kit/skills/dev-review/scripts/review-empirical.mjs` & `review-empirical-state.mjs` & `review-pack.mjs` & `kit/skills/lib/escalation.mjs` | 修改 | `low` 风险纯文档豁免 runtime/fault、单栈实证过滤、`review-pack` 接入 `SUBCOMMAND_META`、`escalation` 签名去重 | 审查包构建与缺陷升级 |
| `kit/skills/lib/workflow-policy.mjs` & `workflow-policy-next.mjs` & `worktree-deps.mjs` & `docs/feature-map.json` | 修改 | 扩展并发标志等价、多语言单栈验证、`pnpm` junction / `fs.allow` 与 `mountedDepsByWorktree` 修复、`verify-edit-gate` 消费 `--base`/游离槽兼容 | 并行工作树验证与功能地图 |
| `doc-plan-ops.mjs` & `docs.mjs` & `doc-approval.mjs` & `harness-context.mjs` & `ledger.mjs` & `flow-inspect.mjs` & `flow-start-provenance.mjs`(new) & `flow-merge.mjs` & `flow-merge-claim.mjs`(new) & `flow-lifecycle-hooks.mjs` & `flow-start-helpers.mjs` & `review-locks.mjs` & `handoff-package.mjs` & `.agents/skills/**` & `.agents/skills/.pf-manifest.json` & `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) & `scripts/dev/injections-data-w6c.mjs`(new) | 修改/新增 | 仓外 `.git/project-forge-flow/` 规划溯源基线防直改 `owner:` 与伪传绕过、CLI 证明边界界定、同步 `.agents/skills/`、正反双向夹具与故障注入 | 规划-实施-审查角色隔离与门禁 |

- **对外可见的变化**：跨仓未传 `--dir` 错位调用明确报错 `BLOCKED_CROSS_REPO_CWD_MISMATCH`；`low` 风险纯文档免跑重型 runtime 与故障注入；归档 SPEC 正文状态表与 YAML 自动对齐；未走 `doc-plan link` 直改 Todo `owner:` 被 `BLOCKED_PROVENANCE_TAMPERED` 阻断。
- **需要同步改的地方**：必须运行 `node scripts/equip.mjs .` 保持 `.agents/skills/`（含派生清单 `.agents/skills/.pf-manifest.json`）字节一致。

## 五、冻结的验收标准

- [x] C13: `kit/skills/lib/cli.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `kit/skills/dev-flow/scripts/flow-issues.mjs` 实现跨仓工作目录不匹配 fail-closed 拦截（`exit-codes.mjs` 登记 `BLOCKED_CROSS_REPO_CWD_MISMATCH`）；`flow.mjs` 与 `review-pack.mjs` 接入 `SUBCOMMAND_META` 单源并对齐文件头，6/6 脚本通过 `subcommand-parity.mjs`。
- [x] C14: `kit/skills/lib/issue-template-hydrate.mjs` 与 `kit/skills/lib/pr-template-hydrate.mjs` 兼容 `**Bold**` 提示模板且零 section 命中时完整保留 `--body`；`flow.mjs finalize` 同步归档 `SPEC` 正文状态表与 YAML `status: implemented`。
- [x] C15: `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-pack.mjs` 与 `kit/skills/lib/escalation.mjs` 对 `low` 风险纯文档变更豁免强制 runtime `check-empirical` / `faultRequired` / `--include-diff` 阻塞，且 `escalation.mjs` 按错误签名去重不重复建单。
- [x] C16: `kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-policy-next.mjs` 与 `kit/skills/dev-review/scripts/review-empirical-state.mjs` 扩展 `isEquivalentConcurrentCommand` 识别 `--maxWorkers` / `--workers` / `--bail` / `--config.verify-deps-before-run=false`；为多语言仓单栈局部变更提供子包/单栈作用域验证识别并在 `collectDevProfileEmpiricalCmds` 接入过滤（未改栈缺失环境不误阻塞）。
- [x] C17: `kit/skills/dev-flow/scripts/worktree-deps.mjs` 与 `docs/feature-map.json` 修复独立 `mount` 更新 `mountedDepsByWorktree`、为 `pnpm` junction 透传 `npm_config_verify_deps_before_run=false` 并给出 Vite `fs.allow` 引导，基于 6B 在 `edit-gate.mjs` 落地的 `--base` 与游离 `HEAD` 支持修复 `verify-edit-gate` 在游离 review 槽执行兼容性；拆小 `flow-lifecycle.mjs`（798 行）、`flow-merge.mjs`（793 行）、`flow-inspect.mjs`（792 行）使全部 `.mjs` `<= 800` 行。
- [x] C18: 强化规划/实施/审查真实角色溯源校验：由 `doc-plan init/link`（`doc-plan-ops.mjs` / `docs.mjs` / `doc-approval.mjs` / `ledger.mjs`）写入仓外 `.git/project-forge-flow/` `planningProvenance` 基线，在 `start`/`claim`/`submit` 拦截未经 `doc-plan link` 直改 Todo `owner:` 的篡改（在 `exit-codes.mjs` 登记 `BLOCKED_PROVENANCE_TAMPERED`）与历史规划作者重叠（`BLOCKED_AUTHOR_IS_IMPLEMENTER`），不按 Git commit author 误杀本地隔离实施代理并诚实界定 `handoff-package.mjs` 证明边界；Slice 6C 新增正反双向夹具（`scripts/dev/fixtures-w6c-harness-gates.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6c.mjs`(new)），执行 `node scripts/equip.mjs .` 后全量门禁全绿。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`two-way`；回滚做法：在隔离分支直接 `git revert <commit>` 即可回退全部门禁与状态机调整。
- **高风险路径**：触及 `kit/` 高风险路径（须独立审查 + 两阶段故障注入）。
- **故障注入预演**：在 `scripts/dev/injections-data-w6c.mjs`(new) 注入破坏 `BLOCKED_CROSS_REPO_CWD_MISMATCH` 拦截、破坏 `**Bold**` 模板 `--body` 保留、破坏 `escalation` 签名去重、破坏仓外 `planningProvenance` 直改 `owner:` 篡改拦截（`BLOCKED_PROVENANCE_TAMPERED`），跑 `node scripts/dev/verify-injections.mjs --only W6C` 验证变红捕获。

## 澄清与补充记录

- 已定（2026-11-22）：6C 严格依赖 `6A` 与 `6B` 合入 `main` 后再启动实施，`scope_files` 与 6A/6B 零文件重叠（`doc-plan.mjs` 归 6B、`doc-plan-ops.mjs` 与 `docs.mjs`/`doc-approval.mjs`/`ledger.mjs` 归 6C；`edit-gate.mjs` 与 `review-gates.mjs` 归 6B；`.agents/skills/.pf-manifest.json` 属 `DERIVED_MANIFEST_PATHS` 按 `depends_on` 顺序更新）。

## 实现说明

> 代码合入前补齐，随功能 PR 一同提交并标记 `implemented`；若常青架构已同步进 `docs/TDD.md`，随关联 `PRD`/`Todo` 成对归档至 `docs/archive/specs/`。

- **实际落地摘要**：完成 Slice 6C `C13..C18` 及并入同域模块的三项系统性根治（根治 A：`workflow-policy-next.mjs` 从 `buildSliceGraph` 回填 `depends_on` / `scope_files` 且 `doc-slice-graph.mjs` 对空写域活跃任务强制 `conservativeSerial: true`；根治 B：`flow-merge-claim.mjs` `evaluateMasterIssueCloseGuard` 在 `main` 尚有未完兄弟切片时禁止关闭 `multi_spec: true` 总控 Issue；根治 C：`cli.mjs` 与文本/模板/评论入口统一拦截非法 ASCII C0 控制字符 `BLOCKED_ASCII_CONTROL_CHAR`）；并拆分 `flow-lifecycle-finalize.mjs`、`flow-start-provenance.mjs` 与 `flow-merge-claim.mjs` 使全部 `.mjs` 严守 `<= 800` 行。
- **与草案的差异**：经 `@coordinator` 授权，同步更新 5 处范围外旧测试/注入锚点以对齐 6C 新契约（`scripts/dev/fixtures-review-empirical.mjs:408-421`、`scripts/dev/fixtures-flow.mjs:240-256`、`scripts/dev/fixtures-flow-truth.mjs:384`、`scripts/dev/injections-data-core.mjs` `I48`、`scripts/dev/injections-data-repo-alignment.mjs` `I395`），并在 `exit-codes.mjs` 增补 `BLOCKED_ASCII_CONTROL_CHAR` 退出码登记。
- **关联同步文件**：`.agents/skills/` 与 `.agents/skills/.pf-manifest.json`（经 `node scripts/equip.mjs .` 同步）、`docs/feature-map.json`、`scripts/dev/subcommand-parity.mjs`、`scripts/dev/fixtures-w6c-harness-gates.mjs`、`scripts/dev/injections-data-w6c.mjs`。

- **实际落地摘要**：待实施后填写
- **与草案的差异**：待实施后填写
- **关联同步文件**：待实施后填写
