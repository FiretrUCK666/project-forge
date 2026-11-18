---
kind: spec
title: v9 B5：通用 E2E 门禁、离线 Scenarios H–J、I160+ 注入与 $TMPDIR 盲跑终验
status: approved
tier: L3
created: 2026-11-18
updated: 2026-11-19
issue: 76
pr: null
branch: feat/b5-e2e-blind-run-gate
owner: impl-76
approved: true
implemented: false
plan_critique: "passed (reviewer=critic-w345-r3, round=2, sha=33835fa5f460, summary=R2 复核通过：移除escalation.mjs写域仅只读复用对齐PRD；C15/C23明确E2E优先diff实质根因审查及轻弱模型不跳过E2E只看diff专项盲测)"
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_todo: ../todo/261118-issue76-b5-e2e-blind-run-gate-todo.md
high_risk_paths: [kit/, templates/, SKILL.md, AGENTS.md]
critique_anchors: "{\"sections\":{\"goal\":{\"present\":true,\"substantive\":true,\"anchors\":[\"!**：不将 `scripts/dev/blind-run-harness.mjs` (new) \",\"!什么**：严禁扩张 `DEV_PROFILE_KEYS` 的 7 个标准键名（复用现有 `smo\",\"--task\",\"C19\",\"C20\",\"C23\",\"CLI\",\"DEV_PROFILE_KEYS\",\"E2E\",\"HTTP\",\"I160\",\"SSH\",\"TMPDIR\",\"`$TMPDIR`\",\"`--include-master-prd`\",\"`.gitattributes`\",\"`A6`\",\"`B4b`\",\"`B5`\",\"`C19`\",\"`C20–C23`\",\"`DEV_PROFILE_KEYS`\",\"`Dev Profile`\",\"`H–J`\",\"`I160+`\",\"`LoopForge-main`\",\"`e2e-verify:`\",\"`e2eObservation`\",\"`flow-lifecycle`\",\"`flow-merge`\",\"`flow.mjs finalize --task b5-e2e-blind-run-gate`\",\"`headSha`\",\"`kit/`\",\"`kit/skills/lib/escalation.mjs`\",\"`kit/skills/lib/profile.mjs`\",\"`kit/skills/lib/signals.mjs`\",\"`preflight-contracts.mjs`\",\"`profile.mjs`\",\"`review-empirical`\",\"`review-gates`\",\"`scripts/dev/blind-run-harness.mjs`\",\"`scripts/dev/e2e-zip-harness.mjs`\",\"`scripts/dev/verify-injections.mjs`\",\"`smoke-verify:`\",\"`v9`\",\"`workflow-policy`\",\"`zip`\",\"flow.mjs\",\"headSha\",\"kit/skills/lib/escalation.mjs\",\"kit/skills/lib/profile.mjs\",\"kit/skills/lib/signals.mjs\",\"preflight-contracts.mjs\",\"profile.mjs\",\"scripts/dev/blind-run-harness.mjs\",\"scripts/dev/e2e-zip-harness.mjs\",\"scripts/dev/verify-injections.mjs\"]},\"design\":{\"present\":true,\"substantive\":false,\"anchors\":[\"!`scripts/dev/*`）\",\"--check\",\"--format\",\"--task\",\"<14336B\",\"<24576B\",\"<=30720B\",\"<=700\",\"<=800\",\">0\",\"AGENTS\",\"AGENTS.md\",\"BLOCKED_E2E_OBSERVATION_REQUIRED\",\"BLOCKED_EMPIRICAL_FIRST\",\"BLOCKED_INSUFFICIENT_VERIFICATION_TIER\",\"BLOCKED_PASS_WITH_OPEN_BLOCKERS\",\"C1\",\"C12\",\"C15\",\"C16\",\"C17\",\"C18\",\"C19\",\"C20\",\"C23\",\"CLI\",\"E2E\",\"HTTP\",\"I160\",\"LLM\",\"PRD\",\"README\",\"README.en.md\",\"README.md\",\"REPO_ONLY\",\"SKILL\",\"SKILL.md\",\"SPEC\",\"SSH\",\"STOP_LOSS_ESCALATE\",\"TDD\",\"TMPDIR\",\"`!smokeRequired`\",\"`$TMPDIR`\",\"`*/AGENTS.md`\",\"`--cmd`\",\"`--e2e-evidence <text>`\",\"`--e2e-evidence`\",\"`--include-diff`\",\"`--include-master-prd`\",\"`--visual-checked`\",\"`.agents/skills/`\",\"`.githooks/pre-push`\",\"`.mjs <= 800`\",\"`0`\",\"`3`\",\"`793`\",\"`<= 700`\",\"`A1/A2/A3`\",\"`A6`\",\"`AGENTS.md < 24576 B`\",\"`AGENTS.md`\",\"`BLOCKED_E2E_OBSERVATION_REQUIRED`\",\"`BLOCKED_EMPIRICAL_FIRST`\",\"`BLOCKED_INSUFFICIENT_VERIFICATION_TIER`\",\"`BLOCKED_PASS_WITH_OPEN_BLOCKERS`\",\"`C*`\",\"`C1..C15`\",\"`C12`\",\"`C15`\",\"`C16`\",\"`C17`\",\"`C18`\",\"`C19`\",\"`C20–C23`\",\"`C23`\",\"`Dev Profile`\",\"`Evidence`\",\"`H–J`\",\"`I160+`\",\"`I160`\",\"`I7`\",\"`I9c`\",\"`I9f`\",\"`Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge`\",\"`LoopForge-main`\",\"`NextSteps`\",\"`Q3`\",\"`README.en.md`\",\"`README.md`\",\"`REPO_ONLY`\",\"`S1–S4`\",\"`SKILL.md`\",\"`STOP_LOSS_ESCALATE`\",\"`Unknowns`\",\"`alreadyMerged`\",\"`artifact_baseline`\",\"`assessBehavioralGate`\",\"`business-flows`\",\"`check-fault`\",\"`checkOrphanScripts`\",\"`cmd/*/main.go`\",\"`determineWorkflowPolicy`\",\"`docs/TDD.md`\",\"`docs/specs/*`\",\"`e2e-zip-harness.mjs`\",\"`e2e-zip-harness`\",\"`e2e.runtime-fail`\",\"`e2e/`\",\"`e2eObservation`\",\"`errorOnly`\",\"`escalation.mjs`\",\"`evidence.json`\",\"`executed/succeeded/errorOnly`\",\"`executed`\",\"`faultRecord`\",\"`flow-lifecycle-helpers.mjs`\",\"`flow-lifecycle.mjs`\",\"`flow-merge.mjs`\",\"`flow-merge`\",\"`flow.mjs finalize --task b5-e2e-blind-run-gate`\",\"`flow.mjs verify`\",\"`flow.mjs`\",\"`full <= 30720 B`\",\"`full`\",\"`gate`\",\"`generic-git`\",\"`git archive --format=zip`\",\"`headSha === evidence.headSha === review.headSha`\",\"`inbound-external-pr`\",\"`kit/skills/dev-review/SKILL.md`\",\"`kit/skills/lib/workflow-policy.mjs`\",\"`lightweight < 14336 B`\",\"`local-only`\",\"`low`\",\"`merge-gate`\",\"`none`\",\"`origin`\",\"`pass`\",\"`preflight.mjs`\",\"`pyproject.toml`\",\"`review-empirical-state.mjs`\",\"`review-empirical.mjs`\",\"`review-empirical`\",\"`review-gates.mjs`\",\"`review-locks.mjs`\",\"`review-pack.mjs`\",\"`review`\",\"`riskTier !== 'low'`\",\"`runtimeFilesTouched.length > 0`\",\"`scripts/dev/*`\",\"`scripts/dev/`\",\"`scripts/dev/blind-run-harness.mjs`\",\"`scripts/dev/e2e-scenarios-stageb.mjs`\",\"`scripts/dev/fixtures-stageb-loop.mjs`\",\"`scripts/dev/injections-data-core.mjs`\",\"`scripts/dev/injections-data-stageb.mjs`\",\"`scripts/dev/injections-data.mjs`\",\"`scripts/dev/preflight-contract-rules.mjs`\",\"`scripts/dev/preflight-contracts.mjs`\",\"`signals.jsonl`\",\"`skills/*`\",\"`smoke-verify: none`\",\"`smoke-verify`\",\"`smokeVerifiedOnHead`\",\"`smoke`\",\"`succeeded`\",\"`sync-toc.mjs README.md README.en.md --check`\",\"`tasks/{id}/evidence.json`\",\"`templates/agents-project.md`\",\"`validateVerificationEvidence`\",\"`verified-on-head`\",\"`verify-injections.mjs`\",\"`visualCheckEvidence`\",\"`visualVerifiedHead`\",\"`workflow-policy.mjs`\",\"alreadyMerged\",\"artifact_baseline\",\"assessBehavioralGate\",\"checkOrphanScripts\",\"determineWorkflowPolicy\",\"docs/TDD.md\",\"e2e-zip-harness.mjs\",\"errorOnly\",\"escalation.mjs\",\"evidence.json\",\"faultRecord\",\"flow-lifecycle-helpers.mjs\",\"flow-lifecycle.mjs\",\"flow-merge.mjs\",\"flow.mjs\",\"headSha\",\"kit/skills/dev-review/SKILL.md\",\"kit/skills/lib/workflow-policy.mjs\",\"preflight.mjs\",\"pyproject.toml\",\"review-empirical-state.mjs\",\"review-empirical.mjs\",\"review-gates.mjs\",\"review-locks.mjs\",\"review-pack.mjs\",\"riskTier\",\"runtimeFilesTouched\",\"scripts/dev/blind-run-harness.mjs\",\"scripts/dev/e2e-scenarios-stageb.mjs\",\"scripts/dev/fixtures-stageb-loop.mjs\",\"scripts/dev/injections-data-core.mjs\",\"scripts/dev/injections-data-stageb.mjs\",\"scripts/dev/injections-data.mjs\",\"scripts/dev/preflight-contract-rules.mjs\",\"scripts/dev/preflight-contracts.mjs\",\"smokeRequired\",\"smokeVerifiedOnHead\",\"sync-toc.mjs\",\"templates/agents-project.md\",\"validateVerificationEvidence\",\"verify-injections.mjs\",\"visualCheckEvidence\",\"visualVerifiedHead\",\"workflow-policy.mjs\"]},\"alternatives\":{\"present\":true,\"substantive\":true,\"anchors\":[\"E2E\",\"`Dev Profile`\",\"`e2e-verify:`\",\"`e2eObservation`\",\"`smoke-verify:`\",\"`smoke`\"]}},\"anchors\":[\"!**：不将 `scripts/dev/blind-run-harness.mjs` (new) \",\"!`scripts/dev/*`）\",\"!什么**：严禁扩张 `DEV_PROFILE_KEYS` 的 7 个标准键名（复用现有 `smo\",\"--check\",\"--format\",\"--task\",\"<14336B\",\"<24576B\",\"<=30720B\",\"<=700\",\"<=800\",\">0\",\"AGENTS\",\"AGENTS.md\",\"BLOCKED_E2E_OBSERVATION_REQUIRED\",\"BLOCKED_EMPIRICAL_FIRST\",\"BLOCKED_INSUFFICIENT_VERIFICATION_TIER\",\"BLOCKED_PASS_WITH_OPEN_BLOCKERS\",\"C1\",\"C12\",\"C15\",\"C16\",\"C17\",\"C18\",\"C19\",\"C20\",\"C23\",\"CLI\",\"DEV_PROFILE_KEYS\",\"E2E\",\"GATE_TIER_RANK\",\"HTTP\",\"I160\",\"LLM\",\"PRD\",\"README\",\"README.en.md\",\"README.md\",\"REPO_ONLY\",\"SKILL\",\"SKILL.md\",\"SPEC\",\"SSH\",\"STOP_LOSS_ESCALATE\",\"TDD\",\"TMPDIR\",\"`!smokeRequired`\",\"`$TMPDIR`\",\"`*/AGENTS.md`\",\"`--cmd`\",\"`--e2e-evidence <text>`\",\"`--e2e-evidence`\",\"`--include-diff`\",\"`--include-master-prd`\",\"`--visual-checked`\",\"`.agents/skills/`\",\"`.gitattributes`\",\"`.githooks/pre-push`\",\"`.mjs <= 800`\",\"`0`\",\"`3`\",\"`793`\",\"`< 24576 B`\",\"`<= 700`\",\"`A1/A2/A3`\",\"`A1–A5`\",\"`A6`\",\"`AGENTS.md < 24576 B`\",\"`AGENTS.md`\",\"`B4b`\",\"`B5`\",\"`BLOCKED_E2E_OBSERVATION_REQUIRED`\",\"`BLOCKED_EMPIRICAL_FIRST`\",\"`BLOCKED_INSUFFICIENT_VERIFICATION_TIER`\",\"`BLOCKED_PASS_WITH_OPEN_BLOCKERS`\",\"`C*`\",\"`C1..C15`\",\"`C12`\",\"`C15`\",\"`C16`\",\"`C17`\",\"`C18`\",\"`C19`\",\"`C20–C23`\",\"`C23`\",\"`DEV_PROFILE_KEYS`\",\"`Dev Profile`\",\"`Evidence`\",\"`GATE_TIER_RANK`\",\"`H`\",\"`H–J`\",\"`I160+`\",\"`I160`\",\"`I7`\",\"`I9c`\",\"`I9f`\",\"`I`\",\"`Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge`\",\"`J`\",\"`LoopForge-main`\",\"`NextSteps`\",\"`Q3`\",\"`README.en.md`\",\"`README.md`\",\"`REPO_ONLY`\",\"`S1–S4`\",\"`SKILL.md`\",\"`STOP_LOSS_ESCALATE`\",\"`Scenarios H–J`\",\"`Unknowns`\",\"`alreadyMerged`\",\"`artifact_baseline`\",\"`assessBehavioralGate`\",\"`business-flows`\",\"`check-fault`\",\"`checkOrphanScripts`\",\"`cmd/*/main.go`\",\"`determineWorkflowPolicy`\",\"`docs/TDD.md`\",\"`docs/specs/*`\",\"`e2e-verify:`\",\"`e2e-zip-harness.mjs`\",\"`e2e-zip-harness`\",\"`e2e.runtime-fail`\",\"`e2e/`\",\"`e2eObservation`\",\"`errorOnly`\",\"`escalation.mjs`\",\"`evidence.json`\",\"`executed/succeeded/errorOnly`\",\"`executed`\",\"`exit 0`\",\"`faultRecord`\",\"`flow-lifecycle-helpers.mjs`\",\"`flow-lifecycle.mjs`\",\"`flow-lifecycle`\",\"`flow-merge.mjs`\",\"`flow-merge`\",\"`flow.mjs finalize --task b5-e2e-blind-run-gate`\",\"`flow.mjs verify`\",\"`flow.mjs`\",\"`full <= 30720 B`\",\"`full`\",\"`gate`\",\"`generic-git`\",\"`git archive --format=zip`\",\"`headSha === evidence.headSha === review.headSha`\",\"`headSha`\",\"`inbound-external-pr`\",\"`kit/`\",\"`kit/skills/dev-review/SKILL.md`\",\"`kit/skills/lib/escalation.mjs`\",\"`kit/skills/lib/profile.mjs`\",\"`kit/skills/lib/signals.mjs`\",\"`kit/skills/lib/workflow-policy.mjs`\",\"`lightweight < 14336 B`\",\"`local-only`\",\"`low`\",\"`merge-gate`\",\"`node scripts/dev/fixtures.mjs`\",\"`node scripts/dev/verify-injections.mjs`\",\"`none`\",\"`origin`\",\"`parseStandardCli`\",\"`pass`\",\"`preflight-contracts.mjs`\",\"`preflight.mjs`\",\"`profile.mjs`\",\"`pyproject.toml`\",\"`record`\",\"`review-empirical-state.mjs`\",\"`review-empirical.mjs`\",\"`review-empirical`\",\"`review-gates.mjs`\",\"`review-gates`\",\"`review-locks.mjs`\",\"`review-pack.mjs check-empirical`\",\"`review-pack.mjs`\",\"`review`\",\"`riskTier !== 'low'`\",\"`runtimeFilesTouched.length > 0`\",\"`scripts/dev/*`\",\"`scripts/dev/`\",\"`scripts/dev/blind-run-harness.mjs`\",\"`scripts/dev/e2e-scenarios-stageb.mjs`\",\"`scripts/dev/e2e-zip-harness.mjs`\",\"`scripts/dev/fixtures-stageb-loop.mjs`\",\"`scripts/dev/fixtures-stageb-onboarding.mjs`\",\"`scripts/dev/injections-data-core.mjs`\",\"`scripts/dev/injections-data-stageb.mjs`\",\"`scripts/dev/injections-data.mjs`\",\"`scripts/dev/preflight-contract-rules.mjs`\",\"`scripts/dev/preflight-contracts.mjs`\",\"`scripts/dev/verify-injections.mjs`\",\"`signals.jsonl`\",\"`skills/*`\",\"`smoke-verify: none`\",\"`smoke-verify:`\",\"`smoke-verify`\",\"`smokeVerifiedOnHead`\",\"`smoke`\",\"`succeeded`\",\"`sync-toc.mjs README.md README.en.md --check`\",\"`tasks/{id}/evidence.json`\",\"`templates/agents-project.md`\",\"`v9`\",\"`validateVerificationEvidence`\",\"`verified-on-head`\",\"`verify-injections.mjs`\",\"`visualCheckEvidence`\",\"`visualVerifiedHead`\",\"`workflow-policy.mjs`\",\"`workflow-policy`\",\"`zip`\",\"alreadyMerged\",\"artifact_baseline\",\"assessBehavioralGate\",\"checkOrphanScripts\",\"determineWorkflowPolicy\",\"docs/TDD.md\",\"e2e-zip-harness.mjs\",\"errorOnly\",\"escalation.mjs\",\"evidence.json\",\"exit 0\",\"faultRecord\",\"flow-lifecycle-helpers.mjs\",\"flow-lifecycle.mjs\",\"flow-merge.mjs\",\"flow.mjs\",\"headSha\",\"kit/skills/dev-review/SKILL.md\",\"kit/skills/lib/escalation.mjs\",\"kit/skills/lib/profile.mjs\",\"kit/skills/lib/signals.mjs\",\"kit/skills/lib/workflow-policy.mjs\",\"parseStandardCli\",\"preflight-contracts.mjs\",\"preflight.mjs\",\"profile.mjs\",\"pyproject.toml\",\"review-empirical-state.mjs\",\"review-empirical.mjs\",\"review-gates.mjs\",\"review-locks.mjs\",\"review-pack.mjs\",\"riskTier\",\"runtimeFilesTouched\",\"scripts/dev/blind-run-harness.mjs\",\"scripts/dev/e2e-scenarios-stageb.mjs\",\"scripts/dev/e2e-zip-harness.mjs\",\"scripts/dev/fixtures-stageb-loop.mjs\",\"scripts/dev/fixtures-stageb-onboarding.mjs\",\"scripts/dev/fixtures.mjs\",\"scripts/dev/injections-data-core.mjs\",\"scripts/dev/injections-data-stageb.mjs\",\"scripts/dev/injections-data.mjs\",\"scripts/dev/preflight-contract-rules.mjs\",\"scripts/dev/preflight-contracts.mjs\",\"scripts/dev/verify-injections.mjs\",\"smokeRequired\",\"smokeVerifiedOnHead\",\"sync-toc.mjs\",\"templates/agents-project.md\",\"validateVerificationEvidence\",\"verify-injections.mjs\",\"visualCheckEvidence\",\"visualVerifiedHead\",\"workflow-policy.mjs\"],\"coreSections\":[\"alternatives\",\"goal\"],\"pendingResolved\":0,\"pendingUnresolved\":0,\"criteriaCount\":5}"
---

