# {{PROJECT_NAME}} — 项目工程契约（每次会话自动读）

本文件是本项目的工程入口契约：AI 每次新开会话先读它，确认项目定位、模块入口、边界、命令与协作流程。**只描述现在是什么样，不写变更履历。**

- **读者分流**：本文件面向 AI（配合 `docs/TDD.md`、`docs/specs/`、`docs/todo/`）；面向人的命令与说明在 `README.md`、`CONTRIBUTING.md`、`{{RELEASING_DOC}}`。
- **取值不写快照**：账号、远端、当前分支与版本号一律现场读清单与版本控制配置，不写死在本文件。
- **持续自演进铁律（严进常删，总长 <= 30KB）**：架构、命令或边界实质变化时须随该次提交同步更新本文并对齐 `README.md`；**24KB 起预警、禁止超过 30KB**——凡能 10 秒从源码直读的细节或已过时条目立即删出，子目录专属约束放 `<subdir>/AGENTS.md`（开头指回根契约，仅写特例，不抄通用规则）。

<!-- project-forge: begin 意图路由 -->
## 意图路由（静默触发，不反问）

收到用户自然语言需求时，**不要反问「要不要调用某 skill」或要求输入 `/skill`**，直接静默加载对应 `SKILL.md` 并先执行对应引擎脚本：

