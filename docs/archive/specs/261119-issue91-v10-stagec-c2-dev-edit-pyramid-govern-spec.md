---
kind: spec
title: v10 第六技能 dev-edit、严格三层倒金字塔与 dev-govern 自动触发（Stage C-2）
status: implemented
tier: L3
created: 2026-11-19
updated: 2026-11-19
issue: 91
pr: null
branch: feat/v10-stagec-c2
owner: impl-c2
approved: true
implemented: true
plan_critique: "passed (reviewer=critic-stage-c-r2, round=2, sha=a504eb5e67bc, summary=Round 2 独立全量重审 PASS（HEAD ce3f3e5）：#256 阻塞项全部修净，写域互斥与源码事实对齐通过。)"
related_prd: ../../prd/261119-v10-stagec-unified-architecture-prd.md
related_todo: ../todo/261119-issue91-v10-stagec-c2-dev-edit-pyramid-govern-todo.md
high_risk_paths: [kit/skills/lib/static-gates.mjs, kit/skills/lib/signals.mjs, kit/skills/dev-govern/scripts/govern-retro.mjs, kit/skills/dev-govern/scripts/govern-audit.mjs]
critique_anchors: "{\"sections\":{\"goal\":{\"present\":true,\"substantive\":true,\"anchors\":[\"!出单元测试分层\",\"AGENTS\",\"AGENTS.md\",\"C1\",\"C2\",\"CLI\",\"HACK\",\"NON_UNIT_TEST_RE\",\"SKILL\",\"SKILL.md\",\"`(?:e2e|integration|browser|perf|benchmark|benchmarks|load|stress)`\",\"`.agents/skills/`\",\"`@ts-ignore`\",\"`AGENTS.md`\",\"`C1`\",\"`C2`\",\"`Case 1`\",\"`Case 2`\",\"`HACK`\",\"`NON_UNIT_TEST_RE`\",\"`SKILL.md`\",\"`cleanup`\",\"`comment?.ok`\",\"`dev-edit/`\",\"`dev-edit`\",\"`dev-flow/`\",\"`dev-govern`\",\"`dev-iterate`\",\"`dev-review`\",\"`edit-gate`\",\"`flow-lifecycle-hooks.mjs`\",\"`govern-retro.mjs`\",\"`govern-tests.mjs`\",\"`labelRes`\",\"`merge`\",\"`node scripts/equip.mjs . && node scripts/compose-agents.mjs .`\",\"`review-ledger.mjs`\",\"`rework`\",\"`static-gates`\",\"`synced`\",\"`templates/`\",\"`templates/agents-project.md`\",\"`tests.unfiltered-quick-test`\",\"`writeTaskLedger`\",\"`意图路由`\",\"flow-lifecycle-hooks.mjs\",\"govern-retro.mjs\",\"govern-tests.mjs\",\"labelRes\",\"review-ledger.mjs\",\"scripts/compose-agents.mjs\",\"scripts/equip.mjs\",\"templates/agents-project.md\",\"writeTaskLedger\"]},\"design\":{\"present\":true,\"substantive\":true,\"anchors\":[\"!或误判的规则（注：`sit` 属于文档脚手架规则、`qa` 在 `govern-tests.mj\",\"!测试夹具白名单）\",\"--changed\",\"--json\",\"--quiet\",\"--reason\",\"--task\",\".agents/skills/dev-edit/scripts/edit-gate.mjs\",\"<=130\",\"<=550L\",\">800\",\">=1000ms\",\">=2\",\">=5\",\"AGENTS\",\"AGENTS.md\",\"C1\",\"CLI\",\"FALLBACK\",\"HACK\",\"NON_UNIT_TEST_RE\",\"SKILL\",\"TEMP\",\"TIER\",\"WORKAROUND\",\"`# noqa`\",\"`# type: ignore`\",\"`#[allow(`\",\"`(?:e2e|integration|browser|perf|benchmark|benchmarks|load|stress)`\",\"`--allow-tier3-fallback --reason \\\"{why}\\\"`\",\"`--auto --task {taskId} --json`\",\"`--changed`\",\"`--files`\",\"`--lib`\",\"`--mode verify --changed --json`\",\"`--skip-edit-gate`\",\"`--skip-govern`\",\"`--test`\",\"`.worktrees`\",\"`730–800`\",\"`<= 130`\",\"`<= 550L`\",\"`> 800`\",\"`>= 1000ms`\",\"`>= 2`\",\"`>= 5`\",\"`@ts-ignore`\",\"`@ts-nocheck`\",\"`AGENTS.md`\",\"`Case 1–4`\",\"`HACK`\",\"`NON_UNIT_TEST_RE`\",\"`TEMP`\",\"`WORKAROUND`\",\"`[TIER-3-FALLBACK]`\",\"`arch-boundary`\",\"`arch-rules`\",\"`audit . --changed --quiet --json`\",\"`comment?.ok`\",\"`defectClass`\",\"`dev-flow`\",\"`dev-iterate`\",\"`dev-plan`\",\"`do-not-edit`\",\"`edit-gate.mjs`\",\"`edit-gate`\",\"`eslint-disable`\",\"`fingerprint`\",\"`flow-lifecycle-hooks.mjs`\",\"`flow.mjs cleanup`\",\"`flow.mjs finalize`\",\"`flow.mjs merge`\",\"`flow.mjs verify`\",\"`govern-audit`\",\"`govern-retro`\",\"`govern-tests.mjs`\",\"`import`\",\"`kit/skills/dev-edit/SKILL.md`\",\"`kit/skills/dev-edit/`\",\"`kit/skills/dev-edit/scripts/`\",\"`kit/skills/dev-edit/scripts/edit-gate.mjs`\",\"`kit/skills/dev-govern/SKILL.md`\",\"`kit/skills/dev-govern/scripts/govern-audit.mjs`\",\"`kit/skills/dev-govern/scripts/govern-retro.mjs`\",\"`kit/skills/dev-govern/scripts/govern-state.mjs`\",\"`kit/skills/dev-govern/scripts/govern-tests.mjs`\",\"`kit/skills/dev-review/scripts/review-ledger.mjs`\",\"`kit/skills/lib/escalation.mjs`\",\"`kit/skills/lib/profile-sniffer.mjs`\",\"`kit/skills/lib/signals.mjs`\",\"`kit/skills/lib/static-gates.mjs`\",\"`labelRes`\",\"`missing-runtime-proof`\",\"`mock-only-test`\",\"`node .agents/skills/dev-edit/scripts/edit-gate.mjs [--mode verify|pre-edit|standalone] [--files a,b] [--changed] [--with-native] [--json]`\",\"`order: 20`\",\"`order: 33`\",\"`order: 40`\",\"`package.json`\",\"`profile-sniffer.mjs`\",\"`pyramidTier`\",\"`qa`\",\"`quick-test`\",\"`race-condition`\",\"`record`\",\"`require`\",\"`retro`\",\"`review-ledger.mjs`\",\"`rework`\",\"`setTimeout`\",\"`sha256(ruleId + defectClass + moduleRoot)`\",\"`signals.jsonl`\",\"`sit`\",\"`sleep`\",\"`stale-contract`\",\"`state-split`\",\"`static-gates-lexer.mjs`\",\"`suppression-bypass`\",\"`targetArtifact`\",\"`test:e2e`\",\"`test:integration`\",\"`test:unit`\",\"`tests.unfiltered-quick-test`\",\"`tier1-architecture`\",\"`tier2-deterministic-gate`\",\"`tier3-prompt-fallback`\",\"`updateTaskLedger`\",\"`use`\",\"`verify`\",\"`writeTaskLedger`\",\"defectClass\",\"edit-gate.mjs\",\"flow-lifecycle-hooks.mjs\",\"flow.mjs\",\"govern-tests.mjs\",\"kit/skills/dev-edit/SKILL.md\",\"kit/skills/dev-edit/scripts/edit-gate.mjs\",\"kit/skills/dev-govern/SKILL.md\",\"kit/skills/dev-govern/scripts/govern-audit.mjs\",\"kit/skills/dev-govern/scripts/govern-retro.mjs\",\"kit/skills/dev-govern/scripts/govern-state.mjs\",\"kit/skills/dev-govern/scripts/govern-tests.mjs\",\"kit/skills/dev-review/scripts/review-ledger.mjs\",\"kit/skills/lib/escalation.mjs\",\"kit/skills/lib/profile-sniffer.mjs\",\"kit/skills/lib/signals.mjs\",\"kit/skills/lib/static-gates.mjs\",\"labelRes\",\"moduleRoot\",\"package.json\",\"profile-sniffer.mjs\",\"pyramidTier\",\"review-ledger.mjs\",\"ruleId\",\"setTimeout\",\"static-gates-lexer.mjs\",\"targetArtifact\",\"taskId\",\"updateTaskLedger\",\"writeTaskLedger\"]},\"alternatives\":{\"present\":true,\"substantive\":true,\"anchors\":[\"AGENTS\",\"AGENTS.md\",\"HACK\",\"NON_UNIT_TEST_RE\",\"`--allow-tier3-fallback`\",\"`@ts-ignore`\",\"`AGENTS.md`\",\"`HACK`\",\"`NON_UNIT_TEST_RE`\",\"`edit-gate.mjs`\",\"`govern-retro`\",\"`static-gates-lexer.mjs`\",\"edit-gate.mjs\",\"static-gates-lexer.mjs\"]}},\"anchors\":[\"!出单元测试分层\",\"!出单元测试的规则\",\"!或误判的规则（注：`sit` 属于文档脚手架规则、`qa` 在 `govern-tests.mj\",\"!测试夹具白名单）\",\"--changed\",\"--json\",\"--quiet\",\"--reason\",\"--task\",\".agents/skills/dev-edit/scripts/edit-gate.mjs\",\"<=130\",\"<=550L\",\">800\",\">=1000ms\",\">=2\",\">=5\",\"AGENTS\",\"AGENTS.md\",\"C1\",\"C2\",\"C5\",\"C6\",\"C7\",\"C8\",\"CLI\",\"FALLBACK\",\"HACK\",\"NON_UNIT_TEST_RE\",\"SC5\",\"SC6\",\"SC7\",\"SC8\",\"SKILL\",\"SKILL.md\",\"TEMP\",\"TIER\",\"WORKAROUND\",\"`# noqa`\",\"`# type: ignore`\",\"`#[allow(`\",\"`(?:e2e|integration|browser|perf|benchmark|benchmarks|load|stress)`\",\"`--allow-tier3-fallback --reason \\\"{why}\\\"`\",\"`--allow-tier3-fallback`\",\"`--auto --task {taskId} --json`\",\"`--changed`\",\"`--files`\",\"`--lib`\",\"`--mode verify --changed --json`\",\"`--skip-edit-gate`\",\"`--skip-govern`\",\"`--test`\",\"`.agents/skills/`\",\"`.worktrees`\",\"`730–800`\",\"`<= 130`\",\"`<= 550L`\",\"`> 800`\",\"`>= 1000ms`\",\"`>= 2`\",\"`>= 5`\",\"`@ts-ignore`\",\"`@ts-nocheck`\",\"`AGENTS.md`\",\"`C1`\",\"`C2`\",\"`Case 1`\",\"`Case 1–4`\",\"`Case 2`\",\"`HACK`\",\"`NON_UNIT_TEST_RE`\",\"`SKILL.md`\",\"`TEMP`\",\"`WORKAROUND`\",\"`[TIER-3-FALLBACK]`\",\"`arch-boundary`\",\"`arch-rules`\",\"`audit . --changed --quiet --json`\",\"`cleanup`\",\"`comment?.ok`\",\"`defectClass`\",\"`dev-edit/`\",\"`dev-edit`\",\"`dev-flow/`\",\"`dev-flow`\",\"`dev-govern`\",\"`dev-iterate`\",\"`dev-plan`\",\"`dev-review`\",\"`do-not-edit`\",\"`edit-gate.mjs`\",\"`edit-gate`\",\"`escalation.mjs`\",\"`eslint-disable`\",\"`fingerprint`\",\"`flow finalize`\",\"`flow merge`\",\"`flow-lifecycle-hooks.mjs`\",\"`flow.mjs cleanup`\",\"`flow.mjs finalize`\",\"`flow.mjs merge`\",\"`flow.mjs verify`\",\"`govern-audit --changed`\",\"`govern-audit`\",\"`govern-retro.mjs`\",\"`govern-retro`\",\"`govern-tests.mjs`\",\"`import`\",\"`kit/skills/dev-edit/SKILL.md`\",\"`kit/skills/dev-edit/`\",\"`kit/skills/dev-edit/scripts/`\",\"`kit/skills/dev-edit/scripts/edit-gate.mjs`\",\"`kit/skills/dev-govern/SKILL.md`\",\"`kit/skills/dev-govern/scripts/govern-audit.mjs`\",\"`kit/skills/dev-govern/scripts/govern-retro.mjs`\",\"`kit/skills/dev-govern/scripts/govern-state.mjs`\",\"`kit/skills/dev-govern/scripts/govern-tests.mjs`\",\"`kit/skills/dev-review/scripts/review-ledger.mjs`\",\"`kit/skills/lib/escalation.mjs`\",\"`kit/skills/lib/profile-sniffer.mjs`\",\"`kit/skills/lib/signals.mjs`\",\"`kit/skills/lib/static-gates.mjs`\",\"`labelRes`\",\"`merge`\",\"`missing-runtime-proof`\",\"`mock-only-test`\",\"`node .agents/skills/dev-edit/scripts/edit-gate.mjs [--mode verify|pre-edit|standalone] [--files a,b] [--changed] [--with-native] [--json]`\",\"`node scripts/equip.mjs . && node scripts/compose-agents.mjs .`\",\"`order: 20`\",\"`order: 33`\",\"`order: 40`\",\"`package.json`\",\"`profile-sniffer.mjs`\",\"`pyramidTier`\",\"`qa`\",\"`quick-test`\",\"`race-condition`\",\"`record`\",\"`require`\",\"`retro`\",\"`review-ledger.mjs`\",\"`rework`\",\"`setTimeout`\",\"`sha256(ruleId + defectClass + moduleRoot)`\",\"`signals.jsonl`\",\"`sit`\",\"`sleep`\",\"`stale-contract`\",\"`state-split`\",\"`static-gates-lexer.mjs`\",\"`static-gates`\",\"`suppression-bypass`\",\"`synced`\",\"`targetArtifact`\",\"`templates/`\",\"`templates/agents-project.md`\",\"`test:e2e`\",\"`test:integration`\",\"`test:unit`\",\"`tests.unfiltered-quick-test`\",\"`tier1-architecture`\",\"`tier2-deterministic-gate`\",\"`tier3-prompt-fallback`\",\"`updateTaskLedger`\",\"`use`\",\"`verify`\",\"`writeTaskLedger`\",\"`意图路由`\",\"defectClass\",\"edit-gate.mjs\",\"escalation.mjs\",\"flow-lifecycle-hooks.mjs\",\"flow.mjs\",\"govern-retro.mjs\",\"govern-tests.mjs\",\"kit/skills/dev-edit/SKILL.md\",\"kit/skills/dev-edit/scripts/edit-gate.mjs\",\"kit/skills/dev-govern/SKILL.md\",\"kit/skills/dev-govern/scripts/govern-audit.mjs\",\"kit/skills/dev-govern/scripts/govern-retro.mjs\",\"kit/skills/dev-govern/scripts/govern-state.mjs\",\"kit/skills/dev-govern/scripts/govern-tests.mjs\",\"kit/skills/dev-review/scripts/review-ledger.mjs\",\"kit/skills/lib/escalation.mjs\",\"kit/skills/lib/profile-sniffer.mjs\",\"kit/skills/lib/signals.mjs\",\"kit/skills/lib/static-gates.mjs\",\"labelRes\",\"moduleRoot\",\"package.json\",\"profile-sniffer.mjs\",\"pyramidTier\",\"review-ledger.mjs\",\"ruleId\",\"scripts/compose-agents.mjs\",\"scripts/equip.mjs\",\"setTimeout\",\"static-gates-lexer.mjs\",\"targetArtifact\",\"taskId\",\"templates/agents-project.md\",\"updateTaskLedger\",\"writeTaskLedger\"],\"coreSections\":[\"alternatives\",\"design\",\"goal\"],\"pendingResolved\":0,\"pendingUnresolved\":0,\"criteriaCount\":4}"
---

