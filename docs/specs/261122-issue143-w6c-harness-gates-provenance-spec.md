---
kind: spec
title: Slice 6C：跨仓隔离、并发实证豁免与角色溯源防绕过
status: draft
tier: L3
created: 2026-11-22
updated: 2026-11-22
issue: 143
pr: null
branch: docs/w6-universal-architecture-plan
owner: plan-w6
plan_mode: interactive
approved: false
implemented: false
plan_critique: pending
related_prd: ../prd/261122-issue143-w6-universal-architecture-prd.md
related_todo: ../todo/261122-issue143-w6c-harness-gates-provenance-todo.md
task_id: w6c-harness-gates-provenance
depends_on:
  - w6a-survey-handoff-core
  - w6b-kit-single-source-hygiene
scope_files:
  - kit/skills/dev-flow/scripts/flow.mjs
  - kit/skills/dev-flow/scripts/flow-issues.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs
  - kit/skills/dev-flow/scripts/flow-start-helpers.mjs
  - kit/skills/dev-flow/scripts/worktree-deps.mjs
  - kit/skills/dev-review/scripts/review-pack.mjs
  - kit/skills/dev-review/scripts/review-empirical.mjs
  - kit/skills/dev-review/scripts/review-locks.mjs
  - kit/skills/lib/cli.mjs
  - kit/skills/lib/workflow-policy.mjs
  - kit/skills/lib/workflow-policy-next.mjs
  - kit/skills/lib/escalation.mjs
  - kit/skills/lib/issue-template-hydrate.mjs
  - kit/skills/lib/pr-template-hydrate.mjs
  - kit/skills/lib/handoff-package.mjs
  - .agents/skills/dev-flow/scripts/flow.mjs
  - .agents/skills/dev-flow/scripts/flow-issues.mjs
  - .agents/skills/dev-flow/scripts/flow-lifecycle.mjs
  - .agents/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs
  - .agents/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs
  - .agents/skills/dev-flow/scripts/flow-start-helpers.mjs
  - .agents/skills/dev-flow/scripts/worktree-deps.mjs
  - .agents/skills/dev-review/scripts/review-pack.mjs
  - .agents/skills/dev-review/scripts/review-empirical.mjs
  - .agents/skills/dev-review/scripts/review-locks.mjs
  - .agents/skills/lib/cli.mjs
  - .agents/skills/lib/workflow-policy.mjs
  - .agents/skills/lib/workflow-policy-next.mjs
  - .agents/skills/lib/escalation.mjs
  - .agents/skills/lib/issue-template-hydrate.mjs
  - .agents/skills/lib/pr-template-hydrate.mjs
  - .agents/skills/lib/handoff-package.mjs
  - docs/feature-map.json
  - scripts/dev/fixtures-w6c-harness-gates.mjs
  - scripts/dev/injections-data-w6c.mjs
