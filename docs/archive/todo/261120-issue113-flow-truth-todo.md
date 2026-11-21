---
kind: todo
title: 流程真相收口实施清单：批准闭合、生成物单生产者、门禁单源派生、退出码单点分层
status: done
created: 2026-11-20
updated: 2026-11-21
issue: 113
pr: null
branch: feat/flow-truth
owner: FiretrUCK666
plan_mode: interactive
approved: false
done_at: 2026-11-21
task_id: flow-truth
planned_at: null
related_prd: null
related_spec: ../specs/261120-issue113-flow-truth-spec.md
depends_on: [w2a-plan-wave-gate]
scope_files: [.github/workflows/check.yml, kit/skills/dev-plan/scripts/doc-audit.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-plan/scripts/doc-plan-ops.mjs, kit/skills/dev-plan/SKILL.md, kit/skills/lib/doc-requirements.mjs, kit/skills/lib/critique-rounds.mjs, kit/skills/lib/docs.mjs, kit/skills/lib/intake-triage.mjs, kit/skills/lib/plan-exit-gate.mjs, kit/skills/dev-flow/scripts/flow.mjs, kit/skills/dev-flow/scripts/flow-lifecycle.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs, kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs, kit/skills/dev-flow/scripts/flow-merge.mjs, kit/skills/dev-flow/scripts/flow-batch.mjs, kit/skills/dev-flow/scripts/flow-intake.mjs, kit/skills/dev-flow/scripts/flow-next.mjs, kit/skills/dev-flow/scripts/flow-inspect.mjs, kit/skills/dev-flow/scripts/flow-cleanup.mjs, kit/skills/dev-flow/SKILL.md, kit/skills/dev-review/scripts/review-ledger.mjs, kit/skills/dev-review/scripts/review-locks.mjs, kit/skills/dev-review/scripts/review-pack.mjs, kit/skills/dev-review/scripts/review-diff.mjs, kit/skills/dev-review/scripts/review-empirical-state.mjs, kit/skills/dev-review/SKILL.md, kit/skills/dev-edit/scripts/edit-gate.mjs, kit/skills/dev-govern/scripts/govern-audit.mjs, kit/skills/dev-govern/scripts/govern-state.mjs, kit/skills/dev-verify-tools/scripts/verify-tools.mjs, kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs, kit/skills/lib/cli.mjs, kit/skills/lib/exit-codes.mjs, kit/skills/lib/gate-truth.mjs, kit/skills/lib/evidence-substance.mjs, kit/skills/lib/workflow-policy.mjs, kit/skills/lib/workflow-helpers.mjs, kit/skills/lib/pr-template-hydrate.mjs, kit/skills/lib/empirical-artifacts.mjs, kit/skills/lib/verify-state.mjs, kit/skills/lib/task-backend.mjs, kit/skills/lib/task-graph.mjs, kit/skills/lib/doc-comments.mjs, kit/skills/lib/review-comment-render.mjs, kit/skills/lib/profile.mjs, kit/skills/lib/profile-sniffer.mjs, kit/skills/lib/ledger.mjs, ".agents/skills/dev-flow/**", ".agents/skills/dev-review/**", ".agents/skills/dev-edit/**", ".agents/skills/dev-plan/**", ".agents/skills/dev-govern/**", ".agents/skills/dev-verify-tools/**", .agents/skills/lib/cli.mjs, .agents/skills/lib/exit-codes.mjs, .agents/skills/lib/gate-truth.mjs, .agents/skills/lib/evidence-substance.mjs, .agents/skills/lib/doc-requirements.mjs, .agents/skills/lib/critique-rounds.mjs, .agents/skills/lib/docs.mjs, .agents/skills/lib/intake-triage.mjs, .agents/skills/lib/plan-exit-gate.mjs, .agents/skills/lib/workflow-policy.mjs, .agents/skills/lib/workflow-helpers.mjs, .agents/skills/lib/pr-template-hydrate.mjs, .agents/skills/lib/empirical-artifacts.mjs, .agents/skills/lib/verify-state.mjs, .agents/skills/lib/task-backend.mjs, .agents/skills/lib/task-graph.mjs, .agents/skills/lib/doc-comments.mjs, .agents/skills/lib/review-comment-render.mjs, .agents/skills/lib/profile.mjs, .agents/skills/lib/profile-sniffer.mjs, .agents/skills/lib/ledger.mjs, .agents/skills/.pf-manifest.json, AGENTS.md, templates/agents-project.md, docs/TDD.md, references/collaboration.md, scripts/dev/merge-gate.mjs, scripts/dev/preflight-contracts.mjs, scripts/dev/preflight-suite.mjs, scripts/dev/fixtures-flow-truth.mjs, scripts/dev/injections-data-flow-truth.mjs, scripts/dev/injections-data-workflow.mjs, scripts/dev/injections-data-core.mjs, scripts/dev/fixtures-local-backend.mjs, scripts/dev/fixtures-onboarding.mjs, scripts/dev/fixtures-platform.mjs, scripts/dev/fixtures-flow-state.mjs, scripts/dev/fixtures-flow-cleanup.mjs, scripts/dev/fixtures-attribution-routing.mjs, scripts/dev/fixtures-escalation-stoploss.mjs, scripts/dev/fixtures-review-token.mjs, scripts/dev/fixtures-review-empirical.mjs, scripts/dev/fixtures-e2e-gate.mjs, scripts/dev/blind-run-harness.mjs, scripts/dev/e2e-scenarios-lifecycle.mjs, scripts/dev/e2e-zip-harness.mjs, scripts/handoff.mjs, docs/archive/specs/261120-issue113-flow-truth-spec.md, docs/archive/todo/261120-issue113-flow-truth-todo.md]
---

