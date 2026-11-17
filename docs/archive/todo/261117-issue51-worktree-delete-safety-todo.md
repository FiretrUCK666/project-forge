---
kind: todo
title: worktree 通配清理的删穿保护
status: done
created: 2026-11-17
updated: 2026-11-18
issue: 51
pr: 64
branch: feat/worktree-delete-safety
owner: FiretrUCK666
approved: false
done_at: 2026-11-18
task_id: worktree-delete-safety
planned_at: 73087a27cb9af3d9cea2988cc3e3e4d3b6154ec9
related_prd: ../../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261117-issue51-worktree-delete-safety-spec.md
---

# Todo: worktree 通配清理的删穿保护

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-17` / `2026-11-18` |
| 分支 / 基线 | `feat/worktree-delete-safety` @ `7b4b40e` |
| 任务编号 | `worktree-delete-safety` |
| 负责人 / 审批 | `FiretrUCK666` / `true` |
| 认领的验收标准 | C1..C6 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-sync.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`scripts/dev/fixtures-flow.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`lstatSafe`、`EXIT_POLICY_BLOCK`（定义在 `flow-inspect.mjs`）、`printNextStep`、夹具助手 `tmpProject` / `gitInit` / `gitCommitFast`
- **本期不做**：跨平台文件系统层 delete-guard、硬链接处理
- **门型与回滚路径**：one-way；移除 `flow-cleanup.mjs` 的新增解绑调用与阻断分支即可回退，扫描器可保留
- **快测命令**：`node scripts/dev/fixtures.mjs --domain flow`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。编号与 SPEC 一一对应。

- [x] C1: 外链存在时 `cleanup` 在删目录之前以 `EXIT_POLICY_BLOCK` 终止并逐条列出路径与目标；主仓哨兵仍在；悬空链接同样阻断且 `reason` 为 `unresolved-target`；`sync` / `submit` / `trial-merge` 路径上不阻断只解绑。
- [x] C2: 无外链的 worktree 退出 0；**工具自己挂的依赖不要求人加 `--allow-outbound`** 且回执标明「工具挂载，自动解绑」；真外链仍阻断；`--allow-outbound` 逐个完全匹配才放行；`--force` 不跳过外链检查；回执里 `unmountedLinks` 的 `path` 与 `target` 都非空。
- [x] C3: **目标在 worktree 内部的链接先 `unlinkSync` 再删目录**——`cleanup` 退出 0、目录消失、分支已删、账本已更新；对照用例说明只 `unlink` 不删会 `Directory not empty`。
- [x] C4: 深度 25 的外链：`scanOutboundLinks` 要么检出、要么报 `scan-truncated`；两种情况下 `cleanup` 都不得继续删目录，主仓哨兵仍在；把上限改小后注入必须变红。
- [x] C5: `flow-sync` / `flow-lifecycle` / `flow-trial-merge` 三处都显式传 `{ mode: 'deps' }`；主仓有真 `node_modules` 时跑 `runTrialMerge` 返回 `ok: true` 且哨兵仍在；漏改任一处时该用例必须变红。
- [x] C6: 判据不以目录名白名单为前置——`I22b` 注入变红即可；不再要求源码级形状断言；`mainDepsIntact` 这类写死 `true` 的字段不作为证据，「被拦下的目标事后也复核」才是。
## 断点与遗留决策

- **当前状态**：`已完成`，无遗留待办。
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/dev/fixtures.mjs --domain flow-cleanup` → 5 项通过 / 0 失败；`node scripts/dev/fixtures.mjs` → 241 项通过 / 0 失败；`node scripts/dev/preflight.mjs` → 33 项读数 0 失败；`node scripts/dev/verify-injections.mjs` → 149 条全部变红捕获（含 `I22`、`I22b`、`I103`、`I143`、`I144`）；`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`、`node scripts/gap-coverage.mjs`、`node scripts/sync-toc.mjs README.md README.en.md --check` 与 `govern-audit.mjs audit . --changed --strict` 均退出 0。
- **文档同步检查**：同步更新 `docs/TDD.md`（Worktree 挂载清单写盘与删穿防护流程及 `fixtures-flow-cleanup.mjs` 条目）与 `kit/skills/dev-flow/SKILL.md`（同步装配进 `.agents/skills/`）。
- **遗留问题**：无
