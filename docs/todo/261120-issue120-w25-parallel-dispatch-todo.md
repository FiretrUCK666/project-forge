---
kind: todo
title: 并行度机制实施清单：依赖满足单点、并行度全阶段可见、串行理由枚举
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 120
pr: null
branch: fix/w25-parallel-dispatch
owner: plan-wave25
approved: false
done_at: null
task_id: w25-parallel-dispatch
planned_at: null
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue120-w25-parallel-dispatch-spec.md
plan_mode: interactive
depends_on: []
scope_files: ["kit/skills/lib/workflow-helpers.mjs", "kit/skills/lib/workflow-policy.mjs", "kit/skills/lib/doc-slice-graph.mjs", "scripts/dev/fixtures-parallel-dispatch.mjs"]
---

# `w25-parallel-dispatch` 实施 Todo（Issue `#120`）

> 对应 SPEC：[parallel-dispatch SPEC](../specs/261120-issue120-w25-parallel-dispatch-spec.md)
>
> **基线**：`a0fe4df`。本切片无前置，可立即开工。

## 一、要做什么

<!-- section: goal -->
让并行度从「一句被忽略的建议」变成一条可核对的结论：

- **依赖满足单点**：一个函数判「目标切片存在且状态属于完成集合」，切片图与就绪扫描共用；归档自然满足，悬空仍报出。
- **全阶段可见**：选中任务时也返回并行度、波次与就绪切片。
- **串行留理由**：理由码来自封闭枚举；可并行却串行时阻断并给两条合法出口；单就绪切片不阻断。
- **两路径对拍**：就绪扫描与切片图对同一批切片给出相同波次划分。

## 二、不做什么

<!-- section: non-goals -->
不改拓扑算法；不改缺写域保守串行判据；不改账本结构与后端；不改并行阈值；不加强制并行开关；不加跳过判定开关；不改认领与工作位隔离；不碰 `docs/archive/`。

不以任何形式打补丁：不把建议改成强制、不加「找不到就算满足」、不用自由文本当理由、不在文档里写「应当并行」了事。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 单点判定）**：在切片图模块抽出「依赖是否满足」函数（目标切片存在且状态属于完成集合，活跃与归档文档一并参与）；`workflow-helpers.mjs` 的就绪扫描改调它，删除自己那段按活跃账本判的逻辑；确保悬空依赖仍被报出。
- [ ] **T2（`C4` 波次单点）**：波次计算以切片图模块为唯一实现；就绪扫描的波次编排改调它，删除重复分层逻辑。
- [ ] **T3（`C2` 全阶段可见）**：`workflow-policy.mjs` 的选中任务返回路径补上并行度、波次、就绪切片三个字段；核对无活跃任务分支的取值不变。
- [ ] **T4（`C3` 串行理由枚举）**：定义封闭枚举（写域重叠、依赖单链、需人拍板、单任务）与每个码对应的系统生成说明；波次计划输出串行结论并区分有无理由。
- [ ] **T5（`C3` 阻断与出口）**：选中任务路径输出并行度结论三态（并行 / 带理由串行 / 无理由阻断）；可并行却串行时给两条合法出口；单就绪切片不阻断。
- [ ] **T6（`C4` 结果对拍）**：新增对拍断言——就绪扫描与切片图对同一批切片给出相同波次划分；改动任一侧过滤即变红。
- [ ] **T7（夹具）**：新增 `scripts/dev/fixtures-parallel-dispatch.mjs` (new)，承接 `C1..C5` 正反断言，含「归档前置就绪」「悬空仍报出」「单任务不阻断」「全阶段可见」四条关键断言。
- [ ] **T8（行数核对）**：逐文件核对 `.mjs <= 800`；`workflow-policy.mjs` 因补字段变长且已由后续片拆分，本片只补字段不搬逻辑；若超 800 行，先把并行度结论计算下沉到编排辅助模块。
- [ ] **T9（同步）**：`kit/` 改动后跑 `node scripts/equip.mjs .`；返回字段新增属于对外契约变化，同提交同步 `docs/TDD.md` 对应模块行与相关技能文档的说明。

## 四、验收与合前检查

- [ ] 两个前置已实现并归档时，就绪扫描返回该切片就绪。
- [ ] 有任务选中时，状态查询返回体含并行度、波次、就绪切片且波次非空。
- [ ] 可并行却串行时阻断并给两条出口；传枚举理由后放行并进报告；单就绪切片不阻断。
- [ ] 就绪扫描与切片图的波次划分对拍一致。
- [ ] `node scripts/dev/fixtures.mjs --domain parallel-dispatch` 全绿，`C1..C5` 正反各一条断言。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
