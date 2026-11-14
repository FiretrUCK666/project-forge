# project-forge — 项目工程契约（每次会话自动读）

本文件面向 AI 会话，写机制、边界与判据；面向人的命令见 `README.md`、`CONTRIBUTING.md`、`RELEASING.md`。**只写当前现状，不写变更履历；取值一律现场读清单与 Git 配置；架构/命令变更须随同提交并对齐 `README.md`。**


<!-- project-forge: begin 意图路由 -->
## 意图路由（静默触发，不反问）

收到用户自然语言需求时，**不要反问「要不要调用某 skill」或要求输入 `/skill`**，直接静默加载对应 `SKILL.md` 并先执行对应引擎脚本：

| 用户自然语言意图 | 加载本地 Skill | 先跑引擎脚本（按需传参） |
| --- | --- | --- |
| 理解项目 / 梳理架构 / 找模块入口 | `.agents/skills/dev-explore/SKILL.md` | `node .agents/skills/dev-explore/scripts/repo-map.mjs` |
| 写需求 / 定方案 / 拆任务 / 查文档全景 | `.agents/skills/dev-plan/SKILL.md` | `node .agents/skills/dev-plan/scripts/doc-plan.mjs` |
| 做功能 / 修缺陷 / 接 Issue / 改 PR | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs inspect` |
| 提交 / 推分支 / 开或更新 PR | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs finalize` -> `verify` -> `submit` |
| 本地预审 / 独立审查 / 审外部 PR | `.agents/skills/dev-review/SKILL.md` | `node .agents/skills/dev-review/scripts/review-pack.mjs` |
| 合并 PR / 清理本地分支与 Worktree | `.agents/skills/dev-flow/SKILL.md` | `node .agents/skills/dev-flow/scripts/flow.mjs merge` / `cleanup` |
| 代码体检 / 清技术债 / 对齐契约与文档 | `.agents/skills/dev-govern/SKILL.md` | `node .agents/skills/dev-govern/scripts/govern-audit.mjs` |
| 首次规范化接管 / 升级工具包 / 交棒退场 | 运行本工具 `survey` / `equip` / `review` / `handoff` | 始终先只读 `survey.mjs`，不直接写业务代码 |
<!-- project-forge: end 意图路由 -->

<!-- project-forge: begin 行事总纲 -->
## 行事总纲与决策准则

- **四条准则**：
  1. **治本不治标**：先查根因再改，不用补丁或盲目重试遮掩问题；
  2. **写原则不写死**：提炼可迁移原则，禁把偶然个案过度泛化；
  3. **融入结构**：先查复用与现成基建，合入既有主干，不留双轨；
  4. **保持清朗**：及时清理废弃路径与冗余分支，控制认知复杂度。
- **信任倒金字塔与验证优先级**：
  - **形式与实证优先于读代码**：`确定性静态与类型门禁（类型 / Schema / arch-rules） > 真实启动运行与端到端实证（测试 / smoke-verify / UI 视觉交互与浅深色截图 / CLI 实测） > 静态读代码与独立审查 > 文档约定`；主观未实证的读代码挑刺不得阻塞合入；
  - 同类审查漏出或运行时复发**满 2 次**沉入确定性形式检查，报错直指根因并清理过期冗余代码。
- **最优解与取舍**：先给无历史包袱的最干净解法再拆步骤；兼顾用户易用（UX）、维护顺手（DX）与 AI 可控（AX）。
- **动手前后**：改前查复用并判 `two-way`/`one-way` 门型；改后拿实测或渲染截图证据、清死代码与借口注释。
- **不当人肉代理**：CLI、接口与 UI 改动必须本地运行实测、走通渲染交互并核对浅深色截图，不让用户代劳验收。
<!-- project-forge: end 行事总纲 -->
<!-- project-forge: begin 项目定位 -->
## 项目定位

一个通用的「项目锻造」skill：给任意项目目录，只读勘察现状、按事实判断该做哪几件事，
把版本管理、GitHub 远端、文档套装、发布通道配到位，并给出配好之后每天怎么干活的协作协议。
**它只做治理，不生成业务代码，也不替项目选型。**

仓库是这套规范的**第一个用户**：`references/` 里写的做法，这里必须自己做到；
做不到时**先改自己，再改规范**。
<!-- project-forge: end 项目定位 -->


<!-- project-forge: begin Dev Profile -->
## Dev Profile

