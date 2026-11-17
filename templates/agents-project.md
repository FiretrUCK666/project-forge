# {{PROJECT_NAME}} — 项目工程契约（每次会话自动读）

<!-- project-forge: if is-full -->
AI 新开会话先读本文件，确认定位、入口、边界、命令与协作流程。**只写现状，不写变更履历；人读指南见 `README.md`、`CONTRIBUTING.md`、`{{RELEASING_DOC}}`。**

- **现场取值与严进常删（<= 30KB）**：账号、远端、分支与版本号现场直读清单/Git；契约或命令实质变化时随提交同步本文与 `README.md`。**24KB 预警、禁超 30KB**——源码 10 秒可读细节或过期条目及时清出，子目录特例放 `<subdir>/AGENTS.md`（开头指回根契约，不抄通用规则）。
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
本文件是轻量工程契约（`lightweight` 档，目标 `< 14KB`）：只描述当前机制、命令与红线，不写变更履历；面向人的说明在 `README.md` 与 `{{RELEASING_DOC}}`。
<!-- project-forge: endif -->

<!-- project-forge: begin 意图路由 -->
## 意图路由（静默触发，不反问）

收到用户自然语言需求时，**不要反问「要不要调用某 skill」或要求输入 `/skill`**，直接静默加载对应 `SKILL.md` 并先执行对应引擎脚本：

