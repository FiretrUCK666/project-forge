---
kind: prd
title: project-forge v7 全栈治理与工作流重构总控需求说明
status: done
created: 2026-11-15
updated: 2026-11-16
issue: null
pr: null
owner: FiretrUCK666
plan_critique: "passed (reviewer=independent-plan-critic-r2, round=2, sha=4f8a5bfc3a04, summary=Refreshed hash after syncing M0 archived todo path and table status)"
related_spec: null
related_todo: null
---

# project-forge v7 全栈治理与工作流重构总控需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（M0–M5 全量实施并实证验收通过，终态归档） |
| 创建 / 更新 | `2026-11-15` / `2026-11-16` |
| 关联 Issue / PR | M0 校准单 #33 / PR #34（M1–M5 各自建单并提交独立 SPEC + Todo + PR） |
| 提出方 / 负责人 | FiretrUCK666 |
| 关联设计 / 任务单 | 常青架构契约 `docs/TDD.md`；M0 任务单 `docs/archive/todo/261115-issue33-v7-prd-tdd-todo.md` |

- **文档关系说明**：本 PRD 是 v7 全量升级的**总产品需求汇总**，统领全量需求、7 大使用场景、五切片路线图（含各切片内同步更新对拍契约要求）与冻结验收标准 `C1..C12`。各阶段具体技术方案与代码级变更范围，由后续 M1–M5 五份独立 `docs/specs/` 与配套 `docs/todo/` 分别落地并互链追溯。

---

## 一、现状痛点与实证诊断

通过对本仓库全模块逐行审计与 Windows 实测基准测试，当前版本存在四大类结构性问题：

1. **高频脚本耗时过长与双库实现分裂**：
   - `kit/skills/dev-flow/scripts/flow.mjs` 的 `inspect` 在未传 `--probe-auth` 时仍无条件触发 `gh auth status`（实测 756ms）与 `git credential fill`（实测 297ms）及 23 次 `git` 子进程，本仓 3 轮热态中位数耗时 `1,905ms`；
   - `scripts/survey.mjs` 存在无用的 `git check-ignore` 死调用（本仓耗时 `644ms`），`--probe-auth` 在无 SSH 密钥或纯 HTTPS/无远端仓仍无条件探测 SSH 22/443 端口（本仓 `3,777ms`，离线超时可达 `10s`）；
   - `scripts/review.mjs` 重复运行两次 `survey()`（实测 `1,028ms`，其中二次勘察占约 50%）；`kit/skills/dev-govern/scripts/govern-audit.mjs`（`1,084ms`）对同一源码最多重复读盘与词法剥离 5 次，且在已有 `Dev Profile` 时仍触发 8,000 目录遍历；
   - `scripts/dev/preflight.mjs` 串行启动约 70 个子进程耗时 `9,399ms`；`scripts/dev/fixtures.mjs` 默认单线程串行执行（`LANES=1`）导致超时，且 mock 测试误触发本机真实认证探测；
   - 平台探测、GitHub 客户端、决策解析与项目命令发现分别在 `scripts/lib/` 与 `kit/skills/lib/` 存在 2–4 份互有漂移的实现。
2. **流程靠文档自觉而非确定性状态机，存在多处绕过与卡死**：
   - **主仓与 Worktree 分裂**：Tier 1 允许直接在主工作区 `main` 上切换开发分支且审查会回退到 `mainRoot`，容易把主工作区搞脏并在多人或并行开发时碰撞；
   - **提审与返工时序冲突**：`finalize` 在首轮提审前把文档 `git mv` 进 `docs/archive/`，一旦首轮打回返工改代码即撞 `BLOCKED_STALE_FINALIZE`；且 `submit` 在 `git push` 之后仍修改 `docs/archive/*` 回填 PR 编号，强迫工作区变脏产生多余补丁提交（`68c2c98`）；
   - **单文件验证旁路**：`verify --tier quick --target` 只跑单文件即可满足 `submit` 与 `merge` 的 `verifiedHead` 校验，彻底绕过 `smoke-verify` 与 `merge-gate`；
   - **远端类型错判**：`generic-git` 有远端仓在 `merge` 时跳过远端 MR 流程直接尝试本地 `git merge`；`submit` 建 PR 时忽略 `.github/pull_request_template.md` 且未先查询分支上是否已有未关 PR；
   - **跨会话与 1:N PRD 断链**：`pf-state` 审查评论标记只写不读，换机或新会话无法重水合完整审查轮次；多切片大需求（1 份总 PRD 拆成 N 份 SPEC）缺少防提前归档父 PRD 的机制。
