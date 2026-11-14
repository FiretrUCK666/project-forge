# 协作流程、权限防线与审查收敛

## 何时读本文件

日常改代码、接 Issue 或处理 PR、识别贡献者与只读克隆身份、组织独立审查或执行合并与清理收尾前，读完本文件（日常运行自动化动作交由 `.agents/skills/` 中对应脚本落地）。

## 一、先判角色（双轴五态，不靠猜）

先核对本地远端、声明源仓库与写权限（`survey.mjs` 与 `flow.mjs inspect` 自动判定），不得靠直觉默认按维护者推代码：

| 身份状态 | 判定事实 | 推送目标与 PR 规则 | 禁止与降级行为 |
| --- | --- | --- | --- |
| `local-only` / `generic-git` | 无远端、`.git/pf-local-mode` 或未匹配注册表远端 | 本地分支提交（`generic-git` 可推远端自建 MR），高风险改动照样走独立审查 | 跳过平台 REST/PR 接口调用，账本记本地 |
| `maintainer` | `origin` 与声明源一致且拥有写权限（含单人所有者与同源团队/组织多位写权限协作者） | 公开/私有仓均直接同源独立特性分支 -> 门禁 -> 推自己分支 -> 开 PR（非 Fork） -> 独立审查 -> 合并 | **严禁直推受保护主干、严禁私自打标签或发版** |
| `contributor-fork` | 存在不同 `upstream` 或 `origin` 为自身 Fork | **只推自己 `origin`**，向 `upstream` 开跨仓 PR；合并前不删 Fork 分支 | **严禁推 `upstream`、严禁自合/打标签/发版**；写标签遇 403 自动降级为评论/本地账本 |
| `clone-readonly` | 克隆他人正本且无写权限（防误判维护者） | **未选定去向前先停下**：提示人三选一（建 Fork 贡献 / 独立新建项目 / 写 `.git/pf-local-mode` 转纯本地） | **严禁尝试推送或伪装成维护者** |
| `undetermined` | 缺权限/API 探测依据 | 保守按 `contributor-fork` 安全边界处置 | 不直推主干、不自动发版或改写远端 |
| `inbound-external-pr` | 在维护者仓中审查外部贡献者提进来的 PR | 建只读安全审查位，先过供应链静态扫描再人工确认跑门禁 | 未经人工确认禁用生命周期脚本并阻断自动执行 |

- **多维护者团队协同（`team-collaborator`）四条规则**：
  1. **零历史新成员验权**：刚加入组织/团队、本地尚无提交历史的成员先跑 `survey.mjs --probe-auth` 或 `flow.mjs inspect --probe-auth` 验证写权限并确认 `maintainer`（`collaborationScope: team-collaborator`），避免离线回退保守状态。
  2. **认领与分支接管双写**：开工跑 `flow.mjs claim` 写清认领人与分支；接手同事未合分支前须在 Issue 与 PR 双写「接管」评论（注明接手人、分支与 HEAD）。
  3. **独立分支与合前同步**：每人保持独立分支，开 PR 前同步默认分支最新提交，遵守 `CODEOWNERS` 与 Merge Queue（若启用），严禁直推主干。
  4. **团队互审**：坚持 `reviewerId !== implementerId` 由同事或独立上下文执行双门与故障注入审查；保守仓可在 `AGENTS.md`「## 取舍」设 `merge-authority: human`。

## 二、五档开工分流与三问定档

动手前先由 `dev-explore`（按需走 `quick` / `medium` / `thorough`）产出 `reusableModules` 与 `featureMap` 核实复用基建，再跑 `doc-plan.mjs triage` 判定档位与**门型（`two-way` 可局部回退 vs `one-way` 不可逆契约/数据/发布）**及分级规划内审级别：

