---
kind: todo
title: 重写双语 README 并治理门禁机制性超时
status: done
created: 2026-11-15
updated: 2026-11-15
issue: null
pr: null
branch: main
owner: null
done_at: 2026-11-15
related_spec: ../specs/261115-readme-and-gate-rewrite-spec.md
tier: L3
---

# Todo: 重写双语 README 并治理门禁机制性超时

## 任务来源

- 关联 SPEC：[重写双语 README 并治理门禁机制性超时](../specs/261115-readme-and-gate-rewrite-spec.md)
- 门型：`two-way`
- 分流档位：`Case 4`

## 本期不做

- 不重构 `fixtures-v5-*` / `fixtures-v6-*` 按历史波次命名的文件归并，作为独立治理项另行处理。
- 不改任何判定逻辑与业务语义，只改执行机制与文档表述。

## 门型与回滚路径

- 门型：`two-way`
- 回滚路径：全部为独立文件改动，`git revert` 即可反向还原；`--only` 与 `--jobs` 均为新增参数，旧调用方式行为不变。

## 验收标准

- [x] C1: `node scripts/dev/fixtures.mjs --only noise-keyword` 未命中任何用例时以非零退出码结束，不静默通过
- [x] C2: `node scripts/dev/verify-injections.mjs` 全量复验的注入检出结论与改造前一致，且不再触碰主工作区
- [x] C3: 门禁能翻转诊断「起步骨架语言清单与识别语言清单」的不一致（注入 I51 必红）
- [x] C4: 双语 README 的语言支持表述与实测一致：能识别 12 种、能生成起步骨架 6 种，两档分列
- [x] C5: 双语 README 含「一次真实改动的完整链路」，把 5 个技能串联说清先后与可跳过点
- [x] C6: 双语 README 目录锚点同步通过，且全部既有门禁仍全绿

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- 全部 8 项执行项完成，6 条验收标准全部实测通过。
- 遗留：`fixtures-v5-*` / `fixtures-v6-*` 按历史波次命名的归并，作为独立治理项另行处理，不与本次混合。

### 实测记录

改造前（本机 Windows，16 核）：

- `fixtures` 全量：311.5 秒
- `verify-injections` 全量：跑满 10 分钟未完成，人工中止

改造后：

- `fixtures --only <keyword>` 定向：0.1 秒
- `fixtures` 全量串行：217 秒，128 项全绿
- `verify-injections --only I43` 单条：10 秒
- `verify-injections` 全量并行（`--jobs 4`）：155 秒，58 条判据全部检出

### 过程中修掉的两个真问题

1. **故障注入会污染工作区**。原实现就地改文件再还原，进程被中途杀掉时仓库停在「判据被拆掉」的状态，`git status` 上只是一行 `M`。本次已被这个机制坑到两次（`scripts/survey.mjs` 与 `templates/docs-spec.md` 都留下过注入残迹）。改成整树副本加每条注入独立副本后，主工作区不再被触碰。
2. **两条注入的期望关键字与断言实际输出对不上**（I43 的 `tests.hard-sleep` 与 I50 的「远端 CI 失败未阻断合并」）。它们看起来「永远红不了」，实际是匹配词写得比断言输出短或长。这不是判据不灵，是复验脚本自己的判据写错了。
