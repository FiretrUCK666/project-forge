---
kind: spec
title: 全仓深度对齐与去硬编码清理（C1-C7）
status: draft
tier: L3
created: 2026-11-22
updated: 2026-11-22
issue: 128
pr: null
branch: fix/w3-repo-alignment
owner: plan-align
plan_mode: interactive
approved: false
implemented: false
plan_critique: "rejected (reviewer=critic-align, round=1, sha=ce7e6d721527, summary=发现2项真实阻塞：C2豁免ci.absent与local-only回归断言冲突；C3扩充cli-parity至12入口漏规划4个缺printHelp的脚本适配)"
related_prd: null
related_todo: ../todo/261122-issue128-w3-repo-alignment-todo.md
high_risk_paths: [scripts/lib/, scripts/dev/preflight.mjs, templates/, kit/, SKILL.md, AGENTS.md, .github/workflows/]
task_id: w3-repo-alignment
depends_on: []
scope_files: [SKILL.md, AGENTS.md, CONTRIBUTING.md, RELEASING.md, .gitignore, docs/TDD.md, docs/feature-map.json, .github/workflows/check.yml, .github/pull_request_template.md, .github/ISSUE_TEMPLATE/bug_report.md, .github/ISSUE_TEMPLATE/feature_request.md, "templates/**", "references/**", "scripts/*.mjs", "scripts/lib/**", scripts/dev/bench.mjs, scripts/dev/cli-parity.mjs, scripts/dev/gap-coverage.mjs, scripts/dev/merge-gate.mjs, scripts/dev/preflight-kernel-parity.mjs, scripts/dev/preflight-suite.mjs, scripts/dev/preflight-suite-checks.mjs, "scripts/dev/fixtures-*.mjs", "scripts/dev/injections-data-*.mjs", "kit/skills/**", ".agents/skills/**"]
---