3. **并行调度、外部协作拓扑与抗无限审查缺口**：
   - 缺少宿主无关的并行多 Worktree 调度机制（`--parallel` 仅服务单任务 Tier 2）；并行写 `info/exclude` 与 `.git/*.lock` 无锁易竞争失败；共用依赖缓存目录或固定测试端口互相踩踏；多分支合并缺少串行 FIFO 临时工作树试合队列与 `baseSha` 漂移检测；
   - 外部协作未统一处理「仅 Issue」「仅 PR」「Issue+PR 互链防重复建单」「外部依赖 Issue 静默丢失」与「堆叠 PR 的 `--after` 起枝、`sync` 变基同步及父合防误关闭」；
   - 防无限审查「六锁」在 `review-ledger.mjs` 存在代码漏洞：第 2+ 轮对未改旧代码的新阻塞项未硬拦截、相同 `HEAD` 原地复审未硬拒、`C*` 同名不同缺陷在 Round 2 误报停损、Round 4 `pass` 可绕过 Round 3 停损、缺少噪声筛选规则与作者处置反馈统计。
4. **通用适配、备份自更新与死检测漏洞**：
   - `scripts/backup.mjs` 默认 `.tar.gz` 在 Windows 原生查看不便且存在 **5 项实测缺陷**：① `BACKUP_SKIP_DIRS` 缺少 `.gradle`/`.turbo`/`.svelte-kit`/`.pytest_cache`/`.mypy_cache`/`.ruff_cache`/`Pods`/`DerivedData`/`.build`/`.swiftpm` 10 个缓存目录；② `visit()` 对每个普通目录/文件冗余调用 `realpathSync.native`；③ PAX 头与 USTAR 路径截断按字符长度切片可能劈裂多字节 UTF-8；④ `unpackTar` 拒绝标准 `./` 前缀归档；⑤ 全量读入+拼接+压缩产生 3 倍内存峰值。`scripts/zip.mjs` 仅支持只读且中心目录偏移用 `eocd.offset - eocd.size` 而非 ZIP 规范偏移 `i+16`；
   - `scripts/update.mjs` 存在 `--check` 篡改节流状态、`--equip` 在最新版跳过刷新、`verifyInstalled` 仅扫顶层脚本且失败不回滚、顶层退役文件不清理与忽略代理/`GH_TOKEN` 缺陷；
   - 空仓 `--bootstrap-empty` 写死 6 栈 `greet` 玩具码、拒收带 `README.md`/`LICENSE` 的新仓且初装 `AGENTS.md` 必红；`templates/agents-project.md` 渲染 `full` 空白态已达 `21,258 B`（受管区 `20,256 B`，本仓 `AGENTS.md` 已达 `24,428 B`），且定制区间与 `--check` 互相死锁、`{{CONVENTIONS_HINT}}` 换行劈断 HTML 标记、`maskVolatile` 无词边界误伤 `main.mjs`/`domain`/`maintainer`、`equip.mjs` 降档误删技能；
   - `govern-tests.mjs` 的零断言检测（`tests.zero-assertion`）与纯 Mock 检测（`tests.mock-tautology`）因 `ASSERTION_RE` 匹配 `it()`/`test()`/`def test_` 而完全失效；CI 缺少 Windows/macOS 多平台矩阵，发布流未在上传附件后回读校验。

---

## 二、产品定位、用户与非目标

### 目标用户与核心目标

- **目标用户**：使用任意编程技术栈与托管形态的个人及团队开发者，以及在这些项目中运行的不同 AI 编程宿主。
- **核心设计原则**：
  1. **零宿主与零特定工具绑定**：产物层不提及任何具体宿主、IDE 或特定多代理工具名称；只定义逻辑角色、隔离结构、文件锁与 CLI 状态接口，由宿主原生能力调度执行。
  2. **高信号规则保留在每次会话入口**：完整保留 `AGENTS.md` 中的自动意图路由、行事总纲、7 键 `Dev Profile`、工程守则与日常协作六步/双写/七步收尾/UTF-8 防乱码规范（仅浓缩冗长口水重复使受管区维持紧凑高密度，不删除任何行为判据与命令），让弱模型开局即能严格守规。
  3. **确定性约束取代口水堆叠**：把状态转移、视野锁定、权限边界与实证检查沉入纯函数与 CLI 阻塞器，同时通过合并重复库做减法保持架构长期可维护。

