---
name: project-forge
description: |
  把一个项目目录（含空目录 0 文件起步、存量改造或跨月重入）治理成规范工程：版本管理、
  GitHub 双轨远端、四层设计文档（docs/TDD.md 与 prd/specs/todo）、<= 30KB 的 AGENTS.md、
  全套 5 个本地研发技能（.agents/skills/）与 CI/发布通道一次配齐，并给出日常无感路由与收尾协议。
  触发词：弄版本管理、配 git、上仓库、建仓库、推到 GitHub、初始化项目、项目起步、空项目起步、
  新项目配置、标准化项目、规范项目、整理项目、项目规范配置、写 AGENTS.md、写 README、
  写贡献指南、配 LICENSE、配 CI、发版配置、交棒、升级工具包、把痕迹清干净。
  支持 Node、Python、Rust、Go、Java、纯文档目录及插件与能力目录；只读勘察先行，幂等不覆盖，
  纯本地无远端照样全量装配 5 个研发技能；默认私有仓库。
  不用于：纯概念问答、临时只改一行代码且不涉及工程治理、或跳过勘察强行覆盖手写规范。
metadata:
  version: "5.0.0"
  source: "https://github.com/FiretrUCK666/project-forge"
---

# project-forge

给一个项目目录，先只读勘察事实，再决定该做什么，一次把治理设施与日常研发流装配到位。

**本文件只写调度与红线，不复述各 `references/` 里的具体判据。** 反直觉规则（防错判维护者、跨平台换行与 Junction 防删穿、四级 GitHub 降级、外部 PR 防投毒、30KB 契约护栏）全部住在 `references/`，动手前按门控读对应全文，严禁凭直觉跳过。

## 四步（起步、存量接入或重入升级）

| 步 | 做什么 | 必读 / 入口 |
| --- | --- | --- |
| **S1 勘察** | 先更新再只读扫：`update.mjs --quiet` 后跑 `survey.mjs --markdown --probe-auth` 获取 `explorationStrategy.tier` 与 `artifactPlan`；若目录空白（`none` / 0 业务文件），停下问 3–4 个简明问题后走 `--bootstrap-empty` 直接落盘起步 `docs/TDD.md`，**不派只读子代理**；存量或重入仓记下 `tier` 与 `shards` 供 `S3` 深度建构与校准 | `references/survey.md` |
| **S2 定范围** | 逐项按 `facts.artifactPlan` 与能力矩阵确定性推进：**存量 `README`/`CONTRIBUTING`/双许可或自有 `LICENSE`/`.agents/skills/<custom>/` 与非标目录一律 `preserve` 原样融合**；缺项按 `create`/`equip`/`upgrade` 补齐，缺许可走 `ask-human`；跨月重入按 `reentry` 做 `calibrate`（只修失效路径、失效脚本、新顶层模块与滞后 `TDD`），并由 `equip.mjs` 核对 `.pf-manifest.json` 无损升级、自净化退役旧文件 | 本文件 |
| **S3 落盘** | **第 0 步：非空存量仓先跑 `backup.mjs create "<项目目录>" --label pre-forge` 打全仓快照**（按 `treeSha256` 去重）；再严格按「版本控制 → 文档 → 远端 → 自动化」推进：配 Git 基线；全量装配 5 个 `.agents/skills/` 后，存量/重入仓依 `S1` `tier` 调 `.agents/skills/dev-explore/`（`parallel-subagents` 时按 `shards` 并行只读深挖，否则 `single-pass`）编写或校准 `docs/TDD.md`（按需删空节）与 `prd`/`specs`/`todo`，生成/无损刷新 `AGENTS.md`（`<= 30KB`，含 `行事总纲`、7 键 `Dev Profile` 与自有技能并存路由）；按五态身份与轨道 A/B 配 GitHub 远端与自动化 | 见门控表 |
| **S4 验收交棒** | 跑项目声明门禁 + `equip.mjs --check` + `compose-agents.mjs --check` + `review.mjs`；汇报结论并经 `handoff.mjs` 询问是否清理引导标记 | `references/handoff.md` |

