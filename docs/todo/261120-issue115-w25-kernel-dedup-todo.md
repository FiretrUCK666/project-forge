---
kind: todo
title: PR-B（#115）共享内核去重、平台收口、验证治理与性能预算 Todo
status: active
tier: L3
created: 2026-11-20
updated: 2026-11-22
issue: 115
pr: null
branch: feat/w25-kernel-dedup
owner: plan-prb
approved: false
implemented: false
related_prd: ../prd/261120-w25-hardening-prd.md
related_spec: ../specs/261120-issue115-w25-kernel-dedup-spec.md
high_risk_paths:
  - kit/
  - scripts/lib/
  - scripts/dev/
  - templates/
  - AGENTS.md
task_id: w25-kernel-dedup
depends_on: []
scope_files:
  - kit/skills/lib/git-core.mjs
  - kit/skills/lib/git-status-fast.mjs
  - kit/skills/lib/git-fast.mjs
  - kit/skills/lib/platform.mjs
  - kit/skills/lib/platform-probe.mjs
  - kit/skills/lib/task-backend.mjs
  - kit/skills/lib/task-backend-local.mjs
  - kit/skills/lib/issue-template-hydrate.mjs
  - kit/skills/lib/escalation.mjs
  - kit/skills/lib/plan-sync.mjs
  - kit/skills/lib/doc-locator.mjs
  - kit/skills/lib/feature-map.mjs
  - kit/skills/lib/verify-state.mjs
  - kit/skills/lib/static-gates.mjs
  - kit/skills/lib/static-gates-lexer.mjs
  - kit/skills/lib/static-gates-comment-hygiene.mjs
  - kit/skills/dev-explore/scripts/doc-locate.mjs
  - kit/skills/dev-plan/scripts/doc-plan.mjs
  - kit/skills/dev-flow/scripts/flow-issues.mjs
  - kit/skills/dev-flow/scripts/worktree-deps.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs
  - kit/skills/dev-flow/scripts/flow-lifecycle.mjs
  - kit/skills/dev-review/scripts/review-empirical-state.mjs
  - kit/skills/dev-edit/scripts/edit-gate.mjs
  - kit/skills/dev-edit/SKILL.md
  - kit/skills/dev-review/SKILL.md
  - kit/skills/dev-verify-tools/scripts/verify-tools.mjs
  - kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs
  - kit/skills/dev-govern/scripts/govern-audit.mjs
  - kit/skills/dev-govern/scripts/govern-checks.mjs
  - kit/skills/dev-govern/scripts/govern-retro.mjs
  - scripts/lib/fs-atomic.mjs
  - scripts/lib/protocol.mjs
  - scripts/lib/text.mjs
  - scripts/lib/update-ops.mjs
  - scripts/lib/platform/github.mjs
  - scripts/lib/platform/registry.mjs
  - scripts/lib/survey-ecosystem.mjs
  - scripts/lib/survey-workspace.mjs
  - scripts/lib/equip-bootstrap.mjs
  - scripts/lib/agents-defaults.mjs
  - scripts/survey.mjs
  - scripts/compose-agents.mjs
  - scripts/lib/review-helpers.mjs
  - scripts/equip-ci.mjs
  - scripts/dev/evidence.mjs
  - scripts/dev/preflight.mjs
  - scripts/dev/preflight-suite.mjs
  - scripts/dev/preflight-kernel-parity.mjs
  - scripts/dev/bench.mjs
  - scripts/dev/fixtures.mjs
  - scripts/dev/fixtures-verify-tools.mjs
  - scripts/dev/fixtures-govern.mjs
  - scripts/dev/e2e-zip-harness.mjs
  - scripts/dev/merge-gate.mjs
  - scripts/dev/injections-data-kernel-dedup.mjs
  - docs/feature-map.json
  - AGENTS.md
  - docs/prd/261120-w25-hardening-prd.md
  - docs/specs/261120-issue114-w25-perf-budget-spec.md
  - docs/todo/261120-issue114-w25-perf-budget-todo.md
  - docs/specs/261120-issue117-w25-verify-map-spec.md
  - docs/todo/261120-issue117-w25-verify-map-todo.md
  - docs/specs/261120-issue118-w25-govern-truth-spec.md
  - docs/todo/261120-issue118-w25-govern-truth-todo.md
  - docs/specs/261120-issue119-w25-deadcode-split-spec.md
  - docs/todo/261120-issue119-w25-deadcode-split-todo.md
