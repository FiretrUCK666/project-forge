---
kind: todo
title: 对话记忆、全周期两态状态机与受控重开
status: done
created: 2026-11-24
updated: 2026-11-25
issue: 176
pr: null
branch: feat/conversational-lifecycle-model
owner: planner-conv-arch
plan_mode: interactive
approved: false
done_at: 2026-11-25
task_id: conversational-lifecycle-model
planned_at: 6416a330632fa28180080e3ad87f825c49724caf
related_prd: ../../prd/261124-conversational-state-machine-prd.md
related_spec: ../specs/261124-issue176-conversational-lifecycle-model-spec.md
depends_on: [core-state-integrity]
scope_files: [kit/skills/lib/session-state.mjs, kit/skills/lib/session-orient.mjs, kit/skills/lib/mutability.mjs, kit/skills/lib/doc-substantive.mjs, kit/skills/lib/doc-slice-graph.mjs, kit/skills/lib/plan-next.mjs, kit/skills/lib/workflow-policy-next.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-plan/scripts/doc-plan-ops.mjs, kit/skills/dev-plan/scripts/doc-audit.mjs, kit/skills/dev-explore/scripts/doc-locate.mjs, kit/skills/dev-explore/scripts/repo-map.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-next.mjs, kit/skills/dev-flow/scripts/flow-cleanup.mjs, "scripts/dev/fixtures*.mjs"]
---

# 对话记忆、全周期两态状态机与受控重开

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-25` |
| 分支 / 基线 | `feat/conversational-lifecycle-model` @ `6416a33` |
| 任务编号 | `conversational-lifecycle-model` |
| 负责人 / 审批 | planner-conv-arch / `false` |
| 规划态 | `interactive`（全部核心决策已拍板确认） |
| 关联 Issue / PR / SPEC | #176 / 未关联 / `docs/archive/specs/261124-issue176-conversational-lifecycle-model-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261124-issue176-conversational-lifecycle-model-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/session-state.mjs`、`kit/skills/lib/session-orient.mjs`、`kit/skills/lib/mutability.mjs` (new)、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/doc-slice-graph.mjs`、`kit/skills/lib/plan-next.mjs`、`kit/skills/lib/workflow-policy-next.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-explore/scripts/doc-locate.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`。
- **复用既有模块**：`kit/skills/lib/session-state.mjs`（`resolveSessionStatePath`）、`kit/skills/lib/ledger.mjs`（`updateTaskLedger`）、`kit/skills/lib/plan-index.mjs`、`kit/skills/lib/git.mjs`（`writeJsonAtomic`）。
- **本期不做**：不修改 Wave 1 的 Critique/Review 槽位钉住逻辑；不修改 CLI 公共参数名与 `SKILL.md` 体积门禁（留待 Wave 3）。
- **门型与回滚路径**：`one-way`；出现问题经 `git revert` 反向提交还原，保持向后兼容读 v1。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C5: `session-state.mjs` 升级至 `schemaVersion: 2`（兼容读 v1），落地 `topics[topicId]`（最多 5 活跃主题、6144 B 上限、`facts` 键值对、`--resolve` 关闭 `open`、`nonGoals`、优先淘汰 `anchors` 且永不静默 FIFO 删除 `facts`）与严格作用域 `markTriageConsumed`/`resolveInheritedTriagePlanMode`；`session-orient.mjs` 完整渲染（无 `.slice(-4)`）且 `includeWorktrees: true` 按新鲜度去重，通过 `node scripts/dev/fixtures.mjs`。
- [x] C6: `doc-plan.mjs` / `doc-plan-ops.mjs` 扩展 `note`（`--topic`、`--fact k=v`、`--resolve`、`--drop`、`--reset`）；`triage` 绑定 `topic` 且省略 `--paths` 时不吸入脏 `git status`；`init` 对 `open.length > 0` 报 `BLOCKED_OPEN_QUESTIONS_UNRESOLVED`（`--allow-open-draft` 仅写主文档并只消费目标主题）；修复 `init --kind prd --multi-spec` 无账本 worktree 陷阱；`doc-locate.mjs` 与 `repo-map.mjs` 默认零写入且仅显式 `--topic` 写 `anchors`，通过 `node scripts/dev/fixtures.mjs`。
- [x] C7: 新增 <= 200 行 `kit/skills/lib/mutability.mjs` (new) 导出 `evaluateMutability` 接入 `doc-plan next`、`clarify`、`flow next`、`flow rework`；`clarifyDoc` 阻断 `LOCKED` 报 `BLOCKED_DOC_FROZEN` + 3 出口，支持 `--drop-criterion C<N> --reason --by user` 且 `checkDocRegression` 区分授权与静默删除；`dropped` 终态接入 `VALID_STATUS_BY_TYPE`、`archive --drop --reason` 与 `flow abort`；`checkOrphanSlices`、`checkMasterCriteriaCoverage` 与 `plan-next` 优先级更新，通过 `node scripts/dev/fixtures.mjs`。
- [x] C8: `flow-lifecycle-helpers.mjs` / `workflow-policy-next.mjs` / `flow-next.mjs` 加固 `flow rework`（默认仅 `changes`/`queueConflict`，`LOCKED` 缺 `--reopen --reason` 报 `BLOCKED_REWORK_REQUIRES_REOPEN`，重开时原子吊销 `reviewTokens` 与 `reviewPassed*` 并退回 `OPEN`），`ambiguous` 暴露 per-task `phase` 与 `mutability` 且仅送就绪/实施任务进 `batch plan`，通过 `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/preflight.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补 C5-C8 正反双向失败回归测试（Red） | `node scripts/dev/fixtures.mjs` 复现红灯 | Wave 1 合并 |
| 2 | 升级 `session-state.mjs` v2 与 `session-orient.mjs`（C5） | `node scripts/dev/fixtures.mjs` 对应组转绿 | 步骤 1 |
| 3 | 扩展 `note`/`triage`/`init` 与 `doc-locate`/`repo-map --topic`（C6） | `node scripts/dev/fixtures.mjs` 对应组转绿 | 步骤 2 |
| 4 | 新建 `mutability.mjs` 并落地 `LOCKED`/`dropped`/1:N/`rework --reopen`（C7-C8） | `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs` 全绿 | 步骤 3 |
| 5 | 同步 `node scripts/equip.mjs .` 与全量门禁验证 | `node scripts/dev/merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `mutability.mjs` 行数超 200 行或与现有状态枚举漂移 | 塞入非纯函数或 I/O 逻辑 | 仅放单一纯函数 `evaluateMutability` 并由单测断言行数 <= 200 |

