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
3. **测试控频快则**：编码每轮只跑 `{target}` 局部测试；涉及运行时/CLI/启动链路改动必跑 `smoke-verify`；全量 `merge-gate` 仅在提交 PR / 合并前运行 1 次。
4. **中途触碰高危升级规则**：实现中途若发现需要修改高风险路径、跨模块外部契约、数据结构或放宽门禁，**立刻停下升级档位**（补写 SPEC 并走 Critique + `approve`，触及门禁交人确认）。

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

## 标准命令流与分级自净化闭环

```sh
# 1. 五档分流 + 门型判断（返回 caseType / doorType / critiqueTier）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>" [--files <n>] [--touches-contract] [--conflicts-tdd]

# 2. 按模板生成文档（含 复用既有模块 / 本期不做 / 门型与回滚路径）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --type <prd|spec|todo> --slug "<kebab-slug>" --title "<标题>" [--task "<taskId>"]

# 3. 规划内审自净化（拦截未填占位、空泛验收、瞎编路径；新路径须标 (new) 且父目录存在）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "docs/todo/<YYMMDD-slug>.md"

# 4. Case 4/5：独立只读 Plan Critique 通过后记录摘要与内容哈希
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "docs/specs/<YYMMDD-slug>.md" --reviewer "<reviewerId>" --round 1 --summary "<结论摘要>"

# 5. 人类批准 SPEC（自动前置执行 audit + 校验 Plan Critique: passed）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "docs/specs/<YYMMDD-slug>.md"

# 6. 实时扫描全局文档全景（零手写索引表，防合并冲突）
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" list
```
