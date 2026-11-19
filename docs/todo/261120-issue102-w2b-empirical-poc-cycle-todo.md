---
kind: todo
title: 工具无关结构化实证附件、PoC 先行原则与有界优化循环实施清单
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 102
pr: null
branch: feat/w2b-empirical-poc-cycle
owner: plan-v101
approved: false
task_id: w2b-empirical-poc-cycle
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue102-w2b-empirical-poc-cycle-spec.md
plan_mode: autonomous
depends_on:
  - w1a-engine-fixes
scope_files:
  - kit/skills/dev-review/**
  - kit/skills/dev-iterate/**
  - kit/skills/dev-govern/**
  - kit/skills/lib/workflow-policy.mjs
  - kit/skills/lib/workflow-helpers.mjs
  - kit/skills/lib/escalation.mjs
  - kit/skills/lib/empirical-artifacts.mjs
  - .agents/skills/dev-review/**
  - .agents/skills/dev-iterate/**
  - .agents/skills/dev-govern/**
  - .agents/skills/lib/workflow-policy.mjs
  - .agents/skills/lib/workflow-helpers.mjs
  - .agents/skills/lib/escalation.mjs
  - .agents/skills/lib/empirical-artifacts.mjs
  - templates/agents-project.md
  - AGENTS.md
  - scripts/dev/fixtures-empirical-cycle.mjs
  - scripts/dev/injections-data-empirical-cycle.mjs
---

# `w2b-empirical-poc-cycle` 实施 Todo（Issue `#102`）

> 对应 SPEC：[w2b-empirical-poc-cycle SPEC](../specs/261120-issue102-w2b-empirical-poc-cycle-spec.md)　｜　总控 PRD：[v10.1 总控 PRD](../prd/261120-v10-1-hardening-pillars-docs-prd.md)

## 一、要做什么

<!-- section: goal -->
拆出独立模块 `kit/skills/lib/empirical-artifacts.mjs` (new) 保全 `workflow-helpers.mjs`（797L）与 `workflow-policy.mjs`（783L）严守 `<= 800` 行红线，在 `workflow-policy.mjs`、`workflow-helpers.mjs`、`escalation.mjs` 与 `dev-review`/`dev-iterate`/`dev-govern` 落地工具无关 `--artifact` 实证校验与 PR 渲染、`UI_VISUAL_EXT_RE` 禁止裸传 `--visual-checked` 强拦截、`PoC-first` 消误报与 Tier 1/2 整类原则及 `iterate.mjs cycle` 有界优化编排，并在 `templates/agents-project.md` 固化「只锁客观输出边界」，刷新 `equip`/`compose-agents`（`AGENTS.md < 24576 B`）并补齐 `scripts/dev/fixtures-empirical-cycle.mjs` (new) 与 `I260–I269`。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不触碰并行切片 `#101` 独占的 `kit/skills/dev-flow/**`、`kit/skills/dev-plan/**` 与 `pending-decisions.mjs` / `handoff-package.mjs`，不硬编码任何具体浏览器、云沙箱或扫描器工具名。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 结构化实证附件校验与渲染）**：新增 `kit/skills/lib/empirical-artifacts.mjs` (new) 承载实证附件非空/SHA-256 校验与附件清单渲染；`kit/skills/lib/workflow-policy.mjs`（新增 `validateVerifyPrecheck` 承接 `#101` `flow verify` 透传）、`kit/skills/lib/workflow-helpers.mjs`（`buildVerificationEvidenceSection` 薄委托）、`kit/skills/dev-review/scripts/review-pack.mjs`、`review-empirical.mjs` 与 `review-empirical-state.mjs` 对接，保证全仓 `.mjs <= 800` 行。
- [ ] **T2（`C2` UI 变更防敷衍强校）**：在 `empirical-artifacts.mjs` (new) -> `workflow-policy.mjs` 与 `review-empirical.mjs` 拦截触及 `UI_VISUAL_EXT_RE` 时裸传 `--visual-checked`（含拒绝硬编码占位串），强制非空 `--artifact` 或实质观察或显式 `--visual-blocked-reason` 诚实报阻。
- [ ] **T3（`C3` PoC 先行消误报与 Tier 1/2 整类原则）**：修改 `kit/skills/lib/escalation.mjs` 支持可选 `reproEvidence` 与 `pocCommand` 字段；在 `kit/skills/dev-iterate/SKILL.md` 与 `kit/skills/dev-govern/SKILL.md` 写入最小复现、复跑证伪与整类加固通用准则。
- [ ] **T4（`C4` 有界优化循环与契约同步）**：在 `kit/skills/dev-iterate/scripts/iterate.mjs` 实现 `cycle --goal "{goal}" [--max-rounds 3] [--json]` 只读四阶段状态机与硬停损门控；在 `templates/agents-project.md` 固化「只锁客观输出边界」，刷新 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .` 确认 `AGENTS.md < 24576 B`。
- [ ] **T5（双向断言与故障注入）**：新增 `scripts/dev/fixtures-empirical-cycle.mjs` (new) 与 `scripts/dev/injections-data-empirical-cycle.mjs` (new)（`I260–I269`），跑通验证并与 `#101` 保持零源码碰撞（若 `#101` 先合，rebase `main` 后重跑 `equip.mjs .` 与 `compose-agents.mjs .` 重建 `.pf-manifest.json`）。

## 四、验收与合前检查

- [ ] `node scripts/dev/fixtures.mjs --domain empirical-cycle` 全绿。
- [ ] 逐条执行 `node scripts/dev/verify-injections.mjs --only I260`（覆盖 `I260..I263`）或全量 `verify-injections.mjs` 全数变红命中。
- [ ] `node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/dev/preflight.mjs` 全绿，且 `AGENTS.md` 字节数严格 `< 24576 B`、全 `.mjs <= 800` 行。
