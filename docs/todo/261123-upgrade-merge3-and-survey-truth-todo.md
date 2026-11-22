---
kind: todo
title: 零工作区污染 8-Skill 跨代升级与勘察身份提问一致性
status: active
created: 2026-11-23
updated: 2026-11-23
issue: null
pr: null
branch: feat/upgrade-merge3-and-survey-truth
owner: coordinator
plan_mode: autonomous
approved: false
done_at: null
task_id: upgrade-merge3-and-survey-truth
planned_at: 69fd2393921ed13d1b93db9fd28690af57a07a1a
related_prd: null
related_spec: ../specs/261123-upgrade-merge3-and-survey-truth-spec.md
---

# 零工作区污染 8-Skill 跨代升级与勘察身份提问一致性

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active` |
| 建单 / 更新 | `2026-11-23` / `2026-11-23` |
| 分支 / 基线 | `feat/upgrade-merge3-and-survey-truth` @ `69fd239` |
| 任务编号 | `upgrade-merge3-and-survey-truth` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `autonomous` |
| 关联 SPEC | `docs/specs/261123-upgrade-merge3-and-survey-truth-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch` 与关联分支最新提交。

## 任务范围与验证基准

- **影响路径**：`scripts/equip.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/lib/merge3.mjs`、`scripts/lib/platform/registry.mjs`、`scripts/lib/survey-questions.mjs`、`scripts/lib/survey-gap-rules.mjs`、`SKILL.md`、`references/survey.md`、`scripts/dev/blind-run-matrix.mjs`、`scripts/dev/e2e-scenarios-evolution.mjs`、`scripts/dev/fixtures-iterate-evolution.mjs`、`scripts/dev/fixtures-onboarding.mjs`
- **复用既有模块**：`scripts/zip.mjs`、`scripts/backup.mjs`、`scripts/lib/merge3.mjs`
- **本期不做**：`dev-edit`/`dev-review`/`dev-govern`/`dev-flow` 门禁修改与测试夹具防泄漏改造（交 PR 2）
- **门型与回滚路径**：two-way；可逆代码改造，按独立 PR 回退即可。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C1: 不传 `--base-dir` 时 8 个 Skill 非重叠改动 + `.mjs` 通过三层 `oldHash` 自动无损三方合并并退 `0`（`equip --check` 退 `0`）。
- [ ] C2: 同行重叠冲突旁路写至 `<gitCommonDir>/project-forge-conflicts/`，`.agents/skills/` 内零 `.upstream`/`.pf-conflict` 且 `.mjs` 零 `<<<<<<<`，解决冲突后旁路自动清理。
- [ ] C3: 移除 `!hasExplicitBase` 跳过漏洞；新登记缺失墓碑返回 `tombstonedNew` 且不自动 `--restore`。
- [ ] C4: 未知 HTTPS 通用远端判 `undetermined`、缺 Git 署名入 `NEEDS_HUMAN`、勘察明禁联网，全量离线门禁全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | Red 测试：补充无 `--base-dir` 8-Skill 自动融合与仓外冲突测试、未知 HTTPS `undetermined` 用例 | 新增 `fixtures` 红灯 | 无 |
| 2 | 实现 `equip-bootstrap` 三层基线查找、`merge3` 仓外旁路、`equip` 与 `registry`/`survey-questions` 改造 | `node scripts/dev/fixtures.mjs` 全绿 | 步骤 1 |
| 3 | 更新 `SKILL.md`/`references/survey.md` 与 `e2e`/`blind` 断言，跑全量门禁、提交、提 PR 与独立审查 | 全量门禁全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`进行中`（SPEC/Todo 审计与内审批准后派发隔离实施工人）
- **待拍板事项**：无
- **下一步第一件事**：在 `.worktrees/impl-upgrade-merge3-and-survey-truth` 跑 `doc-plan audit` 与独立 Critique。

## 澄清与补充记录

- 已确认：工作区 `.agents/skills/` 内冲突时绝不生成多余 `.upstream`/`.pf-conflict` 文件。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
