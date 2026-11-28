---
name: dev-plan
description: |
  需求分流、编写与审核四层工程文档（TDD、PRD、SPEC、Todo）、门型评估与规划内审自净化。
  触发词：做功能、需求规划、写方案、写设计文档、写 PRD、写 SPEC、写 Todo、拆任务、
  需求分流、立项、先出方案、文档自检、implement feature、plan feature、write spec、triage task。
metadata:
  intent: 新需求 / 加功能 / 跨模块改造 / 澄清拍板 / 写方案与拆任务
  script: "`node .agents/skills/dev-plan/scripts/doc-plan.mjs triage` / `init` / `audit`"
  order: 20
  fallback: 按改动影响面人工分级（L3 改契约先写 docs/specs/ 与 docs/todo/，完成后用 git mv 归档；未装配 dev-plan 技能）
---

# dev-plan：需求 → 澄清 → 设计 与独立 Critique 网关

负责 8 阶段研发闭环中的**需求整合、多轮互动澄清、分层设计定案与独立 Critique**。只写经过勘察核实的真相，用恰如其分、不臃肿的文档冻结 `C1..Cn` 验收标准。

## 前置侦察、多链接协同与多轮互动澄清

1. **先 `dev-explore` 后动笔**：起草任何规划前必须先通过 `repo-map.mjs` 与零写入按需定位器 `doc-locate.mjs`（文档/符号切片定位首选）查清真实文件、调用链、CI 命令与 `reusableModules`，禁止凭记忆编造路径或重复造轮子；若收到多个 Issue/PR URL，先用 `flow.mjs inspect [URL...]` 联查互指关系与依赖拓扑序再统一设计。
2. **PRD 双触发入口**：
   - 用户明确提出写 PRD；
   - 经 `dev-explore` 勘察发现跨多模块、流程不清或业务痛点较复杂时，**主动向用户建议先建总控 PRD**（支持 1 份总控 PRD 拆分为 N 份切片 `SPEC + Todo`）。
3. **先声明规划态，再决定怎么澄清**：规划单的 Frontmatter 有 `plan_mode`，取值只两个——`interactive | autonomous`，生成时用 `--plan-mode` 指定，不指定则由 `triage` 结论里的门型与档位推导（单向门、Case 4、L3 与总控 PRD 默认 `interactive`，其余 `autonomous`）。
   - **`interactive`（逐题问到零）**：每个待拍板问题都要逐项与用户沟通确认，一轮问不完就再来一轮，每轮结论直接补进 PRD/SPEC/Todo 的对应章节与 `C1..Cn`，直到「无待拍板问题」。判据是**这个决定错了撤不撤得回来**——单向门、跨模块、改外部契约都撤不回来，猜错的代价由后面的人承担。
   - **`autonomous`（默认推进）**：按仓内既有最佳模式自行拍板并写进文档，只在三种情况下停下来发问——遭遇 `one-way` 不可逆门、Case 5（与 `docs/TDD.md` 冲突）、真业务语义歧义（同一句话能理解成两件不同的事）。
   - **共同下限**：两种模式下「待拍板事项 / 未决问题」全部消解且路径/命令核实后，才可进入 `audit` 与独立 Critique（严禁把未拍板问号留给实现或审查）。区别只在**谁来拍**，不在**要不要拍**。
4. **尊重仓库自有模板与短名图表**：`doc-plan.mjs init` 自动识别并套用仓库既有的 `docs/templates/*.md` / `.github/*-template.md`，同时注入 YAML Frontmatter、元信息概览表与 SPEC 短名 Mermaid（矩形/分组单行 `<= 16`、菱形/边 `<= 12` 单位，禁节点内 HTML 标签）。
5. **说人话四要素 + 三不写**：
   - **三件必答**：真实痛点与目标、本期明确不做（防膨胀）、可运行/可断言的 `C1..Cn`——这三件与项目形态无关，任何项目都得写。**其余章节按形态取舍**：有状态的业务才写状态规则，有身份的才写权限，有门的才标 `two-way`/`one-way`；没门的项目写个门型只是编。
   - **三不写**：不写空泛废话（如「提高质量」「确保稳定」「优化体验」）、不写假路径、不在文档里贴大段实现代码。

## 全场景五档分流与确定性三出口

