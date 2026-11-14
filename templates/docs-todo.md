---
kind: todo
title: "<任务标题>"
status: active
created: YYYY-MM-DD
updated: YYYY-MM-DD
issue: null
pr: null
branch: "<branch>"
owner: "<负责人>"
approved: false
done_at: null
task_id: "<taskId>"
planned_at: "<HEAD SHA>"
related_prd: null
related_spec: null
---

# <任务标题>

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `YYYY-MM-DD` / `YYYY-MM-DD` |
| 分支 / 基线 | `<branch>` @ `<HEAD SHA>` |
| 任务编号 | `<taskId>` |
| 负责人 / 审批 | `<负责人>` / `false` |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / 按需关联 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`<预计修改的目录或文件>`
- **复用既有模块**：<经 `dev-explore` 核实的现成模块/工具；无则说明为何不能复用>
- **本期不做**：<明确排除的顺手改造或扩展，防止范围蔓延>
- **门型与回滚路径**：`two-way` / `one-way`；回滚方式：<反向提交或恢复点操作>
- **快测命令**：`<从项目契约 Dev Profile 取 quick-test 与 smoke-verify（如涉及运行链路）>`
- **高风险提醒**：<是否触碰高风险路径或需要独立审查>

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: <第一条可判定的标准>
- [ ] C2: <第二条>

## 断点与遗留决策

- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）
- **待拍板事项**：<无，或列出需要人拍板的选项>

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：<命令 + 退出码 + 关键输出>
- **文档同步检查**：<已确认 `docs/TDD.md` / `README*.md` / `AGENTS.md` 是否需同步并随本次提交更新>
- **遗留问题**：<无，或对应的后续 Issue 编号>
