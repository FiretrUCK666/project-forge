# project-forge — 项目工程契约（每次会话自动读）

本文件是这个项目的接口契约：AI 每次新开会话先读它，就知道这是什么项目、机制怎么运转、
命令怎么跑、哪些地方不能改坏。**它描述现在是什么样，不描述改过什么。**

- **读者分流**：本文件面向 AI，写机制、边界与判据；面向人的命令与地址在 `README.md`、
  `CONTRIBUTING.md`、`RELEASING.md` 里，不复述。
- **取值不写快照**：账号、邮箱、远端地址、当前分支、当前版本号一律现场读（清单文件、
  版本控制配置、账号查询命令）。Fork 易主后这份文件仍然成立。
- **AI 自维护授权**：项目架构、命令或约定发生实质变更导致本文件失准时，直接更新本文并
  随代码一同提交；涉及用户可见行为或命令变化时，必须同步更新 `README.md`。


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

一个通用的「项目锻造」skill：给任意项目目录，只读勘察现状、按事实判断该做哪几件事，
把版本管理、GitHub 远端、文档套装、发布通道配到位，并给出配好之后每天怎么干活的协作协议。
**它只做治理，不生成业务代码，也不替项目选型。**

仓库是这套规范的**第一个用户**：`references/` 里写的做法，这里必须自己做到；
做不到时**先改自己，再改规范**。
<!-- project-forge: end 项目定位 -->


<!-- project-forge: begin Dev Profile -->
## Dev Profile

以下键值由研发流脚本自动读取，核对后替换为真实值（无对应项填 `none`）：

```yaml
quick-test: node scripts/dev/preflight.mjs
full-test: node scripts/dev/fixtures.mjs
merge-gate: node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs
high-risk: scripts/lib/, scripts/dev/preflight.mjs, templates/, kit/, SKILL.md, AGENTS.md, .github/workflows/, .gitattributes
do-not-edit: docs/archive/, docs/release-notes/
```
<!-- project-forge: end Dev Profile -->

<!-- project-forge: begin 上下文阅读护栏 -->
## 上下文阅读护栏

- **按序读取**：`AGENTS.md` -> `docs/TDD.md`（若存在）-> 相关 `<subdir>/AGENTS.md` -> 用 `repo-map.mjs` 定位源码；修改前先跑 `flow.mjs inspect` 拿当前角色与任务状态。
- **默认不读**：`docs/archive/`、`node_modules/`、`dist/`、`build/`、`.worktrees/`、锁文件全文与构建产物缓存（仅当任务显式命中时定向查阅）。
<!-- project-forge: end 上下文阅读护栏 -->
<!-- project-forge: begin 架构与关键不变量 -->
## 架构与关键不变量

### 模块与入口

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 入口 | `SKILL.md` | 调度与红线：四步、门控表、能力矩阵、硬不变量。**不写判据** |
| 决策 | `references/` | 每份回答一类问题；动手前读完全文，读的是反直觉的那几条 |
| 落盘骨架 | `templates/` | 写进被治理项目的文件母版；条件块与占位符在生成时求值 |
| 内置技能 | `kit/skills/` -> `.agents/skills/` | 五套自包含研发 Skill 单源；通过 `equip.mjs` 同步生成 `.agents/skills/` 与 `.pf-manifest.json` |
| 引擎 | `scripts/` | `survey` 勘察、`equip` 装备、`compose-agents` 生成、`review` 体检、`handoff` 交棒、`sync-toc` 目录同步、`update` 自更新 |

`scripts/lib/` 收敛标记与预算（`protocol.mjs`）、模板求值（`template.mjs`）、报告排版（`render.mjs`）、契约回查（`claims.mjs`）与平台探针（`platform/`）。完整架构与不变量见 `docs/TDD.md`；`scripts/dev/` 与 `.agents/` 只服务本仓库，不进用户包。

### 关键不变量（破坏即事故）

1. **零第三方依赖**：`scripts/` 只用 `node:` 内置模块，只用 JavaScript。`preflight` 扫磁盘检查。
2. **入口不复述判据**：`SKILL.md` 只写「什么时候读哪一份」。两处都写机制，一定有一处先过期。
3. **不写死取值**：账号、路径、版本号、仓库地址、默认分支一律写「从哪里取」。
4. **单一真相源**：标记语法只在 `protocol.mjs`；条件与变量只在 `template.mjs`；
   报告排版只在 `render.mjs`。同一件事两个实现，迟早给出两个答案。