以下键值由研发流脚本自动读取，核对后替换为真实值（无对应项填 `none`）：

```yaml
quick-test: node scripts/dev/preflight.mjs
full-test: node scripts/dev/fixtures.mjs
smoke-verify: node scripts/dev/preflight.mjs
merge-gate: node scripts/dev/preflight.mjs && node scripts/dev/gap-coverage.mjs && node scripts/dev/fixtures.mjs && node scripts/compose-agents.mjs . --check && node scripts/equip.mjs . --check && node scripts/review.mjs . && node scripts/sync-toc.mjs README.md README.en.md --check && node scripts/dev/verify-injections.mjs
arch-rules: kit/** -> scripts/dev/**, scripts/*.mjs -> scripts/dev/**, scripts/lib/** -> scripts/dev/**
high-risk: scripts/lib/, scripts/dev/preflight.mjs, templates/, kit/, SKILL.md, AGENTS.md, .github/workflows/, .gitattributes
do-not-edit: docs/archive/, docs/release-notes/
```
<!-- project-forge: end Dev Profile -->

<!-- project-forge: begin 上下文阅读护栏 -->
## 上下文阅读护栏

- **按序读取**：`AGENTS.md` -> `docs/TDD.md`（若存在）-> 相关 `<subdir>/AGENTS.md` -> 用 `repo-map.mjs` 定位源码；修改前先跑 `flow.mjs inspect` 拿当前角色与任务状态。
- **默认不读**：`docs/archive/`、`node_modules/`、`dist/`、`build/`、`.worktrees/`、锁文件全文与构建缓存（仅按需定向查阅；`do-not-edit` 仅禁手工改历史归档，允许 `finalize`/`archive` 合法归档）。
<!-- project-forge: end 上下文阅读护栏 -->
<!-- project-forge: begin 架构与关键不变量 -->
## 架构与关键不变量

### 模块与入口

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 入口 | `SKILL.md` | 调度与红线：四步、门控表、能力矩阵（**不写判据**） |
| 决策 | `references/` | 每份回答一类问题；动手前读完全文 |
| 落盘骨架 | `templates/` | 被治理项目母版；生成时求值条件块与占位符 |
| 内置技能 | `kit/skills/` -> `.agents/skills/` | 五套自包含研发 Skill 单源；经 `equip.mjs` 生成与 `.pf-manifest.json` 校验 |
| 引擎 | `scripts/` | `survey`、`equip`、`backup`、`compose-agents`、`review`、`handoff`、`sync-toc`、`update` |

`scripts/lib/` 收敛标记与预算（`protocol.mjs`）、模板求值（`template.mjs`）、报告排版（`render.mjs`）、契约回查（`claims.mjs`）与平台探针（`platform/`）。完整架构与双层平面细节见 `docs/TDD.md`；`scripts/dev/` 与 `.agents/` 仅自用不进用户包。

### 关键不变量（破坏即事故）

1. **零第三方依赖**：`scripts/` 与 `kit/` 仅用 Node 18+ `node:*` 内置模块（`preflight` 扫描）。
2. **入口不复述判据**：`SKILL.md` 只指「何时读哪份」，判据细节归 `references/`。
3. **不写死取值**：账号、路径、版本号、仓库地址、默认分支一律现场读取。
4. **单一真相源**：标记与预算只在 `protocol.mjs`、模板求值只在 `template.mjs`、报告排版只在 `render.mjs`。
5. **幂等与只读先行**：勘察前零写入；重复运行字节一致，`equip`/`compose-agents` 写前经 `backup.mjs` 打仓外 `.tar.gz` 快照。
6. **预算与零残留**：入口/参考预算常量只在 `protocol.mjs` 定义；渲染产物严禁残留 `{{VAR}}` 或 `if/endif`。

## 宿主加载与分发边界

- **身份标识零容错**：宿主清单或 `SKILL.md` frontmatter 必填字段必须严格对齐规范，缺失或类型错误会让宿主静默丢弃；宿主侧 ID 与分发包名严格区分，**绝不混改**。
- **产物与分发通道对齐**：宿主直读仓库/制品库编译产物时源码改动须同提交重建；从发布页附件下载时编译产物绝不入库。**严禁用本地挂载（符号链接）代替隔离安装验收**。
<!-- project-forge: end 架构与关键不变量 -->

<!-- project-forge: begin 构建与验证 -->
## 环境与构建验证（改完必跑，全绿才算完成）

- **运行环境**：Node 18+，无构建步骤与外部依赖。

