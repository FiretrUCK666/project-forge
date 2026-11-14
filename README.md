<p align="center">
  <img src="assets/readme/hero.svg" alt="project-forge overview" width="100%">
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>简体中文</strong>
</p>

**project-forge** 是一个面向 GitHub 仓库的工程治理与 AI 协作底座（Zero-dependency Node 18+ Skill）。它坚持**只读勘察先行、写入前全量快照、存量无损融合、实证门禁验收**：无论是空目录冷启动、结构各异的存量仓库，还是隔了数月出现规则漂移的老项目，都能按同一条幂等流水线配齐版本管理、GitHub 远端与 CI、四层设计文档、受管契约 `AGENTS.md` 以及 5 个本地研发技能，把工程判断从人肉口述变成脚本可验证的闭环。

## 目录

<!-- toc:start -->

- [为什么需要 project-forge](#为什么需要-project-forge)
- [四步工作流](#四步工作流)
- [架构与本地研发技能](#架构与本地研发技能)
- [三类接入场景对照](#三类接入场景对照)
- [安装与快速上手](#安装与快速上手)
- [日常协作与可逆发版](#日常协作与可逆发版)
- [核心脚本速查](#核心脚本速查)
- [环境要求、边界与许可](#环境要求边界与许可)

<!-- toc:end -->

## 为什么需要 project-forge

工程治理最常见的问题不是"缺模板"，而是模板覆盖了项目原本有效的规则、脚本与文档各说各话、AI 每次新开会话都要重新摸索规矩。`project-forge` 围绕四个具体痛点设计：

- **空目录闭环起步**：针对 `node`、`python`、`go`、`rust`、`docs` 五种栈，`--bootstrap-empty` 一次性落盘 `.gitattributes`、`.gitignore`、`README.md`、可运行源码与测试以及结构化 `docs/TDD.md`，起手就有可跑的基准工程与测试。
- **存量异构仓库无损融合**：先用 `survey.mjs` 只读扫描 Git、文档、CI、协议与现有本地技能并输出 10 项 `artifactPlan`，已合规项直接保留，已有 `README.md`、`CONTRIBUTING.md`、`LICENSE` 或项目自有技能不覆盖重写，只在缺失或过期处增量补齐。
- **跨月漂移重入校准**：仓库演进几个月后随时可重跑 `survey`、`compose-agents --upgrade` 与 `review.mjs`，对齐模板升级、收口 `AGENTS.md` 受管区间、排查脚本与文档漂移，同时保留维护者手写的「取舍」段落。
- **去人肉代理的实证闭环**：任何断言都要经过可执行的静态门禁、临时目录冒烟与双门独立审查；信任遵循倒金字塔（静态门禁优先于运行冒烟实证，高于双门独立审查与契约文档），不以口头汇报代替运行输出。

## 四步工作流

<p align="center">
  <img src="assets/readme/workflow.svg" alt="project-forge 四步幂等工作流：空目录、存量融合与跨月重入三条路径汇入 S1 到 S4 流水线" width="100%">
</p>

三条入口最终都汇入同一条幂等流水线，第二遍执行产出与第一遍字节一致：

1. **S1 只读勘察**：执行 `survey.mjs --probe-auth` 只读判定仓库所处状态与 10 项 `artifactPlan`（保留 / 补齐 / 跳过 / 需决策），在勘察完成前不向目标项目写入任何文件。
2. **S2 逐项定界**：只对事实缺失或待定项向维护者确认边界（如开源协议、仓库可见性、协作模板与 CI 取舍），把决定落成可机读记录。
3. **S3 写前快照与按序落盘**：先由 `backup.mjs` 生成 `.tar.gz` 写前快照（支持按 ID 回滚），再严格按 **版本库 → 文档 → 远端 → 自动化** 顺序落盘，并由 `equip.mjs` 与 `compose-agents.mjs` 装配技能与受管 `AGENTS.md`。
4. **S4 实证体检与交棒**：运行 `review.mjs` 做全量交付体检（覆盖 10 个核对域），并用 `handoff.mjs` 核验与清理会话痕迹；可逆收尾动作在取得人确认后执行。

## 架构与本地研发技能

<p align="center">
  <img src="assets/readme/architecture.svg" alt="project-forge 双层架构：上层治理底座与下层 5 个本地研发技能及信任倒金字塔" width="100%">
</p>

治理底座负责把仓库规则、快照与四层设计文档（`docs/TDD.md` 架构契约、`docs/prd/` 产品目标、`docs/specs/` 变更规格、`docs/todo/` 追踪待办）配齐并守住 `AGENTS.md <= 30KB` 上限；日常研发由装入目标仓库 `.agents/skills/`（由 `.pf-manifest.json` 校验版本与完整性）的 5 个本地研发技能接管：

| 本地技能 | 核心脚本 | 职责与产出 |
| --- | --- | --- |
| `dev-explore` | `repo-map.mjs` | 三档（`quick`/`medium`/`thorough`）只读勘察代码结构、调用链与改动影响面 |
| `dev-plan` | `doc-plan.mjs` | 按改动等级在四层设计文档间分诊，生成架构、规格或工作追踪草稿（人批后生效） |
| `dev-flow` | `flow.mjs` | 驱动 Worktree 隔离工作流：开分支、认领、构建验证、提 PR、返工、合入与清理 |
| `dev-review` | `review-pack.mjs` | 组装隔离审查上下文与故障注入证据包，附带外源 PR 防投毒只读预检 |
| `dev-govern` | `govern-audit.mjs` | 巡检文档与代码对齐漂移，并提供 `release-prep` 多版本发版前核对 |

所有研发验证均按**信任倒金字塔**自上而下采信：`1. 静态门禁`（规则扫描与结构校验） > `2. 运行冒烟实证`（临时目录实跑与正反双向断言） > `3. 双门独立审查`（独立上下文逐条核对冻结标准） > `4. 契约文档`（文字描述只在被前三层印证时有效）。

## 三类接入场景对照

| 接入场景 | 起步状态 | `project-forge` 处理策略 | 典型入口命令 |
| --- | --- | --- | --- |
| **空目录闭环起步** | 空白目录或仅含空目录结构 | `--bootstrap-empty` 为 5 类栈生成源码、测试、`.gitignore`、`.gitattributes` 与文档底座 | `node "<skill-dir>/scripts/equip.mjs" "<repo>" --bootstrap-empty --lang node --name my-app` |
| **存量异构融合** | 已有业务代码、原有 README/CONTRIBUTING/LICENSE 或自有技能 | 只读识别 `artifactPlan`，原样保留有效资产，增量补齐缺失门禁、契约与本地技能 | `node "<skill-dir>/scripts/survey.mjs" "<repo>" --markdown --probe-auth` |
| **跨月漂移重入** | 已锻造数月后新增模块、升级底座或文档过期 | 无损重跑升级受管区间、核对 `.pf-manifest.json` 校验和并用 `govern-audit` 审计漂移 | `node "<skill-dir>/scripts/compose-agents.mjs" "<repo>" --upgrade` |

## 安装与快速上手

本工具集零第三方运行时依赖，仅需 **Node.js 18+** 与 **Git**，不绑定任何特定 AI 宿主。获取仓库后即可将其作为通用技能或本地命令集使用：

```sh
git clone <project-forge-repo-url> project-forge
```

对任意目标仓库执行一轮"只读勘察 -> 写前备份 -> 装配与生成 -> 实证体检"：

```sh
# 1. 只读勘察目标仓库（不写入任何文件），输出 10 项 artifactPlan 与 GitHub 认证探测
node "<skill-dir>/scripts/survey.mjs" "<project-dir>" --markdown --probe-auth

# 2. 写入前生成全量 .tar.gz 安全快照（支持随时按快照 ID 回滚）
node "<skill-dir>/scripts/backup.mjs" create "<project-dir>" --label pre-forge

# 3. 装配 5 个本地研发技能与受管 AGENTS.md（如已有则会增量融合或升级受管区间）
node "<skill-dir>/scripts/equip.mjs" "<project-dir>"
node "<skill-dir>/scripts/compose-agents.mjs" "<project-dir>"

# 4. 运行 10 域实证体检与交棒痕迹核查
node "<skill-dir>/scripts/review.mjs" "<project-dir>"
node "<skill-dir>/scripts/handoff.mjs" "<project-dir>" --verify
```

当你把它交给 AI 助手执行时，直接给出类似提示词即可：`用 project-forge 检查这个仓库的工程规范、远端发布链路与本地研发技能，按只读勘察先行并补齐缺失项。`

需要同步技能本身的新版本时，运行 `node "<skill-dir>/scripts/update.mjs" --check` 查看远端状态；在离线或受限环境中，可设置环境变量 `PF_NO_UPDATE=1` 关闭联网检查。

## 日常协作与可逆发版

锻造完成后的日常开发遵循**可撤回分档**原则，判断动作属于日常还是高风险不靠直觉，而看**能不能撤回**：

- **日常（可撤回）**：本地改动 → 跑通门禁 → 提交 → **推自己的分支** → 开 Pull Request → 独立上下文按冻结标准审查。删分支、关 PR 都可撤回，因此推分支与开 PR 属于日常动作。
- **审查即闭环**：独立审查输出 `fail` 为空且附带故障注入验证记录时，由**审查者直接合并**（若在维护者「取舍」段显式设置更保守策略除外）。
- **必须人拍板**：**弱化门禁**（删测试、放宽断言、加跳过标记、降级 CI 报错）会永久破坏后续每次校验的真实性，一律先停下由人点头；合并默认分支（未授权时）、对外发版、修改仓库可见性与改写历史同样不得擅自执行。

当人明确要求发版（支持跨多版本区间与自定义目标版本号）时，先通过本地技能的发布前核对整理区间变更并交叉验证影响面，再按 [RELEASING.md](RELEASING.md) 先提交发布说明到默认分支、后推标签并回读确认发布页与附件就绪：

```sh
node .agents/skills/dev-govern/scripts/govern-audit.mjs release-prep --from v4.0.0 --to HEAD --version v5.0.0
```

## 核心脚本速查

| 脚本 | 常用参数 | 用途 |
| --- | --- | --- |
| [scripts/survey.mjs](scripts/survey.mjs) | `--markdown`, `--probe-auth` | 只读勘察仓库现状、识别栈类型、探测 GitHub 认证并输出 10 项 `artifactPlan` |
| [scripts/backup.mjs](scripts/backup.mjs) | `create\|list\|restore`, `--label`, `--id`, `--dry-run`, `--json` | 写入前生成并管理 `.tar.gz` 安全快照 |
| [scripts/equip.mjs](scripts/equip.mjs) | `--check`, `--dry-run`, `--bootstrap-empty --lang ... --name ...` | 向目标项目装配/校验 5 个本地研发技能，或对空目录冷启动闭环工程 |
| [scripts/compose-agents.mjs](scripts/compose-agents.mjs) | `--status`, `--upgrade`, `--check`, `--clean` | 幂等生成或升级目标仓 `AGENTS.md` 受管区间并守住 30KB 预算上限 |
| [scripts/review.mjs](scripts/review.mjs) | `--scope=...`, `--strict`, `--json` | 按 10 个核心域做交付前逐项体检 |
| [scripts/handoff.mjs](scripts/handoff.mjs) | `--scan`, `--verify`, `--json` | 交棒前核查与清理过程临时痕迹 |
| [scripts/sync-toc.mjs](scripts/sync-toc.mjs) | `--check`, `--max-level`, `--min-sections` | 生成并校验双语 Markdown 目录 |
| [scripts/update.mjs](scripts/update.mjs) | `--check`, `--quiet`, `--equip <dir>` | 检查并更新本地 `project-forge` 能力包 |

## 环境要求、边界与许可

- **运行环境**：Node.js 18 及以上版本（`scripts/` 全部使用 `node:` 内置模块，无第三方依赖）、Git；如需自动配齐 GitHub 远端与发布保护，另需 GitHub CLI（`gh`）或已配置认证凭据。
- **能力边界**：`project-forge` 只负责仓库工程治理、协作契约、工作流底座与实证门禁，**不生成业务代码，也不替项目选型技术栈**；产品层仅面向 GitHub 生态。
- **延伸文档**：入口与门控调度见 [SKILL.md](SKILL.md)，本仓库工程契约见 [AGENTS.md](AGENTS.md)，贡献与 PR 规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，发版流程见 [RELEASING.md](RELEASING.md)。
- **开源许可**：采用 [MIT License](LICENSE) 发布。
