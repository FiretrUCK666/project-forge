# GitHub 远端连接、双轨鉴权与发布流水线

## 何时读本文件

需要把本地项目连上 GitHub、在无远端目录建仓、排查 SSH/HTTPS 鉴权或协议错配、配置多账号 SSH 别名、或者配置持续集成与发布策略时读完本文件。产品层注册表当前仅注册 `github` 适配器；未匹配宿主机的自建或其它远端地址会优雅降级为 `generic-git`，完整放行本地分支、三档隔离、测试门禁与本地合并流程（仅跳过远端 REST API 与 Actions 自动化）。

## 一、双轨四级连接引擎

探测与操作全程注入 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`、`SSH_ASKPASS=''`、`SSH_ASKPASS_REQUIRE=never`、`GCM_INTERACTIVE=never`、`GH_PROMPT_DISABLED=1`，并对 `git credential fill` 施以 `5000ms` 硬超时，防止 macOS Keychain 或 GUI 弹窗挂死；无远端目录传入 `--probe-auth` 时同样只读探测本机 `gh` / SSH / 凭据以引导建仓。

### 轨道 A：Git 传输层与协议自愈

| 通道 | 只读探测与无写盘边界 | 典型故障与自愈（`remediationCmd`） |
| --- | --- | --- |
| **SSH** | 先查 `ssh-add -l` 与 `~/.ssh/id_*` 密钥就绪度；显式使用 `StrictHostKeyChecking=yes` 探测 `ssh -T`（**严禁 `accept-new` 自动写盘**），22 端口不通自动回退 `ssh.github.com:443`；解析 `~/.ssh/config` `Host -> HostName` 映射支持多账号别名（如 `git@github-work:owner/repo.git`） | 未收录主机指纹时仅返回指纹核对命令，不擅自改写 `~/.ssh/known_hosts`；`origin` 与可用协议错配时返回一条 `git remote set-url` 自愈命令 |
| **HTTPS + 凭据助手** | 非交互调用 `git credential fill`（5s 硬超时）探测可用凭据与 `gh auth setup-git` 桥接；可选轻量 `GET /user`（带 `AbortSignal.timeout`）验活淘汰过期令牌 | 过期/401/403 令牌直接过滤并提示刷新，不冒充可用 |

### 轨道 B：GitHub API 四级降级

1. **`gh-cli`（首选）**：`gh auth status` 就绪时通过标准 CLI 完成查询、PR、Issue 与 Release 读写。
2. **`node-https-token`（原生自包含兜底）**：未装 `gh` 时使用 Node 内置 `node:https` 客户端（带 `AbortSignal.timeout`），优先读 `GH_TOKEN` / `GITHUB_TOKEN`，其次在 `WeakMap` 内存中复用 `git credential fill` 凭据——**严禁将令牌写入磁盘、日志、stdout 或返回值**。
3. **`mcp-delegate`（宿主代理协同）**：仅当明确确认宿主具备 GitHub MCP 能力时才返回委托载荷，由宿主已授权工具代执行。
4. **`half-duplex` / `offline` / `none`**：仅 Git SSH 可推时生成一键开 PR 比较链接；无可用凭据或离线时写本地任务账本并输出下方认证向导。

## 二、建仓三路决策、缺凭据向导与身份防锁

1. **无远端三路决策**：① 暂不配远端（在 `.git/` 创建 `pf-local-mode` 走纯本地）；② 绑定已有远端（`git remote add origin <url>`）；③ 新建 GitHub 仓库（**默认 `private` 私有**，按需选 `public`，并确认个人或组织归属；私有转公开前必查全历史凭据）。
2. **缺少凭据分步向导（三路线任选其一）**：
   - **`gh CLI` 路线**：安装后依次运行 `gh auth login` -> `gh auth setup-git` -> `gh repo create <owner>/<name> --private --source=. --push`。
   - **`SSH Ed25519` 路线**：生成密钥 `ssh-keygen -t ed25519 -C "<你的邮箱>"`；macOS 将私钥托管进钥匙串并执行 `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`（在 `~/.ssh/config` 配置 `AddKeysToAgent yes` 与 `UseKeychain yes`）；把 `~/.ssh/id_ed25519.pub` 写入 GitHub Settings -> SSH Keys，运行 `ssh -T git@github.com` 校验后执行 `git remote add origin git@github.com:<owner>/<repo>.git`。
   - **`HTTPS + Fine-grained PAT + GCM` 路线**：在 GitHub 生成仅勾选目标仓库 `Contents` 与 `Pull requests` 最小权限的 Fine-grained PAT，存入系统凭据管理器（macOS Keychain / Windows GCM），**严禁把 PAT 写入 `.git/config` 远端 URL**。
3. **身份归属与本地模式标志**：识别 `.git/pf-local-mode`（强制纯本地）、`.git/pf-fork-mode`（Fork 协作）、`.git/pf-standalone-mode`（独立项目维护者）。单人仓勿开启「合并必须他人审批（`require approving reviews >= 1`）」防止自锁。

## 三、仓库设置、Rulesets 与分支保护

- 对齐 `DEFAULT_BRANCH`（通常 `main`）；推自己分支与开/改 PR 属 `two-way` 可逆日常，合并默认分支、发版与改可见性属 `one-way` 不可逆操作。
- **Rulesets / 分支保护 Required Check 对齐**：规则里登记的状态检查名必须与 `ci-check.yml` 中 `jobs.<jobId>.name`（开启 `matrix` 时带 `(<matrix值>)` 后缀）逐字一致。
- **`delete_branch_on_merge` 冲突提示**：若平台开启合并后自动删分支，手工合并收尾的第 7 步 `git ls-remote` 会看到远端分支已消失；存在下游堆叠 PR 时谨慎开启自动删分支。
- **团队协作可选设施**：按团队人数与协作者规模按需配置 `CODEOWNERS`、Dependabot 与基础 Issue/PR 标签。

## 四、多账号与凭据边界

- **严禁把 PAT / OAuth 令牌写进 `.git/config` 的 `remote.origin.url`**。
- 本机多账号（个人 vs 工作）在 `~/.ssh/config` 为每个账号配独立 `Host` 别名与 `HostName github.com`、`IdentityFile`（macOS 可配合 `UseKeychain yes`）及 `IdentitiesOnly yes`，提交前按 `references/version-control.md` 的「提交署名」与「凭据门控」核对身份。

## 五、Issue / PR 模板与非 ASCII 防乱码

- 仓库模板位于 `templates/issue-bug-report.md`、`templates/issue-feature-request.md` 与 `templates/pull-request-template.md`。
- 通过平台命令创建或更新 Issue、PR、Release 或发表评论时，凡包含中文或非 ASCII 内容，**一律先写入系统临时目录 UTF-8 文件并传 `--body-file` / `--notes-file`（或原生 HTTPS JSON 体），提交后回读比对并清理临时文件**——严禁命令行拼接正文字符串。

## 六、版本节点与发布说明

- **日常合并即终点，不随手发版**；只有人明确说要发版时才按 `RELEASING.md` 执行。
- **发版策略 5 选 1**：
  1. **不配置发版流水线**（内部/实验或本地工具）；
  2. **沿用已有工具**（检测到 `.changeset/`、`release-please-config.json`、`.releaserc*`、`.goreleaser*` 时直接 `preserve`，并在 `AGENTS.md` 对齐该工具实际流转）；
  3. **纯手动发版**（按需人工运行 `gh release create`）；
  4. **Tag 触发自动发布页（默认零额外 Secret 路线）**：使用 `templates/ci-release.yml` 监听标签并读取默认分支说明，**默认直接使用内置 `GITHUB_TOKEN` + `permissions: contents: write`，无需额外建个人密钥**；
  5. **联动下游或推送包仓库（按需增强路线）**：仅当发版后须触发下游工作流、回写受保护分支或发布制品库时，才引导配置最小权限 Fine-grained PAT 写入仓库 Secrets（`RELEASE_TOKEN`）或生态 OIDC 可信发布（免长期静态 Secret）。
- 严格次序：先提交并推送发布说明 `docs/release-notes/<标签>.md`（骨架见 `templates/release-notes.md`）或 `CHANGELOG.md` 对应节至默认分支，再打标签推送。

## 七、持续集成

- 检查骨架 `templates/ci-check.yml`（Push / PR 时跑构建、静态检查、测试与契约校验）与发布页骨架 `templates/ci-release.yml`（Tag 推送触发，校验版本号与说明文件正文非空并回读比对 Release 正文；支持 `docs/release-notes/<标签>.md` 与 `CHANGELOG.md` 的 `## [v1.2.3]` / `## [1.2.3]` 双标题格式；模板默认专注说明同步与校验，需上传构建附件的项目可在校验步骤后追加资产上传步骤）。
- **外部 PR 供应链与弱化门禁防线**：外来 Fork PR 触碰工作流、锁文件或生命周期脚本时必须先只读扫描并经人工确认才运行；本地 `flow.mjs merge` 检测到弱化门禁时以退出码 `4` 阻断，必须 `--human-approved` 方可放行；`govern-audit.mjs` 解析 `.github/workflows/*.{yml,yaml}` 比对孤儿测试套。

## 事实来源

GitHub Actions 内置 Runner 版本、官方 Action 主版本号、Fine-grained PAT 权限范围、Rulesets 语法及 OIDC 信任配置随平台演进，落盘前与遇到 `401`/`403`/`422` 报错时直接查阅 GitHub 官方 Docs（Actions / Repositories / Releases / Authentication 对应小节）核准最新规范。
