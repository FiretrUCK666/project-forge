---
kind: spec
title: CLI 契约归一化、Skill 预算门禁与常青瘦身
status: approved
tier: L3
created: 2026-11-24
updated: 2026-11-24
issue: null
pr: null
branch: feat/conv-arch-plan
owner: planner-conv-arch
plan_mode: interactive
approved: true
implemented: false
plan_critique: "passed (reviewer=critic-conv-arch, round=1, sha=2213a625664b, summary=切片 3 SPEC 体积基线精确（dev-govern 15572B / dev-review 15030B），14KB 告警与 16KB 硬限门禁及 C9-C12 同步链路完整可验)"
related_prd: ../prd/261124-conversational-state-machine-prd.md
related_todo: ../todo/261124-ergonomics-and-budget-debloat-todo.md
high_risk_paths: [kit/, scripts/lib/, scripts/dev/preflight.mjs, templates/, AGENTS.md]
task_id: ergonomics-and-budget-debloat
depends_on: [conversational-lifecycle-model]
scope_files: [kit/skills/lib/cli.mjs, kit/skills/lib/subcommand-meta.mjs, kit/skills/lib/tool-owned.mjs, kit/skills/dev-plan/scripts/doc-plan.mjs, kit/skills/dev-flow/scripts/flow.mjs, kit/skills/dev-flow/scripts/flow-inspect.mjs, kit/skills/dev-review/scripts/review-pack.mjs, "kit/skills/*/SKILL.md", scripts/lib/protocol.mjs, scripts/dev/preflight.mjs, scripts/dev/preflight-suite.mjs, "scripts/dev/fixtures*.mjs", templates/agents-project.md, AGENTS.md, docs/TDD.md, references/collaboration.md, README.md, README.en.md]
---

# CLI 契约归一化、Skill 预算门禁与常青瘦身 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `approved`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（公共 CLI 契约归一化、体积门禁引入与全套文档对齐；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-24` / `2026-11-24` |
| 分支 / Issue / PR | `feat/conv-arch-plan` / `#169` / 未关联 |
| 负责人 / 内审状态 | planner-conv-arch / `passed` |
| 规划态 | `interactive`（关键设计与 5 项决策已确认，待拍板为零） |
| 关联 PRD / Todo | `../prd/261124-conversational-state-machine-prd.md` / `../todo/261124-ergonomics-and-budget-debloat-todo.md` |

- **变更一句话**：归一化公共 CLI 参数与 `[NEXT STEP]` / `nextSteps` 输出，落地 14KB/16KB Skill 体积门禁并完成全部 `SKILL.md` 与常青文档瘦身同步。

## 系统变更全景

```mermaid
flowchart LR
  Cli["CLI 归一化"] --> Budget["Skill 体积门禁"]
  Budget --> Debloat["技能文档瘦身"]
  Debloat --> Sync["常青契约同步"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/cli.mjs`、`subcommand-meta.mjs`、`doc-plan.mjs`、`flow.mjs`、`review-pack.mjs` | 改造 | 统一 `--agent`/`--mode`/`--host-mode` 规范名、旧别名静默兼容、`nextSteps` 与 `[NEXT STEP]` 修复 |
| `scripts/lib/protocol.mjs`、`kit/skills/lib/tool-owned.mjs`、`scripts/dev/preflight.mjs`、`scripts/dev/preflight-suite.mjs` | 改造 | 定义并强制执行 `KIT_SKILL_WARN_BYTES`（14KB）与 `KIT_SKILL_MAX_BYTES`（16KB） |
| `kit/skills/dev-govern/SKILL.md`、`kit/skills/dev-review/SKILL.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-plan/SKILL.md` 等 8 套技能文档 | 改造 | 拆解超长条文与重复错误码罗列，全部稳定低于 14KB 告警线 |
| `templates/agents-project.md`、`AGENTS.md`、`docs/TDD.md`、`references/collaboration.md`、`README.md`、`README.en.md` | 改造 | 对齐 Case 1 隔离描述与 `WARN_WORKING_IN_MAIN_CHECKOUT`，同步 v2/两态架构并重跑 `compose`/`equip`/`sync-toc` |

