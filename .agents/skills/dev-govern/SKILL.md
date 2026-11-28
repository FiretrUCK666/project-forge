---
name: dev-govern
description: |
  代码体检、清技术债、安全与规范审计、重构治理、同步 AGENTS/TDD、reconcile、规则下沉、园艺聚类、sample 事后抽检与跨多版本发版筹备（release-prep）。
  触发词：代码体检、清技术债、审计、重构治理、同步 AGENTS/TDD、reconcile、仓库巡检、
  清理过期 worktree、检查 deadcode、安全扫描、治理计划、批量提 Issue、技术债盘点、
  规则下沉、园艺聚类、sample 抽检、arch-rules 检查、release-prep、发版筹备、汇总更新日志。
metadata:
  intent: 代码体检 / 清技术债 / 更新长青文档 / 同步功能地图与架构文档 / 复盘下沉
  script: "`node .agents/skills/dev-govern/scripts/govern-audit.mjs` (`audit` / `reconcile` / `retro`)"
  order: 50
  fallback: 手工运行项目测试与 git status / git worktree list 检查工作区干净状态（未装配 dev-govern 技能）
---

# dev-govern

对仓库做**只读静态代码体检、分批重构治理、契约与工作树巡检（`reconcile`）、园艺信号聚类、自动周期复盘与发版筹备**；
全部入口收敛在：`node .agents/skills/dev-govern/scripts/govern-audit.mjs`。
**职责红线**：本技能严守静态分析与历史信号复盘边界，**绝不编写业务或并发测试，也不启动目标业务服务**。

## 组合工作模式与新增子命令

默认只读，先出事实与 `[GAP_SCAN]`，再按需出计划、聚类、抽检或生成 Issue：

```sh
# 1. 只读审计、基线增量与生命周期轻量自动体检（支持 security,deadcode,tests,docs,hygiene,perf）
node .agents/skills/dev-govern/scripts/govern-audit.mjs audit [--scope src] [--categories security,tests,docs] [--cluster]
node .agents/skills/dev-govern/scripts/govern-audit.mjs audit --save-baseline   # 快照存量基线至 <mainRoot>/.worktrees/.state/govern-baseline.json
node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --changed --quiet --json  # flow finalize/verify 轻量增量体检
node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --skip-govern --reason "<原因>" --json  # 显式留痕跳过，严禁无痕绕过

# 2. 分批计划（--write-todo 生成标准 Frontmatter `-todo.md`）/ 多轮收敛 / 按 TaskBackend 三态建单（github / generic-git / local-only）
node .agents/skills/dev-govern/scripts/govern-audit.mjs plan [--write-todo]     # 兼容 --plan-only
node .agents/skills/dev-govern/scripts/govern-audit.mjs audit --execute --loop
node .agents/skills/dev-govern/scripts/govern-audit.mjs issues [--apply-issues] # 兼容 --issues（支持三态本地与远端工单）

# 3. 园艺信号记录、聚类、事后抽检与三层倒金字塔自动复盘
node .agents/skills/dev-govern/scripts/govern-audit.mjs record --pattern <key> --message "<text>" [--module <dir>] [--file <path>]
node .agents/skills/dev-govern/scripts/govern-audit.mjs cluster [--signals-only]
node .agents/skills/dev-govern/scripts/govern-audit.mjs sample [--commits 30]
node .agents/skills/dev-govern/scripts/govern-audit.mjs retro [--task <id>] [--auto] [--apply-patches] [--allow-tier3-fallback --reason "<原因>"] [--json]

# 4. 跨多版本人类可读发版筹备（支持跳跃自定义号、浅克隆警告与多子包版本聚合）
node .agents/skills/dev-govern/scripts/govern-audit.mjs release-prep [--from <tag|rev>] [--to HEAD] [--version <ver>] [--json]
```

## 跨多版本发版筹备（release-prep）

只读采集发版区间变更事实，适配发版说明目录或 `CHANGELOG.md`（按需成节、不留空节）：

- **区间与版本源**：探测 `--to` 前最新可达标签（无标签则追溯全史；传 `--from` 尊重基线），继承 `v` 前缀，支持 `--version` 跳号；汇总 `SKILL.md`/`package.json`/`pyproject.toml`/`Cargo.toml`/`manifest.json` 版本与最低运行环境变更（`breakingSignals`）。
- **降噪与发版纪律**：过滤纯测试/夹具、CI 内部、`.worktrees`、排版及内部重构提交，去编号入 `userFacingCandidates`，同步采集合规 `implemented` 规格与归档成果，标出 `publicSurfaceTouched` 与 `unaccountedPublicFiles`；只写用户可感知变化与升级步骤，未经人明令严禁打标签或改史。

## 工程契约巡检（reconcile）

怀疑契约文档、架构边界或隔离目录漂移时运行只读 `node .agents/skills/dev-govern/scripts/govern-audit.mjs reconcile`：

