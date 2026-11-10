# 贡献指南

感谢关注。报告缺陷、提需求、改代码都欢迎，按下面的流程来。

## 提之前先看一眼

- 缺陷用 [缺陷模板](.github/ISSUE_TEMPLATE/bug_report.md)，需求用
  [需求模板](.github/ISSUE_TEMPLATE/feature_request.md)——它们问的正是我需要的信息，
  少一轮来回。
- 改动走 Pull Request，正文用 [模板](.github/pull_request_template.md)。

## 本地怎么跑

不装任何东西，只要 Node 18 以上。

```sh
git clone https://github.com/FiretrUCK666/project-forge.git
cd project-forge
node scripts/dev/preflight.mjs
```

这条命令是唯一的门禁：结构检查加一趟端到端冒烟，约五秒。**它绿了才算改完。**

顺手可以跑的两条：

```sh
node scripts/survey.mjs . --markdown    # 看这个仓库自己长什么样
node scripts/review.mjs .               # 自己过一遍交付体检
```

## 改文档和判据

这个项目的产物主要是**给 AI 读的指令**，所以改文档和改代码一样，要能验证：

- 判据写在 `references/` 里，`SKILL.md` 只写「什么时候读哪一份」。两处都写机制，
  一定会有一处先过期。
- 新增一份判据之前先问：能不能并进已有的那篇？文件数量本身就是成本——读它的是 AI，
  它要为每一份付上下文预算。
- 引用别的文件时用相对路径。`preflight` 会检查它是否真实存在。

## 改脚本

- 只用 Node 内置模块，不引第三方依赖，不加第二个运行时。这条由 `preflight` 自动查。
- 脚本输出是给 AI 读的，所以**说清「为什么」比说清「怎么用」重要**——遇到坏输入时
  告诉它下一步该做什么，而不是只报一句错误。
- 改完跑一遍 `--help`：`preflight` 会检查它能不能跑通。

## 这个仓库自己的协作规矩

这个仓库把 `references/collaboration.md` 那套用在自己身上，具体取位见
[`AGENTS.md`](AGENTS.md) 与 [`RELEASING.md`](RELEASING.md)。三条硬性的：

1. **一次实质变更一个提交**，提交信息说清「改了什么、为什么」。禁用 emoji，
   不用内部编号充当说明。
2. **不弱化门禁**：删测试、放宽断言、加跳过标记、把检查改成警告——这类改动一票否决，
   不管是谁提的。
3. **高风险改动要有一轮独立审查**：判定逻辑（`scripts/lib/`）、门禁本身
   （`.github/workflows/`、`scripts/dev/preflight.mjs`）、包边界（`.gitattributes`、
   `REPO_ONLY_*`）、发布链路。改动落在这几处时，在 PR 里说明你派了一个新上下文看过，
   并写下它指出的问题。

## 提交 PR

1. 从 `main` 拉一个分支（`fix/xxx`、`feat/xxx`、`docs/xxx`）。
2. 改完跑 `node scripts/dev/preflight.mjs`，把实际输出贴进 PR 的「怎么验证的」。
3. 用户可见的行为或命令变了，同一次提交里改 `README.md`（以及 `README.en.md`）。
4. 说清回滚点：出问题时怎么退回去。

## 关于两层结构

这个仓库分两层，改动前先认清自己在动哪一层：

| 层 | 位置 | 约束 |
| --- | --- | --- |
| 产品 | `SKILL.md`、`references/`、`templates/`、`scripts/`（顶层与 `lib/`） | 必须对任何项目成立，**不许混进本仓库自己的方法论** |
| 自用 | `AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、`docs/`、`.github/`、`scripts/dev/` | 只服务这个仓库，不进用户包 |

把自用的东西写进 `templates/` 是最容易犯的错：那会让每个用户的每个项目都背上
一套他并不需要的流程。
