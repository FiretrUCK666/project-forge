# 协作流程、权限防线与审查收敛

## 何时读本文件

日常改代码、接 Issue 或处理 PR、识别贡献者与只读克隆身份、组织独立审查或执行合并与清理收尾前，读完本文件（日常运行自动化动作交由 `.agents/skills/` 中对应脚本落地）。

## 一、先判角色（双轴五态，不靠猜）

先核对本地远端、声明源仓库与写权限（`survey.mjs` 与 `flow.mjs inspect` 自动判定），不得靠直觉默认按维护者推代码：

| 身份状态 | 判定事实 | 推送目标与 PR 规则 | 禁止与降级行为 |
| --- | --- | --- | --- |
| `local-only` / `generic-git` | 无远端、`.git/pf-local-mode` 或未匹配注册表远端 | `local-only` 本地提交并经隔离试合合并；`generic-git` 推远端自建 MR，**合并须先在远端完成并带 `--remote-merged`**（禁止本地越权强合主干） | 跳过 GitHub PR 接口调用，账本记本地 |
| `maintainer` | `origin` 与声明源一致且拥有写权限（含单人所有者与同源团队/组织多位写权限协作者） | 公开/私有仓均直接同源独立特性分支 -> 门禁 -> 推自己分支 -> 开 PR（非 Fork） -> 独立审查 -> 合并 | **严禁直推受保护主干、严禁私自打标签或发版** |
| `contributor-fork` | 存在不同 `upstream` 或 `origin` 为自身 Fork | **只推自己 `origin`**，向 `upstream` 开跨仓 PR；合并前不删 Fork 分支 | **严禁推 `upstream`、严禁自合/打标签/发版**；写标签遇 403 自动降级为评论/本地账本 |
| `clone-readonly` | 克隆他人正本且无写权限（防误判维护者） | **未选定去向前先停下**：提示人三选一（建 Fork 贡献 / 独立新建项目 / 写 `.git/pf-local-mode` 转纯本地） | **严禁尝试推送或伪装成维护者** |
| `undetermined` | 缺权限/API 探测依据 | 保守按 `contributor-fork` 安全边界处置 | 不直推主干、不自动发版或改写远端 |
| `inbound-external-pr` | 在维护者仓中审查外部贡献者提进来的 PR | 建只读安全审查位，先过供应链静态扫描再人工确认跑门禁 | 未经人工确认禁用生命周期脚本并阻断自动执行 |

- **多维护者团队协同（`team-collaborator`）四条规则**：
  1. **零历史新成员验权**：刚加入组织/团队、本地尚无提交历史的成员先跑 `survey.mjs --probe-auth` 或 `flow.mjs inspect --probe-auth` 验证写权限并确认 `maintainer`（`collaborationScope: team-collaborator`），避免离线回退保守状态。
  2. **认领防撞车与接管/释放双写**：开工跑 `flow.mjs claim`（自动调用 `listComments` 核对无他人有效 `pf-state` `claim`）写清认领人与分支；接手同事未合分支必须带 `--takeover --reason` 在 Issue 与 PR 双写「接管」评论；放弃认领用 `flow.mjs release --reason` 写释放评论并卸除 `in-progress` 标签。`flow.mjs start --create-issue --title "..."` 可由维护者建单并联动重命名关联文档。
  3. **独立分支与合前同步**：每人保持独立分支，开 PR 前同步默认分支最新提交，遵守 `CODEOWNERS` 与 Merge Queue（若启用），严禁直推主干。
  4. **团队互审**：坚持 `reviewerId !== implementerId` 由同事或独立上下文执行双门与故障注入审查；保守仓可在 `AGENTS.md`「## 取舍」设 `merge-authority: human`。

## 二、五档开工分流与三问定档

日常研发遵循 **8 阶段标准闭环（需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入）**：动手前先由 `dev-explore`（按需走 `quick` / `medium` / `thorough`）产出 `reusableModules` 与 `featureMap` 核实复用基建（收到多个 Issue/PR URL 先由 `flow.mjs inspect` 联查互指与依赖拓扑），再由 `dev-plan` 跑 `doc-plan.mjs triage` 判定档位与**门型（`two-way` 可局部回退 vs `one-way` 不可逆契约/数据/发布）**及分级内审级别：

