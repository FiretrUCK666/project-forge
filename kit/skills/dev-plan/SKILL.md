---
name: dev-plan
description: |
  需求分流、编写与维护四层工程文档（TDD、PRD、SPEC、Todo）及冻结可判定验收标准。
  触发词：需求规划、写方案、写设计文档、写 PRD、写 SPEC、写 Todo、拆任务、
  需求分流、立项、先出方案、plan feature、write spec、triage task。
---

# dev-plan：五档分流与四层文档规划

将需求按变更风险精准分流，只在必要时落盘对应文档，禁止为空想或琐碎改动制造文档噪音。

## 五档分流规则（先跑脚本判定，不靠感觉）

| 档位 | 适用情形 | 文档产物 | 硬门禁 |
| --- | --- | --- | --- |
| **Case 1** | 纯文档 / 问答 / 错别字 | 0 文档 | 无 |
| **Case 2** | 明确局部 bugfix，不改契约 | 0 文档 | 强制先写失败回归测试再修绿（Red-Green） |
| **Case 3** | 局部功能（L2），不改外部契约 | 只建 `docs/todo/` | 冻结 `C1..Cn`，提交 PR 前归档 |
| **Case 4** | 跨模块 / 改外部契约（L3） | `docs/specs/` + `docs/todo/` | SPEC 需确认 `approved` 后再写实现 |
| **Case 5** | 与 `docs/TDD.md` 或生效 `SPEC` 冲突 | 阻断规划 | 必须先更新 `docs/TDD.md` 并获批准 |

说明：仅当产品目标或用户流程尚不清晰时，才额外创建 `docs/prd/`。若当前仓库属于外部开源仓的贡献者 Fork 且上游未接入 `docs/`，本地规划草案不可混入 PR diff。

## 标准命令流

### 1. 分流判定

```sh
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>" [--files <数量>] [--touches-contract] [--conflicts-tdd]
```

### 2. 初始化规划文档

```sh
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --type <prd|spec|todo> --slug "<kebab-slug>" --title "<中文或英文标题>" [--task "<taskId>"]
```

- 每条验收标准必须写为 `- [ ] C1: <可被一条命令或断言判定的条件>`。
- `Todo` 头部自动记录 `Planned at: <HEAD SHA>`，用于后续核对代码漂移。

### 3. 确认 SPEC 生效（仅 Case 4 需要）

AI 只起草 `Status: draft` 的规格文档；经人类维护者拍板后切换为 `approved`：

```sh
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "docs/specs/<YYMMDD-slug>.md"
```

### 4. 查看全局文档状态（零手写索引表）

```sh
node ".agents/skills/dev-plan/scripts/doc-plan.mjs" list
```

所有列表由脚本实时扫描目录文件头生成，严禁手工维护容易引发合并冲突的全局索引文件。
