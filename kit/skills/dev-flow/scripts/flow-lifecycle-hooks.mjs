/**
 * flow-lifecycle-hooks.mjs —— 实施权属校验、条件钩子分发器（dev-edit / dev-govern / forge-hooks.json）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），支持按需探测已装配技能并优雅跳过未落盘钩子。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { evaluateReleaseReason } from '../../lib/evidence-substance.mjs'
import { ARCHITECTURE_MAP_REL, isArchitectureMapOptedOut, verifyArchitectureMapSync } from '../../lib/architecture-map.mjs'
import { execSafe, execShellCommand, gitDiffNameStatusZ, gitStatusPorcelainZ, posixPath, readTextSafe } from '../../lib/git.mjs'
import { enforceSlotBoundary, resolveHostMode, resolveNonEmptyActor } from '../../lib/harness-context.mjs'
import { hasExploredEvidence, rememberPreviousImplementer, verifyPlanningProvenance } from '../../lib/ledger.mjs'
import {
  loadForgeHooksConfig, resolveStageHookCommands, scanExtensionSlotHazards,
} from '../../lib/overlay.mjs'
import { readDecisions } from '../../lib/profile.mjs'
import { CODE_EXT_RE, TEST_FILE_RE } from '../../lib/static-gates.mjs'
import { checkTddSyncParity } from '../../lib/tdd-parity.mjs'
import { validateFeatureMapTopology } from '../../lib/feature-map-graph.mjs'
import { FEATURE_MAP_REL, readFeatureMapSafe } from '../../lib/test-inventory.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'

const NON_IMPL_ROLE_RE = /(?:^|[-_.])(?:coordinator|orchestrator|dispatcher|reviewer|critic)(?:$|[-_.])/i

/** 强制校验 submit/lifecycle 的 `--agent` 权属与认领者匹配，禁止协调者/审查者代提交。 */
export function assertSubmitOwnership(ledger, opts = {}, { mainRoot = null, docRoot = null } = {}) {
  const rawExplicitAgent = String(opts.agent ?? '').trim()
  const hostMode = resolveHostMode(opts)
  const humanApproved = Boolean(opts['human-approved'])
  const checkProvenanceForSubmit = (actorToCheck) => {
    const rootForMain = mainRoot ?? opts._mainRoot ?? null
    if (!rootForMain) return null
    const docRels = [ledger?.specFile, ledger?.archivedSpecFile, ledger?.todoFile, ledger?.archivedTodoFile, ledger?.prdFile, ledger?.archivedPrdFile].filter(Boolean)
    if (docRels.length === 0) return null
    const rootForDocs = docRoot ?? opts._implRoot ?? rootForMain
    const effDocRoot = docRels.some((r) => existsSync(resolve(rootForDocs, r))) ? rootForDocs : rootForMain
    const provRes = verifyPlanningProvenance({
      mainRoot: rootForMain,
      docRoot: effDocRoot,
      docRels,
      taskId: ledger?.taskId ?? null,
      ledger,
      implementerId: actorToCheck,
      hostMode,
      humanApproved,
      isGit: existsSync(resolve(rootForMain, '.git')),
    })
    return provRes.blocked
      ? { ok: false, code: provRes.code, exitCode: provRes.exitCode ?? EXIT.FACT, message: provRes.reason }
      : null
  }
  if (!rawExplicitAgent || /^(?:null|undefined|unknown|none|<[^>]+>)$/i.test(rawExplicitAgent)) {
    if (opts.requireAgent === false) {
      const provErr = checkProvenanceForSubmit(null)
      return provErr ?? { ok: true }
    }
    const waived = resolveNonEmptyActor([], { role: 'submit', hostMode, humanApproved, allowSingleSessionWaive: true })
    if (waived.ok) {
      const provErr = checkProvenanceForSubmit(waived.actor)
      return provErr ?? { ok: true, waived: true, actor: waived.actor }
    }
    return {
      ok: false,
      code: 'BLOCKED_MISSING_ACTOR',
      exitCode: EXIT.USAGE,
      message: 'BLOCKED_MISSING_ACTOR: submit 必须显式传入非空 --agent <实施代理名>（禁止为空、null 或占位词）；仅 single-session 模式下可附 --host-mode single-session --human-approved。',
    }
  }
  const lowExplicit = rawExplicitAgent.toLowerCase()
  const nonImplRole = NON_IMPL_ROLE_RE.test(lowExplicit)
  if (opts.takeover) {
    if (!String(opts.reason ?? '').trim()) {
      return {
        ok: false,
        code: 'BLOCKED_TAKEOVER_REASON_REQUIRED',
        exitCode: EXIT.FACT,
        message: 'BLOCKED_TAKEOVER_REASON_REQUIRED: --takeover 必须同时传入 --reason "<接管原因>"。',
      }
    }
    if (nonImplRole) {
      return {
        ok: false,
        code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
        exitCode: EXIT.FACT,
        message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 协调者/审查者角色 (${rawExplicitAgent}) 不得借 --takeover 代实施者 submit。`,
      }
    }
    // 覆写之前先记账：历史集合是自审判定的唯一依据，不记就等于没换过人。
    const provErr = checkProvenanceForSubmit(rawExplicitAgent)
    if (provErr) return provErr
    const superseded = rememberPreviousImplementer(ledger, rawExplicitAgent)
    ledger.previousImplementers = superseded
    ledger.agent = rawExplicitAgent
    ledger.implementerId = rawExplicitAgent
    ledger.claimedBy = rawExplicitAgent
    return { ok: true, takenOverBy: rawExplicitAgent, previousImplementers: superseded }
  }
  if (nonImplRole) {
    return {
      ok: false,
      code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
      exitCode: EXIT.FACT,
      message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 协调者/审查者身份 (${rawExplicitAgent}) 禁止代实施者 submit；谁改代码谁认领并负责提交与 PR 评论。`,
    }
  }
  if (ledger.claimedBy && String(ledger.claimedBy).trim()) {
    const claimedNorm = String(ledger.claimedBy).trim().toLowerCase()
    if (lowExplicit !== claimedNorm) {
      return {
        ok: false,
        code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
        exitCode: EXIT.FACT,
        message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 提交者 (${rawExplicitAgent}) 与已认领实施者 (${ledger.claimedBy}) 不一致；请由原实施者提交或带 --takeover --reason "..." 接管。`,
      }
    }
    return { ok: true }
  }
  if (ledger.implementerId && String(ledger.implementerId).trim() && ledger.implementerId !== 'local-agent') {
    const implNorm = String(ledger.implementerId).trim().toLowerCase()
    if (lowExplicit !== implNorm) {
      return {
        ok: false,
        code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
        exitCode: EXIT.FACT,
        message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 提交者 (${rawExplicitAgent}) 与已认领实施者 (${ledger.implementerId}) 不一致；请由原实施者提交或带 --takeover --reason "..." 接管。`,
      }
    }
  }
  const provErr = checkProvenanceForSubmit(rawExplicitAgent)
  if (provErr) return provErr
  return { ok: true }
}

/** 校核任务在 finalize/verify 前的认领与探索前置态（已释放任务硬阻断，其余输出提醒或严格拦截）。 */
export function checkTaskSlotBoundaryOrEmit(mainRoot, implRoot, ledger, opts = {}) {
  if (!ledger || ledger.tier === 1) return { ok: true }
  const slotCheck = enforceSlotBoundary({ mainRoot, implRoot, caseType: ledger.caseType, isDirtyMain: false, commits: ledger.baseSha ? 1 : 0 })
  if (slotCheck.ok) return { ok: true }
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: slotCheck.code, reason: slotCheck.reason }, null, 2)}\n`)
  process.stderr.write(`${slotCheck.code}: ${slotCheck.reason}\n`)
  return { ok: false, exitCode: slotCheck.exitCode }
}

export function checkLifecyclePreconditions(ledger, opts = {}) {
  const warnings = []
  if (!ledger || ledger.role === 'inbound-external-pr') return { ok: true, warnings }
  if (ledger.status === 'released') {
    return {
      ok: false,
      code: 'BLOCKED_NOT_CLAIMED',
      exitCode: EXIT.FACT,
      warnings,
      message: `BLOCKED_NOT_CLAIMED: 任务 ${ledger.taskId} 已释放认领，请先重新执行 flow.mjs claim --task ${ledger.taskId} 再继续。`,
    }
  }
  const ownerCheck = assertSubmitOwnership(ledger, { ...opts, requireAgent: false })
  if (!ownerCheck.ok) return { ...ownerCheck, warnings }
  const caseNum = Number(ledger.caseType ?? 3)
  if (caseNum >= 2 && Boolean(ledger.baseSha) && !ledger.claimedAt) {
    return {
      ok: false,
      code: 'BLOCKED_UNCLAIMED_TASK',
      exitCode: EXIT.FACT,
      warnings,
      message: `BLOCKED_UNCLAIMED_TASK: Case ${caseNum} 任务 ${ledger.taskId} 尚未认领（缺少 claimedAt），请先运行 flow.mjs claim --task ${ledger.taskId}。`,
    }
  }
  if (caseNum >= 3 && !hasExploredEvidence(ledger)) {
    return {
      ok: false,
      code: 'BLOCKED_UNEXPLORED_TASK',
      exitCode: EXIT.FACT,
      warnings,
      message: `BLOCKED_UNEXPLORED_TASK: Case ${caseNum} 任务 ${ledger.taskId} 缺少真实 dev-explore 探索证据，请先运行 flow.mjs explore --task ${ledger.taskId}。`,
    }
  }
  return { ok: true, warnings }
}

/** 读取仓库自定义 `.agents/forge-hooks.json` 配置（无配置返回 null）。 */
export function readForgeHooksConfig(mainRoot, implRoot = null) {
  const loaded = loadForgeHooksConfig(mainRoot, implRoot)
  if (!loaded || !loaded.valid || !loaded.config) return null
  return { path: loaded.path, config: loaded.config }
}

/**
 * 在 finalize / verify 阶段核对 `docs/feature-map.json` 同步：
 * 若目标仓存在 `docs/feature-map.json` 且本次改动新增、删除或重命名了核心源码模块/入口文件
 * （跳过纯文档、测试、常规原地修改与 `--no-tdd` / `no-tdd`），
 * 默认阻断（`BLOCKED_FEATURE_MAP_SYNC`，退出码 1），直至补充或清理对应 feature 条目并随本 PR 同步更新。
 */
export async function checkFeatureMapSyncOnFinalize({ implRoot, mainRoot, ledger, opts = {}, changedEntries = null } = {}) {
  const root = implRoot || mainRoot
  if (!root || opts['no-tdd']) return { ok: true, skipped: true, reason: 'no-tdd-or-no-root' }
  const agentsRoot = existsSync(join(root, 'AGENTS.md')) ? root : mainRoot
  if (agentsRoot && readDecisions(readTextSafe(join(agentsRoot, 'AGENTS.md')) ?? '').has('no-tdd')) {
    return { ok: true, skipped: true, reason: 'no-tdd-decision' }
  }
  const fm = readFeatureMapSafe(root)
  if (!fm.present || !fm.valid) return { ok: true, skipped: true, reason: fm.present ? 'invalid-feature-map' : 'feature-map-absent' }

  let entries = Array.isArray(changedEntries) ? changedEntries : null
  if (!entries) {
    const baseRef = ledger?.baseSha || ledger?.baseBranch || 'HEAD~1'
    const diffRes = await gitDiffNameStatusZ(root, [baseRef, 'HEAD'])
    entries = diffRes?.ok ? (diffRes.entries ?? []) : []
  }
  const normalizedEntries = entries.map((e) => ({
    status: String(e.status ?? '').trim().toUpperCase(),
    file: posixPath(e.file ?? '').replace(/^\.\//, ''),
    oldFile: e.oldFile ? posixPath(e.oldFile).replace(/^\.\//, '') : '',
  })).filter((e) => e.file || e.oldFile)

  const isCoreSource = (f) => Boolean(f) && CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f) && !isToolOwnedPath(f) && !/^docs\//.test(f) && !/^scripts\/dev\//.test(f)
  const featureMapUpdated = normalizedEntries.some((e) => e.file === FEATURE_MAP_REL)
  const addedCoreModules = normalizedEntries
    .filter((e) => e.status.startsWith('A') || e.status.startsWith('R'))
    .map((e) => e.file)
    .filter(isCoreSource)
  const removedCoreModules = normalizedEntries
    .flatMap((e) => {
      if (e.status.startsWith('D')) return [e.file]
      if (e.status.startsWith('R') && e.oldFile && e.oldFile !== e.file) return [e.oldFile]
      return []
    })
    .filter(isCoreSource)

  if (featureMapUpdated || addedCoreModules.length > 0 || removedCoreModules.length > 0) {
    const topo = validateFeatureMapTopology(fm.data)
    if (!topo.ok) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_FEATURE_MAP_TOPOLOGY',
        exitCode: EXIT.FACT,
        topologyErrors: topo.errors,
        cycles: topo.cycles,
        message: `BLOCKED_FEATURE_MAP_TOPOLOGY: ${FEATURE_MAP_REL} 拓扑校验失败：${topo.errors.slice(0, 3).join('；')}`,
      }
    }
  }
  if ((addedCoreModules.length === 0 && removedCoreModules.length === 0) || featureMapUpdated) {
    return { ok: true, featureMapUpdated, addedCoreModules, removedCoreModules, uncovered: [], staleEntries: [] }
  }

  const coveredPaths = new Set()
  for (const feat of fm.features) {
    for (const p of [
      ...(Array.isArray(feat.entrypoints) ? feat.entrypoints : []),
      ...(Array.isArray(feat.modules) ? feat.modules : []),
      ...(Array.isArray(feat.entryFiles) ? feat.entryFiles : []),
      ...(Array.isArray(feat.files) ? feat.files : []),
      ...(Array.isArray(feat.paths) ? feat.paths : []),
      ...(feat.entry ? [feat.entry] : []),
    ]) {
      const clean = posixPath(p).replace(/^\.\//, '').replace(/\/+$/, '')
      if (clean) coveredPaths.add(clean)
    }
  }
  const uncovered = addedCoreModules.filter((mod) => ![...coveredPaths].some((cp) => mod === cp || mod.startsWith(`${cp}/`)))
  const staleEntries = removedCoreModules.filter((mod) => coveredPaths.has(mod) && !existsSync(join(root, mod)))
  if (uncovered.length === 0 && staleEntries.length === 0) {
    return { ok: true, featureMapUpdated: false, addedCoreModules, removedCoreModules, uncovered: [], staleEntries: [] }
  }

  const parts = []
  if (uncovered.length > 0) parts.push(`新增未覆盖核心模块 ${uncovered.slice(0, 6).join(', ')}`)
  if (staleEntries.length > 0) parts.push(`已删除或重命名的失效路径仍残留在 feature-map 中 ${staleEntries.slice(0, 6).join(', ')}`)
  const msg = `${FEATURE_MAP_REL} 未同步更新（${parts.join('；')}）；请补充或清理对应 feature 条目并随本 PR 同步提交。`
  if (ledger) {
    ledger.hooks = {
      ...(ledger.hooks ?? {}),
      featureMapSyncMissing: uncovered,
      featureMapStaleEntries: staleEntries,
    }
  }
  return {
    ok: false,
    blocked: true,
    code: 'BLOCKED_FEATURE_MAP_SYNC',
    exitCode: EXIT.ACTION,
    uncovered,
    staleEntries,
    message: `BLOCKED_FEATURE_MAP_SYNC: ${msg}`,
  }
}

/**
 * Case 2 结构漂移守卫：常规原地修复（仅 M 或测试改动）零触发；
 * 若 Case 2 任务实际新增/删除/重命名了非测试核心源码模块，则复用 `checkTddSyncParity` 与 `checkFeatureMapSyncOnFinalize` 阻断漂移。
 */
export async function checkCase2StructuralDriftOnVerify({
  mainRoot, implRoot, ledger, opts = {}, effectiveBase = null, changedFiles = [], statusEntries = [], diffText = undefined,
} = {}) {
  if (!ledger || Number(ledger.caseType) !== 2) return { ok: true, skipped: true }
  const root = implRoot || mainRoot
  if (!root || opts['no-tdd']) return { ok: true, skipped: true }
  const agentsRoot = existsSync(join(root, 'AGENTS.md')) ? root : mainRoot
  const decisions = agentsRoot ? readDecisions(readTextSafe(join(agentsRoot, 'AGENTS.md')) ?? '') : new Set()
  if (decisions.has('no-tdd')) return { ok: true, skipped: true }

  const baseRef = effectiveBase || ledger?.baseSha || ledger?.baseBranch || 'HEAD~1'
  const diffRes = await gitDiffNameStatusZ(root, [baseRef, 'HEAD'])
  const committed = diffRes?.ok ? (diffRes.entries ?? []) : []
  const dirtyEntries = (Array.isArray(statusEntries) ? statusEntries : [])
    .map((e) => ({ status: String(e.xy ?? '').trim(), file: e.file, oldFile: e.oldFile }))
    .filter((e) => /^(?:A|\?\?|D|R)/.test(e.status) || /[ADR]/.test(e.status))
  const allEntries = [...committed, ...dirtyEntries]
  const isCoreSource = (f) => Boolean(f) && CODE_EXT_RE.test(posixPath(f)) && !TEST_FILE_RE.test(posixPath(f)) && !isToolOwnedPath(posixPath(f)) && !/^(?:docs|scripts\/dev)\//.test(posixPath(f))
  const hasStructuralCoreChange = allEntries.some((e) => {
    const st = String(e.status ?? '').trim().toUpperCase()
    if (!(st.startsWith('A') || st.startsWith('D') || st.startsWith('R') || st === '??')) return false
    return isCoreSource(e.file) || isCoreSource(e.oldFile)
  })
  const touchedFeatureMap = [
    ...committed,
    ...(Array.isArray(statusEntries) ? statusEntries : []),
    ...(Array.isArray(changedFiles) ? changedFiles.map((f) => ({ file: f })) : []),
  ].some((e) => posixPath(e.file ?? '').replace(/^\.\//, '') === FEATURE_MAP_REL)
  if (!hasStructuralCoreChange && !touchedFeatureMap) return { ok: true, skipped: true, reason: 'no-core-structural-change' }
  if (!hasStructuralCoreChange && touchedFeatureMap) {
    const fm = readFeatureMapSafe(root)
    if (fm.present && fm.valid) {
      const topo = validateFeatureMapTopology(fm.data)
      if (!topo.ok) {
        return {
          ok: false,
          blocked: true,
          code: 'BLOCKED_FEATURE_MAP_TOPOLOGY',
          exitCode: EXIT.FACT,
          topologyErrors: topo.errors,
          cycles: topo.cycles,
          message: `BLOCKED_FEATURE_MAP_TOPOLOGY: ${FEATURE_MAP_REL} 拓扑校验失败：${topo.errors.slice(0, 3).join('；')}`,
        }
      }
    }
    return { ok: true, skipped: true, reason: 'feature-map-topology-ok' }
  }

  const fmCheck = await checkFeatureMapSyncOnFinalize({ implRoot: root, mainRoot, ledger, opts, changedEntries: allEntries })
  if (!fmCheck.ok) return fmCheck

  const parity = await checkTddSyncParity(root, changedFiles, ledger, { statusEntries, diffEntries: allEntries, diffText })
  if (parity.tddSyncWarning) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_TDD_SYNC',
      exitCode: EXIT.ACTION,
      parity,
      message: `BLOCKED_TDD_SYNC: Case 2 任务新增/删除/重命名核心源码模块但未同步权威架构文档：${parity.tddSyncWarning}`,
    }
  }
  return { ok: true }
}

function resolveSkillScript(mainRoot, implRoot, relPath) {
  for (const root of [implRoot, mainRoot].filter(Boolean)) {
    const abs = resolve(root, relPath)
    if (existsSync(abs)) return abs
  }
  return null
}

/**
 * `verify` 前置条件钩子：按需探测 `.agents/skills/dev-edit/scripts/edit-gate.mjs` 并执行。
 * 未落盘时静默优雅跳过；传入 `--skip-edit-gate` 时跳过并在账本 `hooks` 留痕。
 */
export async function runPreVerifyEditGateHook({ mainRoot, implRoot, taskId, ledger, opts = {} } = {}) {
  const now = new Date().toISOString()
  if (opts['skip-edit-gate']) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_SKIP_EDIT_GATE_FORBIDDEN_ON_FINAL',
      exitCode: EXIT.FACT,
      message: 'BLOCKED_SKIP_EDIT_GATE_FORBIDDEN_ON_FINAL: verify 收口编辑门禁（--final）严禁传入 --skip-edit-gate 跳过。',
    }
  }
  const hookCfg = readForgeHooksConfig(mainRoot, implRoot)
  if (hookCfg?.config?.editGate === false || hookCfg?.config?.hooks?.editGate?.enabled === false) {
    return { ok: true, skipped: true, reason: 'disabled-by-forge-hooks' }
  }
  const scriptPath = resolveSkillScript(mainRoot, implRoot, '.agents/skills/dev-edit/scripts/edit-gate.mjs')
  if (!scriptPath) {
    return { ok: true, skipped: true, reason: 'dev-edit-not-installed' }
  }
  const res = await execSafe(process.execPath, [scriptPath, '--task', String(taskId), '--final', '--json'], {
    cwd: implRoot || mainRoot,
    timeout: 60000,
  })
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 400)
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_EDIT_GATE_FAILED',
      exitCode: EXIT.FACT,
      scriptPath,
      message: `BLOCKED_EDIT_GATE_FAILED: dev-edit 前置编辑门禁未通过（exit=${res.code}）：${detail || 'see edit-gate output'}`,
    }
  }
  if (ledger) {
    ledger.hooks = { ...(ledger.hooks ?? {}), editGatePassedAt: now }
  }
  return { ok: true, executed: true, scriptPath }
}

/**
 * `finalize` / `verify` / `merge` / `cleanup` 条件治理钩子分发器：
 * 支持 `--skip-govern` 记账，在 `finalize` 同步核对 `docs/feature-map.json`，
 * 并按 `.agents/forge-hooks.json` 触发声明式自定义钩子或轻量治理检查/复盘。
 */
export async function checkArchitectureMapSyncOnVerify({ implRoot, mainRoot, ledger, changedFiles = null } = {}) {
  const root = implRoot || mainRoot
  if (!root || !existsSync(join(root, FEATURE_MAP_REL))) return { ok: true, skipped: true, reason: 'feature-map-absent' }
  if (isArchitectureMapOptedOut(root)) return { ok: true, skipped: true, reason: 'opted-out' }
  let touched = Array.isArray(changedFiles) ? changedFiles.map((f) => posixPath(f).replace(/^\.\//, '')) : null
  if (!touched) {
    const baseRef = ledger?.baseSha || ledger?.baseBranch || 'HEAD~1'
    const diffRes = await gitDiffNameStatusZ(root, [baseRef, 'HEAD'])
    const statusEntries = (await gitStatusPorcelainZ(root))?.entries ?? []
    touched = [
      ...(diffRes?.ok ? (diffRes.entries ?? []).map((e) => posixPath(e.file)) : []),
      ...statusEntries.map((e) => posixPath(e.file)),
    ]
  }
  const hasHtml = existsSync(join(root, ARCHITECTURE_MAP_REL))
  const touchesMapFiles = touched.includes(FEATURE_MAP_REL) || touched.includes(ARCHITECTURE_MAP_REL)
  if (!hasHtml && !touchesMapFiles) {
    return { ok: true, skipped: true, reason: 'architecture-map-not-activated' }
  }
  const syncRes = verifyArchitectureMapSync(root)
  if (!syncRes.ok) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_ARCHITECTURE_MAP_DRIFT',
      exitCode: EXIT.FACT,
      message: `${syncRes.message}. Run \`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs render\` to regenerate ${ARCHITECTURE_MAP_REL}.`,
      relPath: ARCHITECTURE_MAP_REL,
    }
  }
  return { ok: true, skipped: false, relPath: ARCHITECTURE_MAP_REL }
}

