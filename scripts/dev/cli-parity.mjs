/**
 * cli-parity.mjs —— 参数注册表、帮助文本、读取点三重对拍。
 *
 * 一个参数要活下来得有三样东西：**注册**（解析器认它）、**声明**（帮助里看得到）、
 * **读取**（真有人用）。三样缺一样就是三种不同的问题：
 *
 * - 帮助里有、注册表里没有 → 用户照着敲会被拒，上线即踩坑；
 * - 注册了、没人读 → 参数是死的：看着能用，其实什么也不做，比没有更糟；
 * - 注册了、帮助里没有 → 参数是暗的：用户不知道它能用，而门禁也看不见它。
 *
 * 第三条这一片不去批量补文档（补出来的说明书会立刻过时），而是**按名字锁住现状**：
 * 已知的暗参数逐条登记，新出现的暗参数一律失败。存量是债，可以还；新增不许。
 *
 * 判据只在「定义位置」上成立。帮助文本里满是句中提及的别的脚本的参数
 * （`--body-file`、`--ignore-scripts`、`--case`），把它们当声明会让反向差集失真。
 * 所以声明只认两种形态：**行首的 `--xxx`**，与**方括号分组里的 `--xxx`**。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule } from '../../kit/skills/lib/git-core.mjs'
import { SUBCOMMAND_META } from '../../kit/skills/lib/subcommand-meta.mjs'

/** 由 `parseStandardCli` 在各入口统一注入、因此不必各自声明的全局参数。 */
export const GLOBAL_FLAGS = Object.freeze(['help', 'json', 'dir', 'repo'])

/** 统一解析器注入全局参数的唯一位置。白名单按注册来源判定，不在各脚本里写例外。 */
export const GLOBAL_FLAG_SOURCE = 'kit/skills/lib/cli.mjs'

/**
 * 走统一解析器的全部 CLI 入口。
 *
 * `scope` 是读取点的搜索范围：参数常在入口注册、在同技能的处理模块或共享库里消费。
 * 不把库纳入搜索，「入口注册、库读取」这类活参数会被判死，然后逼人加豁免。
 */