| 用户自然语言意图 | 加载本地 Skill | 先跑引擎脚本（按需传参） |
| --- | --- | --- |
| 理解项目 / 梳理架构 / 找模块入口 | `.agents/skills/dev-explore/SKILL.md` | `node .agents/skills/dev-explore/scripts/repo-map.mjs` |
| 写需求 / 澄清拍板 / 定方案 / 拆任务 | `.agents/skills/dev-plan/SKILL.md` | `node .agents/skills/dev-plan/scripts/doc-plan.mjs` |
| 做功能 / 修缺陷 / 启动隔离工作位 | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs next` / `inspect` |
<!-- project-forge: if has-remote -->
| 实施者归档 / 实证 / 推分支提 PR | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs finalize` -> `verify` -> `submit` |
<!-- project-forge: if is-full -->
| 本地预审 / 独立双门审查 / 审外部 PR | `.agents/skills/dev-review/SKILL.md` | `node .agents/skills/dev-review/scripts/review-pack.mjs` |
| 审查者合并 PR / 确认后清理 Worktree | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup` |
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
| 门禁放行后合并 PR / 确认后清理 Worktree | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup` |
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
| 归档文档 / 验证并提交至特性分支 | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs finalize` -> `verify` -> `submit` |
<!-- project-forge: if is-full -->
| 本地预审 / 隔离工作树独立双门审查 | `.agents/skills/dev-review/SKILL.md` | `node .agents/skills/dev-review/scripts/review-pack.mjs` |
| 本地试合并入主干与确认后清理 Worktree | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup` |
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
| 门禁放行后本地试合入主干与清理 Worktree | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup` |
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: if is-full -->
| 代码体检 / 清技术债 / retro 复盘下沉 | `.agents/skills/dev-govern/SKILL.md` | `node .agents/skills/dev-govern/scripts/govern-audit.mjs` |
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
| 工程基线检查 / 按需升档完整套件 | 见「环境与构建验证」或升档完整套件 | 运行项目构建/测试命令（用本工具 `equip --tier full` 升档） |
<!-- project-forge: endif -->
| 首次规范化接管 / 升级工具包 / 交棒退场 | 运行本工具 `survey` / `equip` / `review` / `handoff` | 始终先只读 `survey.mjs`，不直接写业务代码 |
<!-- project-forge: if has-custom-skills -->

### 项目自有技能（自动识别，与上方研发流并存）

以下技能位于仓库自有技能目录，命中对应场景时同样静默读取其 `SKILL.md` 并执行；`compose-agents.mjs` 与 `equip.mjs` 会完整保留它们，不与内置研发流冲突：

{{CUSTOM_SKILLS_BLOCK}}
<!-- project-forge: endif -->
<!-- project-forge: end 意图路由 -->

<!-- project-forge: begin 行事总纲 -->
## 行事总纲与决策准则

<!-- project-forge: if is-full -->
- **四条准则**：1. **治本不治标**（查根因，不用补丁遮掩）；2. **写原则不写死**（提炼可迁移原则）；3. **融入结构**（查复用合入主干，不留双轨）；4. **保持清朗**（清废弃路径与冗余分支）。
- **信任倒金字塔**：`确定性静态与类型门禁（类型/Schema/arch-rules） > 真实启动运行与端到端实证（测试/smoke-verify/UI 渲染交互与浅深色截图/CLI 实测） > 静态读代码与独立审查 > 文档约定`；主观未实证挑刺不阻塞合入；同类纠偏复发**满 2 次**沉入确定性静态检查并清理死代码。
- **动手前后与人肉禁令**：先给无历史包袱最优解（兼顾 UX/DX/AX）；改前查复用并判 `two-way`/`one-way` 门型；改后拿实测或渲染交互/浅深色截图证据再汇报，清死代码与借口注释，不让用户代劳验收。
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
- **四条准则**：治本不治标、写原则不写死、先查复用融入主干、及时清理废弃代码。
- **验证优先级**：确定性静态门禁（类型/Schema/`arch-rules`）> 真实启动运行与 UI 渲染截图实证 > 静态读代码 > 文档约定；同类问题复发满 2 次沉入静态规则，不当人肉代理。
- **改前改后**：改前查复用并判 `two-way` / `one-way` 门型；改后拿实测或渲染证据再汇报。
<!-- project-forge: endif -->
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

- **按序读取**：`AGENTS.md` -> `docs/TDD.md`（若存在）-> 相关 `<subdir>/AGENTS.md` -> 用 `repo-map.mjs` 定位源码；修改前先跑 `flow.mjs inspect` 拿当前角色与任务状态。
- **默认不读**：`docs/archive/`、`node_modules/`、`dist/`、`build/`、`.worktrees/`、锁文件全文与构建缓存（仅按需定向查阅；`do-not-edit` 仅禁手工改历史归档，允许 `finalize`/`archive` 合法归档）。
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

<!-- project-forge: fill 模块入口：按「职责 → 入口文件或目录」列出核心模块；如已维护 docs/TDD.md，此处只留总览表并指向 docs/TDD.md -->

### 关键不变量（破坏即事故）

<!-- project-forge: fill 关键不变量：列出「改 A 必须同步看 B」「哪条数据格式 / 接口协议 / 包边界绝不可破」，并注明定义它的权威文件 -->
<!-- project-forge: if is-monorepo -->

## 多包仓库边界（Workspace）

根层负责全局门禁编排，子包（{{WORKSPACE_PACKAGES}}）各自维护入口与依赖声明，**严禁跨子包直接引用未导出的内部私有路径**。子包专属约定放入 `<package>/AGENTS.md`（开头指回根契约，不重复抄通用规则）。
<!-- project-forge: endif -->
<!-- project-forge: if is-plugin-or-skill -->

## 宿主加载与分发边界

- **身份标识零容错**：宿主清单或 `SKILL.md` frontmatter 必填字段必须严格对齐规范，缺失或类型错误会让宿主静默丢弃；宿主侧 ID 与分发包名严格区分，**绝不混改**。
- **产物与分发通道对齐**：宿主直读仓库/制品库编译产物时源码改动须同提交重建；从发布页附件下载时编译产物绝不入库。**严禁用本地挂载（符号链接）代替隔离安装验收**。
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

本项目尚未在清单里声明标准命令。读源码后替换下面内容——**纯文档项目**改为「本项目无构建与测试步骤，交付时只验结构与文档一致性」，并删掉代码块。

<!-- project-forge: fill 构建与验证命令：填这个项目真实的构建、静态检查、测试命令，一条一行 -->
```sh
# 把真实命令写在这里，然后删掉上面那行 fill 标记
```
<!-- project-forge: endif -->

**形式门禁通过且实际启动跑通（UI 须实际渲染、走通交互并核对浅深色截图）才算做完**——拿不出实际运行或渲染证据，不得声称「已验证」。
<!-- project-forge: end 构建与验证 -->

<!-- project-forge: begin 修改守则 -->
## 工程修改守则与硬性规范

<!-- project-forge: if is-full -->
- **严控范围与依赖**：改前先读邻近实现，清净被替换旧逻辑；不擅自引入第三方依赖，确需引入须先说明理由并获确认。
- **测试正反双向与分层控频**：修缺陷先写稳定复现失败测试（Red-Green）；新判定或解析逻辑须覆正反双向用例，禁跳过或凑数。编码中只跑语法/类型检查与 `--tier quick --target <path>`；合前跑 1 次 `full-test`/`merge-gate`；禁零断言、纯 Mock 自证（>=5 mock 仅查调用次数）、单测硬编码 `>=1s` sleep/非无头测试；单测超 800 行按模块拆分。
- **禁坏味注释与文档同步**：只写现状——**禁立碑履历**、**死代码注释块**及无故压制（`HACK`/`WORKAROUND`/`TEMP`/`@ts-ignore`/`eslint-disable`/`# type: ignore`/`# noqa`/`#[allow(`）；改导出、CLI、模块边界或契约时提交前同步 `docs/TDD.md`（若存在）、`README.md`、`AGENTS.md`。
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
- **范围与依赖**：改前读邻近实现、清净旧逻辑；不擅自引入第三方依赖。
- **测试与分层**：修缺陷先写复现失败测试（Red-Green），新判定须有正反双向用例；改完跑 `--tier quick --target <path>`，合前跑 `full-test`/`merge-gate`；禁零断言、纯 Mock 自证、单测 `>=1s` sleep 与弱化门禁。
- **注释与文档同步**：禁立碑履历、死代码注释块及无故 `HACK`/`@ts-ignore`/`eslint-disable`；改导出、CLI 或模块边界时同步更新 `docs/TDD.md`（若存在）、`README.md`、`AGENTS.md`。
<!-- project-forge: endif -->
- {{COMMIT_STYLE_HINT}}
<!-- project-forge: if has-bilingual-docs -->
- **多语文档成对同步**：本仓库有 {{README_LIST}}，改任一语言版本必须同步另一份，并保持双向互指链接有效。
<!-- project-forge: endif -->
<!-- project-forge: end 修改守则 -->

