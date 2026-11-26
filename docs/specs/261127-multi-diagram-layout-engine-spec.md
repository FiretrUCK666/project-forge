---
kind: spec
title: 零依赖 10 类图表布局引擎与避障正交路由器
status: draft
tier: L3
created: 2026-11-27
updated: 2026-11-27
issue: null
pr: null
branch: feat/visual-studio-archify-v2
owner: plan-studio-b
plan_mode: interactive
approved: false
implemented: false
plan_critique: pending
related_prd: ../prd/261127-visual-studio-archify-v2-prd.md
related_todo: ../todo/261127-multi-diagram-layout-engine-todo.md
task_id: multi-diagram-layout-engine
scope_files:
  - kit/skills/lib/visual-router.mjs
  - kit/skills/lib/visual-layout-diagrams.mjs
  - kit/skills/lib/visual-layout-charts.mjs
  - kit/skills/lib/visual-geometry-check.mjs
  - kit/skills/lib/visual-layout.mjs
  - scripts/dev/fixtures-visual-layout-v2.mjs
  - scripts/dev/injections-data-visual-layout-v2.mjs
  - docs/feature-map.json
  - docs/architecture-map.html
depends_on:
  - zero-token-static-analyzer
high_risk_paths:
  - kit/
---

# 零依赖 10 类图表布局引擎与避障正交路由器 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块布局与路由引擎重构，触及高风险路径 `kit/`；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / Issue / PR | `feat/visual-studio-archify-v2` / 未关联 / 未关联 |
| 负责人 / 内审状态 | `plan-studio-b` / `pending` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 PRD / Todo | `docs/prd/261127-visual-studio-archify-v2-prd.md` / `docs/todo/261127-multi-diagram-layout-engine-todo.md` |

- **变更一句话**：以 MIT Clean-Room 纯 Node 18+ 模块化引擎实现 10 类图表的确定性坐标布局、端口散布 + 干线捆绑 + 避障网格 Dijkstra 正交路由，以及零浏览器依赖的纯 Node 几何自检器。

## 系统变更全景

```mermaid
flowchart LR
  Ev["多图证据数据"] --> Core["visual-layout"]
  Core --> Diag["结构类四图布局"]
  Core --> Chart["流程时序四图"]
  Diag --> Router["visual-router"]
  Chart --> Router
  Router --> Geo["几何碰撞自检"]
  Geo --> Out["确定性视觉模型"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/visual-router.mjs` | 新增 | 端口防重叠散布、同侧共享干线捆绑、紧凑避障网格 Dijkstra 最短路径路由与圆角正交 SVG path 生成 |
| `kit/skills/lib/visual-layout-diagrams.mjs` | 新增 | `tree`（轮廓紧凑排布 + `>= 3` 叶子垂直叠放）、`erd`（分层实体网格）、`class`（半列步进继承层次）、`sequence`（生命线与消息序列）布局器 |
| `kit/skills/lib/visual-layout-charts.mjs` | 新增 | `lifecycle`（主干脊柱 + 顶部跨跳弧）、`dataflow`（阶段管道流）、`timeline`（长静默区间自动压缩断口）、`waterfall`（实测耗时甘特条）布局器 |
| `kit/skills/lib/visual-geometry-check.mjs` | 新增 | 纯 Node 确定性 SVG 几何校验器：零 Chrome 依赖，检测节点重叠、画布越界、连线穿盒与空图违规 |
| `kit/skills/lib/visual-layout.mjs` | 修改 | 升级 `architecture` 与 `workflow` 接入 `visual-router.mjs`，并将多图证据接入 `buildVisualModel`，同时瘦身维持 `<= 650` 行 |
| `scripts/dev/fixtures-visual-layout-v2.mjs` | 新增 | 10 类图表布局确定性、正交避障路由与几何自检正反双向夹具（覆盖 `C5..C8`） |
| `scripts/dev/injections-data-visual-layout-v2.mjs` | 新增 | 布局冲突、路由穿盒与几何校验门禁退化故障注入 |
| `docs/feature-map.json`、`docs/architecture-map.html` | 修改 | 登记新增视觉布局/路由/几何校验模块并刷新干净常青架构图 |

## 一、背景与边界声明

