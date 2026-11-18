---
kind: todo
title: v9 B2：平台分支保护能力（开关 A）与跨宿主 .githooks/pre-push
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 72
pr: null
branch: null
owner: "plan-stage-b"
approved: false
done_at: null
task_id: b2-branch-protection-hooks
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_spec: ../specs/261118-issue72-b2-branch-protection-hooks-spec.md
---

# v9 B2：平台分支保护能力（开关 A）与跨宿主 .githooks/pre-push

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | 待启动 Wave 2 认领 @ `0aa2068` |
| 任务编号 | `b2-branch-protection-hooks` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#72` / 未关联 / [B2 SPEC](../specs/261118-issue72-b2-branch-protection-hooks-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC；启动前确认 Wave 1 (`B1` `#71`) 已合入 `main`。

## 任务范围与验证基准

- **影响路径**：`scripts/lib/platform/registry.mjs`、`scripts/lib/platform/github.mjs`、`scripts/lib/platform/github-client.mjs`、`kit/skills/lib/platform.mjs`、`scripts/lib/survey-questions.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/lib/artifact-executors.mjs`、`scripts/lib/render.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/lib/review-helpers.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/equip-ci.mjs`、`scripts/equip.mjs`、`scripts/survey.mjs`、`scripts/review.mjs`、`templates/githooks-pre-push.sh` (new)、`references/remote-github.md`、`references/version-control.md`、`scripts/dev/injections-data-core.mjs`、`scripts/dev/injections-data-gates.mjs`、`scripts/dev/fixtures-stageb-onboarding.mjs` (new)
- **复用既有模块**：`scripts/lib/platform/github-client.mjs`、`scripts/lib/survey-gap-rules.mjs`、`kit/skills/lib/profile.mjs`
- **本期不做**：不默认请求 `required_approving_review_count >= 1`；不修改本地工单后端或非 GitHub 适配器；不覆盖已有 `.husky/`/`lefthook`
- **门型与回滚路径**：`one-way`；合入前丢弃分支，合入后单提交 `git revert` 并重跑 `equip.mjs .` 与 `merge-gate`
- **快测命令**：`node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C4: `HostingProvider.capabilities` 三端对齐新增 `branchProtection` 并在 `survey.mjs` 输出；`github-client.mjs` 新增 `getBranchProtection` 与 `applyBranchProtectionSwitchA` 仅推开关 A（载荷禁含 `required_approving_review_count >= 1`），遇 `403` 返回 `{ ok: false, fallbackToHooks: true }`。
- [ ] C5: `survey-questions.mjs` 新增 `q.branch-protection` 接入 `render.mjs` 与 `--bootstrap-empty`（`generic-git` 过 `checkPlatformLock`），`## 取舍` 写 `branch-protection`/`no-branch-protection` 后不再重复提问，`equip-ci.mjs --protect-branch` 在非 GitHub 仓安全退出 `0`。
- [ ] C6: `equip.mjs --with-hooks` 从 `templates/githooks-pre-push.sh` (new) 安装跨宿主 `.githooks/pre-push` 并配局部 `core.hooksPath`（冲突时 `preserve`），无冲突且未写 `no-git-hooks` 时 `S3` 推荐自动带上 `--with-hooks`；拦默认分支直推并打印 `[NEXT STEP]`，放行全零删分支与 `PF_ALLOW_DIRECT_PUSH=1`；`gap-coverage.mjs` 全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 迁出 `review.mjs` 非 `GAP` 辅助至 `review-helpers.mjs`，压至 `<= 660` 行并同步更新 `injections-data-core.mjs` (`I22c`) 与 `injections-data-gates.mjs` (`I120`) | `node scripts/dev/gap-coverage.mjs`、`review.mjs .` 与 `verify-injections.mjs --only I22c --only I120` 通过 | `#71` 已合入 `main` |
| 2 | 三端对齐 `branchProtection`，实现开关 A API、`--protect-branch`、`templates/githooks-pre-push.sh` (new) 与 `--with-hooks` 推荐逻辑 | `fixtures-stageb-onboarding.mjs` 中 `C4–C6` 双向断言由红转绿 | 步骤 1 |
| 3 | 同步 `.agents/skills/`（`equip.mjs .`）、更新两份 `references/` 并跑通全量 `merge-gate` | 全量门禁全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `pre-push` 误拦 `flow.mjs cleanup` 第 7 步远端删分支 | 未解析 stdin 四元组中全 40 位 `0` 的 `local_sha` | 在 POSIX 脚本显式放行全零 `local_sha` 并写正反夹具与实际 Git bare repo 测试 |
| `review.mjs` 迁出破坏 `gap-coverage.mjs` 扫描 | 把 `GAP_RULES` 对应 `finding(...)` 移离 `review.mjs` | 所有 `GAP_RULES` `finding` 调用原地保留在 `review.mjs` |

## 回滚预案

- **出问题时的第一步**：卸载本地异常测试工作树的 `.githooks` 或切回默认 `core.hooksPath`。
- **回滚用什么**：`git revert` 回退提交并重跑 `equip.mjs .` 与 `gap-coverage.mjs`。
- **回滚之后要做什么**：在 `#72` 评论注明失败分支与平台返回状态。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 独立代码审查人 | 复核开关 A 载荷、403 降级与 `pre-push` 实测并合入 | Wave 2 `submit` 后 | `review` 子代理 |

## 断点与遗留决策

- **当前状态**：`待 Wave 2 启动`（依赖 `#71` 先行合入）
- **待拍板事项**：无
- **下一步第一件事**：`#71` 合入后运行 `flow.mjs start --task b2-branch-protection-hooks --issue 72 --case 4` 启动隔离工作位。

## 澄清与补充记录

- （已落实 Q1 定稿：`equip.mjs --with-hooks` 为 opt-in 且遇既有钩子 `preserve`，无冲突且未写 `no-git-hooks` 时在 `S3` 推荐自动带上 `--with-hooks`）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
