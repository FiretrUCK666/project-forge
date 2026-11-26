---
kind: todo
title: "Review Comment Slimming, Case 2 C1..Cn Parity and Noise Removal"
status: done
created: 2026-11-26
updated: 2026-11-26
issue: 210
pr: 211
branch: feat/review-comment-case2-parity
owner: planner-arch
plan_mode: interactive
approved: false
done_at: 2026-11-26
task_id: review-comment-case2-parity
planned_at: ff2c31b7e9e6762e233fecc57486ddfe04aa085d
related_prd: ../prd/261126-suite-cohesion-v2-prd.md
related_spec: ../specs/261126-issue210-review-comment-case2-parity-spec.md
depends_on: [empirical-handoff-cohesion]
scope_files: [kit/skills/lib/review-comment-render.mjs, kit/skills/lib/doc-comments.mjs, kit/skills/lib/plan-sync.mjs, kit/skills/dev-flow/scripts/flow-context.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-review/scripts/review-sync.mjs, kit/skills/dev-review/SKILL.md, scripts/dev/preflight-contract-rules.mjs, scripts/dev/preflight-contracts.mjs, templates/pull-request-template.md, .github/pull_request_template.md, references/collaboration.md, scripts/dev/fixtures-review-contracts.mjs, scripts/dev/fixtures-flow.mjs, scripts/dev/fixtures-trace-sync.mjs, scripts/dev/injections-data-core.mjs, scripts/dev/injections-data-trace-sync.mjs]
---

