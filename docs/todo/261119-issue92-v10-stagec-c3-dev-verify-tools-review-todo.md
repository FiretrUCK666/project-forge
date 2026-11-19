---
kind: todo
title: v10 第七技能 dev-verify-tools、docs/feature-map.json 与先实证后 Diff 审查（Stage C-3）
status: active
created: 2026-11-19
updated: 2026-11-19
issue: 92
pr: null
branch: null
owner: plan-stage-c
approved: false
done_at: null
task_id: v10-stagec-c3
planned_at: 8566de3da467f5137f362ecad4323dbc093dca00
related_prd: ../prd/261119-v10-stagec-unified-architecture-prd.md
related_spec: ../specs/261119-issue92-v10-stagec-c3-dev-verify-tools-review-spec.md
---

# 任务清单：v10 第七技能 dev-verify-tools、docs/feature-map.json 与先实证后 Diff 审查（Stage C-3）

## 文档信息与范围概览

- **任务编号**：`v10-stagec-c3`
- **所属波次**：Wave C-2 左翼（与 `v10-stagec-c4` 并行推进，写域严格互斥；需待 Wave C-1 合入 `main` 后启动）
- **关联总控**：[Stage C 总控 PRD](../prd/261119-v10-stagec-unified-architecture-prd.md)
- **关联设计**：[Stage C-3 设计规范](../specs/261119-issue92-v10-stagec-c3-dev-verify-tools-review-spec.md)
- Issue: #92

## 任务范围与验证基准

- **修改范围**：新增目录 `kit/skills/dev-verify-tools/` (new) 与 `kit/skills/dev-verify-tools/scripts/` (new)，落地第 7 技能与唯一功能地图 `docs/feature-map.json` (new)（`verificationTools[]` + `testRefs`，无局部哈希）与共享库 `kit/skills/lib/feature-map.mjs` (new)；对接 `repo-map.mjs` 自动预填与 `flow-cleanup.mjs` 仓外草稿销毁；拆出 `review-context.mjs` (new) 并强化 `dev-review` 强制先实证后 `--include-diff`；贯通创造/自动复用/体检清理三大场景，在本 PR 运行 `equip.mjs . && compose-agents.mjs .` 同步派生路由。
- **严禁触碰**：`kit/skills/dev-iterate/` (new)、`kit/skills/dev-flow/scripts/{flow-lifecycle,flow-lifecycle-hooks}.mjs`、`kit/skills/dev-govern/`、`kit/skills/dev-review/scripts/review-diff.mjs`、`scripts/{equip,compose-agents}.mjs`、`scripts/lib/`、`templates/`、`docs/TDD.md` 及手改 `AGENTS.md` 受管模板结构（保留给 C4 写域，仅允许执行 `compose-agents.mjs .` 刷新派生路由），以及 `261118-*` Stage B 文件。
- **验证基准命令**：`node scripts/dev/fixtures-stagec-c3.mjs`、`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit --json`、`node .agents/skills/dev-review/scripts/review-pack.mjs --include-diff`（验证缺实证必阻断）、`node scripts/dev/preflight.mjs`。

### 不做什么（Non-Goals）

- 不改写 `kit/skills/dev-flow/scripts/{flow-lifecycle,flow-lifecycle-hooks}.mjs`、`equip.mjs`、`govern-tests.mjs`、`govern-checks.mjs`、`templates/` 与终局文档同步（归 `C4`）。
- 不负责向原生测试目录批量生成回归/性能测试用例（归第 8 技能 `dev-iterate/` (new)）。

## 验收标准与执行清单

<!-- criteria:start -->
- [ ] C9: （SC9）新增第 7 技能 `dev-verify-tools/` (new) 与唯一机读功能地图 `docs/feature-map.json` (new)（`verificationTools[]` + `testRefs`，无局部哈希且无冗余复写入 `docs/TDD.md`）；由 `repo-map.mjs` 自动从 E2E/脚本/`businessFlows` 预填并完成本仓自举；临时验证草稿锁入仓外 `{gitCommonDir}/project-forge-verify/scratch/{taskId}/` 并在 `flow cleanup`/`abort` 时确定性彻底销毁。
- [ ] C10: （SC10）落地不依赖手工时间戳/日期的工具过时校验：通过 `symbol-index.mjs` 导出符号与 Git tree 基线对比仓外 `{gitCommonDir}/project-forge-verify/cache.json` 自动判 `stale`，并按低/中/高风险执行告警提示、E2E 兜底或硬阻断策略。
- [ ] C11: （SC11）重构 `dev-review`（拆出 `review-context.mjs` (new)），无论 `docs/feature-map.json` (new) 是否存在预设工具，均强制注入 `businessFlows`、相邻模块与运行时能力并在输出 `--include-diff` 前强制完成真实运行或端到端实证校验。
- [ ] C12: （SC12）完整跑通 `dev-verify-tools` 三大自然语言/斜杠核心场景——创造新工具（仓外草稿成熟后沉淀注册入 `docs/feature-map.json` (new)）、自动复用已有工具（含过时分级处置）及工具体检清理（消除僵尸引用与高风险盲区）。
<!-- criteria:end -->