- **要改什么**：将 `kit/skills/lib/visual-layout.mjs`（现 691 行）从仅支持 2 类图升级为模块化 10 类图布局与正交避障路由体系，并内置纯 Node 几何质量校验。
- **不改什么**：本波次不改动 HTML/CSS/JS 前端模板（`visual-render*.mjs` 与 `visual-brief.mjs` 保持向后兼容既有 `tree` 与 `flow` 字段，Wave 3 再全面切换 Studio 渲染器）。
- **本期不做**：不调用无头浏览器或外部布局库（如 dagre/elkjs/graphviz）；不直接生成客户端交互 JS。
- **复用既有模块**：Wave 1 产出的 `kit/skills/lib/static-analyzer.mjs` (new)、`kit/skills/lib/static-evidence.mjs` (new)、`kit/skills/lib/diff-materiality.mjs` (new)，以及既有 `kit/skills/lib/feature-map-graph.mjs`、`kit/skills/lib/visual-layout.mjs`。
- **架构基线关系**：遵循 `arch-rules` 与零第三方依赖红线，所有新增与修改 `.mjs` 文件均严格 `<= 800` 行（依据：`docs/TDD.md`）。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **`kit/skills/lib/visual-router.mjs`（预计 `<= 420` 行）**：
   - 导出 `spreadSidePorts(box, side, count, pad = 16)`：按边长与连线数量均匀散布端口坐标，禁止多条边重合在单一中心点。
   - 导出 `bundleSharedTrunk(edges, boxMap)`：对同一源节点或同侧目标簇提取共享垂直/水平干线坐标，再分叉至目标散布端口。
   - 导出 `routeOrthogonalObstacleGrid(srcPort, dstPort, obstacles, { clearance = 14, bendPenalty = 18, maxGridAxis = 64 } = {})`：
     - 基于节点扩展包围盒（`box +/- clearance`）与端口坐标构建紧凑非均匀正交坐标网格（轴向坐标去重压缩在 `<= 64` 级）。
     - 运行纯 JS 二叉堆 Dijkstra 最短路，目标代价 = `曼哈顿距离 + 拐弯惩罚 * 转角数`，所有落入障碍盒内部的网格边标记为不可通行（仅起点/终点脱壳段允许离开源/目标盒）。
     - 导出 `roundedOrthogonalPath(pts, radius = 10)`（从 `visual-layout.mjs` 下沉为单一真相源）。
2. **`kit/skills/lib/visual-layout-diagrams.mjs`（预计 `<= 520` 行）**：
   - `layoutTreeDiagram(evidence, opts)`：递归轮廓紧凑排布（Clean-Room contour packing），同一父节点下有 `>= 3` 个叶子节点时自动切换为紧凑垂直叠放列表，防止树图水平爆炸。
   - `layoutErdDiagram(evidence, opts)`：按外键引用层级排布实体分层网格，每张实体卡按字段数精确计算高度，调用 `visual-router.mjs` 路由关系连线并附基数标签（`1:N`/`1:1`）。
   - `layoutClassDiagram(evidence, opts)`：拓扑分层 + 半列步进（half-col）水平交错排布，清晰区分继承（实线空心三角）与接口实现（虚线空心三角）。
   - `layoutSequenceDiagram(evidence, opts)`：顶部参与者列头 + 垂直生命线 + 按时间步严格递增的水平消息箭头与自调用环，避免消息文字互相覆盖。
3. **`kit/skills/lib/visual-layout-charts.mjs`（预计 `<= 480` 行）**：
   - `layoutLifecycleDiagram(evidence, opts)`：提取最长无环主路径排布为水平主干脊柱（spine），异常/回退/跨跳迁移采用顶部拱形或避障正交跳弧并标注迁移事件。
   - `layoutDataflowDiagram(evidence, opts)`：按 `needs`/阶段拓扑分层，生成分阶段通道列与节点流转边。
   - `layoutTimelineDiagram(evidence, opts)`：按时间戳排序里程碑；当相邻事件间隔超过中位间隔 `4x` 时自动插入视觉压缩断口（quiet-gap break）标记，消除大段空白。
   - `layoutWaterfallDiagram(evidence, opts)`：仅消费真实实测 `telemetrySpans`，按总时长计算水平时间轴与嵌套 span 甘特条坐标。
