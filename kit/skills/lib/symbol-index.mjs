/**
 * symbol-index.mjs —— 「这个文件定义了哪些名字」的抽取器，以及「这门语言有没有规则」的三态。
 *
 * ## 它治的病
 *
 * 同一个问题在别处出现过两次，两次的错法一样：
 *
 *   - `docs/TDD.md` 的模块漂移判据拿 `includes()` 比字符串。文档里一句
 *     「`foo` 只在注释里出现过」也会被当成「已经写过 foo」，于是注释能替代码签名；
 *   - `repo-map` 的可复用模块按「文件里出现没出现 export 字样」判断，漏掉
 *     PowerShell 的 `function Foo {`、Bash 的 `foo() {`、Go 的 `func bar()`，
 *     把一半语言的仓判成「没有可复用模块」。
 *
 * ## 为什么要三态，不是「有没有符号」
 *
 * 「这门语言一个符号都没抽到」有两种完全不同的含义：文件确实是空的，或者
 * **这门语言根本没有规则**。把后者显示成空数组，读的人会以为「这个仓没东西」——
 * 而事实是我们没看。所以这里返回 `supported: false`，并且调用方要把它报出来。
 *
 * ## 判据是词法级，不是语义级
 *
 * 只认「定义形状」：`function Foo`、`foo() {`、`func bar(`、`def x(`、`class X`。
 * 不做作用域、不做类型解析、不区分重载——这不是编译器，它的用途是给判据提供
 * 「这个名字是以定义的形式出现的」这一条事实。
 *
 * 抽之前先剥注释：扔进注释里的名字不是定义。
 */

import { stripCodeCommentsLines } from './static-gates-lexer.mjs'

/** 扩展名 -> 语言标识。没登记的语言不会被猜，直接落到 `unsupported`。 */
const EXT_TO_LANG = Object.freeze({
  ps1: 'powershell', psm1: 'powershell',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  go: 'go',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python',
  rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
})

/**
 * 每种语言的「定义行」规则。
 *
 * 每组都刻意只收定义形状：`\bfoo\(` 这样的裸调用不算，否则「名字出现过」又变成
 * 和 `includes()` 一样的宽判据。
 */
const SYMBOL_RULES = Object.freeze({
  powershell: [
    /\bfunction\s+(?:global:|script:|local:)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[({]/i,
  ],
  bash: [
    /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/,
    /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
  ],
  go: [
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(\[]/,
    /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/,
  ],
  javascript: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
  ],
  typescript: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/,
  ],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  ],
  java: [
    /^\s*(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  ],
  kotlin: [
    /^\s*(?:public\s+|internal\s+|private\s+)?(?:data\s+|sealed\s+|open\s+|abstract\s+)?(?:class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^\s*fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*\(/,
  ],
  csharp: [
    /^\s*(?:public\s+|internal\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)(?:static\s+|async\s+|virtual\s+|override\s+)*[A-Za-z_][A-Za-z0-9_<>,\[\]?]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ],
  php: [
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ],
  ruby: [
    /^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*[?!=]?)/,
    /^\s*(?:class|module)\s+([A-Z][A-Za-z0-9_:]*)/,
  ],
})

/**
 * 哪些扩展名算「程序语言」，因而该被符号覆盖统计看到。
 *
 * 这份清单必须比 `SYMBOL_RULES` **宽**：它的作用是把「有规则的语言」与「没规则的
 * 语言」放在同一张表里数，缺了哪一门就数不出「N 种里有 M 种缺规则」。
 *
 * 用 `CODE_EXT_RE` 那种「本工具认识的源码」清单代替它是不行的：`.hs`、`.ex`、`.lua`
 * 都不在里面，于是 Haskell/Elixir 的仓在勘察里显示「0 种语言、0 种缺规则」——
 * 那句话的意思是「这个仓没有语言」，而它有的是。
 */
const SYMBOL_CANDIDATE_EXT = new Set([
  'ps1', 'psm1', 'sh', 'bash', 'zsh', 'go', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'rs', 'java', 'kt', 'kts', 'cs', 'php', 'rb',
  'hs', 'lhs', 'ex', 'exs', 'erl', 'lua', 'swift', 'dart', 'scala', 'groovy', 'zig', 'nim', 'r', 'clj', 'cljs', 'ml',
])

/** 这个路径看起来该有符号抽取规则吗（不论现在有没有）。 */
export function isSymbolCandidatePath(rel) {
  const text = String(rel ?? '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  const name = cut === -1 ? text : text.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return SYMBOL_CANDIDATE_EXT.has(name.slice(dot + 1).toLowerCase())
}

/** 这门语言的扩展名有抽取规则吗。 */
export function isSymbolRuleSupported(ext) {
  return Boolean(SYMBOL_RULES[EXT_TO_LANG[normalizeExt(ext)]])
}

function normalizeExt(ext) {
  return String(ext ?? '').trim().toLowerCase().replace(/^\./, '')
}

/** 扩展名对应的语言标识；没登记的语言返回扩展名本身，用于报「缺规则的那种」。 */
export function languageOf(ext) {
  const key = normalizeExt(ext)
  return EXT_TO_LANG[key] ?? (key || 'unknown')
}

/**
 * 抽一个文件里的定义名。
 *
 * @param {string} text 文件正文
 * @param {string} ext 扩展名，带不带点都行
 * @returns {{ lang: string, supported: boolean, status: 'ok'|'unsupported', symbols: string[] }}
 *   `supported: false` 时 `symbols` 一定为空数组——它是「没规则」，不是「没符号」，
 *   调用方必须看 `supported` 而不是 `symbols.length`。
 */
export function extractSymbols(text, ext) {
  const key = normalizeExt(ext)
  const lang = languageOf(key)
  const rules = SYMBOL_RULES[lang]
  if (!rules) return { lang, supported: false, status: 'unsupported', symbols: [] }

  const codeLines = stripCodeCommentsLines(text, key)
  const symbols = []
  const seen = new Set()
  for (const line of codeLines) {
    for (const rule of rules) {
      const m = rule.exec(line)
      if (!m) continue
      const name = m[1]
      if (!name || seen.has(name)) continue
      seen.add(name)
      symbols.push(name)
    }
  }
  return { lang, supported: true, status: 'ok', symbols }
}

/**
 * 一批文件的统计：本仓有几种语言，其中几种缺规则。
 *
 * 被略过的语言不能静默消失——那正是「算不出来显示成算出来没问题」的同一种形状。
 *
 * @param {Array<string|{ rel?: string, ext?: string, name?: string }>} files
 *   直接给文件名（`a.ps1`）、相对路径（`bin/a.sh`）或文件对象都行
 */
export function summarizeSymbolCoverage(files) {
  const langs = new Map()
  for (const f of files ?? []) {
    const raw = typeof f === 'string' ? f : (f?.ext ?? f?.name ?? f?.rel ?? '')
    const text = String(raw)
    const ext = normalizeExt(text.includes('.') ? text.split('.').pop() : text)
    if (!ext || /[\\/]/.test(ext)) continue
    const lang = languageOf(ext)
    const entry = langs.get(lang) ?? { lang, files: 0, supported: isSymbolRuleSupported(ext) }
    entry.files += 1
    langs.set(lang, entry)
  }
  const all = [...langs.values()].sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0))
  const unsupported = all.filter((x) => !x.supported).map((x) => x.lang)
  return { languageCount: all.length, unsupportedCount: unsupported.length, unsupported, languages: all }
}