## 执行步骤

- [ ] 1. **新增第 7 技能、唯一功能地图与 `scratch` 销毁机制（C9）**：创建 `kit/skills/dev-verify-tools/` (new)、`kit/skills/dev-verify-tools/scripts/` (new)、`kit/skills/dev-verify-tools/SKILL.md` (new)（`order: 48`）与 `kit/skills/lib/feature-map.mjs` (new)（`<= 600L`）；在 `kit/skills/dev-explore/scripts/repo-map.mjs` 对接自动从现有 E2E/脚本/`businessFlows` 预填；自举生成本仓 `docs/feature-map.json` (new)（`verificationTools[]` + `testRefs`，不含局部哈希）；锁定临时草稿到 `{gitCommonDir}/project-forge-verify/scratch/{taskId}/` 并更新 `kit/skills/dev-flow/scripts/flow-cleanup.mjs` 在清理与中止时彻底销毁。
- [ ] 2. **实现免手工日期过时校验与风险分级（C10）**：在 `feature-map.mjs` (new) 中结合 `kit/skills/lib/symbol-index.mjs` 导出符号摘要与 Git tree/blob SHA 读写仓外 `{gitCommonDir}/project-forge-verify/cache.json`，实现低风险警告、中风险优先走 E2E/草稿重验与高风险硬阻断，全程不使用时间戳或日期比较。
- [ ] 3. **升级 `dev-review` 先实证后 Diff 强顺序（C11）**：从 `kit/skills/dev-review/scripts/review-pack.mjs` 拆出 `kit/skills/dev-review/scripts/review-context.mjs` (new)（主文件降至 `<= 660L`）；升级 `review-gates.mjs`（`<= 730L`）、`review-empirical.mjs`（`<= 740L`）与 `kit/skills/dev-review/SKILL.md`，强制无论地图有无预设工具皆注入受波及 `businessFlows`、相邻模块及运行时能力并在无实证证据时阻断 `--include-diff`。
- [ ] 4. **贯通三大核心工作流、夹具验证与派生路由同步（C12）**：在 `kit/skills/dev-verify-tools/scripts/verify-tools.mjs` (new)（`<= 650L`）落地创造、自动复用、体检清理完整命令流；编制 `scripts/dev/fixtures-stagec-c3.mjs` (new) 与 `scripts/dev/injections-data-stagec-c3.mjs` (new)，执行 `node scripts/equip.mjs . && node scripts/compose-agents.mjs .` 并实测三场景、审查阻断及 `merge-gate` 全通。

## 风险与应对

- **仓外草稿遗留风险**：若进程异常中断未走 `flow cleanup`，在 `verify-tools.mjs audit` 中同时列出并清理已关闭任务对应的陈旧 `{gitCommonDir}/project-forge-verify/scratch/` 残留。
- **纯文档/非代码变更误阻断**：延续低风险非可执行路径协议豁免，确保纯拼写/Markdown 修正不触发不必要运行实证阻断。

## 回滚预案

- 未推分支可直接清理重置；合入后如发现功能地图匹配或实证门误拦截，通过单次 `git revert` 撤销 `C3` 提交，且不污染或删除现有工作区仓库文件。

## 协作与依赖

- **前置依赖**：Wave C-1（`C1` + `C2`）已合入 `main`（依赖 `markdown-scan.mjs`、`doc-locator.mjs` 与 `edit-gate.mjs`）。
- **下游交接**：与 `C4` 并行推进并在 `C4` 的 `Scenarios K/L` 端到端链路中联动验收。

## 断点与遗留决策

- 无遗留未决决策：Q4（唯一真相源与免日期指纹）与 Q5（无工具同样强制先实证及 `scratch` 位置）均已拍板定稿。

## 澄清与补充记录

- `2026-11-19`：明确 `C3` 所有 `dev-review` 实证上下文改造全部集中在 `review-context.mjs` (new) 与对应评审脚本中，绝不碰触 `C4` 的 `review-diff.mjs`。

## 完成后的记录

- 待实施、验证与合并后补全 PR 号、最终 `HEAD` SHA 与三场景及自举 `docs/feature-map.json` 校验报告。