- **需求澄清与 PRD 双触发**：用户主动要求或勘察发现跨多模块、痛点复杂时主动建议先建总控 PRD（支持 1:N 多切片拆解）；范围或边界不清时**多轮互动提问澄清并持续补全文档，直至消解全部待拍板事项后才交审**。`doc-plan.mjs init` 尊重仓库自有 `docs/templates/*.md` / `.github/*-template.md`，若 `impl` 工作树已存在则直接落盘其中（否则随 `flow.mjs start` 迁入），`critique-pass` 严禁自审（`SELF_CRITIQUE_REJECTED`），批准后按单任务或波次（`--after` / `batch plan`）移交 `dev-flow`。

| 档位 | 适用场景 | 强制产物、分级内审与测试控频 |
| --- | --- | --- |
| **Case 1** | 纯问答 / 错别字 / 单行格式 | **0 文档**，直接改，跑相关校验 |
| **Case 2** | 明确局部缺陷，不改外部契约 | **0 文档**，先写稳定复现失败回归测试再修复（Red-Green）；触及高风险/单向门仍须独立审查 |
| **Case 3** | `L2` 局部功能，不改外部契约 | 按 `templates/docs-todo.md` 建单（含 `复用既有模块`/`本期不做`/`门型与回滚路径`），跑 `doc-plan.mjs audit` 自净化直通 |
| **Case 4** | `L3` 跨模块、接口/契约变更或高风险 | 按 `templates/docs-spec.md`（按需 `docs-prd.md`）+ Todo 建单；经 `audit`（含 Mermaid `16/12` 宽度检查）+ 1–2 轮独立只读 Plan Critique -> 自修 -> `critique-pass` 后交人 `approve`（SPEC 须 `status: approved`，Todo 设 `approved: true`） |
| **Case 5** | 改动与 `docs/TDD.md` 或生效 `SPEC` 冲突 | **阻断编码，先退回更新 `docs/TDD.md`**，同级内审获批后重启 |

**验证优先级、三正交策略与拒绝人肉代理**：坚持形式验证（类型、Schema、`arch-rules`、Mermaid 宽度、静态门禁）与实证验证（真实启动、CLI/接口实测、UI 渲染交互与浅深色截图）**优先于静态读代码挑刺**。用 `flow.mjs next [--probe-auth]` 统一读取唯一合法下一步与三正交风险分档（`low` 纯文档白名单 + 无 CI 时强制独立静态门禁 / `medium` / `high`）；`verify` 写 `<gitCommonDir>/project-forge-flow/tasks/<taskId>/evidence.json` 拦截 `quick --target` 顶替全量门禁，全量 `merge-gate` 仅提交与合前运行 1 次。Case 2/3/4 单任务在隔离 `impl` 位派发 `impl` 子代理；三问留痕写入首次回复、Issue 评论或 `templates/pull-request-template.md`「实现依据」栏，账本存于 `.worktrees/.state/tasks/<taskId>.json`（支持 `status`/`abort`/`next`）。

## 三、三档隔离与 Worktree 共享依赖

| 隔离档位 | 适用条件 | 工作位与规则 |
| --- | --- | --- |
| **第 1 档** | `commits === 0` 且非 `--parallel` | 本地新建特性分支开发（0 提交仓例外） |
| **第 2 档** | **所有有提交历史仓（`commits > 0`）**、并行或 `L2`/`L3` | 建 `.worktrees/impl-<taskId>/`（新分支，迁入规划文档）；跨轮复用同一 `impl` / `review` 槽；`submit` / `review-pack` 先解绑旧 Junction 再同步 `review-<taskId>/` 至最新 `HEAD` 并重挂载依赖（支持 `--reset-review-slot` 清理审查位，**故障注入只在审查位做**）；本地合入须先在临时 `.worktrees/.tmp-merge-*` `--detach` 试合复测后推进干净主干 |
| **第 3 档** | `inbound-external-pr` 外来提案 | 建 `.worktrees/review-pr-<M>/`（detached `FETCH_HEAD`），先过安全扫描 |

