---
name: project-forge
description: |
  把一个项目目录（含空目录 0 文件起步、存量改造或跨月重入）治理成规范工程：版本管理、
  GitHub 双轨远端与通用 Git 降级、四层设计文档（docs/TDD.md 与 prd/specs/todo）、两档契约
  （lightweight < 14KB / full <= 30KB）、本地研发技能（.agents/skills/）与 CI/发布通道一次配齐，
  并给出日常无感路由与收尾协议。
  触发词：弄版本管理、配 git、上仓库、建仓库、推到 GitHub、初始化项目、项目起步、空项目起步、
  新项目配置、标准化项目、规范项目、整理项目、项目规范配置、写 AGENTS.md、写 README、
  写贡献指南、配 LICENSE、配 CI、发版配置、交棒、升级工具包、把痕迹清干净。
  适用于任意语言的仓库：12 种生态（Node、Python、Rust、Go、Java、Ruby、PHP、.NET、C/C++、
  Dart、Swift、Elixir）走清单精准推断，其余语言从 CI 的 run 块与 Makefile/justfile/Taskfile
  读取已被真实执行的命令；空目录 `--bootstrap-empty` 统一搭通用工程基线（支持 `--stack`），
  只读勘察先行，幂等不覆盖，支持 v2 墓碑/定制豁免与纯本地降级运行；默认私有仓库。
  不用于：纯概念问答、临时只改一行代码且不涉及工程治理、或跳过勘察强行覆盖手写规范。
metadata:
  version: "6.0.0"
  source: "https://github.com/FiretrUCK666/project-forge"
---

# project-forge

给一个项目目录，先只读勘察事实，再按体量选择 `lightweight` 或 `full` 档位，一次把治理设施与日常研发流装配到位。

**本文件只写调度与红线，不复述各 `references/` 里的具体判据。** 反直觉规则（防错判维护者、跨平台路径与 Junction 防删穿、`HostingProvider` 降级、外部 PR 防投毒、两档与 v2 账本）全部住在 `references/`，动手前按门控读对应全文，严禁凭直觉跳过。

## 四步（起步、存量接入或重入升级）

| 步 | 做什么 | 必读 / 入口 |
| --- | --- | --- |
| **S1 勘察** | 先更新再只读扫：`update.mjs --quiet`（1h 检查 / 15m 失败冷却、staging 校验后最后原子写 `SKILL.md`）后跑 `survey.mjs --markdown --probe-auth`（无远端亦探测本机凭据），获取 `recommendedTier`、`explorationStrategy.tier` 与 `artifactPlan`；若目录空白或仅含 `README`/`LICENSE`/配置（`none` / 0 业务文件），停下问 3–4 个简明问题后走 `--bootstrap-empty` 生成通用治理基线、初始 `docs/TDD.md` 与自洽 `AGENTS.md`，**不派只读子代理**；存量或重入仓记下 `tier` 与 `shards`（含 `business-flows`）供 `S3` 前只读实跑既有测试与主入口产出 `preForgeBaseline` | `references/survey.md` |
| **S2 定范围** | 逐项按 `facts.artifactPlan` 确定装配档位（`lightweight` 3 技能 / `full` 5 技能，待用户确认）与处置动作：**存量 `README`/`CONTRIBUTING`/单双 `LICENSE`/存量设计文档（`ARCHITECTURE.md`、`docs/adr/` 等）/工作流/`.agents/skills/<custom>/` 一律 `preserve` 原样融合**；缺项按 `create`/`equip`/`upgrade` 补齐，缺许可或待选发版策略（5 选 1）走 `ask-human`；跨月重入按 `reentry` 做 `calibrate`，并由 `equip.mjs` 按 v2 账本尊重 `disabledSkills`/`removedFiles` 墓碑与定制豁免 | 本文件 |
| **S3 落盘** | **第 0 步：非空存量仓先跑 `backup.mjs create "<项目目录>" --label pre-forge` 打全仓快照**（按 `treeSha256` 去重并钉住初始基线）；进入写入前，对存量代码仓以**只读方式实跑对方既有测试与主入口**生成 `preForgeBaseline`（结合 `dev-explore` `businessFlows` 映射），再严格按「版本控制 → 文档 → 远端 → 自动化」推进：配 Git 基线；按确认档位跑 `equip.mjs --tier <lightweight|full>` 装配 `.agents/skills/` 后，存量/重入仓依 `S1` `tier` 调 `.agents/skills/dev-explore/`（`parallel-subagents` 时按 `shards` 并行只读深挖，否则 `single-pass`）**只读取证**，由本步将 `businessFlows` 与 `preForgeBaseline` 落笔 `docs/TDD.md`（含 `## 文档信息` 表与短名 Mermaid 图）与 `prd`/`specs`/`todo`，生成/无损刷新 `AGENTS.md`（仅留薄指针保持 `lightweight < 14KB` / `full <= 30KB`，含 `行事总纲`、7 键 `Dev Profile` 与自有技能并存路由）；按 `HostingProvider`（`github` / `generic-git` 降级）与五态身份配远端与自动化 | 见门控表 |
| **S4 验收交棒** | 跑项目声明门禁 + `equip.mjs --check`（已登记定制文件豁免通过）+ `compose-agents.mjs --check` + `review.mjs`；汇报结论并经 `handoff.mjs` 询问是否清理引导标记（保留 `.agents/skills/` 时不把 `.pf-manifest.json` 计为残留） | `references/handoff.md` |

