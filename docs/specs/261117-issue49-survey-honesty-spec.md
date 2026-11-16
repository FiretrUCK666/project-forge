---
kind: spec
title: 勘察与体检的诚实性
status: draft
tier: L3
created: 2026-11-17
updated: 2026-11-17
issue: 49
pr: null
branch: fix/v8-criteria-trust
owner: null
approved: false
implemented: false
plan_critique: pending
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_todo: ../todo/261117-issue49-survey-honesty-todo.md
high_risk_paths:
  - scripts/lib/template.mjs
  - scripts/lib/claims.mjs
  - scripts/review.mjs
---

# SPEC: 勘察与体检的诚实性

## 文档信息与变更概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（`draft \| approved \| implementing \| in_review \| implemented \| superseded`） |
| 规划级别 | `L3` |
| 创建 / 更新 | `2026-11-17` / `2026-11-17` |
| 分支 / Issue | `fix/v8-criteria-trust` / #49 |
| 认领的验收标准 | C4、C5、C6、C7、C8、C9、C10、C11、C12、C22、C23、C27 |

## 系统变更全景

```mermaid
flowchart LR
  In["输入文本"] --> Lex["命令词法切段"]
  Lex --> Cmd["命令位置判定"]
  Cmd --> Facts["勘察事实"]
  Facts --> Compose["契约生成"]
  Compose --> Judge{"算得出来？"}
  Judge -->|算不出| Unavail["不可用，说原因"]
  Judge -->|算得出| Ok["ok + 结论"]
```

| 模块 / 文件 | 变更性质 | 核心职责 |
| --- | --- | --- |
| `scripts/lib/template.mjs` | 改造 | 占位符形状**先校验后替换**；`${{` 宿主语法豁免 |
| `scripts/lib/claims.mjs` | 改造 | `NOT_A_PATH` 增收家目录 / 环境变量 / 盘符 / 绝对路径 |
| `kit/skills/lib/command-lex.mjs` | 新增 | 按 shell 运算符切段，动作词只在命令位置匹配 |
| `scripts/lib/survey-workspace.mjs` | 改造 | 记录行数；工具产物目录排除在规模之外 |
| `scripts/lib/survey-plan.mjs` | 改造 | 四维阈值与 `evidence` |
| `kit/skills/lib/symbol-index.mjs` | 新增 | 多语言符号抽取与 `unsupported` |
| `kit/skills/lib/tdd-parity.mjs` | 改造 | 符号锚点校验（注释不算定义） |
| `scripts/review.mjs` | 改造 | 三态结论；复用 `profile.mjs` 的取舍解析 |
| `scripts/compose-agents.mjs` | 改造 | 多行 `run:` 逐条展开；按生态折叠 |
| `scripts/lib/render.mjs` | 改造 | 折叠阈值常量与「去哪看」的说明 |
| `templates/agents-project.md` | 改造 | 「取舍」节出厂为空 |

## 一、背景与边界声明

- **要改什么**：勘察与体检在多处把「没算出来」显示成「算出来没问题」。五个具体形状：①宿主模板语法被当成未填占位符，让生成直接崩；②家目录与环境变量的根被当成仓库相对路径，报出假缺失；③命令探测被 `--format=` 值与 `.属性名` 误命中，或反过来因为「已识别生态」整条跳过；④工具产物目录（`.agents/`）被算进项目规模，装完套件规模自己涨；⑤`compose` 崩了，`review` 仍盖「结构也完整」。
- **不改什么**：不改勘察的只读性质，不改 `review` 的结论 id 命名空间，不改 `equip` 的备份策略。
- **本期不做**：不引入第三方解析器（零依赖是不变量）；不做 LSP 级语义分析。
- **复用既有模块**：`kit/skills/lib/verdict.mjs`（三态）、`kit/skills/lib/tool-owned.mjs`（工具产物归属）、`kit/skills/lib/profile-sniffer.mjs`（清单嗅探）、`kit/skills/lib/profile.mjs`（取舍解析单一真相源）。
- **架构基线关系**：对齐「单一真相源」与「入口不复述判据」两条不变量；`render.mjs` 仍是排版单一真相源。

