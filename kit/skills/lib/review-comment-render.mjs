/**
 * review-comment-render.mjs —— 独立审查 PR 与 Issue 全量证据对等单源渲染器。
 *
 * 从 doc-comments.mjs 拆出以控制单文件体积，由 doc-comments.mjs / docs.mjs 汇总导出。
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

const INTERNAL_CLI_RE = /(?:node\s+["']?\.agents\/|\b(?:flow|review-pack|doc-plan|edit-gate|verify-tools|govern-audit|iterate)\.mjs\b)/i

export function cleanMdCell(s) {
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

function sanitizeExternalNextSteps(nextSteps = []) {
  return (Array.isArray(nextSteps) ? nextSteps : [])
    .map((s) => String(s ?? '').trim())
    .filter((s) => s && !INTERNAL_CLI_RE.test(s))
}

function buildReadableNextNote({ isFull, stopLoss, verdict, round, role, prNum, nextSteps }) {
  if (stopLoss) {
    return isFull
      ? '已触发停损熔断，请人类维护者复核后裁决是否继续。'
      : '触发停损熔断，等待人类维护者裁决。'
  }
  const safeSteps = isFull ? sanitizeExternalNextSteps(nextSteps) : []
  if (safeSteps.length > 0) return safeSteps.join('；')
  if (verdict === 'pass') {
    if (role === 'contributor-fork') return '审查已通过，等待上游维护者合并 PR。'
    if (role === 'generic-git') return '审查已通过，请推送分支并在远端完成合并核验。'
    return prNum ? `审查已通过，等待独立审查者或维护者合并 PR #${prNum} 收尾。` : '审查已通过，等待独立审查者或维护者合并收尾。'
  }
  return `请在原分支按上述阻塞项逐项修复、重跑验证并更新提审，推进 Round ${round + 1} 独立复核。`
}

/**
 * 单源渲染结构化审查评论：
 * - `isFull === true`（PR 或无 PR 工单 `!prNum`）：输出固定三字段 + 条件 `止损记录` + `#### 验收标准逐条核对` + 完整 `Must Fix`/`Should Fix`/`Pre-existing`；
 * - `isFull === false`（已关联 `PR #N` 的 Issue）：仅输出紧凑结论、阻塞定位与指向 `PR #N` 的指针摘要。
 */
