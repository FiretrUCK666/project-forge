---
kind: todo
title: 写操作路径改用 probeForWrite 与静态门禁全覆盖
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 62
pr: null
branch: feat/probe-for-write
owner: plan-62
approved: false
done_at: null
task_id: issue-62
planned_at: ba4de9c66d20451d8daf6e9f310553ec68fb3258
related_prd: null
related_spec: ../specs/261118-issue62-probe-for-write-spec.md
---

# 写操作路径改用 probeForWrite 与静态门禁全覆盖

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | `feat/probe-for-write` @ `ba4de9c` |
| 任务编号 | `issue-62` |
| 负责人 / 审批 | plan-62 / `false` |
| 关联 Issue / PR / SPEC | #62 / 未关联 / [261118-issue62-probe-for-write-spec.md](../specs/261118-issue62-probe-for-write-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-flow/scripts/flow-batch.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-sync.mjs`、`kit/skills/dev-govern/scripts/govern-state.mjs`、`kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/lib/shared.mjs`、`.agents/skills/`、`scripts/dev/write-probe-audit.mjs`(new)、`scripts/dev/preflight-suite.mjs`、`scripts/dev/fixtures-handoff-review.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`kit/skills/lib/platform.mjs`（`probeForWrite`、`probeGitHubEnv`）、`kit/skills/lib/static-gates-lexer.mjs`（`stripCodeCommentsLines`）、`scripts/dev/fixtures-helpers.mjs`
- **本期不做**：不修改 `probeGitHubEnv` 默认 `probeNetwork = false` 惰性只读语义；不新增非 GitHub 平台适配器；不改变 `delegatedPayloads` 或 `BLOCKED_*` 错误码结构
- **门型与回滚路径**：one-way；触及 `kit/` 高风险路径与自用门禁，出现异常直接 `git revert` 并重跑 `node scripts/equip.mjs .`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。编号与 SPEC 保持 1:1 对齐。

- [ ] C1: 写与同步调用点全部切至 `probeForWrite` 且文件行数合规。`kit/skills/dev-review/scripts/review-ledger.mjs`（`syncReviewToGitHub`）、`kit/skills/dev-flow/scripts/flow-batch.mjs`（`handleMergeQueue`）、`kit/skills/dev-flow/scripts/flow-inspect.mjs`（`handleStart --create-issue` 分支）与 `kit/skills/dev-govern/scripts/govern-state.mjs`（`applyGitHubIssues`）全部改为调用 `probeForWrite(...)`；`kit/skills/dev-govern/scripts/govern-audit.mjs` 透传 `_ghProbe`/`_ghClient`；`kit/skills/lib/shared.mjs` 导出 `probeForWrite`；`kit/skills/dev-flow/scripts/flow-sync.mjs` 在 `canQueryGh && (opts._ghProbe || opts._ghClient || opts['probe-auth'] || ledger.prNumber || ledger.parentPrNumber)` 时触发 `probeForWrite`；`flow-inspect.mjs` 只读 `inspectWorkspace` 维持 `probeNetwork: Boolean(opts.probeAuth)`；所有改动文件均保持 `<= 800` 行，且 `node scripts/equip.mjs . --check` 退出 `0`。
- [ ] C2: 真实联网探测运行时正反双向夹具实证（不传 `_ghProbe`/`_ghClient`）。在 `scripts/dev/fixtures-handoff-review.mjs` 中以 `PF_NO_REAL_AUTH_PROBE=0`、清空 `GH_TOKEN`/`GITHUB_TOKEN` 与临时 `PATH` 假 `gh` 验证四处入口：正向（`gh auth status` 返回已登录）四者均进入 `tier === 'gh-cli'` 并实际执行写/查子命令；反向（`gh auth status` 失败或无凭据）`review-ledger` 返回 `offlineOrNoCreds: true` 与完整 `delegatedPayloads`、`flow start --create-issue` 返回 `ACTION_REQUIRED_CREATE_ISSUE_DELEGATED`（退出码 `4`）、`govern-state` 返回 `gh CLI / GitHub token` 错误、`flow-batch` 不虚报 PR 合并成功；`node scripts/dev/fixtures.mjs --only 写操作必须联网探通道` 退出 `0`。
- [ ] C3: 全量 `kit/skills/` 静态门禁与 `preflight` + `fixtures` 双端阻断。`scripts/dev/write-probe-audit.mjs`(new) 复用 `stripCodeCommentsLines` 导出 `scanKitWriteProbeViolations` 与 `collectKitWriteProbeTargets`，在 `scripts/dev/preflight-suite.mjs`（`checkKitWriteProbes`）与 `scripts/dev/fixtures-handoff-review.mjs` 双端运行；对真实 `kit/skills/` 扫出 `0` 违规，对键序倒置/多行 `probeGitHubEnv`、`probeNetwork: false`、缺 `probeForWrite` 或仅注释出现 `probeForWrite` 的合成反面样本全部精准拦截，且不误报只读 `probeNetwork: Boolean(opts.probeAuth)`；`node scripts/dev/preflight.mjs` 退出 `0`。
- [ ] C4: 故障注入自证与合前全量门禁通过。在 `scripts/dev/injections-data.mjs` 新增 `I145`（不占用 `I139..I144`），验证退回裸 `probeGitHubEnv` 后运行 `scripts/dev/verify-injections.mjs`（`--only I145`）退出 `0`；`node scripts/dev/preflight.mjs`、全量 `scripts/dev/fixtures.mjs`、`node scripts/equip.mjs . --check` 与 `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --strict` 均退出 `0`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 落地 `scripts/dev/write-probe-audit.mjs`(new) 并接入 `preflight-suite.mjs` 与 `fixtures-handoff-review.mjs`，先补 Red 失败测试与双向合成夹具 | `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs --only 写操作必须联网探通道` 在未改 `kit/` 前必须红（抓出 4 处裸调用） | 规划已批准 |
| 2 | 修改 `review-ledger.mjs`、`flow-batch.mjs`、`flow-inspect.mjs`、`flow-sync.mjs`、`govern-state.mjs`、`govern-audit.mjs`、`shared.mjs`，运行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 并核查各文件 `<= 800` 行 | `node scripts/dev/preflight.mjs`、`node scripts/equip.mjs . --check` 与 `node scripts/dev/fixtures.mjs --only 写操作必须联网探通道` 变绿 | 步骤 1 |
| 3 | 在 `scripts/dev/injections-data.mjs` 登记 `I145` 并跑故障注入及全量门禁 | `scripts/dev/verify-injections.mjs`（`--only I145`）与全量门禁全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`进行中`（SPEC/Todo 草案待独立 Critique 与批准）
- **待拍板事项**：无
- **下一步第一件事**：完成独立 Critique (`critique-pass`) 与 `approve` 后按步骤 1 先跑 Red 门禁。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
