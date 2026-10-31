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
node scripts/dev/preflight.mjs
node scripts/dev/selftest.mjs
node scripts/compose-agents.mjs . --check
node scripts/sync-toc.mjs README.md README.en.md --check
git archive --format=tar HEAD | tar -t > package-list.txt && node scripts/dev/preflight.mjs --package package-list.txt --at HEAD
```

- [ ] 上面五条全绿（与 CI 是同一批命令）
- [ ] 改了判定逻辑的话，同时补了能证伪它的 fixture（一个该被识别成 X 的目录，一个容易被误判成 X 的目录）
- [ ] 改了 `templates/agents-kernel.md` 的话，同一次提交里带上了重新注入的 `AGENTS.md`
- [ ] 改了 README 的结构的话，重跑过 `sync-toc.mjs`
- [ ] 行为变了的话，`README` 与 `AGENTS.md` 里失准的地方都同步了

## 备注

<!-- 有没有拿不准的地方、需要维护者拍板的事，写在这里。 -->

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
