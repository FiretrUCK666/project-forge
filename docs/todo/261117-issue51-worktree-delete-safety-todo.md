---
kind: todo
title: worktree 通配清理的删穿保护
status: active
created: 2026-11-17
updated: 2026-11-17
issue: 51
pr: null
branch: fix/v8-criteria-trust
owner: null
approved: false
done_at: null
task_id: worktree-delete-safety
planned_at: 73087a27cb9af3d9cea2988cc3e3e4d3b6154ec9
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261117-issue51-worktree-delete-safety-spec.md
---

# Todo: worktree 通配清理的删穿保护

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-17` / `2026-11-17` |
| 分支 / 基线 | `fix/v8-criteria-trust` @ `73087a2` |
| 任务编号 | `worktree-delete-safety` |
| 负责人 / 审批 | 待认领 / `false` |
| 认领的验收标准 | C1、C2、C3 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-sync.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`scripts/dev/fixtures-flow.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`lstatSafe`、`EXIT_POLICY_BLOCK`（定义在 `flow-inspect.mjs`）、`printNextStep`、夹具助手 `tmpProject` / `gitInit` / `gitCommitFast`
- **本期不做**：跨平台文件系统层 delete-guard、硬链接处理
- **门型与回滚路径**：one-way；移除 `flow-cleanup.mjs` 的新增解绑调用与阻断分支即可回退，扫描器可保留
- **快测命令**：`node scripts/dev/fixtures.mjs --domain flow`

## 验收标准与执行清单

- [ ] C1: 外链存在时 `cleanup` 在删目录之前以 `EXIT_POLICY_BLOCK` 终止并逐条列出；主仓哨兵文件事后仍存在；悬空链接同样阻断；同一链接在 `sync`/`submit` 的解绑路径上不阻断
- [ ] C2: 无外链的普通 worktree 退出 0；worktree 内部链接不影响删除；`--allow-outbound` 逐条完全匹配放行；`--force` 不跳过外链检查；回执逐条列出解绑的路径与目标
- [ ] C3: 判据不以目录名白名单为前置；全深度遍历；`mainDepsIntact` 与删除前扫描同一集合；两个 mode 共用同一次扫描

## 执行步骤

1. 先补失败用例：5 种链接名（`vendor` / `shared` / `data` / `packages` / 中文名）、深一层嵌套链接、悬空链接、外链目标在 worktree 外、真实 `handleCleanup --confirm --force` 期望被阻断 —— 验证：`node scripts/dev/fixtures.mjs --domain flow`
2. 反向用例：无外链照常放行；worktree 内部互指不误判；`--allow-outbound` 逐条放行后回执含解绑清单 —— 验证：同上
3. 实现 `scanOutboundLinks` 全深度扫描与 `mode` 分档，接入 `flow-cleanup` 的删前解绑与回执明细 —— 验证：`node scripts/dev/fixtures.mjs`
4. 补两条故障注入（I22 跳过 `unlinkSync`、I22b 判据退回按目录名白名单筛）并复验 —— 验证：`node scripts/dev/verify-injections.mjs --only I22`

## 断点与遗留决策

- **当前状态**：`进行中`。已落地并有正反用例：全深度扫描、`mode` 分档、删前解绑、`--allow-outbound` 逐条放行、回执明细、深一层与悬空链接用例。C3 的「同一集合」断言已补（完好校验直接以扫描结果做基准，被拦下与跳过的目标也复核）。
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/dev/fixtures.mjs --domain flow` → 10 项通过 / 0 失败；`node scripts/dev/fixtures.mjs` → 185 项通过 / 0 失败；`verify-injections --only I22` 与 `--only I22b` 均红（正确）。
- **文档同步检查**：`AGENTS.md` 的「卸 worktree 前先仅对链接 `unlinkSync` 解绑」一条与本 SPEC 一致；`docs/TDD.md` 的 worktree 三档描述未变。
- **遗留问题**：无
