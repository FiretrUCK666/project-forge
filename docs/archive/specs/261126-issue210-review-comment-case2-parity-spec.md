---
kind: spec
title: "Review Comment Slimming, Case 2 C1..Cn Parity and Noise Removal"
status: implemented
tier: L3
created: 2026-11-26
updated: 2026-11-26
issue: 210
pr: null
branch: feat/review-comment-case2-parity
owner: planner-arch
plan_mode: interactive
approved: true
implemented: true
plan_critique: "passed (reviewer=critic-governance-cohesion-r4, round=4, sha=cf09b3f1614e, summary=Verified mechanical lint/naming fixes at 6e6f870; all design invariants and C1..C12 remain intact.)"
related_prd: ../../prd/261126-suite-cohesion-v2-prd.md
related_todo: ../todo/261126-issue210-review-comment-case2-parity-todo.md
high_risk_paths: [kit/, templates/]
task_id: review-comment-case2-parity
depends_on: [empirical-handoff-cohesion]
scope_files: [kit/skills/lib/review-comment-render.mjs, kit/skills/lib/doc-comments.mjs, kit/skills/lib/plan-sync.mjs, kit/skills/dev-flow/scripts/flow-context.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-review/scripts/review-gates.mjs, kit/skills/dev-review/scripts/review-sync.mjs, kit/skills/dev-review/SKILL.md, scripts/dev/preflight-contract-rules.mjs, scripts/dev/preflight-contracts.mjs, templates/pull-request-template.md, .github/pull_request_template.md, references/collaboration.md, scripts/dev/fixtures-review-contracts.mjs, scripts/dev/fixtures-flow.mjs, scripts/dev/fixtures-trace-sync.mjs, scripts/dev/injections-data-core.mjs, scripts/dev/injections-data-trace-sync.mjs]
---

# Review Comment Slimming, Case 2 C1..Cn Parity and Noise Removal — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `implemented`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块评论契约瘦身、Case 2 `C1..Cn` 跨后端无损提取与契约规则锁步改造；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-26` / `2026-11-26` |
| 分支 / Issue / PR | `feat/review-comment-case2-parity` / #210 / 未关联 |
| 负责人 / 内审状态 | planner-arch / `passed` |
| 规划态 | `interactive`（评论字段契约与依赖顺序已由总控 PRD 冻结，待拍板为零） |
| 关联 PRD / Todo | `docs/prd/261126-suite-cohesion-v2-prd.md` / `docs/archive/todo/261126-issue210-review-comment-case2-parity-todo.md` |

- **变更一句话**：保障 Case 2 `C1..Cn` 在截断、全角冒号与本地/远端工单回退下全量不丢，单源瘦身 PR/Issue 审查评论并清除噪音、冗余首评与内部 CLI 命令泄漏，锁步对齐新三字段 `REVIEW_FIELDS`、PR 模板、契约脚本、技能说明、夹具与故障注入。

## 系统变更全景

```mermaid
flowchart LR
  Extract["条款跨端提取"] --> Render["评论单源瘦身"]
  Render --> Sync["清理首评与噪音"]
  Sync --> Rules["模板与规则锁步"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/dev-flow/scripts/flow-context.mjs` | 改造 | `summarizeContextBody` 超过 1200 字符截断时完整保留 `- [ ] C*` 清单行 |