| 场景 / 档位 | 确定性出口 & 产物 | 规划内审与执行硬门禁 |
| --- | --- | --- |
| **外部 PR 审查** | 0 文档 | 直接移交 `dev-flow` + `dev-review` 只读隔离扫描 |
| **Case 1**（问答 / 错别字 / 单行） | `direct`（0 文档） | 不写多余文档，允许原地微调并跑对应校验 |
| **Case 2**（明确局部 Bugfix） | `sandbox`（0 文档） | 先进 `.worktrees/sandbox-*` 写失败回归测试再修绿（Red-Green），`promote` 晋升外环 |
| **Case 3**（L2 局部功能，不改契约） | `sandbox`（晋升后补 `docs/todo/`） | 不因裸 `fileCount >= 6` 钝化升 Case 4；沙箱看真效果后 `promote` 补 Todo 跑 `audit` 自净化直通（Critique 仅建议） |
| **Case 4**（L3 跨模块 / 契约 / `one-way`） | `plan-first`（`docs/specs/` + `docs/todo/`，装不下加 `docs/prd/`） | 允许 `--sandbox` 先探路 PoC；合并前须过 `audit` -> **独立 Critique**（`SELF_CRITIQUE_REJECTED` + 全历史换人 + 3 轮停损 `STOP_LOSS_ESCALATE`）-> 交人 `approve` |
| **Case 5**（与 `docs/TDD.md` 或生效 SPEC 冲突） | `plan-first`（阻断拆解，`prdRequired: false`） | 与 PRD 严格正交；先修订 `docs/TDD.md` 并经独立确认后再续 |

说明：`doc-plan.mjs triage` 确定性输出 `recommendedEntry: direct | sandbox | plan-first`、`sandboxPocAllowed`、`briefRecommended` 与单一 `[NEXT STEP]`；`contributor-fork` 若上游无 `docs/`，私有草案绝不混入 PR diff。

**「一份 SPEC 装不下」的 PRD 结构判据**：三条机械信号任一成立即触发 `prdRequired: true`（同时碰四面以上、需求说了要分批、声明动 `>= 12` 个文件）；不以裸 `fileCount >= 6` 误抬局部可逆改动，且 `Case 5` 严格保持 `prdRequired: false`。事后由 `audit` 的 `ORPHAN_SLICES_NO_MASTER_PRD` 兜底多份无主 SPEC。

## 独立 Critique、`impl` 工作树协同与移交 `dev-flow`

- **不可自审与全历史换人**：禁用 `owner: null`（`INVALID_OWNER`），禁跨轮把 `triage` 高档降回低档（`BLOCKED_TRIAGE_DOWNGRADE`）；`interactive` 模式 `clarify` 须带 `--by user` 消解全部待决小节。`critique-pass`/`critique-reject` 写入 `ledger.planCritique`，拒 `SELF_CRITIQUE_REJECTED`（同 `owner`）、`BLOCKED_CRITIQUE_SAME_REVIEWER`（R2+ 复用审稿人）、`BLOCKED_CRITIQUE_ROUND_GAP`（跳轮）与 `BLOCKED_CRITIQUE_SAME_SHA`（未改稿）。
- **严重度分层与 R2+ 收敛**：仅 `[minor]` 禁 `critique-reject`（`BLOCKED_NON_BLOCKING_REJECT`），改走 `critique-pass --should-fix`；R2+ 新增阻塞须命中未闭环项（可配 `--resolved`/`--rebut-accepted`）或落入改动行/章节内（越界报 `BLOCKED_OUT_OF_SCOPE_CRITIQUE`）；连轮同阻或第 3 轮退回触发 `STOP_LOSS_ESCALATE`（`4`），仅人类 `critique-override --human-approved --reason "..."` 解锁；Critique 通过后由维护者 `approve`（`--host-mode single-session --human-approved` 配 `--skip-critique-reason` 仅限无子代理宿主且经人授权，多代理宿主严禁借此绕过；`link --approve` 报 `BLOCKED_APPROVAL_HAS_SINGLE_ENTRY`），支持 `--multi-spec` 与活跃 SPEC 反查总控 PRD。
- **抗压缩恢复、隔离、死路记忆与 Repo-Path Grounding**：随时可跑 `doc-plan.mjs next --handoff` 无损恢复 `1:N` 总控 PRD/切片、`findings`、半成品工作树归属、Living Visual Brief 与三态拍板出口（含 `--plan-only`）；`note --dead-end "<排除路径与原因>"` 按主题独立加锁持久化已证伪死路，防止上下文压缩后重复踩坑。起草前先做业务目标锚定、前提质疑与 Deletion Test（能删减或合并单源绝不叠平行抽象）。`commits > 0` 默认分支 `init` 自动建 `.worktrees/impl-<taskId>/`（若先 `flow.mjs start --planning --task <id>` 则复用同树）；`planner` 返工优先续聊原写手，只读探索不建树；**允许在澄清/选型/用户要求时调用外部网络检索与网页读取工具做外部调研（注明来源），但写入文档的仓内路径、符号与命令必经 `doc-locate`/`repo-map`/`verifyDocClaims` 在本仓验真**。
- **按需 Living Visual Brief 与原型挂载**：`triage` 与 `note` 统一经 `shouldAutoTriggerBrief` 触发仓外 `<gitCommonDir>/project-forge-flow/briefs/` 简报——仅 `Case >= 4` / `one-way` / `prdRequired` / 原型对比意图或多轮 `note` 自动投影，局部可逆单轮 `Case 2/3` 零 Brief 开销；**每次创建或刷新简报后必向用户呈递可点击 `htmlUri`**。`brief` 支持 `--affected-feature`（`id` / `id=说明` / `id=改前 -> 改后`）、`--add-feature`、`--remove-feature`、`--prototype "<标题>=<路径或URL>"`（`<= 512 KB` 及 `http`/`https`/`file` 白名单）、`--select-prototype` 与 `--confirm`（确认后变更置 `confirmedState: stale`）；`init` 迁移 `topic -> task` 或 `1:N master-prd`（子切片记 `parentBriefKey` 不覆写总控）。
- **波次移交 `dev-flow`**：按 `[NEXT STEP]`（`--json` `nextSteps`）移交 `flow.mjs start`（可逆进 `--sandbox`，已批 Case 4 进外环）；多切片配合 `--after` 或 `flow.mjs batch plan`。

