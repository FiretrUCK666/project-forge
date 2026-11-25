/**
 * critique-rounds.mjs —— 规划 Critique 作用域、全历史换人锁、三轮硬停损（与审查端单源共享）及 A4 防空转。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-plan 与 dev-review 共用。
 */

import { EXIT } from './exit-codes.mjs'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import {
  applyFindingClosures, assignStructuredFindings, buildCritiqueTextSnapshot,
  classifyCritiqueFindings, evaluateRound2CritiqueScope, normCritItemText,
  parseCritiqueOverride, parseCritiqueStamp, parseFindings, serializeFindings,
  validateRoundContinuity,
} from './critique-diff.mjs'
import {
  persistPlanCritiqueEntry, persistPlanCritiqueEntrySync,
  readPlanCritiqueEntry, readPlanCritiqueEntrySync,
} from './critique-store.mjs'
import {
  collectOwnerHistory, DOC_FRONTMATTER_KEY_ORDER, docIsoDate, parseDocFrontmatter,
  serializeDocFrontmatter, stripCritiqueMeta, syncPlanDocBodyMeta, updateDocFrontmatter,
} from './docs.mjs'
import { isValidActorName } from './harness-context.mjs'
import { extractDocSnapshot } from './doc-substantive.mjs'
import { posixPath, readTextSafe, sha256Text, writeAtomic } from './git.mjs'
import { appendGovernSignal } from './signals.mjs'

export { parseCritiqueOverride, parseCritiqueStamp, parseFindings, serializeFindings }
export { persistPlanCritiqueEntrySync, readPlanCritiqueEntry, readPlanCritiqueEntrySync }

export const CRITIQUE_FINDINGS_KEY = 'critique_findings'
export const CRITIQUE_ROUNDS_KEY = 'critique_rounds'
export const CRITIQUE_OVERRIDE_KEY = 'critique_override'
export const STOP_LOSS_MAX_ROUNDS = 3

/** 归一化参与人标识（忽略前导 `@` 与大小写）。 */
export function normActorId(s) {
  return String(s ?? '').trim().replace(/^@/, '').toLowerCase()
}

/** 从历史轮次与实施人/作者中收集去重后的排除审查人名单，供 next/critique-scope 提示换人。 */
export function collectExcludedReviewers(rounds = [], primaryActor = null) {
  const out = []
  const seen = new Set()
  const add = (actor) => {
    const clean = String(actor ?? '').trim()
    const key = normActorId(clean)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(clean)
  }
  add(primaryActor)
  for (const r of Array.isArray(rounds) ? rounds : []) {
    add(r?.reviewerId ?? r?.reviewer)
  }
  return out
}

/**
 * C13/C14 共享全历史换人锁：禁止当前轮复核人与历史任意一轮（R1..Rk）的复核人相同。
 */
export function checkDistinctRoundReviewer(rounds = [], currentReviewerId, {
  minRound = 2,
  currentRound = null,
  code = 'BLOCKED_SAME_REVIEWER_REREVIEW',
  subject = '独立审查',
} = {}) {
  const targetKey = normActorId(currentReviewerId)
  const history = Array.isArray(rounds) ? rounds : []
  const excludedReviewers = collectExcludedReviewers(history)
  const effRound = currentRound !== null && currentRound !== undefined
    ? Number(currentRound)
    : (history.reduce((m, r) => Math.max(m, Number(r?.round) || 0), 0) + 1)

  if (!targetKey || effRound < minRound) {
    return { blocked: false, excludedReviewers }
  }
  const matched = history.find((r) => {
    const rNum = Number(r?.round) || 0
    if (currentRound !== null && currentRound !== undefined && rNum === Number(currentRound)) return false
    return normActorId(r?.reviewerId ?? r?.reviewer) === targetKey
  })
  if (matched) {
    return {
      blocked: true,
      code,
      exitCode: EXIT.FACT,
      matchedRound: matched.round ?? null,
      matchedReviewer: matched.reviewerId ?? matched.reviewer,
      excludedReviewers,
      message: `${code}: Round ${effRound} ${subject}复核人 (${currentReviewerId}) 与历史 Round ${matched.round ?? '?'} 相同。`
        + `必须创建全新独立子代理复审（须排除：${excludedReviewers.join(', ') || currentReviewerId}）。`,
    }
  }
  return { blocked: false, excludedReviewers }
}

/**
 * C13/C14/C22⑥ 规划与代码审查共享单一三轮停损规则判定源。
 */