<!-- project-forge: begin 修改守则补充 -->
## 项目特有红线

<!-- project-forge: fill 项目特有红线：补充本项目特有的硬性规范（如兼容性下限、禁 emoji、性能预算等）；无额外规范可直接删掉本行 -->{{CONVENTIONS_HINT}}
<!-- project-forge: end 修改守则补充 -->

<!-- project-forge: begin 版本与发布 -->
## 版本管理与回滚底线

- **提交纪律**：一次实质变更一个独立提交，提交信息说清「改了什么、为什么」，不用内部编号充当说明；大改动或高风险操作前先留干净存档点；有入库构建产物或锁文件须同提交更新。
<!-- project-forge: if has-remote -->
- **回滚四档**：未提交 -> 丢弃工作区；已提交未推 -> 回退存档点；**已推送远端 -> 一律反向提交，严禁强推或改写已推送历史**；已发布版本 -> 只能发递增的新版本（永不复用或删旧版）。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **回滚四档**：未提交 -> 丢弃工作区；分支未并入主干 -> 重置或重起提交；已并入主干 -> 一律反向提交，不随意改写主干记录；已发布版本 -> 只能发递增的新版本（永不复用或删旧版）。
<!-- project-forge: endif -->
<!-- project-forge: if has-release -->

### 版本号与发版死锁防护

版本号以 `{{VERSION_SOURCE}}` 为唯一权威来源；**兼容性下限只上移、不下移、默认不动**（上移须同步修改清单与 `README.md` 环境要求节）。

**日常与发版是两件事，默认只做前一件：**

<!-- project-forge: if is-full -->
<!-- project-forge: if has-remote -->
- **日常**：改完 -> 跑门禁 -> 提交 -> **推自己的分支 -> 开 PR -> 独立审查 -> 合并**。**不打标签、不建发布页、不发制品库。**

  **推到哪一档由「能不能撤回」决定，不由「是不是对外」决定**：推自己的分支、开 PR、改 PR 都能撤回，属于日常；合并默认分支、发布、改可见性、改写历史撤不回来，要先给人看清单。**强制推送与改写已推送历史永不自动执行。**