# 变更设计说明书：v10 第六技能 dev-edit、严格三层倒金字塔与 dev-govern 自动触发（Stage C-2）

## 文档信息与变更概览

- **所属总控 PRD**：[Stage C 总控 PRD](../../prd/261119-v10-stagec-unified-architecture-prd.md)（承接验收标准 `C5–C8`，对应 `SC5–SC8`）
- **所属波次与并行约束**：Wave C-1 右翼，与 [Stage C-1 设计规范](../archive/specs/261119-issue90-v10-stagec-c1-unified-locate-intake-perf-spec.md) 并行开发、写域严格零交叠；依赖 Stage B 合入 `main`
- **关联待办**：[Stage C-2 Todo](../todo/261119-issue91-v10-stagec-c2-dev-edit-pyramid-govern-todo.md)
- Issue: #91

## 系统变更全景

```mermaid
flowchart LR
  ED["dev-edit 门禁\n全改码前置阻断"] --> LX["lex词法去噪\n去注释防误报"]
  RV["review-ledger\n写入分类指纹"] --> SG["signals.jsonl\n指纹跨任务聚合"]
  SG --> RT["govern-retro\n复发触发升格"]
  RT -->|"Tier1优先"| ES["escalation\n架构重构"]
  RT -->|"Tier2次优先"| SN["arch-rules\n原生lint与CI"]
  FL["flow 生命周期"] --> GA["govern-audit\n无感自动触发"]
```

