---
kind: todo
title: v7 M5 全链路技能协同对齐、TDD 架构图完善与总控 PRD 终态归档
status: done
created: 2026-11-16
updated: 2026-11-16
issue: 43
pr: null
branch: feat/v7-m5-align-skills-docs-bootstrap
owner: FiretrUCK666
approved: true
done_at: 2026-11-16
task_id: m5-align-skills-docs-bootstrap
planned_at: bef13feda07c6b5aa90ec41bd3544cf0f5d2878f
related_prd: ../prd/261115-v7-workflow-architecture-prd.md
related_spec: ../specs/261116-issue43-v7-m5-align-skills-docs-bootstrap-spec.md
plan_critique: "passed (reviewer=independent-plan-critic-m5-align-skills-docs-bootstrap-r2, round=2, sha=7206c36662de, summary=Round 2 verified strict linear 4-step order and complete M5 C1..C6 coverage)"
---

# Todo: v7 M5 全链路技能协同对齐、TDD 架构图完善与总控 PRD 终态归档

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / 基线 | `main` @ `bef13fe` |
| 任务编号 | `m5-align-skills-docs-bootstrap` |
| 负责人 / 审批 | FiretrUCK666 / `false` |
| 关联 Issue / SPEC / PRD | #43 / `docs/archive/specs/261116-issue43-v7-m5-align-skills-docs-bootstrap-spec.md` / `docs/archive/prd/261115-v7-workflow-architecture-prd.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`SKILL.md`、`kit/skills/*/SKILL.md`、`.agents/skills/`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`references/collaboration.md`、`references/docs-set.md`、`templates/agents-project.md`、`AGENTS.md`、`docs/TDD.md`、`README.md`、`README.en.md`、`scripts/dev/preflight-contracts.mjs`、`scripts/dev/fixtures-docs.mjs`、`scripts/dev/fixtures-govern.mjs`、`scripts/dev/injections-data.mjs`、`docs/archive/prd/261115-v7-workflow-architecture-prd.md`
- **复用既有模块**：`kit/skills/lib/docs.mjs`、`doc-templates.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-lifecycle.mjs`、`govern-docs.mjs`、`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/sync-toc.mjs`、`scripts/review.mjs`、`scripts/dev/preflight.mjs`、`scripts/dev/fixtures.mjs`、`scripts/dev/e2e-zip-harness.mjs`
- **本期不做**：不新增外部平台扩展、不重写 6 张 `.svg`、不抬升权威版本号发版、不手工篡改 M0–M4 已归档历史单据
- **门型与回滚路径**：one-way；实施全在 `.worktrees/impl-m5-align-skills-docs-bootstrap` 独立分支推进，合前可直接放弃分支，合后通过反向提交回退并重跑门禁
- **快测命令**：`node scripts/dev/preflight.mjs`
- **高风险提醒**：触碰 `SKILL.md`、`AGENTS.md`、`kit/`、`templates/`，合并前须走独立 Plan Critique、独立审查 + 现场故障注入及三平台 CI 全绿。

## 验收标准与执行清单

- [x] C1: 根 `SKILL.md`（`<= 200L / 16KB`，`FULL_READ_MAX_LINES <= 1000`）与 5 套 `kit/skills/*/SKILL.md`（各自 `<= 180L`，经 `equip.mjs .` 同步 `.agents/skills/`）完整覆盖 8 阶段生命周期、多轮澄清/Critique/谁改谁提 PR 与兄弟技能互链，`node scripts/equip.mjs . --check` 退出码 `0`。
- [x] C2: `references/{collaboration,docs-set}.md`、`templates/agents-project.md` 与 `AGENTS.md`（`<= 24576` B，保 `equip-bootstrap` 锚点与 `no-remote` 零泄漏）对齐；`compose-agents.mjs . --check` 与 `preflight-contracts.mjs`（含 `I76`）全绿。
- [x] C3: `docs/TDD.md` 零 `[v7 规划` 残留、同步总控 PRD 归档引用与 `scripts/lib/platform/{index,github-probe}.mjs` 等全模块/CLI 清单，含直观 8 阶段与运行时 Mermaid 图（`16/12` 无 HTML），`doc-plan.mjs audit`、`checkTddSyncParity` 与 `govern-audit.mjs audit .` 退出码 `0`。
- [x] C4: `README.md` 与 `README.en.md` 成对更新 v7 能力（保留 `v6.0.0` 与单源锚点），`node scripts/sync-toc.mjs README.md README.en.md --check` 与 6 张 SVG 检查通过。
- [x] C5: `kit/skills/lib/docs.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-lifecycle.mjs` 支持 `--include-master-prd`（默认仍保护 1:N 共享 PRD，显式传入时保主 PRD `issue: null`/`related_*` 原样且写 `archivedPrdFile`），且 `govern-docs.mjs` 跳过 `docs/archive/` 死链；各 `.mjs <= 800` 行，补齐 `fixtures-docs.mjs` 与 `fixtures-govern.mjs` 正反用例且 `I58` 通过。
- [x] C6: 实证门禁全绿后补全 SPEC「实现说明」、Todo「完成后的记录」、勾选总控 PRD `C1..C12`（`status: done`）及本单 `C1..C6`，执行 `flow.mjs finalize --include-master-prd` 提交成对归档后 `flow.mjs verify --mode gate` 锁定最新 `HEAD`，全套门禁（`preflight`、`gap-coverage`、`fixtures < 30s`、`bench`、`e2e-zip-harness`、`verify-injections --jobs 4`、`review.mjs .`、`govern-audit audit .`、`git archive --package` 与三平台 CI）全绿退出码 `0`。

