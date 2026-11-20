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
approved: true
task_id: w2b-empirical-poc-cycle
planned_at: d2f412968988fd6d2b656ba6b52ee136f0b0ce34
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_spec: ../specs/261120-issue102-w2b-empirical-poc-cycle-spec.md
plan_mode: autonomous
depends_on: [w1a-engine-fixes]
scope_files: ["kit/skills/dev-review/**", "kit/skills/dev-iterate/**", "kit/skills/dev-govern/**", kit/skills/lib/workflow-policy.mjs, kit/skills/lib/workflow-helpers.mjs, kit/skills/lib/escalation.mjs, kit/skills/lib/empirical-artifacts.mjs, ".agents/skills/dev-review/**", ".agents/skills/dev-iterate/**", ".agents/skills/dev-govern/**", .agents/skills/lib/workflow-policy.mjs, .agents/skills/lib/workflow-helpers.mjs, .agents/skills/lib/escalation.mjs, .agents/skills/lib/empirical-artifacts.mjs, templates/agents-project.md, AGENTS.md, scripts/dev/fixtures-empirical-cycle.mjs, scripts/dev/injections-data-empirical-cycle.mjs]
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

- [x] **T1（`C1` 结构化实证附件校验与渲染）**：新增 `kit/skills/lib/empirical-artifacts.mjs` (new) 承载实证附件非空/SHA-256 校验与附件清单渲染；`kit/skills/lib/workflow-policy.mjs`（新增 `validateVerifyPrecheck` 承接 `#101` `flow verify` 透传）、`kit/skills/lib/workflow-helpers.mjs`（`buildVerificationEvidenceSection` 薄委托）、`kit/skills/dev-review/scripts/review-pack.mjs`、`review-empirical.mjs` 与 `review-empirical-state.mjs` 对接，保证全仓 `.mjs <= 800` 行。
- [x] **T2（`C2` UI 变更防敷衍强校）**：在 `empirical-artifacts.mjs` (new) -> `workflow-policy.mjs` 与 `review-empirical.mjs` 拦截触及 `UI_VISUAL_EXT_RE` 时裸传 `--visual-checked`（含拒绝硬编码占位串），强制非空 `--artifact` 或实质观察或显式 `--visual-blocked-reason` 诚实报阻。
- [x] **T3（`C3` PoC 先行消误报与 Tier 1/2 整类原则）**：修改 `kit/skills/lib/escalation.mjs` 支持可选 `reproEvidence` 与 `pocCommand` 字段；在 `kit/skills/dev-iterate/SKILL.md` 与 `kit/skills/dev-govern/SKILL.md` 写入最小复现、复跑证伪与整类加固通用准则。
- [x] **T4（`C4` 有界优化循环与契约同步）**：在 `kit/skills/dev-iterate/scripts/iterate.mjs` 实现 `cycle --goal "{goal}" [--max-rounds 3] [--json]` 只读四阶段状态机与硬停损门控；在 `templates/agents-project.md` 固化「只锁客观输出边界」，刷新 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .` 确认 `AGENTS.md < 24576 B`。
- [x] **T5（双向断言与故障注入）**：新增 `scripts/dev/fixtures-empirical-cycle.mjs` (new) 与 `scripts/dev/injections-data-empirical-cycle.mjs` (new)（`I260–I269`），跑通验证并与 `#101` 保持零源码碰撞（若 `#101` 先合，rebase `main` 后重跑 `equip.mjs .` 与 `compose-agents.mjs .` 重建 `.pf-manifest.json`）。

## 四、验收与合前检查

- [x] `node scripts/dev/fixtures.mjs --domain empirical-cycle` 全绿。
- [x] 逐条执行 `node scripts/dev/verify-injections.mjs --only I260`（覆盖 `I260..I263`）或全量 `verify-injections.mjs` 全数变红命中。
- [x] `node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/dev/preflight.mjs` 全绿，且 `AGENTS.md` 字节数严格 `< 24576 B`、全 `.mjs <= 800` 行。

## 五、完成记录

- `kit/skills/lib/empirical-artifacts.mjs` 承载附件存在性/常规文件/非空校验、`{ relPath, bytes, sha256Prefix, capturedAt }` 元数据、观察实质判据与 PR 实证清单渲染；`workflow-policy.mjs` 只加 `validateVerifyPrecheck` 与 `evaluateStoredVisualEvidence` 接线，实测 `796` 行，`workflow-helpers.mjs` 实测 `485` 行，`pr-template-hydrate.mjs` 实测 `349` 行。
- 附件记录写入仓外 `evidence.json` 与审查回执，`git status` 保持零新增跟踪文件；`--artifact` 在 `review-pack.mjs` 登记为多值标志，逐条校验真实存在、非目录且非 0 字节。
- 触及 `UI_VISUAL_EXT_RE` 时，裸 `--visual-checked` 在 `verify` 与 `submit` 两处均被拦（`BLOCKED_VISUAL_EVIDENCE_REQUIRED`）；旧式硬编码确认串与 `lgtm` 一类水话均被判为无效观察，无渲染环境须显式 `--visual-blocked-reason` 并同步披露在 PR 实证表。
- `escalation.mjs` 支持可选 `reproEvidence`/`pocCommand`，建单正文自动带「最小复现」与「复现命令」两行，不识别任何具体工具名。
- `iterate.mjs cycle` 默认 `3` 轮、硬上限 `10` 轮，三条停损 `ROUND_LIMIT_REACHED`/`NO_PROGRESS_STALL`/`ONE_WAY_GATE_HIT` 触发即输出 `stopped: true` 与 `stopReason`，停损时退出码 `4`，全程只读。
- 实测读数：`fixtures.mjs --domain empirical-cycle` 11 项通过 0 失败；全量 `fixtures.mjs` 343 项通过 0 失败；`verify-injections.mjs` 全量 261 条判据全部变红命中（含 `I260–I269` 十条）；`preflight.mjs` 自检通过 0 项失败（36 项读数）；`AGENTS.md` 实测 `22582` 字节（`< 24576 B`）。
- 与 `#101` 零源码碰撞：本次未触碰 `kit/skills/dev-flow/**`、`kit/skills/dev-plan/**`、`pending-decisions.mjs` 与 `handoff-package.mjs`；`flow.mjs verify` 的 `--artifact` 与 `--visual-blocked-reason` 参数接收仍由 `#101` 落地，本切片的 `validateVerifyPrecheck` 已按其透传契约预留入口。
