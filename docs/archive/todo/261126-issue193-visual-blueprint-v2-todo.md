---
kind: todo
title: Universal Layered Visual Architecture and 4-State Change Blueprint
status: done
created: 2026-11-26
updated: 2026-11-26
issue: 193
pr: null
branch: feat/visual-blueprint-v2
owner: planner-blueprint
plan_mode: autonomous
approved: false
done_at: 2026-11-26
task_id: visual-blueprint-v2
planned_at: 09aa4a80e1c0a00d9c7f9e31c129e4efb9af33d7
related_prd: null
related_spec: ../specs/261126-issue193-visual-blueprint-v2-spec.md
---

# Universal Layered Visual Architecture and 4-State Change Blueprint

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / 基线 | `feat/visual-blueprint-v2` @ `09aa4a8` |
| 任务编号 | `visual-blueprint-v2` |
| 负责人 / 审批 | planner-blueprint / `false` |
| 规划态 | `autonomous`（按仓内既有最佳模式推进，经独立 Critique 过审并批准后交实施子代理执行） |
| 关联 Issue / PR / SPEC | #193 / 未关联 / `docs/archive/specs/261126-issue193-visual-blueprint-v2-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261126-issue193-visual-blueprint-v2-spec.md` 最新内容。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/visual-layout.mjs`、`kit/skills/lib/visual-brief.mjs`、`kit/skills/lib/visual-render-panels.mjs` (new)、`kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-assets.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/SKILL.md`、`docs/TDD.md`、`docs/architecture-map.html`、`scripts/dev/fixtures-visual-engine.mjs`、`scripts/dev/fixtures-living-brief.mjs`
- **复用既有模块**：`kit/skills/lib/feature-map-graph.mjs`（`buildFallbackDomains`）、`kit/skills/lib/visual-layout.mjs` 既有转义与路径清洗函数、`kit/skills/lib/git-core.mjs`（`sha256Text`）、`kit/skills/lib/cli.mjs`（`parseStandardCli`）
- **本期不做**：不修改 `docs/feature-map.json` Schema；不引入第三方依赖；不改动 `buildGeneratedHeaderLine` Line-1 签名与 `isUiVisualFile` 豁免逻辑
- **门型与回滚路径**：one-way；触及 `kit/` 核心库与公共 CLI 契约，异常时通过分支 `git revert` 并重跑 `node scripts/equip.mjs .` 回退。
- **快测命令**：`node scripts/dev/fixtures.mjs --domain visual-engine && node scripts/dev/fixtures.mjs --domain living-brief`

## 验收标准与执行清单

