---
kind: todo
title: 修复外部项目装备断点、仓根命令嗅探与两档五态交叉兼容性
status: done
created: 2026-11-18
updated: 2026-11-18
issue: 58
pr: null
branch: feat/onboarding-matrix
owner: FiretrUCK666
approved: true
done_at: 2026-11-18
task_id: issue-58
planned_at: 9e966352f10318a0893c9cb722fe7c0a9f59ab0f
related_prd: ../../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261118-issue58-onboarding-matrix-spec.md
---

# TODO: 修复外部项目装备断点、仓根命令嗅探与两档五态交叉兼容性

> 任务编号：`issue-58` | 关联 Issue：#58 | 对应 SPEC：[261118-issue58-onboarding-matrix-spec.md](../specs/261118-issue58-onboarding-matrix-spec.md)

## 文档信息

| 字段 | 值 |
| --- | --- |
| 分支 / 任务 | `feat/onboarding-matrix` / `issue-58` |
| 规划基线 `planned_at` | `9e966352f10318a0893c9cb722fe7c0a9f59ab0f` |
| 责任人 | `planner-58` |
| 状态 | `active` |

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/profile-sniffer.mjs`、`scripts/lib/agents-defaults.mjs`(new)、`scripts/compose-agents.mjs`、`scripts/lib/protocol.mjs`、`templates/agents-project.md`、`scripts/lib/agents-sections.mjs`、`scripts/lib/claims.mjs`、`scripts/equip.mjs`、`scripts/handoff.mjs`、`kit/skills/lib/cli.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/task-graph.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/dev-flow/scripts/flow-merge.mjs`、`.agents/skills/`、`AGENTS.md`、`scripts/dev/fixtures-onboarding.mjs`(new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`scripts/survey.mjs` 的 `commands` / `ecosystem` / `docs` 事实、`scripts/lib/equip-bootstrap.mjs` 的 `hydrateInitialAgentsDefaults`、`kit/skills/lib/cli.mjs` 的 `resolveAvailableSkills`、`kit/skills/lib/profile.mjs` 的 `parseAgentsProfile` / `isProfileExplicitNone`、`kit/skills/lib/workflow-policy.mjs` 的 `determineWorkflowPolicy` / `evaluateNextState`、`scripts/backup.mjs` 的快照恢复能力
- **本期不做**：不重写 `dev-govern` 存量文件统一拆分（仅将本次修改的 `scripts/compose-agents.mjs` 控至 800 行以内并维持 `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` 与 `flow-inspect.mjs` 不超过 800 行）；不触碰 `docs/specs/261117-issue50-platform-and-docs-spec.md` 与 `docs/specs/261117-issue52-review-independence-spec.md` C4 的既定领域
- **门型与回滚路径**：`one-way`（涉及 `templates/agents-project.md`、`scripts/lib/`、`kit/skills/lib/workflow-policy.mjs` 与 `flow-merge.mjs` 高风险路径），须独立审查加故障注入；回滚时对本分支单提交执行反向提交（或删除新建文件并重跑 `equip.mjs .` 与 `compose-agents.mjs .`）
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [x] C1: 修复 `kit/skills/lib/profile-sniffer.mjs` 的 `wrapDir` 在仓根目录省略包管理器前缀的缺陷；正向验证根仓与子包在 `npm`/`pnpm`/`yarn`/`bun` 下生成的 `quickTest`/`fullTest`/`lint`/`build` 均携带对应包管理器（根仓输出 `"npm test"`、`"pnpm check"` 等而非裸 `"test"`），且 Python（`pyproject.toml`）、Rust（`Cargo.toml`）、Go（`go.mod`）、Java（`pom.xml`）及零清单纯文档仓均可正常完成 `sniffLayeredCommands` 而不报错；反向验证 `package.json` 仅含默认无效 `no test specified` 时不得生成 `quickTest`，子目录包命令保留 `--prefix`/`--dir`/`--cwd` 目录参数且不含子 shell 切换。
- [x] C2: 拆分 `scripts/lib/agents-defaults.mjs`(new) 并使 `scripts/compose-agents.mjs` 行数降至 800 行以下；在 `scripts/lib/protocol.mjs` 与 `templates/agents-project.md` 接入 7 键 `Dev Profile` 自动预填（从 `survey` 命令集合注入真实 `quick-test`/`full-test`/`merge-gate`，无构建清单的纯文档仓命令与 `arch-rules` 默认输出 `none`，未检出项保留尖括号提示），并在 `scripts/lib/agents-sections.mjs` 对已校准且无占位符的 `Dev Profile` 免报漂移且刷新时保护；验证有命令 Node 仓自动预填真实命令、`bootstrap-empty` 与本仓运行 `compose-agents --check` 及 `review.mjs` 均退出 `0`，且 `templates/agents-project.md` 仍通过 `preflight-suite` 的 7 键一致性与 `resolveEffectiveTier` 默认 `full` 断言。
- [x] C3: 修复 `scripts/lib/claims.mjs` 将 `docs/archive` 纳入 `OPTIONAL_INFRA_DIRS` 并跳过含尖括号占位的未填模板示例表格行（如包含未替换占位单元格的 `docs/TDD.md` 示例行），同时继续保留 `（若存在）` 可选路径说明；反向验证当 `AGENTS.md` 正文真实引用不存在的仓内脚本文件路径且未带可选限定时，`verifyClaims` 仍判定 `claim.path` 为失败（`ok: false`）并使 `review.mjs` 返回退出码 `1`。
- [x] C4: 重构 `templates/agents-project.md` 模板条件块隔离：用 `is-full` 包裹 `意图路由` 中的 `dev-review` / `dev-govern` 行，清理 `is-lightweight` 文段对 `dev-review` / `dev-govern` / `review-pack.mjs` / `govern-audit.mjs` 及强制 `独立审查` / `故障注入` 的表述，并将 `## 高风险路径` 标题区（`templates/agents-project.md` L334）拆为 `is-full`（保留原「触碰须独立审查 + 故障注入」）与 `is-lightweight`（「触碰须人类确认」，保留 `^##\s+高风险路径` 前缀）；正向验证对外部仓运行 `compose-agents --tier lightweight` 产出的 `AGENTS.md` 小于 14KB 且零包含上述未安装技能或强制审查/故障注入条文；反向验证 `--tier full` 与未装配默认 `full` 渲染保留完整 `独立审查` 与 `审查者直接合` 规则，且原始模板继续通过 `preflight-contracts` 与 `preflight-suite` 校验。
- [x] C5: 打通 `lightweight` 下 `local-only` 与 `maintainer` 运行时无死锁闭环（扩展 `kit/skills/lib/cli.mjs` `hasSkillSupport`、`workflow-policy.mjs`、`task-graph.mjs`、`flow.mjs`、`flow-next.mjs` 与 `flow-merge.mjs`，并将 `flow-lifecycle.mjs` 收拢至 `buildSubmitNextSteps` 以严守 `<= 800` 行）：`lightweight`（`hasSkillsDir && !dev-review`）下普通 `Case 2`/`Case 3` 走通 `flow start` -> 提交 -> `finalize` -> `verify --mode full` -> `submit`（`nextStep` 不再触发 `cli.mjs:206` 的 `dev-review` 兜底文案）-> `flow next`（`phase=ready-to-merge`）-> `flow merge`（`local-only` 含 `--detach` 试合推进主干）退出码 `0`；触及全部 6 类高风险触发源之一（`highRiskHits`、`gateWeakeningHits`、`caseType >= 4`、视觉文件、`oneWayBoundaryHits`、`do-not-edit`）时 `merge` 返回退出码 `4` 并强制 `--human-approved --reason "..."` 后放行；反向验证未装配仓（`!hasSkillsDir` 如 `fixtures-flow`）与 `full` 档维持原有门禁与 `gateFindings` 审批兼容（不要求破坏既有夹具的 `--reason`），未通过 `dev-review` 独立审查 PASS 时 `merge` 仍阻断为 `BLOCKED_REQUIRES_INDEPENDENT_REVIEW`。
- [x] C6: 在 `scripts/dev/fixtures-onboarding.mjs`(new) 实现并注册 `2` 档位（`lightweight`、`full`）× `5` 角色（`local-only`、`maintainer`、`contributor-fork`、`generic-git`、`inbound-external-pr`）共 10 种组合的自动化可重复矩阵测试（远端与平台 API 使用可控桩对象）：验证 `contributor-fork` 在 `lightweight` 与 `full` 均于 `submit` 后直接到达 `awaiting-upstream-merge` 且保持 Fork 远端锁定；`generic-git` 在 `lightweight` 于 `submit` 后到达 `awaiting-remote-mr` 并经 `flow merge --remote-merged` 收尾（高风险仍须 `--human-approved`）；`lightweight` 下 `inbound-external-pr` 在 `flow start --external-pr` / `flow next` / `flow verify` 给出明确缺 `dev-review` 提示并阻断为 `BLOCKED_REQUIRES_DEV_REVIEW`（不输出 `review-pack.mjs`）；`full` 档 5 角色全链维持既有审查隔离机制。
- [x] C7: 强化 `scripts/equip.mjs --check` 深度一致性校验（与 `#52` C4 的 `compose-agents` 检查互补）：任一当前档位必需核心技能出现在 `disabledSkills` 或其 `SKILL.md` 被 `removedFiles` 删缺、已安装脚本出现指向缺失 `lib/*.mjs` 的相对导入断链、或 `SKILL.md` 缺少合法 YAML frontmatter `name`/`description` 时，`checkEquip` 必须返回 `ok: false` 且命令行退出码为 `1`；反向验证完好装配的两档仓库与合法登记 `--adopt-custom` 定制修改的仓库仍退出 `0`。
- [x] C8: 修复 `scripts/handoff.mjs` 的 `stripInlineCode` 仅剥除多反引号嵌套元示例（保留 `scripts/dev/fixtures-contracts.mjs` 的双反引号举例免误报契约），并在目标项目非代码块围栏正文里对单反引号包裹的 `references/*.md` 或本 skill 脚本路径执行 `SKILL_INTERNAL_RE` 扫描与 `danglingPointers` 检出；正向验证目标仓 `AGENTS.md` 若遗留单反引号包裹的 `references/collaboration.md` 或 `scripts/survey.mjs`（且目标仓自身没有对应本地文件），`handoff --scan --json` 报告 `clean: false` 并列出悬空指针；反向验证双反引号嵌套元示例、目标仓真实自建的本地对应路径、围栏代码块内或洁净交棒后 `handoff --verify` 必须返回退出码 `0`。
- [x] C9: 在 `scripts/dev/fixtures-onboarding.mjs`(new) 构建 5 类典型项目形态（`frontend`、`backend`、`pure-lib`、`pure-docs`、`ci-enabled`）临时仓完成端到端接管验证：依次通过 `survey` -> `equip` -> `compose-agents` -> `compose-agents --check` -> 补齐占位与取舍后 `review.mjs` -> `backup` 创建与改写后 `--restore` 还原校验 -> `compose-agents --clean` 与 `handoff` 剥离并 `--scan` 返回 `clean: true` -> 交棒后项目自身测试/命令及独立 `dev-flow` 脚本执行正常；合并前运行 `equip.mjs . --check`、`compose-agents.mjs . --check`、`preflight.mjs` 与 `fixtures.mjs` 全绿。

