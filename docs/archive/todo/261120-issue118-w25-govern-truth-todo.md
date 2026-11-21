---
kind: todo
title: 治理真相与规则纠偏实施清单：证据同源、归因去污染、拆条加变体、文档漂移移交
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 118
pr: null
branch: fix/w25-govern-truth
owner: plan-wave25
approved: false
done_at: null
task_id: w25-govern-truth
planned_at: null
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue118-w25-govern-truth-spec.md
plan_mode: interactive
depends_on: []
scope_files: ["scripts/dev/evidence.mjs", "scripts/lib/protocol.mjs", "kit/skills/dev-flow/scripts/flow-lifecycle.mjs", "kit/skills/dev-flow/scripts/flow-context.mjs", "kit/skills/dev-govern/scripts/govern-checks.mjs", "kit/skills/dev-govern/scripts/govern-retro.mjs", "kit/skills/dev-govern/scripts/govern-state.mjs", "scripts/lib/review-helpers.mjs", "scripts/lib/survey-ecosystem.mjs", "scripts/lib/survey-workspace.mjs", "scripts/dev/preflight-suite.mjs", "scripts/dev/fixtures-govern-truth.mjs"]
---

# `w25-govern-truth` 实施 Todo（Issue `#118`）

> 对应 SPEC：[govern-truth SPEC](../specs/261120-issue118-w25-govern-truth-spec.md)
>
> **基线**：`a0fe4df`。本切片无前置，可立即开工。

## 一、要做什么

<!-- section: goal -->
让治理输出与真实一致，把一条错规则改对，并把文档漂移整理成可执行的移交单：

- **证据同源**：发版证据的条目来源改为「同一份排除规则 + 已跟踪文件清单」，条目数与导出包逐项相等；脚本接进会被实际执行到的链路。
- **归因去污染**：确定性与临时路径不参与归因；无归属时如实记「无单一归属文件」。
- **复盘失效判据**：目标已达标或已不存在即不再复现建议，并记账说明。
- **规则可表达本地变体**：陈旧命令先拆条再逐条比对，并允许契约声明「这条远端命令的本地等价形式」；声明必须带差异理由。
- **处置分类**：已注册、已反注册、目录缺失三种状态各给可执行指令。
- **临时目录可见**：未被跟踪且未被忽略且含可执行内容即告警。
- **文档漂移移交**：九条三要素清单交下一波文档重写切片执行。

## 二、不做什么

<!-- section: non-goals -->
不修技术设计文档与契约文档的那些行（交出清单，由下一波整体重写切片执行）；不改交接四态退出码；不改治理严格开关语义；不改契约文件字节预算；不合并十份参考文档；不消灭「本地与远端注入校验并发差异」这件事本身；不加陈旧命令检查的豁免开关；不碰 `docs/archive/`。

不以任何形式打补丁：不给排除名单加枚举前缀、不把流水线脚本抄进文档、不用忽略规则让临时目录隐形、不用「一律按时间过期」处理旧建议、不用开关绕过规则缺陷。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（`C1` 证据同源）**：`scripts/dev/evidence.mjs` 的条目来源改为读同一份排除清单并作用于已跟踪文件清单，删除工作区遍历；核对与导出包条目集合两向差集均为空。
- [ ] **T2（`C8` 接进链路）**：把证据脚本接进一处会被实际执行到的命令链（发版前置或预检的发布前检查），并确认该链路真的会跑到它。
- [ ] **T3（`C2` 归因去污染）**：`flow-lifecycle.mjs` 归因取值前过滤确定性派生清单与临时目录（复用既有派生清单常量）；`flow-context.mjs` 的变更文件排序不再决定归属；过滤后为空记「无单一归属文件」；`govern-checks.mjs` 的热点统计只计已归因信号。
- [ ] **T4（`C3` 复盘失效判据）**：`govern-retro.mjs` 每条建议生成前跑失效判定（已达标 / 目标不存在），命中即跳过并进报告；判定落在建议声明的可观测条件上。
- [ ] **T5（`C4` 拆条）**：`scripts/lib/review-helpers.mjs` 的陈旧命令检查改为先按分隔符拆条再逐条比对（复用命令词法模块的切段能力）；`scripts/lib/survey-ecosystem.mjs` 的命令探测同步按单条输出。
- [ ] **T6（`C4` 本地变体声明）**：契约文件侧支持声明「远端命令 → 本地等价形式」，每条带一句差异理由；比对时优先按本地形式；缺理由即报错；确认「远端带并发、本地不带」这类差异不再被判缺失，同时真缺失仍会报出。
- [ ] **T7（`C5` 处置分类）**：`govern-checks.mjs` 的工作树残留处置按三种状态给指令；确认已反注册孤儿目录的指令实际可执行。
- [ ] **T8（`C6` 临时目录告警）**：`scripts/lib/survey-workspace.mjs` 与 `scripts/dev/preflight-suite.mjs` 加一条检查——未被跟踪、未被忽略且含可执行内容即告警，只告警不阻断；纯空目录不告警。
- [ ] **T9（`C7` 移交清单）**：按 SPEC 2.7 的表逐条复核证据（六个导出名零命中、夹具实际四十六个、脚本实际十个、功能表与地图双向差集、导航模块被两处依赖、更新日期、数量阈值、契约缺四条），确认三要素齐备；本切片不改那两个文档。
- [ ] **T10（夹具与注入）**：新增 `scripts/dev/fixtures-govern-truth.mjs` (new) 承接 `C1..C8` 正反断言；注入三条（证据条目来源改回遍历、拆条逻辑改成不拆、变体声明被忽略）。
- [ ] **T11（行数核对）**：逐文件核对 `.mjs <= 800`；`review-helpers.mjs` 接近上限时把命令切条与变体解析下沉到同目录辅助模块。
- [ ] **T12（同步）**：`kit/` 改动后跑 `node scripts/equip.mjs .`；契约文件的变体声明格式属对外契约变化，同提交同步对应技能文档与 `docs/TDD.md` 的判定说明行（只同步本片实际改动到的判定，不碰文档漂移那九条）。

## 四、验收与合前检查

- [ ] `node scripts/dev/evidence.mjs --json` 的条目集合与该提交导出包文件集合逐项相等（两向差集为空）。
- [ ] `node scripts/review.mjs .` 的陈旧命令一项零命中；删掉契约里一条既无原文覆盖也无形变体声明的真实命令后该项变红；声明变体后该项转绿。
- [ ] 按新规则重算历史信号，确定性派生清单归因条数为零。
- [ ] 对已反注册孤儿目录给出的指令照做可执行。
- [ ] 含可执行内容的未跟踪目录触发告警；纯空未跟踪目录不触发。
- [ ] 移交清单九条三要素齐备且证据逐条复核成立。
- [ ] `node scripts/dev/fixtures.mjs --domain govern-truth` 全绿，`C1..C8` 正反各一条断言。
- [ ] `node scripts/dev/verify-injections.mjs` 全数命中。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