**S3 顺序不可逆**：`.gitattributes` 与 `.gitignore` 必须在首次提交之前落盘；文档与地址须在推送之前就绪；自动化跑的命令与 `AGENTS.md` / `README.md` 必须一致。

## 门控：未读不许动手

| 门控 | 触发时机 | 先读全文 | 防止踩中的典型事故 |
| --- | --- | --- | --- |
| **G1** | 任何写入前 | `references/survey.md` | `isRepoRoot` 为假误提交进父仓；把只读克隆误判成维护者；强覆盖存量设计文档 |
| **G2** | 首次提交或操作 Worktree 前 | `references/version-control.md` | 漏 `._*`/二进制规则、占位署名入史、未解绑 Junction 直接删穿主仓、Workspace 软链毒化 |
| **G3** | 写 `docs/`、`AGENTS.md`、`README`、`LICENSE` 前 | `references/docs-set.md` | `AGENTS.md` 超限、双许可错覆盖、Mermaid 长标签截断、漏成对归档 `PRD`/`SPEC`/`Todo` |
| **G4** | 建库、鉴权或配 CI/发布前 | `references/remote-github.md` | 误写 `known_hosts`、钥匙串弹窗挂死、非注册托管仓误阻断、`RELEASE_TOKEN` 滥建 |
| **G5** | 仅当人明确要求「发版」 | `references/publish.md` + `references/publish-ecosystems.md` | 把「攒够了」当发版、标签与清单或 `CHANGELOG` 不对齐、发前未推说明 |
| **G6** | 目标为插件或能力目录 | `references/skill-project.md` + `references/plugin-ecosystems.md` | frontmatter 错字段静默丢包、产物入库错位、拿本地挂载当隔离验收 |
| **G7** | 交棒校验或清理痕迹前 | `references/handoff.md` | 把交棒做成撤销、误把 `.pf-manifest.json` 当痕迹、把退出码 `3` 当成干净 |

## 日常研发闭环（8 阶段与五套件协同）

项目配好后按 `AGENTS.md` 意图路由静默调度已装配的 `.agents/skills/`（`lightweight` 含前 3 套、`full` 含全套 5 套），贯通 **需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入** 八阶段闭环（`TaskBackend` 抹平 `github` / `generic-git` / `local-only` 三态差异，有提交仓全量进入 `.worktrees/` 隔离），**不要求敲斜杠命令、不反问是否调用**：

| 阶段 / 场景 | 负责技能与核心机制 | 权威协作判据（按标题名直达） |
| --- | --- | --- |
| **1. 需求侦察与判身份** | `dev-explore` 只读跑 `repo-map.mjs` 输出 `Feature Map` 与 `reusableModules`；`flow.mjs inspect` 判五态与多 Issue 依赖图 | `references/collaboration.md`「一、先判角色」 |
| **2–3. 澄清、设计与 Critique** | `dev-plan` 联查多链接与自有模板，**多轮互动澄清直至无待拍板问题**（复杂需求主动建议 PRD），按 Case 1–5 分流并走不可自审 Critique | `references/collaboration.md`「二、五档开工分流」 |
| **4. 隔离实现与提审锁** | `dev-flow` 由 `next` 路由，全入 `impl-*`/`review-*` 槽复用；**谁改代码谁认领并负责 `finalize`（含 `--include-master-prd`）/`verify`/`submit` 与 PR/Issue 评论** | `references/collaboration.md`「三、三档隔离」「四、认领、PR 前文档同步」 |
| **5–7. 评审、实证与验收** | `dev-review` 对外部 PR 先扫 `--untrusted-scan`；运行 Behavioral/Structural 双门与实证核验，Round 2+ 新独立上下文 + 六锁收敛 | `references/collaboration.md`「五、收到别人的 Issue」「六、审别人提进来的 PR」「七、审查循环：怎么才会停」 |
| **8. 合入、清理与复盘** | 独立审查 PASS 后由审查者 `flow.mjs merge`（弱化门禁必拦），问人确认后 7 步清理；`dev-govern` 经 `audit`/`reconcile`/`retro` 读取 `signals.jsonl` 下沉门禁 | `references/collaboration.md`「八、谁能合」「九、合并：收尾七步」 |

## 能力矩阵与默认范围

