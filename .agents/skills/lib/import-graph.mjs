/**
 * import-graph.mjs —— 多语言静态导入解析与仓内相对路径目标映射（单一真相源）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 static-gates.mjs（arch-rules）与
 * static-analyzer.mjs（依赖图/耦合度/多图证据）共同复用，杜绝多套导入正则分叉。
 */

import { join, posix as pathPosix } from 'node:path'

import { posixPath, readTextSafe } from './git.mjs'
import { stripCodeCommentsLines } from './static-gates-lexer.mjs'

const JS_TS_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts'])
const FALLBACK_CODE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts', '.py', '.rs', '.go', '.java', '.kt', '.kts']
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs', 'index.jsx', '__init__.py', 'mod.rs']

/** 读取仓库根 `go.mod` 与 `go.work` 声明的本地 Go 模块前缀映射。 */
export function resolveGoModules(repoRoot) {
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

/**
 * 按文件扩展名与导入指示符生成仓内候选相对路径（单一真相源，供静态抽取与缓存重建共用）。
 */
export function expandImportCandidates(relFile, specifier, { goModules = [], kind = 'import' } = {}) {
  const normFile = posixPath(relFile)
  const ext = normFile.toLowerCase().split('.').pop() ?? ''
  const curDir = pathPosix.dirname(normFile)
  const spec = String(specifier ?? '').trim()
  if (!spec) return []

  if (JS_TS_EXTS.has(ext)) {
    if (spec.startsWith('.')) {
      const base = pathPosix.normalize(pathPosix.join(curDir, spec))
      return [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.ts`]
    }
    const cands = [spec]
    if (spec.startsWith('@/')) cands.push(`src/${spec.slice(2)}`)
    return cands
  }

  if (ext === 'py') {
    const dotM = /^(\.+)(.*)$/.exec(spec)
    if (dotM) {
      let base = curDir
      for (let up = 1; up < dotM[1].length; up += 1) base = pathPosix.dirname(base)
      const sub = dotM[2].replace(/\./g, '/')
      const joined = sub ? pathPosix.normalize(base === '.' ? sub : pathPosix.join(base, sub)) : base
      return [joined, `${joined}.py`, `${joined}/__init__.py`]
    }
    const slash = spec.replace(/\./g, '/')
    return [slash, `${slash}.py`, `${slash}/__init__.py`]
  }

  if (ext === 'go') {
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
    return cands
  }

  if (ext === 'java' || ext === 'kt' || ext === 'kts') {
    const slash = spec.replace(/\./g, '/')
    return [slash, `${slash}.${ext}`, `src/main/java/${slash}.java`]
  }

  if (ext === 'rs') {
    if (kind === 'mod') {
      const joined = curDir === '.' ? spec : pathPosix.join(curDir, spec)
      return [`${joined}.rs`, `${joined}/mod.rs`]
    }
    const slash = spec.replace(/::/g, '/')
    const parentSlash = slash.includes('/') ? slash.slice(0, slash.lastIndexOf('/')) : ''
    const cands = [slash, `src/${slash}`, `src/${slash}.rs`, `src/${slash}/mod.rs`]
    if (parentSlash) cands.push(`src/${parentSlash}.rs`, `src/${parentSlash}/mod.rs`)
    return cands
  }

  return [spec]
}

/**
 * 剥离注释后按语言提取静态导入条目 `{ line, specifier, kind?, candidates }`。
 * 支持 JS/TS、Python、Go、Java/Kotlin、Rust。
 */
export function extractImportsForArch(relFile, text, goModules = []) {
  const results = []
  const ext = posixPath(relFile).toLowerCase().split('.').pop() ?? ''
  const codeLines = stripCodeCommentsLines(text, ext)
  const stripped = codeLines.join('\n')

  if (JS_TS_EXTS.has(ext)) {
    const patterns = [
      /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const re of patterns) {
      for (const m of stripped.matchAll(re)) {
        const spec = m[1].trim()
        if (!spec) continue
        const line = stripped.slice(0, m.index ?? 0).split('\n').length
        results.push({ line, specifier: spec, candidates: expandImportCandidates(relFile, spec, { goModules }) })
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
        results.push({ line: i + 1, specifier: mod, candidates: expandImportCandidates(relFile, mod, { goModules }) })
        continue
      }
      const impM = /^import\s+([A-Za-z0-9_.,\s]+)$/.exec(code)
      if (impM) {
        for (const seg of impM[1].split(',')) {
          const mod = seg.trim().split(/\s+as\s+/i)[0].trim()
          if (!mod) continue
          results.push({ line: i + 1, specifier: mod, candidates: expandImportCandidates(relFile, mod, { goModules }) })
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
      results.push({ line: i + 1, specifier: spec, candidates: expandImportCandidates(relFile, spec, { goModules }) })
    }
    return results
  }

  if (ext === 'java' || ext === 'kt' || ext === 'kts') {
    for (let i = 0; i < codeLines.length; i += 1) {
      const m = /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)(?:\.\*)?\s*;?/.exec(codeLines[i])
      if (!m) continue
      const spec = m[1]
      results.push({ line: i + 1, specifier: spec, candidates: expandImportCandidates(relFile, spec, { goModules }) })
    }
    return results
  }

  if (ext === 'rs') {
    for (let i = 0; i < codeLines.length; i += 1) {
      const useM = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?:crate::|self::|super::)?([A-Za-z0-9_:]+)/.exec(codeLines[i])
      if (useM) {
        const spec = useM[1]
        results.push({ line: i + 1, specifier: spec, candidates: expandImportCandidates(relFile, spec, { goModules }) })
        continue
      }
      const modM = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z0-9_]+)\s*;/.exec(codeLines[i])
      if (modM) {
        const name = modM[1]
        results.push({ line: i + 1, specifier: name, kind: 'mod', candidates: expandImportCandidates(relFile, name, { goModules, kind: 'mod' }) })
      }
    }
  }
  return results
}

/** 按目录分组索引仓内文件列表，加速 Go 包目录及后缀回退解析。 */
export function buildDirFileIndex(fileSet) {
  const dirMap = new Map()
  for (const rel of fileSet ?? []) {
    const norm = posixPath(rel).replace(/^\.\//, '').replace(/^\/+/, '')
    if (!norm) continue
    const dir = pathPosix.dirname(norm)
    if (!dirMap.has(dir)) dirMap.set(dir, [])
    dirMap.get(dir).push(norm)
  }
  for (const list of dirMap.values()) list.sort()
  return dirMap
}

function normCandidate(raw) {
  const clean = posixPath(String(raw ?? '').trim()).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) return ''
  return clean
}

/**
 * 将导入候选列表精确映射到仓内已有文件的相对路径（找不到则返回 `null`）。
 * 兼容 TS ESM `.js -> .ts/.tsx` 映射、无后缀索引补全与 Go 包目录回退。
 */
export function resolveLocalImportTarget(candidates, fileSet, { dirIndex = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !fileSet || fileSet.size === 0) return null
  const idx = dirIndex ?? null

  const lookupGoPkg = (pkgDir) => {
    if (!pkgDir) return null
    const list = idx ? idx.get(pkgDir) : [...fileSet].filter((f) => pathPosix.dirname(f) === pkgDir).sort()
    if (!list || list.length === 0) return null
    const nonTest = list.find((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    return nonTest ?? list.find((f) => f.endsWith('.go')) ?? null
  }

  for (const raw of candidates) {
    const c = normCandidate(raw)
    if (!c) continue
    if (fileSet.has(c)) return c

    if (c.endsWith('/_.go')) {
      const hit = lookupGoPkg(c.slice(0, -5))
      if (hit) return hit
      continue
    }

    if (/\.(?:js|mjs|cjs)$/i.test(c)) {
      const stem = c.replace(/\.(?:js|mjs|cjs)$/i, '')
      for (const alt of ['.ts', '.tsx', '.mts', '.cts', '.jsx']) {
        if (fileSet.has(`${stem}${alt}`)) return `${stem}${alt}`
      }
    }

    for (const ext of FALLBACK_CODE_EXTS) {
      if (fileSet.has(`${c}${ext}`)) return `${c}${ext}`
    }
    for (const idxFile of INDEX_FILES) {
      const joined = `${c}/${idxFile}`
      if (fileSet.has(joined)) return joined
    }
    const goHit = lookupGoPkg(c)
    if (goHit) return goHit
  }
  return null
}