export function evaluateThreeRoundStopLoss({
  round,
  verdict,
  items = [],
  prevItems = [],
  humanApproved = false,
  matchesSame = null,
  maxRounds = STOP_LOSS_MAX_ROUNDS,
  roundBaseline = 0,
} = {}) {
  const rNum = Number(round) || 1
  const baseRound = Math.max(0, Number(roundBaseline) || 0)
  const relRound = Math.max(1, rNum - baseRound)
  const vLow = String(verdict ?? '').toLowerCase()
  const isBlocking = vLow === 'changes' || vLow === 'reject' || vLow === 'rejected' || items.length > 0
  const maxRoundsExceeded = relRound >= maxRounds && isBlocking
  const sameFn = typeof matchesSame === 'function'
    ? matchesSame
    : (a, b) => {
        const ta = normCritItemText(a)
        const tb = normCritItemText(b)
        return Boolean(ta && tb && ta === tb)
      }
  const repeatedItems = (relRound >= 2 && Array.isArray(items) && items.length > 0 && Array.isArray(prevItems) && prevItems.length > 0)
    ? items.filter((it) => prevItems.some((pm) => sameFn(it, pm)))
    : []
  const repeatedTrigger = relRound >= 2 && repeatedItems.length > 0
  const stopLoss = (maxRoundsExceeded || repeatedTrigger) && !humanApproved
  const reasons = []
  if (maxRoundsExceeded) {
    reasons.push(baseRound > 0
      ? `round ${rNum} (post-continue ${relRound} >= ${maxRounds}) with unresolved verdict/blockers`
      : `round ${rNum} >= ${maxRounds} with unresolved verdict/blockers`)
  }
  if (repeatedTrigger) reasons.push(`repeated blocker across consecutive rounds (${repeatedItems.length} item(s))`)
  return { stopLoss, maxRoundsExceeded, repeatedTrigger, repeatedItems, reasons, exitCode: stopLoss ? EXIT.HUMAN : EXIT.OK }
}

/** 安全反序列化 Frontmatter 中的 `critique_rounds` 历史数组（兼容旧单行 `plan_critique` 回退）。 */
export function parseCritiqueRounds(fmData, rawText = '', ledgerEntry = null) {
  if (Array.isArray(ledgerEntry?.rounds) && ledgerEntry.rounds.length > 0) {
    return ledgerEntry.rounds
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({ ...x }))
      .sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0))
  }
  const rawVal = fmData?.[CRITIQUE_ROUNDS_KEY]
  let list = []
  if (Array.isArray(rawVal)) {
    list = rawVal.map((it) => (typeof it === 'string' ? (() => { try { return JSON.parse(it) } catch { return null } })() : it)).filter(Boolean)
  } else if (typeof rawVal === 'string' && rawVal.trim()) {
    try {
      const parsed = JSON.parse(rawVal.trim())
      if (Array.isArray(parsed)) list = parsed.filter((x) => x && typeof x === 'object')
    } catch { /* fallback below */ }
  }
  if (list.length > 0) {
    return list.sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0))
  }
  const legacyText = /^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(String(rawText ?? ''))?.[1]?.trim() ?? null
  const stamp = parseCritiqueStamp(fmData?.plan_critique ?? legacyText)
  if (stamp?.reviewer && stamp.status && stamp.status !== 'skipped') {
    return [{
      round: stamp.round ?? 1,
      verdict: stamp.status,
      reviewerId: stamp.reviewer,
      sha: stamp.sha ?? null,
      summary: stamp.summary ?? null,
      findings: [],
      stopLossTriggered: false,
    }]
  }
  return []
}

/**
 * 正文指纹：剥掉易变生命周期元字段后取前 12 位。
 *
 * 这套口径是 `critique-override` 签字、`critique-pass` 记录与 `approve` 复核三方共用的
 * **同一个**指纹。三处各写一份，迟早算出三个不同的值，然后「签名有效」与「签名过期」
 * 同时成立。所以只在这里定义，另两处引用。
 */
export function critiqueTextFingerprint(rawText) {
  return sha256Text(stripCritiqueMeta(rawText)).slice(0, 12)
}

/**
 * 人类 override 的生效判定。
 *
 * ## 为什么需要它
 *
 * 停损之后由人签字放行，文档里 `plan_critique` 仍留着 `rejected (reviewer=…, round=3, …)`。
 * 那是**历史事实**——当初确实被拒过——不是**当前状态**。把「有过 rejected 记录」
 * 当成「现在仍未过审」，等于让人签的字不生效：人已经拍板放行，门禁还在拦。
 *
 * ## 但它只对签字时那份正文有效
 *
 * 签字后正文再被改动，签名就过期了——人批的是当时那一版，不是改动后的新版。
 * 判据就是正文指纹，与 `approve` 的 `BLOCKED_CRITIQUE_STALE` 完全一致：
 * 两处若用不同口径，「approve 说没过期、门禁说过期」就会同时成立。
 *
 * @param {string} rawText 文档全文
 * @param {object} fmData Frontmatter 数据
 * @returns {{present: boolean, approved: boolean, stale: boolean, sha: string|null,
 *   currentSha: string, override: object|null}}
 */
export function evaluateCritiqueOverride(rawText, fmData, ledgerEntry = null) {
  const override = parseCritiqueOverride(fmData, ledgerEntry)
  const approved = override?.approved === true
  const recordedSha = typeof override?.sha === 'string' ? override.sha.trim().toLowerCase() : ''
  const currentSha = critiqueTextFingerprint(rawText)
  return {
    present: Boolean(override),
    approved,
    // 没记 sha 的旧记录无从比对，按「不冲突」算——不能因为缺个字段就把人的签字作废。
    stale: approved && Boolean(recordedSha) && currentSha !== recordedSha,
    sha: recordedSha || null,
    currentSha,
    override,
  }
}

