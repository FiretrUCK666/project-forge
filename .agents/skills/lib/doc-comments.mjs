/**
 * doc-comments.mjs —— PR / Issue 协同与独立审查评论统一结构化渲染器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 doc-templates.mjs / docs.mjs 汇总导出。
 */

const AGENT_OR_LOCAL_ID_RE = /^(?:impl(?:-|$)|rev(?:-|$)|reviewer(?:-|$)|local(?:-|$)|maintainer$|local-agent|implementer|coordinator(?:-|$)|swarm(?:-|$)|worker(?:-|$)|subagent(?:-|$)|independent-review(?:er)?(?:-|$)|critic(?:-|$)|integrator(?:-|$)|agent-\d+|claude(?:-|$)|gemini(?:-|$)|gpt(?:-|$)|codex(?:-|$))/i
const VALID_GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

/**
 * 统一执行人/协作者展示格式化：
 * - 真实平台登录账号（`backendKind === 'github'` 且非 AI/本地代号）保留 `@login`；
 * - AI 代理 ID（如 `impl-c4`）、离线/本地后端或非法登录名一律反引号包裹防误 `@mention`。
 */
export function formatActorDisplay(rawActor, { isPlatformLogin = false, backendKind = 'github' } = {}) {
  const clean = String(rawActor ?? '').replace(/<[^>]*>/g, '').trim().replace(/^`+|`+$/g, '')
  if (!clean) return '`maintainer`'
  const bare = clean.replace(/^@/, '')
  if (!bare) return '`maintainer`'
  const isOffline = backendKind === 'local-only' || backendKind === 'generic-git' || backendKind === 'local'
  if (isOffline) return `\`${bare}\``
  if (AGENT_OR_LOCAL_ID_RE.test(bare)) return `\`${bare}\``
  if ((isPlatformLogin || clean.startsWith('@') || VALID_GH_LOGIN_RE.test(bare)) && VALID_GH_LOGIN_RE.test(bare)) {
    return `@${bare}`
  }
  return `\`${bare}\``
}

