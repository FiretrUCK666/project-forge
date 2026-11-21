---
name: dev-plan
description: |
  需求分流、编写与审核四层工程文档（TDD、PRD、SPEC、Todo）、门型评估与规划内审自净化。
  触发词：做功能、需求规划、写方案、写设计文档、写 PRD、写 SPEC、写 Todo、拆任务、
  需求分流、立项、先出方案、文档自检、implement feature、plan feature、write spec、triage task。
metadata:
  intent: 新需求 / 做新功能 / 跨模块改造 / 澄清拍板 / 写方案与拆任务
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

## 全场景五档分流（轻重恰当，绝不臃肿）

| 场景 / 档位 | 文档产物 | 规划内审与执行硬门禁 |
| --- | --- | --- |
| **外部 PR 审查** | 0 文档 | 直接移交 `dev-flow` + `dev-review` 只读隔离扫描 |
| **Case 1**（问答 / 错别字 / 单行） | **0 文档** | 不写多余文档，直接转交执行并跑对应校验 |
| **Case 2**（明确局部 Bugfix，不改契约） | **0 文档** | 强制 **Red-Green**：先补失败复现回归测试再修绿；触及高风险须独立审查 |
| **Case 3**（L2 局部功能，不改外部契约） | 只建 `docs/todo/` | 澄清并冻结 `C1..Cn`，跑 `doc-plan.mjs audit` 自净化直通（非平凡 Todo 建议走 Critique） |
| **Case 4**（L3 跨模块 / 改外部契约） | `docs/specs/` + `docs/todo/`；**一份 SPEC 装不下时再加 `docs/prd/`** | 跑 `audit` -> **独立只读 Critique**（`SELF_CRITIQUE_REJECTED` 禁自审；全历史换人 + 3 轮硬停损 `STOP_LOSS_ESCALATE`，支持 `critique-reject`/`critique-override`）-> 交人 `approve` |
| **Case 5**（与 `docs/TDD.md` 或生效 SPEC 冲突） | **阻断拆解** | 先修订 `docs/TDD.md` 并经独立确认后再续 |

说明：`contributor-fork` 若上游仓未接入 `docs/`，私有草案绝不混入 PR diff。

**为什么「一份 SPEC 装不下」是判据、而不是「这件事大不大」**：大小是形容词，量不出来；能问的是
一个结构问题——这份需求的验收清单，一份 SPEC 装得下吗？装不下就必须拆，拆了就需要一个上层容器
记「整体算不算做完」，那个容器就是总控 PRD。三条机械信号任一条成立就够（同时碰四面以上、需求
自己说了要分批、声明要动 12 个以上文件），`doc-plan.mjs triage` 会输出 `prdRequired` 与依据。
**反向同样要守住**：只碰一两面的小需求不许被判进来，否则每件小事都要求先写 PRD，人会直接绕过
整套流程。事后兜底由 `audit` 的 `ORPHAN_SLICES_NO_MASTER_PRD` 负责——两份以上生效 SPEC 没有
共同认领的 PRD 时会报出来。

## 独立 Critique、`impl` 工作树协同与移交 `dev-flow`

- **不可自审、全历史换人与 3 轮停损锁**：`critique-pass` / `critique-reject` 将轮次与锚点写入任务账本 `ledger.planCritique`，硬拒与 `owner` 相同者（`SELF_CRITIQUE_REJECTED`）、Round 2+ 复用任意历史轮次审稿人（`BLOCKED_CRITIQUE_SAME_REVIEWER`，退出码 `3`）及未改稿重审（`BLOCKED_CRITIQUE_SAME_SHA`，退出码 `3`）；连轮相同阻塞项或第 3 轮仍退回触发 `STOP_LOSS_ESCALATE`（退出码 `4`），停损后仍允许改稿继续写新轮次 `critique-reject`/`critique-pass` 或记 `critique-continue`，仅锁定 `approve` 直至人类 `critique-override --human-approved --reason "..."` 解锁；Critique 通过后正文未改由维护者执行 `approve`（改正文触发 `BLOCKED_CRITIQUE_STALE`）。**批准只由 `approve` 一个入口写入**：严格白名单只放行过审（SHA 一致）、带实质理由跳过、人类签字且正文未改三种依据，`link --approve` 会被 `BLOCKED_APPROVAL_HAS_SINGLE_ENTRY` 拒绝。支持 `--milestone` 与 `plan-sync.mjs` 同步规划状态。
- **`impl` 工作树协同**：支持 `doc-plan.mjs init --worktree` 直接创建隔离规划工作树（`status: planning`）；若 `flow.mjs start --task <id> [--planning]` 已先建好隔离工作树，`doc-plan.mjs init --task <id>` 会直接把规划单落盘到 `.worktrees/impl-<id>/` 避免撕裂。
- **波次移交 `dev-flow`**：单任务 `audit`/`approve` 通过后按 `[NEXT STEP]` 移交 `dev-flow`（`flow.mjs start`）；多切片协同可配合 `flow.mjs start --after <parent>` 起堆叠子分支或 `flow.mjs batch plan` 按文件互斥划分波次。未装配兄弟技能时退化为原生 Git 指引。

## 标准命令流

```sh
# 1. 五档分流 + 门型判断 + 改哪看哪联动预警（结论含建议规划态 planMode）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>" [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--plan-mode interactive | autonomous]

# 2. 按统一模板生成文档（自动按工作区形态裁剪适用章节，--no-prune 强制全保留；--prd/--spec 建立互链并继承；支持 --milestone）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind <prd|spec|todo|pair|all> --slug "<slug>" --title "<标题>" [--issue <N>] [--milestone <N|标题>] [--task "<taskId>"] [--prd "<prdPath>"] [--spec "<specPath>"] [--plan-mode interactive | autonomous] [--worktree] [--no-prune]

# 3. 多轮互动澄清落盘与规划内审自净化（实质性校验零字数门槛、跨轮防退化比对、Mermaid 16/12、Frontmatter 互链）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" clarify --file "docs/specs/<file>" --question "<问题>" --decision "<结论>" [--by user] [--criterion "<追加 C 项>"]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "docs/specs/<YYMMDD-slug-spec>.md"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit .

# 4. 关联、独立 Critique（通过/退回/继续重写/人工解锁）、批准、成对归档（--include-master-prd 含总控 PRD）与取代
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" link "<slug-or-path>" [--issue <N>] [--pr <M>] [--milestone <N|标题>] [--branch <B>] [--status <S>]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "docs/specs/<file>" --reviewer "<criticId>" --round 1 --summary "<结论>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-reject --file "docs/specs/<file>" --reviewer "<criticId>" --round 1 --findings "<意见>" --summary "<退回原因>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-continue --file "docs/specs/<file>" --reason "<改进方向>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-override --file "docs/specs/<file>" --human-approved --reason "<裁决理由>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "docs/specs/<file>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" archive [<slug-or-path>] [--task <id>] [--include-master-prd]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" supersede "<oldSpec>" --by "<newSpec>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" list
```
