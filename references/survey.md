# 只读勘察与状态判定

## 何时读本文件

在改写任何文件、初始化版本库或创建文档之前，先读完勘察输出并对照本文判读状态。尤其是碰到空目录、`isRepoRoot === false`、`commitsState === 'unreadable'`、`git.role` 或 `git.auth` 未明时必读。

## 一、勘察命令（只读、并发、无交互）

```sh
node "<本 skill 目录>/scripts/survey.mjs" <目标目录> [--probe-auth] [--verify-token] [--json]
```

- 默认纯只读扫描文件系统与本地 Git 状态（忽略 `.DS_Store`、`._*`、`__MACOSX`、`.Spotlight-V100`、`.Trashes`、`.fseventsd` 等 macOS Finder 元数据）；加 `--probe-auth` 后注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`SSH_ASKPASS_REQUIRE=never`、`GH_PROMPT_DISABLED=1`，并发探测 Track A（SSH 密钥就绪度 + `StrictHostKeyChecking=yes` 22/443、`git credential fill` 5s 硬超时、`gh auth setup-git`、`~/.ssh/config` 别名映射）与 Track B（`gh-cli` -> `node-https-token` -> 仅确认宿主能力时 `mcp-delegate` -> `half-duplex`/`offline`/`none`）。**即使尚未配置远端或处于空目录，传 `--probe-auth` 同样探测本机建仓凭据**；附加 `--verify-token` 可对本地令牌发一次轻量验活请求。
- **外部调研边界与 `NEEDS_HUMAN` 停步铁律**：S1/S2 仓内事实以本地源码与脚本输出为准，离线或勘察仓内现状时禁用网页搜索代替本地核验；仅当需求澄清、技术选型或用户明确要求时允许调用外部网络检索与网页读取工具调研（注明外部来源），且任何写入文档/规划的仓内路径、符号与命令必须经 `doc-locate`、`repo-map` 或 `verifyDocClaims` 在本仓验真（Repo-Path Grounding）；当 `NEEDS_HUMAN > 0`（`needsHuman.count > 0`，如缺许可、`role=undetermined`、缺 Git 署名或待选发版策略）时**严禁任何 S3 写入**，必须先全部问清并等用户拍板后再进入 S3。
- 扫描结果末尾自带基于唯一判据生成的「下一步必读参考」，不靠人工记忆决定要读哪几份。

## 二、必须立即拦截的三类现场

1. **`isRepoRoot === false`（落在上级仓库子目录里）**：
   子目录本身无独立 `.git`，而父目录已有仓库。直接执行初始化或提交会把项目塞进毫不相干的父仓；必须先确认应独立建仓还是本就属于父仓单包模块。
2. **`commitsState === 'unreadable'`（仓库损坏或无权访问）**：
   不要把读不出提交误当成「零提交新仓库」，更不许直接重跑 `git init`；先排查工作树指针、`.git` 权限或对象损坏。
3. **空目录或近空目录起步（`effectiveFiles === 0` 或仅含 `README`/`LICENSE`/`.github`/`.agents`）**：
   只读扫描确认无业务源码或生态清单时，停下来用 3-4 个简明问题确认：**项目定位与栈倾向（`universal` / 12 生态栈 / `docs`）**、**包名与简短描述**、**许可证倾向（如 MIT / Apache-2.0 / 私有不放）**、**是否需要连远端（GitHub / `generic-git` / 暂存纯本地 `local-only`）**。收齐后调用 `equip.mjs <目标目录> --bootstrap-empty --stack <技术栈> --name <包名>`（兼容 `--lang`）一次生成零玩具业务源码的通用治理基线：`git init`、`.gitattributes`、`.gitignore`（按栈配置忽略规则）、缺失时补 `README.md`（已有 `README.md`/`LICENSE` 原文跳过不覆盖）、无占位 `docs/TDD.md`、`docs/feature-map.json`、`docs/{prd,specs,todo}/.gitkeep`、按档位装配的 `.agents/skills/` 与初始自洽 `AGENTS.md`（生成即过 `compose-agents --check` 与 `review.mjs`；非空目录写前经 `scripts/backup.mjs` 自动打仓外 `.zip` 快照）。三层命令嗅探由 `kit/skills/lib/profile-sniffer.mjs` 单源驱动（`Dev Profile -> 2/4 空格中立 CI 与 Makefile/justfile/Taskfile -> 跳过 vendor/examples 等深层非第三方多语言子包`）。

## 三、字段含义

