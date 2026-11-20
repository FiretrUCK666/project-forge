#!/usr/bin/env node
/**
 * verify-tools.mjs —— 第 7 技能 `dev-verify-tools` 验证工具生命周期引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`），支持：
 *   - `sync`：基于 repo-map 增量预填/刷新 `docs/feature-map.json`（保留用户手写条目）；
 *   - `create`：仓外 `{gitCommonDir}/project-forge-verify/scratch/{taskId}/` 试制，经 `edit-gate` 与实跑通过后沉淀登记地图与基线；
 *   - `run`：按变更文件/功能/工具 ID 反查，执行免手工日期过时校验与低/中/高三级风险分派，透传任务参数实跑并刷新基线；
 *   - `audit` / `clean`：校验 Schema、僵尸脚本/模块、符号漂移、核心盲区、跨 >=2 PR 固化提示及安全销毁过期 `scratch/` 残留。
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import {
  FEATURE_MAP_REL, VALID_RISK_LEVELS, VALID_TOOL_KINDS,
  computeFeatureFingerprint, ensureTaskScratchDir, evaluateToolStaleness,
  findAffectedFeatures, isSafeTaskScratchPath, prefillFeatureMapFromRepoMap,
  readFeatureMap, resolveTaskScratchDir, sanitizeFeatureEntry, sanitizeVerificationTool,
  slugifyFeatureId, writeFeatureMap, writeVerifyCacheEntry,
} from '../../lib/feature-map.mjs'
import {
  computeWorktreeEnv, execShellCommand, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ,
  isMainModule, posixPath, resolveRepoRoots,
} from '../../lib/git.mjs'
import { sanitizeTaskId } from '../../lib/ledger.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { runEditGate } from '../../dev-edit/scripts/edit-gate.mjs'
import { generateRepoMap } from '../../dev-explore/scripts/repo-map.mjs'
import { guardExistingFeatureMapForWrite, handleAudit, handleClean } from './verify-tools-audit.mjs'

export { handleAudit, handleClean }

export { EXIT }
const SUBCOMMANDS = ['sync', 'create', 'run', 'audit', 'clean']

function printHelp() {
  process.stdout.write([
    '用法：node verify-tools.mjs <sync|create|run|audit|clean> [dir] [options]',
    '',
    'Subcommands:',
    '  sync    Incrementally prefill/refresh docs/feature-map.json from repo-map (preserves custom entries)',
    '  create  Draft probe in out-of-repo scratch/{taskId}/ and promote after edit-gate + real run pass',
    '  run     Reverse-lookup tools for changed files/feature, run date-free stale check, execute & update cache',
    '  audit   Check schema, zombie refs, stale drift, blind spots, >=2 PR scratch hints & orphan scratch dirs',
    '  clean   Preview or (--confirm) remove zombie feature-map refs and closed-task scratch dirs',
    '',
    'Exit Codes: 0=ok, 1=error, 2=usage, 3=policy/stale/gate blocked',
    '',
  ].join('\n'))
}

function splitCsv(raw) {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((v) => String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean)
}

function normRelFile(repoRoot, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const rel = isAbsolute(s) ? relative(repoRoot, s) : s
  return posixPath(rel).replace(/^\.\//, '').replace(/^\/+/, '')
}

async function resolveCurrentHead(repoRoot) {
  const res = await gitRun(repoRoot, ['rev-parse', 'HEAD'])
  return res.ok ? res.stdout.trim() : null
}

async function collectChangedFilesForRun(repoRoot, baseRef = null) {
  const set = new Set()
  const st = await gitStatusPorcelainZ(repoRoot)
  if (st.ok) {
    for (const e of st.entries) {
      if (e.file && !String(e.status).includes('D')) set.add(posixPath(e.file))
    }
  }
  const ref = baseRef || 'main'
  const mb = await gitRun(repoRoot, ['merge-base', ref, 'HEAD'])
  if (mb.ok && mb.stdout.trim()) {
    const diff = await gitDiffNameStatusZ(repoRoot, [`${mb.stdout.trim()}..HEAD`])
    if (diff.ok) {
      for (const e of diff.entries) {
        if (e.file && e.status !== 'D') set.add(posixPath(e.file))
      }
    }
  }
  return [...set].sort()
}

function buildToolCommand(tool, taskId) {
  let cmd = tool.command ? String(tool.command).trim() : ''
  if (!cmd && tool.scriptPath) {
    cmd = tool.scriptPath.endsWith('.py') ? `python "${tool.scriptPath}"` : `node "${tool.scriptPath}"`
  }
  if (!cmd) return ''
  if (taskId && cmd.includes('{task}')) cmd = cmd.replace(/\{task\}/g, taskId)
  return cmd
}

function emitOut(opts, payload, lines) {
  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stdout.write(`${lines.join('\n')}\n`)
}

export async function handleSync(opts, roots) {
  const workRoot = roots.workTreeRoot
  if (!opts['dry-run']) {
    const guard = guardExistingFeatureMapForWrite(workRoot, opts)
    if (!guard.ok) return { exitCode: guard.exitCode, ok: false, code: 'BLOCKED_CORRUPT_FEATURE_MAP' }
  }
  const map = await generateRepoMap(workRoot, { writeFeatureMap: !opts['dry-run'] })
  const res = prefillFeatureMapFromRepoMap(workRoot, map, { write: !opts['dry-run'] })
  const payload = {
    ok: true,
    action: opts['dry-run'] ? 'sync-dry-run' : 'synced',
    path: FEATURE_MAP_REL,
    existed: res.existed,
    written: res.written,
    featureCount: res.featureMap.features.length,
    addedFeatures: res.addedFeatures,
    updatedFeatures: res.updatedFeatures,
    featureMap: res.featureMap,
  }
  emitOut(opts, payload, [
    `[verify-tools sync] ${FEATURE_MAP_REL}: features=${payload.featureCount} (added=${res.addedFeatures}, updated=${res.updatedFeatures}, written=${res.written})`,
  ])
  return { exitCode: EXIT.OK, ...payload }
}

export async function handleCreate(opts, roots) {
  const workRoot = roots.workTreeRoot
  const taskId = sanitizeTaskId(opts.task || 'verify-draft')
  const featureId = slugifyFeatureId(opts.feature || opts.name || '')
  if (!opts.feature && !opts.name) {
    process.stderr.write('Error: create 需要指定 --feature <id>（或 --name <名称>）。\n')
    return { exitCode: EXIT.USAGE }
  }
  const modules = splitCsv(opts.modules).map((p) => normRelFile(workRoot, p))
  const entrypoints = splitCsv(opts.entrypoints).map((p) => normRelFile(workRoot, p))
  const flows = splitCsv(opts.flows)
  const testRefs = splitCsv(opts['test-refs']).map((p) => normRelFile(workRoot, p))
  const hints = splitCsv(opts.hints)
  const riskRaw = String(opts.risk ?? 'medium').trim().toLowerCase()
  if (!VALID_RISK_LEVELS.includes(riskRaw)) {
    process.stderr.write(`Error: --risk 仅允许 low|medium|high，收到：${opts.risk}\n`)
    return { exitCode: EXIT.USAGE }
  }
  const kindRaw = String(opts.kind ?? (opts.script ? 'script' : 'command')).trim().toLowerCase()
  const kind = VALID_TOOL_KINDS.includes(kindRaw) ? kindRaw : 'command'

  const scratchInfo = ensureTaskScratchDir(roots.gitDir, taskId, roots.mainRoot, {
    featureId,
    modules: modules.length > 0 ? modules : entrypoints,
  })

  // 阶段 A：仓外 scratch 试制草稿（绝不污染工作区）
  if (opts['draft-only'] || (!opts.promote && !opts.apply && !opts.command && !opts.script)) {
    const draftName = basename(String(opts['draft-file'] || `probe-${featureId}.mjs`))
    const draftAbs = join(scratchInfo.dir, draftName)
    if (!isSafeTaskScratchPath(draftAbs, roots.gitDir, taskId, roots.mainRoot)) {
      process.stderr.write(`BLOCKED_UNSAFE_SCRATCH_PATH: 拒绝在仓外 scratch 前缀之外写草稿 (${draftAbs})\n`)
      return { exitCode: EXIT.FACT }
    }
    if (!existsSync(draftAbs) || opts['draft-content']) {
      const content = typeof opts['draft-content'] === 'string' && opts['draft-content'].length > 0
        ? opts['draft-content']
        : `#!/usr/bin/env node\n// Disposable out-of-repo probe for feature: ${featureId}\nconsole.log('PROBE_OK feature=${featureId}')\n`
      writeFileSync(draftAbs, content, 'utf8')
    }
    const payload = {
      ok: true,
      phase: 'scratch-draft',
      featureId,
      taskId,
      scratchDir: scratchInfo.posixDir,
      draftPath: posixPath(draftAbs),
      nextSteps: [
        `node "${posixPath(draftAbs)}"`,
        `node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" create --feature ${featureId} --task ${taskId} --from-scratch "${draftName}" --script scripts/verify-${featureId}.mjs --risk ${riskRaw} --promote`,
      ],
    }
    emitOut(opts, payload, [
      `[verify-tools create:draft] 仓外探针已就绪：${payload.draftPath}`,
      `  featureId=${featureId} | taskId=${taskId} | scratchDir=${payload.scratchDir}`,
    ])
    return { exitCode: EXIT.OK, ...payload }
  }

  // 阶段 B：沉淀至仓库（支持 --from-scratch 迁移）、过 edit-gate 与真实运行后原子注册地图与基线
  const mapGuard = guardExistingFeatureMapForWrite(workRoot, opts)
  if (!mapGuard.ok) return { exitCode: mapGuard.exitCode, ok: false, code: 'BLOCKED_CORRUPT_FEATURE_MAP' }
  const scriptRel = opts.script ? normRelFile(workRoot, opts.script) : null
  const fromScratch = opts['from-scratch'] ? String(opts['from-scratch']).trim() : null
  let promotedFromScratch = false
  let targetScriptAbs = scriptRel ? resolve(workRoot, scriptRel) : null
  let scriptPreExisted = Boolean(targetScriptAbs && existsSync(targetScriptAbs))
  const rollbackCopiedScript = () => {
    if (promotedFromScratch && !scriptPreExisted && targetScriptAbs && existsSync(targetScriptAbs)) {
      try { rmSync(targetScriptAbs, { force: true }) } catch { /* ignore */ }
    }
  }

  if (fromScratch) {
    const srcAbs = isAbsolute(fromScratch) ? fromScratch : join(scratchInfo.dir, fromScratch)
    if (!isSafeTaskScratchPath(srcAbs, roots.gitDir, taskId, roots.mainRoot)) {
      const msg = `BLOCKED_SCRATCH_SOURCE_OUTSIDE_SANDBOX: --from-scratch 必须位于 ${scratchInfo.posixDir} 内`
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT, ok: false, code: 'BLOCKED_SCRATCH_SOURCE_OUTSIDE_SANDBOX', error: msg }
    }
    if (!existsSync(srcAbs)) {
      const msg = `BLOCKED_SCRATCH_SOURCE_MISSING: 仓外草稿不存在：${posixPath(srcAbs)}`
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT, ok: false, code: 'BLOCKED_SCRATCH_SOURCE_MISSING', error: msg }
    }
    if (!scriptRel) {
      process.stderr.write('Error: 使用 --from-scratch 沉淀时必须同时指定目标仓相对路径 --script <relPath>。\n')
      return { exitCode: EXIT.USAGE }
    }
    targetScriptAbs = resolve(workRoot, scriptRel)
    mkdirSync(dirname(targetScriptAbs), { recursive: true })
    copyFileSync(srcAbs, targetScriptAbs)
    promotedFromScratch = true
  }

  if (scriptRel && !existsSync(targetScriptAbs)) {
    const msg = `BLOCKED_MISSING_TOOL_SCRIPT: 指定的持久化脚本不存在：${scriptRel}`
    process.stderr.write(`${msg}\n`)
    return { exitCode: EXIT.FACT, ok: false, code: 'BLOCKED_MISSING_TOOL_SCRIPT', error: msg }
  }

  // 过 edit-gate 静态卫生门禁，阻断压制注释、死代码、过程命名或架构越界
  let editGateRes = null
  if (scriptRel) {
    editGateRes = await runEditGate({ mode: 'standalone', files: [scriptRel], dir: workRoot, task: taskId })
    if (!editGateRes.ok) {
      rollbackCopiedScript()
      const msg = `BLOCKED_EDIT_GATE_FAILED: 验证脚本 ${scriptRel} 未通过 edit-gate 静态门禁（${(editGateRes.blockers ?? []).length} 项阻塞）。`
      const payload = { ok: false, code: 'BLOCKED_EDIT_GATE_FAILED', scriptPath: scriptRel, editGate: editGateRes, error: msg }
      emitOut(opts, payload, [msg, ...(editGateRes.blockers ?? []).map((b) => `  - [${b.ruleId}] ${b.message}`)])
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT, ...payload }
    }
  }

  const toolId = slugifyFeatureId(opts['tool-id'] || (scriptRel ? basename(scriptRel).replace(/\.[^.]+$/, '') : `verify-${featureId}`))
  const toolDef = sanitizeVerificationTool({
    id: toolId,
    kind,
    command: opts.command ? String(opts.command).trim() : (scriptRel ? `node ${scriptRel}` : null),
    scriptPath: scriptRel,
    riskLevel: riskRaw,
    triggerHints: hints.length > 0 ? hints : [featureId],
  })
  const runCmd = buildToolCommand(toolDef, taskId)
  if (!runCmd) {
    process.stderr.write('Error: create 需要提供可执行的 --command "<cmd>" 或 --script <path>。\n')
    return { exitCode: EXIT.USAGE }
  }

  // 真实运行校验通过后才允许落盘登记
  let runOutcome = null
  if (!opts['skip-run']) {
    const wtEnv = computeWorktreeEnv({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, taskId })
    const t0 = performance.now()
    const res = await execShellCommand(runCmd, workRoot, {
      timeout: 180000,
      env: { ...wtEnv, PF_VERIFY_TASK_ID: taskId, PF_VERIFY_SCRATCH_DIR: scratchInfo.dir },
    })
    runOutcome = {
      cmd: runCmd,
      exitCode: res.code,
      ok: Boolean(res.ok),
      durationMs: Math.round(performance.now() - t0),
      stdoutExcerpt: String(res.stdout ?? '').slice(0, 400),
      stderrExcerpt: String(res.stderr ?? '').slice(0, 400),
    }
    if (!runOutcome.ok) {
      rollbackCopiedScript()
      const msg = `BLOCKED_TOOL_RUN_FAILED: 新建工具实跑未通过 (exit=${runOutcome.exitCode})，拒绝登记至 ${FEATURE_MAP_REL}。`
      const payload = { ok: false, code: 'BLOCKED_TOOL_RUN_FAILED', tool: toolDef, runOutcome, error: msg }
      emitOut(opts, payload, [msg, runOutcome.stderrExcerpt || runOutcome.stdoutExcerpt])
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT, ...payload }
    }
  }

  const existing = readFeatureMap(workRoot) ?? { version: 1, features: [] }
  const nextFeatures = existing.features.map((f) => ({
    ...f,
    entrypoints: [...f.entrypoints],
    modules: [...f.modules],
    businessFlows: [...f.businessFlows],
    verificationTools: f.verificationTools.map((t) => ({ ...t })),
    testRefs: [...f.testRefs],
  }))
  let feat = nextFeatures.find((f) => f.id === featureId)
  if (!feat) {
    feat = sanitizeFeatureEntry({
      id: featureId,
      name: opts.name || featureId,
      entrypoints: entrypoints.length > 0 ? entrypoints : modules.slice(0, 2),
      modules: modules.length > 0 ? modules : entrypoints,
      businessFlows: flows.length > 0 ? flows : [`${opts.name || featureId} 核心业务流`],
      verificationTools: [toolDef],
      testRefs,
    })
    nextFeatures.push(feat)
  } else {
    for (const ep of entrypoints) if (!feat.entrypoints.includes(ep)) feat.entrypoints.push(ep)
    for (const mod of modules) if (!feat.modules.includes(mod)) feat.modules.push(mod)
    for (const fl of flows) if (!feat.businessFlows.includes(fl)) feat.businessFlows.push(fl)
    for (const tr of testRefs) if (!feat.testRefs.includes(tr)) feat.testRefs.push(tr)
    const idx = feat.verificationTools.findIndex((t) => t.id === toolDef.id)
    if (idx >= 0) feat.verificationTools[idx] = toolDef
    else feat.verificationTools.push(toolDef)
  }

  writeFeatureMap(workRoot, { version: 1, features: nextFeatures })
  const headSha = await resolveCurrentHead(workRoot)
  const fp = await computeFeatureFingerprint(workRoot, feat)
  const cacheRes = writeVerifyCacheEntry(roots.gitDir, roots.mainRoot, toolDef.id, {
    featureId: feat.id,
    symbolHash: fp.symbolHash,
    moduleTreeHash: fp.moduleTreeHash,
    verifiedSha: headSha,
    passedAtCommit: headSha,
    symbolsByFile: fp.symbolsByFile,
  })

  const payload = {
    ok: true,
    phase: 'promoted',
    featureId: feat.id,
    tool: toolDef,
    promotedFromScratch,
    editGatePassed: editGateRes ? editGateRes.ok : null,
    runOutcome,
    featureMapPath: FEATURE_MAP_REL,
    cachePath: cacheRes.path,
    baseline: cacheRes.entry,
  }
  emitOut(opts, payload, [
    `[verify-tools create:promoted] 已登记工具 "${toolDef.id}" -> feature "${feat.id}" (${FEATURE_MAP_REL})`,
    `  command=${runCmd} | risk=${toolDef.riskLevel} | baseline=${String(headSha ?? 'unborn').slice(0, 8)}`,
  ])
  return { exitCode: EXIT.OK, ...payload }
}