### 明确不做（Non-Goals）

- 不引入任何第三方 npm 依赖或编译构建步骤（严格维持 Node 18+ `node:*` 内置模块）。
- 不把特定非 GitHub 托管平台的专属 REST/CLI 补丁强塞入主包，保持 `HostingProvider` 与 `TaskBackend` 协议中立。
- 不将安装期专用代码（模板求值、空白起步、勘察缺口规则）塞入随包分发到目标仓的 `kit/skills/lib/`。
- 不替用户决定开源许可证、仓库可见性、版本号跨大版本跃迁、发版触发时机或强制改写已推送历史。

---

## 三、全场景产品功能需求（7 大真实使用场景）

### 场景 A：0 文件空白目录起步与任意技术栈接入

1. 兼容由网页端已预建 `README.md` / `LICENSE` 或完全 0 文件的空白目录执行初始化。
2. 废除硬编码 6 语言 `greet` 玩具业务代码；`--bootstrap-empty` 只搭通用工程基线（`git init`、`.gitattributes`、`.gitignore`、`docs/TDD.md`、活跃文档目录及含合法 `none` 占位的 `AGENTS.md`），初装完毕即通过 `compose-agents.mjs --check` 与 `scripts/review.mjs`。
3. 询问用户意向栈后，由 AI 按该栈标准工具链完成初始化并自动运行勘察反推真实 `Dev Profile`。

### 场景 B：存量多语言 / Monorepo / 自有技能仓接管与命令发现

1. 合并分裂的命令与包探测器为统一三层优先级嗅探器：`AGENTS.md Dev Profile`（用户权威） -> 仓库真实 CI / `Makefile` / `justfile` / `Taskfile` / 脚本实际执行命令（支持 4 空格 YAML 与多种 CI 文件） -> 递归多包目录信号（修复根有 `package.json` 屏蔽后端子目录、Maven 测试目录漏检及 Windows 非兼容 `cd` 语法）。
2. 明确产出每条发现命令的 `detectionEvidence`（来自哪份文件的哪一行），并原样保留仓库既有的架构文档与 `.agents/skills/` 自有扩展技能。

### 场景 C：跨版本多月重入升级、定制和平共处与跨平台备份更新

1. **纯 JS `.zip` 仓外备份**：扩展 `scripts/zip.mjs` 实现纯内置 `node:zlib` 读写（按 ZIP 标准 `i+16` 偏移读中央目录）；`scripts/backup.mjs` 默认产出 `.zip`，`list`/`restore` 向下兼容恢复历史 `.tar.gz`，并一次性修复上述 5 项实测缺陷。
2. **`AGENTS.md` 定制兼容与预算保护**：修复 `{{CONVENTIONS_HINT}}` 换行劈断注释、`maskVolatile` 误替换 `main.mjs`/`domain`/`maintainer`、`SECTION_KEYWORDS` 误跳过章节与 `protectedRegions` 导致 `--check` 死红的问题；新增 `compose-agents.mjs --adopt-custom`，合理浓缩受管区间冗长叙述保留全部规则（在现有 `< 14KB` / `<= 30KB` 总契约下，保证受管模板留出充裕项目自定义空间），并在重入大仓超出 `30KB` 时区分「受管膨胀」与「既有项目手写长文」，引导按子目录拆分而非无脑阻断升级。
3. **`equip.mjs` 与 `update.mjs` 健壮性**：降档 `--tier lightweight` 不误删已装的高阶技能；二次编辑已登记定制文件不卡死校验；`update.mjs --check` 保持严格只读、`--equip` 在最新版仍可执行刷新、`verifyInstalled` 覆盖全目录并在失败时原子回滚、全深度清理退役顶层文件、支持代理环境变量与 `GH_TOKEN`。

### 场景 D：纯本地无远端与非 GitHub 远端自适应

