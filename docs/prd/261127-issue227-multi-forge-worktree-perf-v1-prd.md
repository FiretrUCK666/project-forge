---
kind: prd
title: 多远端平台统一适配、并发 Worktree 依赖安全与全仓低 CPU 提速
status: active
created: 2026-11-27
updated: 2026-11-28
issue: 227
pr: null
owner: plan-c-master
plan_mode: interactive
plan_critique: "passed (reviewer=critic-c-r2, round=2, sha=3ad00c571d15, summary=R2 verified all 5 R1 major findings closed: C1..C13 1:1 aligned with 4 slice SPECs/Todos, Wave 1A/1B 0 scope overlap, tight file budget <=780L, Windows NTFS readonly pool & .cmd hardening + execSafe no-throw, master-criteria-sync includeSelf=false & preserveChecked=false default, zero private leakage, zero emoji, arch-rules compliant.)"
related_spec: null
related_todo: null
multi_spec: true
---

# 多远端平台统一适配、并发 Worktree 依赖安全与全仓低 CPU 提速 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-27` / `2026-11-28` |
| 关联 Issue / PR | #227 / 未关联 |
| 提出方 / 负责人 | `plan-c-master` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联设计 / 任务单 | 4 份解耦切片 `SPEC + Todo`（见「切片波次总览」） |

- **目标读者**：实现者、独立审查者与维护者

## 一、要解决的问题

### 现状与痛点

