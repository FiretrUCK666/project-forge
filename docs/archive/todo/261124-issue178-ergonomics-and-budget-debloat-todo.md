---
kind: todo
title: CLI 契约归一化、Skill 预算门禁与常青瘦身
status: done
created: 2026-11-24
updated: 2026-11-25
issue: 178
pr: null
branch: feat/feat-cli-契约归一化-skill-预算门禁与常青瘦身
owner: planner-conv-arch
plan_mode: interactive
approved: false
done_at: 2026-11-25
task_id: ergonomics-and-budget-debloat
planned_at: 6416a330632fa28180080e3ad87f825c49724caf
related_prd: ../prd/261124-conversational-state-machine-prd.md
related_spec: ../specs/261124-issue178-ergonomics-and-budget-debloat-spec.md
depends_on: [conversational-lifecycle-model]
scope_files: [kit/skills/lib/cli.mjs, kit/skills/lib/subcommand-meta.mjs, kit/skills/lib/tool-owned.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-flow/scripts/flow.mjs, kit/skills/dev-flow/scripts/flow-inspect.mjs, kit/skills/dev-review/scripts/review-pack.mjs, "kit/skills/*/SKILL.md", scripts/lib/protocol.mjs, scripts/dev/preflight.mjs, scripts/dev/preflight-suite.mjs, "scripts/dev/fixtures*.mjs", templates/agents-project.md, AGENTS.md, docs/TDD.md, references/collaboration.md, README.md, README.en.md]
---

# CLI 契约归一化、Skill 预算门禁与常青瘦身

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-25` |
| 分支 / 基线 | `feat/feat-cli-契约归一化-skill-预算门禁与常青瘦身` @ `6416a33` |
| 任务编号 | `ergonomics-and-budget-debloat` |
| 负责人 / 审批 | planner-conv-arch / `false` |
| 规划态 | `interactive`（全部核心决策已拍板确认） |
| 关联 Issue / PR / SPEC | #178 / 未关联 / `docs/archive/specs/261124-issue178-ergonomics-and-budget-debloat-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261124-issue178-ergonomics-and-budget-debloat-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/cli.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/lib/tool-owned.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-govern/SKILL.md`、`kit/skills/dev-review/SKILL.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-explore/SKILL.md`、`kit/skills/dev-edit/SKILL.md`、`kit/skills/dev-iterate/SKILL.md`、`kit/skills/dev-verify-tools/SKILL.md`、`scripts/lib/protocol.mjs`、`scripts/dev/preflight.mjs`、`scripts/dev/preflight-suite.mjs`、`templates/agents-project.md`、`AGENTS.md`、`docs/TDD.md`、`references/collaboration.md`、`README.md`、`README.en.md`。
- **复用既有模块**：`scripts/lib/protocol.mjs`、`kit/skills/lib/tool-owned.mjs`、`scripts/compose-agents.mjs`、`scripts/equip.mjs`、`scripts/sync-toc.mjs`。
- **本期不做**：不删减旧 CLI 参数兼容别名；不删减任何有效规则或弱化 `preflight-contracts.mjs` 契约检查。
- **门型与回滚路径**：`one-way`；出现问题通过 `git revert` 反向提交还原，并重跑 `compose-agents.mjs .` 与 `equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C9: `cli.mjs` / `subcommand-meta.mjs` / `doc-plan.mjs` / `flow.mjs` / `flow-inspect.mjs` / `review-pack.mjs` 将公共标志与 `[NEXT STEP]` 统一为 `--agent` / `--mode` / `--host-mode` 且静默保留旧别名，修复 `triage` 漏参、`audit` 重复 `printNextStep`、`flow start` 复用分支提示并在 `--json` 输出 `nextSteps`，通过 `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/subcommand-parity.mjs`。
- [x] C10: `kit/skills/lib/tool-owned.mjs` 与 `scripts/lib/protocol.mjs` 定义并单源导出 `KIT_SKILL_WARN_BYTES = 14 * 1024` 与 `KIT_SKILL_MAX_BYTES = 16 * 1024`，在 `scripts/dev/preflight.mjs` / `preflight-suite.mjs` 强制执行超 14KB 告警、超 16KB 失败阻断，通过 `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs`。
- [x] C11: 全部 8 套 `kit/skills/*/SKILL.md` 拆解超长条文与重复错误码罗列而不丢规则，全部低于 14KB，且通过 `node scripts/dev/preflight.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4`。
- [x] C12: 修复 `templates/agents-project.md` / `AGENTS.md` Case 1 矛盾与 `WARN_WORKING_IN_MAIN_CHECKOUT` 文案，同步 `docs/TDD.md`、`references/collaboration.md`、`README.md`、`README.en.md`，全量通过 `compose-agents.mjs . --check`、`equip.mjs . --check`、`sync-toc.mjs --check`、`review.mjs .`、`e2e-zip-harness.mjs` 与 `merge-gate.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补 C9-C10 正反回归与体积超限测试（Red） | `node scripts/dev/fixtures.mjs` 复现红灯 | Wave 2 合并 |
| 2 | 归一化 CLI 标志、`[NEXT STEP]` 与 `--json` `nextSteps`（C9） | `node scripts/dev/subcommand-parity.mjs` 与 `fixtures.mjs` 绿 | 步骤 1 |
| 3 | 落地 14KB/16KB 预算门禁并瘦身 8 套 `SKILL.md`（C10-C11） | `node scripts/dev/preflight.mjs` 全部低于 14KB | 步骤 2 |
| 4 | 对齐模板与常青双语文档并运行全量同步与门禁（C12） | `node scripts/dev/merge-gate.mjs` 与 `e2e-zip-harness.mjs` 全绿 | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `SKILL.md` 瘦身误删 `preflight-contracts.mjs` 断言关键词 | 合并句子时去掉关键词 | 先跑 `node scripts/dev/preflight.mjs` 逐项核对，绝不弱化断言 |
| 中英文 `README` 目录或版本同步遗漏 | 只改中文或英文一份 | 成对修改并跑 `node scripts/sync-toc.mjs README.md README.en.md --check` |

## 回滚预案

- **出问题时的第一步**：`git revert <commit-sha>` 后重跑 `node scripts/compose-agents.mjs .` 与 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs`。
- **回滚之后要做什么**：检查 `README.md` 与 `README.en.md` 目录一致性并更新 Issue `#169`。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| Wave 2（`conversational-lifecycle-model`） | `note`/`triage`/`mutability.mjs` 与 `reopen` 合并进 `main` | Wave 3 开工前 | 协调者 / 审查者 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（C9..C12 全部落地并通过验证）
- **待拍板事项**：无
- **下一步第一件事**：已完成，无遗留

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

- **实际验证命令与结果**：已完成全量 C9..C12 实现与本地实证（见 finalize 前后全量门禁与 E2E 输出）
- **文档同步检查**：已同步 `templates/agents-project.md`、`AGENTS.md`、`.agents/skills/`、`docs/TDD.md`、`references/collaboration.md`、`README.md`、`README.en.md`、`docs/feature-map.json` 并收口 `docs/archive/prd/261124-conversational-state-machine-prd.md`
- **遗留问题**：无（`#169` 保持 `OPEN` 至 PR 合并后自动/联动收尾）