## 一、背景与边界声明

- **要改什么**：统一公共 CLI 标志与 `[NEXT STEP]` 输出格式、落地内置 Skill 字节预算门禁、瘦身超标与冗长 `SKILL.md`，并同步全仓常青文档与模板。
- **不改什么**：不修改 Wave 1 状态完整性规则与 Wave 2 `session-state.mjs` v2 / `mutability.mjs` 语义（本切片只做 CLI 表达规范化与文档同步）。
- **本期不做**：不删减任何已有运行门禁或错误码拦截逻辑，不破坏旧 CLI 参数的向后兼容解析。
- **复用既有模块**：复用 `kit/skills/lib/tool-owned.mjs` 与 `scripts/lib/protocol.mjs` 的单源预算导出模式（同 `AGENTS_MAX_BYTES` / `AGENTS_WARN_BYTES`），以及 `scripts/compose-agents.mjs`、`scripts/equip.mjs`、`scripts/sync-toc.mjs`。
- **架构基线关系**：符合 `docs/TDD.md` 预算常量单源化要求，且严格保持 `README.md` 与 `README.en.md` 成对同步。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **CLI 公共参数与 `[NEXT STEP]` 输出归一化**：
   - `kit/skills/lib/cli.mjs`、`kit/skills/lib/subcommand-meta.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `kit/skills/dev-review/scripts/review-pack.mjs`：
     * 公共参数规范名统一为 `--agent`、`--mode`、`--host-mode`，help 文本、`subcommand-meta.mjs` 声明与 `[NEXT STEP]` 仅展示规范名；
     * 旧参数（如 `--owner`、`--actor`、`--tier`、`--single-session` 等既有别名）继续作为静默别名保留在解析层，确保老脚本与外部习惯零中断；
     * 修复 `doc-plan triage` 生成的 `[NEXT STEP]` 漏带 `--owner`/`--agent` 的问题；
     * 移除 `doc-plan audit` 末尾连续两次 `printNextStep` 的重复输出；
     * 修复 `flow start` 复用已有工作树/分支时的 `[NEXT STEP]` 提示；
     * 统一在 `--json` 模式结构化返回 `nextSteps` 字段（由 `printNextStep` / JSON 输出辅助逻辑单源生成）。
2. **Skill 体积预算常量与门禁**：
   - 在 `kit/skills/lib/tool-owned.mjs` 定义并由 `scripts/lib/protocol.mjs` 单源重导出 `KIT_SKILL_WARN_BYTES = 14 * 1024`（14336）与 `KIT_SKILL_MAX_BYTES = 16 * 1024`（16384）。
   - 在 `scripts/dev/preflight.mjs` / `scripts/dev/preflight-suite.mjs` 对全部 `kit/skills/*/SKILL.md` 执行字节检查：超过 `KIT_SKILL_WARN_BYTES` 输出结构化告警，超过 `KIT_SKILL_MAX_BYTES` 直接失败阻断。
3. **8 套 `SKILL.md` 去膨胀与常青契约同步**：
   - 对 `kit/skills/dev-govern/SKILL.md`（当前 15572 B）、`kit/skills/dev-review/SKILL.md`（当前 15030 B）、`kit/skills/dev-flow/SKILL.md`（13075 B）、`kit/skills/dev-plan/SKILL.md`（12037 B）及其余 `dev-explore`、`dev-edit`、`dev-iterate`、`dev-verify-tools` 的 `SKILL.md` 进行结构化瘦身：
     * 将超过 1000B 的单条巨型列表拆解为短句或紧凑表格；
     * 移除多处重复罗列的相同错误码说明，保留单源定义与 `preflight-contracts.mjs` 所需全部核心规则锚点；
     * 确保全部 8 套 `SKILL.md` 字节数舒适低于 `KIT_SKILL_WARN_BYTES`（14KB）。
   - 对齐 `templates/agents-project.md` 与 `AGENTS.md` 中的 Case 1 原地微调描述矛盾（明确 Case 1 允许原地微调与隔离规则边界，消除互相冲突表述）及 `WARN_WORKING_IN_MAIN_CHECKOUT` 文案；
   - 同步更新 `docs/TDD.md`、`references/collaboration.md`、`README.md` 与 `README.en.md`（反映 v2 多主题记忆、`OPEN`/`LOCKED` 两态、`reopen` 与规范 CLI 标志）；
   - 执行 `node scripts/compose-agents.mjs .`、`node scripts/equip.mjs .`、`node scripts/sync-toc.mjs README.md README.en.md`。

### 数据与状态变更

- 本次不新增磁盘持久化文件格式；仅新增 JSON 输出字段 `nextSteps` 与预算常量 `KIT_SKILL_WARN_BYTES`、`KIT_SKILL_MAX_BYTES`。

### 异常、回退与安全边界

- 保留旧 CLI 参数静默别名，避免任何既有流水线或脚本升级后报错。
- 瘦身过程严格对照 `scripts/dev/preflight-contracts.mjs`、`scripts/dev/subcommand-parity.mjs` 与 `scripts/dev/verify-injections.mjs`，防止误删规则导致契约检查失败。

### 实现顺序

1. 归一化 `cli.mjs`、`subcommand-meta.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-inspect.mjs`、`review-pack.mjs`（规范标志、静默别名、`[NEXT STEP]` 与 `--json` `nextSteps`）。
2. 在 `kit/skills/lib/tool-owned.mjs`、`scripts/lib/protocol.mjs` 与 `scripts/dev/preflight.mjs` / `preflight-suite.mjs` 落地 `KIT_SKILL_WARN_BYTES` / `KIT_SKILL_MAX_BYTES`。
3. 瘦身 `kit/skills/*/SKILL.md` 至 14KB 以下并验证 `preflight-contracts.mjs` 与 `verify-injections.mjs`。
4. 同步 `templates/agents-project.md`、`AGENTS.md`、`docs/TDD.md`、`references/collaboration.md`、`README.md`、`README.en.md`，运行 `compose-agents.mjs .`、`equip.mjs .`、`sync-toc.mjs`、`review.mjs .`、`fixtures.mjs` 与 `preflight.mjs`。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 直接删除旧 CLI 标志（如 `--owner`/`--tier`） | 仅保留 `--agent`/`--mode`/`--host-mode` | 会破坏存量自动化脚本与用户肌肉记忆，属于不必要的破坏性变更 | 未来跨大版本明确宣布废弃周期后再移除 |
| 只把规则外移出 `SKILL.md` 而不拆解表达 | 用极简几行替代规则说明 | 会触发 `preflight-contracts.mjs` 缺失契约关键词并丢失关键防错说明 | 永不改回（高内聚精简而非删规则） |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/cli.mjs`、`subcommand-meta.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-inspect.mjs`、`review-pack.mjs` | 修改 | 规范参数、`nextSteps` JSON 输出、`triage`/`audit`/`start` `[NEXT STEP]` 修复 | 所有 CLI 调用方与子代理 |
| `kit/skills/lib/tool-owned.mjs`、`scripts/lib/protocol.mjs`、`scripts/dev/preflight.mjs`、`scripts/dev/preflight-suite.mjs` | 修改 | `KIT_SKILL_WARN_BYTES`（14KB）与 `KIT_SKILL_MAX_BYTES`（16KB）门禁 | 全仓构建与 CI 预检 |
| `kit/skills/dev-govern/SKILL.md`、`kit/skills/dev-review/SKILL.md`、`kit/skills/dev-flow/SKILL.md`、`kit/skills/dev-plan/SKILL.md`、`kit/skills/dev-explore/SKILL.md`、`kit/skills/dev-edit/SKILL.md`、`kit/skills/dev-iterate/SKILL.md`、`kit/skills/dev-verify-tools/SKILL.md` | 修改 | 拆解冗余清单与超长列表，全部低于 14KB 且保留全部有效规则 | 技能加载与预算门禁 |
| `templates/agents-project.md`、`AGENTS.md`、`docs/TDD.md`、`references/collaboration.md`、`README.md`、`README.en.md` | 修改 | 修复 Case 1 矛盾与文案、同步架构文档及双语目录 | 全仓文档与下游渲染模板 |

