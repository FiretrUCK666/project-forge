---
kind: prd
title: Wave 6 去补丁通用架构重构
status: draft
created: 2026-11-22
updated: 2026-11-22
issue: 143
pr: null
owner: plan-w6
plan_mode: interactive
plan_critique: pending
related_spec: null
related_todo: null
multi_spec: true
---

# Wave 6 去补丁通用架构重构 — 产品需求说明（PRD）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `draft`（枚举：`draft \| active \| in_review \| done \| superseded \| dropped`） |
| 创建 / 更新 | `2026-11-22` / `2026-11-22` |
| 关联 Issue / PR | #143 / 未关联 |
| 提出方 / 负责人 | plan-w6 |
| 规划态 | `interactive`（逐题问到零拍板）/ `autonomous`（默认推进，仅单向门、Case 5 或真业务歧义才停） |
| 关联设计 / 任务单 | 拆分为 3 组互不相交的切片 SPEC + Todo（`w6a` / `w6b` / `w6c`） |

- **目标读者**：实现者、审查者与后续接手人

## 一、要解决的问题

### 现状与痛点

在多组真实开源仓库与空白目录上完成 12 轮盲测及 6 轮只读取证审计后，暴露出一批无法靠局部补丁根治的系统性架构根因（关联 Issue #143）：

- **S1 勘察与交棒契约假绿/误报**：`scripts/lib/survey-docs.mjs` 与 `scripts/review.mjs` 跨工作流文件全局聚合 `pull_request_target` 与 PR refs，且误匹配 `github.event.pull_request.number` 与 `# zizmor: ignore[dangerous-triggers]`；`RELEASE_WORKFLOW_PATTERNS` 漏判现代发布工具，`detectGitHooksState` 漏检 `simple-git-hooks` 与自定义 `.git/hooks/*`；`scripts/lib/survey-ecosystem.mjs` 与 `kit/skills/lib/profile-sniffer.mjs` 漏识 `.slnx`、`jsr.json` / `deno.json`、`pnpm-workspace.yaml` 继承与 `!` 负向 glob；`scripts/survey.mjs` 违反零写入不变量调用 `recordStepStateSafe`；`scripts/backup.mjs` 受 `readTextSafe` 512KB 上限截断大仓 `index.json`；`scripts/handoff.mjs` 将锁文件/大数据文件/有意软链计入 `truncated` 且与 `--upgrade` 冲突；`templates/agents-project.md` 骨架偏胖（~21-22KB）且泄漏 `CONVENTIONS_HINT` 等指导语，强制大写覆盖 `agents.md` 破坏软链。
- **`kit/` 单源化缺失与本仓自用泄漏**：6 套 CLI 脚本、`kit/skills/lib/doc-verify.mjs`、`kit/skills/dev-plan/scripts/triage-rules.mjs` 与 `scripts/dev/cli-parity.mjs` 多点重复维护子命令清单；`doc-verify.mjs` 与 `doc-facts.mjs` 硬编码 `node|npm|npx|git` 与窄扩展名；`kit/skills/lib/intake-triage.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs`、`kit/skills/dev-govern/scripts/govern-tests.mjs`、`kit/skills/lib/evidence-substance.mjs` 夹带本仓私有锚点或脚本名；`TOMBSTONE_COMMENT_RE` 与 `kit/skills/lib/no-changelog-voice.mjs` 词表分裂；`kit/skills/lib/feature-map.mjs`、`kit/skills/dev-explore/scripts/repo-map.mjs`、`kit/skills/lib/static-gates.mjs` 与 `dev-govern` 多项匹配与跳过规则存在误判/误漏。
- **跨仓边界、并发实证豁免与角色溯源缺口**：`kit/skills/lib/cli.mjs`、`kit/skills/dev-flow/scripts/flow.mjs`、`kit/skills/dev-flow/scripts/flow-issues.mjs` 缺少跨仓 CWD 错位 fail-closed 拦截；`issue-template-hydrate.mjs` 与 `pr-template-hydrate.mjs` 在 `**Bold**` 提示模板零命中时丢弃 `--body`；`flow.mjs finalize` 未同步更新 SPEC 正文状态表；`review-empirical.mjs` 未对 `low` 风险纯文档豁免强制 runtime 检查，且 `escalation.mjs` 重复建单；`workflow-policy.mjs` 未放行常见并发验证参数且多语言单栈改动误卡全栈；`worktree-deps.mjs` 在 `pnpm` Windows junction 与 Vite `fs.allow` 下缺少兼容处理；`BLOCKED_AUTHOR_IS_IMPLEMENTER` 存在同会话改 Todo 后伪传 `--owner` 绕过风险。
- **单文件行数逼近上限**：`flow-lifecycle.mjs`（799 行）、`profile-sniffer.mjs`（788 行）、`equip.mjs`（783 行）、`govern-checks.mjs`（773 行）、`survey-ecosystem.mjs`（771 行）、`repo-map.mjs`（761 行）、`survey-docs.mjs`（741 行）、`govern-docs.mjs`（741 行）、`survey-workspace.mjs`（722 行）、`compose-agents.mjs`（693 行）等均需伴随本次重构按内聚职责拆小，严守 `<= 800` 行红线。

