---
kind: todo
title: Slice 6B：kit 单源化、去自用泄漏与门禁精度升级
status: active
created: 2026-11-22
updated: 2026-11-22
issue: 143
pr: null
branch: docs/w6-universal-architecture-plan
owner: plan-w6
plan_mode: interactive
approved: true
done_at: null
task_id: w6b-kit-single-source-hygiene
planned_at: 836e964ca5bb77e4ce14c1848e280bb15a1e3b9b
related_prd: ../prd/261122-issue143-w6-universal-architecture-prd.md
related_spec: ../specs/261122-issue143-w6b-kit-single-source-hygiene-spec.md
---

# Slice 6B：kit 单源化、去自用泄漏与门禁精度升级

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | 见 Frontmatter `branch` @ `836e964` |
| 任务编号 | `w6b-kit-single-source-hygiene` |
| 负责人 / 审批 | plan-w6 / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #143 / 未关联 / `docs/specs/261122-issue143-w6b-kit-single-source-hygiene-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/subcommand-meta.mjs`(new)、`kit/skills/lib/doc-verify.mjs`、`kit/skills/lib/doc-facts.mjs`、`kit/skills/lib/doc-facts-commands.mjs`(new)、`kit/skills/lib/intake-triage.mjs`、`kit/skills/lib/evidence-substance.mjs`、`kit/skills/lib/no-changelog-voice.mjs`、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/static-gates-comment-hygiene.mjs`、`kit/skills/lib/feature-map.mjs`、`kit/skills/lib/tdd-parity.mjs`、`kit/skills/lib/gate-truth.mjs`、`kit/skills/lib/profile.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/dev-explore/scripts/repo-map-helpers.mjs`(new)、`kit/skills/dev-plan/scripts/triage-rules.mjs`、`kit/skills/dev-plan/scripts/doc-plan.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-review/scripts/review-gates.mjs`、`kit/skills/dev-govern/SKILL.md`、`kit/skills/dev-govern/scripts/govern-audit.mjs`、`kit/skills/dev-govern/scripts/govern-checks.mjs`、`kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs`(new)、`kit/skills/dev-govern/scripts/govern-docs.mjs`、`kit/skills/dev-govern/scripts/govern-evergreen.mjs`、`kit/skills/dev-govern/scripts/govern-tests.mjs`、`kit/skills/dev-verify-tools/scripts/verify-tools.mjs`、`kit/skills/dev-iterate/scripts/iterate.mjs`、`.agents/skills/.pf-manifest.json`、`scripts/dev/subcommand-parity.mjs`(new)、`scripts/dev/preflight-suite.mjs`、`references/plugin-ecosystems.md`、`.github/changelog-voice-baseline.json`、`docs/TDD.md`、`README.md`、`README.en.md`、`scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new)、`scripts/dev/injections-data-w6b.mjs`(new)
- **复用既有模块**：`kit/skills/lib/git-core.mjs`、`kit/skills/lib/static-gates-lexer.mjs`、`kit/skills/lib/profile.mjs`
- **本期不做**：不碰 `scripts/` 安装期与 `dev-flow`/`dev-review` 写域（`flow.mjs`/`review-pack.mjs` 在 6C 接入 `SUBCOMMAND_META`），待 `6A` 合入后基于最新 `main` 实施。
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C7: 单源导出 `SUBCOMMAND_META`（`{ name, mutating }`），统一 `doc-plan.mjs`、`govern-audit.mjs`、`verify-tools.mjs`、`iterate.mjs`、`doc-verify.mjs`、`triage-rules.mjs` 与新增 `scripts/dev/subcommand-parity.mjs`(new)（接入 `scripts/dev/preflight-suite.mjs` 分阶段校验）。
- [ ] C8: `kit/skills/lib/doc-verify.mjs` 与 `kit/skills/lib/doc-facts.mjs` 复用 `COMMON_SKIP_DIRS`、通用多生态只读命令与目标仓 `Dev Profile` 替代 `node|npm|npx|git` 硬编码，扩充多语言后缀。
- [ ] C9: 清零 `kit/` 中全部 `project-forge` 自用逻辑与示例（`intake-triage.mjs` 动态读取目标仓 `AGENTS.md` 与权威文档、`edit-gate.mjs` 与 `govern-tests.mjs` 去掉 `verify-injections|gap-coverage` 硬编码、`evidence-substance.mjs` 等清理），在 `scripts/dev/preflight-suite.mjs` 新增零本仓私有符号静态门禁；`edit-gate.mjs` 补齐 `--base` 与游离 `HEAD` 兼容。
- [ ] C10: 合并 `TOMBSTONE_COMMENT_RE` 与 `kit/skills/lib/no-changelog-voice.mjs` 为单源词形引擎（剥离字面量后同步查 `.mjs` 注释，保留 `TOMBSTONE_COMMENT_RE` 兼容 `shared.mjs:127`），清零存量履历注释并清空 `.github/changelog-voice-baseline.json`；同步 `docs/TDD.md`（去易变计数）、`README.md` / `README.en.md`（补 `scripts/zip.mjs`）与 `kit/skills/dev-govern/SKILL.md`。
- [ ] C11: 提高 `feature-map.mjs`、`repo-map.mjs`、`static-gates.mjs` 与 `dev-govern` 精度（同生态与边界匹配、过滤构建/工作流/测试入口、`UI_VISUAL_EXT_RE` 正则排除测试/夹具路径并导出 `isUiVisualFile`、`TEST_CASE_RE` 排除 `.test(`、`govern-audit --save-baseline --quiet` 不跳过 `tests`/`perf`、`reconcile` 联动 `verify-tools audit`、`govern-docs` 跳过译文 `docs/{lang}/`、`govern-evergreen` 识别 VitePress 根路由与子包路径、`govern-checks` 跳过纯跟踪源码目录 `build/`）；拆小近限文件严守 `<= 800` 行。
- [ ] C12: Slice 6B 新增正反双向夹具（`scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6b.mjs`(new)），运行 `node scripts/equip.mjs .` 保持 `.agents/skills/`（含 `.agents/skills/.pf-manifest.json`）一致，全量门禁与 `govern-audit.mjs audit . --strict` 全绿。
- [ ] C19: 在 `kit/skills/lib/static-gates.mjs`（`scanStructuralHygiene`）、`kit/skills/lib/static-gates-comment-hygiene.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs` 与 `kit/skills/dev-review/scripts/review-gates.mjs` 落地 800 行门禁跨语言自动生成源码豁免与纯声明式数据源码降级（禁按框架文件名硬编码，纯声明式数据置 `declarativeDataFile` 而非 `godFile` 使 `review-gates` 不误报，保留本仓 `kit/` 800 行硬检，混杂业务逻辑的超 800 行文件仍拦截，配正反双向测试）。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 等待 6A 合入 `main` 后，在 `scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new) 先写 C7-C11 与 C19 失败用例 | `node scripts/dev/fixtures.mjs --domain w6b-kit-hygiene` 必须红 | 6A 已合入 |
| 2 | 新建 `subcommand-meta.mjs`(new)、`subcommand-parity.mjs`(new) 与 `doc-facts-commands.mjs`(new)，对齐 6 套表并升级 `preflight-suite.mjs`、`doc-verify.mjs`、`triage-rules.mjs` | `node scripts/dev/preflight.mjs` | 步骤 1 |
| 3 | 清零 `kit/` 自用泄漏并加 `preflight-suite.mjs` 静态门禁；`edit-gate.mjs` 补 `--base`/游离 `HEAD`；合并 `no-changelog-voice.mjs` 与 `TOMBSTONE_COMMENT_RE` 并清空基线 | `node scripts/dev/preflight.mjs` | 步骤 2 |
| 4 | 拆分 `repo-map-helpers.mjs`(new) 与 `govern-checks-hygiene.mjs`(new)，完成 `feature-map` / `static-gates` / `static-gates-comment-hygiene` / `edit-gate` / `review-gates`（含 `C19`） / `dev-govern` 精度升级与文档同步 | `node scripts/equip.mjs .` & `node scripts/sync-toc.mjs README.md README.en.md --check` | 步骤 3 |
| 5 | 补齐 `scripts/dev/injections-data-w6b.mjs`(new) 并全量跑通门禁与严格体检 | `node scripts/dev/verify-injections.mjs --jobs 4` & `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict` | 步骤 4 |

## 断点与遗留决策

- **当前状态**：`进行中`（等待总控规划审核及前置切片 `w6a-survey-handoff-core` 合入后由独立 impl 代理开工）
- **待拍板事项**：无
- **下一步第一件事**：在 `w6a-survey-handoff-core` 合入 `main` 且本 SPEC 获批后，执行 `node .agents/skills/dev-flow/scripts/flow.mjs start --task w6b-kit-single-source-hygiene --case 4 --issue 143`。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：待实施后填写
- **文档同步检查**：待实施后填写
- **遗留问题**：无
