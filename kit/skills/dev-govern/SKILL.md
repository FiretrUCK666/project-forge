---
name: dev-govern
description: |
  代码体检、清技术债、安全与规范审计、重构治理、同步 AGENTS/TDD、reconcile、规则下沉、园艺聚类、sample 事后抽检与跨多版本发版筹备（release-prep）。
  触发词：代码体检、清技术债、审计、重构治理、同步 AGENTS/TDD、reconcile、仓库巡检、
  清理过期 worktree、检查 deadcode、安全扫描、治理计划、批量提 Issue、技术债盘点、
  规则下沉、园艺聚类、sample 抽检、arch-rules 检查、release-prep、发版筹备、汇总更新日志。
metadata:
  intent: 代码体检 / 清技术债 / retro 复盘下沉
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

只读采集并净化任意发版区间的变更事实，适配发版说明目录或 `CHANGELOG.md`（支持自由定制章节、不留空节）：

- **区间与自定义定号**：自动探测 `--to` 之前最新可达标签（无标签仓库则追溯至根提交覆盖全史；传 `--from` 时严格尊重基线），继承现有标签 `v` 前缀，支持 `--version` 跳跃升级（如 `v1.0.0` 直跳 `3.0.0` / `v4.0.0`）。
- **权威版本与下限预警**：汇总 `SKILL.md`、`package.json`、`pyproject.toml`、`Cargo.toml`、`manifest.json` 版本源，并提取 `engines` / `requires-python` / `rust-version` / `go` / `minAppVersion` 等最低运行版本变更写入 `breakingSignals`。
- **双源降噪与防漏交叉核对**：过滤纯测试/夹具、CI 内部、`.worktrees`、纯错字/排版及未触及公开入口的内部重构提交；清洗去掉内部编号进入 `userFacingCandidates`，同步采集合规规格（`implemented`）与归档成果；标出 `publicSurfaceTouched` 及仅落在含糊提交里的 `unaccountedPublicFiles`。
- **发版纪律**：只写最终用户可感知变化与升级步骤，绝不照抄内部提交流水账；未经人明令严禁打标签或改写已发历史。

## 工程契约巡检（reconcile）

当怀疑契约文档、架构边界或隔离目录漂移时运行 `reconcile`（只读）：

```sh
node .agents/skills/dev-govern/scripts/govern-audit.mjs reconcile
```

- **契约体积与失效引用**：`AGENTS.md` 达 `24576` 字节预警、超 `30720` 字节报危，校验反引号路径、默认分支与 `Dev Profile`（含过期 `high-risk:` 零匹配检查 `docs.devprofile-unmatched-high-risk`）。
- **文档温差、相对死链、Mermaid 与活跃 Frontmatter**：对照最近 80 次提交热点目录检查文档滞后（`docs.stale-vs-churn`），扫描活跃目录 Markdown 相对死链（`docs.dead-link`，跳过 `docs/archive/` 历史归档）、Mermaid `16/12` 防截断宽度（`docs.mermaid-label-width`）、`docs/TDD.md` 模块漂移（遵循 `readDecisions` 的 `no-tdd` / 既有架构文档豁免），以及 `docs/{prd,specs,todo}/` 活跃文档的 YAML Frontmatter、`-issue<N>-` 与 `related_*` 互链。
- **结构腐化与跨层边界**：识别墓碑履历注释（`hygiene.tombstone-comment`）、借口/压制标记（`hygiene.excuse-suppression`）、连续注释死代码块（`deadcode.commented-block`）、`>800`/`>1500` 行超大源码（`hygiene.god-file`）与 `arch-rules:` 跨层禁引违规（`hygiene.arch-boundary`）。
- **测试覆盖与 CI 对齐**：聚合根与多子包脚本（`package.json`、`Makefile`、`justfile`、`pom.xml`、`Cargo.toml` 等）、`.github/workflows/` 及中性 CI 配置（`.circleci/config.yml`、`azure-pipelines.yml`、`Jenkinsfile` 等）与 `Dev Profile` 输出 `testInventory`，揪出零断言、全跳过与孤儿测试套件（`tests.orphan-suite`）。
- **Worktree 四态精细判定**：在 worktree 内运行同样以 `<mainRoot>/.worktrees/` 为基准，结合 `git cherry` 与 `git patch-id` 识别 `merged`、`squash_or_rebase_merged`、`no_own_commits`（**仅报告并要求先问人核对未提交改动，绝不误删**）与 `unmerged`。
- **清单与仓库卫生**：校验 `.agents/skills/.pf-manifest.json`（v3 账本，兼容 v1/v2/v3 定制豁免、三方合并与跨系统换行）、明文凭据、`>1MB` 大文件、macOS 元数据过滤及未忽略输出目录。

## 测试分层、控频与质量治理

