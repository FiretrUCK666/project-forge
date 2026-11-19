/**
 * equip-integrity.mjs —— `equip` 合并/升级落盘后的语法与静态 ESM ABI 一致性守门器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）：
 *   1. 对 `.agents/skills/` 下全部 `.mjs` 脚本逐一执行 `node --check` 校验语法完整；
 *   2. 静态解析全部相对 `import`/`export` 声明，校验跨模块文件存在性与具名导出符号 ABI；
 *   3. 任一校验失败时立即经 `backup.mjs` 仓外备份（或写前内存快照）瞬时回滚恢复。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { restoreBackup } from '../backup.mjs'
import { writeAtomic } from './fs-atomic.mjs'
import { isMacOsMetadata } from './protocol.mjs'
import { posixPath } from './text.mjs'

function stripCommentsAndStringsForEsm(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

export function walkMjsFiles(rootDir) {
  const files = []
  if (!existsSync(rootDir)) return files
  const stack = [resolve(rootDir)]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { continue }
    for (const e of entries) {
      if (isMacOsMetadata(e.name) || e.name.startsWith('.')) continue
      const abs = join(cur, e.name)
      if (e.isDirectory()) stack.push(abs)
      else if (e.isFile() && e.name.endsWith('.mjs')) files.push(abs)
    }
  }
  return files.sort()
}

const SYNTAX_VERIFIED_SHA256 = new Set()

/** 对目标 `.mjs` 文件列表逐一运行 `node --check` 校验语法完整。 */
export function runNodeSyntaxCheck(mjsFiles, baseDir = '') {
  const syntaxErrors = []
  for (const abs of mjsFiles) {
    let hash = null
    try {
      hash = createHash('sha256').update(readFileSync(abs)).digest('hex')
      if (SYNTAX_VERIFIED_SHA256.has(hash)) continue
    } catch { /* fallback to check */ }
    const res = spawnSync(process.execPath, ['--check', abs], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    if (res.status !== 0) {
      const rel = baseDir ? posixPath(relative(baseDir, abs)) : posixPath(abs)
      syntaxErrors.push({
        file: rel,
        message: String(res.stderr || res.stdout || `node --check exited ${res.status}`).trim().split('\n').slice(0, 3).join(' '),
      })
    } else if (hash) {
      SYNTAX_VERIFIED_SHA256.add(hash)
    }
  }
  return syntaxErrors
}

function parseNamedList(rawSpecList) {
  const names = []
  for (const raw of String(rawSpecList ?? '').split(',')) {
    const part = raw.trim()
    if (!part) continue
    const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part)
    if (asMatch) names.push({ imported: asMatch[1], local: asMatch[2] })
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) names.push({ imported: part, local: part })
  }
  return names
}

/** 静态提取单份 ESM 模块的声明导出、重导出星号与相对导入需求。 */
export function parseEsmModuleInterface(sourceText) {
  const clean = stripCommentsAndStringsForEsm(String(sourceText ?? '').replace(/\r\n/g, '\n'))
  const directExports = new Set()
  const starReExports = []
  const namedReExports = []
  const relativeImports = []

  // export function|async function|class|const|let|var NAME
  for (const m of clean.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm)) {
    directExports.add(m[1])
  }
  // export const { a, b } = ... / export const [a, b] = ...
  for (const m of clean.matchAll(/^\s*export\s+(?:const|let|var)\s*\{([^}]+)\}\s*=/gm)) {
    for (const item of m[1].split(',')) {
      const tok = item.trim().split(':').pop()?.split('=')[0]?.trim()
      if (tok && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok)) directExports.add(tok)
    }
  }
  if (/^\s*export\s+default\b/m.test(clean)) directExports.add('default')

  // export { a, b as c } [from './x.mjs']
  for (const m of clean.matchAll(/^\s*export\s*\{([\s\S]*?)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    const items = parseNamedList(m[1])
    const fromSpec = m[2]?.trim() || null
    for (const it of items) directExports.add(it.local)
    if (fromSpec && (fromSpec.startsWith('./') || fromSpec.startsWith('../'))) {
      namedReExports.push({ spec: fromSpec, items })
    }
  }

  // export * as ns from './x.mjs' / export * from './x.mjs'
  for (const m of clean.matchAll(/^\s*export\s*\*\s*(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+)?from\s*['"]([^'"]+)['"]/gm)) {
    const alias = m[1]?.trim() || null
    const spec = m[2].trim()
    if (alias) directExports.add(alias)
    if (spec.startsWith('./') || spec.startsWith('../')) {
      if (!alias) starReExports.push(spec)
      relativeImports.push({ spec, names: [], kind: 'export-star' })
    }
  }

  // import { a, b as c } from './x.mjs' / import def, { a } from './x.mjs' / import * as ns from './x.mjs'
  for (const m of clean.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1].trim()
    const spec = m[2].trim()
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue
    const names = []
    const braceMatch = /\{([\s\S]*?)\}/.exec(clause)
    if (braceMatch) {
      for (const it of parseNamedList(braceMatch[1])) names.push(it.imported)
    }
    const beforeBrace = braceMatch ? clause.slice(0, braceMatch.index).replace(/,\s*$/, '').trim() : clause
    if (beforeBrace && !beforeBrace.startsWith('*') && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(beforeBrace)) {
      names.push('default')
    }
    relativeImports.push({ spec, names, kind: 'import' })
  }

  // import './side-effect.mjs'
  for (const m of clean.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) {
    relativeImports.push({ spec: m[1].trim(), names: [], kind: 'side-effect' })
  }

  return { directExports, starReExports, namedReExports, relativeImports }
}

