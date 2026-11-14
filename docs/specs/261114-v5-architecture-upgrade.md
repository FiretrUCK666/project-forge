# v5 架构升级设计规范

Status: implemented
- Plan Critique: passed (reviewer=independent-wave2, round=1, sha=90206642c1d6, summary=Wave 2 dual-layer architecture, backup.mjs, audit/critique gates, smoke/dual-gate review, and govern clustering verified.)
Date: 2026-11-14
Owner: project-forge 维护协作编排组

## 背景与目标

`project-forge` v4 版本聚焦于仓库基础治理（`survey`、`compose-agents`、`review`、`handoff`），在实际跨仓与日常研发使用中暴露出四类结构性缺口：

1. **治理与日常研发脱节**：缺少内置、可随包同步到目标项目 `.agents/skills/` 的日常探索、规划、隔离流转、独立审查与技术债巡检闭环，且缺少 `empty` 空目录零文件起步能力。
2. **身份与 GitHub 探测误判**：`git clone` 他人公开/声明仓库易误判为 `maintainer`；纯 SSH 环境运行 `--probe-auth` 会误报 `no-credential`；单通道依赖 `gh` CLI，在无 CLI/无外网/受限 Token 场景缺少优雅降级。
3. **跨月升级覆盖与退役残留风险**：目标项目手改 `AGENTS.md` 受管区间或定制内置 Skill 后，缺少基于 SHA256 基线的无损防覆盖保护，且旧版移除文件无法自动清理。
4. **并行 Worktree 与外部 PR 安全隐患**：多分支并发开发缺少零拷贝依赖共享与防删穿卸载保护；外部 PR 缺少供应链投毒静态拦截，多轮审查缺少强制防死循环止损，且历史门禁 `ask-before-delete` 与 `homePathLeaks` 存在遗留隐患。

v5 架构升级围绕上述问题完成双层同构工程化重构，并在 Wave 2 增量补强写前增量 `.tar.gz` 快照（`scripts/backup.mjs`）、`行事总纲`、7 键 `Dev Profile`（新增 `smoke-verify` 与 `arch-rules`）、`dev-explore` 三级探索与 `Feature Map`、分级规划自净化（`audit`/`critique-pass`）、`dev-flow` 冒烟实证与弱化门禁退出码 `4` 阻断、`review-pack` 行为/结构双门与门型评估，以及 `govern-audit` 8 项深度审计与 `record`/`cluster`/`sample` 规则下沉抽检。

## 复用既有模块

- 复用 `scripts/lib/protocol.mjs`（标记与预算常数）、`scripts/lib/template.mjs`（条件与变量求值）、`scripts/lib/render.mjs`（勘察报告与导航）、`scripts/lib/claims.mjs`（路径与分支回查）与 `scripts/lib/platform/github.mjs`（双轨四级 GitHub 客户端）。
- 复用 `kit/skills/lib/shared.mjs` 作为内置 5 套 Skill 的唯一零依赖自包含共享内核，并在其中集中实现 `evaluateArchRules` 与 `classifyDoorType`。

## 本期不做

- 不引入任何第三方 npm 依赖或二进制构建步骤，保持纯 Node 18+ `node:*` 内置模块运行。
- 不支持非 GitHub 托管平台或绑定特定宿主私有路径与环境变量。
- 不在未经人类明确确认的情况下自动执行发版、强推、修改仓库可见性或删除本地/远端分支与 Worktree。

## 门型与回滚路径

- 门型：`two-way`（仓库内版本化重构与多模块治理脚本升级，所有产物均受 `.git` 历史、`.agents/skills/.pf-manifest.json` 账本及 `scripts/backup.mjs` 仓外 `.tar.gz` 快照保护）。
- 回滚路径：未提交改动可直接丢弃或运行 `node scripts/backup.mjs restore` 回退；已合并提交可通过 `git revert` 反向提交还原，不改写已推送历史。

## 冻结验收标准（C1..C12）

