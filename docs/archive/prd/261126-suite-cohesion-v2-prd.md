---
kind: prd
title: "Suite Cohesion, Universal Doc Graph and Empirical Gate Parity v2"
status: done
created: 2026-11-26
updated: 2026-11-26
issue: null
pr: null
owner: planner-arch
plan_mode: interactive
plan_critique: "passed (reviewer=critic-governance-cohesion-r4, round=4, sha=11cecd318bb7, summary=Verified mechanical lint/naming fixes at 6e6f870; all design invariants and C1..C12 remain intact.)"
related_spec: null
related_todo: null
multi_spec: true
---

# Suite Cohesion, Universal Doc Graph and Empirical Gate Parity v2 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-26` / `2026-11-26` |
| 关联 Issue / PR | 未关联 / 未关联 |
| 提出方 / 负责人 | planner-arch |
| 规划态 | `interactive`（跨模块边界与契约已冻结，待拍板为零） |
| 切片架构 | 1:N 总控 PRD -> 3 份切片 SPEC + Todo（Wave 1 并行：`doc-graph-evergreen-brief` + `empirical-handoff-cohesion`；Wave 2：`review-comment-case2-parity`） |

- **目标读者**：实现者、独立 Critique 审稿人、独立审查者与仓库维护者

## 一、要解决的问题

### 现状与痛点

1. **常青文档发现依赖硬编码词表与自然语言启发式，且缺少图谱闭环**：`kit/skills/lib/profile.mjs`（L539、L717）仍依赖 `CLASSIC_EVERGREEN_RE` 文件名白名单与自然语言指针词表正则判定权威文档及分裂副本，`profile.mjs:378` 的 `activeRawKey` 遗漏 `evergreenDocs` 分支导致多行 `- none` 误将 `arch-rules` 写入 `explicitNone`。同时，`docAnchors` 仅校验文件路径存在性而不校验 `#heading` 锚点，也缺少强连通环、重定向链、入口分歧与未纳入治理的活跃文档全量核账。
2. **Case 5 与 Living Visual Brief UX 存在断点**：`kit/skills/dev-plan/scripts/doc-plan-brief.mjs` L169 仅对 `result.caseType === 3 || result.caseType === 4` 生成简报而漏掉 Case 5，且 L199-200 将 Case 3 `triage` 绕过 `doc-plan.mjs init --kind todo` 直接引导至 `flow.mjs start`；`doc-plan-ops.mjs` 生成 `tdd` 时未刷新简报；`doc-plan.mjs` `init` 文本输出未打印 `htmlUri`，Case 4 `approve` `nextStep` 漏掉 `--agent` 参数。
3. **实证门禁、UI 产物校验与合流通道多处契约脱节**：`review-empirical.mjs:420` 与 `review-empirical-state.mjs:316` 对省略 `smoke-verify` 的场景形成死循环阻断；`scripts/lib/agents-defaults.mjs:406` 让纯库/CLI 新接入即遭 `BLOCKED_SMOKE_VERIFY_UNCONFIGURED`；`review-empirical.mjs:92` 因 `|| hasDevProfileTestCmds` 导致仅改测试或非运行时文档/配置也被强制故障注入；`review-ledger.mjs` `record` 未自动复用同 `HEAD` 有效 `check-empirical` 回执并在 L426-438 三重拼接实证文本；`flow-lifecycle-helpers.mjs:405` 未传 `implRoot`、`flow-lifecycle.mjs:330` precheck 滞后且 `flow-lifecycle-helpers.mjs:620` 提示自相矛盾；`static-gates.mjs` `isUiVisualFile` 对非 UI 的 README `.svg` 误升高风险；`static-gates.mjs:383` 与 `review-gates.mjs:568` 误将非弱化门禁的 `one-way` 判为 `human-required` 且 `flow-merge.mjs:501` 仅返 `EXIT.FACT`（`exit-codes.mjs:133`）而非 `EXIT.HUMAN`（`4`）；`flow-merge.mjs` 当 `canUseGhApi && ledger.prNumber` 在 L578 为假（如 `mcp-delegate` 留下 `ledger.prNumber === null`）时落入 L657，使 `GitHubBackend.mergePr` 返回 `{ ok: false, delegated: true }` 并绕过 L679/L693 在 L722 静默将任务标为 `merged`；另有 `generic-git` 离线 `--reason` 校验缺失、`workflow-helpers.mjs:43` 缺 `posixPath`、`flow-next.mjs:346` `pack` 模式拼接无效标志、`verify-tools.mjs` 多处缺陷与 `govern-audit.mjs:395` 目录前缀缺失。
4. **审查评论冗余刷屏且 Case 2 验收条款易在长正文/本地工单下丢失**：`flow-context.mjs:76` `summarizeContextBody` 超过 1200 字符直接硬截断导致 `- [ ] C*` 条款被切掉；`review-gates.mjs` `parseAcceptanceCriteria` 仅认半角冒号且缺同步 `getLocalIssue` 回退、`review-sync.mjs:369` 在渲染前未先实例化 `backend` 导致缺异步 `backend.getIssue` 回退；`review-comment-render.mjs` 对同一事件在 PR 与 Issue 重复渲染 95% 相同正文，夹带冗余 `对比基线`、默认 `止损记录：未触发`、固定 `审查来源` 及内部 `node ".agents/..."` 命令；`flow-lifecycle.mjs:713-717` `createPr` 后立即再发冗余 `"提交待审"` PR 评论。

