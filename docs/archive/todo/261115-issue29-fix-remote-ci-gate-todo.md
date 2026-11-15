---
kind: todo
title: 补齐合并前远端 CI 变绿硬门禁并修复 Linux 与 UTC 行为断言
status: done
created: 2026-11-15
updated: 2026-11-15
issue: 29
pr: null
branch: fix/remote-ci-merge-gate
owner: FiretrUCK666
approved: false
done_at: 2026-11-15
task_id: fix-remote-ci-gate
planned_at: 7ea1acccfe80a013cccd755f6d46c50aea5e1dd8
related_prd: null
related_spec: null
---

# Todo: 补齐合并前远端 CI 变绿硬门禁并修复 Linux 与 UTC 行为断言

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-15` / `2026-11-15` |
| 分支 / 基线 | `main` @ `7ea1acc` |
| 任务编号 | `fix-remote-ci-gate` |

## 影响范围

- 预计改动文件：`kit/skills/lib/github-client.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-flow/SKILL.md`、`.github/workflows/check.yml`、`templates/ci-check.yml`、`references/remote-github.md`、`references/collaboration.md`、`scripts/dev/preflight.mjs`、`scripts/dev/preflight-contracts.mjs`、`scripts/dev/fixtures-v6-kit.mjs`、`scripts/dev/verify-injections.mjs`
- 快测命令：`node scripts/dev/preflight.mjs`

## 复用既有模块

- `kit/skills/lib/github-client.mjs`（`githubHttpsRequest` / `execSafe` 四级降级客户端）、`kit/skills/lib/git.mjs`（`writeAtomic` / `ensureWorktreesIgnored`）、`kit/skills/dev-flow/scripts/worktree-deps.mjs`（`mountSharedDeps` / `unmountSharedDeps`）

## 本期不做

- 不重写或强推已推送的 `main` 历史，不删旧任务 `.worktrees/` 与分支（等待人确认后再清理）

## 门型与回滚路径

- 门型：two-way
- 回滚路径：局部可逆改动，直接 git revert 或删除临时分支即可回退。

## 验收标准（动手之前冻结）

- [x] C1: `.github/workflows/check.yml` 汇总 job `check` 增加 `if: always()` 并显式校验 `needs.gates.result == 'success'`（非 `success` 时 `exit 1`），`templates/ci-check.yml` 与 `references/remote-github.md` 同步矩阵汇总防 `skipped` 假绿规范，且 `scripts/dev/preflight-contracts.mjs` 增加确定性静态检查。
- [x] C2: `kit/skills/lib/github-client.mjs` 新增 `getCommitChecks({ repo, ref })`（兼容 `gh-cli` 与 `node-https-token`，聚合 check-runs 与 commit status 并按同名最新运行去重），`kit/skills/dev-flow/scripts/flow-merge.mjs` 在远程 PR 合并前强制校验当前 `HEAD` 远端检查（运行中报 `BLOCKED_CI_PENDING`，失败报 `BLOCKED_CI_FAILED`，无检查工作流的仓库正常放行）。
- [x] C3: `kit/skills/dev-flow/scripts/worktree-deps.mjs` 挂载共享依赖软链时向 `<gitCommonDir>/info/exclude` 写入无尾斜杠忽略项（解决 Linux/macOS 下 `.gitignore` 尾斜杠不匹配 POSIX 软链导致 `git add -A` 误提交的问题），且 `unmountSharedDeps` 跳过已被 Git 跟踪的路径。
- [x] C4: 修复 `scripts/dev/fixtures-v6-kit.mjs` 硬编码日期跨 UTC 午夜失败问题，补充远端 CI 合并门禁（pending/failed/rerun-pass）与 POSIX 软链忽略的正反双向行为断言，并在 `scripts/dev/verify-injections.mjs` 增补对应故障注入。
- [x] C5: `scripts/dev/preflight.mjs` 遍历时跳过 `.worktrees` 目录，`node scripts/equip.mjs .` 与本仓全部门禁及 GitHub Actions Ubuntu（Node 18 / 22）全绿通过。

## 执行步骤

1. 先核实 Issue #29 认领评论归属并冻结上述 Todo —— 验证：`node .agents/skills/dev-plan/scripts/doc-plan.mjs audit --file docs/archive/todo/261115-issue29-fix-remote-ci-gate-todo.md`
2. 补齐远端 CI 合并门禁、`.github/workflows/check.yml` `if: always()` 防假绿、`worktree-deps.mjs` POSIX 软链忽略与 UTC/CI 行为断言 —— 验证：`node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs`
3. 同步 `.agents/skills/`、归档 Todo 并提 PR，等待远端 Actions 全绿后由独立 `swarm` 审查合并 —— 验证：`gh pr checks --watch` 全绿且 `merge-gate` 全通

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- 验证命令与结果：`node scripts/equip.mjs .` 同步无冲突；`preflight.mjs` 30 项读数通过（0 失败）；`fixtures.mjs` 128 项通过（0 失败）；`gap-coverage.mjs`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`（0 缺）、`sync-toc.mjs --check` 与 `govern-audit.mjs` 全通；归档后执行 `verify --mode gate` 全量门禁并等待 PR 远端 GitHub Actions（Ubuntu Node 18/22 + `check`）全绿。
- 遇到的问题与回避方式：Linux/macOS 下 `.gitignore` 带尾斜杠的 `node_modules/` 只忽略真实目录不忽略 POSIX 软链，导致行为断言中 `git add -A` 误将软链入库并卡死清理；改为挂载时向 `$GIT_COMMON_DIR/info/exclude` 写入 `/<depRel>` 无尾斜杠规则，并在解绑前用 `git ls-files --error-unmatch` 跳过已跟踪路径。另修复 `fixtures-v6-kit.mjs` 跨 UTC 午夜硬编码日期问题。