### 目标用户与使用场景

- **外部仓库治理使用方**：在多生态开源仓（Node/TS、Deno/JSR、Python/uv、.NET `.slnx`、Go、Rust 等）及空白目录中执行 `survey.mjs`、`equip.mjs`、`compose-agents.mjs`、`backup.mjs`、`review.mjs`、`handoff.mjs`。
- **内置技能调用方（协作者 / 隔离代理）**：在装配 `.agents/skills/` 的仓内按 `dev-explore -> dev-plan -> dev-flow -> dev-edit -> dev-review -> dev-govern -> dev-verify-tools -> dev-iterate` 推进任务。

### 产品目标

- 消除多生态勘察、交棒净度、契约体积、单源词表、特征地图及跨仓/并发/角色溯源中的全部系统性误报与漏拦，**不采用针对特定测试仓名称或特例路径的补丁写法**。
- 将全量通用运行能力按严格单向依赖与零文件重叠原则拆分为 `6A -> 6B -> 6C` 三片顺序交付，每片独立通过全量门禁与正反双向测试。

## 二、范围与非目标

### 本次要做（In Scope）

- **Slice 6A（`w6a-survey-handoff-core`）**：重构 `scripts/`、`templates/agents-project.md` 与 `kit/skills/lib/{credential-scan,git-core,profile-sniffer}.mjs`，解决 S1 只读零写入、工作流 job 级安全判定、多生态/workspace 继承与 Linter 隔离探测、大容量备份读取、交棒豁免与升级/净剥模式区分、占位凭据统一决策、受管契约 `< 16KB` 瘦身及小写/软链 `agents.md` 保留。
- **Slice 6B（`w6b-kit-single-source-hygiene`）**：重构 `kit/` 单源化与治理/地图精度，落地单源 `SUBCOMMAND_META`、通用只读命令与多语言路径核查、彻底清零 `kit/` 本仓自用泄漏并加静态门禁、统一履历/墓碑词形引擎并清空历史基线、同步文档事实、提升 `feature-map` / `repo-map` / `static-gates` / `dev-govern` 精度，并补齐跨语言自动生成源码豁免与纯声明式数据源码降级以消除 `<= 800` 行门禁误拦。
- **Slice 6C（`w6c-harness-gates-provenance`）**：加固 `dev-flow`、`dev-review` 与 `kit/skills/lib/` 状态机/门禁契约，落地跨仓 CWD 错位阻断、`Bold` 模板零丢弃、SPEC 正文状态同步、`low` 风险纯文档豁免与错误签名建单去重、多并发标志与单栈验证识别、`pnpm` junction/`fs.allow`/游离槽位兼容性，以及真实角色溯源防伪造。

### 明确不做（Non-Goals）

- 不在本规划期内新增非 GitHub 远端平台注册表适配器，不修改外部 AI 宿主私有约定。
- 不引入任何第三方 npm 依赖（严格保持 Node 18+ `node:*` 零依赖）。
- 不在本规划阶段直接修改业务源码或跳过独立 Critique 擅自批准。

