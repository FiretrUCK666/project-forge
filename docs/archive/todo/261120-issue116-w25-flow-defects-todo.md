---
kind: todo
title: 流程缺陷收口实施清单：引用成一等对象、降级显式报出、未适用独立成档
status: done
created: 2026-11-20
updated: 2026-11-21
issue: 116
pr: null
branch: fix/w25-flow-defects
owner: impl-116
plan_mode: interactive
approved: false
done_at: 2026-11-21
task_id: w25-flow-defects
planned_at: null
related_prd: ../../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue116-w25-flow-defects-spec.md
depends_on: []
scope_files: [kit/skills/lib/github-parse.mjs, kit/skills/lib/cli.mjs, kit/skills/lib/session-orient.mjs, kit/skills/lib/empirical-artifacts.mjs, kit/skills/lib/doc-slice-graph.mjs, kit/skills/dev-flow/scripts/flow-intake.mjs, kit/skills/dev-flow/scripts/flow-batch.mjs, kit/skills/dev-flow/scripts/flow-merge.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow.mjs, kit/skills/dev-iterate/scripts/iterate-cycle.mjs, kit/skills/dev-plan/scripts/doc-audit-repo.mjs, kit/skills/dev-plan/scripts/doc-audit.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-review/scripts/review-empirical.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-ledger.mjs, kit/skills/dev-review/scripts/review-locks.mjs, scripts/equip.mjs, scripts/survey.mjs, scripts/lib/agents-defaults.mjs, scripts/lib/equip-bootstrap.mjs, scripts/lib/merge3.mjs, scripts/dev/fixtures-docs.mjs, scripts/dev/fixtures-flow-defects.mjs, scripts/dev/fixtures-empirical-cycle.mjs, scripts/dev/fixtures-plan-wave-slices.mjs, scripts/dev/fixtures-review-empirical.mjs, scripts/dev/injections-data-flow-defects.mjs, scripts/dev/injections-data-gates.mjs, docs/TDD.md]
---

# `w25-flow-defects` 实施 Todo（Issue `#116`）

> 对应 SPEC：[flow-defects SPEC](../specs/261120-issue116-w25-flow-defects-spec.md)
>
> **基线**：`a0fe4df`。本切片无前置，可立即开工。

## 一、要做什么

<!-- section: goal -->
把这些「静默」改成「如实说出」，并让引用在整条链上不失真：

- **引用**：解析处保留目标仓与原始串；写操作前先判目标仓唯一性；两条入口共用一份判定。
- **报出**：校验拒绝给修法；写入产生待裁决冲突不得退 0；路径先归一再解析；三个输入通道的丢弃、失败与截断全部显式。
- **判据独立**：起步态与纯文档项目各自独立判定，不再互相推导。
- **未适用**：零目标范围的审计与门禁报「未适用」并返回非零，不得折成通过。

## 二、不做什么

<!-- section: non-goals -->
不改受管区间与手写区边界；不改真幂等与写前快照；不改停损机制本身；不改工作树清理的确认闸与依赖解绑顺序；不新增关掉检查的开关；不改 `edit-gate.mjs` 无目标退出码；不重做 `flow.mjs --help` 帮助结构；不碰 `docs/archive/`。

