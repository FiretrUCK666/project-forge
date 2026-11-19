---
name: dev-iterate
description: |
  正向测试扩展、盲区识别、定向补测与并发压测迭代技能：交叉比对功能地图、历史信号与近期变更识别测试盲区，
  支持 `--focus` 按自然语言主题定向勘察并生成落盘目标仓原生测试目录的高质量测试，经分片并发执行抓出真实缺陷后
  通过 `escalation.mjs` 建单转入 `dev-plan -> dev-edit -> dev-review` 正流修复，与静态 `dev-govern` 严格解耦。
  触发词：补测试、扩展测试、加集成测试、加E2E测试、回归测试、压测、性能测试、测盲区、正向迭代、
  iterate tests、add integration tests、add e2e tests、regression tests、stress test。
metadata:
  intent: 正向扩展回归/集成/E2E/性能测试与盲区压测
  script: "`node .agents/skills/dev-iterate/scripts/iterate.mjs`"
  order: 55
  fallback: 按项目原生测试目录补充集成/回归用例，确认不污染快速单测且发现缺陷时另起任务单修复（未装配 dev-iterate 技能）
---

# dev-iterate：正向测试扩展与并发回归迭代

专司**主动动态测试建设与持续质量压力验证**，与 `dev-govern` 严格划清职责边界：

- `dev-govern` 只做**静态审计、结构体检与历史信号复盘**，不生成测试文件、不启动并发测试池；
- `dev-iterate` 只做**盲区识别、原生测试生成、分片并发实跑与缺陷升级建单**，发现真实故障时**绝不直接修改业务源码**。

## 核心规则

1. **零参数智能默认主路径 + 双入口定靶（不反问卡住）**：
   - **默认主路径（无 `--focus` 时直接推进，不反问）**：当用户只唤起 `dev-iterate` 而未指定具体 `--focus` 时，不要反问卡住，默认自动结合 `dev-explore`、`docs/feature-map.json`（缺失时优雅降级）、`signals.jsonl`（高频复发热点模块）及近期 Git 变更排出最高价值盲区，按目标仓原生测试栈生成真实业务流/边界/性能测试集（必过 `edit-gate` 反作弊校验）并并发实跑；失败自动经 `escalation` 转正流闭环，通过则沉淀挂回 `testRefs`；
   - **定向模式（`--focus "<自然语言主题/业务流>"`）**：先结合 `doc-locator.mjs` 与源码符号索引只读勘察关联模块与文档切片，再定向生成该业务流的回归/集成/E2E/性能测试方案。
2. **严守原生测试目录与极速 `quick-test` 边界**：
   - 依据 `kit/skills/lib/test-inventory.mjs` 探测目标仓原生集成/回归/E2E/性能测试目录与栈命名惯例落盘，**严禁将生成的测试放入 `.agents/`**；
   - 新生成的重型回归/集成/性能测试**绝不污染目标仓极速 `quick-test` 单测白名单**；
   - 落盘前必须通过 `edit-gate` / 静态反作弊门禁（拦截零断言、纯 Mock 自证、单测 `>= 1s` 硬等待、压制注释、`> 800` 行膨胀及过程编号文件名）。
3. **增量回挂功能地图 `testRefs`**：
   - 新测试写入原生目录后，增量将新测试相对路径追加至 `docs/feature-map.json` 对应 feature 的 `testRefs`（完整保留所有既有字段不覆写；无功能地图时安全跳过）。
4. **分片并发执行与缺陷升级闭环**：
   - `run` 按受限并发池（`--concurrency`）并行实跑原生测试套件，并可设 `--perf-budget-ms` 监控性能退化；
   - 捕获真实失败、竞态超时或性能越阈时，**严禁在测点绕过或直接篡改业务源码**，而是经 `kit/skills/lib/escalation.mjs` 建单（`dev-plan -> dev-edit -> dev-review` 正流修复）并写入结构化信号（`defectClass`、`fingerprint`、`pyramidTier`）至 `signals.jsonl`。

## 标准命令流

```sh
# 1. 自动扫描功能地图盲区、高频信号热点与近期变更，输出补测计划
node ".agents/skills/dev-iterate/scripts/iterate.mjs" plan [--dir <repo>] [--tier integration|e2e|perf|regression] [--json]

# 2. 按自然语言主题定向勘察并规划/生成原生测试（先预演，传 --write 落盘并增量更新 testRefs）
node ".agents/skills/dev-iterate/scripts/iterate.mjs" generate --focus "<业务流或模块主题>" [--tier integration|e2e|perf|regression] [--write] [--json]

# 3. 分片并发实跑新增与关联原生测试套件；遇真实失败或性能越阈自动写信号并经 escalation 建单
node ".agents/skills/dev-iterate/scripts/iterate.mjs" run [--targets <a,b>] [--concurrency 4] [--perf-budget-ms 15000] [--escalate] [--json]
```
