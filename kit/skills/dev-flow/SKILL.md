---
name: dev-flow
description: |
  统一驱动 Git 日常研发全流程：探测身份与凭据、按三档创建分支或 Worktree 并按子包挂载共享依赖、
  认领 Issue、成对归档文档同步锁、执行验证绑定 HEAD、推分支开 PR、返工、审查后合并与安全清理。
  触发词：修 bug、推代码、提 PR、开 PR、合并收尾、清 worktree、处理 Issue、
  收到 Issue、收到 PR、fix bug、create PR、merge PR、cleanup worktree。
metadata:
  intent: 已定案开工 / 明确局部修缺陷 / 查任务状态 / 启动隔离工作位
  script: "`node .agents/skills/dev-flow/scripts/flow.mjs next` / `inspect`"
  order: 30
  fallback: 用原生 git switch -c <branch> 隔离改动并运行项目本地测试验证后再提交（未装配 dev-flow 技能）
  extra_routes:
    - order: 35
      intent: 实施者归档 / 实证 / 推分支提 PR
      intent_local: 归档文档 / 验证并提交至特性分支
      script: "`node .agents/skills/dev-flow/scripts/flow.mjs finalize` -> `verify` -> `submit`"
    - order: 45
      intent: 审查者合并 PR / 确认后清理 Worktree
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
2. **全量 Worktree 隔离、跨轮槽复用与防毒化共享依赖**：
   - 有历史提交仓（`commits > 0`）无论 Case 1/2/3/4 **一律**入第 2 档 `.worktrees/impl-<id>`（含分支占用与主仓脏改动拦截）；仅 0 提交非并行仓允许第 1 档本地特性分支；外部 PR（`--external-pr <M>`）入 `.worktrees/review-pr-<M>`，过 `--untrusted-scan` 前绝不挂依赖或执行脚本。
   - **规划隔离与退场门禁**：支持 `start --planning` 先建隔离工作树完成规划（过审后再运行 `flow start` 同工作树转入实施，无需迁移）。`start --case 3|4`（非 `--planning`）在建分支建工作位之前读已绑定的 SPEC/Todo（`--spec`/`--todo`、账本既有值或按 slug/issue 检索），逐条核对「待拍板清零 + 规划态合法 + 严格白名单过审（SHA 一致）」；未就绪以退出码 `3` 报 `BLOCKED_PLAN_NOT_READY`，不留下任何工作位。判据在 `kit/skills/lib/plan-exit-gate.mjs`，与 `dev-plan` 共用同一份。**开规划 PR 自身**时加 `--allow-plan-bootstrap` 显式豁免。`flow start` 自动采集一次只读 `repo-map` 记入 `ledger.explored`（`flow explore` 保留为显式刷新入口）。
   - 每任务最多复用 1 个 `impl` 槽 + 1 个 `review` 槽；`submit`/`review-pack` 推进 `review-<id>` 时自动 `unmountSharedDeps` -> 同步 `HEAD` -> 重挂载依赖（`--reset-review-slot` 清理故障注入残留）；所有变基/试合同步命令附 `GIT_EDITOR=true` / `--no-edit` 非交互保护，`flow-trial-merge` 在 `--abort` 前输出有界冲突摘要与恢复包。Case 2/3/4 单任务在隔离 `impl` 位派发 `impl` 子代理；多任务由 `batch plan`/`check-disjoint`/`merge-queue`/`resume-session` 与 `sync`（`--after` 堆叠 `rebase --onto`）协同。
3. **谁改谁认领、统一工作前缀与双写评论（协调者不代提）**：
   - **谁改代码谁在隔离 `impl` 位跑完 `claim` -> `finalize` -> `verify` -> `submit` 与 PR/Issue 评论**（协调者只负责调度派发与验收，不得代提 PR；`submit` 传非原认领人或 `coordinator-*`/`reviewer-*` 触发 `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH`）。所有建单与 PR 入口统一遵循 `Case 1 -> docs:` / `Case 2 -> fix:` / `Case >= 3 -> feat:` 规范前缀及四态语义标签（`in-progress`/`in-review`/`changes-requested`/`reviewed`）。接管须 `--takeover --reason` 双写 Issue+PR，弃领用 `release`。
4. **文档同步锁（`1:N` 总控四态闭环）与防旁路分层 `evidence.json`**：
   - `finalize [--strict-sync] [--include-master-prd]`：校验 `C1..Cn` 全勾 `[x]`、检查 `docs/TDD.md` 同步与「改哪看哪」联动，成对 `git mv` 归档至 `docs/archive/`；`1:N` 总控 PRD 执行四态闭环（手动/有活跃兄弟维持 `active`；有未覆盖后续 `C*` 维持 `active`；100% 覆盖且全勾 `[x]` 自动同分支归档；100% 覆盖留 `[ ]` 则 `finalize`/`verify` 均拦截 `BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED`）。`contributor-fork` 且上游无 `docs/` 时私有草案隔离至 `.worktrees/.state/private-docs/`。
   - `verify --mode quick|smoke|full|gate`：写入 `<gitCommonDir>/project-forge-flow/tasks/<id>/evidence.json`（并向 `signals.jsonl` 写事件）绑定 `verifiedHead === HEAD`；`submit`/`merge` 现场按 `low`/`medium`/`high` 三正交策略核验，`quick --target` 绝不顶替全量门禁，无 CI 低风险纯文档变更须过 `runLowRiskDocStaticCheck`。证据只取人说过的：`--e2e-evidence` / `--visual-evidence` 的原文才写成观察记录，裸 `--visual-checked` 只记「已声明核验」，不代为生成观察串。`--artifact <path>`（可重复）与 `--visual-blocked-reason "<原因>"` 一并传给 `empirical-artifacts.mjs` 校验非空常规文件与实质观察（UI 变更缺实证按退出码 `3` 阻断）。
   - `submit` 推后**零跟踪文件写回**，先查 OPEN PR 防重、套用 `.github/pull_request_template.md` 并继承 Milestone 后移交 `dev-review`。
