---
kind: todo
title: v9 B5：通用 E2E 门禁、离线 Scenarios H–J、I160+ 注入与 $TMPDIR 盲跑终验
status: active
created: 2026-11-18
updated: 2026-11-19
issue: 76
pr: null
branch: feat/b5-e2e-blind-run-gate
owner: impl-76
approved: false
done_at: null
task_id: b5-e2e-blind-run-gate
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_spec: ../specs/261118-issue76-b5-e2e-blind-run-gate-spec.md
---

# v9 B5：通用 E2E 门禁、离线 Scenarios H–J、I160+ 注入与 $TMPDIR 盲跑终验

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | 待启动 Wave 5 认领 @ `0aa2068` |
| 任务编号 | `b5-e2e-blind-run-gate` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#76` / 未关联 / [B5 SPEC](../specs/261118-issue76-b5-e2e-blind-run-gate-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC；启动前确认 Waves 1–4（`#71`–`#75`）全部已合入 `main`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/scripts/review-empirical.mjs`、`kit/skills/dev-review/scripts/review-empirical-state.mjs`、`kit/skills/dev-review/scripts/review-locks.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-review/SKILL.md`、`templates/agents-project.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md`、`README.md`、`README.en.md`、`scripts/dev/preflight-contract-rules.mjs` (new)、`scripts/dev/preflight-contracts.mjs`、`scripts/dev/e2e-scenarios-stageb.mjs` (new)、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/blind-run-harness.mjs` (new)、`scripts/dev/injections-data-stageb.mjs` (new)、`scripts/dev/injections-data.mjs`、`scripts/dev/injections-data-core.mjs`、`scripts/dev/fixtures-stageb-loop.mjs` (new)
- **复用既有模块**：`kit/skills/lib/profile.mjs`、`kit/skills/lib/signals.mjs`、`kit/skills/lib/escalation.mjs` (new)、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/verify-injections.mjs`
- **本期不做**：不扩展 `DEV_PROFILE_KEYS` 7 键名；不在产品层代码/门禁/模板写入任何具体端到端驱动或客户端工具名称；合入后不自动打标发版
- **门型与回滚路径**：`one-way`；合入前丢弃分支，合入后单提交 `git revert` 并保留可复现失败样本
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C15: 保留 7 键 `Dev Profile`，在 `flow.mjs` 注册 `--e2e-evidence`，修复 `GATE_TIER_RANK` 跳过 `smoke-verify` 缺陷与 `assessBehavioralGate` `!smokeRequired` 缺陷并清除具体工具硬编码，落地 `--e2e-evidence`、缺 E2E 实证阻断 `--include-diff`/`pass` 与 E2E 失败自动信号建单闭环。
- [x] C16: 完善 `scripts/dev/fixtures-stageb-onboarding.mjs` (new)、`scripts/dev/fixtures-stageb-loop.mjs` (new) 与 `scripts/dev/injections-data-stageb.mjs` (new)（`I160–I173`），全量 `scripts/dev/fixtures.mjs` 与 `scripts/dev/verify-injections.mjs` 100% 通过。
- [x] C17: 交付 `e2e-scenarios-stageb.mjs` (new) 接入 `e2e-zip-harness.mjs`，在 `git archive --format=zip` 离线黑盒环境下全绿跑通 Scenarios `H`、`I`、`J`。
- [x] C18: 交付 `blind-run-harness.mjs` (new)（登记 `docs/TDD.md` 防孤儿报错），在隔离 `$TMPDIR` 克隆多生态真实开源仓（含带自有项目级 Skill 与自定义规则且重跑 `S1–S4` 升级的已规范仓）低提示词盲跑与实跑原生测试，发现问题全部建单修复并沉淀夹具清零；全仓 `.mjs <= 800` 行、`AGENTS.md` 严守体积预算（本仓 `< 24576 B`），`merge-gate` 全链绿；且本片 `finalize` 直接验证 `C19` 免参自动收口总控 PRD。
- [x] C23: 落地 `A6` 校验（`flow-merge`/`review-empirical` 合并前 `headSha === evidence.headSha === review.headSha` 与干净工作区校核、`executed/succeeded/errorOnly` 三态计分、脱敏 `Evidence` / `Unknowns` / `NextSteps` 失败建单、确定性零 LLM Node CLI 故障注入 Stub 覆盖 `I160+` 及 `C20–C23` 探针），坚持「形式门禁 + 真实运行/E2E 实证 + `check-fault` 在前，解锁 `--include-diff` 后结合 `business-flows` / `C*` 做需求实质落地与根因判断（而非风格挑刺）」；跑通自建 HTTP/SSH 模拟远端交错 `Scenarios H–J`；执行零提示词（Zero-Hint）全机制主调度组 + 轻/弱模型对照与 `$TMPDIR`（含 `LoopForge-main`）盲跑终验（必测裸 Issue/同源与 Fork `inbound-external-pr` 链接及初次接入+Day-2+二次 `S1–S4`，且**专门验证轻/弱模型在审查时不跳过 E2E 只看 diff**），任何跳过/漏评/漏归档/歧义均走 `Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge` 根治并沉淀离线回归。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 拆出 `preflight-contract-rules.mjs` (new) 压降 `preflight-contracts.mjs <= 700` 行并同步 `injections-data-core.mjs` (`I7`/`I9c`/`I9f`)，在 `flow.mjs` 注册 `--e2e-evidence`、修复通用 E2E 门禁、接入 `A6` 合并前 `headSha`/三态计分/脱敏诊断建单并在 `fixtures-stageb-loop.mjs` 写入 `C15`/`C23` 双向断言 | `fixtures-stageb-loop`、`verify-injections.mjs --only I7 --only I9c --only I9f` 与 `preflight` 全绿 | `#71`–`#75` 均已合入 `main` |
| 2 | 实现 `scripts/dev/injections-data-stageb.mjs` (new)（`I160+` 含 `C20–C23` 探针及零 LLM CLI 故障注入 Stub）与 `scripts/dev/e2e-scenarios-stageb.mjs` (new)（自建 HTTP/SSH 模拟远端交错运行 Scenarios `H–J`）并实跑通过 | `verify-injections.mjs` 与 `e2e-zip-harness.mjs` 退出 `0` | 步骤 1 |
| 3 | 交付并运行 `blind-run-harness.mjs` (new) 完成 Zero-Hint（主调度 + 轻/弱模型对照，含裸 Issue/PR 链接及初次接入+Day-2+二次 `S1–S4`）与 `$TMPDIR` 多生态开源仓（含 `LoopForge-main`）盲跑，发现的问题走 `Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge` 修复并沉淀离线夹具 | 所有发现问题清零，原生测试全过 | 步骤 2 |
| 4 | 校准 `docs/TDD.md`、`README.md`、`README.en.md`、`AGENTS.md`（`< 24576 B`）与 `.agents/skills/`，先更新总控 PRD `[x] C1..C23` 勾选状态（不传 `--include-master-prd` 直接跑 `flow.mjs finalize` 验证 `C19` 自动收口），过全量 `merge-gate` 后提交审合 | `merge-gate` 与导出包检查全绿，总控 PRD 自动归档 `docs/archive/prd/` | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `$TMPDIR` 盲跑发现真实仓遗漏而直接临时打特例补丁 | 为某特定开源项目硬编码特例规则 | 严格走「建单 -> SPEC/Todo -> 提炼通用原则修复 -> 沉淀离线夹具/注入」闭环 |
| 遗忘提前勾选总控 PRD `C1..C19` 直接跑 `finalize` | 总控仍留有 `[ ] C*` | 依据 `C19`，`finalize` 与 `verify` 会主动硬拦截 `BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED` 并给出 `[NEXT STEP]` |