| 档位 | 适用场景 | 强制产物、分级内审与测试控频 |
| --- | --- | --- |
| **Case 1** | 纯问答 / 错别字 / 单行格式 | **0 文档**，直接改，跑相关校验 |
| **Case 2** | 明确局部缺陷，不改外部契约 | **0 文档**，先写稳定复现失败回归测试再修复（Red-Green）；触及高风险/单向门仍须独立审查 |
| **Case 3** | `L2` 局部功能，不改外部契约 | 按 `templates/docs-todo.md` 建单（含 `复用既有模块`/`本期不做`/`门型与回滚路径`），跑 `doc-plan.mjs audit` 自净化直通 |
| **Case 4** | `L3` 跨模块、接口/契约变更或高风险 | 按 `templates/docs-spec.md`（按需 `docs-prd.md`）+ Todo 建单；经 `audit`（含 Mermaid `16/12` 宽度检查）+ 1–2 轮独立只读 Plan Critique -> 自修 -> `critique-pass` 后交人 `approve`（SPEC 须 `status: approved`，Todo 设 `approved: true`） |
| **Case 5** | 改动与 `docs/TDD.md` 或生效 `SPEC` 冲突 | **阻断编码，先退回更新 `docs/TDD.md`**，同级内审获批后重启 |

**验证优先级、实证取证与拒绝人肉代理**：坚持形式验证（确定性静态检查：类型、Schema、`arch-rules`、Mermaid 宽度、静态规则门禁）与实证验证（真实启动运行、CLI/接口实测、UI/视觉改动实际打开渲染走通交互并核对浅深色截图）**优先于纯对抗式静态读代码挑刺**。编码期每轮运行 `{target}` 快测，涉及运行时入口追加 `flow.mjs verify --mode smoke` 拿端到端证据（涉及 `.tsx`/`.jsx`/`.vue`/`.svelte`/`.html`/`.css`/`.scss`/`.svg` 时补充真实渲染交互与浅深色截图核验并记 `--visual-checked`；`Dev Profile` 显式配置 `none` 时视为合法禁用态），全量 `merge-gate` 仅提交 PR 与合并前运行 1 次；中途触碰高危自动升级。独立审查与三问留痕写入首次回复、Issue 评论或 `templates/pull-request-template.md`「实现依据」栏，账本存于 `.worktrees/.state/tasks/<taskId>.json`（五套脚本支持从当前 worktree/分支/唯一活跃账本自动推断 `--task`，新增 `flow.mjs status` 与 `abort`）。

## 三、三档隔离与 Worktree 共享依赖

| 隔离档位 | 适用条件 | 工作位与规则 |
| --- | --- | --- |
| **第 1 档** | `L1` 小改动且主工作区干净 | 本地新建特性分支就地开发 |
| **第 2 档** | `L2`/`L3`、接 Issue、脏主仓或并行任务 | 建 `.worktrees/impl-<taskId>/`（新分支，保留并迁入匹配规划文档）；`flow.mjs submit` 与 `review-pack --task` 自动将干净 `.worktrees/review-<taskId>/` 同步检出至待审分支最新 `HEAD` 并挂载依赖（杜绝旧 `baseSha` 空 Diff 假审，**故障注入只在审查位做**） |
| **第 3 档** | `inbound-external-pr` 外来提案 | 建 `.worktrees/review-pr-<M>/`（detached `FETCH_HEAD`），先过安全扫描 |

**共享依赖、四态判定与防删穿红线**：锁文件按子包独立比对 SHA256 一致时，通过 `.agents/skills/dev-flow/` 内的 `worktree-deps.mjs` 以 Windows Junction / POSIX Symlink 挂载依赖；**若检测到 Workspace 本地包软链或 Python 可编辑 `.venv` 指回主仓，自动拒绝共享并切换为局部隔离**；锁文件变更亦降级独立安装。清理前用 `git cherry` / `git patch-id` 辨识 `merged`、`squash_or_rebase_merged`、`no_own_commits`（先问再清防误删）与 `unmerged` 四态；挂载/卸载均校验 `samePath(main, wt)`，**拆卸 worktree 前必须先仅对链接执行 `unlinkSync` 解绑并问人点头，再 `git worktree remove`**。`.worktrees/` 须已忽略。

