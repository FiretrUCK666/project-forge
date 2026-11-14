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
   只读扫描确认目录几乎空白时，不要自造骨架。停下来用 3-4 个简明问题确认：**项目定位与技术栈（Node / Python / Go / Rust / 纯文档）**、**包名与简短描述**、**许可证倾向（如 MIT / Apache-2.0 / 私有不放）**、**是否需要连 GitHub 远端**。收齐后调用 `equip.mjs <目标目录> --bootstrap-empty --lang <技术栈> --name <包名>` 一次搭出最小可跑工程、冒烟测试、初始 `docs/TDD.md` 与 `.agents/skills/`。

## 三、字段含义

| 字段 | 含义与行动影响 |
| --- | --- |
| `target` | 目标目录、规范名、是否可写；所有产物路径相对此根目录计算 |
| `scale` | `effectiveFiles`（排除忽略与构建目录后的真实文件数）；为 0 时触发空目录起步流程 |
| `git` | `isRepoRoot`、`isWorktree`（区分独立 worktree 与损坏 `.git`）、`worktreeParent`、`commitsState`、`defaultBranch`、`submodules` |
| `git.role` | 双轴五态身份：`local-only`（无远端或 `.git/pf-local-mode`）、`maintainer`（与声明源一致且有写权限或自有确认）、`contributor-fork`（存在不同 `upstream` 或 Fork 仓）、`clone-readonly`（克隆他人正本且无写权限，**绝不误判为 maintainer**）、`undetermined`（缺依据，按保守贡献者处理） |
| `git.auth` | `https`、`ssh`（含 443 回退结果）、`apiChannel`、`details`、`remediationCmd`（协议错配可执行修复命令；SSH-only 仓不再误报无凭据） |
| `docs` | `readmes`、`agents`、`agentsBytes`（超 `30720` 报异常、`24576` 预警）、`tdd`（`docs/TDD.md`）、`prdDir`、`specsDir`、`todoDir`、`contributing`、`releasing`、`license`、`releaseNotesMode`；缺项决策口径见 `references/docs-set.md` |
| `kit` | 扫描 `.agents/skills/`（仅计含 `SKILL.md` 的合法技能目录）并读取 `.agents/skills/.pf-manifest.json` 哈希账本状态 |
| `ecosystem` / `workspace` | 语言生态、入口清单、`packageManager`、多包目录列表（驱动 `AGENTS.md` 多包边界与忽略规则） |
| `artifacts` | 运行环境下限（`runtimeRequirements`）与从配置提取的标准命令 |
| `ci` / `publish` | 现有 GitHub Actions 流水线与发布通道线索 |
| `risks` | `credentialFindings`（硬编码密钥/令牌）、`homePathLeaks`（严格区分 `test-data` 夹具与真实源码 `leak`）、`largeFiles`、未忽略的构建产物 |
| `gaps` / `decisions` / `questions` | 缺口清单（对应 `review.mjs` 体检规则）、需人拍板的取舍项、精简提问列表 |
| `navigation` | 按当前现场算出的必读参考列表，读完对应文档前不进入写入阶段 |