## 回滚预案

- **出问题时的第一步**：保存 `$TMPDIR` 盲跑失败日志与目标仓指纹后，先用 `git diff` 隔离问题改动。
- **回滚用什么**：`git revert` 回退提交并重跑 `compose-agents.mjs .`、`equip.mjs .`、`e2e-zip-harness.mjs` 与 `verify-injections.mjs`。
- **回滚之后要做什么**：在 `#76` 评论补充失败样本仓特征与最小复现命令。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 独立代码审查人 | 核验 `C15–C18`、`$TMPDIR` 盲跑实测证据与总控 PRD 自动归档结果并合入 | Wave 5 `submit` 后 | `review` 子代理 |

## 断点与遗留决策

- **当前状态**：`待 Wave 5 启动`（依赖 `#71`–`#75` 全部合入）
- **待拍板事项**：无
- **下一步第一件事**：Wave 5 启动后执行 `flow.mjs start --task b5-e2e-blind-run-gate --issue 76 --case 4` 进入 `.worktrees/impl-b5-e2e-blind-run-gate`。

## 澄清与补充记录

- （Wave 5 收官任务单；将在 `finalize` 阶段免传 `--include-master-prd` 直接实证 `C19` 自动归档总控 PRD）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：已跑通 `preflight.mjs`（35/35 通过，0 孤儿脚本）、`fixtures.mjs`（288/288 通过）、`verify-injections.mjs`（`I1–I178` 全捕获）、`e2e-zip-harness.mjs`（Scenarios `A–J` 通过）、`blind-run-harness.mjs`（11/11 执行成功、`errorOnly=0`）、`compose-agents.mjs . --check`（`AGENTS.md < 24576 B`）、`equip.mjs . --check`、`review.mjs .`（mature）与 `sync-toc.mjs --check`，并在归档提交后于最终 `HEAD` 复跑全链门禁与 `flow verify --mode gate --e2e-evidence`。
- **文档同步检查**：已同步更新 `docs/TDD.md`（登记全部新增模块与 `blind-run-harness.mjs`）、`templates/agents-project.md`、`AGENTS.md`（`< 24576 B`）、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-review/SKILL.md`（`equip.mjs` 已同步至 `.agents/skills/`）及双语 `README.md`/`README.en.md`（`sync-toc.mjs` 已同步），`docs/prd/261118-v9-stageb-adaptive-architecture-prd.md` `C1–C23` 已全部勾选 `[x]`。
- **遗留问题**：无（`C19` 免 `--include-master-prd` 闭环归档后完成终验并提审）。