**共享依赖、四态判定与防删穿红线**：锁文件按子包独立比对 SHA256 一致时，通过 `.agents/skills/dev-flow/` 内的 `worktree-deps.mjs` 以 Windows Junction / POSIX Symlink 挂载依赖；**若检测到 Workspace 本地包软链或 Python 可编辑 `.venv` 指回主仓，自动拒绝共享并切换为局部隔离**；锁文件变更亦降级独立安装。清理前用 `git cherry` / `git patch-id` 辨识 `merged`、`squash_or_rebase_merged`、`no_own_commits`（先问再清防误删）与 `unmerged` 四态；挂载/卸载均校验 `samePath(main, wt)`，**拆卸 worktree 前必须先仅对链接执行 `unlinkSync` 解绑并问人点头，再 `git worktree remove`**。`.worktrees/` 须已忽略。

## 四、认领、PR 前文档同步与双写节点

- **谁改谁认领、谁推送并提 PR 与关联评论（一任务一 PR）**：`maintainer` 可用 `flow.mjs start --create-issue --title "..."` 自动建单并联动 `syncDocsLifecycle` 重命名文档；**谁改代码谁负责在隔离 `impl` 位跑完 `claim` -> `finalize` -> `verify` -> `submit` 推送分支、创建/复用 PR 并写关联评论**（协调者只做路由与派发，不代提 PR；接管须 `--takeover --reason` 双写 Issue+PR，弃领用 `flow.mjs release`）。若同一任务已有对应 Issue 与 OPEN PR 直接复用，不开第二条；多 Issue 联做先解 `Depends on` / `Blocks` 依赖序；返工永远在原分支追加提交更新同一个 PR，不重排无关文件。
- **PR 提交前文档同步锁（`flow.mjs finalize`）与零脏文件提审**：
  1. 核对关联 Todo 所有 `[ ]` 已完成勾选 `[x]`、填写「完成后的记录」，将关联 `PRD`（`done`）、`SPEC`（`implemented` 并补全「实现说明」）与 `Todo`（`done`/`archived`）一并 `git mv` **成对归档**进 `docs/archive/{prd,specs,todo}/` 并重算互链；若总控 PRD 为 `1:N` 共享（存在未完结子 SPEC/Todo、已归档子 SPEC 或声明多切片/手动归档），默认保留于 `docs/prd/` 维持 `active` 且不写脏其元数据；当全量切片收口且主 PRD `C1..Cn` 全勾选时，带 `--include-master-prd`（`flow.mjs finalize --include-master-prd` / `doc-plan.mjs archive --include-master-prd`）保留原 `issue`/`related_*` 一并归档至 `docs/archive/prd/` 并写入 `ledger.archivedPrdFile` 豁免 `do-not-edit`（返工期间支持 `finalize` 幂等刷新）；
  2. 检查源码模块边界、对外 CLI 或契约变更是否同步更新 `docs/TDD.md` 与 `README*.md` / `AGENTS.md`；
  3. **推送防脏与模板套用**：`submit` 推后**零跟踪文件写回**（仅写账本与评论）；建 PR 前先查 OPEN PR 防重，新建 PR 默认读取 `.github/pull_request_template.md` 注入实证上下文；
  4. **外部 Fork 防污染**：若 `contributor-fork` 且上游未接入 `docs/`，私有规划存于 `.worktrees/.state/private-docs/<taskId>/` 绝不混入 PR diff。
- **六个双写节点**：认领/释放（Issue）、已提 PR（Issue + `Fixes #N`/`refs #N`）、审查退回（PR 与 Issue）、审查通过（PR 与 Issue）、返工已提交（PR 与 Issue，附新 HEAD 短哈希）、已合并（Issue）。`review-pack.mjs record` 按职责区分 PR 完整审查单（四字段 + `对比基线` + `验收标准逐条核对` 表 + `Must Fix` 编号位置/根因/`Should Fix`/`Pre-existing` + `pf-state`）与 Issue 摘要单（`审核退回/通过` + 逐条状态/标签 + `Must Fix` `file:line` 核心原因 + `pf-state`）**实时双写到 PR 与 Issue** 并按裁决贴 `changes-requested` / `reviewed` 标签；`contributor-fork` 设标签遇 403 自动降级仅发评论，离线或 `mcp-delegate` 无直连凭据时会在 `githubSync.delegatedPayloads` 原样吐出各目标完整正文与 `statePayload` 供宿主 MCP 直接双写，绝不阻塞或临场手写变形。含中文/非 ASCII 正文一律先写系统临时目录 UTF-8 文件再以 `--body-file` / JSON 体提交并回读删除临时文件，绝不在命令行直接拼接中文。

