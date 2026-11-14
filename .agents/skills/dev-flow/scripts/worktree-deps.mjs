#!/usr/bin/env node
/**
 * worktree-deps.mjs —— Worktree 依赖共享挂载与安全解绑引擎。
 *
 * 规则：
 *   1. 比对主 worktree 与目标 worktree 根目录及一级子包目录的锁文件 SHA256；
 *   2. 锁文件一致时，Windows 使用 junction、POSIX 使用 dir symlink 秒挂 node_modules / .venv；
 *   3. 锁文件不一致时自动隔离（返回 mode: 'isolated', reason: 'lockfile-changed'）；
 *   4. 清理 worktree 前强制第一件事只对 junction/symlink 执行 fs.unlinkSync()，绝不 rm -rf 链接目标，
 *      并复核主仓依赖目录完好无损后才放行 git worktree remove。
 */

import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  isMainModule, PACKAGE_LOCKFILES, posixPath, printNextStep, samePath, sha256File, sha256Text,
} from '../../lib/shared.mjs'

const DEP_DIRS = Object.freeze(['node_modules', '.venv'])
const WORKSPACE_CONTAINERS = Object.freeze([
  'packages', 'apps', 'crates', 'services', 'libs', 'workspaces',
])
const SKIP_SUBDIRS = new Set([
  '.git', '.worktrees', 'node_modules', '.venv', 'venv',
  'dist', 'build', 'out', 'target', 'coverage', '.cache',
])

function lstatSafe(p) {
  try { return lstatSync(p) } catch { return null }
}

function statSafe(p) {
  try { return statSync(p) } catch { return null }
}

/** 收集根目录与一级子包目录（相对路径列表，根目录为 ''）。 */
function collectPackageDirs(root) {
  const rels = new Set([''])
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [''] }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (SKIP_SUBDIRS.has(entry.name) || entry.name.startsWith('.')) continue
    rels.add(entry.name)
    if (WORKSPACE_CONTAINERS.includes(entry.name)) {
      const containerAbs = join(root, entry.name)
      try {
        for (const sub of readdirSync(containerAbs, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.isSymbolicLink()) continue
          if (SKIP_SUBDIRS.has(sub.name) || sub.name.startsWith('.')) continue
          rels.add(`${entry.name}/${sub.name}`)
        }
      } catch { /* 忽略不可读容器目录 */ }
    }
  }
  return [...rels].sort()
}

/**
 * 计算锁文件哈希：对非二进制文本锁文件先归一 CRLF 为 LF 再算 SHA256，
 * 避免 Windows 下 core.autocrlf 检出 worktree 时误判锁文件变更。
 */
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

/** 比对主仓与目标 worktree 的全部锁文件 SHA256。 */
export function compareLockfiles(mainRoot, wtRoot) {
  const mainAbs = resolve(mainRoot)
  const wtAbs = resolve(wtRoot)
  const dirs = new Set([...collectPackageDirs(mainAbs), ...collectPackageDirs(wtAbs)])

  const mismatches = []
  const lockfiles = []

  for (const dirRel of [...dirs].sort()) {
    for (const lockName of PACKAGE_LOCKFILES) {
      const rel = dirRel ? `${dirRel}/${lockName}` : lockName
      const mainHash = hashLockfile(join(mainAbs, rel))
      const wtHash = hashLockfile(join(wtAbs, rel))
      if (mainHash === null && wtHash === null) continue
      lockfiles.push({ file: rel, mainHash, wtHash })
      if (mainHash !== wtHash) {
        mismatches.push({
          file: rel,
          mainHash,
          wtHash,
          reason: mainHash === null ? 'added-in-worktree'
            : wtHash === null ? 'removed-in-worktree' : 'hash-mismatch',
        })
      }
    }
  }

  const match = mismatches.length === 0
  return {
    match,
    reason: match ? 'lockfile-match' : 'lockfile-changed',
    checkedCount: lockfiles.length,
    mismatches,
    lockfiles,
  }
}

