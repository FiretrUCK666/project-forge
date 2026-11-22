---
kind: spec
title: Slice 6A：通用 S1 勘察、多生态发现与长青交棒合同
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
related_todo: ../todo/261122-issue143-w6a-survey-handoff-core-todo.md
task_id: w6a-survey-handoff-core
depends_on: []
scope_files:
  - scripts/survey.mjs
  - scripts/backup.mjs
  - scripts/handoff.mjs
  - scripts/review.mjs
  - scripts/compose-agents.mjs
  - scripts/equip.mjs
  - scripts/lib/protocol.mjs
  - scripts/lib/text.mjs
  - scripts/lib/render.mjs
  - scripts/lib/survey-docs.mjs
  - scripts/lib/survey-gap-rules.mjs
  - scripts/lib/survey-ecosystem.mjs
  - scripts/lib/survey-workspace.mjs
  - scripts/lib/survey-workspace-secrets.mjs
  - scripts/lib/agents-defaults.mjs
  - scripts/lib/equip-bootstrap.mjs
  - scripts/lib/compose-agents-helpers.mjs
  - templates/agents-project.md
  - kit/skills/lib/credential-scan.mjs
  - kit/skills/lib/git-core.mjs
  - kit/skills/lib/profile-sniffer.mjs
  - kit/skills/lib/profile-sniffer-packages.mjs
  - .agents/skills/lib/credential-scan.mjs
  - .agents/skills/lib/git-core.mjs
  - .agents/skills/lib/profile-sniffer.mjs
  - .agents/skills/lib/profile-sniffer-packages.mjs
  - scripts/dev/fixtures-w6a-survey-handoff.mjs
  - scripts/dev/fixtures-flow-parallel.mjs
  - scripts/dev/injections-data-w6a.mjs
high_risk_paths:
  - scripts/lib/
  - templates/
  - kit/
---

# Slice 6A：通用 S1 勘察、多生态发现与长青交棒合同 — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块重构、接口/契约变更或高风险改造；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / Issue / PR | 见 Frontmatter `branch` / #143 / 未关联 |
| 负责人 / 内审状态 | plan-w6 / `pending` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 PRD / Todo | `docs/prd/261122-issue143-w6-universal-architecture-prd.md` / `docs/todo/261122-issue143-w6a-survey-handoff-core-todo.md` |

- **变更一句话**：将 S1 只读勘察、多生态与工作区发现、Linter 隔离、大容量备份读取、交棒净度校验、凭据正文扫描及受管 `AGENTS.md` 模板体积与保真能力重构为通用结构化实现，彻底消除跨文件/跨生态误报与 AI 指导语泄漏。

## 系统变更全景

