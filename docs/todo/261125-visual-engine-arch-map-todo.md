---
kind: todo
title: "Zero-Dependency Visual Projection Engine, Architecture Map and S1-S4 Auto-Sync"
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
task_id: visual-engine-arch-map
planned_at: 887adcbe69441de8649d7e3facede8199c3bc2ea
related_prd: ../prd/261125-visual-arch-brief-prd-prd.md
related_spec: ../specs/261125-visual-engine-arch-map-spec.md
depends_on: [feature-map-v2-topology]
scope_files: [kit/skills/lib/visual-layout.mjs, kit/skills/lib/visual-render.mjs, kit/skills/lib/architecture-map.mjs, kit/skills/lib/static-gates.mjs, kit/skills/lib/shared.mjs, kit/skills/lib/workflow-policy.mjs, kit/skills/lib/exit-codes.mjs, kit/skills/lib/subcommand-meta.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-review/scripts/review-locks.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/dev-explore/scripts/repo-map.mjs, kit/skills/dev-govern/scripts/govern-audit.mjs, kit/skills/dev-edit/scripts/edit-gate.mjs, docs/architecture-map.html, scripts/lib/artifact-executors.mjs, scripts/lib/survey-gap-rules.mjs, scripts/survey.mjs, scripts/equip.mjs, scripts/lib/equip-bootstrap.mjs, scripts/review.mjs, scripts/dev/gap-coverage.mjs, .gitattributes, references/survey.md, scripts/dev/injections-data-repo-alignment.mjs, scripts/dev/fixtures-equip.mjs, scripts/dev/fixtures-doc-closure.mjs, scripts/dev/fixtures-visual-engine.mjs, .agents/skills/]
---

