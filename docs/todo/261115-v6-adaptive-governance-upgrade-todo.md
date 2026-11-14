---
kind: todo
title: v6 全域稳健性、渐进装配与平台抽象升级执行任务单
status: active
created: 2026-11-15
updated: 2026-11-15
issue: null
pr: null
branch: feat/v6-adaptive-governance
owner: FiretrUCK666
approved: true
done_at: null
task_id: 261115-v6-adaptive-governance-upgrade
planned_at: ae34a79
related_prd: null
related_spec: ../specs/261115-v6-adaptive-governance-upgrade-spec.md
---

# v6 全域稳健性、渐进装配与平台抽象升级执行任务单

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `active`（已批准，按 Wave A–D 推进实施） |
| 建单 / 更新日期 | `2026-11-15` / `2026-11-15` |
| 关联规范 | [261115-v6-adaptive-governance-upgrade-spec.md](../specs/261115-v6-adaptive-governance-upgrade-spec.md) |
| 目标分支 | `feat/v6-adaptive-governance` |
| 门型判定 | `two-way`（分支隔离 + 仓外 `.tar.gz` 快照可回退） |
| 断点恢复 | 核对 Frontmatter `status`/`branch` 与关联规范 `approved` 标记；审核通过后按下方 Swarm 分片推进 |

## 下一阶段 Swarm 并行实施编排与 L3 Worktree 隔离规程（待人类拍板后执行）

> 全部实施 Worker、合流验证员与独立审查员必须显式绑定 `model: "gemini-4-hydrogen-xhigh"`（Gemini 4 Hydrogen XHigh）；文件修改分片严格隔离，严禁两个写入型 Worker 修改同一文件。

- **L3 第 2 档 Worktree 物理隔离规程与两波推进约定**：
  1. **主工作区零污染**：人类维护者确认 `approved` 启动编码后，主仓库切回干净的 `main` 保持不动，绝不在主工作区直接堆砌大规模跨模块改动；
  2. **三波推进与锁死独占边界**：Wave A 先锁定共享接口契约（`kit/skills/lib/*.mjs` 签名、`.pf-manifest.json` v2 Schema、`TEMPLATE_CONDITIONS`、`HostingProvider` 接口），Wave B 再基于已冻结契约推进下游消费者与文档同步；**Wave A/B 的 5 个写入分片严禁修改 `scripts/dev/`、`.agents/skills/`、`AGENTS.md` 或对仓库根执行 `equip.mjs`/`compose-agents.mjs`/归档操作**；
  3. **实施合流隔离（Implementation Worktree）**：5 个写入分片各自在 Swarm `workspace: "share"` 隔离工作树内编码，Wave C 由 `integrator` 在独立 `impl` 实施工作树（承载 `feat/v6-adaptive-governance` 分支）合入全部修改、同步 `scripts/dev/` 门禁与夹具、执行自举与更新文档收尾记录；
  4. **全新干净工作树独立审查（Clean Detached Review Worktree）**：Wave D 由 `independent-reviewer`（`reviewerId !== implementerId`）在全新的干净 detached `review` 隔离工作树（检出待审 `HEAD`，挂载共享依赖）上执行 `review-pack.mjs`、实证门禁与故障注入验证，确认全部门禁先红后绿、无问题后推进合入并按七步顺序解绑清理 worktree。

