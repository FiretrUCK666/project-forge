---
kind: todo
title: "{{TITLE}}"
status: active
created: {{TODAY}}
updated: {{TODAY}}
issue: {{ISSUE}}
pr: null
branch: {{BRANCH}}
owner: "{{OWNER}}"
approved: false
done_at: null
task_id: "{{TASK_ID}}"
planned_at: "{{HEAD_SHA}}"
related_prd: null
related_spec: null
---

# {{TITLE}}

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `{{TODAY}}` / `{{TODAY}}` |
| 分支 / 基线 | `{{BRANCH}}` @ `{{HEAD_SHA_SHORT}}` |
| 任务编号 | `{{TASK_ID}}` |
| 负责人 / 审批 | {{OWNER_LABEL}} / `false` |
| 关联 Issue / PR / SPEC | {{ISSUE_LABEL}} / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

<!-- section: goal -->
## 任务范围与验证基准

- **影响路径**：{{SCOPE_PATHS}}
- **复用既有模块**：{{REUSABLE}}
- **本期不做**：{{NON_GOALS}}
- **门型与回滚路径**：{{DOOR}}；{{ROLLBACK}}
- **快测命令**：`{{QUICK_CMD}}`

<!-- /section -->

<!-- section: acceptance -->
## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

<!-- criteria:start -->
- [ ] C1: <第一条可判定的标准>
- [ ] C2: <第二条>
<!-- criteria:end -->

<!-- /section -->

<!-- section: steps optional -->
## 执行步骤

1. 先补齐复现或验收测试 —— 验证：`{{QUICK_CMD}}`
2. 实现核心改动并补齐反面用例 —— 验证：`{{QUICK_CMD}}`

<!-- /section -->

<!-- section: breakpoint optional -->
## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：无

<!-- /section -->

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