# v9 B5：通用 E2E 门禁、离线 Scenarios H–J、I160+ 注入与 $TMPDIR 盲跑终验 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（通用运行+观察 E2E 硬门禁、Stage B 全量 `I160+` 故障注入、离线 Scenarios `H–J`、`$TMPDIR` 多生态开源仓盲跑终验与全仓文档校准；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / Issue / PR | 待启动 Wave 5 认领 / `#76` / 未关联 |
| 负责人 / 内审状态 | `plan-stage-b` / `pending` |
| 关联 PRD / Todo | [v9 总控 PRD](../prd/261118-v9-stageb-adaptive-architecture-prd.md) / [B5 Todo](../todo/261118-issue76-b5-e2e-blind-run-gate-todo.md) |
| 认领的验收标准 | `C15`、`C16`、`C17`、`C18`、`C23` |

- **变更一句话**：修补 `GATE_TIER_RANK` 与 `assessBehavioralGate` 的端到端门禁旁路并纳入 `A6` 校验（合并前 `headSha === evidence.headSha === review.headSha`、`executed/succeeded/errorOnly` 三态计分、脱敏 `Evidence` / `Unknowns` / `NextSteps` 诊断建单与确定性 CLI 故障注入 Stub），跑通离线与模拟远端 Scenarios `H–J`，并以零提示词（Zero-Hint）全机制主调度组、轻模型对照组与 `$TMPDIR` 多生态真实开源仓（含 `LoopForge-main`）盲跑及最后一片 `C19` 免参收口完成全阶段闭环。

