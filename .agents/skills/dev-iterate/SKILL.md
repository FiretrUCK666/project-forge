---
name: dev-iterate
description: |
  正向测试扩展、盲区识别、定向补测与并发压测迭代技能：交叉比对功能地图、历史信号与近期变更识别测试盲区，
  支持 `--focus` 按自然语言主题定向勘察并生成落盘目标仓原生测试目录的高质量测试，经分片并发执行抓出真实缺陷后
  通过 `escalation.mjs` 建单转入 `dev-plan -> dev-edit -> dev-review` 正流修复，与静态 `dev-govern` 严格解耦。
  触发词：补测试、扩展测试、加集成测试、加E2E测试、回归测试、压测、性能测试、测盲区、正向迭代、
  iterate tests、add integration tests、add e2e tests、regression tests、stress test。
metadata:
  intent: 补测试 / 扩展回归・集成・E2E・性能测试 / 盲区压测
  script: "`node .agents/skills/dev-iterate/scripts/iterate.mjs` (`plan` / `generate` / `run` / `cycle`)"
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
   - 依据 `kit/skills/lib/suite-inventory.mjs` 探测目标仓原生集成/回归/E2E/性能测试目录与栈命名惯例落盘，**严禁将生成的测试放入 `.agents/`**；
   - 新生成的重型回归/集成/性能测试**绝不污染目标仓极速 `quick-test` 单测白名单**；
   - **探索转非 `Case 1` 写改强制隔离**：从只读探索转入任何非 `Case 1` 文件写改（仅补测试按 Case 2/3 路由），必先走 `flow.mjs start` 隔离 worktree，改后经 `edit-gate` 与 `review-pack` 独立审查合入，严禁在主仓直接落盘；
   - 落盘前必须通过 `edit-gate` / 静态反作弊门禁（拦截零断言、纯 Mock 自证、单测 `>= 1s` 硬等待、压制注释、`> 800` 行膨胀及过程编号文件名）。
3. **增量回挂功能地图 `testRefs`**：
   - 新测试写入原生目录后，增量将新测试相对路径追加至 `docs/feature-map.json` 对应 feature 的 `testRefs`（完整保留所有既有字段不覆写；无功能地图时安全跳过）。
4. **分片并发执行与静默探索升级策略**：
   - `run` 按受限并发池（`--concurrency`）并行实跑原生测试套件，并可设 `--perf-budget-ms` 监控性能退化；
   - 捕获真实失败、竞态超时或性能越阈时，**探索期默认静默落盘本地诊断包与 `signals.jsonl`（不自动向远端刷出工单），传 `--escalate` 显式开启经 `kit/skills/lib/escalation.mjs` 自动建单转入 `dev-plan -> dev-edit -> dev-review` 正流修复，传 `--no-escalate` 强制关闭全部自动升级（含 `cycle` 停损）**：严禁在测点绕过或直接篡改业务源码；`run` 结束输出 `[NEXT STEP]`，`cycle` 状态持久化于 `<gitCommonDir>/project-forge-flow/iterate-cycle.json`。
5. **先最小运行复现，再评整类加固（四步准则）**：
   - 先写最小可执行 PoC 证明可达（复现不出判误报不修补）；修完用同一条 PoC 复跑固化正反回归；同类折射能靠共享边界原语或架构解耦一次性收口做 **Tier 1**，能靠类型/静态门禁下沉拦截做 **Tier 2**；验收只锁产物、接口与断言，不锁私有实现过程。
6. **有界优化循环 `cycle`（只读编排，不自旋）**：
   - 四阶段推进：`Observe`（找盲区与热点）-> `PoC/Escalate (autonomous)`（先复现再升级建单）-> `Fix/Verify`（走正流修并复跑）-> `Reflect`（评整类加固）；
   - 三条硬停损：`ROUND_LIMIT_REACHED`（达到轮次上限，默认 3、硬上限 10）、`NO_PROGRESS_STALL`（连续两轮零进展）、`ONE_WAY_GATE_HIT`（触及单向门或高风险边界需人工拍板）；
   - 触发即输出 `stopped: true` 与 `stopReason` 并退出码 `4`；**绝不自动改源码、不提交、不跳过 `dev-plan -> dev-edit -> dev-review` 正流**。

## 标准命令流

```sh
# 1. 自动扫描功能地图盲区、高频信号热点与近期变更，输出补测计划
node ".agents/skills/dev-iterate/scripts/iterate.mjs" plan [--dir <repo>] [--tier integration|e2e|perf|regression] [--json]

# 2. 按自然语言主题定向勘察并规划/生成原生测试（先预演，传 --write 落盘并增量更新 testRefs；--limit 控制候选上限）
node ".agents/skills/dev-iterate/scripts/iterate.mjs" generate --focus "<业务流或模块主题>" [--tier integration|e2e|perf|regression] [--limit 5] [--write] [--json]

# 3. 分片并发实跑新增与关联原生测试套件；探索期默认静默写本地诊断与信号（传 --escalate 显式经 escalation 建单，传 --no-escalate 强制关闭）
node ".agents/skills/dev-iterate/scripts/iterate.mjs" run [--targets <a,b>] [--concurrency 4] [--perf-budget-ms 15000] [--escalate | --no-escalate] [--json]

# 4. 有界只读优化循环：给出四阶段编排与三条硬停损判定（--max-rounds 默认 3，硬上限 10）
node ".agents/skills/dev-iterate/scripts/iterate.mjs" cycle --goal "<这一轮想把什么做得更好>" [--max-rounds 3] [--progress-history "<json>"] [--pending-gates "<json>"] [--json]
```
