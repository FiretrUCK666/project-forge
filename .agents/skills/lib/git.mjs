/**
 * git.mjs —— 跨平台路径归一、无弹窗安全子进程、进程树超时清理与 Git `-z` 核心原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），统一处理 macOS /private/var 与 APFS NFD、
 * Windows 盘符大小写与 junction、submodule / --separate-git-dir、unborn HEAD 与冲突态。
 */

import {
  closeSync, existsSync, openSync, readdirSync, readSync, statSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import {
  buildNonInteractiveEnv, computeWorktreeEnv, execSafe, execShellCommand,
  killProcessTree, resolveExecutable, withFileLock, withFileLockSync,
} from './exec.mjs'
import {
  BROAD_CODE_EXT_RE, CODE_EXT_RE, COMMON_OUTPUT_DIRS, COMMON_SKIP_DIRS, DEFAULT_WALK_SKIP_DIRS,
  LIKELY_DEFAULT_BRANCHES, MIN_COMMIT_STYLE_SAMPLES, canonicalPath, detectCommitStyle,
  gitRun, gitRunBuffer, isInsideDir, isMacMetadataName, isMacOsJunkPath, isMainModule, posixPath,
  readJsonSafe, readTextSafe, samePath, sha256File, sha256Text, unescapeGitPath,
  writeAtomic, writeJsonAtomic,
} from './git-core.mjs'
import {
  countCommitsAheadDagFast, getCachedNameStatus, hasUnmergedIndexFast,
  isAncestorLinearFast, readFirstParentsFast, readGitIndexPathsFast, readHeadFast,
  readLooseCommitLogFast, readReflogFast, resolveDefaultBranchFast, resolveGitDirFast,
  resolveRefShaFast, setCachedNameStatus,
} from './git-fast.mjs'
import { isCleanWorktreeFast } from './git-status-fast.mjs'
import {
  ensureWorktreesIgnored,
  parseWorktreeListPorcelain,
  resolveRepoRoots,
  syncDetachedWorktree as syncDetachedWorktreeRaw,
} from './git-worktree-env.mjs'

export {
  BROAD_CODE_EXT_RE,
  CODE_EXT_RE,
  COMMON_OUTPUT_DIRS,
  COMMON_SKIP_DIRS,
  DEFAULT_WALK_SKIP_DIRS,
  LIKELY_DEFAULT_BRANCHES,
  MIN_COMMIT_STYLE_SAMPLES,
  buildNonInteractiveEnv,
  canonicalPath,
  computeWorktreeEnv,
  detectCommitStyle,
  ensureWorktreesIgnored,
  execSafe,
  execShellCommand,
  gitRun,
  gitRunBuffer,
  isInsideDir,
  isMacMetadataName,
  isMacOsJunkPath,
  isMainModule,
  killProcessTree,
  parseWorktreeListPorcelain,
  posixPath,
  readJsonSafe,
  readTextSafe,
  resolveExecutable,
  resolveRepoRoots,
  samePath,
  sha256File,
  sha256Text,
  unescapeGitPath,
  withFileLock,
  withFileLockSync,
  writeAtomic,
  writeJsonAtomic,
}

/** 使用 `git status --porcelain=v1 -z -u` 零截断解析工作区改动与冲突条目（干净工作区优先走零进程校验）。 */
export async function gitStatusPorcelainZ(cwd) {
  if (isCleanWorktreeFast(cwd)?.clean) return { ok: true, entries: [], stderr: '' }
  const res = await gitRunBuffer(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-u'])
  if (!res.ok) return { ok: false, entries: [], stderr: res.stderr }
  const text = res.stdout.toString('utf8')
  const tokens = text.split('\0')
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (!tok || tok.length < 4) continue
    const xy = tok.slice(0, 2)
    const file = posixPath(tok.slice(3))
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const oldFile = posixPath(tokens[i + 1] ?? '')
      i += 1
      entries.push({ xy, status: xy.trim() || 'R', file, oldFile })
    } else {
      entries.push({ xy, status: xy.trim() || '??', file })
    }
  }
  return { ok: true, entries, stderr: '' }
}

