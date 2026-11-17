---
kind: todo
title: 平台事实、文档通用性与演进
status: active
created: 2026-11-17
updated: 2026-11-17
issue: 50
pr: null
branch: fix/v8-criteria-trust
owner: null
approved: false
done_at: null
task_id: platform-and-docs
planned_at: 73087a27cb9af3d9cea2988cc3e3e4d3b6154ec9
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261117-issue50-platform-and-docs-spec.md
---

# Todo: 平台事实、文档通用性与演进

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-17` / `2026-11-17` |
| 分支 / 基线 | `fix/v8-criteria-trust` @ `73087a2` |
| 任务编号 | `platform-and-docs` |
| 负责人 / 审批 | 待认领 / `false` |
| 认领的验收标准 | C1、C2、C3、C4、C5、C6、C7、C8、C9、C10 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/profile.mjs`、`scripts/survey.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-explore/SKILL.md`、`scripts/equip-ci.mjs`(new)、`scripts/lib/platform/registry.mjs`、`kit/skills/templates/docs-prd.md`、`kit/skills/templates/docs-spec.md`、`kit/skills/templates/docs-todo.md`
- **复用既有模块**：`verdict.mjs`、`tool-owned.mjs`、`workflow-policy.mjs` 的阶段判定、`protocol.mjs`
- **本期不做**：能力目录的语义检索；为每个平台写专用命令
- **门型与回滚路径**：one-way；模板逐份可回退，`prdRequired` 与 `checkOrphanSlices` 各自独立可关闭
- **快测命令**：`node scripts/dev/fixtures.mjs --domain docs`

## 验收标准与执行清单

- [ ] C1: 取舍解析只留一份实现；`questions` 可复现；`NEEDS_HUMAN` 机器可读
- [ ] C2: 如实报出托管平台与能力，非 GitHub 给出「先问人」的出口
- [ ] C3: 产物计划每个 `create` 都有执行入口，`preserve`/`pending` 不误报
- [ ] C4: 探索技能的「只读」与「写 TDD」只留一个
- [ ] C5: 治理类输入按面数判 Case 4；治理 PRD 覆盖产物计划每一项
- [ ] C6: 探索证据缺失时 next 只给探索这一步；`finalize` 对 TDD 警告不吞；波次计划；空 diff 不是 clean
- [ ] C7: 规划审核 Round 2 起必须换人
- [ ] C8: 文档兄弟集按 slug 认亲，不依赖同日
- [ ] C9: 文档模板「通用主干 + 可扩展章节」
- [ ] C10: 需求分级按装不装得进一份 SPEC；无主切片要报

## 执行步骤

1. 先补失败用例：跨天兄弟集、治理文案三种同义改写、两份无主 SPEC、Round 2 同人连审 —— 验证：`node scripts/dev/fixtures.mjs --domain docs`
2. 反向用例：不同 slug 不误合并、小需求不被判必写 PRD、共同指向一份 PRD 时不报无主 —— 验证：同上
3. 实现取舍单源、兄弟集按 slug、覆盖率与无主切片、Round 2 换人、需求分级 —— 验证：`node scripts/dev/fixtures.mjs`
4. 补故障注入（I78/I81/I82）并复验 —— 验证：`node scripts/dev/verify-injections.mjs`

## 断点与遗留决策

- **当前状态**：`部分完成`（C1、C2、C3、C4、C5、C7、C8、C10 已落地；C6 部分、C9 待拍板）
- **待拍板事项**：C9 的「audit 只强制最小核心」实质是放宽门禁，按本仓契约须人点头后再落（见 PRD 待拍板第 7 项）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/dev/fixtures.mjs --domain docs` → 7 项通过 / 0 失败；`node scripts/dev/fixtures.mjs` → 185 项通过 / 0 失败；`doc-plan audit .` → 9 份全部通过、覆盖率 0 漏项；`verify-injections --only I78`、`I81`、`I82`、`I83`、`I84`、`I85`、`I87`、`I88` 均红（正确）。
- **文档同步检查**：`SKILL.md` 的 S3 已改成「只读取证，由本步落笔」；`kit/skills/dev-explore/SKILL.md` 与 `.agents/` 字节一致。
- **遗留问题**：C6 的「波次计划」与「`finalize` 对 `tddSyncWarning` 非 0」未完成；C9 的模板最小核心需 PRD 待拍板第 7 项点头后生效（机制已落，判定权在人）。