| 用户自然语言意图 | 加载本地 Skill | 先跑引擎脚本（按需传参） |
| --- | --- | --- |
| 理解项目 / 梳理架构 / 找模块入口 | `.agents/skills/dev-explore/SKILL.md` | `node .agents/skills/dev-explore/scripts/repo-map.mjs` |
| 写需求 / 定方案 / 拆任务 / 查文档全景 | `.agents/skills/dev-plan/SKILL.md` | `node .agents/skills/dev-plan/scripts/doc-plan.mjs` |
| 做功能 / 修缺陷 / 接 Issue / 改 PR | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs inspect` |
| 提交 / 推分支 / 开或更新 PR | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs finalize` -> `verify` -> `submit` |
| 本地预审 / 独立审查 / 审外部 PR | `.agents/skills/dev-review/SKILL.md` | `node .agents/skills/dev-review/scripts/review-pack.mjs` |
| 合并 PR / 清理本地分支与 Worktree | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup` |
| 代码体检 / 清技术债 / 对齐契约与文档 | `.agents/skills/dev-govern/SKILL.md` | `node .agents/skills/dev-govern/scripts/govern-audit.mjs` |
| 首次规范化接管 / 升级工具包 / 交棒退场 | 运行本工具 `survey` / `equip` / `review` / `handoff` | 始终先只读 `survey.mjs`，不直接写业务代码 |
<!-- project-forge: end 意图路由 -->

<!-- project-forge: begin 项目定位 -->
## 项目定位

<!-- project-forge: fill 项目定位：两三句话说清本项目解决什么问题、面向谁、对外提供什么形态（命令行工具 / 库 / 服务 / 应用 / 插件 / 能力目录），以及明确不做什么 -->
<!-- project-forge: end 项目定位 -->

<!-- project-forge: begin Dev Profile -->
## Dev Profile

以下键值由研发流脚本自动读取，核对后替换为真实值（无对应项填 `none`）：

```yaml
quick-test: <单文件或快测命令>
full-test: <全量构建与测试命令>
merge-gate: <合并前必跑完整门禁命令>
high-risk: <高风险路径前缀或文件，逗号分隔>
do-not-edit: <禁止自动修改的路径，逗号分隔>
```

<!-- project-forge: fill Dev Profile：核对并补齐上方 quick-test / full-test / merge-gate / high-risk / do-not-edit 真实取值后删掉本行 -->
<!-- project-forge: end Dev Profile -->

<!-- project-forge: begin 上下文阅读护栏 -->
## 上下文阅读护栏

- **按序读取**：`AGENTS.md` -> `docs/TDD.md`（若存在）-> 相关 `<subdir>/AGENTS.md` -> 用 `repo-map.mjs` 定位源码；修改前先跑 `flow.mjs inspect` 拿当前角色与任务状态。
- **默认不读**：`docs/archive/`、`node_modules/`、`dist/`、`build/`、`.worktrees/`、锁文件全文与构建产物缓存（仅当任务显式命中时定向查阅）。
<!-- project-forge: end 上下文阅读护栏 -->

<!-- project-forge: begin 架构与关键不变量 -->
## 架构与关键不变量

### 模块与入口

<!-- project-forge: fill 模块入口：按「职责 → 入口文件或目录」列出核心模块；如已维护 docs/TDD.md，此处只留总览表并指向 docs/TDD.md -->

### 关键不变量（破坏即事故）

<!-- project-forge: fill 关键不变量：列出「改 A 必须同步看 B」「哪条数据格式 / 接口协议 / 包边界绝不可破」，并注明定义它的权威文件 -->
<!-- project-forge: if is-monorepo -->

## 多包仓库边界（Workspace）

根层负责全局门禁编排，子包（{{WORKSPACE_PACKAGES}}）各自维护入口与依赖声明，**严禁跨子包直接引用未导出的内部私有路径**。子包专属约定放入 `<package>/AGENTS.md`（开头指回根契约，不重复抄通用规则）。
<!-- project-forge: endif -->
<!-- project-forge: if is-plugin-or-skill -->

## 宿主加载与分发边界

- **身份标识零容错**：宿主清单或 `SKILL.md` frontmatter 必填字段必须严格对齐规范，缺失或类型错误会让宿主静默丢弃；宿主侧 ID 与分发包名严格区分，**绝不混改**。
- **产物与分发通道对齐**：宿主直读仓库/制品库编译产物时源码改动须同提交重建；从发布页附件下载时编译产物绝不入库。**严禁用本地挂载（符号链接）代替隔离安装验收**。
<!-- project-forge: endif -->
<!-- project-forge: end 架构与关键不变量 -->

<!-- project-forge: begin 构建与验证 -->
## 环境与构建验证（改完必跑，全绿才算完成）

- **运行环境要求**：{{RUNTIME_REQUIREMENTS}}
<!-- project-forge: if has-commands -->

```sh
{{COMMANDS}}
```
<!-- project-forge: endif -->
<!-- project-forge: if no-commands -->

本项目尚未在清单里声明标准命令。读源码后替换下面内容——**纯文档项目**改为「本项目无构建与测试步骤，交付时只验结构与文档一致性」，并删掉代码块。

<!-- project-forge: fill 构建与验证命令：填这个项目真实的构建、静态检查、测试命令，一条一行 -->
```sh
# 把真实命令写在这里，然后删掉上面那行 fill 标记
```
<!-- project-forge: endif -->

**跑出来的才算做完**——拿不出实际运行通过的输出，不得声称「已验证」。
<!-- project-forge: end 构建与验证 -->

<!-- project-forge: begin 修改守则 -->
## 工程修改守则与硬性规范

- **先看再动，贴合既有结构**：先读现有实现与相邻代码，能并入现成机制就不另起炉灶。
- **治本不治标，不留双轨**：先查清根因再动手，被替换掉的旧逻辑一并清干净，不留新旧双轨并存。
- **小步验证，严控依赖**：不擅自引入第三方依赖，确需引入时先说明理由并取得确认。
- **测试正反双向**：修缺陷先写稳定复现的失败测试（Red-Green）；新增判定或解析逻辑须同时覆盖正面用例与易误判的反面用例。
- **不写履历，文档同步**：只描述当前状态；改动代码导出、CLI、模块边界或核心契约时，**必须在提交前同步更新 `docs/TDD.md` / `README.md` / `AGENTS.md`**。
- {{COMMIT_STYLE_HINT}}
<!-- project-forge: if has-bilingual-docs -->
- **多语文档成对同步**：本仓库有 {{README_LIST}}，改任一语言版本必须同步另一份，并保持双向互指链接有效。
<!-- project-forge: endif -->
<!-- project-forge: end 修改守则 -->

<!-- project-forge: begin 修改守则补充 -->
## 项目特有红线

<!-- project-forge: fill 项目特有红线：补充本项目特有的硬性规范（如兼容性下限、禁 emoji、性能预算等）；无额外规范可直接删掉本行{{CONVENTIONS_HINT}} -->
<!-- project-forge: end 修改守则补充 -->

<!-- project-forge: begin 版本与发布 -->
## 版本管理与回滚底线

- **提交纪律**：一次实质变更一个独立提交，提交信息说清「改了什么、为什么」，不用内部编号充当说明；大改动或高风险操作前先留干净存档点；有入库构建产物或锁文件须同提交更新。
- **回滚四档**：未提交 -> 丢弃工作区；已提交未推 -> 回退存档点；**已推送远端 -> 一律反向提交，严禁强推或改写已推送历史**；已发布版本 -> 只能发递增的新版本（永不复用或删旧版）。
<!-- project-forge: if has-release -->

### 版本号与发版死锁防护

版本号以 `{{VERSION_SOURCE}}` 为唯一权威来源；**兼容性下限只上移、不下移、默认不动**（上移须同步修改清单与 `README.md` 环境要求节）。

**日常与发版是两件事，默认只做前一件：**

- **日常**：改完 -> 跑门禁 -> 提交 -> **推自己的分支 -> 开 PR -> 独立审查 -> 合并**。**不打标签、不建发布页、不发制品库。**

  **推到哪一档由「能不能撤回」决定，不由「是不是对外」决定**：推自己的分支、开 PR、改 PR 都能撤回，属于日常；合并默认分支、发布、改可见性、改写历史撤不回来，要先给人看清单。**强制推送与改写已推送历史永不自动执行。**
- **发版**：只有明确说要「发版」时才做，顺序严格按 `{{RELEASING_DOC}}`——先提交并推送发布说明（`{{RELEASE_NOTES_TARGET}}`）到默认分支 `{{DEFAULT_BRANCH}}`，再打标签推送。
- **不自己判断「该发版了」**：攒了几个改动或隔了一阵都不是理由，发版必须人点头。
- **回读才算发完**：标签推上后回读发布页正文、附件与制品库版本均已就位才算完成。
<!-- project-forge: endif -->
<!-- project-forge: end 版本与发布 -->

<!-- project-forge: begin 日常协作与风险分流 -->
## 日常协作：改动怎么落地

- **第一步：双轴五态身份判定（不靠猜）**。

  <!-- project-forge: if has-remote -->
  先核对远端与源仓库：`origin` 与项目声明的源仓库一致且本机有写权限时为 **maintainer**（走分支 -> 门禁 -> 推自己分支 -> 开 PR -> 独立审查 -> 合并，严禁直推主干）；存在不同 `upstream` 或 Fork 时为 **contributor-fork**（**只推自己的 `origin` fork**、向 `upstream` 开 PR，严禁推正本、打标签、发版或提前删 Fork 分支；标签 403 自动降级）；克隆他人正本且无写权限时为 **clone-readonly**（先停下由人选 Fork / 独立新建 / `.git/pf-local-mode` 纯本地）；信息不足按 **undetermined** 保守处理；审外来 PR 为 **inbound-external-pr**（详见 `CONTRIBUTING.md`）。
  <!-- project-forge: endif -->
  <!-- project-forge: if no-remote -->
  这个项目还没有远端，所以眼下只有本地提交。**但落在高风险路径上的改动仍然要有一次独立审查**，结论写进本地任务单——审查不依赖远端存在，它依赖「这处改坏了不会当场失败」。
  <!-- project-forge: endif -->

- **第二步：五档开工分流（Case 1..5）**——动手前先跑 `doc-plan.mjs triage`（或 `flow.mjs inspect`）：

  | 档位 | 触发特征 | 文档与检查动作 |
  | --- | --- | --- |
  | **Case 1** | 纯问答 / 错别字 / 单行格式 | 0 文档，直接改，跑相关校验 |
  | **Case 2** | 明确局部缺陷，不改对外契约 | 0 文档，**先写稳定复现失败测试再修（Red-Green）** |
  | **Case 3** | `L2` 功能或局部调整，不改外部契约 | 在 `{{WORK_DIR}}` 建 Todo，冻结 `C1`、`C2`… |
  | **Case 4** | `L3` 跨模块重构、接口/契约变更或高风险 | 先建 `docs/specs/`（`Status: approved`）+ `{{WORK_DIR}}` Todo |
  | **Case 5** | 与 `docs/TDD.md` 或生效 `SPEC` 冲突 | **阻断并先更新 `docs/TDD.md`**，人拍板后再继续 |

  外加一条硬规则：**触碰下方「高风险路径」任一处 -> 必须有独立审查**。任务账本存于 `.worktrees/.state/tasks/<taskId>.json`；结论写进首次回复、Issue 评论或 PR「实现依据」栏。

- **第三步：三档隔离与 Worktree 共享依赖**——

  | 档位 / 场景 | 隔离策略 | 谁能动 / 怎么用 |
  | --- | --- | --- |
  | 第 1 档：`L1` 且主仓工作区干净 | 本地新建特性分支 | 就地开发，不建多余 worktree |
  | 第 2 档：`L2`/`L3`、接 Issue、脏主仓或并行 | `.worktrees/impl-<taskId>/`（新分支）+ `.worktrees/review-<taskId>/`（detached `HEAD`） | 实施者仅改 `impl-*`；独立审查者在 `review-*` 做故障注入，用完即弃 |
  | 第 3 档：外来 PR（`inbound-external-pr`） | `.worktrees/review-pr-<M>/`（detached `FETCH_HEAD`） | 先静态扫高危变更，禁用生命周期脚本经人确认后再跑门禁 |

  锁文件一致时用 `worktree-deps.mjs` 挂载共享依赖（Windows Junction / POSIX Symlink）；**清理 worktree 前必须先仅对链接执行 `unlinkSync` 解绑，严禁直接递归删目录**。`.worktrees/` 必须已忽略；卸前先问人。

- **第四步：认领与 PR 前文档同步（有远端时适用）**——

  **谁改，谁先认领**（`flow.mjs claim`）。**一次改动 = 一个分支 = 一个 PR**（已有对应 Issue + OPEN PR 时直接复用，不开第二条）；返工在原分支追加提交、更新同一个 PR，不重排无关文件。**PR 提交前必须跑 `flow.mjs finalize`**：核对 Todo 全勾 `[x]` 并归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented` 补实现说明、确认代码-文档对齐。

  | 节点 | 留在哪 | 说什么 |
  | --- | --- | --- |
  | 认领 | Issue | 谁认领、用哪条分支 |
  | 已提 PR | Issue | PR 链接，以及 `Fixes #N` / `refs #N` |
  | 审查退回 | PR **和** Issue | 哪几条标准没过、故障注入记录、第几轮 |
  | 审查通过 | PR **和** Issue | `fail` 为空、下一棒是谁 |
  | 返工已提交 | PR **和** Issue | 新 HEAD 短哈希、门禁已重跑、请重新审核 |
  | 已合并 | Issue | 合并到哪、关掉了哪几个 Issue |

  没有远端时跳过平台动作，在任务账本记录执行者与结论。