/** 使用 `git diff --name-status -z` 零截断解析变更文件清单。 */
export async function gitDiffNameStatusZ(cwd, diffArgs = []) {
  const nsCache = getCachedNameStatus(cwd, diffArgs)
  if (nsCache?.hit) return nsCache.hit
  const res = await gitRunBuffer(cwd, ['--no-optional-locks', 'diff', '--name-status', '-z', ...diffArgs])
  if (!res.ok) return { ok: false, entries: [], stderr: res.stderr }
  const tokens = res.stdout.toString('utf8').split('\0')
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i]
    if (!status) continue
    if (/^[RC]/.test(status)) {
      const oldFile = posixPath(tokens[i + 1] ?? '')
      const file = posixPath(tokens[i + 2] ?? '')
      i += 2
      if (file) entries.push({ status, file, oldFile })
    } else {
      const file = posixPath(tokens[i + 1] ?? '')
      i += 1
      if (file) entries.push({ status, file })
    }
  }
  const out = { ok: true, entries, stderr: '' }
  if (nsCache?.key) setCachedNameStatus(nsCache.key, out)
  return out
}

/** 检测仓库是否处于进行中的 Merge / Rebase / Cherry-pick / Revert / 冲突态（复用已知 wtGitDir 与 statusEntries）。 */
export async function detectInProgressGitOp(repoRoot, opts = {}) {
  const ops = []
  let wtGitDir = opts.wtGitDir ?? resolveGitDirFast(repoRoot)
  if (!wtGitDir) {
    const gdRes = await gitRun(repoRoot, ['rev-parse', '--git-dir'])
    wtGitDir = gdRes.ok && gdRes.stdout.trim() ? resolve(repoRoot, gdRes.stdout.trim()) : join(repoRoot, '.git')
  }
  if (existsSync(join(wtGitDir, 'MERGE_HEAD'))) ops.push('merge')
  if (existsSync(join(wtGitDir, 'REBASE_HEAD')) || existsSync(join(wtGitDir, 'rebase-merge')) || existsSync(join(wtGitDir, 'rebase-apply'))) {
    ops.push('rebase')
  }
  if (existsSync(join(wtGitDir, 'CHERRY_PICK_HEAD'))) ops.push('cherry-pick')
  if (existsSync(join(wtGitDir, 'REVERT_HEAD'))) ops.push('revert')
  if (existsSync(join(wtGitDir, 'BISECT_LOG'))) ops.push('bisect')

  const entries = Array.isArray(opts.statusEntries)
    ? opts.statusEntries
    : (hasUnmergedIndexFast(wtGitDir) === false ? [] : ((await gitStatusPorcelainZ(repoRoot)).entries ?? []))
  const conflicts = entries
    .filter((e) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(e.xy))
    .map((e) => e.file)

  return {
    inProgress: ops.length > 0 || conflicts.length > 0,
    op: ops[0] ?? (conflicts.length > 0 ? 'conflict' : null),
    ops,
    conflicts,
  }
}

function isBinaryProbe(absPath) {
  let fd
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return { exists: false, isBinary: false, size: 0 }
    if (st.size === 0) return { exists: true, isBinary: false, size: 0 }
    fd = openSync(absPath, 'r')
    const probeLen = Math.min(st.size, 4096)
    const buf = Buffer.allocUnsafe(probeLen)
    const n = readSync(fd, buf, 0, probeLen, 0)
    return { exists: true, isBinary: buf.subarray(0, n).includes(0), size: st.size }
  } catch { return { exists: false, isBinary: false, size: 0 } }
  finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
}

/**
 * 无深度限制全仓库文件枚举（Git 仓走 `ls-files -z`，非 Git 仓走无深度上限流式遍历），
 * 通过前 4KB NUL 探测识别文本/二进制文件并过滤 macOS 元数据（`._*` / `__MACOSX` / `.DS_Store`）。
 */
