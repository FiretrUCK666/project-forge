/**
 * review-diff.mjs -- Diff collection (-z safe), conflict guard, Tier 2 review-slot sync,
 * hunk indexing, and untrusted supply-chain hazard scanning for dev-review.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitRunBuffer,
  isMacOsJunkPath, posixPath, readTextSafe, syncDetachedWorktree,
} from '../../lib/git.mjs'
import {
  computePatchRawDigest, getCachedCommitDiff, isAncestorLinearFast, parseRawAndUnifiedDiff,
  readHeadFast, resolveGitDirFast, resolveRefShaFast, setCachedCommitDiff,
} from '../../lib/git-fast.mjs'
import { isCleanWorktreeFast } from '../../lib/git-status-fast.mjs'
import { recordMountedDepsInLedger, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  GATE_WORKFLOW_FILE_RE, LOCKFILE_NAMES, detectGateWeakeningInEntry,
  splitDiffByFile, summarizeHunkChanges,
} from '../../lib/static-gates.mjs'

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE_OR_POLICY: 2,
  UNTRUSTED_HAZARD: 3,
  STOP_LOSS: 4,
})

const LIFECYCLE_HOOK_RE = /"(?:preinstall|install|postinstall|preuninstall|uninstall|postuninstall|prepublish|prepublishOnly|preprepare|prepare|postprepare|prepack|postpack)"\s*:/
const BUILD_SCRIPT_RE = /(?:^|\/)(?:Makefile|GNUmakefile|makefile|justfile|Taskfile\.ya?ml|build\.rs|setup\.py)$|\.(?:mk)$|(?:^|\/)(?:preinstall|install|postinstall|bootstrap)\.(?:sh|bash|ps1|bat|cmd|py|mjs|js|cjs)$|(?:^|\/)(?:scripts?|tools?|build)\/[^/]*(?:build|install|setup|bootstrap|hook)[^/]*\.(?:sh|bash|ps1|bat|cmd|py|mjs|js|cjs)$/i
const EXTRA_CI_FILE_RE = /(?:^|\/)(?:\.travis\.ya?ml|\.drone\.ya?ml|\.buildkite\/pipeline\.ya?ml|\.woodpecker(?:\.ya?ml|\/[^/]+\.ya?ml))$/i

export async function hasCommits(repoRoot) {
  const fastHead = readHeadFast(resolveGitDirFast(repoRoot))
  if (fastHead) return Boolean(fastHead.oid)
  return (await gitRun(repoRoot, ['rev-parse', '--verify', 'HEAD'])).ok
}

export async function resolveReviewTargetSha(mainRoot, worktreeRoot, task, headRef = 'HEAD') {
  if (task) {
    const implRoot = task.worktreePath ? resolve(mainRoot, task.worktreePath) : null
    if (implRoot && existsSync(implRoot)) {
      if (headRef === 'HEAD') {
        const fast = readHeadFast(resolveGitDirFast(implRoot))?.oid
        if (fast) return fast
      }
      const res = await gitRun(implRoot, ['rev-parse', headRef])
      if (res.ok && res.stdout.trim()) return res.stdout.trim()
    }
    if (task.branch && headRef === 'HEAD') {
      const fastBr = resolveRefShaFast(resolveGitDirFast(mainRoot), `refs/heads/${task.branch}`)
      if (fastBr) return fastBr
      const brRes = await gitRun(mainRoot, ['rev-parse', '--verify', `refs/heads/${task.branch}`])
      if (brRes.ok && brRes.stdout.trim()) return brRes.stdout.trim()
    }
  }
  if (headRef === 'HEAD') {
    const fastWt = readHeadFast(resolveGitDirFast(worktreeRoot))?.oid
    if (fastWt) return fastWt
  }
  const fallback = await gitRun(worktreeRoot, ['rev-parse', headRef])
  return fallback.ok && fallback.stdout.trim() ? fallback.stdout.trim() : 'UNBORN'
}

export async function resolveReviewWorktree(mainRoot, worktreeRoot, opts, task) {
  if (opts.worktree) return resolve(opts.worktree)
  if (task?.reviewWorktreePath) {
    const cand = resolve(mainRoot, task.reviewWorktreePath)
    if (existsSync(cand)) return cand
  }
  const taskId = opts.task ?? task?.taskId
  if (taskId) {
    const cand = join(mainRoot, '.worktrees', `review-${taskId}`)
    if (existsSync(cand)) return cand
  }
  if (opts.pr) {
    const cand = join(mainRoot, '.worktrees', `review-pr-${opts.pr}`)
    if (existsSync(cand)) return cand
  }
  if (task?.worktreePath) {
    const cand = resolve(mainRoot, task.worktreePath)
    if (existsSync(cand)) return cand
  }
  return worktreeRoot
}

async function callReviewDepsHelper(fnName, mainRoot, reviewWtAbs, helperOpts = undefined) {
  const hereDir = dirname(fileURLToPath(import.meta.url))
  const depsScript = join(hereDir, '..', '..', 'dev-flow', 'scripts', 'worktree-deps.mjs')
  if (!existsSync(depsScript)) return { mode: 'skipped', reason: 'dev-flow-absent' }
  try {
    const mod = await import(pathToFileURL(depsScript).href)
    if (typeof mod[fnName] === 'function') {
      return helperOpts !== undefined
        ? mod[fnName](mainRoot, reviewWtAbs, helperOpts)
        : mod[fnName](mainRoot, reviewWtAbs)
    }
  } catch (err) {
    return { mode: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
  return { mode: 'skipped', reason: 'no-fn' }
}

/**
 * 在 --task 且非外部 PR 模式下，先解绑旧 Junction，按需清理脏审查位，同步最新 HEAD 后重挂载共享依赖。
 */
