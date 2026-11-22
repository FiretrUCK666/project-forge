---
kind: todo
title: 门禁精准化、should-fix与lastRetro闭环、浅提示词路由及夹具防泄漏
status: active
created: 2026-11-23
updated: 2026-11-23
issue: 153
pr: null
branch: feat/gates-retro-routing-hardening
owner: coordinator
plan_mode: autonomous
approved: false
done_at: null
task_id: gates-retro-routing-hardening
planned_at: e5a7b558dfc84ae2093037c234a981869275fa44
related_prd: null
related_spec: ../specs/261123-issue153-gates-retro-routing-hardening-spec.md
---

# 门禁精准化、should-fix与lastRetro闭环、浅提示词路由及夹具防泄漏

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active` |
| 建单 / 更新 | `2026-11-23` / `2026-11-23` |
| 分支 / 基线 | `feat/gates-retro-routing-hardening` @ `e5a7b55` |
| 任务编号 | `gates-retro-routing-hardening` |
| 负责人 / 审批 | coordinator / `false` |
| 规划态 | `autonomous` |
| 关联 SPEC | `docs/specs/261123-issue153-gates-retro-routing-hardening-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch` 与关联分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/`、`templates/agents-project.md`、`AGENTS.md`、`.agents/skills/`、`scripts/dev/fixtures-helpers.mjs`、`scripts/dev/fixtures*.mjs`
- **复用既有模块**：`credential-scan.mjs`、`signals.mjs`、`govern-state.mjs`、`workflow-policy.mjs`
- **本期不做**：`scripts/equip.mjs`、`scripts/lib/merge3.mjs` 与 `scripts/lib/platform/registry.mjs`（已在 PR #152 完成）
- **门型与回滚路径**：two-way；独立 PR 回退即可恢复。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C1: 恒真占位断言与大面积断言删减升级 `deterministic` 硬阻断；支持 camelCase 断言识别。
- [x] C2: `edit-gate` 只对 diff 新增行做 hygiene 并放行合法归档；`doc-audit` 兼容同级相对互链。
- [x] C3: `--should-fix` 写 `signals.jsonl` 并入 `govern-retro`、`flow-next` 直读 `lastRetro`；`doc-plan-ops` 与 `plan-exit-gate` 双向闭环禁裸写 `skipped`。
- [x] C4: `govern` 排除 `testdata/*.pem` 误报与 Go bench/example；`workflow-policy` 显式报拒收 `--cmd`；`GenericRemoteBackend` 裸仓受控快进；`pnpm` worktree 自动注环境变量。
- [x] C5: `fixtures` 并发隔离 `TMPDIR` 无 Temp 目录泄漏、全文件 <= 800 行、`AGENTS.md < 24KB`、双层同步且全部门禁全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补足 `C1..C5` Red 失败测试用例 | 对应 `fixtures` 失败 | 无 |
| 2 | 按 SPEC 实现 `kit/skills/`、`templates/agents-project.md` 与 `fixtures-helpers` 改造 | 同步 `equip`/`compose-agents` 并跑通 `fixtures` | 步骤 1 |
| 3 | 全量离线门禁回归、提 PR 与独立审查 | 全量门禁全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：`已完成`
- **待拍板事项**：无
- **下一步第一件事**：完成 `finalize` 归档提交与 `verify` / `submit` 提 PR。

## 澄清与补充记录

- 已确认：严格保持 `AGENTS.md <= 24KB` 预警线，仅精炼补充浅提示词隔离与测试归档约束。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs --jobs 6`（480 项通过 / 0 失败，新建 `pf-*` Temp 残留 0）、`verify-injections.mjs --jobs 4`（388 条通过）、`e2e-zip-harness.mjs`（场景 A-L 全通）、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`、`govern-audit.mjs audit . --strict` 全数退出码 0。
- **文档同步检查**：已运行 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .` 保持 `.agents/skills/`、`AGENTS.md`（22,272B < 24KB）与 `kit/`/`templates/` 单源字节一致；SPEC 与 Todo `C1..C5` 已全勾选。
- **遗留问题**：无
