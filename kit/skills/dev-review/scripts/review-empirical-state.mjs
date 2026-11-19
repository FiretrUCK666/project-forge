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
import {
  canonicalPath, execShellCommand, gitStatusPorcelainZ,
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

export function collectDevProfileEmpiricalCmds(devProfile = {}) {
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
  const effectiveAuto = auto.length > 0 ? auto : mergeCmds
  const allTestCmds = [...new Set([...effectiveAuto, ...mergeCmds])]
  return { autoCommands: effectiveAuto, hasDevProfileTestCmds: allTestCmds.length > 0 }
}

/** 提取并校验 `--e2e-evidence` / `--visual-evidence` 输入，拦截无实质水话。 */
export function resolveAndValidateE2eEvidenceInput(opts = {}) {
  const explicitRaw = (typeof opts['e2e-evidence'] === 'string' && opts['e2e-evidence'].trim())
    || (typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim())
    || ''
  if (explicitRaw) {
    const check = validateE2eEvidenceText(explicitRaw)
    if (!check.ok) {
      return { ok: false, explicit: true, raw: explicitRaw, text: '', code: check.code, reason: check.reason }
    }
    return { ok: true, explicit: true, raw: explicitRaw, text: check.cleaned, code: null, reason: null }
  }
  if (opts['visual-checked']) {
    return { ok: true, explicit: false, raw: '', text: 'e2e/visual runtime behavior observed and verified', code: null, reason: null }
  }
  return { ok: true, explicit: false, raw: '', text: '', code: null, reason: null }
}

function isInsideDir(candidateAbs, parentAbs) {
  const c = canonicalPath(candidateAbs)
  const p = canonicalPath(parentAbs)
  if (samePath(c, p)) return true
  const rel = relative(p, c)
  return Boolean(rel && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith('/'))
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

export function buildUnblockCommands({ missingSteps, dirtyFaultResidue, mode, task, round, prNo, baseRef, reviewRoot, mainRoot, autoCommands }) {
  const targetFlags = buildModeTargetFlags({ mode, task, round, prNo, baseRef, reviewRoot, mainRoot })
  const sampleCmd = autoCommands[0] ?? '<可证伪 C* 的验证命令>'
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
    const cmdArg = autoCommands.length > 0 ? '' : ` --cmd "${sampleCmd}"`
    cmds.push(`node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical ${targetFlags}${cmdArg}`)
  }
  if (missingSteps.includes('check-fault:fail')) {
    cmds.push(`在工作区破坏一处核心判定后运行: node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase fail ${targetFlags} --cmd "${sampleCmd}"`)
  }
  if (missingSteps.includes('check-fault:restore') && !dirtyFaultResidue) {
    cmds.push(`还原故障后运行: node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase restore ${targetFlags} --cmd "${sampleCmd}"`)
  }
  if (missingSteps.includes('visual-check')) {
    cmds.push('核验实际渲染/交互与浅深色视觉效果后追加 --visual-checked')
  }
  if (missingSteps.includes('e2e-observation')) {
    cmds.push(`运行端到端实证并附带运行观察结论后重试: node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical ${targetFlags} --e2e-evidence "<运行观察实证>"`)
  }
  const extraVisual = missingSteps.includes('visual-check') ? ' --visual-checked' : ''
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
    exitCode: EXIT.UNTRUSTED_HAZARD,
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
  return payload.exitCode ?? EXIT.UNTRUSTED_HAZARD
}

export function checkUntrustedBeforeExec({ opts, task, mode, headSha, prNo, receipt, diff, reviewRoot, scanUntrustedDiff }) {
  const isExtLedger = Boolean(task?.role === 'inbound-external-pr' || task?.isolation === 'review-pr' || task?.externalPr)
  const shouldScan = Boolean(opts['untrusted-scan'] || opts.pr !== undefined || opts['external-pr'] !== undefined || isExtLedger)
  if (!shouldScan) return { blocked: false }

  const scanRes = scanUntrustedDiff(diff, reviewRoot)
  const hazards = scanRes.hazards ?? []
  const isApproved = Boolean(
    opts.humanApprovedExec
    || opts['human-approved']
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
        exitCode: EXIT.UNTRUSTED_HAZARD,
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
        exitCode: EXIT.UNTRUSTED_HAZARD,
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
      },
      _ghProbe: opts._ghProbe ?? null,
      _ghClient: opts._ghClient ?? null,
    })
  } catch (err) {
    escalation = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { diagnostic, escalation }
}
