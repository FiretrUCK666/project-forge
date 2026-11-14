# GitHub 远端连接、双轨鉴权与发布流水线

## 何时读本文件

需要把本地项目连上 GitHub、排查 SSH/HTTPS 鉴权或协议错配、设计多账号隔离、或者配置持续集成与标签发布工作流时读完本文件。**本体系仅适配 GitHub**，不对非 GitHub 托管平台做假设或兼容降级。

## 一、双轨四级连接引擎

探测与操作全程注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`BatchMode=yes`，绝不因等待弹窗或密码输入卡死；同时将 Git 传输层与 GitHub API 控制面彻底拆开探测：

### 轨道 A：Git 传输层与协议自愈

| 通道 | 探测方式与回退 | 典型故障与自愈（`remediationCmd`） |
| --- | --- | --- |
| **SSH** | 并发探测 `ssh -T git@github.com`（22 端口）；超时或被防火墙拒连时自动回退尝试 `ssh.github.com:443` | 仅 SSH 可通时不再误报「缺 HTTPS 凭据」；提示写入 `~/.ssh/config` 443 端口转发 |
| **HTTPS + 凭据助手** | 非交互调用 `git credential fill` 探测当前主机与仓库路径可用性及 `gh auth setup-git` 桥接状态 | `origin` 为 HTTPS 而仅 SSH 通（或反之）时，返回一条可执行切换命令直接自愈 |

### 轨道 B：GitHub API 四级降级

1. **`gh-cli`（首选）**：`gh auth status` 就绪时通过标准 CLI 完成查询、PR、Issue 与 Release 读写。
2. **`node-https-token`（原生自包含兜底）**：未装 `gh` 时使用 Node 内置 `node:https` 客户端，优先读环境变量 `GH_TOKEN` / `GITHUB_TOKEN`，其次**在内存中**复用 `git credential fill` 吐出的凭证发起 REST/GraphQL 请求——**严禁将令牌写入磁盘、日志、stdout 或函数返回值**。
3. **`mcp-delegate`（宿主代理协同）**：无 CLI 与无环境变量/凭据令牌时，返回规范化 JSON 载荷与 HTML 隐式状态标，交由宿主环境已授权工具代执行。
4. **`half-duplex` / `offline`（半双工或全离线）**：仅 Git SSH 可推分支时，生成一键开 PR 比较链接供人点击；全离线时只写本地任务账本。

## 二、建仓库、默认私有与身份防锁

1. **新仓默认设为私有**：私有转为公开之前，必须先核对全历史凭据、敏感路径与权限配置。
2. **核对身份归属**：`origin` 指向他人仓库或存在上游 `upstream` 时按 `clone-readonly` 或 `contributor-fork` 处理，绝不误走维护者建标签或直推路径（详情见协作判据的五态表）。
3. **单人项目防自锁**：不要为只有一个维护者的仓库开启「合并必须有他人审批（require approving reviews >= 1）」，否则 PR 永远合不进去。

## 三、仓库设置与分支保护

- 对齐 `DEFAULT_BRANCH`（通常 `main`）；开启合并策略与必要的状态检查。按**单向门/双向门**划分：推自己分支与开/改 PR 属 `two-way` 可逆日常；合并默认分支、发版与改可见性属 `one-way` 不可逆操作。
- **不要勾选自动删远端分支**——合并收尾须按顺序先检下游堆叠 PR 与 Fork PR 状态，经人点头再删。
- 若存在已保护默认分支，维护者同样走分支与 PR，不绕过门禁强推主干。

## 四、多账号与凭据边界

- **严禁把 PAT / OAuth 令牌写进 `.git/config` 的 `remote.origin.url`**：写进去即等于明文落盘在本地配置里。
- 本机多账号（如个人 vs 工作）应通过 SSH 别名或按路径切换 `credential.helper`，并在提交前按 `references/version-control.md` 的「提交署名」与「凭据门控」核对作者身份。

## 五、Issue / PR 模板与非 ASCII 防乱码

- 仓库模板位于 `templates/issue-bug-report.md`、`templates/issue-feature-request.md` 与 `templates/pull-request-template.md`。
- 通过脚本或终端工具创建、更新 Issue、PR、Release 或发表评论时，凡包含中文或非 ASCII 内容，**一律先写入系统临时目录 UTF-8 文件并传 `--body-file` / `--notes-file`（或原生 HTTPS JSON 体），提交后回读比对并清理临时文件**——严禁直接在 shell 命令行拼接中文正文字符串。

## 六、版本节点与发布说明

- **日常合并即终点，不随手发版**；只有人明确说要发版时才按 `RELEASING.md` 执行。
- 严格次序：先提交并推送发布说明文件 `docs/release-notes/<标签>.md`（骨架见 `templates/release-notes.md`）至默认分支，确认远端已存在后再打标签推送——顺序颠倒会导致发布流水线读不到说明直接失败。

## 七、持续集成

- 门禁骨架 `templates/ci-check.yml`（Push / PR 时跑构建、静态检查、测试与契约校验）与发版骨架 `templates/ci-release.yml`（Tag 推送触发，校验发布说明正文并上传附件）。
- **外部 PR 供应链与弱化门禁防线**：外来 Fork PR 触碰工作流、锁文件或包生命周期脚本时必须先只读扫描并经人工确认才运行；本地 `flow.mjs merge` 检测到 diff 删断言、加 `.skip`/`.only`、加 `continue-on-error: true`/`|| true` 或改松 CI 权限时直接以退出码 `4` 阻断，必须 `--human-approved` 方可放行；`govern-audit.mjs` 亦解析 `.github/workflows/*.{yml,yaml}` 比对孤儿测试套。

## 事实来源

GitHub Actions 内置 Runner 版本、官方 Action 主版本号、Fine-grained PAT 权限范围及 OIDC 信任配置要求随平台演进，落盘前与遇到 `403`/`422` 报错时直接查阅 GitHub 官方 Docs（Actions / Repositories / Releases 对应小节）核准最新规范，不把易变平台限制写死为静态快照。