- **第五步：独立审查与合并**——

  **独立审查通过之后，由那个审查者直接合。** 外部 PR 同理，安全防线在审查前（只读扫描与禁用生命周期脚本）。**唯一必须人点头的一类：弱化门禁**（删测试、放宽断言、加跳过标记、改警告、改松 CI）。

  | 改动 | 谁能合 |
  | --- | --- |
  | 普通改动 / 外部 PR，独立审查 `fail` 为空 | **审查者直接合** |
  | 触碰下方「高风险路径」任一处 | 审查者合，但审查必须是独立上下文 + 故障注入 |
  | **弱化门禁** | **必须人点头** |

  `contributor-fork` 严禁自合正本 PR，提交后等待上游维护者处理。在「## 取舍」写 `merge-authority: human` 时收回人工确认；发版、改可见性、改写历史永不自动。审查只判冻结标准 `C*`（`fail:`/`pass:` + 故障注入记录），六锁收敛与停损熔断规则只在协作判据写一份，不在本节复抄。

- **第六步：合并收尾与平台交互防乱码**——固定 7 步，顺序不能调：
  1. **把要写的东西写完，并纳入这次 PR**：Todo「完成后的记录」与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、断点写成「已完成，无遗留」。**提交进同一个分支**——合并后再改文件就得另开 PR；
  2. 合并 PR（**不勾选自动删分支**）；
  3. 回读确认 `state=MERGED`；
  4. `git switch {{DEFAULT_BRANCH}} && git pull`；
  5. **先卸 worktree**：`git worktree remove <路径>`（先用 `worktree-deps` 解绑共享依赖链接再删；分支被 worktree 检出时下一步必败）；
  6. 再删本地分支：`git branch -d <分支>`（不是 `-D`）；
  7. **删远端分支之前查两件事**：远端还在不在（`git ls-remote --heads origin <分支>`）、有没有下游堆叠 PR 以该分支为 base（Fork 场景另查上游 PR 非 `OPEN`）；**两件都清了才** `git push origin --delete <分支>`。

  **第 1 步为什么在合并之前**：文档与任务单是库内文件，合并后主干拒推会迫使每件事多出一个只改记录的 PR。

  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支，以及「干净的」是哪几项。**问到人点头才删**（对应 `flow.mjs cleanup --confirm`）；没问到人只汇报，不自己动手。

  通过平台命令创建或更新 Issue、PR、Release、评论时，**含中文或非 ASCII 的正文一律先写入系统临时目录的 UTF-8 文件，用 `--body-file` / `--notes-file` 提交**并回读删临时文件；**严禁命令行直接拼接正文字符串**。

