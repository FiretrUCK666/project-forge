/**
 * flow-lifecycle-hooks.mjs —— 实施权属校验、条件钩子分发器（dev-edit / dev-govern / forge-hooks.json）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），支持按需探测已装配技能并优雅跳过未落盘钩子。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { execSafe, execShellCommand, gitDiffNameStatusZ, posixPath, readTextSafe } from '../../lib/git.mjs'
import { hasExploredEvidence } from '../../lib/ledger.mjs'
import {
  loadForgeHooksConfig, resolveStageHookCommands, scanExtensionSlotHazards,
} from '../../lib/overlay.mjs'
import { isInternalAgentSlug, resolveContributorIdentity } from '../../lib/platform.mjs'
import { readDecisions } from '../../lib/profile.mjs'
import { CODE_EXT_RE, TEST_FILE_RE } from '../../lib/static-gates.mjs'
import { FEATURE_MAP_REL, readFeatureMapSafe } from '../../lib/test-inventory.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'

const NON_IMPL_ROLE_RE = /(?:^|[-_.])(?:coordinator|orchestrator|dispatcher|reviewer|critic)(?:$|[-_.])/i

/** 强制校验 submit/lifecycle 的 `--agent` 权属与认领者匹配，禁止协调者/审查者代提交。 */
export function assertSubmitOwnership(ledger, opts = {}) {
  const rawExplicitAgent = String(opts.agent ?? '').trim()
  if (!rawExplicitAgent) return { ok: true }
  const lowExplicit = rawExplicitAgent.toLowerCase()
  const nonImplRole = NON_IMPL_ROLE_RE.test(lowExplicit)
  if (opts.takeover) {
    if (!String(opts.reason ?? '').trim()) {
      return {
        ok: false,
        code: 'BLOCKED_TAKEOVER_REASON_REQUIRED',
        exitCode: 3,
        message: 'BLOCKED_TAKEOVER_REASON_REQUIRED: --takeover 必须同时传入 --reason "<接管原因>"。',
      }
    }
    if (nonImplRole) {
      return {
        ok: false,
        code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
        exitCode: 3,
        message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 协调者/审查者角色 (${rawExplicitAgent}) 不得借 --takeover 代实施者 submit。`,
      }
    }
    const nextContrib = resolveContributorIdentity({ explicitActor: rawExplicitAgent, ledgerActor: ledger.implementerId })
    ledger.implementerId = nextContrib.actor
    ledger.claimedBy = rawExplicitAgent
    return { ok: true, takenOverBy: nextContrib.actor }
  }
  if (nonImplRole) {
    return {
      ok: false,
      code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
      exitCode: 3,
      message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 协调者/审查者身份 (${rawExplicitAgent}) 禁止代实施者 submit；谁改代码谁认领并负责提交与 PR 评论。`,
    }
  }
  if (ledger.claimedBy && String(ledger.claimedBy).trim()) {
    const claimedNorm = String(ledger.claimedBy).trim().toLowerCase()
    const explicitResolved = resolveContributorIdentity({ explicitActor: rawExplicitAgent, ledgerActor: ledger.implementerId })
    if (lowExplicit !== claimedNorm && explicitResolved.actor.toLowerCase() !== claimedNorm) {
      return {
        ok: false,
        code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
        exitCode: 3,
        message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 提交者 (${rawExplicitAgent}) 与已认领实施者 (${ledger.claimedBy}) 不一致；请由原实施者提交或带 --takeover --reason "..." 接管。`,
      }
    }
    return { ok: true }
  }
  if (ledger.implementerId && !isInternalAgentSlug(ledger.implementerId)) {
    const resolvedExplicit = resolveContributorIdentity({ explicitActor: rawExplicitAgent, ledgerActor: ledger.implementerId })
    if (resolvedExplicit.actor.toLowerCase() !== String(ledger.implementerId).toLowerCase()) {
      return {
        ok: false,
        code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
        exitCode: 3,
        message: `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 提交者 (${resolvedExplicit.actor}) 与已认领实施者 (${ledger.implementerId}) 不一致；请由原实施者提交或带 --takeover --reason "..." 接管。`,
      }
    }
  }
  return { ok: true }
}

/** 校核任务在 finalize/verify 前的认领与探索前置态（已释放任务硬阻断，其余输出提醒或严格拦截）。 */
export function checkLifecyclePreconditions(ledger, opts = {}) {
  const warnings = []
  if (!ledger || ledger.role === 'inbound-external-pr') return { ok: true, warnings }
  if (ledger.status === 'released') {
    return {
      ok: false,
      code: 'BLOCKED_NOT_CLAIMED',
      exitCode: 3,
      warnings,
      message: `BLOCKED_NOT_CLAIMED: 任务 ${ledger.taskId} 已释放认领，请先重新执行 flow.mjs claim --task ${ledger.taskId} 再继续。`,
    }
  }
  const ownerCheck = assertSubmitOwnership(ledger, opts)
  if (!ownerCheck.ok) return { ...ownerCheck, warnings }
  if (!ledger.claimedAt) {
    warnings.push({
      code: 'WARN_NOT_CLAIMED',
      message: `任务 ${ledger.taskId} 尚未记录 claimedAt，建议先运行 flow.mjs claim --task ${ledger.taskId}。`,
    })
  }
  if (!hasExploredEvidence(ledger)) {
    warnings.push({
      code: 'WARN_NOT_EXPLORED',
      message: `任务 ${ledger.taskId} 尚未记录 explored 探索证据，合并前需运行 flow.mjs explore --task ${ledger.taskId}。`,
    })
  }
  if (opts['strict-lifecycle'] && warnings.length > 0) {
    const first = warnings[0]
    const code = first.code === 'WARN_NOT_CLAIMED' ? 'BLOCKED_NOT_CLAIMED' : 'BLOCKED_NOT_EXPLORED'
    return { ok: false, code, exitCode: 3, warnings, message: `${code}: ${first.message}` }
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
 * 在 finalize 阶段核对 `docs/feature-map.json` 同步：
 * 若目标仓存在 `docs/feature-map.json` 且本次改动新增了核心源码模块/入口文件（跳过纯文档、测试与 `--no-tdd`），
 * 检查新模块是否已覆盖或随本 PR 更新；缺同步时输出提醒，在 `--strict-sync` / `strict` 模式下阻断。
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
  })).filter((e) => e.file)

  const featureMapUpdated = normalizedEntries.some((e) => e.file === FEATURE_MAP_REL)
  const addedCoreModules = normalizedEntries
    .filter((e) => e.status.startsWith('A') || e.status.startsWith('R'))
    .map((e) => e.file)
    .filter((f) => CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f) && !isToolOwnedPath(f) && !/^docs\//.test(f) && !/^scripts\/dev\//.test(f))

  if (addedCoreModules.length === 0 || featureMapUpdated) {
    return { ok: true, featureMapUpdated, addedCoreModules, uncovered: [] }
  }

  const coveredPaths = new Set()
  for (const feat of fm.features) {
    for (const p of [
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
  if (uncovered.length === 0) return { ok: true, featureMapUpdated: false, addedCoreModules, uncovered: [] }

  const msg = `新增核心源码模块/入口未同步更新 ${FEATURE_MAP_REL}：${uncovered.slice(0, 6).join(', ')}；请补充对应 feature 条目或随本 PR 同步刷新。`
  if (ledger) {
    ledger.hooks = { ...(ledger.hooks ?? {}), featureMapSyncMissing: uncovered }
  }
  if (opts['strict-sync']) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_FEATURE_MAP_SYNC',
      exitCode: 1,
      uncovered,
      message: `BLOCKED_FEATURE_MAP_SYNC: ${msg}`,
    }
  }
  return { ok: true, warning: `[FEATURE-MAP SYNC REMINDER]: ${msg}`, uncovered }
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
    if (ledger) {
      ledger.hooks = {
        ...(ledger.hooks ?? {}),
        editGateSkippedAt: now,
        editGateSkipReason: String(opts.reason ?? 'explicit-skip-edit-gate').trim() || 'explicit-skip-edit-gate',
      }
    }
    return { ok: true, skipped: true, reason: 'skip-edit-gate-flag' }
  }
  const hookCfg = readForgeHooksConfig(mainRoot, implRoot)
  if (hookCfg?.config?.editGate === false || hookCfg?.config?.hooks?.editGate?.enabled === false) {
    return { ok: true, skipped: true, reason: 'disabled-by-forge-hooks' }
  }
  const scriptPath = resolveSkillScript(mainRoot, implRoot, '.agents/skills/dev-edit/scripts/edit-gate.mjs')
  if (!scriptPath) {
    return { ok: true, skipped: true, reason: 'dev-edit-not-installed' }
  }
  const res = await execSafe(process.execPath, [scriptPath, '--task', String(taskId), '--json'], {
    cwd: implRoot || mainRoot,
    timeout: 60000,
  })
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 400)
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_EDIT_GATE_FAILED',
      exitCode: 3,
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
export async function runLifecycleGovernHook({ stage, mainRoot, implRoot, taskId, ledger, opts = {} } = {}) {
  const now = new Date().toISOString()
  if (stage === 'finalize') {
    const fmCheck = await checkFeatureMapSyncOnFinalize({ implRoot, mainRoot, ledger, opts })
    if (!fmCheck.ok) return fmCheck
    if (fmCheck.warning && !opts.json) process.stderr.write(`${fmCheck.warning}\n`)
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
        exitCode: 3,
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
        exitCode: 3,
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
    if (ledger) {
      ledger.hooks = {
        ...(ledger.hooks ?? {}),
        governSkippedStage: stage,
        governSkippedAt: now,
        governSkipReason: String(opts.reason ?? 'explicit-skip-govern').trim() || 'explicit-skip-govern',
      }
    }
    return { ok: true, skipped: true, stage, reason: 'skip-govern-flag', ...(customResults.length ? { customResults } : {}) }
  }
  const stageCfg = hookCfg?.config?.hooks?.[stage] ?? hookCfg?.config?.[stage] ?? null
  if (stageCfg === false || stageCfg?.enabled === false || hookCfg?.config?.govern === false) {
    return { ok: true, skipped: true, stage, reason: 'disabled-by-forge-hooks', ...(customResults.length ? { customResults } : {}) }
  }
  const governEnabled = Boolean(stageCfg?.govern === true || stageCfg?.enabled === true || opts['run-govern-hook'])
  if (!governEnabled) {
    return { ok: true, skipped: true, stage, reason: 'opt-in-not-configured', ...(customResults.length ? { customResults } : {}) }
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
  const strict = Boolean(stageCfg?.strict)
  if (!res.ok && strict) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_GOVERN_HOOK_FAILED',
      exitCode: 3,
      stage,
      message: `BLOCKED_GOVERN_HOOK_FAILED (${stage}): ${(res.stderr || res.stdout || '').trim().slice(0, 300)}`,
    }
  }
  if (ledger) {
    ledger.hooks = { ...(ledger.hooks ?? {}), [`govern_${stage}_at`]: now, [`govern_${stage}_ok`]: res.ok }
  }
  return { ok: true, executed: true, stage, hookOk: res.ok, scriptPath, ...(customResults.length ? { customResults } : {}) }
}