high_risk_paths:
  - kit/
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
| `kit/skills/lib/cli.mjs` & `kit/skills/dev-flow/scripts/flow.mjs` & `kit/skills/dev-flow/scripts/flow-issues.mjs` | 改造 | 跨仓 CWD 错位 fail-closed 拦截 `BLOCKED_CROSS_REPO_CWD_MISMATCH`，接入 6B 单源 `SUBCOMMAND_META` |
| `kit/skills/lib/issue-template-hydrate.mjs` & `kit/skills/lib/pr-template-hydrate.mjs` | 改造 | 兼容 `**Bold**` 提示模板且零 section 命中时完整保留 `--body` |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` & `flow-lifecycle-helpers.mjs` & `flow-lifecycle-finalize.mjs`(new) | 改造/拆分 | 拆分 `finalize` 逻辑控制 `<= 800` 行，归档时同步 SPEC 正文状态表与 YAML `status: implemented` |
| `kit/skills/dev-review/scripts/review-empirical.mjs` & `review-pack.mjs` & `kit/skills/lib/escalation.mjs` | 改造 | `low` 风险纯文档豁免强制 runtime/fault/`--include-diff` 阻塞；`escalation` 按错误签名去重 |
| `kit/skills/lib/workflow-policy.mjs` & `kit/skills/lib/workflow-policy-next.mjs` | 改造 | 放行 `--maxWorkers`/`--workers`/`--bail`/`--config.verify-deps-before-run=false`；多语言单栈作用域验证识别 |
| `kit/skills/dev-flow/scripts/worktree-deps.mjs` & `docs/feature-map.json` | 改造 | 修复独立 `mount` 更新 `mountedDepsByWorktree`、透传 `pnpm` junction 环境变量与 Vite `fs.allow` 引导；修 `verify-edit-gate` 兼容 |
| `kit/skills/dev-flow/scripts/flow-start-helpers.mjs` & `kit/skills/dev-review/scripts/review-locks.mjs` & `kit/skills/lib/handoff-package.mjs` | 改造 | 强化规划/实施/审查真实角色溯源防伪传 `--owner` 绕过与 `Case >= 2` 派发隔离核查 |

## 一、背景与边界声明

- **要改什么**：改造 `kit/skills/dev-flow/`、`kit/skills/dev-review/`、`kit/skills/lib/{cli,workflow-policy*,escalation,issue-template-hydrate,pr-template-hydrate,handoff-package}.mjs` 与 `docs/feature-map.json`（同步 `.agents/skills/`）。
- **不改什么**：不碰 `scripts/`（除 `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) 与 `injections-data-w6c.mjs`(new)）、`templates/`、`kit/skills/dev-govern/`、`kit/skills/dev-plan/`、`kit/skills/dev-edit/`、`kit/skills/dev-explore/` 等 6A/6B 文件。
- **本期不做**：不改动 S1 勘察逻辑与 `SUBCOMMAND_META` 定义本身（直接消费 6B 落盘的 `kit/skills/lib/subcommand-meta.mjs`(new)）。
- **复用既有模块**：复用 `kit/skills/lib/subcommand-meta.mjs`(new)（6B 落盘）、`kit/skills/lib/doc-approval.mjs`（`collectOwnerHistory`）、`kit/skills/lib/harness-context.mjs`（`checkAuthorIsNotImplementer`）、`kit/skills/lib/profile-sniffer.mjs`（6A 拆分的子包探测）。
- **架构基线关系**：保持 `kit/` 零第三方依赖与 `<= 800` 行红线（`flow-lifecycle.mjs` 现为 799 行，必须拆出 `flow-lifecycle-finalize.mjs`(new)），并执行 `node scripts/equip.mjs .` 保持 `.agents/skills/` 一致（依据：`docs/TDD.md`）。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **跨仓工作目录不匹配拦截（`kit/skills/lib/cli.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs`）**：
   - 在 `cli.mjs` 导出并集成 `validateCrossRepoTarget({ cwd, targetDir, argv, explicitDir, scriptPath, urlRepo })`：
     - 当命令未显式传入 `--dir` / `--repo` 时，若脚本所在仓库根（从 `import.meta.url` 追溯含 `.agents/skills` 的宿主仓根）或显式传入的 Issue/PR URL 所属 `owner/repo` 与 `process.cwd()` 解析出的 Git 仓根（`mainRoot` / remote `owner/repo`）不一致，**立即 fail-closed 拦截**，抛出结构化错误码 `BLOCKED_CROSS_REPO_CWD_MISMATCH`（退出码 `EXIT.FACT` = 3），提示显式传入 `--dir <targetRepo>` 或切入目标仓执行；
     - 在 `flow.mjs`（特别覆盖 `issue`、`intake`、`start`、`submit`、`merge`、`close`、`milestone` 等含远端读写路径）与 `flow-issues.mjs` 统一执行该校验；仅当显式传 `--dir` 时允许跨目录精准定位目标仓。
   - 同步让 `flow.mjs` 与 `review-pack.mjs` 从 `kit/skills/lib/subcommand-meta.mjs`(new) 导入 `subcommandNamesFor('flow')` / `subcommandNamesFor('review-pack')`，并补齐 `flow.mjs` 文件头 `子命令：` 注释全量对齐。

