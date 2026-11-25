---
kind: todo
title: "Hierarchical feature-map v2 Topology, Schema Validation and Context Slicing"
status: active
created: 2026-11-25
updated: 2026-11-25
issue: null
pr: null
branch: feat/visual-arch-plan
owner: planner-arch
plan_mode: interactive
approved: false
done_at: null
task_id: feature-map-v2-topology
planned_at: 887adcbe69441de8649d7e3facede8199c3bc2ea
related_prd: ../prd/261125-visual-arch-brief-prd-prd.md
related_spec: ../specs/261125-feature-map-v2-topology-spec.md
depends_on: []
scope_files: [kit/skills/lib/feature-map-graph.mjs, kit/skills/lib/feature-map.mjs, kit/skills/lib/test-inventory.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs, kit/skills/dev-explore/scripts/repo-map.mjs, kit/skills/dev-explore/scripts/repo-map-helpers.mjs, kit/skills/lib/context-brief.mjs, kit/skills/lib/handoff-package.mjs, kit/skills/dev-review/scripts/review-context.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs, kit/skills/dev-iterate/scripts/iterate.mjs, kit/skills/dev-iterate/scripts/iterate-plan.mjs, kit/skills/lib/exit-codes.mjs, .agents/skills/, scripts/dev/fixtures-feature-map-v2.mjs, scripts/dev/injections-data-verify-tools.mjs]
---

