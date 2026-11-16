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

- **文档关系说明**：本 PRD 是四个 Issue 的治理总纲，冻结产品级验收标准 `C1..C12` 与波次依赖。逐条技术方案由四份独立 SPEC 与配套 Todo 落地并互链追溯。

## 一、要解决的问题

这套工具的核心承诺是「判据可信」——它报告的事实，读的人可以据此行动。实测发现这个承诺在三层同时失效，而且失效方式一致：

**它只校验形状，不校验指称。**

形状是「文件在不在、名字出现没出现、标记成不成对」，指称是「你说的那个东西，在源码里真的存在吗、真的是那样吗」。形状可以被编造，指称不能。

三种具体表现：

1. **判据算错**（#49）：把结构化文本当纯字符串处理，于是 GitHub Actions 的 `${{ }}` 打崩模板渲染、`~/x.y` 被当成仓内路径、`--format=` 被当成 lint 命令；判据读自己的产物，于是装完套件的仓被判成「大型并行仓」；失败被塌缩成通过，于是模板崩了的同一刻体检说「结构也完整」。
2. **流程退化成「AI 记得就做」**（#50）：本该由脚本执行的步骤没有接线——问过的问题永远重问、`ci-check` 的 `create` 没有任何执行器、治理本身建不出 PRD、并行卡在 `ambiguous`。
3. **联动的第三层是空的**（#52）：顺序（L1）与提示（L2）由状态机保证，但身份与内容（L3）全靠 AI 自己填字符串——独立审查可以编一个名字就过，贴的 Issue 只记编号不取正文，贴的 PR 拉不到也报「审查包就绪」。

四条 Issue 之外实测发现三处新缺陷，一并纳入：

- **命令探测整条被跳过**：本仓库 `kinds: ['skill']`，于是 `commands = {}`——有 CI、有十几条真实命令，一条都没读到。
- **分流看措辞不看实质**：一句「把项目治理成规范工程：补文档、配 CI…」被判成 Case 1（0 文档），治理工程绕过 PRD/SPEC/Todo 直接开干。
- **主 Agent 在主工作区直改文件无人拦**：绕过整套隔离与流转，工具一声不吭。

**预期收益**：让「看起来做过了」与「真的做过了」不再长得一样。偷懒与编造从「没人知道」变成「当场红字加非零退出码」。

## 二、范围与非目标

### 本次要做（In Scope）

- 为每条判据立主语：模板变量 / 宿主语法、仓库根 / 家目录根、命令名 / 参数值、项目文件 / 工具产物，各自归档。
- 判据的输入分层：规模类判据只读项目自身事实，不读工具产物。
- 失败与成功用不同表示：三态结论（`ok` / `failed` / `unavailable`），`catch` 分支不得返回 `ok`。
- 产物带可校验锚点：设计文档里点名的符号必须在源码索引里真实定义。
- 把「探索」「分解」变成流程状态：账本字段 + 门禁拦截，而非技能说明书里的一句话。
- 身份与内容拿真凭据：独立审查一次性令牌、Issue 取正文、PR 取不到就硬失败。
- 补上缺失的执行器：`artifactPlan` 的每个 `create` 必须有对应执行入口，否则门禁红。

### 明确不做（Non-Goals）

- 不新增 GitHub 之外的平台适配器（只要求注册表能承载、探测结论如实报出）。
- 不改 `AGENTS.md` 的 30KB 上限与两档（`lightweight` / `full`）划分。
- 不改六锁收敛算法本身。
- 不在 macOS / Linux 上做交叉复现。
- 不调整分片内容、数量与命名。
- 不承诺「AI 永不犯错」：门禁保证的是「编造过不了门」，不是「理解一定正确」。

## 三、复用既有模块

| 模块 | 复用什么 |
| --- | --- |
| `kit/skills/lib/static-gates-lexer.mjs` | 多语言注释剥离，用于「注释里的符号不算已定义」 |
| `kit/skills/lib/workflow-policy.mjs` | `evaluateNextState` 单一入口，波次计划与探索状态挂在这里 |
| `kit/skills/lib/profile.mjs` | 「取舍」解析单一真相源，`survey` 与 `review` 共用 |
| `kit/skills/dev-flow/scripts/flow-batch.mjs` | `check-disjoint` 的写域判定，多任务时据此排波次 |
| `scripts/lib/protocol.mjs` | 标记语法与预算常数，新增契约仍在同一处登记 |
| `kit/skills/lib/verdict.mjs`、`tool-owned.mjs`、`command-lex.mjs` | 本 PRD 期间新增的三套共享契约 |

