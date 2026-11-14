---
kind: spec
title: "<功能/变更标题>"
status: draft
tier: L3
created: YYYY-MM-DD
updated: YYYY-MM-DD
issue: null
pr: null
branch: null
owner: "<负责人>"
approved: false
implemented: false
plan_critique: pending
related_prd: null
related_todo: null
high_risk_paths: []
---

# <功能/变更标题> — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块重构、接口/契约变更或高风险改造；未 `approved` 前不编码） |
| 创建 / 更新 | `YYYY-MM-DD` / `YYYY-MM-DD` |
| 分支 / Issue / PR | `<branch>` / 未关联 / 未关联 |
| 负责人 / 内审状态 | `<负责人>` / `pending` |
| 关联 PRD / Todo | 按需补齐 `related_prd` / `related_todo` |

## 系统变更全景

```mermaid
flowchart LR
  In["请求输入"] --> Core["核心改动"]
  Core --> Gate["门禁验证"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `<真实文件路径，新建文件标 (new)>` | 改造 / 新增 | <受影响的模块、协议或对外契约> |

## 一、背景与边界声明

- **要改什么**：<受影响的模块、协议或对外契约>
- **不改什么**：<明确保持兼容或本次不触碰的模块>
- **本期不做**：<明确本期排除或故意延后的范围，防止顺手改造>
- **复用既有模块**：<先经 `dev-explore` 核实的可复用现有函数、协议或脚本入口；禁止另起炉灶>
- **与 `docs/TDD.md` 的关系**：<对齐既有不变量与 `arch-rules`；若冲突，须先退回更新 `docs/TDD.md`>

## 二、设计方案与契约变更

### 接口 / 数据结构变更

- <新增或调整的接口、参数、文件结构、退出码或状态流转>

### 异常、回退与安全边界

- <失败时如何降级或阻断、权限校验、并发/状态持久化保护>

## 三、冻结的验收标准

> 动手改代码前冻结；实现期间不顺手删减或放宽标准。每条必须能由一条命令或断言实证。

- [ ] C1: <第一条可判定的标准>
- [ ] C2: <第二条>
- [ ] C3: <正向与反向边界用例或门禁命令>

## 四、高风险点、门型与回滚路径

- **门型与回滚路径**：`two-way`（可局部回退）| `one-way`（不可逆变更）；回滚做法：<反向提交 / 兼容开关 / 数据回退步骤>
- **高风险路径**：<是否涉及核心契约、安全校验、迁移脚本等>
- **故障注入预演**：<审查时建议删改哪一行验证对应测试会变红>

## 实现说明

> 代码合入前补齐，随功能 PR 一同提交并标记 `implemented`；若常青架构已同步进 `docs/TDD.md`，随关联 `PRD`/`Todo` 成对归档至 `docs/archive/specs/`。

- **实际落地摘要**：<最终采用方案及与 `draft` 阶段方案的差异（如有）>
- **关联同步文件**：<同步更新的 `docs/TDD.md` / `README.md` / `AGENTS.md` 节点>
