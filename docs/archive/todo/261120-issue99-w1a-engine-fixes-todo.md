---
kind: todo
title: 引擎 8 项边界缺陷根治与 survey(self) 性能优化实施清单
status: done
created: 2026-11-20
updated: 2026-11-20
issue: 99
pr: null
branch: feat/issue99-w1a-engine-fixes
owner: impl-99
approved: true
done_at: 2026-11-20
task_id: w1a-engine-fixes
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue99-w1a-engine-fixes-spec.md
plan_mode: autonomous
depends_on: []
scope_files: ["scripts/*.mjs", "scripts/lib/*.mjs", scripts/dev/fixtures-engine-hardening.mjs, scripts/dev/injections-data-engine-hardening.mjs]
---

# `w1a-engine-fixes` 实施 Todo（Issue `#99`）

> 对应 SPEC：[w1a-engine-fixes SPEC](../specs/261120-issue99-w1a-engine-fixes-spec.md)　｜　总控 PRD：[v10.1 总控 PRD](../../prd/261120-v10-1-hardening-pillars-docs-prd.md)

## 一、要做什么

<!-- section: goal -->
修复 `scripts/compose-agents.mjs`、`scripts/lib/agents-sections.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-scan.mjs`、`scripts/review.mjs`、`scripts/lib/equip-bootstrap.mjs` 与 `scripts/handoff.mjs` 中的 8 项引擎边界缺陷，并把 `node scripts/dev/bench.mjs` 的 `survey(self)` 本地实测中位数从 `289.2 ms` 压回 `<= 250 ms`（新增 `scripts/dev/fixtures-engine-hardening.mjs` (new) 与 `I225–I239` 双证断言）。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不放宽 `250 ms` 性能预算或 `30KB` 上限，不修改 `kit/`、`templates/agents-project.md` 或 `.agents/`，不引入第三方依赖。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [x] **T1（`C1` 手写取舍防漂移）**：修改 `scripts/lib/agents-sections.mjs` `driftRegions`，豁免有实际决策内容的 `取舍` 区域字面漂移检查，并核对 `scripts/compose-agents.mjs --check` 与 `scripts/review.mjs` 协同。
- [x] **T2（`C2` 新增技能单遍双收敛）**：修改 `scripts/compose-agents.mjs` 与 `scripts/lib/agents-defaults.mjs`，使新增自定义技能后单次运行同步更新并校验 `意图路由` 与 `探索策略`。
- [x] **T3（`C3` 嵌入子包过滤与聚合）**：修改 `scripts/lib/survey-ecosystem.mjs` 与 `scripts/lib/agents-defaults.mjs`，过滤 `vendor/**`、`third_party/**`、`**/vscode-web/extensions/**` 并聚合超多子包摘要以守住 `30KB` 上限。
- [x] **T4（`C4` Git 已跟踪输出目录消误报）**：修改 `scripts/lib/survey-workspace.mjs`，仅当输出目录（`dist`/`build`/`out`/`coverage`/`bin`）真实含未跟踪文件时才计入 `unignoredOutputDirs`。
- [x] **T5（`C5` 存量架构文档字段对齐）**：修改 `scripts/review.mjs` 读取 `facts.docs.existingDesignDocs` 与 `tdd-authority` 豁免策略。
- [x] **T6（`C6` 空起步 README 悬空指针清理）**：修改 `scripts/lib/equip-bootstrap.mjs`，移除面向目标仓生成的 `README.md` 中的 `scripts/compose-agents.mjs` 悬空提示。
- [x] **T7（`C7` handoff 相对引用与嵌入大文件）**：修改 `scripts/handoff.mjs` 与 `references/handoff.md`，基于 `dirname(rel)` 校验相对 `references/*.md`、收紧 `SKILL_INTERNAL_RE`、区分 vendored 大文件跳过与真实漏扫，并兼容 `.pf-manifest.json` `schemaVersion === 3`。
- [x] **T8（`C8` 性能剖析回归与双证覆盖）**：优化 `scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-scan.mjs`、`scripts/lib/survey-reentry.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/navigation.mjs` 与 `scripts/survey.mjs`（异步并发文件读取、按需 `git log -n 5000` 避开阻塞 `rev-list`、精准正则预检与 `textByRel`/`bufByRel`/`relSet` 单遍复用），新增 `scripts/dev/fixtures-engine-hardening.mjs` (new) 与 `scripts/dev/injections-data-engine-hardening.mjs` (new)（`I225–I239`），确认 `node scripts/dev/bench.mjs --strict-budget` 1x 全通过。

## 四、验收与合前检查

- [x] `node scripts/dev/fixtures.mjs --domain engine-hardening` 全绿。
- [x] `node scripts/dev/bench.mjs --strict-budget` 实测 `survey(self)` 中位数 `<= 250 ms` 且 `review(self) <= 450 ms`。
- [x] `node scripts/dev/verify-injections.mjs` 全量注入（含 `I225–I239`）全数变红命中。
- [x] 全量 `merge-gate` 与 `e2e-zip-harness.mjs` 全绿通过，交由独立审查验收放行。

## 完成后的记录

- **改动文件**：`scripts/compose-agents.mjs`、`scripts/review.mjs`、`scripts/handoff.mjs`、`scripts/survey.mjs`、`scripts/lib/agents-sections.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-scan.mjs`、`scripts/lib/survey-reentry.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-plan.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/lib/render.mjs`、`scripts/lib/navigation.mjs`、`references/handoff.md`、`scripts/dev/fixtures-engine-hardening.mjs`、`scripts/dev/injections-data-engine-hardening.mjs`、`scripts/dev/injections-data-core.mjs`、`scripts/dev/injections-data-gates.mjs`。
- **补充落地**：同步处理 Issue `#99` 补充评论，`scripts/handoff.mjs` 兼容 `.pf-manifest.json` `schemaVersion === 3` 并同步更新 `references/handoff.md`。
- **已运行且全部通过的核验**：`node scripts/dev/bench.mjs --strict-budget`（`1x` 全 6 项过预算：`survey(self)` 与 `review(self)` 均达标）、`node scripts/dev/fixtures.mjs --domain engine-hardening`、`node scripts/dev/verify-injections.mjs`（含 `I225–I239`）与完整 `merge-gate` + `e2e-zip-harness.mjs`。