```sh
node scripts/dev/preflight.mjs # 结构 + 引用 + 模板 + 自举 + 端到端冒烟
node scripts/dev/gap-coverage.mjs # survey 缺口与 review 结论配对检查
node scripts/dev/fixtures.mjs # 正反双向行为断言
node scripts/compose-agents.mjs . --check # 本仓契约校验（<= 30KB，建议 < 24KB）
node scripts/equip.mjs . --check # kit/skills 与 .agents/skills 字节级一致
node scripts/review.mjs . # 交付体检，预期 0 个「缺」
node scripts/sync-toc.mjs README.md README.en.md --check # 双语 README 目录同步
node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .
```

导出包与注入验证（用完删临时文件）：

```sh
git archive --format=tar -o "$TMPDIR/pf-pkg.tar" HEAD && tar -tf "$TMPDIR/pf-pkg.tar" > package-list.txt && node scripts/dev/preflight.mjs --package package-list.txt
node scripts/dev/verify-injections.mjs
```

**跑出来的才算做完**——未拿到实际通过输出，不得声称「已验证」。
<!-- project-forge: end 构建与验证 -->

<!-- project-forge: begin 修改守则 -->
## 工程修改守则与硬性规范

- **严控范围与依赖**：改动前先读邻近实现，被替换的旧逻辑一并清净；不擅自引入第三方依赖，确需引入须先说明理由并取得确认。
- **测试正反双向**：修缺陷先写稳定复现失败测试（Red-Green）；新增判定或解析逻辑须同时覆盖正面用例与易误判反面用例，禁止跳过或虚高凑数测试。
- **测试分层与控频**：
  - 编码中只跑语法/类型检查，禁频繁跑全量或 E2E；每轮改完按 `--tier quick --target <path>` 跑对应单测；合入前集中跑 1 次 `full-test` 与 `merge-gate`。
  - 禁写零断言、纯 Mock 自证（>=5 mock 仅查调用次数）、单测内硬编码 `>=1s` sleep / 浏览器容器或非无头测试；单测文件超 800 行应按模块拆分。
- **禁坏味与履历注释**：只描述当前状态——**禁立碑履历注释**、**禁死代码注释块**（废弃代码直接删）及无故压制检查（`HACK`/`WORKAROUND`/`TEMP` 或 `@ts-ignore`/`eslint-disable`/`# type: ignore`/`# noqa`/`#[allow(`）。
- **文档同步**：改动对外导出、CLI、模块边界或核心契约时，**必须在提交前同步更新 `docs/TDD.md` / `README.md` / `AGENTS.md`**。
- 本项目历史提交是平铺的一句说明——沿用它，不要混用第二套格式，不用内部编号充当说明
- **多语文档成对同步**：本仓库有 `README.en.md`、`README.md`，改任一语言版本必须同步另一份，并保持双向互指链接有效。
<!-- project-forge: end 修改守则 -->


<!-- project-forge: begin 修改守则补充 -->
## 项目特有红线

- **禁 emoji**：代码、注释、文档、提交信息一律禁止（`preflight` 扫描）。
- **不绑定具体 AI 宿主**：产品层不得出现特定宿主名称、环境变量或私有路径；兼容性由 `SKILL.md` 标准 frontmatter 保证。
- **双向证伪 fixture 铁律**：勘察或门禁判定变更必须在 `scripts/dev/fixtures.mjs` 同补正面用例与易误判反面用例。
<!-- project-forge: end 修改守则补充 -->
<!-- project-forge: begin 版本与发布 -->
## 版本管理与回滚底线

- **提交纪律**：一次实质变更一个独立提交，提交信息说清「改了什么、为什么」，不用内部编号充当说明；大改动或高风险操作前先留干净存档点；有入库构建产物或锁文件须同提交更新。
- **回滚四档**：未提交 -> 丢弃工作区；已提交未推 -> 回退存档点；**已推送远端 -> 一律反向提交，严禁强推或改写已推送历史**；已发布版本 -> 只能发递增的新版本（永不复用或删旧版）。

### 版本号与发版死锁防护

版本号以 `SKILL.md` 为唯一权威来源；**兼容性下限只上移、不下移、默认不动**（上移须同步修改清单与 `README.md` 环境要求节）。

**日常与发版是两件事，默认只做前一件：**

