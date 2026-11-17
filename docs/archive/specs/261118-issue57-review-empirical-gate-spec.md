---
kind: spec
title: 强制审查先跑实证与故障注入再允许 --include-diff
status: implemented
tier: L3
created: 2026-11-18
updated: 2026-11-18
issue: 57
pr: null
branch: feat/review-empirical-gate
owner: FiretrUCK666
approved: true
implemented: true
plan_critique: "passed (reviewer=critic-w1, round=1, sha=a443029b94c1, summary=C1-C4 与 review-empirical 域已对齐，脏残留优先于 slot 同步，I131-I133 及三模式门禁完备)"
related_prd: ../../prd/261117-v8-criteria-trust-prd.md
related_todo: ../todo/261118-issue57-review-empirical-gate-todo.md
high_risk_paths: [kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-review/SKILL.md, kit/skills/lib/handoff-package.mjs]
---

# 强制审查先跑实证与故障注入再允许 --include-diff — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（强化 `dev-review` 门禁顺序并改动 `kit/` 高风险脚本，未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / Issue / PR | `feat/review-empirical-gate` / #57 / 未关联 |
| 负责人 / 内审状态 | planner-57 / `pending` |
| 关联 PRD / Todo | `docs/prd/261117-v8-criteria-trust-prd.md` / `docs/archive/todo/261118-issue57-review-empirical-gate-todo.md` |

- **与总控 PRD 的关系**：挂载于 `docs/prd/261117-v8-criteria-trust-prd.md`（V8 收口增补单），承接 Issue #57 的独立验收标准 `C1..C4`，不修改既有 PRD 编号，也不重复改动 #52 已落地的令牌与 PR 基线机制。
- **变更一句话**：把 `review-pack.mjs` 中的「先读机械事实 -> 跑实证验证 -> 故障注入改坏并还原复绿 -> 再取 `--include-diff` 全文」从口头提示升级为跨 `--task`、`--pr`、`--local`/`--staged`/`--base` 全部生效的确定性状态机门禁，并堵死纯文本模式泄漏 240 行原始 diff 的旁路。

## 系统变更全景

```mermaid
flowchart LR
  Pack["1. 机械事实"] --> Emp["2. 实证命令"]
  Emp --> Fail["3a. 故障 fail"]
  Fail --> Rest["3b. 还原通过"]
  Rest --> Diff["4. 解锁 diff"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/dev-review/scripts/review-empirical.mjs` (new) | 新增 | 计算 `workspaceFingerprint`，在 `{gitCommonDir}/project-forge-flow/` 读写实证与故障注入回执，执行 `check-empirical` / `check-fault` 与 `evaluateIncludeDiffGate` 门禁 |
| `kit/skills/dev-review/scripts/review-pack.mjs` | 改造 | 注册 `check-empirical` / `check-fault` 子命令；脏残留校验先于 `syncTier2ReviewSlotIfNeeded`；输出 `empiricalGate` 状态并在 `--include-diff` 前硬门禁拦截（退出码 `3`） |
| `kit/skills/dev-review/scripts/review-gates.mjs` | 改造 | 修复 `formatPackText` 在未传 `--include-diff` 时泄露 240 行 diff 的旁路；在 `buildPackNextSteps` 与文本摘要输出 `empiricalGate` 可执行步骤 |
| `kit/skills/dev-review/SKILL.md` | 改造 | 精简增补 `check-empirical`、`check-fault --phase fail|restore` 与 `--include-diff` 前置阻断契约（严控字节预算） |
| `kit/skills/lib/handoff-package.mjs` | 改造 | 对齐「先跑再判」引导文案，指向确定性 `check-empirical` / `check-fault` 命令 |
| `scripts/dev/fixtures-review-empirical.mjs` (new) | 新增 | 覆盖 C1–C3 全部正反双向断言（前置阻断、旁路关闭、故障未改/死断言拒斥、Round 2+/变基/`--local` 指纹失效与放行） |
| `scripts/dev/fixtures.mjs` | 改造 | 在 `DOMAIN_REGISTRY` 注册 `review-empirical` 域指向 `fixtures-review-empirical.mjs` (new)（与 #55 分波次顺序合入；不修改已超 800 行的 `scripts/dev/fixtures-review.mjs`） |
| `scripts/dev/injections-data.mjs` | 改造 | 接续 #55 `I128..I130` 预留并追加 `I131..I133` 故障注入（放行 `--include-diff`、跳过故障突变检测、恢复 `formatPackText` 240 行明文泄露） |

