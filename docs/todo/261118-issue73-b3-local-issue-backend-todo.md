---
kind: todo
title: v9 B3：无远端本地工单全生命周期闭环与非交互 Git 防护
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 73
pr: null
branch: null
owner: "plan-stage-b"
approved: false
done_at: null
task_id: b3-local-issue-backend
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_spec: ../specs/261118-issue73-b3-local-issue-backend-spec.md
---

# v9 B3：无远端本地工单全生命周期闭环与非交互 Git 防护

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | 待启动 Wave 3 左列认领 @ `0aa2068` |
| 任务编号 | `b3-local-issue-backend` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#73` / 未关联 / [B3 SPEC](../specs/261118-issue73-b3-local-issue-backend-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC；启动前确认 Wave 1 (`B1` `#71`) 与 Wave 2 (`B2` `#72`) 已合入 `main`（本片与 Wave 3 右列 `B4a` `#74` 源码写域 0 重叠，可并行开发）。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/local-issues.mjs` (new)、`kit/skills/lib/task-backend.mjs`、`kit/skills/lib/exec.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/session-orient.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs` (new)、`kit/skills/dev-flow/scripts/flow-context.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-sync.mjs`、`kit/skills/dev-flow/scripts/flow-trial-merge.mjs`、`kit/skills/dev-review/scripts/review-sync.mjs` (new)、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-govern/scripts/govern-state.mjs`、`kit/skills/dev-govern/scripts/govern-tests.mjs`、`scripts/lib/render.mjs`、`scripts/lib/survey-questions.mjs`、`scripts/compose-agents.mjs`、`scripts/equip.mjs`、`scripts/dev/preflight-suite.mjs`、`scripts/dev/injections-data-gates.mjs`、`scripts/dev/fixtures-stageb-loop.mjs` (new)
- **复用既有模块**：`kit/skills/lib/git.mjs`、`kit/skills/lib/git-fast.mjs`、`kit/skills/lib/platform-probe.mjs`、`scripts/dev/write-probe-audit.mjs`
- **本期不做**：不触摸 `B4a` 写域中的 `survey-*`/`doc-shape`/`repo-map`/`SKILL.md`；不引入多轮停损与总控自动收口（留待 `B4b`）
- **门型与回滚路径**：`one-way`；合入前可直接废弃隔离工作树，合入后单次反向提交并重跑 `equip.mjs .` 与 `merge-gate`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C7: 新增 `kit/skills/lib/local-issues.mjs` (new) 写入 `<effectiveGitDir>/project-forge-flow/issues/`；`TASK_BACKEND_METHODS` 扩至 16 方法；`LocalOnlyBackend` 声明 `issues: true`/`labels: true` 持久化评论、标签与关单态；消除 `.git/pf-local-mode` 粘滞锁定并让 `compose-agents.mjs` `hasRemote` 尊重有效 `localMode`（同时保留空/`readonly-override` 兼容 `fixtures-claims`）。
- [ ] C8: 打通 `flow-issues.mjs` (new)（含 `migrate`）、`flow-context.mjs`（`findMatchingDocStrict` 支持 frontmatter `issue` 兜底匹配预建规划单）、`flow-inspect.mjs`（含远端漂移提示与拆分 `<= 680` 行）、`flow-merge.mjs`、`flow-next.mjs`、`review-sync.mjs` (new)（`review-ledger.mjs <= 600` 行，同步 `I145`）、`session-orient.mjs` 与 `govern-state.mjs`/`govern-tests.mjs` 在无远端与切回远端全闭环，通过 `write-probe-audit.mjs` 0 违规；`exec.mjs` 与 `flow-sync`/`flow-merge`/`flow-trial-merge` 补齐 `GIT_EDITOR=true` 非交互保护。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 拆减 `flow-inspect.mjs`（迁入 `flow-context.mjs` 并加 `issue` 兜底）与 `review-ledger.mjs`（抽离 `review-sync.mjs` (new) 并更新 `injections-data-gates.mjs` `I145`），并在 `exec.mjs` + `preflight-suite.mjs` 加入 `GIT_EDITOR` 对拍 | `node scripts/dev/preflight.mjs` 与 `verify-injections.mjs --only I145` 通过 | `#71`、`#72` 已合入 `main` |
| 2 | 实现 `local-issues.mjs` (new)、16 方法 `TaskBackend`、`flow-issues.mjs` (new) 含 `migrate`、`review-sync.mjs` (new) 及 `pf-local-mode` 平滑迁移 | `fixtures-stageb-loop.mjs` `C7`、`C8` 正反用例全绿且 `write-probe-audit.mjs` 0 违规 | 步骤 1 |
| 3 | 若平行列 `B4a` 先合入，执行 rebase 并运行 `node scripts/equip.mjs .` 重算 `.pf-manifest.json`，跑全量 `merge-gate` | 全量门禁全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 新增写接口触发 `write-probe-audit` 门禁阻断 | `flow-issues.mjs` (new) 或 `review-sync.mjs` (new) 调用远端写方法前未调 `probeForWrite` | 在非 `local-only` 分支显式前置 `probeForWrite` 并由 `preflight.mjs` 静态检查 |
| 误把 `fixtures-claims` 的 `.git/pf-local-mode` 测试破坏 | 无条件忽视空文件 `pf-local-mode` | 仅对含 `{ mode: "no-remote" }` 标记在出现远端时失效；空文件及 `readonly-override` 仍锁死 `local-only` |
| 与并行切片 `B4a` 共享 `.pf-manifest.json` 冲突 | 双方先后改 `kit/skills/` 文件 | 后合入者执行 `GIT_EDITOR=true git rebase` 后运行 `node scripts/equip.mjs .` 自动刷新 |

## 回滚预案

- **出问题时的第一步**：检查 `<effectiveGitDir>/project-forge-flow/issues/` 与测试仓 `.git/pf-local-mode` 状态并保留样本。
- **回滚用什么**：`git revert` 反向提交并重跑 `equip.mjs .`、`write-probe-audit.mjs` 与 `fixtures.mjs`。
- **回滚之后要做什么**：在 `#73` 评论补充复现环境与退出码。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 并行协同切片 `B4a` | 保持与 `B4a`（`#74`）源码写域 0 重叠，先合入者合后后合入者同步 `.pf-manifest.json` | Wave 3 并行阶段 | `B4a` 实施者 / `coordinator` |
| 独立代码审查人 | 核验 `C7`、`C8`、`write-probe-audit` 与本地迁远端全闭环并合入 | `submit` 提审后 | `review` 子代理 |

## 断点与遗留决策

- **当前状态**：`待 Wave 3 启动`（依赖 `#71`、`#72` 先行合入）
- **待拍板事项**：无
- **下一步第一件事**：Wave 3 启动后执行 `flow.mjs start --task b3-local-issue-backend --issue 73 --case 4` 进入 `.worktrees/impl-b3-local-issue-backend`。

## 澄清与补充记录

- （已合并协调者 #187 补充：解决无远端起步后新增 `origin` 的 `.git/pf-local-mode` 粘滞锁定、残余工单 `migrate` 与运行态漂移提示）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
