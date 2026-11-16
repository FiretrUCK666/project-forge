---
name: dev-explore
description: |
  只读探索代码库结构、架构入口、模块边界、CI 验证命令、Feature Map 与可复用现成模块。
  触发词：探索代码、梳理架构、这个模块怎么跑的、找入口、代码结构、项目结构、
  先看看代码、哪里定义的、模块边界、可复用模块、read codebase、explore repo、find entrypoints。
  完全只读，不修改任何文件，不创建分支或工作树。
---

# dev-explore：8 阶段前瞻侦察与资产清单

在「**需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入**」闭环中承担**前置只读侦察**与 **`docs/TDD.md` 漂移校准输入**，为 `dev-plan`、`dev-flow` 与 `dev-govern` 提供代码真相。

## 硬性纪律

1. **严格只读**：只读不写，严禁修改、创建或删除任何文件，严禁切换分支。
2. **全深度无盲区枚举**：Git 仓库默认使用 `git ls-files -z` + 4KB NUL 探测（无深度限制，自动忽略 macOS 元数据），通过包清单（`package.json`、`pom.xml`、`build.gradle*`、`Cargo.toml`、`pyproject.toml`、`go.work`、`*.csproj`、`Package.swift`、`Makefile`/`justfile`/`Taskfile.yml`）与带 `working-directory` 的 CI 步骤识别前后端分离与多生态入口。
3. **先查复用再造轮子**：结尾必须输出**可复用现成模块清单**（`reusableModules`、既有脚本、校验器与公共工具），供 `dev-plan` 方案选型与实施复用。
4. **不越权、不当人肉代理**：结合 `Feature Map` 与 `smoke-verify` 锁定真实本地运行入口，动手后由程序跑实证；尊重 `Dev Profile` 显式配置（含 `none`）。

## 四级探索策略（按复杂度选档，不浪费上下文）

| 档位 | 适用场景（与 `survey` / 日常对齐） | 执行动作 | 明确禁止 |
| --- | --- | --- | --- |
| **none（跳过）** | 空白目录 0 业务文件起步（`explorationStrategy.tier: none`） | 直接交给 `--bootstrap-empty` 生成起步工程与初始 `docs/TDD.md` | **禁止派发子代理或运行全量探索** |
| **quick** | 目标文件或符号已明确，只查 1–3 处 | 直接按路径精读或文本检索 1–3 处源码 | **不跑全量脚本、不派只读子代理** |
| **medium** | 单一模块调用链、或 `explorationStrategy.tier: single-pass` 小型仓初始化 | 跑 `repo-map.mjs [--focus <subdir>]` + 单路通读上下游、复用基建与测试命令 | 不跨到无关目录乱翻 |
| **thorough** | `explorationStrategy.tier: parallel-subagents` 存量/重入仓、大型陌生仓或跨模块体检 | 先跑全量 `repo-map.mjs` 拿 `Feature Map`、包清单、CI 步骤与热点，再按**互不重叠 `shards` 目录边界**并行派 2–4 个只读子代理深挖后汇总 | 禁止多个子代理扫描同一目录或直接修改任何文件 |

## 与 `docs/TDD.md` 的读写边界分工

- **`dev-explore` 只读采证**：输出真实文件入口、包清单、CI 命令与可复用基建；**绝不越权写文件**。
- **初始化与跨月重入写入**：空白仓由 `--bootstrap-empty` 一步落盘初始 `docs/TDD.md`；存量接入在装配套件后用本技能输出写入或校准 `docs/TDD.md`（保留人工决策，按需删去不适用的可选节）。
- **日常迭代持续校准**：当 `dev-flow`（`finalize`）、`dev-govern`（`audit`、`docs.tdd-module-drift`）或 `reentry.staleTddPaths` 发现路径漂移时调用本技能定向重扫并同步修订 `docs/TDD.md`。

## 脚本命令（只读）

```sh
# 1. 全景扫描（目录分布、多包清单、Dev Profile、CI run 步骤、可复用模块、Feature Map、git 热点）
node ".agents/skills/dev-explore/scripts/repo-map.mjs" [targetDir] [--dir <path>]

# 2. 聚焦子目录调用边界
node ".agents/skills/dev-explore/scripts/repo-map.mjs" . --focus "<subdir>"

# 3. 输出结构化 JSON 供后续工具衔接
node ".agents/skills/dev-explore/scripts/repo-map.mjs" . --json
```

## 必须交付的探索结论模板与下游移交

1. **真实入口与 Feature Map**：功能/入口名 -> 源码文件路径 -> 可执行的测试或 `smoke-verify` 验证命令。
2. **可复用现成模块清单**：已存在的共享库、辅助函数、契约类型与现成脚本（标注文件路径与导出符号）。
3. **验证与架构边界**：`Dev Profile`（`quick-test`、`smoke-verify`、`merge-gate`、`arch-rules`）以及 CI 实际运行命令与 `working-directory`。
4. **移交下游（无缝衔接）**：
   - 纯问答直接基于证据回答；
   - 进入需求澄清与方案设计时转交 **`dev-plan`**（先跑 `doc-plan.mjs triage`）；
   - 需求已明确且属 Case 1/2 时直接转交 **`dev-flow`**（先跑 `flow.mjs inspect` / `next`）。
