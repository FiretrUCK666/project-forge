---
kind: todo
title: 共享内核去重实施清单：六组已漂移收敛、五组提前收口、同名导出对拍
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 115
pr: null
branch: fix/w25-kernel-dedup
owner: plan-wave25
approved: false
done_at: null
task_id: w25-kernel-dedup
planned_at: null
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue115-w25-kernel-dedup-spec.md
plan_mode: interactive
depends_on: [w25-flow-defects, w25-deadcode-split]
scope_files: ["scripts/lib/text.mjs", "kit/skills/lib/git-core.mjs", "kit/skills/lib/platform-probe.mjs", "scripts/lib/protocol.mjs", "kit/skills/lib/static-gates.mjs", "kit/skills/lib/static-gates-lexer.mjs", "scripts/lib/survey-ecosystem.mjs", "scripts/lib/survey-workspace.mjs", "scripts/lib/survey-reentry.mjs", "kit/skills/dev-govern/scripts/govern-checks.mjs", "kit/skills/dev-govern/scripts/govern-docs.mjs", "kit/skills/lib/workflow-policy.mjs", "kit/skills/lib/empirical-artifacts.mjs", "kit/skills/lib/feature-map.mjs", "kit/skills/lib/verify-state.mjs", "kit/skills/lib/skill-discovery.mjs", "kit/skills/lib/profile.mjs", "kit/skills/lib/profile-sniffer.mjs", "kit/skills/dev-flow/scripts/flow-intake.mjs", "kit/skills/dev-flow/scripts/flow-issues.mjs", "kit/skills/dev-flow/scripts/worktree-deps.mjs", "kit/skills/dev-review/scripts/review-empirical-state.mjs", "kit/skills/dev-review/scripts/review-locks.mjs", "kit/skills/dev-verify-tools/scripts/verify-tools.mjs", "kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs", "scripts/dev/preflight-suite.mjs", "kit/skills/dev-edit/scripts/edit-gate.mjs", "scripts/dev/fixtures-kernel-dedup.mjs"]
---

# `w25-kernel-dedup` 实施 Todo（Issue `#115`）

> 对应 SPEC：[kernel-dedup SPEC](../specs/261120-issue115-w25-kernel-dedup-spec.md)
>
> **基线**：`a0fe4df`。前置：`w25-flow-defects`（引用与路径形状先定）、`w25-deadcode-split`（策略模块先拆出边界）。

## 一、要做什么

<!-- section: goal -->
把「同一份判定」收敛成一处定义，并用机械检查保证不再复发：

- **六组已漂移**收敛到 `kit/skills/lib/` 层，`scripts/lib/` 反向重导出；行为变化逐条用夹具锁住。
- **五组未漂移**一并收口，证据是收敛前后全套夹具逐字节一致。
- **行数口径**收敛到规则定义处；800 行边界在两道门禁上同结论。
- **同名导出对拍**：一处定义、其余重导出，机械可验。
- **四处产物目录名单**按用途分治并写清差异理由，不合成一个集合。

## 二、不做什么

<!-- section: non-goals -->
不合成产物目录集合；不改纯重导出层；不改后端三 class 布局；不拆生态声明式表；不拆探测模块线性降级链、装备脚本线性事务、原子写临时清理返回形状；不动「跳过规划引导」开关；不改 `arch-rules` 方向；不碰 `docs/archive/`。

不以任何形式打补丁：不留「两份实现 + 一条对拍」的双轨、不用注释说明「这两份要一起改」、不保留兼容别名。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（前置核对）**：确认 `w25-flow-defects` 与 `w25-deadcode-split` 已合入或已在同一波次内落地；未落地则等待，不得先把实现搬进尚未拆分的策略模块。
- [ ] **T2（`C1` 读文本与两函数）**：`scripts/lib/text.mjs` 的读文本实现改为从 `kit/skills/lib/git-core.mjs` 重导出，上限统一为 512KB；`text.mjs` 内四处自用改走重导出；版本号归一与仓库关系同样改为重导出。补 300KB 与 600KB 两条断言。
- [ ] **T3（`C2` 仓库路径与 SSH 配置）**：保留 `platform-probe.mjs` 的实现（认裸 slug、接受环境注入），`text.mjs` 重导出；完整仓名依赖一并迁移避免反向引用；解析失败统一表示并在夹具写明。
- [ ] **T4（`C3` 路径规范形）**：路径规范形、同路径判定、主模块判定收敛到 `git-core.mjs`；先跑全套夹具确认无断言依赖「空串 = 当前目录」；再查工作树挂载与卸载的「同一路径」判定走的是哪一份，先补夹具锁住现状再替换。
- [ ] **T5（`C4` 五组未漂移）**：五组同名实现逐组收敛到一处，其余重导出；每组收敛后立即跑全量夹具并要求逐字节一致；`stripWrapQuotes` 与 `stripInlineYamlComment` 一并纳入同名对拍。
- [ ] **T6（`C5` 行数口径）**：行数计算收敛到 `static-gates.mjs` 一处（语义：切分后末尾空项不计）；`preflight-suite.mjs` 与 `edit-gate.mjs` 改调它；补「恰好 800 行」与「末尾有无换行」两组断言。
- [ ] **T7（`C6` 同名对拍）**：`preflight-suite.mjs` 新增同名导出检查：扫描两个内核层的导出声明，同名出现在两个以上定义处即失败（重导出不计），报告给出两处位置。
- [ ] **T8（`C7` 产物目录分治）**：四份名单各自改为带用途的名字，用途声明与条目差异写进同一模块的一张声明表；新增检查核对「声明差异 = 实际差异」。
- [ ] **T9（夹具）**：新增 `scripts/dev/fixtures-kernel-dedup.mjs` (new)，承接 `C1..C7` 每条的正反断言；五组未漂移的收敛证据用「收敛前后全量夹具输出快照比对」形式落盘。
- [ ] **T10（行数核对）**：逐文件核对 `.mjs <= 800`；`text.mjs` 变薄、`git-core.mjs` 变厚，后者超限时把新增部分下沉为同目录独立模块并保留重导出。
- [ ] **T11（同步）**：`kit/` 改动后重跑 `node scripts/equip.mjs .`；导出集合变化同提交同步 `docs/TDD.md` 的模块导出列，以及 `kit/skills/lib/shared.mjs` 的重导出清单（后者本片不改实现，只在其导出面变化时同步）。

## 四、验收与合前检查

- [ ] `node scripts/dev/fixtures.mjs` 全量通过（本片判据需要全量，不接受按域子集）。
- [ ] 同名导出对拍存在且正反各有一条断言：复制一份同名定义会红，改成重导出会绿。
- [ ] 行数口径只有一处实现；恰好 800 行的文件在两道门禁上同结论。
- [ ] 四处产物目录名单的声明差异与实际差异逐条一致。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [ ] 改动未触及未合入的并行切片写域；`workflow-helpers.mjs` 的波次函数零改动。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