不以任何形式打补丁：不加条件挡住「不认识」的输入、不用重试掩盖解析失败、不留「空集也算通过」的软通道。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [x] **T1（`C1` 引用一等对象）**：`github-parse.mjs` 的完整引用入口提升为基础实现（`parseFlowInputs`），`judgeCrossRepoReference` 做三态判定；`flow-intake.mjs` 复用同套解析与跨仓写阻断。
- [x] **T2（`C2` 拒绝带修法 + 两路径同结论）**：`scripts/lib/merge3.mjs` 抽六值封闭枚举；`scripts/equip.mjs` 校验与写入两条路径共读该判定，非同步非豁免均退 `3` 并给出三种合法处置。
- [x] **T3（`C3` 纯文档判据与起步提交）**：`survey.mjs` 用 `isDocsOnlyByDocuments` 判纯文档并在零提交时报「尚未首次提交」；`scripts/lib/equip-bootstrap.mjs`（`createFirstCommit`）落首次提交；`scripts/lib/agents-defaults.mjs` 将 `unknown`+0 代码收口为 `Dev Profile: none`。
- [x] **T4（`C4` 定位点、三态收口与三通道告警）**：`review-locks.mjs` 归一路径分隔符并支持中文行号，`sameBlockerItem` 按行区间相交去重；`review-ledger.mjs` 落 `unmentionedFromPrev` 三态收口；`iterate-cycle.mjs` 三通道进 `warnings` 不改语义。
- [x] **T5（`C5` 输出降级、零工作量与回告真实性）**：`flow.mjs` 正文列出 `inputs.unknown`；`flow-batch.mjs` 零工作量不落盘；`cli.mjs` 与 `session-orient.mjs` 同步降级正文命令；`flow-merge.mjs` `judgeCommentOutcome` 显式报未发出与补发命令。
- [x] **T6（`C6` 未适用独立成档）**：`doc-audit-repo.mjs` 在零目标或非受管文档时返回 `applicable: false` 并区分 `none`/`unmanaged`，`doc-plan.mjs` 返回非零退出码。
- [x] **T7（`C7` 与 `#113` 对齐）**：交集文件（`flow-batch`/`intake`/`merge`/`flow`、`doc-plan`、`review-ledger`/`locks`、`fixtures-docs.mjs`、`docs/TDD.md`）保留 `#113` 与 `#116` 双方完整逻辑并全绿。
- [x] **T8（夹具与故障注入）**：新增 `scripts/dev/fixtures-flow-defects.mjs`（16 条双向断言）与 `scripts/dev/injections-data-flow-defects.mjs`（`I310–I316`），并更新 `scripts/dev/injections-data-gates.mjs`（`I131`）。
- [x] **T9（行数核对）**：逐文件核对所有 `.mjs <= 800` 行（含 `flow-lifecycle.mjs` 787 行、`scripts/equip.mjs` 781 行）。
- [x] **T10（同步）**：`kit/` 改动后重跑 `node scripts/equip.mjs .` 刷新镜像；同步 `docs/TDD.md`。
- [x] **T11（`C8` Wave 2 五处遗留缺陷修复）**：修复 `review-empirical.mjs`/`review-pack.mjs`（`workspaceFingerprint`、结构化返回值与账本实证回查）、`flow-lifecycle.mjs`（`isExplicitNone` 透传与阻断、`hasVisualCheckFlag` 补全、precheck `reason`/`errors`）、`flow-lifecycle-helpers.mjs`/`empirical-artifacts.mjs`（`visual.headSha` 与 `sameClean` 合并过滤）、`doc-audit-repo.mjs`/`doc-slice-graph.mjs`（单源切片图覆盖与活跃 SPEC 过滤），并在 `fixtures-review-empirical.mjs`、`fixtures-empirical-cycle.mjs`、`fixtures-plan-wave-slices.mjs` 补齐正反双向夹具。

## 四、验收与合前检查

- [x] `node scripts/dev/fixtures.mjs --domain flow-defects` 与 `--domain review-empirical`/`empirical-cycle`/`plan-wave-slices` 全绿。
- [x] 对零目标范围执行审计，退出码非零且输出含「未适用」。
- [x] 本地有同号单据时跨仓引用被阻断，写操作未发生。
- [x] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs --jobs 4` 全绿。
- [x] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [x] 改动未触及并行切片禁碰写域外无关文件（`workflow-policy.mjs`、`workflow-helpers.mjs`、`git-core.mjs`、`git-status-fast.mjs`、`bench.mjs`）。
- [x] `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit docs/archive/specs/261120-issue116-w25-flow-defects-spec.md --json` 与 `audit docs/archive/todo/261120-issue116-w25-flow-defects-todo.md --json` 返回 `ok: true`。

## 完成后的记录

- 完成日期: 2026-11-21
- 分支: fix/w25-flow-defects
- 实施与验证: `#116` 流程缺陷收口 + Wave 2 五处遗留缺陷同分支修复完成，`merge-gate.mjs` 12/12 全过、`verify-injections.mjs --jobs 4` 294/294 全过。