/** 在锁文件一致的前提下挂载主仓共享依赖目录到 worktree。 */
export function mountSharedDeps(mainRoot, wtRoot) {
  const mainAbs = resolve(mainRoot)
  const wtAbs = resolve(wtRoot)
  if (!existsSync(wtAbs)) {
    throw new Error(`目标 worktree 目录不存在：${wtAbs}`)
  }

  const cmp = compareLockfiles(mainAbs, wtAbs)
  if (!cmp.match) {
    return {
      ok: true,
      mode: 'isolated',
      reason: 'lockfile-changed',
      mismatches: cmp.mismatches,
      mounted: [],
      alreadyMounted: [],
      skipped: [],
    }
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const dirs = collectPackageDirs(mainAbs)
  const mounted = []
  const alreadyMounted = []
  const skipped = []

  for (const dirRel of dirs) {
    for (const depName of DEP_DIRS) {
      const rel = dirRel ? `${dirRel}/${depName}` : depName
      const src = join(mainAbs, rel)
      const srcStat = statSafe(src)
      if (!srcStat || !srcStat.isDirectory()) continue

      const srcReal = realpathSync.native(src)
      const dst = join(wtAbs, rel)
      const dstLstat = lstatSafe(dst)

      if (dstLstat) {
        if (dstLstat.isSymbolicLink()) {
          if (samePath(dst, srcReal)) {
            alreadyMounted.push({ path: posixPath(rel), target: srcReal })
          } else {
            skipped.push({ path: posixPath(rel), reason: 'existing-other-symlink' })
          }
        } else {
          skipped.push({ path: posixPath(rel), reason: 'existing-real-dir' })
        }
        continue
      }

      mkdirSync(dirname(dst), { recursive: true })
      symlinkSync(srcReal, dst, linkType)
      mounted.push({ path: posixPath(rel), target: srcReal, linkType })
    }
  }

  const hasShared = mounted.length > 0 || alreadyMounted.length > 0
  return {
    ok: true,
    mode: hasShared ? 'shared' : 'none',
    reason: hasShared ? 'lockfile-match' : 'no-main-deps',
    mismatches: [],
    mounted,
    alreadyMounted,
    skipped,
  }
}

/**
 * 在移除 worktree 前，强制第一件事只对 junction/symlink 执行 unlinkSync 解绑，
 * 绝不递归删除链接目标，并校验主仓依赖目录完好。
 */
export function unmountSharedDeps(mainRoot, wtRoot) {
  const mainAbs = resolve(mainRoot)
  const wtAbs = resolve(wtRoot)
  if (!existsSync(wtAbs)) {
    return { ok: true, unmounted: [], mainDepsIntact: true, note: 'worktree-absent' }
  }

  const dirs = new Set([...collectPackageDirs(mainAbs), ...collectPackageDirs(wtAbs)])
  const unmounted = []
  const mainExpected = []

  for (const dirRel of [...dirs].sort()) {
    for (const depName of DEP_DIRS) {
      const rel = dirRel ? `${dirRel}/${depName}` : depName
      const src = join(mainAbs, rel)
      const srcExists = existsSync(src)
      if (srcExists) mainExpected.push({ path: posixPath(rel), src })

      const dst = join(wtAbs, rel)
      const st = lstatSafe(dst)
      if (!st || !st.isSymbolicLink()) continue

      let targetBefore = null
      try { targetBefore = readlinkSync(dst) } catch { /* 忽略无法读取链接目标 */ }

      // 关键安全操作：只对符号链接/junction 本身调用 unlinkSync，绝不触碰目标目录内容
      unlinkSync(dst)

      if (lstatSafe(dst) !== null) {
        throw new Error(`解绑依赖链接失败，路径仍然存在：${dst}`)
      }
      unmounted.push({ path: posixPath(rel), target: targetBefore })
    }
  }

  // 校验主仓原有依赖目录仍然完好存在
  const missingMain = mainExpected.filter((item) => !existsSync(item.src))
  if (missingMain.length > 0) {
    throw new Error(`安全校验失败：主仓依赖目录异常缺失（${missingMain.map((m) => m.path).join(', ')}）`)
  }

  return {
    ok: true,
    unmounted,
    mainDepsIntact: true,
  }
}

function parseArgs(argv) {
  const sub = argv[0]
  const opts = {}
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1)
      else { opts[a.slice(2)] = argv[i + 1]; i += 1 }
    }
  }
  return { sub, opts }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/worktree-deps.mjs <mount|unmount|status> --main <主仓> --worktree <工作树> [--json]',
    '',
    '  mount    比对锁文件 SHA256 后秒挂共享依赖（不一致则跳过并隔离）',
    '  unmount  安全 unlinkSync 解绑 junction/symlink，并复核主仓依赖完好',
    '  status   仅比对锁文件状态并输出差异',
  ].join('\n') + '\n')
}

function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const { sub, opts } = parseArgs(argv)
  if (opts.help) { printHelp(); return 0 }
  if (!opts.main || !opts.worktree) {
    process.stderr.write('错误：必须指定 --main <主仓目录> 与 --worktree <工作树目录>\n')
    return 2
  }

  try {
    let res
    if (sub === 'status') res = compareLockfiles(opts.main, opts.worktree)
    else if (sub === 'mount') res = mountSharedDeps(opts.main, opts.worktree)
    else if (sub === 'unmount') res = unmountSharedDeps(opts.main, opts.worktree)
    else throw new Error(`未知子命令：${sub}`)

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      process.stdout.write(`worktree-deps (${sub}): ${JSON.stringify(res)}\n`)
      printNextStep([
        sub === 'unmount'
          ? '主仓依赖完好且已解绑，可安全执行 git worktree remove。'
          : '可在 worktree 中直接运行项目命令；清理前务必先执行 unmount。',
      ])
    }
    return 0
  } catch (err) {
    process.stderr.write(`worktree-deps 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const code = main(process.argv.slice(2))
  process.exit(code)
}
