---
name: dev-review
description: |
  独立代码审查、本地严苛预审、不可信外部 PR 供应链拦截、行为/结构双门与门型评估，以及六锁防死循环收敛。
  触发词：代码审查、审一下改动、审查 PR、本地预审、提交前审查、检查 diff、审外部 PR、
  供应链扫描、故障注入审查、复审、打回返工、review、pre-review、untrusted scan。
metadata:
  tier: full
  intent: 本地预审 / 独立双门审查 / 审外部 PR
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

# 先跑实证与故障注入闭环（写入 {gitCommonDir}/project-forge-flow/ 指纹回执），通过后再取全文 diff：
node .agents/skills/dev-review/scripts/review-pack.mjs check-empirical (--task <id> | --pr <M> | --local | --staged | --base <ref>) [--cmd "<验证命令>"]
node .agents/skills/dev-review/scripts/review-pack.mjs check-fault --phase fail|restore (--task <id> | --pr <M> | --local | --staged | --base <ref>) --cmd "<验证命令>"
node .agents/skills/dev-review/scripts/review-pack.mjs (--task <id> | --pr <M> | --local | --staged | --base <ref>) --include-diff [--visual-checked]
```

注：未传 `--include-diff` 时，JSON 与纯文本均只输出 `diff.hunkIndex` 与统计摘要（不输出补丁行，防止绕过或撑爆上下文）；传 `--include-diff` 前须完成当前 `round`/`headSha`/`workspaceFingerprint` 的 `check-empirical` 与 `check-fault`（`fail` + `restore`）闭环，否则以退出码 `3` 返回 `BLOCKED_EMPIRICAL_FIRST` 或 `BLOCKED_DIRTY_FAULT_RESIDUE`。`check-empirical` 与 `check-fault` 跳过 `syncTier2ReviewSlotIfNeeded` 保护在测故障与 `--local` 原未提交改动；空 diff 或 `low` 级纯文档（0 运行时文件且无测试命令）免除故障注入；遇冲突态（`MERGE_HEAD`/`REBASE_HEAD`）或 `git diff` 失败直接报错阻断。

## 不可信外部 PR 供应链门禁

在 `.worktrees/review-pr-<M>` 挂载依赖或执行任何构建/测试命令前，必须先跑静态扫描：

```sh
node .agents/skills/dev-review/scripts/review-pack.mjs --pr <M> --untrusted-scan
```

- 扫描 `base...head` 是否触碰 `.github/workflows/`、`package.json` 生命周期钩子
  （`preinstall`/`install`/`postinstall`/`prepare`）、`Makefile`/构建脚本、`.husky/`、
  `.agents/skills/`、`.gitattributes`、依赖锁文件，或出现测试断言删除、`skip`/`only`、放宽检查。
- 命中任一高危项且未传 `--human-approved-exec` 时，脚本输出 `BLOCKED_UNTRUSTED_HAZARD`
  并以退出码 `3` 硬阻断自动执行。
- 必须先只读呈现风险给人类维护者；取得明确同意后，方可带 `--human-approved-exec`
  复跑，并在安装依赖时使用 `--ignore-scripts` 隔离。

## 行为/结构双门与门型评估

审查包按固定框架拆出三段评估（`--json` 与文本输出同步提供）：

1. **Behavioral Gate（行为与运行时实证门）**：
   - **验证优先级**：形式验证（确定性静态检查：类型、Schema、`arch-rules`、静态规则门禁）与实证验证（真实启动运行、端到端操作、界面/网页/视觉资产实际打开渲染并截图检查交互与浅深色排版、CLI/接口真实输入输出核验）**优先于纯对抗式静态读代码挑刺**。
   - 核对 `verifiedHead === HEAD` 与 `AGENTS.md` Dev Profile 中的
     `quick-test` / `smoke-verify` / `full-test` / `merge-gate`。
   - 若本次改动涉及运行态代码且配置了 `smoke-verify`，审查员必须在独立审查
     worktree 本地运行 `smoke-verify` 并核验真实输出，**严禁把未验证的运行路径转交人肉代测**。
   - 若 `behavioralGate.empiricalVisualCheckRequired === true`（变更含 `.tsx`/`.jsx`/`.vue`/`.svelte`/`.html`/`.css`/`.scss`/`.svg`），必须实际打开渲染界面或视觉资产、走通核心用户交互流程并核对浅色/深色主题截图，**不得仅凭静态读代码下结论**。
2. **Structural Gate（结构与边界门）**：
   - 扫描 diff 新增行中的**履历墓碑注释**（如记录“以前是/后来改成/deprecated since”）与
     **借口/压制标记**（`@ts-ignore`、`@ts-nocheck`、`eslint-disable`、`# noqa`、`# type: ignore`、
     `#[allow(`、`HACK`、`WORKAROUND`、`TEMP`），要求追根因解决而非压制检查。
   - 对照 `AGENTS.md` `arch-rules:`（`fromGlob -> toGlob`）静态校验跨层反向引用违规。
   - 对触碰超过 `800` 行（高危 `1500` 行）的源码文件发出结构拆分预警。
