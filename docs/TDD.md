# project-forge 技术设计与架构文档（TDD）

本文是 `project-forge` 仓库的常青技术设计与架构权威，面向维护者与 AI 会话。文档只描述当前真实架构、模块边界与工程不变量，不记录历史修改流水。

## 系统定位与双层同构架构

`project-forge` 是一个零第三方依赖、纯 JavaScript（`node:*` 内置模块，Node 18+）的工程治理与研发工作流工具包。它既是一套发给外部用户的通用能力包，又是这套规范的第一个真实用户（自举仓）。

仓库严格划分为**产品层**与**自用层**两个互不越界的平面：

| 平面 | 目录与文件 | 职责与分发边界 |
| --- | --- | --- |
| 产品层（进用户包） | `SKILL.md`、`references/`、`templates/`、`scripts/`（顶层与 `lib/`）、`kit/skills/`、`README*.md`、`LICENSE` | 必须对任意外部项目成立；严禁包含特定 AI 宿主路径、非 GitHub 托管平台名称或本仓库内部开发路径 |
| 自用层（`export-ignore` 排除） | `AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、`.github/`、`.gitattributes`、`.gitignore`、`scripts/dev/`、`docs/`、`.agents/` | 只服务本仓库自身治理、测试门禁与研发留痕；通过 `.gitattributes` 与 `protocol.mjs` 双处对齐，在导出用户包时整体剔除 |

双层同构体现为「工具即样板」：本仓根目录的 `.agents/skills/` 由 `kit/skills/` 通过 `scripts/equip.mjs .` 单向同步生成；根目录的 `AGENTS.md` 由 `templates/agents-project.md` 通过 `scripts/compose-agents.mjs .` 渲染并维护，且始终受交付门禁核对。

## `kit/` 到 `.agents/skills/` 单源流向与账本机制

内置研发 Skill 套件在仓库和用户项目之间遵循单一权威流向：`kit/skills/**` -> `scripts/equip.mjs` -> `<target>/.agents/skills/**`。

1. **五套内置研发 Skill**：
   - `dev-explore`（`kit/skills/dev-explore/scripts/repo-map.mjs`）：`quick` / `medium` / `thorough` 三档只读探索、Dev Profile 读取、CI 步骤（`ciRunSteps`）、可复用模块（`reusableModules`）、`featureMap` 与热点定位。
   - `dev-plan`（`kit/skills/dev-plan/scripts/doc-plan.mjs`）：五档分流裁决（Case 1 至 Case 5）、`doorType` 与分级内审级别判定、模板初始化、规划自净化 `audit`、独立 `critique-pass` 防篡改校验及审批流转。
   - `dev-flow`（`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/worktree-deps.mjs`）：任务全链路状态机、Worktree 隔离与共享依赖零拷贝挂载、`verify --mode smoke --target` 运行实证、PR 合并弱化门禁检测（退出码 `4` 阻断）与四态安全清理。
   - `dev-review`（`kit/skills/dev-review/scripts/review-pack.mjs`）：不可信外部 PR 投毒预检（`--untrusted-scan`）、`behavioralGate` + `structuralGate` 双门评估（含 `smoke-verify` 实证、墓碑/借口注释、超大文件与 `arch-rules` 检查）、`doorAssessment` 评估与六锁防死循环审查收口。
   - `dev-govern`（`kit/skills/dev-govern/scripts/govern-audit.mjs`）：代码/文档/卫生 8 项深化审计（Git 演进温差、围栏感知死链、死代码块与借口/墓碑注释、神文件、`arch-rules`、孤儿测试、4 态 Worktree 判别）、修复计划生成、`record`/`cluster`/`sample` 规则下沉抽检与 `reconcile` 巡检对齐。
   - 共享内核 `kit/skills/lib/shared.mjs` 与 `kit/skills/**` 严格遵守 **100% 目录自包含铁律**：副本复制到任意外部项目的 `.agents/skills/` 后必须独立运行，严禁 `import` `kit/skills/` 之外的任何仓库模块（包括 `scripts/dev/`）；且每个内置 Skill 的 `SKILL.md` 严格控制在 `KIT_SKILL_MAX_LINES`（180 行）以内。
2. **SHA256 三态账本（`.agents/skills/.pf-manifest.json`）**：
   - 账本结构记录 `schemaVersion`、`forgeVersion`、`installedAt`、`files["<relPath>"].sha256` 与 `agentsRegions["<regionId>"].sha256`。
   - 同步裁决分三态执行：
     - 目标不存在或磁盘内容哈希与旧账本记录一致：写入新版本并更新账本（字节一致时跳过以保证幂等）。
     - 磁盘内容哈希偏离旧账本记录，或属于用户自建 Skill 目录：判定为用户定制，**100% 保留不覆盖**并仅在报告中提示差异。
     - 旧账本存在但新版 `kit/skills/` 已删除该文件（退役文件）：若磁盘内容哈希仍与旧账本一致，物理删除文件并清理账本记录实现自净化；若用户曾改过则保留并标记为 `orphaned-modified`。
   - `node scripts/equip.mjs <target> --check` 执行零写入字节级一致性校验，不一致即以非零退出码阻断。
3. **空白目录起步与写前增量快照（`--bootstrap-empty` / `scripts/backup.mjs`）**：
   - 针对 `empty` 零文件目录，按指定语言（`node`、`python`、`go`、`rust`、`docs`）生成最小可运行、内置可测试骨架与初始 `docs/TDD.md`（含 `arch-rules` 与 `Feature Map` 骨架），随后接入 `.agents/skills/` 装配，全程零第三方依赖。
   - `scripts/backup.mjs` 基于纯 `node:zlib` 与 POSIX USTAR/PAX tar 打包实现跨平台零外部命令写前快照（`create`/`list`/`restore`/`ensurePreWriteBackup`）。`scripts/equip.mjs` 与 `scripts/compose-agents.mjs` 在修改已有非空目标且实际存在待写变更前自动调用并写入仓外存储（`PF_BACKUP_DIR/<slug>-<hash8>/` -> `<gitCommonDir>/project-forge-backups/` -> `~/.project-forge/backups/<slug>-<hash8>/`），自动跳过 `.git`/`.worktrees`/`node_modules`/构建目录与 `>20MB` 单文件，最多滚动保留 5 份且 `restore` 会清理快照后新增的无主文件；零变动与 `--no-backup` 不写入冗余包。

## `scripts/lib/` 三真相源

所有共享核心规则收敛在三个无环单一真相源模块中：

| 模块 | 职责 | 关键导出与不变量 |
| --- | --- | --- |
| `scripts/lib/protocol.mjs` | 标记语法、预算常数与包边界 | `AGENTS_MAX_BYTES`（30720）、`AGENTS_WARN_BYTES`（24576）、`KIT_SKILL_MAX_LINES`（180）、`KIT_SKILLS`、`FORBIDDEN_PLATFORM_RE`、`PF_MANIFEST_REL`、`WORKTREES_STATE_REL`、`REPO_ONLY_DIRS`、`REPO_ONLY_FILES`、`FULL_READ_REFS`、`apiTarget`、`parseBeginMark` |
| `scripts/lib/template.mjs` | 模板条件求值与变量替换 | `evaluateConditions`、`renderVars`、`renderTemplate`、`residualConditionMarkers`；要求目标 `AGENTS.md` 渲染瞬间完成求值，零残留占位符或条件标记 |
| `scripts/lib/render.mjs` | 勘察报告排版与阅读导航 | `MATURITY_TEXT`、`toMarkdown`、`computeNavigation` |
| `scripts/survey.mjs` | 只读项目勘察与五态身份评估 | 只读扫描、结构与缺口识别、`--probe-auth` 双轨探测 |
| `scripts/equip.mjs` | 内置套件三态账本装配与空项目起步 | `checkEquip`、`equip`、`bootstrapEmpty`、写前调 `backup.mjs` |
| `scripts/backup.mjs` | 纯内置 `.tar.gz` 写前快照引擎 | `createBackup`、`listBackups`、`restoreBackup`、`ensurePreWriteBackup` |
| `scripts/compose-agents.mjs` | `AGENTS.md` 生成、刷新、保护与剥离 | 30KB/24KB 门禁、`agentsRegions` 防覆盖、调 `backup.mjs` |
| `scripts/review.mjs` | 交付体检与成熟度结论报告 | 成熟度/缺失项判定、契约回查与建议指路 |
| `scripts/handoff.mjs` | 交棒扫描与净度核验 | `--scan`/`--verify` 四档退出码（`0`/`1`/`3`/`4`） |
| `scripts/sync-toc.mjs` / `scripts/update.mjs` / `scripts/zip.mjs` | README 目录同步、包副本自更新与导出归档 | 双语目录一致性、非 `.git` 包覆盖升级、纯内置打包辅助 |

辅助校对模块 `scripts/lib/claims.mjs` 负责对生成的文档、反引号路径和分支指针做真实存在性验证；平台集成层收敛于 `scripts/lib/platform/`（`github.mjs` 与 `index.mjs`）。

## 模块分层与禁引规则（arch-rules）

```yaml
arch-rules: kit/** -> scripts/dev/**, scripts/*.mjs -> scripts/dev/**, scripts/lib/** -> scripts/dev/**
```

- **单向依赖层次**：`kit/skills/` 内置技能仅允许自包含引用 `kit/skills/lib/shared.mjs` 与 `node:*`；`scripts/*.mjs` 顶层 CLI 仅依赖 `scripts/lib/` 与同级运行时模块（如 `scripts/backup.mjs`）；`scripts/lib/` 只做无环纯内核与平台探针；`scripts/dev/` 门禁与测试脚本可调用产品层进行校验，反向引用一概禁止。

## 功能与入口地图（Feature Map）

| 能力域 | 入口脚本 | 核心验证入口 |
| --- | --- | --- |
| 勘察与双轨鉴权 | `scripts/survey.mjs` | `node scripts/survey.mjs .` |
| 套件装配与空仓起步 | `scripts/equip.mjs` | `node scripts/equip.mjs . --check` |
| 写前增量快照与回滚 | `scripts/backup.mjs` | `node scripts/backup.mjs list .` |
| 契约生成与预算门禁 | `scripts/compose-agents.mjs` | `node scripts/compose-agents.mjs . --check` |
| 交付体检与交棒扫描 | `scripts/review.mjs`、`scripts/handoff.mjs` | `node scripts/review.mjs .` |
| 探索、规划、流转、审查、治理套件 | `.agents/skills/dev-*/scripts/*.mjs` | `scripts/dev/preflight.mjs`、`scripts/dev/fixtures.mjs` |

## 双轴五态身份判定引擎

工作区角色不再仅靠「`origin` 文本是否匹配」草率裁定（修复他人公开仓 `git clone` 被误判成维护者的隐患），而是由 `resolveWorkspaceIdentity()` 沿**远端拓扑**与**认证所有权/权限**双轴联合判定为五态之一：

| 身份状态 | 判定事实特征 | 权限与流转约束 |
| --- | --- | --- |
| `local-only` | 无远端或显式存在 `.git/pf-local-mode` | 本地全量装备 `.agents/skills/` 并走本地分支/审查闭环；禁止误报远程缺失 |
| `maintainer` | `origin` 与项目声明源仓库一致且经 API 写权限/凭据或本机作者匹配实证；或自建非 Fork 私有/孤仓 | 允许正常分支提 PR、满足独立审查后合流及按明确指令发版 |
| `contributor-fork` | 存在与 `origin` 不同的 `upstream`、API 显示 `isFork` 且父仓匹配源仓库，或 `origin` 为自身 fork | 强制走 Fork 分支开上游 PR；**硬禁止执行 `merge`**；上游 PR 仍 `OPEN` 时禁止清理该 Fork 分支 |
| `clone-readonly` | `origin` 指向他人正本/声明源仓库且无写权限（如只读权限、`viewerPermission` 为 `READ`/`NONE` 或非作者只读克隆） | 降级为只读保护；阻断直推主干与合并，提示先 Fork 再开发 |
| `undetermined` | 缺少足够远端或认证信息无法证实所有权 | 保守按只读贡献路径处理，待用户补齐或探测确认后再放行 |

此外，在接收外部贡献者提案的场景下，流程进入 `inbound-external-pr` 只读隔离审核轨道。

## 双轨四级 GitHub 连接与安全封装

`probeGitHubEnv()` 与 GitHub REST/GraphQL 请求封装在所有子进程环境中强制注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never` 与 `BatchMode=yes`，彻底杜绝凭证弹窗或卡死，并遵循「令牌只在内存中短暂使用、严禁进入返回值/日志/stdout/磁盘」的脱敏原则。

- **Track A（Git 传输轨）**：并发探测 SSH（优先 `ssh -T git@github.com` 端口 22，超时或被拒时回退探测 `ssh.github.com:443`）与 HTTPS credential helper（`git credential fill`、`gh auth setup-git`）；修复仅有 SSH 凭据时 `--probe-auth` 误报 `no-credential` 的缺陷；当本地 remote URL 协议与可用传输错配时直接给出精确的 `remediationCmd`。
- **Track B（GitHub API 四级降级轨）**：
  1. `tier: 'gh-cli'`：优先使用已登录的 `gh` CLI。
  2. `tier: 'node-https-token'`：原生 `node:https` 客户端读取 `GH_TOKEN`/`GITHUB_TOKEN` 或内存复用 `git credential fill` 凭据。
  3. `tier: 'mcp-delegate'`：无本地令牌与 CLI 时生成结构化任务载荷（含 `<!-- pf-state:... -->` 隐式状态标记），交由宿主 MCP 通道代为执行。
  4. `tier: 'half-duplex'` / `'offline'`：仅通 SSH 推送时提供一键创建 PR 链接；完全离线时走本地工作流闭环。
- **平台交互卫生**：所有带非 ASCII 字符的正文（Issue、PR、评论、Release 说明）一律先写系统临时目录 UTF-8 文件并通过 `--body-file` 或 JSON 请求体提交、回读核验后删除临时文件；Fork PR 上设置标签遇到 403 权限不足时自动返回 `{ skipped: true, reason: 'no-permission' }` 而非中断主流程。

## 文档四层体系、五档分流与 `AGENTS.md` 预算约束

1. **文档四层分层**：
   - **入口契约层**（`AGENTS.md`）：仅存当前系统机制、`行事总纲`、工程红线、构建门禁、7 键 Dev Profile（`quick-test` / `full-test` / `smoke-verify` / `merge-gate` / `arch-rules` / `high-risk` / `do-not-edit`）与静默自然语言意图路由表。受硬预算 `AGENTS_MAX_BYTES = 30720`（30KB）与 `AGENTS_WARN_BYTES = 24576`（24KB）严格约束；`compose-agents.mjs` 结合 `.pf-manifest.json` 中的 `agentsRegions` 基线 SHA256 实现**未标 `customized` 的无损防覆盖保护**——若用户手改过受管区间且与旧基线不符，刷新直接保护跳过而不是静默覆盖。
   - **常青架构层**（`docs/TDD.md`）：沉淀稳定技术架构、模块禁引边界与功能入口地图，与代码演进同步。
   - **需求基线层**（`docs/prd/`）：跨周期、多模块产品需求契约（按需建立，含 `- Plan Critique: pending/passed`）。
   - **变更规范与任务单层**（`docs/specs/` + `docs/todo/` -> `docs/archive/todo/`）：均要求包含 `复用既有模块`、`本期不做`、`门型与回滚路径（two-way / one-way）`；设计规范以 `Status: draft | approved | implemented | superseded` 与 `Plan Critique` 生命周期留档；任务单记录冻结的 `- [ ] C1:` 验收标准，经 `doc-plan.mjs audit` 拦截占位/套话/幻觉路径后再推进，PR 合流前随同一分支完成全勾与归档至 `docs/archive/todo/`。
2. **五档分流、分级内审与门型评估（`dev-plan`）**：
   - `Case 1`（纯问答/微调文档）：零文档直接响应（`critiqueTier: none`）。
   - `Case 2`（边界清晰的局部缺陷修复，不改契约）：零设计文档，强制 Red-Green 回归测试。
   - `Case 3`（不改外部契约的中等增量功能）：只建 `docs/todo/<yymmdd>-<slug>.md` 冻结验收标准，运行 `doc-plan.mjs audit` 自修直通（`critiqueTier: self-audit`）。
   - `Case 4`（跨模块、改公共契约或高风险/`one-way` 路径）：建立 `docs/specs/` + `docs/todo/`；先跑 `audit` 再经 1–2 轮独立只读 Plan Critique 写入 `critique-pass`（带正文 SHA256 防篡改锁定）才允许 `approve`（或人传 `--skip-critique-reason` 豁免）。
   - `Case 5`（与 `docs/TDD.md` 或生效 `SPEC` 冲突）：硬阻断实现，先行升级常青文档并同级内审取得人工拍板。

## Worktree 共享依赖零拷贝挂载与防删穿机制

`kit/skills/dev-flow/scripts/worktree-deps.mjs` 与 `flow.mjs` 通过任务账本 `.worktrees/.state/tasks/<taskId>.json` 管理开发与审查双 Worktree 生命周期：

1. **锁文件指纹判定**：对比主工作区与新 Worktree 的锁文件（如 `package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`）SHA256 指纹。
2. **零拷贝挂载与降级隔离**：指纹一致时直接复用主仓依赖目录（Windows 使用 Directory Junction、类 Unix 使用 Symlink 挂载），实现秒级免安装启动；指纹不一致或目标目录已作为实体目录存在时自动退回独立安装隔离。
3. **防删穿铁律（先 `unlinkSync` 再清理）**：Windows `fs.rmSync(dir, { recursive: true })` 或外围目录清理工具若直接作用于未解绑的目录连接或损坏链接有误伤/删穿宿主目录风险。因此 `unmountSharedDeps()` 与 `flow.mjs cleanup` 强制在 `git worktree remove` 或目录删除**之前**，先显式校验链接属性（`lstatSync().isSymbolicLink()`）并调用 `fs.unlinkSync(mountPath)` 仅摘除挂载入口本身，确认与主仓物理脱离后才删除 Worktree。

## 审查安全门禁、收尾七步与全套验收链路

- **外部 PR 安全屏障**：对未知作者提案运行 `review-pack.mjs --untrusted-scan`，静态扫描 `.github/workflows/`、生命周期钩子（`preinstall`/`install`/`postinstall`/`prepare`）、构建脚本、`git hooks`（`.husky/`）、`.agents/skills/`、`.gitattributes`、锁文件变更与断言弱化特征；命中即输出 `BLOCKED_UNTRUSTED_HAZARD` 并以非零退出码拦截执行，仅在明确传入 `--human-approved-exec` 后才放行并强制建议使用 `--ignore-scripts` 隔离。
- **独立审查六锁止损**：任务账本强校验 `reviewerId !== implementerId`；Round 1 全量审核、Round 2 锁定未改动旧块仅审增量 + `rebuts`、Round 3 二元验证；第 3 轮未收口或同一问题指纹连续 2 轮重复出现时触发 `STOP_LOSS_ESCALATE` 强制停损交由人类维护者裁决。
- **双门审查与弱化门禁硬阻断**：`review-pack.mjs` 输出 `behavioralGate`（测试 + `smoke-verify` 运行实证，杜绝人肉代理）、`structuralGate`（新增 diff 中的墓碑履历注释、借口/擅自压制检查、`arch-rules` 跨层引用与 `>800` 行神文件）与 `doorAssessment`（`two-way` / `one-way`）；`flow.mjs merge` 检测到删断言、新增 `.skip`/`.only`、`continue-on-error: true`、`|| true` 或改松 CI 权限时默认以退出码 `4`（`BLOCKED_GATE_WEAKENING`）阻断，必须 `--human-approved` 方可合入。
- **园艺治理、四态 Worktree 与规则下沉**：`govern-audit.mjs` 通过 `git cherry`/`git patch-id` 精准识别 `merged` / `squash_or_rebase_merged` / `no_own_commits` / `unmerged` 四态；支持 `record`（写 `<gitCommonDir>/project-forge-govern/signals.jsonl` 零工作区污染）、`cluster`（满 2 次根因下沉静态检查）与 `sample`（回滚率与 48h 返工热点抽检）。
- **状态机防越权锁**：代码改动后必须重新运行 `finalize`（含 `todo` 归档与 `spec` 更新）及 `verify`（含 `--mode smoke --target`）使 `verifiedHead === HEAD` 方可 `submit`；`contributor-fork` 禁止 `merge`；`cleanup` 无 `--confirm` 时只输出待删清单并询问人类确认，有 `--confirm` 且上游 Fork PR 仍为 `OPEN` 时硬阻断删分支防误关 PR。
- **项目自身门禁闭环**：本仓库修改完成后，必须通过 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`、`sync-toc.mjs --check`、`git archive` 导出包边界校验、`govern-audit.mjs audit .` 及 `verify-injections.mjs` 故障注入自证（全部退出码为 0）方可视为通过。
