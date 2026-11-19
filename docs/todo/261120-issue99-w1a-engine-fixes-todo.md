---
kind: todo
title: 引擎 8 项边界缺陷根治与 survey(self) 性能优化实施清单
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 99
pr: null
branch: feat/w1a-engine-fixes
owner: plan-v101
approved: false
task_id: w1a-engine-fixes
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue99-w1a-engine-fixes-spec.md
plan_mode: autonomous
depends_on: []
scope_files:
  - scripts/*.mjs
  - scripts/lib/*.mjs
  - scripts/dev/fixtures-engine-hardening.mjs
  - scripts/dev/injections-data-engine-hardening.mjs
---

# `w1a-engine-fixes` 实施 Todo（Issue `#99`）

> 对应 SPEC：[w1a-engine-fixes SPEC](../specs/261120-issue99-w1a-engine-fixes-spec.md)　｜　总控 PRD：[v10.1 总控 PRD](../prd/261120-v10-1-hardening-pillars-docs-prd.md)

## 一、要做什么

<!-- section: goal -->
修复 `scripts/compose-agents.mjs`、`scripts/lib/agents-sections.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-scan.mjs`、`scripts/review.mjs`、`scripts/lib/equip-bootstrap.mjs` 与 `scripts/handoff.mjs` 中的 8 项引擎边界缺陷，并把 `node scripts/dev/bench.mjs` 的 `survey(self)` 本地实测中位数从 `289.2 ms` 压回 `<= 250 ms`（新增 `scripts/dev/fixtures-engine-hardening.mjs` (new) 与 `I225–I239` 双证断言）。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不放宽 `250 ms` 性能预算或 `30KB` 上限，不修改 `kit/`、`templates/agents-project.md` 或 `.agents/`，不引入第三方依赖。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 手写取舍防漂移）**：修改 `scripts/lib/agents-sections.mjs` `driftRegions`，豁免有实际决策内容的 `取舍` 区域字面漂移检查，并核对 `scripts/compose-agents.mjs --check` 与 `scripts/review.mjs` 协同。
- [ ] **T2（`C2` 新增技能单遍双收敛）**：修改 `scripts/compose-agents.mjs` 与 `scripts/lib/agents-defaults.mjs`，使新增自定义技能后单次运行同步更新并校验 `意图路由` 与 `探索策略`。
- [ ] **T3（`C3` 嵌入子包过滤与聚合）**：修改 `scripts/lib/survey-ecosystem.mjs` 与 `scripts/lib/agents-defaults.mjs`，过滤 `vendor/**`、`third_party/**`、`**/vscode-web/extensions/**` 并聚合超多子包摘要以守住 `30KB` 上限。
- [ ] **T4（`C4` Git 已跟踪输出目录消误报）**：修改 `scripts/lib/survey-workspace.mjs`，仅当输出目录（`dist`/`build`/`out`/`coverage`/`bin`）真实含未跟踪文件时才计入 `unignoredOutputDirs`。
- [ ] **T5（`C5` 存量架构文档字段对齐）**：修改 `scripts/review.mjs` 读取 `facts.docs.existingDesignDocs` 与 `tdd-authority` 豁免策略。
- [ ] **T6（`C6` 空起步 README 悬空指针清理）**：修改 `scripts/lib/equip-bootstrap.mjs`，移除面向目标仓生成的 `README.md` 中的 `scripts/compose-agents.mjs` 悬空提示。
- [ ] **T7（`C7` handoff 相对引用与嵌入大文件）**：修改 `scripts/handoff.mjs`，基于 `dirname(rel)` 校验相对 `references/*.md`、收紧 `SKILL_INTERNAL_RE` 并区分 vendored 跳过与真实漏扫。
- [ ] **T8（`C8` 性能剖析回归与双证覆盖）**：优化 `scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-scan.mjs` 与 `scripts/survey.mjs`（并行/快速计数、精准预检、单遍 `.agents/skills/` 复用），新增 `scripts/dev/fixtures-engine-hardening.mjs` (new) 与 `scripts/dev/injections-data-engine-hardening.mjs` (new)（`I225–I239`），确认 `node scripts/dev/bench.mjs` 中 `survey(self) <= 250 ms`。

## 四、验收与合前检查

- [ ] `node scripts/dev/fixtures.mjs --domain engine-hardening` 全绿。
- [ ] `node scripts/dev/bench.mjs --strict-budget` 实测 `survey(self)` 中位数 `<= 250 ms` 且 `review(self) <= 450 ms`。
- [ ] 逐条执行 `node scripts/dev/verify-injections.mjs --only I225`（覆盖 `I225..I232`）或全量 `verify-injections.mjs` 全数变红命中。
- [ ] 全量 `merge-gate` 全绿通过且独立审查放行。
