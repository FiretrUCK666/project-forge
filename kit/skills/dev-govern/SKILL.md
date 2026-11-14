---
name: dev-govern
description: |
  代码体检、清技术债、安全与规范审计、重构治理、同步 AGENTS/TDD、多轮收口与 GitHub Issue 批处理。
  触发词：代码体检、清技术债、审计、重构治理、同步 AGENTS/TDD、reconcile、仓库巡检、
  清理过期 worktree、检查 deadcode、安全扫描、治理计划、批量提 Issue、技术债盘点。
---

# dev-govern

对仓库做只读代码体检、分批重构治理、GitHub Issue 生成与工程契约巡检（`reconcile`），
全部入口收敛在：`node .agents/skills/dev-govern/scripts/govern-audit.mjs`。

## 组合工作模式

默认只读，先出事实与 `[GAP_SCAN]`，再按需出计划、执行或生成 Issue：

```sh
# 1. 只读审计：输出结构化发现与 [GAP_SCAN] 汇总
node .agents/skills/dev-govern/scripts/govern-audit.mjs --audit-only

# 2. 限定目录与扫描类别（支持 security,deadcode,tests,docs,hygiene,perf）
node .agents/skills/dev-govern/scripts/govern-audit.mjs --audit-only --scope src --categories security,tests,docs

# 3. 只出分批修复计划（可加 --write-todo 落盘 docs/todo/ 草案）
node .agents/skills/dev-govern/scripts/govern-audit.mjs --plan-only [--write-todo]

# 4. 闭环执行引导 + 多轮收口轮次账本（.worktrees/.state/govern-loop.json）
node .agents/skills/dev-govern/scripts/govern-audit.mjs --execute --loop

# 5. 生成 GitHub Issue 载荷（默认只预览；仅当明确确认且显式传 --apply-issues 时走 UTF-8 --body-file 创建）
node .agents/skills/dev-govern/scripts/govern-audit.mjs --issues [--apply-issues]
```

## 工程契约巡检（reconcile）

当怀疑契约文档、技能安装清单或隔离目录发生漂移时运行 `reconcile`：

```sh
node .agents/skills/dev-govern/scripts/govern-audit.mjs reconcile
```

`reconcile` 重点核对六项事实：
1. **AGENTS.md 体积门禁**：逼近 `24576` 字节（24KB）预警、超过 `30720` 字节（30KB）报高危超限，提示裁剪冗余或下沉至子目录 `AGENTS.md`。
2. **AGENTS.md 路径与命令有效性**：扫描其中反引号相对路径、Dev Profile（`quick-test:`/`full-test:`/`merge-gate:`）引用脚本与 `git switch` 默认分支名是否失效。
3. **docs/TDD.md 模块漂移**：比对 `docs/TDD.md` 与实际源码目录结构，报出未记录的新模块与已失效的旧路径。
4. **`.worktrees/` 陈旧工作树**：检出失效、未登记孤儿目录或分支已合并的可清理 worktree（只报告，不自动删除）。
5. **`.agents/skills/.pf-manifest.json` 完整性**：校验托管清单 JSON 结构、文件是否缺失以及 SHA256 是否漂移。
6. **仓库卫生**：扫描凭据文件/明文密钥形状、`> 1MB` 大文件与未纳入 `.gitignore` 的构建/输出目录。

## 执行与安全护栏

- **先看再改**：`--audit-only`、`--plan-only`、`reconcile` 与不带 `--apply-issues` 的 `--issues` 均为只读。
- **Issue 安全提交**：含非 ASCII 的 GitHub Issue 正文一律通过系统临时目录 UTF-8 文件配合 `--body-file` 提交并删除临时文件，绝不在命令行拼接正文。
- **不擅自删除**：发现陈旧 `.worktrees/` 时，必须先列出清单征询人类确认，清理前先解绑共享依赖链接再执行 `git worktree remove`。
- **闭环验证**：按 `--execute` 分批修复后，跑通 `AGENTS.md` 中的测试命令，再使用 `dev-review` 本地预审（`review-pack.mjs --local`）确认无误。
