# {{PROJECT_NAME}} — 项目工程契约（每次会话自动读）

AI 新会话先读本文件，确认定位、边界、命令与协作流程。**只写现状，不写履历；面向人的文档见 `{{PRIMARY_README}}`、`CONTRIBUTING.md`（可选）、`{{RELEASING_DOC}}`。** 账号、远端、分支与版本现场读取；**24KB 预警、上限 30KB**，长文外置 `docs/TDD.md` 或 `<subdir>/AGENTS.md`。

<!-- project-forge: begin 意图路由 -->
## 意图路由（静默触发，不反问）

命中自然语言意图时**静默读取对应 `SKILL.md` 并先跑引擎脚本**，不反问也不要求 `/skill`：

| 用户自然语言意图 | 加载本地 Skill | 先跑引擎脚本（按需传参） |
| --- | --- | --- |
{{KIT_ROUTING_ROWS}}
| 首次规范化接管 / 规范项目 / 初始化 / 标准化配置 / 升级规范与本地技能 / 交棒清理 | 调用治理技能（`survey` / `equip` / `review` / `handoff`） | 始终先只读 `survey.mjs`，不直接写业务代码 |
<!-- project-forge: if has-custom-skills -->

### 项目自有技能（自动识别，与上方研发流并存）

以下技能位于仓库自有目录，命中时静默读取 `SKILL.md` 执行；`equip.mjs` 与 `compose-agents.mjs` 完整保留：

{{CUSTOM_SKILLS_BLOCK}}
<!-- project-forge: endif -->
<!-- project-forge: end 意图路由 -->

<!-- project-forge: begin 行事总纲 -->
## 行事总纲与决策准则

- **四条准则与高维认知**：1. 治本不治标（锚定业务目标并先质疑前提）；2. 写原则不写死；3. 融入结构（先做 Deletion Test，能删/合并单源绝不叠平行抽象）；4. 保持清朗（清废弃路径与已证伪死路）。
- **信任倒金字塔**：`确定性静态与类型门禁（类型/Schema/arch-rules） > 真实启动与端到端实证（测试/smoke-verify/UI 渲染截图/CLI 实测） > 静态读代码与独立审查 > 文档约定`；同类纠偏复发满 2 次沉入结构重构或静态检查并清死代码。
- **改前改后与验收**：先给最优解；改前查复用、并发雷达并判 `two-way`/`one-way` 门型；无子代理宿主显式按 `hostCapability: serial-fallback` 分片串行降级；改后凭实证汇报，不让用户代劳验收；只锁客观输出边界（产物、接口与断言），不锁私有过程。
<!-- project-forge: end 行事总纲 -->

<!-- project-forge: begin 项目定位 -->
## 项目定位

<!-- project-forge: fill 项目定位：两三句话说清本项目解决什么问题、面向谁、对外提供什么形态（命令行工具 / 库 / 服务 / 应用 / 插件 / 能力目录），以及明确不做什么 -->
<!-- project-forge: end 项目定位 -->

<!-- project-forge: begin Dev Profile -->
## Dev Profile

以下键值由研发流脚本自动读取，核对后替换为真实值（无对应项填 `none`；自定义常青文档可另加可选键 `evergreen-docs:` 或在文档头部写 `evergreen: true`）：

```yaml
quick-test: {{PROFILE_QUICK_TEST}}
full-test: {{PROFILE_FULL_TEST}}
smoke-verify: {{PROFILE_SMOKE_VERIFY}}
merge-gate: {{PROFILE_MERGE_GATE}}
arch-rules: {{PROFILE_ARCH_RULES}}
high-risk: {{PROFILE_HIGH_RISK}}
do-not-edit: {{PROFILE_DO_NOT_EDIT}}
```
{{PROFILE_FILL_HINT}}
<!-- project-forge: end Dev Profile -->

<!-- project-forge: begin 上下文阅读护栏 -->
## 上下文阅读护栏

- **按序按需定位**：`AGENTS.md` -> `docs/TDD.md`（若存在）-> {{SUBDIR_AGENTS_POINTER}} -> 用 `doc-locate.mjs` / `repo-map.mjs` 定位切片，再跑 `flow.mjs inspect` 查状态。
- **演进跳读**：`docs/TDD.md`（若存在）新会话先看目录再按节跳读；`docs/feature-map.json`（若存在，v1/v2 拓扑）按变更切片查询，并派生离线 `docs/architecture-map.html`（可选，`no-architecture-html` 可豁免）；Case 3/4 规划自动维护仓外 Living Visual Brief（`doc-plan.mjs brief`）。
- **默认不读**：`docs/archive/`、`node_modules/`、`dist/`、`build/`、`.worktrees/`、锁文件全文与构建缓存（`do-not-edit` 仅禁手改历史归档，允许 `finalize`/`archive` 归档）。
<!-- project-forge: end 上下文阅读护栏 -->
<!-- project-forge: if has-exploration-strategy -->

