---
kind: spec
title: 第一性原理 Studio 交互界面与纯矢量懒渲染引擎
status: implemented
tier: L3
created: 2026-11-27
updated: 2026-11-27
issue: 219
pr: null
branch: feat/studio-ux-lazy-renderer
owner: plan-studio-b
plan_mode: interactive
approved: true
implemented: true
plan_critique: "passed (reviewer=critic-studio-b-r2, round=2, sha=c73c4d063993, summary=All 3 Round 1 major blockers genuinely closed: CLI triple-parity & verify-tools-render.mjs split, tree.nodes[].diffState compatibility + v5 fixture migration + 4 unique Wave 3 injections, and explicit <=650L rendering budgets with visual-render-client-diagrams.mjs split & external shoot.mjs clarification.)"
related_prd: ../prd/261127-issue219-visual-studio-archify-v2-prd.md
related_todo: ../todo/261127-issue219-studio-ux-lazy-renderer-todo.md
high_risk_paths: [kit/]
task_id: studio-ux-lazy-renderer
scope_files: [kit/skills/lib/visual-render-svg.mjs, kit/skills/lib/visual-render-client.mjs, kit/skills/lib/visual-render-client-diagrams.mjs, kit/skills/lib/visual-brief-store.mjs, kit/skills/lib/visual-render.mjs, kit/skills/lib/visual-render-assets.mjs, kit/skills/lib/visual-render-panels.mjs, kit/skills/lib/visual-brief.mjs, kit/skills/lib/architecture-map.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/dev-verify-tools/scripts/verify-tools-render.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-plan/scripts/doc-plan-brief.mjs, scripts/dev/fixtures-visual-engine.mjs, scripts/dev/fixtures-studio-ux.mjs, scripts/dev/fixtures-living-brief.mjs, scripts/dev/injections-data-visual-engine.mjs, docs/TDD.md, docs/feature-map.json, docs/architecture-map.html, README.md, README.en.md]
depends_on: [zero-token-static-analyzer, multi-diagram-layout-engine]
---

# 第一性原理 Studio 交互界面与纯矢量懒渲染引擎 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `implemented`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（前端渲染架构推翻重做、多文件模块拆分与全仓长青资产收口；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / Issue / PR | `feat/studio-ux-lazy-renderer` / #219 / 未关联 |
| 负责人 / 内审状态 | plan-studio-b / `passed` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 PRD / Todo | `docs/archive/prd/261127-issue219-visual-studio-archify-v2-prd.md` / `docs/archive/todo/261127-issue219-studio-ux-lazy-renderer-todo.md` |

- **变更一句话**：推翻旧 AI 模板 DOM 渲染，交付纯矢量 SVG `viewBox` 相机画布、单源索引压缩 JSON 懒渲染、模块化非文字墙 Change Blueprint、6 项 Studio 交互升级与真浏览器浅/深色实证闭环。

## 系统变更全景

```mermaid
flowchart LR
  Model["多图布局模型"] --> Ser["索引压缩序列化"]
  Ser --> Shell["visual-render"]
  Theme["参数化主题Token"] --> Css["render-assets"]
  Css --> Shell
  BP["模块化变更蓝图"] --> Shell
  Cam["SVG相机与6交互"] --> Shell
  Diag["10图客户端懒渲"] --> Cam
  Shell --> Out["自包含Studio页"]
```

