---
kind: todo
title: "Slice 2: 八技能降熵去误杀、多会话零冲突与通用认知契约"
status: done
created: 2026-11-28
updated: 2026-11-28
issue: 252
pr: null
branch: feat/s2-harness-multisession-cognitive
owner: planner-s2-spec
plan_mode: interactive
approved: false
done_at: 2026-11-28
task_id: s2-harness-multisession-cognitive
planned_at: d9f375dbfad0330fb460c9c89adfc61a53b607bd
related_prd: ../prd/261128-universal-deentropy-redesign-prd.md
related_spec: ../specs/261128-issue252-s2-harness-multisession-cognitive-spec.md
---

# Slice 2: 八技能降熵去误杀、多会话零冲突与通用认知契约

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-28` / `2026-11-28` |
| 分支 / 基线 | `feat/s2-harness-multisession-cognitive` @ `d9f375d` |
| 任务编号 | `s2-harness-multisession-cognitive` |
| 负责人 / 审批 | planner-s2-spec / `false` |
| 规划态 | `interactive`（Wave 2 终局切片，认领总控 PRD `C10..C20`，交付时勾齐 `C1..C20` 成对归档总控 PRD） |
| 关联 Issue / PR / SPEC | #252 / 未关联 / `docs/archive/specs/261128-issue252-s2-harness-multisession-cognitive-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `feat/s2-harness-multisession-cognitive` 分支最新提交，并先读完关联 SPEC 四、五两节文件边界与注入迁移表。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-explore/scripts/repo-map-helpers.mjs`、`kit/skills/lib/feature-map.mjs`、`kit/skills/lib/suite-inventory.mjs`、`kit/skills/lib/suite-runner.mjs` (new)、`kit/skills/dev-iterate/scripts/iterate-plan.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/static-gates-comment-hygiene.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/static-gates-lexer.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`、`kit/skills/dev-govern/scripts/govern-tests.mjs`、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`kit/skills/dev-govern/scripts/govern-evergreen.mjs`、`kit/skills/dev-govern/scripts/govern-state.mjs`、`kit/skills/dev-flow/scripts/flow-sandbox.mjs`、`kit/skills/dev-plan/scripts/doc-plan-ops.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-flow/scripts/flow-merge-claim.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/lib/session-state.mjs`、`kit/skills/lib/session-topics.mjs` (new)、`kit/skills/lib/concurrency-radar.mjs` (new)、`kit/skills/lib/harness-context.mjs`、`kit/skills/dev-flow/scripts/flow-start-helpers.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-plan/scripts/doc-plan-brief.mjs`、`kit/skills/lib/plan-next.mjs`、`kit/skills/lib/session-orient.mjs`、`kit/skills/lib/handoff-package.mjs`、`kit/skills/lib/platform-registry.mjs`、`kit/skills/lib/task-backend.mjs`、`kit/skills/lib/doc-comments.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`scripts/compose-agents.mjs`、`scripts/dev/injections-data-core.mjs`、`scripts/dev/injections-data-edit-pyramid.mjs`、`scripts/dev/injections-data-gates.mjs`、`scripts/dev/injections-data-r6c.mjs`、`scripts/dev/injections-data-w4-harness.mjs`、`scripts/dev/injections-data-w5-blind-fixes.mjs`、`scripts/dev/injections-data-sandbox-flow.mjs`、`scripts/dev/injections-data-conv-s2.mjs`、`scripts/dev/injections-data-iterate-evolution.mjs`、`scripts/dev/injections-data-trace-sync.mjs`、`scripts/dev/fixtures-r5-static-gates.mjs`、`scripts/dev/fixtures-heterogeneous-dual-loop.mjs`、`scripts/dev/fixtures-w4-harness.mjs`、`scripts/dev/fixtures-w5-blind-fixes.mjs`、`scripts/dev/fixtures-sandbox-dual-loop.mjs`、`scripts/dev/fixtures-conv-s2.mjs`、`scripts/dev/fixtures-s2-harness-multisession.mjs` (new)、`scripts/dev/fixtures.mjs`、`SKILL.md`、`AGENTS.md`、`templates/agents-project.md`、`references/survey.md`、`references/collaboration.md`、`kit/skills/*/SKILL.md`、`docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md`、`assets/readme/`。
- **复用既有模块**：`kit/skills/lib/profile-sniffer.mjs`（`extractStructuredCiSteps`、`scanDeclaredTaskRunners`）、`kit/skills/lib/import-graph.mjs`（`resolveLocalImportTarget`）、`kit/skills/lib/git.mjs`（`withFileLockSync`、`canonicalPath`、`COMMON_SKIP_DIRS`）、`kit/skills/lib/sandbox-scope.mjs`（`checkScopeListsOverlap`）、`kit/skills/lib/ledger.mjs`（`listTaskLedgers`）、`kit/skills/lib/context-brief.mjs`（`buildContextBrief`、`formatContextBriefLines`）、`kit/skills/lib/session-orient.mjs`（既有 Working Brief 渲染）、`kit/skills/lib/handoff-package.mjs`（既有 `ROLE_BOUNDARY`）、`kit/skills/lib/critique-rounds.mjs`（`parseCritiqueRounds`）、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`（`releaseGitClaimLease`）、`scripts/lib/protocol.mjs`（`measureAgentsBytes`）。
- **本期不做**：不修改锁死的 7 键 `DEV_PROFILE_KEYS` 与 10 键 `CAPABILITY_KEYS`；不向已达 `780L` 的 `kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs` 堆加逻辑；不另造与 `context-brief.mjs` 平行的第二套快照抽象；不拆松 `edit-gate.mjs:525-564` 既有 5 层 800 行棘轮保护；不阉割 `SKILL.md`/`AGENTS.md`/`templates/agents-project.md` 既有详尽条款；不删除运行态 `mcp-delegate` 协议枚举；不引入第三方依赖；不执行发版或打标签。
- **门型与回滚路径**：`two-way`；合入后若发现回归，对合并提交执行 `git revert -m 1 <mergeCommitSha>` 并重跑 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .` 即可完整回退，仓外 `session-state.json` 保持向后兼容零损坏。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [x] C10: 完成 `kit/skills/dev-explore/scripts/repo-map-helpers.mjs` 全部 3 处重复解析收口（复用 Slice 1 的 `extractStructuredCiSteps`、`scanDeclaredTaskRunners` 与 `kit/skills/lib/import-graph.mjs`，6 处双/三轨解析全量清零）；`kit/skills/dev-explore/scripts/repo-map.mjs` 改用 `projectCodeFiles.length` 统计代码文件数，统一过滤隐藏目录与非源码/storybook 文件并按域聚类汇总 `testRefs`；`kit/skills/lib/feature-map.mjs` 仅在命令作用域覆盖目标模块时绑定 `verificationTools`。
- [x] C11: `kit/skills/lib/suite-inventory.mjs` 拆分为 `kit/skills/lib/suite-inventory.mjs` 与 `kit/skills/lib/suite-runner.mjs` (new)（均 `< 800` 行，核对 `I210`/`I211`/`I422` 100% 检出）；按仓内 `testFiles` 统计自动推导 `colocated` vs `centralized` 布局与命名；`kit/skills/dev-iterate/scripts/iterate-plan.mjs` 在 `--focus` 多模块模式下保证 `plannedTestFile` 集合 100% 唯一。
- [x] C12: 将 `scanStructuralHygiene` 及相关正则整体下沉至 `static-gates-comment-hygiene.mjs` 同文件实现 `evaluateFileHygiene` 并由 `static-gates.mjs` 单向重导出（`SCC = 0`），`review-gates.mjs` 净减行且全部 `< 800` 行；完整保留 `edit-gate.mjs:525-564` 既有 5 层 800 行棘轮保护，仅修 `isUntouchedOnMain` 误阻断并在 `profile.mjs` `OPTIONAL_DEV_PROFILE_KEYS` 增补可选 `max-file-lines`（不动 7 键 `DEV_PROFILE_KEYS`）；`govern-docs.mjs` 对齐 24 KB 受管预算判据；11 项硬阻断误杀清零（含同步 `fixtures-r5-static-gates.mjs`），且 `I187`/`I500`/`I158`/`I43`/`I418`/`I419` 及 6 类客观硬阻断零弱化 100% 检出。
- [x] C13: `flow-sandbox.mjs` 仅在 `(coreDomains.length >= 3 && touchesContract)`、`(policy.oneWayBoundaryHits?.length ?? 0) > 0` 或显式 `Case 4` 时要求 `needsSpec`（单纯 `high-risk` 原地晋升 `Case 3, riskTier=high`，同步迁移 `I985`/`fixtures-sandbox-dual-loop.mjs` 并复验 `fixtures-heterogeneous-dual-loop.mjs`），且 `promote` 识别已批准 SPEC 或 `--spec` 原地晋升不产生双 `taskId`；`doc-plan-ops.mjs` 遇已有同 slug Todo 时 `init --kind pair` 幂等补建 SPEC 并双向互链，`safeSlug` 剥离尾部重复 `-${k}` 后缀同步收口至 `docs.mjs` 与 `doc-plan-ops.mjs`。
- [x] C14: `workflow-policy.mjs`（`< 800` 行）在当前 `HEAD` 已通过 `full` 且规范化后 `full-test === merge-gate` 时视同满足 `gate`；`doc-plan.mjs` `audit` 按 `priorRounds` 动态计算下一轮次并将 `--spec` 归一为仓根路径（同步更新 `I424`），同时修复 `L516` `critique-reject` 合并去重 `[...(opts.findings ?? []), ...(opts.finding ?? [])]` 不再吞单数 `--finding`；`flow-merge-claim.mjs` 改用 `git mktree` 空树（兼容 SHA-256 仓并回退 SHA-1 空树常量）创建认领提交，在 `flow-merge.mjs` 合并后补齐 `releaseGitClaimLease` 并核验 `flow-cleanup.mjs:373,594` 回收路径。
- [x] C15: `session-state.mjs` 拆出 `session-topics.mjs` (new)（均 `< 800` 行），Per-Topic 按 `<safeSlug>-<sha8>.json` 持久化于 `<gitCommonDir>/project-forge-flow/topics/` 并全程 `withFileLockSync` 加锁；在现有 topic 结构补齐 `deadEnds[]` 字段并支持 `doc-plan.mjs note --dead-end "<排除路径与原因>"`；删全局单例 `activeTopic`/`triage` 与 5 主题静默淘汰，保留 `steps`/`explored`/`triageByTask` 于加锁 `session-state.json` 并兼容迁移；保留 `readSessionState().topics` 聚合投影与 `setTopicBriefKey` 重导出，同步迁移 `I921`（含 `alsoDropIn`）并核对 `I401`；省略 `--topic` 多活跃主题按精确匹配/列清单不误阻断，并发 `>= 6` 主题 0 丢写、0 串台。
- [x] C16: 新建 `kit/skills/lib/concurrency-radar.mjs` (new) 沉淀 `projectConcurrencyRadar` 及全部漂移交集/雷达格式化辅助（绝不堆进 `780L` `flow-lifecycle-helpers.mjs`），接入 7 处入口并覆盖 5 类退化边界；精准划分 `harness-context.mjs` 与 `flow-start-helpers.mjs` `BLOCKED_DIRTY_MAIN`（新开隔离 worktree 降级预警，原地改/合主干硬阻断，同步迁移 `I399`/`fixtures-w4-harness.mjs`/`fixtures-sandbox-dual-loop.mjs`）；直接扩展既有单源链路（零平行快照抽象）：`session-orient.mjs` 既有冷启动报告渲染 `deadEnds[]` 与 `concurrencyRadar` 补齐六要素；`handoff-package.mjs`（`< 800` 行）扩展 `ROLE_BOUNDARY` 增补各角色必读 `skillPath` 与 1 行 Day-1 前提质疑/Deletion Test 指令，并在交接包透出活跃 topic `decisions[]`/`deadEnds[]` 与 `concurrencyRadar`（单块 `<= 3072 B`）；`edit-gate --pre-edit`、`doc-plan triage/init`、`review-pack.mjs` 统一复用同一 `contextBrief` + `concurrencyRadar` 投影。
- [x] C17: 在 `platform-registry.mjs`（与 `mrRefPattern` 同级，不动 10 键 `CAPABILITY_KEYS`）新增 `prRefPrefix`（`gitlab` 为 `'!'`，其余 `'#'`）并经 `task-backend.mjs` 透传；`doc-comments.mjs` 零平台名硬编码、全链路 0 处 `PR #null`、有 `prUrl` 时正文单次裸输出供原生富展开且标题不重复 `#N`；`flow-lifecycle.mjs` 返工/HEAD 更新正确透传 `prUrl` 与 `prRefPrefix`（核对 `I413`/`I414`）。
- [x] C18: `pr-template-hydrate.mjs` 清零 `project-forge` 专有措辞（删除 `SURVEY_OR_GATE_FILE_RE` 等本仓私货），仅基于通用可证事实勾选并扩展 `DOC_SYNC_FILE_RE`；`session-orient.mjs` 与 `govern-state.mjs` 在 `local-only` 模式下零泄露远端 PR 或特定平台 CLI 指引；`scripts/compose-agents.mjs` 删除重复 `checkAgentsBytes` 复用 `scripts/lib/protocol.mjs` `measureAgentsBytes` 并同步迁移 `I24`。
- [x] C19: 在 `SKILL.md`、`references/`、`templates/agents-project.md` 与 `kit/skills/*/SKILL.md` 中不删短既有条款、严守 `SKILL_MAX_BYTES`/`KIT_SKILL_WARN_BYTES`/`AGENTS_MANAGED_MAX_BYTES` 预算，精炼嵌入高维业务锚定、前提质疑/Deletion Test、工具无关 Deep Research（清零 `webfetch`/`websearch` 等特定宿主工具名，保留运行态 `mcp-delegate`）与 `hostCapability: serial-fallback` 串行降级，并通过 `equip.mjs . --check` 与 `compose-agents.mjs . --check`。
- [x] C20: 同步更新本仓 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md` 与对应 `assets/readme/*.svg`；`finalize` 前依据已合入归档的 Slice 1（PR #249）勾选总控 PRD `C1..C9`，连同 Slice 2 `C10..C20` 全勾 `[x]` 后经 `evaluateMasterPrdClosureState` 校验完成总控 PRD 与 Slice 2 SPEC/Todo 1:N 成对归档，且 `preflight`、`gap-coverage`、`fixtures`、`bench`、`e2e-zip-harness`、`verify-injections --jobs 4`、`review .`、`sync-toc --check`、`govern-audit audit .` 与 `merge-gate.mjs` 全部退出码 `0`。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 补齐 Slice 2 核心失败回归夹具（`scripts/dev/fixtures-s2-harness-multisession.mjs` (new) 覆盖 `C10..C19` 正反双向断言） | 运行 `node scripts/dev/fixtures.mjs` 确认新夹具按预期报红（Red） | SPEC 经独立 Critique 并 `approve` |
| 2 | 落地 `C10`、`C11`：`repo-map-helpers.mjs` 3 处去重、`repo-map.mjs` 域聚类、`feature-map.mjs` 作用域匹配；拆分 `suite-inventory.mjs` -> `suite-runner.mjs` (new) 与 `iterate-plan.mjs` 唯一路径 | `node scripts/dev/preflight.mjs` 与 `fixtures-explore`/`fixtures-iterate-evolution` 通过，且 `suite-inventory.mjs`/`suite-runner.mjs` `< 800L` | 步骤 1 |
| 3 | 落地 `C12`：`profile.mjs` 增 `max-file-lines`；将 `scanStructuralHygiene` 及相关正则下沉至 `static-gates-comment-hygiene.mjs` 实现 `evaluateFileHygiene` 并由 `static-gates.mjs` 单向重导出（`SCC=0`）；修 `edit-gate.mjs` `isUntouchedOnMain`（保留 5 层棘轮）；净减行改造 `review-gates.mjs`；改造 `govern-*` 清扫 11 项误杀并对齐 24 KB 受管预算 | 同步 `I187`（含 `alsoDropIn`）与 `fixtures-r5-static-gates.mjs`，验证 `I187`/`I500`/`I158`/`I43`/`I418`/`I419` 与 `preflight.mjs` 全绿 | 步骤 2 |
| 4 | 落地 `C13`、`C14`：`flow-sandbox.mjs` 按 `(policy.oneWayBoundaryHits?.length ?? 0) > 0` 解耦 `high-risk` 与支持已批 SPEC 原地晋升；`doc-plan-ops.mjs`/`docs.mjs` 幂等补建 SPEC 与 `safeSlug` 去重；`workflow-policy.mjs` 同命令等价；`doc-plan.mjs` 动态轮次与 L516 `--finding` 修复；`flow-merge-claim.mjs` `git mktree` 空树认领、`flow-merge.mjs` 补齐 `releaseGitClaimLease` 并核验 `flow-cleanup.mjs` | 同步 `I985`/`I424`、`fixtures-sandbox-dual-loop.mjs` 并复验 `fixtures-heterogeneous-dual-loop.mjs` 全绿 | 步骤 3 |
| 5 | 落地 `C15`、`C16`：拆分 `session-state.mjs` -> `session-topics.mjs` (new) 并增补 `deadEnds[]` / `doc-plan note --dead-end`；新建 `concurrency-radar.mjs` (new)；精准划分 `BLOCKED_DIRTY_MAIN`；直接扩展 `session-orient.mjs` 渲染 `deadEnds[]` + `concurrencyRadar`、扩展 `handoff-package.mjs` `ROLE_BOUNDARY`（`skillPath` + Day-1 指令）与透出活跃 topic/雷达，并在 `edit-gate --pre-edit`/`doc-plan triage/init`/`review-pack.mjs` 复用同一 `contextBrief` + `concurrencyRadar` 投影 | 同步 `I921`（含 `alsoDropIn`）/`I399`/`fixtures-w4-harness.mjs`/`fixtures-sandbox-dual-loop.mjs`/`fixtures-conv-s2.mjs`；并发 `>= 6` 主题与 5 类雷达退化边界全绿；全触及文件 `< 800L` | 步骤 4 |
| 6 | 落地 `C17`、`C18`：`platform-registry.mjs`/`task-backend.mjs` 透传 `prRefPrefix`；`doc-comments.mjs`/`flow-lifecycle.mjs` 零 `PR #null` 与单次裸 `prUrl` 富展开；清零 `pr-template-hydrate.mjs` 私货与 `local-only` 泄露；`compose-agents.mjs` 复用 `protocol.mjs` `measureAgentsBytes` | 同步 `I24`/`I413`/`I414`；5 方言 + `generic-git` + `local-only` 夹具全绿 | 步骤 5 |
| 7 | 落地 `C19`、`C20`：更新 `SKILL.md`/`templates/agents-project.md`/`references/`/`kit/skills/*/SKILL.md`；跑 `equip.mjs .` 与 `compose-agents.mjs .`；同步 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`、`README.md`、`README.en.md` 与 `assets/readme/*.svg`；`finalize` 前依已归档 Slice 1（PR #249）勾齐总控 PRD `C1..C9` 及 Slice 2 `C10..C20` 后成对归档 | `node scripts/dev/merge-gate.mjs` 12/12 全绿 + `verify-injections.mjs --jobs 4` 100% 检出 + `sync-toc.mjs --check` 通过 | 步骤 6 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 贴线模块新增代码冲破 800 行红线或引入循环依赖 | 修改 `static-gates.mjs`/`static-gates-comment-hygiene.mjs`、`flow-lifecycle-helpers.mjs`（780L）、`docs.mjs`（788L）、`workflow-policy.mjs`（778L）、`flow-lifecycle.mjs`（777L）、`review-gates.mjs`（775L）、`flow-inspect.mjs`（761L）、`handoff-package.mjs`（761L） | `scanStructuralHygiene` 与正则整体单向下沉 `static-gates-comment-hygiene.mjs`（`SCC=0`）；雷达与格式化辅助全入 `concurrency-radar.mjs` (new)；`handoff-package.mjs` 仅做轻量扩展（`< 20L`）；`refs/pf/claims/*` 清理落于 `flow-merge.mjs`/`flow-cleanup.mjs`；每步跑 `preflight.mjs` 严检行数与 SCC |
| 去误杀时意外松动 6 类硬阻断或破坏既有故障注入/夹具断言 | 调整 `edit-gate.mjs`、`static-gates*.mjs`、`harness-context.mjs`、`flow-sandbox.mjs`、`doc-plan.mjs`、`compose-agents.mjs` | 逐条按 SPEC 注入与夹具迁移表核对 `I24`/`I43`/`I158`/`I187`/`I210`/`I211`/`I399`/`I401`/`I413`/`I414`/`I418`/`I419`/`I422`/`I424`/`I500`/`I921`/`I985` 及 `fixtures-r5-static-gates.mjs`/`fixtures-sandbox-dual-loop.mjs`/`fixtures-heterogeneous-dual-loop.mjs`，合前全跑 `verify-injections.mjs --jobs 4` 100% 检出 |
| 1:N `finalize` 触发 `BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED` | 总控 PRD `C1..C9` 仍为未勾 `[ ]` | `finalize` 前依已合入归档的 Slice 1（PR #249）勾选总控 PRD `C1..C9`，连同 Slice 2 `C10..C20` 全勾 `[x]` 后再执行归档 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（已闭环 Round 1 Plan Critique 全部 4 项 Major 缺陷并完成单源减法收口，待 `audit` 与 Round 2 独立复核）
- **待拍板事项**：无
- **下一步第一件事**：对 SPEC 与 Todo 重跑 `doc-plan.mjs audit --json` 确认 `errors: []`、`warnings: []`，随后移交新独立只读 Critic 进入 Round 2 Plan Critique。