## 一、背景与边界声明

- **要改什么**：为 `kit/skills/dev-review/scripts/review-pack.mjs` 增加实证与故障注入状态记录模块 `kit/skills/dev-review/scripts/review-empirical.mjs` (new)，封堵 `kit/skills/dev-review/scripts/review-gates.mjs` 纯文本 diff 旁路，同步更新 `kit/skills/dev-review/SKILL.md` 与 `kit/skills/lib/handoff-package.mjs`。
- **不改什么**：不修改 `kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs` 与 `scripts/dev/fixtures-review.mjs`（避免与同波装备修复冲突且严守 `<= 800` 行上限）；不禁用 `--include-diff` 的合法读取能力；不改六锁收敛与 `record` 令牌机制（#52）。
- **本期不做**：不新增任何跳过实证的开关（如 `--skip-empirical` / `--trust-me`）；不修改 `dev-plan` / `doc-audit.mjs`（归 #55/#56）。
- **复用既有模块**：复用 `kit/skills/dev-review/scripts/review-diff.mjs`（`EXIT`、`collectDiff`、`resolveReviewWorktree`、`computeDiffRange`、`syncTier2ReviewSlotIfNeeded`）、`kit/skills/lib/cli.mjs`（`parseStandardCli`、`flushAndExit`）、`kit/skills/lib/git.mjs`（`gitRun`、`resolveRepoRoots`）、`kit/skills/lib/profile.mjs`（`parseDevProfile`）及 `kit/skills/dev-review/scripts/review-gates.mjs`（`assessBehavioralGate`）。
- **架构基线关系**：遵循 `docs/TDD.md` `kit/` 单文件 `<= 800` 行与零第三方依赖约束；遵循 `AGENTS.md` 信任倒金字塔（确定性实证与故障注入优先于读 diff）与 `arch-rules` 单向依赖边界。
- **替代方案与否决理由**：否决「只加一个布尔标记 `--empirical-ok` 或只看实施者 `verifiedHead === HEAD`」——实施者的 `flow verify` 不能代替独立审查者跑命令与做故障注入，而纯布尔标志会让 AI 跳过实证直接放行。必须用真执行子命令 + 指纹绑定状态回执，做到无实测、无注入不解锁，有实测则稳定放行。

## 二、设计方案与契约变更

### 1. 复用现有 CLI 入口与目标解析

在 `kit/skills/dev-review/scripts/review-pack.mjs` 中扩展 `SUBCOMMANDS = ['pack', 'record', 'override', 'check-empirical', 'check-fault']`：

