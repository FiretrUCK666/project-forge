---
kind: todo
title: "v10 第六技能 dev-edit、严格三层倒金字塔与 dev-govern 自动触发（Stage C-2）"
status: active
created: 2026-11-19
updated: 2026-11-19
issue: null
pr: null
branch: null
owner: "plan-stage-c"
approved: false
done_at: null
task_id: v10-stagec-c2
planned_at: "8566de3da467f5137f362ecad4323dbc093dca00"
related_prd: ../prd/261119-v10-stagec-unified-architecture-prd.md
related_spec: ../specs/261119-v10-stagec-c2-dev-edit-pyramid-govern-spec.md
---

# 任务清单：v10 第六技能 dev-edit、严格三层倒金字塔与 dev-govern 自动触发（Stage C-2）

## 文档信息与范围概览

- **任务编号**：`v10-stagec-c2`
- **所属波次**：Wave C-1 右翼（与 `v10-stagec-c1` 并行开发，零文件交叠；依赖 Stage B 合入 `main`）
- **关联总控**：[Stage C 总控 PRD](../prd/261119-v10-stagec-unified-architecture-prd.md)
- **关联设计**：[Stage C-2 设计规范](../specs/261119-v10-stagec-c2-dev-edit-pyramid-govern-spec.md)

## 任务范围与验证基准

