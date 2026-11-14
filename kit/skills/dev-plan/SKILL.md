---
name: dev-plan
description: |
  需求分流、编写与审核四层工程文档（TDD、PRD、SPEC、Todo）、门型评估与规划内审自净化。
  触发词：需求规划、写方案、写设计文档、写 PRD、写 SPEC、写 Todo、拆任务、
  需求分流、立项、先出方案、文档自检、plan feature、write spec、triage task。
---

# dev-plan：分级规划、说人话契约与内审自净化

先核实代码真相，再按风险精准分流；用最少的文档冻结可判定标准，并通过内审去除占位符、假路径与过宽 Mermaid 标签。

## 前置核实与核心原则

1. **先 `dev-explore` 后动笔**：起草任何规划前必须先查清目标目录真实文件、调用链与 `reusableModules`，禁止凭记忆猜路径或重复造轮子。
2. **统一模板与短名图表**：`doc-plan init` 输出含 YAML Frontmatter、顶部可见元信息概览表及 SPEC 短名图表（矩形/分组单行显示宽度 `<= 16`，菱形/边标签 `<= 12`，禁用节点内 HTML 标签）。
3. **说人话四要素 + 三不写**：
   - **四要素**：真实问题与目标、本期明确不做（防膨胀）、可执行/可断言的标准 `C*`、门型（`two-way` / `one-way`）与回滚路径。
   - **三不写**：不写空泛正确废话（如「提高质量」「确保稳定」「优化体验」）、不写未核实的假路径/假符号、不在方案里复制粘贴大段实现代码。
4. **成对归档与生命周期联动**：`docs/{prd,specs,todo}/` 采用 `YYMMDD-[issue<N>-]<slug>-{prd,spec,todo}.md` 命名（支持中文 slug）与 YAML Frontmatter；`link` / `archive` / `supersede` 自动更新互链与账本。

## 全场景五档分流规则（先跑脚本判定）

| 场景 / 档位 | 文档产物 | 规划内审与执行硬门禁 |
| --- | --- | --- |
| **外部 PR 审查** | 0 文档 | 直接只读隔离审查与静态投毒扫描 |
| **Case 1**（文档 / 问答 / 错别字） | 0 文档 | 直接执行，无额外门禁 |
| **Case 2**（明确局部 Bugfix，不改契约） | 0 文档 | 强制 **Red-Green**：先补失败复现回归测试再修绿；触及高风险须独立审查 |
| **Case 3**（L2 局部功能，不改外部契约） | 只建 `docs/todo/` | 运行 `doc-plan.mjs audit` 自查修净后直通开工 |
| **Case 4**（L3 跨模块 / 改外部契约） | `docs/specs/` + `docs/todo/`（流程不清补 `docs/prd/`） | 跑 `audit` + 1–2 轮独立只读 Critique -> 自净化原位改好 -> `critique-pass` -> 交人 `approve` |
| **Case 5**（与 `docs/TDD.md` 或生效 SPEC 冲突） | **阻断拆解** | 先修改 `docs/TDD.md` 并走独立审核与确认后再续 |

说明：若当前为 `contributor-fork` 且外部上游仓库未使用 `docs/`，本地草案绝不混入 PR diff。

## 与 `dev-flow` 及兄弟技能的职责边界与衔接

- **单源分工不重复**：`dev-plan` 只负责五档分流、四层文档生成/自审净化与内审批准，**绝不单独重写分支隔离或 Issue/PR 评论逻辑**；`link` 与 `archive` 共用 `kit/skills/lib/docs.mjs` 同一实现。
- **前后衔接链路**：先用 `dev-explore`（`repo-map.mjs`）查清入口与复用设施再动笔；`audit` / `approve` 通过后经 `[NEXT STEP]` 直接移交 `dev-flow`（`flow.mjs start` 建隔离工作树/分支、`--create-issue` 建单改名、`claim` 真实 Contributor 认领、`finalize` 成对归档、`submit` 提 PR 双写评论）；`lightweight` 或未装 `dev-flow` 时自动降级为原生 Git 指引。

## 标准命令流与分级自净化全流程

```sh
# 1. 五档分流 + 门型判断 + 改哪看哪联动预警
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>" [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd]

# 2. 按统一模板生成文档（若已存在任务 worktree，自动写进实施工作树）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind <prd|spec|todo|pair|all> --slug "<slug>" --title "<标题>" [--issue <N>] [--task "<taskId>"]

# 3. 规划内审自净化（含两遍 (new) 收集与 Mermaid 16/12 宽度门禁）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "docs/todo/<YYMMDD-slug-todo>.md"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit .

# 4. 关联、Critique、批准、成对归档与取代
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" link "<slug-or-path>" [--issue <N>] [--pr <M>] [--branch <B>] [--status <S>]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "docs/specs/<file>" --reviewer "<reviewerId>" --round 1 --summary "<结论>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "docs/specs/<file>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" archive [<slug-or-path>] [--task <id>]
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" supersede "<oldSpec>" --by "<newSpec>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" list
```
