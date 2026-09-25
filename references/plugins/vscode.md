# Visual Studio Code 扩展

## 何时读本文件

- 勘察判定项目是 `vscode-extension`（清单里有 `engines.vscode`）时。
- 给一个 VS Code 扩展配置版本管理、远端或发布链路时。

通用结论见 `references/plugin-project.md`，本文件只写这个生态特有的事实。

## 一、怎么认出这类项目

清单就是根目录的 **`package.json`**。最可靠的判定字段是 `engines.vscode`——只有扩展才会
声明它。次要证据：依赖里有 `@types/vscode`、或存在 `.vscodeignore`。

## 二、清单里必须有什么

官方文档标注为**必填**的四个字段（缺任何一个都发不出去）：

| 字段 | 要求 |
| --- | --- |
| `name` | 全小写、不含空格；**在应用市场里全局唯一** |
| `version` | 符合 SemVer |
| `publisher` | 发布者标识（发布前先在市场上注册） |
| `engines.vscode` | 兼容的宿主版本范围；**不能写 `*`** |

常用的可选字段：`displayName`（市场上显示的名字，也要求全局唯一）、`description`、
`categories`、`keywords`、`main`、`browser`、`contributes`、`activationEvents`、
`icon`、`license`、以及指向仓库与问题反馈的 `repository` / `bugs` / `homepage`。

**其中两个字段填错会直接发不出去，得单独盯：**

- **`categories` 只能取官方枚举里的值**——不在枚举里，发布就失败。上次核对到的枚举是：
  `Programming Languages`、`Snippets`、`Linters`、`Themes`、`Debuggers`、`Formatters`、
  `Keymaps`、`SCM Providers`、`Other`、`Extension Packs`、`Language Packs`、
  `Data Science`、`Machine Learning`、`Visualization`、`Notebooks`、`Education`、`Testing`。
  **枚举会随市场增加，以官方 Extension Manifest 页里 `categories` 的 Allowed values 为准**
  （另有一条：某些类别是给特定场景保留的，例如本地化语言包那一类，别拿来当普通分类用）。
- **`keywords` 有数量上限**，超了同样发不出去。**上限以官方该页当前写的数字为准，别背。**

两个都是易变项，上面那份枚举是上次核对到的样子。

## 三、两个标识分别是什么

| 标识 | 是什么 |
| --- | --- |
| **扩展 id** | `${publisher}.${name}` 拼出来的那个字符串；市场上唯一，也是用户配置与数据的地址 |
| **分发标识** | 上面这个 id 本身（VS Code 的扩展不由 npm 制品库分发，而是发到应用市场） |

这个生态里两个标识**拼在一起**，所以容易误以为只有一个。要点仍然相同：

- **`name` 与 `publisher` 一旦发布就不要改**：扩展 id 变化会让已有用户的配置与数据失联，
  而且市场上会变成两个不同的扩展（而不是一次升级）。
- 扩展之间的依赖也用同一个 id 形式（`extensionDependencies` 里写 `publisher.name`），
  改名会让依赖它的扩展一起失效。

## 四、宿主加载什么文件

| 字段 | 作用 |
| --- | --- |
| `main` | 入口（在扩展宿主里运行，能用 Node 能力） |
| `browser` | 网页版扩展的入口（在受限的浏览器环境里运行，**不能用 Node 能力**） |

有的扩展两个都写：同一份代码分别在两种环境里跑，靠条件判断走不同分支。这与
`plugin-project.md` 里「宿主决定运行环境」是同一件事的两种形态。

**编译产物必须进版本库**：安装方不会替你构建，编译产物（`out/`、`dist/` 一类构建输出与入口文件）必须提交；打包出来的存档（`.vsix`）是发布时现做的，不入库。
发布前只打包不发布，核对实际包含哪些文件；CI 里必须有一条「重建后与提交的编译产物一致」的
检查，否则产物与源码迟早脱节。

设置 `vscode:prepublish` 脚本可以让打包前自动构建（见官方文档「Publishing Extensions」
的 prepublish 一节）——把构建挂上去，比靠记忆可靠。

## 五、宿主版本约束

- `engines.vscode` 同时承担两个角色：**打包时的最低要求**与**市场展示的兼容范围**。
  它**不能是 `*`**（必须有下限）。
- 它也是「最低支持版本」的载体——上移它等于放弃旧版宿主上的用户，规则见
  `references/publish.md`。
- 本机调试时对的是你装的那个宿主版本；发布时要重新确认下限是否仍然成立。

## 六、怎么打包、怎么发放

- **打包**：用官方的扩展打包工具（`vsce` 一类）产出安装存档。**它支持「只打包不发布」**，
  发布前必须跑一次，看实际包含哪些文件、体积多大。
- **包含规则**：打包工具按忽略文件（`.vscodeignore`，语法见官方文档的
  「Publishing Extensions」一节）决定排除哪些内容。默认会排除一批常见目录，但**不要依赖默认**——
  要发出去的东西（入口、`contributes` 引用到的资源、图标、说明与许可证）必须确认在包里。
- **发布**：需要一个发布者账号，然后上传存档。发布后市场上才可见。
- **本地调试**：用「以扩展开发主机启动」的方式加载当前目录，改完重启调试会话即可生效。
  这与使用者「装了扩展」是两条不同的路径，**这个差别要写进面向使用者的文档**。

## 七、这个生态特有的坑

- **`engines.vscode` 写 `*` 会被打包工具拒绝**——这不是风格问题，是硬性校验。
- **`name` 与 `displayName` 都要求在市场上唯一**：撞名时发布失败，而不是自动加后缀。
- **`categories` 填枚举外的值、`keywords` 填超量**：两种都是发布时直接失败，不给模糊提示
  （见第二节写的那两条）。
- **网页版扩展（写 `browser` 入口的）不能用 Node 能力**：文件系统、子进程、原生模块都
  不可用。同一份源码要同时支持两种环境时，能力差异必须显式处理，不能假定「本地能跑」。
- **扩展依赖用 id 形式声明**，改 `name` 或 `publisher` 会连带影响依赖它的扩展。

## 事实来源

**本文件的易变项**：清单的必填字段与各自的唯一性要求、`engines.vscode` 的约束、
`categories` 的允许值枚举、`keywords` 的数量上限、`main` 与 `browser` 两个入口、
扩展 id 的构成、打包与忽略规则。

- 清单字段（必填项、`engines.vscode` 不可为 `*`、`name` 与 `displayName` 的唯一性、
  `main` / `browser`、`extensionDependencies`、`vscode:prepublish`）：
  <https://code.visualstudio.com/api/references/extension-manifest>
- 打包与发布流程、打包命令、忽略文件名与语法：
  <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>

第二页的内容**本文件没有逐条抄录**（命令与语法会变），用到时直接照那一页做。

格式与用法见 `references/publish.md` 的『专章的「事实来源」标记』一节。

<!-- vscode-verified: date=2026-09-25 -->