3. **Door Assessment（单向门 / 双向门与爆炸半径）**：
   - `doorType` 判为 `two-way`（可逆代码/测试/文档改动）或 `one-way`（弱化门禁、工作流/钩子、
     发版包装/锁文件、安全/Schema 迁移、`do-not-edit` 触碰或仓库声明 `merge-authority: human`）。
   - `gateWeakened: true` 或涉及发版与不可逆边界时，`mergeAuthority` 锁定为 `human-required`。

## 代码与文档对齐核验（Doc-Code Parity）

审查包自动检测是否改动了导出 API、CLI 参数（`cli-surface`）、模块增删、环境要求或 `high-risk:` 路径，
却未同步更新 `docs/TDD.md`、`README*.md` 或 `AGENTS.md`；校验改动 Markdown 中的 Mermaid `16/12` 防截断宽度；同时检查关联 `docs/todo/`（含 `contributor-fork` 私有隔离目录）是否存在未勾选 `- [ ]` 或未归档至 `docs/archive/todo/`，并对照 `AGENTS.md`「## 改哪看哪」生成 `coupledSyncWarnings` 与「联动同步核对（改哪看哪）」章节。流程模式下未说明的漂移列为 `Must Fix` 候选。

## 六锁防死循环收敛协议

1. **实证优先与故障注入**：在独立审查 worktree 按序跑完 `check-empirical`、`check-fault --phase fail`（改坏一处核心判定并确认变红，拦截空突变 `BLOCKED_FAULT_NO_MUTATION` 与假通过 `BLOCKED_FAULT_NOT_CAUGHT`）、还原并跑 `check-fault --phase restore`（自动写入 `ledger.faultRecord` 并在 `record`/`sync` 自动读取，拦截未还原 `BLOCKED_DIRTY_FAULT_RESIDUE`），之后再按需 `--include-diff`。形式验证与运行/渲染实证优先于静态读代码，**严禁未经实证的臆测挑刺**。
2. **上下文隔离与切片 `C*` 隔离**：只读当前任务 SPEC/Todo 冻结验收标准 `C1..Cn`（不误拉 `1:N` 总控 PRD 全表）、diff（含 SHA256）、门禁证据与文档对齐单，不读实施闲聊；`low` 风险 PR 可选无 `--review-token` 运行 `review-pack record` 写状态单而不影响直接合入。
3. **噪音过滤与三级分类**：只分 `Must Fix`（阻塞合入）、`Should Fix`（建议）与 `Pre-existing`（历史问题）。
   `Must Fix` 仅限违反已冻结 `C*`、确定性形式门禁失败、或可复现的运行/渲染/交互实证失败；主观代码风格偏好或未经实证验证的静态挑刺不得阻塞合入。Round 1 必须一次性列全同类问题全部位置。