## 二、与总控 PRD 的认领映射

本 SPEC 的验收标准**按本文档自己的顺序编号 C1..Cn**（一份文档里的编号必须自洽，C1 永远是它的第一条）；
下表说明它认领了总控 PRD 的哪几条。总控 PRD C4、C5、C6、C7、C8、C9、C10、C11、C12、C22、C23、C27 由本文档负责。

| 本 SPEC | 总控 PRD | 一句话 |
| --- | --- | --- |
| C1 | C4 | 占位符先校验形状再替换，宿主语法豁免 |
| C2 | C5 | 家目录与环境变量根不当仓库相对路径 |
| C3 | C6 | 动作词只在命令位置匹配 |
| C4 | C7 | 工具产物不计入项目规模 |
| C5 | C8 | 规模单调不降，六格矩阵 |
| C6 | C9 | 算不出来不等于算出来没问题 |
| C7 | C10 | 空壳 TDD 判红，符号锚点 |
| C8 | C11 | 工具产物条目为 0 且项目模块必须被认出 |
| C9 | C12 | 取舍节出厂为空 |
| C10 | C22 | 多行 run 逐条展开，无超长单行 |
| C11 | C23 | 命令探测不被 kinds 跳过 |
| C12 | C27 | 命令多时改说「去哪看」 |
## 三、设计方案与契约变更

### 接口 / 数据结构变更

**占位符（`template.mjs`）**

`renderVars` 改为**先扫形状、再替换**，只扫模板正文；`${{ ... }}` 是宿主语法，整段跳过。

**命令词法（新模块）**

```js
splitCommandSegments(cmd) -> string[]   // 按 && || ; | 切段，尊重引号
commandHeadOf(seg)        -> string     // 段首命令名
commandVerbOf(seg)        -> string     // 头之后第一个非选项词
classifyCommandText(text, kinds) -> string | null
```

**规模（`survey-workspace.mjs` / `survey-plan.mjs`）**

`tool-owned.mjs` 的 `TOOL_OWNED_PREFIXES` 决定哪些路径不计入 `codeFiles` / `codeLines`；`EXPLORATION_THRESHOLDS` 四维（`codeFiles` 80、`codeLines` 4000、`modules` 8、`languages` 2）任一超限即 `parallel-subagents`，返回值带 `evidence`。

**三态（`review.mjs`）**

```js
inspectContract() -> { state: 'ok' | 'unavailable', health, error }
```

`state === 'unavailable'` 时产出 `agents.unavailable`（level `missing`），**不得**产出 `agents.ready`。

**失败时如何降级**：`catch` 一律返回 `unavailable` 并带原因；空数组不再被当作「全部通过」的同形值。

### 影响范围