5. **审查者合入、临时 `--detach` 试合、`generic-git` 防越权与 7 步确认清理**：
   - 独立审查 PASS（`low` 风险可免审查直接合或可选 `review-pack record` 写状态单）后由审查者执行 `flow.mjs merge`（校验 `verifiedHead === HEAD`、`reviewPassedHead === HEAD`、远端 CI 绿灯与堆叠父 PR 已合）；`generic-git` 禁本地强合（退出码 `3`，merge 现场取回远端按四态合流判定核验，核不到则阻断，仅 `--human-approved --reason` 可放行）；本地合入须先建 `.worktrees/.tmp-merge-*` `--detach` 试合复测再推进主干；弱化门禁或停损解锁（退出码 `4`）必传 `--human-approved --reason`。
   - `cleanup` 先列清单请人确认后带 `--confirm` 执行（兼容 Squash/远端 `MERGED`；放行账本 `mountedDeps`，阻断未登记外链/悬空链接，确需切断须逐条传 `--allow-outbound`，先 `unlinkSync` 再删 worktree 与分支）。

## 标准命令流

```sh
# 1. 状态重水合 / 身份与多 Issue・PR・Milestone 拓扑探测 / 全局业务分诊 / 工单、账本与里程碑管理
node ".agents/skills/dev-flow/scripts/flow.mjs" next [--task <id>] [--probe-auth] [--handoff] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" inspect [Issue/PR/Milestone URL...] [--probe-auth]
node ".agents/skills/dev-flow/scripts/flow.mjs" intake (--pr <M> | --issue <N>) [--decision <accept|reject|merge-duplicate|needs-info|defer>] [--rationale "<说明>" | --rationale-file <路径>] [--duplicate-of <N>] [--feature-ref <path>] [--apply | --dry-run] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" issue <create|list|view|comment|close|migrate> [--issue <N>] [--title "<标题>"] [--body "<内容>"] [--labels a,b] [--milestone <N|标题>] [--state open|closed|all] [--reason "<原因>"] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" milestone <create|list|assign|close> [--milestone <N|标题|URL>] [--issue <N>] [--task <id>] [--json]
node ".agents/skills/dev-flow/scripts/flow.mjs" status [--task <id>] [--all] [--json]

# 2. 启动工作位（--planning 规划隔离 / --base 基线分支 / --spec|--todo|--prd 显式绑定 / --create-issue 建单 / --parallel / --after / --files；Case 3/4 走规划退场门禁）、变基同步与并行队列
node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug> --case <1..5> [--base <branch>] [--planning] [--issue <N|URL>] [--create-issue --title "<标题>"] [--spec <path>] [--todo <path>] [--prd <path>] [--pr <M|URL>] [--milestone <N|标题|URL>] [--after <parent>] [--files a,b] [--parallel] [--external-pr <M|URL>] [--allow-plan-bootstrap]
node ".agents/skills/dev-flow/scripts/flow.mjs" sync [--task <id>] [--onto <branch>]
node ".agents/skills/dev-flow/scripts/flow.mjs" batch <plan|check-disjoint|merge-queue|resume-session> [--tasks <a,b>] [--enqueue <id>] [--handoff]
node ".agents/skills/dev-flow/scripts/flow.mjs" abort [--task <id>] [--confirm] [--allow-outbound <路径>]

# 3. 实施者探索 / 认领 / 释放 / 归档锁（--include-master-prd）与分层实证
node ".agents/skills/dev-flow/scripts/flow.mjs" explore [--task <id>] [--tier <tier>] [--focus <dir>]
node ".agents/skills/dev-flow/scripts/flow.mjs" claim [--issue <N|URL>] [--takeover --reason "<接管原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" release [--task <id>] [--reason "<释放原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" finalize [--strict-sync] [--include-master-prd]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --tier quick [--target <file>]
node ".agents/skills/dev-flow/scripts/flow.mjs" verify --mode smoke|full|gate [--e2e-evidence "<运行观察>"] [--visual-evidence "<视觉观察>"] [--artifact <path>]... [--visual-checked] [--visual-blocked-reason "<原因>"]

# 4. 实施者提交待审 -> 移交 dev-review -> 返工 -> 审查者合入 -> 确认清理
node ".agents/skills/dev-flow/scripts/flow.mjs" submit [--reset-review-slot]
node ".agents/skills/dev-flow/scripts/flow.mjs" rework [--rebut "<findingId>: <reason>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" merge [--method merge|squash|rebase] [--human-approved] [--reason "<原因>"]
node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm [--only-review-worktree|--keep-worktree] [--keep-local-branch] [--keep-remote-branch] [--allow-outbound <路径>]
```
