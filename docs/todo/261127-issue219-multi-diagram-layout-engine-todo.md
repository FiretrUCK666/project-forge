---
kind: todo
title: 零依赖 10 类图表布局引擎与避障正交路由器
status: active
created: 2026-11-27
updated: 2026-11-27
issue: 219
pr: null
branch: feat/multi-diagram-layout-engine
owner: plan-studio-b
plan_mode: interactive
approved: false
done_at: null
task_id: multi-diagram-layout-engine
planned_at: 76795202dbd2d328d379fbff506b7dad39753133
related_prd: ../prd/261127-issue219-visual-studio-archify-v2-prd.md
related_spec: ../specs/261127-issue219-multi-diagram-layout-engine-spec.md
---

# 零依赖 10 类图表布局引擎与避障正交路由器

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/multi-diagram-layout-engine` @ `7679520` |
| 任务编号 | `multi-diagram-layout-engine` |
| 负责人 / 审批 | plan-studio-b / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | #219 / 未关联 / `docs/specs/261127-issue219-multi-diagram-layout-engine-spec.md` |

- **断点恢复**：接手人先核对 Wave 1（`zero-token-static-analyzer`）是否已合入 `main` 且本切片已获批。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-router.mjs` (new)、`kit/skills/lib/visual-layout-diagrams.mjs` (new)、`kit/skills/lib/visual-layout-charts.mjs` (new)、`kit/skills/lib/visual-geometry-check.mjs` (new)、`kit/skills/lib/visual-layout.mjs`、`scripts/dev/fixtures-visual-layout-v2.mjs` (new)、`scripts/dev/injections-data-visual-layout-v2.mjs` (new)、`docs/feature-map.json`、`docs/architecture-map.html`
- **复用既有模块**：Wave 1 静态分析与证据输出（`static-analyzer.mjs`、`static-evidence.mjs`、`diff-materiality.mjs`）及 `kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/feature-map-graph.mjs`
- **本期不做**：不改造前端 HTML/CSS/JS 模板，不依赖无头浏览器做渲染期校验
- **门型与回滚路径**：`one-way`（高风险路径 `kit/`）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [x] C5: Clean-Room 布局引擎（`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-layout-diagrams.mjs` (new)、`kit/skills/lib/visual-layout-charts.mjs` (new)，每文件 `<= 800` 行且零 npm 依赖）完整实现 `architecture`、`workflow`、`tree`（轮廓排布 + `>= 3` 叶子叠放）、`erd`、`class`（半列步进）、`sequence`、`lifecycle`（主干脊柱 + 顶弧）、`dataflow`、`timeline`（静默断口压缩）与实测 `waterfall` 共 10 类图表布局，重复执行输出字节级一致。
- [x] C6: `kit/skills/lib/visual-router.mjs` (new) 实现端口防重叠散布、同侧共享干线捆绑与紧凑避障网格 Dijkstra 正交路由，复杂有障碍布局中连线穿盒次数为 `0` 且同侧多边端口互不重合。
- [x] C7: `kit/skills/lib/visual-geometry-check.mjs` (new) 在零浏览器依赖下确定性检出 `NODE_OVERLAP`、`OUT_OF_BOUNDS`、`EDGE_CROSSES_BOX` 与 `EMPTY_ACTIVE_DIAGRAM`，正向 10 类图全过、负向人工注入重叠或穿盒必报违例。
- [x] C8: `scripts/dev/fixtures-visual-layout-v2.mjs` (new) 与 `scripts/dev/injections-data-visual-layout-v2.mjs` (new) 正反双向断言及故障注入全绿，且既有 `fixtures-visual-engine.mjs` 零回归；同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs . --check`，`node scripts/dev/preflight.mjs` 退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先补失败测试 `scripts/dev/fixtures-visual-layout-v2.mjs` (new)（10 类图布局、端口散布与避障路由、几何碰撞正反用例） | `node scripts/dev/fixtures.mjs --domain visual-layout-v2` 必红 | Wave 1 合入且本切片获批 |
| 2 | 实现 `visual-router.mjs`、`visual-layout-diagrams.mjs`、`visual-layout-charts.mjs` 与 `visual-geometry-check.mjs` | 单元测试与几何自检初通 | 步骤 1 |
| 3 | 升级并瘦身 `kit/skills/lib/visual-layout.mjs`，确保既有 `fixtures-visual-engine.mjs` 与 `I964` 锚点零回归 | `node scripts/dev/fixtures.mjs --domain visual-layout-v2` 与 `--domain visual-engine` 全绿 | 步骤 2 |
| 4 | 补齐故障注入 `scripts/dev/injections-data-visual-layout-v2.mjs` (new)，同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs .` | `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿 | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`进行中`（依赖 `zero-token-static-analyzer`）
- **待拍板事项**：无
- **下一步第一件事**：Wave 1 合入且本切片获批后，先编写 `scripts/dev/fixtures-visual-layout-v2.mjs` (new) 失败断言并实现 `kit/skills/lib/visual-router.mjs` (new)。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`：PASS（168 项同步，0 语法/ABI 错误）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json`：PASS（`ok: true`, 0 blockers）
  - `node scripts/dev/fixtures.mjs --domain visual-layout-v2`：4/4 PASS
  - `node scripts/dev/fixtures.mjs --domain visual-engine`：6/6 PASS（4 功能 HTML `<= 60 KB`，`I964` 保持完好）
  - `node scripts/dev/merge-gate.mjs`：全量 12/12 PASS
  - `node scripts/dev/verify-injections.mjs --jobs 4`：全量故障注入 100% PASS（含新增 `I1011..I1015` 与既有 `I964`）
- **文档同步检查**：已同步 `docs/feature-map.json`、`docs/architecture-map.html`（`verify-tools.mjs render . --check` PASS，0 脏节点）、SPEC `## 实现说明`、Todo `C5..C8` 与 `.agents/skills/`。
- **遗留问题**：无（Wave 3 将接入前端 Studio UI/UX 渲染层与真浏览器浅/深色截图实证）。