export async function syncTier2ReviewSlotIfNeeded({ mainRoot, worktreeRoot, opts, task, mode }) {
  const isExternalPr = Boolean(opts['external-pr'] || opts.pr || task?.role === 'inbound-external-pr')
  if (mode !== 'task' || !task || isExternalPr || opts.worktree) {
    return null
  }
  const defaultReviewRel = `.worktrees/review-${task.taskId}`
  const hasTier2Slot = task.tier === 2
    || Boolean(task.reviewWorktreePath)
    || existsSync(join(mainRoot, '.worktrees', `review-${task.taskId}`))
  if (!hasTier2Slot) return null

  const reviewRel = task.reviewWorktreePath || defaultReviewRel
  const reviewWtAbs = resolve(mainRoot, reviewRel)
  const targetSha = await resolveReviewTargetSha(mainRoot, worktreeRoot, task, opts.head ?? 'HEAD')
  if (existsSync(reviewWtAbs)) {
    const umRes = await callReviewDepsHelper('unmountSharedDeps', mainRoot, reviewWtAbs, { mode: 'deps' })
    if (umRes && (umRes.ok === false || umRes.mode === 'failed')) {
      throw new Error(`同步审查槽 ${reviewRel} 前解绑共享依赖失败：${umRes.reason ?? JSON.stringify(umRes.blocked ?? [])}`)
    }
  }
  const syncRes = await syncDetachedWorktree(mainRoot, reviewWtAbs, targetSha, { resetDirty: Boolean(opts['reset-review-slot']) })
  const skipDepsForUntrusted = Boolean(opts['untrusted-scan'] && !opts['human-approved-exec'])
  const depsRes = skipDepsForUntrusted
    ? { mode: 'skipped', reason: 'untrusted-scan-before-approval' }
    : await callReviewDepsHelper('mountSharedDeps', mainRoot, reviewWtAbs)

  let mountedUpdated = false
  if (depsRes?.ok) {
    recordMountedDepsInLedger(task, reviewRel, depsRes)
    mountedUpdated = true
  }
  if (mountedUpdated || task.reviewWorktreeHead !== targetSha || !task.reviewWorktreePath) {
    task.reviewWorktreePath = posixPath(reviewRel)
    task.reviewWorktreeHead = targetSha
    writeTaskLedger(mainRoot, task)
  }

  return {
    ...syncRes,
    reviewWorktreePath: posixPath(reviewRel),
    depsMode: depsRes.mode,
    depsReason: depsRes.reason,
  }
}