- 复用所有现有目标与作用域参数：`--task`、`--round`、`--pr`、`--external-pr`、`--local`、`--staged`、`--base`、`--dir`、`--worktree`、`--head`、`--json`、`--human-approved-exec`、`--visual-checked`。
- 新增参数：`--cmd`（可重复多次传多条验证命令）与 `--phase`（`fail | restore`，用于 `check-fault`）。
- **关键保护：脏故障残留校验与 `syncTier2ReviewSlotIfNeeded` 执行顺序**：
  - 执行 `check-empirical` 与 `check-fault` 时 **彻底跳过** `syncTier2ReviewSlotIfNeeded`（直接由 `resolveReviewWorktree` 定位目标审查槽），防止在 `check-fault --phase fail` 期间被 `--reset-review-slot` 清空故障或因 detached checkout 失败；
  - 执行 `pack`（含 `--include-diff`）时，**必须在调用 `syncTier2ReviewSlotIfNeeded`（`review-pack.mjs:243`）之前**先检查现有 Tier 2 审查工作位是否存在未还原的故障注入残留（回执记录 `faultInjectedAndFailed` 尚未对应 `faultRestoredClean`，或审查槽内存在排除共享依赖链接后的脏改动）：若存在脏故障残留（且非单纯不带 `--include-diff` 的显式 `--reset-review-slot` 清理动作），直接以退出码 `3` 阻断并返回 `BLOCKED_DIRTY_FAULT_RESIDUE`，避免底层 `syncDetachedWorktree`（`kit/skills/lib/git.mjs`）抛出泛化的退出码 `1` `BLOCKED_DIRTY_REVIEW_WORKTREE`，也阻止携带脏残留强行读取 `--include-diff`；
  - 仅在确认审查槽干净后，才调用 `syncTier2ReviewSlotIfNeeded` 将工作位推进到 `resolveReviewTargetSha`（Round 2+ 新提交推进 `headSha` 并自然使 Round 1 实证凭证失效），随后计算 `diff`、`workspaceFingerprint` 并在 `--include-diff` 分支执行 `evaluateIncludeDiffGate`（缺失或过期则退出码 `3` 返回 `BLOCKED_EMPIRICAL_FIRST`）。

### 2. 凭证落盘位置与指纹绑定（零工作区污染）

所有状态文件写入 `{gitCommonDir}/project-forge-flow/`（不入库、不污染 worktree），按模式分槽存储并绑定实时指纹：

1. `--task {id}`：`{gitCommonDir}/project-forge-flow/tasks/{safeTaskId}/review-empirical.json`，按 `round` + `headSha` + `diffScope` + `baselineFingerprint` 索引。
2. `--pr {M}`：`{gitCommonDir}/project-forge-flow/reviews/pr-{M}.json`，按 `headSha` + `untrustedScanClean` + `baselineFingerprint` 索引（外部 PR 执行任何 `--cmd` 前必须已通过 `--untrusted-scan` 无高危或持人类批准 `untrustedApproved` / `--human-approved-exec`，否则硬阻断 `BLOCKED_UNTRUSTED_HAZARD`）。
3. `--local` / `--staged` / `--base {ref}`：`{gitCommonDir}/project-forge-flow/reviews/workspace-{scopeKey}.json`，按 `workspaceFingerprint`（对 `headSha`、`diff.sha256`、`git status --porcelain` 排除挂载共享依赖后的综合 SHA-256）索引。

Round 2+、`flow sync` 变基（`range-diff` 改变 `commits`/`diffScope`/`headSha`）或 `--local` 继续编辑源码时，`headSha`、`round` 或 `workspaceFingerprint` 立即变化，旧轮次实证凭证自动失效。

### 3. 四步状态机与各阶段校验细则

1. **Step 1：机械事实检查（不带 `--include-diff` 运行 `review-pack.mjs`）**
   - 始终允许通过（保证 `fixtures-docs.mjs` 等既有机械包 `exit 0`）；记录 `mechanicalPackSeen: true` 与 `baselineFingerprint`。
   - 返回 `empiricalGate: { required, readyForDiff, mode, round, targetRoot, headSha, workspaceFingerprint, steps, missingSteps, unblockCommands }`。
   - 堵死 `review-gates.mjs` `formatPackText` 旁路：当 `includeFullDiff === false` 时，不再打印 `fullDiffText` 前 `240` 行（仅保留 `diff.hunkIndex` 摘要与文件统计），确保文本模式与 JSON 行为一致。