## 五、收到别人的 Issue

- 用 `templates/issue-bug-report.md` 与 `templates/issue-feature-request.md` 收齐最小复现条件、环境与预期差异；信息不足先温柔补问，不凭猜测定责，再决定是否按 Case 2..4 认领处理。

## 六、审别人提进来的 PR（含外部供应链门禁）

在向审查位挂载依赖或执行任何测试/构建脚本前，**先执行 `.agents/skills/dev-review/` 内的 `review-pack.mjs --untrusted-scan --pr <M>`**：

- 静态扫描 `base...head` 改动文件与 diff，一旦触碰 `.github/workflows/`、`package.json` 生命周期钩子（`preinstall`/`install`/`postinstall`/`prepare`）、`Makefile`/构建脚本、git hooks（`.husky/`）、`.agents/skills/`、`.gitattributes`、依赖锁文件或测试断言弱化，若未显式传入 `--human-approved-exec`，立即输出 **`BLOCKED_UNTRUSTED_HAZARD` 并以非零退出码硬阻断自动执行**；
- 仅当维护者确认风险并附 `--human-approved-exec`（推荐配合 `--ignore-scripts` 隔离安装）后，才放行进入测试与审查。

## 七、审查循环：怎么才会停

独立审查只依据冻结的验收标准 `C1`、`C2`…、可重放 diff 与实测门禁输出给结论（**禁止自我审查**，`reviewerId === implementerId` 强制拦截），审查记录四字段必须在同一连续段内并排写清：

```text
审查来源: 子代理 / 新会话 / 另一个人（与执行者不是同一个上下文）
逐条标准状态: fail: C1, C4 / pass: C2, C3, C5, C6
故障注入记录: <删了什么 -> 哪条变红 -> 还原后是否绿>
止损记录: <触发了哪条，或「未触发」>
```

- **diff 绑定与双门评估（`review-pack.mjs` 驱动）**：自动将干净 `.worktrees/review-<taskId>/` 推进至待审分支最新 `HEAD`（非外部 PR），按 `git diff <基线>...<HEAD> > d.txt` 导出并核对 SHA256（`--json` 默认返回 diff 摘要与 hunk 索引，传 `--include-diff` 可选全文）；材料包输出 **`behavioralGate`**（测试 + `smoke-verify` 运行实证，以及 UI/视觉文件变更时触发 `visualFilesChanged` 与 `empiricalVisualCheckRequired` 强制核对真实渲染交互与浅深色截图并由 `record --visual-checked` 记账，杜绝人肉代理）、**`structuralGate`**（词法剥离后的立碑履历注释、连续死代码块、压制标记、`arch-rules`、Mermaid `16/12` 宽度与 `>800` 行超大文件）及 **`doorAssessment`**。`flow.mjs merge` 强制校验 `reviewPassed === true && reviewPassedHead === currentHead && lastReview?.headSha === currentHead && !lastReview?.stopLossTriggered` 且 `implRoot` 工作区干净（`verdict: 'changes'` 重置 `reviewPassedHead: null`）。
- **六锁防死循环与园艺规则下沉**：
  1. **实证优先**：形式静态门禁与运行/渲染/交互实证优先于纯静态读代码挑刺；附可执行命令与高风险故障注入清单；
  2. **上下文隔离**：审查上下文只收 `C*`、diff、门禁证据与文档对齐单，隔离实施过程闲聊；
  3. **三级分级与全量首轮**：问题分 `Must Fix` / `Should Fix` / `Pre-existing`；**`Must Fix` 仅限违反已冻结 `C*`、确定性形式门禁失败、或可复现的运行/渲染/交互实证失败，主观偏好或未实证的静态读代码挑刺不得阻塞合入**；第 1 轮必须一次指出全部同类问题；
  4. **轮次视野收窄与独立新上下文**：第 1 轮看全量 diff -> **第 2 轮起永远新建独立 `review` 子代理并在 `review-locks.mjs` 硬锁下复审**：只核前轮未决 `Must Fix`、`prevHead..HEAD` 增量 hunk（±3 行）及 `rebuts`（未改旧行或无文件主观新刺返回 `BLOCKED_OUT_OF_SCOPE_MUST_FIX` 退出码 `2`，非阻塞项改用 `--should-fix` / `--pre-existing`）；
  5. **防越界返工与虚假 `pass`**：同 `HEAD` 原地复审直接拒绝（`BLOCKED_SAME_HEAD_REREVIEW` 退出码 `2`）；同 `C*` 不同文件/摘要按完整指纹精确追踪不误停损；未清失败 `verify`/`--enforce-gates` 阻断虚假 `pass`（`BLOCKED_PASS_WITH_OPEN_BLOCKERS`）；返工支持 `--rebut` 与 `--disposition` 四类统计；
  6. **停损熔断、防绕过与园艺复盘**：同一 `Must Fix` 连续两轮未收口或达 **3 轮**上限触发 `STOP_LOSS_ESCALATE`；历史已停损未解锁时硬拒 Round 4+ `pass`/`changes` 绕过（退出码 `4`）；人类裁决（`override --human-approved --reason` 配 `merge --human-approved --reason`）方可解锁；`flow verify` / `review-pack record` / `flow rework` 自动写入 `<gitCommonDir>/project-forge-govern/signals.jsonl`，由 `govern-audit.mjs retro [--task] [--apply-patches]`（配合基线增量、`record`/`cluster` 满 `2` 次下沉静态门禁、`sample` 抽检）闭环压低熵增。