- 预计涉及文件：`scripts/lib/template.mjs`、`scripts/lib/claims.mjs`、`kit/skills/lib/command-lex.mjs`(new)、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-plan.mjs`、`kit/skills/lib/symbol-index.mjs`(new)、`kit/skills/lib/tdd-parity.mjs`、`scripts/review.mjs`、`scripts/compose-agents.mjs`、`scripts/lib/render.mjs`、`templates/agents-project.md`

## 四、冻结的验收标准

- [ ] C1: 变量值含宿主模板语法时 `renderVars` 正常返回；宿主模板语法出现在模板正文里时也放过；模板正文里未登记的全大写占位符、缺取值的占位符、形状不对的占位符三类**仍必须抛错**；含宿主模板语法的仓上 `compose-agents.mjs --check` 退出码不得为 2。
- [ ] C2: 家目录根（`~/`、`~user/`）与环境变量根（`$HOME/`、`${HOME}/`、`%VAR%\`）、盘符与绝对路径**一律不作为仓库相对路径**报缺失；反向：真实的仓库相对路径照常校验，缺失时仍报。
- [ ] C3: 命令按 shell 运算符切段（尊重引号），动作词**只在命令位置**匹配；`--format=` 的取值与 `.属性名` 不得被误判成动作；单条命令展示长度上限与 C22 复用同一常量（500 字节），超限时标出总字节数。
- [ ] C4: 装套件前后 `codeFiles` 与 `tier` **完全相同**；只加空的 `docs/prd/.gitkeep` 之类骨架文件不改变重入判定；**加了真实内容才改变**；`codeLines` 不随工具产物变化。
- [ ] C5: `tier` 随真实规模单调不降——**用 6 格矩阵验「任意两格对比都成立」**（500/2000/3950/4050/30000/28000 行）；28000 行 / 40 文件的仓判 `parallel-subagents`；同一份仓连跑两次 `survey`，`explorationStrategy` 逐字相同；改一个模块的行数使规模跨档后，`survey` 要**报出策略变化及其依据**（各维取值）；策略写入 `AGENTS.md` 受管区，重入时比对而不是默默重算。
- [ ] C6: `compose` 退出码非 0 时 `review` 的 agents 段不得出现「结构也完整」，必须出现 `agents.unavailable` 并带原因；反向：`compose` 正常时结论仍为「结构完整」。
- [ ] C7: 空壳 TDD（只列模块名）、4 行 TDD、模板原样（含占位符）、文件完全不存在但有代码——**四种全部判红**（判红的命令与退出码要写进对应 SPEC：「`tdd-parity` / `govern-docs` 的非零退出码 + 具体 finding id」）；**存量仓宽限**：首次上线时先只报 `notice`，宽限期结束（下一个次版本发布）后转为阻断；TDD 里点名的符号在源码里不存在判红；真读过的 TDD（符号全命中）判绿；**反向：只在注释里出现的符号名不得被当成「已定义」**。
- [ ] C8: `reusableModules` 与 `entrypoints` 里属于工具产物目录的条目数**必须为 0**；**反向：项目自己的模块必须被认出来**——一个只有项目源码的仓，`reusableModules` 不得为空；PowerShell 的 `function Foo {`、Bash 的 `foo() {`、Go 的 `func bar()` 三种写法符号抽取分别命中；遇到没有符号规则的语言返回 `unsupported` 而**不是空数组**；`survey` 能报出「本仓 N 种语言，其中 M 种缺少符号规则」。
- [ ] C9: 模板的「取舍」节**出厂为空**，不含预填的 `license` / `no-ci`；0 业务文件、完全空目录里生成契约不报「缺 LICENSE / 缺 CI」之类的噪音；**反向**：真实缺项在有业务文件时照常报。
- [ ] C10: 默认 CI 形状下 `compose-agents` 的生成路径**退出码 0**；「构建与验证」代码块里没有单行超过 500 字节的命令；命令体积不再由压平成一行产生。
- [ ] C11: 任何 `kinds` 下 `survey` 都必须读 CI / Makefile / Taskfile 里被真实执行过的命令，不得因「已识别生态」而整条跳过；主 Agent 在主工作区直接改文件时，`flow next` 或 `inspect` 要能报出固定标记 `WARN_WORKING_IN_MAIN_CHECKOUT`（它是警告不是拦截，退出码仍为 0）；`equip` 与 `compose-agents` 档位不一致要被拦下。
- [ ] C12: 当真实命令多到逼近 30KB 上限时，契约**改为「去哪看」而不是「全抄一遍」**：命令按生态分组、每类只展示前若干条、其余指向 CI 文件与 Makefile 的路径；**反向**：分组之后「构建与验证」仍必须包含**每类至少一条真实命令**，不得退化成空节或纯指针。

## 五、高风险点、门型与回滚路径

- **门型与回滚路径**：`one-way`。门禁语义变更，判松了不会当场失败。回退方式：`template.mjs` / `claims.mjs` / `review.mjs` 的改动可逐文件反向提交；新增模块（`command-lex.mjs`、`symbol-index.mjs`）删除即可，不影响既有调用（调用点同批回退）。
- **故障注入预演**：I22c（catch 返回与成功同形的值）、I80（折叠退化成空节）、I81/I82（PRD 分级与无主切片）。已有 I70（断言正则混入 `test(`）等覆盖符号层。

## 实现说明

<!-- 在合并之前补齐真实实现摘要与验证结果 -->
