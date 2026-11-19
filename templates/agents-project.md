# {{PROJECT_NAME}} — 项目工程契约（每次会话自动读）

AI 新开会话先读本文件，确认定位、入口、边界、命令与协作流程。**只写现状，不写变更履历；面向人的说明见 `README.md`、`CONTRIBUTING.md`、`{{RELEASING_DOC}}`。** 账号、远端、分支与版本号一律现场读取；**24KB 预警、上限 30KB**，超长细节外置至 `docs/TDD.md`（若存在）或 `<subdir>/AGENTS.md`。

<!-- project-forge: begin 意图路由 -->
## 意图路由（静默触发，不反问）

收到自然语言需求时，**直接静默读取对应 `SKILL.md` 并先执行引擎脚本**，不反问也不要求输入 `/skill`：

| 用户自然语言意图 | 加载本地 Skill | 先跑引擎脚本（按需传参） |
| --- | --- | --- |
{{KIT_ROUTING_ROWS}}
| 首次规范化接管 / 升级工具包 / 交棒退场 | 运行本工具 `survey` / `equip` / `review` / `handoff` | 始终先只读 `survey.mjs`，不直接写业务代码 |
<!-- project-forge: if has-remote -->
| 里程碑管理 / 裸粘贴 Issue・PR・Milestone 链接 | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs inspect <URL...>` / `milestone` |
<!-- project-forge: endif -->
<!-- project-forge: if has-custom-skills -->

### 项目自有技能（自动识别，与上方研发流并存）

以下技能位于仓库自有技能目录，命中时静默读取其 `SKILL.md` 执行；`equip.mjs` 与 `compose-agents.mjs` 完整保留：

{{CUSTOM_SKILLS_BLOCK}}
<!-- project-forge: endif -->
<!-- project-forge: end 意图路由 -->

<!-- project-forge: begin 行事总纲 -->
## 行事总纲与决策准则

- **四条准则**：1. **治本不治标**（查根因，不用补丁遮掩）；2. **写原则不写死**（提炼可迁移原则）；3. **融入结构**（查复用合入主干，不留双轨）；4. **保持清朗**（清废弃路径与冗余分支）。
- **信任倒金字塔**：`确定性静态与类型门禁（类型/Schema/arch-rules） > 真实启动运行与端到端实证（测试/smoke-verify/UI 渲染交互与浅深色截图/CLI 实测） > 静态读代码与独立审查 > 文档约定`；主观未实证挑刺不阻塞合入；同类纠偏复发**满 2 次**沉入结构重构或确定性静态检查并清理死代码。
- **改前改后与人肉禁令**：先给无历史包袱最优解；改前查复用并判 `two-way`/`one-way` 门型；改后拿实测或渲染交互证据再汇报，不让用户代劳验收。
<!-- project-forge: end 行事总纲 -->

<!-- project-forge: begin 项目定位 -->
## 项目定位

<!-- project-forge: fill 项目定位：两三句话说清本项目解决什么问题、面向谁、对外提供什么形态（命令行工具 / 库 / 服务 / 应用 / 插件 / 能力目录），以及明确不做什么 -->
<!-- project-forge: end 项目定位 -->

<!-- project-forge: begin Dev Profile -->
## Dev Profile

以下键值由研发流脚本自动读取，核对后替换为真实值（无对应项填 `none`）：

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

- **按序按需定位**：`AGENTS.md` -> `docs/TDD.md`（若存在）-> 相关 `<subdir>/AGENTS.md` -> 用 `doc-locate.mjs` / `repo-map.mjs` 只读定位切片，再跑 `flow.mjs inspect` 获取任务状态。
- **默认不读**：`docs/archive/`、`node_modules/`、`dist/`、`build/`、`.worktrees/`、锁文件全文与构建缓存（`do-not-edit` 仅禁手工改历史归档，允许 `finalize`/`archive` 合法归档）。
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

本项目尚未在清单声明标准命令。读源码后替换为真实命令（纯文档项目说明无构建步骤并删除代码块）：

<!-- project-forge: fill 构建与验证命令：填这个项目真实的构建、静态检查、测试命令，一条一行 -->
```sh
# 把真实命令写在这里，然后删掉上面那行 fill 标记
```
<!-- project-forge: endif -->

**形式门禁通过且真实运行/E2E 观察达标（改运行态且 `smoke-verify` 非 `none` 须跑通并附 `--e2e-evidence`；UI 须走通交互核浅深色图；异常自动脱敏建单）才算做完**——无实证不得声称「已验证」。
<!-- project-forge: end 构建与验证 -->

<!-- project-forge: begin 修改守则 -->
## 工程修改守则与硬性规范

- **严控范围与依赖**：改前先读邻近实现，清净被替换旧逻辑；不擅自引入第三方依赖，确需引入须先说明理由并获确认。
- **测试正反双向与分层控频**：修缺陷先写复现失败测试（Red-Green）；新判定/解析逻辑必配正反双向用例。编码中跑语法检查与 `--tier quick --target <path>`，合前跑 1 次 `full-test`/`merge-gate`；禁零断言、纯 Mock 自证（>=5 mock 仅查调用次数）、单测 `>=1s` sleep 与弱化门禁；单测超 800 行按模块拆分。
- **禁坏味注释与文档同步**：只写现状——**禁立碑履历**、**死代码注释块**及无故压制（`HACK`/`WORKAROUND`/`TEMP`/`@ts-ignore`/`eslint-disable`/`# type: ignore`/`# noqa`/`#[allow(`）；改导出、CLI、模块边界或契约时同提交同步 `docs/TDD.md`（若存在）、`README.md`、`AGENTS.md`。
- {{COMMIT_STYLE_HINT}}
<!-- project-forge: if has-bilingual-docs -->
- **多语文档成对同步**：本仓库有 {{README_LIST}}，改任一语言版本必须同步另一份并保持双向链接有效。
<!-- project-forge: endif -->
<!-- project-forge: end 修改守则 -->

