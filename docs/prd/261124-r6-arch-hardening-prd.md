---
kind: prd
title: Round-6 与本仓全检单源架构根治
status: active
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
owner: plan-r6-arch
plan_mode: interactive
plan_critique: "passed (reviewer=critic-r6d-refresh, round=2, sha=278b92ac4bac, summary=r6a/r6b/r6c已合入归档且stripCritiqueMeta升级后独立复核通过)"
related_spec: null
related_todo: null
multi_spec: true
case_type: 4
---

# Round-6 与本仓全检单源架构根治 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-24` / `2026-11-24` |
| 关联 Issue / PR | 未关联 / 未关联 |
| 提出方 / 负责人 | plan-r6-arch |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联设计 / 任务单 | 按 `r6a` / `r6b` / `r6c` / `r6d` 四份切片 `SPEC + Todo` 认领 `C1..C16` |

- **目标读者**：实现者、审查者与后续接手人

## 一、要解决的问题

### 现状与痛点

基于 Round-6 四仓盲测（`r6-empty-enterprise`、`r6-dotenv-enterprise`、`r6-blinker-v6`、`r6-commons-codec-fork`）与本仓全检实证，当前存在四类结构性断裂：
- **默认分支与状态机分叉**：`kit/skills/lib/git.mjs` `resolveDefaultBranch` 兜底 `'main'` 与 `kit/skills/lib/ledger.mjs` `createDefaultLedger` 预设 `baseBranch: 'main'`，导致 `master`-only 仓误建 `main`；`detectCommitStyle` 在 `scripts/lib/survey-git-fast.mjs` 与 `kit/skills/lib/git.mjs` 各存副本且浅克隆 3 提交易反转；`TERMINAL_TASK_STATUSES` 未含 `'merged'` 且 `evaluateNextState` 未过滤孤儿终态，导致本仓 `.worktrees/.state/tasks/` 7 个遗留台账触发 `MULTIPLE_ACTIVE_TASKS` / `BLOCKED_NOT_CLAIMED`；`flow-cleanup.mjs` 与 `flow-next.mjs` 失一致；`flow-merge.mjs` 在前置短路 `GenericRemoteBackend.mergePr`；跨机缺 `.git/issues` 死循环、`plan-exit-gate.mjs` `'ledgerEntry' in doc` 假阳性及跨平台认领撞车。
- **多套扫描器并存、长聊失忆与简报膨胀**：仓内并存 `collectPlanDocs`、`collectCandidateDocs`、`listDocs` 三套规划扫描且 `kit/skills/lib/session-orient.mjs` 反向导入 `kit/skills/dev-plan/scripts/doc-audit.mjs`；`doc-plan-ops.mjs` `initDoc` 仅查当日文件名致重复建档、`approveSpec` 不联动更新 Todo；`flow-lifecycle-finalize.mjs` 与 `kit/skills/lib/docs.mjs` 不同步 Todo/PRD 正文表；`init` 前长聊缺磁盘缓冲且 `plan-next --handoff` / `critique-scope` 缺上下文简报；`critique-scope` 串行真跑重测试挂起且丢失 `findings`；`review-pack --json` 将 `contextBrief` 序列化 3 遍且 `evaluateToolStaleness` 串行 `git show` 耗时 `6–12s`。
- **`dev-iterate` 断链与跨门禁打架**：`kit/skills/dev-iterate/scripts/iterate.mjs` 漏导 `printNextStep`、`extractSymbols` 传参错位、`slugTestToken` 误伤 `prd`、缺失 `.venv` `pytest`/`mvn`/`tap` 多栈 Runner、`signals.jsonl` 推荐归档 PRD 与 `README.en.md`、`cycle` 不累加；`review-gates.mjs`、`edit-gate.mjs`、`govern-checks.mjs` 在行数（800 vs 801）、超大豁免、归档移动（含 `reviewWorktreePath`）及 `Test Files: 0` 上相互冲突；`review-ledger.mjs` Round 3 `--human-approved` 缺 `--reason` 校验且丢 `baseLedger.rebuts`。
- **契约漂移、冲突规则与硬编码强锁**：`kit/skills/dev-review/SKILL.md` 含幽灵参数 `--target`、`flow.mjs` `printHelp()` 漏参数、`scripts/dev/preflight-contract-rules.mjs` 强锁多文件全文复制，导致 `SKILL.md`/`AGENTS.md`/`references/` 重复抄写并存在 Case 1 隔离、`--planning` 双写、Case 3 Todo Critique、外部搜索一刀切及 `flow merge` 权限冲突。