export async function handleRun(opts, roots) {
  const workRoot = roots.workTreeRoot
  const taskId = opts.task ? sanitizeTaskId(opts.task) : 'adhoc'
  const baseRef = opts.base ? String(opts.base).trim() : null
  const refreshBaseline = Boolean(opts['refresh-baseline'])
  const allowMediumFallback = Boolean(opts['allow-medium-fallback'])
  const liveE2eCmd = opts['live-e2e-cmd'] ? String(opts['live-e2e-cmd']).trim() : ''

  let map = readFeatureMap(workRoot)
  let mapSource = FEATURE_MAP_REL
  if (!map) {
    const rm = await generateRepoMap(workRoot)
    map = prefillFeatureMapFromRepoMap(workRoot, rm, { write: false }).featureMap
    mapSource = 'prefill-in-memory'
  }

  const explicitFiles = splitCsv(opts.files).map((p) => normRelFile(workRoot, p))
  const targetFiles = explicitFiles.length > 0
    ? explicitFiles
    : (opts.changed ? await collectChangedFilesForRun(workRoot, baseRef) : [])

  const matched = []
  const seenTool = new Set()
  const addPair = (feature, tool) => {
    if (!feature || !tool || seenTool.has(tool.id)) return
    seenTool.add(tool.id)
    matched.push({ feature, tool })
  }

  if (opts.tool) {
    const wanted = new Set(splitCsv(opts.tool))
    for (const f of map.features) {
      for (const t of f.verificationTools ?? []) if (wanted.has(t.id)) addPair(f, t)
    }
  } else if (opts.feature) {
    const wanted = new Set(splitCsv(opts.feature).map(slugifyFeatureId))
    for (const f of map.features) {
      if (wanted.has(f.id)) for (const t of f.verificationTools ?? []) addPair(f, t)
    }
  } else if (targetFiles.length > 0) {
    const aff = findAffectedFeatures(map, targetFiles)
    for (const f of aff.matchedFeatures) {
      for (const t of f.verificationTools ?? []) addPair(f, t)
    }
  }

  const scratchDir = posixPath(resolveTaskScratchDir(roots.gitDir, taskId, roots.mainRoot))
  if (matched.length === 0) {
    const payload = {
      ok: true,
      matched: false,
      mapSource,
      targetFiles,
      scratchDir,
      results: [],
      fallbackHint: '未匹配到预设验证工具；禁止跳过实证，请优先运行受波及模块的测试/E2E 命令或在仓外 scratch 目录现写一次性探针实测。',
    }
    emitOut(opts, payload, [
      `[verify-tools run] 未匹配预设验证工具（source=${mapSource}, files=${targetFiles.length}）`,
      `  提示：${payload.fallbackHint}`,
      `  仓外 scratch 路径：${scratchDir}`,
    ])
    return { exitCode: EXIT.OK, ...payload }
  }

  const headSha = await resolveCurrentHead(workRoot)
  const wtEnv = computeWorktreeEnv({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, taskId })
  const results = []
  let blockedCode = null
  let anyFailed = false

  for (const { feature, tool } of matched) {
    const staleness = await evaluateToolStaleness({
      repoRoot: workRoot,
      gitCommonDir: roots.gitDir,
      mainRoot: roots.mainRoot,
      feature,
      tool,
      baseRef,
    })

    if (staleness.status === 'missing-script') {
      blockedCode = staleness.code
      results.push({ toolId: tool.id, featureId: feature.id, staleness, executed: false, ok: false, blocked: true })
      continue
    }

    if (staleness.status === 'stale' && tool.riskLevel === 'high' && !refreshBaseline && !liveE2eCmd) {
      blockedCode = 'BLOCKED_STALE_HIGH_RISK_TOOL'
      results.push({
        toolId: tool.id,
        featureId: feature.id,
        staleness,
        executed: false,
        ok: false,
        blocked: true,
        unblockHints: [
          `先升级验证工具 "${tool.id}" 后带 --refresh-baseline 重跑刷新基线`,
          `或使用等效实时 E2E 命令替代：--live-e2e-cmd "<实时端到端验证命令>"`,
        ],
      })
      continue
    }

    if (staleness.status === 'stale' && tool.riskLevel === 'medium' && !refreshBaseline && !liveE2eCmd && !allowMediumFallback) {
      await appendGovernSignal({
        mainRoot: roots.mainRoot,
        gitDir: roots.gitDir,
        isGit: Boolean(roots.gitDir),
        category: 'verify',
        module: feature.modules[0] ?? feature.id,
        pattern: 'verify.tool-stale-medium',
        ruleId: 'verify.tool-stale-medium',
        defectClass: 'stale-contract',
        severity: 'medium',
        source: 'verify-tools',
        taskId,
        targetArtifact: tool.id,
        message: `medium-risk verification tool "${tool.id}" is stale (${staleness.reasons.join('; ')})`,
        meta: { toolId: tool.id, featureId: feature.id, changedModules: staleness.changedModules },
      })
      blockedCode = 'STALE_MEDIUM_FALLBACK'
      results.push({
        toolId: tool.id,
        featureId: feature.id,
        staleness,
        executed: false,
        ok: false,
        blocked: true,
        fallbackTestRefs: feature.testRefs,
        scratchDir,
        unblockHints: [
          feature.testRefs.length > 0 ? `优先转跑关联 testRefs：${feature.testRefs.join(', ')}` : `在仓外 ${scratchDir} 编写临时探针验证核心路径`,
          '或传 --live-e2e-cmd "<E2E命令>" / --refresh-baseline 重采基线',
        ],
      })
      continue
    }

    const cmdToRun = (staleness.status === 'stale' && liveE2eCmd) ? liveE2eCmd : buildToolCommand(tool, taskId)
    const usedLiveOverride = Boolean(staleness.status === 'stale' && liveE2eCmd)
    const t0 = performance.now()
    const execRes = await execShellCommand(cmdToRun, workRoot, {
      timeout: 300000,
      env: { ...wtEnv, PF_VERIFY_TASK_ID: taskId, PF_VERIFY_SCRATCH_DIR: resolveTaskScratchDir(roots.gitDir, taskId, roots.mainRoot) },
    })
    const durationMs = Math.round(performance.now() - t0)
    const passed = Boolean(execRes.ok)
    if (!passed) anyFailed = true

    let baselineUpdated = false
    const shouldPersistBaseline = passed && (
      staleness.status === 'unbaselined'
      || refreshBaseline
      || (!usedLiveOverride && (!baseRef || staleness.status === 'stale'))
    )
    if (shouldPersistBaseline) {
      const fp = await computeFeatureFingerprint(workRoot, feature)
      writeVerifyCacheEntry(roots.gitDir, roots.mainRoot, tool.id, {
        featureId: feature.id,
        symbolHash: fp.symbolHash,
        moduleTreeHash: fp.moduleTreeHash,
        verifiedSha: headSha,
        passedAtCommit: headSha,
        symbolsByFile: fp.symbolsByFile,
      })
      baselineUpdated = true
    }

    results.push({
      toolId: tool.id,
      featureId: feature.id,
      riskLevel: tool.riskLevel,
      staleness,
      warningCode: staleness.status === 'stale' && tool.riskLevel === 'low' ? 'STALE_WARN' : null,
      usedLiveOverride,
      cmd: cmdToRun,
      executed: true,
      exitCode: execRes.code,
      ok: passed,
      durationMs,
      baselineUpdated,
      stdoutExcerpt: String(execRes.stdout ?? '').slice(0, 500),
      stderrExcerpt: String(execRes.stderr ?? '').slice(0, 500),
    })
  }

  const exitCode = blockedCode ? EXIT.FACT : (anyFailed ? EXIT.ERROR : EXIT.OK)
  const payload = { ok: exitCode === EXIT.OK, code: blockedCode, mapSource, taskId, baseRef, matched: true, results }
  const lines = [`[verify-tools run] matched=${results.length} ok=${payload.ok}${blockedCode ? ` code=${blockedCode}` : ''}`]
  for (const r of results) {
    const tag = r.blocked ? `BLOCKED:${r.staleness.code}` : (r.warningCode ? `${r.warningCode} exit=${r.exitCode}` : `exit=${r.exitCode}`)
    lines.push(`  - [${r.featureId}/${r.toolId}] ${tag}${r.staleness?.reasons?.length ? ` | ${r.staleness.reasons.join('; ')}` : ''}`)
  }
  emitOut(opts, payload, lines)
  if (blockedCode) process.stderr.write(`${blockedCode}: 验证工具过时或脚本缺失，请按提示处置。\n`)
  return { exitCode, ...payload }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return EXIT.OK
  }
  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      positionalDir: 'auto',
      booleanFlags: [
        'json', 'help', 'dry-run', 'draft-only', 'promote', 'apply', 'skip-run',
        'changed', 'refresh-baseline', 'allow-medium-fallback', 'confirm', 'prune-zombies', 'prune-scratch',
      ],
      valueFlags: [
        'dir', 'repo', 'feature', 'name', 'tool', 'tool-id', 'kind', 'command', 'script',
        'from-scratch', 'draft-file', 'draft-content', 'task', 'risk', 'entrypoints',
        'modules', 'flows', 'test-refs', 'hints', 'files', 'base', 'live-e2e-cmd',
      ],
      usageHint: 'verify-tools.mjs <sync|create|run|audit|clean> [dir] [options]',
    })
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    return EXIT.USAGE
  }
  if (!cli.sub) {
    process.stderr.write(`Error: 缺少子命令（可用：${SUBCOMMANDS.join(', ')}）\n`)
    return EXIT.USAGE
  }
  const roots = await resolveRepoRoots(cli.targetDir)
  try {
    let res
    if (cli.sub === 'sync') res = await handleSync(cli.opts, roots)
    else if (cli.sub === 'create') res = await handleCreate(cli.opts, roots)
    else if (cli.sub === 'run') res = await handleRun(cli.opts, roots)
    else if (cli.sub === 'audit') res = await handleAudit(cli.opts, roots)
    else if (cli.sub === 'clean') res = await handleClean(cli.opts, roots)
    if (!cli.opts.json && res?.exitCode === EXIT.OK && res?.nextSteps?.length) {
      printNextStep(res.nextSteps, { repoRoot: roots.mainRoot })
    }
    return res?.exitCode ?? EXIT.OK
  } catch (err) {
    process.stderr.write(`verify-tools 失败：${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.ERROR
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`verify-tools 失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(EXIT.ERROR)
    })
}
