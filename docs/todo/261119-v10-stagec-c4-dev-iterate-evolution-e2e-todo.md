---
kind: todo
title: "v10 第八技能 dev-iterate、跨代双向融合与 Stage B+C 全机制盲测终验（Stage C-4）"
status: active
created: 2026-11-19
updated: 2026-11-19
issue: null
pr: null
branch: null
owner: "plan-stage-c"
approved: false
done_at: null
task_id: v10-stagec-c4
planned_at: "8566de3da467f5137f362ecad4323dbc093dca00"
related_prd: ../prd/261119-v10-stagec-unified-architecture-prd.md
related_spec: ../specs/261119-v10-stagec-c4-dev-iterate-evolution-e2e-spec.md
---

# 任务清单：v10 第八技能 dev-iterate、跨代双向融合与 Stage B+C 全机制盲测终验（Stage C-4）

## 文档信息与范围概览

- **任务编号**：`v10-stagec-c4`
- **所属波次**：Wave C-2 右翼（与 `v10-stagec-c3` 并行推进，写域严格零交叠；在 Wave C-1 合入 `main` 后启动）
- **关联总控**：[Stage C 总控 PRD](../prd/261119-v10-stagec-unified-architecture-prd.md)
- **关联设计**：[Stage C-4 设计规范](../specs/261119-v10-stagec-c4-dev-iterate-evolution-e2e-spec.md)

## 任务范围与验证基准

