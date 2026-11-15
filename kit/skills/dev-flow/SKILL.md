---
name: dev-flow
description: |
  统一驱动 Git 日常研发全流程：探测身份与凭据、按三档创建分支或 Worktree 并按子包挂载共享依赖、
  认领 Issue、成对归档文档同步锁、执行验证绑定 HEAD、推分支开 PR、返工、审查后合并与安全清理。
  触发词：修 bug、做功能、推代码、提 PR、开 PR、合并收尾、清 worktree、处理 Issue、
  审外部 PR、收到 Issue、收到 PR、fix bug、implement feature、create PR、merge PR、cleanup worktree。
---

# dev-flow：Git 研发协同与流转引擎

覆盖从收到需求 / Issue / PR 到分支隔离、验证提交、返工、合并与人类确认清理的全生命周期；除 `inspect`/`start` 外所有子命令均支持从当前 worktree/分支/唯一活跃账本自动推断 `--task`。

## 核心规则

1. **先 `next` / `inspect` 再动手**：`next [--probe-auth]` 统一路由 `idle` / `ambiguous` / 唯一合法下一步并按需从远端 `pf-state` 重建状态；`inspect` 识别身份（`local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `inbound-external-pr` / `generic-git`）；撞见 `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 冲突态一律阻断。
2. **只读克隆不冒推**：遇到 `clone-readonly` 必须停下让用户三选一（`--clone-choice fork|standalone|local`）。
3. **全量 Worktree 隔离、跨轮复用与防毒化共享依赖**：
   - 有历史提交仓（`commits > 0`）无论 Case 1/2/3/4 **一律**入第 2 档 `.worktrees/impl-<id>`（含分支冲突拦截）；仅 0 提交非并行仓允许原地第 1 档分支；第 3 档外部 PR (`--external-pr <M>`) 入 `.worktrees/review-pr-<M>`，未过静态投毒扫描前绝不挂载依赖或跑脚本。
   - 跨轮复用同一 `impl` / `review` 槽；推进 `review-<id>` 时自动 `unmountSharedDeps` -> 同步 `HEAD` -> 重挂载依赖，提供 `--reset-review-slot` 清理审查位脏状态。Case 2/3/4 单任务在隔离 `impl` 位派发 `impl` 子代理实施。
4. **文档双锁、1:N 总控 PRD 保护与防旁路分层 `evidence.json`**：
   - `finalize` 校验未勾 `[ ]` 并成对归档 `PRD/SPEC/Todo` 至 `docs/archive/`（`isSharedMasterPrd` 自动识别 `1:N` 总控 PRD 保留在 `docs/prd/` 维持 `active` 并重算子文档 `related_prd`）；支持返工阶段幂等刷新 `finalizedHead`；检查 `docs/TDD.md` 同步。
   - `verify` 写入 `<gitCommonDir>/project-forge-flow/tasks/<id>/evidence.json` 严格分级证据，尊重 `Dev Profile` 显式 `none`；`submit`/`merge` 现场按 `low`/`medium`/`high` 三正交策略核验，`quick --target` 仅算局部通过绝不顶替全量门禁，无 CI 低风险纯文档变更须通过独立 `runLowRiskDocStaticCheck` 静态必检。
5. **谁改谁提 PR（协调者不代提）、零脏文件提审、`generic-git` 禁强合、临时试合与 Squash 清理**：
   - **谁改代码谁认领并负责 `finalize`/`verify`/`submit` 与 PR/Issue 评论**（协调者只调度，传 `--agent` 为非原认领人或 `coordinator-*`/`reviewer-*` 触发 `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH`）；`submit` 推后零跟踪文件变脏，新建 PR 前先查重 OPEN PR 并套用 `.github/pull_request_template.md`。
   - `generic-git` 有远端禁本地强合并（退出码 `3`，需 `--remote-merged` 或 `--human-approved`）；本地合入须先在干净 `mainRoot` 创建 `.worktrees/.tmp-merge-*` `--detach` 试合复测再 `ff-only` / CAS `update-ref` 推进主干。
   - `merge` 强校 `verifiedHead === HEAD`、远端 CI 全绿及独立审查闭环（触发 `STOP_LOSS_ESCALATE` 或门禁弱化退出码 `4` 须 `--human-approved --reason`）；`cleanup` 兼容 Squash / 远端 `MERGED` 安全删除已合入本地分支（须 `--confirm` 并先 `unlinkSync` 解绑）。

## 标准命令流

```sh
# 1. 状态路由 / 身份与冲突探测
node ".agents/skills/dev-flow/scripts/flow.mjs" next [--task <id>] [--probe-auth] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" inspect [Issue/PR URL...] [--probe-auth]
node ".agents/skills/dev-flow/scripts/flow.mjs" status [--task <id>]

# 2. 启动或放弃隔离工作位（--after 支持堆叠子分支，--files 声明切片，--create-issue 自动建单）
node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug> --case <1..4> [--issue <N|URL>] [--pr <M|URL>] [--after <parent>] [--files a,b] [--external-pr <M|URL>]
node ".agents/skills/dev-flow/scripts/flow.mjs" sync [--task <id>] [--onto <branch>]
node ".agents/skills/dev-flow/scripts/flow.mjs" batch <plan|check-disjoint|merge-queue|resume-session> [--tasks <a,b>] [--enqueue <id>]
node ".agents/skills/dev-flow/scripts/flow.mjs" abort [--task <id>] [--confirm]

# 3. 认领（真账号防撞车，接管须带 --takeover --reason）/ 释放 / 文档锁与分层实证
node ".agents/skills/dev-flow/scripts/flow.mjs" claim [--issue <N|URL>] [--takeover --reason "<接管原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" release [--task <id>] [--reason "<释放原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" finalize [--strict-sync]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --tier quick [--target <file>]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode smoke|full|gate

# 4. 推送并同步审查槽 / 返工 / 最终审查者 PASS 后合并 / 人类确认清理
node ".agents/skills/dev-flow/scripts/flow.mjs" submit [--rework] [--reset-review-slot]
node ".agents/skills/dev-flow/scripts/flow.mjs" rework [--rebut "<findingId>: <reason>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" merge [--remote-merged] [--human-approved] [--reason "<原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm [--only-review-worktree|--keep-worktree] [--keep-local-branch] [--keep-remote-branch]
```
