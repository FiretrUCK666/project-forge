---
name: dev-flow
description: |
  统一驱动 Git 日常研发全流程：探测身份与凭据、按三档创建分支或 Worktree 并按子包挂载共享依赖、
  认领 Issue、成对归档文档同步锁、执行验证绑定 HEAD、推分支开 PR、返工、审查后合并与安全清理。
  触发词：修 bug、推代码、提 PR、开 PR、合并收尾、清 worktree、处理 Issue、
  收到 Issue、收到 PR、fix bug、create PR、merge PR、cleanup worktree。
metadata:
  intent: 已定案开工 / 修 bug / 改错别字 / 接着做 / 查任务状态 / 启动隔离工作位
  script: "`node .agents/skills/dev-flow/scripts/flow.mjs next` / `inspect`"
  order: 30
  fallback: 用原生 git switch -c <branch> 隔离改动并运行项目本地测试验证后再提交（未装配 dev-flow 技能）
  extra_routes:
    - order: 35
      intent: 实施者归档 / 实证 / 推分支提 PR
      intent_local: 归档文档 / 验证并提交至特性分支
      script: "`node .agents/skills/dev-flow/scripts/flow.mjs finalize` -> `verify` -> `submit`"
    - order: 45
      intent: 审查者合并 PR / 清理分支 / 确认后清理 Worktree
      intent_local: 本地试合并入主干与确认后清理 Worktree
      script: "`node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup`"
    - order: 46
      intent: 外部 Issue・PR 业务分诊 / 里程碑管理 / 裸粘贴链接
      intent_local: 本地新增提案分诊 / 里程碑管理
      script: "`node .agents/skills/dev-flow/scripts/flow.mjs intake` / `inspect <URL...>` / `milestone`"
---

# dev-flow：实现 → 实证测试-形式验证 → 合入 状态机

承接 `dev-explore` 侦察事实与 `dev-plan` 已批准设计单，驱动 8 阶段闭环中**隔离实现、分层实证、提审与最终合入清理**，并向 `dev-review` 与 `dev-govern` 输出确定性证据；除 `inspect`/`next`/`start` 外所有子命令支持从当前 worktree/分支/唯一活跃账本自动推断 `--task`。

## 核心规则