export function renderReviewSection({
  isFull = true,
  isIssue = false,
  round, verdict, baseSha, headSha,
  reviewerDisplay = '', implementerDisplay = '', empiricalSummary = '', summary = '',
  criteria = [], criteriaStatusText = '',
  faultInjectionText = '', stopLoss = false, stopReasons = [], mustFixList = [],
  shouldFixList = [], preExistingList = [], rebuttedItems = [], resolvedItems = [],
  prNum = null, labelName = '', staleLabel = '', role = null, nextSteps = [],
} = {}) {
  const shortBase = baseSha ? String(baseSha).slice(0, 7) : ''
  const shortHead = String(headSha ?? '').slice(0, 7) || 'HEAD'
  const baselineText = shortBase && shortBase !== shortHead ? `${shortBase}..${shortHead}` : shortHead
  const statusTagText = verdict === 'pass' ? 'PASS' : 'CHANGES_REQUESTED'
  const cnVerdict = verdict === 'pass' ? '审核通过' : '审核不通过（退回）'
  const stopLossText = `已触发（${stopReasons.join('；')}）`
  const labelNote = labelName ? `（标签：\`${labelName}\`${staleLabel ? `，移除 \`${staleLabel}\`` : ''}）` : ''

  const cleanReviewer = String(reviewerDisplay ?? '').trim()
  const cleanImplementer = String(implementerDisplay ?? '').trim()
  const cleanEmpirical = String(empiricalSummary ?? '').trim()
  const cleanSummary = String(summary ?? '').trim()

  const heading = isIssue
    ? `### ${cnVerdict} · Round ${round} @ \`${shortHead}\`${prNum ? `（PR #${prNum}）` : ''}`
    : `### ${cnVerdict} · Round ${round}（${statusTagText} @ \`${baselineText}\`）`

  const lines = [
    heading,
    '',
    ...(cleanReviewer ? [`- **审查人**：${cleanReviewer}`] : []),
    ...(isFull && cleanImplementer ? [`- **实施人**：${cleanImplementer}`] : []),
    ...(cleanSummary ? [`- **审查结论**：${cleanSummary}`] : []),
    isFull
      ? `- **逐条标准状态**：${criteriaStatusText}${isIssue ? labelNote : ''}`
      : `- **逐条状态与标签**：${criteriaStatusText}${labelNote}`,
    ...(isFull ? [`- **故障注入记录**：${faultInjectionText}`] : []),
    ...(stopLoss ? [`- **止损记录**：${stopLossText}`] : []),
    ...(cleanEmpirical ? [`- **实证核验**：${cleanEmpirical}`] : []),
  ]

  if (isFull && Array.isArray(criteria) && criteria.length > 0) {
    lines.push('', '#### 验收标准逐条核对', '', '| 标准 | 状态 | 核对内容与阻塞定位 |', '| --- | --- | --- |')
    for (const c of criteria) {
      const hits = verdict === 'changes' ? mustFixList.filter((m) => blockerMatchesCriterion(m, c.id)) : []
      const isPending = hits.length === 0 && (c.status === 'pending' || c.unverified === true)
      const stLabel = hits.length > 0 ? 'FAIL' : (isPending ? 'PENDING' : 'PASS')
      const note = hits.length > 0
        ? hits.map((h) => `[${h.id}] \`${formatBlockerLoc(h)}\`: ${cleanMdCell(h.summary)}`).join('；')
        : (isPending ? `${cleanMdCell(c.text)}（待核验）` : cleanMdCell(c.text))
      lines.push(`| ${cleanMdCell(c.id)} | ${stLabel} | ${note} |`)
    }
  }

  if (mustFixList.length > 0) {
    if (isFull) {
      lines.push('', '#### Must Fix（阻塞合入）', '')
      mustFixList.forEach((m, idx) => {
        const crit = m.criterion ? ` · 标准: ${m.criterion}` : ''
        lines.push(`${idx + 1}. **[${m.id}] \`${formatBlockerLoc(m)}\`**（fp: \`${m.fingerprint}\`${crit}）`)
        lines.push(`   - **问题与实证**：${m.summary}`)
        if (m.rootCause) lines.push(`   - **根因**：${m.rootCause}`)
        if (m.fixHint) lines.push(`   - **建议修法**：${m.fixHint}`)
      })
    } else {
      lines.push('', `#### Must Fix 阻塞项（${mustFixList.length} 项）`, '')
      mustFixList.forEach((m, idx) => {
        const rc = m.rootCause ? ` — 根因：${m.rootCause}` : ''
        lines.push(`${idx + 1}. **[${m.id}] \`${formatBlockerLoc(m)}\`**（fp: \`${m.fingerprint}\`）：${m.summary}${rc}`)
      })
    }
  }

  if (resolvedItems.length > 0 || rebuttedItems.length > 0) {
    const parts = [
      resolvedItems.length > 0 ? `已解决：${resolvedItems.join(', ')}` : null,
      rebuttedItems.length > 0 ? `已接受反驳：${rebuttedItems.join(', ')}` : null,
    ].filter(Boolean)
    lines.push('', `- **本轮消解**：${parts.join('；')}`)
  }

  if (isFull) {
    if (shouldFixList.length > 0) {
      lines.push('', '#### Should Fix（非阻塞建议）', '', ...shouldFixList.map((s, idx) => `${idx + 1}. ${s}`))
    }
    if (preExistingList.length > 0) {
      lines.push('', '#### Pre-existing（存量观察）', '', ...preExistingList.map((p, idx) => `${idx + 1}. ${p}`))
    }
  } else if (prNum) {
    const extraCount = shouldFixList.length > 0 || preExistingList.length > 0
      ? `与非阻塞项（Should Fix ${shouldFixList.length} 项、Pre-existing ${preExistingList.length} 项）`
      : ''
    lines.push('', `- **详单**：完整验收对照表、故障注入记录${extraCount}详见 PR #${prNum}。`)
  }

  const nextNote = buildReadableNextNote({ isFull, stopLoss, verdict, round, role, prNum, nextSteps })
  lines.push('', `> **下一步**：${nextNote}`)
  return lines.join('\n')
}

/** 渲染结构化 PR 与 Issue 全量对等审查单（双方均完整包含逐条标准核对表与故障注入记录）。 */
export function buildReviewComments(opts = {}) {
  const { statePayload = {} } = opts
  const stateTag = Object.keys(statePayload).length > 0 ? `<!-- pf-state:${JSON.stringify(statePayload)} -->` : ''
  const prCommentBody = renderReviewSection({ ...opts, isFull: true, isIssue: false })
  const issueCommentBody = renderReviewSection({ ...opts, isFull: true, isIssue: true })
  return { prCommentBody, issueCommentBody, stateTag }
}
