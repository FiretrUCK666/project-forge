---
kind: todo
title: 宿主无关双态规划门禁、PRD 切片图校验与波次交接包实施清单
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 101
pr: null
branch: feat/w2a-plan-wave-gate
owner: plan-v101
approved: false
task_id: w2a-plan-wave-gate
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue101-w2a-plan-wave-gate-spec.md
plan_mode: autonomous
depends_on:
  - w1a-engine-fixes
scope_files:
  - kit/skills/dev-plan/**
  - kit/skills/dev-flow/**
  - kit/skills/lib/pending-decisions.mjs
  - kit/skills/lib/handoff-package.mjs
  - kit/skills/lib/doc-slice-graph.mjs
  - kit/skills/lib/plan-exit-gate.mjs
  - .agents/skills/dev-plan/**
  - .agents/skills/dev-flow/**
  - .agents/skills/lib/pending-decisions.mjs
  - .agents/skills/lib/handoff-package.mjs
  - .agents/skills/lib/doc-slice-graph.mjs
  - .agents/skills/lib/plan-exit-gate.mjs
  - scripts/dev/fixtures-plan-wave.mjs
  - scripts/dev/injections-data-plan-wave.mjs
---

# `w2a-plan-wave-gate` 实施 Todo（Issue `#101`）

> 对应 SPEC：[w2a-plan-wave-gate SPEC](../specs/261120-issue101-w2a-plan-wave-gate-spec.md)　｜　总控 PRD：[v10.1 总控 PRD](../prd/261120-v10-1-hardening-pillars-docs-prd.md)

## 一、要做什么

<!-- section: goal -->
在 `kit/skills/dev-plan/`、`kit/skills/dev-flow/` 与共用库落地零宿主胶水的 `plan_mode: interactive | autonomous` 双态规划门禁、`kit/skills/lib/plan-exit-gate.mjs` (new) 阻断 `flow.mjs start` 退场校验（退出码 `3` `BLOCKED_PLAN_NOT_READY`）、`kit/skills/lib/doc-slice-graph.mjs` (new) 总控切片图校验（`BLOCKED_SLICE_CYCLE` 及同波次防撞），以及 `flow.mjs batch plan --handoff [--json]` 与 `verify` 参数预透传，刷新 `equip.mjs .` 并补齐 `scripts/dev/fixtures-plan-wave.mjs` (new) 与 `I250–I259`。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不绑定任何具体 AI 宿主 `/plan`/`/grill-me`，不触碰 `#102` 独占的 `kit/skills/dev-review/**`、`kit/skills/dev-iterate/**`、`kit/skills/dev-govern/**`、`kit/skills/lib/workflow-policy.mjs`、`workflow-helpers.mjs` 与 `templates/agents-project.md`。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 双态规划模式落地）**：在 `kit/skills/dev-plan/scripts/doc-plan.mjs`、`triage-rules.mjs`、`doc-plan-ops.mjs`、`kit/skills/lib/doc-frontmatter.mjs` 与 `pending-decisions.mjs` 支持 `plan_mode: interactive | autonomous` 并校验枚举合法性，同步更新 `kit/skills/templates/docs-*.md` 与 `kit/skills/dev-plan/SKILL.md` 双态交互规则（零宿主胶水）。
- [ ] **T2（`C2` 规划退场硬校验抽离与接入）**：新增 `kit/skills/lib/plan-exit-gate.mjs` (new)，实现 `evaluatePlanExitGate`，接入 `kit/skills/dev-flow/scripts/flow-inspect.mjs` / `flow-lifecycle.mjs` 中 Case 3/4 `start` 流程，在 `pendingDecisions > 0` 或未过审时返回退出码 `3` 与 `BLOCKED_PLAN_NOT_READY`。
- [ ] **T3（`C3` 切片有向图与波次防撞校验）**：新增 `kit/skills/lib/doc-slice-graph.mjs` (new) 并接入 `doc-audit.mjs` / `doc-audit-repo.mjs`，完成总控 `C1..Cn` 100% 覆盖、`scope_files` + `depends_on` 必填、拓扑判环 `BLOCKED_SLICE_CYCLE` 与同波次写域路径冲突检测。
- [ ] **T4（`C4` 波次交接包与 verify 标志预透传）**：升级 `kit/skills/dev-flow/scripts/flow-batch.mjs` 与 `kit/skills/lib/handoff-package.mjs` 支持 `batch plan --handoff [--json]`（保持 `{ wave, canParallel, tasks }` 兼容并附带交接包）；在 `kit/skills/dev-flow/scripts/flow.mjs` 用 `multiFlags`/`valueFlags` 注册 `--artifact` 与 `--visual-blocked-reason`，移除 `flow-lifecycle.mjs` 裸 `--visual-checked` 硬合成伪造串，经 `flow-lifecycle-helpers.mjs` 透传 `{ artifacts, visualBlockedReason, visualCheckedRaw }` 给 `workflow-policy.mjs`。
- [ ] **T5（同步工具包与双证回归）**：执行 `node scripts/equip.mjs .`，新增 `scripts/dev/fixtures-plan-wave.mjs` (new) 与 `scripts/dev/injections-data-plan-wave.mjs` (new)（`I250–I259`），跑通 `fixtures` 与 `verify-injections`。

## 四、验收与合前检查

- [ ] `node scripts/dev/fixtures.mjs --domain plan-wave` 全绿。
- [ ] 逐条执行 `node scripts/dev/verify-injections.mjs --only I250`（覆盖 `I250..I253`）或全量 `verify-injections.mjs` 全数变红命中。
- [ ] `node scripts/equip.mjs . --check && node scripts/dev/preflight.mjs` 全绿，且与 `#102` 保持零源码碰撞（若 `#102` 先合，rebase `main` 后重跑 `equip.mjs .` 重建 `.pf-manifest.json`）。