1. **先 `next` / `inspect` / `intake` 再动手（`TaskBackend` 抹平三态，默认并行优先）**：
   - `flow.mjs next [--probe-auth]` 是跨会话唯一入口：在 `idle`/`ambiguous` 态同步扫描未 `start` 的就绪 `docs/specs/*.md`（读取 `Depends on` 与写域），`Wave 1 >= 2` 时直接返回 `parallelDispatch: true` 供主会话薄上下文纯调度并行派发；每次只输出单一 `[NEXT STEP]`，并在审查阶段附 `excludedReviewers`；
   - `flow.mjs inspect [Issue/PR/Milestone URL...]` 识别五态身份（`local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `inbound-external-pr` / `generic-git`），解析多 Issue 依赖、已有 OPEN PR 与裸粘贴 Milestone URL；`flow.mjs milestone` 按需管理跨后端里程碑（`submit` 创建 PR 自动继承关联 Issue 里程碑）。
   - `flow.mjs intake --pr <M> | --issue <N>` 执行五态全局业务分诊（`accept` / `reject` / `merge-duplicate` / `needs-info` / `defer`）：适用于外部 PR、外部 Issue 及未经内部审批的新增需求/缺陷；已 `approved` 的本仓自研规划自动豁免；默认预演，传 `--apply` 经三段式结构化评论（决策头 + 人话理由 + `pf-state`）写回平台并贴标/关单。AI 结合 `docs/TDD.md` 与现状深度分析后可直接传 `--decision` + `--rationale` / `--rationale-file`（重复项附 `--duplicate-of <N>`）落地结论。
2. **沙箱双环、全量 Worktree 隔离与规划/实施衔接**：
   - 有历史提交仓（`commits > 0`）`Case >= 2` **一律**隔离（拦 `BLOCKED_MAIN_SLOT_VIOLATION` 与 `BLOCKED_DIRTY_MAIN`）；`Case 1` 允许原地微调；外部 PR 入 `.worktrees/review-pr-<M>`，过 `--untrusted-scan` 前不挂依赖或跑脚本。
   - **高频沙箱内环与真实差分晋升**：可逆迭代用 `start --sandbox [--write-scope a,b]` 建 `.worktrees/sandbox-<id>`（不污染主仓；未传 `--issue` 记 `exempt(sandbox)` 零预建单；支持单常驻或互不重叠 `writeScope` 多子代理并行记入 `ledger.implementers[]`，碰撞报 `BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP`；未晋升硬拒 `finalize`/`submit` 报 `BLOCKED_SANDBOX_PROMOTE_REQUIRED`）。沙箱内环 `verify --inner` 豁免 `claimedAt`/`explored` 并标 `inner: true`（失败仅写本地诊断不刷远端 Issue）。拍板后 `flow.mjs promote --task <id>` 按真实 `git diff <base>...HEAD` 路由：TDD 冲突阻断 `BLOCKED_CASE_5_TDD_CONFLICT`；`Case 2/3` 原地晋升并自动衔接 `claimedAt`/`explored` 与单一 Issue 绑定；`Case 4`/`one-way` 标为已验证 PoC `SANDBOX_PROMOTE_NEEDS_SPEC` 且不预建单。
   - **规划隔离与退场门禁**：`doc-plan.mjs init` 在 `commits > 0` 默认分支自动建 `.worktrees/impl-<id>`（先 `start --planning` 则同位复用）；`start --case 3|4` 前置 `plan-exit-gate` 核审（未就绪报 `BLOCKED_PLAN_NOT_READY`，规划 PR 加 `--allow-plan-bootstrap`）；每任务最多复用 1 实施/沙箱槽 + 1 审查槽（`--reset-review-slot` 清残留）。
3. **谁改谁认领、确定性 Issue 绑定与全员改审分离（协调者不代提）**：
   - `start` 对非沙箱 `Case >= 2` 按「`--issue` -> `ledger` -> 设计文档」先复用；命中 8 类豁免放行，否则 `Case 3/4` 从验真文档建单回链，无文档且缺 `--body`/`--body-file` 的 `Case 2` 报 `BLOCKED_MISSING_ISSUE_BINDING`（`3`）。
   - **谁改代码谁跑完 `claim` -> `finalize` -> `verify` -> `submit --agent <id>`**（`submit` 禁 `coordinator-*`/`reviewer-*` 报 `BLOCKED_MISSING_ACTOR`/`BLOCKED_SUBMIT_OWNERSHIP_MISMATCH`；`--host-mode single-session --human-approved` 仅限无子代理宿主且经人授权；同名作者拦 `BLOCKED_AUTHOR_IS_IMPLEMENTER`；外环审查与合并强校 `reviewerId ∉ implementers[]`）。接管须 `--takeover --reason`，弃领用 `release`。
4. **文档同步锁（`1:N` 四态闭环）与单源三轴 `evidence.json`**：
   - `finalize [--strict-sync] [--include-master-prd]`：校验 `C1..Cn` 全勾 `[x]`、检查 `docs/TDD.md` 与「改哪看哪」，默认轻量 `dev-govern`（`--skip-govern --reason` 留痕），成对 `git mv` 归档进 `docs/archive/`；`1:N` 总控 PRD 100% 覆盖且全勾 `[x]` 自动同分支归档，留 `[ ]` 报 `BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED`。`contributor-fork` 私有草案留 `.worktrees/.state/private-docs/`。
   - `verify --mode quick|smoke|full|gate [--inner]`：前置 `edit-gate --final`（干净 HEAD 复用 `gate-receipt.json` 去重），写 `evidence.json` 绑定 `verifiedHead === HEAD`；外环硬拒 `inner: true`（`BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER`）及 `quick --target` 顶替全量；`quick`/探索/沙箱失败默认仅记本地诊断，不刷远端工单（仅外环阻断触发升级）。单源三轴策略：`visualCheckRequired` 独立于 `riskTier='high'`，故障注入仅绑 `high`/`one-way`/`Case>=4`；UI 变更缺真实 `--artifact`/`--visual-evidence`/`--visual-blocked-reason` 报 `BLOCKED_UI_ARTIFACT_REQUIRED`。`submit` 推后零跟踪文件写回。
5. **独立审查后合入、临时 `--detach` 试合、`generic-git` 防越权与 7 步确认清理**：
   - 独立审查 PASS（`reviewPassed === true && reviewPassedHead === HEAD`；`low` 风险可免审查直接合或可选写状态单）后由**独立审查者或调度者**执行 `flow.mjs merge`（仍严禁实施者自合，校验 `verifiedHead === HEAD`、远端 CI 绿灯与堆叠父 PR 已合）；`merge` 与 `batch merge-queue` 共享合并后回写路径，按文档真源与 `1:N` 切片完成态同步 Issue `C1..Cn` 勾选框、`plan-summary` 及关闭 E2E 升级工单（不触碰 `planBootstrap`、`flow close`、`intake` 与非验收章节）；`generic-git` 禁本地强合（退出码 `3`，merge 现场取回远端按四态合流核验，核不到则阻断仅 `--human-approved --reason` 放行）；本地合入须先 `--detach` 试合复测再推进主干；弱化门禁或停损解锁（退出码 `4`）必传 `--human-approved --reason`。
   - `cleanup` 先列清单与 `--preview-hash`（含分支安全删判定）请人确认后带 `--confirm --preview-hash <hash>` 执行（兼容 Squash/远端 `MERGED`、回收 per-slot 验证缓存、放行账本 `mountedDeps`，阻断未登记外链/悬空链接，先 `unlinkSync` 再删 worktree 与分支）。

## 标准命令流

```sh
# 1. 状态重水合 / 身份与多 Issue・PR・Milestone 拓扑探测 / 全局业务分诊 / 工单、账本与里程碑管理
node ".agents/skills/dev-flow/scripts/flow.mjs" next [--task <id>] [--probe-auth] [--handoff] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" inspect [Issue/PR/Milestone URL...] [--probe-auth]
node ".agents/skills/dev-flow/scripts/flow.mjs" intake (--pr <M> | --issue <N>) [--decision <accept|reject|merge-duplicate|needs-info|defer>] [--rationale "<说明>" | --rationale-file <路径>] [--duplicate-of <N>] [--feature-ref <path>] [--apply | --dry-run] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" issue <create|list|view|comment|close|migrate> [--issue <N>] [--title "<标题>"] [--case <1..5>] [--spec <path>] [--todo <path>] [--prd <path>] [--files <a,b>] [--body "<内容>" | --body-file <路径>] [--labels a,b] [--milestone <N|标题>] [--state open|closed|all] [--reason "<原因>"] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" close --issue <N> [--into <targetIssue>] --reason "<原因>" [--task <id>] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" milestone <create|list|assign|close> [--milestone <N|标题|URL>] [--issue <N>] [--task <id>] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" status [--task <id>] [--all] [--json]

