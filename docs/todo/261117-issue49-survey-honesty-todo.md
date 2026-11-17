---
kind: todo
title: 勘察与体检的诚实性
status: active
created: 2026-11-17
updated: 2026-11-17
issue: 49
pr: null
branch: fix/v8-criteria-trust
owner: null
approved: false
done_at: null
task_id: survey-honesty
planned_at: 73087a27cb9af3d9cea2988cc3e3e4d3b6154ec9
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261117-issue49-survey-honesty-spec.md
---

# Todo: 勘察与体检的诚实性

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-17` / `2026-11-17` |
| 分支 / 基线 | `fix/v8-criteria-trust` @ `73087a2` |
| 任务编号 | `survey-honesty` |
| 负责人 / 审批 | 待认领 / `false` |
| 认领的验收标准 | C1、C2、C3、C4、C5、C6、C7、C8、C9、C10、C11、C12 |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`scripts/lib/template.mjs`、`scripts/lib/claims.mjs`、`scripts/lib/survey-ecosystem.mjs`、`kit/skills/lib/command-lex.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-plan.mjs`、`kit/skills/lib/symbol-index.mjs`(new)、`kit/skills/lib/tdd-parity.mjs`、`scripts/review.mjs`、`scripts/compose-agents.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`scripts/lib/render.mjs`、`scripts/survey.mjs`、`kit/skills/dev-flow/scripts/flow-inspect.mjs`、`kit/skills/dev-flow/scripts/flow-next.mjs`、`templates/agents-project.md`
- **复用既有模块**：`verdict.mjs`、`tool-owned.mjs` 与 `protocol.isToolOwnedPath`、`profile-sniffer.mjs`、`profile.mjs`、`static-gates-lexer.mjs`
- **本期不做**：第三方解析器、LSP 级语义分析
- **门型与回滚路径**：one-way；逐文件反向提交即可回退，`symbol-index.mjs` 删除不影响既有调用（调用点同批回退）
- **快测命令**：`node scripts/dev/fixtures.mjs --domain claims` 与 `--domain contracts`

## 验收标准与执行清单

- [ ] C1: 占位符先校验形状再替换，宿主模板语法豁免，三类坏形状仍必须抛错
- [ ] C2: 家目录 / 环境变量根 / 盘符 / 绝对路径不作为仓库相对路径报缺失；剥掉 `./` 后的仓内真路径仍要认出
- [ ] C3: 动作词只在命令位置匹配；`--format=` 取值、属性名、文件名里的 `test` 都不误判
- [ ] C4: 工具产物不计入项目规模；空骨架 `isReentry` 仍为 false，真实内容才变 true
- [ ] C5: 规模单调不降，六格矩阵任意两格都成立
- [ ] C6: 算不出来不等于算出来没问题（含 catch 分支的静态断言）
- [ ] C7: 空壳 TDD 四种形态全部判红，注释里的符号不算定义
- [ ] C8: 工具产物条目为 0，且项目自己的模块必须被认出
- [ ] C9: 取舍节出厂为空；工具生成的空仓不得报「没有会出事的缺口」
- [ ] C10: 多行 run 逐条展开，无超长单行
- [ ] C11: 命令探测不被已识别生态整条跳过；主工作区直改要报固定标记
- [ ] C12: 命令多时改说「去哪看」，每类至少留一条真实命令

## 执行步骤

1. 先补失败用例：三种坏占位符形状、家目录/环境变量根路径、`--format=zip` 与 `.Restore`、文件名里的 `test` —— 验证：`node scripts/dev/fixtures.mjs --domain claims`
2. 反向用例：`${{ }}` 宿主语法放过、`./docs/TDD.md` 剥前缀后仍认出、六格矩阵单调性、空骨架 `isReentry` 为 false —— 验证：同上
3. 实现各层修复并接入 `review.mjs` 的三态结论 —— 验证：`node scripts/dev/fixtures.mjs`
4. 补故障注入并复验（I22c 三态、I80 折叠退化） —— 验证：`node scripts/dev/verify-injections.mjs --only I22c`

## 断点与遗留决策

- **当前状态**：`进行中`。已落地并有正反用例：C1、C2、C3（含命令展示字节上限）、C4、C5、C6、C9、C10、C11、C12；**未完成**：C7（符号锚点：`symbol-index.mjs` 尚未创建、`tdd-parity.mjs` 仍用 `includes`）、C8（`survey` 尚未报出「N 种语言其中 M 种缺规则」）。
- **待拍板事项**：C7 的存量仓宽限期长度（见 PRD 待拍板第 8 项）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/dev/fixtures.mjs` → 185 项通过 / 0 失败；`node scripts/dev/preflight.mjs` → 32 项读数 0 失败；`verify-injections --only I22c`、`I80`、`I89` 均红（正确）。
- **文档同步检查**：`AGENTS.md` 的「构建与验证」与 `docs/TDD.md` 的模块表已随同更新；`README.md` 与 `README.en.md` 成对同步。
- **遗留问题**：C7 与 C8 的后半条未完成，见上方「断点与遗留决策」。