export async function runLifecycleGovernHook({ stage, mainRoot, implRoot, taskId, ledger, opts = {} } = {}) {
  const now = new Date().toISOString()
  if (stage === 'finalize') {
    const fmCheck = await checkFeatureMapSyncOnFinalize({ implRoot, mainRoot, ledger, opts })
    if (!fmCheck.ok) return fmCheck
    if (fmCheck.warning && !opts.json) process.stderr.write(`${fmCheck.warning}\n`)
  }
  if (stage === 'verify') {
    const archCheck = await checkArchitectureMapSyncOnVerify({ implRoot, mainRoot, ledger })
    if (!archCheck.ok) return archCheck
  }
  const hookCfg = readForgeHooksConfig(mainRoot, implRoot)
  const customCommands = hookCfg ? resolveStageHookCommands(hookCfg.config, stage) : []
  const customResults = []
  for (const item of customCommands) {
    const hazards = scanExtensionSlotHazards('.agents/forge-hooks.json', item.command)
    if (hazards.length > 0) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_UNSAFE_FORGE_HOOK',
        exitCode: EXIT.FACT,
        stage,
        hazards,
        message: `BLOCKED_UNSAFE_FORGE_HOOK (${stage}): .agents/forge-hooks.json 命中高危命令模式（${hazards.map((h) => h.ruleId).join(', ')}）`,
      }
    }
    const cmdRes = await execShellCommand(item.command, implRoot || mainRoot, { timeout: 45000 })
    customResults.push({ stageKey: item.stageKey, command: item.command, ok: cmdRes.ok, exitCode: cmdRes.code ?? (cmdRes.ok ? 0 : 1) })
    if (!cmdRes.ok && item.strict) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_FORGE_HOOK_FAILED',
        exitCode: EXIT.FACT,
        stage,
        customResults,
        message: `BLOCKED_FORGE_HOOK_FAILED (${item.stageKey}): ${(cmdRes.stderr || cmdRes.stdout || 'non-zero exit').trim().slice(0, 300)}`,
      }
    }
  }
  if (ledger && customResults.length > 0) {
    ledger.hooks = { ...(ledger.hooks ?? {}), [`custom_${stage}_at`]: now, [`custom_${stage}_ok`]: customResults.every((r) => r.ok) }
  }

  if (opts['skip-govern']) {
    // 跳过治理巡检同样是放行点，理由的标准与改码门禁那处一致。
    const reasonCheck = evaluateReleaseReason(opts.reason, { subject: '跳过治理巡检的理由' })
    if (!reasonCheck.ok) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_SHALLOW_OVERRIDE_REASON',
        exitCode: EXIT.USAGE,
        stage,
        message: `BLOCKED_SHALLOW_OVERRIDE_REASON: ${reasonCheck.reason} 跳过治理巡检必须写清：这次为什么不跑它、可能漏掉什么。`,
        ...(customResults.length ? { customResults } : {}),
      }
    }
    if (ledger) {
      ledger.hooks = {
        ...(ledger.hooks ?? {}),
        governSkippedStage: stage,
        governSkippedAt: now,
        governSkipReason: reasonCheck.cleaned,
      }
    }
    return { ok: true, skipped: true, stage, reason: 'skip-govern-flag', skipReason: reasonCheck.cleaned, ...(customResults.length ? { customResults } : {}) }
  }
  const stageCfg = hookCfg?.config?.hooks?.[stage] ?? hookCfg?.config?.[stage] ?? null
  if (stageCfg === false || stageCfg?.enabled === false || hookCfg?.config?.govern === false) {
    return { ok: true, skipped: true, stage, reason: 'disabled-by-forge-hooks', ...(customResults.length ? { customResults } : {}) }
  }
  const governEnabled = stageCfg?.govern !== false && opts['run-govern-hook'] !== false
  if (!governEnabled) {
    return { ok: true, skipped: true, stage, reason: 'disabled-by-stage-cfg', ...(customResults.length ? { customResults } : {}) }
  }
  const isRetroStage = stage === 'merge' || stage === 'cleanup'
  const relScript = isRetroStage
    ? '.agents/skills/dev-govern/scripts/govern-retro.mjs'
    : '.agents/skills/dev-govern/scripts/govern-audit.mjs'
  const scriptPath = resolveSkillScript(mainRoot, implRoot, relScript)
  if (!scriptPath) {
    return { ok: true, skipped: true, stage, reason: 'dev-govern-script-absent', ...(customResults.length ? { customResults } : {}) }
  }
  const args = isRetroStage
    ? ['summary', '--task', String(taskId), '--json']
    : ['audit', '--changed', '--json']
  const res = await execSafe(process.execPath, [scriptPath, ...args], {
    cwd: implRoot || mainRoot,
    timeout: 45000,
  })
  const strict = Boolean(stageCfg?.strict || opts['strict-lifecycle'])
  if (!res.ok && strict) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_GOVERN_HOOK_FAILED',
      exitCode: EXIT.FACT,
      stage,
      message: `BLOCKED_GOVERN_HOOK_FAILED (${stage}): ${(res.stderr || res.stdout || '').trim().slice(0, 300)}`,
    }
  }
  if (ledger) {
    ledger.hooks = { ...(ledger.hooks ?? {}), [`govern_${stage}_at`]: now, [`govern_${stage}_ok`]: res.ok }
  }
  return { ok: true, executed: true, stage, hookOk: res.ok, scriptPath, ...(customResults.length ? { customResults } : {}) }
}