| 字段 | 含义与行动影响 |
| --- | --- |
| `target` | 目标目录、规范名、是否可写；所有产物路径相对此根目录计算 |
| `scale` | `effectiveFiles`（排除忽略与系统杂项后的真实文件数）；为 0 时触发空目录起步流程 |
| `git` | `isRepoRoot`、`isBare`、`isShallow`、`commitsState`、`providerId`（`github` 或降级 `generic-git`）、`topology`（`0`/单/Fork/多远端 `remotes[]` 模型）与 `.git/pf-{local,fork,standalone}-mode` 标志 |
| `git.role` | 双轴五态身份：`local-only`（无远端或 `pf-local-mode`）、`maintainer`（与声明源一致且有写权限，或 `generic-git` 通用降级放行本地全流程）、`contributor-fork`（存在不同 `upstream` / Fork 仓 / `pf-fork-mode`）、`clone-readonly`（克隆他人正本且无写权限，**绝不误判为 maintainer**）、`undetermined`（缺依据，按保守贡献者处理） |
| `git.auth` | `https`、`ssh`（含 443 回退与指纹未收录提示）、`apiChannel`、`details`、`remediationCmd`（协议错配修复命令；缺凭据时渲染三路线认证指引） |
| `docs` | `readmes`（含双语及 `.rst`/无后缀 README）、`agents`、`agentsBytes`（超 `30720` 报异常、`24576` 预警）、`tdd`、`existingDesignDocs`（配合单源 `discoverEvergreenDocs` 支持可选 `evergreen-docs:`、Frontmatter `evergreen: true` 与入口链接三层纳管常青文档，避免双轨）、`nonStandardDocs`、`preservedForeignPlanDocs`（原样保留目标仓原生 `docs/{specs,todo}/*`）、`workflowFacts`（含 `.github/workflows` 与中立 CI `neutralCiConfigs`，明确拆分 `checkWorkflows` 与 `releaseWorkflows`）、`contributing`、`releasing`、`license` |
| `kit` | 扫描非隐藏 `skills/*`（含嵌套 `*/skills/*`）与任意隐藏/项目技能容器 `<dir>/skills/<name>/SKILL.md`（无特定宿主路径硬编码，自动区分宿主镜像副本 `mirrorCopies` 不双计不误删），读取 `.agents/skills/.pf-manifest.json`（兼容 v1/v2/v3，保留 `disabledSkills`、`removedFiles`、`customizedFiles`） |
| `explorationStrategy` | 依据 `effectiveFiles`、多包/多生态与重入状态输出 `{ tier, reason, shards }`：`tier` 取 `none`（0 业务文件，转空目录起步）、`single-pass`（中小仓单路通读）、`parallel-subagents`（大型或重入仓，附 2–5 个不重叠 `shards` 分片，含 `business-flows` 核心业务流分片） |
| `artifactPlan` | 由 `computeArtifactPlan` 产出的 13 项治理产物确定性处置列表（含拆分的 `ci-check`/`ci-release` 与 `branch-protection`/`git-hooks`），并按条件附加 `feature-map`/`architecture-map`，直接指明 `snapshot` / `preserve` / `calibrate` / `create` / `equip` / `upgrade` / `ask-human` / `optional` / `skip` |
| `reentry` | 仅当存在 `.pf-manifest.json`、受管标记或既定四层契约时判为重入（不误判存量手写 `AGENTS.md`）；输出 `staleAgentPaths`、`staleAgentScripts`（按 `commandsByEcosystem` 逐栈校验）、`staleTddPaths` 与 `unregisteredTopDirs` |
| `ecosystem` / `workspace` | 识别 Node、Python、Rust、Go、Java、Swift/Apple（`Package.swift` / `*.xcodeproj` / `*.xcworkspace`）等生态、入口清单与多包布局 |
| `risks` / `gaps` / `questions` / `navigation` | 凭据/路径/大文件风险、结构缺口、待拍板问题（含无远端建仓 3 路决策与 5 选 1 发版策略）及必读参考列表 |

### 并行只读分片探索规范（大型与重入仓写前前置）

- 当 `explorationStrategy.tier === 'parallel-subagents'` 时，**进入写入或生成阶段前必须先完成并行只读勘察**：按 `explorationStrategy.shards` 并发派发 2–4 个纯只读子代理，每人只负责互不重叠的分片（如顶层模块与架构入口、既有 `.agents/skills/` 与 `AGENTS.md` 规则、文档/测试/CI 现状）；若当前宿主不支持派生子代理，则显式标明 `hostCapability: serial-fallback` 并按同一 `shards` 清单分片串行执行，不跳过任何分片。
- **分片汇总规范**：子代理严禁修改任何文件、严禁越界重复扫描他人分片，只回传**真实存在路径 + 关键事实摘要 + 发现的漂移/风险**（其中 `business-flows` 分片对照 `repo-map.mjs` 的 `businessFlows` 汇总服务对象、路由/CLI/UI/作业面与文档源码差异）；主代理收齐后与 `reentry` 四个漂移列表交叉核对，再敲定校准与落盘范围。
- **改前只读实跑基线（`S1 -> S3` 前置）**：对非空存量代码仓进入 `S3` 写入前，先以**只读非破坏方式实跑对方既有测试与主入口**，采集 **`preForgeBaseline`**（执行命令、退出码/通过情况、主入口实测状态）直接写入 `docs/TDD.md`（`AGENTS.md` 仅留薄指针以守住体积预算），确保后续治理全过程可对照改前真基线核验无退化。