### 目标用户与使用场景

- **仓库维护者与规划者**：在 `S1` 勘察、`govern audit/reconcile`、`dev-plan`（Case 3/4/5 与 `tdd`）中获得零词表硬编码的文档图谱诊断、精准路由指引与直接可点击的 Living Visual Brief 链接。
- **实施者与独立审查者**：在 `flow.mjs` 与 `review-pack.mjs` 获得自洽无死锁的实证门禁、UI 产物豁免边界、安全的 `mcp-delegate`/`generic-git` 合并核验，以及高信号无刷屏的 PR/Issue 评论。

### 产品目标

1. 落地纯结构叶子模块 `kit/skills/lib/doc-graph.mjs` (new)，消除文件名白名单与自然语言启发式，打通全仓活跃文档核账、`#heading` 锚点校验、`govern`/`survey`/`verify-tools-audit`/`review-context` 单源消费，并修复 Case 5/3 与 Brief 展示断层。
2. 消除 `check-empirical`、`check-fault`、UI 产物核验、`review-ledger` 回执复用、`flow-merge` 与 `verify-tools` 的全部跨模块契约不一致与近上限超行风险（全 `.mjs <= 800` 行）。
3. 实现 Case 2 `C1..Cn` 跨后端无损提取与 `review-comment-render.mjs` 单源渲染瘦身（区分完整 PR/无 PR 工单与紧凑关联 Issue 摘要），锁步同步模板、契约规则（`REVIEW_FIELDS`、`preflight-contracts.mjs`、`kit/skills/dev-review/SKILL.md`）、测试夹具与故障注入表。

## 二、范围与非目标

### 本次要做（In Scope）

