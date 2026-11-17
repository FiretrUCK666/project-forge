---
kind: todo
title: 修复规划文档骨架裁光、形态探测、审计退化与归档隔离
status: done
created: 2026-11-18
updated: 2026-11-18
issue: 56
pr: 65
branch: feat/doc-shape-depth
owner: FiretrUCK666
approved: true
done_at: 2026-11-18
task_id: issue-56
planned_at: a0a57a94e091d8e0907958566f1e3a7b855ca3be
related_prd: ../../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261118-issue56-doc-shape-depth-spec.md
---

# 修复规划文档骨架裁光、形态探测、审计退化与归档隔离

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | `feat/doc-shape-depth` @ `a0a57a9` |
| 任务编号 | `issue-56` |
| 负责人 / 审批 | planner-56 / `false` |
| 关联 Issue / PR / SPEC | #56 / 未关联 / `docs/archive/specs/261118-issue56-doc-shape-depth-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交，并在编码前确认 `docs/archive/specs/261118-issue56-doc-shape-depth-spec.md` 已通过独立 Critique 与 `approved: true`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/doc-shape.mjs` (new)、`kit/skills/lib/doc-substantive.mjs` (new)、`kit/skills/lib/doc-frontmatter.mjs` (new)、`kit/skills/lib/doc-comments.mjs` (new)、`kit/skills/lib/doc-template-render.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/lib/doc-requirements.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/templates/docs-prd.md`、`kit/skills/templates/docs-spec.md`、`kit/skills/templates/docs-todo.md`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-plan/SKILL.md`、`scripts/dev/fixtures-doc-depth.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/fixtures-docs.mjs`、`scripts/dev/fixtures-flow-state.mjs`、`scripts/dev/injections-data.mjs`、`docs/TDD.md`
- **复用既有模块**：`kit/skills/lib/tdd-shape.mjs`（形态探测对照设计）、`kit/skills/lib/tool-owned.mjs`（`isToolOwnedPath`）、`kit/skills/lib/git.mjs`（`gitLsFilesTextAndCode`、`writeAtomic`）、`kit/skills/lib/profile.mjs`（`parseAgentsProfile`、`resolveAuthoritativeTddPath`）、`kit/skills/lib/pending-decisions.mjs`（`analyzePendingDecisions`）、`kit/skills/lib/doc-template-render.mjs`（`applySectionPolicy`）
- **本期不做**：不重做 #50 C5/C8/C9/C10（治理 PRD、活跃组跨日同 slug 互认、`docs-tdd.md`/`tdd-shape.mjs`、`checkOrphanSlices`）；不设最小字数阈值；不修改 `triage-rules.mjs` 与 `dev-review` 包；不引入第三方依赖
- **门型与回滚路径**：one-way；独立分支 `feat/doc-shape-depth` 实施，出现偏差可整分支丢弃或通过 git revert 逐模块回退，严禁修改既有 `docs/archive/` 数据
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。与 `docs/archive/specs/261118-issue56-doc-shape-depth-spec.md` 保持 1:1 严格一致。

