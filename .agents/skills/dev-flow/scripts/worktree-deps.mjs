#!/usr/bin/env node
/**
 * worktree-deps.mjs —— Workspace 感知的 Worktree 共享依赖挂载与安全解绑引擎。
 *
 * 规则：
 *   1. 按子包/生态独立比对锁文件 SHA256（单个子包变更只隔离该子包，不连坐其余子包）；
 *   2. 探测到 npm/pnpm/yarn Workspace 本地软链或 Python editable `.venv` 指回主仓源码时自动局部隔离防毒化；
 *   3. `samePath(main, wt)` 严禁自挂载/自解绑，半途失败原子回滚已建链接；
 *   4. 清理前强制第一件事只对 junction/symlink 执行 `unlinkSync` 并校验主仓依赖完好。
 */

import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { canonicalPath, isMainModule, posixPath, readJsonSafe, readTextSafe, samePath, sha256File, sha256Text } from '../../lib/git.mjs'
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

/** 按子包独立比对锁文件并防毒化探测，安全挂载可共享依赖（半途失败原子回滚）。 */
export function mountSharedDeps(mainRoot, wtRoot) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (!existsSync(wtAbs)) throw new Error(`目标 worktree 目录不存在：${wtAbs}`)
  if (samePath(mainAbs, wtAbs)) throw new Error(`拒绝自挂载：mainRoot 与 worktree 指向同一目录 (${mainAbs})`)

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

/** 清理 worktree 前先仅对 junction/symlink 调用 `unlinkSync` 解绑，并校验主仓依赖完好。 */
export function unmountSharedDeps(mainRoot, wtRoot) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (samePath(mainAbs, wtAbs)) throw new Error(`拒绝自解绑：mainRoot 与 worktree 指向同一目录 (${mainAbs})`)
  if (!existsSync(wtAbs)) return { ok: true, unmounted: [], mainDepsIntact: true, note: 'worktree-absent' }

  const dirs = new Set([...collectCandidatePackageDirs(mainAbs), ...collectCandidatePackageDirs(wtAbs)])
  const unmounted = []
  const mainExpected = []

  for (const dirRel of [...dirs].sort()) {
    for (const depName of ['node_modules', ...PYTHON_DEP_DIRS]) {
      const rel = dirRel ? `${dirRel}/${depName}` : depName
      const src = join(mainAbs, rel)
      if (existsSync(src)) mainExpected.push({ path: posixPath(rel), src })

      const dst = join(wtAbs, rel)
      const st = lstatSafe(dst)
      if (!st || !st.isSymbolicLink()) continue

      let targetBefore = null
      try { targetBefore = readlinkSync(dst) } catch { /* ignore */ }
      unlinkSync(dst)
      if (lstatSafe(dst) !== null) throw new Error(`解绑依赖链接失败，路径仍然存在：${dst}`)
      unmounted.push({ path: posixPath(rel), target: targetBefore })
    }
  }

  const missingMain = mainExpected.filter((item) => !existsSync(item.src))
  if (missingMain.length > 0) {
    throw new Error(`安全校验失败：主仓依赖目录异常缺失（${missingMain.map((m) => m.path).join(', ')}）`)
  }
  return { ok: true, unmounted, mainDepsIntact: true }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/worktree-deps.mjs <mount|unmount|status> --main <主仓> --worktree <工作树> [--json]',
    '',
    '  mount    按子包独立比对锁文件并防毒化探测，安全挂载共享依赖',
    '  unmount  安全 unlinkSync 解绑 junction/symlink，并复核主仓依赖完好',
    '  status   按子包与生态比对锁文件状态并输出差异',
  ].join('\n') + '\n')
}

function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }
  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: ['mount', 'unmount', 'status'],
      valueFlags: ['main', 'worktree'],
      usageHint: 'worktree-deps.mjs <mount|unmount|status> --main <dir> --worktree <dir>',
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
    else if (cli.sub === 'mount') res = mountSharedDeps(cli.opts.main, cli.opts.worktree)
    else if (cli.sub === 'unmount') res = unmountSharedDeps(cli.opts.main, cli.opts.worktree)
    else throw new Error(`未知子命令：${cli.sub}`)

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      process.stdout.write(`worktree-deps (${cli.sub}): ${JSON.stringify(res)}\n`)
      printNextStep([
        cli.sub === 'unmount'
          ? '主仓依赖完好且已解绑，可安全执行 git worktree remove。'
          : '可在 worktree 中直接运行项目命令；清理前务必先执行 unmount。',
      ], { repoRoot: cli.opts.main })
    }
    return 0
  } catch (err) {
    process.stderr.write(`worktree-deps 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main(process.argv.slice(2)))
}