## 标准命令流

```sh
# 0. 单源抗压缩恢复、init 前讨论缓冲（note）、活需求视觉简报（brief）与规划下一步指引
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" next [--file "<docPath>"] [--task "<taskId>"] [--plan-only] [--handoff] [--json]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" note [--topic "<主题>"] [--decision "<结论>"] [--dead-end "<已证伪死路>..."] [--exclude "<不做项>..."] [--anchor "<锚点>..."] [--open "<问题>..."] [--json]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" brief [--topic "<主题>"] [--task "<taskId>"] [--title "<标题>"] [--verdict "<结论>"] [--affected-feature "<id=before::after>..."] [--add-feature "<id|domain|title|summary>..."] [--remove-feature "<id|reason>..."] [--flow-delta "<变化>..."] [--prototype "<标题>=<路径或URL>..."] [--select-prototype "<id>"] [--source-skill "<名称>"] [--confirm] [--open-browser] [--json]

# 1. 五档分流 + 门型判断 + 改哪看哪联动预警（结论含建议规划态 planMode）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>" [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--plan-mode interactive | autonomous]

# 2. 按统一模板生成文档（commits > 0 默认分支自动入隔离规划 worktree；--in-place 原地落盘）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind <prd|spec|todo|tdd|pair|all> --slug "<slug>" --title "<标题>" --agent <id> [--issue <N>] [--milestone <N|标题>] [--task "<taskId>"] [--prd "<prdPath>"] [--spec "<specPath>"] [--plan-mode interactive | autonomous] [--worktree | --in-place] [--no-prune]

# 3. 多轮互动澄清落盘与规划内审自净化（实质性校验零字数门槛、跨轮防退化比对、Mermaid 16/12、Frontmatter 互链）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" clarify --file "docs/specs/<file>" --question "<问题>" --decision "<结论>" [--by user] [--criterion "<追加 C 项>"]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "docs/specs/<YYMMDD-slug-spec>.md"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit .

# 4. 关联、生成只读评审边界（critique-scope）、独立 Critique、批准、成对归档（--include-master-prd）与取代
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" link "<slug-or-path>" [--issue <N>] [--pr <M>] [--milestone <N|标题>] [--branch <B>] [--status <S>]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-scope --file "docs/specs/<file>" [--reviewer "<criticId>"] [--round <N>] [--json]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "docs/specs/<file>" --reviewer "<criticId>" --round 1 [--should-fix "<建议>..."] [--resolved "<F1>..."] [--rebut-accepted "<F2>..."] --summary "<结论>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-reject --file "docs/specs/<file>" --reviewer "<criticId>" --round 1 --findings "<[major] 意见>" [--resolved "<F1>..."] [--rebut-accepted "<F2>..."] --summary "<退回原因>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-continue --file "docs/specs/<file>" --reason "<改进方向>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-override --file "docs/specs/<file>" --human-approved --reason "<裁决理由>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "docs/specs/<file>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" archive [<slug-or-path>] [--task <id>] [--include-master-prd]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" supersede "<oldSpec>" --by "<newSpec>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" list
```