- [x] C1: `kit/skills/lib/visual-layout.mjs`（`<= 750` 行）实现 5 态 `DIFF_STATES = ['added', 'modified', 'removed', 'impacted', 'context']`、Kahn 拓扑分层域排序、稳定 `domain.id` 调色板锁定、`addedNodes[]` 合成独立新域与虚拟绿虚线边、`removed[]`/`featureChanges` 映射、多源聚合 BFS `impactReasons` 与 `284 x 114` 顶部 eyebrow 防截断几何；由 `node scripts/dev/fixtures.mjs --domain visual-engine` 验证通过。
- [x] C2: `kit/skills/lib/visual-brief.mjs`（`<= 795` 行，接近 780 行即抽离解析辅助）、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs` 与 `kit/skills/dev-plan/SKILL.md`（`< 14 KB`、`<= 180` 行，围栏代码块禁字面箭头规避 `cli-parity`）支持 Sidecar `featureChanges`/`addedFeatures`/`removedFeatures`、三态 `--affected-feature`（兼容 `->`/`=>`/`::`）、新 `--add-feature`/`--remove-feature`（纳入 `hasMutation`、异常格式退码 `2`），并通过 `node scripts/dev/cli-parity.mjs`、`node scripts/dev/subcommand-parity.mjs` 与 `node scripts/dev/fixtures.mjs --domain living-brief`。
- [x] C3: 新增 `kit/skills/lib/visual-render-panels.mjs` (new) 并更新 `kit/skills/lib/visual-render.mjs`、`kit/skills/lib/visual-render-assets.mjs`（三文件各 `<= 650` 行），实现单行顶栏（仅 1 个上下文 `复制追问` 按钮）、左下角浮动缩放胶囊、单条域聚焦/仅看变更栏、零左竖条四态样式、`compactClientModel` 透传 `impactReasons`/`changeDetail`/`isVirtual`、无嵌套灰盒可扫读详情区（`1.1rem` 标题、`0.88rem` 正文、顶部 `本次改动`、双列上下游胶囊、垂直流转时间线、折叠源码与验证）、模式感知默认页签与 `flows.length > 0` 默认选中 `flows[0]` 故事板，保留 `switchTab('tree'|'flow')`、`.walk-bar` 等既有交互锚点；由 `node scripts/dev/fixtures.mjs --domain visual-engine` 断言通过。
- [x] C4: 4 功能夹具 HTML 体积严格 `25–60 KB`（`25600–61440` 字节；基线已 `58,549 B`，须紧凑压缩 CSS/JS 并在 `architecture-map` 模式省略 brief 专属 DOM），零三方依赖、零 emoji、零 `homedir()` 泄漏、XSS 与危险协议阻断、`file://` 三级剪贴板降级与 `localStorage` `try/catch`；重渲 `docs/architecture-map.html`、同步 `docs/TDD.md`，且 `node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check` 与 `node scripts/dev/preflight.mjs` 全绿。
- [x] C5: `scripts/dev/fixtures-visual-engine.mjs` 与 `scripts/dev/fixtures-living-brief.mjs` 具备正反双向用例与 `node:vm` `Script` 解析门禁，完成真实 `1440x900` 浅色/深色无头 Chrome 全 5 视图交互与零报错实证，并在 `flow.mjs verify` 附 `--artifact` 实证。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先补 C1/C2/C3 失败测试断言（Red） | `node scripts/dev/fixtures.mjs --domain visual-engine` 红灯 | 无 |
| 2 | 改造 `visual-layout.mjs` 实现拓扑排序、4 态图与 `284 x 114` 几何 | `node scripts/dev/fixtures.mjs --domain visual-engine` C1 通过 | 步骤 1 |
| 3 | 改造 `visual-brief.mjs`、`doc-plan-brief.mjs`、`doc-plan.mjs` 与 `kit/skills/dev-plan/SKILL.md` | `cli-parity.mjs`、`subcommand-parity.mjs` 与 `living-brief` 通过 | 步骤 2 |
| 4 | 拆分 `visual-render-panels.mjs` 并重构 `visual-render.mjs` 与 `visual-render-assets.mjs` | 三文件 `<= 650` L 且 `25-60 KB` 预算与 `visual-engine` 通过 | 步骤 2 |
| 5 | 同步 `docs/TDD.md`、`docs/architecture-map.html` 与 `node scripts/equip.mjs .` | `equip --check`、`compose-agents --check`、`preflight.mjs` 全绿 | 步骤 3、4 |
| 6 | 运行 1440x900 浅/深色无头 Chrome 全 5 视图交互实证与 `edit-gate --final` | 5 视图零 console/pageerror、截屏产物落盘、`verify` 绿灯 | 步骤 5 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 4 功能夹具 HTML 超出 60 KB 上限 | 新增蓝图面板与详情 CSS/JS 体积膨胀 | 将静态样式紧凑命名、复用 `visual-render-assets.mjs` 精简 DOM 构建，每次渲染后校验 `25-60 KB` |
| `kit/skills/dev-plan/SKILL.md` 超出 14 KB 告警阈值 | 新增参数文档占用过多字节 | 压缩 `brief` 行内示例并保持整篇 `< 14336` 字节、`< 180` 行 |
| `doc-plan` 新增参数触发 `cli-parity` 死/暗参数报错 | `doc-plan.mjs` 与 `doc-plan-brief.mjs` 未同步 | 同提交在 `multiFlags`、`printHelp()` 与 `opts[...]` 三处齐改并实跑 `cli-parity.mjs` |

## 回滚预案

- **出问题时的第一步**：运行 `node scripts/dev/preflight.mjs` 与 `node scripts/equip.mjs . --check` 定位破坏范围。
- **回滚用什么**：在特性分支执行 `git revert <commit>`（或重建干净分支）并重新执行 `node scripts/equip.mjs .` 还原 `.agents/skills/`。
- **回滚之后要做什么**：运行 `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render .` 恢复 `docs/architecture-map.html` 一致性。

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（规划文本已完备，待 Round 2 独立 Critique 审查与批准后由独立实施者 `!== planner-blueprint` 执行 `flow.mjs start` 绑定真实 GitHub Issue 并转入实施）
- **待拍板事项**：无
- **下一步第一件事**：派发独立只读 Critic（非 `critic-bp-r1`）运行 Round 2 `doc-plan.mjs critique-scope` 与 `critique-pass`，通过后由维护者 `approve`，再由独立实施者通过 `flow.mjs start --task visual-blueprint-v2 --agent <implId>` 退出 `--planning` 并绑定 Issue 启动实施。

## 澄清与补充记录

- 已定（`autonomous`）：统一采用模块化渲染（`kit/skills/lib/visual-render-panels.mjs` (new) `<= 650` L）、单行顶栏+唯一追问按钮、无左竖条四态样式与默认首流故事板。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/dev/preflight.mjs`：41 项全通过（0 失败）
  - `node scripts/dev/fixtures.mjs --domain visual-engine` & `--domain living-brief`：5/5 + 5/5 通过（4 功能 HTML `54,532 B`）
  - `node scripts/dev/verify-injections.mjs --jobs 4`：467/467 故障注入全部拦截
  - `node scripts/dev/cli-parity.mjs`、`node scripts/dev/subcommand-parity.mjs`、`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`、`govern-audit.mjs audit .`：全部通过
  - 无头 Chrome 1440×900 浅/深色全 5 视图实证：`0` consoleErrors / `0` pageErrors
- **文档同步检查**：已同步 `docs/TDD.md`（登记 `kit/skills/lib/visual-render-panels.mjs`）、`kit/skills/dev-plan/SKILL.md`（`13,101 B`, `92 L`）、`.agents/skills/` 与 `docs/architecture-map.html`（`132,369 B`）
- **遗留问题**：无
