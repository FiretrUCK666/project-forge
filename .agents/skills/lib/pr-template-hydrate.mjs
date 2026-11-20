/**
 * pr-template-hydrate.mjs —— PR 可读标题提取与 `.github/pull_request_template.md` 实证回填。
 *
 * 从 workflow-helpers.mjs 拆出以严守单文件 <= 800 行红线，严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { formatWorkTitle } from './escalation.mjs'
import { readTextSafe } from './git.mjs'
import { extractHeadlessSummary } from './markdown-scan.mjs'

function stripHtmlCommentsOutsideFences(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inFence = false
  let inComment = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) { out.push(line); continue }
    let cur = line
    if (inComment) {
      const endIdx = cur.indexOf('-->')
      if (endIdx < 0) continue
      cur = cur.slice(endIdx + 3)
      inComment = false
    }
    while (cur.includes('<!--')) {
      const start = cur.indexOf('<!--')
      const end = cur.indexOf('-->', start + 4)
      if (end >= 0) {
        cur = `${cur.slice(0, start)}${cur.slice(end + 3)}`
      } else {
        cur = cur.slice(0, start)
        inComment = true
        break
      }
    }
    out.push(cur.trimEnd())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function extractReadableHeading(text) {
  if (!text) return null
  const fm = parseDocFrontmatter(text)
  const fmTitle = typeof fm.data?.title === 'string' ? fm.data.title.trim() : ''
  const h1Match = /^#\s+(.+)$/m.exec(fm.body || text)
  const raw = fmTitle || (h1Match ? h1Match[1].trim() : '')
  if (!raw) return null
  return raw.replace(/^(?:SPEC|PRD|Todo|TODO|规范|规格|任务)\s*[:：]\s*/i, '').trim() || null
}

function extractMarkdownSectionText(text, headingPatterns = []) {
  if (!text) return ''
  const clean = stripHtmlCommentsOutsideFences(parseDocFrontmatter(text).body || text)
  const lines = clean.split('\n')
  let inFence = false
  let capturing = false
  const buf = []
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; if (capturing) buf.push(line); continue }
    if (!inFence && /^##\s+/.test(line)) {
      if (capturing) break
      const title = line.replace(/^##\s+/, '').trim()
      if (headingPatterns.some((re) => re.test(title))) capturing = true
      continue
    }
    if (capturing) buf.push(line)
  }
  return buf.join('\n').trim()
}

function truncatePreservingCodeSpans(text, maxLen = 180) {
  const s = String(text ?? '').trim()
  if (s.length <= maxLen) return s
  let cut = s.slice(0, maxLen)
  const ticks = (cut.match(/`/g) ?? []).length
  if (ticks % 2 === 1) {
    const lastTick = cut.lastIndexOf('`')
    if (lastTick > 0) cut = cut.slice(0, lastTick)
  }
  return `${cut.replace(/[\s、，,;；:：(\[（-]+$/, '')}...`
}

function extractMeaningfulBullets(text, maxItems = 4) {
  if (!text) return []
  const lines = stripHtmlCommentsOutsideFences(text).split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const t = line.trim()
    if (!t || /^#/.test(t) || /^\|/.test(t) || /^[-*_]{3,}$/.test(t)) continue
    const cleaned = t.replace(/^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?/, '').trim()
    if (cleaned.length < 4) continue
    if (/^(?:\*\*)?在合并之前写完/.test(cleaned) || /待实施后补全|TBD|FIXME/i.test(cleaned)) continue
    out.push(truncatePreservingCodeSpans(cleaned, 180))
    if (out.length >= maxItems) break
  }
  return out
}

/** 优先从关联 SPEC / Todo / Issue 提取可读标题并附加工作类型前缀，避免裸拼英文 taskId。 */
export function resolveReadablePrTitle(repoRoot, ledger, explicitTitle = null) {
  const manual = String(explicitTitle ?? '').trim()
  if (manual) return formatWorkTitle(manual, ledger?.caseType)
  const docCandidates = [
    ledger?.specFile, ledger?.archivedSpecFile,
    ledger?.todoFile, ledger?.archivedTodoFile,
  ].filter(Boolean)
  if (repoRoot) {
    for (const rel of docCandidates) {
      const abs = join(repoRoot, rel)
      if (!existsSync(abs)) continue
      const title = extractReadableHeading(readTextSafe(abs))
      if (title) return formatWorkTitle(title, ledger?.caseType)
    }
  }
  const issueTitle = Array.isArray(ledger?.issueContext)
    ? ledger.issueContext.map((i) => String(i?.title ?? '').trim()).find(Boolean)
    : ''
  if (issueTitle) return formatWorkTitle(issueTitle, ledger?.caseType)
  return formatWorkTitle(ledger?.slug ?? ledger?.taskId ?? 'update', ledger?.caseType)
}

function formatDurationMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1000) return `${Math.round(n)}ms`
  return `${(n / 1000).toFixed(2)}s`
}