- **契约体积与引用**：`AGENTS.md` 达 `24576` B 预警、超 `30720` B 报危；校验反引号路径、默认分支与 `Dev Profile`（含零匹配 `docs.devprofile-unmatched-high-risk`）。
- **文档温差、死链与 Frontmatter**：对照最近 80 次提交热点查滞后（`docs.stale-vs-churn`），扫描活跃目录死链（`docs.dead-link`，跳过 `docs/archive/`）、Mermaid `16/12` 宽度（`docs.mermaid-label-width`）、`docs/TDD.md` 漂移（遵循 `no-tdd`/既有文档豁免）及活跃 `docs/{prd,specs,todo}/` YAML Frontmatter、`-issue<N>-` 与 `related_*` 互链。
- **结构腐化与跨层边界**：拦截墓碑注释（`hygiene.tombstone-comment`）、压制标记（`hygiene.excuse-suppression`）、连续注释死代码（`deadcode.commented-block`）、`>800`/`>1500` 行大文件（`hygiene.god-file`）与 `arch-rules:` 跨层违规（`hygiene.arch-boundary`）。
- **测试覆盖与 CI 对齐**：聚合多生态脚本、`Dev Profile` 及 CI 配置（`.github/workflows/`、`.circleci/config.yml`、`azure-pipelines.yml`、`Jenkinsfile` 等）产出 `testInventory`，识别零断言、全跳过与孤儿测试套件（`tests.orphan-suite`）。
- **常青文档、功能地图与架构图对齐**：`reconcile` 保持严格只读（不改盘），校验 `docs/feature-map.json` v2 拓扑完整性与无环约束，核查 `docs/architecture-map.html` 首行 `feature-map-sha256` 指纹漂移并在漂移时提示运行 `verify-tools.mjs render` 同步。
- **Worktree 四态与清单卫生**：在 worktree 内同以 `<mainRoot>/.worktrees/` 为基准，结合 `git cherry`/`git patch-id` 判 `merged`、`squash_or_rebase_merged`、`no_own_commits`（仅报告并请人核对未提交改动，绝不误删）与 `unmerged`；校验 `.agents/skills/.pf-manifest.json`（兼容 v1/v2/v3）、明文凭据、`>1MB` 大文件、macOS 元数据与未忽略输出目录。

## 测试分层、控频与质量治理

- **客观盘点与无 CI 汇报**：汇总测试脚本与目录生成 `testInventory`；有测试却无 CI 时报 `tests.no-ci-config`（`low`），仅核本地 `Dev Profile` 与脚本目录。
- **分层分离**：结合 `profile-sniffer.mjs` 识别 `package.json`（`test:unit`/`integration`/`e2e`）、框架配置（Vitest/Jest/Playwright/Cypress/Pytest markers）、Cargo `tests/` 与 Go build tags；小型单层仓免报 `tests.unfiltered-quick-test`，多层混跑拦截 `tests.collapsed-tiers` 与 `tests.unfiltered-quick-test`。
- **三段控频**：编码中仅语法/类型/单文件检查；阶段后跑 `flow.mjs verify --mode quick --target <path>`；合前集中跑 1 次 `full-test` 与 `merge-gate`。
- **反膨胀与假测审计**：剥离注释并跳过元夹具生成器后，检出单测 `>=1s` sleep（`tests.hard-sleep`）、单测混入浏览器/容器重依赖（`tests.heavy-in-unit`）、`>=5` mock 且 0 真实断言自证（`tests.mock-tautology`）、`>800` 行超大单测（`tests.oversized-file`）与非无头配置（`tests.non-headless`）；拆分测试目录前须先经人类确认。

## 严格三层倒金字塔与自动复盘升格

1. **禁止默认写回 `AGENTS.md`**：`signals.jsonl` 按 `{ defectClass, pyramidTier, fingerprint, targetArtifact }` 记账，`retro` 默认不追加自然语言规则。
2. **同类故障复发 `>= 2` 次强制升格**：
   - **Tier 1（架构重构优先）**：状态分裂、竞态、超长紧文件或跨模块耦合由 `escalation.mjs` 按指纹去重生成重构单。
   - **Tier 2（确定性门禁次优先）**：产出 `arch-rules`、`edit-gate.mjs`、CI 或原生校验建议（不绑定第三方外部 linter 二进制）。
   - **Tier 3（显式兜底与淘汰）**：仅 `--allow-tier3-fallback --reason "<原因>"` 允许写入带 `[TIER-3-FALLBACK]` 与到期条件的极简词条；常规 `retro` 自动淘汰过期或已被 Tier 2 覆盖条目。
- **生命周期自动触发**：`flow finalize`/`verify` 自动跑轻量 `audit . --changed --quiet --json`，`flow merge`/`cleanup` 自动跑 `retro --auto` 并注入 `next` 引导；跳过必带 `--skip-govern --reason` 留痕。

