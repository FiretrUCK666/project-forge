#!/usr/bin/env node
/**
 * worktree-deps.mjs —— 三类分层（Class R/S/I）Worktree 并发依赖挂载、漂移自愈与安全解绑引擎。
 *
 * 规则：
 *   1. Class R（pnpm/bun/uv/Go/Rust/JVM/.NET/Dart/Swift）走原生全局并发仓隔离，永不软链主仓目录；
 *   2. Class S（npm/yarn/pip/PHP/Ruby/CocoaPods/Elixir 及 worktree-shared-readonly）按锁+清单指纹
 *      落仓外只读 dep-pool，毒化或指纹变更即自动隔离/脱钩；
 *   3. Class I（构建产物与 DB/NoSQL 卷）严格隔离，绝不共享；
 *   4. 清理前全深度扫描 worktree 外链，放行 dep-pool/主仓托管挂载为 tool-mounted，其余未获准外链硬阻断。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { canonicalPath, isInsideDir, isMainModule, posixPath, readJsonSafe, samePath, sha256Text } from '../../lib/git.mjs'
import { isPathInGitIndexFast } from '../../lib/git-fast.mjs'
import { listTaskLedgers, readTaskLedger, recordMountedDepsInLedger, sanitizeTaskId, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  buildWorktreeMountHints,
  CLASS_S_EXTRA_SPECS,
  collectCandidatePackageDirs,
  compareUnitLocks,
  computeUnitDepFingerprint,
  detectGlobalStoreClassRUnits,
  detectNodeWorkspacePoisoning,
  detectPythonEditablePoisoning,
  detectUnitDepClass,
  detachWorktreeUnit,
  ensureDepPoolEntry,
  ensureMountedDepsExcluded,
  gcUnusedDepPools,
  listCustomSharedReadonlyDirs,
  lstatSafe,
  NODE_LOCKFILES,
  PY_LOCKFILES,
  PYTHON_DEP_DIRS,
  reconcileWorktreeDeps,
  resolveDepPoolRoot,
  statSafe,
  unlinkLinkSafe,
  unregisterWorktreeFromPoolRefs,
} from '../../lib/worktree-dep-pool.mjs'

export { buildWorktreeMountHints, detachWorktreeUnit, gcUnusedDepPools, reconcileWorktreeDeps }

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
      units.push({ dirRel, ecosystem: 'node', depDirs: ['node_modules'], lockNames: NODE_LOCKFILES, ...nodeCmp })
      lockfiles.push(...nodeCmp.lockfiles)
      mismatches.push(...nodeCmp.mismatches)
    }

    const pyCmp = compareUnitLocks(mainAbs, wtAbs, dirRel, PY_LOCKFILES)
    if (pyCmp.lockfiles.length > 0 || PYTHON_DEP_DIRS.some((d) => existsSync(join(mainAbs, dirRel, d)))) {
      units.push({ dirRel, ecosystem: 'python', depDirs: [...PYTHON_DEP_DIRS], lockNames: PY_LOCKFILES, ...pyCmp })
      lockfiles.push(...pyCmp.lockfiles)
      mismatches.push(...pyCmp.mismatches)
    }

    for (const spec of CLASS_S_EXTRA_SPECS) {
      const exCmp = compareUnitLocks(mainAbs, wtAbs, dirRel, spec.lockfiles)
      const hasManifest = spec.manifests.some((m) => existsSync(join(mainAbs, dirRel, m)))
      if (exCmp.lockfiles.length > 0 || (hasManifest && spec.depDirs.some((d) => existsSync(join(mainAbs, dirRel, d))))) {
        units.push({ dirRel, ecosystem: spec.ecosystem, depDirs: spec.depDirs, lockNames: spec.lockfiles, ...exCmp })
        lockfiles.push(...exCmp.lockfiles)
        mismatches.push(...exCmp.mismatches)
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
    units,
  }
}

function assertTrustedWorktreeForMount(mainAbs, wtAbs, opts) {
  if (opts.allowUntrusted) return
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

/** 按三类策略分层挂载依赖：Class R 走全局仓提示，Class S 落仓外只读 dep-pool，Class I 严格隔离。 */
export function mountSharedDeps(mainRoot, wtRoot, opts = {}) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (!existsSync(wtAbs)) throw new Error(`目标 worktree 目录不存在：${wtAbs}`)
  if (samePath(mainAbs, wtAbs)) throw new Error(`拒绝自挂载：mainRoot 与 worktree 指向同一目录 (${mainAbs})`)
  assertTrustedWorktreeForMount(mainAbs, wtAbs, opts)

  const cmp = compareLockfiles(mainAbs, wtAbs)
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const mounted = []
  const alreadyMounted = []
  const isolatedUnits = []
  const classRUnits = [...detectGlobalStoreClassRUnits(mainAbs, wtAbs)]
  const skipped = []
  const createdThisRun = []

  const mountOneClassSDir = ({ rel, eco, dirRel, fingerprint, srcReal }) => {
    const dst = join(wtAbs, rel)
    const pool = ensureDepPoolEntry({ mainAbs, wtAbs, rel, eco, dirRel, fingerprint, srcReal })
    const dstLstat = lstatSafe(dst)
    if (dstLstat) {
      if (dstLstat.isSymbolicLink() && (samePath(dst, pool.poolDir) || samePath(dst, srcReal))) {
        alreadyMounted.push({ path: posixPath(rel), target: pool.poolDir, poolKey: pool.poolKey })
      } else {
        skipped.push({ path: posixPath(rel), reason: dstLstat.isSymbolicLink() ? 'existing-other-symlink' : 'existing-real-dir' })
      }
      return
    }
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(pool.poolDir, dst, linkType)
    createdThisRun.push({ dst, poolKey: pool.poolKey })
    mounted.push({ path: posixPath(rel), target: pool.poolDir, poolKey: pool.poolKey, linkType })
  }

  try {
    for (const unit of cmp.units) {
      if (unit.dirRel && !existsSync(join(wtAbs, unit.dirRel))) {
        skipped.push({ path: unit.dirRel, reason: 'package-absent-in-worktree' })
        continue
      }
      const cls = detectUnitDepClass(mainAbs, unit.dirRel, unit.ecosystem, unit.lockfiles)
      if (cls.depClass === 'R') {
        classRUnits.push({ dirRel: unit.dirRel || '.', ecosystem: unit.ecosystem, depClass: 'R', manager: cls.manager, offlineCmd: cls.offlineCmd })
        continue
      }
      if (!unit.match) {
        isolatedUnits.push({ dirRel: unit.dirRel || '.', ecosystem: unit.ecosystem, reason: 'lockfile-changed', mismatches: unit.mismatches })
        continue
      }
      const mainFp = computeUnitDepFingerprint(mainAbs, unit.dirRel, unit.ecosystem, unit.lockNames)
      const wtFp = computeUnitDepFingerprint(wtAbs, unit.dirRel, unit.ecosystem, unit.lockNames)
      if (mainFp !== wtFp) {
        isolatedUnits.push({ dirRel: unit.dirRel || '.', ecosystem: unit.ecosystem, reason: 'manifest-deps-changed' })
        continue
      }
      for (const depName of unit.depDirs) {
        const rel = unit.dirRel ? `${unit.dirRel}/${depName}` : depName
        const src = join(mainAbs, rel)
        const srcStat = statSafe(src)
        if (!srcStat || !srcStat.isDirectory()) continue
        const srcReal = canonicalPath(src)
        const poisonReason = unit.ecosystem === 'node'
          ? detectNodeWorkspacePoisoning(mainAbs, srcReal)
          : (unit.ecosystem === 'python' ? detectPythonEditablePoisoning(mainAbs, srcReal) : null)
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
        mountOneClassSDir({ rel, eco: unit.ecosystem, dirRel: unit.dirRel, fingerprint: wtFp, srcReal })
      }
    }

    const custom = listCustomSharedReadonlyDirs(mainAbs)
    for (const rej of custom.rejected) {
      isolatedUnits.push({ dirRel: '.', ecosystem: 'custom', path: rej.path, reason: rej.reason })
    }
    for (const customRel of custom.accepted) {
      const src = join(mainAbs, customRel)
      if (!statSafe(src)?.isDirectory()) continue
      const fp = sha256Text(`custom:${customRel}:${statSafe(src).mtimeMs}`)
      mountOneClassSDir({ rel: customRel, eco: 'custom', dirRel: '', fingerprint: fp, srcReal: canonicalPath(src) })
    }
  } catch (err) {
    for (const item of createdThisRun.reverse()) {
      try { unlinkLinkSafe(item.dst) } catch { /* ignore */ }
      try { unregisterWorktreeFromPoolRefs(mainAbs, wtAbs, [item.poolKey]) } catch { /* ignore */ }
    }
    throw err
  }

  const mountedRelPaths = [...mounted, ...alreadyMounted].map((item) => item.path)
  if (mountedRelPaths.length > 0) ensureMountedDepsExcluded(mainAbs, mountedRelPaths)

  const hasShared = mounted.length > 0 || alreadyMounted.length > 0
  let mode = 'none'
  let reason = 'no-main-deps'
  if (hasShared) {
    mode = (isolatedUnits.length > 0 || classRUnits.length > 0) ? 'partial' : 'shared'
    reason = mode === 'partial' ? 'partial-isolated' : 'lockfile-match'
  } else if (classRUnits.length > 0) {
    mode = 'class-r-global-store'
    reason = 'class-r-global-store'
  } else if (isolatedUnits.length > 0) {
    mode = 'isolated'
    reason = isolatedUnits[0].reason
  }

  const mountHints = buildWorktreeMountHints(mainAbs, wtAbs, cmp.units, [...mounted, ...alreadyMounted], classRUnits)
  return {
    ok: true,
    mode,
    reason,
    mismatches: cmp.mismatches,
    mounted,
    alreadyMounted,
    mountedPaths: mountedRelPaths,
    classRUnits,
    isolatedUnits,
    skipped,
    envHints: mountHints.envHints,
    hints: mountHints.hints,
  }
}