### 目标用户与使用场景

- 使用 `project-forge` 接管外部仓库及多代理/跨机团队协作的开发者与 AI 调度器。
- 在本仓通过八大内置技能执行需求规划、实现、双门审查与持续治理的维护者。

### 产品目标

- 将默认分支解析、提交风格识别、任务活性分类、运行时快照与 Git-Ref CAS 原子认领收敛为单一真源，使本仓 7 个遗留台账现场 `flow.mjs next --json` 零误报且 `master`-only 仓零误建 `main`。
- 用唯一 `kit/skills/lib/plan-index.mjs` (new) 替换 3 套旧扫描器，打通 `session-state.json` `preInit` 长聊缓冲、单源指针简报协议与 `syncPlanDocBodyMeta` 双向正文投影，让 `critique-scope` 静态毫秒响应且守住永恒客观底线。
- 修复 `dev-iterate` 多生态运行与 `cycle` 闭环，统一跨门禁单源判据并将 `review-pack` 延迟压回 `<500ms`（JSON 消除三重冗余序列化）。
- 先解绑 `preflight-contract-rules.mjs` 多处复制强锁，再按「保留合理信息完整度、仅清理冲突与重复副本」整理八大技能文档并扩展 `cli-parity.mjs` 防回归，零硬压字节死线。

## 二、范围与非目标

### 本次要做（In Scope）

- 拆分为 4 片正交切片（Wave 1 并行 A/B/C 真零依赖，Wave 2 收尾 D）：
  - `docs/archive/specs/261124-r6a-single-source-state-spec.md`（单源默认分支、任务活性、运行时快照与跨平台四态 CAS 闭环；PR #162 已合入归档）
  - `docs/archive/specs/261124-r6b-plan-index-antiblue-spec.md`（唯一规划索引、指针简报协议、长聊 `preInit` 与客观防退化；PR #161 已合入归档）
  - `docs/archive/specs/261124-r6c-iterate-unified-gates-spec.md`（`dev-iterate` 确定性重构、跨门禁统一与 `review-pack` 提速去重；PR #163 已合入归档）
  - `docs/specs/261124-r6d-skills-contract-debloat-spec.md`（默认分支收口、`cli-parity` 扩面、冲突去重与全仓装配）

### 明确不做（Non-Goals）

- 不在规划期改动业务源码或删除 `.worktrees/.state/tasks/` 7 个遗留台账。
- 不设置任何魔数文档比率（如 `0.05`/`0.12`/`25`/`40`/`380`）、不硬压 `AGENTS.md` `12–15KB` 字节死线、不写死探索文件数阈值或简报固定行数上限。
- 不引入第三方 npm 依赖或新增第 9 个内置技能。

## 三、用户身份与权限

| 身份 | 能做什么 | 不能做什么 | 代码或配置中的载体 |
| --- | --- | --- | --- |
| 规划写手（`plan-r6-arch`） | 在 `.worktrees/impl-r6-arch-plan` 起草与审计 9 份规划文档 | 严禁运行 `critique-pass` / `approve` 或改业务源码 | Frontmatter `owner`、`kit/skills/lib/doc-approval.mjs` |
| 实施代理（Wave 1/2 `impl`） | 在各自隔离 worktree 修改本切片 `scope_files` 并提交 `verify` / `submit` | 严禁越界修改他片文件或执行 `flow.mjs merge` | SPEC `scope_files`、`flow-merge-claim.mjs` |
| 独立审查者 / 调度者 | 跑 `review-pack` 并记录 `verdict: pass`，通过后可执行 `flow.mjs merge`（A3） | 实施者自合；`contributor-fork` 本地自合；无 `--reason` 绕过停损 | `review-ledger.mjs`、`flow-merge.mjs` |

## 四、关键业务流程