2. **`**Bold**` 提示模板水合与 `finalize` SPEC 正文状态同步（`issue-template-hydrate.mjs`、`pr-template-hydrate.mjs`、`flow-lifecycle.mjs`、`flow-lifecycle-finalize.mjs`(new)）**：
   - `issue-template-hydrate.mjs` 与 `pr-template-hydrate.mjs`：
     - 除识别 `## Heading` 二级标题分段外，支持识别 `**Bold**` 提示行/段落型模板（如 `**Describe the bug**`、`**背景与现象**`、`### ...` 等）；
     - 当传入用户 `--body`（或 `rawBody`）且模板与正文的 section 匹配数为 **0** 时，绝不丢弃用户原文，改为在干净剥离模板注释占位后将用户 `--body` 完整追加/嵌入正文保留。
   - 从 `flow-lifecycle.mjs`（799 行）拆出 `finalize` 核心逻辑至 `kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`(new)：
     - 归档 `SPEC` 时在更新 YAML `status: implemented` 与 `implemented: true` 的同时，同步更新正文 `## 文档信息与变更概览` 表格中的 `当前状态` 单元格（替换为 `` `implemented` ``）及 `更新` 日期与关联归档路径，消除正文状态表与 YAML 脱节。

3. **`low` 风险纯文档豁免与错误签名建单去重（`review-empirical.mjs`、`review-pack.mjs`、`escalation.mjs`）**：
   - `review-empirical.mjs` & `review-pack.mjs`：当 `computeEmpiricalRequirements` 判定 `isLowRiskPureDoc === true`（`policy.riskTier === 'low'` 且无 `high-risk` / `one-way` / 门禁弱化 / UI 视觉文件）时：
     - `empiricalRequired = false`、`faultRequired = false`、`businessFlowEmpiricalRequired = false`；
     - `evaluateIncludeDiffGate` 自动放行 `--include-diff`（无需先跑 runtime `check-empirical` 与 `check-fault`），仍保留机械包校验与纯文档静态检查（死链 / Mermaid 16/12 / 秘密字面量）。
   - `escalation.mjs`：在 `escalateToBackend` 建单前计算规范化错误签名指纹 `computeEscalationFingerprint(item)`（基于 `category + pattern/code + normalizedTargetFile + normalizedSummary`），先检索当前后端（GitHub open/closed 近期工单或 `local-issues`）是否已存在同签名活跃/近期工单；命中则追加进展评论或复用现有工单号（返回 `deduplicated: true`），绝不重复建单。

4. **并发命令等价与多语言单栈作用域验证（`workflow-policy.mjs`、`workflow-policy-next.mjs`）**：
   - `workflow-policy-next.mjs` 的 `normalizeConcurrentVerifyCommand(cmd)` 扩展剥离 `--maxWorkers[= ]\S+`、`--workers[= ]\S+`、`--bail`、`--config.verify-deps-before-run=false`（以及 `--jobs` / `-j`），使 `isEquivalentConcurrentCommand` 在并发或 pnpm 跳过重校验参数下正常匹配配置命令。
   - `workflow-policy.mjs` 新增多语言仓单栈局部变更验证作用域分析函数 `resolveScopedVerificationGate({ repoRoot, changedFiles, packages, profile })`：当变更文件全部落在单一语言栈/子包内且其他栈无文件变更时，记录受波及子包与栈集合（`affectedStacks` / `affectedPackages`），在实证与门禁判定时允许仅针对受波及栈/子包命令完成闭环，未改动栈若本机缺失该语言运行时不误阻塞（如只改 TS 前端包时不因本地缺 Go 环境阻塞）。