## 三、切片拆解与总控映射（1:N 架构）

三个切片严格按 `6A -> 6B -> 6C` 顺序依赖合入，`scope_files` 互不相交：

```mermaid
flowchart LR
  S6A["6A 勘察与交棒"] --> S6B["6B 单源与卫生"]
  S6B --> S6C["6C 隔离与溯源"]
```

| 切片 `task_id` | SPEC 文档 | 前置依赖 `depends_on` | 认领总控标准 | 核心边界 |
| --- | --- | --- | --- | --- |
| `w6a-survey-handoff-core` | `docs/specs/261122-issue143-w6a-survey-handoff-core-spec.md` | `[]` | `C1` - `C6` | `scripts/` + `templates/` + `credential-scan.mjs` + `git-core.mjs` + `profile-sniffer*.mjs` + `scripts/dev/cli-parity.mjs` + `AGENTS.md` |
| `w6b-kit-single-source-hygiene` | `docs/specs/261122-issue143-w6b-kit-single-source-hygiene-spec.md` | `[w6a-survey-handoff-core]` | `C7` - `C12`, `C19` | `kit/skills/lib/{subcommand-meta,doc-*,intake-triage,evidence-substance,no-changelog-voice,static-gates*,feature-map,tdd-parity,gate-truth,profile}.mjs` + `dev-explore/dev-plan/dev-edit/dev-govern/dev-verify-tools/dev-iterate` + `review-gates.mjs` + `scripts/dev/subcommand-parity.mjs`(new) + `docs/TDD.md` + `README*.md` |
| `w6c-harness-gates-provenance` | `docs/specs/261122-issue143-w6c-harness-gates-provenance-spec.md` | `[w6a-survey-handoff-core, w6b-kit-single-source-hygiene]` | `C13` - `C18` | `kit/skills/dev-flow/` + `kit/skills/dev-review/{review-pack,review-empirical*,review-locks}.mjs` + `kit/skills/dev-plan/scripts/doc-plan-ops.mjs` + `kit/skills/lib/{cli,exit-codes,ledger,docs,doc-approval,harness-context,workflow-policy*,escalation,*-template-hydrate,handoff-package}.mjs` + `docs/feature-map.json` |

## 四、复用既有模块

- `kit/skills/lib/git-core.mjs` & `kit/skills/lib/git.mjs`：复用跨平台路径归一（`canonicalPath`、`samePath`、`posixPath`）、`COMMON_SKIP_DIRS`、`CODE_EXT_RE`、`matchGlob` 与安全文件读写。
- `kit/skills/lib/static-gates-lexer.mjs`：复用多语言词法剥离（`buildLexedViews`、`extractLineCommentInfo`），用于注释层履历词扫描与门禁判定。
- `kit/skills/lib/credential-scan.mjs`：复用凭据文件与正文扫描单一真相原语。
- `kit/skills/lib/profile-sniffer.mjs`：复用三层命令嗅探与子包清单发现。
- `scripts/lib/protocol.mjs`、`scripts/lib/template.mjs`、`scripts/lib/render.mjs`：复用受管标记语法、模板渲染求值与报告排版单一真相源。

## 五、非功能要求

| 维度 | 要求 | 怎么验 |
| --- | --- | --- |
| 零第三方依赖 | `scripts/` 与 `kit/` 仅使用 Node 18+ `node:*` 内置模块 | `node scripts/dev/preflight.mjs` |
| 单文件体积与行数 | 所有新增与修改 `.mjs` 严格 `<= 800` 行；`AGENTS.md` 受管空骨架 `< 16KB`（上限 `30720 B`） | `node scripts/dev/preflight.mjs`、`node scripts/compose-agents.mjs . --check` |
| 自包含与字节一致 | `kit/skills/` 与 `.agents/skills/` 经 `equip.mjs` 同步后字节一致，且 `kit/` 无本仓私有符号泄漏 | `node scripts/equip.mjs . --check`、`node scripts/dev/preflight.mjs` |
| 双向证伪与故障注入 | 每项新判定与解析逻辑具备正反双向夹具及故障注入条目 | `node scripts/dev/fixtures.mjs --jobs 6`、`node scripts/dev/verify-injections.mjs --jobs 4` |

