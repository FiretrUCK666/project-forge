---
kind: todo
title: 多 Worktree 三类并发依赖池、Windows 批处理硬化与策略单向门升级
status: active
created: 2026-11-27
updated: 2026-11-27
issue: 227
pr: null
branch: feat/multi-forge-worktree-perf-v1
owner: plan-c-master
plan_mode: interactive
approved: false
done_at: null
task_id: worktree-dep-pool-policy
planned_at: 7785ef3c55cb5251cbca39c6b312b414ab4841f5
related_prd: ../prd/261127-issue227-multi-forge-worktree-perf-v1-prd.md
related_spec: ../specs/261127-issue227-worktree-dep-pool-policy-spec.md
---

# 多 Worktree 三类并发依赖池、Windows 批处理硬化与策略单向门升级

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/multi-forge-worktree-perf-v1` @ `7785ef3` |
| 任务编号 | `worktree-dep-pool-policy` |
| 负责人 / 审批 | plan-c-master / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | #227 / 未关联 / `docs/specs/261127-issue227-worktree-dep-pool-policy-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC 审批状态（需前置切片 `low-cpu-script-perf` 与 `multi-forge-platform-core` 合入后再启动）。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/worktree-dep-pool.mjs` (new)、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/exec.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/intake-triage.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-intake.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-sync.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`scripts/dev/subcommand-parity.mjs`、`scripts/dev/fixtures-w6c-harness-gates.mjs`、`scripts/dev/injections-data-core.mjs`、`scripts/dev/injections-data-gates.mjs`、`scripts/dev/fixtures-worktree-policy-v2.mjs` (new)、`scripts/dev/injections-data-worktree-policy-v2.mjs` (new)
- **复用既有模块**：`kit/skills/lib/exec.mjs`（`withFileLockSync`、`execSafe`）、`kit/skills/lib/profile-sniffer.mjs`（`discoverWorkspacePackages`）、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/subcommand-meta.mjs`
- **本期不做**：不改动多平台业务流替换与实证附件生命周期（Wave 3）；不触碰 `flow-lifecycle.mjs`；不引入第三方依赖
- **门型与回滚路径**：`one-way`（高风险路径 `kit/`）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [ ] C7: 新增 `kit/skills/lib/worktree-dep-pool.mjs` (new) 并瘦身升级 `kit/skills/dev-flow/scripts/worktree-deps.mjs`（`<= 600` 行）：落地 Class R（含独立 `CARGO_TARGET_DIR`）/ Class S（仓外只读 `dep-pool` 按 `sha256(lockfiles+清单依赖段)` + `.prisma`/POSIX shebang 隔离 + `detach`/`reconcile` 漂移自动脱钩 + `pool-refs.json` 引用计数 GC + Windows NTFS 递归撤只读位 `0o777`/`0o666` 后再 `rmSync` 防 `EPERM` + Windows junction 非递归清理兜底 + `scanOutboundLinks` 放行 `dep-pool` 为 `tool-mounted`）/ Class I（构建与 DB/NoSQL 卷严格隔离），同步对齐 `kit/skills/lib/profile.mjs`（`worktree-shared-readonly:`）、`scripts/dev/fixtures-w6c-harness-gates.mjs` 与 `injections-data-core.mjs`/`gates.mjs` 锚点。
- [ ] C8: 升级 `kit/skills/lib/exec.mjs`：`computeWorktreeEnv` 统一重定向 `VITE_CACHE_DIR`/`JEST_CACHE_DIR`/`BABEL_CACHE_PATH`/`ESLINT_CACHE_LOCATION`/`CARGO_TARGET_DIR` 至独立 `PF_CACHE_DIR` 并透传 `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`；CVE-2024-27980 硬化优先对 `npm`/`pnpm`/`npx`/`yarn` `.cmd` 解析底层 JS 直调 `node`，其余 `.cmd`/`.bat` 放行含空格/括号的合法路径与测试垫片正常参数并严格拦截命令拼接元字符，且在 `execSafe` `try/catch` 内捕获返回已登记于 `kit/skills/lib/exit-codes.mjs` `USAGE_CODES` 的 `BLOCKED_UNSAFE_WIN_BATCH_ARG`（维护 `execSafe` 永不抛异常契约）。
- [ ] C9: 升级 `kit/skills/lib/workflow-policy.mjs`（扩展 `isOneWayBoundaryFile` 覆盖 NoSQL/ORM/KV/向量库、Proto/GraphQL/OpenAPI、Docker/K8s/Helm/Terraform；双向兼容修复 `resolveScopedVerificationGate` `dirRel/ecosystems` 字段错位与 `quickTest` 读取）与 `kit/skills/dev-flow/scripts/flow.mjs`/`flow-intake.mjs`/`kit/skills/lib/intake-triage.mjs`（`contextBasis` SHA-256 写前防脏写复核，漂移抛出登记于 `FACT_CODES` 的 `BLOCKED_STALE_INTAKE_CONTEXT`，修正帮助文案并过 `scripts/dev/subcommand-parity.mjs`），新增 `scripts/dev/fixtures-worktree-policy-v2.mjs` (new) 与 `scripts/dev/injections-data-worktree-policy-v2.mjs` (new)，`node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs --domain worktree-policy-v2` 与 `node scripts/dev/merge-gate.mjs` 退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先登记 `BLOCKED_UNSAFE_WIN_BATCH_ARG`/`BLOCKED_STALE_INTAKE_CONTEXT` 并编写失败回归测试 `scripts/dev/fixtures-worktree-policy-v2.mjs` (new)（含 Windows 只读目录清理、`.cmd` 直调 `node`、含括号路径放行与 `execSafe` 不抛异常） | `node scripts/dev/fixtures.mjs --domain worktree-policy-v2` 必红 | Wave 1 合入且本切片获批 |
| 2 | 实现 `kit/skills/lib/worktree-dep-pool.mjs` (new)、瘦身升级 `worktree-deps.mjs`（`<= 600` 行）与 `profile.mjs`，接入 `edit-gate`/`flow-lifecycle-helpers`/`flow-sync`/`flow-cleanup` 钩子并同步 `fixtures-w6c-harness-gates.mjs` | `node scripts/dev/preflight.mjs`、`--domain w6c-harness-gates` 与 `edit-gate` 行数检查全绿 | 步骤 1 |
| 3 | 升级 `exec.mjs`、`workflow-policy.mjs`、`intake-triage.mjs`、`flow-intake.mjs`、`flow.mjs` 与 `subcommand-parity.mjs` | `node scripts/dev/fixtures.mjs --domain worktree-policy-v2` 全绿 | 步骤 2 |
| 4 | 新增故障注入 `scripts/dev/injections-data-worktree-policy-v2.mjs` (new) 并对齐 `injections-data-core.mjs`/`gates.mjs`，执行 `node scripts/equip.mjs .` 并跑通全量验证 | `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0` | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`进行中`（已按 R1 独立审查意见修订完毕，待 R2 独立 Critique、维护者 `approve` 且 Wave 1 合入后开工）
- **待拍板事项**：无
- **下一步第一件事**：在 Wave 1 合入且本切片 `approved` 后，先建失败测试 `scripts/dev/fixtures-worktree-policy-v2.mjs` (new) 并登记两个新阻断码。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