| 主题域 | 改动目标 | 关键载体 |
| --- | --- | --- |
| 第 6 技能 `dev-edit` | 覆全量改码入口并前置入 `verify`；阻断压制/墓碑/反作弊/`>800L` | `kit/skills/dev-edit/` (new)、`kit/skills/dev-edit/scripts/` (new)、`kit/skills/dev-edit/scripts/edit-gate.mjs` (new) |
| 三层纠偏倒金字塔 | 扩展信号指纹、废除默认写 `AGENTS.md`、复发 `>=2` 升 Tier 1/2 | `kit/skills/lib/signals.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-govern/scripts/govern-retro.mjs` |
| `dev-govern` 自动触发 | `finalize`/`verify`/`merge`/`cleanup` 轻量无感审计与复盘 | `kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/dev-govern/scripts/govern-state.mjs` |
| 清除测试分层假阳性 | 删去 `govern-tests.mjs:38` 固定路径正则误判；适配原生测试分层与小仓 | `kit/skills/dev-govern/scripts/govern-tests.mjs`、`kit/skills/lib/profile-sniffer.mjs` |

## 一、背景与边界声明

1. **当前架构痛点**：
   - 现有 `static-gates` 仅部分挂在事后检查，缺少独立的改码阶段规范技能 `dev-edit/` (new)，导致 `Case 1`、`Case 2`、`rework` 及应急直接改码场景易混入 `HACK`/`@ts-ignore`/死代码/单测凑数/超长文件，到 PR 审查阶段才被迫打回返工。
   - `govern-retro.mjs` 长期把复发教训自动建议写回 `AGENTS.md`（Tier 3 提示词层），违背「信任倒金字塔」，造成契约膨胀却无法在确定性编译或静态层面消灭同类 bug；同时 `review-ledger.mjs` 第 194–199 行仅凭 `comment?.ok` 判断 `synced` 而忽略 `labelRes` 失败，且第 546、688 行仍直接调用 `writeTaskLedger`。
   - `dev-govern` 仍靠用户记命令手跑，`merge`/`cleanup` 结束不复盘；`govern-tests.mjs` 第 38 行 `NON_UNIT_TEST_RE` 将 `(?:e2e|integration|browser|perf|benchmark|benchmarks|load|stress)` 路径段整体排除出单元测试分层，并在小型精简仓库反复误报 `tests.unfiltered-quick-test`。
