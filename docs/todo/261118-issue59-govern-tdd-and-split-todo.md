---
kind: todo
title: 补全 docs/TDD.md 模块清单、修正 docs.stale-vs-churn 与夹具误报并按域拆分超长模块
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 59
pr: null
branch: feat/govern-tdd-and-split
owner: plan-59
approved: true
done_at: null
task_id: issue-59
planned_at: 930aea1c1d9837ead25887330e554af1e18a705c
related_prd: null
related_spec: ../specs/261118-issue59-govern-tdd-and-split-spec.md
---

# 补全 docs/TDD.md 模块清单、修正 docs.stale-vs-churn 与夹具误报并按域拆分超长模块

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | `feat/govern-tdd-and-split` @ `930aea1` |
| 任务编号 | `issue-59` |
| 负责人 / 审批 | plan-59 / `false` |
| 关联 Issue / PR / SPEC | #59 / 未关联 / [SPEC](../specs/261118-issue59-govern-tdd-and-split-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`docs/TDD.md`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-git-fast.mjs` (new)、`scripts/lib/survey-docs.mjs` (new)、`scripts/update.mjs`、`scripts/lib/update-net.mjs` (new)、`scripts/backup.mjs`、`scripts/lib/tar.mjs` (new)、`scripts/dev/fixtures-review.mjs`、`scripts/dev/fixtures-review-contracts.mjs` (new)、`scripts/dev/fixtures-flow.mjs`、`scripts/dev/fixtures-flow-state.mjs`、`scripts/dev/injections-data.mjs`、`scripts/dev/injections-data-core.mjs` (new)、`scripts/dev/injections-data-workflow.mjs` (new)、`scripts/dev/injections-data-gates.mjs` (new)、`scripts/dev/fixtures-govern.mjs`、`scripts/dev/fixtures.mjs`
- **复用既有模块**：`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/git.mjs`、`kit/skills/lib/shared.mjs`、`scripts/lib/protocol.mjs`、`scripts/lib/text.mjs`、`scripts/equip.mjs`
- **本期不做**：不扩大 `TEST_FILE_RE` 以免污染 `govern-tests.mjs` 断言检查；不修改或归档 `docs/prd/261117-v8-criteria-trust-prd.md`；不改 `scripts/compose-agents.mjs`；不合入 Stage B 功能；不在 PR 代码/测试中终止宿主机外部 OS 进程，亦不把宿主机既有外部目录 `.worktrees/impl-issue-49` 的带外清理纳入 PR/CI 阻塞门禁。
- **门型与回滚路径**：one-way；合入前可直接废弃分支或 `flow.mjs abort --confirm`，已合入远端一律反向 `git revert` 并重跑全量 `merge-gate`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: `docs/TDD.md` 包含 `kit/skills/**` 与 `scripts/**` 下全部 100% 既有及本次新增 `.mjs` 模块的完整相对路径（无一缺失），更新 `最近更新日期` 且 0 失效引用；运行 `node scripts/review.mjs .` 返回 0 个 `missing`，`node scripts/dev/preflight.mjs` 全绿退出 0。
- [ ] C2: `kit/skills/dev-govern/scripts/govern-docs.mjs` 的 `checkDocChurnStaleness` 在第 237 行与第 249 行两处循环中一致跳过受有效 `.pf-manifest.json`（`!Array.isArray(manifest.files)` 非空普通对象且 `!scopeRel`）托管的 `.agents/skills/` 镜像目录以及 `isTestOrFixtureFile(rel)` 测试/夹具文件；反向：当真实源码目录（如 `kit/skills/` 或 `scripts/lib/`）在最近提交中达 `>= 8` 次非测试非夹具提交且未同步 `docs/TDD.md` / `AGENTS.md` / `docs/*.md` 时仍触发 `docs.stale-vs-churn.<dir>`（由 `scripts/dev/fixtures-govern.mjs` 正反夹具 + `I157` 验证）。
- [ ] C3: `kit/skills/lib/static-gates.mjs`（`FIXTURE_FILE_RE` / `isTestOrFixtureFile`）与 `kit/skills/dev-govern/scripts/govern-checks.mjs` 正确豁免 `scripts/dev/fixtures-*.mjs` 与 `scripts/dev/injections-data*.mjs` 不报 `hygiene.god-file` 且不触发 `govern-tests.mjs` `tests.zero-assertion` 误报；反向：非测试/非夹具脚本（含 `scripts/dev/` 下普通非夹具脚本或 `scripts/lib/` 模块）超过 800 行仍必须触发 `hygiene.god-file`（由 `scripts/dev/fixtures-govern.mjs` 正反夹具 + `I158`、`I159` 验证）。
- [ ] C4: `scripts/lib/survey-workspace.mjs`（拆出 `scripts/lib/survey-git-fast.mjs` 与 `scripts/lib/survey-docs.mjs`）、`scripts/update.mjs`（拆出 `scripts/lib/update-net.mjs`）、`scripts/backup.mjs`（拆出 `scripts/lib/tar.mjs`）、`scripts/dev/fixtures-review.mjs`（拆出 `scripts/dev/fixtures-review-contracts.mjs`）、`scripts/dev/fixtures-flow.mjs` 与 `scripts/dev/injections-data.mjs`（拆出 `scripts/dev/injections-data-core.mjs`、`scripts/dev/injections-data-workflow.mjs`、`scripts/dev/injections-data-gates.mjs`）拆分后，含新增用例后的 `scripts/dev/fixtures-govern.mjs`（675 行起）在内全仓所有 `.mjs` 文件均 `<= 800` 行，原模块导出签名与行为 100% 兼容，且 `arch-rules` 四条禁引 0 违规。
- [ ] C5: 在仓内可执行且可复现的检查下，执行 `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --json` 与 `reconcile --json` 均达到 `0` 条 `docs.stale-vs-churn`、`0` 条 `hygiene.god-file` 与 `0` 条由 Issue #59 新引入的 `hygiene.stale-worktree`（外部宿主机既有孤儿目录 `.worktrees/impl-issue-49` 仅作为非阻塞带外运维备忘，不计入 PR/CI 阻断判据），且完整 `merge-gate`（含 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`、`sync-toc.mjs --check`、`verify-injections.mjs`）全绿通过（退出码 0）。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 在 `scripts/dev/fixtures-govern.mjs`（675 行起，增量用例保持精简以确保 `<= 800` 行）先补齐 C2 与 C3 的失败复现正反用例（Red） | `node scripts/dev/fixtures.mjs --domain govern` 必须失败（Red） | 无 |
| 2 | 在 `static-gates.mjs` / `shared.mjs` / `govern-docs.mjs`（第 237 行与第 249 行共用跳过逻辑）/ `govern-checks.mjs` / `review-gates.mjs` / `repo-map.mjs` 落地镜像与夹具分类修复并同步 `node scripts/equip.mjs .` | `node scripts/dev/fixtures.mjs --domain govern`、`node scripts/equip.mjs . --check` 与 `scripts/dev/fixtures-govern.mjs` `<= 800` 行转绿 | 步骤 1 |
| 3 | 按域拆分 `survey-workspace.mjs`、`update.mjs`、`backup.mjs`、`fixtures-review.mjs`、`fixtures-flow.mjs`、`injections-data.mjs` 并补全带对称 `alsoDropIn`（面向 `.agents/skills/`）的故障注入 `I157`–`I159` | 全仓所有 `.mjs` 文件均 `<= 800` 行、`verify-injections.mjs --only I157`..`I159` 与旧注入锚点全绿 | 步骤 2 |
| 4 | 补齐 `docs/TDD.md` 全仓 `.mjs` 完整相对路径清单与最近更新日期 | `node scripts/review.mjs .`（0 missing）与 `node scripts/dev/preflight.mjs` 退出 0 | 步骤 3 |
| 5 | 在隔离工作树内全量跑通 `merge-gate`、`govern-audit.mjs audit . --json` 与 `reconcile --json`（另附带外宿主机运维备忘：主仓空目录 `.worktrees/impl-issue-49` 如需清理，须先现场重查当前占用进程与空目录并获人类确认后再处理） | `govern-audit.mjs audit . --json`（0 `docs.stale-vs-churn`、0 `hygiene.god-file`、0 条 Issue #59 新增 `hygiene.stale-worktree`）与全量 `merge-gate` 退出 0 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `injections-data*.mjs` 或 `fixtures-survey.mjs` 锚点断裂 | 拆分 `backup.mjs`、`update.mjs`、`survey-workspace.mjs` 时把 `I25`/`I29`/`I44`/`I54`/`I126` 或 `let codeFiles = 0` 迁出原文件 | 保留 `applyPackage`、`restoreBackup`/`createBackup`、`finalizeWalkWorkspace` 原位，只拆出独立协议/网络/快读/文档子模块，并重跑全量 `verify-injections.mjs` |
| `FIXTURE_FILE_RE` 误豁免普通长脚本或误入 `govern-tests.mjs` | 正则匹配范围过宽或混入 `TEST_FILE_RE` | `TEST_FILE_RE` 保持不变，仅用独立 `FIXTURE_FILE_RE` 精准匹配 `fixtures-*`/`injections-data*`/`fixtures/` 等路径并补反向注入 `I159` |
| 独立打包测试目录缺新拆模块 | `scripts/dev/fixtures-equip.mjs` 的 `pkgSub` 仅复制部分 `scripts/*.mjs` 与全量 `scripts/lib/` | 顶层脚本新拆的辅助模块统一放进 `scripts/lib/`（`tar.mjs`、`update-net.mjs`、`survey-git-fast.mjs`、`survey-docs.mjs`），严守 `arch-rules` 与隔离测试复制清单 |

## 回滚预案

- **出问题时的第一步**：运行 `node .agents/skills/dev-flow/scripts/flow.mjs abort --task issue-59 --confirm`（若未合入）或定位失败注入/测试文件。
- **回滚用什么**：未合入前丢弃 `.worktrees/impl-issue-59` 与分支 `feat/govern-tdd-and-split`；已合入则通过 `git revert <merge-commit>` 反向提交回退。
- **回滚之后要做什么**：在 Issue #59 评论记录回退原因并重跑完整 `merge-gate` 验证 `main` 恢复全绿。

## 断点与遗留决策

- **当前状态**：`规划完成，待独立 Critique`（`docs/specs/261118-issue59-govern-tdd-and-split-spec.md` 与本 Todo 已落盘 `.worktrees/impl-issue-59`）
- **待拍板事项**：无
- **下一步第一件事**：由独立 `critic-59` 对 `docs/specs/261118-issue59-govern-tdd-and-split-spec.md` 执行 Critique 并通过后进入 `approve` 与实施。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
