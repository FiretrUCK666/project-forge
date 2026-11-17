---
kind: spec
title: "{{TITLE}}"
status: draft
tier: {{TIER}}
created: {{TODAY}}
updated: {{TODAY}}
issue: {{ISSUE}}
pr: null
branch: {{BRANCH}}
owner: "{{OWNER}}"
approved: false
implemented: false
plan_critique: pending
related_prd: null
related_todo: null
high_risk_paths: []
---

# {{TITLE}} — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `{{TIER}}`（跨模块重构、接口/契约变更或高风险改造；未 `approved` 前不编码） |
| 创建 / 更新 | `{{TODAY}}` / `{{TODAY}}` |
| 分支 / Issue / PR | `{{BRANCH}}` / {{ISSUE_LABEL}} / 未关联 |
| 负责人 / 内审状态 | {{OWNER_LABEL}} / `pending` |
| 关联 PRD / Todo | 按需补齐 `related_prd` / `related_todo` |

- **变更一句话**：<这次改完之后，系统多/少了什么能力>

## 系统变更全景

```mermaid
flowchart LR
  In["请求输入"] --> Core["核心改动"]
  Core --> Gate["门禁验证"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
{{MODULES}}

<!-- section: goal -->
## 一、背景与边界声明

- **要改什么**：<受影响的模块、协议或对外契约>
- **不改什么**：<明确保持兼容或本次不触碰的模块>
- **本期不做**：{{NON_GOALS}}
- **复用既有模块**：{{REUSABLE}}
- **架构基线关系**：<对齐既有不变量与 `arch-rules`；若冲突，须先退回更新 `docs/TDD.md`>
- **替代方案与否决理由**：<还考虑过哪条路、为什么不选它——这段最能防止下一轮推翻重来>

<!-- /section -->

<!-- section: design optional -->
## 二、设计方案与契约变更

### 接口 / 数据结构变更

{{CONTRACT_CHANGES}}

### 数据与状态变更

- <新增或调整的字段、状态、迁移；无则写「本次不涉及持久化变更」>

### 异常、回退与安全边界

{{SAFETY_BOUNDARIES}}

### 实现顺序

1. <先做什么、为什么必须先做它（依赖关系）>
2. <再做什么>

<!-- /section -->

<!-- section: alternatives optional -->
## 三、备选方案与否决理由

> 只写你真的考虑过的。这段最能防止下一轮把已经否掉的方案再拿出来讨论一遍。

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| `<已选>` | `<做法>` | `<决定性理由>` | `<出现什么情况说明选错了>` |
| `<备选>` | `<做法>` | `<否决理由>` | `<什么条件下它会变成更好的选择>` |

<!-- /section -->

<!-- section: breakdown optional -->
## 四、改动清单与影响面

> 一条一条列清「要动什么」。审查者按这张表核对 diff 有没有漏改。

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `<路径>` | 新增 / 修改 / 删除 | `<具体改什么>` | `<调用方 / 使用者>` |

- **对外可见的变化**：<CLI 参数、输出格式、接口签名、错误码；没有就写「无」>
- **需要同步改的地方**：<文档、测试、调用方、部署配置>

<!-- /section -->

<!-- section: acceptance -->
## 五、冻结的验收标准

> 动手改代码前冻结；实现期间不顺手删减或放宽标准。每条必须能由一条命令或断言实证。

<!-- criteria:start -->
- [ ] C1: <第一条可判定的标准>
- [ ] C2: <第二条>
<!-- criteria:end -->

<!-- /section -->

<!-- section: door optional -->
## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：{{DOOR}}；回滚做法：{{ROLLBACK}}
- **高风险路径**：{{HIGH_RISK}}
- **故障注入预演**：{{FAULT_INJECTION}}

<!-- /section -->

<!-- section: rollout optional -->
## 七、上线与兼容策略

> 需要灰度、开关或迁移的项目才需要这一节；纯内部重构整节删掉。

- **灰度与开关**：<是否需要特性开关、默认值与回滚开关位置>
- **数据迁移**：<迁移脚本位置、执行时机、可逆性>
- **向后兼容**：<旧调用方怎么办、兼容期多长>

<!-- /section -->

<!-- section: implementation optional -->
## 实现说明

> 代码合入前补齐，随功能 PR 一同提交并标记 `implemented`；若常青架构已同步进 `docs/TDD.md`，随关联 `PRD`/`Todo` 成对归档至 `docs/archive/specs/`。

- **实际落地摘要**：
- **与草案的差异**：
- **关联同步文件**：

<!-- /section -->
