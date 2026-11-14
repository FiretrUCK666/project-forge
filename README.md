<p align="center">
  <img src="assets/readme/hero.svg" alt="project-forge：从零散目录到规范 GitHub 仓库的流程示意" width="100%">
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="RELEASING.md"><img src="https://img.shields.io/badge/version-v6.0.0-4E7496?style=flat-square" alt="版本 v6.0.0"></a>
  <a href="#安装与上手"><img src="https://img.shields.io/badge/node-%3E%3D18-1F6F5B?style=flat-square" alt="Node.js 18 及以上"></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/dependencies-0-1F6F5B?style=flat-square" alt="零第三方依赖"></a>
  <a href="#配齐后的-5-个日常技能怎么用"><img src="https://img.shields.io/badge/kit-5%20skills-D96B27?style=flat-square" alt="内置 5 个日常研发技能"></a>
  <a href="#它怎么把项目理顺"><img src="https://img.shields.io/badge/platform-GitHub-172033?style=flat-square" alt="面向 GitHub 协作工作流"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-526075?style=flat-square" alt="MIT 许可协议"></a>
</p>

启动一个新项目，或者接手一个已经维护了几个月的老仓库，真正消耗精力的往往是周边的工程杂事：`.gitignore` 漏掉本地密钥、文档描述与最新代码脱节、分支合入前没有实测记录、修改牵连邻近模块却无人提醒。

**project-forge** 先只读盘点目录现状，再在不覆盖手写内容的前提下，按项目体量选择 `lightweight` 或 `full` 两档配置，补齐 Git 基线、四层设计文档、契约文件 `AGENTS.md`、GitHub 检查流以及局部研发技能，让后续改动有据可依。整个工具只使用 `Node.js 18` 及以上内置模块，不安装任何第三方依赖，可在 `Windows`、`macOS` 与 `Linux` 直接运行。

## 它拦住的 5 类常见失误

- **老项目接入不覆盖手写文档**：仓库里原有的手写 `README.md`、`CONTRIBUTING.md`、架构文档、CI 工作流或自定义技能都会原样保留；修改任何文件前，先在仓库外部目录保存 `.tar.gz` 快照备份。
- **需求、规格与任务单成对跟着分支走**：`docs/prd/`、`docs/specs/` 与 `docs/todo/` 统一使用 YAML frontmatter 与 `YYMMDD-issue<N>-<slug>-{prd,spec,todo}.md` 命名，分支推进后随 `flow.mjs finalize` 一并归档到 `docs/archive/`。
- **按实测输出而不是口头判断合并**：每项改动合入默认分支前，都需要拿到静态门禁、真实命令运行结果以及独立审查记录；Mermaid 图表宽度和文档锚点也在提交前自动检查。
- **关联文件改动给出同步提醒**：`AGENTS.md` 里的联动对照表会把源码模块、模板与文档关联起来，修改一侧时直接提醒需要同步核对的文件。
- **两档渐进装配与局部删改豁免**：个人小仓库可以只装 `lightweight` 档（`< 14KB` 契约与 3 个核心流转技能），后续随时无损升级到 `full` 档；用户删除或手改过的托管技能会记录在 `.pf-manifest.json` 里，升级时不会强行写回。

## 目录

<!-- toc:start -->

