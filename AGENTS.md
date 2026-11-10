# project-forge — 本仓库维护契约

本文件约束 `project-forge` **这个仓库自己**的开发与维护。它是维护者读的，不是这个 skill
的产物——随包分发的产物在 `templates/`，两者的读者不同：这份写给改它的人，那份写给用它的人。

## 定位

一个通用的「项目锻造」skill：给任意项目目录，自己勘察现状、判断该做哪几件事，
把版本管理、GitHub 远端、文档套装、发布通道配到位。它只做治理，不生成项目本身。

仓库是这套规范的**第一个用户**：`references/` 里写的做法，这里必须自己做到。
做不到时**先改自己，再改规范**。

## 两层，互不越界

| 层 | 位置 | 谁读 | 能不能被模板校验 |
| --- | --- | --- | --- |
| **产品** | `SKILL.md`、`references/`、`templates/`、`scripts/`（顶层与 `lib/`） | 拿到这个 skill 的人 | 是——它必须对任何项目成立 |
| **自用** | `AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、`docs/`、`.github/`、`scripts/dev/` | 只有改它的人 | **否** |

这条分界是硬性的。早先版本用一张 `TEMPLATE_INSTANCES` 表把两边绑在一起，结果是**这个
仓库自己的协作方法论漏进了给别人的模板**——每个用户的每个项目都要背一套他并不需要的
审查流程。**自用层的方法论不许出现在 `templates/` 里。**

## 不变量

1. **零第三方依赖**：`scripts/` 只用 `node:` 内置模块，只用 JavaScript。
   `preflight.mjs` 会扫磁盘检查，新增脚本不用登记。
2. **入口不复述细节**：`SKILL.md` 只写「什么时候读哪一份」，判据全在 `references/`。
   两处都写机制，一定会有一处先过期。
3. **不写死取值**：账号、路径、版本号、仓库地址一律写「从哪里取」。
4. **单一真相源**：标记语法只在 `scripts/lib/protocol.mjs`；渲染只在 `lib/render.mjs`；
   文本判据只在 `lib/text.mjs`。同一件事两个实现，迟早给出两个答案。
5. **幂等**：所有脚本重复执行结果相同。判据是**第二遍的字节与第一遍相同**。
6. **只读先行**：勘察完成之前不写任何文件。这条是这个 skill 的第一硬不变量，
   它自己必须先做到。
7. **预算门禁**：`SKILL.md` ≤ 160 行、`references/` 合计 ≤ 1300 行、
   一次全量必读 ≤ 850 行。数字在 `protocol.mjs` 里，`preflight.mjs` 会喊。

## 构建与验证（改完必跑）

```sh
node scripts/dev/preflight.mjs   # 结构 + 端到端冒烟，约 5 秒
```

它查六类：入口能被宿主认出来、引用不断链、零依赖、脚本的 `--help` 能跑、
**在临时项目上真跑一遍勘察→生成→体检→交棒**、卫生（无 BOM / emoji / 本机路径）。

**跑出来的才算做完。** 只改文档也要跑——引用断了它才会说话。

几个常用的一次性命令：

```sh
node scripts/survey.mjs . --markdown          # 看这个仓库自己长什么样
node scripts/review.mjs .                      # 自己过一遍交付体检
node scripts/sync-toc.mjs README.md README.en.md --check
```

## 改哪看哪

| 这次动了 | 必须一起看 |
| --- | --- |
| `scripts/lib/protocol.mjs` 的标记语法 | `compose-agents.mjs`、`handoff.mjs`、`review.mjs`、`references/handoff.md` |
| `references/` 里任一判据 | `SKILL.md` 里指向它的那一行（能指就不抄） |
| `templates/` 里任一骨架 | 它有没有被某篇 `references/` 提到（`preflight` 会喊） |
| `scripts/` 里任一脚本 | `SKILL.md` 的「有一段代码要跑到」那节 |
| `README.md` 的结构或能力 | `README.en.md` 成对改，并重跑 `sync-toc` |
| 发布链路的任何一处 | `RELEASING.md`、`docs/release-notes/`、`.github/workflows/release.yml` |

## 提交纪律

一次实质变更一个提交，说清「改了什么、为什么」。禁用 emoji，不用内部编号充当说明。
**改了 `templates/` 或 `references/` 之后同一次提交要重跑 `preflight` 并绿。**

日常只提交推送不打标签；**只有明确说「发版」才打标签写说明**，流程见 `RELEASING.md`。
