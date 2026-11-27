---
kind: todo
title: 全仓脚本低 CPU 调度原语与热点瘦身
status: done
created: 2026-11-27
updated: 2026-11-27
issue: 227
pr: null
branch: feat/low-cpu-script-perf
owner: plan-c-master
plan_mode: interactive
approved: false
done_at: 2026-11-27
task_id: low-cpu-script-perf
planned_at: 7785ef3c55cb5251cbca39c6b312b414ab4841f5
related_prd: ../../prd/261127-issue227-multi-forge-worktree-perf-v1-prd.md
related_spec: ../specs/261127-issue227-low-cpu-script-perf-spec.md
---

# 全仓脚本低 CPU 调度原语与热点瘦身

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/low-cpu-script-perf` @ `7785ef3` |
| 任务编号 | `low-cpu-script-perf` |
| 负责人 / 审批 | plan-c-master / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | #227 / 未关联 / `docs/archive/specs/261127-issue227-low-cpu-script-perf-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC 审批状态。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/proc-budget.mjs` (new)、`kit/skills/lib/git-fast-objects.mjs`、`scripts/sync-toc.mjs`、`scripts/update.mjs`、`scripts/dev/verify-injections.mjs`、`scripts/dev/fixtures.mjs`、`scripts/dev/fixtures-helpers.mjs`、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/merge-gate.mjs`、`scripts/dev/preflight-e2e.mjs`、`kit/skills/dev-iterate/scripts/iterate.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`、`kit/skills/dev-govern/scripts/govern-audit.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/survey.mjs`、`scripts/dev/fixtures-perf-budget.mjs` (new)、`scripts/dev/injections-data-perf-budget.mjs` (new)
- **复用既有模块**：`kit/skills/lib/git-fast-objects.mjs`（`readGitBlobTextFast`）、`kit/skills/lib/git-index-fast.mjs`（`readGitIndexPathsFast`）、`scripts/dev/preflight-e2e.mjs`（`SMOKE_CHILD_CODE` 隔离范式）
- **本期不做**：不触碰多平台注册表/网络层（Wave 1B）、不触碰 Worktree 依赖池与策略层（Wave 2）、不放宽任何既有测试或门禁断言
- **门型与回滚路径**：`one-way`（高风险路径 `kit/`、`scripts/lib/`）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [x] C1: `kit/skills/lib/proc-budget.mjs` (new) 导出 `resolveWorkerConcurrency`（默认 `max(1, availableParallelism() - 2)` 且 `--jobs` 可显式覆盖，1-2 核退化为 `1`）与 `applyLowPriority(pid)`（调用 `os.setPriority(..., PRIORITY_BELOW_NORMAL)` 且对权限/非法 PID 异常安全兜底），并在 `scripts/dev/verify-injections.mjs`、`scripts/dev/fixtures.mjs`、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/merge-gate.mjs` 与 `kit/skills/dev-iterate/scripts/iterate.mjs` 全部接入生效。
- [x] C2: `scripts/dev/fixtures.mjs` 实现 `--only` 跨文件 `import` 闭包预筛懒加载 + `--domain` 单域懒加载且 0 命中自动回退全量导入（实测冷启显著低于全量 325 ms 基线并逼近 ~15 ms，且跨文件引用与动态名用例 0 漏检）；`scripts/dev/fixtures-helpers.mjs` 补齐 `IN_PROCESS_CLI_SCRIPTS` 覆盖 `verify-tools.mjs`/`doc-locate.mjs`/`edit-gate.mjs`/`iterate.mjs`/`equip-ci.mjs` 并兼容 `mod.runCli ?? mod.main`；`scripts/sync-toc.mjs` 与 `scripts/update.mjs` 导出 `runCli` 且 `scripts/dev/preflight-e2e.mjs` `checkHelps` 以单子进程完成 8 个脚本 `--help` 校验。
- [x] C3: `kit/skills/lib/git-fast-objects.mjs` 新增 `readBlobBatch` 供 `kit/skills/dev-edit/scripts/edit-gate.mjs`（行数净减至 `<= 755` 行）与 `kit/skills/dev-govern/scripts/govern-checks.mjs` 复用，`govern-audit.mjs` 透传 `trackedSet` 给 `govern-checks-hygiene.mjs`，`scripts/lib/survey-workspace.mjs`/`scripts/survey.mjs` 消除同步 `git check-ignore` 阻塞；新增 `scripts/dev/fixtures-perf-budget.mjs` (new) 与 `scripts/dev/injections-data-perf-budget.mjs` (new) 正反双向实证通过，`node scripts/dev/bench.mjs`、`node scripts/dev/preflight.mjs`、`node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全部退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写失败回归测试 `scripts/dev/fixtures-perf-budget.mjs` (new)（核数预留、`--jobs` 覆盖、低优先级兜底、`--only` 闭包与 0 命中回退、`--domain` 懒加载、`mod.main` 进程内执行与 `readBlobBatch`） | `node scripts/dev/fixtures.mjs --domain perf-budget` 必红 | 切片获批 |
| 2 | 实现 `kit/skills/lib/proc-budget.mjs` (new) 并接入 5 个并发入口，落地 `fixtures.mjs`、`fixtures-helpers.mjs`、`sync-toc.mjs`/`update.mjs` `runCli` 与 `preflight-e2e.mjs` 单子进程 `checkHelps` | `node scripts/dev/fixtures.mjs --domain perf-budget` 与 `node scripts/dev/preflight.mjs` 全绿 | 步骤 1 |
| 3 | 下沉 `readBlobBatch` 至 `kit/skills/lib/git-fast-objects.mjs`，改造 `edit-gate.mjs`（净减至 `<= 755` 行）、`govern-checks*.mjs`、`govern-audit.mjs` 与 `survey-workspace.mjs`/`survey.mjs` | `node scripts/dev/bench.mjs` 与 `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json` 全绿 | 步骤 2 |
| 4 | 补齐故障注入 `scripts/dev/injections-data-perf-budget.mjs` (new)，同步 `node scripts/equip.mjs .` 并跑通全量验证 | `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0` | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（已按 R1 独立审查意见修订完毕，待 R2 独立 Critique 与维护者 `approve` 后开工）
- **待拍板事项**：无
- **下一步第一件事**：完成 R2 独立 Critique 与 `approve` 后，先建失败测试 `scripts/dev/fixtures-perf-budget.mjs` (new) 再落地 `kit/skills/lib/proc-budget.mjs` (new)。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .` -> 175 文件字节级同步通过，ABI/语法零报错。
  - `node scripts/dev/fixtures.mjs --domain perf-budget` -> 7/7 PASS；全量 `fixtures.mjs` -> 627/627 PASS。
  - `node scripts/dev/verify-injections.mjs --only I1031,I1032,I1033,I1034,I1035,I1036,I1037 --jobs 4` -> 7/7 命中；全量 `verify-injections.mjs --jobs 4`（含在 `merge-gate.mjs` 第 6 步）-> 510/510 命中退出码 `0`。
  - `node scripts/dev/merge-gate.mjs` -> 12/12 步全绿 `passed`（退出码 `0`）。
  - `node scripts/dev/bench.mjs` -> 6/6 全绿：`survey(self)` 376ms -> 348ms，`review(self)` 554ms -> 461ms（`-16.8%`），`preflight(self)` 2782ms -> 2694ms；`fixtures --only` 冷启 397ms -> 171ms（`-56.9%`），`--domain` 369ms -> 136ms（`-63.1%`）。
- **文档同步检查**：已更新本切片 SPEC/Todo（保留 1:N 总控 PRD 留待 Wave 3 终态收口）；`.agents/skills/` 已与 `kit/skills/` 字节级同步。
- **遗留问题**：无。