| `kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/lib/plan-sync.mjs`、`kit/skills/dev-review/scripts/review-sync.mjs` | 改造 | 将纯条款解析（含全角 `C1：`）与同步 `getLocalIssue` 回退辅助抽入无环模块 `kit/skills/lib/plan-sync.mjs`（600 行，避免与 `review-sync.mjs:18` 循环导入）；`review-gates.mjs` 保留 `parseAcceptanceCriteria` 与 L256 `I247` 锚点并委托调用（控 `< 780` 行）；`review-sync.mjs:369` 前先实例化 `backend` 以运行异步 `backend.getIssue` 回退 |
| `kit/skills/lib/review-comment-render.mjs`、`doc-comments.mjs` | 改造 | 单源 `renderReviewSection({ isFull })`（PR 与无 PR 工单全量渲染，有 `prNum` 时 Issue 渲染紧凑摘要）；固定 3 字段 + 条件 `止损记录`；清除内部 `node ".agents/..."` 命令；保 `I248` |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` | 改造 | 取消 L713-717 `createPr` 后立即再发的冗余 `"提交待审"` PR 评论 |
| `scripts/dev/preflight-contract-rules.mjs`、`preflight-contracts.mjs`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md` | 改造 | 锁步更新三字段 `REVIEW_FIELDS`、`preflight-contracts.mjs:407-419`、双 PR 模板、协作文档与 `kit/skills/dev-review/SKILL.md:95`（`<= 14336` B） |
| `scripts/dev/fixtures-review-contracts.mjs`、`fixtures-flow.mjs`、`fixtures-trace-sync.mjs`、`injections-data-core.mjs`、`injections-data-trace-sync.mjs` | 改造 | 锁步更新四字段/首评夹具（`fixtures-review-contracts.mjs:16-51`、`fixtures-flow.mjs:210,641`、`fixtures-trace-sync.mjs:422-430`）与 `I7`/`I8`，并复验 `I413`/`I414` |

## 一、背景与边界声明

- **要改什么**：解决 Case 2 `C1..Cn` 在长正文截断、全角冒号、离线本地工单及未缓存 Issue 场景下的丢失问题；重塑 `review-comment-render.mjs` 单源渲染消除 PR 与 Issue 的双份刷屏、低信号固定噪音及内部命令行泄漏；取消 `createPr` 后的多余首条 PR 评论；锁步更新全部契约规则、模板、技能、夹具与故障注入。
- **不改什么**：不修改切片一与切片二的 `doc-graph`、实证门禁与合并逻辑；保留 `review-gates.mjs`（`I247`）、`review-comment-render.mjs`（`I248`）与 `I413`/`I414` 拦截能力。
- **本期不做**：不重写历史已发送的远端 PR/Issue 评论，仅约束新渲染评论；不引入外部模板引擎。
- **依赖与波次**：显式声明 `depends_on: [empirical-handoff-cohesion]`，在 Wave 2 紧接切片二合入后执行，避免 `flow-lifecycle.mjs` 与 `review-gates.mjs` 并行写冲突（Wave 1 保持零交集）。
- **架构基线关系**：`review-gates.mjs`（792 行）严禁反向导入 `review-sync.mjs`（`review-sync.mjs:18` 已导入 `kit/skills/dev-review/scripts/review-gates.mjs`），须将纯条款解析与同步本地工单回退抽入无环模块 `kit/skills/lib/plan-sync.mjs`（600 行，导入 `local-issues.mjs` 严格无环），使 `review-gates.mjs` 保持 `< 780` 行；`kit/skills/dev-review/SKILL.md <= 14336` B 且 `<= 180` 行；`preflight-contract-rules.mjs`、`preflight-contracts.mjs`、两份 PR 模板与 `references/collaboration.md` 必须同提交一致。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **Case 2 `C1..Cn` 跨后端无损提取**：
   - `flow-context.mjs:76` `summarizeContextBody(rawBody, maxLen = 1200)`：当正文长度超过 `maxLen` 时，单独提取全部 `- [ ] C\d+` / `- [x] C\d+` 行拼接保留于截断摘要之后，确保验收条款永不被截掉。
   - `review-gates.mjs` 与 `kit/skills/lib/plan-sync.mjs`：将纯验收条款解析（扩展正则匹配全角 `C1：` 与复选框行）及同步 `getLocalIssue` 回退辅助抽入 `kit/skills/lib/plan-sync.mjs`（`plan-sync.mjs` 单向依赖 `local-issues.mjs`，严格无环）；`review-gates.mjs` 保留 `parseAcceptanceCriteria` 入口与 L256 精确 `I247` 注释/条件 `if (criteria.length === 0) {`，委托 `plan-sync.mjs` 完成解析与本地工单回退，使 `review-gates.mjs` 稳定缩减至 `< 780` 行。
   - `review-sync.mjs:369-433`：将 `backend` 实例化（原 L430-433）上移至 `parseAcceptanceCriteria` / `buildReviewComments`（L369）之前（离线/无远程凭据时仍使用只读/本地能力，不改变 L413-428 离线短路返回），使异步 `backend.getIssue` 回退在构造审查评论表格前真实执行。
