---
kind: todo
title: 修复真实开源仓盲测发现的僵尸入口、存量大文件棘轮、手写契约与跨角色提示缺陷
status: done
created: 2026-11-22
updated: 2026-11-22
issue: 138
pr: 139
branch: feat/w5-blind-fixes
owner: impl-w5
plan_mode: autonomous
approved: false
done_at: 2026-11-22
task_id: w5-blind-fixes
planned_at: 4357b6126170244bbc05c08390ba91bda0c24f88
related_prd: null
related_spec: null
---

# 修复真实开源仓盲测发现的僵尸入口、存量大文件棘轮、手写契约与跨角色提示缺陷

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | `feat/w5-blind-fixes` @ `4357b61` |
| 任务编号 | `w5-blind-fixes` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #138 / 未关联 / 无 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`scripts/review.mjs`、`scripts/lib/survey-workspace.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`kit/skills/lib/credential-scan.mjs` (new)、`kit/skills/dev-iterate/scripts/iterate.mjs`、`kit/skills/lib/test-inventory.mjs`、`kit/skills/lib/workflow-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`docs/feature-map.json`、`scripts/dev/fixtures-w5-blind-fixes.mjs` (new)、`scripts/dev/injections-data-w5-blind-fixes.mjs` (new)
- **复用既有模块**：`kit/skills/lib/profile.mjs`（`parseAgentsProfile` / `isProfileExplicitNone`）、`kit/skills/lib/static-gates.mjs`（`countTextLines` / `scanStructuralHygiene`）、`kit/skills/lib/git.mjs`（`gitRun` / `posixPath` / `readTextSafe`）、`kit/skills/lib/cli.mjs`（`printNextStep`）
- **本期不做**：不重写全量历史大文件，不改动无关技能域逻辑，不向 `kit/` 引入第三方依赖。
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除特性分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 修复 `kit/skills/dev-explore/scripts/repo-map.mjs` 解析 `package.json`（`main`/`module`/`exports`/`bin`）入口路径，缺失的 `.js`/`.cjs`/`.mjs` 构建产物仅在同名或源码目录存在 `.ts`/`.tsx` 源码时映射收入，否则跳过；对齐既有测试并保持所有 `.mjs` 文件不超过 800 行。
- [x] C2: 在 `kit/skills/dev-edit/scripts/edit-gate.mjs` 实现存量大文件棘轮（Brownfield Ratchet）：新建或原本不超过 800 行的文件改动后超过 800 行继续触发硬阻断 `edit.file-oversized`；`baseRef` 原已超过 800 行的存量文件净增不超过 80 行以 `warning`（`edit.existing-oversized`）放行，净增超过 80 行触发硬阻断 `edit.file-oversized-growth`。
- [x] C3: 修复 `scripts/review.mjs` 在 `facts.kit?.installed` 且手写 `AGENTS.md` 时通过 `parseAgentsProfile` 校验有效 `Dev Profile`，缺失则报 `missing`（`agents.handwritten-missing-dev-profile`）；在 `kit/skills/lib/credential-scan.mjs` (new) 抽取单一真相 `.npmrc` 真实凭据正文判定原语供 `scripts/lib/survey-workspace.mjs` 与 `kit/skills/dev-govern/scripts/govern-checks.mjs` 共用（仅命中凭据模式才报敏感凭据，`node-linker=isolated` 等无害配置不误报，`govern-checks.mjs` 不超过 800 行）。
- [x] C4: 修复 `kit/skills/dev-iterate/scripts/iterate.mjs`（及 `kit/skills/lib/test-inventory.mjs`）识别 TypeScript 项目并生成 `.test.ts` 与 TS 兼容断言及运行命令；在 `kit/skills/lib/workflow-helpers.mjs`（`buildSubmitNextSteps`）、`kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs`（如相关）及 `kit/skills/dev-plan/scripts/doc-plan.mjs`（`audit`/`approve` 指向 `critique-*` 的 `[NEXT STEP]`）加入独立子代理/新会话角色交接硬提示。
- [x] C5: 执行 `node scripts/equip.mjs .` 同步 `.agents/skills/`、刷新 `docs/feature-map.json` 与 `verify-tools` 基线使 `StaleTools: 0`，新增 `scripts/dev/fixtures-w5-blind-fixes.mjs` (new) 与 `scripts/dev/injections-data-w5-blind-fixes.mjs` (new, `I417+`) 正反双向用例及故障注入并通过全量门禁。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 完善规划 Todo 并运行 `doc-plan audit` 与 `flow start`/`explore` | `doc-plan audit . --json` 通过 | 无 |
| 2 | 在 `fixtures-w5-blind-fixes.mjs` 补齐红灯用例与实现 `C1..C4` 根因修复 | `fixtures --domain w5-blind-fixes` 红转绿 | 步骤 1 |
| 3 | 同步 `.agents/skills/`、刷新 `feature-map`、补 `I417+` 注入并跑通全量门禁 | `preflight`/`fixtures`/`verify-injections`/`merge-gate` 全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无
- **下一步第一件事**：运行 `doc-plan.mjs audit . --json` 并只读勘察后通过 `flow.mjs start` 与 `flow.mjs explore` 转入实施。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`：通过（`.agents/skills/.pf-manifest.json` 字节级一致）
  - `node scripts/compose-agents.mjs . --check`：通过
  - `node scripts/sync-toc.mjs README.md README.en.md --check`：通过（8 项）
  - `node scripts/dev/preflight.mjs`：通过（40 项读数，0 失败）
  - `node scripts/dev/preflight-kernel-parity.mjs`、`node scripts/dev/cli-parity.mjs`、`node scripts/dev/gap-coverage.mjs`：均通过（0 失败）
  - `node scripts/dev/fixtures.mjs --jobs 6`：443 项通过，0 失败
  - `node scripts/dev/verify-injections.mjs --jobs 6`：361 条注入全部抓到（含 `I417..I424`）
  - `node scripts/dev/e2e-zip-harness.mjs`：场景 A–L 全通（224 条目）
  - `node scripts/dev/bench.mjs`：calibrated 6/6 全通（`unitMs=93ms`）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --task w5-blind-fixes --mode verify --final --json`：通过（0 blockers）
  - `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict`：通过（0 critical/high/medium）
  - `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit .`：通过（Features=22, Tools=22, Zombies=0, StaleTools=0）
  - `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit . --json`：通过（failedCount=0）
- **文档同步检查**：已运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`（含新增 `lib/credential-scan.mjs`），已更新 `docs/feature-map.json` 模块与 `testRefs` 并刷新验证工具基线；全仓 `.mjs` 均 <= 800 行。
- **遗留问题**：无
