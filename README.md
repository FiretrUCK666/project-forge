# project-forge

[English](README.en.md) | 中文

[![stars](https://img.shields.io/github/stars/FiretrUCK666/project-forge)](https://github.com/FiretrUCK666/project-forge)
[![license](https://img.shields.io/github/license/FiretrUCK666/project-forge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A516-339933)](README.md#环境要求)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](README.md#环境要求)

把一个项目目录锻造成规范项目：版本管理、远端仓库、文档套装、发布通道，一次配到位。

给它一个目录，它先只读勘察，看清这个项目现在是什么状态，再自己判断该做哪几件事、
跳过哪几件事。它不预设技术栈——Node、Python、Rust、Go、Java、纯文档目录，以及插件类
项目与 skill 项目，判断依据都是勘察出来的事实。

## 目录

<!-- toc:start -->

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [更新](#更新)
- [使用](#使用)
- [它不会做的事](#它不会做的事)
- [里面有什么](#里面有什么)
- [脚本](#脚本)
- [设计原则](#设计原则)
- [环境要求](#环境要求)
- [这个仓库自己是怎么配的](#这个仓库自己是怎么配的)
- [遇到问题](#遇到问题)
- [贡献](#贡献)
- [许可](#许可)

<!-- toc:end -->

## 它解决什么问题

一个项目从「能跑」到「像个正经项目」，中间隔着一堆琐碎但容易出错的事：忽略规则写没写
对、产物该不该入库、提交署名配了没、README 里承诺的东西能不能兑现、发布流程会不会
把密钥发出去。这些事每一件都不难，但加起来很多，而且**做错的时候往往很久以后才发现**。

project-forge 把这些收敛成一条流程，并且把判断依据写下来——所以它不只知道「该做什么」，
还知道「为什么」和「什么时候不该做」。

## 安装

这是一个 skill，用的是通用的 `SKILL.md` 格式：一个入口文件，加上 `references/`、
`templates/`、`scripts/` 三个同级目录。frontmatter 里只用了 `name` 与 `description`
这两个各家共通的字段，脚本是纯 Node、不调用任何宿主接口。

把整个目录放进**你所用宿主的用户级 skill 根**：

- **已经装过别的 skill** → 放到它们所在的目录。这是最可靠的判断，不用记路径。
- **一个都没有** → 查该宿主的文档，位置写在它的文档里。

```sh
git clone https://github.com/FiretrUCK666/project-forge.git "<你的 skill 根>/project-forge"
```

目录名保持 `project-forge`——它必须与 frontmatter 里的 `name` 一致。**注意路径的大小写**：
区分大小写的系统上，大小写不同就是另一个目录。

放好之后不需要注册或重启：宿主按目录发现，`SKILL.md` 就是入口。

## 更新

这个 skill 靠克隆分发，**不在任何包管理器里**，所以更新就是拉取最新代码：

```sh
cd <你放 skill 的目录>/project-forge
git pull
```

**怎么知道有新版**：看仓库的 [Releases](https://github.com/FiretrUCK666/project-forge/releases)。
日常改动只提交推送不打标签；攒到发版里程碑（明确说发版）才打标签，发布说明由自动流程生成。提交历史更详细，但那是给维护者看的。

**升级安全吗**：`SKILL.md`、`references/`、`templates/`、`scripts/` 都是纯文本与
零依赖脚本，没有需要重新编译或迁移的东西，直接 `git pull` 即可。若你按
[CONTRIBUTING.md](CONTRIBUTING.md) 里的「开发环境」与「提交前门禁」改过它，拉取前先提交
自己的改动，避免冲突。

## 使用

直接用自然语言描述你的需求即可，触发词包括：

- 版本管理类：弄版本管理、配 git、上仓库、建仓库、推到 GitHub、项目起步
- 文档类：写 AGENTS.md、写 README、配 LICENSE、写贡献指南
- 发布类：发到 npm、发布、配 CI
- 笼统类：标准化项目、规范项目、整理项目

例如：

```
帮我规范这个项目
给 D:\work\my-tool 配上版本管理和文档
这个项目要不要发到 npm
```

它不会一上来就动手。第一步永远是勘察，然后告诉你：这个项目现在是什么状态、准备做哪
几件事、以及**为什么跳过另外几件**。

## 它不会做的事

- 不改动你的代码逻辑，只做版本管理、远端、文档、发布这几件事；
- 不替你决定许可证，只给判据和选项；
- 不擅自把仓库设为公开（默认私有，公开需要你明确点头）；
- 不强制推送、不改写已推送的历史、不删除已发布的版本；
- 不做部署和服务器配置。

## 里面有什么

| 路径 | 内容 |
| --- | --- |
| `SKILL.md` | 入口：硬不变量、能力矩阵、执行流程、硬门控 |
| `references/survey.md` | 勘察协议：读什么、字段什么含义、事实怎么翻译成动作 |
| `references/version-control.md` | 版本管理全线：产物该不该入库的判据、忽略规则、署名、提交纪律、回滚分档、密钥门控 |
| `references/remote-github.md` | 远端仓库：通道发现、建仓、推送、元数据、版本节点与发布说明、协作模板、CI |
| `references/docs-set.md` | 文档套装：各文档的读者是谁、职责、写法与同步纪律 |
| `references/publish.md` | 发布总纲：能不能发、发到哪、版本号语义、什么时候该抬版本号 |
| `references/publish-npm.md` | npm 专章：基础操作、各种既有状态怎么接、适用范围与常见误解 |
| `references/publish-python.md` | Python 专章：清单三表、构建与预演、测试源、可信发布、版本与修正 |
| `references/publish-go.md` | Go 专章：标签形状、无上传模型、收录确认、撤回、私有模块 |
| `references/publish-rust.md` | Rust 专章：清单字段、发布范围、预演、认证、修正 |
| `references/plugin-project.md` | 插件类项目：共同性质、判定协议、没有专章时的处理与生长规则 |
| `references/plugins/` | 各生态的插件专章（一个生态一个文件） |
| `templates/` | 可直接起步的文档骨架，以及几份短许可证的标准全文 |
| `scripts/survey.mjs` | 只读勘察，输出结构化事实 |
| `scripts/compose-agents.mjs` | 生成、刷新或升级 `AGENTS.md`：按项目事实填充、按事实取舍条件段落、报出还需人工补写的节 |
| `scripts/preflight.mjs` | 自检：引用完整性、内核一致性、硬性规范、脚本能否跑起来 |
| `scripts/selftest.mjs` | 行为自检：造 fixture 实跑，断言每条判定结果 |
| `scripts/release-notes.mjs` | 用 UTF-8 文件写发布说明（中文不经 shell，写完回读比对） |
| `scripts/draft-release-notes.mjs` | 从提交记录起草中文发布说明（平台的自动生成只会给英文模板） |
| `scripts/check-badges.mjs` | 检查 README 里的徽章是否真的能显示（私有仓库上的 GitHub 徽章显示不出来） |
| `scripts/sync-toc.mjs` | 让 Markdown 的目录与标题保持同步（从标题生成，锚点按 GitHub 的算法算） |
| `scripts/review.mjs` | P4/P5 交付门禁：没有缺项、待定事项用选项消掉才算写完 |

## 脚本

全部脚本只用运行环境内置的模块，**零依赖**，跨平台。

```sh
# 勘察一个项目（只读，不写任何文件）
node <本领目录>/scripts/survey.mjs <项目目录> --markdown

# 生成、刷新或升级项目的 AGENTS.md
node <本领目录>/scripts/compose-agents.mjs <项目目录>
node <本领目录>/scripts/compose-agents.mjs <项目目录> --check     # 只校验，不一致时退出码 1
node <本领目录>/scripts/compose-agents.mjs <项目目录> --status    # 只看现状，不写入
node <本领目录>/scripts/compose-agents.mjs <项目目录> --upgrade   # 把手写的升级为标准结构

# 自检这个 skill 自身
node <本领目录>/scripts/preflight.mjs
node <本领目录>/scripts/selftest.mjs
```

`<本领目录>` 是这个 skill 所在的位置，`<项目目录>` 是你想处理的那个项目——两者通常
不是同一个目录。路径都是显式传入的，所以在哪个工作目录下执行都可以。

`survey.mjs` 只负责回答「读到了什么」，不负责「所以该怎么办」——判据在 `references/`
里。这条分工是刻意的：事实不随项目类型变化，判据会。

## 设计原则

有几条原则贯穿整个 skill，它们也是判断「某个做法该不该加进来」的标准：

**只读先行。** 勘察没跑完，不写任何文件。同一套动作套到所有项目上一定会做错事——给纯
文档目录配发布流程是无用功，给已经配好远端的项目重建仓库是破坏。

**给判据，不给清单。** 清单会过期（文件增删、目录改名、工具换名），判据不会。凡是能
写成「怎么判断」的地方，就不写成「照抄这个」。

**写意图，不写快照。** 版本号、日期、一次性的决定都不写进文档——写进来就是下一个坑。
需要取值的地方写「从哪里取」。

**读的人不同，写法就不同。** 给 AI 看的文档（`AGENTS.md`）写机制与判据，需要具体值时
让它自己去读项目；给人看的文档（`README`、`CONTRIBUTING`）写具体、可直接复制的命令。
同一件事在这两类文档里本来就该长得不一样。

**幂等、不覆盖。** 任何一步重复执行结果相同；已存在的文件先读后合并，内容冲突时报告
并停下，不擅自取舍。

## 环境要求

### 运行时

**Node.js 16 或更高。** 这是全部要求——所有脚本只用 Node 内置模块（`node:fs`、
`node:path`、`node:url`、`node:os`、`node:child_process`），**没有任何第三方依赖**，
不需要先装任何东西。联网检查徽章与调用接口的脚本需要 Node 18 的全局 `fetch`，
16 下会明确报错而不是静默失败。

版本下限来自脚本用到的语言特性：ESM 的 `node:` 前缀导入、`String.prototype.replaceAll`、
`fs.rmSync`。三者中要求最高的是 `replaceAll`（Node 15 引入）；取 16 是因为它是覆盖全部
特性的第一个长期支持版本。

**实际验证过的版本**：Node 22（持续集成，每次推送都跑）与 Node 24（开发机）。
16 到 21 属于按特性推导的可用区间，**未逐版实测**；如果你在这些版本上遇到问题，
欢迎提 Issue 告知。

### git（可选，但强烈建议）

脚本本身不依赖 git：勘察照常工作（会如实报告「git 不可用」），文档相关的功能完全不受
影响。**行为自检里依赖 git 的分组会自动跳过并说明**，不会报成失败。

需要 git 的是这些能力：版本管理的建立与维护、远端仓库、推送与发布。没有 git 时这几件
事做不了——勘察会明确告诉你，而不是假装成功。

### 网络

勘察与文档生成全程离线。只有远端仓库（建仓、推送、元数据）与发布相关步骤需要访问对应
的托管平台。

## 这个仓库自己是怎么配的

这个 skill 是自己的第一个用户：它的版本管理、文档与持续集成，都是按它自己的标准配的。
`AGENTS.md` 里的通用内核来自 `templates/agents-kernel.md`，由脚本注入而非手抄——
`scripts/preflight.mjs` 会检查两者是否逐字一致，持续集成里也跑这一条。

换句话说，如果这个 skill 教的东西是错的，它自己的仓库会先出问题。

本文件是中文权威版，`README.en.md` 是它的英文译本；两者不一致时以本文件为准，并同步英文版。

## 遇到问题

到 [Issues](https://github.com/FiretrUCK666/project-forge/issues) 提出。为了能定位问题，
请附上：

- 你的操作系统与 Node 版本；
- 你运行的完整命令；
- 完整的报错文本（不是描述现象，是原文）；
- 如果问题与某个具体项目有关，那个项目的技术栈与大致目录结构。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
