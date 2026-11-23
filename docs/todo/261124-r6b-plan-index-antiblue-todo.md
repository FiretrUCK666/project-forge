---
kind: todo
title: 单源规划索引防重、双向正文投影与 Critique 防注水
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
task_id: r6b-plan-index-antiblue
planned_at: 1853e2257b47936b97aed07377c98d2d7a117bb8
related_prd: ../prd/261124-r6-arch-hardening-prd.md
related_spec: ../specs/261124-r6b-plan-index-antiblue-spec.md
---

# 单源规划索引防重、双向正文投影与 Critique 防注水

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/r6-arch-plan` @ `1853e22` |
| 任务编号 | `r6b-plan-index-antiblue` |
| 负责人 / 审批 | plan-r6-arch / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `../specs/261124-r6b-plan-index-antiblue-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/plan-index.mjs` (new)、`kit/skills/lib/{doc-slice-graph,docs,doc-substantive,doc-verify,critique-rounds,context-brief,handoff-package,session-state,session-orient,plan-next,plan-sync,intake-triage}.mjs`、`kit/skills/dev-plan/scripts/*.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`、`scripts/dev/fixtures-r6b-plan.mjs` (new)、`scripts/dev/injections-data-r6b.mjs` (new)
- **复用既有模块**：`kit/skills/lib/doc-frontmatter.mjs`、`kit/skills/lib/critique-store.mjs`、`kit/skills/lib/doc-locator.mjs`
- **本期不做**：不改 `doc-plan-ops.mjs:297` 默认分支白名单（留给 Wave 2 `r6d`）；不改 `plan-exit-gate.mjs` 与切片 A/C/D 专属文件
- **门型与回滚路径**：one-way；`git revert <sha>` 回退。
- **快测命令**：`node scripts/dev/fixtures.mjs --domain r6b-plan`

## 验收标准与执行清单

- [ ] C5: 新建唯一 `kit/skills/lib/plan-index.mjs` (new) 替换 `collectPlanDocs`/`collectCandidateDocs`/`listDocs`，消除 `session-orient.mjs` 反向导入并拦截同 `slug`/`issue` 重复建档（`BLOCKED_DUPLICATE_PLAN_DOC`）。
- [ ] C6: `approveSpec` 原子联动配套 Todo 设为 `active`；实现 `syncPlanDocBodyMeta` 并切换 `flow-lifecycle-finalize.mjs` 同步正文表；落实 A1 对齐 `doc-plan.mjs` Case 3 Todo 自检直通。
- [ ] C7: 改造 `context-brief.mjs`、`handoff-package.mjs`、`repo-map.mjs` 落地单源指针简报与按角色裁剪；补链 `plan-next --handoff` 与 `critique-scope`；`verifyDocClaims` 在 `critique-scope` 默认静态校验并原生回显 `findings`/`priorRounds`。
- [ ] C8: 新增 `session-state.mjs` `preInit` 缓冲与 `doc-plan.mjs note`；`resolveBaselineSnapshotSync` 接入 `plan-critique-state.json`；回归永恒客观防退化底线（去掉魔数比率），通过 `fixtures` 与 `verify-injections`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写 `scripts/dev/fixtures-r6b-plan.mjs` (new) 复现重复建档、`approveSpec` 遗漏 Todo、`critique-scope` 挂起与丢失 `findings` | `node scripts/dev/fixtures.mjs --domain r6b-plan` 必红 | 无 |
| 2 | 落地 `plan-index.mjs` (new) 替换 3 套旧扫描器、实现 `syncPlanDocBodyMeta`、`approveSpec` 联动与 `preInit` 缓冲 | `node scripts/dev/fixtures.mjs --domain r6b-plan` 部分转绿 | 步骤 1 |
| 3 | 完成指针简报协议、按角色裁剪、`critique-scope` 静态校验、客观防退化底线与 `injections-data-r6b.mjs` (new) | `node scripts/dev/preflight.mjs` 与 `verify-injections.mjs` 全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 替换 3 套旧扫描器时遗漏工作树路径兼容字段 | `plan-next.mjs` 或 `doc-slice-graph.mjs` 调用方读取特有属性 | 在 `plan-index.mjs` (new) 保留统一规范字段并跑全量 `fixtures.mjs` 验证零回归 |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：在隔离 `.worktrees/impl-r6b-plan-index-antiblue` 先写 `scripts/dev/fixtures-r6b-plan.mjs` (new) 复现缺陷。

## 澄清与补充记录

- 已确认（2026-11-24 · user）：A1: 非平凡 Case 3 Todo 的 Critique 口径 -> A1 已拍板：非平凡 Case 3 Todo 统一为「自检直通，Critique 仅建议（不强制）」，由切片 B 对齐 `doc-plan.mjs`，切片 D 同步校准 `docs/TDD.md` 与 `kit/skills/dev-plan/SKILL.md`。

## 完成后的记录

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