- **客观盘点与无 CI 诚实汇报**：汇总多构建工具脚本与测试目录生成 `testInventory`；无 `.github/workflows` 等 CI 配置且存在测试时发出 `tests.no-ci-config`（`low`），明示仅核对本地 `Dev Profile` 与脚本目录。
- **分层分离与元数据驱动判定**：结合 `profile-sniffer.mjs` 读取目标仓 `package.json` 测试脚本（`test:unit`/`test:integration`/`test:e2e`）、测试框架配置（Vitest/Jest/Playwright/Cypress/Pytest markers）、Cargo `tests/` 与 Go build tags 精准划分单测/集成/端到端层级；小型单层极速测试仓免报 `tests.unfiltered-quick-test`，大仓或多层混跑时拦截 `tests.collapsed-tiers` 与 `tests.unfiltered-quick-test`。
- **三段测试控频**：编码中只做语法/类型/单文件检查；一轮改动后跑 `flow.mjs verify --tier quick --target <path>`；合入前集中跑 1 次 `full-test` 与 `merge-gate`。
- **反膨胀与假测审计**：剥离注释并跳过元夹具生成器后，识别非 E2E 单测硬编码 `>=1s` sleep（`tests.hard-sleep`）、单测混入浏览器/容器重依赖（`tests.heavy-in-unit`）、`>=5` mock 且仅断言调用次数而 0 真实值断言的纯 Mock 自证（`tests.mock-tautology`）、`>800` 行超大单测（`tests.oversized-file`）与无环境变量隔离的非无头配置（`tests.non-headless`）；重组或拆分测试目录前须先请人类确认。

## 严格三层倒金字塔与自动复盘升格

1. **禁止默认写回 `AGENTS.md`**：`signals.jsonl` 按 `{ defectClass, pyramidTier, fingerprint, targetArtifact }` 记录结构化故障指纹；`retro` 默认绝不向 `AGENTS.md` 追加自然语言规则，避免契约膨胀。
2. **同类故障指纹复发 `>= 2` 次强制升格**：
   - **Tier 1（架构重构优先）**：状态分裂、竞态、超长紧文件或跨模块结构耦合经 `escalation.mjs` 自动生成并按指纹去重 Tier 1 重构单。
   - **Tier 2（确定性门禁次优先）**：可静态拦截缺陷产出 `arch-rules`、`.agents/skills/dev-edit/scripts/edit-gate.mjs`、CI 或目标仓既有原生校验配置建议（绝不硬绑定第三方外部 linter 二进制）。
   - **Tier 3（仅显式兜底与定期淘汰）**：仅传 `--allow-tier3-fallback --reason "<原因>"` 方允许写入带 `[TIER-3-FALLBACK]` 标记与到期条件的极简词条；常规 `retro` 自动识别并清理过期或已由 Tier 2 覆盖的陈旧条目。
- **生命周期自动触发**：`flow finalize`/`verify` 默认自动跑轻量 `audit . --changed --quiet --json`（禁无痕跳过），`flow merge`/`cleanup` 后自动跑 `retro --auto` 并把待整改项注入 `next` 引导；显式跳过必带 `--skip-govern --reason` 留痕。

## 先最小运行复现，再评整类加固

静态体检出的是「可疑」，不是「已确诊」。按固定四步推进，避免拿误报当缺陷、拿补丁当根治：

1. **最小运行复现消误报**：任何静态告警、审查疑点或推测缺陷，先写一个最小可执行复现证明它真实可达；复现不出来就先按误报处理，不写补丁、不建单。
2. **复跑证伪 + 回归防护**：修完后用**同一条**复现命令复跑变绿，并把正反两面断言固化进回归用例，让同类问题再出现时当场被拦下。
3. **评估整类加固（Tier 1 / Tier 2）**：确认这个单点缺陷是否折射出同模式共性——能靠共享边界原语或架构解耦一次性收口的做 **Tier 1**；能靠类型、确定性静态门禁或原生校验配置下沉拦截的做 **Tier 2**。只补出问题的那一处，等于等着同一个问题换个位置再来。
4. **只锁客观边界**：加固后的验收锁在产物、接口与断言上，不锁私有实现过程。过程一改就误报的规则只会逼人绕过它。

## 园艺缓冲聚类、事后抽检与顽固 Bug 三步止损

