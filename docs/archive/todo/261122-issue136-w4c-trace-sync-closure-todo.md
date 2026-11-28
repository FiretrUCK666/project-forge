---
kind: todo
title: 修复远端规划追踪、同轮更新提交与结构化关单断裂
status: done
created: 2026-11-22
updated: 2026-11-22
issue: 136
pr: null
branch: feat/w4c-trace-sync-closure
owner: impl-w4c
plan_mode: autonomous
approved: true
done_at: 2026-11-22
task_id: w4c-trace-sync-closure
planned_at: 97fd8a64a0370b65dbb8d66316e10bfb3ae6b110
related_prd: null
related_spec: null
---

# 修复远端规划追踪、同轮更新提交与结构化关单断裂

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | `feat/w4c-trace-sync-closure` @ `97fd8a6` |
| 任务编号 | `w4c-trace-sync-closure` |
| 负责人 / 审批 | impl-w4c / `true` |
| 规划态 | `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #136 / 未关联 / 无 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/plan-sync.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/task-backend.mjs`、`kit/skills/lib/task-backend-local.mjs`、`kit/skills/lib/doc-comments.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`.agents/skills/`、`docs/feature-map.json`、`scripts/dev/fixtures*.mjs`
- **复用既有模块**：`createTaskBackend`、`updateLocalIssue`、`buildSubmitComments`、`parsePfStateTags`、`sha256Text`、`syncPlanPhaseToBackend`、`probeForWrite`
- **本期不做**：不重写 PR 模板水合引擎，不修改 `local-issues.mjs` 存储格式，不重构非相关 `dev-flow` 子命令
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: `doc-plan.mjs init` 传入全部生成文件列表 `files: res.files`；`PLAN_SYNC_PHASES` 补齐 `clarify`、`critique-continue`、`critique-override`、`supersede`、`plan-backfill` 并以含摘要/内容指纹的幂等键同步，且在 `doc-plan.mjs link` 与 `flow-inspect.mjs` 后绑定 `--issue` 时自动触发 `plan-backfill`；`github-client.mjs` / `task-backend.mjs` / `task-backend-local.mjs` 新增最小 `updateIssueBody` 并在 `plan-sync.mjs` 通过 `mergeManagedPlanSummary` 非破坏维护 Issue 正文托管摘要块（`github-client.mjs <= 800L`）。
- [x] C2: `flow-lifecycle.mjs` 仅传入 `isHeadUpdate: !isRework && hasExistingPr` 至 `buildSubmitComments`（`flow-lifecycle.mjs <= 800L`）；`doc-comments.mjs` 在 `isHeadUpdate === true` 时渲染 `### 提交更新（Round ${round} · HEAD 更新 @ \`${shortHead}\`）` 并双写 PR 与关联 Issue，不重复发 `提交待审（Round 1）`。
- [x] C3: `flow-issues.mjs` 与 `flow.mjs` 增设 `close --issue N [--into targetIssue] --reason "..." [--task taskId] [--json]` 并在 `printHelp()` 准确声明通过 `cli-parity.mjs`，调用 `doc-comments.mjs` 新增 `buildIssueCloseComment`（含 `<!-- pf-state:... -->` 锚点）兼容 GitHub 与本地后端。
- [x] C4: 运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`，按需校准 `docs/feature-map.json`（`verify-tools.mjs audit .` `StaleTools: 0`），并在 `scripts/dev/fixtures*.mjs` 补齐正反双向测试与故障注入且全套门禁通过（全部 `.mjs <= 800L`）。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 核对受影响文件行数与边界，补充或确认复现用例基准 | `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit . --json` | 无 |
| 2 | 实施 `C1`（规划全节点同步、后绑回补、非破坏 Issue 摘要块）与 `C2`（同轮 HEAD 更新提交区分） | `node scripts/dev/fixtures.mjs --jobs 6` | 步骤 1 |
| 3 | 实施 `C3`（`flow.mjs close` 与 `buildIssueCloseComment`）与 `C4`（`equip` 同步、feature-map、双向夹具与全套门禁） | 全套 `preflight` / `cli-parity` / `fixtures` / `verify-injections` / `govern-audit` | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：运行 `doc-plan.mjs audit . --json`、`flow.mjs start`、`flow.mjs claim` 与 `flow.mjs explore`，随后按 `C1..C4` 实施并补齐正反双向验证。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node scripts/dev/preflight.mjs`（40 项读数 0 失败）、`node scripts/dev/preflight-kernel-parity.mjs`、`node scripts/dev/cli-parity.mjs`、`node scripts/dev/exit-code-parity.mjs`、`node scripts/dev/gap-coverage.mjs` 全部通过。
  - `node scripts/dev/fixtures.mjs --jobs 6`（439 项通过，0 项失败）、`node scripts/dev/verify-injections.mjs --jobs 6`（353 条故障注入全部抓红，含新增 `I410`–`I416`）、`node scripts/dev/e2e-zip-harness.mjs`（224 条包条目场景 A–L 全通）、`node scripts/dev/bench.mjs --strict-budget`（6/6 项通过）。
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --task w4c-trace-sync-closure --mode verify --final --json`（blockers=0）、`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit .`（Status=OK, StaleTools=0）、`node .agents/skills/dev-plan/scripts/doc-plan.mjs audit . --json`（failedCount=0）。
- **文档同步检查**：已同步 `docs/TDD.md`、`kit/skills/dev-flow/SKILL.md`、`.agents/skills/`（`equip.mjs .`）与 `docs/feature-map.json`（`StaleTools: 0`）；本改动不涉及 `README.md` / `README.en.md` 用户使用章节。
- **遗留问题**：无。