## 系统变更全景

```mermaid
flowchart LR
  WP["禁用单测顶包"] --> FV["e2e 回执"]
  FV --> RG["观察门禁"]
  RG -->|Fail| ES["自动建单"]
  E2E["Scenarios H-J"] --> BR["$TMPDIR 盲跑"]
  BR --> CL["B5 自闭总控"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/workflow-policy.mjs` | 改造 | 保留 7 键 `Dev Profile`，修复 `GATE_TIER_RANK` 下 `full`/`gate` 跳过 `smoke-verify` 缺陷并强校 `e2eObservation` |
| `kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`flow-lifecycle.mjs`、`flow-merge.mjs` | 改造 | 在 `flow.mjs` 严格 `parseStandardCli` 注册 `--e2e-evidence` 与帮助文案，支持 `verify --e2e-evidence`（兼容 `--visual-checked`），E2E 运行失败自动写 `signals.jsonl`（`e2e.runtime-fail`）与输出脱敏 `Evidence` / `Unknowns` / `NextSteps` 诊断包桥接 `C12` `escalation.mjs` (new) 建单；合并前强校 `headSha === evidence.headSha === review.headSha` 且工作区无脏改动 |
| `kit/skills/dev-review/scripts/review-gates.mjs`、`review-empirical.mjs`、`review-empirical-state.mjs`、`review-locks.mjs`、`review-pack.mjs`、`kit/skills/dev-review/SKILL.md` | 改造 | 修复 `assessBehavioralGate` `!smokeRequired` 逻辑缺陷，清除既有前端驱动工具硬编码文案；缺 E2E 实证阻断 `--include-diff` 与 `pass`；`evidence.json` 拆分 `executed` / `succeeded` / `errorOnly` 三态阻断错路径刷绿；强校三方 `headSha` 一致性 |
| `scripts/dev/preflight-contract-rules.mjs` (new)、`scripts/dev/preflight-contracts.mjs`、`scripts/dev/injections-data-core.mjs` | 新增 / 改造 | 先抽离常量与收尾校验辅助压降 `preflight-contracts.mjs <= 700` 行，同步迁移 `I7`/`I9c`/`I9f` 注入目标，并加入通用 E2E 与零具体工具名合约检查 |
| `scripts/dev/fixtures-stageb-loop.mjs` (new)、`scripts/dev/injections-data-stageb.mjs` (new)、`scripts/dev/injections-data.mjs` | 修改 / 新增 | 写入 `C15`、`C23` 双向用例、确定性零 LLM Node CLI 故障注入 Stub 及覆盖 `C1..C15`/`C19`/`C20–C23` 的 `I160+` 故障注入集合 |
| `scripts/dev/e2e-scenarios-stageb.mjs` (new)、`scripts/dev/e2e-zip-harness.mjs` | 新增 / 改造 | 在解压 `git archive --format=zip` 黑盒环境下自建本地 HTTP/SSH 模拟远端与凭据，交错运行 Scenarios `H`、`I`、`J`（含无远端迁有远端、PR/Issue 标签前缀、按需 Milestone、双侧停损、`A1–A6` 与 E2E 失败建单） |
| `scripts/dev/blind-run-harness.mjs` (new) | 新增 | `$TMPDIR` 隔离多生态真实开源仓（含 `LoopForge-main` 同构/自有技能 `S1–S4` 升级）与零提示词（Zero-Hint）全机制主调度组 + 轻模型对照组盲跑验收器（不入用户包，登记 `docs/TDD.md`） |
| `templates/agents-project.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md`、`README.md`、`README.en.md` | 改造 | 替换通用 E2E 实证文案、登记 `blind-run-harness.mjs` (new)（防孤儿报错）、同步双语 README 目录与校准全局体积 |

## 一、背景与边界声明

- **要改什么**：端到端门禁与策略引擎（`workflow-policy`、`review-gates`、`review-empirical`、`flow-lifecycle`、`flow-merge`）、`A6` 合前三方 `headSha` 校验 / 三态计分 / 脱敏诊断建单 / 确定性 CLI Stub、`preflight-contracts.mjs` 行数拆分、Stage B 故障注入集（`I160+` 含 `C20–C23` 探针）、离线 `zip` + 模拟 HTTP/SSH 远端 Scenarios `H–J`、零提示词（Zero-Hint）全机制与 `$TMPDIR` 多生态（含 `LoopForge-main`）盲跑脚本及全仓文档同步。
- **不改什么**：严禁扩张 `DEV_PROFILE_KEYS` 的 7 个标准键名（复用现有 `smoke-verify:` 键位）；不在任何通用门禁、模板或报错文案中出现具体前端/自动化端到端驱动库或客户端测试框架名称；不在非纯文档仓豁免运行时变更；零提示词盲跑 prompt 严禁泄露内部脚本、命令、工作树或角色分工提示。
- **本期不做**：不将 `scripts/dev/blind-run-harness.mjs` (new) 打进随包分发的 `kit/` 或 `.gitattributes` 导出清单；不在 `$TMPDIR` 盲跑期间向任何外部开源仓库远端执行写操作或推送。
- **复用既有模块**：复用 `kit/skills/lib/profile.mjs`、`kit/skills/lib/signals.mjs`、`kit/skills/lib/escalation.mjs` (new)（`B4b` 交付）、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/verify-injections.mjs`。
- **架构基线关系**：同时作为 Stage B（`v9`）最后一片实施任务，`B5` 在自收口时直接通过 `flow.mjs finalize --task b5-e2e-blind-run-gate`（不传 `--include-master-prd`）实证 `C19` 与显式 `--include-master-prd` 的等价自动闭合语义。
- **替代方案与否决理由**：若为了 E2E 门禁新增第 8 个 `Dev Profile` 键位（如 `e2e-verify:`），会迫使 `profile.mjs` 与 6 处单源契约及既有历史仓配置全部失效；复用 `smoke-verify:` + 结构化 `e2eObservation` 回执做到零迁移兼容。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **通用「运行 + 观察」E2E 硬门禁（`C15`）**：
   - **`kit/skills/lib/workflow-policy.mjs`**：当 `runtimeFilesTouched.length > 0`、`riskTier !== 'low'` 且 `Dev Profile` 中 `smoke-verify` 未显式声明 `none` 时：`determineWorkflowPolicy` 与 `validateVerificationEvidence` 禁止以 `full`/`gate`（仅单测）顶替 `smoke`；缺 `smokeVerifiedOnHead` 或缺结构化 `e2eObservation` 时返回 `BLOCKED_INSUFFICIENT_VERIFICATION_TIER` 或 `BLOCKED_E2E_OBSERVATION_REQUIRED`（退出码 `3`）。若用户仓既无真实 `smoke-verify` 命令也未显式写 `smoke-verify: none` 且未传 `--cmd`/`--e2e-evidence`，按 `Q3` 定稿结论阻断并引导补全。
   - **`flow.mjs verify` 与 `review-pack.mjs`**：支持 `--e2e-evidence <text>`（保留 `--visual-checked` 作为别名写入 `e2eObservation`）；E2E 运行失败记录 `e2e.runtime-fail` 事件至 `signals.jsonl` 并由 `escalation.mjs` 创建追踪工单。
   - **`review-gates.mjs` 与 `review-empirical.mjs`**：修复 `assessBehavioralGate` 中 `!smokeRequired` 导致永远不标记 `verified-on-head` 的缺陷，清除既有具体端到端驱动库/工具硬编码文案；保持「形式门禁 + 真实运行/E2E 观察 + `check-fault` 在前，未完成前阻断 `--include-diff`（`BLOCKED_EMPIRICAL_FIRST`）与 `pass`（`BLOCKED_PASS_WITH_OPEN_BLOCKERS`）」，解锁 `--include-diff` 后须结合 `business-flows` / `C*` 做**需求实质落地与根因判断（而非风格挑刺）**。