- **发版**：只有明确说要「发版」时才做，顺序严格按 `{{RELEASING_DOC}}`——先提交并推送发布说明（`{{RELEASE_NOTES_TARGET}}`）到默认分支 `{{DEFAULT_BRANCH}}`，再打标签推送。
- **不自己判断「该发版了」**：攒了几个改动或隔了一阵都不是理由，发版必须人点头。
- **回读才算发完**：标签推上后回读发布页正文、附件与制品库版本均已就位才算完成。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **日常**：改完 -> 跑门禁 -> 提交至本地特性分支 -> 独立审查 -> 本地试合并入 `{{DEFAULT_BRANCH}}`。**不打标签、不建发布页、不发制品库。**
- **发版**：只有明确说要「发版」时才做，按 `{{RELEASING_DOC}}` 准备发布说明（`{{RELEASE_NOTES_TARGET}}`）与递增版本。
- **不自己判断「该发版了」**：攒了几个改动或隔了一阵都不是理由，发版必须人点头。
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
<!-- project-forge: if has-remote -->
- **日常**：按能不能撤回分档——推自己的分支、开 PR 可撤回属日常（不打标签不发制品库）；合并默认分支、发版、改写历史撤不回来。
- **发版**：不自己判断该发版，仅在人明确说要发版时按 `{{RELEASING_DOC}}` 先提交推送说明（`{{RELEASE_NOTES_TARGET}}`）到 `{{DEFAULT_BRANCH}}`，再打标签并回读确认。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **日常**：改完 -> 跑门禁与测试 -> 提交至本地分支 -> 本地试合并入 `{{DEFAULT_BRANCH}}`（高风险变更须人类确认；不打标签不发制品库）。
- **发版**：不自己判断该发版，仅在人明确说要发版时按 `{{RELEASING_DOC}}` 准备说明（`{{RELEASE_NOTES_TARGET}}`）与版本。
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: end 版本与发布 -->

<!-- project-forge: begin 日常协作与风险分流 -->
## 日常协作：改动怎么落地

<!-- project-forge: if is-lightweight -->
- **身份与远端**：
  <!-- project-forge: if has-remote -->
  先核对远端与源仓库：`origin` 与声明源一致且有写权限为 `maintainer`（独立分支开 PR，禁直推主干；未匹配注册平台远端退化为 `generic-git` 走本地流程后带 `--remote-merged` 确认）；Fork 为 `contributor-fork`（只推自己 `origin` 开 PR 并等待上游合并，禁自合与提前删分支）；只读克隆停下三选一（Fork/新建/`.git/pf-local-mode`）；外来 PR 需先升级为 `full` 档再运行扫描。
  <!-- project-forge: endif -->
  <!-- project-forge: if no-remote -->
  项目还没有远端，仅本地提交；碰「高风险路径」、`Case >= 4` 或 `one-way` 变更须人类确认后带 `--human-approved --reason "..."` 放行。
  <!-- project-forge: endif -->
