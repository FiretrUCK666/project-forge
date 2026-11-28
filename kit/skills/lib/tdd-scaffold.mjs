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

import { FORM_INDEPENDENT_CORE, resolveDocRequirements } from './doc-requirements.mjs'
import { renderDocTemplate } from './doc-template-render.mjs'
import { appendCustomDocSections } from './doc-templates.mjs'
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

/** 形态判定里这一节是不是被打开了。勘察没给出结论时按「没开」处理。 */
function isShapeOn(facts, id) {
  return Array.isArray(facts?.tddShape?.enabled) && facts.tddShape.enabled.includes(id)
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

const LICENSE_HEADER_RE = /\b(?:licensed\s+to|spdx-license-identifier|apache\s+software\s+foundation|copyright|license|permission\s+is\s+hereby\s+granted)\b/i

/**
 * 从现有仓库根目录 Markdown 文档头部探测 HTML 注释形式的许可证声明（如 Apache ASF 头），
 * 跳过 `project-forge:` 受管标记，以便新建 `docs/TDD.md` 时自动继承。
 */
export function detectRepoLicenseHeader(repoRoot) {
  if (!repoRoot) return null
  for (const rel of ['SECURITY.md', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md']) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs)
    if (!text) continue
    const trimmed = text.replace(/^\s+/, '')
    const m = /^(<!--[\s\S]*?-->)/.exec(trimmed)
    if (!m) continue
    const comment = m[1]
    if (/<!--\s*project-forge:/i.test(comment)) continue
    if (LICENSE_HEADER_RE.test(comment)) return comment
  }
  return null
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

  // 能从文件清单里认出来的，就别留成「待补」——那些是事实，不是判断题。
  // kinds 已在上面取过：这里不再声明，避免重复定义
  const manifests = facts?.ecosystem?.manifests ?? []
  const hasFrontend = isShapeOn(facts, 'frontend')
  const hasData = isShapeOn(facts, 'data')

  const frameworkCell = manifests.length > 0
    ? `见 ${manifests.map((m) => `\`${m}\``).join('、')}`
    : '<待补：本仓没有可识别的依赖清单>'
  const structureCell = facts?.workspace?.declared
    ? `多包（${(facts.workspace.packages ?? []).length} 个）`
    : (kinds.length > 1 ? `多生态单体（${kinds.join('、')}）` : '单包 / 单体')
  const dataCell = hasData ? '<待补：清单里检出持久化痕迹，写清载体与版本>' : '无持久化'
  const dataHint = hasData ? '<连接方式与迁移位置>' : '本项目不涉及数据持久化'
  const frontendCell = hasFrontend ? '<待补：检出前端工程，写清框架与构建工具>' : '本项目无前端'

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

  // 章节结构交给模板，生成器只负责把事实算成取值。
  //
  // 这样模板一改，产物立刻跟着改——不会出现「模板 18 节、产物 7 节」这种漂移。
function formatBusinessFlowsBlock(facts, opts) {
  const bf = opts?.businessFlows ?? facts?.businessFlows
  if (!bf) {
    return '- 当前目录暂无业务流入口（核心源码就位后由 `repo-map.mjs` 只读补齐 `businessFlows` 映射）。'
  }
  if (typeof bf === 'string') return bf.trim() || '- 暂无业务流入口。'
  const lines = []
  if (Array.isArray(bf.audienceCues) && bf.audienceCues.length > 0) {
    lines.push(`- **服务对象线索**：${bf.audienceCues.join('；')}`)
  }
  if (Array.isArray(bf.flows) && bf.flows.length > 0) {
    for (const fl of bf.flows.slice(0, 10)) {
      lines.push(`- **${fl.surface ?? 'entry'}** \`${fl.name}\` -> \`${fl.entry}\``)
    }
  } else {
    const s = bf.surfaces ?? {}
    if (s.cli?.length) lines.push(`- **CLI 入口**：${s.cli.slice(0, 5).map((x) => `\`${x.file ?? x}\``).join('、')}`)
    if (s.routes?.length) lines.push(`- **接口/路由面**：${s.routes.slice(0, 5).map((x) => `\`${x}\``).join('、')}`)
    if (s.ui?.length) lines.push(`- **前端交互面**：${s.ui.slice(0, 5).map((x) => `\`${x}\``).join('、')}`)
    if (s.jobs?.length) lines.push(`- **作业与流水线面**：${s.jobs.slice(0, 5).map((x) => `\`${x}\``).join('、')}`)
  }
  if (Array.isArray(bf.docCodeGaps) && bf.docCodeGaps.length > 0) {
    lines.push(`- **文档与源码差异**：${bf.docCodeGaps.slice(0, 5).map((g) => g.detail ?? g.path).join('；')}`)
  }
  return lines.length > 0
    ? lines.join('\n')
    : '- 当前目录暂无业务流入口（核心源码就位后由 `repo-map.mjs` 只读补齐 `businessFlows` 映射）。'
}

function formatPreForgeBaselineBlock(facts, opts) {
  const base = opts?.preForgeBaseline ?? facts?.preForgeBaseline
  if (!base) {
    return '- **preForgeBaseline**：尚未采集（空白目录起步或未执行改前实跑；接入存量代码仓时须在 S1 -> S3 写前只读实跑既有测试与主入口后记录）。'
  }
  if (typeof base === 'string') return base.trim() || '- 已采集改前基线。'
  const lines = []
  if (base.ranAt || base.headSha) {
    lines.push(`- **采集时间 / HEAD**：${base.ranAt ?? '未记时间'}（\`${base.headSha ?? 'uncommitted'}\`）`)
  }
  if (base.summary) lines.push(`- **基线结论**：${base.summary}`)
  for (const item of base.commands ?? []) {
    const st = item.ok === true || item.exitCode === 0 ? 'PASS' : `EXIT ${item.exitCode ?? 'ERR'}`
    lines.push(`- \`${item.command}\` -> **${st}**${item.detail ? `（${item.detail}）` : ''}`)
  }
  for (const ep of base.entrypoints ?? []) {
    const st = ep.ok === true || ep.exitCode === 0 ? 'OK' : `EXIT ${ep.exitCode ?? 'ERR'}`
    lines.push(`- 入口 \`${ep.entry ?? ep.command}\` -> **${st}**${ep.detail ? `（${ep.detail}）` : ''}`)
  }
  return lines.length > 0 ? lines.join('\n') : '- 已采集改前基线。'
}

  const vars = {
    PROJECT_NAME: opts.projectName ?? facts?.target?.name ?? '项目',
    DOC_VERSION: opts.docVersion ?? '0.1.0',
    TODAY: opts.today ?? '',
    BASIS: `由 survey 现场读取清单与目录得出（${kinds.join('、') || '未识别生态'}）`,
    RUNTIME: runtimeLines.join(' / ') || '（待核查）',
    PLATFORM: facts?.git?.hasRemote ? String(facts.git.remoteUrl ?? '有远端') : '仅本地，无远端',
    MANIFESTS: frameworkCell,
    STRUCTURE: structureCell,
    DATA_CELL: dataCell,
    DATA_HINT: dataHint,
    FRONTEND_CELL: frontendCell,
    PLATFORM_NOTE: `${process.platform} 上已验证；其余平台待实测`,
    MODULE_ROWS: moduleRows.length > 0
      ? moduleRows.join('\n')
      : '| `<模块或目录>` | `<对外职责>` | `<依赖方向>` | `<入口文件>` |',
    QUICK_CMD: quick,
    POSITIONING: opts.positioning ?? '<一句话说明本系统解决的核心问题与服务对象>',
    NON_GOALS_LINES: opts.nonGoals ?? '  - <明确不承担的能力范围，防止后续需求越界>',
    BUSINESS_FLOWS_BLOCK: formatBusinessFlowsBlock(facts, opts),
    PRE_FORGE_BASELINE_BLOCK: formatPreForgeBaselineBlock(facts, opts),
  }

  const repoRoot = opts.repoRoot ?? root
  const docRequirements = repoRoot ? resolveDocRequirements(repoRoot, 'tdd') : null
  const immutableCore = new Set(FORM_INDEPENDENT_CORE.tdd ?? [])
  const baseDrops = opts.dropSections
    ?? (facts?.tddShape?.dropSections ? new Set(facts.tddShape.dropSections) : new Set())
  const dropSections = new Set(baseDrops)
  if (docRequirements) {
    const reqIds = new Set(docRequirements.sections.map((s) => s.id))
    for (const id of docRequirements.omit ?? []) {
      if (!immutableCore.has(id) && !reqIds.has(id)) dropSections.add(id)
    }
    for (const id of reqIds) dropSections.delete(id)
  }
  for (const id of immutableCore) dropSections.delete(id)

  const rendered = renderDocTemplate('tdd', {
    vars,
    dropSections: opts.noPrune ? new Set() : dropSections,
    pruneUnfilled: false,
  })
  if (rendered === null) {
    throw new Error('读不到 TDD 模板（kit/skills/templates/docs-tdd.md）——生成器不该在没有模板时继续')
  }
  const body = appendCustomDocSections(rendered, {
    repoRoot,
    kind: 'tdd',
    title: vars.PROJECT_NAME,
    safeSlug: 'tdd',
    taskId: 'tdd',
  })
  const licenseHeader = repoRoot ? detectRepoLicenseHeader(repoRoot) : null
  if (licenseHeader && !body.trimStart().startsWith(licenseHeader)) {
    return `${licenseHeader}\n\n${body.replace(/^\n+/, '')}`
  }
  return body
}
