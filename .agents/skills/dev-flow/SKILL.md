---
name: dev-flow
description: |
  统一驱动 Git 日常研发全流程：探测身份与凭据、按三档创建分支或 Worktree 并秒挂共享依赖、
  认领 Issue、提交前文档同步锁、执行验证绑定 HEAD、推分支开 PR、返工、审查后合并与安全清理。
  触发词：修 bug、做功能、推代码、提 PR、开 PR、合并收尾、清 worktree、处理 Issue、
  审外部 PR、收到 Issue、收到 PR、fix bug、implement feature、create PR、merge PR、cleanup worktree。
---

# dev-flow：Git 研发协同与流转引擎

覆盖从收到需求 / Issue / PR 到分支隔离、验证提交、返工、合并与人类确认清理的全生命周期。

## 核心规则

1. **先 `inspect` 再动手**：并发识别五态身份（`local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `inbound-external-pr`）与 GitHub 双轨通道；同时传入关联 Issue 与 PR 时自动复用原 PR 与原分支，禁止重开第二个 PR；多个 Issue 自动解析 `Depends on / Blocks` 依赖顺序。
2. **只读克隆不冒推**：遇到 `clone-readonly` 必须停下让用户三选一（`--clone-choice fork|standalone|local`）。
3. **三档隔离 + 秒挂共享依赖**：
   - 第 1 档：`L1` 且主仓干净且无并行需求 -> 切分支开发。
   - 第 2 档：`L2/L3` / 关联 Issue / 脏主仓 / 并行 -> `.worktrees/impl-<id>` + 预分配审查槽 `.worktrees/review-<id>`，锁文件 SHA256 一致时自动挂载 `node_modules` / `.venv` junction，不一致时自动隔离。
   - 第 3 档：外部 PR (`--external-pr <M>`) -> `.worktrees/review-pr-<M>` detached 隔离，**未通过静态投毒扫描前绝不挂载依赖或跑脚本**。
4. **提交 PR 前双锁、生命周期联动与验证节奏**：
   - `start`/`claim --issue <N>` 自动同步关联文档 `-issue<N>-` 命名、YAML Frontmatter 与 `related_*` 互链；`submit` 自动回写 `pr` 与 `in_review`。
   - Case 3/4 必须先 `finalize`（核验 `[x]`、更新文档 `done`/`implemented`/`done_at`、归档 Todo 到 `docs/archive/todo/` 并扫描 `AGENTS.md` `## 改哪看哪` 输出 `coupledSyncWarnings`，传 `--strict-sync` 时有漏同步即阻断；Fork 对外部仓不泄漏私有 `docs/`），且改代码后重跑 `verify` 使 `verifiedHead === HEAD` 才允许 `submit`。
   - **分级验证节奏**：坚持形式与实证优先于静态读代码——内循环改完即运行 `verify --tier quick [--target <file>]`（缺省 `--target` 时剥离 `{target}` 并提示窄化）；涉及运行时/CLI/服务必跑 `verify --mode smoke` 拿真实输出证据；涉及 UI/视觉（`.tsx`/`.jsx`/`.vue`/`.svelte`/`.html`/`.css`/`.scss`/`.svg`）须实测渲染交互与浅深色截图并记 `--visual-checked`；合前集中跑 1 次 `verify --mode gate`（或 `full`）。
5. **门禁弱化阻断（单向门退出码 4）与 Fork/清理硬锁**：
   - `merge` 自动扫描 diff 中是否删减测试断言、新增 `.skip`/`.only`、在 workflow 加入 `continue-on-error: true` / 放宽 `permissions`、或命令追加失效旁路；一旦命中，按单向门（`one-way`）以**退出码 `4`** 阻断，必须由人类明确同意后带 `--human-approved` 方可合并。
   - `contributor-fork` 永不推 `upstream`、禁止调 `merge`，且上游 PR 仍为 `OPEN` 时 `cleanup --confirm` 硬锁拒删分支；任何清理不传 `--confirm` 一律只列清单不删；卸载 worktree 必定先 `unlinkSync` 解绑依赖再移除 worktree，再 `git branch -d`（绝不用 `-D`）。

## 标准命令流

```sh
# 1. 环境与输入解析
node ".agents/skills/dev-flow/scripts/flow.mjs" inspect [Issue/PR URL...]

# 2. 启动工作位（支持 --issue <N> 自动对齐文档；clone-readonly 补 --clone-choice）
node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug> --case <1..4> [--issue <N>] [--external-pr <M>]

# 3. 认领、锁定文档、联动校验与分层实证（--tier 等价 --mode）
node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task <id> [--issue <N>]
node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task <id> [--strict-sync]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task <id> --tier quick [--target <file>]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task <id> --mode smoke
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task <id> --mode gate

# 4. 推送与提 PR / 返工 / 合并 / 人类确认后清理
node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task <id> [--rework]
node ".agents/skills/dev-flow/scripts/flow.mjs" rework --task <id> [--rebut "<findingId>: <reason>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task <id> [--human-approved]
node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task <id> [--confirm]
```
