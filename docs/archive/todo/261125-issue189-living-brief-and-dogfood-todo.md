---
kind: todo
title: "Living Visual Brief Engine, Host-Neutral Prototype Mounting and Self-Dogfooding"
status: done
created: 2026-11-25
updated: 2026-11-25
issue: 189
pr: 190
branch: feat/living-brief-and-dogfood
owner: planner-arch
plan_mode: interactive
approved: false
done_at: 2026-11-25
task_id: living-brief-and-dogfood
planned_at: 887adcbe69441de8649d7e3facede8199c3bc2ea
related_prd: ../prd/261125-visual-arch-brief-prd-prd.md
related_spec: ../specs/261125-issue189-living-brief-and-dogfood-spec.md
depends_on: [visual-engine-arch-map]
scope_files: [kit/skills/lib/visual-brief.mjs, kit/skills/dev-plan/scripts/doc-plan-brief.mjs, kit/skills/lib/session-state.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-plan/scripts/doc-plan-ops.mjs, kit/skills/lib/doc-plan-clarify.mjs, kit/skills/dev-explore/scripts/doc-locate.mjs, kit/skills/dev-explore/scripts/repo-map.mjs, kit/skills/lib/plan-next.mjs, kit/skills/dev-flow/scripts/flow-next.mjs, kit/skills/lib/handoff-package.mjs, kit/skills/lib/subcommand-meta.mjs, scripts/dev/cli-parity.mjs, templates/agents-project.md, AGENTS.md, SKILL.md, kit/skills/dev-plan/SKILL.md, kit/skills/dev-verify-tools/SKILL.md, kit/skills/dev-explore/SKILL.md, kit/skills/dev-govern/SKILL.md, references/survey.md, references/collaboration.md, docs/TDD.md, README.md, README.en.md, docs/feature-map.json, docs/architecture-map.html, .agents/skills/, scripts/dev/fixtures-living-brief.mjs]
---