4. **`kit/skills/lib/visual-geometry-check.mjs`（预计 `<= 280` 行）**：
   - 导出 `verifyDiagramGeometry(diagramLayout, { allowContainerOverlap = true } = {})`：
     - 机械校验 4 类几何缺陷：`NODE_OVERLAP`（任意两同级非容器节点包围盒面积交集 `> 0`）、`OUT_OF_BOUNDS`（节点或路径控制点越出 `[0..width, 0..height]`）、`EDGE_CROSSES_BOX`（正交路径非端点线段穿过非起止节点内部）、`EMPTY_ACTIVE_DIAGRAM`（已激活图节点数为 `0`）。
     - 返回 `{ ok, stats: { nodeCount, edgeCount, overlaps, crossings, outOfBounds }, violations }`。
5. **`kit/skills/lib/visual-layout.mjs` 升级契约（瘦身至 `<= 620` 行）**：
   - 保留既有导出 `DIFF_STATES`、`escapeHtml`、`escapeXml`、`escapeJsonForScript`、`toRelPath`、`sanitizeSafeHref`、`sanitizeSafeImgSrc`、`truncateLabel`、`computeDiffOverlay`、`layoutDomainTree`、`layoutFlowDag`、`buildVisualModel`（100% 向后兼容 Wave 3 之前的调用方与现有测试）。
   - `buildVisualModel` 新增可选入参 `evidence`（来自 `static-evidence.mjs`）与 `analysis`（来自 `static-analyzer.mjs`），在返回对象中新增 `diagrams` 字典（按激活图类型映射布局结果）、`activeTabs` 与 `geometryReport`。

### 数据与状态变更

- 本次不涉及持久化文件或磁盘 Schema 变更；全模块均为纯内存确定性计算。

### 异常、回退与安全边界

- 当复杂密图导致避障网格在极少数情况下无严格无碰撞通路时，`routeOrthogonalObstacleGrid` 退化为外围走廊包绕路径并标记 `routedFallback: true`，永不陷入死循环或返回 `NaN` 坐标。
- 所有文本长度计算复用 `displayWidth`（全角计 2、ASCII 计 1），确保中英文混排节点高度与截断长度确定且一致。

### 实现顺序

1. 创建 `kit/skills/lib/visual-router.mjs` 并将 `roundedOrthogonalPath` 下沉，接入 `visual-layout.mjs` 的 `architecture` 与 `workflow`。
2. 创建 `kit/skills/lib/visual-layout-diagrams.mjs` 与 `kit/skills/lib/visual-layout-charts.mjs` 实现其余 8 类图表布局。
3. 创建 `kit/skills/lib/visual-geometry-check.mjs` 并在 `buildVisualModel` 接入全部 10 类图输出。
4. 编写 `scripts/dev/fixtures-visual-layout-v2.mjs` 与 `scripts/dev/injections-data-visual-layout-v2.mjs`，同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs .`。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| Clean-Room 紧凑避障网格 Dijkstra + 纯 Node 几何自检（已选） | 按节点扩展盒建非均匀稀疏网格，零依赖精确避障并毫秒级自检 | 零第三方依赖、确定性字节一致、无需渲染期起 Chrome | 图规模超 500 节点导致网格超限时，可增加层次聚类折叠 |
| 每次渲染启动无头 Chrome 测真实 DOM bbox | 用 Puppeteer/Playwright 渲染后读 `getBoundingClientRect` | 拖慢 CI 与日常 `verify-tools render` 至数秒级且违反零外部浏览器硬依赖 | 仅在 Wave 3 UI 视觉验收阶段用 `shoot.mjs` 截图实证，绝不放进生产渲染路径 |
| 沿用旧版固定侧道折线公式 | 只靠域索引和固定偏移 `lane` 拼折线 | 节点增多或同域多边时必定穿盒与端口重叠 | 永不回退 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/visual-router.mjs` | 新增 | 端口散布、干线捆绑、紧凑网格 Dijkstra 路由、圆角路径 | `visual-layout*.mjs` |
| `kit/skills/lib/visual-layout-diagrams.mjs` | 新增 | `tree`、`erd`、`class`、`sequence` 布局器 | `visual-layout.mjs` |
| `kit/skills/lib/visual-layout-charts.mjs` | 新增 | `lifecycle`、`dataflow`、`timeline`、`waterfall` 布局器 | `visual-layout.mjs` |
| `kit/skills/lib/visual-geometry-check.mjs` | 新增 | 纯 Node 确定性 SVG 几何碰撞/穿盒/越界校验 | `visual-layout.mjs`、回归夹具 |
| `kit/skills/lib/visual-layout.mjs` | 修改 | 接入新路由器与 10 类图布局分发，保持旧字段向后兼容 | `architecture-map.mjs`、`visual-brief.mjs`、`visual-render.mjs` |
| `scripts/dev/fixtures-visual-layout-v2.mjs` | 新增 | 10 类图表布局、路由与几何自检双向夹具 | `scripts/dev/fixtures.mjs` |
| `scripts/dev/injections-data-visual-layout-v2.mjs` | 新增 | 布局/路由/几何校验故障注入 | `scripts/dev/verify-injections.mjs` |
| `docs/feature-map.json`、`docs/architecture-map.html` | 修改 | 注册新增模块并刷新干净常青架构图 | 全仓治理与自检 |

