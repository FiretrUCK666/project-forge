---
name: dev-edit
description: |
  改码阶段边界校验与词法静态门禁：覆盖 Case 1-4、返工、测试修补与独立本地急改全量入口。
  改前核对 do-not-edit 禁改区与相邻模块复用，改后剥离注释/字面量精准拦截压制注释、履历墓碑、
  注释死代码、arch-rules 越界导入、单测反作弊与 >800 行文件膨胀，并按需联动目标仓原生配置。
  触发词：改代码、编辑门禁、改前检查、静态自检、edit-gate、检查压制注释、检查死代码、单测反作弊。
metadata:
  tier: both
  intent: 改码规范 / 改前边界核对与静态自检
  script: node .agents/skills/dev-edit/scripts/edit-gate.mjs --changed --json
  order: 33
  fallback: 改前核对 do-not-edit 与相邻复用，改后手动运行项目静态检查与单元测试（未装配 dev-edit 技能）
---

# dev-edit：改码边界、复用前导与词法静态门禁

本技能覆盖仓库内**全部改码入口**（`Case 1-4`、`rework` 返工、测试补修与脱离 `dev-flow` 的独立急改），在代码提交与 `flow.mjs verify` 前把确定性静态缺陷挡在源头，绝不取代 `dev-review` 独立双门实证。

## 改前与改后三件事

1. **改前核对禁改边界（`--mode pre-edit`）**：确认待修改路径未落入 `AGENTS.md` `do-not-edit` 列表，标出 `high-risk` 路径与已处于 `730-800` 行紧文件区的目标文件。
2. **改前查相邻复用**：扫描同目录及共享层导出符号，优先合入既有主干与共享原语，不复制粘贴双轨逻辑。
3. **改后立即执行门禁（`--mode verify` / `standalone`）**：对本次改动文件执行词法去噪扫描，零阻塞项后进入 `flow.mjs verify` 与提审。

## 六项词法静态拦截规则

所有检查先经 `kit/skills/lib/static-gates-lexer.mjs` 剥离注释与字符串/正则字面量，分别在「纯代码视图」与「注释视图」求值，杜绝规则定义与字符串常量误报：

| 检查项 | 作用域 | 阻断判据 |
| --- | --- | --- |
| 禁改区保护 | 全部改动文件 | 命中 `AGENTS.md` `do-not-edit` 路径即硬阻断 |
| 压制与借口标记 | 非夹具源码注释/属性 | 拦截无正当锚点（`pf-allow:` / `justification:`）的 `HACK`、`WORKAROUND`、`TEMP`、`@ts-ignore`、`@ts-nocheck`、`eslint-disable`、`# type: ignore`、`# noqa`、`#[allow(` |
| 履历墓碑与死代码块 | 非夹具源码注释 | 拦截历史变更履历注释与连续 `>=4` 行（含 `>=3` 行代码特征）注释死代码块 |
| `arch-rules` 越界导入 | 纯代码视图 | 解析 JS/TS/Py/Go/Java/Kotlin/Rust 导入语句并对照 `AGENTS.md` `arch-rules` 阻断反向依赖 |
| 单测反作弊 | 非夹具测试文件 | 阻断零断言测试、`>=5` mock 且仅查调用次数的纯 Mock 自证、单测 `>=1000ms` 硬编码等待与非无头 UI 测试 |
| 文件膨胀控制 | 非测试非夹具源码 | `> 800` 行硬阻断；`730-800` 行输出紧文件拆分建议 |

## 可选原生校验联动（零外部硬绑定）

- 结合 `kit/skills/lib/profile-sniffer.mjs` 仅探测目标仓实际存在的原生配置（如 `eslint.config.*`、`tsconfig.json`、`ruff.toml`、`Cargo.toml`、`go.mod` 与 `package.json` 声明脚本）。
- 传 `--with-native` 时仅在目标仓已声明对应命令时按需调用；工具或配置不存在时安全跳过并记录，绝不要求全局安装第三方外部 linter 二进制。
- 支持 `--skip-edit-gate --reason "<原因>"` 显式记账写入 `signals.jsonl` 留痕；最终合入前门禁仍须通过完整校验。

## 标准命令流

```sh
# 1. 改前核对目标文件禁改区、紧文件预警与相邻复用符号
node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --mode pre-edit --files src/a.mjs,src/b.mjs --json

# 2. 改后执行词法静态门禁（flow verify 前置自动调用同契约）
node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --mode verify --changed --json

# 3. 独立本地急改或测试生成后校验（按需联动仓库已配置原生检查）
node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --mode standalone --changed [--with-native] --json
```
