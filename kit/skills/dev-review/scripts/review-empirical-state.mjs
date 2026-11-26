/**
 * review-empirical-state.mjs -- Fingerprint, receipt storage, status filtering,
 * untrusted pre-exec guard, and Tier 2 pre-sync dirty-residue checks for `review-empirical.mjs`.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { escalateToBackend } from '../../lib/escalation.mjs'
import { evaluateReleaseReason } from '../../lib/evidence-substance.mjs'
import { artifactPathsOf, evaluateObservationSubstance, validateArtifactsAndVisual } from '../../lib/empirical-artifacts.mjs'
import {
  canonicalPath, execShellCommand, gitStatusPorcelainZ, isInsideDir,
  posixPath, readJsonSafe, samePath, sha256File, sha256Text, writeJsonAtomic,
} from '../../lib/git.mjs'
import { nextReviewRound, sanitizeTaskId } from '../../lib/ledger.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { buildE2eDiagnosticPacket, scoreExecutionResult, validateE2eEvidenceText } from '../../lib/workflow-policy.mjs'
import { EXIT } from './review-diff.mjs'

export function sanitizeCmdTemplate(rawCmd) {
  return String(rawCmd ?? '')
    .replace(/\s*(?:--[A-Za-z0-9_-]+(?:=|\s+)|-[A-Za-z]\s+)?\{target\}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function collectDevProfileEmpiricalCmds(devProfile = {}, { scopedGate = null } = {}) {
  const auto = []
  for (const key of ['quick-test', 'smoke-verify', 'full-test']) {
    for (const raw of devProfile[key] ?? []) {
      const clean = sanitizeCmdTemplate(raw)
      if (clean && !auto.includes(clean)) auto.push(clean)
    }
  }
  const mergeCmds = []
  for (const raw of devProfile['merge-gate'] ?? []) {
    const clean = sanitizeCmdTemplate(raw)
    if (clean && !mergeCmds.includes(clean)) mergeCmds.push(clean)
  }
  const rawEffective = auto.length > 0 ? auto : mergeCmds
  const rawAll = [...new Set([...rawEffective, ...mergeCmds])]
  if (scopedGate?.scoped && typeof scopedGate.filterCommands === 'function') {
    const filteredEffective = scopedGate.filterCommands(rawEffective)
    const filteredAll = scopedGate.filterCommands(rawAll)
    return {
      autoCommands: filteredEffective.kept,
      hasDevProfileTestCmds: filteredAll.kept.length > 0,
      skippedCommands: filteredAll.skipped,
      scopedGate,
    }
  }
  return { autoCommands: rawEffective, hasDevProfileTestCmds: rawAll.length > 0, skippedCommands: [], scopedGate: null }
}

/**
 * 提取并校验 `--e2e-evidence` / `--visual-evidence` 输入，拦截无实质水话。
 * 裸 `--visual-checked` 不在本函数里合成任何观察文本：只声明「我核验过」不构成证据，
 * 界面资源改动是否有实证由 `resolveArtifactAndVisualInput` 判定。
 */
export function resolveAndValidateE2eEvidenceInput(opts = {}) {
  const explicitRaw = (typeof opts['e2e-evidence'] === 'string' && opts['e2e-evidence'].trim())
    || (typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim())
    || ''
  if (!explicitRaw) return { ok: true, explicit: false, raw: '', text: '', code: null, reason: null }
  const check = validateE2eEvidenceText(explicitRaw)
  if (!check.ok) {
    return { ok: false, explicit: true, raw: explicitRaw, text: '', code: check.code, reason: check.reason }
  }
  return { ok: true, explicit: true, raw: explicitRaw, text: check.cleaned, code: null, reason: null }
}

/**
 * 汇总审查侧的实证附件与界面核验结论：附件必须是真实非空常规文件，观察必须有实质内容。
 * 变更未触及界面资源时不触发界面判据，只需附件本身合法。
 */
export function resolveArtifactAndVisualInput(opts = {}, { repoRoot = null, visualFilesChanged = [] } = {}) {
  return validateArtifactsAndVisual({
    repoRoot,
    artifacts: artifactPathsOf(opts),
    visualFilesChanged,
    visualCheckedRaw: Boolean(opts['visual-checked']),
    observationSummary: String(opts['e2e-evidence'] ?? opts['visual-evidence'] ?? '').trim(),
    visualBlockedReason: String(opts['visual-blocked-reason'] ?? '').trim(),
  })
}