<!-- project-forge: if has-remote -->
- **五档分流与文档归档**：沿 8 阶段闭环（需求→澄清→设计→实现→评审→实证→验收→合入）澄清拍板并跑 `doc-plan.mjs triage`：Case 1/2 0 文档（Case 2 先写复现失败测试）；Case 3 建 Todo；Case 4 建 SPEC+Todo 经独立 Critique（禁自审）后 `approve`；Case 5 先改 `docs/TDD.md`（若存在）。PR 前实施者跑 `flow.mjs finalize`（总控收口加 `--include-master-prd`）成对归档进 `docs/archive/`。
- **分档推送、门禁放行与清理**：能不能撤回决定分档——推自己分支与开 PR 属日常（谁改谁认领并负责 `verify`/`submit`）；普通改动门禁通过即可合（`contributor-fork` 等上游合），触及高风险/`Case >= 4`/门禁弱化须人类确认并带 `--human-approved --reason "..."`（**弱化门禁必须人点头**），**日常到此为止**。Worktree 先 `worktree-deps.mjs` 解绑（`unlinkSync`）再问人清理；非 ASCII 写临时 UTF-8 文件走 `--body-file`；随时 `--tier full` 升档。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **五档分流与文档归档**：沿 8 阶段闭环澄清拍板并跑 `doc-plan.mjs triage`：Case 1/2 0 文档（Case 2 先写复现失败测试）；Case 3 建 Todo；Case 4 建 SPEC+Todo 经独立 Critique（禁自审）后 `approve`；Case 5 先改 `docs/TDD.md`（若存在）。合前实施者跑 `flow.mjs finalize`（总控收口加 `--include-master-prd`）成对归档进 `docs/archive/`。
- **门禁放行、试合与清理**：普通改动门禁通过即可经 `--detach` 试合并入 `{{DEFAULT_BRANCH}}`，触及高风险/`Case >= 4`/门禁弱化须人类确认并带 `--human-approved --reason "..."`（**弱化门禁必须人点头**），**日常到此为止**。Worktree 先 `worktree-deps.mjs` 解绑（`unlinkSync`）再问人清理；随时可 `--tier full` 升档。
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: if is-full -->
- **第一步：双轴五态身份判定（不靠猜）**。

  <!-- project-forge: if has-remote -->
  先核对远端与源仓库：`origin` 与声明源一致且有写权限为 **maintainer**（公开/私有仓均同源独立分支开 PR，禁直推主干）。多协作者团队遵循：① 零历史新成员先跑 `flow.mjs inspect --probe-auth` 验写权限；② 开工 `flow.mjs claim` 防撞车，接管未合分支须 `--takeover --reason` 双写 Issue+PR（弃领 `release`）；③ 独立分支、合前同步并守 `CODEOWNERS`/Merge Queue；④ `reviewerId !== implementerId` 互审或独立上下文审查（保守仓写 `merge-authority: human`）。Fork 为 **contributor-fork**（只推 `origin` 向 `upstream` 开 PR，禁推正本/打标/发版/提前删分支，标签 403 降级）；只读为 **clone-readonly**（停下选 Fork/独立新建/`.git/pf-local-mode`）；未匹配注册主机退化 `generic-git`（需远端合 MR 后带 `--remote-merged`）；外来 PR 为 **inbound-external-pr**（见 `CONTRIBUTING.md`）。
  <!-- project-forge: endif -->
  <!-- project-forge: if no-remote -->
  这个项目还没有远端，只有本地提交并经临时 `--detach` 试合推进主干；碰高风险路径或 `one-way` 变更仍须独立审查。
  <!-- project-forge: endif -->

- **第二步：状态路由、五档分流与三正交策略**——先跑 `flow.mjs next`（或 `doc-plan.mjs triage`），沿 **8 阶段闭环（需求 → 澄清 → 设计 → 实现 → 评审 → 实证测试-形式验证 → 验收 → 合入）**判档位与门型（`two-way` vs `one-way`）：复杂度高时主动建议建总控 PRD，**多轮澄清直至待拍板事项清零再定稿**（`doc-plan` 尊重自有模板并禁自审 `SELF_CRITIQUE_REJECTED`）：

  | 档位 | 触发特征 | 文档与检查动作 |
  | --- | --- | --- |
  | **Case 1** | 纯问答 / 错别字 / 单行格式 | 0 文档，直接改，跑对应检验 |
  | **Case 2** | 明确局部缺陷，不改对外契约 | 0 文档，**先写复现失败测试再修（Red-Green）** |
  | **Case 3** | `L2` 功能调整，不改外部契约 | 在 `{{WORK_DIR}}` 建 Todo 冻结 `C1`..`Cn`；跑 `doc-plan.mjs audit` 直通 |
  | **Case 4** | `L3` 跨模块/契约变更或高风险 | 先建 `docs/specs/` + `{{WORK_DIR}}` Todo；经 `audit` + 独立 Critique -> `critique-pass` 后交人 `approve` |
  | **Case 5** | 与 `docs/TDD.md`（若存在）或生效 `SPEC` 冲突 | **阻断并先更新 `docs/TDD.md`**（若存在），内审获批后再继续 |

  按三正交策略定级：`low`（纯非可执行文本白名单；无 CI 时强制 `verify` 静态必检）/ `medium` / `high`（高风险/`one-way`/Case>=4 必走独立审查与故障注入）；`evidence.json` 拦截 `quick --target` 顶替全量。Case 2/3/4 单任务在隔离 `impl` 位派 `impl` 子代理；账本存于 `.worktrees/.state/tasks/<taskId>.json`。

