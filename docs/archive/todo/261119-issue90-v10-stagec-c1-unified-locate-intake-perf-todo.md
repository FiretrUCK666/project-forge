---
kind: todo
title: v10 统一八技能、零写入按需定位、全局业务分诊与性能重构（Stage C-1）
status: done
created: 2026-11-19
updated: 2026-11-19
issue: 90
pr: null
branch: feat/stagec-c1
owner: impl-c2
approved: false
done_at: 2026-11-19
task_id: v10-stagec-c1
planned_at: 8566de3da467f5137f362ecad4323dbc093dca00
related_prd: ../../prd/261119-v10-stagec-unified-architecture-prd.md
related_spec: ../specs/261119-issue90-v10-stagec-c1-unified-locate-intake-perf-spec.md
---

# 任务清单：v10 统一八技能、零写入按需定位、全局业务分诊与性能重构（Stage C-1）

## 文档信息与范围概览

- **任务编号**：`v10-stagec-c1`
- **所属波次**：Wave C-1 左翼（与 `v10-stagec-c2` 并行实施，严守互斥写域；需待 Stage B 全量合入 `main` 后启动）
- **关联总控**：[Stage C 总控 PRD](../../prd/261119-v10-stagec-unified-architecture-prd.md)
- **关联设计**：[Stage C-1 设计规范](../specs/261119-issue90-v10-stagec-c1-unified-locate-intake-perf-spec.md)
- Issue: #90

## 任务范围与验证基准

- **修改范围**：统一 8 技能协议与去重模板、Markdown 解析下沉与只读按需定位器 `doc-locate.mjs` (new)、`flow intake` 业务分诊与 `TaskBackend.closePr`/`addLabels`、账本并发原子锁与状态机/性能全面优化。
- **严禁触碰**：`kit/skills/dev-edit/` (new)、`kit/skills/lib/{signals,static-gates,static-gates-lexer,profile-sniffer}.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-govern/SKILL.md` 及 `govern-{retro,state,tests,audit}.mjs`（保留给 C2 写域）；以及 `261118-*` Stage B 文件。
- **验证基准命令**：`node scripts/dev/preflight.mjs`、`node scripts/dev/gap-coverage.mjs`、`node scripts/dev/fixtures.mjs`、`node scripts/compose-agents.mjs . --check`、`node scripts/equip.mjs . --check`、`node scripts/dev/verify-injections.mjs`、`node scripts/dev/bench.mjs`。

### 不做什么（Non-Goals）

- 不实现 `dev-edit` 词法拦截门、三层倒金字塔 `signals.jsonl` 升格与 `dev-govern` 自动周期审计（归 `C2`）。
- 不实现 `dev-verify-tools`、`docs/feature-map.json` (new)、`dev-iterate` 或跨代 `merge3` 合并引擎（归 `C3`/`C4`）。

## 验收标准与执行清单

<!-- criteria:start -->
- [x] C1: （SC1）废除 `lightweight` 技能裁剪与 `14KB` 软/硬字节预算（保留 `--tier` 迁移别名提示），修复 `agents-defaults.mjs` `excludedSkillsFor` 漏洞、抽取共享 YAML 块标量读取器统一 `doc-frontmatter.mjs` 与 `skill-discovery.mjs` 并全域清理五技能字面量升级为统一 8 技能（波次间按实盘技能动态同步 `AGENTS.md`）；完成 `templates/agents-project.md` 去重，使空模板渲染产物约 `15KB` 且本仓 `AGENTS.md` 控制在 `18–19.8KB`（`< 24576 B`）。
- [x] C2: （SC2）将 fenced-code-aware Markdown 解析器下沉至 `kit/skills/lib/markdown-scan.mjs` (new)，交付零写入的 `kit/skills/dev-explore/scripts/doc-locate.mjs` (new)（支持 `--kind`/`--scope`/`--limit`/`--worktree`、无头首段摘要、绝对路径返回与 `~40–120ms`/`~1.5–2.2 KB` 预算）；接入 `session-orient.mjs`（识别 `ARCHITECTURE.md`/`*/AGENTS.md`/无头文档）与 `repo-map.mjs`，且 `handoff` 仅注入相关度 Top-3 定位切片。
- [x] C3: （SC3）落地全局业务分诊 `flow.mjs intake --pr {M} | --issue {N}`（豁免本仓已 `approve` 自研任务，`docs/TDD.md` 定位 + `--feature-ref` 锚点，经 `doc-comments.mjs` `buildIntakeDecisionComments` 输出结构化头 + `pf-state` + 人话评论并打标/关闭）；将 `TASK_BACKEND_METHODS` 扩至 17 方法（补齐 `closePr`、`GenericRemoteBackend` `delegatedPayload`、`LocalOnlyBackend` 持久化），在 `github-client.mjs` 实现 `getPr.labels`、REST 自动建标与 `addLabels` 写后回读及 `403` 降级，`write-probe-audit.mjs` 纳入 `closePr`/`closeIssue`，`review-pack` 前置阻断未分诊或已拒绝 PR。
- [x] C4: （SC4）收敛 `ledger.mjs` 统一原子加锁写入（保留 `writeTaskLedger` 加锁兼容委托），修复 `claimedAt`、`hasExploredEvidence`、`--agent`、`hydrateRemotePfState` 写权限校验与 `R1` 三项漏补（`doc-audit.mjs:7` `readdirSync`、`flow-batch.mjs:218-223` `queue.unshift`、`docs.mjs:556` `ledgerRoot`），统一 `flow status` 委托 `evaluateNextState`；API 批量调用限定并发 4，优化 `release-prep-lib.mjs`、`worktree-deps.mjs`、`verify-injections.mjs` 与 `e2e-zip-harness.mjs`（含 `fixtures`/`injections-data` 模块自动发现）。
<!-- criteria:end -->

