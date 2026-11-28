/**
 * git-worktree-env.mjs —— Worktree 边界解析、`.worktrees/` 忽略守护与 detached 审查工作树同步。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 git.mjs 重导出以保持向后兼容。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { computeWorktreeEnv, withFileLock } from './exec.mjs'
import { canonicalPath, gitRun, readTextSafe, samePath, writeAtomic } from './git-core.mjs'
import { hasDotGitInAncestors, resolveGitDirFast } from './git-index-fast.mjs'
import { hasNoGlobalExcludesFast } from './git-status-fast.mjs'

export { computeWorktreeEnv }

/** 解析 `git worktree list --porcelain` 输出，路径统一 canonicalPath。 */
export function parseWorktreeListPorcelain(text) {
  const items = []
  let cur = null
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') {
      if (cur) items.push(cur)
      cur = null
      continue
    }
    if (line.startsWith('worktree ')) {
      cur = { path: canonicalPath(line.slice(9).trim()), head: null, branch: null, detached: false, bare: false, prunable: null }
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim()
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    } else if (cur && line.trim() === 'detached') {
      cur.detached = true
    } else if (cur && line.trim() === 'bare') {
      cur.bare = true
    } else if (cur && line.startsWith('prunable')) {
      cur.prunable = line.slice(8).trim() || 'missing directory'
    }
  }
  if (cur) items.push(cur)
  return items
}