## 六、验收标准

- [ ] C1: `scripts/lib/survey-docs.mjs`、`scripts/lib/survey-gap-rules.mjs` 与 `scripts/review.mjs` 按工作流文件+job 粒度结构化判定 `pull_request_target` 与不安全 PR checkout，豁免 `pull_request.number` 与 `# zizmor: ignore[dangerous-triggers]`；补齐 `uv publish`、`dotnet ... publish`、`jsr publish`、`vp pack` 与 `simple-git-hooks` / `.git/hooks/*` 检测。
- [ ] C2: `scripts/lib/survey-ecosystem.mjs`、`kit/skills/lib/profile-sniffer.mjs`、`scripts/lib/agents-defaults.mjs` 与 `kit/skills/lib/git-core.mjs` 支持 `.slnx`、`jsr.json` / `deno.json`、`pnpm-workspace.yaml` 继承、`!` 负向 glob 与 `hasManifest` 边界（消除 80 子包爆炸、`Benchmarks` 误选 `dotnet test`、`*.csproj` 覆盖 `MinVer`）；`equip.mjs` / `survey.mjs` 探测根 Linter/Formatter 输出 `.agents/` 忽略隔离方案；`survey()` 严格零写入（取消误写 `session-state.json`）。
- [ ] C3: `scripts/backup.mjs` 取消 512KB `index.json` 读取截断上限（支持任意体积与精简条目元数据）；`scripts/handoff.mjs` `--verify` 对锁文件（`*-lock.*`、`*.lock`）、大数据非工程文件及有意软链不计入 `truncated` 退出码 `3`，区分持续 `--upgrade` 受管态（通过）与 `--strict-clean`（要求剥离），并在 `scripts/dev/cli-parity.mjs` 登记 `--strict-clean`。
- [ ] C4: `kit/skills/lib/credential-scan.mjs`、`scripts/lib/survey-workspace.mjs` 与 `scripts/review.mjs` 识别 `${...}` 动态 PEM 模板字面量、扫描 `.env*` 测试夹具正文、为 `secrets.tracked` 与 `secrets.exposed` 统一接入 `decision: 'secrets-are-placeholders'`，且 `git.output-dirs` 跳过全部受 Git 跟踪或 `.gitignore` `!` 显式放行的目录。
- [ ] C5: `templates/agents-project.md`、`scripts/lib/agents-defaults.mjs`、`scripts/lib/equip-bootstrap.mjs` 与 `scripts/compose-agents.mjs` 精简受管模板骨架（落盘空骨架 `< 16KB`，14KB 存量 `AGENTS.md` 可无损 `--upgrade`）并同步 `AGENTS.md`（保留 `preflight-suite.mjs` 与 `preflight-contract-rules.mjs` 必检契约及 7 步结构），彻底消除 `CONVENTIONS_HINT` / `暂未追加...` / `目录结尾带 /...` 等 AI 指导语泄漏并保留既有小写 `agents.md` / 软链指向；拆小 `survey-workspace.mjs`、`compose-agents.mjs`、`profile-sniffer.mjs` 使全部 `.mjs` `<= 800` 行。
- [ ] C6: Slice 6A 新增正反双向夹具（`scripts/dev/fixtures-w6a-survey-handoff.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6a.mjs`(new)）且 `.agents/skills/`（含 `.agents/skills/.pf-manifest.json`）同步一致，`node scripts/dev/preflight.mjs`、`node scripts/dev/gap-coverage.mjs`、`node scripts/dev/fixtures.mjs --jobs 6` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 全绿。
- [ ] C7: 单源导出 `SUBCOMMAND_META`（`{ name, mutating }`），统一 `doc-plan.mjs`、`govern-audit.mjs`、`verify-tools.mjs`、`iterate.mjs`、`doc-verify.mjs`、`triage-rules.mjs` 与新增 `scripts/dev/subcommand-parity.mjs`(new)（接入 `scripts/dev/preflight-suite.mjs`，为 `flow.mjs` / `review-pack.mjs` 在 6C 接入提供分阶段单源校验基线）。
- [ ] C8: `kit/skills/lib/doc-verify.mjs` 与 `kit/skills/lib/doc-facts.mjs` 复用 `COMMON_SKIP_DIRS`、通用多生态只读命令与目标仓 `Dev Profile` 替代 `node|npm|npx|git` 硬编码，并扩充多语言后缀识别。
- [ ] C9: 清零 `kit/` 中全部 `project-forge` 自用逻辑与示例（`intake-triage.mjs` 动态读取目标仓 `AGENTS.md` 与权威文档、`edit-gate.mjs` 与 `govern-tests.mjs` 去掉 `verify-injections|gap-coverage` 硬编码、`evidence-substance.mjs` 等清理），并在 `scripts/dev/preflight-suite.mjs` 新增零本仓私有符号静态门禁。
- [ ] C10: 合并 `TOMBSTONE_COMMENT_RE` 与 `kit/skills/lib/no-changelog-voice.mjs` 为单源词形引擎（剥离字面量后同步查 `.mjs` 注释），清零 `doc-verify.mjs`、`gate-truth.mjs`、`profile.mjs`、`tdd-parity.mjs`、`references/plugin-ecosystems.md` 等存量履历注释并清空 `.github/changelog-voice-baseline.json`；同步 `docs/TDD.md`（去易变计数）、`README.md` / `README.en.md`（补 `scripts/zip.mjs`）与 `kit/skills/dev-govern/SKILL.md`。
- [ ] C11: 提升 `feature-map.mjs`、`repo-map.mjs`、`static-gates.mjs` 与 `dev-govern` 精度（同生态与路径边界匹配、过滤 `dist/`/`.github/workflows/`/`*.test.*`/`.agents/`、`UI_VISUAL_EXT_RE` 正则排除测试/夹具路径并导出 `isUiVisualFile` 免疫全部 6 处调用、`TEST_CASE_RE` 排除 `.test(` 方法调用、`govern-audit --save-baseline --quiet` 不跳过 `tests`/`perf`、`reconcile` 联动 `verify-tools audit`、`govern-docs` 跳过译文 `docs/{lang}/`、`govern-evergreen` 识别 VitePress 根路由与子包路径、`govern-checks` 跳过纯跟踪源码目录 `build/`）；拆小 `govern-checks.mjs` 与 `repo-map.mjs` 严守 `<= 800` 行。
- [ ] C12: Slice 6B 新增正反双向夹具（`scripts/dev/fixtures-w6b-kit-hygiene.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6b.mjs`(new)），运行 `node scripts/equip.mjs .` 后全量门禁与 `node .agents/skills/dev-govern/scripts/govern-audit.mjs audit . --strict` 全绿。
- [ ] C13: `kit/skills/lib/cli.mjs`、`kit/skills/lib/exit-codes.mjs`、`kit/skills/dev-flow/scripts/flow.mjs` 与 `kit/skills/dev-flow/scripts/flow-issues.mjs` 实现跨仓工作目录不匹配 fail-closed 拦截（在 `exit-codes.mjs` 登记 `BLOCKED_CROSS_REPO_CWD_MISMATCH`）；`flow.mjs` 与 `review-pack.mjs` 接入 `SUBCOMMAND_META` 单源并对齐文件头。
- [ ] C14: `kit/skills/lib/issue-template-hydrate.mjs` 与 `kit/skills/lib/pr-template-hydrate.mjs` 兼容 `**Bold**` 提示模板且零 section 命中时完整保留 `--body`；`flow.mjs finalize` 同步归档 `SPEC` 正文状态表与 YAML `status: implemented`。
- [ ] C15: `kit/skills/dev-review/scripts/review-empirical.mjs`、`review-pack.mjs` 与 `kit/skills/lib/escalation.mjs` 对 `low` 风险纯文档变更豁免强制 runtime `check-empirical` / `faultRequired` / `--include-diff` 阻塞，且 `escalation.mjs` 按错误签名去重（不重复建单）。
- [ ] C16: `kit/skills/lib/workflow-policy.mjs`、`kit/skills/lib/workflow-policy-next.mjs` 与 `kit/skills/dev-review/scripts/review-empirical-state.mjs` 扩展 `isEquivalentConcurrentCommand` 识别 `--maxWorkers` / `--workers` / `--bail` / `--config.verify-deps-before-run=false`；为多语言仓单栈局部变更提供子包/单栈作用域验证识别（未改栈缺失环境不误阻塞）。
- [ ] C17: `kit/skills/dev-flow/scripts/worktree-deps.mjs` 与 `docs/feature-map.json` 修复独立 `mount` 更新 `mountedDepsByWorktree`、为 `pnpm` junction 透传 `npm_config_verify_deps_before_run=false` 并给出 Vite `fs.allow` 引导，基于 6B 在 `edit-gate.mjs` 落地的 `--base` 与游离 `HEAD` 兼容能力修复 `verify-edit-gate` 在游离 review 槽执行兼容性；拆小 `flow-lifecycle.mjs`（798 行）、`flow-merge.mjs`（793 行）、`flow-inspect.mjs`（792 行）严守 `<= 800` 行。
- [ ] C18: 强化规划/实施/审查真实角色溯源校验：由 `doc-plan init/link`（`doc-plan-ops.mjs` / `docs.mjs` / `doc-approval.mjs` / `ledger.mjs`）将不可伪造 `planningProvenance` 写入仓外 `.git/project-forge-flow/` 账本，在 `start`/`claim`/`submit` 拦截未走 `doc-plan link` 直改 Todo `owner:` 的篡改（在 `exit-codes.mjs` 登记 `BLOCKED_PROVENANCE_TAMPERED`）与历史规划作者重叠（`BLOCKED_AUTHOR_IS_IMPLEMENTER`），去掉按 Git commit author 拦截本地隔离实施者的误杀设计并诚实界定 `handoff-package.mjs` 证明边界；Slice 6C 新增正反双向夹具（`scripts/dev/fixtures-w6c-harness-gates.mjs`(new)）与故障注入（`scripts/dev/injections-data-w6c.mjs`(new)），执行 `node scripts/equip.mjs .` 后全量门禁全绿。
- [ ] C19: 在 `kit/skills/lib/static-gates.mjs`（`scanStructuralHygiene`）、`kit/skills/lib/static-gates-comment-hygiene.mjs`、`kit/skills/dev-edit/scripts/edit-gate.mjs` 与 `kit/skills/dev-review/scripts/review-gates.mjs` 补齐 `<= 800` 行门禁两类误拦边界（禁按框架文件名硬编码）：(1) 跨语言自动生成源码豁免（识别前 20 行标准自动生成头标后免检 `godFile` / `nearLimitFile` / 履历墓碑 / 注释死代码，同时保留 `scripts/dev/preflight-suite.mjs` 对本仓 `kit/` 脚本的 800 行硬检）；(2) 纯声明式数据源码降级（高字面量占比、极低控制流密度的纯表驱动文件在 `scanStructuralHygiene` 中不置位 `godFile` 而改为 `declarativeDataFile`，使 `edit-gate.mjs` 降级为 warning 放行且 `review-gates.mjs` 不误报 `godFiles`；真实混杂业务逻辑的 `>800` 行神文件仍严格拦截，并配双向正反测试防注释/假表绕过）。