## 执行步骤

- [x] 1. **统一 8 技能协议与去重模板（C1）**：更新 `scripts/lib/protocol.mjs`（注册 `UNIFIED_SKILL_NAMES`、移除 `lightweight` 裁剪与 `14KB` 限额、确保不写未落盘技能进 `AGENTS.md`）、修复 `scripts/lib/agents-defaults.mjs` 第 292 行、抽取共享 YAML 块标量读取器统一 `doc-frontmatter.mjs` 与 `skill-discovery.mjs`，重写去重 `templates/agents-project.md` 及 `scripts/lib/{agents-sections,survey-plan,survey-questions,survey-reentry,render,equip-bootstrap}.mjs` 与 `scripts/{equip,compose-agents,survey,review,handoff}.mjs`（拆出 `scripts/lib/survey-scan.mjs` (new)，`compose-agents.mjs <= 720L`），消除「5 技能 / 五套」字面量并同步执行 `equip.mjs . && compose-agents.mjs .`。
- [x] 2. **零改原文件按需定位与交棒 Top-3 注入（C2）**：下沉 `scripts/lib/markdown.mjs` 至 `kit/skills/lib/markdown-scan.mjs` (new) 并将原文件转为重导出；实现 `kit/skills/lib/doc-locator.mjs` (new) 与 `kit/skills/dev-explore/scripts/doc-locate.mjs` (new)（全量 CLI 标志、无头首段摘要、绝对路径与 `~40–120ms`/`~1.5–2.2 KB` 预算），接入 `kit/skills/lib/session-orient.mjs`（识别 `ARCHITECTURE.md`/`*/AGENTS.md`/无头文档）、`kit/skills/dev-explore/scripts/repo-map.mjs` 与 `kit/skills/lib/handoff-package.mjs`（Top-3 切片注入），更新 `kit/skills/dev-explore/SKILL.md` 与 `kit/skills/dev-plan/SKILL.md`。
- [x] 3. **全局业务分诊 `flow intake` 与 17 方法标签/关 PR 闭环（C3）**：实现 `kit/skills/lib/intake-triage.mjs` (new) 与 `kit/skills/dev-flow/scripts/flow-intake.mjs` (new)（`approved` 自研豁免、`docs/TDD.md` + `--feature-ref`）与 `doc-comments.mjs` `buildIntakeDecisionComments`；在 `task-backend.mjs` 扩展 `TASK_BACKEND_METHODS` 至 17 方法（`closePr`、`GenericRemoteBackend` `delegatedPayload`、`LocalOnlyBackend` 持久化）、`github-labels.mjs` (new) 与 `github-client.mjs` 实现自动建标/`addLabels` 回读/`403` 降级，更新 `scripts/dev/write-probe-audit.mjs:22` 与 `review-pack.mjs`/`review-pr.mjs` 守卫。
- [x] 4. **原子锁、`R1` 漏补、状态机修复与性能提速（C4）**：在 `kit/skills/lib/ledger.mjs` 统一 `updateTaskLedger` 并保留 `writeTaskLedger` 兼容加锁委托；补齐 `R1` 三处漏洞（`doc-audit.mjs:7`、`flow-batch.mjs:218-223`、`docs.mjs:556`）；拆分 `git-worktree-env.mjs` (new) 与 `git-index-fast.mjs` (new) 使 `git.mjs`/`git-fast.mjs <= 650L`；拆分 `flow-lifecycle-hooks.mjs` (new) 修复 `claimedAt`/`hasExploredEvidence`/`--agent` 并预留 C2 自动钩子；统一 `flow status` 与 `evaluateNextState`、修复 `hydrateRemotePfState`；拆分 `release-prep-collect.mjs` (new) 与实现并发上限 4 执行器、单次 `lstat` 卸载与 `verify-injections.mjs`/`e2e-zip-harness.mjs` 提速改造。
- [x] 5. **测试夹具自动发现与全门禁验收**：升级 `scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs` 支持通用功能域 `fixtures-*.mjs` / `injections-data-*.mjs` 自动加载，编写 `scripts/dev/fixtures-locate-intake.mjs`、`scripts/dev/injections-data-locate-intake.mjs` 并在 `scripts/dev/preflight-contract-rules.mjs` 增补功能域文件名确定性门禁与正反断言；执行完整 `merge-gate` 与 `bench.mjs`。

