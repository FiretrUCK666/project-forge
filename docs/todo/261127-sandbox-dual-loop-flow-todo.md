---
kind: todo
title: 隔离沙箱双环工作树与真实差分晋升流水线
status: draft
created: 2026-11-27
updated: 2026-11-27
issue: null
pr: null
branch: feat/sandbox-dual-loop-v1
owner: plan-sandbox-v1
plan_mode: interactive
approved: false
done_at: null
task_id: sandbox-dual-loop-flow
planned_at: 5feb0dbff6d86a217c45d74e44fe6949a35f912c
related_prd: ../prd/261127-sandbox-dual-loop-v1-prd.md
related_spec: ../specs/261127-sandbox-dual-loop-flow-spec.md
---

# 隔离沙箱双环工作树与真实差分晋升流水线

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/sandbox-dual-loop-v1` @ `5feb0db` |
| 任务编号 | `sandbox-dual-loop-flow` |
| 负责人 / 审批 | plan-sandbox-v1 / `false` |
| 规划态 | `interactive`（架构决策已拍板，待 Critique 与审批） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `docs/specs/261127-sandbox-dual-loop-flow-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-flow/scripts/flow-sandbox.mjs` (new)、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/harness-context.mjs`、`kit/skills/lib/mutability.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/lib/workflow-policy-next.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-start-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`scripts/dev/fixtures-sandbox-dual-loop.mjs` (new)、`scripts/dev/injections-data-sandbox-flow.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-flow/scripts/flow-start-helpers.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/git.mjs`
- **本期不做**：不修改 Wave 1 策略核心；不修改 Wave 3 的 `triage`、模板、文档与 `SKILL.md`。
- **门型与回滚路径**：one-way；须独立审查与两阶段故障注入；回滚用 `git revert` 并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C5: `flow.mjs start --sandbox` 创建 `.worktrees/sandbox-<id>/` 隔离工作树，保护 `main` 干净（`BLOCKED_MAIN_SLOT_VIOLATION` 保持生效），豁免预建 Issue，且对未晋升沙箱执行 `finalize`/`submit` 硬拒 `BLOCKED_SANDBOX_PROMOTE_REQUIRED`（不提前 `git mv` 归档文档）。
- [ ] C6: `ledger.mjs` 新增 `implementers[]`（支持单常驻或互不重叠 `writeScope` 多子代理并行登记，写域冲突硬拒 `BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP`），`collectImplementerHistory` 自动聚合 `implementers[]` 并在外环审查与合并强制执行 `reviewerId ∉ implementers[]`（`SELF_REVIEW_REJECTED`）与防自合（`BLOCKED_SELF_MERGE`）。
- [ ] C7: `flow.mjs promote --task <id>` 按真实 `git diff <baseRef>...HEAD` 经单源 `determineWorkflowPolicy` 确定性路由：`Case 2/3`（含纯 UI 局部改）原地晋升并一次性补齐单一 Issue 绑定与 `C1..Cn` 收口；命中 `Case 4`（`one-way`/`high-risk`/跨多域契约）则输出 `SANDBOX_PROMOTE_NEEDS_SPEC` 标记为已验证 PoC 并引导走 `SPEC`/`1:N PRD` + 独立 Critic + `approve`。
- [ ] C8: `workflow-policy-next.mjs` 完整支持 `sandbox-iterating`、`sandbox-ready-to-promote`、`sandbox-needs-spec` 状态路由与单一可执行命令；沙箱内 `flow verify` 自动打标 `inner: true`，晋升后无缝接入外环 `finalize -> verify -> submit -> review -> merge -> cleanup --confirm --preview-hash`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写失败的 Red-Green 测试 `scripts/dev/fixtures-sandbox-dual-loop.mjs` (new) 并注册到 `scripts/dev/fixtures.mjs` | 运行 `node scripts/dev/fixtures.mjs` 新用例必须红 | Wave 1 已合并 |
| 2 | 改造 `ledger.mjs`、`harness-context.mjs`、`mutability.mjs`、`subcommand-meta.mjs` 与 `workflow-policy-next.mjs` | 账本多代理写域与状态机单测通过且全部文件 `<= 800L` | 步骤 1 |
| 3 | 新增 `kit/skills/dev-flow/scripts/flow-sandbox.mjs` (new) 并薄接入 `flow.mjs`、`flow-inspect.mjs`、`flow-start-helpers.mjs`、`flow-lifecycle.mjs`、`flow-lifecycle-finalize.mjs`、`flow-merge.mjs` | `fixtures-sandbox-dual-loop.mjs` 全绿且 `flow-inspect.mjs`/`flow-lifecycle.mjs`/`flow-merge.mjs <= 800L` | 步骤 2 |
| 4 | 新增 `scripts/dev/injections-data-sandbox-flow.mjs` (new) 并同步 `.agents/skills/`（`node scripts/equip.mjs .`） | `preflight.mjs`、`fixtures.mjs`、`equip.mjs . --check`、`verify-injections.mjs --jobs 4` 全绿 | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `flow-inspect.mjs`（795L）或 `flow-merge.mjs`（789L）超 800 行 | 直接在原文件展开沙箱逻辑 | 所有沙箱实现放在 `flow-sandbox.mjs` (new)，原文件仅留 3-5 行委托调用 |
| 沙箱工作树共享依赖卸载不干净导致 `cleanup` 误删主仓依赖 | `mountSharedDeps` 未登记 `mountedDepsByWorktree` | `handleSandboxStart` 强制复用 `recordMountedDepsInLedger` 并在测试中校验卸载后主仓 `node_modules` 完好 |

## 回滚预案

- **出问题时的第一步**：暂停 Wave 3 启动，保留失败复现日志。
- **回滚用什么**：`git revert` 撤销 Wave 2 合并提交并重跑 `node scripts/equip.mjs .`。
- **回滚之后要做什么**：运行 `node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs` 确认 Wave 1 状态不受影响。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| Wave 1 (`single-source-policy-core`) | 三轴 `determineWorkflowPolicy` 与 `inner: true` 硬拒合入 `main` | 启动本切片前 | 主调度 / Wave 1 审查者 |

## 断点与遗留决策

- **当前状态**：`draft`（Wave 2 切片，依赖 `single-source-policy-core`）
- **待拍板事项**：无
- **下一步第一件事**：待 Wave 1 合入 `main` 且本 SPEC 获 `approve` 后，派独立实施子代理在隔离 worktree 启动步骤 1。

## 澄清与补充记录

- 已确认：`review-ledger.mjs`（798 行）通过复用 `ledger.mjs` 的 `collectImplementerHistory` 自动获得 `reviewerId ∉ implementers[]` 保护，无需修改 `review-ledger.mjs`。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
