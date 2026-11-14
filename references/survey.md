# 只读勘察与状态判定

## 何时读本文件

在改写任何文件、初始化版本库或创建文档之前，先读完勘察输出并对照本文判读状态。尤其是碰到空目录、`isRepoRoot === false`、`commitsState === 'unreadable'`、`git.role` 或 `git.auth` 未明时必读。

## 一、勘察命令（只读、并发、无交互）

```sh
node "<本 skill 目录>/scripts/survey.mjs" <目标目录> [--probe-auth] [--verify-token] [--json]
```

- 默认纯只读扫描文件系统与本地 Git 状态（忽略 `.DS_Store`、`._*`、`__MACOSX`、`.Spotlight-V100`、`.Trashes`、`.fseventsd` 等 macOS Finder 元数据）；加 `--probe-auth` 后注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`SSH_ASKPASS_REQUIRE=never`、`GH_PROMPT_DISABLED=1`，并发探测 Track A（SSH 密钥就绪度 + `StrictHostKeyChecking=yes` 22/443、`git credential fill` 5s 硬超时、`gh auth setup-git`、`~/.ssh/config` 别名映射）与 Track B（`gh-cli` -> `node-https-token` -> 仅确认宿主能力时 `mcp-delegate` -> `half-duplex`/`offline`/`none`）。**即使尚未配置远端或处于空目录，传 `--probe-auth` 同样探测本机建仓凭据**；附加 `--verify-token` 可对本地令牌发一次轻量验活请求。
- 扫描结果末尾自带基于唯一判据生成的「下一步必读参考」，不靠人工记忆决定要读哪几份。

## 二、必须立即拦截的三类现场

1. **`isRepoRoot === false`（落在上级仓库子目录里）**：
   子目录本身无独立 `.git`，而父目录已有仓库。直接执行初始化或提交会把项目塞进毫不相干的父仓；必须先确认应独立建仓还是本就属于父仓单包模块。
2. **`commitsState === 'unreadable'`（仓库损坏或无权访问）**：
   不要把读不出提交误当成「零提交新仓库」，更不许直接重跑 `git init`；先排查工作树指针、`.git` 权限或对象损坏。
3. **空目录或近空目录起步（`effectiveFiles === 0`）**：
   只读扫描确认目录几乎空白时，不要自造骨架。停下来用 3-4 个简明问题确认：**项目定位与技术栈（Node / Python / Go / Rust / Java / 纯文档）**、**包名与简短描述**、**许可证倾向（如 MIT / Apache-2.0 / 私有不放）**、**是否需要连 GitHub 远端**。收齐后调用 `equip.mjs <目标目录> --bootstrap-empty --lang <技术栈> --name <包名>` 一次生成完整最小可运行工程基础：`.gitattributes`、`.gitignore`、初始 `README.md`、真实可运行源码与冒烟测试、填实 `Feature Map` 的 `docs/TDD.md`（不留空洞）及按档位装配的 `.agents/skills/`（已有文件跳过不覆盖；非空目录写前经 `scripts/backup.mjs` 自动打仓外 `.tar.gz` 快照）。

## 三、字段含义