5. **幂等**：所有脚本重复执行结果相同。判据是第二遍的字节与第一遍相同。
6. **只读先行**：勘察完成之前不写任何文件。
7. **预算门禁**：入口行数与字节、参考文档合计行数、一次全量必读行数三个上限，
   **数字只写在 `scripts/lib/protocol.mjs` 的四个常量里**，`preflight` 读它们来判并喊。
   本文不复述具体数值——复述的那一份不会跟着常量变，而它看起来像权威。
8. **渲染产物零残留**：目标项目的 `AGENTS.md` 里不许出现 `{{占位符}}` 与 `if/endif`——
   它们必须在渲染那一刻求值完。留一个 `{{COMMANDS}}` 在用户文件里，看起来像「这里本来就该
   有一段命令」，没人会发现，直到有人照着它去找命令。

## 宿主加载与分发边界

- **身份标识零容错**：宿主清单或 `SKILL.md` frontmatter 的必填字段必须与规范严格对齐，缺失或类型错误会让宿主**静默丢弃且不报错**；宿主侧的 ID 是数据存储地址，改名即丢用户数据，与分发侧的包名严格区分，**绝不混改**。
- **产物与分发通道对齐**：宿主直接从仓库或制品库加载编译产物、安装方不构建的，源码修改后必须**在同一次提交里重建产物**；宿主从发布页附件下载产物的，编译产物**绝不进版本库**，只在发版时挂成附件。
- **严禁用本地开发挂载（符号链接）代替正式分发包的隔离安装验收**。
<!-- project-forge: end 架构与关键不变量 -->

<!-- project-forge: begin 构建与验证 -->
## 环境与构建验证（改完必跑，全绿才算完成）

- **运行环境要求**：Node 18 以上。没有构建步骤，没有需要安装的依赖。

```sh
node scripts/dev/preflight.mjs                              # 结构 + 引用 + 模板 + 自举 + 端到端冒烟
node scripts/dev/gap-coverage.mjs                           # survey 缺口与 review 结论配对检查
node scripts/dev/fixtures.mjs                               # 行为断言：造临时项目实跑，正反双向
node scripts/compose-agents.mjs . --check                   # 本仓库契约：标记成对、无未填占位、体积 <= 30KB
node scripts/equip.mjs . --check                            # kit/skills 与 .agents/skills 字节级一致
node scripts/review.mjs .                                   # 交付体检，预期 0 个「缺」
node scripts/sync-toc.mjs README.md README.en.md --check     # 双语 README 的目录同步
```

用户包内容要真跑一次导出再核对（用完删掉 `package-list.txt`）：

```sh
git archive --format=tar -o "$TMPDIR/pf-pkg.tar" HEAD && tar -tf "$TMPDIR/pf-pkg.tar" > package-list.txt && node scripts/dev/preflight.mjs --package package-list.txt
```

动过判定逻辑时再加一条——它验的不是「现在绿不绿」，是**「绿是不是真的」**：

```sh
node scripts/dev/verify-injections.mjs
```

**跑出来的才算做完**——拿不出实际运行通过的输出，不得声称「已验证」。
<!-- project-forge: end 构建与验证 -->

<!-- project-forge: begin 修改守则 -->
## 工程修改守则与硬性规范

- **先看再动，贴合既有结构**：先读现有实现与相邻代码，能并入现成机制就不另起炉灶。
- **治本不治标，不留双轨**：先查清根因再动手，被替换掉的旧逻辑一并清干净，不留新旧双轨并存。
- **小步验证，严控依赖**：不擅自引入第三方依赖，确需引入时先说明理由并取得确认。
- **测试正反双向**：修缺陷先写稳定复现的失败测试（Red-Green）；新增判定或解析逻辑须同时覆盖正面用例与易误判的反面用例。
- **不写履历，文档同步**：只描述当前状态；改动代码导出、CLI、模块边界或核心契约时，**必须在提交前同步更新 `docs/TDD.md` / `README.md` / `AGENTS.md`**。
- 本项目历史提交是平铺的一句说明——沿用它，不要混用第二套格式，不用内部编号充当说明
- **多语文档成对同步**：本仓库有 `README.en.md`、`README.md`，改任一语言版本必须同步另一份，并保持双向互指链接有效。
<!-- project-forge: end 修改守则 -->


