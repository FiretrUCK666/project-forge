---
kind: todo
title: README 清爽重排与 AGENTS 意图路由补强
status: done
created: 2026-11-22
updated: 2026-11-22
issue: null
pr: null
branch: feat/ux-readme-and-routing
owner: coordinator
previous_owners: [impl-readme-routing]
plan_mode: autonomous
approved: false
done_at: 2026-11-22
task_id: ux-readme-and-routing
planned_at: 02ad60126a0c19ded45673a22f61110d58fd623c
related_prd: null
related_spec: null
owner_changed_reason: 本 Todo 需求与验收口径由协调者下发，impl-readme-routing 为独立实施代理
owner_changed_at: 2026-11-22
---

# README 清爽重排与 AGENTS 意图路由补强

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | `feat/ux-readme-and-routing` @ `02ad601` |
| 任务编号 | `ux-readme-and-routing` |
| 负责人 / 审批 | coordinator / `false`（具体实施人：impl-readme-exec） |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`templates/agents-project.md`、`kit/skills/*/SKILL.md`、`.agents/skills/`、`AGENTS.md`、`README.md`、`README.en.md`
- **复用既有模块**：`scripts/lib/agents-defaults.mjs`（`renderKitRoutingRows`）、`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/sync-toc.mjs`
- **本期不做**：不修改任何 `.mjs` 脚本逻辑或 `references/` 核心判据，不修改 5 张 SVG 资源文件
- **门型与回滚路径**：two-way；局部文档与模板文本改动，可直接 `git revert` 回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: `templates/agents-project.md` 与 `kit/skills/*/SKILL.md` 意图路由短语补强后，`node scripts/equip.mjs . --check` 与 `node scripts/compose-agents.mjs . --check` 退出码 0，且 `AGENTS.md` 保持 `< 24KB`（硬上限 `30KB`）、各 `SKILL.md` 不超 `protocol.mjs` 预算。
- [x] C2: `README.md` 与 `README.en.md` 完成首页触发语替换、去文字墙模块化重排、8 个本地技能拆分为「主链 5 + 外环 3」双表，保留 5 张 Risograph SVG、徽章、双语互链与 `<details>` 折叠区，且 `node scripts/sync-toc.mjs README.md README.en.md --check` 退出码 0。
- [x] C3: `python "C:\Users\FiretrUCK\.gemini\config\skills\oil-tone\scripts\tone_lint.py" README.md` 无 FAIL，无明显 AI 模板腔。
- [x] C4: 全量门禁 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs --jobs 6`、`verify-injections.mjs --jobs 6`、`e2e-zip-harness.mjs`、`review.mjs .`、`edit-gate.mjs --changed --final --json`、`govern-audit.mjs audit . --strict` 全绿。
- [x] C5: 按序执行 `flow.mjs finalize` -> `flow.mjs verify --tier gate`（`merge-gate` 12/12）-> `flow.mjs submit --agent impl-readme-exec` 成功创建 PR。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补强 `templates/agents-project.md` 与 `kit/skills/*/SKILL.md` 意图路由并同步 `.agents/skills/` 与 `AGENTS.md` | `equip.mjs --check` 与 `compose-agents.mjs --check` 通过 | 无 |
| 2 | 成对重排 `README.md` 与 `README.en.md` 并同步目录与文风检查 | `sync-toc.mjs --check` 与 `tone_lint.py` 通过 | 步骤 1 |
| 3 | 跑通全量门禁、归档 Todo、门禁验证并提交 PR | `merge-gate` 12/12 与 `flow.mjs submit` 通过 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`已完成待归档提单`（由 `impl-readme-exec` 接手完成门禁实证并归档提交 PR）
- **待拍板事项**：无
- **下一步第一件事**：分类提交改动并按 `claim` -> `finalize` -> `verify --tier gate` -> `submit` 提交 PR。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`：exit 0（套件校验通过：`.agents/skills/.pf-manifest.json`）
  - `node scripts/compose-agents.mjs . --check`：exit 0（`AGENTS.md` 22088 字节，`< 24KB` 建议阈值，标记成对、内容与模板一致）
  - `node scripts/sync-toc.mjs README.md README.en.md --check`：exit 0（`README.md` 与 `README.en.md` 目录均已是当前状态，各 7 项）
  - `python "C:\Users\FiretrUCK\.gemini\config\skills\oil-tone\scripts\tone_lint.py" README.md`：exit 0（`PASS  no known oil-tone failures`）
  - `node scripts/dev/preflight.mjs`：exit 0（自检通过：0 项失败；`SKILL.md` 101 行 / 13912 字节；`AGENTS.md` 22088 字节；8 个 Skill 均 `<= 180` 行且与 `.agents/skills/` 字节级一致）
  - `node scripts/dev/gap-coverage.mjs`：exit 0（缺口覆盖：20 条各有处置，映射都指向真实结论）
  - `node scripts/dev/fixtures.mjs --jobs 6`：exit 0（行为断言：460 项通过，0 项失败）
  - `node scripts/dev/verify-injections.mjs --jobs 6`：exit 0（故障注入复验：388 条判据都能被抓到）
  - `node scripts/dev/e2e-zip-harness.mjs`：exit 0（真 `.zip` 安装包 Fake-Agent E2E 全通：基础场景 A-G + 生命周期与演化 Scenarios H-L，包条目 235，耗时 45955 ms）
  - `node scripts/review.mjs .`：exit 0（交付体检：可以交付；1 项可选 hooks 建议不阻断）
  - `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --final --json`：exit 0（checked=18, blockers=0, warnings=8 均为 `edit.high-risk-path` 提示）
  - `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict`：exit 0（critical=0, high=0；仅有既有 worktree hygiene 提示）
- **文档同步检查**：`README.md` 与 `README.en.md` 成对重排并经 `sync-toc.mjs --check` 通过；`templates/agents-project.md`、`kit/skills/*/SKILL.md`、`.agents/skills/`（含 `.pf-manifest.json`）与 `AGENTS.md` 均经 `--check` 校验字节一致。
- **遗留问题**：无；`dev-flow` 收尾流程（`claim` -> `finalize` -> `verify --tier gate` -> `submit`）紧随本记录提交后执行。