**S3 顺序不可逆**：`.gitattributes` 与 `.gitignore` 必须在首次提交之前落盘；文档与地址须在推送之前就绪；自动化跑的命令与 `AGENTS.md` / `README.md` 必须一致。

## 门控：未读不许动手

| 门控 | 触发时机 | 先读全文 | 防止踩中的典型事故 |
| --- | --- | --- | --- |
| **G1** | 任何写入前 | `references/survey.md` | `isRepoRoot` 为假误提交进父仓；把只读克隆误判成维护者 |
| **G2** | 首次提交或操作 Worktree 前 | `references/version-control.md` | 漏二进制规则、占位署名入史、已推凭据误改历史、未解绑 Junction 直接删穿主仓依赖 |
| **G3** | 写 `docs/`、`AGENTS.md`、`README`、`LICENSE` 前 | `references/docs-set.md` | `AGENTS.md` 超 `30KB`、双许可错覆盖、丢 `docs/TDD.md` 或自建手写索引冲突 |
| **G4** | 建库、鉴权或配 CI/发布前 | `references/remote-github.md` | SSH-only 误报无凭据、单人仓审批自锁、公开前漏扫凭据、中文命令行乱码 |
| **G5** | 仅当人明确要求「发版」 | `references/publish.md` + `references/publish-ecosystems.md` | 把「攒够了」当发版、标签格式错致流水线静默跳过、发前未推说明 |
| **G6** | 目标为插件或能力目录 | `references/skill-project.md` + `references/plugin-ecosystems.md` | frontmatter 错字段静默丢包、产物入库错位、拿本地挂载当隔离验收 |
| **G7** | 交棒校验或清理痕迹前 | `references/handoff.md` | 把交棒做成撤销、误伤用户 `.agents/skills/<custom>/`、把退出码 `3` 当成干净 |

## 日常研发流路由（配好之后无感使用）

项目配好后日常走 `AGENTS.md` 顶部意图路由，直接静默加载 `.agents/skills/`（`dev-explore` / `dev-plan` / `dev-flow` / `dev-review` / `dev-govern`），**不要求用户敲斜杠命令、不反问是否调用**：

| 日常场景 | 权威协作判据（按标题名直达） |
| --- | --- |
| 判身份与防只读误推 | `references/collaboration.md`「一、先判角色」：五态表与 `clone-readonly` 三选一阻断 |
| 定门型、写规划与分级内审 | `references/collaboration.md`「二、五档开工分流」：`two-way`/`one-way` 判定、Case 1..5、规划 `audit` 与 Plan Critique |
| 开分支、建 Worktree 与共享依赖 | `references/collaboration.md`「三、三档隔离」：实施位 + detached 审查位、Junction 先解绑与 4 态清理判定 |
| 认领、PR 前归档与双写节点 | `references/collaboration.md`「四、认领、PR 前文档同步」：`finalize` 归档 Todo 至 `docs/archive/todo/` |
| 收 Issue 与审外部 PR | `references/collaboration.md`「五、收到别人的 Issue」「六、审别人提进来的 PR」：先扫供应链高危改动 |
| 双门独立审查、园艺治理与熔断 | `references/collaboration.md`「七、审查循环：怎么才会停」：`smoke-verify`/`arch-rules` 双门、6 锁收敛与园艺聚类 |
| 合并授权与收尾清理七步 | `references/collaboration.md`「八、谁能合」「九、合并：收尾七步」：弱化门禁必拦（退出码 4）与先问再清理 |

## 能力矩阵与默认范围

| 事实 | 版本控制 | 文档与 `AGENTS` | `.agents/skills/` | 远端与自动化 |
| --- | --- | --- | --- | --- |
| `empty`（0 业务文件） | 先问 3–4 题后 `--bootstrap-empty` | 同左生成基线、`README`、可执行测试与实填 `TDD` | 全量装齐 5 个 | 按意向可选 |
| `docs-only` | 做 | 做（无代码可省 `TDD`） | 全量装齐 5 个 | 视远端（不发包） |
| 已识别代码生态 / 插件 / 能力目录 | 做 | 做 | 全量装齐 5 个 | 按声明；克隆类不走制品库 |
| `isRepoRoot` 为假 / `unknown` | **先停下问清** | 同左 | 暂缓 | 暂缓 |
| `role` 为 `contributor-fork` / `undetermined` | 做 | 做（不污染上游） | 全量装齐 5 个 | 只推自己 Fork 分支；不发布 |