# Living Visual Brief Engine, Host-Neutral Prototype Mounting and Self-Dogfooding

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / 基线 | `feat/living-brief-and-dogfood` @ `887adcb` |
| 任务编号 | `living-brief-and-dogfood` |
| 负责人 / 审批 | planner-arch / `false` |
| 规划态 | `interactive`（边界与预算已定案，待拍板为零） |
| 关联 Issue / PR / SPEC | #189 / #190 / `docs/archive/specs/261125-issue189-living-brief-and-dogfood-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261125-issue189-living-brief-and-dogfood-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-brief.mjs` (new)、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs` (new)、`kit/skills/lib/session-state.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`doc-plan-ops.mjs`、`kit/skills/lib/doc-plan-clarify.mjs`、`kit/skills/dev-explore/scripts/doc-locate.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/lib/plan-next.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/lib/handoff-package.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`scripts/dev/cli-parity.mjs`、`templates/agents-project.md`、`AGENTS.md`、`SKILL.md`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-verify-tools/SKILL.md`、`kit/skills/dev-explore/SKILL.md`、`kit/skills/dev-govern/SKILL.md`、`references/survey.md`、`references/collaboration.md`、`docs/TDD.md`、`README.md`、`README.en.md`、`docs/feature-map.json`、`docs/architecture-map.html` (new)、`scripts/dev/fixtures-living-brief.mjs` (new)。
- **复用既有模块**：切片 2 的 `kit/skills/lib/visual-layout.mjs` (new) 与 `visual-render.mjs` (new)、`kit/skills/lib/plan-next.mjs`、`kit/skills/lib/plan-index.mjs`、`kit/skills/lib/doc-slice-graph.mjs`（`buildSliceGraph`、`evaluateSliceGraph`）、`kit/skills/lib/session-state.mjs`、`kit/skills/lib/ledger.mjs`。
- **本期不做**：不绑定特定 AI 宿主目录或外部浏览器驱动库；不破坏既有 `session-state.json` 6144 B 配额与 `doc-locate.mjs` 默认零写入不变量。
- **门型与回滚路径**：`one-way`；出现问题经 `git revert` 反向提交并重跑 `compose-agents.mjs .` 与 `equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C9: 新增 `kit/skills/lib/visual-brief.mjs` (new) 与 `kit/skills/dev-plan/scripts/doc-plan-brief.mjs` (new)，实现仓外 `<gitCommonDir>/project-forge-flow/briefs/<briefKey>.{json,html}` 与 `-prototypes/` Single-Truth 实时投影（`workRoot` 优先于 `mainRoot`，使用 `buildSliceGraph`/`evaluateSliceGraph`）、1:N 迁移与 `slice --prd` 确定性派生 `parentBriefKey`、`confirmedState: stale`、原型暂存（拒绝 `> 512 KB` 及非 `http`/`https`/`file` URI）与 `pruneStaleBriefs`，通过 `scripts/dev/fixtures-living-brief.mjs` (new) 正反与负向断言。
- [x] C10: 抽离 `doc-plan.mjs` 处理器至 `doc-plan-brief.mjs` (new)/`doc-plan-ops.mjs` 使其 `< 790` 行且全 `.mjs <= 800` 行，完成 `session-state.mjs`、`doc-plan.mjs`（Case 3/4 自动刷新、`brief` 使用 `--open-browser` 避免 `--open` 冲突、将 `--prototype`/`--select-prototype`/`--confirm`/`--open-browser`/`--source-skill`/`--verdict`/`--affected-feature`/`--flow-delta` 注册进 `printHelp()` 并在 `doc-plan-brief.mjs` (new) 读取、4 处对拍与 `cli-parity.mjs` `DARK_BASELINE` 同步）、`doc-plan-ops.mjs`、`doc-plan-clarify.mjs`、`doc-locate.mjs`（仅 `--topic` 刷新）、`repo-map.mjs --topic`、`plan-next.mjs`、`flow-next.mjs` 与 `handoff-package.mjs` 接入，通过 `preflight.mjs` 与 `fixtures.mjs`。
- [x] C11: 在预算内完成 `templates/agents-project.md`（`<= +500 B`、`AGENTS.md < 24576 B`）、根 `SKILL.md`（`<= +400 B`、`< 16384 B`）、`kit/skills/dev-plan/SKILL.md` / `kit/skills/dev-verify-tools/SKILL.md` / `kit/skills/dev-explore/SKILL.md` / `kit/skills/dev-govern/SKILL.md`（`< 14336 B` 且 `<= 180` 行）、`references/survey.md`/`collaboration.md`、`docs/TDD.md`、双语 `README.md`/`README.en.md` 同步，通过 `sync-toc.mjs --check` 与 `compose-agents.mjs . --check`。
- [x] C12: 升级本仓 `docs/feature-map.json` 至 v2 并渲染提交 `docs/architecture-map.html` (new)，运行 `equip.mjs .`，全绿通过全套门禁（`preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs`、`e2e-zip-harness.mjs`、`review.mjs .`、`govern-audit.mjs audit . --strict`）及真实浏览器浅深色主题视觉实证（附 `--artifact`）。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 新建 `scripts/dev/fixtures-living-brief.mjs` (new) 补齐 C9-C10 正反及 `stale`/`>512KB`/危险 URI 负向用例（Red） | `node scripts/dev/fixtures.mjs` 复现红灯 | 切片 2 合入 |
| 2 | 新建 `visual-brief.mjs` (new) 与 `doc-plan-brief.mjs` (new)，抽离 `doc-plan.mjs` 处理器（`< 790` L）并完成 9 处薄接入 | `fixtures-living-brief.mjs` (new) 与 `preflight.mjs` C9-C10 转绿 | 步骤 1 |
| 3 | 在严格预算内更新 `templates/agents-project.md`、`SKILL.md`、`kit/skills/*/SKILL.md`、`references/`、`docs/TDD.md` 与双语 `README` | `compose-agents.mjs . --check`、`sync-toc.mjs --check` 与 `preflight.mjs` 全绿 | 步骤 2 |
| 4 | 升级本仓 `docs/feature-map.json` 至 v2、生成 `docs/architecture-map.html` (new)、执行 `equip.mjs .` | `verify-tools.mjs audit .` 与 `govern-audit.mjs audit . --strict` 全绿 | 步骤 3 |
| 5 | 在真实浏览器验证 `docs/architecture-map.html` (new) 与 Living Brief 浅深色交互（保存 `--artifact`）并跑全量门禁 | `fixtures.mjs`、`verify-injections.mjs`、`e2e-zip-harness.mjs`、`merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `doc-plan.mjs` (796 L) 或 `AGENTS.md` (23108 B) 触顶 | 直接在原文件追加逻辑或大段文案 | 必须将旧处理逻辑与 `brief` 抽入 `doc-plan-brief.mjs` (new)/`doc-plan-ops.mjs` 使其 `< 790` L；`templates/agents-project.md` 增量 `<= +500 B` |
| `kit/skills/*/SKILL.md` 误删契约关键词或超 14KB | 增补说明过多 | 改动后立即运行 `preflight.mjs` 核对 `preflight-contracts.mjs` 与字节上限 |

## 回滚预案

- **出问题时的第一步**：`git revert <commit-sha>` 并重跑 `node scripts/compose-agents.mjs .` 与 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/fixtures.mjs`。
- **回滚之后要做什么**：清理仓外残留测试目录并确认 `docs/TDD.md` 与 `docs/feature-map.json` 一致。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 切片 2（`visual-engine-arch-map`） | `visual-layout.mjs` (new)、`visual-render.mjs` (new) 与 `isUiVisualFile` 合入 `main` | 本切片开工前 | 协调者 / 审查者 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`
- **待拍板事项**：无
- **下一步第一件事**：归档并提交 PR，移交独立审查。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`preflight.mjs`（41/41 通过）、`fixtures.mjs`（含新增 `fixtures-living-brief.mjs` 4/4 正反及负向断言）、`cli-parity.mjs`、`subcommand-parity.mjs`、`verify-tools.mjs audit .`、`verify-tools.mjs render --check`、`govern-audit.mjs audit . --strict`、`review.mjs .`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`sync-toc.mjs --check`、`flow verify --mode gate`（`merge-gate.mjs` 12/12）与真实无头浏览器渲染实证全绿。
- **文档同步检查**：已同步 `templates/agents-project.md`、`AGENTS.md`（23272 B < 24576 B）、根 `SKILL.md`（14490 B <= 16384 B）、`kit/skills/{dev-plan,dev-verify-tools,dev-explore,dev-govern}/SKILL.md`（均 < 14336 B 且 <= 180 L）、`references/survey.md`、`references/collaboration.md`、`docs/TDD.md`、`README.md`、`README.en.md`、`docs/feature-map.json` v2、`docs/architecture-map.html` 与 `.agents/skills/`。
- **遗留问题**：无。