2. **明确边界**：
   - `dev-edit` 只做改码期边界、工程质量、词法静态门禁与复用前导，不取代 `dev-review` 双门实证或 `dev-iterate` 测试生成；**`edit-gate` 与 Tier 2 检查绝不硬绑定任何第三方外部 linter 二进制**，仅针对目标仓已有配置文件按需调用可选原生命令。
   - `dev-govern` **严守静态审计与历史信号复盘边界**：绝不主动编写业务/并发测试或启动目标服务（该动态职责专归 Stage C-4 `dev-iterate`）。
   - 本切片不触碰 `dev-flow/`、`templates/`、`SKILL.md` 等属于 `C1` 的文件；自动触发由 `C1` 预置在 `flow-lifecycle-hooks.mjs` (new) 的 CLI 契约驱动，但 `C2` 新增第 6 技能后**必须在本 PR 内运行 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 同步派生 `.agents/skills/` 与 `AGENTS.md` `意图路由`**（绝不手改 `templates/agents-project.md`）。

## 二、设计方案与契约变更

### 1. 第 6 技能 `dev-edit/` 与 `edit-gate.mjs` 全入口门禁（对应 C5 / SC5）
- **技能定义与装配目录**：
  - 创建目录 `kit/skills/dev-edit/` (new) 与 `kit/skills/dev-edit/scripts/` (new)。
  - 新增 `kit/skills/dev-edit/SKILL.md` (new)（`order: 33`，介于 `dev-plan` `order: 20` 与 `dev-flow` `order: 40` 之间；精简正文 `<= 130` 行），规范所有改码动作前的三件事：确认目标文件未落入 `do-not-edit`、先查相邻复用消除复制粘贴、改后立即执行 `edit-gate.mjs` (new)。
