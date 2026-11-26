# 改动提案

## 变更摘要

<!-- 一句话说清：解决了什么问题、改动范围与影响模块。 -->

## 关联 Issue 与文档

<!-- 关闭写 Fixes #N，仅关联写 refs #N；Case 3/4 填关联 SPEC/Todo 归档路径。 -->

## 改动理由

<!-- 说明为什么这样改（而非只复述现象）。 -->

## 验证证据

| 验证项 | 结果 | 耗时 | 退出码 |
| --- | --- | --- | --- |
| `merge-gate` | `PASS` | `-` | `0` |

<!-- 附运行时/E2E 观察与导出包验收摘要。 -->

## 影响面、风险与回滚方式

- **门型与风险**：`two-way` / `one-way`，标注是否触及 `AGENTS.md` 高风险路径（`scripts/lib/`、`preflight.mjs`、`templates/`、`kit/`、`SKILL.md`、`AGENTS.md`、`.github/workflows/`、`.gitattributes`）。
- **回滚方式**：`git revert <merge-commit>` 并重跑 `merge-gate`（不强推、不改写已推送历史）。

## 合并授权

独立审查 `fail` 为空时由**审查者直接合**（碰高风险路径须独立上下文加故障注入）；`contributor-fork` 禁止自合，由上游维护者/独立审查合入；若 `AGENTS.md`「## 取舍」设 `merge-authority: human`，仅出具通过结论交人类合入；**弱化门禁必须人点头**；发版、改可见性与改写历史永不自动。

## 独立审查与故障注入

<!-- 独立审查记录由审查者在独立 PR 评论中出具（正文不留占位），每轮评论固定包含以下三字段（触发停损时附止损记录）： -->
逐条标准状态、故障注入记录、实证核验（触发停损时附止损记录；详见独立审查评论）。

## 自查

- [ ] 门禁全绿且与 `AGENTS.md`「环境与构建验证」一致
- [ ] 没有弱化任何门禁或跳过测试
- [ ] 用户可见行为或命令变更已成对同步 `README.md` / `README.en.md` 与 `docs/TDD.md` / `AGENTS.md`
- [ ] 新增勘察/门禁判定已补正反双向夹具（`scripts/dev/fixtures*.mjs`）并登记 `gap-coverage.mjs`
- [ ] 无硬编码本机路径、凭据或 emoji，关联 `PRD`/`SPEC`/`Todo` 已于合并前成对归档