## 执行步骤

- [x] 1. 在 `kit/skills/lib/profile-sniffer.mjs` 修复 `wrapDir` 并补充根/子包、多生态及零清单纯文档仓命令嗅探正反校验（C1）
- [x] 2. 新增 `scripts/lib/agents-defaults.mjs`(new)，拆出变量拼装并加入 7 键 `Dev Profile` 自动预填；精简 `scripts/compose-agents.mjs` 至 800 行以内，更新 `scripts/lib/protocol.mjs` 与 `scripts/lib/agents-sections.mjs` 用户校准保护，完成 `templates/agents-project.md` 两档隔离与 `Dev Profile` 占位接入（C2、C4）
- [x] 3. 在 `scripts/lib/claims.mjs` 将 `docs/archive` 纳入 `OPTIONAL_INFRA_DIRS` 并豁免带尖括号占位的示例表格行，同时保留真实失约路径拦截（C3）
- [x] 4. 强化 `scripts/equip.mjs --check` 三项一致性校验并收敛 `scripts/handoff.mjs` `stripInlineCode` 仅剥多反引号元示例而保留单反引号 `SKILL_INTERNAL_RE` 扫描（C7、C8）
- [x] 5. 在 `kit/skills/lib/cli.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/task-graph.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`flow-inspect.mjs`、`flow-next.mjs`、`flow-lifecycle.mjs` 与 `flow-merge.mjs` 实现两档五态无死锁闭环（`hasSkillsDir` 区分 / 6 类高风险 exit 4 `--reason` / 外部 PR `BLOCKED_REQUIRES_DEV_REVIEW` / `contributor-fork` 顺序修正 / `buildSubmitNextSteps` 精简），确保各文件均不超过 800 行（C5、C6）
- [x] 6. 新增 `scripts/dev/fixtures-onboarding.mjs`(new) 并注册到 `scripts/dev/fixtures.mjs`（`--domain onboarding`），更新 `scripts/dev/injections-data.mjs`（基线既有 `I121`/`I125` 随函数拆分改 `file` 为 `scripts/lib/agents-defaults.mjs`(new) 并新增本单独占 `I134..I138`），落盘 5 类项目形态端到端、`backup`/`handoff`、`2×5` 矩阵与故障注入正反断言（C6、C9）
- [x] 7. 运行 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .` 同步自举产物，依次实跑 `preflight.mjs`、`fixtures.mjs`、`review.mjs .` 与 `doc-plan.mjs audit --file ...` 并更新 SPEC 与 Todo 收尾记录

