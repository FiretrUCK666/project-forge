---
kind: todo
title: Slice 6C：跨仓隔离、并发实证豁免与角色溯源防绕过
status: active
created: 2026-11-22
updated: 2026-11-22
issue: 143
pr: null
branch: feat/w6c-harness-gates-provenance
owner: plan-w6
plan_mode: interactive
approved: true
done_at: null
task_id: w6c-harness-gates-provenance
planned_at: 836e964ca5bb77e4ce14c1848e280bb15a1e3b9b
related_prd: ../prd/261122-issue143-w6-universal-architecture-prd.md
related_spec: ../specs/261122-issue143-w6c-harness-gates-provenance-spec.md
---

# Slice 6C：跨仓隔离、并发实证豁免与角色溯源防绕过

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | 见 Frontmatter `branch` @ `836e964` |
| 任务编号 | `w6c-harness-gates-provenance` |
| 负责人 / 审批 | plan-w6 / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #143 / 未关联 / `docs/specs/261122-issue143-w6c-harness-gates-provenance-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-start-provenance.mjs`(new)、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-merge-claim.mjs`(new)、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs`(new)、`kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs`、`kit/skills/dev-flow/scripts/flow-start-helpers.mjs`、`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/dev-review/scripts/review-empirical-state.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/lib/cli.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/ledger.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/doc-approval.mjs`、`kit/skills/lib/harness-context.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-policy-next.mjs`、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/issue-template-hydrate.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/handoff-package.mjs`、`.agents/skills/.pf-manifest.json`、`docs/feature-map.json`、`scripts/dev/fixtures-w6c-harness-gates.mjs`(new)、`scripts/dev/injections-data-w6c.mjs`(new)
- **复用既有模块**：`kit/skills/lib/subcommand-meta.mjs`(new)、`kit/skills/lib/doc-approval.mjs`、`kit/skills/lib/harness-context.mjs`
- **本期不做**：不修改 6A/6B 写域文件（不碰 `doc-plan.mjs`、`edit-gate.mjs`、`review-gates.mjs`），待 `6A` 与 `6B` 先后合入 `main` 后基于最新 `main` 实施。
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C13: `kit/skills/lib/cli.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `kit/skills/dev-flow/scripts/flow-issues.mjs` 实现跨仓工作目录不匹配 fail-closed 拦截（在 `exit-codes.mjs` 登记 `BLOCKED_CROSS_REPO_CWD_MISMATCH`）；`flow.mjs` 与 `review-pack.mjs` 接入 `SUBCOMMAND_META` 单源并对齐文件头，6/6 脚本通过 `subcommand-parity.mjs`。
- [x] C14: `kit/skills/lib/issue-template-hydrate.mjs` 与 `kit/skills/lib/pr-template-hydrate.mjs` 兼容 `**Bold**` 提示模板且零 section 命中时完整保留 `--body`；`flow.mjs finalize` 同步归档 `SPEC` 正文状态表与 YAML `status: implemented`。
- [x] C15: `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-pack.mjs` 与 `kit/skills/lib/escalation.mjs` 对 `low` 风险纯文档变更豁免强制 runtime `check-empirical` / `faultRequired` / `--include-diff` 阻塞，且 `escalation.mjs` 按错误签名去重不重复建单。
- [x] C16: `kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-policy-next.mjs` 与 `kit/skills/dev-review/scripts/review-empirical-state.mjs` 扩展 `isEquivalentConcurrentCommand` 识别 `--maxWorkers` / `--workers` / `--bail` / `--config.verify-deps-before-run=false`；为多语言仓单栈局部变更提供子包/单栈作用域验证识别并在 `collectDevProfileEmpiricalCmds` 接入过滤（未改栈缺失环境不误阻塞）。
- [x] C17: `kit/skills/dev-flow/scripts/worktree-deps.mjs` 与 `docs/feature-map.json` 修复独立 `mount` 更新 `mountedDepsByWorktree`、为 `pnpm` junction 透传 `npm_config_verify_deps_before_run=false` 并给出 Vite `fs.allow` 引导，基于 6B 在 `edit-gate.mjs` 落地的 `--base` 与游离 `HEAD` 支持修复 `verify-edit-gate` 在游离 review 槽执行兼容性；拆小 `flow-lifecycle.mjs`（798 行）、`flow-merge.mjs`（793 行）、`flow-inspect.mjs`（792 行）严守 `<= 800` 行。
- [x] C18: 强化规划/实施/审查真实角色溯源校验：由 `doc-plan init/link`（`doc-plan-ops.mjs` / `docs.mjs` / `doc-approval.mjs` / `ledger.mjs`）写入仓外 `.git/project-forge-flow/` `planningProvenance` 基线，在 `start`/`claim`/`submit` 拦截未经 `doc-plan link` 直改 Todo `owner:` 的篡改（在 `exit-codes.mjs` 登记 `BLOCKED_PROVENANCE_TAMPERED`）与历史规划作者重叠（`BLOCKED_AUTHOR_IS_IMPLEMENTER`），不按 Git commit author 误杀本地隔离实施代理并诚实界定 `handoff-package.mjs` 证明边界；Slice 6C 新增正反双向夹具（`scripts/dev/fixtures-w6c-harness-gates.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6c.mjs`(new)），执行 `node scripts/equip.mjs .` 后全量门禁全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 等待 6A & 6B 合入 `main` 后，在 `scripts/dev/fixtures-w6c-harness-gates.mjs`(new) 先写 C13-C18 失败用例 | `node scripts/dev/fixtures.mjs --domain w6c-harness-gates` 必须红 | 6A & 6B 已合入 |
| 2 | 在 `exit-codes.mjs` 登记新码，改造 `cli.mjs`、`flow.mjs`、`flow-issues.mjs`、`issue-template-hydrate.mjs`、`pr-template-hydrate.mjs` 并拆分 `flow-lifecycle-finalize.mjs`(new) | `node scripts/dev/preflight.mjs` & `node scripts/dev/fixtures.mjs --domain w6c-harness-gates` | 步骤 1 |
| 3 | 完成 `review-empirical.mjs`、`review-empirical-state.mjs`、`review-pack.mjs`、`escalation.mjs`、`workflow-policy*.mjs`、`worktree-deps.mjs` 与 `docs/feature-map.json` 改造 | `node scripts/dev/preflight.mjs` | 步骤 2 |
| 4 | 落地仓外 `planningProvenance` 溯源体系（`doc-plan-ops.mjs`/`docs.mjs`/`doc-approval.mjs`/`ledger.mjs`/`harness-context.mjs`），拆分 `flow-start-provenance.mjs`(new) 与 `flow-merge-claim.mjs`(new)，加固 `flow-inspect`/`flow-merge`/`flow-lifecycle-hooks`/`review-locks`/`handoff-package` 并同步 `node scripts/equip.mjs .` | `node scripts/equip.mjs . --check` & `node scripts/dev/fixtures.mjs --jobs 6` | 步骤 3 |
| 5 | 补齐 `scripts/dev/injections-data-w6c.mjs`(new) 并全量跑通门禁与故障注入 | `node scripts/dev/verify-injections.mjs --jobs 4` & `node scripts/dev/merge-gate.mjs` | 步骤 4 |

## 断点与遗留决策

- **当前状态**：`进行中`（等待总控规划审核及前置切片 `w6a`、`w6b` 合入后由独立 impl 代理开工）
- **待拍板事项**：无
- **下一步第一件事**：在 `w6a` 与 `w6b` 均合入 `main` 且本 SPEC 获批后，执行 `node .agents/skills/dev-flow/scripts/flow.mjs start --task w6c-harness-gates-provenance --case 4 --issue 143`。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`：exit 0（套件校验通过）
  - `node scripts/compose-agents.mjs . --check`：exit 0（AGENTS.md 一致）
  - `node scripts/dev/preflight.mjs`：exit 0（0 项失败，41 项读数）
  - `node scripts/dev/gap-coverage.mjs`：exit 0（20 条各有处置）
  - `node scripts/dev/subcommand-parity.mjs`：exit 0（6/6 入口全量对齐）
  - `node scripts/review.mjs .`：exit 0（可以交付，0 missing）
  - `node scripts/dev/fixtures.mjs --jobs 6`：exit 0（460 项通过 / 0 项失败）
  - `node scripts/dev/verify-injections.mjs --jobs 6`：exit 0（388 条判据全部抓到，含 `I443`–`I451`）
  - `node scripts/dev/e2e-zip-harness.mjs`：exit 0（Scenarios A–L 全通，232 包条目）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --json`：exit 0（checked 72, blockers 0, violations 0）
  - `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict`：exit 0（critical=0, high=0）
- **文档同步检查**：已运行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 与 `.agents/skills/.pf-manifest.json`，并勾选本 Todo、6C SPEC 与 1:N 总控 PRD（`C1..C19` 全部完成）待随 PR 成对归档。
- **遗留问题**：无
