---
kind: todo
title: v9 B4a：存量异构仓通用勘察、外来文档隔离、business-flows 与改前基线
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 74
pr: null
branch: null
owner: "plan-stage-b"
approved: false
done_at: null
task_id: b4a-heterogeneous-survey
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_spec: ../specs/261118-issue74-b4a-heterogeneous-survey-spec.md
---

# v9 B4a：存量异构仓通用勘察、外来文档隔离、business-flows 与改前基线

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | 待启动 Wave 3 右列认领 @ `0aa2068` |
| 任务编号 | `b4a-heterogeneous-survey` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#74` / 未关联 / [B4a SPEC](../specs/261118-issue74-b4a-heterogeneous-survey-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC；启动前确认 Wave 1 (`B1` `#71`) 与 Wave 2 (`B2` `#72`) 已合入 `main`（本片与 Wave 3 左列 `B3` `#73` 源码写域 0 重叠，可并行开发）。

## 任务范围与验证基准

- **影响路径**：`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-plan.mjs`、`scripts/lib/survey-reentry.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/survey.mjs`、`kit/skills/lib/skill-discovery.mjs`、`kit/skills/lib/doc-shape.mjs`、`kit/skills/lib/doc-requirements.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`kit/skills/lib/tdd-facts.mjs`、`kit/skills/lib/tdd-scaffold.mjs`、`kit/skills/dev-explore/SKILL.md`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-plan/scripts/doc-audit-repo.mjs`、`kit/skills/dev-govern/scripts/release-prep-lib.mjs`、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`SKILL.md`、`references/survey.md`、`references/docs-set.md`、`scripts/dev/fixtures-stageb-onboarding.mjs` (new)
- **复用既有模块**：`kit/skills/lib/profile-sniffer.mjs`、`kit/skills/lib/doc-shape.mjs`、`kit/skills/lib/doc-requirements.mjs`、`kit/skills/lib/tdd-facts.mjs`
- **本期不做**：不触碰 `B3` 写域中的 `platform.mjs`/`render.mjs`/`survey-questions.mjs`/`flow*`；不写死具体外部目录名或项目名
- **门型与回滚路径**：`one-way`；合入前丢弃分支，合入后单次 `git revert` 并重跑 `equip.mjs .` 与 `merge-gate`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C9: `survey-docs.mjs` 探测非标设计目录、非 `.md` README、中性 CI（消除 `ci.absent` 误报）与 `.githooks/`；`survey-reentry.mjs` 与 `doc-audit-repo.mjs` 隔离外来 `docs/` 防误报 `FRONTMATTER_INVALID`；复用 `doc-shape.mjs` 证据跳节与异构模板兼容；`survey-workspace.mjs`/`survey-ecosystem.mjs`/`repo-map.mjs` 解除 `depth > 6` 硬截断并识别多包 glob、自动化脚本与 `exports` 对象映射。
- [ ] C10: `survey-plan.mjs` 新增 `business-flows` 分片只读 `repo-map.mjs` 输出业务流映射；`SKILL.md` 与 `references/survey.md` 规定 `S1 -> S3` 改前只读实跑对方既有测试与入口建立基线；重资产入 `docs/TDD.md`，`AGENTS.md` 严守轻量体积上限。
- [ ] C21: 落地 `A7` 存量异构盲点：`survey-reentry`/`skill-discovery`/`agents-defaults`/`survey-docs` 区分非隐藏 `skills/*`、`.agents/skills/*` 与深层宿主镜像并扫描 `*/AGENTS.md`；`survey-docs`/`doc-shape`/`release-prep-lib`（`<= 795` 行）/`govern-docs`/`review-gates`/`doc-templates` 泛化多语配对文件名（`README.*.md`、`CONTRIBUTING.*.md`、`SECURITY*.md`、`*.zh-CN.md`）；`repo-map.mjs` 补 `pyproject.toml` `[project.scripts]` 与 `cmd/*/main.go`；`profile-sniffer.mjs` 隔离重型 `e2e/`/`webtest/` 并聚合多 workflow。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 扩展 `survey-docs`/`survey-workspace`/`survey-ecosystem`/`survey-reentry`/`agents-defaults`/`skill-discovery`/`profile-sniffer`、`doc-audit-repo`/`doc-shape`/`doc-templates`/`release-prep-lib`/`govern-docs`/`review-gates` 异构兼容与 `A7` 盲点，并在 `fixtures-stageb-onboarding.mjs` 写失败前置用例 | 新夹具先红后绿，且 `release-prep-lib.mjs <= 795` | `#71`、`#72` 已合入 `main` |
| 2 | 实现 `business-flows` 分片、`repo-map.mjs` 业务流分析（含 `pyproject.toml` `[project.scripts]` 与 `cmd/*/main.go`）、`tdd-facts`/`tdd-scaffold` 承接与 `SKILL.md`/`references/` 基线规范 | `fixtures-stageb-onboarding.mjs` 全绿且 `SKILL.md <= 200` 行 | 步骤 1 |
| 3 | 若平行列 `B3` 先合入，执行 rebase 后运行 `node scripts/equip.mjs .` 并跑通全量 `merge-gate` | 全量门禁全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 放过受管但写坏的 `docs/specs/*` | `isManagedPlanDoc` 条件过于宽松 | 凡含标准 Frontmatter `kind:` 或受管模板标记均严格审核，写正反双向断言验证 |
| 解除 `depth > 6` 后遇 symlink 环导致慢扫/死循环 | 存在循环软链或超深大目录 | 在遍历中维护规范真实路径 `Set` 去重及受控扫描上限 |

## 回滚预案

- **出问题时的第一步**：运行 `doc-plan.mjs audit .` 与 `preflight.mjs` 定位受损判据或超出 `SKILL.md` 行数限制处。
- **回滚用什么**：`git revert` 回退提交并重跑 `equip.mjs .` 与 `fixtures.mjs`。
- **回滚之后要做什么**：在 `#74` 评论记录导致误判的目录形态样例。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 并行协同切片 `B3` | 保持源码写域 0 重叠，后合入者重跑 `equip.mjs .` 对齐 `.pf-manifest.json` | Wave 3 并行阶段 | `B3` 实施者 / `coordinator` |
| 独立代码审查人 | 核验异构兼容、外来文档隔离与 `business-flows` 实测并合入 | `submit` 提审后 | `review` 子代理 |

## 断点与遗留决策

- **当前状态**：`待 Wave 3 启动`（依赖 `#71`、`#72` 先行合入）
- **待拍板事项**：无
- **下一步第一件事**：Wave 3 启动后执行 `flow.mjs start --task b4a-heterogeneous-survey --issue 74 --case 4` 进入 `.worktrees/impl-b4a-heterogeneous-survey`。

## 澄清与补充记录

- （已合并协调者要求：在 `C9` 复用 `doc-shape.mjs` 证据跳节逻辑与异构模板兼容，不向非标仓库强套多余章节）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