| 波次 / 分片角色 | 唯一写范围（互不重叠） | 涵盖验收标准 | 隔离模式与模型 |
| --- | --- | --- | --- |
| Wave A · `worker-platform-remote` | `scripts/lib/platform/`、`scripts/lib/text.mjs`、`scripts/survey.mjs`、`scripts/lib/render.mjs`、`references/remote-github.md`、`references/survey.md` | `C8`（推荐档位）, `C9`（survey v2 兼容）, `C10`, `C11`, `C12`（探测拆项）, `C13`（远端指引）, `C14`, `C15`（设计文档、macOS 生态/元数据与重入识别）, `C19`（`text.mjs` 跨平台真实路径） | `share` / `gemini-4-hydrogen-xhigh` |
| Wave A · `worker-update-equip` | `scripts/update.mjs`、`scripts/equip.mjs`、`scripts/backup.mjs`、`scripts/compose-agents.mjs`、`scripts/handoff.mjs`、`scripts/review.mjs`、`scripts/lib/protocol.mjs` | `C1`（`.gitkeep` 初始化）, `C4`（`starterTdd` 表头）, `C7`, `C8`, `C9`, `C12`（`has-release`）, `C15`（`readDecisions`/宿主中性/Java 起步）, `C25` | `share` / `gemini-4-hydrogen-xhigh` |
| Wave A · `worker-kit-core` | `kit/skills/lib/`、`kit/skills/dev-explore/`、`kit/skills/dev-plan/`、`kit/skills/dev-flow/` | `C1`（`doc-plan`）, `C2`（`finalize`/`archive`）, `C3`, `C4`（`docs.mjs` Mermaid `16/12` 校验与 `finalize` 查 `TDD` 日期）, `C10`/`C14`（`platform.mjs` 对齐与 `generic-git`）, `C16`（内核与 `dev-flow`）, `C17`, `C18`, `C19`, `C20`, `C21`, `C22`（`flow` 侧）, `C23` | `share` / `gemini-4-hydrogen-xhigh` |
| Wave B · `worker-kit-gates` | `kit/skills/dev-review/`、`kit/skills/dev-govern/` | `C1`（`write-todo`）, `C2`（`docs/archive//` 修复）, `C4`（接入 Mermaid `16/12` 校验）, `C15`（`profile.mjs` 复用）, `C16`（`dev-review`/`dev-govern` 拆分）, `C19`（冲突拦截）, `C20`（CLI 推断）, `C21`（`review-pack` 同步与 Fork 读取）, `C22`（`review-pack` 侧）, `C24` | `share` / `gemini-4-hydrogen-xhigh` |
| Wave B · `worker-docs-visuals` | `templates/`、`docs/TDD.md`、`README.md`、`README.en.md`、`RELEASING.md`、`CONTRIBUTING.md`、`SKILL.md`、`references/docs-set.md`、`references/publish.md`、`references/publish-ecosystems.md`、`references/handoff.md`、`references/collaboration.md`、`references/version-control.md`、`.github/workflows/`、`.github/pull_request_template.md`、`assets/readme/` | `C1`（模板）, `C2`（成对归档同步）, `C4`, `C5`, `C6`, `C8`（文档）, `C12`（文档）, `C13`（`ci-release` 模板）, `C21`（协作判据）, `C25`（`handoff.md` 退出码） | `share` / `gemini-4-hydrogen-xhigh` |
| Wave C · `integrator` | 仅在独立 `impl` 实施工作树合并 Wave A/B 分支；独占修改 `scripts/dev/`（`preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`verify-injections.mjs`）、运行 `equip.mjs .`/`compose-agents.mjs .`/`sync-toc.mjs` 更新 `.agents/skills/` 与 `AGENTS.md`，并更新 `docs/specs/` 与 `docs/todo/` 实现收尾记录 | `C26`, `C27`, `C28` | `share` (`impl`) / `gemini-4-hydrogen-xhigh` |
| Wave D · `independent-reviewer` | 全程只读隔离；在全新干净 detached `review` 隔离工作树检出待审 `HEAD`，执行 `review-pack.mjs`、双门核对与故障注入实测后输出裁决 | 独立审查 `C1..C28` | 独立 `review` worktree / `gemini-4-hydrogen-xhigh` |

## 任务范围与验证基准

- **影响路径**：`scripts/`、`scripts/lib/`、`kit/skills/`、`templates/`、`references/`、`SKILL.md`、`AGENTS.md`、`docs/`、`README.md`、`README.en.md`、`.github/workflows/`、`assets/readme/`、`scripts/dev/`
- **复用既有模块**：`scripts/lib/protocol.mjs`、`scripts/lib/template.mjs`、`scripts/lib/render.mjs`、`scripts/lib/claims.mjs`、`scripts/backup.mjs`、`kit/skills/lib/shared.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs`、`node .agents/skills/dev-plan/scripts/doc-plan.mjs audit .`
- **高风险提醒**：全量触碰 `AGENTS.md` 声明的全部 `high-risk` 目录，合入前必须通过独立上下文审查、双向证伪夹具与故障注入自证。

## 本期不做

- 不引入第三方运行时 npm 依赖；不在产品层代码出现具体非 GitHub 托管平台名与 API 实现；不自动执行发版或历史强推；严禁删减、放宽或跳过既有门禁断言（禁止弱化门禁）。

## 门型与回滚路径

- **门型**：`two-way`（分支隔离 + 仓外快照保护）
- **回滚路径**：未合入改动可丢弃或通过 `node scripts/backup.mjs restore` 与 `git revert` 安全还原。

## 验收标准与执行清单

- [x] C1: 建齐 `docs/prd/.gitkeep`、`docs/specs/.gitkeep`、`docs/todo/.gitkeep`，统一 `templates/docs-*.md` 与 `doc-plan`/`govern-audit --write-todo` 元信息表与格式，通过 `node scripts/dev/preflight.mjs` 退出码 `0`。
- [x] C2: `flow.mjs finalize` 与 `doc-plan.mjs archive` 支持 `PRD`/`SPEC`/`Todo` 成对归档至 `docs/archive/` 对应目录并更新互链，`do-not-edit` 与双斜杠匹配无冲突。
- [x] C3: 修复 `doc-plan.mjs` `approveSpec` 状态写入、critique 误失效、`auditDoc` 单趟路径误报及中文 slug 重命名重复拼接缺陷。
- [x] C4: `templates/docs-tdd.md`、`docs/TDD.md` 与 `scripts/equip.mjs`（`starterTdd`）补齐 `## 文档信息` 表格并按短名拓扑重绘；`kit/skills/lib/docs.mjs` (new) 落地 Mermaid `16/12` 显示宽度静态校验（禁用节点内 HTML），接入 `preflight.mjs` 与 `doc-plan.mjs audit` 退出码 `0`。
- [x] C5: `.github/workflows/release.yml` 固定 `project-forge/` 前缀；双语 `README.md` / `README.en.md` 补齐一键 zip 下载链接、对照表及自更新机制说明，通过 `sync-toc.mjs --check` 且正文中不含模板套话与推广黑话。
- [x] C6: 6 张双语 SVG（`assets/readme/hero.svg`、`hero-en.svg`、`workflow.svg`、`workflow-en.svg`、`architecture.svg`、`architecture-en.svg`）同步文档结构与通用目标命令，通过 `preflight.mjs` SVG 安全校验。
- [x] C7: `scripts/update.mjs` 实现同盘 staging、最后原子写 `SKILL.md`、中断回滚、全深度清退役、15 分钟失败冷却及移除 S1 前隐式 `equip` 写入。
- [x] C8: `scripts/equip.mjs`、`scripts/survey.mjs` 与 `scripts/compose-agents.mjs` 支持 `--tier lightweight|full` 与无损升档。
- [x] C9: `.pf-manifest.json` 升级 `schemaVersion: 2`（删除墓碑不回写、`--adopt-custom` 绿灯豁免、基线自动收敛、LF 写入与换行兼容防 macOS/Win 误漂移），`scripts/backup.mjs` 钉住首份 `pre-forge` 快照。
- [x] C10: 无远端目录 `--probe-auth` 探测本机凭据不写 `~/.ssh/known_hosts`；`git credential fill` 加硬超时与 askpass 屏蔽防 macOS 钥匙串弹窗挂死；解析 `~/.ssh/config` 别名（含 `--apple-use-keychain` 文档）；Token 轻量验活防假绿。
- [x] C11: 补齐远端 3 路决策与 `gh CLI` / `SSH Ed25519` / `HTTPS PAT + GCM` 分步指引及 GitHub 仓库治理对齐提示。
- [x] C12: 修复 `has-release` 恒真漏洞；拆分 `ci-check`/`ci-release` 探测；落地 5 选 1 发版策略且仅按需指引 `RELEASE_TOKEN` / OIDC。
- [x] C13: `templates/ci-release.yml` 与 `.github/workflows/release.yml` 兼容无 `v` CHANGELOG 标题并补齐单源版本门禁与空 tag 防呆。
- [x] C14: 新增 `scripts/lib/platform/registry.mjs` (new) `HostingProvider` 与 `remotes[]` 拓扑抽象（产品层仅注册 `github`），未知主机降级 `generic-git` 不误阻 `merge`。
- [x] C15: 识别存量架构文档防双轨；修复 `adr` 目录误绑；精确区分首次接入与跨月重入（`detectReentry` 与多生态 `staleAgentScripts`）；全链路忽略 macOS 元数据（`._*`/`__MACOSX` 等）并识别 `Package.swift`/`xcodeproj`；清除特定宿主目录硬编码并兼容通用技能容器探测；补齐 `equip.mjs --bootstrap-empty --lang java`。
- [x] C16: 拆解 `kit/skills/lib/` 正交模块与三套大脚本内部子模块（单文件不超过 `800` 行，零 `>1500` 神文件），统一 `Dev Profile` / `arch-rules` / `resolveRepoRoots` / `detectGateWeakening` / `classifyDoorType` / `parseCoupledSyncRules` / `readDecisions`，通过 `preflight.mjs` `checkKitSuite()`。
- [x] C17: `repo-map.mjs` 改用 `git ls-files -z` + 4KB NUL 探测与多包发现，验证 8 层深 Java + 前端分离夹具完整识出源码与验证步骤。
- [x] C18: `Dev Profile` 显式 `none` 原样尊重；纯文档仓 `quick-test: none` 跑通 `flow verify` 与 `submit`。
- [x] C19: `kit/skills/lib/git.mjs` (new) 与 `scripts/lib/text.mjs` 统一 `-z`、`precomposeunicode`、`canonicalPath`/`samePath()`（兼容 macOS `/private/var` 与 APFS NFC）、冲突态拦截、unborn HEAD、POSIX `detached: true` 进程组强杀及 BSD 工具兼容。
- [x] C20: 统一 5 套脚本 CLI 参数契约、自动推断 `--task`/`--round`、新增 `flow status`/`abort` 与动态技能感知 `[NEXT STEP]`。
- [x] C21: 修复 Tier 2 `review-{taskId}` 同步检出防空 Diff、`flow start` 保留并迁入 `doc-plan` 文档以及 Fork 私有文档读取路径。
- [x] C22: `flow merge` 强校 `reviewPassed === true && reviewPassedHead === currentHead && lastReview?.headSha === currentHead && !lastReview?.stopLossTriggered`（`changes` 重置 `reviewPassedHead: null`）；补齐 `STOP_LOSS_ESCALATE` 人工放行；`cleanup` 兼容 Squash/Rebase 四态清理。
- [x] C23: `worktree-deps.mjs` 实现按子包锁比对、Workspace/editable 软链隔离保护、`samePath` 防护与安全回滚卸载。
- [x] C24: 修复 `review-pack.mjs` 静态门禁死代码与多语言词法误报；`govern-audit.mjs` 实现基线增量与 `--changed` 降噪并对齐 `--write-todo`，且两者接入 Mermaid `16/12` 宽度防截断检查。
- [x] C25: 修复 `scripts/handoff.mjs` 豁免 `.pf-manifest.json`、跳过 `.worktrees/` 与对齐退出码 `4` 文档，带共享依赖目标仓 `--verify` 退出码 `0`。
- [x] C26: 同步适配 `scripts/dev/preflight.mjs`、`scripts/dev/gap-coverage.mjs`、`scripts/dev/fixtures.mjs` 与 `scripts/dev/verify-injections.mjs`（含同步 `I9b`），补齐 `C1..C25` 全部正反双向夹具与故障注入断言。
- [x] C27: 全仓自举与全套门禁（`preflight`、`gap-coverage`、`fixtures`、`verify-injections`、`review`、`govern-audit`、导出包校验）全绿退出码 `0`。
- [x] C28: 补齐规范 `## 实现说明` 与本单 `## 完成后的记录`，完成 `SPEC` 与 `Todo` 成对归档准备。