<!-- project-forge: begin 修改守则补充 -->
## 项目特有红线

<!-- project-forge: fill 项目特有红线：补充本项目特有的硬性规范（如兼容性下限、禁 emoji、性能预算等）；无额外规范可直接删掉本行 -->{{CONVENTIONS_HINT}}
<!-- project-forge: end 修改守则补充 -->

<!-- project-forge: begin 版本与发布 -->
## 版本管理与回滚底线

- **提交纪律**：一次实质变更一个独立提交，说清「改了什么、为什么」，不用内部编号充当说明；高风险改动前留干净存档点；构建产物或锁文件须同提交更新。
<!-- project-forge: if has-remote -->
- **回滚四档**：未提交 -> 丢弃工作区；已提交未推 -> 回退存档点；**已推送远端 -> 一律反向提交，严禁强推或改写已推送历史**；已发布版本 -> 只能发递增新版本（永不复用或删旧版）。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **回滚四档**：未提交 -> 丢弃工作区；分支未并入主干 -> 重置或重起提交；已并入主干 -> 一律反向提交，不随意改写主干记录；已发布版本 -> 只能发递增新版本（永不复用或删旧版）。
<!-- project-forge: endif -->
<!-- project-forge: if has-release -->

### 版本号与发版死锁防护

版本号以 `{{VERSION_SOURCE}}` 为唯一权威来源；**兼容性下限只上移、不下移、默认不动**。**日常与发版是两件事，默认只做前一件**：
<!-- project-forge: if has-remote -->
- **日常（分档看能不能撤回）**：推自己的分支、开 PR、改 PR 撤得回来属日常（不打标签、不建发布页、不发制品库）；合并默认分支、发版、改可见性、改写历史撤不回来，强制推送永不自动执行。
- **发版**：不自己判断该发版，只有人明确说要发版时才按 `{{RELEASING_DOC}}` 先提交推送发布说明（`{{RELEASE_NOTES_TARGET}}`）到 `{{DEFAULT_BRANCH}}`，再打标签并回读确认发布页、附件与制品库均就位。
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
  先核对远端与源仓库：`origin` 与声明源一致且有写权为 **maintainer**（独立分支开 PR，禁直推主干）。多协作者团队遵循：① 零历史新成员先 `flow.mjs inspect --probe-auth` 验写权限；② 开工 `flow.mjs claim` 防撞车，接管未合分支须 `--takeover --reason` 双写 Issue+PR（弃领 `release`）；③ 合前同步并守 `CODEOWNERS`/Merge Queue；④ `reviewerId !== implementerId` 互审（保守仓写 `merge-authority: human`）。Fork 为 **contributor-fork**（只推 `origin` 向 `upstream` 开 PR，禁自合与提前删分支，标签 403 降级）；只读为 **clone-readonly**（三选一）；未注册主机退化 `generic-git`（远端合 MR 后带 `--remote-merged`）；外部/新增 Issue 与 PR 先经 `flow.mjs intake` 业务分诊（已 `approve` 自研豁免）。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
  还没有远端时按 `local-only` 运作，通过本地特性分支与临时 `--detach` 试合推进主干；高风险或 `one-way` 变更仍须独立审查，新增提案可走 `flow.mjs intake` 离线分诊。
