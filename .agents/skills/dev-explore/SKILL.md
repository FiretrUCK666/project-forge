---
name: dev-explore
description: |
  只读探索代码库结构、架构入口、模块边界、CI 验证命令、Feature Map、可复用现成模块与零写入按需定位（doc-locate）。
  触发词：探索代码、梳理架构、这个模块怎么跑的、找入口、代码结构、项目结构、按需定位、定位文档、定位符号、
  先看看代码、哪里定义的、模块边界、可复用模块、read codebase、explore repo、find entrypoints、doc-locate。
  完全只读，不修改任何文件，不创建分支或工作树。
metadata:
  intent: 理解项目 / 梳理架构 / 找模块入口 / 按需定位文档与符号
  script: "`node .agents/skills/dev-explore/scripts/doc-locate.mjs` / `repo-map.mjs`"
  order: 10
  fallback: 手工查看项目清单、CI 工作流与入口源码（未装配 dev-explore 技能）
---

# dev-explore：8 阶段前瞻侦察、零写入按需定位与资产清单

在「**需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入**」闭环中承担**前置只读侦察**、**零写入按需定位（`doc-locate.mjs`）**与 **`docs/TDD.md` 漂移校准输入**，为 `dev-plan`、`dev-flow` 与 `dev-govern` 提供代码与文档真相。

## 硬性纪律

1. **严格只读（零写入红线）**：默认只读不写，严禁修改、创建或删除任何仓内文件（仅显式传 `--topic <id>` 时向仓外 Working Brief 写入已验真锚点并刷新仓外 Living Visual Brief，或显式 `repo-map.mjs --write-feature-map` 时增量更新 `docs/feature-map.json` v2 拓扑与 `docs/architecture-map.html`），严禁切换分支。
2. **先定位再通读**：查特定文档章节、规划契约或源码符号时，**优先运行 `doc-locate.mjs`** 获取绝对路径、`startLine..endLine` 与受预算控制的切片，不把长文档整篇灌入上下文。
3. **全深度无盲区枚举**：Git 仓库默认使用 `git ls-files -z` + 4KB NUL 探测（无深度限制，自动忽略 macOS 元数据），通过包清单与带 `working-directory` 的 CI 步骤识别前后端分离、CLI 与多生态入口；同步识别 `ARCHITECTURE.md`、子目录 `*/AGENTS.md` 与无头/非 Frontmatter 文档（首段非空摘要）。
4. **先查复用再造轮子**：结尾必须输出**可复用现成模块清单**（`reusableModules`、既有脚本、校验器与公共工具），供 `dev-plan` 方案选型与实施复用。
5. **不越权、不当人肉代理**：结合 `Feature Map`、`businessFlows` 与 `smoke-verify` 锁定真实本地运行入口，动手后由程序跑实证；尊重 `Dev Profile` 显式配置（含 `none`）。

## 弹性探索策略（按上下文污染与不确定性选档，不写死文件数或行数阈值）

- **弹性调度原则**：检索目标收敛且不污染主上下文时，主 Agent 可直接运行 `doc-locate.mjs` / `repo-map.mjs` 精准切片；广度高、跨多模块或不确定性强时派发并行只读 `explore` 子代理并以简洁结构化回执收口（**不设固定文件数或简报行数死线**）。

| 档位 | 适用场景（与勘察 / 日常对齐） | 执行动作 | 明确禁止 |
| --- | --- | --- | --- |
| **none（跳过）** | 空白目录 0 业务文件起步（`explorationStrategy.tier: none`） | 直接交给 `--bootstrap-empty` 生成起步工程与初始 `docs/TDD.md` | **禁止派发子代理或运行全量探索** |
| **quick** | 目标收敛、不污染主上下文 | 直接运行 `doc-locate.mjs`（`--file`/`--section`/`--symbol`/`--query`）按行区间精读 | **不跑全量脚本、不整篇通读长文档、不派冗余子代理** |
| **medium** | 单一模块调用链、或 `explorationStrategy.tier: single-pass` 小型仓初始化 | 跑 `repo-map.mjs [--focus <subdir>]` + `doc-locate.mjs` 定位上下游契约、复用基建与测试命令 | 不跨到无关目录乱翻 |
| **thorough** | `explorationStrategy.tier: parallel-subagents` 存量/重入仓、广度高或强不确定性跨模块探索 | 先跑全量 `repo-map.mjs` 拿 `Feature Map`、文档索引、包清单、CI 步骤与热点，再按**互不重叠 `shards` 目录边界**并行派只读子代理深挖并用简洁结构化回执收口 | 禁止多个子代理扫描同一目录或直接修改任何文件 |

