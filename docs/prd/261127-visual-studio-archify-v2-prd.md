---
kind: prd
title: 零 Token 多图视觉 Studio 与第一性原理 UI 重构
status: draft
created: 2026-11-27
updated: 2026-11-27
issue: null
pr: null
owner: plan-studio-b
plan_mode: interactive
plan_critique: pending
related_spec: null
related_todo: null
multi_spec: true
---

# 零 Token 多图视觉 Studio 与第一性原理 UI 重构 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-27` / `2026-11-27` |
| 关联 Issue / PR | 未关联 / 未关联 |
| 提出方 / 负责人 | `plan-studio-b` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联设计 / 任务单 | 1:N 总控 PRD，拆分为 3 份切片 `SPEC + Todo`（Wave 1 -> Wave 2 -> Wave 3） |

- **目标读者**：实现者、独立审查者与维护者

## 一、要解决的问题

### 现状与痛点

1. **静态分析能力碎片化且仅有两类静态图**：现有可视化内核（`kit/skills/lib/visual-layout.mjs` 691 行、`kit/skills/lib/visual-render.mjs` 234 行）只产出「全景架构」与「泳道流转」两类视图，且未接通仓库既有导入解析（`kit/skills/lib/static-gates.mjs`）、Tarjan 强连通分量环检测（`kit/skills/lib/doc-graph.mjs`）与 Git 变更热度，无法零 Token 自动投影数据模型、继承层次、调用时序、状态机、CI 数据流与版本演进时间线。
2. **现网画布渲染存在已实证的交互与排版缺陷**：
   - **拖拽平移即模糊**：`kit/skills/lib/visual-render-assets.mjs` 为被 CSS `scale()` 缩放的 HTML `.pf-stage` 在按下瞬间挂载 `.is-panning { will-change: transform }`，触发浏览器按低倍率缓存位图重采样，导致节点文字一拖拽就发虚。
   - **AI 模板感与「文字墙」**：顶栏与面板按钮尺寸与权重雷同、缺乏主次分层；变更蓝图以纯清单堆砌，缺少结构化「改前 -> 改后」对比卡片、独立下游波及块与画布双向悬浮联动。
   - **双重序列化与导览失准**：首屏同时内联完整 DOM/SVG 与完整客户端 JSON，多图扩展后必然体积膨胀；`kit/skills/lib/visual-brief.mjs`（已达 796 行，逼近 800 行红线）的导览步骤全部硬绑到 `modifiedFeatureIds[0]`，无法一步一跳聚焦真实目标模块。
3. **常青架构图需强校验零脏 diff 态**：`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs` 已在前期移除 `{ changedFiles: changed }` 透传，但 `kit/skills/lib/architecture-map.mjs` 的 `verifyArchitectureMapSync` 仍只验首行指纹与 `homedir` 泄露，尚未机械校验常青 `docs/architecture-map.html` 绝对不含临时 `modified`/`impacted` 脏态节点。

### 目标用户与使用场景

- **项目维护者与审稿人**：在 `docs/architecture-map.html` 与仓外 Living Visual Brief（`<gitCommonDir>/project-forge-flow/briefs/*.html`）中离线打开即可秒级浏览多类架构图、定位耦合环与 PR 实质波及链路。
- **规划与实施代理**：通过 `verify-tools.mjs render` 与 `doc-plan.mjs brief` 零 LLM Token 增量刷新架构全景与变更蓝图，不污染工作区 `git status`。

### 产品目标

- **零 Token 多图自动激活**：统一纯 Node 增量静态分析器按静态证据自动激活最多 10 类图表（3 常驻 + 6 按需静态 + 1 可选实测），无证据绝不渲染空 Tab。
- **拖拽零模糊与体积受控**：全面切换纯矢量 SVG `viewBox` 相机平移/缩放，彻底移除缩放文字容器的 `will-change: transform`；单份索引压缩 JSON + 非当前 Tab 客户端懒渲染，典型项目自包含离线 HTML `< 180 KB`。
- **第一性原理 UI/UX 与 6 项 Studio 交互**：落实三级按钮权重、模块化 Change Blueprint、Hash 历史导航、`?from=` 父子简报串跳、Semantic Passport、多跳 Reach 与双节点 Route Probe、真实步进 Walkthrough、意图芯片问答与纯矢量 `.svg`/`2x .png` 导出。
- **MIT Clean-Room 与异构栈通用**：纯 Node 18+ ESM 零第三方依赖，单文件严格 `<= 800` 行，在 7 类异构仓库栈上无需任何项目定制补丁直接可用。