- **日常到此为止**：合并就是一次改动的终点。**发版是另一件事**，要人明确说才做——见上面「版本管理与回滚底线」。

- **同步不变量**：本节与项目协作判据是**同一套规则**，改任一处必须在同一次提交里对齐另一处；指路一律用标题名，不用节号。
<!-- project-forge: end 日常协作与风险分流 -->

<!-- project-forge: begin 高风险路径 -->
## 高风险路径（触碰须独立审查 + 故障注入）

改在这里出错不会当场失败，而是让门禁从此少查一项——坏了看着还是一片绿。

<!-- project-forge: fill 高风险路径：列出本项目中「改错了不可逆、或会让门禁从此静默少查一项」的目录前缀或文件 -->

写目录时结尾带 `/`，写单个文件时不要带。默认至少包含 `.github/`、`AGENTS.md` 与 `Dev Profile` 中的 `high-risk` 路径。
<!-- project-forge: end 高风险路径 -->

<!-- project-forge: begin 取舍 -->
## 取舍

这一节由维护者手写，脚本不碰。**只有使用者能定的那几件事**记在这里，交付体检会把记下的项当作已表态：

```text
- `license`：不放，因为这是个人项目
- `no-ci`：不配，本地跑就够了
```

可用的键名会在交付体检的「待定」项里逐条给出；删掉某一项就等于重新待定。
<!-- project-forge: end 取舍 -->
