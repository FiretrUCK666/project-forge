---
kind: todo
title: Milestone 1：共享内核单源收敛、性能根治与纯 JS .zip 备份及自更新修复
status: done
created: 2026-11-15
updated: 2026-11-16
issue: 35
pr: null
branch: feat/v7-m1-perf-zip-core
owner: FiretrUCK666
approved: true
done_at: 2026-11-16
task_id: m1-perf-zip-core
planned_at: cd60c18ee7cb990f20c533ff837dd04709356132
related_prd: null
related_spec: ../specs/261115-issue35-v7-m1-perf-zip-core-spec.md
---

# Todo: Milestone 1：共享内核单源收敛、性能根治与纯 JS .zip 备份及自更新修复

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-15` / `2026-11-15` |
| 分支 / 基线 | `feat/v7-m1-perf-zip-core` @ `cd60c18` |
| 任务编号 | `m1-perf-zip-core` |
| 关联 Issue / SPEC | #35 / [SPEC](../specs/261115-issue35-v7-m1-perf-zip-core-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交；配套 SPEC 未 `approved` 前严禁开始编码（对应总控 PRD：`docs/prd/261115-v7-workflow-architecture-prd.md`）。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/`、`kit/skills/`、`scripts/`、`scripts/lib/`、`scripts/dev/`、`SKILL.md`、`AGENTS.md`、`README.md`、`README.en.md`、`references/`、`docs/TDD.md`、`.agents/skills/`
- **复用既有模块**：`scripts/zip.mjs`、`scripts/backup.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/shared.mjs`、`scripts/lib/protocol.mjs`
- **本期不做**：不提前实现 M2 状态机/六锁硬锁、M3 并行批调度/`TaskBackend`/`--bootstrap-empty` 重构或 M4 Fake-Agent 打包 E2E（各留待后续独立切片）。
- **门型与回滚路径**：`one-way`；异常时 `git revert` 回退并重跑全仓门禁。
- **快测命令**：`node scripts/dev/preflight.mjs`
- **高风险提醒**：触碰 `scripts/lib/`、`kit/`、`scripts/dev/preflight.mjs`、`templates/`、`SKILL.md`、`AGENTS.md`，须经独立 Plan Critique 并批准 SPEC，以及独立上下文审查 + 故障注入验收。

## 验收标准与执行清单

- [x] C1: Windows 本机 3 轮热态中位数达标（无 `--probe-auth` `flow inspect <= 300ms`、`survey <= 250ms`、`review <= 450ms`、`preflight < 2,500ms`、`fixtures` 子进程并发全绿 `< 30s`），且 `node scripts/dev/bench.mjs` 全项预算退出码 `0`。
- [x] C2: `scripts/backup.mjs` 默认产出 `.zip`（1,000 文件不超过 250ms、兼容恢复 `.tar.gz`、`./` 前缀及超过 20MB 整仓快照、修净 5 项缺陷与 `zip.mjs` `i+16` 偏移），正反夹具通过。
- [x] C3: `scripts/update.mjs` 修复 `--check` 纯只读、`--equip` 刷新、`verifyInstalled` 在 `applyPackage` 内核验全目录失败原子回滚、清理包内退役顶层文件且保留用户自建文件、代理/`GH_TOKEN` 与缺 `source` 不回退上游，正反夹具通过。
- [x] C4: 共享运行时单源收敛（每文件不超过 800 行，保持 `git.mjs` 导出 `buildNonInteractiveEnv`）且 `kit/** -> scripts/lib/**` 写入 `AGENTS.md` / `docs/TDD.md` `arch-rules` 与 `preflight`；Windows `.cmd` 执行与 `gitLsFilesTextAndCode` 4KB 探测及深层跳过通过夹具。
- [x] C5: `verify-injections.mjs` 可在 `.worktrees/*` 内直接跑绿全数注入；同步 `README.md`/`README.en.md` 等跨文件 `.zip` 与 `arch-rules` 契约对拍并完成 `equip.mjs .`、`compose-agents.mjs .` 与 `sync-toc.mjs --check` 自举全绿。

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`（待合入 PR 独立审查通过后由审查者合并）
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- 实际验证命令与结果：`node scripts/dev/bench.mjs` 6/6 全绿（`survey(300)` 中位数 146 ms / `flow inspect(self)` 163 ms / `survey(self)` 195 ms / `review(self)` 202 ms / `preflight(self)` 1403 ms / `backup.zip(1000)` 63 ms）；`node scripts/dev/fixtures.mjs` 136/136 全绿耗时 21652 ms（6 隔离子进程动态并发）；`node scripts/dev/verify-injections.mjs --jobs 6` 61/61 全红捕获；`preflight.mjs`（31 项读数 0 失败）、`gap-coverage.mjs`（19/19）、`compose-agents.mjs --check`、`equip.mjs --check`、`review.mjs`、`sync-toc.mjs --check`、`govern-audit.mjs audit .` 全绿；随后经 `flow.mjs verify --mode gate` 与 `preflight.mjs --package` 锁定最终提交。
- 文档同步检查：已同步 `docs/TDD.md`、`AGENTS.md`、`SKILL.md`、`README.md`、`README.en.md`、`references/` 与 `.agents/skills/`（`compose-agents --check`、`equip --check`、`sync-toc --check`、`review.mjs`、`gap-coverage.mjs` 全部通过）。
- 遇到的问题与回避方式：Windows 上 `cmd\git.exe` 包装器并发派生触发额外开销，且 `fixtures.mjs` 同步派生冷 `node.exe` 在 6 并发下放大至 30s 以上；通过在 `kit/skills/lib/exec.mjs` 直通真实 `mingw64\bin\git.exe`、`fixtures-helpers.mjs` 复用同进程 CLI 与 `gitInit` 合并配置写入，以及修复 `preflight-e2e.mjs` 懒加载确保 `I17` 注入可被 `gap-coverage` 捕获解决。
