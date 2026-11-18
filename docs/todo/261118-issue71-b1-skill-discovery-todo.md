---
kind: todo
title: v9 B1：动态 Skill 发现、自有技能路由保留与升级补齐
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 71
pr: null
branch: null
owner: "plan-stage-b"
approved: false
done_at: null
task_id: b1-skill-discovery
planned_at: 0aa20686354bde9fb6d5d77ed3b06323039c5123
related_prd: ../prd/261118-v9-stageb-adaptive-architecture-prd.md
related_spec: ../specs/261118-issue71-b1-skill-discovery-spec.md
---

# v9 B1：动态 Skill 发现、自有技能路由保留与升级补齐

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | 待启动 Wave 1 认领 @ `0aa2068` |
| 任务编号 | `b1-skill-discovery` |
| 负责人 / 审批 | `plan-stage-b` / `false` |
| 关联 Issue / PR / SPEC | `#71` / 未关联 / [B1 SPEC](../specs/261118-issue71-b1-skill-discovery-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC；启动实施前确认 `Wave 0.5` 已合入 `main`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/skill-discovery.mjs` (new)、`kit/skills/lib/cli.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/dev-*/SKILL.md`、`scripts/lib/protocol.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/agents-sections.mjs`、`scripts/lib/survey-reentry.mjs`、`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/handoff.mjs`、`templates/agents-project.md`、`AGENTS.md`、`scripts/dev/preflight-suite-checks.mjs` (new)、`scripts/dev/preflight-suite.mjs`、`scripts/dev/fixtures-equip.mjs`、`scripts/dev/fixtures-stageb-onboarding.mjs` (new)、`scripts/dev/fixtures-stageb-loop.mjs` (new)、`scripts/dev/fixtures.mjs`
- **复用既有模块**：`kit/skills/lib/doc-frontmatter.mjs`、`scripts/lib/protocol.mjs`、`scripts/equip.mjs`
- **本期不做**：不修改平台分支保护、本地工单后端或 E2E 门禁模块；不向代码引入任何外部项目 Skill 名称
- **门型与回滚路径**：`one-way`；合入前可直接废弃隔离工作树，合入后通过反向提交回退并重跑 `equip.mjs .` 与 `merge-gate`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: `kit/skills/lib/skill-discovery.mjs` (new) 动态扫描技能目录及 YAML `metadata` 字段（`tier`、`intent`、`script`、`order`、`fallback`），全仓清除硬编码 5 技能数组与写死路由，向临时 `kit/skills/` 放入第 6 个合规范内置技能后零改源码自动识别、`{{KIT_ROUTING_ROWS}}` 渲染与 `preflight-suite.mjs` 均退出 `0`。
- [ ] C2: 修复 `survey-reentry.mjs` 与 `agents-defaults.mjs` 漏读非隐藏技能容器缺陷，提取 `.agents/skills/*`、其他隐藏技能容器与非隐藏 `skills/*` 下全部非托管自有 `SKILL.md` 的 YAML frontmatter `name` 与 `description` 注入 `kit.customSkills` 与 `AGENTS.md` `意图路由`，`S1–S4` 升级完整保留，产品层无具体业务项目 Skill 名称硬编码。
- [ ] C3: 旧版已规范仓缺少新版新增内置技能且未入墓碑时，`survey.mjs` 在 `kit.uninstalledKitSkills` 报出并把 `kit-skills` 设为 `upgrade`，重跑 `S1–S4` 自动补齐新技能且完整保留墓碑/定制与自有技能，`equip.mjs --check` 与 `compose-agents.mjs --check` 退出 `0`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 拆分 `preflight-suite-checks.mjs` (new) 并预注册 `fixtures-stageb-onboarding.mjs` (new) 与 `fixtures-stageb-loop.mjs` (new) | `node scripts/dev/preflight.mjs` 通过且 `preflight-suite.mjs <= 680` 行 | `Wave 0.5` 合入 |
| 2 | 为 5 套 `kit/skills/dev-*/SKILL.md` 补全 `metadata` 并实现 `skill-discovery.mjs` (new)，先在 `fixtures-stageb-onboarding.mjs` (new) 写失败测试再切换全仓动态发现 | 新夹具由红转绿 | 步骤 1 |
| 3 | 运行 `node scripts/compose-agents.mjs .` 与 `node scripts/equip.mjs .`，核验 `AGENTS.md` 体积 `< 24576 B` 及全量 `merge-gate` | 全量门禁全绿 | 步骤 2 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| `arch-rules` 违例或 `.agents/skills/` 未同步 | `kit/` 反向引用 `scripts/` 或改完 `kit/skills/` 未重跑 `equip.mjs .` | 严格将扫描器置于 `kit/skills/lib/` 并跑 `preflight.mjs` 与 `equip.mjs . --check` |
| 既有自定义或墓碑技能在 `upgrade` 误覆盖 | 未先过滤 `disabledSkills`/`removedFiles`/`customizedFiles` | 复用现有 `equip` 三态合并路径并在正反双向夹具覆盖验证 |

## 回滚预案

- **出问题时的第一步**：`git status --short` 定位异常文件，恢复硬编码前先把诊断日志留存在分支内分析。
- **回滚用什么**：合入前 `git reset`/废弃分支；合入后单次 `git revert` 并重跑 `equip.mjs .` + `compose-agents.mjs .`。
- **回滚之后要做什么**：在 `#71` 评论记录失败原因并核实 `merge-gate` 恢复全绿。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 独立代码审查人 | 按 `C1–C3` 实证与故障注入复核 PR 并合并 | Wave 1 `submit` 后 | `review` 子代理 |

## 断点与遗留决策

- **当前状态**：`待 Wave 1 启动`（#71 已建单，规划文档已入 `docs/`）
- **待拍板事项**：无
- **下一步第一件事**：收到 Wave 1 启动指令后运行 `flow.mjs start --task b1-skill-discovery --issue 71 --case 4` 进入 `.worktrees/impl-b1-skill-discovery`。

## 澄清与补充记录

- （初始拆片任务单；含非隐藏 `skills/*` 与 `.agents/skills/*` `name`/`description` 路由抽取要求）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
