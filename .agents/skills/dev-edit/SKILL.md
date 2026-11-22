---
name: dev-edit
description: |
  改码阶段边界校验与词法静态门禁：覆盖 Case 1-4、返工、测试修补与独立本地急改全量入口。
  改前核对 do-not-edit 禁改区与相邻模块复用，改后剥离注释/字面量精准拦截压制注释、履历墓碑、
  注释死代码、arch-rules 越界导入、单测反作弊与 >800 行文件膨胀，并按需联动目标仓原生配置。
  触发词：改代码、编辑门禁、改前检查、静态自检、edit-gate、检查压制注释、检查死代码、单测反作弊。
metadata:
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

## 八项词法与命名静态拦截规则

所有内容检查先经 `kit/skills/lib/static-gates-lexer.mjs` 剥离注释与字符串/正则字面量，分别在「纯代码视图」与「注释视图」求值，杜绝规则定义与字符串常量误报：

| 检查项 | 作用域 | 阻断判据 |
| --- | --- | --- |
| 禁改区保护 | 全部改动文件 | 命中 `AGENTS.md` `do-not-edit` 路径即硬阻断 |
| 过程工件文件名拦截 | 代码/测试/脚本文件名 | 拦截以 `issue<数字>`、`pr<数字>`、`stage<字母>`、`wave<数字>` 命名的长期源码/测试/脚本（文档目录 `docs/{prd,specs,todo,archive}/` 与常规业务词如 `local-issues`、`review-pr`、`v2/` 豁免） |
| 压制与借口标记 | 非夹具源码注释/属性 | 拦截无正当锚点（`pf-allow:` / `justification:`）或无关联追踪单号（`edit.hack-without-issue`）的 `HACK`、`WORKAROUND`、`TEMP`、`@ts-ignore`、`@ts-nocheck`、`eslint-disable`、`# type: ignore`、`# noqa`、`#[allow(` |
| 履历墓碑与死代码块 | 非夹具源码注释 | 拦截历史变更履历注释与连续 `>=4` 行（含 `>=3` 行代码特征）注释死代码块 |
| `arch-rules` 越界导入 | 纯代码视图 | 解析 JS/TS/Py/Go/Java/Kotlin/Rust 导入语句并对照 `AGENTS.md` `arch-rules` 阻断反向依赖 |
| 单测反作弊 | 非夹具测试文件 | 阻断零断言测试、`>=5` mock 且仅查调用次数的纯 Mock 自证、单测 `>=1000ms` 硬编码等待与非无头 UI 测试 |
| 文件膨胀控制 | 非测试非夹具源码 | `> 800` 行硬阻断；`730-800` 行输出紧文件拆分建议 |
| 注释路径与临时绕过校验 | 变更代码注释 | 拦截未绑定 `#<issue>` 单号的 `HACK`/`WORKAROUND`/`TEMP`（`edit.hack-without-issue`）及注释中不存在的反引号路径（`edit.broken-comment-path`） |

## 无预设工具运行时实证分级策略

静态门禁只守下限，改动运行态逻辑必须拿到真实运行证据（严禁以读代码冒充运行通过）：

1. **优先目标仓预设验证命令**：先跑 `AGENTS.md` `Dev Profile` 中的 `smoke-verify`、`quick-test`、`full-test` 或目标仓既有的集成/端到端测试命令。
2. **按项目形态动态复用环境真实能力**：目标仓未预设运行时工具时，按应用形态调用环境已有能力真启真测——CLI/库在临时隔离目录实跑命令并核验退出码与输出；Web/前端起本地服务并用可用无头浏览器或渲染工具检查真实交互、浅深色外观与控制台零报错；后端 API 起实例发真实请求并查状态回读；桌面/移动应用通过本机 GUI 驱动或模拟器验证核心主路径。
3. **仓外临时探针现写即跑（不脏仓树）**：缺少现成测试入口时，在仓外 `<gitCommonDir>/project-forge-verify/scratch/<taskId>/`（或系统临时目录）现写一次性探针脚本真实拉起被测代码采集证据，禁止污染仓库工作树，随收尾清理一并销毁。
4. **缺不可替代外部环境如实阻断**：确因缺少外部服务、专用硬件、桌面会话或凭证而无法真跑时，必须诚实报告缺口并阻断验收，绝不假绿放行。

## 可选原生校验联动（零外部硬绑定）

- 结合 `kit/skills/lib/profile-sniffer.mjs` 仅探测目标仓实际存在的原生配置（如 `eslint.config.*`、`tsconfig.json`、`ruff.toml`、`Cargo.toml`、`go.mod` 与 `package.json` 声明脚本）。
- 传 `--with-native` 时仅在目标仓已声明对应命令时按需调用；工具或配置不存在时安全跳过并记录，绝不要求全局安装第三方外部 linter 二进制。
- 支持 `--skip-edit-gate --reason "<原因>"` 显式记账写入 `signals.jsonl` 留痕；终检传 `--final` 时硬禁 `--skip-edit-gate`（`BLOCKED_SKIP_EDIT_GATE_FORBIDDEN_ON_FINAL`），且 `edit.do-not-edit` 恒为阻断项。

## 注释与架构决策记录边界

- **Why not What**：注释只写非显而易见的不变量、约束或边界原因（Why），不复述代码字面逻辑（What）；禁止履历墓碑与死代码块。
- **临时绕过必带单号**：`HACK`/`WORKAROUND`/`TEMP` 注释必须注明追踪单号（`#<issue>`，先走 `flow.mjs issue create` 或 `escalation.mjs` 建单）；变更中注释反引号路径须指向仓内真实文件（`edit.broken-comment-path`）。
- **架构决策落点**：跨模块或不可逆取舍写入 `docs/TDD.md` 或 `AGENTS.md ## 取舍`，不另建 `docs/adr/`。

## 标准命令流

```sh
# 1. 改前核对目标文件禁改区、紧文件预警与相邻复用符号
node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --mode pre-edit --files src/a.mjs,src/b.mjs --json

# 2. 改后执行词法静态门禁（flow verify 前置自动调用同契约）
node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --mode verify --changed --json

# 3. 独立本地急改或测试生成后校验（按需联动仓库已配置原生检查）
node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --mode standalone --changed [--with-native] --json
```