<!-- project-forge: endif -->

- **第二步：纯调度分波、五档分流与三正交策略**——主会话薄上下文调度，跑 `flow.mjs next`（就绪 `docs/specs/*.md` 在 `Wave 1 >= 2` 时并行派发）或 `doc-plan.mjs triage`，沿 **8 阶段闭环（需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入）**判档与门型（`two-way`/`one-way`），多轮澄清清零待拍板项：

  | 档位 | 触发特征 | 文档与检查动作 |
  | --- | --- | --- |
  | **Case 1** | 纯问答 / 错别字 / 单行格式 | 0 文档，直接改，跑对应检验（前缀 `docs:`） |
  | **Case 2** | 明确局部缺陷，不改对外契约 | 0 文档，**先写复现失败测试再修（Red-Green，前缀 `fix:`）** |
  | **Case 3** | `L2` 功能调整，不改外部契约 | 在 `{{WORK_DIR}}` 建 Todo 冻结 `C1..Cn`；跑 `doc-plan.mjs audit` 直通 |
  | **Case 4** | `L3` 跨模块/契约变更或高风险 | 先建 `docs/specs/` + `{{WORK_DIR}}` Todo；经 `audit` + 3 轮停损 Critique（禁自审/全历史换人）-> `approve` |
  | **Case 5** | 与 `docs/TDD.md`（若存在）或生效 `SPEC` 冲突 | **阻断并先更新 `docs/TDD.md`**（若存在），内审获批后再继续 |

  风险定级：`low`（纯非可执行文本，无 CI 必过静态门禁）/ `medium` / `high`（高风险/`one-way`/Case>=4 必走独立审查与故障注入）；`evidence.json` 拦截 `quick --target` 顶替全量；Case 2/3/4 在隔离 `impl` 位派 `impl` 子代理。

- **第三步：全量 Worktree 隔离与共享依赖**——`commits === 0` 且非 `--parallel` 可原地特性分支；**所有 `commits > 0` 仓**一律建 `.worktrees/impl-<taskId>/` + `.worktrees/review-<taskId>/`（跨轮复用、自动解绑重挂载依赖）。卸 worktree 前先 `worktree-deps.mjs` 仅对链接 `unlinkSync` 解绑，严禁直接递归删目录。

<!-- project-forge: if has-remote -->
- **第四步：认领与 PR 前文档同步**——**谁改代码谁认领并负责 `finalize`/`verify`/`submit` 及 PR/Issue 评论**（协调者不代提 PR；外部 PR 入 `.worktrees/review-pr-<M>/` 先扫高危）；统一前缀（`docs:`/`fix:`/`feat:`）、四态标签与 Milestone 继承；变基/试合附 `GIT_EDITOR=true`/`--no-edit`。PR 前跑 `flow.mjs finalize`（全勾 `[x]`、成对 `git mv` 归档至 `docs/archive/`，`1:N` 总控 PRD 走四态闭环），`submit` 推后零跟踪文件写回、自动抽取 SPEC/Todo/`evidence.json` 生成干净 PR 正文并双写评论。

- **第五步：独立审查与合并**——**独立审查通过（`fail` 为空）后由审查者直接合**（Round 2+ 换全新独立审查上下文，受同 `HEAD`/增量视野/全历史换人与 3 轮硬停损约束；触碰高风险路径须加故障注入；**仅弱化门禁须人点头**，退出码 4；「取舍」写 `merge-authority: human` 收回人合；`contributor-fork` 禁自合；`generic-git` 须带 `--remote-merged`）。合前强校三方 `headSha`、干净工作区与 E2E 观察；详见各技能 `SKILL.md` 与协作判据。

