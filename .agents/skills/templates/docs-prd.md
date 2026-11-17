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

### 现状与痛点

- <当前缺失什么、哪里卡住，附客观事实>

### 目标用户与使用场景

- <谁在什么触发条件下用它>

### 产品目标

- <这件事做成之后，哪个可观察的指标会变；不写「提升体验」这类形容词>

<!-- /section -->

<!-- section: non-goals -->
## 二、范围与非目标

### 本次要做（In Scope）

- <明确交付能力>

### 明确不做（Non-Goals）

{{NON_GOALS}}

<!-- /section -->

<!-- section: users optional -->
## 三、用户身份与权限

> 有「谁能做什么」的项目才需要这一节；纯工具/库可以整节删掉。

| 身份 | 能做什么 | 不能做什么 | 代码或配置中的载体 |
| --- | --- | --- | --- |
| `<角色 1>` | `<权限范围>` | `<明确排除>` | `<对应字段或表>` |

<!-- /section -->

<!-- section: flow optional -->
## 四、关键业务流程

> 只写主链路与必经分支；每一步都要能说出「谁触发、系统做什么、结果是什么」。

1. <用户入口 / 触发动作>
2. <系统响应与边界提示（成功 / 失败 / 缺配置时给用户的可见反馈）>
3. <终态结果>

<!-- /section -->

<!-- section: rules optional -->
## 五、状态与业务规则

> 有状态机的业务才需要这一节；无状态的工具类项目整节删掉。

| 对象 | 状态 | 允许的迁移 | 迁移的触发条件 |
| --- | --- | --- | --- |
| `<对象名>` | `<状态 A -> 状态 B>` | `<谁能触发>` | `<前置条件>` |

<!-- /section -->

<!-- section: reuse optional -->
## 六、复用既有模块

{{REUSABLE}}

<!-- /section -->

<!-- section: nfr optional -->
## 七、非功能要求

> 只写**本项目真正会被验收**的那几条。没有就整节删掉，不要留空表。

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 性能与容量 | <响应时间 / 并发 / 数据量上限> | <压测命令或观测方式> |
| 安全与隐私 | <权限边界、敏感数据处置> | <扫描或测试> |
| 兼容性 | <需要保持兼容的接口或数据格式> | <回归用例> |
| 可用性 | <失败时的降级或重试语义> | <故障注入> |

<!-- /section -->

<!-- section: acceptance -->
## 八、验收标准

<!-- criteria:start -->
- [ ] C1: <第一条可判定的产品结果（附具体命令、界面响应或可观测输出）>
- [ ] C2: <第二条>
<!-- criteria:end -->

<!-- /section -->

<!-- section: door optional -->
## 九、门型与回滚路径

- **门型判定**：{{DOOR}}
- **回滚路径**：{{ROLLBACK}}

<!-- /section -->

<!-- section: pending optional -->
## 十、待拍板问题

> 未清空不进独立 Critique；每条写清选项与各自代价。

- 待确认：无

<!-- /section -->

> 确认需调整系统模块或对外契约时，以此 PRD 为依据补充 `docs/specs/` 后再进入实现；需求全部交付后随同关联 `SPEC`/`Todo` 成对归档至 `docs/archive/prd/`。