---

# PR-B（#115）实施任务清单

## 一、目标

<!-- section: goal -->
在独立 worktree `feat/w25-kernel-dedup` 完成 PR-B（`C1–C8`）全量落地：收敛共享内核、收口多远端/无远端平台注册表、统一四路 Issue 模板水合与首次接入零误报、落地 `verify-tools` 脚本指纹并刷新 `feature-map.json`、修复 `govern` 真实性与三项确定性注释卫生、修复快路径与并发预算、规范退役冗余草案并完成 `I370–I385` 故障注入与双向回归。

## 二、非目标

<!-- section: non-goals -->
- 不改动 PR-A（`#120`）波次/规划隔离核心；不新增第 9 个 skill 或独立 ADR 目录。
- 不修改逼近 800 行的非目标文件（`flow-inspect.mjs`、`docs.mjs`、`profile-sniffer.mjs`、`flow-merge.mjs`、`equip.mjs`）。
- 不削弱默认全量 `preflight` 与 `merge-gate` 校验强度。

## 三、实施任务清单

<!-- section: tasks -->
- [x] **T1（`C1` 共享内核去重与 `#119` 死代码清理）**: 将 `readTextSafe`、`isMacOsJunkPath`、`isInsideDir(candidateAbs, parentAbs)` 收敛至 `kit/skills/lib/git-core.mjs` 并修复 `scripts/lib/update-ops.mjs` 反序 bug；将 `parseSshConfigHostMap`/`lookupSshHost` 统一于 `kit/skills/lib/platform.mjs`；将 `countTextLines` 统一于 `kit/skills/lib/static-gates.mjs` 并重导出至 `protocol.mjs` 与 `edit-gate.mjs`；删除 `fs-atomic.mjs` `parentOf` 与 `protocol.mjs`/`text.mjs`/`survey-workspace.mjs`/`survey-ecosystem.mjs` 零引用死代码；新增 `scripts/dev/preflight-kernel-parity.mjs` (new) 固化 `--slot` 零残留与重复原语检查。
- [x] **T2（`C2` 多远端/无远端注册表与规划远端同步收口）**: 对齐 `scripts/lib/platform/github.mjs`+`registry.mjs` 与 `kit/skills/lib/platform.mjs` 双侧 `GITHUB_PROVIDER` 与 `registerHostingProvider` 适配器契约校验；将 `LocalOnlyBackend`/`GenericRemoteBackend` 从 `kit/skills/lib/task-backend.mjs` 拆入 `kit/skills/lib/task-backend-local.mjs` (new)，并使 `createTaskBackend` 走注册表分发；修改 `scripts/equip-ci.mjs` 消费 `scripts/survey.mjs` `computeArtifactPlan` 产出的 `facts.artifactPlan`；将 `detectDeclaredRepo` 与 `survey-ecosystem.mjs` 改为注册表解析去宿主化；在 `kit/skills/lib/plan-sync.mjs` 提取 `resolveDocIssueNumber` 并修复 `doc-plan.mjs` `critique-pass`/`critique-reject`/`approve` 透传 `issueNumber`。
- [x] **T3（`C3` 统一 `hydrateIssueBody` 与首次接入零误报）**: 新建 `kit/skills/lib/issue-template-hydrate.mjs` (new) 实现 `hydrateIssueBody`（保留 `.github/ISSUE_TEMPLATE/`、剥离围栏外 `<!-- ... -->`、归一化 `\n`、`local-only`/`generic-git` 干净降级），并接入 `flow issue create`、`flow start --create-issue`、`escalation.mjs` 与 `govern-audit issues`；在 `scripts/lib/equip-bootstrap.mjs` 为空仓落盘合法空 `docs/feature-map.json` 并使 `verify-tools audit` 降级 `NOT_APPLICABLE`；`doc-locator.mjs` 将 `references/` 纳入 `contextIndex` 且 `doc-locate.mjs` 支持 `--list`；修复 `scripts/compose-agents.mjs` 与 `scripts/lib/agents-defaults.mjs` 单次幂等。
- [x] **T4（`C4` `#117` 验证工具指纹与功能地图刷新）**: 更新 `kit/skills/lib/verify-state.mjs`（由 `feature-map.mjs` 重导出）`computeFeatureFingerprint` 纳入 `scriptPath` 内容哈希及路径边界校验；更新 `verify-tools.mjs` / `verify-tools-audit.mjs` 落地零执行非零退出、禁止 stale 通过时静默覆写基线，并在 `verify-state.mjs` 记录 `verify.scratch-used`；执行 `node scripts/equip.mjs .` 后刷新 `docs/feature-map.json` 与全部验证工具，清除已归档 `#116` 僵尸引用，实现 `verify-tools audit` 0 stale / 0 zombies / 0 blindSpots。
- [x] **T5（`C5` `#118` 治理真实性与三项注释卫生升级）**: 将 `scripts/dev/evidence.mjs` 改为 `git ls-files -z` + `!isRepoOnlyPath`；在 `flow-lifecycle-helpers.mjs`/`flow-lifecycle.mjs` 排除 `.pf-manifest.json` 信号 blame；修复 `govern-checks.mjs` `orphan_dir` 清理提示、`govern-retro.mjs` 失效建议淘汰与 `review-helpers.mjs` 命令匹配；落地三项确定性注释升级（缺 Issue 的 `HACK`/`WORKAROUND`/`TEMP` 引导 `escalation.mjs`、新建 `kit/skills/lib/static-gates-comment-hygiene.mjs` (new) 检查 `--changed` + 基线棘轮反引号失效路径、更新 `dev-edit`/`dev-review` `SKILL.md` why-not-what 与 `docs/TDD.md`/`AGENTS.md ## 取舍` 规则并同步 `.agents/skills/`）。
- [x] **T6（`C6` `#114` 快路径、增量门禁、安全并发与 1x 硬预算）**: 修复 `git-status-fast.mjs` `eol=crlf` 按文件匹配回退、`git-fast.mjs` `readGitConfigFast` 在 linked worktree 解析 `commondir/config` 与 `readLooseCommitLogFast` 多父合并提交，配与原生 `git` 及 linked worktree 正反测试；为 `preflight.mjs`/`preflight-suite.mjs` 新增 `--changed` 增量模式；移除 `bench.mjs` 2.5x CI 缩放并实现 `--strict-budget` 1x 硬预算；在 `e2e-zip-harness.mjs`（隔离 `H/I/J` `mockSrv`）、`merge-gate.mjs`、`fixtures.mjs` 对纯只读/独立沙盒步骤实施安全有界并发，保持确定性输出与等价退出码。
- [x] **T7（`C7` 无冲突顺序退役吸收草案与 `w25-hardening-prd`）**: `finalize` 前先用 `doc-plan.mjs supersede` + `git mv`（禁调 `buildArchivedDocPatch` 覆写）归档 `#114`/`#117`/`#118`/`#119`，再勾选 `docs/prd/261120-w25-hardening-prd.md` `C1..C7`（暂留 `docs/prd/` 防 `BROKEN_RELATED_LINK`），最后经 `flow finalize` 原子共归档 `#115` 与 PRD（`status: done`），验证 `doc-plan.mjs audit . --json` 仅保留 `v10.1` 主 PRD + `#103` + `#104` 且零报错。
- [x] **T8（`C8` `I370–I385` 故障注入与全量合前验收）**: 新建 `scripts/dev/injections-data-kernel-dedup.mjs` (new) 注册 `I370–I385` 16 条故障注入；在 `fixtures.mjs`/`fixtures-verify-tools.mjs`/`fixtures-govern.mjs` 补齐 GitHub/`generic-git`/`local-only`/存量自定义模板正反双向用例；验证全部 `.mjs <= 800` 行，跑通 `compose-agents .`、`equip . --check`、`preflight.mjs`、`merge-gate.mjs`、`verify-injections.mjs` 与 `bench.mjs --strict-budget`。

## 四、验收与合前检查

<!-- section: verify -->
- [x] `node scripts/compose-agents.mjs . --check` 与 `node scripts/equip.mjs . --check` 通过
- [x] `node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --json` 全绿且无 `.mjs > 800` 行
- [x] `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit . --json` 达 `0 stale / 0 zombies / 0 blindSpots`
- [x] `node scripts/dev/preflight-kernel-parity.mjs` (new)、`node scripts/dev/bench.mjs --strict-budget` 与 `node scripts/dev/merge-gate.mjs` 全绿
- [x] `node scripts/dev/verify-injections.mjs`（含 `I370–I385`）全部精准变红通过
- [x] `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit . --json` 零报错
