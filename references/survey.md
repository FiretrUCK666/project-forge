# 只读勘察与状态判定

## 何时读本文件

在改写任何文件、初始化版本库或创建文档之前，先读完勘察输出并对照本文判读状态。尤其是碰到空目录、`isRepoRoot === false`、`commitsState === 'unreadable'`、`git.role` 或 `git.auth` 未明时必读。

## 一、勘察命令（只读、并发、无交互）

```sh
node "<本 skill 目录>/scripts/survey.mjs" <目标目录> [--probe-auth] [--json]
```

- 默认纯只读扫描文件系统与本地 Git 状态；加 `--probe-auth` 后注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`BatchMode=yes`，并发探测 GitHub Track A（SSH 22 / 443 端口、HTTPS Credential Helper、`gh auth setup-git` 桥接、协议错配修复命令）与 Track B（`gh-cli` -> `node-https-token` -> `mcp-delegate` -> `half-duplex`/`offline`），绝不挂起弹窗或泄露令牌。
- 扫描结果末尾自带基于唯一判据生成的「下一步必读参考」，不靠人工记忆决定要读哪几份。

## 二、必须立即拦截的三类现场

1. **`isRepoRoot === false`（落在上级仓库子目录里）**：
   子目录本身无独立 `.git`，而父目录已有仓库。直接执行初始化或提交会把项目塞进毫不相干的父仓；必须先确认应独立建仓还是本就属于父仓单包模块。
2. **`commitsState === 'unreadable'`（仓库损坏或无权访问）**：
   不要把读不出提交误当成「零提交新仓库」，更不许直接重跑 `git init`；先排查工作树指针、`.git` 权限或对象损坏。
3. **空目录或近空目录起步（`effectiveFiles === 0`）**：
   只读扫描确认目录几乎空白时，不要自造骨架。停下来用 3-4 个简明问题确认：**项目定位与技术栈（Node / Python / Go / Rust / 纯文档）**、**包名与简短描述**、**许可证倾向（如 MIT / Apache-2.0 / 私有不放）**、**是否需要连 GitHub 远端**。收齐后调用 `equip.mjs <目标目录> --bootstrap-empty --lang <技术栈> --name <包名>` 一次生成完整最小可跑工程闭环：`.gitattributes`、`.gitignore`、初始 `README.md`、真实可跑源码与冒烟测试、填实 `Feature Map` 的 `docs/TDD.md`（不留空洞）及全套 5 个 `.agents/skills/`（已有文件跳过不覆盖；非空目录写前经 `scripts/backup.mjs` 自动打仓外 `.tar.gz` 快照）。

## 三、字段含义