5. **Worktree 依赖 `pnpm` 兼容与 `verify-edit-gate` 游离槽修复（`worktree-deps.mjs`、`docs/feature-map.json`）**：
   - `worktree-deps.mjs`：
     - 修复独立 CLI 执行 `worktree-deps.mjs mount` 时同步回写任务账本中的 `mountedDepsByWorktree[wtRel]`，与 `flow start` 保持一致；
     - 检测到 `pnpm` junction 挂载时，在输出环境提示及导出的工作树运行环境中注入 `npm_config_verify_deps_before_run=false`，并在检测到 Vite 配置时输出 `server.fs.allow` 放行共享 `node_modules` 真实路径的可操作引导（写入 JSON `hints` 与标准输出）。
   - `docs/feature-map.json` 中的 `verify-edit-gate`：将命令升级为兼容游离 HEAD 审查槽的写法（如传入 `--mode verify` 或由 `edit-gate.mjs` 在游离 `review-*` 槽自动与基线对比；若用 `--base` 或适配 `dev-edit` 游离槽参数，确保在 `review-*` detached worktree 下执行不误拦已合法归档文件）。

6. **强化规划/实施/审查真实角色溯源校验（`flow-start-helpers.mjs`、`flow-lifecycle.mjs`、`review-locks.mjs`、`handoff-package.mjs`）**：
   - **防伪传 `--owner` 绕过 `BLOCKED_AUTHOR_IS_IMPLEMENTER`**：
     - 在 `flow-start-helpers.mjs`、`flow-lifecycle.mjs`（`claim` / `submit`）与 `review-locks.mjs` 联合校验规划文档（SPEC/Todo/PRD）的完整溯源证据：不仅读取 Frontmatter `owner` 与 `previous_owners`，还检查 Git 提交历史中首次引入/最近修改该 Todo/SPEC 文件的提交作者与签名，以及 `planCritique` 账本记录的初始作者；若同会话未走 `doc-plan link --owner --owner-reason` 留痕而直接改写 Todo `owner:` 字段，或当前实施者/提交作者与规划历史作者一致，拒绝放行并报 `BLOCKED_AUTHOR_IS_IMPLEMENTER`（或 `BLOCKED_PROVENANCE_TAMPERED`）。
   - **强化 `Case >= 2` 派发隔离实施子代理核查与 handoff 约束**：
     - 在 `flow-start-helpers.mjs`、`flow-lifecycle.mjs` 与 `handoff-package.mjs` 中：当 `Case >= 2` 且 `hostMode === 'multi-agent'` 时，强制核对 `claim` / `submit` 的 `--agent` 非协调者/非规划者/非审查者且不可缺省，并在 `handoff-package.mjs` 的 `coordinator` / `implementer` / `reviewer` 交接包中固化角色隔离断言与溯源校验说明。

### 数据与状态变更

- 任务账本新增/规范化记录：`mountedDepsByWorktree` 在独立 `worktree-deps.mjs mount` 后实时更新；规划溯源基线字段（`planningProvenance`: `{ docSha, docAuthors, commitAuthors }`）在 `start` / `claim` 时落盘比对。
- `escalation.mjs` 持久化或检索工单时附带可机器匹配的签名指纹标记（如 `pf-sig:<hash12>`）。

### 异常、回退与安全边界

- `validateCrossRepoTarget` 仅在隐式 `cwd` 与脚本/目标仓库发生跨仓错位时阻断；显式传入 `--dir <targetRepo>` 指向合法仓库时正常放行。
- `low` 风险纯文档豁免仅限于 `riskTier === 'low'`，任何代码/配置/工作流/视觉文件/high-risk 命中均自动回落 `medium` / `high` 严格模式，不可降级。
- `escalation.mjs` 去重命中已关闭（`CLOSED`）且距今久远的历史工单时，仅去重 `OPEN` 状态或相同活跃周期指纹，避免已关闭旧单阻止真实回归重新立单。

### 实现顺序