2. **`I160+` 故障注入、确定性 CLI Stub 与 `A6` 校验（`C16`、`C23`）**：
   - **合并前指纹与三态计分（`A6`）**：`flow-merge.mjs` 与 `review-empirical.mjs` 在合并前强校 `headSha === evidence.headSha === review.headSha` 且工作区无脏改动；`evidence.json` 与盲跑结果计分明确拆分 `executed`、`succeeded` 与 `errorOnly` 三态（阻断空跑或错误分支退出 `0` 刷绿）；`flow.mjs verify` / `review` / E2E 失败自动输出脱敏 `Evidence` / `Unknowns` / `NextSteps` 诊断包并桥接 `C12` `escalation.mjs` (new) 自动建单。
   - **故障注入与确定性 CLI Stub**：新增 `scripts/dev/injections-data-stageb.mjs` (new)，注册进 `scripts/dev/injections-data.mjs`，编号自 `I160` 起覆盖 `C1..C15`、`C19` 及 `C20–C23` 全部核心探针（包含零 LLM 确定性 Node CLI 故障注入 Stub 验证失败降级与退避分支）。
3. **离线黑盒 `e2e-zip-harness` Scenarios `H–J` 与模拟远端（`C17`、`C23`）**：
   - 新增 `scripts/dev/e2e-scenarios-stageb.mjs` (new)，在解压 `git archive --format=zip` 黑盒环境内启停自建本地 HTTP/SSH 模拟远端与凭据，交错跑通：
     - **Scenario H**：纯无远端 `local-only` 起步建单、推进、评审 -> 新增 `origin` 远端 -> 无痛平滑迁单切回远端 -> PR/Issue 规范前缀与单表语义标签、按需 Milestone 绑定继承、`A1/A2/A3` 退避与 `alreadyMerged` 续尾 -> PR 合入自动关单；
     - **Scenario I**：代码评审与规划 Critique 双侧跨轮同人拦截、共享 3 轮硬停损（`STOP_LOSS_ESCALATE`）与结构化恢复包、`artifact_baseline` 防空转、有限冲突块提取、切片 `C*` 隔离/`faultRecord`、`low` 风险可选记录、分级建单与多切片最后一片自动收口；
     - **Scenario J**：Node+Python 异构仓、非标文档与用户既有 `docs/specs/*` 原样保留、自定义脚本、第 6 个临时内置技能与非隐藏自有 `skills/*`（含 `*/AGENTS.md`、多语配对、`pyproject.toml`/`cmd/*/main.go`、`e2e/` 隔离）`S1–S4` 升级、`.githooks/pre-push` 拦直推与全零删分支放行、`generic-git` 本地兼容追踪及真实非 `0` 端到端失败（`executed/succeeded/errorOnly` + 脱敏诊断包）自动建单修复后复绿。
