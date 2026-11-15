---
kind: spec
title: v7 M5 全链路技能协同对齐、TDD 架构图完善与总控 PRD 终态归档
status: implemented
tier: L3
created: 2026-11-16
updated: 2026-11-16
issue: 43
pr: null
branch: feat/v7-m5-align-skills-docs-bootstrap
owner: FiretrUCK666
approved: true
implemented: true
plan_critique: "passed (reviewer=independent-plan-critic-m5-r2, round=2, sha=e99411f8d07a, summary=Round 2 verified all 4 MUST-FIX closed: flow.mjs flag, docs.mjs/flow-lifecycle.mjs --include-master-prd and 800L, govern-docs archive dead-link exemption, hard anchors and I76)"
related_prd: ../prd/261115-v7-workflow-architecture-prd.md
related_todo: ../todo/261116-issue43-v7-m5-align-skills-docs-bootstrap-todo.md
high_risk_paths: [SKILL.md, AGENTS.md, kit/, templates/]
---

# SPEC: v7 M5 全链路技能协同对齐、TDD 架构图完善与总控 PRD 终态归档

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3` |
| 创建 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / Issue | `main` / #43（归属于总控 PRD `docs/archive/prd/261115-v7-workflow-architecture-prd.md` M5 收官与 `C1..C12` 全量验收） |
| 负责人 / 内审状态 | `FiretrUCK666` / `pending` |
| 关联 PRD / Todo | `docs/archive/prd/261115-v7-workflow-architecture-prd.md` / `docs/archive/todo/261116-issue43-v7-m5-align-skills-docs-bootstrap-todo.md` |

## 系统变更全景

```mermaid
flowchart LR
  Entry["入口与五套件"] --> Refs["判据与契约"]
  Refs --> TDD["常青架构图"]
  TDD --> Docs["双语说明与PRD"]
  Docs --> Gate["全量自举与归档"]