## 先最小运行复现，再评整类加固

静态体检仅标「可疑」：先写最小可执行 PoC 复现（无法复现判误报，不打补丁）；修后复跑同命令并固化正反回归；确属共性时，能靠共享边界原语或架构解耦一次性收口的做 **Tier 1**；能靠类型、确定性静态门禁或原生校验配置下沉拦截的做 **Tier 2**。验收只锁产物、接口与断言，不锁私有过程。

## 园艺缓冲聚类、事后抽检与顽固 Bug 三步止损

- **园艺聚类（`cluster`）**：汇总 `signals.jsonl` 与审计发现，按模块+模式整片清理，不在同一文件叠补丁。
- **抽检与复盘（`sample` / `retro`）**：`sample --commits 30` 统计 `Revert` 与 48 小时返工热点；`retro [--task <id>] [--apply-patches] [--json]` 消费 `<gitCommonDir>/project-forge-govern/signals.jsonl`，统计无效审查率并产出建议补丁反馈下轮 `dev-plan`。
- **三步止损**：同一模块/缺陷连续修复 **3 次仍复发或退回**时立即停手，用 `sample` 与 `cluster` 复盘边界与测试缺口，交人类拍板方案。

## 常青文档与功能地图深度核对

覆盖 `docs/TDD.md`、`DESIGN.md`、`ARCHITECTURE.md`、`RUNBOOK.md`、`SECURITY.md`、「改哪看哪」登记文档与 `docs/feature-map.json`：
1. 跑 `govern-audit.mjs reconcile` 获取 `evergreenDocs`、`featureMapDrift`、`emptyDocAnchors`/`emptyToolDomains`/`emptyTestRefDomains` 与 `nextCommands`；
2. 按 `nextCommands` 调 `dev-explore`（`repo-map.mjs` + `doc-locate.mjs --file <doc>`）按章节对照源码核查语义漏项；
3. 缺口汇总后走 `dev-flow` 隔离分支修改并经 `dev-review` 审校合入。

## 与其余七套研发技能的联动

- **`dev-explore`**：遇 `docs.missing-tdd`、`docs.tdd-module-drift`、`featureMapDrift`、`hygiene.god-file`/`arch-boundary` 或规则下沉前，先跑 `repo-map.mjs` 与 `doc-locate.mjs` 摸清入口再动笔。
- **`dev-plan`**：`plan --write-todo` 产出的标准 Todo 可直接过 `doc-plan.mjs audit`；跨模块债或 `retro` 建议整改指引先走 `doc-plan.mjs triage`（L3 建 `SPEC + Todo`）。
- **`dev-edit`**：`edit-gate.mjs` 共用 `static-gates.mjs` 词法与过程文件名拦截内核，`retro` 的 Tier 2 规则可直接下沉至 `edit-gate`/`arch-rules`/CI。
- **`dev-flow`**：按分批计划走 `flow.mjs start --todo <path>` 隔离推进，过期 worktree 由 `flow.mjs cleanup` 四态清理；`verify`/`rework` 自动写入 `signals.jsonl`（未装配兄弟技能自动降级原生 Git）。
- **`dev-verify-tools` / `dev-iterate`**：`dev-verify-tools` 专管验证工具与校验、`dev-iterate` 专管生成与并发运行原生测试；本技能只管静态体检、常青文档/功能地图对齐与历史复盘。
- **`dev-review`**：整改完成后跑全套 `AGENTS.md` 验证并用 `review-pack.mjs --local` 收口；`record --disposition` 反馈自动入库 `signals.jsonl`。

## 执行与安全护栏

- **只读先行与删目录确认**：`--audit-only`、`--plan-only`、`reconcile`、`cluster`、`sample`、`release-prep` 与不带 `--apply-issues` 的 `--issues` 均为只读；清 `.worktrees/`（尤其 `no_own_commits`）前必列清单请人确认并先解绑依赖。
- **Issue 富证据与 UTF-8 提交**：`issues` 产出含 `file:line`、影响面、基线与局限、`C1..Cn` 及 `Out of Scope` 的治理想单；`--apply-issues` 走 `validateIssueBodyQuality`（不合规退出码 `3` 报 `BLOCKED_ISSUE_QUALITY_INCOMPLETE`）与临时 UTF-8 `--body-file`。
- **规则下沉与去熵**：审查漏出或运行时复发满 `2` 次的同类故障必下沉确定性静态检查/门禁，同步清理死代码与废弃路径。
- **探索转写改强制隔离**：`Case 1` 允许原地微调；从只读体检转入**任何非 `Case 1` 文件写改**（含治理修复、常青文档/功能地图与归档校准，仅补测试归 Case 2/3）必先走 `flow.mjs start` 隔离 worktree 并经 `edit-gate` 与 `review-pack` 闭环，禁直改主干；收尾运行 `AGENTS.md` 全部验证与 `review-pack.mjs --local`。
