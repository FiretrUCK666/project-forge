/**
 * static-analyzer.mjs —— 零 Token、纯 Node 18+ 增量静态分析器。
 *
 * 复用 `import-graph.mjs`、`symbol-index.mjs` 与 `doc-graph.mjs` 的 `findSccs`，
 * 构建全仓模块导入图、耦合指标（fanIn/fanOut/cycles）与 Git 热度，
 * 增量缓存落盘至 `<gitCommonDir>/project-forge-flow/analysis-cache.json`（零工作区污染）。
 */

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { findSccs } from './doc-graph.mjs'
import {
  BROAD_CODE_EXT_RE, COMMON_SKIP_DIRS, gitLsFilesTextAndCode, gitRun, gitRunBuffer,
  isMacOsJunkPath, posixPath, readJsonSafe, readTextSafe, writeAtomic,
} from './git.mjs'
import { readGitIndexPathsFast, readHeadFast, resolveCommonGitDir, resolveGitDirFast } from './git-fast.mjs'
import { isCleanWorktreeFast } from './git-status-fast.mjs'
import { buildDirFileIndex, expandImportCandidates, extractImportsForArch, resolveGoModules, resolveLocalImportTarget } from './import-graph.mjs'
import { extractSymbols, isSymbolCandidatePath } from './symbol-index.mjs'

export const ANALYSIS_CACHE_SCHEMA_VERSION = 2
export const MAX_ANALYZE_FILE_BYTES = 512 * 1024
export const MAX_ANALYSIS_CACHE_BYTES = 128 * 1024 * 1024

/**
 * 解析仓外静态分析增量缓存路径：
 * Git 仓落在 `<gitCommonDir>/project-forge-flow/analysis-cache.json`，
 * 非 Git 仓回退 `<repoRoot>/.worktrees/.state/analysis-cache.json`。
 */
export function resolveAnalysisCachePath(repoRoot, cacheRoot = null) {
  const root = resolve(String(cacheRoot || repoRoot || process.cwd()))
  const commonDir = resolveCommonGitDir(root)
  if (commonDir) return join(commonDir, 'project-forge-flow', 'analysis-cache.json')
  return join(root, '.worktrees', '.state', 'analysis-cache.json')
}

function countLinesFast(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  if (!norm) return 0
  const parts = norm.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

function isCodeAnalyzable(rel) {
  const p = posixPath(rel)
  return BROAD_CODE_EXT_RE.test(p) || isSymbolCandidatePath(p)
}

function loadAnalysisCache(cachePath) {
  if (!existsSync(cachePath)) return { files: {}, existed: false, recovered: false }
  const raw = readJsonSafe(cachePath, MAX_ANALYSIS_CACHE_BYTES)
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== ANALYSIS_CACHE_SCHEMA_VERSION || !raw.files || typeof raw.files !== 'object') {
    return { files: {}, existed: true, recovered: true }
  }
  return { files: raw.files, existed: true, recovered: false }
}

function serializeBoundedCache(filesMap, maxBytes = MAX_ANALYSIS_CACHE_BYTES) {
  const fullPayload = JSON.stringify({ schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, files: filesMap })
  const fullBytes = Buffer.byteLength(fullPayload, 'utf8')
  if (fullBytes <= maxBytes) return { payload: fullPayload, bytes: fullBytes, truncated: false }
  const header = `{"schemaVersion":${ANALYSIS_CACHE_SCHEMA_VERSION},"files":{`
  const footer = '}}'
  let curBytes = Buffer.byteLength(header, 'utf8') + Buffer.byteLength(footer, 'utf8')
  const parts = []
  for (const key of Object.keys(filesMap).sort()) {
    const entryStr = `${JSON.stringify(key)}:${JSON.stringify(filesMap[key])}`
    const addBytes = Buffer.byteLength(entryStr, 'utf8') + (parts.length > 0 ? 1 : 0)
    if (curBytes + addBytes > maxBytes) break
    parts.push(entryStr)
    curBytes += addBytes
  }
  if (parts.length === 0) return { payload: null, bytes: fullBytes, truncated: true }
  const bounded = `${header}${parts.join(',')}${footer}`
  return { payload: bounded, bytes: Buffer.byteLength(bounded, 'utf8'), truncated: true }
}

