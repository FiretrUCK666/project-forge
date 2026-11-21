/**
 * verify-tools-audit.mjs —— `dev-verify-tools` 体检（audit）与清理（clean）子命令实现。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`），由 `verify-tools.mjs` 调度。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isInsideDir } from '../../lib/git.mjs'

import {
  FEATURE_MAP_REL, destroyTaskScratchDir, detectScratchSolidificationHints,
  evaluateToolStaleness, listTaskScratchDirs, readFeatureMap, readFeatureMapRaw,
  readFeatureMapStatus, validateFeatureMap, writeFeatureMap,
} from '../../lib/feature-map.mjs'
import { listTaskLedgers, sanitizeTaskId } from '../../lib/ledger.mjs'
import { CODE_EXT_RE, isTestOrFixtureFile } from '../../lib/static-gates.mjs'
import { generateRepoMap } from '../../dev-explore/scripts/repo-map.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'



function emitOut(opts, payload, lines) {
  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stdout.write(`${lines.join('\n')}\n`)
}

export function guardExistingFeatureMapForWrite(workRoot, opts) {
  const st = readFeatureMapStatus(workRoot)
  if (!st.corrupt) return { ok: true, status: st }
  const msg = `BLOCKED_CORRUPT_FEATURE_MAP: ${st.error}（写入操作 Fail-Closed，拒绝覆盖已损坏文件，请先修复或恢复备份）。`
  emitOut(opts, { ok: false, code: 'BLOCKED_CORRUPT_FEATURE_MAP', path: FEATURE_MAP_REL, error: msg }, [msg])
  process.stderr.write(`${msg}\n`)
  return { ok: false, exitCode: EXIT.FACT }
}

export async function handleAudit(opts, roots) {
  const workRoot = roots.workTreeRoot
  const baseRef = opts.base ? String(opts.base).trim() : null
  const st = readFeatureMapStatus(workRoot)
  const raw = readFeatureMapRaw(workRoot)
  const exists = st.exists
  const schema = !exists
    ? { ok: false, errors: [`缺少 ${FEATURE_MAP_REL}`], warnings: [] }
    : (st.corrupt
        ? { ok: false, errors: [st.error], warnings: [] }
        : validateFeatureMap(raw))
  const map = exists && !st.corrupt ? (readFeatureMap(workRoot) ?? { version: 1, features: [] }) : { version: 1, features: [] }

  const zombies = []
  const staleTools = []
  const duplicateFlows = []
  const flowOwner = new Map()

  for (const f of map.features) {
    for (const p of [...f.entrypoints, ...f.modules, ...f.testRefs]) {
      if (!p.endsWith('/') && !existsSync(join(workRoot, p))) {
        zombies.push({ kind: 'missing-path', featureId: f.id, path: p })
      }
    }
    for (const fl of f.businessFlows ?? []) {
      const k = fl.trim().toLowerCase()
      if (flowOwner.has(k) && flowOwner.get(k) !== f.id) {
        duplicateFlows.push({ flow: fl, features: [flowOwner.get(k), f.id] })
      } else {
        flowOwner.set(k, f.id)
      }
    }
    for (const tool of f.verificationTools ?? []) {
      if (tool.scriptPath) {
        const absTool = resolve(workRoot, tool.scriptPath)
        if (!isInsideDir(absTool, workRoot)) {
          zombies.push({ kind: 'script-outside-repo', featureId: f.id, toolId: tool.id, path: tool.scriptPath })
        } else if (!existsSync(absTool)) {
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
        repoRoot: workRoot, gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot, feature: f, tool, baseRef,
      })
      if (staleRes.status === 'stale' || staleRes.status === 'missing-script') staleTools.push(staleRes)
    }
  }

  const repoMap = await generateRepoMap(workRoot)
  const coveredPaths = new Set(map.features.flatMap((f) => [...f.entrypoints, ...f.modules]))
  const blindSpots = []
  for (const ep of repoMap.entrypoints ?? []) {
    if (!CODE_EXT_RE.test(ep) || isTestOrFixtureFile(ep)) continue
    if (!coveredPaths.has(ep)) {
      blindSpots.push({ kind: 'unmapped-entrypoint', path: ep, reason: '核心入口未登记在 docs/feature-map.json' })
    }
  }
  for (const f of map.features) {
    if ((f.verificationTools?.length ?? 0) === 0 && (f.testRefs?.length ?? 0) === 0) {
      blindSpots.push({ kind: 'feature-without-verification', featureId: f.id, reason: `功能 "${f.id}" 既无 verificationTools 也无 testRefs` })
    }
  }

  const solidificationHints = detectScratchSolidificationHints({ gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot })
  const activeTaskIds = new Set(listTaskLedgers(roots.mainRoot, { includeTerminal: false }).map((l) => sanitizeTaskId(l.taskId)))
  const scratchDirs = listTaskScratchDirs(roots.gitDir, roots.mainRoot)
  const orphanScratchDirs = scratchDirs.filter((d) => !activeTaskIds.has(d.taskId))

  const hasHardIssues = !schema.ok || zombies.length > 0 || staleTools.some((s) => s.riskLevel === 'high')
  const toolCount = map.features.reduce((acc, f) => acc + (f.verificationTools?.length ?? 0), 0)
  const isEmptyFeatureMap = exists && !st.corrupt && schema.ok && map.features.length === 0 && toolCount === 0
  const status = isEmptyFeatureMap ? 'NOT_APPLICABLE' : (hasHardIssues ? 'FAILED' : 'OK')
  const payload = {
    ok: !hasHardIssues,
    status,
    exists,
    corrupt: st.corrupt,
    path: FEATURE_MAP_REL,
    featureCount: map.features.length,
    toolCount,
    schema, zombies, staleTools, duplicateFlows, blindSpots, solidificationHints, scratchDirs, orphanScratchDirs,
  }
  const lines = [
    `=== VERIFY-TOOLS AUDIT (${FEATURE_MAP_REL}) ===`,
    `Status: ${status} | Features: ${payload.featureCount} | Tools: ${payload.toolCount} | SchemaOk: ${schema.ok}`,
    `Zombies: ${zombies.length} | StaleTools: ${staleTools.length} | BlindSpots: ${blindSpots.length} | OrphanScratch: ${orphanScratchDirs.length}`,
  ]
  for (const err of schema.errors) lines.push(`  - [SCHEMA_ERR] ${err}`)
  for (const z of zombies.slice(0, 12)) lines.push(`  - [ZOMBIE:${z.kind}] ${z.featureId}: ${z.path}`)
  for (const s of staleTools.slice(0, 12)) lines.push(`  - [STALE:${s.riskLevel}/${s.code}] ${s.featureId}/${s.toolId}: ${s.reasons.join('; ')}`)
  for (const b of blindSpots.slice(0, 10)) lines.push(`  - [BLIND_SPOT:${b.kind}] ${b.path ?? b.featureId}: ${b.reason}`)
  for (const h of solidificationHints) lines.push(`  - [${h.code}] ${h.suggestion}`)
  for (const o of orphanScratchDirs) lines.push(`  - [ORPHAN_SCRATCH] task=${o.taskId} (${o.fileCount} files): ${o.posixDir}`)
  emitOut(opts, payload, lines)
  return { exitCode: hasHardIssues ? EXIT.FACT : EXIT.OK, ...payload }
}

export async function handleClean(opts, roots) {
  const workRoot = roots.workTreeRoot
  const confirmed = Boolean(opts.confirm || opts.apply)
  const pruneZombies = opts['prune-zombies'] !== undefined ? Boolean(opts['prune-zombies']) : true
  const pruneScratch = opts['prune-scratch'] !== undefined ? Boolean(opts['prune-scratch']) : true
  const specificTask = opts.task ? sanitizeTaskId(opts.task) : null

  if (confirmed && pruneZombies) {
    const guard = guardExistingFeatureMapForWrite(workRoot, opts)
    if (!guard.ok) return { exitCode: guard.exitCode, ok: false, code: 'BLOCKED_CORRUPT_FEATURE_MAP' }
  }
  const map = readFeatureMap(workRoot)
  const removedZombiePaths = []
  const removedZombieTools = []
  let nextMap = null

  if (map && pruneZombies) {
    const cleanedFeatures = []
    for (const f of map.features) {
      const keepEp = f.entrypoints.filter((p) => p.endsWith('/') || existsSync(join(workRoot, p)) || (removedZombiePaths.push({ featureId: f.id, field: 'entrypoints', path: p }), false))
      const keepMod = f.modules.filter((p) => p.endsWith('/') || existsSync(join(workRoot, p)) || (removedZombiePaths.push({ featureId: f.id, field: 'modules', path: p }), false))
      const keepTest = f.testRefs.filter((p) => p.endsWith('/') || existsSync(join(workRoot, p)) || (removedZombiePaths.push({ featureId: f.id, field: 'testRefs', path: p }), false))
      const keepTools = (f.verificationTools ?? []).filter((t) => {
        if (t.scriptPath && !existsSync(join(workRoot, t.scriptPath))) {
          removedZombieTools.push({ featureId: f.id, toolId: t.id, scriptPath: t.scriptPath })
          return false
        }
        return true
      })
      cleanedFeatures.push({ ...f, entrypoints: keepEp, modules: keepMod, testRefs: keepTest, verificationTools: keepTools })
    }
    nextMap = { version: 1, features: cleanedFeatures }
  }

  const activeTaskIds = new Set(listTaskLedgers(roots.mainRoot, { includeTerminal: false }).map((l) => sanitizeTaskId(l.taskId)))
  const allScratch = listTaskScratchDirs(roots.gitDir, roots.mainRoot)
  const scratchTargets = pruneScratch
    ? allScratch.filter((d) => (specificTask ? d.taskId === specificTask : !activeTaskIds.has(d.taskId)))
    : []

  if (!confirmed) {
    const payload = {
      ok: true, dryRun: true,
      zombiePathsToRemove: removedZombiePaths,
      zombieToolsToRemove: removedZombieTools,
      scratchDirsToDestroy: scratchTargets.map((s) => ({ taskId: s.taskId, path: s.posixDir, fileCount: s.fileCount })),
    }
    emitOut(opts, payload, [
      `[verify-tools clean:dry-run] 待清理：僵尸路径 ${removedZombiePaths.length} 处、僵尸工具 ${removedZombieTools.length} 项、仓外 scratch 目录 ${scratchTargets.length} 个（加 --confirm 执行）`,
    ])
    return { exitCode: EXIT.OK, ...payload }
  }

  let mapUpdated = false
  if (nextMap && (removedZombiePaths.length > 0 || removedZombieTools.length > 0)) {
    writeFeatureMap(workRoot, nextMap)
    mapUpdated = true
  }
  const destroyedScratch = []
  for (const s of scratchTargets) {
    destroyedScratch.push(await destroyTaskScratchDir({
      gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot, taskId: s.taskId,
      recordSignal: true, source: 'verify-tools-clean',
    }))
  }

  const payload = { ok: true, dryRun: false, mapUpdated, removedZombiePaths, removedZombieTools, destroyedScratch }
  emitOut(opts, payload, [
    `[verify-tools clean] 已清理僵尸路径 ${removedZombiePaths.length} 处、僵尸工具 ${removedZombieTools.length} 项、销毁仓外 scratch ${destroyedScratch.filter((d) => d.destroyed).length} 个。`,
  ])
  return { exitCode: EXIT.OK, ...payload }
}