2. **Step 2：`check-empirical`（实证 / C* 验证）**
   - 在目标工作位检查前提：若 `--task`/`--pr` 存在残留脏修改（未还原的故障注入），拒绝并报 `BLOCKED_DIRTY_FAULT_RESIDUE`；若未先跑机械包，可基于当前基线生成或校验对应基线。
   - 待运行命令来源：优先取 reviewer 传入的 `--cmd` 列表；若省略 `--cmd`，则从 `AGENTS.md` Dev Profile 提取 `quick-test` / `smoke-verify` / `full-test` 中真实可执行命令（`none` 除外）。若既未传 `--cmd`、Dev Profile 又全为 `none` 且触及运行时代码，则阻断提示必须通过 `--cmd` 提供至少一条 C* 证伪命令；若为 `low` 级纯非可执行文档（`runtimeFilesTouched.length === 0` 且无测试命令），允许执行 `--cmd`（如 `doc-plan audit`）或记录 `low-risk-no-runtime-checks` 并标注实证确认。
   - 在目标工作位以独立子进程实际执行每条命令，**全部退出码必须为 `0`**，将命令摘要、输出摘要与耗时写入 `empiricalVerified`。
3. **Step 3：`check-fault`（故障注入与还原复绿，两阶段互证）**
   - 当 `behavioralGate.runtimeFilesTouched.length > 0 || behavioralGate.smokeRequired || (devProfile test cmds exist)` 时为**强制必需**；对于空 diff（`diff.files.length === 0`）或 `0` 运行时改动且无测试命令的 `low` 级纯文档修改，免除故障注入避免死锁。
   - `--phase fail --cmd "{cmd}"`：
     - 校验当前 `currentFingerprint !== baselineFingerprint`：若没有任何改动（工作区纹丝不动），退出码 `3` 拒绝并报 `BLOCKED_FAULT_NO_MUTATION`；
     - 在已注入故障的工作位运行 `{cmd}`：必须**退出码非 `0`**！若 `{cmd}` 在故障存在时依然返回 `0`（套话测试/无效断言），退出码 `3` 拒绝并报 `BLOCKED_FAULT_NOT_CAUGHT`；
     - 成功捕捉失败后写入 `faultInjectedAndFailed: { mutatedFingerprint, failedCmd, exitCode }`。
   - `--phase restore --cmd "{cmd}"`：
     - 校验 `currentFingerprint === baselineFingerprint`（对于 `--task`/`--pr` 同时校验移除挂载链接后 `git status --porcelain` 干净；对于 `--local` 只需恢复到注入前的基线指纹，**绝不执行破坏性的整库 git checkout 清理用户原有未提交修改**！）；若仍停留在故障态则报 `BLOCKED_DIRTY_FAULT_RESIDUE`；
     - 运行 `{cmd}` 确认复绿（`exit === 0`），写入 `faultRestoredClean: true`。
4. **Step 4：解锁 `--include-diff`**
   - 当传入 `--include-diff`（无论 `--json` 还是纯文本模式）且 diff 非空时，调用 `evaluateIncludeDiffGate(...)`：
     - 校验：`mechanicalPackSeen === true`（对应当前 `round`/`headSha`/`workspaceFingerprint`）、`empiricalVerified` 匹配当前指纹、若需故障注入则 `faultInjectedAndFailed && faultRestoredClean` 匹配当前指纹、工作区无故障脏残留；若 `behavioralGate.empiricalVisualCheckRequired === true`，要求 `behavioralGate.visualVerifiedOnHead === true`（或本轮带 `--visual-checked` 确认已实际打开渲染界面核验）。
     - 任意前提缺失或因新提交/改文件而过期时：以退出码 **`3`** 硬阻断，输出结构化载荷 `{ status: 'BLOCKED_EMPIRICAL_FIRST', code: 'BLOCKED_EMPIRICAL_FIRST', exitCode: 3, mode, round, headSha, workspaceFingerprint, missingSteps, nextSteps }`（绝不包含 `diffText` 也不打印 diff 行），stderr 同步提示具体下一步命令。
     - 全部条件满足时：按原有契约返回 `diffIncluded: true` 与完整 `diffText`（或纯文本完整补丁）。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 真执行命令 + 指纹绑定两阶段状态机 (`review-empirical.mjs` (new)) | `check-empirical` + `check-fault` (`fail`/`restore`) 落盘 `{gitCommonDir}/project-forge-flow/` | （已选）不依赖伪造标记、不误伤 `--local` 原有脏改动、多轮自动失效 | 若未来由统一评审守护进程托管沙箱运行态，可迁移存储层 |