```mermaid
flowchart LR
  Scan["工作区扫描"] --> Judge["结构化判定"]
  Judge --> Out["勘察与交棒报告"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `scripts/lib/survey-docs.mjs` & `scripts/lib/survey-gap-rules.mjs` & `scripts/review.mjs` | 改造 | 按工作流文件+job 粒度结构化判定 `pull_request_target`、现代发布模式、hooks 与 `secrets-are-placeholders` |
| `scripts/lib/survey-ecosystem.mjs` & `kit/skills/lib/profile-sniffer.mjs` & `kit/skills/lib/profile-sniffer-packages.mjs`(new) | 改造/拆分 | 支持 `.slnx`、`jsr.json`/`deno.json`、`pnpm-workspace.yaml` 继承与 `!` 负向 glob、修复 `Benchmarks`/`MinVer` 与子包拆分 `<=800` 行 |
| `scripts/survey.mjs` & `scripts/equip.mjs` & `scripts/lib/render.mjs` | 改造 | `survey()` 严格零写入、探测根 Linter/Formatter 输出 `.agents/` 忽略隔离方案 |
| `scripts/backup.mjs` & `kit/skills/lib/git-core.mjs` & `scripts/lib/text.mjs` | 改造 | `readTextSafe` 支持无上限/大体积 `index.json` 读取与负向 glob 匹配 |
| `scripts/handoff.mjs` | 改造 | 豁免锁文件、大数据非工程文件及有意软链不计入 `truncated`，区分 `--upgrade` 与 `--strict-clean` |
| `kit/skills/lib/credential-scan.mjs` & `scripts/lib/survey-workspace.mjs` & `scripts/lib/survey-workspace-secrets.mjs`(new) | 改造/拆分 | 识别 `${...}` 动态 PEM 模板字面量、扫描 `.env*` 夹具、跳过跟踪与 `!` 放行输出目录并拆小控制行数 |
| `templates/agents-project.md` & `scripts/lib/agents-defaults.mjs` & `scripts/lib/equip-bootstrap.mjs` & `scripts/compose-agents.mjs` & `scripts/lib/compose-agents-helpers.mjs`(new) & `scripts/lib/protocol.mjs` | 改造/拆分 | 受管空骨架瘦身至 `< 16KB`、清零指导语泄漏、保留小写 `agents.md` / 软链指向并拆小模块 `<=800` 行 |

## 一、背景与边界声明

- **要改什么**：改造 `scripts/` 勘察/备份/交付/装配/合成入口及 `templates/agents-project.md`，并升级共享底层原语 `kit/skills/lib/credential-scan.mjs`、`kit/skills/lib/git-core.mjs`、`kit/skills/lib/profile-sniffer.mjs`（同步 `.agents/skills/`）。
- **不改什么**：不碰 `kit/skills/dev-flow/`、`kit/skills/dev-review/`、`kit/skills/dev-govern/` 等 6B/6C 专有文件，不修改 `docs/TDD.md`、`README*.md`、`docs/feature-map.json`。
- **本期不做**：不新增 GitHub 之外的远端 API 适配器，不自动安装外部 linter 二进制或自动修改仓库第三方 linter 配置文件（仅只读探测并输出 `.agents/` 忽略方案）。
- **复用既有模块**：复用 `kit/skills/lib/credential-scan.mjs`（单源凭据扫描）、`kit/skills/lib/git-core.mjs`（`matchGlob`、`readTextSafe`、`COMMON_SKIP_DIRS`）、`scripts/lib/protocol.mjs`（`TEMPLATE_VARS` 与标记解析）、`scripts/lib/template.mjs`（模板渲染）。
- **架构基线关系**：保持 `scripts/` 与 `kit/` 零第三方依赖不变量、S1 `survey()` 零写入不变量与全部 `.mjs` 文件 `<= 800` 行红线（依据：`docs/TDD.md`）。

## 二、设计方案与契约变更

### 接口 / 数据结构变更

1. **工作流 Job 级 PR Target 与现代发布/Hook 探测（`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/review.mjs`）**：
   - 新增结构化工作流分析函数 `analyzeWorkflowSecurity(workflowsDir, files)`：按工作流文件及 `jobs` 分块解析触发器与 step：
     - 仅当同一工作流触发 `pull_request_target` **且**同一文件/job 内存在不安全 PR 代码检出（如 `actions/checkout` `ref:` 引用 `github.event.pull_request.head.sha` / `github.event.pull_request.head.ref` / `refs/pull/${{ github.event.pull_request.number }}/merge` 等）且未标注 `# zizmor: ignore[dangerous-triggers]` 时，才置位 `workflowFacts.unsafePullRequestTargetWorkflows`（保留 `usesPullRequestTarget` 与 `checkoutsPrHead` 派生兼容字段，仅当存在至少一条真实命中时两者同真）。
     - 单独引用 `github.event.pull_request.number`（如评论/标签/元数据 API 调用）而未用于检出代码时**豁免**，不判定为 `checkoutsPrHead`。
   - `RELEASE_WORKFLOW_PATTERNS` 扩充现代发布命令：`uv publish`、`dotnet ... publish`（含 `dotnet nuget push` / `dotnet publish`）、`jsr publish` / `deno publish`、`vp pack` / `vite-plus pack`。
   - `detectGitHooksState` 扩展探测 `simple-git-hooks`（`package.json` `simple-git-hooks` 字段或 `.simple-git-hooks` 等配置文件）以及受管于 `.git/hooks/*` 的非空自定义钩子文件（排除 `.sample` 示例）。