1. 改造 `kit/skills/lib/cli.mjs`（跨仓 CWD 错位拦截）、`kit/skills/dev-flow/scripts/flow.mjs`（接入 `SUBCOMMAND_META` + CWD 校验 + 头注释补齐）、`kit/skills/dev-flow/scripts/flow-issues.mjs`。
2. 改造 `kit/skills/lib/issue-template-hydrate.mjs` & `kit/skills/lib/pr-template-hydrate.mjs`；拆分 `kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`(new) 并实现 SPEC 正文状态表同步。
3. 改造 `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-pack.mjs`（`SUBCOMMAND_META` + `low` 文档豁免）、`kit/skills/lib/escalation.mjs`（错误签名去重）。
4. 改造 `kit/skills/lib/workflow-policy.mjs`、`workflow-policy-next.mjs`（并发 flags 等价 + 多语言单栈作用域识别）、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`docs/feature-map.json`。
5. 加固 `flow-start-helpers.mjs`、`flow-lifecycle.mjs`、`review-locks.mjs`、`handoff-package.mjs` 角色溯源与隔离核查；运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`；编写 `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) 与 `scripts/dev/injections-data-w6c.mjs`(new) 并全量跑通门禁。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 仅在 `cli.mjs` 提示警告不阻断跨仓运行 | 打印 stderr 警告后仍继续向当前 CWD 建单 | 用户或自动化脚本忽略警告后仍会污染错误仓库远端 | 必须 fail-closed 阻断 |
| 在 `escalation.mjs` 用完整标题字符串精确匹配去重 | 标题完全相等才跳过建单 | 错误堆栈行号/时间戳轻微变化即失效，依然重复建单 | 必须按结构化签名指纹去重 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/cli.mjs` & `flow.mjs` & `flow-issues.mjs` | 修改 | 跨仓 CWD 错位拦截 `BLOCKED_CROSS_REPO_CWD_MISMATCH`、`flow.mjs` 接入 `SUBCOMMAND_META` | 所有 CLI 入口与 Issue 操作 |
| `kit/skills/lib/issue-template-hydrate.mjs` & `pr-template-hydrate.mjs` | 修改 | 兼容 `**Bold**` 提示模板且零命中保留 `--body` | Issue / PR 创建与提交 |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` & `flow-lifecycle-helpers.mjs` & `flow-lifecycle-finalize.mjs`(new) | 修改/新增 | 拆分 `finalize` 控制 `<=800` 行，同步归档 SPEC 正文状态表与 YAML | `flow finalize` 与归档闭环 |
| `kit/skills/dev-review/scripts/review-empirical.mjs` & `review-pack.mjs` & `kit/skills/lib/escalation.mjs` | 修改 | `low` 风险纯文档豁免 runtime/fault、`review-pack` 接入 `SUBCOMMAND_META`、`escalation` 签名去重 | 审查包构建与缺陷升级 |
| `kit/skills/lib/workflow-policy.mjs` & `workflow-policy-next.mjs` & `worktree-deps.mjs` & `docs/feature-map.json` | 修改 | 扩展并发标志等价、多语言单栈验证、`pnpm` junction / `fs.allow` 与 `mountedDepsByWorktree` 修复、`verify-edit-gate` 兼容 | 并行工作树验证与功能地图 |
| `flow-start-helpers.mjs` & `review-locks.mjs` & `handoff-package.mjs` & `.agents/skills/**` & `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) & `scripts/dev/injections-data-w6c.mjs`(new) | 修改/新增 | 真实角色溯源防绕过、同步 `.agents/skills/`、正反双向夹具与故障注入 | 规划-实施-审查角色隔离与门禁 |

- **对外可见的变化**：跨仓未传 `--dir` 错位调用明确报错 `BLOCKED_CROSS_REPO_CWD_MISMATCH`；`low` 风险纯文档免跑重型 runtime 与故障注入；归档 SPEC 正文状态表与 YAML 自动对齐；同会话改 Todo 伪传 `--owner` 被阻断。
- **需要同步改的地方**：必须运行 `node scripts/equip.mjs .` 保持 `.agents/skills/` 字节一致。

## 五、冻结的验收标准

- [ ] C13: `kit/skills/lib/cli.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `kit/skills/dev-flow/scripts/flow-issues.mjs` 实现跨仓工作目录不匹配 fail-closed 拦截（`BLOCKED_CROSS_REPO_CWD_MISMATCH`）；`flow.mjs` 与 `review-pack.mjs` 接入 `SUBCOMMAND_META` 单源并对齐文件头。
- [ ] C14: `kit/skills/lib/issue-template-hydrate.mjs` 与 `kit/skills/lib/pr-template-hydrate.mjs` 兼容 `**Bold**` 提示模板且零 section 命中时完整保留 `--body`；`flow.mjs finalize` 同步归档 `SPEC` 正文状态表与 YAML `status: implemented`。
- [ ] C15: `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-pack.mjs` 与 `kit/skills/lib/escalation.mjs` 对 `low` 风险纯文档变更豁免强制 runtime `check-empirical` / `faultRequired` / `--include-diff` 阻塞，且 `escalation.mjs` 按错误签名去重不重复建单。
- [ ] C16: `kit/skills/lib/workflow-policy.mjs` 与 `kit/skills/lib/workflow-policy-next.mjs` 扩展 `isEquivalentConcurrentCommand` 识别 `--maxWorkers` / `--workers` / `--bail` / `--config.verify-deps-before-run=false`；为多语言仓单栈局部变更提供子包/单栈作用域验证识别（未改栈缺失环境不误阻塞）。
- [ ] C17: `kit/skills/dev-flow/scripts/worktree-deps.mjs` 与 `docs/feature-map.json` 修复独立 `mount` 更新 `mountedDepsByWorktree`、为 `pnpm` junction 透传 `npm_config_verify_deps_before_run=false` 并给出 Vite `fs.allow` 引导，修复 `verify-edit-gate` 在游离 review 槽执行兼容性；拆小 `flow-lifecycle.mjs` 使全部 `.mjs` `<= 800` 行。
- [ ] C18: 强化规划/实施/审查真实角色溯源校验：禁止同会话直接改 Todo 后伪传 `--owner` 绕过 `BLOCKED_AUTHOR_IS_IMPLEMENTER`，强化 `Case >= 2` 派发隔离实施子代理核查与 `handoff-package.mjs` 约束；Slice 6C 新增正反双向夹具（`scripts/dev/fixtures-w6c-harness-gates.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6c.mjs`(new)），执行 `node scripts/equip.mjs .` 后全量门禁全绿。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`two-way`；回滚做法：在隔离分支直接 `git revert <commit>` 即可回退全部门禁与状态机调整。
- **高风险路径**：触及 `kit/` 高风险路径（须独立审查 + 两阶段故障注入）。
- **故障注入预演**：在 `scripts/dev/injections-data-w6c.mjs`(new) 注入破坏 `BLOCKED_CROSS_REPO_CWD_MISMATCH` 拦截、破坏 `**Bold**` 模板 `--body` 保留、破坏 `escalation` 签名去重、破坏同会话防伪造 `--owner` 拦截，跑 `node scripts/dev/verify-injections.mjs --only W6C` 验证变红捕获。

## 澄清与补充记录

- 已定（2026-11-22）：6C 严格依赖 `6A` 与 `6B` 合入 `main` 后再启动实施，`scope_files` 与 6A/6B 零文件重叠。

## 实现说明

> 代码合入前补齐，随功能 PR 一同提交并标记 `implemented`；若常青架构已同步进 `docs/TDD.md`，随关联 `PRD`/`Todo` 成对归档至 `docs/archive/specs/`。

- **实际落地摘要**：待实施后填写
- **与草案的差异**：待实施后填写
- **关联同步文件**：待实施后填写
