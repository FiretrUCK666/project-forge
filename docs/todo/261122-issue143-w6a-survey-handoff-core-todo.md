---
kind: todo
title: Slice 6A：通用 S1 勘察、多生态发现与长青交棒合同
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
task_id: w6a-survey-handoff-core
planned_at: 836e964ca5bb77e4ce14c1848e280bb15a1e3b9b
related_prd: ../prd/261122-issue143-w6-universal-architecture-prd.md
related_spec: ../specs/261122-issue143-w6a-survey-handoff-core-spec.md
---

# Slice 6A：通用 S1 勘察、多生态发现与长青交棒合同

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-22` / `2026-11-22` |
| 分支 / 基线 | 见 Frontmatter `branch` @ `836e964` |
| 任务编号 | `w6a-survey-handoff-core` |
| 负责人 / 审批 | plan-w6 / `false` |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联 Issue / PR / SPEC | #143 / 未关联 / `docs/specs/261122-issue143-w6a-survey-handoff-core-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与对应分支最新提交。

## 任务范围与验证基准

- **影响路径**：`scripts/survey.mjs`、`scripts/backup.mjs`、`scripts/handoff.mjs`、`scripts/review.mjs`、`scripts/compose-agents.mjs`、`scripts/equip.mjs`、`scripts/lib/protocol.mjs`、`scripts/lib/text.mjs`、`scripts/lib/render.mjs`、`scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs`、`scripts/lib/survey-ecosystem.mjs`、`scripts/lib/survey-workspace.mjs`、`scripts/lib/survey-workspace-secrets.mjs`(new)、`scripts/lib/agents-defaults.mjs`、`scripts/lib/equip-bootstrap.mjs`、`scripts/lib/compose-agents-helpers.mjs`(new)、`templates/agents-project.md`、`AGENTS.md`、`kit/skills/lib/credential-scan.mjs`、`kit/skills/lib/git-core.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`kit/skills/lib/profile-sniffer-packages.mjs`(new)、`.agents/skills/.pf-manifest.json`、`scripts/dev/cli-parity.mjs`、`scripts/dev/fixtures-w6a-survey-handoff.mjs`(new)、`scripts/dev/fixtures-flow-parallel.mjs`、`scripts/dev/injections-data-w6a.mjs`(new)
- **复用既有模块**：`kit/skills/lib/credential-scan.mjs`、`kit/skills/lib/git-core.mjs`、`scripts/lib/protocol.mjs`、`scripts/lib/template.mjs`、`scripts/lib/render.mjs`
- **本期不做**：不修改 6B (`kit/` 单源化与治理精度) 与 6C (`dev-flow` / `dev-review` 与跨仓/并发/角色溯源) 写域内文件，不修改 `docs/TDD.md` 与 `README*.md`。
- **门型与回滚路径**：two-way；局部可逆改动，直接 git revert 或删除临时分支即可回退。
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

- [ ] C1: `scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs` 与 `scripts/review.mjs` 按工作流文件+job 粒度结构化判定 `pull_request_target` 与不安全 PR checkout，豁免 `pull_request.number` 与 `# zizmor: ignore[dangerous-triggers]`；补齐 `uv publish`、`dotnet ... publish`、`jsr publish`、`vp pack` 与 `simple-git-hooks` / `.git/hooks/*` 检测。
- [ ] C2: `scripts/lib/survey-ecosystem.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`scripts/lib/agents-defaults.mjs` 与 `kit/skills/lib/git-core.mjs` 支持 `.slnx`、`jsr.json` / `deno.json`、`pnpm-workspace.yaml` 继承、`!` 负向 glob 与 `hasManifest` 边界；探测根 Linter/Formatter 输出 `.agents/` 忽略隔离方案；`survey()` 严格零写入（取消误写 `session-state.json`）。
- [ ] C3: `scripts/backup.mjs` 取消 512KB `index.json` 读取截断上限；`scripts/handoff.mjs` `--verify` 将锁文件、大数据非工程文件及有意软链豁免出 `truncated` 退出码 `3`，区分持续 `--upgrade` 受管态（通过）与 `--strict-clean`（要求剥离），并在 `scripts/dev/cli-parity.mjs` 登记 `--strict-clean`。
- [ ] C4: `kit/skills/lib/credential-scan.mjs`、`scripts/lib/survey-workspace.mjs` 与 `scripts/review.mjs` 识别 `${...}` 动态 PEM 模板字面量、扫描 `.env*` 测试夹具正文、为 `secrets.tracked` 与 `secrets.exposed` 统一接入 `decision: 'secrets-are-placeholders'`，且 `git.output-dirs` 跳过全部受 Git 跟踪或 `.gitignore` `!` 显式放行的目录。
- [ ] C5: `templates/agents-project.md`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/equip-bootstrap.mjs` 与 `scripts/compose-agents.mjs` 精简受管模板骨架（落盘空骨架 `< 16KB`，14KB 存量 `AGENTS.md` 可无损 `--upgrade`）并运行 `node scripts/compose-agents.mjs .` 同步本仓 `AGENTS.md`（保留 `preflight-suite.mjs` / `preflight-contract-rules.mjs` 必检契约与 7 步结构），彻底消除 `CONVENTIONS_HINT` / `暂未追加...` / `目录结尾带 /...` 等 AI 指导语泄漏并保留既有小写 `agents.md` / 软链指向；拆小近限文件使全部 `.mjs` `<= 800` 行。
- [ ] C6: Slice 6A 新增正反双向夹具（`scripts/dev/fixtures-w6a-survey-handoff.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6a.mjs`(new)）且同步 `.agents/skills/`（含 `.agents/skills/.pf-manifest.json`），`node scripts/dev/preflight.mjs`、`node scripts/dev/gap-coverage.mjs`、`node scripts/dev/fixtures.mjs --jobs 6` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿。

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 在 `scripts/dev/fixtures-w6a-survey-handoff.mjs`(new) 先写 C1-C5 复现失败用例 | `node scripts/dev/fixtures.mjs --domain w6a-survey-handoff` 必须红 | 无 |
| 2 | 升级 `git-core.mjs` / `credential-scan.mjs` 并拆分 `profile-sniffer-packages.mjs`(new) 与 `survey-workspace-secrets.mjs`(new) | `node scripts/dev/preflight.mjs` | 步骤 1 |
| 3 | 完成 `survey-docs.mjs`、`survey-ecosystem.mjs`、`survey.mjs`、`backup.mjs`、`handoff.mjs`（含 `cli-parity.mjs` 登记）、`review.mjs`、`equip.mjs` 改造 | `node scripts/dev/fixtures.mjs --domain w6a-survey-handoff` | 步骤 2 |
| 4 | 精简 `templates/agents-project.md`、拆分 `compose-agents-helpers.mjs`(new)、运行 `compose-agents.mjs .` 与 `equip.mjs .` | `node scripts/compose-agents.mjs . --check` & `node scripts/equip.mjs . --check` | 步骤 3 |
| 5 | 补齐 `scripts/dev/injections-data-w6a.mjs`(new) 并全量跑通验证与故障注入 | `node scripts/dev/verify-injections.mjs --jobs 4` & `node scripts/dev/merge-gate.mjs` | 步骤 4 |

## 断点与遗留决策

- **当前状态**：`进行中`（待规划审批后由独立 impl 代理接手实施）
- **待拍板事项**：无
- **下一步第一件事**：按 SPEC 批准后运行 `node .agents/skills/dev-flow/scripts/flow.mjs start --task w6a-survey-handoff-core --case 4 --issue 143` 启动隔离实施槽位。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**（有 PR 时随关联 `PRD`/`SPEC` 一并经 `flow.mjs finalize` 成对归档至 `docs/archive/todo/`，不另开只改记录的 PR）

- **实际验证命令与结果**：待实施后填写
- **文档同步检查**：待实施后填写
- **遗留问题**：无