## 八、谁能合

按**能不能撤回（双向门 `two-way` vs 单向门 `one-way`）**分档，不按「是不是对外」一刀切：**推自己的分支与开 PR 都能撤回，属于日常**；合并默认分支、发版、改可见性、改写历史撤不回来，严格按以下规则执行：

| 改动类型 | 合并权限 | 前置条件 |
| --- | --- | --- |
| 普通改动 / 外部 PR | **审查者直接合**（`contributor-fork` 等上游维护者合） | 独立审查 `fail` 为空 + `reviewPassedHead === HEAD` + 远端 CI checks 变绿（若有）+ 双门实测证据；外部 PR 先过 `--untrusted-scan` |
| 触碰「高风险路径」任一处 | **审查者直接合** | 独立上下文审查（`reviewerId !== implementerId`）+ 远端 CI checks 变绿（若有）+ 真实故障注入记录 |
| **弱化门禁**（删测试、放宽断言、加跳过、改松 CI）或解锁停损 | **必须人点头** | `flow.mjs merge` 检测到弱化门禁默认以退出码 `4` 阻断，必须明确传 `--human-approved` |

注：发版、改仓库可见性与改写已推送历史永不自动；若项目 `AGENTS.md`「## 取舍」写明 `merge-authority: human`，则全部 PR 的最终合并均收回人手。

## 九、合并：收尾七步

### 合并收尾：固定七步，顺序不能调

1. **把要写的东西写完，并纳入这次 PR**：Todo 文档归档进 `docs/archive/todo/` 与「完成后的记录」、验收标准全部勾选、`docs/specs/` 标为 `implemented` 并与关联 `PRD` 成对归档进 `docs/archive/`、断点写成「已完成，无遗留」。**提交进同一个分支**——合并之后再改库内文件就得另开只改记录的 PR；
2. 合并 PR（**不勾选自动删分支**）；
3. 回读确认 `state=MERGED`；
4. `git switch <默认分支> && git pull`；
5. **先卸 worktree**：`git worktree remove <路径>`（先用共享依赖脚本解绑 junction/symlink 再删目录；分支仍被检出时下一步必败）；
6. **再删本地分支**：`git branch -d <分支>`（不是 `-D`）；
7. **删远端分支之前查两件事**：远端还在不在（`git ls-remote --heads origin <分支>`）、有没有下游堆叠 PR 以该分支为 base，以及 Fork 场景上游 PR 是否仍 `OPEN`；**两件都清了才** `git push origin --delete <分支>`。

**第 5 步之前先把要删的清单列出来问一次**：明确汇报哪个 worktree、哪条本地分支、哪条远端分支以及「干净的」是哪几项；**问到人点头才删**（对应带 `--confirm` 执行清理），绝不私自自动清理或绕过确认（`contributor-fork` 在上游 PR 仍 `OPEN` 时硬锁禁止删分支）。