/** 生成「这一轮要复核什么」的清单（原生消费 `ledgerEntry.findings`、`priorRounds`、`override`、`continued`）。 */
export function buildCritiqueScope({
  round, currentSha, previousSha = null, findingsRaw = '', findings = null,
  priorRounds = [], override = null, continued = null, reviewer = '(未指定)',
}) {
  const history = []
  const seen = new Set()
  const addFinding = (f) => {
    const r = Number(f?.round) || 1
    const text = String(f?.text ?? '').trim()
    if (!text) return
    const key = `${r}:${text}`
    if (seen.has(key)) return
    seen.add(key)
    history.push({ round: r, severity: String(f?.severity ?? 'must').toLowerCase(), text })
  }

  for (const item of parseFindings(findings)) addFinding(item)
  for (const pr of Array.isArray(priorRounds) ? priorRounds : []) {
    const rNum = Number(pr?.round) || 1
    const sev = String(pr?.verdict ?? '').toLowerCase() === 'passed' ? 'should' : 'must'
    const items = Array.isArray(pr?.findings) && pr.findings.length > 0
      ? pr.findings
      : (String(pr?.verdict ?? '').toLowerCase() === 'rejected' && pr?.summary ? [pr.summary] : [])
    for (const txt of items) addFinding({ round: rNum, severity: sev, text: txt })
  }
  for (const item of parseFindings(findingsRaw)) addFinding(item)

  const sortedRounds = Array.isArray(priorRounds)
    ? [...priorRounds].sort((a, b) => (Number(a?.round) || 0) - (Number(b?.round) || 0))
    : []
  const lastPriorRound = sortedRounds.at(-1) ?? null
  const effPrevSha = previousSha
    ?? lastPriorRound?.artifact_baseline?.shortSha
    ?? lastPriorRound?.sha
    ?? null

  const rounds = [...new Set(history.map((h) => h.round))].sort((a, b) => a - b)
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const lastFindings = history.filter((h) => h.round === lastRound)
  const changed = Boolean(effPrevSha && currentSha && String(effPrevSha) !== String(currentSha))

  const lines = [
    `# 规划审核范围（Round ${round}，复核人 ${reviewer}）`,
    '',
    '> 这份清单由 `doc-plan critique-scope` 生成，提供本轮复核范围与正文指纹对照。',
    '',
  ]
  if (lastFindings.length > 0) {
    lines.push(`## 上一轮（Round ${lastRound}）提了 ${lastFindings.length} 条`, '')
    for (const f of lastFindings) lines.push(`- [${f.severity === 'must' ? '必修' : '建议'}] ${f.text}`)
    lines.push('', changed
      ? '**正文在上一轮之后改过。** 请逐条核对改完的地方是否已闭环且未引入新问题。'
      : '**正文在上一轮之后没有改动。** 请重点看上一轮指出的问题——尤其是被驳回的更要回看，判断是否仍然成立（原样直接复审会触发 `BLOCKED_CRITIQUE_SAME_SHA`）。', '')
  } else if (round >= 2) {
    lines.push('## 上一轮没有记录意见', '', '请按完整范围审一遍，并在本轮记录 `--findings`。', '')
  } else {
    lines.push('## 第一轮', '', '按完整范围审，并将发现记入 `--findings`。', '')
  }
  if (continued?.active && continued.reason) {
    lines.push('## 人类打回重写指令（critique-continue）', '', `- 原因：${continued.reason}`, `- 指纹：\`${continued.sha ?? '-'}\`（${continued.sha === currentSha ? '正文尚未修改' : '正文已修订'}）`, '')
  }
  if (override?.approved) {
    lines.push('## 人类停损解锁记录（critique-override）', '', `- 理由：${override.reason ?? '-'}`, `- 签字指纹：\`${override.sha ?? '-'}\`（${override.sha && currentSha && override.sha !== currentSha ? '已过期' : '有效'}）`, '')
  }
  lines.push('## 正文指纹', '', `- 当前：\`${currentSha ?? '(未计算)'}\``, `- 上轮：\`${effPrevSha ?? '(无记录)'}\``, '')
  return {
    prompt: `${lines.join('\n').trimEnd()}\n`,
    mustRecheck: lastFindings.map((f) => f.text),
    allFindings: history,
    previousSha: effPrevSha,
    changed,
    note: lastFindings.length > 0 ? `上一轮 ${lastFindings.length} 条，正文${changed ? '已改' : '未改'}` : '无历史意见',
  }
}

function makePlanError(code, exitCode, message, details = {}) {
  return Object.assign(new Error(message), { code, exitCode, details })
}

function inferDocTypeLight(relPath, fmData) {
  const fmKind = fmData?.kind
  if (fmKind === 'prd' || fmKind === 'spec' || fmKind === 'todo') return fmKind
  const rel = posixPath(relPath).toLowerCase()
  if (rel.includes('/specs/')) return 'spec'
  if (rel.includes('/prd/')) return 'prd'
  if (rel.includes('/todo/')) return 'todo'
  return 'spec'
}