- **`kit/skills/dev-edit/scripts/edit-gate.mjs` (new) 核心引擎（`<= 550L`）**：
  - CLI 契约：`node .agents/skills/dev-edit/scripts/edit-gate.mjs [--mode verify|pre-edit|standalone] [--files a,b] [--changed] [--with-native] [--json]`。
  - **覆盖全部改码入口**：
    - `Case 1–4` 及 `rework` 经 `flow.mjs verify` 前置自动触发 `--mode verify --changed --json`（兼容 `--skip-edit-gate` 记录于任务账本而不放过合并前最终 `verify`）；
    - `dev-iterate` 生成或修补测试后直接调用 `edit-gate.mjs` 校验测试真实断言；
    - 无任务上下文的独立本地急改支持直接运行 `--changed` 或 `--files`。
  - **词法去噪扫描（复用并增强 `kit/skills/lib/static-gates.mjs` 与 `static-gates-lexer.mjs`）**：
    - 必须先经词法器剥离注释与字符串字面量分别构建「纯代码视图」与「注释/文档视图」，从根源杜绝误报和漏报：
      1. **压制注释拦截**：在注释视图中检查无明确正当锚点的 `HACK`、`WORKAROUND`、`TEMP`、`@ts-ignore`、`@ts-nocheck`、`eslint-disable`、`# type: ignore`、`# noqa`、`#[allow(` 等标记（排除测试夹具白名单）。
      2. **履历墓碑与大块死代码注释拦截**：识别代码注释内写变更日期履历或连续被注释掉的逻辑/函数体。
      3. **`arch-rules` 越界导入拦截**：读取项目 `AGENTS.md` `arch-rules` 单向依赖表，在纯代码视图的 `import`/`require`/`use` 中检查非法反向依赖。
      4. **单测反作弊检查**：在新增或变更测试文件中阻断零断言用例、`>= 5` 个 mock 仅校验调用次数的纯 Mock 自证、`>= 1000ms` 硬编码 `sleep`/`setTimeout` 等待，及非无头 UI 测试模式。
      5. **文件膨胀拦截**：单源文件 `> 800` 行硬阻断，进入 `730–800` 行紧文件区输出拆分建议。
    - **可选原生校验联动（绝不硬绑定二进制）**：结合 `kit/skills/lib/profile-sniffer.mjs` 探测目标仓实际存在的配置文件，仅在检测到对应本地工具或 `package.json`/CI 已声明指令时可选提示或联动，`edit-gate.mjs` (new) 与 Tier 2 检查绝不假设或强制要求全局安装任何第三方外部 linter 二进制。