# Zero-Dependency Visual Projection Engine, Architecture Map and S1-S4 Auto-Sync

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / 基线 | `feat/visual-arch-plan` @ `887adcb` |
| 任务编号 | `visual-engine-arch-map` |
| 负责人 / 审批 | planner-arch / `false` |
| 规划态 | `interactive`（边界与策略已定案，待拍板为零） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `../specs/261125-visual-engine-arch-map-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/specs/261125-visual-engine-arch-map-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-layout.mjs` (new)、`kit/skills/lib/visual-render.mjs` (new)、`kit/skills/lib/architecture-map.mjs` (new)、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-lifecycle-finalize.mjs`、`flow-lifecycle-helpers.mjs`、`flow-lifecycle-hooks.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`review-locks.mjs`、`review-pack.mjs`、`review-empirical.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`scripts/lib/artifact-executors.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/survey.mjs`、`scripts/equip.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/review.mjs`、`scripts/dev/gap-coverage.mjs`、`.gitattributes`、`references/survey.md`、`scripts/dev/injections-data-repo-alignment.mjs`、`scripts/dev/fixtures-equip.mjs`、`scripts/dev/fixtures-doc-closure.mjs`、`scripts/dev/fixtures-visual-engine.mjs` (new)。
- **复用既有模块**：切片 1 的 `kit/skills/lib/feature-map-graph.mjs` (new)（`computeFeatureMapCanonicalSha256`、`verifyArchitectureMapHeader`、`buildFallbackDomains`）、`kit/skills/lib/git.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/subcommand-meta.mjs`。
- **本期不做**：不接入 Living Visual Brief 状态机，不修改 `govern reconcile` 只读属性，也不执行本仓 `docs/feature-map.json` v2 升级与自举提交（留待切片 3）。
- **门型与回滚路径**：`one-way`；出问题经 `git revert` 回退提交并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C5: 新增 `kit/skills/lib/visual-layout.mjs` (new)、`kit/skills/lib/visual-render.mjs` (new) 与 `kit/skills/lib/architecture-map.mjs` (new)（`ARCHITECTURE_MAP_REL = 'docs/architecture-map.html'`、支持 `no-architecture-html`），渲染 `25-60 KB` 自包含零依赖 HTML（首行 `@generated ... feature-map-sha256=<sha256>`、树+泳道/DAG+Diff、`walk-bar`、源码卡、3 级 `file://` 剪贴板相对路径追问、`try/catch` `localStorage`、沙盒原型预览且零 `homedir()`），通过 `scripts/dev/fixtures-visual-engine.mjs` (new)。
- [ ] C6: 升级 `kit/skills/lib/static-gates.mjs:84` `isUiVisualFile(f, { repoRoot })`（仅调叶子模块 `feature-map-graph.mjs` (new) 无环校验，由 `kit/skills/lib/shared.mjs` 重导出）及 `review-pack.mjs`（L379、L501 `assessBehavioralGate` 传 `reviewRoot`）、`review-empirical.mjs`（L55 `determineWorkflowPolicy` 传 `repoRoot`）、`workflow-policy.mjs`/`review-gates.mjs`（`<= 798` 行）透传工作树优先根目录，替换全仓全部 6 处 `UI_VISUAL_EXT_RE`（`flow-lifecycle-helpers.mjs`、`flow-lifecycle.mjs`、`review-gates.mjs`、`review-locks.mjs` 两处、`workflow-policy.mjs`），仅豁免与 `docs/feature-map.json` SHA256 一致的 `docs/architecture-map.html` (new)。
- [ ] C7: 实现自动同步读写分离：`flow-lifecycle-finalize.mjs` `handleFinalize` 在 `git add`（L221）前渲染并暂存 `docs/architecture-map.html` (new)，`verify-tools create/sync/render` 与 `repo-map --write-feature-map` 自动渲染；`govern reconcile` 保持 `mutating: false` 只读提示；`verify` 与 `edit-gate --final` 纯只读拦截 `BLOCKED_ARCHITECTURE_MAP_DRIFT`（`EXIT.FACT` 单一档位）；新增 `verify-tools render [--check] [--out]`（含 `verify-tools.mjs:45` `printHelp()` 用法行加入 `render` 至 `sync/create/run/audit/clean/render`）直接读取 `opts.check`/`opts.out` 并对齐 4 处 `subcommand-parity` 与 `cli-parity`。
- [ ] C8: 完成 `S1-S4` 接入（`artifact-executors.mjs`、`survey-gap-rules.mjs`、`survey.mjs`、`equip.mjs`、`equip-bootstrap.mjs`、`review.mjs`、`gap-coverage.mjs`、`.gitattributes`、`references/survey.md`、`injections-data-repo-alignment.mjs`），同步 `node scripts/equip.mjs .` 并通过 `fixtures-equip.mjs`、`fixtures-doc-closure.mjs`、`fixtures-visual-engine.mjs` (new)、`gap-coverage.mjs`、`preflight.mjs` 与 `verify-injections.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 新建 `scripts/dev/fixtures-visual-engine.mjs` (new) 补齐 C5-C8 正反失败用例（Red） | `node scripts/dev/fixtures.mjs` 复现红灯 | 切片 1 合入 |
| 2 | 新建 `visual-layout.mjs` (new)、`visual-render.mjs` (new)、`architecture-map.mjs` (new) | `fixtures-visual-engine.mjs` (new) C5 转绿 | 步骤 1 |
| 3 | 升级 `isUiVisualFile`（无环）与 `shared.mjs` 重导出，替换 6 处调用；`finalize` `git add` 前渲染；落地 `verify-tools render [--check] [--out]` 与只读阻断 `BLOCKED_ARCHITECTURE_MAP_DRIFT` | `preflight.mjs` 与 `fixtures.mjs` C6-C7 转绿 | 步骤 2 |
| 4 | 完成 `S1-S4` 接入（含 `survey-gap-rules.mjs`）与 `.gitattributes`/`references/survey.md` 对齐，同步 `equip.mjs .` | `fixtures-equip.mjs`、`fixtures-doc-closure.mjs`、`gap-coverage.mjs` 转绿 | 步骤 3 |
| 5 | 补充故障注入并跑全量 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs`、`merge-gate.mjs` | 全量门禁全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `static-gates.mjs` (787 L) / `review-gates.mjs` (792 L) / `flow-lifecycle-helpers.mjs` (788 L) / `verify-tools.mjs` (737 L) 超 800 行 | 在原文件直接编写过多辅助函数 | SHA256 与首行指纹校验放叶子模块 `feature-map-graph.mjs` (new)，`review-gates.mjs` 保持 `<= 798` 行 |
| 误伤 `references/survey.md` L38 的 `I396` 注入锚点（`injections-data-repo-alignment.mjs:97`） | 意外修改 `artifactPlan` 13 项描述行 | 保持 L38 原文与 `I396` 同步对齐，不破坏 `I396` 捕获 |

## 回滚预案

- **出问题时的第一步**：`git revert <commit-sha>` 并执行 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/fixtures.mjs`。
- **回滚之后要做什么**：对已使用仓库按需加上 `no-architecture-html` 取舍保护。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 切片 1（`feature-map-v2-topology`） | `feature-map-graph.mjs` (new) 合入 `main` | 本切片开工前 | 协调者 / 审查者 |
| 切片 3（`living-brief-and-dogfood`） | 复用本切片的 `visual-layout.mjs` (new) 与 `visual-render.mjs` (new) | 本切片合并后 | 协调者 / 审查者 |

## 断点与遗留决策

- **当前状态**：`进行中`（等待本 SPEC 独立 Critique 与 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：切片 1 合并后，对 `docs/specs/261125-visual-engine-arch-map-spec.md` 完成 Critique 与 `approve` 并启动 `impl`。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
