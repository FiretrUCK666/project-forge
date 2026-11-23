---
kind: todo
title: dev-iterate 确定性重构与跨门禁单源统一
status: active
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/r6-arch-plan
owner: plan-r6-arch
plan_mode: interactive
approved: true
done_at: null
task_id: r6c-iterate-unified-gates
planned_at: 1853e2257b47936b97aed07377c98d2d7a117bb8
related_prd: ../prd/261124-r6-arch-hardening-prd.md
related_spec: ../specs/261124-r6c-iterate-unified-gates-spec.md
---

# dev-iterate 确定性重构与跨门禁单源统一

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/r6-arch-plan` @ `1853e22` |
| 任务编号 | `r6c-iterate-unified-gates` |
| 负责人 / 审批 | plan-r6-arch / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `../specs/261124-r6c-iterate-unified-gates-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/{static-gates,verify-state,test-inventory,signals,escalation}.mjs`、`kit/skills/dev-iterate/scripts/{iterate,iterate-cycle}.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-review/scripts/review-*.mjs`、`kit/skills/dev-govern/scripts/govern-*.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`scripts/dev/fixtures-r6c-gates.mjs` (new)、`scripts/dev/injections-data-r6c.mjs` (new)
- **复用既有模块**：`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/symbol-index.mjs`、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/verify-state.mjs`
- **本期不做**：不改动 `edit-gate`/`review-context`/`govern-state` 中的默认分支切换（留给 Wave 2 `r6d`）；不改动切片 A/B/D 专属文件
- **门型与回滚路径**：one-way；`git revert <sha>` 回退。
- **快测命令**：`node scripts/dev/fixtures.mjs --domain r6c-gates`

## 验收标准与执行清单

- [ ] C9: 修复 `iterate.mjs` 漏导 `printNextStep`、`extractSymbols` 参数错位、`resolveNativeTestDir` 漏传与 `slugTestToken` 边界；抽象多栈 `resolveTestRunner` 并区分 `missing-runner`。
- [ ] C10: 净化 `signals.jsonl` 推荐、统一 `configuredTestEntries` 与 `fixtures-*.mjs` 识别、`generate --write` 隔离拦截、落实 A2 默认 `--escalate: true`（支持 `--no-escalate`）及 `cycle` 持久化累加停损。
- [ ] C11: 跨门禁统一 `countTextLines`、`isLegalArchiveMove` 与 `resolveOversizedExemption`；修复 `edit-gate` `reviewWorktreePath` 与终态归档；保留 `check-empirical` 在 `--include-diff` 之前而将 `check-fault` 收敛至 `record`；JSON 仅存 1 份 `contextBrief` 且 `evaluateToolStaleness` 提速至 `<500ms`；`verify-tools` `scratch/` 豁免。
- [ ] C12: 修复 `review-ledger.mjs` Round 3 `--reason`、透传 `baseLedger.rebuts`、低风险单会话记录与 `generic-git` `awaiting-remote-mr` 指引，并通过正反夹具与故障注入。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写 `scripts/dev/fixtures-r6c-gates.mjs` (new) 复现 `iterate` 崩溃、800/801 分裂、`review-pack` 重复序列化与 Round 3 漏口 | `node scripts/dev/fixtures.mjs --domain r6c-gates` 必红 | 无 |
| 2 | 改造 `static-gates.mjs`、`verify-state.mjs`、`test-inventory.mjs`、`signals.mjs`、`iterate*.mjs`、`verify-tools.mjs` | `node scripts/dev/fixtures.mjs --domain r6c-gates` 部分转绿 | 步骤 1 |
| 3 | 收口 `edit-gate.mjs`、`review-*.mjs`、`govern-*.mjs` 并补 `injections-data-r6c.mjs` (new) | `node scripts/dev/preflight.mjs` 与 `verify-injections.mjs` 全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `iterate.mjs run` 默认 `--escalate` 在只读环境误建单 | 无写权限或 dry-run 失败 | 支持 `--no-escalate` 开关，并在无写权限时安全降级本地事件日志 |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：在隔离 `.worktrees/impl-r6c-iterate-unified-gates` 先写 `scripts/dev/fixtures-r6c-gates.mjs` (new) 复现 Red 用例。

## 澄清与补充记录

- 已确认（2026-11-24 · user）：A2: `dev-iterate run` 失败升级默认值 -> A2 已拍板：`dev-iterate run` 默认开启失败自动升级建单（`--escalate` 默认 `true`，支持 `--no-escalate` 关闭），由切片 C 实现并在切片 D 同步文档。

## 完成后的记录

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