## 二、范围与非目标

### 本次要做（In Scope）

1. **Wave 1 — `zero-token-static-analyzer`（认领 `C1..C4`）**：纯 Node 增量静态分析器与仓外缓存、3 层 10 类图表静态证据抽取、3-dot `merge-base...HEAD` Materiality 差分过滤 + 1-hop 邻域与有界 hunk、7 栈异构仓库正反双向夹具与故障注入。
2. **Wave 2 — `multi-diagram-layout-engine`（认领 `C5..C8`）**：Clean-Room 10 类图表确定性布局引擎、端口散布与同侧干线捆绑 + 紧凑避障网格 Dijkstra 正交路由器、纯 Node 确定性 SVG 几何自检器（零 Chrome 渲染期依赖）及双向夹具与故障注入。
3. **Wave 3 — `studio-ux-lazy-renderer`（认领 `C9..C12`）**：第一性原理 Studio UI/UX 重构与纯 SVG `viewBox` 相机引擎、模块化非文字墙 Change Blueprint 与单源懒渲染、6 项 Studio 交互升级与导览修复、真浏览器浅/深色截图实证及全仓长青资产锁步收口。

### 明确不做（Non-Goals）

- 绝不拷贝任何第三方非 MIT 项目的源码、CSS、字体、AJV 校验器、渲染期无头浏览器校验链路或 CC-BY-NC-SA 品牌素材；全部算法与界面均以 MIT Clean-Room 纯 Node 18+ 零依赖独立实现。
- 不引入任何 npm 运行时依赖、外链 CDN 字体/脚本或服务器端渲染服务；产物维持单文件离线 `file://` 可直接打开。
- 不为特定仓库写死领域规则或定制补丁；无对应静态证据时不编造占位图表或空标签页。
- 不改动日常 8 技能边界，不触碰 `dev-flow` 沙箱双环核心状态机。

## 三、切片波次总览（1:N 并行与串行编排）

| 波次 | 切片任务 ID | 前置依赖 | 认领标准 | 关联设计文档 |
| --- | --- | --- | --- | --- |
| Wave 1 | `zero-token-static-analyzer` | 无（`[]`） | `C1..C4` | `docs/specs/261127-zero-token-static-analyzer-spec.md` |
| Wave 2 | `multi-diagram-layout-engine` | `zero-token-static-analyzer` | `C5..C8` | `docs/specs/261127-multi-diagram-layout-engine-spec.md` |
| Wave 3 | `studio-ux-lazy-renderer` | `zero-token-static-analyzer`, `multi-diagram-layout-engine` | `C9..C12` | `docs/specs/261127-studio-ux-lazy-renderer-spec.md` |

每波次合入 `main` 时必须保持自身 CI 全绿：同步更新 `docs/feature-map.json`、干净常青 `docs/architecture-map.html`、对应 `scripts/dev/fixtures-*.mjs` 与 `injections-data-*.mjs`，并执行 `node scripts/equip.mjs .` 保持 `.agents/skills/` 字节级同步。

## 四、复用既有模块

- `kit/skills/lib/static-gates.mjs`（多语言导入解析 `extractImportsForArch` / `resolveGoModules`，Wave 1 下沉至共享叶子 `kit/skills/lib/import-graph.mjs` (new) 后双处复用）与 `kit/skills/lib/static-gates-lexer.mjs`（注释剥离）
- `kit/skills/lib/doc-graph.mjs`（Tarjan SCC 算法 `findSccs`）
- `kit/skills/lib/symbol-index.mjs`（多语言定义级符号抽取）
- `kit/skills/dev-explore/scripts/repo-map-helpers.mjs`（`extractCiRunSteps` 工作流解析思路与路径规范化）
- `kit/skills/lib/git.mjs`、`kit/skills/lib/git-core.mjs`、`kit/skills/lib/git-fast.mjs`（`resolveGitDirFast`、`COMMON_SKIP_DIRS`、`sha256Text`、`writeJsonAtomic`）
- `kit/skills/lib/feature-map.mjs` 与 `kit/skills/lib/feature-map-graph.mjs`（`computeFeatureMapFingerprint`、`verifyArchitectureMapHeader`、`buildFallbackDomains`）
- `kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-panels.mjs`、`kit/skills/lib/visual-render-assets.mjs`、`kit/skills/lib/visual-brief.mjs`、`kit/skills/lib/architecture-map.mjs`

