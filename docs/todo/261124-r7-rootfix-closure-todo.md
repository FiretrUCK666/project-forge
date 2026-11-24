---
kind: todo
title: Round-7 盲测 10 项跨项目架构级根因统一根治
status: draft
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/r7-rootfix-closure
owner: plan-r7-rootfix
plan_mode: interactive
approved: false
done_at: null
task_id: r7-rootfix-closure
planned_at: 0b6164668524df0dd0e532f7c477422a76b1870f
related_prd: null
related_spec: ../specs/261124-r7-rootfix-closure-spec.md
---

# Round-7 盲测 10 项跨项目架构级根因统一根治

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/r7-rootfix-closure` @ `0b61646` |
| 任务编号 | `r7-rootfix-closure` |
| 负责人 / 审批 | plan-r7-rootfix / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `docs/specs/261124-r7-rootfix-closure-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/critique-rounds.mjs`、`kit/skills/lib/critique-diff.mjs` (new)、`kit/skills/lib/critique-store.mjs`、`kit/skills/lib/plan-index.mjs`、`kit/skills/lib/plan-exit-gate.mjs`、`kit/skills/lib/plan-next.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/lib/doc-template-render.mjs`、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/pending-decisions.mjs`、`kit/skills/lib/doc-requirements.mjs`、`kit/skills/lib/session-state.mjs`、`kit/skills/lib/issue-template-hydrate.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/static-gates-assertions.mjs` (new)、`kit/skills/lib/task-backend-local.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/templates/docs-todo.md`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`doc-plan-ops.mjs`、`doc-audit.mjs`、`doc-audit-helpers.mjs`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`flow-start-helpers.mjs`、`flow-merge.mjs`、`kit/skills/dev-review/scripts/review-diff.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`scripts/handoff.mjs`、`scripts/lib/review-helpers.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/review.mjs`、`scripts/survey.mjs`、`scripts/equip.mjs`、`scripts/dev/bench.mjs`、`scripts/dev/fixtures-r7-rootfix.mjs` (new)、`scripts/dev/injections-data-r7.mjs` (new)、`docs/TDD.md`、`docs/feature-map.json`、`references/docs-set.md`。
- **复用既有模块**：`kit/skills/lib/doc-approval.mjs`（`APPROVING_STATUS`、`isApprovingStatus`）、`kit/skills/lib/markdown-scan.mjs`（`scanLines`、`fencedSpans`）、`kit/skills/lib/overlay.mjs`（`scanExtensionSlotHazards`）、`kit/skills/lib/git.mjs`（`inspectBranchMergeState`、`resolveDefaultBranch`、`isInsideDir`）。
- **本期不做**：不引入任何 AI 宿主特定绑定或单仓特例硬编码；不自动改写目标仓 `.eslintrc*` / `ruff.toml` / `pyproject.toml` / `.markdownlint*`；不改动 `kit/skills/dev-review/scripts/review-locks.mjs` 既有代码审查锁契约。
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: `critique-rounds.mjs` + `critique-diff.mjs` (new) + `critique-store.mjs` + `doc-plan.mjs` 实现严重度分层（仅含 `minor` 硬拒 `critique-reject` 报 `BLOCKED_NON_BLOCKING_REJECT` 并引导 `critique-pass --should-fix`）、R2+ 正文对比区间锁（禁止对未动旧行/旧章节开阻塞刺，报 `BLOCKED_OUT_OF_SCOPE_CRITIQUE`）、条目级 `--resolved`/`--rebut-accepted` 与防跳轮校验（`BLOCKED_CRITIQUE_ROUND_GAP`），同步 `kit/skills/dev-plan/SKILL.md` 与 `references/docs-set.md`。
- [ ] C2: `plan-index.mjs` 抽 `resolveLinkedPlanGraph`、`doc-audit.mjs` 对 `APPROVING_STATUS` PRD 强校审批依据、`approveSpec` 强校 `related_prd` 就绪（`BLOCKED_MASTER_PRD_CRITIQUE_UNREADY`）、修正 PRD `critique-pass` 下一步为 `approve`、注册 `doc-plan.mjs note` 至 `kit/skills/lib/subcommand-meta.mjs`/`printHelp()`/`kit/skills/dev-plan/SKILL.md`、`plan-next.mjs` 在 `plan-only-handoff` 校验全图就绪、Case 4 Todo 初始 `status: draft` 并在 SPEC `approve` 原子激活（同步校验并修复受影响既有测试夹具）。
- [ ] C3: `doc-audit.mjs` / `doc-audit-helpers.mjs` 实现活跃+归档双态路径解析并隔离元信息概览表 Git 分支名（`docs/` 前缀分支）；`doc-audit-helpers.mjs` 与 `doc-substantive.mjs` 统一先剥除代码围栏与行内反引号再检尖括号占位与正文实质性；`pending-decisions.mjs` 对齐 `doc-requirements.mjs` 的 `风险与开放问题` 章节并识别「无。+ 补充说明」。
- [ ] C4: `session-state.mjs` 修复 `unconsumedFresh` 跨任务误杀并在终态闭合消费；`issue-template-hydrate.mjs` 在 `matchedCount === 0` 时强制追加兜底正文；`flow-inspect.mjs` / `flow-start-helpers.mjs` 在 `--planning` 不预填 `git user.name` 为 `implementerId`、多代理晋升缺 `--agent` 报错引导 `BLOCKED_MISSING_ACTOR`；`flow-merge.mjs` / `task-backend-local.mjs` 在 `generic-git` 合后同步干净本地默认分支并消除清理清单 `(unmerged)` 误报。
- [ ] C5: `scripts/handoff.mjs` 抽 `isForgeOwnedPath` 并按 Git 跟踪 `120000` 与 `.gitignore` 分层过滤（保留未跟踪越界/悬空软链与 PF 所属异常软链退出码 `3` 拦截）；`scripts/lib/review-helpers.mjs` 泛化 `checkEslintAgentsIgnore` 为跨生态 `detectToolingAgentsIgnoreGaps`（ESLint、Ruff、mypy、pyright、pre-commit、markdownlint）并在 `review.mjs`、`survey.mjs`、`equip.mjs` 非侵入提示，保留 `kit.eslint-agents-ignore` 兼容 ID。
- [ ] C6: 新建 `kit/skills/lib/static-gates-assertions.mjs` (new) 并在 `static-gates.mjs` 导出分家族 `hasBehavioralAssertion`（覆盖 `tape`/`tap`/`ava`/`node:test`、Python `self.assert*`、Ruby `assert_*`/`refute_*`、PHP `$this->assert*`、Swift `#expect`/`#require`，严拒 `t.plan`/`t.end` 空壳）并接入 `test-inventory.mjs` / `govern-tests.mjs` / `edit-gate.mjs`；`review-diff.mjs` 全新增行扫描提示词注入/双向字符；`survey-docs.mjs` 增补 PR 工作流裸 `npm install` 与缺最小 `permissions` 审计提示；`scripts/dev/bench.mjs` 拆解 `strictBudget` 与 `runawayCapMs`（零环境变量分支）；`verify-tools.mjs` 新增 `run --stale` 批量实跑刷新基线并在合后清零主仓 `slots.main` 16 项旧基线。
- [ ] C7: 新增 `scripts/dev/fixtures-r7-rootfix.mjs` (new) 与 `scripts/dev/injections-data-r7.mjs` (new)（同时更新 `injections-data-kernel-dedup.mjs` 与 `injections-data-iterate-evolution.mjs`），更新 `docs/TDD.md`、`docs/feature-map.json`、`references/`，运行 `equip.mjs .` 与 `compose-agents.mjs .`，全部 `.mjs <= 800` 行，跑通 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`bench.mjs`、`e2e-zip-harness.mjs`、`verify-injections.mjs --jobs 4` 与 `merge-gate.mjs` 全部退出码 `0`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 注册 `exit-codes.mjs`、`subcommand-meta.mjs`，编写 `fixtures-r7-rootfix.mjs` (new) 失败用例 | `node scripts/dev/fixtures.mjs --domain r7-rootfix` 必须红 | 无 |
| 2 | 实施 C1 + C2 + C3（规划 Critique、关联图就绪与审计隔离）并拆出 `critique-diff.mjs` (new) | `node scripts/dev/fixtures.mjs --domain r7-rootfix` C1..C3 变绿 | 步骤 1 |
| 3 | 实施 C4 + C5 + C6（流转修复、软链/探测表、跨生态断言/diff 扫描/`bench`/`verify-tools run --stale`）并拆出 `static-gates-assertions.mjs` (new) | `node scripts/dev/fixtures.mjs --domain r7-rootfix` 与 `node scripts/dev/bench.mjs` 变绿 | 步骤 2 |
| 4 | 补齐 `injections-data-r7.mjs` (new)、同步 `docs/TDD.md` / `docs/feature-map.json` / `references/`、运行 `equip.mjs .` 与 `compose-agents.mjs .`、全量门禁复核 | `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0` | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `critique-rounds.mjs` / `doc-plan.mjs` / `flow-inspect.mjs` / `static-gates.mjs` / `survey-docs.mjs` 突破 800 行 | 直接在原文件堆叠新逻辑 | 新增纯函数一律拆入 `critique-diff.mjs` (new)、`flow-start-helpers.mjs`、`static-gates-assertions.mjs` (new) 或 `survey-docs.mjs` 同级辅助函数 |
| 既有夹具中 `status: active` PRD 或 `bench.mjs` 注入锚点不兼容 | `doc-audit` 强校 PRD `APPROVING_STATUS` 或 `computeCheckBudget` 签名/公式变化 | 实施时逐一运行全量 `fixtures.mjs` 与 `verify-injections.mjs`，同步修正缺失 `plan_critique: passed` 的合成夹具与 `I385` 等注入向量 |
| Case 4 Todo 初始 `draft` 影响既有单测断言 | 现有测试假设 `init --kind pair` 产出 `status: active` Todo | 实施前核查 `fixtures-doc-*.mjs` 并按 Case 4 语义同步对齐断言，Case 3 独立 Todo 保持 `active` |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：在隔离实施工作树按 `C1..C7` 先补 `scripts/dev/fixtures-r7-rootfix.mjs` (new) 失败复现用例，再逐域落地改造并跑通全量门禁。

## 澄清与补充记录

- 已确认（2026-11-24 · pre-plan）：Round-7 10 项根因均已完成源码现场核查，拆解为 `C1..C7` 交由独立隔离实施代理落地。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