- **园艺缓冲与批清理**：定期用 `cluster` 汇总 `signals.jsonl` 与现场审计发现，按模块+模式一次性整片清理，不在同一文件叠补丁。
- **事后历史抽检与任务复盘（`sample` / `retro`）**：定期运行 `sample --commits 30` 统计 `Revert` 与 48 小时返工热点；任务合入后运行 `retro [--task <id>] [--apply-patches] [--json]` 自动读取 `dev-flow`（`verify`/`rework`）与 `dev-review`（`record` `--disposition`）自动沉淀的 `<gitCommonDir>/project-forge-govern/signals.jsonl`，统计无效审查率并产出规则/门禁/夹具建议补丁，反馈给下轮 `dev-plan`。
- **顽固 Bug 三步止损**：同一模块或同一缺陷连续尝试修复 **3 次仍复发或退回**时，立即停手止损，禁止继续试错打补丁；用 `sample` 与 `cluster` 复盘架构边界与回归测试缺口，交由人类维护者拍板方案后再动。

## 常青文档与功能地图深度核对

除 `docs/TDD.md` 外，自动覆盖 `DESIGN.md`、`ARCHITECTURE.md`、`RUNBOOK.md`、`SECURITY.md` 及 `AGENTS.md`「改哪看哪」登记的常青权威文档与 `docs/feature-map.json`，固定三步执行：

1. **机械定位**：先跑 `govern-audit.mjs reconcile`（覆盖 `kit/`/`app/`/`apps/`/`pkg/`/`cmd/`/`internal/` 并按权威常青文档判定温差）获取 `evergreenDocs`、`featureMapDrift`、`emptyDocAnchors`/`emptyToolDomains`/`emptyTestRefDomains` 与 `nextCommands`；
2. **按节语义核对**：按 `nextCommands` 调用 `dev-explore`（`repo-map.mjs` + `doc-locate.mjs --file <doc>`）按模块和章节对照源码核查语义漏项，不强灌全文；
3. **隔离补全**：汇总缺口清单后走 `dev-flow` 隔离分支修改并经 `dev-review` 审校合入（绝不直接改主干）。

## 与其余七套研发技能的联动

- **`dev-explore`**：遇到 `docs.missing-tdd`、`docs.tdd-module-drift`、`featureMapDrift`、`hygiene.god-file`/`arch-boundary` 或准备执行 `retro` 规则下沉前，先跑 `node .agents/skills/dev-explore/scripts/repo-map.mjs` 与 `doc-locate.mjs --file <doc>` 摸清真实模块入口与章节切片，再落笔治理或修订常青文档。
- **`dev-plan`**：`govern-audit.mjs plan --write-todo` 生成符合统一模板的标准 Todo 并可直接通过 `doc-plan.mjs audit`；命中跨模块债或 `retro` 建议整改时，自动指引先走 `doc-plan.mjs triage`（L3 建 `SPEC + Todo`）。
- **`dev-edit`**：`edit-gate.mjs` 与本技能共用 `static-gates.mjs` 词法与过程工件文件名拦截内核，`retro` 产出的 Tier 2 确定性规则可直接沉淀到 `edit-gate`、`arch-rules` 或 CI。
- **`dev-flow`**：按分批计划执行时通过 `flow.mjs start --todo <path>` 在独立工作树推进、`reconcile` 检出过期 worktree 后由 `flow.mjs cleanup` 四态安全清理；`flow.mjs verify`/`rework` 自动向 `signals.jsonl` 写入运行时信号供 `retro` 消费（未装配兄弟技能时自动降级为原生 Git 指引）。
- **`dev-verify-tools`**：职责清晰划分——`dev-verify-tools` 专管验证工具条目生命周期、过时校验与草稿固化；本技能专管常青权威文档与 `docs/feature-map.json` 模块/业务流结构对齐。
- **`dev-iterate`**：职责严格正交——本技能只做静态体检、文档核对与历史信号复盘；主动生成原生回归/集成/E2E/性能测试并并发实跑一律交由 `dev-iterate`。
- **`dev-review`**：每轮整改与规则下沉后运行 `AGENTS.md` 全部验证命令，再用 `review-pack.mjs --local` 收口确认；`review-pack.mjs record` 的 `--disposition` 反馈自动入库 `signals.jsonl`。

## 执行与安全护栏

- **只读先行与不擅自删目录**：`--audit-only`、`--plan-only`、`reconcile`、`cluster`、`sample`、`release-prep` 与不带 `--apply-issues` 的 `--issues` 均为只读；清理任何 `.worktrees/`（尤其 `no_own_commits`）前必须列清单请人确认并先解绑依赖链接。
- **Issue UTF-8 安全提交**：带 `--apply-issues` 时一律写系统临时目录 UTF-8 文件配合 `gh issue create --body-file` 提交并删除临时文件。
- **规则下沉与去熵**：真实审查漏出或运行时复发满 `2` 次的同类故障，必须下沉为确定性形式静态检查或静态门禁脚本，防止反复靠人工读代码拦错；同步清理死代码、废弃路径与冗余分支，保持代码库精简。
- **验证收口**：修复与下沉完成后运行 `AGENTS.md` 中的全部验证命令与静态/实证门禁，再使用 `dev-review`（`review-pack.mjs --local`）收尾确认。