## 断点与遗留决策

- **断点**：已完成，无遗留。
- **待拍板事项**：无

## 完成后的记录

- **最终改动摘要**：完成 `profile-sniffer.mjs` 根仓 `wrapDir`、`agents-defaults.mjs` 拆分与 7 键 `Dev Profile` 预填/免漂移保护、`templates/agents-project.md` 两档隔离、`claims.mjs` `docs/archive` 与占位示例行过滤、`equip.mjs --check` 三项一致性增强、`handoff.mjs` 单反引号内部指针扫描，以及 `2×5` 运行时无死锁矩阵与 5 形态端到端测试；同步更新 `.agents/skills/`、`AGENTS.md` 与 `docs/TDD.md`。
- **验证与门禁证据**：所有新增与修改文件行数均不超过 800 行（`fixtures-onboarding.mjs` 780 行、`compose-agents.mjs` 676 行、`flow-lifecycle.mjs` 793 行、`workflow-policy.mjs` 788 行），`preflight.mjs`（33 项）、`fixtures.mjs`（232 项含 `--domain onboarding` 7 项）、`e2e-zip-harness.mjs`（7 场景）及 `govern-audit.mjs audit . --changed --strict` 均已通过；待 `finalize` 归档提交后跑全套 `--mode gate` 绑定最终提交 `HEAD`。
- **文件清理确认**：隔离实施位于 `.worktrees/impl-issue-58`，无多余临时文件；待独立审查合并后按清单确认清理。