1. **统一 `TaskBackend` 抽象**：将 5 套技能的认领、评论、标签、PR/MR 与合入抽象为同一后端接口（覆盖 GitHub 后端、尊重远端 MR 的 `GenericRemoteBackend` 与全功能本地账本驱动的 `LocalOnlyBackend`）。
2. **`no-remote` 零泄漏与 `generic-git` 防越权**：纯本地仓库渲染的 `AGENTS.md` 与指引绝不出现 `PR`/`origin`/`push` 等矛盾指令，且不误报 `tests.no-ci-config`；`generic-git` 有远端时禁止 `flow.mjs merge` 越权在本地把代码强合并进主干。

### 场景 E：全 Worktree 日常研发流与三正交风险分级

1. **全量默认 Worktree 隔离（废除主仓原地建分支）**：只要仓库已有提交（`commits > 0`），全部实现一律进入 `.worktrees/impl-N`（基准提交取自默认分支并检查 `mainRoot` 脏改动与目标分支占用冲突）；每条任务至多维持 1 个 `impl` 与 1 个 `review` 复用（打回返工在原 `impl` 同分支追加提交，再次提审通过 `syncDetachedWorktree` 推进原 `review` 工作树并自动解绑过期共享依赖 Junction，提供 `--reset-review-slot` 清理故障注入残留）。
2. **单一入口 `flow.mjs next` 与三正交策略**：任何会话跑 `flow.mjs next --json` 即拿到唯一合法下一步、工作树路径、阻塞原因与紧凑上下文；`determineWorkflowPolicy` 在 `verify`/`submit`/`merge` 现场依据完整 `baseSha..HEAD` diff 实时判定隔离/留痕/审查策略：
   - **低风险（`low`）**：100% 命中非可执行纯文本/文档白名单（如普通 `.md`/注释/文案，**排除**任何源码、脚本、配置 `.json`/`.yml`/`.yaml`、锁文件、`AGENTS.md`、`docs/TDD.md`、`high-risk` 路径及门禁弱化） -> 仍走 Worktree + PR + 门禁绿灯合并，免多余建 Issue 与免开独立审查子代理；**在无远端 CI 仓强制过本地静态文档/死链/Mermaid/秘密扫描，绝不零检查空放**；
   - **中风险（`medium`）**：常规源码/测试变更或 Case 2/3（无 `high-risk` 与门禁弱化） -> Worktree + Issue 认领 + PR（`Closes #N`）+ 分层实证 `evidence.json`（位于 `.gitCommonDir` 下 `project-forge-flow/tasks/<taskId>/evidence.json`，与发版清单脚本 `scripts/dev/evidence.mjs` 严格隔离，必填 `baseSha`/`headSha`/`dirty`/`gates.{quick,smoke,full,gate}`/`skipped[]`）+ 1 路独立审查子代理；
   - **高风险（`high`）**：触碰 `high-risk`、`one-way` 对外契约/Schema/安全路径、门禁弱化或 Case 4/5 -> Worktree + `approved` SPEC/TDD + Issue + PR + `merge-gate` 实证 + 独立审查（强制故障注入与非无头环境视觉核验）+ 按需人类审批。
3. **修复提审/归档/合入/清理全链路断点**：`submit` 推远端后绝不改写 Git 追踪文件（杜绝 `68c2c98`），先查已有 OPEN PR 防重复建单，自动套用 `.github/pull_request_template.md` 并双写评论标签；支持多切片 1:N 总控 PRD 在未全部完成前不被子任务过早归档；`verify` 写入按层级划分的 `evidence.json` 堵死单文件绕过全门禁；本地合入全部在一次性 `--detach` 临时工作树试合复测后才对干净 `mainRoot` 执行 `merge --ff-only`；`cleanup` 始终先列清单经 `--confirm` 选择性确认，支持远端 `MERGED`（含 Squash）安全删本地分支。

### 场景 F：外部协作全拓扑与堆叠 PR 协同

