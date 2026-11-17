---
kind: prd
title: 判据可信化：从校验形状到校验指称
status: draft
created: 2026-11-17
updated: 2026-11-17
issue: null
pr: null
owner: FiretrUCK666
plan_critique: pending
related_spec: null
related_todo: null
---

# PRD: 判据可信化：从校验形状到校验指称

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| in_review \| done \| dropped`） |
| 创建 / 更新 | `2026-11-17` / `2026-11-17` |
| 关联 Issue | #49、#50、#51、#52（治理总纲，拆四份 SPEC 分别落地） |
| 提出方 / 负责人 | FiretrUCK666 |

- **文档关系说明**：本 PRD 是四个 Issue 的治理总纲，冻结产品级验收标准与波次依赖。逐条技术方案由四份独立 SPEC 与配套 Todo 落地并互链追溯。**每条验收标准都注明它来自哪个 Issue 的哪一组**，以便反向核对「四份 SPEC 是否覆盖了本 PRD 的全部 C 项」。

## 一、要解决的问题

这套工具的核心承诺是「判据可信」——它报告的事实，读的人可以据此行动。实测发现这个承诺在三层同时失效，而且失效方式一致：

**它只校验形状，不校验指称。**

形状是「文件在不在、名字出现没出现、标记成不成对」，指称是「你说的那个东西，在源码里真的存在吗、真的是那样吗」。形状可以被编造，指称不能。

三种具体表现：

1. **判据算错**（#49）：把结构化文本当纯字符串处理，于是 GitHub Actions 的 `${{ }}` 打崩模板渲染、家目录写法被当成仓内路径、命令参数值被当成动作词；判据读自己的产物，于是装完套件的仓被判成「大型并行仓」；失败被塌缩成通过，于是模板崩了的同一刻体检说「结构也完整」；产物只校验形状，于是一份 4 行的空壳 TDD 与真读过代码写出的 TDD 等价；探索工具只抓声明行、还把工具自己的代码当成项目的可复用模块推荐出去。
2. **流程退化成「AI 记得就做」**（#50）：本该由脚本执行的步骤没有接线——问过的问题永远重问、`ci-check` 的 `create` 没有任何执行器、治理本身建不出 PRD、并行卡在 `ambiguous`、只读技能被安排去写文件、平台自适应名不副实。
3. **联动的第三层是空的**（#52）：顺序（L1）与提示（L2）由状态机保证，但身份与内容（L3）全靠 AI 自己填字符串——独立审查可以编一个名字就过，贴的 Issue 只记编号不取正文，贴的 PR 拉不到也报「审查包就绪」。

四条 Issue 之外实测发现三处新缺陷，一并纳入：

- **命令探测整条被跳过**：本仓库 `kinds` 为能力目录类，于是 `commands` 为空——有 CI、有十几条真实命令，一条都没读到。（已在实施前修复，PRD 仍冻结判据以便回归）
- **分流看措辞不看实质**：一句「把项目治理成规范工程：补文档、配 CI…」被判成 Case 1（0 文档），治理工程绕过 PRD/SPEC/Todo 直接开干。
- **主 Agent 在主工作区直改文件无人拦**：绕过整套隔离与流转，工具一声不吭。

**预期收益**：让「看起来做过了」与「真的做过了」不再长得一样。偷懒与编造从「没人知道」变成「当场红字加非零退出码」。门禁保证的是「编造过不了门」，不是「理解一定正确」——后一条任何工程手段都保证不了，本 PRD 不作此承诺。

## 二、范围与非目标

### 本次要做（In Scope）

- 为每条判据立主语：模板变量 / 宿主语法、仓库根 / 家目录根、命令名 / 参数值、项目文件 / 工具产物，各自归档。
- 判据的输入分层：规模类判据只读项目自身事实，不读工具产物。
- 失败与成功用不同表示：三态结论（`ok` / `failed` / `unavailable`），`catch` 分支不得返回 `ok`。
- 产物带可校验锚点：设计文档里点名的符号必须在源码索引里真实定义；注释里的符号不算定义。
- 把「探索」「分解」「并发排程」变成流程状态：账本字段 + 门禁拦截，而非技能说明书里的一句话。
- 身份与内容拿真凭据：独立审查一次性令牌、Issue 取正文、PR 取不到就硬失败。
- 补上缺失的执行器：`artifactPlan` 的每个 `create` 必须有对应执行入口，否则门禁红。
- 平台适配如实报出：报出 `providerId` 与 `capabilities`，非 GitHub 远端时提问并给出非 GitHub 发版出口。

### 明确不做（Non-Goals）

- 不新增 GitHub 之外的**具体平台适配器**（只要求注册表能承载、探测结论如实报出）。
- 不改 `AGENTS.md` 的 30KB 上限与两档（`lightweight` / `full`）划分。
- 不改六锁收敛算法本身。
- 不在 macOS / Linux 上做交叉复现。
- 不调整分片内容、数量与命名。
- 不承诺「AI 永不犯错」：门禁保证的是「编造过不了门」，不是「理解一定正确」。

## 三、复用既有模块

以下模块均已存在于仓库，本 PRD 直接复用，不新建重复能力：

| 模块 | 复用什么 |
| --- | --- |
| `kit/skills/lib/static-gates-lexer.mjs` | 多语言注释剥离，用于「注释里的符号不算已定义」 |
| `kit/skills/lib/workflow-policy.mjs` | `evaluateNextState` 单一入口，波次计划与探索状态挂在这里 |
| `kit/skills/lib/profile.mjs` | 「取舍」解析单一真相源，`survey` 与 `review` 共用 |
| `kit/skills/dev-flow/scripts/flow-batch.mjs` | `check-disjoint` 的写域判定，多任务时据此排波次 |
| `scripts/lib/protocol.mjs` | 标记语法与预算常数，新增契约仍在同一处登记 |
| `kit/skills/lib/verdict.mjs` | 三态结论（`ok` / `failed` / `unavailable`）的唯一构造入口 |
| `kit/skills/lib/tool-owned.mjs` | 工具产物归属声明，规模判据据此剔除 |
| `kit/skills/lib/command-lex.mjs` | 命令切段与「动作词只认命令位置」 |

后三者在本次治理的前期已落地并有正反用例覆盖；本 PRD 的职责是**继续把它们接进所有判据**，而不是重新实现。

## 四、关键交互与用户路径

1. **贴一个 Issue 编号，什么都不说**：`flow start --issue N` 取正文写进账本 -> `flow next` 给出唯一合法下一步 -> 子代理在隔离位实施 -> 独立审查拿令牌 -> 审查者合并。用户全程不需要记命令。
2. **治理一个存量项目**：`doc-plan triage` 判 Case 4 -> 建治理 PRD -> 拆 SPEC/Todo -> 按依赖分波次并行 -> 每波门禁全绿才进下一波。
3. **交接给别人或换一个模型**：`flow next` 从磁盘算状态，不依赖会话记忆；`explored` 缺失时合并被拦，跳过探索不再是「没人知道」。
4. **非 GitHub 项目**：`survey` 报出当前远端平台与它的 API 能力，缺什么直接问；发版策略里有「用我自己的流水线」这一出口，文案不提 `RELEASE_TOKEN` 与 `gh release`。

## 五、验收标准

每条注明来源组别，四份 SPEC 必须逐条认领；**任何人可以拿这张表反向核对 SPEC 覆盖率**。

### #51 删穿保护

- [ ] C1（#51 删穿保护 · 核心）worktree 里存在**任意名字、任意深度**、指向 worktree 之外的符号链接时，`cleanup` 默认拒绝删除并退出非 0；把名字换成 `vendor`/`shared`/`data`/`packages`/中文名，行为一致；主仓哨兵文件在 `cleanup` 之后必须仍存在。
- [ ] C2（#51 删穿保护 · 反向，不能误伤）没有任何外链的普通 worktree 照常成功退出 0；外链目标在 worktree **内部**时不影响删除；外链在仓库之外但已被显式逐个列出时，删除正常完成且目标内容完好，**回执里逐条列出解绑了哪条路径、指向哪里**（不是只报个数）；`--force` 只跳过「脏 / 有未跟踪文件」，不跳过外链检查。
- [ ] C3（#51 判据的结构）外链检测**不使用目录名白名单**作为前置条件：实现里不得出现「先按 `node_modules`/`.venv`/`venv` 之类名字筛，再判断是不是链接」的顺序；检测方式是对 worktree 全深度遍历 + 判断是否为链接；`mainDepsIntact` 一类校验的采集范围与删除前扫描范围**必须是同一个集合**；删除后主仓中此前存在的路径仍在。

### #49 A 组 命名空间

- [ ] C4（#49 A-1）变量值含宿主模板语法时 `renderVars` 正常返回；**宿主模板语法出现在模板正文里时也放过**（它不是本工具的占位符）；模板正文里未登记的全大写占位符、缺取值的占位符、形状不对的占位符三类**仍必须抛错**；含宿主模板语法的仓上 `compose-agents.mjs --check` 退出码不得为 2。
- [ ] C5（#49 A-2）家目录根（`~/`、`~user/`）与环境变量根（`$HOME/`、`${HOME}/`、`%VAR%\`）写起的带后缀路径**不得**被当成仓内路径；剥掉点斜杠前缀后的仓内真路径**必须**仍被认出；以父目录相对写法起头、或剥完仍带上级跳转的路径不当作承诺。
- [ ] C6（#49 A-3）命令按 shell 运算符切段（尊重引号），动作词**只在命令位置**匹配；`git archive --format=zip` 不得被判成 lint，属性名 `.Restore` 不得被判成 install，文件名里的 `test` 不得让整段脚本变成测试命令；单条命令展示长度上限与 C22 复用同一常量（500 字节），超限时标出总字节数。

### #49 B / C 组 输入分层与三态

- [ ] C7（#49 B-1、B-2、修法 2）装套件前后 `codeFiles` 与 `tier` **完全相同**；只加空的 `docs/prd`、`docs/specs`、`docs/todo` 骨架文件不改变「重入」判定；静态断言：规模判据的代码里不出现 `.agents/` 路径字面量（排除靠「声明为工具产物」实现，不靠特例）。
- [ ] C8（#49 B-5、修法 3）`tier` 随真实规模单调不降——**用 6 格矩阵验「任意两格对比都成立」**（500/2000/3950/4050/30000/28000 行），不是只验一个点；28000 行 / 40 文件的仓判 `parallel-subagents`；同一份仓连跑两次 `survey`，`explorationStrategy` 逐字相同；改一个模块的行数使规模跨档后，`survey` 要**报出策略变化及其依据**（各维取值）；策略写入 `AGENTS.md` 受管区，重入时比对而不是默默重算。
- [ ] C9（#49 C-1、修法 4）`compose` 退出码非 0 时 `review` 的 agents 段不得出现「结构也完整」；结论算不出来时必须产出**非 ok** 的 finding 且文案直说「这一面算不出来，原因是 X」；静态断言：`catch` 分支不得返回 `state: 'ok'`，禁止用空数组表示失败。

### #49 D 组 指称层

- [ ] C10（#49 D-4、D-7、修法 7）空壳 TDD（只列模块名）、4 行 TDD、模板原样（含占位符）、文件完全不存在但有代码——**四种全部判红**（判红的命令与退出码要写进对应 SPEC：「`tdd-parity` / `govern-docs` 的非零退出码 + 具体 finding id」）；**存量仓宽限**：首次上线时先只报 `notice`，宽限期结束（下一个次版本发布）后转为阻断；TDD 里点名的符号在源码里不存在判红；真读过的 TDD（符号全命中）判绿；**反向：只在注释里出现的符号名不得被当成「已定义」**。
- [ ] C11（#49 D-2、D-3、修法 6）`reusableModules` 与 `entrypoints` 里属于工具产物目录的条目数**必须为 0**；**反向：项目自己的模块必须被认出来**——一个只有项目源码的仓，`reusableModules` 不得为空（只判「工具产物为 0」时，全排除干净 + 项目模块全空心也能过）；PowerShell 的 `function Foo {`、Bash 的 `foo() {`、Go 的 `func bar()` 三种写法符号抽取分别命中；遇到没有符号规则的语言返回 `unsupported` 而**不是空数组**；`survey` 能报出「本仓 N 种语言，其中 M 种缺少符号规则」。
- [ ] C12（#49 D-7）模板的「取舍」节**出厂为空**，不含预填的 `license` / `no-ci`；0 业务文件、完全由工具生成的仓，`review` **不得**输出「没有会出事的缺口」。

### #50 E / F / G 组 状态单一来源、平台自适应、CI 落盘

- [ ] C13（#50 E）`survey` 与 `review` 共用**同一个**「取舍」解析函数（`review.mjs` 里那份逐字相同的副本必须删掉，不留双轨）；写上具体表态后对应项不再是 `ask-human`，具体实例：表态不自动发布后 `ci-release` 不再是 `ask-human`；同一份仓连跑两次 `survey`，`questions` 逐字相同**当且仅当**取舍节没变；`questions` 非空时输出机器可读的 `NEEDS_HUMAN` 标记，不能只是一行 Markdown。
- [ ] C14（#50 F）`survey` 与 `review` 都报出当前远端 `providerId` 与 `capabilities`；**已有远端但非 GitHub 时** `questions` 里出现「平台是哪个 / 要不要配 API 通道」；没有任何 GitHub 远端时 `ci-release` 的 `ask-human` 文案里**不得**出现 `RELEASE_TOKEN` / `gh release`；发版策略有非 GitHub 出口（用自己流水线，只要求 tag 与版本说明同步）；认证缺口在 `--json` 输出里是结构化字段，不只出现在 markdown 正文。
- [ ] C15（#50 G）`artifactPlan` 里每个 `action: create` 都**有对应执行入口**，否则门禁红；落盘后重跑 `survey` 从 `create` 变 `preserve`；没有执行器的 `create` 不许输出。

### #50 H / I / J 组 只读边界、治理即 PRD、账本与并行

- [ ] C16（#50 H）`dev-explore` 的「严格只读」与「写入或校准 TDD」二者**只保留一个**；若保留写入例外，显式写明唯一允许写入的路径与写前备份要求；主流程不再让只读技能承担写入职责。
- [ ] C17（#50 I）治理类输入判 **Case 4**：判据是「这件事会同时碰到几个面」（文档 / CI / 契约 / 目录结构 / 源码 / 工具链），**三面以上即跨模块**；可判形式：同一件事的三种同义改写、以及**完全不含「治理 / 规范化」字样**但跨三面的输入，都必须判 Case 4；写任何治理文件之前先建治理 PRD；**这份 PRD 的 `C1..Cn` 必须覆盖 `artifactPlan` 的每一项**（缺一项即门禁红——这是「治理动作不漏」的判据）；**另一条**：每个 C 项还必须被某份 SPEC 认领（这是「文档互认」的判据，不能替代前一条）；治理 PRD 在重入时可继续追加而非每次重开。
- [ ] C18（#50 J）账本存在 `explored` 字段（含时间、档位、索引符号数）；缺失时 **`flow next` 只给探索这一步**（不能一路做到合并才被拦）、且 `flow merge` 拦截（退出码 4）；`tddSyncWarning` 非空时 `finalize` 退出码非 0（一条不影响任何结果的警告等于没有）；两个以上未闭环任务时 `flow next` 输出**波次计划**（哪些可并行、哪些有依赖）而非「请显式传入 --task」；空 diff 时 `structuralGate.status` 为 `nothing-to-review`，不得是 `clean`。

### #52 联动第三层

- [ ] C19（#52 M）`record` 必须校验由 `flow next` 在待审查阶段生成的**一次性令牌**，同一令牌只能消费一次，round 对不上拒绝；账本里没有 `implementerId` 时**必须拒绝记录**（删掉「空就跳过检查」的分支）；反向：正常换一个真实不同的审查者时流程不受影响。
- [ ] C20（#52 N、O）`flow start --issue N` 在有 API 通道时把标题与正文摘要写进账本与紧凑上下文；无通道时明确报「拿不到正文」且 `next` 提示先去取；`--issue` 与 `--pr` 的「要不要去取」行为**一致**；`review-pack --pr M` 在没有可用通道时退出码非 0，文案说明「拉不到 PR，不能假装审了」；PR 模式下 `diffScope` 必须来自真实 PR 的 base/head，**不得**回退成分支到分支；静态断言：PR 模式下 PR 字段为空时 `status` 不得是就绪态。
- [ ] C21（#52 P）`compose-agents` 生成后，意图路由表里点名的每个 `SKILL.md` 路径**都真实存在**，否则报错；装配档位与生成档位**不一致时**任一方必须拒绝或警告；删掉某个技能目录后（未跑 `equip`），`compose-agents` 要能发现并指出死链。

### 跨组 副产物与流程自证

- [ ] C22（#49 副产物 · P7）默认 CI 形状下 `compose-agents` 的生成路径**退出码 0**；「构建与验证」代码块里没有单行超过 500 字节的命令；命令体积不再由压平成一行产生。
- [ ] C23（流程自证）任何 `kinds` 下 `survey` 都必须读 CI / Makefile / Taskfile 里被真实执行过的命令，不得因「已识别生态」而整条跳过；主 Agent 在主工作区直接改文件时，`flow next` 或 `inspect` 要能报出固定标记 `WARN_WORKING_IN_MAIN_CHECKOUT`（它是警告不是拦截，退出码仍为 0）。
- [ ] C24（规划审核的独立上下文）规划文档（PRD / SPEC / Todo）的 Critique **Round 2 及以后必须由新建的独立子代理执行**，与代码审查同一条规矩；`doc-plan critique-pass` 必须能识别「这一轮的复核人就是上一轮的复核人」并拒绝，而不是只比较「复核人是否等于文档负责人」；反向：换一个真正新建的复核人时流程不受影响。
- [ ] C25（文档兄弟集的认亲方式）同一件事的 PRD / SPEC / Todo 必须被认作一个兄弟集，**且判定不能依赖「同一天创建」**：今天建 PRD、明天建 SPEC 时，`issue` / `branch` / `owner` / `status` 仍要双向同步；写在其中一份上的 Issue 编号要能被其余几份读到；反向：确实属于两件事的同名 slug 不得被误合并。
- [ ] C26（文档模板的通用性）四层规划文档的模板必须是「通用主干 + 可扩展章节」，而不是七节固定表单：任何项目（App、数据管道、论文、硬件、SaaS、纯文档站）都能在**不改工具代码**的前提下写出合身的 PRD/SPEC/Todo；项目自定义章节与工具生成的章节共存且不互相覆盖；`audit` 只强制**与项目形态无关的最小核心**（做什么、不做什么、怎么判定完成），其余章节的存在性由项目自己的模板声明，而不是工具写死；反向：自定义模板不能变成「什么都不用写」的免检通道。
- [ ] C28（需求分级判据：装不装得进一份 SPEC）规划分流必须能判出「这件事大到一份 SPEC 装不下」：同时碰四面以上、需求自己说了要分批、声明要动 12 个以上文件，三条任一条成立就必须先写总控 PRD 再拆 SPEC + Todo；`triage` 输出 `prdRequired` 与判定依据；**反向**：只碰一两面的小需求不得被判进来（每件小事都要求先写 PRD，人会直接绕过整套流程）；**事后兜底**：`docs/specs/` 里有两份以上生效 SPEC、却没有任何 PRD 被两份以上 SPEC 共同认领时，`audit` 必须报 `ORPHAN_SLICES_NO_MASTER_PRD`——否则「每份 SPEC 各自勾完都绿、整体算不算做完没人管」是一种完全合法的状态。
- [ ] C27（体积与可读性的取舍，对应「待拍板问题」第 4 项）当真实命令多到逼近 30KB 上限时，契约**改为「去哪看」而不是「全抄一遍」**：命令按生态分组、每类只展示前若干条、其余指向 CI 文件与 Makefile 的路径；反向：分组之后「构建与验证」仍必须包含**每类至少一条真实命令**，不得退化成空节或纯指针。

## 六、门型、回滚路径与波次依赖

- **门型判定**：`one-way`（触及全部高风险路径：`scripts/lib/`、`kit/`、`templates/`、`SKILL.md`、`AGENTS.md`，且改变门禁语义）。
- **回滚路径**：每个 Issue 在独立分支与 worktree 实施，合入前可直接丢弃分支或 `abort`；已合入的通过反向提交回退并重跑门禁验证，严禁强推或改写已推送历史。四份 SPEC 相互独立，任一可单独回退。

### 波次依赖与写域（决定谁能并行）

写域一律写**从仓库根算起的完整相对路径**——`check-disjoint` 按路径比写域，短名（`review-pack.mjs`）在六个不同目录里都有同名文件时无法判定重叠。

| 波次 | 覆盖的 C | 写域（完整相对路径） | 为什么这个顺序 |
| --- | --- | --- | --- |
| 0 | C4、C5、C6 的形状部分；C9 的三态构造器 | `kit/skills/lib/verdict.mjs`、`kit/skills/lib/tool-owned.mjs`、`kit/skills/lib/command-lex.mjs`、`kit/skills/lib/ledger.mjs`、`scripts/lib/protocol.mjs` | 后面每一波都消费这几个形状，先定死防撞 |
| 1 | C1、C2、C3、C4、C5、C6 | `kit/skills/dev-flow/scripts/worktree-deps.mjs`、`kit/skills/dev-flow/scripts/flow-cleanup.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`；右列为 `scripts/lib/template.mjs`、`scripts/lib/claims.mjs`、`scripts/lib/survey-ecosystem.mjs`、`kit/skills/lib/profile-sniffer.mjs` | 两列写域零重叠；删数据不可恢复，排最前 |
| 2 | C7、C8、C9、C22、C27、C28；C19、C20、C21 | `scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-reentry.mjs`、`scripts/lib/survey-plan.mjs`、`scripts/review.mjs`、`scripts/compose-agents.mjs`、`templates/agents-project.md`、`AGENTS.md`、`scripts/lib/render.mjs`、`kit/skills/lib/doc-requirements.mjs`(new)、`kit/skills/lib/handoff-package.mjs`(new)；右列为 `kit/skills/dev-review/scripts/review-ledger.mjs`、`kit/skills/dev-review/scripts/review-pack.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/ledger.mjs` | 审查令牌与 Issue 取正文都要改 `flow next` 的行为，与三态分层同波必须错开列——**因此 `flow-next.mjs` 的共享窗口从「只许 0/4」改为「波次 2 一次 + 波次 4 一次」** |
| 3 | C10、C11、C12、C13、C14、C15 | `kit/skills/lib/symbol-index.mjs`(new)、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/lib/tdd-parity.mjs`、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`scripts/survey.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/review.mjs`、`templates/agents-project.md`、`scripts/equip-ci.mjs`(new)、`kit/skills/lib/profile.mjs`；右列为 `scripts/lib/platform/registry.mjs`、`templates/ci-release.yml`、`templates/ci-check.yml` | 指称层依赖波次 2 的分层结果；`review.mjs` 与 `templates/agents-project.md` 在波次 2 与 3 各改一次，中间必须重跑全量门禁 |
| 4 | C16、C17、C18、C23 | `SKILL.md`、`kit/skills/dev-explore/SKILL.md`、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`kit/skills/lib/workflow-policy.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs` | 依赖波次 3 的探索证据与产物计划 |
| 5 | C26 + 文档同步（C24、C25 已落地，这里只做回归确认） | `kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/lib/docs.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/templates/docs-prd.md`、`kit/skills/templates/docs-spec.md`、`kit/skills/templates/docs-todo.md`、`docs/TDD.md`、`README.md`、`README.en.md`、`AGENTS.md`、`references/` | 规划审核独立上下文与文档模板通用性都落在规划链，只有总控能同时看全四份改动 |

**跨波共享文件的纪律**（写成规则，不写死清单）：

1. 一个文件被两波点名时，**前一波必须已经合入并通过全量门禁**，后一波才允许改它；
2. 同一个波次内两列**不得出现同一个文件**——`flow.mjs batch check-disjoint` 就是判这个；
3. 新增共享文件时把它登记进本表，不登记就不许改。

当前刻意跨波的有七处，每一处都有 `C` 项要求在同一文件里落两件事，拆不开但必须串行：`scripts/review.mjs`（波次 2 与 3）、`templates/agents-project.md`（波次 2 与 3）、`kit/skills/dev-flow/scripts/flow-next.mjs`（波次 2 与 4）、`kit/skills/lib/workflow-policy.mjs`（波次 2 与 4）、`kit/skills/lib/ledger.mjs`（波次 0 与 2）、`AGENTS.md`（波次 2 与 5）、`kit/skills/dev-plan/scripts/doc-plan.mjs`（波次 4 与 5）。

### 每条 C 的当前状态

四份 SPEC 不许重复认领已完成的部分。状态以提交历史为准，拆 SPEC 前必须重新核对一次：

| 状态 | 覆盖的 C |
| --- | --- |
| 已实现（有回归用例） | C1、C2、C3、C4、C5、C6、C9、C15、C22、C24、C25、C27、C28 |
| 部分实现 | C7（缺「`codeLines` 不随工具产物变化」的断言）、C8（6 格矩阵已落地，缺「依据变化要报」与「写入 `AGENTS.md` 受管区」）、C11（两条都没做到：`repo-map` 仍把 `.agents/skills/lib/*` 当可复用模块；「项目模块必须被认出」也未验）、C13（副本已删；真缺的是 `NEEDS_HUMAN` 机器可读标记，以及 `computeArtifactPlan` 不读取舍集合）、C19（令牌已落地，SKILL.md 已补用法）、C20（PR 硬失败已落地；缺 `compactContext` 里的 issueContext 与「重跑 start 清标记」）、C23（命令探测已修、主工作区直改已报 `WARN_WORKING_IN_MAIN_CHECKOUT`；缺「档位不一致要拦下」） |
| 未开始 | C10、C12、C14、C16、C17、C18（`explored` 字段已落地，缺「只给探索这一步」与 `finalize` 退出码）、C21、C26 |

## 七、待拍板问题

以下八项是产品级取舍，只有使用者能定。**未定了不进入 SPEC 拆解。**

1. **#50 F 组做到哪一步**：只做到「如实报出 providerId 与 capabilities + 非 GitHub 时提问」，还是也包括「非 GitHub 的发版出口」？后者与「不新增平台适配器」的非目标相邻，边界要人定。
   - 建议：**两者都做**。发版出口是文案与策略选项，不是适配器；它让 GitLab / Gitea 用户不必看着 GitHub 专用命令。
2. **模板「取舍」节清空后的噪音**：清空之后，所有新仓的 `review` 会开始报「缺 LICENSE / 缺 CI」。这是**真实状态**，但噪音会上升。
   - 建议：**接受**。正确做法是让这些项落在「待定」档而不是「缺」档——它们本来就该由人表态，不该由模板代答。
3. **#50 H 组二选一**：删掉「写 TDD」让 `dev-explore` 彻底只读，还是保留「唯一允许写 `docs/TDD.md` + 写前备份」的例外？
   - 建议：**彻底只读**。写入交给 `dev-govern` 或 `equip` 的初始化路径；一个叫「只读」的技能拥有写权限，是所有误判的来源。
4. **命令探测修好后的体积压力**：能力目录类仓的「构建与验证」会新增十余条真实命令，逼近 30KB 上限，与「不改 30KB 上限」的非目标相冲。
   - 建议：**不改上限，改渲染**。命令按生态分组并只展示每类前若干条 + 指向 CI 文件，让契约说「去哪看」而不是「全抄一遍」。对应判据见 C27。
5. **CI 落盘的触发时机**：C15 会往用户仓写 `.github/workflows/`。是「勘察发现缺就自动建」，还是「只在人确认后建」？
   - 建议：**只在人确认后建**。`equip` 的定位是「只读先行、写前备份」，自动往用户仓塞工作流与那个定位相冲；`artifactPlan` 负责说「缺」，执行器负责「人点头后建」。
6. **主 Agent 在主工作区直改文件是警告还是拦截**：C23 要求报出来，但报出来之后呢？
   - 建议：**警告 + 不阻断**。这是「绕过隔离位」的早期提示，拦死会把正常的小改动也堵住；真正的硬拦留在 `merge`（C18）。
7. **C26 把 `doc-audit` 的强制章节降为「最小核心」是实质放宽门禁**：按本仓契约「仅弱化门禁须人点头」，这一条必须先拍板再落。
   - 建议：**接受这次放宽**。理由不是「为了通用性」，而是原来那七节**从来不是门禁，只是模板**：强制七节让数据管道、论文、硬件仓写不了合身的文档，人只能绕过流程。收紧到三节之后门禁**更硬**了（主干三节不可豁免，而以前自定义模板只要「有模板」就能过）。这是把一条假门禁换成一条真门禁，不是弱化。
   - 配套：反向条件已落地——自定义模板不能把主干三节减掉，`CORE_SECTION_WAIVED` 会拦。
8. **C10 的新门禁对存量仓是否追溯**：符号锚点门禁上线后，一批只列了模块名的存量 TDD 会立刻变红。
   - 建议：**追溯，但给一次宽限**。首次在本仓跑只报 `notice` 不阻断，宽限期内改完；宽限期结束（下一个次版本发布）转为阻断。不给宽限会让所有人同时红，给永久宽限等于没有这条判据。