function computePlanArtifactBaseline(text, snap) {
  const fullSha = sha256Text(stripCritiqueMeta(text))
  return {
    sha: fullSha,
    shortSha: fullSha.slice(0, 12),
    criteriaCount: snap?.criteriaCount ?? 0,
    anchorCount: Array.isArray(snap?.anchors) ? snap.anchors.length : 0,
  }
}

function persistCritiqueFrontmatter(abs, text, fm, docType, patch) {
  if (fm.hasFrontmatter) {
    updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    const stampLine = `- Plan Critique: ${patch.plan_critique}`
    let updated = text
    if (/^(?:-\s+)?Plan Critique:.*$/mi.test(text)) updated = text.replace(/^(?:-\s+)?Plan Critique:.*$/mi, stampLine)
    else if (/^(?:-\s+)?Status:.*$/mi.test(text)) updated = text.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${stampLine}`)
    else updated = text.replace(/^(#[^\n]*\n)/, `$1\n${stampLine}\n`)
    writeAtomic(abs, updated)
  }
}

function validateCritiqueActorAndHistory({ fmPre, rawPre, file, reviewer, round, digest, priorRounds, strictSameSha = false }) {
  if (!reviewer || !String(reviewer).trim()) {
    throw makePlanError('MISSING_REVIEWER', EXIT.USAGE, 'critique 必须指定 --reviewer <reviewerId>')
  }
  if (fmPre?.hasFrontmatter && !isValidActorName(fmPre.data?.owner)) {
    throw makePlanError(
      'INVALID_OWNER', EXIT.USAGE,
      `INVALID_OWNER: ${file} 的 Frontmatter owner 不得为空、null 或占位词，请先运行 doc-plan.mjs link --owner <name> 补齐。`,
    )
  }
  // 自审要按**负责人历史**判，不只按当前 owner。
  const ownerHistory = collectOwnerHistory(fmPre.data)
  const reviewerId = normActorId(reviewer)
  if (reviewerId && ownerHistory.some((o) => normActorId(o) === reviewerId)) {
    throw makePlanError(
      'SELF_CRITIQUE_REJECTED', EXIT.FACT,
      `SELF_CRITIQUE_REJECTED: 规划 Critique 独立复核人 (${reviewer}) 不得与文档负责人或其任前任负责人相同（历史：${ownerHistory.join('、')}）`,
    )
  }
  const effectiveRound = round !== null && round !== undefined
    ? Number(round)
    : (priorRounds.reduce((m, r) => Math.max(m, Number(r?.round) || 0), 0) + 1)
  const continuity = validateRoundContinuity(priorRounds, round)
  if (continuity.blocked) {
    throw makePlanError('BLOCKED_CRITIQUE_ROUND_GAP', EXIT.FACT, continuity.message, {
      file, round, maxRound: continuity.maxRound,
    })
  }
  const reviewerLock = checkDistinctRoundReviewer(priorRounds, reviewer, {
    minRound: 2,
    currentRound: effectiveRound,
    code: 'BLOCKED_CRITIQUE_SAME_REVIEWER',
    subject: '规划 Critique',
  })
  if (reviewerLock.blocked) {
    throw makePlanError('BLOCKED_CRITIQUE_SAME_REVIEWER', EXIT.FACT, reviewerLock.message, {
      file, round: effectiveRound, excludedReviewers: reviewerLock.excludedReviewers,
    })
  }
  const prevRound = priorRounds.filter((r) => Number(r.round) < effectiveRound).at(-1) ?? null
  const prevBaselineSha = prevRound?.artifact_baseline?.shortSha ?? prevRound?.sha ?? parseCritiqueStamp(fmPre.data?.plan_critique)?.sha
  if (effectiveRound >= 2 && (strictSameSha || prevRound) && prevBaselineSha && prevBaselineSha === digest) {
    throw makePlanError(
      'BLOCKED_CRITIQUE_SAME_SHA', EXIT.FACT,
      `BLOCKED_CRITIQUE_SAME_SHA (BLOCKED_NO_REWORK_CHANGES): ${file} Round ${effectiveRound} 正文与上一轮完全一致 (sha=${digest})，必须先修改文档再复核。`,
      { file, round: effectiveRound, sha: digest, excludedReviewers: reviewerLock.excludedReviewers },
    )
  }
  return { effectiveRound, prevRound, excludedReviewers: reviewerLock.excludedReviewers }
}

/** 记录规划 Critique 通过（含自审拦截、全历史换人锁、A4 正文变动锁与历史停损校验）。 */
export async function critiquePassDoc({
  repoRoot, mainRoot = repoRoot, gitDir = null, isGit = false,
  file, reviewer, round = null, summary = '', findings = [], shouldFix = [],
  resolved = [], rebutAccepted = [], auditDoc = null, docType = null, taskId = null,
}) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', EXIT.ACTION, `找不到文档：${file}`)
  const rawPre = readTextSafe(abs)
  if (rawPre === undefined) throw makePlanError('FILE_UNREADABLE', EXIT.ACTION, `无法读取文本文件：${file}`)

  const relDoc = posixPath(relative(repoRoot, abs))
  const fmPre = parseDocFrontmatter(rawPre)
  const { entry: priorEntry } = await readPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId, fmData: fmPre.data, relDoc,
  })
  const priorRounds = parseCritiqueRounds(fmPre.data, rawPre, priorEntry)
  const snapPre = extractDocSnapshot(rawPre)
  const baselinePre = computePlanArtifactBaseline(rawPre, snapPre)

  const { effectiveRound } = validateCritiqueActorAndHistory({
    fmPre, rawPre, file, reviewer, round, digest: baselinePre.shortSha, priorRounds,
  })

  if (typeof auditDoc === 'function') {
    const audit = auditDoc({ repoRoot, file })
    if (!audit.ok) {
      const err = new Error(`文档尚有 ${audit.errors.length} 处审计问题未自净化，禁止记录 critique-pass`)
      err.audit = audit
      err.exitCode = EXIT.ACTION
      throw err
    }
  }

  const text = readTextSafe(abs) ?? rawPre
  const fm = parseDocFrontmatter(text)
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const snap = extractDocSnapshot(text)
  const baseline = computePlanArtifactBaseline(text, snap)
  const digest = baseline.shortSha
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const stampValue = `passed (reviewer=${String(reviewer).trim()}, round=${effectiveRound}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`

  const rawShould = [...(Array.isArray(findings) ? findings : [findings]), ...(Array.isArray(shouldFix) ? shouldFix : [shouldFix])]
  const findingList = rawShould.map((f) => String(f ?? '').trim()).filter(Boolean)
  const classifiedPass = classifyCritiqueFindings(findingList, { defaultSeverity: 'minor' })
  const closedPrev = applyFindingClosures(priorEntry?.structuredFindings ?? [], { resolved, rebutAccepted, round: effectiveRound })
  const assignedPass = assignStructuredFindings(closedPrev.list, classifiedPass.parsed, effectiveRound, { defaultStatus: 'should-fix' })
  const priorFindings = Array.isArray(priorEntry?.findings) ? priorEntry.findings : []
  const nextFindings = findingList.length > 0
    ? [...priorFindings, { round: effectiveRound, verdict: 'passed', items: findingList }]
    : priorFindings

  const nextRounds = [...priorRounds.filter((r) => Number(r.round) !== effectiveRound), {
    round: effectiveRound, verdict: 'passed', reviewerId: String(reviewer).trim(),
    sha: digest, artifact_baseline: baseline, summary: cleanSummary || null,
    findings: findingList, stopLossTriggered: false, recordedAt: new Date().toISOString(),
  }].sort((a, b) => Number(a.round) - Number(b.round))
  const nextSnapshots = { ...(priorEntry?.roundSnapshots ?? {}), [String(effectiveRound)]: buildCritiqueTextSnapshot(text) }

  persistCritiqueFrontmatter(abs, text, fm, effType, {
    plan_critique: stampValue,
    updated: docIsoDate(),
  })

  const resolvedContinued = priorEntry?.continued
    ? { ...priorEntry.continued, active: false, resolvedAt: new Date().toISOString(), resolvedBy: String(reviewer).trim(), resolvedRound: effectiveRound }
    : undefined

  await persistPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId: taskId ?? fm.data?.task_id ?? null, fmData: fm.data, relDoc,
    entry: {
      ...(priorEntry ?? {}),
      rounds: nextRounds,
      anchors: snap,
      findings: nextFindings,
      structuredFindings: assignedPass.list,
      roundSnapshots: nextSnapshots,
      ...(resolvedContinued ? { continued: resolvedContinued } : {}),
      override: priorEntry?.override ?? parseCritiqueOverride(fm.data),
      updatedAt: new Date().toISOString(),
    },
  })

  if (isGit || existsSync(resolve(mainRoot, '.git'))) {
    await appendGovernSignal({
      mainRoot, gitDir, isGit: Boolean(isGit || existsSync(resolve(mainRoot, '.git'))),
      category: 'plan', module: 'plan', pattern: 'plan.critique-pass', severity: 'info',
      source: 'doc-plan', file: relDoc, round: effectiveRound, verdict: 'pass',
      message: `critique-pass round ${effectiveRound} by ${reviewer}`,
    }).catch(() => {})
  }

  return {
    ok: true, file: relDoc, docType: effType, reviewer: String(reviewer).trim(), round: effectiveRound, sha: digest,
    summary: cleanSummary || null, status: 'passed',
    excludedReviewers: collectExcludedReviewers(nextRounds, fm.data?.owner),
  }
}

/**
 * C14: 记录规划 Critique 驳回；同步校验自审/换人/同 SHA，并在 Round >= 3 或连续同因时触发退出码 4 停损。
 */
export async function critiqueRejectDoc({
  repoRoot, mainRoot = repoRoot, gitDir = null, isGit = false,
  file, reviewer, round = null, summary = '', findings = [],
  resolved = [], rebutAccepted = [], auditDoc = null, docType = null, taskId = null,
}) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', EXIT.ACTION, `找不到文档：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw makePlanError('FILE_UNREADABLE', EXIT.ACTION, `无法读取文本文件：${file}`)

  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const { entry: priorEntry } = await readPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId, fmData: fm.data, relDoc,
  })
  const priorRounds = parseCritiqueRounds(fm.data, text, priorEntry)
  const override = parseCritiqueOverride(fm.data, priorEntry)
  const snap = extractDocSnapshot(text)
  const baseline = computePlanArtifactBaseline(text, snap)
  const digest = baseline.shortSha

  const { effectiveRound, prevRound } = validateCritiqueActorAndHistory({
    fmPre: fm, rawPre: text, file, reviewer, round, digest, priorRounds, strictSameSha: true,
  })

  const findingList = (Array.isArray(findings) ? findings : [findings]).map((f) => String(f ?? '').trim()).filter(Boolean)
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const usedSummaryFallback = findingList.length === 0 && Boolean(cleanSummary)
  const evalItems = findingList.length > 0 ? findingList : (cleanSummary ? [cleanSummary] : [])
  const classified = classifyCritiqueFindings(evalItems, { defaultSeverity: 'major' })
  if (classified.onlyMinor) {
    throw makePlanError(
      'BLOCKED_NON_BLOCKING_REJECT', EXIT.FACT,
      `BLOCKED_NON_BLOCKING_REJECT: critique-reject 仅收到非阻断 minor 建议（${classified.minor.map((m) => m.text).join('；')}），禁止阻断规划；请改用：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${relDoc}" --reviewer "${String(reviewer).trim()}" --round ${effectiveRound} --should-fix "${classified.minor[0].text}"`,
      { file: relDoc, round: effectiveRound, minorFindings: classified.minor.map((m) => m.text) },
    )
  }

  const closedPrev = applyFindingClosures(priorEntry?.structuredFindings ?? [], { resolved, rebutAccepted, round: effectiveRound })
  const openPriorBlockers = closedPrev.list.filter((it) => it.status === 'open' && (it.severity === 'blocker' || it.severity === 'major'))
  const currLines = buildCritiqueTextSnapshot(text)
  const prevSnapKey = String(prevRound?.round ?? (effectiveRound - 1))
  const prevLines = priorEntry?.roundSnapshots?.[prevSnapKey] ?? null
  const auditFailure = typeof auditDoc === 'function' ? !auditDoc({ repoRoot, file }).ok : false
  const roundBaseline = Number(priorEntry?.continued?.roundBaseline) || 0
  const activeContinueReason = priorEntry?.continued?.active
    ? priorEntry.continued.reason
    : (priorEntry?.continued?.reason && roundBaseline > 0 && effectiveRound === roundBaseline + 1 ? priorEntry.continued.reason : '')
  const scopeCheck = evaluateRound2CritiqueScope({
    effectiveRound, prevLines, currLines, blockingItems: classified.blocking,
    openPriorBlockers, usedSummaryFallback, auditFailure, continuedReason: activeContinueReason,
    file: relDoc, reviewer: String(reviewer).trim(),
  })
  if (scopeCheck.blocked) {
    throw makePlanError('BLOCKED_OUT_OF_SCOPE_CRITIQUE', EXIT.FACT, scopeCheck.message, {
      file: relDoc, round: effectiveRound, outOfScope: scopeCheck.outOfScope,
    })
  }

  const blockingTexts = classified.blocking.map((b) => b.text)
  const assigned = assignStructuredFindings(closedPrev.list, classified.parsed, effectiveRound)
  const prevItems = openPriorBlockers.length > 0
    ? openPriorBlockers.map((b) => b.text)
    : (closedPrev.closedIds.length > 0 ? [] : (Array.isArray(prevRound?.findings) && prevRound.findings.length > 0 ? prevRound.findings : (prevRound?.summary ? [prevRound.summary] : [])))

  const sl = evaluateThreeRoundStopLoss({
    round: effectiveRound, verdict: 'reject', items: blockingTexts, prevItems, humanApproved: Boolean(override?.approved),
    roundBaseline,
  })

  const stampValue = `rejected (reviewer=${String(reviewer).trim()}, round=${effectiveRound}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`
  const priorFindings = Array.isArray(priorEntry?.findings) ? priorEntry.findings : []
  const nextFindings = evalItems.length > 0
    ? [...priorFindings, { round: effectiveRound, verdict: 'rejected', items: evalItems }]
    : priorFindings

  const nextRounds = [...priorRounds.filter((r) => Number(r.round) !== effectiveRound), {
    round: effectiveRound, verdict: 'rejected', reviewerId: String(reviewer).trim(),
    sha: digest, artifact_baseline: baseline, summary: cleanSummary || null,
    findings: evalItems, stopLossTriggered: sl.stopLoss, stopLossReasons: sl.reasons,
    recordedAt: new Date().toISOString(),
  }].sort((a, b) => Number(a.round) - Number(b.round))
  const nextSnapshots = { ...(priorEntry?.roundSnapshots ?? {}), [String(effectiveRound)]: currLines }
  const resolvedContinued = priorEntry?.continued
    ? { ...priorEntry.continued, active: false, resolvedAt: new Date().toISOString(), resolvedBy: String(reviewer).trim(), resolvedRound: effectiveRound }
    : undefined

  persistCritiqueFrontmatter(abs, text, fm, effType, {
    plan_critique: stampValue,
    updated: docIsoDate(),
  })

  await persistPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId: taskId ?? fm.data?.task_id ?? null, fmData: fm.data, relDoc,
    entry: {
      ...(priorEntry ?? {}),
      rounds: nextRounds,
      anchors: snap,
      findings: nextFindings,
      structuredFindings: assigned.list,
      roundSnapshots: nextSnapshots,
      ...(resolvedContinued ? { continued: resolvedContinued } : {}),
      override: priorEntry?.override ?? override,
      updatedAt: new Date().toISOString(),
    },
  })

  const hasGitDir = Boolean(isGit || existsSync(resolve(mainRoot, '.git')))
  if (hasGitDir) {
    await appendGovernSignal({
      mainRoot, gitDir, isGit: hasGitDir,
      category: 'plan', module: 'plan',
      pattern: sl.stopLoss ? 'plan.critique-stop-loss' : 'plan.critique-reject',
      severity: sl.stopLoss ? 'high' : 'medium',
      source: 'doc-plan', file: relDoc, taskId: taskId ?? fm.data?.task_id ?? null,
      round: effectiveRound, verdict: 'reject',
      message: `critique-reject round ${effectiveRound}${sl.stopLoss ? ' [STOP_LOSS]' : ''}: ${cleanSummary || evalItems[0] || 'rejected'}`,
      meta: { repeatedItems: sl.repeatedItems, reasons: sl.reasons },
    }).catch(() => {})
  }

  const excludedReviewers = collectExcludedReviewers(nextRounds, fm.data?.owner)
  const overrideCmd = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-override --file "${relDoc}" --human-approved --reason "<维护者裁决原因>"`
  const continueCmd = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-continue --file "${relDoc}" --reason "<改进方向>"`
  const nextStep = sl.stopLoss
    ? `${overrideCmd}（或先运行 ${continueCmd} 后重写并由新复核人继续复核）`
    : `修改 "${relDoc}" 后重跑 audit，再由新独立复核人（排除 ${excludedReviewers.join(', ')}）执行 Round ${effectiveRound + 1}`
  const stopLossPacket = sl.stopLoss
    ? {
        code: 'STOP_LOSS_ESCALATE',
        file: relDoc,
        round: effectiveRound,
        reasons: sl.reasons,
        repeatedFindings: sl.repeatedItems,
        excludedReviewers,
        rootCauseHypothesis: '连续驳回或达到 3 轮规划停损上限，说明需求边界/依赖拆分或架构前提尚有未决冲突。',
        recoveryCommand: overrideCmd,
        continueCommand: continueCmd,
      }
    : null

  return {
    ok: !sl.stopLoss,
    status: sl.stopLoss ? 'STOP_LOSS_ESCALATE' : 'CRITIQUE_REJECTED',
    exitCode: sl.stopLoss ? EXIT.HUMAN : EXIT.FACT,
    file: relDoc,
    reviewer: String(reviewer).trim(),
    round: effectiveRound,
    sha: digest,
    summary: cleanSummary || null,
    findings: evalItems,
    excludedReviewers,
    stopLossTriggered: sl.stopLoss,
    ...(stopLossPacket ? { stopLossPacket } : {}),
    nextStep,
  }
}