export async function computeDiffRange(repoRoot, baseRef, headRef) {
  const wtGitDir = resolveGitDirFast(repoRoot)
  if (wtGitDir && !existsSync(join(wtGitDir, 'reftable'))) {
    const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
    const commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir
    const baseSha = /^[0-9a-f]{40}$/i.test(baseRef)
      ? baseRef
      : (resolveRefShaFast(commonDir, `refs/heads/${baseRef}`) ?? resolveRefShaFast(commonDir, `refs/remotes/${baseRef}`))
    const headSha = headRef === 'HEAD'
      ? readHeadFast(wtGitDir, commonDir)?.oid
      : (/^[0-9a-f]{40}$/i.test(headRef) ? headRef : null)
    if (baseSha && headSha && isAncestorLinearFast(commonDir, baseSha, headSha) === true) {
      return `${baseSha}..${headRef}`
    }
  }
  const mb = await gitRun(repoRoot, ['merge-base', baseRef, headRef])
  if (mb.ok && mb.stdout.trim()) return `${mb.stdout.trim()}..${headRef}`
  return `${baseRef}..${headRef}`
}

function buildHunkIndex(files, untracked, chunks, reviewRoot) {
  const hunkIndex = []
  let totalAddedLines = 0
  let totalRemovedLines = 0

  for (const entry of files) {
    const chunk = chunks.get(entry.file) ?? ''
    const { added, removed, hunks } = summarizeHunkChanges(chunk)
    totalAddedLines += added.length
    totalRemovedLines += removed.length
    hunkIndex.push({
      file: entry.file,
      status: entry.status,
      ...(entry.oldFile ? { oldFile: entry.oldFile } : {}),
      addedLines: added.length,
      removedLines: removed.length,
      hunks: hunks.map((h) => ({
        header: h.header,
        addedLines: h.added.length,
        removedLines: h.removed.length,
      })),
    })
  }

  for (const file of untracked) {
    const txt = readTextSafe(join(reviewRoot, file))
    const addedCount = txt !== undefined ? txt.split('\n').length : 0
    totalAddedLines += addedCount
    hunkIndex.push({
      file,
      status: '?',
      addedLines: addedCount,
      removedLines: 0,
      hunks: addedCount > 0 ? [{ header: `@@ -0,0 +1,${addedCount} @@ (untracked)`, addedLines: addedCount, removedLines: 0 }] : [],
    })
  }

  return {
    hunkIndex,
    summary: {
      filesChanged: files.length,
      untrackedCount: untracked.length,
      addedLines: totalAddedLines,
      removedLines: totalRemovedLines,
    },
  }
}

function parseCommitShowNameStatusZ(buf) {
  const tokens = Buffer.isBuffer(buf) ? buf.toString('utf8').split('\0') : String(buf ?? '').split('\0')
  const byFile = new Map()
  for (let i = 0; i < tokens.length; i += 1) {
    const rawStatus = tokens[i]?.trim()
    if (!rawStatus) continue
    if (/^[RC]/.test(rawStatus)) {
      const oldFile = posixPath(tokens[i + 1] ?? '')
      const file = posixPath(tokens[i + 2] ?? '')
      i += 2
      if (file) byFile.set(file, { status: rawStatus, file, oldFile })
    } else if (/^[MADTU]/.test(rawStatus)) {
      const file = posixPath(tokens[i + 1] ?? '')
      i += 1
      if (file) byFile.set(file, { status: rawStatus, file })
    }
  }
  return [...byFile.values()]
}