1. **切片一（`doc-graph-evergreen-brief`，`depends_on: []`）**：通用文档图谱内核 `kit/skills/lib/doc-graph.mjs` (new)（4 项图谱校验 + 活跃文档五分法 + 非 Markdown 权威支持）、`profile.mjs:378` 修复、接入 `govern-*`/`verify-tools-audit.mjs`/`review-context.mjs`/`survey*`（含 `govern-audit.mjs:395` 目录前缀一致）、Case 5/3 与 `tdd` Living Visual Brief UX 补齐（`doc-plan-brief.mjs`、`doc-plan-ops.mjs`、`doc-plan.mjs`、`kit/skills/dev-plan/SKILL.md`）。
2. **切片二（`empirical-handoff-cohesion`，`depends_on: []`）**：`review-empirical*`（L92 去 `|| hasDevProfileTestCmds`、L420 修死锁、全 `none` 纯文档仓经静态校验放行）、`agents-defaults.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`flow-lifecycle*`（将 precheck 辅助抽入 `flow-lifecycle-hooks.mjs` 保 `flow-lifecycle-helpers.mjs <= 800` 行）、`static-gates.mjs`（将细化 `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs` 保 `static-gates.mjs <= 800` 行，并由 `review-gates.mjs:518,525` 透传 `untrustedSurface` 收窄 `mergeAuthority = 'human-required'` 至 `gateWeakened || humanAuth || untrustedSurface`）、`exit-codes.mjs`（将 `BLOCKED_HUMAN_MERGE_AUTHORITY` 从 `FACT_CODES` L133 迁至 `HUMAN_CODES` `4` 对拍 `exit-code-parity.mjs:152`）、`flow-merge.mjs`（L657-722 守卫 `!mergeRes || mergeRes?.delegated === true || mergeRes?.ok === false`、`generic-git` 离线 `--reason` 与 L501 返回 `EXIT.HUMAN` `4` 同步 `scripts/dev/fixtures-govern.mjs:60`）、`task-backend-local.mjs`、`review-gates.mjs`（L568 同步收窄 `mergeAuthority`）、`flow-next.mjs`、`handoff-package.mjs`、`workflow-*`、`verify-tools.mjs`、`verify-state.mjs`。
3. **切片三（`review-comment-case2-parity`，`depends_on: [empirical-handoff-cohesion]`）**：`flow-context.mjs` `C1..Cn` 截断保留、`kit/skills/lib/plan-sync.mjs`（600 行，无环承接纯条款解析含全角 `C1：` 与同步 `getLocalIssue` 回退辅助，保 `review-gates.mjs < 780` 行及 `I247` 并避免 `review-sync.mjs:18` 循环导入）、`review-sync.mjs`（L369 前提前实例化 `backend` 以执行异步 `backend.getIssue` 回退）、`review-comment-render.mjs`（`renderReviewSection({ isFull })` + 新三字段 + 条件止损 + 去噪去泄漏）、`doc-comments.mjs`、`flow-lifecycle.mjs`（去冗余首评）以及 `scripts/dev/preflight-contract-rules.mjs`、`scripts/dev/preflight-contracts.mjs`、PR 模板、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md`、锁步夹具与故障注入 `I7`/`I8` 升级。

### Slice Plan Table（1:N 切片规划表）

| 切片 `task_id` | 依赖 (`depends_on`) | 波次 | SPEC / Todo 路径 | 认领验收项 |
| --- | --- | --- | --- | --- |
| `doc-graph-evergreen-brief` | `[]` | Wave 1 | `docs/specs/261126-doc-graph-evergreen-brief-spec.md` / `docs/todo/261126-doc-graph-evergreen-brief-todo.md` | `C1..C4` |
| `empirical-handoff-cohesion` | `[]` | Wave 1 | `docs/specs/261126-empirical-handoff-cohesion-spec.md` / `docs/todo/261126-empirical-handoff-cohesion-todo.md` | `C5..C8` |
| `review-comment-case2-parity` | `[empirical-handoff-cohesion]` | Wave 2 | `docs/specs/261126-review-comment-case2-parity-spec.md` / `docs/todo/261126-review-comment-case2-parity-todo.md` | `C9..C12` |

### 明确不做（Non-Goals）

