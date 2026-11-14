# v5 架构升级设计规范

Status: implemented
Date: 2026-11-14
Owner: project-forge 维护协作编排组

## 背景与目标

`project-forge` v4 版本聚焦于仓库基础治理（`survey`、`compose-agents`、`review`、`handoff`），在实际跨仓与日常研发使用中暴露出四类结构性缺口：

1. **治理与日常研发脱节**：缺少内置、可随包同步到目标项目 `.agents/skills/` 的日常探索、规划、隔离流转、独立审查与技术债巡检闭环，且缺少 `empty` 空目录零文件起步能力。
2. **身份与 GitHub 探测误判**：`git clone` 他人公开/声明仓库易误判为 `maintainer`；纯 SSH 环境运行 `--probe-auth` 会误报 `no-credential`；单通道依赖 `gh` CLI，在无 CLI/无外网/受限 Token 场景缺少优雅降级。
3. **跨月升级覆盖与退役残留风险**：目标项目手改 `AGENTS.md` 受管区间或定制内置 Skill 后，缺少基于 SHA256 基线的无损防覆盖保护，且旧版移除文件无法自动清理。
4. **并行 Worktree 与外部 PR 安全隐患**：多分支并发开发缺少零拷贝依赖共享与防删穿卸载保护；外部 PR 缺少供应链投毒静态拦截，多轮审查缺少强制防死循环止损，且历史门禁 `ask-before-delete` 与 `homePathLeaks` 存在遗留隐患。

v5 架构升级围绕上述问题完成双层同构工程化重构。

## 冻结验收标准（C1..C12）

