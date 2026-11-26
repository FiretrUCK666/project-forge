---
kind: todo
title: "Universal Doc Graph, Evergreen Hygiene, Case 5 and Brief UX"
status: done
created: 2026-11-26
updated: 2026-11-26
issue: 206
pr: 208
branch: feat/doc-graph-evergreen-brief
owner: planner-arch
plan_mode: interactive
approved: false
done_at: 2026-11-26
task_id: doc-graph-evergreen-brief
planned_at: ff2c31b7e9e6762e233fecc57486ddfe04aa085d
related_prd: ../../prd/261126-suite-cohesion-v2-prd.md
related_spec: ../specs/261126-issue206-doc-graph-evergreen-brief-spec.md
depends_on: []
scope_files: [kit/skills/lib/doc-graph.mjs, kit/skills/lib/profile.mjs, kit/skills/lib/markdown-scan.mjs, kit/skills/lib/context-brief.mjs, kit/skills/dev-govern/scripts/govern-evergreen.mjs, kit/skills/dev-govern/scripts/govern-docs.mjs, kit/skills/dev-govern/scripts/govern-audit.mjs, kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs, kit/skills/dev-review/scripts/review-context.mjs, scripts/survey.mjs, scripts/lib/survey-scan.mjs, scripts/lib/survey-plan.mjs, kit/skills/dev-plan/scripts/doc-plan-brief.mjs, kit/skills/dev-plan/scripts/doc-plan-ops.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-plan/SKILL.md]
---

