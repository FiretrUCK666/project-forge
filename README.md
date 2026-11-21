<p align="center">
  <img src="assets/readme/hero.svg" alt="project-forge：先勘察再落盘的仓库工程治理技能，补齐版本管理、项目文档与八个本地研发技能，零第三方依赖，支持任意 Git 远端与纯本地" width="100%">
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="RELEASING.md"><img src="https://img.shields.io/badge/version-v6.0.0-4E7496?style=flat-square" alt="版本 v6.0.0"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/node-%3E%3D18-1F6F5B?style=flat-square" alt="Node.js 18 及以上"></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/dependencies-0-1F6F5B?style=flat-square" alt="零第三方依赖"></a>
  <a href="#支持哪些语言"><img src="https://img.shields.io/badge/languages-any-D96B27?style=flat-square" alt="适用于任何语言的仓库"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-526075?style=flat-square" alt="MIT 许可协议"></a>
</p>

一个空目录，或者一个维护了几个月的老仓库，真正消耗时间的地方往往不在业务代码：`.gitignore` 漏掉本地密钥、文档描述和源码对不上、分支合并前缺少实测记录、修改了一处却不知道还有哪几个文件需要同步调整。

**project-forge** 先只读盘点目录现状，再按项目体量补齐 Git 基线、三层常青文档、契约文件 `AGENTS.md`、按远端形态适配的检查流（支持 GitHub、通用 git 远端与纯本地仓库，非 GitHub 或无远端自动跳过 GitHub Actions）以及 8 个本地研发技能。它不覆盖我们手写的内容，不安装任何第三方依赖，Node.js 18 及以上就能运行。

## 它能做什么

| 能力 | 具体做法 |
| --- | --- |
| **保留手写内容** | 已有的 `README.md`、`CONTRIBUTING.md`、架构文档、自定义模板、CI 工作流和自有技能全部原样保留。写入任何文件前先在仓库外面创建一份 `.zip` 快照（兼容恢复 `.tar.gz`） |
| **双态规划与切片调度** | 支持 `interactive` 和 `autonomous` 两种规划模式，可在隔离工作树中起草规划并通过 `plan-sync` 同步状态。多切片任务使用单一三态切片依赖图校验覆盖率与重叠写域，并生成精简交接包 |
| **Worktree 隔离与实证** | 有提交历史的仓库统一进入 `.worktrees/` 隔离槽复用，谁修改代码谁认领并提交 PR。验证支持工具无关的 `--artifact` 附件校验，涉及界面文件时禁止仅凭 `--visual-checked` 放行 |
| **多远端自适应降级** | 统一 `TaskBackend` 适配 GitHub（支持多远端与 SSH 别名）、纯本地无远端（`local-only`）以及非 GitHub 远端（`generic-git`），在 `generic-git` 下不会越权在本地强行合并主干 |
| **先复现与有界迭代** | 在提交修补前先运行最小复现（`PoC-first`）排除误报，并通过 `iterate.mjs cycle` 执行带三条硬停损的有界优化循环。运行时只锁定客观输出边界，高频问题自动下沉为静态规则 |

## 目录

<!-- toc:start -->

