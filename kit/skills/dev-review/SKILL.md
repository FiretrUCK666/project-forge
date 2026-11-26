---
name: dev-review
description: |
  独立代码审查、本地严苛预审、不可信外部 PR 供应链拦截、行为/结构双门与门型评估，以及六锁防死循环收敛。
  触发词：代码审查、审一下改动、审查 PR、本地预审、提交前审查、检查 diff、审外部 PR、
  供应链扫描、故障注入审查、复审、打回返工、review、pre-review、untrusted scan。
metadata:
  intent: 本地预审 / 审 PR / 独立双门审查 / 审外部 PR
  intent_local: 本地预审 / 隔离工作树独立双门审查
  script: node .agents/skills/dev-review/scripts/review-pack.mjs
  order: 40
  fallback: 由独立上下文审查者核对 git diff 与本地测试实证，确认无误后再推进合入（未装配 dev-review 技能）
---

# dev-review：评审 → 实证测试-形式验证 → 验收 双门六锁把关器

承接 `dev-flow submit` 提审或本地预审，把「独立审查子代理调用」与「开发者本地日常预审」统一到只读打包与记账入口：
`node .agents/skills/dev-review/scripts/review-pack.mjs`，并在记账时向 `signals.jsonl` 沉淀处置信号供 `dev-govern retro` 复盘进化。

## 双重模式与入口命令

先运行打包脚本生成上下文隔离的审查包，再开始判读与测试：

```sh
# 模式 A：flow 独立审查子代理 / 外部 PR（支持自动推断 --task 与下一 --round，Tier 2 自动同步 review-<id> 并挂载依赖）
node .agents/skills/dev-review/scripts/review-pack.mjs --task <id|auto> [--round <1|2|3>] [--reset-review-slot]
node .agents/skills/dev-review/scripts/review-pack.mjs --pr <M> [--untrusted-scan] [--worktree <path>]

# 模式 B：开发者本地日常预审（支持位置目录 / --dir；--local 与 --task/--pr/--base 互斥）
node .agents/skills/dev-review/scripts/review-pack.mjs --local
node .agents/skills/dev-review/scripts/review-pack.mjs --staged
node .agents/skills/dev-review/scripts/review-pack.mjs --base <ref>

# 先跑实证、E2E 观察与故障注入闭环（写入 {gitCommonDir}/project-forge-flow/ 指纹回执），通过后再取全文 diff：
node .agents/skills/dev-review/scripts/review-pack.mjs check-empirical (--task <id> | --pr <M> | --local | --staged | --base <ref>) [--cmd "<验证命令>"] [--e2e-evidence "<运行观察结论>"] [--artifact <path>]... [--visual-checked] [--visual-evidence "<视觉观察>"] [--visual-blocked-reason "<原因>"] [--json]
node .agents/skills/dev-review/scripts/review-pack.mjs check-fault --phase fail|restore (--task <id> | --pr <M> | --local | --staged | --base <ref>) --cmd "<验证命令>"
node .agents/skills/dev-review/scripts/review-pack.mjs (--task <id> | --pr <M> | --local | --staged | --base <ref>) --include-diff [--e2e-evidence "<观察结论>"|--visual-checked]
```

注：未传 `--include-diff` 时仅输出 `diff.hunkIndex`、业务流/邻域切片与摘要（防撑爆上下文）。解锁 `--include-diff` 前须完成当前 `round`/`headSha`/`workspaceFingerprint` 的以下闭环，否则以退出码 `3` 返回 `BLOCKED_EMPIRICAL_FIRST` 或 `BLOCKED_DIRTY_FAULT_RESIDUE`：
- 跑通 `check-empirical` 与 `check-fault`（`fail` + `restore`）；空 diff 或 `low` 级纯文档（0 运行时文件且无测试命令）免故障注入；
- 附真实 `--e2e-evidence`（写清入口与观察输出，拒填 `"ok"`/`"pass"`/`"lgtm"`/`"done"`/`"已验证"` 等水话，违者 `BLOCKED_SHALLOW_E2E_EVIDENCE`）；E2E 失败自动写入 `signals.jsonl`（`e2e.runtime-fail`）并输出诊断包与分级建单；
- `check-empirical`/`check-fault` 跳过槽同步以保护在测故障与 `--local` 未提交改动；遇冲突态（`MERGE_HEAD`/`REBASE_HEAD`）或 `git diff` 失败直阻断。

## 零预设工具分级实证策略与上下文装配