function buildVerificationEvidenceSection({ evidence, ledger, shortHead, visualFilesChanged = [], visualVerifiedOnHead = false }) {
  const rows = []
  const gates = evidence?.gates && typeof evidence.gates === 'object' ? evidence.gates : null
  const labelMap = { gate: 'merge-gate', full: 'full-test', smoke: 'smoke-verify', quick: 'quick-test', docStatic: 'doc-static' }
  if (gates) {
    for (const key of ['gate', 'full', 'smoke', 'quick', 'docStatic']) {
      const g = gates[key]
      if (!g) continue
      const status = g.status === 'skipped-explicit-none'
        ? 'SKIP (none)'
        : ((g.exitCode === 0 && g.ok !== false && g.succeeded !== false) ? 'PASS' : 'FAIL')
      const cmdPart = g.cmd ? ` (\`${String(g.cmd).slice(0, 72)}\`)` : ''
      rows.push(`| ${labelMap[key] ?? key}${cmdPart} | ${status} | ${formatDurationMs(g.durationMs)} | ${g.exitCode ?? 0} |`)
    }
  }
  if (rows.length === 0) {
    const mode = ledger?.verifiedMode ?? 'verify'
    const cmdPart = ledger?.verifiedCmd ? ` (\`${String(ledger.verifiedCmd).slice(0, 72)}\`)` : ''
    const exit = ledger?.lastVerifyExitCode ?? 0
    rows.push(`| ${mode}${cmdPart} | ${exit === 0 ? 'PASS' : 'FAIL'} | - | ${exit} |`)
  }
  const lines = [
    '| 验证项 | 结果 | 耗时 | 退出码 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `- **验证基线**：HEAD \`${shortHead}\``,
  ]
  const e2eSummary = String(evidence?.e2eObservation?.summary ?? '').trim()
  if (e2eSummary) {
    lines.push(`- **E2E 运行观察**：${e2eSummary}`)
  }
  if (visualFilesChanged.length > 0) {
    lines.push(`- **视觉与交互核验**：${visualVerifiedOnHead ? `已核验（${ledger?.visualCheckEvidence ?? 'confirmed'}）` : `涉及 ${visualFilesChanged.slice(0, 5).join(', ')}`}`)
  }
  return lines.join('\n')
}

