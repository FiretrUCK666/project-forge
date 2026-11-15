---
name: dev-flow
description: |
  统一驱动 Git 日常研发全流程：探测身份与凭据、按三档创建分支或 Worktree 并按子包挂载共享依赖、
  认领 Issue、成对归档文档同步锁、执行验证绑定 HEAD、推分支开 PR、返工、审查后合并与安全清理。
  触发词：修 bug、做功能、推代码、提 PR、开 PR、合并收尾、清 worktree、处理 Issue、
  审外部 PR、收到 Issue、收到 PR、fix bug、implement feature、create PR、merge PR、cleanup worktree。
---

# dev-flow：实现 → 实证测试-形式验证 → 合入 状态机

承接 `dev-explore` 侦察事实与 `dev-plan` 已批准设计单，驱动 8 阶段闭环中**隔离实现、分层实证、提审与最终合入清理**，并向 `dev-review` 与 `dev-govern` 输出确定性证据；除 `inspect`/`next`/`start` 外所有子命令支持从当前 worktree/分支/唯一活跃账本自动推断 `--task`。

## 核心规则

1. **先 `next` / `inspect` 再动手（`TaskBackend` 抹平三态）**：
   - `flow.mjs next [--probe-auth]` 是跨会话唯一入口：离线/换机时自动从远端 `pf-state` 重建状态并给出唯一合法下一步、`worktreePath` 与阻塞原因；
   - `flow.mjs inspect [Issue/PR URL...]` 识别五态身份（`local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `inbound-external-pr` / `generic-git`），解析多 Issue `Depends on`/`Blocks` 拓扑序与已有 OPEN PR；遇 `clone-readonly` 必停让用户三选一（`--clone-choice fork|standalone|local`）；遇 Git 冲突态一律阻断。
2. **全量 Worktree 隔离、跨轮槽复用与防毒化共享依赖**：
   - 有历史提交仓（`commits > 0`）无论 Case 1/2/3/4 **一律**入第 2 档 `.worktrees/impl-<id>`（含分支占用与主仓脏改动拦截）；仅 0 提交非并行仓允许第 1 档本地特性分支；外部 PR（`--external-pr <M>`）入 `.worktrees/review-pr-<M>`，过 `--untrusted-scan` 前绝不挂依赖或执行脚本。
   - 每任务最多复用 1 个 `impl` 槽 + 1 个 `review` 槽；`submit`/`review-pack` 推进 `review-<id>` 时自动 `unmountSharedDeps` -> 同步 `HEAD` -> 重挂载依赖（`--reset-review-slot` 清理故障注入残留）。Case 2/3/4 单任务在隔离 `impl` 位派发 `impl` 子代理；多任务由 `batch plan`/`check-disjoint`/`merge-queue`/`resume-session` 与 `sync`（`--after` 堆叠 `rebase --onto`）协同。
3. **谁改谁认领、谁推送提 PR 与双写评论（协调者不代提）**：
   - **谁改代码谁在隔离 `impl` 位跑完 `claim` -> `finalize` -> `verify` -> `submit` 与 PR/Issue 评论**（协调者只负责调度派发与验收，不得代提 PR；`submit` 传非原认领人或 `coordinator-*`/`reviewer-*` 触发 `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH`）。接管须 `--takeover --reason` 双写 Issue+PR，弃领用 `release`。
4. **文档同步锁（`--include-master-prd`）与防旁路分层 `evidence.json`**：
   - `finalize [--strict-sync] [--include-master-prd]`：校验 `C1..Cn` 全勾 `[x]`、检查 `docs/TDD.md` 同步（`tdd-parity`）及 `AGENTS.md`「改哪看哪」联动，成对 `git mv` 归档至 `docs/archive/`（`isSharedMasterPrd` 默认保护 `1:N` 总控 PRD 维持 `active`；仅全量完结时传 `--include-master-prd` 检查总控勾选、保留原元信息一并归档并写 `archivedPrdFile`）；`contributor-fork` 且上游无 `docs/` 时私有草案隔离至 `.worktrees/.state/private-docs/`。
   - `verify --mode quick|smoke|full|gate`：写入 `<gitCommonDir>/project-forge-flow/tasks/<id>/evidence.json`（并向 `signals.jsonl` 写事件）绑定 `verifiedHead === HEAD`；`submit`/`merge` 现场按 `low`/`medium`/`high` 三正交策略核验，`quick --target` 绝不顶替全量门禁，无 CI 低风险纯文档变更须过 `runLowRiskDocStaticCheck`。
   - `submit` 推后**零跟踪文件写回**，先查 OPEN PR 防重并套用 `.github/pull_request_template.md` 后移交 `dev-review`。
5. **审查者合入、临时 `--detach` 试合、`generic-git` 防越权与 7 步确认清理**：
   - 独立审查 PASS 后由审查者执行 `flow.mjs merge`（强制校验 `verifiedHead === HEAD`、`reviewPassedHead === HEAD`、远端 CI 绿灯与堆叠父 PR 已合）；`generic-git` 禁本地强合（退出码 `3`，需 `--remote-merged` 或 `--human-approved`）；本地合入须先建 `.worktrees/.tmp-merge-*` `--detach` 试合复测再 `ff-only` / CAS 推进主干；弱化门禁或停损解锁（退出码 `4`）必传 `--human-approved --reason`。
   - `cleanup` 先列清单请人确认后带 `--confirm` 执行（兼容 Squash/远端 `MERGED`，先 `unlinkSync` 解绑再删 worktree 与分支）。

## 标准命令流

```sh
# 1. 状态重水合 / 身份与多 Issue 拓扑探测 / 账本状态
node ".agents/skills/dev-flow/scripts/flow.mjs" next [--task <id>] [--probe-auth] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" inspect [Issue/PR URL...] [--probe-auth]
node ".agents/skills/dev-flow/scripts/flow.mjs" status [--task <id>]

# 2. 启动工作位（--after 堆叠子分支 / --files 切片声明 / --create-issue 建单）、变基同步与并行队列
node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug> --case <1..4> [--issue <N|URL>] [--pr <M|URL>] [--after <parent>] [--files a,b] [--external-pr <M|URL>]
node ".agents/skills/dev-flow/scripts/flow.mjs" sync [--task <id>] [--onto <branch>]
node ".agents/skills/dev-flow/scripts/flow.mjs" batch <plan|check-disjoint|merge-queue|resume-session> [--tasks <a,b>] [--enqueue <id>]
node ".agents/skills/dev-flow/scripts/flow.mjs" abort [--task <id>] [--confirm]

# 3. 实施者认领 / 释放 / 归档锁（--include-master-prd）与分层实证
node ".agents/skills/dev-flow/scripts/flow.mjs" claim [--issue <N|URL>] [--takeover --reason "<接管原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" release [--task <id>] [--reason "<释放原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" finalize [--strict-sync] [--include-master-prd]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --tier quick [--target <file>]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode smoke|full|gate

# 4. 实施者提交待审 -> 移交 dev-review -> 返工 -> 审查者合入 -> 确认清理
node ".agents/skills/dev-flow/scripts/flow.mjs" submit [--rework] [--reset-review-slot]
node ".agents/skills/dev-flow/scripts/flow.mjs" rework [--rebut "<findingId>: <reason>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" merge [--method merge|squash|rebase] [--remote-merged] [--human-approved] [--reason "<原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm [--only-review-worktree|--keep-worktree] [--keep-local-branch] [--keep-remote-branch]
```