- **第三步：全量 Worktree 隔离、跨轮复用与共享依赖**——

  | 档位 / 场景 | 隔离策略 | 谁能动 / 怎么用 |
  | --- | --- | --- |
  | 第 1 档：`commits === 0` 且非 `--parallel` | 本地新建特性分支 | 仅 0 提交仓原地开发 |
  | 第 2 档：**所有有提交历史仓（`commits > 0`）**或并行 | `.worktrees/impl-<taskId>/` + `.worktrees/review-<taskId>/`（detached `HEAD`） | 实施者仅改 `impl-*`；跨轮复用并自动解绑重挂载依赖（支持 `--reset-review-slot`）；本地合入经 `.worktrees/.tmp-merge-*` 试合后推进干净主干 |
  <!-- project-forge: if has-remote -->
  | 第 3 档：外来 PR（`inbound-external-pr`） | `.worktrees/review-pr-<M>/`（detached `FETCH_HEAD`） | 先静态扫高危，禁生命周期脚本经人确认后再测 |
  <!-- project-forge: endif -->

  锁一致时用 `worktree-deps.mjs` 挂载（Workspace/editable 指回主仓自动隔离）；**卸 worktree 前先仅对链接 `unlinkSync` 解绑，严禁直接递归删目录**，列清 4 态后问人再删（`.worktrees/` 须忽略）。

<!-- project-forge: if has-remote -->
- **第四步：认领与 PR 前文档同步（有远端时适用）**——

  **谁改代码谁认领并负责 `finalize`/`verify`/`submit` 及 PR/Issue 评论**（协调者只调度不代提 PR；`flow.mjs claim` 认领，弃领 `release`）；**一任务一分支一 PR**（复用已有 OPEN PR，返工原分支追加）。**PR 前跑 `flow.mjs finalize`**：全勾 `[x]`，成对 `git mv` 归档至 `docs/archive/{prd,specs,todo}/`（`1:N` 总控 PRD 默认保留于 `docs/prd/` 维持 `active`，全量收口时带 `--include-master-prd` 一并归档）；`submit` 推后**零跟踪文件写回**、查重 PR 并套用 `.github/pull_request_template.md`。双写：认领/释放->Issue；提 PR->Issue（`Fixes #N`）；退回/通过/返工->PR+Issue；已合并->Issue。无远端只记账本。

- **第五步：独立审查与合并**——

  **独立审查通过后由审查者直接合**（**Round 2+ 永远新建独立 `review` 子代理并在同 `HEAD`/增量视野/历史停损硬锁下复审**）；外部 PR 先过安全扫描；**仅弱化门禁须人点头**（退出码 4）。审查与返工自动沉淀 `signals.jsonl` 供 `govern-audit.mjs retro` 复盘。

  | 改动 | 谁能合 |
  | --- | --- |
  | 普通改动 / 外部 PR，独立审查 `fail` 为空 | **审查者直接合** |
  | 触碰「高风险路径」任一处 | 审查者合（独立上下文 + 故障注入） |
  | **弱化门禁** | **必须人点头** |

  `contributor-fork` 禁自合；`generic-git` 须带 `--remote-merged`；「取舍」写 `merge-authority: human` 收回人合；发版/改可见性/改历史永不自动。六锁收敛见协作判据。

- **第六步：合并收尾与平台防乱码**——固定 7 步，顺序不能调：
  1. **把要写的东西写完，并纳入这次 PR**：Todo「完成后的记录」与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、断点写成「已完成，无遗留」。**提交进同一个分支**——合并后再改文件就得另开 PR；
  2. 合并 PR（**不勾选自动删分支**）；
  3. 回读确认 `state=MERGED`；
  4. `git switch {{DEFAULT_BRANCH}} && git pull`；
  5. **先卸 worktree**：`git worktree remove <路径>`（先用 `worktree-deps` 解绑共享依赖链接再删；分支被 worktree 检出时下一步必败）；
  6. 再删本地分支：`git branch -d <分支>`（不是 `-D`）；
  7. **删远端分支之前查两件事**：远端还在不在（`git ls-remote --heads origin <分支>`）、有没有下游堆叠 PR 以该分支为 base（Fork 另查上游 PR 非 `OPEN`）；**两件都清了才** `git push origin --delete <分支>`。

  **第 1 步应在合并前随同分支提交**，避免主干拒推多出只改记录的 PR。

  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支及干净状态；**问到人点头才删**（`flow.mjs cleanup --confirm`）。

  平台命令含非 ASCII 正文先写系统临时 UTF-8 文件经 `--body-file`/`--notes-file` 提交并回读删临时文件，严禁命令行直接拼接正文。

