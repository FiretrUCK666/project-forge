---
name: dev-plan
description: |
  需求分流、编写与审核四层工程文档（TDD、PRD、SPEC、Todo）、门型评估与规划内审自净化。
  触发词：需求规划、写方案、写设计文档、写 PRD、写 SPEC、写 Todo、拆任务、
  需求分流、立项、先出方案、文档自检、plan feature、write spec、triage task。
---

# dev-plan：分级规划、说人话契约与内审自净化

先核实代码真相，再按风险精准分流；用最少的文档冻结可判定标准，并通过内审去除占位符与假路径。

## 前置核实与核心原则

1. **先 `dev-explore` 后动笔**：起草任何规划前必须先查清目标目录真实文件、调用链与 `reusableModules`（可复用现成模块），禁止凭记忆猜路径或重复造轮子。
2. **说人话四要素 + 三不写**：
   - **四要素**：真实问题与目标、本期明确不做（防膨胀）、可执行/可断言的标准 `C*`、门型（`two-way` / `one-way`）与回滚路径。
   - **三不写**：不写空泛正确废话（如「提高质量」「确保稳定」「优化体验」）、不写未核实的假路径/假符号、不在方案里复制粘贴大段实现代码。
3. **测试控频与联动核对**：编码每轮只跑 `{target}` 局部测试；涉及运行时/CLI/启动链路改动必跑 `smoke-verify`；全量 `merge-gate` 仅合前跑 1 次；`triage` 同步检查 `AGENTS.md`「## 改哪看哪」输出 `coupledSyncWarnings`。
4. **文档规范与全生命周期联动**：`docs/{prd,specs,todo}/` 采用 `YYMMDD-[issue<N>-]<slug>-{prd,spec,todo}.md` 命名与 YAML Frontmatter（`--- ... ---`）；认领 Issue、关联 PR 或推进状态时统一跑 `doc-plan.mjs link` 自动补 `-issue<N>-` 重命名并互刷 `related_*` 链接。
5. **中途触碰高危升级规则**：实现中途若发现需要修改高风险路径、跨模块外部契约、数据结构或放宽门禁，**立刻停下升级档位**（补写 SPEC 并走 Critique + `approve`，触及门禁交人确认）。

## 全场景五档分流规则（先跑脚本判定）

| 场景 / 档位 | 文档产物 | 规划内审与执行硬门禁 |
| --- | --- | --- |
| **外部 PR 审查** | 0 文档 | 直接只读隔离审查与静态投毒扫描 |
| **Case 1**（文档 / 问答 / 错别字） | 0 文档 | 直接执行，无额外门禁 |
| **Case 2**（明确局部 Bugfix，不改契约） | 0 文档 | 强制 **Red-Green**：先补失败复现回归测试再修绿 |
| **Case 3**（L2 局部功能，不改外部契约） | 只建 `docs/todo/` | 运行 `doc-plan.mjs audit` 自查修净后直通开工 |
| **Case 4**（L3 跨模块 / 改外部契约） | `docs/specs/` + `docs/todo/`（流程不清补 `docs/prd/`） | 跑 `audit` + 1–2 轮独立只读子代理 Plan Critique -> 自净化原位改好 -> `critique-pass` -> 交人 `approve` |
| **Case 5**（与 `docs/TDD.md` 或生效 SPEC 冲突） | **阻断拆解** | 先修改 `docs/TDD.md` 并走独立审核与确认后再续 |

说明：若当前为 `contributor-fork` 且外部上游仓库未使用 `docs/`，本地草案绝不混入 PR diff。

## 标准命令流与分级自净化全流程

```sh
# 1. 五档分流 + 门型判断 + 改哪看哪联动预警（支持 --paths a,b）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>" [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd]

# 2. 按模板生成带 YAML Frontmatter 文档（pair 生成 spec+todo，all 生成 prd+spec+todo）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind <prd|spec|todo|pair|all> --slug "<kebab-slug>" --title "<标题>" [--issue <N>] [--task "<taskId>"]

# 3. 规划内审自净化（单文件或传 . 全仓巡检 YAML Frontmatter、status、issue 命名一致性与互链）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "docs/todo/<YYMMDD-slug-todo>.md"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit .

# 4. 关联 Issue / PR / 分支并自动重命名（补 -issue<N>- 并同步兄弟 related_*）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" link "<slug-or-path>" [--issue <N>] [--pr <M>] [--branch <B>] [--owner <O>] [--status <S>] [--approve]

# 5. Case 4/5：独立只读 Plan Critique 通过 -> approve 人类批准（强制前置 audit + Critique 通过）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "docs/specs/<YYMMDD-slug-spec>.md" --reviewer "<reviewerId>" --round 1 --summary "<结论摘要>"
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "docs/specs/<YYMMDD-slug-spec>.md"

# 6. 实时扫描全局文档全景（零手写索引表，防合并冲突）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" list
```