/** 人类准许在停损后继续重写并复核（`critique-continue --reason`），不等同于批准放行 `approve`。 */
export async function critiqueContinueDoc({
  repoRoot, mainRoot = repoRoot, gitDir = null,
  file, reason = '', by = 'human-maintainer', docType = null, taskId = null,
}) {
  const cleanReason = String(reason ?? '').trim()
  if (!cleanReason) throw makePlanError('MISSING_CONTINUE_REASON', EXIT.USAGE, 'critique-continue 必须传入非空 --reason "<改进方向>"')

  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', EXIT.ACTION, `找不到文档：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw makePlanError('FILE_UNREADABLE', EXIT.ACTION, `无法读取文本文件：${file}`)

  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const digest = critiqueTextFingerprint(text)
  const { entry: priorEntry } = await readPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId, fmData: fm.data, relDoc,
  })
  const priorRounds = parseCritiqueRounds(fm.data, text, priorEntry)
  const roundBaseline = priorRounds.reduce((m, r) => Math.max(m, Number(r?.round) || 0), 0)
  const curStatus = String(fm.data?.status ?? (/^(?:-\s+)?Status:\s*(\S+)/mi.exec(text)?.[1] ?? '')).trim().toLowerCase()
  const wasApproved = Boolean(
    fm.data?.approved === true
    || ['approved', 'implementing', 'in_review'].includes(curStatus)
    || ((effType === 'prd' || effType === 'todo') && curStatus === 'active'),
  )
  if (wasApproved) {
    const today = docIsoDate()
    if (fm.hasFrontmatter) {
      const patch = { status: 'draft', updated: today }
      if ('approved' in (fm.data ?? {}) || effType === 'spec' || effType === 'todo') patch.approved = false
      updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? effType] ?? [] })
      const afterFm = parseDocFrontmatter(readTextSafe(abs) ?? text)
      const syncedBody = syncPlanDocBodyMeta(afterFm.body.replace(/^\n+/, ''), afterFm.data, {
        status: 'draft', today, critiquePassed: /^passed/i.test(String(afterFm.data?.plan_critique ?? '')),
      })
      const keyOrder = [...(DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? effType] ?? []), ...afterFm.keyOrder, ...Object.keys(afterFm.data)]
      writeAtomic(abs, `${serializeDocFrontmatter(afterFm.data, keyOrder)}\n${syncedBody.endsWith('\n') ? syncedBody : `${syncedBody}\n`}`)
    } else if (/^((?:-\s+)?Status:\s*)\S+/mi.test(text)) {
      writeAtomic(abs, text.replace(/^((?:-\s+)?Status:\s*)\S+(\s*)$/mi, '$1draft$2'))
    }
  }
  const continuedObj = {
    active: true,
    reason: cleanReason,
    by: String(by ?? 'human-maintainer').trim() || 'human-maintainer',
    at: new Date().toISOString(),
    sha: digest,
    fromSha: digest,
    roundBaseline,
    roundsAtContinue: priorRounds.map((r) => r.round),
  }

  await persistPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId: taskId ?? fm.data?.task_id ?? null, fmData: fm.data, relDoc,
    entry: {
      ...(priorEntry ?? {}),
      rounds: priorRounds,
      continued: continuedObj,
      updatedAt: continuedObj.at,
    },
  })

  return {
    ok: true,
    status: 'CRITIQUE_CONTINUE_RECORDED',
    file: relDoc,
    docType: effType,
    sha: digest,
    fromSha: digest,
    roundBaseline,
    approvalRevoked: wasApproved,
    continued: continuedObj,
    unlockApprove: false,
    excludedReviewers: collectExcludedReviewers(priorRounds, fm.data?.owner),
    nextStep: `修改 "${relDoc}" 后重跑 audit 并由新复核人执行 critique-reject/critique-pass（注意：critique-continue 不解锁 approve）`,
  }
}

