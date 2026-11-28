---
kind: todo
title: 发版 v7.0.0：同步版本号、发版说明与全量门禁验证
status: done
created: 2026-11-25
updated: 2026-11-25
issue: 182
pr: null
branch: feat/release-v7
owner: coordinator
plan_mode: autonomous
approved: false
done_at: 2026-11-25
task_id: release-v7
planned_at: 5fde840cb90a0b3a27f279c16df3ade9ae5b0605
related_prd: null
related_spec: null
---

# 发版 v7.0.0：同步版本号、发版说明与全量门禁验证

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-25` / `2026-11-25` |
| 分支 / 基线 | `feat/release-v7` @ `5fde840` |
| 任务编号 | `release-v7` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #182 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`SKILL.md`、`README.md`、`README.en.md`、`docs/TDD.md`、`scripts/dev/fixtures-attribution-routing.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`docs/release-notes/v7.0.0.md (new)`、`.agents/skills/`
- **复用既有模块**：`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/sync-toc.mjs`、`scripts/review.mjs`、`scripts/dev/preflight.mjs`
- **本期不做**：不修改无关功能代码；不在本 PR 阶段创建或推送 Git 标签 `v7.0.0`（合入 `main` 后再由 Coordinator 打标签发布）
- **门型与回滚路径**：two-way；PR 合入前局部可逆（直接修正提交或关闭分支），合入后若未打标签可 `git revert`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: `SKILL.md`、`README.md`、`README.en.md` 与 `docs/TDD.md` 的版本标识同步升级为 `7.0.0` / `v7.0.0`，`scripts/dev/fixtures-attribution-routing.mjs` 改用动态 semver 校验（运行 `node scripts/dev/fixtures.mjs --jobs 6` 全部通过）
- [x] C2: 新建 `docs/release-notes/v7.0.0.md`，以 `# v7.0.0` 和一句话导语开头，包含 `## 重点变化`、`## 修复问题`、`## 不兼容变更与迁移`、`## 升级方式`，且无占位符、无 emoji、无 `scripts/dev/` 或内部波次噪音（运行 `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict` 与 `node scripts/review.mjs .` 通过）
- [x] C3: 运行 `node scripts/equip.mjs .` 同步 `.agents/skills/.pf-manifest.json` 的 `forgeVersion` 为 `7.0.0`，并通过全部发版前门禁（`preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`bench.mjs`、`e2e-zip-harness.mjs`、`verify-injections.mjs`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`、`sync-toc.mjs`、`verify-tools.mjs audit .`、`govern-audit.mjs audit . --strict`）与 `git archive` 导出包校验

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 同步 `SKILL.md`、`README.md`、`README.en.md`、`docs/TDD.md` 版本号并更新 `scripts/dev/fixtures-attribution-routing.mjs` 动态 semver 校验 | `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs --jobs 6` 通过 | 无 |
| 2 | 编写人类可读 `docs/release-notes/v7.0.0.md` 并运行 `node scripts/equip.mjs .` 同步 `.pf-manifest.json` | `node scripts/equip.mjs . --check` 与 `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict` 通过 | 步骤 1 |
| 3 | 执行全套发版前 11 条门禁、`verify-tools.mjs audit .`、`edit-gate.mjs --final` 与 `git archive` 导出包校验 | 全量门禁全绿且无临时文件残留 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 发版说明含未允许噪音或旧占位符 | 在 `docs/release-notes/v7.0.0.md` 写入内部路径、波次号或空节 | 由 `govern-audit.mjs` 与人工复核把关，删除空节与内部符号 |
| 版本号与测试/清单未同提交对齐 | 仅更新 `SKILL.md` 而漏更新 `.pf-manifest.json` 或硬编码测试 | 运行 `equip.mjs .` 并通过 `fixtures.mjs` 与 `equip.mjs . --check` 联检 |

## 回滚预案

- **出问题时的第一步**：PR 尚未合入或未打标签时，直接在 `feat/release-v7` 分支修复或关闭 PR；若已合入未打标签则 `git revert` 该合并提交。
- **回滚用什么**：分支反向提交或关闭未合并 PR。
- **回滚之后要做什么**：重新跑通 `preflight.mjs` 与 `equip.mjs . --check`，确认 `SKILL.md` 与 `.pf-manifest.json` 版本号保持一致。

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：在 `.worktrees/impl-release-v7` 内同步版本号、更新动态 semver 校验并撰写 `docs/release-notes/v7.0.0.md`

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：`node scripts/equip.mjs .`、`node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json`（0 blockers）、`node scripts/dev/preflight.mjs`（41/41 PASS）、`node scripts/dev/gap-coverage.mjs`（21/21 PASS）、`node scripts/dev/fixtures.mjs --jobs 6`（544/544 PASS）、`node scripts/dev/bench.mjs`（6/6 PASS）、`node scripts/dev/e2e-zip-harness.mjs`（A–L PASS）、`node scripts/dev/verify-injections.mjs --jobs 4`（460/460 caught）、`node scripts/compose-agents.mjs . --check`、`node scripts/equip.mjs . --check`、`node scripts/review.mjs .`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict`、`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit .` 全绿，且提交后执行 `git archive` + `preflight.mjs --package` 导出包校验。
- **文档同步检查**：已同步 `SKILL.md`、`README.md`、`README.en.md`、`docs/TDD.md`、`.agents/skills/.pf-manifest.json` 版本至 `7.0.0`，新增 `docs/release-notes/v7.0.0.md`，双语 README 目录同步校验通过。
- **遗留问题**：无（本 PR 阶段不打也不推 Git 标签，合入 `main` 后再由 Coordinator 打标签 `v7.0.0`）。
