---
kind: todo
title: 统一跨平台双层身份归属展示、生命周期标签与 AGENTS 意图路由去歧义
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 108
pr: null
branch: feat/issue108-attribution-routing
owner: plan-108
approved: true
done_at: null
task_id: w15-attribution-routing
planned_at: 01d47cc31d278e8e00ecd7e61784846f7a8331ae
related_prd: null
related_spec: ../specs/261120-issue108-w15-attribution-routing-spec.md
---

# 统一跨平台双层身份归属展示、生命周期标签与 AGENTS 意图路由去歧义

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-20` / `2026-11-20` |
| 分支 / 基线 | `feat/issue108-attribution-routing` @ `01d47cc` |
| 任务编号 | `w15-attribution-routing` |
| 负责人 / 审批 | `plan-108` / `false` |
| 关联 Issue / PR / SPEC | #108 / 未关联 / `docs/specs/261120-issue108-w15-attribution-routing-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交，以及 `docs/specs/261120-issue108-w15-attribution-routing-spec.md` 冻结条款。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/{github-parse,github-client,platform,shared,intake-triage,doc-comments,docs,workflow-helpers,workflow-policy,ledger,task-backend,local-issues}.mjs`、`kit/skills/lib/pr-template-hydrate.mjs` (new)、`kit/skills/lib/review-comment-render.mjs` (new)、`kit/skills/dev-flow/scripts/{flow-inspect,flow-intake,flow-explore,flow-issues,flow-lifecycle,flow-lifecycle-hooks,flow-merge,flow-next}.mjs`、`kit/skills/dev-review/scripts/{review-gates,review-ledger,review-pack,review-sync}.mjs`、`kit/skills/*/SKILL.md`、`.agents/skills/**`、`templates/agents-project.md`、`AGENTS.md`、`SKILL.md`、`references/{survey,docs-set,collaboration}.md`、`scripts/dev/{fixtures-attribution-routing,injections-data-attribution-routing}.mjs` (new) 与既有夹具/注入对齐文件
- **复用既有模块**：`parsePfStateTags` / `stripPfStateTags`（`github-parse.mjs`）、`TaskBackend`（`task-backend.mjs`）、`renderKitRoutingRows`（`scripts/lib/agents-defaults.mjs`）、`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/dev/verify-injections.mjs`
- **本期不做**：不修改 `dev-iterate` `cycle` 子命令（留待 `#102`）；不改变 `TaskBackend` 17 方法接口与账本目录布局；不引入第三方依赖
- **门型与回滚路径**：`two-way`；局部可逆改动，直接 `git revert` 对应提交或重跑 `equip.mjs` / `compose-agents.mjs` 即可回退
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: 删除 `github-parse.mjs` `INTERNAL_AGENT_SLUG_RE` 与 `doc-comments.mjs` `AGENT_OR_LOCAL_ID_RE` 及死代码分支，落地正交双层身份 `resolveIdentityLayers`、后端能力声明 `capabilities.mention`（零平台名硬编码）与唯一 `formatAttribution({ account, verifiedPlatformLogin, agent, supportsMention, capabilities })`：仅当后端声明支持 `@mention` 且 `verifiedPlatformLogin === true` 时输出 `@handle`，其余平台、未验证/`git user.name`、离线/`generic-git`/`local-only` 及任意 `agent` 一律反引号包裹，无真实账号时省略而非造 `@maintainer`；经 `node scripts/dev/fixtures.mjs --domain attribution-routing` 与 `I245–I246` 实测通过。
- [ ] C2: 统一 PR 正文与 5 类评论标签（`认领人`/`原认领人`、`实施人`、`审查人`、`分诊人`），清除 `implementer=` 与 `(respecting repo mergeAuthority)`；`parseAcceptanceCriteria` 在 Case 2/外部 PR 缺 SPEC/Todo 时回退解析 `ledger.issueContext`/`prContext` 复选框，`buildReviewComments` 在 `PASS` 与 `CHANGES_REQUESTED` 中均输出 `实证核验` 摘要并完整保留 `Must Fix`/`Should Fix`/`Pre-existing`/`本轮消解` 分区；修复 `flow-intake.mjs:206`（`state.gitIdentity?.name`）与 `flow-explore.mjs:32`；保留自审锁、`BLOCKED_SUBMIT_OWNERSHIP_MISMATCH` 及 `pf-state` 旧键兼容并补齐 `account`；经 `node scripts/dev/fixtures.mjs --domain attribution-routing` 与 `I247–I248` 实测通过。
- [ ] C3: 完成 `AGENTS.md` 路由去歧义（`dev-plan` 先于 `dev-flow`、`extra_routes` `order: 46` 收口 `intake/inspect/milestone`、去重里程碑行、`project-forge` 移至末行）、补全 8 技能脚本入口并清除 `dev-review` `tier: full`、刷新根 `SKILL.md` 为 `v3` 并补全 8 技能闭环（`<= 200L / 16384B`、`version: "6.0.0"`）、在 `references/survey.md`、`references/docs-set.md`、`references/collaboration.md` 与 `templates/agents-project.md` 落地四类资产真融合与主调度纯调度底线；经 `node scripts/equip.mjs . --check && node scripts/compose-agents.mjs . --check`（`AGENTS.md < 24576 B`）及 `I249` 实测通过。
- [ ] C4: 从 797 行 `workflow-helpers.mjs` 拆出 `kit/skills/lib/pr-template-hydrate.mjs` (new) 并拆出 `kit/skills/lib/review-comment-render.mjs` (new)，全仓全部 `.mjs` 文件均 `<= 800` 行；新增 `scripts/dev/fixtures-attribution-routing.mjs` (new) 与 `scripts/dev/injections-data-attribution-routing.mjs` (new)（`I245–I249`），全矩阵覆盖 `github`/`generic-git`/`local-only` 三后端下 `claim/takeover/release`、`submit/rework`、`review pass/changes`（含 Case 2、Case 4 与外部 PR）、`merge` 及 `intake`（外部裸 URL、恶意与正常评论 5 态分诊），全量通过 `merge-gate`（`preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`、`sync-toc.mjs --check`、`verify-injections.mjs`）。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 新增 `fixtures-attribution-routing.mjs` 覆盖 C1–C4 全矩阵失败复现（Red） | `node scripts/dev/fixtures.mjs --domain attribution-routing` 必红 | SPEC 获批 |
| 2 | 拆出 `pr-template-hydrate.mjs` 与 `review-comment-render.mjs`，落地双层身份与 `formatAttribution` 并同步 `shared.mjs` 导出 | `node scripts/dev/preflight.mjs` 语法与边界通过 | 步骤 1 |
| 3 | 升级 `review-gates`、`review-ledger`、`review-sync`、`intake-triage.mjs` 与全套 `flow-*.mjs` 透传、中文标签及状态修复 | `node scripts/dev/fixtures.mjs --domain attribution-routing` 转绿 | 步骤 2 |
| 4 | 更新 7 份 `kit/skills/*/SKILL.md`、`templates/agents-project.md`、`SKILL.md`、`references/*`，重跑 `equip` 与 `compose-agents` | `equip.mjs . --check && compose-agents.mjs . --check && preflight.mjs` 通过 | 步骤 3 |
| 5 | 补齐 `injections-data-attribution-routing.mjs`（`I245–I249`）并对齐既有用例/注入点，执行全量 `merge-gate` | 全部 8 条 `merge-gate` 命令退出码 0 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 删除旧正则/旧标签导致既有用例或故障注入失效 | `fixtures-flow`、`fixtures-iterate-evolution`、`I145`/`I184`/`I219`/`I221` 命中旧符号 | 在 SPEC 改动清单预先纳入对齐改造，跑全量 `fixtures.mjs` 与 `verify-injections.mjs` 验证 |
| `workflow-helpers.mjs` / `workflow-policy.mjs` 超过 800 行门禁 | 直接在 797 行文件中追加逻辑 | 按 SPEC 先拆出 `pr-template-hydrate.mjs` 与 `review-comment-render.mjs` 再实现 |
| `review` 评论标签改动误删 `REVIEW_FIELDS` 导致 `preflight` 报错 | `buildReviewComments` 丢失 `审查来源` 或与四字段不在同段 | 保留 `审查来源` 与其它三字段同段，并在同段并列输出 `审查人`/`实施人`/`实证核验` |

## 回滚预案

- **出问题时的第一步**：`git status -sb` 检查工作树，未提交改动用 `git restore` 或 `git revert <commit>` 退回上一个绿灯基线
- **回滚用什么**：反向提交 `git revert` 并重跑 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .`
- **回滚之后要做什么**：运行全量 `merge-gate` 确认 `preflight`、`fixtures` 与 `verify-injections` 全绿

## 断点与遗留决策

- **当前状态**：`规划完成待 Critique`（已同步建立隔离工作位 `.worktrees/impl-w15-attribution-routing` 与规划分支 `feat/issue108-attribution-routing`）
- **待拍板事项**：无
- **下一步第一件事**：由独立规划审查者 `critic-108` 只读执行 `doc-plan.mjs audit` 与 Critique 审阅，通过后由人类/维护者 `approve` 再派实施者编码。

## 澄清与补充记录

- 已确认：Issue #108 正文与 2 条补充评论全部需求已冻结入 `SPEC` 与 `Todo`，无遗留待拍板项。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