1. **统一图谱解析**：支持外部「仅提 Issue」「仅提 Fork PR（必须先过 `--untrusted-scan` 经人类批准后再挂依赖测试）」「同时提 Issue 与 PR 且正文互指（自动合并为统一任务上下文，禁止重复认领新开 PR 且双端同步评论/标签）」。
2. **依赖阻断与堆叠 PR**：修复外部未传入阻塞 Issue 静默丢失漏洞；支持 `--after` 基于父分支起枝与 PR `base` 设父分支，审查按父分支到本分支计算增量 diff，父 PR 未合前硬锁禁止子 PR 提前合入；提供 `sync` 子命令安全执行 `rebase --onto`、更新 PR `base`、记录 `roundBaseSha` 并用 `range-diff` 防第 2 轮视野爆炸（分离 `syncCount` 不误耗停损轮次）。

### 场景 G：宿主无关并行多 Worktree 调度、抗死循环与三位一体自进化

1. **宿主无关并行调度与合并队列**：定义纯逻辑角色与基于 `gitCommonDir` 的 `withLock('wx')` 锁、`.git/*.lock` 指数退避重试及每工作树环境隔离变量（槽位/端口偏移/独立缓存目录）；提供波次依赖与文件互斥规划、单任务拆片互不重叠校验、跨会话句柄轮换（`--resume-session`）以及串行 FIFO 临时工作树合并队列（检测基线漂移试合复测，冲突直接退回 `impl` 不盲猜合入）。
2. **抗无限审查硬锁、收敛四律与四类反误报统计**：
   - 强制 `--must-fix` 绑定冻结 `C*`/确定性门禁/实证失败（提供 `--should-fix` 与 `--pre-existing` 非阻塞通道与噪声筛选规则），接入 `findingsBlocker` 严审 `pass` 结论；
   - **代码层落地收敛四律**：① 超过 3 轮硬停损转向整体重思/人类裁决；② Round 2+ 确定性门禁扫全 PR、AI 视野与 `record` 硬锁为 `prevHead..HEAD` 新改行 + 上轮未结 `Must Fix` + `rebuts`（直接拒收针对未改旧行的新阻塞项，变基时依 `roundBaseSha` / `range-diff` 计算）；③ Round 1 提示并校验同类问题一次列全；④ 不重复已提出或已关闭意见；
   - 硬拒同 `HEAD` 原地复审；修正 `repeatedTrigger` 按规范化文件/锚点/摘要指纹匹配防止同 `C1` 误停损；修补 Round 4 `pass` 绕过历史停损漏洞；在账本记录四类作者处置反馈（`fixed` 采纳修改 / `rebutted-wrong` 误报反驳 / `intentional` 刻意设计 / `deferred` 暂缓），用于统计无效意见率。
3. **三位一体验证与 SOP 自动沉淀**：救活 `govern-tests.mjs` 失效的零断言与纯 Mock 检测；`checkTddSyncParity` 改为目录/导出/CLI 结构比对；扩展 Mermaid 检查至 `sequenceDiagram`/`stateDiagram`/`erDiagram`；`flow verify`、`review-pack record`、`flow rework` 自动写入 `.gitCommonDir` 运行期 `signals.jsonl`，由 `govern-audit.mjs retro --task` 聚合产出规则/门禁/夹具建议补丁；构建基于 `git archive` 真 `.zip` 安装包的 Fake-Agent E2E 沙盒测试台验证上述全场景。

---

## 四、复用既有模块与五切片分解路线图

### 复用既有模块

- `scripts/lib/protocol.mjs`、`template.mjs`、`render.mjs`、`claims.mjs`、`agents-sections.mjs`、`update-ops.mjs`（安装期专用内核边界）
- `kit/skills/lib/shared.mjs`、`git.mjs`、`docs.mjs`、`doc-templates.mjs`、`ledger.mjs`、`profile.mjs`、`static-gates.mjs`、`platform.mjs`、`github-client.mjs`（双端共享运行时内核）
- `scripts/zip.mjs` 与 `scripts/backup.mjs`（扩展零依赖 `.zip` 读写与兼容恢复）
- `kit/skills/dev-flow/scripts/worktree-deps.mjs`（复用按子包锁文件与防毒化软链解绑）

### 垂直切片分解路线图（同切片同步对齐契约门禁，保持每里程碑绿灯）

```mermaid
flowchart LR
  M0["M0 PRD+TDD校准"] --> M1["M1 内核与.zip"]
  M1 --> M2["M2 状态防死锁"]
  M2 --> M3["M3 并行与动态"]
  M3 --> M4["M4 实证与E2E"]
  M4 --> M5["M5 对齐与自举"]
```