## 五、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 零依赖与体积 | `kit/` 与 `scripts/` 仅使用 Node 18+ `node:*` 内置模块；单文件严格 `<= 800` 行；典型仓库渲染 HTML `< 180 KB` | `node scripts/dev/preflight.mjs`、`edit-gate.mjs` 与 `fixtures-visual-engine.mjs` |
| 安全与隐私 | 离线 `file://` 零外链；严格转义 XSS、拦截危险协议、本地原型 `<= 512 KB`；零 `homedir()` 宿主机路径泄露 | `fixtures-visual-engine.mjs`、`fixtures-living-brief.mjs`、`verify-injections.mjs` |
| 兼容性与无障碍 | 兼容 v1/v2 `docs/feature-map.json` 及 7 类异构栈仓库；浅/深色主题文本对比度满足 WCAG AA | 7 栈异构夹具 + 真浏览器浅/深色截图实证 |
| 幂等与增量性能 | 同输入重复渲染字节级一致；仓外分析缓存命中时无需重扫未变更文件，零工作区脏文件 | `fixtures-static-analyzer.mjs`、`fixtures-visual-layout-v2.mjs`、`bench.mjs` |

## 六、验收标准

<!-- criteria:start -->
- [ ] C1: `kit/skills/lib/static-analyzer.mjs` (new) 复用多语言导入解析与 Tarjan SCC 算法，按 `relPath + blobSha/mtime` 在 `<gitCommonDir>/project-forge-flow/analysis-cache.json` 增量缓存模块依赖图、`fanIn`/`fanOut`/入环耦合与 Git 变更热度，零污染工作区 `git status`（经 `node scripts/dev/fixtures.mjs --domain static-analyzer` 验真）。
- [ ] C2: `kit/skills/lib/static-evidence.mjs` (new) 实现 3 层证据驱动的 10 类图表激活协议（Tier 1 `architecture`/`workflow`/`tree` 常驻；Tier 2 `erd`/`class`/`sequence`/`lifecycle`/`dataflow`/`timeline` 严格按阈值激活且无证据零空 Tab；Tier 3 `waterfall` 仅实测 span 激活），经正反双向夹具验真。
- [ ] C3: `kit/skills/lib/diff-materiality.mjs` (new) 基于 `merge-base(base, HEAD)...HEAD` 3-dot 差异执行 Materiality 过滤（Schema/迁移必触发，纯文档/锁文件/纯重命名跳过），输出 1-hop 邻域并集与有界 `-`/`+` hunk，且 `verifyArchitectureMapSync` 机械阻断含临时变更脏标的常青 `docs/architecture-map.html`。
- [ ] C4: `scripts/dev/fixtures-static-analyzer.mjs` (new) 与 `scripts/dev/injections-data-static-analyzer.mjs` (new) 覆盖 7 类异构仓库栈（空仓、Node/TS 单包与 Monorepo、Python/Go/Rust、Prisma/SQL、前端 UI、CI 密集仓、无包清单非 JS 仓）正反双向验证并同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs .`，Wave 1 全量门禁退出码 `0`。
- [ ] C5: Clean-Room 布局引擎（`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-layout-diagrams.mjs` (new)、`kit/skills/lib/visual-layout-charts.mjs` (new)，每文件 `<= 800` 行）实现全部 10 类图表确定性坐标排布（含 `tree` 轮廓排布与 `>= 3` 叶子叠放、`timeline` 静默断口压缩、`lifecycle` 脊柱与顶弧等），重复运行字节一致。
- [ ] C6: `kit/skills/lib/visual-router.mjs` (new) 实现端口防重叠散布、同侧共享干线捆绑与紧凑避障网格 Dijkstra 正交路由，输出无穿盒、无端口重合的圆角正交 SVG 路径。
- [ ] C7: `kit/skills/lib/visual-geometry-check.mjs` (new) 提供纯 Node 确定性 SVG 几何自检（零浏览器渲染期依赖），机械检出节点重叠、边界越界、连线穿盒与空图违规并可被故障注入捕获。
- [ ] C8: `scripts/dev/fixtures-visual-layout-v2.mjs` (new) 与 `scripts/dev/injections-data-visual-layout-v2.mjs` (new) 对 10 类图表布局、正交路由与几何校验执行正反双向实证，并同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs .`，Wave 2 全量门禁退出码 `0`。
- [ ] C9: Studio UI/UX 渲染层（`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-svg.mjs` (new)、`kit/skills/lib/visual-render-assets.mjs`、`kit/skills/lib/visual-render-client.mjs` (new)）落实三级按钮权重（Primary/Secondary/Icon-Ghost）、参数化浅/深色 WCAG AA 主题 Token、纯矢量 SVG `viewBox` 平移缩放（禁用含文字缩放容器 `will-change: transform`，浮层按 `Math.round(v * dpr) / dpr` 对齐物理像素），根治拖拽模糊。
- [ ] C10: `kit/skills/lib/visual-render-panels.mjs` 与拆分瘦身后的 `kit/skills/lib/visual-brief.mjs` + `kit/skills/lib/visual-brief-store.mjs` (new) 实现模块化非文字墙 Change Blueprint（顶部决策概览、分域变更卡与改前->改后对比、独立下游波及块、双向悬浮联动）与单源索引压缩 JSON + 非当前 Tab 客户端懒渲染，典型项目 HTML `< 180 KB` 且保持离线安全红线。
- [ ] C11: 完成 6 项 Studio 交互升级与导览修复：Hash/历史导航（`#tab=&focus=&reach=&route=`、`Alt+←`）与 `?from=` 父子 Brief 返回条、Semantic Passport、有向 BFS 多跳 Reach 与双节点 Route Probe（`R`）、修复 `visual-brief.mjs` 导览每步独立绑定真实目标、意图芯片注入活跃路径、纯矢量 `.svg` 与 `2x .png` 导出。
- [ ] C12: 完成真浏览器浅/深色视觉与交互实证截图（覆盖全景、拖拽清晰度、多 Tab 懒渲染、Reach/Route 与 Change Blueprint），同步更新 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、`README.md`/`README.en.md`、视觉回归夹具/故障注入与 `equip.mjs .`，执行 `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0`。
<!-- criteria:end -->