2. **多生态、Workspace 继承与负向 Glob（`scripts/lib/survey-ecosystem.mjs`、`kit/skills/lib/git-core.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`kit/skills/lib/profile-sniffer-packages.mjs`(new)、`scripts/lib/agents-defaults.mjs`）**：
   - 将 `profile-sniffer.mjs`（788 行）中的工作区包发现与多语言清单解析拆出至 `kit/skills/lib/profile-sniffer-packages.mjs`(new)，主文件控制在 500 行内。
   - 清单与生态扩充：
     - `.NET`：同时识别 `.slnx` 与 `.sln` / `.csproj`；`dotnet test` 仅在明确测试工程（`*.Tests.csproj` / `*Tests.csproj` / 含 `xunit|nunit|mstest|Microsoft.NET.Test.Sdk` 引用）成立时推荐，排除 `Benchmarks` 目录或纯基准工程误选 `dotnet test`；若仓库采用 `MinVer`（`Directory.Build.props` / `.csproj` 含 `MinVer` 或 tag 驱动版本），版本源保留 `MinVer / Git tag` 语义不被无版本号 `*.csproj` 覆盖。
     - `Deno / JSR`：识别 `jsr.json` / `jsr.jsonc` / `deno.json` / `deno.jsonc`（提取 `name`、`version`、`exports`、`tasks`、`publishable`）。
   - `parseYamlWorkspaceGlobs` 与 `detectWorkspace`：支持读取 `pnpm-workspace.yaml` 与子包继承、完整保留并求值 `!` 负向排除模式（在 `git-core.mjs` 提供带 `!` 排除序列求值的辅助函数 `matchGlobList(path, patterns)`），且要求匹配目录必须真实满足 `hasManifest` 边界，消除目录树误匹配引发的 80 子包爆炸；`detectWorkspace` 结果上限与过滤保持精确一致。

3. **根 Linter/Formatter 探测与 `survey()` 严格零写入（`scripts/survey.mjs`、`scripts/equip.mjs`、`scripts/lib/render.mjs`、`kit/skills/lib/profile-sniffer.mjs`）**：
   - 在 `profile-sniffer.mjs` 新增/扩展 `detectOptionalNativeCheckers`：识别根 `oxlint`（`.oxlintrc.json` / `oxlint.config.*` / `package.json#oxlint`）、`oxfmt`（`.oxfmtrc*` / `oxfmt.config.*`）、`biome`、`eslint`、`dprint`（`dprint.json` / `dprint.jsonc`）、`ruff`、`tsc`，返回结构化 `.agents/` 忽略隔离建议（`agentIgnoreAdvice`：指出对应工具的 ignore 字段或 `.eslintignore` / `biome.json#files.ignore` / `.oxlintrc.json#ignorePatterns` / `dprint.json#excludes` 建议跳过 `.agents/`）。
   - `survey.mjs` 彻底移除 `recordStepStateSafe(root, { step: 'S1', ... })` 写操作，确保 `survey()` 在任何仓内执行均**零文件写入**（不写入 `.git/project-forge-flow/session-state.json`）。`equip.mjs` 输出装配摘要时附带根 Linter `.agents/` 忽略隔离提示。

