/**
 * doc-comments.mjs —— PR / Issue 协同评论结构化渲染器与唯一双层归属格式化原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 doc-templates.mjs / docs.mjs / shared.mjs 汇总导出。
 */

import { buildReviewComments, cleanMdCell } from './review-comment-render.mjs'

export { buildReviewComments }

const VALID_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

function stripAttributionDecorations(raw) {
  return String(raw ?? '').replace(/<[^>]*>/g, '').trim().replace(/^`+|`+$/g, '').replace(/^@+/, '').trim()
}

/**
 * 唯一双层正交归属格式化原语（能力驱动，零平台名硬编码与正则黑名单）：
 * - 仅当 `verifiedPlatformLogin === true` 且后端能力支持（`capabilities?.mention === true || supportsMention === true`）
 *   且 `account` 符合 handle 规范时输出 `@account`；
 * - 其余非空 `account` 与任意 `agent` 一律反引号包裹，缺失则省略（绝不捏造 `@maintainer`）；两者皆空返回 `''`。
 */
export function formatAttribution({
  account = null,
  verifiedPlatformLogin = false,
  agent = null,
  supportsMention = false,
  capabilities = null,
} = {}) {
  const cleanAccount = stripAttributionDecorations(account)
  const cleanAgent = stripAttributionDecorations(agent)
  const canMention = Boolean(verifiedPlatformLogin === true && (supportsMention === true || capabilities?.mention === true))

  const accountPart = cleanAccount
    ? (canMention && VALID_HANDLE_RE.test(cleanAccount) ? `@${cleanAccount}` : `\`${cleanAccount}\``)
    : ''

  const isDuplicate = Boolean(cleanAccount && cleanAgent && cleanAccount.toLowerCase() === cleanAgent.toLowerCase())
  const agentPart = cleanAgent && !isDuplicate ? `\`${cleanAgent}\`` : ''

  if (accountPart && agentPart) return `${accountPart}（${agentPart}）`
  return accountPart || agentPart || ''
}