# 2. 启动工作位（--sandbox 隔离沙箱 / --write-scope 并行写域 / --planning 规划隔离 / --base / --spec|--todo|--prd / --create-issue / --no-issue --reason）、真实差分晋升、变基同步与并行队列
node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug> [--case <1..5>] [--sandbox] [--write-scope a,b] [--agent <id>] [--base <branch>] [--planning] [--issue <N|URL>] [--create-issue --title "<标题>"] [--no-issue --reason "<原因>"] [--body "<内容>" | --body-file <路径>] [--spec <path>] [--todo <path>] [--prd <path>] [--pr <M|URL>] [--milestone <N|标题|URL>] [--after <parent>] [--files a,b] [--parallel] [--external-pr <M|URL>] [--allow-plan-bootstrap]
node ".agents/skills/dev-flow/scripts/flow.mjs" promote --task <id> [--issue <N|URL>] [--body "<内容>" | --body-file <路径>] [--todo <path>] [--no-issue --reason "<原因>"] [--conflicts-tdd] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" sync [--task <id>] [--onto <branch>]
node ".agents/skills/dev-flow/scripts/flow.mjs" batch <plan|check-disjoint|merge-queue|resume-session> [--tasks <a,b>] [--enqueue <id>] [--handoff]
node ".agents/skills/dev-flow/scripts/flow.mjs" abort [--task <id>] [--confirm] [--allow-outbound <路径>]

# 3. 实施者探索 / 认领 / 释放 / 归档锁（--include-master-prd）与内环/外环分层实证
node ".agents/skills/dev-flow/scripts/flow.mjs" explore [--task <id>] [--mode <mode>] [--agent <id>] [--focus <dir>]
node ".agents/skills/dev-flow/scripts/flow.mjs" claim [--issue <N|URL>] [--takeover --reason "<接管原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" release [--task <id>] [--reason "<释放原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" finalize [--strict-sync] [--include-master-prd]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode quick [--target <file>] [--inner]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode smoke|full|gate [--inner] [--e2e-evidence "<运行观察>"] [--visual-evidence "<视觉观察>"] [--artifact <path>]... [--visual-checked] [--visual-blocked-reason "<原因>"]

# 4. 实施者提交待审 -> 移交 dev-review -> 返工 -> 审查者合入 -> 确认清理
node ".agents/skills/dev-flow/scripts/flow.mjs" submit --agent <id> [--host-mode <multi-agent|single-session>] [--human-approved] [--draft] [--new-pr] [--offline] [--reset-review-slot]
node ".agents/skills/dev-flow/scripts/flow.mjs" rework [--rebut "<findingId>: <reason>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" merge [--method merge|squash|rebase] [--human-approved] [--reason "<原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm --preview-hash <hash> [--only-review-worktree|--keep-worktree] [--keep-local-branch] [--keep-remote-branch] [--allow-outbound <路径>]
```
