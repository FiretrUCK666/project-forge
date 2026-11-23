---
kind: todo
title: 八大技能契约零漂移、提示词去臃肿与提交风格防抖
status: active
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/r6-arch-plan
owner: plan-r6-arch
plan_mode: interactive
approved: true
done_at: null
task_id: r6d-skills-contract-debloat
planned_at: 1853e2257b47936b97aed07377c98d2d7a117bb8
related_prd: ../prd/261124-r6-arch-hardening-prd.md
related_spec: ../specs/261124-r6d-skills-contract-debloat-spec.md
---

# 八大技能契约零漂移、提示词去臃肿与提交风格防抖

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/r6-arch-plan` @ `1853e22` |
| 任务编号 | `r6d-skills-contract-debloat` |
| 负责人 / 审批 | plan-r6-arch / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `../specs/261124-r6d-skills-contract-debloat-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`SKILL.md`、`AGENTS.md`、`docs/TDD.md`、`docs/feature-map.json`、`references/*.md`、`templates/agents-project.md`、`kit/skills/dev-*/SKILL.md`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-review/scripts/review-context.mjs`、`kit/skills/dev-govern/scripts/govern-state.mjs`、`.agents/skills/**`、`scripts/compose-agents.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/dev/{cli-parity,preflight-contract-rules}.mjs`、`scripts/dev/fixtures-r6d-contracts.mjs` (new)、`scripts/dev/injections-data-r6d.mjs` (new)
- **复用既有模块**：`kit/skills/lib/git.mjs` (`isDefaultBranch`)、`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/review.mjs`、`scripts/dev/cli-parity.mjs`
- **本期不做**：不新增第 9 个内置技能；不硬压 `AGENTS.md` `12–15KB` 字节死线；须在 Wave 1（切片 A/B/C）全部合入主干后执行
- **门型与回滚路径**：one-way；`git revert <sha>` 回退。
- **快测命令**：`node scripts/dev/fixtures.mjs --domain r6d-contracts`

## 验收标准与执行清单

- [ ] C13: 将 `doc-plan-ops.mjs`、`edit-gate.mjs`、`review-context.mjs`、`govern-state.mjs` 剩余 4 处默认分支调用切至 `isDefaultBranch`；清零 `SKILL.md` 幽灵参数，对齐 `flow.mjs` `printHelp()` 与 `kit/skills/dev-*/SKILL.md` 必传参数，扩展 `cli-parity.mjs` 校验全部 `SKILL.md` 与 `printNextStep`。
- [ ] C14: 先解绑 `scripts/dev/preflight-contract-rules.mjs` 多文件全文复制强锁，再清理 `SKILL.md`、`AGENTS.md`、`templates/agents-project.md`、`references/*.md`、`kit/skills/dev-*/SKILL.md` 与 `docs/TDD.md` 重复副本（保留完整关键信息，无硬压字节死线）。
- [ ] C15: 完整落地 A1/A2/A3、统一 `Case 1` 原地微调与 `--planning` 自动隔离、前置 `single-session + --human-approved`、松绑外部调研配仓内路径硬回落门禁及弹性探索启发式（无固定文件数与简报行数死线）。
- [ ] C16: 同步 `docs/TDD.md` 与 `docs/feature-map.json`，运行 `equip.mjs .` 与 `compose-agents.mjs .`，跑通全量门禁矩阵与故障注入并在最终 PR 归档总控 PRD。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 编写 `scripts/dev/fixtures-r6d-contracts.mjs` (new) 复现幽灵参数漏检与复制规则冲突 | `node scripts/dev/fixtures.mjs --domain r6d-contracts` 必红 | Wave 1 A/B/C 合入 |
| 2 | 切齐 4 处 `isDefaultBranch`、改 `cli-parity.mjs`、`flow.mjs` `printHelp()`、解绑 `preflight-contract-rules.mjs` 并整理全部契约与技能文档 | `node scripts/dev/cli-parity.mjs` 与 `fixtures --domain r6d-contracts` 全绿 | 步骤 1 |
| 3 | 更新 `docs/TDD.md` 与 `docs/feature-map.json`，跑 `equip.mjs .`、`compose-agents.mjs .` 与全套门禁及 `injections-data-r6d.mjs` (new) 并随 PR 归档总控 PRD | `preflight`、`gap-coverage`、`fixtures`、`verify-injections`、`e2e-zip-harness`、`review`、`govern-audit` 全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 解绑 `preflight-contract-rules.mjs` 后入口丢失必要指针 | 清理重复段落时误删标题指针 | 保持权威源判据校验与入口指针校验，通过 `gap-coverage.mjs` 与 `preflight.mjs` 双向兜底 |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：确认 Wave 1 A/B/C 全数合并后，在隔离 `.worktrees/impl-r6d-skills-contract-debloat` 先写 `scripts/dev/fixtures-r6d-contracts.mjs` (new)。

## 澄清与补充记录

- 已确认（2026-11-24 · user）：A1: 非平凡 Case 3 Todo 的 Critique 口径 -> A1 已拍板：非平凡 Case 3 Todo 统一为「自检直通，Critique 仅建议（不强制）」，由切片 B 对齐 `doc-plan.mjs`，切片 D 同步校准 `docs/TDD.md` 与 `kit/skills/dev-plan/SKILL.md`。
- 已确认（2026-11-24 · user）：A2: `dev-iterate run` 失败升级默认值 -> A2 已拍板：`dev-iterate run` 默认开启失败自动升级建单（`--escalate` 默认 `true`，支持 `--no-escalate` 关闭），由切片 C 实现并在切片 D 同步文档。
- 已确认（2026-11-24 · user）：A3: 独立审查通过后 `flow.mjs merge` 执行权 -> A3 已拍板：只读独立审查子代理通过 `review-pack record --verdict pass` 后，允许独立审查者或调度者执行 `flow.mjs merge`（强校验 `reviewPassed === true && headSha === reviewPassedHead`，仍严禁实施者自合），由切片 A 落盘门禁并在切片 D 同步文档。

## 完成后的记录

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
