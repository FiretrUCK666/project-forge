---
kind: todo
title: 全业务流去 GitHub 硬假设、实证附件闭环、同步缺陷根治与多平台 E2E
status: done
created: 2026-11-27
updated: 2026-11-28
issue: 227
pr: null
branch: feat/multi-forge-flow-sync-e2e
owner: plan-c-master
plan_mode: interactive
approved: false
done_at: 2026-11-28
task_id: multi-forge-flow-sync-e2e
planned_at: 7785ef3c55cb5251cbca39c6b312b414ab4841f5
related_prd: ../prd/261127-issue227-multi-forge-worktree-perf-v1-prd.md
related_spec: ../specs/261127-issue227-multi-forge-flow-sync-e2e-spec.md
---

# 全业务流去 GitHub 硬假设、实证附件闭环、同步缺陷根治与多平台 E2E

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-28` |
| 分支 / 基线 | `feat/multi-forge-flow-sync-e2e` @ `7785ef3` |
| 任务编号 | `multi-forge-flow-sync-e2e` |
| 负责人 / 审批 | plan-c-master / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | #227 / 未关联 / `docs/archive/specs/261127-issue227-multi-forge-flow-sync-e2e-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC 审批状态（需 Wave 1 与 Wave 2 全部合入后启动，本切片负责终态收口总控 PRD）。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/master-criteria-sync.mjs` (new)、`kit/skills/dev-flow/scripts/flow-context.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-merge-claim.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs`、`kit/skills/dev-flow/scripts/flow-intake.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-start-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-batch.mjs`、`kit/skills/dev-review/scripts/review-pr.mjs`、`kit/skills/dev-review/scripts/review-sync.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/task-graph.mjs`、`kit/skills/lib/workflow-policy-next.mjs`、`kit/skills/lib/verify-state.mjs`、`kit/skills/lib/empirical-artifacts.mjs`、`kit/skills/lib/plan-sync.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/handoff-package.mjs`、`scripts/survey.mjs`、`scripts/review.mjs`、`scripts/equip-ci.mjs`、`scripts/lib/navigation.mjs`、`scripts/lib/render.mjs`、`scripts/dev/fixtures-empirical-cycle.mjs`、`scripts/dev/fixtures-issue-checklist-sync.mjs`、`scripts/dev/fixtures-multi-platform.mjs` (new)、`scripts/dev/injections-data-multi-platform.mjs` (new)、`scripts/dev/live-forge-e2e.mjs` (new)、`docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md`
- **复用既有模块**：Wave 1B `resolveRemoteTarget` / `RemoteApiBackend` / `probePlatformEnv`、`kit/skills/lib/verify-state.mjs`、`kit/skills/lib/empirical-artifacts.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/plan-sync.mjs`
- **本期不做**：不硬编码任何私域域名/账号/Token；不引入外链图床；不把截图写入 Git 历史；不向 714 行 `doc-slice-graph.mjs` 堆砌新逻辑
- **门型与回滚路径**：`one-way`（高风险路径 `kit/`、`scripts/lib/`）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [x] C10: 全量消除 `kit/skills/dev-flow/scripts/flow-*.mjs`、`kit/skills/dev-review/scripts/review-{pr,sync}.mjs`、`kit/skills/lib/plan-sync.mjs`（L508-520）、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/task-graph.mjs`、`kit/skills/lib/workflow-policy-next.mjs` 与 `scripts/survey.mjs`、`scripts/review.mjs`、`scripts/equip-ci.mjs`、`scripts/lib/navigation.mjs`、`scripts/lib/render.mjs`（L393）中的 `github`/`gh` 硬假设，统一切换为 `resolveRemoteTarget`、`mrRefPattern` 与 10 键 `capabilities` 驱动。
- [x] C11: 落地仓外实证附件目录 `<gitCommonDir>/project-forge-flow/artifacts/<taskId>/` 生命周期（`verify-state.mjs` 安全前缀原语 + `empirical-artifacts.mjs` 5 列统一渲染与 `stageAndSyncTaskArtifacts` + `flow-cleanup.mjs` `cleanup`/`abort` 联动销毁，零入 Git），对接 `capabilities.uploadAttachment`（GitLab/GitCode 原生 `/uploads` 内嵌图且缓存防重传，GitHub/Gitee/Gitea/LAN 直接降级输出文件名 + 字节数 + 校验指纹 + 观察摘要，不询问图床），并确保 `flow-lifecycle.mjs`/`review-empirical.mjs` 瘦身至 `<= 780` 行。
- [x] C12: 新增独立单源模块 `kit/skills/lib/master-criteria-sync.mjs` (new) 根治 3 大同步缺陷并统一 PR/Issue 详单：（1）阻断 `flow-inspect.mjs` L616-617 与 L755-763 两处 `planBootstrap` 自动挂载子切片 SPEC/Todo（并瘦身 `flow-inspect.mjs <= 770` 行），`resolvePrimaryPlanDocOrder` 在 `flow-inspect`/`pr-template-hydrate`/`review-gates`/`handoff-package` 统一优先 `prdFile`（修 PR `#215`）；（2）`collectMasterIssueCriteriaState` 迁入 `master-criteria-sync.mjs` 并增 `includeSelf = false` 默认开关（非终态 `plan-backfill`/`approve` 仅聚合已归档兄弟切片绝不误勾当前未完成切片，`flow-merge` 终态传 `includeSelf: true`），`syncIssueCriteriaCheckboxes` 默认 `preserveChecked = false`（仅非终态 `plan-sync` 显式传 `preserveChecked: true`，完整兼容 `scripts/dev/fixtures-issue-checklist-sync.mjs` 与 `clarify --drop-criterion`，修 Issue `#219`）；（3）PR 详单表格（变更摘要 + 验收清单进度表 + 门禁与 5 列实证附件表，对齐 `scripts/dev/fixtures-empirical-cycle.mjs`、目标仓 GitLab 默认 MR 模板（`.gitlab` 下 `merge_request_templates` 目录 `Default.md`）与 `PR_SECTION_TITLES`）与 Issue `pf:plan-summary` 单源一致。
- [x] C13: 新增 `scripts/dev/fixtures-multi-platform.mjs` (new) 与 `scripts/dev/injections-data-multi-platform.mjs` (new)（纯 Node HTTP Mock Forge + `git init --bare` 全覆盖 GitLab v4 `/uploads` & `refs/merge-requests/1/head` 真 SHA、GitCode 4 字节守卫 & 客户端过滤、Gitee/Gitea 降级、LAN IP / 离线四态核验），提供零硬编码凭据的 opt-in 一次性私有测试仓入口 `scripts/dev/live-forge-e2e.mjs` (new)，并同步 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、`README.md`/`README.en.md` 与 `node scripts/equip.mjs .`，全量 `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先编写失败回归测试 `scripts/dev/fixtures-multi-platform.mjs` (new)（覆盖 PR `#215` 两处挂载阻断、Issue `#219` `includeSelf: false` + `preserveChecked: true` + 显式反选、`artifacts/<taskId>/` 清理与 Mock Forge 5 方言 + LAN/离线 E2E） | `node scripts/dev/fixtures.mjs --domain multi-platform` 必红 | Wave 1 & Wave 2 合入且本切片获批 |
| 2 | 落地 `kit/skills/lib/master-criteria-sync.mjs` (new)，修复 `flow-inspect`/`flow-merge-claim`/`plan-sync`/`pr-template-hydrate`/`review-gates`/`handoff-package`，并实现仓外 `artifacts/<taskId>/`、`uploadAttachment` 渲染与对齐 `fixtures-empirical-cycle.mjs`/`fixtures-issue-checklist-sync.mjs` | `node scripts/dev/preflight.mjs` 与紧文件 `<= 780` 行检查全绿 | 步骤 1 |
| 3 | 全量切换 `flow-*.mjs`、`review-*.mjs`、`plan-sync.mjs`（L508-520）、`escalation`/`task-graph`/`workflow-policy-next` 与 `scripts/{survey,review,equip-ci,navigation,render}` 至 `resolveRemoteTarget` + 10 键 `capabilities` | `node scripts/dev/fixtures.mjs --domain multi-platform` 全绿 | 步骤 2 |
| 4 | 新增 `scripts/dev/injections-data-multi-platform.mjs` (new) 与 `scripts/dev/live-forge-e2e.mjs` (new)，同步 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、双语 `README` 与 `equip.mjs .`，执行终态收口门禁 | `node scripts/dev/merge-gate.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4` 与 `node scripts/sync-toc.mjs README.md README.en.md --check` 退出码 `0` | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（`C10..C13` 全部实现并通过 `preflight` 42/42、`fixtures` 640/640、`verify-injections` 532/532、`edit-gate` 0 blocker）
- **待拍板事项**：无
- **下一步第一件事**：执行 `flow.mjs finalize` 成对归档本切片 SPEC/Todo 与终态总控 PRD，随后运行 `flow.mjs verify --mode gate` 与 `flow.mjs submit --agent impl-c3-overnight`。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .` & `node scripts/equip.mjs . --check`：PASS（`.agents/skills/` 与 `kit/skills/` 字节级一致）
  - `node scripts/dev/preflight.mjs`：PASS（0 项失败，42 项读数，全仓 `<= 800` 行与平台锁/孤立脚本全绿）
  - `node scripts/dev/gap-coverage.mjs`：PASS（0 缺口遗漏）
  - `node scripts/dev/fixtures.mjs`：PASS（640/640 用例全绿，含 `multi-platform` 8/8、`flow` 8/8、`issue-checklist-sync` 11/11、`empirical-cycle` 15/15）
  - `node scripts/dev/verify-injections.mjs --jobs 4`：PASS（532/532 条故障注入 100% 捕获，含新增 `I_MP1..I_MP8`）
  - `node scripts/dev/bench.mjs` & `node scripts/dev/e2e-zip-harness.mjs`：PASS
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --mode verify --changed --json`：PASS（`ok: true`, `blockers: 0`）
  - `node scripts/dev/merge-gate.mjs`（经 `flow.mjs verify --mode gate` 绑定最终 HEAD）：12/12 PASS
- **文档同步检查**：已同步 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`（`verify-tools.mjs render . --check` PASS）、`README.md`、`README.en.md`（`sync-toc.mjs README.md README.en.md --check` PASS）及总控 PRD `C1..C13` 全勾选。
- **遗留问题**：无（外部私有托管实例真机闭环已提供零硬编码 opt-in 脚本 `scripts/dev/live-forge-e2e.mjs` 供按需传环境变量执行）。
