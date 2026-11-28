---
name: dev-verify-tools
description: |
  验证工具生命周期管理与唯一机读功能地图（docs/feature-map.json）：仓外 scratch 试制沉淀验证脚本、
  按变更文件自动反查复用工具并执行免手工日期的符号与树哈希过时校验（低告警/中降级/高阻断），
  以及体检清理僵尸引用、高风险盲区与跨 PR 临时脚本固化提示。
  触发词：验证工具、功能地图、feature-map、缺校验工具、建一个验证流、跑验证工具、
  工具过时、清理僵尸工具、体检验证工具库、verify-tools。
metadata:
  intent: 加验证脚本 / 跑端到端验证 / 维护功能地图 / 过时校验与清理
  script: "`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs` (`audit` / `run` / `create`)"
  order: 48
  fallback: 在仓外临时目录编写一次性探针脚本实测受波及业务流，验证完毕后清理临时产物（未装配 dev-verify-tools 技能）
---

# dev-verify-tools：验证工具生命周期与唯一功能地图引擎

本技能专注管理仓库的**验证工具资产**与机读单一真相源 `docs/feature-map.json`（不向 `docs/TDD.md` 复制工具清单，不代替原生测试目录自动化测试生成）。

## 单一真相源与仓外沙箱边界

1. **受跟踪唯一地图 `docs/feature-map.json`（兼容 v1 / v2 分层拓扑）**：
   - 结构：`{ version: 1|2, domains?: [{ id, name, description?, entrypoints?, docAnchors? }], features: [{ id, name, domain?, dependsOn?, actors?, docAnchors?, entrypoints, modules, businessFlows, verificationTools: [{ id, kind, command, scriptPath, riskLevel, triggerHints }], testRefs }], flows?: [{ id, name, actors, features, steps?, branches?, docAnchors? }] }`。
   - **严禁写入易变局部哈希或手工时间戳**：受跟踪 JSON 只存稳定功能与拓扑映射；由 `repo-map.mjs --write-feature-map` 或 `verify-tools.mjs sync` 增量预填（保留既有手写条目不被覆盖），并自动通过 `verify-tools.mjs render` 确定性派生离线交互式架构全景图 `docs/architecture-map.html`（首行嵌入规范化 `feature-map-sha256` 指纹；`AGENTS.md` 写 `no-architecture-html` 时跳过）。
2. **仓外安全命名空间 `{gitCommonDir}/project-forge-verify/`**：
   - `cache.json`：按 `{ slots[slotKey][toolId] }` 分槽隔离保存最近实证通过时的 `{ symbolHash, moduleTreeHash, verifiedSha, passedAtCommit }`，随 `flow cleanup` 自动回收旧槽。
   - `scratch/{taskId}/`：强制托管全部一次性探针与原型脚本，严禁写入仓库树或 `.worktrees/impl-*`；`flow cleanup`/`abort` 校验路径前缀后彻底销毁，并在非空销毁前向 `signals.jsonl` 写入 `verify.scratch-used`。

## 免手工日期过时校验与三级风险处置

过时判定基于 `symbol-index.mjs` 导出符号摘要与 Git 模块树哈希对比仓外 `cache.json`（不依赖人工填写日期或本地时钟年龄；PR 分支审查时对照基准分支树与当前导出符号，避免误判当前 PR 自身实现体改动）：

| 风险级别 | 过时判定动作 | 返回码与处置 |
| --- | --- | --- |
| `low` | `STALE_WARN` 告警运行 | 输出变更模块与增删导出符号，允许带警告执行（**不自动刷新基线**，须显式 `--refresh-baseline`） |
| `medium` | `STALE_MEDIUM_FALLBACK` | 退出码 `3` 阻断无提醒直接复用，写治理债信号；可加 `--allow-medium-fallback --live-e2e-cmd "<cmd>"` 或转跑 `testRefs` / 仓外 `scratch/{taskId}/` |
| `high` | `BLOCKED_STALE_HIGH_RISK_TOOL` | 硬阻断（退出码 `3`），必须先升级工具重采基线（`--refresh-baseline`）或以等效实时 E2E（`--live-e2e-cmd`）替代 |

## 三大核心场景与与 `dev-review` 交接

1. **创造（`create`）**：针对缺工具的功能先在仓外 `scratch/{taskId}/` 试制（`--draft-only`）；待脚本成熟且经 `edit-gate` 词法卫生与真实运行通过后，带 `--promote` 沉淀至仓库持久化路径并原子登记到 `docs/feature-map.json` 与 `cache.json`。
2. **自动复用（`run`）**：开发或 `dev-review` 按变更文件（`--changed` / `--files`）或 `--feature` / `--tool` 反查匹配工具，自动执行免日期过时判定与风险分派，透传任务上下文运行并回写结构化实证结果与最新基线。
3. **体检清理（`audit` / `clean`）**：核验地图 Schema（拦截非法局部哈希/日期字段）、扫描僵尸脚本与缺失模块、识别 `repo-map` 核心高风险盲区、检测同一 `featureId` 跨 `>= 2` 个不同 `taskId` 依赖 `scratch/` 时的固化升级提示（引导另开独立 PR 沉淀，勿污染当前业务 PR），并清理僵尸引用与已关闭任务的 `scratch/` 残留。

## 标准命令流

```sh
# 1. 增量预填 / 刷新功能地图（不覆盖手写条目）
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" sync --json

# 2. 场景 1（创造）：先在仓外 scratch 试制，成熟后过 edit-gate 与实跑再沉淀入库
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" create --feature <id> --task <taskId> --draft-only --json
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" create --feature <id> --tool-id <tid> [--from-scratch <path> | --script <relPath>] [--command "<cmd>"] --risk medium --task <taskId> --promote --json

# 3. 场景 2（自动复用）：反查变更文件匹配工具、执行免日期过时分派（`--stale` 去重重跑过期/无基线工具并刷新基线；空 feature-map 返回 NOT_APPLICABLE 退出 0）
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" run [--changed | --stale] [--base main] [--task <taskId>] [--refresh-baseline] [--allow-medium-fallback --live-e2e-cmd "<cmd>"] [--live-e2e-cmd "<cmd>"] --json

# 4. 场景 3（体检清理与全景架构图渲染）：检查拓扑/僵尸引用/漂移/盲区，确认后清理，或渲染/核验 docs/architecture-map.html
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" audit [--base main] --json
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" clean [--confirm] [--prune-zombies] [--prune-scratch] --json
node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" render [--check] [--out "<relPath>"] --json
```