/**
 * 归一化记录审查结论时要落账的运行观察与环境阻塞说明。
 *
 * 两处输入走同一套实质判据：`--e2e-evidence` 与 `--visual-blocked-reason` 都不是自由文本，
 * 写「ok」「lgtm」占位等于没写。校验不过就带着结构化原因返回，由调用方阻断。
 */
export function resolveReviewObservationInputs(opts = {}) {
  const rawObs = String(opts['e2e-evidence'] ?? opts['visual-evidence'] ?? '').trim()
  const rawBlocked = String(opts['visual-blocked-reason'] ?? '').trim()
  let e2eText = ''
  if (rawObs) {
    const check = evaluateObservationSubstance(rawObs)
    if (!check.ok) return { ok: false, code: check.code, reason: check.reason, field: 'e2e-evidence', e2eText: '', blockedReasonText: '' }
    e2eText = check.text
  }
  let blockedReasonText = ''
  if (rawBlocked) {
    const check = evaluateObservationSubstance(rawBlocked)
    if (!check.ok) {
      return {
        ok: false,
        code: check.code,
        reason: `环境阻塞说明必须写清这台机器为什么渲染不了，而不是一句话占位。${check.reason}`,
        field: 'visual-blocked-reason',
        e2eText,
        blockedReasonText: '',
      }
    }
    blockedReasonText = check.text
  }
  return { ok: true, code: null, reason: null, field: null, e2eText, blockedReasonText }
}

async function loadOutboundLinks(reviewRoot) {
  const hereDir = dirname(fileURLToPath(import.meta.url))
  const depsScript = join(hereDir, '..', '..', 'dev-flow', 'scripts', 'worktree-deps.mjs')
  if (existsSync(depsScript)) {
    try {
      const mod = await import(pathToFileURL(depsScript).href)
      if (typeof mod.scanOutboundLinks === 'function') {
        const res = mod.scanOutboundLinks(reviewRoot)
        return new Set((res?.outbound ?? []).map((item) => posixPath(item.path)))
      }
    } catch { /* fallback to direct lstat probe */ }
  }
  return new Set()
}

function isOutboundSymlinkEntry(reviewRoot, relFile, outboundSet) {
  const norm = posixPath(relFile).replace(/\/+$/, '')
  if (!norm) return false
  for (const linkPath of outboundSet) {
    if (norm === linkPath || norm.startsWith(`${linkPath}/`)) return true
  }
  const abs = join(reviewRoot, norm)
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) {
      const targetReal = realpathSync.native(abs)
      if (!isInsideDir(targetReal, reviewRoot)) return true
    }
  } catch { /* ignore */ }
  return false
}

/** 获取工作区脏状态列表（自动排除挂载的外部共享依赖链接与主仓 .worktrees 目录）。 */
export async function getEffectiveStatusEntries(reviewRoot, mainRoot = reviewRoot) {
  const st = await gitStatusPorcelainZ(reviewRoot)
  if (!st.ok) {
    throw new Error(`读取工作区状态失败（${reviewRoot}）：${st.stderr}`)
  }
  if (st.entries.length === 0) return []
  const outboundSet = await loadOutboundLinks(reviewRoot)
  const isMain = mainRoot ? samePath(reviewRoot, mainRoot) : false
  return st.entries.filter((entry) => {
    const f = posixPath(entry.file)
    if (isMain && (f === '.worktrees' || f.startsWith('.worktrees/'))) return false
    if (isOutboundSymlinkEntry(reviewRoot, f, outboundSet)) return false
    return true
  })
}

function hashStatusEntry(reviewRoot, entry) {
  const rel = posixPath(entry.file)
  const abs = join(reviewRoot, rel)
  let contentDigest = 'ABSENT'
  if (entry.status !== 'D') {
    try {
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) {
        let target = ''
        try { target = readlinkSync(abs) } catch { /* ignore */ }
        contentDigest = `SYMLINK:${target}`
      } else if (st.isFile()) {
        contentDigest = sha256File(abs) ?? 'UNREADABLE'
      } else if (st.isDirectory()) {
        contentDigest = 'DIR'
      }
    } catch {
      contentDigest = 'ABSENT'
    }
  } else {
    contentDigest = 'DELETED'
  }
  return {
    xy: entry.xy,
    file: rel,
    oldFile: entry.oldFile ? posixPath(entry.oldFile) : '',
    contentDigest,
  }
}