- **日常**：改完 -> 跑门禁 -> 提交 -> **推自己的分支 -> 开 PR -> 独立审查 -> 合并**。**不打标签、不建发布页、不发制品库。**

  **推到哪一档由「能不能撤回」决定，不由「是不是对外」决定**：推自己的分支、开 PR、改 PR 都能撤回，属于日常；合并默认分支、发布、改可见性、改写历史撤不回来，要先给人看清单。**强制推送与改写已推送历史永不自动执行。**
- **发版**：只有明确说要「发版」时才做，顺序严格按 `RELEASING.md`——先提交并推送发布说明（`docs/release-notes/<标签>.md`）到默认分支 `main`，再打标签推送。
- **不自己判断「该发版了」**：攒了几个改动或隔了一阵都不是理由，发版必须人点头。
- **回读才算发完**：标签推上后回读发布页正文、附件与制品库版本均已就位才算完成。
<!-- project-forge: end 版本与发布 -->

<!-- project-forge: begin 日常协作与风险分流 -->
## 日常协作：改动怎么落地

- **第一步：双轴五态身份判定（不靠猜）**。

  先核对远端与源仓库：`origin` 与声明源仓库一致且本机有写权限时为 **maintainer**（含单人所有者与同源团队/组织多位写权限协作者；公开/私有仓均直接同源独立分支开 PR，非 Fork，严禁直推主干）。团队协同遵循：① 零提交历史新成员先跑 `--probe-auth`（或 `flow.mjs inspect --probe-auth`）验写权限；② 开工 `flow.mjs claim` 标明认领人（自动查防撞车），接手未合分支须带 `--takeover --reason` 在 Issue 与 PR 双写接管（弃领用 `flow.mjs release`）；③ 每人独立分支，PR 前同步默认分支并遵守 `CODEOWNERS` 与 Merge Queue（若有）；④ 坚持 `reviewerId !== implementerId` 互审或独立上下文审查（保守仓写 `merge-authority: human`）。存在不同 `upstream` 或 Fork 时为 **contributor-fork**（**只推自己的 `origin` fork**、向 `upstream` 开 PR，严禁推正本、打标签、发版或提前删 Fork 分支；标签 403 自动降级）；克隆他人正本且无写权限时为 **clone-readonly**（先停下由人选 Fork / 独立新建 / `.git/pf-local-mode` 纯本地）；非注册平台远端退化为 `generic-git` 放行本地全流程；信息不足按 **undetermined** 保守处理；审外来 PR 为 **inbound-external-pr**（详见 `CONTRIBUTING.md`）。

- **第二步：五档开工分流（Case 1..5）、门型与分级内审**——动手前先跑 `doc-plan.mjs triage`（或 `flow.mjs inspect`），判定档位与门型（`two-way` 可局部回退 vs `one-way` 不可逆契约/数据/发布改动）：

  | 档位 | 触发特征 | 文档与检查动作 |
  | --- | --- | --- |
  | **Case 1** | 纯问答 / 错别字 / 单行格式 | 0 文档，直接改，跑相关校验 |
  | **Case 2** | 明确局部缺陷，不改对外契约 | 0 文档，**先写稳定复现失败测试再修（Red-Green）** |
  | **Case 3** | `L2` 功能或局部调整，不改外部契约 | 在 `docs/todo/` 建 Todo，冻结 `C1`、`C2`…；跑 `doc-plan.mjs audit` 自修直通 |
  | **Case 4** | `L3` 跨模块重构、接口/契约变更或高风险 | 先建 `docs/specs/` + `docs/todo/` Todo；经 `audit` + 1–2 轮独立 Plan Critique -> `critique-pass` 后交人 `approve` |
  | **Case 5** | 与 `docs/TDD.md` 或生效 `SPEC` 冲突 | **阻断并先更新 `docs/TDD.md`**，同级内审并经人拍板后再继续 |

  外加一条硬规则：**触碰下方「高风险路径」或 `one-way` 变更 -> 必须有独立审查**。任务账本存于 `.worktrees/.state/tasks/<taskId>.json`；结论写进首次回复、Issue 评论或 PR「实现依据」栏。

