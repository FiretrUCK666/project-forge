---
kind: todo
title: 多远端平台统一能力内核与协议方言适配器
status: done
created: 2026-11-27
updated: 2026-11-27
issue: 227
pr: null
branch: feat/multi-forge-platform-core
owner: plan-c-master
plan_mode: interactive
approved: false
done_at: 2026-11-27
task_id: multi-forge-platform-core
planned_at: 7785ef3c55cb5251cbca39c6b312b414ab4841f5
related_prd: ../../prd/261127-issue227-multi-forge-worktree-perf-v1-prd.md
related_spec: ../specs/261127-issue227-multi-forge-platform-core-spec.md
---

# 多远端平台统一能力内核与协议方言适配器

## 文档信息与范围概览

| 项目 | 内容 |
| --- | --- |
| 当前状态 | `done`（枚举：`draft \| active \| pending \| in_review \| done \| archived \| dropped`） |
| 建单 / 更新 | `2026-11-27` / `2026-11-27` |
| 分支 / 基线 | `feat/multi-forge-platform-core` @ `7785ef3` |
| 任务编号 | `multi-forge-platform-core` |
| 负责人 / 审批 | plan-c-master / `false` |
| 规划态 | `interactive`（逐题问到零拍板） |
| 关联 Issue / PR / SPEC | #227 / 未关联 / `docs/archive/specs/261127-issue227-multi-forge-platform-core-spec.md` |

- **断点恢复**：接手人先核对 Frontmatter `status`/`branch`/`issue` 与关联 SPEC 审批状态。

## 任务范围与验证基准

- **影响路径**：`kit/skills/lib/platform-registry.mjs`、`kit/skills/lib/platform-http.mjs` (new)、`kit/skills/lib/platform-providers.mjs` (new)、`kit/skills/lib/platform-probe.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/github-parse.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/github-labels.mjs`、`kit/skills/lib/task-backend.mjs`、`scripts/lib/platform/registry.mjs`、`scripts/lib/platform/index.mjs`、`scripts/lib/platform/github.mjs`、`scripts/lib/platform/github-client.mjs`、`scripts/lib/platform/github-probe.mjs`、`scripts/dev/preflight-suite.mjs`、`scripts/dev/fixtures-platform.mjs`、`scripts/dev/fixtures-repo-alignment.mjs`、`scripts/dev/injections-data-repo-alignment.mjs`、`scripts/dev/injections-data-kernel-dedup.mjs`、`scripts/dev/injections-data-platform-core.mjs` (new)
- **复用既有模块**：`kit/skills/lib/platform-registry.mjs`、`kit/skills/lib/platform-probe.mjs`、`kit/skills/lib/platform.mjs`、`kit/skills/lib/github-parse.mjs`、`kit/skills/lib/github-labels.mjs`、`kit/skills/lib/task-backend.mjs`、`scripts/lib/platform/registry.mjs`
- **本期不做**：不改动 `flow-*.mjs`、`review-*.mjs`、`plan-sync.mjs` 与 `scripts/{survey,review,equip-ci}.mjs`、`scripts/lib/render.mjs` 业务调用面（Wave 3）；不硬编码任何私域企业域名/账号/Token
- **门型与回滚路径**：`one-way`（高风险路径 `kit/`、`scripts/lib/`）；反向提交本切片并重跑 `node scripts/equip.mjs .` 与 `node scripts/dev/preflight.mjs`
- **快测命令**：`node scripts/dev/preflight.mjs`

## 验收标准与执行清单