<!-- project-forge: begin 探索策略 -->
## 探索策略

{{EXPLORATION_STRATEGY}}
<!-- project-forge: end 探索策略 -->
<!-- project-forge: endif -->

<!-- project-forge: begin 架构与关键不变量 -->
## 架构与关键不变量

### 模块与入口

<!-- project-forge: fill 模块入口：按「职责 → 入口文件或目录」列出核心模块；如已维护 docs/TDD.md，此处只留薄指针指向 docs/TDD.md（含业务流与改前实跑基线） -->

### 关键不变量（破坏即事故）

<!-- project-forge: fill 关键不变量：列出「改 A 必须同步看 B」「哪条数据格式 / 接口协议 / 包边界绝不可破」，并注明定义它的权威文件 -->
<!-- project-forge: if is-monorepo -->

## 多包仓库边界（Workspace）

根层负责全局门禁编排，子包（{{WORKSPACE_PACKAGES}}）各自维护入口与依赖声明，**严禁跨子包直接引用未导出的内部私有路径**。子包专属约定放入 `<package>/AGENTS.md`（开头指回根契约，不重复抄通用规则）。
<!-- project-forge: endif -->
<!-- project-forge: if is-plugin-or-skill -->

## 宿主加载与分发边界

- **身份标识零容错**：宿主清单或 `SKILL.md` frontmatter 必填字段必须严格对齐规范，宿主侧 ID 与分发包名**绝不混改**。
- **产物与分发通道对齐**：直读仓库编译产物时同提交重建，走发布附件时编译产物不入库；**严禁用符号链接代替隔离安装验收**。
<!-- project-forge: endif -->
<!-- project-forge: end 架构与关键不变量 -->

<!-- project-forge: begin 构建与验证 -->
## 环境与构建验证（改完必跑，全绿才算完成）

- **运行环境要求**：{{RUNTIME_REQUIREMENTS}}
<!-- project-forge: if has-commands -->

```sh
{{COMMANDS}}
```
<!-- project-forge: endif -->
<!-- project-forge: if has-omitted-commands -->

{{COMMANDS_OMITTED}}
<!-- project-forge: endif -->
<!-- project-forge: if no-commands -->

本项目尚未在清单里声明标准命令。读源码后替换为真实命令（纯文档项目说明无构建步骤并删除代码块）：

<!-- project-forge: fill 构建与验证命令：填这个项目真实的构建、静态检查、测试命令，一条一行 -->
```sh
# 把真实命令写在这里，然后删掉上面那行 fill 标记
```
<!-- project-forge: endif -->

**形式门禁通过且真实运行/E2E 观察达标（改运行态且 `smoke-verify` 非 `none` 须跑通并附 `--e2e-evidence`；UI 须核交互及浅深色图；异常脱敏建单）才算完成**——无实证不得声称已验证。
<!-- project-forge: end 构建与验证 -->

<!-- project-forge: begin 修改守则 -->
## 工程修改守则与硬性规范

- **严控范围与依赖**：改前读邻近实现并清旧逻辑；禁擅增第三方依赖，确需引入先说明并获确认。
- **测试正反双向与分层控频**：修缺陷先写失败测试（Red-Green）；新判定/解析配正反双向用例。编码期跑 `--tier quick --target <path>`，合前跑 `full-test`/`merge-gate`；禁零断言、纯 Mock 自证、单测 `>=1s` sleep 与弱化门禁；单测超 800 行按模块拆分。
- **禁坏味注释与文档同步**：只写现状——**禁履历/死代码注释**及无故压制（`HACK`/`WORKAROUND`/`TEMP`/`@ts-ignore`/`eslint-disable`/`# type: ignore`/`# noqa`/`#[allow(`）；改导出、CLI、边界或契约同步 `docs/TDD.md`（若存在）、`{{PRIMARY_README}}`、`AGENTS.md`。
- {{COMMIT_STYLE_HINT}}
<!-- project-forge: if has-bilingual-docs -->
- **多语文档成对同步**：本仓库有 {{README_LIST}}，改任一版本必须同步另一份并保持双向链接有效。
<!-- project-forge: endif -->
<!-- project-forge: end 修改守则 -->