4. **零提示词（Zero-Hint）全机制主调度盲测与 `$TMPDIR` 真实开源仓终验（`C18`、`C23`）**：
   - 新增 `scripts/dev/blind-run-harness.mjs` (new)（仅在 `scripts/dev/` 下且登记于 `docs/TDD.md` 防 `checkOrphanScripts` 报错）：以完全无本仓前置提示词的全新独立子代理纯调度组**及轻/弱模型对照组**执行 Zero-Hint 盲跑，并在 `$TMPDIR` 隔离克隆真实多生态开源项目（Node/Python/Go/Rust 及含自有项目级技能 `LoopForge-main` 同构/自有技能 `S1–S4` 升级，无远端写操作），必测场景覆盖：① **裸粘贴 Issue 链接**（无额外操作词）；② **裸粘贴 PR 链接**（含同源 PR 与 Fork `inbound-external-pr` 链接）；③ **全新异构仓全周期**（「初次接入含 `business-flows`/非标布局/原生测试隔离/自有技能保留」->「Day-2 真实业务开发」->「二次重跑 `S1–S4` 无损升级」）；④ **专门验证轻/弱模型在审查时不跳过 E2E 只看 diff**，解锁 `--include-diff` 后按 `business-flows` / `C*` 核对需求实质落地与根因。任何跳过、漏评、漏归档、弱模型跑偏或歧义均走标准 `Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge` 根治并沉淀进离线回归。

