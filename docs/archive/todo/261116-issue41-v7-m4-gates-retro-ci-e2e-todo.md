---
kind: todo
title: v7 M4 静态门禁修复、signals/retro 闭环、三平台 CI 与真 .zip E2E 测试台
status: done
created: 2026-11-16
updated: 2026-11-16
issue: 41
pr: 42
branch: feat/v7-m4-gates-retro-ci-e2e
owner: FiretrUCK666
approved: false
done_at: 2026-11-16
task_id: m4-gates-retro-ci-e2e
planned_at: f06bd03e988aa21dff69b2b5f694ba5825f6accf
related_prd: ../../prd/261115-v7-workflow-architecture-prd.md
related_spec: ../specs/261116-issue41-v7-m4-gates-retro-ci-e2e-spec.md
---

# Todo: v7 M4 静态门禁修复、signals/retro 闭环、三平台 CI 与真 .zip E2E 测试台

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-16` / `2026-11-16` |
| 分支 / 基线 | `main` @ `f06bd03`（关联总控 PRD `docs/prd/261115-v7-workflow-architecture-prd.md`） |
| 任务编号 | `m4-gates-retro-ci-e2e` |
| 负责人 / 审批 | `FiretrUCK666` / `false` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与 `docs/archive/specs/261116-issue41-v7-m4-gates-retro-ci-e2e-spec.md` 及对应工作树最新提交。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/static-gates-lexer.mjs` (new)、`kit/skills/lib/static-gates.mjs`、`kit/skills/lib/doc-templates.mjs`、`kit/skills/lib/tdd-parity.mjs` (new)、`kit/skills/lib/signals.mjs` (new)、`kit/skills/lib/profile-sniffer.mjs`、`kit/skills/lib/shared.mjs`、`kit/skills/dev-govern/scripts/govern-tests.mjs`、`govern-audit.mjs`、`govern-state.mjs`、`govern-retro.mjs` (new)、`kit/skills/dev-flow/scripts/flow-lifecycle.mjs`、`flow-batch.mjs`、`kit/skills/dev-review/scripts/review-ledger.mjs`、`.github/workflows/check.yml`、`.github/workflows/release.yml`、`templates/ci-release.yml`、`scripts/dev/bench.mjs`、`scripts/dev/preflight-contracts.mjs`、`references/plugin-ecosystems.md`、`references/skill-project.md`、`scripts/lib/survey-ecosystem.mjs`、`docs/TDD.md`、`AGENTS.md`、`scripts/dev/e2e-zip-harness.mjs` (new)、`scripts/dev/fixtures-m4.mjs` (new)、`scripts/dev/fixtures.mjs`、`scripts/dev/injections-data.mjs`。
- **复用既有模块**：`scripts/zip.mjs`、`kit/skills/lib/exec.mjs`、`static-gates.mjs`、`doc-templates.mjs`、`govern-state.mjs`、`flow-lifecycle.mjs`、`flow-batch.mjs`、`review-ledger.mjs`、`scripts/dev/preflight-contracts.mjs`。
- **本期不做**：不提前改动 M5 根 `SKILL.md`/5 套件全盘结构重构或双语 `README`/SVG 与总控 PRD 归档；不触发发版标签；全部 `.mjs` 控制 `<= 800` 行。
- **门型与回滚路径**：one-way；于独立分支与隔离工作树开发，已合入后采用 `git revert` 安全回退并重跑全套门禁。
- **快测命令**：`node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs --domain m4`

## 验收标准与执行清单

- [x] C1: 救活零断言/纯 Mock 死检查与扩展静态门禁——抽离 `static-gates-lexer.mjs` (new)，`static-gates.mjs` 纯净 `ASSERTION_RE` 不再匹配 `it()`/`test()`/`def test_` 与小写 `require()`（保留 `GATE_ASSERTION_RE`），`govern-tests.mjs` 精准检出函数内零断言与纯 Mock；完成 Python 三引号词法状态与 `.github/workflows` `deleted-ci-step` 检测并在 `fixtures-m4.mjs` (new) 全绿。
- [x] C2: Mermaid 与 `tdd-parity` 全覆盖——`checkMermaidLabelWidth` 按图种分流校验 `sequenceDiagram`、`stateDiagram`/`stateDiagram-v2`、`erDiagram` 宽度 `16/12` 与禁 HTML；同步收敛 `docs/TDD.md` 状态图超宽边标签；`tdd-parity.mjs` (new) 检出模块/导出/CLI 结构漂移（过滤 `TEST_FILE_RE` 与豁免 `no-tdd`）且 `flow-lifecycle.mjs <= 780` 行。
- [x] C3: `signals.jsonl` 自动沉淀与 `retro` 闭环——`flow verify`、`review-pack record`、`flow rework` 自动通过 `signals.mjs` (new) 加锁写入运行期 `signals.jsonl`；`govern-audit.mjs retro --task`（`govern-retro.mjs` (new)）产出 rule/gate/fixture 建议补丁且 `--apply-patches` 不写坏 `AGENTS.md` 受管区间。
- [x] C4: 三平台 CI、`.zip` 上传回读、宿主清理与 M3 小修并入——`.github/workflows/check.yml`（`shell: bash` + `runner.temp` + 保留 `permissions`/`I49` 锚点）覆盖 `ubuntu`/`windows`/`macos` 并接入 `bench.mjs`（CI 2.5x / 本机 1x）、`verify-injections.mjs`、`e2e-zip-harness.mjs`；`release.yml` 下载并经 `readZip` CRC32 回读核验（`templates/ci-release.yml` 与 `preflight-contracts.mjs` 对拍对齐）；清理 `references/plugin-ecosystems.md` 等私人宿主词（保留 `Obsidian`/`VS Code` 与 `config-patch-plugin`）；收敛 `profile-sniffer.mjs` 与 `flow-batch.mjs` `getCommitChecks`。
- [x] C5: 真 `git archive` `.zip` 安装包 Fake-Agent E2E 测试台——`node scripts/dev/e2e-zip-harness.mjs` (new) 独立基于真实 `.zip` 解压安装包实证跑通 7 大场景、跨会话接管与全部防绕过负面测试，退出码为 0。
- [x] C6: 性能、注入与全门禁全绿——`fixtures.mjs` 默认并发实测 `< 30,000 ms`（通过率 100%），`bench.mjs` 6/6 全过，`verify-injections.mjs`（含 `I70..I75`）全部拦截生效，全量 `.mjs <= 800` 行，完整 `merge-gate` + `--package` 与 `.agents/skills/` 同步全绿。