- [x] C1: **双层同构与包边界隔离** — `kit/skills/` 纳入用户包；`.agents/` 与 `docs/` 对齐 `.gitattributes` `export-ignore` 与 `protocol.mjs` `REPO_ONLY_*` 排除列表；`SKILL.md`（`<= 185` 行、`< 18432` 字节、`version: 5.0.0`）与 `kit/` 不含本仓私有路径（如 `scripts/dev`、`docs/release-notes`）及非 GitHub 平台词；产品层禁引 `scripts/dev/` 经 `preflight.mjs` 与 `arch-rules` 双重校验。
- [x] C2: **三态 SHA256 账本、幂等装配与写前快照** — `scripts/equip.mjs` 将 `kit/skills/**` 同步到 `.agents/skills/**` 并维护 `.agents/skills/.pf-manifest.json`；写前由 `scripts/backup.mjs` 在仓外创建滚动 5 份的 `.tar.gz` 快照（支持 `create`/`list`/`restore` 与 `--no-backup`，零变更不冗余备份，还原清理无主文件）。
- [x] C3: **空白项目 0 文件起步** — `scripts/equip.mjs --bootstrap-empty --lang node/python/go/rust/docs` 为空目录生成零第三方依赖的可运行骨架、冒烟测试与初始 `docs/TDD.md`（含 `arch-rules` 与 `Feature Map` 骨架），且生成项目可实际跑通冒烟测试。
- [x] C4: **双轴五态身份判定与防误判修复** — `scripts/lib/platform/index.mjs` 与 `scripts/survey.mjs` 联合远端拓扑与写权限/所有权证据判定 `local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `undetermined`；修复 `git clone` 他人仓误判为 `maintainer` 的缺陷，同时正确识别缺 `declaredRepo` 的自有仓库与 `contributor-fork` 的 `upstream`。
- [x] C5: **双轨四级 GitHub 引擎与脱敏安全** — `probeGitHubEnv` 强制无交互环境变量（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`BatchMode=yes`）；Track A 探测 SSH 22/443 与 HTTPS credential helper 并给出协议错配 `remediationCmd`；Track B 支持 `gh-cli` -> `node-https-token` -> `mcp-delegate` -> `half-duplex` / `offline` 四级降级；token 不进返回值/stdout/JSON；403 设标签降级为 `{ skipped: true }`。
- [x] C6: **文档四层体系与 `AGENTS.md <= 30KB` 无损演进** — 建立 `templates/agents-project.md`、`templates/docs-tdd.md`、`templates/docs-prd.md`、`templates/docs-spec.md` 与 `templates/docs-todo.md` 四层模板体系（PR 前归档至 `docs/archive/todo/`）；`templates/agents-project.md` 纳入 `行事总纲`、7 键 `Dev Profile`、`two-way`/`one-way` 门型分流与同步合并收尾 7 步；`compose-agents.mjs` 强制 `AGENTS_MAX_BYTES = 30720`（`24576` 预警）、`agentsRegions` SHA256 防覆盖保护与写前 `backup.mjs` 快照，本仓 `AGENTS.md` 压至 `24576` 字节以内。
- [x] C7: **目录自包含探索与五档分流规划内审** — `kit/skills/lib/shared.mjs` 新增 `evaluateArchRules` 与 `classifyDoorType`；`kit/skills/dev-explore/scripts/repo-map.mjs` 提取 `ciRunSteps`、`taskRunners`、`reusableModules`、`featureMap`；`kit/skills/dev-plan/scripts/doc-plan.mjs` 实现 Case 1..5 分流、`audit` 占位/套话/路径审查、`critique-pass` 防篡改锁定与分级 `approve`。
- [x] C8: **Worktree 共享依赖零拷贝挂载与防删穿** — `kit/skills/dev-flow/scripts/worktree-deps.mjs` 在锁文件一致时挂载 Directory Junction（Windows）或 Symlink（类 Unix），不一致时退回隔离；`unmountSharedDeps` 先执行 `fs.unlinkSync()` 解绑再删 worktree，主仓库共享依赖目录完好无损。
- [x] C9: **全流程任务状态机、冒烟实证与门禁阻断** — `kit/skills/dev-flow/scripts/flow.mjs` 支持接管、依赖解析、`verify --mode smoke --target`、`verifiedHead === HEAD` 校验、`merge` 检测 diff 弱化门禁以退出码 `4` 阻断（需 `--human-approved`）、`contributor-fork` 禁合并、`OPEN` PR 防删锁与无 `--confirm` 只列清单。
- [x] C10: **外部 PR 投毒拦截与双门六锁审查收口** — `kit/skills/dev-review/scripts/review-pack.mjs --untrusted-scan` 拦截工作流/钩子投毒（`BLOCKED_UNTRUSTED_HAZARD`）；输出 `behavioralGate`、`structuralGate`（墓碑/借口压制/神文件/`arch-rules`）与 `doorAssessment`；禁止自审；轮次 `>= 3` 或连续 2 轮同指纹未收口触发 `STOP_LOSS_ESCALATE`。
- [x] C11: **全量技术债治理、四态 Worktree 与规则下沉** — `kit/skills/dev-govern/scripts/govern-audit.mjs` 实现演进温差、围栏死链、死代码块与借口/墓碑注释、神文件、`arch-rules`、孤儿测试、4 态 Worktree 判定（`merged`/`squash_or_rebase_merged`/`no_own_commits`/`unmerged`），以及 `record`、`cluster`、`sample` 与 `reconcile`。
- [x] C12: **全仓自举、门禁补强与故障注入实证** — 迁移历史任务单至 `docs/archive/todo/` 并清零 `homePathLeaks`；完成本仓 `equip.mjs .`、`compose-agents.mjs .` 与 `sync-toc.mjs` 自举；升级 `preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs`（含 `I19..I28`），全部 10 道门禁退出码为 0。

## 模块化设计与实现边界

### 核心底座与安装装备（`scripts/lib/` & `scripts/`）

- `scripts/lib/protocol.mjs`：集中维护 `AGENTS_MAX_BYTES = 30720`、`AGENTS_WARN_BYTES = 24576`、`KIT_SKILL_MAX_LINES = 180`、`KIT_SKILLS`、`FORBIDDEN_PLATFORM_RE`、`PF_MANIFEST_REL`、`WORKTREES_STATE_REL` 及 `REPO_ONLY_DIRS`（纳入 `.agents/` 与 `docs/`）。
- `scripts/lib/platform/github.mjs` & `scripts/lib/platform/index.mjs`：提供非交互探测、双轨四级 API 封装与双轴五态纯函数判定，支持测试环境变量与探测桩注入。
- `scripts/backup.mjs` & `scripts/equip.mjs`：提供跨平台 POSIX USTAR/PAX `.tar.gz` 仓外写前备份（`ensurePreWriteBackup`）、`kit/skills/` 三态账本同步、`--check` 字节比对与 `--bootstrap-empty` 五语言起步。
- `scripts/survey.mjs` / `scripts/review.mjs` / `scripts/compose-agents.mjs` / `scripts/handoff.mjs` / `scripts/update.mjs`：打通新五态身份、`--probe-auth`、`docs/` 四层探测、`AGENTS.md` 字节门禁与 `backup.mjs` 写前保护，同时保持 `scripts/dev/gap-coverage.mjs` 100% 映射闭环。

### 内置研发 Skill 套件（`kit/skills/`）

- `kit/skills/lib/shared.mjs`：纯 `node:*` 工具集，包含 `AGENTS.md` Dev Profile 解析、原子文件操作、任务账本读写、四级 GitHub 客户端与 `printNextStep`。
- `dev-explore` / `dev-plan` / `dev-flow` / `dev-review` / `dev-govern`：严格控制在每份 `SKILL.md <= 180` 行、无 `kit/skills/` 外部 `import`、无本仓私有路径引用。

### 门禁与双层自举治理（`scripts/dev/` & `docs/`）

- 本仓自举运行 `equip.mjs .` 生成受 `.gitattributes` 保护不进用户包的 `.agents/skills/**` 与 `.pf-manifest.json`，并通过 `preflight.mjs` 强制核对 `kit/skills/` 与 `.agents/skills/` 字节级同构。
- `preflight.mjs` 修复历史「删前必问」段落检索窗口过宽导致的假阴性，并强化对产品层平台词、私密路径、预算上限的自动化扫描；`fixtures.mjs` 与 `verify-injections.mjs` 对新增与既有核心判据实现双向证伪与故障注入验证。
