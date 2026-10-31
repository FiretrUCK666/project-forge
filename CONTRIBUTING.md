# 贡献指南

欢迎提问题、报缺陷、提改动。这是一个通用工具，它的价值取决于它能不能在**别人的**
项目上正确工作——所以来自不同技术栈的反馈尤其有用。

## 提问与反馈

到 [Issues](https://github.com/FiretrUCK666/project-forge/issues) 提出。请先搜索已有的
Issue，避免重复。

**报缺陷用仓库里的[缺陷报告模板](.github/ISSUE_TEMPLATE/bug_report.md)**：它逐项问期望
发生什么、实际发生什么、怎么复现、在什么环境上——一个能被定位的报告就是这四件事。
**要求只写在模板里**，本文不再另抄一份：两份清单各自维护，改一边就会漂移。

如果问题只在特定条件下出现，把那个条件写出来——它往往就是根因所在。

## 提出改动

1. 开一个 Issue 说明你想改什么、为什么。涉及行为变化或新增文件的，先在 Issue 里
   讨论清楚再动手。**只改文字（错别字、文档表述）不必开 Issue**，直接走第 2 条的第三
   条路径即可。
2. 在分支上改，然后开拉取请求：
   - **没有本仓库写权限**（大多数情况）：先 **fork** 到你自己的账号，克隆 fork 出来的
     那份，在分支上开发，推回你自己的 fork，再从那个分支开拉取请求；
   - **有写权限**（协作者）：直接从主干拉一个分支即可；
   - **只改文字**（错别字、文档表述）：在网页上点开文件、点铅笔图标改完提交即可，
     GitHub 会替你建好分支与拉取请求——这条路跑不了下面的提交前门禁，别用它改脚本。
3. 跑完提交前门禁（见下），全绿再提交。
4. 提交拉取请求，说明改了什么、为什么、怎么验证的。

第一次提拉取请求、或不确定 fork 怎么用，看 GitHub 官方的[参与项目](https://docs.github.com/zh/get-started/exploring-projects-on-github/contributing-to-a-project)
（复刻到拉取请求的完整步骤）。fork 落后于正本时，在自己 fork 的页面上点 **Sync fork**
更新即可。

**不要往本仓库推主干，也不要打版本标签或发布**——那些由维护者执行。没有写权限时你
本来也推不动主干，但请注意别把改动提在自己的 fork 主干上就算了事：那样维护者看不到，
**必须开拉取请求**才会被处理。

## 开发环境

这个项目**零依赖**，克隆下来就能改。需要 **Node.js 16 或更高**——脚本只用 Node 内置
模块，没有第三方依赖，也不需要 Python 或任何其他运行时。

一个例外：发布相关的两个脚本（`release-notes.mjs`、`check-badges.mjs`）用的是 Node 18
才有的全局 `fetch`，跑它们要 Node 18 或更高。它们只在发版与核对徽章时用到。

```sh
# 没有写权限（fork 者）：克隆自己账号下的那份
git clone https://github.com/<你的用户名>/project-forge.git
# 有写权限（协作者）：直接克隆正本
git clone https://github.com/FiretrUCK666/project-forge.git
cd project-forge
```

`git` 只改文档时可以不用：没有它时依赖它的那几组自检会**自动跳过并说明**，不会报成
失败。但**要让门禁全绿就必须有 `git`**——上面第五条与 CI 都用 `git archive` 核对产出物，
没装 `git` 这一关跑不了。

克隆下来后**不要把目录改名**：`SKILL.md` 里的 `name` 必须与目录名一致（目录名就是它对
外的身份），改了 `preflight.mjs` 会直接报错。要换位置可以，但保持目录名仍是
`project-forge`。

## 提交前门禁

改完必须全绿。**第一、二条各要跑几分钟，中途没有任何输出**——`preflight.mjs` 里那条
行为自检实测约 4 分钟，两条合起来一刻钟上下。终端上几分钟没动静不是卡死，别 CTRL+C。

```sh
node scripts/dev/preflight.mjs
node scripts/dev/selftest.mjs
node scripts/compose-agents.mjs . --check
node scripts/sync-toc.mjs README.md README.en.md --check
git archive --format=tar HEAD | tar -t > package-list.txt && node scripts/dev/preflight.mjs --package package-list.txt --at HEAD
```

前四条是本地日常，第五条核对**真跑出来的那份用户包**：`git archive` 导出这个版本实际会
分发出去的文件，再与 `SKILL.md` 的文件地图双向对齐。CI 里跑的也是这五条，所以本地全绿
等于 CI 全绿。跑完的 `package-list.txt` 是个中间产物，已被 `.gitignore` 忽略。

第一条是结构自检（引用完整性、内核一致性、硬性规范）；第二条是**行为自检**——它造
临时 fixture 实跑，断言每条判定的结果；第三条校验三件事：`AGENTS.md` 里的通用内核与
`templates/agents-kernel.md` 逐字一致、内核标记恰好一对、**脚本生成的文件不缺节**
（作者自己编排的文件不判缺节——编排是权威，脚本也不会替它补节）；第四条确认
`README.md` 与 `README.en.md` 的目录与标题同步，改了标题或增删节后重跑
`node scripts/sync-toc.mjs README.md README.en.md` 即同步。

**改动判定逻辑时必须同时补 fixture。** `selftest.mjs` 里每条断言对应一类必须防住的
行为契约，改动之后如果它红了，先怀疑自己的改动，不要改断言去迁就实现。

**如果你改了 `templates/agents-kernel.md`**，需要重新注入并一起提交：

```sh
node scripts/compose-agents.mjs .
```

否则第三条门禁会红。

## 改动行为时请附带验证

新增或修改判定能力时，**先造出能证伪它的 fixture**：一个该被识别成 X 的目录，和一个
容易被误判成 X 的目录。用临时目录造，跑完就删，不要把 fixture 留在仓库里。

只验证正面案例等于没验证——勘察脚本里大部分 bug 都出在「把不该匹配的匹配上了」。

## 硬性规范

最关键的几条（**完整规范以 [`AGENTS.md`](AGENTS.md) 为准**）：

1. **禁 emoji**：代码、注释、文档、提交信息一律不得出现 emoji 字符。
2. **零依赖、只用 JavaScript**：`scripts/` 只允许 `node:` 前缀的内置模块与 `.mjs` 文件。
   不引入第三方依赖，也**不引入第二个运行时**（README 对外承诺「Python 完全不需要」，
   加一个 `.py` 脚本就让那句话变成假话）。这个 skill 会被 AI 在各种陌生项目里调用，
   不能要求先装东西。`preflight.mjs` 会检查这两条。
3. **不写死取值**：文档里凡是需要具体值的地方（账号、路径、版本号、仓库地址），一律写
   「从哪里取」。
4. **入口不复述**：`SKILL.md` 只写原则与指针，细节在 `references/` 里。

## 提交信息

一句话说明这次**改了什么、影响谁**。中文或英文都可以，**不要使用 emoji**。一次实质改动
一个提交。若改了内核模板，同一次提交里带上重新注入后的 `AGENTS.md`。

提交信息是发版时那段「这一版更新了什么、修复了什么」的素材，所以**用别人能读懂的话写**：
写「修好了导航链接点击无效」而不是「修了 issue 里的那个 bug」，也不要用内部编号或任务
代号充当说明——出了这个上下文就没人读得懂。想让人一眼看出是修问题还是加能力，可以自己
用前缀（例如 `fix:` / `feat:`），但**不强制**，本项目不引入第二种格式约定。

维护者发版时另有一条：改版本号那次提交的**正文**要写一段面向使用者的总述——发布说明只
取自它，没有正文时发送端会拒绝发送，发版直接失败（判据见 `AGENTS.md` 的「版本节点与发布
说明」）。

## 许可

提交贡献即表示你同意以本项目的许可证（[MIT](LICENSE)）发布你的贡献。
