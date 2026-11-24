---
kind: prd
title: 对话记忆、全周期两态状态机与契约瘦身
status: active
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
owner: planner-conv-arch
plan_mode: interactive
plan_critique: "passed (reviewer=critic-conv-arch, round=1, sha=c354cd38aa32, summary=1:N Master PRD 事实锚定准确，C1-C12 可验证且无待拍板问题，与 TDD/AGENTS 14KB-16KB 预算及架构不变量一致)"
related_spec: null
related_todo: null
multi_spec: true
---

# 对话记忆、全周期两态状态机与契约瘦身 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-24` / `2026-11-24` |
| 关联 Issue / PR | `#169` / 未关联 |
| 提出方 / 负责人 | planner-conv-arch |
| 规划态 | `interactive`（全部关键设计与 5 项决策已由用户确认，待拍板为零） |
| 切片架构 | 1:N 总控 PRD -> 3 份串行切片 SPEC + Todo（Wave 1 -> Wave 2 -> Wave 3） |

- **目标读者**：实现者、独立审查者与后续接手人

## 一、要解决的问题

### 现状与痛点

1. **核心状态机存在多处断层**：`kit/skills/dev-plan/scripts/doc-plan-ops.mjs` 的 `clarifyDoc` 不更新 `## 待拍板问题` 导致 `BLOCKED_PENDING_DECISIONS` 无法自动消解；`approveSpec` 在 `critique-continue` 后再获 `critique-pass` 仍被旧停损记录误拦截；`kit/skills/lib/critique-store.mjs` 在工作树场景下 `sidecarCritiqueFile` 未统一解析 `commondir`、有账本后未合并 sidecar 历史且异步写入缺少文件锁；`kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/critique-diff.mjs` 与 `kit/skills/lib/plan-next.mjs` 在 `roundBaseline`、`continued.active` 清理与 R2 范围判定上不一致；`kit/skills/dev-flow/scripts/flow-sync.mjs`、`flow-merge.mjs`、`flow-cleanup.mjs`、`flow-lifecycle.mjs`、`flow-inspect.mjs` 与 `kit/skills/dev-explore/scripts/repo-map.mjs` 存在 rebase 冲突标志未清、`unmountSharedDeps` 缺 `mountedPaths`、`--reviewer-id` 未纳入 `callerActor` 自合校验、`handleAbort` 漏传 `remoteUrls` 与未检分支删除退出码、`local-only`/`generic-git` 缺 `lastSubmittedHead`、`handleVerify` 缺槽位边界校验等缺陷；`kit/skills/dev-review/scripts/review-pack.mjs`、`review-diff.mjs`、`review-ledger.mjs`、`review-locks.mjs`、`review-empirical.mjs` 在审查中会误快进或读取 `impl-<id>` 而非钉住 `review-<id>`；`kit/skills/lib/criteria-lock.mjs`、`flow-lifecycle-finalize.mjs`、`flow-start-helpers.mjs` 与 `kit/skills/lib/handoff-package.mjs` 存在归档后 `criteriaFrozenFrom` 失配、死字段 `frozenCriteriaSnapshot` 残留及交接包缺上下文渲染。
2. **缺少多主题对话记忆与全周期两态模型**：`kit/skills/lib/session-state.mjs` 目前仅维护单态 `preInit` 与按字符截断的列表，缺少多主题 `topics[topicId]`、可覆写键值对 `facts`、可关闭 `open` 项与重建友好 `anchors`，且 `markTriageConsumed` / `resolveInheritedTriagePlanMode` 会跨任务误消费；缺少单一权威 `evaluateMutability`（`OPEN` / `LOCKED` 两态及安全出口），导致文档冻结拦截、`dropped` 终态回收与 `flow rework --reopen` 缺乏统一守卫。
3. **CLI 契约与 Skill 指令体积膨胀**：`kit/skills/lib/cli.mjs`、`doc-plan.mjs`、`flow.mjs` 与 `review-pack.mjs` 的公共选项与 `[NEXT STEP]` 输出存在旧别名混用、重复打印与 `--json` 缺少 `nextSteps`；`kit/skills/dev-govern/SKILL.md`（15572 B）与 `kit/skills/dev-review/SKILL.md`（15030 B）超过 14KB 且缺少字节预算门禁，`templates/agents-project.md` / `AGENTS.md` 存在 Case 1 隔离描述矛盾。

