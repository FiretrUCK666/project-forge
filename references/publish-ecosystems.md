# 各生态发布硬判据

## 何时读本文件

`references/publish.md` 判定「该不该发、发到哪、发什么号」之后，要真正动手发时读。
这里只有会在发布时**拦住你或悄悄发错东西**的硬判据，没有概念解释。遇到本文件没覆盖的生态，
回 `publish.md` 的「七、失败与中断」及「六、怎么安全地发」现场核查。

## Node / npm

1. **`@scope/pkg` 默认私有。** 公开包必须显式写 `"publishConfig": { "access": "public" }`。
2. **`files` 白名单优先于 `.npmignore`**，两者同时存在时只认 `files`，且对从 Git 直装同样生效。
3. **依赖边界**：运行时用的进 `dependencies`；构建与测试用的进 `devDependencies`；**由宿主或使用方提供的进 `peerDependencies`**。
4. **OIDC / Trusted Publishing 接线**：在 npm 包 Settings -> Publishing access 绑定当前 GitHub 仓库 `<owner>/<repo>`、工作流文件名（如 `release.yml`）与可选 `environment`；工作流 job 声明 `permissions: id-token: write` 并使用 Node 22+（内置足够新版 npm 支持 `--provenance`）；**发布 job 必须关闭依赖缓存**，且 `package.json` 的 `repository` URL 大小写必须与仓库逐字一致。若尚在登记有效期内且未发过真版本，可先发占位版本或按新版 npm Trusted Publisher 登记核对报错。
5. **预演 `npm pack --dry-run`，再做一次隔离安装验证**：把打出来的包装进空目录跑一遍入口；**禁用 `npm link` 或本地路径依赖代替**。
6. **坏版本优先 `npm deprecate`**；撤销发布窗口窄且永久烧号。
7. **`bin` 指向的文件必须存在且带 shebang**；**主入口要在 `exports` 里显式声明**。

## Python / PyPI

1. **`pyproject.toml` 三张表分工**：`[build-system]`、`[project]`、`[project.optional-dependencies]`。缺 `[build-system]` 时构建器只能靠猜。
2. **`license` 写 SPDX 字符串**（如 `MIT`）配 `license-files`。
3. **`readme` 必填**且指向真实文件。
4. **`requires-python` 是唯一真正约束安装的下限**；分类标签只作展示。
5. **禁用 `dynamic = ["name"]`**；`version` 在 `dynamic` 里时按后端实际取值与标签对齐。
6. **预演 `python -m build && twine check dist/*`**，轮子与 `sdist` 源码分发包都要核对文件清单。
7. **TestPyPI 与正式 PyPI 完全独立**；Pending Publisher 支持首版直接走 OIDC，但要求**构建 job（无特权）与发布 job（仅含 `id-token: write` 与 `environment: pypi`）分离**，通过上传/下载 artifact 传递 `dist/*`；PyPI 侧填写的 `Owner`、`Repository name`、`Workflow name`、`Environment name` 四项必须与工作流逐字一致。
8. **禁用本地版本号**（`1.0.0+local`）；同名文件一旦上传永久烧号；正式源禁用跳过已存在参数；内部包名注意防依赖混淆劫持。

## Rust / crates.io

1. **`Cargo.toml` 必填项**：`[package]` 下的 `name`、`version`（必须写足三段 `0.1.0`）、`edition`、`description`、`license`（或 `license-file`）、`repository`。
2. **三个硬上限**：`keywords` 最多 5 个、`categories` 最多 5 个且须命中官方 slug、单 crate 包体积上限 10MB。
3. **工作区内部 crate 写 `publish = false`** 防误发；`include` 会完全覆盖 `exclude` 与 `.gitignore`；本地路径依赖发包时必须附带 `version`（`[patch]` 段不随包发布）。
4. **双步预演**：`cargo package --list` + `cargo publish --dry-run`；正式发布禁用 `--no-verify` 与 `--allow-dirty`；工作区多包按依赖从底向上逐包 `cargo publish -p <name>`。
5. **OIDC 硬前提**：crates.io 可信发布要求该 crate 已存在至少一个已发布版本（首版先用令牌发布，或按 crates.io 最新 Trusted Publishing 策略在 Crate Settings 登记仓库/工作流/环境并在工作流配 `id-token: write`）；包名在索引里不区分大小写与连字符；修正坏版先发兼容新版再 `cargo yank`。

## Go Modules

1. **没有上传动作**：`go mod tidy` → `go test ./...` → **推标签** → 等模块代理收录。
2. **标签形状三条铁律**：单模块 `vX.Y.Z`；子目录模块 `subdir/vX.Y.Z`；**v2 及以上大版本必须在 `go.mod` module 路径与全部 import 路径末尾同步加 `/v2`**。
3. **`go` 指令是强制编译下限**（Go 1.21+）；`replace` 与 `go.work` 仅本地生效；`go.sum` 只许经命令改；私有模块配 `GOPRIVATE`。
4. **已发布标签绝不可挪动**；撤回在 `go.mod` 写 `retract vX.Y.Z` 并**再发更高正式版本**；确认收录以 `go mod download <module>@<version>` 拉取成功为准。

## Java / Maven & Gradle

1. **唯一版本号来源**：Maven 读根 `pom.xml` `<version>`（多模块聚合同步各子模块），Gradle 读 `gradle.properties` 或 `build.gradle(.kts)` `version`（剔除 `-SNAPSHOT` 后与标签对齐）。
2. **发布认证**：Maven Central Portal / Gradle Plugin Portal 需配置签名私钥（GPG 密钥存入仓库 Secrets，绝不入库）与门户令牌（或对应 OIDC 通道），并在发布前用 `./mvnw verify` / `./gradlew check` 完成打包与签名校验。

## 事实来源

本文件涉及的外部事实（各制品库 OIDC 界面字段、Supported Runners 与 Action 版本）会随平台演进，动手前查官方文档，本文件写的是判定流程而不是字段快照。
