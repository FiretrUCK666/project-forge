# 任务单：project-forge v5 双层同构与研发闭环升级

关联规范：[v5 架构升级设计规范](../specs/261114-v5-architecture-upgrade.md)
目标分支：`feat/v5-harness-upgrade`
执行角色：协调与多模块并行实施 + 独立集成验证（无外部远端直推，经独立审查收口）

## 验收标准（动手之前冻结）

- [x] C1: 双层同构与包边界隔离 — `kit/` 进用户包，`.agents/` 与 `docs/` `export-ignore`；`SKILL.md`（`<= 185` 行、`< 18432` 字节、`version: 5.0.0`）与 `kit/` 零本仓私有路径及零非 GitHub 平台词。
- [x] C2: 三态 SHA256 账本与幂等装配 — `scripts/equip.mjs` 实现 `.agents/skills/.pf-manifest.json` 写入、幂等、未改升级、退役文件自净化、用户魔改/自定义保留与 `--check` 校验。
- [x] C3: 空白项目 0 文件起步 — `equip.mjs --bootstrap-empty` 按语言生成零第三方依赖可运行骨架与初始 `docs/TDD.md`，生成物通过自身冒烟测试。
- [x] C4: 双轴五态身份判定 — `resolveWorkspaceIdentity` 与 `survey.mjs` 正确区分 `local-only` / `maintainer` / `contributor-fork` / `clone-readonly` / `undetermined`，阻断他人仓 `git clone` 误判。
- [x] C5: 双轨四级 GitHub 引擎 — 无交互防弹窗探测、纯 SSH 22/443 不误报、错配修复命令、`gh-cli` -> `node-https-token` -> `mcp-delegate` -> `half-duplex` / `offline` 降级、token 零泄露与 403 标签静默跳过。
- [x] C6: 文档四层体系与 `AGENTS.md <= 30KB` — 新建 `docs-{tdd,prd,spec,todo}.md` 模板并移除 `work-item.md`；`agents-project.md` 纳入路由表、Dev Profile 与收尾 7 步；`compose-agents.mjs` 实现 30KB 门禁与 SHA256 防覆盖保护。
- [x] C7: 目录自包含探索与五档分流 — `kit/skills/lib/shared.mjs` 自包含；`repo-map.mjs` 只读建图；`doc-plan.mjs` 实现 Case 1..5 分流与文档生命周期管理。
- [x] C8: Worktree 共享依赖零拷贝挂载与防删穿 — `worktree-deps.mjs` 锁文件匹配挂载 Junction/Symlink，变化时隔离；`unmountSharedDeps` 先 `fs.unlinkSync()` 解绑，主仓依赖无损。
- [x] C9: 全流程状态机与安全防误删锁 — `flow.mjs` 支持接管、依赖解析、`verifiedHead === HEAD` 校验、`contributor-fork` 禁合并、`OPEN` PR 防删锁与无 `--confirm` 只列清单。
- [x] C10: 外部 PR 投毒拦截与六锁审查 — `review-pack.mjs --untrusted-scan` 拦截工作流/钩子投毒（`BLOCKED_UNTRUSTED_HAZARD`）；禁止自审；触发 `STOP_LOSS_ESCALATE` 停损；代码-文档核验与本地预审。
- [x] C11: 全量治理与对齐巡检 — `govern-audit.mjs` 支持 `--audit-only`/`--plan-only`/`--execute`/`--scope`/`--categories`/`--loop`/`--issues`/`--apply-issues` 及 `reconcile` 巡检。
- [x] C12: 全仓自举、门禁补强与故障注入实证 — 迁移历史任务单并清零 `homePathLeaks`；完成自举同步；升级 `preflight.mjs`、`fixtures.mjs` 与 `verify-injections.mjs`（含 `I19..I24`），全部 9 条验证命令退出码为 0。

## 完成后的记录

**在合并之前写完，随这次改动一起提交。**

- 交付物总览：`.gitattributes`、`.gitignore`、`docs/TDD.md`、`docs/specs/261114-v5-architecture-upgrade.md`、`docs/archive/todo/`（含历史归档与脱敏修复）、`README.md`、`README.en.md`、`CONTRIBUTING.md`、核心脚本与平台模块、五套自包含内置研发 Skill（`kit/skills/`）、新版 `SKILL.md` / `references/` / `templates/`、本仓自举 `.agents/skills/` 与 `AGENTS.md`，以及增强版 `scripts/dev/` 门禁与注入校验。
- 遗留与后续：无遗留项，随 `feat/v5-harness-upgrade` 合入主干后归档。