const MAX_SCAN_DEPTH = 24

function normalizeLinkRel(p) {
  const norm = posixPath(String(p ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
  return norm && norm !== '.' ? norm : ''
}

export function scanOutboundLinks(wtRoot) {
  const wtAbs = canonicalPath(wtRoot)
  const outbound = []
  const internal = []
  const broken = []
  const truncatedPaths = []
  let truncated = false
  if (!existsSync(wtAbs)) return { outbound, internal, broken, truncated, truncatedPaths }

  const walk = (absDir, relDir, depth) => {
    if (depth > MAX_SCAN_DEPTH) {
      truncated = true
      truncatedPaths.push(posixPath(relDir || '.'))
      return
    }
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = join(absDir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (rel === '.git') continue
      const st = lstatSafe(abs)
      if (!st) continue
      if (st.isSymbolicLink()) {
        let target = null
        try { target = readlinkSync(abs) } catch { /* ignore */ }
        let resolved = null
        try { resolved = realpathSync.native(abs) } catch { /* ignore */ }
        if (resolved === null) {
          broken.push({ path: posixPath(rel), target })
          outbound.push({ path: posixPath(rel), target, kind: 'unresolved', resolved: null })
          continue
        }
        if (isInsideDir(resolved, wtAbs)) internal.push({ path: posixPath(rel), target })
        else outbound.push({ path: posixPath(rel), target, kind: 'outside', resolved: posixPath(resolved) })
        continue
      }
      if (entry.isDirectory()) walk(abs, rel, depth + 1)
    }
  }

  walk(wtAbs, '', 0)
  return { outbound, internal, broken, truncated, truncatedPaths }
}

function isLinkTrackedInGit(wtAbs, rel) {
  const fastTracked = isPathInGitIndexFast(wtAbs, rel)
  if (fastTracked !== null) return fastTracked
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: wtAbs, stdio: 'ignore', windowsHide: true }).status === 0
}