function replaceSectionIfPresent(md, headingCandidates, newBody) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const matchHeading = (rawTitle) => {
    const clean = String(rawTitle ?? '').replace(/^(?:\d+[.)、]\s*|[一二三四五六七八九十]+[、.)]\s*)/, '').trim()
    const low = clean.toLowerCase()
    return headingCandidates.some((cand) => (cand instanceof RegExp ? cand.test(clean) : String(cand).trim().toLowerCase() === low))
  }
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^##\s+(.+?)\s*$/.exec(lines[i])
    if (!m || !matchHeading(m[1])) continue
    let end = lines.length
    let innerFence = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*(?:```|~~~)/.test(lines[j])) { innerFence = !innerFence; continue }
      if (!innerFence && /^##\s+/.test(lines[j])) { end = j; break }
    }
    const replacement = [lines[i], '', ...String(newBody ?? '').split('\n'), '']
    const nextLines = [...lines.slice(0, i), ...replacement, ...lines.slice(end)]
    return { matched: true, text: nextLines.join('\n') }
  }
  return { matched: false, text: md }
}

function removeSectionByHeading(md, headingTitle) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const target = String(headingTitle).trim()
  const out = []
  let inFence = false
  let skipping = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      if (!skipping) out.push(line)
      continue
    }
    if (!inFence) {
      const m = /^##\s+(.+?)\s*$/.exec(line)
      if (m) {
        if (m[1] === target) { skipping = true; continue }
        skipping = false
      }
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

function updateChecklistByEvidence(md, { verifyPassed, finalized, hasNoSecrets }) {
  return md.replace(/^- \[ \] (.+)$/gm, (full, label) => {
    const t = String(label)
    if (verifyPassed && /(?:验证|测试|门禁|构建|全绿|通过|\b(?:test|tests|verify|verified|check|checks|gate|build|ci|lint|pass|passed|green)\b)/i.test(t)) return `- [x] ${t}`
    if (finalized && /(?:文档|Todo|SPEC|README|TDD|归档|\b(?:docs?|documentation|spec|todo|readme|tdd|archived?|changelog)\b)/i.test(t)) return `- [x] ${t}`
    if (hasNoSecrets && /(?:敏感|凭据|密钥|无多余|无关|\b(?:secrets?|credentials?|tokens?|keys?|clean|unrelated)\b)/i.test(t)) return `- [x] ${t}`
    return full
  })
}

/** 读取 `.github/pull_request_template.md`，剥离引导注释并基于 SPEC/Todo/`evidence.json` 填充实证 PR 正文。 */
export function hydratePrTemplateBody({
  repoRoot,
  taskId,
  ledger,
  policy = null,
  evidence = null,
  actorDisplay = '',
  implementerDisplay = null,
  visualFilesChanged = [],
  visualVerifiedOnHead = false,
  currentHead = '',
  changedFiles = [],
} = {}) {
  const shortHead = String(currentHead ?? '').slice(0, 7) || 'unknown'
  const fixesLine = (ledger?.linkedIssues ?? []).map((n) => `Fixes #${n}`).join('\n') || '无（独立变更任务）'
  const docLinks = [ledger?.specFile, ledger?.todoFile, ledger?.prdFile].filter(Boolean)
  const docSummary = docLinks.length > 0 ? docLinks.map((p) => `\`${p}\``).join('、') : `无（Case ${ledger?.caseType ?? 3}）`
  const pfTag = `<!-- pf-state:${JSON.stringify({ taskId, action: 'pr-body', branch: ledger?.branch ?? null, headSha: currentHead || null })} -->`

  const specRel = ledger?.specFile ?? ledger?.archivedSpecFile
  const todoRel = ledger?.todoFile ?? ledger?.archivedTodoFile
  const specText = repoRoot && specRel && existsSync(join(repoRoot, specRel)) ? readTextSafe(join(repoRoot, specRel)) : ''
  const todoText = repoRoot && todoRel && existsSync(join(repoRoot, todoRel)) ? readTextSafe(join(repoRoot, todoRel)) : ''
  const readableTitle = resolveReadablePrTitle(repoRoot, ledger)

  const specGoalBullets = extractMeaningfulBullets(extractMarkdownSectionText(specText, [/(?:目标|范围|概述|要解决的问题|背景|summary|overview|goal|motivation|background|context|problem)/i]), 3)
  const todoOutcomeBullets = extractMeaningfulBullets(extractMarkdownSectionText(todoText, [/(?:完成后的记录|实际结果|成果|results?|outcomes?|summary|notes)/i]), 3)
  const headlessFallback = (todoOutcomeBullets.length === 0 && specGoalBullets.length === 0)
    ? (() => {
        const rawDoc = specText || todoText
        const bodyBullets = extractMeaningfulBullets(parseDocFrontmatter(rawDoc).body || rawDoc, 2)
        if (bodyBullets.length > 0) return bodyBullets
        const hl = extractHeadlessSummary(rawDoc, { maxLength: 180 })
        return hl ? [hl] : []
      })()
    : []
  const effectiveGoalBullets = specGoalBullets.length > 0 ? specGoalBullets : headlessFallback
  const effectiveImpl = String(implementerDisplay ?? actorDisplay ?? '').trim()
  const implFragment = effectiveImpl ? `，实施人：${effectiveImpl}` : ''
  const summaryText = [
    `- **${readableTitle}**（任务 \`${taskId}\`${implFragment}，涉及 ${changedFiles.length} 个文件）`,
    ...todoOutcomeBullets.map((b) => `- ${b}`),
    ...(todoOutcomeBullets.length === 0 ? effectiveGoalBullets.map((b) => `- ${b}`) : []),
  ].join('\n')
  const whyText = [
    ...(effectiveGoalBullets.length > 0 ? effectiveGoalBullets.slice(0, 2).map((b) => `- ${b}`) : [`- 完成任务 \`${taskId}\` 并对齐工程契约与文档。`]),
    `- 关联文档：${docSummary}`,
  ].join('\n')
  const basisText = [
    `- 档位与风险：Case ${ledger?.caseType ?? 3} / risk=\`${policy?.riskTier ?? 'medium'}\``,
    `- 分支与隔离：\`${ledger?.branch ?? 'unknown'}\`（${ledger?.worktreePath ?? 'branch'}）`,
    `- 关联文档：${docSummary}`,
  ].join('\n')
  const riskLines = [
    `- 风险等级：\`${policy?.riskTier ?? 'medium'}\`（变更文件 ${changedFiles.length} 个）`,
    policy?.highRiskHits?.length ? `- 命中高风险路径：${policy.highRiskHits.slice(0, 6).map((f) => `\`${f}\``).join('、')}` : null,
    policy?.oneWayBoundaryHits?.length ? `- 触及 one-way 边界：${policy.oneWayBoundaryHits.slice(0, 6).map((f) => `\`${f}\``).join('、')}` : null,
  ].filter(Boolean).join('\n')
  const verifyText = buildVerificationEvidenceSection({ evidence, ledger, shortHead, visualFilesChanged, visualVerifiedOnHead })
  const rollbackText = `- 回滚基线：\`${String(ledger?.baseSha ?? '').slice(0, 7) || ledger?.baseBranch || 'main'}\`（反向提交 \`git revert\` 并重跑完整门禁）`
  const mergeAuthText = policy?.independentReviewRequired === false
    ? '- 低风险纯文档改动：门禁绿灯可直接合入'
    : '- 独立审查 `fail` 为空且 CI 绿灯后由审查者合入（审查结论以独立评论记录；若含弱化门禁须人工确认）'

  const verifyPassed = Boolean(ledger?.lastVerifyExitCode === 0 && (!currentHead || ledger?.verifiedHead === currentHead))
  const tplPath = repoRoot ? join(repoRoot, '.github', 'pull_request_template.md') : ''
  const tplRaw = tplPath && existsSync(tplPath) ? readTextSafe(tplPath) : null
  if (!tplRaw) {
    return ['## 变更摘要', '', summaryText, '', '## 改动理由', '', whyText, '', '## 关联 Issue', '', fixesLine, '', '## 影响面与风险', '', riskLines, '', '## 验证证据', '', verifyText, '', '## 回滚方式', '', rollbackText, '', pfTag].join('\n')
  }

  let body = stripHtmlCommentsOutsideFences(tplRaw)
  body = removeSectionByHeading(body, '独立审查与故障注入')
  const sectionUpdates = [
    [['变更摘要', '改了什么', '变更说明', '改动说明', /^(?:summary|description|overview|what(?:\s+changed)?|changes)$/i], summaryText],
    [['关联 Issue 与文档', /^(?:related\s+issues?\s*(?:&|and)\s*docs?)$/i], `${fixesLine}\n- 关联文档：${docSummary}`],
    [['关联 Issue', /^(?:related\s+issues?|issues?|linked\s+issues?)$/i], fixesLine],
    [['改动理由', '为什么', /^(?:motivation|why|background|context|rationale)$/i], whyText],
    [['实现依据', /^(?:design|implementation|approach)$/i], basisText],
    [['影响面、风险与回滚方式', /^(?:impact,?\s*risk\s*(?:&|and)\s*rollback)$/i], [riskLines, rollbackText].filter(Boolean).join('\n')],
    [['影响面与风险', '风险与影响范围', /^(?:impact|risks?|breaking\s+changes?)$/i], riskLines],
    [['验证证据', '怎么验证的', '验证方式', '测试验证', /^(?:testing|test\s+plan|verification|how\s+has\s+this\s+been\s+tested\??)$/i], verifyText],
    [['回滚方式', '回滚点', /^(?:rollback|revert\s+plan)$/i], rollbackText],
    [['合并授权', /^(?:merge\s+authority|approval)$/i], mergeAuthText],
  ]
  for (const [headings, content] of sectionUpdates) body = replaceSectionIfPresent(body, headings, content).text
  body = updateChecklistByEvidence(body, { verifyPassed, finalized: Boolean(ledger?.finalized), hasNoSecrets: verifyPassed })
  return `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n\n${pfTag}\n`
}