/** 静态扫描目录内全部 `.mjs` 文件的跨模块 ESM `import`/`export` ABI 一致性。 */
export function checkStaticEsmAbi(skillsDir) {
  const mjsFiles = walkMjsFiles(skillsDir)
  const parsedByAbs = new Map()
  for (const abs of mjsFiles) {
    try {
      const src = readFileSync(abs, 'utf8')
      parsedByAbs.set(resolve(abs), parseEsmModuleInterface(src))
    } catch {
      parsedByAbs.set(resolve(abs), { directExports: new Set(), starReExports: [], namedReExports: [], relativeImports: [] })
    }
  }

  const resolveExportSet = (absFile, visited = new Set()) => {
    const key = resolve(absFile)
    if (visited.has(key)) return new Set()
    visited.add(key)
    let mod = parsedByAbs.get(key)
    if (!mod && existsSync(key)) {
      try {
        mod = parseEsmModuleInterface(readFileSync(key, 'utf8'))
        parsedByAbs.set(key, mod)
      } catch {
        return new Set()
      }
    }
    if (!mod) return new Set()
    const exports = new Set(mod.directExports)
    for (const starSpec of mod.starReExports) {
      const targetAbs = resolve(dirname(key), starSpec)
      for (const sym of resolveExportSet(targetAbs, visited)) exports.add(sym)
    }
    return exports
  }

  const abiErrors = []
  for (const abs of mjsFiles) {
    const rel = posixPath(relative(skillsDir, abs))
    const mod = parsedByAbs.get(resolve(abs))
    if (!mod) continue

    for (const imp of mod.relativeImports) {
      const targetAbs = resolve(dirname(abs), imp.spec)
      if (!existsSync(targetAbs)) {
        abiErrors.push({ file: rel, spec: imp.spec, kind: 'missing-target', message: `${rel} 导入不存在的目标文件 ${imp.spec}` })
        continue
      }
      if (imp.names.length > 0) {
        const exported = resolveExportSet(targetAbs)
        for (const sym of imp.names) {
          if (!exported.has(sym)) {
            abiErrors.push({
              file: rel,
              spec: imp.spec,
              symbol: sym,
              kind: 'missing-export',
              message: `${rel} 导入的符号「${sym}」未在 ${imp.spec} 中导出`,
            })
          }
        }
      }
    }

    for (const reExp of mod.namedReExports) {
      const targetAbs = resolve(dirname(abs), reExp.spec)
      if (!existsSync(targetAbs)) {
        abiErrors.push({ file: rel, spec: reExp.spec, kind: 'missing-target', message: `${rel} 重导出不存在的目标文件 ${reExp.spec}` })
        continue
      }
      const exported = resolveExportSet(targetAbs)
      for (const item of reExp.items) {
        if (!exported.has(item.imported)) {
          abiErrors.push({
            file: rel,
            spec: reExp.spec,
            symbol: item.imported,
            kind: 'missing-export',
            message: `${rel} 重导出的符号「${item.imported}」未在 ${reExp.spec} 中导出`,
          })
        }
      }
    }
  }
  return abiErrors
}

/** 落盘前捕获待改写文件的内存快照，用于在 `--no-backup` 场景下也能瞬时无损回滚。 */
export function captureMemoryRollbackSnapshot(filePaths = []) {
  const snap = []
  for (const abs of filePaths) {
    if (existsSync(abs)) {
      snap.push({ abs, existed: true, buf: readFileSync(abs) })
    } else {
      snap.push({ abs, existed: false, buf: null })
    }
  }
  return snap
}

function restoreMemorySnapshot(snap) {
  for (const entry of snap ?? []) {
    if (entry.existed && entry.buf !== null) {
      mkdirSync(dirname(entry.abs), { recursive: true })
      writeAtomic(entry.abs, entry.buf)
    } else if (!entry.existed && existsSync(entry.abs)) {
      try { unlinkSync(entry.abs) } catch { /* ignore */ }
    }
  }
}

/**
 * 合并/升级后完整校验 `.agents/skills/` 下全部 `.mjs` 语法（`node --check`）与静态 ESM ABI；
 * 任一失败立即通过 `backup.mjs`（或内存快照）回滚并抛出/返回完整诊断。
 */
export function verifyEquippedIntegrityOrRollback({
  root,
  skillsDir,
  backupInfo = null,
  memorySnapshot = [],
  targetFiles = null,
  skipPristineSyntaxCheck = false,
} = {}) {
  const mjsFiles = walkMjsFiles(skillsDir)
  const syntaxTargets = Array.isArray(targetFiles) ? targetFiles.filter((p) => existsSync(p) && p.endsWith('.mjs')) : mjsFiles
  const syntaxErrors = skipPristineSyntaxCheck ? [] : runNodeSyntaxCheck(syntaxTargets, skillsDir)
  const abiErrors = syntaxErrors.length === 0 ? checkStaticEsmAbi(skillsDir) : []

  if (syntaxErrors.length === 0 && abiErrors.length === 0) {
    return {
      ok: true,
      checkedFiles: mjsFiles.length,
      syntaxErrors: [],
      abiErrors: [],
      rolledBack: false,
    }
  }

  let rollbackMethod = 'memory-snapshot'
  let rolledBack = false
  if (backupInfo?.created && backupInfo.path && existsSync(backupInfo.path)) {
    try {
      restoreBackup(root, { file: backupInfo.path, noPreBackup: true })
      rollbackMethod = 'backup-archive'
      rolledBack = true
    } catch {
      restoreMemorySnapshot(memorySnapshot)
      rolledBack = true
    }
  } else {
    restoreMemorySnapshot(memorySnapshot)
    rolledBack = true
  }

  return {
    ok: false,
    checkedFiles: mjsFiles.length,
    syntaxErrors,
    abiErrors,
    rolledBack,
    rollbackMethod,
  }
}