## 回滚预案

- **出问题时的第一步**：`git revert <commit-sha>` 并重跑 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/fixtures.mjs`。
- **回滚之后要做什么**：保留 v1 兼容断言并更新关联 Issue `#169`。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| Wave 1（`core-state-integrity`） | 账本并发锁与 `clarifyDoc` 基线修复合并进 `main` | Wave 2 开工前 | 协调者 / 审查者 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（等待 Wave 1 合并及本 SPEC 独立 Critique 并 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：对 `docs/archive/specs/261124-issue176-conversational-lifecycle-model-spec.md` 执行 `doc-plan.mjs audit` 并移交独立 Critic 评审。

## 澄清与补充记录

- （本轮无额外澄清补充；待拍板为零）

## 完成后的记录

- **实际验证命令与结果**：`preflight.mjs` 41/41 通过、`fixtures.mjs --jobs 6` 537/537 通过、`verify-injections.mjs --jobs 4` 447/447 捕获、`equip.mjs . --check`、`compose-agents.mjs . --check`、`review.mjs .`、`verify-tools.mjs audit .`、`govern-audit.mjs audit . --strict` 全绿。
- **文档同步检查**：已同步 `docs/TDD.md`、`docs/feature-map.json` 与 `.agents/skills/`（`docs/prd/261124-conversational-state-machine-prd.md` 保持 `active` 且总控 Issue `#169` 保持 `OPEN`）。
- **遗留问题**：无；Slice 3 (`C9..C12`) 留待后续切片推进。