- [x] C1: （`init` 骨架保留与开箱自洽）在 3 文件 Go CLI 临时仓及多生态仓执行 `doc-plan.mjs init --kind prd|spec|todo|pair|all` 时，默认 `pruneUnfilled: false` 保留当前形态适用的可选节（`spec` 含 `design`/`alternatives`/`breakdown`/`door`/`implementation`/`clarifications`、`todo` 含 `steps`/`risk`/`rollback`/`breakpoint`/`clarifications`、`prd` 含 `flow`/`reuse`/`pending`/`door`/`clarifications`），传入 `--no-prune` 时保留模板全部可选节；`spec` 正确渲染 `NON_GOALS`、`REUSABLE`、合法 Markdown 表格 `MODULES`（`| ... |`）及条件化 `{{TDD_REF}}`（无 `docs/TDD.md` 时零 `HALLUCINATED_PATH`、零 `待补齐` 残余，有 `docs/TDD.md` 时保留有效路径）；`govern-docs.mjs --write-todo` 与直接调用 `renderDocTemplate(kind, { vars })` 仍保持 `pruneUnfilled: true` 向后兼容。
- [x] C2: （工作区形态探测与可复核跳过说明）`kit/skills/lib/doc-shape.mjs` (new) 基于实时工作区证据探测 `authRoles`/`stateRules`/`uiFrontend`/`ciRollout`/`cliEntry`/`multiCollab`（零硬编码仓库名，严守 `kit/**` 架构边界）：3 文件 Go CLI 仓跳过不适用的 `users`（`roles`）/`rules`/`rollout`/`coordination` 并写入 `<!-- doc-shape-skipped: ... -->` 与人类可复核摘要且被 `doc-audit` 放行；含鉴权/状态机/前端/CI 发布文件的仓则自动保留对应可选节；`FORM_INDEPENDENT_CORE` 与自定义模板 `required_sections` 永不被跳过（强行写入跳过注释时 `doc-audit` 报 `DOC_SKIP_INVALID_SECTION` 阻断）。
- [x] C3: （核心实质性与非字数型跨轮防退化）`kit/skills/lib/doc-substantive.mjs` (new) + `doc-requirements.mjs` + `doc-audit.mjs` 拦截核心/设计节中的 `待补齐`、`PLACEHOLDER_TEXT_RE` 占位词、`暂无`、`暂缺`、裸 `无`（包含 `- **本期不做**：待补齐`）以及无技术锚点或明确排除对象的纯套话（如「提升体验、优化功能、确保稳定」），**不使用最小字数或字符数下限**（含真实路径/命令/符号/排除依据的短文本如 `- **本期不做**：不动 \`scripts/survey.mjs\`` 通过）；跨轮编辑对比 `HEAD:{relDoc}` / `critique_anchors` / `baselineText` 时，把已填核心节改回空话/清空或静默删减技术锚点必报 `DOC_REGRESSION_CORE_EMPTIED` / `DOC_REGRESSION_ANCHOR_LOST`，并在 `auditDoc` 返回结构化 `delta`（`anchorsAdded`、`anchorsRemoved`、`pendingResolved`）。
- [x] C4: （互链继承、澄清落盘、归档隔离与总控 PRD 归档覆盖）`doc-plan.mjs init --kind todo --spec {specPath}` 自动继承 `related_prd` 并回写父 `related_todo`（同时支持 `--prd` 且不覆写 `1:N` 共享总控 PRD 元信息）；`doc-plan.mjs clarify` 向 `## 澄清与补充记录` 写入已确认需求后 `doc-audit` 退出 `0` 且不触发 `BLOCKED_PENDING_DECISIONS`；`collectSiblingSet` / `syncDocsLifecycle` / `archiveCompletedDocsGroup` 在存在同 `slug` 其他 `issue`/任务（含 `issue: null`）的历史归档文档时，使其保持字节级不变且 `byKind` 返回当前归档路径（同时保持活跃组跨日同 `slug` 互认）；`checkMasterPrdCoverage` 同步扫描 `docs/specs/` 与指向当前总控 PRD 的 `docs/archive/specs/`（排除非关联历史归档 SPEC），使已归档 `#49`/`#55`/`#57` 切片后仓内执行 `doc-plan.mjs audit .` 退出 `0`。
- [x] C5: （双向夹具、故障注入 `I139..I142` 与全量门禁）在 `scripts/dev/fixtures-doc-depth.mjs` (new) 补齐 `C1..C4` 正反双向用例（与 `#50` C5/C8/C9/C10 零重叠）并在 `scripts/dev/fixtures.mjs` 注册 `--domain doc-depth`；在 `scripts/dev/injections-data.mjs` 追加 `I139..I142` 验证全红；全部新增及修改的 `kit/skills/**/*.mjs` 与 `scripts/dev/fixtures-*.mjs` 单文件不超过 `800` 行、`kit/skills/dev-plan/SKILL.md` 不超过 `180` 行；同步 `docs/TDD.md` 与 `node scripts/equip.mjs . --check` 并全量通过 `node scripts/dev/preflight.mjs`、`node scripts/dev/gap-coverage.mjs`、`node scripts/dev/fixtures.mjs`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`、`node scripts/sync-toc.mjs README.md README.en.md --check` 与 `node scripts/dev/verify-injections.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先编写 `scripts/dev/fixtures-doc-depth.mjs` (new) 覆盖 `C1..C4` 失败复现用例并注册 `doc-depth` 域（Red） | `fixtures.mjs --domain doc-depth` 在当前基线稳定失败 | SPEC 获批 |
| 2 | 拆出 `doc-frontmatter.mjs` (new) 与 `doc-comments.mjs` (new)，新增 `doc-shape.mjs` (new) 与 `doc-substantive.mjs` (new) | `node scripts/dev/preflight.mjs` 架构边界与语法全过 | 步骤 1 |
| 3 | 改造 `doc-template-render.mjs`、`doc-templates.mjs`、`doc-requirements.mjs`、`docs.mjs`、`shared.mjs`、三份 `kit/skills/templates/docs-*.md`、`doc-plan.mjs`、`doc-audit.mjs`、`kit/skills/dev-plan/SKILL.md` | `fixtures.mjs --domain doc-depth` 全绿，且本仓 `doc-plan.mjs audit .` 退出 `0` | 步骤 2 |
| 4 | 同步清理 `fixtures-docs.mjs` 与 `fixtures-flow-state.mjs` 中旧 `- 无` 占位、追加 `I139..I142`、更新 `docs/TDD.md` 并执行 `equip` 同步 | 全量 `merge-gate`、`equip --check`、`verify-injections` 与 `govern-audit audit . --changed --strict` 全绿 | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`（已按 C1..C5 完成实现与门禁验证，待 `finalize`/`verify`/`submit` 提交审查）
- **待拍板事项**：无
- **下一步第一件事**：在独立审视上下文完成 PR 审查并由审查者合入。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/dev/preflight.mjs`：通过，0 项失败（33 项读数）
  - `node scripts/dev/gap-coverage.mjs`：通过，19 条均有真实处置
  - `node scripts/dev/fixtures.mjs`：全量 243 项通过 / 0 项失败（含 `--domain doc-depth` 4/4、docs 7/7、doc-shapes 12/12、doc-rules 15/15、flow-state 7/7）
  - `node scripts/dev/verify-injections.mjs --jobs 4`：151 条判据全部拦截（含 `I139..I142`）
  - `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .`：9 份活跃文档与 `docs/prd/261117-v8-criteria-trust-prd.md` 覆盖率全部通过（退出码 0）
  - `node scripts/equip.mjs . --check` / `compose-agents.mjs . --check` / `review.mjs .` / `sync-toc.mjs README.md README.en.md --check`：全绿
- **文档同步检查**：已同步 `docs/TDD.md`、`kit/skills/dev-plan/SKILL.md` 及 `.agents/skills/`（`equip.mjs .` 一致）；全部 `kit/skills/**/*.mjs` 与 `scripts/dev/fixtures-*.mjs` <= 800 行（`doc-audit.mjs` 787 行、`doc-plan.mjs` 766 行、`SKILL.md` 75 行）
- **遗留问题**：无