# `flow-truth` 实施 Todo（Issue `#113`）

> 对应 SPEC：[flow-truth SPEC](../specs/261120-issue113-flow-truth-spec.md)
>
> **基线**：`a0fe4df`。前置切片已合入、关闭并归档，依赖无副作用。

## 一、要做什么

<!-- section: goal -->
在现有 8 个技能与既有脚本内把三类流程失真的根因收口，不新增技能、不加第三方依赖。

- **批准闭合**：依据的判法只有一处实现（扩 `plan-exit-gate.mjs` 的既有导出），`doc-audit.mjs` 的 `auditDoc` 与退场门禁都调它；回退清标记；负责人变更留痕且三处自审锁按历史集合生效；驳回返回非零；中间态复用既有 `in_review`。
- **删自由度**：提审与返工分支拒收提案正文；参数注册按子命令收窄；注册表、帮助、读取点三重对拍（只认定义位置、支持间接读取形态）。
- **改推导**：返工轮次、远端合并结果、观察证据一律从账本与既有 git 判定读出；**证据字段的派生兜底全部删除**，不靠换措辞。
- **合并真相源**：门禁值改为一条编排命令的引用，流水线由三条结构谓词圈定、派生按「一条执行块算一步」并整块经 shell 执行；退出码档位、远端检查判定、层级映射各自单点化。
- **签字通道收紧**：放行类开关理由必填且必须实质（复用抽出的同一判据），三处兜底串与「跳过规划内审」一并纳入。

同步刷新镜像、`AGENTS.md` 门禁取值与 `templates/agents-project.md`，补齐正反双向夹具与故障注入。
<!-- section: goal-end -->

## 二、不做什么

<!-- section: non-goals -->
不新增第 9 个技能与第三方依赖；不删除人类签字通道；不改建单、评论、里程碑的正文参数；不改发版链路本身；**不碰 `docs/archive/`**（所有全仓检索一律排除它）；不写死任何托管平台名、账号、路径与版本号；不改装配脚本的「受管区间 vs 手写区」边界。

