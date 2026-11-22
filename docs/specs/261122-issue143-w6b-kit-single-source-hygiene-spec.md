---
kind: spec
title: Slice 6B：kit 单源化、去自用泄漏与门禁精度升级
status: draft
tier: L3
created: 2026-11-22
updated: 2026-11-22
issue: 143
pr: null
branch: docs/w6-universal-architecture-plan
owner: plan-w6
plan_mode: interactive
approved: false
implemented: false
plan_critique: pending
related_prd: ../prd/261122-issue143-w6-universal-architecture-prd.md
related_todo: ../todo/261122-issue143-w6b-kit-single-source-hygiene-todo.md
task_id: w6b-kit-single-source-hygiene
depends_on:
  - w6a-survey-handoff-core
scope_files:
  - kit/skills/lib/subcommand-meta.mjs
  - kit/skills/lib/doc-verify.mjs
  - kit/skills/lib/doc-facts.mjs
  - kit/skills/lib/doc-facts-commands.mjs
  - kit/skills/lib/intake-triage.mjs
  - kit/skills/lib/evidence-substance.mjs
  - kit/skills/lib/no-changelog-voice.mjs
  - kit/skills/lib/static-gates.mjs
  - kit/skills/lib/static-gates-comment-hygiene.mjs
  - kit/skills/lib/feature-map.mjs
  - kit/skills/lib/tdd-parity.mjs
  - kit/skills/lib/gate-truth.mjs
  - kit/skills/lib/profile.mjs
  - kit/skills/dev-explore/scripts/repo-map.mjs
  - kit/skills/dev-explore/scripts/repo-map-helpers.mjs
  - kit/skills/dev-plan/scripts/triage-rules.mjs
  - kit/skills/dev-plan/scripts/doc-plan.mjs
  - kit/skills/dev-edit/scripts/edit-gate.mjs
  - kit/skills/dev-govern/SKILL.md
  - kit/skills/dev-govern/scripts/govern-audit.mjs
  - kit/skills/dev-govern/scripts/govern-checks.mjs
  - kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs
  - kit/skills/dev-govern/scripts/govern-docs.mjs
  - kit/skills/dev-govern/scripts/govern-evergreen.mjs
  - kit/skills/dev-govern/scripts/govern-retro.mjs
  - kit/skills/dev-govern/scripts/govern-tests.mjs
  - kit/skills/dev-verify-tools/scripts/verify-tools.mjs
  - kit/skills/dev-iterate/scripts/iterate.mjs
  - .agents/skills/lib/subcommand-meta.mjs
  - .agents/skills/lib/doc-verify.mjs
  - .agents/skills/lib/doc-facts.mjs
  - .agents/skills/lib/doc-facts-commands.mjs
  - .agents/skills/lib/intake-triage.mjs
  - .agents/skills/lib/evidence-substance.mjs
  - .agents/skills/lib/no-changelog-voice.mjs
  - .agents/skills/lib/static-gates.mjs
  - .agents/skills/lib/static-gates-comment-hygiene.mjs
  - .agents/skills/lib/feature-map.mjs
  - .agents/skills/lib/tdd-parity.mjs
  - .agents/skills/lib/gate-truth.mjs
  - .agents/skills/lib/profile.mjs
  - .agents/skills/dev-explore/scripts/repo-map.mjs
  - .agents/skills/dev-explore/scripts/repo-map-helpers.mjs
  - .agents/skills/dev-plan/scripts/triage-rules.mjs
  - .agents/skills/dev-plan/scripts/doc-plan.mjs
  - .agents/skills/dev-edit/scripts/edit-gate.mjs
  - .agents/skills/dev-govern/SKILL.md
  - .agents/skills/dev-govern/scripts/govern-audit.mjs
  - .agents/skills/dev-govern/scripts/govern-checks.mjs
  - .agents/skills/dev-govern/scripts/govern-checks-hygiene.mjs
  - .agents/skills/dev-govern/scripts/govern-docs.mjs
  - .agents/skills/dev-govern/scripts/govern-evergreen.mjs
  - .agents/skills/dev-govern/scripts/govern-retro.mjs
  - .agents/skills/dev-govern/scripts/govern-tests.mjs
  - .agents/skills/dev-verify-tools/scripts/verify-tools.mjs
  - .agents/skills/dev-iterate/scripts/iterate.mjs
  - scripts/dev/cli-parity.mjs
  - scripts/dev/preflight-suite.mjs
  - references/plugin-ecosystems.md
  - .github/changelog-voice-baseline.json
  - docs/TDD.md
  - README.md
  - README.en.md
  - scripts/dev/fixtures-w6b-kit-hygiene.mjs
  - scripts/dev/injections-data-w6b.mjs