- **对外可见的变化**：CLI help 与 `[NEXT STEP]` 统一展示 `--agent` / `--mode` / `--host-mode`，`--json` 包含 `nextSteps`；旧标志仍静默兼容；所有 `kit/skills/*/SKILL.md` <= 14KB。
- **需要同步改的地方**：`.agents/skills/`（执行 `node scripts/equip.mjs .`）、`AGENTS.md`（执行 `node scripts/compose-agents.mjs .`）、`README.md` / `README.en.md`（执行 `node scripts/sync-toc.mjs README.md README.en.md`）、`scripts/dev/fixtures*.mjs`。

## 五、冻结的验收标准

- [ ] C9: `cli.mjs` / `subcommand-meta.mjs` / `doc-plan.mjs` / `flow.mjs` / `flow-inspect.mjs` / `review-pack.mjs` 将公开标志、help 与 `[NEXT STEP]` 统一至 `--agent`、`--mode`、`--host-mode` 同时静默保留旧别名兼容；`doc-plan triage` `[NEXT STEP]` 包含 `--agent`（兼容 `--owner`）、`doc-plan audit` 仅输出一次 `printNextStep`、`flow start` 复用分支给出准确 `[NEXT STEP]`，且 `--json` 输出结构化 `nextSteps`，由 `node scripts/dev/fixtures.mjs` 与 `node scripts/dev/subcommand-parity.mjs` 断言通过。
- [ ] C10: `kit/skills/lib/tool-owned.mjs` 定义并由 `scripts/lib/protocol.mjs` 单源重导出 `KIT_SKILL_WARN_BYTES = 14 * 1024` 与 `KIT_SKILL_MAX_BYTES = 16 * 1024`，`scripts/dev/preflight.mjs` / `scripts/dev/preflight-suite.mjs` 对超 14KB 告警、超 16KB 失败阻断（含正反 fixture），由 `node scripts/dev/preflight.mjs` 与 `node scripts/dev/fixtures.mjs` 断言通过。
- [ ] C11: 全部 8 套 `kit/skills/*/SKILL.md` 完成去膨胀（拆解千字节级超长列表与重复错误码罗列而不丢失有效规则），每一份字节数严格低于 `KIT_SKILL_WARN_BYTES`（14336 B），且 `node scripts/dev/preflight.mjs`（含 `preflight-contracts.mjs`）与 `node scripts/dev/verify-injections.mjs --jobs 4` 全部通过。
- [ ] C12: 修复 `templates/agents-project.md` 与 `AGENTS.md` 中的 Case 1 矛盾与 `WARN_WORKING_IN_MAIN_CHECKOUT` 文案，同步更新 `docs/TDD.md`、`references/collaboration.md`、`README.md` 与 `README.en.md`，并执行 `node scripts/compose-agents.mjs . --check`、`node scripts/equip.mjs . --check`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node scripts/review.mjs .`（0 个「缺」）、`node scripts/dev/e2e-zip-harness.mjs` 与 `node scripts/dev/merge-gate.mjs` 全部通过。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（涉及 `scripts/lib/protocol.mjs`、`scripts/dev/preflight.mjs`、`templates/`、`AGENTS.md` 与全套 `kit/`）；回滚做法：通过 `git revert` 反向提交还原，禁止改写远端历史。
- **高风险路径**：本切片几乎触及 `AGENTS.md` 列出的全部高风险路径（`scripts/lib/`、`scripts/dev/preflight.mjs`、`templates/`、`kit/`、`AGENTS.md`），合并前必须由独立审查者执行双阶段故障注入与全链路验证。
- **故障注入预演**：复用 `node .agents/skills/dev-review/scripts/review-pack.mjs check-fault --phase fail` / `restore`，注入将 `KIT_SKILL_MAX_BYTES` 放大或删除 `preflight-contracts.mjs` 断言的故障，确认门禁必红后再恢复。

## 七、上线与兼容策略

- **向后兼容**：旧 CLI 标志作为静默别名持续有效；现有已装备项目通过 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .` 无损平滑升级。

## 澄清与补充记录

- （本轮无额外澄清补充；全部设计边界已由总控 PRD 确认，待拍板为零）

## 实现说明

- **实际落地摘要**：
- **与草案的差异**：
- **关联同步文件**：