用户只点名一件事时**只做那一件事**；用户说全量治理时按上表事实求值全做，**已有内容先读后合不强覆盖**。

## 只有用户能拍板的事与硬不变量

1. **只用户能定**：许可证、署名来源、仓库可见性（默认私有）、归属账号/组织、外部贡献与发版意向。环境版本下限直读清单不瞎问；无人值守用安全默认值并单列待确认项。
2. **只读先行与幂等保护**：勘察完成前零写入；重复运行字节幂等；`AGENTS.md` 与 `.agents/skills/` 遇用户手工修改未标豁免时按 `.pf-manifest.json` 保护跳过，绝不静默覆盖。
3. **凭据零入库与跨平台安全**：扫描拦截密钥与大文件；探测防弹窗；含中文/非 ASCII 正文一律经临时 UTF-8 文件按 `--body-file` / API JSON 提交并回读，绝不命令行拼正文。
4. **按能不能撤回分档（日常与发版分开）**：提交、推自己的分支、开/改 PR 都能撤回，属于日常，不打标签不发版；合并默认分支、发版、改可见性、改写历史撤不回来，发版只由人明令触发，**强推与改写已推历史永不自动**。
5. **合并由审查者收尾、弱化门禁必问**：独立审查 `fail` 为空由审查者直接合（`contributor-fork` 交上游合）；**删测试、放宽断言、加跳过或改松 CI 等弱化门禁必须人点头**。`取舍` 中写 `merge-authority: human` 时收回人工确认。
6. **体积、自净与信任倒金字塔**：`AGENTS.md` 上限 `30KB`（`24KB` 预警）；**形式验证（类型/Schema/`arch-rules`/静态门禁）与实证验证（真实启动运行、CLI 实测、UI/视觉实际渲染截图与端到端交互）优先于对抗式读代码挑刺**（拒绝人肉代理），同类问题满 2 次沉入静态规则并清理死代码；写前快照存于仓外且交棒只清临时痕迹，删文件/分支/worktree 前必先列清单问人点头。

## 核心脚本（零第三方依赖，Node 18+）

```sh
# 0. 工具自更新（不与勘察并行）
node "<本 skill 目录>/scripts/update.mjs" --quiet
# S1 只读勘察（--probe-auth 并发探测 GitHub 轨道 A/B）
node "<本 skill 目录>/scripts/survey.mjs" "<项目目录>" --markdown --probe-auth
# S3 第 0 步：非空存量仓写前全仓 .tar.gz 快照（按 treeSha256 自动去重；亦支持 list / restore）
node "<本 skill 目录>/scripts/backup.mjs" create "<项目目录>" --label pre-forge
# S3 全量装配 / 升级 5 个研发技能（空目录加 --bootstrap-empty --lang <lang> --name <name>）
node "<本 skill 目录>/scripts/equip.mjs" "<项目目录>"
# S3 生成或无损刷新 AGENTS.md（<= 30KB；--check / --upgrade / --clean / --no-backup）
node "<本 skill 目录>/scripts/compose-agents.mjs" "<项目目录>"
# S4 交付体检
node "<本 skill 目录>/scripts/review.mjs" "<项目目录>"
# S4 交棒检查（--verify 四档退出码：0 干净 / 1 有痕迹 / 3 没扫全 / 4 不适用）
node "<本 skill 目录>/scripts/handoff.mjs" "<项目目录>" --scan
```

**边界与汇报**：不做服务器部署/业务重构；不替选许可或伪造命令/署名；有测试命令的跑实测全绿才报「已验证」（纯文档写「只验了结构与文档一致性」）；收尾按「做了什么 -> 结果 -> 下一步（含交棒询问）」简明汇报。