<!-- project-forge: begin 修改守则补充 -->
## 项目特有红线

<!-- project-forge: fill 项目特有红线：补充本项目特有的硬性规范（如兼容性下限、性能预算等）；无额外规范可直接删掉本行 -->
<!-- project-forge: end 修改守则补充 -->

<!-- project-forge: begin 版本与发布 -->
## 版本管理与回滚底线

- **提交纪律**：一实质变更一独立提交，写清改了什么与为什么，不用内部编号充当说明；高风险前留存档点；产物或锁文件同提交更新。
<!-- project-forge: if has-remote -->
- **回滚四档**：未提交丢工作区；已提交未推回存档点；**已推远端一律反向提交，严禁强推或改历史**；已发布只能发递增新版本。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **回滚四档**：未提交丢工作区；未并主干可重置；已并主干一律反向提交，不改写主干；已发布只能发递增新版本。
<!-- project-forge: endif -->
<!-- project-forge: if has-release -->

### 版本号与发版死锁防护

版本号以 `{{VERSION_SOURCE}}` 为唯一权威；**兼容性下限只上移、不下移、默认不动**。**日常与发版分开，默认只做日常**：
<!-- project-forge: if has-remote -->
- **日常（分档看能不能撤回）**：推自己的分支、开 PR、改 PR 撤得回来属日常（不打标签不发制品库）；合并默认分支、发版、改可见性、改写历史撤不回来，强推永不自动执行。
- **发版**：不自己判断该发版，只有人明确说要发版时才按 `{{RELEASING_DOC}}` 先推发布说明（`{{RELEASE_NOTES_TARGET}}`）到 `{{DEFAULT_BRANCH}}`，再打标签并回读确认发布页与制品就位。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **日常**：改完 -> 跑门禁 -> 提交至本地特性分支 -> 独立审查 -> 本地试合并入 `{{DEFAULT_BRANCH}}`（不打标签不发制品库）。
- **发版**：不自己判断该发版，只有人明确说要发版时才按 `{{RELEASING_DOC}}` 准备发布说明（`{{RELEASE_NOTES_TARGET}}`）与递增版本。
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: end 版本与发布 -->

<!-- project-forge: begin 日常协作与风险分流 -->
## 日常协作：改动怎么落地

- **第一步：双轴五态身份判定与入站分诊**——
<!-- project-forge: if has-remote -->
  先核对远端与源仓库：`origin` 一致且有写权为 **maintainer**（分支开 PR，禁直推主干）。多协作者团队：① 新成员先 `flow.mjs inspect --probe-auth` 验写权；② `flow.mjs claim` 防撞车，接管须 `--takeover --reason` 双写 Issue+PR（弃领 `release`）；③ 守 `CODEOWNERS`/Merge Queue；④ 互审（保守仓写 `merge-authority: human`）。Fork 为 **contributor-fork**（推 fork 向 `upstream` 开 PR，禁自合与提前删分支，标签 403 降级）；只读为 **clone-readonly**；未注册主机退化 `generic-git`（手工 MR，merge 四态核验）；新增单经 `flow.mjs intake` 分诊。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
  还没有远端时按 `local-only` 运作，走本地特性分支与 `--detach` 试合推进主干；高风险或 `one-way` 仍须独立审查，新增提案走 `flow.mjs intake` 离线分诊。
<!-- project-forge: endif -->

