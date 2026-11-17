/**
 * tdd-parity.mjs —— 结构级 TDD 同步校验（排除 TEST_FILE_RE、豁免 no-tdd、比对增删模块与导出/CLI）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 flow-lifecycle 与 shared 导出。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { docIsoDate } from './docs.mjs'
import { gitDiffNameStatusZ, gitRunBuffer, gitStatusPorcelainZ, posixPath, readTextSafe } from './git.mjs'
import { getCachedEntriesDiffText } from './git-fast.mjs'
import { parseAgentsProfile, resolveAuthoritativeTddPath } from './profile.mjs'
import { CODE_EXT_RE, TEST_FILE_RE, splitDiffByFile, stripCodeCommentsLines, summarizeHunkChanges } from './static-gates.mjs'

const MODULE_BOUNDARY_DIR_RE = /^(?:src|lib|scripts|kit|packages|apps|services|backend|frontend|bin|cmd)\//i
const CORE_MANIFEST_RE = /^(?:package\.json|Cargo\.toml|pyproject\.toml|go\.mod|go\.work|pom\.xml|build\.gradle(?:\.kts)?)$/i
const SUBCOMMANDS_RE = /\bSUBCOMMANDS\b/

/**
 * 新增/删除行里找「对外符号」。
 *
 * 先剥注释再匹配：扔进注释里的 `export function Foo` 是**说明**，不是定义。
 * 不剥的话，一句「这类东西以前写成 `export const Foo`」就能让判据以为符号还在，
 * 于是真正被删掉的那个导出再也没人核对。
 */
function exportSymbolsOf(lines, file) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1] ?? ''
  const codeOnly = stripCodeCommentsLines(lines.join('\n'), ext)
  const out = new Set()
  for (const line of codeOnly) {
    for (const m of line.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) {
      out.add(m[1])
    }
    for (const m of line.matchAll(/\bpub\s+(?:fn|struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1])
    for (const m of line.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) out.add(m[1])
  }
  return out
}

/**
 * 「模块 `x` 有没有被写进 TDD」只认**完整相对路径**。
 *
 * 只比裸文件名会被正文里的举例冒充：一句「比如 `utils.mjs` 这种」写的是举例，
 * 不是承诺「本仓有一个 utils.mjs 模块」。完整路径（`src/utils.mjs`）是唯一的，
 * 出现在文档里才配叫「点了名」。
 */
function isMentionedInTdd(tddText, fileRel) {
  if (!tddText) return false
  return tddText.includes(posixPath(fileRel))
}