### 目标用户与使用场景

- **多轮规划与研发协作**：规划者、实施者与独立审查者在跨会话、多切片、工作树隔离与 `rework` 场景下依赖单源状态账本、多主题对话记忆与清晰 CLI 指引完成交接。
- **仓库维护者与门禁体系**：通过 `scripts/dev/preflight.mjs` 与 `scripts/dev/fixtures.mjs` 自动守卫 Skill 体积预算、契约同步与正反双向状态机行为。

### 产品目标

1. 消除规划 Critique、Flow 生命周期、Review 槽位与 Criteria 冻结链路全部已定位的状态完整性漏洞，实现端到端状态账本可回读、零静默失步。
2. 落地 `session-state.mjs` `schemaVersion: 2` 多主题对话记忆与 `kit/skills/lib/mutability.mjs` (new) `OPEN` / `LOCKED` 两态状态机，使变更边界、放弃路径与受控重开均有单一权威判据。
3. 完成公共 CLI 参数与 `[NEXT STEP]` 归一化，落地 `14KB`/`16KB` Skill 体积门禁，将全部 8 套 `kit/skills/*/SKILL.md` 瘦身至 14KB 以下并保持常青文档同步。

## 二、范围与非目标

### 本次要做（In Scope）

1. **切片 1（`core-state-integrity`，Wave 1）**：`docs/specs/261124-core-state-integrity-spec.md` 与 `docs/todo/261124-core-state-integrity-todo.md`，修复规划、Critique、Flow、Review 与 Criteria/Handoff 核心状态完整性。
2. **切片 2（`conversational-lifecycle-model`，Wave 2）**：`docs/specs/261124-conversational-lifecycle-model-spec.md` 与 `docs/todo/261124-conversational-lifecycle-model-todo.md`，落地 `session-state.mjs` v2 多主题记忆、`session-orient.mjs` 完整渲染、`doc-plan`/`doc-locate`/`repo-map` 记忆集成、`kit/skills/lib/mutability.mjs` (new) 两态模型、`dropped` 终态及 `flow rework --reopen` 守卫。
3. **切片 3（`ergonomics-and-budget-debloat`，Wave 3）**：`docs/specs/261124-ergonomics-and-budget-debloat-spec.md` 与 `docs/todo/261124-ergonomics-and-budget-debloat-todo.md`，归一化 CLI 公共标志与 `[NEXT STEP]` / `nextSteps` 输出，新增 `KIT_SKILL_WARN_BYTES` / `KIT_SKILL_MAX_BYTES` 门禁，瘦身 `kit/skills/*/SKILL.md` 并同步 `AGENTS.md`、`templates/agents-project.md`、`docs/TDD.md`、`references/collaboration.md`、`README.md` 与 `README.en.md`。

### 明确不做（Non-Goals）

- 不引入任何第三方 npm 依赖，严格保留 Node 18+ `node:*` 内置模块约束。
- 不在产品层硬编码特定 AI 宿主名称、环境变量或私有路径。
- 不删除旧 CLI 参数的向后兼容别名（旧标志保留为静默别名，仅把规范文档与提示统一到规范名）。
- 不通过删减有效规则来凑体积预算，瘦身仅拆解超长冗余条文与重复错误码罗列。

## 三、用户身份与权限

| 身份 | 能做什么 | 不能做什么 | 代码或配置中的载体 |
| --- | --- | --- | --- |
| 规划者（Planner） | 起草 PRD/SPEC/Todo、`note` 缓冲、`clarify --by user` 消解待决问题、`drop-criterion`（需用户授权） | 不得自审 Critique、不得绕过 `LOCKED` 直接 `clarify` | `owner`、`plan_mode`、`kit/skills/lib/mutability.mjs` (new) |
| 独立审查者（Critic / Reviewer） | 钉住 `review-<id>` 槽位跑只读审查与 `critique-pass`/`critique-reject`/`review-pack record`、`merge` | 不得在 `callerActor` 与 `implementerId` 相同时自合（`BLOCKED_SELF_MERGE`） | `reviewer-id`、`callerActor`、`reviewToken` |
| 实施者（Implementer） | 在隔离 `impl-<id>` 槽位编码、`verify`、`finalize`、`submit`、有授权时 `rework --reopen` | 不得在无 `--reopen --reason` 时重开已锁定任务，不得静默删减 `C*` | `implementerId`、`claimedBy`、`criteriaFingerprint` |
| 人类维护者（Maintainer） | `critique-override --human-approved`、授权 `--by user` 删减条目与 `reopen` | 仅在显式参数与理由充足时解锁停损 | `--human-approved`、`--by user`、`--reopen --reason` |