<!-- criteria:start -->
- [x] C4: `kit/skills/lib/platform-registry.mjs` 与 `scripts/lib/platform/registry.mjs` 升级为单源 10 键能力矩阵（新增 `uploadAttachment`、`checks`）并注册 5 内置方言（`github`/`gitlab`/`gitcode`/`gitee`/`gitea`）+ `generic-git` 兜底，零私域域名硬编码；同步升级 `scripts/dev/preflight-suite.mjs`（L355-359 双端注册表对齐与 L383 `AbortSignal.timeout` 校验对齐，且保留全部 SSH 安全断言）、`scripts/dev/fixtures-platform.mjs`、`scripts/dev/fixtures-repo-alignment.mjs`、`scripts/dev/injections-data-repo-alignment.mjs`（`I391`/`I393`）与 `scripts/dev/injections-data-kernel-dedup.mjs`（`I372`/`I373`）。
- [x] C5: 新增零依赖 `kit/skills/lib/platform-http.mjs` (new)（`node:http`+`node:https`、公网 `http://` 与 `169.254.169.254`/`fe80::` Fail-Closed 拦截、仅允许 loopback/RFC1918 局域网 `http://`、`AbortSignal.timeout`、`redirect: 'manual'` + 3xx `Location` 脱敏、全平台令牌脱敏、4 字节字符守卫、随机 boundary + filename CRLF/引号清洗 + 纯 `Buffer.concat` multipart）与 `kit/skills/lib/platform-providers.mjs` (new)（5 方言鉴权头、429 退避上限、GitLab/GitCode `/uploads` multipart 上传、`refs/merge-requests/<iid>/head` 真 SHA 校验含离线/浅仓回退与 `shaSource` 标注、客户端分支二次过滤），升级 `kit/skills/lib/platform-probe.mjs`（`<= 700` 行）、`kit/skills/lib/github-parse.mjs`、`kit/skills/lib/github-client.mjs`、`kit/skills/lib/github-labels.mjs` 与 `scripts/lib/platform/*`。
- [x] C6: `kit/skills/lib/platform.mjs` 新增 `resolveRemoteTarget`（完整支持 GitLab 多级群组 `group/sub/repo` 与 LAN/离线识别），`kit/skills/lib/task-backend.mjs` 落地统一 `RemoteApiBackend` 取代 `provider.id !== 'github'` 硬退化；通过纯 Node 本地 `node:http` Mock Forge 在 `scripts/dev/fixtures-platform.mjs` 与 `scripts/dev/injections-data-platform-core.mjs` (new) 完成正反双向实证与故障注入，`node scripts/dev/preflight.mjs`、`node scripts/dev/fixtures.mjs --domain platform`、`node scripts/dev/fixtures.mjs --domain repo-alignment` 与 `node scripts/dev/merge-gate.mjs` 退出码 `0`。
<!-- criteria:end -->

## 执行步骤

| 步骤 | 做什么 | 怎么验 | 前置依赖 |
| --- | --- | --- | --- |
| 1 | 先补失败断言到 `scripts/dev/fixtures-platform.mjs`（10 键能力、5 方言多级群组、公网 `http://` 与 `169.254.169.254` 拒接、Mock Forge `http://`、纯 Buffer `/uploads`、真 SHA + `shaSource`、4 字节守卫、拒 3xx 重定向与 `Location` 脱敏） | `node scripts/dev/fixtures.mjs --domain platform` 必红 | 切片获批 |
| 2 | 升级双端注册表、`github-parse.mjs` 与 `github-labels.mjs`，实现 `platform-http.mjs` (new) 与 `platform-providers.mjs` (new)，瘦身升级 `platform-probe.mjs`（保 `StrictHostKeyChecking=yes`/`--hostname`/`AbortSignal.timeout`）、`github-client.mjs` 与 `scripts/lib/platform/*` | `node scripts/dev/preflight.mjs` 全绿 | 步骤 1 |
| 3 | 升级 `platform.mjs`（`resolveRemoteTarget`）与 `task-backend.mjs`（`RemoteApiBackend`），同步对齐 `preflight-suite.mjs`、`fixtures-repo-alignment.mjs`、`injections-data-repo-alignment.mjs` 与 `injections-data-kernel-dedup.mjs` | `node scripts/dev/fixtures.mjs --domain platform` 与 `--domain repo-alignment` 全绿 | 步骤 2 |
| 4 | 新增故障注入 `scripts/dev/injections-data-platform-core.mjs` (new)，同步 `node scripts/equip.mjs .` 并跑全量门禁 | `node scripts/dev/merge-gate.mjs` 与 `node scripts/dev/verify-injections.mjs --jobs 4` 退出码 `0` | 步骤 3 |

## 断点与遗留决策

- **当前状态**：`已完成 (done)`（已按 R1 独立审查意见修订完毕，待 R2 独立 Critique 与维护者 `approve` 后开工）
- **待拍板事项**：无
- **下一步第一件事**：完成 R2 独立 Critique 与 `approve` 后，先在 `scripts/dev/fixtures-platform.mjs` 补齐 10 键、SSRF/脱敏与 Mock Forge 失败测试再落地内核代码。

## 澄清与补充记录

- （本轮无额外澄清补充；用户拍板确认的新增要求可通过 `doc-plan.mjs clarify` 写入「已确认：…」）

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- **实际验证命令与结果**：`node scripts/equip.mjs .`、`.agents/skills/dev-edit/scripts/edit-gate.mjs --mode verify --changed --json`（0 blockers）、`node scripts/dev/preflight.mjs`（42/42 PASS）、`node scripts/dev/fixtures.mjs` 全量与 Mock Forge 双向断言通过、`node scripts/dev/verify-injections.mjs --jobs 2`（含 `I1101..I1108` 与 `I372`/`I373`/`I391`/`I393` 全部通过）、`node scripts/dev/merge-gate.mjs`（12/12 PASS）。
- **文档同步检查**：本切片不涉及 `docs/TDD.md`、`docs/feature-map.json` 与双语 `README` 收口（归属 Wave 3）；SPEC 与 Todo 成对归档，`.agents/skills/` 经 `equip.mjs` 同步一致。
- **遗留问题**：无（Wave 3 负责业务调用面切换与长青文档同步）。