### 数据与状态变更

- `tasks/{id}/evidence.json` 新增 `smokeVerifiedOnHead` 与 `e2eObservation` 结构化回执字段（兼容旧 `visualVerifiedHead`/`visualCheckEvidence` 读取）。
- 无新增 `Dev Profile` 键名，无包分发格式改动（`REPO_ONLY` 忽略规则自动排除 `scripts/dev/*`）。

### 异常、回退与安全边界

- 拆分 `scripts/dev/preflight-contracts.mjs`（`793` -> `<= 700` 行）至 `scripts/dev/preflight-contract-rules.mjs` (new) 前先保绿既有全部合约校验，并同步更新 `scripts/dev/injections-data-core.mjs` 中 `I7`/`I9c`/`I9f` 定位。
- 全局检查所有 `.mjs <= 800` 行、本仓 `AGENTS.md < 24576 B`、渲染 `lightweight < 14336 B`、`full <= 30720 B`、`sync-toc.mjs README.md README.en.md --check` 与 `merge-gate` 全链全绿。

### 实现顺序

1. 先从 `scripts/dev/preflight-contracts.mjs` 抽离 `scripts/dev/preflight-contract-rules.mjs` (new)，同步更新 `scripts/dev/injections-data-core.mjs`（`I7`/`I9c`/`I9f`），并验证 `preflight.mjs` 与 `verify-injections.mjs` 绿灯。
2. 修复 `workflow-policy.mjs`、`flow.mjs`（注册 `--e2e-evidence`）、`flow-lifecycle-helpers.mjs`、`flow-lifecycle.mjs`、`review-gates.mjs`、`review-empirical.mjs`、`review-empirical-state.mjs`、`review-locks.mjs`、`review-pack.mjs`、`kit/skills/dev-review/SKILL.md` 及 `templates/agents-project.md`/`SKILL.md` 的通用 E2E 门禁逻辑与文案，并在 `scripts/dev/fixtures-stageb-loop.mjs` (new) 写入 `C15` 双向断言。
3. 实现 `scripts/dev/injections-data-stageb.mjs` (new)（`I160+` 与零 LLM CLI Stub）与 `scripts/dev/e2e-scenarios-stageb.mjs` (new)（自建模拟 HTTP/SSH 远端交错跑通 Scenarios `H–J`）并跑通 `verify-injections.mjs` 与 `e2e-zip-harness.mjs`。
4. 实现 `scripts/dev/blind-run-harness.mjs` (new) 与 `flow-merge`/`review-empirical` `A6` 校验，完成 Zero-Hint 全机制（主模型 + 轻模型对照，含裸 Issue/PR 链接及初次接入+Day-2+二次 `S1–S4`）与 `$TMPDIR` 多生态（含 `LoopForge-main`）真实开源仓盲跑闭环（若检出问题则在隔离分支走「`Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge`」清零并沉淀离线回归），更新 `docs/TDD.md`、`README.md`、`README.en.md`、`AGENTS.md` 与 `.agents/skills/`；随后在本分支直接运行 `flow.mjs finalize --task b5-e2e-blind-run-gate`（不传 `--include-master-prd`）实证 `C19` 自动收口与总控 PRD 归档。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 复用 `smoke-verify:` 7 键 + `e2eObservation` 回执 | 零扩表、零破坏历史仓 `Dev Profile`，强制要求非低危运行态更改执行 `smoke` 与观察回执 | 兼顾零契约膨胀与堵死单测顶替 E2E 漏洞 | 若未来需要按子环境运行多组互异 E2E 命令再考虑映射结构 |
| 新增第 8 个 `Dev Profile` 键 `e2e-verify:` | 把单测和 E2E 拆出两个独立键 | 所有已有工程仓、模板和 6 处单源契约测试都需迁移，收益低于复杂度成本 | 不选 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`flow-lifecycle.mjs`、`flow-merge.mjs` | 修改 | 在 `flow.mjs` 注册 `--e2e-evidence`、修复 `full`/`gate` 跳过 `smoke-verify` 漏洞、接入 E2E 脱敏诊断回执与失败调用 `escalation.mjs` (new) 自动建单（仅只读导入复用，不改 `escalation.mjs`）、落地 `A6` 合并前 `headSha === evidence.headSha === review.headSha` 与干净工作区校核 | `flow`、`verify`、`submit`、`merge`、门禁层 |
| `kit/skills/dev-review/scripts/review-gates.mjs`、`review-empirical.mjs`、`review-empirical-state.mjs`、`review-locks.mjs`、`review-pack.mjs`、`kit/skills/dev-review/SKILL.md` | 修改 | 修 `!smokeRequired` 缺陷、清除具体工具硬编码、阻断缺实证 `--include-diff`/`pass`、拆分 `executed/succeeded/errorOnly` 三态计分并校验三方 `headSha` 一致性 | `dev-review` 双门实证 |
| `scripts/dev/preflight-contract-rules.mjs` (new)、`preflight-contracts.mjs`、`scripts/dev/injections-data-core.mjs` | 新增 / 修改 | 拆分减行、更新 `I7`/`I9c`/`I9f` 定位并增加通用 E2E 工具名静态禁忌校验 | `preflight`、`verify-injections` |
| `scripts/dev/injections-data-stageb.mjs` (new)、`injections-data.mjs`、`scripts/dev/fixtures-stageb-loop.mjs` (new) | 新增 / 修改 | `I160+`（含 `C20–C23` 探针与确定性零 LLM Node CLI 故障注入 Stub）与 `C15`/`C23` 双向断言 | `verify-injections`、`fixtures` |
| `scripts/dev/e2e-scenarios-stageb.mjs` (new)、`e2e-zip-harness.mjs`、`scripts/dev/blind-run-harness.mjs` (new) | 新增 / 修改 | 自建 HTTP/SSH 模拟远端交错跑通离线黑盒 Scenarios `H–J`、Zero-Hint 主调度组 + 轻模型对照与 `$TMPDIR`（含 `LoopForge-main`）真实开源仓盲跑终验 | 端到端黑盒质量验收 |
| `templates/agents-project.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md`、`README.md`、`README.en.md` | 修改 | 文案对齐、`blind-run-harness` 登记 TDD、双语 README 与体积校验校准 | 全仓一致性与发布前基线 |

