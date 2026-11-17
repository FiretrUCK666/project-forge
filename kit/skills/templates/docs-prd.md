---
kind: prd
title: "{{TITLE}}"
status: draft
created: {{TODAY}}
updated: {{TODAY}}
issue: {{ISSUE}}
pr: null
owner: "{{OWNER}}"
plan_critique: pending
related_spec: null
related_todo: null
---

# {{TITLE}} — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| in_review \| done \| dropped`） |
| 创建 / 更新 | `{{TODAY}}` / `{{TODAY}}` |
| 关联 Issue / PR | {{ISSUE_LABEL}} / 未关联 |
| 提出方 / 负责人 | {{OWNER_LABEL}} |
| 关联设计 / 任务单 | 按需补齐 `related_spec` / `related_todo` |

- **目标读者**：实现者、审查者与后续接手人

<!-- section: goal -->
## 一、要解决的问题

<!-- 一两段说清真实用户痛点与预期可观测收益 -->

- <现状痛点与预期可观测的收益>

<!-- /section -->

<!-- section: non-goals -->
## 二、范围与非目标

### 本次要做（In Scope）

- <明确交付能力>

### 明确不做（Non-Goals）

{{NON_GOALS}}

<!-- /section -->

<!-- section: reuse optional -->
## 三、复用既有模块

{{REUSABLE}}

<!-- /section -->

<!-- section: flow optional -->
## 四、关键交互与用户路径

1. <用户入口 / 触发动作 -> 响应与终态>

<!-- /section -->

<!-- section: acceptance -->
## 五、验收标准

<!-- criteria:start -->
- [ ] C1: <第一条可判定的产品结果>
- [ ] C2: <第二条>
<!-- criteria:end -->

<!-- /section -->

<!-- section: door optional -->
## 六、门型与回滚路径

- **门型判定**：{{DOOR}}
- **回滚路径**：{{ROLLBACK}}

<!-- /section -->

<!-- section: pending optional -->
## 七、待拍板问题

- 待确认：无（如有未决设计取舍请列明选项与代价）

<!-- /section -->

> 确认需调整系统模块或对外契约时，以此 PRD 为依据补充 `docs/specs/` 后再进入实现；需求全部交付后随同关联 `SPEC`/`Todo` 成对归档至 `docs/archive/prd/`。