function parseGitIndexBlobShas(lsBuf, diffBuf) {
  const shaMap = new Map()
  const dirtySet = new Set()
  if (lsBuf) {
    for (const tok of lsBuf.toString('utf8').split('\0')) {
      if (!tok) continue
      const tab = tok.indexOf('\t')
      if (tab < 0) continue
      const meta = tok.slice(0, tab).trim().split(/\s+/)
      const sha = meta[1]
      const rel = posixPath(tok.slice(tab + 1)).replace(/^\.\//, '')
      if (rel && sha && /^[0-9a-f]{40,64}$/i.test(sha)) shaMap.set(rel, sha)
    }
  }
  if (diffBuf) {
    for (const tok of diffBuf.toString('utf8').split('\0')) {
      const rel = posixPath(tok).replace(/^\.\//, '')
      if (rel) dirtySet.add(rel)
    }
  }
  return { shaMap, dirtySet }
}

async function readGitIndexBlobShas(repoRoot) {
  const [lsRes, diffRes] = await Promise.all([
    gitRunBuffer(repoRoot, ['--no-optional-locks', 'ls-files', '-s', '-z']),
    gitRunBuffer(repoRoot, ['--no-optional-locks', 'diff-files', '--name-only', '-z']),
  ])
  return parseGitIndexBlobShas(lsRes.ok ? lsRes.stdout : null, diffRes.ok ? diffRes.stdout : null)
}

function gitExecSyncSafe(cwd, args, asBuffer = false) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: asBuffer ? 'buffer' : 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout: out }
  } catch {
    return { ok: false, stdout: asBuffer ? Buffer.alloc(0) : '' }
  }
}

function probeBinarySync(filePath) {
  let fd
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return { exists: false, isBinary: false, size: 0 }
    if (st.size === 0) return { exists: true, isBinary: false, size: 0 }
    const len = Math.min(4096, st.size)
    const buf = Buffer.allocUnsafe(len)
    fd = openSync(filePath, 'r')
    const n = readSync(fd, buf, 0, len, 0)
    for (let i = 0; i < n; i += 1) if (buf[i] === 0) return { exists: true, isBinary: true, size: st.size }
    return { exists: true, isBinary: false, size: st.size }
  } catch {
    return { exists: false, isBinary: false, size: 0 }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
  }
}

function listFilesSync(root, { isGit = true, maxFiles = 50000 } = {}) {
  const files = []
  let truncated = false
  const pushFile = (relPath) => {
    const rel = posixPath(relPath).replace(/^(?:\.\/)+/, '')
    if (!rel || isMacOsJunkPath(rel)) return
    const segs = rel.split('/')
    if (segs.slice(0, -1).some((s) => COMMON_SKIP_DIRS.has(s))) return
    const full = join(root, rel)
    const probe = probeBinarySync(full)
    if (!probe.exists) return
    if (files.length >= maxFiles) { truncated = true; return }
    files.push({ rel, name: basename(rel), full, size: probe.size, isBinary: probe.isBinary, isText: !probe.isBinary })
  }

  if (isGit) {
    const fastIdxPaths = isCleanWorktreeFast(root)?.clean ? readGitIndexPathsFast(root) : null
    if (fastIdxPaths) {
      for (const p of [...fastIdxPaths].sort()) { if (truncated) break; pushFile(p) }
      return { files, truncated }
    }
    const res = gitExecSyncSafe(root, ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], true)
    if (res.ok) {
      for (const p of res.stdout.toString('utf8').split('\0').filter(Boolean).sort()) {
        if (truncated) break
        pushFile(p)
      }
      return { files, truncated }
    }
  }

  const queue = [root]
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacOsJunkPath(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(root, full))
      if (entry.isDirectory()) {
        if (!COMMON_SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        pushFile(rel)
        if (truncated) break
      }
    }
  }
  return { files, truncated }
}

function readGitIndexBlobShasSync(repoRoot) {
  const lsRes = gitExecSyncSafe(repoRoot, ['--no-optional-locks', 'ls-files', '-s', '-z'], true)
  const diffRes = gitExecSyncSafe(repoRoot, ['--no-optional-locks', 'diff-files', '--name-only', '-z'], true)
  return parseGitIndexBlobShas(lsRes.ok ? lsRes.stdout : null, diffRes.ok ? diffRes.stdout : null)
}

function isCacheEntryFresh(cached, { blobSha, mtimeMs, size }) {
  if (!cached || typeof cached !== 'object') return false
  if (cached.size !== size) return false
  if (blobSha) return cached.blobSha === blobSha
  return !cached.blobSha && cached.mtimeMs === mtimeMs
}