# Universal Doc Graph, Evergreen Hygiene, Case 5 and Brief UX

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / 基线 | `feat/doc-graph-evergreen-brief` @ `ff2c31b` |
| 任务编号 | `doc-graph-evergreen-brief` |
| 负责人 / 审批 | planner-arch / `false` |
| 规划态 | `interactive`（边界与不变量已定案，待拍板为零） |
| 关联 Issue / PR / SPEC | #206 / #208 / `docs/archive/specs/261126-issue206-doc-graph-evergreen-brief-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261126-issue206-doc-graph-evergreen-brief-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/doc-graph.mjs` (new)、`kit/skills/lib/profile.mjs`、`kit/skills/lib/markdown-scan.mjs`、`kit/skills/lib/context-brief.mjs`、`kit/skills/dev-govern/scripts/govern-evergreen.mjs`、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs`、`kit/skills/dev-review/scripts/review-context.mjs`、`scripts/survey.mjs`、`scripts/lib/survey-scan.mjs`、`scripts/lib/survey-plan.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/SKILL.md`。
- **复用既有模块**：`kit/skills/lib/markdown-scan.mjs`、`kit/skills/lib/doc-frontmatter.mjs`、`kit/skills/lib/visual-brief.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`。
- **本期不做**：不修改切片二与切片三作用域内的实证门禁、合并与评论模块；不碰 `scripts/lib/survey-docs.mjs`。
- **门型与回滚路径**：`one-way`；出现异常通过 `git revert` 反向提交并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C1: 新增叶子模块 `kit/skills/lib/doc-graph.mjs` (new)（仅导入 `node:fs`、`node:path`、`./git.mjs`、`./markdown-scan.mjs`、`./doc-frontmatter.mjs`）实现 `accountActiveDocs` 与 4 项图谱校验（`brokenLinks`/`brokenAnchors` 含独立 `anchorWarnings`、`cycles`、`redirectChains`、`entryDivergenceAndOrphans`），支持非 Markdown 权威对象，移除 `CLASSIC_EVERGREEN_RE` 与 `profile.mjs:717` 自然语言正则，修复 `profile.mjs:378` `activeRawKey` 并保留 L537 `I217`，经 `node scripts/dev/fixtures.mjs` 验证通过。
- [x] C2: 将 `docGraph` 单源接入 `govern-evergreen.mjs`（保留 L136 `I218`）、`govern-audit.mjs`（含 L395 目录前缀匹配对齐）、`govern-docs.mjs`、`verify-tools-audit.mjs`（`resolveDocAnchor` + 目录前缀匹配）、`review-context.mjs`、`context-brief.mjs` 及 `scripts/survey.mjs`/`scripts/lib/survey-scan.mjs`/`scripts/lib/survey-plan.mjs`（S1 探索注入且 `explorationStrategy` `--check` 通过、`survey-docs.mjs <= 791` 行），经 `node scripts/dev/fixtures.mjs` 验证通过。
- [x] C3: 修复 Case 5/3 与 Brief UX：`doc-plan-brief.mjs` L169 支持 `result.caseType >= 3`、Case 5 结构化 `nextSteps`、保留 L197 `I934`、Case 3 路由至 `doc-plan.mjs init --kind todo`；`doc-plan-ops.mjs` 对 `tdd` 生成简报；`doc-plan.mjs` `init` 输出 `htmlUri` 且 Case 4 `approve` 带 `--agent`；更新 `kit/skills/dev-plan/SKILL.md`（`<= 14336` B 且 `<= 180` 行），经 `node scripts/dev/preflight.mjs` 与 `fixtures.mjs` 验证通过。
- [x] C4: 执行 `node scripts/equip.mjs .` 同步，补齐正反双向夹具（`fixtures-r8-bugfixes.mjs:379` 通过），全绿通过 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4` 与 `merge-gate.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补充 `doc-graph`、前缀匹配、Case 5/3 与 Brief 失败断言（Red） | `node scripts/dev/fixtures.mjs` 复现失败 | 无 |
| 2 | 新建 `kit/skills/lib/doc-graph.mjs` (new)，改造 `markdown-scan.mjs` 与 `profile.mjs` | `node scripts/dev/fixtures.mjs` C1 转绿 | 步骤 1 |
| 3 | 接入 `govern-*`、`verify-tools-audit.mjs`、`review-context.mjs`、`context-brief.mjs` 与 `survey*.mjs` | `node scripts/dev/fixtures.mjs` C2 转绿 | 步骤 2 |
| 4 | 改造 `doc-plan-brief.mjs`、`doc-plan-ops.mjs`、`doc-plan.mjs` 与 `kit/skills/dev-plan/SKILL.md` | `node scripts/dev/preflight.mjs` 与 C3 转绿 | 步骤 3 |
| 5 | 执行 `node scripts/equip.mjs .` 并跑全量门禁与故障注入 | `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4`、`merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `doc-graph.mjs` (new) 与 `profile.mjs` 循环导入 | `doc-graph.mjs` 反向 import `profile.mjs` | 严守单向依赖：仅 `profile.mjs` 或消费方引入 `doc-graph.mjs` |
| 破坏 `I217` / `I218` / `I934` 锚点 | 重构改动目标行字符串 | 保留 3 处字面量并通过 `verify-injections.mjs` 验真 |

## 回滚预案

- **出问题时的第一步**：执行 `git revert HEAD` 并重跑 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/fixtures.mjs`。
- **回滚之后要做什么**：恢复原 `discoverEvergreenDocs` 路径并更新关联任务状态。

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（等待总控 PRD 与本 SPEC 独立 Critique 及 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：完成总控 PRD 与本切片 SPEC 的独立 Critique，再经 `approve` 启动实施工作区。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`：通过（`157` 个套件文件字节级一致）。
  - `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render . --check`：通过（`docs/architecture-map.html` 同步）。
  - `node scripts/compose-agents.mjs . --check`：通过（`AGENTS.md` 23299 B，标记成对）。
  - `node scripts/dev/preflight.mjs`：通过（41/41 项全绿，`kit/skills/dev-plan/SKILL.md` 93 行 / 13286 B）。
  - `node scripts/dev/fixtures.mjs --jobs 6`：通过（含 `fixtures-doc-graph.mjs` 4 项、`fixtures-r8-bugfixes.mjs` 10 项、`fixtures-survey.mjs` 13 项、`fixtures-iterate-evolution.mjs` 12 项、`fixtures-living-brief.mjs` 5 项、`fixtures-w6c-context-brief.mjs` 3 项，共 583 项全过）。
  - `node scripts/dev/verify-injections.mjs --jobs 4`：全量通过（`I217`/`I218`/`I227`/`I934` 等全部红灯拦截）。
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json`：0 阻断（`blockers: 0`）。
- **文档同步检查**：已同步 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`kit/skills/dev-plan/SKILL.md` 与 `.agents/skills/`。
- **遗留问题**：无。