| 模块 / 文件 | 变更性质 | 行数预算 | 核心职责 |
| --- | --- | --- | --- |
| `kit/skills/lib/visual-render-svg.mjs` | 新增 | `<= 520` | 服务端首屏纯矢量 SVG 图元渲染与单源索引压缩 JSON 序列化（向后兼容 `tree.nodes[].diffState`） |
| `kit/skills/lib/visual-render-client.mjs` | 新增 | `<= 480` | 客户端核心交互壳：SVG `viewBox` 相机、物理像素浮层对齐、Hash/历史、`?from=` 返回条、Semantic Passport、Reach/Route Probe、Walkthrough、意图 Q&A 与 `.svg`/`2x .png` 导出 |
| `kit/skills/lib/visual-render-client-diagrams.mjs` | 新增 | `<= 520` | 客户端 10 类图表按需懒渲染 SVG 构建器（按索引压缩 JSON 即时生成非首屏 Tab 矢量 DOM 并缓存） |
| `kit/skills/lib/visual-brief-store.mjs` | 新增 | `<= 420` | 从 `visual-brief.mjs`（现 796 行）拆出 sidecar 规范化、原型暂存与过期清理逻辑 |
| `kit/skills/dev-verify-tools/scripts/verify-tools-render.mjs` | 新增 | `<= 220` | 从 `verify-tools.mjs`（现 777 行）抽离 `render` 子命令与可选 `--telemetry-spans` 处理 |
| `kit/skills/lib/visual-render.mjs` | 修改 | `<= 320` | 重构顶栏、三级按钮权重、动态激活 Tab 栏（零空 Tab）与单源 HTML 壳层装配 |
| `kit/skills/lib/visual-render-assets.mjs` | 修改 | `<= 260` | 参数化浅/深色 WCAG AA 主题 Token 与无 AI 模板感样式；彻底移除含文字缩放容器 `will-change: transform` |
| `kit/skills/lib/visual-render-panels.mjs` | 修改 | `<= 480` | 重做模块化 Change Blueprint（决策概览条、分域变更卡 + 改前->改后对比、独立下游波及块）、Semantic Passport 与意图芯片 Q&A 弹窗 |
| `kit/skills/lib/visual-brief.mjs` | 修改 | `<= 580` | 瘦身并接入 Wave 1 分析与 3-dot diff、`?from=` 父子简报互链、修复导览每步独立绑定真实目标节点 |
| `kit/skills/lib/architecture-map.mjs` | 修改 | `<= 320` | 接通 Wave 1/2 静态分析与 10 类图证据，渲染干净常青 Studio 架构图 |
| `kit/skills/dev-verify-tools/scripts/verify-tools.mjs` | 修改 | `<= 720` | 委托 `render` 至 `verify-tools-render.mjs` 压降行数，并在 `parseStandardCli` 与 `printHelp()` 同步登记 `--telemetry-spans` 满足 CLI 三重对拍 |
| `kit/skills/dev-plan/scripts/doc-plan.mjs` | 修改 | `<= 730` | 在 `parseStandardCli` 与 `printHelp()` 同步登记 `--pr-diff-base` 与 `--parent-brief` 满足 `checkCliParity` 三重对拍 |
| `kit/skills/dev-plan/scripts/doc-plan-brief.mjs` | 修改 | `<= 430` | 消费 `--pr-diff-base` 与 `--parent-brief` 透传 3-dot PR diff 与父子简报导航元数据 |
| `scripts/dev/fixtures-visual-engine.mjs` | 修改 | `<= 720` | 迁移冲突的 v5 DOM/预算断言至 v6 纯 SVG 相机契约，保留 `I964.expect` 精确用例标题 |
| `scripts/dev/fixtures-studio-ux.mjs` | 新增 | `<= 450` | 独立承载懒渲染 `< 180 KB`、零模糊静态锁、6 项 Studio 交互与 `?from=` 协议安全双向断言 |
| `scripts/dev/fixtures-living-brief.mjs` | 修改 | `<= 460` | 补齐多步导览独立目标、父子简报 `?from=` 串跳与 3-dot diff 蓝图卡片回归断言 |
| `scripts/dev/injections-data-visual-engine.mjs` | 修改 | `<= 120` | 保留既有 `I961..I964` 全绿，新增 4 条 Wave 3 专属故障注入（不与 Wave 1 重复） |
| `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md` | 修改 | 符合预算 | 全仓长青架构文档、双语说明与干净基线架构图锁步收口 |

## 一、背景与边界声明

- **要改什么**：从零重做 Studio HTML/CSS/SVG/JS 渲染与交互层，解决拖拽文字模糊、AI 模板按钮均权、文字墙 Change Blueprint、双重序列化体积膨胀与导览硬绑首节点五大沉疴，同时控制所有 `.mjs` 文件严守 `<= 800` 行红线（本切片目标 `<= 730` 行）。
- **不改什么**：保留离线 `file://` 零外链自包含协议、保留 `<!-- @generated by project-forge ... feature-map-sha256=... -->` 首行指纹契约、保留原型 `<= 512 KB` 与 `http:`/`https:`/`file:` 安全白名单及 `homedir()` 零泄露不变量；保留 `pf-visual-data` 中 `tree.nodes[].diffState` 视图以保证 `scripts/dev/fixtures-sandbox-dual-loop.mjs`（`[Sandbox-C8]` 与 `I986`）零回归。
- **本期不做**：不引入任何前端框架或打包器（React/Vue/Tailwind/Vite 等），不依赖在线字体 CDN；不在生产渲染链路引入无头浏览器。
- **复用既有模块**：Wave 1（`kit/skills/lib/static-analyzer.mjs` (new)、`kit/skills/lib/static-evidence.mjs` (new)、`kit/skills/lib/diff-materiality.mjs` (new)）、Wave 2（`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-router.mjs` (new)、`kit/skills/lib/visual-geometry-check.mjs` (new)）及 `kit/skills/lib/empirical-artifacts.mjs`。
- **架构基线关系**：单文件严格 `<= 800` 行，零第三方依赖，满足 `arch-rules`、`checkCliParity` 与 `preflight` 预算门禁（依据：`docs/TDD.md`）。

