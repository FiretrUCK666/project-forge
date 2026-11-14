---
name: dev-govern
description: |
  代码体检、清技术债、安全与规范审计、重构治理、同步 AGENTS/TDD、reconcile、规则下沉、园艺聚类、sample 事后抽检与跨多版本发版筹备（release-prep）。
  触发词：代码体检、清技术债、审计、重构治理、同步 AGENTS/TDD、reconcile、仓库巡检、
  清理过期 worktree、检查 deadcode、安全扫描、治理计划、批量提 Issue、技术债盘点、
  规则下沉、园艺聚类、sample 抽检、arch-rules 检查、release-prep、发版筹备、汇总更新日志。
---

# dev-govern

对仓库做只读代码体检、分批重构治理、契约与工作树巡检（`reconcile`）、园艺信号聚类及历史抽检，
全部入口收敛在：`node .agents/skills/dev-govern/scripts/govern-audit.mjs`。

## 组合工作模式与新增子命令

默认只读，先出事实与 `[GAP_SCAN]`，再按需出计划、聚类、抽检或生成 Issue：

```sh
# 1. 只读审计与模块聚类（支持 security,deadcode,tests,docs,hygiene,perf）
node .agents/skills/dev-govern/scripts/govern-audit.mjs --audit-only [--scope src] [--categories security,tests,docs] [--cluster]

# 2. 分批计划 / 多轮自动收敛 / 安全生成 GitHub Issue
node .agents/skills/dev-govern/scripts/govern-audit.mjs --plan-only [--write-todo]
node .agents/skills/dev-govern/scripts/govern-audit.mjs --execute --loop
node .agents/skills/dev-govern/scripts/govern-audit.mjs --issues [--apply-issues]

# 3. 园艺信号记录、聚类与事后历史抽检
node .agents/skills/dev-govern/scripts/govern-audit.mjs record --pattern <key> --message "<text>" [--module <dir>] [--file <path>]
node .agents/skills/dev-govern/scripts/govern-audit.mjs cluster [--signals-only]
node .agents/skills/dev-govern/scripts/govern-audit.mjs sample [--commits 30]

# 4. 跨多版本人类可读发版筹备（支持跳跃自定义号如 --version 3.0.0）
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

- **契约体积与失效引用**：`AGENTS.md` 达 `24576` 字节预警、超 `30720` 字节报危，校验反引号路径、默认分支与 `Dev Profile`（`quick-test`/`full-test`/`smoke-verify`/`merge-gate`/`arch-rules`）。
- **文档温差与相对死链**：对照最近 80 次提交热点目录检查文档滞后（`docs.stale-vs-churn`），围栏感知扫描 Markdown 相对死链（`docs.dead-link`）与 `docs/TDD.md` 模块漂移。
- **结构腐化与跨层边界**：识别墓碑履历注释（`hygiene.tombstone-comment`）、借口/压制标记（`hygiene.excuse-suppression`）、连续注释死代码块（`deadcode.commented-block`）、`>800`/`>1500` 行超大源码（`hygiene.god-file`）与 `arch-rules:` 跨层禁引违规（`hygiene.arch-boundary`）。
- **测试覆盖与 CI 对齐**：解析 `.github/workflows/*.{yml,yaml}` `ciRunSteps` 与 `Dev Profile`，揪出零断言测试、全跳过测试与孤儿测试套件（`tests.orphan-suite`）。
- **Worktree 四态精细判定**：结合 `git cherry` 与 `git patch-id` 识别 `merged`、`squash_or_rebase_merged`、`no_own_commits`（**仅报告并要求先问人核对未提交改动，绝不误删**）与 `unmerged`。
- **清单与仓库卫生**：校验 `.agents/skills/.pf-manifest.json` 完整性、明文凭据、`>1MB` 大文件及未忽略输出目录。

## 信任倒金字塔与规则下沉阶梯

1. **防线顺序（倒金字塔）**：确定性静态护栏（类型、`arch-rules`、卫生脚本）与高频测试优先于人工或事后复审；能用静态门禁拦住的问题绝不依赖口头叮嘱。
2. **规则下沉阶梯**：
   - **第 1 次出现（L1）**：当场修根因，并用 `record` 记入园艺缓冲 `<gitCommonDir>/project-forge-govern/signals.jsonl`（零污染 `git status`）。
   - **重复达 `>= 2` 次（L2）**：`cluster` / `audit --cluster` 按「模块 + 模式」去重标出 `sinkCandidate`，必须把规则下沉到 `AGENTS.md` `Dev Profile`（`arch-rules` / `smoke-verify`）或对应验证脚本，并在报错文本中直接给出根因修法。
   - **高频或 3 次以上（L3）**：提升为硬门禁并在 CI 工作流强制执行。

## 园艺缓冲聚类、事后抽检与顽固 Bug 三步止损

- **园艺缓冲与批清理**：定期用 `cluster` 汇总 `signals.jsonl` 与现场审计发现，按模块+模式一次性整片清理，不在同一文件叠补丁。
- **事后历史抽检（`sample`）**：定期运行 `sample --commits 30`，统计 `Revert` 回滚率与 48 小时同文件反复返工热点，输出需要补建测试或 `smoke-verify` 的规则下沉建议。
- **顽固 Bug 三步止损**：同一模块或同一缺陷连续尝试修复 **3 次仍复发或退回**时，立即停手止损，禁止继续试错打补丁；用 `sample` 与 `cluster` 复盘架构边界与回归测试缺口，交由人类维护者拍板方案后再动。

## 执行与安全护栏

- **只读先行与不擅自删目录**：`--audit-only`、`--plan-only`、`reconcile`、`cluster`、`sample`、`release-prep` 与不带 `--apply-issues` 的 `--issues` 均为只读；清理任何 `.worktrees/`（尤其 `no_own_commits`）前必须列清单请人确认并先解绑依赖链接。
- **Issue UTF-8 安全提交**：带 `--apply-issues` 时一律写系统临时目录 UTF-8 文件配合 `gh issue create --body-file` 提交并删除临时文件。
- **规则下沉与去熵**：真实审查漏出或运行时复发满 `2` 次的同类故障，必须下沉为确定性形式静态检查或静态门禁脚本，防止反复靠人工读代码拦错；同步清理死代码、废弃路径与冗余分支，保持代码库精简。
- **验证收口**：修复与下沉完成后运行 `AGENTS.md` 中的全部验证命令与静态/实证门禁，再使用 `dev-review`（`review-pack.mjs --local`）收尾确认。
