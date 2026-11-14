---
name: dev-explore
description: |
  只读探索代码库结构、架构入口、模块边界、CI 验证命令、Feature Map 与可复用现成模块。
  触发词：探索代码、梳理架构、这个模块怎么跑的、找入口、代码结构、项目结构、
  先看看代码、哪里定义的、模块边界、可复用模块、read codebase、explore repo、find entrypoints。
  完全只读，不修改任何文件，不创建分支或工作树。
---

# dev-explore：只读分级探索与资产清单

当需要理解仓库全貌、摸清模块调用链、定位复用设施或提取真实运行/验证入口时使用本技能。

## 硬性纪律

1. **严格只读**：只读不写，严禁修改、创建或删除任何文件，严禁切换分支。
2. **先查复用再造轮子**：无论单点还是跨模块探索，结尾必须输出**可复用现成模块清单**（`reusableModules`、既有脚本、校验器与公共工具），规划与实现阶段优先复用。
3. **不越权、不当人肉代理**：结合 `Feature Map` 与 `smoke-verify` 锁定真实本地运行入口，动手后由程序跑实证，禁止把本地能验的流程推给人工猜测。

## 三级探索策略（按复杂度选档，不浪费上下文）

| 档位 | 适用场景 | 执行动作 | 明确禁止 |
| --- | --- | --- | --- |
| **quick** | 目标文件或符号已明确，只查 1–3 处 | 直接按路径精读或文本检索 1–3 处源码 | **不跑全量脚本、不派只读子代理** |
| **medium** | 需摸清单一模块的完整调用链与测试 | 跑 `repo-map.mjs --focus <subdir>` + 沿调用链精读上下游、公共基建与局部测试命令 | 不跨到无关目录乱翻 |
| **thorough** | 陌生仓库、跨模块改造或全局体检前 | 先跑全量 `repo-map.mjs` 拿 `Feature Map`、CI 步骤与热点，再按**互不重叠的目录边界**并行派 2–3 个只读子代理深挖后汇总 | 禁止多个子代理扫描同一目录导致重复消耗 |

## 脚本命令（只读）

```sh
# 1. 全景扫描（目录分布、Dev Profile、CI run 步骤、可复用模块、Feature Map、git 热点）
node ".agents/skills/dev-explore/scripts/repo-map.mjs" [targetDir]

# 2. 聚焦子目录调用边界
node ".agents/skills/dev-explore/scripts/repo-map.mjs" . --focus "<subdir>"

# 3. 输出结构化 JSON 供后续工具衔接
node ".agents/skills/dev-explore/scripts/repo-map.mjs" . --json
```

## 必须交付的探索结论模板

1. **真实入口与 Feature Map**：功能/入口名 -> 源码文件路径 -> 可执行的测试或 `smoke-verify` 验证命令。
2. **可复用现成模块清单**：已存在的共享库、辅助函数、契约类型与现成脚本（标注文件路径与导出符号，防止重复造轮子）。
3. **验证与架构边界**：`Dev Profile`（`quick-test`、`smoke-verify`、`merge-gate`、`arch-rules`）以及 CI 实际运行的检查命令。
4. **交棒判断**：只查问题直接回复；需要改代码或立项规划时，转交规划或流转技能接手。
