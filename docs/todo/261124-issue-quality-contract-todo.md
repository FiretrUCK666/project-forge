---
kind: todo
title: 单一平台中性 Issue 质量契约与门禁
status: draft
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/issue-quality-contract
owner: plan-issue-contract
plan_mode: autonomous
approved: false
done_at: null
task_id: issue-quality-contract
planned_at: 35917ac5e4084845e8638252990db27fbda4cc7f
related_prd: null
related_spec: ../specs/261124-issue-quality-contract-spec.md
---

# 单一平台中性 Issue 质量契约与门禁

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / 基线 | `feat/issue-quality-contract` @ `35917ac` |
| 任务编号 | `issue-quality-contract` |
| 负责人 / 审批 | plan-issue-contract / `false` |
| 规划态 | `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | 未关联 / 未关联 / `docs/specs/261124-issue-quality-contract-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/issue-quality.mjs` (new)、`kit/skills/lib/issue-template-hydrate.mjs`、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`templates/issue-bug-report.md`、`templates/issue-feature-request.md`、`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`、`docs/TDD.md`、`docs/feature-map.json`、`references/docs-set.md`、`references/collaboration.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-govern/SKILL.md`、`AGENTS.md`、`scripts/dev/fixtures-issue-quality.mjs` (new)、`scripts/dev/injections-data-issue-quality.mjs` (new) 及既有夹具升级
- **复用既有模块**：`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/markdown-scan.mjs`、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/plan-index.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`scripts/dev/cli-parity.mjs`
- **本期不做**：不新增 `--mode standalone|linked` 等双模式开关；不引入字数/字节长度死线；不引入第三方依赖或 emoji；不改 `local-issues.mjs` 底层存储签名
- **门型与回滚路径**：two-way；纯源码与契约文档改动，直接 `git revert` 即可无损回滚。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。

- [ ] C1: 单一事实驱动 Issue 质量校验落地（`kit/skills/lib/issue-quality.mjs` (new) 实现 `validateIssueBodyQuality` 5 项底线与 `plan-index.mjs` 查盘，`kit/skills/lib/exit-codes.mjs` 注册 `BLOCKED_ISSUE_QUALITY_INCOMPLETE`，`kit/skills/lib/issue-template-hydrate.mjs` 移除空洞套话与静默删节且绝不留空白占位，无第二套模式）。
- [ ] C2: 富证据自动建单器落地（`kit/skills/lib/escalation.mjs` 的 `buildIssues` 与 `buildEscalationIssuePayload` 自动携带 `file:line`、模块影响面、严重度依据、已核实基线与未测局限、`C1..Cn` 与明确 `Out of Scope`，兼容全部 `TaskBackend` 后端且 UTF-8 安全零 emoji）。
- [ ] C3: 单一入口门禁收口与 `verify-tools run --stale` 排序修复（`flow.mjs issue create` 支持 `--spec`/`--todo`/`--prd`，全托管建单入口强制走 `hydrateIssueBody -> validateIssueBodyQuality -> createIssue`，`cli-parity.mjs` 0 漂移，现有 `fixtures*.mjs` 建单正文升级合规，`verify-tools.mjs run --stale` 将自检置后并一次性通过）。
- [ ] C4: 模板、档案与契约同步完成（更新 `templates/issue-*.md`、`.github/ISSUE_TEMPLATE/*.md`、`docs/TDD.md`、`docs/feature-map.json`、`references/docs-set.md`、`references/collaboration.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-govern/SKILL.md`，并执行 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .`）。
- [ ] C5: 双向测试与故障注入全绿（新增 `scripts/dev/fixtures-issue-quality.mjs` (new) 与 `scripts/dev/injections-data-issue-quality.mjs` (new) 覆盖全部 9 个正反场景与 5 项注入，且 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs`、`gap-coverage.mjs`、`govern-audit.mjs audit .`、`verify-tools.mjs audit` 全部退出码 `0`）。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 注册 `BLOCKED_ISSUE_QUALITY_INCOMPLETE` 并先建红灯测试 `scripts/dev/fixtures-issue-quality.mjs` (new) | `node scripts/dev/fixtures.mjs --domain issue-quality` 必红 | SPEC 获批 |
| 2 | 实现 `kit/skills/lib/issue-quality.mjs` (new) 与改造 `kit/skills/lib/issue-template-hydrate.mjs`（C1） | C1 对应双向用例变绿 | 步骤 1 |
| 3 | 升级 `kit/skills/lib/escalation.mjs`、托管建单入口、`verify-tools.mjs` 自检排序及旧夹具正反改造（C2/C3） | `node scripts/dev/cli-parity.mjs` 与受影响 fixtures 全绿 | 步骤 2 |
| 4 | 同步模板、文档、`feature-map.json`，执行 `equip.mjs .` 与 `compose-agents.mjs .`，补 `injections-data-issue-quality.mjs` (new)（C4/C5） | 全仓 `preflight.mjs`、`fixtures.mjs`、`verify-injections.mjs --jobs 4`、`verify-tools.mjs run --stale` 全绿 | 步骤 3 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 既有夹具调用裸建单失败 | `fixtures-trace-sync.mjs` / `fixtures-local-backend.mjs` / `fixtures-escalation-stoploss.mjs` / `fixtures-handoff-review.mjs` / `fixtures-flow.mjs` 传入极简短正文 | 逐个核实并升级为真实合规正文，同时保留专门的负面拦截测试 |
| `issue-quality.mjs` 与 `pr-template-hydrate.mjs` 循环引用 | 若直接互相静态 import 导致初始化时序问题 | `issue-quality.mjs` 仅依赖 L1/L2 原语（`markdown-scan.mjs`、`doc-substantive.mjs`、`plan-index.mjs`、`exit-codes.mjs`、`git.mjs`），不反向引用 L3 |
| 模板标题改动破坏同构检查 | `templates/issue-*.md` 新增二级标题而 `.github/ISSUE_TEMPLATE/*.md` 未同步 | 同提交成对更新并用 `node scripts/dev/preflight.mjs` 校验 `checkOwnInstances` |

## 断点与遗留决策

- **当前状态**：`draft`（等待独立 Critique 与 `approve`）
- **待拍板事项**：无
- **下一步第一件事**：由独立 Critique 评审 `docs/specs/261124-issue-quality-contract-spec.md` 与本 Todo 并由维护者 `approve` 后转入实施。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
- **文档同步检查**：
- **遗留问题**：