## 风险与应对

- **并发工作树合入顺序碰撞**：若 `C2` 先于 `C1` 合入 `main`，`C1` 合入前需 rebase 最新 `main` 并重跑 `node scripts/equip.mjs .`，自动将 `C2` 已落地的新技能同步进入 `.agents/skills/.pf-manifest.json`。
- **只读与幂等保证**：对 `doc-locate.mjs` (new) 在夹具内注入临时文件监听器或 git status 校验，确保运行前后零写入、零未跟踪残留。

## 回滚预案

- 未推分支可直接清理工作树丢弃改动；合入后如发现协议、字节超限或分诊误伤，通过单次 `git revert` 回滚 `C1` 合并提交；`equip` 写盘前统一经 `backup.mjs` 生成仓外恢复快照。

## 协作与依赖

- **前置依赖**：Stage B 全量合入 `main`；`C2` 依赖本切片合入后提供正式 8 技能协议与 `flow-lifecycle-hooks.mjs` (new) 挂载点（但在 Wave C-1 开发期双方互不修改对方文件）。
- **下游交接**：`C1` 落地后需第一时间通知波次协同者 rebase 并以最新 `markdown-scan.mjs` (new) 与 `doc-locator.mjs` (new) 作为后续 C3 功能地图接口基线。

## 断点与遗留决策

- 已完成，无遗留。

## 澄清与补充记录

- `2026-11-19`：明确 `release-prep-lib.mjs`、紧文件 `git.mjs`/`git-fast.mjs`/`flow-lifecycle.mjs` 均配备独立拆分目标（均降至 `<= 650–700L`）。
- `2026-11-19`：**维护者拍板彻底清理零历史包袱**：彻底删除 `lightweight` 概念、CLI `--tier lightweight` 与迁移分支、`LIGHTWEIGHT_*` / `14336 B` 预算常量及全部双档文案；并同步完成 PR/Issue 标题与正文可读性根治。
- `2026-11-19`：**架构纠偏根治过程编号文件名**：全仓 9 份历史过程命名测试脚本全部改名为功能域命名，本切片新增脚本命名为 `fixtures-locate-intake.mjs` / `injections-data-locate-intake.mjs`；自动发现改为通用 `fixtures-*.mjs` / `injections-data-*.mjs`，并在 `preflight-contract-rules.mjs` 沉入 Tier 2 确定性静态门禁 `checkProcessArtifactFilenames`（配双向夹具与 `I179` 注入）。

## 完成后的记录

- **在合并之前写完**（Issue `#90`，分支 `feat/stagec-c1`）：
  - **渲染字节实测**：纯文档模板渲染 `12,637 B`，Node 示例仓渲染 `13,243 B`，本仓 `AGENTS.md` `21,234 B`（`< 24,576 B` 推荐预算与 `30,720 B` 硬上限），全仓零 `lightweight` 残留。
  - **紧文件行数检查**：全部 14 份 SPEC 限高文件均在上限以内（`git.mjs` 416/650、`git-fast.mjs` 506/650、`github-client.mjs` 718/720、`release-prep-lib.mjs` 317/680、`flow-lifecycle.mjs` 681/700、`flow-lifecycle-hooks.mjs` 235/280、`flow-batch.mjs` 366/410、`compose-agents.mjs` 649/720、`survey.mjs` 562/700、`docs.mjs` 749/755、`doc-audit.mjs` 631/650、`equip.mjs` 665/720、`flow-inspect.mjs` 660/720、`preflight-contracts.mjs` 517/700），全仓 0 个 `.mjs > 800L`，0 个 `SKILL.md > 180L`。
  - **基准与实测耗时对比（`bench.mjs` + `$TMPDIR`）**：`survey(300 files)` `218 -> 187 ms`，`flow inspect(self)` `276 -> 207 ms`，`survey(self)` `425 -> 358 ms`，`review(self)` `389 -> 372 ms`，`preflight(self)` `2008 -> 1907 ms`，`backup.zip(1000 files)` `90 ms`；`doc-locate.mjs` 实测 CLI 97 ms（内核 26 ms）、输出 `1,580 B`、零写入；`verify-injections.mjs` 193 条注入约 95 s 全量捕获。
  - **门禁实证**：`preflight.mjs` 36/36（含 0 违规 `write-probe-audit` 与 0 违规功能域文件名门禁）、`gap-coverage.mjs` 20/20、`fixtures.mjs` 293/293、`verify-injections.mjs` 193/193、`compose-agents --check`、`equip --check`、`review.mjs .`、`sync-toc --check`、`doc-plan audit .`、`govern-audit --changed --strict` 全绿。
