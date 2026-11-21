---
kind: todo
title: 功能地图与验证工具自校实施清单：路径进指纹、未执行成态、盲区全量、地图自检
status: active
created: 2026-11-20
updated: 2026-11-20
issue: 117
pr: null
branch: fix/w25-verify-map
owner: plan-wave25
approved: false
done_at: null
task_id: w25-verify-map
planned_at: null
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue117-w25-verify-map-spec.md
plan_mode: interactive
depends_on: [w25-kernel-dedup]
scope_files: ["kit/skills/dev-verify-tools/scripts/verify-tools.mjs", "kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs", "kit/skills/lib/verify-state.mjs", "kit/skills/lib/feature-map.mjs", "docs/feature-map.json", "kit/skills/dev-verify-tools/SKILL.md", "scripts/dev/fixtures-verify-map.mjs", "scripts/dev/verify-injections.mjs"]
---

# `w25-verify-map` 实施 Todo（Issue `#117`）

> 对应 SPEC：[verify-map SPEC](../specs/261120-issue117-w25-verify-map-spec.md)
>
> **基线**：`a0fe4df`。前置：`w25-kernel-dedup`（合并后的内核是校对对象）。

## 一、要做什么

<!-- section: goal -->
让功能地图真的能校对：

- **路径进指纹**：脚本路径参与指纹；为空即缺陷；「无单一脚本」必须显式声明。
- **未执行成态**：零执行是独立结论，退出码非零，不进通过计数。
- **过期只报不写**：跑通过不写基线；刷新必须显式并写明理由与前值。
- **盲区全量**：源码层与模板层逐个判覆盖，零覆盖逐条列出。
- **新能力归位**：三个模块与两个开关进既有功能，不新开空壳。
- **地图自检工具**：一条已登记工具验地图自身完整性。

## 二、不做什么

<!-- section: non-goals -->
不改共享内核实现（归 `w25-kernel-dedup`）；不改风险分级阈值与语义；不删任何现有工具记录；不改「未采基线」的时间语义；不加跳过审计的开关；不动临时目录结构；不把三十四个夹具写进地图。

不以任何形式打补丁：不把过期自动重写基线后再加一句「曾经过期」的提示、不把未执行降级成警告、不用「地图是合法 JSON」冒充完整性。
<!-- section: non-goals-end -->

## 三、实施任务清单

- [ ] **T1（前置核对）**：确认 `w25-kernel-dedup` 已合入；未合入则等待，不先建新工具。
- [ ] **T2（`C1` 路径进指纹）**：`feature-map.mjs` 的指纹计算纳入工具脚本路径；`verify-tools-audit.mjs` 对每条记录判「路径为空 / 不存在 / 存在但未声明无单一脚本」三种情形；命令字符串里的路径逐条提取并判存在，提取不到的标注未校验。
- [ ] **T3（`C2` 未执行成态）**：`verify-tools.mjs` 在零匹配与全部被跳过两种情形下输出未执行、退出码非零、不进通过计数；报告文案说明「一条都没跑」。
- [ ] **T4（`C3` 写基线条件收窄）**：`verify-tools.mjs` 的写基线判定收窄为「首次」或「显式刷新」；跑通过但过期只报不写；显式刷新写进报告，含刷新前基线提交与理由。
- [ ] **T5（`C4` 盲区全量）**：`verify-tools-audit.mjs` 的盲区计算改为遍历源码层与模板层全部文件；模板层按目录整体判并在报告给出份数；零覆盖项逐条列出；夹具与注入项排除。
- [ ] **T6（`C5` 新能力归位）**：`docs/feature-map.json` 登记三个零登记模块与两个零提及开关，归位到既有功能；零引用夹具登记为测试引用。
- [ ] **T7（`C6` 显式刷新）**：对被自己堵死的那条高风险工具执行显式刷新，报告写明刷新原因与来源切片标识；确认该项审计零阻断。
- [ ] **T8（`C7` 地图自检工具）**：新增一条已登记验证工具，验地图三种缺陷：脚本路径为空、命令路径不存在、模块登记指向不存在文件；登记进地图并采基线。
- [ ] **T9（夹具与注入）**：新增 `scripts/dev/fixtures-verify-map.mjs` (new) 承接 `C1..C7` 正反断言；在 `scripts/dev/verify-injections.mjs` 追加两条注入（路径指纹去掉、过期判定恒不过期）。
- [ ] **T10（行数核对）**：逐文件核对 `.mjs <= 800`；`verify-tools-audit.mjs` 超限时把盲区计算与僵尸检测各下沉为同目录独立模块。
- [ ] **T11（同步）**：`kit/` 改动后重跑 `node scripts/equip.mjs .`；`kit/skills/dev-verify-tools/SKILL.md` 的判定说明与退出码语义随同更新；`docs/TDD.md` 对应模块行同步。

## 四、验收与合前检查

- [ ] `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit .` 输出中零覆盖项非空且逐条列出。
- [ ] `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs run --json` 无选择器时退出码非零且标未执行。
- [ ] 掏空任一已登记脚本后审计报过期；清空脚本路径后报缺陷；命令路径不存在时报僵尸。
- [ ] `node scripts/dev/fixtures.mjs --domain verify-map` 全绿，`C1..C7` 正反各一条断言。
- [ ] `node scripts/dev/verify-injections.mjs` 全数命中。
- [ ] `node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs` 全绿。
- [ ] `.agents/skills/` 与 `kit/skills/` 字节级一致。
- [ ] `doc-plan.mjs audit . --json` 返回 `ok: true`。