/** 渲染 `claim` / `takeover` / `release` 统一结构化评论（动态省略空归属与不适用字段）。 */
export function buildClaimComments({
  action = 'claim',
  taskId = null,
  account = null,
  verifiedPlatformLogin = false,
  agent = null,
  actor = null,
  actorDisplay = null,
  branch = null,
  previousActor = null,
  previousAccount = null,
  previousVerifiedPlatformLogin = false,
  previousAgent = null,
  reason = '',
  issues = [],
  prNumber = null,
  supportsMention = false,
  capabilities = null,
} = {}) {
  const normAction = ['claim', 'takeover', 'release'].includes(String(action).toLowerCase())
    ? String(action).toLowerCase()
    : 'claim'
  const headingMap = {
    claim: '### 认领任务',
    takeover: '### 接管认领',
    release: '### 释放认领',
  }
  const hasExplicitLayers = account !== null || agent !== null
  const actorText = String(actorDisplay ?? '').trim() || formatAttribution({
    account: hasExplicitLayers ? account : null,
    verifiedPlatformLogin: Boolean(verifiedPlatformLogin),
    agent: hasExplicitLayers ? agent : actor,
    supportsMention,
    capabilities,
  })
  const prevObj = (previousActor && typeof previousActor === 'object') ? previousActor : null
  const hasPrevLayers = previousAccount !== null || previousAgent !== null
  const prevText = prevObj
    ? formatAttribution({ ...prevObj, supportsMention, capabilities })
    : ((previousAccount || previousAgent || previousActor)
        ? formatAttribution({
            account: hasPrevLayers ? previousAccount : null,
            verifiedPlatformLogin: Boolean(previousVerifiedPlatformLogin),
            agent: hasPrevLayers ? previousAgent : previousActor,
            supportsMention,
            capabilities,
          })
        : '')

  const cleanTask = taskId ? String(taskId).trim() : ''
  const cleanBranch = branch ? String(branch).trim() : ''
  const cleanReason = reason ? String(reason).trim() : ''
  const issuesText = Array.isArray(issues) && issues.length > 0
    ? [...new Set(issues.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].map((n) => `#${n}`).join(', ')
    : ''

  const nextStepMap = {
    claim: '在隔离工作区完成实现、验证并提交待审。',
    takeover: '在既有分支继续完成修改、验证后更新同一 PR 提审。',
    release: '任务已恢复待认领状态，其他协作者可直接认领接手。',
  }

  const issueLines = [
    headingMap[normAction],
    '',
    ...(actorText ? [`- **认领人**：${actorText}`] : []),
    ...(cleanTask ? [`- **任务**：\`${cleanTask}\``] : []),
    ...(cleanBranch ? [`- **分支**：\`${cleanBranch}\``] : []),
    ...(normAction === 'takeover' && prevText ? [`- **原认领人**：${prevText}`] : []),
    ...(prNumber ? [`- **关联 PR**：#${prNumber}`] : []),
    ...(cleanReason ? [`- **原因**：${cleanReason}`] : []),
    `- **下一步**：${nextStepMap[normAction]}`,
  ]

  const prLines = [
    headingMap[normAction],
    '',
    ...(actorText ? [`- **认领人**：${actorText}`] : []),
    ...(prNumber ? [`- **关联 PR**：#${prNumber}`] : []),
    ...(cleanTask ? [`- **任务**：\`${cleanTask}\``] : []),
    ...(cleanBranch ? [`- **分支**：\`${cleanBranch}\``] : []),
    ...(normAction === 'takeover' && prevText ? [`- **原认领人**：${prevText}`] : []),
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    ...(cleanReason ? [`- **原因**：${cleanReason}`] : []),
    `- **下一步**：${nextStepMap[normAction]}`,
  ]

  return {
    issueCommentBody: issueLines.join('\n'),
    prCommentBody: prLines.join('\n'),
  }
}

/** 渲染 `flow.mjs submit`（首次提审 / PR 创建同步 Issue / 返工更新）结构化多行评论。 */
export function buildSubmitComments({
  isRework = false, round = 1, shortHead = 'HEAD', actorDisplay = '', branch,
  verifiedCmd, prNumber = null, prUrl = null, linkedIssues = [], recentRebuts = '',
} = {}) {
  const cleanActor = String(actorDisplay ?? '').trim()
  const issuesText = linkedIssues.map((n) => `#${n}`).join(', ')
  if (isRework && prNumber) {
    const prCommentBody = [
      `### 返工已提交（Round ${round} @ \`${shortHead}\`）`,
      '',
      ...(cleanActor ? [`- **实施人**：${cleanActor}`] : []),
      `- **分支**：\`${branch}\`（HEAD \`${shortHead}\` · PR #${prNumber}）`,
      `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
      ...(recentRebuts ? [`- **反驳与说明**：${recentRebuts}`] : []),
      ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
      `- **下一步**：请新建独立审查上下文复核 Round ${round}（更新同一 PR）。`,
    ].join('\n')
    const issueCommentBodyFor = () => [
      `### 返工已提交（Round ${round} @ \`${shortHead}\`）`,
      '',
      ...(cleanActor ? [`- **实施人**：${cleanActor}`] : []),
      `- **分支 / PR**：\`${branch}\` · PR #${prNumber}`,
      `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
      ...(recentRebuts ? [`- **反驳与说明**：${recentRebuts}`] : []),
      `- **下一步**：等待 Round ${round} 独立审查复核。`,
    ].join('\n')
    return { prCommentBody, issueCommentBodyFor }
  }
  const prCommentBody = [
    `### 提交待审（Round 1 @ \`${shortHead}\`）`,
    '',
    ...(cleanActor ? [`- **实施人**：${cleanActor}`] : []),
    `- **分支**：\`${branch}\`（HEAD \`${shortHead}\` · PR #${prNumber}）`,
    `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    '- **下一步**：请独立审查上下文执行双门核验与故障注入复核。',
  ].join('\n')
  const issueCommentBodyFor = (iss) => [
    `### 提交待审 · 已提 PR #${prNumber}（@ \`${shortHead}\`）`,
    '',
    ...(cleanActor ? [`- **实施人**：${cleanActor}`] : []),
    `- **分支 / PR**：\`${branch}\` · #${prNumber}${prUrl ? ` (${prUrl})` : ''}`,
    `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
    `- **关联**：Fixes #${iss}`,
    '- **下一步**：等待 Round 1 独立审查复核。',
  ].join('\n')
  return { prCommentBody, issueCommentBodyFor }
}

/** 渲染 `flow.mjs merge` 成功后的 PR 与关联 Issue 结构化收尾评论。 */
export function buildMergeComments({
  prNumber, branch, baseBranch, headSha = '', mergeCommit = '',
  reviewerId = null, reviewerDisplay = null,
  implementerDisplay = '', linkedIssues = [], humanApprovedReason = null,
} = {}) {
  const shortHead = headSha ? String(headSha).slice(0, 7) : ''
  const shortMerge = mergeCommit ? String(mergeCommit).slice(0, 7) : ''
  const issuesText = linkedIssues.map((n) => `#${n}`).join(', ')
  const cleanImpl = String(implementerDisplay ?? '').trim()
  const cleanReviewer = String(reviewerDisplay ?? (reviewerId ? formatAttribution({ agent: reviewerId }) : '')).trim()
  const reviewLine = cleanReviewer
    ? `- **审查人**：${cleanReviewer}（独立复核通过，fail: 无）`
    : `- **门禁结论**：门禁检查通过${humanApprovedReason ? `，人类确认放行（${humanApprovedReason}）` : ''}`
  const issueReviewLine = cleanReviewer
    ? `- **审查人**：${cleanReviewer}（独立复核通过并合并，fail: 无）`
    : `- **门禁结论**：门禁检查通过并合并${humanApprovedReason ? `（人类确认：${humanApprovedReason}）` : ''}`
  const prCommentBody = [
    `### 已合并（PR #${prNumber} -> \`${baseBranch}\`）`,
    '',
    reviewLine,
    ...(shortMerge ? [`- **合并提交**：\`${shortMerge}\``] : []),
    cleanImpl
      ? `- **来源分支 / 实施人**：\`${branch}\`${shortHead ? ` @ \`${shortHead}\`` : ''} · ${cleanImpl}`
      : `- **来源分支**：\`${branch}\`${shortHead ? ` @ \`${shortHead}\`` : ''}`,
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    '- **下一步**：核对待清理 Worktree 与分支清单后由维护者确认执行 `flow.mjs cleanup --confirm`。',
  ].join('\n')
  const issueCommentBody = [
    `### 已合并 · PR #${prNumber}（\`${branch}\` -> \`${baseBranch}\`）`,
    '',
    issueReviewLine,
    ...(shortMerge ? [`- **合并提交**：\`${shortMerge}\``] : []),
    ...(cleanImpl ? [`- **实施人**：${cleanImpl}`] : []),
    '- **下一步**：主干已更新，按收尾清单清理工作区。',
  ].join('\n')
  return { prCommentBody, issueCommentBody }
}