- **修改范围**：新增目录 `kit/skills/dev-iterate/` (new)、`kit/skills/dev-iterate/scripts/` (new)、`.agents/forge-overlays/` (new) 与 `.agents/extensions/` (new)；落地第 8 技能 `dev-iterate/` (new) 与测试盘点 `kit/skills/lib/test-inventory.mjs` (new)；落地跨代双向扩展 `kit/skills/lib/overlay.mjs` (new)、`.agents/forge-hooks.json` (new)、目标仓 Git `pre-push.local` 本地钩子、嵌套发现、供应链扫码、解除 `disabledCoreSkills` 死锁、`scripts/lib/merge3.mjs` (new) 与 `scripts/lib/equip-integrity.mjs` (new)；实现 `Scenarios H–L`、本仓自举、本地模拟 HTTP/SSH 远端与 `$TMPDIR` 多生态 Zero-Hint 强弱模型对照盲测终验。
- **严禁触碰**：`kit/skills/dev-verify-tools/` (new)、`kit/skills/lib/feature-map.mjs` (new)、`docs/feature-map.json` (new)（仅只读验证，不作生成修改）、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/dev-review/{SKILL.md,scripts/{review-context,review-pack,review-gates,review-empirical}.mjs}`（保留给 C3 写域），以及 `261118-*` Stage B 文件。
- **验证基准命令**：`node scripts/dev/preflight.mjs`、`node scripts/dev/e2e-zip-harness.mjs`、`node scripts/dev/e2e-scenarios-stagec.mjs` (new)、`node scripts/dev/blind-run-harness.mjs` (new)、`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`。

### 不做什么（Non-Goals）

- 不改写 `C3` 的 `dev-verify-tools/` (new)、`feature-map.mjs` (new)、`review-context.mjs` (new) 与 `flow-cleanup.mjs`。
- `dev-iterate` 生成的测试用例不放入 `.agents/`，也不污染轻仓快速 `quick-test` 默认单测集。

## 验收标准与执行清单

<!-- criteria:start -->
- [ ] C13: （SC13）新增第 8 技能 `dev-iterate/` (new)，与静态 `dev-govern` 严格划清边界并共用 `kit/skills/lib/test-inventory.mjs` (new)；依据功能地图盲区与高发信号生成符合质量门禁的业务/并发/性能测试直接进入目标仓原生测试目录并支持分片并发执行；抓出真实缺陷或退化时经 `escalation.mjs` (new) 转交 `dev-plan -> dev-edit -> dev-review` 修复并记录信号。
- [ ] C14: （SC14）实现跨代双向演进与融合机制：收窄 `TOOL_OWNED_PREFIXES`、支持 `.agents/forge-overlays/` (new)、`.agents/forge-hooks.json` (new)、目标仓 Git `pre-push.local` 钩子与嵌套技能去重发现并将自定义载荷纳入 `untrusted-scan`；解除 `disabledCoreSkills` 升级死锁；升级 `.pf-manifest.json` 至 schema v3 与 `REGION_MIGRATIONS`，实现条件三方合并 `merge3.mjs` (new)（`.mjs` 冲突禁写文本标记并校验 `node --check` 与静态 ESM ABI）。
- [ ] C15: （SC15）新增并跑通 Stage B+C 离线全链路 `Scenarios H–L`（`scripts/dev/e2e-scenarios-stagec.mjs` (new)），在本仓完成 8 技能与 `docs/feature-map.json` (new) 自举全绿，并在本地自建模拟 HTTP/SSH 远端仓库验证双协作者、打标、`closePr`、升级融合与回滚链路。
- [ ] C16: （SC16）交付 `scripts/dev/blind-run-harness.mjs` (new) 完整验证矩阵，在 `$TMPDIR` 下对 Node、Python、Rust、Go 多生态仓库与含本地定制 Overlay 的存量仓库，于 Zero-Hint 零额外指令下完成 `gemini-4-hydrogen-xhigh` 与 `gemini-3.8-flash-high` 双档模型对照盲测并通过全部定量门槛与回归门禁。
<!-- criteria:end -->

## 执行步骤

- [ ] 1. **新增第 8 技能 `dev-iterate/` 与共享测试盘点（C13）**：抽出 `kit/skills/lib/test-inventory.mjs` (new) 并更新 `kit/skills/dev-govern/scripts/govern-tests.mjs` 复用；创建 `kit/skills/dev-iterate/` (new)、`kit/skills/dev-iterate/scripts/` (new)、`kit/skills/dev-iterate/SKILL.md` (new)（`order: 55`）与 `kit/skills/dev-iterate/scripts/iterate.mjs` (new)（`<= 700L`），确保写入目标仓原生测试目录（零污染 `.agents/` 与 `quick-test`）、过 `edit-gate`、并发运行并由 `kit/skills/lib/escalation.mjs` (new) 转正闭环修复。
- [ ] 2. **落地双向融合基础设施、Overlay/Hook 安全扫码与 `merge3`（C14）**：收窄 `kit/skills/lib/tool-owned.mjs`、`kit/skills/lib/skill-discovery.mjs` 嵌套发现与去重；新增 `kit/skills/lib/overlay.mjs` (new) 与 `flow-lifecycle.mjs` 钩子、扩展 `templates/githooks-pre-push.sh`；更新 `kit/skills/dev-govern/scripts/govern-checks.mjs` 修复 `inspectManifest` 脑裂并豁免合法自定义目录；在 `kit/skills/dev-review/scripts/review-diff.mjs` 将定制载体纳入 `untrusted-scan`；解除 `disabledCoreSkills` 升级锁死；更新 `scripts/lib/protocol.mjs`（schema v3 与 `REGION_MIGRATIONS`）并交付 `scripts/lib/merge3.mjs` (new) 与 `scripts/lib/equip-integrity.mjs` (new) 接入 `equip.mjs` / `compose-agents.mjs`。
- [ ] 3. **完成 Stage B+C `Scenarios H–L`、自举同步与模拟远端（C15）**：新增 `scripts/dev/e2e-scenarios-stagec.mjs` (new) 与 `scripts/dev/mock-remote-server.mjs` (new) 接入 `scripts/dev/e2e-zip-harness.mjs`；更新终版 `docs/TDD.md`、`AGENTS.md`、`SKILL.md`、`README.md`、`README.en.md` 与 `scripts/dev/preflight-contract-rules.mjs` (new)（exact-8 门禁校验）；执行本仓全量 `equip` 自举与本地 HTTP/SSH 模拟远端协同验收。
- [ ] 4. **落实 `$TMPDIR` 多生态实测与 Zero-Hint 双档盲测终验（C16）**：交付 `scripts/dev/blind-run-harness.mjs` (new)、`scripts/dev/blind-run-matrix.mjs` (new)、`scripts/dev/fixtures-stagec-c4.mjs` (new) 与 `scripts/dev/injections-data-stagec-c4.mjs` (new)，对 Node/Python/Rust/Go/Overlay 混合仓在 Zero-Hint 下对照跑通 `gemini-4-hydrogen-xhigh` 与 `gemini-3.8-flash-high` 双模型并校验全门禁全绿收口。

## 风险与应对

- **并发 Wave C-2 二次合入同步**：若 `C3` 后于 `C4` 合入或反向，后合入分支必须 rebase 并运行 `node scripts/equip.mjs .` 与完整 `e2e-scenarios-stagec.mjs` (new) 实测通过后才允许并入 `main`。
- **三方合并误写源码**：`.mjs` 冲突通过后缀 `.pf-conflict` 旁路、禁止写入冲突标记及合后立即 `node --check` 与 ESM ABI 校验三重保护。

## 回滚预案

- `equip`/`compose-agents` 每次改盘前均经 `backup.mjs` 生成仓外 `.zip` 快照，任何回归或校验失败均自动回滚；PR 级别可通过单个 `git revert` 独立恢复至 `C3` 状态。

## 协作与依赖

- **前置依赖**：Wave C-1（`C1` + `C2`）已合入 `main`（依赖 `edit-gate`、`signals` 指纹、`escalation.mjs` (new) 与 `doc-locate`）。
- **并进联动**：Wave C-2 中与 `C3` 并行开发，集成收尾时消费 `C3` 交付的 `docs/feature-map.json` (new) 进行全套 `Scenarios K/L` 与盲测闭环验证。

## 断点与遗留决策

- 无遗留未决决策：Q6（测试入原生目录及 `.mjs` 冲突禁写标记规则）与 Zero-Hint 双模型验证门槛均已拍板定稿。

## 澄清与补充记录

- `2026-11-19`：明确 `C4` 拆分 `blind-run-matrix.mjs` (new) 与 `mock-remote-server.mjs` (new)，保持所有测试框架文件各自 `<= 720L`。

## 完成后的记录

- 待实施、验证与合并后补全 PR 号、最终 `HEAD` SHA、`Scenarios A–L` 实测通过结果与强弱模型盲测指标对比汇总。