## 七、待拍板问题

> 视觉方向选型说明：Wave 3 的结构性 UI/UX 不变量（三级按钮分层、纯 SVG `viewBox` 相机、模块化 Change Blueprint、单源懒渲染、6 项 Studio 交互与 WCAG AA 对比度）已在本 PRD 与 Wave 3 SPEC 中冻结，视觉主题 Token 通过 CSS 自定义属性参数化；具体视觉方向在进入 Wave 3 `approve` 前由用户通过 `oil-ui-pro` 3 方向同屏对比页拍板注入 Token，无阻断规划的未决架构问题。

- 待确认：无

## 八、门型与回滚路径

- **门型判定**：`one-way`（改造 `kit/skills/lib/` 视觉与分析公共契约、多切片跨模块演进并触及高风险路径 `kit/`）。
- **回滚路径**：三波次逐片独立合入，任意波次异常均可通过反向提交（`git revert`）整片回滚并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs` 恢复至上一稳定基线；仓外缓存文件 `<gitCommonDir>/project-forge-flow/analysis-cache.json` 删除即无损重建。

## 九、风险与缓解

| 风险 | 可能性 | 影响 | 缓解办法 |
| --- | --- | --- | --- |
| 模块功能丰富导致单文件超 800 行 | 中 | 触发 `edit-gate` 阻断 | 预先按职责拆分为独立单责模块，目标单文件 `<= 650` 行，并提前拆分 796 行的 `kit/skills/lib/visual-brief.mjs` |
| 客户端懒渲染引入多图渲染器代码导致 HTML 体积超 180 KB | 中 | 拖慢离线打开与回归预算失败 | 单源索引压缩 JSON 去重字段，SVG 渲染函数复用统一图元构建器，夹具锁死体积上限 |
| 非 JS 异构仓静态抽取误报或产出空图 | 中 | 出现空标签页或错误依赖边 | Tier 2 严格设置最低静态证据阈值（如 `class >= 3`、`sequence >= 3` 跳、`timeline >= 2`），缺证据直接隐藏标签页并用 7 栈双向夹具锁死 |
| 拖拽/缩放或暗色模式视觉回退 | 中 | 再次出现模糊、裁切或低对比度 | 源码静态断言禁止缩放容器使用 `will-change: transform`，Wave 3 强制真浏览器浅/深色截图实证 |

## 澄清与补充记录

- 已确认：沿用 MIT Clean-Room 零第三方依赖路线，所有算法与界面在纯 Node 18+ ESM 下独立实现，不拷贝任何非 MIT 项目代码或素材。
- 已确认：常青 `docs/architecture-map.html` 永远保持零临时 PR 变更脏标，PR/任务级变更叠加态严格收敛于仓外 Living Visual Brief 与 3-dot diff 视图。

> 确认需调整系统模块或对外契约时，以此 PRD 为依据推进 3 份切片 `SPEC + Todo`；`1:N` 总控 PRD 走四态闭环，全部 3 波次合入完成时统一成对归档至 `docs/archive/prd/`。