- **修改范围**：新增目录 `kit/skills/dev-edit/` (new) 与 `kit/skills/dev-edit/scripts/` (new) 下的 `edit-gate.mjs` (new)；扩展 `signals.jsonl`、`review-ledger.mjs`（修复第 194–199 行 `labelRes` 漏洞、写入指纹与第 546/688 行 `writeTaskLedger` 迁移）、`govern-retro.mjs` 落实严格三层倒金字塔；补全 `govern-audit.mjs` 与 `govern-state.mjs` 自动触发接口；重写 `govern-tests.mjs` 第 38 行 `NON_UNIT_TEST_RE` 判定消除小仓假阳性；在本 PR 内同步运行 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 刷新 `.agents/skills/` 与 `AGENTS.md` `意图路由`。
- **严禁触碰**：`templates/agents-project.md` 及手改 `AGENTS.md` 受管模板结构、`SKILL.md`、`scripts/` 核心安装脚本、`kit/skills/dev-flow/`、`kit/skills/dev-explore/`、`kit/skills/dev-plan/`、`kit/skills/dev-review/scripts/{review-pack,review-pr}.mjs` 与 `kit/skills/dev-govern/scripts/release-prep-lib.mjs`（保留给 C1 写域），以及 `261118-*` Stage B 文件。
- **验证基准命令**：`node scripts/dev/fixtures-stagec-c2.mjs`（单跑与全量 `fixtures.mjs` 均需通过）、`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --json`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --strict`、`node scripts/dev/preflight.mjs`。

### 不做什么（Non-Goals）

- 不改写 `dev-flow/`、`templates/`、`SKILL.md` 及 `doc-locate` 定位链（归 `C1`）；`edit-gate` 与 Tier 2 检查绝不硬绑定任何第三方外部 linter 二进制。
- 不实现功能验证地图与正向测试生成器 `dev-iterate`（归 `C3`/`C4`）；`dev-govern` 不编写或执行动态业务测试。

## 验收标准与执行清单

<!-- criteria:start -->
- [ ] C5: （SC5）新增第 6 技能 `dev-edit/` (new) 与 `kit/skills/dev-edit/scripts/edit-gate.mjs` (new)，覆盖全量改码入口并前置集成进 `flow.mjs verify`；基于 `static-gates-lexer.mjs` 剥离注释/字面量后阻断压制注释、墓碑履历、死代码注释、`arch-rules` 越界、单测反作弊及 `> 800` 行超限文件，且绝不硬绑定第三方外部 linter 二进制。
- [ ] C6: （SC6）扩展 `signals.jsonl` 增加 `defectClass`、`pyramidTier`、`fingerprint` 并在 `review-ledger.mjs` 写入按条信号、迁移其 `writeTaskLedger` 及修复第 194–199 行忽略 `labelRes` 失败漏洞；废除 `govern-retro.mjs` 默认向 `AGENTS.md` 追加规范，同一模式复发 `>= 2` 次强制经 Stage B 基线 `escalation.mjs` (new) 优先升格为 Tier 1 结构重构或 Tier 2 静态检查/可选原生校验配置，仅显式 `--allow-tier3-fallback` 方允许带 `[TIER-3-FALLBACK]` 标记落地并清理过时条款。
- [ ] C7: （SC7）打通 `dev-govern` 自动触发体系：`flow finalize`/`verify` 链路自动触发轻量 `govern-audit --changed` 体检，`flow merge`/`cleanup` 完成后自动触发轻量 `govern-retro` 复盘（支持 `--skip-govern` 并显式记账，严禁无痕跳过）。
- [ ] C8: （SC8）移除 `govern-tests.mjs` 第 38 行 `NON_UNIT_TEST_RE` 把测试路径段硬编码排除出单元测试的规则，改为结合 `profile-sniffer.mjs` 探测出的目标仓测试分层元数据精准区分单测/集成/端到端测试，并修复小型仓库误报 `tests.unfiltered-quick-test` 的假阳性。
<!-- criteria:end -->

## 执行步骤

- [ ] 1. **新增第 6 技能 `dev-edit/` 与 `edit-gate.mjs`（C5）**：创建 `kit/skills/dev-edit/` (new)、`kit/skills/dev-edit/scripts/` (new)、`kit/skills/dev-edit/SKILL.md` (new)（`order: 33`）与 `kit/skills/dev-edit/scripts/edit-gate.mjs` (new)（不超过 550 行）；扩展 `kit/skills/lib/static-gates-lexer.mjs` 与 `kit/skills/lib/static-gates.mjs`（维持不超过 720 行）支持剥离注释与字面量后拦截 6 类坏味、超过 800 行超限并联动可选原生检查（绝不硬绑定第三方 linter 二进制），对齐 `flow.mjs verify` 调用契约。
- [ ] 2. **扩展信号指纹、`review-ledger` 漏洞修复与倒金字塔引擎（C6）**：更新 `kit/skills/lib/signals.mjs` 增加 `defectClass`/`pyramidTier`/`fingerprint`/`targetArtifact` 结构与旧记录读时补全；升级 `kit/skills/dev-review/scripts/review-ledger.mjs` 修复第 194–199 行忽略 `labelRes` 失败漏洞、迁移第 546/688 行 `writeTaskLedger` 至 `updateTaskLedger` 并在 `record` 写入按条指纹；重写 `kit/skills/dev-govern/scripts/govern-retro.mjs` 彻底取消默认追加 `AGENTS.md`，对复发 `>= 2` 次自动经 Stage B 基线 `kit/skills/lib/escalation.mjs` (new) 或 `profile-sniffer.mjs` 升格 Tier 1/Tier 2（禁用未授权 Tier 3）。
- [ ] 3. **打通 `dev-govern` 自动触发与清理测试误判（C7、C8）**：升级 `kit/skills/dev-govern/scripts/govern-audit.mjs`（新增 `--changed --quiet --json`）与 `govern-state.mjs`（支撑 `--auto` 复盘基准与 `--skip-govern` 审计记录），更新 `kit/skills/dev-govern/SKILL.md`；扩展 `kit/skills/lib/profile-sniffer.mjs` 测试分层元数据探测，移除 `kit/skills/dev-govern/scripts/govern-tests.mjs` 第 38 行 `NON_UNIT_TEST_RE` 硬编码及小型仓库 `unfiltered-quick-test` 误报。
- [ ] 4. **独立双向夹具、派生路由同步与全门禁验收（C5–C8）**：新增 `scripts/dev/fixtures-stagec-c2.mjs` (new) 与 `scripts/dev/injections-data-stagec-c2.mjs` (new) 覆盖全正反场景；在本 PR 运行 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 保持 `.agents/skills/` 与 `AGENTS.md` `意图路由` 对齐，并完成 `C1` rebase 与全量 `merge-gate`。

## 风险与应对

- **词法剥离在模板字符串与正则中的边缘误报**：使用现有 `static-gates-lexer.mjs` 状态机扫描 JS/TS/Py/Rust/Go 语法并写入正反例夹具对比验证。
- **跨文件并行验收**：若 `C1` 尚未合入，确保 `fixtures-stagec-c2.mjs` (new) 可脱离 `fixtures.mjs` 直接单执行通过；`C1` 合入后立即被自动发现接入总门禁。

## 回滚预案

- 未推分支可直接清理重置；合入后若发现门禁误杀或升格循环，通过单个 `git revert` 独立撤销 `C2` 合并提交，同时 `signals.jsonl` 兼容旧字段读出不损坏既有账本。

## 协作与依赖

- **前置依赖**：Stage B 全量合入（提供 `escalation.mjs` (new)）；与 `C1` 通过 `--mode verify --json`、`--changed --quiet --json`、`--auto --json` CLI 契约并行对接。
- **下游交接**：合入 Wave C-1 后为 Wave C-2 的 `C4`（`dev-iterate` 测试质量门与 `escalation` 信号写回）提供就绪的 `edit-gate` 与指纹基线。

## 断点与遗留决策

- 无遗留未决决策：Q2（全改码入口覆盖与钩子边界）、Q3（倒金字塔禁止默认改 `AGENTS.md` 与自动触发时机）均已拍板定稿。

## 澄清与补充记录

- `2026-11-19`：明确 `C2` 严禁触碰 `dev-flow/`，全套自动挂载由 `C1` `flow-lifecycle-hooks.mjs` (new) 按约定 CLI 参数完成。

## 完成后的记录

- 待实施、验证与合并后补全 PR 号、最终 `HEAD` SHA 及正反断言用例通过统计。