4. **Backup 无上限读取与 Handoff 净度分级（`scripts/backup.mjs`、`scripts/lib/text.mjs`、`scripts/handoff.mjs`）**：
   - `git-core.mjs` 的 `readTextSafe(filePath, maxBytes = 512 * 1024)` 保持默认安全限同时支持传入 `Infinity`（或新增 `readJsonSafe(filePath, maxBytes)`），`scripts/backup.mjs` 在读写备份索引 `index.json` 时显式取消 512KB 读取截断上限并精简冗余条目元数据，确保大仓任意体积 `index.json` 可完整 `list` / `restore`。
   - `scripts/handoff.mjs` 重构 `--verify` 覆盖与净度判定：
     - `walk(root)` 显式跳过锁文件（`*-lock.*`、`*.lock` 及 `LOCKFILE_NAMES`）、非工程大数据静态文件（`.svg`/`.map`/`.min.*`/静态数据资产超过 `MAX_BYTES` 不再置位 `truncated = true`）及合法/有意符号链接（如指向仓内或依赖目录的已知软链不计入 `truncated` 退出码 `3`，仍记录于 `scanCoverage` 统计字段）。
     - 新增 `--strict-clean` 开关并明确受管态契约：当仓库存在有效 `.agents/skills/.pf-manifest.json` 且未传入 `--strict-clean` 时，持续 `--upgrade` 受管态的 `AGENTS.md` 受管区间标记（`begin`/`end`）不导致 `--verify` 返回退出码 `1`（仅报告未填 `fill`、残留 `.tmp-*` 与悬空内部指针）；传入 `--strict-clean` 时要求彻底剥离全部标记（返回 `1`）。

5. **凭据正文精确判定与 `git.output-dirs` 放行修复（`kit/skills/lib/credential-scan.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-workspace-secrets.mjs`(new)、`scripts/review.mjs`）**：
   - 将 `survey-workspace.mjs`（722 行）的凭据/泄露/输出目录判定拆出至 `scripts/lib/survey-workspace-secrets.mjs`(new)，保持两文件各自 `< 550` 行。
   - `credential-scan.mjs`：
     - 识别模板字面量中的动态 PEM 构造（如 `` `-----BEGIN ${type} PRIVATE KEY-----` `` 或含 `${...}` 插值的字符串），不再误报为真实私钥块；
     - 正文扫描扩展覆盖 `.env*`（非 `.env.example`/`.sample`/`.template`/`.defaults`）测试夹具目录或文件，结合正文命中真实秘钥与 `classifyEnvFixture` 区分无害占位符与真实凭据；
     - `review.mjs` 为 `secrets.tracked` 与 `secrets.exposed` **统一接入** `decision: 'secrets-are-placeholders'`（允许用户在 `AGENTS.md`「取舍」声明确认为占位/测试数据时同时消解两条提示）。
   - `survey-workspace.mjs` / `survey-workspace-secrets.mjs`(new)：计算 `unignoredOutputDirs` 时，若目录下所有真实存在的文件均受 Git 跟踪，或目录/文件被 `.gitignore` `!` 负向规则显式放行（如 `!dist/`、`!node_modules/` 测试夹具），跳过该目录不报 `git.output-dirs`。

