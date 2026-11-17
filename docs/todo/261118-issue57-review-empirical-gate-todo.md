---
kind: todo
title: 强制审查先跑实证与故障注入再允许 --include-diff
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 57
pr: null
branch: feat/review-empirical-gate
owner: FiretrUCK666
approved: true
done_at: null
task_id: issue-57
planned_at: 9e966352f10318a0893c9cb722fe7c0a9f59ab0f
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261118-issue57-review-empirical-gate-spec.md
---

# 强制审查先跑实证与故障注入再允许 --include-diff

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | `feat/review-empirical-gate` @ `9e96635` |
| 任务编号 | `issue-57` |
| 负责人 / 审批 | planner-57 / `false` |
| 关联 Issue / PR / SPEC | #57 / 未关联 / `docs/specs/261118-issue57-review-empirical-gate-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交，并在实施前确认所属 SPEC 已获 `approved: true`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-review/scripts/review-empirical.mjs` (new)、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/SKILL.md`、`kit/skills/lib/handoff-package.mjs`、`scripts/dev/fixtures-review-empirical.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`review-diff.mjs`（`EXIT`、`collectDiff`、`resolveReviewWorktree`、`syncTier2ReviewSlotIfNeeded`）、`cli.mjs`、`git.mjs`、`profile.mjs`、`review-gates.mjs`（`assessBehavioralGate`）
- **本期不做**：不新增任何跳过实证的开关，不改动 `workflow-policy.mjs`、`flow-lifecycle.mjs` 与 `dev-plan` 相关脚本
- **门型与回滚路径**：one-way（强化独立审查门禁）；执行 git revert 即可无损恢复，运行态状态仅存 `{gitCommonDir}/project-forge-flow/`
- **快测命令**：`node scripts/dev/fixtures.mjs --domain review-empirical`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。**编号与 SPEC 一一对应。**