```

| 模块 / 文件 | 变更性质 | 核心职责与约束 |
| --- | --- | --- |
| `SKILL.md` | 改造 | 在 `<= 200` 行 / `<= 16KB` 内对齐 `S1..S4` 初始化、8 阶段日常研发闭环、v7 `TaskBackend`/`flow next`/`retro` 与全部门控指针 |
| `kit/skills/*/SKILL.md`（5 套） | 改造 | 不盲目缩减，在 `<= 180` 行上限内系统重塑 5 套技能对 8 阶段全链路的分工、多轮澄清/Critique、Worktree 隔离、谁改谁提 PR 与相互衔接 |
| `references/collaboration.md` / `references/docs-set.md` | 改造 | 对齐 8 阶段生命周期、多轮 `dev-plan` 澄清与 PRD 推荐、自定义模板尊重、`--include-master-prd` 与 `retro`/`signals.jsonl` 闭环 |
| `templates/agents-project.md` -> `AGENTS.md` | 改造 | 精炼防叠补丁（`<= 24KB` 预警线内），严守 `equip-bootstrap.mjs` 替换锚点、`no-remote` 零远端词泄漏及 `preflight-contracts.mjs` 对拍 |
| `kit/skills/lib/docs.mjs` / `doc-templates.mjs` | 改造 | 新增 `includeMasterPrd` 归档总控 PRD 并保留其 `issue: null`/`related_*` 原样（保持 `docs.mjs <= 800` 行，必要辅助下沉 `doc-templates.mjs`） |
| `kit/skills/dev-plan/scripts/doc-plan.mjs` / `kit/skills/dev-flow/scripts/flow.mjs` / `kit/skills/dev-flow/scripts/flow-lifecycle.mjs` | 改造 | `flow.mjs` 注册 `'include-master-prd'`、`doc-plan.mjs archive` 注册 `--include-master-prd`、`flow-lifecycle.mjs` 透传检查并正确记录 `ledger.archivedPrdFile`（全文件 `<= 800` 行） |
| `kit/skills/dev-govern/scripts/govern-docs.mjs` | 改造 | `checkMarkdownDeadLinks` 跳过 `docs/archive/` 冻结历史目录（与 Mermaid 检查对齐），避免归档总控 PRD 后对既已归档的 M2 相对链接误报 `docs.dead-link` |
| `docs/TDD.md` | 改造 | 清除全部 `[v7 规划 M5]` 标记，更新总控 PRD 终态归档引用与 `scripts/lib/platform/{index,github-probe}.mjs` 等模块/CLI 清单；新增直观 8 阶段协同与运行状态 Mermaid 图（`16/12` 无 HTML） |
| `README.md` / `README.en.md` | 改造 | 同步 v7 全链路能力与 8 阶段工作流（保持 `oil-tone`、权威版本号 `6.0.0` 不变、`Repo → docs → remote → automation` 等单源句式及 `sync-toc.mjs` 目录同步） |
| `scripts/dev/preflight-contracts.mjs` / `fixtures-docs.mjs` / `fixtures-govern.mjs` / `injections-data.mjs` | 改造 | 新增 8 阶段生命周期与五套件对齐契约校验（配 `I76`）、`--include-master-prd` 与 `govern-docs` 跳过 `docs/archive/` 正反夹具 |
| `docs/archive/prd/261115-v7-workflow-architecture-prd.md` | 改造与终态归档 | 实证勾选 `- [x] C1..C12` 置 `status: done`，经 `finalize --include-master-prd` 归档进 `docs/archive/prd/` |

## 一、背景与边界声明

- **要改什么**：交付 v7 总控路线图收官切片 **M5**：以「**需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入**」为主轴，全盘对齐根目录 `SKILL.md`、5 套 `kit/skills/*/SKILL.md`（同步 `.agents/skills/`）、`references/` 判据、`templates/agents-project.md` -> `AGENTS.md`、`docs/TDD.md` 直观架构图、双语 `README`，打通 `--include-master-prd` 总控 PRD 终态归档与 `govern-docs` 历史归档链接豁免，并以全量门禁与三平台 CI 完成终态自举验收。
- **不改什么**：严守零第三方依赖、零特定 AI 宿主名称、零 Emoji、零 `FORBIDDEN_PLATFORM_RE`；不触发 `git tag v*` 正式发版（保留权威版本号 `6.0.0` 不动）；不篡改 `docs/archive/` 内既已归档的 M0–M4 历史单据；不弱化任何门禁或删减夹具断言。
- **本期不做**：不新增外部平台扩展适配器；不重写既有 6 张 `.svg` 矢量卡片（保留现状通过结构与字号校验）。
- **复用既有模块**：复用 `kit/skills/lib/docs.mjs`、`doc-templates.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-lifecycle.mjs`、`govern-docs.mjs`、`scripts/equip.mjs`、`compose-agents.mjs`、`sync-toc.mjs`、`review.mjs` 与 `scripts/dev/{preflight,fixtures,verify-injections,e2e-zip-harness}.mjs`。
- **架构基线关系**：遵守 `docs/TDD.md` `arch-rules` 及全部 `kit/skills/**/*.mjs <= 800`、`kit/skills/*/SKILL.md <= 180`、`SKILL.md <= 200L / 16KB` 硬预算。

## 二、设计方案与契约变更

### 1. 根 `SKILL.md` 与五套内置 `kit/skills/*/SKILL.md` 协同重塑

- **硬锚点保护清单（不可破坏既有契约与正反测试）**：
  - `SKILL.md`：`<= 200` 行 / `<= 16KB`（`FULL_READ_MAX_LINES <= 1000`）；保留「版本控制 → 文档 → 远端 → 自动化」、`--verify` 行仅出现 `0/1/3/4` 四个退出码（不夹杂其它一位数字）、`--bootstrap-empty` + `explorationStrategy.tier` + `不派只读子代理`（`preflight-suite.mjs:625`）、分档可撤回性/审查者合/弱化门禁人点头、`references/*.md`「标题名」精准锚点。
  - 五套 `kit/skills/*/SKILL.md`（各自 `<= 180` 行，运行 `equip.mjs .` 同步 `.agents/skills/`）：
    1. `kit/skills/dev-explore/SKILL.md`：只读侦察前瞻（`none`/`quick`/`medium`/`thorough` 含 `--bootstrap-empty` 与 `explorationStrategy.tier`、`git ls-files -z`、输出 `Feature Map` + `reusableModules`、`docs/TDD.md` 分工），清晰移交 `dev-plan` / `dev-flow`。
    2. `kit/skills/dev-plan/SKILL.md`：**需求 → 澄清 → 设计 与独立 Critique 网关**。覆盖多 URL/Issue/PR 联查；PRD 双入口推荐（用户提出 / 勘察发现多问题主动建议 PRD）；多轮互动澄清并消解「七、待拍板问题」与范围边界后才定稿；尊重仓库既有模板（`docs/templates/*` / `.github/*-template.md`）；五档分流（Case 1/2 轻量直接、Case 3 Todo、Case 4 SPEC+Todo、Case 5 先 TDD）、Mermaid `16/12`、`impl` 工作树协同（`doc-plan init` 绑定已启动工作树或随 `flow start` 迁入）、不可自审的独立 Critique（`SELF_CRITIQUE_REJECTED`）及批准后移交 `dev-flow`（含 `batch plan` / `--after` 依赖波次）。
    3. `kit/skills/dev-flow/SKILL.md`：**实现 → 实证测试-形式验证 → 合入 状态机**。覆盖 `flow.mjs next` 跨会话重水合、`inspect` 五态+Issue 图谱拓扑、全 Worktree 隔离与槽复用、**谁改代码谁认领并负责 `finalize`/`verify`/`submit` 及 PR/Issue 评论**（`BLOCKED_SUBMIT_OWNERSHIP_MISMATCH`）、分层 `evidence.json` 防 `--target` 旁路、`finalize`（`--include-master-prd` 与 `tdd-parity`）、`merge` CI/双门/`--detach` 试合及 7 步 `--confirm` 清理。
    4. `kit/skills/dev-review/SKILL.md`：**评审 → 实证测试-形式验证 → 验收 双门六锁把关器**。覆盖模式 A/B、外部 PR `--untrusted-scan`、Behavioral/Structural 双门 + `--visual-checked`、Doc-Code Parity、六锁防死循环与 Round 2+ 新独立审查上下文、`--disposition` + `signals.jsonl` 自动记录、PASS 后由审查者执行 `flow merge`（弱化门禁或 `merge-authority: human` 交人拍板）。
    5. `kit/skills/dev-govern/SKILL.md`：治理闭环与规则下沉中枢（`audit`、`reconcile`、`plan --write-todo`、`issues`、`record`/`cluster`/`sample`、`retro [--task] [--apply-patches]` 读取 `signals.jsonl` 与误报率、`release-prep` 跨版本筹备及与四兄弟技能双向联动）。

### 2. 总控 PRD 终态归档（`--include-master-prd`）与归档死链豁免

- **`kit/skills/lib/docs.mjs` & `doc-templates.mjs`（控行 `<= 800`）**：
  - `archiveCompletedDocsGroup(repoRoot, { ..., includeMasterPrd = false })`：用 `wasSharedPrds` 记录 `isSharedMasterPrd(...)` 命中的 1:N 总控 PRD；仅当 `includeMasterPrd === false` 时纳入 `skippedSharedPrds` 保护不归档；当 `includeMasterPrd === true` 时将其 `git mv` 至 `docs/archive/prd/`，**仅写入 `updated: today` 与 `status: 'done'`，严格保留原 `issue`/`pr`/`branch`/`related_spec`/`related_todo` 字段**（绝不将子切片 `#43` 覆写进总控 PRD 引发 `ISSUE_FILENAME_MISMATCH`）；同步返回 `archivedMasterPrd`。若增改接近 790 行，将元信息保留 helper 放至 `doc-templates.mjs`。
- **`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `flow-lifecycle.mjs`（全部 `<= 800` 行）**：
  - `flow.mjs` `booleanFlags`（与 `printHelp` `finalize` 行）与 `doc-plan.mjs` `booleanFlags`（与 `archive` 帮助行）同步登记 `'include-master-prd'`；
  - `flow-lifecycle.mjs` `handleFinalize` 支持 `opts['include-master-prd']`：传该标志时同样检查总控 PRD 内全部 `C*` 勾选完毕，透传 `includeMasterPrd: true` 归档，并设置 `ledger.archivedPrdFile = archivedGroup.byKind.prd`（防止 `workflow-policy` `do-not-edit: docs/archive/` 拦截归档动作）。
- **`kit/skills/dev-govern/scripts/govern-docs.mjs:134`**：
  - 在 `checkMarkdownDeadLinks`（与 L400 Mermaid 检查一致）跳过 `docs/archive/` 历史冻结目录，防止将总控 PRD 归档后，既已冻结不可改的 M2 归档文档 `[总控 PRD](../../prd/261115-v7-workflow-architecture-prd.md)` 被误报 `docs.dead-link`。

### 3. `references/`、`templates/agents-project.md`、`docs/TDD.md`、双语 `README` 与门禁对拍

- **保护模板与注入精确锚点**：
  - `templates/agents-project.md` 同步重渲染 `AGENTS.md`（控体积 `<= 24576` B，不追加零散重复补丁）：严格保持 `scripts/lib/equip-bootstrap.mjs`（L210-253）所依赖的全部 11 处受管待填标注、7 键 YAML、无命令提示行、模块概览占位行与 `**提交纪律**：` 原文；严禁在 `has-remote` 条件块之外出现 `PR`/`origin`/`push`/`pull_request`（保证 `no-remote` 零泄漏及 `lightweight < 14KB`）；保持 `I9`/`I9b`/`I9d`/`I9e`/`I9e2` 精准七步收尾措辞。
  - `references/collaboration.md` & `references/docs-set.md`：补充 8 阶段生命周期全链路对照、多轮 `dev-plan` 澄清与 PRD 推荐、`--include-master-prd` 终态归档及 `retro` 闭环，保留既有二级标题、四字段审查栏及七步收尾原句。
  - **`docs/TDD.md`**：移除全部 3 处 `[v7 规划 M5]` 标记，更新版本号/基线/模块表（补全 `scripts/lib/platform/index.mjs`、`scripts/lib/platform/github-probe.mjs` 及 M4/M5 模块与 CLI 表），将 `docs/archive/prd/261115-v7-workflow-architecture-prd.md` 引用同步至 `docs/archive/prd/261115-v7-workflow-architecture-prd.md`（规避 `docs.tdd-stale-path`），并补充直观 `16/12` 无 HTML Mermaid 图展现 8 阶段五套件协同与 `dev-flow` / `dev-review` 运行态流转。
  - **`README.md` & `README.en.md`**：保留权威版本徽章 `v6.0.0`、`S3` 顺序（`版本库 → 文档 → 远端 → 自动化` / `Repo → docs → remote → automation`）及推送分档措辞，同步更新 8 阶段日常工作流与 v7 全能力，跑通 `sync-toc.mjs`。
  - **`scripts/dev/preflight-contracts.mjs` & `scripts/dev/injections-data.mjs` (`I76`)**：新增 `checkWorkflowLifecycleContracts` 核对根 `SKILL.md` 与 5 套 `kit/skills/*/SKILL.md` 是否显式覆盖 8 阶段生命周期核心环节（`澄清`/`Critique`/`Worktree`/`双门`/`retro`）且互链无孤立，并在 `injections-data.mjs` 增补 `I76` 对应故障注入确保破坏该契约时 `verify-injections` 红灯拦截；在 `scripts/dev/fixtures-docs.mjs` 与 `fixtures-govern.mjs` 补齐 `--include-master-prd` 正反双向用例及 `govern-docs` 跳过 `docs/archive/` 死链正反用例。

## 三、冻结的验收标准

- [x] C1: 根 `SKILL.md`（`<= 200L / 16KB`，`FULL_READ_MAX_LINES <= 1000`）与 5 套 `kit/skills/*/SKILL.md`（各自 `<= 180L`，经 `equip.mjs .` 同步 `.agents/skills/`）完整覆盖 8 阶段生命周期、多轮澄清/PRD 触发/独立 Critique、谁改谁提 PR 与相互联动，`node scripts/equip.mjs . --check` 退出码 `0`。
- [x] C2: `references/{collaboration,docs-set}.md`、`templates/agents-project.md` 与 `AGENTS.md`（`<= 24576` B，过 `--bootstrap-empty` 与 `no-remote` 零泄漏校验）完全一致；`compose-agents.mjs . --check` 及 `preflight-contracts.mjs`（含新增 `checkWorkflowLifecycleContracts` + `I76`）全绿。
- [x] C3: `docs/TDD.md` 零 `[v7 规划` 残留、无失效路径与漏列模块，含直观的 8 阶段与 `dev-flow`/`dev-review` Mermaid 图（严格 `16/12` 无 HTML），通过 `doc-plan.mjs audit`、`checkTddSyncParity` 与 `govern-audit.mjs audit .`。
- [x] C4: `README.md` 与 `README.en.md` 成对对齐 v7 全能力（保留 `v6.0.0` 与全部单源锚点），`node scripts/sync-toc.mjs README.md README.en.md --check` 与 6 张 SVG 检查全过。
- [x] C5: `kit/skills/lib/docs.mjs`、`doc-plan.mjs`、`flow.mjs`、`flow-lifecycle.mjs` 支持 `--include-master-prd` 显式归档（默认仍守 1:N 共享 PRD 不退化，保留主 PRD 原有 `issue`/`related_*`，正确记入 `archivedPrdFile`），且 `govern-docs.mjs` 跳过 `docs/archive/` 历史死链；各 `.mjs` 均 `<= 800` 行，在 `fixtures-docs.mjs` 与 `fixtures-govern.mjs` 补齐正反双向用例且 `I58` 通过。
- [x] C6: 在实证门禁全绿前提下勾选总控 PRD `docs/archive/prd/261115-v7-workflow-architecture-prd.md` `C1..C12`（`status: done`）并经 `flow.mjs finalize --include-master-prd` 连同 M5 SPEC/Todo 一并成对归档后 `verify --mode gate` 锁定最新 `HEAD`，全仓门禁（`preflight`、`gap-coverage`、`fixtures < 30s`、`bench` 6/6、`e2e-zip-harness`、`verify-injections --jobs 4`、`review.mjs .`、`govern-audit audit .`、`git archive --package` 与三平台 CI）全绿退出码 `0`。

## 四、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`（触及 `SKILL.md`、`AGENTS.md`、`kit/`、`templates/` 全部高风险路径并执行总控 PRD 终态归档）。实施阶段隔离在 `.worktrees/impl-m5-align-skills-docs-bootstrap/` 推进；合入前可直接丢弃分支或 `abort`，合入后以 `git revert <mergeCommit>` 回退并重跑门禁。
- **高风险路径**：`SKILL.md`、`AGENTS.md`、`kit/`、`templates/`。
- **故障注入预演**：破坏 `checkWorkflowLifecycleContracts`（`I76`）验证 `verify-injections.mjs` 红灯捕获；破坏 `docs.mjs` `--include-master-prd` 元信息保留或 `flow-lifecycle.mjs` `archivedPrdFile` 赋值为 `null` 验证 `fixtures-docs.mjs` 红灯拦截；破坏 `govern-docs.mjs` `docs/archive/` 跳过逻辑验证 `fixtures-govern.mjs` 红灯捕获。

## 实现说明

- **Step 1（`--include-master-prd` 与 `docs/archive/` 死链豁免）**：在 `kit/skills/lib/doc-templates.mjs` 抽出 `buildArchivedDocPatch` 保持 `kit/skills/lib/docs.mjs` 为 `775` 行（`<= 800`）；`archiveCompletedDocsGroup` 新增 `includeMasterPrd = false` 默认保护 `1:N` 总控 PRD，显式开启时 `git mv` 归档总控 PRD、仅更新 `status: done` 与 `updated` 并保留原 `issue`/`pr`/`branch`/`related_*`，且返回 `archivedMasterPrd`。同步在 `doc-plan.mjs`、`flow.mjs` 注册 `include-master-prd`，`flow-lifecycle.mjs` 检查主 PRD 全勾选并写入 `ledger.archivedPrdFile` 豁免 `do-not-edit`；`govern-docs.mjs` `checkMarkdownDeadLinks` 跳过 `docs/archive/` 历史归档。`fixtures.mjs --only "include-master-prd"`（2/2）与 `verify-injections.mjs --only I58` 全过。
- **Step 2（全链路对齐与 `I76` 契约门禁）**：重塑根 `SKILL.md`（`99L / 12576B`）与 5 套 `kit/skills/*/SKILL.md`（`58L..104L <= 180L`）并经 `equip.mjs .` 同步 `.agents/skills/`；对齐 `references/collaboration.md`、`references/docs-set.md`、`templates/agents-project.md` -> `AGENTS.md`（`22559B <= 24576B`，`lightweight` `9400B < 14KB`，`no-remote` 零泄漏）；清除 `docs/TDD.md` 全部 `[v7 规划` 标记、更新版本为 `v7.0.0` 并补全模块清单与 8 阶段/Worktree 双门六锁 `16/12` 无 HTML Mermaid 图；成对更新 `README.md` / `README.en.md` 并同步目录；在 `scripts/dev/preflight-contracts.mjs`（`793L`）新增 `checkWorkflowLifecycleContracts` 及 `injections-data.mjs` `I76`。
- **实证结果**：`preflight.mjs`（32 项读数 0 失败）、`gap-coverage.mjs`（19/19）、`compose-agents.mjs . --check`、`equip.mjs . --check`、`sync-toc.mjs --check`、`review.mjs .`、`doc-plan.mjs audit .`、`fixtures.mjs`（164/164）、`bench.mjs`（6/6，含 300 文件 `survey` 148ms、`flow inspect` 154ms、`backup.zip` 93ms）、`e2e-zip-harness.mjs`（7 场景全通）、`verify-injections.mjs --jobs 4`（83/83 捕获）及 `git archive` 用户包校验（119 文件）全部通过；`finalize --include-master-prd` 后将再跑终态门禁并锁定 `HEAD`。