### 2. 严格三层纠偏倒金字塔与 `signals.jsonl` 扩展（对应 C6 / SC6）
- **结构化故障指纹流（`kit/skills/lib/signals.mjs` + `kit/skills/dev-review/scripts/review-ledger.mjs`）**：
  - 扩展 `signals.jsonl` 记录字段：`defectClass`（如 `suppression-bypass`、`arch-boundary`、`state-split`、`mock-only-test`、`race-condition`、`stale-contract`、`missing-runtime-proof`）、`pyramidTier`（`tier1-architecture` | `tier2-deterministic-gate` | `tier3-prompt-fallback`）、`fingerprint`（基于 `sha256(ruleId + defectClass + moduleRoot)` 前 12 位稳定指纹）与 `targetArtifact`。
  - 升级 `review-ledger.mjs`：① 在 `record` 时为每条 finding 追加完整指纹事件到运行态状态目录（`.worktrees` 公共状态 `signals.jsonl`）；② 修复第 194–199 行仅看 `comment?.ok` 忽略 `labelRes` 失败的漏洞，显式汇总标签状态与降级提示；③ 将第 546、688 行对 `writeTaskLedger` 的调用迁移至统一加锁 `updateTaskLedger`。
- **倒金字塔强制升格发动机（`kit/skills/dev-govern/scripts/govern-retro.mjs`）**：
  - **彻底废除默认写回 `AGENTS.md`**：删除原来在复盘总结尾部自动拟写或建议向 `AGENTS.md`「修改守则/项目特有红线」追加自然语言条款的默认路径。
  - **同类复发 `>= 2` 次精确判定与三层路由**：
    1. **Tier 1（结构重构优先）**：若 `defectClass` 指向架构耦合、状态分裂、紧文件超长或跨模块隐式依赖，调用 `kit/skills/lib/escalation.mjs` (new) 生成正式 Tier 1 重构任务单（本地 Issue/Todo 草案），明确待解耦文件、新拆模块边界及依赖方向。
    2. **Tier 2（确定性门禁第二优先）**：若问题可静态识别或通过脚本/lint/CI 验证，结合 `profile-sniffer.mjs` 探测的目标仓技术栈生成具体的 Tier 2 落地补丁建议（如在目标仓 `arch-rules` 增加禁令、向 ESLint/Ruff/Clippy/CI 添加规则、或在 `edit-gate.mjs` (new) 新增检测项），仅在安全范围输出可应用补丁或提案，不破坏无端手写配置。
    3. **Tier 3（仅限显式兜底）**：仅当以上两层确实无法静态捕获且调用者显式传参 `--allow-tier3-fallback --reason "{why}"` 时，方允许产出带 `[TIER-3-FALLBACK]` 标识与到期/淘汰条件的极简提示词条；正常定期 `retro` 同时清理已失效或已被后续 Tier 2 规则接管的陈旧 `[TIER-3-FALLBACK]` 遗留条款。

### 3. `dev-govern` 自动触发与全生命周期挂接（对应 C7 / SC7）
- **无感触发契约与双模式入口**：
  - `kit/skills/dev-govern/scripts/govern-audit.mjs`：新增快速增量模式 `audit . --changed --quiet --json`，聚焦本次待提交变动文件及其直接邻域的死代码、`arch-rules`、四层文档同步锁与 `edit-gate` 基础静态卫士，输出稳定轻量结构供 `flow.mjs verify` 与 `flow.mjs finalize`（经 C1 的 `flow-lifecycle-hooks.mjs` (new)）自动调用；命中严重违规直接阻断，保持全过程无噪声。
  - `kit/skills/dev-govern/scripts/govern-retro.mjs`：新增 `--auto --task {taskId} --json`，供 `flow.mjs merge` 与 `flow.mjs cleanup` 完成后自动触发，总结本任务新增与历史累积信号并在跨任务累计复发 `>= 2` 次时自动激活 Tier 1/Tier 2 升格产物。
  - 扩展 `kit/skills/dev-govern/scripts/govern-state.mjs`：持久化最近 `govern-audit`/`govern-retro` 检查基准与 `[TIER-3-FALLBACK]` 清单指纹，支持 `--skip-govern` 将显式豁免记录写入账本与信号流（保障过程绝对可审计）。
  - 更新 `kit/skills/dev-govern/SKILL.md` 声明「静态分析 + 自动周期复盘 + 严禁动态写测」边界。

### 4. 移除 `govern-tests.mjs` 固定路径正则硬编码与小仓假阳性（对应 C8 / SC8）
- **删除 `NON_UNIT_TEST_RE` 硬编码**：移除 `kit/skills/dev-govern/scripts/govern-tests.mjs` 第 38 行将 `(?:e2e|integration|browser|perf|benchmark|benchmarks|load|stress)` 路径段机械当作非单元测试从而排除或误判的规则（注：`sit` 属于文档脚手架规则、`qa` 在 `govern-tests.mjs` 并无正则）。
- **元数据与栈特征驱动判定**：
  - 扩展 `kit/skills/lib/profile-sniffer.mjs`：识别目标仓 `package.json` 测试脚本（如 `test:unit`、`test:integration`、`test:e2e`）、测试框架配置文件（Vitest/Jest projects、Pytest markers/ini、Cargo `--test` vs `--lib`、Go build tags）与实际测试文件数量。
  - `govern-tests.mjs` 依据上述真实测试层级元数据划分测试类别；当仓库总测试数较少且 `quick-test` 无分层分离必要（如小型仓库仅设单条极速运行指令）时，自动放行而不误报 `tests.unfiltered-quick-test`。