| 字段 | 含义与行动影响 |
| --- | --- |
| `target` | 目标目录、规范名、是否可写；所有产物路径相对此根目录计算 |
| `scale` | `effectiveFiles`（排除忽略与系统杂项后的真实文件数）；为 0 时触发空目录起步流程 |
| `recommendedTier` | 依据代码规模、多包布局与协作信号给出的推荐装配档位（`lightweight` \| `full`），供用户确认后传给 `equip.mjs` / `compose-agents.mjs --tier` |
| `git` | `isRepoRoot`、`isBare`、`isShallow`、`commitsState`、`providerId`（`github` 或降级 `generic-git`）、`topology`（`0`/单/Fork/多远端 `remotes[]` 模型）与 `.git/pf-{local,fork,standalone}-mode` 标志 |
| `git.role` | 双轴五态身份：`local-only`（无远端或 `pf-local-mode`）、`maintainer`（与声明源一致且有写权限，或 `generic-git` 通用降级放行本地全流程）、`contributor-fork`（存在不同 `upstream` / Fork 仓 / `pf-fork-mode`）、`clone-readonly`（克隆他人正本且无写权限，**绝不误判为 maintainer**）、`undetermined`（缺依据，按保守贡献者处理） |
| `git.auth` | `https`、`ssh`（含 443 回退与指纹未收录提示）、`apiChannel`、`details`、`remediationCmd`（协议错配修复命令；缺凭据时渲染三路线认证指引） |
| `docs` | `readmes`、`agents`、`agentsBytes`（超 `30720` 报异常、`24576` 预警）、`tdd`、`existingDesignDocs`（识别 `ARCHITECTURE.md` / `*-TDD.md` / `docs/{design,architecture,adr}/` 避免双轨）、`workflowFacts`（明确拆分 `checkWorkflows` 与 `releaseWorkflows`，覆盖主流发布 Action）、`contributing`、`releasing`、`license` |
| `kit` | 扫描 `skills/<name>/SKILL.md` 及任意隐藏/项目技能容器 `<dir>/skills/<name>/SKILL.md`（无特定宿主路径硬编码），读取 `.agents/skills/.pf-manifest.json`（兼容 v1/v2，保留 `tier`、`disabledSkills`、`removedFiles`、`customizedFiles`） |
| `explorationStrategy` | 依据 `effectiveFiles`、多包/多生态与重入状态输出 `{ tier, reason, shards }`：`tier` 取 `none`（0 业务文件，转空目录起步）、`single-pass`（中小仓单路通读）、`parallel-subagents`（大型或重入仓，附 2–4 个不重叠 `shards` 分片） |
| `artifactPlan` | 由 `computeArtifactPlan` 产出的 11 项治理产物确定性处置列表（含拆分的 `ci-check` 与 `ci-release`），直接指明 `snapshot` / `preserve` / `calibrate` / `create` / `equip` / `upgrade` / `ask-human` / `optional` / `skip` |
| `reentry` | 仅当存在 `.pf-manifest.json`、受管标记或既定四层契约时判为重入（不误判存量手写 `AGENTS.md`）；输出 `staleAgentPaths`、`staleAgentScripts`（按 `commandsByEcosystem` 逐栈校验）、`staleTddPaths` 与 `unregisteredTopDirs` |
| `ecosystem` / `workspace` | 识别 Node、Python、Rust、Go、Java、Swift/Apple（`Package.swift` / `*.xcodeproj` / `*.xcworkspace`）等生态、入口清单与多包布局 |
| `risks` / `gaps` / `questions` / `navigation` | 凭据/路径/大文件风险、结构缺口、待拍板问题（含无远端建仓 3 路决策与 5 选 1 发版策略）及必读参考列表 |

### 并行只读分片探索规范（大型与重入仓写前前置）

- 当 `explorationStrategy.tier === 'parallel-subagents'` 时，**进入写入或生成阶段前必须先完成并行只读勘察**：按 `explorationStrategy.shards` 并发派发 2–4 个纯只读子代理，每人只负责互不重叠的分片（如顶层模块与架构入口、既有 `.agents/skills/` 与 `AGENTS.md` 规则、文档/测试/CI 现状）。
- **分片汇总规范**：子代理严禁修改任何文件、严禁越界重复扫描他人分片，只回传**真实存在路径 + 关键事实摘要 + 发现的漂移/风险**；主代理收齐后与 `reentry` 四个漂移列表交叉核对，再敲定校准与落盘范围。

### `artifactPlan` 逐项确定性处置对照表（按表落地，不自由重写）

| 产物 `id` | 常见 `action` 取值 | 存量融合与落地铁律 |
| --- | --- | --- |
| `pre-backup` | `snapshot` / `skip` | 非空目录写前必先 `backup.mjs create <目录> --label pre-forge`；空目录跳过 |
| `git-baseline` | `create` / `calibrate` / `preserve` | 已存在 `.gitignore`/`.gitattributes` 仅增补缺失安全/二进制规则，不清空已有规则 |
| `kit-skills` | `equip` / `upgrade` / `preserve` | 按 `recommendedTier`（`lightweight` \| `full`）装配或无损升级；尊重 v2 墓碑/定制并原样保留自有扩展技能 |
| `docs-tdd` | `create` / `calibrate` / `preserve` / `skip` | 纯文档仓可省；已有存量架构设计文档时优先 `preserve` 防双轨；漂移时仅局部校准 |
| `agents-contract` | `create` / `calibrate` / `preserve` | 缺失时先吸收既有 AI 约定（`otherAiConventions`）；漂移时保留手写规则，只刷新失效项 |
| `readme` | `preserve` / `create` | **已有 README 强制 `preserve`**：严禁套模板重写样式，仅失效命令/入口做最小校准 |
| `contributing` | `preserve` / `optional` / `skip` | 已存在原样保留；仅维护者且有远端时按需补齐 |
| `license` | `preserve` / `ask-human` | 已有单/双许可或私有声明强制保留；缺失一律由人拍板，绝不代选 |
| `releasing` | `preserve` / `create` / `skip` | 已有 `RELEASING.md`/变更记录保留；可发版或有发布流/tag 时建齐 |
| `ci-check` | `preserve` / `calibrate` / `create` / `skip` | 已有检查流保留；`contributor-fork` 与 `generic-git` 跳过；发现高危 `pull_request_target` 立即校准 |
| `ci-release` | `preserve` / `ask-human` / `skip` | 已有发布工作流或工具链保留；待配发版通道时走 5 选 1 决策，默认零额外 Secret 路线 |

## 事实来源

Git 与系统底层行为（如 macOS APFS 大小写与符号链接、OpenSSH `StrictHostKeyChecking` 参数语义）以当前操作系统、Git 官方文档与 Node.js 标准库行为为准。
