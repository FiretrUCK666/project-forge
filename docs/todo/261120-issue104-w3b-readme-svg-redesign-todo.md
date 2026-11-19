---
kind: todo
title: oil-tone 双语 README 重写与全套可变高度 SVG 重设计实施清单
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 104
pr: null
branch: feat/w3b-readme-svg-redesign
owner: plan-v101
approved: true
task_id: w3b-readme-svg-redesign
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue104-w3b-readme-svg-redesign-spec.md
plan_mode: interactive
depends_on: [w3a-panoramic-tdd]
scope_files: [README.md, README.en.md, "assets/readme/*.svg", scripts/dev/preflight-suite-checks.mjs]
---

# `w3b-readme-svg-redesign` 实施 Todo（Issue `#104`）

> 对应 SPEC：[w3b-readme-svg-redesign SPEC](../specs/261120-issue104-w3b-readme-svg-redesign-spec.md)　｜　总控 PRD：[v10.1 总控 PRD](../prd/261120-v10-1-hardening-pillars-docs-prd.md)

## 一、要做什么

<!-- section: goal -->
在 `docs/TDD.md` 定型后严格按 `oil-tone` 与 `beautify-github-readme` 全面重写双语 `README.md` / `README.en.md`，重设计全部 6 张既有 `assets/readme/*.svg` 并新增 `skills-cycle*.svg` (new) 与 `docs-layers*.svg` (new) 自然可变高度图示，完成浏览器浅/深色双主题截图实证并通过 `sync-toc --check` 与 `preflight` 后停在外部测试前硬停机点。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不改写核心引擎与 `kit/` 代码，不在 SVG 内写小于 `16px` 小字或强行统一画幅高度，未经人工指令不自动运行外部真实仓库回归测试集。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 重写双语 README）**：依照定型后的 `docs/TDD.md` 与 `oil-tone` 规范全面重写 `README.md` 与 `README.en.md`，清晰覆盖 `S1–S4`、全 8 个技能日常触发、双态规划、`iterate.mjs cycle` 与跨代融合，并跑通 `node scripts/sync-toc.mjs README.md README.en.md` 与 `--check`。
- [ ] **T2（`C2` 重绘既有 6 张并新增关键双语 SVG）**：重设计 `assets/readme/hero.svg`、`hero-en.svg`、`workflow.svg`、`workflow-en.svg`、`architecture.svg`、`architecture-en.svg`，新增 `assets/readme/skills-cycle.svg` (new)、`assets/readme/skills-cycle-en.svg` (new)、`assets/readme/docs-layers.svg` (new)、`assets/readme/docs-layers-en.svg` (new)，严格按实际内容自然定高、画幅宽松、字体 `>= 16`。
- [ ] **T3（`C3` 对齐 SVG 门禁校验）**：按需更新 `scripts/dev/preflight-suite-checks.mjs` 检查新 SVG 注册表，跑通 `node scripts/dev/preflight.mjs`。
- [ ] **T4（`C4` 浏览器双主题渲染截图核查与硬停机）**：在真实浏览器浅/深色背景下渲染并截取全部 SVG 与 README 页面截图保存于仓外临时路径，通过 `--artifact` 实证门禁合入 `main`；合入全绿后输出总汇报并硬停在外部测试集之前等待人工确认。

## 四、验收与合前检查

- [ ] `node scripts/sync-toc.mjs README.md README.en.md --check` 通过。
- [ ] `node scripts/dev/preflight.mjs` 全绿（全部 SVG 字体 `>= 16`、无外链/脚本、可变高度）。
- [ ] 已附上真实浅/深色浏览器截图 `--artifact` 并通过 `UI_VISUAL_EXT_RE` 审查门禁；已发出测试前硬停机确认请求。