## 四、关键业务流程

1. **Wave 1 状态闭环（核心完整性）**：确保每次澄清、Critique 轮次、工作流 `sync`/`verify`/`submit`/`merge`/`abort` 及 `review-pack` 与 `criteria-lock` 均绑定到正确的工作树槽位、`commondir` 侧车/账本与有效基线 SHA。
2. **Wave 2 对话记忆与两态生命周期**：`note` 与 `triage` 按 `topicId` 写入 `session-state.json` v2，`doc-locate --topic` / `repo-map --topic` 仅在显式传参时写 `anchors`；文档与任务生命周期由 `evaluateMutability` 统一判定 `OPEN` 或 `LOCKED`，对 `LOCKED` 的修订或 `rework` 强制经 `--reopen --reason` 或 `critique-override` 安全出口，放弃任务时统一将关联文档标为 `dropped` 终态。
3. **Wave 3 契约归一化与瘦身**：规范 CLI 参数与 `[NEXT STEP]`/`nextSteps` 输出，落地 `14KB`/`16KB` Skill 体积预算门禁，完成 8 套 `kit/skills/*/SKILL.md` 与 `AGENTS.md`/`docs/TDD.md`/`references/collaboration.md`/双语 `README` 对齐。

## 五、状态与业务规则

| 对象 | 状态 | 允许的迁移 | 迁移的触发条件 |
| --- | --- | --- | --- |
| 规划文档（PRD/SPEC/Todo） | `OPEN`（`draft` / `pending` / `active` 且未 `approved`）-> `LOCKED`（`approved` / `implementing` / `in_review`） | `approve` 锁定；`rework --reopen` 退回 `OPEN` | 通过 `audit` 与 Critique 后 `approve`；`LOCKED` 下 `clarify` 报 `BLOCKED_DOC_FROZEN` |
| 规划文档终态 | `OPEN` / `LOCKED` -> `dropped` / `superseded` / `implemented` / `done` | `archive --drop --reason` 或 `flow abort` 标为 `dropped` | 用户明确放弃或被新文档取代 |
| `session-state.json` | `schemaVersion: 1` -> `schemaVersion: 2` | 向后兼容读取 v1，写入按 v2 `topics[topicId]`（最多 5 活跃主题，每主题 6144 B） | `appendPreInitNote` / `recordTriageDecision` / 显式 `--topic` 锚点写入 |
| `flow rework` | `changes` / `queueConflict` / `LOCKED` -> `OPEN` | 仅显式 `--reopen --reason` 允许从 `LOCKED` 重开 | 原子吊销未消费 `reviewTokens` 并清空 `reviewPassed*` |

## 六、复用既有模块