- 不引入任何第三方 npm 包；不在 `kit/` 与 `scripts/` 中引用特定 AI 宿主名、私有路径或环境变量。
- 不将 `kit/skills/lib/static-gates.mjs`（792 行）、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`（795 行）、`kit/skills/dev-review/scripts/review-gates.mjs`（792 行）或 `scripts/lib/survey-docs.mjs`（791 行）膨胀超过 800 行，改前先向对应范围内部辅助模块抽离函数。
- 不删改或弱化既有故障注入锚点（`I217`、`I218`、`I934`、`I117`、`I247`、`I248`、`I413`、`I414`），涉及 `REVIEW_FIELDS` 契约调整的 `I7`/`I8` 随切片三锁步更新。

## 三、关键业务流程

1. **图谱勘察与 Brief 流转（切片一）**：`doc-graph.mjs` (new) 扫描仓库活跃文档并建图 `G = (V, E)`，供 `govern-evergreen`、`govern reconcile`、`verify-tools audit`、`review-context` 与 `survey` 共享单一真相；`doc-plan` 在 `triage`/`init`/`brief` 对 Case 3/4/5 与 `tdd` 实时更新简报并向终端及调用方输出 `htmlUri`。
2. **实证与合并核验流转（切片二）**：`flow verify` 在执行命令前先跑 UI/产物前置校验并跳过内循环重复门禁；`review-pack check-empirical` 按对齐后的 `runtimeTouched || smokeRequired` 与全 `none` 纯文档静态校验策略执行并将有效回执供 `review-pack record` 自动复用；`flow merge` 对 `mcp-delegate`（含 `prNumber === null` 落入 `backend.mergePr` 返回 `{ ok: false, delegated: true }` 场景）与离线 `generic-git` 强制阻断未核验合并，对 `BLOCKED_HUMAN_MERGE_AUTHORITY` 返回 `EXIT.HUMAN`（`4`）。
3. **跨后端条款提取与评论渲染（切片三）**：`flow-context` 与 `review-gates`/`review-sync`（`backend` 在渲染前实例化）保证 `C1..Cn` 跨远程/本地/截断完整传递；`review-comment-render` 按是否存在 `prNum` 切换 `renderReviewSection({ isFull })`，模板、`preflight-contract-rules`、`preflight-contracts`、`kit/skills/dev-review/SKILL.md` 与 `I7`/`I8` 同步新三字段与条件止损契约。

## 四、复用既有模块

- 文档扫描与前置：`kit/skills/lib/markdown-scan.mjs`（`scanLines`、`slugifyHeading`、`extractHeadingSlugs`）、`kit/skills/lib/doc-frontmatter.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/visual-brief.mjs`。
- 门禁与实证：`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/evidence-substance.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/local-issues.mjs`、`kit/skills/lib/exit-codes.mjs`。

## 五、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 零依赖与体积上限 | 零第三方依赖、零 emoji；全 `.mjs <= 800` 行；`kit/skills/*/SKILL.md <= 14336` B 且 `<= 180` 行 | `node scripts/dev/preflight.mjs` |
| 故障注入与契约闭环 | 全部 `I*` 故障注入精准命中；`equip.mjs . --check` 与 `merge-gate.mjs` 全绿 | `node scripts/dev/verify-injections.mjs --jobs 4` |

## 六、验收标准

- [x] C1: 切片一新增叶子模块 `kit/skills/lib/doc-graph.mjs` (new)（仅导入 `node:fs`、`node:path`、`./git.mjs`、`./markdown-scan.mjs`、`./doc-frontmatter.mjs`），以 `scanLines` + 真实磁盘 `fileSet` + `accountActiveDocs` 实现 `brokenLinks`/`brokenAnchors`（含 `missing-doc-anchor-heading` 独立分类）、`cycles`、`redirectChains`、`entryDivergenceAndOrphans` 4 项纯图谱校验与非 Markdown 权威支持，移除 `CLASSIC_EVERGREEN_RE` 与 `profile.mjs:717` 自然语言正则，修复 `profile.mjs:378` `activeRawKey` 漏映射 `evergreenDocs` 并保留 `profile.mjs:537` `I217` 锚点。
- [x] C2: 切片一将 `docGraph` 单源接入 `govern-evergreen.mjs`（保留 L136 `I218`）、`govern-audit.mjs`（含 L395 目录前缀匹配对齐）、`govern-docs.mjs`、`verify-tools-audit.mjs`（`resolveDocAnchor` + 目录前缀匹配）、`review-context.mjs` 及 `scripts/survey.mjs`/`scripts/lib/survey-scan.mjs`/`scripts/lib/survey-plan.mjs`（向 S1 探索分片注入 `unaccounted` 与结构缺陷，不破 `explorationStrategy` `--check` 且 `survey-docs.mjs <= 791` 行）。
- [x] C3: 切片一修复 Case 5/3 与 Living Visual Brief UX：`doc-plan-brief.mjs` L169 改为 `result.caseType >= 3`、Case 5 输出结构化 `nextSteps`、保留 L197 `I934` 原文、Case 3 `triage` `nextSteps` 路由至 `doc-plan.mjs init --kind todo`；`doc-plan-ops.mjs` 支持 `tdd` 刷新 `visualBrief`；`doc-plan.mjs` `init` 打印 `htmlUri` 且 Case 4 `approve` `nextStep` 带 `--agent`；更新 `kit/skills/dev-plan/SKILL.md`（`<= 14336` B、`<= 180` 行）。
- [x] C4: 切片一同步 `node scripts/equip.mjs .`，补齐正反双向夹具（`fixtures-r8-bugfixes.mjs:379` `missing-doc-anchor` 保持绿灯），通过 `node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4`。
- [x] C5: 切片二消除 `review-empirical.mjs:420` 与 `review-empirical-state.mjs:316` 省略 `smoke-verify` 死锁，优化 `scripts/lib/agents-defaults.mjs:406` 纯库/CLI 新手配置避免立即报 `BLOCKED_SMOKE_VERIFY_UNCONFIGURED`，将 `review-empirical.mjs:92` 改为 `!isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired)`（仅移除 `|| hasDevProfileTestCmds`，保留全部运行时改动包含高风险 `smoke-verify: none` 及 `fixtures-r8-bugfixes.mjs:348-356` 中风险运行时样本触发 `faultRequired === true`），并支持四项 Dev Profile 全 `explicitNone` 纯文档仓经静态校验通过 `check-empirical`。
- [x] C6: 切片二在 `review-ledger.mjs` 实现同 `HEAD` 有效 `check-empirical` 回执自动复用（保留 L121 `if (!evidenceRaw) {` 供 `I117`）、消除 L426-438 `empParts` 三重拼接、统一 `evaluateObservationSubstance` 与 `validateE2eEvidenceText` 判据并取消仅为附着文本重跑 `flow verify --mode smoke`。
- [x] C7: 切片二修复 UI 产物校验链与内循环：从 `flow-lifecycle-helpers.mjs`（795 行）抽离 precheck 辅助至 `flow-lifecycle-hooks.mjs` 并于 L405 透传 `implRoot`（控制两文件 `<= 800` 行）、`flow-lifecycle.mjs:330` 先执行 precheck 再跑测试、`flow-lifecycle-helpers.mjs:620` 去矛盾 `--visual-checked` 提示、`flow-lifecycle.mjs:94,402` 在 `quick --target` 内循环跳过 `--final` edit-gate 与重复 `govern-audit`；将细化 `isUiVisualFile` 辅助抽入 `empirical-artifacts.mjs`（保持 `static-gates.mjs <= 800` 行）并统一 `empirical-artifacts.mjs` 标准，豁免非 UI README `.svg` 与模板误升高风险。
- [x] C8: 切片二将 `static-gates.mjs:383`（`classifyDoorType` 接受由 `review-gates.mjs:518,525` 透传的 `untrustedSurface = false`）与 `review-gates.mjs:568` `mergeAuthority = 'human-required'` 收窄为 `gateWeakened || humanAuth || untrustedSurface`（同步 `scripts/dev/fixtures-govern.mjs:60`），将 `kit/skills/lib/exit-codes.mjs:133` `BLOCKED_HUMAN_MERGE_AUTHORITY` 从 `FACT_CODES` 迁至 `HUMAN_CODES`（`4`）并让 `flow-merge.mjs:501-503` 返回 `EXIT.HUMAN`（`4`，通过 `exit-code-parity.mjs:152`）；在 `flow-merge.mjs:657-722` 显式阻断 `!mergeRes || mergeRes?.delegated === true || mergeRes?.ok === false`（覆盖 `!ledger.prNumber && !ledger.branch` 及 `prNumber === null` 落入 `GitHubBackend.mergePr`）；补齐 `generic-git` 离线 `--reason` 校验（对齐 `task-backend-local.mjs:523`）、修复 `flow-lifecycle-finalize.mjs:229,243`、`workflow-helpers.mjs:43`、`flow-next.mjs:346`、`handoff-package.mjs:338-342`、`verify-tools.mjs:65,129,392`、`workflow-policy.mjs:727`，同步 `node scripts/equip.mjs .` 并全绿通过正反双向夹具与全部门禁。
- [x] C9: 切片三保证 Case 2 `C1..Cn` 跨后端无损传递：`flow-context.mjs:76` `summarizeContextBody` 截断超 1200 字符时完整保留 `- [ ] C*` 行；将纯条款解析（含全角 `C1：`）与同步 `getLocalIssue` 回退辅助抽入无环叶子 `kit/skills/lib/plan-sync.mjs`（避免与 `review-sync.mjs:18` 循环导入），`review-gates.mjs` 保留 `parseAcceptanceCriteria` 与 L256 `I247` 锚点并委托调用（控制 `review-gates.mjs < 780` 行）；`review-sync.mjs:369` 前提前实例化 `backend` 使异步 `backend.getIssue` 回退在渲染前真实生效。
- [x] C10: 切片三在 `kit/skills/lib/review-comment-render.mjs` 落地单源 `renderReviewSection({ isFull })`：PR 与无 PR 工单（`!prNum`）渲染完整结构含 `#### 验收标准逐条核对`；当 `prNum` 存在时关联 Issue 渲染指向 `PR #N` 的紧凑摘要。
- [x] C11: 切片三消除评论噪音与内部 CLI 泄漏：清除冗余 `对比基线` 行、默认 `止损记录：未触发` 与固定 `审查来源`（`REVIEW_FIELDS` 统一为 `['逐条标准状态', '故障注入记录', '实证核验']` 且仅 `stopLoss === true` 输出 `止损记录`）；清除 `doc-comments.mjs` / `review-comment-render.mjs` 对外评论中的内部 `node ".agents/..."` 命令；移除 `flow-lifecycle.mjs:713-717` `createPr` 后立即发送的冗余 `"提交待审"` PR 评论并同步 `scripts/dev/fixtures-trace-sync.mjs:422-430`、`scripts/dev/fixtures-flow.mjs:210,641` 与 `scripts/dev/injections-data-trace-sync.mjs:33-47`（`I413`/`I414` 保持通过）。
- [x] C12: 切片三锁步同步 `scripts/dev/preflight-contract-rules.mjs`（新三字段 `REVIEW_FIELDS`）、`scripts/dev/preflight-contracts.mjs:407-419`（动态 `${REVIEW_FIELDS.length} 个字段`）、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md:95`（`<= 14336` B、`<= 180` 行）、`scripts/dev/fixtures-review-contracts.mjs:16-51`、`scripts/dev/injections-data-core.mjs:56-71`（`I7`/`I8`，保持 `I247`/`I248` 通过）与 `node scripts/equip.mjs .`，全绿通过 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4` 与 `merge-gate.mjs`。

## 七、待拍板问题

- 待确认：无

## 八、门型与回滚路径

- **门型判定**：`one-way`（涉及 `doc-graph.mjs` (new) 权威文档发现算法、`isUiVisualFile` 风险边界、`mergeAuthority` 权限收窄、`flow-merge.mjs` 合并核验及 `REVIEW_FIELDS` 公开契约）。
- **回滚路径**：按切片三 -> 切片二 -> 切片一逆序执行 `git revert` 并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`。

## 九、依赖与前置条件

| 依赖 | 类型 | 就绪状态 | 没有它会怎样 |
| --- | --- | --- | --- |
| Wave 1（切片一 + 切片二）零写域重叠 | 架构边界依赖 | 已通过 `scope_files` 隔离就绪 | 同波次并行将触发合并冲突 |
| 切片三 `depends_on: [empirical-handoff-cohesion]` | 时序串行依赖 | 已在 Frontmatter 显式声明 | `flow-lifecycle.mjs` 与 `review-gates.mjs` 双写冲突 |

## 澄清与补充记录

- 澄清与补充记录：已根据 Round 1 Critique（`critic-governance-cohesion-r1`）校准 `C5` `faultRequired` 公式、`C8` `mergeAuthority`/`mcp-delegate` 边界、三处 800 行超限抽离目标及切片三锁步契约清单（`REVIEW_FIELDS` 三字段、条件止损、`preflight-contracts.mjs`、`kit/skills/dev-review/SKILL.md` 与对应夹具/注入）。
