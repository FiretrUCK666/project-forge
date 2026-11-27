---
kind: todo
title: 第一性原理 Studio 交互界面与纯矢量懒渲染引擎
status: active
created: 2026-11-27
updated: 2026-11-27
issue: null
pr: null
branch: feat/visual-studio-archify-v2
owner: plan-studio-b
plan_mode: interactive
approved: false
done_at: null
task_id: studio-ux-lazy-renderer
planned_at: 76795202dbd2d328d379fbff506b7dad39753133
related_prd: ../prd/261127-issue219-visual-studio-archify-v2-prd.md
related_spec: ../specs/261127-studio-ux-lazy-renderer-spec.md
---

# 第一性原理 Studio 交互界面与纯矢量懒渲染引擎

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/visual-studio-archify-v2` @ `7679520` |
| 任务编号 | `studio-ux-lazy-renderer` |
| 负责人 / 审批 | plan-studio-b / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `../specs/261127-studio-ux-lazy-renderer-spec.md` |

- **断点恢复**：接手人先核对 Wave 1 与 Wave 2 均已合入 `main`，且用户已通过 `oil-ui-pro` 3 方向对比页拍板主题 Token 并完成本切片 `approve`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-render-svg.mjs` (new)、`kit/skills/lib/visual-render-client.mjs` (new)、`kit/skills/lib/visual-render-client-diagrams.mjs` (new)、`kit/skills/lib/visual-brief-store.mjs` (new)、`kit/skills/dev-verify-tools/scripts/verify-tools-render.mjs` (new)、`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-assets.mjs`、`kit/skills/lib/visual-render-panels.mjs`、`kit/skills/lib/visual-brief.mjs`、`kit/skills/lib/architecture-map.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`scripts/dev/fixtures-visual-engine.mjs`、`scripts/dev/fixtures-studio-ux.mjs` (new)、`scripts/dev/fixtures-living-brief.mjs`、`scripts/dev/injections-data-visual-engine.mjs`、`docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md`
- **复用既有模块**：Wave 1 静态分析与证据内核、Wave 2 10 类图布局/路由/几何校验内核、`kit/skills/lib/empirical-artifacts.mjs`
- **本期不做**：不引入任何第三方前端框架、构建器或在线 CDN 资产；不在生产渲染链路依赖无头浏览器
- **门型与回滚路径**：`one-way`（高风险路径 `kit/` 与全仓长青资产同步）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/merge-gate.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [ ] C9: `kit/skills/lib/visual-render.mjs`、`visual-render-svg.mjs`、`visual-render-assets.mjs`、`visual-render-client.mjs` 与 `visual-render-client-diagrams.mjs`（单文件均 `<= 650` 行）实现三级按钮权重分层、参数化浅/深色 WCAG AA 主题 Token 与纯矢量 SVG `viewBox` 相机缩放平移；静态与回归断言确认含文字缩放容器零 `will-change: transform`、浮层按 `Math.round(v * dpr) / dpr` 对齐物理像素、拖拽全程文字清晰无模糊。
- [ ] C10: `kit/skills/lib/visual-render-panels.mjs` 与拆分后的 `visual-brief.mjs` + `visual-brief-store.mjs` 实现模块化非文字墙 Change Blueprint（顶部决策条、分域变更卡与改前->改后对比、独立下游波及块、画布双向悬浮高亮）与单份索引压缩 JSON（向后兼容 `tree.nodes[].diffState`）+ 非当前 Tab 客户端懒渲染，典型项目 HTML 严格 `< 180 KB` 且保持零外链/XSS/512KB/白名单/`homedir` 安全红线。
- [ ] C11: 6 项 Studio 交互升级、CLI 三重对拍与导览修复全部通过自动化与真浏览器实证：Hash/历史导航（`#tab=&focus=&reach=&route=`、`Alt+←`）与 `?from=` 安全父子 Brief 返回条、Semantic Passport（含 `fanIn`/`fanOut`/入环耦合与验真链接）、有向 BFS Reach 与双节点 Route Probe（`R`）、Walkthrough 每步绑定独立真实目标节点、意图芯片自动注入活跃路径、纯矢量 `.svg` 与 `2x .png` 导出；`verify-tools.mjs`（经 `verify-tools-render.mjs` 瘦身）与 `doc-plan.mjs` 通过 `checkCliParity`。
- [ ] C12: 通过外部 `oil-ui-pro` 真浏览器截图脚本产出浅/深色多状态实证截图（全景、拖拽清晰度、多 Tab 懒渲染、Reach/Route 与 Change Blueprint）作为 `--artifact`；完成 `fixtures-visual-engine.mjs` 冲突 v5 断言迁移与 `fixtures-studio-ux.mjs` (new) 补测，保持 `[Sandbox-C8]` 与 `I961..I964` 全绿并补齐 Wave 3 专属故障注入；同步更新 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、`README.md`/`README.en.md` 与 `equip.mjs .`，执行 `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 确认用户经 `oil-ui-pro` 3 方向对比页拍板主题 Token 并完成本切片 `approve` | 本切片 `approved: true` | Wave 1 与 Wave 2 合入 |
| 2 | 拆分 `visual-brief-store.mjs` 与 `verify-tools-render.mjs`，同步先补 `scripts/dev/fixtures-studio-ux.mjs` (new) 失败断言并迁移 `fixtures-visual-engine.mjs` 冲突 v5 断言 | `node scripts/dev/fixtures.mjs --domain studio-ux` 必红 | 步骤 1 |
| 3 | 实现 `visual-render-svg.mjs`、`visual-render-client.mjs`、`visual-render-client-diagrams.mjs`，重构 `visual-render*.mjs`、`visual-brief.mjs`、`architecture-map.mjs` 与 `doc-plan.mjs`/`verify-tools.mjs` CLI 对拍 | `fixtures-visual-engine.mjs`、`fixtures-studio-ux.mjs`、`fixtures-living-brief.mjs` 与 `fixtures-sandbox-dual-loop.mjs` 全绿 | 步骤 2 |
| 4 | 调用外部 `oil-ui-pro` 真浏览器截图脚本采集浅/深色全屏与交互截图迭代打磨，留存 `--artifact` 实证 | 浅/深色截图无模糊、无重叠、无裁切且对比度达标 | 步骤 3 |
| 5 | 补齐 Wave 3 专属故障注入，同步 `docs/TDD.md`、`docs/feature-map.json`、干净 `docs/architecture-map.html`、`README.md`/`README.en.md` 与 `equip.mjs .` | `node scripts/dev/merge-gate.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4` 与 `node scripts/sync-toc.mjs README.md README.en.md --check` 全绿 | 步骤 4 |

## 断点与遗留决策

- **当前状态**：`进行中`（并在 `approve` 前完成 `oil-ui-pro` 3 方向主题选型）
- **待拍板事项**：无
- **下一步第一件事**：Wave 1/2 合入并确认主题 Token 后，拆分 `kit/skills/lib/visual-brief-store.mjs` (new) 与 `kit/skills/dev-verify-tools/scripts/verify-tools-render.mjs` (new)，并补齐 `scripts/dev/fixtures-studio-ux.mjs` (new) 失败断言。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