| 事实 | 版本控制 | 文档与 `AGENTS` | `.agents/skills/` | 远端与自动化 |
| --- | --- | --- | --- | --- |
| `empty`（0 业务文件） | 先问 3–4 题后 `--bootstrap-empty` | 同左保留既有 `README`/`LICENSE` 并生成基线、`TDD` 与自洽 `AGENTS.md` | 按确认档位装配 | 按意向可选 |
| `docs-only` | 做 | 做（无代码可省 `TDD`，Profile 尊重 `none`） | 按确认档位装配 | 视远端（不发包） |
| 已识别代码生态 / 插件 / 能力目录 | 做 | 做（保留存量架构文档） | 按确认档位装配（支持 `--tier full` 升档） | 按声明与 5 选 1 策略 |
| `isRepoRoot` 为假 / `unknown` | **先停下问清** | 同左 | 暂缓 | 暂缓 |
| `role` 为 `contributor-fork` / `undetermined` | 做 | 做（不污染上游） | 按确认档位装配 | 只推自己 Fork 分支；不发布 |

## 只有用户能拍板的事与硬不变量

1. **只用户能定**：装配档位（`lightweight`/`full`）、许可证、署名来源、仓库可见性（默认私有）、归属账号、外部贡献与发版策略（5 选 1）。
2. **只读先行与 v2 墓碑/定制豁免**：勘察前零写入；重复运行字节幂等；用户已删除的技能或文件记入 `disabledSkills`/`removedFiles` 墓碑绝不擅自写回（仅 `--restore` 恢复）；经 `--adopt-custom` 豁免的手改文件不阻断 `--check`；跨系统换行归一等价不误报漂移。
3. **凭据零入库与跨平台安全**：扫描拦截密钥与大文件；探测注入无弹窗变量与 `5000ms` 超时且不写 `~/.ssh/known_hosts`；含中文/非 ASCII 正文一律经临时 UTF-8 文件按 `--body-file` / API JSON 提交并回读。
4. **按能不能撤回分档（日常与发版分开）**：提交、推自己的分支、开/改 PR 都能撤回，属于日常，不打标签不发版；合并默认分支、发版、改可见性、改写历史撤不回来，发版只由人明令触发，**强推与改写已推历史永不自动**。
5. **合并由审查者收尾、弱化门禁必问**：独立审查 `fail` 为空且 `reviewPassedHead === HEAD` 由审查者直接合（`contributor-fork` 交上游合）；**弱化门禁必须人点头**；`取舍` 中写 `merge-authority: human` 时收回人工确认。
6. **体积、图表与信任倒金字塔**：`AGENTS.md` 上限 `30KB`（`lightweight < 14KB`、`24KB` 预警）；Mermaid 矩形/分组单行 `<= 16`、菱形/边 `<= 12` 单位且禁 HTML；**形式验证与实证验证优先于对抗式读代码挑刺**，同类问题满 2 次沉入静态规则并清理死代码；删文件/分支/worktree 前必先列清单问人点头。

## 核心脚本（零第三方依赖，Node 18+）

```sh
# 0. 工具自更新（不与勘察并行；staging 校验后最后原子写 SKILL.md）
node "<本 skill 目录>/scripts/update.mjs" --quiet
# S1 只读勘察（--probe-auth 无远端亦可探测本地凭据，输出 recommendedTier 与 explorationStrategy.tier）
node "<本 skill 目录>/scripts/survey.mjs" "<项目目录>" --markdown --probe-auth
# S3 第 0 步：非空存量仓写前全仓 .zip 快照（钉住首份 pre-forge 基线；支持 list / restore，兼容 .tar.gz）
node "<本 skill 目录>/scripts/backup.mjs" create "<项目目录>" --label pre-forge
# S3 按档位装配 / 无损升级套件（空目录加 --bootstrap-empty [--stack <universal|node|python|go|rust|java|docs|...>] --name <name>；加 --with-hooks 装局部 .githooks/pre-push）
node "<本 skill 目录>/scripts/equip.mjs" "<项目目录>" --tier <lightweight|full>
# S3 按档位生成或无损刷新 AGENTS.md（--check / --upgrade / --clean / --no-backup）
node "<本 skill 目录>/scripts/compose-agents.mjs" "<项目目录>" --tier <lightweight|full>
# S3 把 CI 骨架按勘察事实落盘或配开关 A 分支保护（--kind check|release | --protect-branch [--branch <分支>]；非 GitHub 仓安全退出 0）
node "<本 skill 目录>/scripts/equip-ci.mjs" "<项目目录>" --kind check
# S4 交付体检与交棒检查（--verify 四档退出码：0 干净 / 1 有痕迹 / 3 没扫全 / 4 本仓源码不适用）
node "<本 skill 目录>/scripts/review.mjs" "<项目目录>"
node "<本 skill 目录>/scripts/handoff.mjs" "<项目目录>" --scan
```

**边界与汇报**：不做服务器部署/业务重构；不替选许可或伪造命令/署名；有测试命令的跑实测全绿才报「已验证」（纯文档写「只验了结构与文档一致性」）；收尾按「做了什么 -> 结果 -> 下一步（含交棒询问）」简明汇报。