function parseGitHistoryOutputs(logRes, tagRes) {
  const churn = {}
  const merges = []
  const tags = []
  let degradedReason = null
  if (!logRes.ok) {
    degradedReason = 'git-log-unavailable'
  } else if (logRes.stdout) {
    let curDate = null
    for (const rawLine of logRes.stdout.replace(/\r\n/g, '\n').split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('__PF_C__')) {
        const [sha, date, parentsRaw, subject] = line.slice(8).split('\x1f')
        curDate = date || null
        const parents = String(parentsRaw || '').trim().split(/\s+/).filter(Boolean)
        if (parents.length >= 2) {
          merges.push({
            sha: (sha || '').slice(0, 12),
            date: curDate,
            subject: (subject || '').trim(),
            parents: parents.map((p) => p.slice(0, 12)),
          })
        }
        continue
      }
      const rel = posixPath(line).replace(/^\.\//, '')
      if (!rel) continue
      if (!churn[rel]) {
        churn[rel] = { commits: 1, lastAt: curDate }
      } else {
        churn[rel].commits += 1
        if (!churn[rel].lastAt && curDate) churn[rel].lastAt = curDate
      }
    }
  }

  if (tagRes.ok && tagRes.stdout) {
    for (const rawLine of tagRes.stdout.replace(/\r\n/g, '\n').split('\n')) {
      if (!rawLine.trim()) continue
      const [name, date, sha, ...rest] = rawLine.split('\t')
      if (!name) continue
      tags.push({
        name: name.trim(),
        date: (date || '').trim() || null,
        sha: (sha || '').trim() || null,
        subject: rest.join('\t').trim(),
      })
    }
  }

  return { churn, merges, tags, degradedReason }
}

async function collectGitHistory(repoRoot, maxChurnCommits) {
  const limit = Math.max(1, Math.min(2000, Number(maxChurnCommits) || 200))
  const [logRes, tagRes] = await Promise.all([
    gitRun(repoRoot, [
      '--no-optional-locks', 'log', '-n', String(limit),
      '--name-only', '--format=__PF_C__%H%x1f%aI%x1f%P%x1f%s',
    ]),
    gitRun(repoRoot, [
      '--no-optional-locks', 'for-each-ref', '--sort=-creatordate',
      '--format=%(refname:short)%09%(creatordate:iso-strict)%09%(objectname:short)%09%(subject)',
      'refs/tags',
    ]),
  ])
  return parseGitHistoryOutputs(logRes, tagRes)
}

function collectGitHistorySync(repoRoot, maxChurnCommits) {
  const limit = Math.max(1, Math.min(2000, Number(maxChurnCommits) || 200))
  const logRes = gitExecSyncSafe(repoRoot, [
    '--no-optional-locks', 'log', '-n', String(limit),
    '--name-only', '--format=__PF_C__%H%x1f%aI%x1f%P%x1f%s',
  ], false)
  const tagRes = gitExecSyncSafe(repoRoot, [
    '--no-optional-locks', 'for-each-ref', '--sort=-creatordate',
    '--format=%(refname:short)%09%(creatordate:iso-strict)%09%(objectname:short)%09%(subject)',
    'refs/tags',
  ], false)
  return parseGitHistoryOutputs(logRes, tagRes)
}

function buildEmptyAnalysis(root, cachePath, useCache) {
  return {
    repoRoot: root,
    isGit: false,
    degradedReason: 'missing-repo-root',
    repoFiles: [],
    nodes: [],
    edges: [],
    coupling: {},
    cycles: [],
    churn: {},
    tags: [],
    merges: [],
    cacheStats: { hits: 0, misses: 0, total: 0, cachePath, useCache, recovered: false },
  }
}