- [它拦住的 5 类常见失误](#它拦住的-5-类常见失误)
- [它怎么把项目理顺](#它怎么把项目理顺)
- [配齐后的 5 个日常技能怎么用](#配齐后的-5-个日常技能怎么用)
- [安装与上手](#安装与上手)
- [日常安全边界](#日常安全边界)
- [脚本速查](#脚本速查)
- [许可协议](#许可协议)

<!-- toc:end -->

## 它怎么把项目理顺

<p align="center">
  <img src="assets/readme/workflow.svg" alt="project-forge 接入流程：三类起点收敛到四步理顺" width="100%">
</p>

无论是空白目录、配置了一半的个人项目，还是多人协作中的活跃仓库，**project-forge** 都按四步顺序推进：

1. **只读勘察**：盘点目录结构、生态清单、Git 远端拓扑、本机凭据可用性以及已有架构文档。面对空白目录，只需确认语言栈（支持 `node`、`python`、`go`、`rust`、`java` 与 `docs`）、包名、许可证与远端意向这 3 到 4 个问题。
2. **按事实确定装配范围**：已有手写文档与自定义技能一律保留，缺失项按 `artifactPlan` 规划；根据代码规模与协作信号推荐 `lightweight` 或 `full` 档，许可证、可见性与发版策略交由用户确认。
3. **备份后按顺序落盘**：非空仓库先在仓外创建写前快照，再按 **版本库 → 文档 → 远端 → 自动化** 的顺序生成：先配置 Git 基线与 `.agents/skills/`，再由 `dev-explore` 勘察模块边界并生成 `docs/TDD.md` 与 `AGENTS.md`，最后配置 GitHub 远端与检查/发版工作流（非注册托管远端自动降级为 `generic-git` 本地全流程）。
4. **体检与交棒**：运行交付体检并核对文档链接与契约一致性；如果需要交还给人工手动维护，先列出待清理的引导标记清单，确认后再清理。

## 配齐后的 5 个日常技能怎么用

<p align="center">
  <img src="assets/readme/architecture.svg" alt="5 个日常技能与合并前实证面板" width="100%">
</p>

装配完成后，`lightweight` 档提供 `dev-explore`、`dev-plan` 与 `dev-flow` 三个核心技能，`full` 档配备全部五个技能。日常不需要记忆命令行参数，通过自然语言即可由 `AGENTS.md` 自动路由到对应脚本：

| 你平时这样说 | 对应技能 | 它负责什么 |
| --- | --- | --- |
| 「先帮我理清这个模块的入口和边界」 | `dev-explore` | 只读扫描源码结构、多子包入口与验证命令，不修改工作区文件 |
| 「针对这个需求整理规格和任务拆解」 | `dev-plan` | 生成并核对 `docs/prd/`、`docs/specs/` 与 `docs/todo/`，校验标准与图表宽度 |
| 「接手这个 Issue，在分支上完成改动并提交 PR」 | `dev-flow` | 创建独立分支或 worktree，隔离挂载依赖，运行验证并同步提交与文档归档 |
| 「用独立视角检查这个 PR 有没有漏掉边界」 | `dev-review` | 启动独立上下文按冻结标准与实测结果逐条核查，支持故障注入验证 |
| 「排查一下过期文档、重复逻辑或慢测试」 | `dev-govern` | 基于基线做增量治理审计，检查文档漂移与弱测试，并采集跨版本发版清单 |

一次典型改动会按顺序经过四步：用 `dev-explore` 定位入口与测试命令；用 `dev-plan` 建立文档并冻结 `C1`、`C2` 验收标准；用 `dev-flow` 隔离改动、跑通验证并推送分支；用 `dev-review` 完成独立审查后合并并清理分支。其中**静态门禁优先级高于运行实证，运行实证优先级高于静态读代码，全部通过后再合并并收尾**。

## 安装与上手

- **运行环境**：`Windows`、`macOS` 或 `Linux`，需要 `Node.js 18` 及以上版本（`>= 18`）。
- **零外部依赖**：全部脚本仅调用 Node 内置模块（`node:*`），不需要执行 `npm install`。

**一键下载安装包（推荐）**：直接下载最新正式版压缩包 [project-forge.zip](https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip)（更多历史版本见 [Releases 页面](https://github.com/FiretrUCK666/project-forge/releases)），解压后**保持文件夹名为 `project-forge`**，整体放入你的宿主技能目录即可直接使用（不要附加版本号后缀，否则宿主会因名称不匹配而跳过加载）。

| 安装方式 | 更新机制 | 适用场景 |
| --- | --- | --- |
| **Release 压缩包**（`project-forge.zip`，无 `.git`） | 内置自动更新：检查 `1 小时`节流，替换 `24 小时`冷却，离线 `15 分钟`失败冷却 | 绝大多数日常使用者，即下即用 |
| **`git clone`**（源码副本，带 `.git`） | 脚本只读提示、不自动覆写文件，由维护者手动 `git pull` 更新 | 需要修改工具源码或参与贡献的开发者 |

压缩包副本每次进入流程前会静默执行 `node scripts/update.mjs --quiet`：联网核对采用 `1 小时`间隔节流，成功替换后有 `24 小时`冷却窗口，断网核对失败触发 `15 分钟`冷却后直接跳过，不阻塞离线使用；替换过程在同盘临时目录解包校验后先更新辅助文件、最后原子写入 `SKILL.md`，中途受中断会自动回滚。常用控制方式如下：

```sh
# 立即手动核对是否有新版本（不受 1 小时 / 24 小时节流限制，只报告不覆盖）
node "<技能目录>/scripts/update.mjs" --check

# 彻底关闭自动更新检查（环境变量非空即生效）
PF_NO_UPDATE=1

# 切换到自定义更新源或镜像地址
PF_UPDATE_SOURCE="https://github.com/<owner>/project-forge"
```

安装就绪后，打开需要整理的项目目录，直接发起请求即可：

```text
请先帮我勘察当前目录现状，
列出缺失的配置与安全整理方案。
```

如果是空白目录，只需确认语言栈、项目描述、许可证和是否创建远端等 3 到 4 个问题；如果是已有项目，原有手写文档、非标准架构目录与可用工作流都会得到保留，并按推荐档位装配（后续可随时通过 `--tier full` 无损补齐）。

## 日常安全边界

为了防止误操作破坏已推送历史或放宽门禁，日常分支流转与不可逆操作按以下边界严格分开：

- **按「能不能撤回」划分日常边界**：推自己的分支和开启或更新 PR 都可以随时撤回，因此属于日常动作；合并默认分支（若需绕过常规审查）、打版本标签、正式发版或更改仓库公开状态撤不回来，执行前必须先向人展示清单并获得明确批准。
- **正常合并与人工放行分离**：当独立上下文审查全部通过且无未决问题时，由审查者直接合并；只要改动涉及**弱化门禁**（例如删减测试用例、放宽断言、增加跳过标记或调低 CI 严格度），必须由人确认后才能放行。
- **不自动改写已推送历史，写入后必做回读**：任何情况下都不自动执行强推或重写已推送的提交历史；推送分支、创建 PR 或发布版本后，都会回读远端实际信息，确认标题、正文和标签完整就位。

## 脚本速查

正常使用由 `AGENTS.md` 自动路由，无需记忆命令；需要手动排查或集成 CI 时，可展开查看各入口脚本：

<details>
<summary>查看底层脚本与职责</summary>

| 脚本 | 主要用途 |
| --- | --- |
| `node scripts/survey.mjs <目录>` | 只读盘点仓库结构、文档、远端拓扑、认证状态与推荐档位 |
| `node scripts/backup.mjs create <目录>` | 在仓库外部创建增量压缩快照，写前保护并保留初始基线 |
| `node scripts/equip.mjs <目录> [--tier lightweight\|full]` | 装配或无损升档 `.agents/skills/`（支持 `--check`、`--adopt-custom` 与 `--restore`） |
| `node scripts/compose-agents.mjs <目录> [--tier lightweight\|full]` | 生成或无损刷新 `AGENTS.md`（`lightweight < 14KB`、`full <= 30KB`） |
| `node scripts/review.mjs <目录>` | 运行交付体检，检查规范齐备度与声明回查 |
| `node scripts/handoff.mjs <目录>` | 清理仓库内的引导标记与临时残留以便交棒 |
| `node scripts/sync-toc.mjs README.md README.en.md` | 同步双语 README 目录锚点 |
| `node scripts/update.mjs [--check]` | 检查并原子同步包副本工具更新 |

</details>

## 许可协议

本项目采用 [MIT](LICENSE) 许可协议。欢迎阅读 [贡献指南](CONTRIBUTING.md) 与 [发版说明](RELEASING.md)。