export async function gitLsFilesTextAndCode(root, { isGit = true, focus, probeBinary = true, maxFiles = 50000 } = {}) {
  const absRoot = canonicalPath(root)
  const focusParts = focus
    ? posixPath(focus).replace(/^\/+|\/+$/g, '').split('/').filter((s) => s && s !== '.')
    : []
  const focusRel = focusParts.length > 0 ? focusParts.join('/') : undefined
  const files = []
  const dirSummary = new Map()
  let truncated = false

  const pushFile = (relPath) => {
    const rel = posixPath(relPath).replace(/^(?:\.\/)+/, '')
    if (!rel || isMacOsJunkPath(rel)) return
    if (focusRel && rel !== focusRel && !rel.startsWith(`${focusRel}/`)) return
    const segs = rel.split('/')
    const firstSeg = segs[0]
    if (segs.slice(0, -1).some((s) => COMMON_SKIP_DIRS.has(s))) return
    const full = join(absRoot, rel)
    const probe = probeBinary ? isBinaryProbe(full) : { exists: existsSync(full), isBinary: false, size: 0 }
    if (!probe.exists) return
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    const top = rel.includes('/') ? firstSeg : '.'
    dirSummary.set(top, (dirSummary.get(top) ?? 0) + 1)
    files.push({
      rel,
      name: basename(rel),
      full,
      size: probe.size,
      isBinary: probe.isBinary,
      isText: !probe.isBinary,
    })
  }

  if (isGit) {
    const fastIdxPaths = !focusRel && isCleanWorktreeFast(absRoot)?.clean ? readGitIndexPathsFast(absRoot) : null
    if (fastIdxPaths) {
      for (const p of [...fastIdxPaths].sort()) { if (truncated) break; pushFile(p) }
      return { files, dirSummary, truncated, source: 'git-ls-files-z' }
    }
    const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    if (focusRel) args.push('--', focusRel)
    const res = await gitRunBuffer(absRoot, args)
    if (res.ok) {
      const paths = res.stdout.toString('utf8').split('\0').filter(Boolean).sort()
      for (const p of paths) {
        if (truncated) break
        pushFile(p)
      }
      return { files, dirSummary, truncated, source: 'git-ls-files-z' }
    }
  }

  const queue = [focusRel ? join(absRoot, focusRel) : absRoot]
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacOsJunkPath(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(absRoot, full))
      if (entry.isDirectory()) {
        if (!COMMON_SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        pushFile(rel)
        if (truncated) break
      }
    }
  }
  return { files, dirSummary, truncated, source: 'fs-walk' }
}

/** 现场解析仓库真实默认分支（strict=true 时无可用真实分支返回 null，严禁静默捏造 'main'）。 */
export async function resolveDefaultBranch(repoRoot, { strict = true } = {}) {
  if (!repoRoot || !existsSync(repoRoot)) return strict ? null : 'main'
  const fast = resolveDefaultBranchFast(repoRoot, null, { strict })
  if (fast) return fast
  const [originHeadRes, branchRes, initDefRes] = await Promise.all([
    gitRun(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    gitRun(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
    gitRun(repoRoot, ['config', '--get', 'init.defaultbranch']),
  ])
  if (originHeadRes.ok && originHeadRes.stdout.trim()) {
    return originHeadRes.stdout.trim().replace(/^origin\//, '')
  }
  const curBranch = branchRes.ok ? branchRes.stdout.trim() : undefined

  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    const local = await gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${cand}`])
    if (local.ok) return cand
    const remote = await gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${cand}`])
    if (remote.ok) return cand
  }
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  if (strict) return null
  const initDef = initDefRes.ok ? initDefRes.stdout.trim() : undefined
  return initDef || 'main'
}

/** 判断给定分支名是否为当前仓库的真实默认分支（单源替代 ['main','master'] 白名单）。 */
export async function isDefaultBranch(repoRoot, branchName) {
  const name = String(branchName ?? '').trim()
  if (!name || name === 'HEAD' || name === '(detached)') return false
  const def = await resolveDefaultBranch(repoRoot, { strict: true })
  return Boolean(def && name === def)
}

/** 探测项目格式、默认分支、提交风格与是否启用了四层 docs/ 体系。 */
export async function detectProjectConventions(repoRoot) {
  const wtGitDir = resolveGitDirFast(repoRoot)
  const fastHead = readHeadFast(wtGitDir)
  const isUnborn = Boolean(fastHead && !fastHead.oid)
  const fastLog = (!isUnborn && fastHead?.oid && wtGitDir) ? readLooseCommitLogFast(repoRoot, wtGitDir, fastHead.oid, 20) : null
  const [defaultBranch, logRes] = await Promise.all([
    resolveDefaultBranch(repoRoot, { strict: true }),
    isUnborn
      ? Promise.resolve({ ok: true, stdout: '' })
      : (fastLog?.complete ? Promise.resolve({ ok: true, stdout: fastLog.entries.map((e) => e.subject).join('\n') }) : gitRun(repoRoot, ['log', '--format=%s', '-n', '20'])),
  ])

  const subjects = logRes.ok && logRes.stdout
    ? logRes.stdout.split('\n').filter(Boolean)
    : []
  const commitStyle = detectCommitStyle(subjects)

  const hasDocsSystem = existsSync(join(repoRoot, 'docs', 'TDD.md'))
    || existsSync(join(repoRoot, 'docs', 'specs'))
    || existsSync(join(repoRoot, 'docs', 'todo'))
    || existsSync(join(repoRoot, 'docs', 'prd'))

  return { defaultBranch, commitStyle, hasDocsSystem }
}

