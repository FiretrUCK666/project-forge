---
kind: todo
title: "Slice 1: 接入探测单源收敛、零侵入融合与有界规模渲染"
status: done
created: 2026-11-28
updated: 2026-11-28
issue: 248
pr: null
branch: feat/s1-onboard-probes-visual
owner: planner-s1-spec
plan_mode: interactive
approved: false
done_at: 2026-11-28
task_id: s1-onboard-probes-visual
planned_at: 8d42cdd3f6a989b4254dfc050ef57d7c92781f20
related_prd: ../../prd/261128-universal-deentropy-redesign-prd.md
related_spec: ../specs/261128-issue248-s1-onboard-probes-visual-spec.md
---

# Slice 1: 接入探测单源收敛、零侵入融合与有界规模渲染

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-28` / `2026-11-28` |
| 分支 / 基线 | `feat/s1-onboard-probes-visual` @ `8d42cdd` |
| 任务编号 | `s1-onboard-probes-visual` |
| 负责人 / 审批 | planner-s1-spec / `false` |
| 规划态 | `interactive`（Wave 1 切片，承接总控 PRD `C1..C9`，经独立 Critique 与 `approve` 后移交独立实施者） |
| 关联 Issue / PR / SPEC | #248 / 未关联 / `docs/archive/specs/261128-issue248-s1-onboard-probes-visual-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue`、`docs/archive/specs/261128-issue248-s1-onboard-probes-visual-spec.md` 审批态与隔离 worktree 当前 `HEAD`。

## 任务范围与验证基准

- **影响路径（共 42 份：27 产品层 + 15 验证层）**：
  - 产品层（27 份）：`kit/skills/lib/profile-sniffer.mjs`、`kit/skills/lib/profile-sniffer-packages.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/lib/tool-owned.mjs`、`kit/skills/lib/command-lex.mjs`、`kit/skills/lib/feature-map.mjs`、`kit/skills/lib/static-analyzer.mjs`、`kit/skills/lib/import-graph.mjs`、`kit/skills/lib/static-evidence-erd.mjs`、`kit/skills/lib/visual-layout-diagrams.mjs`、`kit/skills/lib/visual-layout-charts.mjs`、`kit/skills/lib/visual-geometry-check.mjs`、`scripts/lib/agents-sections.mjs`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/compose-agents-helpers.mjs`、`scripts/lib/claims.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/lib/review-helpers.mjs`、`scripts/lib/render.mjs`、`scripts/lib/protocol.mjs`、`scripts/review.mjs`、`scripts/equip.mjs`、`scripts/compose-agents.mjs`、`scripts/survey.mjs`（以及经 `node scripts/equip.mjs .` 同步的 `.agents/skills/`）。
  - 验证与夹具层（15 份）：`scripts/dev/injections-data-core.mjs`、`scripts/dev/gap-coverage.mjs`、`scripts/dev/fixtures-r7-rootfix.mjs`、`scripts/dev/fixtures-r8-bugfixes.mjs`、`scripts/dev/fixtures-w6a-survey-handoff.mjs`、`scripts/dev/fixtures-r5-onboarding.mjs`、`scripts/dev/fixtures-claims.mjs`、`scripts/dev/fixtures-brownfield-onboarding.mjs`、`scripts/dev/fixtures-flow-parallel.mjs`、`scripts/dev/fixtures-heterogeneous-survey.mjs`、`scripts/dev/fixtures-skills-hooks.mjs`、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/fixtures-onboarding.mjs`、`scripts/dev/fixtures-review.mjs`、`scripts/dev/blind-run-harness.mjs`。
- **复用既有模块**：`kit/skills/lib/profile-sniffer.mjs`（`extractYamlRunBlocks`、`scanNeutralCiSteps`、`scanDeclaredTaskRunners`、`discoverWorkspacePackages`）、`kit/skills/lib/tool-owned.mjs`（`AGENTS_MAX_BYTES`、`AGENTS_WARN_BYTES`）、`kit/skills/lib/command-lex.mjs`（`splitCommandSegments`、`commandHeadOf`）、`kit/skills/lib/markdown-scan.mjs`（`scanLines`）、`kit/skills/lib/static-analyzer.mjs`（`analyzeRepoStatic`）、`kit/skills/lib/static-evidence.mjs`（`extractMultiDiagramEvidenceSync`）、`kit/skills/lib/visual-layout.mjs`（`buildVisualModel`）、`kit/skills/lib/visual-router.mjs` 与 `scripts/lib/compose-agents-helpers.mjs`（`formatOversizeBreakdown`）。
- **本期不做**：不修改 `SKILL.md`、`AGENTS.md` 与 `templates/agents-project.md` 既有详尽规范条款正文；不触碰 Wave 2（Slice 2 `C10..C20`，含 `repo-map-helpers.mjs`、`govern-docs.mjs`、统一卫生门禁、多会话并发、5 远端评论、认知契约与常青文档/双语 README 全量同步）；不引入第三方依赖；不改动 `docs/archive/` 与 `docs/release-notes/`。
- **门型与回滚路径**：`two-way`；全部改动隔离在特性分支 `feat/s1-onboard-probes-visual`，合入后如需回退可直接 `git revert -m 1` 并重跑 `node scripts/equip.mjs .` 与 `node scripts/compose-agents.mjs .`。
- **快测命令**：`node scripts/dev/preflight.mjs`
- **全量与合入门禁**：`node scripts/dev/fixtures.mjs`、`node scripts/dev/gap-coverage.mjs`、`node scripts/dev/bench.mjs`、`node scripts/dev/e2e-zip-harness.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4`、`node scripts/compose-agents.mjs . --check`、`node scripts/equip.mjs . --check`、`node scripts/review.mjs .`、`node scripts/dev/merge-gate.mjs`

## 验收标准与执行清单

> 每条 `C1..C9` 与关联 SPEC 一一对应，须由真实命令或正反双向断言实证后勾选 `[x]`。

- [x] C1: 在 `kit/skills/lib/` 确立探测单源原语（`profile-sniffer.mjs` 的 `extractStructuredCiSteps` 与 `scanDeclaredTaskRunners`、`profile-sniffer-packages.mjs` 的 `discoverWorkspacePackages`、`profile.mjs` 的 `discoverDesignDocs`），完成 `scripts/lib/` 侧全部重复实现去重（`scripts/lib/survey-ecosystem.mjs` 与 `scripts/lib/survey-docs.mjs`）；保留 `profile-sniffer.mjs` 中 `detectOptionalNativeCheckers` 的 `{ configured, hasNativeConfig }` 返回契约（保证 `edit-gate.mjs --with-native`、`govern-retro.mjs`、`survey.mjs` 零断链），仅删除其 `.agents/` 配置文本扫描（`mentionsAgents`/`addAdvice`/`agentIgnoreAdvice`）及 `scripts/equip.mjs`、`scripts/lib/render.mjs` 消费点，并彻底删除 `scripts/lib/review-helpers.mjs` 的 `TOOLING_AGENTS_IGNORE_RULES`/`detectToolingAgentsIgnoreGaps`/`checkEslintAgentsIgnore` 及 `scripts/review.mjs` 调用点，同步迁移 `scripts/dev/fixtures-r7-rootfix.mjs`、`scripts/dev/fixtures-r8-bugfixes.mjs`、`scripts/dev/fixtures-w6a-survey-handoff.mjs`、`scripts/dev/fixtures-r5-onboarding.mjs`，`node scripts/dev/preflight.mjs` 与 `node scripts/dev/gap-coverage.mjs` 退出码均为 `0`。
- [x] C2: `extractStructuredCiSteps` 永不跨 workflow 使用 `&&` 拼接命令，自动过滤含 `${{`、多行控制流与长度 `> 256` 字节的片段；在模拟含多 workflow 与 `jq` 续行的夹具仓上运行 `node scripts/survey.mjs` 与 `verify-tools.mjs sync`，输出零非法伪命令且 `verify-tools-audit.mjs` 报告 `0` 个 `missing-script` zombie。
- [x] C3: `scripts/lib/agents-sections.mjs` 禁止按宽泛英文单词跳过核心受管节（`意图路由`、`Dev Profile`、`修改守则`、`日常协作与风险分流`、`取舍`），且 `scripts/compose-agents.mjs` 与 `scripts/review.mjs` 对任意标题去重跳过均输出 `skippedByHeading` 诊断；在含业务章节标题（如 `Real-time Collaboration`、`General Guidelines`）的既有 `AGENTS.md` 夹具上运行 `scripts/compose-agents.mjs`，原文前缀字节级保留且全部核心受管节 `100%` 注入。
- [x] C4: `scripts/compose-agents.mjs`、`scripts/lib/compose-agents-helpers.mjs`、`scripts/lib/survey-gap-rules.mjs` 与 `scripts/review.mjs` 严格保护 `SKILL.md`、`AGENTS.md` 与 `templates/agents-project.md` 既有详尽条款不阉割，复用升级既有 `managedBytes`/`customBytes` 分解逻辑并实行预算分层：`AGENTS_MANAGED_MAX_BYTES = 24576`（`24 KB`，对齐 `kit/skills/lib/tool-owned.mjs` 的 `AGENTS_WARN_BYTES`）硬门禁，当 `totalBytes > 30720` 且超限源于 `customBytes` 时在 `compose-agents`/`review`/`survey-gap-rules` 统一降级为软提示 `notice`（退出码 `0`）并输出 `managedBytes`、`customBytes` 分解与可选紧凑指针模式指引；当 `managedBytes > 24576` 时仍硬阻断（非 `0` 退出码）；同步迁移 `scripts/dev/injections-data-core.mjs` 的 `I24` 守护 `managedBytes > AGENTS_MANAGED_MAX_BYTES`，且本仓 `node scripts/compose-agents.mjs . --check` 退出码为 `0`（`govern-docs.mjs` 侧同源判据在 Slice 2 `C12` 对齐）。
- [x] C5: `scripts/lib/survey-docs.mjs` 删除钩子工具白名单，改用 4 条通用 Git 钩子不变量（`core.hooksPath`、仓根非保留隐藏目录与 `.git/hooks/` 标准钩子文件、自定义 `.githooks/*` 与根级钩子配置，命中即 `preserve`，`scripts/lib/render.mjs` 不再附带 `--with-hooks`）；`scripts/lib/survey-workspace.mjs` 与 `scripts/equip.mjs` 对实际写入受管路径执行动态 `git check-ignore -v -z`，遮蔽时优先输出零副作用精确回纳 `!.agents/skills/` 与 `!.agents/skills/**`；上游历史 `ignoredButTracked` 降级为 `notice`（支持取舍豁免），仅本次新引入忽略冲突硬阻断。
- [x] C6: `scripts/lib/claims.mjs` 围栏代码块拆词统一改为 `/[\s,]+/`、拒绝含逗号 token 与国际通用占位前缀（`path/to/*`、`foo/bar/*`、`example/*`、`your-*`），并将已融合仓非受管正文中的可疑旧路径降级为 `notice`（同时保持无受管标记纯契约与 `I13` 为 `missing`）；`kit/skills/lib/profile.mjs` 的 `readDecisionMap` 兼容无冒号裸取舍开关（如 `- no-git-hooks`）并兼容读取误写在 `## 取舍` 的 `evergreen-docs`；`scripts/lib/review-helpers.mjs` 的 `placeholderIdentity` 准确拦下 RFC 2606 保留无效域（`.invalid`、`example.*`、`.test`）与 `test-*` 占位名。
- [x] C7: 在 `kit/skills/lib/command-lex.mjs`（零依赖、`arch-rules` 合规）抽出共享可执行命令形态校验纯函数（拒绝含中文自然语言句式的非 CLI 文本，仅放行合法可执行命令或显式 `none`），同时接入 `scripts/lib/agents-sections.mjs`（`validateDevProfileRegion`）与 `kit/skills/lib/feature-map.mjs`（不合法时回退合法命令或 `null`）；`scripts/lib/agents-defaults.mjs` 的 `COMMIT_STYLE_HINT` 消除随提交数跨越 `5` 跳变的自破问题，在 1 次与 6 次提交间重复运行 `scripts/compose-agents.mjs --check` 均返回退出码 `0`。
- [x] C8: `kit/skills/lib/profile.mjs` 的 `discoverDesignDocs` 通过 `readdirSync` + `toLowerCase()` 去重并按通用后缀词根识别多份设计文档（在大小写不敏感 FS 上 0 重复条目）；`kit/skills/lib/static-evidence-erd.mjs` 支持通用 SQL `ALTER TABLE ... FOREIGN KEY`、SQLAlchemy 2.0 `mapped_column` 与通用 `@Table`/`@Entity` 最小核并停止逐框架正则堆砌，正反双向夹具断言全部通过。
- [x] C9: `kit/skills/lib/visual-layout-diagrams.mjs` 与 `kit/skills/lib/visual-layout-charts.mjs` 严格执行有界节点上限（`tree <= 120`、`erd <= 48`、`class <= 60`、`dataflow <= 60`）并输出 `meta.truncated`；`kit/skills/lib/visual-geometry-check.mjs` 采用 $O(N \log N)$ 扫描线校验；`kit/skills/lib/static-analyzer.mjs` 升 `ANALYSIS_CACHE_SCHEMA_VERSION = 2` 精简缓存并受 `128 MB` 上限约束；`node scripts/dev/bench.mjs` 与大规模渲染夹具测试全部通过且无超时。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先删旧双轨与白名单：删除 `kit/skills/lib/profile-sniffer.mjs` 的 `.agents/` 配置文本扫描（保留 `detectOptionalNativeCheckers` 返回 `{ configured, hasNativeConfig }`）及 `scripts/equip.mjs`、`scripts/lib/render.mjs` 消费点；彻底删除 `scripts/lib/review-helpers.mjs` 的 `TOOLING_AGENTS_IGNORE_RULES`/`detectToolingAgentsIgnoreGaps`/`checkEslintAgentsIgnore` 及 `scripts/review.mjs` 调用点；删除 `scripts/lib/survey-docs.mjs` 钩子工具白名单与 `scripts/lib/survey-ecosystem.mjs` 跨 workflow 拼接 | `node scripts/dev/preflight.mjs` 核查无断链导入与 0 反向依赖 | SPEC 经独立 Critique 并 `approve` |
| 2 | 建单源探测与命令词法原语：在 `kit/skills/lib/profile-sniffer.mjs` 导出 `extractStructuredCiSteps`（零跨 workflow `&&` 拼接、过滤 `${{`/多行控制流/`> 256 B`）；在 `kit/skills/lib/profile.mjs` 导出 `discoverDesignDocs`（`readdirSync` + `toLowerCase()` 去重 + 通用后缀词根）、兼容裸取舍开关与跨区 `evergreen-docs`；在 `kit/skills/lib/command-lex.mjs` 导出 `validateExecutableCommandShape`；将 `scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/agents-sections.mjs` 与 `kit/skills/lib/feature-map.mjs` 切入单源调用 | `node scripts/dev/preflight.mjs` 与定向单测验证单源函数正反输入输出 | 步骤 1 |
| 3 | 落地零侵入存量融合与分层预算数据链：在 `kit/skills/lib/tool-owned.mjs` 导出 `AGENTS_MANAGED_MAX_BYTES = 24576` 并于 `scripts/lib/protocol.mjs` 用 `export ... from` 单源重导出；在 `scripts/lib/survey-docs.mjs` 产出 `agentsManagedBytes`/`agentsCustomBytes` 并驱动 `scripts/survey.mjs` 与 `scripts/lib/survey-gap-rules.mjs`；改造 `scripts/compose-agents.mjs`（`contractHealth().oversize` 对齐 `managedOversize` 并透传 `totalOversize`/`managedBytes`/`customBytes`/`skippedByHeading` 兼容 `scripts/dev/preflight-e2e.mjs`）、`scripts/lib/compose-agents-helpers.mjs`、`scripts/review.mjs`（保持字面量 `'missing'`/`'notice'` 调 `finding()`、将 `!oversize` 改为 `!managedOversize` 并消费 `claims` 的 `item.level`）；在 `scripts/lib/agents-sections.mjs` 落地核心节保护与 `analyzeContractSections`（保持 `collectMissingSections`/`missingRegionsOf` 返回 `string[]`）；落地 4 条通用钩子不变量、动态 `git check-ignore -v -z` 精确回纳 `!.agents/skills/` + `!.agents/skills/**`、`ignoredButTracked` 降级与 `survey-gap-rules.mjs`/`survey.mjs` 对 `ignore-tracked-legacy` 联动、`scripts/lib/claims.mjs` `/[\s,]+/` 拆词与双态保护 `I13`、RFC 2606/`test-*` 身份拦检与稳定 `commitStyleHint` | `node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .` 与 `node scripts/dev/gap-coverage.mjs` 均返回 `0` | 步骤 2 |
| 4 | 落地有界视觉引擎、扫描线、单源缓存重建与最小 ERD 核：从 `kit/skills/lib/import-graph.mjs` 抽出单源 `expandImportCandidates(relFile, specifier, { goModules, kind })` 供 `extractImportsForArch` 与 `static-analyzer.mjs` 共用；在 `kit/skills/lib/static-evidence-erd.mjs` 补齐 `ALTER TABLE ... FOREIGN KEY`、SQLAlchemy 2.0 `mapped_column`、`@Table`/`@Entity` 最小核；在 `kit/skills/lib/visual-layout-diagrams.mjs` 与 `kit/skills/lib/visual-layout-charts.mjs` 实施 `120/48/60/60` 节点上限与 `meta.truncated`；重构 `kit/skills/lib/visual-geometry-check.mjs` 为 X 轴扫描线 $O(N \log N)$；在 `kit/skills/lib/static-analyzer.mjs` 升 `ANALYSIS_CACHE_SCHEMA_VERSION = 2`、存紧凑 `{ specifier, line, kind }`（保 Rust `mod` 边）并将读写上限统一对齐 `128 MB` | `node scripts/dev/bench.mjs` 与大规模合成图几何/缓存夹具无超时通过 | 步骤 2 |
| 5 | 迁移全部 15 份 `scripts/dev/` 验证文件并补齐正反双向用例：迁移 `scripts/dev/injections-data-core.mjs`（`I24`）、`scripts/dev/gap-coverage.mjs`、`scripts/dev/fixtures-r7-rootfix.mjs`、`scripts/dev/fixtures-r8-bugfixes.mjs`、`scripts/dev/fixtures-w6a-survey-handoff.mjs`、`scripts/dev/fixtures-r5-onboarding.mjs`、`scripts/dev/fixtures-claims.mjs`（`C4`/`I24` 与 `I13`）、`scripts/dev/fixtures-brownfield-onboarding.mjs`、`scripts/dev/fixtures-flow-parallel.mjs`、`scripts/dev/fixtures-heterogeneous-survey.mjs`、`scripts/dev/fixtures-skills-hooks.mjs` 及 RFC 2606 邮箱迁移涉及的 `scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/fixtures-onboarding.mjs`、`scripts/dev/fixtures-review.mjs`、`scripts/dev/blind-run-harness.mjs`（并排查其余调 `reviewProject` 的正例夹具）；补齐 `C1..C9` 正反双向断言 | `node scripts/dev/fixtures.mjs`、`node scripts/dev/e2e-zip-harness.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿退出 `0` | 步骤 3、步骤 4 |
| 6 | 执行 `dify`/`outline` 纯只读外部大仓实证（严禁写盘 `verify-tools.mjs render .` 或不传 `cacheRoot` 的 `renderArchitectureMapAsync`）：对外部仓前后核验 `git status --porcelain` 零变更且 `.git` 目录下 `project-forge-flow` 的 `analysis-cache.json` 未创建/未修改（记录 `mtime`/字节数前后一致）；对 `dify`（或万级文件 SQLAlchemy 2.0 合成仓）跑只读 `scripts/survey.mjs --json` 并以临时 `cacheRoot` 连续两次直调三原语 `analyzeRepoStatic(targetRepo, { useCache: true, cacheRoot })` -> `extractMultiDiagramEvidenceSync(targetRepo, { analysis, featureMap: {}, cacheRoot, useCache: true })` -> `buildVisualModel({ featureMap: {}, analysis, evidence })`，验证二次命中 `hits > 0 && misses === 0`、缓存 `<= 128 MB`、`geometryReport.ok === true`、节点受限且 `evidence.diagrams.erd` 含 SQLAlchemy 2.0 字段；对 `outline`（或等效合成仓）内存态执行 `compose` 核实保留原文前缀与 5 个核心受管节且仅 `customBytes` 超 30 KB 降级 `notice` | 纯只读三原语实证脚本断言全绿且目标仓工作区与 `.git` 缓存均零变更 | 步骤 5 |
| 7 | 同步内置技能与全门禁收口：运行 `node scripts/equip.mjs .` 同步 `.agents/skills/` 并核对全仓 `.mjs` 均 `< 800` 行；依次跑通全量验证矩阵（`preflight`、`gap-coverage`、`fixtures`、`bench`、`e2e-zip-harness`、`verify-injections --jobs 4`、`compose-agents . --check`、`equip . --check`、`review .`、`govern-audit audit .`、`merge-gate`） | 全部命令退出码 `0` 且无遗留未跟踪临时文件 | 步骤 6 |

## 风险与应对

| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 贴线文件改动后超过 `800` 行红线 | `scripts/lib/survey-docs.mjs`（795L）、`scripts/equip.mjs`（757L）、`scripts/lib/survey-workspace.mjs`（756L）、`scripts/review.mjs`（752L）等增量大于删减 | 先在步骤 1 删重/删白名单腾出净空间，公共辅助下沉 `kit/skills/lib/`；每次改完跑 `node scripts/dev/preflight.mjs` 核验行数 |
| `review.mjs` 动态传参破坏 `gap-coverage` 或 `protocol.mjs` 重复导出 | `finding()` 未使用字面量 `'missing'`/`'notice'` 或 `protocol.mjs` 重复定义 `AGENTS_MANAGED_MAX_BYTES` | `review.mjs` 严格用字面量分支调 `finding()`；`protocol.mjs` 严格用 `export { AGENTS_MANAGED_MAX_BYTES } from '../../kit/skills/lib/tool-owned.mjs'`；跑 `preflight.mjs` 与 `gap-coverage.mjs` 验真 |
| `C6` 拦 RFC 2606 域导致既有正例夹具/E2E 误报 | 遗漏某份调用 `reviewProject` 且配置 `@example.com`/`@*.test` 邮箱的正例夹具 | 步骤 5 全量扫描 `scripts/dev/*.mjs` 中调用 `reviewProject`/`review.mjs` 的测试邮箱并统一迁移，同时保留专用负面用例验真拦截 |
| 外部仓只读实证误写目标目录或 `.git` 缓存 | 误调用带写盘副作用的 `verify-tools.mjs render .` 或不透传 `cacheRoot` 的 `renderArchitectureMapAsync` | 强制直调三原语（`analyzeRepoStatic` -> `extractMultiDiagramEvidenceSync` -> `buildVisualModel`）并传临时 `cacheRoot`，前后核验 `git status --porcelain` 与目标仓 `.git` 下 `project-forge-flow` 缓存 `analysis-cache.json` 状态一致 |

## 回滚预案

- **出问题时的第一步**：确认问题范围后，在未合入前直接重置或修复隔离分支 `feat/s1-onboard-probes-visual`；若已合入主干，立即对对应合并提交执行 `git revert -m 1`（严禁强推或改写历史）。
- **回滚用什么**：反向提交 + `node scripts/equip.mjs .` + `node scripts/compose-agents.mjs .` 还原 `.agents/skills/` 与 `AGENTS.md`。
- **回滚之后要做什么**：运行 `node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs` 与 `node scripts/review.mjs .` 确认门禁恢复全绿，并暂停 Wave 2（Slice 2）开工直至 Slice 1 根因修复重新合入。

## 协作与依赖

| 对象 | 需要什么 | 什么时候需要 | 找谁 |
| --- | --- | --- | --- |
| 独立 Critique 审查者 | 对 `docs/archive/specs/261128-issue248-s1-onboard-probes-visual-spec.md` 执行 Round 3 独立只读 Critique 并 `critique-pass` | 本轮修订 `audit` 全绿后、开工前 | `@coordinator` 派发全新独立只读 Critic |
| 独立实施者 | 在隔离 worktree 认领 `#248` 并按本 Todo 步骤实施 `C1..C9` | SPEC 经 `doc-plan.mjs approve` 后 | `@coordinator` 派发独立实施代理 |
| Wave 2（Slice 2）规划与实施者 | 消费 Slice 1 沉淀的 `extractStructuredCiSteps`、`scanDeclaredTaskRunners`、`discoverDesignDocs`、`readDecisionMap`、`validateExecutableCommandShape`、`expandImportCandidates` 与 `AGENTS_MANAGED_MAX_BYTES` | Slice 1 合入主干后 | Slice 2 规划与实施代理 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（`C1..C9` 全部落地、同步 `.agents/skills/` 并完成 `dify`/`outline` 纯只读大仓实证与全量门禁校验）
- **待拍板事项**：无
- **下一步第一件事**：完成 `flow.mjs finalize`、提交代码、`flow.mjs verify --mode gate` 与 `flow.mjs submit` 移交独立审查。

## 澄清与补充记录

- 已确认（2026-11-28，吸收 Round 1 与 Round 2 Critique 全部 Major 与 Should-Fix）：纳入 `kit/skills/lib/import-graph.mjs` 抽出单源 `expandImportCandidates` 供 `static-analyzer.mjs` v2 缓存（`{ specifier, line, kind }`）按需重建（切片总计 42 份文件：27 产品层 + 15 验证层）；`dify` 只读实证改为三原语直调（`analyzeRepoStatic` -> `extractMultiDiagramEvidenceSync` -> `buildVisualModel`）并加校验目标仓 `.git` 下 `project-forge-flow` 缓存 `analysis-cache.json` 零创建/零修改；`review.mjs` 用字面量 `finding()` 并将 `!oversize` 改为 `!managedOversize`，`contractHealth().oversize` 对齐 `managedOversize`；`survey-gap-rules.mjs` 与 `survey.mjs` 对 `ignore-tracked-legacy` 联动并维持 `gap-coverage.mjs` 映射。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `SPEC` 一并经 `flow.mjs finalize` 归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`、`node scripts/dev/preflight.mjs`（0 失败 / 42 项读数）、`node scripts/dev/gap-coverage.mjs`（22/22）、`node scripts/dev/bench.mjs`、`node .agents/skills/dev-edit/scripts/edit-gate.mjs --final`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .`、`node scripts/dev/merge-gate.mjs`、`node scripts/dev/verify-injections.mjs --jobs 4` 全绿退出 0；
  - 纯只读外部大仓实证：`dify`（17,036 文件，目标仓与 `.git/project-forge-flow/analysis-cache.json` 均零写入）首次 `analyzeRepoStatic` 23.9s / 二次 5.5s（`hits=13574, misses=0`，cache v2 12.78 MB <= 128 MB）、`buildVisualModel` 342ms、`geometryReport.ok=true`（0 违规）、四图截断 `tree 13693->120 / erd 205->48 / class 7576->60 / dataflow 106->60`、SQLAlchemy 2.0 ERD 检出 199 实体 / 2,249 字段 / 9 关系；`outline` 内存态 `compose` 字节级保留 14,775 B 原文前缀、5 个核心受管节 100% 注入、`managed=19,750 B <= 24,576 B`、`custom=14,805 B` 降级软提示不阻断（Sequelize `@Table` ERD 检出 40 实体 / 370 字段 / 128 关系）。
- **文档同步检查**：已通过 `node scripts/equip.mjs .` 同步 `.agents/skills/` 与 `kit/skills/` 字节级一致；本仓 `AGENTS.md`（23,280 B / `managed=20,577 B <= 24,576 B`）校验通过；总控 PRD `docs/prd/261128-universal-deentropy-redesign-prd.md` 保持 `status: active` 不归档，Slice 1 自身 SPEC/Todo 随 `flow.mjs finalize` 成对归档。
- **遗留问题**：无（Wave 2 `C10..C20` 留待 Slice 2 独立规划与实施）。
