---
kind: todo
title: 全仓深度对齐与去硬编码清理（C1-C7）
status: active
created: 2026-11-22
updated: 2026-11-22
issue: 128
pr: null
branch: fix/w3-repo-alignment
owner: plan-align
plan_mode: interactive
approved: false
done_at: null
task_id: w3-repo-alignment
planned_at: caa5501784549ee86f3abbe7c1607328f51b7517
related_prd: null
related_spec: ../specs/261122-issue128-w3-repo-alignment-spec.md
scope_files: [SKILL.md, AGENTS.md, CONTRIBUTING.md, RELEASING.md, .gitignore, docs/TDD.md, docs/feature-map.json, .github/workflows/check.yml, .github/pull_request_template.md, .github/ISSUE_TEMPLATE/bug_report.md, .github/ISSUE_TEMPLATE/feature_request.md, "templates/**", "references/**", "scripts/*.mjs", "scripts/lib/**", "scripts/dev/bench.mjs", "scripts/dev/cli-parity.mjs", "scripts/dev/gap-coverage.mjs", "scripts/dev/merge-gate.mjs", "scripts/dev/preflight-kernel-parity.mjs", "scripts/dev/preflight-suite.mjs", "scripts/dev/preflight-suite-checks.mjs", "scripts/dev/fixtures-*.mjs", "scripts/dev/injections-data-*.mjs", "kit/skills/**", ".agents/skills/**"]
---

# 全仓深度对齐与去硬编码清理（C1-C7）

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | `fix/w3-repo-alignment` @ `caa5501` |
| 任务编号 | `w3-repo-alignment` |
| 负责人 / 审批 | `plan-align` / `false` |
| 规划态 | `interactive`（三份审计全量吸收，已收敛零待拍板） |
| 关联 Issue / PR / SPEC | #128 / 未关联 / [w3-repo-alignment SPEC](../specs/261122-issue128-w3-repo-alignment-spec.md) |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交，严守所有 `.mjs <= 800L` 与不触碰 `README.md`/`README.en.md`/`assets/readme/*.svg`。

## 任务范围与验证基准