function finalizeAnalysisGraph({ root, cachePath, isGit, listedFiles, gitIndexState, history, useCache }) {
  const validTextFiles = listedFiles.filter((f) => !f.isBinary && f.size <= MAX_ANALYZE_FILE_BYTES)
  const repoFiles = validTextFiles.map((f) => f.rel).sort()
  const codeFiles = validTextFiles.filter((f) => isCodeAnalyzable(f.rel))

  const goModules = resolveGoModules(root)
  const cacheState = useCache ? loadAnalysisCache(cachePath) : { files: {}, existed: false, recovered: false }
  const prevCacheFiles = cacheState.files
  const nextCacheFiles = {}

  let hits = 0
  let misses = 0
  const analyzedByRel = new Map()

  for (const f of codeFiles) {
    let mtimeMs = 0
    let size = f.size
    try {
      const st = statSync(f.full)
      mtimeMs = Math.trunc(st.mtimeMs)
      size = st.size
    } catch { continue }

    const blobSha = isGit && !gitIndexState.dirtySet.has(f.rel)
      ? (gitIndexState.shaMap.get(f.rel) ?? null)
      : null
    const prev = useCache ? prevCacheFiles[f.rel] : null

    if (useCache && isCacheEntryFresh(prev, { blobSha, mtimeMs, size })) {
      hits += 1
      nextCacheFiles[f.rel] = prev
      analyzedByRel.set(f.rel, prev)
      continue
    }

    misses += 1
    const text = readTextSafe(f.full, MAX_ANALYZE_FILE_BYTES)
    if (text === undefined) continue
    const ext = f.rel.includes('.') ? f.rel.split('.').pop().toLowerCase() : ''
    const rawImports = extractImportsForArch(f.rel, text, goModules)
    const compactImports = rawImports.map((imp) => (
      imp.kind && imp.kind !== 'import'
        ? { specifier: imp.specifier, line: imp.line, kind: imp.kind }
        : { specifier: imp.specifier, line: imp.line }
    ))
    const symInfo = extractSymbols(text, ext)
    const entry = {
      blobSha,
      mtimeMs,
      size,
      imports: compactImports,
      symbols: symInfo.symbols,
      symbolSupported: symInfo.supported,
      lang: symInfo.lang,
      metrics: {
        lines: countLinesFast(text),
        bytes: size,
        ext,
      },
    }
    nextCacheFiles[f.rel] = entry
    analyzedByRel.set(f.rel, entry)
  }

  let cacheTruncated = false
  let cacheBytes = 0
  const prevKeysCount = Object.keys(prevCacheFiles).length
  const nextKeysCount = Object.keys(nextCacheFiles).length
  const shouldWriteCache = useCache && (misses > 0 || cacheState.recovered || !cacheState.existed || prevKeysCount !== nextKeysCount)
  if (shouldWriteCache && (nextKeysCount > 0 || cacheState.recovered)) {
    try {
      const serialized = serializeBoundedCache(nextCacheFiles, MAX_ANALYSIS_CACHE_BYTES)
      cacheTruncated = serialized.truncated
      cacheBytes = serialized.bytes
      if (serialized.payload !== null) {
        mkdirSync(dirname(cachePath), { recursive: true })
        writeAtomic(cachePath, serialized.payload)
      }
    } catch { /* 仓外缓存写入异常时保持分析结果可读 */ }
  } else if (useCache && existsSync(cachePath)) {
    try { cacheBytes = statSync(cachePath).size } catch { cacheBytes = 0 }
  }

  const fileSet = new Set(analyzedByRel.keys())
  const dirIndex = buildDirFileIndex(fileSet)
  const adj = new Map()
  const inDeg = new Map()
  const outDeg = new Map()
  for (const rel of fileSet) {
    adj.set(rel, new Set())
    inDeg.set(rel, 0)
    outDeg.set(rel, 0)
  }

  const edges = []
  const seenEdgeKeys = new Set()
  for (const rel of [...fileSet].sort()) {
    const info = analyzedByRel.get(rel)
    for (const imp of info?.imports ?? []) {
      const candidates = Array.isArray(imp.candidates)
        ? imp.candidates
        : expandImportCandidates(rel, imp.specifier, { goModules, kind: imp.kind })
      const target = resolveLocalImportTarget(candidates, fileSet, { dirIndex })
      if (!target || target === rel) continue
      const key = `${rel}\0${target}`
      if (seenEdgeKeys.has(key)) continue
      seenEdgeKeys.add(key)
      adj.get(rel).add(target)
      outDeg.set(rel, (outDeg.get(rel) ?? 0) + 1)
      inDeg.set(target, (inDeg.get(target) ?? 0) + 1)
      edges.push({ from: rel, to: target, specifier: imp.specifier, line: imp.line })
    }
  }

  const rawSccs = findSccs(fileSet, adj)
  const cycles = rawSccs.map((comp, idx) => ({ id: `scc-${idx + 1}`, nodes: comp }))
  const sccByNode = new Map()
  for (const cyc of cycles) {
    for (const n of cyc.nodes) sccByNode.set(n, cyc.id)
  }

  const coupling = {}
  const nodes = []
  for (const rel of [...fileSet].sort()) {
    const info = analyzedByRel.get(rel)
    const sccId = sccByNode.get(rel) ?? null
    const inCycle = sccId !== null
    const fanIn = inDeg.get(rel) ?? 0
    const fanOut = outDeg.get(rel) ?? 0
    const fileChurn = history.churn[rel] ?? { commits: 0, lastAt: null }
    coupling[rel] = { fanIn, fanOut, inCycle, sccId }
    nodes.push({
      id: rel,
      relPath: rel,
      lang: info.lang,
      lines: info.metrics?.lines ?? 0,
      bytes: info.metrics?.bytes ?? info.size ?? 0,
      symbols: info.symbols ?? [],
      symbolCount: (info.symbols ?? []).length,
      fanIn,
      fanOut,
      inCycle,
      sccId,
      churnCommits: fileChurn.commits,
      lastCommitAt: fileChurn.lastAt,
    })
  }

  return {
    repoRoot: root,
    isGit,
    degradedReason: history.degradedReason,
    repoFiles,
    nodes,
    edges,
    coupling,
    cycles,
    churn: history.churn,
    tags: history.tags,
    merges: history.merges,
    cacheStats: {
      hits,
      misses,
      total: hits + misses,
      cachePath,
      useCache,
      recovered: cacheState.recovered,
      truncated: cacheTruncated,
      cacheBytes,
    },
  }
}

