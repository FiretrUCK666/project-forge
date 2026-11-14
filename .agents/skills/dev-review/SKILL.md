---
name: dev-review
description: |
  独立代码审查、本地严苛预审、不可信外部 PR 供应链拦截、代码与文档对齐核验，以及六锁防死循环收敛。
  触发词：代码审查、审一下改动、审查 PR、本地预审、提交前审查、检查 diff、审外部 PR、
  供应链扫描、故障注入审查、复审、打回返工、review、pre-review、untrusted scan。
---

# dev-review

把「flow 独立审查子代理调用」与「开发者日常本地预审」统一到同一个只读打包和记账入口：
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

## 代码与文档对齐核验（Doc-Code Parity）

审查包会自动检测本轮 diff 是否改动了导出 API、CLI 参数、模块增删、环境要求或
`AGENTS.md` 中的 `high-risk:` 路径，却未同步更新 `docs/TDD.md`、`README*.md` 或 `AGENTS.md`；
同时检查关联 `docs/todo/` 文件是否存在未勾选 `- [ ]` 或未归档至 `docs/archive/todo/`。
流程模式下未说明原因的文档漂移与未闭环 Todo 直接列为 `Must Fix` 候选。

## 六锁防死循环收敛协议

1. **实证优先与故障注入**：在独立审查 worktree 中运行 `AGENTS.md` Dev Profile 列出的测试命令，
   触碰高风险路径时必须做故障注入（改坏一处核心判定 -> 确认测试变红 -> `git checkout -- .` 还原
   -> 确认复绿）。**严禁未验证的臆测挑刺。**
2. **上下文隔离**：审查包仅汇总冻结验收标准 `C1..Cn`、diff（含 SHA256 与字节数）、门禁证据
   （核验 `verifiedHead === HEAD`）与文档对齐单，绝不读取实施者闲聊过程。
3. **噪音过滤与三级分类**：结论只分 `Must Fix`（阻塞合入：违背 `C*`、破坏测试/安全/契约）、
   `Should Fix`（非阻塞建议）与 `Pre-existing`（历史既有问题不阻塞）。Round 1 必须把同类问题
   的所有位置一次性列全。
4. **轮次视野动态收窄**：
   - **Round 1**：审全量 `base...head` diff；
   - **Round 2**：只读 R1 未关 `Must Fix` 账本 + `R1_HEAD..HEAD` 增量 diff + 实施者 `rebuts`，
     锁定未改动的 R1 hunks，禁止对未改旧代码发新挑刺；
   - **Round 3**：只审 `R2_HEAD..HEAD` 增量修复行，作二元 Pass/Fail 核对。
5. **独立性硬锁**：记录结论时若 `--reviewer-id` 与 `implementerId` 相同，脚本直接报错
   （`SELF_REVIEW_REJECTED`，退出码 `2`）拒绝记通过。
6. **停损熔断**：使用 `record` 录入每轮结果；当轮次 `>= 3` 仍有未闭环 `Must Fix`，或同一问题
   指纹连续 2 轮重复出现时，输出 `STOP_LOSS_ESCALATE` 并以退出码 `4` 转交人类维护者裁决：

```sh
node .agents/skills/dev-review/scripts/review-pack.mjs record \
  --task <id> --round <1|2|3> --verdict pass|changes \
  --reviewer-id <id> [--must-fix <textOrJson>...] [--rebut-accepted <idOrFp>...]
```

## 输出与下一跳

每条命令均附带 `[NEXT STEP]` 明确提示下一合法动作：
- `REVIEW_PASSED`：可交由合并流程收尾（注意遵守仓库合并授权规则）。
- `CHANGES_REQUESTED`：实施者在原分支返工提交、重跑验证并更新同一个 PR 后进入下一轮。
- `STOP_LOSS_ESCALATE`（退出码 `4`）或 `BLOCKED_UNTRUSTED_HAZARD`（退出码 `3`）：
  立即停止自动循环，提交摘要请求人类维护者裁决。
