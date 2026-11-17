#!/usr/bin/env node
/**
 * worktree-deps.mjs —— Workspace 感知的 Worktree 共享依赖挂载与安全解绑引擎。
 *
 * 规则：
 *   1. 按子包/生态独立比对锁文件 SHA256（单个子包变更只隔离该子包，不连坐其余子包）；
 *   2. 探测到 npm/pnpm/yarn Workspace 本地软链或 Python editable `.venv` 指回主仓源码时自动局部隔离防毒化；
 *   3. `samePath(main, wt)` 严禁自挂载/自解绑，半途失败原子回滚已建链接；
 *   4. 清理前按「是不是链接」而不是「叫什么名字」全深度扫一遍 worktree，把指向外部的链接
 *      逐个解绑并列出来，再校验主仓完好——`git worktree remove --force` 会跟随 junction，
 *      而它不会替你判断那个链接指向哪里。
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { canonicalPath, isMainModule, posixPath, readJsonSafe, readTextSafe, samePath, sha256File, sha256Text, writeAtomic } from '../../lib/git.mjs'
import { isPathInGitIndexFast } from '../../lib/git-fast.mjs'
import { discoverWorkspacePackages } from '../../lib/profile.mjs'

const NODE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
const PY_LOCKFILES = ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'requirements-dev.txt']
const PYTHON_DEP_DIRS = ['.venv', 'venv']

function lstatSafe(p) {
  try { return lstatSync(p) } catch { return null }
}

function statSafe(p) {
  try { return statSync(p) } catch { return null }
}

function isInsideDir(candidateAbs, parentAbs) {
  const c = canonicalPath(candidateAbs)
  const p = canonicalPath(parentAbs)
  if (samePath(c, p)) return true
  const rel = relative(p, c)
  return Boolean(rel && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith('/'))
}

function hashLockfile(filePath) {
  const st = statSafe(filePath)
  if (!st || !st.isFile()) return null
  if (filePath.toLowerCase().endsWith('.lockb')) return sha256File(filePath)
  try {
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return sha256File(filePath)
    return sha256Text(buf.toString('utf8').replace(/\r\n/g, '\n'))
  } catch {
    return null
  }
}

function collectCandidatePackageDirs(root) {
  const dirs = new Set([''])
  const disc = discoverWorkspacePackages(root)
  for (const pkg of disc.packages) dirs.add(pkg.dirRel)
  for (const depName of ['node_modules', ...PYTHON_DEP_DIRS]) {
    if (existsSync(join(root, depName))) dirs.add('')
  }
  // 同时吸收含本地 node_modules/.venv 的非根目录子目录
  const queue = ['']
  let seen = 0
  while (queue.length > 0 && seen < 1500) {
    const rel = queue.shift()
    const abs = rel ? join(root, rel) : root
    let entries = []
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (['.git', '.worktrees', 'dist', 'build', 'target', 'coverage', '.cache'].includes(entry.name)) continue
      if (entry.name === 'node_modules' || PYTHON_DEP_DIRS.includes(entry.name)) {
        dirs.add(rel)
        continue
      }
      if (!entry.name.startsWith('.')) {
        seen += 1
        queue.push(rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
  }
  return [...dirs].sort()
}

function compareUnitLocks(mainAbs, wtAbs, dirRel, lockNames) {
  const lockfiles = []
  const mismatches = []
  for (const name of lockNames) {
    const rel = dirRel ? `${dirRel}/${name}` : name
    const mainHash = hashLockfile(join(mainAbs, rel))
    const wtHash = hashLockfile(join(wtAbs, rel))
    if (mainHash === null && wtHash === null) continue
    lockfiles.push({ file: rel, mainHash, wtHash })
    if (mainHash !== wtHash) {
      mismatches.push({
        file: rel,
        mainHash,
        wtHash,
        reason: mainHash === null ? 'added-in-worktree' : wtHash === null ? 'removed-in-worktree' : 'hash-mismatch',
      })
    }
  }
  return { match: mismatches.length === 0, lockfiles, mismatches }
}

function detectNodeWorkspacePoisoning(mainAbs, nodeModulesAbs) {
  if (!existsSync(nodeModulesAbs)) return null
  const inspectEntry = (entryPath) => {
    const st = lstatSafe(entryPath)
    if (!st || !st.isSymbolicLink()) return null
    try {
      const targetReal = realpathSync.native(entryPath)
      if (isInsideDir(targetReal, mainAbs) && !isInsideDir(targetReal, nodeModulesAbs)) {
        return `Workspace 软链指回主仓源码 (${posixPath(relative(mainAbs, targetReal))})`
      }
    } catch { /* ignore broken link */ }
    return null
  }
  try {
    for (const e of readdirSync(nodeModulesAbs, { withFileTypes: true })) {
      const full = join(nodeModulesAbs, e.name)
      const direct = inspectEntry(full)
      if (direct) return direct
      if (e.name.startsWith('@') && e.isDirectory()) {
        for (const sub of readdirSync(full, { withFileTypes: true })) {
          const scoped = inspectEntry(join(full, sub.name))
          if (scoped) return scoped
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

function detectPythonEditablePoisoning(mainAbs, venvAbs) {
  if (!existsSync(venvAbs)) return null
  const siteCandidates = []
  for (const libBase of ['lib', 'lib64', 'Lib']) {
    const p = join(venvAbs, libBase)
    if (!existsSync(p)) continue
    if (libBase === 'Lib') {
      const sp = join(p, 'site-packages')
      if (existsSync(sp)) siteCandidates.push(sp)
      continue
    }
    try {
      for (const pyDir of readdirSync(p)) {
        if (!/^python/i.test(pyDir)) continue
        const sp = join(p, pyDir, 'site-packages')
        if (existsSync(sp)) siteCandidates.push(sp)
      }
    } catch { /* ignore */ }
  }

  for (const sp of siteCandidates) {
    let entries = []
    try { entries = readdirSync(sp, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(sp, entry.name)
      if (entry.isFile() && (entry.name.endsWith('.pth') || entry.name.endsWith('.egg-link'))) {
        const txt = readTextSafe(full, 128 * 1024) ?? ''
        for (const line of txt.split('\n')) {
          const t = line.trim()
          if (!t || t.startsWith('#') || t.startsWith('import ')) continue
          const targetAbs = resolve(sp, t)
          if (isInsideDir(targetAbs, mainAbs) && !isInsideDir(targetAbs, venvAbs)) {
            return `Python editable 安装指回主仓（${entry.name} -> ${posixPath(relative(mainAbs, targetAbs))}）`
          }
        }
      } else if (entry.isDirectory() && entry.name.endsWith('.dist-info')) {
        const directUrl = readJsonSafe(join(full, 'direct_url.json'))
        const isEditable = directUrl?.dir_info?.editable === true
        const rawUrl = String(directUrl?.url ?? '')
        if (isEditable && /^file:\/\//i.test(rawUrl)) {
          try {
            const urlPath = decodeURIComponent(new URL(rawUrl).pathname).replace(/^\/([A-Za-z]:)/, '$1')
            if (isInsideDir(urlPath, mainAbs) && !isInsideDir(urlPath, venvAbs)) {
              return `Python editable direct_url 指回主仓（${posixPath(relative(mainAbs, urlPath))}）`
            }
          } catch { /* ignore */ }
        }
      }
    }
  }
  return null
}

/** 按子包与生态独立比对主仓与 worktree 锁文件。 */
export function compareLockfiles(mainRoot, wtRoot) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  const dirs = new Set([...collectCandidatePackageDirs(mainAbs), ...collectCandidatePackageDirs(wtAbs)])

  const lockfiles = []
  const mismatches = []
  const units = []

  for (const dirRel of [...dirs].sort()) {
    const nodeCmp = compareUnitLocks(mainAbs, wtAbs, dirRel, NODE_LOCKFILES)
    if (nodeCmp.lockfiles.length > 0 || existsSync(join(mainAbs, dirRel, 'node_modules'))) {
      units.push({ dirRel, ecosystem: 'node', depDir: 'node_modules', ...nodeCmp })
      lockfiles.push(...nodeCmp.lockfiles)
      mismatches.push(...nodeCmp.mismatches)
    }

    const pyCmp = compareUnitLocks(mainAbs, wtAbs, dirRel, PY_LOCKFILES)
    const hasPyDir = PYTHON_DEP_DIRS.some((d) => existsSync(join(mainAbs, dirRel, d)))
    if (pyCmp.lockfiles.length > 0 || hasPyDir) {
      units.push({ dirRel, ecosystem: 'python', depDirs: PYTHON_DEP_DIRS, ...pyCmp })
      lockfiles.push(...pyCmp.lockfiles)
      mismatches.push(...pyCmp.mismatches)
    }
  }

  const match = mismatches.length === 0
  return {
    match,
    reason: match ? 'lockfile-match' : 'lockfile-changed',
    checkedCount: lockfiles.length,
    mismatches,
    lockfiles,
    units,
  }
}

/** 按子包独立比对锁文件并防毒化探测，安全挂载可共享依赖（半途失败原子回滚；外部 PR 未扫未批硬阻断）。 */
export function mountSharedDeps(mainRoot, wtRoot, opts = {}) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (!existsSync(wtAbs)) throw new Error(`目标 worktree 目录不存在：${wtAbs}`)
  if (samePath(mainAbs, wtAbs)) throw new Error(`拒绝自挂载：mainRoot 与 worktree 指向同一目录 (${mainAbs})`)

  if (!opts.allowUntrusted) {
    const wtName = basename(wtAbs)
    const stateDir = join(mainAbs, '.worktrees', '.state', 'tasks')
    let matchedLedger = readJsonSafe(join(stateDir, `${wtName}.json`))
    if (!matchedLedger && existsSync(stateDir)) {
      try {
        for (const fn of readdirSync(stateDir).filter((f) => f.endsWith('.json'))) {
          const cand = readJsonSafe(join(stateDir, fn))
          if (cand && (cand.reviewWorktreePath === `.worktrees/${wtName}` || cand.worktreePath === `.worktrees/${wtName}`)) {
            matchedLedger = cand
            break
          }
        }
      } catch { /* ignore */ }
    }
    if (/^review-pr-\d+$/.test(wtName) || matchedLedger?.role === 'inbound-external-pr') {
      const scanOk = matchedLedger?.untrustedScanPassed === true
      const approved = Boolean(matchedLedger?.untrustedApproved === true || matchedLedger?.humanApprovedExec === true)
      if (!scanOk || !approved) {
        const reason = !scanOk ? '尚未通过 --untrusted-scan 静态扫描' : '尚未获得人类安全授权'
        throw new Error(`BLOCKED_UNTRUSTED_PR_UNSCANNED: 外部 PR 隔离位 (${wtName}) ${reason}，禁止挂载共享依赖。`)
      }
    }
  }

  const cmp = compareLockfiles(mainAbs, wtAbs)
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const mounted = []
  const alreadyMounted = []
  const isolatedUnits = []
  const skipped = []
  const createdThisRun = []

  try {
    for (const unit of cmp.units) {
      if (unit.dirRel && !existsSync(join(wtAbs, unit.dirRel))) {
        skipped.push({ path: unit.dirRel, reason: 'package-absent-in-worktree' })
        continue
      }
      if (!unit.match) {
        isolatedUnits.push({
          dirRel: unit.dirRel || '.',
          ecosystem: unit.ecosystem,
          reason: 'lockfile-changed',
          mismatches: unit.mismatches,
        })
        continue
      }

      const depNames = unit.ecosystem === 'node' ? ['node_modules'] : PYTHON_DEP_DIRS
      for (const depName of depNames) {
        const rel = unit.dirRel ? `${unit.dirRel}/${depName}` : depName
        const src = join(mainAbs, rel)
        const srcStat = statSafe(src)
        if (!srcStat || !srcStat.isDirectory()) continue
        const srcReal = canonicalPath(src)

        const poisonReason = unit.ecosystem === 'node'
          ? detectNodeWorkspacePoisoning(mainAbs, srcReal)
          : detectPythonEditablePoisoning(mainAbs, srcReal)
        if (poisonReason) {
          isolatedUnits.push({
            dirRel: unit.dirRel || '.',
            ecosystem: unit.ecosystem,
            path: posixPath(rel),
            reason: unit.ecosystem === 'node' ? 'workspace-symlink-poisoning' : 'python-editable-poisoning',
            detail: poisonReason,
          })
          continue
        }

        const dst = join(wtAbs, rel)
        const dstLstat = lstatSafe(dst)
        if (dstLstat) {
          if (dstLstat.isSymbolicLink() && samePath(dst, srcReal)) {
            alreadyMounted.push({ path: posixPath(rel), target: srcReal })
          } else {
            skipped.push({ path: posixPath(rel), reason: dstLstat.isSymbolicLink() ? 'existing-other-symlink' : 'existing-real-dir' })
          }
          continue
        }

        mkdirSync(dirname(dst), { recursive: true })
        symlinkSync(srcReal, dst, linkType)
        createdThisRun.push(dst)
        mounted.push({ path: posixPath(rel), target: srcReal, linkType })
      }
    }
  } catch (err) {
    for (const created of createdThisRun.reverse()) {
      try { unlinkSync(created) } catch { /* 回滚失败忽略 */ }
    }
    throw err
  }

  const mountedRelPaths = [...mounted, ...alreadyMounted].map((item) => item.path)
  if (mountedRelPaths.length > 0) ensureMountedDepsExcluded(mainAbs, mountedRelPaths)

  const hasShared = mounted.length > 0 || alreadyMounted.length > 0
  let mode = 'none'
  let reason = 'no-main-deps'
  if (hasShared) {
    mode = isolatedUnits.length > 0 ? 'partial' : 'shared'
    reason = isolatedUnits.length > 0 ? 'partial-isolated' : 'lockfile-match'
  } else if (isolatedUnits.length > 0) {
    mode = 'isolated'
    reason = isolatedUnits[0].reason
  }

  return {
    ok: true,
    mode,
    reason,
    mismatches: cmp.mismatches,
    mounted,
    alreadyMounted,
    isolatedUnits,
    skipped,
  }
}

function resolveCommonGitDir(mainAbs) {
  const dotGit = join(mainAbs, '.git')
  const st = statSafe(dotGit)
  if (!st) return null
  if (st.isDirectory()) return dotGit
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/mi.exec(readTextSafe(dotGit) ?? '')
    if (!m) return null
    const actualGitDir = resolve(mainAbs, m[1].trim())
    const commonRef = readTextSafe(join(actualGitDir, 'commondir'))
    return commonRef?.trim() ? resolve(actualGitDir, commonRef.trim()) : actualGitDir
  }
  return null
}

function ensureMountedDepsExcluded(mainAbs, relPaths) {
  if (!relPaths || relPaths.length === 0) return
  const commonGitDir = resolveCommonGitDir(mainAbs)
  if (!commonGitDir) return
  const excludeFile = join(commonGitDir, 'info', 'exclude')
  try {
    mkdirSync(dirname(excludeFile), { recursive: true })
    const cur = readTextSafe(excludeFile) ?? ''
    const existing = new Set(cur.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
    const toAdd = []
    for (const rel of relPaths) {
      const rule = `/${posixPath(rel).replace(/^\/+|\/+$/g, '')}`
      if (rule.length > 1 && !existing.has(rule) && !toAdd.includes(rule)) toAdd.push(rule)
    }
    if (toAdd.length === 0) return
    const prefix = cur.length > 0 && !cur.endsWith('\n') ? `${cur}\n` : cur
    writeAtomic(excludeFile, `${prefix}${toAdd.join('\n')}\n`)
  } catch { /* ignore non-writable exclude */ }
}

export function scanOutboundLinks(wtRoot) {
  const wtAbs = canonicalPath(wtRoot)
  const outbound = []
  const internal = []
  const broken = []
  if (!existsSync(wtAbs)) return { outbound, internal, broken }

  const walk = (absDir, relDir, depth) => {
    if (depth > 24) return
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = join(absDir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      // `.git` 是 worktree 的元数据，不是用户内容，删它是 `git worktree remove` 的本职。
      if (rel === '.git') continue
      const st = lstatSafe(abs)
      if (!st) continue

      if (st.isSymbolicLink()) {
        let target = null
        try { target = readlinkSync(abs) } catch { /* 悬空链接读不到目标 */ }
        let resolved = null
        try { resolved = realpathSync.native(abs) } catch { /* 目标可能已不存在 */ }
        if (resolved === null) {
          broken.push({ path: posixPath(rel), target })
          outbound.push({ path: posixPath(rel), target, kind: 'unresolved', resolved: null })
          continue
        }
        if (isInsideDir(resolved, wtAbs)) internal.push({ path: posixPath(rel), target })
        else outbound.push({ path: posixPath(rel), target, kind: 'outside', resolved: posixPath(resolved) })
        continue
      }

      // junction 在 Windows 上 lstat 也报 symlink，这里兜的是「真目录里还嵌着链接」。
      if (entry.isDirectory()) walk(abs, rel, depth + 1)
    }
  }

  walk(wtAbs, '', 0)
  return { outbound, internal, broken }
}

export function unmountSharedDeps(mainRoot, wtRoot, { allowOutbound = [], mode = 'cleanup' } = {}) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (samePath(mainAbs, wtAbs)) throw new Error(`拒绝自解绑：mainRoot 与 worktree 指向同一目录 (${mainAbs})`)
  if (!existsSync(wtAbs)) {
    return { ok: true, unmounted: [], skipped: [], blocked: [], mainDepsIntact: true, note: 'worktree-absent' }
  }

  const allowed = new Set((allowOutbound ?? []).map((p) => posixPath(p).replace(/^\.\//, '').replace(/\/+$/, '')))
  const scan = scanOutboundLinks(wtAbs)
  // 默认档（cleanup）下一步是 `git worktree remove`：未获准的外链必须当场拦下。
  // 依赖清场档（deps）worktree 不会消失：照常解绑并列出来，但目标完好校验一样要过。
  const strict = mode !== 'deps'

  const unmounted = []
  const skipped = []
  const blocked = []

  const before = scan.outbound.map((item) => ({ path: item.path, resolved: item.resolved }))

  for (const link of scan.outbound) {
    if (link.kind === 'unresolved') {
      // 解不出来的悬空链接：cleanup 档不能删（连带删什么不知道），deps 档可以解绑。
      if (strict) {
        blocked.push({ path: link.path, target: link.target, reason: 'unresolved-target' })
        continue
      }
    } else if (!allowed.has(link.path) && strict) {
      blocked.push({ path: link.path, target: link.target, reason: 'points-outside-worktree', resolved: link.resolved })
      continue
    }

    const abs = join(wtAbs, link.path)

    // 已被 Git 跟踪的链接**不能豁免**。
    //
    // 豁免的初衷是「git 自己会删，不用我们管」，但 git 删含链接的目录时会跟着链接走进去：
    // 实测在分支里提交一个指向仓外的符号链接，cleanup 把它记进 skipped、
    // 紧接着 git worktree remove --force 退出 0，**仓外那个目录的内容被删了**。
    //
    // 所以只有「worktree 不消失」的依赖清场档才跳过（解绑会让工作区变脏）；
    // 删除档一律解绑——反正整个目录马上就没，链接删掉不影响任何事。
    if (strict) {
      const fastTracked = isPathInGitIndexFast(wtAbs, link.path)
      const isTracked = fastTracked !== null
        ? fastTracked
        : spawnSync('git', ['ls-files', '--error-unmatch', '--', link.path], { cwd: wtAbs, stdio: 'ignore', windowsHide: true }).status === 0
      if (isTracked) {
        // 记下来，回执里要能看见「这一条是被 Git 跟踪的」——排查时这是关键信息。
        skipped.push({ path: link.path, reason: 'tracked-in-git-but-unlinked' })
      }
    }

    let targetBefore = null
    try { targetBefore = readlinkSync(abs) } catch { /* ignore */ }
    unlinkSync(abs)
    if (lstatSafe(abs) !== null) throw new Error(`解绑链接失败，路径仍然存在：${abs}`)
    unmounted.push({ path: link.path, target: targetBefore })
  }

  // 解绑只允许动链接本身，绝不允许连带目标内容。逐个复核目标还在。
  const missingTargets = before
    .filter((item) => item.resolved)
    .filter((item) => !existsSync(item.resolved))
  if (missingTargets.length > 0) {
    throw new Error(`安全校验失败：解绑之后外部目标不见了（${missingTargets.map((m) => `${m.path} -> ${m.resolved}`).join(', ')}）`
      + '——解绑只该删链接，不该碰目标内容')
  }

  return {
    ok: blocked.length === 0,
    unmounted,
    skipped,
    blocked,
    scanned: { outbound: scan.outbound.length, internal: scan.internal.length, broken: scan.broken.length },
  }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/worktree-deps.mjs <mount|unmount|scan|status> --main <主仓> --worktree <工作树> [--allow-outbound <路径>] [--json]',
    '',
    '  mount    按子包独立比对锁文件并防毒化探测，安全挂载共享依赖',
    '  unmount  全深度扫出指向外部的链接并逐个解绑（清场重挂默认档；删 worktree 请加 --strict）',
    '  scan     只报告 worktree 里的外链，不做任何修改',
    '  status   按子包与生态比对锁文件状态并输出差异',
  ].join('\n') + '\n')
}

function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }
  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: ['mount', 'unmount', 'scan', 'status'],
      valueFlags: ['main', 'worktree'],
      multiFlags: ['allow-outbound'],
      booleanFlags: ['strict'],
      usageHint: 'worktree-deps.mjs <mount|unmount|scan|status> --main <dir> --worktree <dir>',
    })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  if (cli.help) { printHelp(); return 0 }
  if (!cli.opts.main || !cli.opts.worktree) {
    process.stderr.write('错误：必须指定 --main <主仓目录> 与 --worktree <工作树目录>\n')
    return 2
  }

  try {
    let res
    if (cli.sub === 'status') res = compareLockfiles(cli.opts.main, cli.opts.worktree)
    else if (cli.sub === 'scan') res = scanOutboundLinks(cli.opts.worktree)
    else if (cli.sub === 'mount') res = mountSharedDeps(cli.opts.main, cli.opts.worktree)
    else if (cli.sub === 'unmount') {
      // 这个子命令的本职是「清场以便重挂依赖」，所以默认走 deps 档（worktree 不会消失）。
      // 要删 worktree 就必须显式加 --strict，让「跟随 junction 递归删除」这道闸生效。
      res = unmountSharedDeps(cli.opts.main, cli.opts.worktree, {
        allowOutbound: cli.opts['allow-outbound'],
        mode: cli.opts.strict ? 'cleanup' : 'deps',
      })
    } else throw new Error(`未知子命令：${cli.sub}`)

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      process.stdout.write(`worktree-deps (${cli.sub}): ${JSON.stringify(res)}\n`)
      if (cli.sub === 'unmount' && res.ok === false) {
        process.stderr.write(`BLOCKED_OUTBOUND_LINKS: worktree 里有 ${res.blocked.length} 条指向外部的链接未获准删除。`
          + '`git worktree remove --force` 会跟随 junction 递归删除，删了主仓那些目标就没了。\n')
        for (const one of res.blocked) {
          process.stderr.write(`  - ${one.path} -> ${one.resolved ?? one.target}（${one.reason}）\n`)
        }
        process.stderr.write('确认这些目标可以切断后，用 --allow-outbound <路径> 逐个列出再重跑；不存在「全部放行」开关。\n')
        return 4
      }
      printNextStep([
        cli.sub === 'unmount'
          ? '外链已解绑且主仓完好，可安全执行 git worktree remove。'
          : '可在 worktree 中直接运行项目命令；清理前务必先执行 unmount。',
      ], { repoRoot: cli.opts.main })
    }
    if (cli.sub === 'unmount' && res.ok === false) return 4
    return 0
  } catch (err) {
    process.stderr.write(`worktree-deps 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  void flushAndExit(main(process.argv.slice(2)))
}