- **第六步：合并收尾与平台防乱码**——固定 7 步，顺序不能调：
  1. **把要写的东西写完，并纳入这次 PR**：Todo 完成记录与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、随同分支提交；
  2. 合并 PR（不勾选自动删分支）；
  3. 回读确认 `state=MERGED`；
  4. `git switch {{DEFAULT_BRANCH}} && git pull`；
  5. **先卸 worktree**：`git worktree remove <路径>`（先 `worktree-deps` 解绑共享依赖链接）；
  6. 再删本地分支：`git branch -d <分支>`（不是 `-D`）；
  7. **删远端分支前查两件事**：远端还在不在（`git ls-remote --heads origin <分支>`）、有没有下游堆叠 PR 以该分支为 base（Fork 另查上游 PR 非 `OPEN`）；两件都清了才 `git push origin --delete <分支>`。

  **第 5 步前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支及干净状态；**问到人点头才删**（`flow.mjs cleanup --confirm`）。平台命令含非 ASCII 正文一律写系统临时 UTF-8 文件经 `--body-file`/`--notes-file` 提交并删临时文件。

- **日常到此为止**：合并即改动终点，发版必须人明令。
- **同步不变量**：本节与项目协作判据为同一套规则，改动须同提交对齐；指路一律用标题名，不用节号。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **第四步：任务留痕与合并前文档同步**——**谁改代码谁认领并负责 `finalize`/`verify`/`submit`**（记入本地账本），一任务一特性分支；合入前跑 `flow.mjs finalize` 完成勾选与成对归档（`1:N` 总控 PRD 走四态闭环），`submit` 校验干净状态并同步审查槽。

- **第五步：独立审查与本地试合**——**独立审查通过（`fail` 为空）后由审查者直接合入 `{{DEFAULT_BRANCH}}`**（Round 2+ 换全新独立审查上下文，受全历史换人、增量视野与 3 轮硬停损约束；**仅弱化门禁须人点头**；「取舍」写 `merge-authority: human` 收回人合）。本地合入经临时 `--detach` 工作树试合复测后 `--ff-only` 推进主干。

- **第六步：本地合入收尾与 Worktree 清理**——1. 合并前完成 Todo 记录与归档提交；2. 经 `flow.mjs merge` 试合推进 `{{DEFAULT_BRANCH}}`；3. `git switch {{DEFAULT_BRANCH}}` 核对主干；4. 列出 worktree 与本地分支干净状态清单，**问到人点头才删**（`flow.mjs cleanup --confirm`）。

- **日常到此为止**：本地合入 `{{DEFAULT_BRANCH}}` 即改动终点，发版必须人明令。
- **同步不变量**：本节与项目协作判据为同一套规则，改动须同提交对齐；指路一律用标题名，不用节号。
<!-- project-forge: endif -->
<!-- project-forge: end 日常协作与风险分流 -->

<!-- project-forge: begin 高风险路径 -->
## 高风险路径（触碰须独立审查 + 故障注入）

改在这里出错不会当场失败，而是让门禁从此少查一项——坏了看着还是一片绿。

<!-- project-forge: fill 高风险路径：列出本项目中「改错了不可逆、或会让门禁从此静默少查一项」的目录前缀或文件 -->

目录结尾带 `/`，单文件不带；默认至少含 `.github/`、`AGENTS.md` 与 `Dev Profile` 中的 `high-risk` 路径。
<!-- project-forge: end 高风险路径 -->

<!-- project-forge: begin 改哪看哪 -->
## 改哪看哪

| 这次动了 | 必须一起看 |
| --- | --- |
| `<核心模块或公开契约>` | `docs/TDD.md`、`<对应测试与 README>` |
<!-- project-forge: if has-bilingual-docs -->
| `README.md` | {{README_LIST}}（成对同步） |
<!-- project-forge: endif -->

<!-- project-forge: fill 改哪看哪：替换为本项目真实「改动路径与联动文件」映射（至少含反引号相对路径，无则删去示例行） -->
<!-- project-forge: end 改哪看哪 -->

<!-- project-forge: begin 取舍 -->
## 取舍

由维护者手写，脚本不碰。一行一项 `- <键名>：<选择>`（可用键名见体检「待定」项；删去即恢复待定）：

```text
```

<!-- project-forge: end 取舍 -->