| `--include-diff` 直接在后台自动跑全量 `merge-gate` | 每次带 `--include-diff` 自动重跑测试 | 无法验证审查者是否做了故障注入改坏再还原，且每次重看 diff 都阻塞数十秒 | 不考虑改回 |
| 仅靠实施者 `flow verify` 的 `verifiedHead` 放行 | `task.verifiedHead === headSha` 就允许 `--include-diff` | 实施者自测不等于独立审查实证，且无法覆盖 `--local`/`--pr` 与故障注入环节 | 不考虑改回 |

## 四、改动清单与影响面

> 与 #55 完全写域正交；`scripts/dev/fixtures.mjs` 与 `scripts/dev/injections-data.mjs` 在实施合入波次按顺序叠加。

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/dev-review/scripts/review-empirical.mjs` (new) | 新增 | 实现 `computeWorkspaceFingerprint`、回执读写、`runEmpiricalVerification`、`runFaultVerification` 与 `evaluateIncludeDiffGate` | `review-pack.mjs`、`review-gates.mjs` |
| `kit/skills/dev-review/scripts/review-pack.mjs` | 修改 | 接入 `check-empirical` / `check-fault`、脏残留先于 `syncTier2ReviewSlotIfNeeded`、在输出 diff 前执行前置门禁阻断 | 所有 `review-pack.mjs` 调用方 |
| `kit/skills/dev-review/scripts/review-gates.mjs` | 修改 | 封堵 `formatPackText` 未带 `--include-diff` 时的 240 行 diff 泄露，补充 `empiricalGate` 指引 | 纯文本与 JSON 审查包消费者 |
| `kit/skills/dev-review/SKILL.md` | 修改 | 更新双模式入口命令、`check-empirical`/`check-fault` 与前置门禁说明（控制在预算内） | `dev-review` 技能调用上下文 |
| `kit/skills/lib/handoff-package.mjs` | 修改 | 更新「先跑，再判」四步命令引用与前置实证约束文案 | `flow next --handoff` 输出 |
| `scripts/dev/fixtures-review-empirical.mjs` (new) | 新增 | 覆盖 C1–C3 全部正反双向夹具断言 | `scripts/dev/fixtures.mjs` |
| `scripts/dev/fixtures.mjs` | 修改 | 引入 `fixtures-review-empirical.mjs` (new) 并在 `DOMAIN_REGISTRY` 注册 `review-empirical`（与 #55 顺序合并；不修改已 858 行的 `scripts/dev/fixtures-review.mjs`） | 全量 `fixtures.mjs` 套件 |
| `scripts/dev/injections-data.mjs` | 修改 | 接续 #55 预留 `I128..I130` 之后追加 `I131..I133` 故障注入（`I131` 撤防 `evaluateIncludeDiffGate`、`I132` 撤防 `BLOCKED_FAULT_NO_MUTATION`、`I133` 放回 `formatPackText` 明文 diff） | `scripts/dev/verify-injections.mjs` |

- **对外可见的变化**：`review-pack.mjs` 新增 `check-empirical`、`check-fault` 子命令及 `--cmd`、`--phase` 参数；未跑实证直接带 `--include-diff` 改为返回退出码 `3` 与 `BLOCKED_EMPIRICAL_FIRST`；未带 `--include-diff` 的纯文本模式不再泄露 240 行 diff。
- **需要同步改的地方**：在代码波次后执行 node scripts/equip.mjs . 同步 `.agents/skills/`，并通过 `node scripts/equip.mjs . --check` 验绿；同步核对 `README.md` / `README.en.md` 命令摘要与 `docs/TDD.md`（若新增文件需登记）。

## 五、冻结的验收标准

> 动手改代码前冻结；实现期间不顺手删减或放宽标准。每条必须能由一条命令或断言实证。

- [x] C1: （全模式前置阻断与纯文本旁路封堵）在 `--task`、`--pr`、`--local`/`--staged`/`--base` 模式下，在当前 `round` + `headSha` + `workspaceFingerprint` 尚未完成所需实证与故障注入闭环前，运行 `review-pack.mjs` 并带 `--include-diff`（无论是否带 `--json`）必须以退出码 `3` 阻断并输出 `BLOCKED_EMPIRICAL_FIRST`（JSON 中无 `diffText`，文本中无原始 diff 行，并列出 `missingSteps` 与可执行解封命令）；不带 `--include-diff` 的纯文本输出仅含 `diff.hunkIndex`/统计摘要，不打印 `formatPackText` 240 行原始补丁，且既有非 `--include-diff` 机械包（如 `fixtures-docs.mjs`、`fixtures-flow.mjs`、`fixtures-govern.mjs`）继续全部通过。
- [x] C2: （非空实证与两阶段故障注入解锁）执行「机械包 -> `check-empirical`（实跑命令退出 `0`）-> 修改故障并跑 `check-fault --phase fail --cmd ...` -> 还原并跑 `check-fault --phase restore --cmd ...`」完整链路后，`review-pack.mjs` 带 `--include-diff` 放行并返回退出码 `0`（`diffIncluded: true` 与完整 `diffText`）；**反向拦截**：`check-fault --phase fail` 在工作区未改动时必须报 `BLOCKED_FAULT_NO_MUTATION`（退出码 `3`），在故障下命令仍退出 `0` 时必须报 `BLOCKED_FAULT_NOT_CAUGHT`（退出码 `3`），未还原时 `--phase restore` 或 `--task` 带 `--include-diff` 必须报 `BLOCKED_DIRTY_FAULT_RESIDUE`（退出码 `3`）。
- [x] C3: （多轮失效、Slot 保护与纯文档/外部 PR 兼容）`check-empirical` 与 `check-fault` 不触发 `syncTier2ReviewSlotIfNeeded` 重置，不会洗掉 `--phase fail` 已注入故障，也不会破坏 `--local` 模式原有的未提交改动（仅比对还原回 `baselineFingerprint`）；Round 2+ 新提交、`flow sync` `range-diff` 变基或 `--local` 继续改文件后，旧实证凭证立即失效并重新阻断 `--include-diff`；空 diff 或 `0` 运行时文件且无测试命令的 `low` 级纯文档改动不被故障注入死锁；外部 `--pr` 在 `check-empirical` / `check-fault` 前未过 `--untrusted-scan`（或未批准高危项）时继续返回退出码 `3`（`BLOCKED_UNTRUSTED_HAZARD`）。
- [x] C4: （双向夹具、故障注入与全量门禁）`node scripts/dev/fixtures.mjs` 全量通过（支持 `--domain review-empirical` 单独跑 `scripts/dev/fixtures-review-empirical.mjs` (new) 覆盖 `--task`/`--pr`/`--local` 的双向断言）；`node scripts/dev/verify-injections.mjs` 验证预留故障注入 `I131..I133`（`I131` 关闭前置阻断、`I132` 跳过无突变检测、`I133` 恢复纯文本明文 diff 泄露）全部变红失败；`kit/skills/dev-review/scripts/*.mjs` 均不超过 `800` 行；`node scripts/equip.mjs . --check` 与 `merge-gate` 全绿。

## 六、高风险点、门型与回滚路径

- **门型判定**：`one-way`（直接强化独立审查门禁并涉及 `kit/` 高风险路径，必须经过独立审查 + 故障注入实证）。
- **高风险路径**：`kit/skills/dev-review/scripts/review-empirical.mjs` (new)、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/SKILL.md`、`kit/skills/lib/handoff-package.mjs`。
- **回滚路径**：各模块改动均局限在隔离分支内，且 `{gitCommonDir}/project-forge-flow/reviews/` 与 `review-empirical.json` 为纯运行态缓存文件；若需回退，只需执行 git revert 对应提交即可立即恢复 `review-pack.mjs` 与 `formatPackText`，不破坏既有任务账本或 Git 历史。
- **故障注入预演**：在 `scripts/dev/injections-data.mjs` 末尾接续 #55 `I128..I130` 之后预留追加 `I131..I133`：① `I131` 让 `evaluateIncludeDiffGate`（`review-empirical.mjs` (new)）直接返回允许放行 -> 验证未跑实证 `--include-diff` 拦截测试变红；② `I132` 让 `check-fault --phase fail` 跳过 `currentFingerprint !== baselineFingerprint` 校验 -> 验证空改动伪注入测试变红；③ `I133` 在 `review-gates.mjs` 恢复 `formatPackText` 在 `!includeFullDiff` 时打印 `240` 行原始 diff -> 验证纯文本防泄露测试变红。

## 七、待拍板问题

无

## 实现说明

- 将实证状态机按职责拆分为 `kit/skills/dev-review/scripts/review-empirical-state.mjs`（452 行：工作区指纹 `computeWorkspaceFingerprint`、排除挂载共享依赖链接与主仓 `.worktrees` 的 `getEffectiveStatusEntries`、`{gitCommonDir}/project-forge-flow/` 分槽回执存取、slot 同步前置 `checkDirtyFaultResidueBeforeSync`、外部 PR 预执行拦截 `checkUntrustedBeforeExec`）与 `kit/skills/dev-review/scripts/review-empirical.mjs`（695 行：`computeEmpiricalRequirements`、`evaluateIncludeDiffGate`、`handleCheckEmpirical`、`handleCheckFault`）。
- 改造 `kit/skills/dev-review/scripts/review-pack.mjs`（690 行）：扩展 `check-empirical` / `check-fault` 子命令与 `--cmd` / `--phase` 参数；执行 `check-empirical` / `check-fault` 时跳过 `syncTier2ReviewSlotIfNeeded` 保护故障注入与 `--local` 原有未提交修改；执行 `pack` 时先跑 `checkDirtyFaultResidueBeforeSync` 防止脏故障残留触发退化报错，并在 `--include-diff` 输出前强校验 `evaluateIncludeDiffGate`（未闭环以退出码 `3` 输出 `BLOCKED_EMPIRICAL_FIRST` 或 `BLOCKED_DIRTY_FAULT_RESIDUE`）。
- 改造 `kit/skills/dev-review/scripts/review-gates.mjs`（644 行）：封堵 `formatPackText` 在 `!includeFullDiff` 时输出 240 行原始 diff 补丁的旁路，仅展示 `hunkIndex`/文件统计与 `--- Empirical-First Gate ---` 解封步骤；同步更新 `kit/skills/dev-review/SKILL.md`（108 行）、`kit/skills/lib/handoff-package.mjs`、`docs/TDD.md` 并执行 `node scripts/equip.mjs .` 同步 `.agents/skills/`。
- 验证结果：`fixtures.mjs --domain review-empirical` 4/4 通过、全量 `fixtures.mjs` 229/229 通过；`verify-injections.mjs` 全量 139/139（含 `I131..I133`）全部精准变红；`preflight.mjs`（33 项）、`gap-coverage.mjs`（19 项）、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`（`mature`）、`sync-toc.mjs --check` 与 `govern-audit.mjs audit . --changed --strict`（`critical=0, high=0`）全绿。