- [x] C1: **双层同构与包边界隔离** — `kit/skills/` 纳入用户包；`.agents/` 与 `docs/` 对齐 `.gitattributes` `export-ignore` 与 `protocol.mjs` `REPO_ONLY_*` 排除列表；`SKILL.md`（`<= 185` 行、`< 18432` 字节、`version: 5.0.0`）与 `kit/` 不含本仓私有路径（如 `docs/work`、`scripts/dev`、`docs/release-notes`）及非 GitHub 平台词。
- [x] C2: **三态 SHA256 账本与幂等装配** — `scripts/equip.mjs` 将 `kit/skills/**` 同步到 `.agents/skills/**` 并维护 `.agents/skills/.pf-manifest.json`（含 `files` 与 `agentsRegions` SHA256）；实现幂等覆盖、未改自动升级、退役文件物理自净化与用户定制 100% 保留；`--check` 零写入执行字节级校验。
- [x] C3: **空白项目 0 文件起步** — `scripts/equip.mjs --bootstrap-empty --lang <node|python|go|rust|docs> --name <name>` 为空目录生成零第三方依赖的可运行骨架、冒烟测试与初始 `docs/TDD.md`，且生成项目可实际跑通冒烟测试。
- [x] C4: **双轴五态身份判定与防误判修复** — `scripts/lib/platform/index.mjs` 与 `survey.mjs` 联合远端拓扑与写权限/所有权证据判定 `local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `undetermined`；修复 `git clone` 他人仓误判为 `maintainer` 的缺陷，同时正确识别缺 `declaredRepo` 的自有仓库与 `contributor-fork` 的 `upstream`。
- [x] C5: **双轨四级 GitHub 引擎与脱敏安全** — `probeGitHubEnv` 强制无交互环境变量（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`BatchMode=yes`）；Track A 探测 SSH 22/443 与 HTTPS credential helper 并给出协议错配 `remediationCmd`（纯 SSH 不误报 `no-credential`）；Track B 支持 `gh-cli` -> `node-https-token` -> `mcp-delegate` -> `half-duplex` / `offline` 四级降级；token 不进返回值/stdout/JSON；403 设标签降级为 `{ skipped: true }`。
- [x] C6: **文档四层体系与 `AGENTS.md <= 30KB` 无损演进** — 建立 `AGENTS.md` + `docs/TDD.md` + `docs/prd/` + `docs/specs/` + `docs/todo/`（PR 前归档至 `docs/archive/todo/`）模板体系并清理 `templates/work-item.md`；`templates/agents-project.md` 增加静默路由表、Dev Profile 与同步合并收尾 7 步；`compose-agents.mjs` 强制 `AGENTS_MAX_BYTES = 30720`（`24576` 预警）与 `agentsRegions` SHA256 防覆盖保护。
- [x] C7: **目录自包含探索与五档分流规划** — `kit/skills/lib/shared.mjs` 与 `dev-explore`/`dev-plan` 100% 自包含；`repo-map.mjs` 只读生成结构与热点地图；`doc-plan.mjs` 实现 Case 1..5 五档分流、`init`/`approve`/`list` 及 `[NEXT STEP]` 导航。
- [x] C8: **Worktree 共享依赖零拷贝挂载与防删穿** — `worktree-deps.mjs` 在锁文件一致时挂载 Directory Junction（Windows）或 Symlink（类 Unix），不一致时退回隔离；`unmountSharedDeps` 先执行 `fs.unlinkSync()` 解绑再删 worktree，主仓库共享依赖目录完好无损。
- [x] C9: **全流程任务状态机与安全防误删锁** — `flow.mjs` 基于 `.worktrees/.state/tasks/<taskId>.json` 跟踪状态；`inspect` 支持已有 Issue+PR 接管复用并解析多 Issue 依赖边；未 `finalize` 或 `verifiedHead !== HEAD` 时阻断 `submit`；`contributor-fork` 禁止 `merge`；PR `OPEN` 或缺乏 `--confirm` 时 `cleanup` 硬阻断删除分支。
- [x] C10: **外部 PR 供应链拦截与六锁审查收口** — `review-pack.mjs --untrusted-scan` 对触碰工作流、生命周期脚本（如 `postinstall`）等的 diff 输出 `BLOCKED_UNTRUSTED_HAZARD` 非零阻断，普通业务 diff 放行；`record` 拒绝 `reviewerId === implementerId`；轮次 `>= 3` 或连续 2 轮同指纹未收口触发 `STOP_LOSS_ESCALATE`。
- [x] C11: **全量技术债治理与对齐巡检** — `govern-audit.mjs` 实现 `--audit-only`、`--plan-only`、`--execute`、`--scope`、`--categories`、`--loop`、`--issues`/`--apply-issues` 及 `reconcile`（巡检 `AGENTS.md` 体积/路径、`docs/TDD.md` 漂移、陈旧 worktree、`.pf-manifest.json` 与卫生项）。
- [x] C12: **全仓自举、门禁补强与故障注入实证** — 迁移 `docs/work/` 至 `docs/archive/todo/` 并消除本机路径泄露使 `homePathLeaks` 归零；完成本仓 `equip.mjs .`、`compose-agents.mjs .` 与 `sync-toc.mjs` 自举；升级 `preflight.mjs`（修复「删前必问」假阴性、去掉重复调用、新增一致性/路径泄露/平台词/30KB/180 行校验）、`fixtures.mjs`（补齐 `C1..C11` 双向实跑）与 `verify-injections.mjs`（对齐新模板并新增 `I19..I24`），全部 9 条验证命令退出码为 0。

## 模块化设计与实现边界

### 核心底座与安装装备（`scripts/lib/` & `scripts/`）

- `scripts/lib/protocol.mjs`：集中维护 `AGENTS_MAX_BYTES = 30720`、`AGENTS_WARN_BYTES = 24576`、`KIT_SKILL_MAX_LINES = 180`、`KIT_SKILLS`、`FORBIDDEN_PLATFORM_RE`、`PF_MANIFEST_REL`、`WORKTREES_STATE_REL` 及更新后的 `REPO_ONLY_DIRS`（纳入 `.agents/` 与 `docs/`）。
- `scripts/lib/platform/github.mjs` & `index.mjs`：提供非交互探测、双轨四级 API 封装与双轴五态纯函数判定，支持测试环境变量与探测桩注入。
- `scripts/equip.mjs`：负责同步 `kit/skills/**`、三态账本维护、`--check` 字节比对以及 `--bootstrap-empty` 五语言工程生成。
- `scripts/survey.mjs` / `review.mjs` / `compose-agents.mjs` / `handoff.mjs` / `update.mjs`：打通新五态身份、`--probe-auth`、`docs/` 四层探测、`AGENTS.md` 字节门禁与受管区间哈希保护，同时保持 `gap-coverage.mjs` 100% 映射闭环。

### 内置研发 Skill 套件（`kit/skills/`）

- `kit/skills/lib/shared.mjs`：纯 `node:*` 工具集，包含 `AGENTS.md` Dev Profile 解析、原子文件操作、任务账本读写、四级 GitHub 客户端与 `printNextStep`。
- `dev-explore` / `dev-plan` / `dev-flow` / `dev-review` / `dev-govern`：严格控制在每份 `SKILL.md <= 180` 行、无 `kit/skills/` 外部 `import`、无本仓私有路径引用。

### 门禁与双层自举治理（`scripts/dev/` & `docs/`）

- 本仓自举运行 `equip.mjs .` 生成受 `.gitattributes` 保护不进用户包的 `.agents/skills/**` 与 `.pf-manifest.json`，并通过 `preflight.mjs` 强制核对 `kit/skills/` 与 `.agents/skills/` 字节级同构。
- `preflight.mjs` 修复历史「删前必问」段落检索窗口过宽导致的假阴性，并强化对产品层平台词、私密路径、预算上限的自动化扫描；`fixtures.mjs` 与 `verify-injections.mjs` 对新增与既有核心判据实现双向证伪与故障注入验证。