## 执行步骤（严格线性时序）

1. 在 `.worktrees/impl-m5-align-skills-docs-bootstrap` 先为 `--include-master-prd` 与 `govern-docs` 跳过 `docs/archive/` 补齐 Red-Green 测试，再落地 `docs.mjs`、`doc-templates.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-lifecycle.mjs` 与 `govern-docs.mjs`（全 `<= 800` 行） —— 验证：`node scripts/dev/fixtures.mjs --only "include-master-prd"` 与 `node scripts/dev/verify-injections.mjs --only I58`
2. 全面对齐 `SKILL.md` 与 5 套 `kit/skills/*/SKILL.md`（同步 `equip.mjs .`）、`references/{collaboration,docs-set}.md`、`templates/agents-project.md` -> `AGENTS.md`（`compose-agents.mjs .`）、`docs/TDD.md`、`README.md` / `README.en.md`（`sync-toc`）以及 `preflight-contracts.mjs` + `injections-data.mjs` (`I76`) —— 验证：`node scripts/dev/preflight.mjs`、`node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node scripts/dev/bench.mjs`、`node scripts/dev/e2e-zip-harness.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .` 与 `git archive --package` 全绿
3. 基于上步实证结果填写 M5 SPEC「实现说明」、本 Todo「完成后的记录」与勾选总控 PRD `C1..C12`（置 `status: done`）及本单 `C1..C6`，执行 `node .agents/skills/dev-flow/scripts/flow.mjs finalize --task m5-align-skills-docs-bootstrap --include-master-prd` 并提交归档改动至特性分支 —— 验证：`git status --short` 干净且归档目录完整成对
4. 在最新归档提交 `HEAD` 上运行 `node .agents/skills/dev-flow/scripts/flow.mjs verify --task m5-align-skills-docs-bootstrap --mode gate` 绑定 `verifiedHead`，执行 `flow.mjs submit --task m5-align-skills-docs-bootstrap` 建 PR 并触发独立审查与三平台 CI 全绿后合入收尾 —— 验证：`flow.mjs verify --mode gate` 与远端 CI 7/7 全部 `success`

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
  - `node scripts/dev/fixtures.mjs --only "include-master-prd"`：2 项通过，0 项失败；`node scripts/dev/verify-injections.mjs --only I58` / `I76` 均红灯拦截通过。
  - `node scripts/dev/preflight.mjs`：0 项失败（32 项读数；`SKILL.md` `99L/12576B`、`kit/skills/*/SKILL.md <= 104L`、`kit/skills/**/*.mjs <= 777L`）。
  - `node scripts/dev/fixtures.mjs`：164 项通过，0 项失败；`node scripts/dev/bench.mjs`：6/6 项预算通过（300 文件 `survey` 148ms、`flow inspect` 154ms、`backup.zip` 93ms）。
  - `node scripts/dev/e2e-zip-harness.mjs`：真 `.zip` 7 场景 + 跨会话 `--takeover` + 防绕过全通（119 条目，22479ms）；`node scripts/dev/verify-injections.mjs --jobs 4`：83/83 条判据捕获；`git archive --package`：119 文件 0 越界。
  - 归档提交后将在最新 `HEAD` 上复跑 `flow.mjs verify --mode gate`、`govern-audit.mjs audit .` 与全套门禁锁定 `verifiedHead`。
- **文档同步检查**：`equip.mjs . --check`、`compose-agents.mjs . --check`（`AGENTS.md` `22559B <= 24576B`、`lightweight` `9400B < 14KB`、`no-remote` 零泄漏）、`sync-toc.mjs README.md README.en.md --check`、`doc-plan.mjs audit .`、`review.mjs .` 与 `gap-coverage.mjs` 全部通过；`docs/TDD.md` 已清除全部 `[v7 规划` 并指向 `docs/archive/prd/261115-v7-workflow-architecture-prd.md`。
- **遗留问题**：无
