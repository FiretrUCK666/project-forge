---
kind: todo
title: 死代码清零与热点拆分实施清单：二十个导出、一个死参数、策略模块三分、帮助分组
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 119
pr: null
branch: fix/w25-deadcode-split
owner: plan-wave25
approved: false
done_at: null
task_id: w25-deadcode-split
planned_at: null
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue119-w25-deadcode-split-spec.md
plan_mode: interactive
depends_on: [w25-parallel-dispatch]
scope_files: ["scripts/lib/fs-atomic.mjs", "scripts/lib/protocol.mjs", "scripts/lib/text.mjs", "scripts/lib/survey-ecosystem.mjs", "scripts/lib/survey-workspace.mjs", "kit/skills/lib/symbol-index.mjs", "kit/skills/lib/test-inventory.mjs", "kit/skills/lib/doc-toc.mjs", "kit/skills/lib/doc-facts.mjs", "kit/skills/lib/doc-template-render.mjs", "kit/skills/lib/platform-probe.mjs", "kit/skills/lib/workflow-policy.mjs", "kit/skills/lib/workflow-evidence.mjs", "kit/skills/lib/low-risk-doc-check.mjs", "kit/skills/lib/workflow-policy-next.mjs", "kit/skills/dev-flow/scripts/flow.mjs", "kit/skills/dev-explore/scripts/doc-locate.mjs", "scripts/dev/preflight-suite.mjs", "scripts/dev/fixtures-deadcode-split.mjs"]
---

# `w25-deadcode-split` 实施 Todo（Issue `#119`）

> 对应 SPEC：[deadcode-split SPEC](../specs/261120-issue119-w25-deadcode-split-spec.md)
>
> **基线**：`a0fe4df`。前置：`w25-parallel-dispatch`（先定行为，再拆文件）。

## 一、要做什么

<!-- section: goal -->
把没人用的东西清掉，把扛了四件事的文件按职责分开：

- **二十个零消费者导出**：十五个删除、四个去 `export` 保留实现、一个连误导性注释一并删。
- **一个死参数**：注册表、帮助、读取点三处清零；有间接读取点的开关不动。
- **策略模块三分**：策略判定留原模块，低风险检查、证据读写、状态推导各成一模块；完整重导出层，导入方零改动，返回字段一个不变。
- **帮助按子命令分组**：参数集合由注册表对拍守住。
- **定位器清单开关**：只列不查。

## 二、不做什么

<!-- section: non-goals -->
不拆探测模块线性降级链；不拆装备脚本线性事务；不改原子写临时清理返回形状；不改三处文件头长注释；不改工作区遍历并发数；不动「跳过规划引导」开关；不改重导出层导出面；不改生态声明式表；不碰 `docs/archive/`。

不以任何形式打补丁：不把死导出标成废弃留着、不按行数均分文件、不在拆分时不保留重导出层、不让帮助文本自动生成占位说明。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（前置核对）**：确认 `w25-parallel-dispatch` 已合入或已在同波次落地；未落地则等待，不先把状态推导拆走。
- [ ] **T2（`C1` 删除前复核）**：对二十个符号逐个再跑一次全仓命中，确认零消费者；对四个「同文件内被调用」的确认删除 `export` 后文件仍可用；记录每个符号的最终处理方式。
- [ ] **T3（`C1` 执行删除）**：十五个删除（含 `repoRelation` 及其误导性注释）；四个去掉 `export`；两个被同名真实实现取代的包装函数删除且不留别名。
- [ ] **T4（`C2` 死参数）**：`--slot` 从注册表、帮助、读取点三处清零；`preflight-suite.mjs` 的「每个注册参数至少一个读取点」检查覆盖流程入口；确认「跳过规划引导」仍在且有间接读取点。
- [ ] **T5（`C3` 拆分准备）**：先落一份「拆分前后输出比对」的快照脚本——对同一批状态推导输入记录当前输出，作为后续比对的基准。基准必须先于拆分落地，否则无从证明纯位移。
- [ ] **T6（`C3` 三分）**：新增 `low-risk-doc-check.mjs` (new) 承接低风险文档静态检查；新增 `workflow-evidence.mjs` (new) 承接证据路径、读写与前置校验；新增 `workflow-policy-next.mjs` (new) 承接状态推导并按「前置条件 / 阶段选择 / 动作生成」三段拆；`workflow-policy.mjs` 保留策略判定与完整重导出层。
- [ ] **T7（`C3` 比对验证）**：拆分后对同一批输入跑快照脚本，输出与基准逐字节一致；逐项核对返回字段名未变；核对四十六处 import 一处未改。
- [ ] **T8（`C4` 帮助分组）**：`flow.mjs` 帮助按子命令分组，参数集合来自注册表；全局参数单列；`preflight-suite.mjs` 增加「帮助分组参数集合 = 注册表」的对拍。
- [ ] **T9（`C5` 定位器）**：`doc-locate.mjs` 新增清单开关，列出既有索引范围，不触发检索。
- [ ] **T10（夹具）**：新增 `scripts/dev/fixtures-deadcode-split.mjs` (new)，承接 `C1..C6` 正反断言，含「拆分前后逐字节一致」的比对入口。
- [ ] **T11（行数核对）**：三个新模块各不超三百行；`workflow-policy.mjs` 拆分后显著变薄；`platform-probe.mjs` 行数不变。逐文件核对 `.mjs <= 800`。
- [ ] **T12（同步）**：`kit/` 改动后跑 `node scripts/equip.mjs .`；导出集合变化同提交同步 `docs/TDD.md` 的模块导出列与 `kit/skills/lib/shared.mjs` 的重导出清单（后者只在其导出面变化时同步）。

## 四、验收与合前检查

- [ ] 二十个符号全仓命中数为零（含注释），四个函数仍存在但无 `export`。
- [ ] `--slot` 三处零命中；机械检查对新增未读取参数会红。
- [ ] 三个新模块各不超三百行；同一批输入拆分前后输出逐字节一致；四十六处 import 零改动。
- [ ] 帮助分组参数集合与注册表逐个相等。
- [ ] `doc-locate.mjs` 清单开关可用且只列不查。
- [ ] `node scripts/dev/fixtures.mjs` 全量通过。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