export function unmountSharedDeps(mainRoot, wtRoot, opts = {}) {
  let effMain = mainRoot
  let effWt = wtRoot
  let effOpts = opts
  if (wtRoot && typeof wtRoot === 'object') {
    effOpts = { mode: 'deps', mountedPaths: wtRoot.deps ?? wtRoot.mountedPaths ?? [], ...wtRoot }
    effWt = mainRoot
    effMain = wtRoot.mainRoot ?? mainRoot
  }
  const { allowOutbound = [], mode = 'cleanup', mountedPaths = [], dryRun = false } = effOpts ?? {}
  const mainAbs = canonicalPath(effMain)
  const wtAbs = canonicalPath(effWt)
  if (samePath(mainAbs, wtAbs)) throw new Error(`拒绝自解绑：mainRoot 与 worktree 指向同一目录 (${mainAbs})`)
  if (!existsSync(wtAbs)) {
    return { ok: true, unmounted: [], unmountedInternal: [], skipped: [], blocked: [], truncated: false, scanned: { outbound: 0, internal: 0, broken: 0 }, note: 'worktree-absent' }
  }

  const depPoolRoot = resolveDepPoolRoot(mainAbs)
  const allowed = new Set((allowOutbound ?? []).map(normalizeLinkRel).filter(Boolean))
  const mountedSet = new Set((mountedPaths ?? []).map((p) => normalizeLinkRel(typeof p === 'string' ? p : p?.path)).filter(Boolean))
  const strict = mode !== 'deps'

  if (!strict && mountedSet.size > 0) {
    const unmounted = []
    const skipped = []
    const verifiedTargets = []
    for (const rel of mountedSet) {
      const abs = join(wtAbs, rel)
      const st = lstatSafe(abs)
      if (!st || !st.isSymbolicLink()) continue
      if (isLinkTrackedInGit(wtAbs, rel)) { skipped.push({ path: rel, reason: 'tracked-in-git' }); continue }
      let targetBefore = null
      let resolvedBefore = null
      try { targetBefore = readlinkSync(abs) } catch { /* ignore */ }
      try { resolvedBefore = realpathSync.native(abs) } catch { /* ignore */ }
      if (!dryRun) {
        unlinkLinkSafe(abs)
        if (lstatSafe(abs) !== null) throw new Error(`解绑链接失败，路径仍然存在：${abs}`)
        if (resolvedBefore) verifiedTargets.push({ path: rel, resolved: posixPath(resolvedBefore) })
        unmounted.push({ path: rel, target: targetBefore ?? resolvedBefore, source: 'tool-mounted', label: '工具挂载，自动解绑' })
      }
    }
    const missingTargets = verifiedTargets.filter((item) => !existsSync(item.resolved))
    if (missingTargets.length > 0) {
      throw new Error(`安全校验失败：解绑之后外部目标不见了（${missingTargets.map((m) => `${m.path} -> ${m.resolved}`).join(', ')}）`)
    }
    if (!dryRun && unmounted.length > 0) unregisterWorktreeFromPoolRefs(mainAbs, wtAbs)
    return { ok: true, unmounted, unmountedInternal: [], skipped, blocked: [], truncated: false, fastGuided: true, scanned: { outbound: unmounted.length + skipped.length, internal: 0, broken: 0 } }
  }

  const scan = scanOutboundLinks(wtAbs)
  const unmounted = []
  const unmountedInternal = []
  const skipped = []
  const blocked = []
  const outboundPlan = []
  const before = scan.outbound.map((item) => ({ path: item.path, resolved: item.resolved }))

  if (strict && scan.truncated) {
    for (const tp of (scan.truncatedPaths.length > 0 ? scan.truncatedPaths : ['.'])) {
      blocked.push({ path: tp, target: null, reason: 'scan-truncated', resolved: null })
    }
  }

  for (const link of scan.outbound) {
    if (link.kind === 'unresolved') {
      if (strict) { blocked.push({ path: link.path, target: link.target, reason: 'unresolved-target' }); continue }
      outboundPlan.push({ link, source: 'deps-mode' })
      continue
    }
    const inTrustedRoot = Boolean(link.resolved) && (isInsideDir(link.resolved, mainAbs) || isInsideDir(link.resolved, depPoolRoot))
    const isToolMounted = mountedSet.has(link.path) && inTrustedRoot
    const isAllowed = allowed.has(link.path)
    if (strict && !isToolMounted && !isAllowed) {
      blocked.push({ path: link.path, target: link.target, reason: 'points-outside-worktree', resolved: link.resolved })
      continue
    }
    outboundPlan.push({ link, source: isToolMounted ? 'tool-mounted' : (isAllowed ? 'allow-outbound' : 'deps-mode') })
  }

  if ((strict && blocked.length > 0) || dryRun) {
    return { ok: blocked.length === 0, unmounted, unmountedInternal, skipped, blocked, truncated: Boolean(scan.truncated), scanned: { outbound: scan.outbound.length, internal: scan.internal.length, broken: scan.broken.length } }
  }

  for (const { link, source } of outboundPlan) {
    const abs = join(wtAbs, link.path)
    if (isLinkTrackedInGit(wtAbs, link.path)) {
      if (!strict) {
        skipped.push({ path: link.path, reason: 'tracked-in-git' })
        continue
      }
      if (strict) {
        skipped.push({ path: link.path, reason: 'tracked-in-git-but-unlinked' })
      }
    }
    let targetBefore = null
    try { targetBefore = readlinkSync(abs) } catch { /* ignore */ }
    unlinkLinkSafe(abs)
    if (lstatSafe(abs) !== null) throw new Error(`解绑链接失败，路径仍然存在：${abs}`)
    unmounted.push({ path: link.path, target: targetBefore ?? link.resolved ?? link.target, source, ...(source === 'tool-mounted' ? { label: '工具挂载，自动解绑' } : {}) })
  }

  if (strict) {
    for (const link of scan.internal) {
      const abs = join(wtAbs, link.path)
      if (!lstatSafe(abs)?.isSymbolicLink()) continue
      if (isLinkTrackedInGit(wtAbs, link.path)) skipped.push({ path: link.path, reason: 'tracked-internal-in-git-but-unlinked' })
      let targetBefore = null
      try { targetBefore = readlinkSync(abs) } catch { /* ignore */ }
      unlinkLinkSafe(abs)
      if (lstatSafe(abs) !== null) throw new Error(`解绑内部链接失败，路径仍然存在：${abs}`)
      unmountedInternal.push({ path: link.path, target: targetBefore ?? link.target })
    }
  }

  const missingTargets = before.filter((item) => item.resolved).filter((item) => !existsSync(item.resolved))
  if (missingTargets.length > 0) {
    throw new Error(`安全校验失败：解绑之后外部目标不见了（${missingTargets.map((m) => `${m.path} -> ${m.resolved}`).join(', ')}）——解绑只该删链接，不该碰目标内容`)
  }
  if (unmounted.length > 0) unregisterWorktreeFromPoolRefs(mainAbs, wtAbs)
  return { ok: blocked.length === 0, unmounted, unmountedInternal, skipped, blocked, truncated: Boolean(scan.truncated), scanned: { outbound: scan.outbound.length, internal: scan.internal.length, broken: scan.broken.length } }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/worktree-deps.mjs <mount|unmount|scan|status|detach|reconcile> --main <主仓> --worktree <工作树> [选项]',
    '',
    '  mount      按 Class R/S/I 三类策略安全挂载依赖（Class S 落仓外只读 dep-pool）',
    '  unmount    全深度扫出外链并逐个解绑（清场重挂默认档；删 worktree 请加 --strict）',
    '  scan       只报告 worktree 里的外链，不做任何修改',
    '  status     按子包与生态比对锁文件状态并输出差异',
    '  detach     原子脱钩指定子包或依赖单元链接（配合 --unit）',
    '  reconcile  核对锁文件与清单依赖段指纹，自动脱钩漂移依赖链接',
    '',
    '选项：',
    '  --main <path>             主仓库根目录',
    '  --worktree <path>         目标 worktree 目录',
    '  --task <id>               关联任务 ID（同步写回账本 mountedDepsByWorktree）',
    '  --unit <dir>              待脱钩的子包或依赖相对路径（detach 专用）',
    '  --allow-outbound <path>   显式放行待解绑外链（可重复）',
    '  --strict                  删 worktree 前的严格外链校验档',
    '  --json                    输出结构化 JSON',
  ].join('\n') + '\n')
}

