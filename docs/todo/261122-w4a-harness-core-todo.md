---
kind: todo
title: "Wave 1: Harness 共享内核原语与多技能门禁收口"
status: active
created: 2026-11-22
updated: 2026-11-22
issue: null
pr: null
branch: feat/w4a-harness-core
owner: plan-harness
plan_mode: interactive
approved: false
done_at: null
task_id: w4a-harness-core
planned_at: b6ea3f6a2134373f8139ea581465e8024639e5c6
related_prd: ../prd/261122-w4-harness-and-evergreen-prd.md
related_spec: ../specs/261122-w4a-harness-core-spec.md
---

# Wave 1: Harness 共享内核原语与多技能门禁收口

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active` |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | `feat/w4a-harness-core` @ `b6ea3f6` |
| 任务编号 | `w4a-harness-core` |
| 负责人 / 审批 | `plan-harness` / `false` |
| 规划态 | `interactive`（已完成边界澄清，待 Critique 后批准开工） |
| 关联文档 | [Wave 4 总控 PRD](../prd/261122-w4-harness-and-evergreen-prd.md) · [Wave 1 SPEC](../specs/261122-w4a-harness-core-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch` 与所属 SPEC `C1..C5`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/harness-context.mjs` (new)、`kit/skills/lib/session-state.mjs` (new)、`kit/skills/lib/gate-enforcement.mjs` (new)、`kit/skills/lib/verify-state.mjs`、`kit/skills/dev-{explore,plan,edit,flow,review,iterate,verify-tools,govern}/`、`.agents/skills/`、`scripts/{survey,backup,equip,compose-agents,review}.mjs`、`templates/agents-project.md`、`references/collaboration.md`、`scripts/dev/fixtures-w4-harness.mjs` (new)、`scripts/dev/injections-data-w4-harness.mjs` (new)
- **复用既有模块**：`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/evidence-substance.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/handoff-package.mjs`
- **本期不做**：不改 `docs/TDD.md` 全景、不改 `docs/feature-map.json` 全量锚点、不改 `README.md`/`README.en.md`/`assets/readme/`
- **门型与回滚路径**：`one-way`；合入后须以单提交 `git revert` 回滚，严禁改写已推历史。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C1: 落地 `kit/skills/lib/harness-context.mjs` (new) 并完成 `doc-plan`/`flow`/`review` 角色与槽位硬锁接线，运行 `node scripts/dev/fixtures.mjs --domain w4-harness` 与 `node scripts/dev/preflight.mjs` 通过。
- [ ] C2: 落地 `kit/skills/lib/session-state.mjs` (new) 并完成 `S1–S4`、真实 `explored`、`plan-exit-gate`、`multi_spec`、全扫描 `pending-decisions`、`doc-substantive`、`PATH_PREFIX_RE` 与 `draft` 可见性接线，通过正反用例。
- [ ] C3: 落地 `kit/skills/lib/gate-enforcement.mjs` (new) 并完成 `review-pack`、`empirical-artifacts`、`edit-gate --final`、`flow-merge`、`flow-cleanup`、`iterate-cycle` 与轻量治理默认启用接线，通过正反用例。
- [ ] C4: 完成 `kit/skills/lib/verify-state.mjs` per-slot 缓存隔离、`govern-audit.mjs reconcile` 扫描 `kit/` 及地图缺口与 `govern-docs.mjs checkDocChurnStaleness` 修复，通过正反用例。
- [ ] C5: 同步 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .`（`AGENTS.md < 24576B`、`.mjs <= 800L`），补全 `scripts/dev/fixtures-w4-harness.mjs` (new) 与 `scripts/dev/injections-data-w4-harness.mjs` (new)（`I398–I409`），跑通全套 `preflight` / `gap-coverage` / `fixtures` / `bench --strict-budget` / `verify-injections` / `review.mjs .` / `govern-audit.mjs audit . --strict`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先写失败复现断言 `scripts/dev/fixtures-w4-harness.mjs` (new)（Red） | `node scripts/dev/fixtures.mjs --domain w4-harness` 必须红 | 无 |
| 2 | 实现 3 个共享内核原语与 `verify-state` / `dev-govern` 升级并完成薄接线（Green） | `node scripts/dev/fixtures.mjs --domain w4-harness` 转绿且 `.mjs <= 800L` | 步骤 1 |
| 3 | 执行 `equip.mjs .` / `compose-agents.mjs .` 并补 `I398–I409` 故障注入与全量门禁 | `preflight`、`fixtures`、`bench --strict-budget`、`verify-injections` 全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`规划待审`
- **待拍板事项**：无
- **下一步第一件事**：完成 Wave 1+Wave 2 独立 Critique 并批准后，运行 `flow.mjs start --task w4a-harness-core` 进入隔离槽位先写红测试。

## 澄清与补充记录

- 已确认（2026-11-22 · user）：按 #519 指令先执行 Red-Green 建夹具，再落地 4 共享原语、薄接线与 `I398–I409` 注入校验。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