high_risk_paths:
  - kit/
  - AGENTS.md
---

# Slice 6B：kit 单源化、去自用泄漏与门禁精度升级 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块重构、接口/契约变更或高风险改造；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / Issue / PR | 见 Frontmatter `branch` / #143 / 未关联 |
| 负责人 / 内审状态 | plan-w6 / `pending` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 PRD / Todo | `docs/prd/261122-issue143-w6-universal-architecture-prd.md` / `docs/todo/261122-issue143-w6b-kit-single-source-hygiene-todo.md` |

- **变更一句话**：将 `kit/` 子命令表与履历/墓碑词表收敛为唯一真源、清除全部本仓自用符号硬编码并加静态门禁、修准 `feature-map` / `repo-map` / `static-gates` / `dev-govern` 精度并同步文档与历史基线。

## 系统变更全景

```mermaid
flowchart LR
  Meta["单源元数据"] --> Tools["技能与门禁"]
  Tools --> Check["零自用与双语同步"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `kit/skills/lib/subcommand-meta.mjs`(new) & `kit/skills/dev-plan/scripts/triage-rules.mjs` & `scripts/dev/cli-parity.mjs` | 新增/改造 | 单源导出 `SUBCOMMAND_META`（`{ name, mutating }`），统一 6 套 CLI 与对拍校验 |
| `kit/skills/lib/doc-verify.mjs` & `kit/skills/lib/doc-facts.mjs` & `kit/skills/lib/doc-facts-commands.mjs`(new) | 改造/新增 | 复用 `COMMON_SKIP_DIRS`、通用多生态只读命令与目标仓 `Dev Profile` 核查，扩充多语言路径正则 |
| `kit/skills/lib/intake-triage.mjs` & `kit/skills/lib/evidence-substance.mjs` & `kit/skills/dev-edit/scripts/edit-gate.mjs` & `kit/skills/dev-govern/scripts/govern-tests.mjs` & `scripts/dev/preflight-suite.mjs` | 改造 | 清零 `kit/` 内本仓私有锚点/脚本名硬编码，并在 `preflight-suite.mjs` 新增零本仓私有符号静态门禁 |
| `kit/skills/lib/no-changelog-voice.mjs` & `kit/skills/lib/static-gates.mjs` & `.github/changelog-voice-baseline.json` | 改造 | 合并 `TOMBSTONE_COMMENT_RE` 与 `no-changelog-voice.mjs` 为单源词形引擎并清空历史债基线 |
| `kit/skills/lib/feature-map.mjs` & `kit/skills/dev-explore/scripts/repo-map.mjs` & `kit/skills/dev-explore/scripts/repo-map-helpers.mjs`(new) & `kit/skills/dev-govern/scripts/*` | 改造/拆分 | 提升同生态匹配、测试/视觉/VitePress/译文过滤精度；拆小 `govern-checks.mjs` 与 `repo-map.mjs` `<=800` 行 |
| `docs/TDD.md` & `README.md` & `README.en.md` & `kit/skills/dev-govern/SKILL.md` & `references/plugin-ecosystems.md` | 改造 | 消除易变计数、补齐 `scripts/zip.mjs`、修正 `SKILL.md` 路径与清理履历表述 |

## 一、背景与边界声明

- **要改什么**：`kit/skills/lib/`（不含 6A 的 `credential-scan.mjs`/`git-core.mjs`/`profile-sniffer*` 与 6C 的 `cli.mjs`/`workflow-policy*`/`escalation.mjs`/`*-template-hydrate.mjs`/`handoff-package.mjs`）、`dev-explore`/`dev-plan`/`dev-edit`/`dev-govern`/`dev-verify-tools`/`dev-iterate`、`.github/changelog-voice-baseline.json`、`docs/TDD.md`、`README*.md`、`scripts/dev/{cli-parity,preflight-suite}.mjs`。
- **不改什么**：不碰 `scripts/`（除 `scripts/dev/` 测试与门禁）、`templates/`、`kit/skills/dev-flow/`、`kit/skills/dev-review/`、`docs/feature-map.json`（均属 6A 或 6C 写域）；其中 `flow.mjs` 与 `review-pack.mjs` 对 `SUBCOMMAND_META` 的导入消费留待 6C 合入（本片先确保 `SUBCOMMAND_META` 定义覆盖全部 6 套且 `cli-parity.mjs` 强制核对 6 套清单一致）。
- **本期不做**：不重写 `dev-flow` 状态机，不修改 `handoff.mjs` 与 `survey*.mjs`。
- **复用既有模块**：复用 6A 已完善的 `COMMON_SKIP_DIRS`、`CODE_EXT_RE`、`BROAD_CODE_EXT_RE`（`kit/skills/lib/git-core.mjs`），复用 `static-gates-lexer.mjs` 的 `buildLexedViews` 剥离字面量与提取注释。
- **架构基线关系**：严格遵循 `kit/` 自包含与零本仓私有符号边界，全部 `.mjs` `<= 800` 行，并执行 `node scripts/equip.mjs .` 保持 `.agents/skills/` 一致（依据：`docs/TDD.md`）。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **单源子命令元数据 `SUBCOMMAND_META`（`kit/skills/lib/subcommand-meta.mjs`(new)、`doc-plan.mjs`、`govern-audit.mjs`、`verify-tools.mjs`、`iterate.mjs`、`doc-verify.mjs`、`triage-rules.mjs`、`scripts/dev/cli-parity.mjs`）**：
   - 新建 `kit/skills/lib/subcommand-meta.mjs`(new)，单源定义 6 套核心 CLI（`flow`、`doc-plan`、`govern-audit`、`review-pack`、`verify-tools`、`iterate`）的子命令元数据表 `SUBCOMMAND_META`：每条记录含 `{ name, mutating }`（例如 `flow` 含 `inspect(false)`/`next(false)`/`status(false)` 及 `start`/`claim`/`finalize`/`verify`/`submit`/`merge`/`cleanup`/`intake`/`issue`/`close`/`milestone` 等 `mutating: true`）。
   - 导出辅助函数：`subcommandNamesFor(toolKey)`、`mutatingSubcommandsFor(toolKey)`、`allSubcommandNames()`。
   - `doc-plan.mjs`、`govern-audit.mjs`、`verify-tools.mjs`、`iterate.mjs` 直接导入 `subcommandNamesFor(...)`（6C 再接入 `flow.mjs` 与 `review-pack.mjs`）。
   - `doc-verify.mjs` 消费 `mutatingSubcommandsFor('flow')` / `mutatingSubcommandsFor('doc-plan')` 替代硬编码正则，精确拒绝全部状态变更子命令。
   - `triage-rules.mjs` 的 `TOOL_PREFIX_RE` 与 `CLI_SUBCOMMAND_RE` 消费 `allSubcommandNames()` 动态构造正则（保留既有辅助动词如 `check`/`create`/`restore`）。
   - `scripts/dev/cli-parity.mjs` 新增子命令对拍检查：校验 6 套脚本源码中声明的子命令数组、`printHelp()` 帮助列举与 `usageHint` 同 `SUBCOMMAND_META` 100% 匹配，并校对本片内脚本的文件头注释与帮扶行一致（如 `iterate.mjs` 帮助行补齐 `cycle`）。

2. **多生态文档事实与命令核查（`kit/skills/lib/doc-verify.mjs`、`kit/skills/lib/doc-facts.mjs`、`kit/skills/lib/doc-facts-commands.mjs`(new)）**：
   - `doc-verify.mjs` 的 `readCodebase` 改用 `COMMON_SKIP_DIRS` 集合（含 `.git`、`.worktrees`、`node_modules`、`target`、`.venv` 等）叠加 `docs/archive/`，替代写死的 JS 目录列表。
   - 拆出命令只读判定至 `kit/skills/lib/doc-facts-commands.mjs`(new)：`checkCommandClaim` 与 `CMD_RE` 支持通用多生态只读命令（如 `node`/`python`/`pytest`/`cargo`/`go`/`dotnet`/`mvn`/`gradle`/`uv`/`deno`/`bun`/`pnpm`/`yarn`/`npm`/`make`/`just`/`git` 只读检查及目标仓 `AGENTS.md` `## Dev Profile` 配置的只读/验证命令），同时拒绝带写入/删除/推远端副作用标志的命令（如 `--fix`、`--apply`、`--confirm`、`--force`、`push`、`install`、`publish`、`rm`）。
   - `doc-facts.mjs` 扩充 `PATH_RE` 支持多语言工程扩展名（`.rs`、`.go`、`.py`、`.java`、`.kt`、`.cs`、`.fs`、`.csproj`、`.slnx`、`.sln`、`.swift`、`.dart`、`.cpp`、`.h`、`.hpp`、`.vue`、`.svelte`、`.tsx`、`.jsx`、`.sh`、`.ps1` 等）。

3. **彻底清零 `kit/` 本仓自用泄漏并新增静态门禁（`intake-triage.mjs`、`evidence-substance.mjs`、`edit-gate.mjs`、`govern-tests.mjs`、`scripts/dev/preflight-suite.mjs`）**：
   - `intake-triage.mjs` 重构 `evaluateNonGoalsAndRedlines(repoRoot, combinedText, featureRef)`：改为动态读取目标仓 `AGENTS.md` 与 `resolveAuthoritativeTddPath(repoRoot)` 解析到的权威设计文档，从中提取「明确非目标 / Non-Goals / 不做」与「红线 / 关键不变量」条目进行通用语义匹配，移除所有本仓专属硬编码规则（零第三方依赖/不绑定 AI 宿主/禁 emoji/不生成业务代码）与本仓固定锚点（`SKILL.md#`、`docs/TDD.md#技术基线与运行约束`）。
   - `edit-gate.mjs`（467 行）与 `govern-tests.mjs`（133 行）删除 `verify-injections|gap-coverage` 本仓专有文件名特判，改为通用的夹具/测试生成器结构识别（`FIXTURE_FILE_RE` 与测试生成辅助特征）。
   - `evidence-substance.mjs` 替换提示示例中的 `node scripts/survey.mjs . --json` 为通用占位示例（如 `npm test -- --run` 或通用命令示例）。
   - `scripts/dev/preflight-suite.mjs` 新增静态门禁：扫描 `kit/` 下全部 `.mjs` 与 `.md`，拦截除 `project-forge-flow` / `project-forge-govern` / `project-forge-verify` / `project-forge:` 协议命名空间之外的本仓私有脚本/锚点硬编码（如 `verify-injections`、`gap-coverage`、`scripts/survey.mjs`、`技术基线与运行约束`、`明确非目标` 固定锚点等）。

4. **单源履历/墓碑词形引擎与文档事实同步（`kit/skills/lib/no-changelog-voice.mjs`、`kit/skills/lib/static-gates.mjs`、`doc-verify.mjs`、`gate-truth.mjs`、`profile.mjs`、`tdd-parity.mjs`、`references/plugin-ecosystems.md`、`.github/changelog-voice-baseline.json`、`docs/TDD.md`、`README.md`、`README.en.md`、`kit/skills/dev-govern/SKILL.md`）**：
   - 将 `TOMBSTONE_COMMENT_RE` 与 `no-changelog-voice.mjs` 合并为单源词形引擎：在 `no-changelog-voice.mjs` 导出 `CHANGELOG_VOICE_TOMBSTONE_RE` / `findChangelogVoice`（支持词形覆盖 `原来`、`以前`、`早先`、`曾经`、`过去是`、`老版本`、`旧版本`、`以前是` 等，结合语境豁免规则举例与现状标题），`static-gates.mjs` 直接复用该单源正则，不再各自维护分裂词表。
   - 在检查 `.mjs` 文件时先经 `buildLexedViews(text, 'mjs')` 剥离字符串字面量，仅对真实注释行（`commentLines`）运行履历/墓碑扫描，彻底清除 `doc-verify.mjs:12`、`gate-truth.mjs:6`、`profile.mjs:289`、`tdd-parity.mjs:24`、`references/plugin-ecosystems.md:31` 等存量履历表述，并将 `.github/changelog-voice-baseline.json` 清零为 `{}`。
   - 同步常青文档事实：
     - `docs/TDD.md` 移除易变脚本/模块精确计数（如 `共 81 个 .mjs 模块`、`共 49 个脚本`、`10 个入口`、`33 个模块` 等），改为稳定的层级结构表述；
     - `README.md` 与 `README.en.md` 补齐 `scripts/zip.mjs`（含双语同步校验）；
     - `kit/skills/dev-govern/SKILL.md:83` 修正缺失前缀的 `edit-gate.mjs` 相对路径为 `.agents/skills/dev-edit/scripts/edit-gate.mjs`。

5. **提高 `feature-map` / `repo-map` / `static-gates` / `dev-govern` 精度与模块拆分**：
   - `kit/skills/lib/feature-map.mjs`：`prefillFeatureMapFromRepoMap` 匹配测试文件时不再使用裸 `t.toLowerCase().includes(stem.toLowerCase())`，改为**同生态边界 + 完整文件名/路径段词边界**匹配（例如 `.ts/.tsx` 源码只关联同生态 JS/TS 测试，绝不把 `App.tsx` 误绑到 `apply_test.go`），同时过滤 `dist/`、`.github/workflows/`、`*.test.*`、`.agents/` 作为功能入口。
   - `kit/skills/dev-explore/scripts/repo-map.mjs`（761 行）：拆出辅助解析/流程构造至 `kit/skills/dev-explore/scripts/repo-map-helpers.mjs`(new)；扫描与入口发现过滤 `dist/`、`.github/workflows/*.yml`、`.agents/` 与测试文件。
   - `kit/skills/lib/static-gates.mjs`：判断视觉变更文件时显式排除测试文件（`UI_VISUAL_EXT_RE.test(f) && !isTestOrFixtureFile(f)`）；`TEST_CASE_RE` 收窄避免匹配正则方法调用如 `re.test(file)`（要求 `test` 前不为 `.` 成员访问，即 `(?<![.\w$])`）。
   - `kit/skills/dev-govern/scripts/govern-audit.mjs`：`--save-baseline --quiet` 组合时不再因 `opts.quiet` 跳过 `tests` 与 `perf` 类别，确保保存基线全量客观完整；`reconcile` 默认联动调用 `verify-tools` 过时与完整性核查（或内联复用 `feature-map.mjs` / `verify-tools-audit.mjs` 检查工具过期并输出告警）。
   - `kit/skills/dev-govern/scripts/govern-docs.mjs`：Markdown 死链与常规文档检查跳过译文目录 `docs/{lang}/`（标准 BCP-47 双/四字母译文目录）避免误报相对锚点或翻译对照差异。
   - `kit/skills/dev-govern/scripts/govern-evergreen.mjs`：解析反引号/Markdown 路径时识别 VitePress 根路由（如 `/guide/...` 映射到 `docs/guide/...` 或配置 `srcDir`）及子包相对路径（相对于当前常青文档所在子包目录解析），减少 monorepo 文档误报。
   - `kit/skills/dev-govern/scripts/govern-checks.mjs`（773 行）：拆出工作树与清单/卫生辅助至 `kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`(new)；`auditHygiene` 检查未忽略输出目录 `build/` 时，若 `build/` 为纯 Git 跟踪源码目录（含被 Git 跟踪文件且无未跟踪产物，如 Go/Rust/Zig/自研 `build/` 源码包），跳过不误报 `hygiene.unignored-dir.build`。
   - `kit/skills/dev-govern/scripts/govern-retro.mjs`：与 `reconcile` / `verify-tools` 协同收敛（不触及 6C 文件）。

6. **`<= 800` 行结构门禁通用边界升级（`C19`）**：
   - 将通用文件级结构分类辅助拆入 `kit/skills/lib/static-gates-comment-hygiene.mjs`（当前 108 行，为 `static-gates.mjs` 692 行保留充足余量），并由 `kit/skills/lib/static-gates.mjs`（`scanStructuralHygiene`）与 `kit/skills/dev-edit/scripts/edit-gate.mjs` 统一消费（**禁止按框架或工具文件名硬编码特判**）：
     - **跨语言自动生成源码豁免**：读取源码前 20 行并识别跨语言通用自动生成头部标记（涵盖 `Code generated by ... DO NOT EDIT`、`@generated`、`AUTO-GENERATED`、`DO NOT EDIT`、`This file was automatically generated` 等标准通用标记；必须位于前 20 行真实注释头部而非普通代码字符串/尾部注释），命中后豁免 `godFile` / `nearLimitFile` / 履历墓碑 / 注释死代码告警与阻断；同时在 `scripts/dev/preflight-suite.mjs` 保留对本仓 `kit/` 脚本的 800 行硬检（`kit/` 脚本自身不接受自动生成豁免绕过）；
     - **纯声明式数据源码降级**：基于词法剥离后的真实 Token 特征（极高字面量/对象键值对占比、极低控制流关键字与函数分支密度，而非文件扩展名或表名硬编码）判定纯表驱动/纯声明式数据源码（如路由映射表、静态 i18n 字典、正则规则数据表）；此类文件超 800 行时在 `edit-gate.mjs` 不以 `edit.file-oversized` 硬阻断，改为输出 warning / 拆表建议放行；混杂真实业务逻辑与多分支控制流的 `> 800` 行神文件及故意塞入大段注释/假空表的混合文件仍严格阻断。

### 数据与状态变更

- `.github/changelog-voice-baseline.json` 归零为 `{}`。
- `SUBCOMMAND_META` 作为 `kit/skills/lib/subcommand-meta.mjs`(new) 随套件分发入 `.agents/skills/lib/subcommand-meta.mjs`(new)。

### 异常、回退与安全边界

- `doc-verify.mjs` 对未知命令（非白名单只读工具及未通过只读参数校验的命令）保持 `ran: false` 不执行，绝不因扩大生态支持而引入写副作用。
- `preflight-suite.mjs` 新增零本仓私有符号门禁时，明确豁免协议命名空间前缀（`project-forge:`、`project-forge-flow`、`project-forge-govern`、`project-forge-verify`、`pf-`）及历史迁移兼容键名，防止误杀合法协议代码。

### 实现顺序

1. 新建 `kit/skills/lib/subcommand-meta.mjs`(new) 并更新 `doc-plan.mjs`、`govern-audit.mjs`、`verify-tools.mjs`、`iterate.mjs`、`triage-rules.mjs`、`scripts/dev/cli-parity.mjs`。
2. 新建 `kit/skills/lib/doc-facts-commands.mjs`(new)，升级 `doc-verify.mjs` 与 `doc-facts.mjs`；合并 `no-changelog-voice.mjs` 与 `static-gates.mjs` 单源词形引擎并修复 `TEST_CASE_RE` / `UI_VISUAL_EXT_RE`。
3. 清理 `intake-triage.mjs`、`evidence-substance.mjs`、`edit-gate.mjs`、`govern-tests.mjs` 的本仓自用泄漏，在 `scripts/dev/preflight-suite.mjs` 加静态门禁；清零存量履历注释与 `.github/changelog-voice-baseline.json`。
4. 升级 `feature-map.mjs`、拆分 `repo-map-helpers.mjs`(new) 与 `govern-checks-hygiene.mjs`(new)，完成 `govern-audit.mjs`、`govern-docs.mjs`、`govern-evergreen.mjs`、`govern-checks.mjs`、`govern-retro.mjs` 精度提升；在 `static-gates-comment-hygiene.mjs`、`static-gates.mjs` 与 `edit-gate.mjs` 落地 `C19` 跨语言自动生成源码豁免与纯声明式数据源码降级。
5. 同步 `docs/TDD.md`、`README.md`、`README.en.md`、`kit/skills/dev-govern/SKILL.md`、`references/plugin-ecosystems.md`；运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`；编写 `scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new) 与 `scripts/dev/injections-data-w6b.mjs`(new) 并跑通全量门禁。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 继续在 `.github/changelog-voice-baseline.json` 累加豁免计数 | 保持旧履历词条并把新发现的 `.mjs` 注释计入基线数字 | 债务永远不清零且 `TOMBSTONE_COMMENT_RE` 与文档规则持续分裂 | 永不保留分裂基线 |
| 在 `feature-map.mjs` 按硬编码后缀特判排除 `.go` | 写死 `if (src.endsWith('.tsx') && t.endsWith('.go')) skip` | 遇到 Python/Rust/Java 交叉照样误匹配 | 必须使用通用同生态映射与路径词边界 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/subcommand-meta.mjs`(new) & `doc-plan.mjs` & `govern-audit.mjs` & `verify-tools.mjs` & `iterate.mjs` & `triage-rules.mjs` & `scripts/dev/cli-parity.mjs` | 新增/修改 | 单源 `SUBCOMMAND_META`、帮扶/头注释/正则与对拍门禁 | 全部 6 套 CLI 与分流器 |
| `kit/skills/lib/doc-verify.mjs` & `doc-facts.mjs` & `doc-facts-commands.mjs`(new) | 修改/新增 | `COMMON_SKIP_DIRS`、通用多生态只读命令与路径扩展名扩充 | `doc-plan audit` 机械核实 |
| `kit/skills/lib/intake-triage.mjs` & `evidence-substance.mjs` & `edit-gate.mjs` & `govern-tests.mjs` & `scripts/dev/preflight-suite.mjs` | 修改 | 清零 `kit/` 本仓私有泄漏并加静态门禁 | 外部仓分诊、改码与测试体检 |
| `kit/skills/lib/no-changelog-voice.mjs` & `static-gates.mjs` & `static-gates-comment-hygiene.mjs` & `gate-truth.mjs` & `profile.mjs` & `tdd-parity.mjs` & `.github/changelog-voice-baseline.json` & `references/plugin-ecosystems.md` | 修改 | 单源词形引擎（剥离字面量查注释）、清零存量履历债、跨语言生成文件豁免与纯声明式数据降级（`C19`） | 静态卫生、800 行门禁与常青文档检查 |
| `kit/skills/lib/feature-map.mjs` & `repo-map.mjs` & `repo-map-helpers.mjs`(new) & `govern-*.mjs` | 修改/新增 | 同生态/边界匹配、过滤产物目录、VitePress/译文/`build/`源码/基线静默修复、`<=800` 行拆分 | 探索地图与治理体检 |
| `docs/TDD.md` & `README.md` & `README.en.md` & `kit/skills/dev-govern/SKILL.md` & `.agents/skills/**` & `scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new) & `scripts/dev/injections-data-w6b.mjs`(new) | 修改/新增 | 文档事实同步、`.agents/skills/` 同步与正反双向夹具/故障注入 | 双语文档与全量门禁 |

- **对外可见的变化**：`kit/` 不再泄漏 `project-forge` 私有符号；`govern-audit --save-baseline --quiet` 保存完整基线；`feature-map` / `repo-map` / `static-gates` 消除跨生态误绑与 `.test(` 误报。
- **需要同步改的地方**：必须运行 `node scripts/equip.mjs .` 保持 `.agents/skills/` 与 `kit/skills/` 字节一致，同步运行 `node scripts/sync-toc.mjs README.md README.en.md --check`。

## 五、冻结的验收标准

- [ ] C7: 单源导出 `SUBCOMMAND_META`（`{ name, mutating }`），统一 `doc-plan.mjs`、`govern-audit.mjs`、`verify-tools.mjs`、`iterate.mjs`、`doc-verify.mjs`、`triage-rules.mjs` 与 `scripts/dev/cli-parity.mjs` 子命令清单及对拍检查（`node scripts/dev/cli-parity.mjs` 退出 `0`）。
- [ ] C8: `kit/skills/lib/doc-verify.mjs` 与 `kit/skills/lib/doc-facts.mjs` 复用 `COMMON_SKIP_DIRS`、通用多生态只读命令与目标仓 `Dev Profile` 替代 `node|npm|npx|git` 硬编码，扩充多语言后缀识别。
- [ ] C9: 清零 `kit/` 中全部 `project-forge` 自用逻辑与示例（`intake-triage.mjs` 动态读取目标仓 `AGENTS.md` 与权威文档、`edit-gate.mjs` 与 `govern-tests.mjs` 去掉 `verify-injections|gap-coverage` 硬编码、`evidence-substance.mjs` 等清理），在 `scripts/dev/preflight-suite.mjs` 新增零本仓私有符号静态门禁并通过扫描。
- [ ] C10: 合并 `TOMBSTONE_COMMENT_RE` 与 `kit/skills/lib/no-changelog-voice.mjs` 为单源词形引擎（剥离字面量后同步查 `.mjs` 注释），清零 `doc-verify.mjs`、`gate-truth.mjs`、`profile.mjs`、`tdd-parity.mjs`、`references/plugin-ecosystems.md` 等存量履历注释并清空 `.github/changelog-voice-baseline.json` 为 `{}`；同步 `docs/TDD.md`（去易变计数）、`README.md` / `README.en.md`（补 `scripts/zip.mjs`）与 `kit/skills/dev-govern/SKILL.md`。
- [ ] C11: 提高 `feature-map.mjs`、`repo-map.mjs`、`static-gates.mjs` 与 `dev-govern` 精度（同生态与路径边界匹配、过滤 `dist/`/`.github/workflows/`/`*.test.*`/`.agents/`、`TEST_FILE_RE` 不触发 `UI_VISUAL_EXT_RE`、`TEST_CASE_RE` 排除 `.test(`、`govern-audit --save-baseline --quiet` 不跳过 `tests`/`perf`、`reconcile` 联动 `verify-tools audit`、`govern-docs` 跳过译文 `docs/<lang>/`、`govern-evergreen` 识别 VitePress 根路由与子包路径、`govern-checks` 跳过纯跟踪源码目录 `build/`）；全部新增/修改 `.mjs` `<= 800` 行。
- [ ] C12: Slice 6B 新增正反双向夹具（`scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6b.mjs`(new)），运行 `node scripts/equip.mjs .` 后，`node scripts/equip.mjs . --check`、`node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs --jobs 6`、`node scripts/dev/verify-injections.mjs --jobs 4` 与 `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict` 全绿。
- [ ] C19: 在 `kit/skills/lib/static-gates.mjs`（`scanStructuralHygiene`）、`kit/skills/lib/static-gates-comment-hygiene.mjs` 与 `kit/skills/dev-edit/scripts/edit-gate.mjs` 补齐 `<= 800` 行门禁两类误拦边界（禁按框架文件名硬编码）：(1) 跨语言自动生成源码豁免（识别前 20 行标准自动生成头标后免检 `godFile` / `nearLimitFile` / 履历墓碑 / 注释死代码，同时保留 `scripts/dev/preflight-suite.mjs` 对本仓 `kit/` 脚本的 800 行硬检）；(2) 纯声明式数据源码降级（高字面量占比、极低控制流密度的纯表驱动文件不以 `edit.file-oversized` 硬阻断而改为 warning/结构提示放行，真实混杂业务逻辑的 `>800` 行神文件仍严格拦截，并配双向正反测试防注释/假表绕过）。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`two-way`；回滚做法：在隔离分支执行 `git revert <commit>` 即可回退全部改造并恢复 `.agents/skills/`。
- **高风险路径**：触及 `kit/` 与 `AGENTS.md`（实际不动 `AGENTS.md` 受管区，仅校验）高风险路径，须独立审查 + 两阶段故障注入。
- **故障注入预演**：在 `scripts/dev/injections-data-w6b.mjs`(new) 注入破坏 `SUBCOMMAND_META` 一致性、注入向 `kit/` 泄漏私有符号、破坏同生态测试匹配、破坏 `.test(` 排除规则及关闭/放松 `C19` 假表混入业务逻辑拦截，跑 `node scripts/dev/verify-injections.mjs --only W6B` 验证变红捕获。

## 澄清与补充记录

- 已定（2026-11-22）：`flow.mjs` 与 `review-pack.mjs` 由 6C 接入 `SUBCOMMAND_META` 单源并同步 `flow.mjs` 头注释，确保 6B 与 6C 零文件重叠；`protocol.mjs` 由 6A 独占清理。

## 实现说明

> 代码合入前补齐，随功能 PR 一同提交并标记 `implemented`；若常青架构已同步进 `docs/TDD.md`，随关联 `PRD`/`Todo` 成对归档至 `docs/archive/specs/`。

- **实际落地摘要**：待实施后填写
- **与草案的差异**：待实施后填写
- **关联同步文件**：待实施后填写
