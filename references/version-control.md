# 版本控制与提交前门禁

## 何时读本文件

目标项目还没有 `.git`、缺 `.gitignore` 或 `.gitattributes`、Git 署名是系统占位值、扫描出凭据或大文件风险、或者要建/删 Worktree 之前，读完本文件再动手。

## 执行顺序（顺序本身就是正确性）

严格按以下次序执行，颠倒任何两步都会把脏产物、换行错误或密钥钉进首次提交：

1. 核对 `isRepoRoot`、`commitsState` 与进行中冲突态（存在 `.git` 文件指针属于正常 Worktree，**禁止重跑 `git init`**；检测到 `MERGE_HEAD`、`REBASE_HEAD`、`CHERRY_PICK_HEAD` 时先中止操作并提示解冲突）；
2. 生成并核对 `.gitattributes`（文本换行与二进制标记）与 `.gitignore`（构建输出、缓存、`.worktrees/`、Apple/系统杂项、本机凭据）；
3. 核对提交署名（拦截系统占位名与默认本机邮箱）；
4. 执行凭据与大文件扫描（拦截未脱敏密钥与超限二进制）；
5. 仅在全部通过后 `git add` 并提交；建立或移除 Worktree 时遵守分包依赖隔离与解绑次序。

## 判据：什么该进版本库

| 应当入库 | 禁止入库 |
| --- | --- |
| 源码、测试、清单与依赖锁文件 | 构建产物目录（`dist/`、`build/`、`target/`、`*.pyc`）与依赖缓存（`node_modules/`、`.venv/`） |
| `AGENTS.md`、`README*`、`CONTRIBUTING.md`、`docs/` 四层文档 | 本地运行目录与任务状态账本（`.worktrees/`、`.worktrees/.state/`） |
| `.agents/skills/`（用户项目运行期研发技能与 `.pf-manifest.json`） | `.env*`、私钥（`*.pem`/`*.key`）、凭据令牌与本机用户绝对路径 |

注：本工具源码中的 `kit/` 随分发包带给使用者，而使用该项目自身装配的 `.agents/skills/` 与 `docs/` 不应混入他人项目导出包时按对应打包忽略规则隔离。写前备份快照由 `scripts/backup.mjs` 存入 `<gitCommonDir>/project-forge-backups/`、`PF_BACKUP_DIR` 或 `~/.project-forge/backups/`，零污染工作区 `git status`。

## 忽略规则

- **必须兜底包含**：`.worktrees/`、`.env`、`.env.*`（不含明确样本文件 `.env.example`）、`*.pem`、`*.key`、常见操作系统与 Apple 元数据（`._*`、`.DS_Store`、`__MACOSX/`、`.Spotlight-V100`、`.Trashes`、`.fseventsd`、`Thumbs.db`、`desktop.ini`）以及临时产物（`*.tmp-*`）。
- **按真实技术栈追加**：Node（`node_modules/`、`dist/`、`coverage/`）、Python（`__pycache__/`、`.venv/`、`*.egg-info/`）、Go（`bin/`、`coverage.out`）、Rust（`target/`）、Java（`out/`、`target/`、`build/`、`*.class`、`.gradle/`）。
- 若某个本应忽略的文件已被早期提交跟踪，`git add` 前必须先执行 `git rm --cached <路径>` 撤出跟踪后再更新 `.gitignore`。

## 文本属性

首次提交前必须落盘 `.gitattributes`，否则跨平台协作时二进制文件可能被自动换行破坏或产生海量无意义换行 diff：

- 通用基线：`* text=auto eol=lf`；显式声明代码与脚本（如 `*.mjs`、`*.js`、`*.ts`、`*.py`、`*.sh`、`*.yml`、`*.json`、`*.md` `text eol=lf`），批处理脚本按平台要求设 `eol=crlf`。
- 二进制强制锁定：`*.png`、`*.jpg`、`*.webp`、`*.gif`、`*.ico`、`*.woff2`、`*.pdf`、`*.tar`、`*.gz`、`*.zip`、`*.wasm` 一律标注 `binary`（`-text -diff`）。
- macOS / 跨平台路径编码：脚本内置 `core.precomposeunicode=true`、`-z` NUL 分隔、`canonicalPath` 与 Unicode `NFC` 归一，防止 APFS NFD 文件名或含空格/中文路径在 Git 状态与 diff 中误判。

## 提交署名

- 禁止使用系统默认占位值（如 `Administrator`、`root`、`user`、`admin@localhost`、`noreply@localhost` 或空署名）提交。
- 缺失或为占位值时，写入**仓库局部**配置（`git config user.name` / `git config user.email`），不擅自覆写用户的 `--global` 配置。

## 凭据门控

1. **防弹窗挂起**：运行任何探测或 Git 命令统一注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`SSH_ASKPASS_REQUIRE=never` 与 `GH_PROMPT_DISABLED=1`。
2. **未推送 vs 已推送完全相反**：
   - **仅在本地、尚未推上远端**：可用反向修正或交互重置把密钥彻底从本地提交历史中剥除；
   - **已经推送到公开或共享远端**：仅改后续提交毫无意义，历史仍然泄露；**必须优先通知维护者立即吊销并轮换凭据**，再决定是否做历史重写，严禁自动对已推分支强推。
3. 严禁把 PAT / OAuth 令牌写进 `.git/config` 远端 URL；令牌只在内存中通过凭据助手或环境变量读取。

## 大文件

- 单文件达到或接近 GitHub 限制（50MB 起强提醒、100MB 远端硬拒）时，立即中断提交；确认属构建物则移出库并加入 `.gitignore`，确属大型静态资产须交由人决策是否独立发布附件或使用大文件存储，不私自静默拆包或截断。

## Worktree 共享依赖与防删穿规则

- **按子包独立比对与防毒化隔离**：`dev-flow` 内的 `worktree-deps.mjs` 按子包根目录独立比对锁定文件（`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`poetry.lock`、`uv.lock`、`Cargo.lock`、`go.sum`、`requirements*.txt`、`Pipfile.lock`、`gradle.lockfile` 等）SHA256；当检测到 Monorepo Workspace 本地包软链或 Python 可编辑安装（`.venv` 内 `.pth`/路径指向主仓）时，自动拒绝共享并切换为局部隔离兼给出原因说明，绝不让 worktree 静默跑主仓旧代码。
- **四态归属核验与清理顺序红线**：清理前通过 `git cherry` 与 `git patch-id` 区分 `merged`（正常可清理）、`squash_or_rebase_merged`（压缩/变基合入）、`no_own_commits`（无独立提交，先问人再清防误删）与 `unmerged`（仍阻断）；挂载与卸载前均校验 `samePath(mainAbs, wtAbs)` 防护，拆卸任何 worktree 之前，**必须先对挂载的 junction/symlink 本身执行 `unlinkSync` 解绑**，校验主仓依赖目录完好并请人确认后再执行 `git worktree remove`，严禁未解绑就直接递归强删 `.worktrees/*`。