- [x] C1: （全模式前置阻断与纯文本旁路封堵）在 `--task`、`--pr`、`--local`/`--staged`/`--base` 模式下，在当前 `round` + `headSha` + `workspaceFingerprint` 尚未完成所需实证与故障注入闭环前，运行 `review-pack.mjs` 并带 `--include-diff`（无论是否带 `--json`）必须以退出码 `3` 阻断并输出 `BLOCKED_EMPIRICAL_FIRST`（JSON 中无 `diffText`，文本中无原始 diff 行，并列出 `missingSteps` 与可执行解封命令）；不带 `--include-diff` 的纯文本输出仅含 `diff.hunkIndex`/统计摘要，不打印 `formatPackText` 240 行原始补丁，且既有非 `--include-diff` 机械包（如 `fixtures-docs.mjs`、`fixtures-flow.mjs`、`fixtures-govern.mjs`）继续全部通过。
- [x] C2: （非空实证与两阶段故障注入解锁）执行「机械包 -> `check-empirical`（实跑命令退出 `0`）-> 修改故障并跑 `check-fault --phase fail --cmd ...` -> 还原并跑 `check-fault --phase restore --cmd ...`」完整链路后，`review-pack.mjs` 带 `--include-diff` 放行并返回退出码 `0`（`diffIncluded: true` 与完整 `diffText`）；**反向拦截**：`check-fault --phase fail` 在工作区未改动时必须报 `BLOCKED_FAULT_NO_MUTATION`（退出码 `3`），在故障下命令仍退出 `0` 时必须报 `BLOCKED_FAULT_NOT_CAUGHT`（退出码 `3`），未还原时 `--phase restore` 或 `--task` 带 `--include-diff` 必须报 `BLOCKED_DIRTY_FAULT_RESIDUE`（退出码 `3`）。
- [x] C3: （多轮失效、Slot 保护与纯文档/外部 PR 兼容）`check-empirical` 与 `check-fault` 不触发 `syncTier2ReviewSlotIfNeeded` 重置，不会洗掉 `--phase fail` 已注入故障，也不会破坏 `--local` 模式原有的未提交改动（仅比对还原回 `baselineFingerprint`）；Round 2+ 新提交、`flow sync` `range-diff` 变基或 `--local` 继续改文件后，旧实证凭证立即失效并重新阻断 `--include-diff`；空 diff 或 `0` 运行时文件且无测试命令的 `low` 级纯文档改动不被故障注入死锁；外部 `--pr` 在 `check-empirical` / `check-fault` 前未过 `--untrusted-scan`（或未批准高危项）时继续返回退出码 `3`（`BLOCKED_UNTRUSTED_HAZARD`）。
- [x] C4: （双向夹具、故障注入与全量门禁）`node scripts/dev/fixtures.mjs` 全量通过（支持 `--domain review-empirical` 单独跑 `scripts/dev/fixtures-review-empirical.mjs` (new) 覆盖 `--task`/`--pr`/`--local` 的双向断言）；`node scripts/dev/verify-injections.mjs` 验证预留故障注入 `I131..I133`（`I131` 关闭前置阻断、`I132` 跳过无突变检测、`I133` 恢复纯文本明文 diff 泄露）全部变红失败；`kit/skills/dev-review/scripts/*.mjs` 均不超过 `800` 行；`node scripts/equip.mjs . --check` 与 `merge-gate` 全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 在 `scripts/dev/fixtures-review-empirical.mjs` (new) 编写 C1–C3 失败复现用例（Red）并在 `scripts/dev/fixtures.mjs` 注册 `review-empirical` | `node scripts/dev/fixtures.mjs --domain review-empirical` 在 `--include-diff` 前置拦截断言精准失败 | 无 |
| 2 | 新增 `kit/skills/dev-review/scripts/review-empirical.mjs` (new)，改造 `review-pack.mjs`、`review-gates.mjs`、`SKILL.md` 与 `handoff-package.mjs` | `node scripts/dev/fixtures.mjs --domain review-empirical` 全绿，各脚本 `<= 800` 行 | 步骤 1 |
| 3 | 运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`，在 `scripts/dev/injections-data.mjs` 补充 `I131..I133` 故障注入并通过全量门禁 | `node scripts/dev/verify-injections.mjs`、`equip --check` 与 `merge-gate` 全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`已完成`（C1..C4 实施与本地全量门禁已通过，准备按流程归档、verify、submit）
- **待拍板事项**：无
- **下一步第一件事**：运行 `flow.mjs finalize`、`verify --mode gate` 与 `submit --task issue-57` 提交 PR 交由独立审查子代理复核。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/dev/fixtures.mjs --domain review-empirical`：4/4 通过，0 失败；全量 `node scripts/dev/fixtures.mjs`：229/229 通过，0 失败。
  - `node scripts/dev/verify-injections.mjs --only I131`、`I132`、`I133` 与全量 `node scripts/dev/verify-injections.mjs`：139/139 全部精准变红，0 跳过。
  - `node scripts/dev/preflight.mjs`（33 项）、`gap-coverage.mjs`（19 项）、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`（`mature`）、`sync-toc.mjs README.md README.en.md --check` 与 `govern-audit.mjs audit . --changed --strict`（`critical=0, high=0`）全部通过。
  - `kit/skills/dev-review/scripts/*.mjs` 行数分别为 452–713 行（均 `<= 800` 行），`kit/skills/dev-review/SKILL.md` 为 108 行（`<= 180` 行）。
- **文档同步检查**：已同步更新 `kit/skills/dev-review/SKILL.md`、`kit/skills/lib/handoff-package.mjs`、`docs/TDD.md`（登记 `review-empirical.mjs`、`review-empirical-state.mjs`、`fixtures-review-empirical.mjs` 及更新日期 `2026-11-18`），并执行 `node scripts/equip.mjs .` 使 `.agents/skills/` 与 `kit/skills/` 字节级一致。
- **遗留问题**：无（`scripts/dev/injections-data.mjs` 为既有 >800 行自用夹具清单，已于本次只追加 `I131..I133`）。