2. **单源瘦身 `renderReviewSection({ isFull })` 与去噪**：
   - `kit/skills/lib/review-comment-render.mjs`：重构 `buildReviewComments` 核心渲染为单一函数 `renderReviewSection({ isFull, ... })`：
     - 当渲染 PR 评论或无 PR 工单（`!prNum`，覆盖 `local-only` 与 `generic-git`）时 `isFull = true`，输出含 `#### 验收标准逐条核对` 表与完整 `Must Fix`/`Should Fix`/`Pre-existing` 的高信噪结构；
     - 当 `prNum` 存在且渲染关联 Issue 评论时 `isFull = false`，仅输出紧凑高信号摘要（结论、阻塞定位与 `PR #N` 指向），消除 95% 重复刷屏。
   - **新审查字段契约（3 个固定字段 + 条件止损）**：
     - `REVIEW_FIELDS = ['逐条标准状态', '故障注入记录', '实证核验']`（`preflight-contract-rules.mjs:111`）；
     - 移除冗余 `对比基线` 行（标题已含 `@ baselineText`）；
     - 移除固定不变的 `审查来源` 模板行；
     - 仅在 `stopLoss === true` 时条件输出 `止损记录`（省略默认 `止损记录：未触发`）；
     - 保留 `实证核验`（确保 `I248` 锚点完整有效），并清理 `doc-comments.mjs` 与 `review-comment-render.mjs` 中对外暴露的内部 `node ".agents/..."` 命令字符串，改为可读动作说明。
3. **移除冗余首条 PR 评论与全仓契约/夹具锁步**：
   - `flow-lifecycle.mjs:713-717`：在 `createPr` 成功新建 PR 后，仅向关联 Issue 发送 `已提 PR #N` 摘要评论，不再立即向刚创建的 PR 追加内容重复的 `"提交待审"` 评论（返工与同轮 HEAD 更新复用既有 PR 时照常发评）。
   - **锁步文档与规则替换口径**：
     - `scripts/dev/preflight-contract-rules.mjs:111`：`export const REVIEW_FIELDS = ['逐条标准状态', '故障注入记录', '实证核验']`；
     - `scripts/dev/preflight-contracts.mjs:407-419`：将硬编码 `这四个字段` / `四个字段` 文案改为动态 `${REVIEW_FIELDS.length} 个字段`；
     - `templates/pull-request-template.md` 与 `.github/pull_request_template.md`（L34-35）：统一改为 `逐条标准状态、故障注入记录、实证核验（触发停损时附止损记录；详见独立审查评论）。`；
     - `references/collaboration.md`（L64、L83-86）：同步为三固定字段 + 条件 `止损记录` 与无 `对比基线`/`审查来源` 冗余行；
     - `kit/skills/dev-review/SKILL.md:95`：将 `四字段`、`对比基线` 描述同步为三字段 + 条件止损契约（保持 `<= 14336` B 且 `<= 180` 行）。
   - **锁步测试夹具与故障注入**：
     - `scripts/dev/fixtures-review-contracts.mjs:16-51`：更新字段块用例为新三字段；
     - `scripts/dev/fixtures-flow.mjs:210,641`：L210 移除对 `审查来源`/`止损记录`（非停损）的断言并核对 `实证核验`；L641 校验新建 PR 不发冗余首评而关联 Issue 收到 `已提 PR #99`；
     - `scripts/dev/fixtures-trace-sync.mjs:422-430`：适配首提不再向 PR 发 `"提交待审"` 而同轮二次 `submit`（`isHeadUpdate`）与 Issue 评论均正确落盘；
     - `scripts/dev/injections-data-core.mjs:56-71`（`I7`/`I8`）：同步更新 `REVIEW_FIELDS` 与模板替换字符串；复验 `scripts/dev/injections-data-trace-sync.mjs:33-47`（`I413`/`I414`）及 `I247`/`I248` 保持通过。

