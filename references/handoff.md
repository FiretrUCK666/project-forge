# 交棒、自净化与状态校验

## 何时读本文件

当项目治理配置完毕准备交还维护者日常开发、或需要退场验证、清理受管标记与临时产物、以及重入升级 `.agents/skills/` 套装时读完本文件。

## 一、交棒 vs 撤销（两件完全不同的事）

- **交棒**留下这个项目长出来的真能力：`AGENTS.md`（带意图路由与 Dev Profile）、`docs/` 四层文档、`.agents/skills/` 本地研发技能套装、`.gitignore`/`.gitattributes` 与 GitHub 工作流模板——仅剥掉一次性托管标记并清除未收尾的临时产物。
- **绝不做成「撤销」**：不要把刚替项目配好的 `AGENTS.md`、`.agents/skills/` 或门禁脚本一并删光，让项目回到未治理前。

## 二、四档退出码与验证命令

执行以下命令确认当前工程是否仍有未收口的临时引导标记或残留临时文件：

```sh
node "<本 skill 目录>/scripts/handoff.mjs" <目标目录> [--verify]
```

**四档退出码**语义（调用方必须按码分流，绝不把 `3` 误看成 `0`）：

- `0`：干净——无未清理引导标记、无损坏标记、无遗留临时文件；
- `1`：仍需处理——尚存引导占位、损坏受管标记或待收口临时残留；
- `3`：扫描发生截断——目录过深、文件超限或异常导致未扫完，**严禁当作通过**；
- `4`：不适用——当前项目并未留下引导标记，无需清理动作。

## 三、托管 Skill 套装升级与退役自净化

日常研发流技能套装由 `equip.mjs` 从本工具 `kit/skills/` 装配至 `<目标目录>/.agents/skills/`，并通过 `.agents/skills/.pf-manifest.json`（记录 `files` 与 `agentsRegions` 的 SHA256 基线）实现幂等与跨月重入安全升级：

| 本地文件现场状态 | `equip.mjs` 执行动作 | 安全边界 |
| --- | --- | --- |
| 目标文件尚不存在 | 复制写入并登记新 SHA256 | 全套研发技能默认完整装齐（含 `local-only`），不阉割局部能力 |
| 当前哈希 === 旧 manifest 哈希 | 无损升级为新版（同哈希跳过保幂等） | 不打扰正常使用 |
| 当前哈希 !== 旧 manifest 哈希 | **100% 保留用户改过的本地版本不覆盖** | 报告冲突供人手动合并或决定 |
| 新版已移除的退役托管文件 | 当前哈希未改 -> **自动物理删除并移出 manifest（自净化）**；用户改过 -> 保留并标 `orphaned-modified` | 绝不误删用户手改资产 |
| 用户自建的 `.agents/skills/<custom>/` | **永远不碰、不扫进清理名单** | 严守边界，不侵占项目私有扩展 |

注：`equip.mjs` 与 `compose-agents.mjs` 在修改已有非空文件前均动态通过 `scripts/backup.mjs` 在仓外（`<gitCommonDir>/project-forge-backups/`、`PF_BACKUP_DIR` 或 `~/.project-forge/backups/`）保留最多 5 份 `.tar.gz` 快照（`--no-backup` 可跳过，零变动时不冗余备份，可用 `backup.mjs restore` 回滚且零污染工作区）。`compose-agents.mjs` 同样核对 `.pf-manifest.json` 的 `agentsRegions` 基线，未加 `customized` 但被手改过的受管区间自动保护跳过。

## 四、交棒前四步清单

1. **契约、装配与治理自检**：确认 `compose-agents.mjs <项目> --check`、`equip.mjs <项目> --check`、`review.mjs <项目>` 与按需 `govern-audit.mjs`（含 `cluster` / `sample` 规则下沉抽检与死链/注释扫描）均达标，且 `AGENTS.md <= 30KB`；
2. **清理临时标记（可选）**：若不再保留 `AGENTS.md` 上的受管引导注释，跑 `compose-agents.mjs <项目> --clean`（写前先经 `backup.mjs` 快照，只剥标记行、正文一字不动）；
3. **验证无残留**：跑 `handoff.mjs <项目> --verify` 确认退出码为 `0` 或 `4`（仓外备份目录 `.git/project-forge-backups/` 不触发痕迹误报）；
4. **遗留工作树提示**：若 `.worktrees/` 下仍有已合任务的残留目录，**按 `merged` / `squash_or_rebase_merged` / `no_own_commits` / `unmerged` 四态列出清单并请人确认后通过 `flow.mjs cleanup --confirm` 先解绑共享依赖再卸除**，绝不擅自硬删。