export async function collectDiff(repoRoot, spec) {
  const op = await detectInProgressGitOp(repoRoot)
  if (op.inProgress) {
    const detail = op.conflicts.length > 0 ? `（冲突文件：${op.conflicts.slice(0, 5).join(', ')}）` : ''
    throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态${detail}，请先解决冲突后再运行 review-pack。`)
  }

  if (spec.mode === 'commits') {
    const commits = Array.isArray(spec.commits) ? spec.commits.filter(Boolean) : []
    if (commits.length === 0) {
      return {
        sha256: createHash('sha256').update('').digest('hex'),
        bytes: 0,
        text: '',
        chunks: new Map(),
        files: [],
        untracked: [],
        hunkIndex: [],
        summary: { filesChanged: 0, untrackedCount: 0, addedLines: 0, removedLines: 0 },
      }
    }
    if (commits.length === 1) {
      const singleRes = await gitRunBuffer(repoRoot, ['show', '--format=tformat:', '--raw', '--no-ext-diff', '--no-color', commits[0]], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 })
      if (!singleRes.ok) {
        throw new Error(`GIT_DIFF_FAILED: git show 执行失败（commits=${commits[0]}）：${singleRes.stderr || 'unknown git show error'}`)
      }
      const fullBuf = Buffer.isBuffer(singleRes.stdout) ? singleRes.stdout : Buffer.from('')
      const digest = computePatchRawDigest(fullBuf)
      const { entries: parsedEntries, diffText: text } = parseRawAndUnifiedDiff(fullBuf)
      const files = parsedEntries.filter((e) => e.file && !isMacOsJunkPath(e.file))
      const chunks = splitDiffByFile(text)
      const { hunkIndex, summary } = buildHunkIndex(files, [], chunks, repoRoot)
      return { sha256: digest.sha256, bytes: digest.bytes, text, chunks, files, untracked: [], hunkIndex, summary }
    }
    const [rawBufRes, nsBufRes] = await Promise.all([
      gitRunBuffer(repoRoot, ['show', '--format=tformat:', '--no-ext-diff', '--no-color', ...commits], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 }),
      gitRunBuffer(repoRoot, ['show', '--format=tformat:', '--name-status', '-z', ...commits], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }),
    ])
    if (!rawBufRes.ok || !nsBufRes.ok) {
      const errText = rawBufRes.stderr || nsBufRes.stderr || 'unknown git show error'
      throw new Error(`GIT_DIFF_FAILED: git show 执行失败（commits=${commits.join(',')}）：${errText}`)
    }
    const rawBuf = Buffer.isBuffer(rawBufRes.stdout) ? rawBufRes.stdout : Buffer.from('')
    const text = rawBuf.toString('utf8').replace(/\r\n/g, '\n')
    const files = parseCommitShowNameStatusZ(nsBufRes.stdout).filter((e) => e.file && !isMacOsJunkPath(e.file))
    const chunks = splitDiffByFile(text)
    const { hunkIndex, summary } = buildHunkIndex(files, [], chunks, repoRoot)
    return { sha256: createHash('sha256').update(rawBuf).digest('hex'), bytes: rawBuf.length, text, chunks, files, untracked: [], hunkIndex, summary }
  }

  // `--raw` 单独用只输出文件清单（40 行），补丁正文一行都没有。
  // 要拿正文必须同时给 `--unified=N`——两个开关缺一个，审核人拿到的就是一份空 diff：
  // 文件列着 40 个、hunk 索引全空、正文 0 字节，而报告看起来完全正常。
  const argsBase = ['--no-optional-locks', 'diff', '--raw', '--unified=3', '--no-ext-diff', '--no-color']
  let diffArgs
  let cacheCommonDir = null
  let cacheBaseSha = null
  let cacheHeadSha = null
  if (spec.mode === 'local') {
    if (await hasCommits(repoRoot)) {
      diffArgs = [...argsBase, 'HEAD']
    } else {
      diffArgs = [...argsBase, '--cached']
    }
  } else if (spec.mode === 'staged') {
    diffArgs = [...argsBase, '--cached']
  } else {
    let effectiveRange = spec.range
    const rangeM = /^([0-9a-f]{40,64})\.\.([0-9a-f]{40,64}|HEAD)$/i.exec(String(spec.range ?? ''))
    if (rangeM) {
      const wtGitDir = resolveGitDirFast(repoRoot)
      if (wtGitDir) {
        const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
        cacheCommonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir
        const hSha = rangeM[2].toUpperCase() === 'HEAD' ? readHeadFast(wtGitDir, cacheCommonDir)?.oid : rangeM[2]
        if (hSha && /^[0-9a-f]{40,64}$/i.test(hSha)) {
          cacheBaseSha = rangeM[1]
          cacheHeadSha = hSha
          effectiveRange = `${cacheBaseSha}..${cacheHeadSha}`
        }
      }
    }
    diffArgs = [...argsBase, effectiveRange]
  }

  let sha256
  let bytes
  let parsedEntries
  let text
  const cachedHit = (cacheCommonDir && cacheBaseSha && cacheHeadSha)
    ? (cacheBaseSha === cacheHeadSha
        ? { entries: [], diffText: '', rawSha256: createHash('sha256').update('').digest('hex'), rawBytes: 0 }
        : getCachedCommitDiff(cacheCommonDir, cacheBaseSha, cacheHeadSha))
    : null
  if (cachedHit && cachedHit.rawSha256) {
    sha256 = cachedHit.rawSha256
    bytes = cachedHit.rawBytes
    parsedEntries = cachedHit.entries
    text = cachedHit.diffText
  } else {
    const rawBufRes = await gitRunBuffer(repoRoot, diffArgs, { maxBuffer: 64 * 1024 * 1024, timeout: 30000 })
    if (!rawBufRes.ok) {
      const errText = rawBufRes.stderr || 'unknown git diff error'
      throw new Error(`GIT_DIFF_FAILED: git diff 执行失败（scope=${spec.range ?? spec.mode}）：${errText}；请确认基线引用（可用 --base <ref> 指定）及提交历史有效。`)
    }
    const fullBuf = Buffer.isBuffer(rawBufRes.stdout) ? rawBufRes.stdout : Buffer.from('')
    const digest = computePatchRawDigest(fullBuf)
    sha256 = digest.sha256
    bytes = digest.bytes
    const parsed = parseRawAndUnifiedDiff(fullBuf)
    parsedEntries = parsed.entries
    text = parsed.diffText
    if (cacheCommonDir && cacheBaseSha && cacheHeadSha && cacheBaseSha !== cacheHeadSha) {
      setCachedCommitDiff(cacheCommonDir, cacheBaseSha, cacheHeadSha, {
        ok: true, entries: parsedEntries, diffText: text, rawSha256: sha256, rawBytes: bytes,
      })
    }
  }

  const files = parsedEntries.filter((e) => e.file && !isMacOsJunkPath(e.file))
  const untracked = []
  if (spec.mode === 'local' && !isCleanWorktreeFast(repoRoot)?.clean) {
    const st = await gitRunBuffer(repoRoot, ['--no-optional-locks', 'ls-files', '-z', '--others', '--exclude-standard'])
    if (!st.ok) {
      throw new Error(`GIT_LS_FILES_FAILED: 枚举未跟踪文件失败：${st.stderr}`)
    }
    for (const rawPath of st.stdout.toString('utf8').split('\0')) {
      const clean = posixPath(rawPath.trim())
      if (clean && !isMacOsJunkPath(clean)) untracked.push(clean)
    }
  }

  const chunks = splitDiffByFile(text)
  const { hunkIndex, summary } = buildHunkIndex(files, untracked, chunks, repoRoot)

  return { sha256, bytes, text, chunks, files, untracked, hunkIndex, summary }
}

function isParameterizedOrNonAstTest(fileRel, added) {
  const ext = posixPath(fileRel).split('.').pop()?.toLowerCase() ?? ''
  const nonAstLang = ['java', 'kt', 'kts', 'rs', 'cs', 'fs', 'c', 'cc', 'cpp', 'swift', 'rb', 'php'].includes(ext)
  const parameterized = /\b(?:it|test|describe|suite)\.each\b|\btest\.for\b|@ParameterizedTest|\[Theory\]|pytest\.mark\.parametrize/i.test(added.join('\n'))
  return nonAstLang || parameterized
}

/**
 * Static supply-chain and gate-weakening scanner for untrusted diffs.
 * Scans changed file paths + added/removed hunk lines BEFORE running any code.
 */
export function scanUntrustedDiff(diff, repoRoot) {
  const hazards = []
  const advisories = []
  const chunks = diff.chunks ?? splitDiffByFile(diff.text)
  const allFiles = [...diff.files, ...diff.untracked.map((file) => ({ status: '?', file }))]

  for (const entry of allFiles) {
    const f = entry.file
    const base = f.split('/').pop()?.toLowerCase() ?? ''
    const fileDiff = chunks.get(f) ?? ''
    const parsedHunks = summarizeHunkChanges(fileDiff)
    let { added } = parsedHunks
    const { removed, hunks } = parsedHunks
    if (entry.status === '?' && added.length === 0 && repoRoot) {
      const raw = readTextSafe(join(repoRoot, f))
      if (raw) added = raw.split('\n')
    }
    const excerpt = [...added.slice(0, 4).map((l) => `+ ${l}`), ...removed.slice(0, 2).map((l) => `- ${l}`)]

    if (GATE_WORKFLOW_FILE_RE.test(f) || EXTRA_CI_FILE_RE.test(f)) {
      hazards.push({
        category: 'workflow',
        file: f,
        reason: 'Modifies CI/workflow automation (privileged execution surface)',
        excerpt,
      })
    } else if (f.startsWith('.husky/') || f.startsWith('.githooks/') || f.startsWith('.git/hooks/')) {
      hazards.push({
        category: 'git-hook',
        file: f,
        reason: 'Modifies local git hooks that run automatically on git commands',
        excerpt,
      })
    } else if (f.startsWith('.agents/skills/')) {
      hazards.push({
        category: 'agent-skills',
        file: f,
        reason: 'Modifies local agent skills / executable skill scripts',
        excerpt,
      })
    } else if (f === '.gitattributes') {
      hazards.push({
        category: 'gitattributes',
        file: f,
        reason: 'Modifies .gitattributes (package boundaries / filter / diff attributes)',
        excerpt,
      })
    } else if (LOCKFILE_NAMES.has(base)) {
      hazards.push({
        category: 'lockfile',
        file: f,
        reason: 'Modifies dependency lockfile (check for registry/tarball/git URL tampering)',
        excerpt,
      })
    } else if (base === 'package.json') {
      const hookLines = added.filter((l) => LIFECYCLE_HOOK_RE.test(l))
      if (hookLines.length > 0) {
        hazards.push({
          category: 'lifecycle-hook',
          file: f,
          reason: 'Adds or modifies npm lifecycle hook script (preinstall/install/postinstall/prepare)',
          excerpt: hookLines.slice(0, 5).map((l) => `+ ${l}`),
        })
      }
    } else if (BUILD_SCRIPT_RE.test(f)) {
      hazards.push({
        category: 'build-script',
        file: f,
        reason: 'Modifies Makefile or build/install script',
        excerpt,
      })
    }

    const gateHits = detectGateWeakeningInEntry({ file: f, status: entry.status, added, removed, hunks })
    for (const gh of gateHits) {
      if (gh.severity === 'advisory') {
        const note = isParameterizedOrNonAstTest(f, added)
          ? '（已降级为人工核验提示：非完整 AST 语言或参数化测试重构不自动触发 exit 3）'
          : '（静态行数差值提示，需结合测试语义核实，不单独触发 exit 3）'
        advisories.push({ ...gh, reason: `${gh.reason}${note}` })
      } else {
        hazards.push(gh)
      }
    }
  }

  return { hazards, advisories }
}
