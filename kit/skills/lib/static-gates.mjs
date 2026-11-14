/**
 * static-gates.mjs —— 统一静态门禁内核：词法注释剥离、arch-rules、门型评估、门禁弱化与卫生扫描。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-flow、dev-review、dev-govern 共用，
 * 彻底消除各技能脚本间多套判据分叉。
 */

import { existsSync } from 'node:fs'
import { join, posix as pathPosix } from 'node:path'

import { gitRun, gitRunBuffer, posixPath, readTextSafe, unescapeGitPath } from './git.mjs'

export const PACKAGE_LOCKFILES = Object.freeze([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
  'gradle.lockfile', 'packages.lock.json', 'Gemfile.lock', 'composer.lock', 'flake.lock', 'Package.resolved',
])

export const LOCKFILE_NAMES = new Set(PACKAGE_LOCKFILES.map((n) => n.toLowerCase()))

export const UI_VISUAL_EXT_RE = /\.(?:tsx|jsx|vue|svelte|html|css|scss|svg)$/i
export const CODE_EXT_RE = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|kts|rb|php|cs|fs|c|cc|cpp|h|hpp|swift|dart|sh|bash|ps1)$/i
export const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|src\/test|src\/it)\/|(?:\.(?:test|spec)\.[^/]+$)|_test\.[^/]+$|(?:^|\/)test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs|swift)$|_unittest\.(?:cc|cpp)$|\.Tests\//i