- [它能做什么](#它能做什么)
- [外部项目治理与跨代升级](#外部项目治理与跨代升级)
- [八个日常技能与完整流程](#八个日常技能与完整流程)
- [有界优化循环与先复现原则](#有界优化循环与先复现原则)
- [三层常青文档与按需切片](#三层常青文档与按需切片)
- [支持哪些语言](#支持哪些语言)
- [安装](#安装)
- [自动更新](#自动更新)
- [日常安全边界](#日常安全边界)
- [脚本速查](#脚本速查)
- [许可协议](#许可协议)

<!-- toc:end -->

## 外部项目治理与跨代升级

<p align="center">
  <img src="assets/readme/workflow.svg" alt="S1 到 S4 治理流水线：只读勘察（survey.mjs）、确认范围并保留手写资产、写前仓外 .zip 快照与整包回滚、体检与交棒（review 与 handoff）" width="100%">
</p>

无论面对空白目录、半配好的存量仓库，还是已有旧版配置的跨代重入仓库，治理都按 **S1 只读勘察 → S2 定范围与融合 → S3 备份后按序落盘 → S4 体检与交棒** 四步推进：

| 步骤 | 做什么 | 关键点 |
| --- | --- | --- |
| **S1 只读勘察** | 盘点目录结构、语言生态、Git 远端拓扑、本机凭据、已有架构文档和自有技能 | 这一步不写入任何文件；空白目录先问 3 到 4 个问题再起步 |
| **S2 定范围融合** | 保留长青文档、脚本与既有 AI 约定，清理或归档过期内容，按协作态跳过不适用模板 | 许可证、仓库可见性与发版策略先请人拍板 |
| **S3 备份后落盘** | 非空仓库先创建仓外 `pre-forge` `.zip` 快照，再实跑既有测试作为基线后按序写入 | 写入顺序固定为 **版本库 → 文档 → 远端 → 自动化**，不能调换 |
| **S4 体检与交棒** | 运行交付体检与声明回查，将原仓遗留问题通过 `TaskBackend` 建单进入日常流程 | 清理引导标记前先列清单并确认，保留技能时保留 `.pf-manifest.json` |

第三步的顺序不能调换的原因很直接：`.gitattributes` 和 `.gitignore` 必须在第一次提交之前就位，文档和远端地址必须在推送之前就绪，CI 运行的命令必须和 `AGENTS.md`、`README.md` 里描述的完全一致。

在跨代升级已有工程时，`equip.mjs` 通过 `.agents/skills/.pf-manifest.json`（`v3` 账本）管理装配状态：

- **墓碑保护**：用户主动删除的技能或单文件会记入 `disabledSkills` 和 `removedFiles`，升级时绝不擅自恢复，只有显式传入 `--restore` 才会找回。
- **定制豁免与三方合并**：通过 `--adopt-custom` 登记的手改文件不会阻断 `--check`；本地和上游同时修改的非脚本文件由 `merge3.mjs` 自动无冲突合并，`.mjs` 文件遇冲突则保留本地版本且不留冲突标记。
- **校验失败秒级回滚**：升级后若 ESM 语法或导出接口校验不通过，`equip-integrity.mjs` 会从写前仓外 `.zip` 快照立刻整包回滚。

## 八个日常技能与完整流程

<p align="center">
  <img src="assets/readme/architecture.svg" alt="主干 main 与隔离工作树拓扑：.worktrees/impl 运行 explore、plan、edit、flow，经 .worktrees/review 由 dev-review 独立审查合入，外环由 dev-verify-tools、dev-iterate 与 dev-govern 支撑" width="100%">
</p>

日常研发统一装配全部 8 个内置技能，围绕 **需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入** 八个阶段运转。日常通过自然语言静默触发（也可直接粘贴 Issue、PR 或 Milestone 链接），由 `AGENTS.md` 自动路由到对应技能，需要时也可直接运行底层 CLI 脚本。

| 技能 | 自然语言示例 | 技能与 CLI 入口 | 职责与核心门禁 |
| --- | --- | --- | --- |
| `dev-explore` | 「梳理导出模块入口和验证命令」 | `repo-map.mjs`、`doc-locate.mjs` | 全程只读，零写入；按需返回行号切片，输出入口、可复用模块与功能地图 |
| `dev-plan` | 「澄清需求并按波次拆解方案」 | `doc-plan.mjs` | 五档分流（Case 1–5）、`interactive`/`autonomous` 双态规划、隔离与 `plan-sync`、三态切片图与换人 Critique |
| `dev-edit` | 「改代码前先核对禁区和静态门禁」 | `edit-gate.mjs` | 改前查禁改区与复用；改后剥离注释和字面量拦截压制标记、墓碑、死代码、`arch-rules`、单测反作弊与 800 行上限 |
| `dev-flow` | 「按方案建隔离工作树并提交 PR」 | `flow.mjs` | `.worktrees/` 槽复用、`next` 与 `batch plan --handoff` 精简交接包、谁修改谁提交、`1:N` 归档、`--artifact` 与 7 步清理 |
| `dev-verify-tools` | 「核对或补充功能地图里的验证工具」 | `verify-tools.mjs` | 维护唯一机读 `docs/feature-map.json`，仓外 `scratch/` 试制探针，按符号与树哈希免日期判旧 |
| `dev-review` | 「从独立视角审查这个 PR」 | `review-pack.mjs` | 外部 PR 先过 `--untrusted-scan`；强制先过实证（`--artifact`/故障注入）再解锁 `--include-diff`；Round 2+ 换人与六锁收敛 |
| `dev-iterate` | 「压测盲区并运行有界优化循环」 | `iterate.mjs` | 结合地图与热点生成原生测试（过 `edit-gate`）、并发运行、`PoC-first` 建单，并提供 `cycle` 有界循环 |
| `dev-govern` | 「做一次静态审计或复盘规则下沉」 | `govern-audit.mjs` | 只读静态审计、常青文档与工作树巡检（`reconcile`）、信号聚类、`sample` 抽检与 `retro` 复盘（复发满 2 次下沉门禁） |

**哪些步骤可以按档位跳过：**

- **Case 1（错别字或单行格式）**：跳过探索与规划文档，直接修改并运行对应校验。
- **Case 2（明确局部缺陷且不改外部契约）**：不新建规划文档，先编写可复现失败的测试再修复通过（Red-Green）。
- **高风险、单向门或 Case 4 改动**：必须经独立上下文审查并补充故障注入验证，自己审查自己不能算数。

## 有界优化循环与先复现原则

<p align="center">
  <img src="assets/readme/skills-cycle.svg" alt="八个内置技能协作闭环：dev-explore 到 dev-review 主链含最多 3 轮独立内审 Critique 与代码审查返工，外环衔接 dev-govern、dev-iterate 与 dev-verify-tools 并支持缺陷回流建单" width="100%">
</p>

发现疑点或测试盲区时，`dev-iterate`、`dev-review` 和 `dev-govern` 共用一条核心原则：**先跑通最小运行复现（`PoC-first`），确认问题真实存在后再进入修复流程**。

1. **Observe（发现盲区）**：对比 `docs/feature-map.json`、`signals.jsonl` 与近期变更排出待验证热点，只读不改源码。
2. **PoC-first（最小运行复现）**：先执行一条最小可复现命令；复现不出来的静态疑点直接判定为误报，不编写补丁、不建空单。
3. **Escalate & Fix（正流修复与实证）**：通过 `escalation.mjs` 附带 `pocCommand` 与 `reproEvidence` 建单，转入 `dev-plan → dev-edit → dev-flow → dev-review` 修复，附带 `--artifact` 实证附件复跑同一条 PoC 验证变绿。
4. **Reflect（整类加固）**：评估单点缺陷是否来自同类模式缺失——优先通过架构与共享边界原语重构做 Tier 1 治本收口，能用确定性静态规则或类型拦下的做 Tier 2 门禁加固。所有门禁只锁定客观输出边界（产物、接口格式、退出码与正反断言），不锁定私有实现步骤。

`iterate.mjs cycle` 采用只读四阶段编排，一旦触及以下任一条件立即以退出码 `4` 停机并交由人类裁决：

- **`ROUND_LIMIT_REACHED`**：达到轮次上限（默认 `3` 轮，硬上限 `10` 轮）。
- **`NO_PROGRESS_STALL`**：连续 `2` 轮没有新的实证进展。
- **`ONE_WAY_GATE_HIT`**：遇到单向门或高风险变更待批准。

## 三层常青文档与按需切片

<p align="center">
  <img src="assets/readme/docs-layers.svg" alt="三层常青文档（AGENTS.md 路由表与硬约束、docs/TDD.md 架构按节跳读、docs/feature-map.json 模块与验证工具映射）与四层规划归档流转" width="100%">
</p>

项目文档分为**三层常青文档**和**四层规划单据**。平时由 `dev-explore` 的 `doc-locate.mjs` 按章节或符号返回 `startLine..endLine` 切片，避免把整篇长文档塞进会话上下文：

| 层级 | 文件载体 | 定位与保鲜方式 |
| --- | --- | --- |
| **L1 入口契约** | `AGENTS.md` | 每次会话自动读取的薄契约：意图路由、行事总纲、`Dev Profile`、协作流转、高风险路径与 `改哪看哪`（建议 `< 24KB`，上限 `30KB`） |
| **L2 系统架构** | `docs/TDD.md` | 记录真实模块边界、核心流程、Mermaid `16/12` 图表与核心不变量；`tdd-structure.mjs` 与 `tdd-parity.mjs` 校验结构与路径同步 |
| **L3 机读索引** | `docs/feature-map.json` | 唯一机读功能、模块、业务流与验证工具映射；由 `verify-tools.mjs` 用导出符号指纹与 Git 树哈希免手工日期判旧 |
| **四层规划与归档** | `docs/{prd,specs,todo}/` → `docs/archive/` | `doc-plan.mjs` 生成时自动清洗脚手架占位并兼容仓库自有模板；`flow finalize` 校验 `C*` 全勾 `[x]` 与 `1:N` 总控 PRD 收口后成对 `git mv` 归档 |

## 支持哪些语言

**任何语言都能使用。** 语言只决定工具能否按包清单自动推断命令，不影响整条工程流程。

| 情况 | 处理方式 |
| --- | --- |
| **清单精准识别（12 种）** | `Node.js`、`Python`、`Rust`、`Go`、`Java`、`Ruby`、`PHP`、`.NET`、`C/C++`、`Dart`、`Swift`、`Elixir`，直接识别惯用构建与测试命令 |
| **清单外的其他语言** | Haskell、OCaml、Zig、Nim、Crystal、Julia 或自研 DSL：直接从项目里**已经在运行的命令**读取——CI 的 `run:` 块、`Makefile`、`justfile`、`Taskfile` |
| **从空白目录起步** | `equip.mjs --bootstrap-empty` 对任意技术栈生成通用基线（Git 基线、三层文档、`docs/TDD.md`、自洽 `AGENTS.md` 与 8 套技能），零玩具业务源码；支持 `14` 种预设栈（上述 `12` 种语言加 `universal` 与 `docs`，默认 `universal`），并与已有 `README.md`、`LICENSE` 共存 |

同时支持纯文档目录、编辑器扩展、Obsidian 插件和能力目录。如果项目里既没有包清单也没有 CI 或任务文件，勘察会明确说明未探测到命令，并给出查找路径，而不会按语言习惯编造命令。

## 安装

**环境要求**：`Windows`、`macOS` 或 `Linux`，安装 `Node.js 18`（`>= 18`）及以上。全部脚本只使用 Node 内置模块，不需要执行 `npm install`。

| 方式 | 操作方法 | 更新机制 | 适合人群 |
| --- | --- | --- | --- |
| **下载压缩包** | [下载 project-forge.zip（最新版）](https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip) | 自动更新 | 日常使用者 |
| **`git clone`** | `git clone https://github.com/FiretrUCK666/project-forge.git` | 只提示不覆盖，手动 `git pull` | 修改工具本身的人 |

两种方式都要**保持文件夹名称为 `project-forge`**。如果加上分支或版本号后缀（例如 `project-forge-main`），宿主会因目录名与技能名不一致而跳过加载。

安装完成后，打开需要整理的项目目录，直接这样说：

```text
请先帮我勘察当前目录现状，列出缺失的配置和整理方案。
```

## 自动更新

只有**压缩包副本**会自动检查并更新，通过 `git clone` 获取的副本不会自动覆盖。

| 问题 | 说明 |
| --- | --- |
| **检查频率** | 距上次成功核对满 **1 小时**再查；核对失败后 **15 分钟**内不重试（离线不阻塞）；更新完成后 **24 小时**内不重复检查 |
| **原子替换机制** | 下载到同盘临时目录解包 → 全量校验 → 先写辅助文件 → 最后原子写入 `SKILL.md`。中途断电或失败会立刻回滚，不留半更新副本 |
| **关闭或换源** | 设置环境变量 `PF_NO_UPDATE=1` 关闭检查；设置 `PF_UPDATE_SOURCE` 指向镜像地址 |

```sh
# 立刻检查一次，只报告结果不修改文件
node "<技能目录>/scripts/update.mjs" --check

# 关闭自动更新检查
PF_NO_UPDATE=1

# 指向镜像更新源
PF_UPDATE_SOURCE="https://github.com/<owner>/project-forge"
```

## 日常安全边界

日常操作按**能不能撤回**分成两档：

| 档位 | 包含操作 | 是否需要人确认 |
| --- | --- | --- |
| **能撤回** | 本地提交、推自己的分支、开 PR、修改 PR、运行检查 | 不需要，随时可撤销重来 |
| **撤不回来** | 合并进默认分支、打版本标签、正式发版、修改仓库可见性、改写已推送历史 | 需要先列清单并由人批准 |

另有两条底线规则：

- **弱化门禁必须人点头**：删除测试、放宽断言、添加跳过标记或调松 CI 检查，会让门禁从此少查一项，必须经过人类确认。
- **永不自动强推**：任何情况下都不会自动执行 `git push --force` 或改写已推送历史。

独立审查全部通过且没有未决问题时，**审查通过就由审查者合入**——审查者是把关人，不只是提建议的顾问。

## 脚本速查

日常使用时由 `AGENTS.md` 自动路由，不需要手工记忆这些命令。需要排查问题或接入 CI 时可以参考下方清单。

<details>
<summary>查看底层脚本与职责</summary>

| 脚本 | 用途 |
| --- | --- |
| `node scripts/survey.mjs <目录>` | 只读盘点结构、文档、远端拓扑与鉴权状态 |
| `node scripts/backup.mjs create <目录>` | 在仓库外部创建增量 `.zip` 快照（支持 `list` / `restore`） |
| `node scripts/equip.mjs <目录>` | 统一装配或无损刷新 `.agents/skills/`（支持 `--check`、`--adopt-custom`、`--restore`、`--bootstrap-empty`） |
| `node scripts/compose-agents.mjs <目录>` | 生成或无损刷新 `AGENTS.md`（建议 `< 24KB`，上限 `<= 30KB`） |
| `node scripts/equip-ci.mjs <目录>` | 按勘察事实生成 CI 工作流或配置分支保护 |
| `node scripts/review.mjs <目录>` | 交付体检：规范齐备度与声明真实性回查 |
| `node scripts/handoff.mjs <目录>` | 扫描引导标记与临时残留，辅助交棒清理 |
| `node scripts/sync-toc.mjs README.md README.en.md` | 同步双语 README 的目录锚点 |
| `node scripts/update.mjs [--check]` | 检查并原子更新压缩包副本 |

</details>

## 许可协议

本项目采用 [MIT](LICENSE) 许可协议。欢迎阅读 [贡献指南](CONTRIBUTING.md) 与 [发版说明](RELEASING.md)。