# Review Comment Slimming, Case 2 C1..Cn Parity and Noise Removal

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / 基线 | `feat/review-comment-case2-parity` @ `ff2c31b` |
| 任务编号 | `review-comment-case2-parity` |
| 负责人 / 审批 | planner-arch / `false` |
| 规划态 | `interactive`（评论契约与依赖顺序已定案，待拍板为零） |
| 关联 Issue / PR / SPEC | #210 / #211 / `docs/archive/specs/261126-issue210-review-comment-case2-parity-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261126-issue210-review-comment-case2-parity-spec.md`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/review-comment-render.mjs`、`kit/skills/lib/doc-comments.mjs`、`kit/skills/lib/plan-sync.mjs`、`kit/skills/dev-flow/scripts/flow-context.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/scripts/review-sync.mjs`、`kit/skills/dev-review/SKILL.md`、`scripts/dev/preflight-contract-rules.mjs`、`scripts/dev/preflight-contracts.mjs`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`references/collaboration.md`、`scripts/dev/fixtures-review-contracts.mjs`、`scripts/dev/fixtures-flow.mjs`、`scripts/dev/fixtures-trace-sync.mjs`、`scripts/dev/injections-data-core.mjs`、`scripts/dev/injections-data-trace-sync.mjs`。
- **复用既有模块**：`kit/skills/lib/local-issues.mjs`（`getLocalIssue`）、`kit/skills/lib/doc-comments.mjs`、`kit/skills/lib/docs.mjs`。
- **本期不做**：不修改切片一与切片二的 `doc-graph`、实证门禁与合并逻辑；待切片二合并后再启 Wave 2。
- **门型与回滚路径**：`one-way`；出现异常通过 `git revert` 反向提交并重跑 `node scripts/equip.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C9: `flow-context.mjs:76` `summarizeContextBody` 超 1200 字符截断时保留全部 `- [ ] C*` 行；将纯条款解析（含全角 `C1：`）与同步 `getLocalIssue` 回退辅助抽入无环模块 `kit/skills/lib/plan-sync.mjs`（避免与 `review-sync.mjs:18` 循环导入），`review-gates.mjs` 保留 `parseAcceptanceCriteria` 与 L256 `I247` 锚点并委托调用（控 `< 780` 行）；将 `review-sync.mjs` `backend` 实例化上移至 L369 前使异步 `backend.getIssue` 回退在渲染前真实执行，经 `node scripts/dev/fixtures.mjs` 验证通过。
- [x] C10: `kit/skills/lib/review-comment-render.mjs` 落地单源 `renderReviewSection({ isFull })`，PR 与无 PR 工单（`!prNum`）渲染完整结构含 `#### 验收标准逐条核对`，有 `prNum` 时关联 Issue 仅渲染指向 `PR #N` 的紧凑摘要，且 `I248` 保持有效。
- [x] C11: 移除冗余 `对比基线` 行、默认 `止损记录：未触发`、固定 `审查来源`（`REVIEW_FIELDS = ['逐条标准状态', '故障注入记录', '实证核验']` 且仅 `stopLoss === true` 输出 `止损记录`）及 `doc-comments.mjs` / `review-comment-render.mjs` 中内部 `node ".agents/..."` 命令泄漏；取消 `flow-lifecycle.mjs:713-717` `createPr` 后立即追加的冗余 `"提交待审"` PR 评论并同步 `fixtures-flow.mjs:641` 与 `fixtures-trace-sync.mjs:422-430`，复验 `injections-data-trace-sync.mjs:33-47`（`I413`/`I414`）通过。
- [x] C12: 锁步更新 `scripts/dev/preflight-contract-rules.mjs`、`scripts/dev/preflight-contracts.mjs:407-419`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md:95`（`<= 14336` B、`<= 180` 行）、`scripts/dev/fixtures-review-contracts.mjs:16-51`、`scripts/dev/fixtures-flow.mjs:210`、`scripts/dev/injections-data-core.mjs:56-71`（`I7`/`I8`，保 `I247`/`I248`）与 `node scripts/equip.mjs .`，全绿通过 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4` 与 `merge-gate.mjs`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补充 Case 2 长正文/全角/本地回退与精简评论失败夹具（Red） | `node scripts/dev/fixtures.mjs` 复现失败 | 切片二合并 |
| 2 | 改造 `flow-context.mjs`，抽离条款解析与本地回退至无环 `kit/skills/lib/plan-sync.mjs`（控 `review-gates.mjs < 780` 行保 `I247`）并将 `review-sync.mjs` `backend` 上移至 L369 前 | `node scripts/dev/fixtures.mjs` C9 转绿 | 步骤 1 |
| 3 | 重构 `review-comment-render.mjs`、`doc-comments.mjs` 与 `flow-lifecycle.mjs:713-717` | `node scripts/dev/fixtures.mjs` C10-C11 转绿 | 步骤 2 |
| 4 | 锁步更新 `preflight-contract-rules.mjs`、`preflight-contracts.mjs:407-419`、PR 模板、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md:95`、3 个夹具文件与 `I7`/`I8` | `node scripts/dev/preflight.mjs` 与 `fixtures.mjs` 转绿 | 步骤 3 |
| 5 | 执行 `node scripts/equip.mjs .` 并跑全量门禁与故障注入（含 `I413`/`I414`/`I247`/`I248`） | `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4`、`merge-gate.mjs` 全绿 | 步骤 4 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `review-gates.mjs`（792 L）超 800 行或循环导入 `review-sync.mjs` | 直接扩展或反向导入 `review-sync.mjs` | 将纯条款解析与本地工单回退抽入无环 `kit/skills/lib/plan-sync.mjs`，`review-gates.mjs` 控 `< 780` 行 |
| `REVIEW_FIELDS` 调整未同步模板、契约脚本或夹具/注入 | 漏改 `preflight-contracts.mjs`、`kit/skills/dev-review/SKILL.md` 或夹具 | 同一提交内锁步更新全部文件并跑通 `preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs` |

## 回滚预案

- **出问题时的第一步**：执行 `git revert HEAD` 并重跑 `node scripts/equip.mjs .`。
- **回滚用什么**：反向提交 + `node scripts/dev/preflight.mjs` + `node scripts/dev/verify-injections.mjs --jobs 4`。
- **回滚之后要做什么**：同步回退 `REVIEW_FIELDS`、`preflight-contracts.mjs` 与 PR 模板契约声明。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 切片二（`empirical-handoff-cohesion`） | 先合入 `main`，再动 `flow-lifecycle.mjs`、`review-gates.mjs` 与 `kit/skills/dev-review/SKILL.md` | Wave 2 启动前 | 调度者 / 审查者 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`
- **待拍板事项**：无
- **下一步第一件事**：经独立审查与合前门禁验收后合并收尾。

## 澄清与补充记录

- 已根据 Round 1 Critique 补充三字段 `REVIEW_FIELDS`、条件 `止损记录`、`preflight-contracts.mjs:407-419`、`dev-review/SKILL.md:95`、3 个测试夹具与 `I7`/`I8`/`I413`/`I414` 锁步清单，并指定 `review-gates.mjs` 抽离至 `kit/skills/lib/plan-sync.mjs` 且 `backend` 上移至 L369 前。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/equip.mjs .` -> 同步 8 个变更文件，156 个脚本完整性与 ABI 校验通过；
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json` -> `ok: true`，0 blockers；
  - `node scripts/dev/preflight.mjs` -> 41 项读数全绿、0 失败；
  - `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` -> 含 C9-C12 双向正反夹具及 `I7`/`I8`/`I247`/`I248`/`I413`/`I414` 在内的全量门禁通过；
  - `flow.mjs verify --mode gate`（12/12 `merge-gate.mjs`）与 `flow.mjs verify --mode smoke --e2e-evidence` 全绿。
- **文档同步检查**：已同步更新 `templates/pull-request-template.md`、`.github/pull_request_template.md`、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md`、`.agents/skills/` 与 `docs/TDD.md`；`docs/feature-map.json` 经 `verify-tools.mjs audit .` 校验 0 漂移。
- **遗留问题**：无。