**跨切片同步铁律**：`M1–M4` 任一切片若改变了 `SKILL.md`、`AGENTS.md`、`templates/`、`references/`、`preflight-contracts.mjs` 或 `verify-injections.mjs` 所对拍的行为（例如 `.zip` 默认格式、废除 Tier 1 原地分支、废除 6 栈玩具码），必须**在同一个切片提交内同步更新对应契约文本与门禁测试**，确保每个里程碑合入时全量 `merge-gate` 始终为 0 失败。

| 切片 | 核心交付边界（独立建 Issue + SPEC + Todo + PR） | 同切片对拍与依赖策略 |
| --- | --- | --- |
| **M0** | 本总控 PRD + `docs/TDD.md` 架构校准 + M0 任务单 | Case 5 架构先行落地 |
| **M1** | 共享运行时单源收敛（限 `kit/skills/lib/`）、子进程与缓存性能优化、`.zip` 备份与 5 项修复、`update.mjs` 修复、Windows `.cmd` 执行器 | 依赖 M0；同步更新 `.zip` 描述对拍与 `arch-rules` |
| **M2** | L3 纯状态机与 `flow.mjs next`、全 Worktree 隔离、三正交策略表、1:N PRD 保护、抗无限审查硬锁与提审/归档/合入/清理全链路断点修复（场景 E.3） | 依赖 M1；同步更新全量 Worktree 与六锁契约对拍 |
| **M3** | `graph` 互链/堆叠 PR 与 `sync`、宿主无关 `batch` 并行与 FIFO 合并队列、`TaskBackend`、三层嗅探、`--bootstrap-empty` 通用化、`AGENTS.md` 定制与 `equip` 修复 | 依赖 M2；同步更新 `checkStarterLanguageCoverage` 与渲染契约 |
| **M4** | 救活死检查与扩展静态门禁、`signals.jsonl` 自动沉淀与 `retro` 补丁、跨平台 CI、真 `.zip` 安装包 Fake-Agent E2E 测试台 | 依赖 M3；全量场景真包实证 |
| **M5** | 5 套 `SKILL.md`/参考文档/模板/双语 `README`/SVG 全盘精简对齐、清理残留宿主耦合词、本仓全链路自举交付与总控 PRD 归档 | 依赖 M4；全门禁与三平台 CI 绿灯 |

---

## 五、冻结的产品级验收标准（C1..C12）