### 数据与状态变更

- 不改变 `pf-state` JSON 核心字段；仅将 `REVIEW_FIELDS` 规范化为 `['逐条标准状态', '故障注入记录', '实证核验']` 并同步模板/契约检查与评论展示结构。

### 异常、回退与安全边界

- `getLocalIssue` 与 `backend.getIssue` 回退读取失败时 Fail-Soft 返回空数组，不影响主审查流程；`backend` 实例化上移后不触发多余写请求，L413-428 离线短路语义不变；`preflight-contract-rules.mjs`、`preflight-contracts.mjs`、双 PR 模板与 `references/collaboration.md` 必须同提交一致。

### 实现顺序

1. 改造 `flow-context.mjs:76`；将纯条款解析（含全角 `C1：`）与同步 `getLocalIssue` 回退抽入无环模块 `kit/skills/lib/plan-sync.mjs`（避免与 `review-sync.mjs:18` 循环导入），`review-gates.mjs` 保留 `parseAcceptanceCriteria` 与 L256 `I247` 并委托调用（控 `< 780` 行），并将 `review-sync.mjs` `backend` 实例化上移至 L369 前完成异步 `backend.getIssue` 回退。
2. 重构 `review-comment-render.mjs`（`renderReviewSection({ isFull })`、新三字段 + 条件止损、去噪音去内部 CLI、保 `I248`）与 `doc-comments.mjs`；改造 `flow-lifecycle.mjs:713-717`。
3. 锁步更新 `preflight-contract-rules.mjs`、`preflight-contracts.mjs:407-419`、双 PR 模板、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md:95`、`fixtures-review-contracts.mjs:16-51`、`fixtures-flow.mjs:210,641`、`fixtures-trace-sync.mjs:422-430`、`injections-data-core.mjs:56-71`（`I7`/`I8`）并复验 `injections-data-trace-sync.mjs:33-47`（`I413`/`I414`）。
4. 执行 `node scripts/equip.mjs .` 并跑通全量门禁。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 保留 PR 与 Issue 两套独立拼接数组 | 在 `buildReviewComments` 分别维护 `prLines`/`issueLines` | `local-only`/`generic-git` 无 PR 时缺失逐条核对表且重复逻辑易漂移 | 永不改回 |
| `review-gates.mjs` 原地加本地回退代码 | 在 792 行文件直接扩张 | 极易突破 800 行硬红线 | 永不改回 |
| 仅改模板不改 `preflight-contracts.mjs` 与 `fixtures-*` | 局部修改渲染输出 | `preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs` 立即失败 | 永不改回 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/dev-flow/scripts/flow-context.mjs`、`kit/skills/lib/plan-sync.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`review-sync.mjs` | 修改 | 截断保 `C*`、条款解析与本地回退抽入无环 `plan-sync.mjs`（`review-gates.mjs < 780` 行保 `I247`）、全角 `C1：`、`backend` 前置至 L369 前执行异步回退 | Case 2 审查与双写 |
| `kit/skills/lib/review-comment-render.mjs`、`doc-comments.mjs` | 修改 | `renderReviewSection({ isFull })`、三固定字段 + 条件止损、去噪音与内部 CLI | PR/Issue 评论输出 |
| `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` | 修改 | 移除 L713-717 `createPr` 后首条冗余 PR 评论 | `flow submit` 首次建 PR |
| `preflight-contract-rules.mjs`、`preflight-contracts.mjs`、双 PR 模板、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md` | 修改 | `REVIEW_FIELDS`、动态字段计数文案、模板、协作文档与 `dev-review/SKILL.md:95` 锁步 | 静态契约门禁与模板 |
| `fixtures-review-contracts.mjs`、`fixtures-flow.mjs`、`fixtures-trace-sync.mjs`、`injections-data-core.mjs`、`injections-data-trace-sync.mjs` | 修改 / 复验 | 对齐新三字段、首评行为与 `I7`/`I8`；复验 `I413`/`I414` | 测试与故障注入门禁 |