/** C14: 人类维护者显式解锁规划停损（`critique-override --human-approved --reason`）。 */
export async function critiqueOverrideDoc({
  repoRoot, mainRoot = repoRoot, gitDir = null,
  file, humanApproved = false, reason = '', by = 'human-maintainer', docType = null, taskId = null,
}) {
  if (!humanApproved) throw makePlanError('MISSING_HUMAN_APPROVAL', EXIT.USAGE, 'critique-override 必须显式传入 --human-approved')
  const cleanReason = String(reason ?? '').trim()
  if (!cleanReason) throw makePlanError('MISSING_OVERRIDE_REASON', EXIT.USAGE, 'critique-override 必须传入非空 --reason "<裁决说明>"')

  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', EXIT.ACTION, `找不到文档：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw makePlanError('FILE_UNREADABLE', EXIT.ACTION, `无法读取文本文件：${file}`)

  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const digest = critiqueTextFingerprint(text)
  const { entry: priorEntry } = await readPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId, fmData: fm.data, relDoc,
  })
  const priorRounds = parseCritiqueRounds(fm.data, text, priorEntry)
  const overrideObj = {
    approved: true,
    reason: cleanReason,
    by: String(by ?? 'human-maintainer').trim() || 'human-maintainer',
    at: new Date().toISOString(),
    sha: digest,
    overriddenRounds: priorRounds.filter((r) => r.stopLossTriggered).map((r) => r.round),
  }
  if (fm.hasFrontmatter) {
    updateDocFrontmatter(abs, { [CRITIQUE_OVERRIDE_KEY]: JSON.stringify(overrideObj), updated: docIsoDate() }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? effType] ?? [] })
  } else {
    const line = `- Critique Override: ${JSON.stringify(overrideObj)}`
    let updated = text
    if (/^(?:-\s+)?Critique Override:.*$/mi.test(text)) updated = text.replace(/^(?:-\s+)?Critique Override:.*$/mi, line)
    else if (/^(?:-\s+)?Plan Critique:.*$/mi.test(text)) updated = text.replace(/^((?:-\s+)?Plan Critique:.*)$/mi, `$1\n${line}`)
    else if (/^(?:-\s+)?Status:.*$/mi.test(text)) updated = text.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${line}`)
    else updated = /^(#[^\n]*\n)/.test(text) ? text.replace(/^(#[^\n]*\n)/, `$1\n${line}\n`) : `${line}\n\n${text}`
    writeAtomic(abs, updated)
  }

  const resolvedContinued = priorEntry?.continued
    ? { ...priorEntry.continued, active: false, resolvedAt: overrideObj.at, resolvedBy: overrideObj.by }
    : undefined

  await persistPlanCritiqueEntry({
    repoRoot, mainRoot, gitDir, taskId: taskId ?? fm.data?.task_id ?? null, fmData: fm.data, relDoc,
    entry: { ...(priorEntry ?? {}), rounds: priorRounds, ...(resolvedContinued ? { continued: resolvedContinued } : {}), override: overrideObj, updatedAt: overrideObj.at },
  })

  return { ok: true, status: 'CRITIQUE_STOP_LOSS_OVERRIDDEN', file: relDoc, sha: digest, override: overrideObj, nextStep: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${relDoc}"` }
}