## 执行步骤

1. 拆分并修复静态内核与信号基础设施：`static-gates-lexer.mjs` (new)、`static-gates.mjs`、`govern-tests.mjs`、`doc-templates.mjs`、`tdd-parity.mjs` (new)、`signals.mjs` (new)、`shared.mjs` —— 验证：`node scripts/dev/preflight.mjs`
2. 生命周期、治理解耦与 M3 收尾小修：`flow-lifecycle.mjs`、`review-ledger.mjs`、`govern-retro.mjs` (new)、`govern-audit.mjs`、`govern-state.mjs`、`profile-sniffer.mjs`、`flow-batch.mjs` —— 验证：`node scripts/dev/fixtures.mjs --domain govern`
3. 跨平台 CI、发布回读、宿主清理与 TDD 校准：`.github/workflows/check.yml`、`.github/workflows/release.yml`、`templates/ci-release.yml`、`scripts/dev/bench.mjs`、`scripts/dev/preflight-contracts.mjs`、`references/plugin-ecosystems.md`、`references/skill-project.md`、`scripts/lib/survey-ecosystem.mjs`、`docs/TDD.md` —— 验证：`node scripts/dev/preflight.mjs`
4. 真 `.zip` E2E 测试台、注入与同仓自举：`scripts/dev/e2e-zip-harness.mjs` (new)、`scripts/dev/fixtures-m4.mjs` (new)、`fixtures.mjs`、`injections-data.mjs`（`I70..I75`）、重跑 `equip.mjs .` / `compose-agents.mjs .` —— 验证：`node scripts/dev/e2e-zip-harness.mjs` + 完整 `merge-gate` + `bench.mjs` + `verify-injections.mjs` + `fixtures.mjs < 30s`

## 断点与遗留决策

- **当前状态**：`已完成，无遗留（Round 1 M4 交付 + Round 2 跨平台 CI 3 项 MUST-FIX 返工均已落盘，提交后于 HEAD 上锁定 finalize + verify --mode gate 并发起 Round 2 独立审查）`
- **待拍板事项**：无

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **Round 2 跨平台返工修复**：
  - `MUST-FIX 1`（`scripts/lib/survey-workspace.mjs`、`scripts/dev/preflight-e2e.mjs`、`scripts/dev/fixtures-m4.mjs`）：detached `HEAD` 且无 `origin/HEAD` 时，优先核对 `refs/heads/*` 与 `refs/remotes/origin/*` 真实存在的候选默认分支再回退 `init.defaultbranch`；`preflight-e2e.mjs` 失败时同步回显 `stdout` 首要 `missing`；`fixtures-m4.mjs` 补齐正反与仅远端引用测试。
  - `MUST-FIX 2`（`scripts/dev/fixtures-equip.mjs`）：扫描缓存目录纳入 macOS `Library/Caches/project-forge` 与 `.cache/project-forge` 并直接遍历 `cacheHome` 校验节流状态不被 `--check` 篡改。
  - `MUST-FIX 3`（`scripts/*.mjs` 与 `kit/skills/**/scripts/*.mjs` 顶层 CLI 入口）：移除异步输出后的 `process.exit(code)`，统一改用 `process.exitCode = code` 等事件循环/管道自然刷新退出，根治 macOS Node 18 `stdout` 截断并同步重跑 `equip.mjs .`。
- **实际验证命令清单**：提交后于最新 `HEAD` 跑通 `flow.mjs verify --mode gate`（含 `preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`compose-agents.mjs . --check`、`equip.mjs . --check`、`review.mjs .`、`sync-toc.mjs`、`verify-injections.mjs`）、`bench.mjs`、`e2e-zip-harness.mjs`、`govern-audit.mjs audit .` 与 `--package` 净包检查。
- **文档同步检查**：已同步更新 `docs/TDD.md`（收窄第 218–219 行状态图边标签并登记 M4 新增模块表与门禁矩阵）、`references/plugin-ecosystems.md`、`references/skill-project.md`、`kit/skills/dev-govern/SKILL.md` 及 `.agents/skills/`；总控 PRD `docs/prd/261115-v7-workflow-architecture-prd.md` 按 1:N 保护保持 `active` 未动。
- **遗留问题**：无（M5 全盘精简对齐与总控 PRD 归档留待后续里程碑）。