<!-- section: goal -->
- **影响路径**：`kit/skills/lib/platform-registry.mjs` (new)、`kit/skills/**`、`.agents/skills/**`、`scripts/*.mjs`、`scripts/lib/**`、`scripts/dev/**`、`scripts/dev/fixtures-repo-alignment.mjs` (new)、`scripts/dev/injections-data-repo-alignment.mjs` (new)、`templates/**`、`.github/**`、`references/**`、`SKILL.md`、`AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、`.gitignore`、`docs/TDD.md`、`docs/feature-map.json`
- **复用既有模块**：`kit/skills/lib/git-core.mjs`、`platform-probe.mjs`、`github-parse.mjs`、`exit-codes.mjs`、`skill-discovery.mjs`、`doc-substantive.mjs`、`static-gates-lexer.mjs`、`profile.mjs`、`pr-template-hydrate.mjs`、`scripts/lib/protocol.mjs`、`scripts/equip.mjs`、`scripts/compose-agents.mjs`
- **本期不做**：不修改 `README.md`、`README.en.md`、`assets/readme/*.svg`（留给 `#104`）；不引入第三方依赖；不删回归向量 `DOC_REGRESSION_ANCHOR_LOST` / `M0-M5`；不发版。
- **门型与回滚路径**：`two-way`；高风险路径变更须配独立审查与 `I386–I397` 故障注入，回退可用 `git revert` 反向提交。
- **快测命令**：`node scripts/dev/preflight.mjs`
<!-- section: goal-end -->

## 验收标准与执行清单

<!-- section: acceptance -->
> 每条 `C*` 对应明确验证命令或断言；完成并自测通过后勾选 `[x]`。

<!-- criteria:start -->
- [x] C1: 修复模板水合与门禁自相矛盾真 Bug（`templates/agents-project.md:113` 与 `equip-bootstrap.mjs`、`templates/ci-release.yml` 与 `equip-ci.mjs`、`templates/ci-check.yml` 非 Node 生态适配、`docs-tdd.md` 核心节与 `security` 二级标题、`docs-prd.md`/`docs-spec.md`/`doc-plan.mjs:169`），通过 `preflight.mjs`。
- [x] C2: 清除全仓多远端 `generic-git` 与纯本地 `local-only` 的隐性 GitHub 默认（`scripts/review.mjs` 按平台能力对 `collab.*`/`release.absent` 分流且保持 `local-only` 的 `ci.absent` 契约、`registry.mjs`、`ledger.mjs`、`task-backend.mjs`、`flow-*`、`review-sync.mjs`、`workflow-policy-next.mjs`、`govern-*`、`equip-bootstrap.mjs`、`profile.mjs`、`static-gates.mjs`）。
- [x] C3: 彻底收敛双端平台注册表与共享原语至 `kit/skills/lib/`（拆分 `platform-registry.mjs` (new) 保 `platform.mjs <= 800L`，收敛路径/原子写/退出码/分支/技能发现原语与 `kit/` 内部重复常量，`SKILL_INTERNAL_RE` 补 `equip-ci.mjs`，`cli-parity.mjs` 扩至 12 入口并统一 `doc-locate.mjs`/`repo-map.mjs`/`govern-retro.mjs`/`flow-intake.mjs` 的 `printHelp()`），通过 `preflight-kernel-parity.mjs`。
- [x] C4: 全量对齐 `templates/`、`.github/` 与根目录（修复 `issue-template-hydrate.mjs` 空节与裸列表残留、`feature_request.md` 补 `kit/`、对齐 8 技能/`generic-git`/CI/防乱码与 `.gitignore`），严禁修改 `README.md`/`README.en.md`/`assets/readme/*.svg`。
- [x] C5: 全量对齐 `references/`（10 份）、8 份 `kit/skills/*/SKILL.md`、`SKILL.md`（`<= 200L / 16384B`）、`AGENTS.md`（`< 24576B`）、`docs/TDD.md` 与 `docs/feature-map.json`，跑通 `equip.mjs . --check` 与 `compose-agents.mjs . --check`。
- [x] C6: 清理全仓 7 处 `manifest v2 -> v3`、漂移硬编码计数（含 `preflight-suite-checks.mjs` 动态 SVG 统计）、`bench.mjs` `Wave 4`、`survey-plan.mjs` 快照与夹具头立碑注释（保护 `DOC_REGRESSION_ANCHOR_LOST`/`M0-M5`）。
- [x] C7: 新建 `scripts/dev/fixtures-repo-alignment.mjs` (new) 与 `scripts/dev/injections-data-repo-alignment.mjs` (new)（`I386–I397`），全部 `.mjs <= 800L` 并跑通 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`review.mjs .`、`govern-audit.mjs audit .`、导出包校验与 `verify-injections.mjs`。
<!-- criteria:end -->
<!-- section: acceptance-end -->

## 执行步骤

<!-- section: steps -->
| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先建 `fixtures-repo-alignment.mjs` 复现 C1–C4 失败断言（Red） | `node scripts/dev/fixtures.mjs --domain repo-alignment` 变红 | SPEC 获批 |
| 2 | 拆分 `platform-registry.mjs` 并落地 C3 原语收敛与 C2 去隐性 GitHub 默认 | `node scripts/dev/preflight-kernel-parity.mjs` 与 `cli-parity` 通过 | 步骤 1 |
| 3 | 落地 C1 模板水合修复与 C4 全量 `templates/`、`.github/`、根目录对齐 | `node scripts/dev/preflight.mjs` 通过 | 步骤 2 |
| 4 | 落地 C5 文档对齐与 C6 注释/`manifest v3` 清理，重跑 `equip.mjs .` 与 `compose-agents.mjs .` | `equip.mjs . --check` 与 `compose-agents.mjs . --check` 全绿 | 步骤 3 |
| 5 | 补齐 C7 `I386–I397` 注入表并跑全量构建/验证/导出包/故障注入门禁 | 全部门禁与 `I386–I397` 变红复验通过 | 步骤 4 |
<!-- section: steps-end -->

## 风险与应对

<!-- section: risk -->
| 风险 | 触发条件 | 应对方式 |
| --- | --- | --- |
| 临近 800L `.mjs` 文件超限 | 向 `platform.mjs`（794L）、`flow-inspect.mjs`（796L）、`flow-lifecycle.mjs`（795L）、`govern-checks.mjs`（791L）、`docs.mjs`（791L）、`fixtures-onboarding.mjs`（787L）直接追加代码 | 拆出 `platform-registry.mjs` (new) 与 `fixtures-repo-alignment.mjs` (new)，公共辅助收敛到未满载库或 `flow-context.mjs`，严格执行只减不增 |
| `kit/**` 逆向导入 `scripts/lib/**` | 在 `kit/` 直接引用 `scripts/lib/protocol.mjs` | 常量下沉至 `kit/skills/lib/` 并由 `protocol.mjs` 重导出，保持 `arch-rules` 单向依赖 |
| `checkOwnInstances` / `checkTemplates` 失配 | 改 `templates/*` 未同步仓内实例或增删模板变量未同步 `protocol.mjs` | 同步改 `.github/*`、`CONTRIBUTING.md`、`RELEASING.md` 并跑 `preflight.mjs` |
| 误删回归向量或撞车 `#104` | 清理立碑误删 `DOC_REGRESSION_ANCHOR_LOST`/`M0-M5` 或改动 `README*.md`/SVG | 逐行核对只改文件头说明；零触碰 `README.md`、`README.en.md`、`assets/readme/*.svg` |
<!-- section: risk-end -->

## 断点与遗留决策

- **当前状态**：已完成，无遗留（待合并与清理确认）
- **待拍板事项**：无
- **下一步第一件事**：由独立审查代理完成复核后合入默认分支，再经人类确认清理范围执行 `flow.mjs cleanup --confirm`。

## 澄清与补充记录

- （本轮已完整吸收三份全仓只读审计报告并核实相关 `.mjs` 行数与门禁边界，无未决事项。）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（随关联 `SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：
  - `node scripts/dev/preflight.mjs`：通过（40 项读数，0 失败）
  - `node scripts/dev/gap-coverage.mjs`：通过（20 条缺口 100% 配对）
  - `node scripts/dev/fixtures.mjs --jobs 6`：420/420 通过（含 `--domain repo-alignment` 9/9）
  - `node scripts/dev/verify-injections.mjs --jobs 6`：334/334 抓到（含 `I386–I397`）
  - `node scripts/dev/bench.mjs --strict-budget`：6/6 严格预算通过（`mode=strict-1x`）
  - `node scripts/equip.mjs . --check` / `node scripts/compose-agents.mjs . --check`（`22883B < 24576B`）/ `node scripts/sync-toc.mjs README.md README.en.md --check` / `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict`（0 finding）/ `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit . --json`（`failedCount=0`）：均通过
- **文档同步检查**：已同步 `templates/`、`.github/`、`CONTRIBUTING.md`、`RELEASING.md`、10 份 `references/`、8 份 `kit/skills/*/SKILL.md`、`SKILL.md`、`AGENTS.md`、`docs/TDD.md` 与 `docs/feature-map.json`；未触碰 `README.md`、`README.en.md` 与 `assets/readme/*.svg`。
- **遗留问题**：无。
