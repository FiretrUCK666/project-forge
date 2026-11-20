---
kind: todo
title: 流程缺陷收口实施清单：引用成一等对象、降级显式报出、未适用独立成档
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 116
pr: null
branch: fix/w25-flow-defects
owner: plan-wave25
approved: false
done_at: null
task_id: w25-flow-defects
planned_at: null
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue116-w25-flow-defects-spec.md
plan_mode: interactive
depends_on: []
scope_files: ["kit/skills/lib/github-parse.mjs", "kit/skills/dev-flow/scripts/flow-intake.mjs", "kit/skills/dev-flow/scripts/flow-inspect.mjs", "kit/skills/dev-flow/scripts/flow-batch.mjs", "kit/skills/dev-flow/scripts/flow-next.mjs", "kit/skills/dev-flow/scripts/flow.mjs", "kit/skills/dev-iterate/scripts/iterate-cycle.mjs", "kit/skills/dev-iterate/scripts/iterate.mjs", "kit/skills/dev-plan/scripts/doc-audit-repo.mjs", "kit/skills/dev-edit/scripts/edit-gate.mjs", "scripts/equip.mjs", "scripts/survey.mjs", "scripts/dev/fixtures-flow-defects.mjs"]
---

# `w25-flow-defects` 实施 Todo（Issue `#116`）

> 对应 SPEC：[flow-defects SPEC](../specs/261120-issue116-w25-flow-defects-spec.md)
>
> **基线**：`a0fe4df`。本切片无前置，可立即开工。

## 一、要做什么

<!-- section: goal -->
把这些「静默」改成「如实说出」，并让引用在整条链上不失真：

- **引用**：解析处保留目标仓与原始串；写操作前先判目标仓唯一性；两条入口共用一份判定。
- **报出**：校验拒绝给修法；写入产生待裁决冲突不得退 0；路径先归一再解析；三个输入通道的丢弃、失败与截断全部显式。
- **判据独立**：起步态与纯文档项目各自独立判定，不再互相推导。
- **未适用**：零目标范围的审计与门禁报「未适用」并返回非零，不得折成通过。

## 二、不做什么

<!-- section: non-goals -->
不改「未提及是否等于已解决」的账本语义（归 `#113`）；不改受管区间与手写区边界；不改真幂等与写前快照；不改停损机制本身；不改工作树清理的确认闸与解绑顺序；不新增关掉检查的开关；不碰 `docs/archive/`。

不以任何形式打补丁：不加条件挡住「不认识」的输入、不用重试掩盖解析失败、不留「空集也算通过」的软通道。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 引用一等对象）**：`github-parse.mjs` 的完整引用入口提升为基础实现，旧数字入口改为薄包装；`flow-intake.mjs` 与 `flow-inspect.mjs` 的自定义解析改为调用同一实现；`flow-intake.mjs` 增加写操作前的目标仓唯一性判定，跨仓阻断并给出下一步文案；两条入口接受同一批位置参数写法。
- [ ] **T2（`C2` 拒绝带修法 + 两路径同结论）**：`scripts/equip.mjs` 的报告格式化对每类问题补一句可执行修法；写入路径在产生待裁决冲突时返回非零；核对两条路径对同一输入给出同一结论。
- [ ] **T3（`C3` 起步态独立判据）**：`survey.mjs` 增加「无源码且提交数不超过极小阈值」的起步态；技术设计文档条目的跳过判据改为读起步态，不再直接吃项目类型；保留长历史纯文档仓库的原判定。
- [ ] **T4（`C4` 路径归一 + 三通道报出）**：`review-locks.mjs` 的文件行号解析前统一路径归一（复用 `git-core.mjs` 的归一工具）；`iterate-cycle.mjs` 的待拍板门禁、进度历史、轮次上限三处改为带原因的返回结构，报出项、失败原因与截断告警；`iterate.mjs` 把三者写进报告。
- [ ] **T5（`C5` 输出通道）**：`flow-inspect.mjs` 非 JSON 模式列出未使用输入；`flow-batch.mjs` 零条目不落盘；`flow-next.mjs` 与 `flow.mjs` 的正文命令在未装套件时与提示同降级；`flow.mjs` 帮助按任务组织并写明参数归属子命令。
- [ ] **T6（`C6` 未适用独立成档）**：`doc-audit-repo.mjs` 在目标集合为空时返回带「未适用」与两种情形区分的结果，`doc-plan.mjs` 侧退出码非零；`edit-gate.mjs` 无目标文件时输出未适用并返回「有事先处理」档，不返回通过档。
- [ ] **T7（`C7` 与 `#113` 核对）**：确认同一问题判定与轮次收口两处全仓零改动；若 `#113` 已合入则只跑夹具确认，若未合入则确认本片输出中不含对该语义的第二份实现。
- [ ] **T8（夹具）**：新增 `scripts/dev/fixtures-flow-defects.mjs` (new)，承接 `C1..C7` 每条的正反断言。
- [ ] **T9（行数核对）**：逐文件核对 `.mjs <= 800` 行，重点 `flow-inspect.mjs` 与 `equip.mjs`；超限则把报出与格式化下沉到同目录辅助模块。
- [ ] **T10（同步）**：`kit/` 改动后重跑 `node scripts/equip.mjs .` 刷新镜像；CLI 行为变化同提交同步对应技能文档与 `docs/TDD.md` 相关行。

## 四、验收与合前检查

- [ ] `node scripts/dev/fixtures.mjs --domain flow-defects` 全绿，`C1..C7` 每条正反各一条断言。
- [ ] 对零目标范围执行审计，退出码非零且输出含「未适用」。
- [ ] 本地有同号单据时跨仓引用被阻断，写操作未发生。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [ ] 改动未触及未合入的并行切片写域（`workflow-policy.mjs`、`workflow-helpers.mjs`、`git-core.mjs`、`git-status-fast.mjs`、`bench.mjs` 均不在本片写域）。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