function isNonTestSourceFile(rel) {
  if (!rel || TEST_FILE_RE.test(rel)) return false
  if (/^(?:docs|\.worktrees|\.agents)\//i.test(rel)) return false
  return CODE_EXT_RE.test(rel)
}

function collectExportAndCliChanges(diffText) {
  const changes = []
  const chunks = splitDiffByFile(diffText)
  for (const [rawFile, chunk] of chunks.entries()) {
    const file = posixPath(rawFile)
    if (!isNonTestSourceFile(file)) continue
    const { added, removed, hunks } = summarizeHunkChanges(chunk)
    const addedSyms = exportSymbolsOf(added, file)
    const removedSyms = exportSymbolsOf(removed, file)
    let subcommandsTouched = false

    for (const line of [...added, ...removed]) {
      if (SUBCOMMANDS_RE.test(line)) subcommandsTouched = true
    }

    if (!subcommandsTouched && SUBCOMMANDS_RE.test(chunk)) {
      const subBlocks = chunk.split(/\n(?=@@ )/)
      for (const blk of subBlocks) {
        if (SUBCOMMANDS_RE.test(blk) && /\n[+-](?![+-]{2})\s*['"][a-z0-9_-]+['"]/i.test(blk)) {
          subcommandsTouched = true
          break
        }
      }
    }

    for (const sym of addedSyms) {
      if (!removedSyms.has(sym)) changes.push({ file, symbol: sym, change: 'added' })
    }
    for (const sym of removedSyms) {
      if (!addedSyms.has(sym)) changes.push({ file, symbol: sym, change: 'removed' })
    }
    if (subcommandsTouched) {
      changes.push({ file, symbol: 'SUBCOMMANDS', change: 'modified' })
    }
    void hunks
  }
  return changes
}

/**
 * 校验本次变更的非测试源码模块、导出符号及 CLI 子命令是否与权威架构文档同步。
 */
export async function checkTddSyncParity(implRoot, changed = [], ledger = {}, opts = {}) {
  const profile = parseAgentsProfile(implRoot)
  const tddRel = resolveAuthoritativeTddPath(implRoot, profile.decisions)
  if (!tddRel) {
    return {
      docParityReminder: false,
      tddDateStale: false,
      authoritativeTddPath: null,
      missingModulesInTdd: [],
      staleModulesInTdd: [],
      changedExportsOrCli: [],
      tddSyncWarning: null,
    }
  }

  const normTddRel = posixPath(tddRel)
  const tddPath = join(implRoot, normTddRel)
  const tddText = existsSync(tddPath) ? (readTextSafe(tddPath) ?? '') : ''

  const [diffRes, st] = await Promise.all([
    Array.isArray(opts.diffEntries)
      ? Promise.resolve({ entries: opts.diffEntries })
      : (ledger?.baseSha ? gitDiffNameStatusZ(implRoot, [`${ledger.baseSha}..HEAD`]) : Promise.resolve({ entries: [] })),
    Array.isArray(opts.statusEntries)
      ? Promise.resolve({ entries: opts.statusEntries })
      : gitStatusPorcelainZ(implRoot),
  ])
  const changedEntries = diffRes?.entries ?? []
  const normChanged = (Array.isArray(changed) ? changed : []).map((f) => posixPath(f)).filter(Boolean)

  const missingModulesInTdd = []
  const staleModulesInTdd = []
  const addedOrRenamed = new Set()
  const deletedFiles = new Set()
  let touchedManifestOrBoundary = false

  for (const e of changedEntries) {
    const f = posixPath(e.file)
    if (!f || TEST_FILE_RE.test(f)) continue
    if (CORE_MANIFEST_RE.test(basename(f))) touchedManifestOrBoundary = true
    if (/^[AR]/.test(e.status) && isNonTestSourceFile(f)) {
      if (MODULE_BOUNDARY_DIR_RE.test(f)) touchedManifestOrBoundary = true
      addedOrRenamed.add(f)
    } else if (/^D/.test(e.status) && isNonTestSourceFile(f)) {
      if (MODULE_BOUNDARY_DIR_RE.test(f)) touchedManifestOrBoundary = true
      deletedFiles.add(f)
    }
  }
  for (const e of st.entries ?? []) {
    const f = posixPath(e.file)
    if (!f || TEST_FILE_RE.test(f)) continue
    if (CORE_MANIFEST_RE.test(basename(f))) touchedManifestOrBoundary = true
    if (e.xy === '??' && isNonTestSourceFile(f)) {
      if (MODULE_BOUNDARY_DIR_RE.test(f)) touchedManifestOrBoundary = true
      addedOrRenamed.add(f)
    }
  }

  for (const f of [...addedOrRenamed].sort()) {
    if (!isMentionedInTdd(tddText, f)) missingModulesInTdd.push(f)
  }
  for (const f of [...deletedFiles].sort()) {
    if (tddText.includes(f)) staleModulesInTdd.push(f)
  }

  let changedExportsOrCli = []
  if (ledger?.baseSha && normChanged.some((f) => isNonTestSourceFile(f))) {
    const cachedText = opts.diffText ?? getCachedEntriesDiffText(opts.diffEntries)
    if (cachedText !== undefined) {
      changedExportsOrCli = collectExportAndCliChanges(cachedText)
    } else {
      const diffBuf = await gitRunBuffer(implRoot, ['--no-optional-locks', 'diff', '--unified=3', '--no-ext-diff', '--no-color', `${ledger.baseSha}..HEAD`])
      if (diffBuf.ok) {
        changedExportsOrCli = collectExportAndCliChanges(diffBuf.stdout.toString('utf8').replace(/\r\n/g, '\n'))
      }
    }
  }

  const tddUpdated = normChanged.includes(normTddRel)
  const touchedAnyDoc = normChanged.some((f) =>
    f === normTddRel
    || /^(?:docs\/TDD\.md|ARCHITECTURE\.md|README(?:\.[a-z0-9_-]+)?\.md|AGENTS\.md)$/i.test(f))

  let tddDateStale = false
  if ((touchedManifestOrBoundary || changedExportsOrCli.length > 0) && tddText) {
    const today = docIsoDate()
    const hasMetaDate = /最近更新[^\n]*\d{4}-\d{2}-\d{2}/.test(tddText)
    if (hasMetaDate && !tddUpdated && !tddText.includes(today)) tddDateStale = true
  }

  const hasStructDrift = missingModulesInTdd.length > 0
    || staleModulesInTdd.length > 0
    || (!tddUpdated && changedExportsOrCli.length > 0)
  const hasBoundaryDrift = Boolean(touchedManifestOrBoundary && (!tddUpdated || tddDateStale))
  const hasWarning = hasStructDrift || hasBoundaryDrift

  let tddSyncWarning = null
  if (hasWarning) {
    const details = []
    if (missingModulesInTdd.length > 0) details.push(`未收录新增模块: ${missingModulesInTdd.slice(0, 4).join(', ')}`)
    if (staleModulesInTdd.length > 0) details.push(`已删除仍残留路径: ${staleModulesInTdd.slice(0, 4).join(', ')}`)
    if (!tddUpdated && changedExportsOrCli.length > 0) {
      details.push(`导出/CLI 变动: ${changedExportsOrCli.slice(0, 4).map((x) => `${x.file}:${x.symbol}`).join(', ')}`)
    }
    const detailSuffix = details.length > 0 ? `（${details.join('；')}）` : ''
    tddSyncWarning = `本次改动涉及模块目录边界或对外清单${detailSuffix}，请核对 ${normTddRel} 的最近更新日期与模块职责表并随本次提交更新。`
  }

  return {
    docParityReminder: (touchedManifestOrBoundary || hasStructDrift) && !touchedAnyDoc,
    tddDateStale,
    authoritativeTddPath: normTddRel,
    missingModulesInTdd,
    staleModulesInTdd,
    changedExportsOrCli,
    tddSyncWarning,
  }
}