## 澄清与补充记录

- 已确认（2026-11-28）：已完整吸收总控 PRD Round 3 Critic 4 项实施提醒、Slice 1 Reviewer `compose-agents.mjs` `measureAgentsBytes` 单源收口提醒、5 层 800 行棘轮保护校准、Round 1 Plan Critique 全部 4 项 Major 缺陷修订（含 `doc-plan.mjs:516` `--finding` 合并去重），以及单源减法收口（删除平行快照引擎，改为扩展 `session-topics.mjs` `deadEnds[]` + `session-orient.mjs` 六要素 + `handoff-package.mjs` `ROLE_BOUNDARY` `skillPath`/Day-1 指令 + 复用既有 `contextBrief`/`concurrencyRadar`）。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联总控 `PRD` 与 `SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：已实跑 `node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/dev/preflight.mjs`（42/42 通过，0 失败，SCC=0，全仓 .mjs <= 800 行，edit-gate.mjs 745 <= 755 行）、`node .agents/skills/dev-edit/scripts/edit-gate.mjs --final`（PASS，0 阻塞）、`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit .`（22 features / 22 tools / 0 僵尸 / 0 盲区）、`node scripts/sync-toc.mjs README.md README.en.md --check`（双语 7 项同步）、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .`（0 critical / 0 high），并在 `commit` 后实跑完整 `node scripts/dev/merge-gate.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4` 与 `node .agents/skills/dev-iterate/scripts/iterate.mjs run --concurrency 4 --no-signals --json`。
- **文档同步检查**：已同步更新 `docs/TDD.md`、`docs/feature-map.json`、`docs/architecture-map.html`（159,970 B < 180 KB，0 脏节点）、`README.md`、`README.en.md`、`AGENTS.md`（23,480 B <= 30 KB，受管区 <= 24 KB）、`SKILL.md`（14,910 B <= 16 KB）与 `kit/skills/*/SKILL.md`（最大 12,794 B <= 14 KB），核验 `assets/readme/*.svg` 无漂移，并依 Slice 1（PR #249）勾齐总控 PRD `C1..C20` 后成对归档。
- **遗留问题**：无；待独立上下文审查者完成双门审查、两阶段故障注入复核与合入。
