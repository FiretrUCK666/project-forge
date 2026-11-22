/**
 * govern-checks-hygiene.mjs —— 从 `govern-checks.mjs` 拆出的工作树四态巡检、清单校验与未忽略输出目录检测。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  FEATURE_MAP_REL, detectScratchSolidificationHints, evaluateToolStaleness,
  readFeatureMap, readFeatureMapRaw, readFeatureMapStatus, validateFeatureMap,
} from '../../lib/feature-map.mjs'
import {
  COMMON_OUTPUT_DIRS, canonicalPath, gitRun, gitRunBuffer, inspectBranchMergeState,
  isInsideDir, isMacOsJunkPath, parseWorktreeListPorcelain, posixPath, readJsonSafe,
  readTextSafe, samePath, sha256Text,
} from '../../lib/git.mjs'
import { isCleanWorktreeFast, readWorktreeListFast } from '../../lib/git-status-fast.mjs'
import { isAllowedExtensionPath } from '../../lib/overlay.mjs'

const OUTPUT_DIRS = [...COMMON_OUTPUT_DIRS, '.worktrees']

export async function inspectWorktrees(mainRoot, isGit, defaultBranch) {
  const stale = []
  const worktreeEntries = []
  const counts = { merged: 0, squash_or_rebase_merged: 0, no_own_commits: 0, unmerged: 0, prunable: 0, orphan_dir: 0 }
  if (!isGit) return { total: 0, counts, entries: worktreeEntries, stale }

  const fastWtList = readWorktreeListFast(mainRoot)
  let rawEntries = fastWtList
  if (!rawEntries) {
    const listRes = await gitRun(mainRoot, ['worktree', 'list', '--porcelain'])
    rawEntries = listRes.ok && listRes.stdout ? parseWorktreeListPorcelain(listRes.stdout) : []
  }
  const mainCanon = canonicalPath(mainRoot)
  const registeredPaths = []

  const dotWorktreeEntries = rawEntries.filter((e) => {
    registeredPaths.push(e.path)
    if (samePath(e.path, mainCanon)) return false
    const rel = posixPath(relative(mainCanon, e.path))
    return rel.startsWith('.worktrees/')
  })
  const registeredInDotWorktrees = dotWorktreeEntries.length

  const mergeCache = { firstParentPromises: new Map(), patchIdPromises: new Map() }
  const inspected = new Array(dotWorktreeEntries.length)
  let wtCursor = 0
  const inspectOneWt = async () => {
    while (wtCursor < dotWorktreeEntries.length) {
      const idx = wtCursor
      wtCursor += 1
      const e = dotWorktreeEntries[idx]
      const rel = posixPath(relative(mainCanon, e.path))
      if (e.prunable) {
        inspected[idx] = {
          stateKey: 'prunable',
          item: { path: rel, branch: e.branch, headSha: e.head, state: 'prunable', dirty: false, reason: `prunable (${e.prunable})` },
          isStale: true,
        }
        continue
      }
      const fastCleanWt = existsSync(e.path) ? isCleanWorktreeFast(e.path) : null
      const [stRes, mergeInfo] = await Promise.all([
        fastCleanWt?.clean
          ? Promise.resolve({ ok: true, stdout: '' })
          : (existsSync(e.path) ? gitRun(e.path, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']) : Promise.resolve({ ok: false, stdout: '' })),
        inspectBranchMergeState(mainRoot, {
          branch: e.branch,
          headSha: e.head,
          defaultBranch: defaultBranch || 'main',
          cache: mergeCache,
        }),
      ])
      const dirty = Boolean(stRes.ok && stRes.stdout.trim())
      const st = mergeInfo.state
      const item = {
        path: rel,
        branch: e.branch,
        headSha: e.head,
        state: st,
        dirty,
        ownCommits: mergeInfo.ownCommits,
        isShallow: mergeInfo.isShallow,
        reason: st === 'no_own_commits'
          ? `no_own_commits: no unique commits ahead of ${defaultBranch || 'main'} (dirty=${dirty}; ask human before cleaning)`
          : `${st}: ${mergeInfo.reason}`,
      }
      inspected[idx] = { stateKey: st, item, isStale: st !== 'unmerged' }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, dotWorktreeEntries.length) }, inspectOneWt))

  for (const res of inspected) {
    counts[res.stateKey] = (counts[res.stateKey] ?? 0) + 1
    worktreeEntries.push(res.item)
    if (res.isStale) stale.push(res.item)
  }

  const wtContainer = join(mainRoot, '.worktrees')
  if (existsSync(wtContainer)) {
    try {
      for (const d of readdirSync(wtContainer, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '.state' || isMacOsJunkPath(d.name)) continue
        const abs = canonicalPath(join(wtContainer, d.name))
        if (!registeredPaths.some((rp) => samePath(rp, abs))) {
          counts.orphan_dir += 1
          const item = { path: `.worktrees/${d.name}`, branch: undefined, state: 'orphan_dir', dirty: false, reason: 'unregistered orphan directory inside .worktrees/' }
          worktreeEntries.push(item)
          stale.push(item)
        }
      }
    } catch { /* ignore */ }
  }

  return { total: registeredInDotWorktrees, counts, entries: worktreeEntries, stale }
}