| 字段 | 含义与行动影响 |
| --- | --- |
| `target` | 目标目录、规范名、是否可写；所有产物路径相对此根目录计算 |
| `scale` | `effectiveFiles`（排除忽略与构建目录后的真实文件数）；为 0 时触发空目录起步流程 |
| `git` | `isRepoRoot`、`isWorktree`（区分独立 worktree 与损坏 `.git`）、`worktreeParent`、`commitsState`、`defaultBranch`、`submodules` |
| `git.role` | 双轴五态身份：`local-only`（无远端或 `.git/pf-local-mode`）、`maintainer`（与声明源一致且有写权限或自有确认）、`contributor-fork`（存在不同 `upstream` 或 Fork 仓）、`clone-readonly`（克隆他人正本且无写权限，**绝不误判为 maintainer**）、`undetermined`（缺依据，按保守贡献者处理） |
| `git.auth` | `https`、`ssh`（含 443 回退结果）、`apiChannel`、`details`、`remediationCmd`（协议错配可执行修复命令；SSH-only 仓不再误报无凭据） |
| `docs` | `readmes`、`agents`、`agentsBytes`（超 `30720` 报异常、`24576` 预警；含 `行事总纲` 与 7 键 `Dev Profile`）、`tdd`（`docs/TDD.md`）、`prdDir`、`specsDir`、`todoDir`、`contributing`、`releasing`、`license`、`releaseNotesMode`；缺项决策口径见 `references/docs-set.md` |
| `kit` | 扫描 `.agents/skills/`（仅计含 `SKILL.md` 的合法技能目录）并分离内置 5 技能与项目自有 `kit.customSkills`（含 `name`、`path`、`summary`、`valid`），同时读取 `.agents/skills/.pf-manifest.json` 哈希账本状态；后续探索由 `repo-map.mjs` 提取 `reusableModules`、`featureMap` 与 CI 步骤 |
| `explorationStrategy` | 依据 `effectiveFiles`、顶层代码目录与已有治理标记输出 `{ tier, reason, shards }`：`tier` 取 `none`（0 业务文件，转空目录起步）、`single-pass`（中小仓单路通读）、`parallel-subagents`（大型或重入仓，附 2–4 个不重叠 `shards` 分片） |
| `artifactPlan` | 由 `computeArtifactPlan` 产出的 10 项治理产物确定性处置列表（`{ id, artifact, status, action, detail }`），直接指明每一项应 `snapshot` / `preserve` / `calibrate` / `create` / `equip` / `upgrade` / `ask-human` / `optional` / `skip` |
| `reentry` | 跨月重入或存量接入时的漂移快照：`staleAgentPaths`（`AGENTS.md` 提及但磁盘已删的路径）、`staleAgentScripts`（声明的脚本或命令已不存在）、`staleTddPaths`（`docs/TDD.md` 中的失效路径）、`unregisteredTopDirs`（新增但未登记的顶层模块目录） |
| `ecosystem` / `workspace` | 语言生态、入口清单、`packageManager`、多包目录列表（驱动 `AGENTS.md` 多包边界与忽略规则） |
| `artifacts` | 运行环境下限（`runtimeRequirements`）与从配置提取的标准命令 |
| `ci` / `publish` | 现有 GitHub Actions 流水线与发布通道线索 |
| `risks` | `credentialFindings`（硬编码密钥/令牌）、`homePathLeaks`（严格区分 `test-data` 夹具与真实源码 `leak`）、`largeFiles`、未忽略的构建产物 |
| `gaps` / `decisions` / `questions` | 缺口清单（对应 `review.mjs` 体检规则）、需人拍板的取舍项、精简提问列表 |
| `navigation` | 按当前现场算出的必读参考列表，读完对应文档前不进入写入阶段 |

### 并行只读分片探索规范（大型与重入仓写前前置）

- 当 `explorationStrategy.tier === 'parallel-subagents'` 时，**进入写入或生成阶段前必须先完成并行只读勘察**：按 `explorationStrategy.shards` 并发派发 2–4 个纯只读子代理，每人只负责互不重叠的分片（如顶层模块与架构入口、既有 `.agents/skills/` 与 `AGENTS.md` 规则、文档/测试/CI 现状）。
- **分片汇总规范**：子代理严禁修改任何文件、严禁越界重复扫描他人分片，只回传**真实存在路径 + 关键事实摘要 + 发现的漂移/风险**；主代理收齐后与 `reentry` 四个漂移列表交叉核对，再敲定校准与落盘范围。

### `artifactPlan` 逐项确定性处置对照表（按表落地，不自由重写）

| 产物 `id` | 常见 `action` 取值 | 存量融合与落地铁律 |
| --- | --- | --- |
| `pre-backup` | `snapshot` / `skip` | 非空目录写前必先 `backup.mjs create <目录> --label pre-forge`；空目录跳过 |
| `git-baseline` | `create` / `calibrate` / `preserve` | 已存在 `.gitignore`/`.gitattributes` 仅增补缺失安全/二进制规则，不清空已有规则 |
| `kit-skills` | `equip` / `upgrade` / `preserve` | 全量装配或无损升级 5 个内置技能；**原样保留 `.agents/skills/<custom>/`** |
| `docs-tdd` | `create` / `calibrate` / `preserve` / `skip` | 纯文档仓可省；命中 `staleTddPaths`/`unregisteredTopDirs` 仅局部校准，保留既有决断 |
| `agents-contract` | `create` / `calibrate` / `preserve` | 缺失时先吸收既有 AI 约定（`otherAiConventions`）；漂移时保留手写规则，只刷新失效项 |
| `readme` | `preserve` / `create` | **已有 README 强制 `preserve`**：严禁套模板重写样式，仅失效命令/入口做最小校准 |
| `contributing` | `preserve` / `optional` / `skip` | 已存在原样保留；仅维护者且有远端时按需补齐 |
| `license` | `preserve` / `ask-human` | 已有单/双许可或私有声明强制保留；缺失一律由人拍板，绝不代选 |
| `releasing` | `preserve` / `create` / `skip` | 已有 `RELEASING.md`/变更记录保留；可发版或有发布流/tag 时建齐 |
| `ci-workflows` | `preserve` / `create` / `skip` | 已有检查流保留；`contributor-fork` 跳过；非标目录布局原样尊重不强改结构 |