- 账本与文件锁原语：`kit/skills/lib/ledger.mjs`、`kit/skills/lib/git.mjs`（`withFileLockSync`、`writeJsonAtomic`、`readJsonSafe`）、`kit/skills/lib/git-fast.mjs`。
- Critique 与文档冻结原语：`kit/skills/lib/critique-store.mjs`、`kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/critique-diff.mjs`、`kit/skills/lib/criteria-lock.mjs`、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/doc-slice-graph.mjs`。
- 流程与 CLI 公共基础设施：`kit/skills/lib/cli.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/handoff-package.mjs`、`scripts/lib/protocol.mjs`、`kit/skills/lib/tool-owned.mjs`。

## 七、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 零第三方依赖 | `scripts/` 与 `kit/` 仅使用 Node 18+ 内置 `node:*` 模块 | `node scripts/dev/preflight.mjs` |
| 体积与存储预算 | 单主题对话记忆 <= 6144 B（最多 5 活跃主题）；单个 `kit/skills/*/SKILL.md` <= 14KB 告警 / <= 16KB 硬限；`mutability.mjs` <= 200 行 | `node scripts/dev/preflight.mjs` 与 `scripts/dev/fixtures.mjs` |
| 向后兼容 | `session-state.mjs` 兼容读 v1；旧 CLI 参数保留为静默别名；单仓独立 SPEC 与 1:N 总控均合法 | `node scripts/dev/fixtures.mjs` 正反双向用例 |
| 并发与原子性 | 侧车 Critique、`repo-map --task` 与 `reopen` 吊销均采用锁或原子更新 | `scripts/dev/fixtures.mjs` 并发与回读断言 |

## 八、验收标准

- [ ] C1: 切片 1（`core-state-integrity`）修复 `doc-plan-ops.mjs`（`clarifyDoc` 同步更新 `## 待拍板问题`、`approveSpec` 支持 `critique-continue` 后再 `critique-pass`）、`critique-store.mjs`（`commondir` 侧车路径、账本与 sidecar 合并及 `persistPlanCritiqueEntry` 文件锁）及 `critique-rounds.mjs` / `critique-diff.mjs` / `plan-next.mjs`（`fromSha` + `roundBaseline`、`continued.active` 清理、R2 范围纳入 `continued.reason`、已批文档重跑撤销 `approved`、编辑期间保留 `continueActive`），由 `node scripts/dev/fixtures.mjs` 全部正反用例验证通过。
- [ ] C2: 切片 1（`core-state-integrity`）修复 `flow-sync.mjs`（clean rebase 清除 `queueConflict` 并刷新 `finalizedHead`，`unmountSharedDeps` 传入 `mountedPaths`）、`flow-merge.mjs`（`callerActor` 纳入 `opts['reviewer-id']` 阻断自合）、`flow-cleanup.mjs`（`handleAbort` 传 `remoteUrls`、校分支删除退出码、清 `private-docs` / `evidence.json` / `review-empirical.json`）及 `flow-lifecycle.mjs` / `flow-inspect.mjs` / `repo-map.mjs`（`local-only`/`generic-git` `submit` 写 `lastSubmittedHead`、`handleVerify` 校验槽位边界、`in-place` 复用、`repo-map --task` 原子更新账本），由 `node scripts/dev/fixtures.mjs` 验证通过。
- [ ] C3: 切片 1（`core-state-integrity`）修复 `review-pack.mjs` / `review-diff.mjs` / `review-ledger.mjs` / `review-locks.mjs` / `review-empirical.mjs`：`--include-diff` 与 `record` 钉住 `review-<id>` 槽位及已审 `headSha`（审查中途不快进或读取 `impl-<id>`），卸载传 `mountedPaths`，`evaluatePassBlockers` 使用 `resolveEffectiveBaseSha`，`faultRequired` 时 `evaluateIncludeDiffGate` 强制核对 `check-fault:fail` 与 `check-fault:restore`。
- [ ] C4: 切片 1（`core-state-integrity`）修复 `criteria-lock.mjs` / `flow-lifecycle-finalize.mjs` / `flow-start-helpers.mjs` / `handoff-package.mjs`：归档时更新 `criteriaFrozenFrom` 至 `docs/archive/specs/`，在 `flow start` 为批准于建账前的文档回填 `criteriaFingerprint`，移除死字段 `frozenCriteriaSnapshot`，在 `submit` 与 `review-pack record` 强制 `checkFrozenCriteria`，并在 `buildHandoff` 渲染 `issueContext`/`prContext`、动态 `--section` 标题与 `## 怎么算做完` 中的 `smoke-verify`。
- [ ] C5: 切片 2（`conversational-lifecycle-model`）将 `kit/skills/lib/session-state.mjs` 升级至 `schemaVersion: 2`（向后兼容读 v1）：按 `topics[topicId]` 聚合 `preInit` 与 `triage`（最多 5 个活跃主题、每主题 6144 B 上限、可覆写 `facts` 键值对、通过 `--resolve` 关闭 `open`、`nonGoals`、优先淘汰可重建 `anchors`、永不静默 FIFO 删除 `facts`），严格按 topic/task/slug 隔离 `markTriageConsumed` 与 `resolveInheritedTriagePlanMode`，并在 `kit/skills/lib/session-orient.mjs` 完整渲染活跃主题（取消 `.slice(-4)` 截断）且 `includeWorktrees: true` 按新鲜度去重。
- [ ] C6: 切片 2（`conversational-lifecycle-model`）扩展 `kit/skills/dev-plan/scripts/doc-plan.mjs` 与 `doc-plan-ops.mjs` 的 `note`（`--topic`、`--fact k=v`、`--resolve`、`--drop`、`--reset`）；`triage` 绑定 `topic` 且省略 `--paths` 时不再自动吸入脏 `git status` 文件；`init` 在 `open.length > 0` 时报 `BLOCKED_OPEN_QUESTIONS_UNRESOLVED`（除非 `--allow-open-draft`，且仅将 `open` 写入主文档并只消费目标主题）；修复 `init --kind prd --multi-spec` 无账本 worktree 陷阱；`kit/skills/dev-explore/scripts/doc-locate.mjs` 与 `repo-map.mjs` 默认零写入，仅显式传 `--topic <id>` 时向仓外 `session-state.json` `topics[topicId].anchors` 写入已验真相对路径。
- [ ] C7: 切片 2（`conversational-lifecycle-model`）新增不超过 200 行的单源纯函数模块 `kit/skills/lib/mutability.mjs` (new) 导出 `evaluateMutability`（`open` / `locked` + `safeExits`）并接入 `doc-plan next`、`clarify`、`flow next`、`flow rework`；`clarifyDoc` 对 `LOCKED` 阻断报 `BLOCKED_DOC_FROZEN` 并附 3 个安全出口，支持 `--drop-criterion C<N> --reason --by user` 并在 `checkDocRegression` 放行用户授权删除同时继续拦截静默删除；在 `VALID_STATUS_BY_TYPE`、`doc-plan archive --drop --reason` 与 `flow abort` 落地 `dropped` 终态；`checkOrphanSlices` 允许互不关联的独立 SPEC，`checkMasterCriteriaCoverage` 在 Master PRD `active` 期允许分阶段切片并在收口时强制 100% 覆盖，`plan-next` 在 `--task` 同时命中 PRD 与 SPEC 时优先 PRD 且不饿死次要活跃计划。
- [ ] C8: 切片 2（`conversational-lifecycle-model`）加固 `kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/lib/workflow-policy-next.mjs` 与 `kit/skills/dev-flow/scripts/flow-next.mjs`：`flow rework` 默认仅在 `changes` 或 `queueConflict` 时放行，在 `LOCKED` 态缺 `--reopen --reason` 报 `BLOCKED_REWORK_REQUIRES_REOPEN`，带 `--reopen --reason` 时原子吊销未消费 `reviewTokens`、清空 `reviewPassed*` 并退回 `OPEN`；`ambiguous` 阶段为每个任务暴露各自 `phase` 与 `mutability` 并仅将就绪/实施中任务送入 `batch plan`。
- [ ] C9: 切片 3（`ergonomics-and-budget-debloat`）在 `kit/skills/lib/cli.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `kit/skills/dev-review/scripts/review-pack.mjs` 归一化公共 CLI 标志、帮助文档与 `[NEXT STEP]`（规范名为 `--agent`、`--mode`、`--host-mode`，旧参数保留为静默别名），修复 `doc-plan triage` `[NEXT STEP]` 漏 `--owner`/`--agent`、移除 `audit` 重复 `printNextStep`、修复 `flow start` 复用分支 `[NEXT STEP]` 并在 `--json` 模式统一输出 `nextSteps`。
- [ ] C10: 切片 3（`ergonomics-and-budget-debloat`）在 `scripts/lib/protocol.mjs`（与 `kit/skills/lib/tool-owned.mjs` 单源同步）及 `scripts/dev/preflight.mjs` / `scripts/dev/preflight-suite.mjs` 定义并强制执行 `KIT_SKILL_WARN_BYTES = 14 * 1024` 与 `KIT_SKILL_MAX_BYTES = 16 * 1024`。
- [ ] C11: 切片 3（`ergonomics-and-budget-debloat`）在不丢失任何有效约束与错误码语义的前提下，拆解 `kit/skills/*/SKILL.md` 内 1000B 级超长列表与重复错误码罗列，使全部 8 套内置 Skill 文档体积均舒适低于 14KB / 16KB 预算并通过 `scripts/dev/preflight-contracts.mjs` 关键契约覆盖检查。
- [ ] C12: 切片 3（`ergonomics-and-budget-debloat`）对齐 `templates/agents-project.md` 与 `AGENTS.md` 中的 Case 1 隔离矛盾及 `WARN_WORKING_IN_MAIN_CHECKOUT` 文案，同步更新 `docs/TDD.md`、`references/collaboration.md`、`README.md` 与 `README.en.md`，并全量通过 `compose-agents.mjs .`、`equip.mjs .`、`sync-toc.mjs --check`、`review.mjs .`、`preflight.mjs` 与 `fixtures.mjs`。

## 九、待拍板问题

- 待确认：无

## 十、成功度量

| 度量 | 现状基线 | 目标 | 怎么采集 | 什么时候看 |
| --- | --- | --- | --- | --- |
| `kit/skills/*/SKILL.md` 最大字节数 | `dev-govern` 15572 B、`dev-review` 15030 B | 全部 8 套 < 14336 B（14KB） | `node scripts/dev/preflight.mjs` | Wave 3 合并前 |
| 状态完整与两态回归用例通过率 | 存在 3 类跨模块缺口 | `fixtures.mjs` 与 `preflight.mjs` 100% 通过 | `node scripts/dev/fixtures.mjs` | 每波合并前 |
| `doc-plan.mjs audit .` 报错数 | 规划阶段验收 | 0 error、0 未决问题、100% 认领覆盖 | `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .` | 规划定案与每波合前 |

- **如果目标没达到**：对应切片禁止 `approve` 或 `merge`，退回该切片 `impl` 槽位补齐正反 fixture 与修复后重审。

## 十一、门型与回滚路径

- **门型判定**：`one-way`（涉及 `session-state.json` v2 Schema、跨脚本状态机、CLI 规范参数与 `scripts/dev/preflight.mjs` 预算门禁升级）。
- **回滚路径**：按 Wave 3 -> Wave 2 -> Wave 1 逆序发出反向提交（`git revert`），禁止对远端重写历史；`session-state.mjs` 保持向后兼容读取 v1，旧参数保留静默别名以保证降级安全。

## 十二、依赖与前置条件

| 依赖 | 类型 | 就绪状态 | 没有它会怎样 |
| --- | --- | --- | --- |
| 切片 1（`docs/specs/261124-core-state-integrity-spec.md`） | 内部 Wave 1 前置 | 已建档待 Critique | 切片 2 状态原语依赖的账本锁与工作树基线不稳 |
| 切片 2（`docs/specs/261124-conversational-lifecycle-model-spec.md`） | 内部 Wave 2 前置 | 已建档待 Critique | 切片 3 CLI 归一化与文档同步缺少两态模型与 `note` 定稿 |
| 切片 3（`docs/specs/261124-ergonomics-and-budget-debloat-spec.md`） | 内部 Wave 3 收尾 | 已建档待 Critique | 契约体积门禁与常青文档无法闭环 |

## 十三、风险与开放问题

| 风险 | 可能性 | 影响 | 缓解办法 |
| --- | --- | --- | --- |
| 切片 1/2 改动触及多个 `kit/skills/lib/` 模块引发现有测试或注入门禁漂移 | 中 | 高 | 每波合前必跑 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs` 与 `e2e-zip-harness.mjs` |
| `kit/skills/*/SKILL.md` 瘦身误删 `preflight-contracts.mjs` 断言关键词 | 中 | 中 | 改前对照 `preflight-contracts.mjs` 必备关键词列表并在改后立即运行 `preflight.mjs` 验真 |
| `session-state.mjs` v2 迁移时旧 v1 账本读取兼容遗漏 | 低 | 高 | 为 v1 读入转换与超预算淘汰顺序编写正反双向 fixture |

## 澄清与补充记录

- 已确认（2026-11-24 · user）：采用 1:N 总控 PRD + 3 份串行切片（`core-state-integrity` -> `conversational-lifecycle-model` -> `ergonomics-and-budget-debloat`）拆分落地；全周期统一 `OPEN`/`LOCKED` 两态状态机、`session-state.mjs` v2 多主题记忆（5 主题 / 6144 B / 永不静默丢弃 `facts`）、`14KB`/`16KB` Skill 体积门禁及 CLI 规范参数与旧别名静默兼容方案全部拍板确认。