1. **Wave 1 正交实施（真零依赖）**：切片 A、B、C 在各自隔离 worktree 并行施工，`r6b`/`r6c` 不改动 `isDefaultBranch` 调用点（统一留给 Wave 2 `r6d` 收口），各自通过 `fixtures.mjs`、`verify-injections.mjs` 与独立审查合入主干。
2. **Wave 2 契约收尾（`r6d`）**：先将剩余 4 处默认分支白名单收口至 `isDefaultBranch`，解绑 `preflight-contract-rules.mjs` 复制强锁，完成 CLI 对拍扩面与冲突清理，同步 `equip.mjs .` / `compose-agents.mjs .` / `docs/TDD.md` / `docs/feature-map.json` 并在最终 PR 归档本总控 PRD。

## 五、状态与业务规则

| 对象 | 状态 | 允许的迁移 | 迁移的触发条件 |
| --- | --- | --- | --- |
| 任务活性分类 | `active \| terminal-pending-cleanup \| terminal` | `active -> terminal-pending-cleanup -> terminal` | `merged` 或工作树缺失孤儿终态移出活跃集，仅提示待 `cleanup` |
| 认领租约与规划交棒 | `unclaimed -> leased -> taken-over -> released` | CAS 原子推送与 `--force-with-lease` 换手 | 基于标准 Git 引用 `refs/pf/claims/` 实现全平台防撞车 |
| 文档状态双向投影 | `draft -> approved -> implementing -> implemented` | Frontmatter 与正文表同步迁移 | `approveSpec` 联动 Todo `active`；`syncPlanDocBodyMeta` 同步正文表 |

## 六、复用既有模块

- `kit/skills/lib/git-core.mjs`、`kit/skills/lib/git.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/static-gates.mjs`
- `kit/skills/lib/context-brief.mjs`、`kit/skills/lib/session-state.mjs`、`kit/skills/lib/doc-frontmatter.mjs`、`kit/skills/lib/critique-store.mjs`
- `kit/skills/lib/escalation.mjs`、`kit/skills/lib/test-inventory.mjs`、`kit/skills/lib/verify-state.mjs`、`scripts/dev/cli-parity.mjs`

## 七、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 零第三方依赖 | `scripts/` 与 `kit/` 仅用 Node 18+ `node:*` 内置模块，严禁 `kit/skills/lib/` 反向导入技能入口 | `node scripts/dev/preflight.mjs` |
| 响应性能与去冗余 | `review-pack` 从 `6–12s` 压回 `<500ms`，JSON 全局只存 1 份 `contextBrief`，`critique-scope` 毫秒静态响应 | `node scripts/dev/bench.mjs` 与实测计时 |
| 全链沙盒验证 | `e2e-zip-harness.mjs`、`fixtures.mjs` 与 `verify-injections.mjs` 全绿 | `node scripts/dev/e2e-zip-harness.mjs` |

## 八、验收标准