## 二、设计方案与契约变更

### 第一性原理 UI/UX 结构不变量（与参数化主题 Token 解耦）

> 具体色彩与排版方向在进入本切片 `approve` 前由用户经 `oil-ui-pro` 3 方向同屏对比页拍板后注入 `--pf-*` CSS 自定义属性，不改变以下结构与交互契约。

1. **严格三级按钮权重与尺寸分层**：
   - **Primary（主动作，全栏唯一）**：如顶栏唯一主按钮「向 AI 提问」与蓝图主入口，实色强调底 + 明确高度与字重。
   - **Secondary（视图/模式切换）**：Tab 分段器、域筛选与 Reach/Route 切换，轻量边框或底面层级，激活态清晰且不受 `:hover` 同权覆写。
   - **Icon / Ghost（辅助工具与低频操作）**：缩放 `+`/`-`/适配、主题切换、导出 `.svg`/`.png`、重置视角，紧凑图标或文字幽灵按钮，视觉退居二线。
2. **纯矢量 SVG `viewBox` 相机引擎（根治拖拽文字模糊）**：
   - 画布层全部以原生 `<svg>` 元素渲染（域分组、节点卡片、矢量文字、圆角正交路径与箭头标记），彻底取消被 CSS `scale()` 缩放的含文字 HTML DOM `.pf-stage`。
   - 平移与缩放仅更新 `<svg viewBox="vx vy vw vh">` 数值（以鼠标指针为缩放锚点），**源码静态断言严禁对任何画布或含文字缩放容器使用 `will-change: transform`**。
   - 浮层工具条与 Semantic Passport / 选区悬浮按钮坐标统一按 `Math.round(v * dpr) / dpr` 对齐设备物理像素。
3. **模块化非文字墙 Change Blueprint**：
   - **顶部决策概览条**：状态徽标、核心一句话结论、四态统计计数筛选（新增/修改/拟移除/受波及）与「在架构图中高亮改动」主按钮。
   - **按域 / 1:N 切片分块的变更卡片**：结构化呈现「改前 -> 改后」语义对比或移除替代关系、关联源码与 3-dot 有界 diff hunk 折叠预览；与架构画布节点双向悬浮高亮联动。
   - **独立下游波及与依赖链区块**：将上游变更与下游 `impacted` 传导链分层展示，避免冗长纯文本段落墙。
4. **消除双重序列化 + 客户端懒渲染（`< 180 KB` 预算）+ 跨夹具兼容负载**：
   - HTML 内 `<script id="pf-visual-data" type="application/json">` 仅嵌入一份索引压缩 JSON：`{ schemaVersion: 3, mode, title, hasActiveDiff, strings, activeTabs, tree: { domains, nodes: [{ id, diffState, ... }], edges }, diagrams: { ... }, walkthrough }`。保留轻量 `tree.nodes[].diffState` 字段以 100% 兼容既有 `[Sandbox-C8]`（`scripts/dev/fixtures-sandbox-dual-loop.mjs`）与 `verifyArchitectureMapSync`。
   - 服务端 `visual-render-svg.mjs` 仅预渲染默认首屏 Tab（`architecture-map` 默认 `architecture`，`visual-brief` 默认 `brief`）；其余已激活的 Tier 1/2/3 Tab 在首次点击时由 `visual-render-client-diagrams.mjs` 按需从同一份 JSON 构造纯 SVG DOM 并缓存；无静态证据的 Tab 绝不写入 DOM，实现零空标签页。