- **对外可见的变化**：非低危运行态改动的 `flow.mjs verify` 强制要求通过 `smoke-verify` 并记录 `--e2e-evidence` 观察回执；未配 `smoke-verify` 且未显式写 `none` 时阻断引导补全。
- **需要同步改的地方**：`.agents/skills/` 同步（`equip.mjs .`）、`AGENTS.md`（`compose-agents.mjs .`）、`README.md`/`README.en.md`（`sync-toc.mjs`）。

## 五、冻结的验收标准

- [x] C15: 保留 7 键 `Dev Profile`，`workflow-policy.mjs`（`determineWorkflowPolicy`、`validateVerificationEvidence`）修复 `GATE_TIER_RANK` 下 `full`/`gate` 绕过 `smoke-verify` 缺陷——当 `runtimeFilesTouched.length > 0`、`riskTier !== 'low'` 且 `smoke-verify` 未显式设为 `none` 时强制校验 `smoke` (`smokeVerifiedOnHead`) 与结构化 `e2eObservation` 回执（缺失返回 `BLOCKED_INSUFFICIENT_VERIFICATION_TIER` 或 `BLOCKED_E2E_OBSERVATION_REQUIRED`，退出码 `3`）；`flow.mjs verify`（已在 `flow.mjs` `parseStandardCli` 注册 `--e2e-evidence`）与 `review-pack.mjs check-empirical`/`record` 支持 `--e2e-evidence`（兼容 `--visual-checked`）；`review-gates.mjs`（修复 `assessBehavioralGate` `!smokeRequired` 缺陷并清除既有前端驱动工具硬编码文案）、`review-empirical.mjs` 与 `review-locks.mjs` 在缺 E2E 实证时阻断 `--include-diff`（`BLOCKED_EMPIRICAL_FIRST`）与 `pass`（`BLOCKED_PASS_WITH_OPEN_BLOCKERS`），解锁 `--include-diff` 后结合 `business-flows` / `C*` 做需求实质落地与根因判断（而非风格挑刺），E2E 运行失败自动写 `signals.jsonl`（`e2e.runtime-fail`）并接入 `C12` 建单闭环。
- [x] C16: 新增 `scripts/dev/fixtures-stageb-onboarding.mjs` (new)、`scripts/dev/fixtures-stageb-loop.mjs` (new) 与 `scripts/dev/injections-data-stageb.mjs` (new)（故障注入从 `I160` 起编号），覆盖 `C1..C15`、`C19` 全部正反双向用例与门禁拆解探测，`node scripts/dev/fixtures.mjs` 与 `node scripts/dev/verify-injections.mjs` 100% 通过。
- [x] C17: 新增 `scripts/dev/e2e-scenarios-stageb.mjs` (new) 接入 `scripts/dev/e2e-zip-harness.mjs`，从 `git archive --format=zip` 解压安装包黑盒执行 Scenario `H`（无远端本地工单起步 -> 新增远端并迁移/切回远端完整闭环至自动关单）、Scenario `I`（评审/规划双侧跨轮同人拦截、3 轮停损归因与分级建单）与 Scenario `J`（Node+Python 异构仓、非标文档、自定义脚本、自有技能 `S1–S4` 升级、`.githooks/pre-push`、`generic-git` 及真实非 `exit 0` 端到端实测失败建单修复复绿），退出码 `0`。
- [x] C18: 新增 `scripts/dev/blind-run-harness.mjs` (new)（留存 `scripts/dev/` 不进用户包，并登记于 `docs/TDD.md` 通过孤儿脚本审计），在隔离 `$TMPDIR` 克隆副本对多生态真实开源项目（含带自有项目级 Skill 与自定义规则且用新版重跑 `S1–S4` 校准的已规范仓）执行极简低提示词盲跑验收与实跑对方原生测试；发现的阻塞/跨范围问题全部通过「建单 -> SPEC/Todo -> 修复 -> 沉淀夹具与故障注入」清零；全仓所有 `.mjs <= 800` 行、`AGENTS.md` 符合体积预算（本仓 `< 24576 B`），`merge-gate` 全链命令全绿。
- [x] C23: 交付 `A6` 校验、跨特性交错 `Scenarios H–J` 与零提示词（Zero-Hint）盲测终验：① `flow-merge.mjs` 与 `review-empirical.mjs` 合并前强校 `headSha === evidence.headSha === review.headSha` 且工作区无脏改动，`evidence.json` 与盲跑结果计分拆分 `executed` / `succeeded` / `errorOnly` 三态（阻断空跑/错路径刷绿）；`flow.mjs verify` / `review` / E2E 失败输出脱敏 `Evidence` / `Unknowns` / `NextSteps` 诊断包并桥接 `C12` `escalation.mjs` (new) 自动建单；坚持「形式门禁 + 真实运行/E2E 实证 + `check-fault` 在前，解锁 `--include-diff` 后结合 `business-flows` / `C*` 做需求实质落地与根因判断（而非风格挑刺）」；编写确定性零 LLM Node CLI 故障注入 Stub 覆盖 `I160+`（含 `C20–C23` 探针）；② `scripts/dev/e2e-scenarios-stageb.mjs` (new) 在自建 HTTP/SSH 模拟远端与凭据下交错跑通离线 `Scenarios H–J`（覆盖无远端迁有远端、PR/Issue 标签前缀、按需 Milestone、双侧停损、`A1–A5` 与 E2E 失败建单）；③ 增设零提示词（Zero-Hint）全机制主调度组（全新无本仓上下文子代理）与轻/弱模型对照组对照及 `$TMPDIR` 多生态（Node/Python/Go/Rust 与 `LoopForge-main` 同构/自有技能升级）盲跑，必测「裸粘贴 Issue 链接」「裸粘贴同源 PR 与 Fork `inbound-external-pr` 链接」「初次接入含 `business-flows`/非标目录/原生测试隔离/自有技能保留 + Day-2 真实业务开发 + 二次 `S1–S4` 无损升级」并**专门验证轻/弱模型在审查时不跳过 E2E 只看 diff**，暴露的跳过/漏评/漏归档/弱模型跑偏或歧义一律按 `Issue -> SPEC/Todo -> Red-Green -> Review -> CI -> Merge` 根治并沉淀进离线回归。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（涉及最终行为门禁、契约门禁与 E2E 黑盒验证）；回滚做法：合入前丢弃分支；合入后单次反向提交并保留可复现失败样本。
- **高风险路径**：`kit/`、`templates/`、`SKILL.md`、`AGENTS.md`、`scripts/dev/preflight*`（须独立审查与故障注入验证）。
- **故障注入预演**：本片亲自落盘并实测 `I171`（`full-test` 跳过 `smoke-verify` 旁路）、`I172`（缺 E2E 观察回执仍放行 `--include-diff`/`pass`）及 `I160–I173` 全量故障注入捕获率 100%。