const INTAKE_DECISION_LABELS = Object.freeze({
  accept: '接收进入规划/审查（ACCEPT）',
  reject: '拒绝关闭（REJECT）',
  defer: '暂缓排期（DEFER）',
  'merge-duplicate': '重复提案关闭（MERGE-DUPLICATE）',
  'needs-info': '需补充信息（NEEDS-INFO）',
})

/** 渲染 `flow.mjs intake` 三段式评论（结构化决策头 + AI 自由人话段 + 隐藏 `pf-state` 锚点），兼容三类后端。 */
export function buildIntakeDecisionComments({
  targetType = 'issue',
  targetNumber = null,
  decision = 'accept',
  reason = '',
  summary = '',
  rationale = '',
  humanExplanation = '',
  duplicateOf = null,
  dimensions = [],
  labels = [],
  featureRef = null,
  tddRefs = [],
  duplicates = [],
  rollbackHint = '',
  applied = false,
  closed = false,
  account = null,
  verifiedPlatformLogin = false,
  agent = null,
  supportsMention = false,
  capabilities = null,
  actor = null,
  actorDisplay = null,
  statePayload = null,
} = {}) {
  const kindLabel = targetType === 'pr' ? 'PR' : 'Issue'
  const refLabel = targetNumber != null ? `${kindLabel} #${targetNumber}` : kindLabel
  const decisionTitle = INTAKE_DECISION_LABELS[decision] ?? String(decision).toUpperCase()
  const normDupOf = duplicateOf ? String(duplicateOf).replace(/^#/, '').trim() : null
  const hasExplicitLayers = account !== null || agent !== null
  const resolvedActorDisplay = String(actorDisplay ?? '').trim() || formatAttribution({
    account: hasExplicitLayers ? account : null,
    verifiedPlatformLogin: Boolean(verifiedPlatformLogin),
    agent: hasExplicitLayers ? agent : actor,
    supportsMention,
    capabilities,
  })
  const cleanAccount = account ? String(account).trim() : null
  const cleanAgent = agent ? String(agent).trim() : null
  const stateActor = cleanAgent || cleanAccount || (actor ? String(actor).trim() : null) || null

  const payload = statePayload && typeof statePayload === 'object'
    ? statePayload
    : {
        kind: 'intake',
        targetType,
        targetNumber,
        decision,
        labels: Array.isArray(labels) ? labels : [],
        applied: Boolean(applied),
        closed: Boolean(closed),
        ...(featureRef ? { featureRef } : {}),
        ...(normDupOf ? { duplicateOf: normDupOf } : {}),
        ...(cleanAccount ? { account: cleanAccount, verifiedPlatformLogin: Boolean(verifiedPlatformLogin) } : {}),
        ...(cleanAgent ? { agent: cleanAgent } : {}),
        ...(stateActor ? { actor: stateActor } : {}),
      }
  const stateTag = `<!-- pf-state:${JSON.stringify(payload)} -->`

  const lines = [
    `### 业务分诊结论 · ${decisionTitle}（${refLabel}）`,
    '',
    ...(resolvedActorDisplay ? [`- **分诊人**：${resolvedActorDisplay}`] : []),
    `- **分诊判定**：\`${decision}\``,
    `- **处理方式**：${applied ? (closed ? '已执行打标并关闭' : '已执行评论与打标') : '仅预演评估（未执行远端写操作）'}`,
    ...(labels.length > 0 ? [`- **建议/已贴标签**：${labels.map((l) => `\`${l}\``).join('、')}`] : []),
    ...(normDupOf ? [`- **重复指向**：#${normDupOf}`] : []),
    ...(featureRef ? [`- **关联特性锚点**：\`${featureRef}\``] : []),
    ...(tddRefs.length > 0 ? [`- **契约定位依据**：${tddRefs.map((r) => `\`${r}\``).join('、')}`] : []),
    ...(duplicates.length > 0 ? [`- **历史相似条目**：${duplicates.map((d) => (typeof d === 'string' ? `\`${d}\`` : `\`${d.ref ?? d.path ?? d.title}\``)).join('、')}`] : []),
  ]

  if (Array.isArray(dimensions) && dimensions.length > 0) {
    lines.push('', '| 评估维度 | 结果 | 依据摘要 |', '| --- | --- | --- |')
    for (const d of dimensions) {
      lines.push(`| ${cleanMdCell(d.name ?? d.id)} | ${cleanMdCell(d.status ?? 'ok')} | ${cleanMdCell(d.detail ?? d.evidence ?? '-')} |`)
    }
  }

  lines.push('', '#### 说明与后续指引', '')
  const narrative = String(rationale || humanExplanation || reason || summary || '已完成五维业务边界与契约核对。').trim()
  lines.push(narrative)
  if (rollbackHint) {
    lines.push('', `- **撤销与恢复路径**：${rollbackHint}`)
  }
  lines.push('', stateTag)

  const commentBody = lines.join('\n')
  const delegatedPayload = {
    action: closed ? (targetType === 'pr' ? 'close-pr' : 'close-issue') : 'comment',
    targetType,
    targetNumber,
    decision,
    labels: Array.isArray(labels) ? labels : [],
    ...(normDupOf ? { duplicateOf: normDupOf } : {}),
    commentBody,
    statePayload: payload,
    ...(rollbackHint ? { rollbackHint } : {}),
  }
  return {
    commentBody,
    stateTag,
    statePayload: payload,
    delegatedPayload,
    summaryLine: `${refLabel}: ${decision}${reason ? ` (${reason})` : ''}`,
  }
}
