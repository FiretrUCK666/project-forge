---
kind: todo
title: 性能门禁从事实判据重建：快路径命中判定、日志前缀返回、校准相对预算
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 114
pr: null
branch: fix/w25-perf-budget
owner: plan-wave25
approved: false
done_at: null
task_id: w25-perf-budget
planned_at: null
related_prd: null
related_spec: ../specs/261120-issue114-w25-perf-budget-spec.md
plan_mode: interactive
depends_on: []
scope_files: ["kit/skills/lib/git-status-fast.mjs", "kit/skills/lib/git-fast.mjs", "scripts/dev/bench.mjs", "scripts/dev/fixtures-perf-budget.mjs"]
---

# `w25-perf-budget` 实施 Todo（Issue `#114`）

> 对应 SPEC：[perf-budget SPEC](../specs/261120-issue114-w25-perf-budget-spec.md)
>
> **基线**：`a0fe4df`。本切片无前置，可立即开工。

## 一、要做什么

<!-- section: goal -->
把性能门禁从「今天恰好通过」重建为「按事实判定」：

- **快路径判据**：是否退化为慢路径，由「已跟踪文件里有没有命中属性规则的文件」决定，不再由「属性文件里有没有那条规则」决定；两处入口抽成同一个内部函数。
- **日志快路径**：遇合并提交停止续读、返回已读前缀；零条目仍按失败返回。
- **预算来源**：删掉按环境放大预算的分支；每轮先测校准负载，各基准用「校准单位 × 倍数」当阈值，倍数表是唯一常量表。
- **实测压降**：目标是把真实耗时降下来，让预算与实测之间留出可判别余量，而不是把预算抬上去。

## 二、不做什么

<!-- section: non-goals -->
不改远端流水线文件；不放宽量级；不靠加大采样或丢弃离群值压数字；不删 `.gitattributes` 的行尾规则；不动其它基准项的实现；不新增「跳过基准」或「只打报告不判定」的开关；不改成依赖历史账本的趋势门禁。

不以任何形式打补丁：不加条件挡住慢路径、不用重试掩盖、不留「环境不同就多给预算」的软通道。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 属性规则触发判据）**：`kit/skills/lib/git-status-fast.mjs` 第 `201` 行与第 `348` 行两处判据抽成一个内部函数：输入已跟踪文件清单与规则模式，输出「是否有文件命中」。命中判定不实现属性匹配引擎，只判文件名/扩展名是否命中规则里的模式。两处改调这个函数，删除重复条件。
- [ ] **T2（`C2` 合并提交前缀）**：`kit/skills/lib/git-fast.mjs` 的 `readLooseCommitLogFast` 第 `434` 行，把「遇多父提交即返回失败」改为「停止续读、返回已读前缀、`complete` 标假」；已有条目为零时仍返回失败。核对三个调用处（`flow-inspect.mjs`、`git.mjs`、`survey-workspace.mjs`）对 `complete` 与条目数的既有判断是否仍然成立。
- [ ] **T3（`C3` 校准相对预算）**：`scripts/dev/bench.mjs` 删除 `budgetScale` 与读环境变量的分支；新增校准函数（固定小批文件的读入 + 行切分 + 计数，重复取中位数）得到 `unitMs`；每项的绝对毫秒预算改为「校准工作量比」倍数，收拢成一张常量表并逐项写清比值依据；阈值 = `unitMs × 倍数`。
- [ ] **T4（`C3` 报告字段）**：报告逐项打印校准值、倍数、阈值、实测中位数与余量百分比；`--strict-budget` 语义改为「额外打印校准明细」，不再影响阈值。
- [ ] **T5（`C4` 环境一致性）**：核对删掉放大分支后无任何第二处乘数；用两条环境各跑一次，确认阈值数值逐项相等。
- [ ] **T6（`C5` 实测与余量）**：`--strict-budget` 连跑五次记录每次中位数与余量，确认全部通过且 `survey(self)` 余量不低于 20%；不达标就继续压实现，不动阈值。
- [ ] **T7（`C1`/`C2` 定点用例）**：新增 `scripts/dev/fixtures-perf-budget.mjs` (new)，承接两条正反用例：属性有规则而索引无命中文件时断言快路径生效；索引有命中文件时断言按规则退化。另加两条日志用例：HEAD 为合并提交且某父非合并时返回前缀；父链全为合并时返回失败。
- [ ] **T8（行数核对）**：逐文件核对 `.mjs <= 800` 行。若 `bench.mjs` 加校准后超过 400 行，把校准与预算计算下沉为同目录模块，主脚本只保留编排与报告。
- [ ] **T9（同步）**：`kit/` 改动后重跑 `node scripts/equip.mjs .` 刷新镜像；若改到导出集合或模块边界，同提交同步 `docs/TDD.md` 与 `AGENTS.md` 的对应行。

## 四、验收与合前检查

- [ ] `node scripts/dev/fixtures.mjs --domain perf-budget` 全绿，且 `C1`、`C2`、`C6` 的正例与反例各有一条断言。
- [ ] `node scripts/dev/bench.mjs --strict-budget` 连跑五次全部通过，每次报告都含校准值、倍数、阈值与余量百分比。
- [ ] 设与不设远端环境变量各跑一次，阈值数值逐项相等。
- [ ] 全仓搜不到按环境决定预算阈值的分支。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [ ] 改动未触及未合入的并行切片写域。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