5. **6 项 Studio 交互升级与导览根修**：
   - **Hash / 历史导航与父子串跳**：双向同步 `#tab=&focus=&reach=&route=`，监听 `popstate` 与 `Alt+←` 回退上一视角；`master-prd` Brief 点击子切片带 `?from=<parentBriefKey>` 参数打开子切片 Brief，子切片顶部自动呈现「返回总控 PRD 简报」返回条（仅接受安全相对 `briefKey` `[a-z0-9._-]+`，拒绝协议与路径穿越，离线 `file://` 可用）。
   - **Semantic Passport（语义护照）**：点击任意节点滑出/展示紧凑语义护照，显示职责摘要、耦合指标（`fanIn` / `fanOut` / `inCycle` 环告警与环成员）、Git 热度及经本地验真的源码/测试/文档锚点路径。
   - **多跳 Reach 与双节点 Route Probe（`R`）**：有向 BFS 计算当前焦点节点的前驱与后继多跳波及集合并高亮；按 `R` 或点击探测按钮进入双节点模式，选择起止节点后计算最短有向依赖链并支持逐步高亮回放。
   - **Walkthrough 分步导览修复**：彻底修复 `kit/skills/lib/visual-brief.mjs` 原第 407–414 行所有导览步骤全部硬绑 `modifiedFeatureIds[0]` 的缺陷——每步按关联模块/切片/锚点精确解析独立 `targetId` 与所属 `tab`，切换步骤时自动切 Tab 并居中聚焦对应真实节点。
   - **带图上下文的意图芯片问答**：Q&A 弹窗内置 4 枚意图芯片（`解释边界` / `查波及面` / `补测试` / `拆分方案`），点击自动拼接当前聚焦节点语义护照、当前 Reach 波及链或 Route 最短路径，保留三级剪贴板降级。
   - **纯矢量 `.svg` 与 `2x .png` 导出**：直接序列化当前 `<svg>` 并内联已解析的浅/深色主题样式变量生成可编辑独立 `.svg` 下载；基于同份 `.svg` 绘制 `2x` Canvas 生成高清 `.png` 导出。

### CLI 选项契约与三重对拍边界

- `kit/skills/dev-verify-tools/scripts/verify-tools.mjs` + `verify-tools-render.mjs`：新增可选 `--telemetry-spans <path>`（读取真实实测耗时 JSON 供 Tier 3 `waterfall` 渲染），同步登记于 `parseStandardCli` 与 `printHelp()`。
- `kit/skills/dev-plan/scripts/doc-plan.mjs` + `doc-plan-brief.mjs`：新增可选 `--pr-diff-base <ref>`（启用 3-dot PR diff 叠加）与 `--parent-brief <key>`（显式指定父总控 Brief 键），同步登记于 `doc-plan.mjs` 的 `parseStandardCli` 与 `printHelp()`，确保 `scripts/dev/preflight.mjs` 的 `checkCliParity` 100% 通过。

### 既有机读夹具迁移与对齐清单（防冲突回归）

- **`scripts/dev/fixtures-visual-engine.mjs` 迁移项**：
  1. 保留 C5 用例标题 `Visual Engine C5：布局/单文件 HTML 渲染、25-60KB 预算、幂等重写、XSS/URL 防护与 file:// 离线韧性（正反双向）` 或与 `scripts/dev/injections-data-visual-engine.mjs` 的 `I964.expect` 同步一致；将 4 功能小型仓预算升级为 `<= 90 KB`、完整多图大仓升级为 `< 180 KB`。
  2. 将旧版 v5 HTML DOM 画布断言（`.pf-node`、`id="vp-tree"`、`pf-stage`、`data-tab-target="tree"`）迁移为 v6 纯矢量 SVG 断言（`svg-architecture`、`data-tab-target="architecture"`、`<g data-node-id="...">`）。
  3. 将与 C9 直接冲突的旧 v5 断言（`.pf-node.is-dragging-node { transition:none!important; will-change:transform }`、`translate3d(`、`rrt=`）替换为纯 SVG `viewBox` 相机 + 零 `will-change: transform` 抗模糊断言与 `Math.round(v * dpr) / dpr` 对齐断言。
  4. 将硬编码色值断言（`--accent-solid:#4F46E5`、`--muted:#A8B8CD`）迁移为参数化 CSS 自定义属性完整定义与浅/深色对比度 Token 校验（适配用户拍板的 `oil-ui-pro` 视觉方向）。
