/**
 * review-sync.mjs —— 将独立审查结果按 `TaskBackend` 通道双写回远端 PR/Issue 或本地工单。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），远端写入前强制经 `probeForWrite` 探测通道。
 */

import { buildReviewComments } from '../../lib/docs.mjs'
import { gitRun } from '../../lib/git.mjs'
import { readGitConfigFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import {
  detectDeclaredRepo, githubRepoFull, isInternalAgentSlug,
  parsePrNumber, parseRemoteUrls, probeForWrite, resolveContributorIdentity,
} from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { parseAcceptanceCriteria } from './review-gates.mjs'

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
  stopLoss, stopReasons, mustFixList, shouldFixList, preExistingList = [],
  rebuttedItems = [], resolvedItems = [], nextSteps = [], opts,
}) {
  const prNum = parsePrNumber(ledger.prNumber)
  const issueNums = Array.isArray(ledger.linkedIssues)
    ? [...new Set(ledger.linkedIssues.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
    : []

  if (!prNum && issueNums.length === 0) {
    return { synced: false, skipped: true, reason: 'no-linked-pr-or-issue' }
  }

  const isLocalBackendRole = ledger.role === 'local-only'
    || ledger.role === 'generic-git'
    || ledger.providerId === 'generic-git'
    || ledger.providerId === 'none'

  if (isLocalBackendRole) {
    if (issueNums.length === 0) {
      return { synced: false, skipped: true, reason: `role-${ledger.role ?? 'local'}` }
    }
    const criteria = parseAcceptanceCriteria(workTreeRoot, mainRoot, ledger)
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
    const { issueCommentBody } = buildReviewComments({
      round, verdict, baseSha: ledger.baseSha, headSha,
      sourceLine: `\`${reviewerId}\`（独立上下文，implementer=\`${implementerId || 'unknown'}\`）`,
      criteria, criteriaStatusText, faultInjectionText, stopLoss, stopReasons,
      mustFixList, shouldFixList, preExistingList, rebuttedItems, resolvedItems,
      prNum, labelName, staleLabel, role: ledger.role, nextSteps, statePayload,
    })
    const backend = createTaskBackend({
      role: ledger.role, providerId: ledger.providerId ?? 'none', mainRoot, gitDir: opts.gitDir,
    })
    const results = []
    for (const num of issueNums) {
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
    }
    return { synced: results.some((r) => r.comment?.ok), local: true, label: labelName, results }
  }

  let delegatedPayloads = null
  try {
    const fastCfg = readGitConfigFast(opts.gitDir ?? resolveGitDirFast(mainRoot))
    const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(mainRoot, ['remote', '-v'])
    const hasRemote = Boolean(remoteRes.ok && remoteRes.stdout.trim())
    const remoteUrls = hasRemote ? parseRemoteUrls(remoteRes.stdout) : {}
    const declaredRepo = detectDeclaredRepo(mainRoot)
    const originFull = hasRemote ? githubRepoFull(remoteUrls.origin ?? Object.values(remoteUrls)[0]) : null
    const upstreamFull = hasRemote ? githubRepoFull(remoteUrls.upstream) : null
    const targetRepo = (ledger.role === 'contributor-fork' ? (upstreamFull ?? declaredRepo ?? originFull) : (originFull ?? declaredRepo)) ?? null

    const ghProbe = hasRemote
      ? (opts._ghProbe ?? (await probeForWrite({ cwd: mainRoot, remoteUrls })))
      : (opts._ghProbe ?? null)
    const ghClient = opts._ghClient ?? ghProbe?.client ?? null
    const tier = ghClient?.tier ?? ghProbe?.env?.trackB?.tier ?? 'offline'
    const ghLogin = ghProbe?.env?.trackB?.login
    const implDisplay = resolveContributorIdentity({ ghLogin, ledgerActor: implementerId }).display
    const sourceLine = isInternalAgentSlug(reviewerId) && ghLogin
      ? `@${ghLogin}（独立审查子代理 \`${reviewerId}\`，隔离 worktree 复核，实施人：${implDisplay}）`
      : `\`${reviewerId}\`（独立上下文，implementer=\`${implementerId || 'unknown'}\`）`

    const criteria = parseAcceptanceCriteria(workTreeRoot, mainRoot, ledger)
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

    const { prCommentBody, issueCommentBody, stateTag } = buildReviewComments({
      round, verdict, baseSha: ledger.baseSha, headSha, sourceLine, criteria, criteriaStatusText,
      faultInjectionText, stopLoss, stopReasons, mustFixList, shouldFixList, preExistingList,
      rebuttedItems, resolvedItems, prNum, labelName, staleLabel, role: ledger.role, nextSteps, statePayload,
    })
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
        synced: false, offlineOrNoCreds: true, reason: 'no-remote', targetRepo, delegatedPayloads,
        hint: '未配置远端，审查结论已安全保存至本地账本并附规范评论载荷（不阻塞离线使用）。',
      }
    }
    if (!targetRepo) {
      return { synced: false, skipped: true, reason: 'no-github-repo', delegatedPayloads, hint: '非 GitHub 远端，审查结论已写入本地账本。' }
    }
    if ((!opts._ghClient && ghProbe?.env?.providerId !== 'github') || (tier !== 'gh-cli' && tier !== 'node-https-token')) {
      return {
        synced: false,
        offlineOrNoCreds: true,
        tier,
        targetRepo,
        reason: `offline-or-no-credentials(${tier})`,
        delegatedPayloads,
        hint: `离线或无可用 GitHub 凭据（tier=${tier}），已写入本地账本并输出规范化 delegatedPayloads 供宿主原样双写。`,
      }
    }

    const backend = createTaskBackend({
      role: ledger.role, providerId: ledger.providerId, targetRepo,
      client: ghClient, mainRoot, gitDir: opts.gitDir,
    })
    const results = []
    for (const t of targets) {
      const targetBody = t.kind === 'pr' ? prCommentBody : issueCommentBody
      const commentRes = await backend.postComment({
        repo: targetRepo, number: t.number, body: targetBody, statePayload,
      })
      const labelRes = typeof backend.syncStateLabel === 'function'
        ? await backend.syncStateLabel({ repo: targetRepo, number: t.number, state: labelName })
        : await (async () => {
            const addR = await backend.addLabels({ repo: targetRepo, number: t.number, labels: [labelName] })
            await backend.removeLabel({ repo: targetRepo, number: t.number, label: staleLabel })
            return addR
          })()
      results.push({ kind: t.kind, number: t.number, comment: commentRes, label: labelRes })
    }

    const synced = results.some((r) => r.comment?.ok)
    return {
      synced,
      targetRepo,
      label: labelName,
      delegatedPayloads,
      results,
      ...(!synced ? {
        offlineOrNoCreds: true,
        hint: '远端评论同步未成功（可能处于离线或无写权限环境），审查结论已写入本地账本，请使用 delegatedPayloads 原样双写。',
      } : {}),
    }
  } catch (err) {
    return {
      synced: false,
      offlineOrNoCreds: true,
      ...(delegatedPayloads ? { delegatedPayloads } : {}),
      error: err instanceof Error ? err.message : String(err),
      hint: '远端同步异常（可能离线），已安全写入本地账本，绝不阻塞审查流转。',
    }
  }
}