export function inspectManifest(repoRoot) {
  const skillsDir = join(repoRoot, '.agents', 'skills')
  const manifestPath = join(skillsDir, '.pf-manifest.json')
  if (!existsSync(skillsDir) && !existsSync(manifestPath)) {
    return { present: false, status: 'not-equipped', issues: [], customizedCount: 0 }
  }
  if (existsSync(skillsDir) && !existsSync(manifestPath)) {
    return {
      present: true,
      status: 'missing-manifest',
      issues: [{ file: '.agents/skills/.pf-manifest.json', kind: 'missing', detail: '.agents/skills/ exists without .pf-manifest.json' }],
      customizedCount: 0,
    }
  }

  const manifest = readJsonSafe(manifestPath)
  if (!manifest || typeof manifest !== 'object' || typeof manifest.files !== 'object' || manifest.files === null) {
    return {
      present: true,
      status: 'corrupt-manifest',
      issues: [{ file: '.agents/skills/.pf-manifest.json', kind: 'corrupt', detail: 'Invalid JSON or missing files map' }],
      customizedCount: 0,
    }
  }

  const disabledSet = new Set(Array.isArray(manifest.disabledSkills) ? manifest.disabledSkills.map(String) : [])
  const removedMap = manifest.removedFiles && typeof manifest.removedFiles === 'object' && !Array.isArray(manifest.removedFiles)
    ? manifest.removedFiles
    : {}
  const customizedMap = manifest.customizedFiles && typeof manifest.customizedFiles === 'object' && !Array.isArray(manifest.customizedFiles)
    ? manifest.customizedFiles
    : {}
  const pendingConflicts = manifest.pendingConflicts && typeof manifest.pendingConflicts === 'object' && !Array.isArray(manifest.pendingConflicts)
    ? manifest.pendingConflicts
    : {}
  const issues = []
  let checked = 0
  let customizedCount = 0

  const hashDiskFile = (abs) => {
    const buf = readFileSync(abs)
    const textNormHash = !buf.subarray(0, 4096).includes(0)
      ? sha256Text(buf.toString('utf8').replace(/\r\n/g, '\n'))
      : null
    const rawHash = sha256Text(buf.toString('utf8'))
    return { textNormHash, rawHash }
  }

  for (const [relKey, meta] of Object.entries(manifest.files)) {
    const norm = posixPath(relKey).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    if (!norm || isAllowedExtensionPath(norm) || isAllowedExtensionPath(`.agents/${norm}`)) continue
    const topSkill = norm.split('/')[0]
    if (disabledSet.has(topSkill) || Object.prototype.hasOwnProperty.call(removedMap, norm)) continue
    checked += 1

    const abs = norm.startsWith('.agents/skills/') ? join(repoRoot, norm) : join(skillsDir, norm)
    if (!existsSync(abs)) {
      issues.push({ file: norm, kind: 'missing-managed', detail: 'Managed skill file listed in manifest is missing on disk' })
      continue
    }

    const customEntry = customizedMap[norm]
    if (customEntry && typeof customEntry === 'object') {
      try {
        const { textNormHash, rawHash } = hashDiskFile(abs)
        const baseSha = typeof customEntry.baseSha256 === 'string' ? customEntry.baseSha256 : null
        if (!baseSha || textNormHash === baseSha || rawHash === baseSha) {
          customizedCount += 1
        } else {
          issues.push({ file: norm, kind: 're-edited-custom', detail: 'Customized file changed after --adopt-custom baseline; re-adopt or merge' })
        }
      } catch {
        issues.push({ file: norm, kind: 'unreadable', detail: 'Unable to hash customized file' })
      }
      continue
    }

    const expectedSha = typeof meta === 'string' ? meta : meta?.sha256
    if (typeof expectedSha === 'string' && expectedSha) {
      try {
        const { textNormHash, rawHash } = hashDiskFile(abs)
        if (textNormHash !== expectedSha && rawHash !== expectedSha) {
          issues.push({ file: norm, kind: 'drifted', detail: 'File checksum differs from manifest baseline (local modification or drift)' })
        }
      } catch {
        issues.push({ file: norm, kind: 'unreadable', detail: 'Unable to hash managed file' })
      }
    }
  }

  for (const [relKey, info] of Object.entries(pendingConflicts)) {
    issues.push({
      file: posixPath(relKey),
      kind: 'pending-conflict',
      detail: `Unresolved three-way upgrade conflict (${info?.conflictFile ?? `${relKey}.pf-conflict`})`,
    })
  }

  return {
    present: true,
    schemaVersion: manifest.schemaVersion ?? 1,
    status: issues.length === 0 ? 'ok' : 'drift-detected',
    checkedFiles: checked,
    customizedCount,
    pendingConflictCount: Object.keys(pendingConflicts).length,
    issues,
  }
}

