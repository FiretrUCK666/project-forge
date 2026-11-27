---
kind: todo
title: 零 Token 增量静态分析与多图证据抽取引擎
status: active
created: 2026-11-27
updated: 2026-11-27
issue: 219
pr: null
branch: feat/zero-token-static-analyzer
owner: plan-studio-b
plan_mode: interactive
approved: false
done_at: null
task_id: zero-token-static-analyzer
planned_at: 76795202dbd2d328d379fbff506b7dad39753133
related_prd: ../prd/261127-issue219-visual-studio-archify-v2-prd.md
related_spec: ../specs/261127-issue219-zero-token-static-analyzer-spec.md
---

# 零 Token 增量静态分析与多图证据抽取引擎

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/zero-token-static-analyzer` @ `7679520` |
| 任务编号 | `zero-token-static-analyzer` |
| 负责人 / 审批 | plan-studio-b / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | #219 / 未关联 / `docs/specs/261127-issue219-zero-token-static-analyzer-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC 审批状态。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/import-graph.mjs` (new)、`kit/skills/lib/static-analyzer.mjs` (new)、`kit/skills/lib/static-evidence.mjs` (new)、`kit/skills/lib/diff-materiality.mjs` (new)、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/doc-graph.mjs`、`kit/skills/lib/architecture-map.mjs`、`scripts/dev/fixtures-static-analyzer.mjs` (new)、`scripts/dev/injections-data-static-analyzer.mjs` (new)、`docs/feature-map.json`、`docs/architecture-map.html`
- **复用既有模块**：`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/static-gates-lexer.mjs`、`kit/skills/lib/doc-graph.mjs`、`kit/skills/lib/symbol-index.mjs`、`kit/skills/lib/git.mjs`、`kit/skills/lib/git-fast.mjs`
- **本期不做**：不实现图表几何布局与 HTML/CSS/JS 前端渲染，不引入第三方 npm 依赖
- **门型与回滚路径**：`one-way`（高风险路径 `kit/`）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [x] C1: `kit/skills/lib/static-analyzer.mjs` (new) 复用 `import-graph.mjs` 与 `doc-graph.mjs` 的 `findSccs`，在 `<gitCommonDir>/project-forge-flow/analysis-cache.json` 实现按 `relPath + blobSha/mtime` 的增量缓存，准确输出依赖图、`fanIn`/`fanOut`/cycles 与 Git 热度，工作区 `git status --porcelain` 保持为空（`node scripts/dev/fixtures.mjs --domain static-analyzer` 通过）。
- [x] C2: `kit/skills/lib/static-evidence.mjs` (new) 对 10 类图表严格执行 3 层证据门控（Tier 1 常驻，Tier 2 中 `erd`/`class >= 3`/`sequence >= 3 跳`/`lifecycle`/`dataflow`/`timeline >= 2` 缺证据不激活且返回空 Tab 为 0，Tier 3 `waterfall` 仅真实实测 span 激活），正反双向断言全过。
- [x] C3: `kit/skills/lib/diff-materiality.mjs` (new) 基于 `merge-base(base, HEAD)...HEAD` 3-dot 差异精确识别 Schema/迁移必触发、纯文档/锁文件/纯重命名跳过，输出 1-hop 邻域与有界 hunk；`architecture-map.mjs` 保持 `renderArchitectureMapFromRepo` 既有参数契约（保 `I986` 与 `checkExitCodeParity` 有效），并单点由 `verifyArchitectureMapSync` 解析 `pf-visual-data` JSON 与剥离 `<style>`/`<script>` 后以既有 `BLOCKED_ARCHITECTURE_MAP_DRIFT`（`reason: 'dirty-diff-overlay'`）精准拦截含脏 diff 节点的常青 `docs/architecture-map.html`。
- [x] C4: `scripts/dev/fixtures-static-analyzer.mjs` (new) 与 `scripts/dev/injections-data-static-analyzer.mjs` (new) 覆盖 7 类异构仓库栈正反双向验证并全量捕获注入故障；同步更新 `docs/feature-map.json`、`docs/architecture-map.html` 与 `node scripts/equip.mjs . --check`，`node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs --domain static-analyzer` 退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 下沉 `import-graph.mjs` 并导出 `doc-graph.mjs` 的 `findSccs`，同步瘦身 `static-gates.mjs` | `node scripts/dev/preflight.mjs` 全绿 | 切片获批 |
| 2 | 先补失败断言 `scripts/dev/fixtures-static-analyzer.mjs` (new)（7 栈异构仓、缓存、3 层阈值、3-dot Materiality 与脏图拦截） | `node scripts/dev/fixtures.mjs --domain static-analyzer` 必红 | 步骤 1 |
| 3 | 实现 `static-analyzer.mjs`、`static-evidence.mjs`、`diff-materiality.mjs` 并加固 `architecture-map.mjs` | `node scripts/dev/fixtures.mjs --domain static-analyzer` 全绿 | 步骤 2 |
| 4 | 补齐故障注入 `scripts/dev/injections-data-static-analyzer.mjs` (new)，同步 `docs/feature-map.json`、`docs/architecture-map.html` 与 `equip.mjs .` | `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿 | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`进行中`（待总控 PRD 与本切片完成独立 Critique 并经维护者 `approve` 后开工）
- **待拍板事项**：无
- **下一步第一件事**：完成独立 Critique 与 `approve` 后，从 `kit/skills/lib/static-gates.mjs` 抽离 `kit/skills/lib/import-graph.mjs` (new)。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：待全量门禁与故障注入实跑后补齐。
- **文档同步检查**：已同步 `docs/feature-map.json`、`docs/architecture-map.html`、`.agents/skills/`（`equip.mjs .`）与 SPEC `## 实现说明`。
- **遗留问题**：无。
