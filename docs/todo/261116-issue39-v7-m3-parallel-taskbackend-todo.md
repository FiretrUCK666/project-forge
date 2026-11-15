---
kind: todo
title: v7 M3 并行调度、TaskBackend、外部图谱/堆叠 PR 与通用初始化
status: active
created: 2026-11-16
updated: 2026-11-16
issue: 39
pr: null
branch: feat/v7-m3-parallel-taskbackend
owner: FiretrUCK666
approved: false
done_at: null
task_id: m3-parallel-taskbackend
planned_at: 7abfbeafed17e3d9ba9ef36b51b9c2c22e908ac0
related_prd: ../prd/261115-v7-workflow-architecture-prd.md
related_spec: ../specs/261116-issue39-v7-m3-parallel-taskbackend-spec.md
---

# Todo: v7 M3 并行调度、TaskBackend、外部图谱/堆叠 PR 与通用初始化

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / 基线 | `main` @ `7abfbea`（关联总控 PRD `docs/prd/261115-v7-workflow-architecture-prd.md`） |
| 任务编号 | `m3-parallel-taskbackend` |
| 负责人 / 审批 | `FiretrUCK666` / `false` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/specs/261116-issue39-v7-m3-parallel-taskbackend-spec.md` 及对应工作树最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/task-backend.mjs` (new)、`kit/skills/lib/task-graph.mjs` (new)、`kit/skills/lib/profile-sniffer.mjs` (new)、`kit/skills/lib/git-fast.mjs` (new)、`kit/skills/lib/exec.mjs`、`kit/skills/lib/git.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`flow-inspect.mjs`、`flow-lifecycle.mjs`、`flow-merge.mjs`、`flow-sync.mjs` (new)、`flow-batch.mjs` (new)、`flow-cleanup.mjs` (new)、`kit/skills/dev-review/scripts/review-pack.mjs`、`review-locks.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-govern/scripts/govern-tests.mjs`、`scripts/lib/equip-bootstrap.mjs` (new)、`scripts/lib/starter-templates.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/agents-sections.mjs`、`scripts/compose-agents.mjs`、`scripts/equip.mjs`、`templates/agents-project.md`、`SKILL.md`、`references/{survey,docs-set}.md`、`AGENTS.md`、`docs/TDD.md`、`scripts/dev/preflight-contracts.mjs`、`injections-data.mjs`、`scripts/dev/fixtures-m3.mjs` (new)、`fixtures.mjs`、`fixtures-{flow,m2,equip,claims,platform,govern}.mjs`。
- **复用既有模块**：`kit/skills/lib/exec.mjs`、`git.mjs`、`github-client.mjs`、`platform.mjs`、`ledger.mjs`、`docs.mjs`、`workflow-policy.mjs`、`flow-trial-merge.mjs`、`worktree-deps.mjs`、`review-locks.mjs`、`protocol.mjs`、`backup.mjs`。
- **本期不做**：不提前实现 M4（`govern-tests.mjs` AST 与死检查重构、Mermaid 全图扩展、`signals.jsonl`、`check.yml` 3-OS、Fake-Agent 真 `.zip` E2E）或 M5 全盘精简；不写入特定 AI 宿主/禁用平台名；所有 `.mjs` 保持 `<= 800` 行。
- **门型与回滚路径**：one-way；于独立分支与隔离工作树实施，已合入后采用 `git revert` 反向提交回退并重跑全门禁。
- **快测命令**：`node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs --domain m3`

## 验收标准与执行清单

- [x] C1: 外部图谱与堆叠 PR 完整可用——`scripts/dev/fixtures-m3.mjs` (new) 验证单 Issue、单 PR 未扫描审批阻断挂载与 verify、Issue+PR 互链防重复开 PR（`BLOCKED_DUPLICATE_PR_FOR_LINKED_ISSUE`）、未传入外部阻塞 `Depends on` 依赖拦截（`BLOCKED_UNRESOLVED_DEPENDENCY`）、`flow start --after` 与父未合禁合（`BLOCKED_STACK_PARENT_UNMERGED`）、`flow sync`（`rebase --onto`、`updatePrBase`、`syncCount`、`review-pack.mjs` 与 `review-locks.mjs` 基于 `range-diff` 新侧提交精准锁定 Round 2 视野）。
- [x] C2: 宿主无关并行调度与串行 FIFO 合并队列——`withFileLock`、`gitRun` `.git/*.lock` 指数退避、`computeWorktreeEnv`、`flow batch plan`/`check-disjoint`（`BLOCKED_OVERLAPPING_SLICE_FILES`）、`batch merge-queue`（基线漂移试合推进与冲突置 `queueConflict`/`rework` 准确路由 `needs-rework`）及 `batch resume-session` 全绿，且产品层零宿主词、零禁用平台词。
- [x] C3: 统一 `TaskBackend` 与 `no-remote` 零泄漏——`GitHubBackend`/`GenericRemoteBackend`/`LocalOnlyBackend` 13 项统一契约一致；无远端渲染 `AGENTS.md`（`lightweight`/`full`）零 `PR`/`origin`/`push` 且完整保留 `日常`/`不打标签`/`发版`/`明确说`/`不自己判断`/`日常到此为止`；`govern-audit.mjs` 不对纯本地仓误报 `tests.no-ci-config`；`generic-git` 禁本地越权合并（`exit 3`）。
- [x] C4: 通用 `--bootstrap-empty` 与三层命令嗅探——废除 6 栈 `greet` 玩具码，`--bootstrap-empty`（`--stack`/`--lang`）支持已有 `README.md`/`LICENSE` 并使新仓当场通过 `compose-agents --check` 与 `review.mjs`；`profile-sniffer.mjs` (new) 落实 `Dev Profile -> 4空格CI/Taskfile -> 深层非vendor多语言子包`（Windows 安全、产出 `detectionEvidence`）。
- [x] C5: `AGENTS.md`、`equip` 与 `doc-plan` 内审加固——多行 `{{CONVENTIONS_HINT}}` 不劈断注释、`maskVolatile` 不误伤 `main.mjs`/`domain`/`maintainer`、`compose-agents --adopt-custom` 解除 `--check` 死结并输出 `managedBytes`/`customBytes`（兼容 `I24`）、`equip --tier lightweight` 降档保留完好高阶技能与二次定制；`doc-plan critique-pass` 拦截 `SELF_CRITIQUE_REJECTED`、`audit` 提示 `prd`/`TDD`/非平凡 `todo` 独立内审与仓库自定模板识别。
- [x] C6: 性能与故障注入双绿——`node scripts/dev/fixtures.mjs` 默认并发全量跑通实测 `< 30,000 ms`（通过率 100%），`node scripts/dev/bench.mjs` 6/6 全过，`node scripts/dev/verify-injections.mjs`（含 `I64..I69`）全部拦截生效。
- [x] C7: 全仓库契约与结构门禁全绿——同步更新 `SKILL.md`、`references/{survey,docs-set}.md`、`AGENTS.md`、`docs/TDD.md`（移除对应 M3 规划标记）、`.agents/skills/` 与 `preflight-contracts.mjs`；所有 `.mjs <= 800` 行，完整 `merge-gate` 全项退出码为 0。

## 执行步骤

1. 拆分并扩展 L1/L2 内核：`exec.mjs` / `git.mjs`（`withFileLock`、Git 锁退避、`computeWorktreeEnv`、去重提速）、`git-fast.mjs` (new)、`github-client.mjs`（`updatePrBase`）、`task-backend.mjs` (new)、`task-graph.mjs` (new)、`profile-sniffer.mjs` (new)、`workflow-policy.mjs`、`shared.mjs` —— 验证：`node scripts/dev/preflight.mjs`
2. 研发流与治理审查接线：`flow.mjs` / `flow-inspect.mjs` / `flow-lifecycle.mjs` / `flow-merge.mjs` / `flow-sync.mjs` (new) / `flow-batch.mjs` (new) / `flow-cleanup.mjs` (new)、`review-pack.mjs` / `review-locks.mjs`、`govern-tests.mjs`、`doc-plan.mjs` / `doc-templates.mjs` / `docs.mjs` —— 验证：`node scripts/dev/fixtures.mjs --domain flow`
3. 起步与契约工具链升级及文档对拍：`starter-templates.mjs`、`equip-bootstrap.mjs` (new)、`equip.mjs`、`templates/agents-project.md`、`agents-sections.mjs`、`compose-agents.mjs`、`survey-ecosystem.mjs`、`SKILL.md`、`references/{survey,docs-set}.md` —— 验证：`node scripts/dev/fixtures.mjs --domain equip`
4. 同仓自举、夹具更新、注入与 `< 30s` 收口：更新 `preflight-contracts.mjs`、`injections-data.mjs`（`I64..I69`）、`fixtures-m3.mjs` (new)、`fixtures-{flow,m2,equip,claims,platform,govern}.mjs`、重跑 `equip.mjs .`、`compose-agents.mjs .`、更新 `docs/TDD.md` —— 验证：全量 `merge-gate` + `bench.mjs` + `verify-injections.mjs` + `fixtures.mjs` `< 30s`

## 断点与遗留决策

- **当前状态**：`已完成，无遗留`
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：完成全量 `merge-gate`、`node scripts/dev/fixtures.mjs`（157/157 通过，28,722 ms < 30,000 ms）、`node scripts/dev/bench.mjs`（6/6 预算全过）、`node scripts/dev/verify-injections.mjs`（76/76 全部变红拦截）、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .`（critical=0, high=0）及 `flow.mjs verify --task m3-parallel-taskbackend --mode gate` 实证。
- **文档同步检查**：已同步更新 `SKILL.md`、`references/{survey,docs-set}.md`、`README.md`、`README.en.md`（`sync-toc.mjs --check` 9/9 通过）、`AGENTS.md`（`compose-agents.mjs . --check` 通过）、`docs/TDD.md`（移除 M3 规划标记）及 `.agents/skills/`（`equip.mjs . --check` 通过）；总控 PRD `docs/prd/261115-v7-workflow-architecture-prd.md` 保持 `active` 未提前归档。
- **遗留问题**：无（M4/M5 按总控 PRD 分期推进）。
