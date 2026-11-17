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

- **影响路径**：`kit/skills/lib/ledger.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/scripts/review-diff.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`scripts/compose-agents.mjs`、`scripts/lib/agents-sections.mjs`
- **复用既有模块**：`ledger.mjs` 的账本读写、`platform.mjs` 的 API 通道探测、`protocol.mjs` 的退出码常量
- **本期不做**：密码学意义上的身份认证
- **门型与回滚路径**：one-way；三条拒绝条件各自独立，可逐条移除；`flow-next.mjs` 的签发调用回退后账本令牌字段成为死数据
- **快测命令**：`node scripts/dev/fixtures.mjs --domain flow`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。**编号与 SPEC 一一对应。**

- [ ] C1: `record` 必须校验一次性令牌（同一令牌只能消费一次）；Round 不匹配 / 令牌不存在 / 令牌为空三种全部拒绝；`implementerId` 缺失时拒绝记录；**轮次只有一个派生式**（`nextReviewRound`），五处调用点全改，构造 `rounds = [1, 3]` 走完 `next` → `record` 必须成功；`review-gates.mjs` 打印的 `record` 命令必须带 `--review-token`。
- [ ] C2: **Issue 语境**。`flow start --issue N` 有通道时把标题与正文摘要写进账本与 `compactContext`；拿不到时留痕（编号 + 原因），`flow next` 给出具体命令；`--pr` 与 `--issue` 走同一条「尝试 → 留痕 → 给命令」链路；**永远没有通道的仓要有真实出口**（`--ack-no-issue-context --reason`，写进账本后不再拦）；反向：重跑 `start` 取到正文时清掉标记。
- [ ] C3: **PR 模式的基线只能来自真实 PR**。`getPr` 补 `baseRefOid` / `headRefOid`；`mode === 'pr'` 时 `diffScope` 必须是 `<baseRefOid>...<headRefOid>`，不得出现分支名；拿不到 SHA 返回 `BLOCKED_PR_UNRESOLVED` 且退出非 0；行为断言：账本记了 PR 号但远端拉不到时 `status` 不得是 `PACK_READY`；旁路断言：`role === 'inbound-external-pr'` 或 `isolation === 'review-pr'` 的任务走 `--task` 也必须过 PR 判据；账本要新增 `prBaseSha` / `prHeadSha` 两个字段才谈得上比对。
- [ ] C4: `compose-agents` 生成后，意图路由表里点名的每个 `SKILL.md` 路径都真实存在，不存在的必须报出来；装配档位与生成档位不一致时**必须拒绝并以非零退出码结束**（不用「或警告」）；删掉某个技能目录后（未跑 `equip`）要能指出死链；反向：装齐且档位一致的仓跑 `--check` 退出 0 且无任何死链告警。
## 断点与遗留决策

- **当前状态**：`进行中`（C1 已完成；C2 的 `compactContext` 与「重跑 start 清标记」、C3 的档位一致性与死链检测未完成）
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/dev/fixtures.mjs --domain flow` → 10 项通过 / 0 失败；`node scripts/dev/fixtures.mjs` → 185 项通过 / 0 失败；`verify-injections --only I79`（令牌一次性）、`--only I78`（规划审核同人连审）均红（正确）。
- **文档同步检查**：`kit/skills/dev-review/SKILL.md` 已补 `--review-token` 用法，与 `.agents/` 字节一致。
- **遗留问题**：C2 的 `compactContext` 未含 `issueContext`；重跑 `start` 不会重算 `issueContextUnavailable`；C3 的档位一致性与死链检测未实现。
