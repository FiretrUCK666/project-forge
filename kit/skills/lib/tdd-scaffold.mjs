/**
 * tdd-scaffold.mjs —— 按仓库真实事实拼出一份「填好的」TDD，而不是一具空模板。
 *
 * ## 它和 `tdd-shape.mjs` 的分工
 *
 * - `tdd-shape`：判「该保留哪几节」；
 * - 这里：判出来之后，把**能从仓库里读到的部分直接填上**（技术栈、模块表、
 *   命令、部署方式），只把真正需要人判断的留成占位。
 *
 * 差别在于：给一个 Java + React 的仓生成 TDD，技术栈那节不该是
 * `<语言 + 版本下限>`，而该是 `Java 17 / Spring Boot`——那是从 `pom.xml` 读出来的
 * 事实，不是判断题。空模板逼着人把已知的东西再抄一遍，抄的过程还会抄错。
 *
 * ## 不猜的部分
 *
 * 「为什么不选另一个框架」「失败语义」「不变量」这些只能人写，这里一律留占位。
 * 宁可留空让人填，也不生成一段看着完整、实则猜的说明。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from './git.mjs'

/** 常见生态的运行时说明。读不出具体版本时只说语言，不编版本号。 */
const RUNTIME_LABEL = Object.freeze({
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  dotnet: '.NET',
  cpp: 'C/C++',
  dart: 'Dart',
  swift: 'Swift',
  elixir: 'Elixir',
  skill: '（技能包，无运行时依赖）',
  'docs-only': '（纯文档项目，无运行时）',
})

/** 从清单文件里读一个版本下限。读不到返回 null——不编。 */
function readVersionPin(root, kind) {
  const tryRead = (rel) => {
    if (!existsSync(join(root, rel))) return null
    return readTextSafe(join(root, rel))
  }
  try {
    if (kind === 'node') {
      const pkg = tryRead('package.json')
      if (!pkg) return null
      const data = JSON.parse(pkg)
      const engines = data?.engines?.node
      return typeof engines === 'string' ? `Node ${engines}` : null
    }
    if (kind === 'python') {
      const py = tryRead('pyproject.toml')
      const m = py && /requires-python\s*=\s*["']([^"']+)["']/.exec(py)
      if (m) return `Python ${m[1]}`
      const rt = tryRead('runtime.txt')
      if (rt && rt.trim()) return `Python ${rt.trim()}`
      return null
    }
    if (kind === 'java') {
      const pom = tryRead('pom.xml')
      const m = pom && /<(?:maven\.compiler\.(?:source|release)|java\.version)>([^<]+)</.exec(pom)
      return m ? `Java ${m[1]}` : null
    }
    if (kind === 'go') {
      const mod = tryRead('go.mod')
      const m = mod && /^go\s+([\d.]+)$/m.exec(mod)
      return m ? `Go ${m[1]}` : null
    }
    if (kind === 'rust') {
      const cargo = tryRead('Cargo.toml')
      const m = cargo && /rust-version\s*=\s*["']([^"']+)["']/.exec(cargo)
      return m ? `Rust ${m[1]}` : null
    }
  } catch { /* 清单读坏了就当没有，不抛 */ }
  return null
}

/** 顶层目录 -> 职责。只看名字，用于给模块表起一个不空洞的开头。 */
const DIR_ROLE = Object.freeze([
  [/^(?:src|lib|app|pkg|internal|core)$/i, '核心源码'],
  [/^(?:test|tests|spec|__tests__|test-case|e2e)$/i, '测试与断言'],
  [/^(?:scripts?|tools?|bin|cmd|gen-[a-z-]+)$/i, '工具与生成脚本'],
  [/^(?:docs?|documentation)$/i, '文档'],
  [/^(?:deploy|deployment|k8s|helm|infra|ops)$/i, '部署与环境'],
  [/^(?:migrations?|schema|db|database)$/i, '数据模型与迁移'],
  [/^(?:web|frontend|ui|client)$/i, '前端与交互层'],
  [/^(?:api|server|backend|service)$/i, '对外接口与服务'],
  [/^(?:assets?|static|public)$/i, '静态资源'],
  [/^(?:contracts?|proto|openapi)$/i, '接口契约'],
])

/**
 * 目录名后缀也能判断层：`xxx-be` 是后端、`xxx-fe` 是前端、`xxx-svc` 是服务。
 * 这类命名在单体拆多服务的仓里很常见，光看首段认不出来。
 */
const DIR_SUFFIX_ROLE = Object.freeze([
  [/-be$|-backend$|-server$|-api$/i, '后端服务'],
  [/-fe$|-frontend$|-web$|-ui$/i, '前端应用'],
  [/-svc$|-service$/i, '独立服务'],
  [/-lib$|-sdk$|-common$|-shared$/i, '共享库'],
  [/-cli$|-tool$/i, '命令行工具'],
])

/** 这些不是这个项目的业务模块，列进模块表只会误导人。 */
const NOT_A_MODULE = /^(?:\.|node_modules$|dist$|build$|target$|coverage$|vendor$|__pycache__$)/