`review-context.mjs` 按变更文件反查 `docs/feature-map.json` 切片（缺损时 Fail-Soft 轻量预填）与依赖逆邻域，注入受波及 `businessFlows`、相邻模块接口、运行时能力与跨 `>= 2` PR `verify.scratch-used` 提示。**严禁跳过业务流实证直看 `--include-diff`**：
1. **已登记健康工具优先**：功能地图存在未过期工具时优先跑 `verify-tools.mjs run`；高风险过期（`BLOCKED_STALE_HIGH_RISK_TOOL`）硬阻断复用；
2. **复用可用运行能力**：无工具或中风险过期时，复用本机/宿主运行时、无头浏览器、GUI 驱动或模拟器真测受波及业务流与模块边界；
3. **仓外 `scratch/{taskId}/` 现写探针**：缺现成入口时在 `{gitCommonDir}/project-forge-verify/scratch/{taskId}/` 现写一次性探针（不脏仓树，随 `cleanup`/`abort` 销毁，跨 `>= 2` PR 提示固化）；
4. **缺环境如实阻断**：缺外部服务/硬件/凭据无法真跑时如实阻断，绝不假绿。

## 不可信外部 PR 供应链门禁

在 `.worktrees/review-pr-<M>` 挂依赖或跑测试前先跑 `node .agents/skills/dev-review/scripts/review-pack.mjs --pr <M> --untrusted-scan`：
- 扫描 `base...head` 是否触及 `.github/workflows/`、`package.json` 钩子（`preinstall`/`install`/`postinstall`/`prepare`）、`Makefile`/构建脚本、`.husky/`、`.agents/skills/`、`.gitattributes`、锁文件，或删除断言/`skip`/`only`/放宽检查；
- 命中高危且无 `--human-approved-exec` 时输出 `BLOCKED_UNTRUSTED_HAZARD`（退出码 `3`）；须先只读呈现风险给人类，获准后带 `--human-approved-exec --reason "<原因>"` 复跑并配 `--ignore-scripts` 隔离装依赖。

## 行为/结构双门与门型评估

1. **Behavioral Gate（行为与实证门）**：
   - 形式验证（类型/Schema/`arch-rules`/静态门禁）与实证验证（真启运行、E2E、渲染/交互与浅深色截图、CLI 实测）优先于纯读代码挑刺。
   - 核对 `verifiedHead === HEAD` 与 `AGENTS.md` Dev Profile；涉及运行态且配了 `smoke-verify` 时，在审查 worktree 跑通并附 `--e2e-evidence`，解锁 `--include-diff` 后核查 `business-flows` 与冻结 `C*` 实质落地，禁转交人肉代测。
   - `empiricalVisualCheckRequired === true`（含 `.tsx`/`.jsx`/`.vue`/`.svelte`/`.html`/`.css`/`.scss`/`.svg`）须实开渲染界面走通交互并核浅深色截图，禁纯读代码下结论。
2. **Structural Gate（结构与边界门）**：拦截 diff 新增行中的履历墓碑注释、借口/压制标记（`@ts-ignore`/`@ts-nocheck`/`eslint-disable`/`# noqa`/`# type: ignore`/`#[allow(`/`HACK`/`WORKAROUND`/`TEMP`），校验 `arch-rules:` 跨层引用，并对触碰 `>800`（高危 `1500`）行源码预警拆分。
3. **Door Assessment（门型评估）**：判 `two-way` 或 `one-way`（弱化门禁/工作流/发版锁文件/安全与 Schema 迁移/`do-not-edit`/声明 `merge-authority: human`）；`gateWeakened: true` 或不可逆边界锁定 `mergeAuthority = human-required`。

## 代码与文档对齐核验（Doc-Code Parity）

检测导出 API、`cli-surface`、模块增删、环境要求或 `high-risk:` 变动却未同步 `docs/TDD.md`/`README*.md`/`AGENTS.md`，校验 Mermaid `16/12` 宽度，核对关联 `docs/todo/`（含 `contributor-fork` 私有隔离）勾选与 `docs/archive/todo/` 归档，并生成「改哪看哪」`coupledSyncWarnings`；未说明漂移列为 `Must Fix` 候选。

## 六锁防死循环收敛协议