6. **受管 `AGENTS.md` 骨架瘦身、消除指导语泄漏与大小写/软链兼容（`templates/agents-project.md`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/compose-agents.mjs`、`scripts/lib/compose-agents-helpers.mjs`(new)、`scripts/lib/protocol.mjs`）**：
   - 将 `scripts/compose-agents.mjs`（693 行）拆出 `resolveAgentsPath(root)`、大小写/软链保真读写与 `--upgrade`/`--adopt-custom` 辅助至 `scripts/lib/compose-agents-helpers.mjs`(new)。
   - 精简 `templates/agents-project.md` 受管模板文本：压缩重复话术与冗长示例，使新渲染的受管空骨架严格 `< 16KB`（实测目标约 10-14KB），让既有 ~14KB 存量 `AGENTS.md` 执行 `--upgrade` 后稳居 `30720 B` 上限之下（`<= 28KB`）可无损追加。
   - 彻底消除 AI 指导语泄漏：
     - 从 `templates/agents-project.md` 移除 `{{CONVENTIONS_HINT}}` 与「目录结尾带 /，单文件不带；默认至少含…」指导句；同步从 `scripts/lib/protocol.mjs` `TEMPLATE_VARS` 移除 `'CONVENTIONS_HINT'`（并顺带把 `protocol.mjs:176` 的 `曾经` 改写为现状描述）；
     - `scripts/lib/equip-bootstrap.mjs` 移除 `- 暂未追加额外项目特有红线（需要时直接在本节增补并删除本句）。` 占位句，改为保留结构化空节或简短客观说明；
     - `scripts/lib/agents-defaults.mjs` 清理 `conventionsHint` 导出（或仅输出客观路径列表，不注入指导AI怎么改的指令句），同步更新 `scripts/dev/fixtures-flow-parallel.mjs` 相关断言。
   - `compose-agents.mjs` 与 `compose-agents-helpers.mjs`(new)：通过 `resolveAgentsFileTarget(root)` 检测目录内既有 `AGENTS.md` / `agents.md`（大小写不敏感查找真实文件名）及符号链接，写入时经 `realpathSync` 解析软链目标并保持原文件名大小写与链接关系不破坏。

### 数据与状态变更

- `survey()` 不再写入仓外 `session-state.json`（取消 S1 状态写入副作用）。
- `backup.mjs` `index.json` 读取不设 512KB 上限，并精简每条备份条目中的冗余字段以控制体积增长。
- `handoff.mjs` JSON 输出新增 `strictClean` 模式标与更细粒度的 `scanCoverage`（`skippedLockfiles`、`skippedLargeAssets`、`skippedSymlinks`），不再把这三类计入 `truncated: true`。

### 异常、回退与安全边界

- 工作流 `pull_request_target` 解析遇到无法按 YAML job 切分的异常结构时保守回退文件级判定，确保不漏报真实 `pwn-request`。
- `compose-agents.mjs` 写入软链 `agents.md` 时若软链悬空（目标不存在）或指向仓库外路径（`!isInsideDir`），拒绝覆盖并报错退出码 `2`。
- `credential-scan.mjs` 动态 PEM 仅豁免字面含 `${...}` 模板插值的单行模板表达，真实多行 Base64 PEM 块仍严格拦截。

### 实现顺序

1. 升级基础原语：`kit/skills/lib/git-core.mjs`（`readTextSafe`/`readJsonSafe` 无上限支持、`matchGlobList` 负向 `!` glob）、`kit/skills/lib/credential-scan.mjs`（动态 PEM 插值识别）。
2. 拆小并重构发现层：`kit/skills/lib/profile-sniffer-packages.mjs`(new)、`kit/skills/lib/profile-sniffer.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/lib/survey-workspace-secrets.mjs`(new)、`scripts/lib/survey-workspace.mjs`。
3. 更新入口层：`scripts/survey.mjs`（去 S1 写入）、`scripts/backup.mjs`、`scripts/handoff.mjs`、`scripts/review.mjs`、`scripts/equip.mjs`、`scripts/lib/render.mjs`。
4. 瘦身契约模板与合成器：`templates/agents-project.md`、`scripts/lib/protocol.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/lib/compose-agents-helpers.mjs`(new)、`scripts/compose-agents.mjs`。
5. 同步 `.agents/skills/`（`node scripts/equip.mjs .`），编写 `scripts/dev/fixtures-w6a-survey-handoff.mjs`(new)、更新 `scripts/dev/fixtures-flow-parallel.mjs` 与 `scripts/dev/injections-data-w6a.mjs`(new)，跑通全量门禁。

## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 按仓库名/路径加特例白名单 | 在 `survey-docs.mjs` / `survey-ecosystem.mjs` 针对 `vite`、`fastapi`、`Benchmarks` 硬编码跳过 | 违背通用架构重构原则，新仓换目录名即复发 | 永不改回特例白名单 |
| 仅调大 `AGENTS_MAX_BYTES` 放宽上限 | 把 `30720` 调大到 `45KB` 容纳胖骨架与存量契约 | 污染 AI 上下文窗口且违背 AGENTS 紧凑预算契约 | 仅当宿主规范全局调整上限时再评估 |

## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `scripts/lib/survey-docs.mjs` & `scripts/lib/survey-gap-rules.mjs` & `scripts/review.mjs` | 修改 | job 级 `pull_request_target`、现代发布模式、hooks 探测、`secrets-are-placeholders` 接入两档 | `survey.mjs`、`review.mjs` |
| `scripts/lib/survey-ecosystem.mjs` & `kit/skills/lib/profile-sniffer.mjs` & `kit/skills/lib/profile-sniffer-packages.mjs`(new) & `kit/skills/lib/git-core.mjs` | 修改/新增 | `.slnx`/`jsr.json`/`deno.json`/`!` glob/`hasManifest`、`Benchmarks`/`MinVer` 修正、Linter 探测 | 勘察、多生态发现、`dev-explore`/`dev-govern` |
| `scripts/survey.mjs` & `scripts/backup.mjs` & `scripts/handoff.mjs` & `scripts/equip.mjs` & `scripts/lib/render.mjs` & `scripts/lib/text.mjs` | 修改 | S1 零写入、`backup` 取消 512KB 上限、`handoff` 锁文件/大文件/软链豁免及 `--strict-clean`、equip 输出 Linter 隔离建议 | 外部项目接入、交棒与回滚 |
| `kit/skills/lib/credential-scan.mjs` & `scripts/lib/survey-workspace.mjs` & `scripts/lib/survey-workspace-secrets.mjs`(new) | 修改/新增 | 动态 `${...}` PEM 豁免、`.env*` 扫描、`git.output-dirs` 跳过跟踪及 `!` 放行目录 | 凭据扫描与忽略检测 |
| `templates/agents-project.md` & `scripts/lib/agents-defaults.mjs` & `scripts/lib/equip-bootstrap.mjs` & `scripts/compose-agents.mjs` & `scripts/lib/compose-agents-helpers.mjs`(new) & `scripts/lib/protocol.mjs` | 修改/新增 | 空骨架 `< 16KB`、清零指导语泄漏、小写/软链 `agents.md` 保留 | `compose-agents` 与 `equip` |
| `.agents/skills/lib/*` & `scripts/dev/fixtures-w6a-survey-handoff.mjs`(new) & `scripts/dev/fixtures-flow-parallel.mjs` & `scripts/dev/injections-data-w6a.mjs`(new) | 修改/新增 | 同步 `.agents/skills/`、补全正反双向测试与故障注入 | 回归与故障注入门禁 |

- **对外可见的变化**：`handoff.mjs` 新增 `--strict-clean` 选项与无损持续 `--upgrade` 兼容语义；新生成 `AGENTS.md` 受管骨架体积降至 `< 16KB` 且不含 AI 指导语；`survey()` 不再写入 `session-state.json`。
- **需要同步改的地方**：`scripts/equip.mjs .` 同步 `.agents/skills/lib/`；本切片测试写入 `scripts/dev/fixtures-w6a-survey-handoff.mjs`(new) 与 `scripts/dev/injections-data-w6a.mjs`(new)。

## 五、冻结的验收标准

- [ ] C1: `scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs` 与 `scripts/review.mjs` 按工作流文件+job 粒度结构化判定 `pull_request_target` 与不安全 PR checkout，豁免 `pull_request.number` 与 `# zizmor: ignore[dangerous-triggers]`；补齐 `uv publish`、`dotnet ... publish`、`jsr publish`、`vp pack` 与 `simple-git-hooks` / `.git/hooks/*` 检测（由 `node scripts/dev/fixtures.mjs --domain w6a-survey-handoff` 实证）。
- [ ] C2: `scripts/lib/survey-ecosystem.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`scripts/lib/agents-defaults.mjs` 与 `kit/skills/lib/git-core.mjs` 支持 `.slnx`、`jsr.json` / `deno.json`、`pnpm-workspace.yaml` 继承、`!` 负向 glob 与 `hasManifest` 边界（消除 80 子包爆炸、`Benchmarks` 误选 `dotnet test`、`*.csproj` 覆盖 `MinVer`）；`equip.mjs` / `survey.mjs` 探测根 Linter/Formatter 输出 `.agents/` 忽略隔离方案；`survey()` 严格零写入（取消误写 `session-state.json`）。
- [ ] C3: `scripts/backup.mjs` 取消 512KB `index.json` 读取截断上限（支持任意体积与精简条目元数据）；`scripts/handoff.mjs` `--verify` 对锁文件（`*-lock.*`、`*.lock`）、大数据非工程文件及有意软链不计入 `truncated` 退出码 `3`，并区分持续 `--upgrade` 受管态（通过）与 `--strict-clean`（要求剥离）。
- [ ] C4: `kit/skills/lib/credential-scan.mjs`、`scripts/lib/survey-workspace.mjs` 与 `scripts/review.mjs` 识别 `${...}` 动态 PEM 模板字面量、扫描 `.env*` 测试夹具正文、为 `secrets.tracked` 与 `secrets.exposed` 统一接入 `decision: 'secrets-are-placeholders'`，且 `git.output-dirs` 跳过全部受 Git 跟踪或 `.gitignore` `!` 显式放行的目录。
- [ ] C5: `templates/agents-project.md`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/equip-bootstrap.mjs` 与 `scripts/compose-agents.mjs` 精简受管模板骨架（落盘空骨架 `< 16KB`，14KB 存量 `AGENTS.md` 可无损 `--upgrade`），彻底消除 `CONVENTIONS_HINT` / `暂未追加...` / `目录结尾带 /...` 等 AI 指导语泄漏并保留既有小写 `agents.md` / 软链指向；全部新增/修改 `.mjs` 文件严格 `<= 800` 行。
- [ ] C6: Slice 6A 正反双向夹具（`scripts/dev/fixtures-w6a-survey-handoff.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6a.mjs`(new)）且 `.agents/skills/` 同步一致，`node scripts/dev/preflight.mjs`、`node scripts/dev/gap-coverage.mjs`、`node scripts/dev/fixtures.mjs --jobs 6` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿。

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`two-way`；回滚做法：在隔离分支直接 `git revert <commit>` 即可安全恢复，无不可逆持久化迁移。
- **高风险路径**：触及 `scripts/lib/`、`templates/`、`kit/` 高风险路径（需独立审查 + 两阶段故障注入）。
- **故障注入预演**：在 `scripts/dev/injections-data-w6a.mjs`(new) 至少注入破坏 job 级 `pull_request_target` 判定、破坏 `handoff --verify` 锁文件豁免、破坏 `backup` 大 `index.json` 读取与破坏动态 PEM 豁免，运行 `node scripts/dev/verify-injections.mjs --only W6A` 确认精准变红捕获。

## 澄清与补充记录

- 已定（2026-11-22）：`scripts/lib/protocol.mjs` 与 `kit/skills/lib/credential-scan.mjs` / `kit/skills/lib/git-core.mjs` 均由 6A 独占修改，6B/6C 仅复用其导出符号，零文件重叠。

## 实现说明

> 代码合入前补齐，随功能 PR 一同提交并标记 `implemented`；若常青架构已同步进 `docs/TDD.md`，随关联 `PRD`/`Todo` 成对归档至 `docs/archive/specs/`。

- **实际落地摘要**：待实施后填写
- **与草案的差异**：待实施后填写
- **关联同步文件**：待实施后填写