- **第三步：三档隔离与 Worktree 共享依赖**——

  | 档位 / 场景 | 隔离策略 | 谁能动 / 怎么用 |
  | --- | --- | --- |
  | 第 1 档：`L1` 且主仓工作区干净 | 本地新建特性分支 | 就地开发，不建多余 worktree |
  | 第 2 档：`L2`/`L3`、接 Issue、脏主仓或并行 | `.worktrees/impl-<taskId>/`（新分支）+ `.worktrees/review-<taskId>/`（detached `HEAD`） | 实施者仅改 `impl-*`；独立审查者在 `review-*` 做故障注入，用完即弃 |
  | 第 3 档：外来 PR（`inbound-external-pr`） | `.worktrees/review-pr-<M>/`（detached `FETCH_HEAD`） | 先静态扫高危变更，禁用生命周期脚本经人确认后再跑门禁 |

  按子包锁文件一致时用 `worktree-deps.mjs` 挂载共享依赖（Windows Junction / POSIX Symlink；Workspace/editable 指向主仓时自动隔离）；**清理 worktree 前必须先仅对链接执行 `unlinkSync` 解绑，严禁直接递归删目录**（先辨识 `merged`/`squash_or_rebase_merged`/`no_own_commits`/`unmerged` 四态并问人确认）。`.worktrees/` 必须已忽略；卸前先问人。

- **第四步：认领与 PR 前文档同步（有远端时适用）**——

  **谁改，谁先认领**（`flow.mjs claim`，`start --create-issue` 可建单联动命名，弃领用 `release`）。**一次改动 = 一个分支 = 一个 PR**（已有对应 Issue + OPEN PR 时直接复用，不开第二条）；返工在原分支追加提交、更新同一个 PR，不重排无关文件。**PR 提交前必须跑 `flow.mjs finalize`**：核对 Todo 全勾 `[x]`，将关联 `PRD`（`done`）、`SPEC`（`implemented` 补实现说明）与 `Todo` 成对 `git mv` 归档至 `docs/archive/{prd,specs,todo}/` 并同步互链（`do-not-edit` 允许工具合法归档），确认代码-文档对齐。

  | 节点 | 留在哪 | 说什么 |
  | --- | --- | --- |
  | 认领 / 释放 | Issue | 谁认领或释放、用哪条分支（`pf-state` 标记） |
  | 已提 PR | Issue | PR 链接，以及 `Fixes #N` / `refs #N` |
  | 审查退回 | PR **和** Issue | `record` 自动双写四字段与 `changes-requested` 标签 |
  | 审查通过 | PR **和** Issue | `record` 自动双写四字段与 `reviewed` 标签（离线不阻塞） |
  | 返工已提交 | PR **和** Issue | 新 HEAD 短哈希、门禁已重跑、请重新审核 |
  | 已合并 | Issue | 合并到哪、关掉了哪几个 Issue |

  没有远端时跳过平台动作，在任务账本记录执行者与结论。

- **第五步：独立审查与合并**——

  **独立审查通过之后，由那个审查者直接合。** 外部 PR 同理，安全防线在审查前（只读扫描与禁用生命周期脚本）。**唯一必须人点头的一类：弱化门禁**（删测试、放宽断言、加跳过标记、改警告、改松 CI）。

  | 改动 | 谁能合 |
  | --- | --- |
  | 普通改动 / 外部 PR，独立审查 `fail` 为空 | **审查者直接合** |
  | 触碰下方「高风险路径」任一处 | 审查者合，但审查必须是独立上下文 + 故障注入 |
  | **弱化门禁** | **必须人点头** |

  `contributor-fork` 严禁自合正本 PR，提交后等待上游维护者处理。在「## 取舍」写 `merge-authority: human` 时收回人工确认；发版、改可见性、改写历史永不自动。审查只判冻结标准 `C*`（`fail:`/`pass:` + 故障注入记录），六锁收敛与停损熔断规则只在协作判据写一份，不在本节复抄。

- **第六步：合并收尾与平台交互防乱码**——固定 7 步，顺序不能调：
  1. **把要写的东西写完，并纳入这次 PR**：Todo「完成后的记录」与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、断点写成「已完成，无遗留」。**提交进同一个分支**——合并后再改文件就得另开 PR；
  2. 合并 PR（**不勾选自动删分支**）；
  3. 回读确认 `state=MERGED`；
  4. `git switch main && git pull`；
  5. **先卸 worktree**：`git worktree remove <路径>`（先用 `worktree-deps` 解绑共享依赖链接再删；分支被 worktree 检出时下一步必败）；
  6. 再删本地分支：`git branch -d <分支>`（不是 `-D`）；
  7. **删远端分支之前查两件事**：远端还在不在（`git ls-remote --heads origin <分支>`）、有没有下游堆叠 PR 以该分支为 base（Fork 场景另查上游 PR 非 `OPEN`）；**两件都清了才** `git push origin --delete <分支>`。

  **第 1 步为什么在合并之前**：文档与任务单是库内文件，合并后主干拒推会迫使每件事多出一个只改记录的 PR。

  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支，以及「干净的」是哪几项。**问到人点头才删**（对应 `flow.mjs cleanup --confirm`）；没问到人只汇报，不自己动手。

  通过平台命令创建或更新 Issue、PR、Release、评论时，**含中文或非 ASCII 的正文一律先写入系统临时目录的 UTF-8 文件，用 `--body-file` / `--notes-file` 提交**并回读删临时文件；**严禁命令行直接拼接正文字符串**。