- **对外可见的变化**：PR 与 Issue 审查评论精简为 3 固定字段 + 条件止损，对无 PR 工单补全逐条核对表；首次建 PR 不再自发冗余 `"提交待审"` PR 评论；Case 2 全角/长正文 `C1..Cn` 完整保留。
- **需要同步改的地方**：运行 `node scripts/equip.mjs .`；同提交锁步更新全部 5 处契约/文档与 5 处夹具/注入文件。

## 五、冻结的验收标准

- [x] C9: `flow-context.mjs:76` `summarizeContextBody` 在超 1200 字符截断时完整保留 `- [ ] C*` 行；将纯条款解析（含全角 `C1：`）与同步 `getLocalIssue` 回退辅助抽入无环模块 `kit/skills/lib/plan-sync.mjs`（避免与 `review-sync.mjs:18` 循环导入），`review-gates.mjs` 保留 `parseAcceptanceCriteria` 与 L256 `I247` 锚点并委托调用（控 `< 780` 行）；将 `review-sync.mjs` `backend` 实例化上移至 L369 前使异步 `backend.getIssue` 回退在渲染前真实执行，经正反夹具验证通过。
- [x] C10: `kit/skills/lib/review-comment-render.mjs` 通过单一 `renderReviewSection({ isFull })` 渲染，PR 与无 PR 工单（`!prNum`）输出完整结构含 `#### 验收标准逐条核对`，有 `prNum` 时关联 Issue 输出指向 `PR #N` 的紧凑摘要，且 `I248` 保持拦截。
- [x] C11: 清除冗余 `对比基线` 行、默认 `止损记录：未触发`、固定 `审查来源`（`REVIEW_FIELDS = ['逐条标准状态', '故障注入记录', '实证核验']` 且仅 `stopLoss === true` 渲染 `止损记录`）及 `doc-comments.mjs` / `review-comment-render.mjs` 中内部 `node ".agents/..."` 命令泄漏；取消 `flow-lifecycle.mjs:713-717` `createPr` 后立即发送的冗余 `"提交待审"` PR 评论并同步 `fixtures-flow.mjs:641` 与 `fixtures-trace-sync.mjs:422-430`，复验 `injections-data-trace-sync.mjs:33-47`（`I413`/`I414`）通过。
- [x] C12: 锁步更新 `scripts/dev/preflight-contract-rules.mjs`、`scripts/dev/preflight-contracts.mjs:407-419`、`templates/pull-request-template.md`、`.github/pull_request_template.md`、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md:95`（`<= 14336` B、`<= 180` 行）、`scripts/dev/fixtures-review-contracts.mjs:16-51`、`scripts/dev/fixtures-flow.mjs:210`、`scripts/dev/injections-data-core.mjs:56-71`（`I7`/`I8`，保 `I247`/`I248`）与 `node scripts/equip.mjs .`，全绿通过 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4` 与 `merge-gate.mjs`。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`；回滚做法：执行 `git revert` 并重跑 `node scripts/equip.mjs .`。
- **高风险路径**：触及 `kit/` 与 `templates/`（评论契约字段、PR 模板与 `preflight` 规则）。
- **故障注入预演**：锁步更新 `I7`/`I8`（`injections-data-core.mjs:56-71`），复验 `I247`、`I248`、`I413`、`I414`，运行 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿。

## 澄清与补充记录

- 已根据 Round 1 Critique 明确 `REVIEW_FIELDS` 三字段数组与条件止损契约，补充 `preflight-contracts.mjs`、`kit/skills/dev-review/SKILL.md` 与全套夹具/注入到 `scope_files` 及 `C9`/`C11`/`C12`，并指定 `review-gates.mjs` 本地回退抽离至 `kit/skills/lib/plan-sync.mjs` 且 `backend` 上移至 L369 前。

## 实现说明

- **实际落地摘要**：
  - C9：在 `kit/skills/dev-flow/scripts/flow-context.mjs` 的 `summarizeContextBody` 中支持超 1200 字符截断时完整保留 `- [ ] C*` 行并修剪落在清单行中段的截断残尾；将纯条款解析 `extractCriteriaFromBodyText`（兼容全角 `C1：`、加粗与未编号复选框，跳过围栏代码块）及同步 `getLocalIssue` 回退辅助 `appendFallbackCriteriaFromTask` 抽入无环模块 `kit/skills/lib/plan-sync.mjs`（657 行）；`kit/skills/dev-review/scripts/review-gates.mjs` 缩减至 762 行（`< 780`）并完整保留 `I247` 锚点；`kit/skills/dev-review/scripts/review-sync.mjs` 将 `backend` 实例化前置至 `parseAcceptanceCriteria` 前，在线凭据有效时异步回退 `backend.getIssue` 补全条款且保持离线短路语义不变。
  - C10-C11：在 `kit/skills/lib/review-comment-render.mjs` 落地单源 `renderReviewSection({ isFull })`（PR 与无 PR 工单 `!prNum` 全量输出含 `#### 验收标准逐条核对`，关联 PR 的 Issue 输出紧凑指针摘要，保留 `I248` 锚点），去除 `对比基线`、默认 `止损记录：未触发` 与 `审查来源`（仅 `stopLoss === true` 条件渲染 `止损记录`），清理 `review-comment-render.mjs` 与 `doc-comments.mjs` 中对外暴露的内部 `node ".agents/..."` / `.mjs` CLI 命令；取消 `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` 中 `createPr` 后立即发送的冗余 `"提交待审"` PR 评论（保留关联 Issue 的 `已提 PR #N` 与复用 PR 的 `提交更新`/`返工已提交`）。
  - C12：锁步同步 `REVIEW_FIELDS = ['逐条标准状态', '故障注入记录', '实证核验']` 至 `scripts/dev/preflight-contract-rules.mjs`、`scripts/dev/preflight-contracts.mjs`、双 PR 模板、`references/collaboration.md`、`kit/skills/dev-review/SKILL.md`（105 行 / 11,977 B）、`scripts/dev/fixtures-review-contracts.mjs`、`scripts/dev/fixtures-flow.mjs`、`scripts/dev/fixtures-trace-sync.mjs` 与 `scripts/dev/injections-data-core.mjs`（`I7`/`I8`），复验 `I247`/`I248`/`I413`/`I414` 并运行 `node scripts/equip.mjs .`。
- **与草案的差异**：无核心差异；`summarizeContextBody` 额外处理了截断边界恰落在清单行中段（如 `- [ ] C` 处）的场景，避免半截行遮蔽完整 `C*` 条款；`flow-lifecycle.mjs` 因切片二合入后行号平移至 L753-763，对应改动保持一致。
- **关联同步文件**：`.agents/skills/`（经 `node scripts/equip.mjs .` 同步）、`docs/TDD.md`、`.github/pull_request_template.md`、`templates/pull-request-template.md`、`references/collaboration.md`。