4. **轮次视野收窄、全历史换人与 `A4` 基线防空转**：Round 1 审全量 `base...head` 并一次列全同类问题；**Round 2+ 永远新建独立 `review` 子代理并在 `review-locks.mjs` 硬拦截下复审**——复用任意历史轮次审稿人返回 `BLOCKED_SAME_REVIEWER_REREVIEW`（退出码 `2`，`flow.mjs next` 输出 `excludedReviewers`），同 `HEAD` 原地复审返回 `BLOCKED_SAME_HEAD_REREVIEW`，相对 `baseSha` 代码差异指纹未变返回 `BLOCKED_NO_REWORK_CHANGES`（退出码 `2`）；若分支经 `flow.mjs sync`（`GIT_EDITOR=true` 非交互变基）同步，自动通过 `git range-diff` 提取 `!`/`>` 新侧提交限定增量视野；Round 2+ 只核前轮未关 `Must Fix`、`prevHead..HEAD` 增量 hunk（±3 行）及 `rebuts`，对未改旧行或无据主观新挑刺返回 `BLOCKED_OUT_OF_SCOPE_MUST_FIX`；`pass` 前核对未清失败实证或 `--enforce-gates` 门禁（`BLOCKED_PASS_WITH_OPEN_BLOCKERS`）。
5. **独立性与跨文件指纹硬锁**：`record` 时 `--reviewer-id === implementerId` 直接报错 `SELF_REVIEW_REJECTED`（退出码 `2`）；连续未决比对按完整 `fingerprint` / `(file, summary)`，绝不因不同文件同标 `C*` 误触发停损。
6. **停损熔断、结构化证据包与统一分级建单**：历史已触发停损且未解锁时，禁止通过 Round 4+ `pass`/`changes` 绕过（退出码 `4` `STOP_LOSS_ESCALATE`，并落盘 `stopLossPacket` 与 `escalation.mjs` 按等级创建追踪工单）；人类拍板放行后用 `override` 解锁（支持 `--disposition` 记录四类处置统计）：

```sh
node .agents/skills/dev-review/scripts/review-pack.mjs record \
  [--task <id>] [--round <N>] --verdict pass|changes --reviewer-id <id> \
  --review-token <由 flow next 现场签发的令牌，只能消费一次> \
  [--must-fix <textOrJson>...] [--should-fix <text>...] [--pre-existing <text>...] \
  [--disposition "<idOrFp>:fixed|rebutted-wrong|intentional|deferred"...] \
  [--rebut-accepted <idOrFp>...] [--resolved <idOrFp>...] [--enforce-gates] [--visual-checked]

node .agents/skills/dev-review/scripts/review-pack.mjs override \
  [--task <id>] --human-approved --reason "<裁决理由>"
```

说明：`record` 在存在关联 PR 或 `linkedIssues` 且处于 GitHub 在线环境时，会自动拼装规范化结构双写评论（标题统一以 `审核不通过（退回）/审核通过 · Round N` 开头；PR 完整审查单含四字段、`对比基线`、`验收标准逐条核对` 表、`Must Fix` 编号展开/`Should Fix`/`Pre-existing` 与 `pf-state`；Issue 摘要单含每条 `Must Fix` `file:line` 核心原因）**实时双写至 PR 与关联 Issue 评论**，并按裁决贴 `changes-requested` / `reviewed` 标签；403 自动降级，离线或 `mcp-delegate` 无直连凭据时在 `githubSync.delegatedPayloads` 产出各目标完整渲染正文供宿主 MCP 原样双写，同时写入 `<gitCommonDir>/project-forge-govern/signals.jsonl` 供 `dev-govern`（`retro`）统计误报率与下沉规则。

## 输出与下一跳（合入或返工闭环）

每条命令均附 `[NEXT STEP]` 明确提示下一合法动作：
- `REVIEW_PASSED`：若未触发门禁弱化且未声明 `merge-authority: human`，**由当前最终通过审查的独立审查子代理直接运行 `node .agents/skills/dev-flow/scripts/flow.mjs merge` 合并 PR 并双写关闭评论**（严禁自动删除分支/worktree）；随后交回主会话向用户确认 `flow.mjs cleanup --confirm` 清理范围；
- `CHANGES_REQUESTED`：实施者在原 `impl` 分支追加修复（`dev-flow` 的 `rework` -> `verify` -> `submit --rework` 更新同一 PR 并刷新评论），再由**新的独立 `review` 子代理上下文**复核；
- `STOP_LOSS_ESCALATE`（退出码 `4`）或 `BLOCKED_EMPIRICAL_FIRST` / `BLOCKED_DIRTY_FAULT_RESIDUE` / `BLOCKED_UNTRUSTED_HAZARD`（退出码 `3`）：按返回 `nextSteps` 先完成实证与故障注入闭环（或外部高危项交人类 `override` / `--human-approved-exec`）。