1. **全仓验证脚本高 CPU 抢占与冗余子进程风暴**：
   - `scripts/dev/verify-injections.mjs` 共 503 条故障注入（471 条 fixtures + 32 条 preflight），其中 471 次 `fixtures.mjs --only` 每次无条件 `await import()` 全部 86 个测试文件（实测单次加载 325 ms，累计约 153 s 纯冗余 CPU）。
   - `scripts/dev/fixtures.mjs`、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/merge-gate.mjs`、`scripts/dev/verify-injections.mjs` 与 `kit/skills/dev-iterate/scripts/iterate.mjs` 默认不预留前台 CPU 核心且全仓 0 处使用 `os.setPriority`，并发验证时极易打满宿主前台桌面。
   - `scripts/dev/preflight-e2e.mjs` 的 `checkHelps` 并发派生 8 次 `node scripts/*.mjs --help`（累计 1334 ms），且 `scripts/sync-toc.mjs` 与 `scripts/update.mjs` 尚未导出 `runCli`；`scripts/dev/fixtures-helpers.mjs` 的 `IN_PROCESS_CLI_SCRIPTS` 遗漏 `verify-tools.mjs`/`doc-locate.mjs`/`edit-gate.mjs`/`iterate.mjs`/`equip-ci.mjs`（且未兼容 `mod.main`）；`kit/skills/dev-edit/scripts/edit-gate.mjs`（772 行）、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs` 与 `scripts/lib/survey-workspace.mjs` 存在循环内逐文件派生 `git show` / `git cat-file` / 重复 `git ls-files` / 同步 `git check-ignore` 热点。
2. **多远端托管平台与局域网环境残留 `github` / `gh` 硬假设**：
   - 双端注册表（`kit/skills/lib/platform-registry.mjs` 与 `scripts/lib/platform/registry.mjs`）仅注册 `github` 且仅有 8 键能力矩阵（缺 `uploadAttachment` 与 `checks`）；`kit/skills/lib/platform-probe.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/github-labels.mjs`、`kit/skills/lib/platform.mjs` 与 `kit/skills/lib/task-backend.mjs` 对非 GitHub 仓直接硬退化为 `offline` / `generic-git`，且仅支持 `https://api.github.com`、仅脱敏 GitHub 令牌。
   - 业务与渲染脚本（`flow-*.mjs`、`review-pr.mjs`、`review-sync.mjs`、`plan-sync.mjs`、`escalation.mjs`、`task-graph.mjs`、`workflow-policy-next.mjs` 与 `scripts/{survey,review,equip-ci}.mjs`、`scripts/lib/navigation.mjs`、`scripts/lib/render.mjs`）散落多处 `providerId === 'github'`、`githubRepoFull` 与 `pull/<N>/head` 硬假设，无法无缝支持公有或自建企业 GitLab/GitCode、Gitee、Gitea/Forgejo 及局域网 IP / 纯离线仓库。
3. **多 Worktree 并发依赖写穿、批处理注入与策略漏洞**：
   - `kit/skills/dev-flow/scripts/worktree-deps.mjs`（当前已 777 行，逼近 800 行红线）仅覆盖 Node/Python 且采用可写直连主仓 `symlinkSync`，并发跑构建/测试会踩踏 `node_modules` 内的 `.vite`/`.cache`/`.prisma`，缺改后漂移自动 `detach`/`reconcile`、无锁只改清单盲区、Windows NTFS 只读目录递归撤只读位清理及 junction 非递归清理兜底。
   - `kit/skills/lib/exec.mjs` 的 `computeWorktreeEnv` 未重定向 `VITE`/`JEST`/`BABEL`/`ESLINT`/`CARGO_TARGET_DIR` 缓存，且 `quoteForCmdArg` 在 Windows `.cmd`/`.bat` 场景受 CVE-2024-27980 元字符逃逸影响（须同时避免误杀 `Program Files (x86)` 与测试垫片正常参数，并维护 `execSafe` 永不抛异常契约）。
   - `kit/skills/lib/workflow-policy.mjs` 的 `isOneWayBoundaryFile` 漏覆盖 NoSQL/ORM/KV/向量库、Proto/GraphQL/OpenAPI 与 Docker/K8s/Helm/Terraform；`resolveScopedVerificationGate` 读取 `p?.dir`/`p?.ecosystem` 与 `profile-sniffer.mjs` 实际返回 `{ dirRel, ecosystems }` 错位；`flow-intake.mjs` `--apply` 缺少写前 `contextBasis` 防脏写复核且帮助文案与枚举不一致。
4. **实证附件生命周期与三项已实证同步缺陷**：
   - 缺乏仓外 `<gitCommonDir>/project-forge-flow/artifacts/<taskId>/` 统一暂存与销毁闭环及 `capabilities.uploadAttachment` 自动上传/摘要降级渲染。
   - 存在 3 项已实证线上同步缺陷：PR `#215`（`flow-inspect.mjs` 两处 `planBootstrap` 误挂子切片 SPEC 致 PR 标题与验收清单错位）、Issue `#219`（`1:N` 多波次 `plan-backfill` 将已归档兄弟波次 `[x] C1..C8` 刷回 `[ ]`，同时必须防范非终态误勾当前未完成切片 `C*`），以及 PR 详单表格与 Issue `pf:plan-summary` 割裂且未兼容目标仓 GitLab 默认 MR 模板（`.gitlab` 下 `merge_request_templates` 目录 `Default.md`）。

### 目标用户与使用场景

- **多平台与内网工程团队**：在 GitHub、公有或自建企业 GitLab/GitCode 实例、Gitee、Gitea/Forgejo、局域网裸仓及纯离线环境下，零手工补丁运行完整 `survey -> equip -> dev-plan -> dev-flow -> dev-edit -> dev-review -> dev-govern` 研发闭环。
- **高并发多 Worktree 与桌面开发用户**：同时并行推进多个隔离 Worktree 切片与重型自检门禁，避免依赖写穿、锁漂移与电脑前台卡顿。

### 产品目标

- **低 CPU 与提速不弱化**：引入零依赖进程预算调度原语（默认留 2 核 + `PRIORITY_BELOW_NORMAL`），`fixtures.mjs --only`（含跨文件 `import` 闭包解析与 `--domain` 单域懒加载）冷启从 ~325 ms 降至 ~15 ms 级别，消除循环内逐文件 `git` 子进程与同步 `git check-ignore`，全量门禁与故障注入 0 弱化。
- **全平台零补丁统一抽象**：双端注册表升级为 10 键能力矩阵 + 5 内置方言（`github`/`gitlab`/`gitcode`/`gitee`/`gitea`）+ `generic-git` 兜底，支持多级群组、`refs/merge-requests/<iid>/head` 真 SHA（含离线/浅仓回退与 `shaSource`）、客户端分支二次过滤、4 字节字符守卫、公网 `http://` 与链路本地元地址 Fail-Closed 拦截、全平台令牌脱敏与原生 `/uploads` 附件上传/自动摘要降级。
- **并发 Worktree 依赖安全与防注入硬化**：落地 Class R / S / I 三类通用重目录分层与仓外只读 `dep-pool`（含 Windows NTFS 递归撤只读位清理）、彻底封堵 Windows `.cmd`/`.bat` CVE-2024-27980 注入（优先解析 `npm`/`pnpm`/`npx`/`yarn` 底层 JS 直调 `node` 且护住 `execSafe` 不抛异常契约）、补齐单向门与 `dirRel/ecosystems` 字段修复及 `contextBasis` 防脏写分诊。
- **三大同步缺陷单源根治与离线 Mock Forge E2E**：新增独立单源模块 `kit/skills/lib/master-criteria-sync.mjs` (new) 根治 PR `#215` 与 Issue `#219`（含 `includeSelf = false` 与显式反选兼容）、统一 PR/Issue 详单表格，并建成纯 Node `node:http` Mock Forge + `git init --bare` 离线双向 E2E 矩阵与 opt-in 环境变量私有测试仓验证入口。

## 二、范围与非目标

### 本次要做（In Scope）

1. **Wave 1A — `low-cpu-script-perf`（认领 `C1..C3`，与 Wave 1B 写域 100% 零交集）**：进程并发与低优先级原语 `kit/skills/lib/proc-budget.mjs` (new)、`fixtures.mjs` `--only`（跨文件 `import` 闭包 + `--domain` 单域懒加载 + 0 命中回退全量）、`fixtures-helpers.mjs` 进程内脚本补齐与 `mod.runCli ?? mod.main` 兼容、`scripts/sync-toc.mjs`/`scripts/update.mjs` 补齐 `runCli` 并令 `preflight-e2e.mjs` 单子进程校验 8 脚本 `--help`、`readBlobBatch` 下沉 `kit/skills/lib/git-fast-objects.mjs` 瘦身 `edit-gate.mjs` 与 `govern-checks*.mjs`、`survey-workspace.mjs` 消除同步 `git check-ignore`，配 `scripts/dev/fixtures-perf-budget.mjs` (new) 与故障注入。
2. **Wave 1B — `multi-forge-platform-core`（认领 `C4..C6`，与 Wave 1A 写域 100% 零交集）**：双端 10 键能力矩阵与 5 方言注册表、`kit/skills/lib/platform-http.mjs` (new)（公网 `http://` 与 `169.254.169.254`/`fe80::` Fail-Closed、3xx `Location` 脱敏、纯 `Buffer.concat` 随机 boundary multipart）、`kit/skills/lib/platform-providers.mjs` (new)（5 方言鉴权头、429 退避上限、真 SHA + `shaSource` 标注）、升级 `platform-probe.mjs`/`github-parse.mjs`/`github-labels.mjs`/`platform.mjs`/`task-backend.mjs` 与 `scripts/lib/platform/*`，同步升级 `preflight-suite.mjs`（含 `AbortSignal.timeout` 校验对齐）、`fixtures-platform.mjs`、`fixtures-repo-alignment.mjs` 及对应注入锚点。
3. **Wave 2 — `worktree-dep-pool-policy`（认领 `C7..C9`，依赖 Wave 1A + Wave 1B）**：`kit/skills/lib/worktree-dep-pool.mjs` (new)（含 Windows NTFS 递归撤只读位再删防 `EPERM`）与瘦身 `worktree-deps.mjs`、`profile.mjs` 支持 `worktree-shared-readonly:`、`exec.mjs` 缓存重定向与 Windows `.cmd`/`.bat` CVE-2024-27980 硬化（优先直调 `node` + 精准元字符拦截 + `execSafe` 内捕返回 `BLOCKED_UNSAFE_WIN_BATCH_ARG`）、`exit-codes.mjs` 登记两新阻断码、`workflow-policy.mjs` 单向门扩展与 `dirRel/ecosystems` 修复、`flow.mjs`/`flow-intake.mjs`/`intake-triage.mjs` `contextBasis` 防脏写复核与 `subcommand-parity.mjs` 对齐，同步对齐 `fixtures-w6c-harness-gates.mjs` 与注入锚点，配 `scripts/dev/fixtures-worktree-policy-v2.mjs` (new) 与故障注入。
4. **Wave 3 — `multi-forge-flow-sync-e2e`（认领 `C10..C13`，依赖 Wave 1A + Wave 1B + Wave 2，终态收口）**：全业务流与渲染脚本（含 `plan-sync.mjs` 与 `scripts/lib/render.mjs`）消除 `github`/`gh` 硬假设、仓外实证附件生命周期与 `capabilities.uploadAttachment` 对接、新增 `kit/skills/lib/master-criteria-sync.mjs` (new) 单源根治 PR `#215`（阻断 `flow-inspect.mjs` 两处自动挂载）与 Issue `#219`（`includeSelf = false` + 非终态 `preserveChecked: true` 且兼容显式反选）并瘦身全部紧文件至 `<= 780` 行、统一 PR/Issue 详单并对齐 `fixtures-empirical-cycle.mjs`、`scripts/dev/fixtures-multi-platform.mjs` (new) + opt-in 环境变量私有测试仓实测入口及全仓长青资产锁步收口。

### 明确不做（Non-Goals）

- 严禁在仓库代码、测试夹具或文档中硬编码任何特定私域公司域名、组织名、个人账号或访问令牌（所有自建企业 GitLab/GitCode 实例一律通过通用环境变量与配置驱动）。
- 严禁引入任何第三方 npm 依赖或外链图床服务；不支持原生附件上传的平台直接降级输出客观摘要，不向用户追问图床配置，不把截图二进制提交进 Git 分支历史。
- 不触碰任何外部生产业务仓库；真机自建平台验证严格通过 opt-in 环境变量驱动一次性临时私有测试仓并在结束时自动销毁。
- 不弱化任何既有门禁、不绕过 `edit-gate`、`preflight`、`merge-gate` 与 `verify-injections` 校验，不破坏 `arch-rules` 单向依赖或单文件 `<= 800` 行红线。

## 三、切片波次总览（1:N 并行与串行编排）

| 波次 | 切片任务 ID | 前置依赖 | 认领标准 | 关联设计文档 |
| --- | --- | --- | --- | --- |
| Wave 1A | `low-cpu-script-perf` | 无（`[]`） | `C1..C3` | `docs/specs/261127-issue227-low-cpu-script-perf-spec.md` |
| Wave 1B | `multi-forge-platform-core` | 无（`[]`） | `C4..C6` | `docs/specs/261127-issue227-multi-forge-platform-core-spec.md` |
| Wave 2 | `worktree-dep-pool-policy` | `low-cpu-script-perf`, `multi-forge-platform-core` | `C7..C9` | `docs/specs/261127-issue227-worktree-dep-pool-policy-spec.md` |
| Wave 3 | `multi-forge-flow-sync-e2e` | `low-cpu-script-perf`, `multi-forge-platform-core`, `worktree-dep-pool-policy` | `C10..C13` | `docs/specs/261127-issue227-multi-forge-flow-sync-e2e-spec.md` |

Wave 1A（19 文件）与 Wave 1B（20 文件）的 `scope_files` 保持 100% 零交集，可完全并行开发并按合入顺序回归验证；每片合入 `main` 均须执行 `node scripts/equip.mjs .` 与全量门禁保持绿灯，由 Wave 3 统一完成 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html` 与双语 `README` 收口。

## 四、复用既有模块

- `kit/skills/lib/git-fast-objects.mjs`（`readGitBlobTextFast` + 新增 `readBlobBatch`）与 `kit/skills/lib/git-index-fast.mjs`（`readGitIndexPathsFast`）
- `kit/skills/lib/exec.mjs`（`withFileLockSync`、`computeWorktreeEnv`、`prepareExecInvocation`、`execSafe`）
- `kit/skills/lib/exit-codes.mjs`（`EXIT` 四档登记与 `checkExitCodeParity` 单源契约）
- `kit/skills/lib/platform-registry.mjs`、`kit/skills/lib/platform-probe.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/github-parse.mjs`、`kit/skills/lib/github-labels.mjs`、`kit/skills/lib/task-backend.mjs` 与 `scripts/lib/platform/registry.mjs`
- `kit/skills/lib/profile.mjs` 与 `kit/skills/lib/profile-sniffer.mjs`（`discoverWorkspacePackages`）
- `kit/skills/lib/verify-state.mjs`（`resolveTaskScratchDir` / `isSafeTaskScratchPath` / `destroyTaskScratchDir` 仓外安全前缀范式）与 `kit/skills/lib/empirical-artifacts.mjs`
- `kit/skills/lib/doc-slice-graph.mjs`、`kit/skills/lib/plan-sync.mjs`、`kit/skills/lib/pr-template-hydrate.mjs`、`kit/skills/lib/handoff-package.mjs` 与 `kit/skills/dev-flow/scripts/flow-merge-claim.mjs`（`collectMasterIssueCriteriaState` 下沉迁移至独立模块 `kit/skills/lib/master-criteria-sync.mjs` (new)）

## 五、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 零依赖与体积 | `scripts/` 与 `kit/` 仅使用 Node 18+ `node:*` 内置模块；全部源码单文件严格 `<= 800` 行（高紧文件主动外提瘦身至 `<= 780` 行）；`arch-rules` 严格单向 | `node scripts/dev/preflight.mjs` 与 `node .agents/skills/dev-edit/scripts/edit-gate.mjs --final --json` |
| CPU 与性能预算 | 后台重型 worker 默认并发 `max(1, availableParallelism() - 2)` 并降为 `PRIORITY_BELOW_NORMAL`；`fixtures.mjs --only`（含 import 闭包）与 `--domain` 冷启从 ~325 ms 降至 ~15 ms 级别；`bench.mjs` 各项不倒退且 `review(self)` 余量明显提升 | `node scripts/dev/bench.mjs`、`node scripts/dev/fixtures.mjs --domain perf-budget` 与 `verify-injections.mjs` 实测对比 |
| 安全与隐私 | 封堵 Windows `.cmd`/`.bat` CVE-2024-27980（且不误杀合法路径/垫片并保 `execSafe` 不抛异常）；HTTP 请求公网 `http://` Fail-Closed、禁 `169.254.169.254`/`fe80::`、`redirect: 'manual'` + `Location` 脱敏、`AbortSignal.timeout`、全平台令牌脱敏与 4 字节字符守卫；仓内零硬编码私域域名/令牌；实证附件严格仓外零入 Git | `fixtures-platform.mjs`、`fixtures-worktree-policy-v2.mjs`、`fixtures-multi-platform.mjs` 与 `verify-injections.mjs` |
| 兼容性与降级 | 兼容 5 方言 + `generic-git` + 局域网 IP + 纯离线；兼容 `{ dirRel, ecosystems }` 与旧 `{ dir, ecosystem }`；兼容 `fixtures-issue-checklist-sync.mjs` 显式反选、`fixtures-w6c-harness-gates.mjs` 与 `fixtures-empirical-cycle.mjs`；兼容 `.github/pull_request_template.md` 与目标仓 GitLab 默认 MR 模板（`.gitlab` 下 `merge_request_templates` 目录 `Default.md`） | 正反双向夹具与全量 `node scripts/dev/merge-gate.mjs` |

## 六、验收标准

<!-- criteria:start -->
- [x] C1: 新增零依赖调度原语 `kit/skills/lib/proc-budget.mjs` (new)，导出 `resolveWorkerConcurrency`（默认 `max(1, availableParallelism() - 2)` 留出至少 2 核前台余量且支持 `--jobs` 显式覆盖）与 `applyLowPriority(pid)`（经 `os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)` 降级后台 worker 并安全吞掉权限异常），接入 `scripts/dev/verify-injections.mjs`、`scripts/dev/fixtures.mjs`、`scripts/dev/e2e-zip-harness.mjs`、`scripts/dev/merge-gate.mjs` 与 `kit/skills/dev-iterate/scripts/iterate.mjs`。
- [x] C2: `scripts/dev/fixtures.mjs` 实现 `--only` 跨文件 `import` 闭包预筛懒加载 + `--domain` 单域懒加载（冷启从 ~325 ms 降至 ~15 ms 级别，0 命中安全回退全量导入防漏检）；`scripts/dev/fixtures-helpers.mjs` 补齐 `IN_PROCESS_CLI_SCRIPTS` 覆盖 `verify-tools.mjs`/`doc-locate.mjs`/`edit-gate.mjs`/`iterate.mjs`/`equip-ci.mjs` 并兼容 `mod.runCli ?? mod.main`；`scripts/sync-toc.mjs` 与 `scripts/update.mjs` 补齐 `runCli` 导出且 `scripts/dev/preflight-e2e.mjs` 的 `checkHelps` 合并为单子进程批量校验 8 个脚本 `--help`。
- [x] C3: 将 `readBlobBatch` 下沉至 `kit/skills/lib/git-fast-objects.mjs` 供 `kit/skills/dev-edit/scripts/edit-gate.mjs`（行数净减）与 `kit/skills/dev-govern/scripts/govern-checks.mjs` 复用，并透传 `trackedSet` 给 `kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`；`scripts/lib/survey-workspace.mjs`/`scripts/survey.mjs` 消除同步 `git check-ignore` 阻塞；新增 `scripts/dev/fixtures-perf-budget.mjs` (new) 与 `scripts/dev/injections-data-perf-budget.mjs` (new)，实测 `node scripts/dev/bench.mjs` 与 `verify-injections.mjs` 更省 CPU 且零弱化门禁。
- [x] C4: 升级 `kit/skills/lib/platform-registry.mjs` 与 `scripts/lib/platform/registry.mjs` 为单源 10 键能力矩阵（新增 `uploadAttachment`、`checks`），内置 5 方言（`github`、`gitlab`、`gitcode`、`gitee`、`gitea`）+ `generic-git` 兜底且零私域域名硬编码，同步升级 `scripts/dev/preflight-suite.mjs`（含双端注册表对齐与 `AbortSignal.timeout` 校验对齐）、`scripts/dev/fixtures-platform.mjs`、`scripts/dev/fixtures-repo-alignment.mjs`、`scripts/dev/injections-data-repo-alignment.mjs` 与 `scripts/dev/injections-data-kernel-dedup.mjs`。
- [x] C5: 新增零依赖 `kit/skills/lib/platform-http.mjs` (new)（`node:http`+`node:https`、公网 `http://` 与 `169.254.169.254`/`fe80::` Fail-Closed 拦截、仅允许 loopback/RFC1918 局域网 `http://`、`AbortSignal.timeout`、`redirect: 'manual'` + 3xx `Location` 脱敏、全平台令牌脱敏、4 字节字符守卫、随机 boundary + filename CRLF/引号清洗 + 纯 `Buffer.concat` multipart）与 `kit/skills/lib/platform-providers.mjs` (new)（5 方言鉴权头、429 退避上限、GitLab/GitCode `POST /api/v4/projects/:id/uploads`、`refs/merge-requests/<iid>/head` 真 SHA 校验含离线/浅仓回退与 `shaSource` 标注、客户端分支二次过滤），升级 `kit/skills/lib/platform-probe.mjs`、`kit/skills/lib/github-parse.mjs`、`kit/skills/lib/github-labels.mjs` 与 `scripts/lib/platform/*`。
- [x] C6: 升级 `kit/skills/lib/platform.mjs`（新增 `resolveRemoteTarget` 完整支持 GitLab 多级群组与 LAN/离线识别）与 `kit/skills/lib/task-backend.mjs`（统一 `RemoteApiBackend` 取代 `provider.id !== 'github'` 硬退化），配纯 Node 本地 `node:http` Mock Forge 双向单测与故障注入 `scripts/dev/injections-data-platform-core.mjs` (new)。
- [x] C7: 新增 `kit/skills/lib/worktree-dep-pool.mjs` (new) 并瘦身升级 `kit/skills/dev-flow/scripts/worktree-deps.mjs`（`<= 600` 行）：落地三类通用重目录分层（Class R 原生全局仓 + 独立 `CARGO_TARGET_DIR`；Class S 仓外只读 `dep-pool` 按 `sha256(lockfiles+清单依赖段)` + `.prisma`/POSIX shebang 隔离 + `detach`/`reconcile` 漂移自动脱钩 + `pool-refs.json` 引用计数 GC + Windows NTFS 递归撤只读位 `0o666`/`0o777` 后再 `rmSync` 防 `EPERM` + Windows junction 非递归清理兜底 + 放行 `dep-pool` 为 `tool-mounted`；Class I 严格隔离构建与 DB/NoSQL 卷），同步对齐 `kit/skills/lib/profile.mjs`（`worktree-shared-readonly:`）、`scripts/dev/fixtures-w6c-harness-gates.mjs` 与既有注入锚点。
- [x] C8: 升级 `kit/skills/lib/exec.mjs`：`computeWorktreeEnv` 统一重定向 `VITE`/`JEST`/`BABEL`/`ESLINT`/`CARGO_TARGET_DIR` 至独立 `PF_CACHE_DIR` 并透传 `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`；CVE-2024-27980 硬化优先对 `npm`/`pnpm`/`npx`/`yarn` `.cmd` 解析底层 JS 直调 `node`，对其余 `.cmd`/`.bat` 实施精准元字符拦截（放行含空格/括号的合法路径如 `Program Files (x86)` 与测试垫片正常参数，严拦命令拼接元字符），并在 `execSafe` `try/catch` 内返回已登记于 `kit/skills/lib/exit-codes.mjs` 的 `BLOCKED_UNSAFE_WIN_BATCH_ARG` 维护 `execSafe` 永不抛异常契约。
- [x] C9: 升级 `kit/skills/lib/workflow-policy.mjs`（扩展 `isOneWayBoundaryFile` 覆盖 NoSQL/ORM/KV/向量库、Proto/GraphQL/OpenAPI、Docker/K8s/Helm/Terraform；双向兼容修复 `resolveScopedVerificationGate` `dirRel/ecosystems` 字段错位与 `quickTest` 读取）与 `kit/skills/dev-flow/scripts/flow.mjs`/`flow-intake.mjs`/`kit/skills/lib/intake-triage.mjs`（`contextBasis` SHA-256 写前防脏写复核 `BLOCKED_STALE_INTAKE_CONTEXT`、帮助文案修正与 `scripts/dev/subcommand-parity.mjs` 对齐），新增 `scripts/dev/fixtures-worktree-policy-v2.mjs` (new) 与 `scripts/dev/injections-data-worktree-policy-v2.mjs` (new)。
- [x] C10: 全量消除 `kit/skills/dev-flow/scripts/flow-*.mjs`、`kit/skills/dev-review/scripts/review-*.mjs`、`kit/skills/lib/plan-sync.mjs`、`kit/skills/lib/escalation.mjs`、`kit/skills/lib/task-graph.mjs`、`kit/skills/lib/workflow-policy-next.mjs` 与 `scripts/survey.mjs`、`scripts/review.mjs`、`scripts/equip-ci.mjs`、`scripts/lib/navigation.mjs`、`scripts/lib/render.mjs` 中的 `github`/`gh` 硬假设，统一切换为 `resolveRemoteTarget` 与 10 键 `capabilities` 驱动。
- [x] C11: 落地仓外实证附件目录 `<gitCommonDir>/project-forge-flow/artifacts/<taskId>/` 生命周期（`kit/skills/lib/verify-state.mjs` + `kit/skills/lib/empirical-artifacts.mjs` + `kit/skills/dev-flow/scripts/flow-cleanup.mjs` `cleanup`/`abort` 联动销毁，零进 Git），对接 `capabilities.uploadAttachment`（GitLab/GitCode 原生 `/uploads` 内嵌图且缓存防重传，GitHub/Gitee/Gitea/LAN 直接输出文件名 + 字节数 + 校验指纹 + 实证观察摘要，绝不询问图床）并瘦身 `flow-lifecycle.mjs`/`review-empirical.mjs` 至 `<= 780` 行。
- [x] C12: 新增独立单源模块 `kit/skills/lib/master-criteria-sync.mjs` (new) 根治 3 大同步缺陷并统一 PR/Issue 详单表格：（1）阻断 `flow-inspect.mjs` 两处（`dirtyDocs` 与 `wtDocs`）`planBootstrap` 自动挂载子切片 SPEC/Todo，`resolvePrimaryPlanDocOrder` 在 `flow-inspect`/`pr-template-hydrate`/`review-gates`/`handoff-package` 统一优先 `prdFile`（修 PR `#215`）；（2）`collectMasterIssueCriteriaState` 迁入 `master-criteria-sync.mjs` 并增 `includeSelf = false` 开关（非终态 `plan-backfill`/`approve` 仅聚合已归档兄弟切片绝不误勾当前未完成切片，`flow-merge` 终态传 `includeSelf: true`），`syncIssueCriteriaCheckboxes` 默认 `preserveChecked = false`（仅非终态 `plan-sync` 显式传 `preserveChecked: true`，兼容 `fixtures-issue-checklist-sync.mjs` 与 `clarify --drop-criterion` 显式反选，修 Issue `#219`）；（3）PR 详单表格（变更摘要 + 验收清单进度表 + 门禁与 5 列实证附件表，对齐 `fixtures-empirical-cycle.mjs` 与目标仓 GitLab 默认 MR 模板（`.gitlab` 下 `merge_request_templates` 目录 `Default.md`））与 Issue `pf:plan-summary` 单源一致。
- [x] C13: 新增 `scripts/dev/fixtures-multi-platform.mjs` (new) 与 `scripts/dev/injections-data-multi-platform.mjs` (new)（离线纯 Node HTTP Mock Forge + `git init --bare` 完整模拟 GitLab v4 `/uploads` 与 `refs/merge-requests/1/head` 真 SHA、GitCode 4 字节守卫与客户端分支过滤、Gitee/Gitea 降级、LAN IP / 离线四态核验），提供 opt-in 环境变量驱动的一次性私有测试仓实测入口 `scripts/dev/live-forge-e2e.mjs` (new)（零硬编码凭据与域名），并同步 `docs/TDD.md`、`docs/feature-map.json`、零脏态 `docs/architecture-map.html`、`README.md`/`README.en.md` 与 `node scripts/equip.mjs .`，全量 `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0`。
<!-- criteria:end -->

## 七、待拍板问题

- 待确认：无

## 八、门型与回滚路径

- **门型判定**：`one-way`（涉及 `kit/skills/lib/` 平台注册表、HTTP 客户端、Worktree 依赖引擎、命令执行安全边界、退出码登记、策略门禁、主文档同步单源与 `scripts/lib/` 公共契约，且触及高风险路径 `kit/`、`scripts/lib/`）。
- **回滚路径**：4 个切片按 3 波次独立 PR 合入 `main`，任意切片出现异常均可通过 `git revert` 整片反向提交并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs` 恢复至上一稳定基线；仓外 `dep-pool/` 与 `artifacts/<taskId>/` 位于 `<gitCommonDir>/project-forge-flow/`，卸载链接并撤只读位后删除即无损复原。

## 九、风险与缓解

| 风险 | 可能性 | 影响 | 缓解办法 |
| --- | --- | --- | --- |
| 多个紧文件逼近 800 行（`flow-inspect.mjs` 799 行、`review-empirical.mjs` 797 行、`flow-merge.mjs` 792 行、`preflight-suite.mjs` 790 行、`flow-lifecycle.mjs` 788 行、`worktree-deps.mjs` 777 行、`edit-gate.mjs` 772 行、`workflow-policy.mjs` 770 行、`platform-probe.mjs` 765 行） | 高 | 触发 `edit-gate` 单文件超限阻断 | 通过新增 `proc-budget.mjs`、`platform-http.mjs`、`platform-providers.mjs`、`worktree-dep-pool.mjs`、`master-criteria-sync.mjs` 与下沉 `readBlobBatch` 至 `git-fast-objects.mjs`，将全部紧文件主动瘦身压在 `<= 780` 行（不往 714 行的 `doc-slice-graph.mjs` 硬塞） |
| `fixtures.mjs --only` 关键字预筛在跨文件 `import` 或动态拼名时出现部分命中漏检 | 中 | 故障注入漏检，变相弱化门禁 | 启动时解析 `DISCOVERED_FILES` 跨文件 `import` 闭包联动加载依赖文件，补 `--domain` 单域懒加载，且 0 命中强制无条件回退全量导入 |
| Windows NTFS 只读 `dep-pool` 目录直接 `rmSync` 报 `EPERM` 或 `.cmd` 拦截误杀合法参数 | 中 | 清理失败或破坏 `gh.cmd` 垫片及含括号路径 | `worktree-dep-pool.mjs` 清理前递归撤只读位（`0o777`/`0o666`）；`exec.mjs` 对 `npm`/`pnpm`/`npx`/`yarn` `.cmd` 解析底层 JS 直调 `node`，其余 `.cmd` 放行空格与括号并严拦命令拼接元字符，且在 `execSafe` 内捕返回错误码 |
| 非终态 `plan-backfill` 直接复用 `collectMasterIssueCriteriaState` 误勾未完成切片 `C*` | 高 | 总控 Issue 进度虚高 | 在 `master-criteria-sync.mjs` 为 `collectMasterIssueCriteriaState` 增设 `includeSelf = false` 默认开关，非终态仅聚合已归档兄弟切片，`syncIssueCriteriaCheckboxes` 保持默认 `preserveChecked = false` 兼顾显式反选 |

## 澄清与补充记录

- 已确认：Wave 1A（`low-cpu-script-perf`）与 Wave 1B（`multi-forge-platform-core`）写域 100% 正交可并行推进；Wave 2（`worktree-dep-pool-policy`）依赖 Wave 1；Wave 3（`multi-forge-flow-sync-e2e`）依赖 Wave 1 与 Wave 2 并终态收口全仓长青资产。
- 已确认：全部吸收独立审查 R1（`critic-c-r1`）的 20 项源码与契约发现，彻底补齐紧文件瘦身方案、公网 `http://`/元地址安全边界、Windows NTFS 只读池清理、`.cmd` 直调 `node` 与 `execSafe` 永不抛异常契约、以及 `master-criteria-sync.mjs` `includeSelf = false` 防误勾设计。

> 确认需调整系统模块或对外契约时，以此 PRD 为依据推进 4 份切片 `SPEC + Todo`；`1:N` 总控 PRD 走四态闭环，全部 3 波次 4 切片合入完成时统一成对归档至 `docs/archive/prd/`。