function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }
  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: ['mount', 'unmount', 'scan', 'status', 'detach', 'reconcile'],
      valueFlags: ['main', 'worktree', 'task', 'unit'],
      multiFlags: ['allow-outbound'],
      booleanFlags: ['strict'],
      usageHint: 'worktree-deps.mjs <mount|unmount|scan|status|detach|reconcile> --main <dir> --worktree <dir>',
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
    else if (cli.sub === 'detach') res = detachWorktreeUnit(cli.opts.main, cli.opts.worktree, { unit: cli.opts.unit })
    else if (cli.sub === 'reconcile') res = reconcileWorktreeDeps(cli.opts.main, cli.opts.worktree)
    else if (cli.sub === 'mount') {
      res = mountSharedDeps(cli.opts.main, cli.opts.worktree)
      if (res.envHints) for (const [k, v] of Object.entries(res.envHints)) process.env[k] = String(v)
      const mainAbs = canonicalPath(cli.opts.main)
      const wtRel = posixPath(relative(mainAbs, canonicalPath(cli.opts.worktree)))
      const matchedLedger = cli.opts.task
        ? readTaskLedger(mainAbs, sanitizeTaskId(cli.opts.task))
        : listTaskLedgers(mainAbs).find((l) => (l.worktreePath && posixPath(l.worktreePath) === wtRel) || (l.reviewWorktreePath && posixPath(l.reviewWorktreePath) === wtRel))
      if (matchedLedger?.taskId) {
        matchedLedger.depsMode = res.mode
        recordMountedDepsInLedger(matchedLedger, wtRel, res)
        writeTaskLedger(mainAbs, matchedLedger)
        res.ledgerUpdated = true
        res.taskId = matchedLedger.taskId
        res.mountedDepsByWorktree = matchedLedger.mountedDepsByWorktree
      }
    } else if (cli.sub === 'unmount') {
      res = unmountSharedDeps(cli.opts.main, cli.opts.worktree, { allowOutbound: cli.opts['allow-outbound'], mode: cli.opts.strict ? 'cleanup' : 'deps' })
    } else throw new Error(`未知子命令：${cli.sub}`)

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      process.stdout.write(`worktree-deps (${cli.sub}): ${JSON.stringify(res)}\n`)
      for (const h of res.hints ?? []) process.stdout.write(`[HINT] ${h}\n`)
      if (cli.sub === 'unmount' && res.ok === false) {
        process.stderr.write(`BLOCKED_OUTBOUND_LINKS: worktree 里有 ${res.blocked.length} 条指向外部的链接未获准删除。\n`)
        for (const one of res.blocked) process.stderr.write(`  - ${one.path} -> ${one.resolved ?? one.target}（${one.reason}）\n`)
        return 4
      }
      printNextStep([cli.sub === 'unmount' ? '外链已解绑且主仓完好，可安全执行 git worktree remove。' : '可在 worktree 中直接运行项目命令；清理前务必先执行 unmount。'], { repoRoot: cli.opts.main })
    }
    return (cli.sub === 'unmount' && res.ok === false) ? 4 : 0
  } catch (err) {
    process.stderr.write(`worktree-deps 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  void flushAndExit(main(process.argv.slice(2)))
}
