---
kind: spec
title: 引擎 8 项边界缺陷根治与 survey(self) 性能压回 250ms 规划规格
status: draft
tier: L3
created: 2026-11-20
updated: 2026-11-20
issue: 99
pr: null
branch: feat/w1a-engine-fixes
owner: plan-v101
approved: false
implemented: false
plan_critique: pending
related_prd: ../prd/261120-v10-1-hardening-pillars-docs-prd.md
related_todo: ../todo/261120-issue99-w1a-engine-fixes-todo.md
high_risk_paths:
  - scripts/lib/
task_id: w1a-engine-fixes
plan_mode: autonomous
depends_on: []
scope_files:
  - scripts/*.mjs
  - scripts/lib/*.mjs
  - scripts/dev/fixtures-engine-hardening.mjs
  - scripts/dev/injections-data-engine-hardening.mjs
---

# 引擎 8 项边界缺陷根治与 `survey(self)` 性能压回 `<= 250 ms`（Issue `#99`）

> 所属总控 PRD：[v10.1 总控 PRD](../prd/261120-v10-1-hardening-pillars-docs-prd.md)　｜　配对 Todo：[w1a-engine-fixes Todo](../todo/261120-issue99-w1a-engine-fixes-todo.md)
>
> 总控 PRD 认领范围：覆盖总控 `C1..C4`（总控 `C1` -> 切片 `C1..C2`；总控 `C2` -> 切片 `C3..C4`；总控 `C3` -> 切片 `C5..C7`；总控 `C4` -> 切片 `C8` 及双向证伪门禁）。

## 一、目标、剖析证据与非目标

<!-- section: goal -->
### 1.1 问题背景与实测基线

Stage C 合入 `main` 后，针对零文件起步空目录、`LoopForge-main` 大型多包仓与本仓 `node scripts/dev/bench.mjs` 执行盲测，暴露出引擎层 8 处边界误判与性能回归：

- **规则误报与二遍收敛**：手写 `取舍` 决策被 `agents-sections.mjs` 当成模板漂移报错；新增自定义技能后需连跑两次 `compose-agents.mjs` 才能同时更新 `意图路由` 与 `探索策略`；存在 `existingDesignDocs` 存量架构文档时 `review.mjs` 仍误报缺少 `docs/TDD.md`。
- **多包与大仓误判**：`survey-ecosystem.mjs` 把 `vendor/**`、`third_party/**` 及 `**/vscode-web/extensions/**` 计入子包并撑破 `AGENTS.md` `30KB` 上限；`survey-workspace.mjs` 把全文件已纳入 Git 跟踪的输出目录误判为 `unignoredOutputDirs` 与 `ignoredButTracked` 死锁；`equip-bootstrap.mjs` 在空项目生成带有悬空 `scripts/compose-agents.mjs` 的 `README.md`；`handoff.mjs` 未按 `dirname(rel)` 解析内部 `references/*.md` 且未将嵌入第三方大文件与真实漏扫区分。
- **实测性能回退（`survey(self) = 289.2 ms`，预算红线 `250 ms`）**：`scripts/dev/bench.mjs` 中 `SURVEY_SELF_BUDGET_MS` 为 `250`，当前实测剖析分解如下：
  1. `scripts/lib/survey-workspace.mjs` 在 `rawLogLines >= 500` 时串行同步执行 `git rev-list --count HEAD`，单次占用约 `52 ms`；
  2. `scripts/lib/survey-workspace.mjs` 对约 `486` 个文件执行过宽 `SECRET_FAST_PRECHECK_RE`（预检误命中 `95` 次）与 `mightHaveHome`（预检误命中 `63` 次），导致大量无关代码与技能示例进入重正则二次扫描；
  3. `scripts/lib/survey-scan.mjs` 与下游探针重复遍历 `.agents/skills/`。

### 1.2 非目标（Explicit Non-Goals）

<!-- section: non-goals -->
- 严禁放宽 `scripts/dev/bench.mjs` 中 `SURVEY_SELF_BUDGET_MS = 250` 预算阈值或 `30KB` 上限。
- 不修改 `kit/`、`templates/agents-project.md` 或 `.agents/`（零碰撞边界，避免触及 Wave 2 写域）。
- 不引入任何第三方依赖或异步进程池外部工具，仅使用 Node 18+ `node:*` 内置模块。
<!-- section: non-goals-end -->
<!-- section: goal-end -->

## 二、技术设计与根治方案（`C1..C8`）

<!-- section: design -->
```mermaid
flowchart LR
  Scan["单遍扫工作区"] --> Fast["快速路径降噪"]
  Fast --> Eco["过滤嵌入子包"]
  Eco --> Sec["语义区防误报"]
  Sec --> Rev["对齐设计文档"]
  Rev --> Perf["实测压回 250ms"]
```

| 缺陷项 | 根因定位 | 根治方案与目标符号 |
| --- | --- | --- |
| `C1` 手写 `取舍` 漂移 | `scripts/lib/agents-sections.mjs` `driftRegions` 只跳过 `customized` 与 `isCalibratedDevProfile`，未豁免用户手写 `取舍` | 将 `region.id === '取舍'` 纳入语义免字面漂移检查（仍要求非空有效正文，禁空骨架占位直接过审），同步确保 `review.mjs` 与 `compose-agents.mjs --check` 零修改手写 `取舍` 即可通过 |
| `C2` 自定义技能需跑两遍 | `scripts/compose-agents.mjs` `factsOf` 与 `refreshRegions` 分离且 `explorationStrategyBlock` / `renderKitRoutingRows` 未在单次写盘前后共用新技能清单 | 在单遍 `compose-agents.mjs` 内先行识别自定义技能目录与新技能矩阵，令 `意图路由`（`findMissingIntentRoutingSkills` 对齐）与 `探索策略` 同批注入并完成验证，单次运行即通过 `--check` |
| `C3` 嵌入子包撑爆 `30KB` | `scripts/lib/survey-ecosystem.mjs` `listWorkspaceCandidateDirs` / `scanSubdirectories` 扫描了 `vendor/**`、`third_party/**`、`**/vscode-web/extensions/**` 等嵌入第三方源码，且超多子包全量平铺 | 显式跳过嵌入第三方前缀/路径段（支持 `vendor/**`、`third_party/**`、`**/vscode-web/extensions/**`）；在 `scripts/lib/agents-defaults.mjs` `commandsBlock` 对超出阈值的多子包按顶层分组聚合摘要，确保生成的 `AGENTS.md <= 30720 B` |
| `C4` 输出目录误报死锁 | `scripts/lib/survey-workspace.mjs` 对任何命中的 `OUTPUT_DIRS`（`dist`/`build`/`out`/`coverage`/`bin`）直接判入 `unignoredOutputDirs`，未检查目录内文件是否全部已被 Git 跟踪 | 仅当某输出目录在工作区或未跟踪清单中真实存在至少 1 个未跟踪文件时才加入 `unignoredOutputDirs`；若目录下文件已 100% 在 `trackedSet` 中，不再同时触发 `unignoredOutputDirs` 矛盾告警 |
| `C5` 存量架构文档误报 | `scripts/review.mjs` 读 `facts.docs.archDocs ?? facts.docs.designDocs ?? facts.docs.existingArchDocs`，而 `scripts/lib/survey-docs.mjs` 与 `scripts/survey.mjs` 写入的是 `existingDesignDocs` | 对齐 `scripts/review.mjs` 读取 `facts.docs.existingDesignDocs` 并尊重 `tdd-authority` 取舍策略，当项目已有合宪存量架构文档时不再误报缺 `docs/TDD.md` |
| `C6` 空起步 README 悬空指针 | `scripts/lib/equip-bootstrap.mjs` 向被治理项目写入了本工具私有的 `node scripts/compose-agents.mjs .` 提示命令 | 清除 `equip-bootstrap.mjs` 面向宿主生成 `README.md` 中的 `scripts/compose-agents.mjs` 悬空调用，改为指向目标仓自身标准入口或真实生成的技能检查契约 |
| `C7` `handoff.mjs` 内部引用与大文件误报 | `scripts/handoff.mjs` `SKILL_INTERNAL_RE` 匹配宽泛且按 `join(root, target)` 而非 `dirname(rel)` 校验；`MAX_BYTES` 仅记录 `truncated` 未区分嵌入第三方文件 | 基于当前文件 `dirname(rel)` 解析相对 `references/*.md` 路径并限定 `SKILL_INTERNAL_RE` 为本工具参考前缀；跳过/标注 vendored 嵌入目录下的大文件为第三方跳过态而非隐秘漏扫 |
| `C8` `survey(self)` 超 `250 ms` | 串行 `rev-list --count HEAD` ~52ms；486 文件宽预检误命中 95/63 次；`.agents/skills/` 重复扫描 | 1. 若无深历史精确要求则以并行采集或 `dotFast`/快速打包索引计数替代阻塞串行 `rev-list`；2. 收紧 `SECRET_FAST_PRECHECK_RE` 与 `mightHaveHome`（排除 `.agents/skills/`、测试 fixture 示例占位及明显非凭证段落，减少误触发）；3. 在 `scripts/lib/survey-scan.mjs` 复用单遍 `.agents/` 文件遍历结果喂给下游探针 |

### 2.1 可复用既有基础设施

<!-- section: reuse -->
- `scripts/lib/survey-scan.mjs`（已有单遍文件系统扫描骨架）
- `scripts/lib/agents-sections.mjs`（受管区间解析与 `isCalibratedDevProfile` 语义免漂移模式）
- `scripts/dev/bench.mjs`（唯一权威性能门禁脚本，`SURVEY_SELF_BUDGET_MS = 250`）
- `scripts/dev/fixtures-helpers.mjs`（隔离沙盒夹具通用辅助）
<!-- section: reuse-end -->

### 2.2 备选方案与取舍

<!-- section: alternatives -->
- **性能压降路线**：曾考虑通过缓存 `.git` 状态到仓外临时文件加速（否定，违背每次只读无副作用的 CLI 契约并引入陈旧缓存风险）；最终选用单遍目录复用 + 并行 Git 探针 + 精准预检规则，纯无状态提速且完全可测。
- **超多子包聚合策略**：曾考虑直接硬截断保留前 N 个子包（否定，会静默丢包）；改为按父包分组折叠计数并保留顶层命令入口，既保信息完整又守住 `30KB` 上限。
<!-- section: alternatives-end -->
<!-- section: design-end -->

## 三、门型评估、正反双向验收与故障注入矩阵

<!-- section: gates -->
- **门型**：`two-way`（但 `scripts/lib/` 属本仓高风险路径，须通过独立审查 + `I225–I239` 故障注入实证）。
- **验证命令契约**：
  - `node scripts/dev/fixtures.mjs --domain engine-hardening`
  - `node scripts/dev/bench.mjs --strict-budget`（连续 3 轮中位数 `survey(self) <= 250 ms`，且连带 `review(self) <= 450 ms`）
  - 逐条校验注入（如 `node scripts/dev/verify-injections.mjs --only I225` 至 `I232`）或全量 `node scripts/dev/verify-injections.mjs`
  - 全仓合前：`merge-gate` 全绿。
<!-- section: gates-end -->

<!-- section: acceptance -->
### 验收标准（对应 Issue `#99` 与总控 `C1..C4`）

<!-- criteria:start -->
- [ ] **C1**：`compose-agents.mjs` / `agents-sections.mjs` 将手写 `## 取舍` 纳入免模板字面漂移比对语义区，用户填写取舍决策后无需手工标 `customized` 即可通过 `--check` 与 `review.mjs`；反例为空骨架残留占位仍被拦截。
- [ ] **C2**：新增自定义技能后单次运行 `compose-agents.mjs` 同时收敛 `意图路由` 与 `探索策略`，无需跑第二遍即通过 `--check`；反例为手工删除其中一节触发 `--check` 报错退出。
- [ ] **C3**：`survey-ecosystem.mjs` / `compose-agents.mjs` 跳过 `vendor/**`、`third_party/**`、`**/vscode-web/extensions/**` 等 vendored 嵌入子包并对超多子包聚合摘要，避免撑破 `AGENTS.md` `30KB` 上限；反例为真实未豁免的顶层工作区子包仍被精准识别。
- [ ] **C4**：`survey-workspace.mjs` 在 Git 仓仅当同名输出目录（`dist`/`build`/`out`/`coverage`/`bin`）实际包含未跟踪文件时才报 `unignoredOutputDirs`，消除合法已跟踪目录的 `git.output-dirs` 与 `ignoredButTracked` 死锁；反例为同目录下存在未跟踪产物文件时必须继续报错。
- [ ] **C5**：`review.mjs` 读取 `facts.docs.existingDesignDocs` 与 `tdd-authority`，存在存量架构文档时不再误报缺 `docs/TDD.md`；反例为仓内无任何架构设计文档且无豁免时仍报缺口。
- [ ] **C6**：`equip-bootstrap.mjs` 空目录起步生成的 `README.md` 不再包含指向 `scripts/compose-agents.mjs` 的悬空指针，且生成内容通过自身合规检查。
- [ ] **C7**：`handoff.mjs` 按 `dirname(rel)` 校验相对 `references/*.md`、限定 `SKILL_INTERNAL_RE` 为本工具真实参考文档，并区分 vendored 大文件与真实漏扫；反例为真实缺失相对引用或源码越界泄露仍阻断。
- [ ] **C8**：剖析并优化 `survey.mjs` / `survey-scan.mjs` / `survey-workspace.mjs`，使 `node scripts/dev/bench.mjs` 的 `survey(self)` 本地 1x 实测中位数回到 `<= 250 ms`（严禁放宽预算阈值），并在 `scripts/dev/fixtures-engine-hardening.mjs` (new) 与 `scripts/dev/injections-data-engine-hardening.mjs` (new)（号段 `I225–I239`）覆盖全部 8 项正反断言。
<!-- criteria:end -->
<!-- section: acceptance-end -->

## 四、待拍板问题

<!-- section: pending -->
- 已定：8 项根因定位、`survey(self)` 剖析数据（`289.2 ms` 基线拆解）与正反用例及 `I225–I239` 注入边界均已实证确认锁定，无未决事项。
<!-- section: pending-end -->