# Hierarchical feature-map v2 Topology, Schema Validation and Context Slicing

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / 基线 | `feat/visual-arch-plan` @ `887adcb` |
| 任务编号 | `feature-map-v2-topology` |
| 负责人 / 审批 | planner-arch / `false` |
| 规划态 | `interactive`（边界与契约已定案，待拍板为零） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `../specs/261125-feature-map-v2-topology-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/specs/261125-feature-map-v2-topology-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/feature-map-graph.mjs` (new)、`kit/skills/lib/feature-map.mjs`、`kit/skills/lib/test-inventory.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-explore/scripts/repo-map-helpers.mjs`、`kit/skills/lib/context-brief.mjs`、`kit/skills/lib/handoff-package.mjs`、`kit/skills/dev-review/scripts/review-context.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`、`kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`、`kit/skills/dev-iterate/scripts/iterate.mjs`、`kit/skills/dev-iterate/scripts/iterate-plan.mjs` (new)、`kit/skills/lib/exit-codes.mjs`、`scripts/dev/fixtures-feature-map-v2.mjs` (new)、`scripts/dev/injections-data-verify-tools.mjs`。
- **复用既有模块**：`kit/skills/lib/feature-map.mjs`、`kit/skills/lib/git-core.mjs` / `git.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-review/scripts/review-context.mjs`（跨模块 `import` 解析）。
- **本期不做**：不实现视觉渲染引擎（`visual-engine-arch-map`）与 Living Brief/本仓 v2 dogfooding（`living-brief-and-dogfood`）。
- **门型与回滚路径**：`one-way`；出现问题经 `git revert` 回退提交并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C1: 新增叶子模块 `kit/skills/lib/feature-map-graph.mjs` (new)（仅依赖 `node:*` 与 `kit/skills/lib/git-core.mjs`）并升级 `kit/skills/lib/feature-map.mjs` 支持 `[1, 2]` 版本、修复 `sanitizeFeatureEntry` 丢失 `docAnchors[]` 缺陷、保留 L203-204 注入锚点、实现 `domains[]`/`dependsOn[]`/`actors[]`/`flows[]` DFS 判环与悬空校验、`FORBIDDEN_TRACKED_KEYS` 全覆盖扫描、规范化 SHA256、`buildFallbackDomains` 与 `sliceFeatureMapContext`，并将 `test-inventory.mjs` 的 `readFeatureMapSafe`/`updateFeatureMapTestRefs` 迁入 `feature-map.mjs` 仅留薄重导出（`test-inventory.mjs <= 798` 行），经 `node scripts/dev/fixtures.mjs` 验证通过。
- [ ] C2: 升级 `kit/skills/dev-explore/scripts/repo-map.mjs` 与 `repo-map-helpers.mjs` 自动生成 Layer-1 `domains[]` 与无环 `dependsOn[]`；修复 `kit/skills/dev-verify-tools/scripts/verify-tools.mjs` L163-164 重复 `prefillFeatureMapFromRepoMap` 调用并修复 `verify-tools-audit.mjs` L178 `handleClean` 剥除 `domains[]`/`flows[]`/`version` 缺陷且报告拓扑错误，经 `node scripts/dev/fixtures.mjs` 验证通过。
- [ ] C3: 升级 `kit/skills/lib/context-brief.mjs`、`kit/skills/lib/handoff-package.mjs` 与 `kit/skills/dev-review/scripts/review-context.mjs` 保留 `locateTopSlicesForPaths` `budgetLines = 48`（L170），并在 `formatContextBriefLines`（L333）使用 `maxDomains`/`maxNeighbors`/`maxFlows` 上限及 `"contextBrief"` 单源契约按角色权重渲染 `domainSummary`、1-hop 紧凑上下游与 `matchedFlows`，经 `node scripts/dev/fixtures.mjs` 验证通过。
- [ ] C4: 在 `kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`（含 `exit-codes.mjs` 单一 `EXIT.FACT` 档位 `BLOCKED_FEATURE_MAP_TOPOLOGY`）、`kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`（拓扑对拍 + `suggestedCrossFeatureDeps`）与 `kit/skills/dev-iterate/scripts/iterate.mjs`（抽离 `iterate-plan.mjs` (new) 保持 `<= 790` 行，跨 feature `flows[]` 盲区）完成集成并执行 `node scripts/equip.mjs .`；`scripts/dev/fixtures-feature-map-v2.mjs` (new)、`scripts/dev/injections-data-verify-tools.mjs`、`preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs` 全绿通过。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 在 `scripts/dev/fixtures-feature-map-v2.mjs` (new) 补齐 C1-C4 正反双向失败用例（Red） | `node scripts/dev/fixtures.mjs` 复现失败 | 无 |
| 2 | 新建叶子模块 `kit/skills/lib/feature-map-graph.mjs` (new)，升级 `feature-map.mjs` 并抽空 `test-inventory.mjs` 冗余实现仅留薄重导出 | `node scripts/dev/fixtures.mjs` C1 转绿 | 步骤 1 |
| 3 | 升级 `repo-map*.mjs` 与 `verify-tools*.mjs`（修复 L163-164 重复调用与 `verify-tools-audit.mjs` L178 `handleClean`） | `node scripts/dev/fixtures.mjs` C2 转绿 | 步骤 2 |
| 4 | 接入 `context-brief.mjs`、`handoff-package.mjs`、`review-context.mjs`、`flow-lifecycle-hooks.mjs`、`govern-checks-hygiene.mjs`、`iterate.mjs` + `iterate-plan.mjs` (new) | `node scripts/dev/fixtures.mjs` C3-C4 转绿 | 步骤 3 |
| 5 | 同步 `node scripts/equip.mjs .`、补充 `scripts/dev/injections-data-verify-tools.mjs` 故障注入并跑全量门禁 | `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4`、`merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `test-inventory.mjs` (792 L) 或 `iterate.mjs` (759 L) 超过 800 行 | 直接在原文件追加逻辑 | 将 `readFeatureMapSafe`/`updateFeatureMapTestRefs` 迁入 `feature-map.mjs` 仅留薄重导出；拆出 `iterate-plan.mjs` (new) |
| 破坏 `feature-map.mjs` L203-204 注入片段 | 重构循环条件改变文本字面量 | 保持 L203-204 精确字面量并用 `verify-injections.mjs` 校验 `I197` |

## 回滚预案

- **出问题时的第一步**：执行 `git revert <commit-sha>` 并重跑 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/fixtures.mjs`。
- **回滚之后要做什么**：保留 v1 `docs/feature-map.json` 兼容断言并更新对应任务记录。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 切片 2（`visual-engine-arch-map`） | 依赖本切片合入 `main` 后再读取 `feature-map-graph.mjs` (new) API | 本切片合并后 | 调度者 / 审查者 |

## 断点与遗留决策

- **当前状态**：`进行中`（等待总控 PRD 与本 SPEC 独立 Critique 及 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：完成总控 PRD 与本切片独立 Critique 后运行 `doc-plan.mjs approve` 再建 `impl` 任务启动编码。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