/**
 * 在一个目录里找最常见的入口文件。
 *
 * 只认几种放之四海皆准的命名（index / main / mod / __init__），找到就写出来——
 * 「入口文件：待补」和「入口文件：src/index.mjs」对读者的差别是能不能直接点进去。
 */
/**
 * 在一个目录下找最像入口的那个文件。
 *
 * 判断顺序：先按公认的入口文件名（index / main / mod / __init__），
 * 再按「布局约定」（Java 的 Application、Python 的 `__main__`、前端的 index.html）。
 * 都找不到就返回 null，界面上显示「（待补入口文件）」而不是瞎指一个。
 */
/** 只认可执行源码。配置文件叫 `index.yml` 也不是入口。 */
const CODE_EXT = '(?:mjs|js|cjs|ts|tsx|jsx|py|go|rs|java|kt|rb|php|cs|swift|dart|ex|exs|c|cpp|h|hpp|vue|svelte|html)'
const ENTRY_NAME_RE = new RegExp(`(?:^|/)(?:index|main|mod|__init__|__main__)\\.${CODE_EXT}$`, 'i')
const ENTRY_LAYOUT_RE = new RegExp(`(?:Application|Startup|Bootstrap|Program)\\.${CODE_EXT}$|(?:^|/)index\\.html$`, 'i')

/** 这些子路径下的文件不是模块入口：它们属于文档、样例、压测或固件。 */
const NOT_ENTRY_PATH = /\/(?:docs?|receipts?|examples?|samples?|fixtures?|bench(?:mark)?s?|perf|sit|tests?|__tests__|e2e)\//i

function pickEntryFile(dir, allPaths) {
  const prefix = `${dir}/`
  const under = allPaths
    .filter((f) => f.startsWith(prefix) && !NOT_ENTRY_PATH.test(f.slice(prefix.length - 1)))
    // 越浅越可能是入口：`src/index.mjs` 是入口，`src/utils/x/main.mjs` 不是。
    .sort((a, b) => a.split('/').length - b.split('/').length)
  if (under.length === 0) return null
  const byName = under.find((f) => ENTRY_NAME_RE.test(f))
  if (byName) return byName
  const byLayout = under.find((f) => ENTRY_LAYOUT_RE.test(f))
  if (byLayout) return byLayout
  return null
}

function roleOfDir(name) {
  for (const [re, role] of DIR_ROLE) if (re.test(name)) return role
  for (const [re, role] of DIR_SUFFIX_ROLE) if (re.test(name)) return role
  return null
}

/** 判断某个顶层目录该不该进模块表。 */
function isProjectModule(name) {
  if (!name || NOT_A_MODULE.test(name)) return false
  return true
}

/**
 * 拼一份预填 TDD。
 *
 * @param {object} facts `survey` 的事实对象
 * @param {{projectName?: string, today?: string, dropSections?: Set<string>}} opts
 * @returns {string}
 */
