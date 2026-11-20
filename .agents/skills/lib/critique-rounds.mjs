/**
 * critique-rounds.mjs —— 规划 Critique 作用域、全历史换人锁、三轮硬停损（与审查端单源共享）及 A4 防空转。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-plan 与 dev-review 共用。
 */

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { DOC_FRONTMATTER_KEY_ORDER, docIsoDate, parseDocFrontmatter, stripCritiqueMeta, updateDocFrontmatter } from './docs.mjs'
import { extractDocSnapshot } from './doc-substantive.mjs'
import { posixPath, readTextSafe, sha256Text, writeAtomic } from './git.mjs'
import { appendGovernSignal } from './signals.mjs'

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
      exitCode: 2,
      matchedRound: matched.round ?? null,
      matchedReviewer: matched.reviewerId ?? matched.reviewer,
      excludedReviewers,
      message: `${code}: Round ${effRound} ${subject}复核人 (${currentReviewerId}) 与历史 Round ${matched.round ?? '?'} 相同。`
        + `必须创建全新独立子代理复审（须排除：${excludedReviewers.join(', ') || currentReviewerId}）。`,
    }
  }
  return { blocked: false, excludedReviewers }
}

function normCritItemText(item) {
  return String(typeof item === 'string' ? item : (item?.text ?? item?.summary ?? item?.id ?? ''))
    .replace(/\s+/g, ' ').trim().toLowerCase()
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
} = {}) {
  const rNum = Number(round) || 1
  const vLow = String(verdict ?? '').toLowerCase()
  const isBlocking = vLow === 'changes' || vLow === 'reject' || vLow === 'rejected' || items.length > 0
  const maxRoundsExceeded = rNum >= maxRounds && isBlocking
  const sameFn = typeof matchesSame === 'function'
    ? matchesSame
    : (a, b) => {
        const ta = normCritItemText(a)
        const tb = normCritItemText(b)
        return Boolean(ta && tb && ta === tb)
      }
  const repeatedItems = (rNum >= 2 && Array.isArray(items) && items.length > 0 && Array.isArray(prevItems) && prevItems.length > 0)
    ? items.filter((it) => prevItems.some((pm) => sameFn(it, pm)))
    : []
  const repeatedTrigger = rNum >= 2 && repeatedItems.length > 0
  const stopLoss = (maxRoundsExceeded || repeatedTrigger) && !humanApproved
  const reasons = []
  if (maxRoundsExceeded) reasons.push(`round ${rNum} >= ${maxRounds} with unresolved verdict/blockers`)
  if (repeatedTrigger) reasons.push(`repeated blocker across consecutive rounds (${repeatedItems.length} item(s))`)
  return { stopLoss, maxRoundsExceeded, repeatedTrigger, repeatedItems, reasons, exitCode: stopLoss ? 4 : 0 }
}

/** 解析 `plan_critique` 单行印记（兼容旧格式）。 */
export function parseCritiqueStamp(stamp) {
  const raw = String(stamp ?? '').trim()
  if (!raw) return null
  const statusMatch = /^([a-z]+)/i.exec(raw)
  const reviewer = /reviewer=([^,)]+)/i.exec(raw)?.[1]?.trim() ?? null
  const roundRaw = /round=(\d+)/i.exec(raw)?.[1]
  const sha = /\bsha=([a-f0-9]{8,64})\b/i.exec(raw)?.[1]?.toLowerCase() ?? null
  const summary = /summary=([^)]*)/i.exec(raw)?.[1]?.trim() ?? null
  return {
    status: statusMatch ? statusMatch[1].toLowerCase() : null,
    reviewer,
    round: roundRaw ? Number(roundRaw) : null,
    sha,
    summary,
  }
}