export const ENTRY_SPECS = Object.freeze([
  { label: '流程入口', file: 'kit/skills/dev-flow/scripts/flow.mjs', scope: 'kit/skills/dev-flow/scripts' },
  { label: '规划入口', file: 'kit/skills/dev-plan/scripts/doc-plan.mjs', scope: 'kit/skills/dev-plan/scripts' },
  { label: '治理入口', file: 'kit/skills/dev-govern/scripts/govern-audit.mjs', scope: 'kit/skills/dev-govern/scripts' },
  { label: '审查入口', file: 'kit/skills/dev-review/scripts/review-pack.mjs', scope: 'kit/skills/dev-review/scripts' },
  { label: '改码入口', file: 'kit/skills/dev-edit/scripts/edit-gate.mjs', scope: 'kit/skills/dev-edit/scripts' },
  { label: '定位入口', file: 'kit/skills/dev-explore/scripts/doc-locate.mjs', scope: 'kit/skills/dev-explore/scripts' },
  { label: '地图入口', file: 'kit/skills/dev-explore/scripts/repo-map.mjs', scope: 'kit/skills/dev-explore/scripts' },
  { label: '分诊入口', file: 'kit/skills/dev-flow/scripts/flow-intake.mjs', scope: 'kit/skills/dev-flow/scripts' },
  { label: '依赖入口', file: 'kit/skills/dev-flow/scripts/worktree-deps.mjs', scope: 'kit/skills/dev-flow/scripts' },
  { label: '复盘入口', file: 'kit/skills/dev-govern/scripts/govern-retro.mjs', scope: 'kit/skills/dev-govern/scripts' },
  { label: '迭代入口', file: 'kit/skills/dev-iterate/scripts/iterate.mjs', scope: 'kit/skills/dev-iterate/scripts' },
  { label: '工具入口', file: 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs', scope: 'kit/skills/dev-verify-tools/scripts' },
])

/**
 * 已登记在册的暗参数（注册了、帮助里没有声明位置）。
 *
 * 逐条按名字登记，不按数量：数量锁不住「换了一个同名参数」，而名字能。
 * 这份清单只允许变短——补上帮助、或删掉参数，都让对应条目消失；
 * 变长说明又悄悄多了一个用户看不见的参数，那正是这一片要挡的事。
 */
export const DARK_BASELINE = Object.freeze({
  '流程入口': Object.freeze([
    'action', 'branch', 'comment', 'due-on', 'fork-url', 'human-approved-exec',
    'issues', 'pr-ref', 'run-govern-hook', 'strict-lifecycle',
  ]),
  '规划入口': Object.freeze([
    // approve 是被拒的旧入口参数：它现在带 --approve 会得到 BLOCKED_APPROVAL_HAS_SINGLE_ENTRY，
    // 把它写进帮助等于教人用一个必然报错的开关，所以它留在暗参数里而不是补文档。
    'approve', 'decision', 'finding', 'force', 'human-approved', 'implemented', 'kind',
    'reason', 'slug', 'title', 'type',
  ]),
  '治理入口': Object.freeze([
    'apply-patches', 'audit-only', 'escalate', 'issues', 'message', 'note', 'plan-only',
    'reconcile', 'rule', 'title',
  ]),
  '审查入口': Object.freeze([
    'agent', 'criteria-status', 'escalate', 'external-pr', 'issue', 'review-token', 'reviewer-id', 'verdict',
  ]),
  '改码入口': Object.freeze([]),
  '定位入口': Object.freeze([]),
  '地图入口': Object.freeze([]),
  '分诊入口': Object.freeze([]),
  '依赖入口': Object.freeze([]),
  '复盘入口': Object.freeze([]),
  '迭代入口': Object.freeze([]),
  '工具入口': Object.freeze([]),
})

/**
 * 不走统一解析器、但仍须纳入同一检查的入口。
 *
 * 不给它开豁免：让它游离在检查之外，等于承认「自己写解析器」可以成为绕过对拍的办法。
 * `declared` 是它手工维护的最小声明表，`registered` 是它手工维护的注册表，
 * 两者与真实解析分支必须一一对应——`main()` 里新增一个分支而不改这里，对拍就会失败。
 */
export const HAND_ROLLED_SPECS = Object.freeze([
  { label: '交棒入口', file: 'scripts/handoff.mjs', registered: ['help', 'scan', 'verify', 'strict-clean', 'json'], declared: ['help', 'scan', 'verify', 'strict-clean', 'json'] },
])

/** 括号配对：从 `open` 指向的字符开始，返回与之配对的闭括号下标；配不上返回 -1。 */
function matchBracket(text, open) {
  const pairs = { '[': ']', '{': '}', '(': ')' }
  const o = text[open]
  const c = pairs[o]
  if (!c) return -1
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === o) depth += 1
    else if (ch === c) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 取出数组字面量里的一级字符串元素（不递归进嵌套数组）。 */
function stringItemsOfArray(arrayText) {
  const inner = arrayText.slice(1, -1)
  const out = []
  let quote = null
  let buf = ''
  let depth = 0
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\') { buf += inner[i + 1] ?? ''; i += 1; continue }
      if (ch === quote) { quote = null; if (depth === 0 && buf) out.push(buf); buf = ''; continue }
      buf += ch
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; buf = ''; continue }
    if ('[{(]'.includes(ch)) depth += 1
    else if (']})'.includes(ch)) depth -= 1
  }
  return out
}