## 断点与遗留决策

- **当前状态**：Wave A–C 合流、Trust Gateway 实时 Issue/PR 闭环、四处异构误报根除及 `scripts/dev/` 模块化拆分均已完成实施，进入 Wave D 独立审查与收尾归档阶段。
- **待拍板事项**：由 Wave D `independent-reviewer` 在独立干净 detached `review` worktree 复核并给出审查裁决，合入前运行 `flow.mjs finalize` 完成 `SPEC` 与 `Todo` 成对归档。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：完成自举（`equip.mjs .`、`compose-agents.mjs .`、`sync-toc.mjs README.md README.en.md`），并执行全套 12 项门禁命令（`preflight.mjs`、`gap-coverage.mjs`、`fixtures.mjs`、`verify-injections.mjs`、`bench.mjs`、`equip.mjs . --check`、`compose-agents.mjs . --check`、`review.mjs .`、`sync-toc.mjs README.md README.en.md --check`、`govern-audit.mjs audit . --all`、`govern-audit.mjs reconcile .` 及 `git archive` `--package` 校验）按最终工作区基线实跑验绿；完整退出码与读数见合流汇报。
- **文档同步检查**：已同步 `docs/TDD.md`、`AGENTS.md`（<= 24576 B）、`README.md`、`README.en.md`、`CONTRIBUTING.md`、`RELEASING.md`、`SKILL.md`、`references/`、`kit/skills/*/SKILL.md`、`templates/` 及 `assets/readme/` 门面 SVG。
- **遗留问题**：无。