<!-- project-forge: begin 修改守则补充 -->
## 项目特有红线

- **禁 emoji**：代码、注释、文档、提交信息一律禁止。这条由 `preflight` 扫磁盘检查。
- **不绑定具体 AI 宿主**：面向使用者的文件里不出现任何特定宿主的名字、环境变量或私有路径；宿主兼容由 `SKILL.md` 的通用规范保证（`name` 与 `description` 必需、相对路径引用）。
- **双向证伪 fixture 铁律**：新增或修改任何勘察 / 门禁判定逻辑时，必须在 `scripts/dev/fixtures.mjs` 里同时补齐「该命中的正面用例」与「易误判的反面用例」。只测正面等于没测——它只证明了这个判据会命中，没证明它不会误伤。
<!-- project-forge: end 修改守则补充 -->
<!-- project-forge: begin 版本与发布 -->
## 版本管理与回滚底线

- **提交纪律**：一次实质变更一个独立提交，提交信息说清「改了什么、为什么」，不用内部编号充当说明；大改动或高风险操作前先留干净存档点；有入库构建产物或锁文件须同提交更新。
- **回滚四档**：未提交 -> 丢弃工作区；已提交未推 -> 回退存档点；**已推送远端 -> 一律反向提交，严禁强推或改写已推送历史**；已发布版本 -> 只能发递增的新版本（永不复用或删旧版）。

### 版本号与发版死锁防护

版本号以 `SKILL.md` 为唯一权威来源；**兼容性下限只上移、不下移、默认不动**（上移须同步修改清单与 `README.md` 环境要求节）。

**日常与发版是两件事，默认只做前一件：**

- **日常**：改完 -> 跑门禁 -> 提交 -> **推自己的分支 -> 开 PR -> 独立审查 -> 合并**。**不打标签、不建发布页、不发制品库。**

  **推到哪一档由「能不能撤回」决定，不由「是不是对外」决定**：推自己的分支、开 PR、改 PR 都能撤回，属于日常；合并默认分支、发布、改可见性、改写历史撤不回来，要先给人看清单。**强制推送与改写已推送历史永不自动执行。**
- **发版**：只有明确说要「发版」时才做，顺序严格按 `RELEASING.md`——先提交并推送发布说明（`docs/release-notes/<标签>.md`）到默认分支 `main`，再打标签推送。
- **不自己判断「该发版了」**：攒了几个改动或隔了一阵都不是理由，发版必须人点头。
- **回读才算发完**：标签推上后回读发布页正文、附件与制品库版本均已就位才算完成。
<!-- project-forge: end 版本与发布 -->

<!-- project-forge: begin 日常协作与风险分流 -->
## 日常协作：改动怎么落地

- **第一步：双轴五态身份判定（不靠猜）**。

  先核对远端与源仓库：`origin` 与项目声明的源仓库一致且本机有写权限时为 **maintainer**（走分支 -> 门禁 -> 推自己分支 -> 开 PR -> 独立审查 -> 合并，严禁直推主干）；存在不同 `upstream` 或 Fork 时为 **contributor-fork**（**只推自己的 `origin` fork**、向 `upstream` 开 PR，严禁推正本、打标签、发版或提前删 Fork 分支；标签 403 自动降级）；克隆他人正本且无写权限时为 **clone-readonly**（先停下由人选 Fork / 独立新建 / `.git/pf-local-mode` 纯本地）；信息不足按 **undetermined** 保守处理；审外来 PR 为 **inbound-external-pr**（详见 `CONTRIBUTING.md`）。