/** 从 `key: [` 处截出数组字面量文本并解析出元素；找不到返回空数组。 */
function arrayField(schemaText, key) {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\[`)
  const m = re.exec(schemaText)
  if (!m) return []
  const open = m.index + m[0].length - 1
  const close = matchBracket(schemaText, open)
  if (close < 0) return []
  return stringItemsOfArray(schemaText.slice(open, close + 1))
}

/** 解析 `parseStandardCli(argv, {...})` 的 schema：注册了哪些参数、别名指向哪。 */
export function extractRegistered(text) {
  const m = /\bparseStandardCli\(\s*\w+\s*,\s*\{/.exec(text)
  if (!m) return { found: false, flags: [], aliases: {} }
  const open = m.index + m[0].length - 1
  const close = matchBracket(text, open)
  if (close < 0) return { found: false, flags: [], aliases: {} }
  const schemaText = text.slice(open, close + 1)
  const flags = [...new Set([
    ...arrayField(schemaText, 'booleanFlags'),
    ...arrayField(schemaText, 'valueFlags'),
    ...arrayField(schemaText, 'multiFlags'),
  ])]
  const aliases = {}
  const aliasMatch = /\baliases\s*:\s*\{/.exec(schemaText)
  if (aliasMatch) {
    const aOpen = aliasMatch.index + aliasMatch[0].length - 1
    const aClose = matchBracket(schemaText, aOpen)
    if (aClose > 0) {
      const body = schemaText.slice(aOpen + 1, aClose)
      for (const pair of body.matchAll(/(['"]?)([\w-]+)\1\s*:\s*(['"])([\w-]+)\3/g)) aliases[pair[2]] = pair[4]
    }
  }
  const flagPresets = []
  const presetMatch = /\bflagPresets\s*:\s*\{/.exec(schemaText)
  if (presetMatch) {
    const pOpen = presetMatch.index + presetMatch[0].length - 1
    const pClose = matchBracket(schemaText, pOpen)
    if (pClose > 0) {
      const body = schemaText.slice(pOpen + 1, pClose)
      for (const pair of body.matchAll(/(['"]?)([\w-]+)\1\s*:\s*\{/g)) flagPresets.push(pair[2])
    }
  }
  return { found: true, flags: flags.sort(), aliases, flagPresets }
}

/**
 * 解析帮助函数体里的**声明位置**。
 *
 * 判据是「这一处是在给用户列举可用参数」，不是「这一处提到了 --xxx」。只有两种形态算：
 * 1. 行首缩进后紧接着 `--xxx`——选项清单的标准写法；
 * 2. 方括号分组里的 `--xxx`——用法行用它标可选参数（`[--draft] [--json]`）。
 *
 * 句中提及不算：`--body-file` 讲的是另一个命令的参数、`--ignore-scripts` 讲的是包管理器、
 * `(use --ignore-scripts)` 是括注。把它们当声明，「帮助里有、代码里没有」这个方向全是假红灯。
 */
export function extractDeclared(text) {
  const m = /\bfunction\s+printHelp\(\s*\)\s*\{/.exec(text)
  if (!m) return { found: false, flags: [] }
  const open = m.index + m[0].length - 1
  const close = matchBracket(text, open)
  if (close < 0) return { found: false, flags: [] }
  const body = text.slice(open + 1, close)
  const flags = new Set()
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // 去掉字符串字面量的引号前缀，得到「这一行真正开头的文字」。
    const content = line.replace(/^['"`]\s*/, '').replace(/['"`]\s*,?\s*$/, '')
    const head = /^--([a-z0-9][\w-]*)/i.exec(content)
    if (head) flags.add(head[1])
    for (const group of content.matchAll(/\[([^\]\n]*)\]/g)) {
      for (const flag of group[1].matchAll(/--([a-z0-9][\w-]*)/gi)) flags.add(flag[1])
    }
  }
  return { found: true, flags: [...flags].sort() }
}