export function buildPreFilledTdd(facts, opts = {}) {
  const root = facts?.target?.path ?? facts?.target?.root ?? null
  const allPaths = Array.isArray(opts.allPaths)
    ? opts.allPaths
    : (Array.isArray(facts?.tddShape?.filePaths) ? facts.tddShape.filePaths : [])
  const kinds = facts?.ecosystem?.kinds ?? []
  const runtimeLines = []

  if (Array.isArray(facts?.artifacts?.runtimeRequirements) && facts.artifacts.runtimeRequirements.length > 0) {
    runtimeLines.push(...facts.artifacts.runtimeRequirements)
  } else {
    for (const k of kinds) {
      if (k === 'skill' || k === 'docs-only') continue
      const pin = root ? readVersionPin(root, k) : null
      runtimeLines.push(pin ?? `${RUNTIME_LABEL[k] ?? k}（版本下限待从清单核实）`)
    }
  }

  const topDirs = Array.isArray(facts?.reentry?.unregisteredTopDirs)
    ? facts.reentry.unregisteredTopDirs
    : []
  const scannedDirs = [
    ...new Set([
      ...topDirs,
      ...(Array.isArray(facts?.navigation?.topDirs) ? facts.navigation.topDirs : []),
    ]),
  ].filter((d) => d && !d.startsWith('.'))
  void scannedDirs

  const commands = facts?.commands ?? {}
  const quick = commands.test || commands.verify || '（项目尚未登记测试命令）'

  const moduleRows = (Array.isArray(opts.topLevelDirs) ? opts.topLevelDirs : [])
    .filter(isProjectModule)
    // 认得出职责的排前面：一堆「职责待补」挡在开头，读的人第一眼就放弃了。
    .sort((a, b) => Number(Boolean(roleOfDir(b))) - Number(Boolean(roleOfDir(a))))
    .slice(0, 12)
    .map((d) => {
      const role = roleOfDir(d) ?? '（职责待补：写清它对外提供的唯一职责）'
      const entry = pickEntryFile(d, allPaths)
      return `| \`${d}/\` | ${role} | （待补依赖方向） | ${entry ? `\`${entry}\`` : '（待补入口文件）'} |`
    })

  return [
    `# ${opts.projectName ?? facts?.target?.name ?? '项目'} — 技术设计与架构契约（TDD）`,
    '',
    '## 文档信息',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    '| 文档版本 | `0.1.0` |',
    `| 编制 / 最近更新日期 | \`${opts.today ?? ''}\` / \`${opts.today ?? ''}\` |`,
    `| 基线依据 | 由 \`survey\` 现场读取清单与目录得出（${kinds.join('、') || '未识别生态'}） |`,
    `| 运行环境与生态栈 | ${runtimeLines.join('；') || '（待核实）'} |`,
    `| 托管平台适配范围 | ${facts?.git?.hasRemote ? String(facts.git.remoteUrl ?? 'GitHub') : '仅本地，无远端'} |`,
    '| 关联工程契约 | `AGENTS.md` |',
    '',
    '## 目录',
    '',
    '<!-- 章节增删后必须同步，锚点对不上等于没有目录 -->',
    '',
    '## 背景、非目标与术语表',
    '',
    '- **核心定位**：<一句话说明本系统解决的核心问题与服务对象>',
    '- **架构目标与关键取舍**：<例如性能、可靠性、零依赖、向后兼容或安全隔离边界>',
    '- **明确非目标（Non-Goals）**：',
    '  - <明确不承担的能力范围 1>',
    '',
    '### 术语表',
    '',
    '| 术语 | 系统内定义 | 代码或配置中的对应载体 |',
    '| --- | --- | --- |',
    '| <领域术语 1> | <语义界定> | <对应类型、目录或配置字段> |',
    '',
    '## 技术栈选型',
    '',
    '> 取值以清单文件与部署目录为准；这里已按勘察结果预填，未核实处保留占位。',
    '',
    '| 层级 | 本项目采用 | 说明 |',
    '| --- | --- | --- |',
    `| 运行时与最低版本 | ${runtimeLines.join(' / ') || '<待核实>'} | 从清单文件读出 |`,
    `| 核心框架 | <待补：读 ${(facts?.ecosystem?.manifests ?? []).join('、') || '清单'} 得出> | <为什么选它> |`,
    `| 工程结构 | ${facts?.workspace?.declared ? `多包（${(facts.workspace.packages ?? []).length} 个）` : '单包 / 单体'} | <源码与产物位置> |`,
    `| 数据与状态 | <待补：有持久化就写载体与版本> | ${(facts?.ecosystem?.kinds ?? []).includes('docs-only') ? '纯文档项目无持久化' : '<连接方式>'} |`,
    '| 关键第三方依赖 | <只列会约束架构的> | <版本边界与许可约束> |',
    '| 前端与 UI | <有前端就写框架与构建工具，没有就写「本项目无前端」> | <构建产物目录> |',
    '',
    `- **跨平台兼容范围**：<${process.platform} 上已验证；其余平台待实测>`,
    '- **变更前提**：上移版本下限或换框架时，须同步更新 README 与 CI',
    '',
    '## 系统架构全景',
    '',
    '```mermaid',
    'flowchart TB',
    '  In["入口层"] --> Core["核心编排层"]',
    '  Core --> Adapter["适配与存储"]',
    '```',
    '',
    '### 模块与目录职责',
    '',
    '| 模块 / 目录 | 核心职责 | 允许依赖 / 禁止反向引用 | 核心入口文件 |',
    '| --- | --- | --- | --- |',
    ...(moduleRows.length > 0 ? moduleRows : ['| `<模块或目录>` | <对外职责> | <依赖方向> | <入口文件> |']),
    '',
    '### 分层禁引规则（arch-rules）',
    '',
    '```yaml',
    'arch-rules: <fromGlob> -> <toGlob>',
    '```',
    '',
    '### 功能与入口地图（Feature Map）',
    '',
    '| 功能 / 能力域 | 源码入口（文件与关键符号） | 本地验证命令 |',
    '| --- | --- | --- |',
    `| <核心能力 1> | <入口文件路径> | \`${quick}\` |`,
    '',
    '## 核心流程与状态流转',
    '',
    '- **正常主链路**：<核心数据流与关键状态迁移条件>',
    '- **失败与回退语义**：<校验失败或外部超时时如何保障状态可恢复>',
    '- **并发与幂等约定**：<重复执行或并发写入时的锁与幂等键>',
    '',
    '## 核心不变量与安全红线',
    '',
    '1. **数据与状态一致性**：<不能破坏的单一真相源与原子写入>',
    '2. **权限与访问边界**：<鉴权最小权限与凭据防泄露>',
    '3. **输入与外部边界**：<不可信输入校验与命令注入防护>',
    '4. **高风险路径同步约定**：修改 <核心协议或权限边界> 时须同步校准本文与测试',
    '',
  ].join('\n')
}