/** 计算包含 headSha、diff.sha256 与有效脏状态内容哈希的工作区综合指纹。 */
export async function computeWorkspaceFingerprint({ reviewRoot, mainRoot = reviewRoot, headSha, diff, statusEntries }) {
  const entries = Array.isArray(statusEntries)
    ? statusEntries
    : await getEffectiveStatusEntries(reviewRoot, mainRoot)
  const sorted = [...entries]
    .map((e) => hashStatusEntry(reviewRoot, e))
    .sort((a, b) => a.file.localeCompare(b.file) || a.xy.localeCompare(b.xy))
  const payload = {
    headSha: headSha || 'UNBORN',
    diffSha256: diff?.sha256 ?? '',
    entries: sorted,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function computeCleanBaselineFingerprint({ headSha, diff }) {
  const payload = {
    headSha: headSha || 'UNBORN',
    diffSha256: diff?.sha256 ?? '',
    entries: [],
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function resolveEmpiricalReceiptPath({ gitDir, mode, task, prNo, reviewRoot, baseRef }) {
  if (!gitDir) return null
  if (mode === 'task' && task?.taskId) {
    return join(gitDir, 'project-forge-flow', 'tasks', sanitizeTaskId(task.taskId), 'review-empirical.json')
  }
  if (mode === 'pr') {
    const cleanPr = String(prNo ?? task?.prNumber ?? '').replace(/^#/, '').trim()
    return join(gitDir, 'project-forge-flow', 'reviews', `pr-${cleanPr}.json`)
  }
  const keySeed = `${mode}\0${baseRef ?? ''}\0${canonicalPath(reviewRoot)}`
  const scopeKey = `${mode}-${sha256Text(keySeed).slice(0, 12)}`
  return join(gitDir, 'project-forge-flow', 'reviews', `workspace-${scopeKey}.json`)
}

export function readReceipt(receiptPath) {
  if (!receiptPath) return null
  return readJsonSafe(receiptPath) ?? null
}

export function writeReceipt(receiptPath, data) {
  if (!receiptPath) return null
  writeJsonAtomic(receiptPath, { ...data, version: 1, updatedAt: new Date().toISOString() })
  return receiptPath
}

export function isSameScopeContext(receipt, { mode, round, headSha, diffScope }) {
  if (!receipt || receipt.mode !== mode) return false
  if (mode === 'task' && Number(receipt.round) !== Number(round)) return false
  if (receipt.headSha !== headSha) return false
  if (receipt.diffScope !== diffScope) return false
  return true
}

export function hasPendingFaultInReceipt(receipt, { mode, round, headSha, diffScope, currentFingerprint }) {
  if (!receipt?.faultInjectedAndFailed || receipt.faultRestoredClean === true) return false
  if (mode === 'task' || mode === 'pr') {
    if (receipt.headSha !== headSha) return false
    if (mode === 'task' && Number(receipt.round) !== Number(round)) return false
    return true
  }
  return receipt.headSha === headSha
    && receipt.diffScope === diffScope
    && currentFingerprint === receipt.faultInjectedAndFailed.mutatedFingerprint
}

export function buildModeTargetFlags({ mode, task, round, prNo, baseRef, reviewRoot, mainRoot }) {
  if (mode === 'task' && task?.taskId) {
    return `--task ${task.taskId} --round ${round}`
  }
  if (mode === 'pr' && prNo !== undefined && prNo !== null) {
    return `--pr ${prNo}`
  }
  const dirFlag = mainRoot && !samePath(reviewRoot, mainRoot) ? ` --dir "${posixPath(reviewRoot)}"` : ''
  if (mode === 'staged') return `--staged${dirFlag}`
  if (mode === 'base' && baseRef) return `--base ${baseRef}${dirFlag}`
  return `--local${dirFlag}`
}

export function buildUnblockCommands({ missingSteps, dirtyFaultResidue, mode, task, round, prNo, baseRef, reviewRoot, mainRoot, autoCommands, isPureDocsNoneRepo = false }) {
  const targetFlags = buildModeTargetFlags({ mode, task, round, prNo, baseRef, reviewRoot, mainRoot })
  const sampleCmd = autoCommands[0] ?? '<可证伪 C* 的验证命令>'
  const cmdArg = (autoCommands.length > 0 || isPureDocsNoneRepo) ? '' : ` --cmd "${sampleCmd}"`
  const cmds = []
  if (dirtyFaultResidue) {
    if (mode === 'task' || mode === 'pr') {
      cmds.push(`git -C "${posixPath(reviewRoot)}" checkout -- .`)
    } else {
      cmds.push('还原注入故障使工作区回到基线指纹（勿整库 git checkout 以免丢掉 --local 原改动）')
    }
    cmds.push(`node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase restore ${targetFlags} --cmd "${sampleCmd}"`)
  }
  if (missingSteps.includes('mechanical-pack')) {
    cmds.push(`node ".agents/skills/dev-review/scripts/review-pack.mjs" ${targetFlags}`)
  }
  if (missingSteps.includes('check-empirical')) {
    cmds.push(`node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical ${targetFlags}${cmdArg}`)
  }
  if (missingSteps.includes('check-fault:fail')) {
    cmds.push(`在工作区破坏一处核心判定后运行: node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase fail ${targetFlags} --cmd "${sampleCmd}"`)
  }
  if (missingSteps.includes('check-fault:restore') && !dirtyFaultResidue) {
    cmds.push(`还原故障后运行: node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase restore ${targetFlags} --cmd "${sampleCmd}"`)
  }
  if (missingSteps.includes('visual-check')) {
    cmds.push('核验实际渲染/交互与浅深色视觉效果后追加 --artifact "<真实非空产物路径>"；无渲染环境时改用 --visual-blocked-reason "<阻塞原因>" 诚实报阻')
  }
  if (missingSteps.includes('e2e-observation')) {
    cmds.push(`运行端到端实证并附带运行观察结论后重试: node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical ${targetFlags}${cmdArg} --e2e-evidence "<运行观察实证>"`)
  }
  const extraVisual = missingSteps.includes('visual-check') ? ' --artifact "<真实非空产物路径>"' : ''
  const extraE2e = missingSteps.includes('e2e-observation') ? ' --e2e-evidence "<运行观察实证>"' : ''
  cmds.push(`node ".agents/skills/dev-review/scripts/review-pack.mjs" ${targetFlags}${extraVisual}${extraE2e} --include-diff`)
  return cmds
}

/** 在 syncTier2ReviewSlotIfNeeded 之前校验审查槽脏故障残留，防止退化为退出码 1 或误清空残留。 */
export async function checkDirtyFaultResidueBeforeSync({ mainRoot, gitDir, opts, task, mode, prNo }) {
  const isExternalPr = Boolean(
    opts['external-pr'] || opts.pr || task?.role === 'inbound-external-pr' || task?.isolation === 'review-pr' || task?.externalPr,
  )
  let slotRoot = null
  if (mode === 'task' && task && !isExternalPr && !opts.worktree) {
    const defaultReviewRel = `.worktrees/review-${task.taskId}`
    const hasTier2Slot = task.tier === 2
      || Boolean(task.reviewWorktreePath)
      || existsSync(join(mainRoot, defaultReviewRel))
    if (hasTier2Slot) {
      const reviewRel = task.reviewWorktreePath || defaultReviewRel
      const cand = resolve(mainRoot, reviewRel)
      if (existsSync(cand)) slotRoot = cand
    }
  } else if (mode === 'pr' || isExternalPr) {
    const cleanPr = String(prNo ?? task?.prNumber ?? '').replace(/^#/, '').trim()
    const cand = opts.worktree
      ? resolve(opts.worktree)
      : (task?.reviewWorktreePath ? resolve(mainRoot, task.reviewWorktreePath) : (cleanPr ? join(mainRoot, '.worktrees', `review-pr-${cleanPr}`) : null))
    if (cand && existsSync(cand)) slotRoot = cand
  }

  if (!slotRoot) return { blocked: false }

  const dirtyEntries = await getEffectiveStatusEntries(slotRoot, mainRoot)
  const receiptPath = resolveEmpiricalReceiptPath({ gitDir, mode, task, prNo, reviewRoot: slotRoot, baseRef: opts.base })
  const receipt = readReceipt(receiptPath)
  const expectedRound = opts.round ? Number(opts.round) : (task?.rounds?.length ? nextReviewRound(task) : 1)
  const unrestoredSameRound = Boolean(
    receipt?.faultInjectedAndFailed
    && receipt.faultRestoredClean !== true
    && (mode !== 'task' || Number(receipt.round) === expectedRound),
  )

  if (dirtyEntries.length === 0 && !unrestoredSameRound) {
    return { blocked: false }
  }

  // 不带 --include-diff 的显式 --reset-review-slot 允许走 syncTier2ReviewSlotIfNeeded 清理审查槽
  if (opts['reset-review-slot'] && !opts['include-diff'] && mode === 'task' && !isExternalPr) {
    if (receipt && receiptPath) {
      writeReceipt(receiptPath, {
        ...receipt,
        faultInjectedAndFailed: null,
        faultRestoredClean: false,
        faultRestoredAt: null,
        faultRestoredMeta: null,
      })
    }
    return { blocked: false, resetRequested: true }
  }

  const dirtyFiles = dirtyEntries.map((e) => e.file)
  const targetFlags = buildModeTargetFlags({
    mode, task, round: expectedRound, prNo, baseRef: opts.base, reviewRoot: slotRoot, mainRoot,
  })
  const nextSteps = [
    ...(dirtyFiles.length > 0 ? [`git -C "${posixPath(slotRoot)}" checkout -- .`] : []),
    `node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase restore ${targetFlags} --cmd "<验证命令>"`,
  ]
  const reason = dirtyFiles.length > 0
    ? `审查槽 ${posixPath(slotRoot)} 存在未还原的故障注入脏改动（${dirtyFiles.slice(0, 5).join(', ')}）`
    : `审查槽 ${posixPath(slotRoot)} 尚有未执行 check-fault --phase restore 复绿的故障注入记录`
  const message = `BLOCKED_DIRTY_FAULT_RESIDUE: ${reason}；请先还原并通过复绿校验，再读取 --include-diff。`
  return {
    blocked: true,
    code: 'BLOCKED_DIRTY_FAULT_RESIDUE',
    exitCode: EXIT.FACT,
    mode,
    round: expectedRound,
    targetRoot: posixPath(slotRoot),
    dirtyFiles,
    unrestoredFault: unrestoredSameRound,
    nextSteps,
    message,
  }
}

export function recordMechanicalPack({
  gitDir, mode, task, round, prNo, baseRef, reviewRoot, headSha, diffScope,
  workspaceFingerprint, untrustedScanClean, humanApprovedExec,
}) {
  const receiptPath = resolveEmpiricalReceiptPath({ gitDir, mode, task, prNo, reviewRoot, baseRef })
  const prev = readReceipt(receiptPath)
  const sameCtx = isSameScopeContext(prev, { mode, round, headSha, diffScope })

  // 若 --local 正处于已记录的故障突变态，不覆写原始 baselineFingerprint
  if (sameCtx && prev?.faultInjectedAndFailed && prev.faultRestoredClean !== true
    && workspaceFingerprint === prev.faultInjectedAndFailed.mutatedFingerprint) {
    return receiptPath
  }

  const keepExisting = Boolean(sameCtx && prev.baselineFingerprint === workspaceFingerprint)
  const next = keepExisting
    ? {
        ...prev,
        mechanicalPackSeen: true,
        mechanicalPackAt: new Date().toISOString(),
        ...(untrustedScanClean !== undefined ? { untrustedScanClean: Boolean(untrustedScanClean) } : {}),
        ...(humanApprovedExec ? { humanApprovedExec: true } : {}),
      }
    : {
        mode,
        round,
        prNo: prNo ?? null,
        headSha,
        diffScope,
        baselineFingerprint: workspaceFingerprint,
        untrustedScanClean: untrustedScanClean ?? null,
        humanApprovedExec: Boolean(humanApprovedExec),
        mechanicalPackSeen: true,
        mechanicalPackAt: new Date().toISOString(),
        empiricalVerified: null,
        faultInjectedAndFailed: null,
        faultRestoredClean: false,
        faultRestoredAt: null,
        faultRestoredMeta: null,
      }
  return writeReceipt(receiptPath, next)
}

export function emitGateBlock({ opts, code, payload, textLines }) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`${textLines.join('\n')}\n`)
  }
  process.stderr.write(`${payload.error ?? code}\n`)
  return payload.exitCode ?? EXIT.FACT
}

export function checkUntrustedBeforeExec({ opts, task, mode, headSha, prNo, receipt, diff, reviewRoot, scanUntrustedDiff }) {
  const isExtLedger = Boolean(task?.role === 'inbound-external-pr' || task?.isolation === 'review-pr' || task?.externalPr)
  const shouldScan = Boolean(opts['untrusted-scan'] || opts.pr !== undefined || opts['external-pr'] !== undefined || isExtLedger)
  if (!shouldScan) return { blocked: false }

  const scanRes = scanUntrustedDiff(diff, reviewRoot)
  const hazards = scanRes.hazards ?? []
  // 本次调用带着放行开关，就先验理由：只查开关不查理由，等于这道闸门只认喊话。
  // 账本里已经有批准记录（task / receipt）的情形不在这里验——那是上一次已经验过的结果，
  // 现在再要一次理由，会让「已经批过」变成每次执行都得重新批。
  const wantsBypassNow = Boolean(opts.humanApprovedExec || opts['human-approved'])
  if (wantsBypassNow) {
    const reasonCheck = evaluateReleaseReason(opts.reason, {
      subject: opts.humanApprovedExec ? '在不可信代码上执行的理由' : '把不可信扫描记为已批准的理由',
    })
    if (!reasonCheck.ok) {
      const flags = opts.humanApprovedExec ? '--human-approved-exec' : '--human-approved'
      const msg = `${reasonCheck.code}: ${reasonCheck.reason} ${flags} 必须写清：看过哪些高危项、为什么判定可接受、怎么隔离或复核。`
      return {
        blocked: true,
        payload: {
          status: reasonCheck.code,
          code: reasonCheck.code,
          exitCode: EXIT.USAGE,
          mode,
          pr: prNo ?? task?.prNumber ?? null,
          headSha,
          hazards,
          error: msg,
        },
        textLines: [reasonCheck.code, msg],
      }
    }
    opts.releaseReason = reasonCheck.cleaned
  }
  const isApproved = Boolean(
    wantsBypassNow
    || task?.untrustedApproved === true
    || task?.humanApprovedExec === true
    || (receipt?.headSha === headSha && receipt?.humanApprovedExec === true),
  )
  const isInboundExternal = Boolean(isExtLedger || opts['external-pr'] !== undefined)
  const scanPassed = Boolean(
    opts['untrusted-scan']
    || task?.untrustedScanPassed === true
    || (receipt?.headSha === headSha && receipt?.untrustedScanClean === true),
  )

  if (hazards.length > 0 && !isApproved) {
    const msg = `BLOCKED_UNTRUSTED_HAZARD: 检测到 ${hazards.length} 处高危供应链或门禁弱化改动，未获人类授权禁止执行实证命令。`
    return {
      blocked: true,
      payload: {
        status: 'BLOCKED_UNTRUSTED_HAZARD',
        code: 'BLOCKED_UNTRUSTED_HAZARD',
        exitCode: EXIT.FACT,
        mode,
        pr: prNo ?? task?.prNumber ?? null,
        headSha,
        hazards,
        nextSteps: [
          `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${prNo ?? task?.prNumber ?? '<M>'} --untrusted-scan`,
          'Only after explicit human approval, re-run with --human-approved-exec.',
        ],
        error: msg,
      },
      textLines: [
        'BLOCKED_UNTRUSTED_HAZARD',
        `Scope    : ${headSha}`,
        ...hazards.map((h) => `  - [${h.category}] ${h.file}: ${h.reason}`),
        '',
        '[NEXT STEP]',
        '  1. Inspect flagged diff read-only before running any commands.',
        '  2. Ask a human maintainer for explicit approval (--human-approved-exec).',
      ],
    }
  }

  if (isInboundExternal && !scanPassed && !isApproved) {
    const prDisplay = prNo ?? task?.prNumber ?? '?'
    const msg = `BLOCKED_UNTRUSTED_HAZARD: 外部 PR #${prDisplay} 尚未通过 --untrusted-scan 安全扫描（或未获人类授权），禁止执行验证命令。`
    return {
      blocked: true,
      payload: {
        status: 'BLOCKED_UNTRUSTED_HAZARD',
        code: 'BLOCKED_UNTRUSTED_HAZARD',
        exitCode: EXIT.FACT,
        mode,
        pr: prDisplay,
        headSha,
        hazards: [],
        nextSteps: [`node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${prDisplay} --untrusted-scan`],
        error: msg,
      },
      textLines: [
        'BLOCKED_UNTRUSTED_HAZARD',
        `PR       : #${prDisplay} (HEAD ${headSha})`,
        `Reason   : ${msg}`,
        '',
        '[NEXT STEP]',
        `  - node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${prDisplay} --untrusted-scan`,
      ],
    }
  }

  return { blocked: false, scanClean: hazards.length === 0, approved: isApproved }
}

export async function runCommandList(commands, { cwd, env, stopOnFail = true }) {
  const results = []
  for (const cmd of commands) {
    const t0 = performance.now()
    const res = await execShellCommand(cmd, cwd, { timeout: 300000, env })
    const durationMs = Math.round(performance.now() - t0)
    const scored = scoreExecutionResult({
      executed: !res?.skipped,
      exitCode: res?.code ?? 1,
      errorOnly: Boolean(res?.errorOnly || (!res?.ok && res?.code === 0)),
    })
    results.push({
      cmd,
      exitCode: res.code,
      executed: scored.executed,
      succeeded: scored.succeeded,
      errorOnly: scored.errorOnly,
      ok: Boolean(res.ok && scored.ok),
      timedOut: Boolean(res.timedOut),
      durationMs,
      stdoutExcerpt: String(res.stdout ?? '').slice(0, 600),
      stderrExcerpt: String(res.stderr ?? '').slice(0, 600),
    })
    if (stopOnFail && (!res.ok || !scored.ok)) break
  }
  return results
}

export async function handleEmpiricalE2eFailure({
  mainRoot, gitDir, task, mode, failedCmdRes, headSha, changedFiles = [], opts = {},
}) {
  const diagnostic = buildE2eDiagnosticPacket({
    cmd: failedCmdRes?.cmd ?? '',
    exitCode: failedCmdRes?.exitCode ?? 1,
    stdout: failedCmdRes?.stdoutExcerpt ?? '',
    stderr: failedCmdRes?.stderrExcerpt ?? '',
    headSha,
    taskId: task?.taskId ?? null,
    mode,
    changedFiles,
  })
  await appendGovernSignal({
    mainRoot,
    gitDir,
    isGit: Boolean(gitDir),
    category: 'e2e',
    module: changedFiles[0] ? undefined : 'e2e',
    pattern: 'e2e.runtime-fail',
    severity: 'high',
    source: 'review-check-empirical',
    file: changedFiles[0] ?? '',
    taskId: task?.taskId ?? null,
    message: diagnostic.Evidence.slice(0, 2).join(' | '),
    meta: { exitCode: failedCmdRes?.exitCode ?? 1, headSha: headSha ?? null, mode },
  })
  const body = [
    '## Evidence',
    ...diagnostic.Evidence.map((l) => `- ${l}`),
    '',
    '## Unknowns',
    ...diagnostic.Unknowns.map((l) => `- ${l}`),
    '',
    '## NextSteps',
    ...diagnostic.NextSteps.map((l) => `- ${l}`),
  ].join('\n')
  let escalation = null
  try {
    escalation = await escalateToBackend({
      repoRoot: mainRoot,
      item: {
        source: 'review-check-empirical',
        category: 'e2e',
        severity: 'high',
        caseType: task?.caseType ?? 3,
        e2eBlocking: true,
        title: `Empirical E2E failure (${task?.taskId ?? mode})`,
        summary: diagnostic.Evidence.slice(0, 2).join(' | '),
        body,
        rootCause: diagnostic.Unknowns.join('；'),
        nextStep: diagnostic.NextSteps[0] ?? 'Fix runtime issue and re-run check-empirical',
        files: changedFiles.slice(0, 10),
        taskId: task?.taskId ?? null,
        labels: ['e2e-fail'],
        // 建单正文带上最小失败复现与可独立重放的命令，接手的人不必先猜怎么复现。
        reproEvidence: [
          `exit=${failedCmdRes?.exitCode ?? 1}`,
          ...(failedCmdRes?.stderrExcerpt ? [`stderr=${String(failedCmdRes.stderrExcerpt).slice(0, 200)}`] : []),
        ].join('；'),
        ...(failedCmdRes?.cmd ? { pocCommand: failedCmdRes.cmd } : {}),
      },
      _ghProbe: opts._ghProbe ?? null,
      _ghClient: opts._ghClient ?? null,
    })
  } catch (err) {
    escalation = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { diagnostic, escalation }
}