async function isPureTrackedSourceDir(workRoot, dirRel) {
  if (!dirRel || dirRel === '.worktrees') return false
  const trackedRes = await gitRunBuffer(workRoot, ['ls-files', '-z', '--', dirRel])
  if (!trackedRes.ok || !trackedRes.stdout) return false
  const hasTracked = trackedRes.stdout.toString('utf8').split('\0').some(Boolean)
  if (!hasTracked) return false
  const untrackedRes = await gitRunBuffer(workRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', dirRel])
  if (!untrackedRes.ok) return false
  const hasUntracked = untrackedRes.stdout.toString('utf8').split('\0').some(Boolean)
  return !hasUntracked
}

export async function auditUnignoredOutputDirs(workRoot, mainRoot, isGit, findings, addFinding) {
  const presentOutputs = OUTPUT_DIRS.filter((d) => existsSync(join(workRoot, d)))
  if (!isGit || presentOutputs.length === 0) return

  const giTxt = readTextSafe(join(workRoot, '.gitignore')) ?? ''
  const exTxt = readTextSafe(join(mainRoot, '.git', 'info', 'exclude')) ?? ''
  const onlyWorktrees = presentOutputs.length === 1 && presentOutputs[0] === '.worktrees'
    && [giTxt, exTxt].some((t) => /^\s*\/?\.worktrees\/?\s*(?:#.*)?$/m.test(t))
  const res = onlyWorktrees
    ? { stdout: '.worktrees\0' }
    : await gitRun(workRoot, ['check-ignore', '-z', '--stdin'], { input: presentOutputs.join('\0') })
  const ignored = new Set((res.stdout || '').split('\0').filter(Boolean).map((s) => posixPath(s).replace(/\/$/, '')))
  for (const d of presentOutputs) {
    if (ignored.has(d)) continue
    if (await isPureTrackedSourceDir(workRoot, d)) continue
    addFinding(findings, {
      id: `hygiene.unignored-dir.${d}`,
      category: 'hygiene',
      severity: d === '.worktrees' ? 'high' : 'medium',
      file: d,
      title: `Output/workspace directory "${d}/" exists on disk and is NOT in .gitignore`,
      action: `Add "${d}/" to .gitignore.`,
    })
  }
}

/** 联动核查 docs/feature-map.json Schema、僵尸脚本与工具过时漂移，供 `govern-audit reconcile` 调用。 */
export async function runReconcileVerifyToolsAudit(workRoot, mainRoot, gitDir, findings, addFinding) {
  const st = readFeatureMapStatus(workRoot)
  if (!st.exists) {
    return { present: false, status: 'missing', schemaOk: true, zombies: [], staleTools: [], solidificationHints: [] }
  }
  const raw = readFeatureMapRaw(workRoot)
  const schema = st.corrupt ? { ok: false, errors: [st.error], warnings: [] } : validateFeatureMap(raw)
  const map = !st.corrupt ? (readFeatureMap(workRoot) ?? { version: 1, features: [] }) : { version: 1, features: [] }

  if (!schema.ok) {
    addFinding(findings, {
      id: 'docs.verify-tools-schema',
      category: 'docs',
      severity: 'high',
      file: FEATURE_MAP_REL,
      title: `feature-map.json schema error: ${schema.errors[0] ?? 'invalid schema'}`,
      action: 'Run `verify-tools.mjs audit` and fix schema errors in docs/feature-map.json.',
    })
  }

  const zombies = []
  const staleTools = []
  for (const f of map.features) {
    for (const p of [...f.entrypoints, ...f.modules, ...f.testRefs]) {
      if (!p.endsWith('/') && !existsSync(join(workRoot, p))) {
        zombies.push({ kind: 'missing-path', featureId: f.id, path: p })
      }
    }
    for (const tool of f.verificationTools ?? []) {
      if (tool.scriptPath) {
        const absTool = resolve(workRoot, tool.scriptPath)
        if (!isInsideDir(absTool, workRoot) || !existsSync(absTool)) {
          zombies.push({ kind: 'missing-script', featureId: f.id, toolId: tool.id, path: tool.scriptPath })
        }
      } else if (tool.command) {
        const nodeScriptM = /\bnode\s+["']?([^\s"']+\.[cm]?js)["']?/i.exec(String(tool.command))
        if (nodeScriptM && !nodeScriptM[1].startsWith('-')) {
          const absCmdScript = resolve(workRoot, nodeScriptM[1])
          if (!isInsideDir(absCmdScript, workRoot) || !existsSync(absCmdScript)) {
            zombies.push({ kind: 'missing-script', featureId: f.id, toolId: tool.id, path: nodeScriptM[1] })
          }
        }
      }
      const staleRes = await evaluateToolStaleness({
        repoRoot: workRoot, gitCommonDir: gitDir, mainRoot, feature: f, tool,
      })
      if (staleRes.status === 'stale' || staleRes.status === 'missing-script') {
        staleTools.push(staleRes)
        addFinding(findings, {
          id: `docs.verify-tools-stale.${f.id}.${tool.id}`,
          category: 'docs',
          severity: tool.riskLevel === 'high' ? 'high' : 'medium',
          file: FEATURE_MAP_REL,
          title: `Verification tool "${f.id}/${tool.id}" (${tool.riskLevel}) is ${staleRes.status}: ${staleRes.reasons.join('; ')}`,
          action: 'Run `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs run` or `audit` to re-baseline.',
        })
      }
    }
  }

  if (zombies.length > 0) {
    addFinding(findings, {
      id: 'docs.verify-tools-zombie',
      category: 'docs',
      severity: 'medium',
      file: FEATURE_MAP_REL,
      title: `feature-map.json contains ${zombies.length} zombie path/script ref(s): ${zombies.slice(0, 3).map((z) => `${z.featureId}:${z.path}`).join(', ')}`,
      action: 'Run `node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs clean --confirm` or update docs/feature-map.json.',
    })
  }

  const solidificationHints = detectScratchSolidificationHints({ gitCommonDir: gitDir, mainRoot })
  const hasHardIssues = !schema.ok || zombies.length > 0 || staleTools.some((s) => s.riskLevel === 'high')
  return {
    present: true,
    status: hasHardIssues ? 'FAILED' : (staleTools.length > 0 ? 'WARN' : 'OK'),
    schemaOk: schema.ok,
    schemaErrors: schema.errors,
    zombies,
    staleTools,
    solidificationHints,
  }
}