## 四、关键交互与用户路径

1. **贴一个 Issue 编号，什么都不说**：`flow start --issue N` 取正文写进账本 -> `flow next` 给出唯一合法下一步 -> 子代理在隔离位实施 -> 独立审查拿令牌 -> 审查者合并。用户全程不需要记命令。
2. **治理一个存量项目**：`doc-plan triage` 判 Case 4 -> 建治理 PRD -> 拆 SPEC/Todo -> 按依赖分波次并行 -> 每波门禁全绿才进下一波。
3. **交接给别人或换一个模型**：`flow next` 从磁盘算状态，不依赖会话记忆；`explored` 缺失时合并被拦，跳过探索不再是「没人知道」。

## 五、验收标准

- [ ] C1: 装套件前后 `codeFiles` 与 `tier` 完全相同；只加空 `docs/{prd,specs,todo}/.gitkeep` 不改变 `isReentry`（工具产物不参与项目规模判定）。
- [ ] C2: `tier` 随真实规模单调不降，28000 行 / 40 文件的仓判 `parallel-subagents`；策略写入 `AGENTS.md` 受管区并带各维取值。
- [ ] C3: 变量值含 `${{ }}` 时 `renderVars` 正常返回，模板正文里未登记占位符仍抛错；任意以家目录根或环境变量根写起的带后缀路径不得被当成仓内路径，带点斜杠前缀的仓内真路径必须仍被认出。
- [ ] C4: 命令按 shell 运算符切段、只在命令位置匹配动作词；`git archive --format=zip` 不判 lint、`.Restore` 不判 install；单条命令展示有上限并带总长度。
- [ ] C5: 算不出来时 `review` 产出非 ok 的 finding 且文案说明原因；compose 退出码非 0 时 agents 段不得出现「结构也完整」；静态断言：`catch` 分支不得返回 `state: 'ok'`。
- [ ] C6: 任意名字、任意深度的、指向 worktree 之外的链接被默认检出并拒绝删除；主仓内容在清理后完好；`--force` 只跳脏检查；`--allow-outbound` 精确匹配才放行。
- [ ] C7: TDD 里点名的符号必须在源码索引里真实定义；空壳、4 行、模板原样、文件不存在四种 TDD 全红，真读过的 TDD 全绿；注释里的符号不算已定义；没有符号规则的语言返回 `unsupported` 而非空数组。
- [ ] C8: 账本存在 `explored` 字段，缺失时 `flow merge` 拦截；多任务时 `flow next` 输出波次计划而非 `ambiguous`；空 diff 的 `structuralGate.status` 为 `nothing-to-review`。
- [ ] C9: `survey` 与 `review` 共用同一份「取舍」解析；表态后对应项不再是 `ask-human`；`questions` 非空时输出机器可读的 `NEEDS_HUMAN`。
- [ ] C10: `artifactPlan` 的每个 `create` 都有对应执行入口，落盘后重跑 `survey` 从 `create` 变 `preserve`；没有执行器的 `create` 被门禁拦下。
- [ ] C11: 独立审查需要一次性令牌，同一令牌只能消费一次；无 `implementerId` 时拒绝记录；`--issue` 取正文、`--pr` 无通道时退出码非 0。
- [ ] C12: 治理类输入判 Case 4；`compose-agents` 生成后意图路由表里每个 `SKILL.md` 真实存在；主 Agent 在主工作区直改文件时 `flow next` 报出。

## 六、门型与回滚路径

- **门型判定**：`one-way`（触及全部高风险路径：`scripts/lib/`、`kit/`、`templates/`、`SKILL.md`、`AGENTS.md`，且改变门禁语义）。
- **回滚路径**：每个 Issue 在独立分支与 worktree 实施，合入前可直接丢弃分支或 `abort`；已合入的通过反向提交回退并重跑门禁验证，严禁强推或改写已推送历史。四份 SPEC 相互独立，任一可单独回退。

## 七、待拍板问题

- 待确认：无。四项已拍板：一 Issue 一 SPEC 一 PR；#51 优先于 #49（删数据不可恢复）；符号索引作为新模块不改 `static-gates.mjs` 既有职责；某条性质若证明按 Issue 描述做不到，停下来问而非自选替代方案。
