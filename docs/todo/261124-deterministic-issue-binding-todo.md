---
kind: todo
title: Case 2/3/4 开工确定性 Issue 绑定闭环
status: draft
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/deterministic-issue-binding
owner: plan-issue-bind
plan_mode: interactive
approved: false
done_at: null
task_id: deterministic-issue-binding
planned_at: 5c10a036ba96757b6af8b3fd6897860db9963122
related_prd: null
related_spec: ../specs/261124-deterministic-issue-binding-spec.md
---

# Case 2/3/4 开工确定性 Issue 绑定闭环

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/deterministic-issue-binding` @ `5c10a03` |
| 任务编号 | `deterministic-issue-binding` |
| 负责人 / 审批 | plan-issue-bind / `false` |
| 规划态 | `interactive`（单向门，与 SPEC 对齐） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `docs/specs/261124-deterministic-issue-binding-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-flow/scripts/{flow,flow-inspect,flow-start-helpers,flow-issues}.mjs`、`kit/skills/dev-flow/SKILL.md`、`references/collaboration.md`、`templates/agents-project.md`、`AGENTS.md`、`docs/TDD.md`、`docs/feature-map.json`、`scripts/dev/fixtures-*.mjs`、`scripts/dev/e2e-*.mjs`、`scripts/dev/blind-run-harness.mjs`、`scripts/dev/fixtures-issue-binding.mjs` (new)、`scripts/dev/injections-data-issue-binding.mjs` (new)
- **复用既有模块**：`createIssueForStart`（`flow-issues.mjs`）、`validateIssueBodyQuality` / `extractPlanDocContext`（`issue-quality.mjs`）、`hydrateIssueBody`（`issue-template-hydrate.mjs`）、`indexPlanDocs`（`plan-index.mjs`）、`evaluateTextSubstance`（`evidence-substance.mjs`）、`readDecisions`（`profile.mjs`）、`syncTaskDocsSafe` / `findMatchingDocStrict`（`flow-context.mjs`）
- **本期不做**：不为无 `SPEC`/`Todo` 的 `Case 2` 自动捏造占位工单；不对 `contributor-fork`/`clone-readonly` 建上游单；不放宽任何既有门禁；不在 `scripts/review.mjs` 硬编码额外取舍键白名单。
- **门型与回滚路径**：`one-way`；未合入前可丢弃分支与 worktree，已合入远端须通过反向提交回滚并重跑 `equip.mjs` / `compose-agents.mjs`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: `flow.mjs start` 对非豁免 `Case 2/3/4` 按「`--issue` -> `ledger` -> 关联 `SPEC`/`Todo`/`PRD`」复用已有工单不重复建单；`Case 3/4` 携带 `plan-index.mjs` 验真的 `SPEC`/`Todo`（或显式 `--create-issue`/`--body`/`--body-file`）自动经 `createIssueForStart` 走 `hydrateIssueBody -> validateIssueBodyQuality -> TaskBackend.createIssue` 建单并回写账本与文档 Frontmatter；无文档且无有效正文/单号的 `Case 2` 返回 `BLOCKED_MISSING_ISSUE_BINDING`（`EXIT.FACT = 3`）；`Case 1`/`--planning`/`--allow-plan-bootstrap`（无显式建单）/`--external-pr`/`contributor-fork`/`clone-readonly`/`no-auto-issue`/`--no-issue --reason` 正确豁免且可审计；`cli-parity.mjs`、`subcommand-parity.mjs` 与 `exit-code-parity.mjs` 零失败。
- [ ] C2: 全量 `scripts/dev/` 既有测试与 E2E 夹具（含 `fixtures.mjs --jobs 6`、`e2e-zip-harness.mjs`、`e2e-scenarios-evolution.mjs`、`e2e-scenarios-lifecycle.mjs`、`blind-run-harness.mjs`）诚实对齐新契约且不弱化任何门禁，退出码全部为 `0`。
- [ ] C3: `references/collaboration.md`、`kit/skills/dev-flow/SKILL.md`、`templates/agents-project.md`、`docs/TDD.md`、`docs/feature-map.json` 同步完毕，`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`（`0` 个「缺」）、`node scripts/dev/preflight.mjs`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict` 与 `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit .` 全绿。
- [ ] C4: 新增 `scripts/dev/fixtures-issue-binding.mjs` (new) 与 `scripts/dev/injections-data-issue-binding.mjs` (new) 覆盖全部正反边界与故障注入，`node scripts/dev/fixtures.mjs --domain issue-binding` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿，且改动后所有 `.mjs` 文件均 `<= 800` 行、零第三方依赖、零 emoji。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先编写失败夹具 `scripts/dev/fixtures-issue-binding.mjs` (new) | `node scripts/dev/fixtures.mjs --domain issue-binding` 必须红（Red） | SPEC 获批 |
| 2 | 落地 C1 核心状态机（`exit-codes.mjs`、`flow.mjs`、`flow-start-helpers.mjs`、`flow-inspect.mjs`、`flow-issues.mjs`） | `node scripts/dev/fixtures.mjs --domain issue-binding` 变绿且 `preflight.mjs` 参数/退出码/800 行全过 | 步骤 1 |
| 3 | 落地 C2 对齐全量 `scripts/dev/` 调用 `start --case 2\|3\|4` 的夹具与 E2E 剧本 | `fixtures.mjs --jobs 6`、`e2e-zip-harness.mjs`、`blind-run-harness.mjs` 全绿 | 步骤 2 |
| 4 | 落地 C3 文档/模板/地图同步与 C4 故障注入表 `scripts/dev/injections-data-issue-binding.mjs` (new)，跑 `equip`/`compose-agents` 与全链路门禁 | `preflight.mjs`、`verify-injections.mjs --jobs 4`、`review.mjs .`、`govern-audit.mjs audit . --strict`、`verify-tools.mjs audit .` 全绿 | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `flow-inspect.mjs` 超过 `800` 行红线 | 直接在 `handleStart` 内联绑定分支 | 核心状态机与豁免/检索逻辑全部放入 `flow-start-helpers.mjs`，保持 `flow-inspect.mjs <= 800` |
| 门禁拦截前误建孤儿 Issue | 先建单再运行 `plan-exit-gate` 或脏主仓检查 | 强制在 `runStartPlanGate`、`checkStartAuthorSeparation` 与 `checkStartMainCleanAndSlot` 通过后再调用 `resolveOrBindStartIssue` |
| `--allow-plan-bootstrap` 与 `--create-issue` 冲突 | 把 `--allow-plan-bootstrap` 一刀切跳过显式 `--create-issue` | 显式传入 `--create-issue` 时仍执行质量建单，仅隐式未带建单参数时豁免 |

## 回滚预案

- **出问题时的第一步**：运行 `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs --domain issue-binding` 定位退化点；未合并前直接丢弃隔离分支与 worktree。
- **回滚用什么**：已合并至 `main` 时使用 `git revert <merge-sha>` 反向提交并重跑 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .`。
- **回滚之后要做什么**：在关联 Issue/PR 评论说明回滚原因并重跑 `node scripts/dev/merge-gate.mjs` 确认基线恢复。

## 断点与遗留决策

- **当前状态**：`draft`（规划起草完毕，待 `doc-plan.mjs audit` 核验后移交独立 Critique 与 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：由独立 Critique 评审本 SPEC 与 Todo，获批后实施者转入实施认领并按 Red-Green 顺序推进。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