- **日常到此为止**：合并就是一次改动的终点。**发版是另一件事**，要人明确说才做——见上面「版本管理与回滚底线」。

- **同步不变量**：本节与项目协作判据是**同一套规则**，改任一处必须在同一次提交里对齐另一处；指路一律用标题名，不用节号。
<!-- project-forge: end 日常协作与风险分流 -->

<!-- project-forge: begin 高风险路径 -->
## 高风险路径（触碰须独立审查 + 故障注入）

改在这里出错不会当场失败，而是让门禁从此少查一项——坏了看着还是一片绿。

| 路径 | 为什么 |
| --- | --- |
| `scripts/lib/` | 标记语法、条件求值、报告排版的单一真相源；错一处，四条路径同时静默失效 |
| `scripts/dev/preflight.mjs` | 门禁本身。它被改松时没有任何东西会报错，包括它自己 |
| `templates/` | 写进别人项目里的骨架；条件写错一整块会静默消失 |
| `kit/` | 随包分发且同步进 `.agents/skills/` 的五套研发 Skill；改后须重跑 `equip.mjs .` |
| `SKILL.md` | 入口。删掉一条门控，等于让后面每一步都失去前置检查 |
| `AGENTS.md` | 本文件。它是受管区间的容器，改坏了刷新就再也对不上 |
| `.github/workflows/` | 发布链路的门；门被改松，下一次发版就没人拦 |
| `.gitattributes` | 它决定用户包里有什么；与 `protocol.mjs` 的 `REPO_ONLY_*` 必须一致 |
<!-- project-forge: end 高风险路径 -->

## 外部易变事实保鲜

- 稳定决策链直写 `references/`，易变平台事实（上限、权限、版本号）只写查法与官方文档节位。
- 各篇末尾均含 `## 事实来源`：落盘/发版前及遇「字段非法」「无权」时回查重核，平时不追新制造无效提交。

<!-- project-forge: begin 改哪看哪 -->
## 改哪看哪

| 这次动了 | 必须一起看 |
| --- | --- |
| `scripts/lib/protocol.mjs` | `scripts/lib/template.mjs`、`scripts/compose-agents.mjs`、`scripts/handoff.mjs`、`scripts/review.mjs`、`references/handoff.md` |
| `scripts/lib/template.mjs` | `templates/agents-project.md` 条件块、`scripts/dev/preflight.mjs` |
| `references/collaboration.md` | `templates/agents-project.md`、`AGENTS.md` |
| `references/` 任一判据 | `SKILL.md` 指向行、`scripts/review.mjs` `ref` 指路 |
| `templates/agents-project.md` | `AGENTS.md`（跑 `node scripts/compose-agents.mjs .`） |
| `templates/` 骨架 | 本仓实例（`AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、`.github/`） |
| `kit/skills/` | `.agents/skills/`（跑 `node scripts/equip.mjs .`）、`scripts/equip.mjs` |
| `scripts/` 任一脚本 | `SKILL.md`「核心脚本」、`scripts/dev/fixtures.mjs` 正反用例 |
| `README.md` | `README.en.md`（成对同步并跑 `node scripts/sync-toc.mjs`） |
| 发布链路 | `RELEASING.md`、`docs/release-notes/`、`.github/workflows/release.yml` |
<!-- project-forge: end 改哪看哪 -->

## 取舍

由维护者手写，脚本不碰：

```text
- `license`：MIT。希望被广泛拿来用的工具，宽松授权最省事
- `no-ci`：不适用，本仓配了 check 与 release 两条流水线
- `no-collab-templates`：不适用，本仓收外部贡献，模板齐全
- `private`：不适用，本仓是公开仓库
```

可用键名见体检「待定」项；删项即重新待定。