- **第二步：纯调度分波、确定性三出口与三轴正交双环**——主调度**只调度与验收，不改业务源码、不代提合入单**，探索/规划/实施/审查均派独立隔离代理（`--host-mode single-session --human-approved` 仅限无子代理单会话宿主且经人授权）。跑 `flow.mjs next --handoff`（`Wave 1 >= 2` 并行）或 `doc-plan.mjs triage`（确定性输出 `recommendedEntry: direct | sandbox | plan-first` 与单一 `[NEXT STEP]`，按需投影 Living Visual Brief）；弹性探索按范围选直跑 `doc-locate`/`repo-map` 或并行 `explore`，外部调研注明来源且仓内路径/符号/命令必经本地验真。`commits > 0` 默认分支 `doc-plan.mjs init` 自动隔离进 `.worktrees/impl-<taskId>/`（先 `flow.mjs start --planning` 则同位复用）：

  | 档位 | 触发特征 | 文档与检查动作 |
  | --- | --- | --- |
  | **Case 1** | 纯问答 / 错别字 / 单行格式 | 0 文档，允许原地微调，跑对应检验（`docs:`） |
  | **Case 2** | 明确局部缺陷，不改对外契约 | 0 文档，**先写失败测试再修（Red-Green，`fix:`）** |
  | **Case 3** | `L2` 功能调整，不改外部契约 | `{{WORK_DIR}}` 建 Todo 冻结 `C1..Cn`；跑 `doc-plan.mjs audit` 自净化直通（Critique 仅建议） |
  | **Case 4** | `L3` 跨模块/契约变更或高风险 | `docs/specs/` + `{{WORK_DIR}}` Todo；经 `audit` + 3 轮 Critique（禁自审）-> `approve` |
  | **Case 5** | 与 `docs/TDD.md`（若存在）或生效 `SPEC` 冲突 | **阻断并先更新 `docs/TDD.md`**（若存在），内审获批后继续 |

  三轴正交策略：`riskTier`（`low` 纯文本排除视觉 / `medium` 常规与局部 UI / `high` 高风险、`one-way`、弱化门禁或 `Case>=4`）、`visualCheckRequired`（视觉独立于 `high`）、`faultInjectionRequired`（仅绑 `high`/`one-way`/`Case>=4`）；`evidence.json` 拦 `quick --target` 顶替全量并由外环硬拒内环 `inner: true`；Case 2-4 在隔离 `impl` 位派 `impl` 代理（Case 1 允许原地微调）。

- **第三步：隔离沙箱双环、Worktree 隔离与共享依赖**——`commits === 0` 且非 `--parallel` 或 `Case 1` 允许原地微调；**`commits > 0` 的 `Case >= 2`** 禁在脏主仓原地开工（`BLOCKED_MAIN_SLOT_VIOLATION`），可逆探索走 `flow.mjs start --sandbox` 入 `.worktrees/sandbox-<taskId>/`（隔离沙箱不污染主仓、记 `implementers[]` 与互不重叠 `writeScope`、内环快检标 `inner: true` 且失败不刷远端 Issue），拍板后 `flow.mjs promote` 按真实差分路由（`Case 2/3` 原地晋升 / `Case 4` PoC 转规划 / `Case 5` 阻断）；常规外环建 `.worktrees/impl-<taskId>/` + `.worktrees/review-<taskId>/`。卸 worktree 前先 `worktree-deps.mjs` 解绑链接，禁递归直删。**只读探索转非 `Case 1` 写改必先 `flow.mjs start` 隔离 worktree，改后经 `edit-gate` 与 `review-pack`。**

<!-- project-forge: if has-remote -->
- **第四步：认领、确定性 Issue 绑定与 PR 前文档同步**——`flow.mjs start` 对 `Case >= 2` 先复用已有单据，非豁免（`no-auto-issue` / `--no-issue --reason`）时 `Case 3/4` 由验真文档自动建单回链、`Case 2` 无单且缺合规 `--body`/`--body-file` 报 `BLOCKED_MISSING_ISSUE_BINDING`。**谁改代码谁认领并负责 `finalize`/`verify`（前置 `edit-gate --final` 且禁 `--skip-edit-gate`）/`submit --agent <id>`**（禁协调/审查者代提，同名作者拦 `BLOCKED_AUTHOR_IS_IMPLEMENTER`）；外部 PR 入 `.worktrees/review-pr-<M>/` 先扫高危；PR 前跑 `flow.mjs finalize`（全勾 `[x]`、成对归档，`1:N` PRD 走四态），`submit` 零写回跟踪文件。

- **第五步：独立审查与合并**——**独立审查通过（`--enforce-gates`、`reviewToken` 绑定、`fail` 为空、`reviewPassedHead === HEAD`）后由审查者直接合（A3 允许调度者执行 `flow.mjs merge`，严禁实施者自合）**（Round 2+ 换全新上下文，受同 `HEAD`/增量视野/全历史换人与 3 轮停损约束；UI 缺真实 `--artifact`/`--visual-blocked-reason` 阻断；触高风险须故障注入；**仅弱化门禁须人点头**，退出码 4；「取舍」写 `merge-authority: human` 收回人合；`contributor-fork` 禁自合；`generic-git` 推分支交手工 MR，merge 核四态）。合前强校三方 `headSha` 与干净工作区。