### 四类存量资产真融合协议（S2/S3 必守）

存量项目接入绝不做「表面补齐几份文件」的浅层覆盖，而是按四类资产做结构化融合，并把发现的原仓问题全部通过 `TaskBackend` 建本地或远端 Issue 按正常流程分步修清：

1. **长青文档**：识别既有架构/设计/API/数据库说明（`ARCHITECTURE.md`、`docs/adr/` 等）并统一纳入 `evergreen-docs:` / `docs/TDD.md` 单源映射，合并冲突多副本并清理过期副本。
2. **非长青/过期/无效文档**：历史临时方案、过期 Todo 或无效文档归档至 `docs/archive/` 或标出无效残片确认清理，防止污染 `doc-locate` 与后续检索。
3. **既有脚本、工具、数据模型/迁移与 CI**：直接融入 `Dev Profile`、`docs/feature-map.json` 与 `docs/TDD.md`（配合 `tdd-shape.mjs` 裁剪数据模型与部署节），对失效或冲突脚本清晰标出清理建议。
4. **既有 AI 约定（`AGENTS.md`、`CLAUDE.md`、`.cursorrules`、自有技能）**：做语义去重与无损融合（而非机械追加堆叠），保留项目自身约定与扩展槽位。

### `artifactPlan` 逐项确定性处置对照表（按表落地，不自由重写）

| 产物 `id` | 常见 `action` 取值 | 存量融合与落地铁律 |
| --- | --- | --- |
| `pre-backup` | `snapshot` / `skip` | 非空目录写前必先 `backup.mjs create <目录> --label pre-forge`；空目录跳过 |
| `git-baseline` | `create` / `calibrate` / `preserve` | 已存在 `.gitignore`/`.gitattributes` 仅增补缺失安全/二进制规则，不清空已有规则 |
| `kit-skills` | `equip` / `upgrade` / `preserve` | 统一全量装配或无损升级已落盘研发技能；尊重 v3 墓碑/定制/三方合并并原样保留自有扩展技能 |
| `docs-tdd` | `create` / `calibrate` / `preserve` / `skip` | 纯文档仓可省；已有存量架构设计文档时优先 `preserve` 防双轨；漂移时仅局部校准 |
| `agents-contract` | `create` / `calibrate` / `preserve` | 缺失时先吸收既有 AI 约定（`otherAiConventions`）；漂移时保留手写规则，只刷新失效项 |
| `readme` | `preserve` / `create` | **已有 README 强制 `preserve`**：严禁套模板重写样式，仅失效命令/入口做最小校准 |
| `contributing` | `preserve` / `optional` / `skip` | 已存在原样保留；仅维护者且有远端时按需补齐 |
| `license` | `preserve` / `ask-human` | 已有单/双许可或私有声明强制保留；缺失一律由人拍板，绝不代选 |
| `releasing` | `preserve` / `create` / `skip` | 已有 `RELEASING.md`/变更记录保留；可发版或有发布流/tag 时建齐 |
| `ci-check` | `preserve` / `calibrate` / `create` / `skip` | 已有检查流保留；`contributor-fork` 与 `generic-git` 跳过；发现高危 `pull_request_target` 立即校准 |
| `ci-release` | `preserve` / `ask-human` / `skip` | 已有发布工作流或工具链保留；待配发版通道时走 5 选 1 决策，默认零额外 Secret 路线 |
| `branch-protection` | `preserve` / `create` / `ask-human` / `skip` | 有能力后端按开关 A（`equip-ci.mjs --protect-branch`）设分支保护（`require_approvals=0`）；无权限/403 降级为 `git-hooks`；`generic-git` 输出手工清单 |
| `git-hooks` | `preserve` / `create` / `skip` | 冲突 `.husky/`/`lefthook*` 一律 `preserve`；无冲突且未写 `no-git-hooks` 时通过 `equip.mjs --with-hooks` 装配 `.githooks/pre-push` |
| `feature-map` | `preserve` / `create` / `skip` | 空白仓或纯文档仓跳过；存量代码仓缺失时运行 `verify-tools.mjs sync` 自动索引生成 `docs/feature-map.json`（兼容 v1/v2 分层拓扑与无环依赖校验） |
| `architecture-map` | `preserve` / `calibrate` / `create` / `skip` | 空白仓、纯文档仓或写了 `no-architecture-html` 时跳过；存在代码时运行 `verify-tools.mjs render` 确定性派生或校验离线交互式 `docs/architecture-map.html`（指纹匹配时豁免 UI 强锁） |

## 事实来源

Git 与系统底层行为（如 macOS APFS 大小写与符号链接、OpenSSH `StrictHostKeyChecking` 参数语义）以当前操作系统、Git 官方文档与 Node.js 标准库行为为准。
