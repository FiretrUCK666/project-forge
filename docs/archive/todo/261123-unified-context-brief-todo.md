---
kind: todo
title: 单源 context-brief.mjs 贯通全部五个强制代理入口
status: done
created: 2026-11-23
updated: 2026-11-23
issue: null
pr: null
branch: feat/unified-context-brief
owner: coordinator
plan_mode: autonomous
approved: false
done_at: 2026-11-23
task_id: unified-context-brief
planned_at: 5b0da48f3661f6c3237573112589ba3303f1ed58
related_prd: null
related_spec: null
---

# 单源 context-brief.mjs 贯通全部五个强制代理入口

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-23` / `2026-11-23` |
| 分支 / 基线 | `feat/unified-context-brief` @ `5b0da48` |
| 任务编号 | `unified-context-brief` |
| 负责人 / 审批 | coordinator / `false`（具体实施人：impl-context-brief） |
| 规划态 | `autonomous`（局部可逆 Case 3 架构收口） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / 无 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/context-brief.mjs` (new)、`kit/skills/lib/handoff-package.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-flow/scripts/flow-merge-claim.mjs`、`kit/skills/dev-flow/scripts/flow-explore.mjs`、`kit/skills/dev-review/scripts/review-context.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`scripts/dev/fixtures-w6c-harness-gates.mjs`、`docs/TDD.md`、`.agents/skills/`
- **复用既有模块**：`kit/skills/lib/profile.mjs`（`discoverEvergreenDocs`）、`kit/skills/lib/doc-locator.mjs`（`locateTopSlicesForPaths`）、`kit/skills/lib/feature-map.mjs`（`matchFeatureMapForPaths`）、`kit/skills/lib/markdown-scan.mjs`（`indexMarkdownSections`）、`kit/skills/lib/git.mjs`（`canonicalPath` / `posixPath` / `readTextSafe`）
- **本期不做**：不改写 `doc-locator.mjs` 评分算法、不改 `feature-map.json` Schema、不引入任何第三方依赖、不修改 `scripts/lib/` 或 `templates/`
- **门型与回滚路径**：two-way；局部可逆改动，直接 `git revert` 合并提交即可完整回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 新建单源 `kit/skills/lib/context-brief.mjs` 导出 `buildContextBrief` 与 `formatContextBriefLines`，组合 `discoverEvergreenDocs`（输出最多 `maxEvergreenDocs` 份文档 `##` 二级标题目录及 `doc-locate` 命令的 `evergreenToc`）、`locateTopSlicesForPaths`（`relatedSlices`）与 `matchFeatureMapForPaths`（含无精确命中时的顶级 feature 域概览与 `totalFeaturesCount`），且严格 Fail-Soft 零抛错、零第三方依赖、遵守 `arch-rules`、文件 `<= 800` 行。
- [x] C2: 接入全部 5 个强制代理入口并收口既有重复拼接逻辑：`handoff-package.mjs`（替换 `280-324` 行手工拼接并透出 `evergreenToc`）、`doc-plan.mjs`（`triage` 与 `init` 接入 `contextBrief` 与紧凑文本输出）、`flow-merge-claim.mjs`（`handleClaim` 输出 `contextBrief`）、`review-context.mjs` + `review-gates.mjs`（合入 `evergreenContext`）、`flow-explore.mjs` + `ledger.mjs`（`handleExplore` 输出 `contextBrief` 且 `normalizeExploredEvidence`/`createExploredEvidence` 兼容可选 `evergreenDocsCount`/`featureMapCount`）。
- [x] C3: 在 `scripts/dev/fixtures-w6c-harness-gates.mjs` 新增正反双向 Red-Green 用例并通过 `node scripts/dev/fixtures.mjs --jobs 6`（正向五入口均稳定输出 `docs/TDD.md` 章节目录/切片与 `feature-map` 业务流；反向缺/损坏文档均零崩溃安全降级、零虚构且输出有界）。
- [x] C4: 执行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 并更新 `docs/TDD.md` 简明记录 `context-brief.mjs` 五入口收口；全部本地门禁（`equip --check`、`compose-agents --check`、`preflight`、`gap-coverage`、`fixtures --jobs 6`、`verify-injections --jobs 6`、`e2e-zip-harness`、`review.mjs .`、`edit-gate --changed --final --json`、`govern-audit audit . --strict`、`flow verify --tier gate` 与 `--mode smoke`）全绿通过。
- [x] C5: 按规范完成 `flow.mjs finalize` -> `flow.mjs verify` -> `flow.mjs submit --agent impl-context-brief` 提审开 PR。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先写 Red-Green 双向用例再实现 `kit/skills/lib/context-brief.mjs` 与 5 个入口收口 | `node scripts/dev/fixtures.mjs --domain w6c-harness-gates` 先红后绿 | 无 |
| 2 | 运行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 并按「改哪看哪」更新 `docs/TDD.md` | `equip --check` 与 `doc-plan audit` 通过 | 步骤 1 |
| 3 | 跑通全量门禁、归档 Todo 并执行 `verify` + `submit` 开 PR | 全量门禁 exit 0 且 PR 创建成功 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`已完成待归档提审`
- **待拍板事项**：无
- **下一步第一件事**：执行 `flow.mjs finalize` 归档 Todo 并提交分支，随后运行 `flow.mjs verify --tier gate`、`flow.mjs verify --mode smoke` 与 `flow.mjs submit --agent impl-context-brief` 开 PR。

## 澄清与补充记录

- （本轮无额外澄清补充；需求与验收口径来自协调者任务单 `#652` 及补充要求 `#653`）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`：exit 0（`.agents/skills/.pf-manifest.json` 校验通过，151 个托管文件与 `kit/skills/` 字节级一致）
  - `node scripts/compose-agents.mjs . --check`：exit 0（标记成对、无未填占位、结构与模板一致）
  - `node scripts/dev/preflight.mjs`：exit 0（41 项读数、0 项失败；139 个套件脚本均 `<= 800` 行，最大 756 行）
  - `node scripts/dev/gap-coverage.mjs`：exit 0（20 条各有处置）
  - `node scripts/dev/fixtures.mjs --jobs 6`：exit 0（467 通过 / 0 失败，含 `contextBrief` 含 TDD、无 TDD 多常青与缺失/损坏 Fail-Soft 正反双向用例）
  - `node scripts/dev/verify-injections.mjs --jobs 6`：exit 0（388 条判据全抓到，含更新后的 `I105` 指向 `kit/skills/lib/context-brief.mjs`）
  - `node scripts/dev/e2e-zip-harness.mjs`：exit 0（Scenarios A–L 全通，235 包条目，耗时 49501 ms）
  - `node scripts/review.mjs .`：exit 0（结论：可以交付）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --final --json`：exit 0（checked=28, blockers=0）
  - `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict`：exit 0（critical=0, high=0, medium=0）
  - `node .agents/skills/dev-flow/scripts/flow.mjs explore --task unified-context-brief --by impl-context-brief --json`：exit 0（记录 `evergreenDocsCount=4, featureMapCount=22` 与 `contextBrief`）
- **文档同步检查**：已更新 `docs/TDD.md`、`docs/feature-map.json` 与 `.agents/skills/`（`equip.mjs . --check` 通过），`doc-plan.mjs audit .` 全部通过。
- **遗留问题**：无；待 `finalize` 归档提交后跑通 `flow.mjs verify --tier gate` / `--mode smoke` 与 `flow.mjs submit --agent impl-context-brief`。
