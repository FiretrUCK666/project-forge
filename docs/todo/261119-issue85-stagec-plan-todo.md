---
kind: todo
title: "Stage C（v10）全套规划文档起草、写域审计与提交（#85）"
status: active
created: 2026-11-19
updated: 2026-11-19
issue: 85
pr: null
branch: feat/docs-v10-统一8技能-dev-edit倒金字塔-dev-verify-tools-dev-iterate-全局分
owner: "plan-stage-c"
approved: false
done_at: null
task_id: stagec-plan
planned_at: "8566de3da467f5137f362ecad4323dbc093dca00"
related_prd: null
related_spec: null
---

# 任务清单：Stage C（v10）全套规划文档起草、写域审计与提交（#85）

## 文档信息与范围概览

- **任务编号**：`stagec-plan`（仅覆盖本次规划文档落地与提交闭环，`related_prd` 与 `related_spec` 故意置 `null`，确保后续合并本规划 PR 时仅归档本规划 Todo 而保留 Stage C 总控 PRD 与 `C1–C4` 设计/待办文件处于激活状态）
- **关联规划成品**：
  - [Stage C 总控 PRD](../prd/261119-v10-stagec-unified-architecture-prd.md)
  - [Stage C-1 SPEC](../specs/261119-v10-stagec-c1-unified-locate-intake-perf-spec.md) 与 [Stage C-1 Todo](../todo/261119-v10-stagec-c1-unified-locate-intake-perf-todo.md)
  - [Stage C-2 SPEC](../specs/261119-v10-stagec-c2-dev-edit-pyramid-govern-spec.md) 与 [Stage C-2 Todo](../todo/261119-v10-stagec-c2-dev-edit-pyramid-govern-todo.md)
  - [Stage C-3 SPEC](../specs/261119-v10-stagec-c3-dev-verify-tools-review-spec.md) 与 [Stage C-3 Todo](../todo/261119-v10-stagec-c3-dev-verify-tools-review-todo.md)
  - [Stage C-4 SPEC](../specs/261119-v10-stagec-c4-dev-iterate-evolution-e2e-spec.md) 与 [Stage C-4 Todo](../todo/261119-v10-stagec-c4-dev-iterate-evolution-e2e-todo.md)

## 任务范围与验证基准

- **修改范围**：仅限在隔离工作树内新增上述 10 份 Stage C `docs/` 规划文档；严禁修改任何源码、配置、`templates/`、`kit/` 或 Stage B 规划文件。
- **验证基准命令**：逐份与全量 `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit`、`node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs --domain doc-rules`、`node scripts/dev/fixtures.mjs --domain doc-depth`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --strict`。

### 不做什么（Non-Goals）

- 本规划任务不编辑任何 `.mjs` 运行时代码、`templates/`、`kit/`、`SKILL.md` 或 Stage B `261118-*` 规划文档。
- 本规划任务不自行执行 `critique-pass`、`approve`、提交 PR 或合入 `main`（交由协调者指派独立评审）。

## 验收标准与执行清单

<!-- criteria:start -->
- [ ] C1: 完成 Stage C 总控 PRD 与 `C1–C4` 切片全部 4 套 `SPEC + Todo`，冻结 `SC1..SC16`（映射 `C1..C16`）并保证 Wave C-1（`C1 || C2`）与 Wave C-2（`C3 || C4`）写域严格互斥且全部紧文件预设 `<= 730–800` 行拆分布局。
- [ ] C2: 全部新增文档逐份及全仓通过 `doc-plan.mjs audit`、`preflight.mjs`、`fixtures.mjs --domain doc-rules/doc-depth` 与 `govern-audit.mjs audit . --changed --strict`，且与已有 Stage B 文档共存零错误、零未封闭或孤儿切片。
- [ ] C3: 草案干净提交至 `.worktrees/impl-stagec-plan` 分支（不自做 critique/approve/submit），向协调者汇报完整文档清单与 `HEAD` SHA 供独立内审。
<!-- criteria:end -->

## 执行步骤

- [x] 1. 在 `.worktrees/impl-stagec-plan` 起草总控 PRD 与 `C1–C4` 切片 `SPEC + Todo` 共 9 份规划文档及本规划闭环 Todo。
- [ ] 2. 逐份及全仓库运行 `doc-plan.mjs audit`、`preflight.mjs`、`fixtures` 与 `govern-audit --changed --strict`，修正所有告警或边界问题。
- [ ] 3. 核验仅包含本次新增 `docs/` 规划文件后提交至当前隔离分支，向协调者汇报文档清单与 `HEAD` SHA。

## 风险与应对

- **与未合入 Stage B 基线文件共存校验**：对所有引用 Stage B 或 Stage C 尚未落盘的路径统一明确标注 `(new)` 与所属波次前提，确保当前与 `B5` 合并后两次审计均零错误。

## 回滚预案

- 纯文档新增分支，异常时可直接重置或弃置 `.worktrees/impl-stagec-plan` 分支，完全零影响 `main` 与运行态源码。

## 协作与依赖

- **前置输入**：已获批准总规划、阶段 B 检查清单与三份专项源码勘察结论；后续由独立 `critic-stage-c` 评审并在 `B5` 合入 `main` 后推进合并。

## 断点与遗留决策

- 无未决决策，等待本地审计全绿提交并汇报协调者指派独立内审。

## 澄清与补充记录

- `2026-11-19`：遵循 Stage B `#77`/`#83` 规划收口先例设置独立 `stagec-plan` 闭环清单，避免提前归档总控与子切片文件。

## 完成后的记录

- 待 `critic-stage-c` 独立内审与后续收尾归档时补全 PR 号与最终合并 SHA。
