/**
 * review-sync.mjs —— 将独立审查结果按 `TaskBackend` 通道双写回远端 PR/Issue 或本地工单。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），远端写入前强制经 `probeForWrite` 探测通道。
 * 显式汇总评论与标签同步状态，并对 PR 审查单中的验收标准逐条核对表做无损 Markdown 表格安全化。
 */

import { buildReviewComments, formatAttribution } from '../../lib/docs.mjs'
import { buildEscalationIssuePayload, classifyEscalationTier } from '../../lib/escalation.mjs'
import { gitRun, posixPath } from '../../lib/git.mjs'
import { readGitConfigFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import {
  detectDeclaredRepo, getHostingProvider, isVerifiedTier,
  parsePrNumber, parseRemoteUrls, probeForWrite, resolveIdentityLayers, resolveRemoteTarget,
} from '../../lib/platform.mjs'
import { extractCriteriaFromBodyText } from '../../lib/plan-sync.mjs'
import { computeSignalFingerprint, inferDefectClass, inferSignalModule } from '../../lib/signals.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { parseAcceptanceCriteria } from './review-gates.mjs'

const ISSUE_TITLE_MAX = 72
const FILE_REF_RE = /\b((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?\b/

/** 无损安全化 Markdown 表格单元格：仅折行并转义未转义竖线，完整保留全部条款原文不做任何截断。 */
export function sanitizeReviewTableCell(rawText) {
  return String(rawText ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/(?<!\\)\|/g, '\\|')
    .trim()
}

/** 无损安全化 PR 审查评论中「验收标准逐条核对」表格单元格（仅折叠换行并转义未转义竖线，零截断）。 */
export function formatReviewCriteriaTable(prCommentBody) {
  const lines = String(prCommentBody ?? '').split('\n')
  let inCriteriaTable = false
  const out = []
  for (const line of lines) {
    if (/^####\s+验收标准逐条核对(?:\s|$)/.test(line)) {
      inCriteriaTable = true
      out.push(line)
      continue
    }
    if (inCriteriaTable) {
      if (/^#{2,6}\s+/.test(line)) {
        inCriteriaTable = false
        out.push(line)
        continue
      }
      const rowM = /^\|\s*(C\d+[^|]*?)\s*\|\s*(PASS|FAIL)\s*\|\s*(.+?)\s*\|$/.exec(line)
      if (rowM) {
        const safeCell = sanitizeReviewTableCell(rowM[3])
        out.push(`| ${rowM[1].trim()} | ${rowM[2].trim()} | ${safeCell} |`)
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

function formatShortIssueTitle(rawText, maxChars = ISSUE_TITLE_MAX) {
  const clean = String(rawText ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`
}

/** 汇总评论与标签双写结果，防止忽略 `labelRes` 失败或降级。 */
export function summarizeLabelSyncStatus(results = []) {
  const labelWarnings = []
  let labelDegraded = false
  let checkedLabels = 0
  for (const r of results) {
    if (!r || r.label === undefined || r.label === null) continue
    checkedLabels += 1
    const addRes = r.label.addRes
    const degraded = Boolean(r.label.degraded || addRes?.degraded)
    if (degraded) labelDegraded = true
    const failed = r.label.ok === false || addRes?.ok === false
    if (failed) {
      const reason = r.label.error || addRes?.error || (degraded ? 'degraded (permission/403)' : 'label sync failed')
      labelWarnings.push(`${r.kind}#${r.number}: ${reason}`)
    }
  }
  const labelSynced = checkedLabels === 0 ? true : labelWarnings.length === 0
  return { labelSynced, labelDegraded, labelWarnings }
}

function parseAdvisoryCandidate(raw, defaultKind) {
  if (raw && typeof raw === 'object') {
    const summary = String(raw.summary ?? raw.message ?? raw.text ?? raw.title ?? '').trim()
    const file = posixPath(raw.file ?? (FILE_REF_RE.exec(summary)?.[1] ?? ''))
    return {
      ...raw,
      summary,
      file,
      outOfScope: Boolean(raw.outOfScope || defaultKind === 'out-of-scope'),
      preExisting: Boolean(raw.preExisting || defaultKind === 'pre-existing'),
    }
  }
  const text = String(raw ?? '').trim()
  if (!text) return null
  const fileMatch = FILE_REF_RE.exec(text)
  const file = fileMatch ? posixPath(fileMatch[1]) : ''
  const line = fileMatch?.[2] ? Number(fileMatch[2]) : undefined
  const low = text.toLowerCase()
  const severity = /\[(?:critical|p0|sev0)\]/i.test(text) ? 'critical'
    : /\[(?:high|p1|sev1|security|vuln)\]/i.test(text) ? 'high'
      : /\[(?:medium|p2)\]/i.test(text) ? 'medium' : 'low'
  const outOfScope = defaultKind === 'out-of-scope' || /\[out-of-scope\]|范围外/i.test(text)
  const crossModule = /\[cross-module\]|跨模块/i.test(text)
  const highRisk = /\[(?:high-risk|security|one-way)\]|高风险|安全漏洞/i.test(text)
  const doorType = /\[one-way\]|单向门/i.test(text) ? 'one-way' : 'two-way'
  const recurrenceCount = /\b(?:recurrence|repeat|复发)\s*[:=]?\s*([2-9]|\d{2,})/i.test(low) ? 2 : 1
  return {
    summary: text,
    file,
    ...(Number.isInteger(line) ? { line } : {}),
    severity,
    outOfScope,
    preExisting: defaultKind === 'pre-existing',
    crossModule,
    highRisk,
    doorType,
    recurrenceCount,
    singleFile: !crossModule,
    inScope: !outOfScope,
  }
}

/**
 * 普通审查（非停损）范围外/存量发现确定性分级升级：
 * 仅对命中 `classifyEscalationTier(item) === 'escalated-issue'` 的条目按指纹去重生成建单载荷。
 */
export function collectNormalReviewEscalations({
  preExistingList = [],
  outOfScopeList = [],
  mustFixList = [],
  taskId = '',
  round = 1,
  milestone = undefined,
} = {}) {
  const rawCandidates = [
    ...(Array.isArray(outOfScopeList) ? outOfScopeList.map((x) => parseAdvisoryCandidate(x, 'out-of-scope')) : []),
    ...(Array.isArray(preExistingList) ? preExistingList.map((x) => parseAdvisoryCandidate(x, 'pre-existing')) : []),
    ...(Array.isArray(mustFixList)
      ? mustFixList.filter((m) => m && (m.outOfScope || m.preExisting)).map((m) => parseAdvisoryCandidate(m, m.outOfScope ? 'out-of-scope' : 'pre-existing'))
      : []),
  ].filter((c) => c && c.summary)

  const seenFingerprints = new Set()
  const items = []
  const payloads = []

  for (const cand of rawCandidates) {
    const tier = classifyEscalationTier({
      source: 'review',
      severity: cand.severity,
      outOfScope: cand.outOfScope,
      crossModule: cand.crossModule,
      highRisk: cand.highRisk,
      doorType: cand.doorType,
      caseType: cand.caseType,
      recurrenceCount: cand.recurrenceCount,
      singleFile: cand.singleFile,
      inScope: cand.inScope,
      files: cand.file ? [cand.file] : (Array.isArray(cand.files) ? cand.files : []),
      forceIssue: Boolean(cand.forceIssue),
      e2eBlocking: Boolean(cand.e2eBlocking),
    })
    if (tier !== 'escalated-issue') continue

    const moduleRoot = inferSignalModule(cand.file)
    const defectClass = inferDefectClass({
      ruleId: cand.outOfScope ? 'review.out-of-scope' : 'review.pre-existing',
      pattern: cand.outOfScope ? 'review.out-of-scope' : 'review.pre-existing',
      category: 'review',
      message: cand.summary,
    })
    const ruleId = cand.ruleId || (cand.outOfScope ? 'review.out-of-scope' : 'review.pre-existing')
    const fingerprint = cand.fingerprint || computeSignalFingerprint({
      ruleId: `${ruleId}:${cand.summary.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim().slice(0, 64)}`,
      defectClass,
      moduleRoot,
    })
    if (seenFingerprints.has(fingerprint)) continue
    seenFingerprints.add(fingerprint)

    const shortSummary = formatShortIssueTitle(cand.summary, ISSUE_TITLE_MAX)
    const escalationItem = {
      source: 'review',
      outOfScope: cand.outOfScope,
      severity: cand.severity || 'high',
      caseType: cand.caseType ?? (cand.highRisk || cand.crossModule ? 3 : 2),
      taskId,
      category: defectClass,
      title: `${cand.outOfScope ? 'review out-of-scope' : 'review pre-existing'} [fp:${fingerprint}] ${shortSummary}`,
      summary: cand.summary,
      rootCause: `普通审查 Round ${round} 发现范围外/存量高危问题（fingerprint=${fingerprint}，module=${moduleRoot}），独立建单跟进根治，不阻塞当前切片边界。`,
      criteria: [`根治 [${fingerprint}] ${cand.summary} 并补齐双向回归测试`],
      labels: ['escalation', cand.outOfScope ? 'out-of-scope' : 'pre-existing'],
      ...(milestone !== undefined ? { milestone } : {}),
    }
    const payload = { ...buildEscalationIssuePayload(escalationItem), fingerprint, defectClass, moduleRoot }
    items.push({ ...escalationItem, fingerprint, defectClass, moduleRoot })
    payloads.push(payload)
  }

  return { items, payloads }
}

export function buildCriteriaStatusSummary({ workTreeRoot, mainRoot, ledger, verdict, headSha, mustFixList, explicitStatus, parsedCriteria }) {
  if (explicitStatus && String(explicitStatus).trim()) return String(explicitStatus).trim()
  const criteria = parsedCriteria ?? parseAcceptanceCriteria(workTreeRoot, mainRoot, ledger)
  const allIds = criteria.map((c) => c.id)
  if (verdict === 'pass') {
    return allIds.length > 0
      ? `fail: 无 / pass: ${allIds.join(', ')}`
      : `fail: 无 / pass: 全部已核验项 (HEAD ${String(headSha ?? '').slice(0, 7)})`
  }
  const failIds = new Set()
  for (const m of mustFixList) {
    if (m.criterion) failIds.add(m.criterion.toUpperCase())
    else {
      for (const cm of String(m.summary ?? '').matchAll(/\b(C\d+)\b/gi)) {
        failIds.add(cm[1].toUpperCase())
      }
    }
  }
  const passIds = allIds.filter((id) => !failIds.has(id))
  const failList = failIds.size > 0
    ? [...failIds]
    : (mustFixList.length > 0 ? mustFixList.map((m) => m.id) : ['未满足全部验收条件'])
  return `fail: ${failList.join(', ')}${passIds.length > 0 ? ` / pass: ${passIds.join(', ')}` : ''}`
}

async function hydrateCriteriaFromBackend(criteria, { backend, repo = null, issueNums = [] } = {}) {
  if (criteria.length > 0 || !backend || typeof backend.getIssue !== 'function') return criteria
  const out = [...criteria]
  const seen = new Set(out.map((c) => c.id))
  for (const num of issueNums) {
    const res = await Promise.resolve(backend.getIssue({ ...(repo ? { repo } : {}), number: num })).catch(() => null)
    if (!res?.ok || !res.body) continue
    for (const item of extractCriteriaFromBodyText(res.body, `issue#${num}`, { seen, allowUnnumbered: true })) {
      out.push(item)
    }
  }
  return out
}

function resolveFaultInjectionSummary(opts = {}, ledger = {}) {
  const explicit = String(opts['fault-injection'] ?? '').trim()
  if (explicit) return explicit
  const fr = ledger?.faultRecord
  if (fr && fr.restoredAt) {
    return `已通过两阶段故障注入与干净还原（round=${fr.round ?? '-'}, failed=${fr.failedCmd ?? 'injected'}, restoredAt=${fr.restoredAt}）`
  }
  return '未触及高风险路径或未附额外故障注入摘要'
}

export async function syncReviewToGitHub({
  mainRoot, workTreeRoot, ledger, round, verdict, headSha, reviewerId, implementerId,
  empiricalSummary: empiricalSummaryArg = '', summary: summaryArg = '', stopLoss, stopReasons, mustFixList, shouldFixList, preExistingList = [],
  rebuttedItems = [], resolvedItems = [], nextSteps = [], opts = {},
}) {
  const prNum = parsePrNumber(ledger.prNumber)
  const issueNums = Array.isArray(ledger.linkedIssues)
    ? [...new Set(ledger.linkedIssues.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
    : []

  if (!prNum && issueNums.length === 0) {
    return { synced: false, labelSynced: true, labelWarnings: [], skipped: true, reason: 'no-linked-pr-or-issue' }
  }

  const empiricalSummary = String(empiricalSummaryArg || ledger.reviewEmpirical || opts?.evidence || '').trim()
  const reviewSummary = String(summaryArg || opts?.summary || '').trim()
  const isLocalBackendRole = ledger.role === 'local-only'
    || ledger.role === 'generic-git'
    || ledger.providerId === 'generic-git'
    || ledger.providerId === 'none'

  if (isLocalBackendRole) {
    if (issueNums.length === 0) {
      return { synced: false, labelSynced: true, labelWarnings: [], skipped: true, reason: `role-${ledger.role ?? 'local'}` }
    }
    const backend = createTaskBackend({
      role: ledger.role, providerId: ledger.providerId ?? 'none', mainRoot, gitDir: opts.gitDir,
    })
    const revLayers = resolveIdentityLayers({ explicitAgent: reviewerId })
    const implLayers = resolveIdentityLayers({
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? implementerId ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const reviewerDisplay = formatAttribution({ ...revLayers, capabilities: backend.capabilities })
    const implementerDisplay = formatAttribution({ ...implLayers, capabilities: backend.capabilities })
    const parsedCriteria = parseAcceptanceCriteria(workTreeRoot, mainRoot, ledger, { gitDir: opts.gitDir })
    const criteria = await hydrateCriteriaFromBackend(parsedCriteria, { backend, issueNums })
    const criteriaStatusText = buildCriteriaStatusSummary({
      workTreeRoot, mainRoot, ledger, verdict, headSha, mustFixList,
      explicitStatus: opts['criteria-status'], parsedCriteria: criteria,
    })
    const faultInjectionText = resolveFaultInjectionSummary(opts, ledger)
    const labelName = verdict === 'changes' ? 'changes-requested' : 'reviewed'
    const staleLabel = verdict === 'changes' ? 'reviewed' : 'changes-requested'
    const statePayload = {
      taskId: ledger.taskId, action: 'review', round, verdict, headSha, reviewerId, stopLossTriggered: stopLoss,
    }
    const builtLocal = buildReviewComments({
      round, verdict, baseSha: ledger.baseSha, headSha,
      reviewerDisplay, implementerDisplay, empiricalSummary, summary: reviewSummary,
      criteria, criteriaStatusText, faultInjectionText, stopLoss, stopReasons,
      mustFixList, shouldFixList, preExistingList, rebuttedItems, resolvedItems,
      prNum, labelName, staleLabel, role: ledger.role, nextSteps, statePayload,
    })
    const issueCommentBody = formatReviewCriteriaTable(builtLocal.issueCommentBody)
    const results = []
    const syncFailures = []
    for (const num of issueNums) {
      try {
        const commentRes = await backend.postComment({
          taskId: ledger.taskId, number: num, body: issueCommentBody, author: reviewerId, statePayload,
        })
        const labelRes = typeof backend.syncStateLabel === 'function'
          ? await backend.syncStateLabel({ taskId: ledger.taskId, number: num, state: labelName })
          : await (async () => {
              const addR = await backend.addLabels({ taskId: ledger.taskId, number: num, labels: [labelName] })
              await backend.removeLabel({ taskId: ledger.taskId, number: num, label: staleLabel })
              return addR
            })()
        results.push({ kind: 'issue', number: num, comment: commentRes, label: labelRes })
        if (!commentRes?.ok) {
          syncFailures.push({ target: `issue#${num}`, phase: 'review', error: commentRes?.error || commentRes?.reason || 'comment_failed' })
        }
      } catch (err) {
        const msg = err?.message ?? String(err)
        results.push({ kind: 'issue', number: num, comment: { ok: false, error: msg }, label: { ok: false, error: msg } })
        syncFailures.push({ target: `issue#${num}`, phase: 'review', error: msg })
      }
    }
    const synced = results.length > 0 && results.every((r) => r.comment?.ok)
    const { labelSynced, labelDegraded, labelWarnings } = summarizeLabelSyncStatus(results)
    return {
      synced,
      labelSynced,
      fullySynced: synced && labelSynced,
      labelDegraded,
      labelWarnings,
      syncFailures,
      local: true,
      label: labelName,
      results,
      ...(!labelSynced ? { hint: `评论已写但标签同步失败或降级：${labelWarnings.join('；')}` } : {}),
    }
  }

  let delegatedPayloads = null
  try {
    const fastCfg = readGitConfigFast(opts.gitDir ?? resolveGitDirFast(mainRoot))
    const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(mainRoot, ['remote', '-v'])
    const hasRemote = Boolean(remoteRes.ok && remoteRes.stdout.trim())
    const remoteUrls = hasRemote ? parseRemoteUrls(remoteRes.stdout) : {}
    const declaredRepo = detectDeclaredRepo(mainRoot)
    const remoteTarget = hasRemote
      ? resolveRemoteTarget(remoteUrls, { role: ledger.role, declaredRepo, providerHint: ledger.providerId, cwd: mainRoot })
      : { providerId: 'none', repoSlug: null, capabilities: { api: false, mention: false } }
    const targetRepo = remoteTarget.repoSlug ?? declaredRepo ?? null

    const ghProbe = hasRemote
      ? (opts._ghProbe ?? (await probeForWrite({ cwd: mainRoot, remoteUrls })))
      : (opts._ghProbe ?? null)
    const ghClient = opts._ghClient ?? ghProbe?.client ?? null
    const tier = ghClient?.tier ?? ghProbe?.env?.trackB?.tier ?? 'offline'
    const ghLogin = ghProbe?.env?.trackB?.login
    const effectiveProvider = ledger.providerId && ledger.providerId !== 'none'
      ? ledger.providerId
      : (remoteTarget.providerId !== 'none' ? remoteTarget.providerId : (ledger.role === 'local-only' ? 'none' : 'generic-git'))
    const providerCaps = getHostingProvider(effectiveProvider)?.capabilities ?? remoteTarget.capabilities ?? { mention: false }
    const revLayers = resolveIdentityLayers({ ghLogin, ghTier: tier, explicitAgent: reviewerId })
    const implLayers = resolveIdentityLayers({
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? implementerId ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const reviewerDisplay = formatAttribution({ ...revLayers, capabilities: providerCaps })
    const implementerDisplay = formatAttribution({ ...implLayers, capabilities: providerCaps })
    const backend = createTaskBackend({
      role: ledger.role, providerId: effectiveProvider, targetRepo,
      client: ghClient, mainRoot, gitDir: opts.gitDir,
    })

    const hasApiSupport = Boolean(opts._ghClient || providerCaps?.api === true || remoteTarget.capabilities?.api === true)
    const canFetchRemoteIssue = Boolean(hasRemote && targetRepo && hasApiSupport && isVerifiedTier(tier))
    const parsedCriteria = parseAcceptanceCriteria(workTreeRoot, mainRoot, ledger, { gitDir: opts.gitDir })
    const criteria = canFetchRemoteIssue
      ? await hydrateCriteriaFromBackend(parsedCriteria, { backend, repo: targetRepo, issueNums })
      : parsedCriteria
    const criteriaStatusText = buildCriteriaStatusSummary({
      workTreeRoot, mainRoot, ledger, verdict, headSha, mustFixList,
      explicitStatus: opts['criteria-status'], parsedCriteria: criteria,
    })
    const faultInjectionText = resolveFaultInjectionSummary(opts, ledger)
    const labelName = verdict === 'changes' ? 'changes-requested' : 'reviewed'
    const staleLabel = verdict === 'changes' ? 'reviewed' : 'changes-requested'
    const statePayload = {
      taskId: ledger.taskId, action: 'review', round, verdict, headSha, reviewerId,
      ...(revLayers.account ? { account: revLayers.account, verifiedPlatformLogin: revLayers.verifiedPlatformLogin } : {}),
      stopLossTriggered: stopLoss,
    }

    const built = buildReviewComments({
      round, verdict, baseSha: ledger.baseSha, headSha,
      reviewerDisplay, implementerDisplay, empiricalSummary, summary: reviewSummary, criteria, criteriaStatusText,
      faultInjectionText, stopLoss, stopReasons, mustFixList, shouldFixList, preExistingList,
      rebuttedItems, resolvedItems, prNum, labelName, staleLabel, role: ledger.role, nextSteps, statePayload,
    })
    const prCommentBody = formatReviewCriteriaTable(built.prCommentBody)
    const issueCommentBody = formatReviewCriteriaTable(built.issueCommentBody)
    const { stateTag } = built
    const targets = [
      ...(prNum ? [{ kind: 'pr', number: prNum }] : []),
      ...issueNums.filter((n) => n !== prNum).map((n) => ({ kind: 'issue', number: n })),
    ]
    delegatedPayloads = {
      targetRepo,
      label: labelName,
      staleLabel,
      targets: targets.map((t) => {
        const rawBody = t.kind === 'pr' ? prCommentBody : issueCommentBody
        return {
          kind: t.kind,
          number: t.number,
          body: stateTag ? `${rawBody}\n\n${stateTag}` : rawBody,
          rawBody,
          statePayload,
          addLabels: [labelName],
          removeLabels: [staleLabel],
        }
      }),
    }

    if (!hasRemote) {
      return {
        synced: false, labelSynced: false, labelWarnings: [], offlineOrNoCreds: true, reason: 'no-remote', targetRepo, delegatedPayloads,
        hint: '未配置远端，审查结论已安全保存至本地账本并附规范评论载荷（不阻塞离线使用）。',
      }
    }
    if (!targetRepo) {
      return { synced: false, labelSynced: false, labelWarnings: [], skipped: true, reason: 'no-github-repo', delegatedPayloads, hint: '非 GitHub 远端，审查结论已写入本地账本。' }
    }
    if ((!opts._ghClient && !hasApiSupport) || !isVerifiedTier(tier)) {
      return {
        synced: false, labelSynced: false, labelWarnings: [], offlineOrNoCreds: true, tier, targetRepo,
        reason: `offline-or-no-credentials(${tier})`, delegatedPayloads,
        hint: `离线或无可用托管平台凭据（tier=${tier}），已写入本地账本并输出规范化 delegatedPayloads 供宿主原样双写。`,
      }
    }

    const results = []
    const syncFailures = []
    for (const t of targets) {
      const isPrTarget = t.kind === 'pr'
      const targetBody = isPrTarget ? prCommentBody : issueCommentBody
      try {
        const commentRes = await backend.postComment({
          repo: targetRepo, number: t.number, isPr: isPrTarget, body: targetBody, statePayload,
        })
        const labelRes = typeof backend.syncStateLabel === 'function'
          ? await backend.syncStateLabel({ repo: targetRepo, number: t.number, state: labelName, isPr: isPrTarget })
          : await (async () => {
              const addR = await backend.addLabels({ repo: targetRepo, number: t.number, labels: [labelName], isPr: isPrTarget })
              await backend.removeLabel({ repo: targetRepo, number: t.number, label: staleLabel, isPr: isPrTarget })
              return addR
            })()
        results.push({ kind: t.kind, number: t.number, comment: commentRes, label: labelRes })
        if (!commentRes?.ok) {
          syncFailures.push({ target: `${t.kind}#${t.number}`, phase: 'review', error: commentRes?.error || commentRes?.reason || 'comment_failed' })
        }
      } catch (err) {
        const msg = err?.message ?? String(err)
        results.push({ kind: t.kind, number: t.number, comment: { ok: false, error: msg }, label: { ok: false, error: msg } })
        syncFailures.push({ target: `${t.kind}#${t.number}`, phase: 'review', error: msg })
      }
    }

    const synced = results.length > 0 && results.every((r) => r.comment?.ok)
    const { labelSynced, labelDegraded, labelWarnings } = summarizeLabelSyncStatus(results)
    const hints = []
    if (!synced) hints.push('远端评论同步未成功（可能处于离线或无写权限环境），审查结论已写入本地账本，请使用 delegatedPayloads 原样双写。')
    if (!labelSynced) hints.push(`标签同步失败或降级：${labelWarnings.join('；')}`)
    return {
      synced,
      labelSynced,
      fullySynced: synced && labelSynced,
      labelDegraded,
      labelWarnings,
      syncFailures,
      targetRepo,
      label: labelName,
      delegatedPayloads,
      results,
      ...(!synced ? { offlineOrNoCreds: true } : {}),
      ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
    }
  } catch (err) {
    return {
      synced: false,
      labelSynced: false,
      labelWarnings: [],
      offlineOrNoCreds: true,
      ...(delegatedPayloads ? { delegatedPayloads } : {}),
      error: err instanceof Error ? err.message : String(err),
      hint: '远端同步异常（可能离线），已安全写入本地账本，绝不阻塞审查流转。',
    }
  }
}