/**
 * 统一零 Token 增量静态分析入口（异步）：
 * 输出 `{ nodes, edges, coupling, cycles, churn, tags, merges, cacheStats, repoFiles, isGit, degradedReason }`。
 */
export async function analyzeRepoStatic(repoRoot, {
  useCache = true,
  cacheRoot = null,
  includeGitChurn = true,
  maxChurnCommits = 200,
} = {}) {
  const root = resolve(String(repoRoot || process.cwd()))
  const cachePath = resolveAnalysisCachePath(root, cacheRoot)
  if (!existsSync(root)) return buildEmptyAnalysis(root, cachePath, useCache)

  const wtGitDir = resolveGitDirFast(root)
  const commonDir = resolveCommonGitDir(root)
  const isGit = Boolean(wtGitDir && existsSync(wtGitDir))
  const headInfo = isGit ? readHeadFast(wtGitDir, commonDir) : null
  const isUnborn = Boolean(isGit && headInfo && !headInfo.oid)

  const [listed, gitIndexState, history] = await Promise.all([
    gitLsFilesTextAndCode(root, { isGit, probeBinary: true, maxFiles: 50000 }),
    isGit ? readGitIndexBlobShas(root) : Promise.resolve({ shaMap: new Map(), dirtySet: new Set() }),
    (isGit && includeGitChurn && !isUnborn)
      ? collectGitHistory(root, maxChurnCommits)
      : Promise.resolve({
          churn: {},
          merges: [],
          tags: [],
          degradedReason: !isGit ? 'non-git-repo' : (isUnborn ? 'unborn-head' : null),
        }),
  ])

  return finalizeAnalysisGraph({ root, cachePath, isGit, listedFiles: listed.files, gitIndexState, history, useCache })
}

/**
 * 同步零 Token 增量静态分析入口（与 `analyzeRepoStatic` 共享同一缓存与构图管线，供同步投影复用）。
 */
export function analyzeRepoStaticSync(repoRoot, {
  useCache = true,
  cacheRoot = null,
  includeGitChurn = true,
  maxChurnCommits = 200,
} = {}) {
  const root = resolve(String(repoRoot || process.cwd()))
  const cachePath = resolveAnalysisCachePath(root, cacheRoot)
  if (!existsSync(root)) return buildEmptyAnalysis(root, cachePath, useCache)

  const wtGitDir = resolveGitDirFast(root)
  const commonDir = resolveCommonGitDir(root)
  const isGit = Boolean(wtGitDir && existsSync(wtGitDir))
  const headInfo = isGit ? readHeadFast(wtGitDir, commonDir) : null
  const isUnborn = Boolean(isGit && headInfo && !headInfo.oid)

  const listed = listFilesSync(root, { isGit, maxFiles: 50000 })
  const gitIndexState = isGit ? readGitIndexBlobShasSync(root) : { shaMap: new Map(), dirtySet: new Set() }
  const history = (isGit && includeGitChurn && !isUnborn)
    ? collectGitHistorySync(root, maxChurnCommits)
    : {
        churn: {},
        merges: [],
        tags: [],
        degradedReason: !isGit ? 'non-git-repo' : (isUnborn ? 'unborn-head' : null),
      }

  return finalizeAnalysisGraph({ root, cachePath, isGit, listedFiles: listed.files, gitIndexState, history, useCache })
}