/** 安全反序列化 Frontmatter 中的 `critique_rounds` 历史数组（兼容旧单行 `plan_critique` 回退）。 */
export function parseCritiqueRounds(fmData, rawText = '') {
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

/** 安全解析 Frontmatter 中的 `critique_override` 人类解锁记录。 */
export function parseCritiqueOverride(fmData) {
  const raw = fmData?.[CRITIQUE_OVERRIDE_KEY]
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw.trim())
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }
  return null
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
export function evaluateCritiqueOverride(rawText, fmData) {
  const override = parseCritiqueOverride(fmData)
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

/** 把一轮的意见存成一行（`;;` 分隔）。 */
export function serializeFindings(round, findings = []) {
  const parts = []
  for (const f of findings) {
    const text = String(typeof f === 'string' ? f : f?.text ?? '').replace(/[\r\n]+/g, ' ').replace(/;;/g, '；').trim()
    if (!text) continue
    const severity = String(typeof f === 'string' ? 'must' : (f?.severity ?? 'must')).trim() || 'must'
    parts.push(`${round}|${severity}|${text}`)
  }
  return parts.join(' ;; ')
}

/** 把存下来的历史解析回结构化记录。 */
export function parseFindings(raw) {
  const out = []
  for (const part of String(raw ?? '').split(';;')) {
    const seg = part.trim()
    if (!seg) continue
    const m = /^(\d+)\|([a-z]+)\|(.+)$/i.exec(seg)
    if (!m) continue
    out.push({ round: Number(m[1]), severity: m[2].toLowerCase(), text: m[3].trim() })
  }
  return out
}

/** 生成「这一轮要复核什么」的清单。 */
export function buildCritiqueScope({ round, currentSha, previousSha, findingsRaw, reviewer }) {
  const history = parseFindings(findingsRaw)
  const rounds = [...new Set(history.map((h) => h.round))].sort((a, b) => a - b)
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const lastFindings = history.filter((h) => h.round === lastRound)
  const changed = Boolean(previousSha && currentSha && String(previousSha) !== String(currentSha))

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
  lines.push('## 正文指纹', '', `- 当前：\`${currentSha ?? '(未计算)'}\``, `- 上轮：\`${previousSha ?? '(无记录)'}\``, '')
  return {
    prompt: `${lines.join('\n').trimEnd()}\n`,
    mustRecheck: lastFindings.map((f) => f.text),
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

function validateCritiqueActorAndHistory({ fmPre, rawPre, file, reviewer, round, digest, priorRounds, override, strictSameSha = false }) {
  if (!reviewer || !String(reviewer).trim()) {
    throw makePlanError('MISSING_REVIEWER', 2, 'critique 必须指定 --reviewer <reviewerId>')
  }
  if (fmPre.data?.owner && normActorId(fmPre.data.owner) && normActorId(fmPre.data.owner) === normActorId(reviewer)) {
    throw makePlanError('SELF_CRITIQUE_REJECTED', 2, `SELF_CRITIQUE_REJECTED: 规划 Critique 独立复核人 (${reviewer}) 不得与文档负责人 (${fmPre.data.owner}) 相同`)
  }
  const hasPriorStopLoss = priorRounds.some((r) => Boolean(r.stopLossTriggered))
  if (hasPriorStopLoss && !override?.approved) {
    throw makePlanError(
      'STOP_LOSS_ESCALATE', 4,
      `STOP_LOSS_ESCALATE: ${file} 历史规划审查已触发停损且未获人类解锁；请运行 \`doc-plan.mjs critique-override --file "${file}" --human-approved --reason "..."\`。`,
      { file, excludedReviewers: collectExcludedReviewers(priorRounds, fmPre.data?.owner) },
    )
  }
  const effectiveRound = round !== null && round !== undefined
    ? Number(round)
    : (priorRounds.reduce((m, r) => Math.max(m, Number(r?.round) || 0), 0) + 1)
  const reviewerLock = checkDistinctRoundReviewer(priorRounds, reviewer, {
    minRound: 2,
    currentRound: effectiveRound,
    code: 'BLOCKED_CRITIQUE_SAME_REVIEWER',
    subject: '规划 Critique',
  })
  if (reviewerLock.blocked) {
    throw makePlanError('BLOCKED_CRITIQUE_SAME_REVIEWER', 2, reviewerLock.message, {
      file, round: effectiveRound, excludedReviewers: reviewerLock.excludedReviewers,
    })
  }
  const prevRound = priorRounds.filter((r) => Number(r.round) < effectiveRound).at(-1) ?? null
  const prevBaselineSha = prevRound?.artifact_baseline?.shortSha ?? prevRound?.sha ?? parseCritiqueStamp(fmPre.data?.plan_critique)?.sha
  if (effectiveRound >= 2 && (strictSameSha || prevRound) && prevBaselineSha && prevBaselineSha === digest) {
    throw makePlanError(
      'BLOCKED_CRITIQUE_SAME_SHA', 2,
      `BLOCKED_CRITIQUE_SAME_SHA (BLOCKED_NO_REWORK_CHANGES): ${file} Round ${effectiveRound} 正文与上一轮完全一致 (sha=${digest})，必须先修改文档再复核。`,
      { file, round: effectiveRound, sha: digest, excludedReviewers: reviewerLock.excludedReviewers },
    )
  }
  return { effectiveRound, prevRound, excludedReviewers: reviewerLock.excludedReviewers }
}

/** 记录规划 Critique 通过（含自审拦截、全历史换人锁、A4 正文变动锁与历史停损校验）。 */
export async function critiquePassDoc({
  repoRoot, mainRoot = repoRoot, gitDir = null, isGit = false,
  file, reviewer, round = null, summary = '', findings = [], auditDoc = null, docType = null,
}) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', 1, `找不到文档：${file}`)
  const rawPre = readTextSafe(abs)
  if (rawPre === undefined) throw makePlanError('FILE_UNREADABLE', 1, `无法读取文本文件：${file}`)

  const fmPre = parseDocFrontmatter(rawPre)
  const priorRounds = parseCritiqueRounds(fmPre.data, rawPre)
  const override = parseCritiqueOverride(fmPre.data)
  const snapPre = extractDocSnapshot(rawPre)
  const baselinePre = computePlanArtifactBaseline(rawPre, snapPre)

  const { effectiveRound, excludedReviewers } = validateCritiqueActorAndHistory({
    fmPre, rawPre, file, reviewer, round, digest: baselinePre.shortSha, priorRounds, override,
  })

  if (typeof auditDoc === 'function') {
    const audit = auditDoc({ repoRoot, file })
    if (!audit.ok) {
      const err = new Error(`文档尚有 ${audit.errors.length} 处审计问题未自净化，禁止记录 critique-pass`)
      err.audit = audit
      err.exitCode = 1
      throw err
    }
  }

  const text = readTextSafe(abs) ?? rawPre
  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const snap = extractDocSnapshot(text)
  const baseline = computePlanArtifactBaseline(text, snap)
  const digest = baseline.shortSha
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const stampValue = `passed (reviewer=${String(reviewer).trim()}, round=${effectiveRound}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`

  const findingList = (Array.isArray(findings) ? findings : [findings]).map((f) => String(f ?? '').trim()).filter(Boolean)
  const prevFindingsRaw = fm.data?.[CRITIQUE_FINDINGS_KEY]
  const newFindingsRaw = findingList.length > 0
    ? [String(prevFindingsRaw ?? '').trim(), serializeFindings(effectiveRound, findingList)].filter(Boolean).join(' ;; ')
    : (prevFindingsRaw ?? null)

  const nextRounds = [...priorRounds.filter((r) => Number(r.round) !== effectiveRound), {
    round: effectiveRound, verdict: 'passed', reviewerId: String(reviewer).trim(),
    sha: digest, artifact_baseline: baseline, summary: cleanSummary || null,
    findings: findingList, stopLossTriggered: false, recordedAt: new Date().toISOString(),
  }].sort((a, b) => Number(a.round) - Number(b.round))

  const patch = {
    plan_critique: stampValue,
    critique_anchors: JSON.stringify(snap),
    [CRITIQUE_ROUNDS_KEY]: JSON.stringify(nextRounds),
    updated: docIsoDate(),
  }
  if (newFindingsRaw) patch[CRITIQUE_FINDINGS_KEY] = newFindingsRaw
  persistCritiqueFrontmatter(abs, text, fm, effType, patch)

  if (isGit || existsSync(resolve(mainRoot, '.git'))) {
    await appendGovernSignal({
      mainRoot, gitDir, isGit: Boolean(isGit || existsSync(resolve(mainRoot, '.git'))),
      category: 'plan', module: 'plan', pattern: 'plan.critique-pass', severity: 'info',
      source: 'doc-plan', file: relDoc, round: effectiveRound, verdict: 'pass',
      message: `critique-pass round ${effectiveRound} by ${reviewer}`,
    }).catch(() => {})
  }

  return {
    ok: true, file: relDoc, reviewer: String(reviewer).trim(), round: effectiveRound, sha: digest,
    summary: cleanSummary || null, status: 'passed',
    excludedReviewers: collectExcludedReviewers(nextRounds, fm.data?.owner),
  }
}

/**
 * C14: 记录规划 Critique 驳回；同步校验自审/换人/同 SHA，并在 Round >= 3 或连续同因时触发退出码 4 停损。
 */
export async function critiqueRejectDoc({
  repoRoot, mainRoot = repoRoot, gitDir = null, isGit = false,
  file, reviewer, round = null, summary = '', findings = [], docType = null, taskId = null,
}) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', 1, `找不到文档：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw makePlanError('FILE_UNREADABLE', 1, `无法读取文本文件：${file}`)

  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const priorRounds = parseCritiqueRounds(fm.data, text)
  const override = parseCritiqueOverride(fm.data)
  const snap = extractDocSnapshot(text)
  const baseline = computePlanArtifactBaseline(text, snap)
  const digest = baseline.shortSha

  const { effectiveRound, prevRound } = validateCritiqueActorAndHistory({
    fmPre: fm, rawPre: text, file, reviewer, round, digest, priorRounds, override, strictSameSha: true,
  })

  const findingList = (Array.isArray(findings) ? findings : [findings]).map((f) => String(f ?? '').trim()).filter(Boolean)
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const evalItems = findingList.length > 0 ? findingList : (cleanSummary ? [cleanSummary] : [])
  const prevItems = Array.isArray(prevRound?.findings) && prevRound.findings.length > 0
    ? prevRound.findings
    : (prevRound?.summary ? [prevRound.summary] : [])

  const sl = evaluateThreeRoundStopLoss({
    round: effectiveRound, verdict: 'reject', items: evalItems, prevItems, humanApproved: Boolean(override?.approved),
  })

  const stampValue = `rejected (reviewer=${String(reviewer).trim()}, round=${effectiveRound}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`
  const prevFindingsRaw = fm.data?.[CRITIQUE_FINDINGS_KEY]
  const newFindingsRaw = evalItems.length > 0
    ? [String(prevFindingsRaw ?? '').trim(), serializeFindings(effectiveRound, evalItems)].filter(Boolean).join(' ;; ')
    : (prevFindingsRaw ?? null)

  const nextRounds = [...priorRounds.filter((r) => Number(r.round) !== effectiveRound), {
    round: effectiveRound, verdict: 'rejected', reviewerId: String(reviewer).trim(),
    sha: digest, artifact_baseline: baseline, summary: cleanSummary || null,
    findings: evalItems, stopLossTriggered: sl.stopLoss, stopLossReasons: sl.reasons,
    recordedAt: new Date().toISOString(),
  }].sort((a, b) => Number(a.round) - Number(b.round))

  const patch = {
    plan_critique: stampValue,
    critique_anchors: JSON.stringify(snap),
    [CRITIQUE_ROUNDS_KEY]: JSON.stringify(nextRounds),
    updated: docIsoDate(),
  }
  if (newFindingsRaw) patch[CRITIQUE_FINDINGS_KEY] = newFindingsRaw
  persistCritiqueFrontmatter(abs, text, fm, effType, patch)

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
  const nextStep = sl.stopLoss
    ? `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-override --file "${relDoc}" --human-approved --reason "<维护者裁决原因>"`
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
        recoveryCommand: nextStep,
      }
    : null

  return {
    ok: !sl.stopLoss,
    status: sl.stopLoss ? 'STOP_LOSS_ESCALATE' : 'CRITIQUE_REJECTED',
    exitCode: sl.stopLoss ? 4 : 0,
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

/** C14: 人类维护者显式解锁规划停损（`critique-override --human-approved --reason`）。 */
export function critiqueOverrideDoc({
  repoRoot, file, humanApproved = false, reason = '', by = 'human-maintainer', docType = null,
}) {
  if (!humanApproved) throw makePlanError('MISSING_HUMAN_APPROVAL', 2, 'critique-override 必须显式传入 --human-approved')
  const cleanReason = String(reason ?? '').trim()
  if (!cleanReason) throw makePlanError('MISSING_OVERRIDE_REASON', 2, 'critique-override 必须传入非空 --reason "<裁决说明>"')

  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw makePlanError('FILE_NOT_FOUND', 1, `找不到文档：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw makePlanError('FILE_UNREADABLE', 1, `无法读取文本文件：${file}`)

  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const effType = docType ?? inferDocTypeLight(relDoc, fm.data)
  const digest = critiqueTextFingerprint(text)
  const priorRounds = parseCritiqueRounds(fm.data, text)
  const overrideObj = {
    approved: true,
    reason: cleanReason,
    by: String(by ?? 'human-maintainer').trim() || 'human-maintainer',
    at: new Date().toISOString(),
    sha: digest,
    overriddenRounds: priorRounds.filter((r) => r.stopLossTriggered).map((r) => r.round),
  }
  if (fm.hasFrontmatter) {
    updateDocFrontmatter(abs, {
      [CRITIQUE_OVERRIDE_KEY]: JSON.stringify(overrideObj),
      updated: docIsoDate(),
    }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? effType] ?? [] })
  }
  return {
    ok: true,
    status: 'CRITIQUE_STOP_LOSS_OVERRIDDEN',
    file: relDoc,
    sha: digest,
    override: overrideObj,
    nextStep: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${relDoc}"`,
  }
}
