---
kind: todo
title: 独立审查与 Issue 语境
status: active
created: 2026-11-17
updated: 2026-11-17
issue: 52
pr: null
branch: fix/v8-criteria-trust
owner: null
approved: false
done_at: null
task_id: review-independence
planned_at: 73087a27cb9af3d9cea2988cc3e3e4d3b6154ec9
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261117-issue52-review-independence-spec.md
---

# Todo: 独立审查与 Issue 语境

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-17` / `2026-11-17` |
| 分支 / 基线 | `fix/v8-criteria-trust` @ `73087a2` |
| 任务编号 | `review-independence` |
| 负责人 / 审批 | 待认领 / `false` |
| 认领的验收标准 | C1、C2、C3 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/ledger.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/lib/workflow-policy.mjs`
- **复用既有模块**：`ledger.mjs` 的账本读写、`platform.mjs` 的 API 通道探测、`protocol.mjs` 的退出码常量
- **本期不做**：密码学意义上的身份认证
- **门型与回滚路径**：one-way；三条拒绝条件各自独立，可逐条移除；`flow-next.mjs` 的签发调用回退后账本令牌字段成为死数据
- **快测命令**：`node scripts/dev/fixtures.mjs --domain flow`

## 验收标准与执行清单

- [ ] C1: 独立审查凭一次性令牌；同令牌只能消费一次，轮次不符/不存在/为空三种全拒；`implementerId` 缺失时也拒
- [ ] C2: 贴了 Issue 就要把正文摘要取回来；取不到时明确记下编号与原因，`flow next` 给出取正文的命令
- [ ] C3: 意图路由点名的技能路径必须真实存在

## 执行步骤

1. 先补失败用例：编一个 reviewer-id 通过、同一令牌消费两次、Round 不符、无 API 通道时 Issue 正文缺失 —— 验证：`node scripts/dev/fixtures.mjs --domain flow`
2. 反向用例：正常签发的令牌一次消费成功、`flow next` 连跑两次拿到同一枚、正文取到后不再提示 —— 验证：同上
3. 实现令牌签发与消费、Issue 正文抓取、PR 未解析硬失败 —— 验证：`node scripts/dev/fixtures.mjs`
4. 补故障注入（I78 规划审核同人连审、I79 令牌可重复消费）并复验 —— 验证：`node scripts/dev/verify-injections.mjs`

## 断点与遗留决策

- **当前状态**：`进行中`（C1 已完成；C2 的 `compactContext` 与「重跑 start 清标记」、C3 的档位一致性与死链检测未完成）
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/dev/fixtures.mjs --domain flow` → 10 项通过 / 0 失败；`node scripts/dev/fixtures.mjs` → 185 项通过 / 0 失败；`verify-injections --only I79`（令牌一次性）、`--only I78`（规划审核同人连审）均红（正确）。
- **文档同步检查**：`kit/skills/dev-review/SKILL.md` 已补 `--review-token` 用法，与 `.agents/` 字节一致。
- **遗留问题**：C2 的 `compactContext` 未含 `issueContext`；重跑 `start` 不会重算 `issueContextUnavailable`；C3 的档位一致性与死链检测未实现。