## 七、待拍板问题

- 待确认：无

## 八、成功度量

| 度量 | 现状基线 | 目标 | 怎么采集 | 什么时候看 |
| --- | --- | --- | --- | --- |
| 真实多生态仓 S1/handoff 误报项 | 6 组盲测仓存在 `ci.pwn-request`、80 子包爆炸、`truncated=3`、`CONVENTIONS_HINT` 泄漏等系统误报 | 全部根因转通用结构判定，正反双向夹具 100% 覆盖 | `node scripts/dev/fixtures.mjs --jobs 6` | `6A` 合入后 |
| `kit/` 本仓私有符号与履历债 | 存在多处本仓锚点、`SUBCOMMANDS` 分裂与 5+ 处履历注释 | 本仓私有符号 0 残留，`.github/changelog-voice-baseline.json` 清零 | `node scripts/dev/preflight.mjs`、`govern-audit.mjs audit . --strict` | `6B` 合入后 |
| 跨仓安全、文档豁免与角色溯源 | 缺 CWD 错位拦截、`low` 文档被 runtime 卡死、同会话可伪传 `--owner` | 全部边界 fail-closed 拦截且 `low` 纯文档豁免顺畅 | `node scripts/dev/fixtures.mjs --jobs 6`、`verify-injections.mjs --jobs 4` | `6C` 合入后 |