/** 渲染 `claim` / `takeover` / `release` 统一结构化评论（动态省略不适用字段，零空占位）。 */
export function buildClaimComments({
  action = 'claim',
  taskId = null,
  actor = null,
  actorDisplay = null,
  branch = null,
  previousActor = null,
  reason = '',
  issues = [],
  prNumber = null,
  isPlatformLogin = false,
  backendKind = 'github',
} = {}) {
  const normAction = ['claim', 'takeover', 'release'].includes(String(action).toLowerCase())
    ? String(action).toLowerCase()
    : 'claim'
  const headingMap = {
    claim: '### 认领任务',
    takeover: '### 接管认领',
    release: '### 释放认领',
  }
  const actorText = formatActorDisplay(actorDisplay ?? actor, { isPlatformLogin, backendKind })
  const prevText = previousActor ? formatActorDisplay(previousActor, { backendKind }) : null
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
    `- **执行人**：${actorText}`,
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
    `- **执行人**：${actorText}`,
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

function cleanMdCell(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function formatBlockerLoc(m) {
  if (!m?.file) return '全局/门禁项'
  return m.line ? `${m.file}:${m.line}${m.endLine && m.endLine > m.line ? `-${m.endLine}` : ''}` : m.file
}

function blockerMatchesCriterion(m, criterionId) {
  const cid = String(criterionId ?? '').toUpperCase()
  if (!cid) return false
  if (m?.criterion && String(m.criterion).toUpperCase() === cid) return true
  for (const cm of String(m?.summary ?? '').matchAll(/\b(C\d+)\b/gi)) {
    if (cm[1].toUpperCase() === cid) return true
  }
  return false
}

/** 渲染结构化 PR 全量审查单与 Issue 摘要单（支持逐条标准对照表、Must/Should/Pre-existing 分区与离线载荷）。 */
export function buildReviewComments({
  round, verdict, baseSha, headSha, sourceLine, criteria = [], criteriaStatusText,
  faultInjectionText, stopLoss = false, stopReasons = [], mustFixList = [],
  shouldFixList = [], preExistingList = [], rebuttedItems = [], resolvedItems = [],
  prNum = null, labelName = '', staleLabel = '', role = null, nextSteps = [], statePayload = {},
} = {}) {
  const shortBase = baseSha ? String(baseSha).slice(0, 7) : ''
  const shortHead = String(headSha ?? '').slice(0, 7) || 'HEAD'
  const baselineText = shortBase && shortBase !== shortHead ? `${shortBase}..${shortHead}` : shortHead
  const statusTagText = verdict === 'pass' ? 'PASS' : 'CHANGES_REQUESTED'
  const cnVerdict = verdict === 'pass' ? '审核通过' : '审核不通过（退回）'
  const stopLossText = stopLoss ? `已触发（${stopReasons.join('；')}）` : '未触发'
  const stateTag = Object.keys(statePayload).length > 0 ? `<!-- pf-state:${JSON.stringify(statePayload)} -->` : ''

  const prLines = [
    `### ${cnVerdict} · Round ${round}（${statusTagText} @ \`${baselineText}\`）`,
    '',
    `- **审查来源**：${sourceLine}`,
    `- **逐条标准状态**：${criteriaStatusText}`,
    `- **故障注入记录**：${faultInjectionText}`,
    `- **止损记录**：${stopLossText}`,
    `- **对比基线**：\`${baselineText}\``,
  ]

  if (Array.isArray(criteria) && criteria.length > 0) {
    prLines.push('', '#### 验收标准逐条核对', '', '| 标准 | 状态 | 核对内容与阻塞定位 |', '| --- | --- | --- |')
    for (const c of criteria) {
      const hits = verdict === 'changes' ? mustFixList.filter((m) => blockerMatchesCriterion(m, c.id)) : []
      const stLabel = hits.length > 0 ? 'FAIL' : 'PASS'
      const note = hits.length > 0
        ? hits.map((h) => `[${h.id}] \`${formatBlockerLoc(h)}\`: ${cleanMdCell(h.summary)}`).join('；')
        : `${cleanMdCell(c.text)}${c.checked ? '' : '（待确认勾选）'}`
      prLines.push(`| ${cleanMdCell(c.id)} | ${stLabel} | ${note} |`)
    }
  }

  if (mustFixList.length > 0) {
    prLines.push('', '#### Must Fix（阻塞合入）', '')
    mustFixList.forEach((m, idx) => {
      const crit = m.criterion ? ` · 标准: ${m.criterion}` : ''
      prLines.push(`${idx + 1}. **[${m.id}] \`${formatBlockerLoc(m)}\`**（fp: \`${m.fingerprint}\`${crit}）`)
      prLines.push(`   - **问题与实证**：${m.summary}`)
      if (m.rootCause) prLines.push(`   - **根因**：${m.rootCause}`)
      if (m.fixHint) prLines.push(`   - **建议修法**：${m.fixHint}`)
    })
  }
  if (resolvedItems.length > 0 || rebuttedItems.length > 0) {
    const parts = [
      resolvedItems.length > 0 ? `已解决：${resolvedItems.join(', ')}` : null,
      rebuttedItems.length > 0 ? `已接受反驳：${rebuttedItems.join(', ')}` : null,
    ].filter(Boolean)
    prLines.push('', `- **本轮消解**：${parts.join('；')}`)
  }
  if (shouldFixList.length > 0) {
    prLines.push('', '#### Should Fix（非阻塞建议）', '', ...shouldFixList.map((s, idx) => `${idx + 1}. ${s}`))
  }
  if (preExistingList.length > 0) {
    prLines.push('', '#### Pre-existing（存量观察）', '', ...preExistingList.map((p, idx) => `${idx + 1}. ${p}`))
  }

  const nextNote = stopLoss
    ? '已触发停损熔断，请人类维护者复核后运行 `review-pack.mjs override --human-approved --reason "..."`。'
    : (nextSteps.length > 0 ? nextSteps.join('；') : (verdict === 'pass'
      ? (role === 'contributor-fork' ? '等待上游维护者合并 PR。' : '由当前独立审查上下文执行 `flow.mjs merge` 收尾。')
      : `请在原分支逐项修复后执行 \`flow.mjs rework\` -> \`verify\` -> \`submit --rework\` 推进 Round ${round + 1}。`))
  prLines.push('', `> **下一步**：${nextNote}`)

  const labelNote = labelName ? `（标签：\`${labelName}\`${staleLabel ? `，移除 \`${staleLabel}\`` : ''}）` : ''
  const issueLines = [
    `### ${cnVerdict} · Round ${round} @ \`${shortHead}\`${prNum ? `（PR #${prNum}）` : ''}`,
    '',
    `- **审查来源**：${sourceLine}`,
    `- **逐条状态与标签**：${criteriaStatusText}${labelNote}`,
    `- **故障注入摘要**：${faultInjectionText}`,
    `- **止损摘要**：${stopLossText}`,
  ]
  if (mustFixList.length > 0) {
    issueLines.push('', `#### Must Fix 阻塞项（${mustFixList.length} 项）`, '')
    mustFixList.forEach((m, idx) => {
      const rc = m.rootCause ? ` — 根因：${m.rootCause}` : ''
      issueLines.push(`${idx + 1}. **[${m.id}] \`${formatBlockerLoc(m)}\`**（fp: \`${m.fingerprint}\`）：${m.summary}${rc}`)
    })
  }
  if (shouldFixList.length > 0 || preExistingList.length > 0) {
    if (prNum) {
      issueLines.push('', `- **附注**：Should Fix ${shouldFixList.length} 项、Pre-existing ${preExistingList.length} 项（详细对照与列表见 PR #${prNum}）。`)
    } else {
      if (shouldFixList.length > 0) issueLines.push('', '#### Should Fix', '', ...shouldFixList.map((s, idx) => `${idx + 1}. ${s}`))
      if (preExistingList.length > 0) issueLines.push('', '#### Pre-existing', '', ...preExistingList.map((p, idx) => `${idx + 1}. ${p}`))
    }
  }
  const issueNext = stopLoss
    ? '触发停损熔断，等待人类维护者裁决。'
    : (verdict === 'pass' ? `审查已通过${prNum ? `，等待 PR #${prNum} 合并收尾` : ''}。` : `请在原分支按上述编号修复并重新提审（Round ${round + 1}）。`)
  issueLines.push('', `> **下一步**：${issueNext}`)

  return { prCommentBody: prLines.join('\n'), issueCommentBody: issueLines.join('\n'), stateTag }
}

/** 渲染 `flow.mjs submit`（首次提审 / PR 创建同步 Issue / 返工更新）结构化多行评论。 */
export function buildSubmitComments({
  isRework = false, round = 1, shortHead = 'HEAD', actorDisplay, branch,
  verifiedCmd, prNumber = null, prUrl = null, linkedIssues = [], recentRebuts = '',
} = {}) {
  const issuesText = linkedIssues.map((n) => `#${n}`).join(', ')
  if (isRework && prNumber) {
    const prCommentBody = [
      `### 返工已提交（Round ${round} @ \`${shortHead}\`）`,
      '',
      `- **提交人**：${actorDisplay}`,
      `- **分支**：\`${branch}\`（HEAD \`${shortHead}\` · PR #${prNumber}）`,
      `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
      ...(recentRebuts ? [`- **反驳与说明**：${recentRebuts}`] : []),
      ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
      `- **下一步**：请新建独立审查上下文复核 Round ${round}（更新同一 PR）。`,
    ].join('\n')
    const issueCommentBodyFor = () => [
      `### 返工已提交（Round ${round} @ \`${shortHead}\`）`,
      '',
      `- **提交人**：${actorDisplay}`,
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
    `- **提交人**：${actorDisplay}`,
    `- **分支**：\`${branch}\`（HEAD \`${shortHead}\` · PR #${prNumber}）`,
    `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    '- **下一步**：请独立审查上下文执行双门核验与故障注入复核。',
  ].join('\n')
  const issueCommentBodyFor = (iss) => [
    `### 提交待审 · 已提 PR #${prNumber}（@ \`${shortHead}\`）`,
    '',
    `- **提交人**：${actorDisplay}`,
    `- **分支 / PR**：\`${branch}\` · #${prNumber}${prUrl ? ` (${prUrl})` : ''}`,
    `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
    `- **关联**：Fixes #${iss}`,
    '- **下一步**：等待 Round 1 独立审查复核。',
  ].join('\n')
  return { prCommentBody, issueCommentBodyFor }
}

/** 渲染 `flow.mjs merge` 成功后的 PR 与关联 Issue 结构化收尾评论。 */
export function buildMergeComments({
  prNumber, branch, baseBranch, headSha = '', mergeCommit = '', reviewerId, implementerDisplay, linkedIssues = [], humanApprovedReason = null,
} = {}) {
  const shortHead = headSha ? String(headSha).slice(0, 7) : ''
  const shortMerge = mergeCommit ? String(mergeCommit).slice(0, 7) : ''
  const issuesText = linkedIssues.map((n) => `#${n}`).join(', ')
  const reviewLine = reviewerId
    ? `- **审查结论**：由独立审查（\`${reviewerId}\`）复核通过（fail: 无）`
    : `- **门禁结论**：门禁检查通过${humanApprovedReason ? `，人类确认放行（${humanApprovedReason}）` : ''}`
  const issueReviewLine = reviewerId
    ? `- **审查结论**：经独立审查（\`${reviewerId}\`）复核通过并合并（fail: 无）`
    : `- **门禁结论**：门禁检查通过并合并${humanApprovedReason ? `（人类确认：${humanApprovedReason}）` : ''}`
  const prCommentBody = [
    `### 已合并（PR #${prNumber} -> \`${baseBranch}\`）`,
    '',
    reviewLine,
    ...(shortMerge ? [`- **合并提交**：\`${shortMerge}\``] : []),
    `- **来源分支 / 实施人**：\`${branch}\`${shortHead ? ` @ \`${shortHead}\`` : ''} · ${implementerDisplay}`,
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    '- **下一步**：核对待清理 Worktree 与分支清单后由维护者确认执行 `flow.mjs cleanup --confirm`。',
  ].join('\n')
  const issueCommentBody = [
    `### 已合并 · PR #${prNumber}（\`${branch}\` -> \`${baseBranch}\`）`,
    '',
    issueReviewLine,
    ...(shortMerge ? [`- **合并提交**：\`${shortMerge}\``] : []),
    `- **实施人**：${implementerDisplay}`,
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
  actor = 'dev-flow',
  statePayload = null,
} = {}) {
  const kindLabel = targetType === 'pr' ? 'PR' : 'Issue'
  const refLabel = targetNumber != null ? `${kindLabel} #${targetNumber}` : kindLabel
  const decisionTitle = INTAKE_DECISION_LABELS[decision] ?? String(decision).toUpperCase()
  const normDupOf = duplicateOf ? String(duplicateOf).replace(/^#/, '').trim() : null
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
        actor,
      }
  const stateTag = `<!-- pf-state:${JSON.stringify(payload)} -->`

  const lines = [
    `### 业务分诊结论 · ${decisionTitle}（${refLabel}）`,
    '',
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
