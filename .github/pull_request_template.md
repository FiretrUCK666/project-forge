## 改了什么

<!-- 一句话说清「改了什么、影响谁」。这句会被拿去写发布说明，所以要别人能读懂。 -->

## 为什么

<!-- 关联的 Issue，以及这个改动解决的是什么问题。 -->

## 怎么验证的

<!--
贴实际跑过的命令与结果。这个项目的完成标准是「拿得出实际跑过的结果」，
不是「看起来对了」。
-->

```sh
node scripts/dev/preflight.mjs --no-behavior
node scripts/dev/selftest.mjs
node scripts/compose-agents.mjs . --check
node scripts/sync-toc.mjs README.md README.en.md --check
git archive --format=tar HEAD | tar -t > package-list.txt && node scripts/dev/preflight.mjs --package package-list.txt --at HEAD
```

（第一条带 `--no-behavior`：行为那趟交给第二条，两条职责正交。`package-list.txt` 用完删掉。）

- [ ] 上面这几条全绿
- [ ] 改了判定逻辑的话，同时补了能证伪它的 fixture（一个该被识别成 X 的目录，一个容易被误判成 X 的目录）
- [ ] 改了 `templates/agents-kernel.md` 的话，同一次提交里带上了重新注入的 `AGENTS.md`
- [ ] 改了 README 的结构的话，重跑过 `sync-toc.mjs`
- [ ] 行为变了的话，`README` 与 `AGENTS.md` 里失准的地方都同步了

## 回滚点

<!--
出问题回到哪个**已知可用**的状态：上一个可用提交、上一个版本标签，或一条明确的处置步骤。
「出事了再说」不算回滚点——那时候最需要的正是这句话。

这个项目没有可发布的制品、也没有数据迁移，所以回滚通常是「用反向提交退回上一版」。
如果这次改动动了判定逻辑或模板，写清退回之后要重跑哪几条命令确认回到可用状态。
-->

## 备注

<!-- 有没有拿不准的地方、需要维护者拍板的事，写在这里。 -->
