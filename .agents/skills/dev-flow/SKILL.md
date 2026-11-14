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

1. **先 `inspect` 再动手**：识别工作区身份（`local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `inbound-external-pr` / `generic-git`）与远端通道；撞见 `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 冲突态一律阻断。
2. **只读克隆不冒推**：遇到 `clone-readonly` 必须停下让用户三选一（`--clone-choice fork|standalone|local`）。
3. **三档隔离 + Workspace 防毒化共享依赖**：
   - 第 1 档：`L1` 且主仓干净无并行 -> 原地切分支。
   - 第 2 档：`L2/L3` / 关联 Issue / 脏主仓 / 并行 -> `.worktrees/impl-<id>`；`worktree-deps` 按子包与生态独立比对锁文件，探测到 Workspace 软链或 Python editable `.venv` 指回主仓时自动隔离；`submit` 同步推送 `.worktrees/review-<id>` 至最新 `HEAD` 并挂载依赖，杜绝空 Diff 审查。
   - 第 3 档：外部 PR (`--external-pr <M>`) -> `.worktrees/review-pr-<M>` detached 隔离，**未通过静态投毒扫描前绝不挂载依赖或跑脚本**。
4. **提交前双锁、成对归档与严格验证**：
   - `finalize` 检查未勾选条目并调用成对归档将 `PRD/SPEC/Todo` 移入 `docs/archive/{prd,specs,todo}/`，同时核对模块边界改动是否同步更新 `docs/TDD.md` 最近更新日期；`contributor-fork` 若上游不用 `docs/` 则自动隔离到 `.worktrees/.state/private-docs/`。
   - `verify` 尊重 `Dev Profile` 显式 `none`（纯文档仓可直接通过并绑定 `HEAD`）。
5. **审查 HEAD 闭环、门禁弱化阻断与 Squash 清理**：
   - `merge` 强制校验 `implRoot` 干净、`verifiedHead === HEAD`、且需独立审查时校验 `reviewPassed === true && reviewPassedHead === HEAD && lastReview?.headSha === HEAD && !lastReview?.stopLossTriggered`；触发 `STOP_LOSS_ESCALATE` 或门禁弱化（退出码 `4`）必须带 `--human-approved [--reason "..."]` 解锁；放行 `generic-git` 本地合并。
   - `cleanup` 兼容 Squash/Rebase 合入四态判定，必须先 `unlinkSync` 解绑共享依赖再移除 worktree。

## 标准命令流

```sh
# 1. 环境与输入解析 / 查看当前任务唯一合法下一步
node ".agents/skills/dev-flow/scripts/flow.mjs" inspect [Issue/PR URL...] [--probe-auth]
node ".agents/skills/dev-flow/scripts/flow.mjs" status [--task <id>]

# 2. 启动或放弃任务工作位（支持直接贴 Issue/PR URL，自动分流外部 PR 隔离或复用同仓 PR 原分支；--create-issue 可由 maintainer 自动建单）
node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug> --case <1..4> [--issue <N|URL>] [--pr <M|URL>] [--create-issue --title "<标题>"] [--external-pr <M|URL>]
node ".agents/skills/dev-flow/scripts/flow.mjs" abort [--task <id>] [--confirm]

# 3. 认领（远程自动查 pf-state 防撞车，接管须带 --takeover --reason 双写 Issue+PR）/ 释放认领 / 文档锁与实证
node ".agents/skills/dev-flow/scripts/flow.mjs" claim [--issue <N>] [--takeover --reason "<接管原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" release [--task <id>] [--reason "<释放原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" finalize [--strict-sync]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --tier quick [--target <file>]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode smoke
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode gate

# 4. 推送并同步审查槽 / 返工 / 合并 / 人类确认后清理
node ".agents/skills/dev-flow/scripts/flow.mjs" submit [--rework]
node ".agents/skills/dev-flow/scripts/flow.mjs" rework [--rebut "<findingId>: <reason>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" merge [--human-approved] [--reason "<原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm
```