export const GATE_WORKFLOW_FILE_RE = /(?:^|\/)(?:\.github\/(?:workflows|actions)\/[^/]+\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile)$/i
export const GATE_SHELL_OR_SCRIPT_RE = /(?:^|\/)(?:\.github\/(?:workflows|actions)\/[^/]+\.ya?ml|package\.json|Makefile|justfile|Taskfile\.ya?ml)$|\.(?:sh|bash|ps1)$/i
export const GATE_SKIP_RE = /(?:^|[^\w.])(?:(?:it|test|describe|context|suite)\.(?:skip|only)\s*\(|(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@(?:pytest\.mark\.skip(?:if)?|unittest\.skip|Disabled|Ignore)\b|#\[\s*ignore\b|\bt\.Skip(?:f|Now)?\s*\(|\[(?:Fact|Theory)\s*\([^\)]*\bSkip\s*=)|\bDISABLED_[A-Za-z0-9_]+|\{\s*(?:skip|only)\s*:\s*true\b/
export const GATE_ASSERTION_RE = /\b(?:assert(?:\.\w+)?|expect|should|pytest\.raises|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|assert_(?:eq|ne|matches)?!|assert(?:Equals|NotEquals|True|False|Throws|Null|NotNull|That)|strictEqual|deepStrictEqual|equal|notEqual|throws|rejects|match|EXPECT_[A-Z0-9_]+|ASSERT_[A-Z0-9_]+|REQUIRE|CHECK)\b\s*(?:\(|!|\.)|\bassert\s+|\b(?:it|test)\s*\(|@(?:Test|Fact|Theory)\b|\bdef\s+test_|#\[\s*test\s*\]|\bfunc\s+Test[A-Z]/i
export const TEST_CASE_RE = /\b(?:it|test|describe|context|suite)(?:\.(?:skip|only|todo))?\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bdef\s+test_|#\[\s*test\s*\]|\bfunc\s+Test[A-Z]|@(?:Test|ParameterizedTest)\b|\[(?:Fact|Theory)\b/
export const TEST_SKIP_RE = GATE_SKIP_RE
export const ASSERTION_RE = GATE_ASSERTION_RE
export const GATE_CI_PERM_WRITE_RE = /\b(?:contents|id-token|packages|security-events|actions|pull-requests|checks|deployments|issues)\s*:\s*write\b/i
export const GATE_SHELL_BYPASS_RE = /(?:^|[\s;|&"'])\|\|\s*true(?:\s|$|["';&|])/

export const TOMBSTONE_COMMENT_RE = /\b(?:used to be|previously (?:was|were|called|used)|migrated from|replaced old|formerly\b|removed in favor of|deprecated since v?\d|changed from\b.{1,30}\bto\b)|(?:以前是|原先是|原本是|之前是|旧版是|后来改成|后来改为|历史兼容保留)/i
export const EXCUSE_COMMENT_RE = /@(?:ts-ignore|ts-nocheck)|eslint-disable(?:-next-line|-line)?|\bnoqa\b|type:\s*ignore\b|pragma\s+warning\s+disable|\b(?:hack|workaround)\b/i
export const EXCUSE_TEMP_RE = /\bTEMP\b/
export const RUST_ALLOW_RE = /^\s*#\[\s*allow\(/

const C_FAMILY_NO_HASH_COMMENT_EXTS = new Set([
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'java', 'kt', 'kts', 'rs', 'go',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts', 'swift', 'dart', 'php',
])
const C_PREPROC_RE = /^#\s*(?:define|include|if|ifdef|ifndef|else|elif|endif|pragma|undef|error|warning|line|region|endregion)\b/

/** 通用路径 glob 匹配（支持 `*`、`**`、`?` 及目录前缀斜杠）。 */
export function matchGlob(filePath, pattern) {
  const f = posixPath(filePath).replace(/^\.\//, '').replace(/^\/+/, '')
  const p = posixPath(pattern).trim().replace(/^`+|`+$/g, '').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!f || !p) return false
  if (p.endsWith('/')) return f.startsWith(p)
  if (p.endsWith('/**') && !p.slice(0, -3).includes('*') && !p.slice(0, -3).includes('?')) {
    const base = p.slice(0, -3)
    return f === base || f.startsWith(`${base}/`)
  }
  if (!/[*?]/.test(p)) return f === p || f.startsWith(`${p}/`)

  let reStr = '^'
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          reStr += '(?:.*/)?'
          i += 2
        } else {
          reStr += '.*'
          i += 1
        }
      } else {
        reStr += '[^/]*'
      }
    } else if (p[i] === '?') {
      reStr += '[^/]'
    } else {
      reStr += p[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  reStr += '$'
  return new RegExp(reStr).test(f)
}

function isRustLifetimeAt(s, idx, ext) {
  if (ext && ext !== 'rs') return false
  const rest = s.slice(idx)
  if (!/^'(?:_|[A-Za-z][A-Za-z0-9_]*)/.test(rest)) return false
  const m = /^'([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
  if (!m) return false
  const after = rest[m[0].length]
  // `'a'` is a char literal; `'a` or `'static` without closing `'` is a Rust lifetime
  return after !== '\''
}

/**
 * 多语言词法注释提取器：
 * 修复 Rust 生命周期 `'a`、C/C++ 预处理指令（如 `#define`）与块注释跨行跟踪，
 * 返回 `{ commentText, codeText, nextInBlock, pureSingleLine }`。
 */
export function extractLineCommentInfo(line, inBlock = false, ext = '') {
  const s = String(line ?? '')
  const extLow = String(ext ?? '').toLowerCase().replace(/^\./, '')
  const allowHashComment = !C_FAMILY_NO_HASH_COMMENT_EXTS.has(extLow)
  const commentParts = []
  let codeText = ''
  let segStart = 0
  let i = 0
  let block = inBlock
  let quote = ''
  let prevSig = ''
  let onlyComment = true
  let pureSingleLine = false

  if (block) {
    const closeToken = block === 'html' ? '-->' : '*/'
    const end = s.indexOf(closeToken)
    if (end === -1) {
      return { commentText: s.trim(), codeText: '', nextInBlock: block, pureSingleLine: false }
    }
    commentParts.push(s.slice(0, end))
    block = false
    i = end + closeToken.length
    segStart = i
    onlyComment = false
  }

  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]
    if (quote) {
      onlyComment = false
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '\'') {
      if (isRustLifetimeAt(s, i, extLow)) {
        onlyComment = false
        prevSig = '\''
        i += 1
        continue
      }
      onlyComment = false
      quote = ch
      prevSig = ch
      i += 1
      continue
    }
    if (ch === '"' || ch === '`') {
      onlyComment = false
      quote = ch
      prevSig = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      codeText += s.slice(segStart, i)
      segStart = s.length
      if (!prevSig && s[i + 2] !== '/') pureSingleLine = true
      commentParts.push(s.slice(i + 2))
      break
    }
    if (ch === '/' && next === '*') {
      onlyComment = false
      codeText += s.slice(segStart, i)
      const end = s.indexOf('*/', i + 2)
      if (end === -1) {
        commentParts.push(s.slice(i + 2))
        block = true
        segStart = s.length
        break
      }
      commentParts.push(s.slice(i + 2, end))
      i = end + 2
      segStart = i
      continue
    }
    if (ch === '<' && s.slice(i, i + 4) === '<!--') {
      onlyComment = false
      codeText += s.slice(segStart, i)
      const end = s.indexOf('-->', i + 4)
      if (end === -1) {
        commentParts.push(s.slice(i + 4))
        block = 'html'
        segStart = s.length
        break
      }
      commentParts.push(s.slice(i + 4, end))
      i = end + 3
      segStart = i
      continue
    }
    if (ch === '/') {
      const canRegex = !prevSig || '=(:,?[!&|;{}~^+-*'.includes(prevSig)
        || /\b(?:return|case|throw|typeof|await|yield)$/.test(s.slice(0, i).trimEnd())
      if (canRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < s.length) {
          const rc = s[j]
          if (rc === '\\') { j += 2; continue }
          if (rc === '[') inClass = true
          else if (rc === ']' && inClass) inClass = false
          else if (rc === '/' && !inClass) { closed = true; break }
          j += 1
        }
        if (closed) {
          onlyComment = false
          prevSig = '/'
          i = j + 1
          continue
        }
      }
    }
    if (ch === '#' && allowHashComment) {
      const prevCh = i > 0 ? s[i - 1] : ''
      const rest = s.slice(i)
      if ((i === 0 || /\s/.test(prevCh)) && next !== '!' && next !== '[' && !C_PREPROC_RE.test(rest)) {
        codeText += s.slice(segStart, i)
        segStart = s.length
        if (!prevSig && onlyComment) pureSingleLine = true
        commentParts.push(s.slice(i + 1))
        break
      }
    }
    if (!/\s/.test(ch)) {
      prevSig = ch
      onlyComment = false
    }
    i += 1
  }

  if (segStart < s.length) codeText += s.slice(segStart)
  return { commentText: commentParts.join(' ').trim(), codeText, nextInBlock: block, pureSingleLine }
}

/** 剥离源码行内全部注释，保留原始行号映射。 */
export function stripCodeCommentsLines(text, ext = '') {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const info = extractLineCommentInfo(line, inBlock, ext)
    inBlock = info.nextInBlock
    out.push(info.codeText)
  }
  return out
}

function parseArchRuleItem(rawRule) {
  if (rawRule && typeof rawRule === 'object') {
    const from = String(rawRule.fromGlob ?? rawRule.from ?? '').trim()
    const to = String(rawRule.toGlob ?? rawRule.to ?? '').trim()
    return from && to ? { from, to, fromGlob: from, toGlob: to, raw: `${from} -> ${to}` } : null
  }
  const m = /^(.+?)\s*(?:->|→)\s*(.+)$/.exec(String(rawRule ?? '').trim())
  if (!m) return null
  const from = m[1].trim().replace(/^`+|`+$/g, '')
  const to = m[2].trim().replace(/^`+|`+$/g, '')
  if (!from || !to || /^(?:none|<[^>]+>)$/i.test(from) || /^(?:none|<[^>]+>)$/i.test(to)) return null
  return { from, to, fromGlob: from, toGlob: to, raw: `${from} -> ${to}` }
}

function resolveGoModules(repoRoot) {
  const modules = []
  const readMod = (dirRel) => {
    const p = dirRel ? join(repoRoot, dirRel, 'go.mod') : join(repoRoot, 'go.mod')
    const txt = readTextSafe(p)
    const mod = txt ? /^module\s+(\S+)/m.exec(txt)?.[1]?.trim() : undefined
    if (mod) modules.push({ mod, dirRel })
  }
  readMod('')
  const gowork = readTextSafe(join(repoRoot, 'go.work'))
  if (gowork) {
    for (const m of gowork.matchAll(/^\s*(?:use\s+)?(\.\/[^\s)]+|[^\s()./][^\s()]*)/gm)) {
      const sub = posixPath(m[1]).replace(/^\.\//, '').replace(/\/+$/, '')
      if (sub && sub !== 'go' && !/^(?:go|use|replace)$/.test(sub)) readMod(sub)
    }
  }
  return modules
}

function extractImportsForArch(relFile, text, goModules) {
  const results = []
  const ext = posixPath(relFile).toLowerCase().split('.').pop() ?? ''
  const codeLines = stripCodeCommentsLines(text, ext)
  const stripped = codeLines.join('\n')
  const curDir = pathPosix.dirname(posixPath(relFile))

  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts'].includes(ext)) {
    const patterns = [
      /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const re of patterns) {
      for (const m of stripped.matchAll(re)) {
        const spec = m[1].trim()
        if (!spec) continue
        const line = stripped.slice(0, m.index ?? 0).split('\n').length
        const cands = []
        if (spec.startsWith('.')) {
          const base = pathPosix.normalize(pathPosix.join(curDir, spec))
          cands.push(base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.ts`)
        } else {
          cands.push(spec)
          if (spec.startsWith('@/')) cands.push(`src/${spec.slice(2)}`)
        }
        results.push({ line, specifier: spec, candidates: cands })
      }
    }
    return results
  }

  if (ext === 'py') {
    for (let i = 0; i < codeLines.length; i += 1) {
      const code = codeLines[i].trim()
      if (!code) continue
      const fromM = /^from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/.exec(code)
      if (fromM) {
        const mod = fromM[1]
        const cands = []
        const dotM = /^(\.+)(.*)$/.exec(mod)
        if (dotM) {
          let base = curDir
          for (let up = 1; up < dotM[1].length; up += 1) base = pathPosix.dirname(base)
          const sub = dotM[2].replace(/\./g, '/')
          const joined = sub ? pathPosix.normalize(base === '.' ? sub : pathPosix.join(base, sub)) : base
          cands.push(joined, `${joined}.py`, `${joined}/__init__.py`)
        } else {
          const slash = mod.replace(/\./g, '/')
          cands.push(slash, `${slash}.py`, `${slash}/__init__.py`)
        }
        results.push({ line: i + 1, specifier: mod, candidates: cands })
        continue
      }
      const impM = /^import\s+([A-Za-z0-9_.,\s]+)$/.exec(code)
      if (impM) {
        for (const seg of impM[1].split(',')) {
          const mod = seg.trim().split(/\s+as\s+/i)[0].trim()
          if (!mod) continue
          const slash = mod.replace(/\./g, '/')
          results.push({ line: i + 1, specifier: mod, candidates: [slash, `${slash}.py`, `${slash}/__init__.py`] })
        }
      }
    }
    return results
  }

  if (ext === 'go') {
    let inImportBlock = false
    for (let i = 0; i < codeLines.length; i += 1) {
      const line = codeLines[i].trim()
      if (!line) continue
      if (/^import\s*\($/.test(line)) { inImportBlock = true; continue }
      if (inImportBlock && line === ')') { inImportBlock = false; continue }
      const m = inImportBlock
        ? /^(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/.exec(line)
        : /^import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/.exec(line)
      if (!m) continue
      const spec = m[1].trim()
      const cands = [spec, `${spec}/_.go`]
      for (const gm of goModules) {
        if (spec.startsWith(`${gm.mod}/`)) {
          const sub = spec.slice(gm.mod.length + 1)
          const localPkg = gm.dirRel ? `${gm.dirRel}/${sub}` : sub
          cands.unshift(localPkg, `${localPkg}/_.go`)
        }
      }
      if (goModules.length === 0 && /^[^/]+\.[^/]+\/[^/]+\/.+/.test(spec)) {
        const segs = spec.split('/')
        if (segs.length >= 3) cands.unshift(segs.slice(2).join('/'), `${segs.slice(2).join('/')}/_.go`)
        if (segs.length >= 4) cands.unshift(segs.slice(3).join('/'), `${segs.slice(3).join('/')}/_.go`)
      }
      results.push({ line: i + 1, specifier: spec, candidates: cands })
    }
    return results
  }

  if (ext === 'java' || ext === 'kt' || ext === 'kts') {
    for (let i = 0; i < codeLines.length; i += 1) {
      const m = /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)(?:\.\*)?\s*;?/.exec(codeLines[i])
      if (!m) continue
      const spec = m[1]
      const slash = spec.replace(/\./g, '/')
      results.push({ line: i + 1, specifier: spec, candidates: [slash, `${slash}.${ext}`, `src/main/java/${slash}.java`] })
    }
    return results
  }

  if (ext === 'rs') {
    for (let i = 0; i < codeLines.length; i += 1) {
      const m = /^\s*(?:pub\s+)?use\s+(?:crate::)?([A-Za-z0-9_:]+)/.exec(codeLines[i])
      if (!m) continue
      const spec = m[1]
      const slash = spec.replace(/::/g, '/')
      results.push({ line: i + 1, specifier: spec, candidates: [slash, `src/${slash}`, `src/${slash}.rs`] })
    }
  }
  return results
}

/**
 * 依据 Dev Profile 中的 arch-rules（fromGlob -> toGlob）静态解析改动文件引用边界。
 */
export function evaluateArchRules(repoRoot, fileRelList = [], archRules = []) {
  const rules = (Array.isArray(archRules) ? archRules : []).map(parseArchRuleItem).filter(Boolean)
  if (rules.length === 0 || !Array.isArray(fileRelList) || fileRelList.length === 0) {
    return { ok: true, checkedFiles: 0, ruleCount: rules.length, violations: [] }
  }

  const goModules = resolveGoModules(repoRoot)
  const violations = []
  let checkedFiles = 0

  for (const rawFile of fileRelList) {
    const rel = posixPath(rawFile).replace(/^\.\//, '').replace(/^\/+/, '')
    if (!rel) continue
    const matchedRules = rules.filter((r) => matchGlob(rel, r.from))
    if (matchedRules.length === 0) continue

    const text = readTextSafe(join(repoRoot, rel))
    if (text === undefined) continue
    checkedFiles += 1
    const rawLines = text.split('\n')

    for (const imp of extractImportsForArch(rel, text, goModules)) {
      for (const rule of matchedRules) {
        const hit = imp.candidates.find((c) => matchGlob(c, rule.to))
        if (hit) {
          violations.push({
            file: rel,
            line: imp.line,
            rule: rule.raw,
            specifier: imp.specifier,
            target: hit,
            resolvedTarget: hit,
            lineText: (rawLines[imp.line - 1] ?? '').trim().slice(0, 120),
            message: `架构禁引违规 [${rule.raw}]：${rel}:${imp.line} 引用了 ${imp.specifier}（命中禁止目标 ${hit}）`,
            fixHint: `根因修法：勿让 ${rule.from} 直接依赖 ${rule.to}；请将公共契约/工具下沉至允许共享的基础层，或通过依赖注入反转依赖方向。`,
          })
        }
      }
    }
  }

  return { ok: violations.length === 0, checkedFiles, ruleCount: rules.length, violations }
}

/** 判定变更属于双向门（two-way，可逆）还是单向门（one-way，不可逆/触及边界与门禁）。 */
export function classifyDoorType({
  changedFiles = [],
  summary = '',
  touchesContract = false,
  highRisk = [],
  gateWeakened = false,
  doNotEdit = [],
  agentsText = '',
  task = null,
  diffBytes = 0,
} = {}) {
  const files = (Array.isArray(changedFiles) ? changedFiles : []).map((f) => posixPath(f).replace(/^\.\//, ''))
  const riskPatterns = [...new Set([...(Array.isArray(highRisk) ? highRisk : []), '.github/workflows/', 'AGENTS.md', '.gitattributes'])]
  const signals = []

  if (gateWeakened) signals.push('检测到弱化/放宽测试或 CI 门禁检查（必须人工拍板）')
  if (highRisk === true) signals.push('已标记触碰高风险路径')
  const highRiskHits = files.filter((f) => riskPatterns.some((pat) => matchGlob(f, pat)))
  if (highRiskHits.length > 0) signals.push(`触碰高风险路径：${highRiskHits.slice(0, 5).join(', ')}`)
  if (touchesContract) signals.push('涉及跨模块或外部对外契约变更')
  if (task?.doorType === 'one-way') signals.push('任务元数据已声明 doorType=one-way')
  if (agentsText && /^\s*(?:[-*]\s*)?`?merge-authority`?\s*[:：]\s*human\b/im.test(agentsText)) {
    signals.push('AGENTS.md 声明了 merge-authority: human')
  }
  const doNotEditList = Array.isArray(doNotEdit) ? doNotEdit : []
  const protectedHits = files.filter((f) => doNotEditList.some((pat) => matchGlob(f, pat)))
  if (protectedHits.length > 0) signals.push(`触碰受保护 do-not-edit 路径：${protectedHits.slice(0, 5).join(', ')}`)

  const infraHits = files.filter((f) => /(?:^|\/)(?:migrations?|migrate)\/|\.sql$|^(?:SKILL\.md|LICENSE|package-lock\.json)$/i.test(f))
  if (infraHits.length > 0) signals.push(`触碰不可逆迁移或分发根契约：${infraHits.slice(0, 5).join(', ')}`)
  const summaryText = String(summary ?? '')
  if (/(?:breaking\s+change|外部契约|跨模块|数据迁移|schema\s*变更|数据库迁移|不可逆|权限模型|协议变更|弱化门禁|publish|release|改可见性)/i.test(summaryText)) {
    signals.push('任务语义涉及外部契约、权限、发布或不可逆数据迁移')
  }

  const isOneWay = signals.length > 0
  let blastRadius = 'low'
  if (gateWeakened || highRiskHits.length >= 2 || signals.length >= 2 || files.length >= 10 || diffBytes >= 40000) {
    blastRadius = 'high'
  } else if (isOneWay || highRiskHits.length === 1 || files.length >= 4) {
    blastRadius = 'medium'
  }
  const hasHumanAuth = Boolean(gateWeakened) || (agentsText && /merge-authority\s*:\s*human/i.test(agentsText))
  const mergeAuthority = hasHumanAuth || isOneWay ? 'human-required' : (highRiskHits.length > 0 ? 'reviewer-with-fault-injection' : 'reviewer-direct')

  return {
    doorType: isOneWay ? 'one-way' : 'two-way',
    requiresHumanApproval: Boolean(gateWeakened),
    signals,
    reasons: isOneWay ? signals : ['局部可逆改动（未触碰高风险路径、外部契约或门禁定义）'],
    reason: isOneWay ? signals.join('；') : '局部可逆改动（未触碰高风险路径、外部契约或门禁定义，可无损回滚）',
    blastRadius,
    mergeAuthority,
    rollbackPath: isOneWay
      ? '单向门回退：已合并远端须发反向提交或递增版本修复（禁止改写历史）；若含数据库/Schema 迁移须附带显式降级步骤；弱化门禁改动未获 --human-approved 前阻断合并。'
      : '双向门回退：未提交变更可直接重置工作区；已开分支未合并直接关闭 PR 并删除临时分支；已合入则一键 git revert。',
  }
}

/** 按文件切分 unified diff，安全解引用带空格或 C 引号路径。 */
export function splitDiffByFile(diffText) {
  const chunks = new Map()
  const lines = String(diffText ?? '').split('\n')
  let currentFile = null
  let buf = []
  const flush = () => {
    if (currentFile !== null) chunks.set(currentFile, buf.join('\n'))
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush()
      const m = /^diff --git (?:"a\/([^"]+)"|a\/(.+?)) (?:"b\/([^"]+)"|b\/(.+))$/.exec(line)
      const rawB = m ? (m[3] !== undefined ? `"${m[3]}"` : m[4]) : null
      currentFile = rawB ? unescapeGitPath(rawB) : null
      buf = [line]
    } else if (currentFile !== null || buf.length > 0) {
      if (line.startsWith('+++ b/')) currentFile = unescapeGitPath(line.slice(6).trim())
      else if (line.startsWith('+++ "b/')) currentFile = unescapeGitPath(`"${line.slice(7).trim()}`)
      else if (line.startsWith('--- a/') && currentFile === null) currentFile = unescapeGitPath(line.slice(6).trim())
      buf.push(line)
    }
  }
  flush()
  return chunks
}

/** 提取单文件 diff 的增删行列表（支持可选 hunk 粒度拆分）。 */
export function summarizeHunkChanges(fileDiff) {
  const added = []
  const removed = []
  const hunks = []
  let curHunk = null
  for (const line of String(fileDiff ?? '').split('\n')) {
    if (line.startsWith('@@')) {
      if (curHunk) hunks.push(curHunk)
      curHunk = { header: line, added: [], removed: [] }
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      const body = line.slice(1)
      added.push(body)
      if (curHunk) curHunk.added.push(body)
    } else if (line.startsWith('-')) {
      const body = line.slice(1)
      removed.push(body)
      if (curHunk) curHunk.removed.push(body)
    }
  }
  if (curHunk) hunks.push(curHunk)
  return { added, removed, hunks }
}

/** 统一单条目门禁弱化扫描（兼顾 deterministic 与测试断言减少检测）。 */
export function detectGateWeakeningInEntry({ file, status, added = [], removed = [], hunks = null }) {
  const hits = []
  const rel = posixPath(file)
  if (!rel || /\.mdx?$|\.txt$/i.test(rel)) return hits
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const isTest = TEST_FILE_RE.test(rel)
  const isWorkflow = GATE_WORKFLOW_FILE_RE.test(rel)
  const isScriptOrCi = GATE_SHELL_OR_SCRIPT_RE.test(rel)
  const isRegexLine = (l) => /^\s*(?:const|let|var|if|else\s+if|return)\b.*\/[^/]+\//.test(l)

  if (status === 'D' && isTest) {
    hits.push({
      type: 'deleted-test-file',
      category: 'gate-weakening',
      severity: 'deterministic',
      file: rel,
      reason: `删除测试文件 ${rel}（直接削弱回归门禁）`,
      detail: `删除测试文件 ${rel}`,
      excerpt: [`- deleted ${rel}`],
    })
  }

  let inBlock = false
  let permIndent = -1
  for (const line of added) {
    const { commentText, codeText, nextInBlock } = extractLineCommentInfo(line, inBlock, ext)
    inBlock = nextInBlock
    const trimmed = line.trim()

    if (isTest && codeText.trim() && GATE_SKIP_RE.test(codeText) && !isRegexLine(line)) {
      hits.push({
        type: 'test-skip-or-only',
        category: 'gate-weakening',
        severity: 'deterministic',
        file: rel,
        reason: '新增测试 skip/only/ignore 跳过标记',
        detail: trimmed.slice(0, 120),
        excerpt: [`+ ${line}`],
      })
    }

    if (isWorkflow) {
      const indent = line.length - line.trimStart().length
      if (permIndent >= 0 && trimmed !== '' && !trimmed.startsWith('#') && indent <= permIndent) permIndent = -1
      if (/^permissions\s*:/i.test(trimmed)) permIndent = indent
      if (!commentText || codeText.trim()) {
        if (/\bcontinue-on-error\s*:\s*true\b/i.test(codeText)) {
          hits.push({ type: 'ci-continue-on-error', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '工作流步骤设置 continue-on-error: true', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
        }
        if (/^\s*(?:-\s*)?if\s*:\s*(?:false\b|\$\{\{\s*false\s*\}\})/i.test(codeText)) {
          hits.push({ type: 'ci-disabled-step', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '工作流禁用检查步骤 (if: false)', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
        }
        if (/\bpermissions\s*:\s*write-all\b|\bpull_request_target\b/i.test(codeText)
          || ((/\bpermissions\s*:/i.test(codeText) || permIndent >= 0) && GATE_CI_PERM_WRITE_RE.test(codeText))) {
          hits.push({ type: 'ci-loosened-permissions', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '放宽 CI 工作流写权限或触发边界', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
        }
      }
    }

    if (commentText && /(?:eslint-disable(?:-next-line)?|@ts-nocheck)\b/.test(commentText)) {
      hits.push({ type: 'error-suppression', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '新增静态检查屏蔽注释', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
    }

    if (!isRegexLine(line) && codeText.trim()) {
      const hasBypassFlag = /--no-verify\b|--passWithNoTests\b/.test(codeText)
      const hasOrTrue = (isScriptOrCi && GATE_SHELL_BYPASS_RE.test(codeText))
        || /\b(?:exec|spawn|execSync|execFileSync|run)\w*\s*\([^)\n]*\|\|\s*true\b/.test(codeText)
      if (hasBypassFlag || hasOrTrue) {
        hits.push({ type: 'shell-or-true', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '新增校验旁路标记（--no-verify / || true）', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
      }
    }
  }

  if (isTest) {
    const hunkList = Array.isArray(hunks) && hunks.length > 0 ? hunks : [{ added, removed }]
    for (const hk of hunkList) {
      const remAsserts = hk.removed.filter((l) => {
        const info = extractLineCommentInfo(l, false, ext)
        return info.codeText.trim() && GATE_ASSERTION_RE.test(info.codeText)
      })
      const addAsserts = hk.added.filter((l) => {
        const info = extractLineCommentInfo(l, false, ext)
        return info.codeText.trim() && GATE_ASSERTION_RE.test(info.codeText)
      })
      if (remAsserts.length > addAsserts.length) {
        hits.push({
          type: 'deleted-assertion',
          category: 'gate-weakening',
          severity: 'advisory',
          file: rel,
          reason: `测试断言净减少（-${remAsserts.length} / +${addAsserts.length}）`,
          detail: `测试断言净减少（-${remAsserts.length} / +${addAsserts.length}）`,
          excerpt: remAsserts.slice(0, 4).map((l) => `- ${l}`),
        })
      }
    }
  }
  return hits
}

/** 扫描仓库 diff 中可能弱化验证门禁的改动，返回精确命中列表。 */
export async function detectGateWeakening(implRoot, baseRef, baseBranch) {
  let ref = baseRef
  const headRes = await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const headSha = headRes.ok ? headRes.stdout.trim() : null

  if (!ref && baseBranch) {
    const brRes = await gitRun(implRoot, ['rev-parse', '--verify', baseBranch])
    if (brRes.ok && brRes.stdout.trim() !== headSha) ref = baseBranch
  }
  if (!ref) return []

  const [diffRes, nsRes] = await Promise.all([
    gitRunBuffer(implRoot, ['diff', '--unified=3', '--no-ext-diff', '--no-color', `${ref}..HEAD`]),
    gitRunBuffer(implRoot, ['diff', '--name-status', '-z', `${ref}..HEAD`]),
  ])
  if (!diffRes.ok) return []

  const diffText = diffRes.stdout.toString('utf8').replace(/\r\n/g, '\n')
  const chunks = splitDiffByFile(diffText)
  const statusMap = new Map()
  if (nsRes.ok) {
    const tokens = nsRes.stdout.toString('utf8').split('\0')
    for (let i = 0; i < tokens.length; i += 1) {
      const st = tokens[i]
      if (!st) continue
      if (/^[RC]/.test(st)) { statusMap.set(posixPath(tokens[i + 2] ?? ''), st); i += 2 }
      else { statusMap.set(posixPath(tokens[i + 1] ?? ''), st); i += 1 }
    }
  }

  const files = [...new Set([...chunks.keys(), ...statusMap.keys()])].filter(Boolean)
  const findings = []
  for (const file of files) {
    const chunk = chunks.get(file) ?? ''
    const { added, removed, hunks } = summarizeHunkChanges(chunk)
    const status = statusMap.get(file) ?? 'M'
    findings.push(...detectGateWeakeningInEntry({ file, status, added, removed, hunks }))
  }
  return findings
}

/** 扫描源码增行中的履历注释、借口压制与大文件指标。 */
export function scanStructuralHygiene({ fileRel, lines = [], fullLineCount = 0, warnLines = 800, highLines = 1500 }) {
  const ext = posixPath(fileRel).split('.').pop()?.toLowerCase() ?? ''
  const tombstoneComments = []
  const excuseSuppressions = []
  let inBlock = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const { commentText, nextInBlock } = extractLineCommentInfo(line, inBlock, ext)
    inBlock = nextInBlock
    if (commentText && TOMBSTONE_COMMENT_RE.test(commentText)) {
      tombstoneComments.push({ file: fileRel, line: i + 1, excerpt: line.trim().slice(0, 120) })
    }
    if ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(line)) {
      excuseSuppressions.push({ file: fileRel, line: i + 1, excerpt: line.trim().slice(0, 120) })
    }
  }

  const godFile = (!TEST_FILE_RE.test(fileRel) && !fileRel.endsWith('.min.js') && fullLineCount > warnLines)
    ? { file: fileRel, lines: fullLineCount, severity: fullLineCount > highLines ? 'high' : 'warn' }
    : null

  return { tombstoneComments, excuseSuppressions, godFile }
}