## 与 `docs/TDD.md` 的读写边界分工

- **本技能一律只读**：输出真实文件入口、包清单、CI 命令、文档切片与可复用基建；**绝不写任何文件，包括 `docs/TDD.md`**。
- **写入归谁**：
  - 空白仓的初始 `docs/TDD.md` 由 `equip --bootstrap-empty` 一步落盘；
  - 存量仓的校准由 `dev-govern` 指出该改哪里（`docs.tdd-module-drift` 一类结论），架构结论由人落笔或由 `dev-plan` 写进 PRD/SPEC；
  - 本技能只负责把真相查清楚、说清楚。
- **日常迭代持续校准**：当 `dev-flow`（`finalize`）、`dev-govern`（`audit`、`docs.tdd-module-drift`）或 `reentry.staleTddPaths` 发现路径漂移时调用本技能定向重扫并同步修订 `docs/TDD.md`。

## 脚本命令（只读）

```sh
# 1. 文档与符号零写入按需定位（支持 --list 仅列出可索引文档与路径）
node ".agents/skills/dev-explore/scripts/doc-locate.mjs" --query "<关键词>" [--scope docs|src|all] [--kind prd|spec|todo|adr|doc|code] [--limit 5] [--budget-lines 220] [--json]
node ".agents/skills/dev-explore/scripts/doc-locate.mjs" --list [--scope docs|src|all] [--kind <kind>] [--json]

# 2. 按文件与 Markdown 标题节精确切片（跳过代码围栏内 # 注释，兼容无头文档）
node ".agents/skills/dev-explore/scripts/doc-locate.mjs" --file "docs/TDD.md" --section "<章节名>"

# 3. 定位源码符号定义边界（支持 --worktree 指向隔离工作树）
node ".agents/skills/dev-explore/scripts/doc-locate.mjs" --symbol "<符号名>" --scope src [--worktree "<path>"] --json

# 4. 全景扫描（支持 --task 回写探索凭据与 --write-feature-map 增量预填唯一功能地图）
node ".agents/skills/dev-explore/scripts/repo-map.mjs" [targetDir] [--dir <path>] [--task <id>] [--write-feature-map]

# 5. 聚焦子目录调用边界或输出结构化 JSON
node ".agents/skills/dev-explore/scripts/repo-map.mjs" . --focus "<subdir>" [--json]
node ".agents/skills/dev-explore/scripts/repo-map.mjs" . --write-feature-map --json
```

## 必须交付的探索结论模板与下游移交

1. **真实入口、Feature Map 与 Business Flows**：功能/入口名 -> 源码文件路径 -> 可执行的测试或 `smoke-verify` 验证命令，以及 `businessFlows`（服务对象、路由/CLI/UI/作业面、文档源码差异）。
2. **关键文档与符号定位切片**：基于 `doc-locate.mjs` 返回的绝对路径、`startLine..endLine`、无头摘要与可复读定位命令（覆盖 `docs/TDD.md`、`ARCHITECTURE.md`、`*/AGENTS.md` 与相关规范）。
3. **可复用现成模块清单**：已存在的共享库、辅助函数、契约类型与现成脚本（标注文件路径与导出符号）。
4. **验证与架构边界**：`Dev Profile`（`quick-test`、`smoke-verify`、`merge-gate`、`arch-rules`）以及 CI 实际运行命令与 `working-directory`。
5. **移交下游（无缝衔接）**：
   - 纯问答直接基于证据回答；
   - 进入需求澄清与方案设计时转交 **`dev-plan`**（先跑 `doc-plan.mjs triage`）；
   - 需求已明确且属 Case 1/2 时直接转交 **`dev-flow`**（先跑 `flow.mjs inspect` / `next`）。