## 七、上线与兼容策略

- **向后兼容**：显式配置 `smoke-verify: none` 的纯底层无可执行入口库保留 `full` 放行；保留 `--visual-checked` 作为 `--e2e-evidence` 兼容别名；`v9` 合入 `main` 后遵守「日常合并止步，等待维护者明令再按 `RELEASING.md` 发版」。

## 澄清与补充记录

- （Wave 5 收官切片；本片在 `flow.mjs finalize` 时直接实证 `C19` 免传 `--include-master-prd` 自动闭合总控 PRD）
- （2026-11-18 · Issue `#83` 增补 `C23`：纳入 LoopForge `A6` 合并前 `headSha` 一致性/三态计分/脱敏诊断建单/CLI Stub、自建 HTTP/SSH 模拟远端交错 `Scenarios H–J`、零提示词（Zero-Hint）全机制主调度组 + 轻/弱模型对照组，以及含 `LoopForge-main` 同构升级、裸 Issue/PR 链接（含同源 PR 与 `inbound-external-pr`）及初次接入+Day-2+二次 `S1–S4` 在内的 `$TMPDIR` 盲跑终验）

## 实现说明

- **实际落地摘要**：按 SPEC 拆分 `scripts/dev/preflight-contracts.mjs` -> `scripts/dev/preflight-contract-rules.mjs`、拆分 `kit/skills/lib/git.mjs` -> `kit/skills/lib/git-core.mjs` 与 `kit/skills/lib/git-fast-objects.mjs` -> `kit/skills/lib/git-fast.mjs`（全部保持 `<= 700` 行及导出 100% 兼容）；落地 `C15` 通用运行+观察 E2E 硬门禁（保留 7 键 `Dev Profile`，修复 `GATE_TIER_RANK` 跳过 `smoke-verify` 与 `assessBehavioralGate` `!smokeRequired` 缺陷，接入 `--e2e-evidence` 与 `e2e.runtime-fail` 脱敏信号建单，阻断缺 E2E 实证的 `--include-diff` 与 `pass`）、`A6` 合前三方 `headSha`/干净工作区校核与 `executed`/`succeeded`/`errorOnly` 三态计分；补齐 `I160–I178` 故障注入与双向夹具、交付离线 `scripts/dev/e2e-scenarios-stageb.mjs`（Scenarios `H–J`）及 `$TMPDIR` 多生态盲跑工具 `scripts/dev/blind-run-harness.mjs`。
- **与草案的差异**：无实质偏离；新增 `kit/skills/lib/git-core.mjs` 与 `kit/skills/lib/git-fast-objects.mjs` 完成既有 Q6 行数瘦身，并在 `scripts/dev/fixtures-stageb-loop-b5.mjs` 独立承载 B5 双向验证与零 LLM CLI 故障注入 Stub 保持单文件 `<= 800` 行。
- **关联同步文件**：`templates/agents-project.md`、`AGENTS.md`、`references/collaboration.md`、`SKILL.md`、`kit/skills/dev-review/SKILL.md`、`.agents/skills/`、`docs/TDD.md`、`README.md`、`README.en.md`、`docs/prd/261118-v9-stageb-adaptive-architecture-prd.md`、`docs/todo/261118-issue76-b5-e2e-blind-run-gate-todo.md`。