- **第二步：五档开工分流（Case 1..5）**——动手前先跑 `doc-plan.mjs triage`（或 `flow.mjs inspect`）：

  | 档位 | 触发特征 | 文档与检查动作 |
  | --- | --- | --- |
  | **Case 1** | 纯问答 / 错别字 / 单行格式 | 0 文档，直接改，跑相关校验 |
  | **Case 2** | 明确局部缺陷，不改对外契约 | 0 文档，**先写稳定复现失败测试再修（Red-Green）** |
  | **Case 3** | `L2` 功能或局部调整，不改外部契约 | 在 `docs/todo/` 建 Todo，冻结 `C1`、`C2`… |
  | **Case 4** | `L3` 跨模块重构、接口/契约变更或高风险 | 先建 `docs/specs/`（`Status: approved`）+ `docs/todo/` Todo |
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
  4. `git switch main && git pull`；
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

| 路径 | 为什么 |
| --- | --- |
| `scripts/lib/` | 标记语法、条件求值、报告排版的单一真相源；错一处，四条路径同时静默失效 |
| `scripts/dev/preflight.mjs` | 门禁本身。它被改松时没有任何东西会报错，包括它自己 |
| `templates/` | 写进别人项目里的骨架；条件写错一整块会静默消失 |
| `kit/` | 随包分发且同步进 `.agents/skills/` 的五套研发 Skill；改后须重跑 `equip.mjs .` |
| `SKILL.md` | 入口。删掉一条门控，等于让后面每一步都失去前置检查 |
| `AGENTS.md` | 本文件。它是受管区间的容器，改坏了刷新就再也对不上 |
| `.github/workflows/` | 发布链路的门；门被改松，下一次发版就没人拦 |
| `.gitattributes` | 它决定用户包里有什么；与 `protocol.mjs` 的 `REPO_ONLY_*` 必须一致 |
<!-- project-forge: end 高风险路径 -->

## 外部易变事实保鲜

`references/` 里有一部分内容会随平台改版过期：字段上限、OIDC 登记窗口、附件要求、
动作版本号。处理方式是**稳定知识与易变知识分开**：

- **稳定的决策链**（什么该做、按什么顺序、失败怎么判）直接写，它不会因为平台改版失效；
- **易变的平台事实**只写「查法 + 官方文档在哪一节」，**不写具体数值快照**。

每一篇参考的末尾都有 `## 事实来源` 一节，说明这份文件里哪些东西会过期、动手前该去哪查。
**用时看一眼**（落盘与发布之前回查官方文档）、**失败驱动**（遇到「字段非法」「无权」时
先回去重核，不要直接重试）、**平时不管**（不要为了追新而制造无意义提交）。

## 改哪看哪

| 这次动了 | 必须一起看 |
| --- | --- |
| `scripts/lib/protocol.mjs` 的标记语法或条件名 | `scripts/lib/template.mjs`、`compose-agents.mjs`、`handoff.mjs`、`review.mjs`、`references/handoff.md` |
| `scripts/lib/template.mjs` 的求值规则 | `templates/agents-project.md` 里每一处 `if`、`scripts/dev/preflight.mjs` 的模板核对 |
| `references/` 里任一判据 | `SKILL.md` 里指向它的那一行（能指就不抄）、`scripts/review.mjs` 的 `ref` 指路 |
| `templates/` 里任一骨架 | 本仓库对应的实例文件（`AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、`.github/` 下那几份） |
| `templates/agents-project.md` | 本仓库的 `AGENTS.md`——它必须由 `compose-agents.mjs` 生成，不许手写后放着不管 |
| `kit/skills/` | 重跑 `node scripts/equip.mjs .` 同步 `.agents/skills/` 并保持 `--check` 通过 |
| `scripts/` 里任一脚本 | `SKILL.md` 的「核心脚本」那节、`scripts/dev/fixtures.mjs` 的正反用例 |
| `README.md` 的结构或能力 | `README.en.md` 成对改，并重跑 `sync-toc` |
| 发布链路的任何一处 | `RELEASING.md`、`docs/release-notes/`、`.github/workflows/release.yml` |

## 取舍

这一节由维护者手写，脚本不碰。**只有使用者能定的那几件事**记在这里，交付体检会把记下的项当作已表态：

```text
- `license`：MIT。这是一个希望被广泛拿来用的工具，宽松授权最省事
- `no-ci`：不适用，本仓库配了 check 与 release 两条流水线
- `no-collab-templates`：不适用，本仓库收外部贡献，模板齐全
- `private`：不适用，本仓库是公开仓库
```

可用的键名会在交付体检的「待定」项里逐条给出；删掉某一项就等于重新待定。