1. **实证优先与故障注入**：审查 worktree 按序跑完 `check-empirical`、`check-fault --phase fail`（真改坏可执行核心判定并变红，拦截空突变 `BLOCKED_FAULT_INJECTION_NOOP`/`BLOCKED_FAULT_NO_MUTATION` 与假绿 `BLOCKED_FAULT_NOT_CAUGHT`）、还原跑 `check-fault --phase restore`（写入 `ledger.faultRecord` 并拦未还原 `BLOCKED_DIRTY_FAULT_RESIDUE`），再按需 `--include-diff`，禁未经实证臆测挑刺。
2. **上下文与切片 `C*` 隔离**：只读当前 SPEC/Todo 冻结 `C1..Cn`（不误拉 `1:N` PRD 全表）、diff（含 SHA256）、门禁证据与对齐单；`low` 风险 PR 可无 `--review-token` 写状态单而不阻直接合入。
3. **噪音过滤与三级分类**：仅分 `Must Fix`（阻塞：`C*` 违反/形式门禁失败/可复现运行或渲染失败）、`Should Fix`（建议）与 `Pre-existing`（历史）；风格偏好或未实证静态挑刺禁阻塞；Round 1 一次列全同类位置。
4. **R2+ 换人、增量视野与 `A4` 基线**：
   - Round 1 审 `base...head`；Round 2+ 必新建独立 `review` 子代理并由 `review-locks.mjs` 拦截——复用历史审稿人报 `BLOCKED_SAME_REVIEWER_REREVIEW`（`3`，`next` 输出 `excludedReviewers`），同 `HEAD` 报 `BLOCKED_SAME_HEAD_REREVIEW`，代码指纹未变报 `BLOCKED_NO_REWORK_CHANGES`（`3`）；
   - `flow.mjs sync` 变基后自动用 `git range-diff` 提取 `!`/`>` 新提交限定视野；Round 2+ 只核未关 `Must Fix`、`prevHead..HEAD` 增量 hunk（±3 行）及 `rebuts`，越界报 `BLOCKED_OUT_OF_SCOPE_MUST_FIX`；`pass` 前核门禁阻断 `BLOCKED_PASS_WITH_OPEN_BLOCKERS`。
5. **独立性与指纹硬锁**：`--reviewer-id === implementerId` 报 `SELF_REVIEW_REJECTED`（`3`）；未决比对按 `(file, summary)` 完整 `fingerprint`，不因不同文件同标 `C*` 误触发停损。
6. **停损熔断与记账双写**：历史已触发停损未解锁时禁 Round 4+ 绕过（退出码 `4` `STOP_LOSS_ESCALATE`，写 `stopLossPacket` 并经 `escalation.mjs` 建追踪单），仅人类 `override` 解锁；支持 `--disposition` 记四类处置统计：

```sh
node .agents/skills/dev-review/scripts/review-pack.mjs record \
  [--task <id>] [--round <N>] --verdict pass|changes --reviewer-id <id> \
  --review-token <由 flow next 现场签发、绑定 round+reviewerId+headSha 的令牌> \
  [--evidence "<命令与输出摘要；省略时自动复用同 HEAD 有效 check-empirical 回执>"] \
  [--must-fix <textOrJson>...] [--should-fix <text>...] [--pre-existing <text>...] \
  [--disposition "<idOrFp>:fixed|rebutted-wrong|intentional|deferred"...] \
  [--rebut-accepted <idOrFp>...] [--resolved <idOrFp>...] [--no-enforce-gates] [--visual-checked]

node .agents/skills/dev-review/scripts/review-pack.mjs override \
  [--task <id>] --human-approved --reason "<裁决理由>"
```

说明：`record` 经 `TaskBackend` 适配三态（`github` 通过单源 `renderReviewSection({ isFull })` 按 `审核不通过（退回）/审核通过 · Round N` 拼装含三固定字段（`逐条标准状态`/`故障注入记录`/`实证核验`，触发停损时条件附 `止损记录`）、`验收标准逐条核对`、`Must Fix`/`Should Fix`/`Pre-existing` 与 `pf-state` 的 PR 完整单，以及有 `prNum` 时含 `file:line` 核心原因与 `PR #N` 指向的 Issue 紧凑摘要单，无 PR 工单则输出完整单，实时双写评论并贴 `changes-requested`/`reviewed` 标签；403 自动降级，离线/`mcp-delegate` 输出 `githubSync.delegatedPayloads`；`generic-git`/`local-only` 写本地台账），同时写入 `signals.jsonl` 供 `dev-govern`（`retro`）进化。

## 输出与下一跳（合入或返工闭环）

每条命令均附 `[NEXT STEP]`（`--json` 同步输出 `nextSteps`）：
- `REVIEW_PASSED`：非弱化门禁且无 `merge-authority: human` 时，确认 `reviewPassedHead === HEAD` 后由**独立审查者或调度者**运行 `flow.mjs merge` 合并 PR 并双写关闭评论（禁实施者自合与自动删分支/worktree），再交回主会话请用户确认 `flow.mjs cleanup --confirm --preview-hash <hash>`；
- `CHANGES_REQUESTED`：实施者在原 `impl` 分支按 `rework` -> `verify` -> `submit` 更新同一 PR，再交**新的独立 `review` 子代理**复核；
- `STOP_LOSS_ESCALATE`（`4`）或 `BLOCKED_EMPIRICAL_FIRST` / `BLOCKED_DIRTY_FAULT_RESIDUE` / `BLOCKED_UNTRUSTED_HAZARD`（`3`）：按 `nextSteps` 补齐实证闭环或交人类 `override` / `--human-approved-exec`；
- **注释与决策复核**：新增注释只写 Why、`HACK`/`WORKAROUND`/`TEMP` 绑定 `#<issue>`、无失效反引号路径、架构取舍同步 `docs/TDD.md` 或 `AGENTS.md ## 取舍`。