## 四、认领、PR 前文档同步与双写节点

- **谁改谁认领、一任务一 PR**：执行 `flow.mjs claim` 在 Issue 留账号与分支。若同一任务已有对应 Issue 与 OPEN PR 直接复用，不开第二条；多 Issue 联做先解 `Depends on` / `Blocks` 依赖序；返工永远在原分支追加提交更新同一个 PR，不重排无关文件。
- **PR 提交前文档同步锁（`flow.mjs finalize`）**：
  1. 核对关联 Todo 所有 `[ ]` 已完成勾选 `[x]`、填写「完成后的记录」，将关联 `PRD`（`done`）、`SPEC`（`implemented` 并补全「实现说明」）与 `Todo`（`done`/`archived`）一并 `git mv` **成对归档**进 `docs/archive/{prd,specs,todo}/` 并重算 `related_*` 互链（`do-not-edit: docs/archive/` 允许工具执行此合法归档）；
  2. 检查源码模块边界、对外 CLI 或契约变更是否同步更新 `docs/TDD.md`（日期与模块表）/ `README*.md` / `AGENTS.md`；
  3. **外部 Fork 防污染**：若自身为 `contributor-fork` 且上游未接入 `docs/`，本地私有规划文档存于 `.worktrees/.state/private-docs/<taskId>/` 供 `review-pack` 按账本路径读取，绝不混入 PR diff。
- **六个双写节点**：认领（Issue）、已提 PR（Issue + `Fixes #N`/`refs #N`）、审查退回（PR 与 Issue）、审查通过（PR 与 Issue）、返工已提交（PR 与 Issue，附新 HEAD 短哈希）、已合并（Issue）；`contributor-fork` 设标签遇 403 自动降级仅发评论。含中文/非 ASCII 正文一律先写系统临时目录 UTF-8 文件再以 `--body-file` / JSON 体提交并回读删除临时文件，绝不在命令行直接拼接中文。

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
  4. **轮次视野收窄**：第 1 轮看全量 diff -> 第 2 轮仅核 R1 未收口 `Must Fix`、增量 diff 与 `rebuts`（已关闭条目显式记为 `rebutted`/`resolved`，锁定未改旧块禁提新刺）-> 第 3 轮只对增量修复行做二元 Pass/Fail 核对；
  5. **防越界返工**：HEAD 未前进的重提直接拒绝；返工支持 `--rebut` 记有据反驳；
  6. **停损熔断、人工解锁与园艺聚类**：同一 `Must Fix` 连续两轮未收口或达 **3 轮**上限触发 `STOP_LOSS_ESCALATE`；触发后须经人类维护者明确裁决（`review-pack.mjs override --human-approved --reason` 配合 `flow.mjs merge --human-approved --reason`）方可解锁放行；日常经 `dev-govern`（支持 `<mainRoot>/.worktrees/.state/govern-baseline.json` 基线增量与 `--changed` 模式、`record`/`cluster` 满 `2` 次下沉形式静态门禁 / `sample --commits 30` 抽检回滚与 48h 返工热点）持续压低熵增。

## 八、谁能合

按**能不能撤回（双向门 `two-way` vs 单向门 `one-way`）**分档，不按「是不是对外」一刀切：**推自己的分支与开 PR 都能撤回，属于日常**；合并默认分支、发版、改可见性、改写历史撤不回来，严格按以下规则执行：

| 改动类型 | 合并权限 | 前置条件 |
| --- | --- | --- |
| 普通改动 / 外部 PR | **审查者直接合**（`contributor-fork` 等上游维护者合） | 独立审查 `fail` 为空 + `reviewPassedHead === HEAD` + 双门实测证据；外部 PR 先过 `--untrusted-scan` |
| 触碰「高风险路径」任一处 | **审查者直接合** | 独立上下文审查（`reviewerId !== implementerId`）+ 真实故障注入记录 |
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
