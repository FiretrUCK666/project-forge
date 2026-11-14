---
name: dev-review
description: |
  独立代码审查、本地严苛预审、不可信外部 PR 供应链拦截、行为/结构双门与门型评估，以及六锁防死循环收敛。
  触发词：代码审查、审一下改动、审查 PR、本地预审、提交前审查、检查 diff、审外部 PR、
  供应链扫描、故障注入审查、复审、打回返工、review、pre-review、untrusted scan。
---

# dev-review

把「独立审查子代理调用」与「开发者日常本地预审」统一到同一个只读打包和记账入口：
`node .agents/skills/dev-review/scripts/review-pack.mjs`。

## 双重模式与入口命令

先运行打包脚本生成上下文隔离的审查包，再开始判读与测试：

```sh
# 模式 A：flow 独立审查子代理 / 外部 PR
node .agents/skills/dev-review/scripts/review-pack.mjs --task <id> [--round <1|2|3>] [--worktree <path>]
node .agents/skills/dev-review/scripts/review-pack.mjs --pr <M> [--untrusted-scan] [--worktree <path>]

# 模式 B：开发者本地日常预审（不提 PR 也可随时运行）
node .agents/skills/dev-review/scripts/review-pack.mjs --local
node .agents/skills/dev-review/scripts/review-pack.mjs --staged
node .agents/skills/dev-review/scripts/review-pack.mjs --base <ref>
```

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

审查包自动检测是否改动了导出 API、CLI 参数、模块增删、环境要求或 `high-risk:` 路径，
却未同步更新 `docs/TDD.md`、`README*.md` 或 `AGENTS.md`；同时检查关联 `docs/todo/`
是否存在未勾选 `- [ ]` 或未归档至 `docs/archive/todo/`，并对照 `AGENTS.md`「## 改哪看哪」生成
`coupledSyncWarnings` 与「联动同步核对（改哪看哪）」章节（触发路径改动却漏同步伴随文件时重点核验）。流程模式下未说明的漂移列为 `Must Fix` 候选。

## 六锁防死循环收敛协议

1. **实证优先与故障注入**：在独立审查 worktree 运行测试；触碰高风险路径时做故障注入
   （改坏一处核心判定 -> 确认测试变红 -> `git checkout -- .` 还原 -> 确认复绿）。形式验证与运行/渲染实证优先于静态读代码，**严禁未经实证的臆测挑刺**。
2. **上下文隔离**：只读冻结验收标准 `C1..Cn`、diff（含 SHA256）、门禁证据与文档对齐单，不读实施闲聊。
3. **噪音过滤与三级分类**：只分 `Must Fix`（阻塞合入）、`Should Fix`（建议）与 `Pre-existing`（历史问题）。
   `Must Fix` 仅限违反已冻结 `C*`、确定性形式门禁失败、或可复现的运行/渲染/交互实证失败；主观代码风格偏好或未经实证验证的静态挑刺不得阻塞合入。Round 1 必须一次性列全同类问题全部位置。
4. **轮次视野动态收窄**：Round 1 审全量 `base...head`；Round 2 只读 R1 未关 `Must Fix` +
   `R1_HEAD..HEAD` + `rebuts`（锁定未改动旧 hunks，禁发新挑刺）；Round 3 只对 `R2_HEAD..HEAD`
   做二元 Pass/Fail 核对。
5. **独立性硬锁**：`record` 时 `--reviewer-id === implementerId` 直接报错 `SELF_REVIEW_REJECTED`（退出码 `2`）。
6. **停损熔断**：轮次 `>= 3` 仍有未收口 `Must Fix`，或同一指纹连续 2 轮重复时，
   输出 `STOP_LOSS_ESCALATE` 并以退出码 `4` 转交人类维护者裁决：

```sh
node .agents/skills/dev-review/scripts/review-pack.mjs record \
  --task <id> --round <1|2|3> --verdict pass|changes \
  --reviewer-id <id> [--must-fix <textOrJson>...] [--rebut-accepted <idOrFp>...]
```

## 输出与下一跳

每条命令均附 `[NEXT STEP]` 明确提示下一合法动作：
- `REVIEW_PASSED`：按 `doorAssessment.mergeAuthority` 进入合并或转交维护者批准；
- `CHANGES_REQUESTED`：实施者在原分支追加修复、重跑验证并更新同一个 PR；
- `STOP_LOSS_ESCALATE`（退出码 `4`）或 `BLOCKED_UNTRUSTED_HAZARD`（退出码 `3`）：立即停循环转交人类。
