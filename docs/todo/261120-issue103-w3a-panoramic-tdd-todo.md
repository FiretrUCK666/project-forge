---
kind: todo
title: Wave 2.5 本仓自举互转演练与全景 docs/TDD.md 重写实施清单
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 103
pr: null
branch: feat/w3a-panoramic-tdd
owner: plan-v101
approved: false
task_id: w3a-panoramic-tdd
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue103-w3a-panoramic-tdd-spec.md
plan_mode: interactive
depends_on:
  - w2a-plan-wave-gate
  - w2b-empirical-poc-cycle
scope_files:
  - docs/TDD.md
  - docs/feature-map.json
  - AGENTS.md
---

# `w3a-panoramic-tdd` 实施 Todo（Issue `#103`）

> 对应 SPEC：[w3a-panoramic-tdd SPEC](../specs/261120-issue103-w3a-panoramic-tdd-spec.md)　｜　总控 PRD：[v10.1 总控 PRD](../prd/261120-v10-1-hardening-pillars-docs-prd.md)

## 一、要做什么

<!-- section: goal -->
在合入 Wave 1 与 Wave 2 后的 `main` 基线上先完成 Wave 2.5 本仓真实自举互转演练（跑通 `dev-govern` + `dev-verify-tools` + `dev-iterate` 互转并修清发现项、刷新 `docs/feature-map.json`），随后用平实无 AI 味中文与合规 `16/12` Mermaid 图全景重写 `docs/TDD.md`。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不修改 `README.md`、`README.en.md` 与 `assets/readme/*.svg`（留待 Slice 5 `#104`），不删减 `tdd-structure.mjs` 必选章节或模块表。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C4` Wave 2.5 真实自举互转演练）**：在 Wave 1 与 Wave 2 均合入 `main` 后，顺序执行 `govern-audit.mjs audit .`、`verify-tools.mjs audit`、`iterate.mjs discover` 与 `iterate.mjs cycle`，将发现的新问题按正流修复清零并留存 `--artifact` 实证，同步刷新 `docs/feature-map.json` 与 `AGENTS.md`。
- [ ] **T2（`C1` 全景章节大纲重构）**：依据 `kit/skills/lib/tdd-structure.mjs` 必选节边界重写 `docs/TDD.md`，系统贯通 `S1–S4`、全 8 个技能接力、双态规划门禁、波次调度与交接包、`--artifact` 实证与 UI 拦截、`PoC-first` 原则、`iterate.mjs cycle`、三层常青文档与跨代双向融合升级。
- [ ] **T3（`C2` 合规 Mermaid 全景图示）**：绘制至少 4 张全景架构与流程 Mermaid 图（含外部治理、8 技能研发、波次门禁、实证优化循环），严守矩形/子图 `<= 16`、边/菱形 `<= 12` 显示宽度与零 HTML 标签。
- [ ] **T4（`C3` 去 AI 味可读性润色与全门禁校验）**：参照 `oil-tone` 改写为平实通俗中文确保人类无需读源码即可理解运转全貌，并通过 `preflight` / `doc-plan` / `govern-audit` / `sync-toc` 与 `doc-locate.mjs` 节级定位实测。

## 四、验收与合前检查

- [ ] Wave 2.5 自举互转演练零未解遗留缺陷，且 `docs/feature-map.json` 全覆盖最新模块。
- [ ] `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .`（含 Mermaid 16/12 与 TDD 结构）全绿。
- [ ] `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . && node scripts/dev/preflight.mjs` 全绿。