- [x] C1: 改造唯一 `resolveDefaultBranch(repoRoot, { strict = true })`（无真实分支返回 `null`）与唯一 `isDefaultBranch`、`ledger.mjs` `baseBranch: null`、禁止 `flow-trial-merge.mjs` 与 `task-backend-local.mjs` 擅自 `update-ref` 建 `main`；下沉唯一 `detectCommitStyle`（有效非自动提交 `< 5` 不反转）至 `kit/skills/lib/git-core.mjs` 由 `scripts/lib/survey-git-fast.mjs` 与 `kit/skills/lib/git.mjs` 共用。
- [x] C2: 在 `ledger.mjs` 实现 `classifyTaskLiveness` 过滤 `'merged'` 与缺失工作树孤儿任务（本仓 7 个历史台账现场运行 `flow.mjs next --json` 零 `MULTIPLE_ACTIVE_TASKS` / `BLOCKED_NOT_CLAIMED`）；在 `flow-next.mjs` 与 `flow-cleanup.mjs` 共用 `collectTaskRuntimeSnapshot` 消灭 `status --all` 与 `status --task` 分裂。
- [x] C3: 移除 `flow-merge.mjs` 对 `GenericRemoteBackend.mergePr` 的提前短路以走真实远端 fetch + 四态核验；落实 A3 允许独立审查 `verdict: pass` 且 `reviewPassedHead === HEAD` 后由独立审查者或调度者执行 `flow.mjs merge`（仍禁实施者自合）；`flow start` 自动继承已过 `audit` 文档探索凭据。
- [x] C4: 修复 `plan-exit-gate.mjs` `'ledgerEntry' in doc` 假阳性、取消跨机缺失本机 `.git/issues` 死循环、修 `workflow-policy-next.mjs` Case 3 独立 Todo 硬编码 `--case 4` 与无活跃任务直转在途 `draft`/未拆完 PRD；实现 `<50` 行标准 Git 协议 `refs/pf/claims/` CAS 原子认领租约；修复 `flow-lifecycle.mjs` `awaiting-upstream-merge` 与移除 `--remote-merged`、`flow-cleanup.mjs` 远端核查、`flow-merge-claim.mjs` `--takeover` 归属回退。
- [x] C5: 新建唯一 `kit/skills/lib/plan-index.mjs` (new) 直接替换 `doc-slice-graph.mjs` (`collectPlanDocs`)、`plan-next.mjs` (`collectCandidateDocs`)、`doc-audit-repo.mjs` (`listDocs`)；`session-orient.mjs` 改用 `plan-index.mjs` 消除 `kit/skills/lib/` 静态导入 `doc-audit.mjs`；`doc-plan-ops.mjs` `initDoc` 与 `intake-triage.mjs` 全仓拦截同 `slug`/`issue` 重复建档（`BLOCKED_DUPLICATE_PLAN_DOC`）。
- [x] C6: `doc-plan-ops.mjs` `approveSpec` 批准 SPEC 原子联动配套 Todo 设为 `status: active`；在 `docs.mjs` 实现 `syncPlanDocBodyMeta` 并接入 `syncDocsLifecycle`、`archiveCompletedDocsGroup`、`approveSpec` 与 `flow-lifecycle-finalize.mjs`，消除 PRD/SPEC/Todo 正文表与 Frontmatter 失步；落实 A1 对齐 `doc-plan.mjs` Case 3 Todo 自检直通。
- [x] C7: 改造 `context-brief.mjs`（权威 TDD 置顶豁免淘汰、排除 `AGENTS.md`、去掉每 heading 重复 `locateCommand`）并补链 `plan-next --handoff`、`critique-scope` 与 `session-orient`；`repo-map --json` 移除 `featureMapIndex` 全量倾倒；`handoff-package.mjs` 按角色裁剪（`explore`/`critic` 不灌 SPEC 设计正文、Fork 纳入 `privateTodoFile`/`privateSpecFile`/`privatePrdFile`、JSON 仅存 1 份 `contextBrief`）；修复 `critique-scope` `findings` 与 `priorRounds` 回显，`verifyDocClaims` 在 `critique-scope` 默认仅静态校验（仅显式 `--run-commands` 时跑重命令）。
- [x] C8: 在 `session-state.mjs` 新增有界 `preInit` 缓冲与 `doc-plan.mjs note` 追加并在 `initDoc` 自动吸收清空（同时继承 `triage.planMode`、修 Case 4 `prdRequired` `--kind all` 与 `audit` 跳转 `critique-scope`）；`resolveBaselineSnapshotSync` 接通 `plan-critique-state.json`；去掉魔数比率，仅守永恒客观底线（`DOC_REGRESSION_CORE_*`、`DOC_REGRESSION_CRITERIA_DROPPED`、`verifyDocClaims` 实路径与 `critique-scope` 上轮 `findings` 追踪）。
- [x] C9: 修复 `iterate.mjs` 漏导 `printNextStep`、`extractSymbols` 参数与返回值、`slugTestToken` `\b`、`resolveNativeTestDir` 漏传 `files`；抽象单源 `resolveTestRunner` 覆盖 Python（`.venv` `pytest`/`pytest`/`uv`/`unittest`）、Java（`mvn`/`gradle`）、Node/TS（`.js`/`.ts` 下 `tap`/`vitest`/`jest`/`tsx`/`bun`/`node --test`）、Go、Rust 并区分 `missing-runner`，支持递归测试目录与 `configuredTestEntries`。
- [x] C10: `iterate.mjs` 与 `signals.mjs` 过滤非代码/已归档/已删除目标；`static-gates.mjs`、`test-inventory.mjs` 与 `govern-audit.mjs` / `govern-state.mjs` 识别 `configuredTestEntries` 与 `scripts/dev/fixtures-*.mjs` 消灭 `Test Files: 0`；`generate --write` 强制隔离拦截；落实 A2 默认 `--escalate: true`（支持 `--no-escalate` 关闭）与 `classifyEscalationTier`；修通 `iterate-cycle.mjs` 持久化累计轮次与停损建单。
- [x] C11: `review-gates.mjs` 与 `govern-checks.mjs` 共用 `static-gates.mjs` `countTextLines`、`resolveOversizedExemption` 与 `isLegalArchiveMove`；`edit-gate.mjs` 识别 `reviewWorktreePath` 与 `includeTerminal: true` 兄弟归档更新并对齐 brownfield 棘轮；保留 `check-empirical` 在 `--include-diff` 之前而仅将 `check-fault` 锁收敛至 `record --verdict pass`；`review-context.mjs`/`review-pack.mjs` JSON 仅存 1 份 `contextBrief`；`verify-state.mjs` `evaluateToolStaleness` 跳过 `!baseline` 并批量 `git diff --name-only` 预过滤将 `review-pack` 压回 `<500ms`；`verify-tools create` 对 `scratch/` 探针豁免零断言校验。
- [x] C12: 修复 `review-ledger.mjs` Round 3 首次停损 `--human-approved` 缺 `--reason` 校验、完整继承 `baseLedger.rebuts`、低风险单会话冲突与对齐 `generic-git` `awaiting-remote-mr` 指引。
- [x] C13: 在 Wave 2 将 `doc-plan-ops.mjs`、`edit-gate.mjs`、`review-context.mjs`、`govern-state.mjs` 剩余 4 处 `['main','master']` 统一收口至 `isDefaultBranch`；移除幽灵参数 `--target`，补全 `flow.mjs` `printHelp()` 与 `SKILL.md` 必传模板，扩展 `scripts/dev/cli-parity.mjs` 校验全部 `kit/skills/dev-*/SKILL.md` 与 `printNextStep`。
- [x] C14: 先解绑 `scripts/dev/preflight-contract-rules.mjs` 多文件全文复制强锁（权威源查完整判据，入口查标题指针与禁过时声明），再整理 `SKILL.md`、`AGENTS.md`、`templates/agents-project.md`、`references/*.md`、8 份 `kit/skills/dev-*/SKILL.md` 与 `docs/TDD.md` 清理重复副本与矛盾（不设硬压字节死线）。
- [x] C15: 在权威文档与技能指南完整落地 A1/A2/A3、统一 `Case 1` 原地微调与 `--planning` 自动隔离、前置 `single-session + --human-approved`、松绑外部调研配仓内路径硬回落门禁（`doc-locate`/`repo-map`/`verifyDocClaims`），以及按上下文污染与不确定性的弹性探索启发式（不按文件数写死、不给简报写死行数）。
- [x] C16: 同步更新 `docs/TDD.md` 与 `docs/feature-map.json`，运行 `scripts/equip.mjs .` 与 `scripts/compose-agents.mjs .`，通过 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs --jobs 6`、`verify-injections.mjs --jobs 4`、`e2e-zip-harness.mjs`、`review.mjs .`、`doc-plan.mjs audit .` 与 `govern-audit.mjs audit . --strict` 全绿，并在最终 PR 归档本总控 PRD。

## 九、待拍板问题

- 待确认：无

## 十、上线、灰度与运营方案

- **上线方式**：Wave 1 并行合入 A、B、C 三片；Wave 2 合入 D 后统一执行 `scripts/equip.mjs .`、`scripts/compose-agents.mjs .` 与全套门禁及外部压测仓回归。
- **数据与内容迁移**：本仓 7 个遗留台账在切片 A 验证完成后按标准流程清理；外部 `.pf-stress-r6` 复测通过后再清理。

## 十一、成功度量

| 度量 | 现状基线 | 目标 | 怎么采集 | 什么时候看 |
| --- | --- | --- | --- | --- |
| 默认分支、活性与 7 台账误报 | 25+ 处 `'main'`、7 台账报 `MULTIPLE_ACTIVE_TASKS` | 单源 `resolveDefaultBranch` + `classifyTaskLiveness`，0 误报 | `node .agents/skills/dev-flow/scripts/flow.mjs next --json` | Wave 1 切片 A 合入后 |
| `review-pack` 延迟与 JSON 冗余 | `6–12s`，`contextBrief` 序列化 3 遍 | `<500ms`，全局单份 `contextBrief` | `review-pack.mjs` 实测计时与输出字节对比 | Wave 1 切片 C 合入后 |
| `cli-parity` 与规则冲突清零 | `--target` 幽灵参数、5 处规则打架 | `cli-parity.mjs` 全覆盖 0 幽灵参数、0 规则冲突 | `node scripts/dev/cli-parity.mjs` 与 `preflight.mjs` | Wave 2 切片 D 合入后 |

## 十二、门型与回滚路径

- **门型判定**：one-way（涉及 `kit/skills/lib/`、`templates/`、`SKILL.md`、`AGENTS.md` 等高风险契约与跨模块协议变更）
- **回滚路径**：各切片经独立分支与 PR 合入；若出现回归，对已合入提交使用 `git revert <sha>` 回退，禁止强推或改写历史。

## 十三、依赖与前置条件

| 依赖 | 类型 | 就绪状态 | 没有它会怎样 |
| --- | --- | --- | --- |
| 用户 A1/A2/A3 及 3 份顶层深研裁决 | 决策依赖 | 已就绪 | 四片无法消除重复扫描、双轨分支 API 与规则强锁 |
| 本仓 7 个遗留台账现场 | 实证依赖 | 已就绪 | 缺少切片 A `classifyTaskLiveness` 真实仓 Red->Green 回归基线 |

## 十四、风险与缓解

| 风险 | 可能性 | 影响 | 缓解办法 |
| --- | --- | --- | --- |
| Wave 1 并行切片触碰同一共享文件 | 中 | 合并冲突与返工 | 严格按各切片 `scope_files` 物理隔离，剩余 4 处 `isDefaultBranch` 切换留至 Wave 2 `r6d` |
| 解绑 `preflight-contract-rules.mjs` 后误漏必需指针 | 中 | 入口失焦或 `gap-coverage` 失败 | 保留权威源完整判据校验与入口标题指针/禁过时声明校验，跑通 `preflight.mjs` 与 `gap-coverage.mjs` |

## 澄清与补充记录

- 已确认（2026-11-24 · user）：A1: 非平凡 Case 3 Todo 的 Critique 口径 -> A1 已拍板：非平凡 Case 3 Todo 统一为「自检直通，Critique 仅建议（不强制）」，由切片 B 对齐 `doc-plan.mjs`，切片 D 同步校准 `docs/TDD.md` 与 `kit/skills/dev-plan/SKILL.md`。
- 已确认（2026-11-24 · user）：A2: `dev-iterate run` 失败升级默认值 -> A2 已拍板：`dev-iterate run` 默认开启失败自动升级建单（`--escalate` 默认 `true`，支持 `--no-escalate` 关闭），由切片 C 实现并在切片 D 同步文档。
- 已确认（2026-11-24 · user）：A3: 独立审查通过后 `flow.mjs merge` 执行权 -> A3 已拍板：只读独立审查子代理通过 `review-pack record --verdict pass` 后，允许独立审查者或调度者执行 `flow.mjs merge`（强校验 `reviewPassed === true && headSha === reviewPassedHead`，仍严禁实施者自合），由切片 A 落盘门禁并在切片 D 同步文档。

> 确认需调整系统模块或对外契约时，以此 PRD 为依据补充 `docs/specs/` 后再进入实现；需求全部交付后随同关联 `SPEC`/`Todo` 成对归档至 `docs/archive/prd/`；`1:N` 总控 PRD 走四态闭环（子切片合入时仅追加关联进度，全部分支交付完成后统一归档总控 PRD）。