/**
 * 收集读取点：`opts.xY`、`opts['x-y']`、`opts[CONST]` 间接形态，以及按变量枚举的动态形态。
 *
 * 三种「看着像死、其实活着」的写法都要认，否则误判会逼人加豁免——豁免本身就是新暗门：
 * `opts[PLAN_BOOTSTRAP_FLAG]`（常量在共享库）、`opts?.[key]`（键在一个数组里逐个给出）。
 * 认这些形态不是放宽判据，而是把真实写法读全。
 */
export function collectReadFlags(files, constantSources = files) {
  const constants = new Map()
  for (const src of constantSources) {
    for (const m of src.text.matchAll(/\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]+)\2/g)) {
      if (!constants.has(m[1])) constants.set(m[1], m[3])
    }
  }
  const read = new Set()
  for (const src of files) {
    for (const m of src.text.matchAll(/\bopts\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/g)) read.add(m[1])
    for (const m of src.text.matchAll(/\bopts\s*\??\s*\.?\s*\[\s*(['"])([^'"]+)\1\s*\]/g)) read.add(m[2])
    for (const m of src.text.matchAll(/\bopts\s*\??\s*\.?\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
      if (m[1] === 'undefined') continue
      if (constants.has(m[1])) read.add(constants.get(m[1]))
    }
    for (const m of src.text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g)) {
      const keyVar = m[1]
      if (!new RegExp(`\\bopts\\s*\\??\\s*\\.?\\s*\\[\\s*${keyVar}\\s*\\]`).test(src.text)) continue
      for (const lit of m[2].matchAll(/(['"])([^'"]+)\1/g)) read.add(lit[2])
    }
  }
  return read
}

/** 一个参数的读取点是否存在：注册名、驼峰名、别名指向名，任一被读到即算活。 */
export function hasReadPoint(flag, readSet, aliases) {
  const candidates = new Set([flag, camelOf(flag)])
  const target = aliases?.[flag]
  if (target) {
    candidates.add(target)
    candidates.add(camelOf(target))
  }
  for (const c of candidates) if (readSet.has(c)) return true
  return false
}

/** `--x-y` 与点号读取形态 `xY` 之间的归一。 */
export function camelOf(flag) {
  return String(flag).replace(/-([a-z0-9])/gi, (_all, ch) => ch.toUpperCase())
}

function readTextSafe(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * 对单个入口做三重对拍。`walk` 由调用方注入，避免这里再造一个目录遍历。
 */
export function auditEntry(spec, { ROOT, walk }) {
  const entryText = readTextSafe(join(ROOT, spec.file))
  if (entryText === null) return { ok: false, label: spec.label, error: `读不到入口脚本：${spec.file}` }
  const registered = extractRegistered(entryText)
  if (!registered.found) return { ok: false, label: spec.label, error: `${spec.file} 里没有 parseStandardCli 的 schema 对象` }
  const declared = extractDeclared(entryText)
  if (!declared.found) return { ok: false, label: spec.label, error: `${spec.file} 里没有 printHelp 的函数体` }

  const load = (dir) => walk(dir, (f) => f.endsWith('.mjs'))
    .map((abs) => ({ abs, text: readTextSafe(abs) }))
    .filter((f) => f.text !== null)
  const scopeFiles = load(join(ROOT, spec.scope))
  const libraryFiles = load(join(ROOT, 'kit', 'skills', 'lib'))
  const readSet = collectReadFlags([...scopeFiles, ...libraryFiles], [...scopeFiles, ...libraryFiles])

  const registeredSet = new Set(registered.flags)
  const declaredSet = new Set(declared.flags)
  const globalSet = new Set(GLOBAL_FLAGS)

  return {
    ok: true,
    label: spec.label,
    file: spec.file,
    registered: registered.flags.length,
    declared: declared.flags.length,
    dark: registered.flags.filter((f) => !declaredSet.has(f)),
    undeclaredInCode: declared.flags.filter((f) => !registeredSet.has(f) && !globalSet.has(f)),
    dead: registered.flags.filter((f) => !hasReadPoint(f, readSet, registered.aliases)),
  }
}

/** 手工维护的入口也要对拍：声明表与注册表必须互相覆盖。 */
export function auditHandRolled(spec, { ROOT } = {}) {
  const registeredSet = new Set(spec.registered)
  const declaredSet = new Set(spec.declared)
  // 手工声明表不能靠自己给自己作证：解析分支从源码里读出来，与表比对。
  const branches = []
  if (ROOT) {
    const text = readTextSafe(join(ROOT, spec.file)) ?? ''
    for (const m of text.matchAll(/\barg\s*===\s*'(--[\w-]+)'/g)) branches.push(m[1].slice(2))
    for (const m of text.matchAll(/\barg\s*===\s*'-h'/g)) branches.push('help')
  }
  const branchSet = new Set(branches)
  const unlisted = branches.filter((b) => !registeredSet.has(b))
  return {
    ok: true,
    label: spec.label,
    file: spec.file,
    registered: spec.registered.length,
    declared: spec.declared.length,
    dark: spec.registered.filter((f) => !declaredSet.has(f)),
    undeclaredInCode: spec.declared.filter((f) => !registeredSet.has(f)),
    dead: [],
    unlistedBranches: [...new Set(unlisted)],
    branchesFound: branchSet.size,
  }
}

/**
 * 全局参数的登记点必须是唯一一处。
 *
 * 三个全局参数由统一解析器注入：白名单按注册来源判定，只认 `cli.mjs` 里那两个
 * `toSet([...])` 调用，不在各脚本里逐个写例外。这里直接核对那一处还在、还是唯一的。
 */
export function auditGlobalWhitelist({ ROOT }) {
  const text = readTextSafe(join(ROOT, GLOBAL_FLAG_SOURCE))
  if (text === null) return { ok: false, error: `读不到全局参数登记点：${GLOBAL_FLAG_SOURCE}` }
  const callCount = (text.match(/toSet\(\[/g) ?? []).length
  const hasBool = /toSet\(\['help',\s*'json'/.test(text)
  const hasValue = /toSet\(\['dir',\s*'repo'/.test(text)
  const problems = []
  if (callCount !== 2) problems.push(`${GLOBAL_FLAG_SOURCE} 里 toSet([...]) 出现 ${callCount} 处，全局白名单应只在两处登记（布尔与取值各一）`)
  if (!hasBool) problems.push(`${GLOBAL_FLAG_SOURCE} 里找不到布尔全局参数登记（help 与 json 应在同一处 toSet）`)
  if (!hasValue) problems.push(`${GLOBAL_FLAG_SOURCE} 里找不到取值全局参数登记（dir 与 repo 应在同一处 toSet）`)
  return { ok: problems.length === 0, error: problems.join('；') || null }
}

/**
 * 三个方向一起判：反向差集清零、死参数清零、暗参数不得越过登记册。
 *
 * 暗参数按名字比，不比数量：数量锁不住「删一个、加一个」这种调包。
 */
export function evaluateParity(audits, baseline = DARK_BASELINE) {
  const failures = []
  const notes = []
  for (const a of audits) {
    if (!a.ok) {
      failures.push(a.error ?? `${a.label} 对拍失败`)
      continue
    }
    if (a.undeclaredInCode.length > 0) {
      failures.push(`${a.label}帮助里声明了 ${a.undeclaredInCode.length} 个没注册的参数（照着敲会被拒）：${a.undeclaredInCode.join(', ')}`)
    }
    if (a.dead.length > 0) {
      failures.push(`${a.label}有 ${a.dead.length} 个注册参数没有任何读取点（看着能用、其实不做事的死参数）：${a.dead.join(', ')}`)
    }
    const known = new Set(baseline[a.label] ?? [])
    const fresh = a.dark.filter((f) => !known.has(f))
    if (fresh.length > 0) {
      failures.push(`${a.label}新增了 ${fresh.length} 个只有代码知道、帮助里看不到的暗参数：${fresh.join(', ')}（要么补进帮助，要么删掉；不许留在暗处）`)
    }
    const paid = [...known].filter((f) => !a.dark.includes(f))
    if (paid.length > 0) notes.push(`${a.label}还清暗参数 ${paid.length} 个：${paid.map((f) => `--${f}`).join(', ')}`)
    if (Array.isArray(a.unlistedBranches) && a.unlistedBranches.length > 0) {
      failures.push(`${a.label}解析分支里有 ${a.unlistedBranches.length} 个参数没进声明表（自己写的解析器也不能成为绕过对拍的办法）：${a.unlistedBranches.join(', ')}`)
    }
    notes.push(`${a.label} ${a.registered}/${a.declared}，暗参数 ${a.dark.length} 个在册`)
  }
  return { failures, notes }
}

const REQUIRED_SUBCOMMAND_FLAGS = Object.freeze({
  'flow.mjs': {
    submit: ({ flags }) => {
      if (flags.has('agent')) return []
      const singleSession = flags.has('single-session') || flags.has('host-mode')
      if (singleSession && flags.has('human-approved')) return []
      return ['--agent']
    },
    cleanup: ({ flags }) => (flags.has('confirm') && !flags.has('preview-hash') ? ['--preview-hash'] : []),
    close: ({ flags }) => ['issue', 'reason'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
  },
  'doc-plan.mjs': {
    init: ({ flags, sourceKind }) => {
      const missing = ['kind', 'slug', 'title'].filter((f) => !flags.has(f)).map((f) => `--${f}`)
      if (sourceKind === 'skill-md' && !flags.has('owner') && !flags.has('agent')) {
        missing.push('--owner|--agent')
      }
      return missing
    },
    approve: ({ flags }) => (flags.has('file') ? [] : ['--file']),
    'critique-pass': ({ flags }) => ['file', 'reviewer'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
    'critique-reject': ({ flags }) => ['file', 'reviewer'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
    'critique-override': ({ flags }) => ['file', 'human-approved', 'reason'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
  },
  'review-pack.mjs': {
    record: ({ flags }) => ['verdict', 'reviewer-id'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
    override: ({ flags }) => ['human-approved', 'reason'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
    'check-fault': ({ flags }) => ['phase', 'cmd'].filter((f) => !flags.has(f)).map((f) => `--${f}`),
  },
  'iterate.mjs': {
    cycle: ({ flags, sourceKind }) => (sourceKind === 'skill-md' && !flags.has('goal') ? ['--goal'] : []),
  },
})

function buildEntryCatalog(ROOT) {
  const byBase = new Map()
  const subcommandsByBase = new Map()
  for (const meta of Object.values(SUBCOMMAND_META)) {
    subcommandsByBase.set(basename(meta.file), new Set(meta.subcommands.map((s) => s.name)))
  }
  for (const spec of ENTRY_SPECS) {
    const text = readTextSafe(join(ROOT, spec.file))
    if (!text) continue
    const reg = extractRegistered(text)
    if (!reg.found) continue
    const base = basename(spec.file)
    const allowed = new Set([...reg.flags, ...GLOBAL_FLAGS, ...Object.keys(reg.aliases ?? {}), ...(reg.flagPresets ?? [])])
    byBase.set(base, {
      spec,
      base,
      allowed,
      subcommands: subcommandsByBase.get(base) ?? new Set(),
    })
  }
  return byBase
}

function stripTemplateExprs(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      while (j < raw.length && depth > 0) {
        if (raw[j] === '{') depth += 1
        else if (raw[j] === '}') depth -= 1
        j += 1
      }
      out += ' <expr> '
      i = j - 1
    } else {
      out += raw[i]
    }
  }
  return out
}

function parseEntryCommandInvocation(segment, catalog) {
  const cleaned = stripTemplateExprs(segment).trim()
  if (!cleaned) return null
  const m = /\bnode\s+["']?(?:[^"'\s]*\/)?([a-z0-9_-]+\.mjs)["']?(?:\s+([\s\S]*))?$/i.exec(cleaned)
  if (!m) return null
  const entryBase = m[1]
  const entry = catalog.get(entryBase)
  if (!entry) return null

  const tail = m[2] ?? ''
  // 将方括号或引号内的选项统一剥出，同时排除 --cmd "<外部命令 --foo>" 等内嵌引号值
  const strippedQuotedVals = tail.replace(/(--(?:cmd|command|live-e2e-cmd|summary|reason|rationale|title|body|notes?|description|e2e-evidence|visual-evidence|visual-blocked-reason|evidence|findings|rebut|goal)\s+)(?:"[^"]*"|'[^']*')/gi, '$1<quoted>')
  const tokens = strippedQuotedVals.match(/--[a-z0-9][\w-]*|[a-z0-9][\w-]*/gi) ?? []
  let sub = null
  const firstTok = tokens[0] ?? ''
  if (firstTok && !firstTok.startsWith('--') && entry.subcommands.has(firstTok)) {
    sub = firstTok
  }
  const flags = new Set()
  for (const mFlag of strippedQuotedVals.matchAll(/(?:^|[\s\[(|])--([a-z0-9][\w-]*)\b/gi)) {
    flags.add(mFlag[1])
  }
  return { entry, sub, flags, raw: cleaned }
}

/** 校验单段命令行是否存在未注册幽灵参数或缺失必填参数（自动跳过 git/gh/pytest/mvn 等外部 CLI）。 */
export function auditCommandSnippet(snippet, { ROOT, sourceLabel = 'snippet', sourceKind = 'snippet', _catalog = null } = {}) {
  const catalog = _catalog ?? buildEntryCatalog(ROOT)
  const parsed = parseEntryCommandInvocation(snippet, catalog)
  if (!parsed) return { ok: true, skippedExternal: true, failures: [] }
  const { entry, sub, flags } = parsed
  const failures = []
  for (const f of flags) {
    if (!entry.allowed.has(f)) {
      failures.push(`${sourceLabel} 调用 ${entry.base}${sub ? ` ${sub}` : ''} 使用了未注册幽灵参数 --${f}`)
    }
  }
  if (sub) {
    const reqRule = REQUIRED_SUBCOMMAND_FLAGS[entry.base]?.[sub]
    if (typeof reqRule === 'function') {
      const missing = reqRule({ flags, sourceKind, parsed })
      if (missing.length > 0) {
        failures.push(`${sourceLabel} 调用 ${entry.base} ${sub} 缺少必填参数：${missing.join('、')}`)
      }
    }
  }
  return { ok: failures.length === 0, skippedExternal: false, entry: entry.base, sub, flags: [...flags], failures }
}

function extractShellCommandsFromMarkdown(mdText) {
  const lines = String(mdText ?? '').replace(/\r\n/g, '\n').split('\n')
  const cmds = []
  let inFence = false
  let fenceLang = ''
  let buf = ''
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (/^```/.test(trimmed)) {
      if (!inFence) {
        inFence = true
        fenceLang = trimmed.slice(3).trim().toLowerCase()
      } else {
        if (buf.trim()) cmds.push({ line: i + 1, cmd: buf.trim() })
        buf = ''
        inFence = false
        fenceLang = ''
      }
      continue
    }
    if (!inFence || (fenceLang && !/^(?:sh|bash|shell|zsh|pwsh|powershell)?$/.test(fenceLang))) continue
    if (!trimmed || trimmed.startsWith('#')) {
      if (buf.trim()) { cmds.push({ line: i, cmd: buf.trim() }); buf = '' }
      continue
    }
    const cleanLine = trimmed.replace(/\s+#\s+.*$/, '')
    if (cleanLine.endsWith('\\')) {
      buf += (buf ? ' ' : '') + cleanLine.slice(0, -1).trim()
      continue
    }
    const full = (buf ? `${buf} ` : '') + cleanLine
    buf = ''
    for (const part of full.split(/\s*(?:;|&&|\|\||->)\s*/)) {
      if (part.trim()) cmds.push({ line: i + 1, cmd: part.trim() })
    }
  }
  return cmds
}

function extractNextStepCommandsFromScript(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes('.mjs')) continue
    if (!/(?:printNextStep|nextStep|nextSteps|command\s*=|command\s*:|parts\s*=|steps\.push|next\.unshift|nextTier|unlockCmd)/.test(line)
      && !/['"`][^'"`]*node\s+["']?\.agents\/skills\//.test(line)) {
      continue
    }
    for (const lit of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const val = lit[2]
      if (val.includes('.mjs') && /\bnode\s+/.test(val)) {
        hits.push({ line: i + 1, cmd: val })
      }
    }
  }
  return hits
}

function walkMjsFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) walkMjsFiles(full, out)
    else if (ent.isFile() && ent.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/** 扫描全仓 `kit/skills/dev-<name>/SKILL.md` 命令行代码块及 `kit/skills/` 中 `printNextStep`/导航命令，拦截幽灵参数与缺失必填参数。 */
export function auditSkillDocsAndNextSteps({ ROOT }) {
  const catalog = buildEntryCatalog(ROOT)
  const failures = []
  let checkedCommands = 0

  const skillsRoot = join(ROOT, 'kit', 'skills')
  if (existsSync(skillsRoot)) {
    const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('dev-'))
      .map((d) => d.name)
      .sort()
    for (const dirName of skillDirs) {
      const mdRel = `kit/skills/${dirName}/SKILL.md`
      const text = readTextSafe(join(ROOT, mdRel))
      if (!text) continue
      for (const item of extractShellCommandsFromMarkdown(text)) {
        const res = auditCommandSnippet(item.cmd, { ROOT, sourceLabel: `${mdRel}:${item.line}`, sourceKind: 'skill-md', _catalog: catalog })
        if (!res.skippedExternal) {
          checkedCommands += 1
          failures.push(...res.failures)
        }
      }
    }

    for (const abs of walkMjsFiles(skillsRoot)) {
      const relPath = abs.slice(resolve(ROOT).length + 1).replace(/\\/g, '/')
      const text = readTextSafe(abs)
      if (!text) continue
      for (const item of extractNextStepCommandsFromScript(text)) {
        const res = auditCommandSnippet(item.cmd, { ROOT, sourceLabel: `${relPath}:${item.line}`, sourceKind: 'script-next-step', _catalog: catalog })
        if (!res.skippedExternal) {
          checkedCommands += 1
          failures.push(...res.failures)
        }
      }
    }
  }

  return { ok: failures.length === 0, checkedCommands, failures }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
  const walk = (dir, pred, out = []) => {
    if (!existsSync(dir)) return out
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.worktrees') continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) walk(full, pred, out)
      else if (ent.isFile() && (!pred || pred(full))) out.push(full)
    }
    return out
  }
  const audits = [
    ...ENTRY_SPECS.map((spec) => auditEntry(spec, { ROOT, walk })),
    ...HAND_ROLLED_SPECS.map((spec) => auditHandRolled(spec, { ROOT })),
  ]
  const { failures, notes } = evaluateParity(audits)
  const globalCheck = auditGlobalWhitelist({ ROOT })
  if (!globalCheck.ok) failures.push(globalCheck.error)
  const docParity = auditSkillDocsAndNextSteps({ ROOT })
  failures.push(...docParity.failures)
  process.stdout.write(`参数对拍：${notes.join('；')}；SKILL.md/printNextStep 校验 ${docParity.checkedCommands} 条命令\n`)
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
    process.exit(1)
  }
}