/**
 * 使用 `git cherry` + `git patch-id` 判定分支相对于默认主干的四态合流状态：
 * `'merged' | 'squash_or_rebase_merged' | 'no_own_commits' | 'unmerged'`。
 */
export async function inspectBranchMergeState(mainRoot, { branch, headSha, defaultBranch = null, gitDir = null, cache = null } = {}) {
  const resolvedDefault = defaultBranch || await resolveDefaultBranch(mainRoot, { strict: true })
  if (!resolvedDefault) {
    return { state: 'unmerged', ownCommits: 0, isShallow: false, reason: '缺少可用的默认基线分支' }
  }
  const targetRef = branch || headSha
  const resolvedGitDir = gitDir ?? resolveGitDirFast(mainRoot)
  const canFastShallow = Boolean(resolvedGitDir && !existsSync(join(resolvedGitDir, 'reftable')))
  const fastBaseSha = canFastShallow && resolvedDefault ? resolveRefShaFast(resolvedGitDir, `refs/heads/${resolvedDefault}`) : null
  const fastTargetSha = canFastShallow && branch ? resolveRefShaFast(resolvedGitDir, `refs/heads/${branch}`) : (headSha ?? null)
  const sameTip = Boolean(fastBaseSha && fastTargetSha && fastBaseSha === fastTargetSha)
  const fastOwnCount = (fastBaseSha && fastTargetSha && !sameTip) ? countCommitsAheadDagFast(resolvedGitDir, fastBaseSha, fastTargetSha) : null
  const [shallowRes, baseCheck, ownRes] = await Promise.all([
    canFastShallow
      ? Promise.resolve({ ok: true, stdout: existsSync(join(resolvedGitDir, 'shallow')) ? 'true' : 'false' })
      : gitRun(mainRoot, ['rev-parse', '--is-shallow-repository']),
    targetRef
      ? (fastBaseSha ? Promise.resolve({ ok: true, stdout: fastBaseSha }) : gitRun(mainRoot, ['rev-parse', '--verify', '--quiet', resolvedDefault]))
      : Promise.resolve({ ok: false }),
    targetRef
      ? (sameTip
          ? Promise.resolve({ ok: true, stdout: '0' })
          : (fastOwnCount !== null ? Promise.resolve({ ok: true, stdout: String(fastOwnCount) }) : gitRun(mainRoot, ['--no-optional-locks', 'rev-list', '--count', `${resolvedDefault}..${targetRef}`])))
      : Promise.resolve({ ok: false, stdout: '0' }),
  ])
  const isShallow = shallowRes.ok && shallowRes.stdout.trim() === 'true'
  if (!targetRef) return { state: 'unmerged', ownCommits: 0, isShallow, reason: '缺少目标分支或提交引用' }
  if (!baseCheck.ok) return { state: 'unmerged', ownCommits: 0, isShallow, reason: `基线分支 ${resolvedDefault} 不存在` }

  const ownCommits = ownRes.ok ? (Number(ownRes.stdout.trim()) || 0) : 1
  const isAncestor = ownRes.ok && ownCommits === 0

  if (isAncestor && ownCommits === 0) {
    let inFirstParents = sameTip
    if (!sameTip) {
      const loadFirstParents = () => {
        if (cache?.firstParentPromises?.has(resolvedDefault)) return cache.firstParentPromises.get(resolvedDefault)
        const fastFp = fastBaseSha ? readFirstParentsFast(resolvedGitDir, fastBaseSha, 200) : null
        const p = fastFp
          ? Promise.resolve(fastFp)
          : gitRun(mainRoot, ['--no-optional-locks', 'rev-list', '--first-parent', '-n', '200', resolvedDefault])
              .then((r) => new Set(r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []))
        cache?.firstParentPromises?.set(resolvedDefault, p)
        return p
      }
      const [targetShaRes, firstParentSet] = await Promise.all([
        fastTargetSha ? Promise.resolve({ ok: true, stdout: fastTargetSha }) : gitRun(mainRoot, ['rev-parse', targetRef]),
        loadFirstParents(),
      ])
      const targetSha = targetShaRes.ok ? targetShaRes.stdout.trim() : ''
      inFirstParents = !targetSha || firstParentSet.has(targetSha)
    }
    if (!inFirstParents) {
      return { state: 'merged', ownCommits: 0, isShallow, reason: `已合入 ${resolvedDefault}` }
    }
    const fastReflog = branch && canFastShallow ? readReflogFast(resolvedGitDir, `refs/heads/${branch}`) : null
    const reflogLines = fastReflog ?? (branch ? (await gitRun(mainRoot, ['--no-optional-locks', 'reflog', 'show', '--format=%gs', `refs/heads/${branch}`])).stdout?.split('\n') : []) ?? []
    const hasCommitReflog = reflogLines.some((l) => /^(?:commit(?:\s|\(|:)|cherry-pick)/.test(l.trim()))
    if (hasCommitReflog) {
      return { state: 'merged', ownCommits: 0, isShallow, reason: `已合入 ${resolvedDefault}` }
    }
    return { state: 'no_own_commits', ownCommits: 0, isShallow, reason: `无领先 ${resolvedDefault} 的独立提交` }
  }

  const fastAnc = fastBaseSha && fastTargetSha ? isAncestorLinearFast(resolvedGitDir, fastBaseSha, fastTargetSha) : null
  const mbSha = fastAnc === true
    ? fastBaseSha
    : ((await gitRun(mainRoot, ['--no-optional-locks', 'merge-base', resolvedDefault, targetRef])).stdout?.trim() ?? '')
  if (mbSha && fastBaseSha && mbSha === fastBaseSha) {
    return { state: 'unmerged', ownCommits, isShallow, reason: `存在 ${ownCommits} 个未合并提交` }
  }
  const cherryRes = await gitRun(mainRoot, ['--no-optional-locks', 'cherry', resolvedDefault, targetRef])
  const cherryLines = cherryRes.ok && cherryRes.stdout
    ? cherryRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    : []
  if (cherryLines.length > 0 && cherryLines.every((l) => l.startsWith('- '))) {
    return {
      state: 'squash_or_rebase_merged',
      ownCommits,
      isShallow,
      reason: `全部 ${cherryLines.length} 个提交均已通过 rebase/cherry-pick 落地 ${resolvedDefault}`,
    }
  }

  if (mbSha) {
    const diffRes = await gitRun(mainRoot, ['--no-optional-locks', 'diff', mbSha, targetRef])
    if (diffRes.ok && diffRes.stdout) {
      const loadDefaultPatchIds = () => {
        if (cache?.patchIdPromises?.has(resolvedDefault)) return cache.patchIdPromises.get(resolvedDefault)
        const p = gitRun(mainRoot, ['--no-optional-locks', 'log', '-n', '60', '--no-merges', '-p', resolvedDefault], { timeout: 30000 })
          .then((lr) => (lr.ok && lr.stdout ? gitRun(mainRoot, ['patch-id', '--stable'], { input: lr.stdout }) : { ok: false }))
          .then((pr) => new Set(pr.ok && pr.stdout ? pr.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean) : []))
        cache?.patchIdPromises?.set(resolvedDefault, p)
        return p
      }
      const [branchPidRes, set] = await Promise.all([
        gitRun(mainRoot, ['patch-id', '--stable'], { input: diffRes.stdout }),
        loadDefaultPatchIds(),
      ])
      const branchPid = branchPidRes.ok ? branchPidRes.stdout.trim().split(/\s+/)[0] : ''
      if (branchPid && set.has(branchPid)) {
        return {
          state: 'squash_or_rebase_merged',
          ownCommits,
          isShallow,
          reason: `合并补丁 patch-id 与 ${resolvedDefault} 提交完全一致（Squash 合并）`,
        }
      }
    }
  }

  return { state: 'unmerged', ownCommits, isShallow, reason: `存在 ${ownCommits} 个未合并提交` }
}

/** 同步或按需创建干净的 detached 审查隔离工作树至 targetSha，脏工作树直接阻断（支持 resetDirty）。 */
export async function syncDetachedWorktree(mainRoot, wtAbs, targetSha, { resetDirty = false } = {}) {
  return syncDetachedWorktreeRaw(mainRoot, wtAbs, targetSha, { resetDirty, checkStatusFn: gitStatusPorcelainZ })
}