## 三、备选方案与否决理由

1. **否决「在 `govern-retro` 保留默认写 `AGENTS.md`，仅改用人工提醒优先改代码」**：软提醒无法阻止模型顺手写入自然语言补丁导致 `AGENTS.md` 逐代膨胀且同类故障继续复发；必须以代码层硬废除默认回写与 `--allow-tier3-fallback` 显式开关彻底落实倒金字塔。
2. **否决「让 `edit-gate.mjs` 用简单的全文正则匹配 `@ts-ignore` / `HACK`」**：未经词法去噪会把合法字符串示例、正则定义本身（比如本仓自己的规则检测代码）误伤成违禁代码；坚持统一扩展 `static-gates-lexer.mjs` 走先剥离再匹配路径。
3. **否决「扩充路径目录名关键词清单替换 `NON_UNIT_TEST_RE`」**：目录与文件名约定跨项目千差万别，机械扩表治标不治本；直接从测试脚本与配置元数据读取分层真相。

## 四、改动清单与影响面

1. **新增第 6 技能与门禁引擎**：
   - `kit/skills/dev-edit/` (new)、`kit/skills/dev-edit/scripts/` (new)
   - `kit/skills/dev-edit/SKILL.md` (new)
   - `kit/skills/dev-edit/scripts/edit-gate.mjs` (new)
2. **共享静态库、栈探测与信号指纹**：
   - `kit/skills/lib/signals.mjs`
   - `kit/skills/lib/static-gates.mjs`
   - `kit/skills/lib/static-gates-lexer.mjs`
   - `kit/skills/lib/profile-sniffer.mjs`
3. **审查信号采集与治理闭环**：
   - `kit/skills/dev-review/scripts/review-ledger.mjs`（修复第 194–199 行 `labelRes` 漏洞、写入指纹并迁移第 546/688 行 `writeTaskLedger`）
   - `kit/skills/dev-govern/SKILL.md`
   - `kit/skills/dev-govern/scripts/govern-retro.mjs`
   - `kit/skills/dev-govern/scripts/govern-state.mjs`
   - `kit/skills/dev-govern/scripts/govern-tests.mjs`
   - `kit/skills/dev-govern/scripts/govern-audit.mjs`
4. **独立双向夹具与派生装配同步**：
   - `scripts/dev/fixtures-edit-pyramid.mjs` (new)
   - `scripts/dev/injections-data-edit-pyramid.mjs` (new)
   - 在本 PR 内运行 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 同步派生 `.agents/skills/` 与 `AGENTS.md` `意图路由`（保证 CI `equip.mjs . --check` 与 `compose-agents.mjs . --check` 全绿）。

## 五、冻结的验收标准

<!-- criteria:start -->
- [x] C5: （SC5）新增第 6 技能 `dev-edit/` (new) 与 `kit/skills/dev-edit/scripts/edit-gate.mjs` (new)，覆盖全量改码入口并前置集成进 `flow.mjs verify`；基于 `static-gates-lexer.mjs` 剥离注释/字面量后阻断压制注释、墓碑履历、死代码注释、`arch-rules` 越界、单测反作弊及 `> 800` 行超限文件，且绝不硬绑定第三方外部 linter 二进制。
- [x] C6: （SC6）扩展 `signals.jsonl` 增加 `defectClass`、`pyramidTier`、`fingerprint` 并在 `review-ledger.mjs` 写入按条信号、迁移其 `writeTaskLedger` 及修复第 194–199 行忽略 `labelRes` 失败漏洞；废除 `govern-retro.mjs` 默认向 `AGENTS.md` 追加规范，同一模式复发 `>= 2` 次强制经 Stage B 基线 `escalation.mjs` (new) 优先升格为 Tier 1 结构重构或 Tier 2 静态检查/可选原生校验配置，仅显式 `--allow-tier3-fallback` 方允许带 `[TIER-3-FALLBACK]` 标记落地并清理过时条款。
- [x] C7: （SC7）打通 `dev-govern` 自动触发体系：`flow finalize`/`verify` 链路自动触发轻量 `govern-audit --changed` 体检，`flow merge`/`cleanup` 完成后自动触发轻量 `govern-retro` 复盘（支持 `--skip-govern` 并显式记账，严禁无痕跳过）。
- [x] C8: （SC8）移除 `govern-tests.mjs` 第 38 行 `NON_UNIT_TEST_RE` 把测试路径段硬编码排除出单元测试的规则，改为结合 `profile-sniffer.mjs` 探测出的目标仓测试分层元数据精准区分单测/集成/端到端测试，并修复小型仓库误报 `tests.unfiltered-quick-test` 的假阳性。
<!-- criteria:end -->