- [x] C1: 实测性能达标（以 `scripts/dev/bench.mjs` 300 文件基准仓库与本仓 3 轮热态中位数在 Windows 基线检验）——无 `--probe-auth` 的 `flow.mjs inspect` / `next` `<= 300ms`（基线 `1,905ms`），`survey.mjs` `<= 250ms`（基线 `644ms`），`review.mjs` `<= 450ms`（基线 `1,028ms`），`preflight.mjs` `< 2,500ms`（基线 `9,399ms`），`fixtures.mjs` 默认并发全量跑通 `< 30s` 且 `bench.mjs` 满足硬预算。
- [x] C2: 仓外备份默认输出纯 JS 零依赖 `.zip`（1,000 文件创建 `<= 250ms`，Win/Mac/Linux 原生打开；修复上述 5 项 `backup.mjs` 缺陷与 `zip.mjs` `i+16` 偏移），`backup.mjs list/restore` 向下兼容恢复历史 `.tar.gz`，且 `update.mjs` 的 `--check` 纯只读、最新版 `--equip`、全深度清理与失败原子回滚全绿。
- [x] C3: 仓库有提交历史时全量默认 `impl-*` + `review-*` 隔离与跨轮复用（不按轮次新建多余工作树）；返工改锁文件自动解绑旧 Junction；本地合入经临时 `--detach` worktree 试合复测后对干净 `mainRoot` 走 `merge --ff-only` 推进（绝不强推或撕裂索引）；`submit` 推远端后 0 跟踪文件变脏。
- [x] C4: 三正交策略表在 `verify`/`submit`/`merge` 现场依据完整 diff 重算，`low` 仅限纯非可执行文本白名单且在无 CI 仓必过静态检验，`medium`/`high` 按级强制独立审查、故障注入与不可旁路的分层 `evidence.json`（`.gitCommonDir` 下 `project-forge-flow/tasks/...`）绑定验证。
- [x] C5: 六锁 + 收敛四律全数代码级硬落地——Round 2+ 硬拒未改旧行新刺、硬拒同 `HEAD` 复审、修复同 `C*` 误报停损与 Round 4 绕过停损、接入 `findingsBlocker` 与噪声筛选，并记录 `fixed`/`rebutted-wrong`/`intentional`/`deferred` 四类处置统计无效意见率。
- [x] C6: 完整覆盖外部单 Issue、单 PR（含供应链 `--untrusted-scan`）、Issue+PR 互链防重复建单、外部阻塞依赖拦截，以及堆叠 PR（`--after`、`sync` `rebase --onto`、`roundBaseSha` / `range-diff` 防视野爆炸与清理保护）。
- [x] C7: 宿主无关并行多 Worktree 调度与 FIFO 合并队列落地——含 `withLock('wx')`、Git 锁退避、槽位/端口/缓存环境变量、`batch plan`/`check-disjoint`、跨会话句柄轮换与临时工作树试合冲突退回，且产物层零宿主与工具名称绑定。
- [x] C8: 全场景动态适配落地——统一 `TaskBackend` 抹平有无远端与 `generic-git` 防越权；`--bootstrap-empty` 通用基线无玩具码且初装即过 `--check`；三层声明式嗅探覆盖多语言深层子包；1:N 总控 PRD 在仍有未完结子 SPEC 时不被误归档。
- [x] C9: `AGENTS.md` 完整保留全防呆地图且修净 `no-remote` 泄漏、多行注释劈断、`maskVolatile` 误替换、定制区 `--check` 死结（新增 `--adopt-custom`）与大仓 30KB 升级阻断；`equip.mjs` 降档不误删且二次改定制文件可自洽。
- [x] C10: 救活 `govern-tests.mjs` 失效的零断言与纯 Mock 检测，补全多行词法状态、删除 CI 步骤检测与全图表 Mermaid `16/12` 校验，由 `flow verify`/`review-pack record`/`flow rework` 自动写入 `.gitCommonDir` 运行期 `signals.jsonl` 并由 `govern-audit.mjs retro` 产出规则补丁闭环。
- [x] C11: `.github/workflows/check.yml` 覆盖 `ubuntu`/`windows`/`macos` 三平台并纳入 `bench.mjs` 与 `verify-injections.mjs`；`release.yml` 在上传后回读校验 `.zip` 附件；清理 `references/plugin-ecosystems.md` 等残留宿主耦合描述。
- [x] C12: 建成基于 `git archive` 真 `.zip` 安装包的 Fake-Agent E2E 测试台，实证跑通全部 7 大场景、跨会话接管与全部防绕过负面测试，本仓全门禁（含 `verify-injections.mjs`）退出码为 0 完成自举。

---

## 六、门型、回滚路径与已拍板取舍

- **门型判定**：`one-way`（重塑核心架构契约、状态机阻塞规则、工作流与分发边界，拆分为 M0–M5 六次独立门控审批合并）。
- **回滚路径**：每个切片在独立分支与 Worktree 实施；合入前可直接丢弃分支/工作树；已合入切片通过反向提交（`git revert`）安全回退并重跑门禁验证，严禁强推或改写已推送历史。
- **已拍板关键决策**：
  1. 仓外备份默认纯 JS 零依赖 `.zip`，向下兼容恢复 `.tar.gz`。
  2. 非 GitHub 平台保持主包轻量中立，`GenericRemoteBackend` 尊重远端 MR 流程（绝不越权本地强合并），第三方适配器走外部扩展槽。
  3. `--bootstrap-empty` 取消硬编码 6 栈 `greet` 玩具码，只搭通用治理基线，由用户选栈后按真实工具链初始化并反推 `Dev Profile`。
  4. 只要有提交历史即全量强制 Worktree + PR + 门禁绿灯合并；仅当现场全量 diff 为纯非可执行文本低风险时免多余建单与独立审查子代理（无 CI 仓仍必过静态门禁）。
  5. 并行任务成对建 `impl`/`review` 工作树走串行 FIFO 合并队列；宿主支持会话复用时第 2 轮优先复用同一审查上下文，不支持或跨会话时由 CLI 硬锁增量视野。