- **第六步：合并收尾与平台防乱码**——固定 7 步，顺序不能调：
  1. **把要写的东西写完，并纳入这次 PR**：Todo 完成记录与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、随同分支提交；
  2. 合并 PR（不勾选自动删分支）；
  3. 回读确认 `state=MERGED`；
  4. `git switch {{DEFAULT_BRANCH}} && git pull`；
  5. **先卸 worktree**：`git worktree remove <路径>`（先 `worktree-deps` 解绑共享依赖链接）；
  6. 再删本地分支：`git branch -d <分支>`（不是 `-D`）；
  7. **删远端分支前查两件事**：远端还在不在（`git ls-remote --heads origin <分支>`，多远端换写权远端名）、有没有下游堆叠 PR 以该分支为 base（Fork 另查上游 PR 非 `OPEN`）；两件都清了才 `git push origin --delete <分支>`（多远端换对应写权远端名）。

  **第 5 步前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支及干净状态；**问到人点头才删**（`flow.mjs cleanup --confirm --preview-hash <hash>`）。平台命令含非 ASCII/反引号正文优先用工具或单引号 `@'...'@` 写临时 UTF-8 文件经 `--body-file`/`--notes-file` 提交后删（禁 `pwsh` 双引号/`@"..."@`）。

- **日常到此为止**：合并即改动终点，发版必须人明令。
- **同步不变量**：本节改动须与协作判据同提交对齐；指路只用标题名。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **第四步：任务留痕、确定性本地建单与合并前文档同步**——`flow.mjs start` 对 `Case >= 2` 先复用已有单据，非豁免（`no-auto-issue` 取舍或 `--no-issue --reason`）时 `Case 3/4` 自动建本地工单回链、`Case 2` 缺单且无 `--body-file` 报 `BLOCKED_MISSING_ISSUE_BINDING`；**谁改代码谁认领并负责 `finalize`/`verify`/`submit`**，一任务一特性分支；合入前跑 `flow.mjs finalize` 完成勾选与成对归档（`1:N` 总控 PRD 走四态），`submit` 校验干净状态并同步审查槽。

- **第五步：独立审查与本地试合**——**独立审查通过（`fail` 为空、`reviewPassedHead === HEAD`）后由审查者直接合入 `{{DEFAULT_BRANCH}}`（A3 亦允许由调度者执行 `flow.mjs merge`，仍严禁实施者自合）**（Round 2+ 换全新上下文，受全历史换人与 3 轮停损约束；**仅弱化门禁须人点头**；「取舍」写 `merge-authority: human` 收回人合）。本地合入经 `--detach` 试合复测后 `--ff-only` 推进主干。

- **第六步：本地合入收尾与 Worktree 清理**——1. 合并前完成 Todo 记录与归档；2. `flow.mjs merge` 推进 `{{DEFAULT_BRANCH}}`；3. `git switch {{DEFAULT_BRANCH}}` 核对主干；4. 列出 worktree 与本地分支干净清单，**问到人点头才删**（`flow.mjs cleanup --confirm --preview-hash <hash>`）。

- **日常到此为止**：本地合入 `{{DEFAULT_BRANCH}}` 即改动终点，发版必须人明令。
- **同步不变量**：本节改动须与协作判据同提交对齐；指路只用标题名。
<!-- project-forge: endif -->
<!-- project-forge: end 日常协作与风险分流 -->

<!-- project-forge: begin 高风险路径 -->
## 高风险路径（触碰须独立审查 + 故障注入）

改在这里出错不会当场失败，而是让门禁从此少查一项——坏了看着还是一片绿。

<!-- project-forge: fill 高风险路径：列出本项目中「改错了不可逆、或会让门禁从此静默少查一项」的目录前缀或文件 -->
<!-- project-forge: end 高风险路径 -->

<!-- project-forge: begin 改哪看哪 -->
## 改哪看哪

| 这次动了 | 必须一起看 |
| --- | --- |
| `<核心模块或公开契约>` | `docs/TDD.md`、`<对应测试与 README>` |
<!-- project-forge: if has-bilingual-docs -->
| `{{PRIMARY_README}}` | {{README_LIST}}（成对同步） |
<!-- project-forge: endif -->

<!-- project-forge: fill 改哪看哪：替换为本项目真实「改动路径与联动文件」映射（至少含反引号相对路径，无则删去示例行） -->
<!-- project-forge: end 改哪看哪 -->

<!-- project-forge: begin 取舍 -->
## 取舍

由维护者手写，脚本不碰。一行一项 `- <键名>：<选择>`（可用键名见体检「待定」项；删去即恢复待定）：

```text
```

<!-- project-forge: end 取舍 -->