## 六、高风险点、门型与回滚路径

1. **门型判定**：`one-way`（高风险）。触及所有代码修改准入门禁、`signals.jsonl` 结构兼容与倒金字塔自动化决策链路，合入前必须经过独立代码审查与故障注入校验。
2. **紧文件行数控制**：
   - `kit/skills/lib/static-gates.mjs`（当前 733L -> 词法扩充写入 `static-gates-lexer.mjs` 控制主文件 `<= 720L`）
   - `kit/skills/dev-review/scripts/review-ledger.mjs`（Stage B `<= 600L` -> 保持 `<= 640L`）
   - `kit/skills/dev-govern/scripts/govern-state.mjs`（Stage B `<= 680L` -> 保持 `<= 710L`）
   - `kit/skills/dev-edit/scripts/edit-gate.mjs` (new)（控制 `<= 550L`）。
3. **关键故障点与回滚**：
   - **误报阻断开发**：`edit-gate.mjs` (new) 提供精确行号、规则码与 `--mode` 信息；合法规则检验代码自带的正则字面量通过词法剥离自动免疫。
   - **升级死循环**：相同 `fingerprint` 已开出尚未关闭的 Tier 1 重构单时，`govern-retro.mjs` 去重引用原单号而非重复建单。
   - **回滚路径**：所有修改独立封装于 `C2` PR，出现回归可通过单个 `git revert` 撤销。

## 七、上线与兼容策略

- **历史 `signals.jsonl` 兼容**：旧条目的 `defectClass`/`fingerprint` 为空时由 `signals.mjs` 读时按 `ruleId` 与默认模块名实时补全虚拟指纹，平滑过渡不破坏现有信号账本。
- **Wave C-1 合入协同**：若 `C1` 后合入，`C1` 负责 rebase 并重跑 `equip.mjs . && compose-agents.mjs .`；若 `C1` 先合入，`C2` 合入前 rebase `main`、运行 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 将第 6 技能 `dev-edit/` (new) 同步入 `.agents/skills/` 与 `AGENTS.md` `意图路由`，并验证 `fixtures.mjs` 自动发现加载 `fixtures-stagec-c2.mjs` (new) 全绿。

## 澄清与补充记录

- `2026-11-19`：确认 `C2` 的 `edit-gate.mjs` (new) 与 `govern-audit.mjs`/`govern-retro.mjs` 自动调用 CLI 契约与 `C1` 的 `flow-lifecycle-hooks.mjs` (new) 完全解耦，Wave C-1 双方 0 冲突文件。

## 实现说明

- 第 6 技能 `kit/skills/dev-edit/SKILL.md`（65L，`order: 33`，含「无预设工具运行时实证分级策略」）与 `kit/skills/dev-edit/scripts/edit-gate.mjs`（459L，支持不传 `--changed` 仅传 `--task` 自动扫描变更文件以无缝对接 `flow-lifecycle-hooks.mjs`）落地；基于 `static-gates-lexer.mjs` `buildLexedViews` 与通用 Tier 2 规则 `naming.process-artifact-filename`（`edit-gate` 与 `govern-audit` 双端共享），正反夹具覆盖 10 类阻断与词法去噪免疫。
- `signals.jsonl` 扩展 `{ defectClass, pyramidTier, fingerprint, targetArtifact }` 与旧条目读时虚拟指纹补全；`review-ledger.mjs`（600L）零 `writeTaskLedger`、写入条级信号并在普通审查对命中 `classifyEscalationTier === 'escalated-issue'` 的范围外/存量发现按指纹去重自动建单；`review-sync.mjs` 修复 `labelRes`/`addRes` 失败静默忽略，并按维护者决策对 PR 审查表格仅做无损 Markdown 安全化（折行并转义未转义竖线，完整保留条款原文不做截断）。
- `govern-retro.mjs` 彻底废除默认回写 `AGENTS.md` 并补齐 `summary --task {taskId} --json` 直调 CLI 入口（对接 `flow-lifecycle-hooks.mjs`），复发 `>= 2` 次强制按 Tier 1 重构单（去重）/ Tier 2 确定性静态门禁分派，仅 `--allow-tier3-fallback --reason` 允许写 `[TIER-3-FALLBACK]` 并自动清理过期或已由 Tier 2 覆盖条款。
- `govern-audit.mjs`（`--changed --quiet --json`、`--skip-govern`）、`govern-state.mjs`（670L）、`dev-govern/SKILL.md`（已清净旧档位残留 wording）与 `govern-tests.mjs`（移除 `NON_UNIT_TEST_RE`、接入 `profile-sniffer.mjs` 元数据分层与小仓免报 `tests.unfiltered-quick-test`）全部按功能域命名为 `scripts/dev/fixtures-edit-pyramid.mjs` 与 `scripts/dev/injections-data-edit-pyramid.mjs` 并通过全量自动发现门禁与故障注入实测。
