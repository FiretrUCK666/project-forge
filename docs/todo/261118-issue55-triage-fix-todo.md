---
kind: todo
title: 修复 triage 误判工具名与空面集并补全纯文档自检
status: active
created: 2026-11-18
updated: 2026-11-18
issue: 55
pr: null
branch: feat/triage-fix
owner: FiretrUCK666
approved: true
done_at: null
task_id: issue-55
planned_at: 9e966352f10318a0893c9cb722fe7c0a9f59ab0f
related_prd: ../prd/261117-v8-criteria-trust-prd.md
related_spec: ../specs/261118-issue55-triage-fix-spec.md
---

# 修复 triage 误判工具名与空面集并补全纯文档自检

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-18` / `2026-11-18` |
| 分支 / 基线 | `feat/triage-fix` @ `9e96635` |
| 任务编号 | `issue-55` |
| 负责人 / 审批 | planner-55 / `false` |
| 关联 Issue / PR / SPEC | #55 / 未关联 / `docs/specs/261118-issue55-triage-fix-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交，并在实施前确认所属 SPEC 已获 `approved: true`。

## 任务范围与验证基准

- **影响路径**：`kit/skills/dev-plan/scripts/triage-rules.mjs` (new)、`kit/skills/dev-plan/scripts/doc-audit.mjs`、`scripts/dev/fixtures-doc-triage.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`
- **复用既有模块**：`kit/skills/dev-plan/scripts/doc-audit.mjs` 的 `scanActiveContracts`、`computeCoupledSyncWarnings`、`assessPrdNeed`、`classifyDoorType`
- **本期不做**：不修改 `auditDoc` 可选节/实质性逻辑（归 #56）、不修改 `dev-review` 包（归 #57）、不引入第三方依赖
- **门型与回滚路径**：one-way（触及 `kit/` 高风险分流逻辑）；可直接执行 git revert 反向提交或丢弃隔离分支回退
- **快测命令**：`node scripts/dev/fixtures.mjs --domain doc-triage`

## 验收标准与执行清单

> 每条 `C*` 必须对应一条可运行的命令或断言；完成并自测通过后勾选 `[x]`。**编号与 SPEC 一一对应。**

- [x] C1: （工具名等价性与去特例）运行 `node kit/skills/dev-plan/scripts/doc-plan.mjs triage --summary "doc-plan init 会把可选章节剪光" --json` 以及等价调用（`"planx init 会把可选章节剪光"`、`"survey 会把可选章节剪光"`，含直接调用 `triageTask`），三者的分流档位与动作完全一致（均为非 Case 1，且均不返回 `NO_DOC_DIRECT`）。
- [x] C2: （消除空真与代码符号误触发）实装 `kit/skills/dev-plan/scripts/triage-rules.mjs` (new) 代码/工具掩码与空面集拦截后，`"comment out retry timer"`、`"explain why auth fails"`、`"把 docs.mjs 里的路径正则修一下"`、`"fix doc-audit false positive"`、`"update doc-plan.mjs usage help"`、`"fix typo in doc-audit.mjs"`、`"doc-audit false positive on headings"`、`"doc-template-render.mjs strips optional sections"`、`"给 doc-plan init 加一个 --no-prune 参数"`、`"为什么 doc-plan init 会把可选章节剪光"`，以及传入 `--files kit/skills/lib/docs.mjs` 的 `"fix typo"`，全部不得返回 `caseType: 1`；对缺陷类提示词（如 `"fix doc-audit false positive"`、`"把 docs.mjs 里的路径正则修一下"`、`"explain why auth fails"`）返回 `caseType: 2`（`NO_DOC_RED_GREEN`）。
- [x] C3: （Case 1 正向不误伤与自检不变式）运行 `doc-plan.mjs triage`（输入 `"fix typo in README.md"`、`"补充 CONTRIBUTING.md 的发版说明"`、`"解释一下 dev-plan 的五档分流规则"` 与传入 `--files README.md` 的 `"fix broken phrasing"`），全部返回 `caseType: 1`（`NO_DOC_DIRECT`），且 JSON 输出携带 `pureDocCheck.passed === true` 与非空 `whyPureDocs`、`rejectedCodeSignals.length === 0`；反向验证 `pureDocCheck` 不变式在检测到任意代码/缺陷信号时阻止返回 Case 1。
- [x] C4: （双向夹具、故障注入与全量门禁）`node scripts/dev/fixtures.mjs` 全量通过（支持 `--domain doc-triage` 单独跑 `scripts/dev/fixtures-doc-triage.mjs` (new) 的正反双向断言）；`node scripts/dev/verify-injections.mjs` 验证预留故障注入 `I128..I130`（`I128` 关闭符号掩码、`I129` 恢复 `faces.every` 空真、`I130` 绕过 `pureDocCheck`）全部精准变红且退出码非 `0`；`kit/skills/dev-plan/scripts/doc-audit.mjs` 与 `kit/skills/dev-plan/scripts/triage-rules.mjs` (new) 均不超过 `800` 行；`node scripts/equip.mjs . --check` 与 `merge-gate` 全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 在 `scripts/dev/fixtures-doc-triage.mjs` (new) 补齐 C1–C3 失败复现用例（Red）并在 `scripts/dev/fixtures.mjs` 注册 `doc-triage` | `node scripts/dev/fixtures.mjs --domain doc-triage` 精准失败 | 无 |
| 2 | 新建 `kit/skills/dev-plan/scripts/triage-rules.mjs` (new) 并改造 `kit/skills/dev-plan/scripts/doc-audit.mjs`（掩码、空真防护、`pureDocCheck` 自检） | `node scripts/dev/fixtures.mjs --domain doc-triage` 全绿，两文件均 `<= 800` 行 | 步骤 1 |
| 3 | 运行 `node scripts/equip.mjs .` 同步 `.agents/skills/`，在 `scripts/dev/injections-data.mjs` 补充 `I128..I130` 故障注入并通过全量门禁 | `node scripts/dev/verify-injections.mjs`、`equip --check` 与 `merge-gate` 全绿 | 步骤 2 |

## 断点与遗留决策

- **当前状态**：已完成，无遗留（C1–C4 全部实现与实证通过，`kit/skills/` 与 `.agents/skills/` 字节级同步）。
- **待拍板事项**：无
- **下一步第一件事**：无（待 `finalize`、`verify --mode gate` 与 `submit` 进入独立审查）。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/dev/fixtures.mjs --domain doc-triage`：3 项通过，0 项失败。
  - `node scripts/dev/fixtures.mjs`：228 项通过，0 项失败（9 隔离子进程动态并发）。
  - `node scripts/dev/preflight.mjs`：0 项失败（33 项读数）。
  - `node scripts/dev/verify-injections.mjs --only I128` / `I129` / `I130`：全部精准变红且退出码 `0`（表示 3 条注入均成功捕获）。
  - `node scripts/equip.mjs . --check`、`node scripts/compose-agents.mjs . --check`、`node scripts/review.mjs .`、`node scripts/gap-coverage.mjs`、`node scripts/sync-toc.mjs README.md README.en.md --check`、`node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --strict`：均退出 `0`；文件行数 `triage-rules.mjs` 265 行、`doc-audit.mjs` 771 行（均 `<= 800`）。
- **文档同步检查**：已同步更新 `docs/TDD.md`（登记 `kit/skills/dev-plan/scripts/triage-rules.mjs` 与 `scripts/dev/fixtures-doc-triage.mjs` 及最近更新日期 `2026-11-18`）与 `docs/specs/261118-issue55-triage-fix-spec.md`。
- **遗留问题**：无