## 九、门型与回滚路径

- **门型判定**：`two-way`（三片均在独立特性分支/worktree 实施，通过 `scripts/dev/preflight.mjs` 与 `scripts/dev/fixtures.mjs` 回归护航；未涉外部不可逆迁移）。
- **回滚路径**：各切片独立提交并附各自双语夹具与故障注入；若任一切片合入后出现回归，按单切片执行 `git revert` 反向提交即可，不影响既有主干或前置切片基线。

## 十、依赖与前置条件

| 依赖 | 类型 | 就绪状态 | 没有它会怎样 |
| --- | --- | --- | --- |
| 独立 Critique 与人类 `approve` | 流程审批 | 进行中（待 `critic-w6` 审核） | 无法解锁 `flow.mjs start` 进入 `6A`/`6B`/`6C` 实施 |
| `6A` 合入 `main` | 技术依赖 | 待 `6A` 实施 | `6B` 无法直接消费 `6A` 对 `git-core.mjs` 的公共原语升级 |
| `6B` 合入 `main` | 技术依赖 | 待 `6B` 实施 | `6C` 无法在 `flow.mjs` / `review-pack.mjs` 中直接消费 `SUBCOMMAND_META` |

## 十一、风险与缓解措施

| 风险 | 可能性 | 影响 | 缓解办法 |
| --- | --- | --- | --- |
| 改造近限 `.mjs` 文件超过 800 行上限 | 高 | 触发 `edit-gate` 与 `preflight` 阻断 | 各 SPEC 显式规划拆分新模块（`survey-workspace-secrets.mjs`(new)、`compose-agents-helpers.mjs`(new)、`profile-sniffer-packages.mjs`(new)、`govern-checks-hygiene.mjs`(new)、`repo-map-helpers.mjs`(new)、`flow-lifecycle-finalize.mjs`(new)、`flow-start-provenance.mjs`(new)、`flow-merge-claim.mjs`(new)） |
| 6B/6C 修改 `kit/` 后遗忘同步 `.agents/skills/` | 中 | `equip.mjs . --check` 失败 | 每个切片验收标准与 Todo 执行步骤强制包含 `node scripts/equip.mjs .` |
| 精简 `templates/agents-project.md` 误删 `fixtures-flow-parallel.mjs` 断言条件 | 中 | 既有夹具回归失败 | 6A `scope_files` 包含 `scripts/dev/fixtures-flow-parallel.mjs`，同步更新断言核验无 AI 指导语泄漏 |

## 澄清与补充记录

- 已定（2026-11-22）：1:N 切片合并顺序定为 `w6a-survey-handoff-core` -> `w6b-kit-single-source-hygiene` -> `w6c-harness-gates-provenance`，三份 SPEC `scope_files` 严格零文件重叠；`protocol.mjs` 归属 `6A`（处理 `TEMPLATE_VARS` 与 line 176），`subcommand-meta.mjs`(new) 归属 `6B` 并由 `6C` 在 `flow.mjs` / `review-pack.mjs` 接入消费。

> 确认需调整系统模块或对外契约时，以此 PRD 为依据补充 `docs/specs/` 后再进入实现；需求全部交付后随同关联 `SPEC`/`Todo` 成对归档至 `docs/archive/prd/`；`1:N` 总控 PRD 走四态闭环（子切片合入时仅追加关联进度，全部分支交付完成后统一归档总控 PRD）。