- **外部真浏览器视觉实证工具说明**：Wave 3 UI 视觉验收调用 `oil-ui-pro` 技能提供的外部真浏览器截图脚本（`shoot.mjs`，位于外部技能目录，非本仓库跟踪源码文件），仅在开发与独立审查实证阶段运行并产出浅/深色 `--artifact` 截图，绝不进入仓库运行时依赖。

### 数据与状态变更

- `visual-brief.mjs` 拆出 `visual-brief-store.mjs`，不改变 `<gitCommonDir>/project-forge-flow/briefs/<key>.json` 的 `BRIEF_SCHEMA_VERSION = 1` 兼容性；新增可选渲染元数据 `parentBriefHref` 与 `childBriefLinks`（纯相对文件名，零绝对路径泄露）。

### 异常、回退与安全边界

- 所有 SVG 文本与 JSON 序列化继续通过 `escapeXml` / `escapeHtml` / `escapeJsonForScript` 转义，阻断 `</script>` 与 SVG `<script>`/`onload` XSS 注入；`?from=` 参数严格白名单校验 `^[a-z0-9\u4e00-\u9fa5._-]{1,80}$` 防止跨站或路径穿越跳转。
- `2x .png` 导出在受限沙盒浏览器（Canvas taint）下优雅降级提示用户改用纯矢量 `.svg` 导出，绝不抛未捕获异常。
- 客户端脚本通过 `vm.Script` 静态语法校验纳入回归夹具，确保无 ES 语法错误或未定义 CSS 变量。

### 实现顺序

1. 依据用户拍板的 `oil-ui-pro` 视觉方向固化 `--pf-*` 参数化主题 Token。
2. 拆分 `kit/skills/lib/visual-brief-store.mjs` 与 `kit/skills/dev-verify-tools/scripts/verify-tools-render.mjs`，修复 `visual-brief.mjs` 导览步进与 `?from=` 父子串跳，并完成 `doc-plan.mjs`/`verify-tools.mjs` CLI 三重对拍注册。
3. 实现 `visual-render-svg.mjs`、`visual-render-client.mjs`、`visual-render-client-diagrams.mjs`，重构 `visual-render.mjs`、`visual-render-assets.mjs`、`visual-render-panels.mjs` 与 `architecture-map.mjs`。
4. 迁移 `fixtures-visual-engine.mjs`、`fixtures-living-brief.mjs`，新增 `fixtures-studio-ux.mjs` 与 Wave 3 专属故障注入。
5. 调用外部 `oil-ui-pro` 真浏览器截图脚本采集浅/深色全屏与交互截图迭代打磨，留存 `--artifact` 实证。
6. 同步更新 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、`README.md`/`README.en.md` 与 `equip.mjs .`，全量门禁收口。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 纯 SVG `viewBox` 相机 + 拆分子模块客户端懒渲染（已选） | 服务端只渲首屏，客户端由独立 `visual-render-client-diagrams.mjs` 懒渲其余 9 图 | 根治缩放拖拽模糊、消灭双重序列化、单文件全部 `<= 650` 行、HTML `< 180 KB` | 若单图超 1000 节点引发 SVG DOM 帧率瓶颈，可按视口做虚拟裁剪 |
| 把 10 图客户端渲染与交互全塞进单个 `visual-render-client.mjs` | 单文件字符串模板输出全套 JS | 必然突破 800 行红线并难以维护与单测 | 永不采用 |
| 在旧 DOM `.pf-stage` 上仅删掉 `will-change: transform` | 保留旧 CSS `scale()` DOM 节点层小修小补 | 依然存在双份序列化膨胀、无法导纯矢量 SVG 且保留 AI 模板堆砌感 | 永不回退 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/visual-render-svg.mjs` | 新增 | 首屏纯矢量 SVG 生成与单源压缩 JSON 序列化（保留 `tree.nodes[].diffState`） | `visual-render.mjs` |
| `kit/skills/lib/visual-render-client.mjs` | 新增 | `viewBox` 相机、DPR 对齐、6 项 Studio 交互与 `.svg`/`2x .png` 导出 | `visual-render.mjs` |
| `kit/skills/lib/visual-render-client-diagrams.mjs` | 新增 | 客户端 10 类图表按需懒渲染 SVG 构建器 | `visual-render.mjs`、`visual-render-client.mjs` |
| `kit/skills/lib/visual-brief-store.mjs` | 新增 | sidecar 读写、原型暂存与过期清理抽离 | `visual-brief.mjs` |
| `kit/skills/dev-verify-tools/scripts/verify-tools-render.mjs` | 新增 | 抽离 `render` 处理与 `--telemetry-spans` 支持 | `verify-tools.mjs` |
| `kit/skills/lib/visual-render.mjs` | 修改 | 新 Studio HTML 壳层、动态 Tab、单源数据装配 | `architecture-map.mjs`、`visual-brief.mjs` |
| `kit/skills/lib/visual-render-assets.mjs` | 修改 | 参数化主题 Token、三级按钮体系、移除 `will-change: transform` | 所有渲染产物 |
| `kit/skills/lib/visual-render-panels.mjs` | 修改 | 模块化 Change Blueprint、Semantic Passport、意图芯片弹窗 | Brief 与 Architecture Map |
| `kit/skills/lib/visual-brief.mjs` | 修改 | 瘦身至 `<= 580` 行、导览真目标解析、`?from=` 父子串跳、接入分析与 3-dot diff | `doc-plan-brief.mjs`、`doc-plan-ops.mjs` |
| `kit/skills/lib/architecture-map.mjs` | 修改 | 接通 Wave 1/2 产物输出干净常青 Studio 架构图 | `verify-tools.mjs`、`flow`、`survey` |
| `kit/skills/dev-verify-tools/scripts/verify-tools.mjs` | 修改 | 委托 `render` 至 `verify-tools-render.mjs` 并登记 `--telemetry-spans` | `dev-verify-tools`、`cli-parity` |
| `kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs` | 修改 | 登记并消费 `--pr-diff-base` 与 `--parent-brief` | `dev-plan`、`cli-parity` |
| `scripts/dev/fixtures-visual-engine.mjs`、`scripts/dev/fixtures-studio-ux.mjs`、`scripts/dev/fixtures-living-brief.mjs`、`scripts/dev/injections-data-visual-engine.mjs` | 修改 / 新增 | 迁移冲突 v5 断言，新增懒渲染、零模糊、6 项交互与 Wave 3 专属故障注入 | 全仓 CI 门禁 |
| `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md` | 修改 | 全仓长青资产、双语 README 目录与干净架构图同步 | 文档与自检门禁 |

- **对外可见的变化**：`docs/architecture-map.html` 与仓外 Living Visual Brief 升级为多图零空 Tab Studio 界面；客户端 URL 支持 `#tab=&focus=&reach=&route=` 与 `?from=`；`verify-tools render` 新增可选 `--telemetry-spans`，`doc-plan brief` 新增可选 `--pr-diff-base` 与 `--parent-brief`。
- **需要同步改的地方**：`node scripts/equip.mjs .`、`node scripts/sync-toc.mjs README.md README.en.md`、`docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`。