# 全仓深度对齐与去硬编码清理（C1-C7） — 功能设计规范（SPEC）

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3`（跨模块去重、契约对齐与高风险路径整改；未 `approved` 前不编码） |
| 创建 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / Issue / PR | `fix/w3-repo-alignment` / #128 / 未关联 |
| 负责人 / 内审状态 | `plan-align` / `pending` |
| 规划态 | `interactive`（已完成三份全仓审计，所有设计决策均已收敛无未决项） |
| 关联 PRD / Todo | `null` / [w3-repo-alignment Todo](../todo/261122-issue128-w3-repo-alignment-todo.md) |

- **变更一句话**：对照 `main`（`caa5501`）三份全仓只读审计报告，彻底修复模板水合与门禁真 Bug、清除多远端 `generic-git` 与 `local-only` 隐性 GitHub 默认、单源收敛双端平台注册表与共享原语、全量对齐模板/参考/`SKILL.md`/`AGENTS.md`/`docs/TDD.md`/`docs/feature-map.json`、清理 `manifest v2` 与漂移计数及历史立碑注释，并补齐正反双向 Fixture 与 `I386–I397` 故障注入。

## 系统变更全景

```mermaid
flowchart LR
  Tpl["C1/C4 模板门禁"] --> Cap["C2 能力分流"]
  Cap --> Dedup["C3 原语收敛"]
  Dedup --> Docs["C5/C6 文档注释"]
  Docs --> Verify["C7 测试与注入"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `templates/` 与 `scripts/equip-ci.mjs`、`scripts/lib/equip-bootstrap.mjs` | 改造 | 修复水合正则失配/占位空转/非 Node 失效步骤并对齐 `generic-git` |
| `kit/skills/lib/platform-registry.mjs` (new) & `platform.mjs` | 新增 / 拆分 | 从 `platform.mjs`（794L）拆出核心注册表，双端统一 8 键能力与 `file://` 解析 |
| `scripts/lib/` 与 `scripts/dev/preflight-kernel-parity.mjs` | 改造 | 重导出 `kit/skills/lib/` 单一原语并纳入内核对等门禁 |
| `scripts/review.mjs`、`registry.mjs`、`ledger.mjs`、`flow-*`、`govern-*` | 改造 | 清除 `?? 'github'` 与写死命令提示，统一按 `role`/`capabilities` 分流 |
| `references/`、`kit/skills/*/SKILL.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md` | 改造 | 全量同步 PR-A/PR-B 参数、13 项产物、Tier 1/2 语义与 `docs/feature-map.json` |
| `scripts/dev/fixtures-repo-alignment.mjs` (new) & `injections-data-repo-alignment.mjs` (new) | 新增 | 独立承载 C1–C6 正反双向断言与 `I386–I397` 故障注入（避让 770L+ 旧夹具） |

## 一、背景与边界声明

<!-- section: goal -->
- **要改什么**：全仓 7 类对齐改造（C1 模板水合与门禁真 Bug；C2 `review.mjs`/`registry.mjs`/`ledger.mjs`/`task-backend.mjs`/`flow-*`/`govern-*`/`equip-bootstrap.mjs` 去隐性 GitHub 默认；C3 拆分 `platform-registry.mjs` 并单源收敛 `scripts/lib/` 与 `kit/skills/lib/`；C4 全量 `templates/`/`.github/`/根目录；C5 `references/`、8 份 `kit/skills/*/SKILL.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md`、`docs/feature-map.json`；C6 `manifest v2 -> v3` 与计数/立碑清理；C7 新建 `fixtures-repo-alignment.mjs` 与 `I386–I397` 故障注入）。
- **不改什么**：严禁修改 `README.md`、`README.en.md` 与 `assets/readme/*.svg`（留给并行切片 `#104`）；不改变各技能 CLI 既有合法外部行为与退出码语义；不删除回归测试向量（`DOC_REGRESSION_ANCHOR_LOST`、`M0-M5`）。
- **本期不做**：不引入任何第三方 npm 依赖；不新增 GitLab/Bitbucket/Gitee 专用 API 适配器（未知主机继续优雅降级 `generic-git`）；不重写外部测试仓库或发布新版本标签。
- **复用既有模块**：`kit/skills/lib/git-core.mjs`、`kit/skills/lib/platform-probe.mjs`、`kit/skills/lib/github-parse.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/lib/skill-discovery.mjs`、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/static-gates-lexer.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`scripts/lib/protocol.mjs`、`scripts/equip.mjs`、`scripts/compose-agents.mjs`。
- **架构基线关系**：严格遵循 `AGENTS.md` `arch-rules`（允许 `scripts/lib/** -> kit/skills/lib/**`，严禁 `kit/** -> scripts/lib/**` 或 `scripts/dev/**`），全部 `.mjs <= 800` 行、`AGENTS.md < 24576B`、`SKILL.md <= 200L / 16384B`、`kit/skills/*/SKILL.md <= 180L`（依据：`docs/TDD.md`）。
- **替代方案与否决理由**：曾考虑保留 `scripts/lib/platform/registry.mjs` 独立实现仅靠手写注释对齐，或直接把新原语追加进 794L 的 `platform.mjs` 与 770L+ 的旧夹具；已否决，因为前者必然再次漂移（已发生 7 键 vs 8 键、`file://` 分叉），后者会直接击穿 800 行硬上限。
<!-- section: goal-end -->

## 二、设计方案与契约变更

<!-- section: design -->
### 接口 / 数据结构变更

1. **C1：模板水合与门禁真 Bug 修复**
   - `templates/agents-project.md:113` 补齐「里」字为 `本项目尚未在清单里声明标准命令。`；`scripts/lib/equip-bootstrap.mjs:240` `hydrateInitialAgentsDefaults` 同步兼容可选「里」字正则，确保 `--bootstrap-empty` 彻底清除空命令模板块。
   - `templates/ci-release.yml` 与 `scripts/equip-ci.mjs`（`hydrateReleaseTemplate`）：统一 `templates/ci-release.yml:69` 的 `VERSION_MANIFEST` 占位（与 `hydrateReleaseTemplate` 的清单占位符替换匹配）、`:85` 默认分支占位（或删除死替换保留运行时 `${{ github.event.repository.default_branch }}`）并显式适配 `facts.conventions.tagPrefix` 裸标签（`[0-9]*` vs `v*`）及 `workflow_dispatch.inputs.tag.description` 与 `:74` 错误提示；`:106-108` 通用 `sed` 增补 `pom.xml`（`version` XML 标签）与单引号 `version = '...'`。
   - `templates/ci-check.yml` 与 `scripts/equip-ci.mjs`（`hydrateCheckTemplate`）：按 `facts.ecosystem` 动态渲染/替换 `:108-111` 运行时安装步骤（仅 Node 生态落盘 `actions/setup-node@v4` 与声明版本，Python/Rust/Go/Java 等按对应生态输出或省略失效步骤）；同步修正 `:24` vs `:33` 生态数量文案（覆盖 12 生态说明）、补全 `# tags:` 示例行、补齐跨平台矩阵 `defaults.run.shell: bash` 与 `timeout-minutes` 注释提示。
   - `kit/skills/templates/docs-tdd.md`：移除 `doc-info`（`:10`）、`flow`（`:124`）、`invariants`（`:141`）误标的 `optional`；移除 `:238` 删 `build` 节的矛盾注释（对齐 `FORM_INDEPENDENT_CORE.tdd`）；将 `:151-152` `security optional` 改为二级标题 `## 安全与权限边界细节`（对齐 `doc-requirements.mjs:548`）；补全 `## 目录` 中 `build`、`decisions`、`glossary-only` 条目。
   - `kit/skills/templates/docs-prd.md`：`plan_mode` 改为 `interactive`（对齐 `pending-decisions.mjs:71`）；frontmatter 补 `multi_spec: false`；`:22` 状态枚举补 `superseded`；`:197` 补充 1:N 总控 PRD 四态闭环规则。
   - `kit/skills/templates/docs-spec.md`：frontmatter 补 `task_id: null`、`scope_files: []`、`depends_on: []`；删除第 57 行与 `## 三、备选方案与否决理由` 重复的尖括号占位行。
   - `kit/skills/dev-plan/scripts/doc-plan.mjs:169`：当 `profile.quickTest` 缺失或为 `'none'` 时，不再把尖括号占位串传给 `{{QUICK_CMD}}`，改为传入非尖括号合法文本 `无自动快测命令（按手动步骤实证替代）`。

2. **C2：多远端 `generic-git` 与纯本地 `local-only` 去隐性 GitHub 默认**
   - `scripts/review.mjs:452-462,543-572`：复用 `facts.git.providerId` 与 `facts.git.capabilities`（对齐 `survey.mjs:217-291`），仅对 `collab.pr-template`、`collab.issue-templates`、`collab.branch-protection` 与远端发布相关的 `release.absent` 按能力分流豁免（`local-only` 与无对应远端能力的 `generic-git` 不误报缺 `.github/pull_request_template.md`、`.github/ISSUE_TEMPLATE/`、远端分支保护）；**保持 `ci.absent`（`notice` / `no-ci`）在无远端 `local-only` 仓的既有契约输出**（兼容 `fixtures-core.mjs:139-150,203-217` 与 `fixtures-heterogeneous-survey.mjs:174-182`）。
   - `scripts/lib/platform/registry.mjs:352-354,392-394,413,437-442`：定义 `NONE_CAPABILITIES`（8 键全 `false`），`topology.mode === 'none'` 时 `classifyTopologyIdentity` / `resolveTopologyIdentity` / `probeTopologyEnv` 返回 `providerId: 'none'` 与全 `false` 能力表（不再伪装 `GITHUB_PROVIDER.capabilities` 全 `true`；`probeTopologyEnv` 探测本机建仓凭据仍保留凭据结果但工作区能力忠实报告 `none`）。
   - 清除全部 `?? 'github'` / `|| 'github'` 与 `githubRepoFull` 隐性默认：
     - `kit/skills/lib/ledger.mjs:131-132`：`role` 默认 `'local-only'` 时 `providerId` 默认 `partial.providerId ?? (role === 'local-only' ? 'none' : null)`；
     - `kit/skills/lib/task-backend.mjs:255,268`：`createTaskBackend` 默认 `providerId = 'none'`，仅在 `provider?.id === 'github'`（或显式注册工厂）时构造 `GitHubBackend`，其余非 API 平台回退 `GenericRemoteBackend` / `LocalOnlyBackend`；
     - `kit/skills/dev-flow/scripts/flow-cleanup.mjs:350`、`flow-inspect.mjs:276,344,606,623`、`flow-intake.mjs:143`、`flow-next.mjs:317`、`flow.mjs:129`、`flow-context.mjs:85`、`kit/skills/dev-review/scripts/review-sync.mjs:356`：全部改用 `state.identity.providerId` / `parseRemotesTopology` 真实解析，并在 `flow-context.mjs` 提取公共远端解析辅助函数确保 `flow-inspect.mjs`（796L）不增反降。
   - 文案与默认配置去 GitHub 写死：`kit/skills/lib/workflow-policy-next.mjs:257` 按 `providerId`/`role` 分流提示（`github` 提示 `gh issue view`，`local-only`/`generic-git` 提示 `flow.mjs issue view`）；`kit/skills/dev-govern/scripts/govern-state.mjs:591,597` 与 `govern-audit.mjs:48,66` 改为三态 `TaskBackend` 通用工单表述；`scripts/lib/equip-bootstrap.mjs:175` 改为「GitHub 双轨、generic-git 远端与 local-only 本地模式」；`kit/skills/lib/profile.mjs:462` 与 `kit/skills/lib/static-gates.mjs:297` 对齐通用默认高风险路径。

3. **C3：双端平台注册表与共享原语彻底收敛及行数预算拆解**
   - **800L 拆解与 `arch-rules` 落位方案**：`kit/skills/lib/platform.mjs`（794L）、`kit/skills/lib/docs.mjs`（791L）、`kit/skills/dev-govern/scripts/govern-checks.mjs`（791L）严禁直接膨胀；所有跨端共享常量与原语下沉至 `kit/skills/lib/`（允许 `scripts/lib/**` 单向导入）：
     - 新建 `kit/skills/lib/platform-registry.mjs` (new)：从 `platform.mjs`（794L）抽离 `GENERIC_GIT_PROVIDER`、`GITHUB_PROVIDER`、`PROVIDER_REGISTRY`、`validateHostingProvider`、`registerHostingProvider`、`getHostingProvider`（含 `.trim().toLowerCase()`）、`listHostingProviders`、`resolveRemoteDescriptor`（含 `file://` 解析 `repoSlug` 且统一 8 键 `capabilities` 含 `mention`），再由 `kit/skills/lib/platform.mjs`（降至约 650L）与 `scripts/lib/platform/registry.mjs`、`scripts/lib/platform/github.mjs` 直接复用重导出。
     - `scripts/lib/platform/github-client.mjs` 复用 `kit/skills/lib/github-parse.mjs` 导出的 `RETRYABLE_NET_CODES` 并收口客户端底层网络原语（消除双份独立重复实现）。
     - `canonicalPath` / `samePath` / `posixPath` / `isMainModule` / `writeAtomic` / `LIKELY_DEFAULT_BRANCHES`：合并 `text.mjs` 对 `null`/`undefined`/空串返回 `''`/`false` 的边界保护进 `kit/skills/lib/git-core.mjs`；`scripts/lib/text.mjs`、`scripts/lib/fs-atomic.mjs`、`scripts/lib/update-ops.mjs`（删第 3 份 `canonicalRealPath`）、`scripts/lib/protocol.mjs` 直接导入重导出。
     - `parseRemoteUrlHost` / `GITHUB_HOST_RE` / `githubRepoPath`：`scripts/lib/text.mjs` 直接复用 `kit/skills/lib/platform-probe.mjs`。
     - `VERIFY_EXIT`：收归 `kit/skills/lib/exit-codes.mjs`，`scripts/handoff.mjs` 重导出。
     - `summarizeSkillDescription` & `DEFAULT_KIT_SKILLS_DIR`：`scripts/lib/survey-ecosystem.mjs`（782L）与 `scripts/equip.mjs`（782L）直接导入 `kit/skills/lib/skill-discovery.mjs`（净减少两文件行数）。
   - **`kit/skills/` 内部重复常量收敛**：
     - `NON_API_CLIENT_TIERS`（4 项含 `'mcp-delegate'`）收归 `kit/skills/lib/github-client.mjs`，`flow-context.mjs` 与 `review-pr.mjs` 共用；
     - `PLACEHOLDER_TEXT_RE`（含 `待补齐`）收归 `kit/skills/lib/doc-substantive.mjs`，`doc-audit-helpers.mjs` 共用；
     - `CONCRETE_ANCHOR_RE` 在 `doc-audit.mjs` 与 `evidence-substance.mjs` 消歧（明确区分 `DOC_CONCRETE_ANCHOR_RE` 与 `EVIDENCE_CONCRETE_ANCHOR_RE` 或统一单源）；
     - `EXTRA_CI_FILE_RE`、`FEATURE_MAP_REL`、`CODE_EXT` / `CODE_EXT_RE`、`OUTPUT_DIRS`、`parseArchRuleItem`、`looksLikeCommentedCode`、`extractCriteria`、`DECIDED_RE`、`AGENTS_MAX_BYTES` / `AGENTS_WARN_BYTES` 分别收敛至 `kit/skills/lib/git-core.mjs`、`kit/skills/lib/static-gates-lexer.mjs`、`kit/skills/lib/doc-substantive.mjs`、`kit/skills/lib/tool-owned.mjs` 等现有未满载单源库（禁止向 791L `docs.mjs` 与 `govern-checks.mjs` 堆砌新导出；`scripts/lib/protocol.mjs` 从 `kit/skills/lib/` 重导出 `AGENTS_MAX_BYTES`/`AGENTS_WARN_BYTES`）；
     - `TOOL_OWNED_PREFIXES`（`kit/skills/lib/tool-owned.mjs`）动态对齐 `skill-discovery.mjs` / `UNIFIED_SKILL_NAMES`；`scripts/handoff.mjs:69` `SKILL_INTERNAL_RE` 补全 `equip-ci`；`workflow-policy-next.mjs:234` 消除目标仓不存在的 `node scripts/equip.mjs .` 提示。
   - **门禁补齐**：
     - `scripts/dev/cli-parity.mjs:34-40` `ENTRY_SPECS` 扩充至全部 12 个调用 `parseStandardCli` 的入口（在既有 5 个基础上增补 `doc-locate.mjs`、`repo-map.mjs`、`flow-intake.mjs`、`worktree-deps.mjs`、`govern-retro.mjs`、`iterate.mjs`、`verify-tools.mjs` 并登记对应 `DARK_BASELINE`）；同步适配 4 个尚缺标准 `function printHelp()` 的入口（其余 3 个已具备）：`doc-locate.mjs`（`usageText` 改为 `printHelp`）、`repo-map.mjs`（内联帮助抽为 `printHelp`）、`govern-retro.mjs`（内联帮助抽为多行 `printHelp`）、`flow-intake.mjs`（补齐 `printHelp()`、`booleanFlags` 加 `'help'` 与 `--help` 早退 `0`，4 文件均远低于 800L）；
     - `scripts/dev/preflight-suite.mjs:40-48` 改用 `kit/skills/lib/profile.mjs` `DEV_PROFILE_KEYS` 单源，并增补校验 `scripts/lib/agents-defaults.mjs:369-375`；
     - `scripts/dev/preflight-kernel-parity.mjs` 将本次收敛的共享原语（`canonicalPath`、`samePath`、`posixPath`、`isMainModule`、`writeAtomic`、`VERIFY_EXIT`、`LIKELY_DEFAULT_BRANCHES`、`summarizeSkillDescription`、`DEFAULT_KIT_SKILLS_DIR`、`parseRemoteUrlHost`、`githubRepoPath`、`NON_API_CLIENT_TIERS`、`PLACEHOLDER_TEXT_RE`、`parseArchRuleItem`、`looksLikeCommentedCode`、`extractCriteria`、`DECIDED_RE`、`AGENTS_MAX_BYTES`、`registerHostingProvider`）全部纳入 `SINGLE_SOURCE_DEFS`。

4. **C4：全量 `templates/` + `.github/` + 根目录对齐**
   - `templates/readme.md`：补全 8 技能、修正 `dev-explore` 只读定位描述、修复 `check.yml` 徽章示例、区分 GitHub/`generic-git`/`local-only` 的 CI 与反馈渠道、注明单人仓可选 `CONTRIBUTING.md`。
   - `templates/agents-project.md`：对齐 PR-A/PR-B（`flow.mjs next --handoff`、`init --worktree`、`start --planning`、`BLOCKED_PLAN_NOT_READY`、`plan_mode`、`runLowRiskDocStaticCheck`、`commits > 0` Case 1-4 一律进 `.worktrees/impl-*`、`contributor-fork` 私有规划隔离、同 `HEAD` 与故障注入）、兼容 `generic-git` 推分支与手工 MR 合流、取消第 7 步写死 `origin`、对齐 `:231` 默认高风险路径、标注 `CONTRIBUTING.md` 单人仓可选。
   - `templates/contributing.md` & `CONTRIBUTING.md`：补全 `survey.mjs --probe-auth`、`generic-git` MR 合流差异、`docs/TDD.md` + Mermaid `16/12`、`review-pack.mjs --pr ... --untrusted-scan` 与 `--ignore-scripts`；同步 `CONTRIBUTING.md` 验证清单至 `.github/workflows/check.yml`（补 `bench.mjs`、`e2e-zip-harness.mjs`、`--jobs 4`）与自用文件列表（`.gitattributes`、`.gitignore`）。
   - `templates/releasing.md` & `RELEASING.md`：补 `local-only`/`generic-git` 本地打标签降级；更新 `RELEASING.md` 示例标签为 `v6.0.0`、补 `bench.mjs` / `e2e-zip-harness.mjs` 与排除目录 `.agents/` / `.github/`。
   - `templates/pull-request-template.md` & `.github/pull_request_template.md`：补注 `contributor-fork` 与 `merge-authority: human` 合并权说明。
   - `templates/issue-bug-report.md`、`templates/issue-feature-request.md`、`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md` 与 `kit/skills/lib/issue-template-hydrate.mjs`：当 `sec.repro` / `sec.scope` / `sec.extra` 为空时剥离空节与模板占位裸列表 `1.\n2.\n3.`（或填入明确兜底文本，不再留空标题与裸序号）；4 份模板复选框示例统一带 `C1:` / `C2:`；`.github/ISSUE_TEMPLATE/feature_request.md:43-45` 高风险清单补齐 `kit/` 与全部 8 项。
   - `templates/githooks-pre-push.sh`：补 `--slug`、`--case 1..5`、`finalize -> verify -> submit` 完整顺序及缺失 `flow.mjs` 时原生 `git switch -c` 兜底。
   - `.github/workflows/check.yml`（同步顶部注释说明）与 `.gitignore`（补 `._*`、`__MACOSX/`、`.env`、`.env.*`、`!.env.example`、`*.pem`、`*.key`、`*.tmp-*`）。

5. **C5：全量 `references/` + 8 份 `kit/skills/*/SKILL.md` + `SKILL.md` + `AGENTS.md` + `docs/TDD.md` + `docs/feature-map.json` 精确对齐**
   - `references/`：`collaboration.md`（阻塞退出码 `2->3`、`plan-sync.mjs`、`critique-scope`、`batch plan --handoff`、`status --all`、`<= 15 行`上限、UI 禁裸 `--visual-checked`、双写本地工单）、`docs-set.md`（`plan-sync`、`doc-slice-graph`、去 `DOC_REGRESSION_ANCHOR_LOST`、补 `docs/feature-map.json`、Case 3 Todo 免 Critique）、`handoff.md`（区分 `local-only`/`generic-git` 跳过 workflows、补 `--scan`/`--json`）、`remote-github.md`（修正「宿主机」为「托管平台」）、`survey.md`（空目录提问含 `generic-git`/`local-only`、补 `docs/feature-map.json`、`computeArtifactPlan` 更新为 13 项含 `#12 branch-protection` 与 `#13 git-hooks`）、`version-control.md`（补 `>= 20MB` / `> 1MB` 检查阈值）。
   - `kit/skills/*/SKILL.md`（8 份，全部 `<= 180L`，改后跑 `node scripts/equip.mjs .` 同步 `.agents/skills/`）：逐一补全 `doc-locate --list`、`repo-map --task/--write-feature-map`、`critique-scope`、`init --kind tdd`、`start --case 1..5` / `--create-issue` / `--parallel` / `--base` / `--spec`/`--todo`/`--prd`、`verify --e2e-evidence/--visual-evidence`、`flow.mjs issue`（并修正 `flow.mjs:42` `printHelp` 的 `intake --decision` 枚举）、`dev-edit` 8 项表与 `edit.hack-without-issue`、`dev-verify-tools` `low` 级不自动刷新基线 / `medium` 退出码 `3` 与 `--allow-medium-fallback` / 空 `feature-map` 退出码 `0` vs 未匹配 `3` / `create --from-scratch --command`、`dev-review` `check-empirical` 参数与三态 `record`、`dev-govern` 三态 `TaskBackend` 建单与 Tier 1/2 正序、`dev-iterate` Tier 1/2 正序与 `generate --limit`。
   - `SKILL.md`（`<= 200L / 16384B`）、`AGENTS.md`（`compose-agents.mjs .` 生成且 `< 24576B`）、`docs/TDD.md`（`kit/skills/lib/` 真实模块数、`batch plan --handoff` 完整载荷与 `<= 15 行`上限、Tier 1/2 正序）、`docs/feature-map.json`（`survey.businessFlows` 13 项、`preflight-gate.modules` 移出夹具并补齐校验子模块及新增 `platform-registry.mjs`）。

6. **C6：全仓过时 `manifest v2`、漂移计数与历史立碑注释清理**
   - 7 处 `manifest v2 -> v3` 注释/帮助对齐；
   - `shared.mjs`、`gap-coverage.mjs`、`preflight-kernel-parity.mjs`、`cli-parity.mjs`、`preflight-suite.mjs:424,539`、`preflight-suite-checks.mjs:76-80,107`（改为动态扫描 `assets/readme/*.svg` 并输出 `${svgFiles.length}`，兼容后续 `#104` 增补 SVG）、`merge-gate.mjs:15`、`doc-template-render.mjs:144`、`doc-toc.mjs:6`、`tool-owned.mjs:9`、`protocol.mjs:300` 移除脆弱计数写死或改动态推导；
   - `bench.mjs:8`（`Wave 4 -> 严格门禁模式`）、`survey-plan.mjs:20`（移除历史规模快照数字）与 `fixtures-*.mjs` / `injections-data-*.mjs` 文件头阶段立碑注释改写为功能域说明（严格保留有意回归断言/测试向量如 `DOC_REGRESSION_ANCHOR_LOST`、`M0-M5`）。

7. **C7：正反双向 Fixture 与 `I386–I397` 故障注入**
   - 新建 `scripts/dev/fixtures-repo-alignment.mjs` (new) 与 `scripts/dev/injections-data-repo-alignment.mjs` (new)（`I386–I397` 共 12 条）。

### 数据与状态变更

- `createDefaultLedger`（`kit/skills/lib/ledger.mjs:131-132`）新增任务账本在 `role === 'local-only'` 且未传 `providerId` 时写入 `'none'` 而非 `'github'`（读取既有已落盘账本仍兼容）。
- `kit/skills/templates/docs-prd.md` 与 `docs-spec.md` 模板新增标准 Frontmatter 字段（`multi_spec`、`task_id`、`scope_files`、`depends_on`）与 `superseded` 状态枚举说明。
- `kit/skills/lib/platform-registry.mjs` (new) 统一 8 键 `capabilities`（含 `mention`）及无远端 `none` 能力表。

### 异常、回退与安全边界

- 所有 `scripts/` 与 `kit/` 严格零第三方依赖（仅 `node:*` 内置模块），零 emoji，零宿主名称或私有路径硬编码。
- 涉及 `kit/skills/` 变更必须重跑 `node scripts/equip.mjs .` 同步 `.agents/skills/`，并先触发 `backup.mjs` 快照保护。
- 行数守卫：对临近 800L 的 `.mjs`（`flow-inspect.mjs` 796L、`flow-lifecycle.mjs` 795L、`platform.mjs` 794L、`govern-checks.mjs` 791L、`docs.mjs` 791L、`flow-merge.mjs` 783L、`equip.mjs` 782L、`survey-ecosystem.mjs` 782L、`doc-plan.mjs` 774L）执行「只减不增」或「先抽新模块再改」，严禁任何单文件越过 800 行红线。

### 实现顺序

1. **P1 底层单源收敛（C3 核心 + C2 注册表与默认清理）**：先建 `platform-registry.mjs` 拆轻 `platform.mjs`，收敛 `git-core.mjs` / `platform-probe.mjs` / `github-parse.mjs` / `exit-codes.mjs` / `skill-discovery.mjs` / `doc-substantive.mjs` 等单源原语，清除 `registry.mjs` / `ledger.mjs` / `task-backend.mjs` / `review.mjs` / `flow-*` / `govern-*` 隐性 GitHub 默认并升级 `preflight-kernel-parity.mjs` 与 `cli-parity.mjs`。
2. **P2 模板水合与根目录对齐（C1 + C4）**：修复 `equip-bootstrap.mjs` / `equip-ci.mjs` / `doc-plan.mjs` / `issue-template-hydrate.mjs` 真 Bug，更新 `templates/*`、`.github/*`、根目录 `CONTRIBUTING.md` / `RELEASING.md` / `.gitignore`。
3. **P3 文档、套件同步与注释清理（C5 + C6）**：更新 `references/*`、`kit/skills/*/SKILL.md`、`SKILL.md`、`docs/TDD.md`、`docs/feature-map.json`，跑 `equip.mjs .` 与 `compose-agents.mjs .`，清理全仓 `manifest v2`、漂移计数与历史立碑注释。
4. **P4 正反 Fixture、故障注入与全量实证（C7）**：编写 `fixtures-repo-alignment.mjs` 与 `injections-data-repo-alignment.mjs`（`I386–I397`），跑通全部测试、导出包校验与故障注入复验。
<!-- section: design-end -->

<!-- section: alternatives -->
## 三、备选方案与否决理由

| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |
| --- | --- | --- | --- |
| 拆出 `platform-registry.mjs` 与新建独立 `fixtures-repo-alignment.mjs` | 在 `kit/skills/lib/` 抽轻量注册表并在 `scripts/dev/` 新建域测试文件 | 已选：既满足 `arch-rules` 单向依赖，又确保 `platform.mjs`（794L）与旧夹具（770-787L）不破 800L 红线 | 若未来有专门的大规模拆分重构将 `platform-probe.mjs` 合并 |
| 仅在原地修补 `registry.mjs` 并向旧夹具追加用例 | 不新建模块，直接在两套注册表和旧夹具内改代码 | 否决：双端注册表继续重复必再漂移，且 `platform.mjs`、`fixtures-onboarding.mjs` 等将立即突破 800L 触发门禁失败 | 不可能改回（800L 是硬门禁） |
| 跳过 `preflight-suite-checks.mjs` 动态 SVG 扫描 | 保持硬编码 6 张 SVG 与计数文本 | 否决：并行切片 `#104` 合入新 SVG 时会立即漂移或阻断 | 无（动态扫描兼容 6 张及未来更多张） |
<!-- section: alternatives-end -->

<!-- section: breakdown -->
## 四、改动清单与影响面

| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |
| --- | --- | --- | --- |
| `kit/skills/lib/platform-registry.mjs` (new) & `platform.mjs` | 新增 / 拆分 | 统一 8 键能力、`trim().toLowerCase()`、`file://` 解析与 `NONE_CAPABILITIES` | 双端平台探测与 `TaskBackend` |
| `kit/skills/lib/*` & `scripts/lib/*` | 修改 | 单源收敛共享常量/原语；清除 `?? 'github'` 与写死文案 | `scripts/*`、`kit/skills/*` |
| `scripts/review.mjs`、`equip-ci.mjs`、`equip.mjs`、`handoff.mjs` 等 | 修改 | 按能力分流、修复 check/release 水合、`manifest v3`、`SKILL_INTERNAL_RE` | 体检、CI 生成、交棒校验 |
| `templates/`、`.github/`、`CONTRIBUTING.md`、`RELEASING.md`、`.gitignore` | 修改 | 修复正则失配/空节残留，对齐 8 技能、`generic-git` 与 CI 清单 | 被治理项目与本仓贡献者 |
| `references/`、`kit/skills/*/SKILL.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md`、`docs/feature-map.json` | 修改 | 全量同步命令参数、13 项产物、Tier 1/2、载荷规格与模块地图 | AI 宿主会话与门禁脚本 |
| `scripts/dev/*`、`fixtures-repo-alignment.mjs` (new)、`injections-data-repo-alignment.mjs` (new) | 新增 / 修改 | 扩充 12 入口校验与内核对等门禁、清理立碑、补双向用例与 `I386–I397` | `preflight`、`fixtures`、`verify-injections` |

- **对外可见的变化**：修复模板水合、非 GitHub/无远端判定与提示文案；补全帮助文档与 `cli-parity` 校验覆盖；不破坏既有正常命令契约；不改动 `README.md`、`README.en.md`、`assets/readme/*.svg`。
- **需要同步改的地方**：改 `kit/` 后运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`；改 `templates/agents-project.md` 后运行 `node scripts/compose-agents.mjs .` 同步 `AGENTS.md`。
<!-- section: breakdown-end -->

## 五、冻结的验收标准

<!-- section: acceptance -->
<!-- criteria:start -->
- [ ] C1: 修复模板水合与门禁矛盾（`templates/agents-project.md:113` 与 `equip-bootstrap.mjs` 正则一致、`templates/ci-release.yml` 与 `equip-ci.mjs` 水合与裸标签适配、`templates/ci-check.yml` 按生态水合避免失效 `setup-node@v4`、`docs-tdd.md` 去除误标 `optional`/删 `build` 矛盾并改 `security` 为二级标题、`docs-prd.md`/`docs-spec.md`/`doc-plan.mjs:169` 修正字段与 `quick-test: none` 兜底），通过 `node scripts/dev/preflight.mjs`。
- [ ] C2: 清除全仓隐性 GitHub 默认（`scripts/review.mjs` 按平台能力对 `collab.*` 与 `release.absent` 分流并保持 `local-only` 的 `ci.absent` 契约、`registry.mjs` 无远端返回 `none` 全 `false` 能力表、`ledger.mjs`/`task-backend.mjs`/`flow-*`/`review-sync.mjs` 清除 `?? 'github'`、`workflow-policy-next.mjs`/`govern-*`/`equip-bootstrap.mjs`/`profile.mjs`/`static-gates.mjs` 清除写死提示），通过 `local-only` / `generic-git` / `github` 三态正反用例。
- [ ] C3: 双端平台注册表与共享原语彻底收敛至 `kit/skills/lib/`（拆分 `platform-registry.mjs` (new) 保持 `platform.mjs <= 800L`，统一 8 键能力/`.trim().toLowerCase()`/`file://`，收敛 `canonicalPath`/`samePath`/`posixPath`/`isMainModule`/`writeAtomic`/`VERIFY_EXIT`/`LIKELY_DEFAULT_BRANCHES`/`summarizeSkillDescription`/`DEFAULT_KIT_SKILLS_DIR`/`parseRemoteUrlHost`/`githubRepoPath` 及 `kit/` 内部重复常量，`SKILL_INTERNAL_RE` 补 `equip-ci.mjs`，`cli-parity.mjs` 扩至 12 入口并统一 `doc-locate.mjs`/`repo-map.mjs`/`govern-retro.mjs`/`flow-intake.mjs` 的 `printHelp()`），并通过 `node scripts/dev/preflight-kernel-parity.mjs`。
- [ ] C4: 全量对齐 `templates/`、`.github/` 与根目录（`templates/readme.md`/`agents-project.md`/`contributing.md`/`releasing.md`/`pull-request-template.md`/`issue-*.md`/`githooks-pre-push.sh`、`.github/ISSUE_TEMPLATE/*` 与 `issue-template-hydrate.mjs` 缺字段不留裸列表/空标题且 `feature_request.md` 补 `kit/`、`.github/workflows/check.yml`、`CONTRIBUTING.md`、`RELEASING.md`、`.gitignore`），通过 `checkTemplates` 与 `checkOwnInstances` 且不修改 `README.md`/`README.en.md`/`assets/readme/*.svg`。
- [ ] C5: 全量对齐 `references/`（10 份）、8 份 `kit/skills/*/SKILL.md`、`SKILL.md`（`<= 200L / 16384B`）、`AGENTS.md`（`< 24576B`）、`docs/TDD.md` 与 `docs/feature-map.json`，跑通 `node scripts/equip.mjs . --check` 与 `node scripts/compose-agents.mjs . --check`。
- [ ] C6: 清理全仓 7 处 `manifest v2 -> v3`、漂移硬编码计数（含 `preflight-suite-checks.mjs` 动态 SVG 统计）、`bench.mjs` `Wave 4`、`survey-plan.mjs` 历史快照与夹具文件头阶段立碑注释（完整保留 `DOC_REGRESSION_ANCHOR_LOST`/`M0-M5` 等回归向量）。
- [ ] C7: 在 `scripts/dev/fixtures-repo-alignment.mjs` (new) 与 `scripts/dev/injections-data-repo-alignment.mjs` (new) 落盘 C1–C6 正反双向断言与 `I386–I397` 故障注入，全部 `.mjs <= 800L` 且通过 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`review.mjs .`、`govern-audit.mjs audit .`、`git archive` 包清单检查与 `verify-injections.mjs --only I386`..`I397`（及全量门禁）。
<!-- criteria:end -->
<!-- section: acceptance-end -->

## 六、高风险点、门型与回滚路径

- **门型与回滚路径**：`two-way`（涉及 `high-risk` 门禁/模板/库文件，未推远端前可用工作树重置回退，合入后可通过单提交 `git revert` 反向提交回滚）。
- **高风险路径**：`scripts/lib/`、`scripts/dev/preflight.mjs`、`templates/`、`kit/`、`SKILL.md`、`AGENTS.md`、`.github/workflows/`——触碰须独立审查与 `I386–I397` 故障注入实证。
- **故障注入预演**：新建 `scripts/dev/injections-data-repo-alignment.mjs`（`I386–I397`），覆盖模板水合失效、非 Node CI 失效、无远端/通用远端能力误报、`?? 'github'` 回退、双端注册表分叉、内核重复拷贝放行、`cli-parity` 漏入口、Issue 空节残留与同构/Tier 校验失效；通过 `node scripts/dev/verify-injections.mjs` 验证每条注入均可精确击红对应断言。

## 七、上线与兼容策略

- **向后兼容**：既有任务账本缺少新字段或带旧 `v1/v2` `.pf-manifest.json` 的外部项目仍兼容读取；`scripts/lib/` 与 `kit/skills/lib/` 原有导出签名保持向后兼容重导出，避免破坏外部调用方与现有测试夹具。

## 澄清与补充记录

- 已定：依据三份全仓只读审计报告与 `main`（`caa5501`）源码核对确定全部 C1–C7 改动点、`I386–I397` 注入矩阵及 800L 行数防超方案；保留 `README.md`/`README.en.md`/`assets/readme/*.svg` 给 `#104` 处理，无未决事项。
- 已确认（Round 1 Critique 修订）：`scripts/review.mjs` 仅按能力对 `collab.*` 与 `release.absent` 分流并保持 `local-only` 的 `ci.absent` 既有契约；`cli-parity.mjs` 12 入口扩充同步适配 `doc-locate.mjs`/`repo-map.mjs`/`govern-retro.mjs`/`flow-intake.mjs` 的 `printHelp()`（含 `flow-intake.mjs` `--help`）。

## 实现说明

- **实际落地摘要**：待实现阶段填写。
- **与草案的差异**：待实现阶段填写。
- **关联同步文件**：待实现阶段填写。