- **对外可见的变化**：`buildVisualModel` 向后兼容新增 `diagrams`、`activeTabs` 与 `geometryReport` 字段；既有 `tree`/`flow` 输出保持兼容。
- **需要同步改的地方**：`node scripts/equip.mjs .`、`docs/feature-map.json`、`docs/architecture-map.html`。

## 五、冻结的验收标准

<!-- criteria:start -->
- [ ] C5: Clean-Room 布局引擎（`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-layout-diagrams.mjs`、`kit/skills/lib/visual-layout-charts.mjs`，每文件 `<= 800` 行且零 npm 依赖）完整实现 `architecture`、`workflow`、`tree`（轮廓排布 + `>= 3` 叶子叠放）、`erd`、`class`（半列步进）、`sequence`、`lifecycle`（主干脊柱 + 顶弧）、`dataflow`、`timeline`（静默断口压缩）与实测 `waterfall` 共 10 类图表布局，重复执行输出字节级一致。
- [ ] C6: `kit/skills/lib/visual-router.mjs` 实现端口防重叠散布、同侧共享干线捆绑与紧凑避障网格 Dijkstra 正交路由，复杂有障碍布局中连线穿盒次数为 `0` 且同侧多边端口互不重合。
- [ ] C7: `kit/skills/lib/visual-geometry-check.mjs` 在零浏览器依赖下确定性检出 `NODE_OVERLAP`、`OUT_OF_BOUNDS`、`EDGE_CROSSES_BOX` 与 `EMPTY_ACTIVE_DIAGRAM`，正向 10 类图全过、负向人工注入重叠或穿盒必报违例。
- [ ] C8: `scripts/dev/fixtures-visual-layout-v2.mjs` 与 `scripts/dev/injections-data-visual-layout-v2.mjs` 正反双向断言及故障注入全绿，且既有 `fixtures-visual-engine.mjs` 零回归；同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs . --check`，`node scripts/dev/preflight.mjs` 退出码 `0`。
<!-- criteria:end -->

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（改造 `kit/skills/lib/visual-layout.mjs` 并新增公共布局与路由内核）；回滚做法：反向提交本切片 PR 并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`。
- **高风险路径**：`kit/`（特别是 `kit/skills/lib/visual-layout.mjs` 与 `scripts/dev/injections-data-visual-engine.mjs` 中的 `I964` 协议安全校验锚点，须确保 `sanitizeSafeHref` 原有安全校验不被意外破坏）。
- **故障注入预演**：至少注入 4 类退化故障——`tree` 关闭 `>= 3` 叶子叠放、`timeline` 关闭静默断口压缩、`visual-router` 关闭障碍盒拦截导致穿盒、`visual-geometry-check` 放行节点重叠——全部由 `verify-injections.mjs` 捕红。

## 澄清与补充记录

- 已确认：布局与路由全部以纯 Node 确定性数学计算完成，渲染期不引入任何浏览器依赖。

## 实现说明

- **实际落地摘要**：
- **与草案的差异**：
- **关联同步文件**：