不以任何形式打补丁：不加「再多一个判断挡住它」的分支，不加关掉问题的开关，不靠重试掩盖永不成立的判定，不留「跑不了就放过」「按文件名整段跳过」的软通道，**不为通过检查添加任何豁免条目**。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [x] **T1（`C1` 批准闭合，最高优先级）**：在 `kit/skills/lib/plan-exit-gate.mjs` 扩出「依据是否成立」的单点导出（适用性按文档类型，`todo` 档不适用且理由写进代码）；`doc-audit.mjs:299` 的 `auditDoc` 与退场门禁都改成调它，**谁也不许自己再判一遍**；`doc-plan.mjs` 的 `link --status` 只允许非批准档位，`docs.mjs:514-519` 写非批准档位时同批把批准标记置假；`docs.mjs:513` 的负责人变更改为需理由、入账并保留历史集合，`review-ledger.mjs:123-137`、`critique-rounds.mjs:327-355`、`doc-requirements.mjs:626-643` 三处自审锁按历史集合比对；`intake-triage.mjs:152` 的豁免读取改为「标记为真且依据自洽」；`critique-rounds.mjs:537` 驳回改为返回非零；中间态复用既有 `in_review`，不动 `doc-audit.mjs:39-43` 的枚举。
- [x] **T2（`C9` 退出码单点化）**：新增 `kit/skills/lib/exit-codes.mjs` (new) 定义四档语义、20 条码到档位映射表与交棒四态并列声明；12 个前提事实不成立的改判中间档，8 个用法类保持；6 处常量定义收敛为一处，裸字面量改为引用常量；`preflight-suite.mjs` 增加「新增阻断码未登记档位即失败」；**同步 19 处断言：A 类 15 处**（`fixtures-review-token.mjs:100/107/114/122/157`、`fixtures-attribution-routing.mjs:471`、`fixtures-escalation-stoploss.mjs:230/263/344/353/360`、`fixtures-flow-state.mjs:469/509`、`fixtures-e2e-gate.mjs:179`、`blind-run-harness.mjs:347`）**+ B 类 4 处**（`e2e-scenarios-lifecycle.mjs:481/484`、`fixtures-escalation-stoploss.mjs:349/366`）；同步 `kit/skills/dev-plan/SKILL.md:55`。
- [x] **T3（`C2` 生成物单生产者）**：参数注册改为按子命令声明，提审与返工分支不接正文参数；删掉正文短路；账本记标题来源；兜底分节标题从真实模板同一份常量派生；删除 `workflow-policy.mjs:707` 拼接旧参数的分支与 `flow-lifecycle-helpers.mjs:115`、`review-comment-render.mjs:101`、`workflow-policy.mjs:677` 三处旧参数指引。
- [x] **T4（`C3` 轮次与合并事实推导）**：删除返工开关与三处短路，返工改由「末轮退回 + 令牌已消费」推导，同分支防重改为无条件执行；删除声明式合并开关，改用 `kit/skills/lib/git.mjs:303` 的 `inspectBranchMergeState`，判定前先取回远端；`task-backend.mjs` 删掉凭布尔量返回合并成功的分支；同步 `templates/agents-project.md:173`/`:196`、`docs/TDD.md:282`、`references/collaboration.md:13`、`kit/skills/dev-flow/SKILL.md:49`/`:79`；迁移引用旧参数的夹具与端到端脚本。
- [x] **T5（`C4` 删派生兜底）**：新增 `kit/skills/lib/evidence-substance.mjs` (new) 抽出两个既有判据的共用部分；**删除 `flow-lifecycle.mjs:480-481` 与 `review-ledger.mjs:455-459` 两处派生写点**，证据字段只接受入参或既有真实记录；裸布尔开关不再产出能被判据接受的文本；提审、审查回执、放行理由三处都调同一判据。**不扩充黑名单**。
- [x] **T6（`C5` 放行签名契约）**：全部放行点统一为理由必填且必须实质（调 `evidence-substance.mjs`）；删除三处兜底串（`flow-merge.mjs:150`、`flow-lifecycle-hooks.mjs:215`/`:301`）；`doc-plan-ops.mjs:64` 的「跳过规划内审」纳入同一标准；被绕过项逐条入账；`doc-comments.mjs` 的评论带理由与绕过项，删掉「门禁检查通过」结论行；删除合并分支的强制参数；统一「跳过治理巡检」两侧要求。
- [x] **T7（`C6` 门禁单源派生）**：新增 `kit/skills/lib/gate-truth.mjs` (new) 承接结构谓词圈定、派生与三态判定——谓词为「触发形态为提案或推默认分支」「无写作用域」「步骤不需远端上下文」，三者同时成立才采纳；派生按「一条执行块算一步」重写，解析失败与空结果一律阻断；新增 `scripts/dev/merge-gate.mjs` (new) **经 shell 整块执行**并输出三态，未核验不得折成通过；`AGENTS.md` 的 `merge-gate` 改为一条引用命令；豁免标记写进 `.github/workflows/check.yml`；`profile.mjs` 导出唯一的层级映射；`flow-merge.mjs` 与 `flow-batch.mjs` 改为薄调用；`preflight-contracts.mjs` 只保留两条结构检查。
- [x] **T8（`C7` 三重对拍）**：`preflight-suite.mjs` 实现三条判据，帮助函数体按花括号配对截出，声明位置只认「行首声明」与「用法行方括号分组」；读取点识别支持 `opts[CONST]` 间接形态并做连字符到驼峰归一；全局白名单按注册来源判定且只在 `cli.mjs:46-47` 一处声明；`scripts/handoff.mjs` 补最小声明表纳入同一检查（不开豁免）；五个入口暗参数清零（17/10/10/8/0）、反向差集清零、死参数清零。
- [x] **T9（`C8` 分诊只读真相）**：`flow-intake.mjs` 分诊判定只读平台事实；平台读取失败时补充输入保留但留源，结论旁附标注。
- [x] **T10（同步与双证）**：`node scripts/equip.mjs .` 刷新镜像与派生清单；新增 `scripts/dev/fixtures-flow-truth.mjs` (new) 承接 `C6` 定点用例与 `C1..C9` 正反断言；新增 `scripts/dev/injections-data-flow-truth.mjs` (new)；同步三份技能文档与协作判据。
- [x] **T11（行数与拆分核对）**：逐文件核对 `.mjs <= 800` 行；`workflow-policy.mjs`（现 798 行）**只许减不许增**；`flow-lifecycle.mjs`（现 755 行）不得高于当前行数；`doc-audit.mjs` 的新判据以调用单点函数的形式加入，不内联逻辑。

## 四、验收与合前检查

- [x] `node scripts/dev/fixtures.mjs --domain flow-truth` 全绿，`C1..C9` 每条正例与反例各有断言。
- [x] `node scripts/dev/merge-gate.mjs` 本地跑通，三态分明，未核验项逐条列出而非算作通过。
- [x] `node scripts/dev/verify-injections.mjs` 全数命中。
- [x] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [x] **排除 `docs/archive/` 后**全仓搜不到已删除的参数名。
- [x] `AGENTS.md` 门禁值与流水线执行步骤的一致性由派生执行保证；豁免都有标记且都指向需环境上下文的步骤；**本次未新增任何豁免条目**。
- [x] 两份正在生效的 Todo 不因 `C1` 新判据变红（`audit .` 仍 `ok: true`）。
- [x] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [x] `doc-plan.mjs audit . --json` 返回 `ok: true`。