function tryResolveRepoRootsFast(absCwd) {
  const dotGit = join(absCwd, '.git')
  if (!existsSync(dotGit)) return null
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) {
      if (!existsSync(join(dotGit, 'HEAD'))) return null
      const cfg = readTextSafe(join(dotGit, 'config')) ?? ''
      if (/^\s*bare\s*=\s*true\b/im.test(cfg)) return null
      return {
        isGit: true,
        cwd: absCwd,
        mainRoot: absCwd,
        workTreeRoot: absCwd,
        gitDir: dotGit,
        workTreeGitDir: dotGit,
        isWorktree: false,
        isBare: false,
      }
    }
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (!m) return null
      const perWtGitDir = canonicalPath(resolve(absCwd, m[1].trim()))
      if (!existsSync(join(perWtGitDir, 'HEAD'))) return null
      const commondirFile = join(perWtGitDir, 'commondir')
      if (!existsSync(commondirFile)) return null
      const relCommon = readFileSync(commondirFile, 'utf8').trim()
      const commonDir = canonicalPath(resolve(perWtGitDir, relCommon))
      if (basename(commonDir).toLowerCase() !== '.git') return null
      if (!samePath(dirname(dirname(perWtGitDir)), commonDir)) return null
      const mainRoot = canonicalPath(dirname(commonDir))
      return {
        isGit: true,
        cwd: absCwd,
        mainRoot,
        workTreeRoot: absCwd,
        gitDir: commonDir,
        workTreeGitDir: perWtGitDir,
        isWorktree: !samePath(mainRoot, absCwd),
        isBare: false,
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 解析当前目录所属的 Git 仓库边界。
 * 常规仓与 `.worktrees/` 链接工作树通过本地 `.git` 元信息直接零开销解析；
 * 子目录、子模块或 `--separate-git-dir` 自动回退 `git rev-parse`。
 */
export async function resolveRepoRoots(cwd = process.cwd()) {
  const absCwd = canonicalPath(cwd)
  const fast = tryResolveRepoRootsFast(absCwd)
  if (fast) return fast
  if (!hasDotGitInAncestors(absCwd)) {
    return {
      isGit: false, cwd: absCwd, mainRoot: absCwd, workTreeRoot: absCwd,
      gitDir: null, workTreeGitDir: null, isWorktree: false, isBare: false,
    }
  }

  const res = await gitRun(absCwd, [
    'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--is-bare-repository', '--git-dir',
  ])
  if (!res.ok || !res.stdout) {
    return {
      isGit: false, cwd: absCwd, mainRoot: absCwd, workTreeRoot: absCwd,
      gitDir: null, workTreeGitDir: null, isWorktree: false, isBare: false,
    }
  }
  const lines = res.stdout.split('\n').map((l) => l.trim())
  const inside = lines[0] === 'true'
  const topLevel = lines[1] ? canonicalPath(lines[1]) : absCwd
  const commonDir = lines[2] ? canonicalPath(resolve(absCwd, lines[2])) : join(topLevel, '.git')
  const isBare = lines[3] === 'true'
  const perWtGitDir = lines[4] ? canonicalPath(resolve(absCwd, lines[4])) : commonDir

  if (!inside || isBare) {
    return {
      isGit: isBare, cwd: absCwd, mainRoot: absCwd, workTreeRoot: absCwd,
      gitDir: commonDir, workTreeGitDir: perWtGitDir, isWorktree: false, isBare,
    }
  }

  let mainRoot = null
  const isStandardDotGit = basename(commonDir).toLowerCase() === '.git'
  if (isStandardDotGit && samePath(commonDir, perWtGitDir) && samePath(dirname(commonDir), topLevel)) {
    mainRoot = topLevel
  } else if (isStandardDotGit && !samePath(commonDir, perWtGitDir) && samePath(dirname(dirname(perWtGitDir)), commonDir)) {
    mainRoot = canonicalPath(dirname(commonDir))
  } else {
    const wtRes = await gitRun(topLevel, ['worktree', 'list', '--porcelain'])
    if (wtRes.ok && wtRes.stdout) {
      const list = parseWorktreeListPorcelain(wtRes.stdout)
      const primary = list.find((item) => !item.bare)
      if (primary?.path) mainRoot = primary.path
    }
    if (!mainRoot) {
      mainRoot = isStandardDotGit ? canonicalPath(dirname(commonDir)) : topLevel
    }
  }

  return {
    isGit: true, cwd: absCwd, mainRoot, workTreeRoot: topLevel,
    gitDir: commonDir, workTreeGitDir: perWtGitDir,
    isWorktree: !samePath(mainRoot, topLevel), isBare: false,
  }
}

function hasWorktreesRuleInFile(filePath) {
  const txt = readTextSafe(filePath)
  return Boolean(txt && txt.split('\n').some((l) => /^\/?\.worktrees\/?$/.test(l.trim())))
}

/** 确保 .worktrees/ 已被 Git 忽略（优先零进程本地核对，写 `.git/info/exclude` 加文件锁）。 */
export async function ensureWorktreesIgnored(mainRoot, gitDir) {
  const actualGitDir = gitDir ?? join(mainRoot, '.git')
  const excludeFile = join(actualGitDir, 'info', 'exclude')
  if (hasWorktreesRuleInFile(join(mainRoot, '.gitignore')) || hasWorktreesRuleInFile(excludeFile)) return { ok: true, method: 'existing' }
  if (!hasNoGlobalExcludesFast(actualGitDir) && (await gitRun(mainRoot, ['check-ignore', '-q', '.worktrees'])).ok) return { ok: true, method: 'existing' }
  const lockPath = join(actualGitDir, 'project-forge-flow', 'locks', 'info-exclude.lock')
  try {
    return await withFileLock(lockPath, () => {
      mkdirSync(dirname(excludeFile), { recursive: true })
      const cur = readTextSafe(excludeFile) ?? ''
      const hasRule = cur.split('\n').some((l) => {
        const t = l.trim()
        return t === '.worktrees' || t === '.worktrees/' || t === '/.worktrees' || t === '/.worktrees/'
      })
      if (!hasRule) {
        const next = cur.length > 0 && !cur.endsWith('\n') ? `${cur}\n.worktrees/\n` : `${cur}.worktrees/\n`
        writeAtomic(excludeFile, next)
      }
      return { ok: true, method: 'git-info-exclude' }
    })
  } catch {
    return { ok: false, method: 'unignored' }
  }
}

/** 同步或按需创建干净的 detached 审查隔离工作树至 targetSha，脏工作树直接阻断（支持 resetDirty）。 */
export async function syncDetachedWorktreeCore(mainRoot, wtAbs, targetSha, { resetDirty = false, checkStatusFn } = {}) {
  if (!targetSha || targetSha === 'UNBORN') {
    throw new Error('目标工作区尚无有效提交（UNBORN HEAD），无法同步审查隔离工作树')
  }
  if (existsSync(wtAbs)) {
    if (resetDirty) {
      await gitRun(wtAbs, ['reset', '--hard'])
      await gitRun(wtAbs, ['clean', '-fd'])
    }
    const st = typeof checkStatusFn === 'function'
      ? await checkStatusFn(wtAbs)
      : await gitRun(wtAbs, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-u']).then((r) => ({
          ok: r.ok, entries: r.ok && r.stdout ? r.stdout.split('\0').filter(Boolean) : [], stderr: r.stderr,
        }))
    if (!st.ok) throw new Error(`读取审查工作树状态失败（${wtAbs}）：${st.stderr}`)
    if (st.entries.length > 0) {
      throw new Error(`BLOCKED_DIRTY_REVIEW_WORKTREE: 审查工作树 ${wtAbs} 存在未提交改动，请先清理后再推进审查`)
    }
    const wtGitDir = resolveGitDirFast(wtAbs)
    const fastSha = wtGitDir ? readTextSafe(join(wtGitDir, 'HEAD'))?.trim() : null
    if (fastSha && /^[0-9a-f]{40,64}$/i.test(fastSha) && fastSha === targetSha) {
      return { ok: true, action: resetDirty ? 'reset-synced' : 'already-synced', headSha: targetSha, path: wtAbs }
    }
    const curHead = (fastSha && /^[0-9a-f]{40,64}$/i.test(fastSha))
      ? { ok: true, stdout: fastSha }
      : await gitRun(wtAbs, ['rev-parse', 'HEAD'])
    if (curHead.ok && curHead.stdout.trim() === targetSha) {
      return { ok: true, action: resetDirty ? 'reset-synced' : 'already-synced', headSha: targetSha, path: wtAbs }
    }
    const co = await gitRun(wtAbs, ['checkout', '--detach', targetSha])
    if (!co.ok) throw new Error(`推进审查工作树至 ${targetSha.slice(0, 7)} 失败：${co.stderr}`)
    return { ok: true, action: resetDirty ? 'reset-updated' : 'updated', headSha: targetSha, path: wtAbs }
  }
  const addRes = await gitRun(mainRoot, ['worktree', 'add', '--detach', wtAbs, targetSha])
  if (!addRes.ok) throw new Error(`创建审查隔离工作树失败：${addRes.stderr}`)
  return { ok: true, action: 'created', headSha: targetSha, path: wtAbs }
}