- **日常到此为止**：合并即改动终点，发版必须人明令（见「版本管理与回滚底线」）。

- **同步不变量**：本节与项目协作判据是**同一套规则**，改任一处必须在同一次提交里对齐另一处；指路一律用标题名，不用节号。
<!-- project-forge: endif -->
<!-- project-forge: if no-remote -->
- **第四步：任务留痕与合并前文档同步**——

  **谁改代码谁认领并负责 `finalize`/`verify`/`submit`**（`flow.mjs claim` / `release` 记入本地账本与事件日志），一任务一特性分支。**合并入主干前先跑 `flow.mjs finalize`**：Todo/SPEC 全勾 `[x]`，成对 `git mv` 归档至 `docs/archive/{prd,specs,todo}/`（`1:N` 总控 PRD 默认保留于 `docs/prd/` 维持 `active`，全量收口带 `--include-master-prd` 一并归档）；`flow.mjs submit` 仅校验本地干净状态并刷新审查槽。

- **第五步：独立审查与本地试合**——

  **独立审查通过后由审查者直接合入 `{{DEFAULT_BRANCH}}`**（**Round 2+ 永远新建独立 `review` 子代理并在同 `HEAD`/增量视野/历史停损硬锁下复审**）；**仅弱化门禁须人点头**（退出码 4）；「取舍」写 `merge-authority: human` 收回人合。本地合入经临时 `--detach` 工作树试合与复测通过后以 `--ff-only` 推进 `{{DEFAULT_BRANCH}}`。审查与返工自动沉淀 `signals.jsonl` 供 `govern-audit.mjs retro` 复盘。

- **第六步：本地合入收尾与 Worktree 清理**——按序执行：
  1. **把要写的东西写完，随本次提交一并合入**：Todo「完成后的记录」与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、断点写成「已完成，无遗留」；
  2. 经 `flow.mjs merge`（或 `flow.mjs batch merge-queue`）试合通过并推进 `{{DEFAULT_BRANCH}}`；
  3. `git switch {{DEFAULT_BRANCH}}` 确认主干提交完整；
  4. **清理前先列清单问一次**：哪个 worktree、哪条本地分支及干净状态；**问到人点头才删**（`flow.mjs cleanup --confirm`：先 `worktree-deps` `unlinkSync` 解绑，再 `git worktree remove` 与 `git branch -d <分支>`）。

- **日常到此为止**：本地合入 `{{DEFAULT_BRANCH}}` 即改动终点，发版必须人明令（见「版本管理与回滚底线」）。

- **同步不变量**：本节与项目协作判据是**同一套规则**，改任一处必须在同一次提交里对齐另一处；指路一律用标题名，不用节号。
<!-- project-forge: endif -->
<!-- project-forge: endif -->
<!-- project-forge: end 日常协作与风险分流 -->

<!-- project-forge: begin 高风险路径 -->
<!-- project-forge: if is-full -->
## 高风险路径（触碰须独立审查 + 故障注入）
<!-- project-forge: endif -->
<!-- project-forge: if is-lightweight -->
## 高风险路径（触碰须人类确认）
<!-- project-forge: endif -->

改在这里出错不会当场失败，而是让门禁从此少查一项——坏了看着还是一片绿。

<!-- project-forge: fill 高风险路径：列出本项目中「改错了不可逆、或会让门禁从此静默少查一项」的目录前缀或文件 -->

写目录时结尾带 `/`，写单个文件时不要带。默认至少包含 `.github/`、`AGENTS.md` 与 `Dev Profile` 中的 `high-risk` 路径。
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

这一节由维护者手写，脚本不碰。**只有使用者能定的那几件事**记在这里，交付体检会把记下的项当作已表态。

写法：一行一项 `- <键名>：<你的选择>`。可用的键名会在交付体检的「待定」项里逐条给出；删掉某一项就等于重新待定。

```text
```

<!-- project-forge: end 取舍 -->