## 五、冻结的验收标准

<!-- criteria:start -->
- [x] C9: `kit/skills/lib/visual-render.mjs`、`visual-render-svg.mjs`、`visual-render-assets.mjs`、`visual-render-client.mjs` 与 `visual-render-client-diagrams.mjs`（单文件均 `<= 650` 行）实现三级按钮权重分层、参数化浅/深色 WCAG AA 主题 Token 与纯矢量 SVG `viewBox` 相机缩放平移；静态与回归断言确认含文字缩放容器零 `will-change: transform`、浮层按 `Math.round(v * dpr) / dpr` 对齐物理像素、拖拽全程文字清晰无模糊。
- [x] C10: `kit/skills/lib/visual-render-panels.mjs` 与拆分后的 `visual-brief.mjs` + `visual-brief-store.mjs` 实现模块化非文字墙 Change Blueprint（顶部决策条、分域变更卡与改前->改后对比、独立下游波及块、画布双向悬浮高亮）与单份索引压缩 JSON（向后兼容 `tree.nodes[].diffState`）+ 非当前 Tab 客户端懒渲染，典型项目 HTML 严格 `< 180 KB` 且保持零外链/XSS/512KB/白名单/`homedir` 安全红线。
- [x] C11: 6 项 Studio 交互升级、CLI 三重对拍与导览修复全部通过自动化与真浏览器实证：Hash/历史导航（`#tab=&focus=&reach=&route=`、`Alt+←`）与 `?from=` 安全父子 Brief 返回条、Semantic Passport（含 `fanIn`/`fanOut`/入环耦合与验真链接）、有向 BFS Reach 与双节点 Route Probe（`R`）、Walkthrough 每步绑定独立真实目标节点、意图芯片自动注入活跃路径、纯矢量 `.svg` 与 `2x .png` 导出；`verify-tools.mjs`（经 `verify-tools-render.mjs` 瘦身）与 `doc-plan.mjs` 通过 `checkCliParity`。
- [x] C12: 通过外部 `oil-ui-pro` 真浏览器截图脚本产出浅/深色多状态实证截图（全景、拖拽清晰度、多 Tab 懒渲染、Reach/Route 与 Change Blueprint）作为 `--artifact`；完成 `fixtures-visual-engine.mjs` 冲突 v5 断言迁移与 `fixtures-studio-ux.mjs` 补测，保持 `[Sandbox-C8]` 与 `I961..I964` 全绿并补齐 Wave 3 专属故障注入；同步更新 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、`README.md`/`README.en.md` 与 `equip.mjs .`，执行 `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0`。
<!-- criteria:end -->

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（全面重构视觉渲染引擎、升级回归契约与常青文档）；回滚做法：反向提交本切片 PR，重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/merge-gate.mjs`。
- **高风险路径**：`kit/`（特别是 `visual-render*.mjs`、`visual-brief.mjs`、`architecture-map.mjs`、`verify-tools.mjs`、`doc-plan.mjs` 及 `scripts/dev/injections-data-visual-engine.mjs` `I961..I964` 既有防线）。
- **故障注入预演**：除保持既有 `I961..I964` 与 `I986` 全绿外，在 `scripts/dev/injections-data-visual-engine.mjs` 新增 4 条 Wave 3 专属故障注入（不与 Wave 1 重复）——1）回流 `will-change: transform` 到缩放画布/文字容器；2）关闭非当前 Tab 客户端懒渲染重新双份序列化导致体积失控；3）退化 `visual-brief.mjs` 导览重新全绑 `modifiedFeatureIds[0]`；4）放宽 `?from=` 父简报参数校验允许 `javascript:`/`../` 注入——全部由 `verify-injections.mjs` 捕获。

## 澄清与补充记录

- 已确认：落地生产代码前须通过 `oil-ui-pro` 3 方向同屏对比页确认具体视觉主题 Token，并经外部 `oil-ui-pro` 真浏览器浅/深色多轮截图自纠后提交独立盲审。
- 已确认：拆出 `visual-render-client-diagrams.mjs`、`visual-brief-store.mjs` 与 `verify-tools-render.mjs`，确保全部 `kit/` 脚本留足 `<= 800` 行安全余量并通过 CLI 三重对拍。

## 实现说明

- **实际落地摘要**：基于用户拍板的 Direction B Spatial Studio 视觉方向完成纯矢量 SVG `viewBox` 相机画布、单源索引压缩 JSON（`schemaVersion: 3`，保留 `tree.nodes[].diffState`）与 10 类图表客户端按需懒渲染引擎；同步落实 4 项界面打磨（零左侧彩色边条、点击已选节点/空白/`Esc` 反选并默认收起右侧 Semantic Passport、`1440/1280/1024/768/390` 多视口响应式零溢出、浅/深色点阵画布背景）及 2 项连续性优化（`critique-pass`/`critique-reject` 自动刷新 Living Visual Brief；`--select-prototype`/`--confirm` 依据 `triage.recommendedEntry` 为 `sandbox` 任务推荐 `flow.mjs start --sandbox`）。拆分 `visual-brief-store.mjs`、`verify-tools-render.mjs`、`visual-render-svg.mjs`、`visual-render-client.mjs`、`visual-render-client-diagrams.mjs`，全部 `.mjs` 严格遵守 `<= 800` 行预算且 `docs/architecture-map.html` 实测 `< 180 KB`（零脏 diff 态）。
- **与草案的差异**：为满足真浏览器多视口自检（`shoot.mjs` 0 告警）与 `< 180 KB` 体积预算，采用无边框微阴影层级（borderless elevation）消除嵌套边框告警，在单文件目录树与时间线序列化中对大仓实施有界采样（`tree <= 48` 目录节点、`timeline <= 24` 事件），并新增独立故障注入数据表 `scripts/dev/injections-data-studio-ux.mjs`（`I1021..I1024`，自动被 `injections-data.mjs` 发现，不干扰既有 `I961..I964`）。
- **关联同步文件**：`docs/feature-map.json`、`docs/architecture-map.html`、`docs/TDD.md`、`README.md`、`README.en.md`、`.agents/skills/**`（经 `node scripts/equip.mjs .` 全量同步）。
